import Foundation

// Codable mirror of the gateway sidecar's trace JSON (gateway/trace.go).
// The gateway owns capture and storage; these types are read models for the
// :8765 pass-through endpoints. Fields are additive-safe: unknown keys are
// ignored and absent keys decode as nil/zero.

struct GatewayUsage: Codable, Equatable {
    var inputTokens: Int?
    var outputTokens: Int?
    var totalTokens: Int?
    var cachedTokens: Int?
    var reasoningTokens: Int?
    var source: String // reported | accumulated | absent
}

struct GatewayToolCall: Codable, Equatable, Identifiable {
    var name: String
    var callId: String?
    var id: String { callId ?? name }
}

struct GatewayTrace: Codable, Equatable, Identifiable {
    var id: String
    var provider: String
    var endpoint: String
    var path: String
    var model: String
    var startedAt: Double
    var ttftMs: Double?
    var durationMs: Double
    var stream: Bool
    var statusCode: Int
    var usage: GatewayUsage
    var toolCalls: [GatewayToolCall]
    var finishReasons: [String]
    var errorClass: String
    var errorMessage: String?
    var requestBody: String?
    var responseBody: String?
    var requestTruncated: Bool
    var responseTruncated: Bool
    var requestBytes: Int
    var responseBytes: Int
    var sessionKey: String?
    var requestHash: String
    var retrySuspect: Bool
    var source: String?
    var client: String?
    var providerRequestId: String?
    var estCostUSD: Double?

    var startedDate: Date { Date(timeIntervalSince1970: startedAt) }
    var isError: Bool { errorClass != "none" }

    /// Generation throughput: output tokens per active second post-TTFT.
    var tokPerSec: Double? {
        guard let out = usage.outputTokens, out > 0, durationMs > 0 else { return nil }
        let active = durationMs - (ttftMs ?? 0)
        guard active > 1 else { return nil }
        return Double(out) / (active / 1000)
    }
}

struct GatewayModelStats: Codable, Equatable, Identifiable {
    var provider: String
    var model: String
    var requests: Int
    var errorCount: Int
    var inputTokens: Int
    var outputTokens: Int
    var cachedTokens: Int
    var avgTtftMs: Double?
    var avgTokPerSec: Double?
    var cacheHitRate: Double?
    var toolCallRate: Double
    var retrySuspectCount: Int
    var estCostUSD: Double
    var id: String { provider + "/" + model }
}

struct GatewayProviderStats: Codable, Equatable, Identifiable {
    var provider: String
    var requests: Int
    var errorCount: Int
    var inputTokens: Int
    var outputTokens: Int
    var avgTtftMs: Double?
    var estCostUSD: Double
    var id: String { provider }
}

struct GatewayClientStats: Codable, Equatable, Identifiable {
    var client: String
    var requests: Int
    var errorCount: Int
    var id: String { client }
}

struct GatewayErrorStat: Codable, Equatable, Identifiable {
    var `class`: String
    var count: Int
    var id: String { `class` }
}

struct GatewaySessionStats: Codable, Equatable, Identifiable {
    var sessionKey: String
    var requests: Int
    var errorCount: Int
    var providers: [String]
    var models: [String]
    var clients: [String]
    var inputTokens: Int
    var outputTokens: Int
    var toolCallCount: Int
    var firstAt: Double
    var lastAt: Double
    var spanMs: Double
    var id: String { sessionKey }
    var lastDate: Date { Date(timeIntervalSince1970: lastAt) }
}

struct GatewayStats: Codable, Equatable {
    var windowHours: Int
    var since: Double
    var requests: Int
    var errorCount: Int
    var inputTokens: Int
    var outputTokens: Int
    var cachedTokens: Int
    var retrySuspectCount: Int
    var toolCallCount: Int
    var estCostUSD: Double
    var errorRate: Double
    var toolCallRate: Double
    var cacheHitRate: Double?
    var avgTtftMs: Double?
    var p50DurationMs: Double?
    var p95DurationMs: Double?
    var p50TtftMs: Double?
    var p95TtftMs: Double?
    var byModel: [GatewayModelStats]
    var byProvider: [GatewayProviderStats]
    var byClient: [GatewayClientStats]
    var byError: [GatewayErrorStat]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        windowHours = try c.decode(Int.self, forKey: .windowHours)
        since = try c.decode(Double.self, forKey: .since)
        requests = try c.decode(Int.self, forKey: .requests)
        errorCount = try c.decode(Int.self, forKey: .errorCount)
        inputTokens = try c.decode(Int.self, forKey: .inputTokens)
        outputTokens = try c.decode(Int.self, forKey: .outputTokens)
        cachedTokens = try c.decode(Int.self, forKey: .cachedTokens)
        retrySuspectCount = try c.decode(Int.self, forKey: .retrySuspectCount)
        toolCallCount = try c.decode(Int.self, forKey: .toolCallCount)
        estCostUSD = try c.decode(Double.self, forKey: .estCostUSD)
        errorRate = try c.decode(Double.self, forKey: .errorRate)
        toolCallRate = try c.decode(Double.self, forKey: .toolCallRate)
        cacheHitRate = try c.decodeIfPresent(Double.self, forKey: .cacheHitRate)
        avgTtftMs = try c.decodeIfPresent(Double.self, forKey: .avgTtftMs)
        // Newer gateway builds emit the aggregation cuts; older sidecars
        // (and byte-frozen day files) may not — degrade to empty.
        p50DurationMs = try c.decodeIfPresent(Double.self, forKey: .p50DurationMs)
        p95DurationMs = try c.decodeIfPresent(Double.self, forKey: .p95DurationMs)
        p50TtftMs = try c.decodeIfPresent(Double.self, forKey: .p50TtftMs)
        p95TtftMs = try c.decodeIfPresent(Double.self, forKey: .p95TtftMs)
        byModel = try c.decodeIfPresent([GatewayModelStats].self, forKey: .byModel) ?? []
        byProvider = try c.decodeIfPresent([GatewayProviderStats].self, forKey: .byProvider) ?? []
        byClient = try c.decodeIfPresent([GatewayClientStats].self, forKey: .byClient) ?? []
        byError = try c.decodeIfPresent([GatewayErrorStat].self, forKey: .byError) ?? []
    }
}
