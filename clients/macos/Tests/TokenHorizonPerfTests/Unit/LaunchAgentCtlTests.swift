import XCTest
@testable import TokenHorizon

/// Tests for the portable agent manager (LaunchAgentCtl): the installed app
/// binary maintains its own crash-recovery LaunchAgent, no repo scripts.
/// Only pure parts are tested (plist rendering, env snapshot); load/unload
/// touch launchd and are verified live, not in CI.
final class LaunchAgentCtlTests: XCTestCase {

    func testPlist_supervisionKeys() {
        let p = LaunchAgentCtl.plist(
            appBinaryPath: "/Applications/TokenHorizon.app/Contents/MacOS/TokenHorizon",
            logPath: "/Users/x/Library/Logs/TokenHorizon.log",
            environment: [:])
        XCTAssertTrue(p.contains("<string>local.benebsworth.token-horizon</string>"))
        XCTAssertTrue(p.contains("/Applications/TokenHorizon.app/Contents/MacOS/TokenHorizon"))
        XCTAssertTrue(p.contains("/Users/x/Library/Logs/TokenHorizon.log"))
        // Crash-only restart: clean duplicate-exits must NOT loop.
        XCTAssertTrue(p.contains("<key>SuccessfulExit</key><false/>"))
        XCTAssertTrue(p.contains("<integer>30</integer>"))
        XCTAssertTrue(p.contains("<key>RunAtLoad</key><true/>"))
    }

    func testPlist_snapshotsForwardedEnv() {
        let p = LaunchAgentCtl.plist(
            appBinaryPath: "/bin/x", logPath: "/tmp/x.log",
            environment: ["TOKEN_HORIZON_FORCE_TRAY": "1", "OPENCODE_AUTH": "/tmp/auth.json"])
        XCTAssertTrue(p.contains("<key>TOKEN_HORIZON_FORCE_TRAY</key><string>1</string>"))
        XCTAssertTrue(p.contains("<key>OPENCODE_AUTH</key><string>/tmp/auth.json</string>"))
    }

    func testPlist_escapesXML() {
        let p = LaunchAgentCtl.plist(
            appBinaryPath: "/a&b/<c>", logPath: "/tmp/x.log", environment: [:])
        XCTAssertTrue(p.contains("/a&amp;b/&lt;c&gt;"))
        XCTAssertFalse(p.contains("/a&b/<c>"))
        let q = LaunchAgentCtl.plist(
            appBinaryPath: "/bin/x", logPath: "/tmp/x.log",
            environment: ["K": "a\"b'c"])
        XCTAssertTrue(q.contains("a&quot;b&apos;c"))
    }

    func testForwardedEnvironment_filters() {
        let env = [
            "TOKEN_HORIZON_FORCE_TRAY": "1",
            "TOKEN_HORIZON_OLLAMA_UPSTREAM": "127.0.0.1:11434",
            "OPENCODE_AUTH": "/tmp/auth.json",
            "CLAUDE_CONFIG_DIR": "/tmp/claude",
            "HOME": "/Users/x",
            "PATH": "/usr/bin",
            "DEEPSEEK_API_KEY": "",
        ]
        let out = LaunchAgentCtl.forwardedEnvironment(env)
        XCTAssertEqual(out["TOKEN_HORIZON_FORCE_TRAY"], "1")
        XCTAssertEqual(out["TOKEN_HORIZON_OLLAMA_UPSTREAM"], "127.0.0.1:11434")
        XCTAssertEqual(out["OPENCODE_AUTH"], "/tmp/auth.json")
        XCTAssertEqual(out["CLAUDE_CONFIG_DIR"], "/tmp/claude")
        XCTAssertNil(out["HOME"])
        XCTAssertNil(out["PATH"])
        XCTAssertNil(out["DEEPSEEK_API_KEY"], "empty values are dropped")
    }

    func testParseListPID() {
        let running = "{\n\t\"Label\" = \"local.benebsworth.token-horizon\";\n\t\"PID\" = 55234;\n}"
        XCTAssertEqual(LaunchAgentCtl.parseListPID(running), "55234")
        XCTAssertNil(LaunchAgentCtl.parseListPID("{\n\t\"Label\" = \"local.benebsworth.token-horizon\";\n}"))
        XCTAssertNil(LaunchAgentCtl.parseListPID("Could not find service"))
    }

    func testPaths_useOwnBundleAndHome() {
        // plist lives in the user LaunchAgents dir; binary resolves from the
        // bundle (portable — follows the .app wherever it is installed).
        XCTAssertTrue(LaunchAgentCtl.plistURL().path.hasSuffix(
            "Library/LaunchAgents/local.benebsworth.token-horizon.plist"))
        XCTAssertTrue(LaunchAgentCtl.appBinaryPath(
            bundleURL: URL(fileURLWithPath: "/Applications/TokenHorizon.app"))
            == "/Applications/TokenHorizon.app/Contents/MacOS/TokenHorizon")
    }
}
