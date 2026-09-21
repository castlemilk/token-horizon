import Foundation

/// Carousel pages for medium/large widgets. Small widgets stay on overview.
/// Page state is kept extension-local (UserDefaults) and advanced by the
/// chevron App Intents; `cycled` is the pure wrap math (unit-tested).
enum WidgetPage: Int, CaseIterable {
    case overview = 0
    case limits = 1
    case plans = 2

    static var count: Int { allCases.count }

    static func cycled(_ current: Int, delta: Int, count: Int = WidgetPage.count) -> Int {
        guard count > 0 else { return 0 }
        return ((current % count) + delta + count) % count
    }
}

/// Time windows for the usage bar chart. Display-only state: the widget keeps
/// its own choice in UserDefaults and the app preview keeps @State, so the two
/// never fight over the persisted settings file.
enum WidgetWindow: String, CaseIterable {
    case hours
    case days
    case weeks
    case months
    case years

    var label: String {
        switch self {
        case .hours: return "h"
        case .days: return "d"
        case .weeks: return "w"
        case .months: return "m"
        case .years: return "y"
        }
    }

    /// Tooltip for the app preview (widgets have no hover; `.help()` still
    /// documents the control for the shared WidgetCard in the Settings card).
    var helpText: String {
        switch self {
        case .hours: return "24 hourly bars"
        case .days: return "7 daily bars (last week)"
        case .weeks: return "17 weekly bars"
        case .months: return "30 daily bars (last month)"
        case .years: return "12 monthly bars (last year)"
        }
    }

    /// Caption under the chart: span + resolution, so the mixed ladder is
    /// never ambiguous.
    var caption: String {
        switch self {
        case .hours: return "LAST 24 HOURS · HOURLY"
        case .days: return "LAST 7 DAYS · DAILY"
        case .weeks: return "LAST 17 WEEKS · DAILY"
        case .months: return "LAST 30 DAYS · DAILY"
        case .years: return "LAST 12 MONTHS · MONTHLY"
        }
    }

    static func next(after raw: String) -> WidgetWindow {
        let current = WidgetWindow(rawValue: raw) ?? .days
        let index = allCases.firstIndex(of: current) ?? 1
        return allCases[(index + 1) % allCases.count]
    }
}

struct WidgetPreferences: Codable, Equatable {
    var enabled = true
    var period = "today"
    var accent = "cyan"
    var window = WidgetWindow.days.rawValue
    var page = 0
    var showCost = false
    var showLimits = true
    var showChart = true

    var normalized: WidgetPreferences {
        var value = self
        if !["today", "all"].contains(value.period) { value.period = "today" }
        if !["cyan", "violet", "green", "orange"].contains(value.accent) { value.accent = "cyan" }
        if WidgetWindow(rawValue: value.window) == nil { value.window = WidgetWindow.days.rawValue }
        value.page = min(max(0, value.page), WidgetPage.count - 1)
        return value
    }
}

struct WidgetSnapshot: Codable {
    static let kind = "TokenHorizonUsage"
    static let schemaVersion = 5
    static let heatmapWeeks = 17
    static let chartHours = 24
    static let chartDays = 30
    /// 1D shows a single week of daily bars (1M uses the full chartDays).
    static let weeklyDayBars = 7
    static let chartMonths = 12
    var version = schemaVersion
    var preferences = WidgetPreferences()
    var updatedAt: Date?
    var tokens = 0
    var requests = 0
    var cost: Double?
    /// Bar-chart series for the selectable time windows (per-provider stacks).
    var hourly: [DayTokens] = []
    var days: [DayTokens] = []
    var weeks: [DayTokens] = []
    var months: [DayTokens] = []
    var heatmap: [Int] = []
    var limits: [Limit] = []

    /// One day of tokens, split per provider for stacked chart bars.
    /// Providers beyond the top 5 are merged into "other" (bounded payload).
    struct DayTokens: Codable {
        var tokens: Int
        var byProvider: [String: Int]
    }

    struct Limit: Codable, Identifiable {
        var id: String { provider + ":" + label }
        var provider: String
        var label: String
        var usedPercent: Double
        var resetsAt: Date?
        var detail: String

        init(provider: String, label: String, usedPercent: Double,
             resetsAt: Date? = nil, detail: String = "") {
            self.provider = provider
            self.label = label
            self.usedPercent = usedPercent
            self.resetsAt = resetsAt
            self.detail = detail
        }

        /// Urgency mirrors the notch app / `/limits` route thresholds.
        var secondsUntilReset: TimeInterval? {
            guard let resetsAt else { return nil }
            return resetsAt.timeIntervalSinceNow
        }

        func urgency(at now: Date = Date()) -> String {
            guard let seconds = resetsAt?.timeIntervalSince(now), seconds > 0 else { return "normal" }
            if seconds < 86_400 { return "urgent" }
            if seconds < 172_800 { return "soon" }
            return "normal"
        }
    }

    func isStale(at date: Date) -> Bool {
        guard let updatedAt else { return true }
        return date.timeIntervalSince(updatedAt) > 900
    }

    static func number(_ value: Int) -> String {
        switch value {
        case 1_000_000_000...: return String(format: "%.1fB", Double(value) / 1_000_000_000)
        case 1_000_000...: return String(format: "%.1fM", Double(value) / 1_000_000)
        case 1_000...: return String(format: "%.1fK", Double(value) / 1_000)
        default: return String(value)
        }
    }

    /// Compact countdown for the plans page ("45m", "5h 20m", "2d 4h").
    /// Pure and unit-tested; mirrors the notch app's short reset labels.
    static func resetText(_ date: Date, now: Date = Date()) -> String {
        let seconds = date.timeIntervalSince(now)
        guard seconds > 0 else { return "now" }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(max(1, minutes))m" }
        let hours = minutes / 60
        if hours < 48 { return "\(hours)h \(minutes % 60)m" }
        let days = hours / 24
        return "\(days)d \(hours % 24)h"
    }

    /// Chart + carousel state is app-owned (WidgetPreferences) and changed from
    /// the widget via `tokenhorizon://` deep links — in-widget App Intents are
    /// not reliably delivered for ad-hoc-signed extensions, so links (which
    /// always work) are the interaction mechanism. Pure parsing helpers live
    /// here so the app URL handler and tests share them.
    static func windowValue(from raw: String) -> String? {
        WidgetWindow(rawValue: raw)?.rawValue
    }

    /// "next" / "prev" / "0..2" -> target page index (nil when unparseable).
    static func pageValue(from raw: String, current: Int) -> Int? {
        switch raw {
        case "next": return WidgetPage.cycled(current, delta: 1)
        case "prev": return WidgetPage.cycled(current, delta: -1)
        default:
            guard let index = Int(raw), (0..<WidgetPage.count).contains(index) else { return nil }
            return index
        }
    }

    /// Series backing the selected chart window (pure; unit-tested).
    static func points(for window: String, in snapshot: WidgetSnapshot) -> [DayTokens] {
        switch WidgetWindow(rawValue: window) ?? .days {
        case .hours: return snapshot.hourly
        case .days: return Array(snapshot.days.suffix(weeklyDayBars))
        case .weeks: return snapshot.weeks
        case .months: return snapshot.days
        case .years: return snapshot.months
        }
    }

    /// Group flat values into fixed-size chunks (columns of a heatmap).
    static func chunked(_ values: [Int], size: Int) -> [[Int]] {
        guard size > 0 else { return [] }
        return stride(from: 0, to: values.count, by: size).map {
            Array(values[$0..<min($0 + size, values.count)])
        }
    }

/// Heatmap grid for the selected window — same span as the chart, at the
    /// window's resolution. Grid shapes are chosen to *fill* the heatmap area
    /// (no thin strips, no stretched mega-cells, no mostly-empty grids):
    /// 1H 24 hourly cells 12x2, 1D 7 daily cells 7x1, 1W `weeks` daily cells
    /// Nx7, 1M 30 daily cells 6x5 (large) / 10x3 (medium),
    /// 1Y 12 monthly cells 4x3 (large) / 6x2 (medium).
    static func heatmapColumns(for window: String, in snapshot: WidgetSnapshot,
                               weeks: Int, large: Bool) -> [[Int]] {
        switch WidgetWindow(rawValue: window) ?? .days {
        case .hours:
            return chunked(snapshot.hourly.map { $0.tokens }, size: 2)
        case .days:
            return chunked(Array(snapshot.heatmap.suffix(weeklyDayBars)), size: 1)
        case .weeks:
            return chunked(Array(snapshot.heatmap.suffix(max(1, weeks) * 7)), size: 7)
        case .months:
            return chunked(Array(snapshot.heatmap.suffix(chartDays)), size: large ? 5 : 3)
        case .years:
            return chunked(snapshot.months.map { $0.tokens }, size: large ? 3 : 2)
        }
    }

    /// Per-provider totals across the day stacks (the legend + small bar).
    /// Sorted descending, ties by name; beyond `limit` re-merges into "other"
    /// so the legend stays bounded and always sums to the window total.
    static func aggregateByProvider(days: [DayTokens], limit: Int) -> [(provider: String, tokens: Int)] {
        var totals: [String: Int] = [:]
        for day in days {
            for (provider, tokens) in day.byProvider where tokens > 0 {
                totals[provider, default: 0] += tokens
            }
        }
        let sorted = totals.sorted {
            if $0.value == $1.value { return $0.key < $1.key }
            return $0.value > $1.value
        }
        guard limit > 0, sorted.count > limit else {
            return sorted.map { (provider: $0.key, tokens: $0.value) }
        }
        var result = sorted.prefix(limit).map { (provider: $0.key, tokens: $0.value) }
        result.append((provider: "other", tokens: sorted.dropFirst(limit).reduce(0) { $0 + $1.value }))
        return result
    }

    static var preview: WidgetSnapshot {
        let providers = ["claude", "codex", "opencode", "glm", "kimi"]
        func stacks(_ count: Int, scale: Double) -> [DayTokens] {
            (0..<count).map { index in
                var byProvider: [String: Int] = [:]
                var total = 0
                for (slot, provider) in providers.enumerated() {
                    let value = Int(scale * Double((index * 7 + slot * 13) % 40 + 1) * 1_500)
                    byProvider[provider] = value
                    total += value
                }
                return DayTokens(tokens: total, byProvider: byProvider)
            }
        }
return WidgetSnapshot(updatedAt: Date(), tokens: 248_600, requests: 142,
                              hourly: stacks(WidgetSnapshot.chartHours, scale: 0.2),
                              days: stacks(WidgetSnapshot.chartDays, scale: 1),
                              weeks: stacks(WidgetSnapshot.heatmapWeeks, scale: 5),
                              months: stacks(WidgetSnapshot.chartMonths, scale: 20),
                              heatmap: (0..<heatmapWeeks * 7).map { day in (day * 37 % 9) * 12_000 },
                              limits: [Limit(provider: "claude", label: "weekly", usedPercent: 64,
                                             resetsAt: Date().addingTimeInterval(86_400 * 2 + 4 * 3600),
                                             detail: "5h window ok")])
    }
}
