import XCTest
@testable import TokenHorizon

/// Leftover pure formatting/model math: snapshot texts, provider-share edge
/// cases, and Claude account display strings.
final class ModelsMiscTests: XCTestCase {

    func testUsageSnapshotTexts() {
        var snap = UsageSnapshot.empty
        snap.tokensToday = 1500
        snap.tokensAllTime = 2_500_000
        XCTAssertEqual(snap.tokensTodayText, "1.5k")
        XCTAssertEqual(snap.tokensAllTimeText, "2.5M")
    }

    func testWithProviderShares_zeroTotalsStayZero() {
        // All-zero providers must yield 0 shares, never NaN.
        let rows = [
            ModelUsage(provider: "p", model: "a", tokensAll: 0, tokensToday: 0,
                       cost: 0, messages: 0, free: true),
            ModelUsage(provider: "p", model: "b", tokensAll: 0, tokensToday: 0,
                       cost: 0, messages: 0, free: true),
        ]
        let out = ModelUsage.withProviderShares(rows)
        XCTAssertEqual(out.map { $0.sharePercent }, [0, 0])
        XCTAssertFalse(out[0].sharePercent.isNaN)
        // Order is preserved and shares sum to ~100 for nonzero totals.
        let mixed = [
            ModelUsage(provider: "p", model: "a", tokensAll: 75, tokensToday: 0,
                       cost: 0, messages: 0, free: false),
            ModelUsage(provider: "p", model: "b", tokensAll: 25, tokensToday: 0,
                       cost: 0, messages: 0, free: false),
        ]
        let shared = ModelUsage.withProviderShares(mixed)
        XCTAssertEqual(shared.map { $0.model }, ["a", "b"])
        XCTAssertEqual(shared.map { $0.sharePercent }.reduce(0, +), 100, accuracy: 1e-9)
    }

    func testClaudeAccountTexts() {
        var acct = ClaudeAccount(id: "a", label: "l", configDir: "/tmp")
        acct.tokensToday = 2500
        acct.tokensAllTime = 1_500_000
        acct.costToday = 3.5
        acct.costAllTime = 150.75
        XCTAssertEqual(acct.tokensTodayText, "2.5k")
        XCTAssertEqual(acct.tokensAllTimeText, "1.5M")
        XCTAssertEqual(acct.costTodayText, "$3.50")
        XCTAssertEqual(acct.costAllTimeText, "$151")
    }
}
