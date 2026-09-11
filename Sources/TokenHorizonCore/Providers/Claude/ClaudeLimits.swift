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

    public override var meterTarget: URL? { URL(string: "https://api.anthropic.com") }

    public override func makeMeter(listenPort: UInt16, target: URL?, store: UsageStoring?) -> RequestMeter? {
        AnthropicMeter(vendor: provider, listenPort: listenPort,
                       targetBase: target ?? URL(string: "https://api.anthropic.com")!,
                       store: store, sourceKind: .external)
    }

    /// CLAUDE_CONFIG_DIR/.credentials.json (dot-path walked) → macOS Keychain
    /// "Claude Code-credentials" (secret is itself JSON, same key paths).
    public override var auth: VendorAuth {
        let env = ProcessInfo.processInfo.environment
        let rawDir = env["CLAUDE_CONFIG_DIR"] ?? "~/.claude"
        let configDir: String
        if rawDir.hasPrefix("~/") {
            configDir = Platform.paths.homeDirectory.appendingPathComponent(String(rawDir.dropFirst(2))).path
        } else if rawDir == "~" {
            configDir = Platform.paths.homeDirectory.path
        } else {
            configDir = rawDir
        }
        let keyPaths = ["claudeAiOauth.accessToken", "oauth.accessToken", "accessToken"]
        return VendorAuth(sources: [
            .fileJSON("\(configDir)/.credentials.json", keyPaths: keyPaths),
            .keychain(service: "Claude Code-credentials", jsonKeyPaths: keyPaths),
        ])
    }

    /// Multi-account: every `~/.claude*` variant dir (or CLAUDE_CONFIG_DIR)
    /// holding `.credentials.json` is one profile; Keychain is the fallback
    /// single profile. Labels stay empty for the single-profile case.
    public override func credentials() -> [(label: String, credential: String)] {
        let keyPaths = ["claudeAiOauth.accessToken", "oauth.accessToken", "accessToken"]
        var dirs = AccountDiscovery.variantDirs(prefixes: [".claude"], envVars: ["CLAUDE_CONFIG_DIR"])
        if dirs.isEmpty {
            dirs = [Platform.paths.homeDirectory.appendingPathComponent(".claude").path]
        }
        var out: [(String, String)] = []
        for dir in dirs {
            let path = dir + "/.credentials.json"
            guard let data = FileManager.default.contents(atPath: path),
                  let obj = try? JSONSerialization.jsonObject(with: data) else { continue }
            for keyPath in keyPaths {
                var current: Any? = obj
                for part in keyPath.split(separator: ".") {
                    current = (current as? [String: Any])?[String(part)]
                }
                if let token = current as? String, !token.isEmpty {
                    let label = dirs.count > 1 ? AccountDiscovery.deriveLabel(dir: dir) : ""
                    out.append((label, token))
                    break
                }
            }
        }
        if out.isEmpty, let fallback = auth.resolve() {
            out.append(("", fallback))
        }
        return out
    }

    public override func fetch() -> [ProviderLimit] {
        let creds = credentials()
        guard !creds.isEmpty else { return [] }
        let multi = creds.count > 1
        var out: [ProviderLimit] = []
        for (index, (profile, token)) in creds.enumerated() {
            if index > 0 { Thread.sleep(forTimeInterval: 0.1) }
            out += fetchWindows(token: token, providerName: multi && !profile.isEmpty ? "claude (\(profile))" : "claude")
        }
        return out
    }

    private func fetchWindows(token: String, providerName: String) -> [ProviderLimit] {
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
            out.append(limit(label: label, usedPercent: pct, resetsAt: reset, provider: providerName))
        }
        if let limits = obj["limits"] as? [[String: Any]] {
            for entry in limits where (entry["kind"] as? String) == "weekly_scoped" {
                let model = ((entry["scope"] as? [String: Any])?["model"] as? [String: Any])?["display_name"] as? String ?? "scoped"
                if let pct = (entry["utilization"] as? NSNumber)?.doubleValue {
                    out.append(limit(label: "weekly · \(model)", usedPercent: pct,
                                     resetsAt: parseISO(entry["resets_at"] as? String), provider: providerName))
                }
            }
        }
        return out
    }
}
