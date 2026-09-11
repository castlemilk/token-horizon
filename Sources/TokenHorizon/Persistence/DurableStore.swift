import Foundation
import os

private let durableLog = Logger(subsystem: "com.tokenhorizon.app", category: "durable-store")

extension Notification.Name {
    static let tokenHorizonCacheReset = Notification.Name("tokenHorizonCacheReset")
}

final class DurableStore {
    static let shared = DurableStore()
    private let lock = NSLock()
    private let cacheDirectoryURL: URL

    // Debounce state for engine parser saves
    private var isEngineSavePending = false
    private var pendingEnginePayload: EngineStatePayload?
    private var lastEngineWrite = Date.distantPast
    /// Parser-state write throttle. Totals rebuild identically from files on
    /// restart, so this file only buys boot speed — minutes of staleness cost
    /// a short re-parse, never correctness. Terminate/reset flush explicitly.
    static let engineSaveInterval: TimeInterval = 60

    // Cached trends memory representation to allow multi-window updates
    private var cachedTrends: [String: [HistoryPoint]] = [:]

    struct HistoryCachePayload: Codable {
        var version: Int = 1
        var points: [HistoryPoint]
        var streak: Int
        var updatedAt: Date
    }

    struct TrendsCachePayload: Codable {
        var version: Int = 1
        var windows: [String: [HistoryPoint]]
        var updatedAt: Date
    }

    struct LimitsCachePayload: Codable {
        var version: Int = 1
        var planLimits: [ProviderLimit]
        var kimiLimits: [ProviderLimit]
        var updatedAt: Date
    }

    struct StoredWatermark: Codable {
        var input: Int
        var output: Int
        var cacheWrite: Int
        var cacheRead: Int
    }

    struct StoredBucket: Codable {
        var tokens: Int
        var cost: Double
        var input: Int = 0
        var output: Int = 0
        var requests: Int = 0
    }

    struct StoredModelAccum: Codable {
        var all: Int
        var today: Int
        var cost: Double
        var inputAll: Int = 0
        var outputAll: Int = 0
        var inputToday: Int = 0
        var outputToday: Int = 0
        var requestsAll: Int = 0
        var requestsToday: Int = 0
    }

    struct StoredProjectAccum: Codable {
        var tokens: Int = 0
        var cost: Double = 0
        var input: Int = 0
        var output: Int = 0
        var sessions: Int = 0
    }

    struct StoredAdditiveFile: Codable {
        var offset: UInt64
        var allTokens: Int
        var allCost: Double
        var cacheRead: Int
        var buckets: [String: StoredBucket]
        var models: [String: StoredModelAccum]
        var watermarks: [String: StoredWatermark]
        var cacheWrite: Int = 0
        var inputAll: Int = 0
        var outputAll: Int = 0
        var requestsAll: Int = 0
        var projects: [String: StoredProjectAccum] = [:]
    }

    struct StoredCodexRate: Codable {
        var usedPercent: Double
        var windowMinutes: Int
        var resetsAt: Int
    }

    struct StoredCodexWatermark: Codable {
        var input: Int
        var output: Int
        var cached: Int
        var reasoning: Int
    }

    struct StoredCodexFile: Codable {
        var offset: UInt64
        var watermark: StoredCodexWatermark
        var last: StoredCodexWatermark
        var allTokens: Int
        var buckets: [String: StoredBucket]
        var rate: StoredCodexRate?
        var model: String
        var modelTokens: Int
        var inputAll: Int = 0
        var outputAll: Int = 0
        var cachedAll: Int = 0
        var reasoningAll: Int = 0
        var requestsAll: Int = 0
        var models: [String: StoredModelAccum] = [:]
    }

    struct EngineStatePayload: Codable {
        /// v2 added per-bucket token-class splits, per-model input/output/
        /// request accumulators, and per-project rollups. v1 payloads fail
        /// decoding (missing keys) and trigger a one-time full reparse, which
        /// is the only way to recover complete historical splits.
        var version: Int = 2
        var claudeFiles: [String: StoredAdditiveFile]
        var kimiFiles: [String: StoredAdditiveFile]
        var genericFiles: [String: StoredAdditiveFile]
        var codexFiles: [String: StoredCodexFile]
        var updatedAt: Date
    }

    private init() {
        let dir = NSString(string: "~/.config/token-horizon/cache").expandingTildeInPath
        let url = URL(fileURLWithPath: dir, isDirectory: true)
        self.cacheDirectoryURL = url
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    var snapshotURL: URL { cacheDirectoryURL.appendingPathComponent("snapshot.json") }
    var historyURL: URL { cacheDirectoryURL.appendingPathComponent("history.json") }
    var trendsURL: URL { cacheDirectoryURL.appendingPathComponent("trends.json") }
    var limitsURL: URL { cacheDirectoryURL.appendingPathComponent("limits.json") }
    var engineStateURL: URL { cacheDirectoryURL.appendingPathComponent("engine-state.json") }

    // MARK: - Snapshot

    func saveSnapshot(_ snapshot: UsageSnapshot) {
        guard SettingsStore.shared.historyPersistenceEnabled else { return }
        lock.lock()
        defer { lock.unlock() }
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .secondsSince1970
        guard let data = try? enc.encode(snapshot) else { return }
        try? data.write(to: snapshotURL, options: .atomic)
    }

    func loadSnapshot() -> UsageSnapshot? {
        guard SettingsStore.shared.historyPersistenceEnabled else { return nil }
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: snapshotURL) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .secondsSince1970
        return try? dec.decode(UsageSnapshot.self, from: data)
    }

    // MARK: - History (Daily points & streak)

    func saveHistory(points: [HistoryPoint], streak: Int) {
        guard SettingsStore.shared.historyPersistenceEnabled else { return }
        lock.lock()
        defer { lock.unlock() }
        let payload = HistoryCachePayload(points: points, streak: streak, updatedAt: Date())
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .secondsSince1970
        guard let data = try? enc.encode(payload) else { return }
        try? data.write(to: historyURL, options: .atomic)
    }

    func loadHistory() -> (points: [HistoryPoint], streak: Int)? {
        guard SettingsStore.shared.historyPersistenceEnabled else { return nil }
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: historyURL) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .secondsSince1970
        guard let payload = try? dec.decode(HistoryCachePayload.self, from: data) else { return nil }
        return (payload.points, payload.streak)
    }

    // MARK: - Trends

    func saveTrends(window: TrendWindow, points: [HistoryPoint]) {
        guard SettingsStore.shared.historyPersistenceEnabled else { return }
        lock.lock()
        defer { lock.unlock() }
        cachedTrends[window.rawValue] = points
        let payload = TrendsCachePayload(windows: cachedTrends, updatedAt: Date())
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .secondsSince1970
        guard let data = try? enc.encode(payload) else { return }
        try? data.write(to: trendsURL, options: .atomic)
    }

    func loadTrends(window: TrendWindow) -> [HistoryPoint]? {
        guard SettingsStore.shared.historyPersistenceEnabled else { return nil }
        lock.lock()
        defer { lock.unlock() }
        if let mem = cachedTrends[window.rawValue], !mem.isEmpty {
            return mem
        }
        guard let data = try? Data(contentsOf: trendsURL) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .secondsSince1970
        guard let payload = try? dec.decode(TrendsCachePayload.self, from: data) else { return nil }
        cachedTrends = payload.windows
        return payload.windows[window.rawValue]
    }

    // MARK: - Plan & Kimi Limits

    func saveLimits(plan: [ProviderLimit], kimi: [ProviderLimit]) {
        guard SettingsStore.shared.historyPersistenceEnabled else { return }
        lock.lock()
        defer { lock.unlock() }
        let payload = LimitsCachePayload(planLimits: plan, kimiLimits: kimi, updatedAt: Date())
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .secondsSince1970
        guard let data = try? enc.encode(payload) else { return }
        try? data.write(to: limitsURL, options: .atomic)
    }

    func loadLimits() -> (plan: [ProviderLimit], kimi: [ProviderLimit])? {
        guard SettingsStore.shared.historyPersistenceEnabled else { return nil }
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: limitsURL) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .secondsSince1970
        guard let payload = try? dec.decode(LimitsCachePayload.self, from: data) else { return nil }
        return (payload.planLimits, payload.kimiLimits)
    }

    // MARK: - Engine Parser Incremental State

    func scheduleEngineStateSave(
        claude: [String: StoredAdditiveFile],
        kimi: [String: StoredAdditiveFile],
        generic: [String: StoredAdditiveFile],
        codex: [String: StoredCodexFile]
    ) {
        guard SettingsStore.shared.historyPersistenceEnabled else { return }
        lock.lock()
        let payload = EngineStatePayload(
            claudeFiles: claude,
            kimiFiles: kimi,
            genericFiles: generic,
            codexFiles: codex,
            updatedAt: Date()
        )
        pendingEnginePayload = payload
        let now = Date()
        guard !isEngineSavePending,
              now.timeIntervalSince(lastEngineWrite) >= Self.engineSaveInterval else {
            lock.unlock()
            return
        }
        isEngineSavePending = true
        lock.unlock()

        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.isEngineSavePending = false
            guard let savePayload = self.pendingEnginePayload else {
                self.lock.unlock()
                return
            }
            self.pendingEnginePayload = nil
            self.lock.unlock()

            let enc = JSONEncoder()
            enc.dateEncodingStrategy = .secondsSince1970
            guard let data = try? enc.encode(savePayload) else { return }
            try? data.write(to: self.engineStateURL, options: .atomic)
            self.lock.lock()
            self.lastEngineWrite = Date()
            self.lock.unlock()
            durableLog.debug("Saved engine parser state: \(savePayload.codexFiles.count) codex, \(savePayload.claudeFiles.count) claude files")
        }
    }

    /// Synchronous write of any staged engine payload (terminate path).
    /// No-op when persistence is off or nothing is staged. Encodes megabytes
    /// for heavy users — call off the hot path (terminate/reset only).
    func flushEngineState() {
        guard SettingsStore.shared.historyPersistenceEnabled else { return }
        lock.lock()
        guard let payload = pendingEnginePayload else { lock.unlock(); return }
        pendingEnginePayload = nil
        isEngineSavePending = false
        lock.unlock()

        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .secondsSince1970
        guard let data = try? enc.encode(payload) else { return }
        try? data.write(to: self.engineStateURL, options: .atomic)
        lock.lock()
        lastEngineWrite = Date()
        lock.unlock()
    }

    func loadEngineState() -> EngineStatePayload? {
        guard SettingsStore.shared.historyPersistenceEnabled else { return nil }
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: engineStateURL) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .secondsSince1970
        return try? dec.decode(EngineStatePayload.self, from: data)
    }

    // MARK: - Reset & Diagnostics

    @discardableResult
    func resetAll() -> (clearedFiles: Int, clearedBytes: Int64) {
        lock.lock()
        defer { lock.unlock() }
        cachedTrends.removeAll()
        pendingEnginePayload = nil
        lastEngineWrite = .distantPast

        let fm = FileManager.default
        var clearedFiles = 0
        var clearedBytes: Int64 = 0

        let targets = [snapshotURL, historyURL, trendsURL, limitsURL, engineStateURL]
        for url in targets {
            if let attrs = try? fm.attributesOfItem(atPath: url.path),
               let size = attrs[.size] as? Int64 {
                clearedBytes += size
            }
            if (try? fm.removeItem(at: url)) != nil {
                clearedFiles += 1
            }
        }

        durableLog.info("Reset all durable caches: removed \(clearedFiles) files (\(clearedBytes) bytes)")
        NotificationCenter.default.post(name: .tokenHorizonCacheReset, object: nil)
        return (clearedFiles, clearedBytes)
    }

    func cacheStats() -> (filesCount: Int, totalBytes: Int64, lastUpdated: Date?) {
        lock.lock()
        defer { lock.unlock() }
        let fm = FileManager.default
        var count = 0
        var bytes: Int64 = 0
        var latestDate: Date? = nil

        let targets = [snapshotURL, historyURL, trendsURL, limitsURL, engineStateURL]
        for url in targets {
            guard let attrs = try? fm.attributesOfItem(atPath: url.path) else { continue }
            count += 1
            if let s = attrs[.size] as? Int64 { bytes += s }
            if let m = attrs[.modificationDate] as? Date {
                if latestDate == nil || m > latestDate! {
                    latestDate = m
                }
            }
        }
        return (count, bytes, latestDate)
    }
}
