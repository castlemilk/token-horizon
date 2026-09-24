import Foundation
import os

private let engineLog = Logger(subsystem: "com.tokenhorizon.app", category: "engine-supervisor")

// MARK: - Engine supervisor
//
// The local inference engine is a supervised `splash serve` process — the
// same attach-or-spawn discipline as the gateway sidecar: if a splash server
// already answers on loopback we adopt it (read-only — we never kill a server
// we didn't start); otherwise the user can serve a model and we own the
// child, its log, and its shutdown.
//
// The server speaks OpenAI Chat/Responses + Anthropic Messages on :8000 and
// exposes /health /ready /status /metrics. The gateway's /th-splash/ prefix
// routes to it so every local inference is traced for free.

final class EngineSupervisor: ObservableObject {
    static let shared = EngineSupervisor()

    static let defaultPort: UInt16 = 8000

    enum State: Equatable {
        case stopped
        case starting(model: String)
        case serving(model: String, pid: Int, attached: Bool)
        case failed(String)

        var isServing: Bool {
            if case .serving = self { return true }
            return false
        }
        var isBusy: Bool {
            if case .starting = self { return true }
            return false
        }
    }

    @Published private(set) var state: State = .stopped
    /// Last /status payload from the engine (model, memory, request counters).
    @Published private(set) var status: [String: Any]?
    @Published private(set) var lastError: String?

    private let lock = NSLock()
    private var process: Process?
    private var pollTimer: Timer?

    /// Cached port — only meaningful while a server answers.
    private(set) var port: UInt16 = defaultPort

    // MARK: - Binary discovery

    /// `splash` launcher lookup: explicit env override wins (dev inner loop
    /// against a source checkout), then brew locations, then PATH.
    static func binaryURL() -> URL? {
        let env = ProcessInfo.processInfo.environment
        if let override = env["TOKEN_HORIZON_SPLASH_BIN"], !override.isEmpty {
            let url = URL(fileURLWithPath: override)
            if FileManager.default.isExecutableFile(atPath: url.path) { return url }
        }
        for path in ["/opt/homebrew/bin/splash", "/usr/local/bin/splash"] {
            if FileManager.default.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        return nil
    }

    var engineAvailable: Bool { Self.binaryURL() != nil }

    // MARK: - Installed-model check (packaged layout)

    /// Packaged splash keeps models under ~/Library/Application Support/
    /// Splash/models/<owner>/<repo>; a source checkout uses install/models/.
    /// We only report installed-ness — the engine remains the authority on
    /// whether a snapshot is complete and verified.
    static func installedModelIDs() -> Set<String> {
        var found = Set<String>()
        let roots = [
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/Splash/models"),
            Self.binaryURL()?
                .deletingLastPathComponent() // …/bin
                .appendingPathComponent("../libexec/install/models")
                .standardizedFileURL,
        ].compactMap { $0 }
        for root in roots {
            guard let owners = try? FileManager.default.contentsOfDirectory(
                at: root, includingPropertiesForKeys: nil) else { continue }
            for owner in owners {
                guard let repos = try? FileManager.default.contentsOfDirectory(
                    at: owner, includingPropertiesForKeys: nil) else { continue }
                for repo in repos {
                    found.insert("\(owner.lastPathComponent)/\(repo.lastPathComponent)")
                }
            }
        }
        return found
    }

    // MARK: - Lifecycle

    /// Poll the engine once; adopt a running server or clear stale state.
    /// Safe to call repeatedly — cheap loopback probe.
    func refresh() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.probeAndUpdate()
        }
    }

    func startPolling() {
        pollTimer?.invalidate()
        let t = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        RunLoop.main.add(t, forMode: .common)
        pollTimer = t
        refresh()
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    /// Serve a model with the given ceilings. If a server already answers,
    /// this adopts it instead of double-serving (splash's own lock file would
    /// refuse the second instance anyway).
    func serve(model: String, maxMemoryGB: Int?, maxContextK: Int?) {
        lock.lock()
        let busy = state.isBusy || state.isServing
        lock.unlock()
        guard !busy else { return }

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            if self.probeAndUpdate() != nil { return } // already serving — adopted
            self.spawnServe(model: model, maxMemoryGB: maxMemoryGB, maxContextK: maxContextK)
        }
    }

    /// Stop the server — only one we spawned. An adopted (external) server is
    /// left running; it belongs to whoever started it.
    func stop() {
        lock.lock()
        let proc = process
        process = nil
        lock.unlock()
        if let proc, proc.isRunning {
            proc.terminate() // SIGTERM — splash handles Ctrl+C-equivalent cleanup
        }
        DispatchQueue.main.async {
            self.state = .stopped
            self.status = nil
        }
    }

    func shutdown() {
        stopPolling()
        stop()
    }

    // MARK: - API payload

    /// JSON-safe snapshot for GET /engine: supervisor state, hardware
    /// profile, per-model fit + installed flags, and the engine's own
    /// /status fields (passed through verbatim under "engine").
    func snapshotPayload() -> [String: Any] {
        let machine = HardwareProfile.probe()
        let installed = Self.installedModelIDs()
        let models: [[String: Any]] = HardwareProfile.catalog.map { m in
            let f = HardwareProfile.fit(m, on: machine)
            let ceil = HardwareProfile.recommendedCeilings(m, on: machine)
            return [
                "id": m.id, "name": m.displayName, "kind": m.kind,
                "package_gb": m.packageGB, "resident_gb": m.residentGB,
                "recommended_ram_gb": m.recommendedRAMGB,
                "fit": f.rawValue, "fit_label": f.badge,
                "installed": installed.contains(m.id),
                "suggested_max_memory_gb": ceil.maxMemoryGB,
                "suggested_max_context_k": ceil.maxContextK,
            ]
        }
        var stateObj: [String: Any]
        switch state {
        case .stopped:
            stateObj = ["state": "stopped"]
        case .starting(let model):
            stateObj = ["state": "starting", "model": model]
        case .serving(let model, let pid, let attached):
            stateObj = ["state": "serving", "model": model, "pid": pid, "attached": attached]
        case .failed(let reason):
            stateObj = ["state": "failed", "error": reason]
        }
        return [
            "supervisor": stateObj,
            "engine_binary": Self.binaryURL()?.path ?? NSNull(),
            "port": Self.defaultPort,
            "hardware": [
                "chip": machine.chipName,
                "memory_gb": machine.physicalMemoryGB,
                "macos": "\(machine.macosMajor).\(machine.macosMinor)",
                "eligible": HardwareProfile.eligibilityBlocker(machine) == nil,
                "blocker": HardwareProfile.eligibilityBlocker(machine) ?? NSNull(),
            ],
            "models": models,
            "engine": status ?? NSNull(),
            "last_error": lastError ?? NSNull(),
        ]
    }

    // MARK: - Internals

    /// GET /status on :8000. Returns the payload when a splash server
    /// answers, and publishes .serving/.stopped accordingly.
    @discardableResult
    private func probeAndUpdate() -> [String: Any]? {
        guard let url = URL(string: "http://127.0.0.1:\(Self.defaultPort)/status") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 0.6)
        req.httpMethod = "GET"
        var payload: [String: Any]?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            defer { sema.signal() }
            guard let data,
                  let code = (resp as? HTTPURLResponse)?.statusCode, code == 200,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  obj["instance"] != nil else { return }
            payload = obj
        }.resume()
        _ = sema.wait(timeout: .now() + 1.0)

        let spawnedPID: Int? = {
            lock.lock(); defer { lock.unlock() }
            return (process?.isRunning == true) ? Int(process!.processIdentifier) : nil
        }()
        DispatchQueue.main.async {
            if let payload {
                self.status = payload
                let inst = payload["instance"] as? [String: Any] ?? [:]
                let model = inst["model"] as? String ?? "?"
                let pid = inst["pid"] as? Int ?? spawnedPID ?? 0
                self.state = .serving(model: model, pid: pid, attached: spawnedPID == nil)
            } else {
                self.status = nil
                if case .serving = self.state { self.state = .stopped }
                // .starting/.failed keep their state until resolve or timeout
            }
        }
        return payload
    }

    private func spawnServe(model: String, maxMemoryGB: Int?, maxContextK: Int?) {
        guard let bin = Self.binaryURL() else {
            publishFail("splash not installed — brew install incoai/tap/splash")
            return
        }
        var args = ["serve", "--model", model]
        if let mem = maxMemoryGB { args += ["--max-memory", "\(mem)G"] }
        if let ctx = maxContextK { args += ["--max-context", "\(ctx)K"] }

        let proc = Process()
        proc.executableURL = bin
        proc.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        proc.environment = env
        let logURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/token-horizon-engine.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let fh = try? FileHandle(forWritingTo: logURL) {
            proc.standardOutput = fh
            proc.standardError = fh
        }
        proc.terminationHandler = { [weak self] p in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .starting(let m) = self.state, m == model {
                    self.state = .failed("splash exited (\(p.terminationStatus)) during startup — see ~/Library/Logs/token-horizon-engine.log")
                }
                self.process = nil
            }
        }
        do {
            try proc.run()
        } catch {
            publishFail("spawn failed: \(error.localizedDescription)")
            return
        }
        lock.lock()
        process = proc
        lock.unlock()
        DispatchQueue.main.async { self.state = .starting(model: model) }
        engineLog.info("Engine supervisor: spawned splash serve \(model, privacy: .public)")

        // First-serve downloads can take a very long time (~20 GB). Poll
        // /status until the server answers; the launcher prints download
        // progress to the log meanwhile.
        for _ in 0..<360 { // ~30 min ceiling
            if self.probeAndUpdate() != nil { return }
            lock.lock(); let alive = process?.isRunning == true; lock.unlock()
            if !alive { return } // terminationHandler publishes the failure
            Thread.sleep(forTimeInterval: 5)
        }
        publishFail("timed out waiting for splash to come up")
    }

    private func publishFail(_ message: String) {
        engineLog.error("Engine supervisor: \(message, privacy: .public)")
        DispatchQueue.main.async {
            self.state = .failed(message)
            self.lastError = message
        }
    }
}
