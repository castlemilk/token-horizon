import XCTest
@testable import TokenHorizon

final class LeaderboardTests: XCTestCase {

    func testLeaderboardPeriod_fromQuery() {
        XCTAssertEqual(LeaderboardPeriod.from(query: "today"), .today)
        XCTAssertEqual(LeaderboardPeriod.from(query: "1D"), .today)
        XCTAssertEqual(LeaderboardPeriod.from(query: "day"), .today)
        XCTAssertEqual(LeaderboardPeriod.from(query: "7d"), .week)
        XCTAssertEqual(LeaderboardPeriod.from(query: "week"), .week)
        XCTAssertEqual(LeaderboardPeriod.from(query: "1w"), .week)
        XCTAssertEqual(LeaderboardPeriod.from(query: "all"), .all)
        XCTAssertEqual(LeaderboardPeriod.from(query: "all-time"), .all)
        XCTAssertEqual(LeaderboardPeriod.from(query: "streak"), .streak)
        XCTAssertEqual(LeaderboardPeriod.from(query: "unknown"), .today)
        XCTAssertEqual(LeaderboardPeriod.from(query: nil), .today)
    }

    func testShareCardFormat_fromQueryAndContentType() {
        XCTAssertEqual(ShareCardFormat.from(query: "text"), .text)
        XCTAssertEqual(ShareCardFormat.from(query: "markdown"), .markdown)
        XCTAssertEqual(ShareCardFormat.from(query: "md"), .markdown)
        XCTAssertEqual(ShareCardFormat.from(query: "json"), .json)
        XCTAssertEqual(ShareCardFormat.from(query: "svg"), .svg)
        XCTAssertEqual(ShareCardFormat.from(query: "image"), .svg)
        XCTAssertEqual(ShareCardFormat.from(query: nil), .text)

        XCTAssertTrue(ShareCardFormat.text.contentType.contains("text/plain"))
        XCTAssertTrue(ShareCardFormat.markdown.contentType.contains("text/markdown"))
        XCTAssertTrue(ShareCardFormat.json.contentType.contains("application/json"))
        XCTAssertTrue(ShareCardFormat.svg.contentType.contains("image/svg+xml"))
    }

    func testLeaderboardSettings_persistence() {
        let store = SettingsStore.shared
        let origHandle = store.leaderboardHandle
        let origTeam = store.leaderboardTeam
        let origCost = store.leaderboardShareCost
        let origHw = store.leaderboardShareHardware

        store.leaderboardHandle = "test-agent-42"
        XCTAssertEqual(store.leaderboardHandle, "test-agent-42")

        store.leaderboardTeam = "Quantum Labs"
        XCTAssertEqual(store.leaderboardTeam, "Quantum Labs")

        store.leaderboardShareCost = false
        XCTAssertFalse(store.leaderboardShareCost)

        store.leaderboardShareHardware = true
        XCTAssertTrue(store.leaderboardShareHardware)

        // Restore
        store.leaderboardHandle = origHandle
        store.leaderboardTeam = origTeam
        store.leaderboardShareCost = origCost
        store.leaderboardShareHardware = origHw
    }

    func testLeaderboardStore_syncLocalAndRankings() {
        let tempPath = NSTemporaryDirectory() + "test-leaderboard-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: tempPath) }
        let store = LeaderboardStore(customPath: tempPath)

        var snap = UsageSnapshot()
        snap.tokensToday = 1_500_000
        snap.tokensAllTime = 25_000_000
        snap.costToday = 12.50
        snap.costAllTime = 180.00
        snap.models = [
            ModelUsage(provider: "anthropic", model: "claude-3-7-sonnet", tokensAll: 20_000_000, tokensToday: 1_200_000, cost: 150.0, messages: 100, free: false)
        ]

        let history = [
            HistoryPoint(day: 20260901, tokens: 2_000_000, cost: 15.0, byTool: [:]),
            HistoryPoint(day: 20260902, tokens: 3_000_000, cost: 20.0, byTool: [:]),
            HistoryPoint(day: 20260903, tokens: 1_500_000, cost: 12.5, byTool: [:])
        ]

        store.syncLocal(snapshot: snap, history: history, streak: 16)

        let local = store.localEntry()
        XCTAssertNotNil(local)
        XCTAssertEqual(local?.tokensToday, 1_500_000)
        XCTAssertEqual(local?.tokensAll, 25_000_000)
        XCTAssertEqual(local?.streakDays, 16)
        XCTAssertEqual(local?.topModel, "claude-3-7-sonnet")
        XCTAssertTrue(local?.isLocal ?? false)

        // Add a peer entry to test ranking
        let peer = LeaderboardEntry(
            id: "peer:alice",
            handle: "alice",
            team: "Core Team",
            tokensToday: 5_000_000,
            tokens7d: 15_000_000,
            tokensAll: 10_000_000,
            costToday: 40.0,
            cost7d: 120.0,
            costAll: 80.0,
            streakDays: 5,
            topModel: "gpt-6-astra",
            hardware: "Apple M4 Max",
            isLocal: false,
            updatedAt: Date()
        )
        store.addOrUpdateEntry(peer)

        // Test TODAY rankings
        let todayRankings = store.rankings(for: .today)
        XCTAssertEqual(todayRankings.count, 2)
        XCTAssertEqual(todayRankings.first?.entry.id, "peer:alice")
        XCTAssertEqual(todayRankings.first?.rank, 1)
        XCTAssertEqual(todayRankings.first?.badge, "🥇 1st")

        // Test ALL-TIME rankings: local has 25M tokens > alice's 10M tokens
        let allRankings = store.rankings(for: .all)
        XCTAssertEqual(allRankings.first?.entry.isLocal, true)
        XCTAssertEqual(allRankings.first?.rank, 1)

        // Test STREAK rankings: local has 16d > alice's 5d
        let streakRankings = store.rankings(for: .streak)
        XCTAssertEqual(streakRankings.first?.entry.isLocal, true)
        XCTAssertEqual(streakRankings.first?.score, 16)
    }

    func testSyncLocal_promptHistoryIsPrivateUntilEnabled() {
        let settings = SettingsStore.shared
        let origPrompts = settings.leaderboardSharePrompts
        defer { settings.leaderboardSharePrompts = origPrompts }

        let tempPath = NSTemporaryDirectory() + "test-prompts-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: tempPath) }
        let board = LeaderboardStore(customPath: tempPath)

        var snap = UsageSnapshot()
        snap.tokensToday = 1_000_000
        snap.tokensAllTime = 5_000_000
        snap.recentSessions = [
            SessionSummary(id: "s1", title: "Secret project kickoff", cost: 1.0,
                           tokens: 1_000, directory: "/tmp/p", created: Date())
        ]

        settings.leaderboardSharePrompts = false
        board.syncLocal(snapshot: snap, history: [], streak: 3)
        let redacted = board.localEntry()?.breakdown?.sessions ?? []
        XCTAssertEqual(redacted.count, 1, "activity rows still publish without titles")
        XCTAssertEqual(redacted.first?.title, "", "prompt titles must stay private while the setting is off")
        XCTAssertEqual(redacted.first?.tokens, 1_000)

        settings.leaderboardSharePrompts = true
        board.syncLocal(snapshot: snap, history: [], streak: 3)
        XCTAssertEqual(board.localEntry()?.breakdown?.sessions.count, 1)
        XCTAssertEqual(board.localEntry()?.breakdown?.sessions.first?.title, "Secret project kickoff")
    }

    func testSyncLocal_calendarDailyExcludesZeroDays() {
        let tempPath = NSTemporaryDirectory() + "test-calendar-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: tempPath) }
        let board = LeaderboardStore(customPath: tempPath)

        var snap = UsageSnapshot()
        snap.tokensToday = 1_000_000
        snap.tokensAllTime = 5_000_000
        let today = Int(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970)
        let history = (0..<10).map { i in
            HistoryPoint(day: today - i * 86_400, tokens: i % 2 == 0 ? 0 : 1_000, cost: 0, byTool: [:])
        }
        board.syncLocal(snapshot: snap, history: history, streak: 1)
        let daily = board.localEntry()?.breakdown?.daily ?? []
        XCTAssertEqual(daily.count, 5)
        XCTAssertTrue(daily.allSatisfy { $0.tokens > 0 })
    }

    func testLeaderboardStore_shareCardFormats() {
        let tempPath = NSTemporaryDirectory() + "test-sharecard-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: tempPath) }
        let store = LeaderboardStore(customPath: tempPath)

        var snap = UsageSnapshot()
        snap.tokensToday = 800_000
        snap.tokensAllTime = 12_000_000
        snap.costToday = 6.40
        snap.costAllTime = 95.00
        store.syncLocal(snapshot: snap, history: [], streak: 12)

        // 1. Text format
        let textCard = store.generateShareCard(for: .today, format: .text)
        XCTAssertTrue(textCard.contains("TOKEN HORIZON LEADERBOARD"))
        XCTAssertTrue(textCard.contains("Hardware:"))
        XCTAssertTrue(textCard.contains("Active Streak:"))

        // 2. Markdown format
        let mdCard = store.generateShareCard(for: .today, format: .markdown)
        XCTAssertTrue(mdCard.contains("### 🌌 Token Horizon Usage Card"))
        XCTAssertTrue(mdCard.contains("| Metric | Value | Rank & Status |"))
        XCTAssertTrue(mdCard.contains("Today's Tokens"))

        // 3. JSON format
        let jsonCard = store.generateShareCard(for: .today, format: .json)
        guard let jsonData = jsonCard.data(using: .utf8),
              let jsonDict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
            XCTFail("Share card JSON invalid")
            return
        }
        XCTAssertNotNil(jsonDict["handle"])
        XCTAssertNotNil(jsonDict["rank"])
        XCTAssertEqual(jsonDict["period"] as? String, "today")

        // 4. SVG format
        let svgCard = store.generateShareCard(for: .today, format: .svg)
        XCTAssertTrue(svgCard.contains("<svg"))
        XCTAssertTrue(svgCard.contains("viewBox=\"0 0 540 260\""))
        XCTAssertTrue(svgCard.contains("TOKEN HORIZON · LEADERBOARD"))
        XCTAssertTrue(svgCard.contains("</svg>"))
    }

    func testGoogleSheets_resolveURLs() {
        // Apps Script Web App
        let appsScript = "https://script.google.com/macros/s/AKfycbx12345/exec"
        let res1 = LeaderboardStore.resolveGoogleSheetsURL(appsScript)
        XCTAssertEqual(res1.readURL?.absoluteString, appsScript)
        XCTAssertEqual(res1.writeURL?.absoluteString, appsScript)

        // Google Sheet document URL
        let sheetDoc = "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0"
        let res2 = LeaderboardStore.resolveGoogleSheetsURL(sheetDoc)
        XCTAssertEqual(res2.readURL?.absoluteString, "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/gviz/tq?tqx=out:csv")
        XCTAssertNil(res2.writeURL)
    }

    func testGoogleSheets_CSVParser() {
        let csv = """
        Handle,Team,Tokens Today,Tokens 7D,Tokens All-Time,Cost Today,Cost 7D,Cost All-Time,Streak Days,Top Model,Hardware,Updated At
        @benebsworth,Frontier,1500000,8000000,20000000,12.50,60.00,150.00,16,gpt-6-astra,"Apple M5 Max",2026-09-09
        alice,"Core Team",5000000,15000000,10000000,40.00,120.00,80.00,5,claude-3-7-sonnet,"Apple M4 Max",2026-09-09
        """
        let rows = LeaderboardStore.parseCSV(csv)
        XCTAssertEqual(rows.count, 3)

        let entries = LeaderboardStore.parseEntriesFromCSV(rows)
        XCTAssertEqual(entries.count, 2)

        let first = entries[0]
        XCTAssertEqual(first.handle, "benebsworth")
        XCTAssertEqual(first.team, "Frontier")
        XCTAssertEqual(first.tokensToday, 1_500_000)
        XCTAssertEqual(first.tokens7d, 8_000_000)
        XCTAssertEqual(first.tokensAll, 20_000_000)
        XCTAssertEqual(first.streakDays, 16)
        XCTAssertEqual(first.topModel, "gpt-6-astra")
        XCTAssertEqual(first.hardware, "Apple M5 Max")

        let second = entries[1]
        XCTAssertEqual(second.handle, "alice")
        XCTAssertEqual(second.team, "Core Team")
        XCTAssertEqual(second.tokensToday, 5_000_000)
    }

    func testGoogleSheets_JSONDictParsing() {
        let dict: [String: Any] = [
            "handle": "charlie",
            "team": "Research",
            "tokensToday": 2_000_000,
            "tokens7d": 9_000_000,
            "tokensAll": 35_000_000,
            "costToday": 18.0,
            "cost7d": 75.0,
            "costAll": 290.0,
            "streakDays": 21,
            "topModel": "claude-3-7-sonnet",
            "hardware": "Apple M5 Max"
        ]
        let entry = LeaderboardStore.entryFromDict(dict)
        XCTAssertNotNil(entry)
        XCTAssertEqual(entry?.handle, "charlie")
        XCTAssertEqual(entry?.tokensAll, 35_000_000)
        XCTAssertEqual(entry?.streakDays, 21)
    }

    func testCloudflare_URLResolution() {
        let store = SettingsStore.shared
        let origCloud = store.leaderboardCloudURL
        defer { store.leaderboardCloudURL = origCloud }

        store.leaderboardCloudflareURL = "https://token-horizon-leaderboard.castlemilk.workers.dev"
        XCTAssertEqual(LeaderboardStore.shared.cloudLeaderboardURL()?.absoluteString, "https://token-horizon-leaderboard.castlemilk.workers.dev/api/leaderboard")

        store.leaderboardCloudflareURL = "https://token-horizon-leaderboard.castlemilk.workers.dev/api"
        XCTAssertEqual(LeaderboardStore.shared.cloudLeaderboardURL()?.absoluteString, "https://token-horizon-leaderboard.castlemilk.workers.dev/api/leaderboard")

        store.leaderboardCloudflareURL = "https://token-horizon-leaderboard.castlemilk.workers.dev/leaderboard"
        XCTAssertEqual(LeaderboardStore.shared.cloudLeaderboardURL()?.absoluteString, "https://token-horizon-leaderboard.castlemilk.workers.dev/leaderboard")
    }

    func testCloudflare_WrappedEntryParsing() {
        let wrapped: [String: Any] = [
            "rank": 1,
            "badge": "🥇 1st",
            "score": 5000000,
            "entry": [
                "handle": "dave",
                "team": "Castlemilk",
                "tokensToday": 5000000,
                "tokens7d": 25000000,
                "tokensAll": 50000000,
                "costToday": 25.0,
                "streakDays": 10,
                "topModel": "claude-opus-5",
                "hardware": "Apple M5 Max"
            ]
        ]
        let entry = LeaderboardStore.entryFromDict(wrapped)
        XCTAssertNotNil(entry)
        XCTAssertEqual(entry?.handle, "dave")
        XCTAssertEqual(entry?.team, "Castlemilk")
        XCTAssertEqual(entry?.tokensToday, 5_000_000)
        XCTAssertEqual(entry?.tokensAll, 50_000_000)
    }
}
