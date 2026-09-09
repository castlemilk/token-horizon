#if os(Linux)
import Foundation

/// Linux filesystem layout honoring the XDG Base Directory spec.
public struct LinuxPaths: PlatformPathsProviding {
    public init() {}

    public var homeDirectory: URL {
        URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    }

    public var configDirectory: URL {
        let base = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
            ?? homeDirectory.appendingPathComponent(".config", isDirectory: true).path
        return URL(fileURLWithPath: base, isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
    }

    public var cacheDirectory: URL {
        let base = ProcessInfo.processInfo.environment["XDG_CACHE_HOME"]
            ?? homeDirectory.appendingPathComponent(".cache", isDirectory: true).path
        return URL(fileURLWithPath: base, isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
    }
}
#endif // os(Linux)
