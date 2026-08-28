import Foundation

struct UsageSnapshot: Codable {
    var tokensToday: Int = 0
    var tokensAllTime: Int = 0
    var costToday: Double = 0
    var costAllTime: Double = 0
    var perTool: [ToolUsage] = []
    var models: [ModelUsage] = []
    var limits: [ProviderLimit] = []
    var recentSessions: [SessionSummary] = []
    var sources: [String] = []
    var updatedAt: Date = .distantPast

    static let empty = UsageSnapshot()

    var tokensTodayText: String { Self.tokens(tokensToday) }
    var tokensAllTimeText: String { Self.tokens(tokensAllTime) }

    static func tokens(_ n: Int) -> String {
        switch n {
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

    var id: String { "\(provider)/\(model)" }
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
