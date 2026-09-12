import Foundation

/// Kimi speaks BOTH wire protocols depending on the client: pi/Kimi Code v2
/// call the Anthropic-compatible /coding/v1/messages (body id msg_…), while
/// the legacy kimi CLI and OpenAI-mode clients call /chat/completions (body
/// id chatcmpl-… — the id kimi session files persist as messageId). A single
/// meter must therefore dispatch parsing per request path; delegates do the
/// format-specific work.
public final class KimiMeter: RequestMeter {
    private let openai: OpenAICompatibleMeter
    private let anthropic: AnthropicMeter

    public override init(vendor: String, listenPort: UInt16, targetBase: URL,
                         store: UsageStoring? = nil, sourceKind: SourceKind = .external) {
        openai = OpenAICompatibleMeter(vendor: vendor, listenPort: listenPort,
                                       targetBase: targetBase, store: store, sourceKind: sourceKind)
        anthropic = AnthropicMeter(vendor: vendor, listenPort: listenPort,
                                   targetBase: targetBase, store: store, sourceKind: sourceKind)
        super.init(vendor: vendor, listenPort: listenPort, targetBase: targetBase,
                   store: store, sourceKind: sourceKind)
    }

    private func isAnthropic(_ rawPath: String) -> Bool {
        let p = rawPath.split(separator: "?", maxSplits: 1).first.map(String.init) ?? rawPath
        return p.hasSuffix("/v1/messages") || p.hasPrefix("/messages")
    }

    /// Kimi bases carry prefixes (/coding/v1/...) — match SUFFIXES.
    public override func shouldMeter(method: String, path: String) -> Bool {
        guard method == "POST" else { return false }
        let p = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        return p.hasSuffix("/v1/messages") || p.hasPrefix("/messages")
            || p.hasSuffix("/chat/completions") || p.hasSuffix("/completions")
            || p.hasSuffix("/responses")
    }

    public override func usage(from exchange: MeteredExchange) -> TokenBreakdown? {
        isAnthropic(exchange.path) ? anthropic.usage(from: exchange) : openai.usage(from: exchange)
    }

    public override func model(for exchange: MeteredExchange) -> String {
        isAnthropic(exchange.path) ? anthropic.model(for: exchange) : openai.model(for: exchange)
    }

    public override func requestID(for exchange: MeteredExchange) -> String? {
        isAnthropic(exchange.path) ? anthropic.requestID(for: exchange) : openai.requestID(for: exchange)
    }

    public override func requestIDAlt(for exchange: MeteredExchange) -> String? {
        isAnthropic(exchange.path) ? anthropic.requestIDAlt(for: exchange) : nil
    }

    /// Occupancy without path context: input + cacheWrite never double-counts
    /// either protocol (OpenAI input already includes cached tokens and its
    /// cacheWrite is 0; Anthropic input excludes cache and cacheWrite is the
    /// newly-written portion). cacheRead is excluded — it would inflate
    /// OpenAI-mode values.
    public override func contextOccupancy(tokens: TokenBreakdown) -> Int? {
        tokens.input + tokens.cacheWrite
    }

    public override func limitSnapshots(for exchange: MeteredExchange) -> [LimitSnapshot] {
        isAnthropic(exchange.path) ? anthropic.limitSnapshots(for: exchange)
                                   : openai.limitSnapshots(for: exchange)
    }
}
