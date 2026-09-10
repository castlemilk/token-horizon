import XCTest
@testable import TokenHorizon

/// Table-driven tests for the JSONL line parsers — the most
/// correctness-critical code in the app (every token count flows through
/// here). Cases mirror real provider line shapes; add a row, not a function,
/// when a new shape appears.
final class JsonlParserTests: XCTestCase {

    private func eng() -> UsageEngine { UsageEngine() }
    private func data(_ s: String) -> Data { Data(s.utf8) }
    private func hour(of epochSeconds: Double) -> Int { Int(epochSeconds / 3600) * 3600 }

    // MARK: - parseAdditiveLine

    func testAdditive_claudeAssistantBlock() {
        let line = """
        {"message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":5,"cache_read_input_tokens":100}},"timestamp":1725000000.0}
        """
        let p = eng().parseAdditiveLine(data(line))
        XCTAssertNotNil(p)
        XCTAssertEqual(p?.messageId, "msg_1")
        XCTAssertEqual(p?.inputTokens, 10)
        XCTAssertEqual(p?.outputTokens, 20)
        XCTAssertEqual(p?.cacheWriteTokens, 5)
        XCTAssertEqual(p?.cacheReadTokens, 100)
        XCTAssertEqual(p?.hour, hour(of: 1725000000))
    }

    func testAdditive_openAIShapeAndModelFallbacks() {
        // NOTE (known quirk, pinned): each usage dict is read through ALL of
        // anthropic+openai+gemini breakdowns and summed, so OpenAI-shaped
        // lines count twice (openai breakdown + gemini NSNumber fallbacks).
        // Dormant in practice — no scanned home emits prompt_tokens usage
        // (opencode goes through sqlite, not this parser) — but if that ever
        // changes, prefer-first-format here instead of accumulating.
        struct Case {
            let line: String
            let wantIn: Int
            let wantOut: Int
            let wantModel: String
        }
        let cases: [Case] = [
            Case(line: #"{"usage":{"prompt_tokens":30,"completion_tokens":40},"model":"gpt-4o"}"#,
                 wantIn: 60, wantOut: 80, wantModel: "gpt-4o"),
            Case(line: #"{"token_usage":{"prompt_tokens":3,"completion_tokens":4},"model_name":"qwen"}"#,
                 wantIn: 6, wantOut: 8, wantModel: "qwen"),
            Case(line: #"{"usage_metadata":{"input_tokens":5,"output_tokens":6},"modelId":"deepseek"}"#,
                 wantIn: 5, wantOut: 6, wantModel: "deepseek"),
        ]
        for (i, tc) in cases.enumerated() {
            let p = eng().parseAdditiveLine(data(tc.line))
            XCTAssertNotNil(p, "case \(i)")
            XCTAssertEqual(p?.inputTokens, tc.wantIn, "case \(i) in")
            XCTAssertEqual(p?.outputTokens, tc.wantOut, "case \(i) out")
            XCTAssertEqual(p?.model, tc.wantModel, "case \(i) model")
        }
    }

    func testAdditive_geminiCamelCaseAndCacheDetails() {
        let line = """
        {"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":9,"cachedContentTokenCount":3},"timestamp":1725000000.0}
        """
        let p = eng().parseAdditiveLine(data(line))
        XCTAssertEqual(p?.inputTokens, 7)
        XCTAssertEqual(p?.outputTokens, 9)
        XCTAssertEqual(p?.cacheReadTokens, 3)
    }

    func testAdditive_openAICachedTokensDetail() {
        let line = #"{"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":60}}}"#
        let p = eng().parseAdditiveLine(data(line))
        // Input doubles via the openai+gemini overlap documented above;
        // cache_read comes only from the details block.
        XCTAssertEqual(p?.inputTokens, 200)
        XCTAssertEqual(p?.cacheReadTokens, 60)
    }

    func testAdditive_costBlocks() {
        let costUSD = #"{"message":{"usage":{"input_tokens":1,"output_tokens":1}},"costUSD":0.5}"#
        XCTAssertEqual(eng().parseAdditiveLine(data(costUSD))?.explicitCost ?? -1, 0.5, accuracy: 1e-9)
        let costBlock = #"{"message":{"usage":{"input_tokens":1,"output_tokens":1}},"cost":{"total":1.25}}"#
        XCTAssertEqual(eng().parseAdditiveLine(data(costBlock))?.explicitCost ?? -1, 1.25, accuracy: 1e-9)
    }

    func testAdditive_charCountFallback() {
        // 8 chars, no usage: est max(1, 8/4) = 2 input tokens (HUMAN type).
        let human = #"{"content":"abcdefgh","type":"HUMAN"}"#
        let p = eng().parseAdditiveLine(data(human))
        XCTAssertEqual(p?.inputTokens, 2)
        XCTAssertEqual(p?.outputTokens, 0)
        // PLANNER_RESPONSE routes the estimate to output.
        let planner = #"{"content":"abcdefgh","type":"PLANNER_RESPONSE"}"#
        let q = eng().parseAdditiveLine(data(planner))
        XCTAssertEqual(q?.outputTokens, 2)
        XCTAssertEqual(q?.inputTokens, 0)
    }

    func testAdditive_messageIdFallbackAndMillisTimestamp() {
        let line = #"{"id":"abc","usage":{"input_tokens":5,"output_tokens":5},"timestamp":1725000000000.0}"#
        let p = eng().parseAdditiveLine(data(line))
        XCTAssertEqual(p?.messageId, "abc")
        XCTAssertEqual(p?.hour, Int(1725000000 / 3600) * 3600)
    }

    func testAdditive_garbageReturnsNil() {
        for line in ["not json", "{}", #"{"foo":1}"#, "[]", ""] {
            XCTAssertNil(eng().parseAdditiveLine(data(line)), line)
        }
    }

    // MARK: - parseKimiLine

    func testKimi_snakeAndCamelAliases() {
        let ts = 1725000000.0
        let snake = """
        {"message":{"payload":{"token_usage":{"input_other":3,"output":7,"input_cache_read":11,"input_cache_creation":13}}},"timestamp":\(ts)}
        """
        let camel = """
        {"message":{"payload":{"token_usage":{"inputOther":3,"output":7,"inputCacheRead":11,"inputCacheCreation":13}}},"timestamp":\(ts)}
        """
        for line in [snake, camel] {
            let p = eng().parseKimiLine(data(line))
            XCTAssertEqual(p?.tokens, 34, line)
            XCTAssertEqual(p?.hour, hour(of: ts), line)
        }
    }

    func testKimi_zeroOrMissingReturnsNil() {
        let zero = #"{"message":{"payload":{"token_usage":{"input_other":0,"output":0}}}}"#
        XCTAssertNil(eng().parseKimiLine(data(zero)))
        XCTAssertNil(eng().parseKimiLine(data(#"{"message":{}}"#)))
        XCTAssertNil(eng().parseKimiLine(data("garbage")))
    }

    // MARK: - parseCodexLine

    func testCodex_fullLine() {
        // Codex lines carry STRING timestamps (epoch doubles fall back to
        // the current hour by design).
        let line = """
        {"timestamp":"2024-08-30T12:34:56Z","payload":{"model":"gpt-5",\
        "info":{"total_token_usage":{"input_tokens":100,"output_tokens":50,\
        "cached_input_tokens":20,"cache_read_input_tokens":25,\
        "reasoning_output_tokens":10},\
        "last_token_usage":{"input_tokens":90,"output_tokens":40,\
        "cached_input_tokens":15,"reasoning_output_tokens":8}},\
        "rate_limits":{"primary":{"used_percent":12.5,"window_minutes":300,\
        "resets_at":1725003600}}}}
        """
        let p = eng().parseCodexLine(data(line))
        XCTAssertNotNil(p)
        XCTAssertEqual(p?.totals?.input, 100)
        XCTAssertEqual(p?.totals?.output, 50)
        // cached = max(cached_input_tokens, cache_read_input_tokens)
        XCTAssertEqual(p?.totals?.cached, 25)
        XCTAssertEqual(p?.totals?.reasoning, 10)
        XCTAssertEqual(p?.last?.input, 90)
        XCTAssertEqual(p?.model, "gpt-5")
        XCTAssertEqual(p?.rate?.usedPercent ?? -1, 12.5, accuracy: 1e-9)
        XCTAssertEqual(p?.rate?.windowMinutes, 300)
        XCTAssertEqual(p?.rate?.resetsAt, 1725003600)
        let expectedDay = ISO8601DateFormatter().date(from: "2024-08-30T12:34:56Z").map {
            Int($0.timeIntervalSince1970 / 3600) * 3600
        }
        XCTAssertEqual(p?.hour, expectedDay)
    }

    func testCodex_modelFallbackChain() {
        // parseCodexLine (unlike parseAdditiveLine) returns model-only lines:
        // its nil-guard requires only one of totals/rate/model.
        let cases: [(line: String, want: String)] = [
            (#"{"payload":{"turn_context":{"model":"tc-model"}}}"#, "tc-model"),
            (#"{"payload":{"managed_instructions":{"model":"mi-model"}}}"#, "mi-model"),
            (#"{"payload":{"personality":{"model":"p-model"}}}"#, "p-model"),
            (#"{"model":"top-model"}"#, "top-model"),
        ]
        for (i, tc) in cases.enumerated() {
            XCTAssertEqual(eng().parseCodexLine(data(tc.line))?.model, tc.want, "case \(i)")
        }
    }

    func testCodex_emptyReturnsNil() {
        XCTAssertNil(eng().parseCodexLine(data("{}")))
        XCTAssertNil(eng().parseCodexLine(data("nope")))
    }

    // MARK: - codexAccept

    func testCodexAccept_monotonicDelta() {
        let e = eng()
        var st = UsageEngine.CodexFileState()
        let got = e.codexAccept(UsageEngine.CodexWatermark(input: 100, output: 50, cached: 10, reasoning: 5),
                                last: UsageEngine.CodexWatermark(input: 100, output: 50, cached: 10, reasoning: 5),
                                state: &st)
        XCTAssertEqual(got, 165)
        XCTAssertEqual(st.watermark.input, 100)
    }

    func testCodexAccept_staleSnapshotCountsZero() {
        let e = eng()
        // Watermark at 10k; regression to 9,990 (>=98%) = stale re-emit.
        var st = UsageEngine.CodexFileState()
        st.watermark = UsageEngine.CodexWatermark(input: 10000, output: 0, cached: 0, reasoning: 0)
        st.last = UsageEngine.CodexWatermark(input: 9990, output: 0, cached: 0, reasoning: 0)
        let got = e.codexAccept(UsageEngine.CodexWatermark(input: 9990, output: 0, cached: 0, reasoning: 0),
                                last: UsageEngine.CodexWatermark(input: 9990, output: 0, cached: 0, reasoning: 0),
                                state: &st)
        XCTAssertEqual(got, 0)
    }

    func testCodexAccept_hardResetCountsLast() {
        let e = eng()
        var st = UsageEngine.CodexFileState()
        st.watermark = UsageEngine.CodexWatermark(input: 1000, output: 500, cached: 0, reasoning: 0)
        st.last = UsageEngine.CodexWatermark(input: 5, output: 5, cached: 0, reasoning: 0)
        // cur total 15: 15*100=1500 < 1500*98 and 15+10*2=35 < 1500 → reset.
        let got = e.codexAccept(UsageEngine.CodexWatermark(input: 10, output: 5, cached: 0, reasoning: 0),
                                last: UsageEngine.CodexWatermark(input: 5, output: 5, cached: 0, reasoning: 0),
                                state: &st)
        XCTAssertEqual(got, 10)
    }
}
