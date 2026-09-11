import XCTest
import Foundation
import Network
@testable import TokenHorizon

final class OllamaProxyIntegrationTests: XCTestCase {

    override func setUp() {
        super.setUp()
        OllamaTelemetryStore.shared.resetForTesting()
    }

    func testParseTelemetry_nativeOllamaNDJSONStream() {
        let stream = """
        {"model":"qwen2.5-coder:7b","created_at":"2026-09-01T00:00:00Z","response":"def","done":false}
        {"model":"qwen2.5-coder:7b","created_at":"2026-09-01T00:00:01Z","response":" hello","done":false}
        {"model":"qwen2.5-coder:7b","created_at":"2026-09-01T00:00:02Z","response":"","done":true,"total_duration":5000000000,"load_duration":1000000,"prompt_eval_count":28,"prompt_eval_duration":450000000,"eval_count":142,"eval_duration":2840000000}
        """
        guard let data = stream.data(using: .utf8) else {
            XCTFail("Failed to encode stream data")
            return
        }

        let sample = OllamaTelemetryProxy.parseTelemetry(model: "qwen2.5-coder:7b", responseBody: data)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.model, "qwen2.5-coder:7b")
        XCTAssertEqual(sample?.evalCount, 142)
        XCTAssertEqual(sample?.evalDurationNs, 2840000000)
        XCTAssertEqual(sample?.promptEvalCount, 28)
        XCTAssertEqual(sample?.promptEvalDurationNs, 450000000)

        // Measured tok/s: 142 / 2.84s = 50.0 tok/s
        let rate = sample?.tokPerSec
        XCTAssertNotNil(rate)
        XCTAssertEqual(rate!, 50.0, accuracy: 0.1)

        // Prompt tok/s: 28 / 0.45s = 62.22 tok/s
        let promptRate = sample?.promptTokPerSec
        XCTAssertNotNil(promptRate)
        XCTAssertEqual(promptRate!, 62.22, accuracy: 0.1)
    }

    func testParseTelemetry_openAICompatibleSSEStream() {
        let sseStream = """
        data: {"id":"chatcmpl-123","object":"chat.completion.chunk","model":"llama3.2:3b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}

        data: {"id":"chatcmpl-123","object":"chat.completion.chunk","model":"llama3.2:3b","choices":[{"index":0,"delta":{"content":" world"}}]}

        data: {"id":"chatcmpl-123","object":"chat.completion.chunk","model":"llama3.2:3b","choices":[],"usage":{"prompt_tokens":15,"completion_tokens":85,"total_tokens":100}}

        data: [DONE]
        """
        guard let data = sseStream.data(using: .utf8) else {
            XCTFail("Failed to encode SSE stream")
            return
        }

        let elapsedNs: UInt64 = 1_700_000_000 // 1.7 seconds
        let sample = OllamaTelemetryProxy.parseTelemetry(model: "llama3.2:3b", responseBody: data, elapsedDurationNs: elapsedNs)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.model, "llama3.2:3b")
        XCTAssertEqual(sample?.evalCount, 85)
        XCTAssertEqual(sample?.evalDurationNs, elapsedNs)
        XCTAssertEqual(sample?.promptEvalCount, 15)

        // Measured tok/s: 85 / 1.7 = 50.0 tok/s
        let rate = sample?.tokPerSec
        XCTAssertNotNil(rate)
        XCTAssertEqual(rate!, 50.0, accuracy: 0.1)
    }

    func testParseTelemetry_openAINonStreamingResponse() {
        let jsonResponse = """
        {
          "id": "chatcmpl-456",
          "object": "chat.completion",
          "model": "deepseek-coder-v2:16b",
          "choices": [
            {
              "index": 0,
              "message": {
                "role": "assistant",
                "content": "function add(a, b) { return a + b; }"
              },
              "finish_reason": "stop"
            }
          ],
          "usage": {
            "prompt_tokens": 42,
            "completion_tokens": 120,
            "total_tokens": 162
          }
        }
        """
        guard let data = jsonResponse.data(using: .utf8) else {
            XCTFail("Failed to encode JSON response")
            return
        }

        let elapsedNs: UInt64 = 2_000_000_000 // 2.0 seconds
        let sample = OllamaTelemetryProxy.parseTelemetry(model: nil, responseBody: data, elapsedDurationNs: elapsedNs)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.model, "deepseek-coder-v2:16b")
        XCTAssertEqual(sample?.evalCount, 120)
        XCTAssertEqual(sample?.evalDurationNs, elapsedNs)
        XCTAssertEqual(sample?.promptEvalCount, 42)

        let rate = sample?.tokPerSec
        XCTAssertNotNil(rate)
        XCTAssertEqual(rate!, 60.0, accuracy: 0.1)
    }

    func testParseTelemetry_modelExtractedFromPayloadWhenRequestModelIsNil() {
        let ollamaChunk = """
        {"model":"mistral-nemo:12b","done":true,"eval_count":64,"eval_duration":1600000000,"prompt_eval_count":10,"prompt_eval_duration":200000000}
        """
        guard let data = ollamaChunk.data(using: .utf8) else {
            XCTFail("Failed to encode JSON")
            return
        }

        let sample = OllamaTelemetryProxy.parseTelemetry(model: nil, responseBody: data)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.model, "mistral-nemo:12b")
        XCTAssertEqual(sample?.evalCount, 64)
        XCTAssertEqual(sample?.evalDurationNs, 1600000000)
    }

    func testDecodeChunkedPayload_multiChunks() {
        let chunk1 = "{\"model\":\"qwen2.5:1.5b\","
        let chunk2 = "\"done\":true,\"eval_count\":25,\"eval_duration\":500000000}"
        let hex1 = String(format: "%x", chunk1.utf8.count)
        let hex2 = String(format: "%x", chunk2.utf8.count)

        let wireText = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n\(hex1)\r\n\(chunk1)\r\n\(hex2)\r\n\(chunk2)\r\n0\r\n\r\n"
        guard let wireData = wireText.data(using: .utf8) else {
            XCTFail("Failed to encode chunked wire data")
            return
        }

        let sample = OllamaTelemetryProxy.parseTelemetry(model: nil, responseBody: wireData)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.model, "qwen2.5:1.5b")
        XCTAssertEqual(sample?.evalCount, 25)
        XCTAssertEqual(sample?.evalDurationNs, 500000000)
    }

    func testJSONObjects_handlesSSEAndNDJSONAndRawJSON() {
        let sse = "data: {\"test\":1}\n\ndata: {\"test\":2}\n\ndata: [DONE]\n\n"
        let sseObjs = OllamaTelemetryProxy.JSONObjects(in: Data(sse.utf8))
        XCTAssertEqual(sseObjs.count, 2)
        XCTAssertEqual(sseObjs[0]["test"] as? Int, 1)
        XCTAssertEqual(sseObjs[1]["test"] as? Int, 2)

        let ndjson = "{\"a\":1}\n{\"b\":2}\n"
        let ndjsonObjs = OllamaTelemetryProxy.JSONObjects(in: Data(ndjson.utf8))
        XCTAssertEqual(ndjsonObjs.count, 2)
        XCTAssertEqual(ndjsonObjs[0]["a"] as? Int, 1)
        XCTAssertEqual(ndjsonObjs[1]["b"] as? Int, 2)

        let raw = "{\"c\":3,\"d\":\"ok\"}"
        let rawObjs = OllamaTelemetryProxy.JSONObjects(in: Data(raw.utf8))
        XCTAssertEqual(rawObjs.count, 1)
        XCTAssertEqual(rawObjs[0]["c"] as? Int, 3)
    }

    func testOllamaTelemetryStore_recentTokPerSecWeightedCalculation() {
        let store = OllamaTelemetryStore.shared

        // Record sample 1: 100 tokens in 2s (50 t/s)
        let s1 = OllamaTelemetrySample(
            model: "model-a",
            completedAt: Date().addingTimeInterval(-10),
            evalCount: 100,
            evalDurationNs: 2_000_000_000,
            promptEvalCount: 20,
            promptEvalDurationNs: 400_000_000
        )
        store.record(s1)

        // Record sample 2: 200 tokens in 3s (66.67 t/s)
        let s2 = OllamaTelemetrySample(
            model: "model-a",
            completedAt: Date(),
            evalCount: 200,
            evalDurationNs: 3_000_000_000,
            promptEvalCount: 40,
            promptEvalDurationNs: 600_000_000
        )
        store.record(s2)

        // Weighted total: (100 + 200) tokens / (2.0 + 3.0)s = 300 / 5.0 = 60.0 t/s
        let rate = store.recentTokPerSec(for: "model-a")
        XCTAssertNotNil(rate)
        XCTAssertEqual(rate!, 60.0, accuracy: 0.1)

        let usage = store.usage(for: "model-a")
        XCTAssertEqual(usage.tokensAll, 360) // (100+20) + (200+40)
        XCTAssertEqual(usage.messages, 2)
    }
}
