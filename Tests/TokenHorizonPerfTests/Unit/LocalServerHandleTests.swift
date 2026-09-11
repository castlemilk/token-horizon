import XCTest
@testable import TokenHorizon

/// Tests for LocalServer's pure HTTP layer: percent-decoding, form parsing,
/// and route handling via `handle()` with stub providers. No sockets are
/// bound (port-free by design), no shared state is mutated, and no live
/// system calls run — routes touching live/destructive backends (docker,
/// kill, sheets/cloud publish, cache reset, leaderboard sync) are
/// deliberately NOT covered here.
final class LocalServerHandleTests: XCTestCase {

    // MARK: - Harness

    private final class Events {
        var list: [ShellEvent] = []
    }

    private func stubServer(events: Events) -> LocalServer {
        var snap = UsageSnapshot.empty
        snap.tokensToday = 123
        snap.tokensAllTime = 456
        return LocalServer(
            statsProvider: { snap },
            sysProvider: {
                var s = SystemStats.Snapshot()
                s.cpuPercent = 42
                s.ramUsedGB = 8
                s.ramTotalGB = 16
                s.loadAvg1 = 1.5
                return s
            },
            historyProvider: { days in
                (points: [HistoryPoint(day: 7, tokens: 10, cost: 0.1, byTool: ["claude": 10])],
                 streak: 3)
            },
            trendsProvider: { _ in [] },
            limitsProvider: {
                [ProviderLimit(provider: "test", label: "5h", usedPercent: 10,
                               resetsAt: nil, detail: "d")]
            },
            processesProvider: {
                let p = ProcSample(pid: 99, ppid: 1, name: "testproc",
                                   command: "/bin/testproc", user: "u", threads: 2,
                                   cpu: 5, memMB: 10, diskReadMBps: 0, diskWriteMBps: 0,
                                   netInKBps: 0, netOutKBps: 0, startTime: Date())
                return (all: [p], byCPU: [p], byMem: [p], byDisk: [p], byNet: [p])
            },
            onEvent: { events.list.append($0) },
            onCacheReset: nil)
    }

    /// Splits a handle() response into status code + JSON body (if any).
    private func call(_ srv: LocalServer, _ method: String, _ path: String,
                      body: Data = Data()) -> (code: Int, contentType: String, json: Any?) {
        let data = LocalServer.handle(method: method, path: path, body: body, server: srv)
        let sep = Data("\r\n\r\n".utf8)
        guard let range = data.range(of: sep) else {
            XCTFail("no header/body separator"); return (0, "", nil)
        }
        let head = String(decoding: data[..<range.lowerBound], as: UTF8.self)
        let statusLine = head.components(separatedBy: "\r\n").first ?? ""
        let code = Int(statusLine.components(separatedBy: " ")[safe: 1] ?? "") ?? 0
        var contentType = ""
        for line in head.components(separatedBy: "\r\n") where line.lowercased().hasPrefix("content-type:") {
            contentType = line
        }
        let payload = data[range.upperBound...]
        let json: Any? = (try? JSONSerialization.jsonObject(with: Data(payload)))
        return (code, contentType, json)
    }

    // MARK: - Pure helpers

    func testPercentDecode() {
        XCTAssertEqual(LocalServer.percentDecode("a+b%20c"), "a b c")
        XCTAssertEqual(LocalServer.percentDecode("plain"), "plain")
        XCTAssertEqual(LocalServer.percentDecode("%2Ftmp%2Fx"), "/tmp/x")
    }

    func testParseForm() {
        XCTAssertEqual(LocalServer.parseForm(Data("cwd=%2Ftmp&dur=5&exit=0".utf8)),
                       ["cwd": "/tmp", "dur": "5", "exit": "0"])
        XCTAssertEqual(LocalServer.parseForm(Data("a".utf8)), [:])
        XCTAssertEqual(LocalServer.parseForm(Data("".utf8)), [:])
        XCTAssertEqual(LocalServer.parseForm(Data("k=a%26b".utf8)), ["k": "a&b"])
    }

    // MARK: - Routes

    func testHealth_shape() {
        let r = call(stubServer(events: Events()), "GET", "/health")
        XCTAssertEqual(r.code, 200)
        let obj = r.json as? [String: Any]
        XCTAssertEqual(obj?["ok"] as? Bool, true)
        XCTAssertEqual(obj?["name"] as? String, "token-horizon")
        XCTAssertNotNil((obj?["build"] as? [String: Any])?["commit"])
    }

    func testStats_shape() {
        let r = call(stubServer(events: Events()), "GET", "/stats")
        XCTAssertEqual(r.code, 200)
        let obj = r.json as? [String: Any]
        XCTAssertEqual((obj?["usage"] as? [String: Any])?["tokensToday"] as? Int, 123)
        XCTAssertEqual((obj?["system"] as? [String: Any])?["cpu_percent"] as? Double, 42)
    }

    func testEvent_postCapturesAndDefaults() {
        let events = Events()
        let srv = stubServer(events: events)
        let r = call(srv, "POST", "/event", body: Data("cwd=/tmp&dur=150&exit=2".utf8))
        XCTAssertEqual((r.json as? [String: Any])?["ok"] as? Bool, true)
        XCTAssertEqual(events.list.count, 1)
        XCTAssertEqual(events.list.first?.cwd, "/tmp")
        XCTAssertEqual(events.list.first?.durationMs, 150)
        XCTAssertEqual(events.list.first?.exit, 2)

        let r2 = call(srv, "POST", "/event")
        XCTAssertEqual((r2.json as? [String: Any])?["ok"] as? Bool, true)
        XCTAssertEqual(events.list.count, 2)
        XCTAssertEqual(events.list.last?.cwd, "")
    }

    func testProcesses_shape() {
        let r = call(stubServer(events: Events()), "GET", "/processes")
        XCTAssertEqual(r.code, 200)
        let obj = r.json as? [String: Any]
        let all = obj?["all"] as? [[String: Any]]
        XCTAssertEqual(all?.first?["pid"] as? Int, 99)
        XCTAssertNotNil(obj?["tree"])
        XCTAssertEqual((obj?["byCPU"] as? [Any])?.count, 1)
    }

    func testHistory_clampsDays() {
        let srv = stubServer(events: Events())
        for (query, want) in [("days=7", 7), ("days=3", 7), ("days=500", 370), ("", 365)] {
            let path = query.isEmpty ? "/history" : "/history?\(query)"
            let r = call(srv, "GET", path)
            XCTAssertEqual(r.code, 200, query)
            XCTAssertEqual((r.json as? [String: Any])?["days"] as? Int, want, query)
        }
    }

    func testTrends_windowValidation() {
        let srv = stubServer(events: Events())
        let ok = call(srv, "GET", "/trends?window=1D")
        XCTAssertEqual(ok.code, 200)
        XCTAssertEqual((ok.json as? [String: Any])?["window"] as? String, "1D")
        let def = call(srv, "GET", "/trends")
        XCTAssertEqual((def.json as? [String: Any])?["window"] as? String, "1M")
        let bad = call(srv, "GET", "/trends?window=bogus")
        XCTAssertEqual(bad.code, 400)
        XCTAssertNotNil((bad.json as? [String: Any])?["error"])
    }

    func testLimits_shapeAndWeeklyDerivations() {
        let weekly = ProviderLimit(provider: "acme", label: "weekly", usedPercent: 80,
                                   resetsAt: Date().addingTimeInterval(3600), detail: "w")
        let plain = ProviderLimit(provider: "acme", label: "5h", usedPercent: 10,
                                  resetsAt: nil, detail: "p")
        let srv = LocalServer(
            statsProvider: { UsageSnapshot.empty }, sysProvider: { SystemStats.Snapshot() },
            historyProvider: { _ in ([], 0) }, trendsProvider: { _ in [] },
            limitsProvider: { [plain, weekly] },
            processesProvider: { ([], [], [], [], []) },
            onEvent: { _ in }, onCacheReset: nil)
        let r = call(srv, "GET", "/limits")
        XCTAssertEqual(r.code, 200)
        let obj = r.json as? [String: Any]
        XCTAssertEqual((obj?["limits"] as? [Any])?.count, 2)
        let weeklyArr = obj?["weeklyResets"] as? [[String: Any]]
        XCTAssertEqual(weeklyArr?.count, 1)
        XCTAssertEqual(weeklyArr?.first?["urgency"] as? String, "urgent")
        XCTAssertEqual(weeklyArr?.first?["resetsSoon"] as? Bool, true)
        // Maximizer recommendation carries the remaining headroom.
        let rec = obj?["maximizerRecommendation"] as? String ?? ""
        XCTAssertTrue(rec.contains("20%"), rec)
    }

    func testClaudeAccounts_shape() {
        let r = call(stubServer(events: Events()), "GET", "/claude/accounts")
        XCTAssertEqual(r.code, 200)
        XCTAssertNotNil((r.json as? [String: Any])?["accounts"])
    }

    func testModelsAndTopPicks_shape() {
        let srv = stubServer(events: Events())
        let m = call(srv, "GET", "/models?search=&scope=ALL")
        XCTAssertEqual(m.code, 200)
        let mobj = m.json as? [String: Any]
        XCTAssertEqual(mobj?["scope"] as? String, "ALL")
        XCTAssertNotNil(mobj?["count"])
        XCTAssertNotNil(mobj?["models"])
        let t = call(srv, "GET", "/top-picks")
        XCTAssertEqual(t.code, 200)
        XCTAssertNotNil((t.json as? [String: Any])?["topPicks"])
    }

    func testMetrics_servesPrometheusText() {
        let r = call(stubServer(events: Events()), "GET", "/metrics")
        XCTAssertEqual(r.code, 200)
        XCTAssertTrue(r.contentType.lowercased().contains("text/plain"))
    }

    func testDiscoveryStatus_shape() {
        // Read-only: status() inspects locks/timestamps, never scans or
        // touches the network. (POST /discovery/scan is deliberately
        // untested here — it performs live provider fetches.)
        for path in ["/discovery/status", "/models/discovery"] {
            let r = call(stubServer(events: Events()), "GET", path)
            XCTAssertEqual(r.code, 200, path)
            let obj = r.json as? [String: Any]
            XCTAssertNotNil(obj?["catalogCount"], path)
            XCTAssertNotNil(obj?["catalogRevision"], path)
            XCTAssertNotNil(obj?["monitoredFiles"], path)
        }
    }

    func testUnknownRoute_404() {
        let r = call(stubServer(events: Events()), "GET", "/nope")
        XCTAssertEqual(r.code, 404)
        XCTAssertNotNil((r.json as? [String: Any])?["error"])
    }

    func testEvents_shape() {
        // Shape only: the shared in-memory store reflects this process.
        let r = call(stubServer(events: Events()), "GET", "/events")
        XCTAssertEqual(r.code, 200)
        XCTAssertNotNil(r.json as? [Any])
    }

    func testCache_shape() {
        // Shape only: values reflect the developer's real disk cache.
        let r = call(stubServer(events: Events()), "GET", "/cache")
        XCTAssertEqual(r.code, 200)
        let obj = r.json as? [String: Any]
        XCTAssertNotNil(obj?["persistenceEnabled"])
        XCTAssertNotNil(obj?["filesCount"])
        XCTAssertNotNil(obj?["totalBytes"])
        XCTAssertNotNil(obj?["lastUpdated"])
    }
}

/// EventStore is an in-memory capped ring (same file as LocalServer).
/// Confined to the test process — the app's store is untouched.
final class EventStoreTests: XCTestCase {

    func testAddRecentCapsAt200() {
        let store = EventStore.shared
        for i in 0..<205 {
            store.add(ShellEvent(time: Date(), cwd: "/t\(i)", durationMs: i, exit: 0))
        }
        // 205 fresh adds always evict everything older: exactly the newest 200.
        let all = store.recent(limit: 10_000)
        XCTAssertEqual(all.count, 200)
        XCTAssertEqual(all.first?.cwd, "/t204")
    }

    func testLatestTracksMostRecentAdd() {
        let store = EventStore.shared
        let stamp = "/latest-\(UUID().uuidString)"
        store.add(ShellEvent(time: Date(), cwd: stamp, durationMs: 1, exit: 0))
        XCTAssertEqual(store.latest()?.cwd, stamp)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
