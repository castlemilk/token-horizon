import Foundation
#if canImport(SQLite3)
import SQLite3
#elseif canImport(CSQLite)
import CSQLite
#endif

/// Consolidation: backfill local provider files into UsageEvents so the
/// unified store has complete history (pre-meter era + reconciliation source).
///
/// INACTIVE BY DESIGN: nothing in the daemon or app calls ConsolidationRunner.
/// Consolidators exist as the reference logic for the meter↔files cross-check
/// and for one-off backfills. To run one deliberately:
///   let store = try SQLiteUsageStore()
///   try ClaudeConsolidator().consolidate(into: store)
///
/// Events carry DETERMINISTIC ids (hash of vendor+source-record key), so
/// re-running a consolidator is idempotent (INSERT OR IGNORE dedups).
open class FileConsolidator {
    open var vendor: String { fatalError("FileConsolidator subclass must set vendor") }
    open var sourceKind: SourceKind { .external }
    open var dirs: [String] { [] }

    public init() {}

    open func consolidate(into store: UsageStoring) throws -> Int { 0 }

    // MARK: - Deterministic event ids

    /// FNV-1a over the record key, twice with different seeds → 16 bytes → UUID.
    /// Stable across runs: re-consolidating the same record yields the same id.
    public func deterministicID(_ key: String) -> UUID {
        var h1: UInt64 = 0xcbf2_9ce4_8422_2325
        var h2: UInt64 = 0x8422_2325_cbf2_9ce4
        for byte in key.utf8 {
            h1 = (h1 ^ UInt64(byte)) &* 0x0000_0100_0000_01b3
            h2 = (h2 ^ UInt64(byte) &+ 1) &* 0x0000_0100_0000_01b3
        }
        var bytes = [UInt8]()
        for v in [h1, h2] {
            for shift in stride(from: 56, through: 0, by: -8) {
                bytes.append(UInt8((v >> UInt64(shift)) & 0xff))
            }
        }
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3],
                           bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11],
                           bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    // MARK: - Shared parse helpers (same conventions as UsageEngine/meters)

    public func intField(_ dict: [String: Any], _ key: String) -> Int {
        (dict[key] as? NSNumber)?.intValue ?? 0
    }

    public func anthropicBreakdown(_ usage: [String: Any]) -> TokenBreakdown {
        TokenBreakdown(
            input: intField(usage, "input_tokens"),
            output: intField(usage, "output_tokens"),
            cacheRead: intField(usage, "cache_read_input_tokens"),
            cacheWrite: intField(usage, "cache_creation_input_tokens"))
    }

    public func openAIBreakdown(_ usage: [String: Any]) -> TokenBreakdown {
        var b = TokenBreakdown(
            input: intField(usage, "prompt_tokens") + intField(usage, "input_tokens"),
            output: intField(usage, "completion_tokens") + intField(usage, "output_tokens"))
        for detailsKey in ["completion_tokens_details", "output_tokens_details"] {
            if let d = usage[detailsKey] as? [String: Any] {
                b.reasoning += intField(d, "reasoning_tokens")
            }
        }
        for detailsKey in ["prompt_tokens_details", "input_tokens_details"] {
            if let d = usage[detailsKey] as? [String: Any] {
                b.cacheRead += intField(d, "cached_tokens")
            }
        }
        return b
    }

    public func parseTimestamp(_ any: Any?) -> Date? {
        if let s = any as? String {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = iso.date(from: s) { return d }
            iso.formatOptions = [.withInternetDateTime]
            return iso.date(from: s)
        }
        if let n = any as? NSNumber {
            let v = n.doubleValue
            return Date(timeIntervalSince1970: v > 1e12 ? v / 1000 : v)
        }
        return nil
    }

    /// Stream one JSONL file line by line (full-file read; consolidators are
    /// batch tools, not incremental pollers).
    public func forEachLine(_ path: String, _ body: ([String: Any], String) -> Void) {
        guard let data = FileManager.default.contents(atPath: path),
              let text = String(data: data, encoding: .utf8) else { return }
        for line in text.components(separatedBy: "\n") where !line.isEmpty {
            if let lineData = line.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] {
                body(obj, line)
            }
        }
    }

    public func jsonlFiles(under dirs: [String], suffix: String = ".jsonl") -> [String] {
        var out: [String] = []
        let fm = FileManager.default
        for dir in dirs {
            let root = NSString(string: dir).expandingTildeInPath
            guard let en = fm.enumerator(atPath: root) else { continue }
            while let item = en.nextObject() as? String {
                if item.hasSuffix(suffix), !item.contains("/chunks/") {
                    out.append("\(root)/\(item)")
                }
            }
        }
        return out
    }
}

// MARK: - Claude Code

/// One event per assistant message with usage. Session id from the filename.
public final class ClaudeConsolidator: FileConsolidator {
    public override var vendor: String { "claude" }
    public override var dirs: [String] { ["~/.claude/projects", "~/.claude/transcripts"] }

    public override func consolidate(into store: UsageStoring) throws -> Int {
        var events: [UsageEvent] = []
        for file in jsonlFiles(under: dirs) {
            let session = URL(fileURLWithPath: file).deletingPathExtension().lastPathComponent
            var lineNo = 0
            forEachLine(file) { obj, _ in
                lineNo += 1
                guard let message = obj["message"] as? [String: Any],
                      let usage = message["usage"] as? [String: Any] else { return }
                let tokens = anthropicBreakdown(usage)
                guard tokens.total > 0 else { return }
                events.append(UsageEvent(
                    id: deterministicID("\(vendor):\(file):\(lineNo)"),
                    timestamp: parseTimestamp(obj["timestamp"]) ?? Date(),
                    machineID: MachineIdentity.current,
                    source: sourceKind, vendor: vendor,
                    model: message["model"] as? String ?? "",
                    tokens: tokens,
                    contextOccupancy: tokens.input + tokens.cacheRead + tokens.cacheWrite,
                    sessionID: session,
                    product: "claude-code",
                    attestation: .selfReported))
            }
        }
        try store.insert(events)
        return events.count
    }
}

// MARK: - Codex

/// `token_count` payloads carry per-request usage in `last_token_usage` —
/// that IS request-level data (input/output/cached/reasoning).
public final class CodexConsolidator: FileConsolidator {
    public override var vendor: String { "codex" }
    public override var dirs: [String] { ["~/.codex/sessions", "~/.codex/archived_sessions"] }

    public override func consolidate(into store: UsageStoring) throws -> Int {
        var events: [UsageEvent] = []
        for file in jsonlFiles(under: dirs) {
            let session = URL(fileURLWithPath: file).deletingPathExtension().lastPathComponent
            var lineNo = 0
            forEachLine(file) { obj, _ in
                lineNo += 1
                guard let payload = obj["payload"] as? [String: Any],
                      payload["type"] as? String == "token_count",
                      let info = payload["info"] as? [String: Any],
                      let last = info["last_token_usage"] as? [String: Any] else { return }
                var tokens = TokenBreakdown(
                    input: intField(last, "input_tokens"),
                    output: intField(last, "output_tokens"),
                    reasoning: intField(last, "reasoning_output_tokens"))
                tokens.cacheRead = max(intField(last, "cached_input_tokens"),
                                       intField(last, "cache_read_input_tokens"))
                guard tokens.total > 0 else { return }
                events.append(UsageEvent(
                    id: deterministicID("\(vendor):\(file):\(lineNo)"),
                    timestamp: parseTimestamp(obj["timestamp"]) ?? Date(),
                    machineID: MachineIdentity.current,
                    source: sourceKind, vendor: vendor,
                    model: "",
                    tokens: tokens,
                    contextOccupancy: tokens.input,
                    sessionID: session,
                    product: "codex",
                    attestation: .selfReported))
            }
        }
        try store.insert(events)
        return events.count
    }
}

// MARK: - Kimi

/// wire.jsonl token_usage payloads (input_other/output/cache read+creation).
public final class KimiConsolidator: FileConsolidator {
    public override var vendor: String { "kimi" }
    public override var dirs: [String] { ["~/.kimi/sessions"] }

    public override func consolidate(into store: UsageStoring) throws -> Int {
        var events: [UsageEvent] = []
        for file in jsonlFiles(under: dirs, suffix: "wire.jsonl") {
            var lineNo = 0
            forEachLine(file) { obj, _ in
                lineNo += 1
                guard let message = obj["message"] as? [String: Any],
                      let payload = message["payload"] as? [String: Any],
                      let usage = payload["token_usage"] as? [String: Any] else { return }
                let tokens = TokenBreakdown(
                    input: intField(usage, "input_other"),
                    output: intField(usage, "output"),
                    cacheRead: intField(usage, "input_cache_read"),
                    cacheWrite: intField(usage, "input_cache_creation"))
                guard tokens.total > 0 else { return }
                events.append(UsageEvent(
                    id: deterministicID("\(vendor):\(file):\(lineNo)"),
                    timestamp: parseTimestamp(obj["timestamp"]) ?? Date(),
                    machineID: MachineIdentity.current,
                    source: sourceKind, vendor: vendor, model: "",
                    tokens: tokens,
                    contextOccupancy: tokens.input + tokens.cacheRead + tokens.cacheWrite,
                    sessionID: URL(fileURLWithPath: file).deletingLastPathComponent().lastPathComponent,
                    product: "kimi-cli",
                    attestation: .selfReported))
            }
        }
        try store.insert(events)
        return events.count
    }
}

// MARK: - opencode (sqlite)

/// One event per assistant message row: tokens + cost + model + session.
public final class OpenCodeConsolidator: FileConsolidator {
    public override var vendor: String { "opencode" }

    public override func consolidate(into store: UsageStoring) throws -> Int {
        let candidates = [
            NSString("~/.local/share/opencode/opencode.db").expandingTildeInPath,
            NSString("~/Library/Application Support/opencode/opencode.db").expandingTildeInPath,
        ]
        guard let path = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else { return 0 }
        var handle: OpaquePointer?
        guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            sqlite3_close(handle)
            return 0
        }
        defer { sqlite3_close(handle) }
        let sql = """
        SELECT id, session_id, time_created,
               COALESCE(json_extract(data,'$.modelID'),''),
               COALESCE(json_extract(data,'$.tokens.input'),0),
               COALESCE(json_extract(data,'$.tokens.output'),0),
               COALESCE(json_extract(data,'$.tokens.reasoning'),0),
               COALESCE(json_extract(data,'$.tokens.cache.read'),0),
               COALESCE(json_extract(data,'$.tokens.cache.write'),0),
               COALESCE(json_extract(data,'$.cost'),0)
        FROM message WHERE json_extract(data,'$.role')='assistant'
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
        defer { sqlite3_finalize(stmt) }
        var events: [UsageEvent] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            func text(_ i: Int32) -> String {
                sqlite3_column_text(stmt, i).map { String(cString: $0) } ?? ""
            }
            let tokens = TokenBreakdown(
                input: Int(sqlite3_column_int64(stmt, 4)),
                output: Int(sqlite3_column_int64(stmt, 5)),
                reasoning: Int(sqlite3_column_int64(stmt, 6)),
                cacheRead: Int(sqlite3_column_int64(stmt, 7)),
                cacheWrite: Int(sqlite3_column_int64(stmt, 8)))
            guard tokens.total > 0 else { continue }
            events.append(UsageEvent(
                id: deterministicID("opencode:\(text(0))"),
                timestamp: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 2) / 1000),
                machineID: MachineIdentity.current,
                source: sourceKind, vendor: vendor, model: text(3),
                tokens: tokens,
                contextOccupancy: tokens.input,
                cost: sqlite3_column_double(stmt, 9),
                sessionID: text(1),
                product: "opencode",
                attestation: .selfReported))
        }
        try store.insert(events)
        return events.count
    }
}

// MARK: - Runner (INACTIVE by default)

/// Deliberate, explicit backfill entry point. NOT called by the daemon or app.
/// `enabled` must be set true by the caller; TH_CONSOLIDATE=1 in the
/// environment is the documented opt-in for manual runs.
public enum ConsolidationRunner {
    public static var enabled: Bool {
        ProcessInfo.processInfo.environment["TH_CONSOLIDATE"] == "1"
    }

    public static let consolidators: [FileConsolidator] = [
        ClaudeConsolidator(),
        CodexConsolidator(),
        KimiConsolidator(),
        OpenCodeConsolidator(),
    ]

    /// Returns event counts per vendor. Throws when not enabled.
    @discardableResult
    public static func run(into store: UsageStoring) throws -> [String: Int] {
        guard enabled else {
            throw UsageStoreError.stepFailed(
                "consolidation is inactive; set TH_CONSOLIDATE=1 to run deliberately")
        }
        var report: [String: Int] = [:]
        for consolidator in consolidators {
            report[consolidator.vendor] = try consolidator.consolidate(into: store)
        }
        return report
    }
}
