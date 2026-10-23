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
//   - mlx       (:8002) — Apple's mlx-lm server, the canonical Mac engine.
//                 Spawned as `python3 -m mlx_lm.server`; any mlx-community
//                 checkpoint runs, so the catalogue is not limited to a list.
//
// Splash and TH Engine answer /status with an `instance` object; mlx-lm has no
// /status, so its probe reads /v1/models. Both shapes yield the served model.

/// Static description of one supervised engine backend.
struct EngineBackend {
    let id: String              // "splash" | "thengine" | "mlx"
    let displayName: String
    let port: UInt16
    let binaryEnvVar: String
    let binarySearchPaths: [String]
    /// Module-style launches (`python3 -m mlx_lm.server`) put the module in
    /// front of the args; plain binaries leave this empty.
    var argPrefix: [String] = []
    /// Extra env for the spawned child.
    var spawnEnv: [String: String] = [:]
    /// Python module the interpreter must import for the backend to be usable
    /// (mlx-lm); nil for plain binaries.
    var moduleName: String? = nil
    /// Path that proves the server is up, and where the served model is named.
    var probePath: String = "/status"

    /// Extract the served model id from a probe response, reading only the
    /// shape this backend's own probe path serves. Anything else on the port
    /// (a foreign server, a different engine) yields nil and is never adopted.
    func probeModel(_ json: [String: Any]) -> String? {
        switch probePath {
        case "/v1/models":
            // mlx-lm: {"object":"list","data":[{"id":"repo",…}]}
            guard let data = json["data"] as? [[String: Any]] else { return nil }
            return data.first?["id"] as? String
        default:
            // splash / th-engine: {"instance":{"model":…,"pid":…}}
            guard let instance = json["instance"] as? [String: Any] else { return nil }
            return instance["model"] as? String
        }
    }

    /// CLI args for a serve. `model` is the backend's model spec
    /// (HF repo id for splash/mlx; repo/path or repo:file for thengine).
    /// `tokenizer` is only meaningful for thengine (GGUF repos ship no
    /// tokenizer.json — the catalog carries the sibling base repo).
    func spawnArgs(model: String, tokenizer: String?,
                   maxMemoryGB: Int?, maxContextK: Int?, keepLoaded: Bool = false) -> [String] {
        switch id {
        case "splash":
            var args = ["serve", "--model", model]
            if let m = maxMemoryGB { args += ["--max-memory", "\(m)G"] }
            if let c = maxContextK { args += ["--max-context", "\(c)K"] }
            return args
        case "mlx":
            // mlx-lm sizes itself from the model and the machine; it exposes no
            // memory or context ceiling, so those ceilings stay advisory here.
            return argPrefix + ["--model", model, "--host", "127.0.0.1", "--port", "\(port)"]
        default: // thengine
            var args = ["serve", "--model", model, "--port", "\(port)",
                        "--idle-timeout-secs", keepLoaded ? "0" : "300"]
            if let t = tokenizer { args += ["--tokenizer", t] }
            if let c = maxContextK { args += ["--max-context", "\(c * 1024)"] }
            // DFlash draft auto-attach: the only packaged draft is
            // trained against Qwen3.8-27B-class targets — a mismatched
            // draft just burns verify cycles, so gate on the model id.
            if model.lowercased().contains("qwen3.8"), model.contains("27"),
               let draft = Self.dflashDraftDir() {
                args += ["--draft", draft]
            }
            return args
        }
    }

    /// First usable Splash-packaged DFlash draft under the Splash models
    /// dir (`<org>/<pkg>/draft/model.bin` + `layer-0.bin`).
    static func dflashDraftDir() -> String? {
        let root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(
                "Library/Application Support/Splash/models")
        guard let orgs = try? FileManager.default
            .contentsOfDirectory(atPath: root.path) else { return nil }
        for org in orgs {
            let orgDir = root.appendingPathComponent(org)
            guard let pkgs = try? FileManager.default
                .contentsOfDirectory(atPath: orgDir.path) else { continue }
            for pkg in pkgs {
                let draft = orgDir.appendingPathComponent("\(pkg)/draft")
                let ok = FileManager.default.fileExists(
                    atPath: draft.appendingPathComponent("model.bin").path)
                    && FileManager.default.fileExists(
                        atPath: draft
                            .appendingPathComponent("layer-0.bin").path)
                if ok { return draft.path }
            }
        }
        return nil
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

    /// mlx-lm is a python module, not a binary: the "executable" is the
    /// interpreter, and the module is prepended to its args.
    static let mlx = EngineBackend(
        id: "mlx", displayName: "MLX",
        port: 8002,
        binaryEnvVar: "TOKEN_HORIZON_MLX_PYTHON",
        binarySearchPaths: [
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3",
        ],
        argPrefix: ["-m", "mlx_lm.server"],
        moduleName: "mlx_lm",
        probePath: "/v1/models")

    static let all: [EngineBackend] = [.splash, .thengine, .mlx]
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
        /// The model the state names, whatever the phase ("gpt-5.2-preview").
        var currentModel: String? {
            switch self {
            case .starting(let model): return model
            case .serving(let model, _, _): return model
            case .stopped, .failed: return nil
            }
        }
    }

    @Published private(set) var state: State = .stopped
    /// Last /status payload (model, memory, request counters).
    @Published private(set) var status: [String: Any]?
    @Published private(set) var lastError: String?

    private let lock = NSLock()
    private var process: Process?
    private var activationID: UUID?
    private var pollTimer: Timer?
    private var cachedBinary: URL?
    private var cachedModuleCheck: (String, Bool)?

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

    /// Interpreter resolved once — every availability check and spawn reuses
    /// it, so a python module backend is probed once, not per render.
    private var resolvedBinary: URL? {
        lock.lock()
        if let cachedBinary { lock.unlock(); return cachedBinary }
        lock.unlock()
        let url = binaryURL()
        lock.lock()
        cachedBinary = url
        lock.unlock()
        return url
    }

    /// Module backends (mlx-lm) must also import: an interpreter without the
    /// module cannot serve, and saying so up-front beats a failed spawn.
    private func moduleImportable(_ module: String) -> Bool {
        lock.lock()
        if let cachedModuleCheck, cachedModuleCheck.0 == module {
            let value = cachedModuleCheck.1
            lock.unlock()
            return value
        }
        lock.unlock()
        guard let bin = binaryURL() else { return false }
        let proc = Process()
        proc.executableURL = bin
        proc.arguments = ["-c", "import \(module)"]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        var ok = false
        do {
            try proc.run()
            proc.waitUntilExit()
            ok = proc.terminationStatus == 0
        } catch {
            ok = false
        }
        lock.lock()
        cachedModuleCheck = (module, ok)
        lock.unlock()
        return ok
    }

    var engineAvailable: Bool {
        guard resolvedBinary != nil else { return false }
        if let module = backend.moduleName { return moduleImportable(module) }
        return true
    }

    /// How to make the backend available, for the UI's hint line.
    var installHint: String? {
        switch backend.id {
        case "splash": return "splash not installed — run: brew install incoai/tap/splash"
        case "thengine": return "th-engine not built — run: cargo build --release -p th-engine (engine/)"
        case "mlx":
            guard resolvedBinary != nil else {
                return "python3 not found — MLX needs python3 with mlx-lm"
            }
            return "mlx-lm not installed — run: pip install mlx-lm"
        default: return nil
        }
    }

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
               maxMemoryGB: Int?, maxContextK: Int?, keepLoaded: Bool = false) {
        lock.lock()
        let busy = activationID != nil || state.isBusy || state.isServing
        let activation = UUID()
        if !busy { activationID = activation }
        lock.unlock()
        guard !busy else { return }

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            if self.probeAndUpdate() != nil {
                self.lock.lock()
                if self.activationID == activation { self.activationID = nil }
                self.lock.unlock()
                return
            }
            self.spawnServe(model: model, tokenizer: tokenizer,
                            maxMemoryGB: maxMemoryGB, maxContextK: maxContextK,
                            keepLoaded: keepLoaded, activation: activation)
        }
    }

    /// Stop only a server we spawned; an adopted one belongs to whoever ran it.
    func stop() {
        lock.lock()
        let proc = process
        process = nil
        activationID = nil
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

    /// GET the backend's probe path. Returns the payload when its own server
    /// answers and publishes .serving/.stopped accordingly.
    @discardableResult
    private func probeAndUpdate() -> [String: Any]? {
        guard let url = URL(string: "http://127.0.0.1:\(backend.port)\(backend.probePath)") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 0.6)
        req.httpMethod = "GET"
        var payload: [String: Any]?
        var servedModel: String?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            defer { sema.signal() }
            guard let data,
                  let code = (resp as? HTTPURLResponse)?.statusCode, code == 200,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            // The backend's own shape decides: /status names `instance.model`,
            // mlx-lm's /v1/models names `data[0].id`. Anything else on the port
            // is not ours.
            guard let model = self.backend.probeModel(obj) else { return }
            payload = obj
            servedModel = model
        }.resume()
        _ = sema.wait(timeout: .now() + 1.0)

        let spawnedPID: Int? = {
            lock.lock(); defer { lock.unlock() }
            return (process?.isRunning == true) ? Int(process!.processIdentifier) : nil
        }()
        DispatchQueue.main.async {
            if let payload, let model = servedModel {
                self.status = payload
                let inst = payload["instance"] as? [String: Any] ?? [:]
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
                            maxMemoryGB: Int?, maxContextK: Int?,
                            keepLoaded: Bool, activation: UUID) {
        guard let bin = resolvedBinary else {
            lock.lock()
            if activationID == activation { activationID = nil }
            lock.unlock()
            publishFail(installHint ?? "\(backend.id) not installed")
            return
        }
        let args = backend.spawnArgs(model: model, tokenizer: tokenizer,
                                     maxMemoryGB: maxMemoryGB, maxContextK: maxContextK,
                                     keepLoaded: keepLoaded)

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
                self.lock.lock()
                guard self.process === p else { self.lock.unlock(); return }
                self.process = nil
                self.activationID = nil
                self.lock.unlock()
                if case .starting(let m) = self.state, m == model {
                    self.state = .failed("\(self.backend.id) exited (\(p.terminationStatus)) during startup — see ~/Library/Logs/token-horizon-engine-\(self.backend.id).log")
                } else {
                    self.state = .stopped
                    self.status = nil
                }
            }
        }
        lock.lock()
        guard activationID == activation else { lock.unlock(); return }
        do {
            try proc.run()
        } catch {
            activationID = nil
            lock.unlock()
            publishFail("spawn failed: \(error.localizedDescription)")
            return
        }
        process = proc
        lock.unlock()
        DispatchQueue.main.async {
            self.lock.lock()
            let current = self.process === proc
            self.lock.unlock()
            if current { self.state = .starting(model: model) }
        }
        engineLog.info("Engine supervisor: spawned \(self.backend.id, privacy: .public) serve \(model, privacy: .public)")

        // First-serve model downloads can take a very long time (~20 GB).
        for _ in 0..<360 { // ~30 min ceiling
            if self.probeAndUpdate() != nil { return }
            lock.lock(); let alive = process === proc && proc.isRunning; lock.unlock()
            if !alive { return }
            Thread.sleep(forTimeInterval: 5)
        }
        stop()
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
    let mlx = BackendSupervisor(backend: .mlx)

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
        mlx.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }.store(in: &observers)
    }

    func supervisor(for id: String) -> BackendSupervisor? {
        switch id {
        case "splash": return splash
        case "thengine", "th", "th-engine": return thengine
        case "mlx", "mlx-lm", "mlx_lm": return mlx
        default: return nil
        }
    }

    func startPolling() {
        splash.startPolling()
        thengine.startPolling()
        mlx.startPolling()
        reloadBench()
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.reloadBench()
        }
    }

    func shutdown() {
        splash.shutdown()
        thengine.shutdown()
        mlx.shutdown()
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
                "mlx": mlx.payload(),
            ],
            "local_catalog": LocalModelCatalog.models().map { m in
                [
                    "id": m.id, "name": m.name, "engine": m.engine,
                    "params_b": m.paramsB, "quant": m.quant,
                    "download_gb": m.sizeGB, "resident_gb": m.residentGB,
                    "context_k": m.contextK, "capabilities": m.capabilities,
                    "min_ram_gb": m.minRAMGB, "recommended_ram_gb": m.recommendedRAMGB,
                    "license": m.license, "file": m.file ?? NSNull(),
                    "tokenizer": m.tokenizer ?? NSNull(),
                ]
            },
            // The catalogue reconciled for THIS machine, per engine — what a
            // client should actually offer to run, with fit and throughput.
            "recommendations": recommendationPayload(machine: machine),
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

    /// Per-engine "run this here" lists for `/engine`: the catalogue
    /// reconciled against the probed hardware, best first.
    private func recommendationPayload(machine: HardwareProfile.Machine) -> [String: Any] {
        let map = HardwareMap.load()
        var out: [String: Any] = [:]
        for engine in LocalModelCatalog.engines() {
            out[engine] = LocalModelCatalog.runnable(for: machine, engine: engine, map: map).map { rec in
                [
                    "id": rec.model.id,
                    "name": rec.model.name,
                    "model_spec": rec.model.modelSpec,
                    "engine": rec.model.engine,
                    "quant": rec.model.quant,
                    "download_gb": rec.model.sizeGB,
                    "context_k": rec.model.contextK,
                    "fit": rec.fit.rawValue,
                    "fit_label": rec.fit.badge,
                    "tok_per_sec": rec.tokPerSec,
                    "tok_per_sec_measured": rec.tokPerSecMeasured,
                    "suggested_max_memory_gb": rec.maxMemoryGB,
                    "suggested_max_context_k": rec.maxContextK,
                    "installed": HFModelStore.isInstalled(rec.model.id),
                ] as [String: Any]
            }
        }
        return out
    }
}
