import XCTest
@testable import TokenHorizon

/// Contract tests for the locked process snapshot: the off-main /processes
/// path must observe exactly what the main thread stored (no torn reads).
/// Thread-safety itself is enforced by TSan (`task test-race`); these pin
/// the store/snapshot wiring deterministically on one thread.
final class ProcessSnapshotTests: XCTestCase {

    private func proc(_ pid: Int32) -> ProcSample {
        ProcSample(pid: pid, ppid: 1, name: "n", command: "c", user: "u",
                   threads: 1, cpu: 1, memMB: 2, diskReadMBps: 0, diskWriteMBps: 0,
                   netInKBps: 0, netOutKBps: 0, startTime: Date())
    }

    func testSnapshotStartsEmpty() {
        let snap = UIModel().processSnapshot()
        XCTAssertTrue(snap.all.isEmpty)
        XCTAssertTrue(snap.byCPU.isEmpty)
        XCTAssertTrue(snap.byMem.isEmpty)
        XCTAssertTrue(snap.byDisk.isEmpty)
        XCTAssertTrue(snap.byNet.isEmpty)
    }

    func testStoreSnapshotRoundTrip() {
        let model = UIModel()
        let p = proc(7)
        model.storeProcesses(all: [p], byCPU: [p], byMem: [], byDisk: [p], byNet: [])
        let snap = model.processSnapshot()
        XCTAssertEqual(snap.all.count, 1)
        XCTAssertEqual(snap.all.first?.pid, 7)
        XCTAssertEqual(snap.byCPU.count, 1)
        XCTAssertTrue(snap.byMem.isEmpty)
        XCTAssertEqual(snap.byDisk.count, 1)
        XCTAssertTrue(snap.byNet.isEmpty)
        // Published vars mirror the store so existing views keep working.
        XCTAssertEqual(model.allProcesses.count, 1)
        XCTAssertEqual(model.processes.count, 1)
    }

    func testStoreOverwrites() {
        let model = UIModel()
        model.storeProcesses(all: [proc(1)], byCPU: [proc(1)], byMem: [], byDisk: [], byNet: [])
        model.storeProcesses(all: [], byCPU: [], byMem: [], byDisk: [], byNet: [])
        XCTAssertTrue(model.processSnapshot().all.isEmpty)
    }
}
