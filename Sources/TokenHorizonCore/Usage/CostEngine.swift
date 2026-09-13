import Foundation

/// Per-request cost attribution.
///
/// The same vendor×model can cost differently depending on the plan the
/// account is on and the tooling the request flowed through:
/// - subscription/coding-plan vendors (kimi, glm, minimax, alibaba token
///   plan, opencode go) have ZERO marginal per-request cost — consumption is
///   bounded by quota windows, which the limits channel tracks. Charging
///   list prices on top would double-count.
/// - API-billed vendors are priced from the ModelCatalog (cache-read aware).
/// - when the tool's own file record later joins by request id and carries a
///   provider-REPORTED cost (pi, opencode), that value overrides whatever
///   was decided here (`CostSource.reported` in the file-annotation sweep).
public enum CostEngine {

    /// Canonical vendors whose meter endpoints are plan-gated subscriptions:
    /// marginal cost per request is 0, quota is the ceiling. Data-driven —
    /// extend here as plan vendors are added.
    public static let planVendors: Set<String> = [
        "kimi", "glm", "minimax", "alibaba", "opencode",
    ]

    /// Self-managed runtimes: inference is local, marginal cost is 0
    /// (bounded by hardware, not by a bill).
    public static let localComputeVendors: Set<String> = [
        "ollama", "vllm", "sglang", "llamacpp", "mlx",
    ]

    public static func decide(vendor: String, model: String,
                              tokens: TokenBreakdown) -> (cost: Double, source: CostSource) {
        let v = Canonical.vendor(vendor)
        if planVendors.contains(v) || localComputeVendors.contains(v) { return (0, .planFree) }
        let canonicalModel = Canonical.model(vendor: v, model: model)
        if let entry = ModelCatalog.shared.lookup(id: canonicalModel)
            ?? ModelCatalog.shared.lookup(id: model) {
            return (price(tokens: tokens, entry: entry), .computed)
        }
        return (0, .unknown)
    }

    /// Catalog pricing: input/output at list rates plus the cache-read rate
    /// when the catalog carries one. Cache-write is priced as input (vendor
    /// surcharges on cache creation are not yet modeled). MUST stay in
    /// lockstep with SQLiteUsageStore.costEquivalentSQL — the read-side
    /// equivalent cost applies the same rates to the same breakdown, so
    /// API-billed rows show charged cost == list-price equivalent.
    public static func price(tokens: TokenBreakdown, entry: ModelCatalog.Entry) -> Double {
        var usd = (Double(tokens.input + tokens.cacheWrite) * entry.inputPerM
                 + Double(tokens.output) * entry.outputPerM) / 1_000_000
        if let cacheRate = entry.cacheReadPerM {
            usd += Double(tokens.cacheRead) * cacheRate / 1_000_000
        }
        return usd
    }
}
