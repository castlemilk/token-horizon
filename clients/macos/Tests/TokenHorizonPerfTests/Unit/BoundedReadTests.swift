import XCTest
@testable import TokenHorizon
// swiftlint:disable force_try

/// The per-poll read cap (`UsageEngine.maxReadBytes`) must preserve the
/// incremental-reader invariants exactly: offsets advance only by consumed
/// byte counts, partial tails survive to the next poll, and totals stay
/// exact across however many polls a large append takes. Regression context:
/// unbounded `readDataToEndOfFile` let one busy transcript turn a single
/// collect into a multi-second lock-held stall.
final class BoundedReadTests: XCTestCase {

    private var root: String = ""
    private let nowHour = Int(Date().timeIntervalSince1970 / 3600) * 3600

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-bounded-\(UUID().uuidString)").path
        try! FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: root)
        super.tearDown()
    }

    private func engine(maxReadBytes: Int) -> UsageEngine {
        let e = UsageEngine()
        e.resetState()
        e.maxReadBytes = maxReadBytes
        return e
    }

    /// One additive-shaped line with a unique message id and known tokens.
    private func additiveLine(id: Int, input: Int, output: Int) -> String {
        "{\"message\":{\"id\":\"m\(id)\",\"model\":\"claude-sonnet\",\"usage\":{\"input_tokens\":\(input),\"output_tokens\":\(output)}},\"timestamp\":\(Double(nowHour))}\n"
    }

    /// A giant append (far beyond the cap) is consumed across repeated
    /// polls with EXACT totals — no loss, no double counting.
    func testBoundedRead_consumesGiantAppendExactlyAcrossPolls() {
        let count = 300
        var body = ""
        for i in 0..<count { body += additiveLine(id: i, input: 100, output: 10) }
        try! body.write(toFile: root + "/s1.jsonl", atomically: true, encoding: .utf8)

        let e = engine(maxReadBytes: 256) // spans only ~2 lines per poll
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        var result = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
        var polls = 1
        while result.allTokens < count * 110, polls < 1_000 {
            result = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
            polls += 1
        }
        XCTAssertEqual(result.allTokens, count * 110, "exact total after \(polls) capped polls")
        XCTAssertEqual(result.todayTokens, count * 110)
        XCTAssertEqual(result.perModel["claude-sonnet"]?.all, count * 110)
        // The offset must sit exactly at EOF once fully consumed.
        let key = state.keys.first!
        let size = try! FileManager.default.attributesOfItem(atPath: root + "/s1.jsonl")[.size] as! Int
        XCTAssertEqual(Int(state[key]!.offset), size, "offset consumed every byte")
        XCTAssertGreaterThan(polls, 1, "the cap must actually have split the read")
    }

    /// A partial tail (no trailing newline) is still deferred under the cap —
    /// the pinned incremental behavior holds when a poll ends mid-file.
    /// The cap stays larger than one line (production is 16MB — no real line
    /// approaches it), so only the tail, never a body line, is incomplete.
    func testBoundedRead_partialTailSurvives() {
        var body = ""
        for i in 0..<10 { body += additiveLine(id: i, input: 100, output: 10) }
        try! body.write(toFile: root + "/s1.jsonl", atomically: true, encoding: .utf8)
        // Append a tail WITHOUT a trailing newline (live-writer shape).
        let tail = "{\"message\":{\"id\":\"tail-1\",\"model\":\"claude-sonnet\",\"usage\":{\"input_tokens\":500,\"output_tokens\":"
        let fh = FileHandle(forWritingAtPath: root + "/s1.jsonl")!
        fh.seekToEndOfFile()
        fh.write(Data(tail.utf8))
        try! fh.close()

        let e = engine(maxReadBytes: 512) // ~4 lines per poll: multi-poll growth
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        var r = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
        let afterFirstPoll = r.allTokens
        XCTAssertGreaterThan(afterFirstPoll, 0)
        XCTAssertLessThan(afterFirstPoll, 1100, "the cap split the read across polls")
        var polls = 1
        while r.allTokens < 1100, polls < 100 {
            r = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
            polls += 1
        }
        XCTAssertEqual(r.allTokens, 1100, "10 body lines consumed exactly across \(polls) polls")

        // The partial tail must not count and must not be lost.
        r = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
        XCTAssertEqual(r.allTokens, 1100, "partial tail deferred, not counted")

        // Complete the line; the next poll consumes exactly the delta.
        let fh2 = FileHandle(forWritingAtPath: root + "/s1.jsonl")!
        fh2.seekToEndOfFile()
        fh2.write(Data("50}},\"timestamp\":\(Double(nowHour))}\n".utf8))
        try! fh2.close()
        r = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
        XCTAssertEqual(r.allTokens, 1650, "completed tail counted exactly once (1100 + 500 + 50)")
    }

    /// A single line larger than the whole window must not wedge the reader
    /// at one offset forever: it is skipped whole and flagged suspect, and
    /// later normal lines still count.
    func testBoundedRead_oversizeLineSkippedNotSticky() {
        let blob = String(repeating: "x", count: 4_096)
        let normal = additiveLine(id: 9, input: 70, output: 7)
        try! (blob + "\n" + normal).write(toFile: root + "/s1.jsonl", atomically: true, encoding: .utf8)

        let e = engine(maxReadBytes: 256)
        var state: [String: UsageEngine.AdditiveFileState] = [:]
        var r = UsageEngine.SourceResult()
        for _ in 0..<100 {
            r = e.scanAdditive(dirs: [root], state: &state, prefix: "test")
            if r.allTokens == 77 { break }
        }
        XCTAssertEqual(r.allTokens, 77, "the line after the oversize blob still counted")
        XCTAssertEqual(r.allTokens, 77)
        let st = state.values.first
        XCTAssertNotNil(st)
        XCTAssertGreaterThanOrEqual(st!.suspectLines, 1, "oversize skip flagged as suspect")
        let size = try! FileManager.default.attributesOfItem(atPath: root + "/s1.jsonl")[.size] as! Int
        XCTAssertEqual(Int(st!.offset), size, "reader reached EOF — not stuck at the blob")
    }
}
