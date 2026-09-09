import Foundation

/// Operating-system specific secret storage.
///
/// Implementations:
/// - macOS: Keychain via `/usr/bin/security find-generic-password`
/// - Linux: TBD (libsecret / `secret-tool`); currently returns nil
/// - Windows: TBD (Credential Manager / `wincred`); currently returns nil
///
/// Callers must always keep file/env fallbacks — a nil result is normal on
/// platforms without an implementation yet.
public protocol CredentialStore {
    /// Read a generic-password style secret. `account` is optional and
    /// maps to the macOS Keychain `-a` attribute.
    func genericPassword(service: String, account: String?) -> String?
}

public struct DefaultCredentialStore: CredentialStore {
    public init() {}

    public func genericPassword(service: String, account: String?) -> String? {
        #if os(macOS)
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
        #else
        return nil
        #endif
    }
}

/// Registry of OS-specific service implementations used by the portable core.
/// The app (or headless daemon) assigns platform backends at launch.
public enum Platform {
    /// Filesystem layout. Default honors XDG on Linux, APPDATA on Windows,
    /// and the historical ~/.config/token-horizon path on macOS.
    public static var paths: PlatformPathsProviding = DefaultPlatformPaths()

    /// Secret storage. Default uses Keychain on macOS, nil elsewhere.
    public static var credentials: CredentialStore = DefaultCredentialStore()

    /// System telemetry backend. macOS app assigns `SystemStats.self`;
    /// Linux daemon assigns `ProcFSSystemStats.self`. May be nil on platforms
    /// without an implementation — callers must degrade gracefully.
    public static var systemStats: SystemStatsProviding.Type?

    /// Human-readable platform name for /health responses.
    public static var name: String {
        #if os(macOS)
        return "macOS"
        #elseif os(Linux)
        return "Linux"
        #elseif os(Windows)
        return "Windows"
        #else
        return "unknown"
        #endif
    }
}
