import XCTest
#if canImport(SQLite3)
import SQLite3
#endif
@testable import TokenHorizonCore

/// Contract tests for the metered-only usage pipeline:
/// - files NEVER create usage rows; annotations join metered rows at READ time
/// - the join is order-independent BY CONSTRUCTION (nothing is written
///   between the tables; the LEFT JOIN happens in queries)
/// - full resolution is preserved: the meter's own product/cost and the
///   file's product/cost are stored side by side; ranks resolve on read
///   (explicit label > file > sniffed; reported cost > computed)
/// - stored spellings are RAW; vendor/model canonicalization is query-time
/// - limits consolidate per vendor ACCOUNT (multi-account never merges)
final class UsageStoreAnnotationTests: XCTestCase {

    private var storePath: String!

    override func setUp() {
        storePath = NSTemporaryDirectory()
            .appendingPathComponent("th-annot-\(UUID().uuidString).db")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: storePath)
        try? FileManager.default.removeItem(atPath: storePath + "-wal")
        try? FileManager.default.removeItem(atPath: storePath + "-shm")
    }

    private func makeStore() throws -> SQLiteUsageStore {
        try SQLiteUsageStore(path: storePath)
    }

    private func meteredEvent(rid: String, vendor: String = "claude",
                              model: String = "claude-opus-4-5",
                              product: String? = nil,
                              productSource: ProductSource? = nil,
                              cost: Double = 0.5,
                              costSource: CostSource? = .computed) -> UsageEvent {
        UsageEvent(timestamp: Date(), machineID: "m1", source: .external,
                   vendor: vendor, model: model,
                   tokens: TokenBreakdown(input: 100, output: 50),
                   cost: cost, product: product, productSource: productSource,
                   costSource: costSource, accountID: "claude:aabbccdd11223344",
                   requestID: rid, attestation: .measured)
    }

    private func events(_ store: SQLiteUsageStore, filter: UsageFilter = UsageFilter()) throws -> [UsageEvent] {
        try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                        filter: filter, cursor: nil, limit: 100).events
    }

    // MARK: - Order independence (join at read time)

    func testAnnotationBeforeMeteredEvent_joinsAtRead() throws {
        let store = try makeStore()
        try store.annotate([FileAnnotation(vendor: "claude", requestID: "req_1",
                                           product: "claude-code")])
        try store.insertMetered([meteredEvent(rid: "req_1")])
        let event = try XCTUnwrap(events(store).first)
        XCTAssertNil(event.product)                       // meter's own view preserved
        XCTAssertEqual(event.fileProduct, "claude-code")  // file view preserved alongside
        XCTAssertEqual(event.effectiveProduct, "claude-code")
    }

    func testAnnotationAfterMeteredEvent_joinsAtRead() throws {
        let store = try makeStore()
        try store.insertMetered([meteredEvent(rid: "req_2")])
        try store.annotate([FileAnnotation(vendor: "claude", requestID: "req_2",
                                           product: "claude-code")])
        let event = try XCTUnwrap(events(store).first)
        XCTAssertEqual(event.fileProduct, "claude-code")
        XCTAssertEqual(event.effectiveProduct, "claude-code")
    }

    func testAltRequestIDJoins_piStyleBodyID() throws {
        let store = try makeStore()
        var e = meteredEvent(rid: "req_hdr")
        e.requestIDAlt = "msg_body"
        try store.insertMetered([e])
        try store.annotate([FileAnnotation(vendor: "claude", requestID: "msg_body",
                                           product: "pi", cost: 0.42)])
        let event = try XCTUnwrap(events(store).first)
        XCTAssertEqual(event.cost, 0.5, accuracy: 1e-9)        // computed cost preserved
        XCTAssertEqual(event.fileCost ?? 0, 0.42, accuracy: 1e-9)
        XCTAssertEqual(event.effectiveCost, 0.42, accuracy: 1e-9)
        XCTAssertEqual(event.effectiveCostSource, .reported)
    }

    // MARK: - Resolution ranks (decided at query time, nothing overwritten)

    func testExplicitLabelOutranksFile_fileOutranksSniffed() throws {
        let store = try makeStore()
        try store.insertMetered([
            meteredEvent(rid: "req_a", product: "node-sdk", productSource: .headerSniffed),
            meteredEvent(rid: "req_b", product: "claude-code", productSource: .explicitLabel),
        ])
        try store.annotate([
            FileAnnotation(vendor: "claude", requestID: "req_a", product: "pi"),
            FileAnnotation(vendor: "claude", requestID: "req_b", product: "pi"),
        ])
        let byRid = Dictionary(uniqueKeysWithValues: try events(store).map { ($0.requestID ?? "", $0) })
        // sniffed product preserved raw; file wins the EFFECTIVE rank
        XCTAssertEqual(byRid["req_a"]?.product, "node-sdk")
        XCTAssertEqual(byRid["req_a"]?.fileProduct, "pi")
        XCTAssertEqual(byRid["req_a"]?.effectiveProduct, "pi")
        // explicit label is never outranked
        XCTAssertEqual(byRid["req_b"]?.fileProduct, "pi")
        XCTAssertEqual(byRid["req_b"]?.effectiveProduct, "claude-code")
    }

    func testUnmatchedAnnotationCreatesNoUsageRow() throws {
        let store = try makeStore()
        try store.annotate([FileAnnotation(vendor: "claude", requestID: "req_ghost",
                                           product: "claude-code")])
        XCTAssertEqual(try store.count(), 0)  // files never create usage rows
    }

    func testAnnotationIsIdempotent_acrossRepeatedPolls() throws {
        let store = try makeStore()
        try store.insertMetered([meteredEvent(rid: "req_i")])
        let annotation = FileAnnotation(vendor: "claude", requestID: "req_i",
                                        product: "claude-code", cost: 1.5)
        try store.annotate([annotation])
        try store.annotate([annotation])
        try store.annotate([annotation])
        let all = try events(store)
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].effectiveCost, 1.5, accuracy: 1e-9)
    }

    // MARK: - Raw storage, canonical queries

    func testRawVendorSpellingsFoldAtQueryTime() throws {
        let store = try makeStore()
        try store.insertMetered([
            meteredEvent(rid: "r1", vendor: "anthropic"),
            meteredEvent(rid: "r2", vendor: "claude"),
            meteredEvent(rid: "r3", vendor: "kimi"),
        ])
        // stored raw
        let raws = try events(store).map { $0.vendor }
        XCTAssertTrue(raws.contains("anthropic"))
        // vendor filter canonicalizes both sides
        let filtered = try events(store, filter: UsageFilter(vendor: "anthropic"))
        XCTAssertEqual(filtered.count, 2)
        // aggregate groups canonically
        let groups = try store.aggregate(from: .distantPast, to: Date().addingTimeInterval(60),
                                         groupBy: .vendor, filter: UsageFilter())
        XCTAssertEqual(Set(groups.map { $0.key }), ["claude", "kimi"])
        XCTAssertEqual(groups.first { $0.key == "claude" }?.requests, 2)
    }

    func testRawModelSpellingsFoldInAggregates() throws {
        let store = try makeStore()
        try store.insertMetered([
            meteredEvent(rid: "m1", model: "claude-opus-4-5-20251101"),
            meteredEvent(rid: "m2", model: "claude-opus-4.5"),
        ])
        let groups = try store.aggregate(from: .distantPast, to: Date().addingTimeInterval(60),
                                         groupBy: .model, filter: UsageFilter())
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].key, "claude/claude-opus-4-5")
        XCTAssertEqual(groups[0].requests, 2)
    }

    func testProductAggregateUsesEffectiveRank() throws {
        let store = try makeStore()
        try store.insertMetered([meteredEvent(rid: "p1", product: "node-sdk",
                                              productSource: .headerSniffed)])
        try store.annotate([FileAnnotation(vendor: "claude", requestID: "p1", product: "pi")])
        let groups = try store.aggregate(from: .distantPast, to: Date().addingTimeInterval(60),
                                         groupBy: .product, filter: UsageFilter())
        XCTAssertEqual(groups.map { $0.key }, ["pi"])
    }

    // MARK: - Multi-account limits

    func testLimitSnapshotsConsolidatePerAccount_neverAcrossAccounts() throws {
        let store = try makeStore()
        let now = Date()
        try store.recordLimits([
            LimitSnapshot(recordedAt: now, machineID: "m1", provider: "claude",
                          accountID: "claude:aaaa", label: "5h", usedPercent: 40),
            LimitSnapshot(recordedAt: now, machineID: "m1", provider: "claude",
                          accountID: "claude:bbbb", label: "5h", usedPercent: 80),
        ])
        // Same minute, same account → dedups; different account → separate row.
        try store.recordLimits([
            LimitSnapshot(recordedAt: now.addingTimeInterval(5), machineID: "m1",
                          provider: "claude", accountID: "claude:aaaa",
                          label: "5h", usedPercent: 41),
        ])
        let rows = try store.limitHistory(from: .distantPast,
                                          to: now.addingTimeInterval(120), provider: "claude")
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(Set(rows.map { $0.accountID }), ["claude:aaaa", "claude:bbbb"])
    }

    func testLimitHistoryFoldsProviderAliases() throws {
        let store = try makeStore()
        let now = Date()
        try store.recordLimits([
            LimitSnapshot(recordedAt: now, machineID: "m1", provider: "anthropic",
                          accountID: "", label: "5h", usedPercent: 10),
            LimitSnapshot(recordedAt: now, machineID: "m1", provider: "claude",
                          accountID: "", label: "5h", usedPercent: 20),
            LimitSnapshot(recordedAt: now, machineID: "m1", provider: "kimi",
                          accountID: "", label: "5h", usedPercent: 30),
        ])
        let rows = try store.limitHistory(from: .distantPast,
                                          to: now.addingTimeInterval(120), provider: "claude")
        XCTAssertEqual(rows.count, 2)  // anthropic + claude fold together
        XCTAssertEqual(Set(rows.map { $0.usedPercent }), [10, 20])
    }

    // MARK: - Machine alias

    func testMachineAliasSanitization() {
        XCTAssertEqual(MachineIdentity.sanitizedAlias("Wockhardt's MacBook Pro.local"),
                       "wockhardt-s-macbook-pro-local")
        XCTAssertEqual(MachineIdentity.sanitizedAlias("DEV-BOX_01"), "dev-box-01")
        XCTAssertEqual(MachineIdentity.sanitizedAlias("---"), "")
        XCTAssertTrue(MachineIdentity.sanitizedAlias(String(repeating: "a", count: 50)).count <= 32)
    }

    func testMachineAggregateGroupsByAliasNotUUID() throws {
        let store = try makeStore()
        var e1 = meteredEvent(rid: "a1")
        e1.machineAlias = "macbook-pro"
        var e2 = meteredEvent(rid: "a2")
        e2.machineAlias = "macbook-pro"
        try store.insertMetered([e1, e2])
        let groups = try store.aggregate(from: .distantPast, to: Date().addingTimeInterval(60),
                                         groupBy: .machine, filter: UsageFilter())
        XCTAssertEqual(groups.map { $0.key }, ["macbook-pro"])
        XCTAssertEqual(groups[0].requests, 2)
    }

    // MARK: - v1 schema: no migrations, legacy archived aside

    #if canImport(SQLite3)
    func testPreV1DatabaseIsArchivedAside_neverMigrated() throws {
        // Simulate the discarded implementation: a usage_event table with no
        // user_version pragma.
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(storePath, &db,
                       SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil), SQLITE_OK)
        sqlite3_exec(db, "CREATE TABLE usage_event (id TEXT PRIMARY KEY)", nil, nil, nil)
        sqlite3_close(db)
        let store = try makeStore()   // must archive, then start fresh
        XCTAssertEqual(try store.count(), 0)
        let siblings = try FileManager.default.contentsOfDirectory(atPath: NSTemporaryDirectory())
        XCTAssertTrue(siblings.contains { $0.hasPrefix("th-annot-") && $0.contains(".legacy-") })
    }
    #endif

    // MARK: - Capture mode (point ↔ mitm)

    func testCaptureModeDefaultsToPointAndEnvOverrides() {
        setenv("TH_CAPTURE_MODE", "mitm", 1)
        XCTAssertEqual(SettingsStore.shared.meterCaptureMode, .mitm)
        setenv("TH_CAPTURE_MODE", "point", 1)
        XCTAssertEqual(SettingsStore.shared.meterCaptureMode, .point)
        unsetenv("TH_CAPTURE_MODE")
        // persisted default (untouched settings) is point — corporate-safe
        XCTAssertEqual(SettingsStore.shared.meterCaptureMode, .point)
    }

    func testMitmStatusIsSafeAndNeverRunsWithoutConsent() {
        let status = MitmCaptureManager.shared.status
        XCTAssertEqual(status["mode"] as? String, "mitm")
        XCTAssertNotNil(status["next_steps"])
        XCTAssertEqual(status["scope"] as? String,
                       "AI vendor API hosts only; all other TLS passes through undecrypted")
        // no .mitm consent in tests → proxy must not be running
        XCTAssertFalse(MitmCaptureManager.shared.isRunning)
    }

    // MARK: - Runtime auto-metering / routing

    func testRuntimeMeterPortsAreDeterministic() {
        XCTAssertEqual(OllamaRuntime().defaultMeterListenPort, 11435)
        XCTAssertEqual(VLLMRuntime().defaultMeterListenPort, 9311)
        XCTAssertEqual(SGLangRuntime().defaultMeterListenPort, 9312)
        XCTAssertEqual(LlamaCppRuntime().defaultMeterListenPort, 9313)
        XCTAssertEqual(MLXRuntime().defaultMeterListenPort, 9314)
    }

    func testRoutedURLMatchesBySchemeHostAndEffectivePort() {
        let meter = OpenAICompatibleMeter(
            vendor: "vllm", listenPort: 9311,
            targetBase: URL(string: "http://127.0.0.1:8000")!,
            store: nil, sourceKind: .selfManaged)
        MeterRegistry.meterProvider = { [meter] }
        defer { MeterRegistry.meterProvider = nil }
        XCTAssertEqual(
            MeterRegistry.routedURL(for: URL(string: "http://127.0.0.1:8000")!)?.absoluteString,
            "http://127.0.0.1:9311")
        // path on the endpoint must not affect identity
        XCTAssertNotNil(MeterRegistry.routedURL(for: URL(string: "http://127.0.0.1:8000/v1")!))
        // different port / scheme → no route
        XCTAssertNil(MeterRegistry.routedURL(for: URL(string: "http://127.0.0.1:8001")!))
        XCTAssertNil(MeterRegistry.routedURL(for: URL(string: "https://127.0.0.1:8000")!))
        // default-port equivalence (https = 443)
        XCTAssertTrue(MeterRegistry.sameEndpoint(
            URL(string: "https://api.openai.com")!,
            URL(string: "https://api.openai.com:443")!))
    }

    // MARK: - AccountKey / SHA256

    func testSHA256_knownVector() {
        let digest = SHA256.hash(Data("abc".utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testAccountKey_isStablePseudonymousAndBearerStripped() {
        let a = AccountKey.forCredential(vendor: "anthropic", credential: "sk-test-123")
        let b = AccountKey.forCredential(vendor: "claude", credential: "Bearer sk-test-123")
        XCTAssertEqual(a, b)  // vendor canonicalizes (anthropic→claude); scheme stripped
        XCTAssertTrue(a.hasPrefix("claude:"))
        XCTAssertFalse(a.contains("sk-test-123"))
        XCTAssertEqual(AccountKey.forCredential(vendor: "claude", credential: ""), "")
    }

    // MARK: - CostEngine

    func testCostEngine_planVendorsAreZeroMarginal_localComputeIsZero() {
        let tokens = TokenBreakdown(input: 1000, output: 500)
        for vendor in ["kimi", "glm", "minimax", "alibaba", "opencode", "ollama", "vllm"] {
            let d = CostEngine.decide(vendor: vendor, model: "whatever", tokens: tokens)
            XCTAssertEqual(d.cost, 0, vendor)
            XCTAssertEqual(d.source, .planFree, vendor)
        }
    }

    func testCostEngine_unknownModelIsUnknown_notZero() {
        let d = CostEngine.decide(vendor: "openai",
                                  model: "definitely-not-a-real-model-\(UUID().uuidString)",
                                  tokens: TokenBreakdown(input: 10, output: 10))
        XCTAssertEqual(d.source, .unknown)
        XCTAssertEqual(d.cost, 0)
    }
}
