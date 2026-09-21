import XCTest
@testable import TokenHorizon

final class CanonicalIdentityTests: XCTestCase {

    // These tests document the actual behavior of `canonicalIdentity`.
    // The function has many provider-specific special cases plus a default fallback
    // where family = "{provider}-{model}" (provider+model prepended, lowercased).

    func testCanonical_claude_specialCase_3_5_sonnet() {
        let r = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "claude-3-5-sonnet")
        XCTAssertEqual(r.family, "claude-3.5-sonnet")
        XCTAssertEqual(r.providerId, "anthropic")
        XCTAssertEqual(r.providerName, "Anthropic")
    }

    func testCanonical_gpt4o_specialCase() {
        let r = ModelCatalog.canonicalIdentity(provider: "openai", model: "gpt-4o")
        XCTAssertEqual(r.family, "gpt-4o")
        XCTAssertEqual(r.providerId, "openai")
        XCTAssertEqual(r.providerName, "OpenAI")
    }

    func testCanonical_gpt_sol_terra_luna() {
        let sol = ModelCatalog.canonicalIdentity(provider: "openai", model: "gpt-5-sol")
        XCTAssertEqual(sol.family, "gpt-5-sol")
        XCTAssertEqual(sol.displayName, "GPT-5 Sol")
        XCTAssertEqual(sol.providerId, "openai")

        let terra = ModelCatalog.canonicalIdentity(provider: "openai", model: "terra")
        XCTAssertEqual(terra.family, "gpt-5-terra")
        XCTAssertEqual(terra.displayName, "GPT-5 Terra")

        let luna = ModelCatalog.canonicalIdentity(provider: "openai", model: "gpt-luna")
        XCTAssertEqual(luna.family, "gpt-5-luna")
        XCTAssertEqual(luna.displayName, "GPT-5 Luna")
    }

    func testCanonical_gpt_5_6_sol_variants() {
        let v1 = ModelCatalog.canonicalIdentity(provider: "neon", model: "gpt-5-6-sol")
        XCTAssertEqual(v1.family, "gpt-5.6-sol")
        XCTAssertEqual(v1.displayName, "GPT-5.6 Sol")
        XCTAssertEqual(v1.providerId, "openai")

        let v2 = ModelCatalog.canonicalIdentity(provider: "venice", model: "openai-gpt-56-sol")
        XCTAssertEqual(v2.family, "gpt-5.6-sol")
        XCTAssertEqual(v2.displayName, "GPT-5.6 Sol")

        let v3 = ModelCatalog.canonicalIdentity(provider: "openai", model: "gpt-5.6-sol")
        XCTAssertEqual(v3.family, "gpt-5.6-sol")
        XCTAssertEqual(v3.displayName, "GPT-5.6 Sol")
    }

    func testCanonical_upstage_solar_not_gpt_sol() {
        let solar1 = ModelCatalog.canonicalIdentity(provider: "upstage", model: "solar-pro3")
        XCTAssertEqual(solar1.family, "solar-pro3")
        XCTAssertEqual(solar1.displayName, "Solar Pro3")
        XCTAssertEqual(solar1.providerId, "upstage")
        XCTAssertEqual(solar1.providerName, "Upstage")

        let solar2 = ModelCatalog.canonicalIdentity(provider: "kilo", model: "upstage/solar-pro-3")
        XCTAssertEqual(solar2.family, "solar-pro-3")
        XCTAssertEqual(solar2.displayName, "Solar Pro 3")
        XCTAssertEqual(solar2.providerId, "upstage")
        XCTAssertEqual(solar2.providerName, "Upstage")

        let lunaris = ModelCatalog.canonicalIdentity(provider: "kilo", model: "sao10k/l3-lunaris-8b")
        XCTAssertNotEqual(lunaris.family, "gpt-5-luna")
    }

    func testModelsPipeline_gpt_5_sol_preserves_authoritative_price() {
        let aggregatorEntry = ModelCatalog.Entry(
            id: "openai/gpt-5-sol",
            name: "GPT 5 Sol (Aggregator)",
            provider: "kilo",
            providerName: "Kilo",
            inputPerM: 0.15,
            outputPerM: 0.60,
            contextK: 128
        )
        let directEntry = ModelCatalog.Entry(
            id: "gpt-5-sol",
            name: "GPT-5 Sol",
            provider: "openai",
            providerName: "OpenAI",
            inputPerM: 2.50,
            outputPerM: 10.00,
            cacheReadPerM: 0.50,
            contextK: 256,
            discountPercent: 50,
            discountLabel: "-50% PROMO",
            originalInputPerM: 5.00,
            originalOutputPerM: 20.00
        )

        // Test with aggregator first in catalog order
        let result = ModelsPipeline.compute(
            search: "gpt-5-sol",
            scope: .all,
            sortColumn: .model,
            sortAscending: true,
            catalog: [aggregatorEntry, directEntry],
            syntheticModels: [],
            usageModels: []
        )

        let solRow = result.filtered.first(where: { $0.id == "openai/gpt-5-sol" })
        XCTAssertNotNil(solRow)
        XCTAssertEqual(solRow?.inputPrice, 2.50)
        XCTAssertEqual(solRow?.outputPrice, 10.00)
        XCTAssertEqual(solRow?.cachePrice, 0.50)
        XCTAssertEqual(solRow?.discountPercent, 50)
        XCTAssertEqual(solRow?.discountLabel, "-50% PROMO")
        XCTAssertEqual(solRow?.inputPriceText, "$2.50")
        XCTAssertEqual(solRow?.originalInputPriceText, "$5.00")
    }

    func testCanonical_gpt_astra() {
        let astra1 = ModelCatalog.canonicalIdentity(provider: "openai", model: "gpt-6-astra")
        XCTAssertEqual(astra1.family, "gpt-6-astra")
        XCTAssertEqual(astra1.displayName, "GPT-6 Astra")
        XCTAssertEqual(astra1.providerId, "openai")

        let astra2 = ModelCatalog.canonicalIdentity(provider: "codex", model: "astra")
        XCTAssertEqual(astra2.family, "gpt-6-astra")
        XCTAssertEqual(astra2.displayName, "GPT-6 Astra")

        let lookup = ModelCatalog.shared.lookup(id: "gpt-6-astra")
        XCTAssertNotNil(lookup)
        XCTAssertEqual(lookup?.name, "GPT-6 Astra")
        XCTAssertEqual(lookup?.inputPerM, 10.00)
        XCTAssertEqual(lookup?.outputPerM, 50.00)
        XCTAssertEqual(lookup?.cacheReadPerM, 1.00)
    }

    func testCanonical_qwen3_specialCase() {
        let r = ModelCatalog.canonicalIdentity(provider: "alibaba", model: "qwen3:8b")
        XCTAssertEqual(r.family, "qwen3-8b")
        XCTAssertEqual(r.providerId, "alibaba")
        XCTAssertEqual(r.providerName, "Alibaba Cloud")
    }

    func testCanonical_glm_specialCase() {
        let r = ModelCatalog.canonicalIdentity(provider: "zai", model: "glm-4-plus")
        XCTAssertEqual(r.family, "glm-4-plus")
        XCTAssertEqual(r.providerId, "glm")
        XCTAssertEqual(r.providerName, "Zhipu AI")
    }

    func testCanonical_kimi_specialCase() {
        let r = ModelCatalog.canonicalIdentity(provider: "kimi", model: "kimi-k2")
        XCTAssertEqual(r.family, "kimi-k2")
        XCTAssertEqual(r.providerId, "kimi")
        XCTAssertEqual(r.providerName, "Moonshot Kimi")
    }

    // Default fallback: family = "{provider}-{model}"
    // (provider prepended, lowercased, colon→dash on the last segment)

    func testCanonical_default_prependsProvider() {
        let r = ModelCatalog.canonicalIdentity(provider: "mixtral-provider", model: "mixtral-7b")
        XCTAssertEqual(r.family, "mixtral-provider-mixtral-7b")
        XCTAssertEqual(r.providerId, "mixtral-provider")
    }

    func testCanonical_default_colonBecomesDash() {
        // "model:v1" → "model-v1" in the default path
        let r = ModelCatalog.canonicalIdentity(provider: "myco", model: "custommodel:v1")
        XCTAssertEqual(r.family, "myco-custommodel-v1")
    }

    // Dedup contract: two catalog entries that the user thinks are "the same model"
    // must produce the same family key when passed through canonicalIdentity.

    func testDedup_openai_vs_azure_gpt4o() {
        let openai = ModelCatalog.canonicalIdentity(provider: "openai", model: "gpt-4o")
        let azure = ModelCatalog.canonicalIdentity(provider: "azure", model: "gpt-4o")
        XCTAssertEqual(openai.family, azure.family)
    }

    // Stability: the function must be deterministic (same input → same output)

    func testStability_sameInputs_sameOutput() {
        let a = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "claude-3-5-sonnet")
        let b = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "claude-3-5-sonnet")
        XCTAssertEqual(a.family, b.family)
        XCTAssertEqual(a.displayName, b.displayName)
    }

    // Empty model: must not crash, must produce something

    func testCanonical_emptyModel_doesNotCrash() {
        let r = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "")
        XCTAssertNotNil(r.family)
        XCTAssertNotNil(r.displayName)
    }

    func testAstra_netPricingAndTopPicks() {
        let lookup = ModelCatalog.shared.lookup(id: "gpt-6-astra")
        XCTAssertNotNil(lookup)
        guard let astra = lookup else { return }

        let usage = ModelUsage(
            provider: "openai",
            model: "gpt-6-astra",
            tokensAll: 0,
            tokensToday: 0,
            cost: 0,
            messages: 0,
            free: false,
            cacheReadAll: 0,
            estCost: 0,
            contextK: astra.contextK,
            isLocal: false
        )
        let row = ModelRow(usage: usage, catalog: astra, hostCount: 1)
        XCTAssertEqual(row.inputPrice, 10.00)
        XCTAssertEqual(row.outputPrice, 50.00)
        XCTAssertEqual(row.cachePrice, 1.00)
        XCTAssertEqual(row.discountPercent, 90)

        // Effective input price incorporates 80% prompt caching hit rate (0.2 * 10 + 0.8 * 1 = 2.80)
        XCTAssertEqual(row.effectiveInputPrice, 2.80, accuracy: 0.01)
        // Blended net cost across 3:1 input:output ratio: (2.80 * 3 + 50) / 4 = 14.60
        XCTAssertEqual(row.blendedNetCost, 14.60, accuracy: 0.01)
        XCTAssertTrue(row.netSavingsPercent >= 25)

        // Verify top picks selection
        let catalog = ModelCatalog.shared.allEntries()
        let result = ModelsPipeline.compute(
            search: "",
            scope: .all,
            sortColumn: .sweBench,
            sortAscending: false,
            catalog: catalog,
            syntheticModels: [],
            usageModels: []
        )

        let pickIds = result.topPicks.map { $0.id.lowercased() }
        let astraFound = pickIds.contains { $0.contains("astra") }
        XCTAssertTrue(astraFound, "GPT-6 Astra must be selected into Top Picks based on frontier Pareto value ranking")
    }
}
