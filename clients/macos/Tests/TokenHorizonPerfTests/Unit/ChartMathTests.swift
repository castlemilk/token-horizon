import XCTest
@testable import TokenHorizon

/// Tests for chart math (color scales, clamping, bar heights, tool ranking).
/// Pure value logic extracted from view bodies; bodies themselves need UI tests.
final class ChartMathTests: XCTestCase {

    func testHeatColor() {
        XCTAssertEqual(HeatmapGrid.heatColor(level: 0), .green.opacity(0.22))
        // Same expression as the implementation (bitwise identical).
        XCTAssertEqual(HeatmapGrid.heatColor(level: 1), .green.opacity(0.22 + 0.78))
    }

    func testHeatmapAnchor_isWindowP90WithSmallSampleFallback() {
        // 100 nonzero days: the anchor is the 90th-ranked day.
        let spread = Array(1...100)
        XCTAssertEqual(HeatmapScale.anchor(spread), 90)
        // Fewer than ten active days: the maximum stays the anchor so tiny
        // windows keep absolute meaning instead of inflating one quiet day.
        XCTAssertEqual(HeatmapScale.anchor([10, 20, 30]), 30)
        // Zeros are never anchors, and an empty window has none.
        XCTAssertEqual(HeatmapScale.anchor([0, 0, 5, 0, 40, 60]), 60)
        XCTAssertEqual(HeatmapScale.anchor([0, 0]), 0)
        XCTAssertEqual(HeatmapScale.anchor([]), 0)
    }

    func testHeatmapLevel_sqrtCurveBelowTheAnchor() {
        XCTAssertEqual(HeatmapScale.level(0, anchor: 100), 0)
        XCTAssertEqual(HeatmapScale.level(100, anchor: 100), 1, accuracy: 1e-12)
        XCTAssertEqual(HeatmapScale.level(50, anchor: 100), pow(0.5, 0.45), accuracy: 1e-12)
        XCTAssertEqual(HeatmapScale.level(20, anchor: 100), pow(0.2, 0.45), accuracy: 1e-12)
        // Spikes clamp: overshoot magnitude is spikeIntensity's job.
        XCTAssertEqual(HeatmapScale.level(1_000, anchor: 100), 1, accuracy: 1e-12)
        XCTAssertEqual(HeatmapScale.level(50, anchor: 0), 0)
    }

    func testHeatmapSpikeIntensity_growsWithOvershootAndClamps() {
        XCTAssertEqual(HeatmapScale.spikeIntensity(100, anchor: 100), 0, accuracy: 1e-12)
        XCTAssertEqual(HeatmapScale.spikeIntensity(250, anchor: 100), 0.5, accuracy: 1e-12)
        XCTAssertEqual(HeatmapScale.spikeIntensity(400, anchor: 100), 1, accuracy: 1e-12)
        XCTAssertEqual(HeatmapScale.spikeIntensity(4_000, anchor: 100), 1, accuracy: 1e-12)
        XCTAssertEqual(HeatmapScale.spikeIntensity(99, anchor: 100), 0, accuracy: 1e-12)
    }

    func testCellColor_relativeScaleAndSpikeOverdrive() {
        // Quiet days stay dim; zero is the empty cell color.
        XCTAssertEqual(HeatmapGrid.cellColor(0, anchor: 100), .white.opacity(0.06))
        XCTAssertEqual(HeatmapGrid.cellColor(5, anchor: 100),
                       HeatmapGrid.heatColor(level: HeatmapScale.level(5, anchor: 100)))
        // Monotonic below the anchor.
        XCTAssertNotEqual(HeatmapGrid.cellColor(10, anchor: 100), HeatmapGrid.cellColor(50, anchor: 100))
        // At/above the anchor cells leave the ramp for the hotter spike tint.
        XCTAssertEqual(HeatmapGrid.cellColor(100, anchor: 100), HeatmapGrid.spikeColor(0))
        XCTAssertNotEqual(HeatmapGrid.cellColor(100, anchor: 100), HeatmapGrid.heatColor(level: 1))
        XCTAssertEqual(HeatmapGrid.cellColor(400, anchor: 100), HeatmapGrid.spikeColor(1))
        // A zero anchor can never divide: nonzero tokens stay on the plain ramp.
        XCTAssertEqual(HeatmapGrid.cellColor(7, anchor: 0), HeatmapGrid.heatColor(level: 0))
    }

    func testWeekColumnsUseMondayRowsAndPreserveLeadingEmptyDays() {
        let wednesday = point(year: 2026, month: 9, day: 30)
        let thursday = point(year: 2026, month: 10, day: 1)
        let columns = HeatmapGrid.weekColumns([thursday, wednesday], calendar: calendar)
        XCTAssertEqual(columns.count, 1)
        XCTAssertEqual(columns[0].count, 7)
        XCTAssertNil(columns[0][0])
        XCTAssertNil(columns[0][1])
        XCTAssertEqual(columns[0][2]?.day, wednesday.day)
        XCTAssertEqual(columns[0][3]?.day, thursday.day)
        XCTAssertTrue(columns[0].suffix(3).allSatisfy { $0 == nil })
    }

    func testWeekColumnsKeepMissingDaysAndWeeksInTheirCalendarPositions() {
        let first = point(year: 2026, month: 9, day: 30, tokens: 0)
        let last = point(year: 2026, month: 10, day: 14)
        let columns = HeatmapGrid.weekColumns([last, first], calendar: calendar)
        XCTAssertEqual(columns.count, 3)
        XCTAssertEqual(columns[0][2]?.day, first.day)
        XCTAssertEqual(columns[0][2]?.tokens, 0)
        XCTAssertTrue(columns[1].allSatisfy { $0 == nil })
        XCTAssertEqual(columns[2][2]?.day, last.day)
        XCTAssertEqual(columns.flatMap { $0 }.compactMap { $0 }.count, 2)
    }

    func testMonthLabelsDoNotRepeatAfterEmptyWeeksAndDistinguishYears() {
        let empty = [HistoryPoint?](repeating: nil, count: 7)
        let columns = [
            column(point(year: 2025, month: 12, day: 15)), empty,
            column(point(year: 2025, month: 12, day: 29)),
            column(point(year: 2026, month: 1, day: 5)), empty,
            column(point(year: 2026, month: 1, day: 19))
        ]
        let labels = HeatmapGrid.monthLabels(columns, calendar: calendar)
        XCTAssertEqual(labels.map { $0.column }, [0, 3])
        XCTAssertNotEqual(labels.first?.title, labels.last?.title)

        // Two sparse Decembers inside one trailing year still need distinct
        // labels, even though their abbreviated month names are the same.
        let sparse = HeatmapGrid.weekColumns([
            point(year: 2025, month: 12, day: 31), point(year: 2026, month: 12, day: 1)
        ], calendar: calendar)
        let sparseLabels = HeatmapGrid.monthLabels(sparse, calendar: calendar)
        XCTAssertEqual(sparseLabels.count, 2)
        XCTAssertEqual(sparseLabels.first?.title, sparseLabels.last?.title)
        XCTAssertNotEqual(sparseLabels.first?.column, sparseLabels.last?.column)
    }

    func testBarHeight() {
        let view = StackedTrends(points: [])
        XCTAssertEqual(view.barHeight(100, 100, container: 200), 196, accuracy: 1e-9)
        XCTAssertEqual(view.barHeight(0, 100, container: 200), 1.5, accuracy: 1e-9)
        XCTAssertEqual(view.barHeight(25, 100, container: 200), 98, accuracy: 1e-9)
    }

    func testHeatmapTooltipStaysInsideCompactAndExpandedCalendars() {
        let grid = HeatmapGrid(points: [])
        for width in [CGFloat(280), 430] {
            XCTAssertEqual(grid.tooltipX(column: 0, width: width), 0)
            XCTAssertEqual(grid.tooltipX(column: 100, width: width), width - 158)
            // Column 10: one 26 pt weekday gutter + 10 pitches of 8.5 pt
            // + the 3.5 pt cell half-width - the 79 pt bubble half-width.
            XCTAssertEqual(grid.tooltipX(column: 10, width: width), 35.5, accuracy: 0.000001)
            for column in -1...100 {
                let x = grid.tooltipX(column: column, width: width)
                XCTAssertGreaterThanOrEqual(x, 0)
                XCTAssertLessThanOrEqual(x, width - 158)
            }
        }
    }

    func testSortedTools() {
        let view = StackedTrends(points: [])
        let p = HistoryPoint(day: 1, tokens: 14, cost: 0, byTool: ["a": 5, "b": 0, "c": 9])
        XCTAssertEqual(view.sortedTools(p).map { $0.0 }, ["c", "a"])
        XCTAssertEqual(view.sortedTools(p).map { $0.1 }, [9, 5])
    }

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        calendar.firstWeekday = 1 // Monday alignment is independent of locale.
        return calendar
    }

    private func point(year: Int, month: Int, day: Int, tokens: Int = 100) -> HistoryPoint {
        let date = calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
        return HistoryPoint(day: Int(date.timeIntervalSince1970), tokens: tokens, cost: 0, byTool: [:])
    }

    private func column(_ point: HistoryPoint) -> [HistoryPoint?] {
        [point] + [HistoryPoint?](repeating: nil, count: 6)
    }
}
