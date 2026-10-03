import Foundation
import XCTest
@testable import TokenHorizon

final class DurableStoreResetIsolationTests: XCTestCase {
    func testResetObserverCanReadStatsAfterFilesAreCleared() throws {
        let directory = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("token-horizon-reset-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let notifications = NotificationCenter()
        let store = DurableStore(cacheDirectory: directory, notificationCenter: notifications)
        let targets = [store.snapshotURL, store.historyURL, store.trendsURL, store.limitsURL, store.engineStateURL]
        var expectedBytes: Int64 = 0
        for (index, url) in targets.enumerated() {
            let data = Data("isolated cache fixture \(index)".utf8)
            expectedBytes += Int64(data.count)
            try data.write(to: url)
        }
        let unrelated = directory.appendingPathComponent("unrelated.txt")
        try Data("keep this file".utf8).write(to: unrelated)
        XCTAssertEqual(store.cacheStats().filesCount, targets.count)

        let observerFinished = expectation(description: "Synchronous observer can acquire the store lock")
        observerFinished.assertForOverFulfill = true
        let resetFinished = expectation(description: "Reset returns after notifying observers")
        let observer = notifications.addObserver(forName: .tokenHorizonCacheReset, object: nil, queue: nil) { _ in
            let stats = store.cacheStats()
            XCTAssertEqual(stats.filesCount, 0)
            XCTAssertEqual(stats.totalBytes, 0)
            observerFinished.fulfill()
        }
        defer { notifications.removeObserver(observer) }
        let fixtureBytes = expectedBytes
        DispatchQueue.global(qos: .userInitiated).async {
            let result = store.resetAll()
            XCTAssertEqual(result.clearedFiles, targets.count)
            XCTAssertEqual(result.clearedBytes, fixtureBytes)
            resetFinished.fulfill()
        }

        // The old notification-under-lock implementation deadlocks in the
        // observer's cacheStats call. Bound that failure to this isolated store.
        wait(for: [observerFinished, resetFinished], timeout: 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
    }
}
