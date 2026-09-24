import XCTest
@testable import TokenHorizon

/// Headless render checks for the menu-bar rings icon (bitmap contexts need
/// no display). Guards size/contract, not pixels.
final class StatusIconTests: XCTestCase {

    func testImage_hasExpectedSizeAndRepresentation() {
        // Compact concentric gauge sized to the menu bar — must stay small
        // enough not to overflow/clips on crowded bars (was 46x22).
        let img = StatusIcon.image(cpuPercent: 37.5, memPercent: 82)
        XCTAssertEqual(img.size.width, 22)
        XCTAssertEqual(img.size.height, 22)
        XCTAssertFalse(img.representations.isEmpty)
    }

    func testImage_handlesEdgeValuesWithoutCrashing() {
        for (cpu, mem) in [(0.0, 0.0), (100.0, 100.0), (250.0, -10.0), (0.005, 0.004)] {
            let img = StatusIcon.image(cpuPercent: cpu, memPercent: mem)
            XCTAssertEqual(img.size.width, 22)
        }
    }
}
