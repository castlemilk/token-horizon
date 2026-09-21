import Foundation
import os

private let gatewayLog = Logger(subsystem: "com.tokenhorizon.app", category: "gateway-supervisor")

// MARK: - Gateway supervisor
//
// The LLM gateway is a standalone Go sidecar (`gateway/`, zero-dep single
// binary) — portable, decoupled, and runnable without the Mac app. This
// supervisor keeps the app-side contract small: attach to an already-running
// gateway if one answers on loopback, else spawn the bundled binary with our
// environment (ports, upstreams) and terminate it on quit. Standalone runs
// (`./token-horizon-gateway`) simply get attached to.
//
// Discovery is port-based, never assumed: the gateway walks 127.0.0.1:11436+
// and identifies itself via GET /__token_horizon. All reads go through the
// gateway's own API; :8765 reverse-proxies those paths (GatewayBridge) so
// MCP/UI/shell clients keep one API surface.

final class GatewaySupervisor {
    static let shared = GatewaySupervisor()

    /// Candidate loopback ports, matching the gateway's own walk range.
    static let firstPort: UInt16 = 11436
    static let portCount = 20

    private let lock = NSLock()
    private var process: Process?
    private var spawned = false
    private var cachedBaseURL: URL?
    private var cachedGatewayCommit = "?"

    /// Cached-only base URL (no probing — safe for main-thread UI reads).
    var baseURL: URL? {
        lock.lock()
        defer { lock.unlock() }
        return cachedBaseURL
    }

    /// Cached-only gateway port for /health and UI chrome.
    var port: UInt16? {
        guard let url = baseURL, let port = url.port, port > 0, port < 65536 else { return nil }
        return UInt16(port)
    }

    /// Cached URL if present, else a synchronous loopback probe (cheap:
    /// refused connections fail instantly). Call off the main thread.
    func resolveBaseURL() -> URL? {
        lock.lock()
        if let cached = cachedBaseURL {
            lock.unlock()
            return cached
        }
        lock.unlock()
        guard let found = probe() else { return nil }
        lock.lock()
        cachedBaseURL = found
        lock.unlock()
        return found
    }

    func start() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            if self.resolveBaseURL() != nil {
                self.checkStamp(preface: "attached to running gateway")
                return
            }
            self.spawn()
        }
    }

    func stop() {
        lock.lock()
        let proc = spawned ? process : nil
        process = nil
        spawned = false
        cachedBaseURL = nil
        lock.unlock()
        proc?.terminate()
    }

    // MARK: Internals (internal for tests)

    /// Binary lookup: explicit env override (dev inner loop) wins, then the
    /// packaged app bundle. Never guesses install locations.
    static func binaryURL() -> URL? {
        if let override = ProcessInfo.processInfo.environment["TOKEN_HORIZON_GATEWAY_BIN"],
           !override.isEmpty {
            let url = URL(fileURLWithPath: override)
            if FileManager.default.isExecutableFile(atPath: url.path) { return url }
        }
        if let resources = Bundle.main.resourcePath {
            let url = URL(fileURLWithPath: resources).appendingPathComponent("token-horizon-gateway")
            if FileManager.default.isExecutableFile(atPath: url.path) { return url }
        }
        return nil
    }

    private func probe() -> URL? {
        let (url, commit) = probeWithStamp()
        if let commit {
            lock.lock()
            cachedGatewayCommit = commit
            lock.unlock()
        }
        return url
    }

    /// Build-stamp handshake: a sidecar from a different commit still works
    /// (standalone upgrades), but a mismatch is logged loudly — a stale
    /// sidecar serving a fresh app (or vice versa) is a debugging trap.
    private func checkStamp(preface: String) {
        lock.lock()
        let commit = cachedGatewayCommit
        lock.unlock()
        if commit == BuildInfo.commit {
            gatewayLog.info("Gateway supervisor: \(preface, privacy: .public) (build \(commit, privacy: .public) matches app)")
        } else {
            gatewayLog.error("Gateway supervisor: \(preface, privacy: .public) but sidecar build \(commit, privacy: .public) != app build \(BuildInfo.commit, privacy: .public) — rebuild the app to resync")
        }
    }

    private func probeWithStamp() -> (URL?, String?) {
        for i in 0..<Self.portCount {
            let port = Self.firstPort + UInt16(i)
            guard let url = URL(string: "http://127.0.0.1:\(port)/__token_horizon") else { continue }
            var request = URLRequest(url: url, timeoutInterval: 0.3)
            request.httpMethod = "GET"
            var identified: URL?
            var commit: String?
            let sema = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: request) { data, _, _ in
                defer { sema.signal() }
                guard let data,
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      (obj["name"] as? String) == "token-horizon-llm-gateway" else { return }
                identified = URL(string: "http://127.0.0.1:\(port)")
                commit = (obj["build"] as? [String: Any])?["commit"] as? String
            }.resume()
            _ = sema.wait(timeout: .now() + 0.5)
            if let identified {
                return (identified, commit)
            }
        }
        return (nil, nil)
    }

    private func spawn() {
        guard let binary = Self.binaryURL() else {
            gatewayLog.info("Gateway supervisor: no sidecar binary (set TOKEN_HORIZON_GATEWAY_BIN or rebuild the app); gateway routes will 503")
            return
        }
        let proc = Process()
        proc.executableURL = binary
        proc.environment = ProcessInfo.processInfo.environment
        let logURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/token-horizon-gateway.log")
        if FileManager.default.createFile(atPath: logURL.path, contents: nil) {
            proc.standardOutput = try? FileHandle(forWritingTo: logURL)
            proc.standardError = proc.standardOutput
        }
        do {
            try proc.run()
        } catch {
            gatewayLog.error("Gateway supervisor: spawn failed: \(String(describing: error))")
            return
        }
        lock.lock()
        process = proc
        spawned = true
        lock.unlock()
        // Poll for readiness; a slow first bind still attaches within seconds.
        for _ in 0..<25 {
            if let found = probe() {
                lock.lock()
                cachedBaseURL = found
                lock.unlock()
                checkStamp(preface: "spawned sidecar ready")
                return
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        gatewayLog.error("Gateway supervisor: sidecar spawned but never answered")
    }
}

// MARK: - Gateway bridge (:8765 pass-through)
//
// Forwards the gateway-owned paths to the sidecar so MCP/UI/shell keep one
// API surface. Failures degrade to 503 (gateway optional, app never blocks).

enum GatewayBridge {
    /// Paths owned by the sidecar (prefix match for /traces/<id>).
    static func owns(method: String, route: String) -> Bool {
        switch (method, route) {
        case ("GET", "/traces"), ("GET", "/proxy/stats"), ("GET", "/proxy/config"),
             ("POST", "/traces/clear"), ("GET", "/traces/clear"):
            return true
        default:
            return method == "GET" && route.hasPrefix("/traces/")
        }
    }

    /// Join a gateway base URL with the client path (query preserved).
    static func targetURL(base: URL, path: String) -> URL? {
        let suffix = path.hasPrefix("/") ? path : "/" + path
        return URL(string: base.absoluteString + suffix)
    }

    static func response(method: String, path: String, body: Data, baseURL: URL?,
                         json: (Any, Int) -> Data) -> Data? {
        guard let baseURL, let target = targetURL(base: baseURL, path: path) else {
            return json(["error": "llm gateway unavailable",
                         "hint": "start Token Horizon with the gateway sidecar, or run gateway/token-horizon-gateway standalone"], 503)
        }
        var request = URLRequest(url: target, timeoutInterval: 10)
        request.httpMethod = method
        if method == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        var status = 0
        var payload = Data()
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            payload = data ?? Data()
            sema.signal()
        }.resume()
        guard sema.wait(timeout: .now() + 10) == .success, status > 0,
              let obj = try? JSONSerialization.jsonObject(with: payload) else {
            return json(["error": "llm gateway unreachable"], 503)
        }
        return json(obj, status)
    }
}
