import Foundation

struct UsageSnapshot: Codable {
    var tokensToday: Int = 0
    var tokensAllTime: Int = 0
    var costToday: Double = 0
    var costAllTime: Double = 0
    var perTool: [ToolUsage] = []
    var models: [ModelUsage] = []
    var limits: [ProviderLimit] = []
    var claudeAccounts: [ClaudeAccount] = []
    var recentSessions: [SessionSummary] = []
    var sources: [String] = []
    var updatedAt: Date = .distantPast

    static let empty = UsageSnapshot()

    var tokensTodayText: String { Self.tokens(tokensToday) }
    var tokensAllTimeText: String { Self.tokens(tokensAllTime) }

    static func tokens(_ n: Int) -> String {
        switch n {
        case 1_000_000_000...: return String(format: "%.2fB", Double(n) / 1_000_000_000)
        case 1_000_000...: return String(format: "%.1fM", Double(n) / 1_000_000)
        case 1_000...: return String(format: "%.1fk", Double(n) / 1_000)
        default: return "\(n)"
        }
    }

    static func cost(_ c: Double) -> String {
        c >= 100 ? String(format: "$%.0f", c) : String(format: "$%.2f", c)
    }
}

struct ToolUsage: Codable {
    var tool: String
    var tokensToday: Int
    var tokensAllTime: Int
    var costToday: Double
    var costAllTime: Double
    var cacheReadAll: Int = 0
    var cacheWriteAll: Int = 0
}

struct ProviderLimit: Codable, Identifiable {
    var id: String { "\(provider):\(label)" }
    var provider: String
    var label: String
    var usedPercent: Double
    var resetsAt: Date?
    var detail: String

    var isWeekly: Bool {
        let l = label.lowercased()
        return l.contains("week") || l.contains("7d") || l.contains("month") || l.contains("advanced")
    }

    var remainingPercent: Double {
        max(0, 100.0 - usedPercent)
    }

    var secondsUntilReset: TimeInterval? {
        guard let r = resetsAt else { return nil }
        return max(0, r.timeIntervalSinceNow)
    }

    var resetsSoon: Bool {
        guard let s = secondsUntilReset else { return false }
        return s > 0 && s < 86_400
    }
}

struct HistoryPoint: Codable {
    var day: Int
    var tokens: Int
    var cost: Double
    var byTool: [String: Int]
}

enum TrendWindow: String, CaseIterable, Identifiable {
    case day = "1D"
    case week = "1W"
    case month = "1M"
    case quarter = "3M"
    case year = "1Y"

    var id: String { rawValue }

    var spec: (count: Int, seconds: Int, dailyAligned: Bool) {
        switch self {
        case .day: return (24, 3600, false)
        case .week: return (7, 86_400, true)
        case .month: return (30, 86_400, true)
        case .quarter: return (90, 86_400, true)
        case .year: return (52, 7 * 86_400, false)
        }
    }

    var engineKey: String {
        switch self {
        case .day: return "1d"
        case .week: return "1w"
        case .month: return "1m"
        case .quarter: return "3m"
        case .year: return "1y"
        }
    }
}

struct ModelUsage: Codable, Identifiable {
    var provider: String
    var model: String
    var tokensAll: Int
    var tokensToday: Int
    var cost: Double
    var messages: Int
    var free: Bool
    var cacheReadAll: Int = 0
    var estCost: Double = 0
    var contextK: Int = 0
    var tokPerSec: Double? = nil
    var promptTokPerSec: Double? = nil
    var paramSize: String? = nil
    var quant: String? = nil
    var isLocal: Bool = false
    var capabilities: [String] = []
    // Ollama tags can be canonicalized for catalog display; retain the exact
    // runtime name so /api/show can resolve tagged models reliably.
    var localModelName: String? = nil
    /// 0–100 share of the provider's all-time tokens (e.g. fable = 66% of
    /// claude). Populated by `withProviderShares` after per-provider totals
    /// are known; 0 when unknown.
    var sharePercent: Double = 0

    var id: String { "\(provider)/\(model)" }

    var shareText: String {
        sharePercent >= 9.95
            ? String(format: "%.0f%%", sharePercent)
            : String(format: "%.1f%%", sharePercent)
    }

    /// Return copies with `sharePercent` set to each row's 0–100 share of its
    /// own provider's all-time tokens. Order is preserved. Rows whose
    /// provider totals zero get 0 rather than NaN.
    static func withProviderShares(_ models: [ModelUsage]) -> [ModelUsage] {
        var totals: [String: Int] = [:]
        for m in models { totals[m.provider, default: 0] += m.tokensAll }
        return models.map { m in
            var c = m
            let t = totals[m.provider] ?? 0
            c.sharePercent = t > 0 ? min(max(Double(m.tokensAll) / Double(t) * 100, 0), 100) : 0
            return c
        }
    }
}

struct SessionSummary: Codable, Identifiable {
    var id: String
    var title: String
    var cost: Double
    var tokens: Int
    var directory: String
    var created: Date
}

struct ShellEvent: Codable, Identifiable {
    var id = UUID()
    var time: Date
    var cwd: String
    var durationMs: Int
    var exit: Int

    var summary: String {
        let cmd = (cwd as NSString).lastPathComponent
        let dur = durationMs >= 60_000
            ? String(format: "%.1fm", Double(durationMs) / 60_000)
            : durationMs >= 1000
                ? String(format: "%.1fs", Double(durationMs) / 1000)
                : "\(durationMs)ms"
        let mark = exit == 0 ? "✓" : "✗ \(exit)"
        return "\(cmd) \(dur) \(mark)"
    }
}

struct ClaudeAccount: Codable, Identifiable {
    var id: String = ""
    var label: String = ""
    var configDir: String = ""
    var accountUuid: String = ""
    var email: String = ""
    var displayName: String = ""
    var organizationUuid: String = ""
    var organizationName: String = ""
    var organizationType: String = ""
    var rateLimitTier: String = ""
    var hasExtraUsageEnabled: Bool = false
    var tokensToday: Int = 0
    var tokensAllTime: Int = 0
    var costToday: Double = 0
    var costAllTime: Double = 0
    var limits: [ProviderLimit] = []
    var updatedAt: Date = Date()

    var tokensTodayText: String { UsageSnapshot.tokens(tokensToday) }
    var tokensAllTimeText: String { UsageSnapshot.tokens(tokensAllTime) }
    var costTodayText: String { UsageSnapshot.cost(costToday) }
    var costAllTimeText: String { UsageSnapshot.cost(costAllTime) }
}
