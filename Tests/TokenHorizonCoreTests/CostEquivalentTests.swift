import XCTest
@testable import TokenHorizonCore

/// USD-normalized equivalent cost: EVERY request — subscription or
/// API-billed — gets a list-price valuation from catalog rates × token
/// breakdown (input/output/cache-read/cache-write at their own rates),
/// computed at READ time via the pricing cache (mirrors the spelling
/// cache). The label distinguishing a real charge from plan usage stays on
/// `cost`/`costSource`; equivalent cost is never written to stored rows, so
/// history reprices automatically on catalog updates.
final class CostEquivalentTests: XCTestCase {

    private var storePath: String!

    override func setUp() {
        storePath = NSTemporaryDirectory()
            .appendingPathComponent("th-equiv-\(UUID().uuidString).db")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: storePath)
        try? FileManager.default.removeItem(atPath: storePath + "-wal")
        try? FileManager.default.removeItem(atPath: storePath + "-shm")
    }

    private func makeStore() throws -> SQLiteUsageStore {
        try SQLiteUsageStore(path: storePath)
    }

    private func event(vendor: String, model: String,
                       tokens: TokenBreakdown,
                       cost: Double = 0, costSource: CostSource? = nil,
                       ts: Date = Date()) -> UsageEvent {
        UsageEvent(timestamp: ts, machineID: "m1", source: .external,
                   vendor: vendor, model: model, tokens: tokens,
                   cost: cost, costSource: costSource, attestation: .measured)
    }

    private func oneMEach() -> TokenBreakdown {
        TokenBreakdown(input: 1_000_000, output: 1_000_000,
                       cacheRead: 1_000_000, cacheWrite: 1_000_000)
    }

    // MARK: - Plan vs API: same normalization, different label

    func testPlanVendorRow_getsEquivalentCostWithPlanFreeLabel() throws {
        let store = try makeStore()
        // gpt-5-sol catalog rates: 2.50 in / 10.00 out / 0.50 cache-read.
        // cache-write priced as input → 1M each = 2.50+10.00+0.50+2.50.
        try store.insertMetered([event(vendor: "kimi", model: "gpt-5-sol",
                                       tokens: oneMEach(),
                                       cost: 0, costSource: .planFree)])
        let rows = try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                                   filter: UsageFilter(), cursor: nil, limit: 10).events
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.cost, 0)
        XCTAssertEqual(row.costSource, .planFree, "label stays: zero-marginal plan usage")
        XCTAssertEqual(row.costEquivalent ?? 0, 15.50, accuracy: 0.001)
    }

    func testAPIVendorRow_equivalentMatchesChargedCost() throws {
        let store = try makeStore()
        // API-billed: the charged cost (.computed via CostEngine) and the
        // read-side equivalent must agree — same rates, same breakdown.
        let tokens = TokenBreakdown(input: 500_000, output: 100_000,
                                    cacheRead: 200_000, cacheWrite: 50_000)
        let decision = CostEngine.decide(vendor: "deepseek", model: "deepseek-v4-pro",
                                         tokens: tokens)
        XCTAssertEqual(decision.source, .computed)
        try store.insertMetered([event(vendor: "deepseek", model: "deepseek-v4-pro",
                                       tokens: tokens,
                                       cost: decision.cost, costSource: decision.source)])
        let rows = try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                                   filter: UsageFilter(), cursor: nil, limit: 10).events
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.costEquivalent ?? -1, row.cost, accuracy: 0.000001,
                       "charged cost and list-price equivalent must agree for API vendors")
    }

    // MARK: - Aggregations

    func testAggregateSumsEquivalentPerGroup() throws {
        let store = try makeStore()
        try store.insertMetered([
            event(vendor: "kimi", model: "gpt-5-sol", tokens: oneMEach(), costSource: .planFree),
            event(vendor: "kimi", model: "gpt-5-sol", tokens: oneMEach(), costSource: .planFree),
        ])
        let aggs = try store.aggregate(from: .distantPast, to: Date().addingTimeInterval(60),
                                       groupBy: .vendor, filter: UsageFilter())
        let kimi = try XCTUnwrap(aggs.first { $0.key == "kimi" })
        XCTAssertEqual(kimi.costEquivalent ?? 0, 31.0, accuracy: 0.001)
        XCTAssertEqual(kimi.cost, 0)
    }

    func testBucketsAndSummarizeCarryEquivalent() throws {
        let store = try makeStore()
        try store.insertMetered([event(vendor: "kimi", model: "gpt-5-sol",
                                       tokens: oneMEach(), costSource: .planFree)])
        let buckets = try store.buckets(from: .distantPast, to: Date().addingTimeInterval(60),
                                        bucketSeconds: 900, filter: UsageFilter())
        XCTAssertEqual(buckets.first?.costEquivalent ?? 0, 15.50, accuracy: 0.001)

        let summary = try store.summarize(from: .distantPast, to: Date().addingTimeInterval(60),
                                          filter: UsageFilter())
        let kimi = try XCTUnwrap(summary.first { $0.vendor == "kimi" })
        XCTAssertEqual(kimi.costEquivalent ?? 0, 15.50, accuracy: 0.001)
        XCTAssertEqual(kimi.models.first?.costEquivalent ?? 0, 15.50, accuracy: 0.001)
    }

    // MARK: - Unknown pricing stays unknown (never a fake zero)

    func testUnpricedModel_equivalentIsNilNotZero() throws {
        let store = try makeStore()
        try store.insertMetered([event(vendor: "kimi", model: "zzz-no-such-model",
                                       tokens: oneMEach(), costSource: .planFree)])
        let rows = try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                                   filter: UsageFilter(), cursor: nil, limit: 10).events
        XCTAssertNil(rows.first?.costEquivalent)
        let aggs = try store.aggregate(from: .distantPast, to: Date().addingTimeInterval(60),
                                       groupBy: .vendor, filter: UsageFilter())
        XCTAssertNil(aggs.first?.costEquivalent)
    }

    // MARK: - Read-side by construction: pre-existing rows reprice without rewrites

    func testHistoricalRows_gainEquivalentWhenPricingArrives() throws {
        let store = try makeStore()
        // Insert while the model is unpriced → equivalent is nil.
        try store.insertMetered([event(vendor: "kimi", model: "zzz-late-priced",
                                       tokens: oneMEach(), costSource: .planFree)])
        var rows = try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                                   filter: UsageFilter(), cursor: nil, limit: 10).events
        XCTAssertNil(rows.first?.costEquivalent)
        // Pricing arrives (catalog refresh) — the pricing cache is pure
        // derivative state; a direct upsert simulates the next 30s refresh.
        try store.upsertPricingForTesting(raw: "kimi/zzz-late-priced",
                                          inputPerM: 1.0, outputPerM: 2.0, cacheReadPerM: nil)
        rows = try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                               filter: UsageFilter(), cursor: nil, limit: 10).events
        // 1M in ($1) + 1M out ($2) + 1M cache-write as input ($1);
        // cache-read unpriced.
        XCTAssertEqual(rows.first?.costEquivalent ?? 0, 4.0, accuracy: 0.001)
    }

    // MARK: - Validity intervals: the rate in effect AT REQUEST TIME

    func testRateChange_repricesForwardOnly() throws {
        let store = try makeStore()
        let t1 = Date(timeIntervalSince1970: 1_700_000_000)
        let t2: Int64 = 1_750_000_000
        let t3 = Date().addingTimeInterval(-3600)
        try store.upsertPricingForTesting(raw: "kimi/k3", validFrom: 0,
                                          inputPerM: 1.0, outputPerM: 2.0, cacheReadPerM: nil)
        try store.upsertPricingForTesting(raw: "kimi/k3", validFrom: t2,
                                          inputPerM: 10.0, outputPerM: 20.0, cacheReadPerM: nil)
        let tokens = TokenBreakdown(input: 1_000_000, output: 1_000_000)
        try store.insertMetered([
            event(vendor: "kimi", model: "k3", tokens: tokens,
                  costSource: .planFree, ts: t1),
            event(vendor: "kimi", model: "k3", tokens: tokens,
                  costSource: .planFree, ts: t3),
        ])
        let rows = try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                                   filter: UsageFilter(), cursor: nil, limit: 10).events
        let old = try XCTUnwrap(rows.first { abs($0.timestamp.timeIntervalSince(t1)) < 2 })
        let new = try XCTUnwrap(rows.first { abs($0.timestamp.timeIntervalSince(t3)) < 2 })
        XCTAssertEqual(old.costEquivalent ?? 0, 3.0, accuracy: 0.001,
                       "request before the change keeps the OLD rate")
        XCTAssertEqual(new.costEquivalent ?? 0, 30.0, accuracy: 0.001,
                       "request after the change gets the NEW rate")
    }

    func testFirstObservation_pricesAllPriorHistory() throws {
        let store = try makeStore()
        // Request predates ANY pricing knowledge (valid_from = 0 interval
        // inserted later) — best-available estimate applies retroactively.
        let ancient = Date(timeIntervalSince1970: 1_600_000_000)
        try store.insertMetered([event(vendor: "kimi", model: "k3",
                                       tokens: TokenBreakdown(input: 1_000_000, output: 1_000_000),
                                       costSource: .planFree, ts: ancient)])
        try store.upsertPricingForTesting(raw: "kimi/k3", validFrom: 0,
                                          inputPerM: 1.0, outputPerM: 2.0, cacheReadPerM: nil)
        let rows = try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                                   filter: UsageFilter(), cursor: nil, limit: 10).events
        XCTAssertEqual(rows.first?.costEquivalent ?? 0, 3.0, accuracy: 0.001)
    }

    // MARK: - Provider-scoped rates

    func testSameModelDifferentProviders_pricedPerChannel() throws {
        let store = try makeStore()
        // Same model id, different provider channels, different rates —
        // the raw key is vendor||'/'||model, so intervals never leak
        // across providers.
        try store.upsertPricingForTesting(raw: "kimi/k3", inputPerM: 1.0,
                                          outputPerM: 2.0, cacheReadPerM: nil)
        try store.upsertPricingForTesting(raw: "gateway/k3", inputPerM: 0.5,
                                          outputPerM: 1.0, cacheReadPerM: nil)
        let tokens = TokenBreakdown(input: 1_000_000, output: 1_000_000)
        try store.insertMetered([
            event(vendor: "kimi", model: "k3", tokens: tokens, costSource: .planFree),
            event(vendor: "gateway", model: "k3", tokens: tokens, cost: 1.5, costSource: .computed),
        ])
        let rows = try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                                   filter: UsageFilter(), cursor: nil, limit: 10).events
        XCTAssertEqual(rows.first { $0.vendor == "kimi" }?.costEquivalent ?? 0, 3.0, accuracy: 0.001)
        XCTAssertEqual(rows.first { $0.vendor == "gateway" }?.costEquivalent ?? 0, 1.5, accuracy: 0.001)
    }
}
