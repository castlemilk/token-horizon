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
        return KimiMeter(vendor: meterVendorKey, listenPort: listenPort,
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

    public static func credentialPaths() -> [String] { KimiPaths.credentialFiles() }

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
        .clamped(provider: provider, label: label, usedPercent: usedPercent,
                 resetsAt: resetsAt, detail: detail)
    }

    /// Last-good quota rows: a transient failure (network blip, 429, the
    /// gateway omitting a window at exhaustion) must not blank the meters —
    /// serve the previous rows for a grace period. Credentials gone =
    /// deliberate (signed out): drop immediately.
    private static let lastGoodLock = NSLock()
    private static var lastGood: (rows: [ProviderLimit], at: Date)?
    /// Internal (not private) so tests can shrink the grace.
    static var lastGoodGrace: TimeInterval = 20 * 60

    public static func fetch() -> [ProviderLimit] {
        let profiles = readAllCredentials()
        guard !profiles.isEmpty else {
            lastGoodLock.lock(); lastGood = nil; lastGoodLock.unlock()
            return []
        }
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
                               profile: multi ? profileLabel(for: creds.path) : "")
        }
        if !out.isEmpty {
            lastGoodLock.lock(); lastGood = (out, Date()); lastGoodLock.unlock()
            return out
        }
        lastGoodLock.lock()
        let stale = lastGood
        lastGoodLock.unlock()
        if let stale, Date().timeIntervalSince(stale.at) < lastGoodGrace {
            return stale.rows
        }
        return out
    }

    /// Label for a credential profile: the kimi home two levels up from
    /// `…/.kimi-code/credentials/kimi-code.json` → "kimi-code". (deriveLabel
    /// is dir-oriented; fed the FILE path it returned the extension — "json".)
    private static func profileLabel(for path: String) -> String {
        let home = ((path as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
        let base = (home as NSString).lastPathComponent
        return base.hasPrefix(".") ? String(base.dropFirst()) : base
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

        // Retry ×3: the gateway intermittently omits windows or 429s at the
        // exact moment a window exhausts (same failure class as alibaba's
        // missing 5h) — a single-shot read blanks the meter right when the
        // user most wants to see it.
        var obj: [String: Any]?
        for attempt in 0..<3 {
            let r = HTTP.send(req, timeout: 8)
            if (200..<300).contains(r.status), let data = r.data,
               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                obj = parsed
                break
            }
            if attempt < 2 { Thread.sleep(forTimeInterval: 0.4) }
        }
        guard let obj else { return [] }
        return rowsFromUsagesPayload(obj, providerName: profile.isEmpty ? "kimi" : "kimi (\(profile))")
    }

    /// Pure payload → rows mapping (network-free, unit-tested).
    static func rowsFromUsagesPayload(_ obj: [String: Any], providerName: String) -> [ProviderLimit] {
        var limits: [ProviderLimit] = []
        if let usage = obj["usage"] as? [String: Any],
           let limit = parseQuota(usage, "limit"),
           let used = parseQuota(usage, "used") {
            let pct = limit > 0 ? used / limit * 100 : 0
            limits.append(makeLimit(
                provider: providerName,
                label: "week",   // top-level `usage` is the weekly budget (resetTime ~7d out)
                usedPercent: pct,
                resetsAt: parseDate(usage["resetTime"] as? String),
                detail: ""))
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
                    detail: ""))   // ring carries the number; no redundant quota text
            }
        }
        // Fallback synthesis: when the gateway omits the limits[] window
        // entry (observed at window exhaustion), the `usages.limit_5h` /
        // `limit_7d` summary block still reports the window. used_ratio is a
        // 0-1 fraction (defensively accept 0-100).
        func ratioPercent(_ w: [String: Any]) -> Double? {
            guard let ratio = parseQuota(w, "used_ratio") else { return nil }
            return ratio <= 1 ? ratio * 100 : ratio
        }
        let usages = obj["usages"] as? [String: Any]
        if !limits.contains(where: { $0.label == "week" }),
           let w = usages?["limit_7d"] as? [String: Any],
           let pct = ratioPercent(w) {
            limits.append(makeLimit(provider: providerName, label: "week",
                                    usedPercent: pct,
                                    resetsAt: parseDate(w["reset_time"] as? String)))
        }
        if !limits.contains(where: { $0.label.hasSuffix("h") || $0.label.hasSuffix("m") }),
           let w = usages?["limit_5h"] as? [String: Any],
           let pct = ratioPercent(w) {
            limits.append(makeLimit(provider: providerName, label: "5h",
                                    usedPercent: pct,
                                    resetsAt: parseDate(w["reset_time"] as? String)))
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

        let r = HTTP.send(req, timeout: 8)
        guard (200..<300).contains(r.status), let data = r.data,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
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
}
