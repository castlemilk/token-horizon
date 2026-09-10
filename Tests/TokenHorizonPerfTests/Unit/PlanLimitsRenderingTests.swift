import XCTest
@testable import TokenHorizon

/// Regression tests for the Plan Limits section ("PLAN LIMITS & REFRESH
/// TRACKER" in tokensTab): every provider group — including multi-account
/// "claude (label)" rows — must survive from fetch to rendered row.
/// Dropping a group here is exactly "claude usage data gone missing".
final class PlanLimitsRenderingTests: XCTestCase {

    private func claudeLimits(tag: String, fiveH: Double, weekly: Double) -> [ProviderLimit] {
        [
            ProviderLimit(provider: "claude (\(tag))", label: "5h", usedPercent: fiveH,
                          resetsAt: Date().addingTimeInterval(3600), detail: "user@x.com · claude_max"),
            ProviderLimit(provider: "claude (\(tag))", label: "weekly", usedPercent: weekly,
                          resetsAt: Date().addingTimeInterval(86_400 * 2), detail: "user@x.com · claude_max"),
        ]
    }

    private func makeHost() -> DashboardTabs {
        DashboardTabs(model: UIModel(), compact: true)
    }

    func testMultiAccountClaude_eachGetsARow() {
        let limits = claudeLimits(tag: "alpha", fiveH: 28, weekly: 51)
            + claudeLimits(tag: "beta", fiveH: 17, weekly: 4)
        let rows = makeHost().buildUnifiedPlanRows(from: limits)
        let claudeRows = rows.filter { $0.provider.contains("claude") }
        XCTAssertEqual(claudeRows.count, 2, "each claude account must render its own row")
        for r in claudeRows {
            XCTAssertNotNil(r.burstLimit, "\(r.provider) missing burst")
            XCTAssertNotNil(r.cycleLimit, "\(r.provider) missing cycle")
            XCTAssertEqual(r.logoProvider, "claude")
        }
        XCTAssertTrue(rows.contains { $0.displayName == "Claude (alpha)" })
        XCTAssertTrue(rows.contains { $0.displayName == "Claude (beta)" })
    }

    func testSingleClaudeProvider_backCompat() {
        let limits = [
            ProviderLimit(provider: "claude", label: "5h", usedPercent: 10,
                          resetsAt: Date().addingTimeInterval(100), detail: "a@b.c"),
            ProviderLimit(provider: "claude", label: "weekly", usedPercent: 20,
                          resetsAt: Date().addingTimeInterval(200), detail: "a@b.c"),
        ]
        let rows = makeHost().buildUnifiedPlanRows(from: limits)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].displayName, "Claude")
        XCTAssertEqual(rows[0].burstLimit?.label, "5h")
        XCTAssertEqual(rows[0].cycleLimit?.label, "weekly")
    }

    func testClaudeSubtitle_usesEmailPrefix() {
        let rows = makeHost().buildUnifiedPlanRows(from: claudeLimits(tag: "t", fiveH: 1, weekly: 2))
        XCTAssertEqual(rows.first?.subtitle, "user@x.com")
    }

    func testAssembleLimitRows_codexDedup() {
        let fileCodex = ProviderLimit(provider: "codex", label: "5h", usedPercent: 90,
                                      resetsAt: nil, detail: "file")
        let liveCodex = ProviderLimit(provider: "codex", label: "5h", usedPercent: 42,
                                      resetsAt: nil, detail: "live")
        // Live planLimits codex wins; file-derived usage copy dropped.
        var out = DashboardTabs.assembleLimitRows(usageLimits: [fileCodex], planLimits: [liveCodex], kimiLimits: [])
        XCTAssertEqual(out.filter { $0.provider == "codex" }.count, 1)
        XCTAssertEqual(out.first { $0.provider == "codex" }?.detail, "live")
        // No live codex: file copy kept.
        out = DashboardTabs.assembleLimitRows(usageLimits: [fileCodex], planLimits: [], kimiLimits: [])
        XCTAssertEqual(out.filter { $0.provider == "codex" }.count, 1)
        XCTAssertEqual(out.first { $0.provider == "codex" }?.detail, "file")
    }

    func testAssembleLimitRows_keepsClaudeFromPlanLimits() {
        let claude = claudeLimits(tag: "solo", fiveH: 5, weekly: 6)
        let out = DashboardTabs.assembleLimitRows(usageLimits: [], planLimits: claude, kimiLimits: [])
        XCTAssertEqual(out.filter { $0.provider.contains("claude") }.count, 2)
        let rows = makeHost().buildUnifiedPlanRows(from: out)
        XCTAssertEqual(rows.filter { $0.provider.contains("claude") }.count, 1)
    }

    func testProviderNameDisplay() {
        XCTAssertEqual(DashboardTabs.providerNameDisplay("claude (dorja)"), "Claude (dorja)")
        XCTAssertEqual(DashboardTabs.providerNameDisplay("claude"), "Claude")
        XCTAssertEqual(DashboardTabs.providerNameDisplay("codex"), "OpenAI")
        XCTAssertEqual(DashboardTabs.providerNameDisplay("agy"), "AGY")
    }

    // MARK: - Watermark dedup (engine side of "missing vs doubled" claude data)

    func testWatermarkDelta_identicalRepeatCountsZero() {
        let first = UsageEngine.watermarkDelta(prev: nil, input: 100, output: 50, cacheWrite: 10, cacheRead: 500)
        XCTAssertEqual(first.dIn, 100)
        XCTAssertEqual(first.dOut, 50)
        // Same message re-emitted (transcripts repeat ids verbatim): no double count.
        let rep = UsageEngine.watermarkDelta(prev: first.next, input: 100, output: 50, cacheWrite: 10, cacheRead: 500)
        XCTAssertEqual(rep.dIn + rep.dOut + rep.dCw + rep.dCr, 0)
    }

    func testWatermarkDelta_cumulativeGrowthCountsDeltaOnly() {
        let prev = UsageEngine.AdditiveWatermark(input: 100, output: 50, cacheWrite: 0, cacheRead: 20)
        let r = UsageEngine.watermarkDelta(prev: prev, input: 150, output: 60, cacheWrite: 0, cacheRead: 20)
        XCTAssertEqual(r.dIn, 50)
        XCTAssertEqual(r.dOut, 10)
        XCTAssertEqual(r.dCw, 0)
        XCTAssertEqual(r.dCr, 0)
        XCTAssertEqual(r.next.input, 150)
    }

    func testWatermarkDelta_shrinkageNeverNegative() {
        let prev = UsageEngine.AdditiveWatermark(input: 900, output: 100, cacheWrite: 5, cacheRead: 5)
        let r = UsageEngine.watermarkDelta(prev: prev, input: 10, output: 5, cacheWrite: 0, cacheRead: 0)
        XCTAssertEqual(r.dIn + r.dOut + r.dCw + r.dCr, 0)
        XCTAssertEqual(r.next.input, 900, "watermark keeps the max")
    }

    func testAgyRows_rendering() {
        let limits = [
            ProviderLimit(provider: "agy", label: "gemini 5h", usedPercent: 4.8,
                          resetsAt: Date().addingTimeInterval(3600), detail: "95% left"),
            ProviderLimit(provider: "agy", label: "gemini weekly", usedPercent: 28.9,
                          resetsAt: Date().addingTimeInterval(86_400 * 2), detail: "71% left"),
            ProviderLimit(provider: "agy", label: "3p 5h", usedPercent: 0.0,
                          resetsAt: Date().addingTimeInterval(7200), detail: "100% left"),
            ProviderLimit(provider: "agy", label: "3p weekly", usedPercent: 0.0,
                          resetsAt: Date().addingTimeInterval(86_400 * 6), detail: "100% left"),
        ]
        let rows = makeHost().buildUnifiedPlanRows(from: limits)
        let geminiRow = rows.first { $0.id == "agy-gemini" }
        XCTAssertNotNil(geminiRow)
        XCTAssertEqual(geminiRow?.displayName, "AGY (Gemini)")
        XCTAssertEqual(geminiRow?.burstLimit?.label, "gemini 5h")
        XCTAssertEqual(geminiRow?.cycleLimit?.label, "gemini weekly")
        XCTAssertEqual(geminiRow?.logoProvider, "agy")

        let p3Row = rows.first { $0.id == "agy-3p" }
        XCTAssertNotNil(p3Row)
        XCTAssertEqual(p3Row?.displayName, "AGY (3P Models)")
        XCTAssertEqual(p3Row?.burstLimit?.label, "3p 5h")
        XCTAssertEqual(p3Row?.cycleLimit?.label, "3p weekly")
    }

    func testWeeklyPriorityOverScoped() {
        let limits = [
            ProviderLimit(provider: "claude (shorted)", label: "5h", usedPercent: 12.0,
                          resetsAt: Date().addingTimeInterval(3600), detail: "ben@shorted.com.au"),
            ProviderLimit(provider: "claude (shorted)", label: "weekly · Fable", usedPercent: 100.0,
                          resetsAt: Date().addingTimeInterval(86_400 * 2), detail: "ben@shorted.com.au"),
            ProviderLimit(provider: "claude (shorted)", label: "weekly", usedPercent: 86.0,
                          resetsAt: Date().addingTimeInterval(86_400 * 2), detail: "ben@shorted.com.au"),
        ]
        let rows = makeHost().buildUnifiedPlanRows(from: limits)
        XCTAssertEqual(rows.count, 1)
        let row = rows[0]
        XCTAssertEqual(row.cycleLimit?.label, "weekly", "weekly must be prioritized as cycleLimit over scoped Fable")
        XCTAssertEqual(row.cycleLimit?.usedPercent, 86.0)
        XCTAssertEqual(row.extraLimit?.label, "weekly · Fable")
        XCTAssertEqual(row.extraLimit?.usedPercent, 100.0)
    }
}
