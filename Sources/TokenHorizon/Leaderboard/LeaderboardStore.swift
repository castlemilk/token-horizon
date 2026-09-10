import Foundation
#if canImport(AppKit)
import AppKit
#endif

enum LeaderboardPeriod: String, CaseIterable, Identifiable, Codable {
    case today = "today"
    case week = "week"
    case all = "all"
    case streak = "streak"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: return "Today"
        case .week: return "7 Days"
        case .all: return "All-Time"
        case .streak: return "Streak"
        }
    }

    static func from(query: String?) -> LeaderboardPeriod {
        guard let q = query?.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) else {
            return .today
        }
        switch q {
        case "today", "1d", "day": return .today
        case "week", "7d", "1w": return .week
        case "all", "alltime", "all-time", "total": return .all
        case "streak", "streaks": return .streak
        default: return .today
        }
    }
}

enum ShareCardFormat: String, CaseIterable, Identifiable, Codable {
    case text = "text"
    case markdown = "markdown"
    case json = "json"
    case svg = "svg"

    var id: String { rawValue }

    var contentType: String {
        switch self {
        case .text: return "text/plain; charset=utf-8"
        case .markdown: return "text/markdown; charset=utf-8"
        case .json: return "application/json; charset=utf-8"
        case .svg: return "image/svg+xml; charset=utf-8"
        }
    }

    static func from(query: String?) -> ShareCardFormat {
        guard let q = query?.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) else {
            return .text
        }
        switch q {
        case "markdown", "md": return .markdown
        case "json": return .json
        case "svg", "image": return .svg
        default: return .text
        }
    }
}

struct LeaderboardModelBreakdown: Codable, Identifiable, Equatable {
    var id: String { "\(provider)/\(model)" }
    var provider: String
    var model: String
    var tokensToday: Int
    var tokensAll: Int
    var costToday: Double
    var costAll: Double
    var sharePercent: Double
}

struct LeaderboardToolBreakdown: Codable, Identifiable, Equatable {
    var id: String { tool }
    var tool: String
    var tokensToday: Int
    var tokensAll: Int
    var costToday: Double
    var costAll: Double
}

struct LeaderboardDailyPoint: Codable, Identifiable, Equatable {
    var id: Int { day }
    var day: Int
    var dayLabel: String
    var tokens: Int
    var cost: Double
}

struct LeaderboardUsageBreakdown: Codable, Equatable {
    var models: [LeaderboardModelBreakdown] = []
    var tools: [LeaderboardToolBreakdown] = []
    var history: [LeaderboardDailyPoint] = []
    var activeDays: Int = 0
    var totalSessions: Int = 0
}

struct LeaderboardEntry: Codable, Identifiable, Equatable {
    var id: String
    var handle: String
    var team: String
    var tokensToday: Int
    var tokens7d: Int
    var tokensAll: Int
    var costToday: Double
    var cost7d: Double
    var costAll: Double
    var streakDays: Int
    var topModel: String
    var hardware: String
    var isLocal: Bool
    var updatedAt: Date
    var breakdown: LeaderboardUsageBreakdown? = nil

    var displayHandle: String {
        handle.hasPrefix("@") ? handle : "@\(handle)"
    }

    init(
        id: String,
        handle: String,
        team: String,
        tokensToday: Int,
        tokens7d: Int,
        tokensAll: Int,
        costToday: Double,
        cost7d: Double,
        costAll: Double,
        streakDays: Int,
        topModel: String,
        hardware: String,
        isLocal: Bool,
        updatedAt: Date,
        breakdown: LeaderboardUsageBreakdown? = nil
    ) {
        self.id = id
        self.handle = handle
        self.team = team
        self.tokensToday = tokensToday
        self.tokens7d = tokens7d
        self.tokensAll = tokensAll
        self.costToday = costToday
        self.cost7d = cost7d
        self.costAll = costAll
        self.streakDays = streakDays
        self.topModel = topModel
        self.hardware = hardware
        self.isLocal = isLocal
        self.updatedAt = updatedAt
        self.breakdown = breakdown
    }

    func resolvedBreakdown() -> LeaderboardUsageBreakdown {
        if let breakdown, !breakdown.models.isEmpty { return breakdown }
        let prov = topModel.lowercased().contains("claude") ? "claude" : (topModel.lowercased().contains("gpt") ? "openai" : (topModel.lowercased().contains("gemini") ? "gemini" : "ai"))
        let m = LeaderboardModelBreakdown(
            provider: prov,
            model: topModel,
            tokensToday: tokensToday,
            tokensAll: tokensAll,
            costToday: costToday,
            costAll: costAll,
            sharePercent: 100.0
        )
        let t = LeaderboardToolBreakdown(
            tool: prov,
            tokensToday: tokensToday,
            tokensAll: tokensAll,
            costToday: costToday,
            costAll: costAll
        )
        return LeaderboardUsageBreakdown(models: [m], tools: [t], history: [], activeDays: streakDays, totalSessions: 1)
    }
}

struct LeaderboardRankedEntry: Codable, Identifiable {
    var id: String { entry.id }
    var rank: Int
    var badge: String
    var percentile: Double
    var entry: LeaderboardEntry
    var score: Int
    var scoreFormatted: String
    var costFormatted: String
    var relativePercent: Double
}

final class LeaderboardStore {
    static let shared = LeaderboardStore()

    private let lock = NSLock()
    private let path: String
    private var entries: [LeaderboardEntry] = []

    init(customPath: String? = nil) {
        if let customPath {
            path = customPath
        } else {
            let dir = NSString(string: "~/.config/token-horizon").expandingTildeInPath
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            path = dir + "/leaderboard.json"
        }
        loadFromDisk()
    }

    private func loadFromDisk() {
        lock.lock()
        defer { lock.unlock() }

        guard let data = FileManager.default.contents(atPath: path) else {
            entries = []
            return
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        if let decoded = try? decoder.decode([LeaderboardEntry].self, from: data) {
            entries = decoded
        } else {
            entries = []
        }
    }

    private func saveLocked() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(entries) {
            try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
            chmod(path, 0o600)
        }
    }

    func allEntries() -> [LeaderboardEntry] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }

    func localEntry() -> LeaderboardEntry? {
        lock.lock()
        defer { lock.unlock() }
        return entries.first(where: { $0.isLocal })
    }

    func addOrUpdateEntry(_ entry: LeaderboardEntry) {
        lock.lock()
        defer { lock.unlock() }

        if let idx = entries.firstIndex(where: { $0.id == entry.id }) {
            entries[idx] = entry
        } else {
            entries.append(entry)
        }
        saveLocked()
    }

    func removeEntry(id: String) {
        lock.lock()
        defer { lock.unlock() }
        entries.removeAll(where: { $0.id == id })
        saveLocked()
    }

    func syncLocal(snapshot: UsageSnapshot, history: [HistoryPoint], streak: Int) {
        lock.lock()
        defer { lock.unlock() }

        let settings = SettingsStore.shared
        let handle = settings.leaderboardHandle.isEmpty ? NSUserName() : settings.leaderboardHandle
        let team = settings.leaderboardTeam
        let shareCost = settings.leaderboardShareCost
        let shareHardware = settings.leaderboardShareHardware

        // Compute 7-day tokens and cost from history
        let recent7 = history.suffix(7)
        let tokens7d = recent7.reduce(0) { $0 + $1.tokens }
        let cost7d = recent7.reduce(0.0) { $0 + $1.cost }

        // Top model resolution: highest all-time tokens or today
        let topModel: String = {
            if let best = snapshot.models.max(by: { $0.tokensAll < $1.tokensAll }) {
                return best.model
            }
            return "claude-3-7-sonnet"
        }()

        let hardware = shareHardware ? SystemStats.cpuBrandString() : "Apple Silicon"

        // Build model breakdown
        var modelBreakdowns: [LeaderboardModelBreakdown] = []
        let totalAllTokens = max(1, snapshot.tokensAllTime)
        for m in snapshot.models.sorted(by: { $0.tokensAll > $1.tokensAll }) {
            let share = Double(m.tokensAll) / Double(totalAllTokens) * 100.0
            modelBreakdowns.append(LeaderboardModelBreakdown(
                provider: m.provider,
                model: m.model,
                tokensToday: m.tokensToday,
                tokensAll: m.tokensAll,
                costToday: shareCost ? m.cost : 0.0,
                costAll: shareCost ? (m.estCost > 0 ? m.estCost : m.cost) : 0.0,
                sharePercent: share
            ))
        }

        // Build tool breakdown
        var toolBreakdowns: [LeaderboardToolBreakdown] = []
        for t in snapshot.perTool.sorted(by: { $0.tokensAllTime > $1.tokensAllTime }) {
            toolBreakdowns.append(LeaderboardToolBreakdown(
                tool: t.tool,
                tokensToday: t.tokensToday,
                tokensAll: t.tokensAllTime,
                costToday: shareCost ? t.costToday : 0.0,
                costAll: shareCost ? t.costAllTime : 0.0
            ))
        }

        // Build 7-day history points
        let df = DateFormatter()
        df.dateFormat = "EEE d"
        var historyPoints: [LeaderboardDailyPoint] = []
        for p in recent7 {
            let date = Date(timeIntervalSince1970: TimeInterval(p.day * 86400))
            historyPoints.append(LeaderboardDailyPoint(
                day: p.day,
                dayLabel: df.string(from: date),
                tokens: p.tokens,
                cost: shareCost ? p.cost : 0.0
            ))
        }

        let localBreakdown = LeaderboardUsageBreakdown(
            models: modelBreakdowns,
            tools: toolBreakdowns,
            history: historyPoints,
            activeDays: streak,
            totalSessions: snapshot.recentSessions.count
        )

        let local = LeaderboardEntry(
            id: "local:\(handle)",
            handle: handle,
            team: team,
            tokensToday: snapshot.tokensToday,
            tokens7d: max(tokens7d, snapshot.tokensToday),
            tokensAll: max(snapshot.tokensAllTime, snapshot.tokensToday),
            costToday: shareCost ? snapshot.costToday : 0.0,
            cost7d: shareCost ? cost7d : 0.0,
            costAll: shareCost ? snapshot.costAllTime : 0.0,
            streakDays: streak,
            topModel: topModel,
            hardware: hardware,
            isLocal: true,
            updatedAt: Date(),
            breakdown: localBreakdown
        )

        // Clear prior local entries to keep exactly one primary local
        entries.removeAll(where: { $0.isLocal })
        entries.append(local)

        // If multi-account Claude accounts exist, sync them as peer profiles
        for acct in snapshot.claudeAccounts where !acct.email.isEmpty {
            let acctHandle = acct.label.isEmpty ? acct.email : acct.label
            let acctId = "claude:\(acct.id)"
            let acctEntry = LeaderboardEntry(
                id: acctId,
                handle: "\(acctHandle) (Claude)",
                team: acct.organizationName.isEmpty ? team : acct.organizationName,
                tokensToday: acct.tokensToday,
                tokens7d: acct.tokensToday, // Best effort when account-scoped history isn't split
                tokensAll: acct.tokensAllTime,
                costToday: shareCost ? acct.costToday : 0.0,
                cost7d: shareCost ? acct.costToday : 0.0,
                costAll: shareCost ? acct.costAllTime : 0.0,
                streakDays: streak,
                topModel: "claude-3-7-sonnet",
                hardware: hardware,
                isLocal: false,
                updatedAt: acct.updatedAt
            )
            if let idx = entries.firstIndex(where: { $0.id == acctId }) {
                entries[idx] = acctEntry
            } else {
                entries.append(acctEntry)
            }
        }

        saveLocked()
    }

    func rankings(for period: LeaderboardPeriod, teamFilter: String? = nil) -> [LeaderboardRankedEntry] {
        lock.lock()
        var list = entries
        lock.unlock()

        if let t = teamFilter?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
            list = list.filter { $0.team.localizedCaseInsensitiveContains(t) }
        }

        // Sort based on period metric
        list.sort { a, b in
            switch period {
            case .today:
                if a.tokensToday != b.tokensToday { return a.tokensToday > b.tokensToday }
                return a.tokensAll > b.tokensAll
            case .week:
                if a.tokens7d != b.tokens7d { return a.tokens7d > b.tokens7d }
                return a.tokensAll > b.tokensAll
            case .all:
                if a.tokensAll != b.tokensAll { return a.tokensAll > b.tokensAll }
                return a.tokensToday > b.tokensToday
            case .streak:
                if a.streakDays != b.streakDays { return a.streakDays > b.streakDays }
                return a.tokensAll > b.tokensAll
            }
        }

        let total = max(1, list.count)
        let maxScore: Double = {
            guard let first = list.first else { return 1.0 }
            switch period {
            case .today: return Double(max(1, first.tokensToday))
            case .week: return Double(max(1, first.tokens7d))
            case .all: return Double(max(1, first.tokensAll))
            case .streak: return Double(max(1, first.streakDays))
            }
        }()

        return list.enumerated().map { idx, item in
            let rank = idx + 1
            let score: Int
            let scoreFormatted: String
            let costFormatted: String

            switch period {
            case .today:
                score = item.tokensToday
                scoreFormatted = UsageSnapshot.tokens(item.tokensToday)
                costFormatted = item.costToday > 0 ? UsageSnapshot.cost(item.costToday) : "$0.00"
            case .week:
                score = item.tokens7d
                scoreFormatted = UsageSnapshot.tokens(item.tokens7d)
                costFormatted = item.cost7d > 0 ? UsageSnapshot.cost(item.cost7d) : "$0.00"
            case .all:
                score = item.tokensAll
                scoreFormatted = UsageSnapshot.tokens(item.tokensAll)
                costFormatted = item.costAll > 0 ? UsageSnapshot.cost(item.costAll) : "$0.00"
            case .streak:
                score = item.streakDays
                scoreFormatted = "\(item.streakDays)d"
                costFormatted = item.costToday > 0 ? UsageSnapshot.cost(item.costToday) : "$0.00"
            }

            let badge: String = {
                switch rank {
                case 1: return "🥇 1st"
                case 2: return "🥈 2nd"
                case 3: return "🥉 3rd"
                default:
                    if item.streakDays >= 7 && period != .streak {
                        return "🔥 \(item.streakDays)d"
                    }
                    return "#\(rank)"
                }
            }()

            let relativePercent = min(100.0, max(1.0, (Double(score) / maxScore) * 100.0))
            let percentile = max(1.0, (Double(total - rank + 1) / Double(total)) * 100.0)

            return LeaderboardRankedEntry(
                rank: rank,
                badge: badge,
                percentile: (percentile * 10).rounded() / 10,
                entry: item,
                score: score,
                scoreFormatted: scoreFormatted,
                costFormatted: costFormatted,
                relativePercent: (relativePercent * 10).rounded() / 10
            )
        }
    }

    func generateShareCard(for period: LeaderboardPeriod, format: ShareCardFormat, entryId: String? = nil) -> String {
        let ranked = rankings(for: period)
        let target: LeaderboardRankedEntry
        if let entryId, let found = ranked.first(where: { $0.id == entryId }) {
            target = found
        } else if let local = ranked.first(where: { $0.entry.isLocal }) {
            target = local
        } else if let first = ranked.first {
            target = first
        } else {
            // Fallback synthetic entry
            let def = LeaderboardEntry(
                id: "local",
                handle: NSUserName(),
                team: "",
                tokensToday: 0,
                tokens7d: 0,
                tokensAll: 0,
                costToday: 0,
                cost7d: 0,
                costAll: 0,
                streakDays: 0,
                topModel: "claude-3-7-sonnet",
                hardware: SystemStats.cpuBrandString(),
                isLocal: true,
                updatedAt: Date()
            )
            target = LeaderboardRankedEntry(
                rank: 1,
                badge: "🥇 1st",
                percentile: 100.0,
                entry: def,
                score: 0,
                scoreFormatted: "0",
                costFormatted: "$0.00",
                relativePercent: 100.0
            )
        }

        switch format {
        case .text:
            return generateTextCard(target: target, period: period)
        case .markdown:
            return generateMarkdownCard(target: target, period: period)
        case .json:
            return generateJsonCard(target: target, period: period)
        case .svg:
            return generateSvgCard(target: target, period: period)
        }
    }

    private func generateTextCard(target: LeaderboardRankedEntry, period: LeaderboardPeriod) -> String {
        let e = target.entry
        let handle = e.displayHandle
        let teamPart = e.team.isEmpty ? "" : "  Team: \(e.team)"
        let hw = e.hardware.isEmpty ? "Apple Silicon" : e.hardware
        let costTodayStr = e.costToday > 0 ? UsageSnapshot.cost(e.costToday) : "$0.00"

        return """
        ╭─────────────────────────────────────────────────────────────╮
        │ 🌌 TOKEN HORIZON LEADERBOARD                                │
        │ Participant: \(handle.padding(toLength: 20, withPad: " ", startingAt: 0))\(teamPart)
        │ Hardware: \(hw.padding(toLength: 47, withPad: " ", startingAt: 0))│
        ├─────────────────────────────────────────────────────────────┤
        │ Period: \(period.title.uppercased().padding(toLength: 16, withPad: " ", startingAt: 0))Rank: \(target.badge) (Top \(String(format: "%.0f%%", target.percentile)))
        │ Tokens Today: \(UsageSnapshot.tokens(e.tokensToday).padding(toLength: 12, withPad: " ", startingAt: 0))Cost: \(costTodayStr.padding(toLength: 18, withPad: " ", startingAt: 0))│
        │ 7-Day Volume: \(UsageSnapshot.tokens(e.tokens7d).padding(toLength: 12, withPad: " ", startingAt: 0))All-Time: \(UsageSnapshot.tokens(e.tokensAll).padding(toLength: 14, withPad: " ", startingAt: 0))│
        │ Active Streak: \("\(e.streakDays) Days 🔥".padding(toLength: 11, withPad: " ", startingAt: 0))Top Model: \(e.topModel)
        ╰─────────────────────────────────────────────────────────────╯
        """
    }

    private func generateMarkdownCard(target: LeaderboardRankedEntry, period: LeaderboardPeriod) -> String {
        let e = target.entry
        let handle = e.displayHandle
        let teamBadge = e.team.isEmpty ? "" : " · `\(e.team)`"
        let hw = e.hardware.isEmpty ? "Apple Silicon" : e.hardware
        let costTodayStr = e.costToday > 0 ? UsageSnapshot.cost(e.costToday) : "$0.00"
        let cost7dStr = e.cost7d > 0 ? UsageSnapshot.cost(e.cost7d) : "$0.00"
        let costAllStr = e.costAll > 0 ? UsageSnapshot.cost(e.costAll) : "$0.00"

        return """
        ### 🌌 Token Horizon Usage Card

        **\(handle)**\(teamBadge)
        *Hardware:* \(hw)

        | Metric | Value | Rank & Status |
        | :--- | :--- | :--- |
        | **Leaderboard Rank** | **\(target.badge)** | Top \(String(format: "%.0f%%", target.percentile)) in \(period.title) |
        | **Today's Tokens** | `\(UsageSnapshot.tokens(e.tokensToday))` | \(costTodayStr) |
        | **7-Day Rolling** | `\(UsageSnapshot.tokens(e.tokens7d))` | \(cost7dStr) |
        | **All-Time Tokens** | `\(UsageSnapshot.tokens(e.tokensAll))` | \(costAllStr) |
        | **Active Streak** | 🔥 \(e.streakDays) Days | Consecutive Active Days |
        | **Top AI Model** | `\(e.topModel)` | Most utilized architecture |

        *Generated by [Token Horizon](https://github.com/castlemilk/token-horizon)*
        """
    }

    private func generateJsonCard(target: LeaderboardRankedEntry, period: LeaderboardPeriod) -> String {
        let e = target.entry
        let dict: [String: Any] = [
            "handle": e.displayHandle,
            "team": e.team,
            "hardware": e.hardware,
            "period": period.rawValue,
            "periodTitle": period.title,
            "rank": target.rank,
            "badge": target.badge,
            "percentile": target.percentile,
            "tokensToday": e.tokensToday,
            "tokensTodayFormatted": UsageSnapshot.tokens(e.tokensToday),
            "tokens7d": e.tokens7d,
            "tokens7dFormatted": UsageSnapshot.tokens(e.tokens7d),
            "tokensAll": e.tokensAll,
            "tokensAllFormatted": UsageSnapshot.tokens(e.tokensAll),
            "costToday": e.costToday,
            "cost7d": e.cost7d,
            "costAll": e.costAll,
            "streakDays": e.streakDays,
            "topModel": e.topModel,
            "generatedAt": ISO8601DateFormatter().string(from: Date())
        ]
        if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys]) {
            return String(decoding: data, as: UTF8.self)
        }
        return "{}"
    }

    private func generateSvgCard(target: LeaderboardRankedEntry, period: LeaderboardPeriod) -> String {
        let e = target.entry
        let handle = e.displayHandle
        let team = e.team.isEmpty ? "PERSONAL" : e.team.uppercased()
        let hw = e.hardware.isEmpty ? "Apple Silicon" : e.hardware
        let topTokens = UsageSnapshot.tokens(target.score)
        let allTokens = UsageSnapshot.tokens(e.tokensAll)
        let topModel = e.topModel
        let streak = "\(e.streakDays)d"
        let rankBadge = target.badge

        return """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 260" width="540" height="260" style="font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;">
          <defs>
            <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#090D16" />
              <stop offset="50%" stop-color="#111827" />
              <stop offset="100%" stop-color="#1A2035" />
            </linearGradient>
            <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="#6366F1" />
              <stop offset="50%" stop-color="#8B5CF6" />
              <stop offset="100%" stop-color="#EC4899" />
            </linearGradient>
            <linearGradient id="glowGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.3" />
              <stop offset="100%" stop-color="#6366F1" stop-opacity="0.0" />
            </linearGradient>
            <filter id="cardShadow" x="-5%" y="-5%" width="110%" height="110%">
              <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.6" />
            </filter>
          </defs>

          <!-- Main Background -->
          <rect x="10" y="10" width="520" height="240" rx="16" fill="url(#bgGrad)" stroke="#2E3856" stroke-width="1.2" filter="url(#cardShadow)" />
          <rect x="10" y="10" width="520" height="4" rx="2" fill="url(#accentGrad)" />

          <!-- Top Brand Header -->
          <g transform="translate(30, 36)">
            <text font-size="9" font-weight="800" letter-spacing="1.5" fill="#818CF8">TOKEN HORIZON · LEADERBOARD</text>
            <rect x="360" y="-12" width="120" height="20" rx="10" fill="#1E293B" stroke="#334155" stroke-width="1" />
            <text x="420" y="1" font-size="9" font-weight="700" fill="#F8FAFC" text-anchor="middle">\(period.title.uppercased())</text>
          </g>

          <!-- User Identity & Rank Header -->
          <g transform="translate(30, 74)">
            <text font-size="20" font-weight="800" fill="#FFFFFF">\(handle)</text>
            <rect x="0" y="8" width="55" height="15" rx="3" fill="#1E293B" />
            <text x="5" y="19" font-size="8" font-weight="700" fill="#94A3B8">\(team)</text>
            <text x="68" y="19" font-size="9" font-weight="500" fill="#64748B">\(hw)</text>

            <!-- Rank Badge -->
            <rect x="340" y="-18" width="140" height="34" rx="8" fill="#1E1B4B" stroke="#6366F1" stroke-width="1.2" />
            <text x="410" y="4" font-size="13" font-weight="800" fill="#A5B4FC" text-anchor="middle">\(rankBadge)</text>
          </g>

          <!-- 4 KPI Cards Grid -->
          <g transform="translate(30, 120)">
            <!-- Card 1: Period Volume -->
            <rect x="0" y="0" width="112" height="74" rx="8" fill="#151C2C" stroke="#232E48" stroke-width="1" />
            <text x="12" y="20" font-size="8.5" font-weight="700" fill="#64748B">\(period.title.uppercased())</text>
            <text x="12" y="46" font-size="18" font-weight="800" fill="#38BDF8">\(topTokens)</text>
            <text x="12" y="62" font-size="8" font-weight="600" fill="#0284C7">Tokens</text>

            <!-- Card 2: Streak -->
            <rect x="122" y="0" width="112" height="74" rx="8" fill="#151C2C" stroke="#232E48" stroke-width="1" />
            <text x="134" y="20" font-size="8.5" font-weight="700" fill="#64748B">STREAK</text>
            <text x="134" y="46" font-size="18" font-weight="800" fill="#F97316">\(streak)</text>
            <text x="134" y="62" font-size="8" font-weight="600" fill="#EA580C">Active Days 🔥</text>

            <!-- Card 3: All-Time -->
            <rect x="244" y="0" width="112" height="74" rx="8" fill="#151C2C" stroke="#232E48" stroke-width="1" />
            <text x="256" y="20" font-size="8.5" font-weight="700" fill="#64748B">ALL-TIME</text>
            <text x="256" y="46" font-size="18" font-weight="800" fill="#A855F7">\(allTokens)</text>
            <text x="256" y="62" font-size="8" font-weight="600" fill="#9333EA">Total Tokens</text>

            <!-- Card 4: Top Model -->
            <rect x="366" y="0" width="114" height="74" rx="8" fill="#151C2C" stroke="#232E48" stroke-width="1" />
            <text x="378" y="20" font-size="8.5" font-weight="700" fill="#64748B">TOP MODEL</text>
            <text x="378" y="44" font-size="10.5" font-weight="700" fill="#34D399">\(topModel)</text>
            <text x="378" y="62" font-size="8" font-weight="600" fill="#059669">Primary LLM</text>
          </g>

          <!-- Footer Watermark -->
          <g transform="translate(30, 226)">
            <circle cx="4" cy="-4" r="3" fill="#10B981" />
            <text x="14" y="-1" font-size="8" font-weight="500" fill="#64748B">Live verified stats · castlemilk/token-horizon</text>
          </g>
        </svg>
        """
    }

    func copyShareCard(for period: LeaderboardPeriod, format: ShareCardFormat, entryId: String? = nil) -> Bool {
        let content = generateShareCard(for: period, format: format, entryId: entryId)
        #if canImport(AppKit)
        let pb = NSPasteboard.general
        pb.clearContents()
        return pb.setString(content, forType: .string)
        #else
        return false
        #endif
    }

    // MARK: - Google Spreadsheet Backend Sync

    static func resolveGoogleSheetsURL(_ raw: String) -> (readURL: URL?, writeURL: URL?) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return (nil, nil) }

        if trimmed.contains("script.google.com/macros/s/") {
            let u = URL(string: trimmed)
            return (u, u)
        }

        if trimmed.contains("docs.google.com/spreadsheets/d/") {
            // Extract Sheet ID
            if let regex = try? NSRegularExpression(pattern: "/spreadsheets/d/([a-zA-Z0-9-_]+)"),
               let match = regex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
               let range = Range(match.range(at: 1), in: trimmed) {
                let sheetId = String(trimmed[range])
                let csvURL = URL(string: "https://docs.google.com/spreadsheets/d/\(sheetId)/gviz/tq?tqx=out:csv")
                return (csvURL, nil)
            }
        }

        let u = URL(string: trimmed)
        return (u, u)
    }

    func publishToGoogleSheet(forced: Bool = false, completion: @escaping (Result<String, Error>) -> Void) {
        let settings = SettingsStore.shared
        let rawURL = settings.leaderboardSheetsURL
        guard !rawURL.isEmpty else {
            completion(.failure(NSError(domain: "TokenHorizon", code: 400, userInfo: [NSLocalizedDescriptionKey: "No Google Sheets / Webhook URL configured in Settings."])))
            return
        }

        let resolved = Self.resolveGoogleSheetsURL(rawURL)
        guard let writeURL = resolved.writeURL else {
            completion(.failure(NSError(domain: "TokenHorizon", code: 400, userInfo: [NSLocalizedDescriptionKey: "Configured URL does not support writing. Please use a Google Apps Script Web App URL for publishing."])))
            return
        }

        guard let local = localEntry() else {
            completion(.failure(NSError(domain: "TokenHorizon", code: 404, userInfo: [NSLocalizedDescriptionKey: "No local token usage entry found to publish."])))
            return
        }

        // Same change-gating as cloud: Sheets cold-starts are slow, so only
        // publish on a real schedule or material local movement.
        lock.lock()
        let due = LeaderboardSyncPolicy.shouldPublish(now: Date(), lastPublish: lastPublishAt["sheets"], lastTokens: lastPublishedTokens["sheets"], currentTokens: local.tokensAll, forced: forced)
        lock.unlock()
        guard due else {
            completion(.success("Board is already up to date."))
            return
        }

        var req = URLRequest(url: writeURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload: [String: Any] = [
            "action": "publish",
            "entry": [
                "id": local.id,
                "handle": local.handle,
                "team": local.team,
                "tokensToday": local.tokensToday,
                "tokens7d": local.tokens7d,
                "tokensAll": local.tokensAll,
                "costToday": local.costToday,
                "cost7d": local.cost7d,
                "costAll": local.costAll,
                "streakDays": local.streakDays,
                "topModel": local.topModel,
                "hardware": local.hardware,
                "updatedAt": local.updatedAt.timeIntervalSince1970
            ]
        ]

        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            completion(.failure(NSError(domain: "TokenHorizon", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to serialize entry JSON."])))
            return
        }
        req.httpBody = body

        let task = URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            if let err {
                completion(.failure(err))
                return
            }
            self?.lock.lock()
            self?.lastPublishAt["sheets"] = Date()
            self?.lastPublishedTokens["sheets"] = local.tokensAll
            self?.lock.unlock()
            if let data, let str = String(data: data, encoding: .utf8) {
                completion(.success(str.trimmingCharacters(in: .whitespacesAndNewlines)))
            } else {
                completion(.success("Published @\(local.handle) to Google Sheet."))
            }
        }
        task.resume()
    }

    func pullFromGoogleSheet(forced: Bool = false, completion: @escaping (Result<Int, Error>) -> Void) {
        let settings = SettingsStore.shared
        let rawURL = settings.leaderboardSheetsURL
        guard !rawURL.isEmpty else {
            completion(.failure(NSError(domain: "TokenHorizon", code: 400, userInfo: [NSLocalizedDescriptionKey: "No Google Sheets / Webhook URL configured in Settings."])))
            return
        }

        let resolved = Self.resolveGoogleSheetsURL(rawURL)
        guard let readURL = resolved.readURL else {
            completion(.failure(NSError(domain: "TokenHorizon", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid Google Sheets URL."])))
            return
        }

        lock.lock()
        let due = LeaderboardSyncPolicy.shouldPull(now: Date(), lastPull: lastPullAt["sheets"], forced: forced)
        let cachedCount = entries.count
        lock.unlock()
        guard due else {
            completion(.success(cachedCount))
            return
        }

        var req = URLRequest(url: readURL)
        req.httpMethod = "GET"
        req.timeoutInterval = 10.0

        let task = URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            guard let self else { return }
            if let err {
                completion(.failure(err))
                return
            }
            guard let data, !data.isEmpty else {
                completion(.failure(NSError(domain: "TokenHorizon", code: 500, userInfo: [NSLocalizedDescriptionKey: "Empty response from Google Sheet."])))
                return
            }

            var parsedEntries: [LeaderboardEntry] = []

            // Check if response is JSON (Apps Script web app)
            if let jsonObj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let list = jsonObj["leaderboard"] as? [[String: Any]] {
                for item in list {
                    if let entry = Self.entryFromDict(item) {
                        parsedEntries.append(entry)
                    }
                }
            } else if let jsonArr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                for item in jsonArr {
                    if let entry = Self.entryFromDict(item) {
                        parsedEntries.append(entry)
                    }
                }
            } else if let csvStr = String(data: data, encoding: .utf8) {
                // Parse CSV
                let rows = Self.parseCSV(csvStr)
                parsedEntries = Self.parseEntriesFromCSV(rows)
            }

            guard !parsedEntries.isEmpty else {
                completion(.failure(NSError(domain: "TokenHorizon", code: 422, userInfo: [NSLocalizedDescriptionKey: "No valid leaderboard rows parsed from Google Sheet."])))
                return
            }

            self.lock.lock()
            let local = self.entries.first(where: { $0.isLocal })
            for var remote in parsedEntries {
                // Skip or don't overwrite local host identity
                if let local, remote.handle.localizedCaseInsensitiveCompare(local.handle) == .orderedSame {
                    continue
                }
                remote.isLocal = false
                if let idx = self.entries.firstIndex(where: { $0.handle.localizedCaseInsensitiveCompare(remote.handle) == .orderedSame || $0.id == remote.id }) {
                    self.entries[idx] = remote
                } else {
                    self.entries.append(remote)
                }
            }
            self.lastPullAt["sheets"] = Date()
            self.saveLocked()
            let count = self.entries.count
            self.lock.unlock()

            completion(.success(count))
        }
        task.resume()
    }

    static func entryFromDict(_ dict: [String: Any]) -> LeaderboardEntry? {
        let d = (dict["entry"] as? [String: Any]) ?? dict
        guard let handle = d["handle"] as? String, !handle.isEmpty else { return nil }
        let team = d["team"] as? String ?? ""
        let tokensToday = d["tokensToday"] as? Int ?? (d["today"] as? Int ?? 0)
        let tokens7d = d["tokens7d"] as? Int ?? (d["week"] as? Int ?? 0)
        let tokensAll = d["tokensAll"] as? Int ?? (d["all"] as? Int ?? 0)
        let costToday = d["costToday"] as? Double ?? 0.0
        let cost7d = d["cost7d"] as? Double ?? 0.0
        let costAll = d["costAll"] as? Double ?? 0.0
        let streakDays = d["streakDays"] as? Int ?? (d["streak"] as? Int ?? 0)
        let topModel = d["topModel"] as? String ?? "claude-3-7-sonnet"
        let hardware = d["hardware"] as? String ?? "Apple Silicon"
        let updatedAt = (d["updatedAt"] as? Double).map { Date(timeIntervalSince1970: $0) } ?? Date()
        var breakdown: LeaderboardUsageBreakdown? = nil
        if let bd = d["breakdown"] as? [String: Any] {
            var models: [LeaderboardModelBreakdown] = []
            if let ml = bd["models"] as? [[String: Any]] {
                for m in ml {
                    guard let model = m["model"] as? String else { continue }
                    let prov = m["provider"] as? String ?? "ai"
                    let tokToday = m["tokensToday"] as? Int ?? (m["today"] as? Int ?? 0)
                    let tokAll = m["tokensAll"] as? Int ?? (m["all"] as? Int ?? 0)
                    let cToday = m["costToday"] as? Double ?? (m["cost"] as? Double ?? 0.0)
                    let cAll = m["costAll"] as? Double ?? 0.0
                    let share = m["sharePercent"] as? Double ?? 0.0
                    models.append(LeaderboardModelBreakdown(provider: prov, model: model, tokensToday: tokToday, tokensAll: tokAll, costToday: cToday, costAll: cAll, sharePercent: share))
                }
            }
            var tools: [LeaderboardToolBreakdown] = []
            if let tl = bd["tools"] as? [[String: Any]] {
                for t in tl {
                    guard let tool = t["tool"] as? String else { continue }
                    let tokToday = t["tokensToday"] as? Int ?? 0
                    let tokAll = t["tokensAll"] as? Int ?? 0
                    let cToday = t["costToday"] as? Double ?? 0.0
                    let cAll = t["costAll"] as? Double ?? 0.0
                    tools.append(LeaderboardToolBreakdown(tool: tool, tokensToday: tokToday, tokensAll: tokAll, costToday: cToday, costAll: cAll))
                }
            }
            var historyPts: [LeaderboardDailyPoint] = []
            if let hl = bd["history"] as? [[String: Any]] {
                for h in hl {
                    let day = h["day"] as? Int ?? 0
                    let label = h["dayLabel"] as? String ?? ""
                    let tok = h["tokens"] as? Int ?? 0
                    let cost = h["cost"] as? Double ?? 0.0
                    historyPts.append(LeaderboardDailyPoint(day: day, dayLabel: label, tokens: tok, cost: cost))
                }
            }
            breakdown = LeaderboardUsageBreakdown(
                models: models,
                tools: tools,
                history: historyPts,
                activeDays: bd["activeDays"] as? Int ?? streakDays,
                totalSessions: bd["totalSessions"] as? Int ?? 0
            )
        }

        return LeaderboardEntry(
            id: d["id"] as? String ?? "sheet:\(handle)",
            handle: handle,
            team: team,
            tokensToday: tokensToday,
            tokens7d: tokens7d,
            tokensAll: tokensAll,
            costToday: costToday,
            cost7d: cost7d,
            costAll: costAll,
            streakDays: streakDays,
            topModel: topModel,
            hardware: hardware,
            isLocal: false,
            updatedAt: updatedAt,
            breakdown: breakdown
        )
    }

    static func parseCSV(_ text: String) -> [[String]] {
        var rows: [[String]] = []
        var currentRow: [String] = []
        var currentField = ""
        var inQuotes = false

        for char in text {
            if char == "\"" {
                inQuotes.toggle()
            } else if char == "," && !inQuotes {
                currentRow.append(currentField.trimmingCharacters(in: .whitespaces))
                currentField = ""
            } else if (char == "\r" || char == "\n") && !inQuotes {
                currentRow.append(currentField.trimmingCharacters(in: .whitespaces))
                currentField = ""
                if !currentRow.isEmpty && currentRow.contains(where: { !$0.isEmpty }) {
                    rows.append(currentRow)
                }
                currentRow = []
            } else {
                currentField.append(char)
            }
        }
        if !currentField.isEmpty || !currentRow.isEmpty {
            currentRow.append(currentField.trimmingCharacters(in: .whitespaces))
            if !currentRow.isEmpty && currentRow.contains(where: { !$0.isEmpty }) {
                rows.append(currentRow)
            }
        }
        return rows
    }

    static func parseEntriesFromCSV(_ rows: [[String]]) -> [LeaderboardEntry] {
        guard rows.count >= 2 else { return [] }
        let headers = rows[0].map { $0.lowercased().replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "") }

        func colIdx(_ names: [String]) -> Int? {
            for name in names {
                if let idx = headers.firstIndex(of: name) { return idx }
            }
            return nil
        }

        let handleIdx = colIdx(["handle", "participant", "user", "username", "name"]) ?? 0
        let teamIdx = colIdx(["team", "org", "organization"])
        let todayIdx = colIdx(["tokenstoday", "today", "todaytokens", "daytokens", "tokensday"])
        let weekIdx = colIdx(["tokens7d", "7d", "week", "tokensweek", "tokens7days", "weeklytokens"])
        let allIdx = colIdx(["tokensalltime", "tokensall", "alltime", "all", "total", "totaltokens", "lifetime", "tokenslifetime"])
        let costTodayIdx = colIdx(["costtoday", "cost", "todaycost"])
        let cost7dIdx = colIdx(["cost7d", "costweek", "weekcost", "cost7days"])
        let costAllIdx = colIdx(["costalltime", "costall", "costtotal", "totalcost", "alltimecost"])
        let streakIdx = colIdx(["streak", "streakdays", "activedays", "daysstreak"])
        let modelIdx = colIdx(["topmodel", "model", "llm", "primarymodel"])
        let hwIdx = colIdx(["hardware", "hw", "chip", "cpu", "device"])

        var out: [LeaderboardEntry] = []
        for r in rows.dropFirst() {
            guard r.indices.contains(handleIdx) else { continue }
            let handle = r[handleIdx].replacingOccurrences(of: "@", with: "").trimmingCharacters(in: .whitespaces)
            guard !handle.isEmpty else { continue }

            func intVal(_ idx: Int?) -> Int {
                guard let idx, r.indices.contains(idx) else { return 0 }
                let cleaned = r[idx].replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "B", with: "000000000").replacingOccurrences(of: "M", with: "000000").replacingOccurrences(of: "k", with: "000")
                return Int(Double(cleaned) ?? 0)
            }
            func dblVal(_ idx: Int?) -> Double {
                guard let idx, r.indices.contains(idx) else { return 0.0 }
                let cleaned = r[idx].replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "")
                return Double(cleaned) ?? 0.0
            }

            let team = teamIdx.flatMap { r.indices.contains($0) ? r[$0] : nil } ?? ""
            let tokensToday = intVal(todayIdx)
            let tokens7d = intVal(weekIdx)
            let tokensAll = intVal(allIdx)
            let costToday = dblVal(costTodayIdx)
            let cost7d = dblVal(cost7dIdx)
            let costAll = dblVal(costAllIdx)
            let streakDays = intVal(streakIdx)
            let topModel = (modelIdx.flatMap { r.indices.contains($0) ? r[$0] : nil } ?? "").isEmpty ? "claude-3-7-sonnet" : r[modelIdx!]
            let hardware = (hwIdx.flatMap { r.indices.contains($0) ? r[$0] : nil } ?? "").isEmpty ? "Apple Silicon" : r[hwIdx!]

            out.append(LeaderboardEntry(
                id: "sheet:\(handle)",
                handle: handle,
                team: team,
                tokensToday: tokensToday,
                tokens7d: tokens7d,
                tokensAll: tokensAll,
                costToday: costToday,
                cost7d: cost7d,
                costAll: costAll,
                streakDays: streakDays,
                topModel: topModel,
                hardware: hardware,
                isLocal: false,
                updatedAt: Date()
            ))
        }
        return out
    }

    // MARK: - Intelligent sync (TTL + change-gated, stale-while-revalidate)
    //
    // Rankings always serve instantly from memory. Network only fires past
    // TTL (or when forced from UI/MCP), publishes only when local totals
    // moved materially, and cloud reads use ETag so unchanged boards cost a
    // 304 with no parse. This is what keeps auto-sync from hammering the
    // backend every refresh tick.

    private var lastPullAt: [String: Date] = [:]
    private var lastPublishAt: [String: Date] = [:]
    private var lastPublishedTokens: [String: Int] = [:]
    private var cloudEtag: String?

    static func headerValue(_ response: URLResponse?, _ name: String) -> String? {
        guard let http = response as? HTTPURLResponse else { return nil }
        for (key, value) in http.allHeaderFields {
            if (key as? String)?.lowercased() == name.lowercased(), let str = value as? String {
                return str
            }
        }
        return nil
    }

    /// Pure remote merge shared by every pull path (tested): remote rows never
    /// overwrite the local host identity; matches by id, else
    /// case-insensitive handle; anything else appends.
    static func mergeRemoteEntries(current: [LeaderboardEntry], local: LeaderboardEntry?, remote: [LeaderboardEntry]) -> [LeaderboardEntry] {
        var out = current
        for var entry in remote {
            if let local, entry.handle.localizedCaseInsensitiveCompare(local.handle) == .orderedSame {
                continue
            }
            entry.isLocal = false
            if let idx = out.firstIndex(where: { $0.handle.localizedCaseInsensitiveCompare(entry.handle) == .orderedSame || $0.id == entry.id }) {
                out[idx] = entry
            } else {
                out.append(entry)
            }
        }
        return out
    }

    func cloudBaseURL() -> String? {
        let base = SettingsStore.shared.leaderboardCloudURL
        return base.isEmpty ? nil : base
    }

    func cloudLeaderboardURL() -> URL? {
        guard let base = cloudBaseURL() else { return nil }
        let trimmed = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmed.hasSuffix("/leaderboard") {
            return URL(string: trimmed)
        }
        if trimmed.hasSuffix("/api") {
            return URL(string: "\(trimmed)/leaderboard")
        }
        return URL(string: "\(trimmed)/api/leaderboard")
    }

    /// Pull the team board from the Cloudflare Worker + R2 backend.
    func pullFromCloud(forced: Bool = false, completion: @escaping (Result<Int, Error>) -> Void) {
        guard let url = cloudLeaderboardURL() else {
            completion(.failure(NSError(domain: "TokenHorizon", code: 400, userInfo: [NSLocalizedDescriptionKey: "No cloud leaderboard URL configured in Settings."])))
            return
        }
        lock.lock()
        let due = LeaderboardSyncPolicy.shouldPull(now: Date(), lastPull: lastPullAt["cloud"], forced: forced)
        let etag = cloudEtag
        let cachedCount = entries.count
        lock.unlock()
        guard due else {
            completion(.success(cachedCount))
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 8.0
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let etag, !forced {
            req.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            guard let self else { return }
            if let err {
                completion(.failure(err))
                return
            }
            guard let http = resp as? HTTPURLResponse else {
                completion(.failure(NSError(domain: "TokenHorizon", code: 500, userInfo: [NSLocalizedDescriptionKey: "No HTTP response from leaderboard cloud."])))
                return
            }
            if http.statusCode == 304 {
                self.lock.lock()
                self.lastPullAt["cloud"] = Date()
                let count = self.entries.count
                self.lock.unlock()
                completion(.success(count))
                return
            }
            guard (200..<300).contains(http.statusCode), let data, !data.isEmpty else {
                completion(.failure(NSError(domain: "TokenHorizon", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "Cloud leaderboard returned HTTP \(http.statusCode)."])))
                return
            }
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let list = obj["leaderboard"] as? [[String: Any]] else {
                completion(.failure(NSError(domain: "TokenHorizon", code: 422, userInfo: [NSLocalizedDescriptionKey: "No valid leaderboard rows in cloud response."])))
                return
            }
            let remote = list.compactMap(Self.entryFromDict)
            self.lock.lock()
            let local = self.entries.first(where: { $0.isLocal })
            self.entries = Self.mergeRemoteEntries(current: self.entries, local: local, remote: remote)
            self.lastPullAt["cloud"] = Date()
            if let newEtag = Self.headerValue(resp, "etag") {
                self.cloudEtag = newEtag
            }
            let count = self.entries.count
            self.saveLocked()
            self.lock.unlock()
            completion(.success(count))
        }.resume()
    }

    /// Pull the team board from Cloudflare Worker + R2 (alias).
    func pullFromCloudflare(forced: Bool = false, completion: @escaping (Result<Int, Error>) -> Void) {
        pullFromCloud(forced: forced, completion: completion)
    }

    /// Publish the local entry to the cloud backend. Change-gated: skipped
    /// unless local all-time tokens moved materially since the last publish.
    func publishToCloud(forced: Bool = false, completion: @escaping (Result<String, Error>) -> Void) {
        guard let url = cloudLeaderboardURL() else {
            completion(.failure(NSError(domain: "TokenHorizon", code: 400, userInfo: [NSLocalizedDescriptionKey: "No cloud leaderboard URL configured in Settings."])))
            return
        }
        lock.lock()
        let local = entries.first(where: { $0.isLocal })
        lock.unlock()
        guard let local else {
            completion(.failure(NSError(domain: "TokenHorizon", code: 404, userInfo: [NSLocalizedDescriptionKey: "No local token usage entry found to publish."])))
            return
        }
        lock.lock()
        let due = LeaderboardSyncPolicy.shouldPublish(now: Date(), lastPublish: lastPublishAt["cloud"], lastTokens: lastPublishedTokens["cloud"], currentTokens: local.tokensAll, forced: forced)
        lock.unlock()
        guard due else {
            completion(.success("Board is already up to date."))
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 8.0
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let token = SettingsStore.shared.leaderboardCloudToken
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        guard let body = try? encoder.encode(local) else {
            completion(.failure(NSError(domain: "TokenHorizon", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to serialize entry JSON."])))
            return
        }
        req.httpBody = body
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, err in
            guard let self else { return }
            if let err {
                completion(.failure(err))
                return
            }
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 500
                let msg = code == 401 ? "Cloud rejected the write token — check Settings." : "Cloud publish returned HTTP \(code)."
                completion(.failure(NSError(domain: "TokenHorizon", code: code, userInfo: [NSLocalizedDescriptionKey: msg])))
                return
            }
            self.lock.lock()
            self.lastPublishAt["cloud"] = Date()
            self.lastPublishedTokens["cloud"] = local.tokensAll
            self.lock.unlock()
            completion(.success("Published @\(local.handle) to cloud."))
        }.resume()
    }

    /// Publish the local entry to Cloudflare Worker + R2 (alias).
    func publishToCloudflare(forced: Bool = false, completion: @escaping (Result<String, Error>) -> Void) {
        publishToCloud(forced: forced, completion: completion)
    }
}

/// Cache policy for leaderboard sync: pulls are TTL-gated, publishes are
/// additionally change-gated, everything is bypassable via `forced` (manual
/// UI/MCP actions). Pure + tested.
enum LeaderboardSyncPolicy {
    /// Minimum age of the last pull before the network fires again.
    static let pullTTL: TimeInterval = 300
    /// Minimum age of the last publish before another may fire.
    static let publishMinInterval: TimeInterval = 120
    /// Local all-time tokens must move at least this far to justify a publish.
    static let publishTokenDelta = 1000

    static func shouldPull(now: Date, lastPull: Date?, forced: Bool) -> Bool {
        if forced { return true }
        guard let last = lastPull else { return true }
        return now.timeIntervalSince(last) >= pullTTL
    }

    static func shouldPublish(now: Date, lastPublish: Date?, lastTokens: Int?, currentTokens: Int, forced: Bool) -> Bool {
        if forced { return true }
        if let last = lastPublish, now.timeIntervalSince(last) < publishMinInterval { return false }
        guard let prev = lastTokens else { return true }
        return abs(currentTokens - prev) >= publishTokenDelta
    }
}
