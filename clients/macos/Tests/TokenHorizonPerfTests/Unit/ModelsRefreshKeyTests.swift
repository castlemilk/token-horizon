import XCTest
@testable import TokenHorizon

/// The MODELS tab only reruns `ModelsPipeline.compute` when its recompute key
/// changes. Historically that key carried catalog *counts* + revision alone, so
/// per-model token totals, spend and local tok/s — all refreshed every few
/// seconds — never invalidated it and the USAGE column / footer stats froze.
/// These tests pin the content-fingerprint contract.
final class ModelsRefreshKeyTests: XCTestCase {

    private func usage(
        tokens: Int = 1_000,
        cost: Double = 1.0,
        estCost: Double = 0.0
    ) -> ModelUsage {
        ModelUsage(provider: "anthropic", model: "claude-4.5", tokensAll: tokens,
                   tokensToday: tokens, cost: cost, messages: 3, free: false,
                   estCost: estCost)
    }

    private func local(
        speed: Double? = nil,
        promptSpeed: Double? = nil
    ) -> ModelUsage {
        ModelUsage(provider: "ollama", model: "qwen3:8b", tokensAll: 0,
                   tokensToday: 0, cost: 0, messages: 0, free: true,
                   tokPerSec: speed, promptTokPerSec: promptSpeed, isLocal: true)
    }

    private func key(
        catalogCount: Int = 100,
        revision: Int = 7,
        usageModels: [ModelUsage] = [],
        syntheticModels: [ModelUsage] = [],
        search: String = "",
        scope: ModelFilterScope = .all,
        sortColumn: ModelTableColumn = .sweBench,
        sortAscending: Bool = false
    ) -> String {
        ModelsPipeline.baseKey(
            catalogCount: catalogCount, revision: revision,
            usageModels: usageModels, syntheticModels: syntheticModels,
            search: search, scope: scope, sortColumn: sortColumn,
            sortAscending: sortAscending
        )
    }

    // MARK: - Fingerprint reacts to the content that actually changes

    func testFingerprint_changesWhenTokensChange() {
        let before = ModelsPipeline.usageContentFingerprint(usageModels: [usage(tokens: 1_000)], syntheticModels: [])
        let after = ModelsPipeline.usageContentFingerprint(usageModels: [usage(tokens: 2_000)], syntheticModels: [])
        XCTAssertNotEqual(before, after, "token growth must invalidate the recompute key")
    }

    func testFingerprint_changesWhenSpendChanges() {
        let before = ModelsPipeline.usageContentFingerprint(usageModels: [usage(cost: 1.0)], syntheticModels: [])
        let after = ModelsPipeline.usageContentFingerprint(usageModels: [usage(cost: 1.25)], syntheticModels: [])
        XCTAssertNotEqual(before, after, "spend movement must invalidate the recompute key")
    }

    func testFingerprint_changesWhenEstimatedSpendChanges() {
        // estCost is derived for models whose provider reports no cost; it is
        // the only spend signal for those rows.
        let before = ModelsPipeline.usageContentFingerprint(usageModels: [usage(estCost: 0.0)], syntheticModels: [])
        let after = ModelsPipeline.usageContentFingerprint(usageModels: [usage(estCost: 0.75)], syntheticModels: [])
        XCTAssertNotEqual(before, after)
    }

    func testFingerprint_changesWhenLocalSpeedChanges() {
        let before = ModelsPipeline.usageContentFingerprint(usageModels: [], syntheticModels: [local(speed: 42.0)])
        let after = ModelsPipeline.usageContentFingerprint(usageModels: [], syntheticModels: [local(speed: 55.5)])
        XCTAssertNotEqual(before, after, "benchmark results must invalidate the recompute key")
    }

    func testFingerprint_isStableForIdenticalInputs() {
        let first = ModelsPipeline.usageContentFingerprint(usageModels: [usage()], syntheticModels: [local(speed: 40)])
        let second = ModelsPipeline.usageContentFingerprint(usageModels: [usage()], syntheticModels: [local(speed: 40)])
        XCTAssertEqual(first, second)
    }

    func testFingerprint_isStableAcrossReordering() {
        // The key is a sum, so publish order must not cause spurious recomputes
        // (the heavy refresh rebuilds `usage.models` on every tick).
        let first = [usage(tokens: 10), usage(tokens: 20)]
        let second = [usage(tokens: 20), usage(tokens: 10)]
        XCTAssertEqual(
            ModelsPipeline.usageContentFingerprint(usageModels: first, syntheticModels: []),
            ModelsPipeline.usageContentFingerprint(usageModels: second, syntheticModels: [])
        )
    }

    // MARK: - Full key

    func testBaseKey_isStableForIdenticalInputs() {
        XCTAssertEqual(key(usageModels: [usage()]), key(usageModels: [usage()]))
    }

    func testBaseKey_carriesUsageContent() {
        XCTAssertNotEqual(key(usageModels: [usage(tokens: 1)]), key(usageModels: [usage(tokens: 2)]))
    }

    func testBaseKey_reactsWithoutCountOrRevisionChange() {
        // The exact regression: same catalog shape, same model *count*, only
        // the tokens behind one of those models moved.
        let before = key(usageModels: [usage(tokens: 1_000)])
        let after = key(usageModels: [usage(tokens: 1_001)])
        XCTAssertNotEqual(before, after)
    }

    func testBaseKey_carriesEveryInput() {
        let baseline = key()
        XCTAssertNotEqual(baseline, key(catalogCount: 101))
        XCTAssertNotEqual(baseline, key(revision: 8))
        XCTAssertNotEqual(baseline, key(usageModels: [usage()]))
        XCTAssertNotEqual(baseline, key(syntheticModels: [local()]))
        XCTAssertNotEqual(baseline, key(search: "glm"))
        XCTAssertNotEqual(baseline, key(scope: .local))
        XCTAssertNotEqual(baseline, key(sortColumn: .inputPrice))
        XCTAssertNotEqual(baseline, key(sortAscending: true))
    }
}
