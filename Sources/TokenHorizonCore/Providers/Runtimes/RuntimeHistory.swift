import Foundation

/// Bounded in-memory throughput/workload history for one runtime — the
/// generalized successor to MLXHistory, available to EVERY runtime.
/// Fine: one point per poll (cap 1,800). Coarse: 30s averages (cap 2,880 =
/// 24h). Old points are discarded, never persisted (invariant: rollups are
/// in-memory only).
public struct RuntimeHistoryPoint: Equatable {
    public var timestamp: Date
    public var tokPerSec: Double?
    public var promptTokPerSec: Double?
    public var cpuPercent: Double?     // local process aggregate (nil when remote)
    public var memMB: Double?          // local process aggregate (nil when remote)
    public var loadedModels: Double?

    public init(timestamp: Date, tokPerSec: Double? = nil, promptTokPerSec: Double? = nil,
                cpuPercent: Double? = nil, memMB: Double? = nil, loadedModels: Double? = nil) {
        self.timestamp = timestamp
        self.tokPerSec = tokPerSec
        self.promptTokPerSec = promptTokPerSec
        self.cpuPercent = cpuPercent
        self.memMB = memMB
        self.loadedModels = loadedModels
    }
}

public struct RuntimeHistory: Equatable {
    public static let fineLimit = 1_800
    public static let coarseLimit = 2_880
    public static let rollupSeconds: TimeInterval = 30

    public private(set) var fine: [RuntimeHistoryPoint] = []
    public private(set) var coarse: [RuntimeHistoryPoint] = []

    private var activeBucket: Date?

    // Accumulation state for the open bucket (optionals averaged over non-nil samples).
    private var n = 0
    private var tokSum = 0.0; private var tokN = 0
    private var promptSum = 0.0; private var promptN = 0
    private var cpuSum = 0.0; private var cpuN = 0
    private var memSum = 0.0; private var memN = 0
    private var modelsSum = 0.0; private var modelsN = 0

    public init() {}

    public mutating func append(_ point: RuntimeHistoryPoint) {
        fine.append(point)
        if fine.count > Self.fineLimit { fine.removeFirst(fine.count - Self.fineLimit) }

        let bucket = Date(timeIntervalSince1970:
            floor(point.timestamp.timeIntervalSince1970 / Self.rollupSeconds) * Self.rollupSeconds)
        if activeBucket != bucket {
            flushRollup()
            activeBucket = bucket
        }
        n += 1
        if let v = point.tokPerSec { tokSum += v; tokN += 1 }
        if let v = point.promptTokPerSec { promptSum += v; promptN += 1 }
        if let v = point.cpuPercent { cpuSum += v; cpuN += 1 }
        if let v = point.memMB { memSum += v; memN += 1 }
        if let v = point.loadedModels { modelsSum += v; modelsN += 1 }
    }

    private mutating func flushRollup() {
        guard n > 0, let bucket = activeBucket else { return }
        coarse.append(RuntimeHistoryPoint(
            timestamp: bucket,
            tokPerSec: tokN > 0 ? tokSum / Double(tokN) : nil,
            promptTokPerSec: promptN > 0 ? promptSum / Double(promptN) : nil,
            cpuPercent: cpuN > 0 ? cpuSum / Double(cpuN) : nil,
            memMB: memN > 0 ? memSum / Double(memN) : nil,
            loadedModels: modelsN > 0 ? modelsSum / Double(modelsN) : nil))
        if coarse.count > Self.coarseLimit { coarse.removeFirst(coarse.count - Self.coarseLimit) }
        n = 0; tokSum = 0; tokN = 0; promptSum = 0; promptN = 0
        cpuSum = 0; cpuN = 0; memSum = 0; memN = 0; modelsSum = 0; modelsN = 0
    }
}
