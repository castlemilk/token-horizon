import XCTest
@testable import TokenHorizon
// swiftlint:disable force_cast
// Test files are exempt from force-cast enforcement. Production code keeps
// the default error-level enforcement.

/// Regression tests for intelligent leaderboard sync: TTL-gated pulls,
/// change-gated publishes, and the shared remote-merge. These pin the
/// behavior that stops auto-sync from hammering the backend every tick.
final class LeaderboardSyncTests: XCTestCase {

    private func entry(_ id: String, handle: String, all: Int, local: Bool = false) -> LeaderboardEntry {
        LeaderboardEntry(id: id, handle: handle, team: "acme",
                         tokensToday: all / 10, tokens7d: all / 2, tokensAll: all,
                         costToday: 0, cost7d: 0, costAll: 0, streakDays: 3,
                         topModel: "m", hardware: "h", isLocal: local, updatedAt: Date())
    }

    // MARK: - Pull policy

    func testShouldPull_firstTimeAndForced() {
        let now = Date()
        XCTAssertTrue(LeaderboardSyncPolicy.shouldPull(now: now, lastPull: nil, forced: false))
        XCTAssertTrue(LeaderboardSyncPolicy.shouldPull(now: now, lastPull: now, forced: true))
    }

    func testShouldPull_ttlBoundaries() {
        let now = Date()
        let fresh = now.addingTimeInterval(-60)
        let stale = now.addingTimeInterval(-(LeaderboardSyncPolicy.pullTTL + 1))
        XCTAssertFalse(LeaderboardSyncPolicy.shouldPull(now: now, lastPull: fresh, forced: false))
        XCTAssertTrue(LeaderboardSyncPolicy.shouldPull(now: now, lastPull: stale, forced: false))
    }

    // MARK: - Publish policy

    func testShouldPublish_firstTimeAndForced() {
        let now = Date()
        XCTAssertTrue(LeaderboardSyncPolicy.shouldPublish(now: now, lastPublish: nil, lastTokens: nil, currentTokens: 0, forced: false))
        XCTAssertTrue(LeaderboardSyncPolicy.shouldPublish(now: now, lastPublish: now, lastTokens: 10_000, currentTokens: 10_001, forced: true))
    }

    func testShouldPublish_minIntervalAndDelta() {
        let now = Date()
        let recent = now.addingTimeInterval(-30)
        // Too soon, even with big movement.
        XCTAssertFalse(LeaderboardSyncPolicy.shouldPublish(now: now, lastPublish: recent, lastTokens: 0, currentTokens: 99_000, forced: false))
        let old = now.addingTimeInterval(-(LeaderboardSyncPolicy.publishMinInterval + 1))
        // Interval elapsed but trivial movement: skip.
        XCTAssertFalse(LeaderboardSyncPolicy.shouldPublish(now: now, lastPublish: old, lastTokens: 50_000, currentTokens: 50_500, forced: false))
        // Interval elapsed + material movement: fire.
        XCTAssertTrue(LeaderboardSyncPolicy.shouldPublish(now: now, lastPublish: old, lastTokens: 50_000, currentTokens: 51_000, forced: false))
    }

    // MARK: - Remote merge

    func testMergeRemoteEntries_updatesMatchesAppendsRest() {
        let local = entry("local:me", handle: "me", all: 100, local: true)
        let current = [local, entry("sheet:amy", handle: "amy", all: 50)]
        let remote = [
            entry("sheet:amy", handle: "amy", all: 60),
            entry("sheet:ben", handle: "ben", all: 70),
        ]
        let out = LeaderboardStore.mergeRemoteEntries(current: current, local: local, remote: remote)
        XCTAssertEqual(out.count, 3)
        XCTAssertEqual(out.first(where: { $0.handle == "amy" })?.tokensAll, 60)
        XCTAssertNotNil(out.first(where: { $0.handle == "ben" }))
        XCTAssertTrue(out.first(where: { $0.handle == "me" })?.isLocal ?? false)
    }

    func testMergeRemoteEntries_neverOverwritesLocalIdentity() {
        let local = entry("local:me", handle: "Me", all: 100, local: true)
        let remote = [entry("sheet:me", handle: "me", all: 9999)]
        let out = LeaderboardStore.mergeRemoteEntries(current: [local], local: local, remote: remote)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].tokensAll, 100, "remote row matching local handle is dropped")
        XCTAssertTrue(out[0].isLocal)
    }

    func testMergeRemoteEntries_matchesByIdRegardlessOfHandle() {
        let current = [entry("sheet:amy", handle: "amy-old", all: 50)]
        let remote = [entry("sheet:amy", handle: "amy-new", all: 55)]
        let out = LeaderboardStore.mergeRemoteEntries(current: current, local: nil, remote: remote)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].tokensAll, 55)
    }

    func testMergeRemoteEntries_forcesNonLocal() {
        let remote = [entry("x", handle: "mallory", all: 1, local: true)]
        let out = LeaderboardStore.mergeRemoteEntries(current: [], local: nil, remote: remote)
        XCTAssertFalse(out[0].isLocal, "a remote row must never arrive flagged local")
    }

    // MARK: - Cloud payload encoding

    func testCloudEntryEncoding_epochSecondsKeys() throws {
        let e = entry("local:me", handle: "me", all: 1234, local: true)
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .secondsSince1970
        let data = try enc.encode(e)
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(dict["handle"] as? String, "me")
        XCTAssertEqual(dict["tokensAll"] as? Int, 1234)
        // updatedAt must be epoch SECONDS (worker tolerates ms, prefers s).
        let ts = dict["updatedAt"] as? Double ?? -1
        XCTAssertGreaterThan(ts, 1_700_000_000)
        XCTAssertLessThan(ts, 2_000_000_000)
    }
}
