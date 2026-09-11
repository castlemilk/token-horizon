import XCTest
@testable import TokenHorizon

/// Tests for PlanLimitsEngine's pure payload helpers: deep search, number
/// coercion, and Claude OAuth payload parsing (windows, aliases, clamping,
/// reset roll-forward, scoped model rows). Network fetchers stay untested.
final class PlanLimitsParseTests: XCTestCase {

    func testFindObject() {
        let tree: [String: Any] = ["a": ["b": [["c": 42]]], "d": "x"]
        XCTAssertEqual(PlanLimitsEngine.findObject(key: "c", in: tree) as? Int, 42)
        XCTAssertEqual(PlanLimitsEngine.findObject(key: "d", in: tree) as? String, "x")
        XCTAssertNil(PlanLimitsEngine.findObject(key: "missing", in: tree))
        XCTAssertNil(PlanLimitsEngine.findObject(key: "c", in: "scalar"))
        // Depth cap: 9-deep nesting is unreachable (limit 8).
        var deep: Any = ["k": "found"]
        for _ in 0..<10 { deep = ["nest": deep] }
        XCTAssertNil(PlanLimitsEngine.findObject(key: "k", in: deep))
        let shallow: Any = ["nest": ["k": "found"]]
        XCTAssertEqual(PlanLimitsEngine.findObject(key: "k", in: shallow) as? String, "found")
    }

    func testNumber() {
        XCTAssertEqual(PlanLimitsEngine.number(7) ?? -1, 7, accuracy: 1e-9)
        XCTAssertEqual(PlanLimitsEngine.number(2.5) ?? -1, 2.5, accuracy: 1e-9)
        XCTAssertEqual(PlanLimitsEngine.number("3.25") ?? -1, 3.25, accuracy: 1e-9)
        XCTAssertNil(PlanLimitsEngine.number("abc"))
        XCTAssertNil(PlanLimitsEngine.number(nil))
    }

    func testParseClaudePayload_windowsAndAliases() {
        let future = Date().addingTimeInterval(3600).timeIntervalSince1970
        let obj: [String: Any] = [
            "five_hour": ["utilization": 25.0, "resets_at": future],
            "seven_day": ["used_percent": 50, "resetsAt": future],
            "seven_day_oauth_apps": ["usedPercent": 10],
        ]
        let rows = PlanLimitsEngine.parseClaudePayload(obj, detail: "t")
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[0].label, "5h")
        XCTAssertEqual(rows[0].usedPercent, 25, accuracy: 1e-9)
        XCTAssertEqual(rows[1].label, "weekly")
        XCTAssertEqual(rows[2].label, "apps 7d")
        XCTAssertNotNil(rows[0].resetsAt)
        XCTAssertNil(rows[2].resetsAt)
    }

    func testParseClaudePayload_clampsAndSkips() {
        let rows = PlanLimitsEngine.parseClaudePayload([
            "five_hour": ["utilization": 150],
            "seven_day": ["utilization": -5],
            "seven_day_oauth_apps": [:],
        ])
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].usedPercent, 100, accuracy: 1e-9)
        XCTAssertEqual(rows[1].usedPercent, 0, accuracy: 1e-9)
    }

    func testParseClaudePayload_pastResetRollsForward() {
        let past = Date().addingTimeInterval(-10 * 3600).timeIntervalSince1970
        let rows = PlanLimitsEngine.parseClaudePayload(
            ["five_hour": ["utilization": 10, "resets_at": past]])
        XCTAssertEqual(rows.count, 1)
        // A 5h window whose reset passed rolls forward in 5h steps to now+.
        XCTAssertNotNil(rows[0].resetsAt)
        XCTAssertGreaterThan(rows[0].resetsAt!, Date())
    }

    func testParseClaudePayload_scopedModelRows() {
        let obj: [String: Any] = [
            "limits": [
                ["kind": "weekly_scoped",
                 "scope": ["model": ["display_name": "Fable"]],
                 "percent": 33.0],
                ["kind": "weekly_scoped",
                 "scope": ["model": ["display_name": "Ghost"]]],
                ["kind": "other", "percent": 99.0],
            ] as [[String: Any]],
        ]
        let rows = PlanLimitsEngine.parseClaudePayload(obj)
        // Only the row WITH a percent becomes a limit; missing percent is
        // "no data", never zero-filled.
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].label, "weekly · Fable")
        XCTAssertEqual(rows[0].usedPercent, 33, accuracy: 1e-9)
    }

    func testParseClaudePayload_empty() {
        XCTAssertTrue(PlanLimitsEngine.parseClaudePayload([:]).isEmpty)
    }

    func testEpochHelpers() {        // NSNumber seconds and millis, ISO strings, and garbage.
        let d = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(PlanLimitsEngine.epoch(NSNumber(value: 1_700_000_000))?.timeIntervalSince1970 ?? -1,
                       d.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(PlanLimitsEngine.epochMS(NSNumber(value: 1_700_000_000_000))?.timeIntervalSince1970 ?? -1,
                       d.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertNotNil(PlanLimitsEngine.parseISO("2026-09-10T12:00:00Z"))
        XCTAssertNil(PlanLimitsEngine.parseISO(nil))
        XCTAssertNil(PlanLimitsEngine.parseISO("garbage"))
        XCTAssertNil(PlanLimitsEngine.epoch(nil))
        XCTAssertNil(PlanLimitsEngine.epoch("garbage"))
    }

    func testCookieValue() {
        let cookie = "a=1; sec_token=abc%20123; c=3"
        XCTAssertEqual(PlanLimitsEngine.cookieValue(name: "sec_token", from: cookie), "abc 123")
        XCTAssertEqual(PlanLimitsEngine.cookieValue(name: "a", from: cookie), "1")
        XCTAssertNil(PlanLimitsEngine.cookieValue(name: "missing", from: cookie))
        XCTAssertNil(PlanLimitsEngine.cookieValue(name: "a", from: ""))
    }
}
