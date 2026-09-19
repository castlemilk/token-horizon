import XCTest
@testable import TokenHorizonCore

/// Kimi usages payload mapping — especially the EXHAUSTION shape: when the
/// 5h window is exhausted the gateway omits the `limits[]` entry, and the
/// meter must fall back to the `usages.limit_5h` summary block instead of
/// vanishing (observed in the field; same failure class as alibaba's
/// missing 5h window).
final class KimiUsagesParsingTests: XCTestCase {

    /// The normal shape (both windows present in detail).
    func testNormalPayload_weekAnd5h() {
        let rows = KimiLimitsEngine.rowsFromUsagesPayload([
            "usage": ["limit": "100", "used": "24", "remaining": "76",
                      "resetTime": "2026-09-24T01:00:52.054296Z"],
            "limits": [[
                "window": ["duration": 300, "timeUnit": "TIME_UNIT_MINUTE"],
                "detail": ["limit": "100", "used": "5", "remaining": "95",
                           "resetTime": "2026-09-19T07:00:52.054296Z"],
            ]],
            "usages": [
                "limit_5h": ["used_ratio": 0, "reset_time": "2026-09-19T07:00:51Z"],
                "limit_7d": ["used_ratio": 0, "reset_time": "2026-09-24T01:00:51Z"],
            ],
        ], providerName: "kimi")
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.first(where: { $0.label == "week" })?.usedPercent ?? -1, 24, accuracy: 0.01)
        XCTAssertEqual(rows.first(where: { $0.label == "5h" })?.usedPercent ?? -1, 5, accuracy: 0.01)
        XCTAssertNotNil(rows.first(where: { $0.label == "5h" })?.resetsAt)
    }

    /// Exhaustion shape: `limits[]` carries NO window entry — the 5h meter
    /// must still render, at 100%, from the summary block.
    func testExhaustedWindow_synthesizedFromSummaryBlock() {
        let rows = KimiLimitsEngine.rowsFromUsagesPayload([
            "usage": ["limit": "100", "used": "24", "remaining": "76",
                      "resetTime": "2026-09-24T01:00:52Z"],
            "limits": [],
            "usages": [
                "limit_5h": ["used_ratio": 1, "reset_time": "2026-09-19T07:00:51Z"],
                "limit_7d": ["used_ratio": 0.24, "reset_time": "2026-09-24T01:00:51Z"],
            ],
        ], providerName: "kimi")
        let fiveH = rows.first(where: { $0.label == "5h" })
        XCTAssertNotNil(fiveH, "5h meter must survive window-entry omission")
        XCTAssertEqual(fiveH?.usedPercent ?? -1, 100, accuracy: 0.01)
        XCTAssertEqual(fiveH?.resetsAt?.timeIntervalSince1970 ?? 0, 1_789_801_251, accuracy: 2)
    }

    /// used_ratio arrives as a 0-1 fraction; defend against a 0-100 spelling.
    func testRatioPercentSpelling() {
        let rows = KimiLimitsEngine.rowsFromUsagesPayload([
            "limits": [],
            "usages": ["limit_5h": ["used_ratio": 42, "reset_time": "2026-09-19T07:00:51Z"]],
        ], providerName: "kimi")
        XCTAssertEqual(rows.first(where: { $0.label == "5h" })?.usedPercent ?? -1, 42, accuracy: 0.01)
    }

    /// Top-level `usage` missing entirely: week falls back to limit_7d too.
    func testWeekFallbackFromSummaryBlock() {
        let rows = KimiLimitsEngine.rowsFromUsagesPayload([
            "usages": ["limit_7d": ["used_ratio": 0.5, "reset_time": "2026-09-24T01:00:51Z"]],
        ], providerName: "kimi")
        XCTAssertEqual(rows.first(where: { $0.label == "week" })?.usedPercent ?? -1, 50, accuracy: 0.01)
    }

    /// An empty payload yields no rows (caller-side last-good retention
    /// covers transients; parsing must not invent data).
    func testEmptyPayload_yieldsNothing() {
        XCTAssertTrue(KimiLimitsEngine.rowsFromUsagesPayload([:], providerName: "kimi").isEmpty)
    }
}

/// PlanLimitsEngine per-vendor last-good retention: transient fetch
/// failures serve the previous rows for a grace period; credentials gone =
/// deliberate sign-out and rows drop immediately.
final class PlanLimitsRetentionTests: XCTestCase {

    /// Fake adapter whose fetch result and credential presence are scripted.
    final class FakeVendor: VendorLimitsAdapter {
        var rows: [ProviderLimit] = []
        var hasCredential = true
        init(_ name: String) { super.init(provider: name) }
        override var auth: VendorAuth {
            VendorAuth(sources: [.custom { [weak self] in self?.hasCredential == true ? "key" : nil }])
        }
        override func fetch() -> [ProviderLimit] { rows }
    }

    private var savedVendors: [VendorLimitsAdapter] = []
    private var savedGrace: TimeInterval = 0

    override func setUp() {
        savedVendors = PlanLimitsEngine.vendors
        savedGrace = PlanLimitsEngine.lastGoodGrace
    }

    override func tearDown() {
        PlanLimitsEngine.vendors = savedVendors
        PlanLimitsEngine.lastGoodGrace = savedGrace
    }

    private func row(_ provider: String, _ pct: Double) -> ProviderLimit {
        .clamped(provider: provider, label: "5h", usedPercent: pct)
    }

    func testTransientFailure_servesLastGoodWithinGrace() {
        let v = FakeVendor("fakey")
        PlanLimitsEngine.vendors = [v]
        v.rows = [row("fakey", 42)]
        XCTAssertEqual(PlanLimitsEngine.fetchAll().map(\.usedPercent), [42])
        // Transient: fetch returns nothing but the credential still resolves.
        v.rows = []
        XCTAssertEqual(PlanLimitsEngine.fetchAll().map(\.usedPercent), [42],
                       "last-good rows must survive a transient empty fetch")
    }

    func testCredentialGone_dropsImmediately() {
        let v = FakeVendor("fakey")
        PlanLimitsEngine.vendors = [v]
        v.rows = [row("fakey", 42)]
        _ = PlanLimitsEngine.fetchAll()
        v.rows = []
        v.hasCredential = false
        XCTAssertTrue(PlanLimitsEngine.fetchAll().isEmpty,
                      "signed-out vendors must drop rows, not linger stale")
    }

    func testGraceExpiry_dropsStaleRows() {
        let v = FakeVendor("fakey")
        PlanLimitsEngine.vendors = [v]
        PlanLimitsEngine.lastGoodGrace = 0.05
        v.rows = [row("fakey", 42)]
        _ = PlanLimitsEngine.fetchAll()
        v.rows = []
        Thread.sleep(forTimeInterval: 0.08)
        XCTAssertTrue(PlanLimitsEngine.fetchAll().isEmpty,
                      "past the grace period the empty result commits")
    }

    func testOtherVendorsUnaffectedByOneFailure() {
        let good = FakeVendor("goodv")
        let flaky = FakeVendor("flakyv")
        PlanLimitsEngine.vendors = [good, flaky]
        good.rows = [row("goodv", 10)]
        flaky.rows = [row("flakyv", 90)]
        _ = PlanLimitsEngine.fetchAll()
        flaky.rows = []
        let out = PlanLimitsEngine.fetchAll()
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(Set(out.map(\.provider)), ["goodv", "flakyv"])
    }
}
