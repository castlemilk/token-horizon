import Foundation

/// Aggregation dimensions for usage queries.
public enum UsageGroupBy: String, Codable {
    case vendor
    case model
    case machine
    case product
    case session
    case day
}

/// One aggregate row: a group's totals over a time range.
public struct UsageAggregate: Codable {
    public var key: String
    public var tokens = TokenBreakdown()
    public var cost = 0.0
    public var requests = 0
    public var firstEvent: Date?
    public var lastEvent: Date?

    public init(key: String) { self.key = key }
}

/// One time bucket of usage (for trends/history charts).
public struct UsageBucket: Codable {
    public var start: Int          // bucket-aligned epoch seconds
    public var vendor: String      // stacked-series key
    public var tokens = TokenBreakdown()
    public var cost = 0.0

    public init(start: Int, vendor: String) {
        self.start = start
        self.vendor = vendor
    }
}

/// Filter applied to tabular queries, aggregations, buckets, and summaries.
/// All fields optional; nil = no constraint. Exact-match semantics.
public struct UsageFilter: Codable {
    public var vendor: String?
    public var model: String?
    public var machineID: String?
    public var product: String?
    public var source: SourceKind?
    public var attestation: Attestation?
    public var thinkingLevel: String?
    public var sessionID: String?

    public init(vendor: String? = nil, model: String? = nil, machineID: String? = nil,
                product: String? = nil, source: SourceKind? = nil,
                attestation: Attestation? = nil, thinkingLevel: String? = nil,
                sessionID: String? = nil) {
        self.vendor = vendor
        self.model = model
        self.machineID = machineID
        self.product = product
        self.source = source
        self.attestation = attestation
        self.thinkingLevel = thinkingLevel
        self.sessionID = sessionID
    }

    /// SQL WHERE fragments + bound values (column = ? equality only).
    var sqlClauses: [(column: String, value: String)] {
        var out: [(String, String)] = []
        if let vendor { out.append(("vendor", vendor)) }
        if let model { out.append(("model", model)) }
        if let machineID { out.append(("machine_id", machineID)) }
        if let product { out.append(("product", product)) }
        if let source { out.append(("source", source.rawValue)) }
        if let attestation { out.append(("attestation", attestation.rawValue)) }
        if let thinkingLevel { out.append(("thinking_level", thinkingLevel)) }
        if let sessionID { out.append(("session_id", sessionID)) }
        return out
    }
}

/// Per-model rollup inside a provider summary.
public struct ModelSummary: Codable {
    public var model: String
    public var tokens = TokenBreakdown()
    public var cost = 0.0
    public var requests = 0
    public var avgGenerationTokPerSec: Double?
    public var avgPromptTokPerSec: Double?
    public var avgContextOccupancy: Double?
    public var lastEvent: Date?

    public init(model: String) { self.model = model }
}

/// Provider-level rollup with nested per-model rows.
public struct ProviderSummary: Codable {
    public var vendor: String
    public var source: String
    public var tokens = TokenBreakdown()
    public var cost = 0.0
    public var requests = 0
    public var models: [ModelSummary] = []

    public init(vendor: String, source: String) {
        self.vendor = vendor
        self.source = source
    }
}

/// One quota/limit observation at a point in time. Recorded on every
/// LimitsEngine refresh so quota, limit and reset history survives restarts
/// and syncs multi-machine via the same store as usage events.
public struct LimitSnapshot: Codable {
    public var recordedAt: Date
    public var machineID: String
    public var provider: String
    public var label: String
    public var usedPercent: Double
    public var resetsAt: Date?
    public var detail: String

    public init(recordedAt: Date = Date(), machineID: String, provider: String,
                label: String, usedPercent: Double, resetsAt: Date? = nil, detail: String = "") {
        self.recordedAt = recordedAt
        self.machineID = machineID
        self.provider = provider
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.detail = detail
    }

    public init(from limit: ProviderLimit, recordedAt: Date = Date(), machineID: String) {
        self.init(recordedAt: recordedAt, machineID: machineID, provider: limit.provider,
                  label: limit.label, usedPercent: limit.usedPercent,
                  resetsAt: limit.resetsAt, detail: limit.detail)
    }
}

public enum UsageStoreError: Error {
    case openFailed(String)
    case prepareFailed(String)
    case stepFailed(String)
}

/// Minimal leaderboard row for cloud sync. The cloud schema is deliberately
/// different from local tables: it is read-optimized for cross-user rankings
/// (handle/team/period) while local tables stay write-optimized per-machine.
/// Hosts map their richer entry types onto this before recording.
public struct SyncLeaderboardEntry: Codable {
    public var machineID: String
    public var handle: String
    public var team: String
    public var period: String
    public var tokens: Int
    public var cost: Double
    public var topModel: String
    public var breakdownJSON: String
    public var updatedAt: Date

    public init(machineID: String, handle: String, team: String = "", period: String = "today",
                tokens: Int, cost: Double, topModel: String = "",
                breakdownJSON: String = "{}", updatedAt: Date = Date()) {
        self.machineID = machineID
        self.handle = handle
        self.team = team
        self.period = period
        self.tokens = tokens
        self.cost = cost
        self.topModel = topModel
        self.breakdownJSON = breakdownJSON
        self.updatedAt = updatedAt
    }
}

/// The storage contract every usage backend implements — local sqlite today,
/// Postgres/HTTP API tomorrow. Collectors write events through it; engines,
/// dashboards, sync and leaderboards read through it. Implementations must be
/// thread-safe and insert-idempotent (event UUID is the dedup key).
public protocol UsageStoring {
    /// Append events. Re-inserting an existing event id is a no-op, so
    /// retries and multi-machine sync merges are safe.
    func insert(_ events: [UsageEvent]) throws

    /// Tabular request view: filtered events, newest first, rowid-paginated.
    /// nextCursor is nil when the page is exhausted.
    func query(from: Date, to: Date, filter: UsageFilter,
               cursor: Int64?, limit: Int) throws -> (events: [UsageEvent], nextCursor: Int64?)

    /// Totals per group over [from, to), optionally filtered.
    func aggregate(from: Date, to: Date, groupBy: UsageGroupBy, filter: UsageFilter) throws -> [UsageAggregate]

    /// Bucketed series over [from, to) at arbitrary chart resolution
    /// (900 = 15-min, 3600 = hourly, 86400 = daily), optionally filtered.
    func buckets(from: Date, to: Date, bucketSeconds: Int, filter: UsageFilter) throws -> [UsageBucket]

    /// Provider → model rollup over [from, to): token types, cost, request
    /// counts, average measured rates, average context occupancy.
    func summarize(from: Date, to: Date, filter: UsageFilter) throws -> [ProviderSummary]

    /// Live context-window occupancy per session (upserted state, not events).
    func upsertContextState(_ state: ContextState) throws
    func contextStates() throws -> [ContextState]

    /// Sync primitive: events with local sequence > cursor, oldest first.
    /// The cursor maps to a server-side cursor for cloud backends.
    func events(afterSequence cursor: Int64, limit: Int) throws -> (events: [UsageEvent], lastSequence: Int64)

    /// Total stored events (health/debug).
    func count() throws -> Int

    /// Quota timeline: append limit observations (deduplicated per provider/
    /// label/minute so refreshes don't flood the table).
    func recordLimits(_ snapshots: [LimitSnapshot]) throws

    /// Quota history over [from, to), optionally filtered by provider.
    func limitHistory(from: Date, to: Date, provider: String?) throws -> [LimitSnapshot]

    /// Leaderboard outbox: upsert per (machine, handle, period) for cloud sync.
    /// Pending uploads only — rankings themselves live cloud-side (global
    /// construct); rows are deleted on acknowledged push.
    func recordLeaderboard(_ entries: [SyncLeaderboardEntry]) throws

    /// Leaderboard rows updated since the given date (for delta pushes).
    func leaderboardSnapshots(since: Date) throws -> [SyncLeaderboardEntry]

    /// Drop outbox rows updated at or before the given date (after ack).
    func clearSyncedLeaderboard(before: Date) throws

    /// Sync cursors: opaque per-dataset progress markers for delta pushes
    /// (usage rowid, limits timestamp, …). Backends persist them; the sync
    /// engine advances them only on acknowledged pushes.
    func syncCursor(dataset: String) throws -> String?
    func setSyncCursor(dataset: String, cursor: String) throws
}

/// Default no-op quota history for backends that haven't opted in
/// (cloud stubs, test doubles) — SQLiteUsageStore overrides with real storage.
public extension UsageStoring {
    func recordLimits(_ snapshots: [LimitSnapshot]) throws {}
    func limitHistory(from: Date, to: Date, provider: String?) throws -> [LimitSnapshot] { [] }
    func recordLeaderboard(_ entries: [SyncLeaderboardEntry]) throws {}
    func leaderboardSnapshots(since: Date) throws -> [SyncLeaderboardEntry] { [] }
    func clearSyncedLeaderboard(before: Date) throws {}
    func syncCursor(dataset: String) throws -> String? { nil }
    func setSyncCursor(dataset: String, cursor: String) throws {}
}
