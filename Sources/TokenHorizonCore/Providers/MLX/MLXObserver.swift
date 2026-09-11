#if os(macOS)
import Foundation

public enum MLXObserver {
    /// Identify the command forms used by mlx-lm and Ollama's MLX runner.
    /// Delegates to MLXRuntime (single source of truth, cross-platform).
    public static func isMLXCommand(_ command: String) -> Bool {
        MLXRuntime.isMLXCommand(command)
    }

    public static func modelName(in command: String) -> String? {
        MLXRuntime.modelName(in: command)
    }
    /// Splits a ps command line into argv. Internal for hermetic unit tests.
    static func commandArguments(_ command: String) -> [String] {
        var arguments: [String] = []
        var current = ""
        var quote: Character?
        var escaped = false

        for character in command {
            if escaped {
                current.append(character)
                escaped = false
            } else if character == "\\" && quote != "'" {
                escaped = true
            } else if let activeQuote = quote {
                if character == activeQuote {
                    quote = nil
                } else {
                    current.append(character)
                }
            } else if character == "'" || character == "\"" {
                quote = character
            } else if character == " " || character == "\t" {
                if !current.isEmpty {
                    arguments.append(current)
                    current.removeAll(keepingCapacity: true)
                }
            } else {
                current.append(character)
            }
        }
        if escaped { current.append("\\") }
        if !current.isEmpty { arguments.append(current) }
        return arguments
    }

    public static func snapshot(from samples: [ProcSample], now: Date = Date()) -> MLXSnapshot {
        let marked = samples.filter { isMLXCommand($0.command) || isMLXCommand($0.name) }
        guard !marked.isEmpty else { return MLXSnapshot(sampledAt: now) }

        let byPid = Dictionary(uniqueKeysWithValues: samples.map { ($0.pid, $0) })
        var selectedPids = Set(marked.map(\ .pid))
        var changed = true
        while changed {
            changed = false
            for sample in samples where selectedPids.contains(sample.ppid) && !selectedPids.contains(sample.pid) {
                selectedPids.insert(sample.pid)
                changed = true
            }
        }

        func modelFor(_ sample: ProcSample) -> String? {
            var current: ProcSample? = sample
            var visited = Set<Int32>()
            while let candidate = current, visited.insert(candidate.pid).inserted {
                if let model = modelName(in: candidate.command) { return model }
                current = byPid[candidate.ppid]
            }
            return nil
        }

        let selected = samples.filter { sample in
            selectedPids.contains(sample.pid)
        }
        let processes = selected.map { sample in
            let model = modelFor(sample)
            let directModel = modelName(in: sample.command)
            let telemetryRate = directModel.flatMap { OllamaTelemetryStore.shared.recentTokPerSec(for: $0) }
            let benchmark = directModel.flatMap { OllamaClient.cachedBenchmark(for: $0) }
            let serverMetrics = MLXServerEndpoint.metricsURL(in: sample.command)
                .flatMap { MLXServerMetricsStore.shared.metrics(for: $0) }
            return MLXProcess(
                pid: sample.pid,
                ppid: sample.ppid,
                name: sample.name,
                command: sample.command,
                model: model,
                cpu: sample.cpu,
                memoryMB: sample.memMB,
                diskReadMBps: sample.diskReadMBps,
                diskWriteMBps: sample.diskWriteMBps,
                startTime: sample.startTime,
                tokPerSec: telemetryRate
                    ?? serverMetrics?.decodeTokPerSec
                    ?? benchmark?.tokPerSec,
                prefillTokPerSec: serverMetrics?.prefillTokPerSec ?? benchmark?.promptTokPerSec,
                ttftSeconds: serverMetrics?.ttftSeconds
            )
        }.sorted {
            if $0.cpu != $1.cpu { return $0.cpu > $1.cpu }
            return $0.pid < $1.pid
        }
        return MLXSnapshot(sampledAt: now, processes: processes)
    }
}

#endif // os(macOS)
