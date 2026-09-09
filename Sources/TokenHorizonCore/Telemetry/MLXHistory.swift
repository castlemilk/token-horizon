import Foundation

<<<<<<<< HEAD:Sources/TokenHorizon/LocalModels/MLXHistory.swift
struct MLXHistoryPoint: Equatable {
    var timestamp: Date
    var cpuPercent: Double
    var memoryMB: Double
    var diskReadMBps: Double
    var diskWriteMBps: Double
    var tokPerSec: Double?
    var prefillTokPerSec: Double?
========
public struct MLXHistoryPoint: Equatable {
    public init(timestamp: Date, cpuPercent: Double, memoryMB: Double, diskReadMBps: Double, diskWriteMBps: Double, tokPerSec: Double? = nil) {
        self.timestamp = timestamp
        self.cpuPercent = cpuPercent
        self.memoryMB = memoryMB
        self.diskReadMBps = diskReadMBps
        self.diskWriteMBps = diskWriteMBps
        self.tokPerSec = tokPerSec
    }

    public var timestamp: Date
    public var cpuPercent: Double
    public var memoryMB: Double
    public var diskReadMBps: Double
    public var diskWriteMBps: Double
    public var tokPerSec: Double?
>>>>>>>> c0b8275 (Split portable server side into TokenHorizonCore + OS seam interfaces):Sources/TokenHorizonCore/MLXHistory.swift
}

public struct MLXHistory: Equatable {
    public static let fineLimit = 1_800
    public static let coarseLimit = 2_880
    public static let rollupSeconds: TimeInterval = 30

    public private(set) var fine: [MLXHistoryPoint] = []
    private(set) var coarse: [MLXHistoryPoint] = []

    private var activeBucket: Date?
    private var sampleCount = 0
    private var cpuSum = 0.0
    private var memorySum = 0.0
    private var diskReadSum = 0.0
    private var diskWriteSum = 0.0
    private var tokSum = 0.0
    private var tokCount = 0
    private var prefillSum = 0.0
    private var prefillCount = 0

    public init() {}

    mutating func append(_ snapshot: MLXSnapshot) {
        let point = MLXHistoryPoint(
            timestamp: snapshot.sampledAt,
            cpuPercent: snapshot.cpuPercent,
            memoryMB: snapshot.memoryMB,
            diskReadMBps: snapshot.diskReadMBps,
            diskWriteMBps: snapshot.diskWriteMBps,
            tokPerSec: snapshot.measuredTokPerSec,
            prefillTokPerSec: snapshot.measuredPrefillTokPerSec
        )
        fine.append(point)
        trim(&fine, to: Self.fineLimit)

        let bucket = Date(timeIntervalSince1970: floor(point.timestamp.timeIntervalSince1970 / Self.rollupSeconds) * Self.rollupSeconds)
        if activeBucket != bucket {
            flushRollup()
            activeBucket = bucket
            sampleCount = 0
            cpuSum = 0
            memorySum = 0
            diskReadSum = 0
            diskWriteSum = 0
            tokSum = 0
            tokCount = 0
            prefillSum = 0
            prefillCount = 0
        }

        sampleCount += 1
        cpuSum += point.cpuPercent
        memorySum += point.memoryMB
        diskReadSum += point.diskReadMBps
        diskWriteSum += point.diskWriteMBps
        if let tok = point.tokPerSec {
            tokSum += tok
            tokCount += 1
        }
        if let prefill = point.prefillTokPerSec {
            prefillSum += prefill
            prefillCount += 1
        }
    }

    public func cpuSeries(coarse: Bool = false) -> [Double] {
        (coarse ? self.coarse : fine).map(\ .cpuPercent)
    }

    public func memorySeries(coarse: Bool = false) -> [Double] {
        (coarse ? self.coarse : fine).map(\ .memoryMB)
    }

    public func diskSeries(coarse: Bool = false) -> [Double] {
        (coarse ? self.coarse : fine).map { $0.diskReadMBps + $0.diskWriteMBps }
    }

<<<<<<<< HEAD:Sources/TokenHorizon/LocalModels/MLXHistory.swift
    func tokSeries(coarse: Bool = false) -> [Double] {
        (coarse ? self.coarse : fine).map { $0.tokPerSec ?? 0.0 }
    }

    func measuredTokSeries(coarse: Bool = false) -> [Double] {
        (coarse ? self.coarse : fine).compactMap(\.tokPerSec)
    }

    func prefillSeries(coarse: Bool = false) -> [Double] {
        (coarse ? self.coarse : fine).map { $0.prefillTokPerSec ?? 0.0 }
    }

    func measuredPrefillSeries(coarse: Bool = false) -> [Double] {
        (coarse ? self.coarse : fine).compactMap(\.prefillTokPerSec)
    }

    func maxCPU(coarse: Bool = false) -> Double {
        (coarse ? self.coarse : fine).map(\.cpuPercent).max() ?? 0.0
    }

    func maxMemory(coarse: Bool = false) -> Double {
        (coarse ? self.coarse : fine).map(\.memoryMB).max() ?? 0.0
    }

    func maxDisk(coarse: Bool = false) -> Double {
        (coarse ? self.coarse : fine).map { $0.diskReadMBps + $0.diskWriteMBps }.max() ?? 0.0
    }

    func maxTok(coarse: Bool = false) -> Double {
        (coarse ? self.coarse : fine).compactMap(\.tokPerSec).max() ?? 0.0
    }

    func avgTok(coarse: Bool = false) -> Double {
        let measured = (coarse ? self.coarse : fine).compactMap(\.tokPerSec).filter { $0 > 0 }
        guard !measured.isEmpty else { return 0.0 }
        return measured.reduce(0, +) / Double(measured.count)
    }

    func maxPrefill(coarse: Bool = false) -> Double {
        (coarse ? self.coarse : fine).compactMap(\.prefillTokPerSec).max() ?? 0.0
    }

    func avgPrefill(coarse: Bool = false) -> Double {
        let measured = (coarse ? self.coarse : fine).compactMap(\.prefillTokPerSec).filter { $0 > 0 }
        guard !measured.isEmpty else { return 0.0 }
        return measured.reduce(0, +) / Double(measured.count)
========
    public func tokSeries(coarse: Bool = false) -> [Double] {
        (coarse ? self.coarse : fine).compactMap(\ .tokPerSec)
>>>>>>>> c0b8275 (Split portable server side into TokenHorizonCore + OS seam interfaces):Sources/TokenHorizonCore/MLXHistory.swift
    }

    private mutating func flushRollup() {
        guard sampleCount > 0, let activeBucket else { return }
        coarse.append(MLXHistoryPoint(
            timestamp: activeBucket,
            cpuPercent: cpuSum / Double(sampleCount),
            memoryMB: memorySum / Double(sampleCount),
            diskReadMBps: diskReadSum / Double(sampleCount),
            diskWriteMBps: diskWriteSum / Double(sampleCount),
            tokPerSec: tokCount > 0 ? tokSum / Double(tokCount) : nil,
            prefillTokPerSec: prefillCount > 0 ? prefillSum / Double(prefillCount) : nil
        ))
        trim(&coarse, to: Self.coarseLimit)
    }

    private func trim<T>(_ values: inout [T], to limit: Int) {
        if values.count > limit { values.removeFirst(values.count - limit) }
    }
}
