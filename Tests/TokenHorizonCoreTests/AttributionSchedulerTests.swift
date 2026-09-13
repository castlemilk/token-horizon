import XCTest
@testable import TokenHorizonCore

/// Reactive attribution ladder: unattributed LIVE events arm deferred
/// consolidation passes; probes prune when an annotation lands or the TTL
/// expires; consent gates the whole mechanism.
final class AttributionSchedulerTests: XCTestCase {

    private var storePath: String!

    override func setUp() {
        storePath = NSTemporaryDirectory()
            .appendingPathComponent("th-attr-\(UUID().uuidString).db")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: storePath)
        try? FileManager.default.removeItem(atPath: storePath + "-wal")
        try? FileManager.default.removeItem(atPath: storePath + "-shm")
    }

    private func makeScheduler(store: UsageStoring? = nil) -> AttributionScheduler {
        let s = AttributionScheduler()
        s.store = store
        s.consentGranted = { true }
        s.pollHandler = { [:] }
        return s
    }

    private func event(rid: String?, alt: String? = nil,
                       product: String? = nil) -> UsageEvent {
        UsageEvent(timestamp: Date(), machineID: "m1", source: .external,
                   vendor: "kimi", model: "k2",
                   tokens: TokenBreakdown(input: 10, output: 5),
                   cost: 0, product: product,
                   productSource: product.map { _ in .headerSniffed },
                   requestID: rid, requestIDAlt: alt, attestation: .measured)
    }

    // MARK: - Trigger filter

    func testNote_queuesOnlyUnattributedEventsWithRequestIDs() {
        let s = makeScheduler()
        s.note(events: [
            event(rid: "msg_1"),                              // actionable
            event(rid: "msg_2", product: "pi"),               // already attributed
            event(rid: nil, alt: nil),                        // unresolvable
            event(rid: "msg_1"),                              // dup collapses
        ])
        XCTAssertEqual(s.pendingCount, 1)
    }

    func testNote_queuesAltIDOnlyEvents() {
        let s = makeScheduler()
        s.note(events: [event(rid: nil, alt: "msg_alt")])
        XCTAssertEqual(s.pendingCount, 1)
    }

    // MARK: - Resolution

    func testPass_prunesProbesOnceAnnotationLands() throws {
        let store = try SQLiteUsageStore(path: storePath)
        var pollCount = 0
        let s = AttributionScheduler()
        s.store = store
        s.consentGranted = { true }
        s.pollHandler = { pollCount += 1; return [:] }
        s.note(events: [event(rid: "msg_x", alt: "msg_xalt")])
        XCTAssertEqual(s.pendingCount, 1)

        // Annotation matches the ALT id — either provider id resolves.
        try store.annotate([FileAnnotation(vendor: "kimi-coding", requestID: "msg_xalt",
                                           product: "pi")])
        s.runPass()
        XCTAssertEqual(pollCount, 1)
        XCTAssertEqual(s.pendingCount, 0)
    }

    func testPass_keepsUnresolvedProbesAndRetriesWithBackoff() throws {
        let store = try SQLiteUsageStore(path: storePath)
        var pollCount = 0
        let s = AttributionScheduler()
        s.store = store
        s.consentGranted = { true }
        s.pollHandler = { pollCount += 1; return [:] }
        s.note(events: [event(rid: "msg_never")])
        s.runPass()
        s.runPass()
        XCTAssertEqual(pollCount, 2)
        XCTAssertEqual(s.pendingCount, 1, "unresolved probe must survive across passes")
    }

    func testPass_expiresProbesPastTTL() throws {
        let store = try SQLiteUsageStore(path: storePath)
        var clock = Date()
        let s = AttributionScheduler()
        s.store = store
        s.ttl = 60
        s.consentGranted = { true }
        s.pollHandler = { [:] }
        s.now = { clock }
        s.note(events: [event(rid: "msg_old")])
        clock = clock.addingTimeInterval(120)   // files never caught up
        s.runPass()
        XCTAssertEqual(s.pendingCount, 0, "TTL-expired probe must drop")
    }

    // MARK: - Consent gate

    func testPass_drainsQueueWithoutFileReadingConsent() {
        var pollCount = 0
        let s = AttributionScheduler()
        s.store = try? SQLiteUsageStore(path: storePath)
        s.consentGranted = { false }
        s.pollHandler = { pollCount += 1; return [:] }
        s.note(events: [event(rid: "msg_1")])
        s.runPass()
        XCTAssertEqual(pollCount, 0, "no polling without .fileReading consent")
        XCTAssertEqual(s.pendingCount, 0, "queue drains; later grant + traffic re-arms")
    }

    // MARK: - Store probe

    func testAnnotatedRequestIDs_matchesStoredAnnotations() throws {
        let store = try SQLiteUsageStore(path: storePath)
        try store.annotate([FileAnnotation(vendor: "claude", requestID: "req_a", product: "claude-code"),
                            FileAnnotation(vendor: "pi", requestID: "msg_b", product: "pi")])
        let hits = try store.annotatedRequestIDs(among: ["req_a", "msg_b", "msg_c", ""])
        XCTAssertEqual(hits, ["req_a", "msg_b"])
        XCTAssertEqual(try store.annotatedRequestIDs(among: []), [])
    }
}
