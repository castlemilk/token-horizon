import Foundation

/// MiniMax Token Plan.
/// GET https://www.minimax.io/v1/token_plan/remains
/// { model_remains: [{ current_interval_remaining_percent, end_time,
///                     current_weekly_remaining_percent, weekly_end_time }] }
/// Auth: opencode auth.json key "minimax-coding-plan".
public final class MiniMaxLimits: VendorLimitsAdapter {
    public init() { super.init(provider: "minimax") }

    public override var meterTarget: URL? { URL(string: "https://api.minimax.io") }

    public override var auth: VendorAuth {
        VendorAuth(sources: [.opencodeKey("minimax-coding-plan")])
    }

    public override func fetch() -> [ProviderLimit] {
        guard let key = auth.resolve() else { return [] }
        guard let obj = getJSON(url: "https://www.minimax.io/v1/token_plan/remains", key: key),
              let remains = obj["model_remains"] as? [[String: Any]],
              let first = remains.first else { return [] }
        var out: [ProviderLimit] = []
        // Coerce Int/Double/String — API shape varies by plan.
        if let remaining = number(first["current_interval_remaining_percent"]) {
            out.append(limit(label: "interval", usedPercent: Double(100 - remaining),
                             resetsAt: epoch(first["end_time"])))
        }
        if let remaining = number(first["current_weekly_remaining_percent"]) {
            out.append(limit(label: "weekly", usedPercent: Double(100 - remaining),
                             resetsAt: epoch(first["weekly_end_time"])))
        }
        // Surface additional model scopes instead of only the first.
        for extra in remains.dropFirst().prefix(4) {
            guard let remaining = number(extra["current_interval_remaining_percent"]) else { continue }
            let name = (extra["model"] as? String) ?? "model-\(out.count)"
            out.append(limit(label: "interval · \(name)", usedPercent: Double(100 - remaining),
                             resetsAt: epoch(extra["end_time"])))
        }
        return out
    }
}
