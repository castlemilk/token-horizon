import XCTest
@testable import TokenHorizon

/// Catalog freshness rules. `lastFetch` used to be stamped by *every* fetch
/// branch (including the cache-reload and bundle-fallback paths), so a failing
/// models.dev endpoint silently consumed the whole 10-minute refresh budget and
/// the list sat on an arbitrarily old cache.
final class ModelCatalogFreshnessTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: - Staleness / retry backoff

    func testStale_isAlwaysTrueWhenNeverAttempted() {
        XCTAssertTrue(ModelCatalog.isStale(lastAttempt: .distantPast, lastAttemptSucceeded: false,
                                           now: now, maxAge: ModelCatalog.remoteRefreshInterval))
        XCTAssertTrue(ModelCatalog.isStale(lastAttempt: .distantPast, lastAttemptSucceeded: true,
                                           now: now, maxAge: ModelCatalog.interactiveRefreshInterval))
    }

    func testStale_successfulAttemptHonoursMaxAge() {
        let maxAge = ModelCatalog.remoteRefreshInterval
        XCTAssertFalse(ModelCatalog.isStale(lastAttempt: now.addingTimeInterval(-maxAge + 60),
                                            lastAttemptSucceeded: true, now: now, maxAge: maxAge),
                       "a fresh successful fetch must not refetch on the background tick")
        XCTAssertTrue(ModelCatalog.isStale(lastAttempt: now.addingTimeInterval(-maxAge - 1),
                                          lastAttemptSucceeded: true, now: now, maxAge: maxAge),
                      "a successful fetch older than maxAge must refetch")
    }

    func testStale_interactiveMaxAgeIsShorterThanBackground() {
        XCTAssertLessThan(ModelCatalog.interactiveRefreshInterval, ModelCatalog.remoteRefreshInterval,
                          "opening the MODELS tab must refresh sooner than the 60s background tick does")
    }

    func testStale_failedAttemptRetriesWellBeforeMaxAge() {
        // The regression: a failed cycle used to stamp the success timestamp,
        // so nothing retried for a full remoteRefreshInterval.
        let maxAge = ModelCatalog.remoteRefreshInterval
        let failedAgo90s = now.addingTimeInterval(-90)
        XCTAssertTrue(ModelCatalog.isStale(lastAttempt: failedAgo90s, lastAttemptSucceeded: false,
                                           now: now, maxAge: maxAge),
                      "a failed cycle must retry within failedRetryInterval, not maxAge")
        // ...but the same age is still fresh after a *success*.
        XCTAssertFalse(ModelCatalog.isStale(lastAttempt: failedAgo90s, lastAttemptSucceeded: true,
                                            now: now, maxAge: maxAge))
    }

    func testStale_failedAttemptDoesNotHotLoop() {
        XCTAssertFalse(ModelCatalog.isStale(lastAttempt: now.addingTimeInterval(-ModelCatalog.failedRetryInterval + 5),
                                            lastAttemptSucceeded: false, now: now,
                                            maxAge: ModelCatalog.remoteRefreshInterval),
                       "retries must be paced by failedRetryInterval")
    }

    // MARK: - Bundle fallback guard

    /// The benchmarks-only skeleton must never replace a populated catalog:
    /// both the remote fetch and the cache read would have had to fail, and
    /// swapping in a pricing-less skeleton collapses the visible model list.
    func testSeedFromFallback_refusesPopulatedCatalog() throws {
        let catalog = ModelCatalog.shared
        let countBefore = catalog.count
        let revisionBefore = catalog.currentRevision()
        guard countBefore > 0 else { throw XCTSkip("catalog not loaded in this environment") }

        let applied = catalog.seedFromFallback([:])
        XCTAssertFalse(applied, "a populated catalog must never be replaced by the fallback skeleton")
        XCTAssertEqual(catalog.count, countBefore, "fallback seed must not touch the in-memory catalog")
        XCTAssertEqual(catalog.currentRevision(), revisionBefore, "a refused seed must not bump the revision")
    }
}
