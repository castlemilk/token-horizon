import Foundation

final class KimiLimitsEngine {
    static let shared = KimiLimitsEngine()
    private let lock = NSLock()
    private var cache: [ProviderLimit] = []
    private var lastFetch = Date.distantPast
    private static let clientID = "17e5f671-d194-4dfb-9706-5516cb48c098"

    func cachedLimits() -> [ProviderLimit] {
        lock.lock(); defer { lock.unlock() }
        return cache
    }

    func refreshIfDue(maxAge: TimeInterval = 60) {
        lock.lock()
        if Date().timeIntervalSince(lastFetch) < maxAge {
            lock.unlock()
            return
        }
        lastFetch = Date()
        lock.unlock()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let limits = Self.fetch()
            self?.lock.lock()
            self?.cache = limits
            self?.lock.unlock()
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: Notification.Name("kimiLimitsUpdated"), object: limits)
            }
        }
    }

    struct Credentials {
        var accessToken: String
        var refreshToken: String
        var expiresAt: Double
        var path: String
    }

    /// Credential files: `$KIMI_CODE_HOME`/`$KIMI_HOME` overrides, historical
    /// defaults, then auto-discovered `~/.kimi*` variants. Order matters —
    /// `readCredentials` takes the first file holding an access token.
    static func credentialPaths() -> [String] {
        var paths: [String] = []
        let env = ProcessInfo.processInfo.environment
        if let codeHome = env["KIMI_CODE_HOME"]?.trimmingCharacters(in: .whitespaces), !codeHome.isEmpty {
            paths.append("\(HomeDiscovery.expand(codeHome))/credentials/kimi-code.json")
        } else {
            paths.append(HomeDiscovery.expand("~/.kimi-code/credentials/kimi-code.json"))
        }
        if let home = env["KIMI_HOME"]?.trimmingCharacters(in: .whitespaces), !home.isEmpty {
            let p = "\(HomeDiscovery.expand(home))/credentials/kimi-code.json"
            if !paths.contains(p) { paths.append(p) }
        }
        let def = HomeDiscovery.expand("~/.kimi/credentials/kimi-code.json")
        if !paths.contains(def) { paths.append(def) }
        for variant in HomeDiscovery.variantDirs(prefixes: [".kimi"]) {
            let p = "\(variant)/credentials/kimi-code.json"
            if !paths.contains(p), FileManager.default.fileExists(atPath: p) { paths.append(p) }
        }
        return paths
    }

    static func readCredentials() -> Credentials? {
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

    static func saveCredentials(_ creds: Credentials) {
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

    static func fetch() -> [ProviderLimit] {
        guard var creds = readCredentials() else { return [] }

        if creds.expiresAt > 0 && Date().timeIntervalSince1970 + 300 > creds.expiresAt {
            guard let refreshed = refresh(creds) else { return [] }
            creds.accessToken = refreshed.accessToken
            creds.refreshToken = refreshed.refreshToken
            creds.expiresAt = refreshed.expiresAt
            saveCredentials(creds)
        }

        guard let url = URL(string: "https://api.kimi.com/coding/v1/usages") else { return [] }
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.setValue("Bearer \(creds.accessToken)", forHTTPHeaderField: "Authorization")
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
        if let usage = obj["usage"] as? [String: Any],
           let limit = parseQuota(usage, "limit"),
           let used = parseQuota(usage, "used") {
            let pct = limit > 0 ? used / limit * 100 : 0
            let plan = (membership(obj) ?? "plan").replacingOccurrences(of: "LEVEL_", with: "").lowercased()
            limits.append(ProviderLimit(
                provider: "kimi",
                label: plan.lowercased(),
                usedPercent: min(max(pct, 0), 100),
                resetsAt: parseDate(usage["resetTime"] as? String),
                detail: "\(fmt(used)) / \(fmt(limit))"))
        }
        if let entries = obj["limits"] as? [[String: Any]] {
            for entry in entries.prefix(2) {
                guard let detail = entry["detail"] as? [String: Any],
                      let limit = parseQuota(detail, "limit"),
                      let remaining = parseQuota(detail, "remaining") else { continue }
                let pct = limit > 0 ? (limit - remaining) / limit * 100 : 0
                let label = windowLabel(entry["window"] as? [String: Any])
                limits.append(ProviderLimit(
                    provider: "kimi",
                    label: label,
                    usedPercent: min(max(pct, 0), 100),
                    resetsAt: parseDate(detail["resetTime"] as? String),
                    detail: "\(fmt(remaining)) / \(fmt(limit)) left"))
            }
        }
        return limits
    }

    /// Human window label for a Kimi `window` dict ({duration, timeUnit}).
    /// Extracted for testability; previously inline in fetch().
    static func windowLabel(_ win: [String: Any]?) -> String {
        guard let win else { return "window" }
        let duration = (win["duration"] as? NSNumber)?.intValue ?? 0
        let unit = win["timeUnit"] as? String ?? ""
        if unit.contains("MINUTE") {
            return duration % 60 == 0 && duration >= 60 ? "\(duration / 60)h" : "\(duration)m"
        } else if unit.contains("HOUR") {
            return "\(duration)h"
        } else if unit.contains("DAY") {
            return "\(duration)d"
        }
        return "window"
    }

    static func refresh(_ creds: Credentials) -> Credentials? {
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

    static func parseQuota(_ dict: [String: Any], _ key: String) -> Double? {
        if let s = dict[key] as? String { return flexibleNumber(s) }
        if let n = dict[key] as? NSNumber { return n.doubleValue }
        return nil
    }

    static func flexibleNumber(_ s: String) -> Double? {
        let trimmed = s.trimmingCharacters(in: .whitespaces).uppercased()
        var numPart = ""
        var multiplier = 1.0
        for ch in trimmed {
            if ch.isNumber || ch == "." { numPart.append(ch) }
            else if ch == "K" { multiplier = 1_000 }
            else if ch == "M" { multiplier = 1_000_000 }
            else if ch == "B" { multiplier = 1_000_000_000 }
            else if !numPart.isEmpty { break }
        }
        guard let v = Double(numPart) else { return nil }
        return v * multiplier
    }

    static func membership(_ obj: [String: Any]) -> String? {
        guard let user = obj["user"] as? [String: Any],
              let mem = user["membership"] as? [String: Any] else { return nil }
        return mem["level"] as? String
    }

    private static let isoFull: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        if let d = isoFull.date(from: s) { return d }
        return isoPlain.date(from: s)
    }

    static func fmt(_ v: Double) -> String {
        switch v {
        case 1_000_000_000...: return String(format: "%.1fB", v / 1_000_000_000)
        case 1_000_000...: return String(format: "%.1fM", v / 1_000_000)
        case 1_000...: return String(format: "%.1fk", v / 1_000)
        default: return String(format: "%.0f", v)
        }
    }
}
