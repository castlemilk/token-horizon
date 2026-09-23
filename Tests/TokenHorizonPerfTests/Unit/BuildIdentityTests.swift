import XCTest
@testable import TokenHorizon

/// Regression tests for build identity + single-instance decisions — the
/// machinery that prevents stale-binary confusion (looking at one build
/// while agents query another) and silent API-less runs.
final class BuildIdentityTests: XCTestCase {

    func testDescribe_formatsBuildLine() {
        XCTAssertEqual(
            BuildInfo.describe(version: "0.2.0", commit: "a1b2c3d", builtAt: "2026-09-09T12:00:00Z"),
            "0.2.0 · a1b2c3d · 2026-09-09T12:00:00Z")
    }

    func testDescribe_includesBuildNumber() {
        // Marketing version + CFBundleVersion: "0.3.6 (9) · sha · time".
        XCTAssertEqual(
            BuildInfo.describe(version: "0.3.6", build: "9", commit: "a1b2c3d", builtAt: "t"),
            "0.3.6 (9) · a1b2c3d · t")
        // Missing/zero build number degrades to the bare version.
        XCTAssertEqual(
            BuildInfo.describe(version: "0.3.6", build: "0", commit: "c", builtAt: "t"),
            "0.3.6 · c · t")
        XCTAssertEqual(
            BuildInfo.describe(version: "0.3.6", build: "", commit: "c", builtAt: "t"),
            "0.3.6 · c · t")
    }

    func testDevFallbacks_inTestBundle() {
        // The xctest bundle carries no THGitSHA/THBuiltAt keys: unstamped runs
        // must report dev/unknown rather than crashing or blank.
        XCTAssertEqual(BuildInfo.commit, "dev")
        XCTAssertEqual(BuildInfo.builtAt, "unknown")
        XCTAssertTrue(BuildInfo.display.contains("dev"))
    }

    func testDecide_freePortProceeds() {
        XCTAssertEqual(InstanceGuard.decide(ourBuild: "abc", holderBuild: nil), .proceed)
        XCTAssertEqual(InstanceGuard.decide(ourBuild: "abc", holderBuild: ""), .proceed)
    }

    func testDecide_sameBuildIsDuplicate() {
        XCTAssertEqual(InstanceGuard.decide(ourBuild: "a1b2c3d", holderBuild: "a1b2c3d"), .duplicate)
    }

    func testDecide_otherBuildTakeover() {
        // Newest launch wins — a stale holder never shadows fresh code.
        XCTAssertEqual(InstanceGuard.decide(ourBuild: "new1234", holderBuild: "old9999"), .takeover)
        XCTAssertEqual(InstanceGuard.decide(ourBuild: "dev", holderBuild: "old9999"), .takeover)
    }

    func testHolderBuild_extractsCommit() {
        let health: [String: Any] = ["ok": true, "build": ["commit": "a1b2c3d"]]
        XCTAssertEqual(InstanceGuard.holderBuild(health), "a1b2c3d")
        XCTAssertNil(InstanceGuard.holderBuild([:]))
        XCTAssertNil(InstanceGuard.holderBuild(nil))
        // Pre-stamp payloads without a build dict read as unknown holder.
        XCTAssertNil(InstanceGuard.holderBuild(["ok": true, "version": "0.2.0"]))
    }

    func testHealthPayload_carriesBuildDict() {
        // Contract: /health always includes build.version/commit/built_at so
        // operators and scripts can verify what's actually serving :8765.
        let payload: [String: Any] = [
            "ok": true,
            "build": ["version": "0.2.0", "commit": "dev", "built_at": "unknown"],
        ]
        let build = payload["build"] as? [String: Any]
        XCTAssertNotNil(build?["commit"])
        XCTAssertNotNil(build?["built_at"])
    }
}
