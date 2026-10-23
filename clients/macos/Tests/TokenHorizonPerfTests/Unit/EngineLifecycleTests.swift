import XCTest
@testable import TokenHorizon

final class EngineLifecycleTests: XCTestCase {
    func testTHEngineReleasesMemoryByDefault() {
        let args = EngineBackend.thengine.spawnArgs(
            model: "test/model", tokenizer: nil, maxMemoryGB: nil, maxContextK: nil)
        XCTAssertEqual(args, ["serve", "--model", "test/model", "--port", "8001",
                              "--idle-timeout-secs", "300"])
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

    func testSupervisorStartsStoppedWithoutLaunchingModel() {
        let supervisor = BackendSupervisor(backend: .thengine)
        XCTAssertEqual(supervisor.state, .stopped)
        XCTAssertNil(supervisor.status)
    }
}
