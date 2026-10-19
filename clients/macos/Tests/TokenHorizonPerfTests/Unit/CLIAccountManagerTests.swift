import Combine
import XCTest
@testable import TokenHorizon

/// Controller coverage uses private stores, injected account metadata and an
/// in-memory Ghostty runner. No provider discovery, CLI or Apple Event runs.
final class CLIAccountManagerTests: XCTestCase {
    private struct Fixture {
        let root: URL
        let home: URL
        let sessionDirectory: URL
        let profiles: ManagedCLIProfileStore
        let sessions: ManagedTerminalSessionStore
    }

    private func fixture() throws -> Fixture {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-cli-manager-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let sessionDirectory = root.appendingPathComponent("terminal-labels", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: sessionDirectory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return Fixture(root: root, home: home, sessionDirectory: sessionDirectory,
                       profiles: ManagedCLIProfileStore(directory: root.appendingPathComponent("profiles"), home: home.path),
                       sessions: ManagedTerminalSessionStore(directory: sessionDirectory, home: home.path))
    }

    private func account(_ profile: ManagedCLIProfile, email: String = "same@example.com",
                         exists: Bool = true) -> CLIAccountRow {
        CLIAccountRow(profile: profile, email: email, plan: "Pro", status: nil,
                      limits: [], isDefault: false, directoryExists: exists)
    }

    private func manager(_ fixture: Fixture, rows: [CLIAccountRow], runner: ManagerGhosttyRunner) -> CLIAccountManager {
        let ghostty = GhosttyAutomation(runner: runner,
                                       applicationURL: { URL(fileURLWithPath: "/synthetic/Ghostty.app") },
                                       isRunning: { true })
        return CLIAccountManager(profileStore: fixture.profiles, sessionStore: fixture.sessions,
                                 ghostty: ghostty, accountReader: { rows })
    }

    func testDefaultSelectionSkipsHiddenMissingAndMismatchedAccountsAndPrefersSavedDefault() throws {
        let fixture = try fixture()
        var hidden = try fixture.profiles.create(provider: .claude, name: "Hidden")
        hidden.isHidden = true
        let missing = try fixture.profiles.create(provider: .claude, name: "Missing")
        let mismatched = try fixture.profiles.create(provider: .claude, name: "Mismatch", expectedEmail: "expected@example.com")
        let first = try fixture.profiles.create(provider: .claude, name: "First ready")
        let preferred = try fixture.profiles.create(provider: .claude, name: "Preferred")
        let otherProvider = try fixture.profiles.create(provider: .codex, name: "Codex")
        let rows = [account(hidden), account(missing, exists: false),
                    account(mismatched, email: "different@example.com"), account(first),
                    account(preferred), account(otherProvider)]
        let runner = ManagerGhosttyRunner()
        let manager = manager(fixture, rows: rows, runner: runner)

        try fixture.profiles.setDefault(profileID: preferred.id, provider: .claude)
        XCTAssertEqual(manager.defaultProfile(for: .claude)?.id, preferred.id)
        for unavailableDefault in [hidden, missing, mismatched] {
            try fixture.profiles.setDefault(profileID: unavailableDefault.id, provider: .claude)
            XCTAssertNil(manager.defaultProfile(for: .claude), "An unavailable default must not silently switch accounts")
            manager.launchDefault(.claude)
            XCTAssertTrue(manager.errorMessage?.contains("default Claude Code profile is unavailable") == true)
        }
        XCTAssertEqual(manager.defaultProfile(for: .claude, action: .signIn)?.id, mismatched.id)
        XCTAssertEqual(manager.defaultProfile(for: .codex)?.id, otherProvider.id)
        XCTAssertEqual(runner.callCount, 0)
    }

    func testNoEligibleDefaultExplainsHowToReconnectWithoutAppleEvents() throws {
        let fixture = try fixture()
        var hidden = try fixture.profiles.create(provider: .claude, name: "Hidden")
        hidden.isHidden = true
        let runner = ManagerGhosttyRunner()
        let manager = manager(fixture, rows: [account(hidden)], runner: runner)

        XCTAssertNil(manager.defaultProfile(for: .claude))
        manager.launchDefault(.claude)
        XCTAssertTrue(manager.errorMessage?.contains("No Claude Code profile is ready") == true)
        XCTAssertEqual(runner.callCount, 0)
    }

    func testMismatchedAgentLaunchStopsBeforeAnyAppleEvent() throws {
        let fixture = try fixture()
        let profile = try fixture.profiles.create(provider: .claude, name: "Dorja", expectedEmail: "expected@example.com")
        let runner = ManagerGhosttyRunner()
        let manager = manager(fixture, rows: [account(profile, email: "different@example.com")], runner: runner)
        let completed = expectation(description: "Mismatched launch rejected")
        let observation = manager.$launchingProfileID.dropFirst().filter { $0 == nil }.sink { _ in completed.fulfill() }
        defer { observation.cancel() }

        manager.launch(profile)
        wait(for: [completed], timeout: 3)

        XCTAssertTrue(manager.errorMessage?.contains("different@example.com") == true)
        XCTAssertTrue(manager.errorMessage?.contains("expected@example.com") == true)
        XCTAssertEqual(runner.callCount, 0)
        XCTAssertTrue(fixture.sessions.sessions().isEmpty)
    }

    func testTwoLaunchesSerializeWithInventoryAndKeepBothProfileAssociations() throws {
        let fixture = try fixture()
        let first = try fixture.profiles.create(provider: .codex, name: "Personal")
        let second = try fixture.profiles.create(provider: .codex, name: "Work")
        let runner = ManagerGhosttyRunner()
        let gate = InventoryGate()
        let firstInventory = expectation(description: "First launch inventory is waiting")
        let prematureSecondLaunch = expectation(description: "Second launch must wait for inventory")
        prematureSecondLaunch.isInverted = true
        runner.onInventory = { _, count in
            if count == 1 {
                firstInventory.fulfill()
                guard gate.semaphore.wait(timeout: .now() + 3) == .success else {
                    throw GhosttyError.timedOut
                }
            }
        }
        runner.onLaunch = { count in
            if count == 2 && !gate.isReleased { prematureSecondLaunch.fulfill() }
        }
        defer { gate.release() }
        let manager = manager(fixture, rows: [account(first), account(second)], runner: runner)
        let inventoriesCompleted = expectation(description: "Both launches finish their terminal refresh")
        inventoriesCompleted.expectedFulfillmentCount = 2
        let observation = manager.$isRefreshingTerminals.dropFirst().filter { !$0 }.sink { _ in
            inventoriesCompleted.fulfill()
        }
        defer { observation.cancel() }

        manager.launch(first)
        wait(for: [firstInventory], timeout: 3)
        XCTAssertNil(manager.launchingProfileID)
        manager.launch(second)
        wait(for: [prematureSecondLaunch], timeout: 0.1)
        gate.release()
        wait(for: [inventoriesCompleted], timeout: 3)

        XCTAssertEqual(runner.launchCount, 2)
        XCTAssertEqual(manager.terminals.count, 2)
        XCTAssertEqual(Set(manager.sessions.map(\.profileID)), [first.id, second.id])
        XCTAssertEqual(Set(fixture.sessions.sessions().map(\.profileID)), [first.id, second.id])
        let reloaded = ManagedTerminalSessionStore(directory: fixture.sessionDirectory, home: fixture.home.path)
        XCTAssertEqual(Set(reloaded.sessions().map(\.profileID)), [first.id, second.id])
        XCTAssertNil(manager.errorMessage)
    }

    func testLaunchPersistenceWarningSurvivesSuccessfulTerminalRefresh() throws {
        let fixture = try fixture()
        let profile = try fixture.profiles.create(provider: .codex, name: "Personal")
        let runner = ManagerGhosttyRunner()
        let manager = manager(fixture, rows: [account(profile)], runner: runner)
        // The store loaded successfully, then its directory became a file.
        // Remember fails while reconciling an empty in-memory list stays safe.
        try FileManager.default.removeItem(at: fixture.sessionDirectory)
        try Data("synthetic filesystem obstruction".utf8).write(to: fixture.sessionDirectory)
        let refreshed = expectation(description: "Successful inventory after failed label save")
        let observation = manager.$isRefreshingTerminals.dropFirst().filter { !$0 }.sink { _ in refreshed.fulfill() }
        defer { observation.cancel() }

        manager.launch(profile)
        wait(for: [refreshed], timeout: 3)

        XCTAssertEqual(runner.launchCount, 1)
        XCTAssertEqual(manager.terminals.count, 1)
        XCTAssertTrue(manager.sessions.isEmpty)
        XCTAssertEqual(manager.errorMessage, "The window opened, but its account label could not be saved.")
        XCTAssertTrue(manager.notice?.contains("Opened Personal") == true)
    }
}

private final class InventoryGate {
    let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var released = false

    var isReleased: Bool {
        lock.lock(); defer { lock.unlock() }
        return released
    }

    func release() {
        lock.lock()
        released = true
        lock.unlock()
        semaphore.signal()
    }
}

private final class ManagerGhosttyRunner: GhosttyScriptRunning {
    var onInventory: (([GhosttyTerminal], Int) throws -> Void)?
    var onLaunch: ((Int) -> Void)?
    private let lock = NSLock()
    private var calls = 0
    private var launches = 0
    private var inventories = 0
    private var terminals: [GhosttyTerminal] = []

    var callCount: Int {
        lock.lock(); defer { lock.unlock() }
        return calls
    }

    var launchCount: Int {
        lock.lock(); defer { lock.unlock() }
        return launches
    }

    func run(script: String, arguments: [String]) throws -> String {
        lock.lock()
        calls += 1
        if script == GhosttyScriptPlan.launchScript {
            guard arguments.count >= 5 else { lock.unlock(); throw GhosttyError.invalidRequest("Missing synthetic arguments") }
            launches += 1
            let count = launches
            let terminal = GhosttyTerminal(id: UUID().uuidString, windowID: "window-\(count)", tabID: "tab-\(count)",
                                           title: arguments[3], workingDirectory: arguments[1], windowTitle: "Synthetic",
                                           tabTitle: arguments[3], isSelected: true)
            terminals.append(terminal)
            lock.unlock()
            onLaunch?(count)
            let session = GhosttySession(windowID: terminal.windowID, tabID: terminal.tabID, terminalID: terminal.id)
            return String(decoding: try JSONEncoder().encode(session), as: UTF8.self)
        }
        if script == GhosttyScriptPlan.inventoryScript {
            inventories += 1
            let count = inventories
            let snapshot = terminals
            lock.unlock()
            try onInventory?(snapshot, count)
            return String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)
        }
        lock.unlock()
        throw GhosttyError.invalidRequest("Unexpected synthetic Ghostty program")
    }
}
