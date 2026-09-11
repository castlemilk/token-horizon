import XCTest
@testable import TokenHorizon

/// Tests for plan-card layout math (urgency, height estimation, flip
/// decision) and the scoped-quota title. These guard the hover popout
/// against clipping and mislabeled windows.
final class PlanCardTests: XCTestCase {

    private func row(cycleResetsIn seconds: TimeInterval?) -> UnifiedPlanRow {
        UnifiedPlanRow(
            id: "x", provider: "claude", logoProvider: "claude",
            displayName: "Claude", subtitle: "s", burstLimit: nil,
            cycleLimit: seconds.map {
                ProviderLimit(provider: "claude", label: "5h", usedPercent: 10,
                              resetsAt: Date().addingTimeInterval($0), detail: "")
            },
            extraLimit: nil)
    }

    func testIsUrgent() {
        XCTAssertTrue(PlanLimitCard(row: row(cycleResetsIn: 3600)).isUrgent)
        XCTAssertFalse(PlanLimitCard(row: row(cycleResetsIn: 48 * 3600)).isUrgent)
        XCTAssertFalse(PlanLimitCard(row: row(cycleResetsIn: nil)).isUrgent)
    }

    func testEstimatedHeight() {
        // 1 block, no footer: 10+22+7+1+7 + 50 + 0 + 0 + 10+12.
        let one = UnifiedPlanRow(id: "x", provider: "c", logoProvider: "c",
                                 displayName: "C", subtitle: "s",
                                 burstLimit: ProviderLimit(provider: "c", label: "5h",
                                                           usedPercent: 1, resetsAt: nil, detail: ""),
                                 cycleLimit: nil, extraLimit: nil)
        XCTAssertEqual(PlanLimitCard.estimatedHeight(for: one), 119)
        // 3 blocks + urgency footer (+35).
        let lim = ProviderLimit(provider: "c", label: "5h", usedPercent: 1,
                                resetsAt: Date().addingTimeInterval(3600), detail: "")
        let full = UnifiedPlanRow(id: "x", provider: "c", logoProvider: "c",
                                  displayName: "C", subtitle: "s",
                                  burstLimit: lim, cycleLimit: lim, extraLimit: lim)
        XCTAssertEqual(PlanLimitCard.estimatedHeight(for: full), 268)
    }

    func testShowsBelow() {
        let r = row(cycleResetsIn: nil) // need = 119
        XCTAssertTrue(PlanLimitCard.showsBelow(rowTop: 100, rowBottom: 200, viewportH: 600, row: r))
        XCTAssertFalse(PlanLimitCard.showsBelow(rowTop: 100, rowBottom: 200, viewportH: 210, row: r))
        // Not enough room below, more room above → flips above (false).
        XCTAssertFalse(PlanLimitCard.showsBelow(rowTop: 50, rowBottom: 590, viewportH: 600, row: r))
        // Plenty of room above but fits below anyway → below (true).
        XCTAssertTrue(PlanLimitCard.showsBelow(rowTop: 500, rowBottom: 550, viewportH: 700, row: r))
    }

    func testExtraTitle() {
        XCTAssertEqual(PlanLimitCard.extraTitle(ProviderLimit(provider: "c", label: "weekly · Fable",
                                                              usedPercent: 1, resetsAt: nil, detail: "")),
                       "FABLE")
        XCTAssertEqual(PlanLimitCard.extraTitle(ProviderLimit(provider: "c", label: "5h",
                                                              usedPercent: 1, resetsAt: nil, detail: "")),
                       "EXTRA")
    }
}
