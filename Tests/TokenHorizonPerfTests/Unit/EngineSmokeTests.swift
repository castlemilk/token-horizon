import XCTest
@testable import TokenHorizon

/// Smoke tests through the real engine entry points (live HOME, read-only
/// scans; the same durable-cache writes the app itself performs). Assertions
/// are structural invariants that hold regardless of activity — never exact
/// totals (agents may write mid-test) and never timing.
final class EngineSmokeTests: XCTestCase {

    func testSnapshot_isStructuredAndSorted() {
        let snap = UsageEngine().snapshot()
        XCTAssertGreaterThanOrEqual(snap.tokensAllTime, 0)
        XCTAssertGreaterThanOrEqual(snap.tokensToday, 0)
        XCTAssertEqual(snap.sources, snap.perTool.map { $0.tool })
        if snap.models.count > 1 {
            XCTAssertGreaterThanOrEqual(snap.models.first!.tokensToday,
                                        snap.models.last!.tokensToday)
        }
    }

    func testHistory_pointCountAndStreak() {
        let engine = UsageEngine()
        let result = engine.history(days: 7)
        XCTAssertEqual(result.points.count, 7)
        XCTAssertGreaterThanOrEqual(result.streak, 0)
    }

    func testTrendHistory_pointCounts() {
        let engine = UsageEngine()
        XCTAssertEqual(engine.trendHistory(window: .day).count, 24)
        XCTAssertEqual(engine.trendHistory(window: .week).count, 7)
    }

    func testResetState_rebuildsCleanly() {
        let engine = UsageEngine()
        _ = engine.snapshot()
        engine.resetState()
        let snap = engine.snapshot()
        XCTAssertGreaterThanOrEqual(snap.tokensAllTime, 0)
        XCTAssertEqual(snap.sources, snap.perTool.map { $0.tool })
    }
}
