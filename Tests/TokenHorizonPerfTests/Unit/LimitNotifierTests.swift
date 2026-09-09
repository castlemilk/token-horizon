import XCTest
import TokenHorizonCore
@testable import TokenHorizon

final class LimitNotifierTests: XCTestCase {
    func testRefreshDetection_rateLimitCleared() {
        let notifier = LimitNotifier()
        let now = Date()
        let prev = LimitNotifier.LimitState(usedPercent: 100.0, resetsAt: now.addingTimeInterval(3600), detail: "rate-limited", lastUpdated: now.addingTimeInterval(-60))
        let current = ProviderLimit(provider: "opencode-go", label: "weekly", usedPercent: 0.0, resetsAt: now.addingTimeInterval(7 * 86400), detail: "")
        XCTAssertTrue(notifier.isRefresh(prev: prev, current: current, now: now))
    }

    func testRefreshDetection_significantDrop() {
        let notifier = LimitNotifier()
        let now = Date()
        let prev = LimitNotifier.LimitState(usedPercent: 85.0, resetsAt: now.addingTimeInterval(3600), detail: "", lastUpdated: now.addingTimeInterval(-60))
        let current = ProviderLimit(provider: "agy", label: "gemini 5h", usedPercent: 5.0, resetsAt: now.addingTimeInterval(5 * 3600), detail: "95% left")
        XCTAssertTrue(notifier.isRefresh(prev: prev, current: current, now: now))
    }

    func testRefreshDetection_dropToZero() {
        let notifier = LimitNotifier()
        let now = Date()
        let prev = LimitNotifier.LimitState(usedPercent: 25.0, resetsAt: now.addingTimeInterval(1800), detail: "", lastUpdated: now.addingTimeInterval(-60))
        let current = ProviderLimit(provider: "glm", label: "5h", usedPercent: 0.0, resetsAt: now.addingTimeInterval(5 * 3600), detail: "")
        XCTAssertTrue(notifier.isRefresh(prev: prev, current: current, now: now))
    }

    func testRefreshDetection_resetTimePassed() {
        let notifier = LimitNotifier()
        let now = Date()
        let prev = LimitNotifier.LimitState(usedPercent: 60.0, resetsAt: now.addingTimeInterval(-10), detail: "", lastUpdated: now.addingTimeInterval(-60))
        let current = ProviderLimit(provider: "claude", label: "5h", usedPercent: 0.0, resetsAt: now.addingTimeInterval(5 * 3600), detail: "")
        XCTAssertTrue(notifier.isRefresh(prev: prev, current: current, now: now))
    }

    func testRefreshDetection_normalFluctuationNotTriggered() {
        let notifier = LimitNotifier()
        let now = Date()
        let prev = LimitNotifier.LimitState(usedPercent: 50.0, resetsAt: now.addingTimeInterval(3600), detail: "", lastUpdated: now.addingTimeInterval(-60))
        let current = ProviderLimit(provider: "codex", label: "7d", usedPercent: 48.0, resetsAt: now.addingTimeInterval(3600), detail: "")
        XCTAssertFalse(notifier.isRefresh(prev: prev, current: current, now: now))
    }
}
