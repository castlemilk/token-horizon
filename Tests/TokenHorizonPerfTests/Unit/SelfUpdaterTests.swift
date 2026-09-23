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

    func testIsNewer_lengthMismatchAndSuffixes() {
        // Missing components read as zero; prerelease suffixes strip.
        XCTAssertTrue(SelfUpdater.isNewer("0.3.6.1", than: "0.3.6"))
        XCTAssertFalse(SelfUpdater.isNewer("0.3.6", than: "0.3.6.1"))
        XCTAssertTrue(SelfUpdater.isNewer("0.4.0-beta", than: "0.3.9"))
        XCTAssertFalse(SelfUpdater.isNewer("0.3.6-rc1", than: "0.3.6"))
    }

    func testIsNewer_malformedInputsNeverCrash() {
        XCTAssertFalse(SelfUpdater.isNewer("", than: "0.3.6"))
        XCTAssertFalse(SelfUpdater.isNewer("banana", than: "0.3.6"))
        XCTAssertFalse(SelfUpdater.isNewer("1..2", than: "0.3.6"))
        XCTAssertFalse(SelfUpdater.isNewer("v2.0", than: "0.3.6")) // "v2" parses as 0 — no crash
    }
}
