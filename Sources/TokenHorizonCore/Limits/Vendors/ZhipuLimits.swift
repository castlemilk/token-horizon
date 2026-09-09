import Foundation

/// Zhipu AI (GLM Coding Plan).
/// GET https://api.z.ai/api/monitor/usage/quota/limit
/// { data: { limits: [{ type, unit, number, percentage, remaining, nextResetTime, ... }], level } }
/// Auth: opencode auth.json keys "zai-coding-plan" / "zai".
public final class ZhipuLimits: VendorLimitsAdapter {
    public init() { super.init(provider: "glm") }

    public override func fetch() -> [ProviderLimit] {
        let keys = Self.opencodeAuthKeys()
        guard let key = keys["zai-coding-plan"] ?? keys["zai"] else { return [] }
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

            let resetsAt = epochMS(limit["nextResetTime"])
            return ProviderLimit(provider: "glm",
                                 label: label,
                                 usedPercent: min(max(pct, 0), 100),
                                 resetsAt: resetsAt,
                                 detail: detail)
        }
    }
}
