import XCTest
@testable import TokenHorizon

/// Tests for DashboardTabs' pure formatting helpers (also exercised via the
/// /limits route). Date-relative cases anchor to local day boundaries so
/// they cannot flake across midnight.
final class DashboardFormatTests: XCTestCase {

    func testFormatReset() {
        // Pin `now` — using the wall clock twice flaked on slow/coverage
        // instrumented CI runs when the elapsed time crossed a minute edge.
        let now = Date()
        XCTAssertEqual(DashboardTabs.formatReset(now.addingTimeInterval(-5), now: now), "now")
        XCTAssertEqual(DashboardTabs.formatReset(now.addingTimeInterval(30 * 60), now: now), "30m")
        XCTAssertEqual(DashboardTabs.formatReset(now.addingTimeInterval(90 * 60), now: now), "1h 30m")
        XCTAssertEqual(DashboardTabs.formatReset(now.addingTimeInterval(25 * 3600), now: now), "1d 1h")
        XCTAssertEqual(DashboardTabs.formatReset(now.addingTimeInterval(3600), now: now), "1h 0m")
    }

    func testFormatResetShort() {
        let now = Date()
        XCTAssertEqual(DashboardTabs.formatResetShort(now.addingTimeInterval(-1), now: now), "now")
        XCTAssertEqual(DashboardTabs.formatResetShort(now.addingTimeInterval(30 * 60), now: now), "30m")
        // Sub-minute rounds up to 1m, never 0m.
        XCTAssertEqual(DashboardTabs.formatResetShort(now.addingTimeInterval(20), now: now), "1m")
        XCTAssertEqual(DashboardTabs.formatResetShort(now.addingTimeInterval(3.2 * 3600), now: now), "3h")
        XCTAssertEqual(DashboardTabs.formatResetShort(now.addingTimeInterval(2.5 * 86400), now: now), "2.5d")
    }

    func testFormatResetDateTime() {
        let cal = Calendar.current
        let noonToday = cal.startOfDay(for: Date()).addingTimeInterval(12 * 3600)
        XCTAssertTrue(DashboardTabs.formatResetDateTime(noonToday).hasPrefix("today at "))
        let noonTomorrow = cal.startOfDay(for: Date()).addingTimeInterval(36 * 3600)
        XCTAssertTrue(DashboardTabs.formatResetDateTime(noonTomorrow).hasPrefix("tomorrow at "))
        let later = cal.startOfDay(for: Date()).addingTimeInterval(4 * 86400 + 3600)
        let s = DashboardTabs.formatResetDateTime(later)
        XCTAssertFalse(s.isEmpty)
        XCTAssertFalse(s.hasPrefix("today"))
        XCTAssertFalse(s.hasPrefix("tomorrow"))
    }
}
