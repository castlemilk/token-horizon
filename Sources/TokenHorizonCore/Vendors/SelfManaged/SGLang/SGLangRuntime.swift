import Foundation

/// SGLang — default port 30000.
/// Counters: sglang:prompt_tokens_total, sglang:generation_tokens_total.
/// Extras: queue + cache gauges.
public final class SGLangRuntime: LocalInferenceRuntime {
    public init() {
        super.init(vendor: "sglang", displayName: "SGLang",
                   defaultPorts: [30000, 30001],
                   processSignatures: ["sglang"])
    }

    public override var promptCounterNames: [String] { ["sglang:prompt_tokens_total"] }
    public override var generationCounterNames: [String] { ["sglang:generation_tokens_total"] }
    public override var extraMetricNames: [String] {
        ["sglang:num_running_reqs", "sglang:num_queue_reqs", "sglang:cache_hit_rate"]
    }
}
