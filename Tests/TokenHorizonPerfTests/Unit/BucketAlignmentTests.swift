import XCTest
@testable import TokenHorizon

/// Regression tests for hourly-bucket time math. Buckets are UTC-hour
/// aligned while windows start at LOCAL midnight: matching must be by RANGE
/// (`hour >= from && hour < to`), never by striding exact keys — striding
/// silently drops every bucket in non-whole-hour zones and on DST days.
/// Calendar-day bounds must stay contiguous across DST transitions.
final class BucketAlignmentTests: XCTestCase {

    private func eng() -> UsageEngine { UsageEngine() }

    func testAggregate_countsMisalignedBucketsByRange() {
        // Keys on :00, :15 and :45 past the hour must ALL count.
        let merged: [Int: [String: (t: Int, c: Double)]] = [
            0: ["claude": (100, 1.0)],
            900: ["kimi": (50, 0.5)],
            3600 + 2700: ["kimi": (25, 0.25)],
            7199: ["codex": (10, 0.0)],
            7200: ["codex": (999, 0.0)],
        ]
        let p = eng().aggregate(merged, from: 0, to: 7200)
        XCTAssertEqual(p.tokens, 185)
        XCTAssertEqual(p.cost, 1.75, accuracy: 1e-9)
        XCTAssertEqual(p.byTool, ["claude": 100, "kimi": 75, "codex": 10])
        XCTAssertEqual(p.day, 0)
    }

    func testAggregate_boundaries() {
        let merged: [Int: [String: (t: Int, c: Double)]] = [
            100: ["a": (1, 0)],
            200: ["a": (2, 0)],
        ]
        // from inclusive, to exclusive.
        XCTAssertEqual(eng().aggregate(merged, from: 100, to: 200).tokens, 1)
        XCTAssertEqual(eng().aggregate(merged, from: 0, to: 1000).tokens, 3)
    }

    func testAggregate_empty() {
        let p = eng().aggregate([:], from: 0, to: 86_400)
        XCTAssertEqual(p.tokens, 0)
        XCTAssertEqual(p.cost, 0)
        XCTAssertTrue(p.byTool.isEmpty)
    }

    func testDayTokens_matchesAggregate() {
        let merged: [Int: [String: (t: Int, c: Double)]] = [
            3_600: ["a": (10, 0.5)],
            3_600 + 1_800: ["b": (5, 0.25)],
            90_000: ["a": (1000, 0)],
        ]
        XCTAssertEqual(eng().dayTokens(merged, 0), 15)
    }

    func testDailyBounds_contiguousInUTC() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let today = Int(utc.startOfDay(for: Date()).timeIntervalSince1970)
        let bounds = UsageEngine.dailyAlignedBounds(count: 7, today: today, calendar: utc)
        XCTAssertEqual(bounds.count, 7)
        for i in 0..<6 {
            XCTAssertEqual(bounds[i].end, bounds[i + 1].start, "gap at \(i)")
            XCTAssertEqual(bounds[i].end - bounds[i].start, 86_400)
        }
        for b in bounds {
            let comps = utc.dateComponents([.hour, .minute, .second],
                                           from: Date(timeIntervalSince1970: TimeInterval(b.start)))
            XCTAssertEqual(comps.hour, 0)
            XCTAssertEqual(comps.minute, 0)
            XCTAssertEqual(comps.second, 0)
        }
    }

    func testDailyBounds_springForwardIs23Hours() {
        // US DST 2026: clocks jump Mar 8 02:00 -> 03:00 (23-hour day).
        var nyc = Calendar(identifier: .gregorian)
        nyc.timeZone = TimeZone(identifier: "America/New_York")!
        let mar9noon = nyc.date(from: DateComponents(year: 2026, month: 3, day: 9, hour: 12))!
        let today = Int(nyc.startOfDay(for: mar9noon).timeIntervalSince1970)
        let bounds = UsageEngine.dailyAlignedBounds(count: 3, today: today, calendar: nyc)
        XCTAssertEqual(bounds.count, 3)
        XCTAssertEqual(bounds[0].end - bounds[0].start, 86_400) // Mar 7
        XCTAssertEqual(bounds[1].end - bounds[1].start, 23 * 3600) // Mar 8
        XCTAssertEqual(bounds[2].end - bounds[2].start, 86_400) // Mar 9
        XCTAssertEqual(bounds[0].end, bounds[1].start)
        XCTAssertEqual(bounds[1].end, bounds[2].start)
    }

    func testDailyBounds_fallBackIs25Hours() {
        // US DST 2026: clocks fall back Nov 1 02:00 -> 01:00 (25-hour day).
        var nyc = Calendar(identifier: .gregorian)
        nyc.timeZone = TimeZone(identifier: "America/New_York")!
        let nov2noon = nyc.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 12))!
        let today = Int(nyc.startOfDay(for: nov2noon).timeIntervalSince1970)
        let bounds = UsageEngine.dailyAlignedBounds(count: 3, today: today, calendar: nyc)
        XCTAssertEqual(bounds[1].end - bounds[1].start, 25 * 3600) // Nov 1
        XCTAssertEqual(bounds[0].end, bounds[1].start)
        XCTAssertEqual(bounds[1].end, bounds[2].start)
    }

    func testDailyBounds_empty() {
        XCTAssertTrue(UsageEngine.dailyAlignedBounds(count: 0, today: 0).isEmpty)
    }

    // MARK: - streakDays

    func testStreakDays() {
        // Sparse map: day 0, -1d, -2d active; -3d gap; -4d, -5d active.
        let d = 86_400
        let active: Set<Int> = [0, -1, -2, -4, -5].map { $0 * d }.reduce(into: Set()) { $0.insert($1) }
        XCTAssertEqual(UsageEngine.streakDays(today: 0) { active.contains($0) ? 10 : 0 }, 3)
        // Grace rule: today empty, yesterday active → counts from yesterday.
        let grace: Set<Int> = [-1, -2].map { $0 * d }.reduce(into: Set()) { $0.insert($1) }
        XCTAssertEqual(UsageEngine.streakDays(today: 0) { grace.contains($0) ? 10 : 0 }, 2)
        // Everything empty → 0 (cursor steps back once, then stops).
        XCTAssertEqual(UsageEngine.streakDays(today: 0) { _ in 0 }, 0)
        // Single active today only.
        XCTAssertEqual(UsageEngine.streakDays(today: 0) { $0 == 0 ? 5 : 0 }, 1)
        // Long streaks terminate (400 consecutive days).
        let long = Set((0...399).map { -$0 * d })
        XCTAssertEqual(UsageEngine.streakDays(today: 0) { long.contains($0) ? 1 : 0 }, 400)
    }
}
