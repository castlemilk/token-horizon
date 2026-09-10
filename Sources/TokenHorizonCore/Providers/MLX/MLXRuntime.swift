import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// MLX runtime (mlx-lm / mlx_lm.server, Apple Silicon). Like Ollama it has
/// no Prometheus counters: usage truth comes from metering its
/// OpenAI-compatible endpoint; this probe supplies liveness + loaded-model
/// workload via GET /v1/models. Local process CPU/MEM decoration comes from
/// InferenceMonitor's ps pass (macOS only in practice; the class itself is
/// platform-neutral — probes simply fail where no MLX server runs).
public final class MLXRuntime: LocalInferenceRuntime {
    public init() {
        super.init(vendor: "mlx", displayName: "MLX",
                   defaultPorts: [8080],
                   processSignatures: ["mlx_lm", "mlx.server", "mlx-lm"])
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
            }
            return RuntimeProbe(url: base, extra: extra)
        }
        return nil
    }
}
