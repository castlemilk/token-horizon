import XCTest
@testable import TokenHorizon
// swiftlint:disable force_try force_cast
// Test files are exempt from force-try/cast enforcement (a try! that fails
// fails the test loudly, which is the desired behavior). Production code
// keeps the default error-level enforcement.

/// Regression tests for per-model provider share (e.g. "fable is N% of
/// claude usage"). `ModelUsage.withProviderShares` is the single source of
/// the number surfaced in the dashboard MODELS list, `/stats`, and MCP.
final class ModelShareTests: XCTestCase {

    private func model(_ provider: String, _ name: String, _ tokens: Int) -> ModelUsage {
        ModelUsage(provider: provider, model: name, tokensAll: tokens,
                   tokensToday: 0, cost: 0, messages: 0, free: false)
    }

    func testShares_matchClaudeSplit() {
        // Mirrors the live shape: fable-dominated claude usage.
        let rows = ModelUsage.withProviderShares([
            model("claude", "claude-fable-5-1", 6_800),
            model("claude", "claude-opus-5", 3_000),
            model("claude", "claude-sonnet-5", 200),
        ])
        let byName = Dictionary(uniqueKeysWithValues: rows.map { ($0.model, $0) })
        XCTAssertEqual(byName["claude-fable-5-1"]?.sharePercent ?? -1, 68.0, accuracy: 0.001)
        XCTAssertEqual(byName["claude-opus-5"]?.sharePercent ?? -1, 30.0, accuracy: 0.001)
        XCTAssertEqual(byName["claude-sonnet-5"]?.sharePercent ?? -1, 2.0, accuracy: 0.001)
        XCTAssertEqual(rows.reduce(0) { $0 + $1.sharePercent }, 100.0, accuracy: 0.001)
    }

    func testShares_arePerProvider_notGlobal() {
        let rows = ModelUsage.withProviderShares([
            model("claude", "a", 900),
            model("codex", "b", 100),
        ])
        let byName = Dictionary(uniqueKeysWithValues: rows.map { ($0.model, $0) })
        XCTAssertEqual(byName["a"]?.sharePercent ?? -1, 100.0, accuracy: 0.001)
        XCTAssertEqual(byName["b"]?.sharePercent ?? -1, 100.0, accuracy: 0.001)
    }

    func testShares_zeroTotalGivesZeroNotNaN() {
        let rows = ModelUsage.withProviderShares([model("claude", "a", 0)])
        XCTAssertEqual(rows.first?.sharePercent ?? -1, 0.0)
        XCTAssertFalse(rows.first!.sharePercent.isNaN)
    }

    func testShares_preservesOrder() {
        let rows = ModelUsage.withProviderShares([
            model("claude", "b", 1),
            model("claude", "a", 99),
        ])
        XCTAssertEqual(rows.map(\.model), ["b", "a"])
    }

    func testShareText_formatting() {
        var m = model("claude", "a", 1)
        m.sharePercent = 68.4
        XCTAssertEqual(m.shareText, "68%")
        m.sharePercent = 2.34
        XCTAssertEqual(m.shareText, "2.3%")
        m.sharePercent = 0
        XCTAssertEqual(m.shareText, "0.0%")
    }

    func testStatsPayload_includesSharePercentKey() {
        // API contract: /stats encodes every ModelUsage with sharePercent so
        // dashboard, MCP, and any consumer always see it (the producer and
        // consumers ship together; nothing decodes persisted ModelUsage).
        var m = model("claude", "claude-fable-5-1", 10)
        m.sharePercent = 66.6
        let data = try! JSONEncoder().encode(m)
        let dict = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(dict["sharePercent"] as? Double ?? -1, 66.6, accuracy: 0.0001)
    }

    func testSharePercent_roundTrips() {
        var m = model("claude", "claude-fable-5-1", 10)
        m.sharePercent = 66.6
        let data = try! JSONEncoder().encode(m)
        let back = try! JSONDecoder().decode(ModelUsage.self, from: data)
        XCTAssertEqual(back.sharePercent, 66.6, accuracy: 0.0001)
    }
}
