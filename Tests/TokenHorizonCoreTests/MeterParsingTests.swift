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
        XCTAssertEqual(tokens?.input, 11162)
        XCTAssertEqual(tokens?.output, 109)
        XCTAssertEqual(tokens?.cacheRead, 9000)
        XCTAssertEqual(tokens?.reasoning, 24)
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

    // MARK: - Classic data:-prefixed shape (no regression)

    func testDataPrefixedStreamStillParses() {
        let m = meter()
        let body = """
            data: {"id":"chatcmpl-1","usage":{"prompt_tokens":10,"completion_tokens":5}}

            data: [DONE]
            """
        let tokens = m.usage(from: exchange(path: "/v1/chat/completions", body: body))
        XCTAssertEqual(tokens?.input, 10)
        XCTAssertEqual(tokens?.output, 5)
    }
}
