import XCTest
@testable import TokenHorizon

final class OllamaProxyUnitTests: XCTestCase {

    func testOllamaTelemetrySample_rates() {
        let sample = OllamaTelemetrySample(
            model: "qwen2.5-coder:7b",
            completedAt: Date(),
            evalCount: 250,
            evalDurationNs: 5_000_000_000, // 5 seconds -> 50 tok/s
            promptEvalCount: 100,
            promptEvalDurationNs: 500_000_000 // 0.5s -> 200 prompt tok/s
        )

        XCTAssertEqual(sample.tokPerSec, 50.0)
        XCTAssertEqual(sample.promptTokPerSec, 200.0)
    }

    func testOllamaTelemetrySample_zeroDuration() {
        let sample = OllamaTelemetrySample(
            model: "llama3.2:3b",
            completedAt: Date(),
            evalCount: 0,
            evalDurationNs: 0,
            promptEvalCount: 0,
            promptEvalDurationNs: 0
        )

        XCTAssertNil(sample.tokPerSec)
        XCTAssertNil(sample.promptTokPerSec)
    }

    func testOllamaTelemetryStore_recordAndSummary() {
        let store = OllamaTelemetryStore.shared
        let now = Date()

        let sample1 = OllamaTelemetrySample(
            model: "test-unit-model-1",
            completedAt: now,
            evalCount: 120,
            evalDurationNs: 2_000_000_000,
            promptEvalCount: 30,
            promptEvalDurationNs: 200_000_000
        )

        store.record(sample1)

        let summary = store.summary()
        XCTAssertGreaterThanOrEqual(summary.allTokens, 150)
        XCTAssertTrue(summary.models.keys.contains("test-unit-model-1"))

        let recordedModel = summary.models["test-unit-model-1"]
        XCTAssertNotNil(recordedModel)
        XCTAssertGreaterThanOrEqual(recordedModel?.all ?? 0, 150)
        XCTAssertGreaterThanOrEqual(recordedModel?.prompt ?? 0, 30)
        XCTAssertGreaterThanOrEqual(recordedModel?.eval ?? 0, 120)
    }

    func testLocalModelUsageRecord_codableRoundtrip() throws {
        var record = LocalModelUsageRecord(model: "qwen2.5-coder:7b")
        record.promptTokens = 500
        record.evalTokens = 1500
        record.totalTokens = 2000
        record.messages = 5
        record.hourlyBuckets = [1725184800: 2000]

        let data = try JSONEncoder().encode(record)
        let decoded = try JSONDecoder().decode(LocalModelUsageRecord.self, from: data)

        XCTAssertEqual(record.model, decoded.model)
        XCTAssertEqual(record.totalTokens, decoded.totalTokens)
        XCTAssertEqual(record.messages, decoded.messages)
        XCTAssertEqual(record.hourlyBuckets[1725184800], 2000)
    }
}
