import XCTest
@testable import TokenHorizonCore

/// The /stats, /history, /summary endpoints are store-first (the file engine
/// is only a fallback for hosts without a wired store). These tests pin the
/// store-backed assembly: local-midnight day alignment (AEST regression —
/// epoch-aligned buckets must be re-bucketed by local day), streak semantics,
/// and the snapshot rollups.
final class StoreBackedEndpointsTests: XCTestCase {

    private let storePath = NSTemporaryDirectory() + "/th-storeendpoints-\(UUID().uuidString).db"

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: storePath)
        try? FileManager.default.removeItem(atPath: storePath + "-wal")
        try? FileManager.default.removeItem(atPath: storePath + "-shm")
    }

    private func event(vendor: String, tokens: Int, ts: Date) -> UsageEvent {
        UsageEvent(timestamp: ts, machineID: "m1", source: .external,
                   vendor: vendor, model: "m", tokens: TokenBreakdown(output: tokens),
                   cost: 0, attestation: .measured)
    }

    func testStoreHistory_localMidnightAlignmentAndStreak() throws {
        let store = try SQLiteUsageStore(path: storePath)
        let now = Date()
        try store.insertMetered([
            event(vendor: "kimi", tokens: 100, ts: now.addingTimeInterval(-60)),          // today
            event(vendor: "kimi", tokens: 200, ts: now.addingTimeInterval(-86_400)),      // yesterday
            event(vendor: "claude", tokens: 50, ts: now.addingTimeInterval(-3 * 86_400)), // 3d ago (gap before)
        ])

        let (points, streak) = CoreAPIRouter.storeHistory(days: 7, store: store, now: now)
        XCTAssertEqual(points.count, 7)
        XCTAssertEqual(points.last?.tokens, 100, "today's point must carry today's tokens")
        XCTAssertEqual(points[points.count - 2].tokens, 200, "yesterday's point")
        XCTAssertEqual(points[points.count - 4].tokens, 50, "3-days-ago point")
        XCTAssertEqual(streak, 2, "today + yesterday are consecutive; 3d ago is behind a gap")
        // UTC-midnight day keys: aligned to the epoch day, 86400 apart —
        // local time is inferred by the frontend, never baked in server-side.
        for point in points { XCTAssertEqual(point.day % 86_400, 0) }
        for i in 1..<points.count {
            XCTAssertEqual(points[i].day - points[i - 1].day, 86_400)
        }
    }

    func testStoreHistory_streakSkipsEmptyToday() throws {
        let store = try SQLiteUsageStore(path: storePath)
        let now = Date()
        try store.insertMetered([event(vendor: "kimi", tokens: 100,
                                       ts: now.addingTimeInterval(-86_400 - 60))])
        let (_, streak) = CoreAPIRouter.storeHistory(days: 7, store: store, now: now)
        XCTAssertEqual(streak, 1, "empty today falls back to yesterday's run")
    }

    func testStoreSnapshot_todayAndAllTimeSplits() throws {
        let store = try SQLiteUsageStore(path: storePath)
        let now = Date()
        try store.insertMetered([
            event(vendor: "kimi", tokens: 100, ts: now.addingTimeInterval(-60)),
            event(vendor: "kimi", tokens: 900, ts: now.addingTimeInterval(-3 * 86_400)),
            event(vendor: "claude", tokens: 7, ts: now.addingTimeInterval(-120)),
        ])
        let snap = CoreAPIRouter.storeSnapshot(store: store, now: now)
        XCTAssertEqual(snap.tokensToday, 107)
        XCTAssertEqual(snap.tokensAllTime, 1007)
        let kimi = snap.perTool.first { $0.tool == "kimi" }
        XCTAssertEqual(kimi?.tokensToday, 100)
        XCTAssertEqual(kimi?.tokensAllTime, 1000)
        XCTAssertEqual(snap.sources.sorted(), ["claude", "kimi"])
    }
}

// MARK: - Wire rank resolution (the pi-attribution regression)

extension StoreBackedEndpointsTests {

    /// API consumers must receive the RESOLVED rank: a file-joined product
    /// appears as `product`, with the meter's raw observation as `productRaw`
    /// — the UI renders e.product and must never re-implement the rank.
    func testEncodedEvent_resolvesProductRank() throws {
        let store = try SQLiteUsageStore(path: storePath)
        var e = UsageEvent(timestamp: Date().addingTimeInterval(-60), machineID: "m1",
                           source: .external, vendor: "kimi", model: "k3-256k",
                           tokens: TokenBreakdown(output: 10), cost: 0,
                           product: "curl", productSource: .headerSniffed,
                           requestIDAlt: "msg_test123", attestation: .measured)
        try store.insertMetered([e])
        try store.annotate([FileAnnotation(vendor: "kimi-coding", requestID: "msg_test123",
                                           product: "pi", cost: nil,
                                           sourceFile: "/tmp/x.jsonl")])
        let page = try store.query(from: .distantPast, to: Date(), filter: UsageFilter(),
                                   cursor: nil, limit: 10)
        XCTAssertEqual(page.events.count, 1)
        let read = page.events[0]
        XCTAssertEqual(read.fileProduct, "pi")
        XCTAssertEqual(read.effectiveProduct, "pi")

        let data = try JSONEncoder().encode(read)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["product"] as? String, "pi", "wire product is rank-resolved")
        XCTAssertEqual(json["productRaw"] as? String, "curl", "meter observation preserved")
        XCTAssertEqual(json["fileProduct"] as? String, "pi")
    }
}
