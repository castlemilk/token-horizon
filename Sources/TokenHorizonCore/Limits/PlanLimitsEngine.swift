import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public final class PlanLimitsEngine: LimitsEngine {
    public static let shared = PlanLimitsEngine()

    public init() {
        super.init(updatedNotification: .planLimitsUpdated)
    }

    public override func fetchLimits() -> [ProviderLimit] {
        Self.fetchAll()
    }

    public static func authKeys() -> [String: String] {
        let path = ProcessInfo.processInfo.environment["OPENCODE_AUTH"]
            ?? NSString(string: "~/.local/share/opencode/auth.json").expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { return [:] }
        var out: [String: String] = [:]
        for (provider, entry) in obj {
            if let key = entry["key"] as? String, !key.isEmpty {
                out[provider] = key
            }
        }
        return out
    }

    public static func fetchAll() -> [ProviderLimit] {
        let keys = authKeys()
        var out: [ProviderLimit] = []
        if let key = keys["zai-coding-plan"] ?? keys["zai"] { out += zai(key) }
        if let key = keys["minimax-coding-plan"] { out += minimax(key) }
        if let key = keys["opencode-go"] { out += opencodeGo(key) }
        out += alibaba()
        out += gemini()
        out += claude()
        out += deepseek()
        return out
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
            dashSema.wait()
            if let dashData, let html = String(data: dashData, encoding: .utf8),
               let match = html.range(of: "sec[_-]?token[\"'\\s:=]+([A-Za-z0-9_%\\-]{16,})", options: .regularExpression) {
                var token = String(html[match])
                if let eq = token.range(of: "token") {
                    token = String(token[eq.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: "'\\s:=\""))
                    secToken = token
                }
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
            guard let windows = findDict(containingAny: ["per5HourPercentage", "per1WeekPercentage"], in: raw) else {
                if attempt < 2 {
                    Thread.sleep(forTimeInterval: 0.4)
                    continue
                }
                return out
            }
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
            if !out.isEmpty { break }
        }
        return out
    }

    private static func findDict(containingAny keys: [String], in node: Any, depth: Int = 0) -> [String: Any]? {
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

    private static func epochMS(_ v: Any?) -> Date? {
        guard let n = v as? NSNumber else { return nil }
        let t = n.doubleValue
        return Date(timeIntervalSince1970: t > 1e12 ? t / 1000 : t)
    }

    private static func cookieValue(name: String, from cookie: String) -> String? {
        for pair in cookie.split(separator: ";") {
            let trimmed = pair.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("\(name)=") {
                return trimmed.dropFirst(name.count + 1).removingPercentEncoding
            }
        }
        return nil
    }

    private static func findObject(key: String, in node: Any, depth: Int = 0) -> Any? {
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

    private static func number(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue }
        if let s = v as? String { return Double(s) }
        return nil
    }

    // GET https://api.anthropic.com/api/oauth/usage (Claude Code OAuth)
    // { five_hour: {utilization, resets_at}, seven_day: {...}, ... }
    private static func claude() -> [ProviderLimit] {
        guard let token = claudeAccessToken() else { return [] }
        guard let u = URL(string: "https://api.anthropic.com/api/oauth/usage") else { return [] }
        var req = URLRequest(url: u, timeoutInterval: 8)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 8) == .timedOut { return [] }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }

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
            out.append(ProviderLimit(provider: "claude", label: label,
                                     usedPercent: min(max(pct, 0), 100),
                                     resetsAt: reset, detail: ""))
        }
        if let limits = obj["limits"] as? [[String: Any]] {
            for entry in limits where (entry["kind"] as? String) == "weekly_scoped" {
                let model = ((entry["scope"] as? [String: Any])?["model"] as? [String: Any])?["display_name"] as? String ?? "scoped"
                if let pct = (entry["utilization"] as? NSNumber)?.doubleValue {
                    out.append(ProviderLimit(provider: "claude", label: "weekly · \(model)",
                                             usedPercent: min(max(pct, 0), 100),
                                             resetsAt: parseISO(entry["resets_at"] as? String), detail: ""))
                }
            }
        }
        return out
    }

    private static func claudeAccessToken() -> String? {
        let env = ProcessInfo.processInfo.environment
        let configDir = env["CLAUDE_CONFIG_DIR"] ?? "~/.claude"
        let file = NSString(string: "\(configDir)/.credentials.json").expandingTildeInPath
        var root: [String: Any]?
        if let data = FileManager.default.contents(atPath: file),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            root = obj
        } else if let secret = Platform.credentials.genericPassword(service: "Claude Code-credentials", account: nil),
                  let secretData = secret.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: secretData) as? [String: Any] {
            root = obj
        }
        guard let root else { return nil }
        let oauth = (root["claudeAiOauth"] as? [String: Any]) ?? (root["oauth"] as? [String: Any]) ?? root
        return oauth["accessToken"] as? String
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
        if sema.wait(timeout: .now() + 8) == .timedOut { return nil }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    private static func post(url: String, key: String, body: [String: Any], timeout: TimeInterval = 8) -> [String: Any]? {
        guard let u = URL(string: url) else { return nil }
        var req = URLRequest(url: u, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
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
        guard let obj = get(url: "https://api.z.ai/api/monitor/usage/quota/limit", key: key),
              let data = obj["data"] as? [String: Any],
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

            var detail = ""
            if let remaining = (limit["remaining"] as? NSNumber)?.doubleValue {
                detail = String(format: "%.0f left", remaining)
            }

            let resetsAt = epochMS(limit["nextResetTime"])
            return ProviderLimit(provider: "glm",
                                 label: label,
                                 usedPercent: min(max(pct, 0), 100),
                                 resetsAt: resetsAt,
                                 detail: detail)
        }
    }

    // GET https://www.minimax.io/v1/token_plan/remains
    // { model_remains: [{ current_interval_remaining_percent, end_time, current_weekly_remaining_percent, weekly_end_time }] }
    private static func minimax(_ key: String) -> [ProviderLimit] {
        guard let obj = get(url: "https://www.minimax.io/v1/token_plan/remains", key: key),
              let remains = obj["model_remains"] as? [[String: Any]],
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
        guard let obj = get(url: "https://opencode.ai/zen/go/v1/usage", key: key),
              let usage = obj["usage"] as? [String: Any] else { return [] }
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

        let credsPath = NSString(string: "~/.gemini/oauth_creds.json").expandingTildeInPath
        if let data = FileManager.default.contents(atPath: credsPath),
           let creds = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            accessToken = creds["access_token"] as? String
            projectId = creds["project_id"] as? String ?? ""
        }

        if accessToken == nil {
            accessToken = geminiKeychainToken()
        }

        if let access = accessToken {
            if let obj = post(url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
                              key: access,
                              body: ["project": projectId]),
               let buckets = obj["buckets"] as? [[String: Any]], !buckets.isEmpty {
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

    private static func discoverAgyPorts() -> [Int] {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("th-agy-ports-\(UUID().uuidString).txt")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        guard let fh = FileHandle(forWritingAtPath: tmp.path) else { return [] }
        let proc = Process()
        #if os(macOS)
        proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        #else
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/lsof")
        #endif
        proc.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-c", "agy", "-a", "-i4"]
        proc.standardOutput = fh
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            try? fh.close()
            try? FileManager.default.removeItem(at: tmp)
            return []
        }
        try? fh.close()
        guard let data = try? Data(contentsOf: tmp),
              let text = String(data: data, encoding: .utf8) else {
            try? FileManager.default.removeItem(at: tmp)
            return []
        }
        try? FileManager.default.removeItem(at: tmp)

        var ports: [Int] = []
        let pattern = "127\\.0\\.0\\.1:(\\d+)"
        if let regex = try? NSRegularExpression(pattern: pattern) {
            let nsStr = text as NSString
            let matches = regex.matches(in: text, range: NSRange(location: 0, length: nsStr.length))
            for m in matches {
                if m.numberOfRanges > 1 {
                    let portStr = nsStr.substring(with: m.range(at: 1))
                    if let port = Int(portStr), !ports.contains(port) {
                        ports.append(port)
                    }
                }
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
            if !out.isEmpty { return out }
        }
        return []
    }

    private static func geminiKeychainToken() -> String? {
        guard let str = Platform.credentials.genericPassword(service: "gemini", account: "antigravity") else { return nil }
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
        guard let obj = get(url: "https://api.deepseek.com/user/balance", key: key),
              let isAvail = obj["is_available"] as? Bool, isAvail,
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

    private static func epoch(_ v: Any?) -> Date? {
        guard let n = v as? NSNumber else { return nil }
        let t = n.doubleValue
        return Date(timeIntervalSince1970: t > 1e12 ? t / 1000 : t)
    }

    private static func parseISO(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}
