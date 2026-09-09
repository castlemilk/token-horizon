#if os(macOS)
import Foundation

/// macOS filesystem layout. Keeps the established ~/.config/token-horizon
/// config path; caches under ~/Library/Caches.
public struct MacOSPaths: PlatformPathsProviding {
    public init() {}

    public var homeDirectory: URL {
        URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    }

    public var configDirectory: URL {
        homeDirectory
            .appendingPathComponent(".config", isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
    }

    public var cacheDirectory: URL {
        homeDirectory
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Caches", isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
    }
}
#endif // os(macOS)
