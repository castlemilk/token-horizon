#if os(Windows)
import Foundation

/// Windows filesystem layout under %APPDATA% / %LOCALAPPDATA%.
public struct WindowsPaths: PlatformPathsProviding {
    public init() {}

    public var homeDirectory: URL {
        URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    }

    public var configDirectory: URL {
        let base = ProcessInfo.processInfo.environment["APPDATA"]
            ?? homeDirectory.appendingPathComponent("AppData/Roaming").path
        return URL(fileURLWithPath: base, isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
    }

    public var cacheDirectory: URL {
        let base = ProcessInfo.processInfo.environment["LOCALAPPDATA"]
            ?? homeDirectory.appendingPathComponent("AppData/Local").path
        return URL(fileURLWithPath: base, isDirectory: true)
            .appendingPathComponent("token-horizon", isDirectory: true)
    }
}
#endif // os(Windows)
