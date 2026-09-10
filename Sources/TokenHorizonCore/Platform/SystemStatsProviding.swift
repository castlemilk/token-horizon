import Foundation

/// One row of process telemetry, sampled by the platform `SystemStatsProviding` backend.
public struct ProcSample: Equatable {
    public var pid: Int32
    public var ppid: Int32          // parent PID (for tree view)
    public var name: String
    public var command: String      // full command path (comm field from ps)
    public var user: String         // effective user
    public var threads: Int         // thread count
    public var cpu: Double
    public var memMB: Double
    public var diskReadMBps: Double
    public var diskWriteMBps: Double
    public var netInKBps: Double
    public var netOutKBps: Double
    public var startTime: Date      // process start (for uptime)

    public init(pid: Int32, ppid: Int32, name: String, command: String, user: String,
                threads: Int, cpu: Double, memMB: Double, diskReadMBps: Double,
                diskWriteMBps: Double, netInKBps: Double, netOutKBps: Double, startTime: Date) {
        self.pid = pid
        self.ppid = ppid
        self.name = name
        self.command = command
        self.user = user
        self.threads = threads
        self.cpu = cpu
        self.memMB = memMB
        self.diskReadMBps = diskReadMBps
        self.diskWriteMBps = diskWriteMBps
        self.netInKBps = netInKBps
        self.netOutKBps = netOutKBps
        self.startTime = startTime
    }
}

/// Detailed info for a single PID (used by drill-down).
public struct ProcDetail: Equatable, Identifiable {
    public var pid: Int32
    public var ppid: Int32
    public var cpu: Double
    public var memPercent: Double
    public var memMB: Double
    public var virtMB: Double
    public var etime: String        // raw ps etime format
    public var user: String
    public var threads: Int
    public var state: String        // R, S, D, Z, etc.
    public var nice: Int
    public var command: String
    public var openFiles: Int?      // lsof count

    public init(pid: Int32, ppid: Int32, cpu: Double, memPercent: Double, memMB: Double,
                virtMB: Double, etime: String, user: String, threads: Int, state: String,
                nice: Int, command: String, openFiles: Int? = nil) {
        self.pid = pid
        self.ppid = ppid
        self.cpu = cpu
        self.memPercent = memPercent
        self.memMB = memMB
        self.virtMB = virtMB
        self.etime = etime
        self.user = user
        self.threads = threads
        self.state = state
        self.nice = nice
        self.command = command
        self.openFiles = openFiles
    }

    public var id: Int32 { pid }
}

/// Whole-machine resource snapshot.
public struct SystemSnapshot {
    public var cpuPercent: Double = 0
    public var ramUsedGB: Double = 0
    public var ramTotalGB: Double = 0
    public var loadAvg1: Double = 0
    public var diskMBps: Double = 0
    public var netMBps: Double = 0

    public init() {}
}

/// System-wide I/O throughput.
public struct SystemIORates {
    public var diskMBps: Double = 0
    public var netMBps: Double = 0

    public init() {}
}

/// Operating-system specific system telemetry backend.
///
/// Conformances:
/// - macOS: `SystemStats` (mach ticks, vm_statistics64, iostat, getifaddrs, ps)
/// - Linux: `ProcFSSystemStats` (reads /proc/stat, /proc/meminfo, /proc/diskstats, /proc/net/dev)
/// - Windows: TBD (PDH counters, GetSystemTimes, GlobalMemoryStatusEx, CreateToolhelp32Snapshot)
public protocol SystemStatsProviding {
    static func snapshot() -> SystemSnapshot
    static func ioRates(now: Date) -> SystemIORates
    static func processSamples() -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample])
    /// Drill-down detail for one PID (default: unsupported).
    static func processDetail(pid: Int32) -> ProcDetail?
    /// Send a signal to a process (default: unsupported).
    static func killProcess(pid: Int32, signal: Int32) -> Bool
    /// Parent/child ordering for tree views (default: generic DFS builder).
    static func buildProcessTree(_ procs: [ProcSample]) -> [(proc: ProcSample, depth: Int, hasChildren: Bool)]
}

/// Convenience for protocol conformers.
extension SystemStatsProviding {
    public static func ioRates() -> SystemIORates { ioRates(now: Date()) }

    /// Drill-down detail for one PID (macOS: task_threads+lsof; Linux: /proc).
    public static func processDetail(pid: Int32) -> ProcDetail? { nil }
    /// Send a signal to a process (default: unsupported).
    public static func killProcess(pid: Int32, signal: Int32) -> Bool { false }

    /// Parent/child ordering for tree views: roots first, DFS by parentage.
    public static func buildProcessTree(_ procs: [ProcSample]) -> [(proc: ProcSample, depth: Int, hasChildren: Bool)] {
        var children: [Int32: [ProcSample]] = [:]
        let pids = Set(procs.map { $0.pid })
        for p in procs { children[p.ppid, default: []].append(p) }
        for key in children.keys { children[key]?.sort { $0.cpu > $1.cpu } }
        var out: [(proc: ProcSample, depth: Int, hasChildren: Bool)] = []
        func visit(_ p: ProcSample, _ depth: Int) {
            let kids = children[p.pid] ?? []
            out.append((proc: p, depth: depth, hasChildren: !kids.isEmpty))
            for k in kids { visit(k, depth + 1) }
        }
        for p in procs where p.ppid <= 1 || !pids.contains(p.ppid) { visit(p, 0) }
        return out
    }
}
