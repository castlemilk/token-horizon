import Foundation

/// Zhipu AI (GLM Coding Plan).
/// GET https://api.z.ai/api/monitor/usage/quota/limit
/// { data: { limits: [{ type, unit, number, percentage, remaining, nextResetTime, ... }], level } }
/// Auth: opencode auth.json keys "zai-coding-plan" / "zai".
public final class ZhipuLimits: VendorLimitsAdapter {
    public init() { super.init(provider: "glm") }

    public override var auth: VendorAuth {
        VendorAuth(sources: [.opencodeKey("zai-coding-plan"), .opencodeKey("zai")])
    }

    public override func fetch() -> [ProviderLimit] {
        guard let key = auth.resolve() else { return [] }
        guard let obj = getJSON(url: "https://api.z.ai/api/monitor/usage/quota/limit", key: key),
              let data = obj["data"] as? [String: Any],
              let limits = data["limits"] as? [[String: Any]] else { return [] }
        return limits.compactMap { limit in
            guard let pct = (limit["percentage"] as? NSNumber)?.doubleValue else { return nil }
            let type = limit["type"] as? String ?? "quota"
            let unit = (limit["unit"] as? NSNumber)?.intValue ?? 0
            let number = (limit["number"] as? NSNumber)?.intValue ?? 1

            let label: String
            switch (type, unit) {
            case ("TOKENS_LIMIT", 3):
                label = "\(number)h"
            case ("TOKENS_LIMIT", 6):
                label = number > 1 ? "\(number)mo" : "monthly"
            case ("TOKENS_LIMIT", 5):
                label = number > 1 ? "\(number)w" : "weekly"
            case ("TOKENS_LIMIT", 4):
                label = number > 1 ? "\(number)d" : "daily"
            case ("TIME_LIMIT", _):
                label = "search"
            default:
                label = type.replacingOccurrences(of: "_LIMIT", with: "").lowercased()
            }

            var detail = ""
            if let remaining = (limit["remaining"] as? NSNumber)?.doubleValue {
                detail = String(format: "%.0f left", remaining)
            }

            let resetsAt = epoch(limit["nextResetTime"])
            return self.limit(label: label, usedPercent: pct, resetsAt: resetsAt, detail: detail)
        }
    }
}
