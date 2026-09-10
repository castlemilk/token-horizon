import Foundation

/// Granular token-type split. `total` is the sum of all categories.
/// Note: `input` EXCLUDES cacheRead/cacheWrite (those are KV-cache mechanics);
/// providers count differently, so the bucket also stores a compat `tokens`
/// figure for sources whose canonical total excludes some categories.
public struct TokenBreakdown: Codable, Equatable {
    public var input = 0
    public var output = 0
    public var reasoning = 0      // "thinking" tokens
    public var cacheRead = 0      // KV cache hits (read)
    public var cacheWrite = 0     // KV cache creation (write)

    public init(input: Int = 0, output: Int = 0, reasoning: Int = 0,
                cacheRead: Int = 0, cacheWrite: Int = 0) {
        self.input = input
        self.output = output
        self.reasoning = reasoning
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
    }

    public var total: Int { input + output + reasoning + cacheRead + cacheWrite }
    /// Non-cache input share: how much prompt was actually re-processed.
    public var cacheHitShare: Double {
        let denom = input + cacheRead
        return denom > 0 ? Double(cacheRead) / Double(denom) : 0
    }

    public mutating func add(_ other: TokenBreakdown) {
        input += other.input
        output += other.output
        reasoning += other.reasoning
        cacheRead += other.cacheRead
        cacheWrite += other.cacheWrite
    }

    public static func + (l: TokenBreakdown, r: TokenBreakdown) -> TokenBreakdown {
        var out = l
        out.add(r)
        return out
    }
}

public struct UsageSnapshot: Codable {
    public init() {}

    public var tokensToday: Int = 0
    public var tokensAllTime: Int = 0
    public var costToday: Double = 0
    public var costAllTime: Double = 0
    public var perTool: [ToolUsage] = []
    public var models: [ModelUsage] = []
    public var limits: [ProviderLimit] = []
    public var recentSessions: [SessionSummary] = []
    public var sources: [String] = []
    public var updatedAt: Date = .distantPast
    /// Granular token-type split, today and all-time (summed across tools).
    public var breakdownToday = TokenBreakdown()
    public var breakdownAll = TokenBreakdown()

    public static let empty = UsageSnapshot()

    public var tokensTodayText: String { Self.tokens(tokensToday) }
    public var tokensAllTimeText: String { Self.tokens(tokensAllTime) }

    public static func tokens(_ n: Int) -> String {
        switch n {
        case 1_000_000...: return String(format: "%.1fM", Double(n) / 1_000_000)
        case 1_000...: return String(format: "%.1fk", Double(n) / 1_000)
        default: return "\(n)"
        }
    }

    public static func cost(_ c: Double) -> String {
        c >= 100 ? String(format: "$%.0f", c) : String(format: "$%.2f", c)
    }
}

public struct ToolUsage: Codable {
    public init(tool: String, tokensToday: Int, tokensAllTime: Int, costToday: Double,
                costAllTime: Double, cacheReadAll: Int = 0, cacheWriteAll: Int = 0,
                breakdownToday: TokenBreakdown = TokenBreakdown(),
                breakdownAll: TokenBreakdown = TokenBreakdown()) {
        self.tool = tool
        self.tokensToday = tokensToday
        self.tokensAllTime = tokensAllTime
        self.costToday = costToday
        self.costAllTime = costAllTime
        self.cacheReadAll = cacheReadAll
        self.cacheWriteAll = cacheWriteAll
        self.breakdownToday = breakdownToday
        self.breakdownAll = breakdownAll
    }

    public var tool: String
    public var tokensToday: Int
    public var tokensAllTime: Int
    public var costToday: Double
    public var costAllTime: Double
    public var cacheReadAll: Int = 0
    public var cacheWriteAll: Int = 0
    public var breakdownToday = TokenBreakdown()
    public var breakdownAll = TokenBreakdown()
}

public struct ProviderLimit: Codable, Identifiable {
    public init(provider: String, label: String, usedPercent: Double, resetsAt: Date?, detail: String) {
        self.provider = provider
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.detail = detail
    }

    public var id: String { "\(provider):\(label)" }
    public var provider: String
    public var label: String
    public var usedPercent: Double
    public var resetsAt: Date?
    public var detail: String
}

public struct HistoryPoint: Codable {
    public init(day: Int, tokens: Int, cost: Double, byTool: [String: Int],
                breakdown: TokenBreakdown = TokenBreakdown()) {
        self.day = day
        self.tokens = tokens
        self.cost = cost
        self.byTool = byTool
        self.breakdown = breakdown
    }

    /// Bucket start (epoch seconds). With 15-minute buckets this is a 15-min key;
    /// with day aggregation it is local midnight.
    public var day: Int
    public var tokens: Int
    public var cost: Double
    public var byTool: [String: Int]
    public var breakdown = TokenBreakdown()
}

public enum TrendWindow: String, CaseIterable, Identifiable {
    case day = "1D"
    case week = "1W"
    case month = "1M"
    case quarter = "3M"
    case year = "1Y"

    public var id: String { rawValue }

    public var spec: (count: Int, seconds: Int, dailyAligned: Bool) {
        switch self {
        case .day: return (96, 900, false)   // 15-minute granularity
        case .week: return (7, 86_400, true)
        case .month: return (30, 86_400, true)
        case .quarter: return (90, 86_400, true)
        case .year: return (52, 7 * 86_400, false)
        }
    }

    public var engineKey: String {
        switch self {
        case .day: return "1d"
        case .week: return "1w"
        case .month: return "1m"
        case .quarter: return "3m"
        case .year: return "1y"
        }
    }
}

public struct ModelUsage: Codable, Identifiable {
    public init(provider: String, model: String, tokensAll: Int, tokensToday: Int, cost: Double,
                messages: Int, free: Bool, cacheReadAll: Int = 0, estCost: Double = 0,
                contextK: Int = 0, tokPerSec: Double? = nil, promptTokPerSec: Double? = nil,
                paramSize: String? = nil, quant: String? = nil, isLocal: Bool = false,
                capabilities: [String] = [], breakdown: TokenBreakdown = TokenBreakdown()) {
        self.provider = provider
        self.model = model
        self.tokensAll = tokensAll
        self.tokensToday = tokensToday
        self.cost = cost
        self.messages = messages
        self.free = free
        self.cacheReadAll = cacheReadAll
        self.estCost = estCost
        self.contextK = contextK
        self.tokPerSec = tokPerSec
        self.promptTokPerSec = promptTokPerSec
        self.paramSize = paramSize
        self.quant = quant
        self.isLocal = isLocal
        self.capabilities = capabilities
        self.breakdown = breakdown
    }

    public var provider: String
    public var model: String
    public var tokensAll: Int
    public var tokensToday: Int
    public var cost: Double
    public var messages: Int
    public var free: Bool
    public var cacheReadAll: Int = 0
    public var estCost: Double = 0
    public var contextK: Int = 0
    public var tokPerSec: Double? = nil
    public var promptTokPerSec: Double? = nil
    public var paramSize: String? = nil
    public var quant: String? = nil
    public var isLocal: Bool = false
    public var capabilities: [String] = []
    public var breakdown = TokenBreakdown()

    public var id: String { "\(provider)/\(model)" }
}

public struct SessionSummary: Codable, Identifiable {
    public init(id: String, title: String, cost: Double, tokens: Int, directory: String, created: Date) {
        self.id = id
        self.title = title
        self.cost = cost
        self.tokens = tokens
        self.directory = directory
        self.created = created
    }

    public var id: String
    public var title: String
    public var cost: Double
    public var tokens: Int
    public var directory: String
    public var created: Date
}

public struct ShellEvent: Codable, Identifiable {
    public init(time: Date, cwd: String, durationMs: Int, exit: Int) {
        self.time = time
        self.cwd = cwd
        self.durationMs = durationMs
        self.exit = exit
    }

    public var id = UUID()
    public var time: Date
    public var cwd: String
    public var durationMs: Int
    public var exit: Int

    public var summary: String {
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
