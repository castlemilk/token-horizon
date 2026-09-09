import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Google Gemini — two paths, tried in order:
/// 1. Live Antigravity (agy) language server on loopback:
///    POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
/// 2. Gemini CLI / CloudCode:
///    POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
/// Auth: ~/.gemini/oauth_creds.json → Platform.credentials Keychain fallback.
/// See .agents/skills/provider-quota-google/SKILL.md.
public final class GeminiLimits: VendorLimitsAdapter {
    public init() { super.init(provider: "google") }

    /// ~/.gemini/oauth_creds.json → Keychain "gemini"/"antigravity"
    /// (go-keyring-base64 wrapped JSON).
    public override var auth: VendorAuth {
        VendorAuth(sources: [
            .fileJSON("~/.gemini/oauth_creds.json", keyPaths: ["access_token"]),
            .custom { [self] in keychainToken() },
        ])
    }

    public override func fetch() -> [ProviderLimit] {
        let agyLimits = fetchAgyLanguageServerLimits()
        if !agyLimits.isEmpty {
            return agyLimits
        }

        let accessToken = auth.resolve()
        var projectId = ""

        let credsPath = NSString(string: "~/.gemini/oauth_creds.json").expandingTildeInPath
        if let data = FileManager.default.contents(atPath: credsPath),
           let creds = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            projectId = creds["project_id"] as? String ?? ""
        }

        if let access = accessToken {
            if let obj = postJSON(url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
                                  key: access,
                                  body: ["project": projectId]),
               let buckets = obj["buckets"] as? [[String: Any]], !buckets.isEmpty {
                return buckets.compactMap { bucket in
                    guard let remaining = (bucket["remainingFraction"] as? NSNumber)?.doubleValue else { return nil }
                    let used = (1 - remaining) * 100
                    let model = bucket["modelId"] as? String ?? bucket["tokenType"] as? String ?? "gemini"
                    return limit(label: model, usedPercent: used,
                                 resetsAt: parseISO(bucket["resetTime"] as? String))
                }
            }
        }

        if accessToken != nil {
            return [
                limit(label: "tier", usedPercent: 0, detail: "Active · Pro", provider: "agy")
            ]
        }
        return []
    }

    // MARK: - Antigravity language server

    private func discoverAgyPorts() -> [Int] {
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

    private func fetchAgyLanguageServerLimits() -> [ProviderLimit] {
        let ports = discoverAgyPorts()
        for port in ports {
            guard let url = URL(string: "http://127.0.0.1:\(port)/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary") else { continue }
            var req = URLRequest(url: url, timeoutInterval: 1.5)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data("{}".utf8)
            guard let data = performRaw(req, timeout: 1.5),
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
                        out.append(limit(label: lbl, usedPercent: (used * 10).rounded() / 10,
                                         resetsAt: reset, detail: detail, provider: "agy"))
                    }
                }
            }
            if !out.isEmpty { return out }
        }
        return []
    }

    private func keychainToken() -> String? {
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
}
