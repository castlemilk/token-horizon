import XCTest
@testable import TokenHorizon

/// Tests for chart math (color scales, clamping, bar heights, tool ranking).
/// Pure value logic extracted from view bodies; bodies themselves need UI tests.
final class ChartMathTests: XCTestCase {

    func testHeatColor() {
        let grid = HeatmapGrid(points: [], maxTokens: 100)
        XCTAssertEqual(grid.heatColor(level: 0), .green.opacity(0.22))
        // Same expression as the implementation (bitwise identical).
        XCTAssertEqual(grid.heatColor(level: 1), .green.opacity(0.22 + 0.78))
    }

    func testCellColor() {
        let grid = HeatmapGrid(points: [], maxTokens: 100)
        XCTAssertEqual(grid.cellColor(0), .white.opacity(0.06))
        // Full ratio saturates to the top of the scale.
        XCTAssertEqual(grid.cellColor(100), grid.heatColor(level: 1))
        // Monotonic in between.
        XCTAssertNotEqual(grid.cellColor(10), grid.cellColor(50))
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
        let grid = HeatmapGrid(points: [], maxTokens: 100)
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
