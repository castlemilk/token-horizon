import Foundation

/// Canonical identity — THE single home for every vendor/model spelling rule.
///
/// Raw spellings vary wildly across channels for the same thing:
///   vendors: "Zhipu" (file) vs "glm" (limits) vs "zai-coding-plan" (auth key)
///   models:  "claude-opus-4-5-20251101" (files) == "claude-opus-4.5" (pi) ==
///            "claude-haiku-4.5@luh-crank" (gateway suffix) ==
///            "openai-codex/gpt-5.3-codex" (namespaced)
///
/// Everything that persists, matches, or groups by vendor/model funnels
/// through here: SQLiteUsageStore insert + migrations, meter↔file
/// reconciliation, quota history, and the Models-tab family keys
/// (ModelCatalog.canonicalIdentity consumes the rule tables below).
public enum Canonical {

    // MARK: - User overrides (config-dir canonical.json — THE central place)

    /// User-editable canonicalization config, read from
    /// <config>/canonical.json. CONFIG WINS over the hardcoded tables —
    /// update spellings there, never here. Two flat maps:
    ///   vendors: raw provider spelling → canonical vendor
    ///            (read-time CASE fold AND pricing-table keys)
    ///   models:  POST-transformation model name → canonical model id
    ///            (applied after the mechanical folds, before grouping and
    ///            pricing-key construction)
    /// Reloaded live (mtime, 5s TTL); the SQL-side caches (spelling,
    /// pricing) follow within their normal 30s refresh. Missing/invalid
    /// file = no overrides (hardcoded tables only).
    private struct Overrides: Codable {
        var vendors: [String: String]?
        var models: [String: String]?
    }

    private static let overrideLock = NSLock()
    private static var overrides = Overrides()
    private static var overridesCheckedAt = Date.distantPast
    private static var overridesMtime = Date.distantPast
    /// Test seam: alternate config location.
    public static var overrideFilePath: String?

    private static var overridePath: String {
        overrideFilePath
            ?? Platform.paths.configDirectory.appendingPathComponent("canonical.json").path
    }

    /// Force re-read (tests; production relies on the 5s TTL).
    public static func reloadOverrides() {
        overrideLock.lock()
        overridesCheckedAt = .distantPast
        overrideLock.unlock()
    }

    private static func currentOverrides() -> Overrides {
        overrideLock.lock()
        defer { overrideLock.unlock() }
        guard Date().timeIntervalSince(overridesCheckedAt) > 5 else { return overrides }
        overridesCheckedAt = Date()
        let path = overridePath
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let mtime = attrs[.modificationDate] as? Date else {
            overrides = Overrides()
            seedOverrideFile(path)
            return overrides
        }
        guard mtime != overridesMtime else { return overrides }
        if let data = FileManager.default.contents(atPath: path),
           let parsed = try? JSONDecoder().decode(Overrides.self, from: data) {
            overrides = parsed
            overridesMtime = mtime
        } // invalid JSON: keep the last good overrides
        return overrides
    }

    /// First run: materialize the effective config so the user has one
    /// centralized, documented file to edit.
    private static func seedOverrideFile(_ path: String) {
        guard !FileManager.default.fileExists(atPath: path) else { return }
        let seed: [String: Any] = [
            "_comment": "Canonicalization overrides — this file WINS over built-in tables. vendors: raw provider spelling → canonical vendor (read-time fold + pricing keys). models: POST-transformation model name → canonical model id (pricing/catalog/display keys). Reloaded live (~5s); SQL caches follow within 30s.",
            "vendors": vendorTable,
            "models": [
                "k3-256k": "kimi-k3",
                "muse-spark-1.2-free": "muse-spark-1.3-contributor-free",
            ],
        ]
        if let data = try? JSONSerialization.data(withJSONObject: seed, options: [.prettyPrinted, .sortedKeys]) {
            FileManager.default.createFile(atPath: path, contents: data)
        }
    }

    // MARK: - Vendors

    /// Canonical choices follow the dominant existing id (limits adapters,
    /// consolidators), NOT brand correctness: Zhipu coding-plan traffic has
    /// always been "glm" here, so glm wins over zhipu.
    ///
    /// Deliberately NOT merged:
    /// - "openai" ≠ "codex" — direct OpenAI platform traffic is not Codex CLI.
    /// - "qwen" ≠ "alibaba" — Qwen models are served by many gateways.
    static let vendorTable: [String: String] = [
        "anthropic": "claude",
        "kimi-coding": "kimi",
        "kimi-coding-plan": "kimi",
        "kimi-code": "kimi",
        "moonshot": "kimi",
        "zai": "glm",
        "zhipu": "glm",
        "zai-coding-plan": "glm",
        "google": "gemini",
        "minimax-coding-plan": "minimax",
        "alibaba-token-plan": "alibaba",
        "opencode-go": "opencode",
        "llama-cpp": "llamacpp",
        "llama.cpp": "llamacpp",
        "llama": "llamacpp",
        "antigravity": "agy",
    ]

    /// The effective vendor fold map: built-in table MERGED with
    /// canonical.json overrides (config wins). Consumed by the SQL CASE
    /// builders so read-time folds see user edits live.
    public static func effectiveVendorTable() -> [String: String] {
        var t = vendorTable
        for (k, v) in currentOverrides().vendors ?? [:] { t[k] = v }
        return t
    }

    /// Canonical vendor spelling for persistence and matching. Unknown vendors
    /// pass through lowercased/trimmed (custom gateways, e.g. pi providers).
    /// User config (canonical.json) wins over the built-in table.
    public static func vendor(_ raw: String) -> String {
        let k = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let hit = currentOverrides().vendors?[k] { return hit }
        return vendorTable[k] ?? k
    }

    // MARK: - Models: pre-clean (runs before family matching)

    private static let snapshotDate = try? NSRegularExpression(pattern: #"-20\d{6}$"#)
    private static let claudeDottedOld = try? NSRegularExpression(pattern: #"claude-(\d+)\.(\d+)"#)
    private static let claudeDottedNew = try? NSRegularExpression(pattern: #"(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)"#)

    /// Canonical model id for persistence/analytics: the ModelCatalog family
    /// key, so usage rows group exactly like the Models tab and hit pricing/
    /// context lookups. Unknown custom models pass through cleaned.
    public static func model(vendor: String, model rawModel: String) -> String {
        var m = rawModel.trimmingCharacters(in: .whitespacesAndNewlines)
        // Gateway attribution suffix: claude-haiku-4.5@luh-crank → claude-haiku-4.5
        if let at = m.firstIndex(of: "@") { m = String(m[..<at]) }
        m = m.lowercased()
        // Snapshot dates: claude-opus-4-5-20251101 → claude-opus-4-5
        m = snapshotDate?.stringByReplacingMatches(
            in: m, range: NSRange(m.startIndex..., in: m), withTemplate: "") ?? m
        // Claude dotted versions → API-id dash style (catalog family style):
        // claude-sonnet-4.5 → claude-sonnet-4-5, claude-3.5-sonnet → claude-3-5-sonnet
        m = claudeDottedNew?.stringByReplacingMatches(
            in: m, range: NSRange(m.startIndex..., in: m), withTemplate: "$1-$2") ?? m
        m = claudeDottedOld?.stringByReplacingMatches(
            in: m, range: NSRange(m.startIndex..., in: m), withTemplate: "claude-$1-$2") ?? m

        let v = Self.vendor(vendor)
        let family = ModelCatalog.canonicalIdentity(provider: v, model: m).family
        // The catalog's default branch namespaces unknowns as "vendor-model";
        // the vendor column already carries that — store the plain id.
        // The Models tab folds free-tier spellings into the paid family
        // (x-preview-f-free → x-preview-f); usage must NOT — cost differs.
        var result: String
        if family == "\(v)-\(m)" {
            result = m
        } else if m.hasSuffix("-free") && !family.hasSuffix("-free") {
            result = family + "-free"
        } else {
            result = family.isEmpty ? m : family
        }
        // User config wins: POST-transformation name → canonical id
        // (pricing/catalog/display keys all consume this result). Applied
        // LAST so config keys are stable regardless of fold-rule edits.
        if let hit = currentOverrides().models?[result] { result = hit }
        return result
    }

    // MARK: - Family rules (consumed by ModelCatalog.canonicalIdentity)

    /// Qualifier tokens stripped from every family's id ("-latest", "-preview").
    static let qualifierStrips = ["-latest", "-preview"]

    /// Extra strips only the Google branch applies.
    static let googleExtraStrips = ["-thinking", "-exp", "-customtools"]

    /// Version-dash → version-dot folds, per family. Applied after strips.
    /// Order-independent (prefixes are disjoint), kept as arrays for
    /// deterministic application.
    static let geminiFolds: [(String, String)] = [
        ("gemini-3-7-", "gemini-3.7-"), ("gemini-3-5-", "gemini-3.5-"),
        ("gemini-3-1-", "gemini-3.1-"), ("gemini-2-5-", "gemini-2.5-"),
        ("gemini-2-0-", "gemini-2.0-"), ("gemini-1-5-", "gemini-1.5-"),
    ]
    static let claudeFolds: [(String, String)] = [
        ("claude-3-7-", "claude-3.7-"), ("claude-3-5-", "claude-3.5-"),
    ]
    static let qwenFolds: [(String, String)] = [
        ("qwen-3-", "qwen3-"), ("qwen-2-5-", "qwen2.5-"),
    ]

    /// Family id from a raw model spelling: last path component, qualifier
    /// strips, then version folds. Single implementation of the replacement
    /// chain every canonicalIdentity branch used to hand-roll.
    static func familyID(_ m: String, extraStrips: [String] = [],
                         folds: [(String, String)] = []) -> String {
        var f = m.split(separator: "/").last.map(String.init) ?? m
        for token in qualifierStrips + extraStrips {
            f = f.replacingOccurrences(of: token, with: "")
        }
        for (from, to) in folds {
            f = f.replacingOccurrences(of: from, with: to)
        }
        return f
    }
}
