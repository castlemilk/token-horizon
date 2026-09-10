import Foundation

/// Where a measurement came from.
public enum SourceKind: String, Codable {
    case external      // cloud vendor (claude, codex, kimi, ...)
    case selfManaged   // local runtime (vllm, sglang, llamacpp, ollama)
    case gateway       // team metering proxy (future tier-3 attestation)
}

/// How much trust a measurement carries (leaderboard verification tiers).
public enum Attestation: String, Codable {
    case selfReported    // read from local logs — honor system
    case reconciled      // cross-checked against the provider's server-side API
    case gatewayMetered  // measured by a team-controlled gateway
}

/// The single unit of token measurement. One per request (or per measured
/// counter-delta interval for runtime sources). Every collector — vendor
/// file-tailer, API poller, Prometheus scraper, gateway — emits these.
/// Append-only and UUID-keyed so per-machine stores merge conflict-free.
public struct UsageEvent: Codable, Identifiable {
    public var id: UUID
    public var timestamp: Date
    /// Stable per-machine identifier (see MachineIdentity).
    public var machineID: String
    public var source: SourceKind
    public var vendor: String
    public var model: String
    public var tokens: TokenBreakdown
    /// Live context-window fill at request time, when the client exposes it.
    public var contextOccupancy: Int?
    /// Model context capacity (from ModelCatalog), when known.
    public var contextLimit: Int?
    public var cost: Double
    /// Measured prompt-processing throughput, when available.
    public var promptTokPerSec: Double?
    /// Measured generation throughput, when available.
    public var generationTokPerSec: Double?
    public var latencyMs: Int?
    /// Client session correlation (claude/codex/opencode session id).
    public var sessionID: String?
    /// Configured thinking/reasoning effort, normalized across vendors:
    /// "off" | "low" | "medium" | "high" | "adaptive" (vendor decides dynamically).
    /// Vendors represent this wildly differently (OpenAI reasoning_effort,
    /// Anthropic thinking.budget_tokens, Gemini thinkingBudget, Ollama think) —
    /// meters normalize here and keep the native form in thinkingRaw.
    public var thinkingLevel: String?
    /// Vendor-native thinking representation (e.g. "budget_tokens:16000").
    public var thinkingRaw: String?
    /// Client product the request came from ("claude-code", "codex", "pi",
    /// "opencode", ...) — sniffed from headers or set per meter port.
    public var product: String?
    public var attestation: Attestation

    public init(id: UUID = UUID(), timestamp: Date = Date(), machineID: String,
                source: SourceKind, vendor: String, model: String,
                tokens: TokenBreakdown, contextOccupancy: Int? = nil,
                contextLimit: Int? = nil, cost: Double = 0,
                promptTokPerSec: Double? = nil, generationTokPerSec: Double? = nil,
                latencyMs: Int? = nil, sessionID: String? = nil,
                thinkingLevel: String? = nil, thinkingRaw: String? = nil,
                product: String? = nil,
                attestation: Attestation = .selfReported) {
        self.id = id
        self.timestamp = timestamp
        self.machineID = machineID
        self.source = source
        self.vendor = vendor
        self.model = model
        self.tokens = tokens
        self.contextOccupancy = contextOccupancy
        self.contextLimit = contextLimit
        self.cost = cost
        self.promptTokPerSec = promptTokPerSec
        self.generationTokPerSec = generationTokPerSec
        self.latencyMs = latencyMs
        self.sessionID = sessionID
        self.thinkingLevel = thinkingLevel
        self.thinkingRaw = thinkingRaw
        self.product = product
        self.attestation = attestation
    }
}

/// Live context-window occupancy of one client session. This is *state*, not
/// an event: it moves as the conversation grows and is upserted per session.
public struct ContextState: Codable {
    public var sessionID: String
    public var vendor: String
    public var model: String
    public var occupancy: Int
    public var limit: Int
    public var updatedAt: Date

    public init(sessionID: String, vendor: String, model: String,
                occupancy: Int, limit: Int, updatedAt: Date = Date()) {
        self.sessionID = sessionID
        self.vendor = vendor
        self.model = model
        self.occupancy = occupancy
        self.limit = limit
        self.updatedAt = updatedAt
    }

    public var fillFraction: Double {
        limit > 0 ? Double(occupancy) / Double(limit) : 0
    }
}

/// Stable per-machine identity for multi-machine aggregation. Persisted as a
/// UUID in the config dir on first use; user-resettable by deleting the file.
public enum MachineIdentity {
    private static var cached: String?

    public static var current: String {
        if let cached { return cached }
        let url = Platform.paths.configDirectory.appendingPathComponent("machine-id")
        if let data = try? Data(contentsOf: url),
           let id = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !id.isEmpty {
            cached = id
            return id
        }
        let id = UUID().uuidString
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? id.data(using: .utf8)?.write(to: url, options: .atomic)
        cached = id
        return id
    }
}
