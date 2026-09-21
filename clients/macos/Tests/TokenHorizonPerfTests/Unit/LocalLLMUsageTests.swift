import XCTest
@testable import TokenHorizon

final class LocalLLMUsageTests: XCTestCase {
    override func setUp() {
        super.setUp()
        OllamaTelemetryStore.shared.resetForTesting()
    }

    override func tearDown() {
        OllamaTelemetryStore.shared.resetForTesting()
        super.tearDown()
    }

    func testOllamaTelemetryStoreTracksTokensAndMessages() {
        let now = Date()
        let sample1 = OllamaTelemetrySample(
            model: "qwen2.5-coder:7b",
            completedAt: now,
            evalCount: 120,
            evalDurationNs: 2_000_000_000,
            promptEvalCount: 45,
            promptEvalDurationNs: 500_000_000
        )
        let sample2 = OllamaTelemetrySample(
            model: "qwen2.5-coder:7b",
            completedAt: now.addingTimeInterval(10),
            evalCount: 80,
            evalDurationNs: 1_500_000_000,
            promptEvalCount: 25,
            promptEvalDurationNs: 400_000_000
        )

        OllamaTelemetryStore.shared.record(sample1)
        OllamaTelemetryStore.shared.record(sample2)

        let usage = OllamaTelemetryStore.shared.usage(for: "qwen2.5-coder:7b")
        XCTAssertEqual(usage.tokensAll, 270) // (120+45) + (80+25) = 165 + 105 = 270
        XCTAssertEqual(usage.tokensToday, 270)
        XCTAssertEqual(usage.messages, 2)

        let summary = OllamaTelemetryStore.shared.summary()
        XCTAssertEqual(summary.allTokens, 270)
        XCTAssertEqual(summary.todayTokens, 270)
        XCTAssertEqual(summary.messagesAll, 2)
        XCTAssertEqual(summary.models["qwen2.5-coder:7b"]?.all, 270)
        XCTAssertEqual(summary.models["qwen2.5-coder:7b"]?.prompt, 70)
        XCTAssertEqual(summary.models["qwen2.5-coder:7b"]?.eval, 200)
    }

    func testOllamaTelemetryStoreMultiModelAggregation() {
        let now = Date()
        let qwenSample = OllamaTelemetrySample(
            model: "qwen2.5-coder:7b",
            completedAt: now,
            evalCount: 100,
            evalDurationNs: 2_000_000_000,
            promptEvalCount: 50,
            promptEvalDurationNs: 500_000_000
        )
        let llamaSample = OllamaTelemetrySample(
            model: "llama3.2:3b",
            completedAt: now,
            evalCount: 200,
            evalDurationNs: 3_000_000_000,
            promptEvalCount: 100,
            promptEvalDurationNs: 600_000_000
        )

        OllamaTelemetryStore.shared.record(qwenSample)
        OllamaTelemetryStore.shared.record(llamaSample)

        let summary = OllamaTelemetryStore.shared.summary()
        XCTAssertEqual(summary.allTokens, 450) // 150 + 300
        XCTAssertEqual(summary.todayTokens, 450)
        XCTAssertEqual(summary.models.count, 2)
        XCTAssertEqual(summary.models["qwen2.5-coder:7b"]?.all, 150)
        XCTAssertEqual(summary.models["llama3.2:3b"]?.all, 300)
    }

    func testUsageEngineCollectsLocalLLMTokens() {
        let now = Date()
        let sample = OllamaTelemetrySample(
            model: "deepseek-coder-v2:16b",
            completedAt: now,
            evalCount: 300,
            evalDurationNs: 5_000_000_000,
            promptEvalCount: 150,
            promptEvalDurationNs: 1_000_000_000
        )
        OllamaTelemetryStore.shared.record(sample)

        let engine = UsageEngine()
        let snap = engine.snapshot()

        XCTAssertTrue(snap.tokensAllTime >= 450)
        XCTAssertTrue(snap.tokensToday >= 450)
        let ollamaTool = snap.perTool.first(where: { $0.tool == "ollama" })
        XCTAssertNotNil(ollamaTool)
        XCTAssertEqual(ollamaTool?.tokensAllTime, 450)
        XCTAssertEqual(ollamaTool?.tokensToday, 450)

        let ollamaModel = snap.models.first(where: { $0.model == "deepseek-coder-v2:16b" && $0.provider == "ollama" })
        XCTAssertNotNil(ollamaModel)
        XCTAssertEqual(ollamaModel?.tokensAll, 450)
        XCTAssertEqual(ollamaModel?.tokensToday, 450)
        XCTAssertEqual(ollamaModel?.messages, 1)
        XCTAssertTrue(ollamaModel?.isLocal == true)
        XCTAssertTrue(ollamaModel?.free == true)
    }
}
