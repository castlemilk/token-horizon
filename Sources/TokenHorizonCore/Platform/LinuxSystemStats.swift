import Foundation

#if os(Linux)
import Glibc

/// Linux implementation of `SystemStatsProviding` backed by /proc and `ps`.
///
/// CPU/RAM/load come from /proc/stat, /proc/meminfo and getloadavg(3);
/// disk throughput from /proc/diskstats (sector deltas); network throughput
/// from /proc/net/dev (non-loopback byte deltas). Process rows come from
/// procps `ps` — per-process disk/net rates are not populated yet (0).
public enum ProcFSSystemStats: SystemStatsProviding {
    private static let lock = NSLock()
    private static var prevCPU: (busy: UInt64, total: UInt64)?
    private static var prevDisk: (sectors: UInt64, time: Date)?
    private static var prevNet: (bytes: UInt64, time: Date)?

    public static func snapshot() -> SystemSnapshot {
        var snap = SystemSnapshot()
        snap.cpuPercent = cpuPercent()
        let (used, total) = memoryGB()
        snap.ramUsedGB = used
        snap.ramTotalGB = total
        var load = [Double](repeating: 0, count: 1)
        if getloadavg(&load, 1) == 1 { snap.loadAvg1 = load[0] }
        let io = ioRates(now: Date())
        snap.diskMBps = io.diskMBps
        snap.netMBps = io.netMBps
        return snap
    }

    public static func ioRates(now: Date = Date()) -> SystemIORates {
        lock.lock()
        defer { lock.unlock() }
        var rates = SystemIORates()

        let sectors = diskSectorTotal()
        if let prev = prevDisk, let sectors {
            let dt = now.timeIntervalSince(prev.time)
            if dt > 0, sectors >= prev.sectors {
                rates.diskMBps = Double(sectors - prev.sectors) * 512.0 / 1_048_576.0 / dt
            }
        }
        if let sectors { prevDisk = (sectors, now) }

        let bytes = netByteTotal()
        if let prev = prevNet, let bytes {
            let dt = now.timeIntervalSince(prev.time)
            if dt > 0, bytes >= prev.bytes {
                rates.netMBps = Double(bytes - prev.bytes) / 1_048_576.0 / dt
            }
        }
        if let bytes { prevNet = (bytes, now) }

        return rates
    }

    public static func processSamples() -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample]) {
        let all = psSamples()
        let byCPU = Array(all.sorted { $0.cpu > $1.cpu }.prefix(8))
        let byMem = Array(all.sorted { $0.memMB > $1.memMB }.prefix(8))
        // Per-process disk/net sampling not implemented on Linux yet.
        return (all, byCPU, byMem, [], [])
    }

    // MARK: - /proc readers

    private static func cpuPercent() -> Double {
        guard let text = try? String(contentsOfFile: "/proc/stat", encoding: .utf8),
              let line = text.split(separator: "\n").first(where: { $0.hasPrefix("cpu ") }) else { return 0 }
        let nums = line.dropFirst(3).split(whereSeparator: { $0 == " " }).compactMap { UInt64($0) }
        guard nums.count >= 5 else { return 0 }
        let idle = nums[3] + nums[4] // idle + iowait
        let total = nums.reduce(0, +)
        let busy = total - min(idle, total)

        lock.lock()
        defer { lock.unlock() }
        defer { prevCPU = (busy, total) }
        guard let prev = prevCPU, total > prev.total, busy >= prev.busy else { return 0 }
        return Double(busy - prev.busy) / Double(total - prev.total) * 100
    }

    private static func memoryGB() -> (used: Double, total: Double) {
        guard let text = try? String(contentsOfFile: "/proc/meminfo", encoding: .utf8) else { return (0, 0) }
        var totalKB: Double = 0
        var availKB: Double = 0
        for line in text.split(separator: "\n") {
            if line.hasPrefix("MemTotal:") {
                totalKB = Double(line.split(whereSeparator: { $0 == " " || $0 == ":" })[1]) ?? 0
            } else if line.hasPrefix("MemAvailable:") {
                availKB = Double(line.split(whereSeparator: { $0 == " " || $0 == ":" })[1]) ?? 0
            }
        }
        let total = totalKB / 1_048_576
        let used = max(total - availKB / 1_048_576, 0)
        return (used, total)
    }

    private static func diskSectorTotal() -> UInt64? {
        guard let text = try? String(contentsOfFile: "/proc/diskstats", encoding: .utf8) else { return nil }
        var sectors: UInt64 = 0
        for line in text.split(separator: "\n") {
            let f = line.split(whereSeparator: { $0 == " " })
            // major minor name rd rd_merge rd_sectors rd_ms wr wr_merge wr_sectors ...
            guard f.count >= 10 else { continue }
            let name = f[2]
            // Count whole disks only — skip partitions and virtual devices.
            if name.hasPrefix("loop") || name.hasPrefix("ram") || name.hasPrefix("dm-") { continue }
            if name.range(of: #"^(sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+)\d+$"#, options: .regularExpression) != nil { continue }
            if name.range(of: #"^(nvme\d+n\d+|mmcblk\d+)p\d+$"#, options: .regularExpression) != nil { continue }
            sectors += (UInt64(f[5]) ?? 0) + (UInt64(f[9]) ?? 0)
        }
        return sectors
    }

    private static func netByteTotal() -> UInt64? {
        guard let text = try? String(contentsOfFile: "/proc/net/dev", encoding: .utf8) else { return nil }
        var bytes: UInt64 = 0
        for line in text.split(separator: "\n") {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let iface = line[..<colon].trimmingCharacters(in: .whitespaces)
            if iface == "lo" { continue }
            let f = line[colon...].dropFirst().split(whereSeparator: { $0 == " " })
            guard f.count >= 9 else { continue }
            bytes += (UInt64(f[0]) ?? 0) + (UInt64(f[8]) ?? 0) // rx bytes + tx bytes
        }
        return bytes
    }

    // MARK: - ps sampling

    private static func psSamples() -> [ProcSample] {
        let ps = ["/bin/ps", "/usr/bin/ps"].first { FileManager.default.fileExists(atPath: $0) } ?? "/bin/ps"
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("th-ps-\(UUID().uuidString).txt")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: tmp) }
        guard let fh = FileHandle(forWritingAtPath: tmp.path) else { return [] }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: ps)
        proc.arguments = ["-axo", "pid=,ppid=,nlwp=,%cpu=,rss=,etime=,user=,comm="]
        proc.standardOutput = fh
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            try? fh.close()
            return []
        }
        try? fh.close()
        guard let data = try? Data(contentsOf: tmp),
              let text = String(data: data, encoding: .utf8) else { return [] }

        let now = Date()
        var out: [ProcSample] = []
        for line in text.split(separator: "\n") {
            let f = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
            guard f.count >= 8, let pid = Int32(f[0]) else { continue }
            let ppid = Int32(f[1]) ?? 0
            let threads = Int(f[2]) ?? 0
            let cpu = Double(f[3]) ?? 0
            let memMB = (Double(f[4]) ?? 0) / 1024
            let elapsed = parseElapsed(f[5])
            let user = f[6]
            let command = f[7...].joined(separator: " ")
            let name = URL(fileURLWithPath: command).lastPathComponent
            out.append(ProcSample(
                pid: pid, ppid: ppid, name: name, command: command, user: user,
                threads: threads, cpu: cpu, memMB: memMB,
                diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0,
                startTime: now.addingTimeInterval(-elapsed)
            ))
        }
        return out
    }

    /// Parse ps etime: [[dd-]hh:]mm:ss → seconds.
    private static func parseElapsed(_ s: String) -> TimeInterval {
        var days = 0.0
        var rest = s
        if let dash = rest.firstIndex(of: "-") {
            days = Double(rest[..<dash]) ?? 0
            rest = String(rest[rest.index(after: dash)...])
        }
        let parts = rest.split(separator: ":").compactMap { Double($0) }
        var seconds = days * 86_400
        for p in parts { seconds = seconds * 60 + p }
        return seconds
    }
}
#endif
