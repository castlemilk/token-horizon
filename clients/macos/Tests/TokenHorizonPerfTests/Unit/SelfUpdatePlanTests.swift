import Foundation
import XCTest
@testable import TokenHorizon

final class SelfUpdatePlanTests: XCTestCase {
    private let digest = String(repeating: "a", count: 64)
    private func release(_ version: String = "0.3.15") -> [String: Any] {
        let assets = ["zip", "sha256"].map { suffix -> [String: Any] in
            let name = "TokenHorizon-\(version).\(suffix)"
            return ["name": name, "state": "uploaded", "size": 200,
                    "browser_download_url": "https://github.com/castlemilk/token-horizon/releases/download/v\(version)/\(name)"]
        }
        return ["tag_name": "v\(version)", "draft": false, "prerelease": false, "assets": assets]
    }

    func testReleaseRequiresExactNativeArchiveAndChecksum() throws {
        let valid = try SelfUpdatePlan.release(release())
        XCTAssertEqual(valid.tag, "v0.3.15")
        XCTAssertEqual(valid.archiveName, "TokenHorizon-0.3.15.zip")
        XCTAssertNil(valid.notes)
        XCTAssertNil(valid.url)
        for suffix in ["arm64-mac.zip", "x64-mac.zip", "dmg"] {
            var object = release()
            var assets = try XCTUnwrap(object["assets"] as? [[String: Any]])
            assets[0]["name"] = "TokenHorizon-0.3.15-\(suffix)"
            object["assets"] = assets
            XCTAssertThrowsError(try SelfUpdatePlan.release(object))
        }
        var missing = release()
        missing["assets"] = Array(try XCTUnwrap(missing["assets"] as? [[String: Any]]).prefix(1))
        XCTAssertThrowsError(try SelfUpdatePlan.release(missing))
        var duplicate = release()
        let duplicateAssets = try XCTUnwrap(duplicate["assets"] as? [[String: Any]])
        duplicate["assets"] = duplicateAssets + [try XCTUnwrap(duplicateAssets.first)]
        XCTAssertThrowsError(try SelfUpdatePlan.release(duplicate))
    }

    func testReleaseCarriesCuratedNotesAndValidatedReleaseURL() throws {
        var object = release()
        object["body"] = "## Token Horizon v0.3.15\n\n### ✨ Features\n- One-click auto-sync"
        object["html_url"] = "https://github.com/castlemilk/token-horizon/releases/tag/v0.3.15"
        let decorated = try SelfUpdatePlan.release(object)
        XCTAssertEqual(decorated.notes, object["body"] as? String)
        XCTAssertEqual(decorated.url, object["html_url"] as? String)

        var oversized = release()
        oversized["body"] = String(repeating: "x", count: SelfUpdatePlan.maximumReleaseNotesLength + 1)
        XCTAssertEqual(try SelfUpdatePlan.release(oversized).notes?.count, SelfUpdatePlan.maximumReleaseNotesLength)

        for body in ["", "   \n  ", nil] {
            var blank = release()
            if let body { blank["body"] = body }
            XCTAssertNil(try SelfUpdatePlan.release(blank).notes)
        }
        for url in [
            "http://github.com/castlemilk/token-horizon/releases/tag/v0.3.15",
            "https://evil.example/castlemilk/token-horizon/releases/tag/v0.3.15",
            "https://github.com/other/repo/releases/tag/v0.3.15",
            "https://github.com/castlemilk/token-horizon/releases/tag/v0.3.14",
            "https://github.com/castlemilk/token-horizon/releases/tag/v0.3.15?files=1",
            "not a url"
        ] {
            var untrusted = release()
            untrusted["html_url"] = url
            XCTAssertNil(try SelfUpdatePlan.release(untrusted).url, url)
        }
    }

    func testReleaseRejectsUnpublishedUntrustedAndOversizedAssets() throws {
        for (key, value) in [("draft", true), ("prerelease", true)] {
            var object = release(); object[key] = value
            XCTAssertThrowsError(try SelfUpdatePlan.release(object))
        }
        let mutations: [(String, Any)] = [
            ("state", "starter"), ("size", 0), ("size", SelfUpdatePlan.maximumArchiveSize + 1),
            ("browser_download_url", "https://evil.example/TokenHorizon-0.3.15.zip"),
            ("browser_download_url", "http://github.com/castlemilk/token-horizon/releases/download/v0.3.15/TokenHorizon-0.3.15.zip"),
            ("browser_download_url", "https://github.com/other/repo/releases/download/v0.3.15/TokenHorizon-0.3.15.zip"),
            ("browser_download_url", "https://github.com/castlemilk/token-horizon/releases/download/v0.3.14/TokenHorizon-0.3.15.zip"),
            ("digest", "sha256:bad")
        ]
        for (key, value) in mutations {
            var object = release()
            var assets = try XCTUnwrap(object["assets"] as? [[String: Any]])
            assets[0][key] = value; object["assets"] = assets
            XCTAssertThrowsError(try SelfUpdatePlan.release(object), key)
        }
    }

    func testFallbackSelectsNewestCompleteNativeRelease() {
        var electronOnly = release("0.5.0")
        electronOnly["assets"] = [["name": "TokenHorizon-0.5.0-arm64-mac.zip"]]
        let selected = SelfUpdatePlan.newestNativeRelease([release("0.3.9"), electronOnly, release("0.3.15"), release("0.3.14")])
        XCTAssertEqual(selected?.version, "0.3.15")
        XCTAssertNil(SelfUpdatePlan.newestNativeRelease([electronOnly]))
    }

    func testChecksumMatchesExactArchiveAndRejectsDuplicateOrMissingRows() throws {
        let name = "TokenHorizon-0.3.15.zip"
        XCTAssertEqual(try SelfUpdatePlan.checksum("\(digest.uppercased())  \(name)\n\(digest)  unrelated.dmg\n", archiveName: name), digest)
        XCTAssertEqual(try SelfUpdatePlan.checksum("\(digest)\t*\(name)\n", archiveName: name), digest)
        for text in ["\(digest)  unrelated.zip\n", "\(digest)  ./\(name)\n",
                     "\(digest)  \(name)\n\(digest)  \(name)\n", "invalid  \(name)\n",
                     String(repeating: "a", count: 65_537)] {
            XCTAssertThrowsError(try SelfUpdatePlan.checksum(text, archiveName: name))
        }
    }

    func testArchivePathsRemainWithinExpectedBundle() throws {
        try SelfUpdatePlan.validateArchivePaths("TokenHorizon.app/\nTokenHorizon.app/Contents/MacOS/TokenHorizon\n__MACOSX/\n__MACOSX/TokenHorizon.app/._Contents\n")
        for listing in ["", "../outside\n", "/Applications/TokenHorizon.app/file\n",
                        "TokenHorizon.app/Contents/../../outside\n", "TokenHorizon.app\\outside\n", "Electron.app/Contents/MacOS/main\n"] {
            XCTAssertThrowsError(try SelfUpdatePlan.validateArchivePaths(listing))
        }
    }

    func testAutomaticInstallSkipsDirtyAndPreviouslyFailedReleases() {
        XCTAssertTrue(SelfUpdatePlan.automaticInstallAllowed(commit: "9cc7bb1", version: "0.3.15", failedVersion: nil))
        for commit in ["", "dev", "unknown", "9cc7bb1-dirty", "9cc7bb1+dirty", "9cc7bb1\n"] {
            XCTAssertFalse(SelfUpdatePlan.automaticInstallAllowed(commit: commit, version: "0.3.15", failedVersion: nil), commit)
        }
        XCTAssertFalse(SelfUpdatePlan.automaticInstallAllowed(commit: "9cc7bb1", version: "0.3.15", failedVersion: "0.3.15"))
        XCTAssertTrue(SelfUpdatePlan.automaticInstallAllowed(commit: "9cc7bb1", version: "0.3.16", failedVersion: "0.3.15"))
    }

    func testBundleMetadataRequiresExpectedVersionIdentityAndCleanStamp() throws {
        let metadata: [String: Any] = ["CFBundleIdentifier": "local.benebsworth.token-horizon",
            "CFBundleExecutable": "TokenHorizon", "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "0.3.15", "THGitSHA": "9cc7bb1"]
        XCTAssertEqual(try SelfUpdatePlan.validateBundleMetadata(metadata, version: "0.3.15"), "9cc7bb1")
        for (key, value) in [("CFBundleIdentifier", "other.app"), ("CFBundleExecutable", "Electron"),
                             ("CFBundleShortVersionString", "0.3.14"), ("THGitSHA", "9cc7bb1-dirty")] {
            var invalid = metadata; invalid[key] = value
            XCTAssertThrowsError(try SelfUpdatePlan.validateBundleMetadata(invalid, version: "0.3.15"))
        }
        XCTAssertNil(SelfUpdater.teamIdentifier("TeamIdentifier=not set\n"))
        XCTAssertNil(SelfUpdater.teamIdentifier("TeamIdentifier=notset\n"))
        XCTAssertEqual(SelfUpdater.teamIdentifier("Authority=Developer ID Application\nTeamIdentifier=TEAM12345\n"), "TEAM12345")
    }

    func testDownloadRedirectTrustRequiresGitHubHTTPS() {
        for host in ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"] {
            XCTAssertTrue(SelfUpdatePlan.trustedDownloadURL(URL(string: "https://\(host)/download?token=temporary")!))
        }
        for raw in ["http://github.com/download", "https://github.com.evil.example/download",
                    "https://user:secret@github.com/download", "https://github.com:8443/download", "file:///tmp/archive"] {
            XCTAssertFalse(SelfUpdatePlan.trustedDownloadURL(URL(string: raw)!))
        }
    }

    func testRelaunchPassesPathsAsArgumentsAndTargetsOnlyMatchingAgent() {
        let quote = "\u{0060}"
        let bundle = URL(fileURLWithPath: "/Applications/Token ' $HOME \(quote)printf unsafe\(quote).app")
        let backup = URL(fileURLWithPath: "/Applications/previous.app")
        let arguments = SelfUpdateRelaunch.arguments(pid: 123, app: bundle, backup: backup,
            failedCopy: URL(fileURLWithPath: "/Applications/failed.app"), service: "", version: "0.3.15",
            commit: "9cc7bb1", report: URL(fileURLWithPath: "/tmp/report"))
        XCTAssertEqual(arguments[4], bundle.path)
        XCTAssertEqual(arguments[5], backup.path)
        XCTAssertFalse(arguments[1].contains(bundle.path))
        let plist: [String: Any] = ["Label": LaunchAgentCtl.label,
                                   "ProgramArguments": [bundle.appendingPathComponent("Contents/MacOS/TokenHorizon").path]]
        XCTAssertTrue(SelfUpdatePlan.matchingLaunchAgent(plist, bundle: bundle))
        XCTAssertFalse(SelfUpdatePlan.matchingLaunchAgent(plist, bundle: URL(fileURLWithPath: "/Applications/other.app")))
    }
}

final class SelfUpdateTransactionTests: XCTestCase {
    private let destination = URL(fileURLWithPath: "/Apps/TokenHorizon.app")
    private let prepared = URL(fileURLWithPath: "/Apps/prepared.app")
    private let backup = URL(fileURLWithPath: "/Apps/TokenHorizon.backup.app")
    private let previous = URL(fileURLWithPath: "/Apps/previous.app")

    private final class Files {
        var entries: [URL: String]
        var failureSource: URL?
        var partialDestination = false
        init(_ entries: [URL: String]) { self.entries = entries }
        func move(_ source: URL, _ destination: URL) throws {
            if source == failureSource {
                if partialDestination { entries[destination] = "partial" }
                throw SelfUpdateFailure("Injected rename failure")
            }
            guard entries[destination] == nil, let value = entries.removeValue(forKey: source) else {
                throw SelfUpdateFailure("Missing source or occupied destination")
            }
            entries[destination] = value
        }
        func remove(_ url: URL) throws { entries[url] = nil }
    }

    private func replace(_ files: Files) throws {
        try SelfUpdateTransaction.replace(prepared: prepared, destination: destination, backup: backup,
            previousBackup: previous, exists: { files.entries[$0] != nil }, move: files.move, remove: files.remove)
    }

    func testSuccessfulCommitRetainsCurrentAppAsBackup() throws {
        let files = Files([destination: "current", prepared: "new", backup: "older"])
        try replace(files)
        XCTAssertEqual(files.entries[destination], "new")
        XCTAssertEqual(files.entries[backup], "current")
        XCTAssertNil(files.entries[previous])
        XCTAssertNil(files.entries[prepared])
    }

    func testCommitFailureRestoresCurrentAndPriorBackupEvenWithPartialDestination() {
        for partial in [false, true] {
            let files = Files([destination: "current", prepared: "new", backup: "older"])
            files.failureSource = prepared; files.partialDestination = partial
            XCTAssertThrowsError(try replace(files))
            XCTAssertEqual(files.entries[destination], "current")
            XCTAssertEqual(files.entries[backup], "older")
            XCTAssertNil(files.entries[previous])
        }
    }

    func testMovingCurrentFailureRestoresPriorBackupWithoutRemovingCurrent() {
        let files = Files([destination: "current", prepared: "new", backup: "older"])
        files.failureSource = destination
        XCTAssertThrowsError(try replace(files))
        XCTAssertEqual(files.entries[destination], "current")
        XCTAssertEqual(files.entries[backup], "older")
        XCTAssertNil(files.entries[previous])
    }

    func testRelaunchFailureCanRestoreVerifiedPreviousApp() throws {
        let failed = URL(fileURLWithPath: "/Apps/failed.app")
        let files = Files([destination: "new", backup: "current"])
        try SelfUpdateTransaction.restore(destination: destination, backup: backup, failedCopy: failed, move: files.move)
        XCTAssertEqual(files.entries[destination], "current")
        XCTAssertEqual(files.entries[failed], "new")
        XCTAssertNil(files.entries[backup])
    }
}
