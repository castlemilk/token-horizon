import XCTest
@testable import TokenHorizon

/// Tests for the injectable time seam (`THClock` / `ManualClock`).
final class ClockTests: XCTestCase {

    func testSystemClock_returnsApproximatelyNow() {
        let clock: THClock = SystemClock()
        let before = Date()
        let got = clock.now()
        let after = Date()
        XCTAssertGreaterThanOrEqual(got, before)
        XCTAssertLessThanOrEqual(got, after)
    }

    func testManualClock_startsAtGivenDate_andOnlyMovesWhenTold() {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let clock = ManualClock(start)
        XCTAssertEqual(clock.now(), start)
        // Wall-clock time passing must NOT move a manual clock.
        Thread.sleep(forTimeInterval: 0.01)
        XCTAssertEqual(clock.now(), start)
    }

    func testManualClock_advanceAndSet() {
        let clock = ManualClock(Date(timeIntervalSince1970: 0))
        clock.advance(by: 3_600)
        XCTAssertEqual(clock.now(), Date(timeIntervalSince1970: 3_600))
        clock.advance(by: -60)
        XCTAssertEqual(clock.now(), Date(timeIntervalSince1970: 3_540))
        clock.set(Date(timeIntervalSince1970: 42))
        XCTAssertEqual(clock.now(), Date(timeIntervalSince1970: 42))
    }

    func testManualClock_defaultStartIsEpoch() {
        XCTAssertEqual(ManualClock().now(), Date(timeIntervalSince1970: 0))
    }
}
