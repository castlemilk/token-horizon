import XCTest
@testable import TokenHorizon

/// Tests for rolling-series math: MLXHistory windows/rollups, UIModel CPU
/// series windows and MLX peaks, and the window enums. Hermetic throughout.
final class MLXSeriesTests: XCTestCase {

    private func proc(cpu: Double, mem: Double, tok: Double?) -> MLXProcess {
        MLXProcess(pid: 1, ppid: 0, name: "r", command: "--mlx-engine", model: "m",
                   cpu: cpu, memoryMB: mem, diskReadMBps: 1, diskWriteMBps: 2,
                   startTime: Date(), tokPerSec: tok)
    }

    private func snap(at date: Date, cpu: Double, mem: Double = 0, tok: Double? = nil) -> MLXSnapshot {
        MLXSnapshot(sampledAt: date, processes: [proc(cpu: cpu, mem: mem, tok: tok)])
    }

    func testWindows() {
        XCTAssertEqual(SysWindow.allCases.count, 5)
        XCTAssertEqual(MLXWindow.allCases.count, 4)
        XCTAssertEqual(SysWindow.m3.points, 90)
        XCTAssertEqual(SysWindow.h24.points, 2880)
        XCTAssertTrue(SysWindow.h24.coarse)
        XCTAssertFalse(SysWindow.h1.coarse)
        XCTAssertTrue(MLXWindow.h24.coarse)
        XCTAssertFalse(MLXWindow.m5.coarse)
        XCTAssertEqual(SysWindow.m3.id, "3M")
        XCTAssertTrue(SysWindow.h1.label.contains("HOUR"))
    }

    func testMLXHistorySeriesMaxAndMeasured() {
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        var h = MLXHistory()
        h.append(snap(at: base, cpu: 10, mem: 100, tok: nil))
        h.append(snap(at: base.addingTimeInterval(2), cpu: 30, mem: 300, tok: 25))
        h.append(snap(at: base.addingTimeInterval(4), cpu: 20, mem: 200, tok: 0))
        XCTAssertEqual(h.cpuSeries(), [10, 30, 20])
        XCTAssertEqual(h.memorySeries(), [100, 300, 200])
        XCTAssertEqual(h.maxCPU(), 30)
        XCTAssertEqual(h.maxMemory(), 300)
        // measuredTokSeries drops nils; maxTok/avgTok ignore zeros.
        XCTAssertEqual(h.measuredTokSeries(), [25, 0])
        XCTAssertEqual(h.maxTok(), 25)
        XCTAssertEqual(h.avgTok(), 25)
        XCTAssertEqual(MLXHistory().avgTok(), 0)
        XCTAssertEqual(MLXHistory().maxCPU(), 0)
    }

    func testMLXHistoryCoarseRollup() {
        // Two samples in one 30s bucket, one in the next: coarse holds means.
        let base = Date(timeIntervalSince1970: 1_700_000_031)
        var h = MLXHistory()
        h.append(snap(at: base, cpu: 10, tok: 10))
        h.append(snap(at: base.addingTimeInterval(5), cpu: 20, tok: 20))
        h.append(snap(at: base.addingTimeInterval(31), cpu: 60, tok: 60))
        XCTAssertEqual(h.cpuSeries(coarse: true).count, 1)
        XCTAssertEqual(h.cpuSeries(coarse: true).first ?? -1, 15, accuracy: 1e-9)
        XCTAssertEqual(h.maxCPU(coarse: true), 15, accuracy: 1e-9)
        XCTAssertEqual(h.measuredTokSeries(coarse: true), [15])
    }

    func testUIModelSeriesWindows() {
        let model = UIModel()
        for i in 0..<20 { model.record(cpu: Double(i), ram: 0, disk: 0, net: 0) }
        model.sysWindow = .m3
        XCTAssertEqual(model.cpuSeries().count, 20)
        XCTAssertEqual(model.ramSeries().count, 20)
        // Coarse windows read the coarse series (empty: no recordCoarse ran).
        model.sysWindow = .h24
        XCTAssertEqual(model.cpuSeries().count, 0)
    }

    func testUIModelMLXPeaks() {
        let model = UIModel()
        XCTAssertEqual(model.mlxPeakCPU(.m5), 0)
        XCTAssertEqual(model.mlxAvgTok(.m5), 0)
        model.recordMLX(snap(at: Date(), cpu: 40, mem: 500, tok: 30))
        model.recordMLX(snap(at: Date(), cpu: 80, mem: 100, tok: 0))
        XCTAssertEqual(model.mlxPeakCPU(.m5), 80)
        XCTAssertEqual(model.mlxPeakMemory(.m5), 500)
        XCTAssertEqual(model.mlxPeakDisk(.m5), 3)
        XCTAssertEqual(model.mlxPeakTok(.m5), 30)
        XCTAssertEqual(model.mlxAvgTok(.m5), 30)
        XCTAssertFalse(model.mlxCPUHistory.isEmpty)
        XCTAssertFalse(model.mlxTokHistory.isEmpty)
    }
}
