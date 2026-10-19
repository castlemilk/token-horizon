import XCTest
@testable import TokenHorizon

final class ManagedCLIProfileTests: XCTestCase {
    private struct Fixture {
        let home: URL
        let registry: URL
        let store: ManagedCLIProfileStore
    }

    private func fixture() throws -> Fixture {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-managed-cli-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let registry = root.appendingPathComponent("settings", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: registry, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return Fixture(home: home, registry: registry,
                       store: ManagedCLIProfileStore(directory: registry, home: home.path))
    }

    private func permissions(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue & 0o777
    }

    func testProviderLaunchMetadataIsExplicit() {
        let cases: [(CLIAccountProvider, String, String, String, String)] = [
            (.claude, "Claude Code", "claude", "CLAUDE_CONFIG_DIR", ".claude"),
            (.codex, "Codex", "codex", "CODEX_HOME", ".codex")
        ]
        for (provider, title, executable, environment, prefix) in cases {
            XCTAssertEqual(provider.id, provider.rawValue)
            XCTAssertEqual(provider.title, title)
            XCTAssertEqual(provider.executable, executable)
            XCTAssertEqual(provider.environmentKey, environment)
            XCTAssertEqual(provider.defaultHomePrefix, prefix)
        }
    }

    func testCreatePersistsMetadataDefaultsAndPrivatePermissions() throws {
        let fixture = try fixture()
        XCTAssertTrue(fixture.store.profiles().isEmpty)
        XCTAssertNil(fixture.store.loadError)
        let profile = try fixture.store.create(provider: .claude, name: "Dorja Team",
                                                expectedEmail: "ben@dorja.com", workingDirectory: fixture.home.path)
        XCTAssertEqual(profile.configDir, fixture.home.appendingPathComponent(".claude-dorja-team").path)
        XCTAssertTrue(profile.createdByApp)
        XCTAssertEqual(try permissions(URL(fileURLWithPath: profile.configDir)), 0o700)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: profile.configDir), [])
        try fixture.store.setDefault(profileID: profile.id, provider: .claude)

        let registryURL = fixture.registry.appendingPathComponent("accounts.json")
        XCTAssertEqual(try permissions(registryURL), 0o600)
        let reloaded = ManagedCLIProfileStore(directory: fixture.registry, home: fixture.home.path)
        XCTAssertNil(reloaded.loadError)
        XCTAssertEqual(reloaded.profiles(), [profile])
        XCTAssertEqual(reloaded.profilePaths(for: .claude), [profile.configDir])
        XCTAssertTrue(reloaded.profilePaths(for: .codex).isEmpty)
        XCTAssertEqual(reloaded.defaultProfileID(for: .claude), profile.id)
        XCTAssertNil(reloaded.defaultProfileID(for: .codex))
    }

    func testCodexCreationSeedsOnlyIsolatedFileCredentialSetting() throws {
        let fixture = try fixture()
        let defaultCodex = fixture.home.appendingPathComponent(".codex", isDirectory: true)
        try FileManager.default.createDirectory(at: defaultCodex, withIntermediateDirectories: true)
        let secret = Data("synthetic-token-that-must-not-be-copied".utf8)
        try secret.write(to: defaultCodex.appendingPathComponent("auth.json"))
        try Data("model = \"default-only\"\n".utf8).write(to: defaultCodex.appendingPathComponent("config.toml"))

        let profile = try fixture.store.create(provider: .codex, name: "Personal")
        let directory = URL(fileURLWithPath: profile.configDir, isDirectory: true)
        let config = directory.appendingPathComponent("config.toml")
        XCTAssertEqual(try String(contentsOf: config), "cli_auth_credentials_store = \"file\"\n")
        XCTAssertEqual(try permissions(directory), 0o700)
        XCTAssertEqual(try permissions(config), 0o600)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["config.toml"])
        XCTAssertEqual(try Data(contentsOf: defaultCodex.appendingPathComponent("auth.json")), secret)

        let persisted = try String(contentsOf: fixture.registry.appendingPathComponent("accounts.json"))
        for forbidden in ["synthetic-token", "accessToken", "refreshToken", "authorization", "default-only"] {
            XCTAssertFalse(persisted.contains(forbidden), forbidden)
        }
    }

    func testImportRenameAndRemoveLeaveProfileAndAuthUntouched() throws {
        let fixture = try fixture()
        let existing = fixture.home.appendingPathComponent("custom profile", isDirectory: true)
        try FileManager.default.createDirectory(at: existing, withIntermediateDirectories: true)
        let credentials = existing.appendingPathComponent(".credentials.json")
        let original = Data("{\"synthetic\":\"do not change\"}".utf8)
        try original.write(to: credentials)
        let imported = try fixture.store.importProfile(provider: .claude, path: existing.path + "/",
                                                        name: "Work", expectedEmail: "ben@dorja.com")
        XCTAssertEqual(imported.configDir, existing.path)
        XCTAssertFalse(imported.createdByApp)
        try fixture.store.setDefault(profileID: imported.id, provider: .claude)
        var renamed = imported
        renamed.name = "Dorja"
        try fixture.store.save(renamed)
        XCTAssertEqual(fixture.store.profiles(), [renamed])
        XCTAssertEqual(fixture.store.defaultProfileID(for: .claude), imported.id)

        try fixture.store.remove(profileID: imported.id)
        XCTAssertTrue(fixture.store.profiles().isEmpty)
        XCTAssertNil(fixture.store.defaultProfileID(for: .claude))
        XCTAssertTrue(FileManager.default.fileExists(atPath: existing.path))
        XCTAssertEqual(try Data(contentsOf: credentials), original)
        let reloaded = ManagedCLIProfileStore(directory: fixture.registry, home: fixture.home.path)
        XCTAssertTrue(reloaded.profiles().isEmpty)
        XCTAssertNil(reloaded.defaultProfileID(for: .claude))
    }

    func testNormalizationAndIdentityAreStableAndProviderScoped() {
        let dir = "/synthetic/home/.claude-work"
        let paths = [dir, dir + "/", "/synthetic/home/./.claude-work", "/synthetic/home/other/../.claude-work"]
        let ids = paths.map { ManagedCLIProfileStore.profileID(provider: .claude, configDir: $0) }
        XCTAssertEqual(Set(ids).count, 1)
        XCTAssertNotEqual(ids[0], ManagedCLIProfileStore.profileID(provider: .codex, configDir: dir))
        XCTAssertNotEqual(ids[0], ManagedCLIProfileStore.profileID(provider: .claude, configDir: "/synthetic/other/.claude-work"))
        XCTAssertEqual(ManagedCLIProfileStore.normalizedPath("~/work/../.claude", home: "/synthetic/home"), "/synthetic/home/.claude")
        XCTAssertEqual(ManagedCLIProfileStore.normalizedPath(""), "")
    }

    func testInvalidNamesPathsEmailsAndDefaultSelectionsDoNotMutateRegistry() throws {
        let fixture = try fixture()
        for name in ["", " \t ", "/", "..", "work/team", "work\\team", "line\nbreak", String(repeating: "x", count: 81)] {
            XCTAssertThrowsError(try fixture.store.create(provider: .claude, name: name), name)
        }
        for path in ["", "/", "~/", "relative/path", " /tmp/profile", "/tmp/profile\n"] {
            XCTAssertThrowsError(try fixture.store.importProfile(provider: .claude, path: path, name: "Work"), path)
        }
        for email in ["missing-at", "@domain.example", "user@", "user@example.com\nother@example.com", "first@@example.com"] {
            XCTAssertThrowsError(try fixture.store.create(provider: .codex, name: "Invalid email", expectedEmail: email), email)
        }
        XCTAssertThrowsError(try fixture.store.setDefault(profileID: "unknown", provider: .claude))
        XCTAssertTrue(fixture.store.profiles().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.registry.appendingPathComponent("accounts.json").path))
    }

    func testExistingPathIsNeverOverwrittenAndDefaultCannotCrossProviders() throws {
        let fixture = try fixture()
        let first = try fixture.store.create(provider: .codex, name: "Work")
        let config = URL(fileURLWithPath: first.configDir).appendingPathComponent("config.toml")
        let original = try Data(contentsOf: config)
        XCTAssertThrowsError(try fixture.store.create(provider: .codex, name: "Work"))
        XCTAssertEqual(try Data(contentsOf: config), original)
        XCTAssertEqual(fixture.store.profiles(), [first])
        XCTAssertThrowsError(try fixture.store.setDefault(profileID: first.id, provider: .claude))
        XCTAssertNil(fixture.store.defaultProfileID(for: .claude))
        var mismatched = first
        mismatched.id = "incorrect-identity"
        XCTAssertThrowsError(try fixture.store.save(mismatched))
        XCTAssertEqual(fixture.store.profiles(), [first])
    }

    func testMalformedRegistryIsReportedAndPreservedOnEveryMutation() throws {
        let fixture = try fixture()
        let registry = fixture.registry.appendingPathComponent("accounts.json")
        let malformed = Data("{\"accessToken\":\"synthetic-private-marker\",broken".utf8)
        try malformed.write(to: registry)
        let damaged = ManagedCLIProfileStore(directory: fixture.registry, home: fixture.home.path)
        XCTAssertNotNil(damaged.loadError)
        XCTAssertFalse(damaged.loadError?.contains("synthetic-private-marker") == true)
        XCTAssertTrue(damaged.profiles().isEmpty)
        XCTAssertThrowsError(try damaged.create(provider: .claude, name: "Work"))
        XCTAssertThrowsError(try damaged.save(ManagedCLIProfile(provider: .codex, name: "Work",
                                                               configDir: fixture.home.appendingPathComponent(".codex-work").path)))
        XCTAssertThrowsError(try damaged.setDefault(profileID: "unknown", provider: .claude))
        XCTAssertThrowsError(try damaged.setHidden(profileID: "unknown", hidden: true))
        XCTAssertThrowsError(try damaged.remove(profileID: "unknown"))
        XCTAssertEqual(try Data(contentsOf: registry), malformed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.home.appendingPathComponent(".claude-work").path))
    }

    func testUnreadableRegistryShapeIsNotReplaced() throws {
        let fixture = try fixture()
        let registry = fixture.registry.appendingPathComponent("accounts.json")
        try FileManager.default.createDirectory(at: registry, withIntermediateDirectories: false)
        let store = ManagedCLIProfileStore(directory: fixture.registry, home: fixture.home.path)
        XCTAssertNotNil(store.loadError)
        XCTAssertThrowsError(try store.remove(profileID: "anything"))
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: registry.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
    }

    func testHiddenProfilesPersistAndRemainTracked() throws {
        let fixture = try fixture()
        let profile = try fixture.store.create(provider: .claude, name: "Work")
        try fixture.store.setDefault(profileID: profile.id, provider: .claude)
        try fixture.store.setHidden(profileID: profile.id, hidden: true)
        let reloaded = ManagedCLIProfileStore(directory: fixture.registry, home: fixture.home.path)
        XCTAssertTrue(reloaded.profiles().first?.isHidden == true)
        XCTAssertEqual(reloaded.profilePaths(for: .claude), [profile.configDir])
        XCTAssertEqual(reloaded.defaultProfileID(for: .claude), profile.id)
        try reloaded.setHidden(profileID: profile.id, hidden: false)
        XCTAssertFalse(reloaded.profiles().first?.isHidden == true)
        XCTAssertThrowsError(try reloaded.setHidden(profileID: "unknown", hidden: true))
    }

    func testProfilesSavedBeforeVisibilitySettingDecodeAsVisible() throws {
        let fixture = try fixture()
        let profile = try fixture.store.create(provider: .codex, name: "Personal")
        let registryURL = fixture.registry.appendingPathComponent("accounts.json")
        var registry = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: registryURL)) as? [String: Any])
        var rows = try XCTUnwrap(registry["profiles"] as? [[String: Any]])
        rows[0].removeValue(forKey: "isHidden")
        registry["profiles"] = rows
        try JSONSerialization.data(withJSONObject: registry).write(to: registryURL)

        let reloaded = ManagedCLIProfileStore(directory: fixture.registry, home: fixture.home.path)
        XCTAssertNil(reloaded.loadError)
        XCTAssertEqual(reloaded.profiles(), [profile])
        XCTAssertFalse(try XCTUnwrap(reloaded.profiles().first).isHidden)
    }

    func testDefaultPersistenceLocationUsesInjectedHome() throws {
        let fixture = try fixture()
        let store = ManagedCLIProfileStore(home: fixture.home.path)
        let profile = try store.create(provider: .claude, name: "Personal")
        let registry = fixture.home.appendingPathComponent(".config/token-horizon/accounts.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: registry.path))
        XCTAssertEqual(try permissions(registry), 0o600)
        XCTAssertEqual(ManagedCLIProfileStore(home: fixture.home.path).profiles(), [profile])
    }

    func testImportRequiresDirectoryAndDoesNotCreateIt() throws {
        let fixture = try fixture()
        let missing = fixture.home.appendingPathComponent("missing")
        XCTAssertThrowsError(try fixture.store.importProfile(provider: .codex, path: missing.path, name: "Missing"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
        let file = fixture.home.appendingPathComponent("ordinary-file")
        try Data("keep".utf8).write(to: file)
        XCTAssertThrowsError(try fixture.store.importProfile(provider: .codex, path: file.path, name: "File"))
        XCTAssertEqual(try String(contentsOf: file), "keep")
    }

    func testPersistenceFailureRollsBackOnlyNewlyCreatedEmptyProfile() throws {
        let fixture = try fixture()
        try FileManager.default.removeItem(at: fixture.registry)
        try Data("keep".utf8).write(to: fixture.registry)
        for provider in CLIAccountProvider.allCases {
            XCTAssertThrowsError(try fixture.store.create(provider: provider, name: "Failed"))
            let path = fixture.home.appendingPathComponent("\(provider.defaultHomePrefix)-failed").path
            XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        }
        XCTAssertTrue(fixture.store.profiles().isEmpty)
        XCTAssertEqual(try String(contentsOf: fixture.registry), "keep")
    }
}
