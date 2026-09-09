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

    public struct AdditiveFileState {
        public var offset: UInt64 = 0
        public var allTokens: Int = 0
        public var allCost: Double = 0
        public var cacheRead: Int = 0
        public var buckets: [Int: (tokens: Int, cost: Double)] = [:]
        public var models: [String: (all: Int, today: Int, cost: Double)] = [:]
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
        public var buckets: [Int: Int] = [:]
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
        let merged = mergedHourlyLocked()

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
        let merged = mergedHourlyLocked()

        let spec = window.spec
        var points: [HistoryPoint] = []
        let nowHour = currentHour()
        let today = todayBucket()

        for i in (0..<spec.count).reversed() {
            let start: Int
            let end: Int
            if !spec.dailyAligned {
                if spec.seconds == 3600 {
                    start = nowHour - i * 3600
                    end = start + 3600
                } else {
                    start = today - i * spec.seconds
                    end = start + spec.seconds
                }
            } else {
                start = today - i * 86_400
                end = start + 86_400
            }
            points.append(aggregate(merged, from: start, to: min(end, currentHour() + 3600)))
        }
        return points
    }

    private func aggregate(_ merged: [Int: [String: (t: Int, c: Double)]], from: Int, to: Int) -> HistoryPoint {
        var byTool: [String: Int] = [:]
        var tokens = 0
        var cost = 0.0
        for (hour, tools) in merged where hour >= from && hour < to {
            for (tool, v) in tools {
                byTool[tool, default: 0] += v.t
                tokens += v.t
                cost += v.c
            }
        }
        return HistoryPoint(day: from, tokens: tokens, cost: cost, byTool: byTool)
    }

    private func dayTokens(_ merged: [Int: [String: (t: Int, c: Double)]], _ dayStart: Int) -> Int {
        var total = 0
        for (hour, tools) in merged where hour >= dayStart && hour < dayStart + 86_400 {
            total += tools.values.reduce(0) { $0 + $1.t }
        }
        return total
    }

    private func mergedHourlyLocked() -> [Int: [String: (t: Int, c: Double)]] {
        var merged: [Int: [String: (t: Int, c: Double)]] = [:]
        func add(_ hour: Int, _ tool: String, _ tokens: Int, _ cost: Double) {
            guard tokens > 0 || cost > 0 else { return }
            let prev = merged[hour]?[tool] ?? (0, 0.0)
            merged[hour, default: [:]][tool] = (prev.t + tokens, prev.c + cost)
        }
        for (_, st) in claudeFiles { for (h, b) in st.buckets { add(h, "claude", b.tokens, b.cost) } }
        for (_, st) in kimiFiles { for (h, b) in st.buckets { add(h, "kimi", b.tokens, b.cost) } }
        for (key, st) in genericFiles {
            let tool = key.split(separator: "::", maxSplits: 1).first.map(String.init) ?? "other"
            for (h, b) in st.buckets { add(h, tool, b.tokens, b.cost) }
        }
        for (_, st) in codexFiles { for (h, tokens) in st.buckets { add(h, "codex", tokens, 0) } }
        opencodePerDay { day, tokens, cost in add(day, "opencode", tokens, cost) }
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

    private func opencodePerDay(_ handler: (Int, Int, Double) -> Void) {
        guard let db = openDB() else { return }
        let sql = """
        SELECT time_created,
               COALESCE(tokens_input+tokens_output+tokens_reasoning+tokens_cache_read+tokens_cache_write,0),
               COALESCE(cost,0)
        FROM session
        """
        guard let stmt = prepare(db, sql) else { return }
        while sqlite3_step(stmt) == SQLITE_ROW {
            let createdMs = sqlite3_column_double(stmt, 0)
            let tokens = Int(sqlite3_column_int64(stmt, 1))
            let cost = sqlite3_column_double(stmt, 2)
            let hour = Int(createdMs / 1000 / 3600) * 3600
            handler(hour, tokens, cost)
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
                                   cacheReadAll: oc.cacheRead))
            snap.tokensToday += oc.todayTokens
            snap.costToday += oc.todayCost
            snap.tokensAllTime += oc.allTokens
            snap.costAllTime += oc.allCost
            snap.recentSessions = oc.sessions
            snap.models = modelUsage()
        }

        let claude = scanAdditive(dirs: ["~/.claude/projects", "~/.claude/transcripts"],
                                  state: &claudeFiles, prefix: "claude")
        if claude.allTokens > 0 || claude.trackedAny {
            tools.append(ToolUsage(tool: "claude",
                                   tokensToday: claude.todayTokens, tokensAllTime: claude.allTokens,
                                   costToday: claude.todayCost, costAllTime: claude.allCost,
                                   cacheReadAll: claude.cacheRead))
            snap.tokensToday += claude.todayTokens
            snap.costToday += claude.todayCost
            snap.tokensAllTime += claude.allTokens
            snap.costAllTime += claude.allCost
            for (model, v) in claude.perModel {
                snap.models.append(ModelUsage(provider: "claude", model: model,
                                              tokensAll: v.all, tokensToday: v.today, cost: v.cost,
                                              messages: 0, free: v.cost < 0.0001, cacheReadAll: 0))
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
            tools.append(ToolUsage(tool: "codex",
                                   tokensToday: codexToday.today, tokensAllTime: codexToday.all,
                                   costToday: 0, costAllTime: 0))
            snap.tokensToday += codexToday.today
            snap.tokensAllTime += codexToday.all
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
            for (h, b) in st.buckets where h >= kimiToday {
                kimi.todayTokens += b.tokens
                kimi.todayCost += b.cost
            }
        }
        kimi.trackedAny = !kimiFiles.isEmpty
        if kimi.allTokens > 0 || kimi.trackedAny {
            tools.append(ToolUsage(tool: "kimi",
                                   tokensToday: kimi.todayTokens, tokensAllTime: kimi.allTokens,
                                   costToday: kimi.todayCost, costAllTime: kimi.allCost))
            snap.tokensToday += kimi.todayTokens
            snap.costToday += kimi.todayCost
            snap.tokensAllTime += kimi.allTokens
            snap.costAllTime += kimi.allCost
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
                                       cacheReadAll: r.cacheRead))
                snap.tokensToday += r.todayTokens
                snap.costToday += r.todayCost
                snap.tokensAllTime += r.allTokens
                snap.costAllTime += r.allCost
                for (model, v) in r.perModel {
                    snap.models.append(ModelUsage(provider: source.tool, model: model,
                                                  tokensAll: v.all, tokensToday: v.today, cost: v.cost,
                                                  messages: 0, free: v.cost < 0.0001))
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
        var perModel: [String: (all: Int, today: Int, cost: Double)] = [:]
    }

    private func todayBucket() -> Int {
        Int(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970)
    }

    private func hourFromTimestamp(_ ts: String?) -> Int {
        guard let ts else { return currentHour() }
        var date = isoFormatter.date(from: ts)
        if date == nil { date = isoFallback.date(from: ts) }
        if let d = date { return Int(d.timeIntervalSince1970 / 3600) * 3600 }
        return currentHour()
    }

    private func currentHour() -> Int {
        Int(Date().timeIntervalSince1970 / 3600) * 3600
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
        var perModel: [String: (all: Int, today: Int, cost: Double)] = [:]
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
                        st.cacheRead += p.cacheRead
                        st.buckets[p.hour, default: (0, 0)].tokens += p.tokens
                        st.buckets[p.hour, default: (0, 0)].cost += p.cost
                        let modelName = p.model.isEmpty ? (prefix == "agy" ? "gemini-3.7-flash" : "\(prefix)-default") : p.model
                        let isToday = p.hour >= today
                        let prev = st.models[modelName] ?? (0, 0, 0.0)
                        st.models[modelName] = (prev.all + p.tokens, prev.today + (isToday ? p.tokens : 0), prev.cost + p.cost)
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
            for (model, v) in st.models {
                let prev = perModel[model] ?? (0, 0, 0.0)
                perModel[model] = (prev.all + v.all, prev.today + v.today, prev.cost + v.cost)
            }
            for (h, b) in st.buckets where h >= today {
                out.todayTokens += b.tokens
                out.todayCost += b.cost
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
                        st.allTokens += p.tokens
                        st.buckets[p.hour, default: (0, 0)].tokens += p.tokens
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
                        let deltaTokens = codexAccept(parsed, state: &st)
                        if let rate = parsed.rate {
                            st.rate = rate
                        }
                        if deltaTokens > 0 {
                            st.allTokens += deltaTokens
                            st.buckets[parsed.hour, default: 0] += deltaTokens
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
            for (h, v) in st.buckets where h >= today { todayTokens += v }
        }
        return (todayTokens, allTokens)
    }

    private func codexAccept(_ parsed: CodexParsed, state: inout CodexFileState) -> Int {
        let prev = state.watermark
        let cur = parsed.totals

        if cur >= prev {
            let delta = cur.delta(from: prev)
            state.watermark = cur
            state.last = parsed.last
            return delta.displayTokens
        }

        let prevTotal = prev.total
        let curTotal = cur.total
        let lastTotal = state.last.total
        let stale = prevTotal > 0 && curTotal > 0 && lastTotal > 0 &&
            (curTotal * 100 >= prevTotal * 98 || curTotal + lastTotal * 2 >= prevTotal)
        if stale { return 0 }

        state.watermark = cur
        state.last = parsed.last
        return parsed.last.displayTokens
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
        let hour = hourFromTimestamp(obj["timestamp"] as? String)

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

    private func parseKimiLine(_ line: Data) -> (tokens: Int, hour: Int)? {
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

        let input = field(["input_other", "inputOther"])
        let output = field(["output"])
        let cacheRead = field(["input_cache_read", "inputCacheRead"])
        let cacheWrite = field(["input_cache_creation", "inputCacheCreation"])
        let tokens = input + output + cacheRead + cacheWrite
        guard tokens > 0 else { return nil }

        var hour = currentHour()
        if let ts = obj["timestamp"] as? Double {
            hour = Int(ts / 3600) * 3600
        } else if let ts = obj["timestamp"] as? String {
            hour = hourFromTimestamp(ts)
        }
        return (tokens, hour)
    }

    private func parseAdditiveLine(_ line: Data) -> (tokens: Int, cost: Double, hour: Int, model: String, cacheRead: Int)? {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return nil }
        var tokens = 0
        var cost = 0.0
        var cacheRead = 0

        if let usage = (obj["message"] as? [String: Any])?["usage"] as? [String: Any] {
            tokens += anthropicTokens(usage)
            cacheRead += (usage["cache_read_input_tokens"] as? Int) ?? 0
        }
        for key in ["usage", "token_usage", "usageMetadata", "usage_metadata"] {
            if let usage = obj[key] as? [String: Any] {
                tokens += anthropicTokens(usage)
                tokens += openAITokens(usage)
                tokens += geminiTokens(usage)
                cacheRead += (usage["cache_read_input_tokens"] as? Int) ?? 0
                cacheRead += (usage["cached_content_token_count"] as? Int) ?? 0
                cacheRead += (usage["cachedContentTokenCount"] as? Int) ?? 0
                if let details = usage["prompt_tokens_details"] as? [String: Any] {
                    cacheRead += (details["cached_tokens"] as? Int) ?? 0
                }
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
            }
        }

        var hour = currentHour()
        if let ts = obj["timestamp"] as? String {
            hour = hourFromTimestamp(ts)
        } else if let ts = obj["timestamp"] as? Double {
            hour = Int(ts > 1e12 ? ts / 1000 / 3600 : ts / 3600) * 3600
        } else if let ts = obj["created_at"] as? String {
            hour = hourFromTimestamp(ts)
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
        return (tokens, cost, hour, model, cacheRead)
    }

    private func anthropicTokens(_ usage: [String: Any]) -> Int {
        var t = 0
        for key in ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] {
            if let n = usage[key] as? Int, n > 0 { t += n }
            else if let n = usage[key] as? NSNumber, n.intValue > 0 { t += n.intValue }
        }
        return t
    }

    private func openAITokens(_ usage: [String: Any]) -> Int {
        var t = 0
        for key in ["prompt_tokens", "completion_tokens"] {
            if let n = usage[key] as? Int, n > 0 { t += n }
            else if let n = usage[key] as? NSNumber, n.intValue > 0 { t += n.intValue }
        }
        return t
    }

    private func geminiTokens(_ usage: [String: Any]) -> Int {
        if let total = usage["total_token_count"] as? Int, total > 0 { return total }
        if let total = usage["totalTokenCount"] as? Int, total > 0 { return total }
        var t = 0
        for key in ["prompt_token_count", "promptTokenCount", "candidates_token_count", "candidatesTokenCount"] {
            if let n = usage[key] as? Int, n > 0 { t += n }
            else if let n = usage[key] as? NSNumber, n.intValue > 0 { t += n.intValue }
        }
        return t
    }

    private struct OCSums {
        var todayTokens = 0
        var todayCost = 0.0
        var allTokens = 0
        var allCost = 0.0
        var cacheRead = 0
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
               COUNT(*)
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
                out.append(ModelUsage(provider: provider, model: model,
                                      tokensAll: tokensAll, tokensToday: tokensToday,
                                      cost: cost, messages: messages, free: cost < 0.0001))
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
