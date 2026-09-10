import XCTest
@testable import TokenHorizon

/// Tests for small pure helpers: Kimi credential paths, home listing cache,
/// MLX argv splitting, notifier keys, and no-op engine flush.
final class MiscHelperTests: XCTestCase {

    // MARK: - Kimi credential paths

    func testCredentialPaths_honorsEnvOverrides() {
        setenv("KIMI_CODE_HOME", "/tmp/th-kimi-code-home", 1)
        setenv("KIMI_HOME", "/tmp/th-kimi-home", 1)
        defer {
            unsetenv("KIMI_CODE_HOME")
            unsetenv("KIMI_HOME")
        }
        let paths = KimiLimitsEngine.credentialPaths()
        XCTAssertTrue(paths.first?.hasPrefix("/tmp/th-kimi-code-home") ?? false)
        XCTAssertTrue(paths.contains("/tmp/th-kimi-home/credentials/kimi-code.json"))
        XCTAssertTrue(paths.contains(HomeDiscovery.expand("~/.kimi/credentials/kimi-code.json")))
    }

    func testReadCredentials_tempHome() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-kimi-\(UUID().uuidString)")
        let credDir = dir.appendingPathComponent("credentials")
        try FileManager.default.createDirectory(at: credDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let json = #"{"access_token":"abc","refresh_token":"r","expires_at":999}"#
        _ = FileManager.default.createFile(atPath: credDir.appendingPathComponent("kimi-code.json").path,
                                       contents: Data(json.utf8))
        setenv("KIMI_CODE_HOME", dir.path, 1)
        defer { unsetenv("KIMI_CODE_HOME") }
        let creds = KimiLimitsEngine.readCredentials()
        XCTAssertEqual(creds?.accessToken, "abc")
        XCTAssertEqual(creds?.refreshToken, "r")
        XCTAssertEqual(creds?.expiresAt ?? -1, 999, accuracy: 1e-9)
    }

    // MARK: - Home listing cache

    func testResetCache_repopulatesIdentically() {
        let a = HomeDiscovery.variantDirs(prefixes: [".claude"])
        HomeDiscovery.resetCache()
        XCTAssertEqual(HomeDiscovery.variantDirs(prefixes: [".claude"]), a)
    }

    func testHomeEntries_explicitHome() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-home-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: dir.path, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        _ = FileManager.default.createFile(atPath: dir.appendingPathComponent(".claude").path,
                                       contents: Data())
        XCTAssertTrue(HomeDiscovery.homeEntries(home: dir.path).contains(".claude"))
        XCTAssertFalse(HomeDiscovery.homeEntries(home: dir.path + "/missing").contains(".claude"))
    }

    // MARK: - MLX argv splitting

    func testCommandArguments() {
        struct Case { let cmd: String; let want: [String] }
        let cases: [Case] = [
            Case(cmd: "", want: []),
            Case(cmd: "   ", want: []),
            Case(cmd: "/a/b --flag val", want: ["/a/b", "--flag", "val"]),
            Case(cmd: "a\tb", want: ["a", "b"]),
            Case(cmd: #"run "model name" --x"#, want: ["run", "model name", "--x"]),
            Case(cmd: "run 'q w' --x", want: ["run", "q w", "--x"]),
            Case(cmd: #"a\ b c"#, want: ["a b", "c"]),
            Case(cmd: #"trailing\"#, want: [#"trailing\"#]),
        ]
        for (i, tc) in cases.enumerated() {
            XCTAssertEqual(MLXObserver.commandArguments(tc.cmd), tc.want, "case \(i)")
        }
    }

    // MARK: - Notifier keys

    func testMakeKey() {
        let n = LimitNotifier.shared
        XCTAssertEqual(n.makeKey(provider: "Claude", label: "Weekly"), "claude:weekly")
        XCTAssertEqual(n.makeKey(provider: "a", label: "b"), "a:b")
    }

    func testNotifierProviderDisplayName() {
        let n = LimitNotifier.shared
        struct Case { let raw: String; let want: String }
        let cases: [Case] = [
            Case(raw: "codex", want: "OpenAI"), Case(raw: "kimi", want: "Kimi"),
            Case(raw: "glm", want: "GLM"), Case(raw: "minimax", want: "MiniMax"),
            Case(raw: "opencode-go", want: "OpenCode"), Case(raw: "agy", want: "AGY"),
            Case(raw: "gemini", want: "Google"), Case(raw: "alibaba", want: "Alibaba"),
            Case(raw: "claude", want: "Claude"), Case(raw: "deepseek", want: "DeepSeek"),
            Case(raw: "mystery", want: "Mystery"),
        ]
        for (i, tc) in cases.enumerated() {
            XCTAssertEqual(n.providerDisplayName(tc.raw), tc.want, "case \(i)")
        }
    }

    // MARK: - Engine flush no-op

    func testFlushEngineState_withoutStagedPayloadIsNoop() {
        // Must never crash and must not require staged state. (When other
        // tests stage payloads first, this writes the valid staged state —
        // the same write the app performs constantly.)
        DurableStore.shared.flushEngineState()
    }
}
