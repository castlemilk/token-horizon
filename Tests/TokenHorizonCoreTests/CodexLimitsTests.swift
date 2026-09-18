import XCTest
@testable import TokenHorizonCore

/// OpenAI Codex quota contract: JWT account extraction + wham/usage parsing.
/// Network is never touched — the daemon returns [] without credentials.
/// Example payload mirrors .agents/skills/provider-quota-openai/SKILL.md.
final class CodexLimitsTests: XCTestCase {

    private func jwt(tokenPayload: [String: Any]) -> String {
        func b64url(_ obj: Any) -> String {
            let data = try! JSONSerialization.data(withJSONObject: obj)
            return data.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return b64url(["alg": "RS256"]) + "." + b64url(tokenPayload) + ".sig"
    }

    func testJWTAccountID() {
        let token = jwt(tokenPayload: ["https://api.openai.com/auth": [
            "chatgpt_account_id": "dd80d0db",
            "chatgpt_plan_type": "pro",
        ]])
        XCTAssertEqual(CodexLimits.jwtAccountID(token: token), "dd80d0db")
        XCTAssertNil(CodexLimits.jwtAccountID(token: "not.a.jwt"))
        XCTAssertNil(CodexLimits.jwtAccountID(token: jwt(tokenPayload: ["sub": "x"])))
    }

    func testAccountIDPrefersExplicitField() {
        let entry: [String: Any] = ["access": "tok", "accountId": "explicit-id"]
        XCTAssertEqual(CodexLimits.openaiAccountID(entry: entry, token: "tok"), "explicit-id")
        XCTAssertNil(CodexLimits.openaiAccountID(entry: ["access": "tok"], token: "tok"))
    }

    func testWindowLabels() {
        XCTAssertEqual(CodexLimits.windowLabel(seconds: 604800), "weekly")
        XCTAssertEqual(CodexLimits.windowLabel(seconds: 18000), "5h")
        XCTAssertEqual(CodexLimits.windowLabel(seconds: 86400), "1d")
        XCTAssertEqual(CodexLimits.windowLabel(seconds: 300), "5m")
        XCTAssertEqual(CodexLimits.windowLabel(seconds: nil), "window")
    }

    func testResetDateForms() {
        let now = Date(timeIntervalSince1970: 1_788_000_000)
        XCTAssertEqual(
            CodexLimits.resetDate(["reset_at": 1788660440], now: now),
            Date(timeIntervalSince1970: 1788660440))
        XCTAssertEqual(
            CodexLimits.resetDate(["reset_after_seconds": 3600], now: now),
            now.addingTimeInterval(3600))
        XCTAssertNil(CodexLimits.resetDate([:], now: now))
    }

    func testWindowsFromSkillExample() {
        let obj: [String: Any] = [
            "plan_type": "pro",
            "rate_limit": ["primary_window": [
                "used_percent": 17,
                "limit_window_seconds": 604800,
                "reset_at": 1788660440,
            ]],
            "additional_rate_limits": [[
                "limit_name": "GPT-5.3-Codex-Spark",
                "metered_feature": "codex_bengalfox",
                "rate_limit": ["primary_window": [
                    "used_percent": 0,
                    "limit_window_seconds": 18000,
                    "reset_at": 1788098989,
                ]],
            ]],
        ]
        let rows = CodexLimits.windows(from: obj)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].label, "weekly")
        XCTAssertEqual(rows[0].usedPercent, 17)
        XCTAssertEqual(rows[0].resetsAt, Date(timeIntervalSince1970: 1788660440))
        XCTAssertEqual(rows[0].detail, "pro plan")
        XCTAssertEqual(rows[1].label, "5h · GPT-5.3-Codex-Spark")
        XCTAssertEqual(rows[1].usedPercent, 0)
    }

    func testWindowsEmptyWithoutPayload() {
        XCTAssertTrue(CodexLimits.windows(from: [:]).isEmpty)
        XCTAssertTrue(CodexLimits.windows(from: ["rate_limit": [:]]).isEmpty)
    }
}
