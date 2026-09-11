import XCTest
@testable import TokenHorizon

final class ModelDiscoveryEngineTests: XCTestCase {

    func testEngine_statusAndLifecycle() {
        let engine = ModelDiscoveryEngine.shared
        let initialStatus = engine.status()

        XCTAssertGreaterThan(initialStatus.catalogCount, 0)
        XCTAssertGreaterThanOrEqual(initialStatus.catalogRevision, 1)
        XCTAssertFalse(initialStatus.monitoredFiles.isEmpty)

        engine.start()
        let runningStatus = engine.status()
        XCTAssertTrue(runningStatus.isRunning)

        engine.stop()
        let stoppedStatus = engine.status()
        XCTAssertFalse(stoppedStatus.isRunning)
    }

    func testEngine_mergeDiscoveredEntries_incrementsRevisionAndUpdates() {
        let catalog = ModelCatalog.shared
        let revBefore = catalog.currentRevision()

        let testModelId = "test-discovered-model-\(UUID().uuidString.prefix(8))"
        let testEntry = ModelCatalog.Entry(
            id: testModelId,
            name: "Test Discovered Model",
            provider: "openai",
            providerName: "OpenAI",
            inputPerM: 1.50,
            outputPerM: 6.00,
            cacheReadPerM: 0.20,
            contextK: 512,
            benchmarks: ModelCatalog.Benchmarks(swe: 88.0, lcb: 85.0, source: "Synthetic"),
            discountPercent: 30,
            discountLabel: "-30% PROMO"
        )

        let result1 = catalog.mergeDiscoveredEntries([testModelId: testEntry])
        XCTAssertEqual(result1.added, 1)
        XCTAssertEqual(result1.updated, 0)
        XCTAssertGreaterThan(catalog.currentRevision(), revBefore)

        let found = catalog.lookup(id: testModelId)
        XCTAssertNotNil(found)
        XCTAssertEqual(found?.name, "Test Discovered Model")
        XCTAssertEqual(found?.inputPerM, 1.50)
        XCTAssertEqual(found?.discountPercent, 30)

        // Now test updating the existing model with new pricing/discount
        var updatedEntry = testEntry
        updatedEntry.inputPerM = 1.00
        updatedEntry.discountPercent = 50

        let result2 = catalog.mergeDiscoveredEntries([testModelId: updatedEntry])
        XCTAssertEqual(result2.added, 0)
        XCTAssertEqual(result2.updated, 1)

        let foundUpdated = catalog.lookup(id: testModelId)
        XCTAssertEqual(foundUpdated?.inputPerM, 1.00)
        XCTAssertEqual(foundUpdated?.discountPercent, 50)
    }

    func testEngine_triggerScan_returnsSummary() {
        let engine = ModelDiscoveryEngine.shared
        let summary = engine.triggerScan(includeRemote: false)

        XCTAssertEqual(summary.reason, "local_scan")
        XCTAssertGreaterThan(summary.totalCatalogCount, 0)
        XCTAssertGreaterThanOrEqual(summary.catalogRevision, 1)
        XCTAssertLessThanOrEqual(abs(summary.timestamp.timeIntervalSinceNow), 5.0)
    }

    func testEngine_checkLocalFiles_executesWithoutCrash() {
        let engine = ModelDiscoveryEngine.shared
        let res = engine.checkLocalFiles(force: true, reason: "test")
        XCTAssertGreaterThanOrEqual(res.added, 0)
        XCTAssertGreaterThanOrEqual(res.updated, 0)

        let st = engine.status()
        XCTAssertNotNil(st.lastLocalScan)
        XCTAssertGreaterThanOrEqual(st.scanCount, 1)
    }
}
