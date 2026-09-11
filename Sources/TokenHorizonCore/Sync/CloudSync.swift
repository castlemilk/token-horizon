import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Cloud sync: local Core store (on-machine source of truth, offline-capable)
/// publishes deltas to a cloud DB with a deliberately different schema.
///
/// Local tables stay write-optimized per-machine (`usage_event`,
/// `limit_snapshot`, `leaderboard_snapshot`). The cloud schema is
/// read-optimized for cross-user queries (rankings, team rollups); the
/// `CloudSchema` mappers below are the translation layer between them.
///
/// Flow per dataset (usage events, limits, leaderboard):
/// 1. read the persisted cursor from `sync_state`
/// 2. pull the delta from the store (rowid / timestamp based)
/// 3. map to the cloud schema and POST it
/// 4. advance the cursor ONLY on acknowledged push
///
/// Offline (flights) = deltas accumulate locally; the next `sync()` after
/// reconnect pushes everything. Event UUIDs make redelivery idempotent;
/// leaderboard rows merge last-write-wins on `(machine_id, handle, period)`.
public enum CloudSyncDataset: String, CaseIterable {
    case usageEvents = "usage_events"   // cursor: rowid
    case limits = "limits"               // cursor: epoch seconds
    case leaderboard = "leaderboard"     // outbox: rows deleted on ack, no cursor
}

/// Transport seam for the cloud endpoint. URLSession in production, fakes in
/// tests. Paths are relative to the configured base URL.
public protocol CloudTransport {
    func post(path: String, payload: Data) throws
}

public struct CloudTransportError: Error {
    public var status: Int
    public init(status: Int) { self.status = status }
}

/// HTTP transport against the sync worker.
public struct HTTPCloudTransport: CloudTransport {
    public var baseURL: URL
    public var timeout: TimeInterval

    public init(baseURL: URL, timeout: TimeInterval = 15) {
        self.baseURL = baseURL
        self.timeout = timeout
    }

    public func post(path: String, payload: Data) throws {
        let url = baseURL.appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path)
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = payload
        var status = 0
        var transportError: Error?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { _, resp, err in
            status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            transportError = err
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + timeout + 5) == .timedOut {
            throw URLError(.timedOut)
        }
        if let transportError { throw transportError }
        guard (200..<300).contains(status) else { throw CloudTransportError(status: status) }
    }
}

/// Local → cloud schema mappers. Cloud payloads carry `machine_id` on every
/// row (multi-device attribution) and drop local-only columns.
public enum CloudSchema {
    public static func usageEvents(_ events: [UsageEvent]) -> [[String: Any]] {
        events.map { e in
            [
                "id": e.id.uuidString,
                "ts": Int(e.timestamp.timeIntervalSince1970),
                "machine_id": e.machineID,
                "source": e.source.rawValue,
                "vendor": e.vendor,
                "model": e.model,
                "tokens": ["input": e.tokens.input, "output": e.tokens.output,
                           "reasoning": e.tokens.reasoning, "cache_read": e.tokens.cacheRead,
                           "cache_write": e.tokens.cacheWrite],
                "cost": e.cost,
                "session": e.sessionID ?? NSNull(),
                "product": e.product ?? NSNull(),
                "attestation": e.attestation.rawValue,
            ] as [String: Any]
        }
    }

    public static func limits(_ snapshots: [LimitSnapshot], sinceCursor: String) -> [[String: Any]] {
        snapshots.map { s in
            [
                "recorded_at": Int(s.recordedAt.timeIntervalSince1970),
                "machine_id": s.machineID,
                "provider": s.provider,
                "label": s.label,
                "used_percent": s.usedPercent,
                "resets_at": s.resetsAt.map { Int($0.timeIntervalSince1970) } ?? NSNull(),
                "detail": s.detail,
            ] as [String: Any]
        }
    }

    public static func leaderboard(_ entries: [SyncLeaderboardEntry]) -> [[String: Any]] {
        entries.map { e in
            [
                "machine_id": e.machineID,
                "handle": e.handle,
                "team": e.team,
                "period": e.period,
                "tokens": e.tokens,
                "cost": e.cost,
                "top_model": e.topModel,
                "breakdown": (try? JSONSerialization.jsonObject(with: Data(e.breakdownJSON.utf8))) ?? NSNull(),
                "updated_at": Int(e.updatedAt.timeIntervalSince1970),
            ] as [String: Any]
        }
    }

    public static func encode(_ rows: [[String: Any]]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["rows": rows])
    }
}

/// Per-dataset push report.
public struct SyncReport: Codable {
    public var pushed: [String: Int]
    public var skipped: [String]
    public var error: String?

    public init(pushed: [String: Int] = [:], skipped: [String] = [], error: String? = nil) {
        self.pushed = pushed
        self.skipped = skipped
        self.error = error
    }
}

/// The sync engine. Hosts set `baseURL` (nil = disabled) and call `sync()`
/// on connectivity changes or a timer. All state lives in the store.
public final class CloudSync {
    public static let shared = CloudSync()

    public var baseURL: URL?
    public var batchSize = 500
    public var transportFactory: (URL) -> CloudTransport = { HTTPCloudTransport(baseURL: $0) }

    private let lock = NSLock()
    private var _lastReport = SyncReport()
    private var _lastSync: Date?
    private var backoffUntil = Date.distantPast

    public var lastReport: SyncReport { lock.lock(); defer { lock.unlock() }; return _lastReport }
    public var lastSync: Date? { lock.lock(); defer { lock.unlock() }; return _lastSync }

    public init() {
        if let raw = ProcessInfo.processInfo.environment["TH_SYNC_URL"], let url = URL(string: raw) {
            baseURL = url
        }
    }

    /// Push all pending deltas. Returns per-dataset counts; advances cursors
    /// only for acknowledged datasets. Safe to call offline (reports error,
    /// pushes nothing, backs off).
    @discardableResult
    public func sync(store: UsageStoring, now: Date = Date()) -> SyncReport {
        guard let baseURL else { return SyncReport(skipped: CloudSyncDataset.allCases.map(\.rawValue)) }
        lock.lock()
        if now < backoffUntil { lock.unlock(); return SyncReport(error: "backing off") }
        lock.unlock()
        let transport = transportFactory(baseURL)
        var report = SyncReport()
        do {
            report.pushed[CloudSyncDataset.usageEvents.rawValue] = try pushUsage(store: store, transport: transport)
            report.pushed[CloudSyncDataset.limits.rawValue] = try pushLimits(store: store, transport: transport, now: now)
            report.pushed[CloudSyncDataset.leaderboard.rawValue] = try pushLeaderboard(store: store, transport: transport, now: now)
        } catch {
            report.error = String(describing: error)
            lock.lock()
            backoffUntil = now.addingTimeInterval(60)
            lock.unlock()
        }
        lock.lock()
        _lastReport = report
        if report.error == nil { _lastSync = now }
        lock.unlock()
        return report
    }

    private func pushUsage(store: UsageStoring, transport: CloudTransport) throws -> Int {
        let cursor = Int64(try store.syncCursor(dataset: CloudSyncDataset.usageEvents.rawValue) ?? "0") ?? 0
        let page = try store.events(afterSequence: cursor, limit: batchSize)
        guard !page.events.isEmpty else { return 0 }
        try transport.post(path: "/ingest/events", payload: CloudSchema.encode(CloudSchema.usageEvents(page.events)))
        try store.setSyncCursor(dataset: CloudSyncDataset.usageEvents.rawValue, cursor: String(page.lastSequence))
        return page.events.count
    }

    private func pushLimits(store: UsageStoring, transport: CloudTransport, now: Date) throws -> Int {
        let sinceEpoch = Int(try store.syncCursor(dataset: CloudSyncDataset.limits.rawValue) ?? "0") ?? 0
        let from = Date(timeIntervalSince1970: TimeInterval(sinceEpoch))
        let snaps = try store.limitHistory(from: from, to: now, provider: nil).prefix(batchSize)
        guard !snaps.isEmpty else { return 0 }
        try transport.post(path: "/ingest/limits", payload: CloudSchema.encode(CloudSchema.limits(Array(snaps), sinceCursor: String(sinceEpoch))))
        if let last = snaps.map(\.recordedAt).max() {
            try store.setSyncCursor(dataset: CloudSyncDataset.limits.rawValue, cursor: String(Int(last.timeIntervalSince1970)))
        }
        return snaps.count
    }

    private func pushLeaderboard(store: UsageStoring, transport: CloudTransport, now: Date) throws -> Int {
        // Outbox semantics: the table holds only unacknowledged uploads
        // (rankings themselves live cloud-side). Push everything pending,
        // delete on ack. No cursor — the table IS the queue.
        let entries = try store.leaderboardSnapshots(since: .distantPast).prefix(batchSize)
        guard !entries.isEmpty else { return 0 }
        let pushStart = now
        try transport.post(path: "/ingest/leaderboard", payload: CloudSchema.encode(CloudSchema.leaderboard(Array(entries))))
        try store.clearSyncedLeaderboard(before: pushStart)
        return entries.count
    }
}
