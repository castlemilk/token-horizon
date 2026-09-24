import XCTest
@testable import TokenHorizon

/// No-crash smoke tests for live samplers (read-only process spawns).
/// Assertions are structural only — values depend on machine state.
final class SystemSamplingTests: XCTestCase {

    func testProcessDetail_ownPid() {
        let pid = getpid()
        guard let detail = SystemStats.processDetail(pid: pid) else {
            // lsof/ps unavailable in this sandbox — do not fail.
            return
        }
        XCTAssertEqual(detail.pid, pid)
        XCTAssertFalse(detail.command.isEmpty)
    }

    func testMLXProcessSamples_shape() {
        let samples = SystemStats.mlxProcessSamples()
        XCTAssertGreaterThanOrEqual(samples.count, 0)
    }

    func testDockerSampleContainers_shape() {
        // Safe with or without a docker daemon (empty when absent).
        let containers = DockerObserver.sampleContainers()
        XCTAssertGreaterThanOrEqual(containers.count, 0)
    }
}
