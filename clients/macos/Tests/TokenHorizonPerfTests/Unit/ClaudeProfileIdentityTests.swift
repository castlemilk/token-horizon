import XCTest
@testable import TokenHorizon

final class ClaudeProfileIdentityTests: XCTestCase {
    private let home = "/Users/claude-profile-test"

    func testMetadataCandidatesNeverBorrowAnotherProfilesAccount() {
        let cases: [(String, [String])] = [
            ("\(home)/.claude", ["\(home)/.claude.json", "\(home)/.claude/.claude.json"]),
            ("~/.claude/", ["\(home)/.claude.json", "\(home)/.claude/.claude.json"]),
            ("\(home)/.claude-1", ["\(home)/.claude-1/.claude.json"]),
            ("\(home)/.claude-2", ["\(home)/.claude-2/.claude.json"]),
            ("\(home)/.config/claude", ["\(home)/.config/claude/.claude.json"]),
            ("/Volumes/profiles/.claude", ["/Volumes/profiles/.claude/.claude.json"])
        ]
        for (dir, expected) in cases {
            XCTAssertEqual(ClaudeProfileIdentity.metadataPaths(for: dir, home: home), expected, dir)
        }
    }

    func testOnlyCanonicalDefaultCanReadUnscopedKeychainCredentials() {
        let cases = [
            ("\(home)/.claude", true),
            ("\(home)/.claude-1", false),
            ("\(home)/.claude-2", false),
            ("\(home)/.config/claude", false),
            ("/Volumes/profiles/.claude", false)
        ]
        for (dir, isDefault) in cases {
            let scoped = "Claude Code-credentials-\(ClaudeDiscovery.sha256Prefix8(dir))"
            let expected = isDefault ? ["Claude Code-credentials", scoped] : [scoped]
            XCTAssertEqual(ClaudeProfileIdentity.keychainServices(for: dir, home: home), expected, dir)
        }
        XCTAssertEqual(
            ClaudeProfileIdentity.keychainServices(for: "~/.claude/", home: home),
            ClaudeProfileIdentity.keychainServices(for: "\(home)/.claude", home: home))
    }

    func testHomeVariantIDsRemainCompatible() {
        let cases = [
            (".claude", "claude"),
            (".claude-1", "claude-1"),
            (".claude-2", "claude-2"),
            (".claude-personal", "claude-personal")
        ]
        for (directory, expected) in cases {
            XCTAssertEqual(ClaudeProfileIdentity.profileID(for: "\(home)/\(directory)", home: home), expected)
        }
    }

    func testNestedAndCustomHomesKeepDistinctStableIDs() {
        let dirs = [
            "\(home)/.claude",
            "\(home)/.config/claude",
            "\(home)/work/claude",
            "/Volumes/profiles/.claude",
            "/Volumes/profiles/.claude-1",
            "\(home)/.claude-1"
        ]
        let ids = dirs.map { ClaudeProfileIdentity.profileID(for: $0, home: home) }
        XCTAssertEqual(Set(ids).count, dirs.count, "matching basenames must not merge accounts")
        for dir in ["\(home)/.config/claude", "\(home)/work/claude", "/Volumes/profiles/.claude"] {
            let expected = "claude-\(ClaudeDiscovery.sha256Prefix8(dir))"
            XCTAssertEqual(ClaudeProfileIdentity.profileID(for: dir, home: home), expected, dir)
            XCTAssertEqual(ClaudeProfileIdentity.profileID(for: dir + "/", home: home), expected, dir)
        }
    }

    func testProviderNamesPreserveSingleAndSeparateMultipleAccounts() {
        let personal = account(".claude", email: "ben.ebsworth@gmail.com")
        let dorja = account(".claude-2", email: "ben@dorja.com")
        let cases: [([ClaudeAccount], [String: String])] = [
            ([], [:]),
            ([personal], [personal.configDir: "claude"]),
            ([dorja], [dorja.configDir: "claude"]),
            ([personal, dorja], [
                personal.configDir: "claude (ben.ebsworth)",
                dorja.configDir: "claude (dorja)"
            ])
        ]
        for (accounts, expected) in cases {
            XCTAssertEqual(ClaudeProfileIdentity.providerNames(for: accounts), expected)
        }
    }

    func testDuplicateLabelsNeverMergeEvenForTheSameEmail() {
        let cases = [
            ("first@dorja.com", "second@dorja.com", "dorja"),
            ("ben.ebsworth@gmail.com", "ben.ebsworth@gmail.com", "ben.ebsworth")
        ]
        for (firstEmail, secondEmail, label) in cases {
            let first = account(".claude-1", email: firstEmail)
            let second = account(".claude-2", email: secondEmail)
            let expected = [
                first.configDir: "claude (\(label) · claude-1)",
                second.configDir: "claude (\(label) · claude-2)"
            ]
            XCTAssertEqual(ClaudeProfileIdentity.providerNames(for: [first, second]), expected)
            XCTAssertEqual(ClaudeProfileIdentity.providerNames(for: [second, first]), expected,
                           "discovery order must not rename quota rows")
        }
    }

    func testLegacyCollidingIDsStillProduceSeparateProviderGroups() {
        let first = ClaudeAccount(id: "claude", label: "work", configDir: "\(home)/.claude")
        let second = ClaudeAccount(id: "claude", label: "work", configDir: "\(home)/.config/claude")
        let names = ClaudeProfileIdentity.providerNames(for: [first, second])
        XCTAssertEqual(names.count, 2)
        XCTAssertEqual(Set(names.values).count, 2)
        XCTAssertTrue(names.values.allSatisfy { $0.hasPrefix("claude (work · claude · ") })
    }

    func testLiteralLabelCannotMergeWithADisambiguatedLabel() {
        let first = ClaudeAccount(id: "claude-1", label: "work", configDir: "\(home)/.claude-1")
        let second = ClaudeAccount(id: "claude-2", label: "work", configDir: "\(home)/.claude-2")
        let third = ClaudeAccount(id: "claude-3", label: "work · claude-1", configDir: "\(home)/.claude-3")
        let names = ClaudeProfileIdentity.providerNames(for: [first, second, third])
        XCTAssertEqual(Set(names.values).count, 3)
        XCTAssertEqual(names[second.configDir], "claude (work · claude-2)")
        XCTAssertEqual(names, ClaudeProfileIdentity.providerNames(for: [third, second, first]))
    }

    private func account(_ directory: String, email: String) -> ClaudeAccount {
        let dir = "\(home)/\(directory)"
        return ClaudeAccount(
            id: ClaudeProfileIdentity.profileID(for: dir, home: home),
            label: ClaudeDiscovery.deriveLabel(dir: dir, email: email),
            configDir: dir,
            email: email)
    }
}
