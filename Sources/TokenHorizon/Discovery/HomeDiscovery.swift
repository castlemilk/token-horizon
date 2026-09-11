import Foundation

/// Shared auto-discovery for provider config homes under `~/.*`.
///
/// Several providers support multiple local profiles via suffixed dot-dirs
/// (`~/.claude`, `~/.claude-1`, `~/.claude-personal`, ...). Rather than each
/// engine hand-rolling its own glob, all variant discovery goes through here:
/// env override → explicit defaults → `~/<prefix>*` glob → `~/.config/<name>`,
/// deduped, default-first. The `$HOME` top-level listing is cached for 30s so
/// the per-poll `collectLocked()` / limit-refresh paths stay cheap (one
/// readdir per TTL window shared by all providers; per call is just a few
/// `stat`s).
///
/// Testability: every entry point takes an optional explicit `home` (used by
/// tests with a temp dir). `nil` means the real `$HOME` with caching.
enum HomeDiscovery {
    private static let lock = NSLock()
    private static var cachedHome = ""
    private static var cachedEntries: [String] = []
    private static var cachedAt = Date.distantPast
    private static let cacheTTL: TimeInterval = 30

    static func expand(_ path: String) -> String {
        NSString(string: path).expandingTildeInPath
    }

    static func isDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }

    /// Top-level entry names of `home` (default: real `$HOME`). Cached 30s
    /// for the real home only; explicit homes always list fresh (tests).
    static func homeEntries(home: String? = nil) -> [String] {
        let dir = home ?? NSHomeDirectory()
        if home == nil {
            lock.lock()
            let hit = cachedHome == dir && Date().timeIntervalSince(cachedAt) <= cacheTTL
            let entries = hit ? cachedEntries : nil
            lock.unlock()
            if let entries { return entries }
        }
        let items = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        if home == nil {
            lock.lock()
            cachedHome = dir
            cachedEntries = items
            cachedAt = Date()
            lock.unlock()
        }
        return items
    }

    static func resetCache() {
        lock.lock()
        cachedHome = ""
        cachedEntries = []
        cachedAt = .distantPast
        lock.unlock()
    }

    /// All config-home variants for a provider family.
    ///
    /// - `prefixes`: dot-dir prefixes, e.g. `[".claude"]` matches
    ///   `.claude`, `.claude-1`, `.claude-personal` (directories only —
    ///   sibling files like `.claude.json` are ignored).
    /// - `envVars`: env names checked first (tilde-expanded, must exist).
    /// - `defaultPaths`: canonical homes, e.g. `["~/.claude"]`.
    /// - `configNames`: also checked under `~/.config/`.
    static func variantDirs(
        prefixes: [String],
        envVars: [String] = [],
        defaultPaths: [String] = [],
        configNames: [String] = [],
        home: String? = nil
    ) -> [String] {
        var out: [String] = []
        func add(_ path: String) {
            let exp = expand(path)
            guard !exp.isEmpty, !out.contains(exp), isDirectory(exp) else { return }
            out.append(exp)
        }
        let env = ProcessInfo.processInfo.environment
        for v in envVars {
            if let val = env[v]?.trimmingCharacters(in: .whitespacesAndNewlines), !val.isEmpty {
                add(val)
            }
        }
        for d in defaultPaths { add(d) }
        let root = home ?? NSHomeDirectory()
        for item in homeEntries(home: home) {
            guard prefixes.contains(where: { item.hasPrefix($0) }) else { continue }
            add("\(root)/\(item)")
        }
        if !configNames.isEmpty {
            let configRoot = expand("~/.config")
            for name in configNames { add("\(configRoot)/\(name)") }
        }
        let primary = defaultPaths.first.map(expand)
        out.sort {
            if $0 == primary { return true }
            if $1 == primary { return false }
            return $0 < $1
        }
        return out
    }

    /// Expand variant homes with relative `subpaths`, keeping existing dirs only.
    static func scanDirs(_ variants: [String], subpaths: [String]) -> [String] {
        var out: [String] = []
        for base in variants {
            for sub in subpaths {
                let full = "\(base)/\(sub)"
                if !out.contains(full), isDirectory(full) { out.append(full) }
            }
        }
        return out
    }

    /// First existing file at `<variant>/<relative>` across variant homes.
    static func firstFile(in variants: [String], relative: String) -> String? {
        for base in variants {
            let full = "\(base)/\(relative)"
            if FileManager.default.fileExists(atPath: full) { return full }
        }
        return nil
    }

    // MARK: - Provider-specific candidates

    /// opencode `auth.json` locations, in priority order. The historical
    /// default stays first; extras are fallbacks tried only when earlier
    /// candidates are missing or unparseable.
    static func opencodeAuthCandidates() -> [String] {
        var out: [String] = []
        if let env = ProcessInfo.processInfo.environment["OPENCODE_AUTH"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !env.isEmpty {
            out.append(env)
        }
        out += ["~/.local/share/opencode/auth.json", "~/.config/opencode/auth.json", "~/.opencode/auth.json"]
        return out
    }

    /// Gemini OAuth credential files across `~/.gemini*` variants, default first.
    static func geminiCredentialPaths(home: String? = nil) -> [String] {
        // An explicit home roots the default entry too — otherwise the
        // parameter is a lie and callers always hit the real ~/.gemini first.
        var paths = ["\(home ?? NSHomeDirectory())/.gemini/oauth_creds.json"]
        for variant in variantDirs(prefixes: [".gemini"], home: home) {
            let p = "\(variant)/oauth_creds.json"
            if !paths.contains(p) { paths.append(p) }
        }
        return paths
    }

    /// Kimi credential files across `~/.kimi*` variants (covers `.kimi`,
    /// `.kimi-code`, and any suffixed profile dir), default first.
    static func kimiCredentialPaths(home: String? = nil) -> [String] {
        let root = home ?? NSHomeDirectory()
        var paths = [
            "\(root)/.kimi-code/credentials/kimi-code.json",
            "\(root)/.kimi/credentials/kimi-code.json",
        ]
        for variant in variantDirs(prefixes: [".kimi"], home: home) {
            let p = "\(variant)/credentials/kimi-code.json"
            if !paths.contains(p) { paths.append(p) }
        }
        return paths
    }
}
