import XCTest
@testable import TokenHorizon

final class DockerSamplingTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000)

    func testFailureRetainsLastGoodValuesAndBacksOffFromCompletion() {
        let cache = DockerSamplingCache()
        let sample = DockerContainerSample(id: "test", name: "fixture", image: "fixture", cpu: 1,
            memMB: 2, memLimitMB: 3, memPercent: 4, netInMB: 0, netOutMB: 0,
            diskReadMB: 0, diskWriteMB: 0, pids: 1, status: "running", ports: "")
        XCTAssertTrue(cache.begin(now: now))
        XCTAssertEqual(cache.finish([sample], now: now), [sample])
        XCTAssertTrue(cache.begin(now: now.addingTimeInterval(3)))
        XCTAssertFalse(cache.begin(now: now.addingTimeInterval(10)))
        XCTAssertEqual(cache.current(), [sample])
        let completed = now.addingTimeInterval(10)
        XCTAssertEqual(cache.finish(nil, now: completed), [sample])
        XCTAssertFalse(cache.begin(now: completed.addingTimeInterval(2.49)))
        XCTAssertTrue(cache.begin(now: completed.addingTimeInterval(2.5)))
    }

    func testEmptySuccessAndColdFailureAlsoHaveACooldown() {
        let outcomes: [[DockerContainerSample]?] = [[], nil]
        for next in outcomes {
            let cache = DockerSamplingCache()
            XCTAssertTrue(cache.begin(now: now))
            XCTAssertEqual(cache.finish(next, now: now), [])
            XCTAssertFalse(cache.begin(now: now.addingTimeInterval(1)))
            XCTAssertTrue(cache.begin(now: now.addingTimeInterval(2.5)))
        }
    }

    func testConcurrentReadersStartOnlyOneSampler() {
        let cache = DockerSamplingCache()
        let lock = NSLock()
        var starts = 0
        DispatchQueue.concurrentPerform(iterations: 100) { _ in
            if cache.begin(now: now) {
                lock.lock(); starts += 1; lock.unlock()
            }
        }
        XCTAssertEqual(starts, 1)
        XCTAssertEqual(cache.current(), [])
        cache.finish([], now: now)
        XCTAssertFalse(cache.begin(now: now))
    }

    func testCaptureReadsOwnedChildOutputWithoutAPipe() throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/printf")
        task.arguments = ["fixture-output"]
        let data = try XCTUnwrap(DockerObserver.runCapture(task, timeout: 1))
        XCTAssertEqual(String(data: data, encoding: .utf8), "fixture-output")
        XCTAssertEqual(task.terminationStatus, 0)
    }

    func testCaptureDeadlineStopsOnlyItsOwnedSleeperPromptly() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sleep")
        task.arguments = ["3"]
        XCTAssertNil(DockerObserver.runCapture(task, timeout: 0))
        XCTAssertFalse(task.isRunning)
        let started = ProcessInfo.processInfo.systemUptime
        XCTAssertNil(DockerObserver.runCapture(task, timeout: 0.05))
        task.waitUntilExit()
        XCTAssertFalse(task.isRunning)
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 1.5)
    }
}
