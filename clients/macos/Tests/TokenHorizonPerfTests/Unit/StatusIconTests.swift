import XCTest
@testable import TokenHorizon

/// Headless render checks for the menu-bar rings icon. Guards size/contract,
/// not pixels. 18pt is the conventional menu-bar glyph size — a nearly
/// bar-height image bleeds to the slot edges and reads as clipped.
final class StatusIconTests: XCTestCase {

    func testImage_hasExpectedSizeAndRepresentation() {
        let img = StatusIcon.image(cpuPercent: 37.5, memPercent: 82)
        XCTAssertEqual(img.size.width, StatusIcon.glyphSize)
        XCTAssertEqual(img.size.height, StatusIcon.glyphSize)
        // Drawing-handler image — resolution-independent, no baked bitmap.
        XCTAssertFalse(img.representations.isEmpty)
    }

    func testImage_handlesEdgeValuesWithoutCrashing() {
        for (cpu, mem) in [(0.0, 0.0), (100.0, 100.0), (250.0, -10.0), (0.005, 0.004)] {
            let img = StatusIcon.image(cpuPercent: cpu, memPercent: mem)
            XCTAssertEqual(img.size.width, StatusIcon.glyphSize)
        }
    }
}
