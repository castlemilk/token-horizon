import XCTest
@testable import TokenHorizonCore

/// Wire-format regression tests for request meters.
/// - Prefixed bases (/zen/v1/..., /coding/v1/...) must meter via SUFFIX match.
/// - Zen streams start with `event:` (not `data:`) and carry usage in
///   `response.completed` → `response.usage`, plus trailing `ping` events.
final class MeterParsingTests: XCTestCase {

    private func meter() -> OpenAICompatibleMeter {
        OpenAICompatibleMeter(vendor: "opencode-go", listenPort: 9245,
                              targetBase: URL(string: "https://opencode.ai")!,
                              store: nil, sourceKind: .external)
    }

    private func exchange(path: String, body: String) -> MeteredExchange {
        var e = MeteredExchange()
        e.method = "POST"
        e.path = path
        e.responseBody = Data(body.utf8)
        e.status = 200
        return e
    }

    // MARK: - Path matching (suffixes, not prefixes)

    func testZenPathsMeter() {
        let m = meter()
        XCTAssertTrue(m.shouldMeter(method: "POST", path: "/zen/v1/responses"))
        XCTAssertTrue(m.shouldMeter(method: "POST", path: "/zen/v1/chat/completions"))
        // /messages is Anthropic-wire (AnthropicMeter's suffix), not this meter's.
    }

    func testClassicPathsStillMeter() {
        let m = meter()
        XCTAssertTrue(m.shouldMeter(method: "POST", path: "/v1/chat/completions"))
        XCTAssertTrue(m.shouldMeter(method: "POST", path: "/v1/responses"))
        XCTAssertFalse(m.shouldMeter(method: "GET", path: "/v1/chat/completions"))
        XCTAssertFalse(m.shouldMeter(method: "POST", path: "/v1/models"))
    }

    // MARK: - Zen SSE shape (event:-prefixed, ping trailer)

    private let zenStream = """
        event: response.output_text.delta
        data: {"type":"response.output_text.delta","delta":"OK","response":{"id":"resp_abc123","model":"muse-spark-1.3-contributor-free"}}

        event: response.completed
        data: {"type":"response.completed","response":{"id":"resp_abc123","model":"muse-spark-1.3-contributor-free","usage":{"input_tokens":11162,"output_tokens":109,"input_tokens_details":{"cached_tokens":9000},"output_tokens_details":{"reasoning_tokens":24}}}}

        data: [DONE]

        event: ping
        data: {"type":"ping","cost":"0"}
        """

    func testZenStreamUsage() {
        let m = meter()
        let tokens = m.usage(from: exchange(path: "/zen/v1/responses", body: zenStream))
        XCTAssertNotNil(tokens)
        // NET semantics: input excludes cache (11162-9000), output excludes
        // reasoning (109-24); total == provider truth 11162+109.
        XCTAssertEqual(tokens?.input, 2162)
        XCTAssertEqual(tokens?.output, 85)
        XCTAssertEqual(tokens?.cacheRead, 9000)
        XCTAssertEqual(tokens?.reasoning, 24)
        XCTAssertEqual(tokens?.total, 11271)
    }

    func testZenStreamRequestID() {
        let m = meter()
        XCTAssertEqual(m.requestID(for: exchange(path: "/zen/v1/responses", body: zenStream)),
                       "resp_abc123")
    }

    func testZenStreamEvent() {
        let m = meter()
        let event = m.event(from: exchange(path: "/zen/v1/responses", body: zenStream))
        XCTAssertNotNil(event)
        XCTAssertEqual(event?.vendor, "opencode-go")
    }

    func testOpencodeMeterDefaultsProduct() {
        let m = OpenCodeGoMeter(vendor: "opencode-go", listenPort: 9245,
                                targetBase: URL(string: "https://opencode.ai")!,
                                store: nil, sourceKind: .external)
        var e = MeteredExchange()
        e.method = "POST"
        e.path = "/zen/v1/responses"
        e.requestHeaders = [:] // opencode sends no User-Agent
        let attr = m.productAttribution(for: e)
        XCTAssertEqual(attr?.product, "opencode")
        // ...but an explicit label still wins
        m.productLabel = "my-tool"
        XCTAssertEqual(m.productAttribution(for: e)?.product, "my-tool")
    }

    // MARK: - Classic data:-prefixed shape (no regression)

    func testDataPrefixedStreamStillParses() {        let m = meter()
        let body = """
            data: {"id":"chatcmpl-1","usage":{"prompt_tokens":10,"completion_tokens":5}}

            data: [DONE]
            """
        let tokens = m.usage(from: exchange(path: "/v1/chat/completions", body: body))
        XCTAssertEqual(tokens?.input, 10)
        XCTAssertEqual(tokens?.output, 5)
    }

    /// Dual-spelled payloads (chat + Responses names) are alternates —
    /// max, never sum.
    func testDualSpelledUsage_takesMax() {
        let m = meter()
        let body = """
            data: {"id":"chatcmpl-2","usage":{"prompt_tokens":100,"input_tokens":100,"completion_tokens":20,"output_tokens":20,"prompt_tokens_details":{"cached_tokens":30},"input_tokens_details":{"cached_tokens":30},"completion_tokens_details":{"reasoning_tokens":5},"output_tokens_details":{"reasoning_tokens":5}}}

            data: [DONE]
            """
        let tokens = m.usage(from: exchange(path: "/v1/chat/completions", body: body))
        XCTAssertEqual(tokens?.input, 70)
        XCTAssertEqual(tokens?.output, 15)
        XCTAssertEqual(tokens?.cacheRead, 30)
        XCTAssertEqual(tokens?.reasoning, 5)
        XCTAssertEqual(tokens?.total, 120)
    }

    /// Some gateway steps arrive already net (subset larger than gross) —
    /// keep them as-is instead of zeroing into a loss.
    func testAlreadyNetPayload_keptAsIs() {
        let m = meter()
        let body = """
            data: {"id":"resp-net","usage":{"input_tokens":699,"output_tokens":159,"input_tokens_details":{"cached_tokens":147697},"output_tokens_details":{"reasoning_tokens":366}}}

            data: [DONE]
            """
        let tokens = m.usage(from: exchange(path: "/zen/v1/responses", body: body))
        XCTAssertEqual(tokens?.input, 699)
        XCTAssertEqual(tokens?.output, 159)
        XCTAssertEqual(tokens?.cacheRead, 147697)
        XCTAssertEqual(tokens?.reasoning, 366)
    }

    // MARK: - Anthropic wire: thinking tokens (kimi via anthropic endpoint)

    private func anthropicMeter() -> AnthropicMeter {
        AnthropicMeter(vendor: "kimi", listenPort: 9246,
                       targetBase: URL(string: "https://api.moonshot.cn")!,
                       store: nil, sourceKind: .external)
    }

    /// kimi thinking models report thinking tokens on the message_delta
    /// usage as output_tokens_details.thinking_tokens — a SUBSET of output.
    func testAnthropicDeltaThinkingTokens_parseAsReasoning() {
        let m = anthropicMeter()
        let sse = """
            event: message_start
            data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":100,"cache_read_input_tokens":50,"cache_creation_input_tokens":0}}}

            event: message_delta
            data: {"type":"message_delta","usage":{"output_tokens":463,"output_tokens_details":{"thinking_tokens":210}}}

            """
        let tokens = m.usage(from: exchange(path: "/coding/v1/messages", body: sse))
        // NET output: 463 gross - 210 thinking.
        XCTAssertEqual(tokens?.input, 100)
        XCTAssertEqual(tokens?.output, 253)
        XCTAssertEqual(tokens?.reasoning, 210)
        XCTAssertEqual(tokens?.cacheRead, 50)
    }

    /// Non-streaming responses carry the same details object.
    func testAnthropicNonStreamingThinkingTokens_parseAsReasoning() {
        let m = anthropicMeter()
        let json = """
            {"id":"msg_2","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens_details":{"thinking_tokens":7}}}
            """
        let tokens = m.usage(from: exchange(path: "/coding/v1/messages", body: json))
        XCTAssertEqual(tokens?.output, 13)
        XCTAssertEqual(tokens?.reasoning, 7)
    }

    /// No details object → reasoning stays zero, never garbage.
    func testAnthropicDeltaWithoutDetails_reasoningStaysZero() {
        let m = anthropicMeter()
        let sse = """
            event: message_start
            data: {"type":"message_start","message":{"id":"msg_3","usage":{"input_tokens":5}}}

            event: message_delta
            data: {"type":"message_delta","usage":{"output_tokens":9}}

            """
        let tokens = m.usage(from: exchange(path: "/coding/v1/messages", body: sse))
        XCTAssertEqual(tokens?.output, 9)
        XCTAssertEqual(tokens?.reasoning, 0)
    }
}

// MARK: - MITM addon agreement (#8: Swift UA table ↔ generated Python)

final class MitmAddonScriptTests: XCTestCase {

    /// The addon's UA_TABLE rows are generated from ProductSniff.uaTable —
    /// every Swift row must appear verbatim in the Python source, so the
    /// point-mode and MITM capture paths can never disagree on tool identity.
    func testAddonUATableMatchesSwiftTable() {
        let src = MitmAddonScript.source
        XCTAssertTrue(src.contains("UA_TABLE = ["), "addon must define UA_TABLE")
        XCTAssertTrue(src.contains("def product_sniff"), "addon must define product_sniff")
        for row in ProductSniff.uaTable {
            XCTAssertTrue(src.contains("(\"\(row.needle)\", \"\(row.product)\"),"),
                          "addon missing UA row for \(row.needle) → \(row.product)")
        }
        // Seam for manual python-syntax validation: TH_ADDON_DUMP=/tmp swift test
        if let dir = ProcessInfo.processInfo.environment["TH_ADDON_DUMP"] {
            try? src.write(toFile: "\(dir)/token_horizon_addon.py", atomically: true, encoding: .utf8)
        }
    }
}
