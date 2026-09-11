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

    public override var meterTarget: URL? { URL(string: "https://generativelanguage.googleapis.com") }
    public override var meterVendorKey: String { "gemini" }

    public override func makeMeter(listenPort: UInt16, target: URL?, store: UsageStoring?) -> RequestMeter? {
        GeminiMeter(vendor: provider, listenPort: listenPort,
                    targetBase: target ?? URL(string: "https://generativelanguage.googleapis.com")!,
                    store: store, sourceKind: .external)
    }

    /// ~/.gemini/oauth_creds.json → Keychain "gemini"/"antigravity"
    /// (go-keyring-base64 wrapped JSON).
    public override var auth: VendorAuth {
        let credsPath = Platform.paths.homeDirectory.appendingPathComponent(".gemini/oauth_creds.json").path
        return VendorAuth(sources: [
            .fileJSON(credsPath, keyPaths: ["access_token"]),
            .keychainBase64JSON(service: "gemini", account: "antigravity", jsonKeyPaths: ["access_token"]),
        ])
    }

    public override func fetch() -> [ProviderLimit] {
        let agyLimits = fetchAgyLanguageServerLimits()
        if !agyLimits.isEmpty {
            return agyLimits
        }

        let accessToken = auth.resolve()
        var projectId = ""

        let credsPath = Platform.paths.homeDirectory.appendingPathComponent(".gemini/oauth_creds.json").path
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
            return []
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
}
