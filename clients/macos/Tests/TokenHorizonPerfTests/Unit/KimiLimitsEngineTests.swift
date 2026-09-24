import XCTest
@testable import TokenHorizon

/// Table-driven tests for KimiLimitsEngine's pure helpers (window labels,
/// quota number parsing, membership, dates, formatting). The network paths
/// (fetch/refresh) stay untested by design — no live API in unit tests.
final class KimiLimitsEngineTests: XCTestCase {

    func testWindowLabel() {
        struct Case { let win: [String: Any]?; let want: String }
        let cases: [Case] = [
            Case(win: nil, want: "window"),
            Case(win: [:], want: "window"),
            Case(win: ["duration": 300, "timeUnit": "TIME_UNIT_MINUTE"], want: "5h"),
            Case(win: ["duration": 30, "timeUnit": "TIME_UNIT_MINUTE"], want: "30m"),
            Case(win: ["duration": 60, "timeUnit": "TIME_UNIT_MINUTE"], want: "1h"),
            Case(win: ["duration": 5, "timeUnit": "TIME_UNIT_HOUR"], want: "5h"),
            Case(win: ["duration": 7, "timeUnit": "TIME_UNIT_DAY"], want: "7d"),
            Case(win: ["duration": 9, "timeUnit": "FORTNIGHT"], want: "window"),
        ]
        for (i, tc) in cases.enumerated() {
            XCTAssertEqual(KimiLimitsEngine.windowLabel(tc.win), tc.want, "case \(i)")
        }
    }

    func testFlexibleNumber() {
        struct Case { let s: String; let want: Double? }
        let cases: [Case] = [
            Case(s: "42", want: 42),
            Case(s: " 1.5M ", want: 1_500_000),
            Case(s: "2k", want: 2_000),
            Case(s: "3B", want: 3_000_000_000),
            Case(s: "0.5m", want: 500_000),
            Case(s: "", want: nil),
            Case(s: "abc", want: nil),
            Case(s: "1.2.3", want: nil),
        ]
        for (i, tc) in cases.enumerated() {
            if let want = tc.want {
                XCTAssertEqual(KimiLimitsEngine.flexibleNumber(tc.s) ?? -1, want, accuracy: 1e-9, "case \(i)")
            } else {
                XCTAssertNil(KimiLimitsEngine.flexibleNumber(tc.s), "case \(i)")
            }
        }
    }

    func testParseQuota_stringNumberAndMissing() {
        XCTAssertEqual(KimiLimitsEngine.parseQuota(["limit": "1.5M"], "limit") ?? -1, 1_500_000, accuracy: 1e-9)
        XCTAssertEqual(KimiLimitsEngine.parseQuota(["limit": 42], "limit") ?? -1, 42, accuracy: 1e-9)
        XCTAssertEqual(KimiLimitsEngine.parseQuota(["limit": 42.5], "limit") ?? -1, 42.5, accuracy: 1e-9)
        XCTAssertNil(KimiLimitsEngine.parseQuota([:], "limit"))
        XCTAssertNil(KimiLimitsEngine.parseQuota(["other": 1], "limit"))
    }

    func testMembership() {
        XCTAssertEqual(KimiLimitsEngine.membership(["user": ["membership": ["level": "pro"]]]), "pro")
        XCTAssertNil(KimiLimitsEngine.membership([:]))
        XCTAssertNil(KimiLimitsEngine.membership(["user": [:]]))
        XCTAssertNil(KimiLimitsEngine.membership(["user": ["membership": [:]]]))
    }

    func testParseDate() {
        XCTAssertNil(KimiLimitsEngine.parseDate(nil))
        XCTAssertNil(KimiLimitsEngine.parseDate("not-a-date"))
        // Fractional + plain internet datetime both parse to the same instant.
        let a = KimiLimitsEngine.parseDate("2026-09-10T12:00:00.000Z")
        let b = KimiLimitsEngine.parseDate("2026-09-10T12:00:00Z")
        XCTAssertNotNil(a)
        XCTAssertEqual(a?.timeIntervalSince1970 ?? -1, b?.timeIntervalSince1970 ?? -2, accuracy: 0.001)
    }

    func testFmt() {
        XCTAssertEqual(KimiLimitsEngine.fmt(999), "999")
        XCTAssertEqual(KimiLimitsEngine.fmt(1500), "1.5k")
        XCTAssertEqual(KimiLimitsEngine.fmt(2_500_000), "2.5M")
        XCTAssertEqual(KimiLimitsEngine.fmt(3_000_000_000), "3.0B")
        XCTAssertEqual(KimiLimitsEngine.fmt(0), "0")
    }
}
