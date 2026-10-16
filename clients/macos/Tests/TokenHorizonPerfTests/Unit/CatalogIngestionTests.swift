import XCTest
@testable import TokenHorizon

/// Hermetic catalog ingestion: the committed fixture documents
/// (models.dev + OpenRouter shapes) flow through the exact pure functions
/// production uses — parse → authoritative overlay → OpenRouter merge →
/// lab preference → pipeline rows.
///
/// No network, no HOME, no shared singletons: every step here operates on
/// local dictionaries, so these tests are deterministic and safe to run
/// anywhere (including CI without credentials).
final class CatalogIngestionTests: XCTestCase {

    private typealias Score = ModelCatalog.BenchmarkScore
    private typealias BenchmarkTable = ModelCatalog.BenchmarkTable

    /// Look a model up in a table, failing with the id when it resolves to
    /// nothing, so each assertion reads as the row it expects.
    private func score(_ id: String, in table: BenchmarkTable) throws -> Score {
        try XCTUnwrap(ModelCatalog.benchmarkLookup(norm: id, fullKey: id, table: table), id)
    }

    private func jsonFixture(_ name: String) -> Any {
        let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
            ?? Bundle.module.url(forResource: name, withExtension: "json")
        guard let url = url,
              let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) else {
            XCTFail("\(name) fixture not found in test bundle")
            return [:]
        }
        return obj
    }

    /// Intelligence is a property of the weights, not of the route that serves
    /// them: a free-tier, preview or plan id of an already-scored model
    /// inherits that score and says it is approximate. Without this a free route
    /// — the thing a routing decision actually reads — scores blank.
    func testFreeRouteInheritsBaseWeightsScore() throws {
        var table = BenchmarkTable()
        table["deepseek-v4.1-flash"] = Score(name: "DeepSeek V4.1 Flash", swe: 78.0, lcb: 74.0,
                                             source: "DeepSeek", approx: false)

        let canonical = try score("deepseek-v4.1-flash", in: table)
        XCTAssertEqual(canonical.swe, 78.0)
        XCTAssertEqual(canonical.approx, false)

        // The Zen free route of the same weights: inherits, marked approximate.
        let free = try score("deepseek-v4.1-flash-free", in: table)
        XCTAssertEqual(free.swe, 78.0)
        XCTAssertEqual(free.lcb, 74.0)
        XCTAssertEqual(free.source, "DeepSeek")
        XCTAssertEqual(free.approx, true)

        // An unscored base weights: still nothing to inherit.
        XCTAssertNil(ModelCatalog.benchmarkLookup(norm: "space-bunny-free",
                                                  fullKey: "opencode/space-bunny-free",
                                                  table: table))
    }

    /// A route the table scores directly keeps ITS OWN numbers, even when the
    /// base weights are also scored — a direct measurement outranks inheritance.
    func testDirectlyScoredRouteWinsOverInheritance() throws {
        var table = BenchmarkTable()
        table["nemotron-3.5-lightning-free"] = Score(name: "Nemotron 3.5 Lightning Free", swe: 62.0, lcb: 58.5,
                                                     source: "OpenCode", approx: true)
        table["nemotron-3.5-lightning"] = Score(name: "Nemotron 3.5 Lightning", swe: 70.0, lcb: 66.0,
                                                source: "NVIDIA", approx: false)
        let hit = try score("nemotron-3.5-lightning-free", in: table)
        XCTAssertEqual(hit.swe, 62.0)
        XCTAssertEqual(hit.source, "OpenCode")
    }

    /// A table row with no numbers is a name alias, not a measurement. Keeping
    /// it stamped an empty `benchmarks: {}` on every matching row (a local
    /// Ollama model matched `ornith`), making unscored models look scored.
    func testAliasOnlyEntriesProduceNoScore() {
        var table = BenchmarkTable()
        table["gpt-6-astra"] = Score(name: "GPT-6 Astra", swe: nil, lcb: nil, source: "OpenAI", approx: false)
        XCTAssertNil(ModelCatalog.benchmarkLookup(norm: "gpt-6-astra", fullKey: "openai/gpt-6-astra",
                                                  table: table))
    }

    /// `approx` reaches the exported payload from the score itself, not only
    /// when the row also carries AIME/GPQA aux numbers.
    func testExportedScoreCarriesProvenance() throws {
        let payload = ModelCatalogExport.data()
        let obj = try JSONSerialization.jsonObject(with: payload) as? [String: Any]
        let models = try XCTUnwrap(obj?["models"] as? [[String: Any]])
        XCTAssertFalse(models.isEmpty)

        var sawApprox = false
        for model in models {
            guard let bench = model["benchmarks"] as? [String: Any] else { continue }
            // No score row without a number, ever.
            XCTAssertTrue(bench["swe"] != nil || bench["lcb"] != nil,
                          "\(model["id"] as? String ?? "?") has an empty benchmarks object")
            if bench["approx"] as? Bool == true { sawApprox = true }
        }
        XCTAssertTrue(sawApprox, "no approximate score reached the export; provenance is lost")
    }

    /// `benchmarks` gained an `approx` flag, but the shape is persisted
    /// (models-cache.json) and embedded in the catalog fixture without it.
    /// A synthesized decoder would reject those payloads and empty the whole
    /// catalog; this is the regression that made every sort column return 0 rows.
    func testBenchmarksDecodePayloadsWrittenBeforeApproxExisted() throws {
        let legacy = #"{"swe": 78.0, "lcb": 74.0, "source": "DeepSeek"}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(ModelCatalog.Benchmarks.self, from: legacy)
        XCTAssertEqual(decoded.swe, 78.0)
        XCTAssertEqual(decoded.lcb, 74.0)
        XCTAssertEqual(decoded.source, "DeepSeek")
        XCTAssertFalse(decoded.approx, "a payload with no approx flag is a measured score")

        // And a whole catalog of them still loads.
        let entries = #"{"a/b":{"id":"b","name":"B","provider":"a","providerName":"A","inputPerM":0,"outputPerM":0,"contextK":128,"benchmarks":{"swe":50.0,"lcb":40.0,"source":"A"}}}"#.data(using: .utf8)!
        let map = try JSONDecoder().decode([String: ModelCatalog.Entry].self, from: entries)
        XCTAssertEqual(map["a/b"]?.benchmarks?.swe, 50.0)
        XCTAssertEqual(map["a/b"]?.benchmarks?.approx, false)
    }

    /// The official pricing table reprices DeepSeek's own listings, and only
    /// those. A free-tier or plan route of the same weights (`-free` on the
    /// opencode plan bills $0) is a different offer: stamping the direct-API
    /// price on it is how the Zen free route ended up quoting $0.15/$0.60.
    func testDeepSeekPricingOverlay_skipsFreeRoutes() {
        struct Listing {
            let id, provider, providerName: String
            let input, output: Double
            let contextK: Int
        }
        func entry(_ listing: Listing) -> ModelCatalog.Entry {
            ModelCatalog.Entry(id: listing.id, name: listing.id, provider: listing.provider,
                               providerName: listing.providerName,
                               inputPerM: listing.input, outputPerM: listing.output, cacheReadPerM: nil,
                               contextK: listing.contextK, benchmarks: nil, docUrl: nil, description: nil,
                               reasoning: true, toolCall: true, vision: false, openWeights: false,
                               discountPercent: nil, discountLabel: nil, discountDetail: nil,
                               originalInputPerM: nil, originalOutputPerM: nil)
        }
        var map: [String: ModelCatalog.Entry] = [
            "deepseek/deepseek-v4.1-flash": entry(Listing(
                id: "deepseek-v4.1-flash", provider: "deepseek", providerName: "DeepSeek",
                input: 0.10, output: 0.20, contextK: 1000)),
            "opencode/deepseek-v4.1-flash-free": entry(Listing(
                id: "deepseek-v4.1-flash-free", provider: "opencode", providerName: "OpenCode",
                input: 0, output: 0, contextK: 1000)),
            "opencode/space-bunny-free": entry(Listing(
                id: "space-bunny-free", provider: "opencode", providerName: "OpenCode",
                input: 0, output: 0, contextK: 128)),
            "deepseek/deepseek-v4-pro": entry(Listing(
                id: "deepseek-v4-pro", provider: "deepseek", providerName: "DeepSeek",
                input: 0.50, output: 1.00, contextK: 1000))
        ]
        let pricing = ModelCatalog.DeepSeekScrapedPricing(
            flashInput: 0.15, flashOutput: 0.60, flashCache: 0.003,
            proInput: 0.66, proOutput: 1.98, proCache: 0.022)

        ModelCatalog.applyDeepSeekScrapedPricing(into: &map, pricing: pricing, benchmarks: [:])

        // Stale direct listings take the official price.
        XCTAssertEqual(map["deepseek/deepseek-v4.1-flash"]?.inputPerM, 0.15)
        XCTAssertEqual(map["deepseek/deepseek-v4.1-flash"]?.outputPerM, 0.60)
        XCTAssertEqual(map["deepseek/deepseek-v4-pro"]?.inputPerM, 0.66)
        // The free route of the same weights stays free.
        XCTAssertEqual(map["opencode/deepseek-v4.1-flash-free"]?.inputPerM, 0)
        XCTAssertEqual(map["opencode/deepseek-v4.1-flash-free"]?.outputPerM, 0)
        XCTAssertEqual(map["opencode/space-bunny-free"]?.inputPerM, 0)
    }

    /// The bundled benchmark table must resolve headlessly, not just inside the
    /// installed `.app`: `--export-model-catalog` runs from the SwiftPM binary
    /// with any working directory, and an unresolved table silently exports a
    /// catalog with no scores at all (4 of 26 scored models vanished from the
    /// committed artifact this way).
    func testBundledBenchmarksResolveOutsideTheAppBundle() {
        XCTAssertNotNil(ModelCatalog.resourceJSONPath("benchmarks"))
        XCTAssertNotNil(ModelCatalog.resourceJSONPath("plans"))
        XCTAssertFalse(ModelCatalog.loadBenchmarks().isEmpty)
        XCTAssertFalse(ModelCatalogExport.auxiliaryBenchmarks().isEmpty)
    }

    /// models.dev shape → entries, with vision/tool/open-weights carried over.
    func testModelsDevFixture_parsesShape() {
        guard let api = jsonFixture("models-dev-sample") as? [String: Any] else { return }
        let map = ModelCatalog.parseModelsDev(api: api, benchmarks: [:])
        XCTAssertEqual(map.count, 3)

        let stale = map["deepseek/deepseek-v4-pro"]
        XCTAssertEqual(stale?.inputPerM, 0.435)
        XCTAssertEqual(stale?.outputPerM, 0.87)
        XCTAssertEqual(stale?.contextK, 1000)

        let reseller = map["crossmodel/tlab-solar-7z"]
        XCTAssertEqual(reseller?.provider, "crossmodel")
        XCTAssertEqual(reseller?.toolCall, true)

        let zero = map["google/gem-test-flash"]
        XCTAssertEqual(zero?.inputPerM, 0)
        XCTAssertEqual(zero?.vision, true)
    }

    /// OpenRouter shape → per-token strings become $/1M, vendor prefixes map
    /// to canonical providers, unknown vendors pass through, :free survives.
    func testOpenRouterFixture_parsesShape() {
        guard let obj = jsonFixture("openrouter-sample") as? [String: Any],
              let list = obj["data"] as? [[String: Any]] else { return }
        let parsed = ModelCatalog.parseOpenRouterModels(list: list, benchmarks: [:])
        XCTAssertEqual(parsed.count, 4)

        let flash = parsed["deepseek/deepseek-v4.1-flash"]
        XCTAssertEqual(flash?.inputPerM ?? 0, 0.15, accuracy: 0.0001)
        XCTAssertEqual(flash?.outputPerM ?? 0, 0.60, accuracy: 0.0001)
        XCTAssertEqual(flash?.contextK, 1048)
        XCTAssertEqual(flash?.vision, true)
        XCTAssertEqual(flash?.toolCall, true)

        // Vendor-prefix mapping, not passthrough.
        XCTAssertNotNil(parsed["alibaba/qwen-test-coder"])
        XCTAssertEqual(parsed["alibaba/qwen-test-coder"]?.inputPerM ?? 0, 0.30, accuracy: 0.0001)

        // Unknown future vendor + :free variant are preserved, not dropped.
        let free = parsed["future-labs/nova-mind-1:free"]
        XCTAssertNotNil(free)
        XCTAssertEqual(free?.provider, "future-labs")
        XCTAssertEqual(free?.inputPerM, 0)
    }

    /// Full production chain on fixture data: stale models.dev pricing is
    /// corrected, OpenRouter adds what models.dev lacks, and lab-direct rows
    /// win over reseller rows.
    func testFullChain_fixtureEndToEnd() {
        guard let api = jsonFixture("models-dev-sample") as? [String: Any],
              let obj = jsonFixture("openrouter-sample") as? [String: Any],
              let list = obj["data"] as? [[String: Any]] else { return }

        var map = ModelCatalog.parseModelsDev(api: api, benchmarks: [:])
        ModelCatalog.applyDeepSeekAuthoritativeOverlay(into: &map, benchmarks: [:])
        XCTAssertEqual(map["deepseek/deepseek-v4-pro"]?.inputPerM, 0.66)

        let parsed = ModelCatalog.parseOpenRouterModels(list: list, benchmarks: [:])
        ModelCatalog.applyOpenRouterEntries(into: &map, parsed: parsed)

        // V4.1 Flash arrives purely via OpenRouter (absent from models.dev doc).
        XCTAssertEqual(map["deepseek/deepseek-v4.1-flash"]?.inputPerM ?? 0, 0.15, accuracy: 0.0001)
        // Unknown-vendor future model arrives too.
        XCTAssertNotNil(map["future-labs/nova-mind-1:free"])

        // Lab-direct beats reseller for the same model id.
        let lab = ModelCatalog.Entry(
            id: "tlab-solar-7z", name: "Solar Pro",
            provider: "upstage", providerName: "Upstage",
            inputPerM: 0.10, outputPerM: 0.30, contextK: 128)
        let reseller = map["crossmodel/tlab-solar-7z"]
        XCTAssertNotNil(reseller)
        let best = ModelCatalog.pickBestLookup([reseller!, lab])
        XCTAssertEqual(best?.provider, "upstage")
        XCTAssertEqual(best?.inputPerM, 0.10)
    }

    /// Fixture catalog through the real pipeline: future models are
    /// searchable rows with correct pricing — the "fully dynamic" contract.
    func testPipelineEndToEnd_fixtureCatalog() {
        guard let api = jsonFixture("models-dev-sample") as? [String: Any],
              let obj = jsonFixture("openrouter-sample") as? [String: Any],
              let list = obj["data"] as? [[String: Any]] else { return }

        var map = ModelCatalog.parseModelsDev(api: api, benchmarks: [:])
        ModelCatalog.applyDeepSeekAuthoritativeOverlay(into: &map, benchmarks: [:])
        ModelCatalog.applyOpenRouterEntries(
            into: &map, parsed: ModelCatalog.parseOpenRouterModels(list: list, benchmarks: [:]))
        let catalog = Array(map.values)

        let all = ModelsPipeline.compute(
            search: "", scope: .all, sortColumn: .model, sortAscending: true,
            catalog: catalog, syntheticModels: [], usageModels: [])
        XCTAssertGreaterThan(all.base.count, 5)

        let flash = ModelsPipeline.compute(
            search: "deepseek-v4.1-flash", scope: .all, sortColumn: .model, sortAscending: true,
            catalog: catalog, syntheticModels: [], usageModels: [])
        XCTAssertEqual(flash.filtered.count, 1)
        XCTAssertEqual(flash.filtered.first?.inputPrice ?? 0, 0.15, accuracy: 0.0001)

        // Unknown-vendor model is a first-class searchable row, marked free.
        let future = ModelsPipeline.compute(
            search: "nova-mind", scope: .all, sortColumn: .model, sortAscending: true,
            catalog: catalog, syntheticModels: [], usageModels: [])
        XCTAssertEqual(future.filtered.count, 1)
        XCTAssertTrue(future.filtered.first?.isFree ?? false)
    }
}
