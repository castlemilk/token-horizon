import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

struct DockerContainerSample: Identifiable, Codable, Equatable {
    var id: String            // short container ID (e.g. "dd7397b17b9c")
    var name: String          // container name (e.g. "sfh-e2e-backend-1")
    var image: String         // image (e.g. "sfh-e2e-backend")
    var cpu: Double           // CPU percent (e.g. 0.35)
    var memMB: Double         // Memory used in MB (e.g. 47.07)
    var memLimitMB: Double    // Memory limit in MB (e.g. 64686.08)
    var memPercent: Double    // Memory percent (e.g. 0.07)
    var netInMB: Double       // Net in MB
    var netOutMB: Double      // Net out MB
    var diskReadMB: Double    // Block read MB
    var diskWriteMB: Double   // Block write MB
    var pids: Int             // number of processes/threads in container
    var status: String        // "running", "Up 15 hours", etc.
    var ports: String         // e.g. "8480->8080"
}

/// Empty successes and failed attempts also back off; concurrent readers get
/// the last completed value instead of spawning another Docker CLI.
final class DockerSamplingCache {
    private let lock = NSLock()
    private let interval: TimeInterval
    private var sampling = false
    private var completedAt = Date.distantPast
    private var samples: [DockerContainerSample] = []

    init(interval: TimeInterval = 2.5) { self.interval = interval }

    func begin(now: Date = Date()) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !sampling, now.timeIntervalSince(completedAt) >= interval else { return false }
        sampling = true
        return true
    }

    func current() -> [DockerContainerSample] {
        lock.lock(); defer { lock.unlock() }
        return samples
    }

    @discardableResult
    func finish(_ next: [DockerContainerSample]?, now: Date = Date()) -> [DockerContainerSample] {
        lock.lock(); defer { lock.unlock() }
        if let next { samples = next }
        completedAt = now
        sampling = false
        return samples
    }
}

enum DockerObserver {
    private static let cache = DockerSamplingCache()
    static let collectionTimeout: TimeInterval = 3

    static func findDockerExecutable() -> String? {
        var candidates: [String] = []

        #if os(Windows)
        let programFiles = ProcessInfo.processInfo.environment["ProgramFiles"] ?? "C:\\Program Files"
        let programFilesX86 = ProcessInfo.processInfo.environment["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
        let localAppData = ProcessInfo.processInfo.environment["LOCALAPPDATA"] ?? ""
        let userProfile = ProcessInfo.processInfo.environment["USERPROFILE"] ?? ""
        candidates.append("\(programFiles)\\Docker\\Docker\\resources\\bin\\docker.exe")
        candidates.append("\(programFilesX86)\\Docker\\Docker\\resources\\bin\\docker.exe")
        candidates.append("C:\\ProgramData\\DockerDesktop\\version-bin\\docker.exe")
        if !localAppData.isEmpty {
            candidates.append("\(localAppData)\\Docker\\wsl\\docker.exe")
            candidates.append("\(localAppData)\\Programs\\Docker\\Docker\\resources\\bin\\docker.exe")
        }
        if !userProfile.isEmpty {
            candidates.append("\(userProfile)\\.docker\\bin\\docker.exe")
        }
        #else
        candidates.append("/opt/homebrew/bin/docker")
        candidates.append("/usr/local/bin/docker")
        candidates.append("/usr/bin/docker")
        candidates.append("/Applications/Docker.app/Contents/Resources/bin/docker")
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        candidates.append("\(home)/.docker/bin/docker")
        #endif

        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }

        // Search PATH environment variable for docker or docker.exe
        if let pathEnv = ProcessInfo.processInfo.environment["PATH"] {
            #if os(Windows)
            let separator: Character = ";"
            let exeNames = ["docker.exe", "docker.cmd", "docker.bat", "docker"]
            #else
            let separator: Character = ":"
            let exeNames = ["docker"]
            #endif

            for dir in pathEnv.split(separator: separator) {
                let dirStr = String(dir).trimmingCharacters(in: .whitespaces)
                guard !dirStr.isEmpty else { continue }
                for exe in exeNames {
                    let fullPath = (dirStr as NSString).appendingPathComponent(exe)
                    if FileManager.default.isExecutableFile(atPath: fullPath) {
                        return fullPath
                    }
                }
            }
        }

        return nil
    }

    /// Temp files avoid stdout pipe deadlocks. The deadline applies only to
    /// our spawned CLI process; it never stops a Docker daemon or container.
    static func runCapture(_ task: Process, timeout: TimeInterval = DockerObserver.collectionTimeout) -> Data? {
        guard timeout.isFinite, timeout > 0 else { return nil }
        let tempDir = FileManager.default.temporaryDirectory
        let tempFile = tempDir.appendingPathComponent("docker_stats_\(UUID().uuidString).tmp")
        FileManager.default.createFile(atPath: tempFile.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: tempFile) }
        guard let handle = FileHandle(forWritingAtPath: tempFile.path) else { return nil }
        defer { try? handle.close() }
        task.standardOutput = handle
        task.standardError = FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        task.terminationHandler = { _ in exited.signal() }
        do {
            try task.run()
            guard exited.wait(timeout: .now() + timeout) == .success else {
                if task.isRunning { task.terminate() }
                if exited.wait(timeout: .now() + 0.1) == .timedOut, task.isRunning {
                    #if canImport(Darwin) || canImport(Glibc)
                    // SIGKILL is restricted to this Process's child PID if
                    // its CLI ignored termination. No container APIs run.
                    _ = kill(task.processIdentifier, SIGKILL)
                    #endif
                }
                return nil
            }
            guard task.terminationStatus == 0 else { return nil }
            let data = try? Data(contentsOf: tempFile)
            return data
        } catch {
            return nil
        }
    }

    /// Sample running Docker containers with caching.
    static func sampleContainers() -> [DockerContainerSample] {
        guard cache.begin() else { return cache.current() }

        guard let dockerBin = findDockerExecutable() else { return cache.finish(nil) }
        let deadline = ProcessInfo.processInfo.systemUptime + collectionTimeout

        // 1. Fetch metadata (image, status, ports) via docker ps
        var metaMap: [String: (image: String, status: String, ports: String)] = [:]
        let psTask = Process()
        psTask.executableURL = URL(fileURLWithPath: dockerBin)
        psTask.arguments = ["ps", "--format", "{{json .}}"]
        if let psData = runCapture(psTask, timeout: min(1, collectionTimeout)) {
            metaMap = parsePsOutput(psData)
            // A successful empty ps result is authoritative. Avoid an extra
            // stats process (and its collection delay) with no containers.
            if metaMap.isEmpty { return cache.finish([]) }
        }

        // 2. Fetch live metrics via docker stats --no-stream
        let statsTask = Process()
        statsTask.executableURL = URL(fileURLWithPath: dockerBin)
        statsTask.arguments = ["stats", "--no-stream", "--format", "{{json .}}"]
        guard let statsData = runCapture(statsTask, timeout: deadline - ProcessInfo.processInfo.systemUptime)
        else { return cache.finish(nil) }

        let samples = parseStatsOutput(statsData, metadata: metaMap)

        return cache.finish(samples)
    }

    // MARK: - Parsing Helpers

    static func parsePsOutput(_ data: Data) -> [String: (image: String, status: String, ports: String)] {
        guard let text = String(data: data, encoding: .utf8) else { return [:] }
        var result: [String: (image: String, status: String, ports: String)] = [:]
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
        for line in lines {
            guard let lineData = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { continue }
            let id = (obj["ID"] as? String) ?? ""
            let image = (obj["Image"] as? String) ?? ""
            let status = (obj["Status"] as? String) ?? ""
            let ports = (obj["Ports"] as? String) ?? ""
            if !id.isEmpty {
                result[id] = (image, status, ports)
                // Also index short prefix if full hash was returned
                if id.count > 12 {
                    let short = String(id.prefix(12))
                    result[short] = (image, status, ports)
                }
            }
        }
        return result
    }

    static func parseStatsOutput(_ data: Data, metadata: [String: (image: String, status: String, ports: String)] = [:]) -> [DockerContainerSample] {
        guard let text = String(data: data, encoding: .utf8) else { return [] }
        var samples: [DockerContainerSample] = []
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
        for line in lines {
            guard let lineData = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { continue }

            let rawID = (obj["ID"] as? String) ?? (obj["Container"] as? String) ?? ""
            let id = rawID.count > 12 ? String(rawID.prefix(12)) : rawID
            let name = (obj["Name"] as? String) ?? ""
            let cpuStr = (obj["CPUPerc"] as? String) ?? "0%"
            let memUsageStr = (obj["MemUsage"] as? String) ?? ""
            let memPercStr = (obj["MemPerc"] as? String) ?? "0%"
            let netIOStr = (obj["NetIO"] as? String) ?? ""
            let blockIOStr = (obj["BlockIO"] as? String) ?? ""
            let pidsStr = (obj["PIDs"] as? String) ?? "0"

            let cpu = parsePercent(cpuStr)
            let (memUsed, memLimit) = parseSlashPairMB(memUsageStr)
            let memPerc = parsePercent(memPercStr)
            let (netIn, netOut) = parseSlashPairMB(netIOStr)
            let (diskRead, diskWrite) = parseSlashPairMB(blockIOStr)
            let pids = Int(pidsStr.trimmingCharacters(in: .whitespaces)) ?? 0

            let meta = metadata[id] ?? metadata[rawID] ?? ("", "", "")

            samples.append(DockerContainerSample(
                id: id,
                name: name,
                image: meta.image,
                cpu: cpu,
                memMB: memUsed,
                memLimitMB: memLimit,
                memPercent: memPerc,
                netInMB: netIn,
                netOutMB: netOut,
                diskReadMB: diskRead,
                diskWriteMB: diskWrite,
                pids: pids,
                status: meta.status,
                ports: meta.ports
            ))
        }
        return samples
    }

    static func parsePercent(_ s: String) -> Double {
        let cleaned = s.replacingOccurrences(of: "%", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        return Double(cleaned) ?? 0
    }

    /// Parse a single byte quantity with unit into MegaBytes (MB).
    /// Handles B, kB, KiB, MB, MiB, GB, GiB, TB, TiB, PB, PiB.
    static func parseBytesMB(_ s: String) -> Double {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "0B" || trimmed == "0" { return 0 }

        var numStr = ""
        var unitStr = ""
        for ch in trimmed {
            if (ch >= "0" && ch <= "9") || ch == "." {
                numStr.append(ch)
            } else {
                unitStr.append(ch)
            }
        }
        guard let val = Double(numStr) else { return 0 }
        let unit = unitStr.trimmingCharacters(in: .whitespaces).lowercased()
        switch unit {
        case "b":
            return val / (1024 * 1024)
        case "k", "kb", "kib":
            return val / 1024
        case "m", "mb", "mib":
            return val
        case "g", "gb", "gib":
            return val * 1024
        case "t", "tb", "tib":
            return val * 1024 * 1024
        case "p", "pb", "pib":
            return val * 1024 * 1024 * 1024
        default:
            return val
        }
    }

    /// Parse a "val / val" pair into (MB, MB).
    static func parseSlashPairMB(_ s: String) -> (Double, Double) {
        let parts = s.components(separatedBy: "/")
        guard parts.count == 2 else { return (0, 0) }
        return (parseBytesMB(parts[0]), parseBytesMB(parts[1]))
    }

    /// Role of a process within the Docker / container host ecosystem.
    enum ProcessRole: Equatable {
        case primaryVM       // The hypervisor VM or engine running containers (e.g. LinuxKit VM or dockerd)
        case backendDaemon   // Core background management daemon (e.g. com.docker.backend)
        case desktopHelper   // Auxiliary UI / helper / network / build process
        case cli             // User-invoked docker CLI command or shim
        case none
    }

    /// Classify a process into its role within the container ecosystem across macOS, Linux, and Windows.
    static func dockerRole(name: String, command: String) -> ProcessRole {
        let n = name.lowercased()
        let c = command.lowercased()

        // 1. Hypervisor / VM execution host (Apple Virtualization or Windows WSL2/Hyper-V vmmem)
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

        // 2. Core backend management daemon
        if n.contains("com.docker.backend") || c.contains("com.docker.backend") || n.contains("com.docker.service") {
            return .backendDaemon
        }

        // 3. Desktop helpers / UI / auxiliary
        if n.contains("docker desktop") || n.contains("com.docker.build") || n.contains("docker-agent") || n.contains("com.docker.vmnetd") || n.contains("com.docker.proxy") || c.contains("docker desktop") {
            return .desktopHelper
        }

        // 4. CLI / shims
        if n == "docker" || n == "docker.exe" || n == "docker-compose" || n == "docker-compose.exe" || n.contains("docker-shim") || n == "wsl.exe" || c.contains("bin/docker") || c.contains("bin\\docker") {
            return .cli
        }
        if n.contains("docker") || c.contains("docker") {
            return .desktopHelper
        }
        return .none
    }

    /// Check if a process belongs to the Docker or container runtime ecosystem.
    static func isDockerProcess(name: String, command: String) -> Bool {
        return dockerRole(name: name, command: command) != .none
    }

    /// Identify the single primary Docker runtime PID among active processes.
    /// This ensures container expanders are anchored only to the true container execution host,
    /// preventing duplicate expanders across auxiliary helper daemons.
    static func findPrimaryDockerPid(in processes: [ProcSample]) -> Int32? {
        // 1. Apple Virtualization VM or Windows WSL2/Hyper-V vmmem engine (highest RSS)
        let vms = processes.filter { p in
            let n = p.name.lowercased()
            let c = p.command.lowercased()
            return n == "com.apple.virtualization.virtualmachine" || c.contains("virtualization.virtualmachine")
                || n == "vmmem" || n == "vmmemwsl" || n == "vmmem.exe" || n == "vmmemwsl.exe" || n == "wslhost.exe" || c.contains("vmmem")
        }
        if let primaryVM = vms.max(by: { $0.memMB < $1.memMB }) {
            return primaryVM.pid
        }

        // 2. Primary virtualization daemon / standalone dockerd / orbctl / colima
        let primaryEngines = processes.filter { p in
            dockerRole(name: p.name, command: p.command) == .primaryVM
        }
        if let engine = primaryEngines.max(by: { $0.memMB < $1.memMB }) {
            return engine.pid
        }

        // 3. Fallback to main backend daemon
        let backends = processes.filter { p in
            dockerRole(name: p.name, command: p.command) == .backendDaemon
        }
        if let backend = backends.max(by: { $0.memMB < $1.memMB }) {
            return backend.pid
        }

        // 4. Any other Docker process with highest memory
        let anyDocker = processes.filter { isDockerProcess(name: $0.name, command: $0.command) }
        return anyDocker.max(by: { $0.memMB < $1.memMB })?.pid
    }

    /// Provide intelligent parent PID mapping to link detached Docker XPC / hypervisor services
    /// to their parent Docker virtualization / backend controller in the process tree.
    static func effectiveParentPid(for proc: ProcSample, in processes: [ProcSample]) -> Int32 {
        let n = proc.name.lowercased()
        let c = proc.command.lowercased()

        // macOS: If com.apple.Virtualization.VirtualMachine and launchd (PPID 1) is parent:
        if (n == "com.apple.virtualization.virtualmachine" || c.contains("virtualization.virtualmachine")) && proc.ppid <= 1 {
            // Link under com.docker.virtualization if active
            if let virt = processes.first(where: { $0.name.lowercased() == "com.docker.virtualization" || $0.command.lowercased().contains("com.docker.virtualization") }) {
                return virt.pid
            }
            // Or link under com.docker.backend
            if let backend = processes.first(where: { $0.name.lowercased() == "com.docker.backend" && ($0.ppid <= 1 || $0.command.contains("services")) }) {
                return backend.pid
            }
        }

        // Windows: If vmmem / vmmemWSL is running alongside Docker Desktop / com.docker.backend:
        if (n == "vmmem" || n == "vmmemwsl" || n == "vmmem.exe" || n == "vmmemwsl.exe" || n == "wslhost.exe" || c.contains("vmmem")) && proc.ppid <= 1 {
            if let backend = processes.first(where: { $0.name.lowercased().contains("com.docker.backend") || $0.name.lowercased().contains("docker desktop") }) {
                return backend.pid
            }
        }

        return proc.ppid
    }
}
