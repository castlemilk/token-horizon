import Foundation

/// League tiers mirror the public ladder: token thresholds define the ladder,
/// MMR (calibrated to those thresholds plus consistency bonuses) defines the
/// in-league division. Both are pure functions so the worker can mirror them.
enum LeagueTier: String, CaseIterable, Identifiable, Codable {
    case bronze
    case silver
    case gold
    case platinum
    case diamond
    case master
    case grandmaster

    var id: String { rawValue }

    var title: String {
        switch self {
        case .bronze: return "Bronze"
        case .silver: return "Silver"
        case .gold: return "Gold"
        case .platinum: return "Platinum"
        case .diamond: return "Diamond"
        case .master: return "Master"
        case .grandmaster: return "Grandmaster"
        }
    }

    /// Inclusive lower token bound for the tier.
    var minTokens: Int {
        switch self {
        case .bronze: return 0
        case .silver: return 50_000
        case .gold: return 250_000
        case .platinum: return 1_000_000
        case .diamond: return 5_000_000
        case .master: return 20_000_000
        case .grandmaster: return 100_000_000
        }
    }

    /// Exclusive upper token bound; nil = unbounded.
    var maxTokens: Int? {
        switch self {
        case .bronze: return 50_000
        case .silver: return 250_000
        case .gold: return 1_000_000
        case .platinum: return 5_000_000
        case .diamond: return 20_000_000
        case .master: return 100_000_000
        case .grandmaster: return nil
        }
    }

    var index: Int { Self.allCases.firstIndex(of: self) ?? 0 }

    /// Fixed 400-point MMR band per tier.
    var mmrRange: ClosedRange<Int> {
        let low = index * 400
        return low...(low + 399)
    }

    var next: LeagueTier? {
        let i = index + 1
        return i < Self.allCases.count ? Self.allCases[i] : nil
    }

    var colorHex: String {
        switch self {
        case .bronze: return "#B0774B"
        case .silver: return "#AEB6C4"
        case .gold: return "#E0B44C"
        case .platinum: return "#4FC3F7"
        case .diamond: return "#7C6BF5"
        case .master: return "#B44CF0"
        case .grandmaster: return "#F0446B"
        }
    }

    static func from(_ raw: String?) -> LeagueTier? {
        guard let raw = raw?.lowercased(), !raw.isEmpty else { return nil }
        return Self.allCases.first { $0.rawValue == raw }
    }
}

struct LeagueStanding: Equatable {
    var league: LeagueTier
    var division: Int
    var mmr: Int
    var mmrToNext: Int?

    var title: String { "\(league.title) \(romanDivision)" }

    var romanDivision: String {
        switch division {
        case 1: return "I"
        case 2: return "II"
        default: return "III"
        }
    }

    var progressWithinLeague: Double {
        let range = league.mmrRange
        let span = Double(range.upperBound - range.lowerBound + 1)
        let pos = Double(min(max(mmr, range.lowerBound), range.upperBound) - range.lowerBound)
        return min(1, max(0, pos / span))
    }
}

struct LeaderboardSeason: Codable, Equatable {
    var id: String
    var number: Int
    var name: String
    var start: Date
    var end: Date
    var daysRemaining: Int

    static let names = ["Genesis", "Horizon", "Ascension", "Zenith"]

    var displayName: String { "Season \(number) — \(name)" }

    var progress: Double {
        let span = end.timeIntervalSince(start)
        guard span > 0 else { return 0 }
        return min(1, max(0, Date().timeIntervalSince(start) / span))
    }
}

struct LeaderboardAchievement: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var detail: String
    var icon: String
    var unlockedAt: Date?

    init(id: String, title: String, detail: String, icon: String, unlockedAt: Date? = nil) {
        self.id = id
        self.title = title
        self.detail = detail
        self.icon = icon
        self.unlockedAt = unlockedAt
    }
}

enum LeaderboardAnalytics {
    // MARK: - Seasons

    /// Quarterly seasons anchored at 2026-01-01 (Season 1 — Genesis).
    static func season(at date: Date = Date(), calendar: Calendar = .current) -> LeaderboardSeason {
        let genesisComponents = DateComponents(year: 2026, month: 1, day: 1)
        let genesis = calendar.date(from: genesisComponents) ?? Date(timeIntervalSince1970: 1_767_225_600)
        let year = calendar.component(.year, from: date)
        let month = calendar.component(.month, from: date)
        let quarter = (month - 1) / 3
        let seasonNumber = (year - 2026) * 4 + quarter + 1
        var startComps = DateComponents(year: year, month: quarter * 3 + 1, day: 1)
        let start = calendar.date(from: startComps) ?? date
        startComps.month = quarter * 3 + 4
        let end = calendar.date(from: startComps) ?? start.addingTimeInterval(90 * 86_400)
        let days = max(0, calendar.dateComponents([.day], from: date, to: end).day ?? 0)
        let name = LeaderboardSeason.names[(max(1, seasonNumber) - 1) % LeaderboardSeason.names.count]
        _ = genesis
        return LeaderboardSeason(
            id: String(format: "%d-Q%d", year, quarter + 1),
            number: seasonNumber,
            name: name,
            start: start,
            end: end,
            daysRemaining: days
        )
    }

    // MARK: - MMR & league

    /// MMR is calibrated so each ladder threshold lands on a 400-point band
    /// boundary, then log-interpolated inside the band. Consistency bonuses
    /// (streak, active days, model diversity) can promote across a boundary —
    /// "your LLM usage builds more than raw tokens."
    static func mmr(tokensAll: Int, streakDays: Int, activeDays: Int, modelCount: Int) -> Int {
        let tokens = max(0, tokensAll)
        var base: Double
        if let tier = LeagueTier.allCases.last(where: { tokens >= $0.minTokens }) {
            if let maxTokens = tier.maxTokens {
                let lo = Double(max(1, tier.minTokens))
                let hi = Double(maxTokens)
                let ratio = max(1, Double(tokens)) / lo
                let span = log(hi / lo)
                let progress = span > 0 ? min(1, max(0, log(ratio) / span)) : 0
                base = Double(tier.index) * 400 + progress * 400
            } else {
                // Grandmaster: 100M = band base, each decade of tokens adds a
                // full band (continuous with Master's interpolation at 100M).
                let overflow = log(max(1, Double(tokens) / Double(tier.minTokens))) / log(10)
                base = Double(tier.index) * 400 + min(1, max(0, overflow)) * 400
            }
        } else {
            base = 0
        }
        let streakBonus = min(60, max(0, streakDays) * 6)
        let activeBonus = min(50, activeDays * 2)
        let diversityBonus = min(40, max(0, modelCount - 1) * 8)
        return Int((base + Double(streakBonus + activeBonus + diversityBonus)).rounded())
    }

    static func standing(mmr: Int, tokensAll: Int = 0) -> LeagueStanding {
        let clamped = max(0, mmr)
        let tierIndex = min(LeagueTier.allCases.count - 1, clamped / 400)
        let league = LeagueTier.allCases[tierIndex]
        let range = league.mmrRange
        let pos = Double(min(max(clamped, range.lowerBound), range.upperBound) - range.lowerBound)
        let division: Int
        if pos < 133.34 { division = 3 }
        else if pos < 266.67 { division = 2 }
        else { division = 1 }
        let next = league.next
        _ = tokensAll
        return LeagueStanding(
            league: league,
            division: division,
            mmr: clamped,
            mmrToNext: next.map { $0.mmrRange.lowerBound - clamped }
        )
    }

    // MARK: - Efficiency

    /// 0–100 composite of real signals: prompt-cache hit rate (cost),
    /// output-to-input ratio (work), and free/local token share (spend).
    static func efficiency(input: Int, output: Int, cacheRead: Int, totalTokens: Int, freeTokens: Int) -> Double {
        guard totalTokens > 0 else { return 0 }
        let cacheHit = Double(cacheRead) / Double(max(1, cacheRead + input))
        let outputRatio = Double(output) / Double(max(1, input + output))
        let freeShare = Double(max(0, freeTokens)) / Double(max(1, totalTokens))
        let score = 0.45 * cacheHit + 0.35 * outputRatio + 0.20 * freeShare
        return min(100, max(0, (score * 1000).rounded() / 10))
    }

    // MARK: - Achievements

    static func achievements(
        tokensAll: Int,
        requestsAll: Int,
        modelCount: Int,
        streakDays: Int,
        efficiency: Double,
        percentile: Double,
        seasonTokens: Int,
        cacheHitRate: Double
    ) -> [LeaderboardAchievement] {
        var out: [LeaderboardAchievement] = []
        func add(_ id: String, _ title: String, _ detail: String, _ icon: String, _ unlocked: Bool) {
            if unlocked { out.append(LeaderboardAchievement(id: id, title: title, detail: detail, icon: icon)) }
        }
        add("century", "Century Club", "100+ requests logged", "💬", requestsAll >= 100)
        add("prompt_master", "Prompt Master", "1,000+ requests logged", "🏆", requestsAll >= 1_000)
        add("model_explorer", "Model Explorer", "Used 5+ different models", "🧭", modelCount >= 5)
        add("ten_million", "10M Tokens", "Crossed 10M all-time tokens", "📚", tokensAll >= 10_000_000)
        add("hundred_million", "100M Tokens", "Crossed 100M all-time tokens", "🌌", tokensAll >= 100_000_000)
        add("efficiency_expert", "Efficiency Expert", "Efficiency score of 90+", "⚡", efficiency >= 90)
        add("cost_conscious", "Cost Conscious", "60%+ prompt-cache hit rate", "🪙", cacheHitRate >= 60)
        add("consistent_creator", "Consistent Creator", "7-day usage streak", "🔥", streakDays >= 7)
        add("streak_master", "Streak Master", "30-day usage streak", "☄️", streakDays >= 30)
        add("season_grinder", "Season Grinder", "1M+ tokens this season", "🚀", seasonTokens >= 1_000_000)
        add("top_decile", "Top 10%", "Ranked in the global top 10%", "👑", percentile >= 90)
        return out
    }
}
