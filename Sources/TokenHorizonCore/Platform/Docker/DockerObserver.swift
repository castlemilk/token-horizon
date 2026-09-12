import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif os(Windows)
import WinSDK
#endif

/// One Docker container's resource footprint.
public struct DockerContainerSample: Identifiable, Codable, Equatable {
    public var id: String
    public var name: String
    public var image: String
    public var cpu: Double
    public var memMB: Double
    public var memLimitMB: Double
    public var memPercent: Double
    public var netInMB: Double
    public var netOutMB: Double
    public var diskReadMB: Double
    public var diskWriteMB: Double
    public var pids: Int
    public var status: String
    public var ports: String

    public init(id: String, name: String = "", image: String = "", cpu: Double = 0,
                memMB: Double = 0, memLimitMB: Double = 0, memPercent: Double = 0,
                netInMB: Double = 0, netOutMB: Double = 0,
                diskReadMB: Double = 0, diskWriteMB: Double = 0,
                pids: Int = 0, status: String = "", ports: String = "") {
        self.id = id
        self.name = name
        self.image = image
        self.cpu = cpu
        self.memMB = memMB
        self.memLimitMB = memLimitMB
        self.memPercent = memPercent
        self.netInMB = netInMB
        self.netOutMB = netOutMB
        self.diskReadMB = diskReadMB
        self.diskWriteMB = diskWriteMB
        self.pids = pids
        self.status = status
        self.ports = ports
    }
}

/// Transport seam for the Docker Engine API. The default implementation talks
/// to the local Unix socket (no CLI dependency, works headless); tests and
/// remote daemons inject fakes. Generic over the transport — same pattern as
/// `UsageStoring` for analytics backends.
public protocol DockerTransport {
    func get(path: String) -> Data?
}

#if !os(Windows)
/// Docker Engine API over a Unix socket: `GET <path> HTTP/1.0` with a short
/// timeout and a bounded response cap. No dependencies beyond POSIX sockets.
public struct SocketDockerTransport: DockerTransport {
    public var socketPath: String
    public var timeout: TimeInterval
    public var maxBytes: Int

    public init(socketPath: String, timeout: TimeInterval = 2, maxBytes: Int = 8_388_608) {
        self.socketPath = socketPath
        self.timeout = timeout
        self.maxBytes = maxBytes
    }

    public func get(path: String) -> Data? {
        let fd = socket(AF_UNIX, Int32(SOCK_STREAM.rawValue), 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var tv = timeval(tv_sec: Int(timeout), tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8.prefix(MemoryLayout.size(ofValue: addr.sun_path) - 1))
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            bytes.withUnsafeBytes { src in
                if let base = src.baseAddress { memcpy(ptr, base, src.count) }
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, len)
            }
        }
        guard connected == 0 else { return nil }
        let request = "GET \(path) HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        let reqBytes = Array(request.utf8)
        var sent = 0
        while sent < reqBytes.count {
            let n = reqBytes.withUnsafeBytes { ptr in
                write(fd, ptr.baseAddress!.advanced(by: sent), reqBytes.count - sent)
            }
            guard n > 0 else { return nil }
            sent += n
        }
        var out = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while out.count < maxBytes {
            let n = chunk.withUnsafeMutableBytes { ptr -> Int in
                read(fd, ptr.baseAddress, ptr.count)
            }
            guard n > 0 else { break }
            out.append(contentsOf: chunk[0..<n])
        }
        guard let headEnd = out.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        return out[headEnd.upperBound...].isEmpty ? nil : Data(out[headEnd.upperBound...])
    }
}
#endif // !os(Windows)

#if os(Windows)
/// Docker Engine API over the Windows named pipe
/// (`\\.\pipe\docker_engine`, Docker Desktop default). Same HTTP framing as
/// the socket transport; fails fast when Docker is absent. No dependencies
/// beyond WinSDK.
public struct NamedPipeDockerTransport: DockerTransport {
    public var pipePath: String
    public var timeoutMs: DWORD
    public var maxBytes: Int

    public init(pipePath: String = #"\\.\pipe\docker_engine"#,
                timeoutMs: DWORD = 2000, maxBytes: Int = 8_388_608) {
        self.pipePath = pipePath
        self.timeoutMs = timeoutMs
        self.maxBytes = maxBytes
    }

    public func get(path: String) -> Data? {
        guard let handle = openHandle() else { return nil }
        defer { CloseHandle(handle) }
        let request = "GET \(path) HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        let reqBytes = Array(request.utf8)
        var written: DWORD = 0
        let wrote: Bool = reqBytes.withUnsafeBytes {
            WriteFile(handle, $0.baseAddress, DWORD($0.count), &written, nil)
        }
        guard wrote, written == DWORD(reqBytes.count) else { return nil }
        var out = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while out.count < maxBytes {
            var read: DWORD = 0
            let ok: Bool = chunk.withUnsafeMutableBytes {
                ReadFile(handle, $0.baseAddress, DWORD($0.count), &read, nil)
            }
            guard ok, read > 0 else { break }
            out.append(contentsOf: chunk[0..<Int(read)])
        }
        guard let headEnd = out.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        return out[headEnd.upperBound...].isEmpty ? nil : Data(out[headEnd.upperBound...])
    }

    private func openHandle() -> HANDLE? {
        let access: DWORD = GENERIC_READ | GENERIC_WRITE
        func open() -> HANDLE? {
            pipePath.withCString(encodedAs: UTF16.self) {
                CreateFileW($0, access, 0, nil, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nil)
            }
        }
        var handle = open()
        if handle == nil || handle == INVALID_HANDLE_VALUE {
            guard GetLastError() == ERROR_PIPE_BUSY else { return nil }
            let waited: Bool = pipePath.withCString(encodedAs: UTF16.self) {
                WaitNamedPipeW($0, timeoutMs)
            }
            guard waited else { return nil }
            handle = open()
        }
        guard let handle, handle != INVALID_HANDLE_VALUE else { return nil }
        return handle
    }
}
#endif // os(Windows)

/// Container telemetry via the local Docker Engine API.
///
/// Our way: Engine API over a local endpoint (Unix socket, Windows named
/// pipe — not CLI scraping), bounded (capped container count, short timeouts,
/// 2.5s result cache), injectable transport, platform-neutral endpoint
/// search. Call off-main; returns [] when Docker is absent.
public enum DockerObserver {
    private static let lock = NSLock()
    private static var cached: [DockerContainerSample] = []
    private static var cachedAt = Date.distantPast
    public static var cacheInterval: TimeInterval = 2.5
    public static var maxContainers = 32

    /// Injectable transport for tests (nil = auto-detect socket).
    public static var transportOverride: DockerTransport?

    public static func socketPaths() -> [String] {
        let home = Platform.paths.homeDirectory.path
        return [
            "/var/run/docker.sock",
            "\(home)/.docker/run/docker.sock",
        ]
    }

    public static func sampleContainers(now: Date = Date()) -> [DockerContainerSample] {
        lock.lock()
        if now.timeIntervalSince(cachedAt) < cacheInterval {
            let copy = cached
            lock.unlock()
            return copy
        }
        lock.unlock()
        let samples = fetch()
        lock.lock()
        cached = samples
        cachedAt = now
        lock.unlock()
        return samples
    }

    private static func transport() -> DockerTransport? {
        if let t = transportOverride { return t }
        #if os(Windows)
        return NamedPipeDockerTransport()
        #else
        for path in socketPaths() where FileManager.default.fileExists(atPath: path) {
            return SocketDockerTransport(socketPath: path)
        }
        return nil
        #endif
    }

    private static func fetch() -> [DockerContainerSample] {
        guard let t = transport(),
              let data = t.get(path: "/containers/json"),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        var out: [DockerContainerSample] = []
        for entry in list.prefix(maxContainers) {
            guard let id = entry["Id"] as? String else { continue }
            var sample = DockerContainerSample(
                id: String(id.prefix(12)),
                name: ((entry["Names"] as? [String])?.first ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                image: entry["Image"] as? String ?? "",
                status: entry["Status"] as? String ?? entry["State"] as? String ?? "")
            if let ports = entry["Ports"] as? [[String: Any]] {
                sample.ports = ports.compactMap { p -> String? in
                    guard let pub = p["PublicPort"] as? NSNumber, let priv = p["PrivatePort"] as? NSNumber else { return nil }
                    return "\(pub)->\(priv)"
                }.joined(separator: ",")
            }
            if let statsData = t.get(path: "/containers/\(id)/stats?stream=false&one-shot=true"),
               let stats = try? JSONSerialization.jsonObject(with: statsData) as? [String: Any] {
                applyStats(&sample, stats)
            }
            out.append(sample)
        }
        return out
    }

    // MARK: - Process-tree roles (pure, no I/O)

    /// Role of a process within the Docker / container host ecosystem.
    public enum ProcessRole: Equatable {
        case primaryVM
        case backendDaemon
        case desktopHelper
        case cli
        case none
    }

    /// Classify a process into its role within the container ecosystem
    /// across macOS, Linux, and Windows.
    public static func dockerRole(name: String, command: String) -> ProcessRole {
        let n = name.lowercased()
        let c = command.lowercased()
        if n == "com.apple.virtualization.virtualmachine" || c.contains("virtualization.virtualmachine") {
            return .primaryVM
        }
        if n == "vmmem" || n == "vmmemwsl" || n == "vmmem.exe" || n == "vmmemwsl.exe" || n == "wslhost.exe" || c.contains("vmmem") {
            return .primaryVM
        }
        if n == "com.docker.virtualization" || c.contains("com.docker.virtualization") {
            return .primaryVM
        }
        if n == "dockerd" || n == "dockerd.exe" || n == "containerd" || n == "containerd.exe" || n == "orbctl" || n == "colima" {
            return .primaryVM
        }
        if n.contains("com.docker.backend") || c.contains("com.docker.backend") || n.contains("com.docker.service") {
            return .backendDaemon
        }
        if n.contains("docker desktop") || n.contains("com.docker.build") || n.contains("docker-agent") || n.contains("com.docker.vmnetd") || n.contains("com.docker.proxy") || c.contains("docker desktop") {
            return .desktopHelper
        }
        if n == "docker" || n == "docker.exe" || n == "docker-compose" || n == "docker-compose.exe" || n.contains("docker-shim") || n == "wsl.exe" || c.contains("bin/docker") || c.contains("bin\\docker") {
            return .cli
        }
        if n.contains("docker") || c.contains("docker") {
            return .desktopHelper
        }
        return .none
    }

    /// Check if a process belongs to the Docker or container runtime ecosystem.
    public static func isDockerProcess(name: String, command: String) -> Bool {
        dockerRole(name: name, command: command) != .none
    }

    /// Identify the single primary Docker runtime PID among active processes.
    public static func findPrimaryDockerPid(in processes: [ProcSample]) -> Int32? {
        let vms = processes.filter { p in
            let n = p.name.lowercased()
            let c = p.command.lowercased()
            return n == "com.apple.virtualization.virtualmachine" || c.contains("virtualization.virtualmachine")
                || n == "vmmem" || n == "vmmemwsl" || n == "vmmem.exe" || n == "vmmemwsl.exe" || n == "wslhost.exe" || c.contains("vmmem")
        }
        if let primaryVM = vms.max(by: { $0.memMB < $1.memMB }) {
            return primaryVM.pid
        }
        let primaryEngines = processes.filter { p in
            dockerRole(name: p.name, command: p.command) == .primaryVM
        }
        if let engine = primaryEngines.max(by: { $0.memMB < $1.memMB }) {
            return engine.pid
        }
        let backends = processes.filter { p in
            dockerRole(name: p.name, command: p.command) == .backendDaemon
        }
        if let backend = backends.max(by: { $0.memMB < $1.memMB }) {
            return backend.pid
        }
        return nil
    }

    public static func effectiveParentPid(for proc: ProcSample, in processes: [ProcSample]) -> Int32 {
        let n = proc.name.lowercased()
        let c = proc.command.lowercased()
        if (n == "com.apple.virtualization.virtualmachine" || c.contains("virtualization.virtualmachine")) && proc.ppid <= 1 {
            if let virt = processes.first(where: { $0.name.lowercased() == "com.docker.virtualization" || $0.command.lowercased().contains("com.docker.virtualization") }) {
                return virt.pid
            }
            if let backend = processes.first(where: { $0.name.lowercased() == "com.docker.backend" && ($0.ppid <= 1 || $0.command.contains("services")) }) {
                return backend.pid
            }
        }
        if (n == "vmmem" || n == "vmmemwsl" || n == "vmmem.exe" || n == "vmmemwsl.exe" || n == "wslhost.exe" || c.contains("vmmem")) && proc.ppid <= 1 {
            if let backend = processes.first(where: { $0.name.lowercased().contains("com.docker.backend") || $0.name.lowercased().contains("docker desktop") }) {
                return backend.pid
            }
        }
        return proc.ppid
    }

    static func applyStats(_ sample: inout DockerContainerSample, _ stats: [String: Any]) {
        if let cpu = stats["cpu_stats"] as? [String: Any] {
            let total = (cpu["cpu_usage"] as? [String: Any]).flatMap { $0["total_usage"] as? NSNumber }?.uint64Value ?? 0
            let system = (cpu["system_cpu_usage"] as? NSNumber)?.uint64Value ?? 0
            let online = (cpu["online_cpus"] as? NSNumber)?.doubleValue ?? 1
            if let pre = stats["precpu_stats"] as? [String: Any] {
                let preTotal = (pre["cpu_usage"] as? [String: Any]).flatMap { $0["total_usage"] as? NSNumber }?.uint64Value ?? 0
                let preSystem = (pre["system_cpu_usage"] as? NSNumber)?.uint64Value ?? 0
                let cpuDelta = Double(total > preTotal ? total - preTotal : 0)
                let sysDelta = Double(system > preSystem ? system - preSystem : 0)
                if sysDelta > 0 { sample.cpu = cpuDelta / sysDelta * online * 100 }
            }
            sample.pids = (cpu["cpu_usage"] as? [String: Any]).flatMap { $0["percpu_usage"] as? [Any] }?.count ?? sample.pids
        }
        if let mem = stats["memory_stats"] as? [String: Any] {
            let used = (mem["usage"] as? NSNumber)?.doubleValue ?? 0
            let limit = (mem["limit"] as? NSNumber)?.doubleValue ?? 0
            sample.memMB = used / 1_048_576
            sample.memLimitMB = limit / 1_048_576
            if limit > 0 { sample.memPercent = used / limit * 100 }
        }
        if let pids = stats["pids_stats"] as? [String: Any],
           let current = (pids["current"] as? NSNumber)?.intValue {
            sample.pids = current
        }
        if let nets = stats["networks"] as? [String: Any] {
            var rx: Double = 0, tx: Double = 0
            for (_, v) in nets {
                if let iface = v as? [String: Any] {
                    rx += (iface["rx_bytes"] as? NSNumber)?.doubleValue ?? 0
                    tx += (iface["tx_bytes"] as? NSNumber)?.doubleValue ?? 0
                }
            }
            sample.netInMB = rx / 1_048_576
            sample.netOutMB = tx / 1_048_576
        }
        if let blk = stats["blkio_stats"] as? [String: Any],
           let entries = blk["io_service_bytes_recursive"] as? [[String: Any]] {
            var read: Double = 0, write: Double = 0
            for e in entries {
                let op = (e["op"] as? String ?? "").lowercased()
                let v = (e["value"] as? NSNumber)?.doubleValue ?? 0
                if op == "read" { read += v } else if op == "write" { write += v }
            }
            sample.diskReadMB = read / 1_048_576
            sample.diskWriteMB = write / 1_048_576
        }
    }
}
