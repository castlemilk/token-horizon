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
    /// JSON file with dot-separated key paths, first hit wins,
    /// e.g. `.fileJSON("~/.gemini/oauth_creds.json", keyPaths: ["access_token"])`.
    case fileJSON(String, keyPaths: [String])
    /// OS secret store (macOS Keychain; stubs elsewhere). If `jsonKeyPaths` is
    /// given, the secret itself is parsed as JSON and walked.
    case keychain(service: String, account: String? = nil, jsonKeyPaths: [String]? = nil)
    /// Escape hatch for bespoke flows (base64 wrappers, multi-step handshakes).
    case custom(() -> String?)

    public func resolve() -> String? {
        switch self {
        case .env(let name):
            return ProcessInfo.processInfo.environment[name]

        case .opencodeKey(let key):
            return Self.opencodeAuthFileKeys()[key]

        case .fileText(let path):
            let expanded = NSString(string: path).expandingTildeInPath
            let value = (try? String(contentsOfFile: expanded, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (value?.isEmpty == false) ? value : nil

        case .fileJSON(let path, let keyPaths):
            let expanded = NSString(string: path).expandingTildeInPath
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

        case .custom(let read):
            return read()
        }
    }

    /// opencode's auth.json (`OPENCODE_AUTH` env override honored).
    public static func opencodeAuthFileKeys() -> [String: String] {
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

    private static func walk(_ node: Any, keyPath: String) -> String? {
        var current: Any? = node
        for part in keyPath.split(separator: ".") {
            current = (current as? [String: Any])?[String(part)]
            if current == nil { return nil }
        }
        return current as? String
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
}
