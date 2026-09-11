import XCTest
@testable import TokenHorizon

/// Throttle handling for the Claude usage API: Retry-After parsing, backoff
/// clamping, stale disk fallback tiers, and stale row marking. All pure —
/// no keychain, no network, no shared singletons.
final class ClaudeThrottleTests: XCTestCase {

    private func response(headers: [String: String]?, status: Int = 429) -> HTTPURLResponse {
        HTTPURLResponse(
            url: URL(string: "https://api.anthropic.com/api/oauth/usage")!,
            statusCode: status, httpVersion: "HTTP/2", headerFields: headers)!
    }

    func testParseRetryAfter_seconds() {
        XCTAssertEqual(ClaudeDiscovery.parseRetryAfter(response(headers: ["Retry-After": "3509"])), 3509)
        XCTAssertEqual(ClaudeDiscovery.parseRetryAfter(response(headers: ["retry-after": "60"])), 60)
        XCTAssertEqual(ClaudeDiscovery.parseRetryAfter(response(headers: ["RETRY-AFTER": " 120 "])), 120)
    }

    func testParseRetryAfter_absentOrGarbage() {
        XCTAssertNil(ClaudeDiscovery.parseRetryAfter(response(headers: nil)))
        XCTAssertNil(ClaudeDiscovery.parseRetryAfter(response(headers: ["Retry-After": "soon"])))
        XCTAssertNil(ClaudeDiscovery.parseRetryAfter(response(headers: ["Retry-After": "-5"])))
        XCTAssertNil(ClaudeDiscovery.parseRetryAfter(response(headers: ["X-Other": "1"])))
    }

    func testThrottleBackoffDelay_clamps() {
        XCTAssertEqual(ClaudeDiscovery.throttleBackoffDelay(retryAfter: 3509), 3509)
        XCTAssertEqual(ClaudeDiscovery.throttleBackoffDelay(retryAfter: nil),
                       ClaudeDiscovery.defaultThrottleBackoff)
        XCTAssertEqual(ClaudeDiscovery.throttleBackoffDelay(retryAfter: 0),
                       ClaudeDiscovery.defaultThrottleBackoff)
        // Sub-minute asks would just re-trigger the throttle: floor at 60s.
        XCTAssertEqual(ClaudeDiscovery.throttleBackoffDelay(retryAfter: 10), 60)
        // Absurd asks cap at 24h so recovery is never more than a day out.
        XCTAssertEqual(ClaudeDiscovery.throttleBackoffDelay(retryAfter: 1_000_000), 86_400)
    }

    private func cachedUsage(age: TimeInterval) -> [String: Any] {
        let future = Date().addingTimeInterval(3600).timeIntervalSince1970
        return [
            "fetchedAtMs": (Date().timeIntervalSince1970 - age) * 1000.0,
            "utilization": [
                "five_hour": ["utilization": 25.0, "resets_at": future],
                "seven_day": ["utilization": 50.0, "resets_at": future],
            ],
        ]
    }

    func testDiskFallback_freshIsNotStale() {
        let fb = ClaudeDiscovery.diskFallbackLimits(
            cachedUsage: cachedUsage(age: 1800), provider: "claude (dorja)", detail: "d")
        XCTAssertFalse(fb.isStale)
        XCTAssertEqual(fb.limits.count, 2)
        XCTAssertEqual(fb.limits[0].usedPercent, 25, accuracy: 1e-9)
    }

    func testDiskFallback_oldIsStaleButPresent() {
        // 4.8 days old, like dorja's on-disk cache: stale, but parseable —
        // better than hiding the account while live is throttled.
        let fb = ClaudeDiscovery.diskFallbackLimits(
            cachedUsage: cachedUsage(age: 4.8 * 86_400), provider: "claude (dorja)", detail: "d")
        XCTAssertTrue(fb.isStale)
        XCTAssertEqual(fb.limits.count, 2)
    }

    func testDiskFallback_missingBlobIsEmpty() {
        XCTAssertTrue(ClaudeDiscovery.diskFallbackLimits(
            cachedUsage: nil, provider: "p", detail: "d").limits.isEmpty)
        XCTAssertTrue(ClaudeDiscovery.diskFallbackLimits(
            cachedUsage: ["fetchedAtMs": 1.0], provider: "p", detail: "d").limits.isEmpty)
        XCTAssertTrue(ClaudeDiscovery.diskFallbackLimits(
            cachedUsage: ["utilization": [:] as [String: Any]], provider: "p", detail: "d").limits.isEmpty)
    }

    func testMarkStale_throttledGetsBadgeMarker() {
        let rows = [
            ProviderLimit(provider: "claude (dorja)", label: "5h",
                          usedPercent: 11, resetsAt: nil, detail: "ben@dorja.com · claude_max"),
            ProviderLimit(provider: "claude (dorja)", label: "weekly",
                          usedPercent: 23, resetsAt: nil, detail: ""),
        ]
        let marked = ClaudeDiscovery.markStale(rows, throttled: true)
        XCTAssertTrue(marked[0].detail.contains("rate-limited"))
        XCTAssertTrue(marked[0].detail.contains("ben@dorja.com"))
        XCTAssertEqual(marked[1].detail, "rate-limited")
        // Pricing/labels untouched.
        XCTAssertEqual(marked[0].usedPercent, 11, accuracy: 1e-9)

        let stale = ClaudeDiscovery.markStale(rows, throttled: false)
        XCTAssertTrue(stale[0].detail.contains("stale"))
        XCTAssertFalse(stale[0].detail.contains("rate-limited"))

        // Idempotent: re-marking never stacks tags.
        let twice = ClaudeDiscovery.markStale(marked, throttled: true)
        XCTAssertEqual(twice[0].detail, marked[0].detail)
    }
}
