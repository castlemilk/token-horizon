import Foundation

/// Filesystem locations that differ per operating system.
///
/// Implementations live in `Platform/macOS`, `Platform/Linux`, `Platform/Windows`;
/// `DefaultPlatformPaths` aliases the one for the current OS.
public protocol PlatformPathsProviding {
    var homeDirectory: URL { get }
    /// Directory holding settings.json and small state files.
    var configDirectory: URL { get }
    /// Directory for caches that can be regenerated.
    var cacheDirectory: URL { get }
}

#if os(macOS)
public typealias DefaultPlatformPaths = MacOSPaths
#elseif os(Linux)
public typealias DefaultPlatformPaths = LinuxPaths
#elseif os(Windows)
public typealias DefaultPlatformPaths = WindowsPaths
#endif
