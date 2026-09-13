import Foundation

/// Durable 15-minute usage ledger for self-managed runtimes (vLLM, SGLang, llama.cpp).
///
/// Why this exists: cloud providers keep their own durable records (JSONL logs,
/// sqlite DBs) that UsageEngine re-derives on every launch. Local runtimes keep
/// token counters in server memory only — restart the server and they reset to
/// zero, restart the daemon and the deltas are lost. The ledger persists
/// *measured counter deltas* into 15-minute buckets so local inference accrues
/// the same queryable history as providers: totals, per-day trends, token-type
/// breakdown, per-model attribution.
///
/// Honesty rule (invariant #10 spirit): only measured counter deltas are
/// recorded. Tokens a server generated while the daemon was down are NOT
/// backfilled — the first sighting of a counter establishes a baseline.
public final class RuntimeUsageLedger {
    public static let shared = RuntimeUsageLedger()

    /// Token-type deltas for one 15-minute bucket. Mirrors TokenBreakdown.
    public struct Entry: Codable, Equatable {
        public var input = 0
        public var output = 0
        public var reasoning = 0
        public var cacheRead = 0
        public var cacheWrite = 0

        public init() {}

        public var total: Int { input + output + reasoning + cacheRead + cacheWrite }

        public var breakdown: TokenBreakdown {
            TokenBreakdown(input: input, output: output, reasoning: reasoning,
                           cacheRead: cacheRead, cacheWrite: cacheWrite)
        }
    }

    private struct DiskFormat: Codable {
        // scope -> bucketEpoch(string) -> entry
        var scopes: [String: [String: Entry]] = [:]
    }

    /// Scope keys: "vllm" (vendor aggregate) or "vllm|qwen3-32b" (per model).
    private let lock = NSLock()
    private var scopes: [String: [Int: Entry]] = [:]
    private var dirty = false
    private var lastFlush = Date.distantPast

    /// Buckets older than this are pruned on flush (bounds disk growth).
    public var retentionSeconds = 366 * 86_400

    /// Finest tick: 5 minutes (matches UsageEngine; old 15-min keys remain
    /// valid — 900s boundaries align with every third 5-min boundary).
    public static let bucketSeconds = 300

    public let storeURL: URL

    public init(storeURL: URL? = nil) {
        let url = storeURL ?? Platform.paths.configDirectory
            .appendingPathComponent("runtime-usage.json")
        self.storeURL = url
        load(from: url)
    }

    public static func bucketStart(_ epochSeconds: Int) -> Int {
        epochSeconds / bucketSeconds * bucketSeconds
    }

    // MARK: - Recording

    /// Record measured deltas into the bucket containing `date`.
    /// `model == nil` writes the vendor aggregate scope; a non-nil model writes
    /// ONLY the `vendor|model` scope (callers record the aggregate separately).
    public func record(vendor: String, model: String? = nil,
                       input: Int, output: Int, reasoning: Int = 0,
                       cacheRead: Int = 0, cacheWrite: Int = 0, at date: Date = Date()) {
        guard input > 0 || output > 0 || reasoning > 0 || cacheRead > 0 || cacheWrite > 0 else { return }
        let bucket = Self.bucketStart(Int(date.timeIntervalSince1970))
        lock.lock()
        if let model, !model.isEmpty {
            addLocked(scope: "\(vendor)|\(model)", bucket: bucket, input: input, output: output,
                      reasoning: reasoning, cacheRead: cacheRead, cacheWrite: cacheWrite)
        } else {
            addLocked(scope: vendor, bucket: bucket, input: input, output: output,
                      reasoning: reasoning, cacheRead: cacheRead, cacheWrite: cacheWrite)
        }
        dirty = true
        lock.unlock()
        flushIfDue()
    }

    private func addLocked(scope: String, bucket: Int, input: Int, output: Int,
                           reasoning: Int = 0, cacheRead: Int = 0, cacheWrite: Int = 0) {
        var entry = scopes[scope, default: [:]][bucket] ?? Entry()
        entry.input += input
        entry.output += output
        entry.reasoning += reasoning
        entry.cacheRead += cacheRead
        entry.cacheWrite += cacheWrite
        scopes[scope, default: [:]][bucket] = entry
    }

    // MARK: - Reading

    /// Vendor-scoped totals.
    public func totals(vendor: String) -> (all: Int, today: Int,
                                           breakdownAll: TokenBreakdown,
                                           breakdownToday: TokenBreakdown) {
        lock.lock(); defer { lock.unlock() }
        let todayStart = Self.todayBucket()
        var all = 0, today = 0
        var bAll = TokenBreakdown(), bToday = TokenBreakdown()
        for (bucket, entry) in scopes[vendor] ?? [:] {
            all += entry.total
            bAll.add(entry.breakdown)
            if bucket >= todayStart {
                today += entry.total
                bToday.add(entry.breakdown)
            }
        }
        return (all, today, bAll, bToday)
    }

    /// UsageEngine seam: one contribution per vendor with 15-min buckets +
    /// per-model accumulators, shaped like any other usage source.
    public func contributions() -> [UsageEngine.RuntimeUsageContribution] {
        lock.lock(); defer { lock.unlock() }
        let todayStart = Self.todayBucket()
        var vendors = Set<String>()
        for scope in scopes.keys {
            vendors.insert(scope.split(separator: "|", maxSplits: 1).first.map(String.init) ?? scope)
        }
        return vendors.sorted().map { vendor in
            var out = UsageEngine.RuntimeUsageContribution(tool: vendor)
            for (scope, buckets) in scopes {
                let parts = scope.split(separator: "|", maxSplits: 1)
                guard String(parts[0]) == vendor else { continue }
                if parts.count == 1 {
                    for (bucket, entry) in buckets {
                        var be = out.buckets[bucket] ?? UsageEngine.BucketEntry()
                        be.tokens += entry.total
                        be.breakdown.add(entry.breakdown)
                        out.buckets[bucket] = be
                    }
                } else {
                    let model = String(parts[1])
                    var accum = out.models[model] ?? UsageEngine.ModelAccum()
                    for (bucket, entry) in buckets {
                        accum.all += entry.total
                        accum.breakdown.add(entry.breakdown)
                        if bucket >= todayStart { accum.today += entry.total }
                    }
                    out.models[model] = accum
                }
            }
            return out
        }
    }

    // MARK: - Persistence

    /// Flush when dirty and at least 30s since the last write.
    public func flushIfDue() {
        lock.lock()
        let due = dirty && Date().timeIntervalSince(lastFlush) > 30
        lock.unlock()
        if due { flush() }
    }

    public func flush() {
        lock.lock()
        guard dirty else { lock.unlock(); return }
        var disk = DiskFormat()
        let cutoff = Int(Date().timeIntervalSince1970) - retentionSeconds
        for (scope, buckets) in scopes {
            var kept: [String: Entry] = [:]
            for (bucket, entry) in buckets where bucket >= cutoff {
                kept[String(bucket)] = entry
            }
            disk.scopes[scope] = kept
            scopes[scope] = buckets.filter { $0.key >= cutoff }
        }
        dirty = false
        lastFlush = Date()
        lock.unlock()

        guard let data = try? JSONEncoder().encode(disk) else { return }
        let dir = storeURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // .atomic writes to a sibling temp file and renames over the target.
        try? data.write(to: storeURL, options: .atomic)
    }

    private func load(from url: URL) {
        guard let data = try? Data(contentsOf: url),
              let disk = try? JSONDecoder().decode(DiskFormat.self, from: data) else { return }
        var parsed: [String: [Int: Entry]] = [:]
        for (scope, buckets) in disk.scopes {
            var out: [Int: Entry] = [:]
            for (key, entry) in buckets {
                if let bucket = Int(key) { out[bucket] = entry }
            }
            parsed[scope] = out
        }
        lock.lock()
        scopes = parsed
        lock.unlock()
    }

    private static func todayBucket() -> Int {
        DayBoundary.start(ofTs: Int(Date().timeIntervalSince1970))   // UTC midnight
    }
}
