import SwiftUI

struct DashboardTabs: View {
    @ObservedObject var model: UIModel
    var compact: Bool = true
    @State private var tab: DashboardTab = .activity
    @State private var heatmapExpanded = false
    @State private var cookieDraft: String = ""
    @State private var notifyDraft: Bool = true
    @State private var surfaceDraft: SurfaceMode = SettingsStore.shared.surfaceMode
    @State private var trayDraft: Bool = SettingsStore.shared.showTrayIcon
    @State private var launchDraft: Bool = false
    @State private var persistenceDraft: Bool = true
    @State private var cacheStatusMessage: String? = nil
    @State private var modelSearch: String = ""
    @State private var modelSortColumn: ModelTableColumn = .sweBench
    @State private var modelSortAscending: Bool = false
    @State private var modelFilterScope: ModelFilterScope = .all
    @State private var showUsageColumn: Bool = false
    @State private var procSearch: String = ""
    @State private var procSort: String = "cpu"
    @State private var procSortAscending: Bool = false
    @State private var selectedRow: ModelRow?
    @State private var selectedMLXProcess: MLXProcess?
    @State private var mlxWindow: MLXWindow = .h1
    @State private var planHoveredId: String?
    @State private var planViewportH: CGFloat = 600
    @State private var leaderboardPeriod: LeaderboardPeriod = .today
    @State private var leaderboardTeamFilter: String = ""
    @State private var leaderboardShareFormat: ShareCardFormat = .markdown
    @State private var leaderboardCopiedNotice: Bool = false
    @State private var leaderboardPublishing: Bool = false
    @State private var leaderboardPublishNotice: String? = nil
    @State private var selectedLeaderboardEntry: LeaderboardRankedEntry? = nil
    @State private var leaderboardHandleDraft: String = SettingsStore.shared.leaderboardHandle
    @State private var leaderboardTeamDraft: String = SettingsStore.shared.leaderboardTeam
    @State private var leaderboardShareCostDraft: Bool = SettingsStore.shared.leaderboardShareCost
    @State private var leaderboardShareHwDraft: Bool = SettingsStore.shared.leaderboardShareHardware
    @State private var leaderboardSheetsDraft: String = SettingsStore.shared.leaderboardSheetsURL
    @State private var leaderboardCloudDraft: String = SettingsStore.shared.leaderboardCloudURL
    @State private var leaderboardCloudTokenDraft: String = SettingsStore.shared.leaderboardCloudToken
    @State private var leaderboardAutoSyncDraft: Bool = SettingsStore.shared.leaderboardAutoSync
    @State private var leaderboardSheetsNotice: String? = nil
    @State private var leaderboardShowConfig: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            tabBar
            Divider().overlay(Color.white.opacity(0.12))
            ScrollView(.vertical, showsIndicators: false) {
                switch tab {
                case .activity: activityTab
                case .mlx: mlxTab
                case .tokens: tokensTab
                case .models: modelsTab
                case .shells: shellsTab
                case .leaderboard: leaderboardTab
                case .settings: settingsTab
                }
            }
            .coordinateSpace(name: "dashboardScroll")
            .background(
                GeometryReader { geo in
                    Color.clear
                        .onAppear { planViewportH = geo.size.height }
                        .onChange(of: geo.size.height) { _ in planViewportH = geo.size.height }
                }
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear { NotificationCenter.default.post(name: .refreshTrends, object: nil) }
        .sheet(item: $selectedMLXProcess) { process in
            MLXRunnerDetailView(process: process)
        }
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
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            Spacer()
            Button { NotificationCenter.default.post(name: NSNotification.Name("openDashboard"), object: nil) } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
                    .padding(4)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Open dashboard window")
            if compact {
                Button { NSApp.terminate(nil) } label: {
                    Image(systemName: "power").font(.system(size: 10)).foregroundStyle(.white.opacity(0.5))
                        .padding(4)
                        .contentShape(Rectangle())
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

    private var mlxTab: some View {
        let localllm = OllamaTelemetryStore.shared.summary()
        let cpuSeries = model.mlxCPUSeries(mlxWindow)
        let memSeries = model.mlxMemorySeries(mlxWindow)
        let diskSeries = model.mlxDiskSeries(mlxWindow)
        let tokSeries = model.mlxTokSeries(mlxWindow)
        let peakTok = model.mlxPeakTok(mlxWindow)
        let peakCPU = model.mlxPeakCPU(mlxWindow)
        let peakMem = model.mlxPeakMemory(mlxWindow)
        let peakDisk = model.mlxPeakDisk(mlxWindow)

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                sectionLabel("MLX & LOCAL OBSERVABILITY")
                Spacer()
                MonospacedText(
                    text: model.mlx.processes.isEmpty ? "IDLE" : "ACTIVE · \(model.mlx.processes.count) PROCS",
                    color: model.mlx.processes.isEmpty ? .secondary : .green,
                    size: 8
                )
            }
            if let proxyPort = OllamaTelemetryProxy.shared.port {
                MonospacedText(text: "telemetry proxy 127.0.0.1:\(proxyPort) · point Ollama-compatible clients here for exact tok/s", color: .white.opacity(0.35), size: 7.5)
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

            HStack(spacing: 8) {
                mlxStat("CPU", model.mlx.processes.isEmpty ? (peakCPU > 0 ? String(format: "peak %.1f%%", peakCPU) : "0.0%") : String(format: "%.1f%%", model.mlx.cpuPercent), .red)
                mlxStat("MEM", model.mlx.processes.isEmpty ? (peakMem > 0 ? "peak " + formatMemory(peakMem) : "0M") : formatMemory(model.mlx.memoryMB), .cyan)
                mlxStat("READ", model.mlx.processes.isEmpty ? (peakDisk > 0 ? String(format: "peak %.1fM", peakDisk) : "0.0M/s") : String(format: "%.1fM/s", model.mlx.diskReadMBps), .orange)
                mlxStat("WRITE", model.mlx.processes.isEmpty ? "0.0M/s" : String(format: "%.1fM/s", model.mlx.diskWriteMBps), .yellow)
                mlxStat("TOK/S", (model.mlx.measuredTokPerSec ?? (peakTok > 0 ? peakTok : nil)).map { String(format: "%.1f", $0) } ?? "--", .green)
            }

            HStack(spacing: 8) {
                mlxSparkline("CPU \(mlxWindow.rawValue)", cpuSeries, .red)
                mlxSparkline("MEM \(mlxWindow.rawValue)", memSeries, .cyan)
                mlxSparkline("DISK \(mlxWindow.rawValue)", diskSeries, .orange)
                mlxSparkline("TOK/S \(mlxWindow.rawValue)", tokSeries, .green)
            }

            Divider().overlay(Color.white.opacity(0.12))

            sectionLabel("LOCAL TOKEN USAGE")
            HStack(spacing: 12) {
                stat("today", UsageSnapshot.tokens(localllm.todayTokens), .green)
                stat("all-time", UsageSnapshot.tokens(localllm.allTokens), .secondary)
                stat("requests", "\(localllm.messagesAll)", .orange)
                if peakTok > 0 {
                    stat("peak speed", String(format: "%.1f t/s", peakTok), Color(red: 0.18, green: 0.82, blue: 0.72))
                }
                Spacer()
            }

            if !localllm.models.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(localllm.models.keys.sorted()), id: \.self) { modelKey in
                        if let stats = localllm.models[modelKey], stats.all > 0 {
                            HStack(spacing: 6) {
                                Circle().fill(Color(red: 0.18, green: 0.82, blue: 0.72)).frame(width: 3.5, height: 3.5)
                                MonospacedText(text: modelKey, color: .white.opacity(0.85), size: 9)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                MonospacedText(text: "\(UsageSnapshot.tokens(stats.prompt)) in · \(UsageSnapshot.tokens(stats.eval)) out", color: .white.opacity(0.45), size: 7.5)
                                MonospacedText(text: UsageSnapshot.tokens(stats.today), color: .green, size: 9).frame(width: 44, alignment: .trailing)
                                MonospacedText(text: UsageSnapshot.tokens(stats.all), color: .white.opacity(0.7), size: 9).frame(width: 44, alignment: .trailing)
                            }
                        }
                    }
                }
            }

            Divider().overlay(Color.white.opacity(0.12))

            sectionLabel("RUNNERS")
            if model.mlx.processes.isEmpty {
                MonospacedText(text: "no active MLX runner", color: .secondary, size: 9)
                MonospacedText(text: "watching Ollama --mlx-engine and mlx-lm process trees", color: .white.opacity(0.4), size: 7.5)
            } else {
                ForEach(model.mlx.processes) { process in
                    Button { selectedMLXProcess = process } label: {
                        HStack(spacing: 6) {
                            Circle().fill(process.cpu > 50 ? Color.red : .green).frame(width: 4, height: 4)
                            MonospacedText(text: "\(process.pid)", color: .secondary, size: 8)
                            MonospacedText(text: process.model ?? process.name, color: .white.opacity(0.85), size: 9)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            MonospacedText(text: String(format: "%.1f%%", process.cpu), color: .orange, size: 8)
                            MonospacedText(text: formatMemory(process.memoryMB), color: .cyan, size: 8)
                            MonospacedText(text: process.tokPerSec.map { String(format: "%.1f t/s", $0) } ?? "-- t/s", color: .green, size: 8)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            MonospacedText(text: "tok/s is a recent token-weighted Ollama measurement; live request instrumentation is not inferred from process load.", color: .white.opacity(0.35), size: 7.5)
                .fixedSize(horizontal: false, vertical: true)
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
    @State private var procDockerDetail: DockerContainerSample? = nil
    @State private var procVisibleCount: Int = 30
    @State private var procExpandedPids: Set<Int32> = []
    @State private var procExpandedDockerPids: Set<Int32> = []

    enum ProcSortKey: String, CaseIterable, Identifiable {
        case cpu, mem, disk, net, pid, name, user, time
        var id: String { rawValue }
    }

    private var processesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                sectionLabel("PROCESSES — htop style")
                Spacer()
                MonospacedText(text: String(format: "%d procs%@ · sys %.0f%% · %.1f/%.0fG",
                                             model.allProcesses.count,
                                             model.dockerContainers.isEmpty ? "" : String(format: " · %d containers", model.dockerContainers.count),
                                             model.sys.cpuPercent,
                                             model.sys.ramUsedGB, model.sys.ramTotalGB),
                               color: .secondary, size: 8)
            }
            // Filter row + tree toggle
            HStack(spacing: 6) {
                HStack(spacing: 5) {
                    Image(systemName: "magnifyingglass").font(.system(size: 8)).foregroundStyle(.white.opacity(0.4))
                    TextField("filter by name, pid, user, or container…", text: $procSearch)
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
                    let maxMem = Swift.max(rows.compactMap { $0.proc?.memMB ?? $0.container?.memMB }.max() ?? 1, 1)
                    if rows.isEmpty {
                        MonospacedText(text: "no processes match filter", color: .secondary, size: 9)
                            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 12)
                    } else {
                        ForEach(rows) { row in
                            procRowView(row, maxCPU: maxCPU, maxMem: maxMem)
                                .onTapGesture {
                                    if let p = row.proc {
                                        inspectProcess(p)
                                    } else if let c = row.container {
                                        procDockerDetail = c
                                    }
                                }
                                .onAppear {
                                    // Infinite scroll: when last row appears, expand
                                    if row.id == rows.last?.id && procVisibleCount < procFullCount {
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
            .sheet(item: $procDockerDetail) { c in
                dockerContainerDetailSheet(c)
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
            if let key {
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

    private struct ProcDisplayRow: Identifiable {
        let proc: ProcSample?
        let container: DockerContainerSample?
        let depth: Int        // 0 for roots, 1+ for children (tree mode)
        let hasChildren: Bool // tree mode only
        let isDockerRoot: Bool
        let isDockerExpanded: Bool
        let dockerContainerCount: Int

        var id: String {
            if let c = container {
                return "docker-\(c.id)"
            } else if let p = proc {
                return "proc-\(p.pid)"
            }
            return UUID().uuidString
        }
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

        let dockerCount = model.dockerContainers.count
        let primaryDockerPid = DockerObserver.findPrimaryDockerPid(in: model.allProcesses)
        let matchingContainers: [DockerContainerSample] = {
            if q.isEmpty { return model.dockerContainers }
            return model.dockerContainers.filter {
                $0.name.lowercased().contains(q)
                || $0.id.lowercased().contains(q)
                || $0.image.lowercased().contains(q)
                || $0.ports.lowercased().contains(q)
            }
        }()

        var result: [ProcDisplayRow] = []
        for proc in list {
            let isPrimaryHost = (proc.pid == primaryDockerPid) && dockerCount > 0
            let isExpanded = isPrimaryHost && procExpandedDockerPids.contains(proc.pid)
            result.append(ProcDisplayRow(
                proc: proc,
                container: nil,
                depth: 0,
                hasChildren: isPrimaryHost,
                isDockerRoot: isPrimaryHost,
                isDockerExpanded: isExpanded,
                dockerContainerCount: dockerCount
            ))

            if isExpanded {
                for c in matchingContainers {
                    result.append(ProcDisplayRow(
                        proc: nil,
                        container: c,
                        depth: 1,
                        hasChildren: false,
                        isDockerRoot: false,
                        isDockerExpanded: false,
                        dockerContainerCount: 0
                    ))
                }
            }
            if result.count >= procVisibleCount { break }
        }

        // If search matches containers directly and primary docker host was not expanded/shown, append matching containers
        if !q.isEmpty && !matchingContainers.isEmpty {
            let existingIDs = Set(result.compactMap { $0.container?.id })
            for c in matchingContainers where !existingIDs.contains(c.id) {
                result.append(ProcDisplayRow(
                    proc: nil,
                    container: c,
                    depth: 0,
                    hasChildren: false,
                    isDockerRoot: false,
                    isDockerExpanded: false,
                    dockerContainerCount: 0
                ))
            }
        }

        return result
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

        let dockerCount = model.dockerContainers.count
        let primaryDockerPid = DockerObserver.findPrimaryDockerPid(in: model.allProcesses)
        let matchingContainers: [DockerContainerSample] = {
            if q.isEmpty { return model.dockerContainers }
            return model.dockerContainers.filter {
                $0.name.lowercased().contains(q)
                || $0.id.lowercased().contains(q)
                || $0.image.lowercased().contains(q)
                || $0.ports.lowercased().contains(q)
            }
        }()

        var childrenByParent: [Int32: [ProcSample]] = [:]
        for proc in procs {
            let parentPid = DockerObserver.effectiveParentPid(for: proc, in: procs)
            childrenByParent[parentPid, default: []].append(proc)
        }
        let pids = Set(procs.map(\.pid))
        let roots = procs.filter {
            let parentPid = DockerObserver.effectiveParentPid(for: $0, in: procs)
            return parentPid == 0 || !pids.contains(parentPid)
        }.sorted(by: comparator)

        var result: [ProcDisplayRow] = []
        var visited = Set<Int32>()

        func visit(_ proc: ProcSample, depth: Int) {
            guard !visited.contains(proc.pid), result.count < procVisibleCount else { return }
            visited.insert(proc.pid)
            let children = (childrenByParent[proc.pid] ?? []).sorted(by: comparator)
            let isPrimaryHost = (proc.pid == primaryDockerPid) && dockerCount > 0
            let hasAnyChildren = !children.isEmpty || isPrimaryHost
            let isDockerExpanded = isPrimaryHost && procExpandedDockerPids.contains(proc.pid)

            result.append(ProcDisplayRow(
                proc: proc,
                container: nil,
                depth: depth,
                hasChildren: hasAnyChildren,
                isDockerRoot: isPrimaryHost,
                isDockerExpanded: isDockerExpanded,
                dockerContainerCount: dockerCount
            ))

            if isDockerExpanded {
                for c in matchingContainers {
                    result.append(ProcDisplayRow(
                        proc: nil,
                        container: c,
                        depth: depth + 1,
                        hasChildren: false,
                        isDockerRoot: false,
                        isDockerExpanded: false,
                        dockerContainerCount: 0
                    ))
                }
            }

            guard procExpandedPids.contains(proc.pid) else { return }
            for child in children { visit(child, depth: depth + 1) }
        }

        for root in roots {
            visit(root, depth: 0)
            if result.count >= procVisibleCount { break }
        }
        if result.count < procVisibleCount {
            for proc in procs.sorted(by: comparator) where !visited.contains(proc.pid) {
                visit(proc, depth: 0)
                if result.count >= procVisibleCount { break }
            }
        }
        return result
    }

    private var procFullCount: Int {
        let baseCount = procTreeMode ? SystemStats.buildProcessTree(model.allProcesses).count : model.allProcesses.count
        return baseCount + model.dockerContainers.count
    }

    // MARK: - Single row view

    @ViewBuilder
    private func procRowView(_ row: ProcDisplayRow, maxCPU: Double, maxMem: Double) -> some View {
        if let c = row.container {
            procContainerRowView(c, depth: row.depth, maxCPU: maxCPU, maxMem: maxMem)
        } else if let proc = row.proc {
            procProcessRowView(row, proc: proc, maxCPU: maxCPU, maxMem: maxMem)
        }
    }

    private func procProcessRowView(_ row: ProcDisplayRow, proc: ProcSample, maxCPU: Double, maxMem: Double) -> some View {
        let memBar = min(proc.memMB / maxMem * 100, 100)
        let uptimeStr = formatUptime(Date().timeIntervalSince(proc.startTime))
        let indent = procTreeMode ? CGFloat(row.depth) * 8.0 : 0
        let isVM = proc.name.lowercased().contains("virtualmachine") || proc.command.lowercased().contains("virtualmachine")

        return HStack(spacing: 4) {
            // Tree chevron / indent
            HStack(spacing: 0) {
                if row.isDockerRoot {
                    Button {
                        if procExpandedDockerPids.contains(proc.pid) {
                            procExpandedDockerPids.remove(proc.pid)
                        } else {
                            procExpandedDockerPids.insert(proc.pid)
                        }
                    } label: {
                        Image(systemName: row.isDockerExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 7, weight: .bold))
                            .foregroundStyle(.cyan)
                    }
                    .buttonStyle(.plain)
                } else if procTreeMode && row.hasChildren {
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
            let totalContainerMemMB = model.dockerContainers.reduce(0.0) { $0 + $1.memMB }
            HStack(spacing: 4) {
                MonospacedText(text: isVM && row.isDockerRoot ? "Docker LinuxKit VM (VM Alloc: \(formatMemory(proc.memMB)))" : truncatedCommand(proc.command.isEmpty ? proc.name : proc.command),
                               color: .white.opacity(0.85), size: 8)
                    .lineLimit(1).truncationMode(.tail)
                if row.isDockerRoot {
                    Button {
                        if procExpandedDockerPids.contains(proc.pid) {
                            procExpandedDockerPids.remove(proc.pid)
                        } else {
                            procExpandedDockerPids.insert(proc.pid)
                        }
                    } label: {
                        HStack(spacing: 2) {
                            Text("🐳")
                                .font(.system(size: 7))
                            if totalContainerMemMB > 0 {
                                Text(row.isDockerExpanded ? "\(row.dockerContainerCount) CONTAINERS (active \(formatMemory(totalContainerMemMB))) ▼" : "\(row.dockerContainerCount) CONTAINERS · \(formatMemory(totalContainerMemMB)) active ▶")
                                    .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                            } else {
                                Text(row.isDockerExpanded ? "\(row.dockerContainerCount) CONTAINERS ▼" : "\(row.dockerContainerCount) CONTAINERS ▶")
                                    .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                            }
                        }
                        .foregroundStyle(Color.cyan)
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(Capsule().fill(Color.cyan.opacity(0.14)))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(procSelectedPid == proc.pid ? Color.white.opacity(0.08) : Color.clear)
    }

    private func procContainerRowView(_ c: DockerContainerSample, depth: Int, maxCPU: Double, maxMem: Double) -> some View {
        let memBar = min(c.memMB / maxMem * 100, 100)
        let indent = CGFloat(max(1, depth)) * 8.0

        return HStack(spacing: 4) {
            // Indent + whale icon
            HStack(spacing: 2) {
                Spacer().frame(width: indent)
                Text("🐳")
                    .font(.system(size: 7))
            }
            .frame(width: 12 + indent, alignment: .leading)

            MonospacedText(text: c.id, color: .cyan.opacity(0.9), size: 7.5)
                .frame(width: 38, alignment: .leading).lineLimit(1)
            HStack(spacing: 2) {
                Text("docker")
                    .font(.system(size: 6.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(.cyan.opacity(0.8))
            }
            .frame(width: 48, alignment: .leading)

            // CPU bar + value
            ProcessMetric(value: c.cpu, maxValue: maxCPU, text: String(format: "%5.1f", c.cpu),
                          color: c.cpu > 50 ? .red : c.cpu > 5 ? .orange : .cyan,
                          barWidth: 30, textWidth: 33)
                .frame(width: 68, alignment: .trailing)
            // MEM bar
            ProcessMetric(value: memBar, maxValue: 100, text: formatMemory(c.memMB),
                          color: .cyan,
                          gradient: Gradient(colors: [.cyan, .blue, .purple, .pink]),
                          barWidth: 30, textWidth: 33)
                .frame(width: 68, alignment: .trailing)
            MonospacedText(text: String(format: "%.1fM", c.diskReadMB + c.diskWriteMB),
                           color: .white.opacity(0.7), size: 8).frame(width: 36, alignment: .trailing)
            MonospacedText(text: String(format: "%.0fM", c.netInMB + c.netOutMB),
                           color: .white.opacity(0.7), size: 8).frame(width: 36, alignment: .trailing)
            MonospacedText(text: c.pids > 0 ? "\(c.pids)p" : "UP", color: .white.opacity(0.6), size: 8).frame(width: 32, alignment: .trailing)

            HStack(spacing: 4) {
                MonospacedText(text: c.name, color: .cyan, size: 8)
                    .lineLimit(1)
                if !c.image.isEmpty {
                    MonospacedText(text: "(\(c.image))", color: .white.opacity(0.4), size: 7.5)
                        .lineLimit(1).truncationMode(.middle)
                }
                if !c.ports.isEmpty {
                    MonospacedText(text: c.ports, color: .white.opacity(0.3), size: 7)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.cyan.opacity(0.05))
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
            if d.pid == DockerObserver.findPrimaryDockerPid(in: model.allProcesses) && !model.dockerContainers.isEmpty {
                let totalContainerMem = model.dockerContainers.reduce(0.0) { $0 + $1.memMB }
                let totalContainerCpu = model.dockerContainers.reduce(0.0) { $0 + $1.cpu }
                Divider()
                HStack {
                    Text("🐳").font(.system(size: 8))
                    MonospacedText(text: "DOCKER RUNTIME SUMMARY", color: .cyan, size: 8)
                    Spacer()
                    MonospacedText(text: "\(model.dockerContainers.count) active containers", color: .secondary, size: 7.5)
                }
                procDetailRow("active ram", String(format: "%.1f MB (%.2f GB across %d containers)", totalContainerMem, totalContainerMem / 1024, model.dockerContainers.count), color: .cyan)
                procDetailRow("host vm alloc", String(format: "%.1f MB (%.2f GB hypervisor reservation)", d.memMB, d.memMB / 1024), color: .orange)
                procDetailRow("vm overhead", String(format: "%.1f GB (LinuxKit kernel + buffer cache)", max(0, (d.memMB - totalContainerMem) / 1024)), color: .secondary)
                procDetailRow("containers cpu", String(format: "%.1f%% cumulative", totalContainerCpu), color: .cyan)
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
                    _ = SystemStats.killProcess(pid: d.pid, signal: 15)
                    procDetail = nil
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                Button("SIGKILL") {
                    _ = SystemStats.killProcess(pid: d.pid, signal: 9)
                    procDetail = nil
                }
                .buttonStyle(.bordered)
                .tint(.red)
            }
        }
        .padding(14)
        .frame(width: 500, height: children.isEmpty ? 420 : 530)
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

    private func dockerContainerDetailSheet(_ c: DockerContainerSample) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text("🐳").font(.system(size: 11))
                        MonospacedText(text: "DOCKER CONTAINER", color: .cyan, size: 9)
                    }
                    MonospacedText(text: c.name, color: .white, size: 12)
                }
                Spacer()
                Button("Close") { procDockerDetail = nil }
                    .buttonStyle(.borderless)
            }
            Divider()
            procDetailRow("container id", c.id, mono: true)
            procDetailRow("image", c.image.isEmpty ? "unknown" : c.image, color: .cyan)
            if !c.status.isEmpty {
                procDetailRow("status", c.status, color: .green)
            }
            if !c.ports.isEmpty {
                procDetailRow("ports", c.ports, mono: true)
            }
            procDetailRow("cpu", String(format: "%.2f%%", c.cpu), color: c.cpu > 50 ? .red : c.cpu > 5 ? .orange : .cyan)
            procDetailRow("memory", String(format: "%.1f MB (%.2f%% of %.1f GB VM pool)", c.memMB, c.memPercent, c.memLimitMB / 1024),
                          color: c.memMB > 1024 ? .red : c.memMB > 256 ? .orange : .cyan)
            procDetailRow("network i/o", String(format: "%.2f MB in / %.2f MB out", c.netInMB, c.netOutMB))
            procDetailRow("block i/o", String(format: "%.2f MB read / %.2f MB write", c.diskReadMB, c.diskWriteMB))
            if c.pids > 0 {
                procDetailRow("pids/threads", "\(c.pids)")
            }
            Spacer()
        }
        .padding(14)
        .frame(width: 480, height: 320)
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
            if !model.usage.claudeAccounts.isEmpty {
                sectionLabel("CLAUDE PROFILES (\(model.usage.claudeAccounts.count))")
                VStack(spacing: 3) {
                    ForEach(model.usage.claudeAccounts) { acct in
                        HStack(spacing: 6) {
                            Circle().fill(Color.orange).frame(width: 4, height: 4)
                            Text(acct.label)
                                .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.95))
                                .frame(width: 95, alignment: .leading)
                            Text(acct.email.isEmpty ? acct.id : acct.email)
                                .font(.system(size: 7.5, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            MonospacedText(text: "\(UsageSnapshot.tokens(acct.tokensToday)) today", color: .green, size: 8.5)
                                .frame(width: 80, alignment: .trailing)
                            MonospacedText(text: UsageSnapshot.tokens(acct.tokensAllTime), color: .white.opacity(0.6), size: 8.5)
                                .frame(width: 52, alignment: .trailing)
                            MonospacedText(text: UsageSnapshot.cost(acct.costToday), color: .orange, size: 8.5)
                                .frame(width: 46, alignment: .trailing)
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.025)))
                    }
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
                            Circle().fill(m.isLocal ? Color(red: 0.18, green: 0.82, blue: 0.72) : m.free ? Color.green.opacity(0.6) : Color.orange).frame(width: 3.5, height: 3.5)
                            MonospacedText(text: m.model, color: .white.opacity(0.85), size: 9)
                            MonospacedText(text: m.isLocal ? "\(m.provider) (local)" : m.provider, color: .white.opacity(0.4), size: 7.5).frame(maxWidth: .infinity, alignment: .leading)
                            MonospacedText(text: m.sharePercent > 0 ? m.shareText : "", color: .white.opacity(0.45), size: 8).frame(width: 38, alignment: .trailing)
                            MonospacedText(text: UsageSnapshot.tokens(m.tokensToday), color: .green, size: 9).frame(width: 44, alignment: .trailing)
                            MonospacedText(text: m.isLocal ? "local" : m.free ? "free" : UsageSnapshot.cost(m.cost),
                                           color: m.isLocal ? Color(red: 0.18, green: 0.82, blue: 0.72) : m.free ? .green.opacity(0.7) : .orange, size: 9)
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
            let limitRows = DashboardTabs.assembleLimitRows(
                usageLimits: model.usage.limits,
                planLimits: model.planLimits,
                kimiLimits: model.kimiLimits)
            let unifiedRows = buildUnifiedPlanRows(from: limitRows)

            if !unifiedRows.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        sectionLabel("PLAN LIMITS & REFRESH TRACKER")
                        Spacer()
                        if let next = unifiedRows.first(where: { ($0.cycleLimit?.resetsAt?.timeIntervalSinceNow ?? 0) > 0 }),
                           let resetDate = next.cycleLimit?.resetsAt {
                            let diff = resetDate.timeIntervalSinceNow
                            let isUrgent = diff < 86_400
                            HStack(spacing: 4) {
                                Circle().fill(isUrgent ? Color.orange : Color.green).frame(width: 5, height: 5)
                                Text("NEXT REFRESH: \(next.displayName) in \(DashboardTabs.formatResetShort(resetDate))")
                                    .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(isUrgent ? Color.orange : Color.white.opacity(0.85))
                            }
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(isUrgent ? Color.orange.opacity(0.18) : Color.white.opacity(0.06)))
                        }
                    }

                    // Column Header Row
                    HStack(spacing: 6) {
                        Text("PROVIDER / PROFILE")
                            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.4))
                            .frame(width: 130, alignment: .leading)

                        Text("BURST (5H)")
                            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.4))
                            .frame(width: 95, alignment: .leading)

                        Text("WEEKLY HEADROOM")
                            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.4))
                            .frame(width: 130, alignment: .leading)

                        Text("RESETS IN")
                            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.4))
                            .frame(width: 85, alignment: .leading)

                        Text("LOCAL REFRESH")
                            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.4))
                            .frame(width: 110, alignment: .leading)

                        Text("PRIORITY")
                            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.4))
                            .frame(width: 76, alignment: .trailing)
                    }
                    .padding(.horizontal, 6)
                    .padding(.top, 2)

                    // Data Rows
                    VStack(spacing: 3) {
                        ForEach(unifiedRows) { row in
                            let isUrgent = (row.cycleLimit?.resetsAt?.timeIntervalSinceNow ?? .infinity) < 86_400
                            let isSoon = (row.cycleLimit?.resetsAt?.timeIntervalSinceNow ?? .infinity) < 172_800
                            HStack(spacing: 6) {
                                // Column 1: Provider / Profile (width: 130)
                                HStack(spacing: 5) {
                                    ProviderLogoView(provider: row.logoProvider, size: 14)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(row.displayName)
                                            .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                                            .foregroundStyle(.white.opacity(0.95))
                                            .lineLimit(1)
                                        Text(row.subtitle)
                                            .font(.system(size: 7, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }
                                .frame(width: 130, alignment: .leading)

                                // Column 2: Burst (5h / interval / rolling) (width: 95)
                                if let b = row.burstLimit {
                                    HStack(spacing: 4) {
                                        let cleanLabel = b.label
                                            .replacingOccurrences(of: "gemini ", with: "")
                                            .replacingOccurrences(of: "3p ", with: "")
                                        Text(cleanLabel)
                                            .font(.system(size: 7, design: .monospaced))
                                            .foregroundStyle(.white.opacity(0.5))
                                            .frame(width: 22, alignment: .leading)
                                        ZStack(alignment: .leading) {
                                            Capsule().fill(Color.white.opacity(0.12))
                                            Capsule().fill(b.usedPercent >= 100 ? Color.red : b.usedPercent >= 85 ? Color.orange : Color.green.opacity(0.85))
                                                .frame(width: max(2, CGFloat(24 * Swift.min(b.usedPercent, 100) / 100)))
                                        }
                                        .frame(width: 24, height: 4)
                                        Text("\(Int(b.usedPercent))%")
                                            .font(.system(size: 7.5, weight: .semibold, design: .monospaced))
                                            .foregroundStyle(b.usedPercent >= 100 ? .red : b.usedPercent >= 85 ? .orange : .white.opacity(0.85))
                                            .frame(width: 20, alignment: .trailing)
                                        if let r = b.resetsAt {
                                            Text(DashboardTabs.formatResetShort(r))
                                                .font(.system(size: 6.5, design: .monospaced))
                                                .foregroundStyle(.white.opacity(0.4))
                                                .frame(width: 18, alignment: .trailing)
                                        }
                                    }
                                    .frame(width: 95, alignment: .leading)
                                } else {
                                    Text("—")
                                        .font(.system(size: 8, design: .monospaced))
                                        .foregroundStyle(.white.opacity(0.25))
                                        .frame(width: 95, alignment: .leading)
                                }

                                // Column 3: Weekly Headroom (width: 130)
                                if let c = row.cycleLimit {
                                    let rem = c.remainingPercent
                                    HStack(spacing: 4) {
                                        ZStack(alignment: .leading) {
                                            Capsule().fill(Color.white.opacity(0.12))
                                            Capsule().fill(rem > 50 ? Color.green : rem > 20 ? Color.orange : Color.red)
                                                .frame(width: max(2, CGFloat(36 * Swift.min(rem, 100) / 100)))
                                        }
                                        .frame(width: 36, height: 4)

                                        Text("\(String(format: "%.0f%%", rem)) left")
                                            .font(.system(size: 7.5, weight: .semibold, design: .monospaced))
                                            .foregroundStyle(rem > 50 ? Color.green : rem > 20 ? Color.orange : Color.red)
                                            .frame(width: 44, alignment: .leading)

                                        Text("(\(Int(c.usedPercent))%)")
                                            .font(.system(size: 6.5, design: .monospaced))
                                            .foregroundStyle(.white.opacity(0.35))
                                            .frame(width: 34, alignment: .trailing)
                                    }
                                    .frame(width: 130, alignment: .leading)
                                } else {
                                    Text("—")
                                        .font(.system(size: 8, design: .monospaced))
                                        .foregroundStyle(.white.opacity(0.25))
                                        .frame(width: 130, alignment: .leading)
                                }

                                // Column 4: Resets In (width: 85)
                                if let r = row.cycleLimit?.resetsAt {
                                    HStack(spacing: 3) {
                                        Image(systemName: isUrgent ? "flame.fill" : "clock")
                                            .font(.system(size: 6.5))
                                            .foregroundStyle(isUrgent ? Color.orange : isSoon ? Color.yellow : Color.secondary)
                                        Text(DashboardTabs.formatReset(r))
                                            .font(.system(size: 7.5, weight: isUrgent ? .heavy : .medium, design: .monospaced))
                                            .foregroundStyle(isUrgent ? Color.orange : isSoon ? Color.yellow : Color.white.opacity(0.85))
                                    }
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1.5)
                                    .background(
                                        RoundedRectangle(cornerRadius: 3.5)
                                            .fill(isUrgent ? Color.orange.opacity(0.18) : isSoon ? Color.yellow.opacity(0.08) : Color.white.opacity(0.05))
                                    )
                                    .frame(width: 85, alignment: .leading)
                                } else {
                                    Text("—")
                                        .font(.system(size: 8, design: .monospaced))
                                        .foregroundStyle(.white.opacity(0.25))
                                        .frame(width: 85, alignment: .leading)
                                }

                                // Column 5: Local Refresh (width: 110)
                                if let r = row.cycleLimit?.resetsAt {
                                    Text(DashboardTabs.formatResetDateTime(r))
                                        .font(.system(size: 7.5, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .frame(width: 110, alignment: .leading)
                                } else {
                                    Text("—")
                                        .font(.system(size: 8, design: .monospaced))
                                        .foregroundStyle(.white.opacity(0.25))
                                        .frame(width: 110, alignment: .leading)
                                }

                                // Column 6: Priority Action (width: 76)
                                HStack {
                                    if let r = row.cycleLimit?.resetsAt {
                                        let diff = r.timeIntervalSinceNow
                                        if diff > 0 && diff < 86_400 {
                                            Text("BURN TOKENS")
                                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                                .foregroundStyle(Color.black)
                                                .padding(.horizontal, 4)
                                                .padding(.vertical, 1.5)
                                                .background(Capsule().fill(Color.orange))
                                        } else if diff >= 86_400 && diff < 172_800 {
                                            Text("NEXT UP")
                                                .font(.system(size: 6.5, weight: .bold, design: .monospaced))
                                                .foregroundStyle(Color.yellow)
                                                .padding(.horizontal, 4)
                                                .padding(.vertical, 1.5)
                                                .background(Capsule().fill(Color.yellow.opacity(0.16)))
                                        } else {
                                            Text("STANDBY")
                                                .font(.system(size: 6.5, design: .monospaced))
                                                .foregroundStyle(.white.opacity(0.4))
                                                .padding(.horizontal, 4)
                                                .padding(.vertical, 1.5)
                                                .background(Capsule().fill(Color.white.opacity(0.05)))
                                        }
                                    } else {
                                        Text("ACTIVE")
                                            .font(.system(size: 6.5, design: .monospaced))
                                            .foregroundStyle(.white.opacity(0.4))
                                            .padding(.horizontal, 4)
                                            .padding(.vertical, 1.5)
                                            .background(Capsule().fill(Color.white.opacity(0.05)))
                                    }
                                }
                                .frame(width: 76, alignment: .trailing)
                            }
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(
                                RoundedRectangle(cornerRadius: 5)
                                    .fill(isUrgent ? Color.orange.opacity(0.07) : Color.white.opacity(0.025))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 5)
                                            .stroke(isUrgent ? Color.orange.opacity(0.35) : Color.white.opacity(0.06), lineWidth: 0.5)
                                    )
                            )
                            .onHover { over in
                                if over { planHoveredId = row.id }
                                else if planHoveredId == row.id { planHoveredId = nil }
                            }
                            .zIndex(planHoveredId == row.id ? 1 : 0)
                            .overlay(alignment: .topLeading) {
                                if planHoveredId == row.id {
                                    GeometryReader { geo in
                                        let f = geo.frame(in: .named("dashboardScroll"))
                                        let need = PlanLimitCard.estimatedHeight(for: row)
                                        let below = PlanLimitCard.showsBelow(
                                            rowTop: f.minY, rowBottom: f.maxY,
                                            viewportH: planViewportH, row: row)
                                        PlanLimitCard(row: row)
                                            .offset(x: 8, y: below ? 42 : -(need + 6))
                                    }
                                }
                            }
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

    private var leaderboardTab: some View {
        let rankings = LeaderboardStore.shared.rankings(for: leaderboardPeriod, teamFilter: leaderboardTeamFilter)
        let localRanked = rankings.first(where: { $0.entry.isLocal })
        let totalParticipants = rankings.count

        return VStack(alignment: .leading, spacing: 10) {
            // Header bar: Period selection + Action buttons
            HStack(spacing: 6) {
                ForEach(LeaderboardPeriod.allCases) { p in
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) { leaderboardPeriod = p }
                    } label: {
                        Text(p.title.uppercased())
                            .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                            .foregroundStyle(leaderboardPeriod == p ? Color.black : Color.white.opacity(0.55))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Capsule().fill(leaderboardPeriod == p ? Color.white : Color.white.opacity(0.1)))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }

                Spacer()

                // Share Format Picker
                HStack(spacing: 2) {
                    ForEach(ShareCardFormat.allCases) { fmt in
                        Button {
                            leaderboardShareFormat = fmt
                        } label: {
                            Text(fmt.rawValue.uppercased())
                                .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                                .foregroundStyle(leaderboardShareFormat == fmt ? Color.cyan : Color.white.opacity(0.4))
                                .padding(.horizontal, 4).padding(.vertical, 2)
                                .background(RoundedRectangle(cornerRadius: 3).fill(leaderboardShareFormat == fmt ? Color.cyan.opacity(0.15) : Color.clear))
                                .contentShape(RoundedRectangle(cornerRadius: 3))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(2)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.06)))

                // Copy Share Card Button
                Button {
                    let ok = LeaderboardStore.shared.copyShareCard(for: leaderboardPeriod, format: leaderboardShareFormat)
                    if ok {
                        leaderboardCopiedNotice = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                            leaderboardCopiedNotice = false
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: leaderboardCopiedNotice ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 8.5))
                        Text(leaderboardCopiedNotice ? "Copied!" : "Share Card")
                            .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                    }
                    .foregroundStyle(leaderboardCopiedNotice ? Color.green : Color.white.opacity(0.9))
                    .padding(.horizontal, 7).padding(.vertical, 3.5)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.12)))
                    .contentShape(RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)

                // Publish Stats Button
                Button {
                    guard !leaderboardPublishing else { return }
                    leaderboardPublishing = true
                    leaderboardPublishNotice = nil
                    // First ensure local usage is fresh
                    LeaderboardStore.shared.syncLocal(snapshot: model.usage, history: model.historyPoints, streak: model.historyStreak)
                    // Push to Cloud (defaulting to https://tokens.benebsworth.com)
                    LeaderboardStore.shared.publishToCloud(forced: true) { res in
                        DispatchQueue.main.async {
                            leaderboardPublishing = false
                            switch res {
                            case .success:
                                leaderboardPublishNotice = "Published!"
                                // Pull down updated global rankings immediately
                                LeaderboardStore.shared.pullFromCloud(forced: true) { pullRes in
                                    DispatchQueue.main.async {
                                        if case .success = pullRes {
                                            model.leaderboardRankings = LeaderboardStore.shared.rankings(for: leaderboardPeriod)
                                        }
                                    }
                                }
                                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                                    if leaderboardPublishNotice == "Published!" {
                                        leaderboardPublishNotice = nil
                                    }
                                }
                            case .failure(let err):
                                leaderboardPublishNotice = "Failed"
                                leaderboardSheetsNotice = "❌ Publish error: \(err.localizedDescription)"
                                DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
                                    if leaderboardPublishNotice == "Failed" {
                                        leaderboardPublishNotice = nil
                                    }
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        if leaderboardPublishing {
                            ProgressView().controlSize(.mini)
                                .scaleEffect(0.65)
                        } else {
                            Image(systemName: leaderboardPublishNotice == "Published!" ? "checkmark.circle.fill" : (leaderboardPublishNotice == "Failed" ? "exclamationmark.circle.fill" : "arrow.up.circle.fill"))
                                .font(.system(size: 8.5))
                        }
                        Text(leaderboardPublishing ? "Publishing..." : (leaderboardPublishNotice ?? "Publish Stats"))
                            .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                    }
                    .foregroundStyle(leaderboardPublishNotice == "Published!" ? Color.black : (leaderboardPublishNotice == "Failed" ? Color.white : Color.black))
                    .padding(.horizontal, 7).padding(.vertical, 3.5)
                    .background(RoundedRectangle(cornerRadius: 4).fill(leaderboardPublishNotice == "Published!" ? Color.green : (leaderboardPublishNotice == "Failed" ? Color.red.opacity(0.8) : Color.cyan)))
                    .contentShape(RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
                .disabled(leaderboardPublishing)
                .help("Publish your token usage to the global leaderboard at tokens.benebsworth.com")

                // Sync button
                Button {
                    LeaderboardStore.shared.syncLocal(snapshot: model.usage, history: model.historyPoints, streak: model.historyStreak)
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 9))
                        .foregroundStyle(.white.opacity(0.7))
                        .padding(4)
                        .background(Circle().fill(Color.white.opacity(0.1)))
                }
                .buttonStyle(.plain)
                .help("Sync live token usage to leaderboard")

                // Settings drawer toggle
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        leaderboardShowConfig.toggle()
                    }
                } label: {
                    Image(systemName: leaderboardShowConfig ? "chevron.up" : "gearshape")
                        .font(.system(size: 9))
                        .foregroundStyle(leaderboardShowConfig ? Color.cyan : Color.white.opacity(0.7))
                        .padding(4)
                        .background(Circle().fill(Color.white.opacity(0.1)))
                }
                .buttonStyle(.plain)
                .help("Customize leaderboard profile")
            }

            // Optional profile customization drawer
            if leaderboardShowConfig {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("HANDLE").font(.system(size: 7.5, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary)
                            TextField("Handle", text: $leaderboardHandleDraft)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 8.5, design: .monospaced))
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text("TEAM / ORGANIZATION").font(.system(size: 7.5, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary)
                            TextField("Team name", text: $leaderboardTeamDraft)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 8.5, design: .monospaced))
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text("TEAM FILTER").font(.system(size: 7.5, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary)
                            TextField("Filter table", text: $leaderboardTeamFilter)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 8.5, design: .monospaced))
                        }
                        Button {
                            SettingsStore.shared.leaderboardHandle = leaderboardHandleDraft
                            SettingsStore.shared.leaderboardTeam = leaderboardTeamDraft
                            LeaderboardStore.shared.syncLocal(snapshot: model.usage, history: model.historyPoints, streak: model.historyStreak)
                            withAnimation { leaderboardShowConfig = false }
                        } label: {
                            Text("Save")
                                .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                                .foregroundStyle(.black).padding(.horizontal, 8).padding(.vertical, 4)
                                .background(Capsule().fill(Color.cyan))
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 12)
                    }
                    HStack(spacing: 14) {
                        Toggle("Share Cost / Billing", isOn: Binding(
                            get: { leaderboardShareCostDraft },
                            set: {
                                leaderboardShareCostDraft = $0
                                SettingsStore.shared.leaderboardShareCost = $0
                                LeaderboardStore.shared.syncLocal(snapshot: model.usage, history: model.historyPoints, streak: model.historyStreak)
                            }
                        ))
                        .toggleStyle(.checkbox)
                        .font(.system(size: 8, design: .monospaced))

                        Toggle("Share Hardware (\(SystemStats.cpuBrandString()))", isOn: Binding(
                            get: { leaderboardShareHwDraft },
                            set: {
                                leaderboardShareHwDraft = $0
                                SettingsStore.shared.leaderboardShareHardware = $0
                                LeaderboardStore.shared.syncLocal(snapshot: model.usage, history: model.historyPoints, streak: model.historyStreak)
                            }
                        ))
                        .toggleStyle(.checkbox)
                        .font(.system(size: 8, design: .monospaced))
                    }

                    Divider().overlay(Color.white.opacity(0.1))

                    VStack(alignment: .leading, spacing: 4) {
                        Text("CLOUDFLARE CLOUD BACKEND (FAST)").font(.system(size: 7.5, weight: .heavy, design: .monospaced)).foregroundStyle(.orange)
                        Text("Worker + R2 team board with edge caching. Takes over auto-sync when set; Sheets becomes the fallback.")
                            .font(.system(size: 7, design: .monospaced)).foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            TextField("https://<worker>.workers.dev", text: $leaderboardCloudDraft)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 8, design: .monospaced))

                            SecureField("write token", text: $leaderboardCloudTokenDraft)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 8, design: .monospaced))
                                .frame(width: 120)

                            Button {
                                SettingsStore.shared.leaderboardCloudURL = leaderboardCloudDraft
                                SettingsStore.shared.leaderboardCloudToken = leaderboardCloudTokenDraft
                                LeaderboardStore.shared.publishToCloud(forced: true) { res in
                                    DispatchQueue.main.async {
                                        switch res {
                                        case .success(let msg):
                                            leaderboardSheetsNotice = "☁️ Published: \(msg)"
                                        case .failure(let err):
                                            leaderboardSheetsNotice = "❌ \(err.localizedDescription)"
                                        }
                                    }
                                }
                            } label: {
                                HStack(spacing: 3) {
                                    Image(systemName: "arrow.up.circle.fill")
                                    Text("Push")
                                }
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 3)
                                .background(Capsule().fill(Color.blue.opacity(0.6)))
                            }
                            .buttonStyle(.plain)

                            Button {
                                SettingsStore.shared.leaderboardCloudURL = leaderboardCloudDraft
                                SettingsStore.shared.leaderboardCloudToken = leaderboardCloudTokenDraft
                                LeaderboardStore.shared.pullFromCloud(forced: true) { res in
                                    DispatchQueue.main.async {
                                        switch res {
                                        case .success(let count):
                                            leaderboardSheetsNotice = "⚡ Pulled \(count) rows from cloud"
                                            model.leaderboardRankings = LeaderboardStore.shared.rankings(for: leaderboardPeriod)
                                        case .failure(let err):
                                            leaderboardSheetsNotice = "❌ \(err.localizedDescription)"
                                        }
                                    }
                                }
                            } label: {
                                HStack(spacing: 3) {
                                    Image(systemName: "arrow.down.circle.fill")
                                    Text("Pull")
                                }
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 3)
                                .background(Capsule().fill(Color.green.opacity(0.6)))
                            }
                            .buttonStyle(.plain)
                        }

                        if SettingsStore.shared.leaderboardCloudConfigured {
                            Text("● cloud active — auto-sync uses Worker+R2 (5-min pulls, change-gated pushes)")
                                .font(.system(size: 7, design: .monospaced)).foregroundStyle(.green)
                        }
                    }

                    Divider().overlay(Color.white.opacity(0.1))

                    VStack(alignment: .leading, spacing: 4) {
                        Text("GOOGLE SHEETS BACKEND (LEGACY FALLBACK)").font(.system(size: 7.5, weight: .heavy, design: .monospaced)).foregroundStyle(.cyan)
                        Text("Apps Script Web App URL (publish+pull) or Published Sheet CSV URL (read-only):")
                            .font(.system(size: 7, design: .monospaced)).foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            TextField("https://script.google.com/.../exec or https://docs.google.com/spreadsheets/d/...", text: $leaderboardSheetsDraft)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 8, design: .monospaced))

                            Button {
                                SettingsStore.shared.leaderboardSheetsURL = leaderboardSheetsDraft
                                LeaderboardStore.shared.publishToGoogleSheet(forced: true) { res in
                                    DispatchQueue.main.async {
                                        switch res {
                                        case .success(let msg):
                                            leaderboardSheetsNotice = "☁️ Published: \(msg)"
                                        case .failure(let err):
                                            leaderboardSheetsNotice = "❌ \(err.localizedDescription)"
                                        }
                                    }
                                }
                            } label: {
                                HStack(spacing: 3) {
                                    Image(systemName: "arrow.up.circle.fill")
                                    Text("Push")
                                }
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 3)
                                .background(Capsule().fill(Color.blue.opacity(0.6)))
                            }
                            .buttonStyle(.plain)

                            Button {
                                SettingsStore.shared.leaderboardSheetsURL = leaderboardSheetsDraft
                                LeaderboardStore.shared.pullFromGoogleSheet(forced: true) { res in
                                    DispatchQueue.main.async {
                                        switch res {
                                        case .success(let count):
                                            leaderboardSheetsNotice = "🔄 Pulled \(count) rows from Sheet"
                                            model.leaderboardRankings = LeaderboardStore.shared.rankings(for: leaderboardPeriod)
                                        case .failure(let err):
                                            leaderboardSheetsNotice = "❌ \(err.localizedDescription)"
                                        }
                                    }
                                }
                            } label: {
                                HStack(spacing: 3) {
                                    Image(systemName: "arrow.down.circle.fill")
                                    Text("Pull")
                                }
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 3)
                                .background(Capsule().fill(Color.green.opacity(0.6)))
                            }
                            .buttonStyle(.plain)
                        }

                        HStack(spacing: 12) {
                            Toggle("Auto-sync on background refresh tick", isOn: Binding(
                                get: { leaderboardAutoSyncDraft },
                                set: {
                                    leaderboardAutoSyncDraft = $0
                                    SettingsStore.shared.leaderboardAutoSync = $0
                                }
                            ))
                            .toggleStyle(.checkbox)
                            .font(.system(size: 7.5, design: .monospaced))

                            if let msg = leaderboardSheetsNotice {
                                Text(msg)
                                    .font(.system(size: 7.5, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(.orange)
                            }
                        }

                        HStack(spacing: 8) {
                            Button {
                                let sheetUrl = SettingsStore.shared.leaderboardSheetsURL
                                var target = "https://castlemilk.github.io/token-horizon/leaderboard.html"
                                if !sheetUrl.isEmpty, let encoded = sheetUrl.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
                                    target += "?sheet=\(encoded)"
                                }
                                if let url = URL(string: target) {
                                    NSWorkspace.shared.open(url)
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "safari")
                                    Text("Open GitHub Pages Leaderboard ↗")
                                }
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(Color.cyan)
                                .padding(.horizontal, 7).padding(.vertical, 3.5)
                                .background(RoundedRectangle(cornerRadius: 4).fill(Color.cyan.opacity(0.12)))
                            }
                            .buttonStyle(.plain)
                            .help("Open web leaderboard hosted on GitHub Pages")

                            Spacer()
                        }
                    }
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.1)))
            }

            // 4 Hero KPI Cards
            HStack(spacing: 8) {
                // Card 1: Your Rank
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        sectionLabel("YOUR RANK")
                        Spacer()
                        if localRanked != nil {
                            Text("Details ↗")
                                .font(.system(size: 7, weight: .bold, design: .monospaced))
                                .foregroundStyle(Color.yellow.opacity(0.8))
                        }
                    }
                    Text(localRanked?.badge ?? "#1 🥇")
                        .font(.system(size: 13, weight: .heavy, design: .monospaced))
                        .foregroundStyle(Color.yellow)
                    Text("Top \(String(format: "%.0f%%", localRanked?.percentile ?? 100)) of \(totalParticipants)")
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(selectedLeaderboardEntry?.id == localRanked?.id ? Color.yellow.opacity(0.12) : Color.white.opacity(0.04)))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.yellow.opacity(0.25)))
                .contentShape(Rectangle())
                .onTapGesture {
                    if let local = localRanked {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            if selectedLeaderboardEntry?.id == local.id {
                                selectedLeaderboardEntry = nil
                            } else {
                                selectedLeaderboardEntry = local
                            }
                        }
                    }
                }

                // Card 2: Period Volume
                VStack(alignment: .leading, spacing: 2) {
                    sectionLabel(leaderboardPeriod.title.uppercased())
                    Text(localRanked?.scoreFormatted ?? UsageSnapshot.tokens(model.usage.tokensToday))
                        .font(.system(size: 13, weight: .heavy, design: .monospaced))
                        .foregroundStyle(Color.cyan)
                    Text(localRanked?.costFormatted ?? "$0.00")
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.cyan.opacity(0.25)))

                // Card 3: Streak
                VStack(alignment: .leading, spacing: 2) {
                    sectionLabel("ACTIVE STREAK")
                    Text("🔥 \(model.historyStreak) Days")
                        .font(.system(size: 13, weight: .heavy, design: .monospaced))
                        .foregroundStyle(Color.orange)
                    Text("Consecutive days")
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.orange.opacity(0.25)))

                // Card 4: Hardware & Model
                VStack(alignment: .leading, spacing: 2) {
                    sectionLabel("HARDWARE")
                    Text(localRanked?.entry.hardware ?? SystemStats.cpuBrandString())
                        .font(.system(size: 11, weight: .heavy, design: .monospaced))
                        .foregroundStyle(Color.white.opacity(0.95))
                        .lineLimit(1)
                    Text(localRanked?.entry.topModel ?? "claude-3-7-sonnet")
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.12)))
            }

            // Leaderboard Rankings Table
            sectionLabel("PARTICIPANT RANKINGS · \(leaderboardPeriod.title.uppercased())")

            VStack(spacing: 1) {
                // Table header
                HStack(spacing: 6) {
                    Text("RANK").frame(width: 46, alignment: .leading)
                    Text("PARTICIPANT").frame(minWidth: 100, alignment: .leading)
                    Text("TEAM").frame(width: 70, alignment: .leading)
                    Text("TOP MODEL").frame(width: 90, alignment: .leading)
                    Text("VOLUME").frame(width: 65, alignment: .trailing)
                    Text("SHARE").frame(width: 80, alignment: .leading)
                    Text("STREAK").frame(width: 45, alignment: .trailing)
                    Spacer().frame(width: 14)
                }
                .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)

                Divider().overlay(Color.white.opacity(0.1))

                // Table rows
                ForEach(rankings) { item in
                    let isUser = item.entry.isLocal
                    let isSelected = selectedLeaderboardEntry?.id == item.id

                    VStack(spacing: 0) {
                        HStack(spacing: 6) {
                            // Rank & Badge
                            Text(item.badge)
                                .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                                .foregroundStyle(item.rank == 1 ? Color.yellow : item.rank == 2 ? Color.white : item.rank == 3 ? Color.orange : Color.secondary)
                                .frame(width: 46, alignment: .leading)

                            // Participant
                            HStack(spacing: 4) {
                                if isUser {
                                    Circle().fill(Color.green).frame(width: 5, height: 5)
                                }
                                Text(item.entry.displayHandle)
                                    .font(.system(size: 9, weight: isUser ? .heavy : .medium, design: .monospaced))
                                    .foregroundStyle(isUser ? Color.white : Color.white.opacity(0.85))
                                    .lineLimit(1)
                                if isUser {
                                    Text("YOU")
                                        .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                        .foregroundStyle(Color.black)
                                        .padding(.horizontal, 3).padding(.vertical, 1)
                                        .background(Capsule().fill(Color.green))
                                }
                            }
                            .frame(minWidth: 100, alignment: .leading)

                            // Team
                            Text(item.entry.team.isEmpty ? "—" : item.entry.team)
                                .font(.system(size: 8, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .frame(width: 70, alignment: .leading)
                                .lineLimit(1)

                            // Top Model
                            Text(item.entry.topModel)
                                .font(.system(size: 7.5, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 4).padding(.vertical, 1.5)
                                .background(RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.05)))
                                .frame(width: 90, alignment: .leading)
                                .lineLimit(1)

                            // Volume / Score
                            VStack(alignment: .trailing, spacing: 0) {
                                Text(item.scoreFormatted)
                                    .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(Color.cyan)
                                if item.costFormatted != "$0.00" {
                                    Text(item.costFormatted)
                                        .font(.system(size: 7, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .frame(width: 65, alignment: .trailing)

                            // Share bar
                            GeometryReader { barGeo in
                                ZStack(alignment: .leading) {
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(Color.white.opacity(0.08))
                                        .frame(height: 5)
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(isUser ? Color.green : Color.cyan.opacity(0.7))
                                        .frame(width: max(2, barGeo.size.width * CGFloat(item.relativePercent / 100.0)), height: 5)
                                }
                                .frame(maxHeight: .infinity, alignment: .center)
                            }
                            .frame(width: 80, height: 16)

                            // Streak
                            Text("🔥\(item.entry.streakDays)d")
                                .font(.system(size: 8, weight: .semibold, design: .monospaced))
                                .foregroundStyle(item.entry.streakDays >= 7 ? Color.orange : Color.secondary)
                                .frame(width: 45, alignment: .trailing)

                            // Expand / Collapse Chevron
                            Image(systemName: isSelected ? "chevron.up.circle.fill" : "chevron.right")
                                .font(.system(size: 8.5, weight: .bold))
                                .foregroundStyle(isSelected ? Color.cyan : Color.white.opacity(0.35))
                                .frame(width: 14, alignment: .center)
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 4).fill(isSelected ? Color.cyan.opacity(0.16) : (isUser ? Color.white.opacity(0.06) : Color.clear)))
                        .contentShape(Rectangle())
                        .onTapGesture {
                            withAnimation(.easeInOut(duration: 0.18)) {
                                if selectedLeaderboardEntry?.id == item.id {
                                    selectedLeaderboardEntry = nil
                                } else {
                                    selectedLeaderboardEntry = item
                                }
                            }
                        }

                        // Expanded user full usage breakdown details drawer
                        if isSelected {
                            leaderboardUserDetailView(item: item)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 6)
                                .transition(.opacity.combined(with: .move(edge: .top)))
                        }
                    }
                }
            }
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.03)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.08)))

            // Share Card Live Preview Section
            sectionLabel("SHARE CARD PREVIEW · \(leaderboardShareFormat.rawValue.uppercased())")
            let cardText = LeaderboardStore.shared.generateShareCard(for: leaderboardPeriod, format: leaderboardShareFormat, entryId: selectedLeaderboardEntry?.id)

            VStack(alignment: .leading, spacing: 4) {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(cardText)
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(Color.white.opacity(0.85))
                        .textSelection(.enabled)
                        .padding(8)
                }
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.4)))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.1)))
            }
        }
    }

    private func leaderboardUserDetailView(item: LeaderboardRankedEntry) -> some View {
        let entry = item.entry
        let bd = entry.resolvedBreakdown()
        let isUser = entry.isLocal

        return VStack(alignment: .leading, spacing: 8) {
            // Header: Avatar badge, handle, meta pills, copy card, close
            HStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(item.rank == 1 ? Color.yellow.opacity(0.2) : (item.rank == 2 ? Color.white.opacity(0.15) : (item.rank == 3 ? Color.orange.opacity(0.2) : Color.cyan.opacity(0.15))))
                        .frame(width: 28, height: 28)
                    Text(item.badge.components(separatedBy: " ").last ?? "👤")
                        .font(.system(size: 13))
                }

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Text(entry.displayHandle)
                            .font(.system(size: 11, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.white)

                        if isUser {
                            Text("YOU")
                                .font(.system(size: 7, weight: .heavy, design: .monospaced))
                                .foregroundStyle(Color.black)
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(Capsule().fill(Color.green))
                        }

                        Text("Rank #\(item.rank)")
                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                            .foregroundStyle(Color.yellow)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 3).fill(Color.yellow.opacity(0.12)))

                        if !entry.team.isEmpty {
                            Text(entry.team)
                                .font(.system(size: 8, weight: .medium, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.7))
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.08)))
                        }

                        if !entry.hardware.isEmpty {
                            Text(entry.hardware)
                                .font(.system(size: 7.5, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.05)))
                        }

                        Text("🔥 \(entry.streakDays)d streak")
                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                            .foregroundStyle(Color.orange)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 3).fill(Color.orange.opacity(0.12)))
                    }

                    Text("Updated \(DateFormatter.localizedString(from: entry.updatedAt, dateStyle: .short, timeStyle: .short))")
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.4))
                }

                Spacer()

                // Copy share card for this participant
                Button {
                    let card = LeaderboardStore.shared.generateShareCard(for: leaderboardPeriod, format: leaderboardShareFormat, entryId: entry.id)
                    #if canImport(AppKit)
                    let pasteboard = NSPasteboard.general
                    pasteboard.clearContents()
                    pasteboard.setString(card, forType: .string)
                    #endif
                    leaderboardCopiedNotice = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                        leaderboardCopiedNotice = false
                    }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "doc.on.doc")
                        Text("Share Card")
                    }
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .foregroundStyle(Color.cyan)
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color.cyan.opacity(0.12)))
                }
                .buttonStyle(.plain)

                // Close button
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        selectedLeaderboardEntry = nil
                    }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.5))
                }
                .buttonStyle(.plain)
            }

            // 4 Mini KPIs for this user
            HStack(spacing: 6) {
                userMetricBox(title: "TODAY", value: UsageSnapshot.tokens(entry.tokensToday), sub: entry.costToday > 0 ? UsageSnapshot.cost(entry.costToday) : "—", color: .cyan)
                userMetricBox(title: "7 DAYS", value: UsageSnapshot.tokens(entry.tokens7d), sub: entry.cost7d > 0 ? UsageSnapshot.cost(entry.cost7d) : "—", color: .blue)
                userMetricBox(title: "ALL-TIME", value: UsageSnapshot.tokens(entry.tokensAll), sub: entry.costAll > 0 ? UsageSnapshot.cost(entry.costAll) : "—", color: .purple)
                userMetricBox(title: "TOP MODEL", value: entry.topModel, sub: "Primary Driver", color: .green)
            }

            // 7-Day Activity Sparkline / Bars (if history is present)
            if !bd.history.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("7-DAY TOKEN ACTIVITY")
                        .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.secondary)

                    let maxTok = Swift.max(bd.history.map { $0.tokens }.max() ?? 1, 1)
                    HStack(alignment: .bottom, spacing: 6) {
                        ForEach(bd.history) { pt in
                            VStack(spacing: 2) {
                                Text(UsageSnapshot.tokens(pt.tokens))
                                    .font(.system(size: 6.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(pt.tokens > 0 ? Color.cyan : Color.white.opacity(0.3))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.7)

                                ZStack(alignment: .bottom) {
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(Color.white.opacity(0.06))
                                        .frame(height: 32)

                                    let h = maxTok > 0 ? CGFloat(Double(pt.tokens) / Double(maxTok)) * 32.0 : 0
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(LinearGradient(
                                            gradient: Gradient(colors: [Color.cyan.opacity(0.9), Color.blue.opacity(0.7)]),
                                            startPoint: .top,
                                            endPoint: .bottom
                                        ))
                                        .frame(height: max(2, h))
                                }
                                .frame(maxWidth: .infinity)

                                Text(pt.dayLabel)
                                    .font(.system(size: 7, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.5))
                            }
                        }
                    }
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.3)))
                }
            }

            // Model Breakdown Table
            if !bd.models.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text("MODEL ALLOCATION (\(bd.models.count))")
                            .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("TOKENS · COST · SHARE")
                            .font(.system(size: 7, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }

                    VStack(spacing: 2) {
                        ForEach(bd.models.sorted(by: { $0.tokensAll > $1.tokensAll })) { m in
                            HStack(spacing: 6) {
                                ProviderLogoView(provider: m.provider, model: m.model, size: 13)

                                Text(m.model)
                                    .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.9))
                                    .lineLimit(1)

                                Spacer()

                                VStack(alignment: .trailing, spacing: 0) {
                                    Text(UsageSnapshot.tokens(m.tokensToday > 0 ? m.tokensToday : m.tokensAll))
                                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                                        .foregroundStyle(Color.cyan)
                                    if m.costToday > 0 || m.costAll > 0 {
                                        Text(UsageSnapshot.cost(m.costToday > 0 ? m.costToday : m.costAll))
                                            .font(.system(size: 6.5, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .frame(width: 60, alignment: .trailing)

                                // Share bar
                                ZStack(alignment: .leading) {
                                    RoundedRectangle(cornerRadius: 1.5)
                                        .fill(Color.white.opacity(0.08))
                                        .frame(height: 4)
                                    RoundedRectangle(cornerRadius: 1.5)
                                        .fill(Color.cyan)
                                        .frame(width: max(2, 45.0 * CGFloat(Swift.min(m.sharePercent, 100.0) / 100.0)), height: 4)
                                }
                                .frame(width: 45)

                                Text(String(format: "%.1f%%", m.sharePercent))
                                    .font(.system(size: 7, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.6))
                                    .frame(width: 32, alignment: .trailing)
                            }
                            .padding(.horizontal, 6).padding(.vertical, 2.5)
                            .background(RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.025)))
                        }
                    }
                }
            }

            // Tools / Providers Breakdown Chips
            if !bd.tools.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("TELEMETRY TOOLS & PROVIDERS")
                        .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.secondary)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 4) {
                            ForEach(bd.tools.sorted(by: { $0.tokensAll > $1.tokensAll })) { t in
                                HStack(spacing: 4) {
                                    Circle().fill(DashboardTabs.toolColor(t.tool)).frame(width: 4, height: 4)
                                    Text(t.tool)
                                        .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                                        .foregroundStyle(.white.opacity(0.9))
                                    Text(UsageSnapshot.tokens(t.tokensToday > 0 ? t.tokensToday : t.tokensAll))
                                        .font(.system(size: 7.5, design: .monospaced))
                                        .foregroundStyle(Color.cyan)
                                }
                                .padding(.horizontal, 6).padding(.vertical, 2.5)
                                .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.06)))
                            }
                        }
                    }
                }
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.045)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.cyan.opacity(0.25), lineWidth: 1))
    }

    private func userMetricBox(title: String, value: String, sub: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(sub)
                .font(.system(size: 7, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.35)))
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

            sectionLabel("SURFACE")
            VStack(alignment: .leading, spacing: 6) {
                Picker("Surface", selection: Binding(
                    get: { surfaceDraft },
                    set: {
                        surfaceDraft = $0
                        SettingsStore.shared.surfaceMode = $0
                    }
                )) {
                    ForEach(SurfaceMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                Toggle(isOn: Binding(
                    get: { trayDraft },
                    set: {
                        trayDraft = $0
                        SettingsStore.shared.showTrayIcon = $0
                    }
                )) {
                    Text("Also show the menu bar item with the notch panel")
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.9))
                }
                .toggleStyle(.switch)
                .tint(.green)
                Text("Auto uses the notch panel when a notch display is present, otherwise the menu bar. Notch also works on external displays as a floating top-center panel; menu bar shows CPU/MEM rings with the same tabs. TOKEN_HORIZON_FORCE_TRAY=1 always forces the menu bar.")
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            sectionLabel("STARTUP")
            Toggle(isOn: Binding(
                get: { launchDraft },
                set: {
                    launchDraft = $0
                    SettingsStore.shared.launchAtLogin = $0
                }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Launch Token Horizon at login")
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.9))
                    Text("Starts the app automatically when you log in.")
                        .font(.system(size: 8, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
            .toggleStyle(.switch)
            .tint(.green)

            sectionLabel("APP BUILD")
            MonospacedText(text: "v\(BuildInfo.display) — this exact build serves :8765; if these differ from `git rev-parse --short HEAD`, relaunch via ./scripts/make-app.sh", color: .secondary, size: 8).fixedSize(horizontal: false, vertical: true)

            sectionLabel("DATA DURABILITY & CACHE")
            Toggle(isOn: Binding(
                get: { persistenceDraft },
                set: {
                    persistenceDraft = $0
                    SettingsStore.shared.historyPersistenceEnabled = $0
                }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Durable disk cache & history preservation")
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.9))
                    Text("Stores 370-day history, snapshots, and file offsets on disk for instant launch without cold-start delay.")
                        .font(.system(size: 8, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
            .toggleStyle(.switch)
            .tint(.green)

            HStack(spacing: 10) {
                Button {
                    let res = DurableStore.shared.resetAll()
                    cacheStatusMessage = "Cleared \(res.clearedFiles) cache files (\(res.clearedBytes / 1024) KB). Rebuilding..."
                    NotificationCenter.default.post(name: .tokenHorizonCacheReset, object: nil)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
                        cacheStatusMessage = nil
                    }
                } label: {
                    Text("Reset / Rebuild History Cache")
                        .font(.system(size: 8.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.9))
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.red.opacity(0.25)))
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.red.opacity(0.5)))
                }
                .buttonStyle(.plain)

                if let msg = cacheStatusMessage {
                    MonospacedText(text: msg, color: .orange, size: 8)
                } else {
                    let stats = DurableStore.shared.cacheStats()
                    MonospacedText(text: "\(stats.filesCount) cached files (\(stats.totalBytes / 1024) KB)", color: .secondary, size: 8)
                }
            }

            sectionLabel("CLAUDE ACCOUNTS")
            if model.usage.claudeAccounts.isEmpty {
                MonospacedText(text: "auto-detected from ~/.claude* profiles or macOS Keychain 'Claude Code-credentials'", color: .secondary, size: 8.5).fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(model.usage.claudeAccounts) { acct in
                        HStack(alignment: .top, spacing: 8) {
                            ProviderLogoView(provider: "claude", size: 16)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(acct.email.isEmpty ? acct.id : acct.email)
                                        .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                                        .foregroundStyle(.white.opacity(0.95))
                                    if !acct.organizationType.isEmpty {
                                        Text(acct.organizationType)
                                            .font(.system(size: 8, weight: .medium, design: .monospaced))
                                            .padding(.horizontal, 4)
                                            .padding(.vertical, 1)
                                            .background(Color.orange.opacity(0.2))
                                            .foregroundStyle(Color.orange)
                                            .clipShape(Capsule())
                                    }
                                    if acct.hasExtraUsageEnabled {
                                        Text("extra usage")
                                            .font(.system(size: 7.5, design: .monospaced))
                                            .padding(.horizontal, 4)
                                            .padding(.vertical, 1)
                                            .background(Color.green.opacity(0.2))
                                            .foregroundStyle(Color.green)
                                            .clipShape(Capsule())
                                    }
                                }
                                HStack(spacing: 8) {
                                    Text(acct.configDir)
                                        .font(.system(size: 8, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                    if !acct.organizationName.isEmpty && acct.organizationName != acct.email {
                                        Text("· \(acct.organizationName)")
                                            .font(.system(size: 8, design: .monospaced))
                                            .foregroundStyle(.secondary.opacity(0.8))
                                    }
                                }
                                HStack(spacing: 12) {
                                    Text("Tokens: \(acct.tokensAllTimeText) (today: \(acct.tokensTodayText))")
                                        .font(.system(size: 8, design: .monospaced))
                                        .foregroundStyle(.white.opacity(0.7))
                                    if acct.costAllTime > 0 {
                                        Text("Cost: \(acct.costAllTimeText)")
                                            .font(.system(size: 8, design: .monospaced))
                                            .foregroundStyle(.orange.opacity(0.8))
                                    }
                                }
                            }
                            Spacer()
                        }
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                    }
                }
            }
            sectionLabel("LEADERBOARD PROFILE")
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Handle").font(.system(size: 8, design: .monospaced)).foregroundStyle(.secondary)
                    TextField("Username", text: $leaderboardHandleDraft)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 8.5, design: .monospaced))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Team / Organization").font(.system(size: 8, design: .monospaced)).foregroundStyle(.secondary)
                    TextField("Team", text: $leaderboardTeamDraft)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 8.5, design: .monospaced))
                }
                Button {
                    SettingsStore.shared.leaderboardHandle = leaderboardHandleDraft
                    SettingsStore.shared.leaderboardTeam = leaderboardTeamDraft
                    LeaderboardStore.shared.syncLocal(snapshot: model.usage, history: model.historyPoints, streak: model.historyStreak)
                } label: {
                    Text("Save")
                        .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.black).padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Capsule().fill(Color.white))
                }
                .buttonStyle(.plain)
                .padding(.top, 14)
            }
            Toggle(isOn: Binding(
                get: { leaderboardShareCostDraft },
                set: {
                    leaderboardShareCostDraft = $0
                    SettingsStore.shared.leaderboardShareCost = $0
                    LeaderboardStore.shared.syncLocal(snapshot: model.usage, history: model.historyPoints, streak: model.historyStreak)
                }
            )) {
                Text("Share billing / estimated cost on leaderboard").font(.system(size: 9, design: .monospaced))
            }.toggleStyle(.switch).tint(.green)

            Toggle(isOn: Binding(
                get: { leaderboardShareHwDraft },
                set: {
                    leaderboardShareHwDraft = $0
                    SettingsStore.shared.leaderboardShareHardware = $0
                    LeaderboardStore.shared.syncLocal(snapshot: model.usage, history: model.historyPoints, streak: model.historyStreak)
                }
            )) {
                Text("Share hardware chip name (\(SystemStats.cpuBrandString()))").font(.system(size: 9, design: .monospaced))
            }.toggleStyle(.switch).tint(.green)

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text("Cloudflare Edge Leaderboard URL").font(.system(size: 8, design: .monospaced)).foregroundStyle(.orange)
                    Spacer()
                    if SettingsStore.shared.leaderboardCloudConfigured {
                        Text("● connected").font(.system(size: 7.5, weight: .bold, design: .monospaced)).foregroundStyle(.green)
                    }
                }
                HStack(spacing: 6) {
                    TextField("https://tokens.benebsworth.com", text: $leaderboardCloudDraft)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 8.5, design: .monospaced))
                        .onChange(of: leaderboardCloudDraft) { val in
                            SettingsStore.shared.leaderboardCloudURL = val
                        }

                    Button {
                        LeaderboardStore.shared.syncLocal(snapshot: model.usage, history: model.historyPoints, streak: model.historyStreak)
                        LeaderboardStore.shared.publishToCloud(forced: true) { _ in
                            LeaderboardStore.shared.pullFromCloud(forced: true) { _ in
                                DispatchQueue.main.async {
                                    model.leaderboardRankings = LeaderboardStore.shared.rankings(for: leaderboardPeriod)
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: "arrow.up.circle.fill")
                            Text("Publish")
                        }
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Capsule().fill(Color.cyan))
                    }
                    .buttonStyle(.plain)
                    .help("Publish your stats directly to tokens.benebsworth.com")
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Google Spreadsheet Backend URL (Apps Script / Published Sheet CSV)").font(.system(size: 8, design: .monospaced)).foregroundStyle(.secondary)
                TextField("https://script.google.com/.../exec or https://docs.google.com/spreadsheets/d/...", text: $leaderboardSheetsDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 8.5, design: .monospaced))
                    .onChange(of: leaderboardSheetsDraft) { val in
                        SettingsStore.shared.leaderboardSheetsURL = val
                    }
            }

            Toggle(isOn: Binding(
                get: { leaderboardAutoSyncDraft },
                set: {
                    leaderboardAutoSyncDraft = $0
                    SettingsStore.shared.leaderboardAutoSync = $0
                }
            )) {
                Text("Auto-sync leaderboard on background refresh").font(.system(size: 9, design: .monospaced))
            }.toggleStyle(.switch).tint(.green)

            sectionLabel("GEMINI")
            MonospacedText(text: "auto-detected from ~/.gemini*/oauth_creds.json when present", color: .secondary, size: 8.5)
            sectionLabel("ALIBABA / GLM / MINIMAX / OPENCODE-GO")
            MonospacedText(text: "keys read from opencode auth.json", color: .secondary, size: 8.5)
        }
        .onAppear {
            cookieDraft = SettingsStore.shared.getCookie()
            notifyDraft = SettingsStore.shared.notifyOnLimitRefresh
            launchDraft = SettingsStore.shared.launchAtLogin
            persistenceDraft = SettingsStore.shared.historyPersistenceEnabled
            leaderboardHandleDraft = SettingsStore.shared.leaderboardHandle
            leaderboardTeamDraft = SettingsStore.shared.leaderboardTeam
            leaderboardShareCostDraft = SettingsStore.shared.leaderboardShareCost
            leaderboardShareHwDraft = SettingsStore.shared.leaderboardShareHardware
            leaderboardCloudDraft = SettingsStore.shared.leaderboardCloudURL
            leaderboardSheetsDraft = SettingsStore.shared.leaderboardSheetsURL
            leaderboardAutoSyncDraft = SettingsStore.shared.leaderboardAutoSync
        }
    }

    @State private var displayedCount = 50
    @State private var _baseRows: [ModelRow] = []
    @State private var _filteredRows: [ModelRow] = []
    @State private var _scopeCounts: [ModelFilterScope: Int] = [:]
    @State private var _localCount: Int = 0
    @State private var _lastBaseKey: String = ""
    @State private var _topPicks: [ModelsPipeline.TopPickModel] = []
    @State private var isTopPicksExpanded: Bool = true

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

            // Top Picks Panel: Top 10 Models by Performance & Cost
            if !_topPicks.isEmpty {
                TopPicksPanel(topPicks: _topPicks, isExpanded: $isTopPicksExpanded) { pickRow in
                    selectedRow = pickRow
                }
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
        .onReceive(NotificationCenter.default.publisher(for: .refreshModelExtras)) { _ in
            recomputeFilteredRows(force: true)
        }
        .task {
            recomputeFilteredRows()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                let curKey = "\(ModelCatalog.shared.allEntries().count)-\(ModelCatalog.shared.currentRevision())-\(model.usage.models.count)-\(model.syntheticModels.count)"
                if curKey != _lastBaseKey { await MainActor.run { recomputeFilteredRows() } }
            }
        }
    }

    private func benchmarkAllLocal() {
        for r in _filteredRows.filter({ $0.isLocal }) { OllamaClient.benchmark(model: r.localModelName) }
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
        let rev = ModelCatalog.shared.currentRevision()
        let baseKey = "\(ModelCatalog.shared.allEntries().count)-\(rev)-\(model.usage.models.count)-\(model.syntheticModels.count)-\(modelSearch)-\(modelFilterScope.rawValue)-\(modelSortColumn.rawValue)-\(modelSortAscending)"
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
                self._topPicks = result.topPicks
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
        var result: [Double] = []
        result.reserveCapacity(maxPoints)
        for i in 0..<maxPoints {
            let start = Int(Double(i) * stride)
            let end = Swift.min(Int(Double(i + 1) * stride), values.count)
            let count = Swift.max(end - start, 1)
            var sum = 0.0
            for j in start..<start + count {
                sum += values[j]
            }
            result.append(sum / Double(count))
        }
        return result
    }

    /// Short model name from a scoped quota label ("weekly · Fable" → "Fable").
    static func scopedModelName(_ label: String) -> String {
        if let sep = label.range(of: "·") {
            return label[sep.upperBound...].trimmingCharacters(in: .whitespaces)
        }
        return label
    }

    static func providerNameDisplay(_ p: String) -> String {        let lower = p.lowercased()
        if lower.hasPrefix("claude") {
            if let start = p.firstIndex(of: "("), let end = p.firstIndex(of: ")") {
                let tag = String(p[p.index(after: start)..<end])
                return "Claude (\(tag))"
            }
            return "Claude"
        }
        switch lower {
        case "codex", "openai": return "OpenAI"
        case "kimi", "moonshot": return "Kimi"
        case "glm", "zai", "zhipu": return "GLM"
        case "minimax": return "MiniMax"
        case "opencode-go", "opencode": return "OpenCode"
        case "agy", "antigravity": return "AGY"
        case "google", "gemini": return "Google"
        case "alibaba", "qwen", "bailian": return "Alibaba"
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

    static func formatResetShort(_ d: Date) -> String {
        let diff = d.timeIntervalSinceNow
        if diff <= 0 { return "now" }
        if diff < 3600 { return "\(max(1, Int(diff / 60)))m" }
        if diff < 86400 {
            let hours = diff / 3600
            return String(format: "%.0fh", hours)
        }
        let days = diff / 86400
        return String(format: "%.1fd", days)
    }

    static func formatResetDateTime(_ d: Date) -> String {
        let cal = Calendar.current
        let timeFormatter = DateFormatter()
        timeFormatter.dateFormat = "h:mm a"
        let timeStr = timeFormatter.string(from: d)

        if cal.isDateInToday(d) {
            return "today at \(timeStr)"
        } else if cal.isDateInTomorrow(d) {
            return "tomorrow at \(timeStr)"
        } else {
            let dayFormatter = DateFormatter()
            dayFormatter.dateFormat = "EEE h:mm a"
            return dayFormatter.string(from: d)
        }
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
        case "ollama", "mlx", "localllm": return Color(red: 0.18, green: 0.82, blue: 0.72)
        default: return .gray
        }
    }

    /// Assemble the flat limit list feeding the Plan Limits section.
    /// Prefer live `planLimits` codex rows over the file-derived `usageLimits`
    /// ones when both exist. Extracted for testability; used by tokensTab.
    static func assembleLimitRows(usageLimits: [ProviderLimit], planLimits: [ProviderLimit], kimiLimits: [ProviderLimit]) -> [ProviderLimit] {
        let base = planLimits.contains(where: { $0.provider == "codex" })
            ? usageLimits.filter { $0.provider != "codex" }
            : usageLimits
        return base + kimiLimits + planLimits
    }

    /// Group flat limits into one row per provider for the Plan Limits table.
    /// Multi-account claude providers ("claude (label)") each get their own
    /// row — never drop a provider group here (rows with nil burst/cycle
    /// render as "—", they must still appear).
    func buildUnifiedPlanRows(from limits: [ProviderLimit]) -> [UnifiedPlanRow] {
        var rows: [UnifiedPlanRow] = []

        // 1. Google Gemini & Antigravity (agy)
        let agyLimits = limits.filter { $0.provider == "agy" }
        if !agyLimits.isEmpty {
            let geminiLimits = agyLimits.filter { $0.label.contains("gemini") }
            if !geminiLimits.isEmpty {
                let burst = geminiLimits.first { !$0.isWeekly }
                let cycle = geminiLimits.first { $0.isWeekly }
                rows.append(UnifiedPlanRow(
                    id: "agy-gemini",
                    provider: "agy",
                    logoProvider: "agy",
                    displayName: "AGY (Gemini)",
                    subtitle: UsageEngine.configuredAgyModel(),
                    burstLimit: burst,
                    cycleLimit: cycle,
                    extraLimit: nil
                ))
            }
            let p3Limits = agyLimits.filter { $0.label.contains("3p") }
            if !p3Limits.isEmpty {
                let burst = p3Limits.first { !$0.isWeekly }
                let cycle = p3Limits.first { $0.isWeekly }
                rows.append(UnifiedPlanRow(
                    id: "agy-3p",
                    provider: "agy",
                    logoProvider: "agy",
                    displayName: "AGY (3P Models)",
                    subtitle: "claude / gpt / glm",
                    burstLimit: burst,
                    cycleLimit: cycle,
                    extraLimit: nil
                ))
            }
            let otherAgy = agyLimits.filter { !$0.label.contains("gemini") && !$0.label.contains("3p") }
            if !otherAgy.isEmpty {
                let burst = otherAgy.first { !$0.isWeekly }
                let cycle = otherAgy.first { $0.isWeekly }
                rows.append(UnifiedPlanRow(
                    id: "agy-other",
                    provider: "agy",
                    logoProvider: "agy",
                    displayName: "AGY",
                    subtitle: "coding-plan",
                    burstLimit: burst,
                    cycleLimit: cycle,
                    extraLimit: nil
                ))
            }
        }

        // 2. All other providers
        let nonAgyLimits = limits.filter { $0.provider != "agy" }
        let grouped = Dictionary(grouping: nonAgyLimits, by: { $0.provider })

        for (provider, pLimits) in grouped {
            // Model-scoped quotas ("weekly · Fable") are per-model sub-limits:
            // they must never compete for the burst/cycle slots (their reset
            // dates would hijack the weekly headroom column and row sorting).
            // They ride in `extra` and are summarized in the subtitle.
            let scoped = pLimits.filter { $0.label.contains("·") }
            let burst = pLimits.first { !$0.isWeekly && $0.label != "search" && !$0.label.contains("·") }
            let cycleCandidates = pLimits.filter { $0.isWeekly && !$0.label.contains("·") }.sorted { ($0.resetsAt ?? .distantFuture) < ($1.resetsAt ?? .distantFuture) }
            let cycle = cycleCandidates.first { $0.label == "weekly" } ?? cycleCandidates.first
            let extra = pLimits.first { $0.label == "search" } ?? scoped.first ?? cycleCandidates.filter { $0.label != cycle?.label }.first

            var sub = ""
            if provider.contains("claude") {
                if let det = pLimits.first?.detail, !det.isEmpty {
                    let parts = det.components(separatedBy: " · ")
                    sub = parts.first ?? ""
                }
                let scopedBits = scoped.map { "\(DashboardTabs.scopedModelName($0.label)) \(Int($0.usedPercent))%" }
                if !scopedBits.isEmpty {
                    sub = sub.isEmpty ? scopedBits.joined(separator: " · ") : "\(sub) · \(scopedBits.joined(separator: " · "))"
                }
            } else if provider == "kimi" {
                sub = "kimi-coding-plan"
            } else if provider == "minimax" {
                sub = "minimax-coding-plan"
            } else if provider == "opencode-go" {
                sub = extra != nil ? "extra: \(extra!.label)" : "opencode-go zen"
            } else if provider == "glm" {
                sub = extra != nil ? "search: \(extra!.detail)" : "zai-coding-plan"
            } else if provider == "codex" {
                sub = "openai oauth"
            } else if provider == "alibaba" {
                sub = "bailian token plan"
            }
            if sub.isEmpty {
                sub = pLimits.first?.detail ?? ""
            }

            let logoProv = provider.contains("claude") ? "claude" : provider
            let dispName = DashboardTabs.providerNameDisplay(provider)

            rows.append(UnifiedPlanRow(
                id: provider,
                provider: provider,
                logoProvider: logoProv,
                displayName: dispName,
                subtitle: sub,
                burstLimit: burst,
                cycleLimit: cycle,
                extraLimit: extra
            ))
        }

        // Sort rows by soonest cycle reset date (urgent resets first!)
        return rows.sorted { r1, r2 in
            let d1 = r1.cycleLimit?.resetsAt ?? r1.burstLimit?.resetsAt ?? .distantFuture
            let d2 = r2.cycleLimit?.resetsAt ?? r2.burstLimit?.resetsAt ?? .distantFuture
            return d1 < d2
        }
    }
}

