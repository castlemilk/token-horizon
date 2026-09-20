import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// OpenAI Codex / ChatGPT subscription quota (provider key "codex", matching
/// usage rows + file consolidation spelling so /limits groups with them).
/// GET https://chatgpt.com/backend-api/wham/usage
/// { plan_type, rate_limit.primary_window {used_percent, limit_window_seconds,
///   reset_at}, additional_rate_limits [{limit_name, metered_feature,
///   rate_limit.primary_window {...}}] }
/// Auth: opencode auth.json key "openai" (access token + accountId field,
/// JWT payload fallback). Wire format stays OpenAI-compatible, so the
/// default makeMeter + meterTarget below are the whole metering story.
/// See .agents/skills/provider-quota-openai/SKILL.md.
public final class CodexLimits: VendorLimitsAdapter {
    public init() { super.init(provider: "codex") }

    public override var meterTarget: URL? { URL(string: "https://api.openai.com") }

    public override var auth: VendorAuth {
        VendorAuth(sources: [.custom(Self.openaiAccessToken)])
    }

    // MARK: - Credentials

    static func authFilePath() -> String {
        if let p = ProcessInfo.processInfo.environment["OPENCODE_AUTH"], !p.isEmpty { return p }
        return Platform.paths.homeDirectory.appendingPathComponent(".local/share/opencode/auth.json").path
    }

    /// The raw "openai" entry: an object for OAuth, a bare token string otherwise.
    static func openaiEntry() -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: authFilePath()),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let entry = obj["openai"] as? [String: Any] { return entry }
        if let token = obj["openai"] as? String, !token.isEmpty { return ["key": token] }
        return nil
    }

    static func openaiAccessToken() -> String? {
        guard let entry = openaiEntry() else { return nil }
        for field in ["access", "access_token", "accessToken", "key", "token"] {
            if let token = entry[field] as? String, !token.isEmpty { return token }
        }
        return nil
    }

    /// Account ID for the ChatGPT-Account-ID header: explicit field first,
    /// JWT payload fallback (https://api.openai.com/auth → chatgpt_account_id).
    static func openaiAccountID(entry: [String: Any]?, token: String) -> String? {
        if let entry {
            for field in ["accountId", "account_id", "chatgpt_account_id"] {
                if let id = entry[field] as? String, !id.isEmpty { return id }
            }
        }
        return jwtAccountID(token: token)
    }

    static func decodeJWTPayload(token: String) -> [String: Any]? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var b64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    static func jwtAccountID(token: String) -> String? {
        guard let payload = decodeJWTPayload(token: token),
              let auth = payload["https://api.openai.com/auth"] as? [String: Any],
              let id = auth["chatgpt_account_id"] as? String, !id.isEmpty else { return nil }
        return id
    }

    // MARK: - Fetch

    public override func fetch() -> [ProviderLimit] {
        let entry = Self.openaiEntry()
        let token = entry.flatMap { e in
            ["access", "access_token", "accessToken", "key", "token"].lazy.compactMap { e[$0] as? String }.first(where: { !$0.isEmpty })
        } ?? auth.resolve()
        guard let token else { return [] }
        let accountID = Self.openaiAccountID(entry: entry, token: token)
        return fetchWindows(token: token, accountID: accountID)
    }

    private func fetchWindows(token: String, accountID: String?) -> [ProviderLimit] {
        // Pseudonymous per-account key: quota windows consolidate against the
        // SAME account across meter/quota-API/file sources; the raw token is
        // never persisted.
        let account = accountKey(for: token)
        guard let u = URL(string: "https://chatgpt.com/backend-api/wham/usage") else { return [] }
        var req = URLRequest(url: u, timeoutInterval: 8)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let accountID { req.setValue(accountID, forHTTPHeaderField: "ChatGPT-Account-ID") }
        req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", forHTTPHeaderField: "User-Agent")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let obj = performJSON(req, timeout: 8) else { return [] }
        return Self.windows(from: obj, now: Date()).map {
            limit(label: $0.label, usedPercent: $0.usedPercent,
                  resetsAt: $0.resetsAt, detail: $0.detail, account: account)
        }
    }

    // MARK: - Pure parsing (unit-tested)

    struct CodexWindow {
        let label: String
        let usedPercent: Double
        let resetsAt: Date?
        let detail: String
    }

    /// Primary window + per-feature windows from a wham/usage payload.
    static func windows(from obj: [String: Any], now: Date = Date()) -> [CodexWindow] {
        var out: [CodexWindow] = []
        let plan = obj["plan_type"] as? String ?? ""
        let detail = plan.isEmpty ? "" : "\(plan) plan"
        if let rl = obj["rate_limit"] as? [String: Any],
           let primary = rl["primary_window"] as? [String: Any],
           let pct = (primary["used_percent"] as? NSNumber)?.doubleValue {
            out.append(CodexWindow(label: windowLabel(seconds: primary["limit_window_seconds"]),
                                   usedPercent: pct,
                                   resetsAt: resetDate(primary, now: now),
                                   detail: detail))
        }
        if let arr = obj["additional_rate_limits"] as? [[String: Any]] {
            for entry in arr.prefix(5) {
                guard let rl = entry["rate_limit"] as? [String: Any],
                      let primary = rl["primary_window"] as? [String: Any],
                      let pct = (primary["used_percent"] as? NSNumber)?.doubleValue else { continue }
                let name = (entry["limit_name"] as? String)
                    ?? (entry["metered_feature"] as? String)
                    ?? "extra"
                out.append(CodexWindow(label: "\(windowLabel(seconds: primary["limit_window_seconds"])) · \(name)",
                                       usedPercent: pct,
                                       resetsAt: resetDate(primary, now: now),
                                       detail: detail))
            }
        }
        return out
    }

    /// 604800 → "weekly", 18000 → "5h", else Nd/Nh/Nm.
    static func windowLabel(seconds: Any?) -> String {
        guard let s = (seconds as? NSNumber)?.intValue, s > 0 else { return "window" }
        if s % 86400 == 0 { return s == 604800 ? "weekly" : "\(s / 86400)d" }
        if s % 3600 == 0 { return "\(s / 3600)h" }
        return "\(max(s / 60, 1))m"
    }

    /// reset_at epoch wins; reset_after_seconds counts from now.
    static func resetDate(_ window: [String: Any], now: Date) -> Date? {
        if let ts = window["reset_at"] as? NSNumber { return Date(timeIntervalSince1970: ts.doubleValue) }
        if let ts = window["reset_at"] as? String, let d = Double(ts) { return Date(timeIntervalSince1970: d) }
        if let after = (window["reset_after_seconds"] as? NSNumber)?.doubleValue {
            return now.addingTimeInterval(after)
        }
        return nil
    }
}
