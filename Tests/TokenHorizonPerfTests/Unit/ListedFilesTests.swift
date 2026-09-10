import XCTest
@testable import TokenHorizon
// swiftlint:disable force_try
// Test files are exempt from force-try enforcement (a try! that fails fails
// the test loudly, which is the desired behavior). Production code keeps the
// default error-level enforcement.

/// Hermetic tests for `UsageEngine.listedFiles` — the mtime-pruned recursive
/// listing cache behind every JSONL scan. Uses throwaway temp dirs (no
/// dependency on the developer's real $HOME).
final class ListedFilesTests: XCTestCase {

    private var root: String = ""

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-listedfiles-\(UUID().uuidString)").path
        try! FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: root)
        super.tearDown()
    }

    private func write(_ rel: String, _ text: String = "{}\n") {
        let abs = root + "/" + rel
        try! FileManager.default.createDirectory(
            atPath: (abs as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: abs, contents: Data(text.utf8))
    }

    private func engine() -> UsageEngine { UsageEngine() }

    func testListsNestedJsonlAndSkipsOthers() {
        write("a.jsonl")
        write("sub/b.jsonl")
        write("sub/deep/c.jsonl")
        write("note.txt")
        write("sub/chunks/d.jsonl")
        write("sub/transcript_full.jsonl")
        // Non-matching suffix for the default call.
        write("sub/e.json")

        let got = Set(engine().listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl"))
        XCTAssertEqual(got, ["a.jsonl", "sub/b.jsonl", "sub/deep/c.jsonl"])
    }

    func testMissingDirReturnsEmpty() {
        XCTAssertEqual(engine().listedFiles(fm: .default, root: root + "/nope", rel: "", suffix: ".jsonl"), [])
    }

    func testNewNestedFileDetectedAfterCache() {
        write("sub/a.jsonl")
        let eng = engine()
        let clock = ManualClock(Date())
        XCTAssertEqual(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl", clock: clock), ["sub/a.jsonl"])
        // Within the TTL the cached listing is served even though nothing
        // changed — zero syscalls by design.
        XCTAssertEqual(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl", clock: clock), ["sub/a.jsonl"])
        // Past the TTL a nested add is picked up (subdir mtimes are no
        // excuse: the refresh walk always descends).
        clock.advance(by: UsageEngine.listingTTL + 1)
        write("sub/nested/b.jsonl")
        XCTAssertEqual(
            Set(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl", clock: clock)),
            ["sub/a.jsonl", "sub/nested/b.jsonl"])
    }

    func testRemovedFileDisappearsAfterCache() {
        write("a.jsonl")
        write("b.jsonl")
        let eng = engine()
        let clock = ManualClock(Date())
        XCTAssertEqual(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl", clock: clock).count, 2)
        try! FileManager.default.removeItem(atPath: root + "/a.jsonl")
        clock.advance(by: UsageEngine.listingTTL + 1)
        XCTAssertEqual(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl", clock: clock), ["b.jsonl"])
    }

    func testTTLBoundsStaleness() {
        // Documents the freshness contract: discovery of new files lags at
        // most listingTTL; growth of known files is unaffected (per-file
        // size checks run every tick regardless).
        write("a.jsonl")
        let eng = engine()
        let clock = ManualClock(Date())
        XCTAssertEqual(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl", clock: clock), ["a.jsonl"])
        write("b.jsonl")
        XCTAssertEqual(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl", clock: clock), ["a.jsonl"])
        clock.advance(by: UsageEngine.listingTTL - 1)
        XCTAssertEqual(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl", clock: clock), ["a.jsonl"])
        clock.advance(by: 2)
        XCTAssertEqual(
            Set(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl", clock: clock)),
            ["a.jsonl", "b.jsonl"])
    }

    func testSuffixVariantsAreCachedIndependently() {
        write("a.jsonl")
        write("a.wire.jsonl")
        let eng = engine()
        XCTAssertEqual(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl").count, 2)
        XCTAssertEqual(eng.listedFiles(fm: .default, root: root, rel: "", suffix: "wire.jsonl"), ["a.wire.jsonl"])
    }

    func testExcludedDirsArePrunedAtAnyDepth() {
        write("keep/a.jsonl")
        write("keep/scratch/b.jsonl")
        write("scratch/c.jsonl")
        write("keep/deep/scratch/d.jsonl")
        let eng = engine()
        XCTAssertEqual(
            Set(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl",
                                excluding: ["scratch"])),
            ["keep/a.jsonl"])
    }

    func testNestedChunksDirIsPrunedButTopLevelIsNot() {
        // Mirrors the historical `contains("/chunks/")` file exclusion: nested
        // chunks/ content was never counted, so descent is pure waste —
        // except a top-level `chunks/` dir, whose files do NOT match the check.
        write("chunks/top.jsonl")
        write("sub/chunks/nested.jsonl")
        write("sub/real.jsonl")
        let eng = engine()
        XCTAssertEqual(
            Set(eng.listedFiles(fm: .default, root: root, rel: "", suffix: ".jsonl")),
            ["chunks/top.jsonl", "sub/real.jsonl"])
    }

    func testAgyExclusionsMatchLayoutEvidence() {
        // Zero .jsonl outside logs/ across the real tree; guard the contract.
        XCTAssertEqual(UsageEngine.excludedDirNames(for: "agy"),
                       ["scratch", ".user_uploaded", ".tempmediaStorage"])
        XCTAssertTrue(UsageEngine.excludedDirNames(for: "claude").isEmpty)
    }
}
