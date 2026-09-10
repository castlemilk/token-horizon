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
        method == "POST" && (path.hasPrefix("/v1/messages") || path.hasPrefix("/messages"))
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
        for line in text.components(separatedBy: "\n") {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard let data = payload.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = obj["type"] as? String else { continue }
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

    /// Cost from the built-in catalog pricing (incl. cache-read rate).
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
