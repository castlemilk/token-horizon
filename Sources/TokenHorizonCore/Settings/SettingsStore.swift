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
    private var _runtimeEndpoints: [String: [RuntimeEndpoint]] = [:]

    /// User-managed self-hosted runtime endpoints, vendor → list.
    /// Cloud providers are NOT configurable here (their API bases are fixed
    /// by the provider class); this list exists for self-hosters running
    /// vLLM/SGLang/llama.cpp/Ollama on arbitrary hosts/ports.
    public var runtimeEndpoints: [String: [RuntimeEndpoint]] {
        get { lock.lock(); defer { lock.unlock() }; return _runtimeEndpoints }
        set {
            lock.lock()
            _runtimeEndpoints = newValue
            saveLocked()
            lock.unlock()
        }
    }

    public func addRuntimeEndpoint(vendor: String, _ endpoint: RuntimeEndpoint) {
        lock.lock()
        var list = _runtimeEndpoints[vendor] ?? []
        if !list.contains(where: { $0.url == endpoint.url }) {
            list.append(endpoint)
            _runtimeEndpoints[vendor] = list
            saveLocked()
        }
        lock.unlock()
    }

    public func removeRuntimeEndpoint(vendor: String, url: String) {
        lock.lock()
        if var list = _runtimeEndpoints[vendor] {
            list.removeAll { $0.url == url }
            _runtimeEndpoints[vendor] = list
            saveLocked()
        }
        lock.unlock()
    }

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
            "notifyOnLimitRefresh": _notifyOnLimitRefresh,
            "runtimeEndpoints": _runtimeEndpoints.mapValues { list in
                list.map { $0.asDict }
            },
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
        var endpoints: [String: [RuntimeEndpoint]] = [:]
        if let data = FileManager.default.contents(atPath: path),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            c = obj["alibabaCookie"] as? String ?? ""
            if let n = obj["notifyOnLimitRefresh"] as? Bool {
                notify = n
            }
            if let dict = obj["runtimeEndpoints"] as? [String: [[String: Any]]] {
                for (vendor, list) in dict {
                    endpoints[vendor] = list.compactMap { RuntimeEndpoint(dict: $0) }
                }
            }
        }
        if c.isEmpty {
            let fb = Platform.paths.configDirectory.appendingPathComponent("alibaba-cookie.txt").path
            c = (try? String(contentsOfFile: fb, encoding: .utf8)) ?? ""
        }
        _alibabaCookie = c.trimmingCharacters(in: .whitespacesAndNewlines)
        _notifyOnLimitRefresh = notify
        _runtimeEndpoints = endpoints
    }

    public func getCookie() -> String { alibabaCookie }

    public func setCookie(_ s: String) { alibabaCookie = s }
}
