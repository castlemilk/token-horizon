import AppKit
import CoreGraphics
import SwiftUI

extension Notification.Name {
    static let dismissNotch = Notification.Name("TokenHorizonDismissNotch")
}

extension NSScreen {
    /// A screen that exists AND is actually driving pixels. A lid-closed
    /// (clamshell) internal panel can linger in NSScreen.screens while
    /// inactive — anchoring the notch UI there renders into a dead display.
    var isActiveDisplay: Bool {
        guard let key = deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else { return true }
        return CGDisplayIsActive(CGDirectDisplayID(key.uint32Value)) != 0
    }
}

final class NotchPanel: NSPanel {
    private var notchScreen: NSScreen?
    private let model: UIModel
    private var hostingView: FirstMouseHostingView<NotchContentView>?
    private var interaction = NotchInteractionPolicy()
    private var isExpanded: Bool { interaction.isExpanded }
    private var hoverTimer: Timer?
    private var collapsedHoverFrame: NSRect = .zero
    private var handlingPanelInput = false
    private var trackingMenus: [ObjectIdentifier: NSMenu] = [:]
    private var menuObservers: [NSObjectProtocol] = []
    private var screenObserver: NSObjectProtocol?
    private var dismissObserver: NSObjectProtocol?
    private var inactiveObserver: NSObjectProtocol?
    private var localEventMonitor: Any?
    private var globalEventMonitor: Any?

    struct Geometry {
        let notchWidth: CGFloat
        let wing: CGFloat
        let centerX: CGFloat
        let collapsed: NSSize
        let expanded: NSSize
        let topInset: CGFloat

        static func forScreen(_ screen: NSScreen?) -> Geometry {
            // The fallback is only used while no display is available; frame()
            // declines to position the panel until an active screen returns.
            let fallback = NSRect(x: 0, y: 0, width: 740, height: 600)
            return forDisplay(frame: screen?.frame ?? fallback,
                              visibleFrame: screen?.visibleFrame ?? fallback,
                              safeAreaTop: screen?.safeAreaInsets.top ?? 0,
                              auxiliaryTopLeftArea: screen?.auxiliaryTopLeftArea,
                              auxiliaryTopRightArea: screen?.auxiliaryTopRightArea)
        }

        /// Pure screen geometry keeps scaled displays and dock clearance testable
        /// without creating an application or a window.
        static func forDisplay(frame: NSRect, visibleFrame: NSRect, safeAreaTop: CGFloat,
                               auxiliaryTopLeftArea: NSRect? = nil,
                               auxiliaryTopRightArea: NSRect? = nil) -> Geometry {
            let topInset = max(safeAreaTop, 24)
            var notchWidth: CGFloat = 0
            var centerX = frame.midX
            if safeAreaTop > 0, let left = auxiliaryTopLeftArea, let right = auxiliaryTopRightArea {
                if right.minX > left.maxX {
                    notchWidth = right.minX - left.maxX
                    centerX = (left.maxX + right.minX) / 2
                }
            }
            let wing: CGFloat = notchWidth > 0 ? 32 : 60
            let collapsedW = notchWidth + wing * 2
            // Anchor at the physical top (including the notch), but leave room
            // above a bottom dock on short/scaled displays. Keep the notch band
            // itself intact even if transient display bounds are unusually small.
            let visibleBottom = max(frame.minY, visibleFrame.minY)
            let availableHeight = max(topInset, frame.maxY - visibleBottom - 12)
            return Geometry(
                notchWidth: notchWidth,
                wing: wing,
                centerX: centerX,
                collapsed: NSSize(width: collapsedW, height: topInset),
                expanded: NSSize(width: max(740, collapsedW + 360), height: min(topInset + 560, availableHeight)),
                topInset: topInset)
        }

        func panelFrame(in screenFrame: NSRect, expanded: Bool) -> NSRect {
            let size = expanded ? self.expanded : collapsed
            return NSRect(x: centerX - size.width / 2,
                          y: screenFrame.maxY - size.height,
                          width: size.width, height: size.height)
        }
    }

    init(model: UIModel) {
        self.model = model
        notchScreen = Self.activeScreen()
        let geo = Geometry.forScreen(notchScreen)

        super.init(contentRect: NSRect(origin: .zero, size: geo.collapsed),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        hidesOnDeactivate = false
        hasShadow = false
        isMovable = false

        let host = FirstMouseHostingView(rootView: NotchContentView(model: model, geometry: geo))
        hostingView = host
        host.sizingOptions = []
        let wrap = PanelContentView(frame: NSRect(origin: .zero, size: geo.collapsed))
        wrap.addSubview(host)
        host.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.topAnchor.constraint(equalTo: wrap.topAnchor),
            host.bottomAnchor.constraint(equalTo: wrap.bottomAnchor),
            host.leadingAnchor.constraint(equalTo: wrap.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: wrap.trailingAnchor),
        ])
        contentView = wrap

        relayout(expanded: false)
        startHoverMonitoring()
        startDismissMonitoring()

        // More and Settings menus may extend beyond the panel's hover bounds.
        // Keep the panel alive until their native tracking session ends.
        menuObservers.append(NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification,
                                                                   object: nil, queue: .main) { [weak self] note in
            guard let self, let menu = note.object as? NSMenu else { return }
            // Notifications cover every menu in the application. Admit only a
            // popup opened by an input event dispatched to this notch panel.
            let event = NSApp.currentEvent
            let eventAge = ProcessInfo.processInfo.systemUptime - (event?.timestamp ?? 0)
            let recentPanelEvent = event?.window === self && eventAge >= 0 && eventAge < 0.5
            let belongsToPanel = menu !== NSApp.mainMenu
                && ((self.handlingPanelInput && event?.window === self) || recentPanelEvent)
            let id = ObjectIdentifier(menu)
            if self.interaction.beginMenu(id, initiatedByPanel: belongsToPanel) {
                self.trackingMenus[id] = menu
            }
        })
        menuObservers.append(NotificationCenter.default.addObserver(forName: NSMenu.didEndTrackingNotification,
                                                                   object: nil, queue: .main) { [weak self] note in
            guard let menu = note.object as? NSMenu else { return }
            let id = ObjectIdentifier(menu)
            self?.trackingMenus.removeValue(forKey: id)
            self?.interaction.endMenu(id)
        })

        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.screenParametersChanged()
        }
    }

    deinit {
        hoverTimer?.invalidate()
        menuObservers.forEach { NotificationCenter.default.removeObserver($0) }
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        if let dismissObserver { NotificationCenter.default.removeObserver(dismissObserver) }
        if let inactiveObserver { NotificationCenter.default.removeObserver(inactiveObserver) }
        if let localEventMonitor { NSEvent.removeMonitor(localEventMonitor) }
        if let globalEventMonitor { NSEvent.removeMonitor(globalEventMonitor) }
    }

    private static func activeScreen() -> NSScreen? {
        NSScreen.screens.first { $0.safeAreaInsets.top > 0 && $0.isActiveDisplay }
            ?? NSScreen.main.flatMap { $0.isActiveDisplay ? $0 : nil }
            ?? NSScreen.screens.first { $0.isActiveDisplay }
    }

    private func refreshScreenGeometry() {
        notchScreen = Self.activeScreen()
        let geometry = Geometry.forScreen(notchScreen)
        if let screen = notchScreen {
            collapsedHoverFrame = geometry.panelFrame(in: screen.frame, expanded: false)
        } else {
            collapsedHoverFrame = .zero
        }
        hostingView?.rootView = NotchContentView(model: model, geometry: geometry)
    }

    private func screenParametersChanged() {
        cancelPanelMenus()
        interaction.reset()
        relayout(expanded: false)
    }

    private func frame(expanded: Bool) -> NSRect? {
        guard let screen = notchScreen, screen.isActiveDisplay else { return nil }
        let geo = Geometry.forScreen(screen)
        return geo.panelFrame(in: screen.frame, expanded: expanded)
    }

    func relayout(expanded: Bool) {
        refreshScreenGeometry()
        setExpanded(expanded, animated: false)
    }

    private func setExpanded(_ flag: Bool, animated: Bool = true) {
        let changed = isExpanded != flag || model.notchExpanded != flag
        interaction.setExpanded(flag)
        if !flag { trackingMenus.removeAll() }
        if model.notchExpanded != flag { model.notchExpanded = flag }
        if changed {
            NotificationCenter.default.post(name: NSNotification.Name("TokenHorizonProcessMonitoringDidChange"), object: flag)
        }
        guard let target = frame(expanded: flag) else { return }
        guard changed, animated, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            setFrame(target, display: true)
            return
        }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.3
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            animator().setFrame(target, display: true)
        }
    }

    private func startHoverMonitoring() {
        let timer = Timer(timeInterval: 0.06, repeats: true) { [weak self] _ in
            self?.checkHover()
        }
        RunLoop.main.add(timer, forMode: .common)
        hoverTimer = timer
    }

    private func checkHover() {
        guard isVisible, !collapsedHoverFrame.isEmpty else { return }
        let mouse = NSEvent.mouseLocation
        // Observe the visible frame while expanded. On collapse, use the cached
        // narrow trigger immediately so the shrinking body cannot reopen itself.
        let testFrame = isExpanded ? self.frame.insetBy(dx: -8, dy: -8) : collapsedHoverFrame
        let inside = testFrame.contains(mouse)
        let transition = interaction.poll(pointerInside: inside,
                                          eventTracking: RunLoop.current.currentMode == .eventTracking,
                                          now: ProcessInfo.processInfo.systemUptime)
        if interaction.menuIDs.isEmpty, !trackingMenus.isEmpty { trackingMenus.removeAll() }
        if let transition { setExpanded(transition) }
    }

    /// Close UI, Escape and external routing can all use the same safe path.
    /// Cancel only this panel's own menus, then require a fresh pointer entry.
    func dismiss() {
        cancelPanelMenus()
        interaction.dismiss()
        setExpanded(false)
    }

    private func cancelPanelMenus() {
        let menus = Array(trackingMenus.values)
        trackingMenus.removeAll()
        for menu in menus { menu.cancelTrackingWithoutAnimation() }
    }

    private func startDismissMonitoring() {
        dismissObserver = NotificationCenter.default.addObserver(forName: .dismissNotch,
                                                                 object: nil, queue: .main) { [weak self] _ in
            self?.dismiss()
        }
        inactiveObserver = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification,
                                                                  object: nil, queue: .main) { [weak self] _ in
            self?.dismiss()
        }
        localEventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]) { [weak self] event in
            guard let self, self.isExpanded else { return event }
            if event.type == .keyDown {
                if event.keyCode == 53, event.window === self || NSApp.keyWindow === self {
                    self.dismiss()
                    return nil
                }
            } else if event.window !== self {
                self.dismissAfterOutsideClick(at: event.window?.convertPoint(toScreen: event.locationInWindow) ?? NSEvent.mouseLocation)
            }
            return event
        }
        // Mouse-only monitoring does not require keyboard/accessibility access.
        globalEventMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            self?.dismissAfterOutsideClick(at: NSEvent.mouseLocation)
        }
    }

    private func dismissAfterOutsideClick(at point: NSPoint) {
        guard isExpanded, !self.frame.contains(point) else { return }
        // Menu clicks belong to AppKit's tracking loop; let an active menu
        // finish selection/cancellation before the normal hover close resumes.
        if !trackingMenus.isEmpty, RunLoop.current.currentMode == .eventTracking { return }
        dismiss()
    }

    override func cancelOperation(_ sender: Any?) {
        dismiss()
    }

    override func sendEvent(_ event: NSEvent) {
        let input = event.type == .leftMouseDown || event.type == .rightMouseDown
            || event.type == .otherMouseDown || event.type == .keyDown
        let wasHandlingInput = handlingPanelInput
        if input { handlingPanelInput = true }
        defer { handlingPanelInput = wasHandlingInput }
        if event.type == .leftMouseDown && !isKeyWindow {
            makeKey()
        }
        super.sendEvent(event)
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

}

final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}

final class FirstMouseHostingController<Content: View>: NSHostingController<Content> {
    override func loadView() {
        let host = FirstMouseHostingView(rootView: rootView)
        host.sizingOptions = []
        self.view = host
    }
}

final class PanelContentView: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.98).cgColor
        layer?.cornerRadius = 10
        layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
    }

    required init?(coder: NSCoder) { nil }
}

final class ClockModel: ObservableObject {
    @Published var now = ""
    var formatter: DateFormatter?
    private var timer: Timer?

    func start() {
        timer?.invalidate()
        tick()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    private func tick() {
        now = formatter?.string(from: Date()) ?? ""
        objectWillChange.send()
    }
}
