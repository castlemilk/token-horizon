import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// OS capabilities Token Horizon needs, probed live.
public enum Capability: String, Codable, CaseIterable {
    case networkListen      // bind loopback listeners (request meters, API server)
    case networkOutbound    // reach vendor APIs / runtime endpoints
    case localStorage       // read provider logs/DBs (~/.claude, opencode.db, ...)
    case processInspection  // enumerate processes (runtime detection)
}

/// Live status of one capability, with platform-specific remediation steps
/// the client can display when the capability is missing.
public struct CapabilityStatus: Codable {
    public var capability: String
    public var state: String        // granted | denied | unknown
    public var detail: String
    public var remediation: [String]

    public init(capability: Capability, state: String, detail: String, remediation: [String] = []) {
        self.capability = capability.rawValue
        self.state = state
        self.detail = detail
        self.remediation = remediation
    }
}

/// Probes OS capabilities and tells the user EXACTLY what to do at the
/// platform level when one is missing. Distinct from ConsentManager:
/// consent = "may we?" (user authorization), capabilities = "can we?"
/// (OS-enforced: TCC on macOS, confinement on Linux, firewall on Windows).
/// GET /permissions exposes this so any client can relay the instructions.
public enum PermissionManager {

    public static func status() -> [CapabilityStatus] {
        Capability.allCases.map { probe($0) }
    }

    public static func probe(_ capability: Capability) -> CapabilityStatus {
        switch capability {
        case .networkListen: return probeListen()
        case .networkOutbound: return probeOutbound()
        case .localStorage: return probeStorage()
        case .processInspection: return probeProcesses()
        }
    }

    // MARK: - Probes

    private static func probeListen() -> CapabilityStatus {
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        guard fd >= 0 else {
            return CapabilityStatus(capability: .networkListen, state: "unknown",
                                    detail: "socket() failed: errno \(errno)")
        }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0  // ephemeral
        addr.sin_addr = in_addr(s_addr: INADDR_LOOPBACK.bigEndian)
        let ok = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if ok == 0, listen(fd, 1) == 0 {
            return CapabilityStatus(capability: .networkListen, state: "granted",
                                    detail: "loopback bind+listen works")
        }
        return CapabilityStatus(capability: .networkListen, state: "denied",
                                detail: "bind/listen failed: errno \(errno)",
                                remediation: listenRemediation)
    }

    private static func probeOutbound() -> CapabilityStatus {
        if ProcessInfo.processInfo.environment["TH_OFFLINE"] == "1" {
            return CapabilityStatus(capability: .networkOutbound, state: "unknown",
                                    detail: "skipped (TH_OFFLINE=1)")
        }
        let hostStr = ProcessInfo.processInfo.environment["TH_PROBE_HOST"] ?? "1.1.1.1"
        let timeoutMs = Int(ProcessInfo.processInfo.environment["TH_PROBE_TIMEOUT_MS"] ?? "") ?? 800
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        guard fd >= 0 else {
            return CapabilityStatus(capability: .networkOutbound, state: "unknown",
                                    detail: "socket() failed: errno \(errno)")
        }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(443).bigEndian
        var ip = in_addr()
        guard inet_pton(AF_INET, hostStr, &ip) == 1 else {
            return CapabilityStatus(capability: .networkOutbound, state: "unknown",
                                    detail: "bad TH_PROBE_HOST")
        }
        addr.sin_addr = ip
        var flags = fcntl(fd, F_GETFL)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if result == 0 || errno == EINPROGRESS {
            var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
            if poll(&pfd, 1, Int32(timeoutMs)) > 0, pfd.revents & Int16(POLLOUT) != 0 {
                var err: Int32 = 0
                var len = socklen_t(MemoryLayout<Int32>.size)
                getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
                if err == 0 {
                    return CapabilityStatus(capability: .networkOutbound, state: "granted",
                                            detail: "TCP connect to \(hostStr):443 succeeded")
                }
            }
        }
        return CapabilityStatus(capability: .networkOutbound, state: "denied",
                                detail: "outbound connect failed: errno \(errno)",
                                remediation: outboundRemediation)
    }

    private static func probeStorage() -> CapabilityStatus {
        let home = Platform.paths.homeDirectory.path
        let candidates = ["\(home)/.claude", "\(home)/.codex", "\(home)/.kimi",
                          "\(home)/.local/share/opencode", "\(home)/.gemini"]
        var unreadable: [String] = []
        var found = 0
        let fm = FileManager.default
        for path in candidates {
            guard fm.fileExists(atPath: path) else { continue }  // vendor not installed — fine
            found += 1
            if fm.contents(atPath: path) == nil && (try? fm.contentsOfDirectory(atPath: path)) == nil {
                unreadable.append(path)
            }
        }
        if unreadable.isEmpty {
            return CapabilityStatus(capability: .localStorage, state: "granted",
                                    detail: found > 0 ? "\(found) provider dir(s) readable"
                                                      : "no provider dirs present (nothing to read)")
        }
        return CapabilityStatus(capability: .localStorage, state: "denied",
                                detail: "cannot read: \(unreadable.joined(separator: ", "))",
                                remediation: storageRemediation)
    }

    private static func probeProcesses() -> CapabilityStatus {
        let readable = FileManager.default
        #if os(Linux)
        let ok = readable.fileExists(atPath: "/proc/self/status")
        #else
        let ok = true  // ps/mach always available to the user session
        #endif
        return CapabilityStatus(capability: .processInspection,
                                state: ok ? "granted" : "denied",
                                detail: ok ? "process table readable" : "process table unavailable",
                                remediation: ok ? [] : processRemediation)
    }

    // MARK: - Remediation (per platform)

    private static var listenRemediation: [String] {
        #if os(macOS)
        return [
            "If the app is sandboxed: add the com.apple.security.network.server entitlement.",
            "Check System Settings → Network → Firewall: allow incoming connections for token-horizon (or your terminal).",
            "If 'Block all incoming connections' is on, loopback still works — re-run to confirm.",
        ]
        #elseif os(Linux)
        return [
            "Ports below 1024 require root: use high ports (default behavior) or `sudo setcap cap_net_bind_service=+ep` on the binary.",
            "Under snap/flatpak confinement, add the network-bind plug: `snap connect token-horizon:network-bind`.",
            "Check SELinux: `sudo ausearch -m avc -ts recent` for bind denials.",
        ]
        #else
        return [
            "Approve the Windows Defender Firewall prompt for token-horizon (Private networks suffice — listeners are loopback-only).",
            "Or: netsh advfirewall firewall add rule name=\"token-horizon\" dir=in action=allow program=<path>.",
        ]
        #endif
    }

    private static var outboundRemediation: [String] {
        #if os(macOS)
        return [
            "If sandboxed: add the com.apple.security.network.client entitlement.",
            "Check a content-filter / Little Snitch / Lulu rule blocking the process.",
        ]
        #elseif os(Linux)
        return [
            "Check egress firewall rules (ufw/nftables) and proxy env vars (HTTPS_PROXY).",
            "Under snap confinement: `snap connect token-horizon:network`.",
        ]
        #else
        return [
            "Allow token-horizon outbound in Windows Defender Firewall (allowed by default unless a deny rule exists).",
            "Check corporate proxy: set HTTPS_PROXY if required.",
        ]
        #endif
    }

    private static var storageRemediation: [String] {
        #if os(macOS)
        return [
            "System Settings → Privacy & Security → Files and Folders: grant access for the host app (or your terminal — TCC grants inherit).",
            "For ~/Library containers and Mail-style protected dirs: Full Disk Access may be required.",
            "If sandboxed: provider paths must be added as user-selected read-only files or the sandbox relaxed for these reads.",
        ]
        #elseif os(Linux)
        return [
            "Fix ownership/permissions on the provider dir (e.g. `chmod -R u+r ~/.claude`).",
            "Under snap: `snap connect token-horizon:home`; under flatpak: `flatpak override --filesystem=home`.",
            "If /home is encrypted and the daemon runs as another user, run it as your user or unlock the keyring mount.",
        ]
        #else
        return [
            "Check the provider directory ACLs (right-click → Properties → Security) for the daemon's user.",
            "Controlled Folder Access (Windows Security → Ransomware protection) may block reads — allow token-horizon.",
        ]
        #endif
    }

    private static var processRemediation: [String] {
        #if os(Linux)
        return [
            "If /proc is mounted with hidepid=2, run the daemon as the owning user or adjust the mount option.",
            "Inside containers, ensure the runtime processes share the PID namespace (--pid=host) if you want host detection.",
        ]
        #else
        return []
        #endif
    }
}
