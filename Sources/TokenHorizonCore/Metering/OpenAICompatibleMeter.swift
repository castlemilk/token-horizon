import Foundation

/// Meters the OpenAI wire formats — one implementation covers OpenAI itself
/// plus every OpenAI-compatible server (vLLM, SGLang, llama.cpp, LiteLLM,
/// OpenRouter, DeepSeek, Zhipu, MiniMax, Alibaba compatible-mode, ...).
/// That is the point of the base class: vendor and runtime implementations
/// differ only in parsing.
///
/// Chat completions: POST /v1/chat/completions { "model": ..., "stream": ... }
///   → JSON { "usage": {...} }  or  SSE chunks whose final chunk carries
///     "usage" (stream_options.include_usage).
/// Responses API (Codex CLI): POST /v1/responses
///   → SSE `response.completed` event (data.response.usage) or final JSON
///     { "usage": { input_tokens, output_tokens, *_details } }.
open class OpenAICompatibleMeter: RequestMeter {
    /// Extra path prefixes to meter (defaults cover chat + legacy completions
    /// + the Responses API).
    open var meteredPathPrefixes: [String] {
        ["/v1/chat/completions", "/v1/completions", "/chat/completions", "/completions",
         "/v1/responses", "/responses", "/backend-api/codex/responses"]
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

    /// SSE stream: usage rides a `response.completed` event (Responses API)
    /// or the final `data:` chunk (chat completions with include_usage;
    /// vLLM/SGLang always send it).
    private func usageFromSSE(_ body: Data) -> TokenBreakdown? {
        guard let text = String(data: body, encoding: .utf8), text.hasPrefix("data:") else { return nil }
        var found: TokenBreakdown?
        for line in text.components(separatedBy: "\n") {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard payload != "[DONE]",
                  let data = payload.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if let usage = obj["usage"] as? [String: Any] {
                found = parseUsageDict(usage)
            } else if let response = obj["response"] as? [String: Any],
                      let usage = response["usage"] as? [String: Any] {
                found = parseUsageDict(usage)
            }
        }
        return found
    }

    private func parseUsageDict(_ usage: [String: Any]) -> TokenBreakdown {
        func int(_ dict: [String: Any], _ key: String) -> Int {
            (dict[key] as? NSNumber)?.intValue ?? 0
        }
        // Chat completions names; Responses API names fall back.
        var b = TokenBreakdown(
            input: int(usage, "prompt_tokens") + int(usage, "input_tokens"),
            output: int(usage, "completion_tokens") + int(usage, "output_tokens"))
        if let details = usage["completion_tokens_details"] as? [String: Any] {
            b.reasoning += int(details, "reasoning_tokens")
        }
        if let details = usage["output_tokens_details"] as? [String: Any] {
            b.reasoning += int(details, "reasoning_tokens")
        }
        if let details = usage["prompt_tokens_details"] as? [String: Any] {
            b.cacheRead += int(details, "cached_tokens")
        }
        if let details = usage["input_tokens_details"] as? [String: Any] {
            b.cacheRead += int(details, "cached_tokens")
        }
        return b
    }

    /// OpenAI: `reasoning_effort: "low|medium|high"` (chat) or
    /// `reasoning: {effort: ...}` (Responses API). Absent = model default.
    public override func thinkingLevel(for exchange: MeteredExchange) -> (level: String, raw: String)? {
        guard let obj = try? JSONSerialization.jsonObject(with: exchange.requestBody) as? [String: Any] else { return nil }
        if let effort = obj["reasoning_effort"] as? String {
            return (normalizeEffort(effort), "reasoning_effort:\(effort)")
        }
        if let reasoning = obj["reasoning"] as? [String: Any],
           let effort = reasoning["effort"] as? String {
            return (normalizeEffort(effort), "reasoning.effort:\(effort)")
        }
        return nil
    }

    func normalizeEffort(_ effort: String) -> String {
        switch effort.lowercased() {
        case "none", "minimal", "off": return "off"
        case "low": return "low"
        case "medium": return "medium"
        case "high", "max": return "high"
        case "auto": return "adaptive"
        default: return effort.lowercased()
        }
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
