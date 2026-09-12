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
        var handle = try Self.open(resolved)
        if Self.isPreV1Database(handle) {
            // No migrations: the pre-v1 implementation is discarded. Archive
            // the old file aside (never delete) and start a fresh v1 store.
            sqlite3_close(handle)
            let archive = resolved + ".legacy-\(Int(Date().timeIntervalSince1970))"
            try? FileManager.default.moveItem(atPath: resolved, toPath: archive)
            for suffix in ["-wal", "-shm"] {
                try? FileManager.default.removeItem(atPath: resolved + suffix)
            }
            FileHandle.standardError.write(
                "token-horizon: pre-v1 usage.db archived to \(archive)\n".data(using: .utf8)!)
            handle = try Self.open(resolved)
        }
        sqlite3_busy_timeout(handle, 5000)
        db = handle
        try migrate()
        registerMachine(id: MachineIdentity.current, alias: MachineIdentity.alias)
    }

    /// Upsert one machine id → alias mapping (display label; the id remains
    /// the identity). Called on open for the local machine and on every
    /// metered insert for the event's machine.
    private func registerMachine(id: String, alias: String?) {
        lock.lock(); defer { lock.unlock() }
        registerMachineLocked(id: id, alias: alias)
    }

    private func registerMachineLocked(id: String, alias: String?) {
        guard let alias, !alias.isEmpty, !id.isEmpty else { return }
        let sql = """
        INSERT INTO machine (machine_id, alias, updated_at) VALUES (?,?,?)
        ON CONFLICT(machine_id) DO UPDATE SET alias=excluded.alias, updated_at=excluded.updated_at
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, id)
        bindText(stmt, 2, alias)
        sqlite3_bind_int64(stmt, 3, Int64(Date().timeIntervalSince1970))
        sqlite3_step(stmt)
    }

    private static func open(_ path: String) throws -> OpaquePointer? {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(path, &handle,
                              SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                              nil) == SQLITE_OK else {
            sqlite3_close(handle)
            throw UsageStoreError.openFailed(path)
        }
        return handle
    }

    /// v1 databases carry `PRAGMA user_version = 1`. Anything with a
    /// usage_event table but version 0 is from the discarded implementation.
    private static func isPreV1Database(_ handle: OpaquePointer?) -> Bool {
        var stmt: OpaquePointer?
        var version = 0
        if sqlite3_prepare_v2(handle, "PRAGMA user_version", -1, &stmt, nil) == SQLITE_OK,
           sqlite3_step(stmt) == SQLITE_ROW {
            version = Int(sqlite3_column_int(stmt, 0))
        }
        sqlite3_finalize(stmt)
        guard version == 0 else { return false }
        stmt = nil
        var hasTable = false
        if sqlite3_prepare_v2(handle,
                              "SELECT name FROM sqlite_master WHERE type='table' AND name='usage_event'",
                              -1, &stmt, nil) == SQLITE_OK,
           sqlite3_step(stmt) == SQLITE_ROW {
            hasTable = true
        }
        sqlite3_finalize(stmt)
        return hasTable
    }

    deinit { sqlite3_close(db) }

    /// v1 schema — THE first state of the database. There are no migrations:
    /// any pre-v1 database (user_version 0 with existing tables, from the
    /// discarded implementation) is archived aside as usage.legacy-<ts>.db
    /// on open and a fresh store is created.
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
            product_source TEXT,
            cost_source TEXT,
            account_id TEXT,
            request_id TEXT,
            request_id_alt TEXT,
            attestation TEXT NOT NULL DEFAULT 'measured'
        );
        CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_event(ts);
        CREATE INDEX IF NOT EXISTS idx_usage_vendor_ts ON usage_event(vendor, ts);
        CREATE INDEX IF NOT EXISTS idx_usage_machine_ts ON usage_event(machine_id, ts);
        CREATE INDEX IF NOT EXISTS idx_usage_product_ts ON usage_event(product, ts);
        CREATE INDEX IF NOT EXISTS idx_usage_requestid ON usage_event(request_id);
        CREATE TABLE IF NOT EXISTS context_state (
            session_id TEXT PRIMARY KEY,
            vendor TEXT NOT NULL,
            model TEXT NOT NULL,
            occupancy INTEGER NOT NULL,
            context_limit INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS limit_snapshot (
            recorded_at INTEGER NOT NULL,
            machine_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            account_id TEXT NOT NULL DEFAULT '',
            label TEXT NOT NULL,
            used_percent REAL NOT NULL,
            resets_at INTEGER,
            detail TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (recorded_at, machine_id, provider, account_id, label)
        );
        CREATE INDEX IF NOT EXISTS idx_limit_provider_ts ON limit_snapshot(provider, recorded_at);
        CREATE TABLE IF NOT EXISTS file_annotation (
            vendor TEXT NOT NULL,
            request_id TEXT NOT NULL,
            product TEXT,
            cost REAL,
            ts INTEGER NOT NULL,
            source_file TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (vendor, request_id)
        );
        -- Read-side canonicalization cache: raw spelling → canonical form.
        -- Pure derivative state (rebuilt lazily by the read path); stored
        -- usage/limit rows are NEVER rewritten. Model folds join this table
        -- so canonical grouping/filtering happens entirely in SQL.
        CREATE TABLE IF NOT EXISTS spelling (
            kind TEXT NOT NULL,         -- 'model' (keyed vendor||'/'||model)
            raw TEXT NOT NULL,
            canon TEXT NOT NULL,
            PRIMARY KEY (kind, raw)
        );
        CREATE TABLE IF NOT EXISTS sync_state (
            dataset TEXT PRIMARY KEY,
            cursor TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        );
        -- One row per machine: id → inferred alias. Joined at read time;
        -- usage/limit rows carry only machine_id (no per-row alias storage).
        CREATE TABLE IF NOT EXISTS machine (
            machine_id TEXT PRIMARY KEY,
            alias TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        DROP TABLE IF EXISTS leaderboard_snapshot;
        PRAGMA user_version = 1;
        """
        guard sqlite3_exec(db, ddl, nil, nil, nil) == SQLITE_OK else {
            throw UsageStoreError.stepFailed("schema: \(lastError())")
        }
    }


    // MARK: - UsageStoring

    public func insert(_ events: [UsageEvent]) throws {
        lock.lock(); defer { lock.unlock() }
        try insertLocked(events)
    }

    private func insertLocked(_ events: [UsageEvent]) throws {
        guard !events.isEmpty else { return }
        let sql = """
        INSERT OR IGNORE INTO usage_event
        (id, ts, machine_id, source, vendor, model, input, output, reasoning,
         cache_read, cache_write, context_occupancy, context_limit, cost,
         prompt_tps, gen_tps, latency_ms, session_id, attestation,
         thinking_level, thinking_raw, product, request_id,
         product_source, cost_source, account_id, request_id_alt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        // Retry BEGIN IMMEDIATE under parallel load (60× /stats+/event stress).
        var began = false
        for _ in 0..<5 {
            if sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK { began = true; break }
            Thread.sleep(forTimeInterval: 0.005)
        }
        guard began else { throw UsageStoreError.stepFailed("insert: busy") }
        for e in events {
            sqlite3_reset(stmt)
            sqlite3_clear_bindings(stmt)
            bindText(stmt, 1, e.id.uuidString)
            sqlite3_bind_int64(stmt, 2, Int64(e.timestamp.timeIntervalSince1970))
            bindText(stmt, 3, e.machineID)
            bindText(stmt, 4, e.source.rawValue)
            // RAW spellings are stored as received — vendor/model
            // canonicalization is a query-time concern (see vendorCaseSQL /
            // model merging in the read paths), never a write-time rewrite.
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
            if let v = e.requestID { bindText(stmt, 23, v) } else { sqlite3_bind_null(stmt, 23) }
            if let v = e.productSource { bindText(stmt, 24, v.rawValue) } else { sqlite3_bind_null(stmt, 24) }
            if let v = e.costSource { bindText(stmt, 25, v.rawValue) } else { sqlite3_bind_null(stmt, 25) }
            if let v = e.accountID { bindText(stmt, 26, v) } else { sqlite3_bind_null(stmt, 26) }
            if let v = e.requestIDAlt { bindText(stmt, 27, v) } else { sqlite3_bind_null(stmt, 27) }
            guard sqlite3_step(stmt) == SQLITE_DONE else {
                sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
                throw UsageStoreError.stepFailed("insert: \(lastError())")
            }
        }
        sqlite3_exec(db, "COMMIT", nil, nil, nil)
        // Alias lives in the machine table, not on each row.
        for e in events { registerMachineLocked(id: e.machineID, alias: e.machineAlias) }
    }

    // MARK: - Metered writes (the ONLY writer of usage rows)

    /// Live metered events. Plain idempotent insert — there is no second
    /// writer to reconcile against. File observations live in
    /// file_annotation and join at READ time, so nothing is ever merged or
    /// overwritten on the write path.
    public func insertMetered(_ events: [UsageEvent]) throws {
        lock.lock(); defer { lock.unlock() }
        try insertLocked(events)
    }

    // MARK: - File annotations (tool attribution; stored raw, joined at read)

    /// Store tool annotations from session files. Idempotent: (vendor,
    /// request_id) is the natural key, so re-polling the same files is a
    /// no-op. Timing is a non-issue BY DESIGN: annotations and metered rows
    /// never reference each other on write — the LEFT JOIN happens in the
    /// read queries, so arrival order (file before/after the response
    /// completes) cannot matter.
    public func annotate(_ annotations: [FileAnnotation]) throws {
        guard !annotations.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        let insertSQL = """
        INSERT OR IGNORE INTO file_annotation
        (vendor, request_id, product, cost, ts, source_file)
        VALUES (?,?,?,?,?,?)
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, insertSQL, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        for a in annotations {
            guard !a.requestID.isEmpty else { continue }
            sqlite3_reset(stmt)
            sqlite3_clear_bindings(stmt)
            bindText(stmt, 1, a.vendor)   // raw spelling; canonicalized at query time
            bindText(stmt, 2, a.requestID)
            if let v = a.product { bindText(stmt, 3, v) } else { sqlite3_bind_null(stmt, 3) }
            if let v = a.cost { sqlite3_bind_double(stmt, 4, v) } else { sqlite3_bind_null(stmt, 4) }
            sqlite3_bind_int64(stmt, 5, Int64(a.timestamp.timeIntervalSince1970))
            bindText(stmt, 6, a.sourceFile)
            sqlite3_step(stmt)
        }
    }

    // MARK: - Query-time canonicalization helpers

    /// SQL expression folding raw vendor spellings to canonical form
    /// (Canonical.vendorTable as a CASE, unknowns pass through lowercased).
    /// Used in GROUP BY / WHERE so stored rows stay raw while aggregation
    /// and filtering see canonical vendors.
    private func vendorCaseSQL(_ column: String) -> String {
        var s = "CASE LOWER(TRIM(\(column)))"
        for (alias, canonical) in Canonical.vendorTable {
            s += " WHEN '\(alias)' THEN '\(canonical)'"
        }
        return s + " ELSE LOWER(TRIM(\(column))) END"
    }

    /// Distinct raw (vendor, model) spellings currently stored, registered
    /// with their canonical forms in the `spelling` table. This is a pure
    /// READ-SIDE cache — it lets model folds run entirely in SQL (JOIN/GROUP
    /// BY) while stored rows stay raw. Rebuilt lazily, 30s TTL; the table
    /// can be dropped and recreated at any time.
    private var spellingsRefreshedAt = Date.distantPast
    private func ensureSpellingsCurrent() {
        lock.lock(); defer { lock.unlock() }
        guard Date().timeIntervalSince(spellingsRefreshedAt) > 30 else { return }
        spellingsRefreshedAt = Date()
        var rows: [(String, String)] = []
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "SELECT DISTINCT vendor, model FROM usage_event", -1, &stmt, nil) == SQLITE_OK {
            while sqlite3_step(stmt) == SQLITE_ROW {
                rows.append((columnText(stmt, 0), columnText(stmt, 1)))
            }
        }
        sqlite3_finalize(stmt)
        var ins: OpaquePointer?
        guard sqlite3_prepare_v2(db,
                "INSERT OR IGNORE INTO spelling (kind, raw, canon) VALUES ('model', ?, ?)",
                -1, &ins, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(ins) }
        for (vendor, model) in rows {
            sqlite3_reset(ins)
            sqlite3_clear_bindings(ins)
            bindText(ins, 1, "\(vendor)/\(model)")
            bindText(ins, 2, Canonical.model(vendor: vendor, model: model))
            sqlite3_step(ins)
        }
    }

    /// The file-annotation join, as a correlated subquery producing AT MOST
    /// ONE annotation row per usage row (never fan-out): matches either
    /// provider id the meter captured (header id or body id).
    private static let annotationJoinSQL = """
    LEFT JOIN file_annotation fa ON fa.rowid = (
        SELECT MIN(rowid) FROM file_annotation
        WHERE request_id = usage_event.request_id
           OR request_id = usage_event.request_id_alt
    )
    """

    /// The model-spelling join: folds raw (vendor, model) spellings to their
    /// canonical model in SQL. At most one spelling row per usage row.
    private static let modelSpellingJoinSQL = """
    LEFT JOIN spelling sm ON sm.kind = 'model'
        AND sm.raw = usage_event.vendor || '/' || usage_event.model
    """

    /// The machine join: id → display alias (one row per machine, no
    /// per-event alias storage).
    private static let machineJoinSQL = """
    LEFT JOIN machine mc ON mc.machine_id = usage_event.machine_id
    """


    // MARK: - Filtering

    /// WHERE clause from time range + filter. Returns SQL (starting with
    /// WHERE or empty) and the values to bind in order.
    ///
    /// Canonicalization at QUERY time: stored spellings are raw, so
    /// - a VENDOR filter folds both sides through the vendor CASE expression;
    /// - a MODEL filter matches via the spelling cache (subquery on the
    ///   canonical form) plus raw equality, entirely in SQL;
    /// - all other filters are exact matches on raw stored values.
    /// Column names are qualified so queries can LEFT JOIN file_annotation /
    /// spelling.
    private func whereSQL(from: Date, to: Date, filter: UsageFilter,
                          cursor: Int64? = nil, cursorBefore: Bool = true) -> (String, [String], [Int64]) {
        ensureSpellingsCurrent()
        var clauses = ["usage_event.ts >= ?", "usage_event.ts < ?"]
        var ints: [Int64] = [Int64(from.timeIntervalSince1970), Int64(to.timeIntervalSince1970)]
        var strings: [String] = []
        if let cursor {
            clauses.append(cursorBefore ? "usage_event.rowid < ?" : "usage_event.rowid > ?")
            ints.append(cursor)
        }
        if let vendor = filter.vendor {
            clauses.append("\(vendorCaseSQL("usage_event.vendor")) = ?")
            strings.append(Canonical.vendor(vendor))
        }
        if let model = filter.model {
            let target = Canonical.model(vendor: filter.vendor ?? "", model: model)
            clauses.append("""
            (usage_event.model = ?
             OR usage_event.vendor || '/' || usage_event.model IN
                (SELECT raw FROM spelling WHERE kind = 'model' AND canon = ?))
            """)
            strings.append(model)
            strings.append(target)
        }
        if let machine = filter.machineID {
            // Alias-aware: the machine query param accepts the raw machine id
            // OR its display alias (what group=machine returns as key).
            // Correlated subquery — no dependency on the mc join being
            // present in the calling SELECT.
            clauses.append("""
            (usage_event.machine_id = ?
             OR usage_event.machine_id IN (SELECT machine_id FROM machine WHERE alias = ?))
            """)
            strings.append(machine)
            strings.append(machine)
        }
        for clause in filter.sqlClauses where clause.column != "vendor" && clause.column != "model" && clause.column != "machine_id" {
            clauses.append("usage_event.\(clause.column) = ?")
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
        SELECT usage_event.rowid, usage_event.id, usage_event.ts, usage_event.machine_id,
               usage_event.source, usage_event.vendor, usage_event.model,
               usage_event.input, usage_event.output, usage_event.reasoning,
               usage_event.cache_read, usage_event.cache_write,
               usage_event.context_occupancy, usage_event.context_limit,
               usage_event.cost, usage_event.prompt_tps, usage_event.gen_tps,
               usage_event.latency_ms, usage_event.session_id, usage_event.attestation,
               usage_event.thinking_level, usage_event.thinking_raw, usage_event.product,
               usage_event.request_id, usage_event.product_source, usage_event.cost_source,
               usage_event.account_id, usage_event.request_id_alt, mc.alias,
               fa.product, fa.cost
        FROM usage_event \(Self.annotationJoinSQL) \(Self.machineJoinSQL) \(parts.0)
        ORDER BY usage_event.rowid DESC LIMIT ?
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
        let vendorCase = vendorCaseSQL("usage_event.vendor")
        let keyExpr: String
        switch groupBy {
        // All folds run in SQL: vendors via the CASE expression, models via
        // the spelling cache join, products via the annotation join rank.
        case .vendor: keyExpr = vendorCase
        case .model: keyExpr = "\(vendorCase) || '/' || COALESCE(sm.canon, usage_event.model)"
        case .machine: keyExpr = "COALESCE(mc.alias, usage_event.machine_id)"
        // Product groups resolve the attribution RANK at query time:
        // explicit port label > file-joined tool record > header sniff.
        case .product: keyExpr = """
        COALESCE(CASE WHEN usage_event.product_source = 'explicitLabel'
                      THEN usage_event.product END,
                 fa.product, usage_event.product, '?')
        """
        case .session: keyExpr = "COALESCE(usage_event.session_id, '')"
        case .day: keyExpr = "strftime('%Y-%m-%d', usage_event.ts, 'unixepoch', 'localtime')"
        }
        let parts = whereSQL(from: from, to: to, filter: filter)
        let sql = """
        SELECT \(keyExpr), SUM(usage_event.input), SUM(usage_event.output), SUM(usage_event.reasoning),
               SUM(usage_event.cache_read), SUM(usage_event.cache_write), SUM(usage_event.cost), COUNT(*),
               MIN(usage_event.ts), MAX(usage_event.ts)
        FROM usage_event \(Self.annotationJoinSQL) \(Self.modelSpellingJoinSQL) \(Self.machineJoinSQL)
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
        let size = BucketResolution.snap(bucketSeconds)
        let parts = whereSQL(from: from, to: to, filter: filter)
        // Vendor series fold to canonical form at query time; rows stay raw.
        let sql = """
        SELECT (usage_event.ts / \(size)) * \(size), \(vendorCaseSQL("usage_event.vendor")),
               SUM(usage_event.input), SUM(usage_event.output), SUM(usage_event.reasoning),
               SUM(usage_event.cache_read), SUM(usage_event.cache_write), SUM(usage_event.cost)
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
        SELECT \(vendorCaseSQL("usage_event.vendor")), usage_event.source,
               COALESCE(sm.canon, usage_event.model),
               SUM(usage_event.input), SUM(usage_event.output), SUM(usage_event.reasoning),
               SUM(usage_event.cache_read), SUM(usage_event.cache_write), SUM(usage_event.cost), COUNT(*),
               SUM(usage_event.gen_tps * (usage_event.output+usage_event.input)) / NULLIF(SUM(usage_event.output+usage_event.input),0),
               SUM(usage_event.prompt_tps * (usage_event.output+usage_event.input)) / NULLIF(SUM(usage_event.output+usage_event.input),0),
               SUM(usage_event.context_occupancy * (usage_event.output+usage_event.input)) / NULLIF(SUM(usage_event.output+usage_event.input),0),
               MAX(usage_event.ts)
        FROM usage_event \(Self.modelSpellingJoinSQL)
        \(parts.0)
        GROUP BY 1, 3
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
        SELECT usage_event.rowid, usage_event.id, usage_event.ts, usage_event.machine_id,
               usage_event.source, usage_event.vendor, usage_event.model,
               usage_event.input, usage_event.output, usage_event.reasoning,
               usage_event.cache_read, usage_event.cache_write,
               usage_event.context_occupancy, usage_event.context_limit,
               usage_event.cost, usage_event.prompt_tps, usage_event.gen_tps,
               usage_event.latency_ms, usage_event.session_id, usage_event.attestation,
               usage_event.thinking_level, usage_event.thinking_raw, usage_event.product,
               usage_event.request_id, usage_event.product_source, usage_event.cost_source,
               usage_event.account_id, usage_event.request_id_alt, mc.alias,
               fa.product, fa.cost
        FROM usage_event \(Self.annotationJoinSQL) \(Self.machineJoinSQL)
        WHERE usage_event.rowid > ? ORDER BY usage_event.rowid LIMIT ?
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

    public func recordLimits(_ snapshots: [LimitSnapshot]) throws {
        guard !snapshots.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        let sql = """
        INSERT OR IGNORE INTO limit_snapshot
        (recorded_at, machine_id, provider, account_id, label, used_percent, resets_at, detail)
        VALUES (?,?,?,?,?,?,?,?)
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        for s in snapshots {
            // Minute-granularity dedup: refreshes within the same minute collapse.
            let minute = Int64(s.recordedAt.timeIntervalSince1970) / 60 * 60
            sqlite3_bind_int64(stmt, 1, minute)
            bindText(stmt, 2, s.machineID)
            bindText(stmt, 3, s.provider)   // raw spelling; canonicalized at query time
            bindText(stmt, 4, s.accountID)
            bindText(stmt, 5, s.label)
            sqlite3_bind_double(stmt, 6, s.usedPercent)
            if let r = s.resetsAt { sqlite3_bind_int64(stmt, 7, Int64(r.timeIntervalSince1970)) }
            else { sqlite3_bind_null(stmt, 7) }
            bindText(stmt, 8, s.detail)
            sqlite3_step(stmt)
            sqlite3_reset(stmt)
            sqlite3_clear_bindings(stmt)
        }
        // Bound table growth: keep 370 days.
        let cutoff = Int64(Date().timeIntervalSince1970) - 370 * 86_400
        sqlite3_exec(db, "DELETE FROM limit_snapshot WHERE recorded_at < \(cutoff)", nil, nil, nil)
    }

    public func limitHistory(from: Date, to: Date, provider: String?) throws -> [LimitSnapshot] {
        lock.lock(); defer { lock.unlock() }
        // Providers are stored RAW; a provider filter folds both sides
        // through the same vendor CASE expression used for usage vendors.
        let providerClause = provider != nil
            ? " AND \(vendorCaseSQL("provider")) = ?" : ""
        let sql = """
        SELECT recorded_at, machine_id, provider, account_id, label, used_percent, resets_at, detail
        FROM limit_snapshot WHERE recorded_at >= ? AND recorded_at < ?\(providerClause)
        ORDER BY recorded_at
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, Int64(from.timeIntervalSince1970))
        sqlite3_bind_int64(stmt, 2, Int64(to.timeIntervalSince1970))
        if let provider { bindText(stmt, 3, Canonical.vendor(provider)) }
        var out: [LimitSnapshot] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let resets: Date? = sqlite3_column_type(stmt, 6) == SQLITE_NULL
                ? nil : Date(timeIntervalSince1970: sqlite3_column_double(stmt, 6))
            out.append(LimitSnapshot(
                recordedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 0)),
                machineID: columnText(stmt, 1),
                provider: columnText(stmt, 2),
                accountID: columnText(stmt, 3),
                label: columnText(stmt, 4),
                usedPercent: sqlite3_column_double(stmt, 5),
                resetsAt: resets,
                detail: columnText(stmt, 7)))
        }
        return out
    }

    public func syncCursor(dataset: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT cursor FROM sync_state WHERE dataset = ?",
                                 -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, dataset)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return columnText(stmt, 0)
    }

    public func setSyncCursor(dataset: String, cursor: String) throws {
        lock.lock(); defer { lock.unlock() }
        let sql = """
        INSERT INTO sync_state (dataset, cursor, updated_at) VALUES (?,?,?)
        ON CONFLICT(dataset) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw UsageStoreError.prepareFailed(lastError())
        }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, dataset)
        bindText(stmt, 2, cursor)
        sqlite3_bind_int64(stmt, 3, Int64(Date().timeIntervalSince1970))
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw UsageStoreError.stepFailed("setSyncCursor: \(lastError())")
        }
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
        let requestID = sqlite3_column_type(stmt, 23) == SQLITE_NULL ? nil : columnText(stmt, 23)
        let productSource = sqlite3_column_type(stmt, 24) == SQLITE_NULL ? nil : ProductSource(rawValue: columnText(stmt, 24))
        let costSource = sqlite3_column_type(stmt, 25) == SQLITE_NULL ? nil : CostSource(rawValue: columnText(stmt, 25))
        let accountID = sqlite3_column_type(stmt, 26) == SQLITE_NULL ? nil : columnText(stmt, 26)
        let requestIDAlt = sqlite3_column_type(stmt, 27) == SQLITE_NULL ? nil : columnText(stmt, 27)
        let fileProduct = sqlite3_column_type(stmt, 29) == SQLITE_NULL ? nil : columnText(stmt, 29)
        let fileCost = sqlite3_column_type(stmt, 30) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 30)
        return UsageEvent(
            id: UUID(uuidString: columnText(stmt, 1)) ?? UUID(),
            timestamp: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 2)),
            machineID: columnText(stmt, 3),
            machineAlias: sqlite3_column_type(stmt, 28) == SQLITE_NULL ? nil : columnText(stmt, 28),
            source: SourceKind(rawValue: columnText(stmt, 4)) ?? .external,
            vendor: columnText(stmt, 5), model: columnText(stmt, 6),
            tokens: tokens, contextOccupancy: occupancy, contextLimit: ctxLimit,
            cost: sqlite3_column_double(stmt, 14),
            promptTokPerSec: promptTps, generationTokPerSec: genTps,
            latencyMs: latency, sessionID: session,
            thinkingLevel: thinkingLevel, thinkingRaw: thinkingRaw,
            product: product, productSource: productSource, costSource: costSource,
            accountID: accountID, fileProduct: fileProduct, fileCost: fileCost,
            requestID: requestID, requestIDAlt: requestIDAlt,
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
