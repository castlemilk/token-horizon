import Foundation
import CryptoKit

final class ClaudeDiscovery {
    static let shared = ClaudeDiscovery()
    private let lock = NSLock()
    private var cachedAccounts: [ClaudeAccount] = []
    private var cachedLimitsMap: [String: [ProviderLimit]] = [:]
    private var lastSuccessfulLiveLimits: [String: [ProviderLimit]] = [:]
    private var lastFetch = Date.distantPast

    /// Per-account throttle state: configDir → earliest next live attempt.
    /// A 429 backs one account off without pausing the others, and stops the
    /// refresh loop from renewing a server backoff faster than it can decay.
    private var backoffUntil: [String: Date] = [:]
    static let defaultThrottleBackoff: TimeInterval = 300 // 5 min

    /// Per-config-dir OAuth refresh throttle: a dead refresh token
    /// (invalid_grant) must not retry on every 30s poll.
    private var lastRefreshAttempt: [String: Date] = [:]
    static let refreshAttemptInterval: TimeInterval = 600

    /// Test hook: when set, token-refresh POSTs go to these URLs instead of
    /// the production Anthropic endpoints.
    var tokenEndpointOverride: [URL]?

    /// Outcome of one live usage-API call: payload on 2xx, plus the raw
    /// status and any Retry-After so callers can back off per account.
    struct LiveUsageResult {
        var payload: [String: Any]?
        var statusCode: Int
        var retryAfter: TimeInterval?
    }

    private init() {}

    static func sha256Prefix8(_ str: String) -> String {
        let hash = SHA256.hash(data: Data(str.utf8))
        return hash.map { String(format: "%02x", $0) }.joined().prefix(8).description
    }

    /// All Claude config homes: `$CLAUDE_CONFIG_DIR` → `~/.claude` →
    /// auto-discovered `~/.claude*` variants → `~/.config/claude`.
    /// Shared glob lives in `HomeDiscovery` (cached `$HOME` listing).
    static func discoverDirectories(home: String? = nil) -> [String] {
        HomeDiscovery.variantDirs(
            prefixes: [".claude"],
            envVars: ["CLAUDE_CONFIG_DIR"],
            defaultPaths: ["~/.claude"],
            configNames: ["claude"],
            home: home)
    }

    static func deriveLabel(dir: String, email: String) -> String {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, let atIdx = trimmed.firstIndex(of: "@") {
            let user = String(trimmed[..<atIdx])
            let domain = String(trimmed[trimmed.index(after: atIdx)...]).lowercased()
            let parts = domain.split(separator: ".")
            if let primary = parts.first {
                let s = String(primary)
                if s == "gmail" || s == "outlook" || s == "icloud" || s == "proton" {
                    return user.isEmpty ? s : user
                }
                return s
            }
        }
        let base = (dir as NSString).lastPathComponent
        return base.hasPrefix(".") ? String(base.dropFirst()) : base
    }

    private func readClaudeJson(for dir: String) -> (oauth: [String: Any]?, cachedUsage: [String: Any]?) {
        let defaultClaude = NSString(string: "~/.claude").expandingTildeInPath
        let homeClaudeJson = NSString(string: "~/.claude.json").expandingTildeInPath
        let dirClaudeJson = "\(dir)/.claude.json"

        let candidatePaths: [String]
        if dir == defaultClaude {
            candidatePaths = [homeClaudeJson, dirClaudeJson]
        } else {
            candidatePaths = [dirClaudeJson, homeClaudeJson]
        }

        for path in candidatePaths {
            guard let data = FileManager.default.contents(atPath: path),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let oauth = obj["oauthAccount"] as? [String: Any]
            let cachedUsage = obj["cachedUsageUtilization"] as? [String: Any]
            if oauth != nil || cachedUsage != nil {
                return (oauth, cachedUsage)
            }
        }
        return (nil, nil)
    }

    /// Where a profile's OAuth blob lives — needed to write rotated tokens
    /// back into the same store the CLI reads.
    enum CredentialSource {
        case credentialsFile(path: String, oauthKey: String)
        case keychain(service: String, account: String, oauthKey: String)
    }

    struct ClaudeCredentials {
        var accessToken: String
        var refreshToken: String
        var expiresAtMs: Double
        var source: CredentialSource
        var oauth: [String: Any]
    }

    /// Full OAuth material for a profile dir: `.credentials.json` first,
    /// then the macOS Keychain services Claude Code uses. Returns the whole
    /// `claudeAiOauth`-style blob (not just the token) so refresh write-back
    /// can preserve sibling fields like `refreshTokenExpiresAt`/`scopes`.
    func readCredentials(for dir: String) -> ClaudeCredentials? {
        let credFile = "\(dir)/.credentials.json"
        if let data = FileManager.default.contents(atPath: credFile),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let (key, oauth) = Self.extractOAuth(from: obj) {
            return Self.makeCredentials(oauth: oauth, source: .credentialsFile(path: credFile, oauthKey: key))
        }

        let hash = Self.sha256Prefix8(dir)
        let defaultClaude = NSString(string: "~/.claude").expandingTildeInPath
        let services: [String]
        if dir == defaultClaude {
            services = ["Claude Code-credentials", "Claude Code-credentials-\(hash)"]
        } else {
            services = ["Claude Code-credentials-\(hash)", "Claude Code-credentials"]
        }

        for svc in services {
            if let text = runSecurityFindGenericPassword(service: svc),
               let data = text.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let (key, oauth) = Self.extractOAuth(from: obj) {
                let account = Self.parseKeychainAccount(runSecurityItemAttributes(service: svc)) ?? NSUserName()
                return Self.makeCredentials(oauth: oauth, source: .keychain(service: svc, account: account, oauthKey: key))
            }
        }
        return nil
    }

    private static func makeCredentials(oauth: [String: Any], source: CredentialSource) -> ClaudeCredentials? {
        guard let token = oauth["accessToken"] as? String, !token.isEmpty else { return nil }
        return ClaudeCredentials(
            accessToken: token,
            refreshToken: oauth["refreshToken"] as? String ?? "",
            expiresAtMs: (oauth["expiresAt"] as? NSNumber)?.doubleValue ?? 0,
            source: source,
            oauth: oauth)
    }

    /// First `claudeAiOauth`/`oauth`/`claudeOAuth` blob holding a non-empty
    /// accessToken, with the top-level key it was found under.
    static func extractOAuth(from obj: [String: Any]) -> (key: String, oauth: [String: Any])? {
        for key in ["claudeAiOauth", "oauth", "claudeOAuth"] {
            if let oauth = obj[key] as? [String: Any],
               let token = oauth["accessToken"] as? String, !token.isEmpty {
                return (key, oauth)
            }
        }
        return nil
    }

    func findAccessToken(for dir: String) -> String? {
        guard let creds = readCredentials(for: dir) else { return nil }
        let expiry = creds.expiresAtMs > 0 ? Date(timeIntervalSince1970: creds.expiresAtMs / 1000) : nil
        guard OAuthRefresh.needsRefresh(expiresAt: expiry), !creds.refreshToken.isEmpty else {
            return creds.accessToken
        }

        lock.lock()
        let throttled = Date().timeIntervalSince(lastRefreshAttempt[dir] ?? .distantPast) < Self.refreshAttemptInterval
        if !throttled { lastRefreshAttempt[dir] = Date() }
        lock.unlock()
        if throttled { return creds.accessToken }

        guard let tokens = OAuthRefresh.refresh(
            urls: tokenEndpointOverride ?? OAuthRefresh.claudeTokenURLs,
            refreshToken: creds.refreshToken,
            clientID: OAuthRefresh.claudeClientID) else {
            return creds.accessToken
        }
        return writeBackRefreshed(tokens, to: creds)
    }

    /// Persist rotated tokens into the same store the CLI reads. The store
    /// is re-read first: if its refreshToken no longer matches the one we
    /// sent, the CLI already rotated — writing ours would resurrect a dead
    /// refresh token, so we adopt the store's current access token instead.
    /// Returns the access token the caller should use.
    func writeBackRefreshed(_ tokens: OAuthRefresh.RefreshedTokens, to creds: ClaudeCredentials) -> String {
        var oauth = creds.oauth
        oauth["accessToken"] = tokens.accessToken
        oauth["refreshToken"] = tokens.refreshToken
        oauth["expiresAt"] = tokens.expiresAt.timeIntervalSince1970 * 1000

        switch creds.source {
        case .credentialsFile(let path, let oauthKey):
            guard let data = FileManager.default.contents(atPath: path),
                  var root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let current = root[oauthKey] as? [String: Any] else { return tokens.accessToken }
            guard (current["refreshToken"] as? String ?? "") == creds.refreshToken else {
                return (current["accessToken"] as? String) ?? tokens.accessToken
            }
            root[oauthKey] = oauth
            OAuthRefresh.writeJSONAtomically(root, to: path)
            return tokens.accessToken
        case .keychain(let service, let account, let oauthKey):
            guard let text = runSecurityFindGenericPassword(service: service),
                  let data = text.data(using: .utf8),
                  var root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let current = root[oauthKey] as? [String: Any] else { return tokens.accessToken }
            guard (current["refreshToken"] as? String ?? "") == creds.refreshToken else {
                return (current["accessToken"] as? String) ?? tokens.accessToken
            }
            root[oauthKey] = oauth
            guard let payload = try? JSONSerialization.data(withJSONObject: root),
                  let secret = String(data: payload, encoding: .utf8) else { return tokens.accessToken }
            _ = runSecurityAddGenericPassword(service: service, account: account, secret: secret)
            // Keep a sibling `.credentials.json` consistent when it holds the
            // same (now-dead) refresh token — Linux-mode installs read it.
            syncStaleCredentialsFile(refreshToken: creds.refreshToken, oauth: oauth)
            return tokens.accessToken
        }
    }

    /// If a `.credentials.json` exists anywhere under the discovered profile
    /// dirs carrying the same pre-rotation refresh token, patch it too so a
    /// CLI that reads the file doesn't replay a dead grant.
    private func syncStaleCredentialsFile(refreshToken: String, oauth: [String: Any]) {
        for dir in Self.discoverDirectories() {
            let path = "\(dir)/.credentials.json"
            guard let data = FileManager.default.contents(atPath: path),
                  var root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let (key, _) = Self.extractOAuth(from: root),
                  let current = root[key] as? [String: Any],
                  (current["refreshToken"] as? String ?? "") == refreshToken else { continue }
            root[key] = oauth
            OAuthRefresh.writeJSONAtomically(root, to: path)
        }
    }

    /// `"acct"<blob>="benebsworth"` from `security find-generic-password`
    /// attribute output; nil when unparseable (caller falls back to NSUserName).
    static func parseKeychainAccount(_ attributes: String?) -> String? {
        guard let attributes,
              let range = attributes.range(of: "\"acct\"<blob>=\"") else { return nil }
        let rest = attributes[range.upperBound...]
        guard let close = rest.firstIndex(of: "\"") else { return nil }
        let value = String(rest[..<close])
        return value.isEmpty ? nil : value
    }

    private func runSecurityItemAttributes(service: String) -> String? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        task.arguments = ["find-generic-password", "-s", service]
        let stdoutPipe = Pipe()
        task.standardOutput = stdoutPipe
        task.standardError = Pipe()
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            return nil
        }
        guard task.terminationStatus == 0 else { return nil }
        let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)
    }

    private func runSecurityAddGenericPassword(service: String, account: String, secret: String) -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        task.arguments = ["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret]
        task.standardOutput = Pipe()
        task.standardError = Pipe()
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            return false
        }
        return task.terminationStatus == 0
    }

    private func runSecurityFindGenericPassword(service: String) -> String? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        task.arguments = ["find-generic-password", "-s", service, "-w"]
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        task.standardOutput = stdoutPipe
        task.standardError = stderrPipe
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            return nil
        }
        guard task.terminationStatus == 0 else { return nil }
        let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func fetchUsageAPI(token: String, timeout: TimeInterval = 8) -> LiveUsageResult {
        guard let url = URL(string: "https://api.anthropic.com/api/oauth/usage") else {
            return LiveUsageResult(payload: nil, statusCode: -1, retryAfter: nil)
        }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("claude-code/0.2.29", forHTTPHeaderField: "User-Agent")
        var resultData: Data?
        var statusCode = -1
        var retryAfter: TimeInterval?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse {
                statusCode = http.statusCode
                if (200..<300).contains(http.statusCode) { resultData = d }
                retryAfter = Self.parseRetryAfter(http)
            }
            sema.signal()
        }.resume()
        _ = sema.wait(timeout: .now() + timeout)
        guard let resultData,
              let obj = try? JSONSerialization.jsonObject(with: resultData) as? [String: Any] else {
            return LiveUsageResult(payload: nil, statusCode: statusCode, retryAfter: retryAfter)
        }
        return LiveUsageResult(payload: obj, statusCode: statusCode, retryAfter: retryAfter)
    }

    /// Parses `Retry-After` (seconds) case-insensitively. Anthropic/Cloudflare
    /// send integer seconds on 429; anything else yields nil (caller defaults).
    static func parseRetryAfter(_ http: HTTPURLResponse) -> TimeInterval? {
        for (key, value) in http.allHeaderFields {
            guard let name = key as? String, name.lowercased() == "retry-after",
                  let raw = value as? String,
                  let secs = Double(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
                  secs >= 0 else { continue }
            return secs
        }
        return nil
    }

    /// Clamp for throttle backoffs: honor the server's ask, floored at 60s
    /// (sub-minute asks just re-trigger the throttle) and capped at 24h.
    /// Missing/invalid asks default to `defaultThrottleBackoff`.
    static func throttleBackoffDelay(retryAfter: TimeInterval?) -> TimeInterval {
        guard let r = retryAfter, r > 0 else { return defaultThrottleBackoff }
        return min(max(r, 60), 86_400)
    }

    func accountMetadata(for dir: String) -> ClaudeAccount {
        let (oauth, _) = readClaudeJson(for: dir)
        let email = oauth?["emailAddress"] as? String ?? ""
        let label = Self.deriveLabel(dir: dir, email: email)
        let base = (dir as NSString).lastPathComponent
        let id = base.hasPrefix(".") ? String(base.dropFirst()) : base

        return ClaudeAccount(
            id: id,
            label: label,
            configDir: dir,
            accountUuid: oauth?["accountUuid"] as? String ?? "",
            email: email,
            displayName: oauth?["displayName"] as? String ?? "",
            organizationUuid: oauth?["organizationUuid"] as? String ?? "",
            organizationName: oauth?["organizationName"] as? String ?? "",
            organizationType: oauth?["organizationType"] as? String ?? "",
            rateLimitTier: oauth?["organizationRateLimitTier"] as? String ?? "",
            hasExtraUsageEnabled: oauth?["hasExtraUsageEnabled"] as? Bool ?? false
        )
    }

    /// Disk fallback for `cachedUsageUtilization`. Returns parsed rows plus
    /// whether they are stale (older than `maxFreshAge`). Fresh rows are
    /// always safe; stale rows are only better than hiding the account when
    /// live is throttled or erroring — never invent rows from a missing blob.
    static func diskFallbackLimits(
        cachedUsage: [String: Any]?,
        provider: String,
        detail: String,
        maxFreshAge: TimeInterval = 7200
    ) -> (limits: [ProviderLimit], isStale: Bool) {
        guard let util = cachedUsage?["utilization"] as? [String: Any] else { return ([], false) }
        let rows = PlanLimitsEngine.parseClaudePayload(util, provider: provider, detail: detail)
        guard !rows.isEmpty else { return ([], false) }
        let fetchedAtMs = cachedUsage?["fetchedAtMs"] as? Double ?? 0
        let age = Date().timeIntervalSince1970 - (fetchedAtMs / 1000.0)
        return (rows, !(age > 0 && age < maxFreshAge))
    }

    /// Tags stale fallback rows in `detail`. Throttled rows carry the
    /// established "rate-limited" marker (drives the red RATE LIMITED badge
    /// in PlanLimitsViews and the cleared-refresh notification); other stale
    /// rows carry "stale". Fresh rows pass through untouched. Idempotent.
    static func markStale(_ rows: [ProviderLimit], throttled: Bool) -> [ProviderLimit] {
        rows.map { row in
            var marked = row
            let tag = throttled ? "rate-limited" : "stale"
            if !marked.detail.localizedCaseInsensitiveContains(tag) {
                marked.detail = marked.detail.isEmpty ? tag : "\(marked.detail) · \(tag)"
            }
            return marked
        }
    }

    func fetchAllLimits() -> [ProviderLimit] {
        lock.lock()
        if Date().timeIntervalSince(lastFetch) < 90 && !cachedLimitsMap.isEmpty {
            let res = Array(cachedLimitsMap.values.joined())
            lock.unlock()
            return res
        }
        lock.unlock()

        let dirs = Self.discoverDirectories()
        guard !dirs.isEmpty else { return [] }

        var accounts: [ClaudeAccount] = []
        for dir in dirs {
            accounts.append(accountMetadata(for: dir))
        }

        let isMultiAccount = accounts.count > 1
        var allLimits: [ProviderLimit] = []
        var limitsByDir: [String: [ProviderLimit]] = [:]

        for (index, acct) in accounts.enumerated() {
            if index > 0 {
                // Short pause to avoid triggering Cloudflare / Anthropic 429 rate limit bursts
                Thread.sleep(forTimeInterval: 0.1)
            }

            let providerName = isMultiAccount ? "claude (\(acct.label))" : "claude"
            let detail = "\(acct.email.isEmpty ? acct.id : acct.email)\(acct.organizationType.isEmpty ? "" : " · \(acct.organizationType)")"

            var limits: [ProviderLimit] = []
            var liveThrottled = false
            var liveAttempted = false
            self.lock.lock()
            let backedOff = (self.backoffUntil[acct.configDir] ?? .distantPast) > Date()
            self.lock.unlock()
            if backedOff {
                // Still inside a server backoff window: don't spend a request
                // that would only renew the throttle. Fall through to memory
                // + disk below so the account stays visible.
                liveThrottled = true
            } else if let token = self.findAccessToken(for: acct.configDir) {
                liveAttempted = true
                let res = self.fetchUsageAPI(token: token)
                if let obj = res.payload {
                    limits = PlanLimitsEngine.parseClaudePayload(obj, provider: providerName, detail: detail)
                    if !limits.isEmpty {
                        self.lock.lock()
                        self.lastSuccessfulLiveLimits[acct.configDir] = limits
                        self.backoffUntil.removeValue(forKey: acct.configDir)
                        self.lock.unlock()
                    }
                } else if res.statusCode == 429 {
                    liveThrottled = true
                    let wait = Self.throttleBackoffDelay(retryAfter: res.retryAfter)
                    self.lock.lock()
                    self.backoffUntil[acct.configDir] = Date().addingTimeInterval(wait)
                    self.lock.unlock()
                    NSLog("[ClaudeDiscovery] %@: usage API throttled (429), backing off %.0fs", acct.id, wait)
                }
            }

            if limits.isEmpty {
                // 1. Prefer last successful live limits so 429 doesn't downgrade valid data
                self.lock.lock()
                let prevLive = self.lastSuccessfulLiveLimits[acct.configDir] ?? []
                let prevMem = self.cachedLimitsMap[acct.configDir] ?? []
                self.lock.unlock()

                if !prevLive.isEmpty {
                    limits = prevLive
                } else if !prevMem.isEmpty {
                    limits = prevMem
                } else {
                    // 2. Fresh disk cache (< 2h) as before; plus a stale tier:
                    // when live was attempted but refused (429/backoff) or
                    // errored, an old row marked stale beats a vanished
                    // account. Token-missing (logged out) keeps fresh-only.
                    let (_, cachedUsage) = self.readClaudeJson(for: acct.configDir)
                    let fb = Self.diskFallbackLimits(
                        cachedUsage: cachedUsage, provider: providerName, detail: detail)
                    if !fb.limits.isEmpty && (!fb.isStale || liveThrottled || liveAttempted) {
                        limits = fb.isStale
                            ? Self.markStale(fb.limits, throttled: liveThrottled)
                            : fb.limits
                    }
                }
            }

            limitsByDir[acct.configDir] = limits
            allLimits.append(contentsOf: limits)
        }

        lock.lock()
        self.cachedLimitsMap = limitsByDir
        for i in 0..<accounts.count {
            accounts[i].limits = limitsByDir[accounts[i].configDir] ?? []
        }
        self.cachedAccounts = accounts
        self.lastFetch = Date()
        lock.unlock()

        return allLimits
    }

    func cachedLimits(for dir: String) -> [ProviderLimit] {
        lock.lock(); defer { lock.unlock() }
        return cachedLimitsMap[dir] ?? []
    }

    func accounts() -> [ClaudeAccount] {
        lock.lock(); defer { lock.unlock() }
        return cachedAccounts
    }
}
