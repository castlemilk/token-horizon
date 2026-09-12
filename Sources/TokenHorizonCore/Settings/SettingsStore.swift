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
    private var _meterCaptureMode: String = MeterCaptureMode.point.rawValue
    private var _filePolling: Bool = false
    /// Per-vendor meter desired state: true = always on, false = off (also
    /// suppresses runtime auto-metering), absent = default (runtimes auto,
    /// cloud vendors off). Persisted; the daemon reconciles live meters to
    /// this map (POST /meters/toggle) and applies it at startup.
    private var _meterToggles: [String: Bool] = [:]

    public var meterToggles: [String: Bool] {
        lock.lock(); defer { lock.unlock() }
        return _meterToggles
    }

    public func setMeterEnabled(_ vendor: String, _ enabled: Bool) {
        lock.lock()
        _meterToggles[vendor.lowercased()] = enabled
        saveLocked()
        lock.unlock()
    }

    /// How usage is measured: "point" (tools configured at loopback meters —
    /// the default, and the only mode corporate machines should use) or
    /// "mitm" (scoped TLS interception of AI vendor hosts via a local proxy,
    /// requires .mitm consent + mitmproxy). Swappable at runtime; env
    /// TH_CAPTURE_MODE overrides.
    public var meterCaptureMode: MeterCaptureMode {
        get {
            if let env = ProcessInfo.processInfo.environment["TH_CAPTURE_MODE"],
               let mode = MeterCaptureMode(rawValue: env.lowercased()) { return mode }
            lock.lock(); defer { lock.unlock() }
            return MeterCaptureMode(rawValue: _meterCaptureMode) ?? .point
        }
        set {
            lock.lock()
            _meterCaptureMode = newValue.rawValue
            saveLocked()
            lock.unlock()
        }
    }

    /// Automatic periodic file consolidation (annotations + limit snapshots).
    /// DEFAULT OFF: consolidation is a deliberate, manual action (POST
    /// /consolidate) — files are not the usage source, so there is no reason
    /// to read them continuously. Env TH_FILE_POLL=1 forces polling on.
    public var filePolling: Bool {
        get {
            if ProcessInfo.processInfo.environment["TH_FILE_POLL"] == "1" { return true }
            lock.lock(); defer { lock.unlock() }
            return _filePolling
        }
        set {
            lock.lock()
            _filePolling = newValue
            saveLocked()
            lock.unlock()
        }
    }

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
            "meterCaptureMode": _meterCaptureMode,
            "filePolling": _filePolling,
            "meterToggles": _meterToggles,
            "runtimeEndpoints": _runtimeEndpoints.mapValues { list in
                list.map { $0.asDict }
            },
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload) {
            try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
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
            if let m = obj["meterCaptureMode"] as? String {
                _meterCaptureMode = m
            }
            if let fp = obj["filePolling"] as? Bool {
                _filePolling = fp
            }
            if let t = obj["meterToggles"] as? [String: Bool] {
                _meterToggles = t
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
