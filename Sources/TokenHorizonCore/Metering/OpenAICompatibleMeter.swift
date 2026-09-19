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
    /// Path suffixes to meter (defaults cover chat + legacy completions
    /// + the Responses API). Suffixes, not prefixes: bases carry prefixes
    /// (/zen/v1/... for opencode, /coding/v1/... for kimi-style gateways),
    /// and meters are per-vendor loopback relays — only that vendor's
    /// clients ever arrive here, so suffixes can't over-match.
    open var meteredPathPrefixes: [String] {
        ["/v1/chat/completions", "/v1/completions", "/chat/completions", "/completions",
         "/v1/responses", "/responses", "/backend-api/codex/responses"]
    }

    public override func shouldMeter(method: String, path: String) -> Bool {
        guard method == "POST" else { return false }
        let p = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        return meteredPathPrefixes.contains { p.hasSuffix($0) }
    }

    public override func model(for exchange: MeteredExchange) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: exchange.requestBody) as? [String: Any],
           let model = obj["model"] as? String {
            return model
        }
        return ""
    }

    /// OpenAI semantics: prompt_tokens already include cached tokens.
    /// Storage is NET (input excludes cacheRead — see parseUsageDict), so
    /// the gross occupancy is net input PLUS the cached share.
    public override func contextOccupancy(tokens: TokenBreakdown) -> Int? {
        tokens.input + tokens.cacheRead
    }

    public override func usage(from exchange: MeteredExchange) -> TokenBreakdown? {
        if let usage = usageFromSSE(exchange.responseBody) ?? usageFromJSON(exchange.responseBody) {
            return usage
        }
        return nil
    }

    public override func requestID(for exchange: MeteredExchange) -> String? {
        // Non-streaming: top-level body id (chatcmpl-/resp-…). SSE: every
        // chunk repeats the same response id — first wins ("response" wrapper
        // for the Responses API). SSE bodies may start with `event:` (Zen)
        // or `data:` (OpenAI).
        if let obj = try? JSONSerialization.jsonObject(with: exchange.responseBody) as? [String: Any],
           let id = obj["id"] as? String { return id }
        guard let text = String(data: exchange.responseBody, encoding: .utf8),
              text.hasPrefix("data:") || text.hasPrefix("event:") else { return nil }
        for obj in sseObjects(text) {
            if let id = obj["id"] as? String { return id }
            if let resp = obj["response"] as? [String: Any], let id = resp["id"] as? String { return id }
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
    /// vLLM/SGLang always send it). Streams may start with `event:` (Zen
    /// emits `event:`/`data:` pairs plus `ping` events) or `data:`.
    private func usageFromSSE(_ body: Data) -> TokenBreakdown? {
        guard let text = String(data: body, encoding: .utf8),
              text.hasPrefix("data:") || text.hasPrefix("event:") else { return nil }
        var found: TokenBreakdown?
        for obj in sseObjects(text) {
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
        // Chat completions names vs Responses API names are ALTERNATE
        // spellings of the same counters (Zen may send either) — take the
        // max, never the sum, so a dual-spelled payload can't double-count.
        let grossInput = max(int(usage, "prompt_tokens"), int(usage, "input_tokens"))
        let grossOutput = max(int(usage, "completion_tokens"), int(usage, "output_tokens"))
        var reasoning = 0
        if let details = usage["completion_tokens_details"] as? [String: Any] {
            reasoning = max(reasoning, int(details, "reasoning_tokens"))
        }
        if let details = usage["output_tokens_details"] as? [String: Any] {
            reasoning = max(reasoning, int(details, "reasoning_tokens"))
        }
        var cacheRead = 0
        if let details = usage["prompt_tokens_details"] as? [String: Any] {
            cacheRead = max(cacheRead, int(details, "cached_tokens"))
        }
        if let details = usage["input_tokens_details"] as? [String: Any] {
            cacheRead = max(cacheRead, int(details, "cached_tokens"))
        }
        // TokenBreakdown stores NET figures (input excludes cache, output
        // excludes reasoning — see Models.swift): reasoning_tokens and
        // cached_tokens USUALLY arrive as subsets of the gross counters, so
        // subtract to avoid double-counting. But some gateway payloads are
        // already net (subset LARGER than gross, e.g. Zen tool-call steps) —
        // never subtract past zero into a loss: when the "subset" exceeds
        // gross, the counter was already net, keep it as-is.
        return TokenBreakdown(
            input: cacheRead <= grossInput ? grossInput - cacheRead : grossInput,
            output: reasoning <= grossOutput ? grossOutput - reasoning : grossOutput,
            reasoning: reasoning,
            cacheRead: cacheRead)
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
}
