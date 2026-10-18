import XCTest
@testable import TokenHorizon

final class MultiTeamMembershipTests: XCTestCase {
    private let memberships = [
        LeaderboardTeamIdentity(id: "team-a", name: "Alpha"),
        LeaderboardTeamIdentity(id: "team-b", name: "Beta")
    ]

    private func entry(_ teams: [[String: String]]? = nil) -> LeaderboardEntry {
        var dict: [String: Any] = ["handle": "pilot", "team": "Alpha", "teamId": "team-a",
                                   "tokensAll": 100, "tokensToday": 10, "tokens7d": 40]
        if let teams { dict["teams"] = teams }
        return LeaderboardStore.entryFromDict(dict)!
    }

    func testLegacyProfileStillResolvesOneTeam() {
        let legacy = entry()
        XCTAssertNil(legacy.teams)
        XCTAssertEqual(legacy.resolvedTeams, [memberships[0]])
    }

    func testLegacyLabelRemainsEditableWithoutCloudMembership() {
        var legacy = entry()
        legacy.teamId = ""
        legacy.teams = []
        let carried = LeaderboardStore.localTeamIdentity(configuredTeam: "New label", previousLocal: legacy)
        XCTAssertEqual(carried.team, "New label")
        XCTAssertEqual(carried.teamId, "")
    }

    func testMultiTeamCountsOncePerTeamAndSurvivesDiskRoundTrip() throws {
        var profile = entry()
        profile.teams = memberships + [memberships[0]]
        let restored = try JSONDecoder().decode(LeaderboardEntry.self, from: JSONEncoder().encode(profile))
        XCTAssertEqual(restored.resolvedTeams, memberships)
        let rows = TeamStore.localTeams(from: [restored])
        XCTAssertEqual(Set(rows.map(\.teamId)), Set(["team-a", "team-b"]))
        for row in rows {
            XCTAssertEqual(row.tokens, 100)
            XCTAssertEqual(row.tokensToday, 10)
            XCTAssertEqual(row.tokens7d, 40)
            XCTAssertEqual(row.members, 1)
        }
    }

    func testCloudMembershipReplacesFullListIncludingLastLeave() {
        var local = entry()
        var remote = entry()
        remote.teams = memberships
        LeaderboardStore.adoptTeamIdentity(into: &local, from: remote)
        XCTAssertEqual(local.resolvedTeams, memberships)
        XCTAssertEqual(local.tokensAll, 100)
        remote.teams = []
        remote.team = ""
        remote.teamId = ""
        LeaderboardStore.adoptTeamIdentity(into: &local, from: remote)
        XCTAssertEqual(local.teams, [])
        XCTAssertEqual(local.teamId, "")
        XCTAssertEqual(local.team, "")
        let carried = LeaderboardStore.localTeamIdentity(configuredTeam: "Old label", previousLocal: local)
        XCTAssertEqual(carried.team, "")
        XCTAssertEqual(carried.teamId, "")
    }

    func testAllMembershipsSurviveLocalRebuildAndDiskReload() throws {
        let path = NSTemporaryDirectory() + "multi-team-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let store = LeaderboardStore(customPath: path)
        var snapshot = UsageSnapshot()
        snapshot.tokensAllTime = 1_000
        store.syncLocal(snapshot: snapshot, history: [], streak: 1)
        var local = try XCTUnwrap(store.localEntry())
        local.teams = memberships
        local.team = "Alpha"; local.teamId = "team-a"
        store.addOrUpdateEntry(local)
        store.syncLocal(snapshot: snapshot, history: [], streak: 2)
        XCTAssertEqual(store.localEntry()?.resolvedTeams, memberships)
        XCTAssertEqual(store.rankings(for: .all, teamFilter: "team-b").count, 1)
        let reloaded = LeaderboardStore(customPath: path)
        XCTAssertEqual(reloaded.localEntry()?.resolvedTeams, memberships)
        XCTAssertEqual(TeamStore.localTeams(from: [try XCTUnwrap(reloaded.localEntry())]).count, 2)
    }

    func testDictionaryParserKeepsAllMembershipsAndExplicitEmptyList() {
        let parsed = entry(memberships.map { ["id": $0.id, "name": $0.name] })
        XCTAssertEqual(parsed.teams, memberships)
        XCTAssertEqual(parsed.teamDisplayName, "Alpha, Beta")
        XCTAssertEqual(entry([]).teams, [])
    }
}
