import Foundation

/// Timing and menu ownership for the polled notch driver. Time is monotonic
/// uptime supplied by the host, so clock adjustments cannot strand a dwell.
struct NotchInteractionPolicy {
    static let openDelay: TimeInterval = 0.12
    static let closeDelay: TimeInterval = 0.4
    static let menuRecoveryDelay: TimeInterval = 0.18

    private(set) var isExpanded = false
    private(set) var menuIDs: Set<ObjectIdentifier> = []
    private(set) var requiresPointerExit = false
    private var insideSince: TimeInterval?
    private var outsideSince: TimeInterval?
    private var menusIdleSince: TimeInterval?

    mutating func reset(expanded: Bool = false) {
        self = NotchInteractionPolicy()
        isExpanded = expanded
    }

    mutating func setExpanded(_ expanded: Bool) {
        isExpanded = expanded
        insideSince = nil
        outsideSince = nil
        if expanded {
            requiresPointerExit = false
        } else {
            menuIDs.removeAll()
            menusIdleSince = nil
        }
    }

    /// Explicit dismissal must not immediately reopen under a stationary mouse.
    mutating func dismiss() {
        setExpanded(false)
        requiresPointerExit = true
    }

    @discardableResult
    mutating func beginMenu(_ id: ObjectIdentifier, initiatedByPanel: Bool) -> Bool {
        guard isExpanded, initiatedByPanel else { return false }
        menuIDs.insert(id)
        insideSince = nil
        outsideSince = nil
        menusIdleSince = nil
        return true
    }

    mutating func endMenu(_ id: ObjectIdentifier) {
        guard menuIDs.remove(id) != nil else { return }
        outsideSince = nil
        menusIdleSince = nil
    }

    /// A live menu can stay open indefinitely. A missed end notification is
    /// recovered only after consecutive polls outside AppKit's tracking loop.
    /// Returning a transition leaves the actual frame/model mutation to AppKit.
    mutating func poll(pointerInside: Bool, eventTracking: Bool, now: TimeInterval) -> Bool? {
        if !menuIDs.isEmpty {
            if eventTracking {
                menusIdleSince = nil
                insideSince = nil
                outsideSince = nil
                return nil
            }
            let since = menusIdleSince ?? now
            menusIdleSince = since
            guard now - since >= Self.menuRecoveryDelay else { return nil }
            menuIDs.removeAll()
            menusIdleSince = nil
            outsideSince = nil
        }

        if requiresPointerExit {
            if !pointerInside {
                requiresPointerExit = false
                insideSince = nil
            }
            return nil
        }

        if pointerInside {
            outsideSince = nil
            guard !isExpanded else { return nil }
            let since = insideSince ?? now
            insideSince = since
            return now - since >= Self.openDelay ? true : nil
        }
        insideSince = nil
        guard isExpanded else { return nil }
        let since = outsideSince ?? now
        outsideSince = since
        return now - since >= Self.closeDelay ? false : nil
    }
}
