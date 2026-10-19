import XCTest
@testable import TokenHorizon

final class DashboardNavigationPreferencesTests: XCTestCase {
    func testDefaultsKeepExistingQuickNavigationOrder() {
        XCTAssertEqual(DashboardNavigationPreferences().pinnedTabs, [.tokens, .activity, .mlx, .settings])
    }

    func testStoredIdentifiersNormalizeWithoutChangingOrder() {
        let cases: [([String], [DashboardTab])] = [
            (["TEAMS", "TOKENS", "TEAMS", "UNKNOWN", "SETTINGS"], [.teams, .tokens, .settings]),
            ([" tokens\n", "teams", "TOKENS", "\tsettings "], [.tokens, .teams, .settings]),
            (["UNKNOWN", "REMOVED-TAB"], []),
            ([], [])
        ]
        for (identifiers, expected) in cases {
            let preferences = DashboardNavigationPreferences(pinnedTabIDs: identifiers)
            XCTAssertEqual(preferences.pinnedTabs, expected, identifiers.description)
            XCTAssertEqual(preferences.pinnedTabIDs, expected.map(\.rawValue))
            XCTAssertEqual(preferences.normalized, preferences)
        }
    }

    func testAbsentOrMalformedStoredListUsesDefaults() throws {
        let cases = ["{}", "null", "[]", "42", "{\"pinnedTabIDs\":null}",
                     "{\"pinnedTabIDs\":\"TOKENS\"}", "{\"pinnedTabIDs\":[\"TEAMS\",42]}"]
        for json in cases {
            let preferences = try JSONDecoder().decode(DashboardNavigationPreferences.self, from: Data(json.utf8))
            XCTAssertEqual(preferences, DashboardNavigationPreferences(), json)
        }
    }

    func testExplicitEmptyListSurvivesCodableRoundTrip() throws {
        let preferences = try JSONDecoder().decode(DashboardNavigationPreferences.self,
                                                  from: Data("{\"pinnedTabIDs\":[]}".utf8))
        XCTAssertTrue(preferences.pinnedTabs.isEmpty)
        XCTAssertEqual(preferences.unpinnedTabs, DashboardTab.allCases)
        XCTAssertEqual(try JSONDecoder().decode(DashboardNavigationPreferences.self,
                                               from: JSONEncoder().encode(preferences)), preferences)
    }

    func testOrderAndStableIdentifiersSurviveRoundTrip() throws {
        let preferences = DashboardNavigationPreferences(pinnedTabs: [.teams, .leaderboard, .models, .tokens])
        let data = try JSONEncoder().encode(preferences)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["pinnedTabIDs"] as? [String], ["TEAMS", "LEADERBOARD", "MODELS", "TOKENS"])
        XCTAssertEqual(try JSONDecoder().decode(DashboardNavigationPreferences.self, from: data), preferences)
    }

    func testPinAndUnpinAreIdempotentAndRepinningAppends() {
        var preferences = DashboardNavigationPreferences(pinnedTabs: [.teams, .tokens])
        preferences.setPinned(.teams, pinned: true)
        XCTAssertEqual(preferences.pinnedTabs, [.teams, .tokens])
        preferences.setPinned(.teams, pinned: false)
        preferences.setPinned(.teams, pinned: false)
        XCTAssertEqual(preferences.pinnedTabs, [.tokens])
        preferences.setPinned(.teams, pinned: true)
        XCTAssertEqual(preferences.pinnedTabs, [.tokens, .teams])
    }

    func testEveryTabCanBeUnpinnedWithoutLosingAccess() {
        var preferences = DashboardNavigationPreferences()
        for tab in DashboardTab.allCases { preferences.setPinned(tab, pinned: false) }
        XCTAssertTrue(preferences.pinnedTabs.isEmpty)
        XCTAssertEqual(preferences.unpinnedTabs, DashboardTab.allCases)
    }

    func testAllTabsMayBePinnedAndUnpinnedTabsRemainAvailable() {
        var preferences = DashboardNavigationPreferences(pinnedTabs: [.teams])
        // All current/future tabs remain reachable without silently pinning them.
        XCTAssertEqual(preferences.unpinnedTabs, DashboardTab.allCases.filter { $0 != .teams })
        for tab in DashboardTab.allCases { preferences.setPinned(tab, pinned: true) }
        XCTAssertEqual(Set(preferences.pinnedTabs), Set(DashboardTab.allCases))
        XCTAssertTrue(preferences.unpinnedTabs.isEmpty)
        XCTAssertEqual(preferences.pinnedTabs.count, DashboardTab.allCases.count)
    }

    func testReorderingClampsAtEndsAndIgnoresUnpinnedTabs() {
        let cases: [(DashboardTab, Int, [DashboardTab])] = [
            (.activity, -1, [.activity, .tokens, .mlx, .settings]),
            (.activity, 1, [.tokens, .mlx, .activity, .settings]),
            (.mlx, Int.min, [.mlx, .tokens, .activity, .settings]),
            (.tokens, Int.max, [.activity, .mlx, .settings, .tokens]),
            (.tokens, -1, [.tokens, .activity, .mlx, .settings]),
            (.settings, 1, [.tokens, .activity, .mlx, .settings]),
            (.teams, -1, [.tokens, .activity, .mlx, .settings]),
            (.activity, 0, [.tokens, .activity, .mlx, .settings])
        ]
        for (tab, offset, expected) in cases {
            var preferences = DashboardNavigationPreferences()
            preferences.move(tab, offset: offset)
            XCTAssertEqual(preferences.pinnedTabs, expected, "\(tab) by \(offset)")
        }
        var empty = DashboardNavigationPreferences(pinnedTabs: [])
        empty.move(.teams, offset: Int.max)
        XCTAssertTrue(empty.pinnedTabs.isEmpty)
    }

}

final class SettingsNavigationPreferencesTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("token-horizon-navigation-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }

    private var settingsURL: URL { directory.appendingPathComponent("settings.json") }

    func testLegacySettingsKeepDefaultsWithoutRewritingIdentityOrRegisteringLaunchAgent() throws {
        let legacy = Data("{\"leaderboardTeam\":\"maxxers\",\"leaderboardHandle\":\"fixture-user\",\"launchAtLogin\":true}".utf8)
        try legacy.write(to: settingsURL)
        let store = SettingsStore(directory: directory)
        XCTAssertEqual(store.navigationPreferences, DashboardNavigationPreferences())
        XCTAssertEqual(store.leaderboardTeam, "maxxers")
        XCTAssertEqual(store.leaderboardHandle, "fixture-user")
        XCTAssertEqual(try Data(contentsOf: settingsURL), legacy)
    }

    func testOrderPersistsWithoutChangingTeamSharingOrCredentials() throws {
        let store = SettingsStore(directory: directory)
        store.leaderboardTeam = "maxxers"
        store.leaderboardHandle = "fixture-user"
        store.leaderboardCloudToken = "test-only-credential"
        store.leaderboardShareCost = false
        store.leaderboardShareHardware = false
        store.leaderboardSharePrompts = false
        store.historyPersistenceEnabled = false
        store.navigationPreferences = DashboardNavigationPreferences(pinnedTabs: [.teams, .leaderboard, .tokens])

        let restored = SettingsStore(directory: directory)
        XCTAssertEqual(restored.navigationPreferences.pinnedTabs, [.teams, .leaderboard, .tokens])
        XCTAssertEqual(restored.leaderboardTeam, "maxxers")
        XCTAssertEqual(restored.leaderboardHandle, "fixture-user")
        XCTAssertEqual(restored.leaderboardCloudToken, "test-only-credential")
        XCTAssertFalse(restored.leaderboardShareCost)
        XCTAssertFalse(restored.leaderboardShareHardware)
        XCTAssertFalse(restored.leaderboardSharePrompts)
        XCTAssertFalse(restored.historyPersistenceEnabled)
        let attributes = try FileManager.default.attributesOfItem(atPath: settingsURL.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testClearingAllPinsPersistsAndResetRestoresDefaults() {
        let store = SettingsStore(directory: directory)
        store.navigationPreferences = DashboardNavigationPreferences(pinnedTabs: [])
        XCTAssertTrue(SettingsStore(directory: directory).navigationPreferences.pinnedTabs.isEmpty)
        store.navigationPreferences = DashboardNavigationPreferences()
        XCTAssertEqual(SettingsStore(directory: directory).navigationPreferences, DashboardNavigationPreferences())
    }

    func testNavigationNotificationArrivesAfterSaveAndUnlock() {
        let store = SettingsStore(directory: directory)
        var notifications = 0
        let observer = NotificationCenter.default.addObserver(forName: .tokenHorizonNavigationDidChange,
                                                              object: nil, queue: nil) { notification in
            guard let changed = notification.object as? SettingsStore, changed === store else { return }
            notifications += 1
            // Reading from the notification verifies the setter released its lock.
            XCTAssertEqual(store.navigationPreferences.pinnedTabs, [.teams, .tokens])
            XCTAssertEqual(SettingsStore(directory: self.directory).navigationPreferences.pinnedTabs, [.teams, .tokens])
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        store.navigationPreferences = DashboardNavigationPreferences(pinnedTabs: [.teams, .tokens])
        store.navigationPreferences = DashboardNavigationPreferences(pinnedTabIDs: ["teams", "TOKENS", "TEAMS"])
        XCTAssertEqual(notifications, 1)
    }

    func testMalformedPreferenceValuesFallBackWithoutDiscardingOtherSettings() throws {
        let values: [Any] = [NSNull(), "TEAMS", 42, ["pinnedTabIDs": NSNull()], ["pinnedTabIDs": ["TEAMS", 42]]]
        for value in values {
            let data = try JSONSerialization.data(withJSONObject: ["navigationPreferences": value, "leaderboardTeam": "maxxers"])
            try data.write(to: settingsURL)
            let store = SettingsStore(directory: directory)
            XCTAssertEqual(store.navigationPreferences, DashboardNavigationPreferences(), "\(value)")
            XCTAssertEqual(store.leaderboardTeam, "maxxers")
        }
    }

    func testUnknownAndDuplicateStoredPinsAreSanitizedOnLoad() throws {
        try Data("{\"navigationPreferences\":{\"pinnedTabIDs\":[\"TEAMS\",\"UNKNOWN\",\"TOKENS\",\"TEAMS\"]}}".utf8)
            .write(to: settingsURL)
        XCTAssertEqual(SettingsStore(directory: directory).navigationPreferences.pinnedTabs, [.teams, .tokens])
    }

    func testNoOpPreferenceAssignmentDoesNotCreateSettingsFile() {
        let store = SettingsStore(directory: directory)
        store.navigationPreferences = DashboardNavigationPreferences()
        XCTAssertFalse(FileManager.default.fileExists(atPath: settingsURL.path))
    }
}
