import XCTest
@testable import TokenHorizon

final class PlanLimitsRefreshTests: XCTestCase {
    private final class Counter {
        private let lock = NSLock()
        private var value = 0

        func increment() -> Int {
            lock.lock(); defer { lock.unlock() }
            value += 1
            return value
        }

        var count: Int {
            lock.lock(); defer { lock.unlock() }
            return value
        }
    }

    private func row(provider: String, usedPercent: Double) -> ProviderLimit {
        ProviderLimit(provider: provider, label: "weekly", usedPercent: usedPercent, resetsAt: nil, detail: "fixture")
    }

    private func observeUpdate(engine: PlanLimitsEngine, provider: String, usedPercent: Double) -> (NSObjectProtocol, XCTestExpectation) {
        let updated = expectation(description: "Quota cache and notification updated")
        updated.assertForOverFulfill = true
        let observer = NotificationCenter.default.addObserver(forName: Notification.Name("planLimitsUpdated"), object: nil, queue: nil) { note in
            guard let rows = note.object as? [ProviderLimit], rows.first?.provider == provider else { return }
            XCTAssertTrue(Thread.isMainThread)
            XCTAssertEqual(rows.first?.usedPercent, usedPercent)
            XCTAssertEqual(engine.cachedLimits().first?.usedPercent, usedPercent)
            updated.fulfill()
        }
        return (observer, updated)
    }

    func testBlockedRefreshCoalescesConcurrentExpiredAndForcedRequests() {
        let provider = UUID().uuidString
        let limits = [row(provider: provider, usedPercent: 25)]
        let clock = ManualClock(Date(timeIntervalSince1970: 1_000))
        let counter = Counter()
        let started = expectation(description: "The first fetch started")
        let duplicate = expectation(description: "No overlapping fetch starts")
        duplicate.isInverted = true
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let engine = PlanLimitsEngine(fetchLimits: {
            if counter.increment() == 1 {
                started.fulfill()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
            } else {
                duplicate.fulfill()
            }
            return limits
        }, clock: clock)
        let (observer, updated) = observeUpdate(engine: engine, provider: provider, usedPercent: 25)
        defer { NotificationCenter.default.removeObserver(observer) }

        engine.refreshIfDue()
        wait(for: [started], timeout: 2)
        clock.advance(by: 120)
        DispatchQueue.concurrentPerform(iterations: 100) { index in
            if index.isMultiple(of: 3) { engine.refreshNow() } else { engine.refreshIfDue(maxAge: 0) }
        }
        wait(for: [duplicate], timeout: 0.1)
        XCTAssertEqual(counter.count, 1)
        XCTAssertTrue(engine.cachedLimits().isEmpty)

        release.signal()
        wait(for: [updated], timeout: 2)
        XCTAssertEqual(counter.count, 1)
        XCTAssertEqual(engine.cachedLimits().first?.usedPercent, 25)
    }

    func testCompletionStartsFreshnessWindowAndReleasesRefreshGuard() {
        let provider = UUID().uuidString
        let rows = [row(provider: provider, usedPercent: 30)]
        let clock = ManualClock(Date(timeIntervalSince1970: 1_000))
        let counter = Counter()
        let started = expectation(description: "The first fetch started")
        let freshRefetch = expectation(description: "Completion keeps the cache fresh")
        freshRefetch.isInverted = true
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let engine = PlanLimitsEngine(fetchLimits: {
            if counter.increment() == 1 {
                started.fulfill()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
            } else if clock.now() == Date(timeIntervalSince1970: 4_600) {
                freshRefetch.fulfill()
            }
            return rows
        }, clock: clock)
        let (firstObserver, firstUpdated) = observeUpdate(engine: engine, provider: provider, usedPercent: 30)
        defer { NotificationCenter.default.removeObserver(firstObserver) }
        engine.refreshIfDue()
        wait(for: [started], timeout: 2)
        clock.advance(by: 3_600)
        release.signal()
        wait(for: [firstUpdated], timeout: 2)
        NotificationCenter.default.removeObserver(firstObserver)

        engine.refreshIfDue(maxAge: 60)
        wait(for: [freshRefetch], timeout: 0.1)
        XCTAssertEqual(counter.count, 1, "A slow fetch is fresh when it finishes")

        let (nextObserver, nextUpdated) = observeUpdate(engine: engine, provider: provider, usedPercent: 30)
        defer { NotificationCenter.default.removeObserver(nextObserver) }
        clock.advance(by: 61)
        engine.refreshIfDue(maxAge: 60)
        wait(for: [nextUpdated], timeout: 2)
        XCTAssertEqual(counter.count, 2, "Completion releases the guard for an expired cache")
    }

    func testForcedRefreshRunsDespiteFreshCache() {
        let provider = UUID().uuidString
        let initialRows = [row(provider: provider, usedPercent: 10)]
        let nextRows = [row(provider: provider, usedPercent: 20)]
        let counter = Counter()
        let engine = PlanLimitsEngine(fetchLimits: {
            counter.increment() == 1 ? initialRows : nextRows
        }, clock: ManualClock(Date(timeIntervalSince1970: 1_000)))
        let (firstObserver, firstUpdated) = observeUpdate(engine: engine, provider: provider, usedPercent: 10)
        defer { NotificationCenter.default.removeObserver(firstObserver) }
        engine.refreshIfDue()
        wait(for: [firstUpdated], timeout: 2)
        NotificationCenter.default.removeObserver(firstObserver)

        let (nextObserver, nextUpdated) = observeUpdate(engine: engine, provider: provider, usedPercent: 20)
        defer { NotificationCenter.default.removeObserver(nextObserver) }
        engine.refreshNow()
        wait(for: [nextUpdated], timeout: 2)
        XCTAssertEqual(counter.count, 2)
        XCTAssertEqual(engine.cachedLimits().first?.usedPercent, 20)
    }

    func testBlockedFetchDoesNotRetainEngine() {
        let started = expectation(description: "The fetch started")
        let finished = expectation(description: "The detached fetch finishes")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        var engine: PlanLimitsEngine? = PlanLimitsEngine(fetchLimits: {
            started.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
            finished.fulfill()
            return []
        })
        weak var weakEngine = engine
        engine?.refreshNow()
        wait(for: [started], timeout: 2)

        engine = nil
        XCTAssertNil(weakEngine, "A blocked provider must not keep an instance alive")
        release.signal()
        wait(for: [finished], timeout: 2)
    }
}
