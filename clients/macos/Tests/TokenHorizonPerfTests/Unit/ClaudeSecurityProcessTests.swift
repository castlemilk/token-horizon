import XCTest
import Darwin
@testable import TokenHorizon

final class ClaudeSecurityProcessTests: XCTestCase {
    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("th claude ' capture \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    private func process(_ executable: String = "/bin/sh", arguments: [String]) -> Process {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: executable)
        task.arguments = arguments
        return task
    }

    private func assertClean(_ directory: URL, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [], file: file, line: line)
    }

    func testLargeStdoutAndStderrDoNotDeadlockOrMixCredentials() throws {
        let directory = try temporaryDirectory()
        let secret = String(repeating: "fixture-secret-", count: 128)
        let diagnostic = String(repeating: "private-diagnostic-", count: 128)
        let script = """
        count=0
        while [ "$count" -lt 512 ]; do
          printf '%s' "$1"
          printf '%s' "$2" >&2
          count=$((count+1))
        done
        """
        let task = process(arguments: ["-c", script, "capture-fixture", secret, diagnostic])
        let output = try XCTUnwrap(ClaudeSecurityProcess.runCapture(task, timeout: 5, temporaryDirectory: directory))
        XCTAssertEqual(output, Data(String(repeating: secret, count: 512).utf8))
        XCTAssertFalse(task.isRunning)
        XCTAssertEqual(task.terminationStatus, 0)
        try assertClean(directory)
    }

    func testCaptureDirectoryAndBothOutputFilesArePrivateAndRemoved() throws {
        let directory = try temporaryDirectory()
        let script = """
        for capture in "$1"/token-horizon-claude-security.*; do
          /usr/bin/stat -f '%Lp' "$capture" "$capture/stdout" "$capture/stderr"
        done
        """
        let task = process(arguments: ["-c", script, "permissions-fixture", directory.path])
        let output = try XCTUnwrap(ClaudeSecurityProcess.runCapture(task, timeout: 5, temporaryDirectory: directory))
        XCTAssertEqual(String(data: output, encoding: .utf8), "700\n600\n600\n")
        try assertClean(directory)
    }

    func testSuccessfulEmptyOutputStillSignalsSuccessfulWrite() throws {
        let directory = try temporaryDirectory()
        let task = process(arguments: ["-c", "printf 'private write diagnostic' >&2; exit 0"])
        XCTAssertEqual(ClaudeSecurityProcess.runCapture(task, timeout: 5, temporaryDirectory: directory), Data())
        XCTAssertEqual(task.terminationStatus, 0)
        try assertClean(directory)
    }

    func testFailedExitDiscardsSecretOutputAndCleansFiles() throws {
        let directory = try temporaryDirectory()
        let task = process(arguments: ["-c", "printf 'fixture secret'; printf 'private failure' >&2; exit 7"])
        XCTAssertNil(ClaudeSecurityProcess.runCapture(task, timeout: 5, temporaryDirectory: directory))
        XCTAssertEqual(task.terminationStatus, 7)
        XCTAssertFalse(task.isRunning)
        try assertClean(directory)
    }

    func testExcessiveOutputIsRejectedWithoutLeavingCredentialFiles() throws {
        let directory = try temporaryDirectory()
        let script = """
        count=0
        while [ "$count" -lt 4097 ]; do
          printf '%s' "$1"
          count=$((count+1))
        done
        """
        let task = process(arguments: ["-c", script, "oversized-fixture", String(repeating: "x", count: 1024)])
        XCTAssertNil(ClaudeSecurityProcess.runCapture(task, timeout: 5, temporaryDirectory: directory))
        XCTAssertEqual(task.terminationStatus, 0)
        XCTAssertFalse(task.isRunning)
        try assertClean(directory)
    }

    func testFailedLaunchCleansPrivateFiles() throws {
        let directory = try temporaryDirectory()
        let task = process(directory.appendingPathComponent("missing-executable").path, arguments: [])
        XCTAssertNil(ClaudeSecurityProcess.runCapture(task, timeout: 1, temporaryDirectory: directory))
        XCTAssertFalse(task.isRunning)
        try assertClean(directory)
    }

    func testDeadlineTerminatesOnlyTheOwnedChildAndCleansFiles() throws {
        let directory = try temporaryDirectory()
        let companion = process("/bin/sleep", arguments: ["5"])
        companion.standardOutput = FileHandle.nullDevice
        companion.standardError = FileHandle.nullDevice
        try companion.run()
        defer {
            if companion.isRunning { companion.terminate() }
            companion.waitUntilExit()
        }
        let task = process("/bin/sleep", arguments: ["5"])
        let started = ProcessInfo.processInfo.systemUptime
        XCTAssertNil(ClaudeSecurityProcess.runCapture(task, timeout: 0.05, temporaryDirectory: directory))
        XCTAssertFalse(task.isRunning)
        XCTAssertTrue(companion.isRunning, "A timeout must not terminate another process")
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 2)
        try assertClean(directory)
    }

    func testDeadlineKillsAnOwnedChildThatIgnoresTermination() throws {
        let directory = try temporaryDirectory()
        let task = process(arguments: ["-c", "trap '' TERM; exec /bin/sleep 5"])
        let started = ProcessInfo.processInfo.systemUptime
        XCTAssertNil(ClaudeSecurityProcess.runCapture(task, timeout: 0.5, temporaryDirectory: directory))
        XCTAssertFalse(task.isRunning)
        XCTAssertEqual(task.terminationReason, .uncaughtSignal)
        XCTAssertEqual(task.terminationStatus, SIGKILL)
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 2)
        try assertClean(directory)
    }

    func testInvalidDeadlineDoesNotLaunchOrCreateCaptureFiles() throws {
        let directory = try temporaryDirectory()
        for timeout in [0, -1, TimeInterval.infinity, TimeInterval.nan] {
            let task = process("/bin/sleep", arguments: ["5"])
            XCTAssertNil(ClaudeSecurityProcess.runCapture(task, timeout: timeout, temporaryDirectory: directory))
            XCTAssertFalse(task.isRunning)
            try assertClean(directory)
        }
    }
}
