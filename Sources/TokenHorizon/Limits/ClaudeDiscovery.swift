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
    static func discoverDirectories() -> [String] {
        HomeDiscovery.variantDirs(
            prefixes: [".claude"],
            envVars: ["CLAUDE_CONFIG_DIR"],
            defaultPaths: ["~/.claude"],
            configNames: ["claude"])
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

    func findAccessToken(for dir: String) -> String? {
        let credFile = "\(dir)/.credentials.json"
        if let data = FileManager.default.contents(atPath: credFile),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let token = extractToken(from: obj) { return token }
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
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let token = extractToken(from: obj) { return token }
            }
        }
        return nil
    }

    private func extractToken(from obj: [String: Any]) -> String? {
        if let ai = obj["claudeAiOauth"] as? [String: Any],
           let token = ai["accessToken"] as? String, !token.isEmpty {
            return token
        }
        if let oauth = obj["oauth"] as? [String: Any],
           let token = oauth["accessToken"] as? String, !token.isEmpty {
            return token
        }
        if let co = obj["claudeOAuth"] as? [String: Any],
           let token = co["accessToken"] as? String, !token.isEmpty {
            return token
        }
        return nil
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
