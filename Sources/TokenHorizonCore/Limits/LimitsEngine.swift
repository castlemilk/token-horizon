import Foundation

/// Base class for provider limit engines (PlanLimitsEngine, KimiLimitsEngine).
///
/// Swift inheritance note: class-only, single inheritance. Subclasses override
/// `fetchLimits()` (the Template Method hook); the base class provides the
/// shared bounded cache, refresh throttling, and update notification.
/// Value-type seams (SystemStatsProviding, CredentialStore) stay protocols —
/// Swift structs/enums cannot inherit.
public class LimitsEngine {
    /// Posted on the main queue after every refresh, with the new limits as object.
    public let updatedNotification: Notification.Name

    private let lock = NSLock()
    private var cache: [ProviderLimit] = []
    private var lastFetch = Date.distantPast

    public init(updatedNotification: Notification.Name) {
        self.updatedNotification = updatedNotification
    }

    public func cachedLimits() -> [ProviderLimit] {
        lock.lock(); defer { lock.unlock() }
        return cache
    }

    /// Template Method hook — subclasses return fresh limits (may block; called
    /// off the main queue).
    public func fetchLimits() -> [ProviderLimit] {
        fatalError("LimitsEngine subclass must override fetchLimits()")
    }

    public func refreshNow() {
        lock.lock()
        lastFetch = .distantPast
        lock.unlock()
        refreshIfDue(maxAge: .infinity)
    }

    public func refreshIfDue(maxAge: TimeInterval = 60) {
        lock.lock()
        if Date().timeIntervalSince(lastFetch) < maxAge {
            lock.unlock()
            return
        }
        lastFetch = Date()
        lock.unlock()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let limits = self.fetchLimits()
            self.lock.lock()
            self.cache = limits
            self.lock.unlock()
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: self.updatedNotification, object: limits)
            }
        }
    }
}
