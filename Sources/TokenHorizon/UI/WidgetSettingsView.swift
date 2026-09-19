import SwiftUI
import WidgetKit

struct WidgetSettingsView: View {
    @ObservedObject var model: UIModel
    @State private var preferences = SettingsStore.shared.widgetPreferences
    @State private var previewSize = "medium"
    @State private var previewPage = 0
    @State private var reloadRequested = false

    private var preview: WidgetSnapshot {
        WidgetBridge.makeSnapshot(usage: model.usage, history: model.historyPoints,
                                  hourly: model.hourTrendPoints,
                                  limits: model.planLimits + model.kimiLimits + model.usage.limits,
                                  preferences: preferences)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Desktop widget", systemImage: "rectangle.3.group")
                .font(.system(size: 14, weight: .semibold))
            Text("Your usage alongside Weather, Calendar and your other widgets.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            Picker("Preview size", selection: $previewSize) {
                Text("Small").tag("small")
                Text("Medium").tag("medium")
                Text("Large").tag("large")
            }.pickerStyle(.segmented)
            WidgetCard(snapshot: preview, size: previewSize, page: previewPage,
                       onPageChange: { previewPage = $0 },
                       window: preferences.window,
                       onWindowChange: { preferences.window = $0 })
                .padding(16)
                .frame(width: previewSize == "small" ? 170 : nil,
                       height: previewSize == "large" ? 340 : 175)
                .background(RoundedRectangle(cornerRadius: 20).fill(Color.white.opacity(0.06)))
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.white.opacity(0.12)))
                .frame(maxWidth: .infinity)
                .accessibilityLabel("Widget preview")
            Toggle("Show usage in widgets", isOn: $preferences.enabled)
            Group {
                Picker("Token total", selection: $preferences.period) {
                    Text("Today").tag("today")
                    Text("All time").tag("all")
                }
                Picker("Accent", selection: $preferences.accent) {
                    Text("Cyan").tag("cyan")
                    Text("Violet").tag("violet")
                    Text("Green").tag("green")
                    Text("Orange").tag("orange")
                }
                Toggle("Show tracked cost", isOn: $preferences.showCost)
                Toggle("Show plan limits", isOn: $preferences.showLimits)
                Toggle("Show seven-day activity", isOn: $preferences.showChart)
            }.disabled(!preferences.enabled)
            Divider()
            Text("Add it: right-click your desktop → Edit Widgets → Token Horizon. Choose a size and drag it onto your desktop or Notification Center.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button(reloadRequested ? "Refresh requested" : "Refresh widgets") {
                    WidgetCenter.shared.reloadTimelines(ofKind: WidgetSnapshot.kind)
                    reloadRequested = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { reloadRequested = false }
                }.disabled(reloadRequested)
                Spacer()
                Text("macOS 14+").font(.caption).foregroundStyle(.secondary)
            }
            Text("Settings apply to all Token Horizon widgets. macOS controls refresh timing; "
                 + "keep the app running for updates. Offline widgets show their last snapshot. "
                 + "Pausing or hiding cost takes effect on the next widget refresh.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: 12))
        .toggleStyle(.switch).tint(.cyan)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.035)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.white.opacity(0.08)))
        .onAppear { preferences = SettingsStore.shared.widgetPreferences }
        .onChange(of: preferences) { SettingsStore.shared.widgetPreferences = $0 }
        .onReceive(NotificationCenter.default.publisher(for: .tokenHorizonWidgetDidChange)) { _ in
            let saved = SettingsStore.shared.widgetPreferences
            if saved != preferences { preferences = saved }
        }
    }
}
