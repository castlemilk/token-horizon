import XCTest
@testable import TokenHorizon

final class CodexAccountDiscoveryTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func jwt(_ payload: [String: Any]) -> String {
        let data = json(payload)
        let encoded = data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return "eyJhbGciOiJub25lIn0.\(encoded).synthetic"
    }

    private func codexAuth(account: String, email: String, expiry: TimeInterval = 10_000,
                           storedAccount: String? = nil) -> Data {
        let access = jwt(["exp": now.timeIntervalSince1970 + expiry,
                          "https://api.openai.com/auth": ["chatgpt_account_id": account, "chatgpt_plan_type": "pro"]])
        let identity = jwt(["email": email, "name": "Synthetic User",
                            "https://api.openai.com/auth": ["chatgpt_account_id": account]])
        return json(["tokens": ["access_token": access, "refresh_token": "synthetic-\(account)",
                                 "account_id": storedAccount ?? account, "id_token": identity]])
    }

    private func opencodeAuth(account: String, email: String, expiry: TimeInterval = 20_000) -> Data {
        json(["openai": ["type": "oauth", "access": jwt([
            "https://api.openai.com/auth": ["chatgpt_account_id": account],
            "https://api.openai.com/profile": ["email": email],
        ]), "refresh": "synthetic-oc-\(account)", "accountId": account,
                           "expires": (now.timeIntervalSince1970 + expiry) * 1_000]])
    }

    private func json(_ object: [String: Any]) -> Data {
        do {
            return try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
        } catch {
            XCTFail("The synthetic JSON fixture could not be encoded")
            return Data()
        }
    }

    private func usage(_ percent: Double) -> CodexAccountDiscovery.UsageResult {
        .init(payload: ["plan_type": "pro", "rate_limit": [
            "primary_window": ["used_percent": percent, "limit_window_seconds": 18_000,
                                "reset_at": now.timeIntervalSince1970 + 3_600],
            "secondary_window": ["used_percent": percent + 10, "limit_window_seconds": 604_800,
                                  "reset_at": now.timeIntervalSince1970 + 86_400],
        ]], statusCode: 200)
    }

    func testDiscoversDefaultVariantsEnvironmentAndManagedHomesWithoutReadingHostHome() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("th-codex-discovery-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = [root.appendingPathComponent(".codex"), root.appendingPathComponent(".codex-work"),
                     root.appendingPathComponent("custom-codex"), root.appendingPathComponent("managed/personal"),
                     root.appendingPathComponent(".config/codex")]
        for path in paths { try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true) }
        try Data().write(to: root.appendingPathComponent(".codex-file"))

        let directories = CodexAccountDiscovery.discoverDirectories(
            home: root.path, environment: ["CODEX_HOME": paths[2].path], managedDirectories: [paths[3].path, paths[1].path])

        XCTAssertEqual(Set(directories), Set(paths.map(\.path)))
        XCTAssertEqual(directories.count, paths.count)
        XCTAssertEqual(directories.first, paths[2].path)
        XCTAssertFalse(directories.contains(root.appendingPathComponent(".codex-file").path))
    }

    func testSeparateAccountsAllReceiveQuotaAndKeepTheirOwnAuthSource() {
        let homes = ["/synthetic/.codex", "/synthetic/.codex-work", "/synthetic/.codex-dorja"]
        let files = [homes[0] + "/auth.json": codexAuth(account: "gmail", email: "ben.ebsworth@gmail.com"),
                     homes[1] + "/auth.json": codexAuth(account: "shorted", email: "ben@shorted.com.au"),
                     homes[2] + "/auth.json": codexAuth(account: "dorja", email: "ben@dorja.com")]
        var refreshedPaths: [String] = []
        var queriedAccounts: [String] = []
        let discovery = CodexAccountDiscovery(
            directories: { homes }, opencodePaths: { [] }, fileReader: { files[$0] },
            authRefresher: { auth in
                if case .codexFile(let path) = auth.source { refreshedPaths.append(path) }
                else { XCTFail("Codex homes must keep their own file source") }
                return auth
            }, usageFetcher: { auth in
                queriedAccounts.append(auth.accountId)
                return self.usage(20)
            }, clock: ManualClock(now))

        let rows = discovery.fetchAllLimits(force: true)
        XCTAssertEqual(Set(queriedAccounts), ["gmail", "shorted", "dorja"])
        XCTAssertEqual(Set(refreshedPaths), Set(files.keys))
        XCTAssertEqual(rows.count, 6)
        XCTAssertEqual(Set(rows.map(\.provider)).count, 3)
        XCTAssertEqual(Set(discovery.accounts().map(\.email)),
                       ["ben.ebsworth@gmail.com", "ben@shorted.com.au", "ben@dorja.com"])
        XCTAssertEqual(discovery.account(forConfigDir: homes[2])?.accountId, "dorja")
    }

    func testSameAccountAcrossCodexHomesAndOpencodePollsFreshestOnceAndRetainsAllPaths() {
        let homes = ["/synthetic/.codex", "/synthetic/.codex-copy"]
        let opencode = "/synthetic/opencode/auth.json"
        let files = [homes[0] + "/auth.json": codexAuth(account: "shared", email: "same@example.com", expiry: 100),
                     homes[1] + "/auth.json": codexAuth(account: "shared", email: "same@example.com", expiry: 200),
                     opencode: opencodeAuth(account: "shared", email: "same@example.com", expiry: 300)]
        var refreshSources: [PlanLimitsEngine.OpenAIAuth.Source] = []
        var usageCalls = 0
        let discovery = CodexAccountDiscovery(
            directories: { homes }, opencodePaths: { [opencode] }, fileReader: { files[$0] },
            authRefresher: { refreshSources.append($0.source); return $0 },
            usageFetcher: { auth in
                usageCalls += 1
                XCTAssertEqual(auth.source, .opencodeFile(path: opencode))
                return self.usage(20)
            }, clock: ManualClock(now))

        XCTAssertEqual(discovery.fetchAllLimits(force: true).count, 2)
        XCTAssertEqual(discovery.accounts().count, 1)
        XCTAssertEqual(discovery.accounts().first?.configDirs, homes)
        XCTAssertEqual(Set(discovery.accounts().first?.authPaths ?? []), Set(files.keys))
        XCTAssertEqual(refreshSources, [.opencodeFile(path: opencode)])
        XCTAssertEqual(usageCalls, 1)
    }

    func testSameEmailInDifferentWorkspacesKeepsSeparateQuotaRows() {
        let homes = ["/synthetic/.codex-one", "/synthetic/.codex-two"]
        let files = [homes[0] + "/auth.json": codexAuth(account: "workspace-one", email: "same@example.com"),
                     homes[1] + "/auth.json": codexAuth(account: "workspace-two", email: "same@example.com")]
        let discovery = CodexAccountDiscovery(
            directories: { homes }, opencodePaths: { [] }, fileReader: { files[$0] },
            authRefresher: { $0 }, usageFetcher: { _ in self.usage(20) }, clock: ManualClock(now))

        let rows = discovery.fetchAllLimits(force: true)
        XCTAssertEqual(discovery.accounts().count, 2)
        XCTAssertEqual(Set(rows.map(\.provider)).count, 2)
        XCTAssertTrue(rows.allSatisfy { $0.provider.contains("same@example.com · ") })
    }

    func testRefreshAdoptingDifferentAccountUsesNewJWTIdentityAndDoesNotBorrowOldQuota() {
        let home = "/synthetic/.codex"
        let path = home + "/auth.json"
        var files = [path: codexAuth(account: "old-account", email: "old@example.com")]
        var switchDuringRefresh = false
        var queriedAccounts: [String] = []
        let discovery = CodexAccountDiscovery(
            directories: { [home] }, opencodePaths: { [] }, fileReader: { files[$0] },
            authRefresher: { original in
                guard switchDuringRefresh else { return original }
                // Model a write-back race where the CLI changes accounts and
                // the old helper returns a stale accountId with the new JWT.
                let replacement = self.codexAuth(account: "new-account", email: "new@example.com",
                                                 storedAccount: "old-account")
                files[path] = replacement
                guard let root = try? JSONSerialization.jsonObject(with: replacement) as? [String: Any],
                      let tokens = root["tokens"] as? [String: Any],
                      let access = tokens["access_token"] as? String else {
                    XCTFail("The synthetic replacement credentials could not be decoded")
                    return original
                }
                var adopted = original
                adopted.accessToken = access
                return adopted
            }, usageFetcher: { auth in
                queriedAccounts.append(auth.accountId)
                return switchDuringRefresh ? .init(payload: nil, statusCode: 503) : self.usage(20)
            }, clock: ManualClock(now))

        XCTAssertEqual(discovery.fetchAllLimits(force: true).count, 2)
        let originalID = discovery.accounts().first?.id
        switchDuringRefresh = true
        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
        XCTAssertEqual(queriedAccounts, ["old-account", "new-account"])
        XCTAssertEqual(discovery.accounts().first?.accountId, "new-account")
        XCTAssertEqual(discovery.accounts().first?.email, "new@example.com")
        XCTAssertNotEqual(discovery.accounts().first?.id, originalID)
    }

    func testMissingAuthRetainsHydratedIdentityAndExplicitSignInStatusWithoutAPIs() {
        let home = "/synthetic/.codex-dorja"
        let cached = CodexAccount(id: "known-dorja", accountId: "dorja", email: "ben@dorja.com",
                                  label: "ben@dorja.com", configDirs: [home], authPaths: [home + "/auth.json"])
        let discovery = CodexAccountDiscovery(
            cachedAccounts: [cached], directories: { [home] }, opencodePaths: { [] }, fileReader: { _ in nil },
            authRefresher: { auth in XCTFail("No credentials must never refresh"); return auth },
            usageFetcher: { _ in XCTFail("No credentials must never query quota"); return .init(payload: nil, statusCode: -1) },
            clock: ManualClock(now))

        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
        XCTAssertEqual(discovery.accounts().first?.email, "ben@dorja.com")
        XCTAssertTrue(discovery.accounts().first?.quotaStatus?.contains("Sign in") == true)
        XCTAssertNotNil(discovery.account(forConfigDir: home)?.profileStatuses[home])
    }

    func testKeyringProfileExplainsWhyFileBasedQuotaIsUnavailable() {
        let home = "/synthetic/.codex-keyring"
        let discovery = CodexAccountDiscovery(
            directories: { [home] }, opencodePaths: { [] },
            fileReader: { $0 == home + "/config.toml" ? Data("cli_auth_credentials_store = \"keyring\"\n".utf8) : nil },
            authRefresher: { auth in XCTFail("Keyring-only profile must not read or refresh host credentials"); return auth },
            usageFetcher: { _ in XCTFail("Keyring-only profile must not query quota"); return .init(payload: nil, statusCode: -1) },
            clock: ManualClock(now))

        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
        XCTAssertTrue(discovery.accounts().first?.quotaStatus?.contains("system credential store") == true)
    }

    func testOpaqueTokenSwitchCannotReuseUnverifiedAccountQuota() {
        let home = "/synthetic/.codex"
        var token = "synthetic-old-opaque"
        let discovery = CodexAccountDiscovery(
            directories: { [home] }, opencodePaths: { [] },
            fileReader: { _ in self.json(["tokens": ["access_token": token]]) }, authRefresher: { $0 },
            usageFetcher: { auth in
                auth.accessToken == "synthetic-old-opaque" ? self.usage(20) : .init(payload: nil, statusCode: 503)
            }, clock: ManualClock(now))

        XCTAssertEqual(discovery.fetchAllLimits(force: true).count, 2)
        token = "synthetic-other-opaque"
        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
    }

    func testAPIKeyModeDoesNotPollRetainedChatGPTTokens() throws {
        let home = "/synthetic/.codex-api"
        var root = try XCTUnwrap(try JSONSerialization.jsonObject(
            with: codexAuth(account: "old", email: "old@example.com")) as? [String: Any])
        root["auth_mode"] = "apikey"
        let data = json(root)
        let discovery = CodexAccountDiscovery(
            directories: { [home] }, opencodePaths: { [] }, fileReader: { _ in data },
            authRefresher: { auth in XCTFail("API-key mode must not refresh an old ChatGPT login"); return auth },
            usageFetcher: { _ in XCTFail("API-key mode must not query ChatGPT quotas"); return .init(payload: nil, statusCode: -1) },
            clock: ManualClock(now))

        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
        XCTAssertTrue(discovery.accounts().first?.quotaStatus?.contains("API key") == true)
        XCTAssertEqual(discovery.accounts().first?.label, "codex-api")
    }

    func testTransientQuotaFailureRetainsStaleRowsButUnauthorizedClearsThem() {
        let home = "/synthetic/.codex"
        let files = [home + "/auth.json": codexAuth(account: "gmail", email: "ben.ebsworth@gmail.com")]
        var status = 200
        let discovery = CodexAccountDiscovery(
            directories: { [home] }, opencodePaths: { [] }, fileReader: { files[$0] }, authRefresher: { $0 },
            usageFetcher: { _ in status == 200 ? self.usage(20) : .init(payload: nil, statusCode: status) },
            clock: ManualClock(now))

        XCTAssertEqual(discovery.fetchAllLimits(force: true).count, 2)
        status = 503
        let stale = discovery.fetchAllLimits(force: true)
        XCTAssertEqual(stale.count, 2)
        XCTAssertTrue(stale.allSatisfy { $0.detail.contains("stale") })
        status = 401
        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty)
        XCTAssertTrue(discovery.accounts().first?.quotaStatus?.contains("expired") == true)
        status = 503
        XCTAssertTrue(discovery.fetchAllLimits(force: true).isEmpty, "Rejected quota cannot return on a later network failure")
    }

    func testRecentPersistedQuotaSurvivesFirstTransientRefreshOnlyForMatchingIdentity() throws {
        let home = "/synthetic/.codex"
        let files = [home + "/auth.json": codexAuth(account: "gmail", email: "ben.ebsworth@gmail.com")]
        let initial = CodexAccountDiscovery(
            directories: { [home] }, opencodePaths: { [] }, fileReader: { files[$0] }, authRefresher: { $0 },
            usageFetcher: { _ in self.usage(20) }, clock: ManualClock(now))
        _ = initial.fetchAllLimits(force: true)
        var persisted = try XCTUnwrap(initial.accounts().first)
        for age in [60.0, 7_201.0] {
            persisted.updatedAt = now.addingTimeInterval(-age)
            let restarted = CodexAccountDiscovery(
                cachedAccounts: [persisted], directories: { [home] }, opencodePaths: { [] },
                fileReader: { files[$0] }, authRefresher: { $0 },
                usageFetcher: { _ in .init(payload: nil, statusCode: 503) }, clock: ManualClock(now))
            let rows = restarted.fetchAllLimits(force: true)
            XCTAssertEqual(rows.count, age < 7_200 ? 2 : 0)
            XCTAssertTrue(rows.allSatisfy { $0.detail.contains("stale") })
        }
        persisted.updatedAt = now.addingTimeInterval(-60)
        let changedFiles = [home + "/auth.json": codexAuth(account: "dorja", email: "ben@dorja.com")]
        let switched = CodexAccountDiscovery(
            cachedAccounts: [persisted], directories: { [home] }, opencodePaths: { [] },
            fileReader: { changedFiles[$0] }, authRefresher: { $0 },
            usageFetcher: { _ in .init(payload: nil, statusCode: 503) }, clock: ManualClock(now))
        XCTAssertTrue(switched.fetchAllLimits(force: true).isEmpty)
        XCTAssertEqual(switched.accounts().first?.accountId, "dorja")
    }

    func testRateLimitBackoffDoesNotPreventOtherAccountsFromRefreshing() {
        let homes = ["/synthetic/.codex-one", "/synthetic/.codex-two"]
        let files = [homes[0] + "/auth.json": codexAuth(account: "one", email: "one@example.com"),
                     homes[1] + "/auth.json": codexAuth(account: "two", email: "two@example.com")]
        var calls: [String: Int] = [:]
        let clock = ManualClock(now)
        let discovery = CodexAccountDiscovery(
            directories: { homes }, opencodePaths: { [] }, fileReader: { files[$0] }, authRefresher: { $0 },
            usageFetcher: { auth in
                calls[auth.accountId, default: 0] += 1
                return auth.accountId == "one" ? .init(payload: nil, statusCode: 429, retryAfter: 120) : self.usage(20)
            }, clock: clock)

        XCTAssertEqual(discovery.fetchAllLimits(force: true).count, 2)
        XCTAssertEqual(discovery.fetchAllLimits(force: true).count, 2)
        XCTAssertEqual(calls["one"], 1)
        XCTAssertEqual(calls["two"], 2)
        clock.advance(by: 121)
        _ = discovery.fetchAllLimits(force: true)
        XCTAssertEqual(calls["one"], 2)
    }

    func testLiveAccountRetainsMissingSiblingHomeStatus() {
        let liveHome = "/synthetic/.codex"
        let missingHome = "/synthetic/.codex-copy"
        let files = [liveHome + "/auth.json": codexAuth(account: "shared", email: "same@example.com")]
        let initial = CodexAccountDiscovery(
            directories: { [liveHome] }, opencodePaths: { [] }, fileReader: { files[$0] },
            authRefresher: { $0 }, usageFetcher: { _ in self.usage(20) }, clock: ManualClock(now))
        _ = initial.fetchAllLimits(force: true)
        var cached = initial.accounts()[0]
        cached.configDirs.append(missingHome)
        let discovery = CodexAccountDiscovery(
            cachedAccounts: [cached], directories: { [liveHome, missingHome] }, opencodePaths: { [] },
            fileReader: { files[$0] }, authRefresher: { $0 }, usageFetcher: { _ in self.usage(20) }, clock: ManualClock(now))

        XCTAssertEqual(discovery.fetchAllLimits(force: true).count, 2)
        XCTAssertEqual(discovery.accounts().count, 1)
        XCTAssertEqual(Set(discovery.accounts()[0].configDirs), [liveHome, missingHome])
        XCTAssertNotNil(discovery.accounts()[0].profileStatuses[missingHome])
        XCTAssertNil(discovery.accounts()[0].quotaStatus)
    }

    func testUsageParserIncludesBothWindowsAndNamedModelLimitsWithoutInventingUsage() {
        let payload: [String: Any] = [
            "rate_limit": ["primary_window": ["used_percent": 20, "limit_window_seconds": 18_000],
                           "secondary_window": ["used_percent": 30, "limit_window_seconds": 604_800]],
            "additional_rate_limits": [["limit_name": "Spark", "rate_limit": [
                "primary_window": ["used_percent": 40, "limit_window_seconds": 18_000],
                "secondary_window": ["limit_window_seconds": 604_800],
            ]]],
        ]
        let rows = CodexAccountDiscovery.parseUsagePayload(payload)
        XCTAssertEqual(rows.map(\.label), ["5h", "7d", "spark 5h"])
        XCTAssertEqual(rows.map(\.usedPercent), [20, 30, 40])
        XCTAssertTrue(CodexAccountDiscovery.parseUsagePayload(["rate_limit": ["primary_window": [:]]]).isEmpty)
    }

    func testAccountSnapshotsNeverSerializeTokens() throws {
        let home = "/synthetic/.codex"
        let files = [home + "/auth.json": codexAuth(account: "gmail", email: "ben.ebsworth@gmail.com")]
        let discovery = CodexAccountDiscovery(
            directories: { [home] }, opencodePaths: { [] }, fileReader: { files[$0] }, authRefresher: { $0 },
            usageFetcher: { _ in self.usage(20) }, clock: ManualClock(now))
        _ = discovery.fetchAllLimits(force: true)

        let data = try JSONEncoder().encode(discovery.accounts())
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(text.contains("ben.ebsworth@gmail.com"))
        XCTAssertFalse(text.contains("synthetic-gmail"))
        XCTAssertFalse(text.contains("access_token"))
        XCTAssertFalse(text.contains("refresh_token"))
        XCTAssertFalse(text.contains("id_token"))
    }
}
