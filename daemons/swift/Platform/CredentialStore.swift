import Foundation

/// Operating-system specific secret storage.
///
/// Implementations live in `Platform/macOS` (Keychain), `Platform/Linux`
/// (libsecret — stub), `Platform/Windows` (wincred — stub).
/// `DefaultCredentialStore` aliases the one for the current OS.
///
/// Callers must always keep file/env fallbacks — a nil result is normal on
/// platforms without an implementation yet.
public protocol CredentialStore {
    /// Read a generic-password style secret. `account` is optional and
    /// maps to the macOS Keychain `-a` attribute.
    func genericPassword(service: String, account: String?) -> String?
}

#if os(macOS)
public typealias DefaultCredentialStore = MacOSKeychainStore
#elseif os(Linux)
public typealias DefaultCredentialStore = LinuxCredentialStore
#elseif os(Windows)
public typealias DefaultCredentialStore = WindowsCredentialStore
#endif

/// Registry of OS-specific service implementations used by the portable core.
/// The app (or headless daemon) assigns platform backends at launch.
public enum Platform {
    /// Filesystem layout for the current OS (see Platform/macOS|Linux|Windows).
    public static var paths: PlatformPathsProviding = DefaultPlatformPaths()

    /// Secret storage for the current OS.
    public static var credentials: CredentialStore = DefaultCredentialStore()

    /// System telemetry backend. macOS assigns `SystemStats.self`;
    /// Linux assigns `ProcFSSystemStats.self`. May be nil on platforms
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
