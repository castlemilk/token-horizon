import Foundation

/// llama.cpp (llama-server) — default port 8080.
/// Counters: llamacpp:prompt_tokens_total, llamacpp:tokens_predicted_total.
/// Extras: requests processing/failed, KV-cache cells in use.
public final class LlamaCppRuntime: LocalInferenceRuntime {
    public init() {
        super.init(vendor: "llamacpp", displayName: "llama.cpp",
                   defaultPorts: [8080],
                   processSignatures: ["llama-server", "llamacpp", "llama.cpp"])
    }

    public override var promptCounterNames: [String] { ["llamacpp:prompt_tokens_total"] }
    public override var generationCounterNames: [String] { ["llamacpp:tokens_predicted_total"] }
    public override var extraMetricNames: [String] {
        ["llamacpp:requests_processing", "llamacpp:requests_deferred", "llamacpp:n_tokens_max"]
    }
}
