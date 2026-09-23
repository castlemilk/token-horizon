import Foundation
import SQLite3

final class UsageEngine {
    private var db: OpaquePointer?
    private let lock = NSLock()

    private var claudeFiles: [String: AdditiveFileState] = [:]
    private var codexFiles: [String: CodexFileState] = [:]
    private var genericFiles: [String: AdditiveFileState] = [:]
    private var kimiFiles: [String: AdditiveFileState] = [:]
    /// Set whenever parser state mutates (new deltas, truncation resets,
    /// file purges, manual reset). Gates the expensive full-state conversion
    /// in persistEngineStateLocked: idle ticks skip it entirely.
    private var parserStateDirty = false
    /// Per-source parser-state versions, bumped on the same mutations.
    /// Gates the O(files x buckets x models) aggregation tails: an unchanged
    /// version + same day reuses the previous SourceResult. Per-prefix keys
    /// stay correct under shared state (genericFiles) because every mutation
    /// and every aggregation filters by the same prefix.
    private var scanVersions: [String: Int] = [:]
    private struct ScanMemo { var version: Int; var today: Int; var result: SourceResult }
    private var scanMemos: [String: ScanMemo] = [:]
    /// Last computed snapshot, for routes that must never block on a scan:
    /// the /limits merge used to stall behind a cold-start scan holding the
    /// engine lock, which timed out API/MCP clients after app restarts.
    /// Guarded by its own lock (not `lock`) — `lock` is held for whole scans,
    /// so sharing it would reintroduce the stall. Lock order is always
    /// engine `lock` → `lastSnapshotLock`; readers take only the latter.
    private let lastSnapshotLock = NSLock()
    private var lastSnapshot: UsageSnapshot?
    /// Raw file size via stat(2) — one syscall, no objects. Replaces
    /// FileManager.attributesOfItem (full NSDictionary + NSNumbers per file),
    /// which profiled at ~24us/file on a loaded box across ~900 files/tick.
    /// Follows symlinks like FileManager does; nil when the file is gone.
    private static func fileSize(atPath path: String) -> UInt64? {
        var sb = stat()
        let ok = path.withCString { cstr in stat(cstr, &sb) }
        guard ok == 0, sb.st_size >= 0 else { return nil }
        return UInt64(sb.st_size)
    }
    private struct ListingCache { var files: [String]; var validatedAt: Date }
    private var listingCache: [String: ListingCache] = [:]
    /// hour-bucket → local day-start memo (Calendar calls are costly on the
    /// per-line scan path; the working set is ~24h × a few weeks).
    private var hourDayCache: [Int: Int] = [:]
    /// Trailing window kept for per-model daily history. The dashboard shows a
    /// 7-day stacked chart but needs the full 17-week window for per-day
    /// heatmap drilldowns.
    static let modelHistoryDays = 120
    /// Listing refresh bound. Directory trees hold thousands of media dirs
    /// (agy `brain/` ≈ 4k dirs); re-walking them every 5s tick cost ~200ms.
    /// New/deleted files are discovered at most this late — growth of KNOWN
    /// files is still detected every tick via per-file size checks, and no
    /// data is ever lost (offsets resume; history backfills). Matches
    /// HomeDiscovery's 30s `$HOME` listing cache.
    static let listingTTL: TimeInterval = 30

    struct AdditiveWatermark {
        var input: Int = 0
        var output: Int = 0
        var cacheWrite: Int = 0
        var cacheRead: Int = 0
    }

    /// Per-model accumulation. `all`/`today`/`cost` are the original fields;
    /// the input/output/request splits feed the leaderboard analytics.
    struct ModelAccum {
        var all = 0
        var today = 0
        var cost = 0.0
        var inputAll = 0
        var outputAll = 0
        var inputToday = 0
        var outputToday = 0
        var requestsAll = 0
        var requestsToday = 0
    }

    /// Hourly bucket with token-class split. `tokens` stays the total
    /// (input + output + cache read + cache write) so every existing consumer
    /// keeps working.
    struct HourBucket {
        var tokens = 0
        var cost = 0.0
        var input = 0
        var output = 0
        var requests = 0
    }

    /// Working-directory rollup. Claude/generic JSONL `cwd` + opencode
    /// session `directory`.
    struct ProjectAccum {
        var tokens = 0
        var cost = 0.0
        var input = 0
        var output = 0
        var sessions = 0
    }

    struct AdditiveFileState {
        var offset: UInt64 = 0
        var allTokens: Int = 0
        var allCost: Double = 0
        var cacheRead: Int = 0
        var cacheWrite: Int = 0
        var inputAll: Int = 0
        var outputAll: Int = 0
        var requestsAll: Int = 0
        var buckets: [Int: HourBucket] = [:]
        var models: [String: ModelAccum] = [:]
        var projects: [String: ProjectAccum] = [:]
        var watermarks: [String: AdditiveWatermark] = [:]
        /// model → local day-start → tokens, pruned to the trailing window.
        /// Per-file so truncation/rotation resets it with the rest of state.
        var modelDays: [String: [Int: Int]] = [:]
    }

    struct CodexWatermark {
        var input = 0
        var output = 0
        var cached = 0
        var reasoning = 0

        var total: Int { input + output + cached + reasoning }
        var displayTokens: Int { total }

        static func >= (l: CodexWatermark, r: CodexWatermark) -> Bool {
            l.input >= r.input && l.output >= r.output && l.cached >= r.cached && l.reasoning >= r.reasoning
        }

        func delta(from prev: CodexWatermark) -> CodexWatermark {
            CodexWatermark(input: input - prev.input, output: output - prev.output,
                           cached: cached - prev.cached, reasoning: reasoning - prev.reasoning)
        }
    }

    struct CodexRate {
        var usedPercent: Double
        var windowMinutes: Int
        var resetsAt: Int
    }

    struct CodexFileState {
        var offset: UInt64 = 0
        var watermark = CodexWatermark()
        var last = CodexWatermark()
        /// True once a cumulative `token_count` event has been consumed. Newer
        /// sessions also emit per-response `token_usage_record` events with the
        /// same usage — suppressed once the cumulative stream is confirmed so
        /// a response is never counted through both streams.
        var sawTokenCount = false
        var allTokens: Int = 0
        var buckets: [Int: HourBucket] = [:]
        var rate: CodexRate?
        var model: String = "codex"
        var modelTokens: Int = 0
        var inputAll: Int = 0
        var outputAll: Int = 0
        var cachedAll: Int = 0
        var reasoningAll: Int = 0
        var requestsAll: Int = 0
        var models: [String: ModelAccum] = [:]
        var modelDays: [String: [Int: Int]] = [:]
    }

    /// Session dirs for the fixed single-home generic tools, expanded to
    /// auto-discovered `~/.*` variants (e.g. `~/.qwen` and any future
    /// `~/.qwen-*` profile). Only existing dirs are returned — missing homes
    /// are a cheap no-op either way, so skipping them just shortens the scan.
    static var genericSources: [(tool: String, dirs: [String])] {
        func dirs(prefixes: [String], subpaths: [String]) -> [String] {
            HomeDiscovery.scanDirs(HomeDiscovery.variantDirs(prefixes: prefixes), subpaths: subpaths)
        }
        return [
            ("glm", dirs(prefixes: [".zcode", ".glm"], subpaths: ["projects"])),
            ("qwen", dirs(prefixes: [".qwen"], subpaths: ["projects"])),
            ("grok", dirs(prefixes: [".grok", ".xai"], subpaths: ["sessions"])),
            ("deepseek", dirs(prefixes: [".dsh", ".deepseek"], subpaths: ["sessions"])),
            ("gemini", dirs(prefixes: [".gemini"], subpaths: ["transcripts", "sessions", "projects"])),
            ("agy", dirs(prefixes: [".gemini"], subpaths: ["antigravity-cli/brain", "antigravity-cli/conversations"])),
        ]
    }

    static func configuredAgyModel() -> String {
        let path = NSString(string: "~/.gemini/antigravity-cli/settings.json").expandingTildeInPath
        if let data = FileManager.default.contents(atPath: path),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let m = obj["model"] as? String, !m.isEmpty {
            let lower = m.lowercased()
            if lower.contains("3.8") && lower.contains("flash") { return "gemini-3.8-flash" }
            if lower.contains("3.7") && lower.contains("flash") { return "gemini-3.7-flash" }
            if lower.contains("2.5") && lower.contains("flash") { return "gemini-2.5-flash" }
            if lower.contains("2.5") && lower.contains("pro") { return "gemini-2.5-pro" }
            return m
        }
        return "gemini-3.8-flash"
    }
    /// Codex session homes: historical `~/.codex/{sessions,archived_sessions}`
    /// plus any auto-discovered `~/.codex*` variants (`$CODEX_HOME` first).
    /// Shares `codexFiles` state across all dirs; unseen files are purged per
    /// scan, so added/removed variants converge without a reset.
    static var codexScanDirs: [String] {
        var out = ["~/.codex/sessions", "~/.codex/archived_sessions"].map(HomeDiscovery.expand)
        let variants = HomeDiscovery.variantDirs(
            prefixes: [".codex"], envVars: ["CODEX_HOME"], defaultPaths: ["~/.codex"])
        for extra in HomeDiscovery.scanDirs(variants, subpaths: ["sessions", "archived_sessions"]) {
            if !out.contains(extra) { out.append(extra) }
        }
        return out
    }
    static var kimiDirs: [String] {
        let env = ProcessInfo.processInfo.environment
        var dirs: [String] = []
        if let home = env["KIMI_HOME"], !home.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            dirs.append("\(HomeDiscovery.expand(home))/sessions")
        } else {
            dirs.append(HomeDiscovery.expand("~/.kimi/sessions"))
        }
        if let codeHome = env["KIMI_CODE_HOME"], !codeHome.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            dirs.append("\(HomeDiscovery.expand(codeHome))/sessions")
        } else {
            dirs.append(HomeDiscovery.expand("~/.kimi-code/sessions"))
        }
        // Auto-discovered ~/.kimi* variants (a third profile dir, etc.).
        for variant in HomeDiscovery.variantDirs(prefixes: [".kimi"]) {
            let s = "\(variant)/sessions"
            if !dirs.contains(s), HomeDiscovery.isDirectory(s) { dirs.append(s) }
        }
        return dirs
    }

    private let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private let isoFallback = ISO8601DateFormatter()

    init() {
        loadDurableEngineState()
        NotificationCenter.default.addObserver(forName: .tokenHorizonCacheReset, object: nil, queue: nil) { [weak self] _ in
            self?.resetState()
        }
    }

    func resetState() {
        lock.lock()
        defer { lock.unlock() }
        claudeFiles.removeAll()
        kimiFiles.removeAll()
        genericFiles.removeAll()
        codexFiles.removeAll()
        listingCache.removeAll()
        hourDayCache.removeAll()
        opencodeCache = nil
        devinSessionsCache = nil
        devinMtimes.removeAll()
        scanVersions.removeAll()
        scanMemos.removeAll()
        // Force the cleared state to disk next tick: otherwise a restart
        // would reload the stale pre-reset payload and skip data.
        parserStateDirty = true
    }

    /// Set TH_PERF_LOG=1 to log per-phase timings from snapshot/history/
    /// trends (off by default; a single env read, zero cost otherwise).
    /// Used by scripts/profile-tick.sh; see TickPerfHarnessTests.
    static let perfLogEnabled =
        ProcessInfo.processInfo.environment["TH_PERF_LOG"] != nil

    @inline(__always)
    private static func perfNow() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds
    }

    @inline(__always)
    private static func perfSpanMs(from t0: UInt64, to t1: UInt64) -> Double {
        Double(t1 >= t0 ? t1 - t0 : 0) / 1_000_000
    }

    /// Opt-in phase attribution for collectLocked (TH_PERF_LOG=1). Each mark
    /// is a single branch when logging is off, so the hot path pays nothing
    /// otherwise. Mark names denote segment ENDS; log() prints segment times.
    private struct PhaseTimer {
        var marks: [(String, UInt64)] = []
        mutating func mark(_ name: String) {
            if UsageEngine.perfLogEnabled { marks.append((name, UsageEngine.perfNow())) }
        }
        func log() {
            guard UsageEngine.perfLogEnabled, marks.count > 1 else { return }
            var parts: [String] = []
            parts.reserveCapacity(marks.count)
            for i in 1..<marks.count {
                parts.append("\(marks[i].0)=\(String(format: "%.1f", UsageEngine.perfSpanMs(from: marks[i - 1].1, to: marks[i].1)))")
            }
            NSLog("[Perf] collect " + parts.joined(separator: " "))
        }
    }

    /// Live parser corpus size. Must be called with `lock` held.
    private func trackedFileCountLocked() -> Int {
        claudeFiles.count + codexFiles.count + genericFiles.count + kimiFiles.count
    }

    func snapshot() -> UsageSnapshot {
        lock.lock()
        defer { lock.unlock() }
        let t0 = Self.perfNow()
        let snap = collectLocked()
        lastSnapshotLock.lock()
        lastSnapshot = snap
        lastSnapshotLock.unlock()
        let t1 = Self.perfNow()
        DurableStore.shared.saveSnapshot(snap)
        TokenHorizonTelemetry.shared.recordEngineTick(op: "snapshot", durationSeconds: Self.perfSpanMs(from: t0, to: t1) / 1000, filesTracked: trackedFileCountLocked())
        if Self.perfLogEnabled {
            NSLog("[Perf] snapshot collect=%.1fms save=%.1fms",
                  Self.perfSpanMs(from: t0, to: t1),
                  Self.perfSpanMs(from: t1, to: Self.perfNow()))
        }
        return snap
    }

    /// Last-known snapshot without waiting for an in-flight scan (nil until
    /// the first snapshot lands). Prefer this on routes that must answer fast.
    func cachedSnapshot() -> UsageSnapshot? {
        lastSnapshotLock.lock()
        defer { lastSnapshotLock.unlock() }
        return lastSnapshot
    }

    func history(days: Int) -> (points: [HistoryPoint], streak: Int) {
        lock.lock()
        defer { lock.unlock() }
        let t0 = Self.perfNow()
        _ = collectLocked()
        let merged = mergedHourlyLocked()

        let cal = Calendar.current
        var points: [HistoryPoint] = []
        for offset in (0..<days).reversed() {
            guard let date = cal.date(byAdding: .day, value: -offset, to: Date()) else { continue }
            let startDay = cal.startOfDay(for: date)
            let start = Int(startDay.timeIntervalSince1970)
            // Calendar-day end (DST-safe): a fixed +86400 would drop or
            // borrow an hour on 23/25-hour days.
            let endDay = cal.date(byAdding: .day, value: 1, to: startDay) ?? startDay.addingTimeInterval(86_400)
            points.append(aggregate(merged, from: start, to: Int(endDay.timeIntervalSince1970)))
        }

        let today = todayBucket()
        // Durable overlay, shared by the points fill above and the streak
        // walk below: pruned-file days count in both, so the heatmap and
        // the streak can never disagree about the past.
        var storedByDay: [Int: HistoryPoint] = [:]
        // Overlay durable history for prior days where log files were pruned/deleted
        if SettingsStore.shared.historyPersistenceEnabled,
           let stored = DurableStore.shared.loadHistory() {
            for p in stored.points { storedByDay[p.day] = p }
            for i in 0..<points.count {
                let day = points[i].day
                if day < today && points[i].tokens == 0, let cached = storedByDay[day], cached.tokens > 0 {
                    points[i] = cached
                }
            }
        }

        let streak = Self.streakDays(today: today) { day in
            let live = dayTokens(merged, day)
            if day < today, live == 0, let cached = storedByDay[day], cached.tokens > 0 {
                return cached.tokens
            }
            return live
        }

        let t1 = Self.perfNow()
        DurableStore.shared.saveHistory(points: points, streak: streak)
        TokenHorizonTelemetry.shared.recordEngineTick(op: "history", durationSeconds: Self.perfSpanMs(from: t0, to: t1) / 1000, filesTracked: trackedFileCountLocked())
        if Self.perfLogEnabled {
            NSLog("[Perf] history(%dd) collect+aggregate=%.1fms save=%.1fms",
                  days, Self.perfSpanMs(from: t0, to: t1),
                  Self.perfSpanMs(from: t1, to: Self.perfNow()))
        }
        return (points, streak)
    }

    func trendHistory(window: TrendWindow) -> [HistoryPoint] {
        lock.lock()
        defer { lock.unlock() }
        let t0 = Self.perfNow()
        _ = collectLocked()
        let merged = mergedHourlyLocked()

        let spec = window.spec
        var points: [HistoryPoint] = []
        let nowHour = currentHour()
        let today = todayBucket()
        // Calendar-day bounds for daily-aligned windows (DST-safe).
        let dayBounds = spec.dailyAligned ? Self.dailyAlignedBounds(count: spec.count, today: today) : []

        for (position, i) in (0..<spec.count).reversed().enumerated() {
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
                start = dayBounds[position].start
                end = dayBounds[position].end
            }
            points.append(aggregate(merged, from: start, to: min(end, currentHour() + 3600)))
        }

        let t1 = Self.perfNow()
        DurableStore.shared.saveTrends(window: window, points: points)
        TokenHorizonTelemetry.shared.recordEngineTick(op: "trends", durationSeconds: Self.perfSpanMs(from: t0, to: t1) / 1000, filesTracked: trackedFileCountLocked())
        if Self.perfLogEnabled {
            NSLog("[Perf] trends(%@) collect+aggregate=%.1fms save=%.1fms",
                  window.rawValue, Self.perfSpanMs(from: t0, to: t1),
                  Self.perfSpanMs(from: t1, to: Self.perfNow()))
        }
        return points
    }

    /// Sums hourly buckets in [from, to). Buckets are UTC-hour aligned while
    /// windows start at LOCAL midnight, so this matches by RANGE, never by
    /// striding exact keys — striding silently drops every bucket in
    /// non-whole-hour zones and on DST transition days. Internal for tests.
    func aggregate(_ merged: [Int: [String: (t: Int, c: Double)]], from: Int, to: Int) -> HistoryPoint {
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

    /// Day total via aggregate (single implementation of the range rule).
    /// Internal for hermetic unit tests.
    func dayTokens(_ merged: [Int: [String: (t: Int, c: Double)]], _ dayStart: Int) -> Int {
        aggregate(merged, from: dayStart, to: dayStart + 86_400).tokens
    }

    /// Consecutive active days ending today (or yesterday when today is
    /// still empty — the grace rule). Pure for testability: `tokensOn` maps
    /// a day-start bucket to that day's tokens.
    static func streakDays(today: Int, tokensOn: (Int) -> Int) -> Int {
        var streak = 0
        var cursor = today
        if tokensOn(cursor) == 0 { cursor -= 86_400 }
        while tokensOn(cursor) > 0 {
            streak += 1
            cursor -= 86_400
        }
        return streak
    }

    /// Merge per-directory accumulators into the snapshot project list.
    private func mergeProjects(into list: inout [ProjectUsage], from accums: [String: ProjectAccum]) {
        guard !accums.isEmpty else { return }
        var index: [String: Int] = [:]
        for (i, p) in list.enumerated() { index[p.directory] = i }
        for (dir, a) in accums {
            if let i = index[dir] {
                list[i].tokens += a.tokens
                list[i].cost += a.cost
                list[i].sessions += a.sessions
                list[i].inputTokens += a.input
                list[i].outputTokens += a.output
            } else {
                index[dir] = list.count
                list.append(ProjectUsage(directory: dir, tokens: a.tokens, cost: a.cost,
                                         sessions: a.sessions, inputTokens: a.input,
                                         outputTokens: a.output))
            }
        }
    }

    /// Merge per-model daily maps across files/sources.
    private func mergeModelDays(into list: inout [String: [Int: Int]], from accums: [String: [Int: Int]]) {
        guard !accums.isEmpty else { return }
        for (model, days) in accums {
            var acc = list[model] ?? [:]
            for (day, tokens) in days { acc[day, default: 0] += tokens }
            list[model] = acc
        }
    }

    /// 7 (Mon-first) x 24 local-hour token grid over the trailing `days`.
    /// Buckets are UTC-hour aligned; Calendar converts each to local time.
    func activityHeatmap(days: Int = 28) -> [[Int]] {
        lock.lock()
        defer { lock.unlock() }
        _ = collectLocked()
        let merged = mergedHourlyLocked()
        let cal = Calendar.current
        let start = cal.startOfDay(for: cal.date(byAdding: .day, value: -(max(1, days) - 1), to: Date()) ?? Date())
        let startTs = Int(start.timeIntervalSince1970)
        var grid = Array(repeating: Array(repeating: 0, count: 24), count: 7)
        for (hour, tools) in merged where hour >= startTs {
            var tokens = 0
            for (_, v) in tools { tokens += v.t }
            guard tokens > 0 else { continue }
            let date = Date(timeIntervalSince1970: TimeInterval(hour))
            let weekday = cal.component(.weekday, from: date)
            let hourOfDay = cal.component(.hour, from: date)
            let row = (weekday + 5) % 7
            guard (0..<7).contains(row), (0..<24).contains(hourOfDay) else { continue }
            grid[row][hourOfDay] += tokens
        }
        return grid
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
        for (_, st) in codexFiles { for (h, b) in st.buckets { add(h, "codex", b.tokens, 0) } }
        let localllm = OllamaTelemetryStore.shared.summary()
        for (h, tokens) in localllm.hourlyBuckets { add(h, "ollama", tokens, 0) }
        for (day, tokens, cost) in cachedOpencodeLocked().hourly { add(day, "opencode", tokens, cost) }
        return merged
    }

    static func windowLabel(minutes: Int) -> String {
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

    private func opencodePerDayQuery(_ db: OpaquePointer, _ handler: (Int, Int, Double) -> Void) {
        let sql = """
        SELECT CAST(time_created / 1000 / 3600 AS INT) * 3600,
               SUM(COALESCE(tokens_input+tokens_output+tokens_reasoning+tokens_cache_read+tokens_cache_write,0)),
               SUM(COALESCE(cost,0))
        FROM session
        GROUP BY 1
        """
        guard let stmt = prepare(db, sql) else { return }
        while sqlite3_step(stmt) == SQLITE_ROW {
            let hour = Int(sqlite3_column_int64(stmt, 0))
            let tokens = Int(sqlite3_column_int64(stmt, 1))
            let cost = sqlite3_column_double(stmt, 2)
            handler(hour, tokens, cost)
        }
        sqlite3_finalize(stmt)
    }

    private func collectLocked() -> UsageSnapshot {
        var snap = UsageSnapshot()
        snap.updatedAt = Date()
        var tools: [ToolUsage] = []
        var mergedModelDays: [String: [Int: Int]] = [:]
        var ph = PhaseTimer()
        ph.mark("start")

        let opencode = cachedOpencodeLocked()
        if let oc = opencode.sums {
            tools.append(ToolUsage(tool: "opencode",
                                   tokensToday: oc.todayTokens, tokensAllTime: oc.allTokens,
                                   costToday: oc.todayCost, costAllTime: oc.allCost,
                                   cacheReadAll: oc.cacheRead, cacheWriteAll: oc.cacheWrite,
                                   inputTokensToday: oc.inputTokensToday,
                                   outputTokensToday: oc.outputTokensToday,
                                   inputTokensAllTime: oc.inputTokensAll,
                                   outputTokensAllTime: oc.outputTokensAll,
                                   requestsToday: oc.requestsToday,
                                   requestsAllTime: oc.requestsAll))
            snap.tokensToday += oc.todayTokens
            snap.costToday += oc.todayCost
            snap.tokensAllTime += oc.allTokens
            snap.costAllTime += oc.allCost
            snap.recentSessions = oc.sessions
            snap.models = opencode.models
            for p in opencode.projects { snap.projects.append(p) }
        }
        ph.mark("opencode")

        let claudeDirs = ClaudeDiscovery.discoverDirectories()
        var claudeScanDirs: [String] = []
        for dir in claudeDirs {
            claudeScanDirs.append("\(dir)/projects")
            claudeScanDirs.append("\(dir)/transcripts")
        }
        let claude = scanAdditive(dirs: claudeScanDirs,
                                  state: &claudeFiles, prefix: "claude")
        if claude.allTokens > 0 || claude.trackedAny {
            tools.append(ToolUsage(tool: "claude",
                                   tokensToday: claude.todayTokens, tokensAllTime: claude.allTokens,
                                   costToday: claude.todayCost, costAllTime: claude.allCost,
                                   cacheReadAll: claude.cacheRead, cacheWriteAll: claude.cacheWrite,
                                   inputTokensToday: claude.inputToday,
                                   outputTokensToday: claude.outputToday,
                                   inputTokensAllTime: claude.inputAll,
                                   outputTokensAllTime: claude.outputAll,
                                   requestsToday: claude.requestsToday,
                                   requestsAllTime: claude.requestsAll))
            snap.tokensToday += claude.todayTokens
            snap.costToday += claude.todayCost
            snap.tokensAllTime += claude.allTokens
            snap.costAllTime += claude.allCost
            for (model, v) in claude.perModel {
                snap.models.append(ModelUsage(provider: "claude", model: model,
                                              tokensAll: v.all, tokensToday: v.today, cost: v.cost,
                                              messages: v.requestsAll, free: v.cost < 0.0001,
                                              inputTokensAll: v.inputAll, outputTokensAll: v.outputAll,
                                              inputTokensToday: v.inputToday, outputTokensToday: v.outputToday,
                                              requestsAll: v.requestsAll, requestsToday: v.requestsToday))
            }
            mergeProjects(into: &snap.projects, from: claude.projects)
            mergeModelDays(into: &mergedModelDays, from: claude.modelDays)
        }
        ph.mark("claude")

        let claudeToday = todayBucket()
        var claudeAccounts: [ClaudeAccount] = []
        for dir in claudeDirs {
            var acct = ClaudeDiscovery.shared.accountMetadata(for: dir)
            let exp = NSString(string: dir).expandingTildeInPath
            let prefixMatch = "claude::\(exp)/"
            var acctTokensAll = 0
            var acctTokensToday = 0
            var acctCostAll = 0.0
            var acctCostToday = 0.0
            for (key, st) in claudeFiles where key.hasPrefix(prefixMatch) {
                acctTokensAll += st.allTokens
                acctCostAll += st.allCost
                for (h, b) in st.buckets where h >= claudeToday {
                    acctTokensToday += b.tokens
                    acctCostToday += b.cost
                }
            }
            acct.tokensToday = acctTokensToday
            acct.tokensAllTime = acctTokensAll
            acct.costToday = acctCostToday
            acct.costAllTime = acctCostAll
            acct.limits = ClaudeDiscovery.shared.cachedLimits(for: dir)
            claudeAccounts.append(acct)
        }
        snap.claudeAccounts = claudeAccounts
        ph.mark("accts")

        let codexToday = scanCodex(dirs: Self.codexScanDirs)
        if let rate = latestCodexRate() {
            let left = max(0, Int(100 - rate.usedPercent))
            snap.limits.append(ProviderLimit(
                provider: "codex",
                label: Self.windowLabel(minutes: rate.windowMinutes),
                usedPercent: rate.usedPercent,
                resetsAt: Date(timeIntervalSince1970: TimeInterval(rate.resetsAt)),
                detail: "\(left)% left"))
        }
        if codexToday.all > 0 {
            let codexTodayBucket = todayBucket()
            var cInputAll = 0, cOutputAll = 0, cRequestsAll = 0
            var cInputToday = 0, cOutputToday = 0, cRequestsToday = 0
            var modelMap: [String: ModelAccum] = [:]
            for (_, st) in codexFiles {
                cInputAll += st.inputAll
                cOutputAll += st.outputAll
                cRequestsAll += st.requestsAll
                for (model, v) in st.models {
                    var acc = modelMap[model] ?? ModelAccum()
                    acc.all += v.all
                    acc.today += v.today
                    acc.inputAll += v.inputAll
                    acc.outputAll += v.outputAll
                    acc.inputToday += v.inputToday
                    acc.outputToday += v.outputToday
                    acc.requestsAll += v.requestsAll
                    acc.requestsToday += v.requestsToday
                    modelMap[model] = acc
                }
                mergeModelDays(into: &mergedModelDays, from: st.modelDays)
                for (h, b) in st.buckets where h >= codexTodayBucket {
                    cInputToday += b.input
                    cOutputToday += b.output
                    cRequestsToday += b.requests
                }
            }
            tools.append(ToolUsage(tool: "codex",
                                   tokensToday: codexToday.today, tokensAllTime: codexToday.all,
                                   costToday: 0, costAllTime: 0,
                                   inputTokensToday: cInputToday, outputTokensToday: cOutputToday,
                                   inputTokensAllTime: cInputAll, outputTokensAllTime: cOutputAll,
                                   requestsToday: cRequestsToday, requestsAllTime: cRequestsAll))
            snap.tokensToday += codexToday.today
            snap.tokensAllTime += codexToday.all
            for (model, v) in modelMap.sorted(by: { $0.value.all > $1.value.all }) {
                snap.models.append(ModelUsage(provider: "codex", model: model,
                                              tokensAll: v.all, tokensToday: v.today, cost: 0,
                                              messages: v.requestsAll, free: true,
                                              inputTokensAll: v.inputAll, outputTokensAll: v.outputAll,
                                              inputTokensToday: v.inputToday, outputTokensToday: v.outputToday,
                                              requestsAll: v.requestsAll, requestsToday: v.requestsToday))
            }
        }
        ph.mark("codex")

        var kimi = SourceResult()
        scanKimi(dirs: Self.kimiDirs)
        let kimiToday = todayBucket()
        for (_, st) in kimiFiles {
            kimi.allTokens += st.allTokens
            kimi.allCost += st.allCost
            kimi.inputAll += st.inputAll
            kimi.outputAll += st.outputAll
            kimi.requestsAll += st.requestsAll
            for (model, v) in st.models {
                var acc = kimi.perModel[model] ?? ModelAccum()
                acc.all += v.all
                acc.today += v.today
                acc.cost += v.cost
                acc.inputAll += v.inputAll
                acc.outputAll += v.outputAll
                acc.inputToday += v.inputToday
                acc.outputToday += v.outputToday
                acc.requestsAll += v.requestsAll
                acc.requestsToday += v.requestsToday
                kimi.perModel[model] = acc
            }
            mergeModelDays(into: &kimi.modelDays, from: st.modelDays)
            for (h, b) in st.buckets where h >= kimiToday {
                kimi.todayTokens += b.tokens
                kimi.todayCost += b.cost
                kimi.inputToday += b.input
                kimi.outputToday += b.output
                kimi.requestsToday += b.requests
            }
        }
        kimi.trackedAny = !kimiFiles.isEmpty
        if kimi.allTokens > 0 || kimi.trackedAny {
            tools.append(ToolUsage(tool: "kimi",
                                   tokensToday: kimi.todayTokens, tokensAllTime: kimi.allTokens,
                                   costToday: kimi.todayCost, costAllTime: kimi.allCost,
                                   cacheReadAll: kimi.cacheRead, cacheWriteAll: kimi.cacheWrite,
                                   inputTokensToday: kimi.inputToday,
                                   outputTokensToday: kimi.outputToday,
                                   inputTokensAllTime: kimi.inputAll,
                                   outputTokensAllTime: kimi.outputAll,
                                   requestsToday: kimi.requestsToday,
                                   requestsAllTime: kimi.requestsAll))
            snap.tokensToday += kimi.todayTokens
            snap.costToday += kimi.todayCost
            snap.tokensAllTime += kimi.allTokens
            snap.costAllTime += kimi.allCost
            for (model, v) in kimi.perModel {
                snap.models.append(ModelUsage(provider: "kimi", model: model,
                                              tokensAll: v.all, tokensToday: v.today,
                                              cost: v.cost, messages: v.requestsAll,
                                              free: v.cost < 0.0001,
                                              inputTokensAll: v.inputAll, outputTokensAll: v.outputAll,
                                              inputTokensToday: v.inputToday, outputTokensToday: v.outputToday,
                                              requestsAll: v.requestsAll, requestsToday: v.requestsToday))
            }
        }
        mergeModelDays(into: &mergedModelDays, from: kimi.modelDays)
        ph.mark("kimi")

        for source in Self.genericSources {
            let r = scanAdditive(dirs: source.dirs, state: &genericFiles, prefix: source.tool)
            if r.allTokens > 0 {
                tools.append(ToolUsage(tool: source.tool,
                                       tokensToday: r.todayTokens, tokensAllTime: r.allTokens,
                                       costToday: r.todayCost, costAllTime: r.allCost,
                                       cacheReadAll: r.cacheRead, cacheWriteAll: r.cacheWrite,
                                       inputTokensToday: r.inputToday,
                                       outputTokensToday: r.outputToday,
                                       inputTokensAllTime: r.inputAll,
                                       outputTokensAllTime: r.outputAll,
                                       requestsToday: r.requestsToday,
                                       requestsAllTime: r.requestsAll))
                snap.tokensToday += r.todayTokens
                snap.costToday += r.todayCost
                snap.tokensAllTime += r.allTokens
                snap.costAllTime += r.allCost
                for (model, v) in r.perModel {
                    snap.models.append(ModelUsage(provider: source.tool, model: model,
                                                  tokensAll: v.all, tokensToday: v.today, cost: v.cost,
                                                  messages: v.requestsAll, free: v.cost < 0.0001,
                                                  inputTokensAll: v.inputAll, outputTokensAll: v.outputAll,
                                                  inputTokensToday: v.inputToday, outputTokensToday: v.outputToday,
                                                  requestsAll: v.requestsAll, requestsToday: v.requestsToday))
                }
                mergeProjects(into: &snap.projects, from: r.projects)
                mergeModelDays(into: &mergedModelDays, from: r.modelDays)
            }
        }
        ph.mark("generic")

        let devin = scanDevin(dirs: Self.devinDirs, state: &genericFiles)
        if devin.allTokens > 0 || devin.trackedAny {
            tools.append(ToolUsage(tool: "devin",
                                   tokensToday: devin.todayTokens, tokensAllTime: devin.allTokens,
                                   costToday: devin.todayCost, costAllTime: devin.allCost,
                                   cacheReadAll: devin.cacheRead, cacheWriteAll: devin.cacheWrite,
                                   inputTokensToday: devin.inputToday,
                                   outputTokensToday: devin.outputToday,
                                   inputTokensAllTime: devin.inputAll,
                                   outputTokensAllTime: devin.outputAll,
                                   requestsToday: devin.requestsToday,
                                   requestsAllTime: devin.requestsAll))
            snap.tokensToday += devin.todayTokens
            snap.costToday += devin.todayCost
            snap.tokensAllTime += devin.allTokens
            snap.costAllTime += devin.allCost
            for (model, v) in devin.perModel {
                snap.models.append(ModelUsage(provider: "devin", model: model,
                                              tokensAll: v.all, tokensToday: v.today, cost: v.cost,
                                              messages: v.requestsAll, free: v.cost < 0.0001,
                                              inputTokensAll: v.inputAll, outputTokensAll: v.outputAll,
                                              inputTokensToday: v.inputToday, outputTokensToday: v.outputToday,
                                              requestsAll: v.requestsAll, requestsToday: v.requestsToday))
            }
            mergeProjects(into: &snap.projects, from: devin.projects)
            mergeModelDays(into: &mergedModelDays, from: devin.modelDays)
        }
        ph.mark("devin")

        let localllm = OllamaTelemetryStore.shared.summary()
        if localllm.allTokens > 0 {
            var ollamaRequestsAll = 0
            for (_, v) in localllm.models { ollamaRequestsAll += v.messages }
            tools.append(ToolUsage(tool: "ollama",
                                   tokensToday: localllm.todayTokens, tokensAllTime: localllm.allTokens,
                                   costToday: 0, costAllTime: 0,
                                   requestsAllTime: ollamaRequestsAll))
            snap.tokensToday += localllm.todayTokens
            snap.tokensAllTime += localllm.allTokens
            for (model, v) in localllm.models.sorted(by: { $0.value.all > $1.value.all }) {
                snap.models.append(ModelUsage(provider: "ollama", model: model,
                                              tokensAll: v.all, tokensToday: v.today, cost: 0,
                                              messages: v.messages, free: true, isLocal: true,
                                              localModelName: model,
                                              inputTokensAll: v.prompt, outputTokensAll: v.eval,
                                              requestsAll: v.messages))
            }
        }
        ph.mark("ollama")

        snap.models.sort {
            if $0.tokensToday != $1.tokensToday { return $0.tokensToday > $1.tokensToday }
            return $0.tokensAll > $1.tokensAll
        }
        // Per-model share of its provider (fable % of claude, etc.). Single
        // O(n) pass; feeds the dashboard MODELS list, /stats, and MCP.
        snap.models = ModelUsage.withProviderShares(snap.models)
        // Per-model daily history (trailing window), provider-resolved.
        var providerByModel: [String: String] = [:]
        for m in snap.models { providerByModel[m.model] = m.provider }
        snap.modelDaily = mergedModelDays.flatMap { model, days in
            days.map { ModelDailyUsage(model: model,
                                       provider: providerByModel[model] ?? "other",
                                       day: $0.key, tokens: $0.value) }
        }.filter { $0.tokens > 0 }
        snap.perTool = tools.filter { $0.tokensAllTime > 0 || $0.tokensToday > 0 }
        snap.sources = snap.perTool.map { $0.tool }
        snap.inputTokensAllTime = snap.perTool.reduce(0) { $0 + $1.inputTokensAllTime }
        snap.outputTokensAllTime = snap.perTool.reduce(0) { $0 + $1.outputTokensAllTime }
        snap.inputTokensToday = snap.perTool.reduce(0) { $0 + $1.inputTokensToday }
        snap.outputTokensToday = snap.perTool.reduce(0) { $0 + $1.outputTokensToday }
        snap.requestsAllTime = snap.perTool.reduce(0) { $0 + $1.requestsAllTime }
        snap.requestsToday = snap.perTool.reduce(0) { $0 + $1.requestsToday }
        snap.projects.sort { $0.tokens > $1.tokens }
        persistEngineStateLocked()
        ph.mark("tail")
        ph.log()
        return snap
    }

    private func persistEngineStateLocked() {
        guard SettingsStore.shared.historyPersistenceEnabled else { return }
        // The full-state conversion below walks every bucket/model/watermark
        // of every file (megabytes for heavy users) — skip it when nothing
        // mutated since the last persist.
        guard parserStateDirty else { return }
        parserStateDirty = false
        func toStoredAdditive(_ dict: [String: AdditiveFileState]) -> [String: DurableStore.StoredAdditiveFile] {
            var out: [String: DurableStore.StoredAdditiveFile] = [:]
            out.reserveCapacity(dict.count)
            for (path, st) in dict {
                var buckets: [String: DurableStore.StoredBucket] = [:]
                for (h, b) in st.buckets {
                    buckets[String(h)] = DurableStore.StoredBucket(
                        tokens: b.tokens, cost: b.cost, input: b.input,
                        output: b.output, requests: b.requests)
                }
                var models: [String: DurableStore.StoredModelAccum] = [:]
                for (m, accum) in st.models {
                    models[m] = DurableStore.StoredModelAccum(
                        all: accum.all, today: accum.today, cost: accum.cost,
                        inputAll: accum.inputAll, outputAll: accum.outputAll,
                        inputToday: accum.inputToday, outputToday: accum.outputToday,
                        requestsAll: accum.requestsAll, requestsToday: accum.requestsToday)
                }
                var projects: [String: DurableStore.StoredProjectAccum] = [:]
                for (dir, p) in st.projects {
                    projects[dir] = DurableStore.StoredProjectAccum(
                        tokens: p.tokens, cost: p.cost, input: p.input,
                        output: p.output, sessions: p.sessions)
                }
                var modelDays: [String: [String: Int]] = [:]
                for (model, days) in st.modelDays {
                    var d: [String: Int] = [:]
                    for (day, tokens) in days { d[String(day)] = tokens }
                    modelDays[model] = d
                }
                var watermarks: [String: DurableStore.StoredWatermark] = [:]
                for (mid, wm) in st.watermarks {
                    watermarks[mid] = DurableStore.StoredWatermark(input: wm.input, output: wm.output, cacheWrite: wm.cacheWrite, cacheRead: wm.cacheRead)
                }
                out[path] = DurableStore.StoredAdditiveFile(
                    offset: st.offset,
                    allTokens: st.allTokens,
                    allCost: st.allCost,
                    cacheRead: st.cacheRead,
                    buckets: buckets,
                    models: models,
                    watermarks: watermarks,
                    cacheWrite: st.cacheWrite,
                    inputAll: st.inputAll,
                    outputAll: st.outputAll,
                    requestsAll: st.requestsAll,
                    projects: projects,
                    modelDays: modelDays
                )
            }
            return out
        }

        var storedCodex: [String: DurableStore.StoredCodexFile] = [:]
        storedCodex.reserveCapacity(codexFiles.count)
        for (path, st) in codexFiles {
            var buckets: [String: DurableStore.StoredBucket] = [:]
            for (h, b) in st.buckets {
                buckets[String(h)] = DurableStore.StoredBucket(
                    tokens: b.tokens, cost: b.cost, input: b.input,
                    output: b.output, requests: b.requests)
            }
            var models: [String: DurableStore.StoredModelAccum] = [:]
            for (m, accum) in st.models {
                models[m] = DurableStore.StoredModelAccum(
                    all: accum.all, today: accum.today, cost: accum.cost,
                    inputAll: accum.inputAll, outputAll: accum.outputAll,
                    inputToday: accum.inputToday, outputToday: accum.outputToday,
                    requestsAll: accum.requestsAll, requestsToday: accum.requestsToday)
            }
            let wm = DurableStore.StoredCodexWatermark(
                input: st.watermark.input,
                output: st.watermark.output,
                cached: st.watermark.cached,
                reasoning: st.watermark.reasoning
            )
            let last = DurableStore.StoredCodexWatermark(
                input: st.last.input,
                output: st.last.output,
                cached: st.last.cached,
                reasoning: st.last.reasoning
            )
            var modelDays: [String: [String: Int]] = [:]
            for (model, days) in st.modelDays {
                var d: [String: Int] = [:]
                for (day, tokens) in days { d[String(day)] = tokens }
                modelDays[model] = d
            }
            let rate = st.rate.map {
                DurableStore.StoredCodexRate(usedPercent: $0.usedPercent, windowMinutes: $0.windowMinutes, resetsAt: $0.resetsAt)
            }
            storedCodex[path] = DurableStore.StoredCodexFile(
                offset: st.offset,
                watermark: wm,
                last: last,
                sawTokenCount: st.sawTokenCount,
                allTokens: st.allTokens,
                buckets: buckets,
                rate: rate,
                model: st.model,
                modelTokens: st.modelTokens,
                inputAll: st.inputAll,
                outputAll: st.outputAll,
                cachedAll: st.cachedAll,
                reasoningAll: st.reasoningAll,
                requestsAll: st.requestsAll,
                models: models,
                modelDays: modelDays
            )
        }

        DurableStore.shared.scheduleEngineStateSave(
            claude: toStoredAdditive(claudeFiles),
            kimi: toStoredAdditive(kimiFiles),
            generic: toStoredAdditive(genericFiles),
            codex: storedCodex
        )
    }

    private func loadDurableEngineState() {
        guard SettingsStore.shared.historyPersistenceEnabled,
              let payload = DurableStore.shared.loadEngineState() else { return }
        // Pre-v4 payloads kept only an 8-day per-model window; discard them so
        // the first scan rebuilds the full 17-week history for drilldowns.
        guard payload.version >= 4 else { return }
        lock.lock()
        defer { lock.unlock() }

        func fromStoredAdditive(_ dict: [String: DurableStore.StoredAdditiveFile]) -> [String: AdditiveFileState] {
            var out: [String: AdditiveFileState] = [:]
            out.reserveCapacity(dict.count)
            for (path, stored) in dict {
                var buckets: [Int: HourBucket] = [:]
                for (hStr, b) in stored.buckets {
                    if let h = Int(hStr) {
                        buckets[h] = HourBucket(tokens: b.tokens, cost: b.cost,
                                                input: b.input, output: b.output,
                                                requests: b.requests)
                    }
                }
                var models: [String: ModelAccum] = [:]
                for (m, accum) in stored.models {
                    models[m] = ModelAccum(
                        all: accum.all, today: accum.today, cost: accum.cost,
                        inputAll: accum.inputAll, outputAll: accum.outputAll,
                        inputToday: accum.inputToday, outputToday: accum.outputToday,
                        requestsAll: accum.requestsAll, requestsToday: accum.requestsToday)
                }
                var projects: [String: ProjectAccum] = [:]
                for (dir, p) in stored.projects {
                    projects[dir] = ProjectAccum(
                        tokens: p.tokens, cost: p.cost, input: p.input,
                        output: p.output, sessions: p.sessions)
                }
                var modelDays: [String: [Int: Int]] = [:]
                for (model, days) in stored.modelDays {
                    var d: [Int: Int] = [:]
                    for (dayStr, tokens) in days { if let day = Int(dayStr) { d[day] = tokens } }
                    modelDays[model] = d
                }
                var watermarks: [String: AdditiveWatermark] = [:]
                for (mid, wm) in stored.watermarks {
                    watermarks[mid] = AdditiveWatermark(input: wm.input, output: wm.output, cacheWrite: wm.cacheWrite, cacheRead: wm.cacheRead)
                }
                out[path] = AdditiveFileState(
                    offset: stored.offset,
                    allTokens: stored.allTokens,
                    allCost: stored.allCost,
                    cacheRead: stored.cacheRead,
                    cacheWrite: stored.cacheWrite,
                    inputAll: stored.inputAll,
                    outputAll: stored.outputAll,
                    requestsAll: stored.requestsAll,
                    buckets: buckets,
                    models: models,
                    projects: projects,
                    watermarks: watermarks,
                    modelDays: modelDays
                )
            }
            return out
        }

        var loadedCodex: [String: CodexFileState] = [:]
        loadedCodex.reserveCapacity(payload.codexFiles.count)
        for (path, stored) in payload.codexFiles {
            var buckets: [Int: HourBucket] = [:]
            for (hStr, b) in stored.buckets {
                if let h = Int(hStr) {
                    buckets[h] = HourBucket(tokens: b.tokens, cost: b.cost,
                                            input: b.input, output: b.output,
                                            requests: b.requests)
                }
            }
            var models: [String: ModelAccum] = [:]
            for (m, accum) in stored.models {
                models[m] = ModelAccum(
                    all: accum.all, today: accum.today, cost: accum.cost,
                    inputAll: accum.inputAll, outputAll: accum.outputAll,
                    inputToday: accum.inputToday, outputToday: accum.outputToday,
                    requestsAll: accum.requestsAll, requestsToday: accum.requestsToday)
            }
            let wm = CodexWatermark(
                input: stored.watermark.input,
                output: stored.watermark.output,
                cached: stored.watermark.cached,
                reasoning: stored.watermark.reasoning
            )
            let last = CodexWatermark(
                input: stored.last.input,
                output: stored.last.output,
                cached: stored.last.cached,
                reasoning: stored.last.reasoning
            )
            var modelDays: [String: [Int: Int]] = [:]
            for (model, days) in stored.modelDays {
                var d: [Int: Int] = [:]
                for (dayStr, tokens) in days { if let day = Int(dayStr) { d[day] = tokens } }
                modelDays[model] = d
            }
            let rate = stored.rate.map {
                CodexRate(usedPercent: $0.usedPercent, windowMinutes: $0.windowMinutes, resetsAt: $0.resetsAt)
            }
            loadedCodex[path] = CodexFileState(
                offset: stored.offset,
                watermark: wm,
                last: last,
                sawTokenCount: stored.sawTokenCount ?? false,
                allTokens: stored.allTokens,
                buckets: buckets,
                rate: rate,
                model: stored.model,
                modelTokens: stored.modelTokens,
                inputAll: stored.inputAll,
                outputAll: stored.outputAll,
                cachedAll: stored.cachedAll,
                reasoningAll: stored.reasoningAll,
                requestsAll: stored.requestsAll,
                models: models,
                modelDays: modelDays
            )
        }

        self.claudeFiles = fromStoredAdditive(payload.claudeFiles)
        // Kimi wire.jsonl migrated to flat `usage.record` events which the
        // old nested-schema parser never matched — pre-v5 persisted offsets
        // sit past uncounted history, so v4 payloads drop kimi file state and
        // the next scan reparses from 0 (one-time catch-up; v5+ loads keep it).
        self.kimiFiles = payload.version >= 5 ? fromStoredAdditive(payload.kimiFiles) : [:]
        self.genericFiles = fromStoredAdditive(payload.genericFiles)
        self.codexFiles = loadedCodex
    }

    /// Per-source scan rollup. Internal (returned by scanAdditive) for tests.
    struct SourceResult {
        var trackedAny = false
        var todayTokens = 0
        var todayCost = 0.0
        var allTokens = 0
        var allCost = 0.0
        var cacheRead = 0
        var cacheWrite = 0
        var inputAll = 0
        var outputAll = 0
        var inputToday = 0
        var outputToday = 0
        var requestsAll = 0
        var requestsToday = 0
        var perModel: [String: ModelAccum] = [:]
        var projects: [String: ProjectAccum] = [:]
        var modelDays: [String: [Int: Int]] = [:]
    }

    private func todayBucket() -> Int {
        Int(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970)
    }

    /// Local day-start for an epoch-hour bucket, memoized. Buckets are
    /// UTC-hour aligned; the Calendar conversion gives the local day.
    private func dayStartLocked(forHour hour: Int) -> Int {
        if let cached = hourDayCache[hour] { return cached }
        let day = Int(Calendar.current.startOfDay(
            for: Date(timeIntervalSince1970: TimeInterval(hour))).timeIntervalSince1970)
        if hourDayCache.count > 4096 { hourDayCache.removeAll(keepingCapacity: true) }
        hourDayCache[hour] = day
        return day
    }

    /// Drop per-model days outside the trailing window (bounds state + payload).
    private func pruneModelDays(_ days: inout [Int: Int], cutoff: Int) {
        if days.count > Self.modelHistoryDays * 2 {
            days = days.filter { $0.key >= cutoff }
        }
    }

    /// Calendar-day window bounds, newest last. Uses real calendar days
    /// (not today-i*86400) so DST transition days come out as 23/25h days
    /// instead of misattributing an hour. Pure for testability.
    static func dailyAlignedBounds(count: Int, today: Int, calendar: Calendar = .current) -> [(start: Int, end: Int)] {
        let anchor = Date(timeIntervalSince1970: TimeInterval(today))
        var out: [(start: Int, end: Int)] = []
        out.reserveCapacity(count)
        for i in (0..<count).reversed() {
            if let ds = calendar.date(byAdding: .day, value: -i, to: anchor),
               let de = calendar.date(byAdding: .day, value: 1, to: ds) {
                out.append((Int(ds.timeIntervalSince1970), Int(de.timeIntervalSince1970)))
            } else {
                let s = today - i * 86_400
                out.append((s, s + 86_400))
            }
        }
        return out
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

    private func cachedFiles(in dir: String, suffix: String = ".jsonl", excluding: Set<String> = []) -> [String] {
        listedFiles(fm: FileManager.default, root: dir, rel: "", suffix: suffix, excluding: excluding)
    }

    /// Directories whose entire subtree can never hold session files, by tool.
    /// Antigravity's `brain/` tree is ~9k media/scratch entries holding 7
    /// session transcripts (all under `.system_generated/logs/`); walking it
    /// fully every 5s tick cost ~200ms. Evidence: zero `.jsonl` outside
    /// `logs/` across the whole tree. If Antigravity ever moves transcripts,
    /// extend this set — sessions there would silently stop counting.
    static func excludedDirNames(for prefix: String) -> Set<String> {
        prefix == "agy" ? ["scratch", ".user_uploaded", ".tempmediaStorage"] : []
    }

    /// Recursive listing with TTL-bounded caching. Directory trees hold
    /// thousands of media dirs (agy `brain/` ≈ 4k dirs holding 7 session
    /// transcripts); re-walking them every 5s tick profiled at ~200ms, and
    /// per-dir mtime short-circuiting proved both slow (a stat per dir) and
    /// subtle. This re-walks at most every `listingTTL` (fresh readdir is
    /// always truth — no mtime-granularity assumptions) and serves the cached
    /// list in between with ZERO syscalls. Growth of known files is still
    /// detected every tick by per-file size checks in the scan callers, so
    /// the TTL only delays NEW/DELETED file discovery — never data.
    /// Internal for hermetic testing (`clock` injects time); all access holds
    /// the engine lock.
    func listedFiles(fm: FileManager, root: String, rel: String, suffix: String,
                     excluding: Set<String> = [], clock: THClock = SystemClock()) -> [String] {
        let key = root + "\0" + rel + "\0" + suffix + "\0" + excluding.sorted().joined(separator: ",")
        let now = clock.now()
        if let c = listingCache[key], now.timeIntervalSince(c.validatedAt) < Self.listingTTL {
            return c.files
        }
        var out: [String] = []
        collectDir(fm: fm, root: root, rel: rel, suffix: suffix, excluding: excluding, out: &out)
        listingCache[key] = ListingCache(files: out, validatedAt: now)
        return out
    }

    /// Fresh recursive walk (no caching — the TTL above amortizes it).
    /// Prunes nested `chunks/` (every file under it was already excluded by
    /// the path check below, so descent is pure waste). Top-level `chunks/`
    /// is still descended: the original `contains("/chunks/")` check does
    /// not match it.
    private func collectDir(fm: FileManager, root: String, rel: String, suffix: String, excluding: Set<String>, out: inout [String]) {
        let abs = rel.isEmpty ? root : root + "/" + rel
        guard let items = try? fm.contentsOfDirectory(atPath: abs) else { return }
        var isDir = ObjCBool(false)
        for item in items {
            let itemRel = rel.isEmpty ? item : rel + "/" + item
            if fm.fileExists(atPath: root + "/" + itemRel, isDirectory: &isDir), isDir.boolValue {
                if !rel.isEmpty, item == "chunks" { continue }
                if excluding.contains(item) { continue }
                collectDir(fm: fm, root: root, rel: itemRel, suffix: suffix, excluding: excluding, out: &out)
            } else if item.hasSuffix(suffix) {
                if itemRel.contains("/chunks/") { continue }
                if itemRel.contains("transcript_full.jsonl") { continue }
                out.append(itemRel)
            }
        }
    }

    /// Watermark delta for repeated message ids.
    /// Claude transcripts repeat the same assistant message (identical usage)
    /// several times per file — ~70% of ids repeat. `prev == nil` means "no
    /// message id on this line": count everything, store nothing.
    /// Otherwise count only growth beyond the recorded max (monotonic
    /// cumulative re-emits dedup to zero) and advance the watermark.
    static func watermarkDelta(prev: AdditiveWatermark?, input: Int, output: Int, cacheWrite: Int, cacheRead: Int)
        -> (dIn: Int, dOut: Int, dCw: Int, dCr: Int, next: AdditiveWatermark)
    {
        guard let prev else {
            return (input, output, cacheWrite, cacheRead,
                    AdditiveWatermark(input: input, output: output, cacheWrite: cacheWrite, cacheRead: cacheRead))
        }
        let next = AdditiveWatermark(
            input: max(prev.input, input),
            output: max(prev.output, output),
            cacheWrite: max(prev.cacheWrite, cacheWrite),
            cacheRead: max(prev.cacheRead, cacheRead))
        return (max(0, input - prev.input), max(0, output - prev.output),
                max(0, cacheWrite - prev.cacheWrite), max(0, cacheRead - prev.cacheRead), next)
    }

    /// Incremental additive scan over session dirs. Internal for hermetic
    /// accuracy tests (temp dirs + local state, no HOME involved).
    func scanAdditive(dirs: [String], state: inout [String: AdditiveFileState], prefix: String) -> SourceResult {
        let today = todayBucket()
        let modelDayCutoff = today - Self.modelHistoryDays * 86_400
        var seen = Set<String>()
        let keyPrefix = prefix + "::"

        for dir in dirs {
            let root = NSString(string: dir).expandingTildeInPath
            for item in cachedFiles(in: root, excluding: Self.excludedDirNames(for: prefix)) {
                let full = "\(root)/\(item)"
                let key = keyPrefix + full
                seen.insert(key)
                guard let size = Self.fileSize(atPath: full) else { continue }
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
                        let deltaIn: Int
                        let deltaOut: Int
                        let deltaCw: Int
                        let deltaCr: Int

                        if let mid = p.messageId {
                            let r = Self.watermarkDelta(
                                prev: st.watermarks[mid],
                                input: p.inputTokens, output: p.outputTokens,
                                cacheWrite: p.cacheWriteTokens, cacheRead: p.cacheReadTokens)
                            deltaIn = r.dIn
                            deltaOut = r.dOut
                            deltaCw = r.dCw
                            deltaCr = r.dCr
                            st.watermarks[mid] = r.next
                        } else {
                            let r = Self.watermarkDelta(
                                prev: nil,
                                input: p.inputTokens, output: p.outputTokens,
                                cacheWrite: p.cacheWriteTokens, cacheRead: p.cacheReadTokens)
                            deltaIn = r.dIn
                            deltaOut = r.dOut
                            deltaCw = r.dCw
                            deltaCr = r.dCr
                        }

                        let deltaTokens = deltaIn + deltaOut + deltaCw + deltaCr
                        if deltaTokens == 0 && p.explicitCost == nil {
                            continue
                        }

                        let cost: Double
                        if let expCost = p.explicitCost {
                            cost = expCost
                        } else if deltaTokens > 0 {
                            cost = Self.estimateTokenCost(
                                model: p.model,
                                inputTokens: deltaIn,
                                outputTokens: deltaOut,
                                cacheReadTokens: deltaCr,
                                cacheWriteTokens: deltaCw
                            )
                        } else {
                            cost = 0.0
                        }

                        let modelName = p.model.isEmpty ? (prefix == "agy" ? Self.configuredAgyModel() : "\(prefix)-default") : p.model
                        accumulateAdditive(&st, dIn: deltaIn, dOut: deltaOut, dCw: deltaCw, dCr: deltaCr,
                                           cost: cost, hour: p.hour, model: modelName, cwd: p.cwd,
                                           today: today, modelDayCutoff: modelDayCutoff)
                    }
                }
                st.offset += UInt64(consumable.count)
                state[key] = st
                parserStateDirty = true
                scanVersions[prefix, default: 0] += 1
            }
        }

        for key in state.keys where !seen.contains(key) && key.hasPrefix(keyPrefix) {
            state.removeValue(forKey: key)
            parserStateDirty = true
            scanVersions[prefix, default: 0] += 1
        }
        // Memoized tail: pure function of this prefix's state slice + today.
        // Idle ticks (no deltas, no purges) reuse the previous SourceResult.
        if let m = scanMemos[prefix], m.version == (scanVersions[prefix] ?? 0), m.today == today {
            var cached = m.result
            cached.trackedAny = !seen.isEmpty
            return cached
        }
        var out = summarizeAdditive(prefix: prefix, state: state, today: today)
        out.trackedAny = !seen.isEmpty
        scanMemos[prefix] = ScanMemo(version: scanVersions[prefix] ?? 0, today: today, result: out)
        return out
    }

    /// Shared per-record accumulation for additive sources (JSONL lines and
    /// Devin transcript steps alike). `deltaTokens == 0` with an explicit cost
    /// is allowed (cost-only records); request counts only advance on tokens.
    private func accumulateAdditive(_ st: inout AdditiveFileState, dIn: Int, dOut: Int, dCw: Int, dCr: Int,
                                    cost: Double, hour: Int, model: String, cwd: String?,
                                    today: Int, modelDayCutoff: Int) {
        let deltaTokens = dIn + dOut + dCw + dCr
        st.allTokens += deltaTokens
        st.allCost += cost
        st.cacheRead += dCr
        st.cacheWrite += dCw
        st.inputAll += dIn
        st.outputAll += dOut
        if deltaTokens > 0 { st.requestsAll += 1 }
        var bucket = st.buckets[hour] ?? HourBucket()
        bucket.tokens += deltaTokens
        bucket.cost += cost
        bucket.input += dIn
        bucket.output += dOut
        if deltaTokens > 0 { bucket.requests += 1 }
        st.buckets[hour] = bucket
        let isToday = hour >= today
        var acc = st.models[model] ?? ModelAccum()
        acc.all += deltaTokens
        acc.today += isToday ? deltaTokens : 0
        acc.cost += cost
        acc.inputAll += dIn
        acc.outputAll += dOut
        if deltaTokens > 0 { acc.requestsAll += 1 }
        if isToday {
            acc.inputToday += dIn
            acc.outputToday += dOut
            if deltaTokens > 0 { acc.requestsToday += 1 }
        }
        st.models[model] = acc
        if deltaTokens > 0 {
            let dayStart = dayStartLocked(forHour: hour)
            var days = st.modelDays[model] ?? [:]
            days[dayStart, default: 0] += deltaTokens
            pruneModelDays(&days, cutoff: modelDayCutoff)
            st.modelDays[model] = days
        }
        if let cwd, !cwd.isEmpty {
            var pa = st.projects[cwd] ?? ProjectAccum()
            pa.tokens += deltaTokens
            pa.cost += cost
            pa.input += dIn
            pa.output += dOut
            if deltaTokens > 0 { pa.sessions += 1 }
            st.projects[cwd] = pa
        }
    }

    /// Aggregate a `[key: AdditiveFileState]` slice into a SourceResult.
    /// Shared by scanAdditive (JSONL) and scanDevin (JSON transcript docs).
    private func summarizeAdditive(prefix: String, state: [String: AdditiveFileState], today: Int) -> SourceResult {
        var out = SourceResult()
        let keyPrefix = prefix + "::"
        let modelDayCutoff = today - Self.modelHistoryDays * 86_400
        for (key, st) in state where key.hasPrefix(keyPrefix) {
            out.allTokens += st.allTokens
            out.allCost += st.allCost
            out.cacheRead += st.cacheRead
            out.cacheWrite += st.cacheWrite
            out.inputAll += st.inputAll
            out.outputAll += st.outputAll
            out.requestsAll += st.requestsAll
            for (model, v) in st.models {
                var acc = out.perModel[model] ?? ModelAccum()
                acc.all += v.all
                acc.today += v.today
                acc.cost += v.cost
                acc.inputAll += v.inputAll
                acc.outputAll += v.outputAll
                acc.inputToday += v.inputToday
                acc.outputToday += v.outputToday
                acc.requestsAll += v.requestsAll
                acc.requestsToday += v.requestsToday
                out.perModel[model] = acc
            }
            for (h, b) in st.buckets where h >= today {
                out.todayTokens += b.tokens
                out.todayCost += b.cost
                out.inputToday += b.input
                out.outputToday += b.output
                out.requestsToday += b.requests
            }
            for (dir, p) in st.projects {
                var acc = out.projects[dir] ?? ProjectAccum()
                acc.tokens += p.tokens
                acc.cost += p.cost
                acc.input += p.input
                acc.output += p.output
                acc.sessions += p.sessions
                out.projects[dir] = acc
            }
            for (model, days) in st.modelDays {
                var acc = out.modelDays[model] ?? [:]
                for (day, tokens) in days where day >= modelDayCutoff {
                    acc[day, default: 0] += tokens
                }
                out.modelDays[model] = acc
            }
        }
        return out
    }

    /// Devin CLI session dirs: `~/.local/share/devin/cli/transcripts` holds
    /// one `<session>.json` doc per session, rewritten as steps append.
    static var devinDirs: [String] {
        [HomeDiscovery.expand("~/.local/share/devin/cli/transcripts")]
    }

    /// Devin transcript scanner. Unlike the JSONL sources each file is a
    /// whole JSON document (`{agent, steps[], final_metrics}`), so there is
    /// no byte-offset tail: the doc is re-parsed whenever its (size, mtime)
    /// fingerprint changes — same-size rewrites (a step's metrics can update
    /// in place) are still caught via mtime. `st.offset` stores the last
    /// parsed size purely for shrink detection (rotate/recreate → reset).
    /// Per-step `step_id` watermarks dedup re-parses and absorb cumulative
    /// metric rewrites. `metrics.prompt_tokens` already includes
    /// `cached_tokens` (OpenAI semantics), so input = prompt - cached and
    /// cacheRead = cached.
    private var devinMtimes: [String: (size: UInt64, mtime: TimeInterval)] = [:]
    func scanDevin(dirs: [String], state: inout [String: AdditiveFileState], prefix: String = "devin") -> SourceResult {
        let today = todayBucket()
        let modelDayCutoff = today - Self.modelHistoryDays * 86_400
        var seen = Set<String>()
        let keyPrefix = prefix + "::"
        let projectDirs = devinProjectDirs()

        for dir in dirs {
            let root = NSString(string: dir).expandingTildeInPath
            for item in cachedFiles(in: root, suffix: ".json") {
                let full = "\(root)/\(item)"
                let key = keyPrefix + full
                seen.insert(key)
                guard let attrs = try? FileManager.default.attributesOfItem(atPath: full),
                      let size = (attrs[.size] as? UInt64) ?? (attrs[.size] as? NSNumber)?.uint64Value,
                      let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 else { continue }
                if let prev = devinMtimes[key], prev == (size, mtime) { continue }
                // Record before parsing: a torn mid-write doc must not be
                // re-read every tick — the next real write bumps mtime.
                devinMtimes[key] = (size, mtime)
                var st = state[key] ?? AdditiveFileState()
                if size < st.offset { st = AdditiveFileState() }
                guard let data = FileManager.default.contents(atPath: full),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let steps = obj["steps"] as? [[String: Any]] else { continue }
                let sessionId = (item as NSString).deletingPathExtension
                let cwd = projectDirs[sessionId]
                let agentModel = ((obj["agent"] as? [String: Any])?["model_name"] as? String) ?? ""
                for step in steps {
                    guard let metrics = step["metrics"] as? [String: Any] else { continue }
                    let prompt = (metrics["prompt_tokens"] as? NSNumber)?.intValue ?? 0
                    let completion = (metrics["completion_tokens"] as? NSNumber)?.intValue ?? 0
                    let cached = (metrics["cached_tokens"] as? NSNumber)?.intValue ?? 0
                    guard prompt + completion > 0 else { continue }
                    let input = max(0, prompt - cached)
                    let stepId = ((step["step_id"] as? NSNumber)?.stringValue)
                        ?? (step["timestamp"] as? String) ?? UUID().uuidString
                    let r = Self.watermarkDelta(prev: st.watermarks[stepId],
                                                input: input, output: completion,
                                                cacheWrite: 0, cacheRead: cached)
                    st.watermarks[stepId] = r.next
                    let deltaTokens = r.dIn + r.dOut + r.dCr
                    guard deltaTokens > 0 else { continue }
                    let hour = hourFromTimestamp(step["timestamp"] as? String)
                    let stepModel = (step["model_name"] as? String) ?? ""
                    let model = !stepModel.isEmpty ? stepModel : (agentModel.isEmpty ? "devin" : agentModel)
                    let cost = Self.estimateTokenCost(model: model, inputTokens: r.dIn,
                                                      outputTokens: r.dOut, cacheReadTokens: r.dCr,
                                                      cacheWriteTokens: 0)
                    accumulateAdditive(&st, dIn: r.dIn, dOut: r.dOut, dCw: 0, dCr: r.dCr,
                                       cost: cost, hour: hour, model: model, cwd: cwd,
                                       today: today, modelDayCutoff: modelDayCutoff)
                }
                st.offset = size
                state[key] = st
                parserStateDirty = true
                scanVersions[prefix, default: 0] += 1
            }
        }
        for key in state.keys where !seen.contains(key) && key.hasPrefix(keyPrefix) {
            state.removeValue(forKey: key)
            devinMtimes.removeValue(forKey: key)
            parserStateDirty = true
            scanVersions[prefix, default: 0] += 1
        }
        if let m = scanMemos[prefix], m.version == (scanVersions[prefix] ?? 0), m.today == today {
            var cached = m.result
            cached.trackedAny = !seen.isEmpty
            return cached
        }
        var out = summarizeAdditive(prefix: prefix, state: state, today: today)
        out.trackedAny = !seen.isEmpty
        scanMemos[prefix] = ScanMemo(version: scanVersions[prefix] ?? 0, today: today, result: out)
        return out
    }

    /// session_id → working_directory from the Devin CLI's sessions.db,
    /// fingerprint-gated on db/-wal/-shm so idle ticks never open sqlite.
    private var devinSessionsCache: (fp: String, map: [String: String])?
    /// `base` is injectable for hermetic tests; nil → the real sessions.db.
    func devinProjectDirs(base: String? = nil) -> [String: String] {
        let base = base ?? NSString("~/.local/share/devin/cli/sessions.db").expandingTildeInPath
        var parts: [String] = []
        for suffix in ["", "-wal", "-shm"] {
            let p = base + suffix
            if let a = try? FileManager.default.attributesOfItem(atPath: p),
               let m = (a[.modificationDate] as? Date)?.timeIntervalSince1970,
               let s = a[.size] as? UInt64 {
                parts.append("\(m):\(s)")
            }
        }
        let fp = base + ">" + parts.joined(separator: "|")
        if let c = devinSessionsCache, c.fp == fp { return c.map }
        var map: [String: String] = [:]
        var handle: OpaquePointer?
        if sqlite3_open_v2(base, &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK {
            sqlite3_busy_timeout(handle, 150)
            if let stmt = prepare(handle!, "SELECT id, working_directory FROM sessions") {
                while sqlite3_step(stmt) == SQLITE_ROW {
                    let id = text(stmt, 0), dir = text(stmt, 1)
                    if !id.isEmpty, !dir.isEmpty { map[id] = dir }
                }
                sqlite3_finalize(stmt)
            }
        }
        sqlite3_close(handle)
        devinSessionsCache = (fp, map)
        return map
    }

    /// Incremental kimi scan. Internal for hermetic accuracy tests; call
    /// resetState() first for isolation from durable engine state.
    @discardableResult
    func scanKimi(dirs: [String]) -> (today: Int, all: Int) {
        var seen = Set<String>()
        for dir in dirs {
            let root = NSString(string: dir).expandingTildeInPath
            for item in cachedFiles(in: root, suffix: "wire.jsonl") {
                let full = "\(root)/\(item)"
                seen.insert(full)
                guard let size = Self.fileSize(atPath: full) else { continue }
                var st = kimiFiles[full] ?? AdditiveFileState()
                if size < st.offset { st = AdditiveFileState() }
                guard size > st.offset, let fh = FileHandle(forReadingAtPath: full) else { continue }
                fh.seek(toFileOffset: st.offset)
                let chunk = fh.readDataToEndOfFile()
                try? fh.close()
                guard let lastNewline = chunk.lastIndex(of: UInt8(ascii: "\n")) else { continue }
                let consumable = chunk[chunk.startIndex...lastNewline]
                let kimiToday = todayBucket()
                for line in consumable.split(separator: UInt8(ascii: "\n")) where !line.isEmpty {
                    if let p = parseKimiLine(Data(line)) {
                        st.allTokens += p.tokens
                        st.cacheRead += p.cacheReadTokens
                        st.cacheWrite += p.cacheWriteTokens
                        st.inputAll += p.inputTokens
                        st.outputAll += p.outputTokens
                        st.requestsAll += 1
                        var bucket = st.buckets[p.hour] ?? HourBucket()
                        bucket.tokens += p.tokens
                        bucket.input += p.inputTokens
                        bucket.output += p.outputTokens
                        bucket.requests += 1
                        st.buckets[p.hour] = bucket
                        let model = p.model ?? "kimi (model n/a)"
                        var acc = st.models[model] ?? ModelAccum()
                        acc.all += p.tokens
                        acc.inputAll += p.inputTokens
                        acc.outputAll += p.outputTokens
                        acc.requestsAll += 1
                        if p.hour >= kimiToday {
                            acc.today += p.tokens
                            acc.inputToday += p.inputTokens
                            acc.outputToday += p.outputTokens
                            acc.requestsToday += 1
                        }
                        st.models[model] = acc
                        var days = st.modelDays[model] ?? [:]
                        days[dayStartLocked(forHour: p.hour), default: 0] += p.tokens
                        pruneModelDays(&days, cutoff: kimiToday - Self.modelHistoryDays * 86_400)
                        st.modelDays[model] = days
                    }
                }
                st.offset += UInt64(consumable.count)
                kimiFiles[full] = st
                parserStateDirty = true
            }
        }
        // Drop state for removed variant dirs/files (mirrors scanAdditive).
        let kimiBefore = kimiFiles.count
        kimiFiles = kimiFiles.filter { seen.contains($0.key) }
        if kimiFiles.count != kimiBefore { parserStateDirty = true }
        var todayTokens = 0, allTokens = 0
        for (_, st) in kimiFiles {
            allTokens += st.allTokens
            for (h, b) in st.buckets where h >= todayBucket() { todayTokens += b.tokens }
        }
        return (todayTokens, allTokens)
    }

    /// Incremental codex scan. Internal for hermetic accuracy tests; call
    /// resetState() first for isolation from durable engine state.
    func scanCodex(dirs: [String]) -> (today: Int, all: Int) {
        var state = codexFiles
        let today = todayBucket()
        var seen = Set<String>()

        for dir in dirs {
            let root = NSString(string: dir).expandingTildeInPath
            for item in cachedFiles(in: root) {
                let full = "\(root)/\(item)"
                seen.insert(full)
                guard let size = Self.fileSize(atPath: full) else { continue }
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
                        if let model = parsed.model, !model.isEmpty {
                            st.model = model
                        }
                        if let rate = parsed.rate {
                            st.rate = rate
                        }
                        var delta = CodexWatermark()
                        if let totals = parsed.totals {
                            st.sawTokenCount = true
                            delta = codexAcceptDetailed(totals, last: parsed.last ?? totals, state: &st)
                        } else if let rec = parsed.record, !st.sawTokenCount, rec.total > 0 {
                            // Per-response record (no cumulative stream yet):
                            // count it and advance the watermark so the paired
                            // token_count — which already includes this
                            // response — nets a zero delta when it arrives.
                            st.watermark.input += rec.input
                            st.watermark.output += rec.output
                            st.watermark.cached += rec.cached
                            st.watermark.reasoning += rec.reasoning
                            delta = rec
                        }
                        let deltaTokens = delta.displayTokens
                        if deltaTokens > 0 {
                            st.allTokens += deltaTokens
                            st.modelTokens += deltaTokens
                            st.inputAll += delta.input
                            st.outputAll += delta.output
                            st.cachedAll += delta.cached
                            st.reasoningAll += delta.reasoning
                            st.requestsAll += 1
                            var bucket = st.buckets[parsed.hour] ?? HourBucket()
                            bucket.tokens += deltaTokens
                            bucket.input += delta.input
                            bucket.output += delta.output
                            bucket.requests += 1
                            st.buckets[parsed.hour] = bucket
                            let model = st.model.isEmpty ? "codex" : st.model
                            var acc = st.models[model] ?? ModelAccum()
                            acc.all += deltaTokens
                            acc.inputAll += delta.input
                            acc.outputAll += delta.output
                            acc.requestsAll += 1
                            if parsed.hour >= today {
                                acc.today += deltaTokens
                                acc.inputToday += delta.input
                                acc.outputToday += delta.output
                                acc.requestsToday += 1
                            }
                            st.models[model] = acc
                            var days = st.modelDays[model] ?? [:]
                            days[dayStartLocked(forHour: parsed.hour), default: 0] += deltaTokens
                            pruneModelDays(&days, cutoff: today - Self.modelHistoryDays * 86_400)
                            st.modelDays[model] = days
                        }
                    }
                }
                st.offset += UInt64(consumable.count)
                state[full] = st
                parserStateDirty = true
            }
        }

        let codexBefore = state.count
        codexFiles = state.filter { seen.contains($0.key) }
        if codexFiles.count != codexBefore { parserStateDirty = true }
        var todayTokens = 0, allTokens = 0
        for (_, st) in codexFiles {
            allTokens += st.allTokens
            for (h, b) in st.buckets where h >= today { todayTokens += b.tokens }
        }
        return (todayTokens, allTokens)
    }

    /// Stateful codex watermark accept. Internal for hermetic unit tests.
    func codexAccept(_ cur: CodexWatermark, last: CodexWatermark, state: inout CodexFileState) -> Int {
        codexAcceptDetailed(cur, last: last, state: &state).displayTokens
    }

    /// Component-preserving variant of `codexAccept`: returns the accepted
    /// delta with input/output/cached/reasoning split for analytics.
    func codexAcceptDetailed(_ cur: CodexWatermark, last: CodexWatermark, state: inout CodexFileState) -> CodexWatermark {
        let prev = state.watermark

        if cur >= prev {
            let delta = cur.delta(from: prev)
            state.watermark = cur
            state.last = last
            return delta
        }

        let prevTotal = prev.total
        let curTotal = cur.total
        let lastTotal = state.last.total
        let stale = prevTotal > 0 && curTotal > 0 && lastTotal > 0 &&
            (curTotal * 100 >= prevTotal * 98 || curTotal + lastTotal * 2 >= prevTotal)
        if stale { return CodexWatermark() }

        state.watermark = cur
        state.last = last
        return last
    }

    struct CodexParsed {
        var totals: CodexWatermark?
        var last: CodexWatermark?
        /// Per-response usage from `token_usage_record` events (additive,
        /// redundant with `token_count` when both streams exist).
        var record: CodexWatermark?
        var hour: Int
        var rate: CodexRate?
        var model: String?
    }

    /// Parses one codex session line. Internal for hermetic unit tests.
    func parseCodexLine(_ line: Data) -> CodexParsed? {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return nil }
        let payload = obj["payload"] as? [String: Any]
        let info = payload?["info"] as? [String: Any]
        let hour = hourFromTimestamp(obj["timestamp"] as? String)

        var model: String?
        if let m = payload?["model"] as? String, !m.isEmpty {
            model = m
        } else if let turn = payload?["turn_context"] as? [String: Any], let m = turn["model"] as? String, !m.isEmpty {
            model = m
        } else if let managed = payload?["managed_instructions"] as? [String: Any], let m = managed["model"] as? String, !m.isEmpty {
            model = m
        } else if let personality = payload?["personality"] as? [String: Any], let m = personality["model"] as? String, !m.isEmpty {
            model = m
        } else if let m = obj["model"] as? String, !m.isEmpty {
            model = m
        }

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

        let totals = watermark(info?["total_token_usage"] as? [String: Any])
        let last = watermark(info?["last_token_usage"] as? [String: Any]) ?? totals
        let record = (obj["type"] as? String) == "token_usage_record"
            ? watermark(payload?["usage"] as? [String: Any]) : nil

        var rate: CodexRate?
        if let rl = payload?["rate_limits"] as? [String: Any],
           let primary = rl["primary"] as? [String: Any],
           let used = (primary["used_percent"] as? NSNumber)?.doubleValue {
            rate = CodexRate(
                usedPercent: used,
                windowMinutes: (primary["window_minutes"] as? NSNumber)?.intValue ?? 0,
                resetsAt: (primary["resets_at"] as? NSNumber)?.intValue ?? 0)
        }

        if totals == nil && record == nil && rate == nil && model == nil {
            return nil
        }
        return CodexParsed(totals: totals, last: last, record: record, hour: hour, rate: rate, model: model)
    }

    struct KimiParsedLine {
        var tokens: Int
        var inputTokens: Int
        var outputTokens: Int
        var cacheReadTokens: Int
        var cacheWriteTokens: Int
        var hour: Int
        var model: String?
    }

    /// Parses one kimi wire.jsonl line. Internal for hermetic unit tests.
    /// Accepts the modern flat `usage.record` event and the legacy nested
    /// `message.payload.token_usage` shape.
    func parseKimiLine(_ line: Data) -> KimiParsedLine? {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return nil }

        var usage: [String: Any]
        var model: String?
        if (obj["type"] as? String) == "usage.record" {
            // "session"-scope records are cumulative summaries of the whole
            // session; only per-request "turn" records are additive.
            guard (obj["usageScope"] as? String) == "turn",
                  let u = obj["usage"] as? [String: Any] else { return nil }
            usage = u
            model = (obj["model"] as? String).flatMap { m in
                m.split(separator: "/").last.map { String($0) }
            }
        } else if let message = obj["message"] as? [String: Any],
                  let payload = message["payload"] as? [String: Any],
                  let u = payload["token_usage"] as? [String: Any] {
            usage = u
        } else { return nil }

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
        if let t = obj["time"] as? NSNumber {
            var secs = t.doubleValue
            if secs > 1e12 { secs /= 1000 }
            hour = Int(secs / 3600) * 3600
        } else if let ts = obj["timestamp"] as? Double {
            hour = Int(ts / 3600) * 3600
        } else if let ts = obj["timestamp"] as? String {
            hour = hourFromTimestamp(ts)
        }
        return KimiParsedLine(tokens: tokens, inputTokens: input, outputTokens: output,
                              cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
                              hour: hour, model: model)
    }

    struct AdditiveParsedLine {
        var messageId: String?
        var inputTokens: Int
        var outputTokens: Int
        var cacheWriteTokens: Int
        var cacheReadTokens: Int
        var explicitCost: Double?
        var hour: Int
        var model: String
        var cwd: String?
    }

    /// Parses one generic/claude JSONL line (anthropic/openai/gemini usage
    /// shapes, cost blocks, char-count fallback). Internal for hermetic tests.
    func parseAdditiveLine(_ line: Data) -> AdditiveParsedLine? {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return nil }
        var messageId: String?
        var cacheRead = 0
        var inputTokens = 0
        var outputTokens = 0
        var cacheWriteTokens = 0
        var explicitCost: Double?

        if let msg = obj["message"] as? [String: Any] {
            if let id = msg["id"] as? String { messageId = id }
            if let usage = msg["usage"] as? [String: Any] {
                let (inp, out, cw, cr) = anthropicBreakdown(usage)
                inputTokens += inp
                outputTokens += out
                cacheWriteTokens += cw
                cacheRead += cr
            }
        }
        for key in ["usage", "token_usage", "usageMetadata", "usage_metadata"] {
            if let usage = obj[key] as? [String: Any] {
                let (aIn, aOut, aCw, aCr) = anthropicBreakdown(usage)
                let (oIn, oOut) = openAIBreakdown(usage)
                let (gIn, gOut, gCr) = geminiBreakdown(usage)
                inputTokens += aIn + oIn + gIn
                outputTokens += aOut + oOut + gOut
                cacheWriteTokens += aCw
                let cr = aCr + gCr
                cacheRead += cr
                if let details = usage["prompt_tokens_details"] as? [String: Any] {
                    let dCr = (details["cached_tokens"] as? Int) ?? 0
                    cacheRead += dCr
                }
            }
        }
        if messageId == nil, let id = obj["id"] as? String, (obj["usage"] != nil || obj["token_usage"] != nil) {
            messageId = id
        }
        if let costBlock = obj["cost"] as? [String: Any], let total = costBlock["total"] as? Double {
            explicitCost = (explicitCost ?? 0.0) + total
        }
        if let c = obj["costUSD"] as? NSNumber { explicitCost = (explicitCost ?? 0.0) + c.doubleValue }

        var tokens = inputTokens + outputTokens + cacheWriteTokens + cacheRead
        if tokens == 0 && explicitCost == nil {
            var charCount = 0
            if let c = obj["content"] as? String { charCount += c.count }
            if let th = obj["thinking"] as? String { charCount += th.count }
            if let tc = obj["tool_calls"] as? [Any] {
                // Previously re-encoded via JSONSerialization.data(withJSONObject:)
                // just to count chars — an alloc per fallback line. Sum string
                // content directly instead (same /4 token estimate).
                charCount += Self.estimatedToolCallChars(tc)
            }
            if charCount > 0 {
                let estTok = max(1, charCount / 4)
                tokens = estTok
                let isOutput = (obj["type"] as? String == "PLANNER_RESPONSE" || obj["source"] as? String == "MODEL")
                if isOutput {
                    outputTokens += estTok
                } else {
                    inputTokens += estTok
                }
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
                model = Self.configuredAgyModel()
            }
        }

        guard tokens > 0 || explicitCost != nil else { return nil }
        return AdditiveParsedLine(
            messageId: messageId,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            cacheWriteTokens: cacheWriteTokens,
            cacheReadTokens: cacheRead,
            explicitCost: explicitCost,
            hour: hour,
            model: model,
            cwd: obj["cwd"] as? String
        )
    }

    /// Approximate serialized char count for tool_calls without JSON re-encode.
    /// Sums string content recursively with small per-container overhead so the
    /// existing `charCount / 4` token fallback stays calibrated.
    static func estimatedToolCallChars(_ value: Any) -> Int {
        if let s = value as? String { return s.count }
        if let arr = value as? [Any] {
            var total = 2 // brackets
            for el in arr { total += estimatedToolCallChars(el) + 1 }
            return total
        }
        if let dict = value as? [String: Any] {
            var total = 2 // braces
            for (k, v) in dict { total += k.count + 3 + estimatedToolCallChars(v) }
            return total
        }
        if value is NSNumber { return 8 }
        return 4
    }

    private func anthropicBreakdown(_ usage: [String: Any]) -> (input: Int, output: Int, cacheWrite: Int, cacheRead: Int) {
        let inp = (usage["input_tokens"] as? Int) ?? (usage["input_tokens"] as? NSNumber)?.intValue ?? 0
        let out = (usage["output_tokens"] as? Int) ?? (usage["output_tokens"] as? NSNumber)?.intValue ?? 0
        let cw = (usage["cache_creation_input_tokens"] as? Int) ?? (usage["cache_creation_input_tokens"] as? NSNumber)?.intValue ?? 0
        let cr = (usage["cache_read_input_tokens"] as? Int) ?? (usage["cache_read_input_tokens"] as? NSNumber)?.intValue ?? 0
        return (inp, out, cw, cr)
    }

    private func openAIBreakdown(_ usage: [String: Any]) -> (input: Int, output: Int) {
        let inp = (usage["prompt_tokens"] as? Int) ?? (usage["prompt_tokens"] as? NSNumber)?.intValue ?? 0
        let out = (usage["completion_tokens"] as? Int) ?? (usage["completion_tokens"] as? NSNumber)?.intValue ?? 0
        return (inp, out)
    }

    private func geminiBreakdown(_ usage: [String: Any]) -> (input: Int, output: Int, cacheRead: Int) {
        let inp = (usage["prompt_token_count"] as? Int) ?? (usage["promptTokenCount"] as? Int)
            ?? (usage["prompt_tokens"] as? NSNumber)?.intValue ?? 0
        let out = (usage["candidates_token_count"] as? Int) ?? (usage["candidatesTokenCount"] as? Int)
            ?? (usage["completion_tokens"] as? NSNumber)?.intValue ?? 0
        let cr = (usage["cached_content_token_count"] as? Int) ?? (usage["cachedContentTokenCount"] as? Int) ?? 0
        return (inp, out, cr)
    }

    static func estimateTokenCost(
        model: String,
        inputTokens: Int,
        outputTokens: Int,
        cacheReadTokens: Int,
        cacheWriteTokens: Int
    ) -> Double {
        let m = model.lowercased()
        if m.contains("claude") {
            let inPerM: Double
            let outPerM: Double
            let crPerM: Double
            let cwPerM: Double
            if m.contains("fable") {
                inPerM = 10.00; outPerM = 50.00; crPerM = 0.25; cwPerM = 12.50
            } else if m.contains("opus") {
                let isLegacy = m.contains("opus-3") || m.contains("opus-4-1")
                inPerM = isLegacy ? 15.00 : 5.00
                outPerM = isLegacy ? 75.00 : 25.00
                crPerM = isLegacy ? 1.50 : 0.50
                cwPerM = inPerM * 1.25
            } else if m.contains("haiku") {
                inPerM = m.contains("4-5") ? 1.00 : 0.80
                outPerM = m.contains("4-5") ? 5.00 : 4.00
                crPerM = inPerM * 0.10
                cwPerM = inPerM * 1.25
            } else {
                inPerM = 3.00; outPerM = 15.00; crPerM = 0.30; cwPerM = 3.75
            }
            return (Double(inputTokens) * inPerM + Double(outputTokens) * outPerM
                    + Double(cacheReadTokens) * crPerM + Double(cacheWriteTokens) * cwPerM) / 1_000_000.0
        }

        if m.contains("gemini") {
            let inPerM: Double
            let outPerM: Double
            let crPerM: Double
            if m.contains("pro") {
                inPerM = 1.25; outPerM = 5.00; crPerM = 0.3125
            } else {
                inPerM = 0.15; outPerM = 0.60; crPerM = 0.0375
            }
            return (Double(inputTokens) * inPerM + Double(outputTokens) * outPerM
                    + Double(cacheReadTokens) * crPerM) / 1_000_000.0
        }

        if let entry = ModelCatalog.shared.lookup(id: model), (entry.inputPerM > 0 || entry.outputPerM > 0) {
            let inCost = Double(inputTokens) * entry.inputPerM
            let outCost = Double(outputTokens) * entry.outputPerM
            let crCost = Double(cacheReadTokens) * (entry.cacheReadPerM ?? (entry.inputPerM * 0.10))
            let cwCost = Double(cacheWriteTokens) * (entry.inputPerM * 1.25)
            return (inCost + outCost + crCost + cwCost) / 1_000_000.0
        }

        // Unknown or zero-priced model with real tokens: ask the catalog to
        // self-heal (throttled live refresh) so pricing lands within minutes.
        if inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens > 0 {
            ModelCatalog.notePricingGap()
        }
        return 0.0
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
        var cacheWrite = 0
        var inputTokensAll = 0
        var outputTokensAll = 0
        var inputTokensToday = 0
        var outputTokensToday = 0
        var requestsAll = 0
        var requestsToday = 0
        var sessions: [SessionSummary] = []
    }

    private func localMidnightUTC() -> Int {
        todayBucket()
    }

    /// stat-gated snapshot of all opencode sqlite reads. The message-table
    /// GROUP BY with per-row json_extract is the hottest query in the 5s
    /// tick (~400ms warm in debug); db content cannot change without the
    /// db/-wal/-shm fingerprint changing, so idle ticks skip sqlite entirely.
    /// All access happens under `lock` (snapshot/history/trends hold it).
    private struct OpencodeSnapshot {
        var fingerprint: String
        var sums: OCSums?
        var models: [ModelUsage]
        var hourly: [(Int, Int, Double)]
        var projects: [ProjectUsage]
    }
    private var opencodeCache: OpencodeSnapshot?

    private func opencodeFingerprint() -> String {
        var parts: [String] = []
        parts.reserveCapacity(6)
        for base in [
            NSString("~/.local/share/opencode/opencode.db").expandingTildeInPath,
            NSString("~/Library/Application Support/opencode/opencode.db").expandingTildeInPath,
        ] {
            for suffix in ["", "-wal", "-shm"] {
                let p = base + suffix
                if let a = try? FileManager.default.attributesOfItem(atPath: p),
                   let m = (a[.modificationDate] as? Date)?.timeIntervalSince1970,
                   let s = a[.size] as? UInt64 {
                    parts.append("\(suffix):\(m):\(s)")
                }
            }
        }
        return parts.joined(separator: "|")
    }

    private func cachedOpencodeLocked() -> OpencodeSnapshot {
        let fp = opencodeFingerprint()
        if let c = opencodeCache, c.fingerprint == fp { return c }
        var snap = OpencodeSnapshot(fingerprint: fp, sums: nil, models: [], hourly: [], projects: [])
        snap.models = modelUsageQuery()
        if var sums = opencodeUsageQuery() {
            sums.requestsAll = snap.models.reduce(0) { $0 + $1.requestsAll }
            sums.requestsToday = snap.models.reduce(0) { $0 + $1.requestsToday }
            snap.sums = sums
        }
        if let db = openDB() {
            opencodePerDayQuery(db) { h, t, c in snap.hourly.append((h, t, c)) }
            snap.projects = opencodeProjectsQuery(db)
        }
        opencodeCache = snap
        return snap
    }

    private func opencodeUsageQuery() -> OCSums? {
        guard let db = openDB() else { return nil }
        var out = OCSums()

        let tokenExpr = "COALESCE(SUM(tokens_input+tokens_output+tokens_reasoning+tokens_cache_read+tokens_cache_write),0)"
        let midnightMs = localMidnightUTC() * 1000

        var sql = """
        SELECT \(tokenExpr), COALESCE(SUM(cost),0),
               COALESCE(SUM(tokens_cache_read),0), COALESCE(SUM(tokens_cache_write),0),
               COALESCE(SUM(tokens_input),0), COALESCE(SUM(tokens_output),0)
        FROM session
        """
        if let stmt = prepare(db, sql), sqlite3_step(stmt) == SQLITE_ROW {
            out.allTokens = Int(sqlite3_column_int64(stmt, 0))
            out.allCost = sqlite3_column_double(stmt, 1)
            out.cacheRead = Int(sqlite3_column_int64(stmt, 2))
            out.cacheWrite = Int(sqlite3_column_int64(stmt, 3))
            out.inputTokensAll = Int(sqlite3_column_int64(stmt, 4))
            out.outputTokensAll = Int(sqlite3_column_int64(stmt, 5))
            sqlite3_finalize(stmt)
        }
        sql = """
        SELECT \(tokenExpr), COALESCE(SUM(cost),0),
               COALESCE(SUM(tokens_input),0), COALESCE(SUM(tokens_output),0)
        FROM session WHERE time_created > \(midnightMs)
        """
        if let stmt = prepare(db, sql), sqlite3_step(stmt) == SQLITE_ROW {
            out.todayTokens = Int(sqlite3_column_int64(stmt, 0))
            out.todayCost = sqlite3_column_double(stmt, 1)
            out.inputTokensToday = Int(sqlite3_column_int64(stmt, 2))
            out.outputTokensToday = Int(sqlite3_column_int64(stmt, 3))
            sqlite3_finalize(stmt)
        }
        sql = """
        SELECT s.id, s.title, s.cost,
               COALESCE(s.tokens_input+s.tokens_output+s.tokens_reasoning+s.tokens_cache_read+s.tokens_cache_write,0),
               s.directory, s.time_created, s.tokens_input, s.tokens_output, s.model,
               (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id AND json_extract(m.data,'$.role')='assistant')
        FROM session s ORDER BY s.time_updated DESC LIMIT 12
        """
        if let stmt = prepare(db, sql) {
            while sqlite3_step(stmt) == SQLITE_ROW {
                let id = text(stmt, 0)
                let title = text(stmt, 1)
                let cost = sqlite3_column_double(stmt, 2)
                let tokens = Int(sqlite3_column_int64(stmt, 3))
                let dir = text(stmt, 4)
                let created = Date(timeIntervalSince1970: sqlite3_column_double(stmt, 5) / 1000)
                let inputTokens = Int(sqlite3_column_int64(stmt, 6))
                let outputTokens = Int(sqlite3_column_int64(stmt, 7))
                let requests = Int(sqlite3_column_int64(stmt, 9))
                var provider = ""
                var modelName = ""
                if let data = text(stmt, 8).data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    provider = obj["providerID"] as? String ?? ""
                    modelName = obj["id"] as? String ?? ""
                }
                out.sessions.append(SessionSummary(id: id, title: title, cost: cost, tokens: tokens,
                                                   directory: dir, created: created,
                                                   provider: provider, model: modelName,
                                                   inputTokens: inputTokens, outputTokens: outputTokens,
                                                   requests: requests))
            }
            sqlite3_finalize(stmt)
        }
        return out
    }

    private func opencodeProjectsQuery(_ db: OpaquePointer) -> [ProjectUsage] {
        let sql = """
        SELECT directory,
               COALESCE(SUM(tokens_input+tokens_output+tokens_reasoning+tokens_cache_read+tokens_cache_write),0),
               COALESCE(SUM(cost),0), COUNT(*),
               COALESCE(SUM(tokens_input),0), COALESCE(SUM(tokens_output),0)
        FROM session WHERE directory != ''
        GROUP BY directory ORDER BY 2 DESC LIMIT 12
        """
        var out: [ProjectUsage] = []
        guard let stmt = prepare(db, sql) else { return out }
        while sqlite3_step(stmt) == SQLITE_ROW {
            out.append(ProjectUsage(directory: text(stmt, 0),
                                    tokens: Int(sqlite3_column_int64(stmt, 1)),
                                    cost: sqlite3_column_double(stmt, 2),
                                    sessions: Int(sqlite3_column_int64(stmt, 3)),
                                    inputTokens: Int(sqlite3_column_int64(stmt, 4)),
                                    outputTokens: Int(sqlite3_column_int64(stmt, 5))))
        }
        sqlite3_finalize(stmt)
        return out
    }

    private func modelUsageQuery() -> [ModelUsage] {
        guard let db = openDB() else { return [] }
        let midnightMs = localMidnightUTC() * 1000
        // MATERIALIZED: tokensExpr is evaluated once per row instead of twice
        // (total + today-conditional SUMs). ~25% faster on large message
        // tables; verified byte-identical output vs the flat form.
        let tokensExpr = "COALESCE(json_extract(data,'$.tokens.total'), COALESCE(json_extract(data,'$.tokens.input'),0) + COALESCE(json_extract(data,'$.tokens.output'),0) + COALESCE(json_extract(data,'$.tokens.reasoning'),0) + COALESCE(json_extract(data,'$.tokens.cache.read'),0) + COALESCE(json_extract(data,'$.tokens.cache.write'),0), 0)"
        let sql = """
        WITH m AS MATERIALIZED (
            SELECT COALESCE(json_extract(data,'$.providerID'),'?') AS p,
                   COALESCE(json_extract(data,'$.modelID'),'?') AS mo,
                   \(tokensExpr) AS t,
                   time_created AS tc,
                   COALESCE(json_extract(data,'$.cost'),0) AS c,
                   COALESCE(json_extract(data,'$.tokens.input'),0) AS i,
                   COALESCE(json_extract(data,'$.tokens.output'),0) AS o,
                   COALESCE(json_extract(data,'$.tokens.cache.read'),0) AS cr,
                   COALESCE(json_extract(data,'$.tokens.cache.write'),0) AS cw
            FROM message WHERE json_extract(data,'$.role')='assistant')
        SELECT p, mo, SUM(t),
               SUM(CASE WHEN tc > \(midnightMs) THEN t ELSE 0 END),
               SUM(c), COUNT(*),
               SUM(i), SUM(o), SUM(cr), SUM(cw),
               SUM(CASE WHEN tc > \(midnightMs) THEN i ELSE 0 END),
               SUM(CASE WHEN tc > \(midnightMs) THEN o ELSE 0 END),
               SUM(CASE WHEN tc > \(midnightMs) THEN 1 ELSE 0 END)
        FROM m GROUP BY 1,2 ORDER BY 3 DESC
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
                let isFree = cost < 0.0001 || provider.lowercased().contains("free") || model.lowercased().contains("free") || model.lowercased().contains("pickle")
                out.append(ModelUsage(provider: provider, model: model,
                                      tokensAll: tokensAll, tokensToday: tokensToday,
                                      cost: cost, messages: messages, free: isFree,
                                      cacheReadAll: Int(sqlite3_column_int64(stmt, 8)),
                                      inputTokensAll: Int(sqlite3_column_int64(stmt, 6)),
                                      outputTokensAll: Int(sqlite3_column_int64(stmt, 7)),
                                      inputTokensToday: Int(sqlite3_column_int64(stmt, 10)),
                                      outputTokensToday: Int(sqlite3_column_int64(stmt, 11)),
                                      cacheWriteAll: Int(sqlite3_column_int64(stmt, 9)),
                                      requestsAll: messages,
                                      requestsToday: Int(sqlite3_column_int64(stmt, 12))))
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

    struct Cell {
        var int: Int?
        var double: Double?
    }

    private func text(_ stmt: OpaquePointer, _ i: Int32) -> String {
        guard let c = sqlite3_column_text(stmt, i) else { return "" }
        return String(cString: c)
    }
}
