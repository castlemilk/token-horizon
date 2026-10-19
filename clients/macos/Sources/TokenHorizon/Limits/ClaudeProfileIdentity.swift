import Foundation

/// Profile boundaries shared by metadata, credentials and quota row identity.
/// Custom homes must never borrow the default profile's account or token.
enum ClaudeProfileIdentity {
    static func metadataPaths(for dir: String, home: String = NSHomeDirectory()) -> [String] {
        let profile = expandedPath(dir, home: home)
        let root = expandedPath(home, home: home)
        let ownMetadata = "\(profile)/.claude.json"
        return profile == "\(root)/.claude"
            ? ["\(root)/.claude.json", ownMetadata]
            : [ownMetadata]
    }

    static func keychainServices(for dir: String, home: String = NSHomeDirectory()) -> [String] {
        let profile = expandedPath(dir, home: home)
        let root = expandedPath(home, home: home)
        let scoped = "Claude Code-credentials-\(ClaudeDiscovery.sha256Prefix8(profile))"
        return profile == "\(root)/.claude"
            ? ["Claude Code-credentials", scoped]
            : [scoped]
    }

    static func profileID(for dir: String, home: String = NSHomeDirectory()) -> String {
        let profile = expandedPath(dir, home: home)
        let root = expandedPath(home, home: home)
        let base = (profile as NSString).lastPathComponent
        let name = base.hasPrefix(".") ? String(base.dropFirst()) : base

        // Preserve existing identifiers for ordinary ~/.claude* profiles.
        // A basename alone cannot identify nested/custom homes: both
        // ~/.claude and ~/.config/claude otherwise become "claude".
        if (profile as NSString).deletingLastPathComponent == root,
           base.hasPrefix(".claude") {
            return name
        }
        return "\(name.isEmpty ? "claude" : name)-\(ClaudeDiscovery.sha256Prefix8(profile))"
    }

    static func providerNames(for accounts: [ClaudeAccount]) -> [String: String] {
        guard accounts.count > 1 else {
            return accounts.first.map { [$0.configDir: "claude"] } ?? [:]
        }

        let labels = accounts.map { $0.label.isEmpty ? $0.id : $0.label }
        let labelCounts = Dictionary(grouping: labels, by: { $0 }).mapValues(\.count)
        var names: [String: String] = [:]
        for (account, label) in zip(accounts, labels) {
            let id = account.id.isEmpty ? profileID(for: account.configDir) : account.id
            let display = (labelCounts[label] ?? 0) > 1 ? "\(label) · \(id)" : label
            names[account.configDir] = "claude (\(display))"
        }

        // Also cover old/custom account IDs that collide, or a literal label
        // that happens to match a disambiguated display label. Provider is
        // the UI grouping key, so distinct directories must stay distinct.
        let nameCounts = Dictionary(grouping: Array(names.values), by: { $0 }).mapValues(\.count)
        for account in accounts {
            guard let name = names[account.configDir], (nameCounts[name] ?? 0) > 1 else { continue }
            let suffix = ClaudeDiscovery.sha256Prefix8(expandedPath(account.configDir, home: NSHomeDirectory()))
            names[account.configDir] = String(name.dropLast()) + " · \(suffix))"
        }
        return names
    }

    /// Lexical normalization only; profile identity must not depend on
    /// whether a directory exists or resolve a symlink into another profile.
    private static func expandedPath(_ path: String, home: String) -> String {
        let expanded: String
        if path == "~" {
            expanded = home
        } else if path.hasPrefix("~/") {
            expanded = home + String(path.dropFirst())
        } else {
            expanded = path
        }
        return URL(fileURLWithPath: expanded).standardizedFileURL.path
    }
}
