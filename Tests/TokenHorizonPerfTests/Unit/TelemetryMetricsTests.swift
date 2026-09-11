import XCTest
@testable import TokenHorizon

final class TelemetryMetricsTests: XCTestCase {

    func testPrometheusMetricsExposition() {
        let telemetry = TokenHorizonTelemetry.shared

        let sample = OllamaTelemetrySample(
            model: "qwen2.5-coder:7b",
            completedAt: Date(),
            evalCount: 80,
            evalDurationNs: 2_000_000_000,
            promptEvalCount: 20,
            promptEvalDurationNs: 100_000_000
        )

        telemetry.recordOllama(sample)
        telemetry.recordOllamaRequest(model: "qwen2.5-coder:7b")

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
        telemetry.recordOllamaRequest(model: "qwen2.5-coder:7b")
        let text = telemetry.prometheusText()
        XCTAssertTrue(text.contains("token_horizon_ollama_requests_total"))
    }
}
