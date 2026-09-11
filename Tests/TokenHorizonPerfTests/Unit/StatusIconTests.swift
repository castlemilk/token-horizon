import XCTest
@testable import TokenHorizon

/// Headless render checks for the menu-bar rings icon (bitmap contexts need
/// no display). Guards size/contract, not pixels.
final class StatusIconTests: XCTestCase {

    func testImage_hasExpectedSizeAndRepresentation() {
        let img = StatusIcon.image(cpuPercent: 37.5, memPercent: 82)
        XCTAssertEqual(img.size.width, 46)
        XCTAssertEqual(img.size.height, 22)
        XCTAssertFalse(img.representations.isEmpty)
    }

    func testImage_handlesEdgeValuesWithoutCrashing() {
        for (cpu, mem) in [(0.0, 0.0), (100.0, 100.0), (250.0, -10.0), (0.005, 0.004)] {
            let img = StatusIcon.image(cpuPercent: cpu, memPercent: mem)
            XCTAssertEqual(img.size.width, 46)
        }
    }
}
