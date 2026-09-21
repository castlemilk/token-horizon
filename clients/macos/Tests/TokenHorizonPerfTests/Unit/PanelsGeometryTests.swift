import XCTest
@testable import TokenHorizon

/// Tests for NotchPanel geometry math (panel anchoring without a display).
/// Rendering and hover behavior need UI tests; this pins the math.
final class PanelsGeometryTests: XCTestCase {

    func testGeometryWithoutScreen() {
        let geo = NotchPanel.Geometry.forScreen(nil)
        XCTAssertEqual(geo.topInset, 24)
        XCTAssertEqual(geo.notchWidth, 0)
        XCTAssertEqual(geo.centerX, 0)
        XCTAssertEqual(geo.wing, 60)
        XCTAssertEqual(geo.collapsed, NSSize(width: 120, height: 24))
        XCTAssertEqual(geo.expanded, NSSize(width: 740, height: 584))
    }
}
