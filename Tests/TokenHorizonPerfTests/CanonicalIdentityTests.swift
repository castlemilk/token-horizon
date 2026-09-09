import XCTest
import TokenHorizonCore
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
}
