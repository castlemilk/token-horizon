import XCTest
@testable import TokenHorizon

/// Tests for the both-surfaces-at-once toggle. Same shared-store
/// save/restore discipline as SettingsStoreTests.
final class ShowTrayIconTests: XCTestCase {

    func testShowTrayIcon_roundTrip() {
        let store = SettingsStore.shared
        let original = store.showTrayIcon
        defer { store.showTrayIcon = original }

        store.showTrayIcon = !original
        XCTAssertEqual(store.showTrayIcon, !original)
    }

    func testShowTrayIcon_postsChangeNotification() {
        let store = SettingsStore.shared
        let original = store.showTrayIcon
        defer { store.showTrayIcon = original }

        let exp = expectation(forNotification: .tokenHorizonSurfaceDidChange, object: nil)
        store.showTrayIcon = !original
        wait(for: [exp], timeout: 2)
    }

    func testResolveSurface_modesAndEnvPrecedence() {
        // Neutralize the env escape hatch for determinism, restore after.
        let savedEnv = getenv("TOKEN_HORIZON_FORCE_TRAY").map { String(cString: $0) }
        unsetenv("TOKEN_HORIZON_FORCE_TRAY")
        defer {
            if let s = savedEnv { setenv("TOKEN_HORIZON_FORCE_TRAY", s, 1) }
        }
        let store = SettingsStore.shared
        let originalMode = store.surfaceMode
        defer { store.surfaceMode = originalMode }

        let app = AppDelegate()
        store.surfaceMode = .tray
        XCTAssertEqual(app.resolveSurface(), .tray)
        store.surfaceMode = .notch
        XCTAssertEqual(app.resolveSurface(), .notch)
        // Auto depends on attached hardware; assert only that it resolves.
        store.surfaceMode = .auto
        _ = app.resolveSurface()

        // Env escape hatch wins over an explicit notch pin.
        setenv("TOKEN_HORIZON_FORCE_TRAY", "1", 1)
        store.surfaceMode = .notch
        XCTAssertEqual(app.resolveSurface(), .tray)
    }
}
