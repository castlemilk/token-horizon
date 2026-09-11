import Foundation

/// One place a vendor credential can come from. Sources are tried in order;
/// the first non-empty result wins. Compose per vendor in the adapter's
/// `auth` property:
///
///     override var auth: VendorAuth {
///         VendorAuth(sources: [.opencodeKey("zai-coding-plan"), .env("ZAI_API_KEY")])
///     }
public enum CredentialSource {
    /// Environment variable, e.g. `.env("DEEPSEEK_API_KEY")`.
    case env(String)
    /// Key from opencode's auth.json, e.g. `.opencodeKey("zai-coding-plan")`.
    case opencodeKey(String)
    /// Plain-text file (trimmed), e.g. a cookie dump.
    case fileText(String)
    /// Plain-text file whose path comes from an env var, else fallback path.
    case fileTextEnv(envVar: String, fallback: String)
    /// JSON file with dot-separated key paths, first hit wins,
    /// e.g. `.fileJSON("~/.gemini/oauth_creds.json", keyPaths: ["access_token"])`.
    case fileJSON(String, keyPaths: [String])
    /// OS secret store (macOS Keychain; stubs elsewhere). If `jsonKeyPaths` is
    /// given, the secret itself is parsed as JSON and walked.
    case keychain(service: String, account: String? = nil, jsonKeyPaths: [String]? = nil)
    /// Keychain secret wrapped as `go-keyring-base64:<b64(JSON)>` (antigravity).
    case keychainBase64JSON(service: String, account: String? = nil, jsonKeyPaths: [String])
    /// Every credentials file matching a pattern inside a directory
    /// (multi-account profiles): label = file name without extension.
    case profileFiles(directory: String, pattern: String, keyPaths: [String])
    /// Escape hatch for bespoke flows (base64 wrappers, multi-step handshakes).
    case custom(() -> String?)

    public func resolve() -> String? {
        switch self {
        case .env(let name):
            return ProcessInfo.processInfo.environment[name]

        case .opencodeKey(let key):
            return Self.opencodeAuthFileKeys()[key]

        case .fileText(let path):
            let expanded = Self.expand(path)
            let value = (try? String(contentsOfFile: expanded, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (value?.isEmpty == false) ? value : nil

        case .fileTextEnv(let envVar, let fallback):
            let path: String
            if let envPath = ProcessInfo.processInfo.environment[envVar],
               !envPath.trimmingCharacters(in: .whitespaces).isEmpty {
                path = envPath
            } else {
                path = fallback
            }
            let expanded = Self.expand(path)
            let value = (try? String(contentsOfFile: expanded, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (value?.isEmpty == false) ? value : nil

        case .fileJSON(let path, let keyPaths):
            let expanded = Self.expand(path)
            guard let data = FileManager.default.contents(atPath: expanded),
                  let obj = try? JSONSerialization.jsonObject(with: data) else { return nil }
            for keyPath in keyPaths {
                if let value = Self.walk(obj, keyPath: keyPath), !value.isEmpty { return value }
            }
            return nil

        case .keychain(let service, let account, let jsonKeyPaths):
            guard let secret = Platform.credentials.genericPassword(service: service, account: account),
                  !secret.isEmpty else { return nil }
            guard let keyPaths = jsonKeyPaths else { return secret }
            guard let data = secret.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) else { return nil }
            for keyPath in keyPaths {
                if let value = Self.walk(obj, keyPath: keyPath), !value.isEmpty { return value }
            }
            return nil

        case .keychainBase64JSON(let service, let account, let jsonKeyPaths):
            guard var raw = Platform.credentials.genericPassword(service: service, account: account),
                  !raw.isEmpty else { return nil }
            if raw.hasPrefix("go-keyring-base64:") {
                raw = String(raw.dropFirst("go-keyring-base64:".count))
            }
            guard let decoded = Data(base64Encoded: raw),
                  let obj = try? JSONSerialization.jsonObject(with: decoded) as? [String: Any] else { return nil }
            let tokenObj = (obj["token"] as? [String: Any]) ?? obj
            for keyPath in jsonKeyPaths {
                if let value = Self.walk(tokenObj, keyPath: keyPath), !value.isEmpty { return value }
            }
            return nil

        case .custom(let read):
            return read()
        }
    }

    /// Labeled credentials across all sources (multi-account). Single-profile
    /// sources vend one entry with an empty label; profile dirs vend one per
    /// matching file. First source winning per label; order preserved.
    public func resolveLabeled() -> [(label: String, credential: String)] {
        var out: [(String, String)] = []
        var seen = Set<String>()
        switch self {
        case .profileFiles(let directory, let pattern, let keyPaths):
            let dir = Self.expand(directory)
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
            for entry in entries.sorted() where Self.match(pattern: pattern, name: entry) {
                let full = dir + "/" + entry
                guard let data = FileManager.default.contents(atPath: full),
                      let obj = try? JSONSerialization.jsonObject(with: data) else { continue }
                for keyPath in keyPaths {
                    if let value = Self.walk(obj, keyPath: keyPath), !value.isEmpty {
                        let label = (entry as NSString).deletingPathExtension
                        if seen.insert(label).inserted { out.append((label, value)) }
                        break
                    }
                }
            }
            return out
        default:
            if let value = resolve(), !value.isEmpty { return [("", value)] }
            return []
        }
    }

    private static func match(pattern: String, name: String) -> Bool {
        if pattern == "*" { return true }
        if pattern.hasPrefix("*.") {
            return name.hasSuffix(String(pattern.dropFirst()))
        }
        return name == pattern
    }

    /// opencode's auth.json (`OPENCODE_AUTH` env override honored).
    public static func opencodeAuthFileKeys() -> [String: String] {
        let path = ProcessInfo.processInfo.environment["OPENCODE_AUTH"]
            ?? Platform.paths.homeDirectory.appendingPathComponent(".local/share/opencode/auth.json").path
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

    private static func walk(_ node: Any, keyPath: String) -> String? {
        var current: Any? = node
        for part in keyPath.split(separator: ".") {
            current = (current as? [String: Any])?[String(part)]
            if current == nil { return nil }
        }
        return current as? String
    }

    public static func expand(_ path: String) -> String {
        if path.hasPrefix("~/") {
            return Platform.paths.homeDirectory.appendingPathComponent(String(path.dropFirst(2))).path
        }
        if path == "~" { return Platform.paths.homeDirectory.path }
        return path
    }
}

public struct VendorAuth {
    public let sources: [CredentialSource]

    public init(sources: [CredentialSource] = []) {
        self.sources = sources
    }

    /// First non-empty credential across the chain, or nil (vendor not configured).
    public func resolve() -> String? {
        for source in sources {
            if let value = source.resolve(), !value.isEmpty { return value }
        }
        return nil
    }

    /// Labeled credentials across the whole chain (multi-account profiles).
    /// Labels are unique; single-profile vendors return one empty-labeled entry.
    public func resolveAll() -> [(label: String, credential: String)] {
        var out: [(String, String)] = []
        var seen = Set<String>()
        for source in sources {
            for (label, cred) in source.resolveLabeled() where !cred.isEmpty {
                if seen.insert(label).inserted { out.append((label, cred)) }
            }
        }
        return out
    }
}
