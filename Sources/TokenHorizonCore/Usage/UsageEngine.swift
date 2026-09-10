import Foundation
#if canImport(SQLite3)
import SQLite3
#elseif canImport(CSQLite)
import CSQLite
#endif

public final class UsageEngine {
    public init() {}
    private var db: OpaquePointer?
    private let lock = NSLock()

    private var claudeFiles: [String: AdditiveFileState] = [:]
    private var codexFiles: [String: CodexFileState] = [:]
    private var genericFiles: [String: AdditiveFileState] = [:]
    private var kimiFiles: [String: AdditiveFileState] = [:]
    private var dirCache: [String: (mtime: Date, files: [String])] = [:]

    /// One 15-minute bucket: compat aggregate (`tokens`, `cost`) + granular split.
    /// `tokens` preserves each source's canonical total (e.g. codex display tokens
    /// exclude cached/reasoning); `breakdown` carries the full type detail.
    public struct BucketEntry {
        public var tokens = 0
        public var cost = 0.0
        public var breakdown = TokenBreakdown()

        public init() {}
    }

    /// Per-model accumulator for JSONL sources.
    public struct ModelAccum {
        public var all = 0
        public var today = 0
        public var cost = 0.0
        public var breakdown = TokenBreakdown()

        public init() {}
    }

    public struct AdditiveFileState {
        public var offset: UInt64 = 0
        public var allTokens: Int = 0
        public var allCost: Double = 0
        public var cacheRead: Int = 0
        public var breakdown = TokenBreakdown()
        public var buckets: [Int: BucketEntry] = [:]
        public var models: [String: ModelAccum] = [:]
    }

    public struct CodexWatermark {
        public var input = 0
        public var output = 0
        public var cached = 0
        public var reasoning = 0

        public var total: Int { input + output + cached + reasoning }
        public var displayTokens: Int { input + output }

        public static func >= (l: CodexWatermark, r: CodexWatermark) -> Bool {
            l.input >= r.input && l.output >= r.output && l.cached >= r.cached && l.reasoning >= r.reasoning
        }

        public func delta(from prev: CodexWatermark) -> CodexWatermark {
            CodexWatermark(input: input - prev.input, output: output - prev.output,
                           cached: cached - prev.cached, reasoning: reasoning - prev.reasoning)
        }
    }

    public struct CodexRate {
        public var usedPercent: Double
        public var windowMinutes: Int
        public var resetsAt: Int
    }

    public struct CodexFileState {
        public var offset: UInt64 = 0
        public var watermark = CodexWatermark()
        public var last = CodexWatermark()
        public var allTokens: Int = 0
        public var breakdown = TokenBreakdown()
        public var buckets: [Int: BucketEntry] = [:]
        public var rate: CodexRate?
        public var modelTokens: Int = 0
    }

    public static let genericSources: [(tool: String, dirs: [String])] = [
        ("glm", ["~/.zcode/projects"]),
        ("qwen", ["~/.qwen/projects"]),
        ("grok", ["~/.grok/sessions"]),
        ("deepseek", ["~/.dsh/sessions"]),
        ("gemini", ["~/.gemini/transcripts", "~/.gemini/sessions", "~/.gemini/projects"]),
        ("agy", ["~/.gemini/antigravity-cli/brain", "~/.gemini/antigravity-cli/conversations"]),
    ]
    public static var kimiDirs: [String] {
        let env = ProcessInfo.processInfo.environment
        var dirs: [String] = []
        if let home = env["KIMI_HOME"] { dirs.append("\(home)/sessions") }
        else { dirs.append("~/.kimi/sessions") }
        if let codeHome = env["KIMI_CODE_HOME"] { dirs.append("\(codeHome)/sessions") }
        else { dirs.append("~/.kimi-code/sessions") }
        return dirs
    }

    private let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private let isoFallback = ISO8601DateFormatter()

    public func snapshot() -> UsageSnapshot {
        lock.lock()
        defer { lock.unlock() }
        return collectLocked()
    }

    public func history(days: Int) -> (points: [HistoryPoint], streak: Int) {
        lock.lock()
        defer { lock.unlock() }
        _ = collectLocked()
        let merged = mergedBucketsLocked()

        let cal = Calendar.current
        var points: [HistoryPoint] = []
        for offset in (0..<days).reversed() {
            guard let date = cal.date(byAdding: .day, value: -offset, to: Date()) else { continue }
            let start = Int(cal.startOfDay(for: date).timeIntervalSince1970)
            points.append(aggregate(merged, from: start, to: start + 86_400))
        }

        var streak = 0
        var cursor = todayBucket()
        if dayTokens(merged, cursor) == 0 { cursor -= 86_400 }
        while dayTokens(merged, cursor) > 0 {
            streak += 1
            cursor -= 86_400
        }
        return (points, streak)
    }

    public func trendHistory(window: TrendWindow) -> [HistoryPoint] {
        lock.lock()
        defer { lock.unlock() }
        _ = collectLocked()
        let merged = mergedBucketsLocked()

        let spec = window.spec
        var points: [HistoryPoint] = []
        let nowBucket = currentBucket()
        let today = todayBucket()

        for i in (0..<spec.count).reversed() {
            let start: Int
            let end: Int
            if !spec.dailyAligned {
                if spec.seconds == Self.bucketSeconds {
                    start = nowBucket - i * Self.bucketSeconds
                    end = start + Self.bucketSeconds
                } else {
                    start = today - i * spec.seconds
                    end = start + spec.seconds
                }
            } else {
                start = today - i * 86_400
                end = start + 86_400
            }
            points.append(aggregate(merged, from: start, to: min(end, currentBucket() + Self.bucketSeconds)))
        }
        return points
    }

    private func aggregate(_ merged: [Int: [String: BucketEntry]], from: Int, to: Int) -> HistoryPoint {
        var byTool: [String: Int] = [:]
        var tokens = 0
        var cost = 0.0
        var breakdown = TokenBreakdown()
        for (bucket, tools) in merged where bucket >= from && bucket < to {
            for (tool, v) in tools {
                byTool[tool, default: 0] += v.tokens
                tokens += v.tokens
                cost += v.cost
                breakdown.add(v.breakdown)
            }
        }
        return HistoryPoint(day: from, tokens: tokens, cost: cost, byTool: byTool, breakdown: breakdown)
    }

    private func dayTokens(_ merged: [Int: [String: BucketEntry]], _ dayStart: Int) -> Int {
        var total = 0
        for (bucket, tools) in merged where bucket >= dayStart && bucket < dayStart + 86_400 {
            total += tools.values.reduce(0) { $0 + $1.tokens }
        }
        return total
    }

    private func mergedBucketsLocked() -> [Int: [String: BucketEntry]] {
        var merged: [Int: [String: BucketEntry]] = [:]
        func add(_ bucket: Int, _ tool: String, _ entry: BucketEntry) {
            guard entry.tokens > 0 || entry.cost > 0 else { return }
            var prev = merged[bucket, default: [:]][tool] ?? BucketEntry()
            prev.tokens += entry.tokens
            prev.cost += entry.cost
            prev.breakdown.add(entry.breakdown)
            merged[bucket, default: [:]][tool] = prev
        }
        for (_, st) in claudeFiles { for (h, b) in st.buckets { add(h, "claude", b) } }
        for (_, st) in kimiFiles { for (h, b) in st.buckets { add(h, "kimi", b) } }
        for (key, st) in genericFiles {
            let tool = key.split(separator: "::", maxSplits: 1).first.map(String.init) ?? "other"
            for (h, b) in st.buckets { add(h, tool, b) }
        }
        for (_, st) in codexFiles { for (h, b) in st.buckets { add(h, "codex", b) } }
        opencodePerBucket { bucket, entry in add(bucket, "opencode", entry) }
        return merged
    }

    public static func windowLabel(minutes: Int) -> String {
        if minutes <= 0 { return "session" }
        if minutes < 60 { return "\(minutes)m" }
        if minutes < 1440 { return "\(minutes / 60)h" }
        return "\(minutes / 1440)d"
    }

    private func latestCodexRate() -> CodexRate? {
        codexFiles.values.compactMap { $0.rate }.max { a, b in
            a.resetsAt != b.resetsAt ? a.resetsAt < b.resetsAt : a.usedPercent < b.usedPercent
        }
    }

    private func opencodePerBucket(_ handler: (Int, BucketEntry) -> Void) {
        guard let db = openDB() else { return }
        let sql = """
        SELECT time_created,
               COALESCE(tokens_input,0), COALESCE(tokens_output,0),
               COALESCE(tokens_reasoning,0), COALESCE(tokens_cache_read,0),
               COALESCE(tokens_cache_write,0), COALESCE(cost,0)
        FROM session
        """
        guard let stmt = prepare(db, sql) else { return }
        while sqlite3_step(stmt) == SQLITE_ROW {
            let createdMs = sqlite3_column_double(stmt, 0)
            var entry = BucketEntry()
            entry.breakdown = TokenBreakdown(
                input: Int(sqlite3_column_int64(stmt, 1)),
                output: Int(sqlite3_column_int64(stmt, 2)),
                reasoning: Int(sqlite3_column_int64(stmt, 3)),
                cacheRead: Int(sqlite3_column_int64(stmt, 4)),
                cacheWrite: Int(sqlite3_column_int64(stmt, 5)))
            entry.tokens = entry.breakdown.total
            entry.cost = sqlite3_column_double(stmt, 6)
            let bucket = bucketStart(Int(createdMs / 1000))
            handler(bucket, entry)
        }
        sqlite3_finalize(stmt)
    }

    private func collectLocked() -> UsageSnapshot {
        var snap = UsageSnapshot()
        snap.updatedAt = Date()
        var tools: [ToolUsage] = []

        if let oc = opencodeUsage() {
            tools.append(ToolUsage(tool: "opencode",
                                   tokensToday: oc.todayTokens, tokensAllTime: oc.allTokens,
                                   costToday: oc.todayCost, costAllTime: oc.allCost,
                                   cacheReadAll: oc.cacheRead,
                                   breakdownToday: oc.breakdownToday,
                                   breakdownAll: oc.breakdownAll))
            snap.tokensToday += oc.todayTokens
            snap.costToday += oc.todayCost
            snap.tokensAllTime += oc.allTokens
            snap.costAllTime += oc.allCost
            snap.breakdownToday.add(oc.breakdownToday)
            snap.breakdownAll.add(oc.breakdownAll)
            snap.recentSessions = oc.sessions
            snap.models = modelUsage()
        }

        let claude = scanAdditive(dirs: ["~/.claude/projects", "~/.claude/transcripts"],
                                  state: &claudeFiles, prefix: "claude")
        if claude.allTokens > 0 || claude.trackedAny {
            tools.append(ToolUsage(tool: "claude",
                                   tokensToday: claude.todayTokens, tokensAllTime: claude.allTokens,
                                   costToday: claude.todayCost, costAllTime: claude.allCost,
                                   cacheReadAll: claude.cacheRead,
                                   breakdownToday: claude.breakdownToday,
                                   breakdownAll: claude.breakdownAll))
            snap.tokensToday += claude.todayTokens
            snap.costToday += claude.todayCost
            snap.tokensAllTime += claude.allTokens
            snap.costAllTime += claude.allCost
            snap.breakdownToday.add(claude.breakdownToday)
            snap.breakdownAll.add(claude.breakdownAll)
            for (model, v) in claude.perModel {
                snap.models.append(ModelUsage(provider: "claude", model: model,
                                              tokensAll: v.all, tokensToday: v.today, cost: v.cost,
                                              messages: 0, free: v.cost < 0.0001, cacheReadAll: 0,
                                              breakdown: v.breakdown))
            }
        }

        let codexToday = scanCodex(dirs: ["~/.codex/sessions", "~/.codex/archived_sessions"])
        if let rate = latestCodexRate() {
            snap.limits.append(ProviderLimit(
                provider: "codex",
                label: Self.windowLabel(minutes: rate.windowMinutes),
                usedPercent: rate.usedPercent,
                resetsAt: Date(timeIntervalSince1970: TimeInterval(rate.resetsAt)),
                detail: ""))
        }
        if codexToday.all > 0 {
            var codexBreakdownAll = TokenBreakdown()
            var codexBreakdownToday = TokenBreakdown()
            let codexTodayStart = todayBucket()
            for (_, st) in codexFiles {
                codexBreakdownAll.add(st.breakdown)
                for (h, b) in st.buckets where h >= codexTodayStart {
                    codexBreakdownToday.add(b.breakdown)
                }
            }
            tools.append(ToolUsage(tool: "codex",
                                   tokensToday: codexToday.today, tokensAllTime: codexToday.all,
                                   costToday: 0, costAllTime: 0,
                                   breakdownToday: codexBreakdownToday,
                                   breakdownAll: codexBreakdownAll))
            snap.tokensToday += codexToday.today
            snap.tokensAllTime += codexToday.all
            snap.breakdownToday.add(codexBreakdownToday)
            snap.breakdownAll.add(codexBreakdownAll)
            let codexTokens = codexFiles.values.reduce(0) { $0 + $1.modelTokens }
            if codexTokens > 0 {
                snap.models.append(ModelUsage(provider: "codex", model: "codex (model n/a)",
                                              tokensAll: codexTokens, tokensToday: 0, cost: 0,
                                              messages: 0, free: true))
            }
        }

        var kimi = SourceResult()
        scanKimi(dirs: Self.kimiDirs)
        let kimiToday = todayBucket()
        for (_, st) in kimiFiles {
            kimi.allTokens += st.allTokens
            kimi.allCost += st.allCost
            kimi.breakdownAll.add(st.breakdown)
            for (h, b) in st.buckets where h >= kimiToday {
                kimi.todayTokens += b.tokens
                kimi.todayCost += b.cost
                kimi.breakdownToday.add(b.breakdown)
            }
        }
        kimi.trackedAny = !kimiFiles.isEmpty
        if kimi.allTokens > 0 || kimi.trackedAny {
            tools.append(ToolUsage(tool: "kimi",
                                   tokensToday: kimi.todayTokens, tokensAllTime: kimi.allTokens,
                                   costToday: kimi.todayCost, costAllTime: kimi.allCost,
                                   breakdownToday: kimi.breakdownToday,
                                   breakdownAll: kimi.breakdownAll))
            snap.tokensToday += kimi.todayTokens
            snap.costToday += kimi.todayCost
            snap.tokensAllTime += kimi.allTokens
            snap.costAllTime += kimi.allCost
            snap.breakdownToday.add(kimi.breakdownToday)
            snap.breakdownAll.add(kimi.breakdownAll)
            snap.models.append(ModelUsage(provider: "kimi", model: "kimi (model n/a)",
                                          tokensAll: kimi.allTokens, tokensToday: kimi.todayTokens,
                                          cost: kimi.allCost, messages: 0, free: kimi.allCost < 0.0001))
        }

        for source in Self.genericSources {
            let r = scanAdditive(dirs: source.dirs, state: &genericFiles, prefix: source.tool)
            if r.allTokens > 0 {
                tools.append(ToolUsage(tool: source.tool,
                                       tokensToday: r.todayTokens, tokensAllTime: r.allTokens,
                                       costToday: r.todayCost, costAllTime: r.allCost,
                                       cacheReadAll: r.cacheRead,
                                       breakdownToday: r.breakdownToday,
                                       breakdownAll: r.breakdownAll))
                snap.tokensToday += r.todayTokens
                snap.costToday += r.todayCost
                snap.tokensAllTime += r.allTokens
                snap.costAllTime += r.allCost
                snap.breakdownToday.add(r.breakdownToday)
                snap.breakdownAll.add(r.breakdownAll)
                for (model, v) in r.perModel {
                    snap.models.append(ModelUsage(provider: source.tool, model: model,
                                                  tokensAll: v.all, tokensToday: v.today, cost: v.cost,
                                                  messages: 0, free: v.cost < 0.0001,
                                                  breakdown: v.breakdown))
                }
            }
        }

        snap.models.sort {
            if $0.tokensToday != $1.tokensToday { return $0.tokensToday > $1.tokensToday }
            return $0.tokensAll > $1.tokensAll
        }
        snap.perTool = tools.filter { $0.tokensAllTime > 0 || $0.tokensToday > 0 }
        snap.sources = snap.perTool.map { $0.tool }
        return snap
    }

    private struct SourceResult {
        var trackedAny = false
        var todayTokens = 0
        var todayCost = 0.0
        var allTokens = 0
        var allCost = 0.0
        var cacheRead = 0
        var breakdownAll = TokenBreakdown()
        var breakdownToday = TokenBreakdown()
        var perModel: [String: ModelAccum] = [:]
    }

    /// Bucket granularity: 15 minutes (epoch-aligned keys). "Today" compares
    /// bucket keys against local-midnight epoch; history/trends re-aggregate.
    public static let bucketSeconds = 900

    private func bucketStart(_ epochSeconds: Int) -> Int {
        epochSeconds / Self.bucketSeconds * Self.bucketSeconds
    }

    private func todayBucket() -> Int {
        Int(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970)
    }

    private func bucketFromTimestamp(_ ts: String?) -> Int {
        guard let ts else { return currentBucket() }
        var date = isoFormatter.date(from: ts)
        if date == nil { date = isoFallback.date(from: ts) }
        if let d = date { return bucketStart(Int(d.timeIntervalSince1970)) }
        return currentBucket()
    }

    private func currentBucket() -> Int {
        bucketStart(Int(Date().timeIntervalSince1970))
    }

    private func cachedFiles(in dir: String, suffix: String = ".jsonl") -> [String] {
        let fm = FileManager.default
        let mtime = (try? fm.attributesOfItem(atPath: dir)[.modificationDate] as? Date) ?? .distantPast
        if let cached = dirCache[dir], cached.mtime == mtime { return cached.files }
        guard let en = fm.enumerator(atPath: dir) else { return [] }
        var files: [String] = []
        while let item = en.nextObject() as? String {
            if item.hasSuffix(suffix) {
                if item.contains("/chunks/") { continue }
                if item.contains("transcript_full.jsonl") { continue }
                files.append(item)
            }
        }
        dirCache[dir] = (mtime, files)
        return files
    }

    private func scanAdditive(dirs: [String], state: inout [String: AdditiveFileState], prefix: String) -> SourceResult {
        var out = SourceResult()
        var cacheRead = 0
        var perModel: [String: ModelAccum] = [:]
        let fm = FileManager.default
        let today = todayBucket()
        var seen = Set<String>()

        for dir in dirs {
            let root = NSString(string: dir).expandingTildeInPath
            for item in cachedFiles(in: root) {
                let full = "\(root)/\(item)"
                let key = "\(prefix)::\(full)"
                seen.insert(key)
                guard let attrs = try? fm.attributesOfItem(atPath: full),
                      let size = attrs[.size] as? UInt64 else { continue }
                var st = state[key] ?? AdditiveFileState()
                if size < st.offset { st = AdditiveFileState() }
                guard size > st.offset, let fh = FileHandle(forReadingAtPath: full) else { continue }
                fh.seek(toFileOffset: st.offset)
                let chunk = fh.readDataToEndOfFile()
                try? fh.close()
                guard let lastNewline = chunk.lastIndex(of: UInt8(ascii: "\n")) else { continue }
                let consumable = chunk[chunk.startIndex...lastNewline]
                for line in consumable.split(separator: UInt8(ascii: "\n")) where !line.isEmpty {
                    if let p = parseAdditiveLine(Data(line)) {
                        st.allTokens += p.tokens
                        st.allCost += p.cost
                        st.cacheRead += p.breakdown.cacheRead
                        st.breakdown.add(p.breakdown)
                        var entry = st.buckets[p.hour] ?? BucketEntry()
                        entry.tokens += p.tokens
                        entry.cost += p.cost
                        entry.breakdown.add(p.breakdown)
                        st.buckets[p.hour] = entry
                        let modelName = p.model.isEmpty ? (prefix == "agy" ? "gemini-3.7-flash" : "\(prefix)-default") : p.model
                        let isToday = p.hour >= today
                        var accum = st.models[modelName] ?? ModelAccum()
                        accum.all += p.tokens
                        accum.today += isToday ? p.tokens : 0
                        accum.cost += p.cost
                        accum.breakdown.add(p.breakdown)
                        st.models[modelName] = accum
                    }
                }
                st.offset = st.offset + UInt64(consumable.count)
                state[key] = st
            }
        }

        for key in state.keys where !seen.contains(key) && key.hasPrefix("\(prefix)::") {
            state.removeValue(forKey: key)
        }
        for (key, st) in state where key.hasPrefix("\(prefix)::") {
            out.allTokens += st.allTokens
            out.allCost += st.allCost
            cacheRead += st.cacheRead
            out.breakdownAll.add(st.breakdown)
            for (model, v) in st.models {
                var prev = perModel[model] ?? ModelAccum()
                prev.all += v.all
                prev.today += v.today
                prev.cost += v.cost
                prev.breakdown.add(v.breakdown)
                perModel[model] = prev
            }
            for (h, b) in st.buckets where h >= today {
                out.todayTokens += b.tokens
                out.todayCost += b.cost
                out.breakdownToday.add(b.breakdown)
            }
        }
        out.cacheRead = cacheRead
        out.perModel = perModel
        out.trackedAny = !seen.isEmpty
        return out
    }

    private func scanKimi(dirs: [String]) {
        let fm = FileManager.default
        for dir in dirs {
            let root = NSString(string: dir).expandingTildeInPath
            for item in cachedFiles(in: root, suffix: "wire.jsonl") {
                let full = "\(root)/\(item)"
                guard let attrs = try? fm.attributesOfItem(atPath: full),
                      let size = (attrs[.size] as? NSNumber)?.uint64Value else { continue }
                var st = kimiFiles[full] ?? AdditiveFileState()
                if size < st.offset { st = AdditiveFileState() }
                guard size > st.offset, let fh = FileHandle(forReadingAtPath: full) else { continue }
                fh.seek(toFileOffset: st.offset)
                let chunk = fh.readDataToEndOfFile()
                try? fh.close()
                guard let lastNewline = chunk.lastIndex(of: UInt8(ascii: "\n")) else { continue }
                let consumable = chunk[chunk.startIndex...lastNewline]
                for line in consumable.split(separator: UInt8(ascii: "\n")) where !line.isEmpty {
                    if let p = parseKimiLine(Data(line)) {
                        st.allTokens += p.breakdown.total
                        st.cacheRead += p.breakdown.cacheRead
                        st.breakdown.add(p.breakdown)
                        var entry = st.buckets[p.hour] ?? BucketEntry()
                        entry.tokens += p.breakdown.total
                        entry.breakdown.add(p.breakdown)
                        st.buckets[p.hour] = entry
                    }
                }
                st.offset = st.offset + UInt64(consumable.count)
                kimiFiles[full] = st
            }
        }
    }

    private func scanCodex(dirs: [String]) -> (today: Int, all: Int) {
        var state = codexFiles
        let fm = FileManager.default
        let today = todayBucket()
        var seen = Set<String>()

        for dir in dirs {
            let root = NSString(string: dir).expandingTildeInPath
            for item in cachedFiles(in: root) {
                let full = "\(root)/\(item)"
                seen.insert(full)
                guard let attrs = try? fm.attributesOfItem(atPath: full),
                      let size = attrs[.size] as? UInt64 else { continue }
                var st = state[full] ?? CodexFileState()
                if size < st.offset { st = CodexFileState() }
                guard size > st.offset, let fh = FileHandle(forReadingAtPath: full) else { continue }
                defer { try? fh.close() }
                fh.seek(toFileOffset: st.offset)
                let chunk = fh.readDataToEndOfFile()
                guard let lastNewline = chunk.lastIndex(of: UInt8(ascii: "\n")) else { continue }
                let consumable = chunk[chunk.startIndex...lastNewline]
                for line in consumable.split(separator: UInt8(ascii: "\n")) where !line.isEmpty {
                    if let parsed = parseCodexLine(Data(line)) {
                        let delta = codexAccept(parsed, state: &st)
                        if let rate = parsed.rate {
                            st.rate = rate
                        }
                        if delta.displayTokens > 0 {
                            st.allTokens += delta.displayTokens
                            st.breakdown.input += delta.input
                            st.breakdown.output += delta.output
                            st.breakdown.reasoning += delta.reasoning
                            st.breakdown.cacheRead += delta.cached
                            var entry = st.buckets[parsed.hour] ?? BucketEntry()
                            entry.tokens += delta.displayTokens
                            entry.breakdown.input += delta.input
                            entry.breakdown.output += delta.output
                            entry.breakdown.reasoning += delta.reasoning
                            entry.breakdown.cacheRead += delta.cached
                            st.buckets[parsed.hour] = entry
                        }
                    }
                }
                st.offset = st.offset + UInt64(consumable.count)
                state[full] = st
            }
        }

        codexFiles = state.filter { seen.contains($0.key) }
        var todayTokens = 0, allTokens = 0
        for (_, st) in codexFiles {
            allTokens += st.allTokens
            for (h, v) in st.buckets where h >= today { todayTokens += v.tokens }
        }
        return (todayTokens, allTokens)
    }

    /// Returns the accepted watermark delta (zero watermark when nothing new).
    private func codexAccept(_ parsed: CodexParsed, state: inout CodexFileState) -> CodexWatermark {
        let prev = state.watermark
        let cur = parsed.totals

        if cur >= prev {
            let delta = cur.delta(from: prev)
            state.watermark = cur
            state.last = parsed.last
            return delta
        }

        let prevTotal = prev.total
        let curTotal = cur.total
        let lastTotal = state.last.total
        let stale = prevTotal > 0 && curTotal > 0 && lastTotal > 0 &&
            (curTotal * 100 >= prevTotal * 98 || curTotal + lastTotal * 2 >= prevTotal)
        if stale { return CodexWatermark() }

        state.watermark = cur
        state.last = parsed.last
        return parsed.last
    }

    public struct CodexParsed {
        public var totals: CodexWatermark
        public var last: CodexWatermark
        public var hour: Int
        public var rate: CodexRate?
    }

    private func parseCodexLine(_ line: Data) -> CodexParsed? {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let payload = obj["payload"] as? [String: Any],
              payload["type"] as? String == "token_count",
              let info = payload["info"] as? [String: Any] else { return nil }

        func watermark(_ dict: [String: Any]?) -> CodexWatermark? {
            guard let u = dict else { return nil }
            let input = (u["input_tokens"] as? Int) ?? 0
            let output = (u["output_tokens"] as? Int) ?? 0
            let cachedA = (u["cached_input_tokens"] as? Int) ?? 0
            let cachedB = (u["cache_read_input_tokens"] as? Int) ?? 0
            let reasoning = (u["reasoning_output_tokens"] as? Int) ?? 0
            return CodexWatermark(input: max(input, 0), output: max(output, 0),
                                  cached: max(max(cachedA, cachedB), 0), reasoning: max(reasoning, 0))
        }

        guard let totals = watermark(info["total_token_usage"] as? [String: Any]) else { return nil }
        let last = watermark(info["last_token_usage"] as? [String: Any]) ?? totals
        let hour = bucketFromTimestamp(obj["timestamp"] as? String)

        var rate: CodexRate?
        if let rl = payload["rate_limits"] as? [String: Any],
           let primary = rl["primary"] as? [String: Any],
           let used = primary["used_percent"] as? Double {
            rate = CodexRate(
                usedPercent: used,
                windowMinutes: primary["window_minutes"] as? Int ?? 0,
                resetsAt: primary["resets_at"] as? Int ?? 0)
        }
        return CodexParsed(totals: totals, last: last, hour: hour, rate: rate)
    }

    private func parseKimiLine(_ line: Data) -> (breakdown: TokenBreakdown, hour: Int)? {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let message = obj["message"] as? [String: Any],
              let payload = message["payload"] as? [String: Any],
              let usage = payload["token_usage"] as? [String: Any] else { return nil }

        func field(_ names: [String]) -> Int {
            for n in names {
                if let v = usage[n] as? Int, v > 0 { return v }
                if let v = usage[n] as? NSNumber, v.intValue > 0 { return v.intValue }
            }
            return 0
        }

        let breakdown = TokenBreakdown(
            input: field(["input_other", "inputOther"]),
            output: field(["output"]),
            cacheRead: field(["input_cache_read", "inputCacheRead"]),
            cacheWrite: field(["input_cache_creation", "inputCacheCreation"]))
        guard breakdown.total > 0 else { return nil }

        var hour = currentBucket()
        if let ts = obj["timestamp"] as? Double {
            hour = bucketStart(Int(ts))
        } else if let ts = obj["timestamp"] as? String {
            hour = bucketFromTimestamp(ts)
        }
        return (breakdown, hour)
    }

    private func parseAdditiveLine(_ line: Data) -> (tokens: Int, cost: Double, hour: Int, model: String, breakdown: TokenBreakdown)? {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return nil }
        var tokens = 0
        var cost = 0.0
        var breakdown = TokenBreakdown()

        if let usage = (obj["message"] as? [String: Any])?["usage"] as? [String: Any] {
            let b = anthropicBreakdown(usage)
            tokens += b.total
            breakdown.add(b)
        }
        for key in ["usage", "token_usage", "usageMetadata", "usage_metadata"] {
            if let usage = obj[key] as? [String: Any] {
                let a = anthropicBreakdown(usage)
                let o = openAIBreakdown(usage)
                let g = geminiBreakdown(usage)
                tokens += a.total + o.total + g.total
                breakdown.add(a)
                breakdown.add(o)
                breakdown.add(g)
            }
        }
        if let costBlock = obj["cost"] as? [String: Any], let total = costBlock["total"] as? Double {
            cost += total
        }
        if let c = obj["costUSD"] as? NSNumber { cost += c.doubleValue }

        if tokens == 0 {
            var charCount = 0
            if let c = obj["content"] as? String { charCount += c.count }
            if let th = obj["thinking"] as? String { charCount += th.count }
            if let tc = obj["tool_calls"] as? [Any] {
                if let tcData = try? JSONSerialization.data(withJSONObject: tc) {
                    charCount += tcData.count
                }
            }
            if charCount > 0 {
                tokens = max(1, charCount / 4)
                breakdown.output += tokens   // char-estimate: attribute as model output
            }
        }

        var hour = currentBucket()
        if let ts = obj["timestamp"] as? String {
            hour = bucketFromTimestamp(ts)
        } else if let ts = obj["timestamp"] as? Double {
            hour = bucketStart(Int(ts > 1e12 ? ts / 1000 : ts))
        } else if let ts = obj["created_at"] as? String {
            hour = bucketFromTimestamp(ts)
        }
        var model = ""
        if let m = (obj["message"] as? [String: Any])?["model"] as? String { model = m }
        else if let m = obj["model"] as? String { model = m }
        else if let m = obj["model_name"] as? String { model = m }
        else if let m = obj["modelId"] as? String { model = m }
        if model.isEmpty {
            if obj["type"] as? String == "PLANNER_RESPONSE" || obj["source"] as? String == "MODEL" {
                model = "gemini-3.7-flash"
            }
        }
        guard tokens > 0 || cost > 0 else { return nil }
        return (tokens, cost, hour, model, breakdown)
    }

    private func intField(_ usage: [String: Any], _ key: String) -> Int {
        if let n = usage[key] as? Int, n > 0 { return n }
        if let n = usage[key] as? NSNumber, n.intValue > 0 { return n.intValue }
        return 0
    }

    /// Anthropic convention: input/output/cache_read/cache_creation.
    private func anthropicBreakdown(_ usage: [String: Any]) -> TokenBreakdown {
        TokenBreakdown(
            input: intField(usage, "input_tokens"),
            output: intField(usage, "output_tokens"),
            cacheRead: intField(usage, "cache_read_input_tokens"),
            cacheWrite: intField(usage, "cache_creation_input_tokens"))
    }

    /// OpenAI convention: prompt/completion + details.reasoning/cached.
    private func openAIBreakdown(_ usage: [String: Any]) -> TokenBreakdown {
        var b = TokenBreakdown(
            input: intField(usage, "prompt_tokens"),
            output: intField(usage, "completion_tokens"))
        if let details = usage["completion_tokens_details"] as? [String: Any] {
            b.reasoning += intField(details, "reasoning_tokens")
        }
        if let details = usage["prompt_tokens_details"] as? [String: Any] {
            b.cacheRead += intField(details, "cached_tokens")
        }
        return b
    }

    /// Gemini convention: prompt/candidates/thoughts/cached counts; falls back
    /// to the bare total (attributed as input) when components are absent.
    private func geminiBreakdown(_ usage: [String: Any]) -> TokenBreakdown {
        var b = TokenBreakdown(
            input: intField(usage, "prompt_token_count") + intField(usage, "promptTokenCount"),
            output: intField(usage, "candidates_token_count") + intField(usage, "candidatesTokenCount"),
            reasoning: intField(usage, "thoughts_token_count") + intField(usage, "thoughtsTokenCount"),
            cacheRead: intField(usage, "cached_content_token_count") + intField(usage, "cachedContentTokenCount"))
        if b.total == 0 {
            let total = intField(usage, "total_token_count") + intField(usage, "totalTokenCount")
            if total > 0 { b.input += total }
        }
        return b
    }

    private struct OCSums {
        var todayTokens = 0
        var todayCost = 0.0
        var allTokens = 0
        var allCost = 0.0
        var cacheRead = 0
        var breakdownAll = TokenBreakdown()
        var breakdownToday = TokenBreakdown()
        var sessions: [SessionSummary] = []
    }

    private func localMidnightUTC() -> Int {
        var t = time(nil)
        var local = tm()
        localtime_r(&t, &local)
        let hourOffset = local.tm_hour * 3600
        let minOffset = local.tm_min * 60
        var midnightLocal: time_t = t - time_t(hourOffset) - time_t(minOffset) - time_t(local.tm_sec)
        var gmt = tm()
        gmtime_r(&midnightLocal, &gmt)
        return midnightLocal - gmt.tm_gmtoff
    }

    private func opencodeUsage() -> OCSums? {
        guard let db = openDB() else { return nil }
        var out = OCSums()

        let tokenExpr = "COALESCE(SUM(tokens_input+tokens_output+tokens_reasoning+tokens_cache_read+tokens_cache_write),0)"
        let midnightMs = localMidnightUTC() * 1000

        var sql = "SELECT \(tokenExpr), COALESCE(SUM(cost),0), COALESCE(SUM(tokens_cache_read),0) FROM session"
        if let sums = query3(db, sql) {
            out.allTokens = sums.0
            out.allCost = sums.1
            out.cacheRead = sums.2
        }
        sql = "SELECT \(tokenExpr), COALESCE(SUM(cost),0) FROM session WHERE time_created > \(midnightMs)"
        if let sums = query2(db, sql), let tok = sums.0.int, let cost = sums.1.double {
            out.todayTokens = tok
            out.todayCost = cost
        }
        // Granular type split, all-time and today.
        let cols = "COALESCE(SUM(tokens_input),0), COALESCE(SUM(tokens_output),0), COALESCE(SUM(tokens_reasoning),0), COALESCE(SUM(tokens_cache_read),0), COALESCE(SUM(tokens_cache_write),0)"
        if let b = queryBreakdown(db, "SELECT \(cols) FROM session") {
            out.breakdownAll = b
        }
        if let b = queryBreakdown(db, "SELECT \(cols) FROM session WHERE time_created > \(midnightMs)") {
            out.breakdownToday = b
        }
        sql = """
        SELECT id, title, cost,
               COALESCE(tokens_input+tokens_output+tokens_reasoning+tokens_cache_read+tokens_cache_write,0),
               directory, time_created
        FROM session ORDER BY time_updated DESC LIMIT 12
        """
        if let stmt = prepare(db, sql) {
            while sqlite3_step(stmt) == SQLITE_ROW {
                let id = text(stmt, 0)
                let title = text(stmt, 1)
                let cost = sqlite3_column_double(stmt, 2)
                let tokens = Int(sqlite3_column_int64(stmt, 3))
                let dir = text(stmt, 4)
                let created = Date(timeIntervalSince1970: sqlite3_column_double(stmt, 5) / 1000)
                out.sessions.append(SessionSummary(id: id, title: title, cost: cost, tokens: tokens, directory: dir, created: created))
            }
            sqlite3_finalize(stmt)
        }
        return out
    }

    private func queryBreakdown(_ db: OpaquePointer, _ sql: String) -> TokenBreakdown? {
        guard let stmt = prepare(db, sql) else { return nil }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return TokenBreakdown(
            input: Int(sqlite3_column_int64(stmt, 0)),
            output: Int(sqlite3_column_int64(stmt, 1)),
            reasoning: Int(sqlite3_column_int64(stmt, 2)),
            cacheRead: Int(sqlite3_column_int64(stmt, 3)),
            cacheWrite: Int(sqlite3_column_int64(stmt, 4)))
    }

    private func modelUsage() -> [ModelUsage] {
        guard let db = openDB() else { return [] }
        let midnightMs = localMidnightUTC() * 1000
        let tokensExpr = "COALESCE(json_extract(data,'$.tokens.total'), COALESCE(json_extract(data,'$.tokens.input'),0) + COALESCE(json_extract(data,'$.tokens.output'),0), 0)"
        let sql = """
        SELECT COALESCE(json_extract(data,'$.providerID'),'?'),
               COALESCE(json_extract(data,'$.modelID'),'?'),
               SUM(\(tokensExpr)),
               SUM(CASE WHEN time_created > \(midnightMs) THEN \(tokensExpr) ELSE 0 END),
               COALESCE(SUM(json_extract(data,'$.cost')),0),
               COUNT(*),
               COALESCE(SUM(json_extract(data,'$.tokens.input')),0),
               COALESCE(SUM(json_extract(data,'$.tokens.output')),0),
               COALESCE(SUM(json_extract(data,'$.tokens.reasoning')),0),
               COALESCE(SUM(json_extract(data,'$.tokens.cache.read')),0),
               COALESCE(SUM(json_extract(data,'$.tokens.cache.write')),0)
        FROM message
        WHERE json_extract(data,'$.role')='assistant'
        GROUP BY 1,2 ORDER BY 3 DESC
        """
        var out: [ModelUsage] = []
        if let stmt = prepare(db, sql) {
            while sqlite3_step(stmt) == SQLITE_ROW {
                let provider = text(stmt, 0)
                let model = text(stmt, 1)
                let tokensAll = Int(sqlite3_column_int64(stmt, 2))
                let tokensToday = Int(sqlite3_column_int64(stmt, 3))
                let cost = sqlite3_column_double(stmt, 4)
                let messages = Int(sqlite3_column_int64(stmt, 5))
                let breakdown = TokenBreakdown(
                    input: Int(sqlite3_column_int64(stmt, 6)),
                    output: Int(sqlite3_column_int64(stmt, 7)),
                    reasoning: Int(sqlite3_column_int64(stmt, 8)),
                    cacheRead: Int(sqlite3_column_int64(stmt, 9)),
                    cacheWrite: Int(sqlite3_column_int64(stmt, 10)))
                out.append(ModelUsage(provider: provider, model: model,
                                      tokensAll: tokensAll, tokensToday: tokensToday,
                                      cost: cost, messages: messages, free: cost < 0.0001,
                                      breakdown: breakdown))
            }
            sqlite3_finalize(stmt)
        }
        return out
    }

    private func openDB() -> OpaquePointer? {
        if let db { return db }
        let candidates = [
            NSString("~/.local/share/opencode/opencode.db").expandingTildeInPath,
            NSString("~/Library/Application Support/opencode/opencode.db").expandingTildeInPath,
        ]
        for c in candidates {
            guard FileManager.default.fileExists(atPath: c) else { continue }
            var handle: OpaquePointer?
            let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX
            guard sqlite3_open_v2(c, &handle, flags, nil) == SQLITE_OK else {
                sqlite3_close(handle)
                continue
            }
            sqlite3_busy_timeout(handle, 150)
            db = handle
            return handle
        }
        return nil
    }

    private func prepare(_ db: OpaquePointer, _ sql: String) -> OpaquePointer? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
        return stmt
    }

    private func query3(_ db: OpaquePointer, _ sql: String) -> (Int, Double, Int)? {
        guard let stmt = prepare(db, sql) else { return nil }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return (Int(sqlite3_column_int64(stmt, 0)), sqlite3_column_double(stmt, 1), Int(sqlite3_column_int64(stmt, 2)))
    }

    private func query2(_ db: OpaquePointer, _ sql: String) -> (Cell, Cell)? {
        guard let stmt = prepare(db, sql) else { return nil }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return (
            Cell(int: sqlite3_column_type(stmt, 0) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(stmt, 0)),
                 double: sqlite3_column_type(stmt, 0) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 0)),
            Cell(int: sqlite3_column_type(stmt, 1) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(stmt, 1)),
                 double: sqlite3_column_type(stmt, 1) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 1))
        )
    }

    public struct Cell {
        public var int: Int?
        public var double: Double?
    }

    private func text(_ stmt: OpaquePointer, _ i: Int32) -> String {
        guard let c = sqlite3_column_text(stmt, i) else { return "" }
        return String(cString: c)
    }
}
