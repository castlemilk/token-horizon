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
    /// Sum of per-row USD-equivalent list costs (see UsageEvent
    /// .costEquivalent); nil when NO row in the group is catalog-priced.
    public var costEquivalent: Double?
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
    /// USD-equivalent list cost summed over the bucket; nil when no row in
    /// the bucket is catalog-priced.
    public var costEquivalent: Double?
    /// Requests in the bucket.
    public var requests = 0

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
    /// Exclude self-reported (file-claimed / backfilled) rows — the UI
    /// default, so only measured-or-better attestation flows to dashboards.
    public var meteredOnly: Bool = false

    public init(vendor: String? = nil, model: String? = nil, machineID: String? = nil,
                product: String? = nil, source: SourceKind? = nil,
                attestation: Attestation? = nil, thinkingLevel: String? = nil,
                sessionID: String? = nil, meteredOnly: Bool = false) {
        self.vendor = vendor
        self.model = model
        self.machineID = machineID
        self.product = product
        self.source = source
        self.attestation = attestation
        self.thinkingLevel = thinkingLevel
        self.sessionID = sessionID
        self.meteredOnly = meteredOnly
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
    /// USD-equivalent list cost for this model's rows; nil when unpriced.
    public var costEquivalent: Double?
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
    /// USD-equivalent list cost summed over priced models; nil when none
    /// of the vendor's models are catalog-priced.
    public var costEquivalent: Double?
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
    /// Pseudonymous account this quota window belongs to (see AccountKey).
    /// Multi-account vendors keep one quota timeline PER ACCOUNT; empty =
    /// single/unknown account.
    public var accountID: String
    public var label: String
    public var usedPercent: Double
    public var resetsAt: Date?
    public var detail: String

    public init(recordedAt: Date = Date(), machineID: String, provider: String,
                accountID: String = "", label: String, usedPercent: Double,
                resetsAt: Date? = nil, detail: String = "") {
        self.recordedAt = recordedAt
        self.machineID = machineID
        self.provider = provider
        self.accountID = accountID
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.detail = detail
    }

    public init(from limit: ProviderLimit, recordedAt: Date = Date(), machineID: String) {
        self.init(recordedAt: recordedAt, machineID: machineID, provider: limit.provider,
                  accountID: limit.accountID, label: limit.label,
                  usedPercent: limit.usedPercent, resetsAt: limit.resetsAt, detail: limit.detail)
    }
}

public enum UsageStoreError: Error {
    case openFailed(String)
    case prepareFailed(String)
    case stepFailed(String)
}

/// The storage contract every usage backend implements — local sqlite today,
/// Postgres/HTTP API tomorrow. Collectors write events through it; engines,
/// dashboards, sync and leaderboards read through it. Implementations must be
/// thread-safe and insert-idempotent (event UUID is the dedup key).
public protocol UsageStoring {
    /// Append events. Re-inserting an existing event id is a no-op, so
    /// retries and multi-machine sync merges are safe.
    func insert(_ events: [UsageEvent]) throws

    /// Append events measured LIVE by a request meter — the ONLY writer of
    /// usage rows. Implementations must be thread-safe and insert-idempotent
    /// (event UUID is the dedup key).
    func insertMetered(_ events: [UsageEvent]) throws

    /// Append tool annotations recovered from session files. Idempotent
    /// (vendor+requestID is the natural key). Annotations are stored
    /// alongside usage rows and joined onto them at READ time — they never
    /// modify a usage row, so every observation keeps full resolution.
    func annotate(_ annotations: [FileAnnotation]) throws

    /// Which of the given provider request ids already carry a file
    /// annotation. AttributionScheduler prunes resolved probes with this.
    func annotatedRequestIDs(among ids: [String]) throws -> Set<String>

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

    /// Sync cursors: opaque per-dataset progress markers for delta pushes
    /// (usage rowid, limits timestamp). Backends persist them; the sync
    /// engine advances them only on acknowledged pushes.
    func syncCursor(dataset: String) throws -> String?
    func setSyncCursor(dataset: String, cursor: String) throws
}

/// Default no-op quota history for backends that haven't opted in
/// (cloud stubs, test doubles) — SQLiteUsageStore overrides with real storage.
public extension UsageStoring {
    func recordLimits(_ snapshots: [LimitSnapshot]) throws {}
    func limitHistory(from: Date, to: Date, provider: String?) throws -> [LimitSnapshot] { [] }
    func syncCursor(dataset: String) throws -> String? { nil }
    func setSyncCursor(dataset: String, cursor: String) throws {}
}

/// Backends without annotation storage simply drop annotations.
public extension UsageStoring {
    func insertMetered(_ events: [UsageEvent]) throws { try insert(events) }
    func annotate(_ annotations: [FileAnnotation]) throws {}
    func annotatedRequestIDs(among ids: [String]) throws -> Set<String> { [] }
}
