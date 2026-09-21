import XCTest
@testable import TokenHorizon

/// Regression tests for the Claude model-scoped quota (Fable). The live
/// Anthropic payload reports scoped limits with a `percent` key — an earlier
/// parser revision only read `utilization` and silently dropped every Fable
/// row. These tests pin the live shape end to end: parse → group → subtitle.
final class ClaudeScopedQuotaTests: XCTestCase {

    /// Live shape from ~/.claude.json cachedUsageUtilization (ben.ebsworth).
    private func livePayload() -> [String: Any] {
        [
            "five_hour": ["utilization": 28.0, "resets_at": "2026-09-07T07:19:59.949719+00:00"],
            "seven_day": ["utilization": 51.0, "resets_at": "2026-09-09T01:59:59.949738+00:00"],
            "seven_day_opus": NSNull(),
            "seven_day_sonnet": NSNull(),
            "limits": [
                ["kind": "session", "group": "session", "percent": 28,
                 "resets_at": "2026-09-07T07:19:59.949719+00:00", "scope": NSNull()],
                ["kind": "weekly_all", "group": "weekly", "percent": 51,
                 "resets_at": "2026-09-09T01:59:59.949738+00:00", "scope": NSNull()],
                ["kind": "weekly_scoped", "group": "weekly", "percent": 51,
                 "resets_at": "2026-09-09T01:59:59.949942+00:00",
                 "scope": ["model": ["id": NSNull(), "display_name": "Fable"], "surface": NSNull()]],
            ],
        ]
    }

    func testParse_liveShapeYieldsFableRow() {
        let out = PlanLimitsEngine.parseClaudePayload(
            livePayload(), provider: "claude (ben.ebsworth)",
            detail: "ben.ebsworth@gmail.com · claude_max")
        let fable = out.first { $0.label == "weekly · Fable" }
        XCTAssertNotNil(fable, "Fable scoped quota must be extracted, got: \(out.map(\.label))")
        XCTAssertEqual(fable?.usedPercent ?? -1, 51.0, accuracy: 0.001)
        XCTAssertEqual(fable?.provider, "claude (ben.ebsworth)")
        XCTAssertNotNil(fable?.resetsAt)
        // session/weekly_all mirror the top-level windows — not duplicated.
        XCTAssertEqual(out.filter { $0.label == "weekly · Fable" }.count, 1)
        XCTAssertTrue(out.contains { $0.label == "5h" })
        XCTAssertTrue(out.contains { $0.label == "weekly" })
    }

    func testParse_scopedEntryWithoutPercentIsSkippedNotZeroed() {
        let obj: [String: Any] = ["limits": [
            ["kind": "weekly_scoped", "scope": ["model": ["display_name": "Fable"]]],
        ]]
        XCTAssertTrue(PlanLimitsEngine.parseClaudePayload(obj).isEmpty)
    }

    func testParse_scopedNilResetYieldsNilDate() {
        // shorted account: percent 0, resets_at null.
        let obj: [String: Any] = ["limits": [
            ["kind": "weekly_scoped", "percent": 0, "resets_at": NSNull(),
             "scope": ["model": ["display_name": "Fable"]]],
        ]]
        let out = PlanLimitsEngine.parseClaudePayload(obj)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].usedPercent, 0.0, accuracy: 0.001)
        XCTAssertNil(out[0].resetsAt)
    }

    func testParse_legacyUtilizationKeyStillWorks() {
        let obj: [String: Any] = ["limits": [
            ["kind": "weekly_scoped", "utilization": 65.0, "resets_at": "2026-09-07T00:00:00.000Z",
             "scope": ["model": ["display_name": "Claude 3.5 Sonnet"]]],
        ]]
        let out = PlanLimitsEngine.parseClaudePayload(obj)
        XCTAssertEqual(out.first?.label, "weekly · Claude 3.5 Sonnet")
        XCTAssertEqual(out.first?.usedPercent ?? -1, 65.0, accuracy: 0.001)
    }

    // MARK: - Grouping into plan rows

    private func claudeGroup() -> [ProviderLimit] {
        PlanLimitsEngine.parseClaudePayload(
            livePayload(), provider: "claude (ben.ebsworth)",
            detail: "ben.ebsworth@gmail.com · claude_max")
    }

    func testGrouping_fableNeverBecomesCycle() {
        let rows = DashboardTabs(model: UIModel(), compact: true)
            .buildUnifiedPlanRows(from: claudeGroup())
        XCTAssertEqual(rows.count, 1)
        let row = rows[0]
        XCTAssertEqual(row.cycleLimit?.label, "weekly", "real weekly stays the cycle")
        XCTAssertEqual(row.burstLimit?.label, "5h")
        XCTAssertEqual(row.extraLimit?.label, "weekly · Fable")
    }

    func testGrouping_subtitleShowsFablePercent() {
        let rows = DashboardTabs(model: UIModel(), compact: true)
            .buildUnifiedPlanRows(from: claudeGroup())
        XCTAssertEqual(rows[0].subtitle, "ben.ebsworth@gmail.com · Fable 51%")
    }

    func testGrouping_cycleSortIgnoresFableReset() {
        // Fable resets sooner than weekly here — cycle must still be weekly.
        let soon = Date().addingTimeInterval(3600)
        let late = Date().addingTimeInterval(3600 * 48)
        let limits = [
            ProviderLimit(provider: "claude (x)", label: "weekly", usedPercent: 10,
                          resetsAt: late, detail: "a@b.c"),
            ProviderLimit(provider: "claude (x)", label: "weekly · Fable", usedPercent: 90,
                          resetsAt: soon, detail: "a@b.c"),
        ]
        let rows = DashboardTabs(model: UIModel(), compact: true).buildUnifiedPlanRows(from: limits)
        XCTAssertEqual(rows[0].cycleLimit?.label, "weekly")
        XCTAssertEqual(rows[0].extraLimit?.label, "weekly · Fable")
        XCTAssertTrue(rows[0].subtitle.contains("Fable 90%"))
    }

    func testScopedModelName() {
        XCTAssertEqual(DashboardTabs.scopedModelName("weekly · Fable"), "Fable")
        XCTAssertEqual(DashboardTabs.scopedModelName("weekly · Claude 3.5 Sonnet"), "Claude 3.5 Sonnet")
        XCTAssertEqual(DashboardTabs.scopedModelName("plain"), "plain")
    }

    // MARK: - Hover card titles

    func testExtraTitle_scopedShowsModelName() {
        let fable = ProviderLimit(provider: "claude (x)", label: "weekly · Fable",
                                  usedPercent: 90, resetsAt: nil, detail: "")
        XCTAssertEqual(PlanLimitCard.extraTitle(fable), "FABLE")
    }

    func testExtraTitle_plainShowsExtra() {
        let search = ProviderLimit(provider: "glm", label: "search",
                                   usedPercent: 10, resetsAt: nil, detail: "120 left")
        XCTAssertEqual(PlanLimitCard.extraTitle(search), "EXTRA")
    }

    // MARK: - Popout placement (scroll-aware flip)

    private func fullRow() -> UnifiedPlanRow {
        UnifiedPlanRow(
            id: "claude (x)", provider: "claude (x)", logoProvider: "claude",
            displayName: "Claude (x)", subtitle: "a@b.c · Fable 90%",
            burstLimit: ProviderLimit(provider: "claude (x)", label: "5h", usedPercent: 10,
                                      resetsAt: nil, detail: ""),
            cycleLimit: ProviderLimit(provider: "claude (x)", label: "weekly", usedPercent: 20,
                                      resetsAt: Date().addingTimeInterval(3600), detail: ""),
            extraLimit: ProviderLimit(provider: "claude (x)", label: "weekly · Fable", usedPercent: 90,
                                      resetsAt: nil, detail: ""))
    }

    func testEstimatedHeight_growsWithContent() {
        let full = PlanLimitCard.estimatedHeight(for: fullRow())
        XCTAssertGreaterThan(full, 150, "header + 3 blocks + footer must exceed 150pt")
        let bare = UnifiedPlanRow(id: "p", provider: "p", logoProvider: "p", displayName: "P",
                                  subtitle: "", burstLimit: nil, cycleLimit: nil, extraLimit: nil)
        XCTAssertLessThan(PlanLimitCard.estimatedHeight(for: bare), full)
        XCTAssertEqual(PlanLimitCard.estimatedHeight(for: fullRow()), full, "deterministic")
    }

    func testShowsBelow_roomBelowStaysBelow() {
        XCTAssertTrue(PlanLimitCard.showsBelow(rowTop: 100, rowBottom: 140, viewportH: 600, row: fullRow()))
    }

    func testShowsBelow_crampedBottomFlipsAbove() {
        XCTAssertFalse(PlanLimitCard.showsBelow(rowTop: 500, rowBottom: 540, viewportH: 600, row: fullRow()))
    }

    func testShowsBelow_tinyViewportPrefersLargerSide() {
        // 100pt viewport, row in the middle: more room above → above.
        XCTAssertFalse(PlanLimitCard.showsBelow(rowTop: 60, rowBottom: 90, viewportH: 100, row: fullRow()))
        // Row near the top with nothing above → below even if cramped.
        XCTAssertTrue(PlanLimitCard.showsBelow(rowTop: 0, rowBottom: 30, viewportH: 100, row: fullRow()))
    }
}
