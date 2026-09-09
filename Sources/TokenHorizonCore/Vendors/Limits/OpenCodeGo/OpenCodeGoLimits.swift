import Foundation

/// OpenCode Go (Zen).
/// GET https://opencode.ai/zen/go/v1/usage
/// { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
/// Auth: opencode auth.json key "opencode-go".
public final class OpenCodeGoLimits: VendorLimitsAdapter {
    public init() { super.init(provider: "opencode-go") }

    public override func fetch() -> [ProviderLimit] {
        let keys = Self.opencodeAuthKeys()
        guard let key = keys["opencode-go"] else { return [] }
        guard let obj = getJSON(url: "https://opencode.ai/zen/go/v1/usage", key: key),
              let usage = obj["usage"] as? [String: Any] else { return [] }
        var out: [ProviderLimit] = []
        for (window, metric) in usage.sorted(by: { $0.key < $1.key }) {
            guard let m = metric as? [String: Any],
                  let pct = (m["percent"] as? NSNumber)?.doubleValue else { continue }
            let status = m["status"] as? String
            out.append(ProviderLimit(provider: "opencode-go",
                                     label: window,
                                     usedPercent: min(max(pct, 0), 100),
                                     resetsAt: parseISO(m["resetsAt"] as? String),
                                     detail: status == "rate-limited" ? "rate-limited" : ""))
        }
        return out
    }
}
