import Foundation
import XCTest
@testable import TokenHorizon

final class OllamaTelemetryPersistenceTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ollama-telemetry-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
        directory = nil
        try super.tearDownWithError()
    }

    private func sample(tokens: Int) -> OllamaTelemetrySample {
        OllamaTelemetrySample(model: "isolated-model", completedAt: Date(), evalCount: tokens,
                              evalDurationNs: 1_000_000_000, promptEvalCount: nil,
                              promptEvalDurationNs: nil)
    }

    private func awaitSave(to url: URL) {
        let saved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            FileManager.default.fileExists(atPath: url.path)
        }, object: nil)
        wait(for: [saved], timeout: 3)
    }

    func testLoadsOnlyInjectedFile() throws {
        let url = directory.appendingPathComponent("usage.json")
        let record = LocalModelUsageRecord(model: "isolated-model", evalTokens: 42,
                                          totalTokens: 42, messages: 1)
        let state = LocalLLMTelemetryState(models: ["isolated-model": record])
        try JSONEncoder().encode(state).write(to: url)

        let store = OllamaTelemetryStore(storageURL: url)
        XCTAssertEqual(store.usage(for: "isolated-model").tokensAll, 42)
        XCTAssertEqual(store.summary().allTokens, 42)
    }

    func testSavesToInjectedFile() throws {
        let url = directory.appendingPathComponent("nested/usage.json")
        let store = OllamaTelemetryStore(storageURL: url)
        defer { store.resetForTesting(storageURL: nil) }
        store.record(sample(tokens: 17))

        awaitSave(to: url)
        let state = try JSONDecoder().decode(LocalLLMTelemetryState.self, from: Data(contentsOf: url))
        XCTAssertEqual(state.models["isolated-model"]?.totalTokens, 17)
    }

    func testResetCancelsOldSaveAndUsesNewDestination() throws {
        let oldURL = directory.appendingPathComponent("existing.json")
        let original = try JSONEncoder().encode(LocalLLMTelemetryState())
        try original.write(to: oldURL)
        let store = OllamaTelemetryStore(storageURL: oldURL)
        defer { store.resetForTesting(storageURL: nil) }
        store.record(sample(tokens: 99))

        let newURL = directory.appendingPathComponent("replacement.json")
        store.resetForTesting(storageURL: newURL)
        store.record(sample(tokens: 7))
        awaitSave(to: newURL)

        XCTAssertEqual(try Data(contentsOf: oldURL), original)
        let state = try JSONDecoder().decode(LocalLLMTelemetryState.self, from: Data(contentsOf: newURL))
        XCTAssertEqual(state.models["isolated-model"]?.totalTokens, 7)
        XCTAssertEqual(store.summary().allTokens, 7)
    }
}
