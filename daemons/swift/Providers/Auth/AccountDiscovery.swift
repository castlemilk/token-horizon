import Foundation

/// Multi-account discovery via files: many vendors keep one credentials file
/// per profile (e.g. `~/.claude*` variant dirs, `~/.kimi-code` +
/// `~/.kimi`). The network-level request meters deliberately stay
/// account-agnostic (per-request measurement needs no identity) — profiles
/// matter for quota fetching and file tailing, both of which are keyed by
/// credential/profile label.
///
/// Conventions:
/// - `variantDirs(prefixes:envVars:)` finds `$HOME/<prefix>*` directories
///   (plus any env override): each directory is one account profile.
/// - `deriveLabel(dir:email:)` turns a directory/email into a short label
///   (`work`, `gmail-user`, …) used in limit rows when >1 profile exists.
public enum AccountDiscovery {
    /// Candidate profile directories: env override first, then
    /// `$HOME` entries matching any prefix (sorted for determinism).
    public static func variantDirs(prefixes: [String], envVars: [String] = []) -> [String] {
        for env in envVars {
            if let dir = ProcessInfo.processInfo.environment[env],
               !dir.trimmingCharacters(in: .whitespaces).isEmpty,
               FileManager.default.fileExists(atPath: dir) {
                return [dir]
            }
        }
        let home = Platform.paths.homeDirectory.path
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: home) else {
            return []
        }
        var out: [String] = []
        for entry in entries {
            for prefix in prefixes where entry == prefix || entry.hasPrefix(prefix + ".") || entry.hasPrefix(prefix + "-") || entry.hasPrefix(prefix + "_") {
                let full = home + "/" + entry
                var isDir: ObjCBool = false
                if FileManager.default.fileExists(atPath: full, isDirectory: &isDir), isDir.boolValue {
                    out.append(full)
                }
            }
        }
        return out.sorted()
    }

    /// Short human label for a profile directory (+ optional account email).
    public static func deriveLabel(dir: String, email: String = "") -> String {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, let atIdx = trimmed.firstIndex(of: "@") {
            let user = String(trimmed[..<atIdx])
            let domain = String(trimmed[trimmed.index(after: atIdx)...]).lowercased()
            if let primary = domain.split(separator: ".").first {
                let s = String(primary)
                if ["gmail", "outlook", "icloud", "proton"].contains(s) {
                    return user.isEmpty ? s : user
                }
                return s
            }
        }
        let base = (dir as NSString).lastPathComponent
        let stripped = base.hasPrefix(".") ? String(base.dropFirst()) : base
        if let dash = stripped.firstIndex(of: ".") {
            return String(stripped[stripped.index(after: dash)...])
        }
        if let dash = stripped.firstIndex(of: "-") {
            return String(stripped[stripped.index(after: dash)...])
        }
        return stripped
    }
}
