import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public final class KimiLimitsEngine: LimitsEngine, Meterable {
    public static let shared = KimiLimitsEngine()
    private static let clientID = "17e5f671-d194-4dfb-9706-5516cb48c098"

    public init() {
        super.init(updatedNotification: .kimiLimitsUpdated)
    }

    public var meterVendorKey: String { "kimi" }
    public var defaultMeterTarget: URL? { URL(string: "https://api.kimi.com") }
    public func makeMeter(listenPort: UInt16, target: URL?, store: UsageStoring?) -> RequestMeter? {
        guard ConsentManager.shared.isGranted(.metering) else { return nil }
        return AnthropicMeter(vendor: meterVendorKey, listenPort: listenPort,
                              targetBase: target ?? defaultMeterTarget!,
                              store: store, sourceKind: .external)
    }

    public override func fetchLimits() -> [ProviderLimit] {
        Self.fetch()
    }

    public struct Credentials {
        public var accessToken: String
        public var refreshToken: String
        public var expiresAt: Double
        public var path: String
    }

    public static func credentialPaths() -> [String] {
        let home = Platform.paths.homeDirectory.path
        var paths: [String] = []
        for envKey in ["KIMI_CODE_HOME", "KIMI_HOME"] {
            if let codeHome = ProcessInfo.processInfo.environment[envKey],
               !codeHome.trimmingCharacters(in: .whitespaces).isEmpty {
                paths.append("\(codeHome)/credentials/kimi-code.json")
            }
        }
        if paths.isEmpty {
            paths.append("\(home)/.kimi-code/credentials/kimi-code.json")
        }
        paths.append("\(home)/.kimi/credentials/kimi-code.json")
        return paths
    }

    public static func readCredentials() -> Credentials? {
        for path in credentialPaths() {
            guard let data = FileManager.default.contents(atPath: path),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = obj["access_token"] as? String else { continue }
            let refresh = obj["refresh_token"] as? String ?? ""
            let expires = (obj["expires_at"] as? NSNumber)?.doubleValue ?? 0
            return Credentials(accessToken: token, refreshToken: refresh, expiresAt: expires, path: path)
        }
        return nil
    }

    public static func saveCredentials(_ creds: Credentials) {
        let obj: [String: Any] = [
            "access_token": creds.accessToken,
            "refresh_token": creds.refreshToken,
            "expires_at": creds.expiresAt,
            "scope": "kimi-code",
            "token_type": "Bearer",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: .prettyPrinted) else { return }
        try? data.write(to: URL(fileURLWithPath: creds.path))
    }

    private static func makeLimit(provider: String = "kimi", label: String, usedPercent: Double, resetsAt: Date? = nil, detail: String = "") -> ProviderLimit {
        ProviderLimit(provider: provider, label: label,
                      usedPercent: min(max(usedPercent, 0), 100),
                      resetsAt: resetsAt, detail: detail)
    }

    public static func fetch() -> [ProviderLimit] {
        let profiles = readAllCredentials()
        guard !profiles.isEmpty else { return [] }
        let multi = profiles.count > 1
        var out: [ProviderLimit] = []
        for (index, var creds) in profiles.enumerated() {
            if index > 0 { Thread.sleep(forTimeInterval: 0.1) }
            if creds.expiresAt > 0 && Date().timeIntervalSince1970 + 300 > creds.expiresAt {
                guard let refreshed = refresh(creds) else { continue }
                creds.accessToken = refreshed.accessToken
                creds.refreshToken = refreshed.refreshToken
                creds.expiresAt = refreshed.expiresAt
                saveCredentials(creds)
            }
            out += fetchUsages(token: creds.accessToken,
                               profile: multi ? AccountDiscovery.deriveLabel(dir: creds.path) : "")
        }
        return out
    }

    /// Every credential file holding a token is one profile (multi-account).
    public static func readAllCredentials() -> [Credentials] {
        var out: [Credentials] = []
        for path in credentialPaths() {
            guard let data = FileManager.default.contents(atPath: path),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = obj["access_token"] as? String, !token.isEmpty else { continue }
            let refresh = obj["refresh_token"] as? String ?? ""
            let expires = (obj["expires_at"] as? NSNumber)?.doubleValue ?? 0
            out.append(Credentials(accessToken: token, refreshToken: refresh, expiresAt: expires, path: path))
        }
        return out
    }

    private static func fetchUsages(token: String, profile: String) -> [ProviderLimit] {
        guard let url = URL(string: "https://api.kimi.com/coding/v1/usages") else { return [] }
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("OpenUsage", forHTTPHeaderField: "User-Agent")

        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 8) == .timedOut { return [] }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }

        var limits: [ProviderLimit] = []
        let providerName = profile.isEmpty ? "kimi" : "kimi (\(profile))"
        if let usage = obj["usage"] as? [String: Any],
           let limit = parseQuota(usage, "limit"),
           let used = parseQuota(usage, "used") {
            let pct = limit > 0 ? used / limit * 100 : 0
            let plan = (membership(obj) ?? "plan").replacingOccurrences(of: "LEVEL_", with: "").lowercased()
            limits.append(makeLimit(
                provider: providerName,
                label: plan.lowercased(),
                usedPercent: pct,
                resetsAt: parseDate(usage["resetTime"] as? String),
                detail: "\(fmt(used)) / \(fmt(limit))"))
        }
        if let entries = obj["limits"] as? [[String: Any]] {
            for entry in entries.prefix(2) {
                guard let detail = entry["detail"] as? [String: Any],
                      let limit = parseQuota(detail, "limit"),
                      let remaining = parseQuota(detail, "remaining") else { continue }
                let pct = limit > 0 ? (limit - remaining) / limit * 100 : 0
                var label = "window"
                if let win = entry["window"] as? [String: Any] {
                    let duration = (win["duration"] as? NSNumber)?.intValue ?? 0
                    let unit = win["timeUnit"] as? String ?? ""
                    if unit.contains("MINUTE") {
                        label = duration % 60 == 0 && duration >= 60 ? "\(duration / 60)h" : "\(duration)m"
                    } else if unit.contains("HOUR") {
                        label = "\(duration)h"
                    } else if unit.contains("DAY") {
                        label = "\(duration)d"
                    }
                }
                limits.append(makeLimit(
                    provider: providerName,
                    label: label,
                    usedPercent: pct,
                    resetsAt: parseDate(detail["resetTime"] as? String),
                    detail: "\(fmt(remaining)) / \(fmt(limit)) left"))
            }
        }
        return limits
    }

    public static func refresh(_ creds: Credentials) -> Credentials? {
        guard !creds.refreshToken.isEmpty,
              let url = URL(string: "https://auth.kimi.com/api/oauth/token") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let body = "client_id=\(clientID)&grant_type=refresh_token&refresh_token=\(creds.refreshToken)"
        req.httpBody = body.data(using: .utf8)

        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 8) == .timedOut { return nil }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let access = obj["access_token"] as? String else { return nil }
        let refresh = obj["refresh_token"] as? String ?? creds.refreshToken
        let expiresIn = (obj["expires_in"] as? NSNumber)?.doubleValue ?? 3600
        return Credentials(accessToken: access, refreshToken: refresh,
                           expiresAt: Date().timeIntervalSince1970 + expiresIn, path: creds.path)
    }

    public static func parseQuota(_ dict: [String: Any], _ key: String) -> Double? {
        QuotaParsers.quota(dict, key)
    }

    public static func flexibleNumber(_ s: String) -> Double? {
        QuotaParsers.flexibleNumber(s)
    }

    public static func membership(_ obj: [String: Any]) -> String? {
        guard let user = obj["user"] as? [String: Any],
              let mem = user["membership"] as? [String: Any] else { return nil }
        return mem["level"] as? String
    }

    public static func parseDate(_ s: String?) -> Date? {
        QuotaParsers.parseISO(s)
    }

    public static func fmt(_ v: Double) -> String {
        QuotaParsers.compact(v)
    }
}
