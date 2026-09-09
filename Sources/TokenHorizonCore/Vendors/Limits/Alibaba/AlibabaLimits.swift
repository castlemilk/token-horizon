import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Alibaba Cloud Model Studio (Bailian) Token Plan.
/// GET https://bailian-singapore-cs.alibabacloud.com/data/api.json
///   ?action=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage&product=sfm_bailian
/// Cookie-authenticated rolling-window API (Personal/Solo).
/// usage.per5HourPercentage / per1WeekPercentage are 0-1 ratios.
/// See .agents/skills/provider-quota-alibaba/SKILL.md for the handshake spec.
public final class AlibabaLimits: VendorLimitsAdapter {
    public init() { super.init(provider: "alibaba") }

    public override func fetch() -> [ProviderLimit] {
        let env = ProcessInfo.processInfo.environment
        var cookie = ""
        if let path = ProcessInfo.processInfo.environment["ALIBABA_COOKIE_FILE"] {
            cookie = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        }
        if cookie.isEmpty, let env = ProcessInfo.processInfo.environment["ALIBABA_TOKEN_PLAN_COOKIE"] {
            cookie = env
        }
        if cookie.isEmpty {
            let path = Platform.paths.configDirectory.appendingPathComponent("alibaba-cookie.txt").path
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
            if let dashData = performRaw(dashReq, timeout: 10),
               let html = String(data: dashData, encoding: .utf8),
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

        let data = performRaw(req, timeout: 8)
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
}
