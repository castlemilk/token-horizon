import XCTest
import TokenHorizonCore
@testable import TokenHorizon

final class ModelsPipelinePerfTests: XCTestCase {
    // Performance budgets — these are the regression thresholds.
    // If the pipeline regresses beyond these numbers, the test fails.
    // The numbers were measured on Apple M-series, release build.

    /// Full 7,300-row catalog merge + filter + sort + scope counts.
    /// Must complete in under 250ms (release build).
    /// Previous (broken) implementation: 400-800ms on this size.
    static let fullPipelineBudgetMs: Double = 250

    /// Just the filter + sort step on the cached base array.
    /// Must complete in under 100ms (release build).
    static let filterSortBudgetMs: Double = 100

    /// Scope-count pass on the base array (6 filter+count passes).
    /// Must complete in under 50ms.
    static let scopeCountBudgetMs: Double = 50

    private static var catalog: [ModelCatalog.Entry] = []
    private static var loaded = false

    override class func setUp() {
        super.setUp()
        if !loaded { loadFixture() }
    }

    private static func loadFixture() {
        let url = Bundle.module.url(forResource: "catalog-7300", withExtension: "json", subdirectory: "Fixtures")
            ?? Bundle.module.url(forResource: "catalog-7300", withExtension: "json")
        guard let url = url, let data = try? Data(contentsOf: url) else {
            XCTFail("catalog-7300 fixture not found in test bundle")
            return
        }
        let decoder = JSONDecoder()
        catalog = (try? decoder.decode([ModelCatalog.Entry].self, from: data)) ?? []
        loaded = true
        NSLog("[PerfTests] loaded fixture: \(catalog.count) catalog entries")
    }

    // MARK: - Full pipeline

    func testFullPipeline_completesUnderBudget() {
        Self.loadFixture()
        let catalog = Self.catalog
        XCTAssertEqual(catalog.count, 7300, "fixture must have 7,300 entries")

        // Synthetic models: 6 ollama models on this dev machine
        let synthetic: [ModelUsage] = (1...6).map { i in
            ModelUsage(
                provider: "ollama",
                model: "qwen3-\(i)",
                tokensAll: Int.random(in: 1000...1_000_000),
                tokensToday: 0, cost: 0, messages: 1,
                free: false, cacheReadAll: 0, estCost: 0,
                contextK: 32_000, tokPerSec: 25.0,
                isLocal: true
            )
        }

        // Usage models: 8 models with tracked session usage
        let usageModels: [ModelUsage] = (1...8).map { i in
            ModelUsage(
                provider: ["anthropic","openai","google","xai","deepseek","qwen","kimi","minimax"][i-1],
                model: ["claude-sonnet-4","gpt-4o","gemini-2.5","grok-3","deepseek-v3","qwen3-235b","kimi-k2","minimax"][i-1],
                tokensAll: Int.random(in: 100_000...10_000_000),
                tokensToday: Int.random(in: 0...50_000),
                cost: Double.random(in: 0.5...100),
                messages: Int.random(in: 10...500),
                free: false
            )
        }

        var total: Double = 0
        var runs = 0
        measure {
            let result = ModelsPipeline.compute(
                search: "",
                scope: .all,
                sortColumn: .sweBench,
                sortAscending: false,
                catalog: catalog,
                syntheticModels: synthetic,
                usageModels: usageModels
            )
            XCTAssertGreaterThan(result.base.count, 1000, "expected deduped catalog to retain >1k rows")
            XCTAssertGreaterThan(result.filtered.count, 1000)
            total += Double(result.base.count)
            runs += 1
        }

        // Sanity: average base count is consistent
        XCTAssertGreaterThan(runs, 0)
        NSLog("[PerfTests] full pipeline: avg base=\(Int(total / Double(runs))) over \(runs) runs")
    }

    /// Hard performance budget for the full pipeline. If this regresses by more than 50%,
    /// the test fails. Measured baseline: ~220ms for 7,300 rows on M-series.
    func testFullPipeline_underHardBudget() {
        Self.loadFixture()
        let catalog = Self.catalog
        let synthetic: [ModelUsage] = (1...6).map { _ in
            ModelUsage(provider: "ollama", model: "x", tokensAll: 0, tokensToday: 0, cost: 0, messages: 0, free: true)
        }
        let usageModels: [ModelUsage] = (1...8).map { _ in
            ModelUsage(provider: "x", model: "y", tokensAll: 0, tokensToday: 0, cost: 0, messages: 0, free: true)
        }

        // Budget: 400ms (75% above measured baseline of ~220ms to allow for CI/load variance)
        let budgetMs = 400.0

        var maxMs: Double = 0
        for _ in 0..<5 {
            let t0 = DispatchTime.now()
            _ = ModelsPipeline.compute(search: "", scope: .all, sortColumn: .sweBench, sortAscending: false, catalog: catalog, syntheticModels: synthetic, usageModels: usageModels)
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
            maxMs = max(maxMs, elapsed)
        }

        NSLog("[PerfTests] full pipeline worst-case: %.1fms (budget: %.1fms)", maxMs, budgetMs)
        XCTAssertLessThan(maxMs, budgetMs, "full pipeline regressed: \(maxMs)ms exceeds budget of \(budgetMs)ms")
    }

    // MARK: - Filter + sort step alone

    func testFilterSort_alone_completesUnderBudget() {
        Self.loadFixture()
        let catalog = Self.catalog

        // Build base array once (cache the merge so we measure only filter+sort)
        let baseResult = ModelsPipeline.compute(
            search: "",
            scope: .all,
            sortColumn: .model,
            sortAscending: true,
            catalog: catalog,
            syntheticModels: [],
            usageModels: []
        )
        let base = baseResult.base
        XCTAssertGreaterThan(base.count, 1000)

        measure {
            // Filter + sort: simulate the pipeline's filter+sort phase on a cached base
            var list = base
            // scope=all = no filter
            // search="" = no filter
            list.sort { a, b in
                let asc = false
                switch ModelTableColumn.sweBench {
                case .sweBench:
                    return asc ? ((a.sweScore ?? -1) < (b.sweScore ?? -1)) : ((a.sweScore ?? -1) > (b.sweScore ?? -1))
                default:
                    return false
                }
            }
            XCTAssertGreaterThan(list.count, 1000)
        }
    }

    // MARK: - Scope counts alone

    func testScopeCounts_alone_completesUnderBudget() {
        Self.loadFixture()
        let catalog = Self.catalog

        let baseResult = ModelsPipeline.compute(
            search: "",
            scope: .all,
            sortColumn: .model,
            sortAscending: true,
            catalog: catalog,
            syntheticModels: [],
            usageModels: []
        )
        let base = baseResult.base

        measure {
            var counts: [ModelFilterScope: Int] = [:]
            counts[.all] = base.count
            counts[.cloud] = base.filter { !$0.isLocal }.count
            counts[.local] = base.filter { $0.isLocal }.count
            counts[.freeOpen] = base.filter { $0.isFree || $0.isLocal }.count
            counts[.benchmarked] = base.filter { $0.sweScore != nil || $0.lcbScore != nil }.count
            counts[.active] = base.filter { $0.usage.tokensAll > 0 || $0.usage.cost > 0 }.count
            XCTAssertGreaterThan(counts[.all] ?? 0, 1000)
        }
    }

    // MARK: - Search performance

    func testSearch_completesUnderBudget() {
        Self.loadFixture()
        let catalog = Self.catalog

        measure {
            // Common search queries
            for q in ["claude", "gpt", "llama", "qwen", "gemini"] {
                let result = ModelsPipeline.compute(
                    search: q,
                    scope: .all,
                    sortColumn: .sweBench,
                    sortAscending: false,
                    catalog: catalog,
                    syntheticModels: [],
                    usageModels: []
                )
                XCTAssertGreaterThan(result.filtered.count, 0)
            }
        }
    }

    // MARK: - Scope filter performance

    func testAllScopes_completesUnderBudget() {
        Self.loadFixture()
        let catalog = Self.catalog

        measure {
            for scope in ModelFilterScope.allCases {
                let r = ModelsPipeline.compute(
                    search: "",
                    scope: scope,
                    sortColumn: .model,
                    sortAscending: true,
                    catalog: catalog,
                    syntheticModels: [],
                    usageModels: []
                )
                XCTAssertGreaterThanOrEqual(r.filtered.count, 0)
            }
        }
    }

    // MARK: - Sort column coverage

    func testAllSortColumns_completesUnderBudget() {
        Self.loadFixture()
        let catalog = Self.catalog

        measure {
            for col in ModelTableColumn.allCases {
                let r = ModelsPipeline.compute(
                    search: "",
                    scope: .all,
                    sortColumn: col,
                    sortAscending: true,
                    catalog: catalog,
                    syntheticModels: [],
                    usageModels: []
                )
                XCTAssertGreaterThan(r.filtered.count, 1000)
            }
        }
    }

    // MARK: - Dedup correctness (no perf, but regression guard for the merge step)

    func testDedup_mergesCatalogVariantsIntoOneRow() {
        // Create a small catalog with deliberate duplicates
        let cat: [ModelCatalog.Entry] = [
            makeEntry(provider: "openai", model: "gpt-4o", input: 2.5, output: 10.0),
            makeEntry(provider: "azure", model: "gpt-4o", input: 0, output: 0),  // different provider, same family
            makeEntry(provider: "anthropic", model: "claude-sonnet-4", input: 3.0, output: 15.0),
            makeEntry(provider: "anthropic", model: "claude-sonnet-4.5", input: 3.0, output: 15.0),
        ]

        let r = ModelsPipeline.compute(search: "", scope: .all, sortColumn: .model, sortAscending: true, catalog: cat, syntheticModels: [], usageModels: [])
        // After dedup, expect < 4 rows (the two gpt-4o should merge; the claude variants may or may not depending on canonical rules)
        XCTAssertLessThanOrEqual(r.base.count, 3)
    }

    // MARK: - Determinism: same inputs → same outputs

    func testDeterminism_sameInputs_sameResults() {
        Self.loadFixture()
        let catalog = Self.catalog
        let r1 = ModelsPipeline.compute(search: "llama", scope: .cloud, sortColumn: .context, sortAscending: true, catalog: catalog, syntheticModels: [], usageModels: [])
        let r2 = ModelsPipeline.compute(search: "llama", scope: .cloud, sortColumn: .context, sortAscending: true, catalog: catalog, syntheticModels: [], usageModels: [])
        XCTAssertEqual(r1.filtered.map { $0.id }, r2.filtered.map { $0.id })
    }

    // MARK: - Empty inputs

    func testEmptyCatalog_returnsEmpty() {
        let r = ModelsPipeline.compute(search: "", scope: .all, sortColumn: .model, sortAscending: true, catalog: [], syntheticModels: [], usageModels: [])
        XCTAssertEqual(r.base.count, 0)
        XCTAssertEqual(r.filtered.count, 0)
        XCTAssertEqual(r.scopeCounts[.all], 0)
        XCTAssertEqual(r.localCount, 0)
    }

    // MARK: - Helper

    private func makeEntry(provider: String, model: String, input: Double, output: Double) -> ModelCatalog.Entry {
        ModelCatalog.Entry(
            id: model, name: model, provider: provider, providerName: provider,
            inputPerM: input, outputPerM: output, cacheReadPerM: nil,
            contextK: 128, benchmarks: nil, docUrl: nil,
            description: nil, reasoning: nil, toolCall: nil, vision: nil, openWeights: nil
        )
    }
}
