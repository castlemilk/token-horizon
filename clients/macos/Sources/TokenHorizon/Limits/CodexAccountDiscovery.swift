import Foundation
import CryptoKit

/// Displayable account metadata only. OAuth material remains in each CLI's
/// original credential store and is never included in snapshots or UI state.
struct CodexAccount: Codable, Identifiable {
    var id: String
    var accountId: String = ""
    var email: String = ""
    var displayName: String = ""
    var planType: String = ""
    var label: String = ""
    var configDirs: [String] = []
    var authPaths: [String] = []
    var profileStatuses: [String: String] = [:]
    var limits: [ProviderLimit] = []
    var quotaStatus: String?
    var updatedAt: Date = Date()
}

/// Discovers independent CODEX_HOME sign-ins and deduplicates quota polling
/// by ChatGPT workspace/account ID, rather than choosing one global login.
final class CodexAccountDiscovery {
    struct UsageResult {
        var payload: [String: Any]?
        var statusCode: Int
        var retryAfter: TimeInterval? = nil
    }

    static let shared = CodexAccountDiscovery(cachedAccounts: DurableStore.shared.loadSnapshot()?.codexAccounts ?? [])
    private let lock = NSLock()
    private let fetchLock = NSLock()
    private let directories: () -> [String]
    private let opencodePaths: () -> [String]
    private let fileReader: (String) -> Data?
    private let authRefresher: (PlanLimitsEngine.OpenAIAuth) -> PlanLimitsEngine.OpenAIAuth
    private let usageFetcher: (PlanLimitsEngine.OpenAIAuth) -> UsageResult
    private let clock: THClock
    private var cachedAccounts: [CodexAccount]
    private var lastSuccessfulLimits: [String: [ProviderLimit]] = [:]
    private var backoffUntil: [String: Date] = [:]
    private var quotaCredentialByID: [String: String] = [:]
    private var lastFetch = Date.distantPast

    init(cachedAccounts: [CodexAccount] = [],
         directories: @escaping () -> [String] = { CodexAccountDiscovery.discoverDirectories() },
         opencodePaths: @escaping () -> [String] = {
             HomeDiscovery.opencodeAuthCandidates().map(HomeDiscovery.expand)
         },
         fileReader: @escaping (String) -> Data? = { FileManager.default.contents(atPath: $0) },
         authRefresher: @escaping (PlanLimitsEngine.OpenAIAuth) -> PlanLimitsEngine.OpenAIAuth = {
             PlanLimitsEngine.ensureFreshOpenAIAuth($0)
         },
         usageFetcher: @escaping (PlanLimitsEngine.OpenAIAuth) -> UsageResult = {
             CodexAccountDiscovery.fetchUsage(auth: $0)
         },
         clock: THClock = SystemClock()) {
        self.cachedAccounts = cachedAccounts
        self.directories = directories
        self.opencodePaths = opencodePaths
        self.fileReader = fileReader
        self.authRefresher = authRefresher
        self.usageFetcher = usageFetcher
        self.clock = clock
        // A recent persisted quota is safe only under the same known account
        // ID. Keep it through the first transient refresh after a restart;
        // opaque credentials cannot prove that identity across launches.
        for account in cachedAccounts where !account.accountId.isEmpty && !account.limits.isEmpty {
            let age = clock.now().timeIntervalSince(account.updatedAt)
            if age >= 0 && age <= 7_200 { lastSuccessfulLimits[account.id] = account.limits }
        }
    }

    /// An explicit home/environment keeps directory discovery hermetic.
    /// Managed homes can live outside the ordinary ~/.codex* convention.
    static func discoverDirectories(home: String? = nil, environment: [String: String]? = nil,
                                    managedDirectories: [String]? = nil) -> [String] {
        let root = home ?? NSHomeDirectory()
        let env = environment ?? (home == nil ? ProcessInfo.processInfo.environment : [:])
        let managed = managedDirectories ?? (home == nil
            ? ManagedCLIProfileStore.shared.profilePaths(for: .codex) : [])
        var result: [String] = []
        func add(_ raw: String) {
            let path = normalizedPath(raw, home: root)
            guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  HomeDiscovery.isDirectory(path), !result.contains(path) else { return }
            result.append(path)
        }
        if let override = env["CODEX_HOME"] { add(override) }
        add("\(root)/.codex")
        for name in HomeDiscovery.homeEntries(home: home).sorted() where name.hasPrefix(".codex") {
            add("\(root)/\(name)")
        }
        add("\(root)/.config/codex")
        for path in managed { add(path) }
        return result
    }

    func accounts() -> [CodexAccount] {
        lock.lock(); defer { lock.unlock() }
        return cachedAccounts
    }

    func account(forConfigDir dir: String) -> CodexAccount? {
        let path = Self.normalizedPath(dir)
        lock.lock(); defer { lock.unlock() }
        return cachedAccounts.first { $0.configDirs.contains(path) }
    }

    private struct Candidate {
        var auth: PlanLimitsEngine.OpenAIAuth
        var account: CodexAccount
        var path: String
        var configDir: String?
    }

    func fetchAllLimits(force: Bool = false) -> [ProviderLimit] {
        // Different refresh surfaces may ask together; a second request must
        // not race token rotation or publish an older account snapshot.
        fetchLock.lock(); defer { fetchLock.unlock() }
        lock.lock()
        let previousAccounts = cachedAccounts
        let recentlyFetched = clock.now().timeIntervalSince(lastFetch) < 90
        lock.unlock()
        if !force && recentlyFetched { return previousAccounts.flatMap(\.limits) }

        var candidates: [Candidate] = []
        var unavailable: [CodexAccount] = []
        let homes = Self.unique(directories().map { Self.normalizedPath($0) })
        for dir in homes {
            let path = "\(dir)/auth.json"
            let root = readJSON(path)
            if let root, let candidate = candidate(root: root, path: path, configDir: dir, opencode: false) {
                candidates.append(candidate)
            } else {
                let status = unavailableStatus(root: root, dir: dir)
                var account = previousAccounts.first { $0.configDirs.contains(dir) }
                    ?? Self.emptyAccount(path: path)
                account.configDirs = [dir]
                account.authPaths = [path]
                account.profileStatuses = [dir: status]
                account.quotaStatus = status
                account.limits = []
                account.label = Self.label(for: account)
                unavailable.append(account)
            }
        }
        for path in Self.unique(opencodePaths().map { Self.normalizedPath($0) }) {
            guard let root = readJSON(path),
                  let candidate = candidate(root: root, path: path, configDir: nil, opencode: true) else { continue }
            candidates.append(candidate)
        }

        // Refresh only the freshest login for an account. Duplicate stores
        // can contain the same single-use refresh grant; rotating all copies
        // would invalidate a CLI's token needlessly.
        let initialGroups = Dictionary(grouping: candidates.indices, by: { candidates[$0].account.id })
        for indices in initialGroups.values {
            guard let selected = indices.max(by: {
                Self.expiry(candidates[$0].auth) < Self.expiry(candidates[$1].auth)
            }) else { continue }
            let stored = candidates[selected]
            let refreshed = authRefresher(stored.auth)
            let root = readJSON(stored.path)
            // The write-back helper may adopt a CLI's concurrent account
            // switch. Only read an ID token from the matching access token.
            let matchingRoot = root.flatMap { self.accessToken(root: $0, opencode: stored.configDir == nil) == refreshed.accessToken ? $0 : nil }
            var updated = metadata(auth: refreshed, root: matchingRoot,
                                   path: stored.path, configDir: stored.configDir,
                                   opencode: stored.configDir == nil)
            if updated.accountId == stored.account.accountId {
                if updated.email.isEmpty { updated.email = stored.account.email }
                if updated.displayName.isEmpty { updated.displayName = stored.account.displayName }
                if updated.planType.isEmpty { updated.planType = stored.account.planType }
                updated.label = Self.label(for: updated)
            }
            var scopedAuth = refreshed
            scopedAuth.accountId = updated.accountId
            candidates[selected] = Candidate(auth: scopedAuth, account: updated,
                                             path: stored.path, configDir: stored.configDir)
        }

        // Regroup after refresh so an adopted replacement token is attributed
        // to its own workspace rather than the old account's cached quotas.
        let groups = Dictionary(grouping: candidates, by: { $0.account.id })
        var accounts: [CodexAccount] = []
        var authByID: [String: PlanLimitsEngine.OpenAIAuth] = [:]
        for (_, group) in groups {
            guard let selected = group.max(by: { Self.expiry($0.auth) < Self.expiry($1.auth) }) else { continue }
            var account = selected.account
            account.configDirs = Self.unique(group.compactMap(\.configDir)).sorted()
            account.authPaths = Self.unique(group.map(\.path)).sorted()
            account.limits = []
            account.quotaStatus = nil
            for missing in unavailable where missing.id == account.id {
                account.configDirs = Self.unique(account.configDirs + missing.configDirs).sorted()
                account.authPaths = Self.unique(account.authPaths + missing.authPaths).sorted()
                account.profileStatuses.merge(missing.profileStatuses) { _, status in status }
            }
            authByID[account.id] = selected.auth
            accounts.append(account)
        }
        for missing in unavailable where authByID[missing.id] == nil {
            if let index = accounts.firstIndex(where: { $0.id == missing.id }) {
                accounts[index].configDirs = Self.unique(accounts[index].configDirs + missing.configDirs).sorted()
                accounts[index].authPaths = Self.unique(accounts[index].authPaths + missing.authPaths).sorted()
                accounts[index].profileStatuses.merge(missing.profileStatuses) { _, status in status }
            } else {
                accounts.append(missing)
            }
        }
        accounts.sort { ($0.email.isEmpty ? $0.label : $0.email, $0.id) < ($1.email.isEmpty ? $1.label : $1.email, $1.id) }
        let providerNames = Self.providerNames(for: accounts)
        for index in accounts.indices {
            let id = accounts[index].id
            guard let auth = authByID[id] else { continue }
            let provider = providerNames[id] ?? "codex"
            let account = accounts[index]
            let detail = account.email.isEmpty ? account.label : account.email
            // Opaque credentials without a workspace ID cannot establish that
            // a replacement token belongs to the previous account.
            if auth.accountId.isEmpty {
                let fingerprint = Self.hash(auth.accessToken)
                if quotaCredentialByID[id] != fingerprint {
                    lastSuccessfulLimits.removeValue(forKey: id)
                    backoffUntil.removeValue(forKey: id)
                }
                quotaCredentialByID[id] = fingerprint
            }
            let backedOff = (backoffUntil[id] ?? .distantPast) > clock.now()
            let result = backedOff ? UsageResult(payload: nil, statusCode: 429) : usageFetcher(auth)
            if let payload = result.payload {
                var rows = Self.parseUsagePayload(payload)
                rows = Self.relabel(rows, provider: provider, detail: detail, marker: nil)
                if !rows.isEmpty {
                    lastSuccessfulLimits[id] = rows
                    backoffUntil.removeValue(forKey: id)
                    accounts[index].limits = rows
                    if let plan = payload["plan_type"] as? String { accounts[index].planType = plan }
                }
            }
            if result.statusCode == 401 || result.statusCode == 403 {
                lastSuccessfulLimits.removeValue(forKey: id)
                backoffUntil.removeValue(forKey: id)
                accounts[index].quotaStatus = "Codex sign-in expired. Sign in to this profile again."
            } else if accounts[index].limits.isEmpty {
                if result.statusCode == 429 && !backedOff {
                    let delay = min(max(result.retryAfter ?? 300, 60), 86_400)
                    backoffUntil[id] = clock.now().addingTimeInterval(delay)
                }
                let marker = result.statusCode == 429 ? "rate-limited" : "stale"
                accounts[index].limits = Self.relabel(lastSuccessfulLimits[id] ?? [],
                                                       provider: provider, detail: detail, marker: marker)
                accounts[index].quotaStatus = result.statusCode == 429
                    ? "Quota refresh is rate-limited. It will retry automatically."
                    : "Quota is temporarily unavailable. It will retry automatically."
            }
            accounts[index].updatedAt = clock.now()
        }
        // Quota memory is account-scoped and bounded by currently discovered
        // identities. An old signed-out account cannot revive another quota.
        let active = Set(accounts.filter { authByID[$0.id] != nil }.map(\.id))
        lastSuccessfulLimits = lastSuccessfulLimits.filter { active.contains($0.key) }
        backoffUntil = backoffUntil.filter { active.contains($0.key) }
        quotaCredentialByID = quotaCredentialByID.filter { active.contains($0.key) }
        lock.lock()
        cachedAccounts = accounts
        lastFetch = clock.now()
        lock.unlock()
        return accounts.flatMap(\.limits)
    }

    private func readJSON(_ path: String) -> [String: Any]? {
        guard let data = fileReader(path) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func accessToken(root: [String: Any], opencode: Bool) -> String? {
        let entry = root[opencode ? "openai" : "tokens"] as? [String: Any]
        return entry?[opencode ? "access" : "access_token"] as? String
    }

    private func candidate(root: [String: Any], path: String, configDir: String?, opencode: Bool) -> Candidate? {
        if !opencode, ["apikey", "api_key"].contains(root["auth_mode"] as? String ?? "") { return nil }
        guard let entry = root[opencode ? "openai" : "tokens"] as? [String: Any],
              let access = entry[opencode ? "access" : "access_token"] as? String,
              !access.isEmpty else { return nil }
        let expiryMs = (entry["expires"] as? NSNumber)?.doubleValue ?? 0
        var auth = PlanLimitsEngine.OpenAIAuth(
            accessToken: access,
            refreshToken: entry[opencode ? "refresh" : "refresh_token"] as? String ?? "",
            expiresAt: opencode && expiryMs > 0 ? Date(timeIntervalSince1970: expiryMs / 1000) : OAuthRefresh.jwtExpiry(access),
            accountId: entry[opencode ? "accountId" : "account_id"] as? String ?? "",
            source: opencode ? .opencodeFile(path: path) : .codexFile(path: path))
        let account = metadata(auth: auth, root: root, path: path, configDir: configDir, opencode: opencode)
        auth.accountId = account.accountId
        return Candidate(auth: auth, account: account, path: path, configDir: configDir)
    }

    private func metadata(auth: PlanLimitsEngine.OpenAIAuth, root: [String: Any]?, path: String,
                          configDir: String?, opencode: Bool) -> CodexAccount {
        let access = OAuthRefresh.jwtPayload(auth.accessToken) ?? [:]
        let entry = root?[opencode ? "openai" : "tokens"] as? [String: Any] ?? [:]
        let idToken = entry["id_token"] as? String ?? entry["idToken"] as? String ?? ""
        let identity = OAuthRefresh.jwtPayload(idToken) ?? [:]
        let accessAuth = access["https://api.openai.com/auth"] as? [String: Any] ?? [:]
        let identityAuth = identity["https://api.openai.com/auth"] as? [String: Any] ?? [:]
        let profile = access["https://api.openai.com/profile"] as? [String: Any] ?? [:]
        let accountId = Self.nonEmpty(accessAuth["chatgpt_account_id"] as? String)
            ?? Self.nonEmpty(auth.accountId)
            ?? Self.nonEmpty(identityAuth["chatgpt_account_id"] as? String) ?? ""
        // ID-token hints must not override a different current access token.
        let identityMatches = (identityAuth["chatgpt_account_id"] as? String).map { $0 == accountId } ?? true
        let email = Self.nonEmpty(profile["email"] as? String)
            ?? Self.nonEmpty(access["email"] as? String)
            ?? (identityMatches ? Self.nonEmpty(identity["email"] as? String) : nil)
            ?? Self.nonEmpty(entry["email"] as? String) ?? ""
        var account = CodexAccount(id: accountId.isEmpty ? "codex-profile-\(Self.hash(path))" : "codex-\(Self.hash(accountId))",
                                   accountId: accountId, email: email,
                                   displayName: identityMatches ? identity["name"] as? String ?? "" : "",
                                   planType: accessAuth["chatgpt_plan_type"] as? String
                                       ?? (identityMatches ? identityAuth["chatgpt_plan_type"] as? String : nil) ?? "",
                                   configDirs: configDir.map { [$0] } ?? [], authPaths: [path])
        account.label = Self.label(for: account)
        return account
    }

    private func unavailableStatus(root: [String: Any]?, dir: String) -> String {
        if Self.nonEmpty(root?["OPENAI_API_KEY"] as? String) != nil ||
            ["apikey", "api_key"].contains(root?["auth_mode"] as? String ?? "") {
            return "This profile uses an API key. ChatGPT plan quotas require a ChatGPT sign-in."
        }
        let config = fileReader("\(dir)/config.toml").flatMap { String(data: $0, encoding: .utf8) } ?? ""
        let credentialStore = #"(?m)^\s*cli_auth_credentials_store\s*=\s*["'](keyring|auto|ephemeral)["']"#
        if config.range(of: credentialStore, options: .regularExpression) != nil {
            return "This profile uses the system credential store or an in-memory sign-in. File-based Codex sign-in is required for quota tracking."
        }
        return "Sign in to this Codex profile to restore quota tracking."
    }

    static func providerNames(for accounts: [CodexAccount]) -> [String: String] {
        guard accounts.count > 1 else { return accounts.first.map { [$0.id: "codex"] } ?? [:] }
        let labels = Dictionary(grouping: accounts, by: { label(for: $0) })
        var result: [String: String] = [:]
        for account in accounts {
            let label = Self.label(for: account)
            let display = (labels[label]?.count ?? 0) > 1 ? "\(label) · \(account.id.suffix(8))" : label
            result[account.id] = "codex (\(display))"
        }
        return result
    }

    /// Mirrors the existing quota parser while retaining secondary windows
    /// (a 5h burst and 7d cycle can be reported together).
    static func parseUsagePayload(_ payload: [String: Any]) -> [ProviderLimit] {
        var rows: [ProviderLimit] = []
        func windows(_ rate: [String: Any], name: String = "") {
            for key in ["primary_window", "secondary_window"] {
                guard let window = rate[key] as? [String: Any],
                      let used = (window["used_percent"] as? NSNumber)?.doubleValue,
                      used.isFinite else { continue }
                let seconds = (window["limit_window_seconds"] as? NSNumber)?.intValue ?? 604_800
                let windowLabel = PlanLimitsEngine.windowLabel(seconds: seconds)
                rows.append(ProviderLimit(provider: "codex", label: name.isEmpty ? windowLabel : "\(name.lowercased()) \(windowLabel)",
                                          usedPercent: min(max(used, 0), 100),
                                          resetsAt: (window["reset_at"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) },
                                          detail: ""))
            }
        }
        if let rate = payload["rate_limit"] as? [String: Any] { windows(rate) }
        for extra in payload["additional_rate_limits"] as? [[String: Any]] ?? [] {
            if let rate = extra["rate_limit"] as? [String: Any] {
                windows(rate, name: extra["limit_name"] as? String ?? "")
            }
        }
        return rows
    }

    private static func fetchUsage(auth: PlanLimitsEngine.OpenAIAuth) -> UsageResult {
        guard let url = URL(string: "https://chatgpt.com/backend-api/wham/usage") else {
            return UsageResult(payload: nil, statusCode: -1)
        }
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.setValue("Bearer \(auth.accessToken)", forHTTPHeaderField: "Authorization")
        if !auth.accountId.isEmpty { request.setValue(auth.accountId, forHTTPHeaderField: "ChatGPT-Account-ID") }
        request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        var result = UsageResult(payload: nil, statusCode: -1)
        let resultLock = NSLock()
        let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse else { return }
            resultLock.lock(); defer { resultLock.unlock() }
            result.statusCode = http.statusCode
            result.retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
            if (200..<300).contains(http.statusCode), let data {
                result.payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            }
        }.resume()
        _ = semaphore.wait(timeout: .now() + 8)
        resultLock.lock(); defer { resultLock.unlock() }
        return result
    }

    private static func relabel(_ rows: [ProviderLimit], provider: String, detail: String,
                                marker: String?) -> [ProviderLimit] {
        rows.map { original in
            var row = original
            row.provider = provider
            row.detail = marker.map { detail.isEmpty ? $0 : "\(detail) · \($0)" } ?? detail
            return row
        }
    }

    private static func emptyAccount(path: String) -> CodexAccount {
        var account = CodexAccount(id: "codex-profile-\(hash(path))", authPaths: [path])
        account.label = label(for: account)
        return account
    }

    private static func label(for account: CodexAccount) -> String {
        if !account.email.isEmpty { return account.email }
        if let directory = account.configDirs.first {
            return (directory as NSString).lastPathComponent.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        }
        if !account.accountId.isEmpty { return String(account.accountId.suffix(8)) }
        return "opencode"
    }

    private static func expiry(_ auth: PlanLimitsEngine.OpenAIAuth) -> Date { auth.expiresAt ?? .distantPast }
    private static func nonEmpty(_ value: String?) -> String? {
        value.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    }
    private static func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }
    private static func hash(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description
    }
    private static func normalizedPath(_ path: String, home: String = NSHomeDirectory()) -> String {
        let expanded = path == "~" ? home : (path.hasPrefix("~/") ? home + String(path.dropFirst()) : path)
        return URL(fileURLWithPath: expanded).standardizedFileURL.path
    }
}
