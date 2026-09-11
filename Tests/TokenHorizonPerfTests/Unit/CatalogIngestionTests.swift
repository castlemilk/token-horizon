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
