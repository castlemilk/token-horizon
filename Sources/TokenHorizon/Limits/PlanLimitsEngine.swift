import Foundation

final class PlanLimitsEngine {
    static let shared = PlanLimitsEngine()
    private let lock = NSLock()
    private var cache: [ProviderLimit] = []
    private var lastFetch = Date.distantPast

    func cachedLimits() -> [ProviderLimit] {
        lock.lock(); defer { lock.unlock() }
        return cache
    }

    func refreshNow() {
        lock.lock()
        lastFetch = .distantPast
        lock.unlock()
        refreshIfDue(maxAge: .infinity)
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
            let limits = Self.fetchAll()
            self?.lock.lock()
            self?.cache = limits
            self?.lock.unlock()
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: Notification.Name("planLimitsUpdated"), object: limits)
            }
        }
    }

    /// opencode `auth.json` keys, trying `OPENCODE_AUTH` then the known
    /// fallback locations (`~/.local/share/...`, `~/.config/...`,
    /// `~/.opencode/...`). First file that parses wins.
    static func authKeys() -> [String: String] {
        for raw in HomeDiscovery.opencodeAuthCandidates() {
            let path = HomeDiscovery.expand(raw)
            guard let data = FileManager.default.contents(atPath: path),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { continue }
            var out: [String: String] = [:]
            for (provider, entry) in obj {
                if let key = entry["key"] as? String, !key.isEmpty {
                    out[provider] = key
                }
            }
            if !out.isEmpty { return out }
        }
        return [:]
    }

    /// Full auth entry (key + metadata like OpenAI `accountId`) for one
    /// provider, searched across the same candidate files as `authKeys()`.
    static func authEntry(provider: String) -> [String: Any]? {
        for raw in HomeDiscovery.opencodeAuthCandidates() {
            let path = HomeDiscovery.expand(raw)
            guard let data = FileManager.default.contents(atPath: path),
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let entry = root[provider] as? [String: Any] else { continue }
            return entry
        }
        return nil
    }

    static func fetchAll() -> [ProviderLimit] {
        let keys = authKeys()
        var tasks: [() -> [ProviderLimit]] = []
        if let key = keys["zai-coding-plan"] ?? keys["zai"] { tasks.append { zai(key) } }
        if let key = keys["minimax-coding-plan"] { tasks.append { minimax(key) } }
        if let key = keys["opencode-go"] { tasks.append { opencodeGo(key) } }
        tasks.append { alibaba() }
        tasks.append { gemini() }
        tasks.append { claude() }
        tasks.append { deepseek() }
        tasks.append { openai() }
        // Independent network calls: run concurrently so one slow provider
        // can't stall the whole /limits response (MCP/UI timeouts used to fire
        // and the list looked frozen). Order is preserved by index.
        var results = Array(repeating: [ProviderLimit](), count: tasks.count)
        let group = DispatchGroup()
        let queue = DispatchQueue(label: "token-horizon.plan-limits.fetch", attributes: .concurrent)
        for i in tasks.indices {
            queue.async(group: group) {
                results[i] = tasks[i]()
            }
        }
        group.wait()
        return results.flatMap { $0 }
    }

    // GET https://bailian-singapore-cs.alibabacloud.com/data/api.json
    //   ?action=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage&product=sfm_bailian
    // Cookie-authenticated Bailian rolling-window API (Personal/Solo).
    // usage.per5HourPercentage / per1WeekPercentage are 0-1 ratios.
    private static func alibaba() -> [ProviderLimit] {
        let env = ProcessInfo.processInfo.environment
        var cookie = ""
        if let path = ProcessInfo.processInfo.environment["ALIBABA_COOKIE_FILE"] {
            cookie = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        }
        if cookie.isEmpty, let env = ProcessInfo.processInfo.environment["ALIBABA_TOKEN_PLAN_COOKIE"] {
            cookie = env
        }
        if cookie.isEmpty {
            let path = NSString(string: "~/.config/token-horizon/alibaba-cookie.txt").expandingTildeInPath
            cookie = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        }
        if cookie.isEmpty { cookie = SettingsStore.shared.alibabaCookie }
        if cookie.isEmpty { cookie = env["ALIBABA_TOKEN_PLAN_COOKIE"] ?? "" }
        guard !cookie.isEmpty, cookie.contains("=") else { return [] }
        if cookie.lowercased().hasPrefix("cookie:") {
            cookie = String(cookie.dropFirst(7)).trimmingCharacters(in: .whitespaces)
        }

        let host = env["ALIBABA_TOKEN_PLAN_HOST"] ?? "https://bailian-singapore-cs.alibabacloud.com"
        let dashboardOrigin = "https://modelstudio.console.alibabacloud.com"
        let dashboardURL = dashboardOrigin + "/ap-southeast-1/?tab=plan#/efm/subscription/token-plan"
        let usageAPI = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage"

        var secToken = ""
        if let dashURL = URL(string: dashboardURL.replacingOccurrences(of: "#/efm/subscription/token-plan", with: "")) {
            var dashReq = URLRequest(url: dashURL, timeoutInterval: 10)
            dashReq.setValue(cookie, forHTTPHeaderField: "Cookie")
            dashReq.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", forHTTPHeaderField: "User-Agent")
            var dashData: Data?
            let dashSema = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: dashReq) { d, resp, _ in
                if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { dashData = d }
                dashSema.signal()
            }.resume()
            _ = dashSema.wait(timeout: .now() + 10)
            if let dashData, let html = String(data: dashData, encoding: .utf8) {
                secToken = extractSecToken(from: html) ?? ""
            }
        }

        var cornerstone: [String: Any] = [
            "feTraceId": UUID().uuidString.lowercased(),
            "feURL": dashboardURL,
            "protocol": "V2",
            "console": "ONE_CONSOLE",
            "productCode": "p_efm",
            "switchUserType": 3,
            "domain": "modelstudio.console.alibabacloud.com",
            "consoleSite": "MODELSTUDIO_ALBABACLOUD",
            "userNickName": "",
            "userPrincipalName": "",
            "xsp_lang": "en-US",
        ]
        if let cna = cookieValue(name: "cna", from: cookie), !cna.isEmpty {
            cornerstone["X-Anonymous-Id"] = cna
        }
        let params: [String: Any] = [
            "Api": usageAPI,
            "V": "1.0",
            "Data": ["cornerstoneParam": cornerstone],
        ]
        guard let paramsData = try? JSONSerialization.data(withJSONObject: params),
              let paramsJSON = String(data: paramsData, encoding: .utf8) else { return [] }

        var body = URLComponents()
        var bodyItems = [
            URLQueryItem(name: "product", value: "sfm_bailian"),
            URLQueryItem(name: "action", value: "IntlBroadScopeAspnGateway"),
            URLQueryItem(name: "region", value: "ap-southeast-1"),
            URLQueryItem(name: "language", value: "en-US"),
            URLQueryItem(name: "params", value: paramsJSON),
        ]
        if !secToken.isEmpty { bodyItems.append(URLQueryItem(name: "sec_token", value: secToken)) }
        body.queryItems = bodyItems

        guard let url = URL(string: "\(host)/data/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=\(usageAPI)&_v=undefined") else { return [] }
        var req = URLRequest(url: url, timeoutInterval: 12)
        req.httpMethod = "POST"
        req.httpBody = Data((body.percentEncodedQuery ?? "").utf8)
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        req.setValue(cookie, forHTTPHeaderField: "Cookie")
        req.setValue("XMLHttpRequest", forHTTPHeaderField: "X-Requested-With")
        req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", forHTTPHeaderField: "User-Agent")
        req.setValue(dashboardOrigin, forHTTPHeaderField: "Origin")
        req.setValue(dashboardURL, forHTTPHeaderField: "Referer")
        if let csrf = cookieValue(name: "login_aliyunid_csrf", from: cookie) {
            req.setValue(csrf, forHTTPHeaderField: "x-xsrf-token")
            req.setValue(csrf, forHTTPHeaderField: "x-csrf-token")
        }

        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 8) == .timedOut { return [] }
        var out: [ProviderLimit] = []
        for attempt in 0..<3 {
            guard let data, let raw = try? JSONSerialization.jsonObject(with: data) else { return [] }
            out = parseAlibabaPayload(raw)
            if !out.isEmpty { break }
            if attempt < 2 { Thread.sleep(forTimeInterval: 0.4) }
        }
        return out
    }

    static func parseAlibabaPayload(_ raw: Any) -> [ProviderLimit] {
        guard let windows = findDict(containingAny: ["per5HourPercentage", "per1WeekPercentage"], in: raw) else {
            return []
        }
        var out: [ProviderLimit] = []
        if let ratio = number(windows["per5HourPercentage"]) {
            out.append(ProviderLimit(provider: "alibaba", label: "5h",
                                     usedPercent: min(max(ratio <= 1 ? ratio * 100 : ratio, 0), 100),
                                     resetsAt: epochMS(windows["per5HourResetTime"]),
                                     detail: ""))
        }
        if let ratio = number(windows["per1WeekPercentage"]) {
            out.append(ProviderLimit(provider: "alibaba", label: "weekly",
                                     usedPercent: min(max(ratio <= 1 ? ratio * 100 : ratio, 0), 100),
                                     resetsAt: epochMS(windows["per1WeekResetTime"]),
                                     detail: ""))
        }
        return out
    }

    static func findDict(containingAny keys: [String], in node: Any, depth: Int = 0) -> [String: Any]? {
        guard depth < 10 else { return nil }
        if let dict = node as? [String: Any] {
            if keys.contains(where: { dict[$0] != nil }) { return dict }
            for (_, v) in dict {
                if let found = findDict(containingAny: keys, in: v, depth: depth + 1) { return found }
            }
        } else if let array = node as? [Any] {
            for v in array {
                if let found = findDict(containingAny: keys, in: v, depth: depth + 1) { return found }
            }
        }
        return nil
    }

    static func epochMS(_ v: Any?) -> Date? {
        guard let n = v as? NSNumber else { return nil }
        let t = n.doubleValue
        return Date(timeIntervalSince1970: t > 1e12 ? t / 1000 : t)
    }

    static func cookieValue(name: String, from cookie: String) -> String? {
        for pair in cookie.split(separator: ";") {
            let trimmed = pair.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("\(name)=") {
                return trimmed.dropFirst(name.count + 1).removingPercentEncoding
            }
        }
        return nil
    }

    static func findObject(key: String, in node: Any, depth: Int = 0) -> Any? {
        guard depth < 8 else { return nil }
        if let dict = node as? [String: Any] {
            if let v = dict[key] { return v }
            for (_, v) in dict {
                if let found = findObject(key: key, in: v, depth: depth + 1) { return found }
            }
        } else if let array = node as? [Any] {
            for v in array {
                if let found = findObject(key: key, in: v, depth: depth + 1) { return found }
            }
        }
        return nil
    }

    static func number(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue }
        if let s = v as? String { return Double(s) }
        return nil
    }

    // GET https://api.anthropic.com/api/oauth/usage (Claude Code OAuth)
    // { five_hour: {utilization, resets_at}, seven_day: {...}, ... }
    private static func claude() -> [ProviderLimit] {
        ClaudeDiscovery.shared.fetchAllLimits()
    }

    static func parseClaudePayload(_ obj: [String: Any], provider: String = "claude", detail: String = "") -> [ProviderLimit] {
        let windows: [(String, String)] = [("five_hour", "5h"), ("seven_day", "weekly"),
                                           ("seven_day_oauth_apps", "apps 7d")]
        var out: [ProviderLimit] = []
        for (key, label) in windows {
            guard let window = obj[key] as? [String: Any] else { continue }
            let pct = (window["utilization"] as? NSNumber)?.doubleValue
                ?? (window["used_percent"] as? NSNumber)?.doubleValue
                ?? (window["usedPercent"] as? NSNumber)?.doubleValue
            guard let pct else { continue }
            var reset: Date?
            if let ts = window["resets_at"] as? String { reset = parseISO(ts) }
            else if let ts = window["resets_at"] as? NSNumber { reset = epoch(ts) }
            else if let ts = window["resetsAt"] as? NSNumber { reset = epoch(ts) }
            else if let ts = window["resetsAt"] as? String { reset = parseISO(ts) }
            if let r = reset, r < Date() {
                let step: TimeInterval = (label == "5h") ? 5 * 3600 : (7 * 86_400)
                var current = r
                let now = Date()
                while current < now {
                    current = current.addingTimeInterval(step)
                }
                reset = current
            }
            out.append(ProviderLimit(provider: provider, label: label,
                                     usedPercent: min(max(pct, 0), 100),
                                     resetsAt: reset, detail: detail))
        }
        // Model-scoped quotas (e.g. Fable): live entries carry `percent`
        // (older payloads used `utilization`). A missing/unknown percent means
        // "no data" — the row is skipped, never zero-filled.
        if let limits = obj["limits"] as? [[String: Any]] {
            for entry in limits where (entry["kind"] as? String) == "weekly_scoped" {
                let model = ((entry["scope"] as? [String: Any])?["model"] as? [String: Any])?["display_name"] as? String ?? "scoped"
                let pct = (entry["percent"] as? NSNumber)?.doubleValue
                    ?? (entry["utilization"] as? NSNumber)?.doubleValue
                    ?? (entry["used_percent"] as? NSNumber)?.doubleValue
                    ?? (entry["usedPercent"] as? NSNumber)?.doubleValue
                guard let pct else { continue }
                var reset: Date?
                if let ts = entry["resets_at"] as? String { reset = parseISO(ts) }
                else if let ts = entry["resets_at"] as? NSNumber { reset = epoch(ts) }
                out.append(ProviderLimit(provider: provider, label: "weekly · \(model)",
                                         usedPercent: min(max(pct, 0), 100),
                                         resetsAt: reset, detail: detail))
            }
        }
        return out
    }

    private static func claudeAccessToken(dir: String? = nil) -> String? {
        if let dir {
            return ClaudeDiscovery.shared.findAccessToken(for: dir)
        }
        let env = ProcessInfo.processInfo.environment
        let configDir = env["CLAUDE_CONFIG_DIR"] ?? NSString(string: "~/.claude").expandingTildeInPath
        return ClaudeDiscovery.shared.findAccessToken(for: configDir)
    }

    private static func get(url: String, key: String, timeout: TimeInterval = 8) -> [String: Any]? {
        guard let u = URL(string: url) else { return nil }
        var req = URLRequest(url: u, timeoutInterval: timeout)
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("opencode/1.0.0 (darwin; arm64)", forHTTPHeaderField: "User-Agent")
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + timeout) == .timedOut { return nil }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    private static func post(url: String, key: String, body: [String: Any], timeout: TimeInterval = 8) -> [String: Any]? {
        guard let u = URL(string: url) else { return nil }
        var req = URLRequest(url: u, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("opencode/1.0.0 (darwin; arm64)", forHTTPHeaderField: "User-Agent")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 8) == .timedOut { return nil }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    // GET https://api.z.ai/api/monitor/usage/quota/limit
    // { data: { limits: [{ type, unit, number, percentage, remaining, nextResetTime, ... }], level } }
    private static func zai(_ key: String) -> [ProviderLimit] {
        guard let obj = get(url: "https://api.z.ai/api/monitor/usage/quota/limit", key: key) else { return [] }
        return parseZaiPayload(obj)
    }

    static func parseZaiPayload(_ obj: [String: Any]) -> [ProviderLimit] {
        guard let data = obj["data"] as? [String: Any],
              let limits = data["limits"] as? [[String: Any]] else { return [] }
        return limits.compactMap { limit in
            guard let pct = (limit["percentage"] as? NSNumber)?.doubleValue else { return nil }
            let type = limit["type"] as? String ?? "quota"
            let unit = (limit["unit"] as? NSNumber)?.intValue ?? 0
            let number = (limit["number"] as? NSNumber)?.intValue ?? 1

            let label: String
            switch (type, unit) {
            case ("TOKENS_LIMIT", 3):
                label = "\(number)h"
            case ("TOKENS_LIMIT", 6):
                label = number > 1 ? "\(number)mo" : "monthly"
            case ("TOKENS_LIMIT", 5):
                label = number > 1 ? "\(number)w" : "weekly"
            case ("TOKENS_LIMIT", 4):
                label = number > 1 ? "\(number)d" : "daily"
            case ("TIME_LIMIT", _):
                label = "search"
            default:
                label = type.replacingOccurrences(of: "_LIMIT", with: "").lowercased()
            }

            let resetsAt = epochMS(limit["nextResetTime"])
            let usedPercent: Double
            var detail = ""

            if type == "TOKENS_LIMIT" {
                let remainingPct = min(max(pct, 0), 100)
                usedPercent = 100.0 - remainingPct
                let base = remainingPct == 0 ? "0% left (exhausted)" : String(format: "%.0f%% left", remainingPct)
                // Z.ai omits nextResetTime for the rolling burst window; say so
                // instead of leaving the UI with a blank countdown.
                detail = resetsAt == nil ? base + " · rolling window" : base
            } else if type == "TIME_LIMIT" {
                if let usage = (limit["usage"] as? NSNumber)?.doubleValue, usage > 0,
                   let curr = (limit["currentValue"] as? NSNumber)?.doubleValue {
                    usedPercent = min(max((curr / usage) * 100.0, 0), 100.0)
                } else {
                    usedPercent = min(max(pct, 0), 100)
                }
                if let remaining = (limit["remaining"] as? NSNumber)?.doubleValue {
                    detail = String(format: "%.0f left", remaining)
                }
            } else {
                usedPercent = min(max(pct, 0), 100)
                if let remaining = (limit["remaining"] as? NSNumber)?.doubleValue {
                    detail = String(format: "%.0f left", remaining)
                }
            }

            return ProviderLimit(provider: "glm",
                                 label: label,
                                 usedPercent: usedPercent,
                                 resetsAt: resetsAt,
                                 detail: detail)
        }
    }

    // GET https://www.minimax.io/v1/token_plan/remains
    // { model_remains: [{ current_interval_remaining_percent, end_time, current_weekly_remaining_percent, weekly_end_time }] }
    private static func minimax(_ key: String) -> [ProviderLimit] {
        guard let obj = get(url: "https://www.minimax.io/v1/token_plan/remains", key: key) else { return [] }
        return parseMinimaxPayload(obj)
    }

    static func parseMinimaxPayload(_ obj: [String: Any]) -> [ProviderLimit] {
        guard let remains = obj["model_remains"] as? [[String: Any]],
              let first = remains.first else { return [] }
        var out: [ProviderLimit] = []
        if let remaining = first["current_interval_remaining_percent"] as? Int {
            out.append(ProviderLimit(provider: "minimax", label: "interval",
                                     usedPercent: Double(100 - remaining),
                                     resetsAt: epoch(first["end_time"]),
                                     detail: ""))
        }
        if let remaining = first["current_weekly_remaining_percent"] as? Int {
            out.append(ProviderLimit(provider: "minimax", label: "weekly",
                                     usedPercent: Double(100 - remaining),
                                     resetsAt: epoch(first["weekly_end_time"]),
                                     detail: ""))
        }
        return out
    }

    // GET https://opencode.ai/zen/go/v1/usage
    // { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
    private static func opencodeGo(_ key: String) -> [ProviderLimit] {
        guard let obj = get(url: "https://opencode.ai/zen/go/v1/usage", key: key) else { return [] }
        return parseOpencodeGoPayload(obj)
    }

    static func parseOpencodeGoPayload(_ obj: [String: Any]) -> [ProviderLimit] {
        guard let usage = obj["usage"] as? [String: Any] else { return [] }
        var out: [ProviderLimit] = []
        for (window, metric) in usage.sorted(by: { $0.key < $1.key }) {
            guard let m = metric as? [String: Any],
                   let pct = (m["percent"] as? NSNumber)?.doubleValue else { continue }
            let status = m["status"] as? String
            out.append(ProviderLimit(provider: "opencode-go",
                                     label: window,
                                     usedPercent: min(max(pct, 0), 100),
                                     resetsAt: parseISO(m["resetsAt"] as? String),
                                     detail: status == "rate-limited" ? "rate-limited" : ""))
        }
        return out
    }

    // POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary (Live AGY)
    // or POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota (Gemini CLI / CloudCode)
    private static func gemini() -> [ProviderLimit] {
        let agyLimits = fetchAgyLanguageServerLimits()
        if !agyLimits.isEmpty {
            return agyLimits
        }

        var accessToken: String?
        var projectId = ""

        for credsPath in HomeDiscovery.geminiCredentialPaths() {
            guard let data = FileManager.default.contents(atPath: credsPath),
                  let creds = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = creds["access_token"] as? String, !token.isEmpty else { continue }
            accessToken = token
            projectId = creds["project_id"] as? String ?? ""
            break
        }

        if accessToken == nil {
            accessToken = geminiKeychainToken()
        }

        if let access = accessToken {
            if let obj = post(url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
                              key: access,
                              body: ["project": projectId]) {
                let parsed = parseGeminiBucketsPayload(obj)
                if !parsed.isEmpty { return parsed }
            }
        }

        if accessToken != nil {
            return [
                ProviderLimit(provider: "agy",
                              label: "tier",
                              usedPercent: 0,
                              resetsAt: nil,
                              detail: "Active · Pro")
            ]
        }
        return []
    }

    static func parseGeminiBucketsPayload(_ obj: [String: Any]) -> [ProviderLimit] {
        guard let buckets = obj["buckets"] as? [[String: Any]], !buckets.isEmpty else { return [] }
        return buckets.compactMap { bucket in
            guard let remaining = (bucket["remainingFraction"] as? NSNumber)?.doubleValue else { return nil }
            let used = (1 - remaining) * 100
            let model = bucket["modelId"] as? String ?? bucket["tokenType"] as? String ?? "gemini"
            return ProviderLimit(provider: "google",
                                 label: model,
                                 usedPercent: min(max(used, 0), 100),
                                 resetsAt: parseISO(bucket["resetTime"] as? String),
                                 detail: "")
        }
    }

    private static var cachedAgyPort: Int?

    private static func discoverAgyPorts() -> [Int] {
        var ports: [Int] = []
        if let cp = cachedAgyPort {
            ports.append(cp)
        }

        // 1. Fast log check: check ~/.gemini/antigravity-cli/cli.log (takes <1ms)
        let cliLogPath = NSString(string: "~/.gemini/antigravity-cli/cli.log").expandingTildeInPath
        if let text = try? String(contentsOfFile: cliLogPath, encoding: .utf8) {
            let ns = text as NSString
            if let matches = agyLogPortRegex?.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                for m in matches.suffix(3) {
                    if m.numberOfRanges > 1, let port = Int(ns.substring(with: m.range(at: 1))), !ports.contains(port) {
                        ports.append(port)
                    }
                }
            }
        }

        // 2. Fast PID lookup using pgrep and targeted lsof -p PID (takes ~20ms instead of 30+ seconds)
        let pgrep = Process()
        pgrep.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        pgrep.arguments = ["-x", "agy"]
        let pgrepPipe = Pipe()
        pgrep.standardOutput = pgrepPipe
        pgrep.standardError = FileHandle.nullDevice
        if (try? pgrep.run()) != nil {
            pgrep.waitUntilExit()
            if pgrep.terminationStatus == 0 {
                let pidsData = pgrepPipe.fileHandleForReading.readDataToEndOfFile()
                if let pidsStr = String(data: pidsData, encoding: .utf8) {
                    for pidLine in pidsStr.components(separatedBy: .newlines) {
                        let trimmed = pidLine.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !trimmed.isEmpty else { continue }
                        let lsof = Process()
                        lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
                        lsof.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-p", trimmed, "-a", "-i4"]
                        let lsofPipe = Pipe()
                        lsof.standardOutput = lsofPipe
                        lsof.standardError = FileHandle.nullDevice
                        if (try? lsof.run()) != nil {
                            lsof.waitUntilExit()
                            let lsofData = lsofPipe.fileHandleForReading.readDataToEndOfFile()
                            if let lsofText = String(data: lsofData, encoding: .utf8), let regex = agyPortRegex {
                                let ns = lsofText as NSString
                                for m in regex.matches(in: lsofText, range: NSRange(location: 0, length: ns.length)) {
                                    if m.numberOfRanges > 1, let port = Int(ns.substring(with: m.range(at: 1))), !ports.contains(port) {
                                        ports.append(port)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 3. Fallback: if no ports discovered yet, run general lsof via temp file
        if ports.isEmpty {
            let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("th-agy-ports-\(UUID().uuidString).txt")
            FileManager.default.createFile(atPath: tmp.path, contents: nil)
            if let fh = FileHandle(forWritingAtPath: tmp.path) {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
                proc.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-c", "agy", "-a", "-i4"]
                proc.standardOutput = fh
                proc.standardError = FileHandle.nullDevice
                if (try? proc.run()) != nil {
                    proc.waitUntilExit()
                }
                try? fh.close()
                if let data = try? Data(contentsOf: tmp),
                   let text = String(data: data, encoding: .utf8),
                   let regex = agyPortRegex {
                    let nsStr = text as NSString
                    let matches = regex.matches(in: text, range: NSRange(location: 0, length: nsStr.length))
                    for m in matches {
                        if m.numberOfRanges > 1, let port = Int(nsStr.substring(with: m.range(at: 1))), !ports.contains(port) {
                            ports.append(port)
                        }
                    }
                }
                try? FileManager.default.removeItem(at: tmp)
            }
        }

        return ports
    }

    private static func fetchAgyLanguageServerLimits() -> [ProviderLimit] {
        let ports = discoverAgyPorts()
        for port in ports {
            guard let url = URL(string: "http://127.0.0.1:\(port)/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary") else { continue }
            var req = URLRequest(url: url, timeoutInterval: 1.5)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data("{}".utf8)
            var data: Data?
            let sema = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: req) { d, resp, _ in
                if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                    data = d
                }
                sema.signal()
            }.resume()
            if sema.wait(timeout: .now() + 1.5) == .timedOut { continue }
            guard let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let resp = obj["response"] as? [String: Any],
                  let groups = resp["groups"] as? [[String: Any]], !groups.isEmpty else { continue }

            cachedAgyPort = port
            let out = parseAgyLanguageServerGroups(groups)
            if !out.isEmpty { return out }
        }
        return []
    }

    static func parseAgyLanguageServerGroups(_ groups: [[String: Any]]) -> [ProviderLimit] {
        var out: [ProviderLimit] = []
        for g in groups {
            let gname = (g["displayName"] as? String) ?? ""
            let prefix = gname.lowercased().contains("gemini") ? "gemini" : (gname.lowercased().contains("claude") || gname.lowercased().contains("gpt") ? "3p" : gname.lowercased())
            if let buckets = g["buckets"] as? [[String: Any]] {
                for b in buckets {
                    let rem = (b["remainingFraction"] as? NSNumber)?.doubleValue ?? 1.0
                    let used = min(max((1.0 - rem) * 100.0, 0.0), 100.0)
                    let w = (b["window"] as? String) ?? (b["bucketId"] as? String) ?? "quota"
                    let lbl = "\(prefix) \(w)"
                    let detail = "\(Int(round(rem * 100.0)))% left"
                    let reset = parseISO(b["resetTime"] as? String)
                    out.append(ProviderLimit(provider: "agy",
                                             label: lbl,
                                             usedPercent: (used * 10).rounded() / 10,
                                             resetsAt: reset,
                                             detail: detail))
                }
            }
        }
        return out
    }

    private static func geminiKeychainToken() -> String? {
        let security = Process()
        security.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        security.arguments = ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]
        let pipe = Pipe()
        security.standardOutput = pipe
        security.standardError = FileHandle.nullDevice
        do { try security.run() } catch { return nil }
        let out = pipe.fileHandleForReading.readDataToEndOfFile()
        security.waitUntilExit()
        guard let str = String(data: out, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !str.isEmpty else { return nil }
        var rawB64 = str
        if rawB64.hasPrefix("go-keyring-base64:") {
            rawB64 = String(rawB64.dropFirst("go-keyring-base64:".count))
        }
        guard let decodedData = Data(base64Encoded: rawB64),
              let obj = try? JSONSerialization.jsonObject(with: decodedData) as? [String: Any] else { return nil }
        let tokenObj = (obj["token"] as? [String: Any]) ?? obj
        return tokenObj["access_token"] as? String
    }

    // GET https://api.deepseek.com/user/balance
    private static func deepseek() -> [ProviderLimit] {
        let env = ProcessInfo.processInfo.environment
        let keys = authKeys()
        guard let key = keys["deepseek"] ?? env["DEEPSEEK_API_KEY"], !key.isEmpty else { return [] }
        guard let obj = get(url: "https://api.deepseek.com/user/balance", key: key) else { return [] }
        return parseDeepSeekPayload(obj)
    }

    static func parseDeepSeekPayload(_ obj: [String: Any]) -> [ProviderLimit] {
        guard let isAvail = obj["is_available"] as? Bool, isAvail,
              let infos = obj["balance_infos"] as? [[String: Any]],
              let first = infos.first else { return [] }
        let total = (first["total_balance"] as? String) ?? (first["total_balance"] as? NSNumber)?.stringValue ?? ""
        let curr = (first["currency"] as? String) ?? "USD"
        return [
            ProviderLimit(provider: "deepseek",
                          label: "balance",
                          usedPercent: 0,
                          resetsAt: nil,
                          detail: "$\(total) \(curr)")
        ]
    }

    // GET https://chatgpt.com/backend-api/wham/usage
    // Live OpenAI ChatGPT Pro/Plus/Codex rolling-window rate limits & usage quotas.
    private static func openai() -> [ProviderLimit] {
        guard let entry = authEntry(provider: "openai"),
              let access = entry["access"] as? String, !access.isEmpty else { return [] }

        var accountId = entry["accountId"] as? String ?? ""
        if accountId.isEmpty {
            let parts = access.split(separator: ".")
            if parts.count >= 2 {
                var payloadStr = String(parts[1])
                let rem = payloadStr.count % 4
                if rem > 0 { payloadStr += String(repeating: "=", count: 4 - rem) }
                if let payloadData = Data(base64Encoded: payloadStr.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")),
                   let claims = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any],
                   let auth = claims["https://api.openai.com/auth"] as? [String: Any] {
                    accountId = auth["chatgpt_account_id"] as? String ?? ""
                }
            }
        }

        guard let url = URL(string: "https://chatgpt.com/backend-api/wham/usage") else { return [] }
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.httpMethod = "GET"
        req.setValue("Bearer \(access)", forHTTPHeaderField: "Authorization")
        if !accountId.isEmpty {
            req.setValue(accountId, forHTTPHeaderField: "ChatGPT-Account-ID")
        }
        req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", forHTTPHeaderField: "User-Agent")
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        var respObj: [String: Any]?
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, r, e in
            defer { sem.signal() }
            guard let d, let http = r as? HTTPURLResponse, (200...299).contains(http.statusCode),
                  let json = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }
            respObj = json
        }.resume()
        _ = sem.wait(timeout: .now() + 8)

        guard let obj = respObj else { return [] }
        return parseOpenAIPayload(obj)
    }

    static func parseOpenAIPayload(_ obj: [String: Any]) -> [ProviderLimit] {
        var out: [ProviderLimit] = []

        if let rl = obj["rate_limit"] as? [String: Any],
           let pw = rl["primary_window"] as? [String: Any],
           let used = (pw["used_percent"] as? NSNumber)?.doubleValue {
            let windowSec = (pw["limit_window_seconds"] as? NSNumber)?.intValue ?? 604800
            let label = Self.windowLabel(seconds: windowSec)
            let resetAt = (pw["reset_at"] as? NSNumber)?.doubleValue
            let reset = resetAt.map { Date(timeIntervalSince1970: $0) }
            let left = max(0, Int(100 - used))
            out.append(ProviderLimit(
                provider: "codex",
                label: label,
                usedPercent: used,
                resetsAt: reset,
                detail: "\(left)% left"
            ))
        }

        if let addl = obj["additional_rate_limits"] as? [[String: Any]] {
            for item in addl {
                let name = item["limit_name"] as? String ?? ""
                guard let rate = item["rate_limit"] as? [String: Any] else { continue }
                if let pw = rate["primary_window"] as? [String: Any],
                   let used = (pw["used_percent"] as? NSNumber)?.doubleValue {
                    let windowSec = (pw["limit_window_seconds"] as? NSNumber)?.intValue ?? 18000
                    let label = Self.windowLabel(seconds: windowSec)
                    let resetAt = (pw["reset_at"] as? NSNumber)?.doubleValue
                    let reset = resetAt.map { Date(timeIntervalSince1970: $0) }
                    let left = max(0, Int(100 - used))
                    let displayLabel = name.isEmpty ? label : "\(name.lowercased()) \(label)"
                    out.append(ProviderLimit(
                        provider: "codex",
                        label: displayLabel,
                        usedPercent: used,
                        resetsAt: reset,
                        detail: "\(left)% left"
                    ))
                }
            }
        }
        return out
    }

    static func windowLabel(seconds: Int) -> String {
        let mins = seconds / 60
        if mins <= 0 { return "session" }
        if mins < 60 { return "\(mins)m" }
        if mins < 1440 { return "\(mins / 60)h" }
        return "\(mins / 1440)d"
    }

    // Cached formatters/regex: parseISO runs per window per poll; constructing
    // ISO8601DateFormatter + NSRegularExpression per call showed up as alloc
    // overhead in static profiling. These are immutable after creation.
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
    private static let agyPortRegex: NSRegularExpression? = try? NSRegularExpression(pattern: "127\\.0\\.0\\.1:(\\d+)")
    private static let agyLogPortRegex: NSRegularExpression? = try? NSRegularExpression(pattern: "port at (\\d+) for HTTP")
    private static let secTokenRegex: NSRegularExpression? = try? NSRegularExpression(
        pattern: "sec[_-]?token[\"'\\s:=]+([A-Za-z0-9_%\\-]{16,})")

    /// Extract sec_token from dashboard HTML using the cached regex.
    /// Capture group 1 is the token; falls back to nil when absent.
    static func extractSecToken(from html: String) -> String? {
        guard let regex = secTokenRegex else { return nil }
        let ns = html as NSString
        guard let m = regex.firstMatch(in: html, range: NSRange(location: 0, length: ns.length)),
              m.numberOfRanges > 1 else { return nil }
        let token = ns.substring(with: m.range(at: 1))
            .trimmingCharacters(in: CharacterSet(charactersIn: "'\\s:=\""))
        return token.isEmpty ? nil : token
    }

    static func epoch(_ v: Any?) -> Date? {
        guard let n = v as? NSNumber else { return nil }
        let t = n.doubleValue
        return Date(timeIntervalSince1970: t > 1e12 ? t / 1000 : t)
    }

    static func parseISO(_ s: String?) -> Date? {
        guard let s else { return nil }
        if let d = isoFull.date(from: s) { return d }
        return isoPlain.date(from: s)
    }
}
