import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Cloud sync: local Core store (on-machine source of truth, offline-capable)
/// publishes deltas to a cloud DB with a deliberately different schema.
///
/// Local tables stay write-optimized per-machine (`usage_event`,
/// `limit_snapshot`). The cloud schema is read-optimized for cross-user
/// queries (rankings, team rollups); the `CloudSchema` mappers below are the
/// translation layer between them. Leaderboard contributions are derived
/// cloud-side from usage deltas — no leaderboard state lives on the machine,
/// not even pending: usage rows ARE the pending state, identified by the
/// handle/team envelope on every batch.
///
/// Flow per dataset (usage events, limits):
/// 1. read the persisted cursor from `sync_state`
/// 2. pull the delta from the store (rowid / timestamp based)
/// 3. map to the cloud schema and POST it with the identity envelope
/// 4. advance the cursor ONLY on acknowledged push
///
/// Offline (flights) = deltas accumulate locally; the next `sync()` after
/// reconnect pushes everything. Event UUIDs make redelivery idempotent.
public enum CloudSyncDataset: String, CaseIterable {
    case usageEvents = "usage_events"   // cursor: rowid
    case limits = "limits"               // cursor: epoch seconds
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
        let r = HTTP.send(req, timeout: timeout + 5)
        guard r.status > 0 else { throw URLError(.cannotConnectToHost) }
        guard (200..<300).contains(r.status) else { throw CloudTransportError(status: r.status) }
    }
}

/// Local → cloud schema mappers. Cloud payloads carry `machine_id` on every
/// row (multi-device attribution) and drop local-only columns.
public enum CloudSchema {
    public static func usageEvents(_ events: [UsageEvent]) -> [[String: Any]] {
        // The cloud schema is canonical + resolved: vendor/model fold to
        // canonical spellings, product/cost resolve their query-time ranks
        // (explicit > file > sniffed; reported > computed). Local rows stay
        // raw — the resolution happens here, at the read boundary.
        events.map { e in
            [
                "id": e.id.uuidString,
                "ts": Int(e.timestamp.timeIntervalSince1970),
                "machine_id": e.machineID,
                "machine_alias": e.machineAlias ?? NSNull(),
                "source": e.source.rawValue,
                "vendor": e.canonicalVendor,
                "model": e.canonicalModel,
                "tokens": ["input": e.tokens.input, "output": e.tokens.output,
                           "reasoning": e.tokens.reasoning, "cache_read": e.tokens.cacheRead,
                           "cache_write": e.tokens.cacheWrite],
                "cost": e.effectiveCost,
                "cost_source": e.effectiveCostSource?.rawValue ?? NSNull(),
                "session": e.sessionID ?? NSNull(),
                "product": e.effectiveProduct ?? NSNull(),
                "account_id": e.accountID ?? NSNull(),
                "request_id": e.requestID ?? NSNull(),
                "attestation": e.attestation.rawValue,
            ] as [String: Any]
        }
    }

    public static func limits(_ snapshots: [LimitSnapshot], sinceCursor: String) -> [[String: Any]] {
        snapshots.map { s in
            [
                "recorded_at": Int(s.recordedAt.timeIntervalSince1970),
                "machine_id": s.machineID,
                "provider": Canonical.vendor(s.provider),
                "account_id": s.accountID,
                "label": s.label,
                "used_percent": s.usedPercent,
                "resets_at": s.resetsAt.map { Int($0.timeIntervalSince1970) } ?? NSNull(),
                "detail": s.detail,
            ] as [String: Any]
        }
    }

    public static func encode(_ rows: [[String: Any]], envelope: [String: Any] = [:]) throws -> Data {
        var payload = envelope
        payload["rows"] = rows
        return try JSONSerialization.data(withJSONObject: payload)
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
    /// Identity envelope on every batch (cloud attributes rows to handle/team).
    public var handle: String
    public var team: String
    /// Server-minted user UUID learned at Google/Microsoft sign-in — pins
    /// attribution to that exact account (server falls back to handle when
    /// absent). Persisted by the daemon (CloudIdentityStore) so background
    /// sync keeps attributing correctly with the UI closed.
    public var userID: String
    /// Env-boot values, kept so sign-out can restore them.
    private let envHandle: String
    private let envTeam: String
    private let envBaseURL: URL?

    private let lock = NSLock()
    private var _lastReport = SyncReport()
    private var _lastSync: Date?
    private var backoffUntil = Date.distantPast
    /// Host-attached store so event ingestion can nudge a sync without
    /// knowing the wiring (set once at boot via `attach(store:)`).
    private var _store: UsageStoring?
    private var nudgePending = false
    private let nudgeQueue = DispatchQueue(label: "tokenhorizon.cloudsync.nudge", qos: .utility)
    /// How long activity nudges coalesce before firing — bursts of metered
    /// requests collapse into ONE push instead of one per request.
    public var nudgeDelay: TimeInterval = 4

    public var lastReport: SyncReport { lock.lock(); defer { lock.unlock() }; return _lastReport }
    public var lastSync: Date? { lock.lock(); defer { lock.unlock() }; return _lastSync }

    /// Attach the store at boot so `noteActivity()` can drive syncs.
    public func attach(store: UsageStoring) {
        lock.lock(); _store = store; lock.unlock()
    }

    /// Event-ingestion nudge: meters and /analytics/events call this after
    /// inserting rows so fresh usage ships within seconds instead of waiting
    /// for the next timer tick. Debounced (bursts coalesce), backoff-aware,
    /// no-op when sync is disabled. The CURSOR is still the boundary — the
    /// nudge only decides WHEN sync runs, never what it pushes.
    public func noteActivity() {
        guard baseURL != nil else { return }
        lock.lock()
        if nudgePending { lock.unlock(); return }
        nudgePending = true
        let store = _store
        lock.unlock()
        nudgeQueue.asyncAfter(deadline: .now() + nudgeDelay) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.nudgePending = false
            self.lock.unlock()
            guard let store else { return }
            self.sync(store: store)
        }
    }

    public init() {
        let env = ProcessInfo.processInfo.environment
        if let raw = env["TH_SYNC_URL"], let url = URL(string: raw) {
            baseURL = url
        }
        envHandle = env["TH_SYNC_HANDLE"] ?? NSUserName()
        envTeam = env["TH_SYNC_TEAM"] ?? ""
        envBaseURL = baseURL
        handle = envHandle
        team = envTeam
        userID = env["TH_SYNC_USER_ID"] ?? ""
    }

    /// Restore the env/default identity (UI sign-out clears the persisted
    /// cloud sign-in; sync falls back to the machine user). A base URL that
    /// came from the persisted identity (not env) is dropped too — after
    /// unlink, the daemon must not keep pushing to a server it only learned
    /// about from the signed-in UI.
    public func clearIdentity() {
        lock.lock()
        handle = envHandle
        team = envTeam
        userID = ""
        baseURL = envBaseURL
        lock.unlock()
    }

    private var envelope: [String: Any] {
        lock.lock()
        let (h, t, u) = (handle, team, userID)
        lock.unlock()
        return ["machine_id": MachineIdentity.current, "machine_alias": MachineIdentity.alias,
                "handle": h, "team": t, "user_id": u]
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
            report.pushed[CloudSyncDataset.usageEvents.rawValue] = try drainUsage(store: store, transport: transport)
            report.pushed[CloudSyncDataset.limits.rawValue] = try drainLimits(store: store, transport: transport, now: now)
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

    /// Safety cap on pages per sync() call: inserts arriving mid-drain keep
    /// the cursor moving forward, so a hard cap guarantees the loop exits
    /// and leaves the rest to the next tick/nudge.
    private let maxPagesPerSync = 40

    /// Push pages until the backlog is drained (a short page = caught up).
    /// Rows that landed BETWEEN ticks (or during this drain) all have
    /// rowid > cursor, so they are pushed here — the cursor only ever
    /// advances to acknowledged rows, nothing in between is skipped.
    private func drainUsage(store: UsageStoring, transport: CloudTransport) throws -> Int {
        var total = 0
        for _ in 0..<maxPagesPerSync {
            let n = try pushUsage(store: store, transport: transport)
            total += n
            if n < batchSize { break }
        }
        return total
    }

    private func drainLimits(store: UsageStoring, transport: CloudTransport, now: Date) throws -> Int {
        // The limits cursor is epoch-SECOND inclusive (`recorded_at >= ?`),
        // so a full page whose rows share the boundary second re-returns the
        // same rows — cloud ingest is idempotent (ON CONFLICT DO NOTHING),
        // but stop when the cursor stops advancing.
        var total = 0
        var lastCursor = ""
        for _ in 0..<maxPagesPerSync {
            let n = try pushLimits(store: store, transport: transport, now: now)
            total += n
            if n < batchSize { break }
            let cursor = (try? store.syncCursor(dataset: CloudSyncDataset.limits.rawValue)) ?? nil
            if cursor == lastCursor { break }
            lastCursor = cursor ?? ""
        }
        return total
    }

    private func pushUsage(store: UsageStoring, transport: CloudTransport) throws -> Int {
        let cursor = Int64(try store.syncCursor(dataset: CloudSyncDataset.usageEvents.rawValue) ?? "0") ?? 0
        let page = try store.events(afterSequence: cursor, limit: batchSize)
        guard !page.events.isEmpty else { return 0 }
        try transport.post(path: "/ingest/events", payload: CloudSchema.encode(CloudSchema.usageEvents(page.events), envelope: envelope))
        try store.setSyncCursor(dataset: CloudSyncDataset.usageEvents.rawValue, cursor: String(page.lastSequence))
        return page.events.count
    }

    private func pushLimits(store: UsageStoring, transport: CloudTransport, now: Date) throws -> Int {
        let sinceEpoch = Int(try store.syncCursor(dataset: CloudSyncDataset.limits.rawValue) ?? "0") ?? 0
        let from = Date(timeIntervalSince1970: TimeInterval(sinceEpoch))
        let snaps = try store.limitHistory(from: from, to: now, provider: nil).prefix(batchSize)
        guard !snaps.isEmpty else { return 0 }
        try transport.post(path: "/ingest/limits", payload: CloudSchema.encode(CloudSchema.limits(Array(snaps), sinceCursor: String(sinceEpoch)), envelope: envelope))
        if let last = snaps.map(\.recordedAt).max() {
            try store.setSyncCursor(dataset: CloudSyncDataset.limits.rawValue, cursor: String(Int(last.timeIntervalSince1970)))
        }
        return snaps.count
    }
}
