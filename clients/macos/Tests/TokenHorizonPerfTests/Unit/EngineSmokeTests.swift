import XCTest
@testable import TokenHorizon

/// Real engine entry points over bounded provider streams and isolated cache.
final class EngineSmokeTests: XCTestCase {

    func testSnapshot_isStructuredAndSorted() throws {
        let fixture = try UsageEngineFixture()
        defer { try? fixture.remove() }
        let snap = fixture.engine.snapshot()
        XCTAssertEqual(snap.tokensAllTime, 240)
        XCTAssertEqual(snap.tokensToday, 170)
        XCTAssertEqual(snap.inputTokensAllTime, 185)
        XCTAssertEqual(snap.outputTokensAllTime, 45)
        XCTAssertEqual(snap.requestsAllTime, 4)
        XCTAssertEqual(snap.sources, ["codex", "kimi"])
        XCTAssertEqual(snap.sources, snap.perTool.map { $0.tool })
        XCTAssertEqual(snap.models.map { $0.model }, ["gpt-fixture", "k3-fixture"])
        XCTAssertEqual(snap.models.map { $0.tokensToday }, [120, 50])
        XCTAssertEqual(snap.parserHealth.map { $0.files }, [1, 1])
        XCTAssertTrue(snap.parserHealth.allSatisfy { $0.suspect == 0 })
        XCTAssertTrue(fixture.engine.watchSpec.allSatisfy { $0.root.hasPrefix(fixture.root.path + "/") })
        XCTAssertEqual(fixture.engine.snapshot().tokensAllTime, 240, "Repeated collection must not double count")
    }

    func testHistory_pointCountAndStreak() throws {
        let fixture = try UsageEngineFixture()
        defer { try? fixture.remove() }
        let result = fixture.engine.history(days: 7)
        XCTAssertEqual(result.points.count, 7)
        XCTAssertEqual(result.points.map { $0.tokens }, [0, 0, 0, 0, 0, 70, 170])
        XCTAssertEqual(result.points.last?.byTool, ["codex": 120, "kimi": 50])
        XCTAssertEqual(result.streak, 2)
    }

    func testTrendHistory_pointCounts() throws {
        let fixture = try UsageEngineFixture()
        defer { try? fixture.remove() }
        let day = fixture.engine.trendHistory(window: .day)
        let week = fixture.engine.trendHistory(window: .week)
        XCTAssertEqual(day.count, 24)
        XCTAssertEqual(day.last?.tokens, 170)
        XCTAssertEqual(week.count, 7)
        XCTAssertEqual(week.reduce(0) { $0 + $1.tokens }, 240)
    }

    func testResetState_rebuildsCleanly() throws {
        let fixture = try UsageEngineFixture()
        defer { try? fixture.remove() }
        XCTAssertEqual(fixture.engine.snapshot().tokensAllTime, 240)
        try fixture.appendCodex(input: 7, output: 3)
        fixture.engine.resetState()
        let snap = fixture.engine.snapshot()
        XCTAssertEqual(snap.tokensAllTime, 250)
        XCTAssertEqual(snap.tokensToday, 180)
        XCTAssertEqual(snap.requestsAllTime, 5)
        XCTAssertEqual(snap.sources, snap.perTool.map { $0.tool })
        XCTAssertEqual(fixture.engine.snapshot().tokensAllTime, 250)
    }
}
