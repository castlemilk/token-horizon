import SwiftUI

extension Notification.Name {
    static let refreshTrends = Notification.Name("refreshTrends")
    static let refreshModelExtras = Notification.Name("refreshModelExtras")
    static let ollamaTelemetryUpdated = Notification.Name("ollamaTelemetryUpdated")
    static let openDashboard = Notification.Name("openDashboard")
}

final class UIModel: ObservableObject {
    @Published var usage = UsageSnapshot.empty
    @Published var sys = SystemStats.Snapshot()
    @Published var latestEvent: ShellEvent?
    @Published var notchExpanded = false
    // Rolling history backed by BoundedSeries (see Core/): appends auto-trim
    // to cap, so the old hand-rolled trim() is gone. The read API stays
    // `[Double]`, so views and tests are untouched.
    @Published private var _cpuHistory = BoundedSeries<Double>(capacity: UIModel.fineLimit)
    @Published private var _ramHistory = BoundedSeries<Double>(capacity: UIModel.fineLimit)
    @Published private var _diskHistory = BoundedSeries<Double>(capacity: UIModel.fineLimit)
    @Published private var _netHistory = BoundedSeries<Double>(capacity: UIModel.fineLimit)
    @Published private var _cpuCoarse = BoundedSeries<Double>(capacity: UIModel.coarseLimit)
    @Published private var _ramCoarse = BoundedSeries<Double>(capacity: UIModel.coarseLimit)
    @Published private var _diskCoarse = BoundedSeries<Double>(capacity: UIModel.coarseLimit)
    @Published private var _netCoarse = BoundedSeries<Double>(capacity: UIModel.coarseLimit)

    var cpuHistory: [Double] { _cpuHistory.values }
    var ramHistory: [Double] { _ramHistory.values }
    var diskHistory: [Double] { _diskHistory.values }
    var netHistory: [Double] { _netHistory.values }
    var cpuCoarse: [Double] { _cpuCoarse.values }
    var ramCoarse: [Double] { _ramCoarse.values }
    var diskCoarse: [Double] { _diskCoarse.values }
    var netCoarse: [Double] { _netCoarse.values }
    @Published var mlx = MLXSnapshot()
    @Published private(set) var mlxHistory = MLXHistory()
    @Published var sysWindow: SysWindow = .m3
    @Published var processes: [ProcSample] = []
    @Published var processesMem: [ProcSample] = []
    @Published var processesDisk: [ProcSample] = []
    @Published var processesNet: [ProcSample] = []
    @Published var allProcesses: [ProcSample] = []  // htop-style: all ~500 procs, sorted/filtered in view
    private let processesLock = NSLock()

    /// Locked snapshot of the process lists for off-main readers
    /// (LocalServer /processes serves from a connection queue while the main
    /// thread replaces these arrays — direct reads raced). Views keep reading
    /// the @Published vars on main. Call storeProcesses on main.
    func processSnapshot() -> (all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample]) {
        processesLock.lock(); defer { processesLock.unlock() }
        return (allProcesses, processes, processesMem, processesDisk, processesNet)
    }

    func storeProcesses(all: [ProcSample], byCPU: [ProcSample], byMem: [ProcSample], byDisk: [ProcSample], byNet: [ProcSample]) {
        processesLock.lock(); defer { processesLock.unlock() }
        allProcesses = all
        processes = byCPU
        processesMem = byMem
        processesDisk = byDisk
        processesNet = byNet
    }
    @Published var dockerContainers: [DockerContainerSample] = []
    @Published var shellEvents: [ShellEvent] = []
    @Published var historyPoints: [HistoryPoint] = []
    @Published var historyStreak = 0
    @Published var trendPoints: [HistoryPoint] = []
    @Published var hourTrendPoints: [HistoryPoint] = []
    @Published var trendWindow: TrendWindow = .month
    @Published var kimiLimits: [ProviderLimit] = []
    @Published var planLimits: [ProviderLimit] = []
    @Published var syntheticModels: [ModelUsage] = []
    @Published var leaderboardRankings: [LeaderboardRankedEntry] = []

    static let fineLimit = 1800
    static let coarseLimit = 2880
    private var coarseTick = 0

    // These are rolling windows. Samples older than the 24-hour coarse window
    // are discarded instead of being persisted or retained in memory.
    func record(cpu: Double, ram: Double, disk: Double, net: Double) {
        _cpuHistory.append(cpu)
        _ramHistory.append(ram)
        _diskHistory.append(disk)
        _netHistory.append(net)
    }

    func recordCoarse() {
        guard !_cpuHistory.isEmpty else { return }
        coarseTick += 1
        guard coarseTick >= 15 else { return }
        coarseTick = 0
        _cpuCoarse.append(_cpuHistory.averageOfLast(15))
        _ramCoarse.append(_ramHistory.averageOfLast(15))
        _diskCoarse.append(_diskHistory.averageOfLast(15))
        _netCoarse.append(_netHistory.averageOfLast(15))
    }

    func recordMLX(_ snapshot: MLXSnapshot) {
        mlx = snapshot
        mlxHistory.append(snapshot)
    }

    var mlxCPUHistory: [Double] { mlxHistory.cpuSeries() }
    var mlxMemoryHistory: [Double] { mlxHistory.memorySeries() }
    var mlxDiskHistory: [Double] { mlxHistory.diskSeries() }
    var mlxTokHistory: [Double] { mlxHistory.tokSeries() }

    func mlxCPUSeries(_ window: MLXWindow) -> [Double] {
        Array((window.coarse ? mlxHistory.cpuSeries(coarse: true) : mlxHistory.cpuSeries()).suffix(window.points))
    }
    func mlxMemorySeries(_ window: MLXWindow) -> [Double] {
        Array((window.coarse ? mlxHistory.memorySeries(coarse: true) : mlxHistory.memorySeries()).suffix(window.points))
    }
    func mlxDiskSeries(_ window: MLXWindow) -> [Double] {
        Array((window.coarse ? mlxHistory.diskSeries(coarse: true) : mlxHistory.diskSeries()).suffix(window.points))
    }
    func mlxTokSeries(_ window: MLXWindow) -> [Double] {
        Array((window.coarse ? mlxHistory.tokSeries(coarse: true) : mlxHistory.tokSeries()).suffix(window.points))
    }
    func mlxPrefillSeries(_ window: MLXWindow) -> [Double] {
        Array((window.coarse ? mlxHistory.prefillSeries(coarse: true) : mlxHistory.prefillSeries()).suffix(window.points))
    }
    func mlxPeakCPU(_ window: MLXWindow) -> Double {
        mlxCPUSeries(window).max() ?? 0.0
    }
    func mlxPeakMemory(_ window: MLXWindow) -> Double {
        mlxMemorySeries(window).max() ?? 0.0
    }
    func mlxPeakDisk(_ window: MLXWindow) -> Double {
        mlxDiskSeries(window).max() ?? 0.0
    }
    func mlxPeakTok(_ window: MLXWindow) -> Double {
        mlxTokSeries(window).max() ?? 0.0
    }
    func mlxPeakPrefill(_ window: MLXWindow) -> Double {
        mlxPrefillSeries(window).max() ?? 0.0
    }
    func mlxAvgTok(_ window: MLXWindow) -> Double {
        let nonZero = mlxTokSeries(window).filter { $0 > 0 }
        guard !nonZero.isEmpty else { return 0.0 }
        return nonZero.reduce(0, +) / Double(nonZero.count)
    }

    func cpuSeries() -> [Double] {
        sysWindow.coarse ? Array(cpuCoarse.suffix(sysWindow.points)) : Array(cpuHistory.suffix(sysWindow.points))
    }
    func ramSeries() -> [Double] {
        sysWindow.coarse ? Array(ramCoarse.suffix(sysWindow.points)) : Array(ramHistory.suffix(sysWindow.points))
    }
    func diskSeries() -> [Double] {
        sysWindow.coarse ? Array(diskCoarse.suffix(sysWindow.points)) : Array(diskHistory.suffix(sysWindow.points))
    }
    func netSeries() -> [Double] {
        sysWindow.coarse ? Array(netCoarse.suffix(sysWindow.points)) : Array(netHistory.suffix(sysWindow.points))
    }
}

enum SysWindow: String, CaseIterable, Identifiable {
    case m3 = "3M", m15 = "15M", h1 = "1H", h6 = "6H", h24 = "24H"
    var id: String { rawValue }
    var points: Int { switch self { case .m3: 90; case .m15: 450; case .h1: 1800; case .h6: 720; case .h24: 2880 } }
    var label: String {
        switch self { case .m3: return "LAST 3 MIN"; case .m15: return "LAST 15 MIN"; case .h1: return "LAST HOUR"; case .h6: return "LAST 6 HOURS"; case .h24: return "LAST 24 HOURS" }
    }
    var coarse: Bool { self == .h6 || self == .h24 }
}

enum MLXWindow: String, CaseIterable, Identifiable {
    case m5 = "5M", h1 = "1H", h6 = "6H", h24 = "24H"
    var id: String { rawValue }
    var points: Int {
        switch self { case .m5: return 150; case .h1: return 1_800; case .h6: return 720; case .h24: return 2_880 }
    }
    var coarse: Bool { self == .h6 || self == .h24 }
}

