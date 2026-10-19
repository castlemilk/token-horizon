import XCTest
@testable import TokenHorizon

/// Account-specific live quotas replace the unscoped session-log fallback
/// and remain separate through native plan-row rendering and persistence.
final class CLIAccountRenderingTests: XCTestCase {
    private func limits(provider: String, email: String, burst: Double = 20,
                        cycle: Double = 40) -> [ProviderLimit] {
        [ProviderLimit(provider: provider, label: "5h", usedPercent: burst,
                       resetsAt: Date(timeIntervalSince1970: 1_900_000_000), detail: email),
         ProviderLimit(provider: provider, label: "7d", usedPercent: cycle,
                       resetsAt: Date(timeIntervalSince1970: 1_900_100_000), detail: email)]
    }

    private func host() -> DashboardTabs {
        DashboardTabs(model: UIModel(), compact: true)
    }

    func testMultipleLiveCodexAccountsReplaceUnscopedFileQuotaAndKeepOtherProviders() {
        let fileQuota = ProviderLimit(provider: "codex", label: "5h", usedPercent: 99,
                                      resetsAt: nil, detail: "file fallback")
        let glm = ProviderLimit(provider: "glm", label: "5h", usedPercent: 10,
                                resetsAt: nil, detail: "glm")
        let kimi = ProviderLimit(provider: "kimi", label: "weekly", usedPercent: 15,
                                 resetsAt: nil, detail: "kimi")
        let live = limits(provider: "codex (ben.ebsworth@gmail.com)", email: "ben.ebsworth@gmail.com")
            + limits(provider: "codex (ben@dorja.com)", email: "ben@dorja.com", burst: 30, cycle: 50)

        let assembled = DashboardTabs.assembleLimitRows(
            usageLimits: [fileQuota, glm], planLimits: live, kimiLimits: [kimi])

        XCTAssertEqual(assembled.count, 6)
        XCTAssertFalse(assembled.contains { $0.provider == "codex" })
        XCTAssertFalse(assembled.contains { $0.detail == "file fallback" })
        XCTAssertEqual(assembled.filter { $0.provider == "glm" }.count, 1)
        XCTAssertEqual(assembled.filter { $0.provider == "kimi" }.count, 1)
        XCTAssertEqual(assembled.filter { $0.provider == "codex (ben.ebsworth@gmail.com)" }.count, 2)
        XCTAssertEqual(assembled.filter { $0.provider == "codex (ben@dorja.com)" }.count, 2)
    }

    func testFileQuotaRemainsWhenOnlyOtherProvidersHaveLiveLimits() {
        let fileQuota = ProviderLimit(provider: "codex", label: "5h", usedPercent: 99,
                                      resetsAt: nil, detail: "file fallback")
        let claude = ProviderLimit(provider: "claude (dorja)", label: "weekly", usedPercent: 10,
                                   resetsAt: nil, detail: "ben@dorja.com")

        let assembled = DashboardTabs.assembleLimitRows(
            usageLimits: [fileQuota], planLimits: [claude], kimiLimits: [])

        XCTAssertEqual(assembled.count, 2)
        XCTAssertEqual(assembled.first { $0.provider == "codex" }?.usedPercent, 99)
        XCTAssertEqual(assembled.first { $0.provider == "codex" }?.detail, "file fallback")
    }

    func testSeparateCodexAccountsRenderIndependentBurstAndCycleRows() throws {
        let live = limits(provider: "codex (ben.ebsworth@gmail.com)", email: "ben.ebsworth@gmail.com", burst: 11, cycle: 22)
            + limits(provider: "codex (ben@dorja.com)", email: "ben@dorja.com", burst: 33, cycle: 44)
        let rows = host().buildUnifiedPlanRows(from: DashboardTabs.assembleLimitRows(
            usageLimits: [], planLimits: live, kimiLimits: []))

        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(Set(rows.map(\.id)).count, 2)
        let personal = try XCTUnwrap(rows.first { $0.provider == "codex (ben.ebsworth@gmail.com)" })
        let dorja = try XCTUnwrap(rows.first { $0.provider == "codex (ben@dorja.com)" })
        XCTAssertEqual(personal.displayName, "Codex (ben.ebsworth@gmail.com)")
        XCTAssertEqual(dorja.displayName, "Codex (ben@dorja.com)")
        XCTAssertEqual(personal.burstLimit?.usedPercent, 11)
        XCTAssertEqual(personal.cycleLimit?.usedPercent, 22)
        XCTAssertEqual(dorja.burstLimit?.usedPercent, 33)
        XCTAssertEqual(dorja.cycleLimit?.usedPercent, 44)
        XCTAssertTrue(rows.allSatisfy { $0.logoProvider.contains("codex") })
    }

    func testSameEmailWorkspaceLabelsRemainSeparateThroughRendering() throws {
        let accounts = [
            CodexAccount(id: "codex-workspace-aaaaaaaa", accountId: "workspace-a", email: "same@example.com"),
            CodexAccount(id: "codex-workspace-bbbbbbbb", accountId: "workspace-b", email: "same@example.com"),
        ]
        let names = CodexAccountDiscovery.providerNames(for: accounts)
        let live = try accounts.flatMap { account -> [ProviderLimit] in
            let provider = try XCTUnwrap(names[account.id])
            return limits(provider: provider, email: account.email)
        }
        let rows = host().buildUnifiedPlanRows(from: live)

        XCTAssertEqual(Set(names.values).count, 2)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(Set(rows.map(\.id)).count, 2)
        XCTAssertTrue(rows.allSatisfy { $0.displayName.hasPrefix("Codex (same@example.com · ") })
        XCTAssertTrue(rows.allSatisfy { $0.burstLimit != nil && $0.cycleLimit != nil })
    }

    func testCodexDisplayNamesPreserveAccountAndExistingSingleAccountBrand() {
        XCTAssertEqual(DashboardTabs.providerNameDisplay("codex (ben@dorja.com)"), "Codex (ben@dorja.com)")
        XCTAssertEqual(DashboardTabs.providerNameDisplay("codex (same@example.com · aaaaaaaa)"),
                       "Codex (same@example.com · aaaaaaaa)")
        XCTAssertEqual(DashboardTabs.providerNameDisplay("codex"), "OpenAI")
    }

    func testUsageSnapshotRoundTripPreservesCodexIdentityAndOfflineProfileStatus() throws {
        let home = "/synthetic/.codex-dorja"
        let account = CodexAccount(id: "codex-dorja", accountId: "workspace-dorja", email: "ben@dorja.com",
                                   label: "ben@dorja.com", configDirs: [home], authPaths: [home + "/auth.json"],
                                   profileStatuses: [home: "Sign in to this profile"],
                                   limits: limits(provider: "codex", email: "ben@dorja.com"),
                                   quotaStatus: "Sign in to this profile")
        var snapshot = UsageSnapshot()
        snapshot.codexAccounts = [account]

        let data = try JSONEncoder().encode(snapshot)
        let decoded = try JSONDecoder().decode(UsageSnapshot.self, from: data)
        let restored = try XCTUnwrap(decoded.codexAccounts?.first)

        XCTAssertEqual(restored.id, account.id)
        XCTAssertEqual(restored.accountId, "workspace-dorja")
        XCTAssertEqual(restored.email, "ben@dorja.com")
        XCTAssertEqual(restored.configDirs, [home])
        XCTAssertEqual(restored.profileStatuses[home], "Sign in to this profile")
        XCTAssertEqual(restored.quotaStatus, "Sign in to this profile")
        XCTAssertEqual(restored.limits.count, 2)
        let serialized = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(serialized.contains("codexAccounts"))
        XCTAssertFalse(serialized.contains("access_token"))
        XCTAssertFalse(serialized.contains("refresh_token"))
    }

    func testOlderSnapshotWithoutCodexAccountsStillHydrates() throws {
        let oldSnapshot = Data(#"{"tokensToday":123,"tokensAllTime":456,"claudeAccounts":[]}"#.utf8)
        let decoded = try JSONDecoder().decode(UsageSnapshot.self, from: oldSnapshot)

        XCTAssertEqual(decoded.tokensToday, 123)
        XCTAssertEqual(decoded.tokensAllTime, 456)
        XCTAssertNil(decoded.codexAccounts)
    }
}
