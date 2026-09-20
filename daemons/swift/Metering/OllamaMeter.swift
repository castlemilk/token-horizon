import Foundation

/// Meters the Ollama native API (POST /api/chat, /api/generate). Responses
/// are NDJSON: one JSON object per line; the final line carries
///   { "done": true, "prompt_eval_count": N, "prompt_eval_duration": ns,
///     "eval_count": M, "eval_duration": ns }
/// Provider-reported nanosecond durations give EXACT rates — this meter
/// overrides `rates` to use them instead of wall-clock estimates.
open class OllamaMeter: RequestMeter {
    public var measuredPromptTps: Double?
    public var measuredGenerationTps: Double?

    public override func shouldMeter(method: String, path: String) -> Bool {
        method == "POST" && (path.hasPrefix("/api/chat") || path.hasPrefix("/api/generate"))
    }

    public override func model(for exchange: MeteredExchange) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: exchange.requestBody) as? [String: Any],
           let model = obj["model"] as? String {
            return model
        }
        // Fall back to the model echoed in the final NDJSON line.
        return finalObject(exchange.responseBody)?["model"] as? String ?? ""
    }

    /// Ollama: prompt_eval_count IS the full prompt (cache mechanics hidden).
    public override func contextOccupancy(tokens: TokenBreakdown) -> Int? {
        tokens.input
    }

    public override func usage(from exchange: MeteredExchange) -> TokenBreakdown? {
        guard let final = finalObject(exchange.responseBody) else { return nil }
        let input = (final["prompt_eval_count"] as? NSNumber)?.intValue ?? 0
        let output = (final["eval_count"] as? NSNumber)?.intValue ?? 0
        guard input > 0 || output > 0 else { return nil }
        return TokenBreakdown(input: input, output: output)
    }

    /// Exact provider-measured rates from nanosecond durations (pure — no I/O).
    public override func rates(from exchange: MeteredExchange, tokens: TokenBreakdown) -> (prompt: Double?, generation: Double?) {
        guard let final = finalObject(exchange.responseBody) else { return (nil, nil) }
        var prompt: Double?
        var generation: Double?
        if let count = (final["prompt_eval_count"] as? NSNumber)?.intValue,
           let ns = (final["prompt_eval_duration"] as? NSNumber)?.uint64Value,
           count > 0, ns > 0 {
            prompt = Double(count) / (Double(ns) / 1_000_000_000)
        }
        if let count = (final["eval_count"] as? NSNumber)?.intValue,
           let ns = (final["eval_duration"] as? NSNumber)?.uint64Value,
           count > 0, ns > 0 {
            generation = Double(count) / (Double(ns) / 1_000_000_000)
        }
        return (prompt, generation)
    }

    /// Bridge measured sample into telemetry store + OTel exactly once per
    /// completed request (called once from the connection teardown path).
    public override func event(from exchange: MeteredExchange) -> UsageEvent? {
        guard let event = super.event(from: exchange) else { return nil }
        if let final = finalObject(exchange.responseBody),
           let evalCount = (final["eval_count"] as? NSNumber)?.intValue,
           let evalNs = (final["eval_duration"] as? NSNumber)?.uint64Value,
           evalCount > 0, evalNs > 0 {
            let sample = InferenceTelemetrySample(
                model: event.model, completedAt: exchange.completedAt,
                evalCount: evalCount, evalDurationNs: evalNs,
                promptEvalCount: (final["prompt_eval_count"] as? NSNumber)?.intValue,
                promptEvalDurationNs: (final["prompt_eval_duration"] as? NSNumber)?.uint64Value)
            InferenceTelemetryStore.shared.record(sample)
            TokenHorizonTelemetry.shared.recordInference(sample, vendor: vendor)
        }
        return event
    }

    /// Ollama: `think` is bool OR a level string ("low"/"medium"/"high"),
    /// depending on model support.
    public override func thinkingLevel(for exchange: MeteredExchange) -> (level: String, raw: String)? {
        guard let obj = try? JSONSerialization.jsonObject(with: exchange.requestBody) as? [String: Any],
              let think = obj["think"] else { return nil }
        if let flag = think as? Bool {
            return (flag ? "adaptive" : "off", "think:\(flag)")
        }
        if let level = think as? String {
            return (level.lowercased(), "think:\(level)")
        }
        return nil
    }

    /// Last non-empty NDJSON line as an object.
    private func finalObject(_ body: Data) -> [String: Any]? {
        guard let text = String(data: body, encoding: .utf8) else { return nil }
        for line in text.components(separatedBy: "\n").reversed() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            return obj
        }
        return nil
    }
}
