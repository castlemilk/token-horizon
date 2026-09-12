import Foundation

/// Meters the Anthropic Messages wire format (POST /v1/messages) — covers
/// Claude Code and anthropic-compatible endpoints (e.g. Kimi for Coding).
///
/// Streaming SSE anatomy:
///   message_start  → data.message.usage { input_tokens, cache_read_input_tokens,
///                     cache_creation_input_tokens }  (context fill at send time)
///   message_delta  → data.usage { output_tokens }    (final output count)
/// Non-streaming: plain JSON response with the same usage object.
open class AnthropicMeter: RequestMeter {
    public override func shouldMeter(method: String, path: String) -> Bool {
        // Anthropic-compatible bases carry prefixes: kimi is /coding/v1/messages,
        // zhipu is /api/anthropic/v1/messages — match the SUFFIX, not a prefix.
        let p = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        return method == "POST" && (p.hasSuffix("/v1/messages") || p.hasPrefix("/messages"))
    }

    /// Anthropic's `request-id` response header == the `requestId` field
    /// Claude Code transcripts persist — the strong cross-channel dedup key.
    public override func requestID(for exchange: MeteredExchange) -> String? {
        exchange.responseHeaders["request-id"]
    }

    /// The body `id` (msg_...) is the SECOND Anthropic id: pi-style harnesses
    /// persist it as `responseId`, so file annotations from those tools join
    /// on this value (claude code's own transcripts join on the header id).
    public override func requestIDAlt(for exchange: MeteredExchange) -> String? {
        if let obj = try? JSONSerialization.jsonObject(with: exchange.responseBody) as? [String: Any],
           let id = obj["id"] as? String { return id }
        guard let text = String(data: exchange.responseBody, encoding: .utf8),
              text.hasPrefix("event:") || text.hasPrefix("data:") else { return nil }
        for obj in sseObjects(text) {
            if obj["type"] as? String == "message_start",
               let message = obj["message"] as? [String: Any],
               let id = message["id"] as? String { return id }
        }
        return nil
    }

    /// Anthropic rate limits ride every response as
    /// `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`;
    /// reset is an RFC3339 timestamp (not a duration like OpenAI).
    public override func limitSnapshots(for exchange: MeteredExchange) -> [LimitSnapshot] {
        let h = exchange.responseHeaders
        var out: [LimitSnapshot] = []
        for kind in ["requests", "tokens"] {
            guard let limit = headerDouble(h, "anthropic-ratelimit-\(kind)-limit"),
                  let remaining = headerDouble(h, "anthropic-ratelimit-\(kind)-remaining"),
                  limit > 0 else { continue }
            let usedPercent = min(max((1 - remaining / limit) * 100, 0), 100)
            out.append(LimitSnapshot(
                recordedAt: exchange.completedAt,
                machineID: machineID,
                provider: vendor,
                accountID: accountID(for: exchange) ?? "",
                label: "\(kind) (wire)",
                usedPercent: usedPercent,
                resetsAt: QuotaParsers.parseISO(h["anthropic-ratelimit-\(kind)-reset"]),
                detail: "\(Int(remaining))/\(Int(limit)) remaining"))
        }
        return out
    }

    public override func model(for exchange: MeteredExchange) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: exchange.requestBody) as? [String: Any],
           let model = obj["model"] as? String {
            return model
        }
        return ""
    }

    /// Anthropic semantics: input_tokens EXCLUDE cache read/creation — the
    /// full context occupancy is the sum.
    public override func contextOccupancy(tokens: TokenBreakdown) -> Int? {
        tokens.input + tokens.cacheRead + tokens.cacheWrite
    }

    public override func usage(from exchange: MeteredExchange) -> TokenBreakdown? {
        if let text = String(data: exchange.responseBody, encoding: .utf8),
           text.hasPrefix("event:") || text.hasPrefix("data:") {
            return usageFromSSE(text)
        }
        if let obj = try? JSONSerialization.jsonObject(with: exchange.responseBody) as? [String: Any],
           let usage = obj["usage"] as? [String: Any] {
            return parseUsage(usage, into: TokenBreakdown())
        }
        return nil
    }

    private func usageFromSSE(_ text: String) -> TokenBreakdown? {
        var breakdown = TokenBreakdown()
        var sawUsage = false
        for obj in sseObjects(text) {
            guard let type = obj["type"] as? String else { continue }
            switch type {
            case "message_start":
                if let message = obj["message"] as? [String: Any],
                   let usage = message["usage"] as? [String: Any] {
                    breakdown = parseUsage(usage, into: breakdown)
                    sawUsage = true
                }
            case "message_delta":
                if let usage = obj["usage"] as? [String: Any] {
                    // output_tokens here is the cumulative final count.
                    if let out = (usage["output_tokens"] as? NSNumber)?.intValue {
                        breakdown.output = out
                        sawUsage = true
                    }
                }
            default:
                continue
            }
        }
        return sawUsage ? breakdown : nil
    }

    private func parseUsage(_ usage: [String: Any], into b: TokenBreakdown) -> TokenBreakdown {
        func int(_ key: String) -> Int { (usage[key] as? NSNumber)?.intValue ?? 0 }
        var out = b
        if let v = (usage["input_tokens"] as? NSNumber)?.intValue { out.input = v }
        if let v = (usage["output_tokens"] as? NSNumber)?.intValue { out.output = v }
        out.cacheRead = int("cache_read_input_tokens")
        out.cacheWrite = int("cache_creation_input_tokens")
        return out
    }

    /// Anthropic: `thinking: {"type": "enabled", "budget_tokens": N}` — the
    /// level is a token BUDGET, so we band it (off/low/medium/high).
    public override func thinkingLevel(for exchange: MeteredExchange) -> (level: String, raw: String)? {
        guard let obj = try? JSONSerialization.jsonObject(with: exchange.requestBody) as? [String: Any],
              let thinking = obj["thinking"] as? [String: Any],
              let type = thinking["type"] as? String else { return nil }
        guard type == "enabled" else { return ("off", "type:\(type)") }
        let budget = (thinking["budget_tokens"] as? NSNumber)?.intValue ?? 0
        let level: String
        switch budget {
        case ..<1: level = "adaptive"
        case ..<4_000: level = "low"
        case ..<16_000: level = "medium"
        default: level = "high"
        }
        return (level, "budget_tokens:\(budget)")
    }
}
