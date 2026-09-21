import XCTest
@testable import TokenHorizon

/// Hardware-fit matrix and eligibility for the local inference engine.
/// Pure-logic checks — machines are synthetic, no real hardware probing.
final class HardwareProfileTests: XCTestCase {

    private func machine(_ name: String, _ ramGB: Double,
                         major: Int = 26, minor: Int = 5) -> HardwareProfile.Machine {
        HardwareProfile.Machine(
            chipName: name, physicalMemoryGB: ramGB,
            macosMajor: major, macosMinor: minor,
            chipGeneration: HardwareProfile.chipGeneration(from: name),
            chipTier: HardwareProfile.chipTier(from: name))
    }

    func testChipParsing() {
        XCTAssertEqual(HardwareProfile.chipGeneration(from: "Apple M5 Max"), 5)
        XCTAssertEqual(HardwareProfile.chipGeneration(from: "Apple M3"), 3)
        XCTAssertEqual(HardwareProfile.chipGeneration(from: "Apple M1 Pro"), 1)
        XCTAssertEqual(HardwareProfile.chipGeneration(from: "Intel"), 0)
        XCTAssertEqual(HardwareProfile.chipTier(from: "Apple M5 Max"), .max)
        XCTAssertEqual(HardwareProfile.chipTier(from: "Apple M4 Pro"), .pro)
        XCTAssertEqual(HardwareProfile.chipTier(from: "Apple M3 Ultra"), .ultra)
        XCTAssertEqual(HardwareProfile.chipTier(from: "Apple M4"), .base)
    }

    func testEligibility() {
        XCTAssertNil(HardwareProfile.eligibilityBlocker(machine("Apple M5 Max", 128)))
        XCTAssertNil(HardwareProfile.eligibilityBlocker(machine("Apple M3", 36)))
        XCTAssertNotNil(HardwareProfile.eligibilityBlocker(machine("Apple M2", 64)))   // too old
        XCTAssertNotNil(HardwareProfile.eligibilityBlocker(machine("Apple M4", 32)))   // too little RAM
        XCTAssertNotNil(HardwareProfile.eligibilityBlocker(
            machine("Apple M5", 64, major: 26, minor: 3)))                             // macOS < 26.4
        XCTAssertNil(HardwareProfile.eligibilityBlocker(
            machine("Apple M4", 48, major: 27, minor: 0)))                             // future OS fine
    }

    func testFitTiers() {
        let dense = HardwareProfile.catalog.first { $0.id.contains("27B") }!
        XCTAssertEqual(HardwareProfile.fit(dense, on: machine("Apple M5 Max", 128)), .generous)
        XCTAssertEqual(HardwareProfile.fit(dense, on: machine("Apple M4 Pro", 48)), .comfortable)
        XCTAssertEqual(HardwareProfile.fit(dense, on: machine("Apple M3", 36)), .tight)
        XCTAssertEqual(HardwareProfile.fit(dense, on: machine("Apple M2", 64)), .unsupported)
        XCTAssertEqual(HardwareProfile.fit(dense, on: machine("Apple M5", 24)), .unsupported)
    }

    func testCeilingsStayInsideRAM() {
        let dense = HardwareProfile.catalog.first { $0.id.contains("27B") }!
        for ram in [36.0, 48.0, 64.0, 96.0, 128.0] {
            let c = HardwareProfile.recommendedCeilings(dense, on: machine("Apple M5", ram))
            XCTAssertGreaterThan(c.maxMemoryGB, Int(dense.residentGB), "ram=\(ram)")
            XCTAssertLessThan(c.maxMemoryGB, Int(ram), "budget must leave headroom")
            XCTAssertTrue([32, 128].contains(c.maxContextK))
        }
    }
}
