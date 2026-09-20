import Foundation
#if os(Linux)
import Glibc
#elseif os(macOS)
import Darwin
#endif

/// Boot/login auto-start registration for the headless daemon.
///
/// The daemon must run as the LOGGED-IN USER — it reads per-user provider
/// credentials and writes per-user state — so every mechanism here is
/// user-scoped: systemd --user (+ linger for boot-before-login) on Linux,
/// LaunchAgent on macOS. Root-level services (system units, LaunchDaemons,
/// Windows SCM) are deliberately not used. Windows is unsupported: the
/// headless target is `#if !os(Windows)`.
public struct AutoStartStatus: Codable {
    /// This platform has a registration mechanism at all.
    public let supported: Bool
    /// "systemd-user" | "autostart-desktop" | "launchagent" | "unsupported"
    public let mechanism: String
    /// The unit/plist/desktop file is on disk.
    public let installed: Bool
    /// The service manager will start the daemon at boot/login.
    public let enabled: Bool
    /// The service manager reports the daemon active right now.
    public let running: Bool
    /// Human-readable detail (errors, linger state, fallback notes).
    public let detail: String

    public init(supported: Bool, mechanism: String, installed: Bool, enabled: Bool, running: Bool, detail: String) {
        self.supported = supported
        self.mechanism = mechanism
        self.installed = installed
        self.enabled = enabled
        self.running = running
        self.detail = detail
    }
}

public enum DaemonAutoStartError: Error, CustomStringConvertible {
    case unsupported(String)
    case commandFailed(String)

    public var description: String {
        switch self {
        case .unsupported(let m): return m
        case .commandFailed(let m): return m
        }
    }
}

public enum DaemonAutoStart {

    public static let label = "com.tokenhorizon.headless"
    public static let unitName = "token-horizon-headless.service"

    // MARK: - Public API

    public static func status() -> AutoStartStatus {
        #if os(macOS)
        return macStatus()
        #elseif os(Linux)
        return linuxStatus()
        #else
        return AutoStartStatus(supported: false, mechanism: "unsupported",
                               installed: false, enabled: false, running: false,
                               detail: "the headless daemon is not built for this platform (#if !os(Windows))")
        #endif
    }

    /// Register the currently-running binary to start at boot/login and start
    /// it now. Returns the resulting status; throws on hard failure.
    @discardableResult
    public static func install() throws -> AutoStartStatus {
        #if os(macOS)
        return try macInstall()
        #elseif os(Linux)
        return try linuxInstall()
        #else
        throw DaemonAutoStartError.unsupported("auto-start is not supported on this platform")
        #endif
    }

    /// De-register from boot/login. The running process is deliberately NOT
    /// stopped — it may be the caller (a daemon uninstalling itself would
    /// die mid-request before finishing cleanup). "Disabled + unit removed"
    /// means: will not start at next boot; keeps running until it exits.
    @discardableResult
    public static func uninstall() throws -> AutoStartStatus {
        #if os(macOS)
        return try macUninstall()
        #elseif os(Linux)
        return try linuxUninstall()
        #else
        throw DaemonAutoStartError.unsupported("auto-start is not supported on this platform")
        #endif
    }

    // MARK: - Shared helpers

    /// Absolute path of the running binary — what the service will execute.
    static func executablePath() -> String {
        #if os(Linux)
        if let resolved = try? FileManager.default.destinationOfSymbolicLink(atPath: "/proc/self/exe") {
            return resolved
        }
        #elseif os(macOS)
        var buffer = [CChar](repeating: 0, count: 4096)
        var size = UInt32(buffer.count)
        if _NSGetExecutablePath(&buffer, &size) == 0 {
            return String(cString: buffer)
        }
        #endif
        let arg0 = CommandLine.arguments[0]
        if arg0.hasPrefix("/") { return arg0 }
        return FileManager.default.currentDirectoryPath + "/" + arg0
    }

    /// Run a CLI, capturing stdout+stderr via a temp file (Pipe +
    /// readDataToEndOfFile deadlocks — see AGENTS.md invariant 8).
    /// Returns (exit code, combined output). Times out after 20s.
    @discardableResult
    static func run(_ launchPath: String, _ args: [String], extraEnv: [String: String] = [:]) -> (code: Int32, out: String) {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-autostart-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchPath)
        proc.arguments = args
        if !extraEnv.isEmpty {
            var env = ProcessInfo.processInfo.environment
            for (k, v) in extraEnv { env[k] = v }
            proc.environment = env
        }
        if let handle = try? FileHandle(forWritingTo: tmp) {
            proc.standardOutput = handle
            proc.standardError = handle
        }
        do { try proc.run() } catch { return (-1, "\(error)") }

        let deadline = Date().addingTimeInterval(20)
        while proc.isRunning && Date() < deadline { usleep(50_000) }
        if proc.isRunning {
            // SIGTERM is async — reading terminationStatus of a still-live
            // process traps (UD2 → SIGILL) in corelibs-foundation and takes
            // the whole daemon down. Grace period, SIGKILL escalation, and
            // only read the status once it actually exited.
            proc.terminate()
            let termDeadline = Date().addingTimeInterval(5)
            while proc.isRunning && Date() < termDeadline { usleep(50_000) }
            if proc.isRunning { killPID(proc.processIdentifier) }
            let killDeadline = Date().addingTimeInterval(5)
            while proc.isRunning && Date() < killDeadline { usleep(50_000) }
        }

        let out = (try? String(contentsOf: tmp, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // Guarded read: only an exited process has a status to report.
        let code: Int32 = proc.isRunning ? -1 : proc.terminationStatus
        return (code, out)
    }

    static func killPID(_ pid: Int32) {
        #if os(Linux)
        _ = Glibc.kill(pid, SIGKILL)
        #elseif os(macOS)
        _ = Darwin.kill(pid, SIGKILL)
        #else
        ()
        #endif
    }

    static func which(_ tool: String) -> String? {
        let (code, out) = run("/usr/bin/env", ["which", tool])
        guard code == 0, !out.isEmpty else { return nil }
        return out.components(separatedBy: "\n").first
    }
}

// MARK: - Pure generators (unit-tested)

extension DaemonAutoStart {
    static func systemdUnit(execPath: String) -> String {
        """
        [Unit]
        Description=Token Horizon headless usage daemon (loopback API on :8765)
        After=network-online.target

        [Service]
        ExecStart=\(execPath)
        Restart=on-failure
        RestartSec=5

        [Install]
        WantedBy=default.target

        """
    }

    static func autostartDesktop(execPath: String) -> String {
        """
        [Desktop Entry]
        Type=Application
        Name=Token Horizon daemon
        Comment=Token Horizon headless usage daemon (loopback API on :8765)
        Exec=\(execPath)
        Terminal=false
        X-GNOME-Autostart-enabled=true

        """
    }

    static func launchAgentPlist(label: String, execPath: String, logPath: String) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key><string>\(label)</string>
            <key>ProgramArguments</key>
            <array><string>\(execPath)</string></array>
            <key>RunAtLoad</key><true/>
            <key>KeepAlive</key><true/>
            <key>StandardOutPath</key><string>\(logPath)</string>
            <key>StandardErrorPath</key><string>\(logPath)</string>
        </dict>
        </plist>

        """
    }
}

// MARK: - Linux (systemd --user + linger; XDG autostart fallback)

#if os(Linux)
extension DaemonAutoStart {
    static var configHome: String {
        ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
            ?? NSHomeDirectory() + "/.config"
    }
    static var unitPath: String { configHome + "/systemd/user/" + unitName }
    static var desktopPath: String { configHome + "/autostart/token-horizon-headless.desktop" }

    /// systemctl/launcher env: a boot-started daemon (linger) has no session
    /// bus in its environment, but the user manager owns one at the
    /// predictable XDG_RUNTIME_DIR path.
    static func sessionEnv() -> [String: String] {
        let env = ProcessInfo.processInfo.environment
        let uid = getuid()
        var extra: [String: String] = [:]
        let runtime = env["XDG_RUNTIME_DIR"] ?? "/run/user/\(uid)"
        if env["XDG_RUNTIME_DIR"] == nil, FileManager.default.fileExists(atPath: runtime) {
            extra["XDG_RUNTIME_DIR"] = runtime
        }
        if env["DBUS_SESSION_BUS_ADDRESS"] == nil {
            extra["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=\(runtime)/bus"
        }
        return extra
    }

    static func linuxStatus() -> AutoStartStatus {
        let fm = FileManager.default
        if let systemctl = which("systemctl") {
            let env = sessionEnv()
            let installed = fm.fileExists(atPath: unitPath)
            let enabled = run(systemctl, ["--user", "is-enabled", unitName], extraEnv: env).code == 0
            let running = run(systemctl, ["--user", "is-active", unitName], extraEnv: env).code == 0
            let (_, lingerOut) = run(which("loginctl") ?? "/usr/bin/true", ["show-user", NSUserName(), "-p", "Linger"], extraEnv: env)
            let linger = lingerOut.contains("Linger=yes")
            return AutoStartStatus(supported: true, mechanism: "systemd-user",
                                   installed: installed, enabled: enabled, running: running,
                                   detail: linger
                                     ? "lingering enabled — starts at boot before login"
                                     : "starts at login; 'loginctl enable-linger $USER' for boot-before-login")
        }
        // Fallback: XDG desktop autostart (GUI login only, no service manager).
        let installed = fm.fileExists(atPath: desktopPath)
        return AutoStartStatus(supported: true, mechanism: "autostart-desktop",
                               installed: installed, enabled: installed, running: false,
                               detail: "no systemd — desktop autostart starts the daemon at graphical login only")
    }

    static func linuxInstall() throws -> AutoStartStatus {
        let fm = FileManager.default
        let exec = executablePath()
        if let systemctl = which("systemctl") {
            let env = sessionEnv()
            let dir = (unitPath as NSString).deletingLastPathComponent
            try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try systemdUnit(execPath: exec).write(toFile: unitPath, atomically: true, encoding: .utf8)
            var r = run(systemctl, ["--user", "daemon-reload"], extraEnv: env)
            guard r.code == 0 else { throw DaemonAutoStartError.commandFailed("daemon-reload: \(r.out)") }
            r = run(systemctl, ["--user", "enable", "--now", unitName], extraEnv: env)
            guard r.code == 0 else { throw DaemonAutoStartError.commandFailed("enable --now: \(r.out)") }
            // Boot-before-login: linger is best-effort (polkit may deny it).
            var detail = "systemd user service enabled and started"
            if let loginctl = which("loginctl") {
                let lr = run(loginctl, ["enable-linger", NSUserName()], extraEnv: env)
                detail += lr.code == 0
                    ? "; lingering enabled (starts at boot before login)"
                    : "; linger denied — starts at login only (\(lr.out))"
            }
            var s = linuxStatus()
            s = AutoStartStatus(supported: s.supported, mechanism: s.mechanism,
                                installed: s.installed, enabled: s.enabled,
                                running: s.running, detail: detail)
            return s
        }
        // Fallback for non-systemd Linux.
        let dir = (desktopPath as NSString).deletingLastPathComponent
        try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try autostartDesktop(execPath: exec).write(toFile: desktopPath, atomically: true, encoding: .utf8)
        return linuxStatus()
    }

    static func linuxUninstall() throws -> AutoStartStatus {
        let fm = FileManager.default
        if let systemctl = which("systemctl") {
            let env = sessionEnv()
            if fm.fileExists(atPath: unitPath) {
                // No --now: never stop the running process (see uninstall()).
                let r = run(systemctl, ["--user", "disable", unitName], extraEnv: env)
                guard r.code == 0 else { throw DaemonAutoStartError.commandFailed("disable: \(r.out)") }
                _ = run(systemctl, ["--user", "daemon-reload"], extraEnv: env)
            }
            try? fm.removeItem(atPath: unitPath)
            return linuxStatus()
        }
        try? fm.removeItem(atPath: desktopPath)
        return linuxStatus()
    }
}
#endif // os(Linux)

// MARK: - macOS (LaunchAgent, per-user, at login)

#if os(macOS)
extension DaemonAutoStart {
    static var plistPath: String {
        NSHomeDirectory() + "/Library/LaunchAgents/\(label).plist"
    }
    static var logPath: String {
        NSHomeDirectory() + "/Library/Logs/token-horizon/headless.log"
    }

    static func macStatus() -> AutoStartStatus {
        let installed = FileManager.default.fileExists(atPath: plistPath)
        // launchctl print exits 0 only when the agent is loaded.
        let running = installed
            && run("/bin/launchctl", ["print", "gui/\(getuid())/\(label)"]).code == 0
        return AutoStartStatus(supported: true, mechanism: "launchagent",
                               installed: installed, enabled: installed, running: running,
                               detail: installed
                                 ? "LaunchAgent — starts at login, kept alive"
                                 : "not installed")
    }

    static func macInstall() throws -> AutoStartStatus {
        let fm = FileManager.default
        let exec = executablePath()
        // Reload semantics: bootout first (ignore "not loaded" errors).
        _ = run("/bin/launchctl", ["bootout", "gui/\(getuid())/\(label)"])
        try fm.createDirectory(atPath: (plistPath as NSString).deletingLastPathComponent,
                               withIntermediateDirectories: true)
        try fm.createDirectory(atPath: (logPath as NSString).deletingLastPathComponent,
                               withIntermediateDirectories: true)
        try launchAgentPlist(label: label, execPath: exec, logPath: logPath)
            .write(toFile: plistPath, atomically: true, encoding: .utf8)
        var r = run("/bin/launchctl", ["bootstrap", "gui/\(getuid())", plistPath])
        if r.code != 0 {
            // Pre-modern macOS fallback.
            r = run("/bin/launchctl", ["load", "-w", plistPath])
        }
        guard r.code == 0 else {
            throw DaemonAutoStartError.commandFailed("launchctl bootstrap/load: \(r.out)")
        }
        return macStatus()
    }

    static func macUninstall() throws -> AutoStartStatus {
        // disable (not bootout): never kill the running process — it may be
        // the caller. Disabled + plist removed = no start at next login.
        _ = run("/bin/launchctl", ["disable", "gui/\(getuid())/\(label)"])
        try? FileManager.default.removeItem(atPath: plistPath)
        return macStatus()
    }
}
#endif // os(macOS)
