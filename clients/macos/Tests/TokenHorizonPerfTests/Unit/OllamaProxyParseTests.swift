import XCTest
@testable import TokenHorizon

/// Tests for the Ollama response parsers (native + OpenAI-compatible +
/// chunked framing). Pure Data in, values out — no daemon, no sockets.
final class OllamaProxyParseTests: XCTestCase {

    private func data(_ s: String) -> Data { Data(s.utf8) }

    func testNumberCoercion() {
        XCTAssertEqual(OllamaTelemetryProxy.number(7)?.intValue, 7)
        XCTAssertEqual(OllamaTelemetryProxy.number(2.5)?.doubleValue ?? -1, 2.5, accuracy: 1e-9)
        XCTAssertEqual(OllamaTelemetryProxy.number("42")?.intValue, 42)
        // Numeric strings that fail to parse coerce to zero (never nil-crash).
        XCTAssertEqual(OllamaTelemetryProxy.number("abc")?.intValue, 0)
        XCTAssertNil(OllamaTelemetryProxy.number(nil))
    }

    func testDecodeChunkedBody() {
        // No headers → passthrough.
        let plain = data(#"{"a":1}"#)
        XCTAssertEqual(OllamaTelemetryProxy.decodeChunkedBody(plain), plain)
        // Headers without chunked framing → body only.
        let withHeaders = data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"b\":2}")
        XCTAssertEqual(OllamaTelemetryProxy.decodeChunkedBody(withHeaders), data(#"{"b":2}"#))
        // Chunked framing → decoded.
        let chunked = data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n")
        XCTAssertEqual(OllamaTelemetryProxy.decodeChunkedBody(chunked), data("Wikipedia"))
        // Malformed chunk stream → best-effort prefix, never crash.
        XCTAssertNotNil(OllamaTelemetryProxy.decodeChunkedBody(data("zzzz")))
    }

    func testDecodeChunkedPayload() {
        let payload = OllamaTelemetryProxy.decodeChunkedPayload(data("3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"))
        XCTAssertEqual(payload, data("abcde"))
        XCTAssertEqual(OllamaTelemetryProxy.decodeChunkedPayload(Data()), Data())
    }

    func testParseTelemetryNativeFormat() {
        let body = data("""
        {"model":"qwen3","done":true,"eval_count":80,"eval_duration":2000000000,"prompt_eval_count":20,"prompt_eval_duration":100000000}
        """)
        let s = OllamaTelemetryProxy.parseTelemetry(responseBody: body)
        XCTAssertEqual(s?.model, "qwen3")
        XCTAssertEqual(s?.evalCount, 80)
        XCTAssertEqual(s?.evalDurationNs, 2_000_000_000)
        XCTAssertEqual(s?.promptEvalCount, 20)
    }

    func testParseTelemetryOpenAIFormat() {
        let body = data("""
        {"model":"gpt-oss","usage":{"completion_tokens":50,"prompt_tokens":10,"total_tokens":60}}
        """)
        let s = OllamaTelemetryProxy.parseTelemetry(responseBody: body)
        XCTAssertEqual(s?.evalCount, 50)
        XCTAssertEqual(s?.promptEvalCount, 10)
        // Explicit model param wins over the payload field.
        let renamed = OllamaTelemetryProxy.parseTelemetry(model: "override", responseBody: body)
        XCTAssertEqual(renamed?.model, "override")
    }

    func testParseTelemetryRejectsUnusable() {
        XCTAssertNil(OllamaTelemetryProxy.parseTelemetry(responseBody: data("{}")))
        XCTAssertNil(OllamaTelemetryProxy.parseTelemetry(responseBody: data("nope")))
        // done:false streaming fragments carry no final counts.
        XCTAssertNil(OllamaTelemetryProxy.parseTelemetry(
            responseBody: data(#"{"model":"m","done":false,"response":"hi"}"#)))
        // No model anywhere → skipped.
        XCTAssertNil(OllamaTelemetryProxy.parseTelemetry(
            responseBody: data(#"{"done":true,"eval_count":5,"eval_duration":100}"#)))
    }
}
