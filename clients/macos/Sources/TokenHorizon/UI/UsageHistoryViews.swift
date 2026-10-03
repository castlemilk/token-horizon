import SwiftUI

/// The compact surface keeps a readable plot width. A longer calendar moves
/// below it when the two cannot fit, rather than compressing text or bars.
struct UsageHistorySection: View {
    let history: [HistoryPoint]
    let trend: [HistoryPoint]
    @Binding var window: TrendWindow
    @Binding var expandedCalendar: Bool
    var onWindowChange: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var calendarPoints: [HistoryPoint] {
        Array(history.suffix(expandedCalendar ? 364 : 168))
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 20) {
                calendar(width: expandedCalendar ? 430 : 280)
                trends.frame(minWidth: 360, maxWidth: .infinity, alignment: .leading)
            }
            VStack(alignment: .leading, spacing: 16) {
                trends
                Divider().overlay(Color.white.opacity(0.08))
                calendar(width: expandedCalendar ? 430 : 280)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var trends: some View {
        let total = trend.reduce(0) { $0 + $1.tokens }
        let active = trend.filter { $0.tokens > 0 }.count
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("Usage over time")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
                Spacer(minLength: 4)
                HStack(spacing: 3) {
                    ForEach(TrendWindow.allCases) { option in
                        Button {
                            window = option
                            onWindowChange()
                        } label: {
                            Text(option.rawValue)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(window == option ? Color.black : Color.white.opacity(0.75))
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(Capsule().fill(window == option ? Color.cyan : Color.white.opacity(0.08)))
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Usage over \(option.rawValue)")
                        .accessibilityAddTraits(window == option ? .isSelected : [])
                    }
                }
            }
            HStack(alignment: .top, spacing: 24) {
                summary("Window total", UsageSnapshot.tokens(total), color: .green)
                summary("Average", active > 0 ? UsageSnapshot.tokens(total / active) : "0", color: .white.opacity(0.85))
                    .help("Average tokens across the \(active) active buckets in this window")
            }
            if trend.isEmpty {
                Text("Loading usage…")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 108)
            } else {
                StackedTrends(points: trend).frame(height: 108)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func calendar(width: CGFloat) -> some View {
        let points = calendarPoints
        let count = max(1, HeatmapGrid.weekColumns(points).count)
        let cell = min(9, max(4, (width - 26) / CGFloat(count) - 1.5))
        let peak = max(1, points.map(\.tokens).max() ?? 1)
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Activity")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
                Spacer(minLength: 4)
                Button {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                        expandedCalendar.toggle()
                    }
                } label: {
                    Text(expandedCalendar ? "Show 24 weeks" : "Show 52 weeks")
                        .font(.system(size: 10)).foregroundStyle(.cyan)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            HeatmapGrid(points: points, maxTokens: peak, cellSize: cell)
            HeatmapKPIs(points: points, horizontal: true)
        }
        .frame(width: width, alignment: .leading)
    }

    private func summary(_ title: String, _ value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value).font(.system(size: 14, weight: .semibold)).monospacedDigit()
                .foregroundStyle(color).lineLimit(1)
            Text(title).font(.system(size: 10)).foregroundStyle(.white.opacity(0.65))
        }
    }
}
