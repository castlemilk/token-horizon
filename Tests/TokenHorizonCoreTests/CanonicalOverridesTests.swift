import XCTest
@testable import TokenHorizonCore

/// canonical.json overrides: user config WINS over built-in tables, is
/// reloaded live, and drives every read-time fold — vendor CASE, spelling
/// cache, and the pricing join (which lives in canonical namespace, so one
/// config line maps any raw spelling onto its scraped rates).
final class CanonicalOverridesTests: XCTestCase {

    private var cfgPath: String!
    private var storePath: String!

    override func setUp() {
        cfgPath = NSTemporaryDirectory()
            .appendingPathComponent("th-canon-\(UUID().uuidString).json")
        storePath = NSTemporaryDirectory()
            .appendingPathComponent("th-canon-\(UUID().uuidString).db")
        Canonical.overrideFilePath = cfgPath
        Canonical.reloadOverrides()
    }

    override func tearDown() {
        Canonical.overrideFilePath = nil
        Canonical.reloadOverrides()
        try? FileManager.default.removeItem(atPath: cfgPath)
        try? FileManager.default.removeItem(atPath: storePath)
        try? FileManager.default.removeItem(atPath: storePath + "-wal")
        try? FileManager.default.removeItem(atPath: storePath + "-shm")
    }

    private func writeConfig(_ json: String) {
        FileManager.default.createFile(atPath: cfgPath, contents: Data(json.utf8))
        Canonical.reloadOverrides()
    }

    private func makeStore() throws -> SQLiteUsageStore {
        try SQLiteUsageStore(path: storePath)
    }

    // MARK: - Precedence

    func testVendorOverride_winsOverBuiltinTable() {
        writeConfig(#"{"vendors":{"acme-gw":"acme"},"models":{}}"#)
        XCTAssertEqual(Canonical.vendor("acme-gw"), "acme")
        XCTAssertEqual(Canonical.vendor("anthropic"), "claude",
                       "built-in table still applies where config is silent")
        XCTAssertEqual(Canonical.vendor("totally-unknown"), "totally-unknown",
                       "unknowns still pass through lowercased")
    }

    func testModelOverride_appliesPostTransformation() {
        writeConfig(#"{"models":{"k3-256k":"kimi-k3"}}"#)
        XCTAssertEqual(Canonical.model(vendor: "kimi", model: "k3-256k"), "kimi-k3")
        // Mechanical folds still run first: config keys are POST-transformation.
        XCTAssertEqual(Canonical.model(vendor: "kimi", model: "K3-256K"), "kimi-k3",
                       "lowercasing happens before the override lookup")
    }

    /// Regression: the "-free" branch used to RETURN EARLY, skipping the
    /// override entirely for free-tier spellings (muse-spark live bug).
    func testModelOverride_appliesAfterFreeSuffixBranch() {
        writeConfig(#"{"models":{"muse-spark-1.2-free":"muse-spark-1.3-contributor-free"}}"#)
        XCTAssertEqual(Canonical.model(vendor: "opencode-go",
                                       model: "muse-spark-1.3-contributor-free"),
                       "muse-spark-1.3-contributor-free")
    }

    // MARK: - Pricing join lives in canonical namespace

    /// THE centralization property: usage stored RAW (kimi/k3-256k) joins
    /// pricing stored CANONICAL (kimi/kimi-k3) purely via canonical.json.
    func testPricingJoin_foldsRawUsageOntoCanonicalRatesViaConfig() throws {
        writeConfig(#"{"models":{"k3-256k":"kimi-k3"}}"#)
        let store = try makeStore()
        try store.upsertPricingForTesting(raw: "kimi/kimi-k3", inputPerM: 3.0,
                                          outputPerM: 15.0, cacheReadPerM: 0.30)
        try store.insertMetered([UsageEvent(
            timestamp: Date(), machineID: "m1", source: .external,
            vendor: "kimi", model: "k3-256k",
            tokens: TokenBreakdown(input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000),
            cost: 0, costSource: .planFree, attestation: .measured)])
        let rows = try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                                   filter: UsageFilter(), cursor: nil, limit: 10).events
        XCTAssertEqual(rows.first?.costEquivalent ?? 0, 18.30, accuracy: 0.001,
                       "raw kimi/k3-256k must value at canonical kimi/kimi-k3 rates")
    }

    func testPricingJoin_foldsVendorSpellingViaConfig() throws {
        writeConfig(#"{"vendors":{"acme-gw":"acme"}}"#)
        let store = try makeStore()
        try store.upsertPricingForTesting(raw: "acme/k3", inputPerM: 1.0,
                                          outputPerM: 2.0, cacheReadPerM: nil)
        try store.insertMetered([UsageEvent(
            timestamp: Date(), machineID: "m1", source: .external,
            vendor: "acme-gw", model: "k3",
            tokens: TokenBreakdown(input: 1_000_000, output: 1_000_000),
            cost: 0, costSource: .computed, attestation: .measured)])
        let rows = try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                                   filter: UsageFilter(), cursor: nil, limit: 10).events
        XCTAssertEqual(rows.first?.costEquivalent ?? 0, 3.0, accuracy: 0.001)
    }

    // MARK: - Override edits propagate through the caches

    func testEditedMapping_propagatesToSpellingCacheViaReplace() throws {
        writeConfig(#"{"models":{"k3-256k":"kimi-k3"}}"#)
        let store = try makeStore()
        try store.insertMetered([UsageEvent(
            timestamp: Date(), machineID: "m1", source: .external,
            vendor: "kimi", model: "k3-256k",
            tokens: TokenBreakdown(input: 1, output: 1),
            cost: 0, attestation: .measured)])
        _ = try store.query(from: .distantPast, to: Date().addingTimeInterval(60),
                            filter: UsageFilter(), cursor: nil, limit: 10)
        // User edits the mapping: k3-256k is its own model, not an alias.
        writeConfig(#"{"models":{}}"#)
        // Force the store's 30s cache TTL open via a fresh store instance.
        let fresh = try SQLiteUsageStore(path: storePath)
        let aggs = try fresh.aggregate(from: .distantPast, to: Date().addingTimeInterval(60),
                                       groupBy: .model, filter: UsageFilter())
        XCTAssertTrue(aggs.contains { $0.key == "kimi/k3-256k" },
                      "REPLACE refresh must overwrite the stale folded spelling")
        XCTAssertFalse(aggs.contains { $0.key.hasSuffix("/kimi-k3") })
    }
}
