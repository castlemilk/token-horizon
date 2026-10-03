import Foundation
import XCTest
@testable import TokenHorizon

final class NotchInteractionPolicyTests: XCTestCase {
    func testHoverKeepsOpenAndCloseDwellAndResetsOnReentry() {
        var policy = NotchInteractionPolicy()
        XCTAssertNil(policy.poll(pointerInside: true, eventTracking: false, now: 0))
        XCTAssertNil(policy.poll(pointerInside: true, eventTracking: false, now: 0.11))
        XCTAssertEqual(policy.poll(pointerInside: true, eventTracking: false, now: 0.13), true)
        policy.setExpanded(true)
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 1))
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 1.39))
        XCTAssertNil(policy.poll(pointerInside: true, eventTracking: false, now: 1.4))
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 2))
        XCTAssertEqual(policy.poll(pointerInside: false, eventTracking: false, now: 2.41), false)
    }

    func testAnUnrelatedMenuCannotLockAnExpandedNotch() {
        let menu = NSObject()
        var policy = NotchInteractionPolicy()
        policy.setExpanded(true)
        XCTAssertFalse(policy.beginMenu(ObjectIdentifier(menu), initiatedByPanel: false))
        XCTAssertTrue(policy.menuIDs.isEmpty)
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: true, now: 1))
        XCTAssertEqual(policy.poll(pointerInside: false, eventTracking: true, now: 1.41), false)
    }

    func testActiveOwnedMenuDoesNotExpireWhenPointerLeavesPanel() {
        let menu = NSObject()
        var policy = NotchInteractionPolicy()
        policy.setExpanded(true)
        XCTAssertTrue(policy.beginMenu(ObjectIdentifier(menu), initiatedByPanel: true))
        for now in [0.0, 10, 60, 3_600] {
            XCTAssertNil(policy.poll(pointerInside: false, eventTracking: true, now: now))
        }
        XCTAssertEqual(policy.menuIDs, [ObjectIdentifier(menu)])
    }

    func testMissingMenuEndRecoversAfterTrackingLoopExits() {
        let menu = NSObject()
        var policy = NotchInteractionPolicy()
        policy.setExpanded(true)
        policy.beginMenu(ObjectIdentifier(menu), initiatedByPanel: true)
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: true, now: 1))
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 2))
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 2.12))
        XCTAssertFalse(policy.menuIDs.isEmpty)
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 2.19))
        XCTAssertTrue(policy.menuIDs.isEmpty)
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 2.58))
        XCTAssertEqual(policy.poll(pointerInside: false, eventTracking: false, now: 2.6), false)
    }

    func testTemporaryDefaultModeDoesNotExpireAnActiveMenu() {
        let menu = NSObject()
        var policy = NotchInteractionPolicy()
        policy.setExpanded(true)
        policy.beginMenu(ObjectIdentifier(menu), initiatedByPanel: true)
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 1))
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: true, now: 1.1))
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 2))
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: true, now: 2.1))
        XCTAssertEqual(policy.menuIDs, [ObjectIdentifier(menu)])
    }

    func testMenuEndStartsACompleteCloseDwell() {
        let menu = NSObject()
        var policy = NotchInteractionPolicy()
        policy.setExpanded(true)
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 1))
        policy.beginMenu(ObjectIdentifier(menu), initiatedByPanel: true)
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: true, now: 2))
        policy.endMenu(ObjectIdentifier(menu))
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 3))
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 3.39))
        XCTAssertEqual(policy.poll(pointerInside: false, eventTracking: false, now: 3.41), false)
    }

    func testUnrelatedMenuEndCannotRestartCloseDwell() {
        let otherMenu = NSObject()
        var policy = NotchInteractionPolicy()
        policy.setExpanded(true)
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 1))
        policy.endMenu(ObjectIdentifier(otherMenu))
        XCTAssertEqual(policy.poll(pointerInside: false, eventTracking: false, now: 1.41), false)
    }

    func testDismissClearsMenusAndRequiresFreshPointerEntry() {
        let menu = NSObject()
        var policy = NotchInteractionPolicy()
        policy.setExpanded(true)
        policy.beginMenu(ObjectIdentifier(menu), initiatedByPanel: true)
        policy.dismiss()
        XCTAssertFalse(policy.isExpanded)
        XCTAssertTrue(policy.menuIDs.isEmpty)
        XCTAssertNil(policy.poll(pointerInside: true, eventTracking: false, now: 1))
        XCTAssertNil(policy.poll(pointerInside: true, eventTracking: false, now: 60))
        XCTAssertNil(policy.poll(pointerInside: false, eventTracking: false, now: 61))
        XCTAssertNil(policy.poll(pointerInside: true, eventTracking: false, now: 62))
        XCTAssertEqual(policy.poll(pointerInside: true, eventTracking: false, now: 62.13), true)
    }

    func testResetForDisplayChangeClearsMenuAndDismissalState() {
        let menu = NSObject()
        var policy = NotchInteractionPolicy()
        policy.setExpanded(true)
        policy.beginMenu(ObjectIdentifier(menu), initiatedByPanel: true)
        policy.dismiss()
        policy.reset()
        XCTAssertFalse(policy.isExpanded)
        XCTAssertTrue(policy.menuIDs.isEmpty)
        XCTAssertFalse(policy.requiresPointerExit)
        XCTAssertNil(policy.poll(pointerInside: true, eventTracking: false, now: 1))
        XCTAssertEqual(policy.poll(pointerInside: true, eventTracking: false, now: 1.13), true)
    }

    func testCollapsedPanelCannotAcquireAMenuLock() {
        let menu = NSObject()
        var policy = NotchInteractionPolicy()
        XCTAssertFalse(policy.beginMenu(ObjectIdentifier(menu), initiatedByPanel: true))
        XCTAssertTrue(policy.menuIDs.isEmpty)
    }
}
