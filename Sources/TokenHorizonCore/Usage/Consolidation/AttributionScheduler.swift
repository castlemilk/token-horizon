import Foundation

/// Reactive attribution: when a LIVE metered/MITM request lands without
/// wire-inferable attribution (no product label from explicit port config or
/// User-Agent sniffing), schedule a consolidation pass to recover the missing
/// metadata from tool session files.
///
/// Why deferred retries instead of a per-request file probe:
/// - the tool's session record (pi's `responseId`, claude's `requestId`) is
///   written AFTER the response completes, by an amount we cannot bound —
///   a probe at request time would race the tool's own write and miss;
/// - parallel requests collapse into ONE tail-read pass: annotations are
///   keyed by provider request id and LEFT JOINed at read time, so a single
///   consolidation pass resolves every pending request at once, and nothing
///   per-request is ever written back;
/// - arrival order cannot matter (invariant #14): the join is at query
///   time, so whenever the annotation lands, history is retroactively healed.
///
/// Policy: first pass ~5s after the first unattributed request, then
/// 30s / 2m / 10m backoff while probes remain unresolved. Probes expire
/// after `ttl` (tools that never record a provider request id — e.g. kimi
/// wire.jsonl — are quietly dropped). Gated on `.fileReading` consent;
/// without it the queue drains and a later grant + new traffic re-arms.
public final class AttributionScheduler {
    public static let shared = AttributionScheduler()

    /// Store used to prune resolved probes. Wired alongside
    /// `FilePoller.shared.store` in CoreAPIRouter.
    public var store: UsageStoring?

    /// Backoff ladder (seconds) between consolidation passes while probes
    /// stay unresolved; the last rung repeats until TTL.
    public var backoffs: [TimeInterval] = [5, 30, 120, 600]

    /// How long an unresolved probe is retried before being dropped.
    public var ttl: TimeInterval = 3600

    // MARK: - Seams (tests)

    public var pollHandler: () -> [String: Int] = { FilePoller.shared.poll() }
    public var consentGranted: () -> Bool = { ConsentManager.shared.isGranted(.fileReading) }
    public var now: () -> Date = { Date() }

    private struct Probe {
        /// Both provider ids the meter captured (header id + body id); an
        /// annotation matching EITHER resolves the probe.
        let ids: [String]
        let firstSeen: Date
    }

    private let lock = NSLock()
    private var pending: [String: Probe] = [:]
    private var stage = 0
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "tokenhorizon.attribution", qos: .utility)

    public init() {}

    /// Pending probe count (status/debug).
    public var pendingCount: Int { lock.lock(); defer { lock.unlock() }; return pending.count }

    /// Observe freshly stored LIVE events (meter emit path, MITM
    /// /analytics/events). Only events lacking a product label but carrying
    /// a provider request id are actionable — everything else is either
    /// already attributed or unresolvable from files. In-memory only; never
    /// blocks the caller.
    public func note(events: [UsageEvent]) {
        lock.lock()
        defer { lock.unlock() }
        var fresh = false
        for e in events where e.product == nil {
            let ids = [e.requestID, e.requestIDAlt].compactMap { $0 }.filter { !$0.isEmpty }
            guard let key = ids.first, pending[key] == nil else { continue }
            pending[key] = Probe(ids: ids, firstSeen: now())
            fresh = true
        }
        // New traffic re-arms the ladder from the top so attribution stays
        // snappy even while older probes sit on a slow rung.
        if fresh {
            stage = 0
            scheduleLocked()
        }
    }

    /// One consolidation pass + probe pruning. Internal (not private) for
    /// deterministic tests; production callers go through the timer.
    func runPass() {
        lock.lock()
        timer?.cancel()
        timer = nil
        let probes = Array(pending.values)
        lock.unlock()

        guard !probes.isEmpty else { return }

        // Consent gate: the poller would no-op anyway; drain instead of
        // spinning retries until a grant + new traffic re-arms us.
        guard consentGranted(), let store else {
            lock.lock()
            pending.removeAll()
            stage = 0
            lock.unlock()
            return
        }

        _ = pollHandler()

        let allIDs = probes.flatMap { $0.ids }
        let resolved = (try? store.annotatedRequestIDs(among: allIDs)) ?? []
        let cutoff = now().addingTimeInterval(-ttl)
        lock.lock()
        for probe in probes {
            let hit = probe.ids.contains { resolved.contains($0) }
            if hit || probe.firstSeen < cutoff, let key = probe.ids.first {
                pending.removeValue(forKey: key)
            }
        }
        if pending.isEmpty {
            stage = 0
        } else {
            stage += 1
            scheduleLocked()
        }
        lock.unlock()
    }

    /// Cancel any scheduled pass and drain the queue (tests, shutdown).
    public func reset() {
        lock.lock()
        timer?.cancel()
        timer = nil
        pending.removeAll()
        stage = 0
        lock.unlock()
    }

    private func scheduleLocked() {
        guard timer == nil, !pending.isEmpty, !backoffs.isEmpty else { return }
        let delay = backoffs[min(stage, backoffs.count - 1)]
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + delay)
        t.setEventHandler { [weak self] in self?.runPass() }
        t.resume()
        timer = t
    }
}
