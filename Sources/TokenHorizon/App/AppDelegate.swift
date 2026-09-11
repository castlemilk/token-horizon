import AppKit
import TokenHorizonCore
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    let model = UIModel()
    let engine = UsageEngine()
    var server: POSIXLoopbackHTTPServer!
    var notchPanel: NotchPanel?
    var statusItem: NSStatusItem?
    var popover: NSPopover?
    var dashboardWindow: NSWindow?
    private var usingTray = false
    private var surfacesBuilt = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSLog("TokenHorizon starting (build %@)", BuildInfo.display)
        // Single instance on :8765, newest launch wins. A duplicate of our
        // own build exits quietly (login item + launcher double-fire);
        // anything else is replaced so a stale binary can never shadow us.
        switch InstanceGuard.claimPort() {
        case .proceed:
            break
        case .duplicate:
            NSLog("TokenHorizon: same build already serving :8765 — exiting quietly")
            NSApp.terminate(nil)
            return
        case .conflict:
            NSLog("TokenHorizon: :8765 held by another process that would not yield — exiting(1) for supervised relaunch")
            exit(1)
        }
        // Wire the TokenHorizonCore platform seams to the macOS backends.
        Platform.systemStats = SystemStats.self

        try? "launch at \(Date())\n".write(to: URL(fileURLWithPath: "/tmp/token-horizon-launch.log"), atomically: true, encoding: .utf8)
        // One router for every host (core): app and headless serve identical APIs.
        let usageStore = try? SQLiteUsageStore()
        let router = CoreAPIRouter(engine: engine, usageStore: usageStore)
        router.serverName = "token-horizon"
        router.processesOverride = { [weak self] in
            if let self = self, !self.model.allProcesses.isEmpty {
                return (self.model.allProcesses, self.model.processes, self.model.processesMem, self.model.processesDisk, self.model.processesNet)
            }
            return SystemStats.processSamples()
        }
        router.onShellEvent = { [weak self] _ in
            DispatchQueue.main.async {
                self?.model.latestEvent = EventStore.shared.latest().map(ShellEvent.init)
                self?.model.shellEvents = EventStore.shared.recent(limit: 9).map(ShellEvent.init)
            }
            self?.refreshHeavy()
        }
        engine.localRuntimeUsage = { RuntimeUsageLedger.shared.contributions() }
        engine.usageStore = usageStore
        InferenceMonitor.shared.startPolling()
        if ConsentManager.shared.isGranted(.fileReading) {
            FilePoller.shared.startPolling()
        }
        router.startMetersFromEnv()
        router.startMetersFromSettings()
        // Ollama metering (replaces the old telemetry proxy): with consent,
        // listen on 11435 and route our own Ollama client through it so the
        // app's queries are measured too. Asks once, remembers the answer.
        if ConsentManager.shared.ensure(.metering,
                reason: "A loopback listener measures token usage and exact tok/s per Ollama API request. Traffic is forwarded unchanged to your local Ollama server."),
           router.addMeter(vendor: "ollama", port: 11435, target: nil) {
            OllamaClient.baseURLProvider = { URL(string: "http://127.0.0.1:11435") }
        }
        // One server on every machine: the POSIX loopback transport +
        // core CoreAPIRouter (the old NWListener LocalServer is gone).
        server = POSIXLoopbackHTTPServer { router.route($0) }
        _ = TokenHorizonTelemetry.shared
        // Zero-latency instant UI hydration from durable disk cache
        if SettingsStore.shared.historyPersistenceEnabled {
            if let snap = DurableStore.shared.loadSnapshot() {
                model.usage = snap
            }
            if let hist = DurableStore.shared.loadHistory() {
                model.historyPoints = hist.points
                model.historyStreak = hist.streak
            }
            if let trends = DurableStore.shared.loadTrends(window: model.trendWindow) {
                model.trendPoints = trends
            }
            if let lims = DurableStore.shared.loadLimits() {
                model.planLimits = lims.plan
                model.kimiLimits = lims.kimi
            }
        }
        server.start()
        _ = TokenHorizonTelemetry.shared

        model.latestEvent = EventStore.shared.latest().map(ShellEvent.init)
        model.shellEvents = EventStore.shared.recent(limit: 9).map(ShellEvent.init)
        _ = SystemStats.snapshot()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self else { return }
            let s = SystemStats.snapshot()
            DispatchQueue.main.async { self.model.sys = s }
        }
        refresh()
        refreshHistory()
        refreshOllama()
        refreshMLX()
        KimiLimitsEngine.shared.refreshIfDue()
        PlanLimitsEngine.shared.refreshIfDue()
        ModelCatalog.shared.ensureLoaded()
        ModelDiscoveryEngine.shared.start()
        rebuildSurfaces()
        NotificationCenter.default.addObserver(forName: .refreshTrends, object: nil, queue: .main) { [weak self] _ in
            self?.refreshTrends()
        }
        NotificationCenter.default.addObserver(forName: .refreshModelExtras, object: nil, queue: .main) { [weak self] _ in
            self?.refreshOllama()
        }
        NotificationCenter.default.addObserver(forName: .ollamaTelemetryUpdated, object: nil, queue: .main) { [weak self] _ in
            self?.refresh()
            self?.refreshOllama()
            self?.refreshTrends()
        }

        // Light tick: sys + coarse every 2s
        let sysTimer = Timer(timeInterval: 2.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.refreshMLX()
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let self else { return }
                let sys = SystemStats.snapshot()
                DispatchQueue.main.async {
                    self.model.sys = sys
                    self.model.record(cpu: sys.cpuPercent,
                                      ram: sys.ramUsedGB / max(sys.ramTotalGB, 1) * 100,
                                      disk: sys.diskMBps,
                                      net: sys.netMBps)
                    self.model.recordCoarse()
                    if self.usingTray {
                        let memPct = sys.ramUsedGB / max(sys.ramTotalGB, 1) * 100
                        self.statusItem?.button?.title = String(format: "◉ %2.0f%% %2.0f%%",
                                                                 sys.cpuPercent, memPct)
                        self.statusItem?.button?.image = StatusIcon.image(cpuPercent: sys.cpuPercent, memPercent: memPct)
                    }
                }
            }
        }
        RunLoop.main.add(sysTimer, forMode: .common)

        // Heavy tick: usage + procs every 5s, history/trends every 60s, limits every 30s
        var heavyTick = 0
        let heavyTimer = Timer(timeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.refreshHeavy()
            heavyTick += 1
            if heavyTick % 12 == 0 {
                self?.refreshHistory()
                self?.refreshTrends()
            }
            if heavyTick % 6 == 0 {
                KimiLimitsEngine.shared.refreshIfDue()
                PlanLimitsEngine.shared.refreshIfDue()
                self?.model.kimiLimits = KimiLimitsEngine.shared.cachedLimits().map(ProviderLimit.init)
                self?.model.planLimits = PlanLimitsEngine.shared.cachedLimits().map(ProviderLimit.init)
            }
            if heavyTick % 12 == 0 {
                self?.refreshOllama()
                ModelCatalog.shared.ensureLoaded()
            }
        }
        RunLoop.main.add(heavyTimer, forMode: .common)

        NotificationCenter.default.addObserver(forName: .openDashboard, object: nil, queue: .main) { [weak self] _ in
            self?.openDashboard()
        }
        NotificationCenter.default.addObserver(forName: .planLimitsUpdated, object: nil, queue: .main) { [weak self] note in
            let core = (note.object as? [TokenHorizonCore.ProviderLimit]) ?? PlanLimitsEngine.shared.cachedLimits()
            let limits = core.map(ProviderLimit.init)
            self?.model.planLimits = limits
            LimitNotifier.shared.checkLimits(limits)
            if let self {
                DurableStore.shared.saveLimits(plan: limits, kimi: self.model.kimiLimits)
            }
        }
        NotificationCenter.default.addObserver(forName: .kimiLimitsUpdated, object: nil, queue: .main) { [weak self] note in
            let core = (note.object as? [TokenHorizonCore.ProviderLimit]) ?? KimiLimitsEngine.shared.cachedLimits()
            let limits = core.map(ProviderLimit.init)
            self?.model.kimiLimits = limits
            LimitNotifier.shared.checkLimits(limits)
            if let self {
                DurableStore.shared.saveLimits(plan: self.model.planLimits, kimi: limits)
            }
        }
        NotificationCenter.default.addObserver(forName: NSNotification.Name("TokenHorizonProcessMonitoringDidChange"), object: nil, queue: .main) { [weak self] note in
            guard let self else { return }
            if (note.object as? Bool) == true {
                self.refreshHeavy()
            }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.rebuildSurfaces()
        }
        NotificationCenter.default.addObserver(forName: .tokenHorizonSurfaceDidChange, object: nil, queue: .main) { [weak self] _ in
            self?.rebuildSurfaces()
        }
    }

    /// Surface precedence: TOKEN_HORIZON_FORCE_TRAY=1 (escape hatch) >
    /// Settings surfaceMode > auto-detect (notch screen present?).
    enum ActiveSurface { case notch, tray }

    func resolveSurface() -> ActiveSurface {
        if ProcessInfo.processInfo.environment["TOKEN_HORIZON_FORCE_TRAY"] == "1" { return .tray }
        switch SettingsStore.shared.surfaceMode {
        case .tray: return .tray
        case .notch: return .notch
        case .auto: return hasNotch ? .notch : .tray
        }
    }

    private var hasNotch: Bool {
        NSScreen.screens.contains { $0.safeAreaInsets.top > 0 }
    }

    func rebuildSurfaces() {
        let surface = resolveSurface()
        let extraTray = SettingsStore.shared.showTrayIcon
        let wantTray = (surface == .tray) || extraTray
        let wantNotch = (surface == .notch)
        if surfacesBuilt, wantTray == usingTray, wantNotch == (notchPanel != nil) { return }
        surfacesBuilt = true
        usingTray = wantTray

        if wantTray {
            if statusItem == nil { setupStatusItem() }
        } else {
            removeStatusItem()
        }

        if wantNotch {
            // Exclusive-notch closes the dashboard window (tray→notch
            // transition); with both surfaces the window is independent.
            if !extraTray { closeDashboard() }
            if notchPanel == nil {
                let panel = NotchPanel(model: model)
                panel.relayout(expanded: false)
                panel.orderFrontRegardless()
                notchPanel = panel
            } else {
                notchPanel?.relayout(expanded: false)
                notchPanel?.orderFrontRegardless()
            }
        } else {
            notchPanel?.orderOut(nil)
            notchPanel = nil
        }
    }

    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
            button.title = "◉ …"
            button.image = StatusIcon.image(cpuPercent: 0, memPercent: 0)
        }
        let pop = NSPopover()
        pop.contentSize = NSSize(width: 560, height: 680)
        pop.behavior = .transient
        pop.appearance = NSAppearance(named: .darkAqua)
        let wrap = FirstMouseHostingController(rootView:
            DashboardTabs(model: model, compact: false)
                .padding(14)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black.opacity(0.96))
        )
        pop.contentViewController = wrap
        popover = pop
        item.button?.target = self
        item.button?.action = #selector(togglePopover(_:))
        statusItem = item
    }

    private func removeStatusItem() {
        popover?.close()
        popover = nil
        if let item = statusItem { NSStatusBar.system.removeStatusItem(item) }
        statusItem = nil
    }

    @objc func togglePopover(_ sender: Any?) {
        guard let button = statusItem?.button, let pop = popover else { return }
        if pop.isShown {
            pop.close()
        } else {
            pop.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
            pop.contentViewController?.view.window?.makeKey()
            refreshHeavy()
        }
    }

    func openDashboard() {
        popover?.close()
        let window: NSWindow
        if let existing = dashboardWindow {
            window = existing
        } else {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 680),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable],
                             backing: .buffered, defer: false)
            w.title = "Token Horizon"
            w.appearance = NSAppearance(named: .darkAqua)
            w.isReleasedWhenClosed = false
            w.center()
            // NSHostingView set as contentView auto-fills the window; sizingOptions=[]
            // stops it from pushing the window size back from SwiftUI's ideal size.
            let host = FirstMouseHostingView(rootView:
                DashboardTabs(model: model, compact: false)
                    .padding(16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            )
            host.sizingOptions = []
            w.contentView = host
            dashboardWindow = w
            window = w
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        refreshHeavy()
    }

    private func closeDashboard() {
        dashboardWindow?.close()
        dashboardWindow = nil
    }

    func refresh() {
        refreshHeavy()
    }

    func refreshHeavy() {
        KimiLimitsEngine.shared.refreshIfDue(maxAge: 30)
        PlanLimitsEngine.shared.refreshIfDue(maxAge: 30)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let usage = self.engine.snapshot()
            let procs = SystemStats.processSamples()
            let containers = DockerObserver.sampleContainers()
            DispatchQueue.main.async {
                self.model.usage = UsageSnapshot(usage)
                self.model.storeProcesses(all: procs.all, byCPU: procs.byCPU, byMem: procs.byMem,
                                          byDisk: procs.byDisk, byNet: procs.byNet)
                self.model.dockerContainers = containers
                LeaderboardStore.shared.syncLocal(snapshot: usage, history: self.model.historyPoints, streak: self.model.historyStreak)
                self.model.leaderboardRankings = LeaderboardStore.shared.rankings(for: .today)

                if SettingsStore.shared.leaderboardAutoSync {
                    // Cloud backend preferred: edge-cached reads + TTL/change-gated
                    // writes. Sheets stays as the legacy fallback. Both paths are
                    // policy-gated inside the store (no per-tick network hammer)
                    // and rankings always serve instantly from memory.
                    if SettingsStore.shared.leaderboardCloudConfigured {
                        LeaderboardStore.shared.publishToCloud { _ in }
                        LeaderboardStore.shared.pullFromCloud { _ in
                            DispatchQueue.main.async {
                                self.model.leaderboardRankings = LeaderboardStore.shared.rankings(for: .today)
                            }
                        }
                    } else if !SettingsStore.shared.leaderboardSheetsURL.isEmpty {
                        LeaderboardStore.shared.publishToGoogleSheet { _ in }
                        LeaderboardStore.shared.pullFromGoogleSheet { _ in
                            DispatchQueue.main.async {
                                self.model.leaderboardRankings = LeaderboardStore.shared.rankings(for: .today)
                            }
                        }
                    }
                }
                }
        }
    }

    func refreshTrends() {
        let window = model.trendWindow
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let points = engine.trendHistory(window: window.core).map(HistoryPoint.init)
            DispatchQueue.main.async {
                self.model.trendPoints = points
            }
        }
    }

    func refreshHistory() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let result = engine.history(days: 370)
            let heatmap = engine.activityHeatmap(days: 28)
            let points = result.points.map(HistoryPoint.init)
            DispatchQueue.main.async {
                self.model.historyPoints = points
                self.model.historyStreak = result.streak
                LeaderboardStore.shared.syncLocal(snapshot: self.model.usage, history: points,
                                                  streak: result.streak, heatmap: heatmap)
                self.model.leaderboardRankings = LeaderboardStore.shared.rankings(for: .today)
            }
        }
    }

    func refreshOllama() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let installed = OllamaClient.fetchInstalled()
            let ollama = installed.map { m -> ModelUsage in
                let param = m.details["parameter_size"] ?? ""
                let quant = m.details["quantization_level"] ?? ""
                let ctxLen = Int(m.details["context_length"] ?? "0") ?? 0
                return ModelUsage(
                    provider: "ollama",
                    model: m.name,
                    tokensAll: 0,
                    tokensToday: 0,
                    cost: 0,
                    messages: 0,
                    free: true,
                    cacheReadAll: 0,
                    estCost: 0,
                    contextK: ctxLen > 0 ? (ctxLen / 1000) : 0,
                    tokPerSec: m.tokPerSec,
                    promptTokPerSec: m.promptTokPerSec,
                    paramSize: param.isEmpty ? nil : param,
                    quant: quant.isEmpty ? nil : quant,
                    isLocal: true,
                    capabilities: m.capabilities,
                    localModelName: m.name
                )
            }
            DispatchQueue.main.async {
                self?.model.syntheticModels = ollama
            }
        }
    }

    private func refreshMLX() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let samples = SystemStats.mlxProcessSamples()
            let snapshot = MLXObserver.snapshot(from: samples)
            TokenHorizonTelemetry.shared.recordMLX(snapshot)
            DispatchQueue.main.async {
                self.model.recordMLX(snapshot)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        ModelDiscoveryEngine.shared.stop()
        // Exact parser-state persistence for fast next boot (throttled to
        // 60s during the run; a few hundred ms here is invisible on quit).
        DurableStore.shared.flushEngineState()
        TokenHorizonTelemetry.shared.shutdown()
    }
}
