import XCTest
import CoreGraphics
@testable import TokenHorizon

final class ChartStackLayoutTests: XCTestCase {
    private let chart = StackedTrends(points: [])

    func testEqualProvidersShareOneScaledBar() {
        let point = HistoryPoint(day: 0, tokens: 100, cost: 0, byTool: ["codex": 50, "claude": 50])
        let segments = chart.segmentHeights(point, maxTotal: 100, container: 80)
        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(height("codex", in: segments), height("claude", in: segments), accuracy: 0.000001)
        XCTAssertEqual(segments.reduce(0) { $0 + $1.1 }, chart.barHeight(100, 100, container: 80), accuracy: 0.000001)
        assertBounded(segments, container: 80)
    }

    func testManySmallProvidersDoNotMultiplyTheMinimumBarHeight() {
        let providers = Dictionary(uniqueKeysWithValues: (0..<100).map { ("provider-\($0)", 1) })
        let point = HistoryPoint(day: 0, tokens: 100, cost: 0, byTool: providers)
        let segments = chart.segmentHeights(point, maxTotal: 100, container: 80)
        XCTAssertEqual(segments.count, 100)
        XCTAssertTrue(segments.allSatisfy { $0.1 < 1.5 })
        XCTAssertEqual(segments.reduce(0) { $0 + $1.1 }, chart.barHeight(100, 100, container: 80), accuracy: 0.000001)
        assertBounded(segments, container: 80)
    }

    func testMissingBreakdownIsRepresentedByOther() {
        let point = HistoryPoint(day: 0, tokens: 100, cost: 0, byTool: ["codex": 40])
        let segments = chart.segmentHeights(point, maxTotal: 100, container: 104)
        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(height("codex", in: segments), 40, accuracy: 0.000001)
        XCTAssertEqual(height("other", in: segments), 60, accuracy: 0.000001)
        assertBounded(segments, container: 104)
    }

    func testMissingBreakdownMergesWithExistingOther() {
        let point = HistoryPoint(day: 0, tokens: 100, cost: 0, byTool: ["codex": 40, "other": 20])
        let segments = chart.segmentHeights(point, maxTotal: 100, container: 104)
        XCTAssertEqual(segments.filter { $0.0 == "other" }.count, 1)
        XCTAssertEqual(height("other", in: segments), 60, accuracy: 0.000001)
        XCTAssertEqual(height("codex", in: segments), 40, accuracy: 0.000001)
        assertBounded(segments, container: 104)
    }

    func testOverReportedBreakdownKeepsSharesInsideReportedTotalBar() {
        let point = HistoryPoint(day: 0, tokens: 100, cost: 0, byTool: ["codex": 100, "claude": 50])
        let segments = chart.segmentHeights(point, maxTotal: 100, container: 104)
        XCTAssertEqual(height("codex", in: segments), 100 * 2.0 / 3, accuracy: 0.000001)
        XCTAssertEqual(height("claude", in: segments), 100 / 3.0, accuracy: 0.000001)
        XCTAssertFalse(segments.contains { $0.0 == "other" })
        assertBounded(segments, container: 104)
    }

    func testEmptyOrNonpositiveBreakdownStillShowsPositiveTotal() {
        for byTool in [[:], ["codex": -50, "claude": 0]] {
            let point = HistoryPoint(day: 0, tokens: 100, cost: 0, byTool: byTool)
            let segments = chart.segmentHeights(point, maxTotal: 100, container: 104)
            XCTAssertEqual(segments.count, 1)
            XCTAssertEqual(segments.first?.0, "other")
            XCTAssertEqual(height("other", in: segments), 100, accuracy: 0.000001)
            assertBounded(segments, container: 104)
        }
    }

    func testNonpositiveTotalsAndNonfinitePlotHeightsHaveNoSegments() {
        for tokens in [0, -100] {
            let point = HistoryPoint(day: 0, tokens: tokens, cost: 0, byTool: ["codex": 100])
            XCTAssertTrue(chart.segmentHeights(point, maxTotal: 100, container: 80).isEmpty)
        }
        let point = HistoryPoint(day: 0, tokens: 100, cost: 0, byTool: ["codex": 100])
        for container in [CGFloat(0), -80, .nan, .infinity, -.infinity] {
            XCTAssertTrue(chart.segmentHeights(point, maxTotal: 100, container: container).isEmpty)
        }
    }

    func testTinyPlotsAndInvalidPeaksRemainBounded() {
        let point = HistoryPoint(day: 0, tokens: 100, cost: 0, byTool: ["codex": 40, "claude": 60])
        for container in [CGFloat(0), 1, 2, 4, 10, 80] {
            for peak in [-100, 0, 1, 50, 100] {
                assertBounded(chart.segmentHeights(point, maxTotal: peak, container: container), container: container)
                let height = chart.barHeight(100, peak, container: container)
                XCTAssertTrue(height.isFinite)
                XCTAssertGreaterThanOrEqual(height, 0)
                XCTAssertLessThanOrEqual(height, max(0, container))
            }
        }
    }

    func testLargeProviderCountsDoNotOverflowIntegerAccumulation() {
        let point = HistoryPoint(day: 0, tokens: Int.max, cost: 0,
                                 byTool: ["codex": Int.max, "claude": Int.max, "ignored": Int.min])
        let segments = chart.segmentHeights(point, maxTotal: Int.max, container: 80)
        XCTAssertEqual(segments.count, 2)
        assertBounded(segments, container: 80)
        XCTAssertEqual(height("codex", in: segments), height("claude", in: segments), accuracy: 0.000001)
    }

    private func height(_ tool: String, in segments: [(String, CGFloat)]) -> CGFloat {
        segments.filter { $0.0 == tool }.reduce(0) { $0 + $1.1 }
    }

    private func assertBounded(_ segments: [(String, CGFloat)], container: CGFloat,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(Set(segments.map { $0.0 }).count, segments.count, file: file, line: line)
        for segment in segments {
            XCTAssertTrue(segment.1.isFinite, file: file, line: line)
            XCTAssertGreaterThanOrEqual(segment.1, 0, file: file, line: line)
        }
        XCTAssertLessThanOrEqual(segments.reduce(0) { $0 + $1.1 }, max(0, container) + 0.000001,
                                 file: file, line: line)
    }
}
