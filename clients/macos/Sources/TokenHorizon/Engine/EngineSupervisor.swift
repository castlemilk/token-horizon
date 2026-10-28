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
            // mlx-lm: {"object":"list","data":[{"id":"repo",…}]}. mlx-vlm lists
            // the whole HF cache sorted by id and flags the one in memory with
            // `loaded` — no loaded entry there means nothing is served yet.
            guard let data = json["data"] as? [[String: Any]] else { return nil }
            if data.contains(where: { $0["loaded"] != nil }) {
                return data.first { $0["loaded"] as? Bool == true }?["id"] as? String
            }
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
    /// `idleSecs` is the engine's own inactivity deadline (0 = never); only
    /// thengine honours it natively — splash/mlx rely on the supervisor's
    /// watchdog instead. `expertCacheGB`/`maxNumSeqs` are mlx-vlm-only
    /// (Flint expert offload + concurrency); mlx-lm rejects both flags, so
    /// they are forwarded only when the model serves under mlx_vlm.
    func spawnArgs(model: String, tokenizer: String?,
                   maxMemoryGB: Int?, maxContextK: Int?, keepLoaded: Bool = false,
                   expertCacheGB: Int? = nil, maxNumSeqs: Int? = nil,
                   specTokens: Int? = nil, kvQuant: Bool? = nil,
                   idleSecs: Int = 60) -> [String] {
        switch id {
        case "splash":
            var args = ["serve", "--model", model]
            if let m = maxMemoryGB { args += ["--max-memory", "\(m)G"] }
            if let c = maxContextK { args += ["--max-context", "\(c)K"] }
            return args
        case "mlx":
            // mlx-lm sizes itself from the model and the machine; it exposes no
            // memory or context ceiling, so those ceilings stay advisory here.
            var args = ["-m", "\(serverModule(for: model) ?? "mlx_lm").server",
                        "--model", model, "--host", "127.0.0.1", "--port", "\(port)"]
            if serverModule(for: model) == "mlx_vlm" {
                if let e = expertCacheGB, e > 0 { args += ["--expert-cache-gb", "\(e)"] }
                if let n = maxNumSeqs, n > 0 { args += ["--max-num-seqs", "\(n)"] }
            }
            return args
        default: // thengine
            var args = ["serve", "--model", model, "--port", "\(port)",
                        "--idle-timeout-secs", keepLoaded ? "0" : "\(max(1, idleSecs))"]
            if let t = tokenizer { args += ["--tokenizer", t] }
            if let c = maxContextK { args += ["--max-context", "\(c * 1024)"] }
            // memgov admission budget: the engine plans weights + KV at the
            // context ceiling and refuses to load over an explicit budget
            // (previously this ceiling was ignored here).
            if let m = maxMemoryGB { args += ["--max-mem-gb", "\(m)"] }
            // profile knobs (ServeProfile.knobs) — lookup speculation and
            // TurboQuant KV.
            if let s = specTokens { args += ["--spec-tokens", "\(s)"] }
            if kvQuant == true { args += ["--kv-quant"] }
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

/// Named serve profiles — the payload's knobs bundled the way they get
/// used (HyperQwen-style): "reproduction" is the copy arm, where output
/// repeats input and prompt-lookup speculation pays, so thengine drafts at
/// its max; "long-context" trades decode memory for KV headroom via
/// TurboQuant. mlx sizes itself and splash has no matching flags — both
/// ignore profiles.
enum ServeProfile: String, CaseIterable {
    case chat
    case reproduction
    case longContext = "long-context"

    struct ParseError: Error, Equatable {
        let raw: String
        var message: String {
            "unknown profile '\(raw)' — chat | reproduction | long-context"
        }
    }

    /// nil/empty → nil (engine defaults). Unknown strings fail so the API
    /// can 400 instead of silently ignoring.
    static func parse(_ raw: String?) -> Result<ServeProfile?, ParseError> {
        guard let raw, !raw.isEmpty else { return .success(nil) }
        guard let p = ServeProfile(rawValue: raw) else {
            return .failure(ParseError(raw: raw))
        }
        return .success(p)
    }

    /// Knob expansion per backend. thengine only; nil = engine defaults.
    func knobs(backendId: String) -> (specTokens: Int?, kvQuant: Bool?) {
        guard backendId == "thengine" else { return (nil, nil) }
        switch self {
        case .chat: return (nil, nil)
        case .reproduction: return (7, nil)
        case .longContext: return (nil, true)
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

    /// mlx-lm is a python module, not a binary: the "executable" is the
    /// interpreter, and the module is prepended to its args.
    static let mlx = EngineBackend(
        id: "mlx", displayName: "MLX",
        port: 8002,
        binaryEnvVar: "TOKEN_HORIZON_MLX_PYTHON",
        binarySearchPaths: [
            // The managed runtime (scripts/setup-mlx-runtime.sh) wins: it is
            // the only interpreter guaranteed to carry the modules — system
            // pythons are fallbacks (Homebrew's is externally-managed).
            NSString("~/.config/token-horizon/mlx-runtime/bin/python")
                .expandingTildeInPath,
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3",
        ],
        // Flint checkpoints need mlx-vlm (≥0.7.10) — upstream mlx-lm support
        // is still pending (ml-explore/mlx-lm#1998). `serverModule` picks.
        argPrefix: ["-m", "mlx_lm.server"],
        moduleName: "mlx_lm",
        probePath: "/v1/models")

    static let all: [EngineBackend] = [.splash, .thengine, .mlx]

    /// The python module a model is served by. Flint-family checkpoints run
    /// under mlx-vlm today; everything else on mlx uses mlx-lm.
    func serverModule(for model: String) -> String? {
        guard id == "mlx" else { return moduleName }
        return model.lowercased().contains("flint") ? "mlx_vlm" : "mlx_lm"
    }
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
    /// "<interpreter path>|<module>" → probe outcome. Positives are cached;
    /// negatives are re-probed so a module installed while the app runs is
    /// picked up without a restart.
    private var cachedModuleCheck: [String: (installed: Bool, version: String?)] = [:]
    private var spawnedModel: String?
    // Idle lifecycle — guarded by `lock`, updated only on the probe queue.
    private var pinnedAtServe = false
    private var lastActivity = Date.distantPast
    private var lastRequestSig: UInt64?
    private var lastCpuNs: UInt64?
    private var idleSeconds: TimeInterval = 0

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

    /// Module backends (mlx-lm) must also import: an interpreter without the
    /// module cannot serve, and saying so up-front beats a failed spawn.
    /// `minVersion` gates checkpoints a too-old package can't serve (Flint →
    /// mlx-vlm ≥0.7.10); an installed module of unknown version passes.
    private func moduleImportable(_ module: String, minVersion: String? = nil) -> Bool {
        let probe = moduleProbe(module)
        guard probe.installed else { return false }
        guard let floor = minVersion, let have = probe.version else { return true }
        return Self.versionAtLeast(have, floor)
    }

    /// `find_spec` + `importlib.metadata` instead of a real import: ~20 ms
    /// against ~1 s to import mlx_vlm, cheap enough to run on the UI path.
    /// The child writes its verdict to a temp file (the project's pipe-safe
    /// pattern — no Pipe+waitUntilExit reads).
    private func moduleProbe(_ module: String) -> (installed: Bool, version: String?) {
        let interpreter = binaryURL()?.path ?? ""
        let key = "\(interpreter)|\(module)"
        lock.lock()
        if let hit = cachedModuleCheck[key], hit.installed {
            lock.unlock(); return hit
        }
        lock.unlock()
        var result = (installed: false, version: nil as String?)
        if let bin = binaryURL() {
            let tmp = NSTemporaryDirectory()
                .appending("th-modprobe-\(UUID().uuidString)")
            let proc = Process()
            proc.executableURL = bin
            proc.arguments = ["-c",
                "import importlib.util, importlib.metadata, pathlib\n"
                + "m='\(module)'\n"
                + "ok = importlib.util.find_spec(m) is not None\n"
                + "v = ''\n"
                + "if ok:\n"
                + "    try: v = importlib.metadata.version(m.replace('_','-'))\n"
                + "    except Exception: pass\n"
                + "pathlib.Path(r'\(tmp)').write_text(('1\\n'+v) if ok else '0\\n')\n"]
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
            do {
                try proc.run()
                proc.waitUntilExit()
                if let report = try? String(contentsOfFile: tmp, encoding: .utf8) {
                    let lines = report.split(separator: "\n", omittingEmptySubsequences: false)
                    let installed = lines.first == "1"
                    let version = lines.count > 1 ? String(lines[1]) : nil
                    result = (installed, installed && !(version ?? "").isEmpty ? version : nil)
                }
            } catch {}
            try? FileManager.default.removeItem(atPath: tmp)
        }
        if result.installed {
            lock.lock()
            cachedModuleCheck[key] = result
            lock.unlock()
        }
        return result
    }

    /// Minimum package versions for serving modules — FlintForCausalLM only
    /// exists in mlx-vlm ≥0.7.10 (mlx-lm support is ml-explore/mlx-lm#1998).
    static let moduleFloor: [String: String] = ["mlx_vlm": "0.7.10"]

    /// Dotted-version comparison ("0.7.10" ≥ "0.7.10"): numeric prefix per
    /// component, missing components count as 0.
    static func versionAtLeast(_ have: String, _ floor: String) -> Bool {
        func parts(_ s: String) -> [Int] {
            s.split(separator: ".").map { Int($0.prefix(while: { $0.isNumber })) ?? 0 }
        }
        let h = parts(have), f = parts(floor)
        for i in 0..<max(h.count, f.count) {
            let a = i < h.count ? h[i] : 0, b = i < f.count ? f[i] : 0
            if a != b { return a > b }
        }
        return true
    }

    var engineAvailable: Bool {
        guard binaryURL() != nil else { return false }
        switch backend.id {
        case "mlx":
            // Either serving module makes the backend usable; which module a
            // given model needs is checked again at spawn.
            return moduleImportable("mlx_lm") || moduleImportable("mlx_vlm")
        default:
            if let module = backend.moduleName { return moduleImportable(module) }
            return true
        }
    }

    /// How to make the backend available, for the UI's hint line.
    var installHint: String? {
        switch backend.id {
        case "splash": return "splash not installed — run: brew install incoai/tap/splash"
        case "thengine": return "th-engine not built — run: cargo build --release -p th-engine (engine/)"
        case "mlx":
            guard binaryURL() != nil else {
                return "python3 not found — MLX needs python3 with mlx-lm/mlx-vlm"
            }
            return "mlx runtime not installed — run: scripts/setup-mlx-runtime.sh"
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
               maxMemoryGB: Int?, maxContextK: Int?, keepLoaded: Bool = false,
               expertCacheGB: Int? = nil, maxNumSeqs: Int? = nil,
               profile: ServeProfile? = nil) {
        lock.lock()
        let busy = activationID != nil || state.isBusy || state.isServing
        let activation = UUID()
        if !busy {
            activationID = activation
            pinnedAtServe = keepLoaded
            lastActivity = Date()
            lastRequestSig = nil
            lastCpuNs = nil
            idleSeconds = 0
        }
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
                            keepLoaded: keepLoaded, expertCacheGB: expertCacheGB,
                            maxNumSeqs: maxNumSeqs, profile: profile,
                            activation: activation)
        }
    }

    /// Stop only a server we spawned; an adopted one belongs to whoever ran it.
    func stop() {
        lock.lock()
        let proc = process
        process = nil
        spawnedModel = nil
        activationID = nil
        lastRequestSig = nil
        lastCpuNs = nil
        idleSeconds = 0
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
        lock.lock()
        let idle = Int(idleSeconds.rounded())
        let pinned = pinnedAtServe
        lock.unlock()
        return [
            "id": backend.id,
            "name": backend.displayName,
            "supervisor": stateObj,
            "engine_binary": binaryURL()?.path ?? NSNull(),
            "port": backend.port,
            "engine": status ?? NSNull(),
            "last_error": lastError ?? NSNull(),
            "idle_seconds": idle,
            "idle_timeout_secs": SettingsStore.shared.engineIdleTimeoutSecs,
            "keep_loaded": pinned,
        ]
    }

    // MARK: Internals

    /// One loopback GET on the backend's port → JSON object; nil on any
    /// failure or non-200.
    private func getJSON(_ path: String) -> [String: Any]? {
        guard let url = URL(string: "http://127.0.0.1:\(backend.port)\(path)") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 0.6)
        req.httpMethod = "GET"
        var obj: [String: Any]?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            defer { sema.signal() }
            guard let data, (resp as? HTTPURLResponse)?.statusCode == 200 else { return }
            obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }.resume()
        _ = sema.wait(timeout: .now() + 1.0)
        return obj
    }

    /// Request counters — /status `requests` (splash, thengine) or mlx-vlm's
    /// /metrics `summary` — reduced to a signature that moves on every start
    /// or settle, plus the in-flight count. Gauges stay out of the signature
    /// (queue age, uptime and in-flight itself would mask or fake events);
    /// nil when no known counter is present.
    static func requestActivity(_ counters: [String: Any]) -> (signature: UInt64, inFlight: Int64)? {
        var signature: UInt64 = 0
        var submitted: Int64 = 0, settled: Int64 = 0, inFlight: Int64 = 0
        var found = false
        for (key, value) in counters {
            guard let n = (value as? NSNumber)?.int64Value else { continue }
            switch key {
            case "submitted", "total", "requests_started":
                submitted = max(submitted, n)
            case "completed", "cancelled", "failed", "requests_completed", "requests_failed":
                settled += n
            case "active", "inflight", "in_flight":
                inFlight += n
                found = true
                continue
            default:
                continue
            }
            signature &+= UInt64(bitPattern: n)
            found = true
        }
        return found ? (signature, max(inFlight, submitted - settled)) : nil
    }

    /// GET the backend's probe path. Returns the payload when its own server
    /// answers and publishes .serving/.stopped accordingly.
    @discardableResult
    private func probeAndUpdate() -> [String: Any]? {
        // The backend's own shape decides: /status names `instance.model`,
        // /v1/models its served entry. Anything else on the port is not ours.
        var payload = getJSON(backend.probePath)
        var servedModel = payload.flatMap { backend.probeModel($0) }
        if servedModel == nil { payload = nil }

        let (spawnedPID, ownModel): (Int?, String?) = {
            lock.lock(); defer { lock.unlock() }
            guard let p = process, p.isRunning else { return (nil, nil) }
            return (Int(p.processIdentifier), spawnedModel)
        }()
        // mlx-lm's /v1/models lists every cached checkpoint without saying
        // which is loaded; for a server we spawned, what we asked for is.
        if servedModel != nil, backend.probePath == "/v1/models", let ownModel {
            servedModel = ownModel
        }

        // Idle-lifecycle bookkeeping. Request counters when the backend has
        // them (splash/thengine /status, mlx-vlm /metrics) — an in-flight
        // request or a moved signature means work; else CPU moved on the
        // served pid (mlx-lm — an idle pooled conn burns ~0 while any decode
        // always does). Probes and keep-alive connections stay under both.
        // Evaluated on this probe queue; `idleSeconds` is read under `lock`
        // by payload().
        let now = Date()
        var busy = false
        if let payload, servedModel != nil {
            var counters = payload["requests"] as? [String: Any]
            if counters == nil, backend.id == "mlx" {
                counters = getJSON("/metrics")?["summary"] as? [String: Any]
            }
            if let activity = counters.flatMap(Self.requestActivity) {
                lock.lock()
                busy = activity.inFlight > 0 || (lastRequestSig.map { $0 != activity.signature } ?? true)
                lastRequestSig = activity.signature
                lock.unlock()
            } else {
                var pid = spawnedPID
                if pid == nil {
                    pid = (payload["instance"] as? [String: Any])?["pid"] as? Int
                }
                if let pid {
                    var t = proc_taskinfo()
                    let n = proc_pidinfo(pid_t(pid), PROC_PIDTASKINFO, 0, &t,
                                         Int32(MemoryLayout<proc_taskinfo>.stride))
                    if n == Int32(MemoryLayout<proc_taskinfo>.stride) {
                        let ns = t.pti_total_user + t.pti_total_system
                        lock.lock()
                        // >20ms CPU in a ~5s window = real work; health probes
                        // and python GC stay far below this.
                        busy = lastCpuNs.map { ns > $0 &+ 20_000_000 } ?? true
                        lastCpuNs = ns
                        lock.unlock()
                    }
                }
            }
            lock.lock()
            // First sighting is the baseline — an adopted server with no
            // signal must not read as idle since distantPast.
            if busy || lastActivity == .distantPast { lastActivity = now }
            let idleFor = now.timeIntervalSince(lastActivity)
            idleSeconds = idleFor
            let owned = process?.isRunning == true
            let pinned = pinnedAtServe
            lock.unlock()
            let timeout = TimeInterval(SettingsStore.shared.engineIdleTimeoutSecs)
            if owned, !pinned, timeout > 0, idleFor >= timeout {
                engineLog.info("Engine supervisor: \(self.backend.id, privacy: .public) idle \(Int(idleFor))s ≥ \(Int(timeout))s — stopping to release model memory")
                self.stop()
                return payload
            }
        } else {
            lock.lock()
            lastActivity = .distantPast
            lastRequestSig = nil
            lastCpuNs = nil
            idleSeconds = 0
            lock.unlock()
        }
        let (published, publishedModel) = (payload, servedModel)
        DispatchQueue.main.async {
            if let payload = published, let model = publishedModel {
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
                            keepLoaded: Bool, expertCacheGB: Int? = nil,
                            maxNumSeqs: Int? = nil, profile: ServeProfile? = nil,
                            activation: UUID) {
        guard let bin = binaryURL() else {
            lock.lock()
            if activationID == activation { activationID = nil }
            lock.unlock()
            publishFail(installHint ?? "\(backend.id) not installed")
            return
        }
        if let module = backend.serverModule(for: model),
           !moduleImportable(module, minVersion: Self.moduleFloor[module]) {
            lock.lock()
            activationID = nil
            lock.unlock()
            publishFail(module == "mlx_vlm"
                ? "flint needs mlx-vlm ≥0.7.10 — run: scripts/setup-mlx-runtime.sh"
                : (installHint ?? "\(module) not installed"))
            return
        }
        let knobs = profile?.knobs(backendId: backend.id)
            ?? (specTokens: nil, kvQuant: nil)
        let args = backend.spawnArgs(model: model, tokenizer: tokenizer,
                                     maxMemoryGB: maxMemoryGB, maxContextK: maxContextK,
                                     keepLoaded: keepLoaded, expertCacheGB: expertCacheGB,
                                     maxNumSeqs: maxNumSeqs,
                                     specTokens: knobs.specTokens, kvQuant: knobs.kvQuant,
                                     idleSecs: SettingsStore.shared.engineIdleTimeoutSecs)

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
                self.spawnedModel = nil
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
        spawnedModel = model
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
        recordBenchMeasurements(obj)
    }

    /// The bench file's latest run as HardwareMap measurements — one per
    /// engine that reported a decode rate. Pure: persistence is the caller's.
    static func benchMeasurements(from payload: [String: Any]) -> [HardwareMap.Measurement] {
        guard let latest = payload["latest"] as? [String: Any],
              let engines = latest["engines"] as? [String: Any] else { return [] }
        let ranAt = (latest["ran_at"] as? String)
            .flatMap { ISO8601DateFormatter().date(from: $0) } ?? Date()
        let catalog = LocalModelCatalog.models()
        var out: [HardwareMap.Measurement] = []
        for (engineID, raw) in engines {
            guard let e = raw as? [String: Any],
                  let model = e["model"] as? String,
                  let decode = (e["decode_tps"] as? NSNumber)?.doubleValue,
                  decode > 0 else { continue }
            // modelSpec carries "repo:file" for GGUF rows, the bare repo
            // otherwise — matching on it covers both spellings.
            let row = catalog.first { $0.modelSpec == model && $0.engine == engineID }
            out.append(HardwareMap.Measurement(
                modelSpec: row?.modelSpec ?? model,
                engine: engineID,
                quant: row?.quant ?? "",
                paramsB: row?.paramsB ?? 0,
                tokPerSec: decode,
                promptTokPerSec: (e["engine_prefill_tps"] as? NSNumber)?.doubleValue,
                measuredAt: ranAt,
                source: "engine-bench"))
        }
        return out
    }

    /// A measured run outranks the bandwidth estimate in recommendations —
    /// the bench harness feeding the hardware profile it belongs to.
    private func recordBenchMeasurements(_ payload: [String: Any]) {
        let fresh = Self.benchMeasurements(from: payload)
        guard !fresh.isEmpty else { return }
        var map = HardwareMap.load()
        var changed = false
        for m in fresh {
            if let prev = map.measured(spec: m.modelSpec, engine: m.engine),
               prev.tokPerSec == m.tokPerSec,
               prev.promptTokPerSec == m.promptTokPerSec { continue }
            map = map.record(m)
            changed = true
        }
        if changed { map.save() }
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
