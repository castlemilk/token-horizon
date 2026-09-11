import XCTest
@testable import TokenHorizon

final class UsageEngineUnitTests: XCTestCase {

    func testCodexWatermark_totalAndDisplayTokens() {
        let wm = UsageEngine.CodexWatermark(input: 100, output: 50, cached: 25, reasoning: 10)
        XCTAssertEqual(wm.total, 185)
        XCTAssertEqual(wm.displayTokens, 185)
    }

    func testCodexWatermark_greaterThanOrEqual() {
        let wm1 = UsageEngine.CodexWatermark(input: 100, output: 50, cached: 25, reasoning: 10)
        let wm2 = UsageEngine.CodexWatermark(input: 80, output: 50, cached: 20, reasoning: 5)
        let wm3 = UsageEngine.CodexWatermark(input: 120, output: 40, cached: 25, reasoning: 10)

        XCTAssertTrue(wm1 >= wm2)
        XCTAssertFalse(wm2 >= wm1)
        XCTAssertFalse(wm1 >= wm3) // wm3 has more input, wm1 has more output
    }

    func testCodexWatermark_delta() {
        let current = UsageEngine.CodexWatermark(input: 150, output: 70, cached: 40, reasoning: 20)
        let prev = UsageEngine.CodexWatermark(input: 100, output: 50, cached: 25, reasoning: 10)

        let d = current.delta(from: prev)
        XCTAssertEqual(d.input, 50)
        XCTAssertEqual(d.output, 20)
        XCTAssertEqual(d.cached, 15)
        XCTAssertEqual(d.reasoning, 10)
        XCTAssertEqual(d.total, 95)
    }

    func testUsageEngine_windowLabel() {
        XCTAssertEqual(UsageEngine.windowLabel(minutes: 0), "session")
        XCTAssertEqual(UsageEngine.windowLabel(minutes: 5), "5m")
        XCTAssertEqual(UsageEngine.windowLabel(minutes: 60), "1h")
        XCTAssertEqual(UsageEngine.windowLabel(minutes: 300), "5h")
        XCTAssertEqual(UsageEngine.windowLabel(minutes: 1440), "1d")
        XCTAssertEqual(UsageEngine.windowLabel(minutes: 10080), "7d")
    }

    func testTrendWindow_specs() {
        XCTAssertEqual(TrendWindow.day.spec.count, 24)
        XCTAssertEqual(TrendWindow.day.spec.seconds, 3600)
        XCTAssertFalse(TrendWindow.day.spec.dailyAligned)

        XCTAssertEqual(TrendWindow.week.spec.count, 7)
        XCTAssertEqual(TrendWindow.week.spec.seconds, 86400)
        XCTAssertTrue(TrendWindow.week.spec.dailyAligned)

        XCTAssertEqual(TrendWindow.month.spec.count, 30)
        XCTAssertEqual(TrendWindow.quarter.spec.count, 90)
        XCTAssertEqual(TrendWindow.year.spec.count, 52)
    }

    func testUsageSnapshot_tokenFormatting() {
        XCTAssertEqual(UsageSnapshot.tokens(0), "0")
        XCTAssertEqual(UsageSnapshot.tokens(999), "999")
        XCTAssertEqual(UsageSnapshot.tokens(1000), "1.0k")
        XCTAssertEqual(UsageSnapshot.tokens(1500), "1.5k")
        XCTAssertEqual(UsageSnapshot.tokens(1_000_000), "1.0M")
        XCTAssertEqual(UsageSnapshot.tokens(2_500_000), "2.5M")
        XCTAssertEqual(UsageSnapshot.tokens(1_500_000_000), "1.50B")
    }

    func testUsageSnapshot_costFormatting() {
        XCTAssertEqual(UsageSnapshot.cost(0.0), "$0.00")
        XCTAssertEqual(UsageSnapshot.cost(1.234), "$1.23")
        XCTAssertEqual(UsageSnapshot.cost(99.99), "$99.99")
        XCTAssertEqual(UsageSnapshot.cost(150.75), "$151")
    }

    func testAdditiveFileState_accumulations() {
        var state = UsageEngine.AdditiveFileState()
        state.allTokens = 1000
        state.allCost = 0.05
        state.cacheRead = 200
        state.buckets[1725184800] = UsageEngine.HourBucket(tokens: 500, cost: 0.025)
        state.models["claude-3-5-sonnet"] = UsageEngine.ModelAccum(all: 1000, today: 500, cost: 0.05)

        XCTAssertEqual(state.allTokens, 1000)
        XCTAssertEqual(state.allCost, 0.05)
        XCTAssertEqual(state.buckets[1725184800]?.tokens, 500)
        XCTAssertEqual(state.models["claude-3-5-sonnet"]?.today, 500)
    }

    func testAdditiveWatermark_deduplicatesIdenticalBlocks() {
        var state = UsageEngine.AdditiveFileState()
        let mid = "msg_011Ceoce5v6tZp8K9sbD4AcJ"

        // First block: thinking
        let prev1 = state.watermarks[mid] ?? UsageEngine.AdditiveWatermark()
        let dIn1 = max(0, 2 - prev1.input)
        let dOut1 = max(0, 730 - prev1.output)
        let dCw1 = max(0, 6046 - prev1.cacheWrite)
        let dCr1 = max(0, 63890 - prev1.cacheRead)
        let dTok1 = dIn1 + dOut1 + dCw1 + dCr1
        state.watermarks[mid] = UsageEngine.AdditiveWatermark(input: 2, output: 730, cacheWrite: 6046, cacheRead: 63890)
        state.allTokens += dTok1

        XCTAssertEqual(dTok1, 2 + 730 + 6046 + 63890)
        XCTAssertEqual(state.allTokens, 70668)

        // Second block: text (exact duplicate usage snapshot)
        let prev2 = state.watermarks[mid] ?? UsageEngine.AdditiveWatermark()
        let dIn2 = max(0, 2 - prev2.input)
        let dOut2 = max(0, 730 - prev2.output)
        let dCw2 = max(0, 6046 - prev2.cacheWrite)
        let dCr2 = max(0, 63890 - prev2.cacheRead)
        let dTok2 = dIn2 + dOut2 + dCw2 + dCr2
        state.allTokens += dTok2

        // Duplicate block adds 0 delta tokens!
        XCTAssertEqual(dTok2, 0)
        XCTAssertEqual(state.allTokens, 70668)
    }

    func testAdditiveWatermark_handlesMonotonicStreamingTokens() {
        var state = UsageEngine.AdditiveFileState()
        let mid = "msg_011CenvxUx2w3uHvvXekZC47"

        // Chunk 1: streaming start (output_tokens: 3)
        let prev1 = state.watermarks[mid] ?? UsageEngine.AdditiveWatermark()
        let dIn1 = max(0, 2 - prev1.input)
        let dOut1 = max(0, 3 - prev1.output)
        let dCw1 = max(0, 1234 - prev1.cacheWrite)
        let dCr1 = max(0, 89027 - prev1.cacheRead)
        let dTok1 = dIn1 + dOut1 + dCw1 + dCr1
        state.watermarks[mid] = UsageEngine.AdditiveWatermark(input: 2, output: 3, cacheWrite: 1234, cacheRead: 89027)
        state.allTokens += dTok1

        XCTAssertEqual(dTok1, 2 + 3 + 1234 + 89027)

        // Chunk 2: streaming complete (output_tokens: 608)
        let prev2 = state.watermarks[mid] ?? UsageEngine.AdditiveWatermark()
        let dIn2 = max(0, 2 - prev2.input)
        let dOut2 = max(0, 608 - prev2.output)
        let dCw2 = max(0, 1234 - prev2.cacheWrite)
        let dCr2 = max(0, 89027 - prev2.cacheRead)
        let dTok2 = dIn2 + dOut2 + dCw2 + dCr2
        state.watermarks[mid] = UsageEngine.AdditiveWatermark(input: 2, output: 608, cacheWrite: 1234, cacheRead: 89027)
        state.allTokens += dTok2

        // Delta is exactly 608 - 3 = 605
        XCTAssertEqual(dTok2, 605)
        XCTAssertEqual(state.allTokens, 2 + 608 + 1234 + 89027)
    }

    func testConfiguredAgyModel_detection() {
        let model = UsageEngine.configuredAgyModel()
        XCTAssertFalse(model.isEmpty)
        // If settings.json exists with Gemini 3.8 Flash, it normalizes to gemini-3.8-flash, else fallback
        XCTAssertTrue(model.contains("gemini") || model.contains("flash"))
    }
}
