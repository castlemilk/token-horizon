import Foundation

/// THE incremental JSONL reader (invariant #4) — one implementation for
/// every file tailer (FileConsolidator, UsageEngine scanners).
///
/// Semantics:
/// - consumes only bytes past `offset`, and only up to the LAST newline, so
///   a partially-written tail line survives unconsumed to the next poll;
/// - the stored offset advances by exactly the consumed byte count;
/// - truncation/rotation (file shrank below offset) restarts at 0 and fires
///   `onTruncate` BEFORE any line is delivered, so callers with per-file
///   accumulators can reset them (codex watermarks, additive totals) —
///   natural-key-idempotent consumers (annotations) pass no hook.
public enum IncrementalJSONL {

    @discardableResult
    public static func readNewLines(path: String, offset: inout UInt64,
                                    onTruncate: () -> Void = {},
                                    body: (Data, String) -> Void) -> Bool {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: path),
              let size = (attrs[.size] as? NSNumber)?.uint64Value else { return false }
        if size < offset {
            offset = 0
            onTruncate()
        }
        guard size > offset, let fh = FileHandle(forReadingAtPath: path) else { return false }
        fh.seek(toFileOffset: offset)
        let chunk = fh.readDataToEndOfFile()
        try? fh.close()
        guard let lastNL = chunk.lastIndex(of: UInt8(ascii: "\n")),
              lastNL >= chunk.startIndex else { return false }
        let consumable = chunk[chunk.startIndex...lastNL]
        for line in consumable.split(separator: UInt8(ascii: "\n")) where !line.isEmpty {
            body(Data(line), String(decoding: line, as: UTF8.self))
        }
        offset += UInt64(consumable.count)
        return true
    }
}
