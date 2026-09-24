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

    func testTooltipXClamps() {
        let grid = HeatmapGrid(points: [], maxTokens: 1)
        XCTAssertEqual(grid.tooltipX(col: 0, totalCols: 10), 0)
        XCTAssertEqual(grid.tooltipX(col: 29, totalCols: 30), 97, accuracy: 1e-9)
        XCTAssertEqual(grid.tooltipX(col: 15, totalCols: 30), 52, accuracy: 1e-9)
    }

    func testTooltipHeight() {
        let grid = HeatmapGrid(points: [], maxTokens: 1)
        XCTAssertEqual(grid.tooltipHeight(HistoryPoint(day: 1, tokens: 5, cost: 0, byTool: [:])), 58)
        XCTAssertEqual(grid.tooltipHeight(HistoryPoint(day: 1, tokens: 0, cost: 0, byTool: [:])), 40)
    }

    func testBarHeight() {
        let view = StackedTrends(points: [])
        XCTAssertEqual(view.barHeight(100, 100, container: 200), 196, accuracy: 1e-9)
        XCTAssertEqual(view.barHeight(0, 100, container: 200), 1.5, accuracy: 1e-9)
        XCTAssertEqual(view.barHeight(25, 100, container: 200), 98, accuracy: 1e-9)
    }

    func testSortedTools() {
        let view = StackedTrends(points: [])
        let p = HistoryPoint(day: 1, tokens: 14, cost: 0, byTool: ["a": 5, "b": 0, "c": 9])
        XCTAssertEqual(view.sortedTools(p).map { $0.0 }, ["c", "a"])
        XCTAssertEqual(view.sortedTools(p).map { $0.1 }, [9, 5])
    }
}
