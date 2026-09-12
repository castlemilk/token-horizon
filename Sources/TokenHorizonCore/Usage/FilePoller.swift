import Foundation

/// Routine file-location poller: turns provider log files into TOOL
/// ATTRIBUTION + LIMIT observations on the DB-backed timeline.
///
/// Files never create usage rows — usage is metered-only. Consolidators
/// emit FileAnnotations (joined onto metered rows by provider request id,
/// order-independent) and LimitSnapshots (e.g. codex rate-limit windows).
/// Polling is idempotent: (vendor, request_id) and per-minute limit keys
/// dedup, so each pass only applies what it hasn't seen.
///
/// Gating: requires `.fileReading` consent. Disabled without it.
/// Cadence: default every 60s on a utility queue; call `poll()` manually in
/// tests or for an immediate backfill.
public final class FilePoller {
    public static let shared = FilePoller()

    public var interval: TimeInterval = 60
    public var store: UsageStoring?
    private var timer: DispatchSourceTimer?
    private let lock = NSLock()
    private var _lastPoll: Date?
    private var _lastReport: [String: Int] = [:]

    public var lastPoll: Date? { lock.lock(); defer { lock.unlock() }; return _lastPoll }
    public var lastReport: [String: Int] { lock.lock(); defer { lock.unlock() }; return _lastReport }

    public init(store: UsageStoring? = nil) {
        self.store = store
    }

    /// File locations polled, for status/debugging (mirrors consolidators).
    /// Files contribute attribution + limits only — never usage rows.
    public var locations: [String] {
        let home = Platform.paths.homeDirectory.path
        var dirs = [
            "\(home)/.claude/projects",
            "\(home)/.codex/sessions",
            "\(home)/.local/share/opencode/opencode.db",
        ]
        if let kimiHome = ProcessInfo.processInfo.environment["KIMI_HOME"], !kimiHome.isEmpty {
            dirs.append("\(kimiHome)/sessions")
        }
        if let codeHome = ProcessInfo.processInfo.environment["KIMI_CODE_HOME"], !codeHome.isEmpty {
            dirs.append("\(codeHome)/sessions")
        } else {
            dirs.append("\(home)/.kimi-code/sessions")
        }
        return dirs
    }

    /// One poll pass: run every consolidator into the store. Returns per-vendor counts.
    @discardableResult
    public func poll(now: Date = Date()) -> [String: Int] {
        guard ConsentManager.shared.isGranted(.fileReading),
              let store else { return [:] }
        var report: [String: Int] = [:]
        for consolidator in ConsolidationRunner.consolidators {
            do {
                report[consolidator.vendor] = try consolidator.consolidate(into: store)
            } catch {
                report[consolidator.vendor] = 0
            }
        }
        lock.lock()
        _lastPoll = now
        _lastReport = report
        lock.unlock()
        return report
    }

    public func startPolling() {
        stopPolling()
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "tokenhorizon.filepoller", qos: .utility))
        timer.schedule(deadline: .now() + 5, repeating: interval)
        timer.setEventHandler { [weak self] in _ = self?.poll() }
        timer.resume()
        self.timer = timer
    }

    public func stopPolling() {
        timer?.cancel()
        timer = nil
    }
}
