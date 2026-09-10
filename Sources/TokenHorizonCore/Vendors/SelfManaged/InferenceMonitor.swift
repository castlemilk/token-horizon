import Foundation

/// Polls all registered self-managed runtimes and derives measured throughput
/// from Prometheus counter deltas between polls. Bounded: one snapshot per
/// runtime, kept in memory only.
public final class InferenceMonitor {
    public static let shared = InferenceMonitor()

    /// Registered runtimes; append to add a vendor at runtime.
    public var runtimes: [LocalInferenceRuntime] = [
        VLLMRuntime(),
        SGLangRuntime(),
        LlamaCppRuntime(),
    ]

    private let lock = NSLock()
    private var snapshots: [String: RuntimeSnapshot] = [:]
    private var lastCounters: [String: (generation: Double, prompt: Double, time: Date)] = [:]
    private var timer: DispatchSourceTimer?

    public init() {}

    /// Latest snapshot per runtime vendor.
    public func current() -> [RuntimeSnapshot] {
        lock.lock(); defer { lock.unlock() }
        return snapshots.values.sorted { $0.vendor < $1.vendor }
    }

    /// One poll pass over all runtimes (blocks briefly on HTTP probes;
    /// call off-main).
    @discardableResult
    public func poll(now: Date = Date()) -> [RuntimeSnapshot] {
        var results: [RuntimeSnapshot] = []
        for runtime in runtimes {
            results.append(pollOne(runtime, now: now))
        }
        lock.lock()
        for snap in results { snapshots[snap.vendor] = snap }
        lock.unlock()
        return results
    }

    /// Start a repeating poll on a utility queue (default every 15s).
    public func startPolling(interval: TimeInterval = 15) {
        stopPolling()
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "tokenhorizon.inference", qos: .utility))
        timer.schedule(deadline: .now() + 1, repeating: interval)
        timer.setEventHandler { [weak self] in self?.poll() }
        timer.resume()
        self.timer = timer
    }

    public func stopPolling() {
        timer?.cancel()
        timer = nil
    }

    private func pollOne(_ runtime: LocalInferenceRuntime, now: Date) -> RuntimeSnapshot {
        let processes = runtime.detectProcesses()
        guard !processes.isEmpty else {
            lock.lock(); lastCounters[runtime.vendor] = nil; lock.unlock()
            return RuntimeSnapshot(vendor: runtime.vendor, displayName: runtime.displayName,
                                   running: false, sampledAt: now)
        }

        var snap = RuntimeSnapshot(vendor: runtime.vendor, displayName: runtime.displayName,
                                   running: true, pids: processes.map(\.pid), sampledAt: now)
        guard let port = runtime.activePort(),
              let text = runtime.fetchMetricsText(port: port) else {
            return snap // running but not scraping (yet)
        }
        let metrics = runtime.metrics(from: runtime.parsePrometheus(text))
        snap.port = port
        snap.generationTokensTotal = metrics.generationTokensTotal
        snap.promptTokensTotal = metrics.promptTokensTotal
        snap.extra = metrics.extra

        lock.lock()
        if let prev = lastCounters[runtime.vendor] {
            let dt = now.timeIntervalSince(prev.time)
            if dt > 0 {
                let genDelta = metrics.generationTokensTotal - prev.generation
                let promptDelta = metrics.promptTokensTotal - prev.prompt
                if genDelta >= 0 { snap.tokPerSec = genDelta / dt }
                if promptDelta >= 0 { snap.promptTokPerSec = promptDelta / dt }
            }
        }
        lastCounters[runtime.vendor] = (metrics.generationTokensTotal, metrics.promptTokensTotal, now)
        lock.unlock()
        return snap
    }
}
