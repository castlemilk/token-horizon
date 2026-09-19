import XCTest
@testable import TokenHorizonCore

/// Cloud identity persistence: the daemon saves the UI's sign-in so
/// background sync attributes to the right user with the UI closed.
final class CloudIdentityTests: XCTestCase {

    private var path: String!

    override func setUp() {
        path = NSTemporaryDirectory().appendingPathComponent("th-cloudid-\(UUID().uuidString).json")
        CloudIdentityStore.pathOverride = path
    }

    override func tearDown() {
        CloudIdentityStore.pathOverride = nil
        try? FileManager.default.removeItem(atPath: path)
    }

    func testRoundTrip() throws {
        XCTAssertNil(CloudIdentityStore.load(), "empty before first save")
        let id = CloudIdentity(baseURL: "https://cloud.example.com/", handle: "wock",
                               userID: "u-123", team: "core", displayName: "Wock")
        try CloudIdentityStore.save(id)
        let loaded = try XCTUnwrap(CloudIdentityStore.load())
        XCTAssertEqual(loaded.handle, "wock")
        XCTAssertEqual(loaded.userID, "u-123")
        XCTAssertEqual(loaded.team, "core")
        XCTAssertEqual(loaded.baseURL, "https://cloud.example.com/")
        XCTAssertGreaterThan(loaded.savedAt, 0)
        // 0600 — identity files are not world-readable.
        let perms = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
        XCTAssertEqual(perms, 0o600)
    }

    func testClear() throws {
        try CloudIdentityStore.save(CloudIdentity(baseURL: "", handle: "a", userID: "u"))
        XCTAssertNotNil(CloudIdentityStore.load())
        CloudIdentityStore.clear()
        XCTAssertNil(CloudIdentityStore.load())
    }

    func testApplyConfiguresSyncEngine() {
        let sync = CloudSync()
        let id = CloudIdentity(baseURL: "https://cloud.example.com", handle: "wock",
                               userID: "u-123", team: "core")
        CloudIdentityStore.apply(id, to: sync)
        XCTAssertEqual(sync.baseURL?.absoluteString, "https://cloud.example.com")
        XCTAssertEqual(sync.handle, "wock")
        XCTAssertEqual(sync.userID, "u-123")
        XCTAssertEqual(sync.team, "core")
        // Empty base URL keeps the engine's existing target.
        let keep = CloudIdentity(baseURL: "", handle: "h2", userID: "u-2")
        CloudIdentityStore.apply(keep, to: sync)
        XCTAssertEqual(sync.baseURL?.absoluteString, "https://cloud.example.com")
        XCTAssertEqual(sync.handle, "h2")
    }
}
