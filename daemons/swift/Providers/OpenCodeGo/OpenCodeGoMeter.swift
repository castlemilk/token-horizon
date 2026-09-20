import Foundation

/// Meter for the opencode-go point relay (loopback :9245 → opencode.ai).
///
/// opencode sends no User-Agent, so header sniffing yields nothing. This
/// meter is single-purpose — only opencode-routed clients ever arrive here —
/// so an unattributed exchange defaults to product "opencode" (stored as
/// .headerSniffed, still outranked by explicit labels and file records).
public final class OpenCodeGoMeter: OpenAICompatibleMeter {
    public override func productAttribution(for exchange: MeteredExchange) -> (product: String, source: ProductSource)? {
        if let found = super.productAttribution(for: exchange) { return found }
        return ("opencode", .headerSniffed)
    }
}
