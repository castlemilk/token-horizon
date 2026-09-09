import AppKit
import TokenHorizonCore
import SwiftUI

final class NotchPanel: NSPanel {
    private let notchScreen: NSScreen?
    private let model: UIModel
    private var isExpanded = false
    private var hoverTimer: Timer?
    private var insideSince: Date?
    private var outsideSince: Date?

    struct Geometry {
        let notchWidth: CGFloat
        let wing: CGFloat
        let centerX: CGFloat
        let collapsed: NSSize
        let expanded: NSSize
        let topInset: CGFloat

        static func forScreen(_ screen: NSScreen?) -> Geometry {
            let top = screen?.safeAreaInsets.top ?? 0
            let topInset = max(top, 24)
            var notchWidth: CGFloat = 0
            var centerX = screen?.frame.midX ?? 0
            if top > 0, let s = screen {
                let left = s.auxiliaryTopLeftArea?.maxX ?? 0
                let right = s.auxiliaryTopRightArea?.minX ?? 0
                if right > left {
                    notchWidth = right - left
                    centerX = (left + right) / 2
                }
            }
            let wing: CGFloat = notchWidth > 0 ? 32 : 60
            let collapsedW = notchWidth + wing * 2
            return Geometry(
                notchWidth: notchWidth,
                wing: wing,
                centerX: centerX,
                collapsed: NSSize(width: collapsedW, height: topInset),
                expanded: NSSize(width: max(740, collapsedW + 360), height: topInset + 560),
                topInset: topInset)
        }
    }

    init(model: UIModel) {
        self.model = model
        notchScreen = NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main
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

        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.relayout(expanded: false)
        }
    }

    private func frame(expanded: Bool) -> NSRect? {
        guard let screen = notchScreen ?? NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main else { return nil }
        let geo = Geometry.forScreen(screen)
        let size = expanded ? geo.expanded : geo.collapsed
        return NSRect(x: geo.centerX - size.width / 2,
                      y: screen.frame.maxY - size.height,
                      width: size.width,
                      height: size.height)
    }

    func relayout(expanded: Bool) {
        if let f = frame(expanded: expanded) { setFrame(f, display: true) }
    }

    private func setExpanded(_ flag: Bool) {
        guard isExpanded != flag, let target = frame(expanded: flag) else { return }
        isExpanded = flag
        model.notchExpanded = flag
        NotificationCenter.default.post(name: NSNotification.Name("TokenHorizonProcessMonitoringDidChange"), object: flag)
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
        let mouse = NSEvent.mouseLocation
        guard let current = frame(expanded: isExpanded) else { return }
        let testFrame = isExpanded ? current.insetBy(dx: -8, dy: -8) : current
        let inside = testFrame.contains(mouse)
        let now = Date()

        if inside {
            outsideSince = nil
            if !isExpanded {
                let since = insideSince ?? now
                insideSince = since
                if now.timeIntervalSince(since) > 0.12 { setExpanded(true) }
            }
        } else {
            insideSince = nil
            if isExpanded {
                let since = outsideSince ?? now
                outsideSince = since
                if now.timeIntervalSince(since) > 0.4 { setExpanded(false) }
            }
        }
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown && !isKeyWindow {
            makeKey()
        }
        super.sendEvent(event)
    }
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
