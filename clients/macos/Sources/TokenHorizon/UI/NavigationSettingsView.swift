import SwiftUI

/// The same saved shortcuts are used by the notch, menu bar and dashboard.
struct NavigationSettingsView: View {
    @Binding var preferences: DashboardNavigationPreferences

    private var orderedTabs: [DashboardTab] {
        preferences.pinnedTabs + preferences.unpinnedTabs
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Choose which tabs stay in your navigation. Use the arrows to change their order. Other tabs remain in More.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(orderedTabs) { destination in
                HStack(spacing: 8) {
                    Toggle(isOn: Binding(
                        get: { preferences.isPinned(destination) },
                        set: { preferences.setPinned(destination, pinned: $0) })) {
                        Label(destination.title, systemImage: destination.icon)
                    }
                    .toggleStyle(.checkbox)
                    .accessibilityLabel("Pin \(destination.title)")
                    Spacer(minLength: 8)
                    if let index = preferences.pinnedTabs.firstIndex(of: destination) {
                        moveButton(destination, offset: -1, enabled: index > 0)
                        moveButton(destination, offset: 1, enabled: index < preferences.pinnedTabs.count - 1)
                    } else {
                        Text("In More").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(minHeight: 28)
            }
            Divider().overlay(Color.white.opacity(0.08))
            HStack {
                Button("Reset to defaults") { preferences = DashboardNavigationPreferences() }
                    .disabled(preferences == DashboardNavigationPreferences())
                Spacer()
                Text("Saved automatically").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func moveButton(_ destination: DashboardTab, offset: Int, enabled: Bool) -> some View {
        Button { preferences.move(destination, offset: offset) } label: {
            Image(systemName: offset < 0 ? "chevron.up" : "chevron.down")
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel("Move \(destination.title) \(offset < 0 ? "earlier" : "later")")
        .help(offset < 0 ? "Move earlier" : "Move later")
    }
}
