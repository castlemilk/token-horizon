import Foundation
import CryptoKit
import Darwin

final class ClaudeDiscovery {
    static let shared = ClaudeDiscovery(cachedAccounts: DurableStore.shared.loadSnapshot()?.claudeAccounts ?? [])
    private let lock = NSLock()
    private let fetchLock = NSLock()
    private var cachedAccounts: [ClaudeAccount] = []
    private var cachedLimitsMap: [String: [ProviderLimit]] = [:]
    private var lastSuccessfulLiveLimits: [String: [ProviderLimit]] = [:]
    private var lastFetch = Date.distantPast
    private var metadataByDir: [String: ClaudeAccount]
    private var verifiedProfiles: [String: (fingerprint: String, account: ClaudeAccount)] = [:]
    private var quotaIdentityByDir: [String: String] = [:]
    private let directories: () -> [String]
    private let tokenReader: ((String) -> String?)?
    private let profileFetcher: ((String) -> [String: Any]?)?
    private let usageFetcher: ((String) -> LiveUsageResult)?

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

    /// Injectable readers keep account-switch regressions independent of the
    /// host's credentials. Only non-secret profile metadata is hydrated.
    init(cachedAccounts: [ClaudeAccount] = [],
         directories: @escaping () -> [String] = { ClaudeDiscovery.discoverDirectories() },
         tokenReader: ((String) -> String?)? = nil,
         profileFetcher: ((String) -> [String: Any]?)? = nil,
         usageFetcher: ((String) -> LiveUsageResult)? = nil) {
        self.metadataByDir = cachedAccounts.reduce(into: [:]) { $0[$1.configDir] = $1 }
        self.directories = directories
        self.tokenReader = tokenReader
        self.profileFetcher = profileFetcher
        self.usageFetcher = usageFetcher
    }

    static func sha256Prefix8(_ str: String) -> String {
        let hash = SHA256.hash(data: Data(str.utf8))
        return hash.map { String(format: "%02x", $0) }.joined().prefix(8).description
    }

    /// All Claude config homes: `$CLAUDE_CONFIG_DIR` → `~/.claude` →
    /// auto-discovered `~/.claude*` variants → `~/.config/claude`.
    /// Shared glob lives in `HomeDiscovery` (cached `$HOME` listing).
    static func discoverDirectories(home: String? = nil) -> [String] {
        var directories = HomeDiscovery.variantDirs(
            prefixes: [".claude"],
            envVars: ["CLAUDE_CONFIG_DIR"],
            defaultPaths: ["~/.claude"],
            configNames: ["claude"],
            home: home)
        if home == nil {
            for path in ManagedCLIProfileStore.shared.profilePaths(for: .claude)
                where HomeDiscovery.isDirectory(path) && !directories.contains(path) {
                directories.append(path)
            }
        }
        return directories
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
        for path in ClaudeProfileIdentity.metadataPaths(for: dir) {
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

    /// Full OAuth material for a profile dir, newest expiry first across its
    /// file and Keychain stores. Explicit CLAUDE_CONFIG_DIR=~/.claude uses the
    /// hashed service even for the default home; an older unscoped login must
    /// not hide that sign-in. Returns the whole
    /// `claudeAiOauth`-style blob (not just the token) so refresh write-back
    /// can preserve sibling fields like `refreshTokenExpiresAt`/`scopes`.
    func readCredentials(for dir: String) -> ClaudeCredentials? {
        var candidates: [ClaudeCredentials] = []
        let credFile = "\(dir)/.credentials.json"
        if let data = FileManager.default.contents(atPath: credFile),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let (key, oauth) = Self.extractOAuth(from: obj) {
            if let credentials = Self.makeCredentials(oauth: oauth, source: .credentialsFile(path: credFile, oauthKey: key)) {
                candidates.append(credentials)
            }
        }

        for svc in ClaudeProfileIdentity.keychainServices(for: dir) {
            if let text = runSecurityFindGenericPassword(service: svc),
               let data = text.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let (key, oauth) = Self.extractOAuth(from: obj) {
                let account = Self.parseKeychainAccount(runSecurityItemAttributes(service: svc)) ?? NSUserName()
                if let credentials = Self.makeCredentials(oauth: oauth, source: .keychain(service: svc, account: account, oauthKey: key)) {
                    candidates.append(credentials)
                }
            }
        }
        return Self.preferredCredentials(candidates)
    }

    /// Equal/unknown expiries preserve discovery order. Comparing only a
    /// profile's allowed stores keeps freshness from crossing account homes.
    static func preferredCredentials(_ candidates: [ClaudeCredentials]) -> ClaudeCredentials? {
        candidates.reduce(nil) { current, candidate in
            guard let current else { return candidate }
            return candidate.expiresAtMs > current.expiresAtMs ? candidate : current
        }
    }

    /// The canonical folder can have two independent Keychain sign-ins. Match
    /// the exact store quota discovery selected, without exposing any tokens or
    /// changing credentials. Custom folders always keep their explicit scope.
    func usesDefaultEnvironmentForLaunch(for dir: String) -> Bool {
        guard ClaudeProfileIdentity.keychainServices(for: dir).first == "Claude Code-credentials" else {
            return false
        }
        return Self.usesDefaultEnvironmentForLaunch(for: dir, source: readCredentials(for: dir)?.source)
    }

    enum AgentLaunchIdentityError: LocalizedError, Equatable {
        case changedSignIn, unverifiedSignIn, missingSignIn

        var errorDescription: String? {
            switch self {
            case .changedSignIn:
                return "The Claude sign-in changed since the account list refreshed. Refresh accounts before opening this profile."
            case .unverifiedSignIn:
                return "This Claude sign-in could not be verified. Refresh accounts or use Manage → Sign in / reconnect… before opening it."
            case .missingSignIn:
                return "This Claude profile is signed out. Use Manage → Sign in / reconnect… before opening it."
            }
        }
    }

    /// Verify the exact current credential selection before an agent starts.
    /// Reading source separately after checking cached metadata can otherwise
    /// launch a different account when the CLI changes logins between polls.
    func verifiedDefaultEnvironmentForAgentLaunch(for dir: String, matchingEmail: String) throws -> Bool {
        guard ClaudeProfileIdentity.keychainServices(for: dir).first == "Claude Code-credentials" else {
            return false
        }
        fetchLock.lock(); defer { fetchLock.unlock() }
        // Launch may precede the first quota poll after restart. Reuse normal
        // refresh/write-back before verifying, then select the stored token
        // and its source together (a concurrent CLI refresh may replace both).
        _ = findAccessToken(for: dir)
        let selected = readCredentials(for: dir)
        return try verifiedDefaultEnvironmentForAgentLaunch(for: dir, matchingEmail: matchingEmail,
                                                           credentials: selected, home: NSHomeDirectory())
    }

    /// Hermetic seam: only synthetic selected credentials are needed to verify
    /// that identity checking and launch scoping use one selection. No tokens
    /// leave this method and it never refreshes or writes credential stores.
    func verifiedDefaultEnvironmentForAgentLaunch(for dir: String, matchingEmail: String,
                                                  credentials: ClaudeCredentials?, home: String) throws -> Bool {
        guard ClaudeProfileIdentity.keychainServices(for: dir, home: home).first == "Claude Code-credentials" else {
            return false
        }
        guard let credentials else {
            prepareQuotaCache(for: ClaudeAccount(configDir: dir), authenticated: false)
            throw AgentLaunchIdentityError.missingSignIn
        }
        guard let account = verifiedAccount(for: dir, token: credentials.accessToken) else {
            prepareQuotaCache(for: ClaudeAccount(configDir: dir), authenticated: false)
            throw AgentLaunchIdentityError.unverifiedSignIn
        }
        prepareQuotaCache(for: account, authenticated: true)
        guard matchingEmail.isEmpty || account.email.caseInsensitiveCompare(matchingEmail) == .orderedSame else {
            throw AgentLaunchIdentityError.changedSignIn
        }
        return Self.usesDefaultEnvironmentForLaunch(for: dir, source: credentials.source, home: home)
    }

    /// Pure credential-source decision for tests and callers that already read
    /// the selected credentials. A file is shared by both canonical launch modes;
    /// absent credentials deliberately keep new sign-ins explicitly scoped.
    static func usesDefaultEnvironmentForLaunch(for dir: String, source: CredentialSource?,
                                               home: String = NSHomeDirectory()) -> Bool {
        guard ClaudeProfileIdentity.keychainServices(for: dir, home: home).first == "Claude Code-credentials", let source,
              case .keychain(let service, _, _) = source else { return false }
        return service == "Claude Code-credentials"
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
        guard let data = runSecurity(arguments: ["find-generic-password", "-s", service]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func runSecurityAddGenericPassword(service: String, account: String, secret: String) -> Bool {
        runSecurity(arguments: ["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret]) != nil
    }

    private func runSecurityFindGenericPassword(service: String) -> String? {
        guard let data = runSecurity(arguments: ["find-generic-password", "-s", service, "-w"]) else { return nil }
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func runSecurity(arguments: [String]) -> Data? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        task.arguments = arguments
        return ClaudeSecurityProcess.runCapture(task)
    }

    func fetchUsageAPI(token: String, timeout: TimeInterval = 8) -> LiveUsageResult {
        fetchAPI(path: "usage", token: token, timeout: timeout)
    }

    private func fetchAPI(path: String, token: String, timeout: TimeInterval = 8) -> LiveUsageResult {
        guard let url = URL(string: "https://api.anthropic.com/api/oauth/\(path)") else {
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
        lock.lock(); defer { lock.unlock() }
        // Live identity belongs to the token, even when a CLI leaves stale
        // oauthAccount metadata behind after switching sign-ins.
        if let verified = verifiedProfiles[dir] { return verified.account }
        // An unauthenticated/copied config is not evidence of an account
        // switch. Keep a known profile identity until its own token verifies
        // the replacement, including across logout and app restarts.
        if var previous = metadataByDir[dir], !previous.email.isEmpty || !previous.accountUuid.isEmpty {
            previous.id = ClaudeProfileIdentity.profileID(for: dir)
            return previous
        }
        let account = Self.accountMetadata(dir: dir, oauth: oauth)
        metadataByDir[dir] = account
        return account
    }

    private static func accountMetadata(dir: String, oauth: [String: Any]?) -> ClaudeAccount {
        let email = oauth?["emailAddress"] as? String ?? ""
        let label = Self.deriveLabel(dir: dir, email: email)

        return ClaudeAccount(
            id: ClaudeProfileIdentity.profileID(for: dir),
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

    /// Profile metadata from the same OAuth token used for quota queries.
    /// Never trust a directory's cached email over the authenticated account.
    static func parseProfilePayload(_ obj: [String: Any], dir: String) -> ClaudeAccount? {
        guard let account = obj["account"] as? [String: Any],
              let uuid = account["uuid"] as? String, !uuid.isEmpty,
              let email = (account["email"] ?? account["email_address"]) as? String,
              !email.isEmpty else { return nil }
        let org = obj["organization"] as? [String: Any] ?? [:]
        return accountMetadata(dir: dir, oauth: [
            "accountUuid": uuid, "emailAddress": email,
            "displayName": account["display_name"] ?? account["full_name"] ?? "",
            "organizationUuid": org["uuid"] ?? "",
            "organizationName": org["name"] ?? "",
            "organizationType": org["organization_type"] ?? "",
            "organizationRateLimitTier": org["rate_limit_tier"] ?? "",
            "hasExtraUsageEnabled": org["has_extra_usage_enabled"] ?? false
        ])
    }

    private func verifiedAccount(for dir: String, token: String) -> ClaudeAccount? {
        let fingerprint = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
        lock.lock()
        let previous = verifiedProfiles[dir]
        lock.unlock()
        if let previous, previous.fingerprint == fingerprint { return previous.account }
        let payload: [String: Any]?
        if let profileFetcher {
            payload = profileFetcher(token)
        } else {
            payload = fetchAPI(path: "profile", token: token).payload
        }
        guard let payload, let account = Self.parseProfilePayload(payload, dir: dir) else {
            lock.lock()
            verifiedProfiles.removeValue(forKey: dir)
            lock.unlock()
            return nil
        }
        lock.lock()
        verifiedProfiles[dir] = (fingerprint, account)
        metadataByDir[dir] = account
        lock.unlock()
        return account
    }

    private func prepareQuotaCache(for account: ClaudeAccount, authenticated: Bool) {
        let dir = account.configDir
        let identity = "\(account.accountUuid)|\(account.organizationUuid)|\(account.email)"
        lock.lock(); defer { lock.unlock() }
        if !authenticated || quotaIdentityByDir[dir] != identity {
            cachedLimitsMap.removeValue(forKey: dir)
            lastSuccessfulLiveLimits.removeValue(forKey: dir)
            backoffUntil.removeValue(forKey: dir)
        }
        quotaIdentityByDir[dir] = authenticated ? identity : nil
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

    func fetchAllLimits(force: Bool = false) -> [ProviderLimit] {
        fetchLock.lock(); defer { fetchLock.unlock() }
        lock.lock()
        if !force && Date().timeIntervalSince(lastFetch) < 90 && !cachedLimitsMap.isEmpty {
            let res = Array(cachedLimitsMap.values.joined())
            lock.unlock()
            return res
        }
        lock.unlock()

        let dirs = directories()
        var accounts: [ClaudeAccount] = []
        var tokensByDir: [String: String] = [:]
        for dir in dirs {
            var account = accountMetadata(for: dir)
            let token: String?
            if let tokenReader {
                token = tokenReader(dir)
            } else {
                token = findAccessToken(for: dir)
            }
            if let token {
                if let verified = verifiedAccount(for: dir, token: token) {
                    account = verified
                    account.quotaStatus = nil
                    tokensByDir[dir] = token
                } else {
                    account.quotaStatus = "Could not verify this Claude sign-in. Quota will retry."
                }
            } else {
                account.quotaStatus = "Sign in to this Claude profile to restore quota tracking."
                lock.lock()
                verifiedProfiles.removeValue(forKey: dir)
                lock.unlock()
            }
            prepareQuotaCache(for: account, authenticated: tokensByDir[dir] != nil)
            accounts.append(account)
        }

        let providerNames = ClaudeProfileIdentity.providerNames(for: accounts)
        var allLimits: [ProviderLimit] = []
        var limitsByDir: [String: [ProviderLimit]] = [:]

        for index in accounts.indices {
            if index > 0 {
                // Keep quota queries sequential to avoid Anthropic 429 bursts.
                Thread.sleep(forTimeInterval: 0.1)
            }
            let acct = accounts[index]
            let providerName = providerNames[acct.configDir] ?? "claude"
            let detail = "\(acct.email.isEmpty ? acct.id : acct.email)\(acct.organizationType.isEmpty ? "" : " · \(acct.organizationType)")"
            // Missing/unverified profile credentials must never borrow another
            // account's live quota or a potentially mismatched disk cache.
            guard let token = tokensByDir[acct.configDir] else {
                limitsByDir[acct.configDir] = []
                continue
            }

            var limits: [ProviderLimit] = []
            var liveThrottled = false
            var authenticationRejected = false
            lock.lock()
            let backedOff = (backoffUntil[acct.configDir] ?? .distantPast) > Date()
            lock.unlock()
            if backedOff {
                liveThrottled = true
            } else {
                let res = usageFetcher?(token) ?? fetchUsageAPI(token: token)
                if let obj = res.payload {
                    limits = PlanLimitsEngine.parseClaudePayload(obj, provider: providerName, detail: detail)
                    if !limits.isEmpty {
                        lock.lock()
                        lastSuccessfulLiveLimits[acct.configDir] = limits
                        backoffUntil.removeValue(forKey: acct.configDir)
                        lock.unlock()
                    }
                } else if res.statusCode == 429 {
                    liveThrottled = true
                    let wait = Self.throttleBackoffDelay(retryAfter: res.retryAfter)
                    lock.lock()
                    backoffUntil[acct.configDir] = Date().addingTimeInterval(wait)
                    lock.unlock()
                    NSLog("[ClaudeDiscovery] %@: usage API throttled (429), backing off %.0fs", acct.id, wait)
                } else if res.statusCode == 401 || res.statusCode == 403 {
                    authenticationRejected = true
                    accounts[index].quotaStatus = "Claude sign-in expired. Sign in to this profile again."
                    prepareQuotaCache(for: acct, authenticated: false)
                }
            }

            if limits.isEmpty && !authenticationRejected {
                lock.lock()
                let prevLive = lastSuccessfulLiveLimits[acct.configDir] ?? []
                let prevMem = cachedLimitsMap[acct.configDir] ?? []
                lock.unlock()
                // Relabel remembered rows after a directory/label collision
                // changes; their account identity was checked above.
                let previous = prevLive.isEmpty ? prevMem : prevLive
                if !previous.isEmpty {
                    limits = Self.markStale(previous.map { row in
                        var row = row
                        row.provider = providerName
                        row.detail = detail
                        return row
                    }, throttled: liveThrottled)
                } else {
                    let (oauth, cachedUsage) = readClaudeJson(for: acct.configDir)
                    // A CLI may leave cached utilization belonging to its old
                    // login. Only use it when both account and org still match.
                    let diskIdentity = Self.accountMetadata(dir: acct.configDir, oauth: oauth)
                    if diskIdentity.accountUuid == acct.accountUuid &&
                        diskIdentity.organizationUuid == acct.organizationUuid {
                        let fb = Self.diskFallbackLimits(
                            cachedUsage: cachedUsage, provider: providerName, detail: detail)
                        limits = Self.markStale(fb.limits, throttled: liveThrottled)
                    }
                }
                if limits.isEmpty {
                    accounts[index].quotaStatus = liveThrottled
                        ? "Quota refresh is rate-limited. It will retry automatically."
                        : "Quota is temporarily unavailable. It will retry automatically."
                }
            }
            limitsByDir[acct.configDir] = limits
            allLimits.append(contentsOf: limits)
        }

        lock.lock()
        cachedLimitsMap = limitsByDir
        for index in accounts.indices {
            let dir = accounts[index].configDir
            accounts[index].limits = limitsByDir[dir] ?? []
            metadataByDir[dir] = accounts[index]
            if verifiedProfiles[dir] != nil {
                verifiedProfiles[dir]?.account = accounts[index]
            }
        }
        cachedAccounts = accounts
        lastFetch = Date()
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

/// The Keychain CLI can emit more than a pipe's capacity. Capture to private
/// files before waiting, and bound prompts/tool failures without logging secrets.
/// Internal so tests run the actual helper with hermetic child executables.
enum ClaudeSecurityProcess {
    static func runCapture(_ task: Process, timeout: TimeInterval = 8,
                           temporaryDirectory: URL = FileManager.default.temporaryDirectory) -> Data? {
        guard timeout.isFinite, timeout > 0, !task.isRunning,
              let directory = privateDirectory(in: temporaryDirectory) else { return nil }
        defer { try? FileManager.default.removeItem(at: directory) }
        let outputURL = directory.appendingPathComponent("stdout")
        guard let output = privateFile(at: outputURL),
              let errors = privateFile(at: directory.appendingPathComponent("stderr")) else { return nil }
        defer { try? output.close(); try? errors.close() }
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = output
        task.standardError = errors
        do {
            try task.run()
            guard waitForExit(task, timeout: timeout) else {
                // Only this Process's spawned child is signaled. No broad
                // process-name matching or existing Keychain processes.
                if task.isRunning { task.terminate() }
                if !waitForExit(task, timeout: 0.1), task.isRunning {
                    _ = kill(task.processIdentifier, SIGKILL)
                }
                _ = waitForExit(task, timeout: 0.5)
                return nil
            }
            guard task.terminationStatus == 0 else { return nil }
            let reader = try FileHandle(forReadingFrom: outputURL)
            defer { try? reader.close() }
            let maximumOutput = 4 * 1024 * 1024
            let data = try reader.read(upToCount: maximumOutput + 1) ?? Data()
            guard data.count <= maximumOutput else { return nil }
            return data
        } catch {
            return nil
        }
    }

    private static func waitForExit(_ task: Process, timeout: TimeInterval) -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        while task.isRunning {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { return false }
            // Polling avoids depending on a termination callback obtaining a
            // dispatch worker when a provider has already exhausted the pool.
            Thread.sleep(forTimeInterval: min(0.01, remaining))
        }
        return true
    }

    private static func privateDirectory(in parent: URL) -> URL? {
        var template = Array(parent.appendingPathComponent("token-horizon-claude-security.XXXXXX").path.utf8CString)
        let path = template.withUnsafeMutableBufferPointer { buffer -> String? in
            guard let base = buffer.baseAddress, let created = mkdtemp(base) else { return nil }
            return String(cString: created)
        }
        return path.map { URL(fileURLWithPath: $0, isDirectory: true) }
    }

    private static func privateFile(at url: URL) -> FileHandle? {
        let descriptor = url.path.withCString { Darwin.open($0, O_RDWR | O_CREAT | O_EXCL, mode_t(0o600)) }
        guard descriptor >= 0 else { return nil }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }
}
