import XCTest
@testable import TokenHorizon

/// The TEAMS tab aggregates cloud `GET /api/teams` rows, or — when the cloud
/// is unreachable — groups the leaderboard entries already on disk. These
/// tests pin the local grouping key (must match `aggregateTeams` in
/// `cloudflare/src/index.js`), the endpoint derivation, and the `teamId` field
/// the grouping depends on.
final class TeamStoreTests: XCTestCase {

    private func entry(
        handle: String,
        team: String,
        teamId: String = "",
        tokensAll: Int = 100,
        tokensToday: Int = 0,
        tokens7d: Int = 0,
        costAll: Double = 0,
        providers: [(String, Int)] = [],
        daily: [(Int, Int)] = [],
        isLocal: Bool = false
    ) -> LeaderboardEntry {
        var breakdown = LeaderboardUsageBreakdown()
        breakdown.models = providers.map {
            LeaderboardModelBreakdown(provider: $0.0, model: "m", tokensToday: 0,
                                      tokensAll: $0.1, costToday: 0, costAll: 0,
                                      sharePercent: 0)
        }
        breakdown.daily = daily.map {
            LeaderboardDailyPoint(day: $0.0, dayLabel: "d", tokens: $0.1, cost: 0)
        }
        return LeaderboardEntry(
            id: "id:\(handle)", handle: handle, team: team, teamId: teamId,
            tokensToday: tokensToday, tokens7d: tokens7d, tokensAll: tokensAll,
            costToday: 0, cost7d: 0, costAll: costAll, streakDays: 0,
            topModel: "claude", hardware: "M3", isLocal: isLocal,
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000),
            breakdown: breakdown)
    }

    // MARK: - Grouping

    func test_localTeams_mergesEntriesSharingATeamId() {
        let rows = TeamStore.localTeams(from: [
            entry(handle: "a", team: "Alpha", teamId: "t1", tokensAll: 100),
            entry(handle: "b", team: "Alpha EU", teamId: "t1", tokensAll: 50)
        ])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].id, "id:t1")
        XCTAssertEqual(rows[0].tokens, 150)
        XCTAssertEqual(rows[0].members, 2)
        XCTAssertEqual(rows[0].users.map(\.handle), ["a", "b"])
    }

    func test_localTeams_idLessEntryJoinsTheKnownIdGroupByLabel() {
        let rows = TeamStore.localTeams(from: [
            entry(handle: "a", team: "Beta", teamId: "t2", tokensAll: 10),
            entry(handle: "b", team: "beta", teamId: "", tokensAll: 20)
        ])
        XCTAssertEqual(rows.count, 1, "a shared label must not split an id-keyed team")
        XCTAssertEqual(rows[0].id, "id:t2")
        XCTAssertEqual(rows[0].tokens, 30)
    }

    func test_localTeams_membershipNameBeatsThePublishLabel() {
        let local = entry(handle: "me", team: "Castlemilk", teamId: "t1", tokensAll: 300, isLocal: true)
        let peer = entry(handle: "peer", team: "maxxers", teamId: "t1", tokensAll: 100)
        for entries in [[local, peer], [peer, local]] {
            let rows = TeamStore.localTeams(from: entries)
            XCTAssertEqual(rows.count, 1)
            XCTAssertEqual(rows[0].id, "id:t1")
            XCTAssertEqual(rows[0].team, "maxxers", "the membership name wins whatever the order")
            XCTAssertEqual(rows[0].members, 2)
        }
    }

    func test_localTeams_cloudRowsKeepTheFirstSeenName() {
        let rows = TeamStore.localTeams(from: [
            entry(handle: "a", team: "Alpha", teamId: "t1", tokensAll: 10),
            entry(handle: "b", team: "Alpha EU", teamId: "t1", tokensAll: 5)
        ])
        XCTAssertEqual(rows[0].team, "Alpha", "an all-cloud group is not re-labelled by the last member")
    }

    func test_localTeams_labelOnlyTeamsStayOnTheLegacyKey() {
        let rows = TeamStore.localTeams(from: [
            entry(handle: "a", team: "Solo", tokensAll: 5),
            entry(handle: "b", team: "Solo", tokensAll: 7)
        ])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].id, "legacy:Solo")
        XCTAssertEqual(rows[0].tokens, 12)
        XCTAssertTrue(rows[0].teamId.isEmpty)
    }

    func test_localTeams_blankLabelFallsBackToUnassigned() {
        let rows = TeamStore.localTeams(from: [entry(handle: "a", team: "   ", tokensAll: 1)])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].team, "Unassigned")
        XCTAssertEqual(rows[0].id, "legacy:Unassigned")
    }

    func test_localTeams_sortsByTokensDescending() {
        let rows = TeamStore.localTeams(from: [
            entry(handle: "a", team: "Low", tokensAll: 10),
            entry(handle: "b", team: "High", tokensAll: 1_000),
            entry(handle: "c", team: "Mid", tokensAll: 100)
        ])
        XCTAssertEqual(rows.map(\.team), ["High", "Mid", "Low"])
    }

    func test_localTeams_capsTheMemberListAtSixAndSortsIt() {
        let rows = TeamStore.localTeams(from: (1...8).map {
            entry(handle: "h\($0)", team: "Big", tokensAll: $0)
        })
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].members, 8, "all members are counted")
        XCTAssertEqual(rows[0].users.count, 6, "only the top six are listed")
        XCTAssertEqual(rows[0].users.map(\.tokensAll), [8, 7, 6, 5, 4, 3])
    }

    func test_localTeams_accumulatesProviderMixAndDailyPoints() {
        let rows = TeamStore.localTeams(from: [
            entry(handle: "a", team: "T", tokensAll: 10,
                  providers: [("anthropic", 60)], daily: [(1_700, 100)]),
            entry(handle: "b", team: "T", tokensAll: 20,
                  providers: [("anthropic", 40), ("openai", 30)], daily: [(1_700, 250)])
        ])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].providers["anthropic"], 100)
        XCTAssertEqual(rows[0].providers["openai"], 30)
        XCTAssertEqual(rows[0].daily, [LeaderboardTeamDay(day: 1_700, tokens: 350)])
    }

    func test_localTeams_countsPublishedWindows() {
        let rows = TeamStore.localTeams(from: [
            entry(handle: "a", team: "T", tokensAll: 1, tokensToday: 5, tokens7d: 0),
            entry(handle: "b", team: "T", tokensAll: 1, tokensToday: 0, tokens7d: 0),
            entry(handle: "c", team: "T", tokensAll: 1, tokensToday: 0, tokens7d: 9)
        ])
        XCTAssertEqual(rows[0].publishedToday, 1, "zero-activity members are not reporters")
        XCTAssertEqual(rows[0].publishedWeek, 1)
        XCTAssertEqual(rows[0].tokensToday, 5)
        XCTAssertEqual(rows[0].tokens7d, 9)
    }

    func test_localTeams_emptyInputProducesNoRows() {
        XCTAssertTrue(TeamStore.localTeams(from: []).isEmpty)
    }

    // MARK: - Endpoint

    func test_teamsURL_targetsTheJsonApiNotTheProfilePage() {
        XCTAssertEqual(TeamStore.teamsURL(baseURL: "https://token-horizon.dev")?.absoluteString,
                       "https://token-horizon.dev/api/teams")
        XCTAssertEqual(TeamStore.teamsURL(baseURL: "https://token-horizon.dev/api")?.absoluteString,
                       "https://token-horizon.dev/api/teams")
        XCTAssertEqual(TeamStore.teamsURL(baseURL: "https://token-horizon.dev/api/leaderboard")?.absoluteString,
                       "https://token-horizon.dev/api/teams")
        XCTAssertEqual(TeamStore.teamsURL(baseURL: "https://token-horizon.dev/leaderboard")?.absoluteString,
                       "https://token-horizon.dev/api/teams",
                       "a bare /leaderboard base must not resolve to the /teams profile page")
        XCTAssertEqual(TeamStore.teamsURL(baseURL: "https://host.example/prefix")?.absoluteString,
                       "https://host.example/prefix/api/teams")
        XCTAssertEqual(TeamStore.teamsURL(baseURL: "https://host.example/prefix/leaderboard")?.absoluteString,
                       "https://host.example/prefix/api/teams")
        XCTAssertEqual(TeamStore.teamsURL(baseURL: "https://host.example/")?.absoluteString,
                       "https://host.example/api/teams")
    }

    func test_teamsURL_rejectsBadBases() {
        XCTAssertNil(TeamStore.teamsURL(baseURL: ""))
        XCTAssertNil(TeamStore.teamsURL(baseURL: "   "))
        XCTAssertNil(TeamStore.teamsURL(baseURL: "not a url"))
        XCTAssertNil(TeamStore.teamsURL(baseURL: "file:///tmp/x"))
    }

    // MARK: - Cloud cache revalidation

    func test_forcedTeamRefreshBypassesTheHTTPResponseCache() {
        let request = TeamStore.teamsRequest(url: URL(string: "https://host.example/api/teams")!,
                                            force: true, source: .cloud, etag: "old-team-payload")
        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData,
                       "refreshing after a publish must not replay a fresh URLSession cache entry")
        XCTAssertNil(request.value(forHTTPHeaderField: "If-None-Match"))
    }

    func test_localFallbackCannotRevalidateAnOldCloudPayload() {
        let oldTag = "cloud-before-outage"
        let tag = TeamStore.updatedETag(source: .local, previous: oldTag, received: nil,
                                       replacingPayload: false)
        XCTAssertNil(tag, "a cloud validator no longer describes the local fallback rows")
        let request = TeamStore.teamsRequest(url: URL(string: "https://host.example/api/teams")!,
                                            force: false, source: .local, etag: oldTag)
        XCTAssertNil(request.value(forHTTPHeaderField: "If-None-Match"),
                     "a 304 must never promote local rows into a cloud result")
    }

    func test_cloudRevalidationRetainsTheValidatorForUnchangedRows() {
        let tag = TeamStore.updatedETag(source: .cloud, previous: "same-rows", received: nil,
                                       replacingPayload: false)
        let request = TeamStore.teamsRequest(url: URL(string: "https://host.example/api/teams")!,
                                            force: false, source: .cloud, etag: tag)
        XCTAssertEqual(request.value(forHTTPHeaderField: "If-None-Match"), "same-rows")
    }

    func test_newCloudPayloadReplacesOrClearsThePreviousValidator() {
        let cases: [(String?, String?)] = [("new-rows", "new-rows"), (nil, nil)]
        for (received, expected) in cases {
            XCTAssertEqual(TeamStore.updatedETag(source: .cloud, previous: "old-rows",
                                                received: received, replacingPayload: true), expected,
                           "a new 200 response must never retain the validator of older rows")
        }
        XCTAssertNil(TeamStore.updatedETag(source: .none, previous: "old-rows", received: nil,
                                          replacingPayload: false))
    }

    // MARK: - Cloud row parsing

    func test_cloudRow_decodesTheAggregateShape() {
        let row: [String: Any] = [
            "team": "Paprika",
            "teamId": "abc123",
            "tokens": 4_000,
            "tokensToday": 120,
            "tokens7d": 900,
            "cost": 3.25,
            "members": 2,
            "recentWindowProfiles": ["today": 1, "week": 2],
            "providers": ["anthropic": 3_000, "openai": 1_000],
            "users": [["handle": "bene", "tokensAll": 3_000]],
            "daily": [["day": 1_700_000_000, "tokens": 400]],
            "memberCount": 5,
            "url": "https://token-horizon.dev/t/abc123"
        ]
        let team = LeaderboardTeam(dict: row)
        XCTAssertNotNil(team)
        XCTAssertEqual(team?.id, "id:abc123")
        XCTAssertEqual(team?.tokens, 4_000)
        XCTAssertEqual(team?.publishedToday, 1)
        XCTAssertEqual(team?.publishedWeek, 2)
        XCTAssertEqual(team?.providers["anthropic"], 3_000)
        XCTAssertEqual(team?.users.first?.handle, "bene")
        XCTAssertEqual(team?.daily, [LeaderboardTeamDay(day: 1_700_000_000, tokens: 400)])
        XCTAssertEqual(team?.memberCount, 5)
        XCTAssertEqual(team?.teamUrl, "https://token-horizon.dev/t/abc123")
    }

    func test_cloudRow_requiresATeamName() {
        XCTAssertNil(LeaderboardTeam(dict: ["tokens": 1]))
        XCTAssertNil(LeaderboardTeam(dict: ["team": ""]))
    }

    func test_cloudRow_serializesBackToTheWireShape() {
        let team = LeaderboardTeam(team: "Solo")
        let dict = team.toDict()
        XCTAssertEqual(dict["team"] as? String, "Solo")
        XCTAssertEqual(dict["tokens"] as? Int, 0)
        XCTAssertNotNil(dict["recentWindowProfiles"] as? [String: Any])
        XCTAssertNotNil(dict["users"] as? [Any])
        XCTAssertNotNil(dict["daily"] as? [Any])
        XCTAssertNil(dict["memberCount"], "an unknown roster total is never invented")
    }

    // MARK: - Wire parsing

    func test_entryFromDict_readsTeamId() {
        let parsed = LeaderboardStore.entryFromDict([
            "handle": "bene", "team": "Paprika", "teamId": "abc123",
            "tokensAll": 10, "tokensToday": 1, "tokens7d": 2
        ])
        XCTAssertEqual(parsed?.team, "Paprika")
        XCTAssertEqual(parsed?.teamId, "abc123")
    }

    func test_entryFromDict_defaultsTeamIdToEmpty() {
        let parsed = LeaderboardStore.entryFromDict(["handle": "bene", "team": "Solo"])
        XCTAssertEqual(parsed?.teamId, "")
    }

    func test_entryDecodesWithoutATeamIdKey() throws {
        let json = """
        {"id":"x","handle":"bene","team":"Solo","tokensToday":1,"tokens7d":2,
         "tokensAll":3,"costToday":0,"cost7d":0,"costAll":0,"streakDays":0,
         "topModel":"claude","hardware":"M3","isLocal":false,"updatedAt":1700000000}
        """
        let decoded = try JSONDecoder().decode(LeaderboardEntry.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.teamId, "")
        XCTAssertEqual(decoded.team, "Solo")
    }
}
