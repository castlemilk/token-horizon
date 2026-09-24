import XCTest
@testable import TokenHorizon

/// Contract checks for the consumer-defined ports in `Core/Protocols.swift`.
///
/// These pin the seam, not behavior: real engines must satisfy the protocols
/// (compile-time conformance is declared in Protocols.swift; these tests prove
/// the conformances actually hold at runtime), and hand-written fakes — the
/// preferred test double (Real → Fake → Stub → Mock) — must be substitutable
/// wherever the port is accepted.
final class ProtocolsTests: XCTestCase {

    // MARK: - Fakes (kept next to the port they serve)

    final class FakeUsage: UsageSnapshotProviding, UsageHistoryProviding {
        var snapshotStub = UsageSnapshot.empty
        var historyStub: (points: [HistoryPoint], streak: Int) = ([], 0)
        var trendsStub: [HistoryPoint] = []
        private(set) var snapshotCalls = 0

        func snapshot() -> UsageSnapshot {
            snapshotCalls += 1
            return snapshotStub
        }

        func history(days: Int) -> (points: [HistoryPoint], streak: Int) { historyStub }

        func trendHistory(window: TrendWindow) -> [HistoryPoint] { trendsStub }
    }

    final class FakeLimits: LimitsProviding {
        var rows: [ProviderLimit] = []
        private(set) var refreshCalls = 0

        func cachedLimits() -> [ProviderLimit] { rows }

        func refreshIfDue(maxAge: TimeInterval) { refreshCalls += 1 }
    }

    // MARK: - Real engines satisfy the ports

    func testUsageEngine_satisfiesUsagePorts() {
        let engine = AppDependencies.makeUsageEngine()
        XCTAssertTrue((engine as any UsageSnapshotProviding) is UsageEngine)
        XCTAssertTrue((engine as any UsageHistoryProviding) is UsageEngine)
    }

    func testLimitEngines_satisfyLimitsPort() {
        XCTAssertTrue((PlanLimitsEngine.shared as any LimitsProviding) is PlanLimitsEngine)
        XCTAssertTrue((KimiLimitsEngine.shared as any LimitsProviding) is KimiLimitsEngine)
    }

    // MARK: - Fakes are substitutable for the ports

    func testFakeUsage_servesSnapshotThroughPort() {
        let fake = FakeUsage()
        let port: any UsageSnapshotProviding = fake
        XCTAssertEqual(port.snapshot().tokensToday, UsageSnapshot.empty.tokensToday)
        XCTAssertEqual(fake.snapshotCalls, 1)
    }

    func testFakeLimits_servesRowsThroughPort() {
        let fake = FakeLimits()
        fake.rows = [ProviderLimit(provider: "test", label: "5h", usedPercent: 12, resetsAt: nil, detail: "fake")]
        let port: any LimitsProviding = fake
        XCTAssertEqual(port.cachedLimits().count, 1)
        port.refreshIfDue(maxAge: 30)
        XCTAssertEqual(fake.refreshCalls, 1)
    }

    func testFactory_returnsLiveImplementations() {
        XCTAssertTrue(AppDependencies.makeClock() is SystemClock)
        XCTAssertTrue(AppDependencies.makeFileSystem() is LiveFileSystem)
    }
}
