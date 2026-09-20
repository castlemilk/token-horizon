import XCTest
@testable import TokenHorizon
@testable import TokenHorizonCore

final class TelemetryMetricsTests: XCTestCase {

    func testPrometheusMetricsExposition() {
        let telemetry = TokenHorizonTelemetry.shared

        let sample = InferenceTelemetrySample(
            model: "qwen2.5-coder:7b",
            completedAt: Date(),
            evalCount: 80,
            evalDurationNs: 2_000_000_000,
            promptEvalCount: 20,
            promptEvalDurationNs: 100_000_000
        )

        telemetry.recordInference(sample, vendor: "ollama")
        telemetry.recordInferenceRequest(model: "qwen2.5-coder:7b", vendor: "ollama")

        let text = telemetry.prometheusText()
        XCTAssertFalse(text.isEmpty)
    }

    func testEngineTickRecordingExposesSeries() {
        let telemetry = TokenHorizonTelemetry.shared
        telemetry.recordEngineTick(op: "snapshot", durationSeconds: 0.042, filesTracked: 893)
        let text = telemetry.prometheusText()
        XCTAssertTrue(text.contains("token_horizon_engine_tick_duration_seconds"))
        XCTAssertTrue(text.contains("token_horizon_engine_files_tracked"))
    }

    func testMLXMetricRecording() {
        let telemetry = TokenHorizonTelemetry.shared
        let proc = MLXProcess(
            pid: 1234,
            ppid: 1,
            name: "mlx-runner",
            command: "--mlx-engine",
            model: "qwen2.5-coder",
            cpu: 75.5,
            memoryMB: 4096.0,
            diskReadMBps: 10.5,
            diskWriteMBps: 2.0,
            startTime: Date(),
            tokPerSec: 45.0
        )
        let snapshot = MLXSnapshot(sampledAt: Date(), processes: [proc])

        telemetry.recordMLX(snapshot)

        let text = telemetry.prometheusText()
        XCTAssertFalse(text.isEmpty)
    }

    func testRequestCounterRecording() {
        let telemetry = TokenHorizonTelemetry.shared
        telemetry.recordInferenceRequest(model: "qwen2.5-coder:7b", vendor: "ollama")
        let text = telemetry.prometheusText()
        XCTAssertTrue(text.contains("token_horizon_inference_requests_total"))
    }
}
