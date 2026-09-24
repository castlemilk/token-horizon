import Foundation

/// Injectable time source.
///
/// Go analogue: an injected `now func() time.Time` field instead of calling
/// `time.Now()` (here: `Date()`) deep in testable logic. Production code uses
/// `SystemClock`; tests use `ManualClock`, which is fully deterministic.
///
/// Named `THClock` (not `Clock`) to avoid colliding with Swift's own
/// `Clock` protocol (`ContinuousClock` is used by `ModelsPipeline`).
protocol THClock {
    func now() -> Date
}

/// Live clock. One line, no state.
struct SystemClock: THClock {
    func now() -> Date { Date() }
}

/// Deterministic test clock. Starts at `start`, moves only via
/// `advance(by:)` / `set(_:)` — the equivalent of Go's `fakeClock`.
final class ManualClock: THClock {
    private var current: Date
    private let lock = NSLock()

    init(_ start: Date = Date(timeIntervalSince1970: 0)) {
        current = start
    }

    func now() -> Date {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    func advance(by interval: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        current = current.addingTimeInterval(interval)
    }

    func set(_ date: Date) {
        lock.lock(); defer { lock.unlock() }
        current = date
    }
}
