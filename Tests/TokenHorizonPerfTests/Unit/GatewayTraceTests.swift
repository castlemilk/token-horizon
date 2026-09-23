import XCTest
@testable import TokenHorizon

// Decode coverage for the gateway's trace/observability payloads. Field
// names are frozen on the wire (the :8765 API passes them through
// byte-for-byte), so these pin the contract both directions: new fields
// decode, and older sidecars lacking them still parse.
final class GatewayTraceTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testTraceDecodesFullSchema() throws {
        let t = try decode(GatewayTrace.self, """
        {"id":"abc-1","provider":"kimi","endpoint":"messages","path":"/th-kimi/v1/messages",
         "model":"kimi-k2","startedAt":1789443200.5,"ttftMs":230.4,"durationMs":1450.2,"stream":true,
         "statusCode":200,"usage":{"inputTokens":1200,"outputTokens":340,"totalTokens":1540,
         "cachedTokens":800,"reasoningTokens":100,"source":"accumulated"},
         "toolCalls":[{"name":"read_file","callId":"c1"}],"finishReasons":["end_turn"],
         "errorClass":"none","requestTruncated":false,"responseTruncated":false,
         "requestBytes":2048,"responseBytes":5120,"sessionKey":"sess-9","requestHash":"h1",
         "retrySuspect":false,"source":"proxy","client":"kimi-cli",
         "providerRequestId":"req_xyz","estCostUSD":null}
        """)
        XCTAssertEqual(t.provider, "kimi")
        XCTAssertEqual(t.client, "kimi-cli")
        XCTAssertEqual(t.source, "proxy")
        XCTAssertEqual(t.providerRequestId, "req_xyz")
        XCTAssertEqual(t.sessionKey, "sess-9")
        XCTAssertEqual(t.usage.inputTokens, 1200)
        XCTAssertEqual(t.usage.cachedTokens, 800)
        XCTAssertFalse(t.isError)
        XCTAssertNotNil(t.tokPerSec)
    }

    func testTraceDecodesLegacySchema() throws {
        // Pre-observability sidecar/day-file rows lack source/client/rid.
        let t = try decode(GatewayTrace.self, """
        {"id":"old-1","provider":"openai","endpoint":"chat_completions","path":"/v1/chat/completions",
         "model":"gpt-5","startedAt":1789443200.0,"durationMs":900.0,"stream":false,"statusCode":200,
         "usage":{"source":"reported"},"toolCalls":[],"finishReasons":[],
         "errorClass":"none","requestTruncated":false,"responseTruncated":false,
         "requestBytes":100,"responseBytes":200,"requestHash":"h","retrySuspect":false,
         "estCostUSD":null}
        """)
        XCTAssertEqual(t.provider, "openai")
        XCTAssertNil(t.client)
        XCTAssertNil(t.source)
        XCTAssertNil(t.providerRequestId)
    }

    func testStatsDecodesAggregationCuts() throws {
        let s = try decode(GatewayStats.self, """
        {"windowHours":24,"since":1789443200.0,"requests":10,"errorCount":2,"inputTokens":5000,
         "outputTokens":1200,"cachedTokens":3000,"retrySuspectCount":1,"toolCallCount":4,
         "estCostUSD":0,"errorRate":0.2,"toolCallRate":0.4,"cacheHitRate":0.6,"avgTtftMs":210.0,
         "p50DurationMs":900.0,"p95DurationMs":2400.0,"p50TtftMs":180.0,"p95TtftMs":500.0,
         "byModel":[{"provider":"openai","model":"gpt-5","requests":7,"errorCount":1,
           "inputTokens":4000,"outputTokens":900,"cachedTokens":2500,"avgTtftMs":200.0,
           "avgTokPerSec":42.0,"cacheHitRate":0.62,"toolCallRate":0.5,"retrySuspectCount":1,
           "estCostUSD":0}],
         "byProvider":[{"provider":"openai","requests":7,"errorCount":1,"inputTokens":4000,
           "outputTokens":900,"avgTtftMs":200.0,"estCostUSD":0}],
         "byClient":[{"client":"codex","requests":6,"errorCount":0}],
         "byError":[{"class":"rateLimited","count":2}]}
        """)
        XCTAssertEqual(s.requests, 10)
        XCTAssertEqual(s.p95DurationMs, 2400.0)
        XCTAssertEqual(s.byProvider.first?.provider, "openai")
        XCTAssertEqual(s.byClient.first?.client, "codex")
        XCTAssertEqual(s.byError.first?.class, "rateLimited")
    }

    func testStatsDecodesLegacyWithoutNewCuts() throws {
        let s = try decode(GatewayStats.self, """
        {"windowHours":24,"since":1789443200.0,"requests":1,"errorCount":0,"inputTokens":10,
         "outputTokens":5,"cachedTokens":0,"retrySuspectCount":0,"toolCallCount":0,"estCostUSD":0,
         "errorRate":0,"toolCallRate":0,"cacheHitRate":null,"avgTtftMs":null,
         "byModel":[]}
        """)
        XCTAssertEqual(s.requests, 1)
        XCTAssertNil(s.p95DurationMs)
        XCTAssertTrue(s.byProvider.isEmpty)
        XCTAssertTrue(s.byClient.isEmpty)
        XCTAssertTrue(s.byError.isEmpty)
    }

    func testSessionStatsDecodes() throws {
        let s = try decode(GatewaySessionStats.self, """
        {"sessionKey":"sess-1","requests":3,"errorCount":1,"providers":["kimi","openai"],
         "models":["kimi-k2","gpt-5"],"clients":["codex"],"inputTokens":800,"outputTokens":300,
         "toolCallCount":2,"firstAt":1789443000.0,"lastAt":1789443200.0,"spanMs":200000.0}
        """)
        XCTAssertEqual(s.sessionKey, "sess-1")
        XCTAssertEqual(s.providers, ["kimi", "openai"])
        XCTAssertEqual(s.spanMs, 200000.0)
    }
}
