import Foundation
#if canImport(SQLite3)
import SQLite3
#elseif canImport(CSQLite)
import CSQLite
#endif

/// Consolidation: recover TOOL ATTRIBUTION and LIMITS from provider files.
///
/// Files NEVER create usage rows, and they never MODIFY usage rows either.
/// Usage is measured exclusively by request meters. What files contribute is
/// stored at full resolution ALONGSIDE the meter's observations:
///   1. FileAnnotations — the file's own claim of tool identity and
///      tool/provider-reported cost, keyed by the PROVIDER REQUEST ID. The
///      store keeps them in `file_annotation` and LEFT JOINs them at READ
///      time, so arrival order (file before/after the response) cannot
///      matter and no observation is ever overwritten — the ranking
///      (explicit label > file record > header sniff; reported cost >
///      computed) is a query-time decision.
///   2. LimitSnapshots — rate-limit state captured in file records (codex
///      `token_count` payloads carry the account's window utilization),
///      consolidated against the same vendor ACCOUNT as meter/API sources.
///
/// A file record with no provider request id yields nothing — the tool
/// simply never gets the label for that request (meter header-sniffing may
/// still attribute it).
///
/// GATED BY DESIGN: routine passes run via FilePoller (60s, .fileReading
/// consent). ConsolidationRunner.run remains a deliberate one-off
/// (TH_CONSOLIDATE=1) for backfills.
open class FileConsolidator {
    open var vendor: String { fatalError("FileConsolidator subclass must set vendor") }
    open var sourceKind: SourceKind { .external }
    open var dirs: [String] { [] }

    public init() {}

    /// One pass over the files. Returns the number of observations emitted
    /// (annotations + limit snapshots). Idempotent by store natural keys.
    open func consolidate(into store: UsageStoring) throws -> Int { 0 }

    // MARK: - Shared parse helpers (same conventions as UsageEngine/meters)

    public func intField(_ dict: [String: Any], _ key: String) -> Int {
        (dict[key] as? NSNumber)?.intValue ?? 0
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
        let home = Platform.paths.homeDirectory.path
        for dir in dirs {
            let root: String
            if dir.hasPrefix("~/") { root = home + "/" + String(dir.dropFirst(2)) }
            else if dir == "~" { root = home }
            else { root = dir }
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

/// Transcript `requestId` == the `request-id` response header the
/// AnthropicMeter captures — the exact join key. One annotation per
/// assistant message carrying usage.
public final class ClaudeConsolidator: FileConsolidator {
    public override var vendor: String { "claude" }
    public override var dirs: [String] { ["~/.claude/projects", "~/.claude/transcripts"] }

    public override func consolidate(into store: UsageStoring) throws -> Int {
        var annotations: [FileAnnotation] = []
        for file in jsonlFiles(under: dirs) {
            forEachLine(file) { obj, _ in
                guard let message = obj["message"] as? [String: Any],
                      let usage = message["usage"] as? [String: Any],
                      ((usage["input_tokens"] as? NSNumber)?.intValue ?? 0) > 0
                        || ((usage["output_tokens"] as? NSNumber)?.intValue ?? 0) > 0,
                      let rid = obj["requestId"] as? String, !rid.isEmpty else { return }
                annotations.append(FileAnnotation(
                    vendor: vendor, requestID: rid,
                    product: "claude-code",
                    timestamp: parseTimestamp(obj["timestamp"]) ?? Date(),
                    sourceFile: file))
            }
        }
        try store.annotate(annotations)
        return annotations.count
    }
}

// MARK: - Codex

/// `token_count` payloads carry no provider request id — codex sessions can
/// never be tool-annotated (the meter's User-Agent sniff covers codex).
/// What they DO carry is the account's rate-limit state
/// (`payload.rate_limits.primary/secondary`), captured here as limit
/// snapshots. Account is unknown from files ("" = single/unknown account).
public final class CodexConsolidator: FileConsolidator {
    public override var vendor: String { "codex" }
    public override var dirs: [String] { ["~/.codex/sessions", "~/.codex/archived_sessions"] }

    public override func consolidate(into store: UsageStoring) throws -> Int {
        var snapshots: [LimitSnapshot] = []
        for file in jsonlFiles(under: dirs) {
            forEachLine(file) { obj, _ in
                guard let payload = obj["payload"] as? [String: Any],
                      payload["type"] as? String == "token_count",
                      let rateLimits = payload["rate_limits"] as? [String: Any] else { return }
                let ts = parseTimestamp(obj["timestamp"]) ?? Date()
                for window in ["primary", "secondary"] {
                    guard let w = rateLimits[window] as? [String: Any],
                          let used = (w["used_percent"] as? NSNumber)?.doubleValue else { continue }
                    let minutes = (w["window_minutes"] as? NSNumber)?.intValue ?? 0
                    let resets = (w["resets_at"] as? NSNumber)?.doubleValue
                    snapshots.append(LimitSnapshot(
                        recordedAt: ts,
                        machineID: MachineIdentity.current,
                        provider: vendor,
                        accountID: "",
                        label: Self.windowLabel(minutes: minutes),
                        usedPercent: used,
                        resetsAt: resets.map { Date(timeIntervalSince1970: $0) },
                        detail: "codex \(window) window (file)"))
                }
            }
        }
        try store.recordLimits(snapshots)
        return snapshots.count
    }

    static func windowLabel(minutes: Int) -> String {
        switch minutes {
        case 0: return "window (file)"
        case 10_080: return "weekly (file)"
        case 1_440: return "daily (file)"
        case let m where m % 60 == 0: return "\(m / 60)h (file)"
        default: return "\(minutes)m (file)"
        }
    }
}

// MARK: - Kimi

/// wire.jsonl records usually carry no provider request id; when one is
/// present it joins the AnthropicMeter's wire id (kimi speaks the
/// anthropic-compatible format).
public final class KimiConsolidator: FileConsolidator {
    public override var vendor: String { "kimi" }
    public override var dirs: [String] { ["~/.kimi/sessions"] }

    public override func consolidate(into store: UsageStoring) throws -> Int {
        var annotations: [FileAnnotation] = []
        for file in jsonlFiles(under: dirs, suffix: "wire.jsonl") {
            forEachLine(file) { obj, _ in
                guard let message = obj["message"] as? [String: Any],
                      let payload = message["payload"] as? [String: Any],
                      payload["token_usage"] != nil else { return }
                let rid = (payload["request_id"] as? String)
                    ?? (payload["requestId"] as? String)
                    ?? (message["requestId"] as? String)
                    ?? (obj["request_id"] as? String) ?? ""
                guard !rid.isEmpty else { return }
                annotations.append(FileAnnotation(
                    vendor: vendor, requestID: rid,
                    product: "kimi-cli",
                    timestamp: parseTimestamp(obj["timestamp"]) ?? Date(),
                    sourceFile: file))
            }
        }
        try store.annotate(annotations)
        return annotations.count
    }
}

// MARK: - pi (coding agent harness)

/// ~/.pi/agent/sessions/<project>/<ts>_<uuid>.jsonl — assistant messages carry
/// `usage { ..., cost.total }` and `responseId` == the provider body id
/// (chatcmpl-/resp- for OpenAI-style APIs, msg_... for Anthropic — the
/// meter captures both via requestID/requestIDAlt).
///
/// Vendor attribution: pi is the HARNESS, `message.provider` is the upstream
/// vendor — annotations carry vendor = provider (raw spelling; folds to
/// canonical at query time) and product = "pi". Pi also reports the actual
/// billed cost, which outranks the meter's computed/plan cost at query time
/// (both are stored; nothing is merged).
public final class PiConsolidator: FileConsolidator {
    public override var vendor: String { "pi" }
    public override var dirs: [String] { ["~/.pi/agent/sessions"] }

    public override func consolidate(into store: UsageStoring) throws -> Int {
        var annotations: [FileAnnotation] = []
        for file in jsonlFiles(under: dirs) {
            forEachLine(file) { obj, _ in
                guard obj["type"] as? String == "message",
                      let message = obj["message"] as? [String: Any],
                      message["role"] as? String == "assistant",
                      message["usage"] != nil,
                      let rid = message["responseId"] as? String, !rid.isEmpty else { return }
                let provider = (message["provider"] as? String ?? "pi")
                    .lowercased().replacingOccurrences(of: " ", with: "-")
                let cost = ((message["usage"] as? [String: Any])?["cost"] as? [String: Any])?["total"]
                    as? NSNumber
                annotations.append(FileAnnotation(
                    vendor: provider, requestID: rid,
                    product: "pi",
                    cost: cost?.doubleValue,
                    timestamp: parseTimestamp(obj["timestamp"]) ?? Date(),
                    sourceFile: file))
            }
        }
        try store.annotate(annotations)
        return annotations.count
    }
}

// MARK: - opencode (sqlite)

/// One annotation per assistant message row that exposes an upstream
/// response id. opencode's own message ids are internal and never join —
/// only a provider-issued response id does. Rows carry the zen-reported
/// cost, which becomes the authoritative cost on the joined metered row.
public final class OpenCodeConsolidator: FileConsolidator {
    public override var vendor: String { "opencode" }

    public override func consolidate(into store: UsageStoring) throws -> Int {
        let home = Platform.paths.homeDirectory.path
        let candidates = [
            home + "/.local/share/opencode/opencode.db",
            home + "/Library/Application Support/opencode/opencode.db",
        ]
        guard let path = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else { return 0 }
        var handle: OpaquePointer?
        guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            sqlite3_close(handle)
            return 0
        }
        defer { sqlite3_close(handle) }
        let sql = """
        SELECT COALESCE(json_extract(data,'$.responseID'),
                        json_extract(data,'$.responseId'),
                        json_extract(data,'$.provider.responseId'), ''),
               time_created,
               COALESCE(json_extract(data,'$.cost'),0)
        FROM message WHERE json_extract(data,'$.role')='assistant'
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
        defer { sqlite3_finalize(stmt) }
        var annotations: [FileAnnotation] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let rid = sqlite3_column_text(stmt, 0).map { String(cString: $0) } ?? ""
            guard !rid.isEmpty else { continue }
            annotations.append(FileAnnotation(
                vendor: vendor, requestID: rid,
                product: "opencode",
                cost: sqlite3_column_double(stmt, 2),
                timestamp: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 1) / 1000),
                sourceFile: path))
        }
        try store.annotate(annotations)
        return annotations.count
    }
}

// MARK: - Runner (INACTIVE by default)

/// Deliberate, explicit backfill entry point. NOT called by the daemon or app
/// except with TH_CONSOLIDATE=1. Re-runs are idempotent: annotations key on
/// (vendor, request_id); limit snapshots dedup per minute.
public enum ConsolidationRunner {
    public static var enabled: Bool {
        ProcessInfo.processInfo.environment["TH_CONSOLIDATE"] == "1"
    }

    public static let consolidators: [FileConsolidator] = [
        ClaudeConsolidator(),
        CodexConsolidator(),
        KimiConsolidator(),
        PiConsolidator(),
        OpenCodeConsolidator(),
    ]

    /// Returns observation counts per vendor. Throws when not enabled.
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
