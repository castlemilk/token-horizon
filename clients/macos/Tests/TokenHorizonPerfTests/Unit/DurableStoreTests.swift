import XCTest
@testable import TokenHorizon

final class DurableStoreTests: XCTestCase {

    override func setUp() {
        super.setUp()
        DurableStore.shared.resetAll()
    }

    override func tearDown() {
        DurableStore.shared.resetAll()
        super.tearDown()
    }

    func testDurableStore_snapshotRoundTrip() {
        var snap = UsageSnapshot()
        snap.tokensToday = 125_000
        snap.tokensAllTime = 4_500_000
        snap.costToday = 1.25
        snap.costAllTime = 45.00
        snap.perTool = [
            ToolUsage(tool: "codex", tokensToday: 100_000, tokensAllTime: 3_000_000, costToday: 0, costAllTime: 0),
            ToolUsage(tool: "claude", tokensToday: 25_000, tokensAllTime: 1_500_000, costToday: 1.25, costAllTime: 45.00)
        ]
        snap.models = [
            ModelUsage(provider: "openai", model: "gpt-5.6-sol", tokensAll: 2_000_000, tokensToday: 50_000, cost: 0, messages: 10, free: false),
            ModelUsage(provider: "claude", model: "claude-3-7-sonnet", tokensAll: 1_500_000, tokensToday: 25_000, cost: 45.0, messages: 5, free: false)
        ]

        DurableStore.shared.saveSnapshot(snap)

        guard let loaded = DurableStore.shared.loadSnapshot() else {
            XCTFail("Snapshot failed to load from durable store")
            return
        }

        XCTAssertEqual(loaded.tokensToday, 125_000)
        XCTAssertEqual(loaded.tokensAllTime, 4_500_000)
        XCTAssertEqual(loaded.costToday, 1.25)
        XCTAssertEqual(loaded.costAllTime, 45.00)
        XCTAssertEqual(loaded.perTool.count, 2)
        XCTAssertEqual(loaded.models.count, 2)
    }

    func testDurableStore_historyRoundTrip() {
        var points: [HistoryPoint] = []
        let baseDay = 1725000000
        for i in 0..<30 {
            points.append(HistoryPoint(
                day: baseDay + i * 86_400,
                tokens: (i + 1) * 10_000,
                cost: Double(i + 1) * 0.50,
                byTool: ["claude": (i + 1) * 6000, "codex": (i + 1) * 4000]
            ))
        }

        DurableStore.shared.saveHistory(points: points, streak: 14)

        guard let loaded = DurableStore.shared.loadHistory() else {
            XCTFail("History failed to load from durable store")
            return
        }

        XCTAssertEqual(loaded.points.count, 30)
        XCTAssertEqual(loaded.streak, 14)
        XCTAssertEqual(loaded.points[0].tokens, 10_000)
        XCTAssertEqual(loaded.points[29].tokens, 300_000)
        XCTAssertEqual(loaded.points[29].byTool["claude"], 180_000)
    }

    func testDurableStore_trendsRoundTrip() {
        let points = [
            HistoryPoint(day: 1725184800, tokens: 5000, cost: 0.1, byTool: ["codex": 5000]),
            HistoryPoint(day: 1725188400, tokens: 8000, cost: 0.2, byTool: ["claude": 8000])
        ]

        DurableStore.shared.saveTrends(window: .day, points: points)

        let loaded = DurableStore.shared.loadTrends(window: .day)
        XCTAssertNotNil(loaded)
        XCTAssertEqual(loaded?.count, 2)
        XCTAssertEqual(loaded?[0].tokens, 5000)
        XCTAssertEqual(loaded?[1].tokens, 8000)
    }

    func testDurableStore_limitsRoundTrip() {
        let plan = [
            ProviderLimit(provider: "codex", label: "5h session", usedPercent: 45.0, resetsAt: Date(timeIntervalSince1970: 1725200000), detail: "55% left"),
            ProviderLimit(provider: "codex", label: "weekly", usedPercent: 82.0, resetsAt: Date(timeIntervalSince1970: 1725500000), detail: "18% left")
        ]
        let kimi = [
            ProviderLimit(provider: "kimi", label: "weekly", usedPercent: 12.0, resetsAt: nil, detail: "88% left")
        ]

        DurableStore.shared.saveLimits(plan: plan, kimi: kimi)

        guard let loaded = DurableStore.shared.loadLimits() else {
            XCTFail("Limits failed to load from durable store")
            return
        }

        XCTAssertEqual(loaded.plan.count, 2)
        XCTAssertEqual(loaded.kimi.count, 1)
        XCTAssertEqual(loaded.plan[0].provider, "codex")
        XCTAssertEqual(loaded.plan[0].usedPercent, 45.0)
        XCTAssertEqual(loaded.kimi[0].provider, "kimi")
    }

    func testDurableStore_resetAll() {
        var snap = UsageSnapshot()
        snap.tokensToday = 5000
        DurableStore.shared.saveSnapshot(snap)
        DurableStore.shared.saveHistory(points: [HistoryPoint(day: 1725000000, tokens: 100, cost: 0.01, byTool: [:])], streak: 1)

        let beforeStats = DurableStore.shared.cacheStats()
        XCTAssertTrue(beforeStats.filesCount >= 2)
        XCTAssertTrue(beforeStats.totalBytes > 0)

        let res = DurableStore.shared.resetAll()
        XCTAssertTrue(res.clearedFiles >= 2)
        XCTAssertTrue(res.clearedBytes > 0)

        let afterStats = DurableStore.shared.cacheStats()
        XCTAssertEqual(afterStats.filesCount, 0)
        XCTAssertEqual(afterStats.totalBytes, 0)
        XCTAssertNil(DurableStore.shared.loadSnapshot())
        XCTAssertNil(DurableStore.shared.loadHistory())
    }

    func testDurableStore_flushEngineStateNeverCrashes() {
        // No-op when nothing is staged; otherwise writes the valid staged
        // payload (the same write the app performs constantly).
        DurableStore.shared.flushEngineState()
    }
}
