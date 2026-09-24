import XCTest
@testable import TokenHorizon

/// Codable round-trips for the durable cache payloads (history, trends,
/// engine parser state). Pure in-memory encode/decode — no disk involved,
/// so these pin schema stability without touching the developer's cache.
final class PayloadRoundTripTests: XCTestCase {

    private func coder() -> (JSONEncoder, JSONDecoder) {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .secondsSince1970
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .secondsSince1970
        return (enc, dec)
    }

    func testHistoryPayload() throws {
        let payload = DurableStore.HistoryCachePayload(
            points: [HistoryPoint(day: 7, tokens: 100, cost: 0.5, byTool: ["a": 100])],
            streak: 4, updatedAt: Date(timeIntervalSince1970: 1_700_000_000))
        let (enc, dec) = coder()
        let back = try dec.decode(DurableStore.HistoryCachePayload.self,
                                  from: enc.encode(payload))
        XCTAssertEqual(back.points.count, 1)
        XCTAssertEqual(back.points[0].tokens, 100)
        XCTAssertEqual(back.streak, 4)
        XCTAssertEqual(back.updatedAt.timeIntervalSince1970, 1_700_000_000, accuracy: 0.001)
    }

    func testTrendsPayload() throws {
        let payload = DurableStore.TrendsCachePayload(
            windows: ["1m": [HistoryPoint(day: 1, tokens: 9, cost: 0, byTool: [:])]],
            updatedAt: Date(timeIntervalSince1970: 42))
        let (enc, dec) = coder()
        let back = try dec.decode(DurableStore.TrendsCachePayload.self,
                                  from: enc.encode(payload))
        XCTAssertEqual(back.windows["1m"]?.first?.tokens, 9)
    }

    func testEngineStatePayload() throws {
        let additive = DurableStore.StoredAdditiveFile(
            offset: 123, allTokens: 456, allCost: 0.07, cacheRead: 8,
            buckets: ["3600": DurableStore.StoredBucket(tokens: 456, cost: 0.07)],
            models: ["m": DurableStore.StoredModelAccum(all: 456, today: 1, cost: 0.07)],
            watermarks: ["mid": DurableStore.StoredWatermark(input: 1, output: 2, cacheWrite: 3, cacheRead: 4)])
        let codex = DurableStore.StoredCodexFile(
            offset: 10,
            watermark: DurableStore.StoredCodexWatermark(input: 1, output: 2, cached: 3, reasoning: 4),
            last: DurableStore.StoredCodexWatermark(input: 0, output: 0, cached: 0, reasoning: 0),
            allTokens: 7, buckets: ["3600": DurableStore.StoredBucket(tokens: 7, cost: 0)],
            rate: DurableStore.StoredCodexRate(usedPercent: 12.5, windowMinutes: 300, resetsAt: 99),
            model: "gpt-5", modelTokens: 7)
        let payload = DurableStore.EngineStatePayload(
            claudeFiles: ["c": additive], kimiFiles: [:], genericFiles: [:],
            codexFiles: ["x": codex], updatedAt: Date(timeIntervalSince1970: 7))
        let (enc, dec) = coder()
        let back = try dec.decode(DurableStore.EngineStatePayload.self,
                                  from: enc.encode(payload))
        XCTAssertEqual(back.claudeFiles["c"]?.allTokens, 456)
        XCTAssertEqual(back.claudeFiles["c"]?.watermarks["mid"]?.output, 2)
        XCTAssertEqual(back.codexFiles["x"]?.rate?.windowMinutes, 300)
        XCTAssertEqual(back.codexFiles["x"]?.model, "gpt-5")
        // A nil rate round-trips as nil (not zero).
        let back2 = try dec.decode(
            DurableStore.StoredCodexFile.self,
            from: enc.encode(DurableStore.StoredCodexFile(
                offset: 0,
                watermark: DurableStore.StoredCodexWatermark(input: 0, output: 0, cached: 0, reasoning: 0),
                last: DurableStore.StoredCodexWatermark(input: 0, output: 0, cached: 0, reasoning: 0),
                allTokens: 0, buckets: [:], rate: nil, model: "", modelTokens: 0)))
        XCTAssertNil(back2.rate)
    }

    /// `sawTokenCount` is optional on disk: pre-v5 state files lack the key
    /// and must decode to nil (→ false), while v5+ values round-trip.
    func testCodexSawTokenCountBackwardCompat() throws {
        let (enc, dec) = coder()
        // A real v4 file carries every field except sawTokenCount.
        let legacyJSON = """
        {"offset":0,"watermark":{"input":0,"output":0,"cached":0,"reasoning":0},\
        "last":{"input":0,"output":0,"cached":0,"reasoning":0},"allTokens":0,\
        "buckets":{},"model":"","modelTokens":0,"inputAll":0,"outputAll":0,\
        "cachedAll":0,"reasoningAll":0,"requestsAll":0,"models":{},"modelDays":{}}
        """.data(using: .utf8)!
        let legacy = try dec.decode(DurableStore.StoredCodexFile.self, from: legacyJSON)
        XCTAssertNil(legacy.sawTokenCount)
        let modern = DurableStore.StoredCodexFile(
            offset: 0,
            watermark: DurableStore.StoredCodexWatermark(input: 0, output: 0, cached: 0, reasoning: 0),
            last: DurableStore.StoredCodexWatermark(input: 0, output: 0, cached: 0, reasoning: 0),
            sawTokenCount: true,
            allTokens: 0, buckets: [:], rate: nil, model: "", modelTokens: 0)
        let back = try dec.decode(DurableStore.StoredCodexFile.self, from: enc.encode(modern))
        XCTAssertEqual(back.sawTokenCount, true)
    }

    /// Snapshot decode stays backward-compatible when `parserHealth` is absent.
    func testSnapshotParserHealthDecodeDefault() throws {
        let snapJSON = #"{"tokensToday":5,"updatedAt":1700000000}"#.data(using: .utf8)!
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .secondsSince1970
        let snap = try dec.decode(UsageSnapshot.self, from: snapJSON)
        XCTAssertTrue(snap.parserHealth.isEmpty)
        var h = ParserHealth(source: "kimi")
        h.files = 2
        h.suspect = 3
        var snap2 = UsageSnapshot()
        snap2.parserHealth = [h]
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .secondsSince1970
        let back = try dec.decode(UsageSnapshot.self, from: enc.encode(snap2))
        XCTAssertEqual(back.parserHealth.first?.source, "kimi")
        XCTAssertEqual(back.parserHealth.first?.suspect, 3)
    }
}
