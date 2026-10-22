import XCTest
@testable import TokenHorizon

/// Regression tests for the catalog data-quality fixes:
///  1. identity fragmentation (regional/brand/date affixes + version hyphenation),
///  2. codex-exclusive models that vanish from the published artifact,
///  3. price float-corruption / negative prices / junk context windows.
final class CatalogDataQualityTests: XCTestCase {

    // MARK: 1. Identity fragmentation

    func testRegionalPrefix_collapsesToBaseFamily() {
        // "us.anthropic.claude-sonnet-5" must resolve to the same family as "claude-sonnet-5".
        let regional = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "us.anthropic.claude-sonnet-5")
        let base = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "claude-sonnet-5")
        XCTAssertEqual(regional.family, "claude-sonnet-5")
        XCTAssertEqual(regional.family, base.family)
    }

    func testBrandDoublePrefix_strippedButOwnStemKept() {
        let doubled = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "anthropic.claude-opus-5-5")
        XCTAssertEqual(doubled.family, "claude-opus-5.5")
        // A model's own "claude-" stem must never be stripped.
        let ownStem = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "claude-sonnet-5")
        XCTAssertEqual(ownStem.family, "claude-sonnet-5")
    }

    func testDateSuffix_strippedAndVersionFolded() {
        let dated = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "claude-haiku-4-5@20251001")
        XCTAssertEqual(dated.family, "claude-haiku-4.5")
    }

    func testVersionHyphenation_dedupesDotAndHyphenForms() {
        let hyphen = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "claude-opus-5-5")
        let dot = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "claude-opus-5.5")
        XCTAssertEqual(hyphen.family, "claude-opus-5.5")
        XCTAssertEqual(hyphen.family, dot.family)
    }

    func testLegacyVersionFolds_preserved() {
        // The pre-existing 3-5 / 3-7 folds must keep working via the new regex.
        let r = ModelCatalog.canonicalIdentity(provider: "anthropic", model: "claude-3-5-sonnet")
        XCTAssertEqual(r.family, "claude-3.5-sonnet")
    }

    // MARK: 2. Codex-exclusive flagships

    func testCodexFlagships_presentWithRealContextAndPrice() {
        // gpt-6.1-sol is the most-used model on this machine yet is absent from the
        // published artifact because CI lacks ~/.codex/models_cache.json. It must now
        // resolve from the pinned flagships regardless.
        for (id, input, output) in [("gpt-6.1-sol", 2.50, 10.00), ("gpt-6-sol", 2.50, 10.00), ("gpt-6-luna", 0.10, 0.40)] {
            guard let hit = ModelCatalog.shared.lookup(id: id) else {
                XCTFail("\(id) must be present in the catalog"); continue
            }
            XCTAssertEqual(hit.contextK, 872, "\(id) context mirrors codex max_context_window=872000")
            XCTAssertEqual(hit.inputPerM, input, accuracy: 0.001, "\(id) input price")
            XCTAssertEqual(hit.outputPerM, output, accuracy: 0.001, "\(id) output price")
        }
    }

    // MARK: 3. Price / context hygiene

    func testNormalized_repairsFloatCorruptedPrice() {
        let e = ModelCatalog.Entry(
            id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5",
            provider: "anthropic", providerName: "Anthropic",
            inputPerM: 0.09999999999999999, outputPerM: 0.8000000000000001,
            cacheReadPerM: 0.008000000000000002, contextK: 200
        )
        let n = ModelCatalog.normalized(e)
        XCTAssertEqual(n.inputPerM, 0.1, accuracy: 1e-9)
        XCTAssertEqual(n.outputPerM, 0.8, accuracy: 1e-9)
        XCTAssertEqual(n.cacheReadPerM ?? -1, 0.008, accuracy: 1e-9)
    }

    func testNormalized_clampsNegativePrices() {
        let e = ModelCatalog.Entry(
            id: "openrouter/openrouter-auto-beta", name: "Auto",
            provider: "openrouter", providerName: "OpenRouter",
            inputPerM: -1.25, outputPerM: -3.5, contextK: 128
        )
        let n = ModelCatalog.normalized(e)
        XCTAssertEqual(n.inputPerM, 0)
        XCTAssertEqual(n.outputPerM, 0)
    }

    func testNormalized_resetsJunkContextWindow() {
        // Media/router placeholders ship contextK = 99999 (99M tokens) — not a real window.
        let junk = ModelCatalog.Entry(
            id: "qiniu-ai/kling-v2-6", name: "Kling",
            provider: "qiniu-ai", providerName: "Qiniu",
            inputPerM: 1, outputPerM: 1, contextK: 99999
        )
        XCTAssertEqual(ModelCatalog.normalized(junk).contextK, 0)

        // A legitimate large window (llama4-scout 10M tokens = 10000K) must survive.
        let legit = ModelCatalog.Entry(
            id: "meta/llama4-scout", name: "Llama 4 Scout",
            provider: "meta", providerName: "Meta",
            inputPerM: 1, outputPerM: 1, contextK: 10000
        )
        XCTAssertEqual(ModelCatalog.normalized(legit).contextK, 10000)
    }

    // MARK: 4. Benchmark accuracy — one source of truth

    /// The curated table spells generations two ways ("claude-3-7-sonnet" and
    /// "claude-3.7-sonnet"). Both spellings must resolve to the same score:
    /// a separator mismatch used to make every flagship fall back to a
    /// hardcoded literal, so the table's number never reached the catalog.
    func testBenchmarkTable_bridgesDotAndHyphenSpellings() {
        let table = ModelCatalog.loadBenchmarks()
        // Hyphenated key → dotted alias (ids and flagships spell versions with dots).
        XCTAssertEqual(table["claude-3.7-sonnet"]?.swe, 77.6)
        XCTAssertEqual(table["claude-3.7-sonnet"]?.lcb, 70.3)
        XCTAssertEqual(table["claude-3.5-sonnet"]?.swe, 74.5)
        XCTAssertEqual(table["gemini-2.5-pro"]?.swe, 63.8)
        // Dotted key → hyphenated alias (gateways that spell versions hyphenated).
        XCTAssertEqual(table["gemini-3-7-flash"]?.swe, 67.0)
        // The raw spelling always keeps its own row.
        XCTAssertEqual(table["claude-3-7-sonnet"]?.swe, 77.6)
        XCTAssertEqual(table["claude-3-5-haiku"]?.lcb, 43.1)
    }

    /// The four frontier Anthropic scores used to live only as Swift literals
    /// in the fallback chain, so they had no single source and no provenance
    /// flag. They now live in the curated table like every other score.
    func testClaudeFlagshipScores_liveInTheCuratedTable() {
        let table = ModelCatalog.loadBenchmarks()
        XCTAssertEqual(table["claude-opus-5"]?.swe, 82.0)
        XCTAssertEqual(table["claude-opus-5"]?.lcb, 79.0)
        XCTAssertEqual(table["claude-opus-4-6"]?.swe, 76.5)
        XCTAssertEqual(table["claude-opus-4-6"]?.lcb, 74.0)
        XCTAssertEqual(table["claude-fable-5-1"]?.swe, 84.0)
        XCTAssertEqual(table["claude-fable-5-1"]?.lcb, 80.5)
        XCTAssertEqual(table["claude-haiku-4-5"]?.swe, 40.6)
        XCTAssertEqual(table["claude-haiku-4-5"]?.lcb, 43.1)
        // Hand-curated constants are estimates: they must say so.
        for key in ["claude-opus-5", "claude-opus-4-6", "claude-fable-5-1", "claude-haiku-4-5"] {
            XCTAssertEqual(table[key]?.approx, true, "\(key) must be flagged approximate")
        }
    }

    /// `curatedBenchmark` is the table-first resolver for hand-authored
    /// fallback entries: the curated table wins, the caller's literal is only
    /// the last resort for a missing table.
    func testCuratedBenchmark_prefersTableOverLiteral() {
        let stale = ModelCatalog.Benchmarks(swe: 70.3, lcb: 71.0, source: "Anthropic")
        let hit = ModelCatalog.curatedBenchmark("claude-3.7-sonnet", or: stale)
        XCTAssertEqual(hit.swe, 77.6)
        XCTAssertEqual(hit.lcb, 70.3)
        XCTAssertEqual(hit.source, "Anthropic")

        // An unknown key keeps the caller's literal.
        let miss = ModelCatalog.curatedBenchmark("no-such-model", or: stale)
        XCTAssertEqual(miss, stale)
    }

    /// The synthesized fallback for an unknown id must carry the curated
    /// score. It used to ship 70.3/71 for claude-3.7-sonnet while the table
    /// said 77.6/70.3 — the same model, two different numbers.
    func testLookupSynthesis_usesCuratedTableScore() {
        let entry = ModelCatalog.shared.lookup(id: "anthropic/claude-3.7-sonnet-unknown-route")
        XCTAssertEqual(entry?.id, "claude-3.7-sonnet")
        XCTAssertEqual(entry?.benchmarks?.swe, 77.6)
        XCTAssertEqual(entry?.benchmarks?.lcb, 70.3)
    }

    /// A dated route is a frozen snapshot of the same weights: it inherits the
    /// canonical score and says it is approximate, exactly like a `-free` tier.
    func testDatedRoute_inheritsCanonicalScoreAsApproximate() {
        let table = ModelCatalog.loadBenchmarks()
        let dated = ModelCatalog.benchmarkLookup(norm: "claude-3-5-sonnet-20241022",
                                                 fullKey: "anthropic/claude-3-5-sonnet-20241022",
                                                 table: table)
        XCTAssertEqual(dated?.swe, 74.5)
        XCTAssertEqual(dated?.lcb, 67.2)
        XCTAssertEqual(dated?.approx, true, "an inherited score must read as approximate")

        // The dotted spelling of the same snapshot resolves the same way.
        let dotted = ModelCatalog.benchmarkLookup(norm: "claude-3.5-sonnet-20241022",
                                                  fullKey: "anthropic/claude-3.5-sonnet-20241022",
                                                  table: table)
        XCTAssertEqual(dotted?.swe, 74.5)

        // A model whose trailing digits are a size, not a date, keeps its id.
        XCTAssertNil(ModelCatalog.baseWeightsKey("gemma-4-31b"))
    }

    // MARK: 5. One model, one row

    /// The routes a model is sold on are listings of that model, not separate
    /// rows. "o3" reached 14 sellers and was listed 14 times, each with its
    /// own price — so the explorer could not compare them.
    func testCatalog_listsAModelOnceAcrossItsRoutes() throws {
        let payload = ModelCatalogExport.payload()
        let models = try XCTUnwrap(payload["models"] as? [[String: Any]])
        var byName: [String: Int] = [:]
        for m in models {
            let name = (m["name"] as? String ?? "").lowercased()
            guard !name.isEmpty else { continue }
            byName[name, default: 0] += 1
        }
        XCTAssertLessThanOrEqual(byName["o3"] ?? 0, 2, "o3 must not be listed once per seller")
        XCTAssertLessThanOrEqual(byName["gpt-5"] ?? 0, 2, "gpt-5 must not be listed once per seller")
        XCTAssertLessThanOrEqual(byName["claude-opus-4.6"] ?? 0, 2, "claude-opus-4.6 must not be listed once per seller")
    }

    /// A service tier is a different model with a different price: "gpt-5-batch"
    /// costs half of "gpt-5". Folding the tier into the base model gave the
    /// base model a batch price — and the tier no row of its own.
    func testServiceTier_keepsItsOwnFamilyAndPrice() {
        XCTAssertEqual(ModelCatalog.canonicalIdentity(provider: "openai", model: "gpt-6.1-sol").family, "gpt-6.1-sol")
        XCTAssertEqual(ModelCatalog.canonicalIdentity(provider: "openai", model: "gpt-6.1-sol:batch").family, "gpt-6.1-sol-batch")
        XCTAssertEqual(ModelCatalog.canonicalIdentity(provider: "openai", model: "gpt-6.1-sol-pro").family, "gpt-6.1-sol-pro")
        XCTAssertEqual(ModelCatalog.canonicalIdentity(provider: "openai", model: "gpt-5-sol-fast").family, "gpt-5-sol-fast")
    }

    /// The row that represents a model carries the LAB's price and context —
    /// not a reseller's, and not a service tier's.
    func testRepresentativeRoute_carriesTheLabsPriceAndContext() {
        let lab = ModelCatalog.Entry(
            id: "gpt-6.1-sol", name: "GPT 6.1 Sol",
            provider: "openai", providerName: "OpenAI",
            inputPerM: 2.5, outputPerM: 10, contextK: 872
        )
        let reseller = ModelCatalog.Entry(
            id: "openai/gpt-6.1-sol", name: "GPT 6.1 Sol",
            provider: "merge-gateway", providerName: "Merge Gateway",
            inputPerM: 2, outputPerM: 8, contextK: 1050
        )
        let result = ModelsPipeline.compute(search: "", scope: .all, sortColumn: .sweBench, sortAscending: false,
                                             catalog: [reseller, lab], syntheticModels: [], usageModels: [])
        let row = result.base.first { $0.usage.model == "gpt-6.1-sol" }
        XCTAssertEqual(row?.catalog?.inputPerM, 2.5, "the lab's price represents the model")
        XCTAssertEqual(row?.contextK, 872, "the lab's context window represents the model")
        XCTAssertEqual(row?.usage.provider, "openai", "the row is labelled with the lab")
    }

    // MARK: 6. The model card, resolved for every model

    /// A route id is one spelling of the lab's canonical model: what the route
    /// does not say about those weights, the canonical entry says.
    func testRouteTakesTheCapabilitiesOfItsCanonicalModel() throws {
        let json = """
        {"openai": {"name": "OpenAI", "models": {
          "gpt-5.2": {"id": "gpt-5.2", "cost": {"input": 1.25, "output": 10},
                      "limit": {"context": 400000}, "reasoning": true, "tool_call": true,
                      "open_weights": false, "release_date": "2025-11-01", "knowledge": "2025-06-01"},
          "gpt-5.2-preview": {"id": "gpt-5.2-preview", "cost": {"input": 1.25, "output": 10},
                      "canonical_model_id": "openai/gpt-5.2"}}}}
        """
        let api = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let map = ModelCatalog.parseModelsDev(api: api, benchmarks: [:])
        let canonical = try XCTUnwrap(map["openai/gpt-5.2"])
        let route = try XCTUnwrap(map["openai/gpt-5.2-preview"])
        XCTAssertEqual(canonical.contextK, 400)
        XCTAssertEqual(route.reasoning, true, "the route takes the canonical model's reasoning flag")
        XCTAssertEqual(route.toolCall, true, "the route takes the canonical model's tool flag")
        XCTAssertEqual(route.openWeights, false, "the route takes the canonical model's open-weights flag")
        XCTAssertEqual(route.contextK, 400, "the route takes the canonical model's context window")
        XCTAssertEqual(route.releaseDate, "2025-11-01", "the route takes the canonical model's release date")
    }

    /// The card carries what the source says about the model — and only that:
    /// a field the source does not state stays unknown rather than guessed.
    func testModelCard_keepsUnknownsUnknown() throws {
        let json = """
        {"acme": {"name": "Acme", "models": {
          "widget-1": {"id": "widget-1", "cost": {"input": 1, "output": 2}, "limit": {"context": 32000}}}}}
        """
        let api = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let map = ModelCatalog.parseModelsDev(api: api, benchmarks: [:])
        let entry = try XCTUnwrap(map["acme/widget-1"])
        XCTAssertEqual(entry.contextK, 32)
        XCTAssertNil(entry.reasoning, "an unstated capability stays unknown")
        XCTAssertNil(entry.openWeights)
        XCTAssertNil(entry.releaseDate)
    }

    /// The curated table (a person transcribed the vendor's numbers) wins over
    /// the sourced one (public evaluation boards); the sourced table fills the
    /// gaps. Both live in the loaded table.
    func testBenchmarkTable_mergesTheSourcedScoresUnderTheCuratedOnes() {
        let table = ModelCatalog.loadBenchmarks()
        XCTAssertFalse(table.isEmpty)
        // A curated key keeps the curated number and its source.
        let curated = table["claude-3-7-sonnet"]
        XCTAssertEqual(curated?.swe, 77.6, "the curated score wins")
        XCTAssertEqual(curated?.source, "Anthropic")
        // The sourced table contributes models the curated one does not cover.
        let sourced = table.values.first { $0.source.hasPrefix("SWE-bench Verified") }
        XCTAssertNotNil(sourced, "the sourced table must reach the catalog")
    }

    /// The picks are models, not routes: a free tier and the paid route of
    /// the same weights are one model, and listing both spent half the picks
    /// on a single release.
    func testTopPicks_areOnePerModel() {
        let catalog = ModelCatalog.shared.allEntries()
        let result = ModelsPipeline.compute(search: "", scope: .all, sortColumn: .sweBench, sortAscending: false,
                                             catalog: catalog, syntheticModels: [], usageModels: [])
        XCTAssertFalse(result.topPicks.isEmpty)
        var seen: Set<String> = []
        for pick in result.topPicks {
            let weights = ModelCatalog.baseWeightsKey(pick.id) ?? pick.id
            XCTAssertTrue(seen.insert(weights).inserted, "\(pick.id) repeats a model already in the picks")
        }
    }
}
