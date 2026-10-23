import XCTest
@testable import TokenHorizon

/// The Hugging Face cache as the installed/download store: what the engines
/// act on. The tests build the hub layout by hand in a temporary directory —
/// blobs, partial blobs, snapshots — and assert what the store reports.
final class HFModelStoreTests: XCTestCase {

    private var root: URL!
    private var previousHome: String?

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("hf-store-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        previousHome = ProcessInfo.processInfo.environment["HF_HOME"]
        setenv("HF_HOME", root.path, 1)
    }

    override func tearDownWithError() throws {
        if let previousHome { setenv("HF_HOME", previousHome, 1) } else { unsetenv("HF_HOME") }
        try? FileManager.default.removeItem(at: root)
    }

    private func install(_ repoId: String, file: String = "model.gguf") throws {
        let dir = HFModelStore.repoDir(repoId).appendingPathComponent("snapshots/abc123")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("weights".utf8).write(to: dir.appendingPathComponent(file))
    }

    private func partial(_ repoId: String, downloadedGB: Double) throws {
        let blobs = HFModelStore.repoDir(repoId).appendingPathComponent("blobs")
        try FileManager.default.createDirectory(at: blobs, withIntermediateDirectories: true)
        // Write the byte count without allocating it.
        let file = blobs.appendingPathComponent("sha.incomplete")
        try Data().write(to: file)
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: UInt64(downloadedGB * 1_000_000_000))
        try handle.close()
    }

    func testInstalled_requiresACompleteSnapshot() throws {
        let repo = "Qwen/Qwen3-32B-GGUF"
        XCTAssertFalse(HFModelStore.isInstalled(repo), "nothing on disk is not installed")
        try partial(repo, downloadedGB: 5)          // a partial download is not installed
        XCTAssertFalse(HFModelStore.isInstalled(repo), "a partial download is not installed")
        try install(repo)                            // a complete snapshot is
        XCTAssertTrue(HFModelStore.isInstalled(repo))
    }

    func testProgress_reportsPartialBytesAgainstTheExpectedSize() throws {
        let repo = "Qwen/Qwen3-32B-GGUF"
        try partial(repo, downloadedGB: 9)
        let p = try XCTUnwrap(HFModelStore.progress(repo, expectedGB: 19.8))
        XCTAssertEqual(p.downloadedGB, 9.0, accuracy: 0.05)
        XCTAssertEqual(p.totalGB, 19.8)
        XCTAssertEqual(p.fraction, 9.0 / 19.8, accuracy: 0.01)
    }

    func testProgress_nilWhenNothingIsDownloading() throws {
        XCTAssertNil(HFModelStore.progress("Qwen/Qwen3-32B-GGUF", expectedGB: 19.8))
    }

    func testCacheDirName_followsTheHubConvention() {
        XCTAssertEqual(HFModelStore.cacheDirName("Qwen/Qwen3-32B-GGUF"), "models--Qwen--Qwen3-32B-GGUF")
    }
}
