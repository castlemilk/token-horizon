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

    /// TH_METERS="vendor:port[@product][->target],..."
    public func startMetersFromEnv() {
        guard let spec = ProcessInfo.processInfo.environment["TH_METERS"] else { return }
        if !meteringConsented {
            FileHandle.standardError.write("token-horizon: TH_METERS set but metering consent not granted; listeners disabled (TH_CONSENT=metering to grant)\n".data(using: .utf8)!)
            return
        }
        for entry in spec.split(separator: ",") {
            let text = String(entry)
            guard let colon = text.firstIndex(of: ":") else { continue }
            let vendor = String(text[..<colon])
            var rest = String(text[text.index(after: colon)...])
            var target: URL?
            if let arrow = rest.range(of: "->") {
                target = URL(string: String(rest[arrow.upperBound...]))
                rest = String(rest[..<arrow.lowerBound])
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
            guard let events, !events.isEmpty else {
                return Self.json(["error": "body must be a UsageEvent or [UsageEvent] JSON"], status: 400)
            }
            do {
                try store.insert(events)
                return Self.json(["inserted": events.count, "total": (try? store.count()) ?? -1])
            } catch {
                return Self.json(["error": "insert failed: \(error)"], status: 500)
            }

        case ("GET", "/permissions"):
            return Self.json(["permissions": Self.encode(PermissionManager.status())])

        case ("POST", "/runtimes/endpoints"):
            guard let obj = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let vendor = obj["vendor"] as? String,
                  let url = obj["url"] as? String else {
                return Self.json(["error": "body must be {vendor, url, meterPort?, label?}"], status: 400)
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
            return Self.json(meters.map { [
                "vendor": $0.vendor,
                "listen_port": Int($0.listenPort),
                "target": $0.targetBase.absoluteString,
                "source": $0.sourceKind.rawValue,
            ] })

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
            let resolution = Int(params["resolution"] ?? "900") ?? 900
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
            let limit = Int(params["limit"] ?? "500") ?? 500
            guard let page = try? store.events(afterSequence: cursor, limit: limit) else {
                return Self.json(["error": "sync read failed"], status: 500)
            }
            return Self.json(["events": Self.encode(page.events), "cursor": page.lastSequence])

        case ("GET", "/stats"):
            let usage = engine.snapshot()
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
            return Self.json(["usage": Self.encode(usage), "system": system])

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
            let result = engine.history(days: days)
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
            let points = engine.trendHistory(window: window)
            let total = points.reduce(0) { $0 + $1.tokens }
            return Self.json(["window": window.rawValue, "total": total,
                              "points": Self.encode(points)])

        case ("GET", "/limits"):
            return Self.json(["limits": Self.encode(PlanLimitsEngine.fetchAll() + KimiLimitsEngine.fetch())])

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
                  let stats = Platform.systemStats else {
                return Self.json(["error": "missing pid"], status: 400)
            }
            let signal = params["signal"].flatMap { Int32($0) } ?? 15
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
            sessionID: params["session"])
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
