import XCTest
@testable import TokenHorizon

final class ModelCatalogLookupTests: XCTestCase {

    func testLookup_flagshipModels() {
        let catalog = ModelCatalog.shared

        // GPT-5 Sol
        let sol = catalog.lookup(id: "gpt-5-sol")
        XCTAssertNotNil(sol)
        XCTAssertEqual(sol?.name, "GPT-5 Sol")
        XCTAssertEqual(sol?.provider, "openai")
        XCTAssertEqual(sol?.inputPerM, 2.50)
        XCTAssertEqual(sol?.outputPerM, 10.00)
        XCTAssertEqual(sol?.discountPercent, 50)
        XCTAssertEqual(sol?.contextK, 256)

        // GPT-5 Terra
        let terra = catalog.lookup(id: "gpt-5-terra")
        XCTAssertNotNil(terra)
        XCTAssertEqual(terra?.name, "GPT-5 Terra")
        XCTAssertEqual(terra?.discountPercent, 20)

        // GPT-5 Luna
        let luna = catalog.lookup(id: "gpt-5-luna")
        XCTAssertNotNil(luna)
        XCTAssertEqual(luna?.name, "GPT-5 Luna")

        // Claude Opus 5.5 — a curated entry exists so spellings that miss the
        // live feed cache still resolve to their own canonical model (never
        // fold into Opus 5). Synthetic id guarantees no byId feed match.
        let opus55 = catalog.lookup(id: "test/claude-opus-5-5-rc")
        XCTAssertNotNil(opus55)
        XCTAssertEqual(opus55?.id, "claude-opus-5-5")
        XCTAssertEqual(opus55?.name, "Claude Opus 5.5")
        XCTAssertEqual(opus55?.provider, "anthropic")
        XCTAssertEqual(opus55?.inputPerM, 4.00)
        XCTAssertEqual(opus55?.outputPerM, 20.00)
        XCTAssertEqual(opus55?.cacheReadPerM, 0.20)
        XCTAssertEqual(opus55?.contextK, 1000)
        // Real feed spellings resolve to an Opus 5.5 entry — canonical or
        // live-cached (byId wins, keeping live pricing) — but never Opus 5.
        for variant in ["claude-opus-5-5", "anthropic/claude-opus-5.5", "claude-opus-5-5-thinking",
                        "us.anthropic.claude-opus-5-5", "claude-opus-5-5@default"] {
            let e = catalog.lookup(id: variant)
            XCTAssertNotNil(e, variant)
            XCTAssertNotEqual(e?.id, "claude-opus-5", variant)
            XCTAssertTrue((e?.id ?? "").contains("5-5") || (e?.name ?? "").contains("5.5"), variant)
        }
        // …while genuine Opus 5 still lands on its own entry.
        XCTAssertEqual(catalog.lookup(id: "claude-opus-5")?.id, "claude-opus-5")

        // Gemini 3.7 Flash
        let g37 = catalog.lookup(id: "gemini-3.7-flash")
        XCTAssertNotNil(g37)
        XCTAssertEqual(g37?.provider, "google")
        XCTAssertEqual(g37?.contextK, 1000)

        // DeepSeek V4 Pro (authoritative off-peak pricing per official docs)
        let dsv4 = catalog.lookup(id: "deepseek-v4-pro")
        XCTAssertNotNil(dsv4)
        XCTAssertEqual(dsv4?.provider, "deepseek")
        XCTAssertEqual(dsv4?.inputPerM, 0.66)
        XCTAssertEqual(dsv4?.outputPerM, 1.98)
        XCTAssertEqual(dsv4?.cacheReadPerM, 0.022)
        XCTAssertEqual(dsv4?.contextK, 1000)

        // DeepSeek V4.1 Flash (current flagship, off-peak base; peak 2x)
        let dsv41 = catalog.lookup(id: "deepseek-v4.1-flash")
        XCTAssertNotNil(dsv41)
        XCTAssertEqual(dsv41?.provider, "deepseek")
        XCTAssertEqual(dsv41?.inputPerM, 0.15)
        XCTAssertEqual(dsv41?.outputPerM, 0.60)
        XCTAssertEqual(dsv41?.cacheReadPerM, 0.003)
        XCTAssertEqual(dsv41?.contextK, 1000)

        // Legacy DeepSeek flash aliases route to V4.1 Flash pricing
        let dsFlash = catalog.lookup(id: "deepseek-flash")
        XCTAssertNotNil(dsFlash)
        XCTAssertEqual(dsFlash?.inputPerM, 0.15)
        XCTAssertEqual(dsFlash?.outputPerM, 0.60)
    }

    func testLookup_deepSeekDynamicSynthesis() {
        let catalog = ModelCatalog.shared
        // Unknown future DeepSeek ids synthesize tier pricing, never nil/$0.
        let future = catalog.lookup(id: "deepseek-v4-2-ultra")
        XCTAssertNotNil(future)
        XCTAssertEqual(future?.provider, "deepseek")
        XCTAssertGreaterThan(future?.inputPerM ?? 0, 0)
        XCTAssertGreaterThan(future?.outputPerM ?? 0, 0)

        let futurePro = catalog.lookup(id: "deepseek-v5-pro")
        XCTAssertNotNil(futurePro)
        XCTAssertEqual(futurePro?.inputPerM, 0.66)
        XCTAssertEqual(futurePro?.outputPerM, 1.98)

        // Unknown future OpenAI/Claude/Gemini ids also synthesize.
        XCTAssertNotNil(catalog.lookup(id: "gpt-7-nova"))
        XCTAssertNotNil(catalog.lookup(id: "claude-opus-6"))
        XCTAssertNotNil(catalog.lookup(id: "gemini-4-pro"))
    }

    func testScrapeDeepSeekPricing_parsesTable() {
        // Row-major Flash/Pro columns as served by the live docs page:
        // per price type: Flash-off, Pro-off, Flash-peak, Pro-peak.
        let html = """
        <table><tr><td>MODEL VERSION</td><td>DeepSeek-V4.1-Flash</td><td>DeepSeek-V4-Pro-0813</td></tr>
        <tr><td>cache hit off</td><td>$0.003</td><td>$0.022</td></tr>
        <tr><td>cache hit peak</td><td>$0.006</td><td>$0.044</td></tr>
        <tr><td>cache miss off</td><td>$0.15</td><td>$0.66</td></tr>
        <tr><td>cache miss peak</td><td>$0.3</td><td>$1.32</td></tr>
        <tr><td>output off</td><td>$0.6</td><td>$1.98</td></tr>
        <tr><td>output peak</td><td>$1.2</td><td>$3.96</td></tr>
        <tr><td>Concurrency Limit</td></tr></table>
        """
        let pricing = ModelCatalog.scrapeDeepSeekPricing(html: html)
        XCTAssertNotNil(pricing)
        XCTAssertEqual(pricing?.flashInput, 0.15)
        XCTAssertEqual(pricing?.flashOutput, 0.6)
        XCTAssertEqual(pricing?.flashCache, 0.003)
        XCTAssertEqual(pricing?.proInput, 0.66)
        XCTAssertEqual(pricing?.proOutput, 1.98)
        XCTAssertEqual(pricing?.proCache, 0.022)
    }

    func testScrapeDeepSeekPricing_rejectsChangedShape() {
        XCTAssertNil(ModelCatalog.scrapeDeepSeekPricing(html: "<p>no table here</p>"))
        XCTAssertNil(ModelCatalog.scrapeDeepSeekPricing(html: "MODEL VERSION $1 $2 Concurrency Limit"))
    }

    func testDeepSeekOverlay_correctsStaleModelsDevRows() {
        // models.dev ships stale DeepSeek rows (0.435/0.87, 128K ctx, no V4.1).
        var map: [String: ModelCatalog.Entry] = [
            "deepseek/deepseek-v4-pro": ModelCatalog.Entry(
                id: "deepseek-v4-pro", name: "DeepSeek V4 Pro",
                provider: "deepseek", providerName: "DeepSeek",
                inputPerM: 0.435, outputPerM: 0.87, cacheReadPerM: 0.003625, contextK: 1000)
        ]
        ModelCatalog.applyDeepSeekAuthoritativeOverlay(into: &map, benchmarks: [:])
        XCTAssertEqual(map["deepseek/deepseek-v4-pro"]?.inputPerM, 0.66)
        XCTAssertEqual(map["deepseek/deepseek-v4-pro"]?.outputPerM, 1.98)
        XCTAssertEqual(map["deepseek/deepseek-v4-pro"]?.cacheReadPerM, 0.022)
        // V4.1 Flash aliases are created even when models.dev lacks them.
        XCTAssertEqual(map["deepseek-flash"]?.inputPerM, 0.15)
        XCTAssertEqual(map["deepseek/deepseek-v4-flash"]?.outputPerM, 0.60)
    }

    func testLookup_prefersLabOverReseller() {
        // Same model under a reseller and the lab: lookup must use direct
        // pricing, not reseller markup (regression: suffix scan used to
        // return whichever row the dict yielded first).
        // (Stem contains the family, as real reseller rows do.)
        let stem = "tlab-minimax-7z"
        let reseller = ModelCatalog.Entry(
            id: stem, name: "TLab Probe (Reseller)",
            provider: "crossmodel", providerName: "CrossModel",
            inputPerM: 9.99, outputPerM: 99.99, contextK: 128)
        let lab = ModelCatalog.Entry(
            id: stem, name: "TLab Probe",
            provider: "minimax", providerName: "MiniMax",
            inputPerM: 0.30, outputPerM: 1.20, contextK: 200)
        _ = ModelCatalog.shared.mergeDiscoveredEntries(
            ["crossmodel/\(stem)": reseller, "minimax/\(stem)": lab])
        let found = ModelCatalog.shared.lookup(id: stem)
        XCTAssertEqual(found?.provider, "minimax")
        XCTAssertEqual(found?.inputPerM, 0.30)
    }

    func testLookup_synthesisCoversAllFutureFamilies() {
        let catalog = ModelCatalog.shared
        // Every canonical provider family synthesizes — future models are
        // never nil/missing, at worst transient estimates awaiting live data.
        // (99-suffixed ids are guaranteed absent from the live catalog.)
        let cases: [(id: String, provider: String)] = [
            ("qwen4-99-coder", "alibaba"),
            ("kimi-k99-thinking", "kimi"),
            ("minimax-m99-quantum", "minimax"),
            ("grok-99", "xai"),
            ("mistral-large-99", "mistral"),
            ("llama-99-70b", "meta"),
            ("command-99", "cohere"),
            ("sonar-99", "perplexity"),
            ("nova-99", "amazon"),
            ("solar-pro-99", "upstage"),
            ("big-pickle-99", "opencode"),
            ("ornith-99:35b", "ollama")
        ]
        for probe in cases {
            let entry = catalog.lookup(id: probe.id)
            XCTAssertNotNil(entry, "synthesis missing for \(probe.id)")
            XCTAssertEqual(entry?.provider, probe.provider, "wrong provider for \(probe.id)")
        }
        // Paid families always get positive estimates (never $0).
        for id in ["qwen4-99-coder", "grok-99", "llama-99-70b", "kimi-k99"] {
            let entry = catalog.lookup(id: id)
            XCTAssertGreaterThan(entry?.inputPerM ?? 0, 0, "zero pricing for \(id)")
            XCTAssertGreaterThan(entry?.outputPerM ?? 0, 0, "zero pricing for \(id)")
        }
    }

    func testOpenRouterProviderMapping() {
        XCTAssertEqual(ModelCatalog.openRouterProvider(for: "qwen").id, "alibaba")
        XCTAssertEqual(ModelCatalog.openRouterProvider(for: "z-ai").id, "glm")
        XCTAssertEqual(ModelCatalog.openRouterProvider(for: "moonshotai").id, "kimi")
        XCTAssertEqual(ModelCatalog.openRouterProvider(for: "x-ai").id, "xai")
        XCTAssertEqual(ModelCatalog.openRouterProvider(for: "mistralai").id, "mistral")
        XCTAssertEqual(ModelCatalog.openRouterProvider(for: "meta-llama").id, "meta")
        // Unknown future vendors pass through instead of being dropped.
        XCTAssertEqual(ModelCatalog.openRouterProvider(for: "future-labs").id, "future-labs")
    }

    func testOpenRouterParse_realShape() {
        let list: [[String: Any]] = [
            ["id": "deepseek/deepseek-v4.1-flash", "name": "DeepSeek: DeepSeek V4.1 Flash",
             "context_length": 1048576,
             "architecture": ["input_modalities": ["text", "image"]],
             "supported_parameters": ["tools", "reasoning"],
              "pricing": ["prompt": "0.00000015", "completion": "0.0000006", "input_cache_read": "0.000000003"]],
            ["id": "nex-agi/nex-n2.5-mini:free", "name": "Nex AGI: Nex-N2.5-Mini (free)",
             "context_length": 262144,
             "architecture": ["input_modalities": ["text"]],
             "supported_parameters": ["tools"],
             "pricing": ["prompt": "0", "completion": "0"]]
        ]
        let parsed = ModelCatalog.parseOpenRouterModels(list: list, benchmarks: [:])
        let flash = parsed["deepseek/deepseek-v4.1-flash"]
        XCTAssertNotNil(flash)
        XCTAssertEqual(flash?.inputPerM ?? 0, 0.15, accuracy: 0.0001)
        XCTAssertEqual(flash?.outputPerM ?? 0, 0.60, accuracy: 0.0001)
        XCTAssertEqual(flash?.cacheReadPerM ?? 0, 0.003, accuracy: 0.0001)
        XCTAssertEqual(flash?.contextK, 1048)
        XCTAssertEqual(flash?.provider, "deepseek")
        XCTAssertEqual(flash?.name, "DeepSeek V4.1 Flash")
        // Unknown vendor + :free variant survive with passthrough provider.
        let free = parsed["nex-agi/nex-n2.5-mini:free"]
        XCTAssertNotNil(free)
        XCTAssertEqual(free?.provider, "nex-agi")
        XCTAssertEqual(free?.inputPerM, 0)
    }

    func testOpenRouterMerge_neverOverwritesPositivePricing() {
        var map: [String: ModelCatalog.Entry] = [
            "anthropic/claude-x": ModelCatalog.Entry(
                id: "claude-x", name: "Claude X",
                provider: "anthropic", providerName: "Anthropic",
                inputPerM: 3.00, outputPerM: 15.00, contextK: 200),
            "google/gem-new": ModelCatalog.Entry(
                id: "gem-new", name: "Gem New",
                provider: "google", providerName: "Google",
                inputPerM: 0, outputPerM: 0, contextK: 0)
        ]
        let parsed: [String: ModelCatalog.Entry] = [
            "anthropic/claude-x": ModelCatalog.Entry(
                id: "claude-x", name: "Claude X (OR)",
                provider: "anthropic", providerName: "Anthropic",
                inputPerM: 9.99, outputPerM: 99.99, contextK: 999),
            "google/gem-new": ModelCatalog.Entry(
                id: "gem-new", name: "Gem New",
                provider: "google", providerName: "Google",
                inputPerM: 0.15, outputPerM: 0.60, cacheReadPerM: 0.038, contextK: 1000,
                docUrl: "https://openrouter.ai/models?q=google/gem-new",
                description: "Live pricing via OpenRouter (google/gem-new)")
        ]
        ModelCatalog.applyOpenRouterEntries(into: &map, parsed: parsed)
        // Positive pricing untouched.
        XCTAssertEqual(map["anthropic/claude-x"]?.inputPerM, 3.00)
        XCTAssertEqual(map["anthropic/claude-x"]?.name, "Claude X")
        // Zero-priced row backfilled.
        XCTAssertEqual(map["google/gem-new"]?.inputPerM, 0.15)
        XCTAssertEqual(map["google/gem-new"]?.contextK, 1000)
    }

    func testLookup_hyphensAndColonsNormalization() {
        let catalog = ModelCatalog.shared

        // qwen2.5_coder_7b with underscore or colon
        let lookup1 = catalog.lookup(id: "gpt_5_sol")
        XCTAssertNotNil(lookup1)
        XCTAssertEqual(lookup1?.id, "gpt-5-sol")

        let lookup2 = catalog.lookup(id: "gpt-5-sol:latest")
        XCTAssertNotNil(lookup2)
        XCTAssertEqual(lookup2?.id, "gpt-5-sol")
    }

    func testCanonicalIdentity_coverageForAllProviders() {
        // DeepSeek
        let ds = ModelCatalog.canonicalIdentity(provider: "deepseek", model: "deepseek-reasoner")
        XCTAssertEqual(ds.providerId, "deepseek")
        XCTAssertEqual(ds.providerName, "DeepSeek")

        // Google
        let gem = ModelCatalog.canonicalIdentity(provider: "google", model: "gemini-2.5-pro")
        XCTAssertEqual(gem.providerId, "google")
        XCTAssertEqual(gem.providerName, "Google")

        // Meta
        let meta = ModelCatalog.canonicalIdentity(provider: "meta", model: "llama-3.3-70b")
        XCTAssertEqual(meta.providerId, "meta")
        XCTAssertEqual(meta.providerName, "Meta")

        // Mistral
        let mistral = ModelCatalog.canonicalIdentity(provider: "mistral", model: "codestral-2501")
        XCTAssertEqual(mistral.providerId, "mistral")
        XCTAssertEqual(mistral.providerName, "Mistral")

        // xAI Grok
        let grok = ModelCatalog.canonicalIdentity(provider: "xai", model: "grok-beta")
        XCTAssertEqual(grok.providerId, "xai")
        XCTAssertEqual(grok.providerName, "xAI")

        // Alibaba
        let qwen = ModelCatalog.canonicalIdentity(provider: "ollama", model: "qwen2.5-coder:7b")
        XCTAssertEqual(qwen.providerId, "alibaba")
        XCTAssertEqual(qwen.providerName, "Alibaba Cloud")

        // Ollama Local Custom
        let ollama = ModelCatalog.canonicalIdentity(provider: "ollama", model: "ornith-1.5:35b")
        XCTAssertEqual(ollama.providerId, "ollama")
        XCTAssertEqual(ollama.providerName, "Ollama (Local)")
    }

    func testLookup_claudeAndGeminiCostEstimation() {
        let catalog = ModelCatalog.shared

        // Claude Fable 5.1
        let fable = catalog.lookup(id: "claude-fable-5-1")
        XCTAssertNotNil(fable)
        XCTAssertEqual(fable?.provider, "anthropic")
        XCTAssertEqual(fable?.inputPerM, 10.00)
        XCTAssertEqual(fable?.outputPerM, 50.00)

        // Claude Opus 5
        let opus5 = catalog.lookup(id: "claude-opus-5")
        XCTAssertNotNil(opus5)
        XCTAssertEqual(opus5?.provider, "anthropic")
        XCTAssertEqual(opus5?.inputPerM, 5.00)
        XCTAssertEqual(opus5?.outputPerM, 25.00)

        // Claude Sonnet 3.7
        let sonnet = catalog.lookup(id: "claude-3-7-sonnet")
        XCTAssertNotNil(sonnet)
        XCTAssertEqual(sonnet?.provider, "anthropic")
        XCTAssertEqual(sonnet?.inputPerM, 3.00)
        XCTAssertEqual(sonnet?.outputPerM, 15.00)

        // Gemini 3.7 Flash
        let g37 = catalog.lookup(id: "gemini-3.7-flash")
        XCTAssertNotNil(g37)
        XCTAssertEqual(g37?.name, "Gemini 3.7 Flash")
        XCTAssertEqual(g37?.inputPerM, 0.15)
        XCTAssertEqual(g37?.outputPerM, 0.60)

        // Cost estimation verification
        let claudeCost = UsageEngine.estimateTokenCost(
            model: "claude-opus-5",
            inputTokens: 1_000,
            outputTokens: 1_000,
            cacheReadTokens: 10_000,
            cacheWriteTokens: 1_000
        )
        // 1000 * 5/1M + 1000 * 25/1M + 10000 * 0.5/1M + 1000 * 6.25/1M
        // = 0.005 + 0.025 + 0.005 + 0.00625 = 0.04125
        XCTAssertEqual(claudeCost, 0.04125, accuracy: 0.0001)

        let geminiCost = UsageEngine.estimateTokenCost(
            model: "gemini-3.7-flash",
            inputTokens: 10_000,
            outputTokens: 10_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0
        )
        // 10k * 0.15/1M + 10k * 0.60/1M = 0.0015 + 0.0060 = 0.0075
        XCTAssertEqual(geminiCost, 0.0075, accuracy: 0.0001)
    }
}
