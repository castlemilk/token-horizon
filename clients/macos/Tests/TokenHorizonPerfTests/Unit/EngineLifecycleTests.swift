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

    func testSupervisorStartsStoppedWithoutLaunchingModel() {
        let supervisor = BackendSupervisor(backend: .thengine)
        XCTAssertEqual(supervisor.state, .stopped)
        XCTAssertNil(supervisor.status)
    }
}
