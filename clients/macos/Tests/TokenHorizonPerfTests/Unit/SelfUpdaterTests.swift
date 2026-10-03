import XCTest
@testable import TokenHorizon

/// Semver comparison driving the self-updater: a wrong "newer" answer either
/// nags users to downgrade or silently skips real releases.
final class SelfUpdaterTests: XCTestCase {

    func testIsNewer_basic() {
        XCTAssertTrue(SelfUpdater.isNewer("0.3.7", than: "0.3.6"))
        XCTAssertTrue(SelfUpdater.isNewer("0.4.0", than: "0.3.9"))
        XCTAssertTrue(SelfUpdater.isNewer("1.0.0", than: "0.9.9"))
        XCTAssertTrue(SelfUpdater.isNewer("0.10.0", than: "0.9.9"))
    }

    func testIsNewer_notNewer() {
        XCTAssertFalse(SelfUpdater.isNewer("0.3.6", than: "0.3.6"))
        XCTAssertFalse(SelfUpdater.isNewer("0.3.5", than: "0.3.6"))
        XCTAssertFalse(SelfUpdater.isNewer("0.2.9", than: "0.3.0"))
        XCTAssertFalse(SelfUpdater.isNewer("0.9.9", than: "1.0.0"))
    }

    func testIsNewer_acceptsOnlyStableThreePartVersions() {
        // This channel requires stable X.Y.Z releases.
        XCTAssertFalse(SelfUpdater.isNewer("0.3.6.1", than: "0.3.6"))
        XCTAssertFalse(SelfUpdater.isNewer("0.3.6", than: "0.3.6.1"))
        XCTAssertFalse(SelfUpdater.isNewer("0.4.0-beta", than: "0.3.9"))
        XCTAssertFalse(SelfUpdater.isNewer("0.3.6-rc1", than: "0.3.6"))
    }

    func testIsNewer_malformedInputsNeverCrash() {
        XCTAssertFalse(SelfUpdater.isNewer("", than: "0.3.6"))
        XCTAssertFalse(SelfUpdater.isNewer("banana", than: "0.3.6"))
        XCTAssertFalse(SelfUpdater.isNewer("1..2", than: "0.3.6"))
        XCTAssertFalse(SelfUpdater.isNewer("v2.0", than: "0.3.6"))
        for malformed in ["01.0.0", "2.01.0", "2.0.01", "-2.0.0", "+2.0.0", "2.0", "2.0.0+build", "2.0.0\n", "999999999999999999999.0.0"] {
            XCTAssertFalse(SelfUpdater.isNewer(malformed, than: "0.3.6"), malformed)
        }
    }

    private func developerIDSignature(team: String) -> String {
        "Authority=Developer ID Application: Token Horizon (\(team))\n"
            + "Authority=Developer ID Certification Authority\nAuthority=Apple Root CA\n"
            + "TeamIdentifier=\(team)\n"
    }

    func testAdHocBootstrapMayUpgradeToDeveloperIDRelease() throws {
        XCTAssertEqual(
            try SelfUpdater.validateSigningIdentity(candidate: developerIDSignature(team: "ABC12345DE"),
                                                    current: "Signature=adhoc\nTeamIdentifier=not set\n"),
            "ABC12345DE"
        )
    }

    func testProductionInstallationRequiresTheSameSigningTeam() throws {
        let current = developerIDSignature(team: "ABC12345DE")
        XCTAssertEqual(try SelfUpdater.validateSigningIdentity(candidate: current, current: current), "ABC12345DE")
        XCTAssertThrowsError(
            try SelfUpdater.validateSigningIdentity(candidate: developerIDSignature(team: "XYZ98765AB"), current: current)
        )
    }

    func testCandidatesRequireDeveloperIDAuthorityAndAnUnambiguousTeam() {
        let current = "Signature=adhoc\nTeamIdentifier=not set\n"
        let signed = developerIDSignature(team: "ABC12345DE")
        let invalid = [
            current,
            "Authority=Apple Development: Token Horizon\nTeamIdentifier=ABC12345DE\n",
            "Authority=Apple Development: Token Horizon\n" + signed,
            "Authority=Developer ID Application: Token Horizon\nTeamIdentifier=not set\n",
            "Authority=Developer ID Application: Token Horizon\n",
            developerIDSignature(team: "malformed"),
            signed + "TeamIdentifier=XYZ98765AB\n",
            signed + "Signature=adhoc\n"
        ]
        for candidate in invalid {
            XCTAssertThrowsError(try SelfUpdater.validateSigningIdentity(candidate: candidate, current: current), candidate)
        }
    }

    func testUnrecognizedCurrentSignatureCannotBypassTeamBinding() {
        let signed = developerIDSignature(team: "ABC12345DE")
        for current in ["", "Signature=adhoc\n", signed + "TeamIdentifier=XYZ98765AB\n"] {
            XCTAssertThrowsError(try SelfUpdater.validateSigningIdentity(candidate: signed, current: current))
        }
    }

    func testGatekeeperAcceptsOnlyNotarizedDeveloperIDAssessment() throws {
        // spctl is supplied by macOS, so the client does not need Xcode or
        // Command Line Tools to verify a notarized production update.
        try SelfUpdater.validateNotarizedAssessment(
            "/tmp/TokenHorizon.app: accepted\nsource=Notarized Developer ID\n"
                + "origin=Developer ID Application: Token Horizon (ABC12345DE)\n"
        )
        for assessment in [
            "/tmp/TokenHorizon.app: accepted\nsource=Developer ID\n",
            "/tmp/TokenHorizon.app: rejected\nsource=Unnotarized Developer ID\n",
            "/tmp/TokenHorizon.app: rejected\nsource=Notarized Developer ID\n",
            "/tmp/TokenHorizon.app: accepted\n",
            "assessments disabled\n",
            "/tmp/TokenHorizon.app: accepted\nsource=Notarized Developer ID\nsource=Developer ID\n"
        ] {
            XCTAssertThrowsError(try SelfUpdater.validateNotarizedAssessment(assessment), assessment)
        }
    }
}
