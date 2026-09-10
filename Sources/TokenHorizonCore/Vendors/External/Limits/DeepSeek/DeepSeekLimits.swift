import Foundation

/// DeepSeek Platform balance.
/// GET https://api.deepseek.com/user/balance
/// Auth: opencode auth.json key "deepseek" or DEEPSEEK_API_KEY env.
public final class DeepSeekLimits: VendorLimitsAdapter {
    public init() { super.init(provider: "deepseek") }

    public override var auth: VendorAuth {
        VendorAuth(sources: [.opencodeKey("deepseek"), .env("DEEPSEEK_API_KEY")])
    }

    public override func fetch() -> [ProviderLimit] {
        guard let key = auth.resolve(), !key.isEmpty else { return [] }
        guard let obj = getJSON(url: "https://api.deepseek.com/user/balance", key: key),
              let isAvail = obj["is_available"] as? Bool, isAvail,
              let infos = obj["balance_infos"] as? [[String: Any]],
              let first = infos.first else { return [] }
        let total = (first["total_balance"] as? String) ?? (first["total_balance"] as? NSNumber)?.stringValue ?? ""
        let curr = (first["currency"] as? String) ?? "USD"
        return [
            limit(label: "balance", usedPercent: 0, detail: "$\(total) \(curr)")
        ]
    }
}
