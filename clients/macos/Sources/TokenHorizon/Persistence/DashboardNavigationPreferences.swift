import Foundation

/// Ordered navigation shortcuts shared by the notch, popover and dashboard.
/// Persist enum identifiers rather than visible labels so a title change does
/// not reset a user's pins. Unpinned (including newly added) tabs remain in More.
struct DashboardNavigationPreferences: Codable, Equatable {
    private(set) var pinnedTabIDs: [String]

    init(pinnedTabs: [DashboardTab] = DashboardTab.quickTabs) {
        self.init(pinnedTabIDs: pinnedTabs.map(\.rawValue))
    }

    init(pinnedTabIDs: [String]) {
        var seen = Set<String>()
        self.pinnedTabIDs = pinnedTabIDs.compactMap { identifier in
            let identifier = identifier.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            guard let tab = DashboardTab(rawValue: identifier), seen.insert(tab.rawValue).inserted else { return nil }
            return tab.rawValue
        }
    }

    var pinnedTabs: [DashboardTab] { pinnedTabIDs.compactMap(DashboardTab.init(rawValue:)) }

    var unpinnedTabs: [DashboardTab] { DashboardTab.allCases.filter { !isPinned($0) } }

    var normalized: DashboardNavigationPreferences { DashboardNavigationPreferences(pinnedTabIDs: pinnedTabIDs) }

    func isPinned(_ tab: DashboardTab) -> Bool { pinnedTabIDs.contains(tab.rawValue) }

    mutating func setPinned(_ tab: DashboardTab, pinned: Bool) {
        if pinned {
            if !isPinned(tab) { pinnedTabIDs.append(tab.rawValue) }
        } else {
            pinnedTabIDs.removeAll { $0 == tab.rawValue }
        }
    }

    /// Moves a pin one or more positions, clamping at either end.
    mutating func move(_ tab: DashboardTab, offset: Int) {
        guard let index = pinnedTabIDs.firstIndex(of: tab.rawValue), offset != 0 else { return }
        // Clamp before adding, so even a malformed caller offset cannot overflow.
        let destination = index + min(max(offset, -index), pinnedTabIDs.count - index - 1)
        guard destination != index else { return }
        pinnedTabIDs.remove(at: index)
        pinnedTabIDs.insert(tab.rawValue, at: destination)
    }

    private enum CodingKeys: String, CodingKey { case pinnedTabIDs }

    init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: CodingKeys.self),
              let identifiers = try? container.decode([String].self, forKey: .pinnedTabIDs) else {
            self.init()
            return
        }
        self.init(pinnedTabIDs: identifiers)
    }
}
