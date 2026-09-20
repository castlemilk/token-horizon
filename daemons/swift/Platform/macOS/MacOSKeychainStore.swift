#if os(macOS)
import Foundation

/// macOS Keychain access via the `security` CLI (avoids Keychain entitlement
/// prompts that SecItemCopyMatching would trigger in an unsigned/headless tool).
public struct MacOSKeychainStore: CredentialStore {
    public init() {}

    public func genericPassword(service: String, account: String?) -> String? {
        let security = Process()
        security.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        var args = ["find-generic-password", "-s", service]
        if let account { args += ["-a", account] }
        args.append("-w")
        security.arguments = args
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("th-keychain-\(UUID().uuidString).txt")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        guard let fh = FileHandle(forWritingAtPath: tmp.path) else { return nil }
        security.standardOutput = fh
        security.standardError = FileHandle.nullDevice
        do { try security.run() } catch {
            try? fh.close()
            try? FileManager.default.removeItem(at: tmp)
            return nil
        }
        security.waitUntilExit()
        try? fh.close()
        let out = (try? Data(contentsOf: tmp)) ?? Data()
        try? FileManager.default.removeItem(at: tmp)
        guard security.terminationStatus == 0 else { return nil }
        let str = String(data: out, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (str?.isEmpty == false) ? str : nil
    }
}
#endif // os(macOS)
