import Foundation

/// MITM capture mode: scoped TLS interception of AI vendor API traffic.
///
/// The TLS core is deliberately DELEGATED to mitmproxy (`mitmdump`), the
/// industry-standard tool for this — writing a TLS-intercepting proxy in
/// Swift would add a heavy dependency and a maintenance burden that belongs
/// upstream. This manager owns everything around it:
///
///   1. consent gate (.mitm — explicit user permission, never auto-granted)
///   2. detection (mitmdump on PATH or in Homebrew locations)
///   3. addon deployment (config dir; the addon carries the host allowlist
///      and the UsageEvent emission — see MitmAddonScript)
///   4. process lifecycle (spawn/monitor/stop, loopback-only listener)
///   5. setup checklist + remediation surfaced via `status` (GET /meters) —
///      privileged steps (CA trust, system proxy) are NEVER performed
///      silently; the user runs them or we flip user-level settings only.
///
/// SCOPING IS THE POINT: the addon passes every non-allowlisted TLS
/// connection through UNDECRYPTED (tls_clienthello ignore). Only AI vendor
/// API hosts (the same set the point-mode meters target) are intercepted.
/// Corporate machines should use point mode instead.
public final class MitmCaptureManager: MeterCapturing {
    public static let shared = MitmCaptureManager()

    public let mode: MeterCaptureMode = .mitm
    /// Loopback port the scoped proxy listens on.
    public var listenPort: UInt16 = 9871

    private let lock = NSLock()
    private var process: Process?

    public var configDir: URL {
        Platform.paths.configDirectory.appendingPathComponent("mitm")
    }
    public var addonPath: URL { configDir.appendingPathComponent("token_horizon_mitm.py") }
    public var caDir: URL { configDir.appendingPathComponent("ca") }
    public var caCertPath: URL { caDir.appendingPathComponent("mitmproxy-ca-cert.pem") }

    // MARK: - Detection

    /// mitmdump on PATH or in the usual Homebrew/MacPorts locations.
    public var mitmdumpPath: String? {
        let candidates = ["/opt/homebrew/bin/mitmdump", "/usr/local/bin/mitmdump",
                          "/opt/local/bin/mitmdump"]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) { return c }
        // PATH lookup via /usr/bin/which (no shell).
        let tmp = NSTemporaryDirectory() + "th-which-\(UUID().uuidString)"
        FileManager.default.createFile(atPath: tmp, contents: nil)
        guard let fh = FileHandle(forWritingAtPath: tmp) else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        p.arguments = ["mitmdump"]
        p.standardOutput = fh
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
        try? fh.close()
        let out = (try? String(contentsOfFile: tmp))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        try? FileManager.default.removeItem(atPath: tmp)
        return out.isEmpty ? nil : out
    }

    public var caGenerated: Bool {
        FileManager.default.fileExists(atPath: caCertPath.path)
    }

    /// Best-effort trust check: has the mitmproxy CA been added to a
    /// keychain (macOS) / the system CA store (Linux)?
    public var caTrusted: Bool {
        #if os(macOS)
        return runCapture("/usr/bin/security", ["find-certificate", "-c", "mitmproxy"])
            .contains("mitmproxy")
        #elseif os(Linux)
        return FileManager.default.fileExists(
            atPath: "/usr/local/share/ca-certificates/mitmproxy.crt")
        #else
        return false
        #endif
    }

    // MARK: - Lifecycle

    public func start() {
        lock.lock(); defer { lock.unlock() }
        guard process == nil else { return }
        guard ConsentManager.shared.isGranted(.mitm) else {
            log("mitm mode selected but .mitm consent not granted — proxy not started (TH_CONSENT=mitm to grant headless)")
            return
        }
        guard let mitmdump = mitmdumpPath else {
            log("mitm mode selected but mitmproxy is not installed — \(Self.remediationInstall)")
            return
        }
        do {
            try FileManager.default.createDirectory(at: caDir, withIntermediateDirectories: true)
            try MitmAddonScript.source.write(to: addonPath, atomically: true, encoding: .utf8)
        } catch {
            log("mitm: cannot deploy addon: \(error)")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: mitmdump)
        p.arguments = [
            "--listen-host", "127.0.0.1",
            "--listen-port", String(listenPort),
            "--scripts", addonPath.path,
            "--set", "confdir=\(caDir.path)",
            "--quiet",
        ]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            process = p
            Thread.detachNewThread { [weak self] in
                p.waitUntilExit()
                self?.lock.lock()
                self?.process = nil
                self?.lock.unlock()
            }
            log("mitm: scoped proxy started on 127.0.0.1:\(listenPort) — AI vendor hosts only")
        } catch {
            log("mitm: failed to launch mitmdump: \(error)")
        }
    }

    public func stop() {
        lock.lock()
        let p = process
        process = nil
        lock.unlock()
        p?.terminate()
    }

    public var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return process?.isRunning ?? false
    }

    // MARK: - Status / remediation

    /// Setup checklist for GET /meters. Every step the user must take is
    /// listed with its exact command — nothing privileged happens silently.
    public var status: [String: Any] {
        let consented = ConsentManager.shared.isGranted(.mitm)
        var steps: [String] = []
        if !consented { steps.append("grant consent: TH_CONSENT=mitm (or approve the prompt)") }
        if mitmdumpPath == nil { steps.append(Self.remediationInstall) }
        if mitmdumpPath != nil, !caGenerated {
            steps.append("start the proxy once to generate its CA (happens automatically on start)")
        }
        if caGenerated, !caTrusted { steps.append(Self.remediationTrust(caCert: caCertPath.path)) }
        return [
            "mode": mode.rawValue,
            "consented": consented,
            "mitmdump": mitmdumpPath ?? NSNull(),
            "running": isRunning,
            "listen": "127.0.0.1:\(listenPort)",
            "ca_generated": caGenerated,
            "ca_trusted": caTrusted,
            "scope": "AI vendor API hosts only; all other TLS passes through undecrypted",
            "next_steps": steps,
        ]
    }

    static var remediationInstall: String {
        #if os(macOS)
        return "install mitmproxy: brew install mitmproxy"
        #else
        return "install mitmproxy: see https://mitmproxy.org (e.g. pipx install mitmproxy)"
        #endif
    }

    static func remediationTrust(caCert: String) -> String {
        #if os(macOS)
        return "trust the CA (admin prompt): sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"\(caCert)\""
        #else
        return "trust the CA: sudo cp \"\(caCert)\" /usr/local/share/ca-certificates/mitmproxy.crt && sudo update-ca-certificates"
        #endif
    }

    private func runCapture(_ launch: String, _ args: [String]) -> String {
        let tmp = NSTemporaryDirectory() + "th-mitm-\(UUID().uuidString)"
        FileManager.default.createFile(atPath: tmp, contents: nil)
        guard let fh = FileHandle(forWritingAtPath: tmp) else { return "" }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launch)
        p.arguments = args
        p.standardOutput = fh
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            p.waitUntilExit()
            try? fh.close()
            defer { try? FileManager.default.removeItem(atPath: tmp) }
            return (try? String(contentsOfFile: tmp)) ?? ""
        } catch {
            try? fh.close()
            try? FileManager.default.removeItem(atPath: tmp)
            return ""
        }
    }

    private func log(_ message: String) {
        FileHandle.standardError.write("token-horizon: \(message)\n".data(using: .utf8)!)
    }
}
