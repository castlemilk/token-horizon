import Foundation
import CryptoKit

final class ClaudeDiscovery {
    static let shared = ClaudeDiscovery()
    private let lock = NSLock()
    private var cachedAccounts: [ClaudeAccount] = []
    private var cachedLimitsMap: [String: [ProviderLimit]] = [:]
    private var lastSuccessfulLiveLimits: [String: [ProviderLimit]] = [:]
    private var lastFetch = Date.distantPast

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

    func fetchUsageAPI(token: String, timeout: TimeInterval = 8) -> [String: Any]? {
        guard let url = URL(string: "https://api.anthropic.com/api/oauth/usage") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("claude-code/0.2.29", forHTTPHeaderField: "User-Agent")
        var resultData: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                resultData = d
            }
            sema.signal()
        }.resume()
        _ = sema.wait(timeout: .now() + timeout)
        guard let resultData,
              let obj = try? JSONSerialization.jsonObject(with: resultData) as? [String: Any] else {
            return nil
        }
        return obj
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
            if let token = self.findAccessToken(for: acct.configDir),
               let liveObj = self.fetchUsageAPI(token: token) {
                limits = PlanLimitsEngine.parseClaudePayload(liveObj, provider: providerName, detail: detail)
                if !limits.isEmpty {
                    self.lock.lock()
                    self.lastSuccessfulLiveLimits[acct.configDir] = limits
                    self.lock.unlock()
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
                    // 2. Only fall back to .claude.json if disk cache is fresh (< 2 hours old)
                    let (_, cachedUsage) = self.readClaudeJson(for: acct.configDir)
                    let fetchedAtMs = cachedUsage?["fetchedAtMs"] as? Double ?? 0
                    let ageSeconds = Date().timeIntervalSince1970 - (fetchedAtMs / 1000.0)
                    if ageSeconds > 0 && ageSeconds < 7200 {
                        if let util = cachedUsage?["utilization"] as? [String: Any] {
                            limits = PlanLimitsEngine.parseClaudePayload(util, provider: providerName, detail: detail)
                        }
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
