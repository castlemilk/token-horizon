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

    /// Gemini semantics: promptTokenCount includes cached tokens.
    public override func contextOccupancy(tokens: TokenBreakdown) -> Int? {
        tokens.input
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
        func int(_ key: String) -> Int { (meta[key] as? NSNumber)?.intValue ?? 0 }
        return TokenBreakdown(
            input: int("promptTokenCount"),
            output: int("candidatesTokenCount"),
            reasoning: int("thoughtsTokenCount"),
            cacheRead: int("cachedContentTokenCount"))
    }

    /// Gemini: `generationConfig.thinkingConfig.thinkingBudget` — 0 = off,
    /// -1 = dynamic (adaptive), positive = token budget (banded).
    public override func thinkingLevel(for exchange: MeteredExchange) -> (level: String, raw: String)? {
        guard let obj = try? JSONSerialization.jsonObject(with: exchange.requestBody) as? [String: Any],
              let config = obj["generationConfig"] as? [String: Any],
              let thinking = config["thinkingConfig"] as? [String: Any] else { return nil }
        guard let budget = (thinking["thinkingBudget"] as? NSNumber)?.intValue else { return nil }
        let level: String
        switch budget {
        case 0: level = "off"
        case -1: level = "adaptive"
        case ..<4_000: level = "low"
        case ..<16_000: level = "medium"
        default: level = "high"
        }
        return (level, "thinkingBudget:\(budget)")
    }

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
