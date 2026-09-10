import Foundation

/// What the user is consenting to.
public enum ConsentScope: String, Codable, CaseIterable {
    case metering     // loopback request relays (RequestMeter listeners)
    case fileReading  // tailing provider log files / sqlite DBs
    case telemetry    // process detection + Prometheus scraping of local runtimes
}

/// A stored consent decision.
public struct ConsentRecord: Codable {
    public var granted: Bool
    public var at: Date
    /// Bumped when consent text/behavior changes → re-ask.
    public var version: Int

    public init(granted: Bool, at: Date = Date(), version: Int) {
        self.granted = granted
        self.at = at
        self.version = version
    }
}

/// Cross-platform consent manager. Nothing listens without an explicit grant:
/// consent is asked via the OS-native dialog (macOS osascript, Linux
/// zenity/kdialog, Windows PowerShell MessageBox), granted non-interactively
/// via TH_CONSENT=metering,fileReading,... (automation), or pre-seeded by
/// editing consents.json. Decisions persist in the config dir.
///
/// Headless/no-display environments NEVER auto-grant: the prompt commands
/// fail fast and ensure() returns the stored state (default: denied) with
/// instructions printed to stderr.
public final class ConsentManager {
    public static let shared = ConsentManager()

    /// Bump when prompt wording/behavior changes so users re-confirm.
    public static let consentVersion = 1

    private let lock = NSLock()
    private var records: [String: ConsentRecord] = [:]
    private let storeURL: URL

    public init(storeURL: URL? = nil) {
        let url = storeURL ?? Platform.paths.configDirectory
            .appendingPathComponent("consents.json")
        self.storeURL = url
        if let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode([String: ConsentRecord].self, from: data) {
            records = decoded
        }
    }

    // MARK: - Query

    /// True only with a stored, current-version grant (or env override).
    public func isGranted(_ scope: ConsentScope) -> Bool {
        if envGranted(scope) { return true }
        lock.lock(); defer { lock.unlock() }
        guard let record = records[scope.rawValue] else { return false }
        return record.granted && record.version == Self.consentVersion
    }

    /// Non-interactive grant via environment (CI, containers, systemd units):
    /// TH_CONSENT="metering,fileReading" or "all".
    private func envGranted(_ scope: ConsentScope) -> Bool {
        guard let value = ProcessInfo.processInfo.environment["TH_CONSENT"]?.lowercased() else { return false }
        let granted = value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        return granted.contains("all") || granted.contains(scope.rawValue.lowercased())
    }

    // MARK: - Grant / revoke

    public func grant(_ scope: ConsentScope) {
        set(scope, granted: true)
    }

    public func revoke(_ scope: ConsentScope) {
        set(scope, granted: false)
    }

    private func set(_ scope: ConsentScope, granted: Bool) {
        lock.lock()
        records[scope.rawValue] = ConsentRecord(granted: granted, version: Self.consentVersion)
        lock.unlock()
        persist()
    }

    private func persist() {
        lock.lock(); let snapshot = records; lock.unlock()
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? FileManager.default.createDirectory(
            at: storeURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: storeURL, options: .atomic)
        chmod(storeURL.path, 0o600)
    }

    // MARK: - Asking

    /// Ask the user (once) if no current decision exists. Returns the
    /// effective state. Never blocks forever: prompt helpers have timeouts.
    @discardableResult
    public func ensure(_ scope: ConsentScope, reason: String) -> Bool {
        if isGranted(scope) { return true }
        lock.lock()
        let hasDecision = records[scope.rawValue].map { $0.version == Self.consentVersion } ?? false
        lock.unlock()
        if hasDecision { return false }  // previously denied, current version

        guard let granted = prompt(scope: scope, reason: reason) else {
            FileHandle.standardError.write("""
            token-horizon: '\(scope.rawValue)' not enabled — no display to ask for consent.
            Grant non-interactively with: TH_CONSENT=\(scope.rawValue) (or 'all')

            """.data(using: .utf8)!)
            return false
        }
        set(scope, granted: granted)
        return granted
    }

    /// OS-native yes/no dialog. Nil = no display available (headless).
    private func prompt(scope: ConsentScope, reason: String) -> Bool? {
        let text = "Token Horizon requests permission: \(scope.rawValue)\n\n\(reason)"
        #if os(macOS)
        return runPrompt("/usr/bin/osascript", [
            "-e", "display dialog \"\(text)\" buttons {\"Deny\", \"Allow\"} default button \"Deny\" with title \"Token Horizon\""],
            stdoutMarker: "Allow")
        #elseif os(Linux)
        guard ProcessInfo.processInfo.environment["DISPLAY"] != nil
                || ProcessInfo.processInfo.environment["WAYLAND_DISPLAY"] != nil else { return nil }
        if let zenity = which("zenity") {
            return runPrompt(zenity, ["--question", "--title=Token Horizon",
                                      "--text=\(text)", "--ok-label=Allow", "--cancel-label=Deny",
                                      "--timeout=60"], exitZeroMeansGrant: true)
        }
        if let kdialog = which("kdialog") {
            return runPrompt(kdialog, ["--title", "Token Horizon", "--yesno", text],
                             exitZeroMeansGrant: true)
        }
        return nil
        #elseif os(Windows)
        let script = """
        Add-Type -AssemblyName System.Windows.Forms; \
        $r = [System.Windows.Forms.MessageBox]::Show('\(text.replacingOccurrences(of: "'", with: "''"))', \
        'Token Horizon', 'YesNo', 'Question'); if ($r -eq 'Yes') { exit 0 } else { exit 1 }
        """
        return runPrompt("powershell.exe", ["-NoProfile", "-Command", script],
                         exitZeroMeansGrant: true)
        #endif
    }

    private func which(_ tool: String) -> String? {
        let out = runCapture("/usr/bin/env", ["which", tool])
        return out.isEmpty ? nil : out
    }

    /// Prompt runner: exit-code semantics (zenity/kdialog/powershell).
    private func runPrompt(_ launch: String, _ args: [String], exitZeroMeansGrant: Bool) -> Bool? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launch)
        process.arguments = args
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch { return nil }
    }

    /// Prompt runner: parse stdout marker (osascript returns button name).
    private func runPrompt(_ launch: String, _ args: [String], stdoutMarker: String) -> Bool? {
        let out = runCapture(launch, args)
        return out.contains(stdoutMarker)
    }

    private func runCapture(_ launch: String, _ args: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launch)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return String(data: data, encoding: .utf8) ?? ""
        } catch { return "" }
    }
}
