import XCTest
@testable import TokenHorizon

/// Budget-gated: `makeSnapshot` runs in the widget-tap critical path (pref
/// change -> rebuild -> reload) and on every 5s publish, so regressions here
/// are felt directly as laggy widget transitions.
/// Budget: 5 ms average over 40 runs against a full 370-day history.
final class WidgetSnapshotPerfTests: XCTestCase {

    private func fixture() -> (usage: UsageSnapshot, history: [HistoryPoint], hourly: [HistoryPoint]) {
        var usage = UsageSnapshot()
        usage.tokensToday = 12_345_678
        usage.updatedAt = Date()
        var history: [HistoryPoint] = []
        let today = Int(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970)
        for offset in 0..<370 {
            history.append(HistoryPoint(
                day: today - offset * 86_400,
                tokens: 1_000_000 + offset * 13_337,
                cost: Double(offset) * 0.42,
                byTool: ["claude": 500_000 + offset, "codex": 250_000, "opencode": 120_000,
                         "glm": 80_000, "kimi": 50_000, "gemini": 30_000, "ollama": 20_000]))
        }
        let hourly = (0..<24).map { index in
            HistoryPoint(day: Int(Date().timeIntervalSince1970) - (23 - index) * 3600,
                         tokens: 100_000 + index * 1_000, cost: 0.5,
                         byTool: ["claude": 60_000, "codex": 40_000])
        }
        return (usage, history, hourly)
    }

    func testMakeSnapshot_underHardBudget() {
        let fx = fixture()
        var preferences = WidgetPreferences()
        preferences.showChart = true

        // Warm caches (calendar, formatters).
        _ = WidgetBridge.makeSnapshot(usage: fx.usage, history: fx.history, hourly: fx.hourly,
                                      limits: [], preferences: preferences)

        let runs = 40
        let start = DispatchTime.now()
        for _ in 0..<runs {
            _ = WidgetBridge.makeSnapshot(usage: fx.usage, history: fx.history, hourly: fx.hourly,
                                          limits: [], preferences: preferences)
        }
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
        let average = elapsed / Double(runs)
        NSLog("[PerfTests] makeSnapshot average: %.2fms (budget: 5.00ms, %d runs)", average, runs)
        XCTAssertLessThan(average, 5.0, "REGRESSION: widget snapshot build slower than budget")
    }

    func testBucketPoints_matchesNaiveScan() {
        // The optimized merge walk must agree with the naive per-bucket scan.
        let today = Int(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970)
        let history = (0..<200).map { offset in
            HistoryPoint(day: today - offset * 86_400, tokens: offset,
                         cost: Double(offset), byTool: ["claude": offset, "codex": 1])
        }
        let buckets: [(Date, Date)] = (0..<30).map { offset in
            let start = Date(timeIntervalSince1970: Double(today - (29 - offset) * 86_400))
            return (start, start.addingTimeInterval(86_400))
        }
        let optimized = WidgetBridge.bucketPoints(history, in: buckets)
        let naive = buckets.map { start, end -> HistoryPoint in
            var tokens = 0
            var cost = 0.0
            var byTool: [String: Int] = [:]
            for point in history where Double(point.day) >= start.timeIntervalSince1970
                && Double(point.day) < end.timeIntervalSince1970 {
                tokens += max(0, point.tokens)
                cost += max(0, point.cost)
                for (tool, value) in point.byTool where value > 0 { byTool[tool, default: 0] += value }
            }
            return HistoryPoint(day: Int(start.timeIntervalSince1970), tokens: tokens, cost: cost, byTool: byTool)
        }
        XCTAssertEqual(optimized.count, naive.count)
        for (lhs, rhs) in zip(optimized, naive) {
            XCTAssertEqual(lhs.tokens, rhs.tokens)
            XCTAssertEqual(lhs.cost, rhs.cost, accuracy: 0.0001)
            XCTAssertEqual(lhs.byTool, rhs.byTool)
        }
    }
}
