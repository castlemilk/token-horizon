import SwiftUI

struct WingRingGauge: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let percent: Double
    let color: Color
    var help: String = ""
    var body: some View {
        let clamped = Swift.min(Swift.max(percent, 0), 100)
        return ZStack {
            Circle().stroke(Color.white.opacity(0.18), lineWidth: 2.8)
            Circle()
                .trim(from: 0, to: CGFloat(max(clamped, 4) / 100))
                .stroke(color, style: StrokeStyle(lineWidth: 2.8, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .shadow(color: color.opacity(0.35), radius: 2)
            Text(String(format: "%.0f", clamped))
                .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.6)
        }
        .frame(width: 22, height: 22)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.5), value: clamped)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(help)
        .accessibilityValue("\(Int(clamped)) percent")
        .help(help)
    }
}

struct ProcessMetric: View {
    let value: Double
    let maxValue: Double
    let text: String
    let color: Color
    var gradient: Gradient? = nil
    var barWidth: CGFloat = 20
    var textWidth: CGFloat = 34
    var body: some View {
        HStack(spacing: 4) {
                MonospacedText(text: text, color: .white.opacity(0.75), size: 8)
                .frame(width: textWidth, alignment: .trailing)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.1))
                let fillWidth = max(1.5, CGFloat(barWidth * Swift.min(value / Swift.max(maxValue, 1), 1)))
                if let gradient {
                    Capsule().fill(LinearGradient(gradient: gradient, startPoint: .leading, endPoint: .trailing))
                        .frame(width: fillWidth)
                } else {
                    Capsule().fill(color.opacity(0.75)).frame(width: fillWidth)
                }
            }
            .frame(width: barWidth, height: 3)
        }
        .frame(width: barWidth + textWidth + 4, height: 12, alignment: .trailing)
    }
}

struct HeatmapGrid: View {
    let points: [HistoryPoint]
    let maxTokens: Int
    var cellSize: CGFloat = 7
    @State private var hovered: (point: HistoryPoint, column: Int)?
    private let gap: CGFloat = 1.5
    private let weekdayWidth: CGFloat = 26
    private let weekdayLabels = ["Mon", "", "Wed", "", "Fri", "", ""]

    var body: some View {
        let columns = Self.weekColumns(points)
        let width = CGFloat(columns.count) * (cellSize + gap) + weekdayWidth
        let labels = positionedMonthLabels(columns, width: width)
        return VStack(alignment: .leading, spacing: 5) {
            ZStack(alignment: .topLeading) {
                ForEach(labels, id: \.column) { label in
                    Text(label.title)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.white.opacity(0.65))
                        .offset(x: label.x)
                }
            }
            .frame(width: width, height: 12, alignment: .leading)
            HStack(alignment: .top, spacing: 0) {
                VStack(alignment: .trailing, spacing: gap) {
                    ForEach(0..<7, id: \.self) { row in
                        Text(weekdayLabels[row])
                            .font(.system(size: 8))
                            .foregroundStyle(.white.opacity(0.6))
                            .frame(width: weekdayWidth, height: cellSize, alignment: .leading)
                    }
                }
                HStack(alignment: .top, spacing: gap) {
                    ForEach(Array(columns.enumerated()), id: \.offset) { column, week in
                        VStack(spacing: gap) {
                            ForEach(0..<7, id: \.self) { row in
                                if let point = week[row] {
                                    let description = tooltipDescription(point)
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(cellColor(point.tokens))
                                        .frame(width: cellSize, height: cellSize)
                                        .help(description)
                                        .accessibilityLabel(description)
                                        .onHover { over in
                                            if over { hovered = (point, column) }
                                            else if hovered?.point.day == point.day { hovered = nil }
                                        }
                                } else {
                                    Color.clear.frame(width: cellSize, height: cellSize)
                                }
                            }
                        }
                    }
                }
            }
            HStack(spacing: 4) {
                Spacer(minLength: 0)
                Text("Less")
                ForEach(0..<6, id: \.self) { level in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(heatColor(level: Double(level) / 5.0))
                        .frame(width: 7, height: 7)
                }
                Text("More")
            }
            .font(.system(size: 8))
            .foregroundStyle(.white.opacity(0.6))
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .topLeading) {
            GeometryReader { bounds in
                if let hovered {
                    // Native help is not delivered in the nonactivating notch.
                    // Keep a custom bubble inside the calendar's actual width.
                    tooltip(hovered.point)
                        .offset(x: tooltipX(column: hovered.column, width: bounds.size.width))
                        .allowsHitTesting(false)
                }
            }
        }
        .onChange(of: cellSize) { _ in hovered = nil }
    }

    /// Monday-aligned columns retain missing days and bound allocation to a
    /// trailing year, including the partial weeks at either end.
    static func weekColumns(_ points: [HistoryPoint], calendar: Calendar = .current) -> [[HistoryPoint?]] {
        guard let earliest = points.map(\.day).min(), let latest = points.map(\.day).max() else { return [] }
        let lastDay = calendar.startOfDay(for: Date(timeIntervalSince1970: TimeInterval(latest)))
        let earliestDay = calendar.startOfDay(for: Date(timeIntervalSince1970: TimeInterval(earliest)))
        let yearStart = calendar.date(byAdding: .day, value: -363, to: lastDay) ?? earliestDay
        let firstDay = max(earliestDay, yearStart)
        let leading = (calendar.component(.weekday, from: firstDay) + 5) % 7
        let days = max(0, calendar.dateComponents([.day], from: firstDay, to: lastDay).day ?? 0)
        var columns = Array(repeating: Array<HistoryPoint?>(repeating: nil, count: 7),
                            count: (leading + days + 7) / 7)
        for point in points {
            let day = calendar.startOfDay(for: Date(timeIntervalSince1970: TimeInterval(point.day)))
            let offset = calendar.dateComponents([.day], from: firstDay, to: day).day ?? -1
            guard offset >= 0, offset <= days else { continue }
            let index = leading + offset
            columns[index / 7][index % 7] = point
        }
        return columns
    }

    /// Label each month once instead of re-emitting it after an unlabeled week.
    static func monthLabels(_ columns: [[HistoryPoint?]], calendar: Calendar = .current) -> [(column: Int, title: String)] {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.dateFormat = "MMM"
        var previous: DateComponents?
        var labels: [(column: Int, title: String)] = []
        for (index, column) in columns.enumerated() {
            guard let point = column.compactMap({ $0 }).first else { continue }
            let date = Date(timeIntervalSince1970: TimeInterval(point.day))
            let month = calendar.dateComponents([.year, .month], from: date)
            if month != previous {
                labels.append((index, formatter.string(from: date)))
                previous = month
            }
        }
        return labels
    }

    private func positionedMonthLabels(_ columns: [[HistoryPoint?]], width: CGFloat) -> [(column: Int, title: String, x: CGFloat)] {
        var labels: [(column: Int, title: String, x: CGFloat)] = []
        var nextX = CGFloat.infinity
        for label in Self.monthLabels(columns).reversed() {
            let x = min(weekdayWidth + CGFloat(label.column) * (cellSize + gap), max(weekdayWidth, width - 24))
            if nextX - x >= 26 {
                labels.append((label.column, label.title, x))
                nextX = x
            }
        }
        return Array(labels.reversed())
    }

    func heatColor(level: Double) -> Color {
        Color.green.opacity(0.22 + 0.78 * level)
    }

    func cellColor(_ tokens: Int) -> Color {
        guard tokens > 0 else { return Color.white.opacity(0.06) }
        let ratio = log(Double(tokens) + 1) / log(Double(max(maxTokens, 1)) + 1)
        return heatColor(level: Swift.min(ratio * 1.4, 1))
    }

    private static let tooltipDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    private func tooltipDescription(_ point: HistoryPoint) -> String {
        let date = Self.tooltipDateFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(point.day)))
        let summary = point.tokens > 0 ? "\(UsageSnapshot.tokens(point.tokens)) tokens" : "No usage"
        let tools = point.byTool.filter { $0.value > 0 }.sorted { $0.value > $1.value }.prefix(4)
            .map { "\($0.key): \(UsageSnapshot.tokens($0.value))" }
        return ([date, summary] + tools).joined(separator: "\n")
    }

    /// The weekday gutter is added once; first and last cells share the same
    /// bounds regardless of the calendar's current number of weeks.
    func tooltipX(column: Int, width: CGFloat) -> CGFloat {
        let center = weekdayWidth + CGFloat(column) * (cellSize + gap) + cellSize / 2
        return min(max(0, center - 79), max(0, width - 158))
    }

    private func tooltip(_ point: HistoryPoint) -> some View {
        let tools = point.byTool.filter { $0.value > 0 }.sorted { $0.value > $1.value }.prefix(4)
        return VStack(alignment: .leading, spacing: 2) {
            Text(Self.tooltipDateFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(point.day))))
                .font(.system(size: 8, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
            Text(point.tokens > 0 ? "\(UsageSnapshot.tokens(point.tokens)) tokens" : "No usage")
                .font(.system(size: 10, weight: .semibold)).monospacedDigit().foregroundStyle(.green)
            ForEach(Array(tools), id: \.key) { tool, tokens in
                HStack(spacing: 3) {
                    Circle().fill(DashboardTabs.toolColor(tool)).frame(width: 3, height: 3)
                    Text(tool).font(.system(size: 8)).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
                    Spacer(minLength: 3)
                    Text(UsageSnapshot.tokens(tokens)).font(.system(size: 8)).monospacedDigit()
                        .foregroundStyle(.white.opacity(0.65))
                }
            }
        }
        .padding(7).frame(width: 158, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.97))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.18))))
    }
}

struct HeatmapKPIs: View {
    let points: [HistoryPoint]
    var horizontal = false
    var body: some View {
        var total = 0
        var peak = 0
        var active = 0
        for p in points {
            total += p.tokens
            if p.tokens > peak { peak = p.tokens }
            if p.tokens > 0 { active += 1 }
        }
        return Group {
            if horizontal {
                HStack(alignment: .top, spacing: 16) {
                    kpi(UsageSnapshot.tokens(total), "Total tokens")
                    kpi(UsageSnapshot.tokens(peak), "Peak day")
                    kpi("\(active)", "Active days")
                }
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    kpi(UsageSnapshot.tokens(total), "Total tokens")
                    kpi(UsageSnapshot.tokens(peak), "Peak tokens")
                    kpi("\(active)", "Active days")
                }
            }
        }
    }
    private func kpi(_ value: String, _ caption: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.system(size: 13, weight: .semibold)).monospacedDigit()
                .foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.8)
            Text(caption).font(.system(size: 9)).foregroundStyle(.white.opacity(0.65))
        }
    }
}

struct StackedTrends: View {
    let points: [HistoryPoint]
    @State private var hovered: (point: HistoryPoint, index: Int)?
    var body: some View {
        let maxTotal = Swift.max(points.map { $0.tokens }.max() ?? 1, 1)
        return GeometryReader { geo in
            let n = Swift.max(points.count, 1)
            let barW = geo.size.width / CGFloat(n)
            let bubbleW: CGFloat = 158
            return ZStack(alignment: .topLeading) {
                HStack(alignment: .bottom, spacing: 0) {
                    ForEach(Array(points.enumerated()), id: \.offset) { i, point in
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(segmentHeights(point, maxTotal: maxTotal, container: geo.size.height).reversed()), id: \.0) { tool, height in
                                Rectangle()
                                    .fill(DashboardTabs.toolColor(tool).opacity(hovered?.index == i ? 1 : 0.88))
                                    .frame(height: height)
                            }
                            if point.tokens == 0 { Rectangle().fill(Color.white.opacity(0.05)).frame(height: 1) }
                        }
                        .frame(width: barW, height: geo.size.height, alignment: .bottom)
                        .contentShape(Rectangle())
                        .accessibilityLabel("\(dayString(point.day)), \(UsageSnapshot.tokens(point.tokens)) tokens")
                        .onHover { over in
                            if over { hovered = (point, i) }
                            else if hovered?.index == i { hovered = nil }
                        }
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height, alignment: .bottom)
                .clipped()
                Rectangle().fill(Color.white.opacity(0.15)).frame(height: 1).frame(maxHeight: .infinity, alignment: .bottom)
                if let h = hovered, h.point.tokens > 0 {
                    let rawX = (CGFloat(h.index) + 0.5) * barW - bubbleW / 2
                    let clampedX = Swift.min(Swift.max(rawX, 0), Swift.max(0, geo.size.width - bubbleW))
                    trendTooltip(h.point)
                        .offset(x: clampedX, y: 4)
                        .allowsHitTesting(false)
                }
            }
        }
    }
    /// Sqrt-scaled bar height. Internal for hermetic unit tests.
    func barHeight(_ tokens: Int, _ maxTotal: Int, container: CGFloat) -> CGFloat {
        guard container.isFinite, container > 0 else { return 0 }
        let ratio = sqrt(min(1, Double(max(0, tokens)) / Double(max(1, maxTotal))))
        return min(container, max(min(1.5, container), CGFloat(ratio) * max(0, container - 4)))
    }

    /// Scale the bucket once, then divide its height linearly. Scaling each
    /// provider separately makes a multi-provider stack exceed the plot.
    func segmentHeights(_ point: HistoryPoint, maxTotal: Int, container: CGFloat) -> [(String, CGFloat)] {
        guard point.tokens > 0, container.isFinite, container > 0 else { return [] }
        var values = sortedTools(point).map { ($0.0, Double($0.1)) }
        let known = values.reduce(0.0) { $0 + $1.1 }
        let missing = max(0, Double(point.tokens) - known)
        if missing > 0 {
            if let index = values.firstIndex(where: { $0.0 == "other" }) {
                values[index].1 += missing
            } else {
                values.append(("other", missing))
            }
        }
        let denominator = max(Double(point.tokens), known)
        let height = barHeight(point.tokens, maxTotal, container: container)
        return values.map { ($0.0, height * CGFloat($0.1 / denominator)) }
    }
    /// Tools sorted by tokens desc. Internal for hermetic unit tests.
    func sortedTools(_ point: HistoryPoint) -> [(String, Int)] {
        point.byTool.filter { $0.value > 0 }.sorted { $0.value > $1.value }
    }
    private func trendTooltip(_ p: HistoryPoint) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(dayString(p.day))
                .font(.system(size: 8, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.6))
            Text("\(UsageSnapshot.tokens(p.tokens)) tokens")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(.green)
            ForEach(Array(sortedTools(p).prefix(4)), id: \.0) { tool, tokens in
                HStack(spacing: 3) {
                    Circle().fill(DashboardTabs.toolColor(tool)).frame(width: 3, height: 3)
                    Text(tool).font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
                    Spacer()
                    Text(UsageSnapshot.tokens(tokens)).font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.55))
                }
            }
        }
        .padding(7).frame(width: 158, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.97))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.18))))
    }
    private func dayString(_ epochDay: Int) -> String {
        DateFormatter.localizedString(from: Date(timeIntervalSince1970: TimeInterval(epochDay)),
                                      dateStyle: .medium, timeStyle: .none)
    }
}

struct Sparkline: View {
    let values: [Double]
    let color: Color
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            let maxV = Swift.max(values.max() ?? 0, 1)
            let pts: [CGPoint] = values.enumerated().map { i, v in
                CGPoint(x: w * CGFloat(i) / CGFloat(Swift.max(values.count - 1, 1)),
                        y: h - 2 - (h - 4) * CGFloat(Swift.min(v, maxV) / maxV))
            }
            ZStack {
                if pts.count > 1 {
                    Path { p in
                        p.move(to: CGPoint(x: pts[0].x, y: h))
                        pts.forEach { p.addLine(to: $0) }
                        p.addLine(to: CGPoint(x: pts[pts.count - 1].x, y: h))
                        p.closeSubpath()
                    }
                    .fill(LinearGradient(colors: [color.opacity(0.32), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    Path { p in
                        p.move(to: pts[0])
                        pts.dropFirst().forEach { p.addLine(to: $0) }
                    }
                    .stroke(color.opacity(0.95), style: StrokeStyle(lineWidth: 1.4, lineCap: .round, lineJoin: .round))
                    if let last = pts.last {
                        Circle().fill(color).frame(width: 3.5, height: 3.5).position(last)
                    }
                } else {
                    Text("collecting…")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                }
            }
        }
    }
}
