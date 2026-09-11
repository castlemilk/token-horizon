import SwiftUI

struct WingRingGauge: View {
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
        .animation(.easeOut(duration: 0.5), value: clamped)
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
    @State private var hovered: (point: HistoryPoint, col: Int, row: Int)?
    private let gap: CGFloat = 1.5
    private let tooltipWidth: CGFloat = 158
    private let weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    var body: some View {
        let cal = Calendar.current
        var weekColumns: [[HistoryPoint?]] = Array(repeating: Array(repeating: nil, count: 7), count: (points.count + 6) / 7)
        var monthAtColumn: [Int: String] = [:]
        let f = DateFormatter(); f.dateFormat = "MMM"
        for (i, point) in points.enumerated() {
            let date = Date(timeIntervalSince1970: TimeInterval(point.day))
            let weekday = cal.component(.weekday, from: date)
            let col = i / 7
            let row = (weekday + 5) % 7
            if col < weekColumns.count {
                weekColumns[col][row] = point
                if monthAtColumn[col] == nil {
                    let m = f.string(from: date)
                    let prev = col - 1
                    if prev < 0 || monthAtColumn[prev] != m { monthAtColumn[col] = m }
                }
            }
        }
        let gridWidth = CGFloat(weekColumns.count) * (cellSize + gap)
        _ = gridWidth
        let monthLabelsWidth = CGFloat(weekColumns.count) * (cellSize + gap) + 22
        return VStack(alignment: .leading, spacing: 3) {
            ZStack(alignment: .topLeading) {
                ForEach(Array(monthAtColumn.sorted(by: { $0.key < $1.key })), id: \.key) { col, month in
                    Text(month)
                        .font(.system(size: 7, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.45))
                        .offset(x: 22 + CGFloat(col) * (cellSize + gap))
                }
            }
            .frame(width: monthLabelsWidth, height: 9, alignment: .leading)
            HStack(alignment: .top, spacing: 0) {
                VStack(alignment: .trailing, spacing: gap) {
                    ForEach(0..<7, id: \.self) { row in
                        Text(weekdayLabels[row])
                            .font(.system(size: 6.5, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.4))
                            .frame(width: 20, height: cellSize, alignment: .trailing)
                    }
                }
                ZStack(alignment: .topLeading) {
                    HStack(alignment: .top, spacing: gap) {
                        ForEach(Array(weekColumns.enumerated()), id: \.offset) { col, week in
                            VStack(spacing: gap) {
                                ForEach(0..<7, id: \.self) { row in
                                    if let p = week[row] {
                                        RoundedRectangle(cornerRadius: 2)
                                            .fill(cellColor(p.tokens))
                                            .frame(width: cellSize, height: cellSize)
                                            .onHover { over in
                                                if over { hovered = (p, col, row) }
                                                else if hovered?.point.day == p.day { hovered = nil }
                                            }
                                    } else {
                                        Color.clear.frame(width: cellSize, height: cellSize)
                                    }
                                }
                            }
                        }
                    }
                    if let h = hovered {
                        tooltipCard(h.point)
                            .offset(x: tooltipX(col: h.col, totalCols: weekColumns.count) + 22,
                                    y: h.row < 3 ? 7 * (cellSize + gap) + 6 : -tooltipHeight(h.point))
                    }
                }
            }
            HStack(spacing: 3) {
                Spacer()
                Text("Less").font(.system(size: 6.5, design: .monospaced)).foregroundStyle(.white.opacity(0.35))
                ForEach(0..<6, id: \.self) { level in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(heatColor(level: Double(level) / 5.0))
                        .frame(width: 6, height: 6)
                }
                Text("More").font(.system(size: 6.5, design: .monospaced)).foregroundStyle(.white.opacity(0.35))
            }
        }
    }

    /// Heat color scale. Internal for hermetic unit tests.
    func heatColor(level: Double) -> Color {
        Color.green.opacity(0.22 + 0.78 * level)
    }
    /// Log-scaled cell color. Internal for hermetic unit tests.
    func cellColor(_ tokens: Int) -> Color {
        guard tokens > 0 else { return Color.white.opacity(0.06) }
        let ratio = log(Double(tokens) + 1) / log(Double(maxTokens) + 1)
        return heatColor(level: Swift.min(ratio * 1.4, 1))
    }
    /// Clamped tooltip anchor. Internal for hermetic unit tests.
    func tooltipX(col: Int, totalCols: Int) -> CGFloat {
        let raw = CGFloat(col) * (cellSize + gap) - tooltipWidth / 2 + cellSize / 2
        let maxX = CGFloat(totalCols) * (cellSize + gap) - tooltipWidth
        return Swift.min(Swift.max(raw, 0), Swift.max(maxX, 0))
    }
    /// Tooltip height by content. Internal for hermetic unit tests.
    func tooltipHeight(_ p: HistoryPoint) -> CGFloat { p.tokens > 0 ? 58 : 40 }
    private func tooltipCard(_ p: HistoryPoint) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(dayString(p.day))
                .font(.system(size: 8, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.6))
            Text(p.tokens > 0 ? "\(UsageSnapshot.tokens(p.tokens)) tokens" : "no usage")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(p.tokens > 0 ? .green : .secondary)
            if p.tokens > 0 {
                ForEach(Array(p.byTool.filter { $0.value > 0 }.sorted { $0.value > $1.value }.prefix(4)), id: \.key) { tool, tokens in
                    HStack(spacing: 3) {
                        Circle().fill(DashboardTabs.toolColor(tool)).frame(width: 3, height: 3)
                        Text(tool).font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.75))
                        Spacer()
                        Text(UsageSnapshot.tokens(tokens)).font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.55))
                    }
                }
            }
        }
        .padding(7).frame(width: tooltipWidth, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.97))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.18))))
    }
    private func dayString(_ epochDay: Int) -> String {
        DateFormatter.localizedString(from: Date(timeIntervalSince1970: TimeInterval(epochDay)),
                                      dateStyle: .medium, timeStyle: .none)
    }
}

struct HeatmapKPIs: View {
    let points: [HistoryPoint]
    var body: some View {
        var total = 0
        var peak = 0
        var active = 0
        for p in points {
            total += p.tokens
            if p.tokens > peak { peak = p.tokens }
            if p.tokens > 0 { active += 1 }
        }
        return VStack(alignment: .leading, spacing: 12) {
            kpi(UsageSnapshot.tokens(total), "Total tokens")
            kpi(UsageSnapshot.tokens(peak), "Peak tokens")
            kpi("\(active)", "Active days")
        }
    }
    private func kpi(_ value: String, _ caption: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.system(size: 14, weight: .bold, design: .monospaced))
                .foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.6)
            Text(caption).font(.system(size: 7.5, design: .monospaced)).foregroundStyle(.secondary)
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
                            ForEach(Array(sortedTools(point).reversed()), id: \.0) { tool, tokens in
                                Rectangle()
                                    .fill(DashboardTabs.toolColor(tool).opacity(hovered?.index == i ? 1 : 0.88))
                                    .frame(height: barHeight(tokens, maxTotal, container: geo.size.height))
                            }
                            if point.tokens == 0 { Rectangle().fill(Color.white.opacity(0.05)).frame(height: 1) }
                        }
                        .frame(width: barW, height: geo.size.height, alignment: .bottom)
                        .contentShape(Rectangle())
                        .onHover { over in
                            if over { hovered = (point, i) }
                            else if hovered?.index == i { hovered = nil }
                        }
                    }
                }
                .frame(maxHeight: .infinity, alignment: .bottom)
                Rectangle().fill(Color.white.opacity(0.15)).frame(height: 1).frame(maxHeight: .infinity, alignment: .bottom)
                if let h = hovered, h.point.tokens > 0 {
                    let rawX = (CGFloat(h.index) + 0.5) * barW - bubbleW / 2
                    let clampedX = Swift.min(Swift.max(rawX, 0), geo.size.width - bubbleW)
                    trendTooltip(h.point).offset(x: clampedX, y: -46)
                }
            }
        }
    }
    /// Sqrt-scaled bar height. Internal for hermetic unit tests.
    func barHeight(_ tokens: Int, _ maxTotal: Int, container: CGFloat) -> CGFloat {
        let ratio = sqrt(Double(tokens) / Double(maxTotal))
        return max(1.5, CGFloat(ratio * Double(container - 4)))
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
                    Text(tool).font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.75))
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

