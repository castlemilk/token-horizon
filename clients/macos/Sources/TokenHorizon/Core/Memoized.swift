import Foundation

/// Single-flight, last-value read memo for fan-out providers (the :8889
/// HTTP seam). The failure mode this prevents, observed live: a background
/// engine scan held the engine lock for ~30s while each HTTP request and
/// tick queued its OWN collect behind it — ~90 blocked dispatch threads,
/// soft-limit exhaustion, and a fully hung API. With this seam, one caller
/// recomputes; every other caller receives the last value immediately.
///
/// Staleness is bounded by the refresh cadence of the underlying producers
/// (the heavy tick recomputes leaderboard data every 2s), so a last value
/// served mid-recompute is at most a couple of seconds old.
final class MemoizedValue<T> {
    private let lock = NSLock()
    private let ttl: TimeInterval
    private var value: T?
    private var computedAt = -Double.infinity
    private var computing = false
    private let compute: () -> T

    /// - Parameters:
    ///   - ttl: how long a completed value satisfies calls without recompute.
    ///   - compute: the expensive producer. Runs OFF the memo lock, at most
    ///     once concurrently.
    init(ttl: TimeInterval, compute: @escaping () -> T) {
        self.ttl = ttl
        self.compute = compute
    }

    /// Fresh within `ttl` → cached value. A recompute in flight → last
    /// value (nil before the first completion). Otherwise computes once;
    /// callers that arrived during that compute receive its result too —
    /// they block on it by design, but they cannot START a second one.
    func get() -> T? {
        lock.lock()
        if let value, Date().timeIntervalSince1970 - computedAt < ttl {
            lock.unlock()
            return value
        }
        if computing {
            // Only the first caller of a burst waits; latecomers get the
            // last good value so the server queue can never pile up here.
            let last = value
            lock.unlock()
            return last
        }
        computing = true
        lock.unlock()

        let fresh = compute()

        lock.lock()
        value = fresh
        computedAt = Date().timeIntervalSince1970
        computing = false
        lock.unlock()
        return fresh
    }
}

/// Keyed variant for providers parameterized by request input (history
/// days, trend window, heatmap days). Same single-flight and last-value
/// guarantees per key; bounded entry count with oldest-first eviction.
final class KeyedMemo<K: Hashable, T> {
    private struct Entry {
        var value: T
        var computedAt: TimeInterval
    }

    private let lock = NSLock()
    private let ttl: TimeInterval
    private var entries: [K: Entry] = [:]
    private var inFlight: Set<K> = []
    private let compute: (K) -> T

    init(ttl: TimeInterval, compute: @escaping (K) -> T) {
        self.ttl = ttl
        self.compute = compute
    }

    func get(_ key: K) -> T? {
        lock.lock()
        if let entry = entries[key], Date().timeIntervalSince1970 - entry.computedAt < ttl {
            lock.unlock()
            return entry.value
        }
        if inFlight.contains(key) {
            let last = entries[key]?.value
            lock.unlock()
            return last
        }
        inFlight.insert(key)
        lock.unlock()

        let fresh = compute(key)

        lock.lock()
        entries[key] = Entry(value: fresh, computedAt: Date().timeIntervalSince1970)
        inFlight.remove(key)
        if entries.count > 16 {
            let cutoff = Date().timeIntervalSince1970 - 60
            for (k, e) in entries where e.computedAt < cutoff {
                entries.removeValue(forKey: k)
            }
        }
        lock.unlock()
        return fresh
    }
}
