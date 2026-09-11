import XCTest
@testable import TokenHorizon

/// Pure-logic coverage for the league/MMR/season/efficiency/achievement
/// model. The Cloudflare worker mirrors these functions, so exact values
/// here pin the cross-surface contract.
final class LeaderboardAnalyticsTests: XCTestCase {

    // MARK: - Leagues

    func testLeagueThresholds_areContiguous() {
        for (i, tier) in LeagueTier.allCases.enumerated() {
            XCTAssertEqual(tier.index, i)
            if i < LeagueTier.allCases.count - 1 {
                XCTAssertEqual(tier.maxTokens, LeagueTier.allCases[i + 1].minTokens, "\(tier) upper bound must meet next lower bound")
            } else {
                XCTAssertNil(tier.maxTokens)
            }
        }
        XCTAssertEqual(LeagueTier.bronze.minTokens, 0)
        XCTAssertEqual(LeagueTier.grandmaster.minTokens, 100_000_000)
    }

    func testMMR_landsOnBandBoundariesAtThresholds() {
        // Token thresholds are the exact MMR band boundaries (before bonuses).
        XCTAssertEqual(LeaderboardAnalytics.mmr(tokensAll: 0, streakDays: 0, activeDays: 0, modelCount: 0), 0)
        XCTAssertEqual(LeaderboardAnalytics.mmr(tokensAll: 50_000, streakDays: 0, activeDays: 0, modelCount: 0), 400)
        XCTAssertEqual(LeaderboardAnalytics.mmr(tokensAll: 250_000, streakDays: 0, activeDays: 0, modelCount: 0), 800)
        XCTAssertEqual(LeaderboardAnalytics.mmr(tokensAll: 1_000_000, streakDays: 0, activeDays: 0, modelCount: 0), 1200)
        XCTAssertEqual(LeaderboardAnalytics.mmr(tokensAll: 5_000_000, streakDays: 0, activeDays: 0, modelCount: 0), 1600)
        XCTAssertEqual(LeaderboardAnalytics.mmr(tokensAll: 20_000_000, streakDays: 0, activeDays: 0, modelCount: 0), 2000)
        XCTAssertEqual(LeaderboardAnalytics.mmr(tokensAll: 100_000_000, streakDays: 0, activeDays: 0, modelCount: 0), 2400)
    }

    func testMMR_isMonotonicInTokens() {
        var previous = -1
        for exponent in stride(from: 0.0, through: 11.0, by: 0.25) {
            let tokens = Int(pow(10.0, exponent))
            let mmr = LeaderboardAnalytics.mmr(tokensAll: tokens, streakDays: 0, activeDays: 0, modelCount: 0)
            XCTAssertGreaterThanOrEqual(mmr, previous, "MMR regressed at 10^\(exponent)")
            previous = mmr
        }
    }

    func testMMR_bonusesPromoteAcrossBoundary() {
        let base = LeaderboardAnalytics.mmr(tokensAll: 900_000, streakDays: 0, activeDays: 0, modelCount: 0)
        let boosted = LeaderboardAnalytics.mmr(tokensAll: 900_000, streakDays: 10, activeDays: 25, modelCount: 6)
        XCTAssertGreaterThan(boosted, base)
        XCTAssertLessThanOrEqual(boosted - base, 60 + 50 + 40)
    }

    func testStanding_divisions() {
        XCTAssertEqual(LeaderboardAnalytics.standing(mmr: 1200).division, 3)
        XCTAssertEqual(LeaderboardAnalytics.standing(mmr: 1200).league, .platinum)
        XCTAssertEqual(LeaderboardAnalytics.standing(mmr: 1400).division, 2)
        XCTAssertEqual(LeaderboardAnalytics.standing(mmr: 1580).division, 1)
        XCTAssertEqual(LeaderboardAnalytics.standing(mmr: 1580).league, .platinum)
        XCTAssertEqual(LeaderboardAnalytics.standing(mmr: 1600).league, .diamond)
        XCTAssertEqual(LeaderboardAnalytics.standing(mmr: 2800).league, .grandmaster)
    }

    func testStanding_mmrToNext() {
        let standing = LeaderboardAnalytics.standing(mmr: 1300)
        XCTAssertEqual(standing.league, .platinum)
        XCTAssertEqual(standing.mmrToNext, 300) // diamond starts at 1600
        XCTAssertNil(LeaderboardAnalytics.standing(mmr: 3000).mmrToNext)
        XCTAssertEqual(standing.title, "Platinum III")
        XCTAssertEqual(LeaderboardAnalytics.standing(mmr: 1400).title, "Platinum II")
    }

    // MARK: - Seasons

    func testSeason_quarterlyAnchoredAt2026() {
        var comps = DateComponents()
        comps.year = 2026
        comps.month = 9
        comps.day = 11
        let date = Calendar.current.date(from: comps)!
        let season = LeaderboardAnalytics.season(at: date)
        XCTAssertEqual(season.id, "2026-Q3")
        XCTAssertEqual(season.number, 3)
        XCTAssertEqual(season.name, "Ascension")
        XCTAssertEqual(season.displayName, "Season 3 — Ascension")
        XCTAssertGreaterThan(season.daysRemaining, 0)
        XCTAssertTrue(season.start < date && date < season.end)
    }

    func testSeason_genesisIsFirstQuarter2026() {
        var comps = DateComponents()
        comps.year = 2026
        comps.month = 2
        comps.day = 1
        let season = LeaderboardAnalytics.season(at: Calendar.current.date(from: comps)!)
        XCTAssertEqual(season.number, 1)
        XCTAssertEqual(season.name, "Genesis")
    }

    // MARK: - Efficiency

    func testEfficiency_compositeAndBounds() {
        // cacheHit = 200/300, outputRatio = 50/150, freeShare = 0
        let score = LeaderboardAnalytics.efficiency(input: 100, output: 50, cacheRead: 200, totalTokens: 350, freeTokens: 0)
        XCTAssertEqual(score, 41.7, accuracy: 0.05)
        XCTAssertEqual(LeaderboardAnalytics.efficiency(input: 0, output: 0, cacheRead: 0, totalTokens: 0, freeTokens: 0), 0)
        // Perfect cache + all output + all free = 100, clamped.
        let perfect = LeaderboardAnalytics.efficiency(input: 0, output: 100, cacheRead: 100, totalTokens: 200, freeTokens: 200)
        XCTAssertEqual(perfect, 100)
    }

    // MARK: - Achievements

    func testAchievements_unlockRules() {
        let none = LeaderboardAnalytics.achievements(
            tokensAll: 0, requestsAll: 0, modelCount: 0, streakDays: 0,
            efficiency: 0, percentile: 0, seasonTokens: 0, cacheHitRate: 0)
        XCTAssertTrue(none.isEmpty)

        let all = LeaderboardAnalytics.achievements(
            tokensAll: 150_000_000, requestsAll: 2_000, modelCount: 8, streakDays: 40,
            efficiency: 95, percentile: 95, seasonTokens: 5_000_000, cacheHitRate: 80)
        let ids = Set(all.map(\.id))
        XCTAssertTrue(ids.isSuperset(of: [
            "century", "prompt_master", "model_explorer", "ten_million",
            "hundred_million", "efficiency_expert", "cost_conscious",
            "consistent_creator", "streak_master", "season_grinder", "top_decile"
        ]))
    }

    func testAchievements_partialUnlocks() {
        let some = LeaderboardAnalytics.achievements(
            tokensAll: 20_000_000, requestsAll: 150, modelCount: 2, streakDays: 7,
            efficiency: 50, percentile: 40, seasonTokens: 500_000, cacheHitRate: 30)
        let ids = Set(some.map(\.id))
        XCTAssertEqual(ids, ["century", "ten_million", "consistent_creator"])
    }
}
