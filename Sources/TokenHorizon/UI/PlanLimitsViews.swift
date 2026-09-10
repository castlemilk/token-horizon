import SwiftUI

struct UnifiedPlanRow: Identifiable {
    let id: String
    let provider: String
    let logoProvider: String
    let displayName: String
    let subtitle: String
    let burstLimit: ProviderLimit?
    let cycleLimit: ProviderLimit?
    let extraLimit: ProviderLimit?
}

/// Styled hover card for a Plan Limits row. Replaces the native `.help()`
/// tooltip (which never fires in the non-activating notch panel) with the
/// same custom-bubble pattern as the heatmap cards: provider header, one
/// section per quota window with bar + headroom + reset, model-scoped quotas
/// (Fable) highlighted, urgency footer.
struct PlanLimitCard: View {
    let row: UnifiedPlanRow

    /// Card section title for the `extra` slot: scoped quotas show the model
    /// name ("weekly · Fable" → "FABLE"), everything else is "EXTRA".
    static func extraTitle(_ limit: ProviderLimit) -> String {
        limit.label.contains("·") ? DashboardTabs.scopedModelName(limit.label).uppercased() : "EXTRA"
    }

    /// Estimated card height for the current row's content. Mirrors the body
    /// layout constants below (header + one compact block per window +
    /// optional urgency footer + padding + safety margin). Used to decide
    /// whether the card fits below the hovered row or must flip above it.
    static func estimatedHeight(for row: UnifiedPlanRow) -> CGFloat {
        let blocks = [row.burstLimit, row.cycleLimit, row.extraLimit].compactMap { $0 }.count
        let footer: CGFloat = {
            guard let r = row.cycleLimit?.resetsAt else { return 0 }
            return (r.timeIntervalSinceNow > 0 && r.timeIntervalSinceNow < 86_400) ? 35 : 0
        }()
        // padding 10+10, header 22, spacings 7/7, divider 1, each windowLine
        // 50 (16+4+16 content + 14 padding) with 7 between, footer, +12 margin.
        return 10 + 22 + 7 + 1 + 7 + CGFloat(blocks) * 50 + CGFloat(max(blocks - 1, 0)) * 7 + footer + 10 + 12
    }

    /// True when the card fits below the row inside the visible scroll
    /// viewport; otherwise it renders above the row. Pure function of the
    /// row's visible frame so the popout never clips outside the scroll view.
    static func showsBelow(rowTop: CGFloat, rowBottom: CGFloat, viewportH: CGFloat, row: UnifiedPlanRow) -> Bool {
        let need = estimatedHeight(for: row)
        let spaceBelow = viewportH - rowBottom
        return spaceBelow >= need || spaceBelow >= rowTop
    }

    private var isUrgent: Bool {
        (row.cycleLimit?.resetsAt?.timeIntervalSinceNow ?? .infinity) < 86_400
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                ProviderLogoView(provider: row.logoProvider, size: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.displayName)
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundStyle(.white)
                    if !row.subtitle.isEmpty {
                        Text(row.subtitle)
                            .font(.system(size: 8, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.55))
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                if isUrgent {
                    Text("RESET SOON")
                        .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(Capsule().fill(Color.orange))
                }
            }
            Divider().overlay(Color.white.opacity(0.12))
            if let b = row.burstLimit {
                windowLine(title: "BURST · \(b.label.uppercased())", limit: b, tint: .cyan, glow: false)
            }
            if let c = row.cycleLimit {
                windowLine(title: "CYCLE · \(c.label.uppercased())", limit: c, tint: .green, glow: false)
            }
            if let x = row.extraLimit {
                let scoped = x.label.contains("·")
                windowLine(title: Self.extraTitle(x), limit: x,
                           tint: scoped ? .orange : .purple, glow: scoped)
            }
            if let r = row.cycleLimit?.resetsAt,
               r.timeIntervalSinceNow > 0 && r.timeIntervalSinceNow < 86_400 {
                HStack(spacing: 4) {
                    Image(systemName: "flame.fill")
                        .font(.system(size: 7))
                        .foregroundStyle(Color.orange)
                    Text("Resets in \(DashboardTabs.formatReset(r)) — prioritize usage on this profile.")
                        .font(.system(size: 7.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color.orange)
                }
                .padding(.horizontal, 6).padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.orange.opacity(0.12)))
            }
        }
        .padding(10)
        .frame(width: 254, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.97))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.white.opacity(0.18))))
        .shadow(color: .black.opacity(0.5), radius: 8, y: 3)
    }

    /// One compact quota-window line: tinted title + reset text on top,
    /// usage bar with used% and headroom below. Fixed ~40pt tall so
    /// `estimatedHeight` stays accurate.
    private func windowLine(title: String, limit: ProviderLimit, tint: Color, glow: Bool) -> some View {
        let used = limit.usedPercent
        let barColor: Color = used >= 100 ? .red : used >= 85 ? .orange : tint
        let resetText: String = {
            guard let r = limit.resetsAt else { return "no reset scheduled" }
            let f = DashboardTabs.formatReset(r)
            return f == "now" ? "resets now" : "resets in \(f)"
        }()
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text(title)
                    .font(.system(size: 7, weight: .heavy, design: .monospaced))
                    .foregroundStyle(tint)
                if limit.detail.localizedCaseInsensitiveContains("rate-limited") {
                    Text("RATE LIMITED")
                        .font(.system(size: 6, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(Capsule().fill(Color.red))
                }
                Spacer(minLength: 4)
                Text(resetText)
                    .font(.system(size: 7, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.5))
            }
            .frame(height: 16)
            HStack(spacing: 6) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.12))
                        Capsule().fill(barColor)
                            .frame(width: max(3, geo.size.width * CGFloat(min(used, 100) / 100)))
                    }
                }
                .frame(height: 5)
                Text("\(Int(used))%")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(used >= 85 ? barColor : .white)
                    .frame(width: 30, alignment: .trailing)
                Text("· \(String(format: "%.0f%%", limit.remainingPercent)) left")
                    .font(.system(size: 7.5, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.5))
            }
            .frame(height: 16)
        }
        .padding(7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(glow ? tint.opacity(0.10) : Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(glow ? tint.opacity(0.4) : Color.white.opacity(0.07), lineWidth: 0.75))
    }
}

