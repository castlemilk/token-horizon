import XCTest
@testable import TokenHorizon

/// Contract tests for the web catalog export (`/models/catalog` +
/// `docs/data/models.json`): the dashboard depends on these keys and shapes.
final class ModelCatalogExportTests: XCTestCase {

    func testPayload_carriesSchemaAndCounts() throws {
        let payload = ModelCatalogExport.payload()
        XCTAssertEqual(payload["schemaVersion"] as? Int, 1)
        XCTAssertEqual(payload["count"] as? Int, (payload["models"] as? [[String: Any]])?.count)
        XCTAssertNotNil(payload["generatedAt"] as? Int)
        XCTAssertNotNil(payload["catalogCount"] as? Int)
        XCTAssertFalse((payload["providers"] as? [[String: Any]])?.isEmpty ?? true)
    }

    func testModels_exposeExplorerFields() throws {
        let payload = ModelCatalogExport.payload()
        let models = try XCTUnwrap(payload["models"] as? [[String: Any]], "models array missing")
        XCTAssertFalse(models.isEmpty, "live cache or built-in flagships must yield entries")
        for row in models.prefix(50) {
            XCTAssertNotNil(row["id"] as? String)
            XCTAssertNotNil(row["name"] as? String)
            XCTAssertNotNil(row["provider"] as? String)
            XCTAssertNotNil(row["providerName"] as? String)
            XCTAssertNotNil(row["category"] as? String)
            XCTAssertTrue(row["inputPerM"] != nil && row["outputPerM"] != nil,
                          "pricing keys must always be present for the explorer columns")
        }
    }

    func testTopPicks_areRankedAndScored() throws {
        let picks = try XCTUnwrap(ModelCatalogExport.payload()["topPicks"] as? [[String: Any]],
                                   "topPicks array missing")
        XCTAssertFalse(picks.isEmpty)
        let ranks = picks.compactMap { $0["rank"] as? Int }
        XCTAssertEqual(ranks, Array(1...picks.count), "picks must be 1..n in order")
        for pick in picks {
            XCTAssertNotNil(pick["id"] as? String)
            XCTAssertNotNil(pick["valueScore"] as? Double)
            XCTAssertNotNil(pick["badge"] as? String)
            XCTAssertNotNil(pick["reason"] as? String)
        }
    }

    func testBenchmarks_includeCuratedAuxiliaryScores() throws {
        let payload = ModelCatalogExport.payload()
        let models = try XCTUnwrap(payload["models"] as? [[String: Any]])
        let withSwe = models.filter { ($0["benchmarks"] as? [String: Any])?["swe"] != nil }
        XCTAssertFalse(withSwe.isEmpty, "at least the curated flagship benchmarks must surface")
        // AIME/GPQA only exist in Resources/benchmarks.json; when that file is
        // reachable (repo checkout) the export enriches the same rows.
        let aux = ModelCatalogExport.auxiliaryBenchmarks()
        if !aux.isEmpty {
            let enriched = models.contains { row in
                let bench = row["benchmarks"] as? [String: Any]
                return bench?["aime"] != nil || bench?["gpqa"] != nil
            }
            XCTAssertTrue(enriched, "benchmarks.json entries must enrich exported rows")
        }
    }

    func testData_isValidJSON() throws {
        let data = ModelCatalogExport.data()
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["schemaVersion"] as? Int, 1)
    }

    func testCategory_neverEmpty() throws {
        let models = try XCTUnwrap(ModelCatalogExport.payload()["models"] as? [[String: Any]])
        for row in models {
            let category = row["category"] as? String ?? ""
            XCTAssertFalse(category.isEmpty)
        }
    }

    func testPricing_neverClaimsFreeWithoutEvidence() throws {
        // Regression: subscription-plan models (Kimi Code, Copilot, …) publish
        // `cost: 0`, which used to surface as "Free" with a fake $0.04 blended
        // price. Zero-price rows may only be free with explicit evidence.
        let models = try XCTUnwrap(ModelCatalogExport.payload()["models"] as? [[String: Any]])
        var unknown = 0
        for row in models {
            XCTAssertNotNil(row["priceKnown"] as? Bool, "every row carries priceKnown")
            let input = row["inputPerM"] as? Double ?? 0
            let output = row["outputPerM"] as? Double ?? 0
            guard input == 0, output == 0, row["isLocal"] as? Bool != true else { continue }
            let isFree = row["isFree"] as? Bool ?? false
            let known = row["priceKnown"] as? Bool ?? true
            if isFree {
                let hay = ((row["name"] as? String ?? "") + " " + (row["id"] as? String ?? "")).lowercased()
                XCTAssertTrue(hay.contains("free"),
                              "zero-price row claimed free without evidence: \(row["id"] as? String ?? "?")")
                XCTAssertTrue(known, "explicitly free rows must have known pricing")
            }
            if !known {
                unknown += 1
                XCTAssertNil(row["blendedNetCost"], "unknown pricing must not carry a blended cost")
                XCTAssertNil(row["effectiveInputPerM"], "unknown pricing must not carry an effective price")
            }
        }
        try XCTSkipIf(unknown == 0, "sparse catalog (no live cache) has no unpriced rows to guard")
    }

    func testTopPicks_carryPriceKnown() throws {
        let picks = try XCTUnwrap(ModelCatalogExport.payload()["topPicks"] as? [[String: Any]])
        for pick in picks {
            XCTAssertNotNil(pick["priceKnown"] as? Bool)
        }
    }

    func testNameAccuracy_stemsAndVersionDots() {
        // Version dots lost by the display formatter are restored from the family.
        XCTAssertEqual(ModelCatalogExport.cleanDisplayName("GPT 5 1", family: "gpt-5-1"), "GPT 5.1")
        XCTAssertEqual(ModelCatalogExport.cleanDisplayName("Grok 4 3", family: "grok-4-3"), "Grok 4.3")
        XCTAssertEqual(ModelCatalogExport.cleanDisplayName("Claude Sonnet 4 6 Thinking", family: "claude-sonnet-4-6-thinking"),
                       "Claude Sonnet 4.6 Thinking")
        XCTAssertEqual(ModelCatalogExport.cleanDisplayName("Qwen3 30B A3b Thinking", family: "qwen3-30b-a3b-thinking"),
                       "Qwen3 30B A3b Thinking", "no false dot insertion mid-token")
        // Prefix/separator variants collapse to one stem.
        XCTAssertEqual(ModelCatalogExport.nameStem("OpenAI GPT 5.5"), ModelCatalogExport.nameStem("GPT-5.5"))
        XCTAssertEqual(ModelCatalogExport.nameStem("Kimi K3"), ModelCatalogExport.nameStem("Moonshot Kimi K3"))
        XCTAssertEqual(ModelCatalogExport.nameStem("MiniMax M2.7"), ModelCatalogExport.nameStem("MiniMax M27"))
        XCTAssertNotEqual(ModelCatalogExport.nameStem("GPT-5.5"), ModelCatalogExport.nameStem("GPT-5.5 Pro"))
        XCTAssertNotEqual(ModelCatalogExport.nameStem("Claude Opus 4.6"), ModelCatalogExport.nameStem("Claude Sonnet 4.6"))
    }

    /// Hermetic: cheapest-per-provider wins, cache>input prices are dropped.
    /// (CI runners have no live model cache, so payload-richness checks below
    /// must not require multi-provider families to exist.)
    func testListingSpread_cheapestPerProviderAndCacheClamp() {
        func entry(_ provider: String, input: Double, output: Double, cache: Double?) -> ModelCatalog.Entry {
            ModelCatalog.Entry(id: "claude-test", name: "Claude Test", provider: provider, providerName: provider,
                               inputPerM: input, outputPerM: output, cacheReadPerM: cache,
                               contextK: 128, benchmarks: nil, docUrl: nil, description: nil,
                               reasoning: nil, toolCall: nil, vision: nil, openWeights: nil,
                               discountPercent: nil, discountLabel: nil, discountDetail: nil,
                               originalInputPerM: nil, originalOutputPerM: nil)
        }
        // Recognized lab models canonicalize the same family across providers
        // (e.g. anthropic direct and an OpenRouter listing of the same model).
        let entries = [
            entry("anthropic", input: 5, output: 25, cache: 1),
            entry("anthropic", input: 9, output: 40, cache: nil),    // same provider, pricier → dropped
            entry("openrouter", input: 2.5, output: 12, cache: 9),   // cache above input → clamped to nil
            entry("openrouter", input: 3, output: 13, cache: 0.3),   // same provider, pricier → dropped
        ]
        let family = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "claude-test").family
        let listings = ModelCatalogExport.listingsByFamily(entries)[family] ?? []
        XCTAssertEqual(listings.count, 2, "one listing per provider")
        XCTAssertEqual(listings.first(where: { $0.provider == "openrouter" })?.inputPerM, 2.5)
        XCTAssertNil(listings.first(where: { $0.provider == "openrouter" })?.cacheReadPerM,
                     "cache above input must be dropped")
        XCTAssertEqual(listings.first(where: { $0.provider == "anthropic" })?.inputPerM, 5)
    }

    func testListingSpread_reportsCheapestTruthfulPrice() throws {
        let models = try XCTUnwrap(ModelCatalogExport.payload()["models"] as? [[String: Any]])
        let withListings = models.filter { ($0["listingCount"] as? Int ?? 0) > 1 }
        for row in withListings {
            let listings = row["listings"] as? [[String: Any]] ?? []
            XCTAssertFalse(listings.isEmpty)
            for listing in listings {
                XCTAssertNotNil(listing["provider"] as? String)
                // Cache pricing above input is dropped, never reported.
                if let cache = listing["cacheReadPerM"] as? Double,
                   let input = listing["inputPerM"] as? Double, input > 0 {
                    XCTAssertLessThanOrEqual(cache, input, "cache price above input for \(row["id"] ?? "?")")
                }
            }
            if let from = row["priceFrom"] as? Double {
                XCTAssertGreaterThan(from, 0)
                XCTAssertNotNil(row["priceFromProvider"] as? String)
                let canonical = row["inputPerM"] as? Double ?? 0
                XCTAssertTrue(canonical <= 0 || from < canonical, "priceFrom only when cheaper than the canonical listing")
            }
        }
    }

    func testCachePricing_neverExceedsInput() throws {
        let models = try XCTUnwrap(ModelCatalogExport.payload()["models"] as? [[String: Any]])
        for row in models {
            guard let cache = row["cacheReadPerM"] as? Double,
                  let input = row["inputPerM"] as? Double, input > 0 else { continue }
            XCTAssertLessThanOrEqual(cache, input, "implausible cache pricing leaked for \(row["id"] ?? "?")")
        }
    }

    func testPlans_carryTiersAndModelLinkage() throws {
        let payload = ModelCatalogExport.payload()
        let plans = try XCTUnwrap(payload["plans"] as? [[String: Any]], "plans array missing")
        XCTAssertFalse(plans.isEmpty, "curated plans.json must ship")
        XCTAssertNotNil(payload["plansUpdatedAt"] as? String)
        let ids = Set(plans.compactMap { $0["id"] as? String })
        XCTAssertTrue(ids.contains("github-copilot"))
        // Curated tier data for the plans we have verified, docs for the rest.
        let copilot = try XCTUnwrap(plans.first { $0["id"] as? String == "github-copilot" })
        let tiers = try XCTUnwrap(copilot["tiers"] as? [[String: Any]])
        XCTAssertEqual(tiers.count, 7)
        XCTAssertEqual(tiers.first?["name"] as? String, "Free")
        XCTAssertEqual(tiers.first?["priceMonthly"] as? Double, 0)

        // Any row that references a plan must use a curated id.
        let models = try XCTUnwrap(payload["models"] as? [[String: Any]])
        for row in models {
            for planId in (row["plans"] as? [String]) ?? [] {
                XCTAssertTrue(ids.contains(planId), "row references unknown plan \(planId)")
            }
        }
    }

    /// Hermetic plan linkage: rows match plans through their source provider
    /// listings (the canonical merge drops plan provider ids).
    func testPlanLinkage_matchesSourceProviderListings() {
        let usage = ModelUsage(provider: "kimi", model: "k3", tokensAll: 0, tokensToday: 0,
                               cost: 0, messages: 0, free: false)
        let row = ModelRow(usage: usage, catalog: nil)
        let listings: [String: [ModelCatalogExport.Listing]] = ["k3": [
            ModelCatalogExport.Listing(provider: "kimi-for-coding", inputPerM: 0, outputPerM: 0, cacheReadPerM: nil),
            ModelCatalogExport.Listing(provider: "openrouter", inputPerM: 2.6, outputPerM: 13.2, cacheReadPerM: 0.3),
        ]]
        let plans: [[String: Any]] = [
            ["id": "kimi-for-coding", "providers": ["kimi-for-coding"]],
            ["id": "unrelated-plan", "providers": ["someone-else"]],
        ]
        XCTAssertEqual(ModelCatalogExport.planIds(for: row, listings: listings, plans: plans), ["kimi-for-coding"])
        XCTAssertEqual(ModelCatalogExport.planIds(for: row, listings: [:], plans: plans), [])
    }
}
