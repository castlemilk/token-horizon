import Foundation

/// Meters the Gemini generateContent wire format — covers the Gemini API
/// (and any Google-compatible gateway):
///   POST /v1beta/models/<model>:generateContent          (JSON response)
///   POST /v1beta/models/<model>:streamGenerateContent    (SSE, usageMetadata
///                                                        rides the final chunk)
/// The model is in the PATH, not the request body.
open class GeminiMeter: RequestMeter {
    public override func shouldMeter(method: String, path: String) -> Bool {
        method == "POST" && (path.contains(":generateContent") || path.contains(":streamGenerateContent"))
    }

    public override func model(for exchange: MeteredExchange) -> String {
        // /v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse
        guard let modelsRange = exchange.path.range(of: "/models/") else { return "" }
        let rest = exchange.path[modelsRange.upperBound...]
        guard let colon = rest.firstIndex(of: ":") else { return "" }
        return String(rest[..<colon])
    }

    /// Gemini semantics: promptTokenCount includes cached tokens. Storage
    /// is NET (input excludes cacheRead — see GeminiUsage), so the gross
    /// occupancy is net input PLUS the cached share.
    public override func contextOccupancy(tokens: TokenBreakdown) -> Int? {
        tokens.input + tokens.cacheRead
    }

    public override func usage(from exchange: MeteredExchange) -> TokenBreakdown? {
        if let text = String(data: exchange.responseBody, encoding: .utf8),
           text.hasPrefix("data:") {
            return usageFromSSE(text)
        }
        if let obj = try? JSONSerialization.jsonObject(with: exchange.responseBody) as? [String: Any] {
            return usageFromObject(obj)
        }
        return nil
    }

    private func usageFromSSE(_ text: String) -> TokenBreakdown? {
        var found: TokenBreakdown?
        for obj in sseObjects(text) {
            if let usage = usageFromObject(obj) { found = usage }
        }
        return found
    }

    private func usageFromObject(_ obj: [String: Any]) -> TokenBreakdown? {
        guard let meta = obj["usageMetadata"] as? [String: Any] else { return nil }
        return GeminiUsage.breakdown(from: meta)
    }

    /// Gemini: `generationConfig.thinkingConfig.thinkingBudget` — 0 = off,
    /// -1 = dynamic (adaptive), positive = token budget (banded).
    public override func thinkingLevel(for exchange: MeteredExchange) -> (level: String, raw: String)? {
        guard let obj = try? JSONSerialization.jsonObject(with: exchange.requestBody) as? [String: Any],
              let config = obj["generationConfig"] as? [String: Any],
              let thinking = config["thinkingConfig"] as? [String: Any] else { return nil }
        guard let budget = (thinking["thinkingBudget"] as? NSNumber)?.intValue else { return nil }
        return (ThinkingBands.level(forBudget: budget, zero: .off), "thinkingBudget:\(budget)")
    }
}
