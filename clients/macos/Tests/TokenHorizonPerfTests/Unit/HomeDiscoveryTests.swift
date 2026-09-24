import XCTest
@testable import TokenHorizon
// swiftlint:disable force_try
// Test files are exempt from force-try enforcement (a try! that fails fails
// the test loudly, which is the desired behavior). Production code keeps the
// default error-level enforcement.

/// Regression tests for `HomeDiscovery` — the shared `~/.*` provider-home
/// auto-discovery. A new `~/.<provider>-N` profile dir must be picked up
/// without code changes; these tests pin that contract using temp homes
/// (hermetic — no dependency on the developer's real `$HOME`).
final class HomeDiscoveryTests: XCTestCase {

    private func makeHome(files: [String] = [], dirs: [String] = []) -> String {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-home-\(UUID().uuidString)").path
        try! FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        for d in dirs {
            try! FileManager.default.createDirectory(atPath: "\(tmp)/\(d)", withIntermediateDirectories: true)
        }
        for f in files {
            FileManager.default.createFile(atPath: "\(tmp)/\(f)", contents: Data("x".utf8))
        }
        return tmp
    }

    private func removeHome(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }

    func testVariantDirs_findsSuffixedProfilesDefaultFirst() {
        let home = makeHome(
            files: [".claude.json"],
            dirs: [".claude", ".claude-1", ".claude-personal", ".codex"])
        defer { removeHome(home) }

        let dirs = HomeDiscovery.variantDirs(
            prefixes: [".claude"], defaultPaths: ["\(home)/.claude"], home: home)
        XCTAssertEqual(dirs.count, 3, "all .claude* dirs, sibling .claude.json file ignored")
        XCTAssertEqual(dirs.first, "\(home)/.claude", "default stays first")
        XCTAssertTrue(dirs.contains("\(home)/.claude-1"))
        XCTAssertTrue(dirs.contains("\(home)/.claude-personal"))
        XCTAssertFalse(dirs.contains(where: { $0.hasSuffix(".claude.json") }))
    }

    func testVariantDirs_noMatchEmpty() {
        let home = makeHome(dirs: [".claude"])
        defer { removeHome(home) }
        XCTAssertTrue(HomeDiscovery.variantDirs(
            prefixes: [".qwen"], defaultPaths: ["\(home)/.qwen"], home: home).isEmpty)
    }

    func testVariantDirs_dedupesDefaultMatchedByGlob() {
        let home = makeHome(dirs: [".codex"])
        defer { removeHome(home) }
        let dirs = HomeDiscovery.variantDirs(
            prefixes: [".codex"], defaultPaths: ["\(home)/.codex"], home: home)
        XCTAssertEqual(dirs.count, 1)
    }

    func testVariantDirs_envOverrideIncluded() {
        let home = makeHome(dirs: [".claude"])
        let extra = makeHome(dirs: ["custom"])
        defer { removeHome(home); removeHome(extra) }
        setenv("TH_TEST_CFG_DIR", "\(extra)/custom", 1)
        defer { unsetenv("TH_TEST_CFG_DIR") }
        let dirs = HomeDiscovery.variantDirs(
            prefixes: [".claude"], envVars: ["TH_TEST_CFG_DIR"],
            defaultPaths: ["\(home)/.claude"], home: home)
        // Historical contract: default stays first, env dir still discovered.
        XCTAssertEqual(dirs.first, "\(home)/.claude")
        XCTAssertTrue(dirs.contains("\(extra)/custom"))
    }

    func testVariantDirs_ignoresMissingEnvAndDefaults() {
        let home = makeHome(dirs: [".claude"])
        defer { removeHome(home) }
        unsetenv("TH_TEST_MISSING_VAR")
        let dirs = HomeDiscovery.variantDirs(
            prefixes: [".claude"], envVars: ["TH_TEST_MISSING_VAR"],
            defaultPaths: ["\(home)/.does-not-exist"], home: home)
        XCTAssertEqual(dirs, ["\(home)/.claude"])
    }

    func testScanDirs_keepsExistingSubpathsOnly() {
        let home = makeHome(dirs: [".codex/sessions", ".codex-1/sessions", ".codex-1/other"])
        defer { removeHome(home) }
        let variants = HomeDiscovery.variantDirs(prefixes: [".codex"], home: home)
        XCTAssertEqual(variants.count, 2)
        let scans = HomeDiscovery.scanDirs(variants, subpaths: ["sessions", "archived_sessions"])
        XCTAssertTrue(scans.contains("\(home)/.codex/sessions"))
        XCTAssertTrue(scans.contains("\(home)/.codex-1/sessions"))
        XCTAssertFalse(scans.contains(where: { $0.contains("archived_sessions") }))
        XCTAssertFalse(scans.contains(where: { $0.hasSuffix("/other") }))
    }

    func testFirstFile_searchesVariantsInOrder() {
        let home = makeHome(dirs: [".kimi", ".kimi-2/credentials"])
        defer { removeHome(home) }
        FileManager.default.createFile(
            atPath: "\(home)/.kimi-2/credentials/kimi-code.json", contents: Data("{}".utf8))
        let found = HomeDiscovery.firstFile(
            in: ["\(home)/.kimi", "\(home)/.kimi-2"], relative: "credentials/kimi-code.json")
        XCTAssertEqual(found, "\(home)/.kimi-2/credentials/kimi-code.json")
        XCTAssertNil(HomeDiscovery.firstFile(in: ["\(home)/.kimi"], relative: "credentials/kimi-code.json"))
    }

    func testOpencodeAuthCandidates_defaultFirst() {
        unsetenv("OPENCODE_AUTH")
        let c = HomeDiscovery.opencodeAuthCandidates()
        XCTAssertGreaterThanOrEqual(c.count, 3)
        XCTAssertTrue(c[0].hasSuffix(".local/share/opencode/auth.json"))
    }

    func testOpencodeAuthCandidates_envFirst() {
        setenv("OPENCODE_AUTH", "/tmp/th-auth.json", 1)
        defer { unsetenv("OPENCODE_AUTH") }
        XCTAssertEqual(HomeDiscovery.opencodeAuthCandidates().first, "/tmp/th-auth.json")
    }

    func testGeminiCredentialPaths_defaultFirstPlusVariants() {
        let home = makeHome(dirs: [".gemini", ".gemini-work"])
        defer { removeHome(home) }
        let paths = HomeDiscovery.geminiCredentialPaths(home: home)
        XCTAssertTrue(paths[0].hasSuffix(".gemini/oauth_creds.json"))
        XCTAssertTrue(paths.contains("\(home)/.gemini/oauth_creds.json"))
        XCTAssertTrue(paths.contains("\(home)/.gemini-work/oauth_creds.json"))
    }

    func testKimiCredentialPaths_coversBothFamilies() {
        let paths = HomeDiscovery.kimiCredentialPaths()
        XCTAssertTrue(paths[0].hasSuffix(".kimi-code/credentials/kimi-code.json"))
        XCTAssertTrue(paths.contains(where: { $0.hasSuffix(".kimi/credentials/kimi-code.json") }))
    }

    // MARK: - Engine integration (form, not live-home dependent)

    func testCodexScanDirs_form() {
        for d in UsageEngine.codexScanDirs {
            XCTAssertTrue(d.hasPrefix("/"), "must be expanded absolute: \(d)")
            XCTAssertTrue(d.hasSuffix("/sessions") || d.hasSuffix("/archived_sessions"))
        }
        XCTAssertTrue(UsageEngine.codexScanDirs.contains(where: { $0.hasSuffix(".codex/sessions") }))
    }

    func testKimiDirs_form() {
        for d in UsageEngine.kimiDirs {
            XCTAssertTrue(d.hasPrefix("/"), "must be expanded absolute: \(d)")
            XCTAssertTrue(d.hasSuffix("/sessions"))
        }
    }

    func testGenericSources_dirsAreAbsolute() {
        let tools = Dictionary(uniqueKeysWithValues: UsageEngine.genericSources.map { ($0.tool, $0.dirs) })
        XCTAssertEqual(Set(tools.keys), ["glm", "qwen", "grok", "deepseek", "gemini", "agy"])
        for (tool, dirs) in tools {
            for d in dirs {
                XCTAssertTrue(d.hasPrefix("/"), "\(tool): must be expanded absolute: \(d)")
            }
        }
    }

    func testClaudeDiscovery_usesSharedGlob() {
        // Live-home smoke: default first when present (existing contract).
        let dirs = ClaudeDiscovery.discoverDirectories()
        let def = HomeDiscovery.expand("~/.claude")
        if HomeDiscovery.isDirectory(def) {
            XCTAssertEqual(dirs.first, def)
        } else {
            XCTAssertTrue(dirs.isEmpty)
        }
    }
}
