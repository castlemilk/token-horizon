import Foundation

/// Filesystem locations that differ per operating system.
///
/// Implementations:
/// - macOS: `~` home, config at `~/.config/token-horizon` (matches historical behavior)
/// - Linux: honors `XDG_CONFIG_HOME` (default `~/.config`), data at `XDG_DATA_HOME`
/// - Windows: `%APPDATA%` / `%LOCALAPPDATA%`
public protocol PlatformPathsProviding {
    var homeDirectory: URL { get }
    /// Directory holding settings.json and small state files.
    var configDirectory: URL { get }
    /// Directory for caches that can be regenerated.
    var cacheDirectory: URL { get }
}

public struct DefaultPlatformPaths: PlatformPathsProviding {
    public init() {}

    public var homeDirectory: URL {
        URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    }

    public var configDirectory: URL {
        #if os(Windows)
        let base = ProcessInfo.processInfo.environment["APPDATA"]
            ?? homeDirectory.appendingPathComponent("AppData/Roaming").path
        return URL(fileURLWithPath: base, isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
        #elseif os(Linux)
        let base = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
            ?? homeDirectory.appendingPathComponent(".config", isDirectory: true).path
        return URL(fileURLWithPath: base, isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
        #else
        // macOS: keep the established path.
        return homeDirectory
            .appendingPathComponent(".config", isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
        #endif
    }

    public var cacheDirectory: URL {
        #if os(Windows)
        let base = ProcessInfo.processInfo.environment["LOCALAPPDATA"]
            ?? homeDirectory.appendingPathComponent("AppData/Local").path
        return URL(fileURLWithPath: base, isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
        #elseif os(Linux)
        let base = ProcessInfo.processInfo.environment["XDG_CACHE_HOME"]
            ?? homeDirectory.appendingPathComponent(".cache", isDirectory: true).path
        return URL(fileURLWithPath: base, isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
        #else
        return homeDirectory
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Caches", isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
        #endif
    }
}
