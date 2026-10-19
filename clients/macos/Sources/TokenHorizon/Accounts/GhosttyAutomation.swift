import AppKit
import Foundation

/// A surface, rather than a process: selecting it never sends text to its shell.
struct GhosttyTerminal: Identifiable, Codable, Equatable {
    let id: String
    let windowID: String
    let tabID: String
    let title: String
    let workingDirectory: String
    let windowTitle: String
    let tabTitle: String
    let isSelected: Bool
}

struct GhosttySession: Codable, Equatable {
    let windowID: String
    let tabID: String
    let terminalID: String
}

enum GhosttyDestination: String, CaseIterable, Identifiable {
    case window, tab
    var id: String { rawValue }
}

struct GhosttyLaunchRequest {
    var executable: String
    var arguments: [String] = []
    var environment: [String: String]
    var unsetEnvironment: [String] = []
    var workingDirectory: String
    var title: String
    var destination: GhosttyDestination = .window
    /// Ghostty leaves an exited terminal visible so authentication results remain readable.
    var keepOpenAfterExit: Bool = true
}

enum GhosttyError: LocalizedError, Equatable {
    case notInstalled
    case notRunning
    case automationDenied
    case scriptingUnavailable
    case terminalUnavailable
    case invalidRequest(String)
    case timedOut
    case invalidResponse
    case commandFailed

    var errorDescription: String? {
        switch self {
        case .notInstalled: return "Install Ghostty 1.3 or later to manage terminals."
        case .notRunning: return "Ghostty is not running. Launch an account to open a new window."
        case .automationDenied:
            return "Allow Token Horizon to control Ghostty in System Settings → Privacy & Security → Automation."
        case .scriptingUnavailable:
            return "Ghostty scripting is unavailable. Use Ghostty 1.3 or later and enable macos-applescript."
        case .terminalUnavailable: return "That Ghostty terminal has closed. Refresh the terminal list."
        case .invalidRequest(let reason): return reason
        case .timedOut: return "Ghostty did not respond in time. Check for a macOS Automation prompt and try again."
        case .invalidResponse: return "Ghostty returned an unreadable terminal list. Refresh and try again."
        case .commandFailed: return "Ghostty could not complete the action. Refresh and try again."
        }
    }

    /// Do not surface raw AppleScript errors: they can contain terminal titles or command arguments.
    static func commandError(_ message: String) -> GhosttyError {
        // Ghostty also uses -1743 when its own scripting setting is disabled.
        if message.localizedCaseInsensitiveContains("macos-applescript")
            || message.localizedCaseInsensitiveContains("scripting is disabled") {
            return .scriptingUnavailable
        }
        if message.contains("-1743") || message.localizedCaseInsensitiveContains("not authorized") {
            return .automationDenied
        }
        if message.contains("-1712") { return .timedOut }
        if message.contains("-1728") { return .terminalUnavailable }
        if message.contains("-1708") || message.contains("-2740") || message.contains("-2741") {
            return .scriptingUnavailable
        }
        if message.contains("-600") || message.contains("-609") { return .notRunning }
        return .commandFailed
    }
}

protocol GhosttyScriptRunning {
    func run(script: String, arguments: [String]) throws -> String
}

/// All methods that communicate with Ghostty are synchronous and must run off-main.
/// Inventory is explicit: calling it while Ghostty is stopped never starts the app.
final class GhosttyAutomation {
    static let bundleIdentifier = "com.mitchellh.ghostty"
    private let runner: GhosttyScriptRunning
    private let applicationURL: () -> URL?
    private let runningProbe: () -> Bool

    init(runner: GhosttyScriptRunning = GhosttyProcessRunner(),
         applicationURL: @escaping () -> URL? = {
             NSWorkspace.shared.urlForApplication(withBundleIdentifier: GhosttyAutomation.bundleIdentifier)
         },
         isRunning: @escaping () -> Bool = {
             !NSRunningApplication.runningApplications(withBundleIdentifier: GhosttyAutomation.bundleIdentifier).isEmpty
         }) {
        self.runner = runner
        self.applicationURL = applicationURL
        self.runningProbe = isRunning
    }

    var isInstalled: Bool { applicationURL() != nil }
    var isRunning: Bool { runningProbe() }
    var installedVersion: String? {
        guard let url = applicationURL(), let bundle = Bundle(url: url) else { return nil }
        return bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }

    func inventory() throws -> [GhosttyTerminal] {
        try requireInstallation()
        guard isRunning else { return [] }
        let output = try runner.run(script: GhosttyScriptPlan.inventoryScript, arguments: [])
        return try GhosttyScriptPlan.parseInventory(output)
    }

    func focus(terminalID: String) throws {
        guard UUID(uuidString: terminalID) != nil else {
            throw GhosttyError.invalidRequest("Choose a valid Ghostty terminal to focus.")
        }
        try requireInstallation()
        guard isRunning else { throw GhosttyError.notRunning }
        _ = try runner.run(script: GhosttyScriptPlan.focusScript, arguments: [terminalID])
    }

    func launch(_ request: GhosttyLaunchRequest) throws -> GhosttySession {
        let plan = try GhosttyScriptPlan.launch(request)
        try requireInstallation()
        let output = try runner.run(script: plan.script, arguments: plan.arguments)
        return try GhosttyScriptPlan.parseSession(output)
    }

    private func requireInstallation() throws {
        guard isInstalled else { throw GhosttyError.notInstalled }
        if let version = installedVersion,
           version.compare("1.3", options: .numeric) == .orderedAscending {
            throw GhosttyError.scriptingUnavailable
        }
    }
}

/// Captures to private temporary files, not pipes (wait-before-read can deadlock).
/// The timeout also bounds an unanswered Automation permission prompt.
struct GhosttyProcessRunner: GhosttyScriptRunning {
    var timeout: TimeInterval = 15

    func run(script: String, arguments: [String]) throws -> String {
        let manager = FileManager.default
        let directory = manager.temporaryDirectory.appendingPathComponent("th-ghostty-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true,
                                    attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: directory) }
        let stdoutURL = directory.appendingPathComponent("stdout")
        let stderrURL = directory.appendingPathComponent("stderr")
        manager.createFile(atPath: stdoutURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        manager.createFile(atPath: stderrURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let stdout = try FileHandle(forWritingTo: stdoutURL)
        let stderr = try FileHandle(forWritingTo: stderrURL)
        defer { try? stdout.close(); try? stderr.close() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script] + arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = stdout
        process.standardError = stderr
        let completed = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completed.signal() }
        do { try process.run() } catch { throw GhosttyError.commandFailed }
        guard completed.wait(timeout: .now() + max(0.1, timeout)) == .success else {
            if process.isRunning { process.terminate() }
            throw GhosttyError.timedOut
        }
        // Cap reads even when a future Ghostty version unexpectedly emits a large response.
        let output = try Self.readCapped(stdoutURL, limit: 2 * 1_024 * 1_024)
        guard process.terminationStatus == 0 else {
            let error = (try? Self.readCapped(stderrURL, limit: 16_384)) ?? ""
            throw GhosttyError.commandError(error)
        }
        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func readCapped(_ url: URL, limit: Int) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: limit + 1) ?? Data()
        guard data.count <= limit else { throw GhosttyError.invalidResponse }
        return String(decoding: data, as: UTF8.self)
    }
}
