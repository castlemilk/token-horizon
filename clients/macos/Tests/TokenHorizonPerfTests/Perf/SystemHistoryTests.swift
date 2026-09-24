import XCTest
@testable import TokenHorizon

final class SystemHistoryTests: XCTestCase {
    func testDiskParser_sumsCumulativeDeviceTotals() {
        let output = """
        disk0 disk1
        KB/t xfrs MB KB/t xfrs MB
        12.50 100 123.25 4.00 20 6.75
        """

        XCTAssertEqual(SystemStats.parseDiskTotalMB(Data(output.utf8)), 130, accuracy: 0.0001)
    }

    func testDiskParser_ignoresHeadersAndMalformedRows() {
        let output = """
        disk0
        KB/t xfrs MB
        unavailable data
        8.00 10 2.50
        """

        XCTAssertEqual(SystemStats.parseDiskTotalMB(Data(output.utf8)), 2.5, accuracy: 0.0001)
    }

    func testNetworkParser_extractsPidsAndByteCounters() {
        let output = """
        time,,interface,state,bytes_in,bytes_out
        12:00:00,opencode.123,,,1500,2500
        12:00:00,worker.456,,,0,8192
        12:00:00,malformed,,,not-a-number,4
        """
        let result = SystemStats.parseNetSnapshot(Data(output.utf8))

        XCTAssertEqual(result[123]?.inB, 1500)
        XCTAssertEqual(result[123]?.outB, 2500)
        XCTAssertEqual(result[456]?.inB, 0)
        XCTAssertEqual(result[456]?.outB, 8192)
        XCTAssertNil(result[999])
    }

    func testNetworkParser_returnsEmptyForMissingColumns() {
        let output = "time,,interface,state\n12:00:00,worker.456,,,\n"

        XCTAssertTrue(SystemStats.parseNetSnapshot(Data(output.utf8)).isEmpty)
    }

    func testIORates_areFiniteAndCachedForShortInterval() {
        let now = Date()
        let first = SystemStats.ioRates(now: now)
        let cached = SystemStats.ioRates(now: now.addingTimeInterval(1))

        XCTAssertGreaterThanOrEqual(first.diskMBps, 0)
        XCTAssertGreaterThanOrEqual(first.netMBps, 0)
        XCTAssertTrue(first.diskMBps.isFinite)
        XCTAssertTrue(first.netMBps.isFinite)
        XCTAssertEqual(cached.diskMBps, first.diskMBps)
        XCTAssertEqual(cached.netMBps, first.netMBps)
    }

    func testSnapshot_exposesSystemIORates() {
        let snapshot = SystemStats.snapshot()

        XCTAssertGreaterThanOrEqual(snapshot.diskMBps, 0)
        XCTAssertGreaterThanOrEqual(snapshot.netMBps, 0)
        XCTAssertTrue(snapshot.diskMBps.isFinite)
        XCTAssertTrue(snapshot.netMBps.isFinite)
    }

    func testHistory_isBoundedAndCoarsened() {
        let model = UIModel()

        for index in 0..<5_000 {
            model.record(cpu: Double(index),
                         ram: Double(index),
                         disk: Double(index),
                         net: Double(index))
            model.recordCoarse()
        }

        XCTAssertEqual(model.cpuHistory.count, UIModel.fineLimit)
        XCTAssertEqual(model.ramHistory.count, UIModel.fineLimit)
        XCTAssertEqual(model.diskHistory.count, UIModel.fineLimit)
        XCTAssertEqual(model.netHistory.count, UIModel.fineLimit)
        XCTAssertEqual(model.cpuCoarse.count, 333)
        XCTAssertEqual(model.ramCoarse.count, 333)
        XCTAssertEqual(model.diskCoarse.count, 333)
        XCTAssertEqual(model.netCoarse.count, 333)
        model.sysWindow = .h24
        XCTAssertEqual(model.diskSeries().count, 333)
        XCTAssertEqual(model.netSeries().count, 333)
    }

    func testHistory_coarseValuesAverageFifteenFineSamples() {
        let model = UIModel()

        for index in 0..<15 {
            model.record(cpu: Double(index),
                         ram: Double(index * 2),
                         disk: Double(index * 3),
                         net: Double(index * 4))
            model.recordCoarse()
        }

        XCTAssertEqual(model.cpuCoarse, [7])
        XCTAssertEqual(model.ramCoarse, [14])
        XCTAssertEqual(model.diskCoarse, [21])
        XCTAssertEqual(model.netCoarse, [28])
    }

    func testHistory_discardsSamplesPast24Hours() {
        let model = UIModel()
        let sampleCount = UIModel.coarseLimit * 15 + 15

        for index in 0..<sampleCount {
            model.record(cpu: Double(index),
                         ram: Double(index),
                         disk: Double(index),
                         net: Double(index))
            model.recordCoarse()
        }
        model.sysWindow = .h24

        XCTAssertEqual(model.cpuHistory.count, UIModel.fineLimit)
        XCTAssertEqual(model.ramHistory.count, UIModel.fineLimit)
        XCTAssertEqual(model.diskHistory.count, UIModel.fineLimit)
        XCTAssertEqual(model.netHistory.count, UIModel.fineLimit)
        XCTAssertEqual(model.cpuCoarse.count, UIModel.coarseLimit)
        XCTAssertEqual(model.ramCoarse.count, UIModel.coarseLimit)
        XCTAssertEqual(model.diskCoarse.count, UIModel.coarseLimit)
        XCTAssertEqual(model.netCoarse.count, UIModel.coarseLimit)
        XCTAssertEqual(model.diskSeries().count, UIModel.coarseLimit)
        XCTAssertEqual(model.netSeries().count, UIModel.coarseLimit)
        XCTAssertEqual(model.diskHistory.first, Double(sampleCount - UIModel.fineLimit))
    }
}
