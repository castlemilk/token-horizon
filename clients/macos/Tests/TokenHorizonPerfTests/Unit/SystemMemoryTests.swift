import XCTest
@testable import TokenHorizon

final class SystemMemoryTests: XCTestCase {
    /// Regression: ram_total_gb published as 0 — `totalRAMGB` (already in
    /// GB) was divided by 1 GiB a second time in SystemStats.memory(), so
    /// every MEM% (`used / max(total, 1)`) degenerated to thousands of
    /// percent and the notch MEM ring pinned at 100% permanently.
    func testMemoryTotalIsPhysicalRAMNotDividedTwice() {
        let (used, total) = SystemStats.memory()
        let physical = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824
        XCTAssertEqual(total, physical, accuracy: 0.5,
                       "total must be physical RAM in GB, not re-divided")
        XCTAssertGreaterThanOrEqual(used, 0)
        XCTAssertLessThanOrEqual(used, total * 1.05,
                                 "app+wired+compressed cannot exceed physical (small drift allowed)")
        // What the notch computes — must be a sane percentage.
        let pct = used / max(total, 1) * 100
        XCTAssertGreaterThanOrEqual(pct, 0)
        XCTAssertLessThanOrEqual(pct, 100)
    }
}
