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

    func testResolveSurface_modesAndForceTrayPrecedence() {
        for hasNotch in [false, true] {
            let cases: [(SurfaceMode, AppDelegate.ActiveSurface)] = [
                (.tray, .tray),
                (.notch, .notch),
                (.auto, hasNotch ? .notch : .tray)
            ]
            for (mode, expected) in cases {
                XCTAssertEqual(
                    AppDelegate.resolveSurface(mode: mode, forceTray: false, hasNotch: hasNotch),
                    expected
                )
                XCTAssertEqual(
                    AppDelegate.resolveSurface(mode: mode, forceTray: true, hasNotch: hasNotch),
                    .tray
                )
            }
        }
    }
}
