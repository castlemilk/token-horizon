import Foundation

/// Meters the OpenAI chat/completions wire format — one implementation covers
/// OpenAI itself plus every OpenAI-compatible server (vLLM, SGLang, llama.cpp,
/// LiteLLM, OpenRouter, ...). That is the point of the base class: vendor and
/// runtime implementations differ only in parsing.
///
/// Request:  POST /v1/chat/completions { "model": ..., "stream": ... }
/// Response: JSON { "usage": {...} }  or  SSE `data:` chunks whose final
///           chunk carries `"usage"` (stream_options.include_usage).
open class OpenAICompatibleMeter: RequestMeter {
    /// Extra path prefixes to meter (defaults cover chat + legacy completions).
    open var meteredPathPrefixes: [String] {
        ["/v1/chat/completions", "/v1/completions", "/chat/completions", "/completions"]
    }

    public override func shouldMeter(method: String, path: String) -> Bool {
        method == "POST" && meteredPathPrefixes.contains { path.hasPrefix($0) }
    }

    public override func model(for exchange: MeteredExchange) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: exchange.requestBody) as? [String: Any],
           let model = obj["model"] as? String {
            return model
        }
        return ""
    }

    /// OpenAI semantics: prompt_tokens already include cached tokens.
    public override func contextOccupancy(tokens: TokenBreakdown) -> Int? {
        tokens.input
    }

    public override func usage(from exchange: MeteredExchange) -> TokenBreakdown? {
        if let usage = usageFromSSE(exchange.responseBody) ?? usageFromJSON(exchange.responseBody) {
            return usage
        }
        return nil
    }

    /// Whole-body JSON response (non-streaming).
    private func usageFromJSON(_ body: Data) -> TokenBreakdown? {
        guard let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let usage = obj["usage"] as? [String: Any] else { return nil }
        return parseUsageDict(usage)
    }

    /// SSE stream: usage rides the final `data:` chunk (requires
    /// stream_options.include_usage on OpenAI; vLLM/SGLang always send it).
    private func usageFromSSE(_ body: Data) -> TokenBreakdown? {
        guard let text = String(data: body, encoding: .utf8), text.hasPrefix("data:") else { return nil }
        var found: TokenBreakdown?
        for line in text.components(separatedBy: "\n") {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard payload != "[DONE]",
                  let data = payload.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let usage = obj["usage"] as? [String: Any] else { continue }
            found = parseUsageDict(usage)
        }
        return found
    }

    private func parseUsageDict(_ usage: [String: Any]) -> TokenBreakdown {
        func int(_ dict: [String: Any], _ key: String) -> Int {
            (dict[key] as? NSNumber)?.intValue ?? 0
        }
        var b = TokenBreakdown(
            input: int(usage, "prompt_tokens"),
            output: int(usage, "completion_tokens"))
        if let details = usage["completion_tokens_details"] as? [String: Any] {
            b.reasoning += int(details, "reasoning_tokens")
        }
        if let details = usage["prompt_tokens_details"] as? [String: Any] {
            b.cacheRead += int(details, "cached_tokens")
        }
        return b
    }

    /// Cost from the built-in catalog pricing when the model is known.
    public override func cost(for exchange: MeteredExchange, tokens: TokenBreakdown) -> Double {
        let model = model(for: exchange)
        guard let entry = ModelCatalog.shared.lookup(id: model) else { return 0 }
        var usd = (Double(tokens.input) * entry.inputPerM + Double(tokens.output) * entry.outputPerM) / 1_000_000
        if let cacheRate = entry.cacheReadPerM {
            usd += Double(tokens.cacheRead) * cacheRate / 1_000_000
        }
        return usd
    }
}
