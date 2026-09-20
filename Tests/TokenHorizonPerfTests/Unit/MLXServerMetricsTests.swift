import XCTest
@testable import TokenHorizon
@testable import TokenHorizonCore

/// Tests for runner-reported `/metrics` parsing and prefill capture in the
/// MLX observer/history. Hermetic: no live runner is contacted.
final class MLXServerMetricsTests: XCTestCase {

    func testParserReadsLatestRequestTimings() throws {
        let json = """
        {"latest":{"timestamp_unix":1789539300.03,"endpoint":"/chat/completions","model":"./qwen","prompt_tokens":51965,
        "completion_tokens":170,"prefill_tok_s":549.83,"decode_tok_s":12.46,"ttft_s":94.96},"recent":[],"summary":{"requests_completed":51}}
        """
        let metrics = try XCTUnwrap(MLXServerMetrics.parse(Data(json.utf8), measuredAt: Date(timeIntervalSince1970: 0)))

        XCTAssertEqual(metrics.prefillTokPerSec ?? 0, 549.83, accuracy: 0.0001)
        XCTAssertEqual(metrics.decodeTokPerSec ?? 0, 12.46, accuracy: 0.0001)
        XCTAssertEqual(metrics.ttftSeconds ?? 0, 94.96, accuracy: 0.0001)
        XCTAssertEqual(metrics.promptTokens, 51965)
        XCTAssertEqual(metrics.completionTokens, 170)
        XCTAssertEqual(metrics.measuredAt.timeIntervalSince1970, 1789539300.03, accuracy: 0.01)
    }

    func testParserReturnsNilWithoutCompletedRequests() {
        XCTAssertNil(MLXServerMetrics.parse(Data(#"{"latest":null,"summary":{}}"#.utf8)))
        XCTAssertNil(MLXServerMetrics.parse(Data(#"{"summary":{}}"#.utf8)))
        XCTAssertNil(MLXServerMetrics.parse(Data("not json".utf8)))
    }

    func testEndpointParsesHostPortAndDefaults() {
        XCTAssertEqual(
            MLXServerEndpoint.metricsURL(in: "python -m mlx_vlm server --model x --host 127.0.0.1 --port 8137")?.absoluteString,
            "http://127.0.0.1:8137/metrics"
        )
        XCTAssertEqual(
            MLXServerEndpoint.metricsURL(in: "python -m mlx_vlm server --port=9000")?.absoluteString,
            "http://127.0.0.1:9000/metrics"
        )
        XCTAssertEqual(
            MLXServerEndpoint.metricsURL(in: "mlx_lm.server --model qwen")?.absoluteString,
            "http://127.0.0.1:8080/metrics"
        )
        XCTAssertEqual(
            MLXServerEndpoint.metricsURL(in: "python -m mlx_vlm server --host 0.0.0.0 --port 8080")?.absoluteString,
            "http://127.0.0.1:8080/metrics"
        )
        XCTAssertNil(MLXServerEndpoint.metricsURL(in: "ollama runner --mlx-engine --port 11434"))
        XCTAssertNil(MLXServerEndpoint.metricsURL(in: "ollama serve"))
    }

    func testCommandMatchingRecognizesMLXVLM() {
        XCTAssertTrue(MLXObserver.isMLXCommand("python -m mlx_vlm server --model ./qwen/4-bit --port 8137"))
        XCTAssertTrue(MLXObserver.isMLXCommand("mlx-vlm serve --model qwen"))
    }

    func testSnapshotCapturesRunnerPrefillAndDecode() {
        let port = 18937
        let command = "python -m mlx_vlm server --model ./Qwen3.8-27B-Uncensored-MLX/4-bit --host 127.0.0.1 --port \(port)"
        let url = URL(string: "http://127.0.0.1:\(port)/metrics")!
        MLXServerMetricsStore.shared.record(
            MLXServerMetrics(prefillTokPerSec: 550, decodeTokPerSec: 12.5, ttftSeconds: 95,
                             promptTokens: 100, completionTokens: 10, measuredAt: Date()),
            for: url
        )
        defer { MLXServerMetricsStore.shared.reset() }

        let snapshot = MLXObserver.snapshot(from: [sample(pid: 200, ppid: 1, command: command, cpu: 50)])

        XCTAssertEqual(snapshot.processes.count, 1)
        XCTAssertEqual(snapshot.processes.first?.prefillTokPerSec ?? 0, 550, accuracy: 0.0001)
        XCTAssertEqual(snapshot.processes.first?.tokPerSec ?? 0, 12.5, accuracy: 0.0001)
        XCTAssertEqual(snapshot.processes.first?.ttftSeconds ?? 0, 95, accuracy: 0.0001)
        XCTAssertEqual(snapshot.measuredPrefillTokPerSec ?? 0, 550, accuracy: 0.0001)
    }

    func testSnapshotPrefersTelemetryProxyOverRunnerMetrics() {
        let port = 18938
        let command = "python -m mlx_vlm server --model \(model) --host 127.0.0.1 --port \(port)"
        let url = URL(string: "http://127.0.0.1:\(port)/metrics")!
        MLXServerMetricsStore.shared.record(
            MLXServerMetrics(prefillTokPerSec: 400, decodeTokPerSec: 10, ttftSeconds: nil,
                             promptTokens: nil, completionTokens: nil, measuredAt: Date()),
            for: url
        )
        InferenceTelemetryStore.shared.record(
            InferenceTelemetrySample(model: model, completedAt: Date(timeIntervalSince1970: 1),
                                  evalCount: 100, evalDurationNs: 1_000_000_000,
                                  promptEvalCount: 30, promptEvalDurationNs: 100_000_000)
        )
        defer { MLXServerMetricsStore.shared.reset() }

        let snapshot = MLXObserver.snapshot(from: [sample(pid: 201, ppid: 1, command: command, cpu: 10)])

        XCTAssertEqual(snapshot.processes.first?.tokPerSec ?? 0, 100, accuracy: 0.0001)
        XCTAssertEqual(snapshot.processes.first?.prefillTokPerSec ?? 0, 400, accuracy: 0.0001)
    }

    func testHistoryTracksPrefillSeriesAndRollups() {
        var history = MLXHistory()
        let process = MLXProcess(pid: 1, ppid: 0, name: "server", command: "python -m mlx_vlm server",
                                 model: "qwen", cpu: 10, memoryMB: 20, diskReadMBps: 1, diskWriteMBps: 2,
                                 startTime: Date(), tokPerSec: 12, prefillTokPerSec: 550, ttftSeconds: 0.5)

        for second in 0..<3 {
            history.append(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: Double(second)), processes: [process]))
        }
        history.append(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: 31), processes: []))

        XCTAssertEqual(history.prefillSeries(), [550, 550, 550, 0])
        XCTAssertEqual(history.maxPrefill(), 550)
        XCTAssertEqual(history.avgPrefill(), 550)
        XCTAssertEqual(history.measuredPrefillSeries(coarse: true), [550])
    }

    func testUIModelPeakPrefill() {
        let model = UIModel()
        let process = MLXProcess(pid: 1, ppid: 0, name: "server", command: "python -m mlx_vlm server",
                                 model: "qwen", cpu: 10, memoryMB: 20, diskReadMBps: 1, diskWriteMBps: 2,
                                 startTime: Date(), tokPerSec: 12, prefillTokPerSec: 480, ttftSeconds: nil)

        model.recordMLX(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: 0), processes: [process]))
        model.recordMLX(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: 2), processes: []))

        XCTAssertEqual(model.mlxPeakPrefill(.m5), 480)
        XCTAssertEqual(model.mlxPeakPrefill(.h24), 0)
    }

    private let model = "qwen-test-\(UUID().uuidString)"

    private func sample(pid: Int32, ppid: Int32, command: String, cpu: Double) -> ProcSample {
        ProcSample(pid: pid, ppid: ppid, name: command, command: command, user: "test", threads: 1,
                   cpu: cpu, memMB: 10, diskReadMBps: 1, diskWriteMBps: 2,
                   netInKBps: 0, netOutKBps: 0, startTime: Date())
    }
}
