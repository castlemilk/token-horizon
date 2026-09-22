import XCTest
import SQLite3
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

    /// Input/output/cache/request splits and per-project (cwd) rollups are
    /// exact — these feed the leaderboard's Input/Output/Requests columns.
    func testAdditive_tokenClassSplitsAndProjects() {
        let nowTs = Double(nowHour)
        write("s1.jsonl", """
        {"cwd":"/Users/dev/alpha","message":{"id":"m1","model":"claude-sonnet","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":200}},"timestamp":\(nowTs)}
        {"cwd":"/Users/dev/beta","message":{"id":"m2","model":"claude-sonnet","usage":{"input_tokens":5,"output_tokens":5}},"timestamp":\(nowTs)}

        """)
        let e = engine()
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        let r = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
        XCTAssertEqual(r.allTokens, 370)
        XCTAssertEqual(r.inputAll, 105)
        XCTAssertEqual(r.outputAll, 55)
        XCTAssertEqual(r.cacheWrite, 10)
        XCTAssertEqual(r.cacheRead, 200)
        XCTAssertEqual(r.requestsAll, 2)
        XCTAssertEqual(r.inputToday, 105)
        XCTAssertEqual(r.outputToday, 55)
        XCTAssertEqual(r.requestsToday, 2)
        XCTAssertEqual(r.projects["/Users/dev/alpha"]?.tokens, 360)
        XCTAssertEqual(r.projects["/Users/dev/alpha"]?.input, 100)
        XCTAssertEqual(r.projects["/Users/dev/beta"]?.tokens, 10)
        let model = r.perModel["claude-sonnet"]
        XCTAssertEqual(model?.inputAll, 105)
        XCTAssertEqual(model?.outputAll, 55)
        XCTAssertEqual(model?.requestsAll, 2)
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

    // MARK: - Devin transcript docs

    private func iso(_ epoch: Int) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date(timeIntervalSince1970: TimeInterval(epoch)))
    }

    private func devinDoc(steps: [String]) -> String {
        """
        {"schema_version":1,"session_id":"sess-1",
         "agent":{"name":"devin","version":"3000.0.0","model_name":"SWE-2 High"},
         "steps":[\(steps.joined(separator: ","))],
         "final_metrics":{}}
        """
    }

    private func devinStep(_ id: Int, prompt: Int, completion: Int, cached: Int,
                           source: String = "agent", model: String? = "SWE-2 High") -> String {
        let modelField = model.map { ",\"model_name\":\"\($0)\"" } ?? ""
        return """
        {"step_id":\(id),"timestamp":"\(iso(nowHour))","source":"\(source)"\(modelField),"metrics":{"prompt_tokens":\(prompt),"completion_tokens":\(completion),"cached_tokens":\(cached)}}
        """
    }

    /// Agent steps count; system/user/metric-less steps don't. `prompt_tokens`
    /// includes the cached slice, so input = prompt - cached, cacheRead =
    /// cached, total = prompt + completion.
    func testDevin_parsesStepsWithCacheSplit() {
        write("sess-1.json", devinDoc(steps: [
            "{\"step_id\":1,\"timestamp\":\"\(iso(nowHour))\",\"source\":\"system\"}",
            devinStep(2, prompt: 1000, completion: 100, cached: 400),
            "{\"step_id\":3,\"timestamp\":\"\(iso(nowHour))\",\"source\":\"user\"}",
            devinStep(4, prompt: 2000, completion: 200, cached: 1500),
        ]))
        let e = engine()
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        let r = e.scanDevin(dirs: [root], state: &state)
        // step2: 600 in + 100 out + 400 cr = 1100; step4: 500 + 200 + 1500 = 2200
        XCTAssertEqual(r.allTokens, 3300)
        XCTAssertEqual(r.todayTokens, 3300)
        XCTAssertEqual(r.cacheRead, 1900)
        XCTAssertEqual(r.inputAll, 1100)
        XCTAssertEqual(r.outputAll, 300)
        XCTAssertEqual(r.requestsAll, 2)
        XCTAssertEqual(r.perModel["SWE-2 High"]?.all, 3300)
        XCTAssertEqual(r.perModel["SWE-2 High"]?.requestsAll, 2)
        XCTAssertTrue(r.trackedAny)
    }

    /// Whole-doc files re-parse only on growth; the second scan sees the same
    /// steps but watermarks keep totals stable, and an appended step counts
    /// only its own delta.
    func testDevin_rescanAppendsOnlyNewSteps() {
        write("sess-1.json", devinDoc(steps: [devinStep(2, prompt: 1000, completion: 100, cached: 400)]))
        let e = engine()
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        XCTAssertEqual(e.scanDevin(dirs: [root], state: &state).allTokens, 1100)
        // No change → identical totals (memo path).
        XCTAssertEqual(e.scanDevin(dirs: [root], state: &state).allTokens, 1100)
        // Append a step → file grows → only the new step's tokens land.
        write("sess-1.json", devinDoc(steps: [
            devinStep(2, prompt: 1000, completion: 100, cached: 400),
            devinStep(5, prompt: 500, completion: 50, cached: 100),
        ]))
        XCTAssertEqual(e.scanDevin(dirs: [root], state: &state).allTokens, 1650)
    }

    /// A step re-emitted with larger cumulative metrics counts only growth.
    func testDevin_stepMetricGrowthCountsDelta() {
        write("sess-1.json", devinDoc(steps: [devinStep(2, prompt: 1000, completion: 100, cached: 400)]))
        let e = engine()
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        XCTAssertEqual(e.scanDevin(dirs: [root], state: &state).allTokens, 1100)
        write("sess-1.json", devinDoc(steps: [devinStep(2, prompt: 1200, completion: 150, cached: 400)]))
        XCTAssertEqual(e.scanDevin(dirs: [root], state: &state).allTokens, 1350)
    }

    /// A shrunk file (rotated/recreated transcript) resets state and reports
    /// exactly the current content.
    func testDevin_truncationResets() {
        write("sess-1.json", devinDoc(steps: [
            devinStep(2, prompt: 10000, completion: 100, cached: 400),
            devinStep(3, prompt: 20000, completion: 200, cached: 500),
        ]))
        let e = engine()
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        XCTAssertEqual(e.scanDevin(dirs: [root], state: &state).allTokens, 30300)
        // Same path rewritten smaller → state resets → current content only.
        write("sess-1.json", devinDoc(steps: [devinStep(1, prompt: 30, completion: 10, cached: 0)]))
        XCTAssertEqual(e.scanDevin(dirs: [root], state: &state).allTokens, 40)
    }

    /// A torn mid-write JSON doc fails parsing but keeps the last-good state
    /// (transient writes must not zero live totals); the completed rewrite
    /// then counts exactly the new content.
    func testDevin_partialJsonKeepsLastGood() {
        let path = root + "/sess-1.json"
        write("sess-1.json", devinDoc(steps: [devinStep(2, prompt: 1000, completion: 100, cached: 400)]))
        let e = engine()
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        XCTAssertEqual(e.scanDevin(dirs: [root], state: &state).allTokens, 1100)
        // Simulate a torn write: truncate mid-doc so JSONSerialization fails.
        let data = FileManager.default.contents(atPath: path)!
        try! data.prefix(data.count - 40).write(to: URL(fileURLWithPath: path))
        XCTAssertEqual(e.scanDevin(dirs: [root], state: &state).allTokens, 1100)
        // Rewrite valid → counts fresh.
        write("sess-1.json", devinDoc(steps: [devinStep(2, prompt: 1000, completion: 100, cached: 400)]))
        XCTAssertEqual(e.scanDevin(dirs: [root], state: &state).allTokens, 1100)
    }

    /// sessions.db id → working_directory drives per-project rollups.
    func testDevin_projectMapFromSessionsDB() {
        let dbPath = root + "/sessions.db"
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil), SQLITE_OK)
        sqlite3_exec(db, "CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT)", nil, nil, nil)
        sqlite3_exec(db, "INSERT INTO sessions VALUES ('sess-1','/Users/dev/alpha')", nil, nil, nil)
        sqlite3_exec(db, "INSERT INTO sessions VALUES ('sess-2','/Users/dev/beta')", nil, nil, nil)
        sqlite3_close(db)
        let e = engine()
        let map = e.devinProjectDirs(base: dbPath)
        XCTAssertEqual(map["sess-1"], "/Users/dev/alpha")
        XCTAssertEqual(map["sess-2"], "/Users/dev/beta")
    }
}
