import XCTest
@testable import TokenHorizonCore

/// Auto-start registration contract: the generated unit/plist/desktop files
/// are pure functions — regressions here break customer boot behavior.
/// Service-manager interaction (systemctl/launchctl) is NOT unit-tested.
final class DaemonAutoStartTests: XCTestCase {

    func testSystemdUnit() {
        let unit = DaemonAutoStart.systemdUnit(execPath: "/home/u/.local/bin/token-horizon-headless")
        XCTAssertTrue(unit.contains("ExecStart=/home/u/.local/bin/token-horizon-headless"))
        XCTAssertTrue(unit.contains("Restart=on-failure"))
        XCTAssertTrue(unit.contains("WantedBy=default.target"))
        XCTAssertTrue(unit.contains("[Service]"))
    }

    func testAutostartDesktopEntry() {
        let desktop = DaemonAutoStart.autostartDesktop(execPath: "/opt/th/token-horizon-headless")
        XCTAssertTrue(desktop.contains("[Desktop Entry]"))
        XCTAssertTrue(desktop.contains("Exec=/opt/th/token-horizon-headless"))
        XCTAssertTrue(desktop.contains("Type=Application"))
    }

    func testLaunchAgentPlist() {
        let plist = DaemonAutoStart.launchAgentPlist(
            label: "com.tokenhorizon.headless",
            execPath: "/Applications/token-horizon.app/Contents/MacOS/token-horizon-headless",
            logPath: "/Users/u/Library/Logs/token-horizon/headless.log")
        XCTAssertTrue(plist.contains("<key>Label</key><string>com.tokenhorizon.headless</string>"))
        XCTAssertTrue(plist.contains("<string>/Applications/token-horizon.app/Contents/MacOS/token-horizon-headless</string>"))
        XCTAssertTrue(plist.contains("<key>RunAtLoad</key><true/>"))
        XCTAssertTrue(plist.contains("<key>KeepAlive</key><true/>"))
        XCTAssertTrue(plist.contains("<key>StandardOutPath</key>"))
        // Must be parseable XML plist.
        let obj = try? PropertyListSerialization.propertyList(
            from: Data(plist.utf8), format: nil)
        let dict = obj as? [String: Any]
        XCTAssertEqual(dict?["Label"] as? String, "com.tokenhorizon.headless")
        XCTAssertEqual(dict?["RunAtLoad"] as? Bool, true)
        XCTAssertEqual(dict?["KeepAlive"] as? Bool, true)
    }

    func testStatusNeverCrashes() {
        // On the Linux CI/dev box: supported, systemd-user or autostart-desktop.
        // Must not throw and must be self-consistent.
        let s = DaemonAutoStart.status()
        #if os(Windows)
        XCTAssertFalse(s.supported)
        #else
        XCTAssertTrue(s.supported)
        #endif
        if !s.installed {
            XCTAssertFalse(s.enabled)
            XCTAssertFalse(s.running)
        }
    }

    func testExecutablePathIsAbsolute() {
        XCTAssertTrue(DaemonAutoStart.executablePath().hasPrefix("/"))
    }
}
