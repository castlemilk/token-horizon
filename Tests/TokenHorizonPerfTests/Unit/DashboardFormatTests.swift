import XCTest
@testable import TokenHorizon

/// Tests for DashboardTabs' pure formatting helpers (also exercised via the
/// /limits route). Date-relative cases anchor to local day boundaries so
/// they cannot flake across midnight.
final class DashboardFormatTests: XCTestCase {

    func testFormatReset() {
        XCTAssertEqual(DashboardTabs.formatReset(Date().addingTimeInterval(-5)), "now")
        XCTAssertEqual(DashboardTabs.formatReset(Date().addingTimeInterval(30 * 60)), "30m")
        XCTAssertEqual(DashboardTabs.formatReset(Date().addingTimeInterval(90 * 60)), "1h 30m")
        XCTAssertEqual(DashboardTabs.formatReset(Date().addingTimeInterval(25 * 3600)), "1d 1h")
    }

    func testFormatResetShort() {
        XCTAssertEqual(DashboardTabs.formatResetShort(Date().addingTimeInterval(-1)), "now")
        XCTAssertEqual(DashboardTabs.formatResetShort(Date().addingTimeInterval(30 * 60)), "30m")
        // Sub-minute rounds up to 1m, never 0m.
        XCTAssertEqual(DashboardTabs.formatResetShort(Date().addingTimeInterval(20)), "1m")
        XCTAssertEqual(DashboardTabs.formatResetShort(Date().addingTimeInterval(3.2 * 3600)), "3h")
        XCTAssertEqual(DashboardTabs.formatResetShort(Date().addingTimeInterval(2.5 * 86400)), "2.5d")
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
