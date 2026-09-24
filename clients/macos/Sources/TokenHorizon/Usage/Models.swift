import Foundation

/// Decode helper: falls back to a default when a key is absent, so adding
/// fields to persisted Codable payloads never invalidates old caches.
extension KeyedDecodingContainer {
    func thDecode<T: Decodable>(_ key: Key, or fallback: T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)) ?? fallback
    }
}

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
    var inputTokensToday: Int = 0
    var outputTokensToday: Int = 0
    var inputTokensAllTime: Int = 0
    var outputTokensAllTime: Int = 0
    var requestsToday: Int = 0
    var requestsAllTime: Int = 0
    var projects: [ProjectUsage] = []
    var modelDaily: [ModelDailyUsage] = []
    var parserHealth: [ParserHealth] = []

    static let empty = UsageSnapshot()

    init() {}

    enum CodingKeys: String, CodingKey {
        case tokensToday, tokensAllTime, costToday, costAllTime, perTool, models
        case limits, claudeAccounts, recentSessions, sources, updatedAt, projects
        case inputTokensToday, outputTokensToday, inputTokensAllTime, outputTokensAllTime
        case requestsToday, requestsAllTime, modelDaily, parserHealth
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tokensToday = c.thDecode(.tokensToday, or: 0)
        tokensAllTime = c.thDecode(.tokensAllTime, or: 0)
        costToday = c.thDecode(.costToday, or: 0)
        costAllTime = c.thDecode(.costAllTime, or: 0)
        perTool = c.thDecode(.perTool, or: [])
        models = c.thDecode(.models, or: [])
        limits = c.thDecode(.limits, or: [])
        claudeAccounts = c.thDecode(.claudeAccounts, or: [])
        recentSessions = c.thDecode(.recentSessions, or: [])
        sources = c.thDecode(.sources, or: [])
        updatedAt = c.thDecode(.updatedAt, or: .distantPast)
        inputTokensToday = c.thDecode(.inputTokensToday, or: 0)
        outputTokensToday = c.thDecode(.outputTokensToday, or: 0)
        inputTokensAllTime = c.thDecode(.inputTokensAllTime, or: 0)
        outputTokensAllTime = c.thDecode(.outputTokensAllTime, or: 0)
        requestsToday = c.thDecode(.requestsToday, or: 0)
        requestsAllTime = c.thDecode(.requestsAllTime, or: 0)
        projects = c.thDecode(.projects, or: [])
        modelDaily = c.thDecode(.modelDaily, or: [])
        parserHealth = c.thDecode(.parserHealth, or: [])
    }

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
    var inputTokensToday: Int = 0
    var outputTokensToday: Int = 0
    var inputTokensAllTime: Int = 0
    var outputTokensAllTime: Int = 0
    var requestsToday: Int = 0
    var requestsAllTime: Int = 0

    init(tool: String, tokensToday: Int, tokensAllTime: Int, costToday: Double,
         costAllTime: Double, cacheReadAll: Int = 0, cacheWriteAll: Int = 0,
         inputTokensToday: Int = 0, outputTokensToday: Int = 0,
         inputTokensAllTime: Int = 0, outputTokensAllTime: Int = 0,
         requestsToday: Int = 0, requestsAllTime: Int = 0) {
        self.tool = tool
        self.tokensToday = tokensToday
        self.tokensAllTime = tokensAllTime
        self.costToday = costToday
        self.costAllTime = costAllTime
        self.cacheReadAll = cacheReadAll
        self.cacheWriteAll = cacheWriteAll
        self.inputTokensToday = inputTokensToday
        self.outputTokensToday = outputTokensToday
        self.inputTokensAllTime = inputTokensAllTime
        self.outputTokensAllTime = outputTokensAllTime
        self.requestsToday = requestsToday
        self.requestsAllTime = requestsAllTime
    }

    enum CodingKeys: String, CodingKey {
        case tool, tokensToday, tokensAllTime, costToday, costAllTime
        case cacheReadAll, cacheWriteAll
        case inputTokensToday, outputTokensToday, inputTokensAllTime, outputTokensAllTime
        case requestsToday, requestsAllTime
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tool = c.thDecode(.tool, or: "other")
        tokensToday = c.thDecode(.tokensToday, or: 0)
        tokensAllTime = c.thDecode(.tokensAllTime, or: 0)
        costToday = c.thDecode(.costToday, or: 0)
        costAllTime = c.thDecode(.costAllTime, or: 0)
        cacheReadAll = c.thDecode(.cacheReadAll, or: 0)
        cacheWriteAll = c.thDecode(.cacheWriteAll, or: 0)
        inputTokensToday = c.thDecode(.inputTokensToday, or: 0)
        outputTokensToday = c.thDecode(.outputTokensToday, or: 0)
        inputTokensAllTime = c.thDecode(.inputTokensAllTime, or: 0)
        outputTokensAllTime = c.thDecode(.outputTokensAllTime, or: 0)
        requestsToday = c.thDecode(.requestsToday, or: 0)
        requestsAllTime = c.thDecode(.requestsAllTime, or: 0)
    }
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
    var inputTokensAll: Int = 0
    var outputTokensAll: Int = 0
    var inputTokensToday: Int = 0
    var outputTokensToday: Int = 0
    var cacheWriteAll: Int = 0
    var requestsAll: Int = 0
    var requestsToday: Int = 0

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

extension ModelUsage {
    enum CodingKeys: String, CodingKey {
        case provider, model, tokensAll, tokensToday, cost, messages, free
        case cacheReadAll, estCost, contextK, tokPerSec, promptTokPerSec
        case paramSize, quant, isLocal, capabilities, localModelName, sharePercent
        case inputTokensAll, outputTokensAll, inputTokensToday, outputTokensToday
        case cacheWriteAll, requestsAll, requestsToday
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = c.thDecode(.provider, or: "?")
        model = c.thDecode(.model, or: "?")
        tokensAll = c.thDecode(.tokensAll, or: 0)
        tokensToday = c.thDecode(.tokensToday, or: 0)
        cost = c.thDecode(.cost, or: 0)
        messages = c.thDecode(.messages, or: 0)
        free = c.thDecode(.free, or: false)
        cacheReadAll = c.thDecode(.cacheReadAll, or: 0)
        estCost = c.thDecode(.estCost, or: 0)
        contextK = c.thDecode(.contextK, or: 0)
        tokPerSec = c.thDecode(.tokPerSec, or: nil as Double?)
        promptTokPerSec = c.thDecode(.promptTokPerSec, or: nil as Double?)
        paramSize = c.thDecode(.paramSize, or: nil as String?)
        quant = c.thDecode(.quant, or: nil as String?)
        isLocal = c.thDecode(.isLocal, or: false)
        capabilities = c.thDecode(.capabilities, or: [])
        localModelName = c.thDecode(.localModelName, or: nil as String?)
        sharePercent = c.thDecode(.sharePercent, or: 0)
        inputTokensAll = c.thDecode(.inputTokensAll, or: 0)
        outputTokensAll = c.thDecode(.outputTokensAll, or: 0)
        inputTokensToday = c.thDecode(.inputTokensToday, or: 0)
        outputTokensToday = c.thDecode(.outputTokensToday, or: 0)
        cacheWriteAll = c.thDecode(.cacheWriteAll, or: 0)
        requestsAll = c.thDecode(.requestsAll, or: 0)
        requestsToday = c.thDecode(.requestsToday, or: 0)
    }
}

struct SessionSummary: Codable, Identifiable {
    var id: String
    var title: String
    var cost: Double
    var tokens: Int
    var directory: String
    var created: Date
    var provider: String = ""
    var model: String = ""
    var inputTokens: Int = 0
    var outputTokens: Int = 0
    var requests: Int = 0

    init(id: String, title: String, cost: Double, tokens: Int, directory: String,
         created: Date, provider: String = "", model: String = "",
         inputTokens: Int = 0, outputTokens: Int = 0, requests: Int = 0) {
        self.id = id
        self.title = title
        self.cost = cost
        self.tokens = tokens
        self.directory = directory
        self.created = created
        self.provider = provider
        self.model = model
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.requests = requests
    }

    enum CodingKeys: String, CodingKey {
        case id, title, cost, tokens, directory, created
        case provider, model, inputTokens, outputTokens, requests
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.thDecode(.id, or: UUID().uuidString)
        title = c.thDecode(.title, or: "")
        cost = c.thDecode(.cost, or: 0)
        tokens = c.thDecode(.tokens, or: 0)
        directory = c.thDecode(.directory, or: "")
        created = c.thDecode(.created, or: Date())
        provider = c.thDecode(.provider, or: "")
        model = c.thDecode(.model, or: "")
        inputTokens = c.thDecode(.inputTokens, or: 0)
        outputTokens = c.thDecode(.outputTokens, or: 0)
        requests = c.thDecode(.requests, or: 0)
    }
}

/// One (model, local-day) token total for the trailing model-history window.
/// Published in the leaderboard breakdown so the dashboard can stack usage
/// by model over time with real data.
struct ModelDailyUsage: Codable, Identifiable, Equatable {
    var model: String
    var provider: String
    var day: Int
    var tokens: Int

    var id: String { "\(model)@\(day)" }

    init(model: String, provider: String, day: Int, tokens: Int) {
        self.model = model
        self.provider = provider
        self.day = day
        self.tokens = tokens
    }

    enum CodingKeys: String, CodingKey { case model, provider, day, tokens }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = c.thDecode(.model, or: "unknown")
        provider = c.thDecode(.provider, or: "other")
        day = c.thDecode(.day, or: 0)
        tokens = c.thDecode(.tokens, or: 0)
    }
}

/// Real per-project (working directory) aggregation. Fed by the opencode
/// session table plus claude/generic JSONL `cwd` fields.
struct ProjectUsage: Codable, Identifiable {
    var directory: String
    var tokens: Int = 0
    var cost: Double = 0
    var sessions: Int = 0
    var inputTokens: Int = 0
    var outputTokens: Int = 0

    var id: String { directory }
    var name: String {
        let last = (directory as NSString).lastPathComponent
        return last.isEmpty ? directory : last
    }

    enum CodingKeys: String, CodingKey {
        case directory, tokens, cost, sessions, inputTokens, outputTokens
    }

    init(directory: String, tokens: Int, cost: Double, sessions: Int,
         inputTokens: Int = 0, outputTokens: Int = 0) {
        self.directory = directory
        self.tokens = tokens
        self.cost = cost
        self.sessions = sessions
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        directory = c.thDecode(.directory, or: "")
        tokens = c.thDecode(.tokens, or: 0)
        cost = c.thDecode(.cost, or: 0)
        sessions = c.thDecode(.sessions, or: 0)
        inputTokens = c.thDecode(.inputTokens, or: 0)
        outputTokens = c.thDecode(.outputTokens, or: 0)
    }
}

/// Per-source parser health (since launch): consumed lines, parsed usage
/// records, and `suspect` — usage-shaped lines that failed to parse.
/// A nonzero suspect count is the schema-drift early-warning signal.
struct ParserHealth: Codable {
    var source: String
    var files: Int = 0
    var linesRead: Int = 0
    var parsed: Int = 0
    var suspect: Int = 0

    enum CodingKeys: String, CodingKey { case source, files, linesRead, parsed, suspect }

    init(source: String) { self.source = source }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = c.thDecode(.source, or: "unknown")
        files = c.thDecode(.files, or: 0)
        linesRead = c.thDecode(.linesRead, or: 0)
        parsed = c.thDecode(.parsed, or: 0)
        suspect = c.thDecode(.suspect, or: 0)
    }
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
