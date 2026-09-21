import XCTest
@testable import TokenHorizon

final class ProcessMetricsTests: XCTestCase {
    func testProcessSamples_returnsAllProcessesAndTopLists() {
        let result = SystemStats.processSamples()

        XCTAssertFalse(result.all.isEmpty, "process sampling should return at least one process")
        XCTAssertLessThanOrEqual(result.byCPU.count, 8)
        XCTAssertLessThanOrEqual(result.byMem.count, 8)
        XCTAssertLessThanOrEqual(result.byDisk.count, 8)
        XCTAssertLessThanOrEqual(result.byNet.count, 8)
        XCTAssertEqual(result.byCPU.first?.pid, result.all.max(by: { $0.cpu < $1.cpu })?.pid)
        XCTAssertEqual(result.byDisk, result.byDisk.sorted { ($0.diskReadMBps + $0.diskWriteMBps) > ($1.diskReadMBps + $1.diskWriteMBps) })
        XCTAssertEqual(result.byNet, result.byNet.sorted { ($0.netInKBps + $0.netOutKBps) > ($1.netInKBps + $1.netOutKBps) })

        for process in result.all {
            XCTAssertGreaterThanOrEqual(process.cpu, 0)
            XCTAssertGreaterThanOrEqual(process.memMB, 0)
            XCTAssertGreaterThanOrEqual(process.diskReadMBps, 0)
            XCTAssertGreaterThanOrEqual(process.diskWriteMBps, 0)
            XCTAssertGreaterThanOrEqual(process.netInKBps, 0)
            XCTAssertGreaterThanOrEqual(process.netOutKBps, 0)
        }
    }

    func testProcessSamples_staysWithinRefreshBudget() {
        let start = DispatchTime.now()
        _ = SystemStats.processSamples()
        let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000

        // This runs only while the notch is open, but must remain well below the
        // 5-second refresh interval even on a loaded development machine.
        XCTAssertLessThan(elapsedMs, 1000, "process sampling took \(elapsedMs)ms")
    }
}
