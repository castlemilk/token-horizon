import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Ollama runtime. No Prometheus endpoint and no cumulative token counters —
/// usage truth comes from the OllamaMeter (exact ns-duration rates); this
/// probe supplies WORKLOAD truth via the native API:
///   GET /api/ps      loaded models, RAM/VRAM footprint, CPU/GPU split
///   GET /api/version liveness fallback
/// HTTP-only by design: works for remote hosts, no process inspection.
public final class OllamaRuntime: LocalInferenceRuntime {
    public init() {
        super.init(vendor: "ollama", displayName: "Ollama",
                   defaultPorts: [11434], processSignatures: ["ollama serve"])
    }

    public override func probe() -> RuntimeProbe? {
        let bases = configuredEndpoints.compactMap { URL(string: $0.url) }
            + defaultPorts.compactMap { URL(string: "http://127.0.0.1:\($0)") }
        for base in bases {
            if let probe = probePS(base: base) { return probe }
            if httpOK(base.appendingPathComponent("/api/version")) {
                return RuntimeProbe(url: base)
            }
        }
        return nil
    }

    /// GET /api/ps → loaded model count + aggregate memory footprints.
    private func probePS(base: URL) -> RuntimeProbe? {
        guard let data = httpData(base.appendingPathComponent("/api/ps")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = obj["models"] as? [[String: Any]] else { return nil }
        var extra: [String: Double] = ["loaded_models": Double(models.count)]
        extra["loaded_size_bytes"] = models.reduce(0.0) {
            $0 + (($1["size"] as? NSNumber)?.doubleValue ?? 0)
        }
        extra["loaded_vram_bytes"] = models.reduce(0.0) {
            $0 + (($1["size_vram"] as? NSNumber)?.doubleValue ?? 0)
        }
        return RuntimeProbe(url: base, extra: extra)
    }

    private func httpOK(_ url: URL) -> Bool { httpData(url) != nil }

    private func httpData(_ url: URL) -> Data? {
        let req = URLRequest(url: url, timeoutInterval: 1.5)
        var result: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                result = data
            }
            sema.signal()
        }.resume()
        _ = sema.wait(timeout: .now() + 2.5)
        return result
    }
}
