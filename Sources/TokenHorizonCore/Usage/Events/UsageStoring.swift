import Foundation

/// Aggregation dimensions for usage queries.
public enum UsageGroupBy: String, Codable {
    case vendor
    case model
    case machine
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

    /// Totals per group over [from, to).
    func aggregate(from: Date, to: Date, groupBy: UsageGroupBy) throws -> [UsageAggregate]

    /// Bucketed series over [from, to) for stacked trends.
    func buckets(from: Date, to: Date, bucketSeconds: Int) throws -> [UsageBucket]

    /// Live context-window occupancy per session (upserted state, not events).
    func upsertContextState(_ state: ContextState) throws
    func contextStates() throws -> [ContextState]

    /// Sync primitive: events with local sequence > cursor, oldest first.
    /// The cursor maps to a server-side cursor for cloud backends.
    func events(afterSequence cursor: Int64, limit: Int) throws -> (events: [UsageEvent], lastSequence: Int64)

    /// Total stored events (health/debug).
    func count() throws -> Int
}
