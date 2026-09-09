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
        let pipe = Pipe()
        security.standardOutput = pipe
        security.standardError = FileHandle.nullDevice
        do { try security.run() } catch { return nil }
        let out = pipe.fileHandleForReading.readDataToEndOfFile()
        security.waitUntilExit()
        let str = String(data: out, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (str?.isEmpty == false) ? str : nil
    }
}
#endif // os(macOS)
