import XCTest
@testable import TokenHorizon

/// Account identity and quota fallback must follow the authenticated profile.
/// All profile homes, tokens and HTTP responses are synthetic.
final class ClaudeAccountTrackingTests: XCTestCase {
    func testCredentialFreshnessSelectsNewLoginAcrossProfilesOwnStores() {
        func credentials(_ token: String, expiry: Double, file: Bool = false) -> ClaudeDiscovery.ClaudeCredentials {
            .init(accessToken: token, refreshToken: "synthetic-refresh", expiresAtMs: expiry,
                  source: file ? .credentialsFile(path: "/synthetic/.credentials.json", oauthKey: "claudeAiOauth")
                    : .keychain(service: "synthetic-\(token)", account: "test", oauthKey: "claudeAiOauth"),
                  oauth: [:])
        }
        let cases: [([ClaudeDiscovery.ClaudeCredentials], String?)] = [
            ([], nil),
            ([credentials("old-default", expiry: 100), credentials("new-scoped", expiry: 200)], "new-scoped"),
            ([credentials("old-file", expiry: 100, file: true), credentials("new-keychain", expiry: 200)], "new-keychain"),
            ([credentials("new-file", expiry: 200, file: true), credentials("old-keychain", expiry: 100)], "new-file"),
            ([credentials("first", expiry: 0), credentials("second", expiry: 0)], "first")
        ]
        for (candidates, token) in cases {
            XCTAssertEqual(ClaudeDiscovery.preferredCredentials(candidates)?.accessToken, token)
        }
    }

    func testCanonicalLaunchScopingFollowsTheSamePreferredCredentialSourceAsQuota() {
        let home = "/synthetic-home"
        let directory = "\(home)/.claude"
        let scopedService = ClaudeProfileIdentity.keychainServices(for: directory, home: home)[1]
        func credentials(service: String, expiry: Double) -> ClaudeDiscovery.ClaudeCredentials {
            .init(accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAtMs: expiry,
                  source: .keychain(service: service, account: "test", oauthKey: "claudeAiOauth"), oauth: [:])
        }
        let cases: [([ClaudeDiscovery.ClaudeCredentials], Bool)] = [
            ([credentials(service: "Claude Code-credentials", expiry: 200),
              credentials(service: scopedService, expiry: 100)], true),
            ([credentials(service: "Claude Code-credentials", expiry: 100),
              credentials(service: scopedService, expiry: 200)], false),
            ([credentials(service: "Claude Code-credentials", expiry: 100),
              credentials(service: scopedService, expiry: 100)], true),
            ([credentials(service: scopedService, expiry: 100)], false),
            ([], false)
        ]
        for (candidates, expectedDefault) in cases {
            let preferred = ClaudeDiscovery.preferredCredentials(candidates)
            XCTAssertEqual(ClaudeDiscovery.usesDefaultEnvironmentForLaunch(
                for: directory, source: preferred?.source, home: home), expectedDefault)
        }
    }

    func testCustomProfilesNeverBorrowUnscopedLaunchEvenForAnInvalidSource() {
        let home = "/synthetic-home"
        let unscoped = ClaudeDiscovery.CredentialSource.keychain(
            service: "Claude Code-credentials", account: "test", oauthKey: "claudeAiOauth")
        for directory in ["\(home)/.claude-2", "\(home)/.config/claude", "/elsewhere/.claude"] {
            XCTAssertFalse(ClaudeDiscovery.usesDefaultEnvironmentForLaunch(for: directory, source: unscoped, home: home))
        }
        XCTAssertTrue(ClaudeDiscovery.usesDefaultEnvironmentForLaunch(for: "~/.claude/", source: unscoped, home: home))
        XCTAssertFalse(ClaudeDiscovery.usesDefaultEnvironmentForLaunch(
            for: "\(home)/.claude", source: .credentialsFile(path: "\(home)/.claude/.credentials.json", oauthKey: "claudeAiOauth"),
            home: home))
    }

    func testCanonicalAgentLaunchRejectsChangedCurrentIdentityAndClearsOldQuota() throws {
        let directory = try makeProfileDirectory(".claude")
        let home = directory.deletingLastPathComponent().path
        var profileCalls = 0
        let discovery = ClaudeDiscovery(
            directories: { [directory.path] }, tokenReader: { _ in "synthetic-old" },
            profileFetcher: { token in
                profileCalls += 1
                return token == "synthetic-old"
                    ? self.profilePayload(email: "ben.ebsworth@gmail.com", uuid: "gmail")
                    : self.profilePayload(email: "ben@dorja.com", uuid: "dorja")
            }, usageFetcher: { _ in self.usageResult(percent: 17) })
        XCTAssertEqual(discovery.fetchAllLimits(force: true).count, 1)
        let current = ClaudeDiscovery.ClaudeCredentials(
            accessToken: "synthetic-new", refreshToken: "synthetic-refresh", expiresAtMs: 200,
            source: .keychain(service: "Claude Code-credentials", account: "test", oauthKey: "claudeAiOauth"), oauth: [:])
        XCTAssertThrowsError(try discovery.verifiedDefaultEnvironmentForAgentLaunch(
            for: directory.path, matchingEmail: "ben.ebsworth@gmail.com", credentials: current, home: home)) {
            XCTAssertEqual($0 as? ClaudeDiscovery.AgentLaunchIdentityError, .changedSignIn)
            XCTAssertTrue($0.localizedDescription.contains("Refresh accounts"))
        }
        XCTAssertEqual(profileCalls, 2)
        XCTAssertTrue(discovery.cachedLimits(for: directory.path).isEmpty)
        XCTAssertEqual(discovery.accountMetadata(for: directory.path).email, "ben@dorja.com")
    }

    func testCanonicalAgentLaunchUsesTheVerifiedSelectionsExactSource() throws {
        let home = "/synthetic-home"
        let directory = "\(home)/.claude"
        var profileCalls = 0
        let discovery = ClaudeDiscovery(directories: { [] }, profileFetcher: { token in
            XCTAssertEqual(token, "synthetic-current")
            profileCalls += 1
            return self.profilePayload(email: "ben@dorja.com", uuid: "dorja")
        })
        var selected = ClaudeDiscovery.ClaudeCredentials(
            accessToken: "synthetic-current", refreshToken: "synthetic-refresh", expiresAtMs: 200,
            source: .keychain(service: "Claude Code-credentials", account: "test", oauthKey: "claudeAiOauth"), oauth: [:])
        XCTAssertTrue(try discovery.verifiedDefaultEnvironmentForAgentLaunch(
            for: directory, matchingEmail: "BEN@DORJA.COM", credentials: selected, home: home))
        selected.source = .keychain(service: ClaudeProfileIdentity.keychainServices(for: directory, home: home)[1],
                                   account: "test", oauthKey: "claudeAiOauth")
        XCTAssertFalse(try discovery.verifiedDefaultEnvironmentForAgentLaunch(
            for: directory, matchingEmail: "ben@dorja.com", credentials: selected, home: home))
        XCTAssertEqual(profileCalls, 1, "The same exact token can use cached verification, independently of its store")
    }

    func testCanonicalAgentLaunchRejectsMissingOrUnverifiedCredentialsWithoutLiveReaders() throws {
        let home = "/synthetic-home"
        let directory = "\(home)/.claude"
        var profileCalls = 0
        let discovery = ClaudeDiscovery(directories: { [] }, profileFetcher: { _ in profileCalls += 1; return nil })
        XCTAssertThrowsError(try discovery.verifiedDefaultEnvironmentForAgentLaunch(
            for: directory, matchingEmail: "ben@dorja.com", credentials: nil, home: home)) {
            XCTAssertEqual($0 as? ClaudeDiscovery.AgentLaunchIdentityError, .missingSignIn)
        }
        XCTAssertEqual(profileCalls, 0)
        let selected = ClaudeDiscovery.ClaudeCredentials(
            accessToken: "synthetic-unverified", refreshToken: "synthetic-refresh", expiresAtMs: 200,
            source: .keychain(service: "Claude Code-credentials", account: "test", oauthKey: "claudeAiOauth"), oauth: [:])
        XCTAssertThrowsError(try discovery.verifiedDefaultEnvironmentForAgentLaunch(
            for: directory, matchingEmail: "ben@dorja.com", credentials: selected, home: home)) {
            XCTAssertEqual($0 as? ClaudeDiscovery.AgentLaunchIdentityError, .unverifiedSignIn)
        }
        XCTAssertEqual(profileCalls, 1)
        XCTAssertFalse(try discovery.verifiedDefaultEnvironmentForAgentLaunch(
            for: "\(home)/.claude-2", matchingEmail: "ben@dorja.com", credentials: selected, home: home))
        XCTAssertEqual(profileCalls, 1, "Custom profiles do not use canonical credential selection")
    }

    private func makeProfileDirectory(_ name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-claude-account-\(UUID().uuidString)", isDirectory: true)
        let directory = root.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return directory
    }

    private func writeMetadata(to directory: URL, email: String, uuid: String,
                               organization: String = "org-1", cachedPercent: Double? = nil) throws {
        var metadata: [String: Any] = [
            "oauthAccount": [
                "emailAddress": email, "accountUuid": uuid,
                "organizationUuid": organization, "organizationType": "claude_max",
            ],
        ]
        if let cachedPercent {
            metadata["cachedUsageUtilization"] = [
                "fetchedAtMs": Date().timeIntervalSince1970 * 1_000,
                "utilization": usagePayload(percent: cachedPercent),
            ]
        }
        let data = try JSONSerialization.data(withJSONObject: metadata)
        try data.write(to: directory.appendingPathComponent(".claude.json"), options: .atomic)
    }

    private func profilePayload(email: String, uuid: String,
                                organization: String = "org-1") -> [String: Any] {
        [
            "account": ["uuid": uuid, "email": email, "display_name": "Synthetic User"],
            "organization": [
                "uuid": organization, "name": "Synthetic Organization",
                "organization_type": "claude_max", "rate_limit_tier": "default_claude_max_5x",
                "has_extra_usage_enabled": true,
            ],
        ]
    }

    private func usagePayload(percent: Double) -> [String: Any] {
        ["five_hour": ["utilization": percent, "resets_at": "2026-10-16T12:00:00Z"]]
    }

    private func usageResult(percent: Double) -> ClaudeDiscovery.LiveUsageResult {
        .init(payload: usagePayload(percent: percent), statusCode: 200, retryAfter: nil)
    }

    private func failedUsage(status: Int = 503) -> ClaudeDiscovery.LiveUsageResult {
        .init(payload: nil, statusCode: status, retryAfter: nil)
    }

    func testAuthenticatedProfilesCorrectCopiedMetadataAndKeepThreeQuotaRows() throws {
        let gmail = try makeProfileDirectory(".claude-personal")
        let dorja = try makeProfileDirectory(".claude-dorja")
        let shorted = try makeProfileDirectory(".claude-work")
        let directories = [gmail, dorja, shorted]
        for directory in directories {
            try writeMetadata(to: directory, email: "ben@shorted.com.au", uuid: "shorted")
        }
        let tokenByDirectory = [gmail.path: "synthetic-gmail", dorja.path: "synthetic-dorja",
                                shorted.path: "synthetic-shorted"]
        let profiles = [
            "synthetic-gmail": profilePayload(email: "ben.ebsworth@gmail.com", uuid: "gmail"),
            "synthetic-dorja": profilePayload(email: "ben@dorja.com", uuid: "dorja"),
            "synthetic-shorted": profilePayload(email: "ben@shorted.com.au", uuid: "shorted"),
        ]
        let percentages = ["synthetic-gmail": 11.0, "synthetic-dorja": 22.0,
                           "synthetic-shorted": 33.0]
        let discovery = ClaudeDiscovery(
            directories: { directories.map(\.path) },
            tokenReader: { tokenByDirectory[$0] },
            profileFetcher: { profiles[$0] },
            usageFetcher: { self.usageResult(percent: percentages[$0] ?? -1) })

        let rows = discovery.fetchAllLimits(force: true)
        let accounts = discovery.accounts()

        XCTAssertEqual(Set(accounts.map(\.email)),
                       ["ben.ebsworth@gmail.com", "ben@dorja.com", "ben@shorted.com.au"])
        XCTAssertEqual(Set(rows.map(\.provider)),
                       ["claude (ben.ebsworth)", "claude (dorja)", "claude (shorted)"])
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows.first { $0.detail.hasPrefix("ben.ebsworth@gmail.com") }?.usedPercent, 11)
        XCTAssertEqual(rows.first { $0.detail.hasPrefix("ben@dorja.com") }?.usedPercent, 22)
        XCTAssertEqual(rows.first { $0.detail.hasPrefix("ben@shorted.com.au") }?.usedPercent, 33)
        XCTAssertTrue(accounts.allSatisfy { $0.quotaStatus == nil && $0.limits.count == 1 })
        XCTAssertEqual(discovery.accountMetadata(for: gmail.path).email, "ben.ebsworth@gmail.com")
        XCTAssertEqual(discovery.accountMetadata(for: dorja.path).email, "ben@dorja.com")
    }

    func testUnchangedTokenVerifiesProfileOnceAcrossForcedPolls() throws {
        let directory = try makeProfileDirectory(".claude-personal")
        try writeMetadata(to: directory, email: "copied@other.example", uuid: "copied")
        var profileCalls = 0
        var usageCalls = 0
        let discovery = ClaudeDiscovery(
            directories: { [directory.path] },
            tokenReader: { _ in "synthetic-unchanged" },
            profileFetcher: { _ in
                profileCalls += 1
                return self.profilePayload(email: "ben.ebsworth@gmail.com", uuid: "gmail")
            },
            usageFetcher: { _ in
                usageCalls += 1
                return self.usageResult(percent: Double(usageCalls))
            })

        XCTAssertEqual(discovery.fetchAllLimits(force: true).first?.usedPercent, 1)
        XCTAssertEqual(discovery.fetchAllLimits(force: true).first?.usedPercent, 2)
        XCTAssertEqual(profileCalls, 1)
        XCTAssertEqual(usageCalls, 2)
        XCTAssertEqual(discovery.accounts().first?.email, "ben.ebsworth@gmail.com")
    }

    func testSwitchingTokenCannotReusePreviousAccountQuotaOrMismatchedDiskCache() throws {
        let directory = try makeProfileDirectory(".claude-personal")
        try writeMetadata(to: directory, email: "ben.ebsworth@gmail.com", uuid: "gmail",
                          cachedPercent: 77)
        var token = "synthetic-gmail"
        var profileCalls = 0
        let discovery = ClaudeDiscovery(
            directories: { [directory.path] },
            tokenReader: { _ in token },
            profileFetcher: { current in
                profileCalls += 1
                return current == "synthetic-gmail"
                    ? self.profilePayload(email: "ben.ebsworth@gmail.com", uuid: "gmail")
                    : self.profilePayload(email: "ben@dorja.com", uuid: "dorja")
            },
            usageFetcher: { current in
                current == "synthetic-gmail" ? self.usageResult(percent: 41) : self.failedUsage()
            })

        XCTAssertEqual(discovery.fetchAllLimits(force: true).first?.usedPercent, 41)
        token = "synthetic-dorja"
        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
        XCTAssertTrue(discovery.cachedLimits(for: directory.path).isEmpty)
        XCTAssertEqual(discovery.accounts().first?.email, "ben@dorja.com")
        XCTAssertEqual(discovery.accountMetadata(for: directory.path).accountUuid, "dorja")
        XCTAssertNotNil(discovery.accounts().first?.quotaStatus)
        XCTAssertEqual(profileCalls, 2)
    }

    func testChangedTokenWithUnverifiableProfileClearsQuotaAndSkipsUsageAPI() throws {
        let directory = try makeProfileDirectory(".claude-personal")
        try writeMetadata(to: directory, email: "ben.ebsworth@gmail.com", uuid: "gmail",
                          cachedPercent: 77)
        var token = "synthetic-gmail"
        var profileCalls = 0
        var usageCalls = 0
        let discovery = ClaudeDiscovery(
            directories: { [directory.path] }, tokenReader: { _ in token },
            profileFetcher: { current in
                profileCalls += 1
                guard current == "synthetic-gmail" else { return nil }
                return self.profilePayload(email: "ben.ebsworth@gmail.com", uuid: "gmail")
            },
            usageFetcher: { _ in
                usageCalls += 1
                return self.usageResult(percent: 41)
            })

        XCTAssertEqual(discovery.fetchAllLimits(force: true).first?.usedPercent, 41)
        token = "synthetic-unverifiable"
        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
        XCTAssertTrue(discovery.cachedLimits(for: directory.path).isEmpty)
        XCTAssertTrue(discovery.accounts().first?.limits.isEmpty == true)
        XCTAssertTrue(discovery.accounts().first?.quotaStatus?.localizedCaseInsensitiveContains("verify") == true)
        XCTAssertEqual(profileCalls, 2)
        XCTAssertEqual(usageCalls, 1, "An unverified replacement token must never fetch quota")
    }

    func testMatchingDiskQuotaStaysVisibleAndMarkedStaleWhenLiveUsageFails() throws {
        for (status, marker) in [(429, "rate-limited"), (503, "stale")] {
            let directory = try makeProfileDirectory(".claude-dorja-\(status)")
            try writeMetadata(to: directory, email: "ben@dorja.com", uuid: "dorja",
                              cachedPercent: 63)
            var usageCalls = 0
            let discovery = ClaudeDiscovery(
                directories: { [directory.path] }, tokenReader: { _ in "synthetic-dorja" },
                profileFetcher: { _ in self.profilePayload(email: "ben@dorja.com", uuid: "dorja") },
                usageFetcher: { _ in
                    usageCalls += 1
                    return self.failedUsage(status: status)
                })

            let rows = discovery.fetchAllLimits(force: true)
            let row = try XCTUnwrap(rows.first, "HTTP \(status) must preserve matching disk quota")
            XCTAssertEqual(rows.count, 1)
            XCTAssertEqual(row.usedPercent, 63)
            XCTAssertTrue(row.detail.hasPrefix("ben@dorja.com"))
            XCTAssertTrue(row.detail.localizedCaseInsensitiveContains(marker),
                          "HTTP \(status) fallback must be marked \(marker)")
            XCTAssertEqual(discovery.accounts().first?.email, "ben@dorja.com")
            XCTAssertEqual(discovery.accounts().first?.limits.count, 1)
            XCTAssertEqual(discovery.cachedLimits(for: directory.path).count, 1)
            XCTAssertEqual(usageCalls, 1)
        }
    }

    func testMissingTokenKeepsIdentityAndRequestsSignInWithoutCallingAPIs() throws {
        let directory = try makeProfileDirectory(".claude-personal")
        try writeMetadata(to: directory, email: "ben.ebsworth@gmail.com", uuid: "gmail",
                          cachedPercent: 77)
        var token: String? = "synthetic-gmail"
        var profileCalls = 0
        var usageCalls = 0
        let discovery = ClaudeDiscovery(
            directories: { [directory.path] },
            tokenReader: { _ in token },
            profileFetcher: { _ in
                profileCalls += 1
                return self.profilePayload(email: "ben.ebsworth@gmail.com", uuid: "gmail")
            },
            usageFetcher: { _ in
                usageCalls += 1
                return self.usageResult(percent: 20)
            })

        XCTAssertEqual(discovery.fetchAllLimits(force: true).count, 1)
        token = nil
        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
        XCTAssertEqual(profileCalls, 1)
        XCTAssertEqual(usageCalls, 1)
        XCTAssertEqual(discovery.accounts().first?.email, "ben.ebsworth@gmail.com")
        XCTAssertTrue(discovery.accounts().first?.quotaStatus?.localizedCaseInsensitiveContains("sign in") == true)
        XCTAssertTrue(discovery.cachedLimits(for: directory.path).isEmpty)
    }

    func testAbsentTokenOnFirstPollDoesNotUseFreshDiskQuota() throws {
        let directory = try makeProfileDirectory(".claude-dorja")
        try writeMetadata(to: directory, email: "ben@dorja.com", uuid: "dorja", cachedPercent: 77)
        let discovery = ClaudeDiscovery(
            directories: { [directory.path] }, tokenReader: { _ in nil },
            profileFetcher: { _ in XCTFail("Missing credentials must not call the profile API"); return nil },
            usageFetcher: { _ in XCTFail("Missing credentials must not call the usage API"); return self.failedUsage() })

        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
        XCTAssertEqual(discovery.accounts().first?.email, "ben@dorja.com")
        XCTAssertTrue(discovery.accounts().first?.quotaStatus?.localizedCaseInsensitiveContains("sign in") == true)
    }

    func testTemporaryMetadataRemovalRetainsKnownProfileIdentity() throws {
        let directory = try makeProfileDirectory(".claude-dorja")
        try writeMetadata(to: directory, email: "ben@dorja.com", uuid: "dorja")
        let discovery = ClaudeDiscovery(directories: { [directory.path] }, tokenReader: { _ in nil })
        let original = discovery.accountMetadata(for: directory.path)
        try FileManager.default.removeItem(at: directory.appendingPathComponent(".claude.json"))

        let retained = discovery.accountMetadata(for: directory.path)
        XCTAssertEqual(retained.email, "ben@dorja.com")
        XCTAssertEqual(retained.accountUuid, "dorja")
        XCTAssertEqual(retained.id, original.id)
        XCTAssertEqual(retained.configDir, directory.path)
    }

    func testHydratedAccountIdentitySurvivesMissingMetadataAtLaunch() throws {
        let directory = try makeProfileDirectory(".claude-personal")
        let hydrated = ClaudeAccount(id: "legacy-profile", label: "ben.ebsworth",
                                     configDir: directory.path, accountUuid: "gmail",
                                     email: "ben.ebsworth@gmail.com", organizationUuid: "org-1")
        let discovery = ClaudeDiscovery(cachedAccounts: [hydrated],
                                        directories: { [directory.path] }, tokenReader: { _ in nil })

        let account = discovery.accountMetadata(for: directory.path)
        XCTAssertEqual(account.email, "ben.ebsworth@gmail.com")
        XCTAssertEqual(account.accountUuid, "gmail")
        XCTAssertEqual(account.organizationUuid, "org-1")
        XCTAssertEqual(account.id, ClaudeProfileIdentity.profileID(for: directory.path))
        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
        XCTAssertEqual(discovery.accounts().first?.email, "ben.ebsworth@gmail.com")
    }

    func testCopiedDefaultMetadataCannotReplaceKnownLoggedOutProfileAcrossPolls() throws {
        let directory = try makeProfileDirectory(".claude-dorja")
        let hydrated = ClaudeAccount(label: "dorja", configDir: directory.path,
                                     accountUuid: "dorja", email: "ben@dorja.com")
        try writeMetadata(to: directory, email: "ben@shorted.com.au", uuid: "shorted")
        let discovery = ClaudeDiscovery(cachedAccounts: [hydrated],
                                        directories: { [directory.path] }, tokenReader: { _ in nil })
        for _ in 0..<2 {
            XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
            let account = discovery.accountMetadata(for: directory.path)
            XCTAssertEqual(account.email, "ben@dorja.com")
            XCTAssertTrue(account.quotaStatus?.localizedCaseInsensitiveContains("sign in") == true)
        }
    }

    func testUnauthorizedQuotaResponseInvalidatesPriorQuotaAndRejectsDiskFallback() throws {
        let directory = try makeProfileDirectory(".claude-dorja")
        try writeMetadata(to: directory, email: "ben@dorja.com", uuid: "dorja", cachedPercent: 77)
        var unauthorized = false
        let discovery = ClaudeDiscovery(
            directories: { [directory.path] }, tokenReader: { _ in "synthetic-dorja" },
            profileFetcher: { _ in self.profilePayload(email: "ben@dorja.com", uuid: "dorja") },
            usageFetcher: { _ in unauthorized ? self.failedUsage(status: 401) : self.usageResult(percent: 20) })

        XCTAssertEqual(discovery.fetchAllLimits(force: true).first?.usedPercent, 20)
        unauthorized = true
        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
        XCTAssertTrue(discovery.cachedLimits(for: directory.path).isEmpty)
        XCTAssertTrue(discovery.accounts().first?.limits.isEmpty == true)
        XCTAssertTrue(discovery.accounts().first?.quotaStatus?.localizedCaseInsensitiveContains("expired") == true)
    }

    func testRememberedQuotaRowsRelabelWhenAnotherProfileHasSameDisplayLabel() throws {
        let first = try makeProfileDirectory(".claude-first")
        let second = try makeProfileDirectory(".claude-second")
        try writeMetadata(to: first, email: "ben@dorja.com", uuid: "dorja-ben")
        try writeMetadata(to: second, email: "alice@dorja.com", uuid: "dorja-alice")
        var directories = [first.path]
        var firstUnavailable = false
        let discovery = ClaudeDiscovery(
            directories: { directories },
            tokenReader: { $0 == first.path ? "synthetic-first" : "synthetic-second" },
            profileFetcher: { token in
                token == "synthetic-first"
                    ? self.profilePayload(email: "ben@dorja.com", uuid: "dorja-ben")
                    : self.profilePayload(email: "alice@dorja.com", uuid: "dorja-alice")
            },
            usageFetcher: { token in
                if token == "synthetic-first" {
                    return firstUnavailable ? self.failedUsage() : self.usageResult(percent: 21)
                }
                return self.usageResult(percent: 34)
            })

        XCTAssertEqual(discovery.fetchAllLimits(force: true).first?.provider, "claude")
        directories.append(second.path)
        firstUnavailable = true
        let rows = discovery.fetchAllLimits(force: true)
        let accounts = discovery.accounts()

        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(Set(rows.map(\.provider)).count, 2)
        XCTAssertFalse(rows.contains { $0.provider == "claude" })
        for account in accounts {
            let row = try XCTUnwrap(rows.first { $0.detail.hasPrefix(account.email) })
            XCTAssertEqual(row.provider, "claude (dorja · \(account.id))")
            XCTAssertEqual(account.limits.first?.provider, row.provider)
        }
        let remembered = try XCTUnwrap(rows.first { $0.detail.hasPrefix("ben@dorja.com") })
        XCTAssertEqual(remembered.usedPercent, 21)
        XCTAssertTrue(remembered.detail.localizedCaseInsensitiveContains("stale"))
    }

    func testProfilePayloadRequiresUsableAccountIdentity() {
        let invalid: [[String: Any]] = [
            [:], ["account": "invalid"], ["account": [:]],
            ["account": ["uuid": "", "email": "ben@dorja.com"]],
            ["account": ["uuid": "dorja"]],
            ["account": ["uuid": "dorja", "email": ""]],
            ["account": ["uuid": 123, "email": "ben@dorja.com"]],
            ["account": ["uuid": "dorja", "email": NSNull()]],
        ]
        for (index, payload) in invalid.enumerated() {
            XCTAssertNil(ClaudeDiscovery.parseProfilePayload(payload, dir: "/synthetic/claude"),
                         "Malformed profile case \(index) must not establish account identity")
        }
    }

    func testProfilePayloadMapsAccountAndOrganizationMetadata() throws {
        let account = try XCTUnwrap(ClaudeDiscovery.parseProfilePayload(
            profilePayload(email: "ben@dorja.com", uuid: "dorja"), dir: "/synthetic/claude"))
        XCTAssertEqual(account.email, "ben@dorja.com")
        XCTAssertEqual(account.accountUuid, "dorja")
        XCTAssertEqual(account.displayName, "Synthetic User")
        XCTAssertEqual(account.organizationUuid, "org-1")
        XCTAssertEqual(account.organizationName, "Synthetic Organization")
        XCTAssertEqual(account.organizationType, "claude_max")
        XCTAssertEqual(account.rateLimitTier, "default_claude_max_5x")
        XCTAssertTrue(account.hasExtraUsageEnabled)
    }
}
