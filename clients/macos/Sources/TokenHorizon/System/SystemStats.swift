import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
#if canImport(IOKit)
import IOKit
#endif

struct ProcSample: Equatable {
    var pid: Int32
    var ppid: Int32          // parent PID (for tree view)
    var name: String
    var command: String      // full command path (comm field from ps)
    var user: String         // effective user
    var threads: Int         // thread count
    var cpu: Double
    var memMB: Double
    var diskReadMBps: Double
    var diskWriteMBps: Double
    var netInKBps: Double
    var netOutKBps: Double
    var startTime: Date      // process start (for uptime)
}

/// Detailed info for a single PID (used by drill-down).
struct ProcDetail: Equatable, Identifiable {
    var pid: Int32
    var ppid: Int32
    var cpu: Double
    var memPercent: Double
    var memMB: Double
    var virtMB: Double
    var etime: String        // raw ps etime format
    var user: String
    var threads: Int
    var state: String        // R, S, D, Z, etc.
    var nice: Int
    var command: String
    var openFiles: Int?      // lsof count
    var id: Int32 { pid }
}

enum SystemStats {
    struct Snapshot {
        var cpuPercent: Double = 0
        var ramUsedGB: Double = 0
        var ramTotalGB: Double = 0
        var loadAvg1: Double = 0
        var diskMBps: Double = 0
        var netMBps: Double = 0
    }

    struct IORates {
        var diskMBps: Double = 0
        var netMBps: Double = 0
    }

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
    /// Serializes per-pid rate dictionaries (`prevDisk`/`prevNet`/`prevMLXDisk`).
    /// `processSamples()` runs from the 5s heavy tick AND from the `/processes`
    /// HTTP route on the server's concurrent queue; unguarded dictionary
    /// mutation there crashed the app (EXC_BAD_ACCESS in
    /// `_NativeDictionary.ensureUnique` inside `diskRate`).
    private static let procLock = NSLock()
    private static var ioCache = IORates()
    private static var ioCacheTime: Date?
    private static var previousIO: (diskMB: Double, netB: UInt64, time: Date)?

    static func processSamples() -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample]) {
        procLock.lock()
        defer { procLock.unlock() }
        return processSamplesLocked()
    }

    private static func processSamplesLocked() -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample]) {
        #if canImport(Darwin)
        return nativeProcessSamplesLocked()
        #else
        return ([], [], [], [], [])
        #endif
    }

    /// Per-pid cumulative CPU time (ns) at last sample — `ps %cpu` is a
    /// lifetime average; the delta reports what the process actually did
    /// since the previous tick, which is what "top CPU" is expected to show.
    private static var prevProcCPU: [Int32: (ns: UInt64, at: Date)] = [:]

    /// Fill `buf` with live pids; returns bytes written (or needed when the
    /// buffer was too small).
    private static func listAllPids(into buf: inout [pid_t]) -> Int32 {
        buf.withUnsafeMutableBufferPointer { ptr in
            proc_listpids(UInt32(PROC_ALL_PIDS), 0,
                          UnsafeMutableRawPointer(ptr.baseAddress),
                          Int32(ptr.count * MemoryLayout<pid_t>.size))
        }
    }
    /// uid → login name; getpwuid once per distinct user, not per process.
    private static var uidNames: [UInt32: String] = [:]

    /// Native process table — `proc_listpids` + 2 `proc_pidinfo` calls per
    /// pid replace the `/bin/ps` spawn+parse every tick (~30ms + ~500-line
    /// string churn → ~2ms of syscalls). `command` carries the exec comm
    /// name; rows surfaced in a top list get full argv via KERN_PROCARGS2.
    private static func nativeProcessSamplesLocked() -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample]) {
        var pidBuf = [pid_t](repeating: 0, count: 4096)
        var bytes = listAllPids(into: &pidBuf)
        if Int(bytes) >= pidBuf.count * MemoryLayout<pid_t>.size {
            // Buffer filled — table may be larger; size it from the return.
            pidBuf = [pid_t](repeating: 0, count: Int(bytes) / MemoryLayout<pid_t>.size + 256)
            bytes = listAllPids(into: &pidBuf)
        }
        let now = Date()
        guard bytes > 0 else {
            let mock = ProcSample(pid: 1, ppid: 0, name: "launchd", command: "/sbin/launchd", user: "root", threads: 0, cpu: 0.5, memMB: 100, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: now)
            return ([mock], [mock], [mock], [mock], [mock])
        }
        let netSnapshot = fetchNetSnapshot()
        var samples: [ProcSample] = []
        samples.reserveCapacity(512)
        for rawPid in pidBuf.prefix(Int(bytes) / MemoryLayout<pid_t>.size) where rawPid > 0 {
            let pid = Int32(rawPid)
            var bsd = proc_bsdinfo()
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd,
                               Int32(MemoryLayout<proc_bsdinfo>.size)) > 0 else { continue }
            var task = proc_taskinfo()
            let taskOK = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task,
                                      Int32(MemoryLayout<proc_taskinfo>.size)) > 0
            let name = fixedCString(&bsd.pbi_name)
            let comm = fixedCString(&bsd.pbi_comm)
            let display = !name.isEmpty ? name : comm
            guard !display.isEmpty else { continue }
            let user = uidNames[bsd.pbi_uid] ?? {
                let s = getpwuid(bsd.pbi_uid).flatMap { $0.pointee.pw_name.map { String(cString: $0) } }
                    ?? "\(bsd.pbi_uid)"
                uidNames[bsd.pbi_uid] = s
                return s
            }()
            let start = Date(timeIntervalSince1970: Double(bsd.pbi_start_tvsec) + Double(bsd.pbi_start_tvusec) / 1e6)
            let cpu = cpuPercent(for: pid, taskNs: taskOK ? task.pti_total_user &+ task.pti_total_system : 0,
                                 start: start, now: now)
            let disk = diskRate(for: pid, now: now)
            let net = netRate(for: pid, snapshot: netSnapshot, now: now)
            samples.append(ProcSample(
                pid: pid, ppid: Int32(bitPattern: bsd.pbi_ppid), name: display, command: display,
                user: user, threads: taskOK ? Int(task.pti_threadnum) : 0,
                cpu: cpu, memMB: taskOK ? Double(task.pti_resident_size) / 1_048_576 : 0,
                diskReadMBps: disk.read, diskWriteMBps: disk.write,
                netInKBps: net.inK, netOutKBps: net.outK,
                startTime: start > now ? now : start
            ))
        }
        guard !samples.isEmpty else {
            let mock = ProcSample(pid: 1, ppid: 0, name: "launchd", command: "/sbin/launchd", user: "root", threads: 0, cpu: 0.5, memMB: 100, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: now)
            return ([mock], [mock], [mock], [mock], [mock])
        }
        let livePids = Set(samples.map(\.pid))
        prevDisk = prevDisk.filter { livePids.contains($0.key) }
        prevNet = prevNet.filter { livePids.contains($0.key) }
        prevProcCPU = prevProcCPU.filter { livePids.contains($0.key) }
        if prevDisk.count > 500 { prevDisk.removeAll() }
        if prevNet.count > 500 { prevNet.removeAll() }
        if prevProcCPU.count > 2000 { prevProcCPU.removeAll() }

        // Full argv only for rows a user can see — one sysctl per visible
        // pid instead of a table-wide args fetch (~500 × ~100µs).
        var tops: Set<Int32> = []
        for p in top8(samples, by: { $0.cpu > $1.cpu })
                 + top8(samples, by: { $0.memMB > $1.memMB })
                 + top8(samples, by: { $0.diskReadMBps + $0.diskWriteMBps > $1.diskReadMBps + $1.diskWriteMBps })
                 + top8(samples, by: { $0.netInKBps + $0.netOutKBps > $1.netInKBps + $1.netOutKBps }) {
            tops.insert(p.pid)
        }
        var argvMap: [Int32: String] = [:]
        for pid in tops { if let a = processArgs(for: pid) { argvMap[pid] = a } }
        if !argvMap.isEmpty {
            for i in samples.indices { if let a = argvMap[samples[i].pid] { samples[i].command = a } }
        }
        return (samples,
                top8(samples, by: { $0.cpu > $1.cpu }),
                top8(samples, by: { $0.memMB > $1.memMB }),
                top8(samples, by: { $0.diskReadMBps + $0.diskWriteMBps > $1.diskReadMBps + $1.diskWriteMBps }),
                top8(samples, by: { $0.netInKBps + $0.netOutKBps > $1.netInKBps + $1.netOutKBps }))
    }

    /// Recent-window CPU% for one pid: cumulative task ns delta / wall delta.
    /// First-seen pids fall back to the lifetime average (ps %cpu semantics).
    /// A failed taskinfo read (taskNs=0) clears the baseline instead of
    /// recording it, so the next good sample doesn't report the entire
    /// cumulative time as one delta spike.
    private static func cpuPercent(for pid: Int32, taskNs: UInt64, start: Date, now: Date) -> Double {
        defer { prevProcCPU[pid] = taskNs > 0 ? (ns: taskNs, at: now) : nil }
        if let prev = prevProcCPU[pid] {
            let wall = now.timeIntervalSince(prev.at)
            if wall > 0.05, taskNs >= prev.ns {
                return Double(taskNs - prev.ns) / wall / 1e7
            }
            return 0
        }
        let lifetime = now.timeIntervalSince(start)
        guard lifetime > 1 else { return 0 }
        return Double(taskNs) / 1e9 / lifetime * 100
    }

    /// `char[N]`-as-tuple C buffers → String (stops at the first NUL).
    private static func fixedCString<T>(_ tuple: inout T) -> String {
        withUnsafeBytes(of: &tuple) { buf in
            let end = buf.firstIndex(of: 0) ?? buf.count
            return String(decoding: buf[..<end], as: UTF8.self)
        }
    }

    /// Bounded top-8 selection — one pass, O(8n), replaces four full sorts.
    private static func top8(_ samples: [ProcSample], by areInOrder: (ProcSample, ProcSample) -> Bool) -> [ProcSample] {
        var top: [ProcSample] = []
        top.reserveCapacity(9)
        for s in samples {
            if let i = top.firstIndex(where: { areInOrder(s, $0) }) {
                top.insert(s, at: i)
                if top.count > 8 { top.removeLast() }
            } else if top.count < 8 { top.append(s) }
        }
        return top
    }

    /// KERN_PROCARGS2 → joined argv, matching what `ps -o comm` displayed.
    /// Internal for hermetic tests.
    static func processArgs(for pid: Int32) -> String? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0,
              size > MemoryLayout<Int32>.size, size <= 1024 * 1024 else { return nil }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        let argc = buf.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        var i = MemoryLayout<Int32>.size
        // exec path, then NUL padding to alignment, then argv[0..argc-1]
        while i < size, buf[i] != 0 { i += 1 }
        while i < size, buf[i] == 0 { i += 1 }
        var args: [String] = []
        for _ in 0..<max(0, Int(argc)) {
            guard i < size else { break }
            let s = i
            while i < size, buf[i] != 0 { i += 1 }
            args.append(String(decoding: buf[s..<i], as: UTF8.self))
            i += 1
        }
        let joined = args.joined(separator: " ")
        return joined.isEmpty ? nil : joined
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
    static func buildProcessTree(_ procs: [ProcSample]) -> [(proc: ProcSample, depth: Int, hasChildren: Bool)] {
        // Index children by ppid (using effectiveParentPid to link detached Docker XPC services)
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
    static func processDetail(pid: Int32) -> ProcDetail? {
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
        return kill(pid, signal) == 0
        #else
        return false
        #endif
    }

    // Legacy wrapper for existing call sites
    static func processSamplesLegacy() -> (byCPU: [ProcSample], byMem: [ProcSample]) {
        let r = processSamples()
        return (r.byCPU, r.byMem)
    }

    /// Narrow process sampling for MLX observability. This intentionally does
    /// not run nettop or populate the general process table.
    static func mlxProcessSamples() -> [ProcSample] {
        procLock.lock()
        defer { procLock.unlock() }
        return mlxProcessSamplesLocked()
    }

    private static func mlxProcessSamplesLocked() -> [ProcSample] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-axo", "pid=,ppid=,%cpu=,rss=,etime=,user=,args="]
        guard let data = runCapture(task) else { return [] }
        // Byte-level prefilter: no "mlx" marker anywhere in the table → the
        // ~500-line args parse is skipped entirely (the common case on
        // machines with no MLX runner).
        guard MLXObserver.dataContainsMLXMarker(data) else {
            prevMLXDisk.removeAll()
            return []
        }

        struct Raw {
            var pid: Int32
            var ppid: Int32
            var cpu: Double
            var rssKB: Double
            var etime: String
            var user: String
            var command: String
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

    static func parseNetSnapshot(_ data: Data) -> [Int32: (inB: UInt64, outB: UInt64)] {
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
    /// pipe back-pressure/deadlock when the process list is large. The wait
    /// is bounded: a wedged `ps`/`nettop` must not hold the sampler lock
    /// indefinitely — 2s ticks otherwise stack blocked threads behind it
    /// (observed live: `ps` stalling ~1.5s per run with 5+ samplers queued).
    /// The semaphore wakes on exit; the old 20ms `usleep` poll added up to
    /// a poll-interval of dead latency to every capture.
    private static func runCapture(_ task: Process) -> Data? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("token-horizon-")
            .appendingPathExtension(UUID().uuidString)
        guard FileManager.default.createFile(atPath: url.path, contents: nil),
              let output = FileHandle(forWritingAtPath: url.path) else { return nil }
        defer { try? FileManager.default.removeItem(at: url) }
        task.standardOutput = output
        let exited = DispatchSemaphore(value: 0)
        task.terminationHandler = { _ in exited.signal() }
        do {
            try task.run()
            guard exited.wait(timeout: .now() + subprocessTimeout) == .success else {
                task.terminate()
                if exited.wait(timeout: .now() + 0.2) == .timedOut, task.isRunning {
                    #if canImport(Darwin) || canImport(Glibc)
                    _ = kill(task.processIdentifier, SIGKILL)
                    #endif
                }
                try? output.close()
                return nil
            }
            try? output.close()
        } catch {
            try? output.close()
            return nil
        }
        guard task.terminationStatus == 0 else { return nil }
        return try? Data(contentsOf: url)
    }

    /// Wall-clock bound for one subprocess capture (see runCapture).
    private static let subprocessTimeout: TimeInterval = 5.0

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
    static func ioRates(now: Date = Date()) -> IORates {
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

    private static var prevTicks: [Int64] = []
    private static var cpuPrimed = false
    private static var pageBytes: Double = 0
    private static var totalRAMGB: Double = 0
    /// Serializes snapshot state (prevTicks/cpuPrimed) — snapshot() is called
    /// from the sys timer, HTTP providers, and launch defer on different queues.
    private static let sysLock = NSLock()

    static func snapshot() -> Snapshot {
        sysLock.lock()
        defer { sysLock.unlock() }
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

        // Diff directly against prevTicks — the kernel buffer is copied out
        // in place instead of allocating a fresh [Int64] every tick.
        let n = Int(numCPUs) * Int(CPU_STATE_MAX)
        if prevTicks.count != n {
            prevTicks = [Int64](repeating: 0, count: n)
            cpuPrimed = false
        }
        defer {
            for i in 0..<n { prevTicks[i] = Int64(ticks[i]) }
        }
        guard cpuPrimed else { cpuPrimed = true; return 0 }

        var busyDelta: Int64 = 0
        var totalDelta: Int64 = 0
        for cpu in 0..<Int(numCPUs) {
            let base = cpu * Int(CPU_STATE_MAX)
            let user = Int64(ticks[base + Int(CPU_STATE_USER)]) - prevTicks[base + Int(CPU_STATE_USER)]
            let sys = Int64(ticks[base + Int(CPU_STATE_SYSTEM)]) - prevTicks[base + Int(CPU_STATE_SYSTEM)]
            let nice = Int64(ticks[base + Int(CPU_STATE_NICE)]) - prevTicks[base + Int(CPU_STATE_NICE)]
            let idle = Int64(ticks[base + Int(CPU_STATE_IDLE)]) - prevTicks[base + Int(CPU_STATE_IDLE)]
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

    /// GB memory accounting for /stats + the notch MEM ring. Widened for
    /// the ram_total regression test: `total` (already GB) used to be
    /// divided by 1 GiB a second time and published as 0, degenerating
    /// every MEM% (`used / max(total, 1)`) so the ring pinned at 100%.
    static func memory() -> (used: Double, total: Double) {
        if totalRAMGB == 0 {
            totalRAMGB = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824
        }
        let total = totalRAMGB
        #if canImport(Darwin)
        var stats = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        if pageBytes == 0 {
            var pageSize: vm_size_t = 0
            host_page_size(mach_host_self(), &pageSize)
            pageBytes = Double(pageSize)
        }

        let ok = withUnsafeMutablePointer(to: &stats) { ptr -> Bool in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) == KERN_SUCCESS
            }
        }
        guard ok else { return (0, total) }

        let page = pageBytes
        // Activity Monitor formula: App Memory + Wired Memory + Compressed Memory
        // App Memory = (internal_page_count - purgeable_count)
        let appMemoryPages = max(0, Double(stats.internal_page_count) - Double(stats.purgeable_count))
        let wiredPages = Double(stats.wire_count)
        let compressedPages = Double(stats.compressor_page_count)
        let usedPages = appMemoryPages + wiredPages + compressedPages
        let usedBytes = usedPages * page
        // `total` is already GB (totalRAMGB); only usedBytes is in page-bytes.
        return (usedBytes / 1_073_741_824, total)
        #else
        return (0, total / 1_073_741_824)
        #endif
    }
}
