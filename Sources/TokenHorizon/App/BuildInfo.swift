import Foundation
import TokenHorizonCore

/// Build identity. `scripts/make-app.sh` stamps the app's Info.plist with the
/// git commit + UTC build time (`THGitSHA` / `THBuiltAt`); unstamped runs
/// (e.g. `swift run` from a dirty tree) report "dev"/"unknown". The stamp is
/// surfaced in `/health`, the Settings tab, and the launch log line so a
/// stale binary can never again be mistaken for the current build.
enum BuildInfo {
    static func value(_ key: String, fallback: String) -> String {
        if let s = Bundle.main.infoDictionary?[key] as? String, !s.isEmpty { return s }
        return fallback
    }

    static var version: String { value("CFBundleShortVersionString", fallback: "0.2.0") }
    static var commit: String { value("THGitSHA", fallback: "dev") }
    static var builtAt: String { value("THBuiltAt", fallback: "unknown") }

    static var display: String { describe(version: version, commit: commit, builtAt: builtAt) }

    static func describe(version: String, commit: String, builtAt: String) -> String {
        "\(version) · \(commit) · \(builtAt)"
    }
}

/// Single-instance enforcement for the loopback API port.
///
/// History of confusion this prevents: `LocalServer` used to hop to
/// 8766–8784 when :8765 was taken, so two instances could run side by side —
/// the user looked at one while agents queried the other. Now :8765 is fixed
/// and newest launch wins: a duplicate of the same build exits quietly, a
/// different build takes over, and a bind that still fails is fatal (never a
/// silent dead server).
enum InstanceGuard {
    static let port: UInt16 = 8765

    enum Decision: Equatable {
        case proceed   // port free (or holder gone)
        case duplicate // holder runs our exact build — exit quietly
        case takeover  // holder runs something else — replace it
    }

    /// Pure decision core: nil/empty holder means proceed.
    static func decide(ourBuild: String, holderBuild: String?) -> Decision {
        guard let holder = holderBuild, !holder.isEmpty else { return .proceed }
        return holder == ourBuild ? .duplicate : .takeover
    }

    enum ClaimResult { case proceed, duplicate, conflict }

    /// Claim :8765 for this process. Blocking (short timeouts); call off-main
    /// when possible. Never returns with another live holder on the port.
    static func claimPort() -> ClaimResult {
        if let health = probeHolder(timeout: 1.0) {
            switch decide(ourBuild: BuildInfo.commit, holderBuild: holderBuild(health)) {
            case .duplicate:
                return .duplicate
            case .takeover:
                NSLog("TokenHorizon: taking over :8765 from build %@ (newest launch wins)",
                      holderBuild(health) ?? "?")
                terminateOthers()
                return waitForPortFree(timeout: 3.0) ? .proceed : .conflict
            case .proceed:
                return .proceed
            }
        }
        return .proceed
    }

    static func holderBuild(_ health: [String: Any]?) -> String? {
        (health?["build"] as? [String: Any])?["commit"] as? String
    }

    /// Raw /health dict from the current port holder, or nil when free.
    static func probeHolder(timeout: TimeInterval = 1.0) -> [String: Any]? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return nil }
        let r = HTTP.send(URLRequest(url: url, timeoutInterval: timeout), timeout: timeout)
        guard (200..<300).contains(r.status) else { return nil }
        return r.json
    }

    /// SIGTERM sibling TokenHorizon processes owned by this user, never self.
    /// Uses the temp-file capture pattern (no Pipe deadlock risk).
    static func terminateOthers() {
        let me = ProcessInfo.processInfo.processIdentifier
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("th-pgrep-\(UUID().uuidString).txt")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        guard let fh = FileHandle(forWritingAtPath: tmp.path) else { return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        proc.arguments = ["-x", "TokenHorizon"]
        proc.standardOutput = fh
        proc.standardError = FileHandle.nullDevice
        do { try proc.run(); proc.waitUntilExit() } catch {
            try? fh.close()
            try? FileManager.default.removeItem(at: tmp)
            return
        }
        try? fh.close()
        defer { try? FileManager.default.removeItem(at: tmp) }
        guard let text = try? String(contentsOf: tmp, encoding: .utf8) else { return }
        for line in text.split(separator: "\n") {
            guard let pid = Int32(line.trimmingCharacters(in: .whitespaces)), pid != me else { continue }
            let killer = Process()
            killer.executableURL = URL(fileURLWithPath: "/bin/kill")
            killer.arguments = [String(pid)]
            killer.standardOutput = FileHandle.nullDevice
            killer.standardError = FileHandle.nullDevice
            try? killer.run()
            killer.waitUntilExit()
        }
    }

    static func waitForPortFree(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if probeHolder(timeout: 0.5) == nil { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return probeHolder(timeout: 0.5) == nil
    }
}
