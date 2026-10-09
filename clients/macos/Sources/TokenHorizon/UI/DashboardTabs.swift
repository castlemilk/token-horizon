import SwiftUI

struct DashboardTabs: View {
    @ObservedObject var model: UIModel
    var compact: Bool = true
    @State private var tab: DashboardTab = .tokens
    @State private var settingsSection: AppSettingsSection = .general
    @State private var profileSaveNotice: String?
    @State private var connectionSaveNotice: String?
    @ObservedObject private var syncController = LeaderboardSyncController.shared
    @ObservedObject private var cloudSignIn = CloudSignInController.shared
    @State private var heatmapExpanded = false
    @State private var cookieDraft: String = ""
    @State private var notifyDraft: Bool = true
    @State private var surfaceDraft: SurfaceMode = SettingsStore.shared.surfaceMode
    @State private var trayDraft: Bool = SettingsStore.shared.showTrayIcon
    @State private var launchDraft: Bool = false
    @State private var persistenceDraft: Bool = true
    @State private var cacheStatusMessage: String? = nil
    @State private var cacheSummary: String?
    @State private var cacheResetRunning = false
    @State private var modelSearch: String = ""
    @State private var modelSortColumn: ModelTableColumn = .sweBench
    @State private var modelSortAscending: Bool = false
    @State private var modelFilterScope: ModelFilterScope = .all
    @State private var modelPlanFilter: ModelPlanFilter = .all
    @State private var showUsageColumn: Bool = false
    @State private var procSearch: String = ""
    @State private var procSort: String = "cpu"
    @State private var procSortAscending: Bool = false
    @State private var selectedRow: ModelRow?
    @State private var selectedMLXProcess: MLXProcess?
    @State private var mlxWindow: MLXWindow = .h1
    @State private var planHoveredId: String?
    @State private var planViewportH: CGFloat = 600
    @State private var leaderboardHandleDraft: String = SettingsStore.shared.leaderboardHandle
    @State private var leaderboardTeamDraft: String = SettingsStore.shared.leaderboardTeam
    @State private var leaderboardShareCostDraft: Bool = SettingsStore.shared.leaderboardShareCost
    @State private var leaderboardShareHwDraft: Bool = SettingsStore.shared.leaderboardShareHardware
    @State private var leaderboardSharePromptsDraft: Bool = SettingsStore.shared.leaderboardSharePrompts
    @State private var leaderboardSheetsDraft: String = SettingsStore.shared.leaderboardSheetsURL
    @State private var leaderboardCloudDraft: String = SettingsStore.shared.leaderboardCloudURL
    @State private var leaderboardCloudTokenDraft: String = SettingsStore.shared.leaderboardCloudToken
    @State private var leaderboardClaimTokenDraft: String = ""
    @State private var autoSyncOn = SettingsStore.shared.leaderboardAutoSync
    @State private var syncDestinationDraft: String = SettingsStore.shared.leaderboardCloudConfigured
        || SettingsStore.shared.leaderboardSheetsURL.isEmpty ? "cloud" : "sheets"
    @ObservedObject private var updater = SelfUpdater.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            appHeader
            tabBar
            Divider().overlay(Color.white.opacity(0.12))
            ScrollView(.vertical, showsIndicators: false) {
                switch tab {
                case .activity: activityTab
                case .mlx: mlxTab
                case .engine: EngineTabView()
                case .tokens: tokensTab
                case .traces: TracesTabView()
                case .models: modelsTab
                case .shells: shellsTab
                case .leaderboard: LeaderboardTabView(model: model, onOpenSettings: { openSettings(.sharing) })
                case .teams: TeamsTabView()
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
            Divider().overlay(Color.white.opacity(0.12))
            webShortcuts
        }
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .onReceive(NotificationCenter.default.publisher(for: .selectDashboardTab)) { note in
            guard !compact, let destination = note.object as? DashboardTab else { return }
            tab = destination
            if let section = note.userInfo?["settingsSection"] as? AppSettingsSection {
                settingsSection = section
            }
        }
        // Catalog/discovery refresh notifications and the staleness poll live on
        // the ROOT (not inside `modelsTab`), so rows stay warm while another tab
        // is showing and changes made off-tab are picked up when you come back.
        .onReceive(NotificationCenter.default.publisher(for: .refreshModelExtras)) { _ in
            recomputeFilteredRows(force: true)
        }
        .onAppear {
            if compact {
                tab = model.compactDashboardTab
                settingsSection = model.compactSettingsSection
            }
            autoSyncOn = SettingsStore.shared.leaderboardAutoSync
            ModelCatalog.shared.ensureLoaded(maxAge: ModelCatalog.interactiveRefreshInterval)
            NotificationCenter.default.post(name: .refreshTrends, object: nil)
        }
        .task {
            recomputeFilteredRows()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                // The gate inside recomputeFilteredRows compares the full
                // content key, so a bare call here is the cheap thing: it either
                // early-exits or schedules one off-main pipeline run.
                await MainActor.run { recomputeFilteredRows() }
            }
        }
        .onChange(of: tab) { destination in
            if compact { model.compactDashboardTab = destination }
        }
        .onChange(of: settingsSection) { section in
            if compact { model.compactSettingsSection = section }
        }
        .sheet(item: $selectedMLXProcess) { process in
            MLXRunnerDetailView(process: process)
        }
        .sheet(isPresented: Binding(get: { !compact && cloudSignIn.isPresented },
                                    set: { if !$0 && !compact { cloudSignIn.cancel() } })) {
            CloudSignInView(controller: cloudSignIn)
        }
    }

    private var appHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Token Horizon")
                        .font(.system(size: 16, weight: .semibold))
                    Text(syncController.statusText)
                        .font(.system(size: 11))
                        .foregroundStyle(syncController.lastError == nil ? Color.white.opacity(0.7) : Color.orange)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if !syncController.isSyncing, syncController.lastError == nil,
                       let syncedAt = syncController.lastSuccessAt {
                        (Text("Last completed ") + Text(syncedAt, style: .relative) + Text(" ago"))
                            .font(.system(size: 10)).foregroundStyle(.white.opacity(0.7))
                    }
                    if autoSyncOn, syncController.requiresSignIn, !syncController.isSyncing,
                       syncController.lastError == nil {
                        Text("Auto-sync paused — click Sync now to reconnect")
                            .font(.system(size: 10)).foregroundStyle(.orange)
                    }
                }
                Spacer(minLength: 8)
                Button { setAutoSync(!autoSyncOn) } label: {
                    HStack(spacing: 5) {
                        Circle().fill(autoSyncOn ? Color.green : Color.white.opacity(0.35)).frame(width: 6, height: 6)
                        Text("AUTO")
                            .font(.system(size: 10, weight: .heavy, design: .monospaced))
                            .foregroundStyle(autoSyncOn ? Color.white : Color.white.opacity(0.55))
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(autoSyncOn ? Color.white.opacity(0.16) : Color.white.opacity(0.06)))
                    .contentShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(syncController.isSyncing)
                .accessibilityLabel(autoSyncOn ? "Turn auto-sync off" : "Turn auto-sync on")
                .help(autoSyncOn ? "Auto-sync is on — click to turn it off"
                                 : "Auto-sync is off — click to connect this Mac and sync automatically")
                Button { syncController.syncNow() } label: {
                    HStack(spacing: 6) {
                        if syncController.isSyncing {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath")
                        }
                        Text(syncController.isSyncing ? "Syncing…" : "Sync now")
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.cyan))
                }
                .buttonStyle(.plain)
                .disabled(syncController.isSyncing)
                .help("Refresh local usage, publish your sharing preferences, and update cloud rankings")
                Button { openSettings() } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 15))
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Settings")
                .accessibilityLabel("Open Settings")
                .keyboardShortcut(",", modifiers: .command)
                if compact {
                    Button {
                        NotificationCenter.default.post(name: .dismissNotch, object: nil)
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .medium))
                            .frame(width: 28, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Close panel (Escape)")
                    .accessibilityLabel("Close panel")
                    .keyboardShortcut(.escape, modifiers: [])
                }
            }
            if let error = syncController.lastError {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .help(error)
                    .textSelection(.enabled)
            }
        }
    }

    private var tabBar: some View {
        HStack(spacing: 6) {
            ForEach(DashboardTab.quickTabs) { destination in
                tabButton(destination)
            }
            Menu {
                ForEach(DashboardTab.allCases.filter { !DashboardTab.quickTabs.contains($0) && $0 != .settings }) { destination in
                    Button { tab = destination } label: {
                        Label(destination.title, systemImage: destination.icon)
                    }
                }
                Divider()
                Button { openSettings() } label: { Label("Settings…", systemImage: "gearshape") }
                Button { openWeb(.webSettings) } label: { Label("Web account settings", systemImage: "person.crop.circle") }
                Button { openWeb(.signIn) } label: { Label("Connect account", systemImage: "person.badge.key") }
                Divider()
                Button("Quit Token Horizon") { NSApp.terminate(nil) }
                    .keyboardShortcut("q", modifiers: .command)
            } label: {
                Label(DashboardTab.quickTabs.contains(tab) ? "More" : tab.title, systemImage: "ellipsis.circle")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(DashboardTab.quickTabs.contains(tab) ? Color.white.opacity(0.75) : Color.cyan)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Model inventory, traces, shells, team aggregates, and leaderboard")
            Spacer(minLength: 4)
            if compact {
                Button {
                    NotificationCenter.default.post(name: .openDashboard, object: tab,
                                                    userInfo: ["settingsSection": settingsSection])
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 12))
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Open this tab in the native window")
                .accessibilityLabel("Open this tab in the native window")
            }
        }
    }

    private func tabButton(_ destination: DashboardTab) -> some View {
        Button { tab = destination } label: {
            Label(destination.title, systemImage: destination.icon)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(tab == destination ? Color.black : Color.white.opacity(0.8))
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 8).fill(tab == destination ? Color.white : Color.white.opacity(0.06)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(tab == destination ? .isSelected : [])
    }

    private var webShortcuts: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Open on web", systemImage: "arrow.up.right.square")
                .font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.7))
            HStack(spacing: 4) {
                webShortcut("Dashboard", icon: "rectangle.grid.2x2", destination: .workspace)
                webShortcut("Leaderboard", icon: "trophy", destination: .leaderboard)
                webShortcut("Models", icon: "cube", destination: .models)
                webShortcut("My profile", icon: "person.crop.circle", destination: .profile)
            }
        }
    }

    private func webShortcut(_ title: String, icon: String, destination: WebDestination) -> some View {
        Button { openWeb(destination) } label: {
            Label(title, systemImage: icon)
                .font(.system(size: 11, weight: .medium))
                .lineLimit(1)
            .foregroundStyle(.white.opacity(0.8))
            .frame(maxWidth: .infinity, minHeight: 30)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open \(title.lowercased()) in your browser")
        .accessibilityLabel("Open \(title) in your browser")
    }

    private func openWeb(_ destination: WebDestination) {
        NotificationCenter.default.post(name: .openWebDestination, object: destination)
    }

    private func openSettings(_ section: AppSettingsSection = .general) {
        tab = .settings
        settingsSection = section
    }

    /// One switch for auto-sync on every surface: saving the preference also
    /// defaults the cloud destination and, when switching on, runs the manual
    /// sync immediately so the browser consent happens in the same click.
    private func setAutoSync(_ enabled: Bool) {
        autoSyncOn = enabled
        SettingsStore.shared.leaderboardAutoSync = enabled
        if enabled, !SettingsStore.shared.leaderboardCloudConfigured,
           SettingsStore.shared.leaderboardSheetsURL.isEmpty {
            SettingsStore.shared.leaderboardCloudURL = WebDestination.defaultBaseURL
            leaderboardCloudDraft = WebDestination.defaultBaseURL
            syncDestinationDraft = "cloud"
        }
        if enabled { syncController.syncNow() }
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
        let prefillSeries = model.mlxPrefillSeries(mlxWindow)
        let peakTok = model.mlxPeakTok(mlxWindow)
        let peakPrefill = model.mlxPeakPrefill(mlxWindow)
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
            if let gatewayPort = GatewaySupervisor.shared.port {
                MonospacedText(text: "llm gateway 127.0.0.1:\(gatewayPort) · drop-in base URL for Codex (OPENAI_BASE_URL), Claude Code (ANTHROPIC_BASE_URL), Ollama (OLLAMA_HOST)", color: .white.opacity(0.35), size: 7.5)
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
                mlxStat("DECODE", (model.mlx.measuredTokPerSec ?? (peakTok > 0 ? peakTok : nil)).map { String(format: "%.1f", $0) } ?? "--", .green)
                mlxStat("PREFILL", (model.mlx.measuredPrefillTokPerSec ?? (peakPrefill > 0 ? peakPrefill : nil)).map { String(format: "%.1f", $0) } ?? "--", .teal)
            }

            HStack(spacing: 8) {
                mlxSparkline("CPU \(mlxWindow.rawValue)", cpuSeries, .red)
                mlxSparkline("MEM \(mlxWindow.rawValue)", memSeries, .cyan)
                mlxSparkline("DISK \(mlxWindow.rawValue)", diskSeries, .orange)
                mlxSparkline("DECODE \(mlxWindow.rawValue)", tokSeries, .green)
                mlxSparkline("PREFILL \(mlxWindow.rawValue)", prefillSeries, .teal)
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
                MonospacedText(text: "watching Ollama --mlx-engine, mlx-lm, and mlx_vlm process trees", color: .white.opacity(0.4), size: 7.5)
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
                            if let prefill = process.prefillTokPerSec {
                                MonospacedText(text: String(format: "p %.0f", prefill), color: .teal, size: 8)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            MonospacedText(text: "decode/prefill tok/s are measured by the Ollama telemetry proxy or the runner's own /metrics endpoint; never inferred from process load.", color: .white.opacity(0.35), size: 7.5)
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
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), alignment: .leading)], alignment: .leading, spacing: 8) {
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
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .help(acct.label)
                                .frame(width: 95, alignment: .leading)
                            Text(acct.email.isEmpty ? acct.id : acct.email)
                                .font(.system(size: 7.5, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .help(acct.email.isEmpty ? acct.id : acct.email)
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

                        Text("CYCLE HEADROOM")
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

                                // Column 3: Cycle headroom (width: 130) — weekly
                                // and monthly stack when a provider reports both
                                // (e.g. opencode-go); scoped/search extras stay in
                                // the hover card + subtitle.
                                if let c = row.cycleLimit {
                                    let extraCycle = row.extraLimit.flatMap {
                                        $0.isWeekly && !$0.label.contains("·") ? $0 : nil
                                    }
                                    VStack(alignment: .leading, spacing: 3) {
                                        planCycleLine(c)
                                        if let x = extraCycle { planCycleLine(x) }
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
        UsageHistorySection(history: model.historyPoints, trend: model.trendPoints,
                            window: $model.trendWindow, expandedCalendar: $heatmapExpanded) {
            NotificationCenter.default.post(name: .refreshTrends, object: nil)
        }
    }

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
        VStack(alignment: .leading, spacing: 16) {
            Picker("Settings section", selection: $settingsSection) {
                ForEach(AppSettingsSection.allCases) { section in
                    Text(section.rawValue).tag(section)
                }
            }
            .pickerStyle(.segmented)
            switch settingsSection {
            case .general:
                settingsCard("Appearance", icon: "macwindow") { surfaceSettings }
                settingsCard("Startup & notifications", icon: "power") {
                    startupSettings
                    Divider().overlay(Color.white.opacity(0.08))
                    notificationSettings
                }
                settingsCard("History & cache", icon: "externaldrive") { cacheSettings }
                settingsCard("Updates", icon: "arrow.triangle.2.circlepath") { updateSettings }
                settingsCard("App build", icon: "info.circle") {
                    MonospacedText(text: "v\(BuildInfo.display)", color: .secondary, size: 11)
                }
            case .sharing:
                settingsCard("Profile & privacy", icon: "person.crop.circle") { leaderboardProfileSettings }
                settingsCard("Sync connection", icon: "arrow.triangle.2.circlepath") { leaderboardSyncSettings }
            case .providers:
                settingsCard("Provider credentials", icon: "key") {
                    DisclosureGroup("Alibaba token plan cookie") { cookieSettings.padding(.top, 10) }
                    Divider().overlay(Color.white.opacity(0.08))
                    DisclosureGroup("Claude accounts") { claudeAccountSettings.padding(.top, 10) }
                    Divider().overlay(Color.white.opacity(0.08))
                    providerDiscoverySettings
                }
            case .widget:
                WidgetSettingsView(model: model)
            }
        }
        .padding(.vertical, 4)
        .onAppear {
            cookieDraft = SettingsStore.shared.getCookie()
            notifyDraft = SettingsStore.shared.notifyOnLimitRefresh
            surfaceDraft = SettingsStore.shared.surfaceMode
            trayDraft = SettingsStore.shared.showTrayIcon
            launchDraft = SettingsStore.shared.launchAtLogin
            persistenceDraft = SettingsStore.shared.historyPersistenceEnabled
            leaderboardHandleDraft = SettingsStore.shared.leaderboardHandle
            leaderboardTeamDraft = SettingsStore.shared.leaderboardTeam
            leaderboardShareCostDraft = SettingsStore.shared.leaderboardShareCost
            leaderboardShareHwDraft = SettingsStore.shared.leaderboardShareHardware
            leaderboardSharePromptsDraft = SettingsStore.shared.leaderboardSharePrompts
            leaderboardCloudDraft = SettingsStore.shared.leaderboardCloudURL
            leaderboardCloudTokenDraft = SettingsStore.shared.leaderboardCloudToken
            leaderboardClaimTokenDraft = ""
            leaderboardSheetsDraft = SettingsStore.shared.leaderboardSheetsURL
            autoSyncOn = SettingsStore.shared.leaderboardAutoSync
            syncDestinationDraft = SettingsStore.shared.leaderboardCloudConfigured
                || SettingsStore.shared.leaderboardSheetsURL.isEmpty ? "cloud" : "sheets"
            if compact, let draft = model.compactSettingsDraft {
                cookieDraft = draft.cookie
                leaderboardHandleDraft = draft.handle
                leaderboardTeamDraft = draft.team
                leaderboardCloudDraft = draft.cloudURL
                leaderboardCloudTokenDraft = draft.appToken
                leaderboardClaimTokenDraft = draft.claimToken
                leaderboardSheetsDraft = draft.sheetsURL
                syncDestinationDraft = draft.destination
                profileSaveNotice = draft.profileNotice
                connectionSaveNotice = draft.connectionNotice
            }
            refreshCacheSummary()
        }
        .onDisappear {
            if compact {
                model.compactSettingsDraft = CompactSettingsDraft(
                    cookie: cookieDraft, handle: leaderboardHandleDraft, team: leaderboardTeamDraft,
                    cloudURL: leaderboardCloudDraft, appToken: leaderboardCloudTokenDraft,
                    claimToken: leaderboardClaimTokenDraft, sheetsURL: leaderboardSheetsDraft,
                    destination: syncDestinationDraft, profileNotice: profileSaveNotice,
                    connectionNotice: connectionSaveNotice)
            }
        }
    }

    private func refreshCacheSummary() {
        DispatchQueue.global(qos: .utility).async {
            let stats = DurableStore.shared.cacheStats()
            let summary = "\(stats.filesCount) cached files (\(stats.totalBytes / 1024) KB)"
            DispatchQueue.main.async { cacheSummary = summary }
        }
    }

    private func stageLocalProfile() {
        NotificationCenter.default.post(name: .refreshLocalLeaderboard, object: nil)
    }

    private func settingsCard<Content: View>(_ title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(title, systemImage: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.95))
            content()
        }
        .font(.system(size: 12))
        .foregroundStyle(.white.opacity(0.9))
        .tint(.green)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.045)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.white.opacity(0.1)))
    }

    private var updateSettings: some View {
        let busy = updater.phase == .checking || updater.phase == .downloading
            || updater.phase == .installing || updater.phase == .relaunching
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Circle()
                    .fill(updateStatusColor)
                    .frame(width: 7, height: 7)
                MonospacedText(
                    text: updateStatusText,
                    color: updater.phase == .failed ? .red : .secondary,
                    size: 11
                )
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
                if busy {
                    ProgressView()
                        .scaleEffect(0.55)
                        .frame(width: 14, height: 14)
                }
            }
            HStack(spacing: 10) {
                Toggle("Auto-update", isOn: Binding(
                    get: { SettingsStore.shared.autoUpdateEnabled },
                    set: { SettingsStore.shared.autoUpdateEnabled = $0 }
                ))
                .toggleStyle(.checkbox)
                .font(.system(size: 12))
                .help("Download, verify, and install new releases automatically")
                Spacer()
                Button { updater.check(manual: true) } label: {
                    Text("Check now")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.8))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Capsule().fill(Color.white.opacity(0.12)))
                }
                .buttonStyle(.plain)
                .disabled(busy)
                if updater.phase == .available {
                    Button { updater.install() } label: {
                        Text("Update to \(updater.latestTag)")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 12).padding(.vertical, 5)
                            .background(Capsule().fill(Color.white))
                    }
                    .buttonStyle(.plain)
                }
            }
            if updater.phase == .available {
                if let notes = updater.releaseNotes, !notes.isEmpty {
                    ScrollView(.vertical) {
                        Text(notes)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(Color.white.opacity(0.85))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                    }
                    .frame(maxHeight: 220)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.35)))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.1)))
                    .accessibilityLabel("Release notes for \(updater.latestTag)")
                }
                if let link = updater.releaseURL.flatMap(URL.init(string:)) {
                    Button {
                        NSWorkspace.shared.open(link)
                    } label: {
                        Text("View release on GitHub ↗")
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.cyan)
                    }
                    .buttonStyle(.plain)
                    .help("Open the full release on GitHub")
                }
            }
            if let checked = updater.lastChecked {
                MonospacedText(
                    text: "last checked \(checked.formatted(date: .omitted, time: .shortened)) · releases on github",
                    color: .white.opacity(0.3), size: 9)
            }
        }
    }

    private var updateStatusColor: Color {
        switch updater.phase {
        case .upToDate: return .green
        case .available: return .orange
        case .failed: return .red
        case .downloading, .installing, .relaunching: return .blue
        default: return .gray
        }
    }

    private var updateStatusText: String {
        switch updater.phase {
        case .idle: return "v\(BuildInfo.version) installed"
        case .checking: return "checking for updates…"
        case .upToDate: return "v\(BuildInfo.version) — up to date"
        case .available: return updater.statusDetail.isEmpty
            ? "\(updater.latestTag) available — you're on v\(BuildInfo.version)"
            : updater.statusDetail
        case .downloading, .installing, .relaunching, .failed: return updater.statusDetail
        }
    }

    private var cookieSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Paste Cookie header from bailian-singapore-cs.alibabacloud.com tokenplan/personal/api/v2/usage request.")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $cookieDraft)
                .font(.system(size: 11, design: .monospaced))
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
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.black).padding(.horizontal, 12).padding(.vertical, 6)
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
        }
    }

    private var notificationSettings: some View {
        Toggle(isOn: Binding(
            get: { notifyDraft },
            set: {
                notifyDraft = $0
                SettingsStore.shared.notifyOnLimitRefresh = $0
            }
        )) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Notify when token limits refresh")
                    .font(.system(size: 12, weight: .medium))
                Text("Sends a system notification when a quota window resets or a rate limit clears.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.switch)
        .tint(.green)
    }

    private var surfaceSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
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
                    .font(.system(size: 12, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .toggleStyle(.switch)
            .tint(.green)
            Text("Auto uses the notch panel when a notch display is present, otherwise the menu bar. Notch also works on external displays as a floating top-center panel; menu bar shows CPU/MEM rings with the same tabs. TOKEN_HORIZON_FORCE_TRAY=1 always forces the menu bar.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var startupSettings: some View {
        Toggle(isOn: Binding(
            get: { launchDraft },
            set: {
                launchDraft = $0
                SettingsStore.shared.launchAtLogin = $0
            }
        )) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Launch Token Horizon at login")
                    .font(.system(size: 12, weight: .medium))
                Text("Starts the app automatically when you log in.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.switch)
        .tint(.green)
    }

    private var cacheSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle(isOn: Binding(
                get: { persistenceDraft },
                set: {
                    persistenceDraft = $0
                    SettingsStore.shared.historyPersistenceEnabled = $0
                }
            )) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Durable disk cache & history preservation")
                        .font(.system(size: 12, weight: .medium))
                    Text("Stores 370-day history, snapshots, and file offsets on disk for instant launch without cold-start delay.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .toggleStyle(.switch)
            .tint(.green)

            VStack(alignment: .leading, spacing: 8) {
                Button {
                    cacheResetRunning = true
                    cacheStatusMessage = "Clearing cache…"
                    DispatchQueue.global(qos: .utility).async {
                        let result = DurableStore.shared.resetAll()
                        DispatchQueue.main.async {
                            cacheResetRunning = false
                            cacheStatusMessage = "Cleared \(result.clearedFiles) cache files (\(result.clearedBytes / 1024) KB). Rebuilding…"
                            refreshCacheSummary()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                cacheStatusMessage = nil
                            }
                        }
                    }
                } label: {
                    Text("Reset / Rebuild History Cache")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.9))
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.red.opacity(0.25)))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.red.opacity(0.5)))
                }
                .buttonStyle(.plain)
                .disabled(cacheResetRunning)

                if let msg = cacheStatusMessage {
                    MonospacedText(text: msg, color: .orange, size: 11)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    MonospacedText(text: cacheSummary ?? "Reading cache size…", color: .secondary, size: 11)
                }
            }
        }
    }

    private var claudeAccountSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.usage.claudeAccounts.isEmpty {
                MonospacedText(text: "auto-detected from ~/.claude* profiles or macOS Keychain 'Claude Code-credentials'", color: .secondary, size: 11)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(model.usage.claudeAccounts) { acct in
                        HStack(alignment: .top, spacing: 10) {
                            ProviderLogoView(provider: "claude", size: 20)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(acct.email.isEmpty ? acct.id : acct.email)
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(.white.opacity(0.95))
                                    .lineLimit(1).truncationMode(.middle)
                                HStack(spacing: 6) {
                                    if !acct.organizationType.isEmpty {
                                        Text(acct.organizationType)
                                            .font(.system(size: 11, weight: .medium))
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(Color.orange.opacity(0.2))
                                            .foregroundStyle(Color.orange)
                                            .clipShape(Capsule())
                                    }
                                    if acct.hasExtraUsageEnabled {
                                        Text("extra usage")
                                            .font(.system(size: 11))
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(Color.green.opacity(0.2))
                                            .foregroundStyle(Color.green)
                                            .clipShape(Capsule())
                                    }
                                }
                                Text(acct.configDir)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                                    .fixedSize(horizontal: false, vertical: true)
                                if !acct.organizationName.isEmpty && acct.organizationName != acct.email {
                                    Text("· \(acct.organizationName)")
                                        .font(.system(size: 11))
                                        .foregroundStyle(.secondary)
                                }
                                Text("Tokens: \(acct.tokensAllTimeText) (today: \(acct.tokensTodayText))")
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.85))
                                if acct.costAllTime > 0 {
                                    Text("Cost: \(acct.costAllTimeText)")
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(.orange)
                                }
                            }
                            .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.04)))
                    }
                }
            }
        }
    }

    private var leaderboardProfileSettings: some View {
        let configuredHandle = SettingsStore.shared.leaderboardHandle
        let savedHandle = configuredHandle.isEmpty ? NSUserName() : configuredHandle
        return VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Handle").font(.system(size: 11)).foregroundStyle(.secondary)
                        TextField(NSUserName(), text: $leaderboardHandleDraft)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(size: 12))
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Published team label").font(.system(size: 11)).foregroundStyle(.secondary)
                        TextField("Team", text: $leaderboardTeamDraft)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(size: 12))
                    }
                }
                Button {
                    SettingsStore.shared.leaderboardHandle = leaderboardHandleDraft
                    SettingsStore.shared.leaderboardTeam = leaderboardTeamDraft
                    stageLocalProfile()
                    profileSaveNotice = "Profile saved locally. Use Sync now to publish your changes."
                } label: {
                    Text("Save profile")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.black).padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Capsule().fill(Color.white))
                }
                .buttonStyle(.plain)
                if let notice = profileSaveNotice {
                    Text(notice).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 14) {
                Button("My profile ↗") { openWeb(.profile) }
                Button("Manage teams ↗") { openWeb(.teams) }
                Button("Web account settings ↗") { openWeb(.webSettings) }
            }
            .buttonStyle(.plain).foregroundStyle(.cyan)
            Text("Team membership and invitations are managed on the web. The team label here is published with your usage; account membership takes precedence.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 10) {
                    Button("Connect / claim my handle") { openWeb(.claimHandle) }
                        .buttonStyle(.bordered)
                    Text(savedHandle.hasPrefix("@") ? savedHandle : "@\(savedHandle)")
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Text("Sign in and choose the profile this Mac publishes to. A new handle is created when your first sync finishes.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Your connection is saved securely in Keychain, and sync continues automatically after approval.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Toggle(isOn: Binding(
                get: { leaderboardShareCostDraft },
                set: {
                    leaderboardShareCostDraft = $0
                    SettingsStore.shared.leaderboardShareCost = $0
                    stageLocalProfile()
                }
            )) {
                Text("Share billing / estimated cost on leaderboard")
                    .font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
            }.toggleStyle(.switch).tint(.green)

            Toggle(isOn: Binding(
                get: { leaderboardShareHwDraft },
                set: {
                    leaderboardShareHwDraft = $0
                    SettingsStore.shared.leaderboardShareHardware = $0
                    stageLocalProfile()
                }
            )) {
                Text("Share hardware chip name (\(SystemStats.cpuBrandString()))")
                    .font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
            }.toggleStyle(.switch).tint(.green)

            Toggle(isOn: Binding(
                get: { leaderboardSharePromptsDraft },
                set: {
                    leaderboardSharePromptsDraft = $0
                    SettingsStore.shared.leaderboardSharePrompts = $0
                    stageLocalProfile()
                }
            )) {
                Text("Share prompt history / session titles (off by default)")
                    .font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
            }.toggleStyle(.switch).tint(.green)

        }
    }

    private var leaderboardSyncSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            let savedHandle = SettingsStore.shared.leaderboardHandle.isEmpty ? NSUserName() : SettingsStore.shared.leaderboardHandle
            if let account = DesktopCloudAccountStore.shared.account(baseURL: SettingsStore.shared.leaderboardCloudURL, handle: savedHandle) {
                HStack {
                    Label("Connected as \(account.displayName)", systemImage: "checkmark.shield.fill")
                        .font(.system(size: 12)).foregroundStyle(.cyan)
                    Spacer()
                    Button("Disconnect this Mac") { cloudSignIn.disconnect() }.buttonStyle(.bordered)
                }
            } else {
                Button("Sign in & connect this Mac") { openWeb(.signIn) }.buttonStyle(.bordered)
            }
            if let error = cloudSignIn.error, !cloudSignIn.isPresented {
                Text(error).font(.system(size: 11)).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Use Sync now in the header to refresh local usage, publish it, and update rankings.")
                .fixedSize(horizontal: false, vertical: true)
            if let error = syncController.lastError {
                Text(error)
                    .font(.system(size: 11)).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            Toggle("Sync automatically", isOn: Binding(
                get: { autoSyncOn },
                set: { setAutoSync($0) }
            ))
            .toggleStyle(.switch)
            Text("Local usage is collected automatically. Cloud sync uses the privacy choices above.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            DisclosureGroup("Advanced connection") {
                VStack(alignment: .leading, spacing: 8) {
                    Picker("Sync destination", selection: $syncDestinationDraft) {
                        Text("Cloud").tag("cloud")
                        Text("Google Sheets").tag("sheets")
                    }
                    .pickerStyle(.segmented)
                    Text("Cloud URL").foregroundStyle(.secondary)
                    TextField("https://token-horizon.dev", text: $leaderboardCloudDraft)
                        .textFieldStyle(.roundedBorder)
                    Text("App write token").foregroundStyle(.secondary)
                    SecureField("Optional for anonymous profiles", text: $leaderboardCloudTokenDraft)
                        .textFieldStyle(.roundedBorder)
                    Text("Restore anonymous profile token").foregroundStyle(.secondary)
                    SecureField("Paste the original claim token only if needed", text: $leaderboardClaimTokenDraft)
                        .textFieldStyle(.roundedBorder)
                    Text("New anonymous profile tokens are saved automatically. Restore an original token here if this Mac cannot update an existing anonymous profile.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Account connections are managed above. This optional token is for administrator-managed deployments.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Google Sheets URL · fallback").foregroundStyle(.secondary)
                    TextField("Apps Script or published CSV URL", text: $leaderboardSheetsDraft)
                        .textFieldStyle(.roundedBorder)
                    Button("Save connection") {
                        let cloudURL = leaderboardCloudDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                        let sheetsURL = leaderboardSheetsDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !cloudURL.isEmpty, CloudPublishCredentials.endpointURL(baseURL: cloudURL) == nil {
                            connectionSaveNotice = "Enter a valid HTTP or HTTPS cloud URL."
                            return
                        }
                        if !sheetsURL.isEmpty, LeaderboardStore.resolveGoogleSheetsURL(sheetsURL).readURL == nil {
                            connectionSaveNotice = "Enter a valid Apps Script or published Google Sheets URL."
                            return
                        }
                        if syncDestinationDraft == "sheets", sheetsURL.isEmpty {
                            connectionSaveNotice = "Enter a Google Sheets URL to use this sync destination."
                            return
                        }
                        let restored = leaderboardClaimTokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !restored.isEmpty, CloudPublishCredentials.validatedToken(restored) == nil {
                            connectionSaveNotice = "The profile token contains invalid characters or is too long."
                            return
                        }
                        SettingsStore.shared.leaderboardCloudURL = syncDestinationDraft == "cloud"
                            ? (cloudURL.isEmpty ? WebDestination.defaultBaseURL : cloudURL) : ""
                        SettingsStore.shared.leaderboardCloudToken = leaderboardCloudTokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                        SettingsStore.shared.leaderboardSheetsURL = leaderboardSheetsDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !restored.isEmpty,
                           let endpoint = CloudPublishCredentials.endpointURL(baseURL: SettingsStore.shared.leaderboardCloudURL) {
                            let handle = SettingsStore.shared.leaderboardHandle.isEmpty ? NSUserName() : SettingsStore.shared.leaderboardHandle
                            SettingsStore.shared.setLeaderboardClaimToken(restored, endpoint: endpoint, handle: handle)
                            leaderboardClaimTokenDraft = ""
                        }
                        connectionSaveNotice = "Connection saved. Use Sync now to try it."
                    }
                    .buttonStyle(.bordered)
                    if let notice = connectionSaveNotice {
                        Text(notice).font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 10)
            }
        }
    }

    private var providerDiscoverySettings: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Gemini").font(.system(size: 12, weight: .medium))
            MonospacedText(text: "auto-detected from ~/.gemini*/oauth_creds.json when present", color: .secondary, size: 11)
                .fixedSize(horizontal: false, vertical: true)
            Text("Alibaba / GLM / MiniMax / OpenCode-Go")
                .font(.system(size: 12, weight: .medium))
                .padding(.top, 6)
            MonospacedText(text: "keys read from opencode auth.json", color: .secondary, size: 11)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @State private var displayedCount = 50
    @State private var _baseRows: [ModelRow] = []
    @State private var _filteredRows: [ModelRow] = []
    @State private var _scopeCounts: [ModelFilterScope: Int] = [:]
    @State private var _planCounts: [String: Int] = [:]
    @State private var _uncoveredCount: Int = 0
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

                // Subscription-plan coverage (curated plans.json): e.g. ZEN for
                // every family opencode-go sells, GLM for the coding plan, etc.
                // Counts are faceted over the same base as the scope chips.
                Menu {
                    Button { modelPlanFilter = .all } label: {
                        Text("All plans  \(_scopeCounts[.all] ?? 0)")
                    }
                    Divider()
                    ForEach(ModelPlanIndex.plans().plans, id: \.id) { plan in
                        Button { modelPlanFilter = .plan(plan.id) } label: {
                            Text("\(plan.name)  \(_planCounts[plan.id] ?? 0)")
                        }
                    }
                    Divider()
                    Button { modelPlanFilter = .uncovered } label: {
                        Text("No plan  \(_uncoveredCount)")
                    }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "creditcard")
                        Text(planFilterLabel)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 6, weight: .bold))
                            .foregroundStyle(modelPlanFilter == .all ? Color.white.opacity(0.5) : Color.black.opacity(0.55))
                    }
                    .font(.system(size: 8, weight: .heavy, design: .monospaced))
                    .foregroundStyle(modelPlanFilter == .all ? Color.white.opacity(0.55) : Color.black)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(Capsule().fill(modelPlanFilter == .all ? Color.white.opacity(0.08) : Color.white))
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Filter the list by subscription-plan coverage")

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
                    .onChange(of: modelPlanFilter) { _ in displayedCount = 50; recomputeFilteredRows() }
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
            ModelCatalog.shared.ensureLoaded(maxAge: ModelCatalog.interactiveRefreshInterval)
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

    /// Current plan pill text for the filter control.
    private var planFilterLabel: String {
        switch modelPlanFilter {
        case .all: return "PLAN"
        case .uncovered: return "NO PLAN"
        case .plan(let id):
            guard let plan = ModelPlanIndex.plans().plans.first(where: { $0.id == id }) else {
                return id.uppercased()
            }
            return plan.short
        }
    }

    private func recomputeFilteredRows(force: Bool = false) {
        // Key from cheap accessors only: `count` and `currentRevision()` are
        // lock-guarded scalar reads. It carries a *content* fingerprint of the
        // usage inputs, so per-model token/spend/speed changes invalidate it
        // too (catalog counts and revision alone never move for those).
        let baseKey = ModelsPipeline.baseKey(
            catalogCount: ModelCatalog.shared.count,
            revision: ModelCatalog.shared.currentRevision(),
            usageModels: model.usage.models,
            syntheticModels: model.syntheticModels,
            search: modelSearch,
            scope: modelFilterScope,
            planFilter: modelPlanFilter,
            sortColumn: modelSortColumn,
            sortAscending: modelSortAscending
        )
        if !force && baseKey == _lastBaseKey && !_filteredRows.isEmpty { return }
        _lastBaseKey = baseKey
        // Only pay for the catalog materialization once we know we will run.
        let catalog = ModelCatalog.shared.allEntries()
        let syntheticModels = model.syntheticModels
        let usageModels = model.usage.models
        Task.detached(priority: .userInitiated) { [modelSearch, modelFilterScope, modelPlanFilter, modelSortColumn, modelSortAscending] in
            let result = ModelsPipeline.compute(
                search: modelSearch,
                scope: modelFilterScope,
                planFilter: modelPlanFilter,
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
                self._planCounts = result.planCounts
                self._uncoveredCount = result.uncoveredCount
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
        case "devin", "swe", "windsurf", "cognition": return "Devin"
        default: return p
        }
    }

    static func formatReset(_ d: Date, now: Date = Date()) -> String {
        let diff = d.timeIntervalSince(now)
        if diff <= 0 { return "now" }
        if diff < 3600 { return "\(Int(diff / 60))m" }
        if diff < 86400 { return "\(Int(diff / 3600))h \(Int((diff.truncatingRemainder(dividingBy: 3600)) / 60))m" }
        let days = Int(diff / 86400)
        let hours = Int((diff.truncatingRemainder(dividingBy: 86400)) / 3600)
        return "\(days)d \(hours)h"
    }

    static func formatResetShort(_ d: Date, now: Date = Date()) -> String {
        let diff = d.timeIntervalSince(now)
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
        case "devin", "swe", "windsurf": return Color(red: 0.30, green: 0.30, blue: 0.95)
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
                // Second cycle windows (monthly) render inline in the row —
                // only non-window extras ("search") earn a subtitle mention.
                sub = extra.map { $0.isWeekly ? "opencode-go zen" : "extra: \($0.label)" } ?? "opencode-go zen"
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

    /// Short window tag for the plan-cycle headroom lines: WK / MO / 7D / 30D.
    static func cycleTag(_ label: String) -> String {
        let l = label.lowercased()
        if l.contains("week") { return "WK" }
        if l.contains("month") || l.hasSuffix("mo") { return "MO" }
        return String(l.uppercased().prefix(4))
    }

    /// One compact cycle-headroom line in the PLAN LIMITS table: window tag +
    /// remaining bar + "N% left" + "(used%)". Sized to the 130pt column; two
    /// stack when a provider reports weekly and monthly windows.
    private func planCycleLine(_ c: ProviderLimit) -> some View {
        let rem = c.remainingPercent
        return HStack(spacing: 4) {
            Text(DashboardTabs.cycleTag(c.label))
                .font(.system(size: 6.5, weight: .bold, design: .monospaced))
                .foregroundStyle(.white.opacity(0.4))
                .frame(width: 20, alignment: .leading)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.12))
                Capsule().fill(rem > 50 ? Color.green : rem > 20 ? Color.orange : Color.red)
                    .frame(width: max(2, CGFloat(30 * Swift.min(rem, 100) / 100)))
            }
            .frame(width: 30, height: 4)

            Text("\(String(format: "%.0f%%", rem)) left")
                .font(.system(size: 7.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(rem > 50 ? Color.green : rem > 20 ? Color.orange : Color.red)
                .frame(width: 40, alignment: .leading)

            Text("(\(Int(c.usedPercent))%)")
                .font(.system(size: 6.5, design: .monospaced))
                .foregroundStyle(.white.opacity(0.35))
                .frame(width: 28, alignment: .trailing)
        }
        .frame(width: 130, alignment: .leading)
    }
}
