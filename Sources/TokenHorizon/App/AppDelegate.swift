import AppKit
import TokenHorizonCore
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    let model = UIModel()
    let engine = UsageEngine()
    var server: LocalServer!
    var notchPanel: NotchPanel?
    var statusItem: NSStatusItem?
    var popover: NSPopover?
    var dashboardWindow: NSWindow?
    private var usingTray = false
    private var surfacesBuilt = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Wire the TokenHorizonCore platform seams to the macOS backends.
        Platform.systemStats = SystemStats.self

        try? "launch at \(Date())\n".write(to: URL(fileURLWithPath: "/tmp/token-horizon-launch.log"), atomically: true, encoding: .utf8)
        // One router for every host (core): app and headless serve identical APIs.
        let router = CoreAPIRouter(engine: engine, usageStore: try? SQLiteUsageStore())
        router.serverName = "token-horizon"
        router.processesOverride = { [weak self] in
            if let self = self, !self.model.allProcesses.isEmpty {
                return (self.model.allProcesses, self.model.processes, self.model.processesMem, self.model.processesDisk, self.model.processesNet)
            }
            return SystemStats.processSamples()
        }
        router.onShellEvent = { [weak self] _ in
            DispatchQueue.main.async {
                self?.model.latestEvent = EventStore.shared.latest()
                self?.model.shellEvents = EventStore.shared.recent(limit: 9)
            }
            self?.refreshHeavy()
        }
        engine.localRuntimeUsage = { RuntimeUsageLedger.shared.contributions() }
        InferenceMonitor.shared.startPolling()
        router.startMetersFromEnv()
        router.startMetersFromSettings()
        // Ollama metering (replaces the old telemetry proxy): with consent,
        // listen on 11435 and route our own Ollama client through it so the
        // app's queries are measured too. Asks once, remembers the answer.
        if ConsentManager.shared.ensure(.metering,
                reason: "A loopback listener measures token usage and exact tok/s per Ollama API request. Traffic is forwarded unchanged to your local Ollama server."),
           router.addMeter(vendor: "ollama", port: 11435, target: nil) {
            OllamaClient.baseURLProvider = { URL(string: "http://127.0.0.1:11435") }
            model.ollamaMeterPort = 11435
        }
        server = LocalServer(router: router)
        server.start()
        _ = TokenHorizonTelemetry.shared

        model.latestEvent = EventStore.shared.latest()
        model.shellEvents = EventStore.shared.recent(limit: 9)
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
        rebuildSurfaces()
        NotificationCenter.default.addObserver(forName: .refreshTrends, object: nil, queue: .main) { [weak self] _ in
            self?.refreshTrends()
        }
        NotificationCenter.default.addObserver(forName: .refreshModelExtras, object: nil, queue: .main) { [weak self] _ in
            self?.refreshOllama()
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
                        self.statusItem?.button?.title = String(format: "◉ %2.0f%% %2.0f%%",
                                                                 sys.cpuPercent,
                                                                 sys.ramUsedGB / max(sys.ramTotalGB, 1) * 100)
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

        NotificationCenter.default.addObserver(forName: .openDashboard, object: nil, queue: .main) { [weak self] _ in
            self?.openDashboard()
        }
        NotificationCenter.default.addObserver(forName: .planLimitsUpdated, object: nil, queue: .main) { [weak self] note in
            let limits = (note.object as? [ProviderLimit]) ?? PlanLimitsEngine.shared.cachedLimits()
            self?.model.planLimits = limits
            LimitNotifier.shared.checkLimits(limits)
        }
        NotificationCenter.default.addObserver(forName: .kimiLimitsUpdated, object: nil, queue: .main) { [weak self] note in
            let limits = (note.object as? [ProviderLimit]) ?? KimiLimitsEngine.shared.cachedLimits()
            self?.model.kimiLimits = limits
            LimitNotifier.shared.checkLimits(limits)
        }
        NotificationCenter.default.addObserver(forName: NSNotification.Name("TokenHorizonProcessMonitoringDidChange"), object: nil, queue: .main) { [weak self] note in
            guard let self else { return }
            if (note.object as? Bool) == false {
                self.model.allProcesses = []
                self.model.processes = []
                self.model.processesMem = []
                self.model.processesDisk = []
                self.model.processesNet = []
            }
            self.refreshHeavy()
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.rebuildSurfaces()
        }
    }

    private var hasNotch: Bool {
        if ProcessInfo.processInfo.environment["TOKEN_HORIZON_FORCE_TRAY"] == "1" { return false }
        return NSScreen.screens.contains { $0.safeAreaInsets.top > 0 }
    }

    func rebuildSurfaces() {
        let wantTray = !hasNotch
        if surfacesBuilt, wantTray == usingTray { return }
        surfacesBuilt = true
        usingTray = wantTray

        if wantTray {
            notchPanel?.orderOut(nil)
            notchPanel = nil
            setupStatusItem()
        } else {
            removeStatusItem()
            closeDashboard()
            if notchPanel == nil {
                let panel = NotchPanel(model: model)
                panel.relayout(expanded: false)
                panel.orderFrontRegardless()
                notchPanel = panel
            } else {
                notchPanel?.relayout(expanded: false)
                notchPanel?.orderFrontRegardless()
            }
        }
    }

    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
            button.title = "◉ …"
        }
        let pop = NSPopover()
        pop.contentSize = NSSize(width: 560, height: 680)
        pop.behavior = .transient
        pop.appearance = NSAppearance(named: .darkAqua)
        let wrap = NSHostingController(rootView:
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
            clearProcessSamples()
        } else {
            pop.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
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
            let host = NSHostingView(rootView:
                DashboardTabs(model: model, compact: false)
                    .padding(16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            )
            if #available(macOS 13.0, *) { host.sizingOptions = [] }
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
        if !hasNotch { clearProcessSamples() }
    }

    func refresh() {
        refreshHeavy()
    }

    func refreshHeavy() {
        KimiLimitsEngine.shared.refreshIfDue(maxAge: 30)
        PlanLimitsEngine.shared.refreshIfDue(maxAge: 30)
        // Process enumeration runs only while the process table is visible.
        let sampleProcesses = processMonitoringActive
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let usage = engine.snapshot()
            let procs = sampleProcesses ? SystemStats.processSamples() : nil
            DispatchQueue.main.async {
                self.model.usage = usage
                if let procs {
                    guard self.processMonitoringActive else { return }
                    self.model.allProcesses = procs.all
                    self.model.processes = procs.byCPU
                    self.model.processesMem = procs.byMem
                    self.model.processesDisk = procs.byDisk
                    self.model.processesNet = procs.byNet
                }
            }
        }
    }

    private var processMonitoringActive: Bool {
        if dashboardWindow?.isVisible == true { return true }
        if hasNotch { return model.notchExpanded }
        return popover?.isShown == true || dashboardWindow?.isVisible == true
    }

    private func clearProcessSamples() {
        model.allProcesses = []
        model.processes = []
        model.processesMem = []
        model.processesDisk = []
        model.processesNet = []
    }

    func refreshTrends() {
        let window = model.trendWindow
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let points = engine.trendHistory(window: window)
            DispatchQueue.main.async {
                self.model.trendPoints = points
            }
        }
    }

    func refreshHistory() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let result = engine.history(days: 370)
            DispatchQueue.main.async {
                self.model.historyPoints = result.points
                self.model.historyStreak = result.streak
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
                    capabilities: m.capabilities
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
        TokenHorizonTelemetry.shared.shutdown()
    }
}
