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
    private var lastModelCounters: [String: (prompt: Double, generation: Double)] = [:]
    private var timer: DispatchSourceTimer?

    /// Durable usage ledger receiving measured counter deltas. Replaceable in tests.
    public var ledger: RuntimeUsageLedger = .shared

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
            lock.lock()
            lastCounters[runtime.vendor] = nil
            for key in lastModelCounters.keys where key.hasPrefix("\(runtime.vendor)|") {
                lastModelCounters[key] = nil
            }
            lock.unlock()
            return RuntimeSnapshot(vendor: runtime.vendor, displayName: runtime.displayName,
                                   running: false, sampledAt: now)
        }

        var snap = RuntimeSnapshot(vendor: runtime.vendor, displayName: runtime.displayName,
                                   running: true, pids: processes.map(\.pid), sampledAt: now)
        guard let metricsURL = runtime.activeMetricsURL(),
              let text = runtime.fetchMetricsText(url: metricsURL) else {
            return snap // running but not scraping (yet)
        }
        var metrics = runtime.metrics(from: runtime.parsePrometheus(text))
        metrics.perModel = runtime.parsePrometheusPerModel(text)
        snap.port = metricsURL.port
        snap.generationTokensTotal = metrics.generationTokensTotal
        snap.promptTokensTotal = metrics.promptTokensTotal
        snap.extra = metrics.extra

        // Measured deltas only: first sighting establishes a baseline (no
        // backfill); a counter decrease means the server restarted, so the
        // current reading is the delta since restart.
        func measuredDelta(_ cur: Double, _ prev: Double?) -> Int {
            guard let prev else { return 0 }
            let d = cur - prev
            return d >= 0 ? Int(d.rounded()) : Int(cur.rounded())
        }

        lock.lock()
        let prev = lastCounters[runtime.vendor]
        if let prev {
            let dt = now.timeIntervalSince(prev.time)
            if dt > 0 {
                let genDelta = metrics.generationTokensTotal - prev.generation
                let promptDelta = metrics.promptTokensTotal - prev.prompt
                if genDelta >= 0 { snap.tokPerSec = genDelta / dt }
                if promptDelta >= 0 { snap.promptTokPerSec = promptDelta / dt }
            }
        }
        lastCounters[runtime.vendor] = (metrics.generationTokensTotal, metrics.promptTokensTotal, now)

        // Feed the durable usage ledger (provider-parity usage data).
        let inputDelta = measuredDelta(metrics.promptTokensTotal, prev?.prompt)
        let outputDelta = measuredDelta(metrics.generationTokensTotal, prev?.generation)
        if inputDelta > 0 || outputDelta > 0 {
            ledger.record(vendor: runtime.vendor, input: inputDelta, output: outputDelta, at: now)
        }
        for (model, counts) in metrics.perModel {
            let key = "\(runtime.vendor)|\(model)"
            let prevModel = lastModelCounters[key]
            let mIn = measuredDelta(counts.prompt, prevModel?.prompt)
            let mOut = measuredDelta(counts.generation, prevModel?.generation)
            if mIn > 0 || mOut > 0 {
                ledger.record(vendor: runtime.vendor, model: model, input: mIn, output: mOut, at: now)
            }
            lastModelCounters[key] = counts
        }
        // Drop per-model baselines for models that disappeared (server restart
        // with a different model) so a returning model is treated as reset.
        for key in lastModelCounters.keys where key.hasPrefix("\(runtime.vendor)|") {
            let model = String(key.dropFirst(runtime.vendor.count + 1))
            if metrics.perModel[model] == nil { lastModelCounters[key] = nil }
        }
        lock.unlock()
        return snap
    }
}
