import Foundation
import TokenHorizonCore

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Token Horizon headless daemon — the cross-platform server side.
// Serves the same loopback API as the macOS app's LocalServer (127.0.0.1:8765+)
// so the MCP shim, shell hook, and any future UI work unchanged.

let engine = UsageEngine()
// Self-managed runtimes accrue usage into the durable ledger; the engine
// merges it like any provider source (stats/trends/history parity).
engine.localRuntimeUsage = { RuntimeUsageLedger.shared.contributions() }

// Unified usage store (UsageStoring) — local sqlite backend; cloud backends
// (Postgres/HTTP) slot in behind the same protocol later.
let usageStore: UsageStoring? = {
    do { return try SQLiteUsageStore() }
    catch { FileHandle.standardError.write("usage store unavailable: \(error)\n".data(using: .utf8)!); return nil }
}()

// Request meters (the listeners). Every vendor/runtime class is Meterable —
// it carries both its native channel (limits API / logs / Prometheus) and a
// request listener. TH_METERS="vendor:port[->target],..." e.g.
//   TH_METERS="vllm:9100,claude:9102->https://api.anthropic.com"
// Target optional: the vendor/runtime class supplies its default API base.
var meters: [RequestMeter] = []
if let spec = ProcessInfo.processInfo.environment["TH_METERS"] {
    for entry in spec.split(separator: ",") {
        let text = String(entry)
        guard let colon = text.firstIndex(of: ":") else { continue }
        let vendor = String(text[..<colon])
        let rest = String(text[text.index(after: colon)...])
        let portText: String
        let target: URL?
        if let arrow = rest.range(of: "->") {
            portText = String(rest[..<arrow.lowerBound])
            target = URL(string: String(rest[arrow.upperBound...]))
        } else {
            portText = rest
            target = nil
        }
        guard let port = UInt16(portText) else { continue }
        guard let meter = MeterRegistry.make(vendor: vendor, port: port,
                                             target: target, store: usageStore) else {
            FileHandle.standardError.write("no meterable vendor/runtime '\(vendor)'\n".data(using: .utf8)!)
            continue
        }
        meter.start()
        meters.append(meter)
    }
}

#if os(Linux)
Platform.systemStats = ProcFSSystemStats.self
#endif
InferenceMonitor.shared.startPolling()

func json(_ obj: Any, status: Int = 200) -> HTTPResponse {
    let payload = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
    return HTTPResponse(status: status, body: payload)
}

func encodeToJSONObject<T: Encodable>(_ value: T, datesAsEpoch: Bool = true) -> Any {
    let enc = JSONEncoder()
    if datesAsEpoch { enc.dateEncodingStrategy = .secondsSince1970 }
    guard let data = try? enc.encode(value),
          let obj = try? JSONSerialization.jsonObject(with: data) else { return NSNull() }
    return obj
}

func queryParams(_ query: String) -> [String: String] {
    var out: [String: String] = [:]
    for pair in query.split(separator: "&") {
        let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
        if kv.count == 2 { out[kv[0]] = kv[1].removingPercentEncoding ?? kv[1] }
    }
    return out
}

func router(_ request: HTTPRequest) -> HTTPResponse {
    let route = request.path.split(separator: "?").first.map(String.init) ?? request.path
    let query = request.path.split(separator: "?", maxSplits: 1).last.map(String.init) ?? ""

    switch (request.method, route) {
    case ("GET", "/health"):
        return json([
            "ok": true,
            "version": "0.2.0",
            "name": "token-horizon-headless",
            "platform": Platform.name,
            "usage_store": usageStore != nil,
        ])

    // Unified usage store: ingest endpoint (same shape a cloud API will take).
    case ("POST", "/events"):
        guard let store = usageStore else {
            return json(["error": "usage store unavailable"], status: 503)
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        let body = request.body
        let events: [UsageEvent]?
        if let array = try? decoder.decode([UsageEvent].self, from: body) {
            events = array
        } else if let single = try? decoder.decode(UsageEvent.self, from: body) {
            events = [single]
        } else {
            events = nil
        }
        guard let events, !events.isEmpty else {
            return json(["error": "body must be a UsageEvent or [UsageEvent] JSON"], status: 400)
        }
        do {
            try store.insert(events)
            return json(["inserted": events.count, "total": (try? store.count()) ?? -1])
        } catch {
            return json(["error": "insert failed: \(error)"], status: 500)
        }

    case ("GET", "/meters"):
        return json(meters.map { [
            "vendor": $0.vendor,
            "listen_port": Int($0.listenPort),
            "target": $0.targetBase.absoluteString,
            "source": $0.sourceKind.rawValue,
        ] })

    case ("GET", "/events/count"):
        guard let store = usageStore else { return json(["error": "usage store unavailable"], status: 503) }
        return json(["count": (try? store.count()) ?? -1])

    case ("GET", "/events/aggregate"):
        guard let store = usageStore else { return json(["error": "usage store unavailable"], status: 503) }
        let params = queryParams(query)
        let from = Date(timeIntervalSince1970: TimeInterval(Int(params["from"] ?? "0") ?? 0))
        let to = Date(timeIntervalSince1970: TimeInterval(Int(params["to"] ?? "\(Int(Date().timeIntervalSince1970) + 60)") ?? 0))
        let groupBy = UsageGroupBy(rawValue: params["group"] ?? "vendor") ?? .vendor
        let rows = (try? store.aggregate(from: from, to: to, groupBy: groupBy)) ?? []
        return json(["group": groupBy.rawValue, "rows": encodeToJSONObject(rows, datesAsEpoch: true)])

    case ("GET", "/events/sync"):
        guard let store = usageStore else { return json(["error": "usage store unavailable"], status: 503) }
        let params = queryParams(query)
        let cursor = Int64(params["cursor"] ?? "0") ?? 0
        let limit = Int(params["limit"] ?? "500") ?? 500
        guard let page = try? store.events(afterSequence: cursor, limit: limit) else {
            return json(["error": "sync read failed"], status: 500)
        }
        return json(["events": encodeToJSONObject(page.events, datesAsEpoch: true),
                     "cursor": page.lastSequence])

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
        return json(["usage": encodeToJSONObject(usage), "system": system])

    case ("POST", "/event"):
        var form: [String: String] = [:]
        for pair in String(decoding: request.body, as: UTF8.self).components(separatedBy: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 {
                form[kv[0]] = kv[1].replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? kv[1]
            }
        }
        EventStore.shared.add(ShellEvent(
            time: Date(),
            cwd: form["cwd"] ?? "",
            durationMs: Int(form["dur"] ?? "") ?? 0,
            exit: Int(form["exit"] ?? "") ?? 0))
        return json(["ok": true])

    case ("GET", "/events"):
        return json(encodeToJSONObject(EventStore.shared.recent(limit: 25)))

    case ("GET", "/history"):
        var days = 365
        for pair in query.split(separator: "&") where pair.hasPrefix("days=") {
            if let n = Int(pair.dropFirst(5)) { days = min(max(n, 7), 370) }
        }
        let result = engine.history(days: days)
        return json(["days": days, "streak": result.streak,
                     "points": encodeToJSONObject(result.points, datesAsEpoch: false)])

    case ("GET", "/trends"):
        var key = "1m"
        for pair in query.split(separator: "&") where pair.hasPrefix("window=") {
            key = String(pair.dropFirst(7))
        }
        guard let window = TrendWindow(rawValue: key.uppercased()) else {
            return json(["error": "unknown window, use 1D/1W/1M/3M/1Y"], status: 400)
        }
        let points = engine.trendHistory(window: window)
        let total = points.reduce(0) { $0 + $1.tokens }
        return json(["window": window.rawValue, "total": total,
                     "points": encodeToJSONObject(points, datesAsEpoch: false)])

    case ("GET", "/limits"):
        return json(["limits": encodeToJSONObject(PlanLimitsEngine.fetchAll() + KimiLimitsEngine.fetch())])

    case ("GET", "/runtimes"):
        // Self-managed inference runtimes (vLLM, SGLang, llama.cpp): detection + measured tok/s.
        let snaps = InferenceMonitor.shared.current()
        return json(snaps.map { snap -> [String: Any] in
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
            // Provider-parity usage totals from the durable ledger.
            let usage = RuntimeUsageLedger.shared.totals(vendor: snap.vendor)
            dict["usage"] = [
                "tokens_all": usage.all,
                "tokens_today": usage.today,
                "breakdown_all": encodeToJSONObject(usage.breakdownAll),
                "breakdown_today": encodeToJSONObject(usage.breakdownToday),
            ]
            return dict
        })

    case ("GET", "/processes"):
        guard let stats = Platform.systemStats else {
            return json(["error": "no system stats provider on this platform"], status: 404)
        }
        let p = stats.processSamples()
        func procArray(_ arr: [ProcSample]) -> [[String: Any]] {
            arr.map {
                ["pid": $0.pid, "ppid": $0.ppid, "name": $0.name, "command": $0.command,
                 "user": $0.user, "threads": $0.threads, "cpu": $0.cpu, "memMB": $0.memMB,
                 "diskReadMBps": $0.diskReadMBps, "diskWriteMBps": $0.diskWriteMBps,
                 "netInKBps": $0.netInKBps, "netOutKBps": $0.netOutKBps,
                 "startTime": $0.startTime.timeIntervalSince1970]
            }
        }
        return json(["all": procArray(p.all), "byCPU": procArray(p.byCPU), "byMem": procArray(p.byMem),
                     "byDisk": procArray(p.byDisk), "byNet": procArray(p.byNet)])

    case ("GET", "/metrics"):
        return HTTPResponse(contentType: "text/plain; version=0.0.4",
                            body: Data(TokenHorizonTelemetry.shared.prometheusText().utf8))

    default:
        return json(["error": "not found"], status: 404)
    }
}

let server = POSIXLoopbackHTTPServer(handler: router)
server.start()
guard server.port > 0 else {
    FileHandle.standardError.write(Data("token-horizon-headless: could not bind 127.0.0.1:8765-8784\n".utf8))
    exit(1)
}
print("token-horizon-headless listening on http://127.0.0.1:\(server.port)")
dispatchMain()
