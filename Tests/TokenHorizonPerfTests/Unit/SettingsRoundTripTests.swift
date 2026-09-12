import XCTest
@testable import TokenHorizon

/// Round-trip tests for the remaining persisted settings. Same shared-store
/// save/restore discipline as SettingsStoreTests. launchAtLogin's setter is
/// deliberately untested (it registers with launchd).
final class SettingsRoundTripTests: XCTestCase {

    func testStringSettings_roundTrip() {
        let store = SettingsStore.shared
        let origHandle = store.leaderboardHandle
        let origTeam = store.leaderboardTeam
        let origRemote = store.leaderboardRemoteURL
        let origCloud = store.leaderboardCloudURL
        let origToken = store.leaderboardCloudToken
        defer {
            store.leaderboardHandle = origHandle
            store.leaderboardTeam = origTeam
            store.leaderboardRemoteURL = origRemote
            store.leaderboardCloudURL = origCloud
            store.leaderboardCloudToken = origToken
        }
        store.leaderboardHandle = "  tester  "
        store.leaderboardTeam = "acme"
        store.leaderboardRemoteURL = "https://example.com/x"
        store.leaderboardCloudURL = "https://example.com///"
        store.leaderboardCloudToken = "tok"
        XCTAssertEqual(store.leaderboardHandle, "tester")
        XCTAssertEqual(store.leaderboardTeam, "acme")
        XCTAssertEqual(store.leaderboardRemoteURL, "https://example.com/x")
        XCTAssertEqual(store.leaderboardCloudURL, "https://example.com")
        XCTAssertEqual(store.leaderboardCloudToken, "tok")
        XCTAssertTrue(store.leaderboardCloudConfigured)
    }

    func testBoolSettings_roundTrip() {
        let store = SettingsStore.shared
        let origSync = store.leaderboardAutoSync
        let origCost = store.leaderboardShareCost
        let origHw = store.leaderboardShareHardware
        let origPrompts = store.leaderboardSharePrompts
        let origHist = store.historyPersistenceEnabled
        let origNotify = store.notifyOnLimitRefresh
        defer {
            store.leaderboardAutoSync = origSync
            store.leaderboardShareCost = origCost
            store.leaderboardShareHardware = origHw
            store.leaderboardSharePrompts = origPrompts
            store.historyPersistenceEnabled = origHist
            store.notifyOnLimitRefresh = origNotify
        }
        store.leaderboardAutoSync = !origSync
        store.leaderboardShareCost = !origCost
        store.leaderboardShareHardware = !origHw
        store.leaderboardSharePrompts = !origPrompts
        store.historyPersistenceEnabled = !origHist
        store.notifyOnLimitRefresh = !origNotify
        XCTAssertEqual(store.leaderboardAutoSync, !origSync)
        XCTAssertEqual(store.leaderboardShareCost, !origCost)
        XCTAssertEqual(store.leaderboardShareHardware, !origHw)
        XCTAssertEqual(store.leaderboardSharePrompts, !origPrompts)
        XCTAssertEqual(store.historyPersistenceEnabled, !origHist)
        XCTAssertEqual(store.notifyOnLimitRefresh, !origNotify)
    }



    func testLaunchAtLogin_getterIsReadOnlyBool() {
        // Setter registers with launchd — never call it here. The getter
        // only reads status.
        XCTAssertNotNil(SettingsStore.shared.launchAtLogin as Bool)
    }

    func testSheetsURL_fallsBackToRemote() {
        let store = SettingsStore.shared
        let origSheets = store.leaderboardSheetsURL
        let origRemote = store.leaderboardRemoteURL
        defer {
            store.leaderboardSheetsURL = origSheets
            store.leaderboardRemoteURL = origRemote
        }
        // NOTE: the sheets setter mirrors into remoteURL, so set sheets first.
        store.leaderboardSheetsURL = ""
        store.leaderboardRemoteURL = "https://remote.example/s"
        XCTAssertEqual(store.leaderboardSheetsURL, "https://remote.example/s")
    }
}
