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

    /// When set, every refresh appends quota/reset snapshots for timeline analytics.
    public var snapshotStore: UsageStoring?

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
        refreshIfDue()
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
            let store = self.snapshotStore
            self.lock.unlock()
            if let store {
                let snaps = limits.map { LimitSnapshot(from: $0, machineID: MachineIdentity.current) }
                try? store.recordLimits(snaps)
            }
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: self.updatedNotification, object: limits)
            }
        }
    }
}

// MARK: - Shared quota coercion (single source of truth)

// VendorLimitsAdapter instance helpers and KimiLimitsEngine statics both
// delegate here so per-vendor parsing never drifts.
public enum QuotaParsers {
    public static func number(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue }
        if let s = v as? String {
            if let direct = Double(s) { return direct }
            return flexibleNumber(s)
        }
        return nil
    }

    public static func quota(_ dict: [String: Any], _ key: String) -> Double? {
        number(dict[key])
    }

    public static func flexibleNumber(_ s: String) -> Double? {
        let trimmed = s.trimmingCharacters(in: .whitespaces).uppercased()
        var numPart = ""
        var multiplier = 1.0
        for ch in trimmed {
            if ch.isNumber || ch == "." { numPart.append(ch) }
            else if ch == "K" { multiplier = 1_000 }
            else if ch == "M" { multiplier = 1_000_000 }
            else if ch == "B" { multiplier = 1_000_000_000 }
            else if !numPart.isEmpty { break }
        }
        guard let v = Double(numPart) else { return nil }
        return v * multiplier
    }

    public static func parseISO(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    public static func epoch(_ v: Any?) -> Date? {
        guard let n = v as? NSNumber else { return nil }
        let t = n.doubleValue
        return Date(timeIntervalSince1970: t > 1e12 ? t / 1000 : t)
    }

    public static func compact(_ v: Double) -> String {
        switch v {
        case 1_000_000_000...: return String(format: "%.1fB", v / 1_000_000_000)
        case 1_000_000...: return String(format: "%.1fM", v / 1_000_000)
        case 1_000...: return String(format: "%.1fk", v / 1_000)
        default: return String(format: "%.0f", v)
        }
    }
}
