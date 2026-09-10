import Foundation
import Network

final class LocalServer {
    private var listener: NWListener?
    let onEvent: (ShellEvent) -> Void
    let statsProvider: () -> UsageSnapshot
    let sysProvider: () -> SystemStats.Snapshot
    let historyProvider: (Int) -> (points: [HistoryPoint], streak: Int)
    let trendsProvider: (TrendWindow) -> [HistoryPoint]
    let limitsProvider: () -> [ProviderLimit]
    let processesProvider: () -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample])
    private(set) var port: UInt16 = 8765

    let onCacheReset: (() -> Void)?

    init(statsProvider: @escaping () -> UsageSnapshot,
         sysProvider: @escaping () -> SystemStats.Snapshot,
         historyProvider: @escaping (Int) -> (points: [HistoryPoint], streak: Int),
         trendsProvider: @escaping (TrendWindow) -> [HistoryPoint],
         limitsProvider: @escaping () -> [ProviderLimit],
         processesProvider: @escaping () -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample]),
         onEvent: @escaping (ShellEvent) -> Void,
         onCacheReset: (() -> Void)? = nil) {
        self.statsProvider = statsProvider
        self.sysProvider = sysProvider
        self.historyProvider = historyProvider
        self.trendsProvider = trendsProvider
        self.limitsProvider = limitsProvider
        self.processesProvider = processesProvider
        self.onEvent = onEvent
        self.onCacheReset = onCacheReset
    }

    /// Called when :8765 cannot be served (bind refused or listener dies
    /// before first ready). Defaults to a loud fatal exit — a Token Horizon
    /// with no API is worse than none (stale/missing data with no signal).
    /// Injectable so tests can record instead of exiting.
    var onBindFailure: (() -> Void)?
    private var bindReady = false

    static func fatalBindError() {
        NSLog("TokenHorizon: FATAL — cannot serve 127.0.0.1:8765 (port held by another process?). Refusing to run API-less; exiting(1).")
        exit(1)
    }

    /// Bind the fixed API port. No port-hopping: serving anywhere other than
    /// :8765 while the world assumes :8765 caused side-by-side instances with
    /// divergent data. Use `InstanceGuard.claimPort()` before calling.
    func start() {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        guard let p = NWEndpoint.Port(rawValue: InstanceGuard.port),
              let l = try? NWListener(using: params, on: p) else {
            (onBindFailure ?? Self.fatalBindError)()
            return
        }
        listener = l
        port = InstanceGuard.port
        l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        l.stateUpdateHandler = { [weak self] state in
            if case .ready = state { self?.bindReady = true }
            if case .failed = state {
                // Pre-ready failure = we never served: fatal. Post-ready
                // blips (sleep/wake) just drop the listener.
                if self?.bindReady == false { (self?.onBindFailure ?? Self.fatalBindError)() }
                else { self?.listener = nil }
            }
        }
        l.start(queue: DispatchQueue(label: "tokenhorizon.server"))
    }

    private static let connQueue = DispatchQueue(label: "tokenhorizon.conn", attributes: .concurrent)

    private func accept(_ conn: NWConnection) {
        conn.stateUpdateHandler = { state in
            if case .cancelled = state { conn.cancel() }
            if case .failed = state { conn.cancel() }
        }
        // One shared concurrent queue for all connections (was one queue per
        // connection): connections are independent short-lived request/response
        // pairs, and per-connection queues showed up as churn under burst load
        // (60x parallel /stats stress test).
        conn.start(queue: Self.connQueue)
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

    static func percentDecode(_ s: String) -> String {
        s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? s
    }

    static func parseForm(_ body: Data) -> [String: String] {
        var out: [String: String] = [:]
        for pair in String(decoding: body, as: UTF8.self).components(separatedBy: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { out[kv[0]] = percentDecode(kv[1]) }
        }
        return out
    }

    static func handle(method: String, path: String, body: Data, server: LocalServer) -> Data {
        let route = path.split(separator: "?").first.map(String.init) ?? path
        let components = URLComponents(string: "http://localhost\(path.hasPrefix("/") ? path : "/" + path)")
        let queryItems = components?.queryItems ?? []

        func json(_ obj: Any, status: Int = 200) -> Data {
            let payload = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
            let header = "HTTP/1.1 \(status) OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n"
            return Data(header.utf8) + payload
        }

        func rawResponse(_ text: String, contentType: String, status: Int = 200) -> Data {
            let payload = Data(text.utf8)
            let header = "HTTP/1.1 \(status) OK\r\nContent-Type: \(contentType)\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n"
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

        case ("GET", "/docker"):
            let containers = DockerObserver.sampleContainers()
            let totalMemMB = containers.reduce(0.0) { $0 + $1.memMB }
            let totalCpu = containers.reduce(0.0) { $0 + $1.cpu }
            let allProcs = server.processesProvider().all
            let primaryPid = DockerObserver.findPrimaryDockerPid(in: allProcs)
            let vmHost = allProcs.first(where: { $0.pid == primaryPid })

            let list: [[String: Any]] = containers.map {
                [
                    "id": $0.id,
                    "name": $0.name,
                    "image": $0.image,
                    "cpu": $0.cpu,
                    "memMB": $0.memMB,
                    "memLimitMB": $0.memLimitMB,
                    "memPercent": $0.memPercent,
                    "netInMB": $0.netInMB,
                    "netOutMB": $0.netOutMB,
                    "diskReadMB": $0.diskReadMB,
                    "diskWriteMB": $0.diskWriteMB,
                    "pids": $0.pids,
                    "status": $0.status,
                    "ports": $0.ports
                ]
            }
            return json([
                "containers": list,
                "count": list.count,
                "totalContainerMemMB": totalMemMB,
                "totalContainerMemGB": totalMemMB / 1024,
                "totalContainerCpu": totalCpu,
                "vmHostPid": primaryPid ?? 0,
                "vmHostMemMB": vmHost?.memMB ?? 0
            ])

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

        case ("GET", "/cache"):
            let stats = DurableStore.shared.cacheStats()
            return json([
                "persistenceEnabled": SettingsStore.shared.historyPersistenceEnabled,
                "filesCount": stats.filesCount,
                "totalBytes": stats.totalBytes,
                "lastUpdated": stats.lastUpdated?.timeIntervalSince1970 ?? 0
            ])

        case ("POST", "/cache/reset"), ("GET", "/cache/reset"):
            let res = DurableStore.shared.resetAll()
            server.onCacheReset?()
            return json([
                "ok": true,
                "clearedFiles": res.clearedFiles,
                "clearedBytes": res.clearedBytes,
                "message": "Durable cache cleared; rebuilding in background"
            ])

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
            var arr = (try? JSONSerialization.jsonObject(with: arrData)) as? [[String: Any]] ?? []
            for i in 0..<arr.count {
                if i < limits.count {
                    let lim = limits[i]
                    arr[i]["isWeekly"] = lim.isWeekly
                    arr[i]["remainingPercent"] = lim.remainingPercent
                    arr[i]["resetsSoon"] = lim.resetsSoon
                    if let r = lim.resetsAt {
                        let diff = r.timeIntervalSinceNow
                        arr[i]["resetsIn"] = DashboardTabs.formatReset(r)
                        arr[i]["resetsInShort"] = DashboardTabs.formatResetShort(r)
                        arr[i]["resetDateTime"] = DashboardTabs.formatResetDateTime(r)
                        arr[i]["urgency"] = diff < 86_400 ? "urgent" : diff < 172_800 ? "soon" : "normal"
                    }
                }
            }
            let weekly = limits.filter { $0.isWeekly }
                .sorted { ($0.resetsAt ?? .distantFuture) < ($1.resetsAt ?? .distantFuture) }
            let weeklyArr: [[String: Any]] = weekly.map { lim in
                var dict: [String: Any] = [
                    "provider": lim.provider,
                    "label": lim.label,
                    "usedPercent": lim.usedPercent,
                    "remainingPercent": lim.remainingPercent,
                    "detail": lim.detail,
                    "resetsSoon": lim.resetsSoon
                ]
                if let r = lim.resetsAt {
                    let diff = r.timeIntervalSinceNow
                    dict["resetsAt"] = r.timeIntervalSince1970
                    dict["resetsIn"] = DashboardTabs.formatReset(r)
                    dict["resetsInShort"] = DashboardTabs.formatResetShort(r)
                    dict["resetDateTime"] = DashboardTabs.formatResetDateTime(r)
                    dict["urgency"] = diff < 86_400 ? "urgent" : diff < 172_800 ? "soon" : "normal"
                }
                return dict
            }
            var resultDict: [String: Any] = [
                "limits": arr,
                "weeklyResets": weeklyArr
            ]
            if let next = weeklyArr.first {
                resultDict["nextWeeklyReset"] = next
                if let prov = next["provider"] as? String, let inStr = next["resetsIn"] as? String, let rem = next["remainingPercent"] as? Double {
                    resultDict["maximizerRecommendation"] = "Prioritize using \(DashboardTabs.providerNameDisplay(prov)) — resets in \(inStr) with \(String(format: "%.0f%%", rem)) unused tokens remaining."
                }
            }
            return json(resultDict)

        case ("GET", "/claude/accounts"):
            let snap = server.statsProvider()
            let enc = JSONEncoder()
            enc.dateEncodingStrategy = .secondsSince1970
            let accountsData = (try? enc.encode(snap.claudeAccounts)) ?? Data("[]".utf8)
            let arr = (try? JSONSerialization.jsonObject(with: accountsData)) as? [Any] ?? []
            return json(["accounts": arr])

        case ("GET", "/leaderboard"):
            let periodParam = queryItems.first(where: { $0.name == "period" })?.value
            let period = LeaderboardPeriod.from(query: periodParam)
            let teamParam = queryItems.first(where: { $0.name == "team" })?.value
            let formatParam = queryItems.first(where: { $0.name == "format" })?.value

            if let formatParam, formatParam != "json" {
                let fmt = ShareCardFormat.from(query: formatParam)
                let card = LeaderboardStore.shared.generateShareCard(for: period, format: fmt)
                return rawResponse(card, contentType: fmt.contentType)
            }

            // Sync local entry
            let snap = server.statsProvider()
            let hist = server.historyProvider(30)
            LeaderboardStore.shared.syncLocal(snapshot: snap, history: hist.points, streak: hist.streak)

            let ranked = LeaderboardStore.shared.rankings(for: period, teamFilter: teamParam)
            let localRanked = ranked.first(where: { $0.entry.isLocal })

            let enc = JSONEncoder()
            enc.dateEncodingStrategy = .secondsSince1970
            let rankedData = (try? enc.encode(ranked)) ?? Data("[]".utf8)
            let rankedArr = (try? JSONSerialization.jsonObject(with: rankedData)) as? [Any] ?? []

            var userRankObj: [String: Any]? = nil
            if let localRanked,
               let localData = try? enc.encode(localRanked),
               let obj = try? JSONSerialization.jsonObject(with: localData) as? [String: Any] {
                userRankObj = obj
            }

            return json([
                "period": period.rawValue,
                "periodTitle": period.title,
                "total": ranked.count,
                "team": teamParam ?? "",
                "userRank": (userRankObj as Any),
                "leaderboard": rankedArr
            ])

        case ("POST", "/leaderboard"):
            let dec = JSONDecoder()
            dec.dateDecodingStrategy = .secondsSince1970
            if let entry = try? dec.decode(LeaderboardEntry.self, from: body) {
                LeaderboardStore.shared.addOrUpdateEntry(entry)
                return json(["ok": true, "entry": entry.id])
            }
            return json(["error": "invalid leaderboard entry json"], status: 400)

        case ("POST", "/leaderboard/sync"):
            let snap = server.statsProvider()
            let hist = server.historyProvider(30)
            LeaderboardStore.shared.syncLocal(snapshot: snap, history: hist.points, streak: hist.streak)
            let local = LeaderboardStore.shared.localEntry()
            let enc = JSONEncoder()
            enc.dateEncodingStrategy = .secondsSince1970
            let localData = (try? enc.encode(local)) ?? Data("{}".utf8)
            let localObj = (try? JSONSerialization.jsonObject(with: localData)) as? [String: Any] ?? [:]
            return json(["ok": true, "local": localObj])

        case ("GET", "/leaderboard/share"):
            let periodParam = queryItems.first(where: { $0.name == "period" })?.value
            let period = LeaderboardPeriod.from(query: periodParam)
            let formatParam = queryItems.first(where: { $0.name == "format" })?.value
            let format = ShareCardFormat.from(query: formatParam)
            let entryId = queryItems.first(where: { $0.name == "id" })?.value
            let doCopy = queryItems.first(where: { $0.name == "copy" })?.value == "1" || queryItems.first(where: { $0.name == "copy" })?.value == "true"

            let snap = server.statsProvider()
            let hist = server.historyProvider(30)
            LeaderboardStore.shared.syncLocal(snapshot: snap, history: hist.points, streak: hist.streak)

            if doCopy {
                _ = LeaderboardStore.shared.copyShareCard(for: period, format: format, entryId: entryId)
            }

            let card = LeaderboardStore.shared.generateShareCard(for: period, format: format, entryId: entryId)
            return rawResponse(card, contentType: format.contentType)

        case ("POST", "/leaderboard/sheets/publish"), ("GET", "/leaderboard/sheets/publish"):
            let snap = server.statsProvider()
            let hist = server.historyProvider(30)
            LeaderboardStore.shared.syncLocal(snapshot: snap, history: hist.points, streak: hist.streak)

            let sema = DispatchSemaphore(value: 0)
            var result: Result<String, Error>?
            LeaderboardStore.shared.publishToGoogleSheet { res in
                result = res
                sema.signal()
            }
            _ = sema.wait(timeout: .now() + 10.0)

            switch result {
            case .success(let msg):
                return json(["ok": true, "message": msg])
            case .failure(let err):
                return json(["ok": false, "error": err.localizedDescription], status: 500)
            case .none:
                return json(["ok": false, "error": "Google Sheets publish timed out"], status: 504)
            }

        case ("POST", "/leaderboard/sheets/pull"), ("GET", "/leaderboard/sheets/pull"):
            let sema = DispatchSemaphore(value: 0)
            var result: Result<Int, Error>?
            LeaderboardStore.shared.pullFromGoogleSheet { res in
                result = res
                sema.signal()
            }
            _ = sema.wait(timeout: .now() + 10.0)

            switch result {
            case .success(let count):
                return json(["ok": true, "count": count, "message": "Pulled leaderboard from Google Sheet"])
            case .failure(let err):
                return json(["ok": false, "error": err.localizedDescription], status: 500)
            case .none:
                return json(["ok": false, "error": "Google Sheets pull timed out"], status: 504)
            }

        case ("POST", "/leaderboard/cloudflare/publish"), ("GET", "/leaderboard/cloudflare/publish"),
             ("POST", "/leaderboard/cloud/publish"), ("GET", "/leaderboard/cloud/publish"):
            let snap = server.statsProvider()
            let hist = server.historyProvider(30)
            LeaderboardStore.shared.syncLocal(snapshot: snap, history: hist.points, streak: hist.streak)

            let sema = DispatchSemaphore(value: 0)
            var result: Result<String, Error>?
            LeaderboardStore.shared.publishToCloud(forced: true) { res in
                result = res
                sema.signal()
            }
            _ = sema.wait(timeout: .now() + 10.0)

            switch result {
            case .success(let msg):
                return json(["ok": true, "message": msg])
            case .failure(let err):
                return json(["ok": false, "error": err.localizedDescription], status: 500)
            case .none:
                return json(["ok": false, "error": "Cloud publish timed out"], status: 504)
            }

        case ("POST", "/leaderboard/cloudflare/pull"), ("GET", "/leaderboard/cloudflare/pull"),
             ("POST", "/leaderboard/cloud/pull"), ("GET", "/leaderboard/cloud/pull"):
            let sema = DispatchSemaphore(value: 0)
            var result: Result<Int, Error>?
            LeaderboardStore.shared.pullFromCloud(forced: true) { res in
                result = res
                sema.signal()
            }
            _ = sema.wait(timeout: .now() + 10.0)

            switch result {
            case .success(let count):
                return json(["ok": true, "count": count, "message": "Pulled leaderboard from cloud"])
            case .failure(let err):
                return json(["ok": false, "error": err.localizedDescription], status: 500)
            case .none:
                return json(["ok": false, "error": "Cloud pull timed out"], status: 504)
            }

        case ("GET", "/leaderboard/cloudflare/config"), ("GET", "/leaderboard/cloud/config"):
            let store = SettingsStore.shared
            return json([
                "cloudflareURL": store.leaderboardCloudURL,
                "cloudURL": store.leaderboardCloudURL,
                "cloudConfigured": store.leaderboardCloudConfigured
            ])

        case ("POST", "/leaderboard/cloudflare/config"), ("POST", "/leaderboard/cloud/config"):
            let store = SettingsStore.shared
            if let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                if let c = (obj["cloudflareURL"] ?? obj["cloudURL"]) as? String { store.leaderboardCloudURL = c }
                if let t = obj["cloudToken"] as? String { store.leaderboardCloudToken = t }
            } else {
                let form = parseForm(body)
                if let c = form["cloudflareURL"] ?? form["cloudURL"] { store.leaderboardCloudURL = c }
                if let t = form["cloudToken"] { store.leaderboardCloudToken = t }
            }
            return json([
                "ok": true,
                "cloudflareURL": store.leaderboardCloudURL,
                "cloudURL": store.leaderboardCloudURL,
                "cloudConfigured": store.leaderboardCloudConfigured
            ])

        case ("GET", "/leaderboard/sheets/config"):
            let store = SettingsStore.shared
            return json([
                "sheetsURL": store.leaderboardSheetsURL,
                "autoSync": store.leaderboardAutoSync,
                "cloudflareURL": store.leaderboardCloudURL,
                "cloudURL": store.leaderboardCloudURL,
                "cloudConfigured": store.leaderboardCloudConfigured
            ])

        case ("POST", "/leaderboard/sheets/config"):
            let store = SettingsStore.shared
            if let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                if let u = obj["sheetsURL"] as? String { store.leaderboardSheetsURL = u }
                if let a = obj["autoSync"] as? Bool { store.leaderboardAutoSync = a }
                if let c = (obj["cloudflareURL"] ?? obj["cloudURL"]) as? String { store.leaderboardCloudURL = c }
                if let t = obj["cloudToken"] as? String { store.leaderboardCloudToken = t }
            } else {
                let form = parseForm(body)
                if let u = form["sheetsURL"] { store.leaderboardSheetsURL = u }
                if let a = form["autoSync"] { store.leaderboardAutoSync = (a == "true" || a == "1") }
                if let c = form["cloudflareURL"] ?? form["cloudURL"] { store.leaderboardCloudURL = c }
                if let t = form["cloudToken"] { store.leaderboardCloudToken = t }
            }
            return json([
                "ok": true,
                "sheetsURL": store.leaderboardSheetsURL,
                "autoSync": store.leaderboardAutoSync,
                "cloudflareURL": store.leaderboardCloudURL,
                "cloudURL": store.leaderboardCloudURL,
                "cloudConfigured": store.leaderboardCloudConfigured
            ])

        case ("GET", "/leaderboard/web"), ("HEAD", "/leaderboard/web"), ("GET", "/leaderboard/pages"), ("HEAD", "/leaderboard/pages"):
            let cloudUrl = SettingsStore.shared.leaderboardCloudURL
            let sheetUrl = SettingsStore.shared.leaderboardSheetsURL
            var target = "https://castlemilk.github.io/token-horizon/leaderboard.html"
            if !cloudUrl.isEmpty {
                target = cloudUrl.hasSuffix("/leaderboard.html") ? cloudUrl : "\(cloudUrl)/leaderboard.html"
            } else if !sheetUrl.isEmpty, let encoded = sheetUrl.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
                target += "?sheet=\(encoded)"
            }
            let redirectResponse = [
                "HTTP/1.1 302 Found",
                "Location: \(target)",
                "Content-Length: 0",
                "Connection: close",
                "\r\n"
            ].joined(separator: "\r\n")
            return Data(redirectResponse.utf8)

        case ("GET", "/top-picks"), ("GET", "/models/top-picks"):
            let snap = server.statsProvider()
            let catalog = ModelCatalog.shared.allEntries()
            let result = ModelsPipeline.compute(
                search: "",
                scope: .all,
                sortColumn: .sweBench,
                sortAscending: false,
                catalog: catalog,
                syntheticModels: [],
                usageModels: snap.models
            )
            let picks: [[String: Any]] = result.topPicks.map { pick in
                var dict: [String: Any] = [
                    "rank": pick.rank,
                    "id": pick.row.id,
                    "name": pick.row.displayName,
                    "provider": pick.row.providerDisplay,
                    "valueScore": pick.valueScore,
                    "perfScore": pick.perfScore,
                    "inputPrice": pick.row.inputPrice,
                    "outputPrice": pick.row.outputPrice,
                    "effectiveInputPrice": pick.row.effectiveInputPrice,
                    "blendedNetCost": pick.row.blendedNetCost,
                    "blendedNetCostText": pick.row.blendedNetCostText,
                    "netSavingsPercent": pick.row.netSavingsPercent,
                    "blendedCostPerM": pick.blendedCostPerM,
                    "hasDiscount": pick.row.hasDiscount,
                    "badge": pick.badge,
                    "reason": pick.reason,
                    "contextK": pick.row.contextK
                ]
                if let cp = pick.row.cachePrice { dict["cachePrice"] = cp }
                if let swe = pick.row.sweScore { dict["sweScore"] = swe }
                if let lcb = pick.row.lcbScore { dict["lcbScore"] = lcb }
                if let disc = pick.row.discountPercent { dict["discountPercent"] = disc }
                if let lbl = pick.row.discountLabel { dict["discountLabel"] = lbl }
                return dict
            }
            return json(["topPicks": picks, "count": picks.count])

        case ("GET", "/models"):
            let search = queryItems.first(where: { $0.name == "search" || $0.name == "q" })?.value ?? ""
            let scopeStr = queryItems.first(where: { $0.name == "scope" })?.value?.uppercased() ?? "ALL"
            let scope = ModelFilterScope(rawValue: scopeStr) ?? .all
            let snap = server.statsProvider()
            let catalog = ModelCatalog.shared.allEntries()
            let result = ModelsPipeline.compute(
                search: search,
                scope: scope,
                sortColumn: .sweBench,
                sortAscending: false,
                catalog: catalog,
                syntheticModels: [],
                usageModels: snap.models
            )
            let rows: [[String: Any]] = result.filtered.prefix(100).map { row in
                var dict: [String: Any] = [
                    "id": row.id,
                    "name": row.displayName,
                    "provider": row.providerDisplay,
                    "inputPrice": row.inputPrice,
                    "outputPrice": row.outputPrice,
                    "effectiveInputPrice": row.effectiveInputPrice,
                    "blendedNetCost": row.blendedNetCost,
                    "blendedNetCostText": row.blendedNetCostText,
                    "netSavingsPercent": row.netSavingsPercent,
                    "hasDiscount": row.hasDiscount,
                    "contextK": row.contextK,
                    "contextText": row.contextText,
                    "isLocal": row.isLocal,
                    "isFree": row.isFree
                ]
                if let cp = row.cachePrice { dict["cachePrice"] = cp }
                if let swe = row.sweScore { dict["sweScore"] = swe }
                if let lcb = row.lcbScore { dict["lcbScore"] = lcb }
                if let disc = row.discountPercent { dict["discountPercent"] = disc }
                if let lbl = row.discountLabel { dict["discountLabel"] = lbl }
                return dict
            }
            return json(["count": result.filtered.count, "scope": scope.rawValue, "models": rows])

        case ("GET", "/discovery/status"), ("GET", "/models/discovery"):
            let st = ModelDiscoveryEngine.shared.status()
            let enc = JSONEncoder()
            enc.dateEncodingStrategy = .iso8601
            let data = (try? enc.encode(st)) ?? Data("{}".utf8)
            let jsonObj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            return json(jsonObj)

        case ("POST", "/discovery/scan"), ("POST", "/models/scan"):
            let incRemote = queryItems.first(where: { $0.name == "remote" })?.value != "0"
            let summary = ModelDiscoveryEngine.shared.triggerScan(includeRemote: incRemote)
            let enc = JSONEncoder()
            enc.dateEncodingStrategy = .iso8601
            let data = (try? enc.encode(summary)) ?? Data("{}".utf8)
            let jsonObj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            return json(jsonObj)

        case ("GET", "/health"):
            let proxyPort: Any = if let port = OllamaTelemetryProxy.shared.port {
                Int(port)
            } else {
                NSNull()
            }
            return json([
                "ok": true,
                "version": BuildInfo.version,
                "name": "token-horizon",
                "ollama_proxy_port": proxyPort,
                "build": [
                    "version": BuildInfo.version,
                    "commit": BuildInfo.commit,
                    "built_at": BuildInfo.builtAt,
                ],
            ])

        default:
            return json(["error": "not found"], status: 404)
        }
    }
}

final class EventStore {
    static let shared = EventStore()
    private var events: [ShellEvent] = []
    private let lock = NSLock()

    func add(_ ev: ShellEvent) {
        lock.lock(); defer { lock.unlock() }
        events.insert(ev, at: 0)
        if events.count > 200 { events.removeLast(events.count - 200) }
    }

    func recent(limit: Int) -> [ShellEvent] {
        lock.lock(); defer { lock.unlock() }
        return Array(events.prefix(limit))
    }

    func latest() -> ShellEvent? {
        lock.lock(); defer { lock.unlock() }
        return events.first
    }
}
