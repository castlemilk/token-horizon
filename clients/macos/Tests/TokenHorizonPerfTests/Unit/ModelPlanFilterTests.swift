import XCTest
@testable import TokenHorizon

/// Plan coverage filtering: curated `plans.json` → family coverage → the
/// MODELS tab's plan dropdown, row badges and `/models?plan=`.
///
/// The matching rule walks *raw* source providers (models.dev ids like
/// `opencode-go`, `zai-coding-plan`) grouped by canonical family, because
/// canonical merge rewrites every row's provider to the lab id and would
/// otherwise erase the plan linkage entirely.
final class ModelPlanFilterTests: XCTestCase {

    // MARK: - Fixtures

    /// Providers that `plans.json` actually names, plus one it never covers.
    private func fixtureCatalog() -> [ModelCatalog.Entry] {
        [
            // GLM coding plan family, sold through two plan providers.
            entry(id: "glm-4.6", provider: "zai-coding-plan"),
            entry(id: "glm-4.6", provider: "opencode-go"),
            // OpenCode Zen also sells a non-GLM family.
            entry(id: "big-pickle", provider: "opencode-go"),
            // Copilot-only source, never part of Zen.
            entry(id: "gpt-5", provider: "github-copilot"),
            // No curated plan sells Anthropic directly.
            entry(id: "claude-opus-5", provider: "anthropic")
        ]
    }

    private func entry(id: String, provider: String) -> ModelCatalog.Entry {
        ModelCatalog.Entry(
            id: id, name: id, provider: provider, providerName: provider,
            inputPerM: 1, outputPerM: 2, contextK: 128
        )
    }

    private func compute(
        planFilter: ModelPlanFilter = .all,
        scope: ModelFilterScope = .all,
        search: String = ""
    ) -> ModelsPipeline.Result {
        ModelsPipeline.compute(
            search: search,
            scope: scope,
            planFilter: planFilter,
            sortColumn: .model,
            sortAscending: true,
            catalog: fixtureCatalog(),
            syntheticModels: [],
            usageModels: []
        )
    }

    // MARK: - Curated file

    func testCuratedPlansLoad() {
        let doc = ModelPlanIndex.plans()
        XCTAssertGreaterThanOrEqual(doc.plans.count, 10, "plans.json must ship with the bundle")
        XCTAssertTrue(doc.plans.contains { $0.id == "opencode-zen" }, "opencode-zen must be curated")
        let zen = doc.plans.first { $0.id == "opencode-zen" }
        XCTAssertEqual(zen?.short, "ZEN")
        XCTAssertTrue(zen?.providers.contains("opencode-go") == true)
        XCTAssertTrue(doc.plans.allSatisfy { !$0.short.isEmpty }, "every plan needs a pill label")
    }

    func testDerivedShort_fallsBackToFirstWord() {
        XCTAssertEqual(ModelPlanIndex.derivedShort(from: "GLM Coding Plan"), "GLM")
        XCTAssertEqual(ModelPlanIndex.derivedShort(from: "MiniMax Token Plan"), "MINIMAX")
        XCTAssertEqual(ModelPlanIndex.derivedShort(from: "single"), "SINGLE")
    }

    // MARK: - Coverage stamping

    func testCompute_stampsPlanIdsFromRawSourceProviders() throws {
        let byFamily = Dictionary(grouping: compute().base, by: { $0.usage.model })
        // glm-4.6 is sold by both zai-coding-plan and opencode-go.
        let glm = try XCTUnwrap(byFamily["glm-4.6"]?.first)
        XCTAssertEqual(Set(glm.planIds), ["zai-coding-plan", "opencode-zen"])

        let pickle = try XCTUnwrap(byFamily["big-pickle"]?.first)
        XCTAssertEqual(pickle.planIds, ["opencode-zen"], "opencode-go-only family is Zen-covered")

        let copilot = try XCTUnwrap(byFamily["gpt-5"]?.first)
        XCTAssertEqual(copilot.planIds, ["github-copilot"])

        let anthropic = try XCTUnwrap(byFamily["claude-opus-5"]?.first)
        XCTAssertEqual(anthropic.planIds, [], "Anthropic has no curated plan")
    }

    func testCompute_uncoveredRowsHaveNoBadges() {
        let uncovered = compute().base.filter { $0.planIds.isEmpty }
        XCTAssertEqual(uncovered.map(\.usage.model), ["claude-opus-5"])
        XCTAssertEqual(compute().uncoveredCount, 1)
        XCTAssertTrue(uncovered.allSatisfy { $0.planBadges.isEmpty && $0.planNames.isEmpty })
    }

    // MARK: - Filtering

    func testPlanFilter_planSelectsOnlyCoveredRows() {
        let result = compute(planFilter: .plan("opencode-zen"))
        XCTAssertEqual(result.filtered.count, 2, "glm-4.6 + big-pickle")
        XCTAssertTrue(result.filtered.allSatisfy { $0.planIds.contains("opencode-zen") })
        XCTAssertFalse(result.filtered.contains { $0.usage.model == "claude-opus-5" })
    }

    func testPlanFilter_allMatchesUnfiltered() {
        let all = compute(planFilter: .all)
        XCTAssertEqual(all.filtered.count, all.base.count)
        XCTAssertEqual(all.filtered.count, 4)
    }

    /// The dropdown badge for a plan must equal what selecting it yields.
    func testPlanFilter_facetCountsMatchSelectingEachPlan() {
        let all = compute(planFilter: .all)
        for plan in ModelPlanIndex.plans().plans {
            let expected = all.planCounts[plan.id] ?? 0
            let selected = compute(planFilter: .plan(plan.id)).filtered.count
            XCTAssertEqual(selected, expected, "facet count for \(plan.id) drifted from the filter")
        }
        XCTAssertEqual(compute(planFilter: .uncovered).filtered.count, all.uncoveredCount)
        // A row covered by two plans contributes to two counts, so the facet
        // totals can exceed the base — but every covered row must be reachable.
        let covered = all.base.count - all.uncoveredCount
        XCTAssertGreaterThanOrEqual(all.planCounts.values.reduce(0, +), covered)
        XCTAssertGreaterThan(covered, 0, "fixture must contain covered rows")
    }

    func testPlanFilter_composesWithSearchAndScope() {
        let zenCloud = compute(planFilter: .plan("opencode-zen"), scope: .cloud, search: "glm")
        XCTAssertEqual(zenCloud.filtered.count, 1)
        XCTAssertEqual(zenCloud.filtered.first?.usage.model, "glm-4.6")

        // "copilot" matches the plan name of the GPT row.
        let byPlanName = compute(search: "copilot")
        XCTAssertEqual(byPlanName.filtered.map(\.usage.model), ["gpt-5"])
    }

    func testPlanFilter_unknownPlanYieldsNoRows() {
        let result = compute(planFilter: .plan("does-not-exist"))
        XCTAssertTrue(result.filtered.isEmpty)
        XCTAssertFalse(result.base.isEmpty)
    }

    // MARK: - Keys & parsing

    func testPlanFilter_rawValueRoundTrip() {
        XCTAssertEqual(ModelPlanFilter(rawValue: "").rawValue, "all")
        XCTAssertEqual(ModelPlanFilter(rawValue: "ALL").rawValue, "all")
        XCTAssertEqual(ModelPlanFilter(rawValue: "  Uncovered ").rawValue, "uncovered")
        XCTAssertEqual(ModelPlanFilter(rawValue: "OpenCode-Zen").rawValue, "opencode-zen")
        XCTAssertEqual(ModelPlanFilter(rawValue: "opencode-zen"), .plan("opencode-zen"))
    }

    func testBaseKey_carriesPlanFilter() {
        let base = ModelsPipeline.baseKey(
            catalogCount: 10, revision: 3, usageModels: [], syntheticModels: [],
            search: "", scope: .all, sortColumn: .model, sortAscending: false
        )
        let zen = ModelsPipeline.baseKey(
            catalogCount: 10, revision: 3, usageModels: [], syntheticModels: [],
            search: "", scope: .all, planFilter: .plan("opencode-zen"),
            sortColumn: .model, sortAscending: false
        )
        let uncovered = ModelsPipeline.baseKey(
            catalogCount: 10, revision: 3, usageModels: [], syntheticModels: [],
            search: "", scope: .all, planFilter: .uncovered,
            sortColumn: .model, sortAscending: false
        )
        XCTAssertNotEqual(base, zen)
        XCTAssertNotEqual(zen, uncovered)
    }

    func testScopeQueryValue_acceptsAliases() {
        XCTAssertEqual(ModelFilterScope(queryValue: "all"), .all)
        XCTAssertEqual(ModelFilterScope(queryValue: "free"), .freeOpen)
        XCTAssertEqual(ModelFilterScope(queryValue: "FREE / OPEN"), .freeOpen)
        XCTAssertEqual(ModelFilterScope(queryValue: "local"), .local)
        XCTAssertEqual(ModelFilterScope(queryValue: "used"), .active)
        XCTAssertEqual(ModelFilterScope(queryValue: "benchmarked"), .benchmarked)
        XCTAssertEqual(ModelFilterScope(queryValue: "nonsense"), .all)
    }
}
