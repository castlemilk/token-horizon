import Foundation

/// THE loopback API router — one implementation, used by every host:
/// the macOS app and the headless daemon — both serve it over
/// headless daemon (POSIX sockets in Platform/POSIXLoopbackHTTPServer).
/// Host differences are injected as closures; no route logic lives in hosts.
public final class CoreAPIRouter {
    public let engine: UsageEngine
    public var usageStore: UsageStoring?

    /// Active request meters (managed via addMeter / startMetersFrom*).
    public var meters: [RequestMeter] = []

    /// Host wiring hooks:
    public var serverName = "token-horizon"
    /// macOS UI serves cached process lists; nil = live sampling.
    public var processesOverride: (() -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample],
                                          byDisk: [ProcSample], byNet: [ProcSample]))?
    /// Called when a shell event is posted (host updates UI state).
    public var onShellEvent: (ShellEvent) -> Void = { _ in }

    public init(engine: UsageEngine, usageStore: UsageStoring? = nil) {
        self.engine = engine
        self.usageStore = usageStore
        // DB-first wiring: file poller + quota snapshots write through the
        // same store every analytics read goes through (multi-machine sync
        // via machine_id + /analytics/sync).
        if let store = usageStore {
            FilePoller.shared.store = store
            AttributionScheduler.shared.store = store
            PlanLimitsEngine.shared.snapshotStore = store
            KimiLimitsEngine.shared.snapshotStore = store
        }
        // Routing seam: any core component can route runtime calls through
        // live meters via MeterRegistry.routedURL (one measuring path).
        MeterRegistry.meterProvider = { [weak self] in self?.meters ?? [] }
    }

    private var meteringConsented: Bool {
        ConsentManager.shared.isGranted(.metering)
    }

    // MARK: - Meter management

    @discardableResult
    public func addMeter(vendor: String, port: UInt16, target: URL?, product: String? = nil) -> Bool {
        guard meteringConsented,
              !meters.contains(where: { $0.listenPort == port }),
              let meter = MeterRegistry.make(vendor: vendor, port: port,
                                             target: target, store: usageStore) else { return false }
        meter.productLabel = product
        meter.start()
        meters.append(meter)
        return true
    }

    /// Remove + stop a running meter by vendor key.
    @discardableResult
    public func removeMeter(vendor: String) -> Bool {
        guard let index = meters.firstIndex(where: {
            $0.vendor.lowercased() == vendor.lowercased()
        }) else { return false }
        meters[index].stop()
        meters.remove(at: index)
        return true
    }

    /// UI/API toggle: reconcile live meters with the desired state and
    /// persist it (survives restarts; applied by startCaptureMode).
    @discardableResult
    public func toggleMeter(vendor: String, enabled: Bool) -> Bool {
        let key = vendor.lowercased()
        if enabled {
            guard meteringConsented else { return false }
            if meters.contains(where: { $0.vendor.lowercased() == key }) {
                SettingsStore.shared.setMeterEnabled(key, true)
                return true
            }
            let port = MeterRegistry.defaultListenPort(for: key)
            guard addMeter(vendor: key, port: port, target: nil) else { return false }
            SettingsStore.shared.setMeterEnabled(key, true)
            return true
        }
        SettingsStore.shared.setMeterEnabled(key, false)
        return removeMeter(vendor: key)
    }

    /// Startup: start every meter the user toggled on (persisted desired
    /// state). Env + settings-endpoint + auto-meters layer on top.
    public func startMetersFromToggles() {
        guard meteringConsented else { return }
        for (vendor, enabled) in SettingsStore.shared.meterToggles where enabled {
            _ = addMeter(vendor: vendor,
                         port: MeterRegistry.defaultListenPort(for: vendor),
                         target: nil)
        }
    }

    /// TH_METERS="vendor:port[@product][->target],..."
    public func startMetersFromEnv() {
        guard let spec = ProcessInfo.processInfo.environment["TH_METERS"] else { return }
        if !meteringConsented {
            FileHandle.standardError.write("token-horizon: TH_METERS set but metering consent not granted; listeners disabled (TH_CONSENT=metering to grant)\n".data(using: .utf8)!)
            return
        }
        for entry in spec.split(separator: ",") {
            let text = String(entry).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let colon = text.firstIndex(of: ":") else { continue }
            let vendor = String(text[..<colon]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !vendor.isEmpty else { continue }
            var rest = String(text[text.index(after: colon)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            var target: URL?
            if let arrow = rest.range(of: "->") {
                let targetStr = String(rest[arrow.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                guard let url = URL(string: targetStr),
                      let scheme = url.scheme?.lowercased(),
                      ["http", "https"].contains(scheme),
                      url.host != nil else { continue }
                target = url
                rest = String(rest[..<arrow.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            var product: String?
            if let at = rest.range(of: "@", options: .backwards) {
                product = String(rest[at.upperBound...])
                rest = String(rest[..<at.lowerBound])
            }
            guard let port = UInt16(rest) else { continue }
            if !addMeter(vendor: vendor, port: port, target: target, product: product) {
                FileHandle.standardError.write("token-horizon: no meterable provider/runtime '\(vendor)'\n".data(using: .utf8)!)
            }
        }
    }

    /// Settings-managed runtime endpoints with meterPort set.
    public func startMetersFromSettings() {
        guard meteringConsented else { return }
        for (vendor, endpoints) in SettingsStore.shared.runtimeEndpoints {
            for endpoint in endpoints {
                guard let meterPort = endpoint.meterPort else { continue }
                _ = addMeter(vendor: vendor, port: UInt16(meterPort),
                             target: URL(string: endpoint.url))
            }
        }
    }

    // MARK: - Capture mode (swappable: point ↔ mitm)

    /// MITM capture manager, alive only while mitm mode is active.
    public private(set) var mitmCapture: MitmCaptureManager?

    /// Point-mode auto-metering: the first time InferenceMonitor observes a
    /// runtime alive, pre-wire its request meter on the runtime's
    /// deterministic loopback port (LocalInferenceRuntime.defaultMeterListenPort).
    /// GENERIC — every detected runtime (Ollama, vLLM, SGLang, llama.cpp,
    /// MLX) gets the same treatment, no per-vendor special cases. The meter
    /// measures whoever points at it; users find the ports via GET /meters,
    /// and internal clients route automatically via MeterRegistry.routedURL.
    public func startAutoMetering() {
        InferenceMonitor.shared.onRuntimeSighting = { [weak self] runtime in
            guard let self, self.meteringConsented,
                  let port = runtime.defaultMeterListenPort,
                  // explicit user toggle-off suppresses auto-metering
                  SettingsStore.shared.meterToggles[runtime.meterVendorKey] != false,
                  !self.meters.contains(where: { $0.vendor == runtime.meterVendorKey })
            else { return }
            if self.addMeter(vendor: runtime.meterVendorKey, port: port, target: nil) {
                FileHandle.standardError.write(
                    "token-horizon: auto-meter for \(runtime.vendor) on 127.0.0.1:\(port) — point clients there for exact per-request measurement\n".data(using: .utf8)!)
            }
        }
    }

    /// Start the configured capture mode. This is THE swappable seam:
    /// - point (default; the corporate-safe mode): loopback request meters
    ///   from env + settings + auto-meters for detected local runtimes;
    /// - mitm (personal machines, explicit .mitm consent): scoped TLS
    ///   interception of AI vendor hosts via MitmCaptureManager; point
    ///   meters are NOT started alongside it.
    /// Both modes emit the same UsageEvents into the same store.
    public func startCaptureMode() {
        switch SettingsStore.shared.meterCaptureMode {
        case .mitm:
            let manager = MitmCaptureManager.shared
            mitmCapture = manager
            if ConsentManager.shared.isGranted(.mitm) {
                manager.start()
            } else {
                FileHandle.standardError.write(
                    "token-horizon: capture mode is mitm but .mitm consent not granted — nothing intercepted (TH_CONSENT=mitm or approve the prompt)\n".data(using: .utf8)!)
            }
        case .point:
            startMetersFromEnv()
            startMetersFromSettings()
            startMetersFromToggles()
            startAutoMetering()
        }
    }

    // MARK: - Routing

    public func route(_ request: HTTPRequest) -> HTTPResponse {
        let route = request.path.split(separator: "?").first.map(String.init) ?? request.path
        let query = request.path.split(separator: "?", maxSplits: 1).last.map(String.init) ?? ""

        switch (request.method, route) {
        case ("GET", "/health"):
            var payload: [String: Any] = [
                "ok": true,
                "version": "0.2.0",
                "name": serverName,
                "platform": Platform.name,
                "usage_store": usageStore != nil,
                "machine_id": MachineIdentity.current,
                "machine_alias": MachineIdentity.alias,
            ]
            return Self.json(payload)

        case ("POST", "/analytics/events"):
            guard let store = usageStore else {
                return Self.json(["error": "usage store unavailable"], status: 503)
            }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .secondsSince1970
            let events: [UsageEvent]?
            if let array = try? decoder.decode([UsageEvent].self, from: request.body) {
                events = array
            } else if let single = try? decoder.decode(UsageEvent.self, from: request.body) {
                events = [single]
            } else {
                events = nil
            }
            guard let events, !events.isEmpty, events.count <= 1000 else {
                return Self.json(["error": "body must be a UsageEvent or [UsageEvent] JSON (max 1000)"], status: 400)
            }
            do {
                try store.insert(events)
                // MITM-captured events get the same reactive attribution
                // ladder as point-metered ones.
                AttributionScheduler.shared.note(events: events)
                return Self.json(["inserted": events.count, "total": (try? store.count()) ?? -1])
            } catch {
                return Self.json(["error": "insert failed: \(error)"], status: 500)
            }

        case ("POST", "/analytics/backfill"):
            // Deliberate one-time import of file-derived history into the
            // event store (attestation-marked; deterministic ids make re-runs
            // no-ops). Files stay annotation-only on the live path — this is
            // the documented bootstrap exception, never automatic.
            guard let store = usageStore else {
                return Self.json(["error": "usage store unavailable"], status: 503)
            }
            let events = engine.backfillEvents()
            do {
                try store.insert(events)
                return Self.json(["candidates": events.count, "total": (try? store.count()) ?? -1])
            } catch {
                return Self.json(["error": "backfill failed: \(error)"], status: 500)
            }

        case ("POST", "/consolidate"):
            // Deliberate one-pass file consolidation (tool annotations +
            // limit snapshots). Files never create usage rows; automatic
            // polling is opt-in (Settings.filePolling / TH_FILE_POLL=1).
            guard usageStore != nil else {
                return Self.json(["error": "usage store unavailable"], status: 503)
            }
            guard ConsentManager.shared.isGranted(.fileReading) else {
                return Self.json(["error": "fileReading consent not granted"], status: 403)
            }
            let report = FilePoller.shared.poll()
            return Self.json(["ok": true, "observations": report])

        case ("GET", "/permissions"):
            return Self.json(["permissions": Self.encode(PermissionManager.status())])

        case ("GET", "/consents"):
            let scopes = ConsentManager.shared.states().map { ["scope": $0.scope, "granted": $0.granted] }
            return Self.json(["scopes": scopes])

        case ("POST", "/consents"):
            // Loopback permission request: the user clicking Allow/Deny in
            // the desktop UI grants exactly like the OS prompt would (same
            // trust domain as /meters/toggle). Granting .metering also
            // starts persisted meters immediately — no restart needed.
            guard let obj = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let scopeName = obj["scope"] as? String,
                  let scope = ConsentScope(rawValue: scopeName),
                  let granted = obj["granted"] as? Bool else {
                return Self.json(["error": "body must be {scope, granted}"], status: 400)
            }
            if granted {
                ConsentManager.shared.grant(scope)
                if scope == .metering { startMetersFromToggles() }
            } else {
                ConsentManager.shared.revoke(scope)
            }
            return Self.json(["ok": true, "scope": scope.rawValue,
                              "granted": ConsentManager.shared.isGranted(scope)])

        case ("GET", "/service"):
            return Self.json(Self.encode(DaemonAutoStart.status()))

        case ("POST", "/service/install"):
            do {
                return Self.json(Self.encode(try DaemonAutoStart.install()))
            } catch {
                return Self.json(["error": "install failed: \(error)",
                                  "status": Self.encode(DaemonAutoStart.status())], status: 500)
            }

        case ("POST", "/service/uninstall"):
            do {
                return Self.json(Self.encode(try DaemonAutoStart.uninstall()))
            } catch {
                return Self.json(["error": "uninstall failed: \(error)",
                                  "status": Self.encode(DaemonAutoStart.status())], status: 500)
            }

        case ("POST", "/runtimes/endpoints"):
            guard let obj = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let vendor = obj["vendor"] as? String,
                  let url = obj["url"] as? String else {
                return Self.json(["error": "body must be {vendor, url, meterPort?, label?}"], status: 400)
            }
            if let port = obj["meterPort"] as? Int, !(1...65535).contains(port) {
                return Self.json(["error": "meterPort must be 1-65535"], status: 400)
            }
            let endpoint = RuntimeEndpoint(url: url, meterPort: obj["meterPort"] as? Int,
                                           label: obj["label"] as? String)
            SettingsStore.shared.addRuntimeEndpoint(vendor: vendor, endpoint)
            var meterStarted = false
            if let meterPort = endpoint.meterPort {
                meterStarted = addMeter(vendor: vendor, port: UInt16(meterPort),
                                        target: URL(string: url))
            }
            return Self.json(["ok": true, "meter_started": meterStarted])

        case ("GET", "/meters"):
            let toggles = SettingsStore.shared.meterToggles
            var payload: [String: Any] = [
                "mode": SettingsStore.shared.meterCaptureMode.rawValue,
                "point": meters.map { [
                    "vendor": $0.vendor,
                    "listen_port": Int($0.listenPort),
                    "target": $0.targetBase.absoluteString,
                    "source": $0.sourceKind.rawValue,
                    "seen": $0.seenExchanges,
                    "measured": $0.measuredExchanges,
                ] },
                // Every meterable vendor and its state — the UI renders
                // toggles from this; no hardcoded vendor list client-side.
                "catalog": MeterRegistry.availableVendors.sorted().map { v -> [String: Any] in
                    let running = meters.first(where: { $0.vendor.lowercased() == v.lowercased() })
                    var entry: [String: Any] = [
                        "vendor": v,
                        "running": running != nil,
                        "enabled": running != nil || toggles[v.lowercased()] == true,
                        "listen_port": running.map { Int($0.listenPort) } ?? Int(MeterRegistry.defaultListenPort(for: v)),
                        "target": running?.targetBase.absoluteString ?? NSNull(),
                    ]
                    // Runtime default target (first configured endpoint, else
                    // 127.0.0.1:defaultPort) so UIs can prefill endpoint
                    // editors for stopped meters. Cloud vendors have none —
                    // their API bases are fixed by the provider class.
                    if running == nil,
                       let rt = InferenceMonitor.shared.runtimes.first(where: {
                           $0.meterVendorKey.lowercased() == v.lowercased()
                       }),
                       let def = rt.defaultMeterTarget {
                        entry["default_target"] = def.absoluteString
                    }
                    return entry
                },
            ]
            if let mitm = mitmCapture {
                payload["mitm"] = mitm.status
            }
            return Self.json(payload)

        case ("POST", "/meters/toggle"):
            guard let obj = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let vendor = obj["vendor"] as? String,
                  let enabled = obj["enabled"] as? Bool else {
                return Self.json(["error": "body must be {vendor, enabled}"], status: 400)
            }
            guard meteringConsented else {
                return Self.json(["error": "metering consent not granted"], status: 403)
            }
            let ok = toggleMeter(vendor: vendor, enabled: enabled)
            let running = meters.first(where: { $0.vendor.lowercased() == vendor.lowercased() })
            return Self.json([
                "ok": ok,
                "running": running != nil,
                "listen_port": running.map { Int($0.listenPort) } ?? NSNull(),
            ], status: ok ? 200 : 502)

        case ("POST", "/meters/port"):
            // Move a vendor's loopback meter to a new listen port and persist
            // it into the daemon settings (runtimeEndpoints meterPort, or the
            // meter toggle default) so restarts restore it.
            guard let obj = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let vendor = obj["vendor"] as? String,
                  let port = obj["port"] as? Int else {
                return Self.json(["error": "body must be {vendor, port}"], status: 400)
            }
            guard (1...65535).contains(port) else {
                return Self.json(["error": "port must be 1-65535"], status: 400)
            }
            guard meteringConsented else {
                return Self.json(["error": "metering consent not granted"], status: 403)
            }
            let key = vendor.lowercased()
            let target = meters.first(where: { $0.vendor.lowercased() == key })?.targetBase
            if meters.contains(where: { $0.vendor.lowercased() != key && $0.listenPort == port }) {
                return Self.json(["error": "port already in use by another meter"], status: 409)
            }
            removeMeter(vendor: key)
            guard addMeter(vendor: key, port: UInt16(port), target: target) else {
                return Self.json(["error": "port unavailable or meter would not start",
                                  "listen_port": NSNull()], status: 502)
            }
            // Persist: rewrite the settings endpoint carrying this target, or
            // record one so the custom port survives restarts.
            let targetStr = target?.absoluteString ?? ""
            if !targetStr.isEmpty,
               var list = SettingsStore.shared.runtimeEndpoints[key] {
                var touched = false
                for i in list.indices where list[i].url == targetStr {
                    list[i].meterPort = port
                    touched = true
                }
                if touched {
                    SettingsStore.shared.runtimeEndpoints[key] = list
                } else {
                    SettingsStore.shared.addRuntimeEndpoint(
                        vendor: key, RuntimeEndpoint(url: targetStr, meterPort: port))
                }
            }
            return Self.json(["ok": true, "running": true, "listen_port": port])

        case ("GET", "/analytics/count"):
            guard let store = usageStore else { return Self.json(["error": "usage store unavailable"], status: 503) }
            return Self.json(["count": (try? store.count()) ?? -1])

        case ("GET", "/analytics/events"):
            guard let store = usageStore else { return Self.json(["error": "usage store unavailable"], status: 503) }
            let params = Self.queryParams(query)
            let (from, to) = Self.timeRange(params)
            let cursor = params["cursor"].flatMap { Int64($0) }
            let limit = min(Int(params["limit"] ?? "200") ?? 200, 1000)
            guard let page = try? store.query(from: from, to: to, filter: Self.usageFilter(params),
                                              cursor: cursor, limit: limit) else {
                return Self.json(["error": "query failed"], status: 500)
            }
            return Self.json(["events": Self.encode(page.events),
                              "next_cursor": page.nextCursor ?? NSNull()])

        case ("GET", "/analytics/buckets"):
            guard let store = usageStore else { return Self.json(["error": "usage store unavailable"], status: 503) }
            let params = Self.queryParams(query)
            let (from, to) = Self.timeRange(params)
            let requested = Int(params["resolution"] ?? "300") ?? 300
            let resolution: Int
            if params["resolution"] == nil {
                resolution = BucketResolution.forHorizon(spanSeconds: Int(to.timeIntervalSince(from)))
            } else {
                resolution = BucketResolution.snap(requested)
            }
            let rows = (try? store.buckets(from: from, to: to, bucketSeconds: resolution,
                                           filter: Self.usageFilter(params))) ?? []
            return Self.json(["resolution": resolution, "buckets": Self.encode(rows)])

        case ("GET", "/analytics/summary"):
            guard let store = usageStore else { return Self.json(["error": "usage store unavailable"], status: 503) }
            let params = Self.queryParams(query)
            let (from, to) = Self.timeRange(params)
            let rows = (try? store.summarize(from: from, to: to, filter: Self.usageFilter(params))) ?? []
            return Self.json(["providers": Self.encode(rows)])

        case ("GET", "/analytics/aggregate"):
            guard let store = usageStore else { return Self.json(["error": "usage store unavailable"], status: 503) }
            let params = Self.queryParams(query)
            let (from, to) = Self.timeRange(params)
            let groupBy = UsageGroupBy(rawValue: params["group"] ?? "vendor") ?? .vendor
            let rows = (try? store.aggregate(from: from, to: to, groupBy: groupBy,
                                             filter: Self.usageFilter(params))) ?? []
            return Self.json(["group": groupBy.rawValue, "rows": Self.encode(rows)])

        case ("GET", "/analytics/sync"):
            guard let store = usageStore else { return Self.json(["error": "usage store unavailable"], status: 503) }
            let params = Self.queryParams(query)
            let cursor = Int64(params["cursor"] ?? "0") ?? 0
            let limit = min(max(Int(params["limit"] ?? "500") ?? 500, 1), 1000)
            guard let page = try? store.events(afterSequence: cursor, limit: limit) else {
                return Self.json(["error": "sync read failed"], status: 500)
            }
            return Self.json(["events": Self.encode(page.events), "cursor": page.lastSequence])

        case ("GET", "/summary"):
            // Per-vendor rollups for the Tokens dashboard. DB-first: the
            // event store holds metered + consolidated + ledger rows; the
            // file engine is the fallback for hosts without a wired store.
            if let store = usageStore {
                let rollups = (try? store.summarize(from: .distantPast, to: Date(),
                                                    filter: UsageFilter())) ?? []
                let providers: [[String: Any]] = rollups
                    .filter { $0.tokens.total > 0 }
                    .map { p in
                        let models: [[String: Any]] = p.models
                            .sorted { $0.tokens.total > $1.tokens.total }
                            .map { m in
                                [
                                    "model": m.model,
                                    "vendor": p.vendor,
                                    "tokens": [
                                        "input": m.tokens.input, "output": m.tokens.output,
                                        "reasoning": m.tokens.reasoning,
                                        "cacheRead": m.tokens.cacheRead, "cacheWrite": m.tokens.cacheWrite,
                                        "total": m.tokens.total,
                                    ],
                                    "requests": m.requests,
                                    "cost": max(m.cost, 0),
                                ]
                            }
                        return [
                            "vendor": p.vendor,
                            "tokens": [
                                "input": p.tokens.input, "output": p.tokens.output,
                                "reasoning": p.tokens.reasoning,
                                "cacheRead": p.tokens.cacheRead, "cacheWrite": p.tokens.cacheWrite,
                                "total": p.tokens.total,
                            ],
                            "requests": p.requests,
                            "cost": max(p.cost, 0),
                            "models": models,
                        ]
                    }
                return Self.json(["providers": providers])
            }
            let snapshot = engine.snapshot()
            let providers: [[String: Any]] = snapshot.perTool
                .filter { $0.tokensAllTime > 0 || $0.tokensToday > 0 }
                .sorted { $0.tokensAllTime > $1.tokensAllTime }
                .map { t in
                    let b = t.breakdownAll
                    let vendor = Canonical.vendor(t.tool)
                    let models: [[String: Any]] = snapshot.models
                        .filter { Canonical.vendor($0.provider) == vendor }
                        .sorted { $0.tokensAll > $1.tokensAll }
                        .map { m in
                            [
                                "model": m.model,
                                "vendor": vendor,
                                "tokens": [
                                    "input": m.breakdown.input, "output": m.breakdown.output,
                                    "reasoning": m.breakdown.reasoning,
                                    "cacheRead": m.breakdown.cacheRead, "cacheWrite": m.breakdown.cacheWrite,
                                    "total": m.tokensAll,
                                ],
                                "requests": m.messages,
                                "cost": max(m.cost, 0),
                            ]
                        }
                    return [
                        "vendor": vendor,
                        "tokens": [
                            "input": b.input, "output": b.output, "reasoning": b.reasoning,
                            "cacheRead": b.cacheRead, "cacheWrite": b.cacheWrite,
                            "total": t.tokensAllTime,
                        ],
                        "requests": 0,
                        "cost": max(t.costAllTime, 0),
                        "models": models,
                    ]
                }
            return Self.json(["providers": providers])

        case ("GET", "/stats"):
            // DB-first: the event store holds metered + consolidated + ledger
            // rows (complete, incl. today); the file engine is the fallback
            // for hosts without a wired store.
            var usage: [String: Any]
            if let store = usageStore {
                usage = Self.encode(Self.storeSnapshot(store: store)) as? [String: Any] ?? [:]
            } else {
                usage = Self.encode(engine.snapshot()) as? [String: Any] ?? [:]
            }
            var system: [String: Any] = [:]
            if let stats = Platform.systemStats {
                let sys = stats.snapshot()
                system = [
                    "cpu_percent": sys.cpuPercent.rounded(),
                    "ram_used_gb": (sys.ramUsedGB * 100).rounded() / 100,
                    "ram_total_gb": sys.ramTotalGB.rounded(),
                    "load_1m": sys.loadAvg1,
                ]
            }
            return Self.json(["usage": usage, "system": system])

        case ("POST", "/event"):
            let form = Self.parseForm(request.body)
            let event = ShellEvent(
                time: Date(),
                cwd: form["cwd"] ?? "",
                durationMs: Int(form["dur"] ?? "") ?? 0,
                exit: Int(form["exit"] ?? "") ?? 0)
            EventStore.shared.add(event)
            onShellEvent(event)
            return Self.json(["ok": true])

        case ("GET", "/events"):
            return Self.json(Self.encode(EventStore.shared.recent(limit: 25)))

        case ("GET", "/history"):
            var days = 365
            for pair in query.split(separator: "&") where pair.hasPrefix("days=") {
                if let n = Int(pair.dropFirst(5)) { days = min(max(n, 7), 370) }
            }
            let result: (streak: Int, points: [HistoryPoint])
            if let store = usageStore {
                let h = Self.storeHistory(days: days, store: store)
                result = (h.streak, h.points)
            } else {
                result = engine.history(days: days)
            }
            return Self.json(["days": days, "streak": result.streak,
                              "points": Self.encode(result.points)])

        case ("GET", "/trends"):
            var key = "1m"
            for pair in query.split(separator: "&") where pair.hasPrefix("window=") {
                key = String(pair.dropFirst(7))
            }
            guard let window = TrendWindow(rawValue: key.uppercased()) else {
                return Self.json(["error": "unknown window, use 1D/1W/1M/3M/1Y"], status: 400)
            }
            // DB-first: the event store holds meters + consolidators + the
            // runtime ledger (complete, incl. today). The file-engine path is
            // the fallback for hosts without a wired store.
            if let store = usageStore {
                let points = Self.storeTrends(window: window, store: store)
                let total = points.reduce(0) { $0 + $1.tokens }
                return Self.json(["window": window.rawValue, "total": total,
                                  "points": Self.encode(points)])
            }
            let points = engine.trendHistory(window: window)
            let total = points.reduce(0) { $0 + $1.tokens }
            return Self.json(["window": window.rawValue, "total": total,
                              "points": Self.encode(points)])

        case ("GET", "/limits"):
            PlanLimitsEngine.shared.refreshIfDue()
            KimiLimitsEngine.shared.refreshIfDue()
            return Self.json(["limits": Self.encode(PlanLimitsEngine.shared.cachedLimits() + KimiLimitsEngine.shared.cachedLimits())])

        case ("POST", "/limits/refresh"):
            // Manual refresh (UI refresh button): force a re-fetch on the
            // utility queue and return the current cache immediately — the UI
            // fast-polls GET /limits until the fresh rows land.
            PlanLimitsEngine.shared.refreshNow()
            KimiLimitsEngine.shared.refreshNow()
            return Self.json(["limits": Self.encode(PlanLimitsEngine.shared.cachedLimits() + KimiLimitsEngine.shared.cachedLimits())])

        case ("GET", "/limits/history"):
            guard let store = usageStore else { return Self.json(["error": "usage store unavailable"], status: 503) }
            let params = Self.queryParams(query)
            let (from, to) = Self.timeRange(params)
            let snaps = (try? store.limitHistory(from: from, to: to, provider: params["provider"])) ?? []
            return Self.json(["snapshots": Self.encode(snaps)])

        case ("GET", "/sync/status"):
            guard let store = usageStore else { return Self.json(["error": "usage store unavailable"], status: 503) }
            var cursors: [String: String] = [:]
            for dataset in CloudSyncDataset.allCases {
                cursors[dataset.rawValue] = (try? store.syncCursor(dataset: dataset.rawValue)) ?? ""
            }
            let report = CloudSync.shared.lastReport
            return Self.json([
                "enabled": CloudSync.shared.baseURL != nil,
                "cursors": cursors,
                "last_sync": CloudSync.shared.lastSync?.timeIntervalSince1970 ?? NSNull(),
                "last_report": Self.encode(report),
            ])

        case ("POST", "/sync/now"):
            guard let store = usageStore else { return Self.json(["error": "usage store unavailable"], status: 503) }
            let report = CloudSync.shared.sync(store: store)
            return Self.json(["report": Self.encode(report)])

        case ("GET", "/timeline"):
            guard let store = usageStore else { return Self.json(["error": "usage store unavailable"], status: 503) }
            let params = Self.queryParams(query)
            let (from, to) = Self.timeRange(params)
            let resolution: Int
            if let req = params["resolution"].flatMap({ Int($0) }) {
                resolution = BucketResolution.snap(req)
            } else {
                resolution = BucketResolution.forHorizon(spanSeconds: Int(to.timeIntervalSince(from)))
            }
            let buckets = (try? store.buckets(from: from, to: to, bucketSeconds: resolution,
                                              filter: Self.usageFilter(params))) ?? []
            let limits = (try? store.limitHistory(from: from, to: to, provider: params["provider"])) ?? []
            let files = FilePoller.shared.lastReport
            let lastPoll: Any = FilePoller.shared.lastPoll.map { $0.timeIntervalSince1970 } ?? NSNull()
            return Self.json(["resolution": resolution,
                              "buckets": Self.encode(buckets),
                              "limits": Self.encode(limits),
                              "file_poller": ["last_poll": lastPoll,
                                              "locations": FilePoller.shared.locations,
                                              "last_report": files,
                                              "attribution_pending": AttributionScheduler.shared.pendingCount]])

        case ("GET", "/runtimes"):
            let snaps = InferenceMonitor.shared.current()
            return Self.json(snaps.map { snap -> [String: Any] in
                var dict: [String: Any] = [
                    "vendor": snap.vendor,
                    "display_name": snap.displayName,
                    "running": snap.running,
                    "pids": snap.pids,
                    "sampled_at": snap.sampledAt.timeIntervalSince1970,
                ]
                if let port = snap.port { dict["port"] = port }
                if let tps = snap.tokPerSec { dict["tok_per_sec"] = tps }
                if let ptps = snap.promptTokPerSec { dict["prompt_tok_per_sec"] = ptps }
                if let gen = snap.generationTokensTotal { dict["generation_tokens_total"] = gen }
                if let prompt = snap.promptTokensTotal { dict["prompt_tokens_total"] = prompt }
                if !snap.extra.isEmpty { dict["extra"] = snap.extra }
                let usage = RuntimeUsageLedger.shared.totals(vendor: snap.vendor)
                dict["usage"] = [
                    "tokens_all": usage.all,
                    "tokens_today": usage.today,
                    "breakdown_all": Self.encode(usage.breakdownAll),
                    "breakdown_today": Self.encode(usage.breakdownToday),
                ]
                return dict
            })

        case ("GET", "/runtimes/history"):
            // Bounded per-runtime series (fine per-poll / coarse 30s rollups):
            // ?vendor=mlx&coarse=0|1 — the MLXHistory feature, for every runtime.
            let params = Self.queryParams(query)
            guard let vendor = params["vendor"],
                  let history = InferenceMonitor.shared.history(vendor: vendor) else {
                return Self.json(["error": "unknown vendor or no history yet"], status: 404)
            }
            let points = params["coarse"] == "1" ? history.coarse : history.fine
            return Self.json([
                "vendor": vendor,
                "points": points.map { p -> [String: Any] in
                    var dict: [String: Any] = ["timestamp": p.timestamp.timeIntervalSince1970]
                    if let v = p.tokPerSec { dict["tok_per_sec"] = v }
                    if let v = p.promptTokPerSec { dict["prompt_tok_per_sec"] = v }
                    if let v = p.cpuPercent { dict["cpu_percent"] = v }
                    if let v = p.memMB { dict["mem_mb"] = v }
                    if let v = p.loadedModels { dict["loaded_models"] = v }
                    return dict
                },
            ])

        case ("GET", "/processes"):
            guard let stats = Platform.systemStats else {
                return Self.json(["error": "no system stats provider on this platform"], status: 404)
            }
            let p = processesOverride?() ?? stats.processSamples()
            let tree = stats.buildProcessTree(p.all)
            let treeArr: [[String: Any]] = tree.map { tup in
                ["pid": tup.proc.pid, "ppid": tup.proc.ppid, "name": tup.proc.name,
                 "command": tup.proc.command, "user": tup.proc.user, "threads": tup.proc.threads,
                 "cpu": tup.proc.cpu, "memMB": tup.proc.memMB,
                 "diskReadMBps": tup.proc.diskReadMBps, "diskWriteMBps": tup.proc.diskWriteMBps,
                 "netInKBps": tup.proc.netInKBps, "netOutKBps": tup.proc.netOutKBps,
                 "depth": tup.depth, "hasChildren": tup.hasChildren,
                 "startTime": tup.proc.startTime.timeIntervalSince1970]
            }
            return Self.json(["all": Self.procArray(p.all), "tree": treeArr,
                              "byCPU": Self.procArray(p.byCPU), "byMem": Self.procArray(p.byMem),
                              "byDisk": Self.procArray(p.byDisk), "byNet": Self.procArray(p.byNet)])

        case ("GET", "/process"):
            let params = Self.queryParams(query)
            guard let pid = params["pid"].flatMap({ Int32($0) }),
                  let stats = Platform.systemStats,
                  let detail = stats.processDetail(pid: pid) else {
                return Self.json(["error": "pid not found or unsupported"], status: 404)
            }
            return Self.json([
                "pid": detail.pid, "ppid": detail.ppid,
                "cpu": detail.cpu, "memPercent": detail.memPercent,
                "memMB": detail.memMB, "virtMB": detail.virtMB,
                "etime": detail.etime, "user": detail.user,
                "threads": detail.threads, "state": detail.state,
                "nice": detail.nice, "command": detail.command,
                "openFiles": detail.openFiles ?? NSNull(),
            ])

        case ("POST", "/kill"):
            let params = Self.queryParams(query)
            guard let pid = params["pid"].flatMap({ Int32($0) }),
                  pid > 1,
                  let stats = Platform.systemStats else {
                return Self.json(["error": "missing or invalid pid"], status: 400)
            }
            let signal = params["signal"].flatMap { Int32($0) } ?? 15
            guard [1, 2, 9, 15].contains(signal) else {
                return Self.json(["error": "signal must be one of 1,2,9,15"], status: 400)
            }
            return Self.json(["ok": stats.killProcess(pid: pid, signal: signal)])

        case ("GET", "/metrics"):
            return HTTPResponse(contentType: "text/plain; version=0.0.4",
                                body: Data(TokenHorizonTelemetry.shared.prometheusText().utf8))

        default:
            return Self.json(["error": "not found"], status: 404)
        }
    }

    // MARK: - Helpers

    public static func json(_ obj: Any, status: Int = 200) -> HTTPResponse {
        let payload = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        return HTTPResponse(status: status, body: payload)
    }

    public static func encode<T: Encodable>(_ value: T, datesAsEpoch: Bool = true) -> Any {
        let enc = JSONEncoder()
        if datesAsEpoch { enc.dateEncodingStrategy = .secondsSince1970 }
        guard let data = try? enc.encode(value),
              let obj = try? JSONSerialization.jsonObject(with: data) else { return NSNull() }
        return obj
    }

    public static func queryParams(_ query: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in query.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { out[kv[0]] = kv[1].removingPercentEncoding ?? kv[1] }
        }
        return out
    }

    public static func parseForm(_ body: Data) -> [String: String] {
        queryParams(String(decoding: body, as: UTF8.self).replacingOccurrences(of: "+", with: " "))
    }

    static func usageFilter(_ params: [String: String]) -> UsageFilter {
        UsageFilter(
            vendor: params["vendor"],
            model: params["model"],
            machineID: params["machine"],
            product: params["product"],
            source: params["source"].flatMap { SourceKind(rawValue: $0) },
            attestation: params["attestation"].flatMap { Attestation(rawValue: $0) },
            thinkingLevel: params["thinking"],
            sessionID: params["session"],
            meteredOnly: params["metered"] == "1")
    }

    /// Store-backed /trends: one fine-grained bucket scan binned into the
    /// /history over the store: one HistoryPoint per local-midnight day plus
    /// the consecutive-day streak (today counts when it has traffic, else the
    /// streak walks back from yesterday — same semantics as the engine).
    static func storeHistory(days: Int, store: UsageStoring, now: Date = Date()) -> (points: [HistoryPoint], streak: Int) {
        let todayStart = DayBoundary.start(ofTs: Int(now.timeIntervalSince1970))
        let from = Date(timeIntervalSince1970: TimeInterval(todayStart - (days - 1) * 86_400))
        let rows = (try? store.buckets(from: from, to: now, bucketSeconds: 3_600,
                                       filter: UsageFilter())) ?? []
        var byDay: [Int: HistoryPoint] = [:]
        for row in rows {
            // Hourly buckets are epoch-aligned; day boundaries are UTC
            // midnight (DayBoundary) — local rendering is the frontend's job.
            let dayStart = DayBoundary.start(ofTs: row.start)
            var point = byDay[dayStart] ?? HistoryPoint(day: dayStart, tokens: 0, cost: 0, byTool: [:])
            let t = row.tokens
            let total = t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite
            point.tokens += total
            point.cost += row.cost
            point.byTool[row.vendor, default: 0] += total
            point.breakdown.add(t)
            byDay[dayStart] = point
        }
        var points: [HistoryPoint] = []
        for offset in (0..<days).reversed() {
            let start = todayStart - offset * 86_400
            points.append(byDay[start] ?? HistoryPoint(day: start, tokens: 0, cost: 0, byTool: [:]))
        }
        var streak = 0
        var cursor = todayStart
        if (byDay[cursor]?.tokens ?? 0) == 0 { cursor -= 86_400 }
        while (byDay[cursor]?.tokens ?? 0) > 0 {
            streak += 1
            cursor -= 86_400
        }
        return (points, streak)
    }

    /// /stats over the store: the UsageSnapshot the macOS app assembles from
    /// files, computed here from metered/store rows instead — same DTO, so
    /// UI/MCP consumers see an identical shape. Per-vendor today/all-time
    /// splits, per-model rollups, recent sessions, and current quota windows
    /// (latest LimitSnapshot per provider+label+account, which also carries
    /// wire-sourced codex windows the file engine used to own).
    static func storeSnapshot(store: UsageStoring, now: Date = Date()) -> UsageSnapshot {
        var snap = UsageSnapshot()
        snap.updatedAt = now
        let todayStart = DayBoundary.start(of: now)   // UTC day; frontend renders local
        let all = (try? store.aggregate(from: .distantPast, to: now, groupBy: .vendor,
                                        filter: UsageFilter())) ?? []
        let today = (try? store.aggregate(from: todayStart, to: now, groupBy: .vendor,
                                          filter: UsageFilter())) ?? []
        let todayByVendor = Dictionary(uniqueKeysWithValues: today.map { ($0.key, $0) })
        snap.perTool = all.map { v in
            let t = todayByVendor[v.key]
            return ToolUsage(tool: v.key,
                             tokensToday: t?.tokens.total ?? 0, tokensAllTime: v.tokens.total,
                             costToday: t?.cost ?? 0, costAllTime: v.cost,
                             cacheReadAll: v.tokens.cacheRead, cacheWriteAll: v.tokens.cacheWrite,
                             breakdownToday: t?.tokens ?? TokenBreakdown(), breakdownAll: v.tokens)
        }
        for v in snap.perTool {
            snap.tokensToday += v.tokensToday
            snap.tokensAllTime += v.tokensAllTime
            snap.costToday += v.costToday
            snap.costAllTime += v.costAllTime
            snap.breakdownToday.add(v.breakdownToday)
            snap.breakdownAll.add(v.breakdownAll)
        }
        let modelsAll = (try? store.aggregate(from: .distantPast, to: now, groupBy: .model,
                                              filter: UsageFilter())) ?? []
        let modelsToday = (try? store.aggregate(from: todayStart, to: now, groupBy: .model,
                                                filter: UsageFilter())) ?? []
        let todayByModel = Dictionary(uniqueKeysWithValues: modelsToday.map { ($0.key, $0) })
        snap.models = modelsAll.map { m in
            let split = m.key.split(separator: "/", maxSplits: 1)
            let vendor = split.first.map(String.init) ?? ""
            let model = split.count > 1 ? String(split[1]) : m.key
            let t = todayByModel[m.key]
            return ModelUsage(provider: vendor, model: model,
                              tokensAll: m.tokens.total, tokensToday: t?.tokens.total ?? 0,
                              cost: m.cost, messages: m.requests,
                              free: m.cost < 0.0001 && (m.costEquivalent ?? 0) < 0.0001,
                              cacheReadAll: m.tokens.cacheRead,
                              estCost: m.costEquivalent ?? 0,
                              breakdown: m.tokens)
        }
        let sessions = (try? store.aggregate(from: .distantPast, to: now, groupBy: .session,
                                             filter: UsageFilter())) ?? []
        snap.recentSessions = sessions
            .filter { !$0.key.isEmpty }
            .sorted { ($0.lastEvent ?? .distantPast) > ($1.lastEvent ?? .distantPast) }
            .prefix(15)
            .map { s in
                SessionSummary(id: s.key, title: s.key, cost: s.cost,
                               tokens: s.tokens.total, directory: "",
                               created: s.firstEvent ?? now)
            }
        // Current quota windows: latest observation per provider+label+account.
        let limitRows = (try? store.limitHistory(
            from: now.addingTimeInterval(-30 * 86_400), to: now, provider: nil)) ?? []
        var latest: [String: LimitSnapshot] = [:]
        for row in limitRows {
            let key = "\(row.provider)|\(row.accountID)|\(row.label)"
            if let existing = latest[key], existing.recordedAt >= row.recordedAt { continue }
            latest[key] = row
        }
        snap.limits = latest.values
            .sorted { $0.provider == $1.provider ? $0.label < $1.label : $0.provider < $1.provider }
            .map { ProviderLimit(provider: $0.provider, label: $0.label,
                                 usedPercent: $0.usedPercent, resetsAt: $0.resetsAt,
                                 detail: $0.detail, accountID: $0.accountID) }
        snap.sources = snap.perTool.map(\.tool)
        return snap
    }

    /// window's point ranges. Range math mirrors UsageEngine.trendHistory so
    /// both paths agree on bucket boundaries (local-midnight day alignment).
    static func storeTrends(window: TrendWindow, store: UsageStoring, now: Date = Date()) -> [HistoryPoint] {
        let spec = window.spec
        let fine = UsageEngine.bucketSeconds
        let todayStart = DayBoundary.start(ofTs: Int(now.timeIntervalSince1970))  // UTC
        let nowBucket = Int(now.timeIntervalSince1970) / fine * fine

        var ranges: [(start: Int, end: Int)] = []
        for i in (0..<spec.count).reversed() {
            let start: Int
            if !spec.dailyAligned {
                start = spec.seconds == fine ? nowBucket - i * fine : todayStart - i * spec.seconds
            } else {
                start = todayStart - i * spec.seconds
            }
            ranges.append((start, min(start + spec.seconds, nowBucket + fine)))
        }
        guard let earliest = ranges.first?.start else { return [] }
        let rows = (try? store.buckets(from: Date(timeIntervalSince1970: TimeInterval(earliest)),
                                       to: now, bucketSeconds: fine, filter: UsageFilter())) ?? []
        var points = ranges.map { HistoryPoint(day: $0.start, tokens: 0, cost: 0, byTool: [:]) }
        for row in rows {
            guard let idx = ranges.firstIndex(where: { row.start >= $0.start && row.start < $0.end }) else { continue }
            let t = row.tokens
            let total = t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite
            points[idx].tokens += total
            points[idx].cost += row.cost
            points[idx].byTool[row.vendor, default: 0] += total
            points[idx].breakdown.input += t.input
            points[idx].breakdown.output += t.output
            points[idx].breakdown.reasoning += t.reasoning
            points[idx].breakdown.cacheRead += t.cacheRead
            points[idx].breakdown.cacheWrite += t.cacheWrite
        }
        return points
    }

    static func timeRange(_ params: [String: String]) -> (Date, Date) {
        let from = Date(timeIntervalSince1970: TimeInterval(Int(params["from"] ?? "0") ?? 0))
        // +60s slack: events stamped at exactly "now" are inside the range.
        let to = Date(timeIntervalSince1970: TimeInterval(
            Int(params["to"] ?? "\(Int(Date().timeIntervalSince1970) + 60)") ?? 0))
        return (from, to)
    }

    static func procArray(_ arr: [ProcSample]) -> [[String: Any]] {
        arr.map {
            ["pid": $0.pid, "ppid": $0.ppid, "name": $0.name, "command": $0.command,
             "user": $0.user, "threads": $0.threads, "cpu": $0.cpu, "memMB": $0.memMB,
             "diskReadMBps": $0.diskReadMBps, "diskWriteMBps": $0.diskWriteMBps,
             "netInKBps": $0.netInKBps, "netOutKBps": $0.netOutKBps,
             "startTime": $0.startTime.timeIntervalSince1970]
        }
    }
}
