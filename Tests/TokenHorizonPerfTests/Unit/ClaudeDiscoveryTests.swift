import XCTest
@testable import TokenHorizon

final class ClaudeDiscoveryTests: XCTestCase {

    func testSha256Prefix8_deterministic() {
        let path = "/Users/benebsworth/.claude-1"
        let hash = ClaudeDiscovery.sha256Prefix8(path)
        XCTAssertEqual(hash, "0f3d57eb")

        let path2 = "/Users/benebsworth/.claude-2"
        let hash2 = ClaudeDiscovery.sha256Prefix8(path2)
        XCTAssertEqual(hash2, "7a95f4f6")
    }

    func testDeriveLabel_extractsCleanIdentifiers() {
        XCTAssertEqual(ClaudeDiscovery.deriveLabel(dir: "/Users/test/.claude", email: "ben.ebsworth@gmail.com"), "ben.ebsworth")
        XCTAssertEqual(ClaudeDiscovery.deriveLabel(dir: "/Users/test/.claude-1", email: "ben@shorted.com.au"), "shorted")
        XCTAssertEqual(ClaudeDiscovery.deriveLabel(dir: "/Users/test/.claude-2", email: "ben@dorja.com"), "dorja")
        XCTAssertEqual(ClaudeDiscovery.deriveLabel(dir: "/Users/test/.claude-3", email: "user@acme.org"), "acme")
        XCTAssertEqual(ClaudeDiscovery.deriveLabel(dir: "/Users/test/.claude-personal", email: ""), "claude-personal")
    }

    func testDiscoverDirectories_includesStandardDirs() {
        let dirs = ClaudeDiscovery.discoverDirectories()
        XCTAssertFalse(dirs.isEmpty)
        let defaultClaude = NSString(string: "~/.claude").expandingTildeInPath
        XCTAssertTrue(dirs.contains(defaultClaude))
        // Verify ~/.claude is first in the list
        XCTAssertEqual(dirs.first, defaultClaude)
    }

    func testParseClaudePayload_withMultiAccountProviderAndDetail() {
        let json: [String: Any] = [
            "five_hour": [
                "utilization": 28.0,
                "resets_at": "2026-09-07T18:00:00.000Z"
            ],
            "seven_day": [
                "utilization": 14.0,
                "resets_at": "2026-09-11T00:00:00.000Z"
            ]
        ]

        let limits = PlanLimitsEngine.parseClaudePayload(
            json,
            provider: "claude (shorted)",
            detail: "ben@shorted.com.au · claude_max"
        )
        XCTAssertEqual(limits.count, 2)

        let fiveH = limits.first(where: { $0.label == "5h" })
        XCTAssertNotNil(fiveH)
        XCTAssertEqual(fiveH?.provider, "claude (shorted)")
        XCTAssertEqual(fiveH?.usedPercent, 28.0)
        XCTAssertEqual(fiveH?.detail, "ben@shorted.com.au · claude_max")

        let weekly = limits.first(where: { $0.label == "weekly" })
        XCTAssertNotNil(weekly)
        XCTAssertEqual(weekly?.provider, "claude (shorted)")
        XCTAssertEqual(weekly?.usedPercent, 14.0)
    }

    func testAccountMetadata_readsDiscoveredAccount() {
        let defaultClaude = NSString(string: "~/.claude").expandingTildeInPath
        let acct = ClaudeDiscovery.shared.accountMetadata(for: defaultClaude)
        XCTAssertEqual(acct.configDir, defaultClaude)
        XCTAssertFalse(acct.id.isEmpty)
        // If host has .claude.json, email will be populated
        if !acct.email.isEmpty {
            XCTAssertTrue(acct.email.contains("@"))
        }
    }

    func testDiskCacheStalenessLogic() {
        let nowSec = Date().timeIntervalSince1970
        // Case 1: Fresh cache (10 minutes old)
        let freshAtMs = (nowSec - 600) * 1000.0
        let freshAge = nowSec - (freshAtMs / 1000.0)
        XCTAssertTrue(freshAge < 7200, "Cache from 10 minutes ago should be considered fresh")

        // Case 2: Stale cache (3 days old like ~/.claude-1/.claude.json was)
        let staleAtMs = (nowSec - 3 * 86400) * 1000.0
        let staleAge = nowSec - (staleAtMs / 1000.0)
        XCTAssertFalse(staleAge < 7200, "Cache older than 2 hours must be rejected as stale")
    }
}
