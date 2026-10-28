import XCTest
@testable import TokenHorizon

final class EngineLifecycleTests: XCTestCase {
    func testTHEngineReleasesMemoryByDefault() {
        let args = EngineBackend.thengine.spawnArgs(
            model: "test/model", tokenizer: nil, maxMemoryGB: nil, maxContextK: nil)
        XCTAssertEqual(args, ["serve", "--model", "test/model", "--port", "8001",
                              "--idle-timeout-secs", "60"])
    }

    func testTHEngineIdleTimeoutIsConfigurable() {
        let args = EngineBackend.thengine.spawnArgs(
            model: "test/model", tokenizer: nil, maxMemoryGB: nil, maxContextK: nil,
            idleSecs: 120)
        XCTAssertEqual(args, ["serve", "--model", "test/model", "--port", "8001",
                              "--idle-timeout-secs", "120"])
    }

    func testKeepingModelLoadedRequiresExplicitActivation() {
        let args = EngineBackend.thengine.spawnArgs(
            model: "test/model", tokenizer: "test/tokenizer", maxMemoryGB: nil,
            maxContextK: 8, keepLoaded: true)
        XCTAssertEqual(args, ["serve", "--model", "test/model", "--port", "8001",
                              "--idle-timeout-secs", "0", "--tokenizer", "test/tokenizer",
                              "--max-context", "8192"])
    }

    func testSplashArgumentsAreUnchanged() {
        let args = EngineBackend.splash.spawnArgs(
            model: "test/model", tokenizer: nil, maxMemoryGB: 16, maxContextK: 8,
            keepLoaded: true)
        XCTAssertEqual(args, ["serve", "--model", "test/model", "--max-memory", "16G",
                              "--max-context", "8K"])
    }

    /// MLX is a python module, not a binary: the interpreter is the executable
    /// and the module name leads the args. mlx-lm sizes itself, so the memory
    /// and context ceilings are not forwarded as flags (they would be rejected).
    func testMLXArgumentsRunTheModule() {
        let args = EngineBackend.mlx.spawnArgs(
            model: "mlx-community/Qwen3-8B-4bit", tokenizer: nil,
            maxMemoryGB: 24, maxContextK: 16, keepLoaded: true)
        XCTAssertEqual(args, ["-m", "mlx_lm.server",
                              "--model", "mlx-community/Qwen3-8B-4bit",
                              "--host", "127.0.0.1", "--port", "8002"])
        XCTAssertEqual(EngineBackend.mlx.moduleName, "mlx_lm")
    }

    /// FlintForCausalLM is served by mlx-vlm (>=0.7.10), not upstream mlx-lm —
    /// the backend picks the module from the checkpoint name.
    func testFlintCheckpointsServeUnderMlxVlm() {
        let flint = EngineBackend.mlx.spawnArgs(
            model: "RecursiveSI/flint-int4", tokenizer: nil,
            maxMemoryGB: nil, maxContextK: nil)
        XCTAssertEqual(flint.prefix(2), ["-m", "mlx_vlm.server"])

        let qwen = EngineBackend.mlx.spawnArgs(
            model: "mlx-community/Qwen3-8B-4bit", tokenizer: nil,
            maxMemoryGB: nil, maxContextK: nil)
        XCTAssertEqual(qwen.prefix(2), ["-m", "mlx_lm.server"])

        XCTAssertEqual(EngineBackend.mlx.serverModule(for: "RecursiveSI/flint-int4"), "mlx_vlm")
        XCTAssertEqual(EngineBackend.mlx.serverModule(for: "mlx-community/flint-mixed-3-4bit"), "mlx_vlm")
        XCTAssertEqual(EngineBackend.thengine.serverModule(for: "Qwen/Qwen3-8B-GGUF"), nil)
    }

    /// The managed venv is the first interpreter tried — a bare system python
    /// (Homebrew's is externally-managed) can only ever be a fallback.
    func testMlxPrefersManagedRuntime() {
        let expected = NSString("~/.config/token-horizon/mlx-runtime/bin/python")
            .expandingTildeInPath
        XCTAssertEqual(EngineBackend.mlx.binarySearchPaths.first, expected)
    }

    /// Flint's serving floor is mlx-vlm 0.7.10 — the version comparator must
    /// handle the two-digit component correctly (0.7.9 is below the floor).
    func testModuleVersionFloors() {
        XCTAssertTrue(BackendSupervisor.versionAtLeast("0.7.10", "0.7.10"))
        XCTAssertTrue(BackendSupervisor.versionAtLeast("0.7.10.1", "0.7.10"))
        XCTAssertTrue(BackendSupervisor.versionAtLeast("0.8.0", "0.7.10"))
        XCTAssertTrue(BackendSupervisor.versionAtLeast("1.0", "0.7.10"))
        XCTAssertFalse(BackendSupervisor.versionAtLeast("0.7.9", "0.7.10"))
        XCTAssertFalse(BackendSupervisor.versionAtLeast("0.6", "0.7.10"))
        XCTAssertEqual(BackendSupervisor.moduleFloor["mlx_vlm"], "0.7.10")
        XCTAssertNil(BackendSupervisor.moduleFloor["mlx_lm"])
    }

    /// bench-engines.json feeds the hardware profile: a measured run becomes
    /// a Measurement the catalogue can claim against the served spec.
    func testBenchResultsBecomeMeasurements() throws {
        let payload: [String: Any] = ["latest": [
            "ran_at": "2026-10-24T13:00:00Z",
            "engines": [
                "mlx": ["model": "RecursiveSI/flint-int4", "decode_tps": 123.4,
                        "engine_prefill_tps": 456.0],
                "thengine": ["model": "Qwen/Qwen3-8B-GGUF:Qwen3-8B-Q4_K_M.gguf",
                             "decode_tps": 55.5],
                // No decode rate → nothing to record.
                "splash": ["model": "incoai/Qwen3.8-27B-Splash"],
            ]]]
        let ms = EngineManager.benchMeasurements(from: payload)
        XCTAssertEqual(ms.count, 2)
        let flint = try XCTUnwrap(ms.first { $0.engine == "mlx" })
        XCTAssertEqual(flint.modelSpec, "RecursiveSI/flint-int4")
        XCTAssertEqual(flint.quant, "MLX INT4")
        XCTAssertEqual(flint.paramsB, 39.8)
        XCTAssertEqual(flint.tokPerSec, 123.4)
        XCTAssertEqual(flint.promptTokPerSec, 456.0)
        XCTAssertEqual(flint.source, "engine-bench")
        let th = try XCTUnwrap(ms.first { $0.engine == "thengine" })
        XCTAssertEqual(th.modelSpec, "Qwen/Qwen3-8B-GGUF:Qwen3-8B-Q4_K_M.gguf")
        XCTAssertEqual(th.quant, "Q4_K_M", "a repo:file spec must still find its catalog row")
        XCTAssertNil(th.promptTokPerSec)
    }

    /// Each backend proves itself at its own endpoint: /status names
    /// `instance.model`, mlx-lm's /v1/models names `data[0].id`.
    func testProbeReadsEachBackendShape() {
        XCTAssertEqual(EngineBackend.thengine.probePath, "/status")
        XCTAssertEqual(EngineBackend.splash.probePath, "/status")
        XCTAssertEqual(EngineBackend.mlx.probePath, "/v1/models")

        let status: [String: Any] = ["instance": ["model": "incoai/Qwen3.8-27B-Splash", "pid": 42]]
        XCTAssertEqual(EngineBackend.splash.probeModel(status), "incoai/Qwen3.8-27B-Splash")

        let models: [String: Any] = ["object": "list",
                                     "data": [["id": "mlx-community/Qwen3-8B-4bit"]]]
        XCTAssertEqual(EngineBackend.mlx.probeModel(models), "mlx-community/Qwen3-8B-4bit")

        // A foreign server on the port must not be adopted as ours.
        XCTAssertNil(EngineBackend.mlx.probeModel(["metrics": [:]]))
        XCTAssertNil(EngineBackend.splash.probeModel(["data": [["id": "x"]]]))
    }

    /// mlx-vlm's /v1/models lists the whole HF cache sorted by id; the served
    /// model is the `loaded` entry, never simply the first one.
    func testMlxVlmProbeReadsTheLoadedEntry() {
        let listing: [String: Any] = ["object": "list", "data": [
            ["id": "Qwen/Qwen2.5-Coder-14B-Instruct", "loaded": false],
            ["id": "RecursiveSI/flint-int4", "loaded": true],
        ]]
        XCTAssertEqual(EngineBackend.mlx.probeModel(listing), "RecursiveSI/flint-int4")
        let nothingLoaded: [String: Any] = ["data": [["id": "a/b", "loaded": false]]]
        XCTAssertNil(EngineBackend.mlx.probeModel(nothingLoaded),
                     "an mlx-vlm server with nothing in memory is not serving")
    }

    /// Idle detection reads request counters in every shape the backends
    /// publish; gauges (uptime, queue age, in-flight) never move the
    /// signature, so a quiet server can idle out.
    func testRequestActivityAcrossCounterShapes() throws {
        let splash = try XCTUnwrap(BackendSupervisor.requestActivity(
            ["submitted": 5, "completed": 4, "cancelled": 0, "failed": 0]))
        XCTAssertEqual(splash.inFlight, 1)

        let thengine = try XCTUnwrap(BackendSupervisor.requestActivity(
            ["total": 3, "active": 0, "completed": 3, "cancelled": 0, "failed": 0, "queue_age_ms": 12]))
        XCTAssertEqual(thengine.inFlight, 0)
        let later = try XCTUnwrap(BackendSupervisor.requestActivity(
            ["total": 3, "active": 0, "completed": 3, "cancelled": 0, "failed": 0, "queue_age_ms": 9000]))
        XCTAssertEqual(thengine.signature, later.signature, "a gauge must not look like traffic")

        let running: [String: Any] = ["requests_started": 2, "requests_completed": 1,
                                      "requests_failed": 0, "in_flight": 1, "uptime_s": 99.5]
        let mlxVlm = try XCTUnwrap(BackendSupervisor.requestActivity(running))
        XCTAssertEqual(mlxVlm.inFlight, 1)
        let settled = try XCTUnwrap(BackendSupervisor.requestActivity(
            ["requests_started": 2, "requests_completed": 2, "requests_failed": 0,
             "in_flight": 0, "uptime_s": 104.5]))
        XCTAssertEqual(settled.inFlight, 0)
        XCTAssertNotEqual(settled.signature, mlxVlm.signature, "a settled request is activity")

        XCTAssertNil(BackendSupervisor.requestActivity(["uptime_s": 1.0]))
    }

    /// memgov: the serve payload's memory ceiling reaches th-engine as an
    /// explicit admission budget (--max-mem-gb); splash keeps --max-memory.
    func testTHEngineReceivesMemoryBudget() {
        let args = EngineBackend.thengine.spawnArgs(
            model: "test/model", tokenizer: nil, maxMemoryGB: 48, maxContextK: nil)
        XCTAssertTrue(args.contains("--max-mem-gb"))
        XCTAssertTrue(args.contains("48"))
        // Absent ceiling → no flag (the engine derives from the device).
        let bare = EngineBackend.thengine.spawnArgs(
            model: "test/model", tokenizer: nil, maxMemoryGB: nil, maxContextK: nil)
        XCTAssertFalse(bare.contains("--max-mem-gb"))
    }

    /// mlx-vlm-only knobs reach the command line only when the model serves
    /// under mlx_vlm (Flint) — mlx-lm rejects `--expert-cache-gb` and
    /// `--max-num-seqs`, and a Qwen serve must not die on them.
    func testMlxExpertCacheGatesOnTheServerModule() {
        let flint = EngineBackend.mlx.spawnArgs(
            model: "RecursiveSI/flint-int4", tokenizer: nil,
            maxMemoryGB: nil, maxContextK: nil, keepLoaded: false,
            expertCacheGB: 12, maxNumSeqs: 4)
        XCTAssertTrue(flint.contains("--expert-cache-gb"))
        XCTAssertEqual(flint[flint.firstIndex(of: "--expert-cache-gb")! + 1], "12")
        XCTAssertTrue(flint.contains("--max-num-seqs"))
        XCTAssertEqual(flint[flint.firstIndex(of: "--max-num-seqs")! + 1], "4")

        let qwen = EngineBackend.mlx.spawnArgs(
            model: "mlx-community/Qwen3-8B-4bit", tokenizer: nil,
            maxMemoryGB: nil, maxContextK: nil, keepLoaded: false,
            expertCacheGB: 12, maxNumSeqs: 4)
        XCTAssertFalse(qwen.contains("--expert-cache-gb"), "mlx_lm.server rejects the flag")
        XCTAssertFalse(qwen.contains("--max-num-seqs"))

        // Absent/zero knobs change nothing on either module.
        let bareFlint = EngineBackend.mlx.spawnArgs(
            model: "RecursiveSI/flint-int4", tokenizer: nil,
            maxMemoryGB: nil, maxContextK: nil, keepLoaded: false,
            expertCacheGB: 0, maxNumSeqs: nil)
        XCTAssertFalse(bareFlint.contains("--expert-cache-gb"))
    }

    /// Serve profiles: parse validation, per-backend expansion, and the
    /// flags they become on thengine's command line.
    func testServeProfiles() {
        XCTAssertEqual(try? ServeProfile.parse(nil).get(), nil)
        XCTAssertEqual(try? ServeProfile.parse("").get(), nil)
        XCTAssertEqual(try? ServeProfile.parse("reproduction").get(), .reproduction)
        XCTAssertThrowsError(try ServeProfile.parse("bogus").get())

        // thengine expands; mlx/splash ignore (they size themselves or
        // have no matching flags).
        XCTAssertEqual(ServeProfile.reproduction.knobs(backendId: "thengine").specTokens, 7)
        XCTAssertEqual(ServeProfile.longContext.knobs(backendId: "thengine").kvQuant, true)
        XCTAssertEqual(ServeProfile.chat.knobs(backendId: "thengine").specTokens, nil)
        XCTAssertEqual(ServeProfile.reproduction.knobs(backendId: "mlx").specTokens, nil)

        let args = EngineBackend.thengine.spawnArgs(
            model: "test/model", tokenizer: nil, maxMemoryGB: nil, maxContextK: nil,
            keepLoaded: false, specTokens: 7, kvQuant: true)
        XCTAssertTrue(args.contains("--spec-tokens"))
        XCTAssertEqual(args[args.firstIndex(of: "--spec-tokens")! + 1], "7")
        XCTAssertTrue(args.contains("--kv-quant"))

        let bare = EngineBackend.thengine.spawnArgs(
            model: "test/model", tokenizer: nil, maxMemoryGB: nil, maxContextK: nil)
        XCTAssertFalse(bare.contains("--spec-tokens"))
        XCTAssertFalse(bare.contains("--kv-quant"))
    }

    func testSupervisorStartsStoppedWithoutLaunchingModel() {
        let supervisor = BackendSupervisor(backend: .thengine)
        XCTAssertEqual(supervisor.state, .stopped)
        XCTAssertNil(supervisor.status)
    }
}
