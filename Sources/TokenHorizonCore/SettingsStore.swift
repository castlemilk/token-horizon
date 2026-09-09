import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

public final class SettingsStore {
    public static let shared = SettingsStore()
    private let lock = NSLock()
    private let path: String
    private var _alibabaCookie: String
    private var _notifyOnLimitRefresh: Bool = true

    public var alibabaCookie: String {
        get { lock.lock(); defer { lock.unlock() }; return _alibabaCookie }
        set {
            lock.lock()
            _alibabaCookie = newValue
            saveLocked()
            lock.unlock()
        }
    }

    public var notifyOnLimitRefresh: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _notifyOnLimitRefresh }
        set {
            lock.lock()
            _notifyOnLimitRefresh = newValue
            saveLocked()
            lock.unlock()
        }
    }

    private func saveLocked() {
        let payload: [String: Any] = [
            "alibabaCookie": _alibabaCookie,
            "notifyOnLimitRefresh": _notifyOnLimitRefresh
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload) {
            try? data.write(to: URL(fileURLWithPath: path))
            chmod(path, 0o600)
        }
    }

    private init() {
        let dir = Platform.paths.configDirectory.path
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        path = dir + "/settings.json"
        var c = ""
        var notify = true
        if let data = FileManager.default.contents(atPath: path),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            c = obj["alibabaCookie"] as? String ?? ""
            if let n = obj["notifyOnLimitRefresh"] as? Bool {
                notify = n
            }
        }
        if c.isEmpty {
            let fb = Platform.paths.configDirectory.appendingPathComponent("alibaba-cookie.txt").path
            c = (try? String(contentsOfFile: fb, encoding: .utf8)) ?? ""
        }
        _alibabaCookie = c.trimmingCharacters(in: .whitespacesAndNewlines)
        _notifyOnLimitRefresh = notify
    }

    public func getCookie() -> String { alibabaCookie }

    public func setCookie(_ s: String) { alibabaCookie = s }
}
