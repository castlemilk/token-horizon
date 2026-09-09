#if os(macOS)
import Foundation
import Network

public final class LocalServer {
    private var listener: NWListener?
    public let onEvent: (ShellEvent) -> Void
    public let statsProvider: () -> UsageSnapshot
    public let sysProvider: () -> SystemStats.Snapshot
    public let historyProvider: (Int) -> (points: [HistoryPoint], streak: Int)
    public let trendsProvider: (TrendWindow) -> [HistoryPoint]
    public let limitsProvider: () -> [ProviderLimit]
    public let processesProvider: () -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample])
    private(set) var port: UInt16 = 8765

    public init(statsProvider: @escaping () -> UsageSnapshot,
         sysProvider: @escaping () -> SystemStats.Snapshot,
         historyProvider: @escaping (Int) -> (points: [HistoryPoint], streak: Int),
         trendsProvider: @escaping (TrendWindow) -> [HistoryPoint],
         limitsProvider: @escaping () -> [ProviderLimit],
         processesProvider: @escaping () -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample]),
         onEvent: @escaping (ShellEvent) -> Void) {
        self.statsProvider = statsProvider
        self.sysProvider = sysProvider
        self.historyProvider = historyProvider
        self.trendsProvider = trendsProvider
        self.limitsProvider = limitsProvider
        self.processesProvider = processesProvider
        self.onEvent = onEvent
    }

    public func start() {
        for attempt in 0..<20 {
            let candidate = UInt16(8765 + attempt)
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            guard let p = NWEndpoint.Port(rawValue: candidate),
                  let l = try? NWListener(using: params, on: p) else { continue }
            listener = l
            port = candidate
            break
        }
        guard let listener else { return }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        listener.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.listener = nil }
        }
        listener.start(queue: DispatchQueue(label: "tokenhorizon.server"))
    }

    private func accept(_ conn: NWConnection) {
        conn.stateUpdateHandler = { state in
            if case .cancelled = state { conn.cancel() }
            if case .failed = state { conn.cancel() }
        }
        conn.start(queue: DispatchQueue(label: "tokenhorizon.conn.\(ObjectIdentifier(conn).hashValue)"))
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let range = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = Data(buf[..<range.lowerBound])
                var body = Data(buf[range.upperBound...])
                let headText = String(decoding: head, as: UTF8.self)
                let lines = headText.components(separatedBy: "\r\n")
                let parts = lines.first.map { $0.split(separator: " ") } ?? []
                let method = parts.count > 0 ? String(parts[0]) : ""
                let rawPath = parts.count > 1 ? String(parts[1]) : "/"
                let contentLength = lines.first(where: { $0.lowercased().hasPrefix("content-length:") })
                    .flatMap { Int($0.drop(while: { $0 != ":" }).dropFirst().trimmingCharacters(in: .whitespaces)) } ?? 0
                while body.count < contentLength, !done {
                    let remaining = contentLength - body.count
                    let sema = DispatchSemaphore(value: 0)
                    conn.receive(minimumIncompleteLength: remaining, maximumLength: remaining) { d, _, _, _ in
                        if let d { body.append(d) }
                        sema.signal()
                    }
                    sema.wait()
                }
                let response = Self.handle(method: method, path: rawPath, body: body, server: self)
                conn.send(content: response, completion: .contentProcessed { _ in conn.cancel() })
            } else if error == nil && !done && buf.count < 1_048_576 {
                self.receive(conn, buffer: buf)
            } else {
                conn.cancel()
            }
        }
    }

    public static func percentDecode(_ s: String) -> String {
        s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? s
    }

    public static func parseForm(_ body: Data) -> [String: String] {
        var out: [String: String] = [:]
        for pair in String(decoding: body, as: UTF8.self).components(separatedBy: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { out[kv[0]] = percentDecode(kv[1]) }
        }
        return out
    }

    public static func handle(method: String, path: String, body: Data, server: LocalServer) -> Data {
        let route = path.split(separator: "?").first.map(String.init) ?? path
        let components = URLComponents(string: "http://localhost\(path.hasPrefix("/") ? path : "/" + path)")
        let queryItems = components?.queryItems ?? []

        func json(_ obj: Any, status: Int = 200) -> Data {
            let payload = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
            let header = "HTTP/1.1 \(status) OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n"
            return Data(header.utf8) + payload
        }

        func pid32(_ s: String) -> Int32? {
            return Int32(s.trimmingCharacters(in: .whitespaces))
        }

        switch (method, route) {
        case ("GET", "/metrics"):
            let payload = Data(TokenHorizonTelemetry.shared.prometheusText().utf8)
            let header = "HTTP/1.1 200 OK\r\nContent-Type: text/plain; version=0.0.4\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n"
            return Data(header.utf8) + payload

        case ("GET", "/stats"):
            let u = server.statsProvider()
            let sys = server.sysProvider()
            let enc = JSONEncoder()
            enc.dateEncodingStrategy = .secondsSince1970
            let usageData = (try? enc.encode(u)) ?? Data("{}".utf8)
            let usage = (try? JSONSerialization.jsonObject(with: usageData)) as? [String: Any] ?? [:]
            return json([
                "usage": usage,
                "system": [
                    "cpu_percent": sys.cpuPercent.rounded(),
                    "ram_used_gb": (sys.ramUsedGB * 100).rounded() / 100,
                    "ram_total_gb": sys.ramTotalGB.rounded(),
                    "load_1m": sys.loadAvg1,
                ],
            ])

        case ("POST", "/event"):
            let form = parseForm(body)
            let ev = ShellEvent(
                time: Date(),
                cwd: form["cwd"] ?? "",
                durationMs: Int(form["dur"] ?? "") ?? 0,
                exit: Int(form["exit"] ?? "") ?? 0)
            server.onEvent(ev)
            return json(["ok": true])

        case ("GET", "/processes"):
            let p = server.processesProvider()
            func procArray(_ arr: [ProcSample]) -> [[String: Any]] {
                arr.map {
                    ["pid": $0.pid, "ppid": $0.ppid, "name": $0.name, "command": $0.command,
                     "user": $0.user, "threads": $0.threads, "cpu": $0.cpu, "memMB": $0.memMB,
                     "diskReadMBps": $0.diskReadMBps, "diskWriteMBps": $0.diskWriteMBps,
                     "netInKBps": $0.netInKBps, "netOutKBps": $0.netOutKBps,
                     "startTime": $0.startTime.timeIntervalSince1970]
                }
            }
            let tree = SystemStats.buildProcessTree(p.all)
            let treeArr: [[String: Any]] = tree.map { tup in
                ["pid": tup.proc.pid, "ppid": tup.proc.ppid, "name": tup.proc.name,
                 "command": tup.proc.command, "user": tup.proc.user, "threads": tup.proc.threads,
                 "cpu": tup.proc.cpu, "memMB": tup.proc.memMB,
                 "diskReadMBps": tup.proc.diskReadMBps, "diskWriteMBps": tup.proc.diskWriteMBps,
                 "netInKBps": tup.proc.netInKBps, "netOutKBps": tup.proc.netOutKBps,
                 "depth": tup.depth, "hasChildren": tup.hasChildren,
                 "startTime": tup.proc.startTime.timeIntervalSince1970]
            }
            return json(["all": procArray(p.all), "tree": treeArr,
                         "byCPU": procArray(p.byCPU), "byMem": procArray(p.byMem),
                         "byDisk": procArray(p.byDisk), "byNet": procArray(p.byNet)])

        case ("GET", "/process"):
            // Drill-down: /process?pid=1234
            guard let pidStr = queryItems.first(where: { $0.name == "pid" })?.value,
                  let pid = pid32(pidStr) else {
                return json(["error": "missing pid"])
            }
            guard let detail = SystemStats.processDetail(pid: pid) else {
                return json(["error": "pid not found"])
            }
            return json([
                "pid": detail.pid, "ppid": detail.ppid,
                "cpu": detail.cpu, "memPercent": detail.memPercent,
                "memMB": detail.memMB, "virtMB": detail.virtMB,
                "etime": detail.etime, "user": detail.user,
                "threads": detail.threads, "state": detail.state,
                "nice": detail.nice, "command": detail.command,
                "openFiles": detail.openFiles ?? NSNull()
            ])

        case ("POST", "/kill"):
            // Drill-down: /kill?pid=1234&signal=15
            guard let pidStr = queryItems.first(where: { $0.name == "pid" })?.value,
                  let pid = pid32(pidStr) else {
                return json(["error": "missing pid"])
            }
            let signal = Int32(queryItems.first(where: { $0.name == "signal" })?.value ?? "") ?? SIGTERM
            let ok = SystemStats.killProcess(pid: pid, signal: signal)
            return json(["ok": ok])

        case ("GET", "/events"):
            let events = EventStore.shared.recent(limit: 25)
            let enc = JSONEncoder()
            enc.dateEncodingStrategy = .secondsSince1970
            let arr = (try? enc.encode(events)) ?? Data("[]".utf8)
            return json((try? JSONSerialization.jsonObject(with: arr)) as? [Any] ?? [])

        case ("GET", "/history"):
            var days = 365
            if let q = path.split(separator: "?", maxSplits: 1).last {
                for pair in q.split(separator: "&") {
                    if pair.hasPrefix("days="), let n = Int(pair.dropFirst(5)) {
                        days = min(max(n, 7), 370)
                    }
                }
            }
            let result = server.historyProvider(days)
            let enc = JSONEncoder()
            let pointsData = (try? enc.encode(result.points)) ?? Data("[]".utf8)
            let points = (try? JSONSerialization.jsonObject(with: pointsData)) as? [Any] ?? []
            return json(["days": days, "streak": result.streak, "points": points])

        case ("GET", "/trends"):
            var key = "1m"
            if let q = path.split(separator: "?", maxSplits: 1).last,
               let pair = q.split(separator: "&").first(where: { $0.hasPrefix("window=") }) {
                key = String(pair.dropFirst(7))
            }
            guard let window = TrendWindow(rawValue: key.uppercased()) else {
                return json(["error": "unknown window, use 1D/1W/1M/3M/1Y"], status: 400)
            }
            let points = server.trendsProvider(window)
            let enc = JSONEncoder()
            let pointsData = (try? enc.encode(points)) ?? Data("[]".utf8)
            let arr = (try? JSONSerialization.jsonObject(with: pointsData)) as? [Any] ?? []
            let total = points.reduce(0) { $0 + $1.tokens }
            return json(["window": window.rawValue, "total": total, "points": arr])

        case ("GET", "/limits"):
            let limits = server.limitsProvider()
            let enc = JSONEncoder()
            enc.dateEncodingStrategy = .secondsSince1970
            let arrData = (try? enc.encode(limits)) ?? Data("[]".utf8)
            let arr = (try? JSONSerialization.jsonObject(with: arrData)) as? [Any] ?? []
            return json(["limits": arr])

        case ("GET", "/health"):
            let proxyPort: Any = if let port = OllamaTelemetryProxy.shared.port {
                Int(port)
            } else {
                NSNull()
            }
            return json([
                "ok": true,
                "version": "0.2.0",
                "name": "token-horizon",
                "ollama_proxy_port": proxyPort,
            ])

        default:
            return json(["error": "not found"], status: 404)
        }
    }
}

// EventStore moved to TokenHorizonCore (EventStore.swift).

#endif // os(macOS)
