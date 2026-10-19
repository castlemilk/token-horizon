import XCTest
@testable import TokenHorizon

final class GhosttyAutomationTests: XCTestCase {
    private let terminalID = "550E8400-E29B-41D4-A716-446655440000"

    func testStoppedInventoryDoesNotStartGhosttyOrRequestAutomation() throws {
        let runner = RecordingGhosttyRunner()
        let ghostty = makeGhostty(runner: runner, running: false)
        XCTAssertEqual(try ghostty.inventory(), [])
        XCTAssertTrue(runner.calls.isEmpty)
    }

    func testMissingInstallationReturnsActionableErrorWithoutAutomation() {
        let runner = RecordingGhosttyRunner()
        let ghostty = GhosttyAutomation(runner: runner, applicationURL: { nil }, isRunning: { false })
        XCTAssertThrowsError(try ghostty.inventory()) { XCTAssertEqual($0 as? GhosttyError, .notInstalled) }
        XCTAssertThrowsError(try ghostty.launch(validRequest())) { XCTAssertEqual($0 as? GhosttyError, .notInstalled) }
        XCTAssertTrue(runner.calls.isEmpty)
    }

    func testInventoryPreservesWindowTabAndUnicodeDirectoryMetadata() throws {
        let runner = RecordingGhosttyRunner()
        runner.output = """
        [{"id":"\(terminalID)","windowID":"window-1","tabID":"tab-2",\
        "title":"Claude \\"quoted\\"\\nDorja","workingDirectory":"/Users/test/Équipe",\
        "windowTitle":"Work","tabTitle":"Dorja","isSelected":true}]
        """
        let terminals = try makeGhostty(runner: runner).inventory()
        XCTAssertEqual(terminals.count, 1)
        XCTAssertEqual(terminals[0].title, "Claude \"quoted\"\nDorja")
        XCTAssertEqual(terminals[0].workingDirectory, "/Users/test/Équipe")
        XCTAssertEqual(terminals[0].windowID, "window-1")
        XCTAssertEqual(terminals[0].tabID, "tab-2")
        XCTAssertTrue(terminals[0].isSelected)
        XCTAssertEqual(runner.calls.count, 1)
        XCTAssertEqual(runner.calls[0].script, GhosttyScriptPlan.inventoryScript)
        XCTAssertEqual(runner.calls[0].arguments, [])
    }

    func testMalformedAndAmbiguousInventoryResponsesAreRejected() throws {
        let terminal = GhosttyTerminal(id: terminalID, windowID: "window", tabID: "tab", title: "shell",
                                      workingDirectory: "/tmp", windowTitle: "", tabTitle: "", isSelected: false)
        let duplicated = String(decoding: try JSONEncoder().encode([terminal, terminal]), as: UTF8.self)
        for value in ["", "missing value", "{}", "[{\"id\":\"bad\"}]", duplicated] {
            XCTAssertThrowsError(try GhosttyScriptPlan.parseInventory(value), value) {
                XCTAssertEqual($0 as? GhosttyError, .invalidResponse)
            }
        }
    }

    func testFocusUsesStableIDAndNeverPastesIntoShell() throws {
        let runner = RecordingGhosttyRunner()
        try makeGhostty(runner: runner).focus(terminalID: terminalID)
        XCTAssertEqual(runner.calls.count, 1)
        XCTAssertEqual(runner.calls[0].arguments, [terminalID])
        XCTAssertTrue(runner.calls[0].script.contains("focus terminal id terminalID"))
        for prohibited in ["input text", "send key", "close", "new window", "new tab"] {
            XCTAssertFalse(runner.calls[0].script.contains(prohibited))
        }
    }

    func testFocusRejectsStaleInvalidOrStoppedTargetsWithoutEvents() {
        let runner = RecordingGhosttyRunner()
        XCTAssertThrowsError(try makeGhostty(runner: runner).focus(terminalID: "\" & do shell script \"bad")) {
            guard let error = $0 as? GhosttyError, case .invalidRequest = error else {
                return XCTFail("Expected invalid target")
            }
        }
        XCTAssertThrowsError(try makeGhostty(runner: runner, running: false).focus(terminalID: terminalID)) {
            XCTAssertEqual($0 as? GhosttyError, .notRunning)
        }
        XCTAssertTrue(runner.calls.isEmpty)
    }

    func testLaunchDefaultsToNewWindowAndReturnsAllStableIDs() throws {
        let runner = RecordingGhosttyRunner()
        runner.output = sessionJSON
        let session = try makeGhostty(runner: runner, running: false).launch(validRequest())
        XCTAssertEqual(session, GhosttySession(windowID: "window-1", tabID: "tab-1", terminalID: terminalID))
        XCTAssertEqual(runner.calls.count, 1)
        XCTAssertEqual(runner.calls[0].arguments[0], "window")
        XCTAssertEqual(runner.calls[0].arguments[1], "/Users/test/projects")
        XCTAssertTrue(runner.calls[0].arguments.contains("CLAUDE_CONFIG_DIR=/Users/test/.claude-2"))
        XCTAssertTrue(runner.calls[0].script.contains("activate window win"))
        XCTAssertFalse(runner.calls[0].script.contains("input text"))
        XCTAssertFalse(runner.calls[0].script.contains("send key"))
        XCTAssertFalse(runner.calls[0].script.contains("initial input"))
    }

    func testOptionalTabDestinationCreatesOnlyANewSurface() throws {
        var request = validRequest()
        request.destination = .tab
        let plan = try GhosttyScriptPlan.launch(request)
        XCTAssertEqual(plan.arguments[0], "tab")
        XCTAssertTrue(plan.script.contains("new tab in win with configuration cfg"))
        XCTAssertTrue(plan.script.contains("new window with configuration cfg"))
        XCTAssertFalse(plan.script.contains("input text"))
    }

    func testLaunchKeepsUntrustedPathsAndTitlesOutOfScriptSource() throws {
        var request = validRequest()
        request.executable = "/Users/test/CLI tools/claude"
        request.workingDirectory = "/Users/test/A \"project\"; $(touch bad)"
        request.title = "Dorja \"; do shell script \"bad"
        request.arguments = ["argument with spaces", "$(touch bad)", "quote'and\\slash"]
        request.environment = ["CLAUDE_CONFIG_DIR": "/Users/test/O'Brien/.claude"]
        let plan = try GhosttyScriptPlan.launch(request)
        XCTAssertEqual(plan.script, GhosttyScriptPlan.launchScript)
        XCTAssertFalse(plan.script.contains("$(touch bad)"))
        XCTAssertFalse(plan.script.contains("O'Brien"))
        XCTAssertEqual(plan.arguments[1], request.workingDirectory)
        XCTAssertEqual(plan.arguments[3], request.title)
        XCTAssertEqual(plan.arguments[4], "true")
        XCTAssertEqual(plan.arguments[5], "CLAUDE_CONFIG_DIR=/Users/test/O'Brien/.claude")
        XCTAssertTrue(plan.arguments[2].hasPrefix("/bin/zsh -l -i -c 'exec "))
        XCTAssertTrue(plan.arguments[2].contains("/usr/bin/env"))
        XCTAssertTrue(plan.arguments[2].contains("CLAUDE_CONFIG_DIR="))
    }

    func testShellQuotingProtectsApostrophesEmptyValuesAndSubstitutions() {
        let cases: [(String, String)] = [
            ("", "''"),
            ("hello world", "'hello world'"),
            ("O'Brien", "'O'\\''Brien'"),
            ("$(touch /tmp/bad); `id`", "'$(touch /tmp/bad); `id`'"),
            ("a\nb", "'a\nb'")
        ]
        for (input, expected) in cases { XCTAssertEqual(GhosttyScriptPlan.shellQuote(input), expected) }
    }

    func testEnvironmentOrderIsDeterministicAndAllowsEqualsInValues() throws {
        var request = validRequest()
        request.environment = ["Z_VALUE": "a=b", "CODEX_HOME": "/tmp/codex profile"]
        let plan = try GhosttyScriptPlan.launch(request)
        XCTAssertEqual(Array(plan.arguments.dropFirst(5)), ["CODEX_HOME=/tmp/codex profile", "Z_VALUE=a=b"])
    }

    func testInvalidLaunchRequestsNeverInvokeRunner() {
        let runner = RecordingGhosttyRunner()
        let ghostty = makeGhostty(runner: runner)
        var cases: [GhosttyLaunchRequest] = []
        var request = validRequest(); request.executable = ""; cases.append(request)
        request = validRequest(); request.executable = "-option"; cases.append(request)
        request = validRequest(); request.workingDirectory = "relative/path"; cases.append(request)
        request = validRequest(); request.title = "line\nbreak"; cases.append(request)
        request = validRequest(); request.arguments = ["nul\0argument"]; cases.append(request)
        request = validRequest(); request.environment = ["BAD=KEY": "value"]; cases.append(request)
        request = validRequest(); request.environment = ["OK": "value\0"]; cases.append(request)
        request = validRequest(); request.environment = ["OK\n": "value"]; cases.append(request)
        request = validRequest(); request.unsetEnvironment = ["-u"]; cases.append(request)
        request = validRequest(); request.unsetEnvironment = ["BAD\n"]; cases.append(request)
        for invalid in cases {
            XCTAssertThrowsError(try ghostty.launch(invalid)) {
                guard let error = $0 as? GhosttyError, case .invalidRequest = error else {
                    return XCTFail("Expected invalid request")
                }
            }
        }
        XCTAssertTrue(runner.calls.isEmpty)
    }

    func testRemovedAuthenticationVariablesAreClearedAtSurfaceAndAfterShellStartup() throws {
        var request = validRequest()
        request.unsetEnvironment = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]
        let plan = try GhosttyScriptPlan.launch(request)
        XCTAssertEqual(Array(plan.arguments.dropFirst(5)), ["ANTHROPIC_API_KEY=", "CLAUDE_CODE_OAUTH_TOKEN=",
                                                         "CLAUDE_CONFIG_DIR=/Users/test/.claude-2"])
        let invocation = "exec '/usr/bin/env' '-u' 'ANTHROPIC_API_KEY' '-u' 'CLAUDE_CODE_OAUTH_TOKEN' "
            + "'CLAUDE_CONFIG_DIR=/Users/test/.claude-2' 'claude'"
        XCTAssertEqual(plan.arguments[2], "/bin/zsh -l -i -c " + GhosttyScriptPlan.shellQuote(invocation))
    }

    func testExplicitProfileAssignmentWinsOverRemovalOfTheSameVariable() throws {
        var request = validRequest()
        request.unsetEnvironment = ["CLAUDE_CONFIG_DIR"]
        let plan = try GhosttyScriptPlan.launch(request)
        XCTAssertEqual(Array(plan.arguments.dropFirst(5)), ["CLAUDE_CONFIG_DIR=/Users/test/.claude-2"])
        let invocation = "exec '/usr/bin/env' '-u' 'CLAUDE_CONFIG_DIR' 'CLAUDE_CONFIG_DIR=/Users/test/.claude-2' 'claude'"
        XCTAssertEqual(plan.arguments[2], "/bin/zsh -l -i -c " + GhosttyScriptPlan.shellQuote(invocation))
    }

    func testKeepOpenAfterExitDefaultsOnAndCanBeDisabled() throws {
        var request = validRequest()
        XCTAssertEqual(try GhosttyScriptPlan.launch(request).arguments[4], "true")
        request.keepOpenAfterExit = false
        XCTAssertEqual(try GhosttyScriptPlan.launch(request).arguments[4], "false")
        XCTAssertTrue(GhosttyScriptPlan.launchScript.contains("set wait after command of cfg to keepOpen"))
    }

    func testPermissionAndScriptingErrorsHaveSpecificRecoveryMessages() {
        let cases: [(String, GhosttyError)] = [
            ("Not authorized to send Apple events to Ghostty. (-1743)", .automationDenied),
            ("AppleScript is disabled by macos-applescript (-1743)", .scriptingUnavailable),
            ("Event not handled (-1708)", .scriptingUnavailable),
            ("Application isn't running. (-600)", .notRunning),
            ("Connection invalid (-609)", .notRunning),
            ("Can't get terminal (-1728)", .terminalUnavailable),
            ("AppleEvent timed out (-1712)", .timedOut),
            ("Sensitive user terminal title", .commandFailed)
        ]
        for (message, expected) in cases {
            XCTAssertEqual(GhosttyError.commandError(message), expected)
            XCTAssertFalse(expected.localizedDescription.contains("Sensitive user terminal title"))
        }
    }

    func testRunnerErrorsPropagateWithoutRetryingOrCreatingAnotherTerminal() {
        let runner = RecordingGhosttyRunner()
        runner.error = GhosttyError.automationDenied
        XCTAssertThrowsError(try makeGhostty(runner: runner).launch(validRequest())) {
            XCTAssertEqual($0 as? GhosttyError, .automationDenied)
        }
        XCTAssertEqual(runner.calls.count, 1)
    }

    func testMalformedLaunchResponseCannotBecomeAFocusTarget() {
        for output in ["", "{}", "{\"windowID\":\"w\",\"tabID\":\"t\",\"terminalID\":\"not-a-uuid\"}"] {
            XCTAssertThrowsError(try GhosttyScriptPlan.parseSession(output)) {
                XCTAssertEqual($0 as? GhosttyError, .invalidResponse)
            }
        }
    }

    private func makeGhostty(runner: RecordingGhosttyRunner, running: Bool = true) -> GhosttyAutomation {
        // A deliberately nonexistent bundle means tests neither inspect installed apps nor use real HOME.
        GhosttyAutomation(runner: runner, applicationURL: { URL(fileURLWithPath: "/test/Ghostty.app") },
                          isRunning: { running })
    }

    private func validRequest() -> GhosttyLaunchRequest {
        GhosttyLaunchRequest(executable: "claude", environment: ["CLAUDE_CONFIG_DIR": "/Users/test/.claude-2"],
                             workingDirectory: "/Users/test/projects", title: "Claude · Dorja")
    }

    private var sessionJSON: String {
        "{\"windowID\":\"window-1\",\"tabID\":\"tab-1\",\"terminalID\":\"\(terminalID)\"}"
    }
}

private final class RecordingGhosttyRunner: GhosttyScriptRunning {
    struct Call { let script: String; let arguments: [String] }
    var calls: [Call] = []
    var output = ""
    var error: Error?
    func run(script: String, arguments: [String]) throws -> String {
        calls.append(Call(script: script, arguments: arguments))
        if let error { throw error }
        return output
    }
}
