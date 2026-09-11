import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// MLX runtime (mlx-lm / mlx_lm.server, Apple Silicon). Same shape as every
/// other LocalInferenceRuntime — only the details differ:
/// - no Prometheus counters (like Ollama): usage truth comes from metering its
///   OpenAI-compatible endpoint; tok/s is per-request, never estimated.
/// - liveness via GET /v1/models (loaded-model names as workload, not tokens).
/// - process detection includes descendant processes of MLX roots + --model
///   attribution (shared helpers below; MLXObserver delegates to them).
/// The class itself is platform-neutral — probes simply fail where no MLX
/// server runs; CPU/MEM decoration comes from InferenceMonitor's ps pass.
public final class MLXRuntime: LocalInferenceRuntime {
    public init() {
        super.init(vendor: "mlx", displayName: "MLX",
                   defaultPorts: [8081],
                   processSignatures: ["mlx_lm", "mlx.server", "mlx-lm", "--mlx-engine"])
    }

    /// MLX serves no Prometheus series: no cumulative counters, no model labels.
    public override var promptCounterNames: [String] { [] }
    public override var generationCounterNames: [String] { [] }
    public override var modelLabelKeys: [String] { [] }

    /// Future file locations for MLX transcripts (none today; seam for the
    /// routine file poller — mirrors UsageEngine genericSources).
    public var logDirectories: [String] { [] }

    /// MLX serves an OpenAI-compatible API: usage truth is the request meter.
    public override func makeMeter(listenPort: UInt16, target: URL?, store: UsageStoring?) -> RequestMeter? {
        guard ConsentManager.shared.isGranted(.metering) else { return nil }
        let fallback = defaultPorts.first ?? 8081
        let upstream = target
            ?? configuredEndpoints.lazy.compactMap { URL(string: $0.url) }.first
            ?? URL(string: "http://127.0.0.1:\(activePort() ?? fallback)")!
        return OpenAICompatibleMeter(vendor: vendor, listenPort: listenPort, targetBase: upstream,
                                     store: store, sourceKind: .selfManaged)
    }

    /// Descendant-aware detection: match MLX roots, then include their children
    /// (server forks workers that don't carry the signature themselves).
    public override func detectProcesses() -> [ProcSample] {
        guard let stats = Platform.systemStats else { return [] }
        let all = stats.processSamples().all
        let roots = all.filter { isMLXProcess(command: $0.command, name: $0.name) }
        guard !roots.isEmpty else { return [] }
        let byPid = Dictionary(uniqueKeysWithValues: all.map { ($0.pid, $0) })
        var selected = Set(roots.map(\.pid))
        var changed = true
        while changed {
            changed = false
            for s in all where selected.contains(s.ppid) && !selected.contains(s.pid) {
                selected.insert(s.pid)
                changed = true
            }
        }
        _ = byPid
        return all.filter { selected.contains($0.pid) }
    }

    /// Model attribution: walk up the process tree for --model/-m.
    public func modelName(for sample: ProcSample, byPid: [Int32: ProcSample]) -> String? {
        var current: ProcSample? = sample
        var visited = Set<Int32>()
        while let c = current, visited.insert(c.pid).inserted {
            if let m = Self.modelName(in: c.command) { return m }
            current = byPid[c.ppid]
        }
        return nil
    }

    public func isMLXProcess(command: String, name: String) -> Bool {
        Self.isMLXCommand(command) || Self.isMLXCommand(name)
    }

    public static func isMLXCommand(_ command: String) -> Bool {
        let value = command.lowercased()
        return value.contains("--mlx-engine")
            || value.contains("mlx_lm")
            || value.contains("mlx-lm")
            || value.contains("/mlx")
    }

    public static func modelName(in command: String) -> String? {
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

    public override func probe() -> RuntimeProbe? {
        let bases = configuredEndpoints.compactMap { URL(string: $0.url) }
            + defaultPorts.compactMap { URL(string: "http://127.0.0.1:\($0)") }
        for base in bases {
            let req = URLRequest(url: base.appendingPathComponent("/v1/models"), timeoutInterval: 1.5)
            var result: Data?
            var ok = false
            let sema = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                    ok = true
                    result = data
                }
                sema.signal()
            }.resume()
            _ = sema.wait(timeout: .now() + 2.5)
            guard ok else { continue }
            var extra: [String: Double] = [:]
            if let result,
               let obj = try? JSONSerialization.jsonObject(with: result) as? [String: Any],
               let models = obj["data"] as? [[String: Any]] {
                extra["loaded_models"] = Double(models.count)
                for (i, m) in models.prefix(8).enumerated() {
                    if let id = m["id"] as? String, !id.isEmpty {
                        extra["loaded_model_\(i)_hash"] = Double(abs(id.hashValue % 1_000_000))
                    }
                }
            }
            return RuntimeProbe(url: base, extra: extra)
        }
        return nil
    }
}
                sema.signal()
            }.resume()
            _ = sema.wait(timeout: .now() + 2.5)
            guard ok else { continue }
            var extra: [String: Double] = [:]
            if let result,
               let obj = try? JSONSerialization.jsonObject(with: result) as? [String: Any],
               let models = obj["data"] as? [[String: Any]] {
                extra["loaded_models"] = Double(models.count)
            }
            return RuntimeProbe(url: base, extra: extra)
        }
        return nil
    }
}
