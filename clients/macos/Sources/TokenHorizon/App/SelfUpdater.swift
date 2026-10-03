import AppKit
import Combine
import CryptoKit
import Darwin
import Foundation
import os

private let updaterLog = Logger(subsystem: "com.tokenhorizon.app", category: "updater")

/// Native updates use published GitHub assets, an exact SHA-256 entry, bundle
/// and signature validation, a reversible rename, and a supervised restart.
final class SelfUpdater: ObservableObject {
    static let shared = SelfUpdater()
    enum Phase: Equatable { case idle, checking, upToDate, available, downloading, installing, relaunching, failed }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var latestTag = ""
    @Published private(set) var statusDetail = ""
    @Published private(set) var lastChecked: Date?
    private var timer: Timer?
    private var initialCheck: DispatchWorkItem?
    private var release: SelfUpdateRelease?
    private var failedVersion: String?
    private var checkingID: UUID?
    private var failureReport: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("TokenHorizon/self-update-failure.txt")
    }

    func start() {
        guard Thread.isMainThread else { main { self.start() }; return }
        timer?.invalidate(); initialCheck?.cancel()
        if let report = try? String(contentsOf: failureReport, encoding: .utf8) {
            let lines = report.split(whereSeparator: \.isNewline)
            if let version = lines.first.map(String.init), SelfUpdatePlan.versionParts(version) != nil {
                failedVersion = version
                phase = .failed
                statusDetail = lines.count > 1 ? String(lines[1].prefix(400)) : "The last update needs attention."
            }
        }
        let work = DispatchWorkItem { [weak self] in self?.check(manual: false) }
        initialCheck = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
        timer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in self?.check(manual: false) }
    }

    func check(manual: Bool) {
        guard Thread.isMainThread else { main { self.check(manual: manual) }; return }
        guard ![Phase.checking, .downloading, .installing, .relaunching].contains(phase) else { return }
        let id = UUID()
        checkingID = id; release = nil; latestTag = ""
        phase = .checking; statusDetail = "Checking for updates…"
        let base = "https://api.github.com/repos/\(SelfUpdatePlan.repository)/releases"
        fetchJSON(URL(string: base + "/latest")!) { [weak self] result in
            guard let self, self.checkingID == id else { return }
            switch result {
            case .failure(let error): self.checkFailed(error)
            case .success(let value):
                guard let object = value as? [String: Any] else {
                    self.checkFailed(SelfUpdateFailure("GitHub returned an invalid release response.")); return
                }
                if let native = try? SelfUpdatePlan.release(object) {
                    self.checked(native, fallback: false)
                } else {
                    // /latest may describe Electron artifacts. Search only a
                    // bounded recent page for the complete native contract.
                    self.fetchJSON(URL(string: base + "?per_page=20")!) { [weak self] result in
                        guard let self, self.checkingID == id else { return }
                        switch result {
                        case .failure(let error): self.checkFailed(error)
                        case .success(let value):
                            guard let objects = value as? [[String: Any]],
                                  let native = SelfUpdatePlan.newestNativeRelease(Array(objects.prefix(20))) else {
                                self.checkFailed(SelfUpdateFailure("No complete native macOS release is available. Check again after its archive and checksum are published."))
                                return
                            }
                            self.checked(native, fallback: true)
                        }
                    }
                }
            }
        }
    }

    private func checked(_ native: SelfUpdateRelease, fallback: Bool) {
        checkingID = nil; lastChecked = Date(); latestTag = native.tag
        guard Self.isNewer(native.version, than: BuildInfo.version) else {
            phase = .upToDate
            statusDetail = fallback ? "Your native macOS app is up to date; newer desktop releases do not include a native update." : "Up to date"
            return
        }
        release = native; phase = .available
        statusDetail = "\(native.tag) available — you're on v\(BuildInfo.version)"
        if !SelfUpdatePlan.isCleanReleaseCommit(BuildInfo.commit) {
            statusDetail += ". Automatic installation is paused for this development build; use Update to install explicitly."
        } else if failedVersion == native.version {
            statusDetail += ". Automatic retry is paused after a startup failure; use Update to retry."
        } else if fallback {
            statusDetail += ". This is the latest compatible native macOS release."
        }
        if SettingsStore.shared.autoUpdateEnabled, Bundle.main.bundleURL.pathExtension == "app",
           SelfUpdatePlan.automaticInstallAllowed(commit: BuildInfo.commit, version: native.version, failedVersion: failedVersion) {
            install(automatic: true)
        }
    }

    private func checkFailed(_ error: Error) {
        checkingID = nil; lastChecked = Date(); phase = .failed
        statusDetail = "Update check failed: \(error.localizedDescription)"
        updaterLog.error("release check failed: \(error.localizedDescription)")
    }

    static func isNewer(_ candidate: String, than current: String) -> Bool {
        SelfUpdatePlan.isNewer(candidate, than: current)
    }

    func install() { install(automatic: false) }
    private func install(automatic: Bool) {
        guard Thread.isMainThread else { main { self.install(automatic: automatic) }; return }
        guard phase == .available || phase == .failed, let release else { return }
        let destination = Bundle.main.bundleURL
        guard destination.pathExtension == "app" else {
            phase = .failed; statusDetail = "Self-update only works from an installed .app."; return
        }
        if automatic && !SelfUpdatePlan.automaticInstallAllowed(commit: BuildInfo.commit, version: release.version, failedVersion: failedVersion) { return }
        if !automatic { failedVersion = nil; try? FileManager.default.removeItem(at: failureReport) }
        phase = .downloading; statusDetail = "Downloading \(release.tag)…"
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let stage = try self.stage(release)
                defer { try? FileManager.default.removeItem(at: stage.root) }
                self.main { self.phase = .installing; self.statusDetail = "Installing \(release.tag)…" }
                // Create restart diagnostics before replacing any app files.
                try FileManager.default.createDirectory(at: self.failureReport.deletingLastPathComponent(), withIntermediateDirectories: true)
                let backup = try self.swap(stagedApp: stage.app, destination: destination, release: release)
                do {
                    try self.relaunch(destination: destination, backup: backup, release: release, commit: stage.commit)
                } catch {
                    let failed = destination.deletingLastPathComponent().appendingPathComponent(".TokenHorizon-failed-\(UUID().uuidString).app")
                    try SelfUpdateTransaction.restore(destination: destination, backup: backup, failedCopy: failed,
                                                      move: FileManager.default.moveItem)
                    try? FileManager.default.removeItem(at: failed)
                    throw error
                }
            } catch {
                updaterLog.error("update install failed: \(error.localizedDescription)")
                self.main { self.phase = .failed; self.statusDetail = "Update failed: \(error.localizedDescription)" }
            }
        }
    }

    private struct Stage { let root: URL; let app: URL; let commit: String }
    private func stage(_ release: SelfUpdateRelease) throws -> Stage {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("token-horizon-update-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        var staged = false
        defer { if !staged { try? fm.removeItem(at: root) } }
        let zipURL = root.appendingPathComponent(release.archiveName)
        let shaURL = root.appendingPathComponent("release.sha256")
        try download(release.archive, to: zipURL, expectedSize: release.archiveSize)
        try download(release.checksum, to: shaURL, expectedSize: release.checksumSize)
        let expected = try SelfUpdatePlan.checksum(String(contentsOf: shaURL, encoding: .utf8), archiveName: release.archiveName)
        let actual = try sha256(zipURL)
        guard expected == actual, release.archiveDigest == nil || release.archiveDigest == actual else {
            throw SelfUpdateFailure("The downloaded archive failed SHA-256 verification.")
        }
        try SelfUpdatePlan.validateArchivePaths(run("/usr/bin/unzip", ["-Z1", zipURL.path], maximumOutput: 8 * 1024 * 1024))
        let unpack = root.appendingPathComponent("unpack")
        try fm.createDirectory(at: unpack, withIntermediateDirectories: true)
        try run("/usr/bin/ditto", ["-x", "-k", zipURL.path, unpack.path])
        let app = unpack.appendingPathComponent("TokenHorizon.app")
        let commit = try validate(app: app, release: release)
        staged = true
        return Stage(root: root, app: app, commit: commit)
    }

    private func validate(app: URL, release: SelfUpdateRelease) throws -> String {
        let base = app.deletingLastPathComponent().resolvingSymlinksInPath()
            .appendingPathComponent(app.lastPathComponent).standardizedFileURL
        let executable = app.appendingPathComponent("Contents/MacOS/TokenHorizon")
        let plist = app.appendingPathComponent("Contents/Info.plist")
        let requiredExecutables = [executable,
            app.appendingPathComponent("Contents/Resources/token-horizon-gateway"),
            app.appendingPathComponent("Contents/Resources/th-engine"),
            app.appendingPathComponent("Contents/PlugIns/TokenHorizonWidget.appex/Contents/MacOS/TokenHorizonWidget")]
        guard base == app.resolvingSymlinksInPath().standardizedFileURL,
              (requiredExecutables + [plist]).allSatisfy({ $0.resolvingSymlinksInPath().path.hasPrefix(base.path + "/") }),
              requiredExecutables.allSatisfy({ FileManager.default.isExecutableFile(atPath: $0.path) }),
              let metadata = try PropertyListSerialization.propertyList(from: Data(contentsOf: plist), options: [], format: nil) as? [String: Any] else {
            throw SelfUpdateFailure("The archive is missing a valid native app, gateway, widget or TH Engine.")
        }
        let commit = try SelfUpdatePlan.validateBundleMetadata(metadata, version: release.version)
        try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        let currentSignature = try? run("/usr/bin/codesign", ["-d", "--verbose=4", Bundle.main.bundleURL.path])
        let downloadedSignature = try run("/usr/bin/codesign", ["-d", "--verbose=4", app.path])
        if let team = Self.teamIdentifier(currentSignature ?? ""), Self.teamIdentifier(downloadedSignature) != team {
            throw SelfUpdateFailure("The downloaded app has a different signing team from this installation.")
        }
        return commit
    }

    static func teamIdentifier(_ text: String) -> String? {
        guard let line = text.split(whereSeparator: \.isNewline).first(where: { $0.hasPrefix("TeamIdentifier=") }) else { return nil }
        let team = String(line.dropFirst("TeamIdentifier=".count))
        return team.isEmpty || team == "not set" || team == "notset" ? nil : team
    }

    private func swap(stagedApp: URL, destination: URL, release: SelfUpdateRelease) throws -> URL {
        let fm = FileManager.default, parent = destination.deletingLastPathComponent()
        guard fm.isWritableFile(atPath: parent.path) else {
            throw SelfUpdateFailure("Move Token Horizon to a writable Applications folder before updating.")
        }
        let prepared = parent.appendingPathComponent(".TokenHorizon-update-\(UUID().uuidString).app")
        defer { try? fm.removeItem(at: prepared) }
        try run("/usr/bin/ditto", [stagedApp.path, prepared.path])
        _ = try validate(app: prepared, release: release)
        let backup = parent.appendingPathComponent(destination.deletingPathExtension().lastPathComponent + ".backup.app")
        let previous = parent.appendingPathComponent(".TokenHorizon-previous-\(UUID().uuidString).app")
        try SelfUpdateTransaction.replace(prepared: prepared, destination: destination, backup: backup, previousBackup: previous,
            exists: { fm.fileExists(atPath: $0.path) }, move: fm.moveItem, remove: fm.removeItem)
        return backup
    }

    private func relaunch(destination: URL, backup: URL, release: SelfUpdateRelease, commit: String) throws {
        var service = ""
        if let data = try? Data(contentsOf: LaunchAgentCtl.plistURL()),
           let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
           SelfUpdatePlan.matchingLaunchAgent(plist, bundle: destination) {
            service = "gui/\(getuid())/\(LaunchAgentCtl.label)"
        }
        let failed = destination.deletingLastPathComponent().appendingPathComponent(".TokenHorizon-failed-\(UUID().uuidString).app")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = SelfUpdateRelaunch.arguments(pid: ProcessInfo.processInfo.processIdentifier,
            app: destination, backup: backup, failedCopy: failed, service: service,
            version: release.version, commit: commit, report: failureReport)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        main {
            self.phase = .relaunching; self.statusDetail = "Restarting and verifying \(release.tag)…"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
        }
    }

    private func fetchJSON(_ url: URL, completion: @escaping (Result<Any, Error>) -> Void) {
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("TokenHorizon/\(BuildInfo.version)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { data, response, error in
            let result: Result<Any, Error>
            do {
                if let error { throw error }
                guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                      http.url?.scheme == "https", http.url?.host == "api.github.com" else {
                    let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                    throw SelfUpdateFailure(code == 403 || code == 429 ? "GitHub rate limited this check. Try again later." : "GitHub returned HTTP \(code).")
                }
                guard let data, !data.isEmpty, data.count <= 2 * 1024 * 1024 else { throw SelfUpdateFailure("GitHub returned an invalid release response.") }
                result = .success(try JSONSerialization.jsonObject(with: data))
            } catch { result = .failure(error) }
            self.main { completion(result) }
        }.resume()
    }

    private final class DownloadState {
        let lock = NSLock(), semaphore = DispatchSemaphore(value: 0)
        var finished = false
        var result: Result<Void, Error>?
    }
    private final class DownloadGuard: NSObject, URLSessionDownloadDelegate {
        let maximum: Int64
        init(maximum: Int64) { self.maximum = maximum }
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(request.url.flatMap { SelfUpdatePlan.trustedDownloadURL($0) ? request : nil })
        }
        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
            if totalBytesWritten > maximum || totalBytesExpectedToWrite > maximum { downloadTask.cancel() }
        }
        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
    }

    private func download(_ url: URL, to destination: URL, expectedSize: Int64) throws {
        let delegate = DownloadGuard(maximum: expectedSize)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 120
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let state = DownloadState()
        let task = session.downloadTask(with: URLRequest(url: url, timeoutInterval: 120)) { temporary, response, error in
            state.lock.lock()
            defer { state.lock.unlock() }
            guard !state.finished else { return }
            do {
                if let error { throw error }
                guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                      let final = http.url, SelfUpdatePlan.trustedDownloadURL(final),
                      let temporary,
                      let size = try FileManager.default.attributesOfItem(atPath: temporary.path)[.size] as? NSNumber,
                      size.int64Value == expectedSize else { throw SelfUpdateFailure("The release download is incomplete or came from an unexpected host.") }
                try FileManager.default.moveItem(at: temporary, to: destination)
                state.result = .success(())
            } catch { state.result = .failure(error) }
            state.finished = true
            state.semaphore.signal()
        }
        task.resume()
        guard state.semaphore.wait(timeout: .now() + 130) == .success else {
            task.cancel()
            state.lock.lock(); state.finished = true; state.lock.unlock()
            throw SelfUpdateFailure("The release download timed out. Check your connection and try again.")
        }
        state.lock.lock(); let result = state.result; state.lock.unlock()
        guard let result else { throw SelfUpdateFailure("The release download did not finish.") }
        try result.get()
    }

    private func sha256(_ url: URL) throws -> String {
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        var digest = SHA256()
        while let bytes = try file.read(upToCount: 1024 * 1024), !bytes.isEmpty { digest.update(data: bytes) }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }

    @discardableResult
    private func run(_ path: String, _ arguments: [String], maximumOutput: Int = 65_536) throws -> String {
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("th-update-tool-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: output.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: output) }
        let file = try FileHandle(forWritingTo: output)
        defer { try? file.close() }
        let process = Process(), done = DispatchSemaphore(value: 0)
        process.executableURL = URL(fileURLWithPath: path); process.arguments = arguments
        process.standardOutput = file; process.standardError = file
        process.terminationHandler = { _ in done.signal() }
        try process.run()
        guard done.wait(timeout: .now() + 120) == .success else {
            process.terminate()
            if done.wait(timeout: .now() + 2) != .success { kill(process.processIdentifier, SIGKILL) }
            throw SelfUpdateFailure("\(URL(fileURLWithPath: path).lastPathComponent) timed out.")
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: output.path)
        guard ((attributes[.size] as? NSNumber)?.intValue ?? 0) <= maximumOutput else { throw SelfUpdateFailure("Update verification produced too much output.") }
        let data = try Data(contentsOf: output)
        guard process.terminationStatus == 0 else {
            throw SelfUpdateFailure("\(URL(fileURLWithPath: path).lastPathComponent) failed: \(String(data: data, encoding: .utf8)?.prefix(300) ?? "")")
        }
        return String(data: data, encoding: .utf8) ?? ""
    }
    private func main(_ action: @escaping () -> Void) { DispatchQueue.main.async(execute: action) }
}
