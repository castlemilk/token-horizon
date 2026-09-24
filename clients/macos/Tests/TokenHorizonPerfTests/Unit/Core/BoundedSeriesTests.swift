import XCTest
@testable import TokenHorizon

/// Table-driven tests for `BoundedSeries` — one test function per behavior,
/// cases as data rows (the Go table-driven analogue: add a row, not a copy-
/// pasted test function, when behavior grows).
final class BoundedSeriesTests: XCTestCase {

    func testAppend_capsAtCapacity_dropsOldestFirst() {
        struct Case {
            let capacity: Int
            let appended: [Int]
            let want: [Int]
        }
        let cases: [Case] = [
            Case(capacity: 3, appended: [], want: []),
            Case(capacity: 3, appended: [1], want: [1]),
            Case(capacity: 3, appended: [1, 2, 3], want: [1, 2, 3]),
            Case(capacity: 3, appended: [1, 2, 3, 4], want: [2, 3, 4]),
            Case(capacity: 3, appended: [1, 2, 3, 4, 5, 6], want: [4, 5, 6]),
            Case(capacity: 1, appended: [7, 8], want: [8]),
            Case(capacity: 1800, appended: Array(0..<5_000), want: Array(3_200..<5_000)),
        ]
        for (index, tc) in cases.enumerated() {
            var series = BoundedSeries<Int>(capacity: tc.capacity)
            series.append(contentsOf: tc.appended)
            XCTAssertEqual(series.values, tc.want, "case \(index) (capacity \(tc.capacity))")
            XCTAssertEqual(series.count, tc.want.count, "case \(index) count")
        }
    }

    func testAppend_bulkOverfill_keepsOnlyNewest() {
        var series = BoundedSeries<String>(capacity: 2)
        series.append(contentsOf: ["a", "b", "c", "d"])
        XCTAssertEqual(series.values, ["c", "d"])
        XCTAssertEqual(series.oldest, "c")
        XCTAssertEqual(series.newest, "d")
    }

    func testEmpty_exposesNilEndsAndZeroAverage() {
        let series = BoundedSeries<Double>(capacity: 10)
        XCTAssertTrue(series.isEmpty)
        XCTAssertNil(series.oldest)
        XCTAssertNil(series.newest)
        XCTAssertEqual(series.averageOfLast(15), 0)
        XCTAssertEqual(series.suffix(5), [])
    }

    func testAverageOfLast_matchesUIModelCoarseRollup() {
        // UIModel.recordCoarse averages the last 15 fine samples; this is the
        // same math through the shared type. 0..<15 averages to 7.
        var series = BoundedSeries<Double>(capacity: 1_800)
        series.append(contentsOf: (0..<15).map(Double.init))
        XCTAssertEqual(series.averageOfLast(15), 7)
        // Partial window: average of what exists (matches suffix(n) behavior).
        XCTAssertEqual(series.averageOfLast(30), 7)
        // Narrower window: last 5 of 0..<15 -> 10+11+12+13+14 = 60 / 5 = 12.
        XCTAssertEqual(series.averageOfLast(5), 12)
    }

    func testRemoveAll_resetsToEmpty() {
        var series = BoundedSeries<Int>(capacity: 4)
        series.append(contentsOf: [1, 2, 3])
        series.removeAll()
        XCTAssertTrue(series.isEmpty)
        XCTAssertEqual(series.values, [])
        series.append(9)
        XCTAssertEqual(series.values, [9])
    }
}
