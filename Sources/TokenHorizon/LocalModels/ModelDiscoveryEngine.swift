import Foundation

final class ModelDiscoveryEngine {
    static let shared = ModelDiscoveryEngine()

    private let queue = DispatchQueue(label: "com.tokenhorizon.discovery", qos: .utility)
    private let lock = NSLock()

    private var localTimer: DispatchSourceTimer?
    private var remoteTimer: DispatchSourceTimer?

    private var fileSystemSources: [DispatchSourceFileSystemObject] = []
    private var openDescriptors: [CInt] = []

    private var debounceWorkItem: DispatchWorkItem?

    struct FileState: Codable, Equatable {
        var path: String
        var exists: Bool
        var mtime: Date?
        var size: UInt64
    }

    struct DiscoveryStatus: Codable {
        var isRunning: Bool
        var lastLocalScan: Date?
        var lastRemoteScan: Date?
        var scanCount: Int
        var totalDiscovered: Int
        var recentDiscovered: [String]
        var monitoredFiles: [FileStatus]
        var catalogRevision: Int
        var catalogCount: Int

        struct FileStatus: Codable {
            var path: String
            var exists: Bool
            var lastModified: Date?
            var sizeBytes: UInt64
        }
    }

    struct DiscoverySummary: Codable {
        var timestamp: Date
        var added: Int
        var updated: Int
        var newModels: [String]
        var reason: String
        var catalogRevision: Int
        var totalCatalogCount: Int
    }

    private var trackedFiles: [String: FileState] = [:]
    private var lastLocalScan: Date?
    private var lastRemoteScan: Date?
    private var scanCount: Int = 0
    private var totalDiscovered: Int = 0
    private var recentDiscovered: [String] = []
    private var isRunning: Bool = false

    private let monitoredPaths: [String] = [
        NSString(string: "~/.codex/models_cache.json").expandingTildeInPath,
        NSString(string: "~/.config/codex/models_cache.json").expandingTildeInPath,
        NSString(string: "~/.local/share/opencode/auth.json").expandingTildeInPath,
        NSString(string: "~/.config/opencode/opencode.json").expandingTildeInPath,
        NSString(string: "~/.config/token-horizon/models-cache.json").expandingTildeInPath,
        NSString(string: "~/.config/token-horizon/settings.json").expandingTildeInPath
    ]

    private let monitoredDirectories: [String] = [
        NSString(string: "~/.codex").expandingTildeInPath,
        NSString(string: "~/.local/share/opencode").expandingTildeInPath,
        NSString(string: "~/.config/token-horizon").expandingTildeInPath
    ]

    private init() {}

    func start() {
        lock.lock()
        if isRunning {
            lock.unlock()
            return
        }
        isRunning = true
        lock.unlock()

        queue.async { [weak self] in
            guard let self else { return }
            self.setupDirectoryMonitors()
            self.setupTimers()
            // Perform initial scans
            _ = self.checkLocalFiles(force: true, reason: "startup")
            self.checkRemoteAPIs(force: false, reason: "startup")
        }
    }

    func stop() {
        lock.lock()
        guard isRunning else {
            lock.unlock()
            return
        }
        isRunning = false
        lock.unlock()

        queue.async { [weak self] in
            guard let self else { return }
            self.localTimer?.cancel()
            self.localTimer = nil
            self.remoteTimer?.cancel()
            self.remoteTimer = nil

            for source in self.fileSystemSources {
                source.cancel()
            }
            self.fileSystemSources.removeAll()

            for fd in self.openDescriptors {
                close(fd)
            }
            self.openDescriptors.removeAll()
        }
    }

    private func setupTimers() {
        // 1. Fast local file attribute check every 5 seconds
        let lt = DispatchSource.makeTimerSource(queue: queue)
        lt.schedule(deadline: .now() + 5.0, repeating: 5.0, leeway: .milliseconds(500))
        lt.setEventHandler { [weak self] in
            _ = self?.checkLocalFiles(force: false, reason: "timer_5s")
        }
        lt.resume()
        self.localTimer = lt

        // 2. Remote provider & catalog check every 300 seconds (5 min)
        let rt = DispatchSource.makeTimerSource(queue: queue)
        rt.schedule(deadline: .now() + 60.0, repeating: 300.0, leeway: .seconds(5))
        rt.setEventHandler { [weak self] in
            self?.checkRemoteAPIs(force: false, reason: "timer_300s")
        }
        rt.resume()
        self.remoteTimer = rt
    }

    private func setupDirectoryMonitors() {
        for dir in monitoredDirectories {
            guard FileManager.default.fileExists(atPath: dir) else { continue }
            let fd = open(dir, O_EVTONLY)
            guard fd >= 0 else { continue }
            openDescriptors.append(fd)

            let source = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd,
                eventMask: [.write, .extend, .attrib, .link],
                queue: queue
            )
            source.setEventHandler { [weak self] in
                self?.debounceDirectoryEvent(dir: dir)
            }
            source.setCancelHandler {
                close(fd)
            }
            source.resume()
            fileSystemSources.append(source)
        }
    }

    private func debounceDirectoryEvent(dir: String) {
        debounceWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            _ = self?.checkLocalFiles(force: false, reason: "fs_event:\(dir)")
        }
        debounceWorkItem = work
        queue.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    @discardableResult
    func checkLocalFiles(force: Bool = false, reason: String = "manual") -> (added: Int, updated: Int, addedModels: [String]) {
        var changed = force
        var currentStates: [String: FileState] = [:]

        for path in monitoredPaths {
            let exists = FileManager.default.fileExists(atPath: path)
            var mtime: Date? = nil
            var size: UInt64 = 0

            if exists, let attrs = try? FileManager.default.attributesOfItem(atPath: path) {
                mtime = attrs[.modificationDate] as? Date
                size = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
            }

            let state = FileState(path: path, exists: exists, mtime: mtime, size: size)
            currentStates[path] = state

            lock.lock()
            let old = trackedFiles[path]
            lock.unlock()

            if old == nil || old != state {
                changed = true
            }
        }

        lock.lock()
        trackedFiles = currentStates
        lastLocalScan = Date()
        scanCount += 1
        lock.unlock()

        guard changed else { return (0, 0, []) }

        // Perform ingestion of local caches & flagships
        let bm = ModelCatalog.loadBenchmarks()
        var map: [String: ModelCatalog.Entry] = [:]

        ModelCatalog.injectDirectFlagships(into: &map, benchmarks: bm)
        ModelCatalog.fetchCodexCachedModels(into: &map, benchmarks: bm)

        let result = ModelCatalog.shared.mergeDiscoveredEntries(map)

        if result.added > 0 || result.updated > 0 {
            lock.lock()
            totalDiscovered += result.added
            for id in result.addedIds {
                if !recentDiscovered.contains(id) {
                    recentDiscovered.insert(id, at: 0)
                }
            }
            if recentDiscovered.count > 20 {
                recentDiscovered = Array(recentDiscovered.prefix(20))
            }
            lock.unlock()
        }

        return (result.added, result.updated, result.addedIds)
    }

    func checkRemoteAPIs(force: Bool = false, reason: String = "manual") {
        let bm = ModelCatalog.loadBenchmarks()
        var map: [String: ModelCatalog.Entry] = [:]

        ModelCatalog.fetchLiveZaiModels(into: &map, benchmarks: bm)
        ModelCatalog.fetchLiveOpenAIModels(into: &map, benchmarks: bm)
        // No-auth DeepSeek pricing scrape runs every cycle so pricing updates
        // land within minutes; /models enumeration runs too when a key exists.
        ModelCatalog.fetchLiveDeepSeekModels(into: &map, benchmarks: bm)
        ModelCatalog.fetchLiveAnthropicModels(into: &map, benchmarks: bm)
        ModelCatalog.fetchLiveGeminiModels(into: &map, benchmarks: bm)
        ModelCatalog.fetchLiveOpenRouterModels(into: &map, benchmarks: bm)

        let result = ModelCatalog.shared.mergeDiscoveredEntries(map)

        lock.lock()
        lastRemoteScan = Date()
        if result.added > 0 {
            totalDiscovered += result.added
            for id in result.addedIds {
                if !recentDiscovered.contains(id) {
                    recentDiscovered.insert(id, at: 0)
                }
            }
            if recentDiscovered.count > 20 {
                recentDiscovered = Array(recentDiscovered.prefix(20))
            }
        }
        lock.unlock()

        // Fetch remote catalog if force or if last fetch is older than the
        // shared 10m freshness window (was 30m — pricing updates lagged).
        let lastFetch = ModelCatalog.shared.getLastFetchTime()
        if force || Date().timeIntervalSince(lastFetch) > ModelCatalog.remoteRefreshInterval {
            ModelCatalog.fetchAndMerge()
        }
    }

    func triggerScan(includeRemote: Bool = true) -> DiscoverySummary {
        var totalAdded = 0
        var totalUpdated = 0
        var newModels: [String] = []

        let sema = DispatchSemaphore(value: 0)
        queue.async { [weak self] in
            guard let self else {
                sema.signal()
                return
            }
            let local = self.checkLocalFiles(force: true, reason: "on_demand")
            totalAdded += local.added
            totalUpdated += local.updated
            newModels.append(contentsOf: local.addedModels)

            if includeRemote {
                self.checkRemoteAPIs(force: true, reason: "on_demand")
            }
            sema.signal()
        }

        _ = sema.wait(timeout: .now() + 30.0)

        return DiscoverySummary(
            timestamp: Date(),
            added: totalAdded,
            updated: totalUpdated,
            newModels: newModels,
            reason: includeRemote ? "full_scan" : "local_scan",
            catalogRevision: ModelCatalog.shared.currentRevision(),
            totalCatalogCount: ModelCatalog.shared.count
        )
    }

    func status() -> DiscoveryStatus {
        lock.lock()
        defer { lock.unlock() }

        let files: [DiscoveryStatus.FileStatus] = monitoredPaths.map { p in
            let st = trackedFiles[p]
            return DiscoveryStatus.FileStatus(
                path: p,
                exists: st?.exists ?? FileManager.default.fileExists(atPath: p),
                lastModified: st?.mtime,
                sizeBytes: st?.size ?? 0
            )
        }

        return DiscoveryStatus(
            isRunning: isRunning,
            lastLocalScan: lastLocalScan,
            lastRemoteScan: lastRemoteScan,
            scanCount: scanCount,
            totalDiscovered: totalDiscovered,
            recentDiscovered: recentDiscovered,
            monitoredFiles: files,
            catalogRevision: ModelCatalog.shared.currentRevision(),
            catalogCount: ModelCatalog.shared.count
        )
    }
}
