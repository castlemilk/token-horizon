import Foundation

/// Bounded ring buffer of recent shell command events (posted by the zsh hook).
public final class EventStore {
    public static let shared = EventStore()
    private var events: [ShellEvent] = []
    private let lock = NSLock()

    public init() {}

    public func add(_ ev: ShellEvent) {
        lock.lock(); defer { lock.unlock() }
        events.insert(ev, at: 0)
        if events.count > 200 { events.removeLast(events.count - 200) }
    }

    public func recent(limit: Int) -> [ShellEvent] {
        lock.lock(); defer { lock.unlock() }
        return Array(events.prefix(limit))
    }

    public func latest() -> ShellEvent? {
        lock.lock(); defer { lock.unlock() }
        return events.first
    }
}
