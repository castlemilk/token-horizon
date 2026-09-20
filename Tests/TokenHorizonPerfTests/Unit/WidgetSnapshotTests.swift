import XCTest
@testable import TokenHorizon

final class WidgetSnapshotTests: XCTestCase {
    private static var dayZero: Int {
        Int(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970)
    }

    func testSnapshotRoundTripAndPrivacy() throws {
        var usage = UsageSnapshot()
        usage.tokensToday = 1234
        usage.tokensAllTime = 5678
        usage.costToday = 9.5
        usage.updatedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let snapshot = WidgetBridge.makeSnapshot(usage: usage, history: [], limits: [], preferences: WidgetPreferences())
        let data = try JSONEncoder().encode(snapshot)
        let decoded = try JSONDecoder().decode(WidgetSnapshot.self, from: data)
        XCTAssertEqual(decoded.version, 5)
        XCTAssertEqual(decoded.tokens, 1234)
        XCTAssertEqual(decoded.updatedAt, usage.updatedAt)
        XCTAssertNil(decoded.cost)
        XCTAssertEqual(decoded.hourly.count, WidgetSnapshot.chartHours)
        XCTAssertEqual(decoded.days.count, WidgetSnapshot.chartDays)
        XCTAssertEqual(decoded.weeks.count, WidgetSnapshot.heatmapWeeks)
        XCTAssertEqual(decoded.months.count, WidgetSnapshot.chartMonths)
        XCTAssertEqual(decoded.heatmap.count, WidgetSnapshot.heatmapWeeks * 7)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("claudeAccounts"))
    }

    func testPreferencesAndDisabledSnapshot() {
        var prefs = WidgetPreferences()
        prefs.period = "invalid"
        prefs.accent = "invalid"
        XCTAssertEqual(prefs.normalized.period, "today")
        XCTAssertEqual(prefs.normalized.accent, "cyan")
        prefs.enabled = false
        var usage = UsageSnapshot()
        usage.tokensToday = 500
        let snapshot = WidgetBridge.makeSnapshot(usage: usage, history: [], limits: [], preferences: prefs)
        XCTAssertEqual(snapshot.tokens, 0)
        XCTAssertNil(snapshot.updatedAt)
        XCTAssertTrue(snapshot.days.isEmpty)
        XCTAssertTrue(snapshot.hourly.isEmpty)
        XCTAssertTrue(snapshot.weeks.isEmpty)
        XCTAssertTrue(snapshot.heatmap.isEmpty)
    }

    func testAllTimeCostLimitsAndStaleness() {
        var prefs = WidgetPreferences()
        prefs.period = "all"
        prefs.showCost = true
        var usage = UsageSnapshot()
        usage.tokensAllTime = 5678
        usage.costAllTime = 12
        usage.updatedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let limits = [ProviderLimit(provider: "test", label: "weekly", usedPercent: 120, detail: "private")]
        let snapshot = WidgetBridge.makeSnapshot(usage: usage, history: [], limits: limits + limits, preferences: prefs)
        XCTAssertEqual(snapshot.tokens, 5678)
        XCTAssertEqual(snapshot.cost, 12)
        XCTAssertEqual(snapshot.limits.count, 1)
        XCTAssertEqual(snapshot.limits.first?.usedPercent, 100)
        XCTAssertFalse(snapshot.isStale(at: usage.updatedAt.addingTimeInterval(900)))
        XCTAssertTrue(snapshot.isStale(at: usage.updatedAt.addingTimeInterval(901)))
    }

    func testDailyStacksSplitPerProvider() {
        let today = Self.dayZero
        let history = [
            HistoryPoint(day: today - 86_400, tokens: 100, cost: 0, byTool: ["claude": 70, "codex": 30]),
            HistoryPoint(day: today, tokens: 50, cost: 0, byTool: ["claude": 50])
        ]
        let snapshot = WidgetBridge.makeSnapshot(usage: .empty, history: history, limits: [], preferences: WidgetPreferences())
        XCTAssertEqual(snapshot.days.count, WidgetSnapshot.chartDays)
        let yesterday = snapshot.days[WidgetSnapshot.chartDays - 2]
        XCTAssertEqual(yesterday.tokens, 100)
        XCTAssertEqual(yesterday.byProvider["claude"], 70)
        XCTAssertEqual(yesterday.byProvider["codex"], 30)
        XCTAssertEqual(snapshot.days[WidgetSnapshot.chartDays - 1].byProvider["claude"], 50)
    }

    func testHourlyStacksUseProvidedPoints() {
        let now = Date()
        let hourly = (0..<30).map { index in
            HistoryPoint(day: Int(now.timeIntervalSince1970) - (29 - index) * 3600,
                         tokens: 10, cost: 0, byTool: ["codex": 10])
        }
        let snapshot = WidgetBridge.makeSnapshot(usage: .empty, history: [], hourly: hourly, limits: [], preferences: WidgetPreferences())
        XCTAssertEqual(snapshot.hourly.count, WidgetSnapshot.chartHours)
        XCTAssertEqual(snapshot.hourly.last?.tokens, 10)
        XCTAssertEqual(snapshot.hourly.last?.byProvider["codex"], 10)
    }

    func testWeeklyBucketsAggregateSevenDays() {
        let today = Self.dayZero
        let history = (0..<28).map { offset in
            HistoryPoint(day: today - offset * 86_400, tokens: 10, cost: 0, byTool: ["claude": 10])
        }
        let snapshot = WidgetBridge.makeSnapshot(usage: .empty, history: history, limits: [], preferences: WidgetPreferences())
        XCTAssertEqual(snapshot.weeks.count, WidgetSnapshot.heatmapWeeks)
        let currentWeek = snapshot.weeks[WidgetSnapshot.heatmapWeeks - 1]
        XCTAssertEqual(currentWeek.tokens, 70)
        XCTAssertEqual(currentWeek.byProvider["claude"], 70)
        XCTAssertEqual(snapshot.weeks[WidgetSnapshot.heatmapWeeks - 2].tokens, 70)
        XCTAssertEqual(snapshot.weeks.reduce(0) { $0 + $1.tokens }, 280)
    }

    func testDailyStacksCapProvidersIntoOther() {
        let today = Self.dayZero
        var byTool: [String: Int] = [:]
        for i in 0..<8 { byTool["provider-\(i)"] = (i + 1) * 10 }
        let history = [HistoryPoint(day: today, tokens: byTool.values.reduce(0, +), cost: 0, byTool: byTool)]
        let snapshot = WidgetBridge.makeSnapshot(usage: .empty, history: history, limits: [], preferences: WidgetPreferences())
        let todayStack = snapshot.days[WidgetSnapshot.chartDays - 1].byProvider
        XCTAssertEqual(todayStack.count, 6)
        XCTAssertEqual(todayStack["other"], 10 + 20 + 30)
        XCTAssertEqual(todayStack.values.reduce(0, +), byTool.values.reduce(0, +))
    }

    func testHeatmapTrailingWeeksOldestFirst() {
        let today = Self.dayZero
        let history = [
            HistoryPoint(day: today, tokens: 42, cost: 0, byTool: [:]),
            HistoryPoint(day: today - 86_400 * (WidgetSnapshot.heatmapWeeks * 7 - 1), tokens: 7, cost: 0, byTool: [:])
        ]
        let snapshot = WidgetBridge.makeSnapshot(usage: .empty, history: history, limits: [], preferences: WidgetPreferences())
        XCTAssertEqual(snapshot.heatmap.count, WidgetSnapshot.heatmapWeeks * 7)
        XCTAssertEqual(snapshot.heatmap.last, 42)
        XCTAssertEqual(snapshot.heatmap.first, 7)
        XCTAssertEqual(snapshot.heatmap.reduce(0, +), 49)
    }

    func testHeatmapOmittedWhenChartHidden() {
        var prefs = WidgetPreferences()
        prefs.showChart = false
        let history = [HistoryPoint(day: Self.dayZero, tokens: 42, cost: 0, byTool: [:])]
        let snapshot = WidgetBridge.makeSnapshot(usage: .empty, history: history, limits: [], preferences: prefs)
        XCTAssertTrue(snapshot.days.isEmpty)
        XCTAssertTrue(snapshot.weeks.isEmpty)
        XCTAssertTrue(snapshot.heatmap.isEmpty)
    }

    func testCarouselPageCycling() {
        XCTAssertEqual(WidgetPage.cycled(0, delta: 1), 1)
        XCTAssertEqual(WidgetPage.cycled(1, delta: 1), 2)
        XCTAssertEqual(WidgetPage.cycled(2, delta: 1), 0)
        XCTAssertEqual(WidgetPage.cycled(0, delta: -1), 2)
        XCTAssertEqual(WidgetPage.cycled(5, delta: 0), 2)
        XCTAssertEqual(WidgetPage.cycled(3, delta: -1, count: 0), 0)
        XCTAssertEqual(WidgetPage.allCases.count, 3)
    }

    func testResetTextAndUrgency() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(WidgetSnapshot.resetText(now.addingTimeInterval(-5), now: now), "now")
        XCTAssertEqual(WidgetSnapshot.resetText(now.addingTimeInterval(600), now: now), "10m")
        XCTAssertEqual(WidgetSnapshot.resetText(now.addingTimeInterval(5 * 3600 + 20 * 60), now: now), "5h 20m")
        XCTAssertEqual(WidgetSnapshot.resetText(now.addingTimeInterval(2 * 86_400 + 4 * 3600), now: now), "2d 4h")

        var limit = WidgetSnapshot.Limit(provider: "p", label: "l", usedPercent: 10,
                                         resetsAt: now.addingTimeInterval(3600))
        XCTAssertEqual(limit.urgency(at: now), "urgent")
        limit.resetsAt = now.addingTimeInterval(86_400 + 3600)
        XCTAssertEqual(limit.urgency(at: now), "soon")
        limit.resetsAt = now.addingTimeInterval(3 * 86_400)
        XCTAssertEqual(limit.urgency(at: now), "normal")
        limit.resetsAt = nil
        XCTAssertEqual(limit.urgency(at: now), "normal")
    }

    func testLimitsAreExpirySortedAndKeepDetail() {
        let now = Date()
        let limits = [
            ProviderLimit(provider: "late", label: "weekly", usedPercent: 90,
                          resetsAt: now.addingTimeInterval(7 * 86_400), detail: "week"),
            ProviderLimit(provider: "soon", label: "5h", usedPercent: 10,
                          resetsAt: now.addingTimeInterval(3600), detail: "burst"),
            ProviderLimit(provider: "none", label: "monthly", usedPercent: 50,
                          resetsAt: nil, detail: "no reset")
        ]
        let snapshot = WidgetBridge.makeSnapshot(usage: .empty, history: [], limits: limits,
                                                 preferences: WidgetPreferences())
        XCTAssertEqual(snapshot.limits.map(\.provider), ["soon", "late", "none"])
        XCTAssertEqual(snapshot.limits.first?.detail, "burst")
        XCTAssertEqual(snapshot.limits.first?.usedPercent, 10)
    }

    func testWindowPreferenceNormalization() {
        var prefs = WidgetPreferences()
        prefs.window = "bogus"
        XCTAssertEqual(prefs.normalized.window, "days")
        prefs.window = "weeks"
        XCTAssertEqual(prefs.normalized.window, "weeks")
        prefs.page = 99
        XCTAssertEqual(prefs.normalized.page, WidgetPage.count - 1)
        prefs.page = -3
        XCTAssertEqual(prefs.normalized.page, 0)
    }

    func testReloadPolicySparesBudget() {
        let now = Date()
        XCTAssertTrue(WidgetBridge.shouldReload(force: true, changed: false, lastReload: now, now: now),
                      "taps always repaint")
        XCTAssertFalse(WidgetBridge.shouldReload(force: false, changed: false, lastReload: .distantPast, now: now),
                       "no-op ticks never spend a reload")
        XCTAssertTrue(WidgetBridge.shouldReload(force: false, changed: true, lastReload: .distantPast, now: now),
                      "changed payload after the interval reloads")
        XCTAssertFalse(WidgetBridge.shouldReload(force: false, changed: true, lastReload: now, now: now),
                       "changed payload inside the interval is deferred")
        XCTAssertTrue(WidgetBridge.shouldReload(force: false, changed: true,
                                                lastReload: now.addingTimeInterval(-301), now: now))
    }

    func testDeepLinkParsing() {
        XCTAssertEqual(WidgetSnapshot.windowValue(from: "weeks"), "weeks")
        XCTAssertNil(WidgetSnapshot.windowValue(from: "bogus"))
        XCTAssertEqual(WidgetSnapshot.pageValue(from: "next", current: 2), 0)
        XCTAssertEqual(WidgetSnapshot.pageValue(from: "prev", current: 0), 2)
        XCTAssertEqual(WidgetSnapshot.pageValue(from: "1", current: 2), 1)
        XCTAssertNil(WidgetSnapshot.pageValue(from: "9", current: 0))
        XCTAssertNil(WidgetSnapshot.pageValue(from: "junk", current: 0))
    }

    func testWindowCyclingAndSeriesSelection() {
        XCTAssertEqual(WidgetWindow.next(after: "hours"), .days)
        XCTAssertEqual(WidgetWindow.next(after: "days"), .weeks)
        XCTAssertEqual(WidgetWindow.next(after: "weeks"), .months)
        XCTAssertEqual(WidgetWindow.next(after: "months"), .years)
        XCTAssertEqual(WidgetWindow.next(after: "years"), .hours)
        XCTAssertEqual(WidgetWindow.next(after: "bogus"), .weeks)
        XCTAssertEqual(WidgetWindow.allCases.map(\.label), ["h", "d", "w", "m", "y"])
        XCTAssertEqual(WidgetWindow.allCases.map(\.helpText).count, WidgetWindow.allCases.count)

        let snapshot = WidgetSnapshot.preview
        XCTAssertEqual(WidgetSnapshot.points(for: "hours", in: snapshot).count, WidgetSnapshot.chartHours)
        XCTAssertEqual(WidgetSnapshot.points(for: "days", in: snapshot).count, WidgetSnapshot.weeklyDayBars)
        XCTAssertEqual(WidgetSnapshot.points(for: "weeks", in: snapshot).count, WidgetSnapshot.heatmapWeeks)
        XCTAssertEqual(WidgetSnapshot.points(for: "months", in: snapshot).count, WidgetSnapshot.chartDays)
        XCTAssertEqual(WidgetSnapshot.points(for: "years", in: snapshot).count, WidgetSnapshot.chartMonths)
        XCTAssertEqual(WidgetSnapshot.points(for: "bogus", in: snapshot).count, WidgetSnapshot.weeklyDayBars)
    }

    func testMonthlyBucketsAggregate() {
        let calendar = Calendar.current
        let history = (0..<80).map { offset in
            HistoryPoint(day: Int(Date().timeIntervalSince1970) - offset * 86_400,
                         tokens: 10, cost: 0, byTool: ["claude": 10])
        }
        let snapshot = WidgetBridge.makeSnapshot(usage: .empty, history: history, limits: [],
                                                 preferences: WidgetPreferences())
        XCTAssertEqual(snapshot.months.count, WidgetSnapshot.chartMonths)
        XCTAssertEqual(snapshot.months.reduce(0) { $0 + $1.tokens }, 800)
        let firstOfMonth = calendar.date(from: calendar.dateComponents([.year, .month], from: Date()))!
        let daysThisMonth = calendar.dateComponents([.day], from: firstOfMonth, to: Date()).day! + 1
        XCTAssertEqual(snapshot.months.last?.tokens, daysThisMonth * 10)
    }

    func testHeatmapColumnsFollowWindow() {
        let snapshot = WidgetSnapshot.preview
        let hourly = WidgetSnapshot.heatmapColumns(for: "hours", in: snapshot, weeks: 17, large: true)
        XCTAssertEqual(hourly.count, 12)
        XCTAssertTrue(hourly.allSatisfy { $0.count == 2 })
        XCTAssertEqual(hourly.flatMap { $0 }.count, WidgetSnapshot.chartHours)

        let daily = WidgetSnapshot.heatmapColumns(for: "days", in: snapshot, weeks: 17, large: true)
        XCTAssertEqual(daily.count, WidgetSnapshot.weeklyDayBars)
        XCTAssertTrue(daily.allSatisfy { $0.count == 1 })

        let weekly = WidgetSnapshot.heatmapColumns(for: "weeks", in: snapshot, weeks: 17, large: true)
        XCTAssertEqual(weekly.count, 17)
        XCTAssertEqual(weekly.first?.count, 7)
        XCTAssertEqual(weekly.flatMap { $0 }.count, WidgetSnapshot.heatmapWeeks * 7)

        // Monthly/yearly keep square-ish, area-filling grids (bigger cells).
        let monthlyLarge = WidgetSnapshot.heatmapColumns(for: "months", in: snapshot, weeks: 17, large: true)
        XCTAssertEqual(monthlyLarge.count, 6)
        XCTAssertTrue(monthlyLarge.allSatisfy { $0.count == 5 })
        XCTAssertEqual(monthlyLarge.flatMap { $0 }.count, WidgetSnapshot.chartDays)

        let monthlyMedium = WidgetSnapshot.heatmapColumns(for: "months", in: snapshot, weeks: 8, large: false)
        XCTAssertEqual(monthlyMedium.count, 10)
        XCTAssertTrue(monthlyMedium.allSatisfy { $0.count == 3 })

        let yearlyLarge = WidgetSnapshot.heatmapColumns(for: "years", in: snapshot, weeks: 17, large: true)
        XCTAssertEqual(yearlyLarge.count, 4)
        XCTAssertTrue(yearlyLarge.allSatisfy { $0.count == 3 })
        XCTAssertEqual(yearlyLarge.flatMap { $0 }.count, WidgetSnapshot.chartMonths)

        let yearlyMedium = WidgetSnapshot.heatmapColumns(for: "years", in: snapshot, weeks: 8, large: false)
        XCTAssertEqual(yearlyMedium.count, 6)
        XCTAssertTrue(yearlyMedium.allSatisfy { $0.count == 2 })

        XCTAssertEqual(WidgetSnapshot.chunked([1, 2, 3, 4, 5], size: 2), [[1, 2], [3, 4], [5]])
        XCTAssertEqual(WidgetSnapshot.chunked([1, 2], size: 0), [])
    }

    func testAggregateByProvider_sortsCapsAndSums() {
        let days = [
            WidgetSnapshot.DayTokens(tokens: 100, byProvider: ["claude": 60, "codex": 40]),
            WidgetSnapshot.DayTokens(tokens: 90, byProvider: ["claude": 30, "codex": 40, "glm": 20]),
            WidgetSnapshot.DayTokens(tokens: 50, byProvider: ["kimi": 50])
        ]
        let all = WidgetSnapshot.aggregateByProvider(days: days, limit: 10)
        XCTAssertEqual(all.map(\.provider), ["claude", "codex", "kimi", "glm"])
        XCTAssertEqual(all.map(\.tokens), [90, 80, 50, 20])
        XCTAssertEqual(all.reduce(0) { $0 + $1.tokens }, 240)

        let capped = WidgetSnapshot.aggregateByProvider(days: days, limit: 2)
        XCTAssertEqual(capped.map(\.provider), ["claude", "codex", "other"])
        XCTAssertEqual(capped.last?.tokens, 70)
        XCTAssertEqual(capped.reduce(0) { $0 + $1.tokens }, 240)
    }
}