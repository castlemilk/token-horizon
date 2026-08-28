import XCTest
@testable import TokenHorizon

final class ProcessTreeTests: XCTestCase {

    /// Tests the process tree builder used by the htop-style TREE view.
    /// The contract:
    ///   - `buildProcessTree([proc])` returns a DFS-ordered flat list
    ///   - depth=0 for roots (ppid 0 OR ppid not in the input set)
    ///   - children are grouped under parents
    ///   - cycles are guarded (a process can't be its own ancestor)

    func testTree_emptyInput_emptyOutput() {
        let result = SystemStats.buildProcessTree([])
        XCTAssertTrue(result.isEmpty)
    }

    func testTree_singleProcess_isRoot() {
        let p = makeProc(pid: 1, ppid: 0, name: "launchd")
        let result = SystemStats.buildProcessTree([p])
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].depth, 0)
        XCTAssertEqual(result[0].proc.pid, 1)
        XCTAssertFalse(result[0].hasChildren)
    }

    func testTree_parentChild_preservesHierarchy() {
        let parent = makeProc(pid: 100, ppid: 0, name: "parent")
        let child = makeProc(pid: 101, ppid: 100, name: "child")
        let grandchild = makeProc(pid: 102, ppid: 101, name: "grandchild")
        let result = SystemStats.buildProcessTree([parent, child, grandchild])
        XCTAssertEqual(result.count, 3)

        let parentIdx = result.firstIndex(where: { $0.proc.pid == 100 })!
        let childIdx = result.firstIndex(where: { $0.proc.pid == 101 })!
        let gcIdx = result.firstIndex(where: { $0.proc.pid == 102 })!

        XCTAssertEqual(result[parentIdx].depth, 0)
        XCTAssertEqual(result[childIdx].depth, 1)
        XCTAssertEqual(result[gcIdx].depth, 2)
        XCTAssertLessThan(parentIdx, childIdx, "parent must come before child")
        XCTAssertLessThan(childIdx, gcIdx, "child must come before grandchild")
        XCTAssertTrue(result[parentIdx].hasChildren)
        XCTAssertTrue(result[childIdx].hasChildren)
        XCTAssertFalse(result[gcIdx].hasChildren)
    }

    func testTree_multipleRoots_allAtDepthZero() {
        let p1 = makeProc(pid: 1, ppid: 0, name: "launchd")
        let p2 = makeProc(pid: 2, ppid: 0, name: "kthreadd")
        let p3 = makeProc(pid: 3, ppid: 0, name: "init")
        let result = SystemStats.buildProcessTree([p1, p2, p3])
        XCTAssertEqual(result.count, 3)
        for row in result { XCTAssertEqual(row.depth, 0) }
    }

    func testTree_orphanPpid_processedAsRoot() {
        // ppid=999 not in the set → treated as a root
        let p = makeProc(pid: 100, ppid: 999, name: "orphan")
        let result = SystemStats.buildProcessTree([p])
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].depth, 0)
    }

    func testTree_childrenSortedByCPU_descending() {
        // Children under pid 1 should be ordered by cpu descending
        let parent = makeProc(pid: 1, ppid: 0, name: "parent")
        let c1 = makeProc(pid: 10, ppid: 1, name: "low-cpu", cpu: 1.0)
        let c2 = makeProc(pid: 11, ppid: 1, name: "high-cpu", cpu: 90.0)
        let c3 = makeProc(pid: 12, ppid: 1, name: "mid-cpu", cpu: 30.0)
        let result = SystemStats.buildProcessTree([parent, c1, c2, c3])
        XCTAssertEqual(result.count, 4)
        let childPids = result[1...].map { $0.proc.pid }
        XCTAssertEqual(childPids, [11, 12, 10], "children must be sorted by CPU descending")
    }

    func testTree_cycleDoesNotInfiniteLoop() {
        // A → B → A: should terminate (visited guard)
        let a = makeProc(pid: 1, ppid: 2, name: "A")
        let b = makeProc(pid: 2, ppid: 1, name: "B")
        let result = SystemStats.buildProcessTree([a, b])
        XCTAssertLessThanOrEqual(result.count, 2, "cycle must terminate; got \(result.count) entries")
    }

    func testTree_realisticPsOutput_buildsCorrectTree() {
        // Simulate `ps -axo pid,ppid,comm` output
        let procs: [ProcSample] = [
            makeProc(pid: 1, ppid: 0, name: "launchd"),
            makeProc(pid: 100, ppid: 1, name: "WindowServer"),
            makeProc(pid: 200, ppid: 100, name: "Dock"),
            makeProc(pid: 201, ppid: 100, name: "Finder"),
            makeProc(pid: 300, ppid: 1, name: "loginwindow"),
            makeProc(pid: 400, ppid: 1, name: "sshd"),
            makeProc(pid: 401, ppid: 400, name: "sshd-session"),
            makeProc(pid: 402, ppid: 401, name: "zsh"),
        ]
        let result = SystemStats.buildProcessTree(procs)
        XCTAssertEqual(result.count, 8)

        let byPid = Dictionary(uniqueKeysWithValues: result.map { ($0.proc.pid, $0) })

        XCTAssertEqual(byPid[1]?.depth, 0)
        XCTAssertEqual(byPid[100]?.depth, 1)
        XCTAssertEqual(byPid[200]?.depth, 2)
        XCTAssertEqual(byPid[201]?.depth, 2)
        XCTAssertEqual(byPid[300]?.depth, 1)
        XCTAssertEqual(byPid[400]?.depth, 1)
        XCTAssertEqual(byPid[401]?.depth, 2)
        XCTAssertEqual(byPid[402]?.depth, 3)

        XCTAssertTrue(byPid[1]!.hasChildren)
        XCTAssertTrue(byPid[100]!.hasChildren)
        XCTAssertTrue(byPid[400]!.hasChildren)
        XCTAssertFalse(byPid[200]!.hasChildren)
        XCTAssertFalse(byPid[402]!.hasChildren)
    }

    // MARK: - Helpers

    private func makeProc(pid: Int32, ppid: Int32, name: String, cpu: Double = 0) -> ProcSample {
        ProcSample(
            pid: pid, ppid: ppid, name: name, command: "/" + name, user: "root", threads: 1,
            cpu: cpu, memMB: 10, diskReadMBps: 0, diskWriteMBps: 0,
            netInKBps: 0, netOutKBps: 0, startTime: Date()
        )
    }
}
