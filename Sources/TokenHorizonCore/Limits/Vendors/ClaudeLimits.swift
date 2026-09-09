import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Anthropic Claude (Claude Code OAuth).
/// GET https://api.anthropic.com/api/oauth/usage
/// { five_hour: {utilization, resets_at}, seven_day: {...}, limits: [weekly_scoped ...] }
/// Auth: CLAUDE_CONFIG_DIR/.credentials.json → Platform.credentials Keychain fallback.
/// See .agents/skills/provider-quota-anthropic/SKILL.md.
public final class ClaudeLimits: VendorLimitsAdapter {
    public init() { super.init(provider: "claude") }

    public override func fetch() -> [ProviderLimit] {
        guard let token = accessToken() else { return [] }
        guard let u = URL(string: "https://api.anthropic.com/api/oauth/usage") else { return [] }
        var req = URLRequest(url: u, timeoutInterval: 8)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let obj = performJSON(req, timeout: 8) else { return [] }

        let windows: [(String, String)] = [("five_hour", "5h"), ("seven_day", "weekly"),
                                           ("seven_day_oauth_apps", "apps 7d")]
        var out: [ProviderLimit] = []
        for (key, label) in windows {
            guard let window = obj[key] as? [String: Any] else { continue }
            let pct = (window["utilization"] as? NSNumber)?.doubleValue
                ?? (window["used_percent"] as? NSNumber)?.doubleValue
                ?? (window["usedPercent"] as? NSNumber)?.doubleValue
            guard let pct else { continue }
            var reset: Date?
            if let ts = window["resets_at"] as? String { reset = parseISO(ts) }
            else if let ts = window["resets_at"] as? NSNumber { reset = epoch(ts) }
            out.append(ProviderLimit(provider: "claude", label: label,
                                     usedPercent: min(max(pct, 0), 100),
                                     resetsAt: reset, detail: ""))
        }
        if let limits = obj["limits"] as? [[String: Any]] {
            for entry in limits where (entry["kind"] as? String) == "weekly_scoped" {
                let model = ((entry["scope"] as? [String: Any])?["model"] as? [String: Any])?["display_name"] as? String ?? "scoped"
                if let pct = (entry["utilization"] as? NSNumber)?.doubleValue {
                    out.append(ProviderLimit(provider: "claude", label: "weekly · \(model)",
                                             usedPercent: min(max(pct, 0), 100),
                                             resetsAt: parseISO(entry["resets_at"] as? String), detail: ""))
                }
            }
        }
        return out
    }

    private func accessToken() -> String? {
        let env = ProcessInfo.processInfo.environment
        let configDir = env["CLAUDE_CONFIG_DIR"] ?? "~/.claude"
        let file = NSString(string: "\(configDir)/.credentials.json").expandingTildeInPath
        var root: [String: Any]?
        if let data = FileManager.default.contents(atPath: file),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            root = obj
        } else if let secret = Platform.credentials.genericPassword(service: "Claude Code-credentials", account: nil),
                  let secretData = secret.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: secretData) as? [String: Any] {
            root = obj
        }
        guard let root else { return nil }
        let oauth = (root["claudeAiOauth"] as? [String: Any]) ?? (root["oauth"] as? [String: Any]) ?? root
        return oauth["accessToken"] as? String
    }
}
