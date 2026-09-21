import Combine
import Foundation
import os

private let engineLog = Logger(subsystem: "com.tokenhorizon.app", category: "engine-supervisor")

// MARK: - Engine backends
//
// Token Horizon supervises local inference engines as sidecars — the same
// attach-or-spawn discipline as the gateway: if a server already answers on
// the backend's loopback port we adopt it (read-only — we never kill a
// server we didn't start); otherwise serve() spawns the child and owns its
// log + shutdown.
//
// Two backends today:
//   - splash    (:8000) — incoai's specialized engine; vendored source at
//                 docs/splash. Closed SPLH protocol; we tune via CLI flags.
//   - thengine  (:8001) — our Rust/candle engine (engine/); the TH-owned
//                 surface with live config + introspection hooks.
//
// Both answer /status with an `instance` object, so the probe is uniform.

/// Static description of one supervised engine backend.
struct EngineBackend {
    let id: String              // "splash" | "thengine"
    let displayName: String
    let port: UInt16
    let binaryEnvVar: String
    let binarySearchPaths: [String]
    /// Extra env for the spawned child.
    var spawnEnv: [String: String] { [:] }

    /// CLI args for a serve. `model` is the backend's model spec
    /// (HF repo id for splash; repo/path or repo:file for thengine).
    /// `tokenizer` is only meaningful for thengine (GGUF repos ship no
    /// tokenizer.json — the catalog carries the sibling base repo).
    func spawnArgs(model: String, tokenizer: String?,
                   maxMemoryGB: Int?, maxContextK: Int?) -> [String] {
        switch id {
        case "splash":
            var args = ["serve", "--model", model]
            if let m = maxMemoryGB { args += ["--max-memory", "\(m)G"] }
            if let c = maxContextK { args += ["--max-context", "\(c)K"] }
            return args
        default: // thengine
            var args = ["serve", "--model", model, "--port", "\(port)"]
            if let t = tokenizer { args += ["--tokenizer", t] }
            if let c = maxContextK { args += ["--max-context", "\(c * 1024)"] }
            return args
        }
    }
}

extension EngineBackend {
    static let splash = EngineBackend(
        id: "splash", displayName: "Splash",
        port: 8000,
        binaryEnvVar: "TOKEN_HORIZON_SPLASH_BIN",
        binarySearchPaths: ["/opt/homebrew/bin/splash", "/usr/local/bin/splash"])

    static let thengine = EngineBackend(
        id: "thengine", displayName: "TH Engine",
        port: 8001,
        binaryEnvVar: "TOKEN_HORIZON_TH_ENGINE_BIN",
        binarySearchPaths: [
            // bundled sidecar (release app), dev builds, cargo bin
            Bundle.main.resourceURL?
                .appendingPathComponent("th-engine").path ?? "",
            "/Users/benebsworth/projects/token-horizon/engine/target/release/th-engine",
            "/opt/homebrew/bin/th-engine",
        ])

    static let all: [EngineBackend] = [.splash, .thengine]
}

// MARK: - Per-backend supervisor

final class BackendSupervisor: ObservableObject {
    let backend: EngineBackend

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
    /// Last /status payload (model, memory, request counters).
    @Published private(set) var status: [String: Any]?
    @Published private(set) var lastError: String?

    private let lock = NSLock()
    private var process: Process?
    private var pollTimer: Timer?

    init(backend: EngineBackend) {
        self.backend = backend
    }

    // MARK: Binary discovery

    func binaryURL() -> URL? {
        let env = ProcessInfo.processInfo.environment
        if let override = env[backend.binaryEnvVar], !override.isEmpty {
            let url = URL(fileURLWithPath: override)
            if FileManager.default.isExecutableFile(atPath: url.path) { return url }
        }
        for path in backend.binarySearchPaths where !path.isEmpty {
            if FileManager.default.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        return nil
    }

    var engineAvailable: Bool { binaryURL() != nil }

    // MARK: Lifecycle

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

    /// Serve a model. If a server already answers on the backend's port we
    /// adopt it instead of double-serving.
    func serve(model: String, tokenizer: String? = nil,
               maxMemoryGB: Int?, maxContextK: Int?) {
        lock.lock()
        let busy = state.isBusy || state.isServing
        lock.unlock()
        guard !busy else { return }

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            if self.probeAndUpdate() != nil { return }
            self.spawnServe(model: model, tokenizer: tokenizer,
                            maxMemoryGB: maxMemoryGB, maxContextK: maxContextK)
        }
    }

    /// Stop only a server we spawned; an adopted one belongs to whoever ran it.
    func stop() {
        lock.lock()
        let proc = process
        process = nil
        lock.unlock()
        if let proc, proc.isRunning {
            proc.terminate()
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

    // MARK: Payload

    func payload() -> [String: Any] {
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
            "id": backend.id,
            "name": backend.displayName,
            "supervisor": stateObj,
            "engine_binary": binaryURL()?.path ?? NSNull(),
            "port": backend.port,
            "engine": status ?? NSNull(),
            "last_error": lastError ?? NSNull(),
        ]
    }

    // MARK: Internals

    /// GET /status on the backend port. Returns the payload when a server
    /// answers and publishes .serving/.stopped accordingly.
    @discardableResult
    private func probeAndUpdate() -> [String: Any]? {
        guard let url = URL(string: "http://127.0.0.1:\(backend.port)/status") else { return nil }
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
            }
        }
        return payload
    }

    private func spawnServe(model: String, tokenizer: String?,
                            maxMemoryGB: Int?, maxContextK: Int?) {
        guard let bin = binaryURL() else {
            publishFail("\(backend.id) not installed")
            return
        }
        let args = backend.spawnArgs(model: model, tokenizer: tokenizer,
                                     maxMemoryGB: maxMemoryGB, maxContextK: maxContextK)

        let proc = Process()
        proc.executableURL = bin
        proc.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        for (k, v) in backend.spawnEnv { env[k] = v }
        proc.environment = env
        let logURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/token-horizon-engine-\(backend.id).log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let fh = try? FileHandle(forWritingTo: logURL) {
            proc.standardOutput = fh
            proc.standardError = fh
        }
        proc.terminationHandler = { [weak self] p in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .starting(let m) = self.state, m == model {
                    self.state = .failed("\(self.backend.id) exited (\(p.terminationStatus)) during startup — see ~/Library/Logs/token-horizon-engine-\(self.backend.id).log")
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
        engineLog.info("Engine supervisor: spawned \(self.backend.id, privacy: .public) serve \(model, privacy: .public)")

        // First-serve model downloads can take a very long time (~20 GB).
        for _ in 0..<360 { // ~30 min ceiling
            if self.probeAndUpdate() != nil { return }
            lock.lock(); let alive = process?.isRunning == true; lock.unlock()
            if !alive { return }
            Thread.sleep(forTimeInterval: 5)
        }
        publishFail("timed out waiting for \(backend.id) to come up")
    }

    private func publishFail(_ message: String) {
        engineLog.error("Engine supervisor: \(message, privacy: .public)")
        DispatchQueue.main.async {
            self.state = .failed(message)
            self.lastError = message
        }
    }
}

// MARK: - Installed-model detection (Splash packaged layout)

/// Packaged splash keeps models under ~/Library/Application Support/
/// Splash/models/<owner>/<repo>; a source checkout uses install/models/.
/// We only report installed-ness — the engine remains the authority on
/// whether a snapshot is complete and verified.
func splashInstalledModelIDs() -> Set<String> {
    var found = Set<String>()
    let roots = [
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Splash/models"),
        URL(fileURLWithPath: "/opt/homebrew/bin/splash")
            .deletingLastPathComponent()
            .appendingPathComponent("../libexec/install/models")
            .standardizedFileURL,
    ]
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

// MARK: - Manager facade
//
// One entry point for the app + API: holds both backend supervisors and
// produces the combined /engine payload (per-backend state + hardware +
// model catalogs). Views observe this.

final class EngineManager: ObservableObject {
    static let shared = EngineManager()

    let splash = BackendSupervisor(backend: .splash)
    let thengine = BackendSupervisor(backend: .thengine)

    /// Latest side-by-side bench results (scripts/bench-engines.sh writes
    /// ~/.config/token-horizon/engine-bench.json). Loaded lazily; refreshed
    /// on poll ticks so the ENGINE tab picks up new runs.
    @Published private(set) var bench: [String: Any]?

    private var observers = Set<AnyCancellable>()

    static let benchURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".config/token-horizon/engine-bench.json")

    func reloadBench() {
        guard let data = try? Data(contentsOf: Self.benchURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        bench = obj
    }

    private init() {
        // Forward child @Published changes so views observing the manager
        // refresh without subscribing to each supervisor.
        splash.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }.store(in: &observers)
        thengine.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }.store(in: &observers)
    }

    func supervisor(for id: String) -> BackendSupervisor? {
        switch id {
        case "splash": return splash
        case "thengine", "th", "th-engine": return thengine
        default: return nil
        }
    }

    func startPolling() {
        splash.startPolling()
        thengine.startPolling()
        reloadBench()
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.reloadBench()
        }
    }

    func shutdown() {
        splash.shutdown()
        thengine.shutdown()
    }

    /// Combined GET /engine payload.
    func snapshotPayload() -> [String: Any] {
        let machine = HardwareProfile.probe()
        let installed = splashInstalledModelIDs()
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
        return [
            "backends": [
                "splash": splash.payload(),
                "thengine": thengine.payload(),
            ],
            "hardware": [
                "chip": machine.chipName,
                "memory_gb": machine.physicalMemoryGB,
                "macos": "\(machine.macosMajor).\(machine.macosMinor)",
                "eligible": HardwareProfile.eligibilityBlocker(machine) == nil,
                "blocker": HardwareProfile.eligibilityBlocker(machine) ?? NSNull(),
            ],
            "models": models,
            "thengine_models": THEngineModel.catalogPayload(),
        ]
    }
}
