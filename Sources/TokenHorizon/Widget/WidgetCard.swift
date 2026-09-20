import SwiftUI

/// Deep links are the widget interaction mechanism: `Button(intent:)` taps
/// were silently dropped for this ad-hoc-signed extension (no App Intent
/// delivery at all), while `Link`/widgetURL always opens the host app — an
/// LSUIElement accessory here, so nothing visibly pops up; the app updates the
/// preference and force-republishes, and the widget repaints.
enum WidgetDeepLink {
    static func window(_ raw: String) -> URL? {
        URL(string: "tokenhorizon://window?value=\(raw)")
    }

    static func page(_ delta: Int) -> URL? {
        URL(string: "tokenhorizon://page?value=\(delta > 0 ? "next" : "prev")")
    }
}

struct WidgetCard: View {
    let snapshot: WidgetSnapshot
    var size = "medium"
    var date = Date()
    var offline = false
    var page = 0
    /// App-preview path: local paging without deep links. Nil inside the
    /// real widget, where chevrons fire the tokenhorizon:// page link.
    var onPageChange: ((Int) -> Void)?
    var window = WidgetWindow.days.rawValue
    /// App-preview path for the window picker (see onPageChange).
    var onWindowChange: ((String) -> Void)?

    var accent: Color {
        switch snapshot.preferences.accent {
        case "violet": return .purple
        case "green": return .green
        case "orange": return .orange
        default: return .cyan
        }
    }

    static func providerColor(_ provider: String) -> Color {
        switch provider {
        case "opencode", "muse", "x-preview": return .green
        case "claude": return .orange
        case "codex", "openai", "minimax": return .cyan
        case "kimi", "kimi-coding-plan": return .purple
        case "glm", "zai", "zai-coding-plan": return .yellow
        case "qwen", "qwen-coder": return .blue
        case "grok", "xai": return .pink
        case "gemini", "google": return Color(red: 0.26, green: 0.52, blue: 0.96)
        case "agy", "antigravity": return Color(red: 0.65, green: 0.45, blue: 0.95)
        case "deepseek", "alibaba", "alibaba-token-plan": return .teal
        case "ollama", "mlx", "localllm": return Color(red: 0.18, green: 0.82, blue: 0.72)
        default: return .gray
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: size == "large" ? 14 : 8) {
            HStack(spacing: 5) {
                Image(systemName: "circle.hexagongrid.fill").foregroundStyle(accent)
                Text("TOKEN HORIZON").font(.system(size: 10, weight: .bold, design: .rounded))
                Spacer(minLength: 4)
                if showsWindowPicker { windowToggle }
            }
            if !snapshot.preferences.enabled {
                Spacer(minLength: 0)
                Text("Widget paused").font(.headline)
                Text("Enable in Token Horizon Settings.").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else if snapshot.updatedAt == nil {
                Spacer(minLength: 0)
                Text("Open Token Horizon").font(.headline)
                Text("Your usage will appear after the first refresh.").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else {
                Group {
                    switch WidgetPage(rawValue: page) ?? .overview {
                    case .overview: overviewPage
                    case .limits: limitsPage
                    case .plans: plansPage
                    }
                }
                Spacer(minLength: 0)
                chrome
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var carouselEnabled: Bool { size != "small" }

    /// Top-right time-window picker: only meaningful on the overview chart
    /// (and never for the small family, which has no carousel).
    private var showsWindowPicker: Bool {
        carouselEnabled
            && (WidgetPage(rawValue: page) ?? .overview) == .overview
            && snapshot.preferences.enabled
            && snapshot.updatedAt != nil
            && snapshot.preferences.showChart
    }

    private var overviewPage: some View {
        VStack(alignment: .leading, spacing: size == "large" ? 12 : 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(WidgetSnapshot.number(snapshot.tokens))
                    .font(.system(size: size == "small" ? 30 : 34, weight: .semibold, design: .rounded))
                    .monospacedDigit().minimumScaleFactor(0.65).lineLimit(1)
                VStack(alignment: .leading, spacing: 1) {
                    Text(snapshot.preferences.period == "today" ? "tokens today" : "tokens all time")
                    if let cost = snapshot.cost, snapshot.preferences.showCost {
                        Text(String(format: "$%.2f tracked", cost))
                    } else if snapshot.requests > 0 {
                        Text("\(snapshot.requests) requests")
                    }
                }
                .font(.caption2).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            if size == "small" {
                if snapshot.preferences.showChart { providerStackBar }
            } else if snapshot.preferences.showChart {
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 5) {
                        statsLine
                        windowChart
                        providerLegend
                    }
                    .frame(width: size == "large" ? 156 : 132)
                    heatmapGrid(WidgetSnapshot.heatmapColumns(for: window, in: snapshot,
                                                              weeks: size == "large" ? 17 : 8,
                                                              large: size == "large"),
                                caption: heatmapCaption,
                                compact: size != "large")
                }
            }
        }
    }

    private var heatmapCaption: String {
        let weeks = size == "large" ? 17 : 8
        return WidgetWindow(rawValue: window) == .weeks
            ? "LAST \(weeks) WEEKS · DAILY"
            : (WidgetWindow(rawValue: window) ?? .days).caption
    }

    /// Compressed window summary: Σ total · per-bucket average · peak.
    private var statsLine: some View {
        let series = activeSeries
        let total = series.reduce(0) { $0 + $1.tokens }
        let peak = series.map(\.tokens).max() ?? 0
        let average = series.isEmpty ? 0 : total / series.count
        return Text("Σ\(WidgetSnapshot.number(total)) · ⌀\(WidgetSnapshot.number(average)) · ▲\(WidgetSnapshot.number(peak))")
            .font(.system(size: 8, weight: .medium, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    private var activeSeries: [WidgetSnapshot.DayTokens] {
        WidgetSnapshot.points(for: window, in: snapshot)
    }

    private var windowLabel: String {
        (WidgetWindow(rawValue: window) ?? .days).label
    }

    private var windowToggle: some View {
        HStack(spacing: 2) {
            Image(systemName: "clock")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.leading, 4)
            ForEach(WidgetWindow.allCases, id: \.self) { option in
                windowPill(option)
            }
        }
        .padding(2)
        .background(Capsule().fill(Color.white.opacity(0.07)))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
    }

    private func windowPill(_ option: WidgetWindow) -> some View {
        let active = window == option.rawValue
        let label = Text(option.label)
            .font(.system(size: 8.5, weight: .bold, design: .rounded))
            .foregroundStyle(active ? Color.black.opacity(0.85) : Color.white.opacity(0.55))
            .padding(.horizontal, 6).padding(.vertical, 2.5)
            .background(
                Capsule()
                    .fill(active ? accent : Color.clear)
                    .shadow(color: active ? accent.opacity(0.45) : .clear, radius: 2, y: 0.5)
            )
            .contentShape(Capsule())
        return Group {
            if let onWindowChange {
                Button { onWindowChange(option.rawValue) } label: { label }
            } else if let url = WidgetDeepLink.window(option.rawValue) {
                Link(destination: url) { label }
            } else {
                label
            }
        }
        .buttonStyle(.plain)
        .help("\(option.label.uppercased()) — \(option.helpText)")
        .accessibilityLabel("\(option.label) window: \(option.helpText)")
    }

    /// Stacked bars for the selected window (24 hours / 14 days / 17 weeks),
    /// provider-colored, newest bucket at full opacity.
    private var windowChart: some View {
        let series = activeSeries
        let maxTokens = max(1, series.map(\.tokens).max() ?? 1)
        let height: CGFloat = size == "large" ? 46 : 36
        return VStack(alignment: .leading, spacing: 3) {
            if series.isEmpty || series.allSatisfy({ $0.tokens == 0 }) {
                Text("No usage in window").font(.system(size: 9)).foregroundStyle(.secondary)
                    .frame(height: height, alignment: .center)
            } else {
                HStack(alignment: .bottom, spacing: 1) {
                    ForEach(Array(series.enumerated()), id: \.offset) { index, bucket in
                        VStack(spacing: 0) {
                            ForEach(Array(sortedProviders(bucket).enumerated()), id: \.offset) { _, entry in
                                let segment = bucket.tokens > 0 ? CGFloat(entry.1) / CGFloat(bucket.tokens) : 0
                                Self.providerColor(entry.0)
                                    .frame(height: max(1, height * CGFloat(bucket.tokens) / CGFloat(maxTokens) * segment))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .bottom)
                        .opacity(index == series.count - 1 ? 1 : 0.6)
                        .accessibilityLabel("\(bucket.tokens) tokens")
                    }
                }
                .frame(height: height, alignment: .bottom)
                .clipShape(RoundedRectangle(cornerRadius: 3))
                Text((WidgetWindow(rawValue: window) ?? .days).caption)
                    .font(.system(size: 8, weight: .semibold)).foregroundStyle(.secondary)
                    .lineLimit(1).minimumScaleFactor(0.8)
                    .help("\(WidgetSnapshot.number(series.reduce(0) { $0 + $1.tokens })) tokens · \((WidgetWindow(rawValue: window) ?? .days).helpText)")
            }
        }
    }

    /// Legend doubles as the aggregated per-provider summary for the window
    /// (brand mark = color key, value = tokens, pct = share). Bounded rows.
    private var providerLegend: some View {
        let entries = WidgetSnapshot.aggregateByProvider(days: activeSeries, limit: size == "large" ? 5 : 3)
        let total = max(1, entries.reduce(0) { $0 + $1.tokens })
        return VStack(alignment: .leading, spacing: 3) {
            ForEach(entries, id: \.provider) { entry in
                let share = Int(Double(entry.tokens) / Double(total) * 100)
                HStack(spacing: 5) {
                    ProviderLogoView(provider: entry.provider, size: size == "large" ? 12 : 11)
                    Text(entry.provider)
                        .font(.system(size: 8.5, weight: .medium))
                        .lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 2)
                    Text(WidgetSnapshot.number(entry.tokens))
                        .font(.system(size: 8, weight: .semibold, design: .rounded)).monospacedDigit()
                    Text("\(share)%")
                        .font(.system(size: 7.5)).monospacedDigit()
                        .foregroundStyle(.secondary.opacity(0.8))
                        .frame(width: 24, alignment: .trailing)
                }
                .help("\(entry.provider): \(entry.tokens) tokens · \(share)% of this window")
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(entry.provider), \(WidgetSnapshot.number(entry.tokens)) tokens, \(share) percent of window")
            }
            if entries.isEmpty {
                Text("No usage yet").font(.system(size: 8.5)).foregroundStyle(.secondary)
            }
        }
    }

    private func sortedProviders(_ bucket: WidgetSnapshot.DayTokens) -> [(String, Int)] {
        bucket.byProvider.sorted {
            if $0.value == $1.value { return $0.key < $1.key }
            return $0.value > $1.value
        }.map { ($0.key, $0.value) }
    }

    /// Small-size fallback: one horizontal stacked bar, provider-colored.
    private var providerStackBar: some View {
        let entries = WidgetSnapshot.aggregateByProvider(days: snapshot.days, limit: 6)
        let total = max(1, entries.reduce(0) { $0 + $1.tokens })
        return VStack(alignment: .leading, spacing: 3) {
            GeometryReader { geo in
                HStack(spacing: 1) {
                    ForEach(entries, id: \.provider) { entry in
                        Self.providerColor(entry.provider)
                            .frame(width: max(1, geo.size.width * CGFloat(entry.tokens) / CGFloat(total)))
                    }
                }
            }
            .frame(height: 10)
            .clipShape(Capsule())
            Text("BY PROVIDER · 7D").font(.system(size: 8, weight: .semibold)).foregroundStyle(.secondary)
        }
    }

    private var limitsPage: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Plan limits").font(.system(size: 13, weight: .semibold))
            if snapshot.limits.isEmpty {
                Text("No plan limits available").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(Array(snapshot.limits.prefix(size == "large" ? 5 : 3))) { limit in
                    limitRow(limit, showReset: true)
                }
            }
        }
    }

    /// Plans & expiry: what the user has and what resets/expires soonest.
    /// Row styling mirrors the notch app (urgency thresholds <24h / <48h).
    private var plansPage: some View {
        let rows = Array(snapshot.limits.prefix(size == "large" ? 6 : 4))
        let now = Date()
        let urgentCount = snapshot.limits.filter { $0.urgency(at: now) == "urgent" }.count
        return VStack(alignment: .leading, spacing: size == "large" ? 9 : 7) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("Plans & resets").font(.system(size: 13, weight: .semibold))
                if urgentCount > 0 {
                    Text("\(urgentCount) <24h")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5).padding(.vertical, 1.5)
                        .background(Capsule().fill(Color.red.opacity(0.75)))
                }
                Spacer(minLength: 4)
                Text("\(snapshot.limits.count) active").font(.system(size: 9)).foregroundStyle(.secondary)
            }
            if let next = rows.first(where: { $0.resetsAt != nil }) {
                planCallout(next)
            }
            if rows.isEmpty {
                Text("No plan limits available").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(rows) { limit in
                    planRow(limit, showDetail: size == "large")
                }
            }
        }
    }

    /// Spotlight card for the soonest-expiring plan: brand mark, countdown,
    /// usage bar and a truncated detail line — all compressed.
    private func planCallout(_ limit: WidgetSnapshot.Limit) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                ProviderLogoView(provider: limit.provider, size: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text("NEXT RESET").font(.system(size: 7.5, weight: .bold)).foregroundStyle(.secondary)
                    Text("\(limit.provider) · \(limit.label)")
                        .font(.system(size: 11, weight: .semibold)).lineLimit(1)
                }
                Spacer(minLength: 2)
                VStack(alignment: .trailing, spacing: 1) {
                    if let resets = limit.resetsAt {
                        Text(WidgetSnapshot.resetText(resets))
                            .font(.system(size: 13, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(urgencyColor(limit))
                    }
                    Text("\(Int(limit.usedPercent))% used")
                        .font(.system(size: 8)).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            ProgressView(value: limit.usedPercent, total: 100)
                .tint(urgencyColor(limit))
            if !limit.detail.isEmpty {
                Text(limit.detail)
                    .font(.system(size: 7.5)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
        }
        .padding(7)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.06)))
        .help(planTooltip(limit))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Next reset: " + planTooltip(limit))
    }

    private func planRow(_ limit: WidgetSnapshot.Limit, showDetail: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                ProviderLogoView(provider: limit.provider, size: 12)
                Text("\(limit.provider) · \(limit.label)")
                    .font(.system(size: 10, weight: .medium)).lineLimit(1)
                if showDetail, !limit.detail.isEmpty {
                    Text(limit.detail)
                        .font(.system(size: 7.5)).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 2)
                if let resets = limit.resetsAt {
                    Text(WidgetSnapshot.resetText(resets))
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(urgencyColor(limit))
                }
                Text("\(Int(limit.usedPercent))%")
                    .font(.system(size: 9)).monospacedDigit().foregroundStyle(.secondary)
                    .frame(width: 26, alignment: .trailing)
            }
            ProgressView(value: limit.usedPercent, total: 100)
                .tint(limit.usedPercent >= 90 ? .orange : Self.providerColor(limit.provider))
        }
        .help(planTooltip(limit))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(planTooltip(limit))
    }

    private func planTooltip(_ limit: WidgetSnapshot.Limit) -> String {
        var parts = ["\(limit.provider) \(limit.label): \(Int(limit.usedPercent))% used"]
        if let resets = limit.resetsAt {
            parts.append("resets in \(WidgetSnapshot.resetText(resets))")
        }
        if !limit.detail.isEmpty {
            parts.append(limit.detail)
        }
        return parts.joined(separator: " · ")
    }

    private func urgencyColor(_ limit: WidgetSnapshot.Limit) -> Color {
        switch limit.urgency() {
        case "urgent": return .red
        case "soon": return .orange
        default: return Self.providerColor(limit.provider)
        }
    }

    private func limitRow(_ limit: WidgetSnapshot.Limit, showReset: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                ProviderLogoView(provider: limit.provider, size: 12)
                Text("\(limit.provider) · \(limit.label)").lineLimit(1)
                Spacer(minLength: 2)
                if showReset, let resets = limit.resetsAt {
                    Text(resets, style: .relative).lineLimit(1)
                }
                Text("\(Int(limit.usedPercent))%").monospacedDigit()
            }.font(.system(size: 10))
            ProgressView(value: limit.usedPercent, total: 100)
                .tint(limit.usedPercent >= 90 ? .orange : Self.providerColor(limit.provider))
        }
    }

    private var chrome: some View {
        HStack(spacing: 6) {
            if carouselEnabled { pageButton(delta: -1, systemImage: "chevron.left") }
            Circle().fill(offline || snapshot.isStale(at: date) ? Color.orange : accent).frame(width: 5, height: 5)
            if let updated = snapshot.updatedAt {
                Text(offline ? "Offline ·" : snapshot.isStale(at: date) ? "Last update" : "Updated")
                Text(updated, style: .time)
            }
            Spacer(minLength: 0)
            if carouselEnabled {
                HStack(spacing: 3) {
                    ForEach(0..<WidgetPage.count, id: \.self) { index in
                        Circle()
                            .fill(index == page ? accent : Color.white.opacity(0.25))
                            .frame(width: 4, height: 4)
                    }
                }
                pageButton(delta: 1, systemImage: "chevron.right")
            }
        }
        .font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
    }

    private func pageButton(delta: Int, systemImage: String) -> some View {
        let icon = Image(systemName: systemImage)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.secondary)
            .frame(width: 22, height: 22)
            .background(Circle().fill(Color.white.opacity(0.08)))
        return Group {
            if let onPageChange {
                Button { onPageChange(WidgetPage.cycled(page, delta: delta)) } label: { icon }
            } else if let url = WidgetDeepLink.page(delta) {
                Link(destination: url) { icon }
            } else {
                icon
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(delta > 0 ? "Next view" : "Previous view")
    }

    private func heatmapGrid(_ columns: [[Int]], caption: String, compact: Bool = false) -> some View {
        let maxTokens = max(1, columns.flatMap { $0 }.max() ?? 1)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 3) {
                ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                    VStack(spacing: 3) {
                        ForEach(Array(column.enumerated()), id: \.offset) { _, tokens in
                            RoundedRectangle(cornerRadius: 2.5)
                                .fill(heatColor(tokens: tokens, maxTokens: maxTokens))
                                .frame(maxWidth: .infinity)
                                .aspectRatio(1, contentMode: .fit)
                                .accessibilityLabel("\(tokens) tokens")
                        }
                    }
                }
            }
            HStack {
                Text(caption)
                Spacer()
                if !compact {
                    Text("Less")
                    ForEach([0.0, 0.25, 0.5, 0.75, 1.0], id: \.self) { level in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(level == 0 ? Color.white.opacity(0.08) : accent.opacity(0.25 + 0.75 * level))
                            .frame(width: 8, height: 8)
                    }
                    Text("More")
                }
            }
            .font(.system(size: 8, weight: .medium)).foregroundStyle(.secondary)
        }
    }

    private func heatColor(tokens: Int, maxTokens: Int) -> Color {
        guard tokens > 0 else { return Color.white.opacity(0.08) }
        let level = Double(tokens) / Double(maxTokens)
        switch level {
        case ..<0.25: return accent.opacity(0.35)
        case ..<0.5: return accent.opacity(0.55)
        case ..<0.75: return accent.opacity(0.8)
        default: return accent
        }
    }
}
