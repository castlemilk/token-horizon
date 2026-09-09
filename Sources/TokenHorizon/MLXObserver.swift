import Foundation
import TokenHorizonCore

enum MLXObserver {
    /// Identify the command forms used by mlx-lm and Ollama's MLX runner.
    static func isMLXCommand(_ command: String) -> Bool {
        let value = command.lowercased()
        return value.contains("--mlx-engine")
            || value.contains("mlx_lm")
            || value.contains("mlx-lm")
            || value.contains("/mlx")
    }

    static func modelName(in command: String) -> String? {
        let parts = command.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        for index in parts.indices {
            if parts[index] == "--model" || parts[index] == "-m", parts.indices.contains(index + 1) {
                return parts[index + 1]
            }
            if parts[index].hasPrefix("--model=") {
                let value = String(parts[index].dropFirst("--model=".count))
                return value.isEmpty ? nil : value
            }
        }
        return nil
    }

    static func snapshot(from samples: [ProcSample], now: Date = Date()) -> MLXSnapshot {
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
            let telemetry = directModel.flatMap { OllamaTelemetryStore.shared.latest(for: $0) }
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
                tokPerSec: telemetry?.tokPerSec
                    ?? directModel.flatMap { OllamaClient.cachedBenchmark(for: $0)?.tokPerSec }
            )
        }.sorted {
            if $0.cpu != $1.cpu { return $0.cpu > $1.cpu }
            return $0.pid < $1.pid
        }
        return MLXSnapshot(sampledAt: now, processes: processes)
    }
}
