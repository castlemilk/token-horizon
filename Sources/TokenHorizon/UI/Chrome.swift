import SwiftUI

struct MonospacedText: View {
    let text: String
    let color: Color
    var size: CGFloat = 11
    var body: some View {
        Text(text).font(.system(size: size, weight: .medium, design: .monospaced)).foregroundStyle(color).lineLimit(1)
    }
}

struct NotchContentView: View {
    @ObservedObject var model: UIModel
    let geometry: NotchPanel.Geometry
    var body: some View {
        if model.notchExpanded {
            DashboardTabs(model: model, compact: true)
                .padding(.top, geometry.topInset + 8).padding(.bottom, 14).padding(.horizontal, 16)
                .frame(maxHeight: .infinity, alignment: .top)
        } else {
            let cpuPct = model.sys.cpuPercent
            let ramPct = model.sys.ramUsedGB / max(model.sys.ramTotalGB, 1) * 100
            HStack(spacing: 0) {
                WingRingGauge(percent: cpuPct, color: .red, help: "CPU")
                    .frame(width: geometry.wing, alignment: .trailing).padding(.trailing, 2)
                Color.clear.frame(width: geometry.notchWidth)
                WingRingGauge(percent: ramPct, color: .cyan, help: "Memory")
                    .frame(width: geometry.wing, alignment: .leading).padding(.leading, 2)
            }
            .frame(height: geometry.topInset)
        }
    }
}

enum DashboardTab: String, CaseIterable, Identifiable {
    case activity = "ACTIVITY", mlx = "MLX", engine = "ENGINE", tokens = "TOKENS", traces = "TRACES", models = "MODELS", shells = "SHELLS", leaderboard = "LEADERBOARD", settings = "SETTINGS"
    var id: String { rawValue }

    /// SF Symbol shown on every pill; the text label only renders on the
    /// selected tab, so the bar stays single-line in narrow popovers.
    var icon: String {
        switch self {
        case .activity: return "waveform.path.ecg"
        case .mlx: return "memorychip"
        case .engine: return "bolt.fill"
        case .tokens: return "number"
        case .traces: return "point.3.connected.trianglepath.dotted"
        case .models: return "cube"
        case .shells: return "terminal"
        case .leaderboard: return "trophy"
        case .settings: return "gearshape"
        }
    }
}

