import Foundation
import TokenHorizonCore

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Token Horizon headless daemon — the cross-platform server side.
// Serves the same loopback API as the macOS app's LocalServer (127.0.0.1:8765+)
// so the MCP shim, shell hook, and any future UI work unchanged.

let engine = UsageEngine()

#if os(Linux)
Platform.systemStats = ProcFSSystemStats.self
#endif

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
        ])

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
