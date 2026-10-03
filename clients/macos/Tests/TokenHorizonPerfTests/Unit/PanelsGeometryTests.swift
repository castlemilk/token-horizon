import AppKit
import XCTest
@testable import TokenHorizon

final class PanelsGeometryTests: XCTestCase {
    func testExpandedHeightUsesPhysicalTopAndVisibleBottomOnScaledDisplays() {
        let cases: [(String, NSRect, NSRect, CGFloat)] = [
            ("normal", NSRect(x: 0, y: 0, width: 1512, height: 982),
             NSRect(x: 0, y: 70, width: 1512, height: 874), 598),
            ("short without bottom dock", NSRect(x: 0, y: 0, width: 1280, height: 600),
             NSRect(x: 0, y: 0, width: 1280, height: 562), 588),
            ("short with bottom dock", NSRect(x: 0, y: 0, width: 1280, height: 600),
             NSRect(x: 0, y: 70, width: 1280, height: 492), 518),
            ("shifted display", NSRect(x: -1600, y: 300, width: 1280, height: 600),
             NSRect(x: -1600, y: 370, width: 1280, height: 492), 518),
            ("display below main", NSRect(x: 0, y: -600, width: 1280, height: 600),
             NSRect(x: 0, y: -540, width: 1280, height: 502), 528)
        ]
        for (name, frame, visibleFrame, expectedHeight) in cases {
            let geometry = NotchPanel.Geometry.forDisplay(frame: frame, visibleFrame: visibleFrame, safeAreaTop: 38)
            XCTAssertEqual(geometry.expanded.height, expectedHeight, accuracy: 0.01, name)
            XCTAssertEqual(geometry.expanded.width, 740, accuracy: 0.01, name)
            let expandedFrame = geometry.panelFrame(in: frame, expanded: true)
            XCTAssertEqual(expandedFrame.maxY, frame.maxY, accuracy: 0.01, name)
            XCTAssertGreaterThanOrEqual(expandedFrame.minY, visibleFrame.minY + 12, name)
        }
    }

    func testNotchCenterUsesBothAuxiliaryAreasInGlobalCoordinates() {
        let frame = NSRect(x: -1512, y: 200, width: 1512, height: 982)
        let geometry = NotchPanel.Geometry.forDisplay(
            frame: frame, visibleFrame: frame, safeAreaTop: 38,
            auxiliaryTopLeftArea: NSRect(x: -1512, y: 1144, width: 650, height: 38),
            auxiliaryTopRightArea: NSRect(x: -650, y: 1144, width: 650, height: 38))
        XCTAssertEqual(geometry.notchWidth, 212)
        XCTAssertEqual(geometry.centerX, -756)
        XCTAssertEqual(geometry.wing, 32)
        XCTAssertEqual(geometry.collapsed, NSSize(width: 276, height: 38))
        XCTAssertEqual(geometry.panelFrame(in: frame, expanded: false),
                       NSRect(x: -894, y: 1144, width: 276, height: 38))
        XCTAssertEqual(geometry.panelFrame(in: frame, expanded: true).midX, -756)
    }

    func testWideNotchKeepsItsWingsAndExpandedWidthBeyondMinimum() {
        let frame = NSRect(x: 0, y: 0, width: 1512, height: 982)
        let geometry = NotchPanel.Geometry.forDisplay(
            frame: frame, visibleFrame: frame, safeAreaTop: 38,
            auxiliaryTopLeftArea: NSRect(x: 0, y: 944, width: 506, height: 38),
            auxiliaryTopRightArea: NSRect(x: 1006, y: 944, width: 506, height: 38))
        XCTAssertEqual(geometry.notchWidth, 500)
        XCTAssertEqual(geometry.collapsed.width, 564)
        XCTAssertEqual(geometry.expanded.width, 924)
    }

    func testMissingAuxiliaryAreasDoNotCreateAnOffCenterNotch() {
        let frame = NSRect(x: -1512, y: 0, width: 1512, height: 982)
        let left = NSRect(x: -1512, y: 944, width: 650, height: 38)
        let right = NSRect(x: -650, y: 944, width: 650, height: 38)
        let cases: [(NSRect?, NSRect?)] = [(nil, nil), (left, nil), (nil, right), (right, left)]
        for (leftArea, rightArea) in cases {
            let geometry = NotchPanel.Geometry.forDisplay(
                frame: frame, visibleFrame: frame, safeAreaTop: 38,
                auxiliaryTopLeftArea: leftArea, auxiliaryTopRightArea: rightArea)
            XCTAssertEqual(geometry.notchWidth, 0)
            XCTAssertEqual(geometry.centerX, frame.midX)
            XCTAssertEqual(geometry.collapsed.width, 120)
            XCTAssertEqual(geometry.expanded.width, 740)
        }
    }

    func testNotchlessDisplayKeepsMinimumBandAndIgnoresAuxiliaryAreas() {
        let frame = NSRect(x: 100, y: 300, width: 1920, height: 1080)
        let geometry = NotchPanel.Geometry.forDisplay(
            frame: frame, visibleFrame: frame, safeAreaTop: 0,
            auxiliaryTopLeftArea: NSRect(x: 100, y: 1356, width: 900, height: 24),
            auxiliaryTopRightArea: NSRect(x: 1120, y: 1356, width: 900, height: 24))
        XCTAssertEqual(geometry.topInset, 24)
        XCTAssertEqual(geometry.notchWidth, 0)
        XCTAssertEqual(geometry.centerX, 1060)
        XCTAssertEqual(geometry.collapsed, NSSize(width: 120, height: 24))
        XCTAssertEqual(geometry.expanded, NSSize(width: 740, height: 584))
    }

    func testVisibleBottomCannotExtendPastPhysicalDisplayBottom() {
        let frame = NSRect(x: 0, y: 300, width: 1280, height: 600)
        let geometry = NotchPanel.Geometry.forDisplay(
            frame: frame, visibleFrame: NSRect(x: 0, y: 200, width: 1280, height: 662), safeAreaTop: 38)
        XCTAssertEqual(geometry.expanded.height, 588)
        XCTAssertEqual(geometry.panelFrame(in: frame, expanded: true).minY, frame.minY + 12)
    }
}
