import XCTest
@testable import TokenHorizon

/// Tests for ModelRow's computed display/pricing logic — the math behind the
/// MODELS tab, /stats, and MCP model output. Pure value semantics throughout.
final class ModelRowTests: XCTestCase {

    private func usage(provider: String = "anthropic", model: String = "m",
                       tokensAll: Int = 0, tokensToday: Int = 0, cost: Double = 0,
                       free: Bool = false, contextK: Int = 0, tokPerSec: Double? = nil,
                       param: String? = nil, localName: String? = nil) -> ModelUsage {
        ModelUsage(provider: provider, model: model, tokensAll: tokensAll,
                   tokensToday: tokensToday, cost: cost, messages: 0, free: free,
                   contextK: contextK, tokPerSec: tokPerSec, paramSize: param,
                   localModelName: localName)
    }

    private func entry(name: String? = nil, providerName: String? = nil,
                       input: Double = 0, output: Double = 0, cache: Double? = nil,
                       contextK: Int = 0, swe: Double? = nil, lcb: Double? = nil,
                       discount: Int? = nil, discountLabel: String? = nil,
                       originalIn: Double? = nil, originalOut: Double? = nil) -> ModelCatalog.Entry {
        ModelCatalog.Entry(
            id: "test-model", name: name ?? "test-model",
            provider: "test", providerName: providerName ?? "Test",
            inputPerM: input, outputPerM: output, cacheReadPerM: cache,
            contextK: contextK,
            benchmarks: (swe != nil || lcb != nil)
                ? ModelCatalog.Benchmarks(swe: swe, lcb: lcb, source: "test") : nil,
            docUrl: nil, description: nil, reasoning: nil, toolCall: nil,
            vision: nil, openWeights: nil, discountPercent: discount,
            discountLabel: discountLabel, discountDetail: nil,
            originalInputPerM: originalIn, originalOutputPerM: originalOut)
    }

    func testDisplayName_fallsBackToModel() {
        XCTAssertEqual(ModelRow(usage: usage(), catalog: entry(name: "Pretty")).displayName, "Pretty")
        // name == id → not a real display name, fall back to model slug.
        XCTAssertEqual(ModelRow(usage: usage(model: "slug"), catalog: entry(name: "test-model")).displayName, "slug")
        XCTAssertEqual(ModelRow(usage: usage(model: "slug"), catalog: nil).displayName, "slug")
    }

    func testProviderDisplay_mapping() {
        struct Case { let provider: String; let want: String }
        let cases: [Case] = [
            Case(provider: "anthropic", want: "Anthropic"),
            Case(provider: "openai", want: "OpenAI"),
            Case(provider: "ollama", want: "Ollama (Local)"),
            Case(provider: "google", want: "Google"),
            Case(provider: "xai", want: "xAI"),
            Case(provider: "mystery", want: "mystery"),
        ]
        for (i, tc) in cases.enumerated() {
            XCTAssertEqual(ModelRow(usage: usage(provider: tc.provider), catalog: nil).providerDisplay,
                           tc.want, "case \(i)")
        }
        // Catalog providerName wins over the mapping table.
        XCTAssertEqual(ModelRow(usage: usage(provider: "anthropic"), catalog: entry(providerName: "Custom")).providerDisplay,
                       "Custom")
    }

    func testFreeAndPrices() {
        let local = ModelRow(usage: usage(provider: "ollama", free: false), catalog: entry(input: 5, output: 5))
        XCTAssertTrue(local.isLocal)
        XCTAssertTrue(local.isFree)
        XCTAssertEqual(local.inputPrice, 0)
        XCTAssertEqual(local.blendedNetCost, 0.04)

        let free = ModelRow(usage: usage(free: true), catalog: entry())
        XCTAssertTrue(free.isFree)

        let paid = ModelRow(usage: usage(), catalog: entry(input: 3, output: 15))
        XCTAssertFalse(paid.isFree)
        XCTAssertEqual(paid.inputPrice, 3)
        XCTAssertEqual(paid.outputPrice, 15)
    }

    func testEffectiveAndBlendedPricing() {
        // Prompt-cache path: 80% of input at cache price.
        let cached = ModelRow(usage: usage(), catalog: entry(input: 10, output: 10, cache: 1))
        XCTAssertEqual(cached.effectiveInputPrice, 10 * 0.20 + 1 * 0.80, accuracy: 1e-9)
        // Discount path without cache pricing.
        let promo = ModelRow(usage: usage(),
                             catalog: ModelCatalog.Entry(
                                 id: "m", name: "m", provider: "p", providerName: "P",
                                 inputPerM: 10, outputPerM: 10, cacheReadPerM: nil,
                                 contextK: 0, benchmarks: nil, docUrl: nil,
                                 description: nil, reasoning: nil, toolCall: nil,
                                 vision: nil, openWeights: nil, discountPercent: 50,
                                 discountLabel: "-50%", discountDetail: nil,
                                 originalInputPerM: 20, originalOutputPerM: 20))
        XCTAssertEqual(promo.effectiveInputPrice, 5, accuracy: 1e-9)
        XCTAssertTrue(promo.hasDiscount)
        XCTAssertEqual(promo.discountLabel, "-50%")
        // Blended 3:1 over net prices, floored at 0.04.
        XCTAssertEqual(promo.blendedNetCost, max(0.04, (5 * 3 + 10) / 4), accuracy: 1e-9)
        XCTAssertGreaterThan(cached.netSavingsPercent, 0)
        XCTAssertEqual(ModelRow(usage: usage(), catalog: entry(input: 10, output: 10)).netSavingsPercent, 0)
    }

    func testContextText() {
        XCTAssertEqual(ModelRow(usage: usage(contextK: 1500), catalog: nil).contextText, "1.5M")
        XCTAssertEqual(ModelRow(usage: usage(contextK: 1000), catalog: nil).contextText, "1M")
        XCTAssertEqual(ModelRow(usage: usage(contextK: 128), catalog: nil).contextText, "128k")
        XCTAssertEqual(ModelRow(usage: usage(param: "7B"), catalog: nil).contextText, "7B")
        XCTAssertEqual(ModelRow(usage: usage(), catalog: nil).contextText, "—")
        // Usage wins over catalog.
        XCTAssertEqual(ModelRow(usage: usage(contextK: 64), catalog: entry(contextK: 128)).contextK, 64)
    }

    func testScoreAndSpeedTexts() {
        let row = ModelRow(usage: usage(tokPerSec: 45.2), catalog: entry(swe: 72.34, lcb: 68.1))
        XCTAssertEqual(row.sweScore ?? -1, 72.34, accuracy: 1e-9)
        XCTAssertEqual(row.sweText, "72.3%")
        XCTAssertEqual(row.lcbText, "68.1%")
        XCTAssertEqual(row.speedText, "45.2 t/s")
        XCTAssertEqual(ModelRow(usage: usage(), catalog: nil).sweText, "—")
        XCTAssertEqual(ModelRow(usage: usage(), catalog: nil).speedText, "API")
    }

    func testCostTexts() {
        XCTAssertEqual(ModelRow(usage: usage(cost: 12.5), catalog: nil).costText, "$12.50")
        XCTAssertEqual(ModelRow(usage: usage(free: true), catalog: nil).costText, "Free")
        XCTAssertEqual(ModelRow(usage: usage(), catalog: entry(input: 2.5)).costText, "$2.50")
    }

    func testRemainingPriceTexts() {
        let row = ModelRow(usage: usage(), catalog: entry(input: 2.5, output: 10, cache: 0.5,
                                                          originalIn: 5, originalOut: 20))
        XCTAssertEqual(row.inputPriceText, "$2.50")
        XCTAssertEqual(row.outputPriceText, "$10.00")
        XCTAssertEqual(row.cachePriceText, "$0.50")
        XCTAssertEqual(row.originalInputPriceText, "$5.00")
        XCTAssertEqual(row.originalOutputPriceText, "$20.00")
        // Effective input blends 80% cache reads: 2.5*0.2 + 0.5*0.8 = 0.90.
        XCTAssertEqual(row.effectiveInputPriceText, "$0.90")
        XCTAssertEqual(row.discountDetail, nil)
        // Tiny prices use 4 decimals.
        let tiny = ModelRow(usage: usage(), catalog: entry(input: 0.002, originalIn: 0.004))
        XCTAssertEqual(tiny.inputPriceText, "$0.0020")
        XCTAssertEqual(tiny.originalInputPriceText, "$0.0040")
        // Free/local short-circuits.
        XCTAssertEqual(ModelRow(usage: usage(free: true), catalog: nil).inputPriceText, "Free")
        XCTAssertEqual(ModelRow(usage: usage(), catalog: nil).cachePriceText, "—")
    }

    func testEffectiveCostAndUsageCost() {
        var m = usage(cost: 3)
        m.estCost = 9
        XCTAssertEqual(ModelRow(usage: m, catalog: nil).effectiveCost, 9)
        XCTAssertEqual(ModelRow(usage: usage(cost: 3), catalog: nil).usageCostText, "$3.00")
        var e = usage()
        e.estCost = 4.5
        XCTAssertEqual(ModelRow(usage: e, catalog: nil).usageCostText, "$4.50")
    }

    func testPromptSpeedAndLocalName() {
        var u = usage()
        u.promptTokPerSec = 120
        XCTAssertEqual(ModelRow(usage: u, catalog: nil).promptSpeedText, "120 p-t/s")
        XCTAssertNil(ModelRow(usage: usage(), catalog: nil).promptSpeedText)
        XCTAssertEqual(ModelRow(usage: usage(model: "m", localName: "exact:tag"), catalog: nil).localModelName,
                       "exact:tag")
        XCTAssertEqual(ModelRow(usage: usage(model: "m"), catalog: nil).localModelName, "m")
    }

    func testDocUrl() {
        // Local models resolve against the Ollama library.
        XCTAssertEqual(ModelRow(usage: usage(provider: "ollama", model: "qwen3:8b"), catalog: nil).docUrl?.absoluteString,
                       "https://ollama.com/library/qwen3")
    }

    func testShareTextThresholds() {
        var u = usage()
        u.sharePercent = 66.66
        XCTAssertEqual(u.shareText, "67%")
        u.sharePercent = 4.44
        XCTAssertEqual(u.shareText, "4.4%")
    }
}
