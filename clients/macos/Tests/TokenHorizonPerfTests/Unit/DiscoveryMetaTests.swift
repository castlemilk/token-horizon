import XCTest
@testable import TokenHorizon

/// Tests for discovery status reads and credential-path computation.
/// No timers are started and no network runs — pure reads.
final class DiscoveryMetaTests: XCTestCase {

    func testDiscoveryStatus_shape() {
        let st = ModelDiscoveryEngine.shared.status()
        XCTAssertGreaterThanOrEqual(st.monitoredFiles.count, 0)
        XCTAssertGreaterThanOrEqual(st.scanCount, 0)
        XCTAssertGreaterThanOrEqual(st.catalogCount, 0)
    }

    func testGeminiCredentialPaths_explicitHome() {
        let paths = HomeDiscovery.geminiCredentialPaths(home: "/tmp/th-gemini-home")
        XCTAssertFalse(paths.isEmpty)
        XCTAssertEqual(paths.first, "/tmp/th-gemini-home/.gemini/oauth_creds.json")
    }

    func testKimiCredentialPaths_explicitHome() {
        let paths = HomeDiscovery.kimiCredentialPaths(home: "/tmp/th-kimi-home")
        XCTAssertEqual(paths.first, "/tmp/th-kimi-home/.kimi-code/credentials/kimi-code.json")
        XCTAssertTrue(paths.contains("/tmp/th-kimi-home/.kimi/credentials/kimi-code.json"))
    }

    func testDeriveLabel() {
        struct Case { let dir: String; let email: String; let want: String }
        let cases: [Case] = [
            Case(dir: "/h/.claude-2", email: "dev@gmail.com", want: "dev"),
            Case(dir: "/h/.claude-2", email: "ops@Example.COM", want: "example"),
            Case(dir: "/h/.claude-2", email: "", want: "claude-2"),
            Case(dir: "/h/work", email: "", want: "work"),
        ]
        for (i, tc) in cases.enumerated() {
            XCTAssertEqual(ClaudeDiscovery.deriveLabel(dir: tc.dir, email: tc.email), tc.want, "case \(i)")
        }
    }

    func testAccountMetadata_tempHome() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-claude-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: dir.path, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let json = """
        {"oauthAccount":{"emailAddress":"dev@gmail.com","accountUuid":"u1","displayName":"Dev","organizationName":"Acme"}}
        """
        _ = FileManager.default.createFile(atPath: dir.appendingPathComponent(".claude.json").path,
                                           contents: Data(json.utf8))
        let acct = ClaudeDiscovery.shared.accountMetadata(for: dir.path)
        XCTAssertEqual(acct.email, "dev@gmail.com")
        XCTAssertEqual(acct.accountUuid, "u1")
        XCTAssertEqual(acct.displayName, "Dev")
        XCTAssertEqual(acct.organizationName, "Acme")
        XCTAssertEqual(acct.configDir, dir.path)
    }
}
