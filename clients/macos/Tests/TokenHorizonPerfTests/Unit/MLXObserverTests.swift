import XCTest
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
        XCTAssertEqual(MLXObserver.modelName(in: "mlx_lm.server --model '/tmp/model with spaces'"), "/tmp/model with spaces")
        // Explicit --model beats `python -m <module>`.
        XCTAssertEqual(MLXObserver.modelName(in: "python -m mlx_vlm server --model qwen"), "qwen")
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

    func testMLXHistoryTracksIdleAndBurstUsageOverTime() {
        var history = MLXHistory()
        let active = MLXProcess(pid: 100, ppid: 1, name: "runner", command: "runner", model: "qwen", cpu: 85, memoryMB: 16384, diskReadMBps: 120, diskWriteMBps: 10, startTime: Date(), tokPerSec: 42.5)

        // 10 idle seconds
        for second in 0..<10 {
            history.append(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: Double(second)), processes: []))
        }
        // 5 active seconds
        for second in 10..<15 {
            history.append(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: Double(second)), processes: [active]))
        }
        // 5 idle seconds
        for second in 15..<20 {
            history.append(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: Double(second)), processes: []))
        }

        XCTAssertEqual(history.fine.count, 20)
        XCTAssertEqual(history.cpuSeries().count, 20)
        XCTAssertEqual(history.memorySeries().count, 20)
        XCTAssertEqual(history.diskSeries().count, 20)
        XCTAssertEqual(history.tokSeries().count, 20)

        // Idle points should be 0.0, burst points should be 42.5
        XCTAssertEqual(history.tokSeries()[0], 0.0)
        XCTAssertEqual(history.tokSeries()[9], 0.0)
        XCTAssertEqual(history.tokSeries()[10], 42.5)
        XCTAssertEqual(history.tokSeries()[14], 42.5)
        XCTAssertEqual(history.tokSeries()[15], 0.0)

        XCTAssertEqual(history.maxCPU(), 85.0)
        XCTAssertEqual(history.maxMemory(), 16384.0)
        XCTAssertEqual(history.maxDisk(), 130.0)
        XCTAssertEqual(history.maxTok(), 42.5)
        XCTAssertEqual(history.avgTok(), 42.5)
    }

    func testUIModelMLXWindowStats() {
        let model = UIModel()
        let active = MLXProcess(pid: 100, ppid: 1, name: "runner", command: "runner", model: "qwen", cpu: 50, memoryMB: 8192, diskReadMBps: 20, diskWriteMBps: 5, startTime: Date(), tokPerSec: 35.0)

        model.recordMLX(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: 0), processes: []))
        model.recordMLX(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: 2), processes: [active]))
        model.recordMLX(MLXSnapshot(sampledAt: Date(timeIntervalSince1970: 4), processes: []))

        XCTAssertEqual(model.mlxPeakCPU(.m5), 50.0)
        XCTAssertEqual(model.mlxPeakMemory(.m5), 8192.0)
        XCTAssertEqual(model.mlxPeakDisk(.m5), 25.0)
        XCTAssertEqual(model.mlxPeakTok(.m5), 35.0)
        XCTAssertEqual(model.mlxAvgTok(.m5), 35.0)
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

    func testSnapshotUsesWeightedRecentTelemetryRate() {
        let model = "qwen-test-\(UUID().uuidString)"
        let store = OllamaTelemetryStore.shared
        store.record(OllamaTelemetrySample(model: model, completedAt: Date(timeIntervalSince1970: 1), evalCount: 70, evalDurationNs: 1_000_000_000, promptEvalCount: nil, promptEvalDurationNs: nil))
        store.record(OllamaTelemetrySample(model: model, completedAt: Date(timeIntervalSince1970: 2), evalCount: 1, evalDurationNs: 100_000_000, promptEvalCount: nil, promptEvalDurationNs: nil))

        let snapshot = MLXObserver.snapshot(from: [
            sample(pid: 100, ppid: 1, command: "ollama runner --mlx-engine --model \(model)", cpu: 1)
        ])

        XCTAssertEqual(snapshot.processes.first?.tokPerSec ?? 0, 71 / 1.1, accuracy: 0.0001)
    }

    func testMLXModelInspectorReadsConfigurationAndTotalSize() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("token-horizon-mlx-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let config: [String: Any] = [
            "architectures": ["LlamaForCausalLM"],
            "hidden_size": 4096,
            "quantization_config": ["bits": 4, "group_size": 64]
        ]
        let configData = try JSONSerialization.data(withJSONObject: config)
        try configData.write(to: directory.appendingPathComponent("config.json"))
        try Data(repeating: 0, count: 1234).write(to: directory.appendingPathComponent("model.safetensors"))

        let metadata = try XCTUnwrap(MLXModelInspector.metadata(for: directory.path))
        guard case .object(let overview) = metadata.sections["overview"] else {
            return XCTFail("missing MLX overview")
        }

        XCTAssertEqual(overview["size_bytes"], .number(String(configData.count + 1234)))
        XCTAssertEqual(overview["format"], .string("safetensors"))
        XCTAssertEqual(overview["quantization"], .string("bits=4"))
        XCTAssertNotNil(metadata.sections["config / config.json"])
    }

    func testOllamaMetadataKeepsInstalledAndShowTrees() {
        let installed = OllamaModel(
            name: "qwen3:8b-q4_K_M",
            size: 4_294_967_296,
            modifiedAt: "2026-08-30T00:00:00Z",
            capabilities: ["completion"],
            details: ["quantization_level": "Q4_K_M"],
            tokPerSec: nil,
            promptTokPerSec: nil,
            rawMetadata: .object([
                "name": .string("qwen3:8b-q4_K_M"),
                "size": .number("4294967296")
            ])
        )
        let metadata = OllamaClient.makeModelMetadata(
            name: installed.name,
            installed: installed,
            card: .object([
                "details": .object(["quantization_level": .string("Q4_K_M")]),
                "model_info": .object(["general.architecture": .string("llama")])
            ]),
            running: .object([
                "name": .string("qwen3:8b-q4_K_M"),
                "size_vram": .number("2147483648")
            ])
        )

        XCTAssertNil(metadata.error)
        XCTAssertNotNil(metadata.sections["installed /api/tags"])
        XCTAssertNotNil(metadata.sections["configuration /api/show"])
        XCTAssertNotNil(metadata.sections["loaded /api/ps"])
        XCTAssertEqual(metadata.model, installed.name)
    }

    func testLocalModelRowRetainsExactOllamaTagAfterCanonicalization() {
        let catalogEntry = ModelCatalog.Entry(
            id: "qwen3-8b-q4-k-m",
            name: "Qwen 3 8B",
            provider: "alibaba",
            providerName: "Alibaba Cloud",
            inputPerM: 0,
            outputPerM: 0,
            contextK: 32,
            openWeights: true
        )
        let result = ModelsPipeline.compute(
            search: "",
            scope: .local,
            sortColumn: .model,
            sortAscending: true,
            catalog: [catalogEntry],
            syntheticModels: [ModelUsage(
                provider: "ollama",
                model: "qwen3:8b-q4_K_M",
                tokensAll: 0,
                tokensToday: 0,
                cost: 0,
                messages: 0,
                free: true,
                isLocal: true,
                localModelName: "qwen3:8b-q4_K_M"
            )],
            usageModels: []
        )

        XCTAssertEqual(result.filtered.count, 1)
        XCTAssertEqual(result.filtered.first?.localModelName, "qwen3:8b-q4_K_M")
        XCTAssertTrue(result.filtered.first?.isLocal == true)
        XCTAssertEqual(result.filtered.first?.providerDisplay, "Ollama (Local)")
    }

    private func sample(pid: Int32, ppid: Int32, command: String, cpu: Double) -> ProcSample {
        ProcSample(pid: pid, ppid: ppid, name: command, command: command, user: "test", threads: 1,
                   cpu: cpu, memMB: 10, diskReadMBps: 1, diskWriteMBps: 2,
                   netInKBps: 0, netOutKBps: 0, startTime: Date())
    }
}
