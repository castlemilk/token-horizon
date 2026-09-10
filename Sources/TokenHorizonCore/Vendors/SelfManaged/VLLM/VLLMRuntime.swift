import Foundation

/// vLLM — default port 8000.
/// Counters: vllm:prompt_tokens_total, vllm:generation_tokens_total.
/// Extras: GPU KV-cache usage, running/waiting requests.
public final class VLLMRuntime: LocalInferenceRuntime {
    public init() {
        super.init(vendor: "vllm", displayName: "vLLM",
                   defaultPorts: [8000],
                   processSignatures: ["vllm"])
    }

    public override var promptCounterNames: [String] { ["vllm:prompt_tokens_total"] }
    public override var generationCounterNames: [String] { ["vllm:generation_tokens_total"] }
    public override var extraMetricNames: [String] {
        ["vllm:gpu_cache_usage_perc", "vllm:num_requests_running", "vllm:num_requests_waiting"]
    }
}
