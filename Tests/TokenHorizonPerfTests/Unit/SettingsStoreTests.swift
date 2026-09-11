import XCTest
@testable import TokenHorizon

final class SettingsStoreTests: XCTestCase {

    func testSettingsStore_cookieAndNotificationGetSet() {
        let store = SettingsStore.shared
        let originalCookie = store.alibabaCookie
        let originalNotify = store.notifyOnLimitRefresh

        let testCookie = "cna=test-token-horizon-cookie-12345"
        store.setCookie(testCookie)
        XCTAssertEqual(store.getCookie(), testCookie)
        XCTAssertEqual(store.alibabaCookie, testCookie)

        store.notifyOnLimitRefresh = false
        XCTAssertFalse(store.notifyOnLimitRefresh)

        // Restore original
        store.setCookie(originalCookie)
        store.notifyOnLimitRefresh = originalNotify
    }
}
