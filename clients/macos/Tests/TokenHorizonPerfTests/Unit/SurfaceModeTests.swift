import XCTest
@testable import TokenHorizon

/// Tests for the surface-mode config (notch panel vs menu bar).
/// Follows the SettingsStoreTests pattern: mutate the shared store, restore
/// afterwards — never leave the developer's real settings changed.
final class SurfaceModeTests: XCTestCase {

    func testSurfaceMode_roundTripsAllCases() {
        let store = SettingsStore.shared
        let original = store.surfaceMode
        defer { store.surfaceMode = original }

        for mode in SurfaceMode.allCases {
            store.surfaceMode = mode
            XCTAssertEqual(store.surfaceMode, mode)
        }
    }

    func testSurfaceMode_idsAndLabels() {
        XCTAssertEqual(SurfaceMode.allCases.map { $0.rawValue }.sorted(),
                       ["auto", "notch", "tray"])
        for mode in SurfaceMode.allCases {
            XCTAssertFalse(mode.label.isEmpty)
            XCTAssertEqual(mode.id, mode.rawValue)
        }
    }

    func testSurfaceMode_unknownRawFallsBackToAuto() {
        XCTAssertNil(SurfaceMode(rawValue: "bogus"))
        XCTAssertEqual(SurfaceMode(rawValue: "bogus") ?? .auto, .auto)
    }

    func testSurfaceMode_postsChangeNotification() {
        let store = SettingsStore.shared
        let original = store.surfaceMode
        defer { store.surfaceMode = original }

        let exp = expectation(forNotification: .tokenHorizonSurfaceDidChange, object: nil)
        store.surfaceMode = (original == .tray) ? .notch : .tray
        wait(for: [exp], timeout: 2)
    }
}
