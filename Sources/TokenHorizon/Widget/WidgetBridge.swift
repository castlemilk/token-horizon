import Foundation
import WidgetKit

final class WidgetBridge {
    static let shared = WidgetBridge()
    private let lock = NSLock()
    private var snapshot = WidgetSnapshot()
    private var encoded = Data("{}".utf8)
    private var lastReload = Date.distantPast

    /// Publishing is on the widget-tap critical path (preference change ->
    /// snapshot -> reload), so it encodes once and — importantly — only asks
    /// WidgetKit to reload when the bytes actually changed. Redundant reloads
    /// burn the system's per-widget reload budget, which is what makes later
    /// updates feel slow.
    func publish(usage: UsageSnapshot, history: [HistoryPoint], hourly: [HistoryPoint] = [],
                 limits: [ProviderLimit], force: Bool = false) {
        let next = Self.makeSnapshot(usage: usage, history: history, hourly: hourly, limits: limits,
                                     preferences: SettingsStore.shared.widgetPreferences)
        let data = (try? JSONEncoder().encode(next)) ?? Data("{}".utf8)
        lock.lock()
        let changed = data != encoded
        snapshot = next
        encoded = data
        let reload = Self.shouldReload(force: force, changed: changed, lastReload: lastReload)
        if reload { lastReload = Date() }
        lock.unlock()
        if reload { WidgetCenter.shared.reloadTimelines(ofKind: WidgetSnapshot.kind) }
    }

    /// Reload policy (pure, unit-tested): taps always repaint; the periodic
    /// path only spends a reload when the payload actually changed, so the
    /// system's per-widget reload budget is not burned on no-op ticks.
    static func shouldReload(force: Bool, changed: Bool, lastReload: Date,
                             now: Date = Date(), interval: TimeInterval = 300) -> Bool {
        if force { return true }
        return changed && now.timeIntervalSince(lastReload) >= interval
    }

    /// Serves the pre-encoded snapshot — `/widget` is a memcpy, never an encode.
    func data() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return encoded
    }

    /// Merge history into arbitrary ordered, non-overlapping [start, end) buckets.
    /// Single-pass merge walk (points sorted once, bucket cursor advances
    /// monotonically) instead of one full scan per bucket — this runs in the
    /// widget-tap critical path, and the old shape was O(buckets x history)
    /// with an array allocation per bucket. Pure static: unit-tested.
    static func bucketPoints(_ history: [HistoryPoint], in buckets: [(Date, Date)]) -> [HistoryPoint] {
        guard !buckets.isEmpty else { return [] }
        var result = buckets.map {
            HistoryPoint(day: Int($0.0.timeIntervalSince1970), tokens: 0, cost: 0, byTool: [:])
        }
        let starts = buckets.map { $0.0.timeIntervalSince1970 }
        let ends = buckets.map { $0.1.timeIntervalSince1970 }
        var bucket = 0
        for point in history.sorted(by: { $0.day < $1.day }) {
            let day = Double(point.day)
            while bucket < buckets.count && day >= ends[bucket] { bucket += 1 }
            guard bucket < buckets.count else { break }
            guard day >= starts[bucket] else { continue }
            result[bucket].tokens += max(0, point.tokens)
            result[bucket].cost += max(0, point.cost)
            for (tool, value) in point.byTool where value > 0 {
                result[bucket].byTool[tool, default: 0] += value
            }
        }
        return result
    }

    /// Provider stacks per bucket, capping to the window's top-5 providers and
    /// merging the tail into "other" (bounded payload + bounded bar segments).
    static func cappedStacks(_ points: [HistoryPoint], limit: Int = 5) -> [WidgetSnapshot.DayTokens] {
        var totals: [String: Int] = [:]
        for point in points {
            for (tool, tokens) in point.byTool where tokens > 0 {
                totals[tool, default: 0] += tokens
            }
        }
        let top = Set(totals.sorted {
            if $0.value == $1.value { return $0.key < $1.key }
            return $0.value > $1.value
        }.prefix(limit).map(\.key))
        return points.map { point in
            var byProvider: [String: Int] = [:]
            for (tool, tokens) in point.byTool where tokens > 0 {
                byProvider[top.contains(tool) ? tool : "other", default: 0] += tokens
            }
            return WidgetSnapshot.DayTokens(tokens: max(0, point.tokens), byProvider: byProvider)
        }
    }

    static func makeSnapshot(usage: UsageSnapshot, history: [HistoryPoint], hourly: [HistoryPoint] = [],
                             limits: [ProviderLimit], preferences: WidgetPreferences, now: Date = Date(),
                             calendar: Calendar = .current) -> WidgetSnapshot {
        let preferences = preferences.normalized
        var result = WidgetSnapshot(preferences: preferences)
        guard preferences.enabled else { return result }
        result.updatedAt = usage.updatedAt == .distantPast ? nil : usage.updatedAt
        let today = preferences.period == "today"
        result.tokens = max(0, today ? usage.tokensToday : usage.tokensAllTime)
        result.requests = max(0, today ? usage.requestsToday : usage.requestsAllTime)
        let cost = today ? usage.costToday : usage.costAllTime
        result.cost = preferences.showCost && cost.isFinite ? max(0, cost) : nil
        if preferences.showChart {
            let start = calendar.startOfDay(for: now)
            // Hour buckets align to the wall clock so the 24H chart shows the
            // current hour on the right even when the input is empty.
            let hourStart = Int(now.timeIntervalSince1970 / 3600) * 3600
            let hourBuckets: [(Date, Date)] = (0..<WidgetSnapshot.chartHours).compactMap { offset in
                let begin = Date(timeIntervalSince1970: Double(hourStart - (WidgetSnapshot.chartHours - 1 - offset) * 3600))
                return (begin, begin.addingTimeInterval(3600))
            }
            let dayBuckets: [(Date, Date)] = (0..<WidgetSnapshot.chartDays).compactMap { offset in
                guard let day = calendar.date(byAdding: .day, value: -(WidgetSnapshot.chartDays - 1 - offset), to: start),
                      let end = calendar.date(byAdding: .day, value: 1, to: day) else { return nil }
                return (day, end)
            }
            // Trailing weeks ending today (last bucket covers the last 7 days).
            let weekBuckets: [(Date, Date)] = (0..<WidgetSnapshot.heatmapWeeks).compactMap { offset in
                let back = (WidgetSnapshot.heatmapWeeks - 1 - offset) * 7
                guard let begin = calendar.date(byAdding: .day, value: -back - 6, to: start),
                      let end = calendar.date(byAdding: .day, value: -back + 1, to: start) else { return nil }
                return (begin, end)
            }
            // Trailing calendar months ending this month (1Y chart).
            let monthAnchor = calendar.date(from: calendar.dateComponents([.year, .month], from: now)) ?? start
            let monthBuckets: [(Date, Date)] = (0..<WidgetSnapshot.chartMonths).compactMap { offset in
                guard let begin = calendar.date(byAdding: .month, value: -(WidgetSnapshot.chartMonths - 1 - offset), to: monthAnchor),
                      let end = calendar.date(byAdding: .month, value: 1, to: begin) else { return nil }
                return (begin, end)
            }
            result.hourly = Self.cappedStacks(Self.bucketPoints(hourly, in: hourBuckets))
            result.days = Self.cappedStacks(Self.bucketPoints(history, in: dayBuckets))
            result.weeks = Self.cappedStacks(Self.bucketPoints(history, in: weekBuckets))
            result.months = Self.cappedStacks(Self.bucketPoints(history, in: monthBuckets))
            // GitHub-style intensity grid: trailing 17 weeks of daily totals,
            // oldest-first. One pass builds the day->tokens map; each cell is
            // then a dictionary lookup (the old per-cell history.filter was
            // O(cells x history) with an array allocation per cell).
            var tokensByDay: [Int: Int] = [:]
            for point in history where point.tokens > 0 {
                tokensByDay[point.day, default: 0] += max(0, point.tokens)
            }
            let heatmapDays = WidgetSnapshot.heatmapWeeks * 7
            result.heatmap = (0..<heatmapDays).map { index in
                guard let day = calendar.date(byAdding: .day, value: index - (heatmapDays - 1), to: start) else { return 0 }
                return tokensByDay[Int(day.timeIntervalSince1970)] ?? 0
            }
        }
        if preferences.showLimits {
            var seen = Set<String>()
            // Expiry-first ordering, like the notch app's plan rows: soonest
            // reset wins, missing resets last, then highest usage.
            result.limits = limits.filter {
                $0.usedPercent.isFinite && seen.insert($0.id).inserted
            }.sorted {
                let lhs = $0.resetsAt ?? .distantFuture
                let rhs = $1.resetsAt ?? .distantFuture
                if lhs == rhs {
                    if $0.usedPercent == $1.usedPercent { return $0.id < $1.id }
                    return $0.usedPercent > $1.usedPercent
                }
                return lhs < rhs
            }.prefix(6).map {
                WidgetSnapshot.Limit(provider: $0.provider, label: $0.label,
                                     usedPercent: min(100, max(0, $0.usedPercent)),
                                     resetsAt: $0.resetsAt, detail: $0.detail)
            }
        }
        return result
    }
}
