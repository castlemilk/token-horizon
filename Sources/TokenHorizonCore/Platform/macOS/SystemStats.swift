#if os(macOS)
import Foundation
#if canImport(Darwin)
import Darwin
<<<<<<<< HEAD:Sources/TokenHorizon/System/SystemStats.swift
#endif
#if canImport(IOKit)
import IOKit
#endif
import TokenHorizonCore
========
>>>>>>>> e0e1d59 (Organize TokenHorizonCore by concern; per-OS Platform folders):Sources/TokenHorizonCore/Platform/macOS/SystemStats.swift

// ProcSample, ProcDetail, SystemSnapshot, SystemIORates and the
// SystemStatsProviding protocol live in TokenHorizonCore (cross-platform).
// This enum is the macOS implementation of that protocol (mach, vm64, iostat, ps).

public enum SystemStats {
    public typealias Snapshot = SystemSnapshot
    public typealias IORates = SystemIORates

    static func cpuBrandString() -> String {
        var size = 0
        sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0)
        guard size > 0 else { return "Apple Silicon" }
        var cString = [CChar](repeating: 0, count: size)
        sysctlbyname("machdep.cpu.brand_string", &cString, &size, nil, 0)
        let str = String(cString: cString).trimmingCharacters(in: .whitespacesAndNewlines)
        return str.isEmpty ? "Apple Silicon" : str
    }

    private static var prevDisk: [Int32: (read: UInt64, write: UInt64, time: Date)] = [:]
    private static var prevMLXDisk: [Int32: (read: UInt64, write: UInt64, time: Date)] = [:]
    private static var prevNet: [Int32: (inB: UInt64, outB: UInt64, time: Date)] = [:]
    private static var netCache: [Int32: (inB: UInt64, outB: UInt64)] = [:]
    private static var netCacheTime: Date?
    private static let ioLock = NSLock()
    private static var ioCache = IORates()
    private static var ioCacheTime: Date?
    private static var previousIO: (diskMB: Double, netB: UInt64, time: Date)?

<<<<<<<< HEAD:Sources/TokenHorizon/System/SystemStats.swift
    static func processSamples() -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample]) {
========
    public static func processSamples() -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample]) {
        NSLog("processSamples start")
>>>>>>>> e0e1d59 (Organize TokenHorizonCore by concern; per-OS Platform folders):Sources/TokenHorizonCore/Platform/macOS/SystemStats.swift
        // Extended ps: pid, ppid, %cpu, rss, etime, user, comm
        // (macOS ps doesn't have nthreads/nlwp in standard column mode; we get threads
        // via task_threads mach API in processDetail for drill-down)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-axo", "pid=,ppid=,%cpu=,rss=,etime=,user=,comm="]
        guard let data = runCapture(task) else {
            return ([], [], [], [], [])
        }
        let now = Date()
        let netSnapshot = fetchNetSnapshot()
        var samples: [ProcSample] = []
        samples.reserveCapacity(512)
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            // 6 fixed fields: pid ppid cpu rss etime user, then the rest is comm
            let tokens = trimmed.split(separator: " ", omittingEmptySubsequences: true)
            guard tokens.count >= 6,
                  let pid = Int32(tokens[0]),
                  let ppid = Int32(tokens[1]),
                  let cpu = Double(tokens[2]),
                  let rssKB = Double(tokens[3]) else { continue }
            let etime = tokens[4]
            let user = String(tokens[5])
            let commRaw: String
            if tokens.count > 6 {
                commRaw = tokens[6...].joined(separator: " ")
            } else {
                commRaw = user
            }
            let name = (commRaw as NSString).lastPathComponent
            guard !name.isEmpty else { continue }
            let disk = diskRate(for: pid, now: now)
            let net = netRate(for: pid, snapshot: netSnapshot, now: now)
            samples.append(ProcSample(
                pid: pid, ppid: ppid, name: name, command: commRaw, user: user, threads: 0,
                cpu: cpu, memMB: rssKB / 1024,
                diskReadMBps: disk.read, diskWriteMBps: disk.write,
                netInKBps: net.inK, netOutKBps: net.outK,
                startTime: parseEtime(String(etime), now: now) ?? now
            ))
        }
        if samples.isEmpty {
            let mock = ProcSample(pid: 1, ppid: 0, name: "launchd", command: "/sbin/launchd", user: "root", threads: 0, cpu: 0.5, memMB: 100, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: now)
            return ([mock], [mock], [mock], [mock], [mock])
        }
        let byCPU = samples.sorted { $0.cpu > $1.cpu }
        let byMem = samples.sorted { $0.memMB > $1.memMB }
        let byDisk = samples.sorted { ($0.diskReadMBps + $0.diskWriteMBps) > ($1.diskReadMBps + $1.diskWriteMBps) }
        let byNet = samples.sorted { ($0.netInKBps + $0.netOutKBps) > ($1.netInKBps + $1.netOutKBps) }
        let livePids = Set(samples.map { $0.pid })
        prevDisk = prevDisk.filter { livePids.contains($0.key) }
        prevNet = prevNet.filter { livePids.contains($0.key) }
        if prevDisk.count > 500 { prevDisk.removeAll() }
        if prevNet.count > 500 { prevNet.removeAll() }
        return (samples,
                Array(byCPU.prefix(8)), Array(byMem.prefix(8)),
                Array(byDisk.prefix(8)), Array(byNet.prefix(8)))
    }

    /// Parse ps etime format (e.g. "5", "12:34", "1-02:34:56") into a start Date.
    private static func parseEtime(_ s: String, now: Date) -> Date? {
        var seconds: Int = 0
        if s.contains("-") {
            let parts = s.split(separator: "-", maxSplits: 1)
            if let days = Int(parts[0]) { seconds += days * 86400 }
            if parts.count == 2 { seconds += parseHms(String(parts[1])) }
        } else {
            seconds = parseHms(s)
        }
        guard seconds > 0 else { return nil }
        return now.addingTimeInterval(-Double(seconds))
    }

    private static func parseHms(_ s: String) -> Int {
        let parts = s.split(separator: ":").compactMap { Int($0) }
        switch parts.count {
        case 1: return parts[0]
        case 2: return parts[0] * 60 + parts[1]
        case 3: return parts[0] * 3600 + parts[1] * 60 + parts[2]
        default: return 0
        }
    }

    /// Build a tree representation of processes (children grouped under parents).
    /// Returns a flat ordered list with depth info suitable for indented tree display.
<<<<<<<< HEAD:Sources/TokenHorizon/System/SystemStats.swift
    static func buildProcessTree(_ procs: [ProcSample]) -> [(proc: ProcSample, depth: Int, hasChildren: Bool)] {
        // Index children by ppid (using effectiveParentPid to link detached Docker XPC services)
========
    public static func buildProcessTree(_ procs: [ProcSample]) -> [(proc: ProcSample, depth: Int, hasChildren: Bool)] {
        // Index children by ppid
>>>>>>>> e0e1d59 (Organize TokenHorizonCore by concern; per-OS Platform folders):Sources/TokenHorizonCore/Platform/macOS/SystemStats.swift
        var byParent: [Int32: [ProcSample]] = [:]
        for p in procs {
            let parentPid = DockerObserver.effectiveParentPid(for: p, in: procs)
            byParent[parentPid, default: []].append(p)
        }
        // Find roots (ppid 0 or ppid not in set)
        let pids = Set(procs.map { $0.pid })
        var roots = procs.filter {
            let parentPid = DockerObserver.effectiveParentPid(for: $0, in: procs)
            return parentPid == 0 || !pids.contains(parentPid)
        }
        // If no clear root (pid 1 is launchd), ensure launchd-like roots come first
        roots.sort { $0.pid < $1.pid }
        // DFS to build flat list
        var result: [(ProcSample, Int, Bool)] = []
        var visited = Set<Int32>()
        func visit(_ proc: ProcSample, depth: Int) {
            if visited.contains(proc.pid) { return }  // guard against cycles
            visited.insert(proc.pid)
            let children = byParent[proc.pid] ?? []
            let hasKids = !children.isEmpty
            result.append((proc, depth, hasKids))
            // Sort children by CPU descending so heavy children surface first
            let sortedChildren = children.sorted { $0.cpu > $1.cpu }
            for child in sortedChildren {
                visit(child, depth: depth + 1)
            }
        }
        for root in roots { visit(root, depth: 0) }
        return result
    }

    /// Lookup detailed info for a single PID (used by drill-down).
    public static func processDetail(pid: Int32) -> ProcDetail? {
        // Use ps with extra fields (no nthreads — macOS doesn't support it in ps column mode)
        let pipe = Pipe()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-p", String(pid), "-o", "pid=,ppid=,%cpu=,%mem=,rss=,vsz=,etime=,user=,state=,nice=,command="]
        task.standardOutput = pipe
        do { try task.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard let line = String(decoding: data, as: UTF8.self).split(separator: "\n").first.map(String.init) else { return nil }
        let parts = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        // Format: pid ppid cpu mem% rss vsz etime user state nice command...
        guard parts.count >= 10,
              let pidI = Int32(parts[0]),
              let ppidI = Int32(parts[1]),
              let cpu = Double(parts[2]),
              let memPct = Double(parts[3]),
              let rssKB = Double(parts[4]),
              let vszKB = Double(parts[5]) else { return nil }
        let etimeStr = parts[6]
        let user = parts[7]
        let state = parts[8]
        let nice = Int(parts[9]) ?? 0
        let command = parts.dropFirst(10).joined(separator: " ")
        let threads = machThreadCount(for: pid) ?? 0
        return ProcDetail(
            pid: pidI, ppid: ppidI, cpu: cpu, memPercent: memPct, memMB: rssKB / 1024,
            virtMB: vszKB / 1024, etime: etimeStr, user: user, threads: threads,
            state: state, nice: nice, command: command,
            openFiles: countOpenFiles(pid: pidI)
        )
    }

    /// Use mach task_threads to count threads for a PID.
    private static func machThreadCount(for pid: Int32) -> Int? {
        #if canImport(Darwin)
        var task: mach_port_t = 0
        let kr = task_for_pid(mach_task_self_, pid, &task)
        guard kr == KERN_SUCCESS else { return nil }
        defer { mach_port_deallocate(mach_task_self_, task) }
        var threadList: thread_act_array_t?
        var threadCount: mach_msg_type_number_t = 0
        let kr2 = task_threads(task, &threadList, &threadCount)
        guard kr2 == KERN_SUCCESS, let list = threadList else { return nil }
        let count = Int(threadCount)
        // Deallocate the thread ports (but not the array itself)
        let listSize = vm_size_t(threadCount) * vm_size_t(MemoryLayout<thread_act_t>.stride)
        vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: list)), listSize)
        return count
        #else
        return nil
        #endif
    }

    /// Count open file descriptors for a PID (used by drill-down).
    private static func countOpenFiles(pid: Int32) -> Int? {
        #if os(Windows)
        return nil
        #else
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        task.arguments = ["-p", String(pid), "-F", "n"]
        guard let data = runCapture(task) else { return nil }
        // Count lines starting with 'n'
        let str = String(decoding: data, as: UTF8.self)
        return str.split(separator: "\n").filter { $0.hasPrefix("n") }.count
        #endif
    }

    /// Send termination signal to a PID (used by drill-down kill button).
    @discardableResult
<<<<<<<< HEAD:Sources/TokenHorizon/System/SystemStats.swift
    static func killProcess(pid: Int32, signal: Int32 = 15) -> Bool {
        #if os(Windows)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "C:\\Windows\\System32\\taskkill.exe")
        task.arguments = signal == 9 ? ["/F", "/PID", String(pid)] : ["/PID", String(pid)]
        do {
            try task.run()
            task.waitUntilExit()
            return task.terminationStatus == 0
        } catch {
            return false
        }
        #elseif canImport(Darwin) || os(Linux)
========
    public static func killProcess(pid: Int32, signal: Int32 = SIGTERM) -> Bool {
>>>>>>>> e0e1d59 (Organize TokenHorizonCore by concern; per-OS Platform folders):Sources/TokenHorizonCore/Platform/macOS/SystemStats.swift
        return kill(pid, signal) == 0
        #else
        return false
        #endif
    }

    // Legacy wrapper for existing call sites
    public static func processSamplesLegacy() -> (byCPU: [ProcSample], byMem: [ProcSample]) {
        let r = processSamples()
        return (r.byCPU, r.byMem)
    }

    /// Narrow process sampling for MLX observability. This intentionally does
    /// not run nettop or populate the general process table.
    public static func mlxProcessSamples() -> [ProcSample] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-axo", "pid=,ppid=,%cpu=,rss=,etime=,user=,args="]
        guard let data = runCapture(task) else { return [] }

        struct Raw {
            public var pid: Int32
            public var ppid: Int32
            public var cpu: Double
            public var rssKB: Double
            public var etime: String
            public var user: String
            public var command: String
        }

        let now = Date()
        var raw: [Raw] = []
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            let tokens = line.trimmingCharacters(in: .whitespaces).split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard tokens.count >= 6,
                  let pid = Int32(tokens[0]),
                  let ppid = Int32(tokens[1]),
                  let cpu = Double(tokens[2]),
                  let rssKB = Double(tokens[3]) else { continue }
            raw.append(Raw(pid: pid, ppid: ppid, cpu: cpu, rssKB: rssKB,
                           etime: tokens[4], user: tokens[5],
                           command: tokens.dropFirst(6).joined(separator: " ")))
        }

        var included = Set(raw.filter { MLXObserver.isMLXCommand($0.command) }.map(\ .pid))
        var changed = true
        while changed {
            changed = false
            for process in raw where included.contains(process.ppid) && !included.contains(process.pid) {
                included.insert(process.pid)
                changed = true
            }
        }

        let livePids = Set(included)
        prevMLXDisk = prevMLXDisk.filter { livePids.contains($0.key) }
        return raw.filter { included.contains($0.pid) }.map { process in
            let disk = diskRate(for: process.pid, now: now, previous: &prevMLXDisk)
            return ProcSample(pid: process.pid, ppid: process.ppid,
                              name: (process.command as NSString).lastPathComponent,
                              command: process.command, user: process.user, threads: 0,
                              cpu: process.cpu, memMB: process.rssKB / 1024,
                              diskReadMBps: disk.read, diskWriteMBps: disk.write,
                              netInKBps: 0, netOutKBps: 0,
                              startTime: parseEtime(process.etime, now: now) ?? now)
        }.sorted {
            if $0.cpu != $1.cpu { return $0.cpu > $1.cpu }
            return $0.pid < $1.pid
        }
    }

    private static func diskRate(for pid: Int32, now: Date) -> (read: Double, write: Double) {
        diskRate(for: pid, now: now, previous: &prevDisk)
    }

    private static func diskRate(for pid: Int32, now: Date,
                                 previous: inout [Int32: (read: UInt64, write: UInt64, time: Date)]) -> (read: Double, write: Double) {
        var usage = rusage_info_v2()
        let status = withUnsafeMutablePointer(to: &usage) { ptr in
            // libproc declares the buffer as `rusage_info_t *` (void ** in the
            // Swift import). Rebind the struct's storage directly; do not pass
            // a pointer to a temporary pointer variable.
            return ptr.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
                proc_pid_rusage(Int32(pid), Int32(RUSAGE_INFO_V2), $0)
            }
        }
        guard status == 0 else {
            previous.removeValue(forKey: pid)
            return (0, 0)
        }

        let current = (read: usage.ri_diskio_bytesread, write: usage.ri_diskio_byteswritten)
        defer { previous[pid] = (current.read, current.write, now) }
        guard let prior = previous[pid] else { return (0, 0) }
        let dt = now.timeIntervalSince(prior.time)
        guard dt > 0.1 else { return (0, 0) }
        let read = Double(current.read >= prior.read ? current.read - prior.read : 0) / dt / 1_048_576
        let write = Double(current.write >= prior.write ? current.write - prior.write : 0) / dt / 1_048_576
        return (read, write)
    }

    private static func fetchNetSnapshot() -> [Int32: (inB: UInt64, outB: UInt64)] {
        // One CSV sample, process totals only. Unlike interactive nettop this exits
        // immediately and is cheap enough to run once per process refresh.
        if let cacheTime = netCacheTime, Date().timeIntervalSince(cacheTime) < 4.0 {
            return netCache
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/nettop")
        task.arguments = ["-P", "-L", "1", "-x", "-n"]
        task.standardError = FileHandle.nullDevice
        guard let data = runCapture(task) else { return netCache }

        let result = parseNetSnapshot(data)
        netCache = result
        netCacheTime = Date()
        return result
    }

    public static func parseNetSnapshot(_ data: Data) -> [Int32: (inB: UInt64, outB: UInt64)] {
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
        guard let headerIndex = lines.firstIndex(where: { $0.contains("bytes_in") }) else { return [:] }
        let header = lines[headerIndex].split(separator: ",", omittingEmptySubsequences: false).map(String.init)
        guard let inIndex = header.firstIndex(of: "bytes_in"),
              let outIndex = header.firstIndex(of: "bytes_out") else { return [:] }

        var result: [Int32: (inB: UInt64, outB: UInt64)] = [:]
        for line in lines.dropFirst(headerIndex + 1) {
            let fields = line.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
            guard fields.count > max(inIndex, outIndex),
                  let processField = fields.dropFirst().first,
                  let dot = processField.lastIndex(of: "."),
                  let pid = Int32(processField[processField.index(after: dot)...]),
                  let inBytes = UInt64(fields[inIndex].trimmingCharacters(in: .whitespacesAndNewlines)),
                  let outBytes = UInt64(fields[outIndex].trimmingCharacters(in: .whitespacesAndNewlines)) else { continue }
            result[pid] = (inBytes, outBytes)
        }
        return result
    }

    /// Capture short-lived command output without a Pipe. A temp file avoids
    /// pipe back-pressure/deadlock when the process list is large.
    private static func runCapture(_ task: Process) -> Data? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("token-horizon-")
            .appendingPathExtension(UUID().uuidString)
        guard FileManager.default.createFile(atPath: url.path, contents: nil),
              let output = FileHandle(forWritingAtPath: url.path) else { return nil }
        defer { try? FileManager.default.removeItem(at: url) }
        task.standardOutput = output
        do {
            try task.run()
            task.waitUntilExit()
            try? output.close()
        } catch {
            try? output.close()
            return nil
        }
        guard task.terminationStatus == 0 else { return nil }
        return try? Data(contentsOf: url)
    }

    private static func netRate(for pid: Int32, snapshot: [Int32: (inB: UInt64, outB: UInt64)], now: Date) -> (inK: Double, outK: Double) {
        guard let cur = snapshot[pid] else { return (0, 0) }
        defer { prevNet[pid] = (cur.inB, cur.outB, now) }
        guard let prev = prevNet[pid] else { return (0, 0) }
        let dt = now.timeIntervalSince(prev.time)
        guard dt > 0.1 else { return (0, 0) }
        let inRate = Double(cur.inB > prev.inB ? cur.inB - prev.inB : 0) / dt / 1024
        let outRate = Double(cur.outB > prev.outB ? cur.outB - prev.outB : 0) / dt / 1024
        return (inRate, outRate)
    }

    /// Read system-wide I/O counters on a short cache interval. This is much
    /// cheaper than retaining or rescanning per-process samples for history.
    public static func ioRates(now: Date = Date()) -> IORates {
        ioLock.lock()
        defer { ioLock.unlock() }
        if let cachedAt = ioCacheTime, now.timeIntervalSince(cachedAt) < 4 {
            return ioCache
        }

        let diskMB = diskTotalMB()
        let netB = interfaceNetworkBytes()
        defer {
            previousIO = (diskMB, netB, now)
            ioCacheTime = now
        }
        guard let previousIO else {
            ioCache = IORates()
            return ioCache
        }
        let seconds = now.timeIntervalSince(previousIO.time)
        guard seconds > 0.1 else { return ioCache }
        let diskDelta = max(0, diskMB - previousIO.diskMB)
        let netDelta = netB >= previousIO.netB ? netB - previousIO.netB : 0
        ioCache = IORates(
            diskMBps: diskDelta / seconds,
            netMBps: Double(netDelta) / seconds / 1_048_576
        )
        return ioCache
    }

    private static func diskTotalMB() -> Double {
        if let iokitMB = ioKitDiskTotalMB() {
            return iokitMB
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/iostat")
        task.arguments = ["-Id", "1", "1"]
        guard let data = runCapture(task) else { return 0 }
        return parseDiskTotalMB(data)
    }

<<<<<<<< HEAD:Sources/TokenHorizon/System/SystemStats.swift
    private static func ioKitDiskTotalMB() -> Double? {
        #if canImport(IOKit)
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOBlockStorageDriver"), &iterator) == KERN_SUCCESS else {
            return nil
        }
        defer { IOObjectRelease(iterator) }
        var totalBytes: UInt64 = 0
        var foundAny = false
        while case let driver = IOIteratorNext(iterator), driver != 0 {
            defer { IOObjectRelease(driver) }
            var unmanagedProps: Unmanaged<CFMutableDictionary>?
            if IORegistryEntryCreateCFProperties(driver, &unmanagedProps, kCFAllocatorDefault, 0) == KERN_SUCCESS,
               let dict = unmanagedProps?.takeRetainedValue() as? [String: Any],
               let stats = dict["Statistics"] as? [String: Any] {
                let read = (stats["Bytes (Read)"] as? NSNumber)?.uint64Value ?? 0
                let write = (stats["Bytes (Written)"] as? NSNumber)?.uint64Value ?? 0
                totalBytes += read + write
                foundAny = true
            }
        }
        guard foundAny else { return nil }
        return Double(totalBytes) / 1_048_576.0
        #else
        return nil
        #endif
    }

    static func parseDiskTotalMB(_ data: Data) -> Double {
========
    public static func parseDiskTotalMB(_ data: Data) -> Double {
>>>>>>>> e0e1d59 (Organize TokenHorizonCore by concern; per-OS Platform folders):Sources/TokenHorizonCore/Platform/macOS/SystemStats.swift
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
        for line in lines {
            let values = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).compactMap { Double($0) }
            guard values.count >= 3, values.count % 3 == 0 else { continue }
            return stride(from: 2, to: values.count, by: 3).reduce(0) { $0 + values[$1] }
        }
        return 0
    }

    private static func interfaceNetworkBytes() -> UInt64 {
        #if canImport(Darwin)
        var addressList: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addressList) == 0, let first = addressList else { return 0 }
        defer { freeifaddrs(first) }
        var total: UInt64 = 0
        var current: UnsafeMutablePointer<ifaddrs>? = first
        while let address = current {
            let flags = address.pointee.ifa_flags
            if flags & UInt32(IFF_LOOPBACK) == 0,
               let data = address.pointee.ifa_data {
                let stats = data.assumingMemoryBound(to: if_data.self).pointee
                total += UInt64(stats.ifi_ibytes) + UInt64(stats.ifi_obytes)
            }
            current = address.pointee.ifa_next
        }
        return total
        #else
        return 0
        #endif
    }

    private static var prevTicks: [Int64]?

    public static func snapshot() -> Snapshot {
        var s = Snapshot()
        s.cpuPercent = cpuUsage()
        s.loadAvg1 = loadAverage()
        (s.ramUsedGB, s.ramTotalGB) = memory()
        let io = ioRates()
        s.diskMBps = io.diskMBps
        s.netMBps = io.netMBps
        return s
    }

    private static func cpuUsage() -> Double {
        #if canImport(Darwin)
        var numCPUs: natural_t = 0
        var info: processor_info_array_t?
        var count: mach_msg_type_number_t = 0
        guard host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, &numCPUs, &info, &count) == KERN_SUCCESS,
              let ticks = info else { return 0 }
        defer {
            let size = vm_size_t(count) * vm_size_t(MemoryLayout<integer_t>.stride)
            vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: ticks)), size)
        }

        var current: [Int64] = []
        current.reserveCapacity(Int(numCPUs) * Int(CPU_STATE_MAX))
        for cpu in 0..<Int(numCPUs) {
            for state in 0..<Int(CPU_STATE_MAX) {
                current.append(Int64(ticks[cpu * Int(CPU_STATE_MAX) + state]))
            }
        }

        defer { prevTicks = current }
        guard let prev = prevTicks, prev.count == current.count else { return 0 }

        var busyDelta: Int64 = 0
        var totalDelta: Int64 = 0
        for cpu in 0..<Int(numCPUs) {
            let base = cpu * Int(CPU_STATE_MAX)
            let user = current[base + Int(CPU_STATE_USER)] - prev[base + Int(CPU_STATE_USER)]
            let sys = current[base + Int(CPU_STATE_SYSTEM)] - prev[base + Int(CPU_STATE_SYSTEM)]
            let nice = current[base + Int(CPU_STATE_NICE)] - prev[base + Int(CPU_STATE_NICE)]
            let idle = current[base + Int(CPU_STATE_IDLE)] - prev[base + Int(CPU_STATE_IDLE)]
            busyDelta += user + sys + nice
            totalDelta += user + sys + nice + idle
        }
        guard totalDelta > 0 else { return 0 }
        return Double(busyDelta) / Double(totalDelta) * 100
        #else
        return 0
        #endif
    }

    private static func loadAverage() -> Double {
        #if canImport(Darwin)
        var loads = [Double](repeating: 0, count: 3)
        guard getloadavg(&loads, 3) >= 1 else { return 0 }
        return loads[0]
        #else
        return 0
        #endif
    }

    private static func memory() -> (used: Double, total: Double) {
        let total = Double(ProcessInfo.processInfo.physicalMemory)
        #if canImport(Darwin)
        var stats = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        var pageSize: vm_size_t = 0
        host_page_size(mach_host_self(), &pageSize)

        let ok = withUnsafeMutablePointer(to: &stats) { ptr -> Bool in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) == KERN_SUCCESS
            }
        }
        guard ok else { return (0, total) }

        let page = Double(pageSize)
        // Activity Monitor formula: App Memory + Wired Memory + Compressed Memory
        // App Memory = (internal_page_count - purgeable_count)
        let appMemoryPages = max(0, Double(stats.internal_page_count) - Double(stats.purgeable_count))
        let wiredPages = Double(stats.wire_count)
        let compressedPages = Double(stats.compressor_page_count)
        let usedPages = appMemoryPages + wiredPages + compressedPages
        let usedBytes = usedPages * page
        return (usedBytes / 1_073_741_824, total / 1_073_741_824)
        #else
        return (0, total / 1_073_741_824)
        #endif
    }
}

// MARK: - Cross-platform protocol conformance (interface defined in TokenHorizonCore)
extension SystemStats: SystemStatsProviding {}

#endif // os(macOS)
