import XCTest
@testable import TokenHorizon

/// Coverage for previously untested/weak paths:
/// KimiLimitsEngine (was 0%), PlanLimitsEngine helpers, Models value types,
/// UsageEngine token-estimate helpers. All pure/offline — no network.
final class CoverageImprovementTests: XCTestCase {

    // MARK: - KimiLimitsEngine

    func testKimiParseQuota_stringAndNumber() {
        XCTAssertEqual(KimiLimitsEngine.parseQuota(["limit": "10k"], "limit"), 10_000)
        XCTAssertEqual(KimiLimitsEngine.parseQuota(["limit": "1.5M"], "limit"), 1_500_000)
        XCTAssertEqual(KimiLimitsEngine.parseQuota(["limit": NSNumber(value: 42)], "limit"), 42)
        XCTAssertNil(KimiLimitsEngine.parseQuota([:], "limit"))
        // Bool bridges to NSNumber(1) via [String: Any] — documents existing behavior.
        XCTAssertEqual(KimiLimitsEngine.parseQuota(["limit": true], "limit"), 1.0)
    }

    func testKimiFlexibleNumber_suffixes() {
        XCTAssertEqual(KimiLimitsEngine.flexibleNumber("2K"), 2_000)
        XCTAssertEqual(KimiLimitsEngine.flexibleNumber("1.5m"), 1_500_000)
        XCTAssertEqual(KimiLimitsEngine.flexibleNumber("3B"), 3_000_000_000)
        XCTAssertEqual(KimiLimitsEngine.flexibleNumber("  500 "), 500)
        XCTAssertEqual(KimiLimitsEngine.flexibleNumber("12.5k tokens"), 12_500)
        XCTAssertNil(KimiLimitsEngine.flexibleNumber("abc"))
        XCTAssertNil(KimiLimitsEngine.flexibleNumber(""))
    }

    func testKimiMembership_extractsLevel() {
        let obj: [String: Any] = ["user": ["membership": ["level": "LEVEL_PRO"]]]
        XCTAssertEqual(KimiLimitsEngine.membership(obj), "LEVEL_PRO")
        XCTAssertNil(KimiLimitsEngine.membership([:]))
        XCTAssertNil(KimiLimitsEngine.membership(["user": [:]]))
    }

    func testKimiWindowLabel_units() {
        XCTAssertEqual(KimiLimitsEngine.windowLabel(["duration": 120, "timeUnit": "MINUTE"]), "2h")
        XCTAssertEqual(KimiLimitsEngine.windowLabel(["duration": 30, "timeUnit": "MINUTE"]), "30m")
        XCTAssertEqual(KimiLimitsEngine.windowLabel(["duration": 5, "timeUnit": "HOUR"]), "5h")
        XCTAssertEqual(KimiLimitsEngine.windowLabel(["duration": 7, "timeUnit": "DAY"]), "7d")
        XCTAssertEqual(KimiLimitsEngine.windowLabel(nil), "window")
        XCTAssertEqual(KimiLimitsEngine.windowLabel([:]), "window")
    }

    func testKimiParseDate_isoVariants() {
        XCTAssertNotNil(KimiLimitsEngine.parseDate("2026-09-01T15:30:00.000Z"))
        XCTAssertNotNil(KimiLimitsEngine.parseDate("2026-09-01T15:30:00Z"))
        XCTAssertNil(KimiLimitsEngine.parseDate(nil))
        XCTAssertNil(KimiLimitsEngine.parseDate("not-a-date"))
    }

    func testKimiFmt_scales() {
        XCTAssertEqual(KimiLimitsEngine.fmt(500), "500")
        XCTAssertEqual(KimiLimitsEngine.fmt(2_500), "2.5k")
        XCTAssertEqual(KimiLimitsEngine.fmt(3_000_000), "3.0M")
        XCTAssertEqual(KimiLimitsEngine.fmt(2_000_000_000), "2.0B")
    }

    // MARK: - PlanLimitsEngine helpers

    func testPlanWindowLabel_boundaries() {
        XCTAssertEqual(PlanLimitsEngine.windowLabel(seconds: 0), "session")
        XCTAssertEqual(PlanLimitsEngine.windowLabel(seconds: -5), "session")
        XCTAssertEqual(PlanLimitsEngine.windowLabel(seconds: 1800), "30m")
        XCTAssertEqual(PlanLimitsEngine.windowLabel(seconds: 18_000), "5h")
        XCTAssertEqual(PlanLimitsEngine.windowLabel(seconds: 604_800), "7d")
    }

    func testPlanParseISO_cachedFormatters() {
        XCTAssertNotNil(PlanLimitsEngine.parseISO("2026-09-01T15:30:00.000Z"))
        XCTAssertNotNil(PlanLimitsEngine.parseISO("2026-09-01T15:30:00Z"))
        XCTAssertNil(PlanLimitsEngine.parseISO(nil))
        XCTAssertNil(PlanLimitsEngine.parseISO("garbage"))
    }

    func testPlanExtractSecToken() {
        let html = #"<html><script>var sec_token="ABCDEF1234567890_xyz";</script></html>"#
        XCTAssertEqual(PlanLimitsEngine.extractSecToken(from: html), "ABCDEF1234567890_xyz")
        XCTAssertNil(PlanLimitsEngine.extractSecToken(from: "<html>no token here</html>"))
    }

    func testPlanParseDeepSeekPayload() {
        let obj: [String: Any] = [
            "is_available": true,
            "balance_infos": [["total_balance": "12.34", "currency": "USD"]]
        ]
        let out = PlanLimitsEngine.parseDeepSeekPayload(obj)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].provider, "deepseek")
        XCTAssertEqual(out[0].detail, "$12.34 USD")
        // Unavailable (depleted) balances still surface as an exhausted row.
        let depleted = PlanLimitsEngine.parseDeepSeekPayload([
            "is_available": false,
            "balance_infos": [["total_balance": "-0.02", "currency": "USD"]]
        ])
        XCTAssertEqual(depleted.count, 1)
        XCTAssertEqual(depleted[0].usedPercent, 100)
        XCTAssertEqual(depleted[0].detail, "$-0.02 USD · unavailable")
        XCTAssertTrue(PlanLimitsEngine.parseDeepSeekPayload(["is_available": false]).isEmpty)
        XCTAssertTrue(PlanLimitsEngine.parseDeepSeekPayload([:]).isEmpty)
    }

    func testPlanParseOpenAIPayload_primaryAndAdditional() {
        let obj: [String: Any] = [
            "rate_limit": ["primary_window": [
                "used_percent": 42.0,
                "limit_window_seconds": 18_000,
                "reset_at": 1_800_000_000.0
            ]],
            "additional_rate_limits": [[
                "limit_name": "GPT-5",
                "rate_limit": ["primary_window": [
                    "used_percent": 10.0,
                    "limit_window_seconds": 604_800,
                    "reset_at": 1_800_000_000.0
                ]]
            ]]
        ]
        let out = PlanLimitsEngine.parseOpenAIPayload(obj)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].provider, "codex")
        XCTAssertEqual(out[0].label, "5h")
        XCTAssertEqual(out[0].usedPercent, 42.0, accuracy: 0.001)
        XCTAssertNotNil(out[0].resetsAt)
        XCTAssertTrue(out[1].label.contains("gpt-5"))
        XCTAssertTrue(PlanLimitsEngine.parseOpenAIPayload([:]).isEmpty)
    }

    func testPlanParseAgyGroups_prefixes() {
        let groups: [[String: Any]] = [[
            "displayName": "Gemini Pro",
            "buckets": [[
                "remainingFraction": 0.75,
                "window": "5h",
                "resetTime": "2026-09-01T15:30:00.000Z"
            ]]
        ], [
            "displayName": "Claude Sonnet",
            "buckets": [[
                "remainingFraction": 0.5,
                "bucketId": "weekly",
                "resetTime": "2026-09-07T00:00:00Z"
            ]]
        ]]
        let out = PlanLimitsEngine.parseAgyLanguageServerGroups(groups)
        XCTAssertEqual(out.count, 2)
        XCTAssertTrue(out[0].label.hasPrefix("gemini"))
        XCTAssertEqual(out[0].usedPercent, 25.0, accuracy: 0.01)
        XCTAssertTrue(out[1].label.hasPrefix("3p"))
        XCTAssertTrue(PlanLimitsEngine.parseAgyLanguageServerGroups([]).isEmpty)
    }

    // MARK: - Models value types

    func testUsageSnapshotTokensFormatting() {
        XCTAssertEqual(UsageSnapshot.tokens(999), "999")
        XCTAssertEqual(UsageSnapshot.tokens(1_500), "1.5k")
        XCTAssertEqual(UsageSnapshot.tokens(2_500_000), "2.5M")
        XCTAssertEqual(UsageSnapshot.cost(99.99), "$99.99")
        XCTAssertEqual(UsageSnapshot.cost(150), "$150")
    }

    func testProviderLimitHelpers() {
        let weekly = ProviderLimit(provider: "claude", label: "weekly", usedPercent: 80, resetsAt: nil, detail: "")
        XCTAssertTrue(weekly.isWeekly)
        XCTAssertEqual(weekly.remainingPercent, 20, accuracy: 0.001)
        let daily = ProviderLimit(provider: "codex", label: "5h", usedPercent: 30, resetsAt: nil, detail: "")
        XCTAssertFalse(daily.isWeekly)
        XCTAssertEqual(daily.id, "codex:5h")
        let adv = ProviderLimit(provider: "x", label: "advanced tools", usedPercent: 10, resetsAt: nil, detail: "")
        XCTAssertTrue(adv.isWeekly)
    }

    func testProviderLimitResetTiming() {
        let soon = ProviderLimit(provider: "p", label: "5h", usedPercent: 10,
                                 resetsAt: Date().addingTimeInterval(3600), detail: "")
        XCTAssertTrue(soon.resetsSoon)
        XCTAssertNotNil(soon.secondsUntilReset)
        let none = ProviderLimit(provider: "p", label: "5h", usedPercent: 10, resetsAt: nil, detail: "")
        XCTAssertFalse(none.resetsSoon)
        XCTAssertNil(none.secondsUntilReset)
        let far = ProviderLimit(provider: "p", label: "w", usedPercent: 10,
                                resetsAt: Date().addingTimeInterval(200_000), detail: "")
        XCTAssertFalse(far.resetsSoon)
    }

    func testTrendWindowSpecs() {
        XCTAssertEqual(TrendWindow.day.spec.count, 24)
        XCTAssertEqual(TrendWindow.week.spec.seconds, 86_400)
        XCTAssertEqual(TrendWindow.month.spec.dailyAligned, true)
        XCTAssertEqual(TrendWindow.year.spec.count, 52)
        XCTAssertEqual(TrendWindow.day.engineKey, "1d")
        XCTAssertEqual(TrendWindow.quarter.engineKey, "3m")
        XCTAssertEqual(TrendWindow.allCases.count, 5)
    }

    func testShellEventSummary_marks() {
        let ok = ShellEvent(time: Date(), cwd: "/Users/me/proj", durationMs: 500, exit: 0)
        XCTAssertTrue(ok.summary.contains("proj"))
        XCTAssertTrue(ok.summary.contains("✓"))
        let slow = ShellEvent(time: Date(), cwd: "/x/y", durationMs: 90_000, exit: 1)
        XCTAssertTrue(slow.summary.contains("m"))
        XCTAssertTrue(slow.summary.contains("✗ 1"))
        let secs = ShellEvent(time: Date(), cwd: "/x/y", durationMs: 2_500, exit: 0)
        XCTAssertTrue(secs.summary.contains("s"))
    }

    func testModelUsageAndSessionIds() {
        let m = ModelUsage(provider: "openai", model: "gpt-5", tokensAll: 10, tokensToday: 5,
                           cost: 0.1, messages: 2, free: false)
        XCTAssertEqual(m.id, "openai/gpt-5")
        let s = SessionSummary(id: "abc", title: "t", cost: 1, tokens: 2, directory: "/tmp", created: Date())
        XCTAssertEqual(s.id, "abc")
    }

    // MARK: - UsageEngine helpers

    func testEstimatedToolCallChars_scalesWithContent() {
        XCTAssertEqual(UsageEngine.estimatedToolCallChars("hello"), 5)
        let small = UsageEngine.estimatedToolCallChars([["name": "a"]])
        let big = UsageEngine.estimatedToolCallChars([["name": String(repeating: "x", count: 1000)]])
        XCTAssertGreaterThan(big, small)
        // Dict overhead: keys + structure counted
        XCTAssertGreaterThan(UsageEngine.estimatedToolCallChars(["a": "b"]), 4)
        XCTAssertEqual(UsageEngine.estimatedToolCallChars([]), 2)
    }

    func testEstimateTokenCost_knownFamilies() {
        let claude = UsageEngine.estimateTokenCost(model: "claude-sonnet", inputTokens: 1_000_000,
                                                  outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0)
        XCTAssertGreaterThan(claude, 0)
        let opus = UsageEngine.estimateTokenCost(model: "claude-opus-4-5", inputTokens: 1000,
                                                outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0)
        XCTAssertGreaterThan(opus, 0)
        let haiku = UsageEngine.estimateTokenCost(model: "claude-haiku-4-5", inputTokens: 1000,
                                                 outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0)
        XCTAssertGreaterThan(haiku, 0)
        let gemini = UsageEngine.estimateTokenCost(model: "gemini-flash", inputTokens: 1000,
                                                  outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0)
        XCTAssertGreaterThan(gemini, 0)
        let geminiPro = UsageEngine.estimateTokenCost(model: "gemini-pro", inputTokens: 1000,
                                                     outputTokens: 1000, cacheReadTokens: 100, cacheWriteTokens: 0)
        XCTAssertGreaterThan(geminiPro, gemini)
        let unknownZero = UsageEngine.estimateTokenCost(model: "totally-unknown-xyz-123",
                                                       inputTokens: 0, outputTokens: 0,
                                                       cacheReadTokens: 0, cacheWriteTokens: 0)
        XCTAssertEqual(unknownZero, 0)
    }
}
