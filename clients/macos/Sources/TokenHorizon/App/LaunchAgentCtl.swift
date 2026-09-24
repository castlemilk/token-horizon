import Foundation

/// Self-management for crash auto-recovery. The installed app binary maintains
/// its own LaunchAgent — no repo scripts needed, so it works portably from
/// anywhere the .app bundle lives (`/Applications`, `~/Applications`, …).
/// Invoked via `--install-launch-agent` / `--uninstall-launch-agent` /
/// `--agent-status` before NSApplication starts (see main.swift).
///
/// The agent points at the RUNNING bundle's own binary and snapshots the
/// config env (TOKEN_HORIZON_* + auth overrides) into the plist, so a
/// supervised launch sees the same configuration as a direct shell launch.
enum LaunchAgentCtl {
    static let label = "local.benebsworth.token-horizon"

    /// Env allowlist baked into the agent plist (plus any TOKEN_HORIZON_*).
    static let forwardedPrefixes = ["TOKEN_HORIZON_"]
    static let forwardedKeys: Set<String> = [
        "OPENCODE_AUTH", "KIMI_HOME", "KIMI_CODE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
        "ALIBABA_TOKEN_PLAN_COOKIE", "ALIBABA_COOKIE_FILE", "ALIBABA_TOKEN_PLAN_HOST",
        "DEEPSEEK_API_KEY", "OPENAI_API_KEY",
        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT",
    ]

    static func forwardedEnvironment(_ env: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        env.filter { key, value in
            !value.isEmpty && (forwardedKeys.contains(key) || forwardedPrefixes.contains(where: key.hasPrefix))
        }
    }

    static func plistURL(home: URL? = nil) -> URL {
        let base = home ?? FileManager.default.homeDirectoryForCurrentUser
        return base.appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    static func appBinaryPath(bundleURL: URL? = nil) -> String {
        let bundle = bundleURL ?? Bundle.main.bundleURL
        return bundle.appendingPathComponent("Contents/MacOS/TokenHorizon").path
    }

    static func logPath(home: URL? = nil) -> URL {
        let base = home ?? FileManager.default.homeDirectoryForCurrentUser
        return base.appendingPathComponent("Library/Logs/TokenHorizon.log")
    }

    static func xmlEscaped(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for ch in s {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&apos;"
            default: out.append(ch)
            }
        }
        return out
    }

    /// Pure plist renderer (testable — no filesystem or launchctl involved).
    static func plist(appBinaryPath: String, logPath: String, environment: [String: String]) -> String {
        var envXML = ""
        for key in environment.keys.sorted() {
            envXML += "\t\t<key>\(xmlEscaped(key))</key><string>\(xmlEscaped(environment[key] ?? ""))</string>\n"
        }
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
        \t<key>Label</key><string>\(label)</string>
        \t<key>ProgramArguments</key><array><string>\(xmlEscaped(appBinaryPath))</string></array>
        \t<key>RunAtLoad</key><true/>
        \t<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
        \t<key>ThrottleInterval</key><integer>30</integer>
        \t<key>EnvironmentVariables</key><dict>
        \(envXML)\t</dict>
        \t<key>StandardOutPath</key><string>\(xmlEscaped(logPath))</string>
        \t<key>StandardErrorPath</key><string>\(xmlEscaped(logPath))</string>
        </dict>
        </plist>

        """
    }

    @discardableResult
    static func run(_ exe: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            p.waitUntilExit()
        } catch {
            return 1
        }
        return p.terminationStatus
    }

    static func install() -> Int32 {
        let bin = appBinaryPath()
        guard FileManager.default.isExecutableFile(atPath: bin) else {
            fputs("install-launch-agent: app binary not executable: \(bin)\n", stderr)
            return 1
        }
        let plistDest = plistURL()
        let content = plist(appBinaryPath: bin, logPath: logPath().path,
                            environment: forwardedEnvironment())
        do {
            try FileManager.default.createDirectory(at: plistDest.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try content.write(to: plistDest, atomically: true, encoding: .utf8)
        } catch {
            fputs("install-launch-agent: cannot write \(plistDest.path): \(error)\n", stderr)
            return 1
        }
        print("wrote \(plistDest.path)")
        _ = run("/bin/launchctl", ["unload", plistDest.path])
        if run("/bin/launchctl", ["load", plistDest.path]) != 0 {
            fputs("install-launch-agent: warning: launchctl load failed\n", stderr)
            return 1
        }
        print("loaded \(label) (crash auto-recovery active)")
        return status()
    }

    static func uninstall() -> Int32 {
        let plist = plistURL()
        _ = run("/bin/launchctl", ["unload", plist.path])
        try? FileManager.default.removeItem(at: plist)
        print("removed \(plist.path) (in-app login item, if enabled, is untouched)")
        return 0
    }

    /// Parse `launchctl list <label>` output: `"PID" = 1234;` when running.
    /// Pure (testable); nil means loaded-but-idle or unparseable.
    static func parseListPID(_ text: String) -> String? {
        guard text.contains(label) else { return nil }
        guard let m = text.range(of: #""PID" = (\d+);"#, options: .regularExpression) else { return nil }
        let digits = text[m].filter(\.isNumber)
        return digits.isEmpty ? nil : digits
    }
    /// One-line agent state for operators/scripts. Reads launchctl output via
    /// temp file (no Pipe deadlock pattern).
    static func status() -> Int32 {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("th-agent-status-\(UUID().uuidString).txt")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: tmp) }
        guard let fh = FileHandle(forWritingAtPath: tmp.path) else {
            print("agent \(label): status unknown (cannot capture launchctl)")
            return 1
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["list", label]
        p.standardOutput = fh
        p.standardError = FileHandle.nullDevice
        do { try p.run(); p.waitUntilExit() } catch {
            try? fh.close()
            print("agent \(label): not loaded")
            return 0
        }
        try? fh.close()
        guard p.terminationStatus == 0,
              let text = try? String(contentsOf: tmp, encoding: .utf8),
              text.contains(label) else {
            print("agent \(label): not loaded")
            return 0
        }
        if let pid = parseListPID(text) {
            print("agent \(label): loaded (pid=\(pid))")
        } else {
            print("agent \(label): loaded (idle)")
        }
        return 0
    }
}
