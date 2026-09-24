import Foundation

/// Shared OAuth refresh-token plumbing for providers whose CLI-owned
/// credentials expire while the CLI isn't running. Claude Code access
/// tokens live ~8h and Codex/ChatGPT tokens rotate similarly; without this
/// the quota fetchers silently go stale until the user next launches the
/// CLI (the only thing that normally refreshes them).
///
/// Both public OAuth clients rotate the refresh token on every grant, so
/// refreshed credentials MUST be written back to the same store the CLI
/// reads — otherwise the next `claude`/`codex` run would hold a dead
/// refresh token and force a re-login. Callers re-read the store right
/// before writing and skip the write when the CLI already rotated.
enum OAuthRefresh {
    static let claudeClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    static let codexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"

    /// Anthropic moved token refresh from console.anthropic.com to
    /// platform.claude.com (Claude Code v2.1.81+); newest first, old as
    /// fallback for pre-migration tokens.
    static let claudeTokenURLs: [URL] = [
        URL(string: "https://platform.claude.com/v1/oauth/token")!,
        URL(string: "https://console.anthropic.com/v1/oauth/token")!,
    ]
    static let codexTokenURL = URL(string: "https://auth.openai.com/oauth/token")!

    /// Refresh proactively inside this window — mirrors Codex CLI's own
    /// 5-minute near-expiry refresh so a token can't die mid-poll.
    static let expirySkew: TimeInterval = 300

    struct RefreshedTokens {
        var accessToken: String
        var refreshToken: String
        var expiresAt: Date
        var idToken: String?
    }

    static func needsRefresh(expiresAt: Date?, now: Date = Date(), skew: TimeInterval = expirySkew) -> Bool {
        guard let expiresAt else { return false }
        return now.addingTimeInterval(skew) >= expiresAt
    }

    /// JWT payload, signature unchecked — we only read claims for expiry
    /// and account hints; the API validates the token itself.
    static func jwtPayload(_ token: String) -> [String: Any]? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = String(parts[1])
        let rem = payload.count % 4
        if rem > 0 { payload += String(repeating: "=", count: 4 - rem) }
        guard let data = Data(base64Encoded: payload.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    static func jwtExpiry(_ token: String) -> Date? {
        guard let exp = (jwtPayload(token)?["exp"] as? NSNumber)?.doubleValue else { return nil }
        return Date(timeIntervalSince1970: exp)
    }

    /// POST `{grant_type, refresh_token, client_id}` as JSON to each URL in
    /// order; first 2xx carrying an access_token wins. A rotated
    /// `refresh_token` in the response replaces the input (they're
    /// single-use); absent means the input stays valid. A 4xx auth
    /// rejection (invalid_grant et al.) stops early — fallback endpoints
    /// can't revive a dead refresh token.
    static func refresh(urls: [URL], refreshToken: String, clientID: String,
                        timeout: TimeInterval = 10) -> RefreshedTokens? {
        guard !refreshToken.isEmpty,
              let bodyData = try? JSONSerialization.data(withJSONObject: [
                  "grant_type": "refresh_token",
                  "refresh_token": refreshToken,
                  "client_id": clientID,
              ]) else { return nil }
        for url in urls {
            var req = URLRequest(url: url, timeoutInterval: timeout)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            req.httpBody = bodyData
            var resultData: Data?
            var status = -1
            let sema = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: req) { d, r, _ in
                if let http = r as? HTTPURLResponse {
                    status = http.statusCode
                    if (200..<300).contains(http.statusCode) { resultData = d }
                }
                sema.signal()
            }.resume()
            if sema.wait(timeout: .now() + timeout) == .timedOut { continue }
            guard let resultData,
                  let obj = try? JSONSerialization.jsonObject(with: resultData) as? [String: Any],
                  let access = obj["access_token"] as? String, !access.isEmpty else {
                if (400...403).contains(status) { return nil }
                continue
            }
            let expiresIn = (obj["expires_in"] as? NSNumber)?.doubleValue ?? 3600
            return RefreshedTokens(
                accessToken: access,
                refreshToken: obj["refresh_token"] as? String ?? refreshToken,
                expiresAt: Date().addingTimeInterval(expiresIn),
                idToken: obj["id_token"] as? String)
        }
        return nil
    }

    /// Atomic JSON write preserving the file's existing POSIX permissions —
    /// credential stores are mode 0600 and must stay that way.
    static func writeJSONAtomically(_ obj: [String: Any], to path: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else { return }
        let fm = FileManager.default
        let perm = (try? fm.attributesOfItem(atPath: path))?[.posixPermissions] as? NSNumber
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
        if let perm {
            try? fm.setAttributes([.posixPermissions: perm], ofItemAtPath: path)
        }
    }
}
