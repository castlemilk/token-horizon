import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    let model = UIModel()
    // Created via the composition root so tests can substitute fakes at the
    // seam without touching this wiring. Same concrete type, no behavior change.
    let engine = AppDependencies.makeUsageEngine()
    var server: LocalServer!
    var notchPanel: NotchPanel?
    var statusItem: NSStatusItem?
    var popover: NSPopover?
    var dashboardWindow: NSWindow?
    private var usingTray = false
    private var surfacesBuilt = false
    private var surfaceRebuildScheduled = false
    private let heavyRefresh = HeavyRefreshCoordinator()
    private let refreshQueue = DispatchQueue(label: "token-horizon.refresh", qos: .utility)

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

        server = LocalServer(statsProvider: { [engine] in engine.snapshot() },
                             sysProvider: { SystemStats.snapshot() },
                             historyProvider: { [engine] days in engine.history(days: days) },
                             trendsProvider: { [engine] window in engine.trendHistory(window: window) },
                              limitsProvider: { [engine] in
                                  let plan = PlanLimitsEngine.shared.cachedLimits()
                                  let kimi = KimiLimitsEngine.shared.cachedLimits()
                                  // Cached (non-blocking): a cold-start scan
                                  // must not stall /limits for minutes.
                                  var all = engine.cachedSnapshot()?.limits ?? []
                                  if plan.contains(where: { $0.provider == "codex" }) {
                                      all.removeAll(where: { $0.provider == "codex" })
                                  }
                                  all.append(contentsOf: kimi)
                                  all.append(contentsOf: plan)
                                  return all
                              },
                              processesProvider: { [weak self] in
                                  if let self {
                                      let snap = self.model.processSnapshot()
                                      if !snap.all.isEmpty { return snap }
                                  }
                                  let live = SystemStats.processSamples()
                                  return (live.all, live.byCPU, live.byMem, live.byDisk, live.byNet)
                              },
                              heatmapProvider: { [engine] days in engine.activityHeatmap(days: days) },
                              leaderboardDataProvider: { [engine] in engine.leaderboardData() },
                             onEvent: { [weak self] ev in
                                 EventStore.shared.add(ev)
                                 DispatchQueue.main.async {
                                     self?.model.latestEvent = EventStore.shared.latest()
                                     self?.model.shellEvents = EventStore.shared.recent(limit: 9)
                                 }
                                 self?.refreshHeavy()
                             },
                             onCacheReset: { [weak self] in
                                 self?.engine.resetState()
                                 self?.refresh()
                                 self?.refreshHistory()
                                 self?.refreshTrends()
                             })
        server.localModelsProvider = { [weak self] in
            self?.localModelsPayload() ?? [:]
        }
        server.start()
        // fs-event-driven freshness: writes under provider roots mark the
        // owning source dirty and fire this ~0.75s later (debounced), so
        // usage lands in the UI/API in ~1s instead of waiting out the 5s
        // tick. Idle ticks then do zero file work; a 60s sweep backstops.
        engine.onActivity = { [weak self] in self?.refreshHeavy() }
        _ = TokenHorizonTelemetry.shared
        OllamaTelemetryProxy.shared.start()
        GatewaySupervisor.shared.start()

        model.latestEvent = EventStore.shared.latest()
        model.shellEvents = EventStore.shared.recent(limit: 9)
        _ = SystemStats.snapshot()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self else { return }
            let s = SystemStats.snapshot()
            DispatchQueue.main.async { self.model.sys = s }
        }
        publishWidget()
        NotificationCenter.default.addObserver(forName: .tokenHorizonWidgetDidChange, object: nil, queue: .main) { [weak self] _ in
            self?.publishWidget(force: true)
        }
        LeaderboardSyncController.shared.configureCollector { [weak self] completion in
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let self else { return }
                let data = self.engine.leaderboardData()
                completion(.success(data))
                DispatchQueue.main.async {
                    self.applyLeaderboardData(data)
                    self.publishWidget()
                }
            }
        }
        refresh()
        refreshHistory()
        refreshTrends()
        refreshOllama()
        refreshMLX()
        KimiLimitsEngine.shared.refreshIfDue()
        PlanLimitsEngine.shared.refreshIfDue()
        ModelCatalog.shared.ensureLoaded()
        ModelDiscoveryEngine.shared.start()
        SelfUpdater.shared.start()
        EngineManager.shared.startPolling()
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
                        // Rings only — no text title. The old "◉ %2.0f%% %2.0f%%"
                        // title duplicated the rings, padded single digits with
                        // spaces, and made the item wide enough to get clipped
                        // off crowded menu bars (reads as a "broken gauge").
                        self.statusItem?.button?.title = ""
                        self.statusItem?.button?.toolTip = String(format: "CPU %.0f%%  ·  MEM %.0f%%", sys.cpuPercent, memPct)
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
                self?.model.kimiLimits = KimiLimitsEngine.shared.cachedLimits()
                self?.model.planLimits = PlanLimitsEngine.shared.cachedLimits()
            }
            if heavyTick % 12 == 0 {
                self?.refreshOllama()
                ModelCatalog.shared.ensureLoaded()
            }
        }
        RunLoop.main.add(heavyTimer, forMode: .common)

        NotificationCenter.default.addObserver(forName: .openDashboard, object: nil, queue: .main) { [weak self] note in
            self?.openDashboard(tab: note.object as? DashboardTab,
                                settingsSection: note.userInfo?["settingsSection"] as? AppSettingsSection)
        }
        NotificationCenter.default.addObserver(forName: .openWebDestination, object: nil, queue: .main) { [weak self] note in
            guard let destination = note.object as? WebDestination else { return }
            self?.openWeb(destination)
        }
        NotificationCenter.default.addObserver(forName: NSNotification.Name("planLimitsUpdated"), object: nil, queue: .main) { [weak self] note in
            let limits = (note.object as? [ProviderLimit]) ?? PlanLimitsEngine.shared.cachedLimits()
            self?.model.planLimits = limits
            LimitNotifier.shared.checkLimits(limits)
            if let self {
                DurableStore.shared.saveLimits(plan: limits, kimi: self.model.kimiLimits)
            }
        }
        NotificationCenter.default.addObserver(forName: NSNotification.Name("kimiLimitsUpdated"), object: nil, queue: .main) { [weak self] note in
            let limits = (note.object as? [ProviderLimit]) ?? KimiLimitsEngine.shared.cachedLimits()
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
            self?.scheduleSurfaceRebuild()
        }
        NotificationCenter.default.addObserver(forName: .tokenHorizonSurfaceDidChange, object: nil, queue: .main) { [weak self] _ in
            self?.scheduleSurfaceRebuild()
        }
        NotificationCenter.default.addObserver(forName: .dismissNotch, object: nil, queue: .main) { [weak self] _ in
            self?.popover?.close()
        }
        NotificationCenter.default.addObserver(forName: .refreshLocalLeaderboard, object: nil, queue: .main) { [weak self] _ in
            self?.refreshLocalLeaderboard()
        }
    }

    /// Surface precedence: TOKEN_HORIZON_FORCE_TRAY=1 (escape hatch) >
    /// Settings surfaceMode > auto-detect (notch screen present?).
    enum ActiveSurface: Equatable { case notch, tray }

    func resolveSurface() -> ActiveSurface {
        Self.resolveSurface(mode: SettingsStore.shared.surfaceMode,
                            forceTray: ProcessInfo.processInfo.environment["TOKEN_HORIZON_FORCE_TRAY"] == "1",
                            hasNotch: hasNotch)
    }

    static func resolveSurface(mode: SurfaceMode, forceTray: Bool, hasNotch: Bool) -> ActiveSurface {
        if forceTray { return .tray }
        switch mode {
        case .tray: return .tray
        case .notch: return .notch
        case .auto: return hasNotch ? .notch : .tray
        }
    }

    private var hasNotch: Bool {
        // Active-display check matters on clamshell rigs: the lid-closed
        // internal panel can linger in NSScreen.screens while inactive.
        NSScreen.screens.contains { $0.safeAreaInsets.top > 0 && $0.isActiveDisplay }
    }

    private func scheduleSurfaceRebuild() {
        guard !surfaceRebuildScheduled else { return }
        surfaceRebuildScheduled = true
        // Let the control's event and Settings draft update finish before
        // removing any host view. Multiple settings notifications fold here.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.surfaceRebuildScheduled = false
            self.rebuildSurfaces()
        }
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
            // Settings lives in this independent window. Changing the quick
            // surface must not close it or discard an in-progress draft.
            if notchPanel == nil {
                let panel = NotchPanel(model: model)
                panel.relayout(expanded: false)
                panel.orderFrontRegardless()
                notchPanel = panel
            }
        } else {
            // Clear expansion and process-monitoring state before releasing
            // the host. Extra-tray changes retain the existing panel above.
            notchPanel?.dismiss()
            notchPanel?.orderOut(nil)
            notchPanel = nil
        }
    }

    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.title = ""
            button.toolTip = "Token Horizon"
            button.image = StatusIcon.image(cpuPercent: 0, memPercent: 0)
        }
        let pop = NSPopover()
        pop.contentSize = NSSize(width: 740, height: 680)
        pop.behavior = .transient
        pop.appearance = NSAppearance(named: .darkAqua)
        let wrap = FirstMouseHostingController(rootView:
            DashboardTabs(model: model, compact: true)
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

    func openDashboard(tab: DashboardTab? = nil, settingsSection: AppSettingsSection? = nil) {
        popover?.close()
        let window: NSWindow
        if let existing = dashboardWindow {
            window = existing
        } else {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 680),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable],
                             backing: .buffered, defer: false)
            w.title = "Token Horizon"
            w.minSize = NSSize(width: 740, height: 540)
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
        if let tab {
            // Deliver after the new hosting view has subscribed; reused windows
            // receive the same route without recreating their view or drafts.
            DispatchQueue.main.async {
                var info: [AnyHashable: Any] = [:]
                if let settingsSection { info["settingsSection"] = settingsSection }
                NotificationCenter.default.post(name: .selectDashboardTab, object: tab, userInfo: info)
            }
        }
        refreshHeavy()
    }

    private func openWeb(_ destination: WebDestination) {
        popover?.close()
        if destination == .signIn || destination == .claimHandle {
            CloudSignInController.shared.signIn { result in
                if case .success = result { LeaderboardSyncController.shared.syncNow() }
            }
            return
        }
        let settings = SettingsStore.shared
        // Workspace and sign-in discover the browser account's owned profiles.
        // Profile, claims, and web settings target the identity published by this Mac.
        let localHandle = settings.leaderboardHandle.isEmpty ? NSUserName() : settings.leaderboardHandle
        let handle = destination == .profile || destination == .webSettings || destination == .claimHandle ? localHandle : ""
        NSWorkspace.shared.open(destination.url(baseURL: settings.leaderboardCloudURL,
                                                handle: handle))
    }

    private func closeDashboard() {
        dashboardWindow?.close()
        dashboardWindow = nil
    }

    private func publishWidget(force: Bool = false) {
        let usage = model.usage
        let history = model.historyPoints
        let hourly = model.hourTrendPoints
        var limits = usage.limits
        if model.planLimits.contains(where: { $0.provider == "codex" }) {
            limits.removeAll { $0.provider == "codex" }
        }
        limits += model.planLimits + model.kimiLimits
        WidgetBridge.shared.publish(usage: usage, history: history, hourly: hourly,
                                    limits: limits, force: force)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme?.lowercased() == "tokenhorizon" {
            if let action = WidgetDeepLink.action(from: url) {
                switch action {
                case .sync:
                    // The widget opens the shared operation's visible status,
                    // including recovery advice if publication fails.
                    openDashboard(tab: .tokens)
                    LeaderboardSyncController.shared.syncNow { [weak self] _ in
                        guard let self else { return }
                        self.refreshLeaderboardRankings { self.publishWidget(force: true) }
                    }
                case .signIn:
                    openWeb(.signIn)
                }
                continue
            }
            switch url.host {
            case "dashboard":
                let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
                let rawTab = components?.queryItems?.first(where: { $0.name == "tab" })?.value
                let tab = rawTab.flatMap { DashboardTab(rawValue: $0.uppercased()) }
                let rawSection = components?.queryItems?.first(where: { $0.name == "section" })?.value
                let section = rawSection.flatMap { value in
                    AppSettingsSection.allCases.first { $0.rawValue.localizedCaseInsensitiveCompare(value) == .orderedSame }
                }
                openDashboard(tab: tab, settingsSection: section)
            case "settings":
                openDashboard(tab: .settings)
            case "window":
                // tokenhorizon://window?value=hours|days|weeks — same effect as
                // the widget picker's link.
                guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                      let value = components.queryItems?.first(where: { $0.name == "value" })?.value,
                      let window = WidgetSnapshot.windowValue(from: value) else { continue }
                var prefs = SettingsStore.shared.widgetPreferences
                prefs.window = window
                SettingsStore.shared.widgetPreferences = prefs
            case "page":
                // tokenhorizon://page?value=next|prev|<index> — carousel nav.
                guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                      let value = components.queryItems?.first(where: { $0.name == "value" })?.value else { continue }
                var prefs = SettingsStore.shared.widgetPreferences
                guard let target = WidgetSnapshot.pageValue(from: value, current: prefs.page) else { continue }
                prefs.page = target
                SettingsStore.shared.widgetPreferences = prefs
            default:
                continue
            }
        }
    }

    func refresh() {
        refreshHeavy()
    }

    func refreshHeavy() {
        guard heavyRefresh.request() else { return }
        // Filesystem activity may request a refresh from a utility queue.
        // Capture UI-owned values only after crossing to main.
        DispatchQueue.main.async { [weak self] in self?.performHeavyRefresh() }
    }

    private func performHeavyRefresh() {
        KimiLimitsEngine.shared.refreshIfDue(maxAge: 30)
        PlanLimitsEngine.shared.refreshIfDue(maxAge: 30)
        refreshQueue.async { [weak self] in
            guard let self else { return }
            let data = self.engine.leaderboardData()
            let procs = SystemStats.processSamples()
            let containers = DockerObserver.sampleContainers()
            LeaderboardStore.shared.syncLocal(data)
            let rankings = LeaderboardStore.shared.rankings(for: .today)
            DispatchQueue.main.async {
                self.applyLeaderboardData(data)
                self.publishWidget()
                self.model.storeProcesses(all: procs.all, byCPU: procs.byCPU, byMem: procs.byMem,
                                          byDisk: procs.byDisk, byNet: procs.byNet)
                self.model.dockerContainers = containers
                self.model.leaderboardRankings = rankings

                if SettingsStore.shared.leaderboardAutoSync {
                    // Shares the manual run state while retaining the store's
                    // TTL/change gates. Publishing precedes the ranking pull.
                    LeaderboardSyncController.shared.syncAutomatically { _ in
                        self.refreshLeaderboardRankings()
                    }
                }
                if self.heavyRefresh.finish() { self.performHeavyRefresh() }
            }
        }
    }

    func refreshTrends() {
        let window = model.trendWindow
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let points = engine.trendHistory(window: window)
            // Hourly series feeds the widget's 24H chart window; fetched on the
            // 60s trends tick (trendHistory persists to disk — keep it off the
            // 5s heavy tick).
            let hourly = engine.trendHistory(window: .day)
            DispatchQueue.main.async {
                self.model.trendPoints = points
                self.model.hourTrendPoints = hourly
                // Republish so the widget's 1H window reflects the fresh
                // hourly series on the first trends tick after launch.
                self.publishWidget()
            }
        }
    }

    func refreshHistory() {
        refreshLocalLeaderboard()
    }

    /// A background completion may reach main after a newer manual export.
    private func applyLeaderboardData(_ data: LeaderboardSyncLocalData) {
        guard data.snapshot.updatedAt >= model.usage.updatedAt else { return }
        model.usage = data.snapshot
        model.historyPoints = data.history
        model.historyStreak = data.streak
    }

    /// Stage one coherent generation for profile/privacy changes too. A
    /// scan is event-gated; never combine cached UI history with fresh totals.
    private func refreshLocalLeaderboard() {
        refreshQueue.async {
            let data = self.engine.leaderboardData()
            LeaderboardStore.shared.syncLocal(data)
            let rankings = LeaderboardStore.shared.rankings(for: .today)
            DispatchQueue.main.async {
                self.applyLeaderboardData(data)
                self.model.leaderboardRankings = rankings
            }
        }
    }

    private func refreshLeaderboardRankings(completion: (() -> Void)? = nil) {
        refreshQueue.async {
            let rankings = LeaderboardStore.shared.rankings(for: .today)
            DispatchQueue.main.async {
                self.model.leaderboardRankings = rankings
                completion?()
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

    /// GET /local payload: MLX runner snapshot + bounded history series +
    /// Ollama telemetry rollup. Runs on the server connection queue — the same
    /// off-main model read pattern as processesProvider.
    private func localModelsPayload() -> [String: Any] {
        let mlx = model.mlx
        let llm = OllamaTelemetryStore.shared.summary()

        let procs: [[String: Any]] = mlx.processes.map { p in
            var d: [String: Any] = [
                "pid": p.pid, "ppid": p.ppid, "name": p.name, "command": p.command,
                "cpu": p.cpu, "memoryMB": p.memoryMB,
                "diskReadMBps": p.diskReadMBps, "diskWriteMBps": p.diskWriteMBps,
                "startTime": p.startTime.timeIntervalSince1970
            ]
            if let m = p.model { d["model"] = m }
            if let t = p.tokPerSec { d["tokPerSec"] = t }
            if let t = p.prefillTokPerSec { d["prefillTokPerSec"] = t }
            if let t = p.ttftSeconds { d["ttftSeconds"] = t }
            return d
        }

        var models: [String: Any] = [:]
        for (key, s) in llm.models {
            models[key] = ["today": s.today, "all": s.all, "prompt": s.prompt,
                           "eval": s.eval, "messages": s.messages]
        }

        var totals: [String: Any] = [
            "cpuPercent": mlx.cpuPercent,
            "memoryMB": mlx.memoryMB,
            "diskReadMBps": mlx.diskReadMBps,
            "diskWriteMBps": mlx.diskWriteMBps
        ]
        if let t = mlx.measuredTokPerSec { totals["measuredTokPerSec"] = t }
        if let t = mlx.measuredPrefillTokPerSec { totals["measuredPrefillTokPerSec"] = t }

        var payload: [String: Any] = [
            "sampledAt": mlx.sampledAt.timeIntervalSince1970,
            "processes": procs,
            "totals": totals,
            "series": [
                "cpu": model.mlxHistory.cpuSeries(), "memory": model.mlxHistory.memorySeries(),
                "disk": model.mlxHistory.diskSeries(), "tok": model.mlxHistory.tokSeries(),
                "prefill": model.mlxHistory.prefillSeries(),
                "cpuCoarse": model.mlxHistory.cpuSeries(coarse: true),
                "memoryCoarse": model.mlxHistory.memorySeries(coarse: true),
                "diskCoarse": model.mlxHistory.diskSeries(coarse: true),
                "tokCoarse": model.mlxHistory.tokSeries(coarse: true),
                "prefillCoarse": model.mlxHistory.prefillSeries(coarse: true)
            ],
            "ollama": [
                "todayTokens": llm.todayTokens, "allTokens": llm.allTokens,
                "messagesToday": llm.messagesToday, "messagesAll": llm.messagesAll,
                "models": models, "hourlyBuckets": llm.hourlyBuckets
            ]
        ]
        if let port = OllamaTelemetryProxy.shared.port { payload["proxyPort"] = Int(port) }
        if let port = GatewaySupervisor.shared.port { payload["gatewayPort"] = Int(port) }
        return payload
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
        OllamaTelemetryProxy.shared.stop()
        GatewaySupervisor.shared.stop()
        EngineManager.shared.shutdown()
        // Exact parser-state persistence for fast next boot (throttled to
        // 60s during the run; a few hundred ms here is invisible on quit).
        DurableStore.shared.flushEngineState()
        TokenHorizonTelemetry.shared.shutdown()
    }
}
