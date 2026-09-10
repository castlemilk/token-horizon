import SwiftUI
import TokenHorizonCore

final class UIModel: ObservableObject {
    @Published var usage = UsageSnapshot.empty
    @Published var sys = SystemStats.Snapshot()
    @Published var latestEvent: ShellEvent?
    @Published var notchExpanded = false
    @Published var cpuHistory: [Double] = []
    @Published var ramHistory: [Double] = []
    @Published var diskHistory: [Double] = []
    @Published var netHistory: [Double] = []
    @Published var cpuCoarse: [Double] = []
    @Published var ramCoarse: [Double] = []
    @Published var diskCoarse: [Double] = []
    @Published var netCoarse: [Double] = []
    @Published var mlx = MLXSnapshot()
    /// Loopback port of the Ollama request meter (nil = metering off/declined).
    var ollamaMeterPort: Int? = nil
    /// Unified runtime/provider surfaces (fed by InferenceMonitor + UsageStoring).
    @Published var runtimes: [RuntimeSnapshot] = []
    @Published var providerSummary: [ProviderSummary] = []
    var usageStore: UsageStoring?
    @Published private(set) var mlxHistory = MLXHistory()
    @Published var sysWindow: SysWindow = .m3
    @Published var processes: [ProcSample] = []
    @Published var processesMem: [ProcSample] = []
    @Published var processesDisk: [ProcSample] = []
    @Published var processesNet: [ProcSample] = []
    @Published var allProcesses: [ProcSample] = []  // htop-style: all ~500 procs, sorted/filtered in view
    @Published var shellEvents: [ShellEvent] = []
    @Published var historyPoints: [HistoryPoint] = []
    @Published var historyStreak = 0
    @Published var trendPoints: [HistoryPoint] = []
    @Published var trendWindow: TrendWindow = .month
    @Published var kimiLimits: [ProviderLimit] = []
    @Published var planLimits: [ProviderLimit] = []
    @Published var syntheticModels: [ModelUsage] = []

    static let fineLimit = 1800
    static let coarseLimit = 2880
    private var coarseTick = 0

    // These are rolling windows. Samples older than the 24-hour coarse window
    // are discarded instead of being persisted or retained in memory.
    func record(cpu: Double, ram: Double, disk: Double, net: Double) {
        cpuHistory.append(cpu)
        ramHistory.append(ram)
        diskHistory.append(disk)
        netHistory.append(net)
        trim(&cpuHistory, to: Self.fineLimit)
        trim(&ramHistory, to: Self.fineLimit)
        trim(&diskHistory, to: Self.fineLimit)
        trim(&netHistory, to: Self.fineLimit)
    }

    func recordCoarse() {
        guard !cpuHistory.isEmpty else { return }
        coarseTick += 1
        guard coarseTick >= 15 else { return }
        coarseTick = 0
        let n = min(15, cpuHistory.count)
        cpuCoarse.append(cpuHistory.suffix(n).reduce(0, +) / Double(n))
        ramCoarse.append(ramHistory.suffix(n).reduce(0, +) / Double(n))
        diskCoarse.append(diskHistory.suffix(n).reduce(0, +) / Double(n))
        netCoarse.append(netHistory.suffix(n).reduce(0, +) / Double(n))
        trim(&cpuCoarse, to: Self.coarseLimit)
        trim(&ramCoarse, to: Self.coarseLimit)
        trim(&diskCoarse, to: Self.coarseLimit)
        trim(&netCoarse, to: Self.coarseLimit)
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

    private func trim(_ values: inout [Double], to limit: Int) {
        if values.count > limit { values.removeFirst(values.count - limit) }
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

struct MonospacedText: View {
    let text: String
    let color: Color
    var size: CGFloat = 11
    var body: some View {
        Text(text).font(.system(size: size, weight: .medium, design: .monospaced)).foregroundStyle(color).lineLimit(1)
    }
}

struct NotchContentView: View {
    @ObservedObject var model: UIModel
    let geometry: NotchPanel.Geometry
    var body: some View {
        if model.notchExpanded {
            DashboardTabs(model: model, compact: true)
                .padding(.top, geometry.topInset + 8).padding(.bottom, 14).padding(.horizontal, 16)
                .frame(maxHeight: .infinity, alignment: .top)
        } else {
            let cpuPct = model.sys.cpuPercent
            let ramPct = model.sys.ramUsedGB / max(model.sys.ramTotalGB, 1) * 100
            HStack(spacing: 0) {
                WingRingGauge(percent: cpuPct, color: .red, help: "CPU")
                    .frame(width: geometry.wing, alignment: .trailing).padding(.trailing, 2)
                Color.clear.frame(width: geometry.notchWidth)
                WingRingGauge(percent: ramPct, color: .cyan, help: "Memory")
                    .frame(width: geometry.wing, alignment: .leading).padding(.leading, 2)
            }
            .frame(height: geometry.topInset)
        }
    }
}

enum DashboardTab: String, CaseIterable, Identifiable {
    case activity = "ACTIVITY", mlx = "MLX", tokens = "TOKENS", providers = "PROVIDERS", models = "MODELS", shells = "SHELLS", settings = "⚙ SETTINGS"
    var id: String { rawValue }
}

struct DashboardTabs: View {
    @ObservedObject var model: UIModel
    var compact: Bool = true
    @State private var tab: DashboardTab = .activity
    @State private var heatmapExpanded = false
    @State private var cookieDraft: String = ""
    @State private var notifyDraft: Bool = true
    @State private var modelSearch: String = ""
    @State private var modelSortColumn: ModelTableColumn = .sweBench
    @State private var modelSortAscending: Bool = false
    @State private var modelFilterScope: ModelFilterScope = .all
    @State private var showUsageColumn: Bool = false
    @State private var procSearch: String = ""
    @State private var procSort: String = "cpu"
    @State private var procSortAscending: Bool = false
    @State private var selectedRow: ModelRow?
    @State private var mlxWindow: MLXWindow = .h1

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            tabBar
            Divider().overlay(Color.white.opacity(0.12))
            ScrollView(.vertical, showsIndicators: false) {
                switch tab {
                case .activity: activityTab
                case .mlx: mlxTab
                case .tokens: tokensTab
                case .providers: providersTab
                case .models: modelsTab
                case .shells: shellsTab
                case .settings: settingsTab
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear { NotificationCenter.default.post(name: .refreshTrends, object: nil) }
    }

    private var tabBar: some View {
        HStack(spacing: 4) {
            ForEach(DashboardTab.allCases) { t in
                Button { withAnimation(.easeOut(duration: 0.15)) { tab = t } } label: {
                    Text(t.rawValue)
                        .font(.system(size: 9, weight: .heavy, design: .monospaced))
                        .foregroundStyle(tab == t ? Color.black : Color.white.opacity(0.5))
                        .padding(.horizontal, 12).padding(.vertical, 4)
                        .background(Capsule().fill(tab == t ? Color.white : Color.white.opacity(0.14)))
                }
                .buttonStyle(.plain)
            }
            Spacer()
            Button { NotificationCenter.default.post(name: NSNotification.Name("openDashboard"), object: nil) } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
            }
            .buttonStyle(.plain)
            .help("Open dashboard window")
            if compact {
                Button { NSApp.terminate(nil) } label: {
                    Image(systemName: "power").font(.system(size: 10)).foregroundStyle(.white.opacity(0.5))
                }
                .buttonStyle(.plain)
                .help("Quit")
            }
        }
    }

    private var activityTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 4) {
                ForEach(SysWindow.allCases) { w in
                    Button { model.sysWindow = w } label: {
                        Text(w.rawValue)
                            .font(.system(size: 8, weight: .heavy, design: .monospaced))
                            .foregroundStyle(model.sysWindow == w ? Color.black : Color.white.opacity(0.5))
                            .padding(.horizontal, 8).padding(.vertical, 2.5)
                            .background(Capsule().fill(model.sysWindow == w ? Color.white : Color.white.opacity(0.08)))
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    sectionLabel(String(format: "CPU %@ · %.0f%%", model.sysWindow.rawValue, model.sys.cpuPercent))
                    Sparkline(values: DashboardTabs.downsample(model.cpuSeries(), to: 300), color: .red).frame(height: 40)
                }.frame(maxWidth: .infinity)
                VStack(alignment: .leading, spacing: 3) {
                    sectionLabel(String(format: "MEM %.0f%%", model.sys.ramUsedGB / max(model.sys.ramTotalGB, 1) * 100))
                    Sparkline(values: DashboardTabs.downsample(model.ramSeries(), to: 300), color: .cyan).frame(height: 40)
                }.frame(maxWidth: .infinity)
                VStack(alignment: .leading, spacing: 3) {
                    sectionLabel(String(format: "DISK %.1fM", model.sys.diskMBps))
                    Sparkline(values: DashboardTabs.downsample(model.diskSeries(), to: 300), color: .orange).frame(height: 40)
                }.frame(maxWidth: .infinity)
                VStack(alignment: .leading, spacing: 3) {
                    sectionLabel(String(format: "NET %.1fM", model.sys.netMBps))
                    Sparkline(values: DashboardTabs.downsample(model.netSeries(), to: 300), color: .purple).frame(height: 40)
                }.frame(maxWidth: .infinity)
            }
            Divider().overlay(Color.white.opacity(0.12))
            processesSection
        }
    }

    // Unified provider/runtime surface: live measured throughput for every
    // runtime (InferenceMonitor) + metered provider→model rollups (UsageStoring).
    private var providersTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                sectionLabel("PROVIDERS & RUNTIMES")
                Spacer()
                let active = model.runtimes.filter { $0.running }.count
                MonospacedText(text: active == 0 ? "IDLE" : "\(active) ACTIVE",
                               color: active == 0 ? .secondary : .green, size: 8)
            }
            if model.runtimes.isEmpty && model.providerSummary.isEmpty {
                MonospacedText(text: "no runtime or metered activity yet", color: .secondary, size: 9)
            }
            if !model.runtimes.isEmpty {
                sectionLabel("LIVE RUNTIMES · MEASURED")
                ForEach(model.runtimes, id: \.vendor) { rt in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Circle().fill(rt.running ? Color.green : Color.secondary.opacity(0.4))
                                .frame(width: 5, height: 5)
                            MonospacedText(text: rt.displayName, color: .white, size: 9)
                            Spacer()
                            if let tps = rt.tokPerSec {
                                MonospacedText(text: String(format: "%.1f tok/s", tps), color: .green, size: 9)
                            } else {
                                MonospacedText(text: "—", color: .secondary, size: 9)
                            }
                        }
                        HStack(spacing: 8) {
                            if let p = rt.promptTokPerSec {
                                MonospacedText(text: String(format: "prompt %.1f/s", p), color: .secondary, size: 8)
                            }
                            if let g = rt.generationTokensTotal {
                                MonospacedText(text: "gen \(fmtTok(Int(g)))", color: .secondary, size: 8)
                            }
                            if let port = rt.port {
                                MonospacedText(text: ":\(port)", color: .secondary, size: 8)
                            }
                        }.padding(.leading, 11)
                    }
                }
            }
            if !model.providerSummary.isEmpty {
                sectionLabel("METERED USAGE · 30D")
                ForEach(model.providerSummary, id: \.vendor) { prov in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            MonospacedText(text: prov.vendor.uppercased(), color: .white, size: 9)
                            MonospacedText(text: prov.source, color: .secondary, size: 8)
                            Spacer()
                            MonospacedText(text: "\(fmtTok(prov.tokens.total)) tok · \(prov.requests) req",
                                           color: .white.opacity(0.7), size: 8)
                        }
                        ForEach(prov.models, id: \.model) { m in
                            HStack(spacing: 6) {
                                Text(m.model)
                                    .font(.system(size: 8, design: .monospaced))
                                    .foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                if let tps = m.avgGenerationTokPerSec {
                                    MonospacedText(text: String(format: "%.1f t/s", tps), color: .green.opacity(0.8), size: 8)
                                }
                                MonospacedText(text: fmtTok(m.tokens.total), color: .secondary, size: 8)
                            }.padding(.leading, 8)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func fmtTok(_ n: Int) -> String {
        if n >= 1_000_000_000 { return String(format: "%.1fB", Double(n) / 1e9) }
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1e6) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1e3) }
        return "\(n)"
    }

    private var mlxTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                sectionLabel("MLX OBSERVABILITY")
                Spacer()
                MonospacedText(
                    text: model.mlx.processes.isEmpty ? "IDLE" : "ACTIVE · \(model.mlx.processes.count) PROCS",
                    color: model.mlx.processes.isEmpty ? .secondary : .green,
                    size: 8
                )
            }
            if let meterPort = model.ollamaMeterPort {
                MonospacedText(text: "request meter 127.0.0.1:\(meterPort) · point Ollama-compatible clients here for exact tok/s", color: .white.opacity(0.35), size: 7.5)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 4) {
                ForEach(MLXWindow.allCases) { window in
                    Button { mlxWindow = window } label: {
                        Text(window.rawValue)
                            .font(.system(size: 8, weight: .heavy, design: .monospaced))
                            .foregroundStyle(mlxWindow == window ? Color.black : Color.white.opacity(0.5))
                            .padding(.horizontal, 8).padding(.vertical, 2.5)
                            .background(Capsule().fill(mlxWindow == window ? Color.white : Color.white.opacity(0.08)))
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }

            if model.mlx.processes.isEmpty {
                MonospacedText(text: "no MLX runner detected", color: .secondary, size: 10)
                MonospacedText(text: "watching Ollama --mlx-engine and mlx-lm process trees", color: .white.opacity(0.45), size: 8)
            } else {
                HStack(spacing: 8) {
                    mlxStat("CPU", String(format: "%.1f%%", model.mlx.cpuPercent), .red)
                    mlxStat("MEM", formatMemory(model.mlx.memoryMB), .cyan)
                    mlxStat("READ", String(format: "%.1fM/s", model.mlx.diskReadMBps), .orange)
                    mlxStat("WRITE", String(format: "%.1fM/s", model.mlx.diskWriteMBps), .yellow)
                    mlxStat("TOK/S", model.mlx.measuredTokPerSec.map { String(format: "%.1f", $0) } ?? "--", .green)
                }

                HStack(spacing: 8) {
                    mlxSparkline("CPU", model.mlxCPUSeries(mlxWindow), .red)
                    mlxSparkline("MEM", model.mlxMemorySeries(mlxWindow), .cyan)
                    mlxSparkline("DISK", model.mlxDiskSeries(mlxWindow), .orange)
                    mlxSparkline("TOK/S", model.mlxTokSeries(mlxWindow), .green)
                }

                Divider().overlay(Color.white.opacity(0.12))
                sectionLabel("RUNNERS")
                ForEach(model.mlx.processes) { process in
                    HStack(spacing: 6) {
                        Circle().fill(process.cpu > 50 ? Color.red : .green).frame(width: 4, height: 4)
                        MonospacedText(text: "\(process.pid)", color: .secondary, size: 8)
                        MonospacedText(text: process.model ?? process.name, color: .white.opacity(0.85), size: 9)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        MonospacedText(text: String(format: "%.1f%%", process.cpu), color: .orange, size: 8)
                        MonospacedText(text: formatMemory(process.memoryMB), color: .cyan, size: 8)
                        MonospacedText(text: process.tokPerSec.map { String(format: "%.1f t/s", $0) } ?? "-- t/s", color: .green, size: 8)
                    }
                }
                MonospacedText(text: "tok/s is the latest completed Ollama measurement; live request instrumentation is not inferred from process load.", color: .white.opacity(0.35), size: 7.5)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func mlxStat(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            MonospacedText(text: label, color: .white.opacity(0.4), size: 7)
            MonospacedText(text: value, color: color, size: 10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func mlxSparkline(_ label: String, _ values: [Double], _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionLabel(label)
            Sparkline(values: DashboardTabs.downsample(values, to: 100), color: color).frame(height: 30)
        }
        .frame(maxWidth: .infinity)
    }

    private func formatMemory(_ megabytes: Double) -> String {
        megabytes >= 1024 ? String(format: "%.1fG", megabytes / 1024) : String(format: "%.0fM", megabytes)
    }

    // MARK: - htop-style processes section

    @State private var procTreeMode: Bool = false
    @State private var procSelectedPid: Int32? = nil
    @State private var procDetail: ProcDetail? = nil
    @State private var procVisibleCount: Int = 30
    @State private var procExpandedPids: Set<Int32> = []

    enum ProcSortKey: String, CaseIterable, Identifiable {
        case cpu, mem, disk, net, pid, name, user, time
        var id: String { rawValue }
    }

    private var processesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                sectionLabel("PROCESSES — htop style")
                Spacer()
                MonospacedText(text: String(format: "%d procs · sys %.0f%% · %.1f/%.0fG",
                                             model.allProcesses.count, model.sys.cpuPercent,
                                             model.sys.ramUsedGB, model.sys.ramTotalGB),
                               color: .secondary, size: 8)
            }
            // Filter row + tree toggle
            HStack(spacing: 6) {
                HStack(spacing: 5) {
                    Image(systemName: "magnifyingglass").font(.system(size: 8)).foregroundStyle(.white.opacity(0.4))
                    TextField("filter by name, pid, or user…", text: $procSearch)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.white)
                        .textFieldStyle(.plain)
                    if !procSearch.isEmpty {
                        Button { procSearch = "" } label: {
                            Image(systemName: "xmark.circle.fill").font(.system(size: 9)).foregroundStyle(.white.opacity(0.4))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(Color.white.opacity(0.08)))
                // Tree/Flat toggle
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { procTreeMode.toggle() }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: procTreeMode ? "list.bullet.indent" : "list.bullet")
                            .font(.system(size: 7.5))
                        Text(procTreeMode ? "TREE" : "FLAT")
                            .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                    }
                    .foregroundStyle(procTreeMode ? Color.green : Color.white.opacity(0.55))
                    .padding(.horizontal, 6).padding(.vertical, 2.5)
                    .background(Capsule().fill(procTreeMode ? Color.green.opacity(0.15) : Color.white.opacity(0.06)))
                }
                .buttonStyle(.plain)
                .help("Toggle tree view (parent/child process grouping)")
            }

            // Column headers (clickable to sort)
            procHeaderRow

            // Process list
            ScrollView(.vertical, showsIndicators: true) {
                LazyVStack(spacing: 0) {
                    let rows = procDisplayRows
                    let maxCPU = Swift.max(model.allProcesses.map(\.cpu).max() ?? 1, 1)
                    let maxMem = Swift.max(rows.map(\.proc.memMB).max() ?? 1, 1)
                    if rows.isEmpty {
                        MonospacedText(text: "no processes match filter", color: .secondary, size: 9)
                            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 12)
                    } else {
                        ForEach(rows, id: \.proc.pid) { row in
                            procRowView(row, maxCPU: maxCPU, maxMem: maxMem)
                                .onTapGesture {
                                    inspectProcess(row.proc)
                                }
                                .onAppear {
                                    // Infinite scroll: when last row appears, expand
                                    if row.proc.pid == rows.last?.proc.pid && procVisibleCount < procFullCount {
                                        procVisibleCount += 30
                                    }
                                }
                        }
                        if procVisibleCount < procFullCount {
                            HStack(spacing: 6) {
                                ProgressView().scaleEffect(0.6)
                                MonospacedText(text: "showing \(procVisibleCount) of \(procFullCount) — scroll for more", color: .secondary, size: 8)
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                    }
                }
            }
            .frame(maxHeight: 280)
            .sheet(item: $procDetail) { detail in
                procDetailSheet(detail)
            }
        }
    }

    private var procHeaderRow: some View {
        HStack(spacing: 4) {
            procSortHeader("", key: nil, width: 12, align: .leading)  // tree chevron
            procSortHeader("PID", key: .pid, width: 38, align: .leading)
            procSortHeader("USER", key: .user, width: 48, align: .leading)
            procSortHeader("CPU%", key: .cpu, width: 68, align: .trailing)
            procSortHeader("MEM", key: .mem, width: 68, align: .trailing)
            procSortHeader("DISK", key: .disk, width: 36, align: .trailing)
            procSortHeader("NET", key: .net, width: 36, align: .trailing)
            procSortHeader("TIME", key: .time, width: 32, align: .trailing)
            procSortHeader("COMMAND", key: .name, width: nil, align: .leading)
        }
        .padding(.horizontal, 6).padding(.vertical, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.04))
        .overlay(Rectangle().fill(Color.white.opacity(0.1)).frame(height: 1), alignment: .bottom)
    }

    private func procSortHeader(_ title: String, key: ProcSortKey?, width: CGFloat?, align: Alignment) -> some View {
        Group {
            if let key = key {
                Button {
                    if procSort == key.rawValue {
                        procSortAscending.toggle()
                    } else {
                        procSort = key.rawValue
                        procSortAscending = (key == .name || key == .user)
                    }
                } label: {
                    HStack(spacing: 2) {
                        Text(title)
                            .font(.system(size: 7, weight: .heavy, design: .monospaced))
                            .foregroundStyle(procSort == key.rawValue ? Color.white : Color.white.opacity(0.45))
                        if procSort == key.rawValue {
                            Image(systemName: procSortAscending ? "arrow.up" : "arrow.down")
                                .font(.system(size: 6, weight: .bold))
                                .foregroundStyle(.cyan)
                        }
                    }
                    .frame(maxWidth: width == nil ? .infinity : width, alignment: align)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                Text(title)
                    .font(.system(size: 7, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: width == nil ? .infinity : width, alignment: align)
            }
        }
    }

    // MARK: - Process data shaping

    private struct ProcDisplayRow {
        let proc: ProcSample
        let depth: Int        // 0 for roots, 1+ for children (tree mode)
        let hasChildren: Bool // tree mode only
    }

    /// Compute the displayed process list (filtered + sorted + paged).
    /// Tree mode returns a flat list with depth info; flat mode returns sorted/filtered/paged.
    private var procDisplayRows: [ProcDisplayRow] {
        if procTreeMode {
            return procTreeRows
        } else {
            return procFlatRows
        }
    }

    private var procFlatRows: [ProcDisplayRow] {
        let q = procSearch.lowercased().trimmingCharacters(in: .whitespaces)
        var list = model.allProcesses
        if !q.isEmpty {
            list = list.filter {
                $0.name.lowercased().contains(q)
                || String($0.pid).contains(q)
                || $0.user.lowercased().contains(q)
                || $0.command.lowercased().contains(q)
            }
        }
        list.sort { a, b in
            let asc = procSortAscending
            switch ProcSortKey(rawValue: procSort) ?? .cpu {
            case .cpu: return asc ? a.cpu < b.cpu : a.cpu > b.cpu
            case .mem: return asc ? a.memMB < b.memMB : a.memMB > b.memMB
            case .disk: let ad = a.diskReadMBps + a.diskWriteMBps; let bd = b.diskReadMBps + b.diskWriteMBps; return asc ? ad < bd : ad > bd
            case .net: let an = a.netInKBps + a.netOutKBps; let bn = b.netInKBps + b.netOutKBps; return asc ? an < bn : an > bn
            case .pid: return asc ? a.pid < b.pid : a.pid > b.pid
            case .name: return asc ? a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending : a.name.localizedCaseInsensitiveCompare(b.name) == .orderedDescending
            case .user: return asc ? a.user.localizedCaseInsensitiveCompare(b.user) == .orderedAscending : a.user.localizedCaseInsensitiveCompare(b.user) == .orderedDescending
            case .time: return asc ? a.startTime < b.startTime : a.startTime > b.startTime
            }
        }
        let limited = Array(list.prefix(procVisibleCount))
        return limited.map { ProcDisplayRow(proc: $0, depth: 0, hasChildren: false) }
    }

    private var procTreeRows: [ProcDisplayRow] {
        let q = procSearch.lowercased().trimmingCharacters(in: .whitespaces)
        var procs = model.allProcesses
        if !q.isEmpty {
            procs = procs.filter {
                $0.name.lowercased().contains(q)
                || String($0.pid).contains(q)
                || $0.user.lowercased().contains(q)
                || $0.command.lowercased().contains(q)
            }
        }
        let comparator: (ProcSample, ProcSample) -> Bool = { a, b in
            let asc = procSortAscending
            switch ProcSortKey(rawValue: procSort) ?? .cpu {
            case .cpu: return asc ? a.cpu < b.cpu : a.cpu > b.cpu
            case .mem: return asc ? a.memMB < b.memMB : a.memMB > b.memMB
            case .disk: let ad = a.diskReadMBps + a.diskWriteMBps; let bd = b.diskReadMBps + b.diskWriteMBps; return asc ? ad < bd : ad > bd
            case .net: let an = a.netInKBps + a.netOutKBps; let bn = b.netInKBps + b.netOutKBps; return asc ? an < bn : an > bn
            case .pid: return asc ? a.pid < b.pid : a.pid > b.pid
            case .name: return asc ? a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending : a.name.localizedCaseInsensitiveCompare(b.name) == .orderedDescending
            case .user: return asc ? a.user.localizedCaseInsensitiveCompare(b.user) == .orderedAscending : a.user.localizedCaseInsensitiveCompare(b.user) == .orderedDescending
            case .time: return asc ? a.startTime < b.startTime : a.startTime > b.startTime
            }
        }

        // Keep parent/child structure intact while sorting siblings by the selected column.
        var childrenByParent: [Int32: [ProcSample]] = [:]
        for proc in procs { childrenByParent[proc.ppid, default: []].append(proc) }
        let pids = Set(procs.map(\.pid))
        let roots = procs.filter { $0.ppid == 0 || !pids.contains($0.ppid) }.sorted(by: comparator)
        var result: [ProcDisplayRow] = []
        var visited = Set<Int32>()
        func visit(_ proc: ProcSample, depth: Int) {
            guard !visited.contains(proc.pid), result.count < procVisibleCount else { return }
            visited.insert(proc.pid)
            let children = (childrenByParent[proc.pid] ?? []).sorted(by: comparator)
            result.append(ProcDisplayRow(proc: proc, depth: depth, hasChildren: !children.isEmpty))
            guard procExpandedPids.contains(proc.pid) else { return }
            for child in children { visit(child, depth: depth + 1) }
        }
        for root in roots {
            visit(root, depth: 0)
            if result.count >= procVisibleCount { break }
        }
        // A cycle has no root. Include its unvisited nodes safely rather than dropping it.
        if result.count < procVisibleCount {
            for proc in procs.sorted(by: comparator) where !visited.contains(proc.pid) {
                visit(proc, depth: 0)
                if result.count >= procVisibleCount { break }
            }
        }
        return result
    }

    private var procFullCount: Int {
        if procTreeMode {
            return SystemStats.buildProcessTree(model.allProcesses).count
        } else {
            return model.allProcesses.count
        }
    }

    // MARK: - Single row view

    private func procRowView(_ row: ProcDisplayRow, maxCPU: Double, maxMem: Double) -> some View {
        let proc = row.proc
        let memBar = min(proc.memMB / maxMem * 100, 100)
        let uptimeStr = formatUptime(Date().timeIntervalSince(proc.startTime))
        let indent = procTreeMode ? CGFloat(row.depth) * 8.0 : 0

        return HStack(spacing: 4) {
            // Tree chevron / indent
            HStack(spacing: 0) {
                if procTreeMode && row.hasChildren {
                    Button {
                        if procExpandedPids.contains(proc.pid) {
                            procExpandedPids.remove(proc.pid)
                        } else {
                            procExpandedPids.insert(proc.pid)
                        }
                    } label: {
                        Image(systemName: procExpandedPids.contains(proc.pid) ? "chevron.down" : "chevron.right")
                            .font(.system(size: 7, weight: .bold))
                            .foregroundStyle(.cyan)
                    }
                    .buttonStyle(.plain)
                } else if procTreeMode {
                    Spacer().frame(width: 8)
                }
                Spacer().frame(width: indent)
            }
            .frame(width: 12, alignment: .leading)

            MonospacedText(text: String(proc.pid), color: .white.opacity(0.7), size: 8).frame(width: 38, alignment: .leading).lineLimit(1)
            MonospacedText(text: proc.user, color: .white.opacity(0.6), size: 8).frame(width: 48, alignment: .leading).lineLimit(1).truncationMode(.tail)
            // CPU bar + value (compact metric fits its column — no clipping)
            ProcessMetric(value: proc.cpu, maxValue: maxCPU, text: String(format: "%5.1f", proc.cpu),
                          color: proc.cpu > 50 ? .red : proc.cpu > 5 ? .orange : .green,
                          barWidth: 30, textWidth: 33)
                .frame(width: 68, alignment: .trailing)
            // MEM bar is relative to the largest displayed process; value is absolute RSS.
            ProcessMetric(value: memBar, maxValue: 100, text: formatMemory(proc.memMB),
                          color: .green,
                          gradient: Gradient(colors: [.green, .yellow, .orange, .red]),
                          barWidth: 30, textWidth: 33)
                .frame(width: 68, alignment: .trailing)
            MonospacedText(text: String(format: "%.1fM", proc.diskReadMBps + proc.diskWriteMBps),
                           color: .white.opacity(0.7), size: 8).frame(width: 36, alignment: .trailing)
            MonospacedText(text: String(format: "%.0fK", proc.netInKBps + proc.netOutKBps),
                           color: .white.opacity(0.7), size: 8).frame(width: 36, alignment: .trailing)
            MonospacedText(text: uptimeStr, color: .white.opacity(0.6), size: 8).frame(width: 32, alignment: .trailing)
            MonospacedText(text: truncatedCommand(proc.command.isEmpty ? proc.name : proc.command),
                           color: .white.opacity(0.85), size: 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(1).truncationMode(.tail)
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(procSelectedPid == proc.pid ? Color.white.opacity(0.08) : Color.clear)
    }

    /// Truncate long command paths to ~20 chars for the table column.
    /// The full string is shown in the hover inspector bubble + click drill-down.
    private func truncatedCommand(_ cmd: String) -> String {
        if cmd.count <= 20 { return cmd }
        return String(cmd.prefix(19)) + "…"
    }

    // MARK: - Drill-down sheet

    private func inspectProcess(_ proc: ProcSample) {
        procSelectedPid = proc.pid
        procDetail = nil
        Task {
            let detail = await Task.detached(priority: .userInitiated) {
                SystemStats.processDetail(pid: proc.pid)
            }.value
            guard !Task.isCancelled else { return }
            procDetail = detail
        }
    }

    private func procDetailSheet(_ d: ProcDetail) -> some View {
        let children = model.allProcesses
            .filter { $0.ppid == d.pid }
            .sorted { $0.cpu > $1.cpu }
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    MonospacedText(text: "PROCESS DETAIL", color: .green, size: 9)
                    MonospacedText(text: "PID \(d.pid)", color: .white, size: 12)
                }
                Spacer()
                Button("Close") { procDetail = nil; procSelectedPid = nil }
                    .buttonStyle(.borderless)
            }
            Divider()
            procDetailRow("command", d.command, mono: true)
            procDetailRow("user", d.user)
            procDetailRow("parent", "\(d.ppid)")
            procDetailRow("state", d.state, color: d.state.contains("Z") ? .red : d.state.contains("R") ? .green : .secondary)
            procDetailRow("cpu", String(format: "%.2f%%", d.cpu), color: d.cpu > 50 ? .red : .secondary)
            procDetailRow("memory", String(format: "%.1f MB (%.2f%%)", d.memMB, d.memPercent),
                          color: d.memMB > 1024 ? .red : d.memMB > 256 ? .orange : .secondary)
            procDetailRow("virtual", String(format: "%.1f GB", d.virtMB / 1024))
            procDetailRow("threads", d.threads == 0 ? "n/a" : "\(d.threads)")
            procDetailRow("nice", "\(d.nice)")
            procDetailRow("etime", d.etime)
            if let of = d.openFiles {
                procDetailRow("open files", "\(of)", color: of > 1000 ? .yellow : .secondary)
            }
            if !children.isEmpty {
                Divider()
                HStack {
                    MonospacedText(text: "CHILD PROCESSES", color: .secondary, size: 8)
                    Spacer()
                    MonospacedText(text: "\(children.count)", color: .cyan, size: 8)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(children, id: \.pid) { child in
                            HStack(spacing: 6) {
                                Circle().fill(child.cpu > 50 ? Color.red : child.cpu > 5 ? Color.orange : Color.green)
                                    .frame(width: 4, height: 4)
                                MonospacedText(text: "\(child.pid)", color: .secondary, size: 8)
                                MonospacedText(text: child.name, color: .white.opacity(0.85), size: 8)
                                    .lineLimit(1)
                                Spacer()
                                MonospacedText(text: String(format: "%.1f%%", child.cpu), color: .orange, size: 8)
                                MonospacedText(text: child.command, color: .white.opacity(0.45), size: 7.5)
                                    .lineLimit(1).truncationMode(.middle)
                                    .frame(maxWidth: 150, alignment: .trailing)
                            }
                        }
                    }
                }
                .frame(maxHeight: 90)
            }
            Spacer()
            HStack(spacing: 8) {
                Button("SIGTERM") {
                    _ = SystemStats.killProcess(pid: d.pid, signal: SIGTERM)
                    procDetail = nil
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                Button("SIGKILL") {
                    _ = SystemStats.killProcess(pid: d.pid, signal: SIGKILL)
                    procDetail = nil
                }
                .buttonStyle(.bordered)
                .tint(.red)
            }
        }
        .padding(14)
        .frame(width: 500, height: children.isEmpty ? 360 : 470)
    }

    private func procDetailRow(_ label: String, _ value: String, color: Color = .secondary, mono: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 8) {
            MonospacedText(text: label, color: Color.white.opacity(0.35), size: 8)
                .frame(width: 70, alignment: .leading)
            Text(value)
                .font(mono ? .system(size: 8, design: .monospaced) : .system(size: 8))
                .foregroundStyle(color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
    }

    // MARK: - Helpers

    private func formatUptime(_ seconds: TimeInterval) -> String {
        if seconds < 60 { return String(format: "%ds", Int(seconds)) }
        if seconds < 3600 { return String(format: "%dm", Int(seconds / 60)) }
        if seconds < 86400 { return String(format: "%dh", Int(seconds / 3600)) }
        return String(format: "%dd", Int(seconds / 86400))
    }

    private var tokensTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(model.usage.tokensTodayText).font(.system(size: 22, weight: .bold, design: .monospaced)).foregroundStyle(.green)
                Text("tokens today").font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
                Spacer()
                Text(UsageSnapshot.cost(model.usage.costToday)).font(.system(size: 16, weight: .semibold, design: .monospaced)).foregroundStyle(.orange)
            }
            HStack(spacing: 6) {
                stat("all-time", "\(model.usage.tokensAllTimeText) · \(UsageSnapshot.cost(model.usage.costAllTime))", .secondary)
                Spacer(); stat("streak", "\(model.historyStreak)d", .green)
            }
            tokensTrendsAndHeatmap
            Divider().overlay(Color.white.opacity(0.12))
            if !model.usage.perTool.isEmpty {
                sectionLabel("BY TOOL")
                HStack(spacing: 14) {
                    ForEach(model.usage.perTool, id: \.tool) { tool in
                        HStack(spacing: 4) {
                            Circle().fill(DashboardTabs.toolColor(tool.tool)).frame(width: 4, height: 4)
                            MonospacedText(text: tool.tool, color: .white.opacity(0.85), size: 10)
                            MonospacedText(text: UsageSnapshot.tokens(tool.tokensToday), color: .green, size: 10)
                            if tool.cacheReadAll > 0 {
                                MonospacedText(text: "\(Int(Double(tool.cacheReadAll) / Double(Swift.max(tool.tokensAllTime, 1)) * 100))% cached",
                                               color: .green.opacity(0.7), size: 9)
                            }
                        }
                    }
                    Spacer()
                }
                Divider().overlay(Color.white.opacity(0.12))
            }
            if !model.usage.models.isEmpty {
                let freeT = model.usage.models.filter { $0.free }.reduce(0) { $0 + $1.tokensAll }
                let paid = model.usage.models.filter { !$0.free }
                let paidT = paid.reduce(0) { $0 + $1.tokensAll }
                let paidC = paid.reduce(0.0) { $0 + $1.cost }
                let activeModels = model.usage.models.filter { $0.tokensAll > 0 || $0.tokensToday > 0 }
                sectionLabel("MODELS (\(activeModels.count))")
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(activeModels.prefix(10)) { m in
                        HStack(spacing: 6) {
                            Circle().fill(m.free ? Color.green.opacity(0.6) : Color.orange).frame(width: 3.5, height: 3.5)
                            MonospacedText(text: m.model, color: .white.opacity(0.85), size: 9)
                            MonospacedText(text: m.provider, color: .white.opacity(0.4), size: 7.5).frame(maxWidth: .infinity, alignment: .leading)
                            MonospacedText(text: UsageSnapshot.tokens(m.tokensToday), color: .green, size: 9).frame(width: 44, alignment: .trailing)
                            MonospacedText(text: m.free ? "free" : UsageSnapshot.cost(m.cost),
                                           color: m.free ? .green.opacity(0.7) : .orange, size: 9)
                                .frame(width: 40, alignment: .trailing)
                        }
                    }
                }
                HStack(spacing: 12) {
                    Spacer(); stat("free", UsageSnapshot.tokens(freeT), .green)
                    if paidT > 0 { stat("pay-go", "\(UsageSnapshot.tokens(paidT)) · \(UsageSnapshot.cost(paidC))", .orange) }
                }
                Divider().overlay(Color.white.opacity(0.12))
            }
            let limitRows = model.usage.limits + model.kimiLimits + model.planLimits
            if !limitRows.isEmpty {
                sectionLabel("PLAN LIMITS")
                VStack(alignment: .leading, spacing: 6) {
                    let grouped = Dictionary(grouping: limitRows, by: { $0.provider })
                    ForEach(grouped.keys.sorted(), id: \.self) { provider in
                        let rows = grouped[provider]!.sorted { $0.usedPercent > $1.usedPercent }
                        HStack(spacing: 7) {
                            ProviderLogoView(provider: provider, size: 14)
                            MonospacedText(text: DashboardTabs.providerNameDisplay(provider), color: .white.opacity(0.88), size: 9)
                                .frame(width: 58, alignment: .leading)
                            ForEach(rows) { l in
                                HStack(spacing: 3) {
                                    MonospacedText(text: l.label, color: .white.opacity(0.42), size: 7.5)
                                        .frame(minWidth: 26, alignment: .leading)
                                    ZStack(alignment: .leading) {
                                        Capsule().fill(Color.white.opacity(0.12))
                                        Capsule().fill(l.usedPercent >= 100 ? Color.red : l.usedPercent >= 85 ? Color.orange : Color.green.opacity(0.85))
                                            .frame(width: max(2, CGFloat(48 * Swift.min(l.usedPercent, 100) / 100)))
                                    }
                                    .frame(width: 48, height: 4)
                                    MonospacedText(text: String(format: "%.0f%%", l.usedPercent),
                                                   color: l.usedPercent >= 100 ? .red : l.usedPercent >= 85 ? .orange : .white.opacity(0.85), size: 8.5)
                                        .frame(width: 24, alignment: .trailing)
                                }
                                .help("\(DashboardTabs.providerNameDisplay(provider)) \(l.label): \(String(format: "%.1f%%", l.usedPercent)) used\(l.detail.isEmpty ? "" : " (\(l.detail))")\(l.resetsAt != nil ? " · Resets in \(DashboardTabs.formatReset(l.resetsAt!))" : "")")
                            }
                            Spacer()
                        }
                    }
                }
                Divider().overlay(Color.white.opacity(0.12))
            }
            sectionLabel("RECENT SESSIONS")
            VStack(alignment: .leading, spacing: 5) {
                ForEach(model.usage.recentSessions.prefix(3)) { s in
                    HStack(spacing: 8) {
                        Circle().fill(Color.green.opacity(0.5)).frame(width: 4, height: 4)
                        MonospacedText(text: s.title, color: .white.opacity(0.85), size: 10).frame(maxWidth: .infinity, alignment: .leading)
                        MonospacedText(text: UsageSnapshot.tokens(s.tokens), color: .secondary, size: 10)
                        MonospacedText(text: UsageSnapshot.cost(s.cost), color: .orange.opacity(0.8), size: 10).frame(minWidth: 44, alignment: .trailing)
                    }
                }
            }
        }
    }

    private var tokensTrendsAndHeatmap: some View {
        let trendTotal = model.trendPoints.reduce(0) { $0 + $1.tokens }
        let activeBuckets = model.trendPoints.filter { $0.tokens > 0 }.count
        return HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 8) {
                    HeatmapGrid(points: heatmapPoints, maxTokens: heatmapMax, cellSize: heatmapExpanded ? 4.5 : 5.5)
                    HeatmapKPIs(points: heatmapPoints).frame(width: 72)
                }
                Button { withAnimation { heatmapExpanded.toggle() } } label: {
                    Text(heatmapExpanded ? "collapse 24W" : "expand 52W")
                        .font(.system(size: 7, weight: .heavy, design: .monospaced)).foregroundStyle(.white.opacity(0.45))
                }
                .buttonStyle(.plain)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 3) {
                    ForEach(TrendWindow.allCases) { w in
                        Button { model.trendWindow = w; NotificationCenter.default.post(name: .refreshTrends, object: nil) } label: {
                            Text(w.rawValue)
                                .font(.system(size: 7, weight: .heavy, design: .monospaced))
                                .foregroundStyle(model.trendWindow == w ? Color.black : Color.white.opacity(0.5))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Capsule().fill(model.trendWindow == w ? Color.white : Color.white.opacity(0.08)))
                        }
                        .buttonStyle(.plain)
                    }
                }
                HStack(spacing: 8) {
                    stat("window", UsageSnapshot.tokens(trendTotal), .green)
                    stat("avg", activeBuckets > 0 ? UsageSnapshot.tokens(trendTotal / Swift.max(activeBuckets, 1)) : "0", .secondary)
                }
                if model.trendPoints.isEmpty {
                    MonospacedText(text: "loading…", color: .secondary, size: 9).frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 16)
                } else {
                    StackedTrends(points: model.trendPoints).frame(height: 80)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var heatmapPoints: [HistoryPoint] {
        Array(model.historyPoints.suffix(heatmapExpanded ? 364 : 168))
    }
    private var heatmapMax: Int { Swift.max(heatmapPoints.map { $0.tokens }.max() ?? 1, 1) }

    private var shellsTab: some View {
        VStack(alignment: .leading, spacing: 5) {
            sectionLabel("RECENT SHELL COMMANDS")
            if model.shellEvents.isEmpty { MonospacedText(text: "no events yet — run a command in zsh", color: .secondary, size: 10) }
            ForEach(Array(model.shellEvents.prefix(9).enumerated()), id: \.element.id) { _, ev in
                HStack(spacing: 8) {
                    Circle().fill(ev.exit == 0 ? Color.green.opacity(0.5) : Color.red).frame(width: 4, height: 4)
                    MonospacedText(text: (ev.cwd as NSString).lastPathComponent, color: .white.opacity(0.85), size: 10).frame(maxWidth: .infinity, alignment: .leading)
                    MonospacedText(text: ev.summary, color: .secondary, size: 10)
                }
            }
        }
    }

    private var settingsTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("ALIBABA TOKEN PLAN — COOKIE")
            Text("Paste Cookie header from bailian-singapore-cs.alibabacloud.com tokenplan/personal/api/v2/usage request.")
                .font(.system(size: 8, design: .monospaced)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $cookieDraft)
                .font(.system(size: 8, design: .monospaced))
                .scrollContentBackground(.hidden)
                .foregroundStyle(.white.opacity(0.85))
                .padding(6).frame(height: 90)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.05)))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.12)))
            HStack(spacing: 10) {
                Button {
                    SettingsStore.shared.setCookie(cookieDraft)
                    NotificationCenter.default.post(name: .refreshTrends, object: nil)
                } label: {
                    Text("Save & refresh")
                        .font(.system(size: 9, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.black).padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Capsule().fill(Color.white))
                }
                .buttonStyle(.plain)
                Spacer()
                if let row = model.planLimits.first(where: { $0.provider == "alibaba" }) {
                    MonospacedText(text: "alibaba: \(row.label) \(Int(row.usedPercent))%", color: .green, size: 9)
                } else if cookieDraft.contains("=") {
                    MonospacedText(text: "fetching…", color: .secondary, size: 9)
                }
            }
            sectionLabel("NOTIFICATIONS")
            Toggle(isOn: Binding(
                get: { notifyDraft },
                set: {
                    notifyDraft = $0
                    SettingsStore.shared.notifyOnLimitRefresh = $0
                }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Notify when token limits refresh")
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.9))
                    Text("Sends a system notification when a quota window resets or a rate limit clears.")
                        .font(.system(size: 8, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
            .toggleStyle(.switch)
            .tint(.green)

            sectionLabel("CLAUDE")
            MonospacedText(text: "auto-detected from ~/.claude/.credentials.json or macOS Keychain 'Claude Code-credentials'", color: .secondary, size: 8.5).fixedSize(horizontal: false, vertical: true)
            sectionLabel("GEMINI")
            MonospacedText(text: "auto-detected from ~/.gemini/oauth_creds.json when present", color: .secondary, size: 8.5)
            sectionLabel("ALIBABA / GLM / MINIMAX / OPENCODE-GO")
            MonospacedText(text: "keys read from opencode auth.json", color: .secondary, size: 8.5)
        }
        .onAppear {
            cookieDraft = SettingsStore.shared.getCookie()
            notifyDraft = SettingsStore.shared.notifyOnLimitRefresh
        }
    }

    @State private var displayedCount = 50
    @State private var _baseRows: [ModelRow] = []
    @State private var _filteredRows: [ModelRow] = []
    @State private var _scopeCounts: [ModelFilterScope: Int] = [:]
    @State private var _localCount: Int = 0
    @State private var _lastBaseKey: String = ""

    private var modelsTab: some View {
        let rows = _filteredRows
        let visibleRows = Array(rows.prefix(displayedCount))

        return VStack(alignment: .leading, spacing: 8) {
            // Search Bar, Model Counts, and Toggle Buttons
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                TextField("search models, providers, context, capabilities…", text: $modelSearch)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.85))
                    .textFieldStyle(.plain)
                if !modelSearch.isEmpty {
                    Button { modelSearch = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                MonospacedText(text: "\(rows.count) models", color: .secondary, size: 9)
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(Capsule().fill(Color.white.opacity(0.06)))

            // Filter Scopes & Action Toggles
            HStack(spacing: 4) {
                ForEach(ModelFilterScope.allCases) { scope in
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) { modelFilterScope = scope }
                    } label: {
                        let count = _scopeCounts[scope] ?? 0
                        HStack(spacing: 3) {
                            Text(scope.rawValue)
                            Text("\(count)")
                                .font(.system(size: 7.5, weight: .regular, design: .monospaced))
                                .foregroundStyle(modelFilterScope == scope ? Color.black.opacity(0.7) : Color.white.opacity(0.4))
                        }
                        .font(.system(size: 8, weight: .heavy, design: .monospaced))
                        .foregroundStyle(modelFilterScope == scope ? Color.black : Color.white.opacity(0.55))
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(
                            Capsule().fill(modelFilterScope == scope ? Color.white : Color.white.opacity(0.08))
                        )
                    }
                    .buttonStyle(.plain)
                }

                Spacer()

                // Optional Usage Column Toggle Button
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { showUsageColumn.toggle() }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: showUsageColumn ? "chart.bar.fill" : "chart.bar")
                            .font(.system(size: 7.5))
                        Text(showUsageColumn ? "HIDE USAGE" : "+ USAGE COL")
                            .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                    }
                    .foregroundStyle(showUsageColumn ? Color.orange : Color.white.opacity(0.6))
                    .padding(.horizontal, 6).padding(.vertical, 2.5)
                    .background(
                        Capsule().fill(showUsageColumn ? Color.orange.opacity(0.18) : Color.white.opacity(0.07))
                    )
                }
                .buttonStyle(.plain)
                .help("Toggle personal token usage & spend column")

                if _localCount > 0 {
                    Button {
                        benchmarkAllLocal()
                    } label: {
                        HStack(spacing: 2) {
                            Image(systemName: "bolt.fill")
                                .font(.system(size: 7.5))
                            Text("BENCHMARK")
                                .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                        }
                        .foregroundStyle(Color.cyan)
                        .padding(.horizontal, 6).padding(.vertical, 2.5)
                        .background(Capsule().fill(Color.cyan.opacity(0.12)))
                    }
                    .buttonStyle(.plain)
                    .help("Benchmark speed (tok/s) for all installed local Ollama models")
                }

                Button {
                    ModelCatalog.shared.refreshRemote()
                } label: {
                    HStack(spacing: 2) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.system(size: 7.5))
                        Text("SYNC")
                            .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                    }
                    .foregroundStyle(Color.white.opacity(0.75))
                    .padding(.horizontal, 6).padding(.vertical, 2.5)
                    .background(Capsule().fill(Color.white.opacity(0.09)))
                }
                .buttonStyle(.plain)
                .help("Discover newly released models and sync pricing from remote catalog and live APIs")
            }

            // TanStack-style Table Container
            VStack(alignment: .leading, spacing: 0) {
                // Table Header Row
                HStack(spacing: 6) {
                    tableHeaderCell(title: "MODEL & PROVIDER", column: .model, alignment: .leading)
                    tableHeaderCell(title: "CTX", column: .context, width: compact ? 42 : 52, alignment: .center)
                    tableHeaderCell(title: "IN / 1M", column: .inputPrice, width: compact ? 52 : 62, alignment: .trailing)
                    tableHeaderCell(title: "OUT / 1M", column: .outputPrice, width: compact ? 54 : 64, alignment: .trailing)
                    tableHeaderCell(title: "CACHE", column: .cachePrice, width: compact ? 48 : 58, alignment: .trailing)
                    tableHeaderCell(title: "SWE-BENCH", column: .sweBench, width: compact ? 56 : 68, alignment: .trailing)
                    tableHeaderCell(title: "LCB", column: .codingLCB, width: compact ? 46 : 56, alignment: .trailing)
                    tableHeaderCell(title: "SPEED", column: .speed, width: compact ? 58 : 72, alignment: .trailing)
                    if showUsageColumn {
                        tableHeaderCell(title: "USAGE", column: .usage, width: compact ? 74 : 90, alignment: .trailing)
                    }
                    Text("LINK")
                        .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .frame(width: 22, alignment: .center)
                }
                .padding(.horizontal, 6).padding(.vertical, 5)
                .background(Color.white.opacity(0.04))
                .overlay(Rectangle().fill(Color.white.opacity(0.1)).frame(height: 1), alignment: .bottom)

                if rows.isEmpty {
                    VStack(spacing: 4) {
                        Image(systemName: "cube.transparent")
                            .font(.system(size: 20))
                            .foregroundStyle(.tertiary)
                            .padding(.top, 16)
                        MonospacedText(text: "no matching models", color: .secondary, size: 10)
                        Text("Try adjusting your search query or filter scope")
                            .font(.system(size: 8.5, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
                } else {
                    ScrollView(.vertical, showsIndicators: true) {
                        LazyVStack(spacing: 0) {
                            ForEach(visibleRows) { row in
                                ModelRowView(row: row, compact: compact, showUsage: showUsageColumn)
                                    .onTapGesture { selectedRow = row }
                                    .onAppear {
                                        if row.id == visibleRows.last?.id && visibleRows.count < rows.count {
                                            displayedCount += 50
                                        }
                                    }
                            }
                            if visibleRows.count < rows.count {
                                HStack(spacing: 6) {
                                    ProgressView().scaleEffect(0.6)
                                    MonospacedText(text: "showing \(visibleRows.count) of \(rows.count) — scroll for more", color: .secondary, size: 8)
                                }
                                .frame(maxWidth: .infinity).padding(.vertical, 8)
                            }
                        }
                    }
                    .frame(minHeight: 180, maxHeight: compact ? 340 : 460)
                    .sheet(item: $selectedRow) { row in
                        ModelDetailView(row: row)
                    }
                    .onChange(of: modelSearch) { _ in displayedCount = 50; recomputeFilteredRows() }
                    .onChange(of: modelFilterScope) { _ in displayedCount = 50; recomputeFilteredRows() }
                    .onChange(of: modelSortColumn) { _ in recomputeFilteredRows() }
                    .onChange(of: modelSortAscending) { _ in recomputeFilteredRows() }
                }

                // Table Summary Footer Bar
                HStack(spacing: 10) {
                    let totalModels = rows.count
                    let sweModels = rows.compactMap { $0.sweScore }
                    let avgSWE = sweModels.isEmpty ? 0 : (sweModels.reduce(0, +) / Double(sweModels.count))
                    let measuredLocal = rows.filter { ($0.usage.tokPerSec ?? 0) > 0 }
                    let avgTokSec = measuredLocal.isEmpty ? 0 : (measuredLocal.reduce(0.0) { $0 + ($1.usage.tokPerSec ?? 0) } / Double(measuredLocal.count))

                    stat("catalog", "\(totalModels)", .white.opacity(0.8))
                    if avgSWE > 0 {
                        stat("avg SWE", String(format: "%.1f%%", avgSWE), .green)
                    }
                    if avgTokSec > 0 {
                        stat("avg local", String(format: "%.1f tok/s", avgTokSec), .cyan)
                    }
                    if showUsageColumn {
                        let totalTok = rows.reduce(0) { $0 + $1.usage.tokensAll }
                        let totalCost = rows.reduce(0.0) { $0 + $1.effectiveCost }
                        if totalTok > 0 {
                            stat("used", UsageSnapshot.tokens(totalTok), .orange)
                        }
                        if totalCost > 0 {
                            stat("spend", UsageSnapshot.cost(totalCost), .orange)
                        }
                    }
                    Spacer()
                }
                .padding(.horizontal, 6).padding(.vertical, 4)
                .background(Color.white.opacity(0.02))
                .overlay(Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1), alignment: .top)
            }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.white.opacity(0.08), lineWidth: 1))
        }
        .onAppear {
            ModelCatalog.shared.ensureLoaded()
        }
        .task {
            recomputeFilteredRows()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                let curKey = "\(ModelCatalog.shared.allEntries().count)-\(model.usage.models.count)-\(model.syntheticModels.count)"
                if curKey != _lastBaseKey { await MainActor.run { recomputeFilteredRows() } }
            }
        }
    }

    private func benchmarkAllLocal() {
        for r in _filteredRows.filter({ $0.isLocal }) { OllamaClient.benchmark(model: r.usage.model) }
    }

    private func tableHeaderCell(title: String, column: ModelTableColumn, width: CGFloat? = nil, alignment: Alignment = .trailing) -> some View {
        Button {
            if modelSortColumn == column {
                modelSortAscending.toggle()
            } else {
                modelSortColumn = column
                modelSortAscending = (column == .model || column == .inputPrice || column == .outputPrice)
            }
            recomputeFilteredRows(force: true)
        } label: {
            HStack(spacing: 3) {
                Text(title)
                    .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                    .foregroundStyle(modelSortColumn == column ? Color.white : Color.white.opacity(0.45))
                if modelSortColumn == column {
                    Image(systemName: modelSortAscending ? "arrow.up" : "arrow.down")
                        .font(.system(size: 6.5, weight: .bold))
                        .foregroundStyle(.cyan)
                }
            }
            .frame(maxWidth: width == nil ? .infinity : width, alignment: alignment)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func recomputeFilteredRows(force: Bool = false) {
        let baseKey = "\(ModelCatalog.shared.allEntries().count)-\(model.usage.models.count)-\(model.syntheticModels.count)-\(modelSearch)-\(modelFilterScope.rawValue)-\(modelSortColumn.rawValue)-\(modelSortAscending)"
        if !force && baseKey == _lastBaseKey && !_filteredRows.isEmpty { return }
        _lastBaseKey = baseKey
        let catalog = ModelCatalog.shared.allEntries()
        let syntheticModels = model.syntheticModels
        let usageModels = model.usage.models
        Task.detached(priority: .userInitiated) { [modelSearch, modelFilterScope, modelSortColumn, modelSortAscending] in
            let result = ModelsPipeline.compute(
                search: modelSearch,
                scope: modelFilterScope,
                sortColumn: modelSortColumn,
                sortAscending: modelSortAscending,
                catalog: catalog,
                syntheticModels: syntheticModels,
                usageModels: usageModels
            )
            await MainActor.run {
                self._baseRows = result.base
                self._filteredRows = result.filtered
                self._scopeCounts = result.scopeCounts
                self._localCount = result.localCount
            }
        }
    }

    func sectionLabel(_ s: String) -> some View {
        Text(s).font(.system(size: 8, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
    }
    func stat(_ label: String, _ value: String, _ color: Color) -> some View {
        HStack(spacing: 4) {
            Text(label).font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
            MonospacedText(text: value, color: color, size: 9)
        }
    }

    static func downsample(_ values: [Double], to maxPoints: Int) -> [Double] {
        guard values.count > maxPoints else { return values }
        let stride = Double(values.count) / Double(maxPoints)
        return (0..<maxPoints).map { i in
            let start = Int(Double(i) * stride)
            let end = Swift.min(Int(Double(i + 1) * stride), values.count)
            let slice = values[start..<Swift.max(end, start + 1)]
            return slice.reduce(0, +) / Double(slice.count)
        }
    }

    static func providerNameDisplay(_ p: String) -> String {
        switch p.lowercased() {
        case "codex", "openai": return "OpenAI"
        case "kimi", "moonshot": return "Kimi"
        case "glm", "zai", "zhipu": return "GLM"
        case "minimax": return "MiniMax"
        case "opencode-go", "opencode": return "OpenCode"
        case "agy", "antigravity": return "AGY"
        case "google", "gemini": return "Google"
        case "alibaba", "qwen", "bailian": return "Alibaba"
        case "claude", "anthropic": return "Claude"
        case "deepseek": return "DeepSeek"
        default: return p
        }
    }

    static func formatReset(_ d: Date) -> String {
        let diff = d.timeIntervalSinceNow
        if diff <= 0 { return "now" }
        if diff < 3600 { return "\(Int(diff / 60))m" }
        if diff < 86400 { return "\(Int(diff / 3600))h \(Int((diff.truncatingRemainder(dividingBy: 3600)) / 60))m" }
        let days = Int(diff / 86400)
        let hours = Int((diff.truncatingRemainder(dividingBy: 86400)) / 3600)
        return "\(days)d \(hours)h"
    }

    static func toolColor(_ tool: String) -> Color {
        switch tool {
        case "opencode", "muse", "x-preview", "deepseek-v4-pro": return .green
        case "claude": return .orange
        case "codex", "MiniMax", "minimax-coding-plan": return .cyan
        case "kimi", "kimi-coding-plan": return .purple
        case "glm", "zai", "zai-coding-plan": return .yellow
        case "qwen", "qwen-coder": return .blue
        case "grok", "xai": return .pink
        case "gemini", "google": return Color(red: 0.26, green: 0.52, blue: 0.96)
        case "agy", "antigravity": return Color(red: 0.65, green: 0.45, blue: 0.95)
        case "deepseek", "alibaba", "alibaba-token-plan": return .teal
        default: return .gray
        }
    }
}

struct WingRingGauge: View {
    let percent: Double
    let color: Color
    var help: String = ""
    var body: some View {
        let clamped = Swift.min(Swift.max(percent, 0), 100)
        return ZStack {
            Circle().stroke(Color.white.opacity(0.18), lineWidth: 2.8)
            Circle()
                .trim(from: 0, to: CGFloat(max(clamped, 4) / 100))
                .stroke(color, style: StrokeStyle(lineWidth: 2.8, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .shadow(color: color.opacity(0.35), radius: 2)
            Text(String(format: "%.0f", clamped))
                .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.6)
        }
        .frame(width: 22, height: 22)
        .animation(.easeOut(duration: 0.5), value: clamped)
        .help(help)
    }
}

struct ProcessMetric: View {
    let value: Double
    let maxValue: Double
    let text: String
    let color: Color
    var gradient: Gradient? = nil
    var barWidth: CGFloat = 20
    var textWidth: CGFloat = 34
    var body: some View {
        HStack(spacing: 4) {
                MonospacedText(text: text, color: .white.opacity(0.75), size: 8)
                .frame(width: textWidth, alignment: .trailing)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.1))
                let fillWidth = max(1.5, CGFloat(barWidth * Swift.min(value / Swift.max(maxValue, 1), 1)))
                if let gradient {
                    Capsule().fill(LinearGradient(gradient: gradient, startPoint: .leading, endPoint: .trailing))
                        .frame(width: fillWidth)
                } else {
                    Capsule().fill(color.opacity(0.75)).frame(width: fillWidth)
                }
            }
            .frame(width: barWidth, height: 3)
        }
        .frame(width: barWidth + textWidth + 4, height: 12, alignment: .trailing)
    }
}

struct HeatmapGrid: View {
    let points: [HistoryPoint]
    let maxTokens: Int
    var cellSize: CGFloat = 7
    @State private var hovered: (point: HistoryPoint, col: Int, row: Int)?
    private let gap: CGFloat = 1.5
    private let tooltipWidth: CGFloat = 158
    private let weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    var body: some View {
        let cal = Calendar.current
        var weekColumns: [[HistoryPoint?]] = Array(repeating: Array(repeating: nil, count: 7), count: (points.count + 6) / 7)
        var monthAtColumn: [Int: String] = [:]
        let f = DateFormatter(); f.dateFormat = "MMM"
        for (i, point) in points.enumerated() {
            let date = Date(timeIntervalSince1970: TimeInterval(point.day))
            let weekday = cal.component(.weekday, from: date)
            let col = i / 7
            let row = (weekday + 5) % 7
            if col < weekColumns.count {
                weekColumns[col][row] = point
                if monthAtColumn[col] == nil {
                    let m = f.string(from: date)
                    let prev = col - 1
                    if prev < 0 || monthAtColumn[prev] != m { monthAtColumn[col] = m }
                }
            }
        }
        let gridWidth = CGFloat(weekColumns.count) * (cellSize + gap)
        _ = gridWidth
        let monthLabelsWidth = CGFloat(weekColumns.count) * (cellSize + gap) + 22
        return VStack(alignment: .leading, spacing: 3) {
            ZStack(alignment: .topLeading) {
                ForEach(Array(monthAtColumn.sorted(by: { $0.key < $1.key })), id: \.key) { col, month in
                    Text(month)
                        .font(.system(size: 7, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.45))
                        .offset(x: 22 + CGFloat(col) * (cellSize + gap))
                }
            }
            .frame(width: monthLabelsWidth, height: 9, alignment: .leading)
            HStack(alignment: .top, spacing: 0) {
                VStack(alignment: .trailing, spacing: gap) {
                    ForEach(0..<7, id: \.self) { row in
                        Text(weekdayLabels[row])
                            .font(.system(size: 6.5, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.4))
                            .frame(width: 20, height: cellSize, alignment: .trailing)
                    }
                }
                ZStack(alignment: .topLeading) {
                    HStack(alignment: .top, spacing: gap) {
                        ForEach(Array(weekColumns.enumerated()), id: \.offset) { col, week in
                            VStack(spacing: gap) {
                                ForEach(0..<7, id: \.self) { row in
                                    if let p = week[row] {
                                        RoundedRectangle(cornerRadius: 2)
                                            .fill(cellColor(p.tokens))
                                            .frame(width: cellSize, height: cellSize)
                                            .onHover { over in
                                                if over { hovered = (p, col, row) }
                                                else if hovered?.point.day == p.day { hovered = nil }
                                            }
                                    } else {
                                        Color.clear.frame(width: cellSize, height: cellSize)
                                    }
                                }
                            }
                        }
                    }
                    if let h = hovered {
                        tooltipCard(h.point)
                            .offset(x: tooltipX(col: h.col, totalCols: weekColumns.count) + 22,
                                    y: h.row < 3 ? 7 * (cellSize + gap) + 6 : -tooltipHeight(h.point))
                    }
                }
            }
            HStack(spacing: 3) {
                Spacer()
                Text("Less").font(.system(size: 6.5, design: .monospaced)).foregroundStyle(.white.opacity(0.35))
                ForEach(0..<6, id: \.self) { level in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(heatColor(level: Double(level) / 5.0))
                        .frame(width: 6, height: 6)
                }
                Text("More").font(.system(size: 6.5, design: .monospaced)).foregroundStyle(.white.opacity(0.35))
            }
        }
    }

    private func heatColor(level: Double) -> Color {
        Color.green.opacity(0.22 + 0.78 * level)
    }
    private func cellColor(_ tokens: Int) -> Color {
        guard tokens > 0 else { return Color.white.opacity(0.06) }
        let ratio = log(Double(tokens) + 1) / log(Double(maxTokens) + 1)
        return heatColor(level: Swift.min(ratio * 1.4, 1))
    }
    private func tooltipX(col: Int, totalCols: Int) -> CGFloat {
        let raw = CGFloat(col) * (cellSize + gap) - tooltipWidth / 2 + cellSize / 2
        let maxX = CGFloat(totalCols) * (cellSize + gap) - tooltipWidth
        return Swift.min(Swift.max(raw, 0), Swift.max(maxX, 0))
    }
    private func tooltipHeight(_ p: HistoryPoint) -> CGFloat { p.tokens > 0 ? 58 : 40 }
    private func tooltipCard(_ p: HistoryPoint) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(dayString(p.day))
                .font(.system(size: 8, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.6))
            Text(p.tokens > 0 ? "\(UsageSnapshot.tokens(p.tokens)) tokens" : "no usage")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(p.tokens > 0 ? .green : .secondary)
            if p.tokens > 0 {
                ForEach(Array(p.byTool.filter { $0.value > 0 }.sorted { $0.value > $1.value }.prefix(4)), id: \.key) { tool, tokens in
                    HStack(spacing: 3) {
                        Circle().fill(DashboardTabs.toolColor(tool)).frame(width: 3, height: 3)
                        Text(tool).font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.75))
                        Spacer()
                        Text(UsageSnapshot.tokens(tokens)).font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.55))
                    }
                }
            }
        }
        .padding(7).frame(width: tooltipWidth, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.97))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.18))))
    }
    private func dayString(_ epochDay: Int) -> String {
        DateFormatter.localizedString(from: Date(timeIntervalSince1970: TimeInterval(epochDay)),
                                      dateStyle: .medium, timeStyle: .none)
    }
}

struct HeatmapKPIs: View {
    let points: [HistoryPoint]
    var body: some View {
        let total = points.reduce(0) { $0 + $1.tokens }
        let peak = points.map { $0.tokens }.max() ?? 0
        let active = points.filter { $0.tokens > 0 }.count
        return VStack(alignment: .leading, spacing: 12) {
            kpi(UsageSnapshot.tokens(total), "Total tokens")
            kpi(UsageSnapshot.tokens(peak), "Peak tokens")
            kpi("\(active)", "Active days")
        }
    }
    private func kpi(_ value: String, _ caption: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.system(size: 14, weight: .bold, design: .monospaced))
                .foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.6)
            Text(caption).font(.system(size: 7.5, design: .monospaced)).foregroundStyle(.secondary)
        }
    }
}

struct StackedTrends: View {
    let points: [HistoryPoint]
    @State private var hovered: (point: HistoryPoint, index: Int)?
    var body: some View {
        let maxTotal = Swift.max(points.map { $0.tokens }.max() ?? 1, 1)
        return GeometryReader { geo in
            let n = Swift.max(points.count, 1)
            let barW = geo.size.width / CGFloat(n)
            let bubbleW: CGFloat = 158
            return ZStack(alignment: .topLeading) {
                HStack(alignment: .bottom, spacing: 0) {
                    ForEach(Array(points.enumerated()), id: \.offset) { i, point in
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(sortedTools(point).reversed()), id: \.0) { tool, tokens in
                                Rectangle()
                                    .fill(DashboardTabs.toolColor(tool).opacity(hovered?.index == i ? 1 : 0.88))
                                    .frame(height: barHeight(tokens, maxTotal, container: geo.size.height))
                            }
                            if point.tokens == 0 { Rectangle().fill(Color.white.opacity(0.05)).frame(height: 1) }
                        }
                        .frame(width: barW, height: geo.size.height, alignment: .bottom)
                        .contentShape(Rectangle())
                        .onHover { over in
                            if over { hovered = (point, i) }
                            else if hovered?.index == i { hovered = nil }
                        }
                    }
                }
                .frame(maxHeight: .infinity, alignment: .bottom)
                Rectangle().fill(Color.white.opacity(0.15)).frame(height: 1).frame(maxHeight: .infinity, alignment: .bottom)
                if let h = hovered, h.point.tokens > 0 {
                    let rawX = (CGFloat(h.index) + 0.5) * barW - bubbleW / 2
                    let clampedX = Swift.min(Swift.max(rawX, 0), geo.size.width - bubbleW)
                    trendTooltip(h.point).offset(x: clampedX, y: -46)
                }
            }
        }
    }
    private func barHeight(_ tokens: Int, _ maxTotal: Int, container: CGFloat) -> CGFloat {
        let ratio = sqrt(Double(tokens) / Double(maxTotal))
        return max(1.5, CGFloat(ratio * Double(container - 4)))
    }
    private func sortedTools(_ point: HistoryPoint) -> [(String, Int)] {
        point.byTool.filter { $0.value > 0 }.sorted { $0.value > $1.value }
    }
    private func trendTooltip(_ p: HistoryPoint) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(dayString(p.day))
                .font(.system(size: 8, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.6))
            Text("\(UsageSnapshot.tokens(p.tokens)) tokens")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(.green)
            ForEach(Array(sortedTools(p).prefix(4)), id: \.0) { tool, tokens in
                HStack(spacing: 3) {
                    Circle().fill(DashboardTabs.toolColor(tool)).frame(width: 3, height: 3)
                    Text(tool).font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.75))
                    Spacer()
                    Text(UsageSnapshot.tokens(tokens)).font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.55))
                }
            }
        }
        .padding(7).frame(width: 158, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.97))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.18))))
    }
    private func dayString(_ epochDay: Int) -> String {
        DateFormatter.localizedString(from: Date(timeIntervalSince1970: TimeInterval(epochDay)),
                                      dateStyle: .medium, timeStyle: .none)
    }
}

struct Sparkline: View {
    let values: [Double]
    let color: Color
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            let maxV = Swift.max(values.max() ?? 0, 1)
            let pts: [CGPoint] = values.enumerated().map { i, v in
                CGPoint(x: w * CGFloat(i) / CGFloat(Swift.max(values.count - 1, 1)),
                        y: h - 2 - (h - 4) * CGFloat(Swift.min(v, maxV) / maxV))
            }
            ZStack {
                if pts.count > 1 {
                    Path { p in
                        p.move(to: CGPoint(x: pts[0].x, y: h))
                        pts.forEach { p.addLine(to: $0) }
                        p.addLine(to: CGPoint(x: pts[pts.count - 1].x, y: h))
                        p.closeSubpath()
                    }
                    .fill(LinearGradient(colors: [color.opacity(0.32), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    Path { p in
                        p.move(to: pts[0])
                        pts.dropFirst().forEach { p.addLine(to: $0) }
                    }
                    .stroke(color.opacity(0.95), style: StrokeStyle(lineWidth: 1.4, lineCap: .round, lineJoin: .round))
                    if let last = pts.last {
                        Circle().fill(color).frame(width: 3.5, height: 3.5).position(last)
                    }
                } else {
                    Text("collecting…")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                }
            }
        }
    }
}


struct ModelRowView: View {
    let row: ModelRow
    var compact: Bool
    var showUsage: Bool = false
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 6) {
            // Model + Provider Logo
            HStack(spacing: 6) {
                ProviderLogoView(provider: row.usage.provider, model: row.usage.model, size: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.displayName)
                        .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    HStack(spacing: 3) {
                        Text(row.providerDisplay)
                            .font(.system(size: 7.5, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.45))
                            .lineLimit(1)
                        if let d = row.discountLabel {
                            Text(d)
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .padding(.horizontal, 3).padding(.vertical, 0.5)
                                .background(Capsule().fill(Color.green.opacity(0.25)))
                                .foregroundStyle(Color.green)
                        }
                        if row.isLocal {
                            Text("LOCAL")
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .padding(.horizontal, 3).padding(.vertical, 0.5)
                                .background(Capsule().fill(Color.teal.opacity(0.25)))
                                .foregroundStyle(Color.teal)
                        } else if row.catalog?.reasoning == true {
                            Text("REASONING")
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .padding(.horizontal, 3).padding(.vertical, 0.5)
                                .background(Capsule().fill(Color.indigo.opacity(0.28)))
                                .foregroundStyle(Color(red: 0.65, green: 0.65, blue: 1.0))
                        } else if row.isFree {
                            Text("FREE")
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .padding(.horizontal, 3).padding(.vertical, 0.5)
                                .background(Capsule().fill(Color.green.opacity(0.22)))
                                .foregroundStyle(Color.green)
                        }
                        if row.hostCount > 1 {
                            Text("\(row.hostCount) hosts")
                                .font(.system(size: 6.5, weight: .semibold, design: .monospaced))
                                .padding(.horizontal, 3).padding(.vertical, 0.5)
                                .background(Capsule().fill(Color.white.opacity(0.12)))
                                .foregroundStyle(Color.white.opacity(0.6))
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Context / Param Size
            VStack(alignment: .center, spacing: 1) {
                Text(row.contextText)
                    .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(row.contextText != "—" ? .white.opacity(0.85) : .secondary)
                if let q = row.usage.quant {
                    Text(q)
                        .font(.system(size: 6.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .frame(width: compact ? 42 : 52, alignment: .center)

            // Input Price / 1M
            VStack(alignment: .trailing, spacing: 0) {
                if let orig = row.originalInputPriceText {
                    Text(orig)
                        .font(.system(size: 6.5, design: .monospaced))
                        .strikethrough()
                        .foregroundStyle(.secondary)
                }
                Text(row.inputPriceText)
                    .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(row.hasDiscount ? .green : (row.inputPrice == 0 && row.isFree ? .green : .white.opacity(0.85)))
            }
            .frame(width: compact ? 52 : 62, alignment: .trailing)

            // Output Price / 1M
            VStack(alignment: .trailing, spacing: 0) {
                if let orig = row.originalOutputPriceText {
                    Text(orig)
                        .font(.system(size: 6.5, design: .monospaced))
                        .strikethrough()
                        .foregroundStyle(.secondary)
                }
                Text(row.outputPriceText)
                    .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(row.hasDiscount ? .green : (row.outputPrice == 0 && row.isFree ? .green : .white.opacity(0.85)))
            }
            .frame(width: compact ? 54 : 64, alignment: .trailing)

            // Cache Price / 1M
            VStack(alignment: .trailing, spacing: 0) {
                Text(row.cachePriceText)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.45))
            }
            .frame(width: compact ? 48 : 58, alignment: .trailing)

            // Benchmark (SWE-bench Verified)
            VStack(alignment: .trailing, spacing: 1) {
                if let swe = row.sweScore {
                    HStack(spacing: 3) {
                        Text(String(format: "%.1f%%", swe))
                            .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(swe >= 70 ? .green : (swe >= 60 ? .cyan : (swe >= 50 ? .blue : .yellow)))
                    }
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(
                        RoundedRectangle(cornerRadius: 3)
                            .fill((swe >= 70 ? Color.green : (swe >= 60 ? Color.cyan : Color.blue)).opacity(0.12))
                    )
                } else {
                    Text("—").font(.system(size: 8.5, design: .monospaced)).foregroundStyle(.secondary)
                }
            }
            .frame(width: compact ? 56 : 68, alignment: .trailing)

            // Coding (LCB)
            VStack(alignment: .trailing, spacing: 1) {
                if let lcb = row.lcbScore {
                    Text(String(format: "%.1f%%", lcb))
                        .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(.cyan.opacity(0.9))
                } else {
                    Text("—").font(.system(size: 8.5, design: .monospaced)).foregroundStyle(.secondary)
                }
            }
            .frame(width: compact ? 46 : 56, alignment: .trailing)

            // Speed (tok/s for local models)
            VStack(alignment: .trailing, spacing: 1) {
                if row.isLocal {
                    if OllamaClient.isBenchmarking(model: row.usage.model) {
                        HStack(spacing: 2) {
                            ProgressView().scaleEffect(0.5).frame(width: 10, height: 10)
                            Text("test…").font(.system(size: 7.5, design: .monospaced)).foregroundStyle(.cyan)
                        }
                    } else if let tps = row.usage.tokPerSec, tps > 0 {
                        Button {
                            OllamaClient.benchmark(model: row.usage.model)
                        } label: {
                            VStack(alignment: .trailing, spacing: 0) {
                                Text(String(format: "%.1f t/s", tps))
                                    .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(.teal)
                                if let ptps = row.promptSpeedText {
                                    Text(ptps)
                                        .font(.system(size: 6.5, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .help("Click to re-benchmark speed")
                    } else {
                        Button {
                            OllamaClient.benchmark(model: row.usage.model)
                        } label: {
                            Text("⚡ Test")
                                .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                                .padding(.horizontal, 4).padding(.vertical, 1.5)
                                .background(RoundedRectangle(cornerRadius: 3).fill(Color.cyan.opacity(0.2)))
                                .foregroundStyle(.cyan)
                        }
                        .buttonStyle(.plain)
                        .help("Benchmark tokens/sec for \(row.usage.model)")
                    }
                } else {
                    Text("API").font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.3))
                }
            }
            .frame(width: compact ? 58 : 72, alignment: .trailing)

            // Optional Usage Column
            if showUsage {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(row.usage.tokensAll > 0 ? UsageSnapshot.tokens(row.usage.tokensAll) : "—")
                        .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(row.usage.tokensAll > 0 ? .white : .secondary)
                    if row.usage.cost > 0 {
                        Text(UsageSnapshot.cost(row.usage.cost))
                            .font(.system(size: 7, design: .monospaced))
                            .foregroundStyle(.orange)
                    }
                }
                .frame(width: compact ? 74 : 90, alignment: .trailing)
            }

            // Link Out
            Group {
                if let url = row.docUrl {
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Image(systemName: "arrow.up.right.square")
                            .font(.system(size: 10.5))
                            .foregroundStyle(isHovered ? Color.white : Color.white.opacity(0.5))
                    }
                    .buttonStyle(.plain)
                    .help("Open official documentation for \(row.displayName)")
                } else {
                    Color.clear.frame(width: 14)
                }
            }
            .frame(width: 22, alignment: .center)
        }
        .padding(.vertical, 4).padding(.horizontal, 6)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.white.opacity(isHovered ? 0.05 : 0.015))
        )
        .onHover { h in isHovered = h }
    }
}

struct ModelDetailView: View {
    let row: ModelRow
    @Environment(\.dismiss) var dismiss
    @State private var ollamaCard: [String: Any]? = nil

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    ProviderLogoView(provider: row.usage.provider, model: row.usage.model, size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.displayName).font(.system(size: 16, weight: .bold, design: .monospaced)).foregroundStyle(.white)
                        Text(row.providerDisplay).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                        HStack(spacing: 4) {
                            if let d = row.discountLabel { pill(d, color: .green) }
                            if row.isLocal { pill("LOCAL", color: .teal) }
                            if row.catalog?.reasoning == true { pill("REASONING", color: .indigo) }
                            if row.catalog?.toolCall == true { pill("TOOLS", color: .cyan) }
                            if row.catalog?.vision == true { pill("VISION", color: .purple) }
                            if row.isFree { pill("FREE", color: .green) }
                        }
                    }
                    Spacer()
                    if let url = row.docUrl {
                        Button { NSWorkspace.shared.open(url) } label: {
                            Label("Docs", systemImage: "arrow.up.right.square").font(.system(size: 10, weight: .semibold, design: .monospaced))
                        }.buttonStyle(.bordered).controlSize(.small)
                    }
                }
                if let desc = row.catalog?.description, !desc.isEmpty {
                    Text(desc).font(.system(size: 10, design: .monospaced)).foregroundStyle(.white.opacity(0.75)).fixedSize(horizontal: false, vertical: true)
                        .padding(8).background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                }
                if let dDetail = row.discountDetail ?? (row.hasDiscount ? "\(row.discountLabel ?? "Promotional discount") applied" : nil) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Discounts & Promotions").font(.system(size: 9, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
                        HStack(spacing: 8) {
                            Image(systemName: "tag.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(.green)
                            Text(dDetail)
                                .font(.system(size: 9.5, design: .monospaced))
                                .foregroundStyle(.green)
                            Spacer()
                            if let pct = row.discountPercent {
                                Text("-\(pct)%")
                                    .font(.system(size: 9, weight: .heavy, design: .monospaced))
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(Capsule().fill(Color.green.opacity(0.25)))
                                    .foregroundStyle(.green)
                            }
                        }
                        .padding(8)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.green.opacity(0.08)))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.green.opacity(0.2), lineWidth: 1))
                    }
                }
                HStack(spacing: 16) {
                    detailStat("Context", row.contextText, sub: row.usage.quant != nil ? row.usage.quant! : nil)
                    detailStat("In / 1M", row.inputPriceText, sub: row.originalInputPriceText != nil ? "was \(row.originalInputPriceText!)" : nil)
                    detailStat("Out / 1M", row.outputPriceText, sub: row.originalOutputPriceText != nil ? "was \(row.originalOutputPriceText!)" : nil)
                    detailStat("Cache / 1M", row.cachePriceText, sub: nil)
                }
                if let bench = row.catalog?.benchmarks {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Benchmarks").font(.system(size: 9, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                            if let v = bench.swe { benchCard("SWE-bench Verified", v, source: bench.source) }
                            if let v = bench.lcb { benchCard("LiveCodeBench", v, source: bench.source) }
                            // DeepSWE and extended benchmarks reserved for future catalog entries
                            if row.catalog?.benchmarks != nil && bench.swe == nil && bench.lcb == nil {
                                Text("No published scores for this model variant").font(.system(size: 8.5, design: .monospaced)).foregroundStyle(.secondary)
                            }
                        }
                        if !bench.source.isEmpty {
                            Text("Source: \(bench.source)").font(.system(size: 7, design: .monospaced)).foregroundStyle(.white.opacity(0.3))
                        }
                    }
                    .padding(8).background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                }
                if row.usage.tokensAll > 0 {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Your Usage").font(.system(size: 9, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
                        HStack(spacing: 16) {
                            detailStat("Tokens", UsageSnapshot.tokens(row.usage.tokensAll), sub: "\(UsageSnapshot.tokens(row.usage.tokensToday)) today")
                            detailStat("Cost", row.costText, sub: nil)
                            if row.usage.cacheReadAll > 0 {
                                let pct = Int(Double(row.usage.cacheReadAll) / Double(max(row.usage.tokensAll, 1)) * 100)
                                detailStat("Cache hit", "\(pct)%", sub: "\(UsageSnapshot.tokens(row.usage.cacheReadAll)) cached")
                            }
                        }
                    }.padding(8).background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                }
                if row.isLocal {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Local Model Card").font(.system(size: 9, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
                        if let card = ollamaCard {
                            ForEach(Array((card["details"] as? [String: Any] ?? [:]).sorted(by: { $0.key < $1.key }).prefix(8)), id: \.key) { k, v in
                                HStack { Text(k).font(.system(size: 8, design: .monospaced)).foregroundStyle(.secondary); Spacer(); Text(String(describing: v)).font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.75)) }
                            }
                            if let mf = card["modelfile"] as? String {
                                Text(mf).font(.system(size: 7, design: .monospaced)).foregroundStyle(.white.opacity(0.35)).lineLimit(3).padding(.top, 4)
                            }
                        } else {
                            Text("Loading model card…").font(.system(size: 8.5, design: .monospaced)).foregroundStyle(.secondary)
                        }
                    }.padding(8).background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                    .onAppear { if ollamaCard == nil { ollamaCard = OllamaClient.modelCard(for: row.usage.model) } }
                }
            }.padding(16)
        }
        .frame(width: 520, height: 480)
        .background(Color(nsColor: .windowBackgroundColor))
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }
    private func pill(_ t: String, color: Color) -> some View {
        Text(t).font(.system(size: 6.5, weight: .heavy, design: .monospaced)).padding(.horizontal, 4).padding(.vertical, 1).background(Capsule().fill(color.opacity(0.22))).foregroundStyle(color)
    }
    private func detailStat(_ label: String, _ value: String, sub: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 7, weight: .heavy, design: .monospaced)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 11, weight: .bold, design: .monospaced)).foregroundStyle(.white)
            if let s = sub { Text(s).font(.system(size: 7, design: .monospaced)).foregroundStyle(.white.opacity(0.4)) }
        }
    }
    private func benchCard(_ title: String, _ value: Double, source: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 7, weight: .heavy, design: .monospaced)).foregroundStyle(.secondary)
            HStack(spacing: 4) {
                Text(String(format: "%.1f%%", value)).font(.system(size: 13, weight: .bold, design: .monospaced)).foregroundStyle(value >= 70 ? .green : value >= 60 ? .cyan : .yellow)
                Spacer()
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.1)).frame(height: 4)
                    Capsule().fill(value >= 70 ? Color.green : value >= 60 ? Color.cyan : Color.yellow).frame(width: max(2, CGFloat(value / 100 * 60)), height: 4)
                }.frame(width: 60)
            }
        }.padding(6).background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.03)))
    }
}

struct ProviderLogoView: View {
    let provider: String
    var model: String? = nil
    var size: CGFloat = 20

    var body: some View {
        let p = provider.lowercased()
        let m = (model ?? "").lowercased()

        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(brandBackground(p: p, m: m))

            brandGlyph(p: p, m: m, size: size * 0.62)
        }
        .frame(width: size, height: size)
        .overlay(
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .stroke(Color.white.opacity(0.14), lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(0.2), radius: 1, y: 0.5)
    }

    private func brandBackground(p: String, m: String) -> Color {
        if p.contains("anthropic") || p.contains("claude") || m.contains("claude") {
            return Color(red: 0.85, green: 0.47, blue: 0.34)
        }
        if p.contains("openai") || p.contains("codex") || m.contains("gpt") || m.hasPrefix("o1") || m.hasPrefix("o3") {
            return Color(red: 0.06, green: 0.64, blue: 0.50)
        }
        if p.contains("google") || p.contains("gemini") || m.contains("gemini") || m.contains("gemma") {
            return Color(red: 0.15, green: 0.40, blue: 0.94)
        }
        if p.contains("deepseek") || m.contains("deepseek") {
            return Color(red: 0.08, green: 0.52, blue: 0.92)
        }
        if p.contains("kimi") || p.contains("moonshot") || m.contains("kimi") {
            return Color(red: 0.48, green: 0.28, blue: 0.88)
        }
        if p.contains("glm") || p.contains("zai") || p.contains("zhipu") || m.contains("glm") {
            return Color(red: 0.12, green: 0.44, blue: 0.95)
        }
        if p.contains("minimax") || m.contains("minimax") {
            return Color(red: 0.95, green: 0.30, blue: 0.25)
        }
        if p.contains("alibaba") || p.contains("qwen") || p.contains("bailian") || m.contains("qwen") {
            return Color(red: 1.0, green: 0.42, blue: 0.0)
        }
        if p.contains("xai") || p.contains("grok") || m.contains("grok") {
            return Color(red: 0.14, green: 0.14, blue: 0.16)
        }
        if p.contains("ollama") {
            return Color(red: 0.18, green: 0.18, blue: 0.22)
        }
        if p.contains("mistral") || m.contains("codestral") || m.contains("mistral") {
            return Color(red: 0.95, green: 0.40, blue: 0.05)
        }
        if p.contains("meta") || m.contains("llama") {
            return Color(red: 0.0, green: 0.51, blue: 0.98)
        }
        if p.contains("agy") || p.contains("antigravity") {
            return Color(red: 0.38, green: 0.18, blue: 0.95)
        }
        if p.contains("opencode") || p.contains("muse") || m.contains("muse") || m.contains("x-preview") {
            return Color(red: 0.06, green: 0.65, blue: 0.42)
        }
        return DashboardTabs.toolColor(p).opacity(0.85)
    }

    @ViewBuilder
    private func brandGlyph(p: String, m: String, size: CGFloat) -> some View {
        if p.contains("anthropic") || p.contains("claude") || m.contains("claude") {
            // Anthropic Asterisk
            AnthropicAsteriskShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("openai") || p.contains("codex") || m.contains("gpt") || m.hasPrefix("o1") || m.hasPrefix("o3") {
            // OpenAI Flower Swirl
            OpenAISwirlShape()
                .stroke(Color.white, style: StrokeStyle(lineWidth: size * 0.14, lineCap: .round))
                .frame(width: size, height: size)
        } else if p.contains("google") || p.contains("gemini") || m.contains("gemini") || m.contains("gemma") {
            // Google Gemini 4-point Sparkle
            GeminiSparkleShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("agy") || p.contains("antigravity") {
            // Antigravity Delta
            AntigravityDeltaShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("deepseek") || m.contains("deepseek") {
            // DeepSeek Whale Fin
            DeepSeekFinShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("kimi") || p.contains("moonshot") || m.contains("kimi") {
            // Moonshot Kimi K
            Text("K")
                .font(.system(size: size * 0.9, weight: .heavy, design: .rounded))
                .foregroundStyle(Color.white)
        } else if p.contains("glm") || p.contains("zai") || p.contains("zhipu") || m.contains("glm") {
            // GLM Prism
            GLMPrismShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("minimax") || m.contains("minimax") {
            // MiniMax M
            Text("M")
                .font(.system(size: size * 0.9, weight: .heavy, design: .rounded))
                .foregroundStyle(Color.white)
        } else if p.contains("alibaba") || p.contains("qwen") || p.contains("bailian") || m.contains("qwen") {
            // Qwen Orbit
            QwenOrbitShape()
                .stroke(Color.white, style: StrokeStyle(lineWidth: size * 0.14, lineCap: .round))
                .frame(width: size, height: size)
        } else if p.contains("xai") || p.contains("grok") || m.contains("grok") {
            // Grok X
            Text("𝕏")
                .font(.system(size: size * 0.9, weight: .heavy, design: .default))
                .foregroundStyle(Color.white)
        } else if p.contains("ollama") {
            // Ollama Llama Silhouette
            OllamaLlamaShape()
                .fill(Color(red: 0.25, green: 0.90, blue: 0.70))
                .frame(width: size, height: size)
        } else if p.contains("mistral") || m.contains("codestral") || m.contains("mistral") {
            // Mistral Staircase
            MistralStepsShape()
                .fill(Color.white)
                .frame(width: size, height: size)
        } else if p.contains("meta") || m.contains("llama") {
            // Meta Infinity
            Text("∞")
                .font(.system(size: size * 1.1, weight: .bold, design: .default))
                .foregroundStyle(Color.white)
        } else if p.contains("opencode") || p.contains("muse") || m.contains("muse") || m.contains("x-preview") {
            // OpenCode Terminal Prompt
            Text(">_")
                .font(.system(size: size * 0.68, weight: .heavy, design: .monospaced))
                .foregroundStyle(Color.white)
        } else {
            let letters = String(m.prefix(2)).uppercased()
            Text(letters.isEmpty ? String(p.prefix(2)).uppercased() : letters)
                .font(.system(size: size * 0.55, weight: .heavy, design: .monospaced))
                .foregroundStyle(Color.white)
        }
    }
}

// MARK: - Custom Vector Logo Shapes

struct AntigravityDeltaShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        // Floating upward delta triangle
        path.move(to: CGPoint(x: rect.midX, y: rect.minY + h * 0.12))
        path.addLine(to: CGPoint(x: rect.maxX - w * 0.12, y: rect.maxY - h * 0.15))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.12, y: rect.maxY - h * 0.15))
        path.closeSubpath()
        return path
    }
}

struct AnthropicAsteriskShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) / 2
        let spokes = 8
        for i in 0..<spokes {
            let angle = Double(i) * (.pi * 2.0 / Double(spokes))
            let outer = CGPoint(x: center.x + CGFloat(cos(angle)) * r, y: center.y + CGFloat(sin(angle)) * r)
            path.move(to: center)
            path.addLine(to: outer)
        }
        return path.strokedPath(StrokeStyle(lineWidth: rect.width * 0.16, lineCap: .round))
    }
}

struct OpenAISwirlShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) * 0.42
        for i in 0..<6 {
            let angle = Double(i) * (.pi / 3.0)
            let p1 = CGPoint(x: center.x + CGFloat(cos(angle)) * (r * 0.4),
                             y: center.y + CGFloat(sin(angle)) * (r * 0.4))
            let p2 = CGPoint(x: center.x + CGFloat(cos(angle + 0.8)) * r,
                             y: center.y + CGFloat(sin(angle + 0.8)) * r)
            path.move(to: p1)
            path.addQuadCurve(to: p2, control: CGPoint(x: center.x + CGFloat(cos(angle + 0.4)) * (r * 1.1),
                                                       y: center.y + CGFloat(sin(angle + 0.4)) * (r * 1.1)))
        }
        return path
    }
}

struct GeminiSparkleShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let w = rect.width / 2
        let h = rect.height / 2
        let pinch: CGFloat = 0.22

        path.move(to: CGPoint(x: c.x, y: c.y - h))
        path.addQuadCurve(to: CGPoint(x: c.x + w, y: c.y), control: CGPoint(x: c.x + w * pinch, y: c.y - h * pinch))
        path.addQuadCurve(to: CGPoint(x: c.x, y: c.y + h), control: CGPoint(x: c.x + w * pinch, y: c.y + h * pinch))
        path.addQuadCurve(to: CGPoint(x: c.x - w, y: c.y), control: CGPoint(x: c.x - w * pinch, y: c.y + h * pinch))
        path.addQuadCurve(to: CGPoint(x: c.x, y: c.y - h), control: CGPoint(x: c.x - w * pinch, y: c.y - h * pinch))
        path.closeSubpath()
        return path
    }
}

struct DeepSeekFinShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        path.move(to: CGPoint(x: rect.minX + w * 0.15, y: rect.maxY - h * 0.15))
        path.addCurve(to: CGPoint(x: rect.minX + w * 0.85, y: rect.minY + h * 0.25),
                      control1: CGPoint(x: rect.minX + w * 0.3, y: rect.minY + h * 0.8),
                      control2: CGPoint(x: rect.minX + w * 0.6, y: rect.minY + h * 0.3))
        path.addQuadCurve(to: CGPoint(x: rect.minX + w * 0.55, y: rect.maxY - h * 0.15),
                          control: CGPoint(x: rect.minX + w * 0.8, y: rect.maxY - h * 0.3))
        path.closeSubpath()
        return path
    }
}

struct GLMPrismShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let w = rect.width * 0.45
        let h = rect.height * 0.45
        path.move(to: CGPoint(x: c.x, y: c.y - h))
        path.addLine(to: CGPoint(x: c.x + w, y: c.y))
        path.addLine(to: CGPoint(x: c.x, y: c.y + h))
        path.addLine(to: CGPoint(x: c.x - w, y: c.y))
        path.closeSubpath()
        return path
    }
}

struct QwenOrbitShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        path.addEllipse(in: CGRect(x: rect.minX + w * 0.1, y: rect.minY + h * 0.1, width: w * 0.8, height: h * 0.8))
        path.move(to: CGPoint(x: rect.minX + w * 0.6, y: rect.minY + h * 0.6))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.9, y: rect.minY + h * 0.9))
        return path
    }
}

struct OllamaLlamaShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        // Llama head profile & ears
        path.move(to: CGPoint(x: rect.minX + w * 0.25, y: rect.maxY - h * 0.15))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.25, y: rect.minY + h * 0.35))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.38, y: rect.minY + h * 0.1)) // Left ear
        path.addLine(to: CGPoint(x: rect.minX + w * 0.48, y: rect.minY + h * 0.35))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.60, y: rect.minY + h * 0.1)) // Right ear
        path.addLine(to: CGPoint(x: rect.minX + w * 0.70, y: rect.minY + h * 0.35))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.85, y: rect.minY + h * 0.55)) // Snout
        path.addLine(to: CGPoint(x: rect.minX + w * 0.85, y: rect.minY + h * 0.75))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.65, y: rect.minY + h * 0.85))
        path.addLine(to: CGPoint(x: rect.minX + w * 0.65, y: rect.maxY - h * 0.15))
        path.closeSubpath()
        return path
    }
}

struct MistralStepsShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        let barW = w * 0.18
        // 4 stepping blocks
        let heights: [CGFloat] = [0.35, 0.65, 0.95, 0.50]
        for (i, bh) in heights.enumerated() {
            let x = rect.minX + CGFloat(i) * (w * 0.24)
            let y = rect.maxY - h * bh
            path.addRoundedRect(in: CGRect(x: x, y: y, width: barW, height: h * bh), cornerSize: CGSize(width: 1, height: 1))
        }
        return path
    }
}
