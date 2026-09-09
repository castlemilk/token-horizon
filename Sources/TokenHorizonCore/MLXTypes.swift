import Foundation

/// One process belonging to an MLX runner tree (mlx-lm or Ollama's MLX engine).
public struct MLXProcess: Equatable, Identifiable {
    public var pid: Int32
    public var ppid: Int32
    public var name: String
    public var command: String
    public var model: String?
    public var cpu: Double
    public var memoryMB: Double
    public var diskReadMBps: Double
    public var diskWriteMBps: Double
    public var startTime: Date
    public var tokPerSec: Double?

    public init(pid: Int32, ppid: Int32, name: String, command: String, model: String? = nil,
                cpu: Double, memoryMB: Double, diskReadMBps: Double, diskWriteMBps: Double,
                startTime: Date, tokPerSec: Double? = nil) {
        self.pid = pid
        self.ppid = ppid
        self.name = name
        self.command = command
        self.model = model
        self.cpu = cpu
        self.memoryMB = memoryMB
        self.diskReadMBps = diskReadMBps
        self.diskWriteMBps = diskWriteMBps
        self.startTime = startTime
        self.tokPerSec = tokPerSec
    }

    public var id: Int32 { pid }
}

/// Aggregated view of all currently detected MLX runner processes.
public struct MLXSnapshot: Equatable {
    public var sampledAt: Date = .distantPast
    public var processes: [MLXProcess] = []

    public init(sampledAt: Date = .distantPast, processes: [MLXProcess] = []) {
        self.sampledAt = sampledAt
        self.processes = processes
    }

    public var cpuPercent: Double { processes.reduce(0) { $0 + $1.cpu } }
    public var memoryMB: Double { processes.reduce(0) { $0 + $1.memoryMB } }
    public var diskReadMBps: Double { processes.reduce(0) { $0 + $1.diskReadMBps } }
    public var diskWriteMBps: Double { processes.reduce(0) { $0 + $1.diskWriteMBps } }
    public var measuredTokPerSec: Double? {
        let rates = Dictionary(grouping: processes.compactMap { process -> (String, Double)? in
            guard let model = process.model, let rate = process.tokPerSec else { return nil }
            return (model, rate)
        }, by: { $0.0 }).values.compactMap { $0.first?.1 }
        guard !rates.isEmpty else { return nil }
        return rates.reduce(0, +)
    }
}
