import Foundation
#if canImport(SQLite3)
import SQLite3
#elseif canImport(CSQLite)
import CSQLite
#endif

/// Local sqlite implementation of UsageStoring. One row per UsageEvent;
/// WAL mode so future concurrent readers (UI, sync) don't block writers.
/// Cloud backends (Postgres, HTTP API) slot in behind the same protocol.
public final class SQLiteUsageStore: UsageStoring {
    private var db: OpaquePointer?
    private let lock = NSLock()

    public let path: String

    public init(path: String? = nil) throws {
        let resolved = path ?? Platform.paths.configDirectory
            .appendingPathComponent("usage.db").path
        self.path = resolved
        try FileManager.default.createDirectory(
            atPath: NSString(string: resolved).deletingLastPathComponent,
            withIntermediateDirectories: true)
        var handle: OpaquePointer?
        guard sqlite3_open_v2(resolved, &handle,
                              SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                              nil) == SQLITE_OK else {
            sqlite3_close(handle)
            throw UsageStoreError.openFailed(resolved)
        }
        sqlite3_busy_timeout(handle, 150)
        db = handle
        try migrate()
    }

    deinit { sqlite3_close(db) }

    private func migrate() throws {
        let ddl = """
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS usage_event (
            id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            machine_id TEXT NOT NULL,
            source TEXT NOT NULL,
            vendor TEXT NOT NULL,
            model TEXT NOT NULL,
            input INTEGER NOT NULL DEFAULT 0,
            output INTEGER NOT NULL DEFAULT 0,
            reasoning INTEGER NOT NULL DEFAULT 0,
            cache_read INTEGER NOT NULL DEFAULT 0,
            cache_write INTEGER NOT NULL DEFAULT 0,
            context_occupancy INTEGER,
            context_limit INTEGER,
            cost REAL NOT NULL DEFAULT 0,
            prompt_tps REAL,
            gen_tps REAL,
            latency_ms INTEGER,
            session_id TEXT,
            thinking_level TEXT,
            thinking_raw TEXT,
            product TEXT,
            attestation TEXT NOT NULL DEFAULT 'selfReported'
        );
        CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_event(ts);
        CREATE INDEX IF NOT EXISTS idx_usage_vendor_ts ON usage_event(vendor, ts);
        CREATE INDEX IF NOT EXISTS idx_usage_machine_ts ON usage_event(machine_id, ts);
        CREATE TABLE IF NOT EXISTS context_state (
            session_id TEXT PRIMARY KEY,
            vendor TEXT NOT NULL,
            model TEXT NOT NULL,
            occupancy INTEGER NOT NULL,
            context_limit INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        """
        guard sqlite3_exec(db, ddl, nil, nil, nil) == SQLITE_OK else {
            throw UsageStoreError.stepFailed("migrate: \(lastError())")
        }
        // Forward-compatible column adds (existing DBs): errors are ignored —
        // SQLITE "duplicate column name" simply means the column exists.
        for alter in [
            "ALTER TABLE usage_event ADD COLUMN thinking_level TEXT",
            "ALTER TABLE usage_event ADD COLUMN thinking_raw TEXT",
            "ALTER TABLE usage_event ADD COLUMN product TEXT",
        ] {
            sqlite3_exec(db, alter, nil, nil, nil)
        }
        // Index on the added column runs AFTER the ALTERs (existing DBs).
        sqlite3_exec(db, "CREATE INDEX IF NOT EXISTS idx_usage_product_ts ON usage_event(product, ts)", nil, nil, nil)
    }

    // MARK: - UsageStoring

    public func insert(_ events: [UsageEvent]) throws {
        lock.lock(); defer { lock.unlock() }
        let sql = """
        INSERT OR IGNORE INTO usage_event
        (id, ts, machine_id, source, vendor, model, input, output, reasoning,
         cache_read, cache_write, context_occupancy, context_limit, cost,
         prompt_tps, gen_tps, latency_ms, session_id, attestation,
         thinking_level, thinking_raw, product)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil)
        for e in events {
            sqlite3_reset(stmt)
            sqlite3_clear_bindings(stmt)
            bindText(stmt, 1, e.id.uuidString)
            sqlite3_bind_int64(stmt, 2, Int64(e.timestamp.timeIntervalSince1970))
            bindText(stmt, 3, e.machineID)
            bindText(stmt, 4, e.source.rawValue)
            bindText(stmt, 5, e.vendor)
            bindText(stmt, 6, e.model)
            sqlite3_bind_int64(stmt, 7, Int64(e.tokens.input))
            sqlite3_bind_int64(stmt, 8, Int64(e.tokens.output))
            sqlite3_bind_int64(stmt, 9, Int64(e.tokens.reasoning))
            sqlite3_bind_int64(stmt, 10, Int64(e.tokens.cacheRead))
            sqlite3_bind_int64(stmt, 11, Int64(e.tokens.cacheWrite))
            bindOptInt(stmt, 12, e.contextOccupancy)
            bindOptInt(stmt, 13, e.contextLimit)
            sqlite3_bind_double(stmt, 14, e.cost)
            bindOptDouble(stmt, 15, e.promptTokPerSec)
            bindOptDouble(stmt, 16, e.generationTokPerSec)
            bindOptInt(stmt, 17, e.latencyMs)
            if let s = e.sessionID { bindText(stmt, 18, s) } else { sqlite3_bind_null(stmt, 18) }
            bindText(stmt, 19, e.attestation.rawValue)
            if let v = e.thinkingLevel { bindText(stmt, 20, v) } else { sqlite3_bind_null(stmt, 20) }
            if let v = e.thinkingRaw { bindText(stmt, 21, v) } else { sqlite3_bind_null(stmt, 21) }
            if let v = e.product { bindText(stmt, 22, v) } else { sqlite3_bind_null(stmt, 22) }
            guard sqlite3_step(stmt) == SQLITE_DONE else {
                sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
                throw UsageStoreError.stepFailed("insert: \(lastError())")
            }
        }
        sqlite3_exec(db, "COMMIT", nil, nil, nil)
    }

    // MARK: - Filtering

    /// WHERE clause from time range + filter. Returns SQL (starting with
    /// WHERE or empty) and the values to bind in order.
    private func whereSQL(from: Date, to: Date, filter: UsageFilter,
                          cursor: Int64? = nil, cursorBefore: Bool = true) -> (String, [String], [Int64]) {
        var clauses = ["ts >= ?", "ts < ?"]
        var ints: [Int64] = [Int64(from.timeIntervalSince1970), Int64(to.timeIntervalSince1970)]
        var strings: [String] = []
        if let cursor {
            clauses.append(cursorBefore ? "rowid < ?" : "rowid > ?")
            ints.append(cursor)
        }
        for clause in filter.sqlClauses {
            clauses.append("\(clause.column) = ?")
            strings.append(clause.value)
        }
        return ("WHERE " + clauses.joined(separator: " AND "), strings, ints)
    }

    private func bindWhere(_ stmt: OpaquePointer?, _ parts: (String, [String], [Int64])) {
        var index: Int32 = 1
        for v in parts.2 { sqlite3_bind_int64(stmt, index, v); index += 1 }
        for v in parts.1 { bindText(stmt, index, v); index += 1 }
    }

    /// Bind order must match whereSQL clause order: ts ints, cursor int,
    /// then filter strings. (Ints before strings because ts/cursor clauses
    /// are prepended.)

    // MARK: - Tabular query

    public func query(from: Date, to: Date, filter: UsageFilter,
                      cursor: Int64?, limit: Int) throws -> (events: [UsageEvent], nextCursor: Int64?) {
        let parts = whereSQL(from: from, to: to, filter: filter, cursor: cursor)
        let sql = """
        SELECT rowid, id, ts, machine_id, source, vendor, model, input, output,
               reasoning, cache_read, cache_write, context_occupancy, context_limit,
               cost, prompt_tps, gen_tps, latency_ms, session_id, attestation,
               thinking_level, thinking_raw, product
        FROM usage_event \(parts.0)
        ORDER BY rowid DESC LIMIT ?
        """
        lock.lock(); defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        bindWhere(stmt, parts)
        sqlite3_bind_int64(stmt, Int32(parts.2.count + parts.1.count + 1), Int64(limit))
        var out: [UsageEvent] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            out.append(readEvent(stmt))
        }
        let nextCursor: Int64? = out.count == limit ? lastRowid(of: out) : nil
        return (out, nextCursor)
    }

    private func lastRowid(of events: [UsageEvent]) -> Int64? {
        // rowid of the last row read — recovered via a lookup on the event id.
        guard let lastID = events.last?.id.uuidString else { return nil }
        var lookup: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT rowid FROM usage_event WHERE id = ?", -1, &lookup, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(lookup) }
        bindText(lookup, 1, lastID)
        guard sqlite3_step(lookup) == SQLITE_ROW else { return nil }
        return sqlite3_column_int64(lookup, 0)
    }

    // MARK: - Aggregates / buckets / summary

    public func aggregate(from: Date, to: Date, groupBy: UsageGroupBy, filter: UsageFilter) throws -> [UsageAggregate] {
        let keyExpr: String
        switch groupBy {
        case .vendor: keyExpr = "vendor"
        case .model: keyExpr = "vendor || '/' || model"
        case .machine: keyExpr = "machine_id"
        case .product: keyExpr = "COALESCE(product, '?')"
        case .session: keyExpr = "COALESCE(session_id, '')"
        case .day: keyExpr = "strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime')"
        }
        let parts = whereSQL(from: from, to: to, filter: filter)
        let sql = """
        SELECT \(keyExpr), SUM(input), SUM(output), SUM(reasoning),
               SUM(cache_read), SUM(cache_write), SUM(cost), COUNT(*),
               MIN(ts), MAX(ts)
        FROM usage_event
        \(parts.0)
        GROUP BY 1 ORDER BY 2+3+4+5+6 DESC
        """
        lock.lock(); defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        bindWhere(stmt, parts)
        var out: [UsageAggregate] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            var agg = UsageAggregate(key: columnText(stmt, 0))
            agg.tokens = TokenBreakdown(
                input: Int(sqlite3_column_int64(stmt, 1)),
                output: Int(sqlite3_column_int64(stmt, 2)),
                reasoning: Int(sqlite3_column_int64(stmt, 3)),
                cacheRead: Int(sqlite3_column_int64(stmt, 4)),
                cacheWrite: Int(sqlite3_column_int64(stmt, 5)))
            agg.cost = sqlite3_column_double(stmt, 6)
            agg.requests = Int(sqlite3_column_int64(stmt, 7))
            agg.firstEvent = Date(timeIntervalSince1970: sqlite3_column_double(stmt, 8))
            agg.lastEvent = Date(timeIntervalSince1970: sqlite3_column_double(stmt, 9))
            out.append(agg)
        }
        return out
    }

    public func buckets(from: Date, to: Date, bucketSeconds: Int, filter: UsageFilter) throws -> [UsageBucket] {
        let size = max(60, bucketSeconds)
        let parts = whereSQL(from: from, to: to, filter: filter)
        let sql = """
        SELECT (ts / \(size)) * \(size), vendor,
               SUM(input), SUM(output), SUM(reasoning),
               SUM(cache_read), SUM(cache_write), SUM(cost)
        FROM usage_event
        \(parts.0)
        GROUP BY 1, 2 ORDER BY 1
        """
        lock.lock(); defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        bindWhere(stmt, parts)
        var out: [UsageBucket] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            var b = UsageBucket(start: Int(sqlite3_column_int64(stmt, 0)),
                                vendor: columnText(stmt, 1))
            b.tokens = TokenBreakdown(
                input: Int(sqlite3_column_int64(stmt, 2)),
                output: Int(sqlite3_column_int64(stmt, 3)),
                reasoning: Int(sqlite3_column_int64(stmt, 4)),
                cacheRead: Int(sqlite3_column_int64(stmt, 5)),
                cacheWrite: Int(sqlite3_column_int64(stmt, 6)))
            b.cost = sqlite3_column_double(stmt, 7)
            out.append(b)
        }
        return out
    }

    public func upsertContextState(_ state: ContextState) throws {
        let sql = """
        INSERT INTO context_state (session_id, vendor, model, occupancy, context_limit, updated_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET
            vendor=excluded.vendor, model=excluded.model,
            occupancy=excluded.occupancy, context_limit=excluded.context_limit,
            updated_at=excluded.updated_at
        """
        lock.lock(); defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, state.sessionID)
        bindText(stmt, 2, state.vendor)
        bindText(stmt, 3, state.model)
        sqlite3_bind_int64(stmt, 4, Int64(state.occupancy))
        sqlite3_bind_int64(stmt, 5, Int64(state.limit))
        sqlite3_bind_int64(stmt, 6, Int64(state.updatedAt.timeIntervalSince1970))
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw UsageStoreError.stepFailed("upsertContextState: \(lastError())")
        }
    }

    public func summarize(from: Date, to: Date, filter: UsageFilter) throws -> [ProviderSummary] {
        let parts = whereSQL(from: from, to: to, filter: filter)
        let sql = """
        SELECT vendor, source, model,
               SUM(input), SUM(output), SUM(reasoning),
               SUM(cache_read), SUM(cache_write), SUM(cost), COUNT(*),
               AVG(gen_tps), AVG(prompt_tps), AVG(context_occupancy), MAX(ts)
        FROM usage_event
        \(parts.0)
        GROUP BY vendor, model
        ORDER BY 4+5+6+7+8 DESC
        """
        lock.lock(); defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        bindWhere(stmt, parts)
        var providers: [String: ProviderSummary] = [:]
        var order: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let vendor = columnText(stmt, 0)
            let source = columnText(stmt, 1)
            let model = columnText(stmt, 2)
            if providers[vendor] == nil {
                providers[vendor] = ProviderSummary(vendor: vendor, source: source)
                order.append(vendor)
            }
            var row = ModelSummary(model: model)
            row.tokens = TokenBreakdown(
                input: Int(sqlite3_column_int64(stmt, 3)),
                output: Int(sqlite3_column_int64(stmt, 4)),
                reasoning: Int(sqlite3_column_int64(stmt, 5)),
                cacheRead: Int(sqlite3_column_int64(stmt, 6)),
                cacheWrite: Int(sqlite3_column_int64(stmt, 7)))
            row.cost = sqlite3_column_double(stmt, 8)
            row.requests = Int(sqlite3_column_int64(stmt, 9))
            if sqlite3_column_type(stmt, 10) != SQLITE_NULL { row.avgGenerationTokPerSec = sqlite3_column_double(stmt, 10) }
            if sqlite3_column_type(stmt, 11) != SQLITE_NULL { row.avgPromptTokPerSec = sqlite3_column_double(stmt, 11) }
            if sqlite3_column_type(stmt, 12) != SQLITE_NULL { row.avgContextOccupancy = sqlite3_column_double(stmt, 12) }
            row.lastEvent = Date(timeIntervalSince1970: sqlite3_column_double(stmt, 13))
            providers[vendor]?.tokens.add(row.tokens)
            providers[vendor]?.cost += row.cost
            providers[vendor]?.requests += row.requests
            providers[vendor]?.models.append(row)
        }
        return order.compactMap { providers[$0] }
    }

    public func contextStates() throws -> [ContextState] {
        lock.lock(); defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
                "SELECT session_id, vendor, model, occupancy, context_limit, updated_at FROM context_state ORDER BY updated_at DESC",
                -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        var out: [ContextState] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            out.append(ContextState(
                sessionID: columnText(stmt, 0), vendor: columnText(stmt, 1),
                model: columnText(stmt, 2),
                occupancy: Int(sqlite3_column_int64(stmt, 3)),
                limit: Int(sqlite3_column_int64(stmt, 4)),
                updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 5))))
        }
        return out
    }

    public func events(afterSequence cursor: Int64, limit: Int) throws -> (events: [UsageEvent], lastSequence: Int64) {
        let sql = """
        SELECT rowid, id, ts, machine_id, source, vendor, model, input, output,
               reasoning, cache_read, cache_write, context_occupancy, context_limit,
               cost, prompt_tps, gen_tps, latency_ms, session_id, attestation,
               thinking_level, thinking_raw, product
        FROM usage_event WHERE rowid > ? ORDER BY rowid LIMIT ?
        """
        lock.lock(); defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, cursor)
        sqlite3_bind_int64(stmt, 2, Int64(limit))
        var out: [UsageEvent] = []
        var last = cursor
        while sqlite3_step(stmt) == SQLITE_ROW {
            last = sqlite3_column_int64(stmt, 0)
            out.append(readEvent(stmt))
        }
        return (out, last)
    }

    public func count() throws -> Int {
        lock.lock(); defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM usage_event", -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int64(stmt, 0))
    }

    /// Row → UsageEvent. Column layout fixed by the SELECTs above.
    private func readEvent(_ stmt: OpaquePointer?) -> UsageEvent {
        let tokens = TokenBreakdown(
            input: Int(sqlite3_column_int64(stmt, 7)),
            output: Int(sqlite3_column_int64(stmt, 8)),
            reasoning: Int(sqlite3_column_int64(stmt, 9)),
            cacheRead: Int(sqlite3_column_int64(stmt, 10)),
            cacheWrite: Int(sqlite3_column_int64(stmt, 11)))
        let occupancy = sqlite3_column_type(stmt, 12) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(stmt, 12))
        let ctxLimit = sqlite3_column_type(stmt, 13) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(stmt, 13))
        let promptTps = sqlite3_column_type(stmt, 15) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 15)
        let genTps = sqlite3_column_type(stmt, 16) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 16)
        let latency = sqlite3_column_type(stmt, 17) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(stmt, 17))
        let session = sqlite3_column_type(stmt, 18) == SQLITE_NULL ? nil : columnText(stmt, 18)
        let thinkingLevel = sqlite3_column_type(stmt, 20) == SQLITE_NULL ? nil : columnText(stmt, 20)
        let thinkingRaw = sqlite3_column_type(stmt, 21) == SQLITE_NULL ? nil : columnText(stmt, 21)
        let product = sqlite3_column_type(stmt, 22) == SQLITE_NULL ? nil : columnText(stmt, 22)
        return UsageEvent(
            id: UUID(uuidString: columnText(stmt, 1)) ?? UUID(),
            timestamp: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 2)),
            machineID: columnText(stmt, 3),
            source: SourceKind(rawValue: columnText(stmt, 4)) ?? .external,
            vendor: columnText(stmt, 5), model: columnText(stmt, 6),
            tokens: tokens, contextOccupancy: occupancy, contextLimit: ctxLimit,
            cost: sqlite3_column_double(stmt, 14),
            promptTokPerSec: promptTps, generationTokPerSec: genTps,
            latencyMs: latency, sessionID: session,
            thinkingLevel: thinkingLevel, thinkingRaw: thinkingRaw,
            product: product,
            attestation: Attestation(rawValue: columnText(stmt, 19)) ?? .selfReported)
    }

    // MARK: - Helpers

    /// sqlite3 destructor macro (not imported by the Swift module map).
    private var SQLITE_TRANSIENT: sqlite3_destructor_type {
        unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    }

    private func lastError() -> String {
        String(cString: sqlite3_errmsg(db))
    }

    private func bindText(_ stmt: OpaquePointer?, _ index: Int32, _ value: String) {
        sqlite3_bind_text(stmt, index, (value as NSString).utf8String, -1, SQLITE_TRANSIENT)
    }

    private func bindOptInt(_ stmt: OpaquePointer?, _ index: Int32, _ value: Int?) {
        if let v = value { sqlite3_bind_int64(stmt, index, Int64(v)) }
        else { sqlite3_bind_null(stmt, index) }
    }

    private func bindOptDouble(_ stmt: OpaquePointer?, _ index: Int32, _ value: Double?) {
        if let v = value { sqlite3_bind_double(stmt, index, v) }
        else { sqlite3_bind_null(stmt, index) }
    }

    private func columnText(_ stmt: OpaquePointer?, _ index: Int32) -> String {
        guard let c = sqlite3_column_text(stmt, index) else { return "" }
        return String(cString: c)
    }
}
