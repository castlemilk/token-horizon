import Foundation

/// Bounds collectors requested by both the timer and filesystem callbacks.
/// A burst retains one follow-up, so the newest activity is never dropped.
final class HeavyRefreshCoordinator {
    private let lock = NSLock()
    private var running = false
    private var pending = false

    /// The caller that receives true owns starting the next collector.
    func request() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if running {
            pending = true
            return false
        }
        running = true
        return true
    }

    /// True transfers ownership directly to one pending follow-up. The gate
    /// stays occupied until that follow-up completes, avoiding a launch race.
    func finish() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard running else { return false }
        if pending {
            pending = false
            return true
        }
        running = false
        return false
    }
}
