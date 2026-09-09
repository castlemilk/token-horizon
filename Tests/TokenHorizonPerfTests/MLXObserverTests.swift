import XCTest
import TokenHorizonCore
@testable import TokenHorizon
import OpenTelemetryApi
import OpenTelemetrySdk
import PrometheusExporter

final class MLXObserverTests: XCTestCase {
    func testCommandMatchingRecognizesOllamaMLXRunnerAndMLXLM() {
        XCTAssertTrue(MLXObserver.isMLXCommand("ollama runner --mlx-engine --model qwen3.8:27b-mlx"))
        XCTAssertTrue(MLXObserver.isMLXCommand("python -m mlx_lm.server --model qwen"))
        XCTAssertFalse(MLXObserver.isMLXCommand("ollama serve"))
    }

    func testModelNameParsesSeparatedAndEqualsForms() {
        XCTAssertEqual(MLXObserver.modelName(in: "ollama runner --mlx-engine --model qwen3.8:27b-mlx"), "qwen3.8:27b-mlx")
        XCTAssertEqual(MLXObserver.modelName(in: "mlx_lm.server --model=qwen3.8:27b-mlx"), "qwen3.8:27b-mlx")
        XCTAssertNil(MLXObserver.modelName(in: "ollama runner --mlx-engine"))
    }

    func testSnapshotIncludesMLXChildrenAndSortsByCPU() {
        let now = Date()
        let runner = sample(pid: 100, ppid: 1, command: "ollama runner --mlx-engine --model qwen3.8:27b-mlx", cpu: 12)
        let worker = sample(pid: 101, ppid: 100, command: "ollama_llama_server", cpu: 80)
        let grandchild = sample(pid: 103, ppid: 101, command: "mlx-worker", cpu: 3)
        let unrelated = sample(pid: 102, ppid: 1, command: "ollama serve", cpu: 99)

        let snapshot = MLXObserver.snapshot(from: [runner, worker, grandchild, unrelated], now: now)

        XCTAssertEqual(snapshot.processes.map(\ .pid), [101, 100, 103])
        XCTAssertEqual(snapshot.processes.first?.model, "qwen3.8:27b-mlx")
        XCTAssertEqual(snapshot.processes.last?.model, "qwen3.8:27b-mlx")
        XCTAssertEqual(snapshot.cpuPercent, 95)
        XCTAssertEqual(snapshot.sampledAt, now)
    }

    func testUIModelMLXHistoryIsBounded() {
        let model = UIModel()
        let process = MLXProcess(pid: 100, ppid: 1, name: "runner", command: "--mlx-engine --model qwen", model: "qwen", cpu: 1, memoryMB: 2, diskReadMBps: 3, diskWriteMBps: 4, startTime: Date(), tokPerSec: 5)

        for index in 0..<5_000 {
            model.recordMLX(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: Double(index)), processes: [process]))
        }

        XCTAssertEqual(model.mlxCPUHistory.count, UIModel.fineLimit)
        XCTAssertEqual(model.mlxMemoryHistory.count, UIModel.fineLimit)
        XCTAssertEqual(model.mlxDiskHistory.count, UIModel.fineLimit)
        XCTAssertEqual(model.mlxTokHistory.count, UIModel.fineLimit)
    }

    func testMLXHistoryRollsUpOnlineIntoThirtySecondBuckets() {
        var history = MLXHistory()
        let process = MLXProcess(pid: 100, ppid: 1, name: "runner", command: "runner", model: "qwen", cpu: 10, memoryMB: 20, diskReadMBps: 1, diskWriteMBps: 2, startTime: Date(), tokPerSec: 30)

        for second in 0...60 {
            history.append(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: Double(second)), processes: [process]))
        }

        XCTAssertEqual(history.fine.count, 61)
        XCTAssertEqual(history.coarse.count, 2)
        XCTAssertEqual(history.coarse[0].cpuPercent, 10, accuracy: 0.0001)
        XCTAssertEqual(history.coarse[0].tokPerSec ?? 0, 30, accuracy: 0.0001)
    }

    func testTelemetryExportsPrometheusMetrics() {
        TokenHorizonTelemetry.shared.recordMLX(MLXSnapshot(sampledAt: Date()))
        TokenHorizonTelemetry.shared.recordOllamaRequest(model: "qwen-test")
        let text = TokenHorizonTelemetry.shared.prometheusText()

        XCTAssertTrue(text.contains("token_horizon_mlx_active_runners"))
        XCTAssertTrue(text.contains("token_horizon_ollama_requests_total"))
        XCTAssertTrue(text.contains("model=\"qwen-test\""))
    }

    func testDirectOpenTelemetryPrometheusExport() {
        let exporter = PrometheusExporter(options: PrometheusExporterOptions(url: "http://127.0.0.1:1/metrics"))
        let provider = MeterProviderSdk.builder()
            .registerView(selector: InstrumentSelectorBuilder().build(), view: View.builder().build())
            .registerMetricReader(reader: PeriodicMetricReaderBuilder(exporter: exporter).setInterval(timeInterval: 0.1).build())
            .build()
        let meter = provider.get(name: "test")
        let gauge = meter.gaugeBuilder(name: "test_gauge").build()
        gauge.record(value: 1)
        Thread.sleep(forTimeInterval: 0.3)

        XCTAssertTrue(PrometheusExporterExtensions.writeMetricsCollection(exporter: exporter).contains("test_gauge"))
        _ = provider.shutdown()
    }

    func testOllamaProxyParsesFinalStreamingMetadata() {
        let response = """
        {"response":"hello","done":false}
        {"response":"","done":true,"eval_count":120,"eval_duration":4000000000,"prompt_eval_count":30,"prompt_eval_duration":500000000}
        """

        let sample = OllamaTelemetryProxy.parseTelemetry(
            model: "qwen3.8:27b-mlx",
            responseBody: Data(response.utf8),
            completedAt: Date(timeIntervalSince1970: 123)
        )

        XCTAssertEqual(sample?.model, "qwen3.8:27b-mlx")
        XCTAssertEqual(sample?.evalCount, 120)
        XCTAssertEqual(sample?.tokPerSec ?? 0, 30, accuracy: 0.0001)
        XCTAssertEqual(sample?.promptTokPerSec ?? 0, 60, accuracy: 0.0001)
        XCTAssertEqual(sample?.completedAt, Date(timeIntervalSince1970: 123))
    }

    func testOllamaProxyParsesChunkedHTTPResponse() {
        let json = "{\"done\":true,\"eval_count\":50,\"eval_duration\":2000000000}\n"
        let chunk = String(format: "%x", json.utf8.count)
        let response = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\(chunk)\r\n\(json)\r\n0\r\n\r\n"

        let sample = OllamaTelemetryProxy.parseTelemetry(
            model: "qwen3.8:27b-mlx",
            responseBody: Data(response.utf8)
        )

        XCTAssertEqual(sample?.evalCount, 50)
        XCTAssertEqual(sample?.tokPerSec ?? 0, 25, accuracy: 0.0001)
    }

    func testOllamaProxyIgnoresIncompleteResponseMetadata() {
        let response = "{\"done\":true,\"eval_count\":50}\n"

        XCTAssertNil(OllamaTelemetryProxy.parseTelemetry(model: "qwen", responseBody: Data(response.utf8)))
    }

    private func sample(pid: Int32, ppid: Int32, command: String, cpu: Double) -> ProcSample {
        ProcSample(pid: pid, ppid: ppid, name: command, command: command, user: "test", threads: 1,
                   cpu: cpu, memMB: 10, diskReadMBps: 1, diskWriteMBps: 2,
                   netInKBps: 0, netOutKBps: 0, startTime: Date())
    }
}
