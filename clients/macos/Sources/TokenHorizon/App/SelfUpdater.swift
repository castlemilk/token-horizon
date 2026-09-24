import AppKit
import os

private let updaterLog = Logger(subsystem: "com.tokenhorizon.app", category: "updater")

/// In-app self-updater: polls the GitHub releases API, compares semver,
/// downloads + verifies (sha256) the zip, swaps the .app bundle in place
/// (previous install parked as TokenHorizon.backup.app), and relaunches.
///
/// Auto mode (Settings → Updates): periodic checks install + relaunch
/// without prompting. Manual mode shows an Update button instead. Same
/// trust model as install.sh — HTTPS release assets + the published
/// .sha256 checksum verified before anything is replaced.
final class SelfUpdater: ObservableObject {
    static let shared = SelfUpdater()

    enum Phase: Equatable {
        case idle, checking, upToDate, available, downloading, installing, relaunching, failed
    }

    @Published var phase: Phase = .idle
    @Published var latestTag = ""          // "v0.3.7"
    @Published var statusDetail = ""       // human-readable line under the card
    @Published var lastChecked: Date?

    private let repo = "castlemilk/token-horizon"
    private var timer: Timer?

    // MARK: - scheduling

    /// Called once at app launch. First check ~20s in (let the network settle),
    /// then every 6h while the app runs.
    func start() {
        timer?.invalidate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            self?.check(manual: false)
        }
        timer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in
            self?.check(manual: false)
        }
    }

    // MARK: - check

    func check(manual: Bool) {
        guard phase == .idle || phase == .upToDate || phase == .available || phase == .failed || manual else { return }
        phase = .checking
        statusDetail = "checking for updates…"
        guard let url = URL(string: "https://api.github.com/repos/\(repo)/releases/latest") else { return }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { [weak self] data, _, error in
            guard let self else { return }
            DispatchQueue.main.async {
                self.lastChecked = Date()
                guard let data,
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let tag = obj["tag_name"] as? String, !tag.isEmpty
                else {
                    self.phase = .failed
                    self.statusDetail = "check failed\(error.map { ": \($0.localizedDescription)" } ?? "")"
                    updaterLog.error("release check failed: \(String(describing: error))")
                    return
                }
                self.latestTag = tag
                let latest = String(tag.drop(while: { $0 == "v" }))
                if Self.isNewer(latest, than: BuildInfo.version) {
                    self.phase = .available
                    self.statusDetail = "v\(latest) available"
                    updaterLog.notice("update available: v\(latest) (current v\(BuildInfo.version))")
                    if SettingsStore.shared.autoUpdateEnabled,
                       Bundle.main.bundleURL.pathExtension == "app" {
                        self.install()
                    }
                } else {
                    self.phase = .upToDate
                    self.statusDetail = "up to date"
                }
            }
        }.resume()
    }

    /// Strict numeric X.Y.Z comparison — prerelease/build suffixes ignored
    /// (release tags are always plain semver). Any non-numeric component
    /// makes the input malformed → not newer (a garbage tag must never
    /// trigger an auto-install).
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        func parts(_ s: String) -> [Int]? {
            var out: [Int] = []
            for comp in s.split(separator: ".", omittingEmptySubsequences: false) {
                let head = comp.split(separator: "-").first ?? ""
                guard !head.isEmpty, let n = Int(head) else { return nil }
                out.append(n)
            }
            return out.isEmpty ? nil : out
        }
        guard let c = parts(candidate), let v = parts(current) else { return false }
        for i in 0..<max(c.count, v.count) {
            let a = i < c.count ? c[i] : 0, b = i < v.count ? v[i] : 0
            if a != b { return a > b }
        }
        return false
    }

    // MARK: - install

    /// Download → verify sha256 → swap bundle in place → relaunch.
    /// Runs entirely off-main; @Published updates hop back to main.
    /// Re-entrant only from .available or .failed (retry) — never mid-flight.
    func install() {
        guard phase == .available || phase == .failed else { return }
        guard !latestTag.isEmpty else { return }
        // Only a real .app bundle can be swapped — a `swift run` / .build
        // dev binary lives in the build dir; moving it would be destructive.
        guard Bundle.main.bundleURL.pathExtension == "app" else {
            phase = .failed
            statusDetail = "self-update only works from an installed .app"
            return
        }
        let tag = latestTag
        let ver = String(tag.drop(while: { $0 == "v" }))
        phase = .downloading
        statusDetail = "downloading v\(ver)…"

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let stage = try self.stage(tag: tag, ver: ver)
                self.main { self.phase = .installing; self.statusDetail = "installing v\(ver)…" }
                try self.swap(stagedApp: stage.app, backupSuffix: ".backup")
                self.main { self.phase = .relaunching; self.statusDetail = "relaunching…" }
                try? FileManager.default.removeItem(at: stage.root)
                self.relaunch()
            } catch {
                updaterLog.error("update install failed: \(String(describing: error))")
                self.main {
                    self.phase = .failed
                    self.statusDetail = "update failed: \(error.localizedDescription)"
                }
            }
        }
    }

    private struct Stage { let root: URL; let app: URL }

    /// Fetch zip + published .sha256, verify, unpack. Throws on any mismatch.
    private func stage(tag: String, ver: String) throws -> Stage {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("token-horizon-update-\(ver)-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let base = "https://github.com/\(repo)/releases/download/\(tag)"
        let zipURL = root.appendingPathComponent("app.zip")
        let shaURL = root.appendingPathComponent("app.sha256")

        try download("\(base)/TokenHorizon-\(ver).zip", to: zipURL)
        try download("\(base)/TokenHorizon-\(ver).sha256", to: shaURL)

        // Verify the zip against the release's published checksum.
        let shaText = (try? String(contentsOf: shaURL, encoding: .utf8)) ?? ""
        let want = shaText.split(separator: "\n")
            .first { $0.hasSuffix(".zip") }?
            .split(separator: " ").first.map(String.init) ?? ""
        let got = shasum(zipURL)
        guard !want.isEmpty, got == want else {
            throw NSError(domain: "SelfUpdater", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "checksum mismatch (\(got.prefix(12))… ≠ \(want.prefix(12))…)"])
        }

        let unpack = root.appendingPathComponent("unpack")
        try FileManager.default.createDirectory(at: unpack, withIntermediateDirectories: true)
        try run("/usr/bin/ditto", ["-x", "-k", zipURL.path, unpack.path])
        let app = unpack.appendingPathComponent("TokenHorizon.app")
        guard FileManager.default.fileExists(atPath: app.appendingPathComponent("Contents/MacOS/TokenHorizon").path) else {
            throw NSError(domain: "SelfUpdater", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "archive missing TokenHorizon.app"])
        }
        return Stage(root: root, app: app)
    }

    /// Replace the RUNNING bundle at its own path (same trick as install.sh:
    /// previous copy parked as TokenHorizon.backup.app, then ditto, then
    /// strip quarantine). Works whether the app lives in /Applications,
    /// ~/Applications, or a custom install dir.
    private func swap(stagedApp: URL, backupSuffix: String) throws {
        let dest = Bundle.main.bundleURL
        let backup = dest.deletingLastPathComponent()
            .appendingPathComponent("TokenHorizon\(backupSuffix).app")
        try? FileManager.default.removeItem(at: backup)
        try FileManager.default.moveItem(at: dest, to: backup)
        do {
            try run("/usr/bin/ditto", [stagedApp.path, dest.path])
        } catch {
            // Roll back so we're not left app-less.
            try? FileManager.default.moveItem(at: backup, to: dest)
            throw error
        }
        _ = try? run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", dest.path])
    }

    /// Relaunch: detached shell opens the swapped bundle after we exit.
    /// Clean terminate does NOT trip the launch agent's SuccessfulExit=false
    /// KeepAlive, so we must open explicitly.
    private func relaunch() {
        let path = Bundle.main.bundleURL.path
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1; /usr/bin/open -n \"\(path)\""]
        try? p.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            NSApp.terminate(nil)
        }
    }

    // MARK: - helpers

    private func download(_ url: String, to dest: URL) throws {
        var done: Error?
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.downloadTask(with: URLRequest(url: URL(string: url)!, timeoutInterval: 120)) { tmp, resp, err in
            defer { sem.signal() }
            if let err { done = err; return }
            if let code = (resp as? HTTPURLResponse)?.statusCode, code != 200 {
                done = NSError(domain: "SelfUpdater", code: code,
                               userInfo: [NSLocalizedDescriptionKey: "HTTP \(code)"])
                return
            }
            guard let tmp else { done = NSError(domain: "SelfUpdater", code: -1); return }
            do { try FileManager.default.moveItem(at: tmp, to: dest) } catch { done = error }
        }.resume()
        _ = sem.wait(timeout: .now() + 130)
        if let done { throw done }
        guard FileManager.default.fileExists(atPath: dest.path) else {
            throw NSError(domain: "SelfUpdater", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "download timed out"])
        }
    }

    private func shasum(_ url: URL) -> String {
        (try? run("/usr/bin/shasum", ["-a", "256", url.path]))?
            .split(separator: " ").first.map(String.init) ?? ""
    }

    @discardableResult
    private func run(_ path: String, _ args: [String]) throws -> String {
        let p = Process()
        let out = Pipe()
        p.launchPath = path
        p.arguments = args
        p.standardOutput = out
        p.standardError = out
        try p.run()
        // Temp-file pattern would be needed for large output; ditto/shasum
        // emit only a few lines — pipe + drain before waitUntilExit is safe.
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            let tool = URL(fileURLWithPath: path).lastPathComponent
            let tail = String(data: data, encoding: .utf8)?.prefix(200) ?? ""
            throw NSError(domain: "SelfUpdater", code: Int(p.terminationStatus),
                          userInfo: [NSLocalizedDescriptionKey: "\(tool) exited \(p.terminationStatus): \(tail)"])
        }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func main(_ f: @escaping () -> Void) {
        DispatchQueue.main.async(execute: f)
    }
}
