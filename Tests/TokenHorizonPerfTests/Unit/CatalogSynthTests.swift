import XCTest
@testable import TokenHorizon

/// Tests for catalog synthesis (dynamic pricing for uncataloged models) and
/// provider doc-URL resolution. Pure string logic, fully hermetic.
final class CatalogSynthTests: XCTestCase {

    func testSynthesizeDeepSeek() {
        let flash = ModelCatalog.synthesizeDynamicEntry(for: "deepseek-flash")
        XCTAssertEqual(flash?.provider, "deepseek")
        XCTAssertEqual(flash?.inputPerM ?? -1, 0.15, accuracy: 1e-9)
        XCTAssertEqual(flash?.outputPerM ?? -1, 0.60, accuracy: 1e-9)
        let pro = ModelCatalog.synthesizeDynamicEntry(for: "deepseek-pro-v3")
        XCTAssertEqual(pro?.inputPerM ?? -1, 0.66, accuracy: 1e-9)
        XCTAssertEqual(pro?.outputPerM ?? -1, 1.98, accuracy: 1e-9)
    }

    func testSynthesizeOpenAITiers() {
        XCTAssertEqual(ModelCatalog.synthesizeDynamicEntry(for: "gpt-6-mini")?.inputPerM ?? -1,
                       0.10, accuracy: 1e-9)
        XCTAssertEqual(ModelCatalog.synthesizeDynamicEntry(for: "gpt-6-terra")?.inputPerM ?? -1,
                       1.20, accuracy: 1e-9)
        XCTAssertEqual(ModelCatalog.synthesizeDynamicEntry(for: "gpt-6")?.inputPerM ?? -1,
                       2.50, accuracy: 1e-9)
        XCTAssertEqual(ModelCatalog.synthesizeDynamicEntry(for: "gpt-6")?.provider, "openai")
    }

    func testSynthesizeClaudeTiers() {
        XCTAssertEqual(ModelCatalog.synthesizeDynamicEntry(for: "claude-opus-9")?.inputPerM ?? -1,
                       5.00, accuracy: 1e-9)
        XCTAssertEqual(ModelCatalog.synthesizeDynamicEntry(for: "claude-haiku-9")?.inputPerM ?? -1,
                       1.00, accuracy: 1e-9)
        XCTAssertEqual(ModelCatalog.synthesizeDynamicEntry(for: "claude-sonnet-9")?.inputPerM ?? -1,
                       3.00, accuracy: 1e-9)
    }

    func testSynthesizeGeminiAndGLM() {
        XCTAssertEqual(ModelCatalog.synthesizeDynamicEntry(for: "gemini-9-pro")?.inputPerM ?? -1,
                       1.25, accuracy: 1e-9)
        XCTAssertEqual(ModelCatalog.synthesizeDynamicEntry(for: "gemini-9-flash")?.inputPerM ?? -1,
                       0.15, accuracy: 1e-9)
        XCTAssertEqual(ModelCatalog.synthesizeDynamicEntry(for: "glm-9-flash")?.inputPerM ?? -1,
                       0.01, accuracy: 1e-9)
        XCTAssertEqual(ModelCatalog.synthesizeDynamicEntry(for: "glm-9")?.inputPerM ?? -1,
                       0.70, accuracy: 1e-9)
    }

    func testSynthesizeUnknownReturnsNil() {
        XCTAssertNil(ModelCatalog.synthesizeDynamicEntry(for: "some-random-thing"))
        XCTAssertNil(ModelCatalog.synthesizeDynamicEntry(for: ""))
    }

    func testDocUrl() {
        // Catalog entry URL wins.
        var entry = ModelCatalog.Entry(
            id: "m", name: "m", provider: "x", providerName: "X",
            inputPerM: 0, outputPerM: 0, cacheReadPerM: nil, contextK: 0,
            benchmarks: nil, docUrl: "https://example.com/docs", description: nil,
            reasoning: nil, toolCall: nil, vision: nil, openWeights: nil,
            discountPercent: nil, discountLabel: nil, discountDetail: nil,
            originalInputPerM: nil, originalOutputPerM: nil)
        XCTAssertEqual(ModelCatalog.docUrl(for: "x", model: "m", catalogEntry: entry)?.absoluteString,
                       "https://example.com/docs")
        entry.docUrl = nil
        struct Case { let provider: String; let model: String; let wantHost: String }
        let cases: [Case] = [
            Case(provider: "anthropic", model: "x", wantHost: "docs.anthropic.com"),
            Case(provider: "openai", model: "x", wantHost: "platform.openai.com"),
            Case(provider: "x", model: "gpt-9", wantHost: "platform.openai.com"),
            Case(provider: "google", model: "x", wantHost: "ai.google.dev"),
            Case(provider: "deepseek", model: "x", wantHost: "api-docs.deepseek.com"),
            Case(provider: "qwen", model: "x", wantHost: "alibabacloud.com"),
            Case(provider: "kimi", model: "x", wantHost: "moonshot.cn"),
            Case(provider: "glm", model: "x", wantHost: "open.bigmodel.cn"),
            Case(provider: "minimax", model: "x", wantHost: "minimaxi.com"),
            Case(provider: "xai", model: "x", wantHost: "docs.x.ai"),
            Case(provider: "mistral", model: "x", wantHost: "docs.mistral.ai"),
            Case(provider: "opencode", model: "x", wantHost: "opencode.ai"),
            Case(provider: "ollama", model: "qwen3:8b", wantHost: "ollama.com"),
            Case(provider: "unknown", model: "unknown", wantHost: "models.dev"),
        ]
        for (i, tc) in cases.enumerated() {
            let url = ModelCatalog.docUrl(for: tc.provider, model: tc.model, catalogEntry: entry)
            XCTAssertTrue(url?.absoluteString.contains(tc.wantHost) ?? false,
                          "case \(i) \(tc.provider)/\(tc.model)")
        }
        // Ollama tag is stripped to the base name.
        XCTAssertEqual(ModelCatalog.docUrl(for: "ollama", model: "qwen3:8b", catalogEntry: entry)?.absoluteString,
                       "https://ollama.com/library/qwen3")
    }
}
