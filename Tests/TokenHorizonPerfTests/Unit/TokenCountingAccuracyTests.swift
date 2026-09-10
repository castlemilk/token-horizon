import XCTest
@testable import TokenHorizon
// swiftlint:disable force_try
// Test files are exempt from force-try enforcement (a try! that fails fails
// the test loudly, which is the desired behavior). Production code keeps the
// default error-level enforcement.

/// End-to-end token-counting accuracy: realistic multi-line session files
/// driven through the real incremental scanners (temp dirs + local state —
/// no HOME, no db, no network). Totals are hand-computed; every assertion is
/// exact. This is the executable form of the ground-truth protocol:
/// per-session lasts must aggregate exactly, repeats must not double count.
///
/// NOTE on file content: Swift multi-line literals do NOT include a trailing
/// newline, so every fixture below ends with an explicit blank line before
/// the closing delimiter. That trailing newline is load-bearing: the
/// incremental readers only consume through the last `\n` (partial tails
/// survive to the next poll), matching how real JSONL writers terminate
/// every line. See testUnterminatedTailIsDeferred for the pinned behavior.
final class TokenCountingAccuracyTests: XCTestCase {

    private var root: String = ""
    private let nowHour = Int(Date().timeIntervalSince1970 / 3600) * 3600

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-accuracy-\(UUID().uuidString)").path
        try! FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: root)
        super.tearDown()
    }

    private func write(_ rel: String, _ text: String) {
        let abs = root + "/" + rel
        try! FileManager.default.createDirectory(
            atPath: (abs as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try! text.write(toFile: abs, atomically: true, encoding: .utf8)
    }

    private func engine() -> UsageEngine {
        let e = UsageEngine()
        e.resetState()
        return e
    }

    // MARK: - Additive (claude-shaped) sessions

    /// Streaming re-emit (identical repeat) counts once; monotonic growth
    /// counts only the delta; separate files aggregate; old buckets stay out
    /// of "today".
    func testAdditive_exactTotalsAcrossFiles() {
        let nowTs = Double(nowHour)
        let oldTs = Double(nowHour - 30 * 86400)
        write("s1.jsonl", """
        {"message":{"id":"m1","model":"claude-sonnet","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":200}},"timestamp":\(nowTs)}
        {"message":{"id":"m1","model":"claude-sonnet","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":200}},"timestamp":\(nowTs)}
        {"message":{"id":"m1","model":"claude-sonnet","usage":{"input_tokens":100,"output_tokens":80,"cache_creation_input_tokens":10,"cache_read_input_tokens":200}},"timestamp":\(nowTs)}
        {"message":{"id":"m2","model":"claude-sonnet","usage":{"input_tokens":5,"output_tokens":5}},"timestamp":\(nowTs)}

        """)
        write("s2.jsonl", """
        {"message":{"id":"o1","model":"claude-sonnet","usage":{"input_tokens":1000,"output_tokens":0}},"timestamp":\(oldTs)}

        """)

        let e = engine()
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        let r = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
        // s1: 360 + 0 (dup) + 30 (output growth) + 10 = 400; s2: 1000.
        XCTAssertEqual(r.allTokens, 1400)
        XCTAssertEqual(r.todayTokens, 400)
        XCTAssertEqual(r.perModel["claude-sonnet"]?.all, 1400)
        XCTAssertEqual(r.perModel["claude-sonnet"]?.today, 400)
        XCTAssertTrue(r.trackedAny)
    }

    func testAdditive_rescanIsIdempotent() {
        write("s.jsonl", """
        {"message":{"id":"m1","usage":{"input_tokens":7,"output_tokens":8}},"timestamp":\(Double(nowHour))}

        """)
        let e = engine()
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        let first = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
        let second = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
        XCTAssertEqual(first.allTokens, 15)
        XCTAssertEqual(second.allTokens, 15)
        XCTAssertEqual(second.todayTokens, 15)
    }

    func testAdditive_truncationRecountsCurrentContentOnly() {
        write("s.jsonl", """
        {"message":{"id":"m1","usage":{"input_tokens":100,"output_tokens":100}},"timestamp":\(Double(nowHour))}

        """)
        let e = engine()
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        XCTAssertEqual(e.scanAdditive(dirs: [root], state: &state, prefix: "test").allTokens, 200)
        // Truncate to a smaller file: state resets (per the watermark
        // protocol) and totals equal a fresh parse — no ghost of old bytes.
        write("s.jsonl", """
        {"message":{"id":"m9","usage":{"input_tokens":30,"output_tokens":10}},"timestamp":\(Double(nowHour))}

        """)
        XCTAssertEqual(e.scanAdditive(dirs: [root], state: &state, prefix: "test").allTokens, 40)
    }

    func testAdditive_costOnlyLines() {
        write("s.jsonl", """
        {"message":{"id":"m1","usage":{"input_tokens":0,"output_tokens":0}},"costUSD":1.5,"timestamp":\(Double(nowHour))}

        """)
        let e = engine()
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        let r = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
        XCTAssertEqual(r.allTokens, 0)
        XCTAssertEqual(r.allCost, 1.5, accuracy: 1e-9)
    }

    func testUnterminatedTailIsDeferred() {
        // The incremental readers consume only through the last `\n`: a
        // final line without a terminator is an in-flight partial write and
        // must survive to the next poll — never counted, never lost.
        write("s.jsonl", "{\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":7,\"output_tokens\":8}},\"timestamp\":\(Double(nowHour))}")
        let e = engine()
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        XCTAssertEqual(e.scanAdditive(dirs: [root], state: &state, prefix: "test").allTokens, 0)
        // Completing the line (appending the terminator) counts it exactly once.
        let fh = FileHandle(forWritingAtPath: root + "/s.jsonl")
        fh?.seekToEndOfFile()
        fh?.write(Data("\n".utf8))
        try? fh?.close()
        XCTAssertEqual(e.scanAdditive(dirs: [root], state: &state, prefix: "test").allTokens, 15)
    }

    // MARK: - Codex sessions

    /// Per-session ALL must equal the last total (not the sum of lines);
    /// stale regressions are ignored; multi-file sums aggregate.
    func testCodex_exactTotals() {
        let now = ISO8601DateFormatter().string(from: Date())
        let old = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-30 * 86400))
        func totals(_ i: Int, _ o: Int) -> String {
            #"{"total_token_usage":{"input_tokens":\#(i),"output_tokens":\#(o),"cached_input_tokens":0,"reasoning_output_tokens":0}}"#
        }
        write("sess1.jsonl", """
        {"timestamp":"\(now)","payload":{"model":"gpt-5","info":\(totals(1000, 500))}}
        {"timestamp":"\(now)","payload":{"model":"gpt-5","info":\(totals(1000, 600))}}
        {"timestamp":"\(now)","payload":{"model":"gpt-5","info":\(totals(1000, 600))}}
        {"timestamp":"\(now)","payload":{"model":"gpt-5","info":\(totals(990, 590))}}

        """)
        write("sess-old.jsonl", """
        {"timestamp":"\(old)","payload":{"model":"gpt-5","info":\(totals(2000, 0))}}

        """)
        let e = engine()
        // sess1: 1500 + 100 + 0 (dup) + 0 (stale 99%) = 1600; old: 2000.
        let r = e.scanCodex(dirs: [root])
        XCTAssertEqual(r.all, 3600)
        XCTAssertEqual(r.today, 1600)
        // Rescan consumes nothing new.
        let r2 = e.scanCodex(dirs: [root])
        XCTAssertEqual(r2.all, 3600)
        XCTAssertEqual(r2.today, 1600)
    }
}
