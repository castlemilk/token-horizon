import XCTest
@testable import TokenHorizon

final class HeavyRefreshCoordinatorTests: XCTestCase {
    func testIdleCompletionReleasesTheNextRequest() {
        let gate = HeavyRefreshCoordinator()
        XCTAssertTrue(gate.request())
        XCTAssertFalse(gate.finish())
        XCTAssertFalse(gate.finish())
        XCTAssertTrue(gate.request())
        XCTAssertFalse(gate.finish())
    }

    func testBurstKeepsOneFollowupAndFreshActivityDuringFollowupSurvives() {
        let gate = HeavyRefreshCoordinator()
        XCTAssertTrue(gate.request())
        for _ in 0..<100 { XCTAssertFalse(gate.request()) }
        XCTAssertTrue(gate.finish())
        // The promoted run still owns the gate, while new activity gets
        // exactly one subsequent run rather than being lost or parallelized.
        for _ in 0..<100 { XCTAssertFalse(gate.request()) }
        XCTAssertTrue(gate.finish())
        XCTAssertFalse(gate.finish())
        XCTAssertTrue(gate.request())
    }

    func testConcurrentRequestBurstHasOneCollectorAndOneFollowup() {
        let gate = HeavyRefreshCoordinator()
        let lock = NSLock()
        var starts = 0
        DispatchQueue.concurrentPerform(iterations: 100) { _ in
            if gate.request() {
                lock.lock(); starts += 1; lock.unlock()
            }
        }
        XCTAssertEqual(starts, 1)
        XCTAssertTrue(gate.finish())
        XCTAssertFalse(gate.finish())
    }

    func testCompletionRacingActivityNeverLosesOrDuplicatesTheNextRun() {
        for _ in 0..<100 {
            let gate = HeavyRefreshCoordinator()
            XCTAssertTrue(gate.request())
            let lock = NSLock()
            var promoted = false
            var started = false
            DispatchQueue.concurrentPerform(iterations: 2) { index in
                let result = index == 0 ? gate.finish() : gate.request()
                lock.lock()
                if index == 0 { promoted = result } else { started = result }
                lock.unlock()
            }
            XCTAssertNotEqual(promoted, started, "Exactly one caller must own the next run")
            XCTAssertFalse(gate.finish())
        }
    }

    func testExplicitSurfaceAndForceTrayTakePrecedenceOverDetection() {
        for hasNotch in [false, true] {
            XCTAssertEqual(AppDelegate.resolveSurface(mode: .notch, forceTray: false, hasNotch: hasNotch), .notch)
            XCTAssertEqual(AppDelegate.resolveSurface(mode: .tray, forceTray: false, hasNotch: hasNotch), .tray)
            XCTAssertEqual(AppDelegate.resolveSurface(mode: .auto, forceTray: false, hasNotch: hasNotch), hasNotch ? .notch : .tray)
            for mode in SurfaceMode.allCases {
                XCTAssertEqual(AppDelegate.resolveSurface(mode: mode, forceTray: true, hasNotch: hasNotch), .tray)
            }
        }
    }
}
