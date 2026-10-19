import XCTest
@testable import TokenHorizon

final class ManagedTerminalSessionTests: XCTestCase {
    private struct Fixture {
        let home: URL
        let directory: URL
        let store: ManagedTerminalSessionStore
        var file: URL { directory.appendingPathComponent("terminal-sessions.json") }
    }

    private func fixture() throws -> Fixture {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-terminal-session-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let directory = root.appendingPathComponent("settings", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return Fixture(home: home, directory: directory,
                       store: ManagedTerminalSessionStore(directory: directory, home: home.path))
    }

    private func session(_ index: Int, home: URL, action: CLIProfileLaunchAction = .agent,
                         project: String = "project") -> ManagedTerminalSession {
        let terminalID = String(format: "00000000-0000-0000-0000-%012x", index)
        let profileID = ManagedCLIProfileStore.profileID(
            provider: index.isMultiple(of: 2) ? .claude : .codex,
            configDir: home.appendingPathComponent("profile-\(index)").path)
        return ManagedTerminalSession(
            terminal: GhosttySession(windowID: "window-\(index)", tabID: "tab-\(index)", terminalID: terminalID),
            profileID: profileID, action: action, workingDirectory: home.appendingPathComponent(project).path,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000 + Double(index)))
    }

    func testRememberReloadKeepsExactProfileAssociationAndLastProject() throws {
        let fixture = try fixture()
        XCTAssertNil(fixture.store.loadError)
        XCTAssertTrue(fixture.store.sessions().isEmpty)
        XCTAssertEqual(fixture.store.workingDirectory(), fixture.home.path)
        let first = session(1, home: fixture.home, action: .signIn, project: "dorja")
        let second = session(2, home: fixture.home, action: .shell, project: "personal")
        try fixture.store.remember(first)
        try fixture.store.remember(second)

        let reloaded = ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path)
        XCTAssertNil(reloaded.loadError)
        XCTAssertEqual(reloaded.sessions(), [second, first])
        XCTAssertEqual(reloaded.workingDirectory(), second.workingDirectory)
        XCTAssertEqual(reloaded.sessions().first { $0.id == first.id }?.profileID, first.profileID)
        XCTAssertEqual(reloaded.sessions().first { $0.id == second.id }?.profileID, second.profileID)
        XCTAssertNotEqual(first.profileID, second.profileID)

        let lastProject = fixture.home.appendingPathComponent("next-project").path
        try reloaded.setWorkingDirectory(lastProject)
        let reopened = ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path)
        XCTAssertEqual(reopened.workingDirectory(), lastProject)
        XCTAssertEqual(reopened.sessions(), [second, first], "Choosing a project must not rewrite existing terminal associations")
    }

    func testDuplicateTerminalIDReplacesAssociationAndMovesToFront() throws {
        let fixture = try fixture()
        let first = session(1, home: fixture.home)
        let second = session(2, home: fixture.home)
        try fixture.store.remember(first)
        try fixture.store.remember(second)
        var updated = session(3, home: fixture.home, action: .signOut, project: "replacement-project")
        updated.terminal = first.terminal
        try fixture.store.remember(updated)

        XCTAssertEqual(fixture.store.sessions(), [updated, second])
        XCTAssertEqual(fixture.store.sessions().filter { $0.id == first.id }.count, 1)
        XCTAssertEqual(fixture.store.workingDirectory(), updated.workingDirectory)
        XCTAssertEqual(ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path).sessions(), [updated, second])
    }

    func testRememberRetainsOnlyNewest256Surfaces() throws {
        let fixture = try fixture()
        for index in 0..<260 {
            try fixture.store.remember(session(index, home: fixture.home))
        }
        let rows = fixture.store.sessions()
        XCTAssertEqual(rows.count, 256)
        XCTAssertEqual(rows.first?.id, session(259, home: fixture.home).id)
        XCTAssertEqual(rows.last?.id, session(4, home: fixture.home).id)
        XCTAssertEqual(Set(rows.map(\.id)).count, 256)
        XCTAssertFalse(rows.contains { $0.id == session(3, home: fixture.home).id })
        XCTAssertEqual(ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path).sessions(), rows)
    }

    func testSuccessfulInventoryReconcilesExactTerminalIDsOnly() throws {
        let fixture = try fixture()
        let first = session(1, home: fixture.home, project: "first-project")
        let second = session(2, home: fixture.home, project: "second-project")
        let third = session(3, home: fixture.home, project: "third-project")
        for row in [first, second, third] { try fixture.store.remember(row) }
        // A live window/tab/profile ID cannot stand in for a terminal ID.
        XCTAssertThrowsError(try fixture.store.reconcile(terminalIDs: [first.id, third.id, second.terminal.windowID,
                                                                      second.terminal.tabID, second.profileID]))
        XCTAssertEqual(fixture.store.sessions(), [third, second, first], "An invalid inventory must not prune labels")
        try fixture.store.reconcile(terminalIDs: [first.id, third.id])
        XCTAssertEqual(fixture.store.sessions(), [third, first])
        XCTAssertEqual(fixture.store.workingDirectory(), third.workingDirectory)
        let reloaded = ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path)
        XCTAssertEqual(reloaded.sessions(), [third, first])

        let originalBytes = try Data(contentsOf: fixture.file)
        try reloaded.reconcile(terminalIDs: [first.id, third.id])
        XCTAssertEqual(try Data(contentsOf: fixture.file), originalBytes, "Unchanged successful inventories must not rewrite labels")
        try reloaded.reconcile(terminalIDs: [])
        XCTAssertTrue(reloaded.sessions().isEmpty, "A successful empty inventory clears closed surfaces")
        XCTAssertEqual(reloaded.workingDirectory(), third.workingDirectory)
    }

    func testPersistenceIsPrivateAndContainsOnlyAssociationMetadata() throws {
        let fixture = try fixture()
        let row = session(1, home: fixture.home, action: .signIn)
        try fixture.store.remember(row)
        let attributes = try FileManager.default.attributesOfItem(atPath: fixture.file.path)
        let permissions = try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue & 0o777
        XCTAssertEqual(permissions, 0o600)
        let data = try Data(contentsOf: fixture.file)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rows = try XCTUnwrap(json["sessions"] as? [[String: Any]])
        let persisted = try XCTUnwrap(rows.first)
        XCTAssertEqual(persisted["profileID"] as? String, row.profileID)
        XCTAssertEqual(Set(persisted.keys), ["terminal", "profileID", "action", "workingDirectory", "createdAt"])
        let terminal = try XCTUnwrap(persisted["terminal"] as? [String: String])
        XCTAssertEqual(Set(terminal.keys), ["windowID", "tabID", "terminalID"])
        let text = try XCTUnwrap(String(data: data, encoding: .utf8))
        for forbidden in ["accessToken", "refreshToken", "Authorization", "auth.json", ".credentials.json", "command", "output"] {
            XCTAssertFalse(text.contains(forbidden), forbidden)
        }
    }

    func testCorruptRegistryRefusesMutationsAndPreservesOriginalBytes() throws {
        let fixture = try fixture()
        let corrupt = Data("{\"privateMarker\":\"synthetic-secret-marker\",broken".utf8)
        try corrupt.write(to: fixture.file)
        let damaged = ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path)
        XCTAssertNotNil(damaged.loadError)
        XCTAssertFalse(damaged.loadError?.contains("synthetic-secret-marker") == true)
        XCTAssertTrue(damaged.sessions().isEmpty)
        XCTAssertEqual(damaged.workingDirectory(), fixture.home.path)
        XCTAssertThrowsError(try damaged.remember(session(1, home: fixture.home)))
        XCTAssertThrowsError(try damaged.setWorkingDirectory(fixture.home.appendingPathComponent("new-project").path))
        XCTAssertThrowsError(try damaged.reconcile(terminalIDs: []))
        XCTAssertEqual(try Data(contentsOf: fixture.file), corrupt)
        XCTAssertTrue(damaged.sessions().isEmpty)
    }

    func testUnsupportedVersionLeavesSafeEmptyStateAndPreservesBytes() throws {
        let fixture = try fixture()
        try fixture.store.remember(session(1, home: fixture.home, project: "old-format-project"))
        let original = try Data(contentsOf: fixture.file)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: original) as? [String: Any])
        object["version"] = 99
        let unsupported = try JSONSerialization.data(withJSONObject: object)
        try unsupported.write(to: fixture.file)

        let store = ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path)
        XCTAssertNotNil(store.loadError)
        XCTAssertTrue(store.sessions().isEmpty)
        XCTAssertEqual(store.workingDirectory(), fixture.home.path)
        XCTAssertThrowsError(try store.remember(session(2, home: fixture.home)))
        XCTAssertThrowsError(try store.setWorkingDirectory(fixture.home.path))
        XCTAssertEqual(try Data(contentsOf: fixture.file), unsupported)
    }

    func testDefaultStorageLocationUsesInjectedHome() throws {
        let fixture = try fixture()
        let store = ManagedTerminalSessionStore(home: fixture.home.path)
        let row = session(1, home: fixture.home)
        try store.remember(row)
        let expected = fixture.home.appendingPathComponent(".config/token-horizon/terminal-sessions.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: expected.path))
        XCTAssertEqual(ManagedTerminalSessionStore(home: fixture.home.path).sessions(), [row])
    }

    func testInvalidMetadataCannotReplaceExistingLabelsOrProjectPreference() throws {
        let fixture = try fixture()
        let valid = session(1, home: fixture.home)
        try fixture.store.remember(valid)
        let original = try Data(contentsOf: fixture.file)
        var invalidTerminal = valid
        invalidTerminal.terminal = GhosttySession(windowID: "window", tabID: "tab", terminalID: "not-a-uuid")
        var invalidWindow = valid
        invalidWindow.terminal = GhosttySession(windowID: "", tabID: "tab", terminalID: valid.id)
        var invalidTab = valid
        invalidTab.terminal = GhosttySession(windowID: "window", tabID: String(repeating: "x", count: 257), terminalID: valid.id)
        var invalidProfile = valid
        invalidProfile.profileID = "unscoped-name"
        var newlineProfile = valid
        newlineProfile.profileID += "\n"
        var invalidDate = valid
        invalidDate.createdAt = Date(timeIntervalSinceReferenceDate: .nan)
        var invalidProject = valid
        invalidProject.workingDirectory = "relative/project"
        for row in [invalidTerminal, invalidWindow, invalidTab, invalidProfile, newlineProfile, invalidDate, invalidProject] {
            XCTAssertThrowsError(try fixture.store.remember(row))
            XCTAssertEqual(fixture.store.sessions(), [valid])
            XCTAssertEqual(try Data(contentsOf: fixture.file), original)
        }
        for directory in ["", "relative/project", " /tmp/project", "/tmp/line\nbreak", "/tmp/line\u{2028}break", "/" + String(repeating: "x", count: 4096)] {
            XCTAssertThrowsError(try fixture.store.setWorkingDirectory(directory))
            XCTAssertEqual(fixture.store.workingDirectory(), valid.workingDirectory)
            XCTAssertEqual(try Data(contentsOf: fixture.file), original)
        }
    }

    func testInvalidPersistedMetadataLeavesSafeEmptyState() throws {
        let fixture = try fixture()
        let valid = session(1, home: fixture.home)
        let encoded = try JSONEncoder().encode(valid)
        let originalRow = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        var invalidProfile = originalRow
        invalidProfile["profileID"] = "copied-token-is-not-a-profile-id"
        var invalidProject = originalRow
        invalidProject["workingDirectory"] = "relative/project"
        let cases: [[String: Any]] = [
            ["version": 1, "workingDirectory": "relative", "sessions": []],
            ["version": 1, "workingDirectory": fixture.home.path, "sessions": [invalidProfile]],
            ["version": 1, "workingDirectory": fixture.home.path, "sessions": [invalidProject]],
            ["version": 1, "workingDirectory": fixture.home.path, "sessions": [originalRow, originalRow]]
        ]
        for object in cases {
            let bytes = try JSONSerialization.data(withJSONObject: object)
            try bytes.write(to: fixture.file)
            let store = ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path)
            XCTAssertNotNil(store.loadError)
            XCTAssertTrue(store.sessions().isEmpty)
            XCTAssertEqual(store.workingDirectory(), fixture.home.path)
            XCTAssertThrowsError(try store.remember(valid))
            XCTAssertEqual(try Data(contentsOf: fixture.file), bytes)
        }
    }

    func testPersistedSessionAndFileBoundsAreEnforcedBeforePublishingState() throws {
        let fixture = try fixture()
        let rows = try (0..<257).map { index in
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(session(index, home: fixture.home)))
        }
        let bytes = try JSONSerialization.data(withJSONObject: [
            "version": 1, "workingDirectory": fixture.home.path, "sessions": rows
        ])
        try bytes.write(to: fixture.file)
        let tooMany = ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path)
        XCTAssertNotNil(tooMany.loadError)
        XCTAssertTrue(tooMany.sessions().isEmpty)
        XCTAssertThrowsError(try tooMany.setWorkingDirectory(fixture.home.path))
        XCTAssertEqual(try Data(contentsOf: fixture.file), bytes)

        let oversized = Data(repeating: 0x20, count: 2 * 1024 * 1024 + 1)
        try oversized.write(to: fixture.file)
        let tooLarge = ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path)
        XCTAssertNotNil(tooLarge.loadError)
        XCTAssertTrue(tooLarge.sessions().isEmpty)
        XCTAssertThrowsError(try tooLarge.remember(session(1, home: fixture.home)))
        XCTAssertEqual(try Data(contentsOf: fixture.file), oversized)
    }

    func testSymlinkStoreIsRejectedWithoutChangingLinkOrTarget() throws {
        let fixture = try fixture()
        let target = fixture.home.appendingPathComponent("unrelated.json")
        let bytes = Data("unrelated data".utf8)
        try bytes.write(to: target)
        try FileManager.default.createSymbolicLink(at: fixture.file, withDestinationURL: target)
        let linked = ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path)
        XCTAssertNotNil(linked.loadError)
        XCTAssertTrue(linked.sessions().isEmpty)
        XCTAssertThrowsError(try linked.remember(session(1, home: fixture.home)))
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: fixture.file.path), target.path)
        XCTAssertEqual(try Data(contentsOf: target), bytes)

        try FileManager.default.removeItem(at: target)
        let dangling = ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path)
        XCTAssertNotNil(dangling.loadError)
        XCTAssertThrowsError(try dangling.setWorkingDirectory(fixture.home.path))
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: fixture.file.path), target.path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }

    func testNonregularStoreAndReplacementAfterLoadCannotBeOverwritten() throws {
        let fixture = try fixture()
        try FileManager.default.createDirectory(at: fixture.file, withIntermediateDirectories: false)
        let directoryStore = ManagedTerminalSessionStore(directory: fixture.directory, home: fixture.home.path)
        XCTAssertNotNil(directoryStore.loadError)
        XCTAssertThrowsError(try directoryStore.remember(session(1, home: fixture.home)))
        // The original store was loaded before the destination became a directory.
        XCTAssertThrowsError(try fixture.store.remember(session(2, home: fixture.home)))
        XCTAssertTrue(fixture.store.sessions().isEmpty)
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.file.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
    }
}
