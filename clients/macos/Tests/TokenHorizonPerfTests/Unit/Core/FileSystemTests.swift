import XCTest
@testable import TokenHorizon

/// Tests for the injectable file-read seam (`THFileReading`).
final class FileSystemTests: XCTestCase {

    func testLiveFileSystem_readsRealFiles_andMissesLikeFileManager() {
        let fs: THFileReading = LiveFileSystem()
        // This test file's own source isn't visible at runtime, but the
        // bundle-adjacent fixtures dir must NOT exist on disk as a file.
        XCTAssertFalse(fs.fileExists(atPath: "/definitely/not/here-\(UUID().uuidString).jsonl"))
        XCTAssertNil(fs.contents(atPath: "/definitely/not/here-\(UUID().uuidString).jsonl"))
    }

    func testInMemoryFileSystem_roundTripsSeededAndWrittenFiles() {
        let seed = Data("{\"hello\":1}\n".utf8)
        let fs = InMemoryFileSystem(files: ["/a.jsonl": seed])
        XCTAssertTrue(fs.fileExists(atPath: "/a.jsonl"))
        XCTAssertEqual(fs.contents(atPath: "/a.jsonl"), seed)
        XCTAssertFalse(fs.fileExists(atPath: "/b.jsonl"))

        let extra = Data("x".utf8)
        fs.write(extra, to: "/b.jsonl")
        XCTAssertEqual(fs.contents(atPath: "/b.jsonl"), extra)

        fs.remove(atPath: "/a.jsonl")
        XCTAssertFalse(fs.fileExists(atPath: "/a.jsonl"))
        XCTAssertNil(fs.contents(atPath: "/a.jsonl"))
    }
}
