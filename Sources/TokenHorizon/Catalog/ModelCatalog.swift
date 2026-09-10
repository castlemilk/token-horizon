import Foundation

final class ModelCatalog {
    static let shared = ModelCatalog()
    private let lock = NSLock()
    private var byId: [String: Entry] = [:]
    private var lastFetch: Date = .distantPast
    private(set) var revision: Int = 1

    // Memoized canonical identity. Pure function of (provider, model), so
    // results are safe to share across compute() calls: the 7,300-row merge
    // re-resolves the same ids on every keystroke (~106ms in debug, ~40% of
    // the pipeline). Bounded (distinct model ids are finite) with its own
    // lock — never reuse `lock` here, the lookup path must stay independent.
    private static var identityMemo: [String: (family: String, displayName: String, providerId: String, providerName: String)] = [:]
    private static let identityLock = NSLock()
    private static let identityMemoCap = 32_768

    static func canonicalIdentity(provider: String, model: String) -> (family: String, displayName: String, providerId: String, providerName: String) {
        let key = provider + "\0" + model
        identityLock.lock()
        if let hit = identityMemo[key] { identityLock.unlock(); return hit }
        identityLock.unlock()
        let result = canonicalIdentityUncached(provider: provider, model: model)
        identityLock.lock()
        if identityMemo.count < identityMemoCap { identityMemo[key] = result }
        identityLock.unlock()
        return result
    }

    private init() {
        loadFastLocal()
    }

    func currentRevision() -> Int {
        lock.lock(); defer { lock.unlock() }
        return revision
    }

    struct Entry: Codable, Equatable {
        var id: String
        var name: String
        var provider: String
        var providerName: String
        var inputPerM: Double
        var outputPerM: Double
        var cacheReadPerM: Double?
        var contextK: Int
        var benchmarks: Benchmarks?
        var docUrl: String?
        var description: String?
        var reasoning: Bool?
        var toolCall: Bool?
        var vision: Bool?
        var openWeights: Bool?
        var discountPercent: Int?
        var discountLabel: String?
        var discountDetail: String?
        var originalInputPerM: Double?
        var originalOutputPerM: Double?
    }

    struct Benchmarks: Codable, Equatable {
        var swe: Double?
        var lcb: Double?
        var source: String
    }

    func lookup(id: String) -> Entry? {
        lock.lock(); defer { lock.unlock() }
        let clean = id.lowercased().trimmingCharacters(in: .whitespaces)
        // Collect every matching row first: the catalog holds the same model
        // under many keys (lab-direct, aggregators, resellers, bare ids).
        // pickBestLookup then prefers the lab-authoritative, priced row so
        // cost attribution uses direct pricing instead of reseller markup.
        var candidates: [Entry] = []
        if let exact = byId[clean] { candidates.append(exact) }
        let hyphens = clean.replacingOccurrences(of: "_", with: "-")
        if hyphens != clean, let h = byId[hyphens] { candidates.append(h) }
        let colons = clean.split(separator: ":").first.map(String.init) ?? clean
        if colons != clean && colons != hyphens, let c = byId[colons] { candidates.append(c) }
        if candidates.isEmpty {
            for (k, v) in byId {
                if k.hasSuffix("/" + clean) || k.hasSuffix("/" + hyphens) || k.hasSuffix("/" + colons) {
                    candidates.append(v)
                }
            }
        }
        if let best = Self.pickBestLookup(candidates) { return best }
        if clean.contains("astra") || clean.contains("gpt-6-astra") || clean.contains("gpt-astra") {
            if let a = byId["gpt-6-astra"] ?? byId["openai/gpt-6-astra"] ?? byId["astra"] { return a }
            return Entry(
                id: "gpt-6-astra",
                name: "GPT-6 Astra",
                provider: "openai",
                providerName: "OpenAI",
                inputPerM: 10.00,
                outputPerM: 50.00,
                cacheReadPerM: 1.00,
                contextK: 872,
                benchmarks: Benchmarks(swe: 85.2, lcb: 81.0, source: "OpenAI"),
                docUrl: "https://platform.openai.com/docs/models",
                description: "OpenAI premier frontier flagship model for complex coding, computer use & autonomous agents (90% prompt cache savings)",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false,
                discountPercent: 90,
                discountLabel: "-90% CACHED",
                discountDetail: "90% prompt cache savings ($10.00 → $1.00 / 1M cache read)"
            )
        }
        if clean.contains("5.6-sol") || clean.contains("5-6-sol") || clean.contains("56-sol") {
            if let a = byId["gpt-5.6-sol"] ?? byId["openai/gpt-5.6-sol"] { return a }
            return Entry(
                id: "gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                provider: "openai",
                providerName: "OpenAI",
                inputPerM: 2.50,
                outputPerM: 10.00,
                cacheReadPerM: 0.50,
                contextK: 1050,
                benchmarks: Benchmarks(swe: 83.0, lcb: 80.0, source: "OpenAI"),
                docUrl: "https://platform.openai.com/docs/models",
                description: "OpenAI premier flagship tier for complex reasoning, architectural design & multi-step coding agents (50% promotional discount active)",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false,
                discountPercent: 50,
                discountLabel: "-50% PROMO",
                discountDetail: "50% promotional reduction ($5.00 → $2.50 input / $20.00 → $10.00 output)",
                originalInputPerM: 5.00,
                originalOutputPerM: 20.00
            )
        }
        if !clean.contains("solar") && (clean.contains("gpt-5-sol") || clean.contains("gpt-sol") || clean == "sol" || clean.contains("-sol") || clean == "openai/gpt-5-sol") {
            if let a = byId["gpt-5-sol"] ?? byId["openai/gpt-5-sol"] { return a }
            return Entry(
                id: "gpt-5-sol",
                name: "GPT-5 Sol",
                provider: "openai",
                providerName: "OpenAI",
                inputPerM: 2.50,
                outputPerM: 10.00,
                cacheReadPerM: 0.50,
                contextK: 256,
                benchmarks: Benchmarks(swe: 81.5, lcb: 78.0, source: "OpenAI"),
                docUrl: "https://platform.openai.com/docs/models",
                description: "OpenAI premier flagship tier for complex reasoning, architectural design & multi-step coding agents (50% promotional discount active)",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false,
                discountPercent: 50,
                discountLabel: "-50% PROMO",
                discountDetail: "50% promotional reduction ($5.00 → $2.50 input / $20.00 → $10.00 output)",
                originalInputPerM: 5.00,
                originalOutputPerM: 20.00
            )
        }
        if clean.contains("5.6-terra") || clean.contains("5-6-terra") || clean.contains("56-terra") {
            if let a = byId["gpt-5.6-terra"] ?? byId["openai/gpt-5.6-terra"] { return a }
            return Entry(
                id: "gpt-5.6-terra",
                name: "GPT-5.6 Terra",
                provider: "openai",
                providerName: "OpenAI",
                inputPerM: 1.20,
                outputPerM: 4.80,
                cacheReadPerM: 0.15,
                contextK: 1050,
                benchmarks: Benchmarks(swe: 74.0, lcb: 70.0, source: "OpenAI"),
                docUrl: "https://platform.openai.com/docs/models",
                description: "OpenAI balanced all-rounder tier for daily professional coding & multi-modal workflows (20% promo reduction)",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false,
                discountPercent: 20,
                discountLabel: "-20% PROMO",
                discountDetail: "20% promotional reduction ($1.50 → $1.20 input / $6.00 → $4.80 output)",
                originalInputPerM: 1.50,
                originalOutputPerM: 6.00
            )
        }
        if clean.contains("terra") || clean.contains("gpt-5-terra") || clean.contains("gpt-terra") {
            return Entry(
                id: "gpt-5-terra",
                name: "GPT-5 Terra",
                provider: "openai",
                providerName: "OpenAI",
                inputPerM: 1.20,
                outputPerM: 4.80,
                cacheReadPerM: 0.15,
                contextK: 256,
                benchmarks: Benchmarks(swe: 72.0, lcb: 68.5, source: "OpenAI"),
                docUrl: "https://platform.openai.com/docs/models",
                description: "OpenAI balanced all-rounder tier for daily professional coding & multi-modal workflows (20% promo reduction)",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false,
                discountPercent: 20,
                discountLabel: "-20% PROMO",
                discountDetail: "20% promotional reduction ($1.50 → $1.20 input / $6.00 → $4.80 output)",
                originalInputPerM: 1.50,
                originalOutputPerM: 6.00
            )
        }
        if !clean.contains("lunaris") && (clean.contains("5.6-luna") || clean.contains("5-6-luna") || clean.contains("56-luna")) {
            if let a = byId["gpt-5.6-luna"] ?? byId["openai/gpt-5.6-luna"] { return a }
            return Entry(
                id: "gpt-5.6-luna",
                name: "GPT-5.6 Luna",
                provider: "openai",
                providerName: "OpenAI",
                inputPerM: 0.10,
                outputPerM: 0.40,
                cacheReadPerM: 0.025,
                contextK: 1050,
                benchmarks: Benchmarks(swe: 54.0, lcb: 52.0, source: "OpenAI"),
                docUrl: "https://platform.openai.com/docs/models",
                description: "OpenAI high-speed lightweight tier for fast summaries, classification & cost-sensitive tasks",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false
            )
        }
        if !clean.contains("lunaris") && (clean.contains("luna") || clean.contains("gpt-5-luna") || clean.contains("gpt-luna")) {
            return Entry(
                id: "gpt-5-luna",
                name: "GPT-5 Luna",
                provider: "openai",
                providerName: "OpenAI",
                inputPerM: 0.10,
                outputPerM: 0.40,
                cacheReadPerM: 0.025,
                contextK: 128,
                benchmarks: Benchmarks(swe: 52.0, lcb: 50.0, source: "OpenAI"),
                docUrl: "https://platform.openai.com/docs/models",
                description: "OpenAI high-speed lightweight tier for fast summaries, classification & cost-sensitive tasks",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false
            )
        }
        // DeepSeek V4 family — authoritative pricing from https://api-docs.deepseek.com/quick_start/pricing
        // (off-peak cache-miss base; peak = 2x). V4.1-Flash is the current flagship;
        // legacy `deepseek-flash` / `deepseek-v4-flash*` aliases route to V4.1-Flash,
        // and `deepseek-v4-pro` routes to V4.1-Flash from 2026-09-14 (billed at Flash).
        if clean.contains("v4.1") && clean.contains("flash") || clean == "deepseek-flash" || clean == "deepseek/flash" || clean.contains("deepseek-v4-flash") || clean.contains("deepseek-flash") {
            if let a = byId["deepseek-v4.1-flash"] ?? byId["deepseek/deepseek-v4.1-flash"] { return a }
            return Entry(
                id: "deepseek-v4.1-flash",
                name: "DeepSeek V4.1 Flash",
                provider: "deepseek",
                providerName: "DeepSeek",
                inputPerM: 0.15,
                outputPerM: 0.60,
                cacheReadPerM: 0.003,
                contextK: 1000,
                benchmarks: Benchmarks(swe: 78.0, lcb: 74.0, source: "DeepSeek"),
                docUrl: "https://api-docs.deepseek.com/quick_start/pricing",
                description: "DeepSeek current flagship (off-peak shown; peak 2x; surpasses V4 Pro, faster + cheaper)",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: true
            )
        }
        if clean.contains("deepseek-v4-pro") || (clean.contains("deepseek") && clean.contains("v4") && clean.contains("pro")) {
            if let a = byId["deepseek-v4-pro-0813"] ?? byId["deepseek/deepseek-v4-pro-0813"] ?? byId["deepseek-v4-pro"] ?? byId["deepseek/deepseek-v4-pro"] { return a }
            return Entry(
                id: "deepseek-v4-pro-0813",
                name: "DeepSeek V4 Pro",
                provider: "deepseek",
                providerName: "DeepSeek",
                inputPerM: 0.66,
                outputPerM: 1.98,
                cacheReadPerM: 0.022,
                contextK: 1000,
                benchmarks: Benchmarks(swe: 72.0, lcb: 68.0, source: "DeepSeek"),
                docUrl: "https://api-docs.deepseek.com/quick_start/pricing",
                description: "DeepSeek V4 Pro 0813 (off-peak shown; peak 2x; routes to V4.1 Flash from 2026-09-14 billed at Flash)",
                reasoning: true,
                toolCall: true,
                vision: false,
                openWeights: true
            )
        }
        if clean.contains("claude-fable") || clean.contains("fable-5") || clean.contains("fable") {
            return Entry(
                id: "claude-fable-5-1",
                name: "Claude Fable 5.1",
                provider: "anthropic",
                providerName: "Anthropic",
                inputPerM: 10.00,
                outputPerM: 50.00,
                cacheReadPerM: 0.25,
                contextK: 1000,
                benchmarks: Benchmarks(swe: 84.0, lcb: 80.5, source: "Anthropic"),
                docUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
                description: "Anthropic frontier reasoning & software engineering model (97.5% prompt cache savings)",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false,
                discountPercent: 90,
                discountLabel: "-90% CACHED",
                discountDetail: "97.5% prompt cache read discount ($10.00 → $0.25 / 1M)"
            )
        }
        if clean.contains("claude-opus") || clean.contains("opus-5") || clean.contains("opus-4") {
            let isLegacy = clean.contains("opus-3") || clean.contains("opus-4-1")
            return Entry(
                id: clean.contains("opus-5") ? "claude-opus-5" : "claude-opus-4-6",
                name: clean.contains("opus-5") ? "Claude Opus 5" : "Claude Opus 4.6",
                provider: "anthropic",
                providerName: "Anthropic",
                inputPerM: isLegacy ? 15.00 : 5.00,
                outputPerM: isLegacy ? 75.00 : 25.00,
                cacheReadPerM: isLegacy ? 1.50 : 0.50,
                contextK: 1000,
                benchmarks: Benchmarks(swe: clean.contains("opus-5") ? 82.0 : 76.5, lcb: clean.contains("opus-5") ? 79.0 : 74.0, source: "Anthropic"),
                docUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
                description: "Anthropic flagship model for complex coding & architecture (90% prompt cache savings)",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false,
                discountPercent: 90,
                discountLabel: "-90% CACHED",
                discountDetail: "90% prompt cache read discount ($5.00 → $0.50 / 1M)"
            )
        }
        if clean.contains("claude-sonnet") || clean.contains("3-7-sonnet") || clean.contains("3.7-sonnet") || clean.contains("3-5-sonnet") || clean.contains("3.5-sonnet") {
            let is37 = clean.contains("3-7") || clean.contains("3.7")
            return Entry(
                id: is37 ? "claude-3.7-sonnet" : "claude-3.5-sonnet",
                name: is37 ? "Claude 3.7 Sonnet" : "Claude 3.5 Sonnet",
                provider: "anthropic",
                providerName: "Anthropic",
                inputPerM: 3.00,
                outputPerM: 15.00,
                cacheReadPerM: 0.30,
                contextK: 200,
                benchmarks: Benchmarks(swe: is37 ? 70.3 : 65.0, lcb: is37 ? 71.0 : 67.0, source: "Anthropic"),
                docUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
                description: "Anthropic premier industry benchmark model for coding & agentic workflows (90% prompt cache savings)",
                reasoning: is37,
                toolCall: true,
                vision: true,
                openWeights: false,
                discountPercent: 90,
                discountLabel: "-90% CACHED",
                discountDetail: "90% prompt cache read discount ($3.00 → $0.30 / 1M)"
            )
        }
        if clean.contains("claude-haiku") || clean.contains("haiku-4") || clean.contains("3-5-haiku") || clean.contains("3.5-haiku") {
            let is45 = clean.contains("4-5") || clean.contains("4.5")
            return Entry(
                id: is45 ? "claude-haiku-4-5" : "claude-3.5-haiku",
                name: is45 ? "Claude Haiku 4.5" : "Claude 3.5 Haiku",
                provider: "anthropic",
                providerName: "Anthropic",
                inputPerM: is45 ? 1.00 : 0.80,
                outputPerM: is45 ? 5.00 : 4.00,
                cacheReadPerM: is45 ? 0.10 : 0.08,
                contextK: 200,
                benchmarks: Benchmarks(swe: 40.6, lcb: 43.1, source: "Anthropic"),
                docUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
                description: "Anthropic high-speed lightweight model for quick tasks & summaries",
                reasoning: false,
                toolCall: true,
                vision: true,
                openWeights: false
            )
        }
        if clean.contains("gemini-3.7-flash") {
            return Entry(
                id: "gemini-3.7-flash",
                name: "Gemini 3.7 Flash",
                provider: "google",
                providerName: "Google",
                inputPerM: 0.15,
                outputPerM: 0.60,
                cacheReadPerM: 0.038,
                contextK: 1000,
                benchmarks: Benchmarks(swe: 67.0, lcb: 65.0, source: "Google"),
                docUrl: "https://ai.google.dev/pricing",
                description: "Google next-generation hybrid reasoning & coding flash model (75% context caching savings)",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false,
                discountPercent: 75,
                discountLabel: "-75% CACHED",
                discountDetail: "75% context caching discount ($0.15 → $0.038 / 1M cache read)"
            )
        }
        if clean.contains("gemini-3.5-flash") {
            return Entry(
                id: "gemini-3.5-flash",
                name: "Gemini 3.5 Flash",
                provider: "google",
                providerName: "Google",
                inputPerM: 0.15,
                outputPerM: 0.60,
                cacheReadPerM: 0.038,
                contextK: 1000,
                benchmarks: Benchmarks(swe: 65.0, lcb: 62.0, source: "Google"),
                docUrl: "https://ai.google.dev/pricing",
                description: "Google next-generation speed & multimodal reasoning model",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false
            )
        }
        if clean.contains("gemini-2.5-pro") || clean.contains("gemini-3.1-pro") || clean.contains("gemini-3-pro") {
            return Entry(
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                provider: "google",
                providerName: "Google",
                inputPerM: 1.25,
                outputPerM: 5.00,
                cacheReadPerM: 0.31,
                contextK: 2000,
                benchmarks: Benchmarks(swe: 63.8, lcb: 60.5, source: "Google"),
                docUrl: "https://ai.google.dev/pricing",
                description: "Google frontier multimodal reasoning & coding model",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false
            )
        }
        if clean.contains("gemini-2.5-flash") || clean.contains("gemini-2.0-flash") {
            return Entry(
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                provider: "google",
                providerName: "Google",
                inputPerM: 0.15,
                outputPerM: 0.60,
                cacheReadPerM: 0.038,
                contextK: 1000,
                benchmarks: Benchmarks(swe: 55.0, lcb: 54.0, source: "Google"),
                docUrl: "https://ai.google.dev/pricing",
                description: "Google high-performance multimodal flash model",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: false
            )
        }
        if clean.contains("glm-5.3-flash") || clean.contains("glm-4-flash") {
            return Entry(
                id: "glm-5.3-flash",
                name: "GLM 5.3 Flash",
                provider: "glm",
                providerName: "Zhipu AI",
                inputPerM: 0.01,
                outputPerM: 0.01,
                cacheReadPerM: 0.005,
                contextK: 128,
                benchmarks: Benchmarks(swe: 58.0, lcb: 55.0, source: "Zhipu"),
                docUrl: "https://open.bigmodel.cn/dev/api",
                description: "Zhipu high-speed lightweight reasoning & coding model",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: true
            )
        }
        if clean.contains("glm-5.3") || clean.contains("glm-5") {
            return Entry(
                id: "glm-5.3",
                name: "GLM 5.3",
                provider: "glm",
                providerName: "Zhipu AI",
                inputPerM: 0.70,
                outputPerM: 0.70,
                cacheReadPerM: 0.14,
                contextK: 128,
                benchmarks: Benchmarks(swe: 68.0, lcb: 63.0, source: "Zhipu"),
                docUrl: "https://open.bigmodel.cn/dev/api",
                description: "Zhipu flagship frontier coding & reasoning model",
                reasoning: true,
                toolCall: true,
                vision: true,
                openWeights: true
            )
        }
        // Generic dynamic synthesis: any new model id containing a known
        // family substring gets plausible pricing immediately (corrected when
        // the authoritative fetch lands), so the list never shows $0/missing
        // for newly released models like deepseek-v4.1, gpt-6-*, claude-5-*.
        if let synth = Self.synthesizeDynamicEntry(for: clean) { return synth }
        return nil
    }

    /// Picks the best row among catalog matches for one model id.
    /// Preference order (deterministic): lab-authoritative provider first
    /// (direct pricing beats reseller markup), then positively-priced rows
    /// (beats $0 placeholders), then lowest id for stability.
    static func pickBestLookup(_ candidates: [Entry]) -> Entry? {
        guard !candidates.isEmpty else { return nil }
        if candidates.count == 1 { return candidates[0] }
        return candidates.sorted { a, b in
            let canonA = canonicalIdentity(provider: a.provider, model: a.id)
            let canonB = canonicalIdentity(provider: b.provider, model: b.id)
            let authA = a.provider.lowercased() == canonA.providerId ? 0 : 1
            let authB = b.provider.lowercased() == canonB.providerId ? 0 : 1
            if authA != authB { return authA < authB }
            let priceA = (a.inputPerM > 0 || a.outputPerM > 0) ? 0 : 1
            let priceB = (b.inputPerM > 0 || b.outputPerM > 0) ? 0 : 1
            if priceA != priceB { return priceA < priceB }
            return a.id.lowercased() < b.id.lowercased()
        }.first
    }

    /// Best-effort pricing for model ids not yet in the catalog or flagships.
    /// Keeps the token list fully dynamic: new releases appear with reasonable
    /// pricing instead of $0/missing until models.dev + live fetchers confirm.
    static func synthesizeDynamicEntry(for clean: String) -> Entry? {
        let id = clean
        let display = formatModelDisplayName(clean)
        // DeepSeek: Flash vs Pro split (official docs 2026-09-10, off-peak base).
        if clean.contains("deepseek") {
            let isPro = clean.contains("pro")
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "deepseek", providerName: "DeepSeek",
                inputPerM: isPro ? 0.66 : 0.15,
                outputPerM: isPro ? 1.98 : 0.60,
                cacheReadPerM: isPro ? 0.022 : 0.003,
                contextK: 1000,
                benchmarks: nil,
                docUrl: "https://api-docs.deepseek.com/quick_start/pricing",
                description: isPro
                    ? "DeepSeek Pro-tier estimate (off-peak shown; peak 2x; live pricing pending)"
                    : "DeepSeek Flash-tier estimate (off-peak shown; peak 2x; live pricing pending)",
                reasoning: true, toolCall: true,
                vision: clean.contains("vision") || clean.contains("flash"),
                openWeights: true
            )
        }
        // OpenAI: tier guess from name fragments.
        if clean.contains("gpt") || clean.hasPrefix("o1") || clean.hasPrefix("o3") || clean.hasPrefix("o4") || clean.contains("astra") || clean.contains("daybreak") || clean.contains("reserve") {
            let isCheap = clean.contains("mini") || clean.contains("nano") || clean.contains("luna")
            let isMid = clean.contains("terra") || clean.contains("turbo") || clean.contains("flash")
            let inp = isCheap ? 0.10 : (isMid ? 1.20 : 2.50)
            let out = isCheap ? 0.40 : (isMid ? 4.80 : 10.00)
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "openai", providerName: "OpenAI",
                inputPerM: inp, outputPerM: out, cacheReadPerM: inp * 0.2,
                contextK: 256,
                benchmarks: nil,
                docUrl: "https://platform.openai.com/docs/models",
                description: "OpenAI estimate for newly discovered model (live pricing pending)",
                reasoning: true, toolCall: true, vision: true, openWeights: false
            )
        }
        // Anthropic Claude: Opus / Sonnet / Haiku tiers.
        if clean.contains("claude") || clean.contains("opus") || clean.contains("sonnet") || clean.contains("haiku") || clean.contains("fable") {
            let isOpus = clean.contains("opus")
            let isHaiku = clean.contains("haiku")
            let inp = isOpus ? 5.00 : (isHaiku ? 1.00 : 3.00)
            let out = isOpus ? 25.00 : (isHaiku ? 5.00 : 15.00)
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "anthropic", providerName: "Anthropic",
                inputPerM: inp, outputPerM: out, cacheReadPerM: inp * 0.1,
                contextK: 200,
                benchmarks: nil,
                docUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
                description: "Anthropic estimate for newly discovered model (live pricing pending)",
                reasoning: true, toolCall: true, vision: true, openWeights: false
            )
        }
        // Google Gemini: Pro vs Flash split.
        if clean.contains("gemini") || clean.contains("gemma") {
            let isPro = clean.contains("pro") && !clean.contains("flash")
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "google", providerName: "Google",
                inputPerM: isPro ? 1.25 : 0.15,
                outputPerM: isPro ? 5.00 : 0.60,
                cacheReadPerM: isPro ? 0.31 : 0.038,
                contextK: 1000,
                benchmarks: nil,
                docUrl: "https://ai.google.dev/pricing",
                description: "Google estimate for newly discovered model (live pricing pending)",
                reasoning: true, toolCall: true, vision: true, openWeights: false
            )
        }
        // Zhipu GLM: Flash vs standard split.
        if clean.contains("glm") || clean.contains("codegeex") {
            let isFlash = clean.contains("flash") || clean.contains("air") || clean.contains("turbo")
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "glm", providerName: "Zhipu AI",
                inputPerM: isFlash ? 0.01 : 0.70,
                outputPerM: isFlash ? 0.01 : 0.70,
                cacheReadPerM: isFlash ? 0.005 : 0.14,
                contextK: 128,
                benchmarks: nil,
                docUrl: "https://open.bigmodel.cn/dev/api",
                description: "Zhipu estimate for newly discovered model (live pricing pending)",
                reasoning: true, toolCall: true, vision: true, openWeights: true
            )
        }
        // Alibaba Qwen: cheap / standard / max tiers.
        if clean.contains("qwen") || clean.contains("bailian") {
            let isCheap = clean.contains("flash") || clean.contains("lite") || clean.contains("air") || clean.contains("mini") || clean.contains("turbo")
            let isMax = clean.contains("max") || clean.contains("plus")
            let inp = isCheap ? 0.10 : (isMax ? 0.80 : 0.30)
            let out = isCheap ? 0.40 : (isMax ? 3.20 : 1.20)
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "alibaba", providerName: "Alibaba Cloud",
                inputPerM: inp, outputPerM: out, cacheReadPerM: inp * 0.2,
                contextK: 128,
                benchmarks: nil,
                docUrl: "https://www.alibabacloud.com/help/en/model-studio/developer-reference/what-is-qwen-llm",
                description: "Qwen estimate for newly discovered model (live pricing pending)",
                reasoning: true, toolCall: true, vision: clean.contains("vision") || clean.contains("vl"), openWeights: true
            )
        }
        // Moonshot Kimi.
        if clean.contains("kimi") || clean.contains("moonshot") {
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "kimi", providerName: "Moonshot Kimi",
                inputPerM: 0.60, outputPerM: 2.50, cacheReadPerM: 0.15,
                contextK: 256,
                benchmarks: nil,
                docUrl: "https://platform.moonshot.cn/docs/",
                description: "Kimi estimate for newly discovered model (live pricing pending)",
                reasoning: true, toolCall: true, vision: false, openWeights: true
            )
        }
        // MiniMax.
        if clean.contains("minimax") {
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "minimax", providerName: "MiniMax",
                inputPerM: 0.30, outputPerM: 1.20, cacheReadPerM: 0.06,
                contextK: 200,
                benchmarks: nil,
                docUrl: "https://platform.minimaxi.com/document/",
                description: "MiniMax estimate for newly discovered model (live pricing pending)",
                reasoning: true, toolCall: true, vision: false, openWeights: false
            )
        }
        // xAI Grok: mini vs flagship tiers.
        if clean.contains("grok") || clean == "xai" || clean.hasPrefix("xai-") {
            let isMini = clean.contains("mini")
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "xai", providerName: "xAI",
                inputPerM: isMini ? 0.30 : 3.00,
                outputPerM: isMini ? 0.50 : 15.00,
                cacheReadPerM: isMini ? 0.075 : 0.75,
                contextK: 256,
                benchmarks: nil,
                docUrl: "https://docs.x.ai/docs/models",
                description: "Grok estimate for newly discovered model (live pricing pending)",
                reasoning: true, toolCall: true, vision: true, openWeights: false
            )
        }
        // Mistral & Codestral.
        if clean.contains("mistral") || clean.contains("codestral") || clean.contains("pixtral") || clean.contains("mixtral") {
            let isSmall = clean.contains("mini") || clean.contains("small") || clean.contains("lite") || clean.contains("8b") || clean.contains("7b")
            let isLarge = clean.contains("large") || clean.contains("medium")
            let inp = isSmall ? 0.10 : (isLarge ? 0.50 : 0.30)
            let out = isSmall ? 0.30 : (isLarge ? 1.50 : 0.90)
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "mistral", providerName: "Mistral",
                inputPerM: inp, outputPerM: out, cacheReadPerM: inp * 0.25,
                contextK: 128,
                benchmarks: nil,
                docUrl: "https://docs.mistral.ai/getting-started/models/",
                description: "Mistral estimate for newly discovered model (live pricing pending)",
                reasoning: true, toolCall: true, vision: clean.contains("pixtral"), openWeights: true
            )
        }
        // Meta LLaMA (via API hosting): small vs large tiers.
        if clean.contains("llama") || clean.contains("meta-") {
            let isSmall = clean.contains("8b") || clean.contains("7b") || clean.contains("3b") || clean.contains("1b") || clean.contains("instant")
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "meta", providerName: "Meta",
                inputPerM: isSmall ? 0.05 : 0.35,
                outputPerM: isSmall ? 0.10 : 0.60,
                cacheReadPerM: isSmall ? 0.01 : 0.07,
                contextK: 128,
                benchmarks: nil,
                docUrl: "https://models.dev",
                description: "LLaMA estimate for newly discovered model (live pricing pending)",
                reasoning: false, toolCall: true, vision: clean.contains("vision"), openWeights: true
            )
        }
        // Cohere Command.
        if clean.contains("cohere") || clean.contains("command") {
            let isPlus = clean.contains("plus") || clean.contains("command-a")
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "cohere", providerName: "Cohere",
                inputPerM: isPlus ? 2.50 : 0.15,
                outputPerM: isPlus ? 10.00 : 0.60,
                cacheReadPerM: isPlus ? 0.25 : 0.03,
                contextK: 128,
                benchmarks: nil,
                docUrl: "https://models.dev",
                description: "Cohere estimate for newly discovered model (live pricing pending)",
                reasoning: false, toolCall: true, vision: false, openWeights: false
            )
        }
        // Perplexity Sonar.
        if clean.contains("sonar") || clean.contains("perplexity") {
            let isPro = clean.contains("pro")
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "perplexity", providerName: "Perplexity",
                inputPerM: isPro ? 3.00 : 1.00,
                outputPerM: isPro ? 15.00 : 1.00,
                cacheReadPerM: isPro ? 0.30 : 0.20,
                contextK: 128,
                benchmarks: nil,
                docUrl: "https://models.dev",
                description: "Sonar estimate for newly discovered model (live pricing pending)",
                reasoning: clean.contains("reasoning"), toolCall: false, vision: false, openWeights: false
            )
        }
        // Amazon Nova.
        if clean.contains("nova") || clean.contains("bedrock") {
            let isSmall = clean.contains("micro") || clean.contains("lite")
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "amazon", providerName: "Amazon Web Services",
                inputPerM: isSmall ? 0.035 : 0.80,
                outputPerM: isSmall ? 0.14 : 3.20,
                cacheReadPerM: isSmall ? 0.008 : 0.20,
                contextK: 300,
                benchmarks: nil,
                docUrl: "https://models.dev",
                description: "Nova estimate for newly discovered model (live pricing pending)",
                reasoning: true, toolCall: true, vision: true, openWeights: false
            )
        }
        // Upstage Solar.
        if clean.contains("solar") || clean.contains("upstage") {
            let isMini = clean.contains("mini")
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "upstage", providerName: "Upstage",
                inputPerM: isMini ? 0.04 : 0.10,
                outputPerM: isMini ? 0.08 : 0.30,
                cacheReadPerM: isMini ? 0.01 : 0.025,
                contextK: 128,
                benchmarks: nil,
                docUrl: "https://models.dev",
                description: "Solar estimate for newly discovered model (live pricing pending)",
                reasoning: true, toolCall: true, vision: false, openWeights: false
            )
        }
        // OpenCode free-tier models.
        if clean.contains("big-pickle") || clean.contains("x-preview") || clean.contains("ox-alpha") || clean.contains("muse-spark") || clean.contains("nemotron") || clean.contains("mimo") {
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "opencode", providerName: "OpenCode",
                inputPerM: 0, outputPerM: 0, cacheReadPerM: nil,
                contextK: 128,
                benchmarks: nil,
                docUrl: "https://opencode.ai",
                description: "Free OpenCode model",
                reasoning: true, toolCall: true, vision: false, openWeights: true
            )
        }
        // Local Ollama models are free by definition.
        if clean.hasPrefix("ollama/") || clean.hasPrefix("ollama-") || clean.contains("ornith") {
            return Entry(
                id: id, name: display.isEmpty ? clean : display,
                provider: "ollama", providerName: "Ollama (Local)",
                inputPerM: 0, outputPerM: 0, cacheReadPerM: nil,
                contextK: 128,
                benchmarks: nil,
                docUrl: "https://ollama.com/library",
                description: "Local model (free, on-device)",
                reasoning: false, toolCall: nil, vision: nil, openWeights: true
            )
        }
        return nil
    }

    func allEntries() -> [Entry] {
        lock.lock(); defer { lock.unlock() }
        var seen = Set<String>()
        var result: [Entry] = []
        result.reserveCapacity(byId.count)
        for e in byId.values {
            let key = "\(e.provider)/\(e.id)".lowercased()
            if seen.insert(key).inserted {
                result.append(e)
            }
        }
        return result
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return byId.count
    }

    @discardableResult
    func mergeDiscoveredEntries(_ newEntries: [String: Entry]) -> (added: Int, updated: Int, addedIds: [String]) {
        lock.lock()
        var added = 0
        var updated = 0
        var addedIds: [String] = []
        for (k, v) in newEntries {
            let cleanKey = k.lowercased()
            if let existing = byId[cleanKey] {
                if existing != v {
                    byId[cleanKey] = v
                    updated += 1
                }
            } else {
                byId[cleanKey] = v
                added += 1
                addedIds.append(v.name.isEmpty ? v.id : v.name)
            }
        }
        if added > 0 || updated > 0 {
            revision += 1
            let copy = byId
            DispatchQueue.global(qos: .utility).async {
                let cachePath = NSString(string: "~/.config/token-horizon/models-cache.json").expandingTildeInPath
                if let enc = try? JSONEncoder().encode(copy) {
                    try? enc.write(to: URL(fileURLWithPath: cachePath))
                }
            }
        }
        lock.unlock()
        if added > 0 || updated > 0 {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .refreshModelExtras, object: nil)
            }
        }
        return (added, updated, addedIds)
    }

    private func loadFastLocal() {
        let cachePath = NSString(string: "~/.config/token-horizon/models-cache.json").expandingTildeInPath
        let bm = Self.loadBenchmarks()
        var map: [String: Entry] = [:]
        if let data = try? Data(contentsOf: URL(fileURLWithPath: cachePath)),
           let decoded = try? JSONDecoder().decode([String: Entry].self, from: data) {
            map = decoded
        }
        Self.injectDirectFlagships(into: &map, benchmarks: bm)
        Self.fetchCodexCachedModels(into: &map, benchmarks: bm)
        self.byId = map
        self.revision += 1
    }

    func getLastFetchTime() -> Date {
        lock.lock(); defer { lock.unlock() }
        return lastFetch
    }

    private static var lastGapTrigger: Date = .distantPast
    private static let gapLock = NSLock()
    static let gapRefreshCooldown: TimeInterval = 120 // 2 min

    /// Called when spend is attributed to a model with unknown/zero pricing.
    /// Self-healing discovery: a throttled background refresh pulls live
    /// pricing within minutes instead of waiting for the next 10-minute
    /// cycle. Safe to call from hot paths (single lock + timestamp check).
    static func notePricingGap() {
        gapLock.lock()
        let due = Date().timeIntervalSince(lastGapTrigger) > gapRefreshCooldown
        if due { lastGapTrigger = Date() }
        gapLock.unlock()
        if due { DispatchQueue.global(qos: .utility).async { Self.fetchAndMerge() } }
    }

    func refreshRemote() {
        lock.lock()
        lastFetch = .distantPast
        lock.unlock()
        DispatchQueue.global(qos: .utility).async { Self.fetchAndMerge() }
    }

    /// Near-realtime catalog freshness: background ticks call this every ~60s.
    /// Refresh when never fetched OR older than `remoteRefreshInterval` so new
    /// models + pricing updates land within minutes, not hours.
    static let remoteRefreshInterval: TimeInterval = 600 // 10 min
    func ensureLoaded() {
        lock.lock()
        let last = lastFetch
        lock.unlock()
        let stale = last == .distantPast || Date().timeIntervalSince(last) > Self.remoteRefreshInterval
        if stale { DispatchQueue.global(qos: .utility).async { Self.fetchAndMerge() } }
    }

    /// Compiled once: compiling this per call (inside formatModelDisplayName,
    /// itself called per catalog row per pipeline run) showed up hot.
    private static let dateSuffixPattern: NSRegularExpression? = try? NSRegularExpression(pattern: #"-\d{8}$"#)

    static func formatModelDisplayName(_ modelId: String) -> String {
        var clean = modelId
            .replacingOccurrences(of: ":latest", with: "")
            .replacingOccurrences(of: "-latest", with: "")
            .replacingOccurrences(of: "_", with: "-")

        clean = dateSuffixPattern?.stringByReplacingMatches(in: clean, range: NSRange(clean.startIndex..., in: clean), withTemplate: "") ?? clean

        let tokens = clean.split(separator: "-")
        var words: [String] = []
        for t in tokens {
            let s = String(t)
            let lower = s.lowercased()
            if lower == "glm" { words.append("GLM") }
            else if lower == "gpt" { words.append("GPT") }
            else if lower == "claude" { words.append("Claude") }
            else if lower == "gemini" { words.append("Gemini") }
            else if lower == "gemma" || lower == "gemma3" { words.append(lower == "gemma3" ? "Gemma 3" : "Gemma") }
            else if lower == "deepseek" { words.append("DeepSeek") }
            else if lower == "qwen" || lower == "qwen3" || lower == "qwen2.5" { words.append(lower.capitalized) }
            else if lower == "kimi" { words.append("Kimi") }
            else if lower == "minimax" { words.append("MiniMax") }
            else if lower == "llama" { words.append("Llama") }
            else if lower == "codestral" { words.append("Codestral") }
            else if lower == "mistral" { words.append("Mistral") }
            else if lower == "grok" { words.append("Grok") }
            else if lower == "flash" { words.append("Flash") }
            else if lower == "pro" { words.append("Pro") }
            else if lower == "plus" { words.append("Plus") }
            else if lower == "turbo" { words.append("Turbo") }
            else if lower == "coder" { words.append("Coder") }
            else if lower == "reasoner" { words.append("Reasoner") }
            else if lower == "sonnet" { words.append("Sonnet") }
            else if lower == "haiku" { words.append("Haiku") }
            else if lower == "opus" { words.append("Opus") }
            else if lower == "sol" { words.append("Sol") }
            else if lower == "terra" { words.append("Terra") }
            else if lower == "luna" { words.append("Luna") }
            else if lower == "astra" { words.append("Astra") }
            else if lower == "solar" { words.append("Solar") }
            else if lower == "upstage" { words.append("Upstage") }
            else if lower == "cohere" { words.append("Cohere") }
            else if lower == "command" { words.append("Command") }
            else if lower == "sonar" { words.append("Sonar") }
            else if lower == "nova" { words.append("Nova") }
            else if lower == "perplexity" { words.append("Perplexity") }
            else if lower == "mini" { words.append("mini") }
            else if lower == "max" { words.append("Max") }
            else if lower == "air" { words.append("Air") }
            else if lower == "lite" { words.append("Lite") }
            else if lower == "ultra" { words.append("Ultra") }
            else if lower == "vision" { words.append("Vision") }
            else if lower == "thinking" { words.append("Thinking") }
            else if lower.hasPrefix("v") && lower.count <= 4 && Double(lower.dropFirst()) != nil {
                words.append("V" + lower.dropFirst())
            } else if lower.hasSuffix("b") && Double(lower.dropLast()) != nil {
                words.append(lower.dropLast() + "B")
            } else {
                words.append(s.prefix(1).uppercased() + s.dropFirst())
            }
        }
        return words.joined(separator: " ")
    }

    private static func canonicalIdentityUncached(provider: String, model: String) -> (family: String, displayName: String, providerId: String, providerName: String) {
        let p = provider.lowercased()
        let m = model.lowercased()
            .replacingOccurrences(of: "_", with: "-")
            .replacingOccurrences(of: ":latest", with: "")
            .replacingOccurrences(of: ":", with: "-")

        // 1. Google Gemini, Gemma, Imagen & Veo (dynamic auto-discovery for all 3.x, 2.x, 1.x releases)
        if p.contains("google") || p.contains("vertex") || m.contains("gemini") || m.contains("gemma") || m.contains("imagen") || m.contains("veo") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            var family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
                .replacingOccurrences(of: "-thinking", with: "")
                .replacingOccurrences(of: "-exp", with: "")
                .replacingOccurrences(of: "-customtools", with: "")
            family = family
                .replacingOccurrences(of: "gemini-3-7-", with: "gemini-3.7-")
                .replacingOccurrences(of: "gemini-3-5-", with: "gemini-3.5-")
                .replacingOccurrences(of: "gemini-3-1-", with: "gemini-3.1-")
                .replacingOccurrences(of: "gemini-2-5-", with: "gemini-2.5-")
                .replacingOccurrences(of: "gemini-2-0-", with: "gemini-2.0-")
                .replacingOccurrences(of: "gemini-1-5-", with: "gemini-1.5-")
            let name = formatModelDisplayName(family)
            return (family, name, "google", "Google")
        }

        // 2. Zhipu GLM Models (dynamic for releases like glm-5.3-flash, glm-5.3, glm-4-plus, glm-4-air, etc.)
        if p.contains("glm") || p.contains("zai") || p.contains("zhipu") || m.contains("glm") || m.contains("codegeex") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            let name = formatModelDisplayName(family)
            return (family, name, "glm", "Zhipu AI")
        }

        // 3. Anthropic Claude Models (dynamic for all Claude 3.7, 3.5, 4.x, Sonnet, Opus, Haiku)
        if p.contains("anthropic") || p.contains("claude") || m.contains("claude") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            var family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            family = family
                .replacingOccurrences(of: "claude-3-7-", with: "claude-3.7-")
                .replacingOccurrences(of: "claude-3-5-", with: "claude-3.5-")
            let name = formatModelDisplayName(family)
            return (family, name, "anthropic", "Anthropic")
        }

        // 4. Upstage Solar Models (dynamic auto-discovery for solar-pro, solar-mini, etc.)
        if p.contains("upstage") || m.contains("solar") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
                .replacingOccurrences(of: "upstage-", with: "")
            let name = formatModelDisplayName(family)
            return (family, name, "upstage", "Upstage")
        }

        // 5. OpenAI Models (dynamic for GPT-6 Astra, GPT Daybreak, GPT Reserve, GPT-5.6 Sol, Terra, Luna, GPT-5, GPT-4o, GPT-4.5, o1, o3, o4)
        let isOpenAI = p.contains("openai") || p.contains("codex") || m.contains("gpt") || m.contains("chatgpt") || m.contains("astra") || m.contains("daybreak") || m.contains("reserve") || m.hasPrefix("o1") || m.hasPrefix("o3") || m.hasPrefix("o4") || ((m.contains("sol") || m.contains("terra") || m.contains("luna")) && (p.contains("openai") || p.contains("codex") || m.contains("gpt")))
        if isOpenAI {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            if family.contains("astra") {
                return ("gpt-6-astra", "GPT-6 Astra", "openai", "OpenAI")
            }
            if family.contains("daybreak") {
                return ("gpt-daybreak", "GPT Daybreak Blue", "openai", "OpenAI")
            }
            if family.contains("reserve") {
                return ("gpt-reserve", "GPT Reserve", "openai", "OpenAI")
            }
            if family.contains("5.6-sol") || family.contains("5-6-sol") || family.contains("56-sol") {
                return ("gpt-5.6-sol", "GPT-5.6 Sol", "openai", "OpenAI")
            }
            if (family.contains("gpt-5-sol") || family.contains("gpt-sol") || family.contains("-sol") || family == "sol") && !family.contains("solar") {
                return ("gpt-5-sol", "GPT-5 Sol", "openai", "OpenAI")
            }
            if family.contains("5.6-terra") || family.contains("5-6-terra") || family.contains("56-terra") {
                return ("gpt-5.6-terra", "GPT-5.6 Terra", "openai", "OpenAI")
            }
            if family.contains("terra") {
                return ("gpt-5-terra", "GPT-5 Terra", "openai", "OpenAI")
            }
            if family.contains("5.6-luna") || family.contains("5-6-luna") || family.contains("56-luna") {
                return ("gpt-5.6-luna", "GPT-5.6 Luna", "openai", "OpenAI")
            }
            if family.contains("luna") && !family.contains("lunaris") {
                return ("gpt-5-luna", "GPT-5 Luna", "openai", "OpenAI")
            }
            if family.contains("auto-review") {
                return ("codex-auto-review", "Codex Auto Review", "openai", "OpenAI")
            }
            let name = formatModelDisplayName(family)
            return (family, name, "openai", "OpenAI")
        }

        // 5. DeepSeek Models (dynamic for V4 Pro, V3, R1, Coder)
        if p.contains("deepseek") || m.contains("deepseek") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            let name = formatModelDisplayName(family)
            return (family, name, "deepseek", "DeepSeek")
        }

        // 6. Alibaba Qwen Models (dynamic for Qwen 3 Coder, 2.5, MoE)
        if p.contains("alibaba") || p.contains("qwen") || p.contains("bailian") || m.contains("qwen") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            var family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            family = family
                .replacingOccurrences(of: "qwen-3-", with: "qwen3-")
                .replacingOccurrences(of: "qwen-2-5-", with: "qwen2.5-")
            let name = formatModelDisplayName(family)
            return (family, name, "alibaba", "Alibaba Cloud")
        }

        // 7. Moonshot Kimi (dynamic for K2, 1.5, etc.)
        if p.contains("moonshot") || p.contains("kimi") || m.contains("kimi") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            let name = formatModelDisplayName(family)
            return (family, name, "kimi", "Moonshot Kimi")
        }

        // 8. MiniMax (dynamic for M3, 01, etc.)
        if p.contains("minimax") || m.contains("minimax") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            let name = formatModelDisplayName(family)
            return (family, name, "minimax", "MiniMax")
        }

        // 9. xAI Grok (dynamic for Grok 4, Grok 3, Grok 2)
        if p.contains("xai") || m.contains("grok") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            let name = formatModelDisplayName(family)
            return (family, name, "xai", "xAI")
        }

        // 10. Mistral & Codestral (dynamic)
        if p.contains("mistral") || m.contains("codestral") || m.contains("pixtral") || m.contains("mistral") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            let name = formatModelDisplayName(family)
            return (family, name, "mistral", "Mistral")
        }

        // 11. Meta LLaMA (dynamic)
        if p.contains("meta") || m.contains("llama") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            let name = formatModelDisplayName(family)
            return (family, name, "meta", "Meta")
        }

        // 12. Cohere Command & Embed
        if p.contains("cohere") || m.contains("command-r") || m.contains("command-light") || m.contains("cohere") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            let name = formatModelDisplayName(family)
            return (family, name, "cohere", "Cohere")
        }

        // 13. Amazon Nova
        if p.contains("amazon") || p.contains("bedrock") || m.contains("nova-") || m.contains("amazon-nova") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            let name = formatModelDisplayName(family)
            return (family, name, "amazon", "Amazon Web Services")
        }

        // 14. Perplexity Sonar
        if p.contains("perplexity") || m.contains("sonar") {
            let clean = m.split(separator: "/").last.map(String.init) ?? m
            let family = clean
                .replacingOccurrences(of: "-latest", with: "")
                .replacingOccurrences(of: "-preview", with: "")
            let name = formatModelDisplayName(family)
            return (family, name, "perplexity", "Perplexity")
        }

        // 15. OpenCode models
        if m.contains("muse-spark-1.3") { return ("muse-spark-1.3", "Muse Spark 1.3", "opencode", "OpenCode") }
        if m.contains("muse-spark") { return ("muse-spark-1.2", "Muse Spark 1.2", "opencode", "OpenCode") }
        if m.contains("nemotron") && m.contains("free") { return ("nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free", "opencode", "OpenCode") }
        if m.contains("mimo") && m.contains("free") { return ("mimo-v2.5-free", "MiMo 2.5 Free", "opencode", "OpenCode") }
        if m.contains("ling") && m.contains("free") { return ("ling-3.0-flash-fin-free", "Ling 3.0 Flash Fin Free", "opencode", "OpenCode") }
        if m.contains("big-pickle") { return ("big-pickle", "Big Pickle", "opencode", "OpenCode") }
        if m.contains("x-preview") { return ("x-preview-f-free", "x-Preview-f Free (Deprecated)", "opencode", "OpenCode") }
        if m.contains("ox-alpha") { return ("ox-alpha-free", "OX-Alpha Free (Deprecated)", "opencode", "OpenCode") }

        // 16. Local custom models (e.g. ornith-1.5:35b)
        if m.contains("ornith") { return ("ornith-1.5-35b", "Ornith 1.5 35B", "ollama", "Ollama (Local)") }

        // Default: clean ID and provider
        let lastPart = model.split(separator: "/").last.map(String.init) ?? model
        let clean = lastPart.replacingOccurrences(of: ":", with: "-")
        return ("\(p)-\(clean.lowercased())", lastPart, p, provider)
    }

    static func docUrl(for provider: String, model: String, catalogEntry: Entry? = nil) -> URL? {
        if let direct = catalogEntry?.docUrl, let u = URL(string: direct), !direct.isEmpty {
            return u
        }
        let p = provider.lowercased()
        let m = model.lowercased()
        // Local models first: an ollama-hosted qwen/gemma model must resolve
        // to the Ollama library, not the vendor docs matched below.
        if p.contains("ollama") {
            let base = m.components(separatedBy: ":").first ?? m
            return URL(string: "https://ollama.com/library/\(base)")
        }
        if p.contains("anthropic") || p.contains("claude") {
            return URL(string: "https://docs.anthropic.com/en/docs/about-claude/models")
        }
        if p.contains("openai") || p.contains("codex") || m.contains("gpt") || m.hasPrefix("o1") || m.hasPrefix("o3") {
            return URL(string: "https://platform.openai.com/docs/models")
        }
        if p.contains("google") || p.contains("gemini") || m.contains("gemini") {
            return URL(string: "https://ai.google.dev/gemini-api/docs/models")
        }
        if p.contains("deepseek") || m.contains("deepseek") {
            return URL(string: "https://api-docs.deepseek.com/quick_start/pricing")
        }
        if p.contains("alibaba") || p.contains("qwen") || p.contains("bailian") || m.contains("qwen") {
            return URL(string: "https://www.alibabacloud.com/help/en/model-studio/developer-reference/what-is-qwen-llm")
        }
        if p.contains("kimi") || p.contains("moonshot") {
            return URL(string: "https://platform.moonshot.cn/docs/")
        }
        if p.contains("glm") || p.contains("zai") || p.contains("zhipu") {
            return URL(string: "https://open.bigmodel.cn/dev/api")
        }
        if p.contains("minimax") {
            return URL(string: "https://platform.minimaxi.com/document/")
        }
        if p.contains("xai") || p.contains("grok") {
            return URL(string: "https://docs.x.ai/docs/models")
        }
        if p.contains("mistral") {
            return URL(string: "https://docs.mistral.ai/getting-started/models/")
        }
        if p.contains("opencode") || p.contains("muse") {
            return URL(string: "https://opencode.ai")
        }
        return URL(string: "https://models.dev")
    }

    static func fetchAndMerge() {
        let cachePath = NSString(string: "~/.config/token-horizon/models-cache.json").expandingTildeInPath
        let bm = loadBenchmarks()
        let catalog = ModelCatalog.shared
        // Try remote with a bounded timeout (was blocking Data(contentsOf:)
        // with no timeout — a stalled models.dev fetch could hang the utility
        // queue and delay pricing updates indefinitely).
        if let url = URL(string: "https://models.dev/api.json"),
           let obj = Self.fetchJSON(url: url, timeout: 15) as? [String: Any] {
            var map: [String: Entry] = [:]
            for (providerId, provAny) in obj {
                guard let prov = provAny as? [String: Any] else { continue }
                let providerName = prov["name"] as? String ?? providerId
                let provDoc = prov["doc"] as? String
                let models = prov["models"] as? [String: Any] ?? [:]
                for (modelId, mAny) in models {
                    guard let m = mAny as? [String: Any] else { continue }
                    let cost = m["cost"] as? [String: Any] ?? [:]
                    let limit = m["limit"] as? [String: Any] ?? [:]
                    let key = "\(providerId)/\(modelId)".lowercased()
                    let norm = modelId.lowercased().replacingOccurrences(of: "_", with: "-")
                    let bench = bm[norm] ?? bm[key] ?? bm[modelId.lowercased()]
                    let doc = (m["doc"] as? String) ?? provDoc
                    let cacheRead = (cost["cache_read"] as? NSNumber)?.doubleValue
                    let reasoning = m["reasoning"] as? Bool
                    let toolCall = m["tool_call"] as? Bool
                    let desc = m["description"] as? String
                    let openWeights = m["open_weights"] as? Bool
                    let modalities = (m["modalities"] as? [String: Any])?["input"] as? [String] ?? []
                    let vision = modalities.contains("image") || modalities.contains("vision")
                    map[key] = Entry(id: modelId,
                                     name: bench?.name ?? (m["name"] as? String) ?? modelId,
                                     provider: providerId,
                                     providerName: providerName,
                                     inputPerM: (cost["input"] as? NSNumber)?.doubleValue ?? 0,
                                     outputPerM: (cost["output"] as? NSNumber)?.doubleValue ?? 0,
                                     cacheReadPerM: cacheRead,
                                     contextK: ((limit["context"] as? NSNumber)?.intValue ?? 0) / 1000,
                                     benchmarks: bench.map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) },
                                     docUrl: doc,
                                     description: desc,
                                     reasoning: reasoning,
                                     toolCall: toolCall,
                                     vision: vision,
                                     openWeights: openWeights)
                }
            }
            injectDirectFlagships(into: &map, benchmarks: bm)
            fetchCodexCachedModels(into: &map, benchmarks: bm)
            fetchLiveZaiModels(into: &map, benchmarks: bm)
            fetchLiveOpenAIModels(into: &map, benchmarks: bm)
            fetchLiveDeepSeekModels(into: &map, benchmarks: bm)
            fetchLiveAnthropicModels(into: &map, benchmarks: bm)
            fetchLiveGeminiModels(into: &map, benchmarks: bm)
            fetchLiveOpenRouterModels(into: &map, benchmarks: bm)
            if let enc = try? JSONEncoder().encode(map) {
                try? enc.write(to: URL(fileURLWithPath: cachePath))
            }
            catalog.lock.lock(); catalog.byId = map; catalog.revision += 1; catalog.lastFetch = Date(); catalog.lock.unlock()
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .refreshModelExtras, object: nil)
            }
            return
        }

        if let data = try? Data(contentsOf: URL(fileURLWithPath: cachePath)),
           var decoded = try? JSONDecoder().decode([String: Entry].self, from: data) {
            injectDirectFlagships(into: &decoded, benchmarks: bm)
            fetchCodexCachedModels(into: &decoded, benchmarks: bm)
            fetchLiveZaiModels(into: &decoded, benchmarks: bm)
            fetchLiveOpenAIModels(into: &decoded, benchmarks: bm)
            fetchLiveDeepSeekModels(into: &decoded, benchmarks: bm)
            fetchLiveAnthropicModels(into: &decoded, benchmarks: bm)
            fetchLiveGeminiModels(into: &decoded, benchmarks: bm)
            fetchLiveOpenRouterModels(into: &decoded, benchmarks: bm)
            catalog.lock.lock(); catalog.byId = decoded; catalog.revision += 1; catalog.lastFetch = Date(); catalog.lock.unlock()
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .refreshModelExtras, object: nil)
            }
            return
        }

        // Bundle fallback directly from benchmarks.json
        var fallbackMap: [String: Entry] = [:]
        for (k, v) in bm {
            let p = inferProvider(from: k)
            fallbackMap[k] = Entry(id: k, name: v.name, provider: p.id, providerName: p.name,
                                   inputPerM: 0, outputPerM: 0, contextK: 128,
                                   benchmarks: Benchmarks(swe: v.swe, lcb: v.lcb, source: v.source),
                                   docUrl: nil, description: nil)
        }
        injectDirectFlagships(into: &fallbackMap, benchmarks: bm)
        fetchCodexCachedModels(into: &fallbackMap, benchmarks: bm)
        fetchLiveZaiModels(into: &fallbackMap, benchmarks: bm)
        fetchLiveOpenAIModels(into: &fallbackMap, benchmarks: bm)
        fetchLiveDeepSeekModels(into: &fallbackMap, benchmarks: bm)
        fetchLiveAnthropicModels(into: &fallbackMap, benchmarks: bm)
        fetchLiveGeminiModels(into: &fallbackMap, benchmarks: bm)
            fetchLiveOpenRouterModels(into: &fallbackMap, benchmarks: bm)
        catalog.lock.lock(); catalog.byId = fallbackMap; catalog.revision += 1; catalog.lastFetch = Date(); catalog.lock.unlock()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .refreshModelExtras, object: nil)
        }
    }

    /// Bounded synchronous JSON GET for background catalog refresh. Returns the
    /// parsed object or nil on timeout/non-2xx/invalid JSON. Must only be called
    /// off-main (all fetchAndMerge paths run on a utility queue).
    static func fetchJSON(url: URL, timeout: TimeInterval) -> Any? {
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        var result: Any?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            defer { sema.signal() }
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let d, let obj = try? JSONSerialization.jsonObject(with: d) else { return }
            result = obj
        }.resume()
        _ = sema.wait(timeout: .now() + timeout + 2)
        return result
    }

    /// Bounded synchronous text GET for background pricing scrapes.
    static func fetchText(url: URL, timeout: TimeInterval) -> String? {
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.setValue("text/html,*/*", forHTTPHeaderField: "Accept")
        var result: String?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            defer { sema.signal() }
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let d, let s = String(data: d, encoding: .utf8) else { return }
            result = s
        }.resume()
        _ = sema.wait(timeout: .now() + timeout + 2)
        return result
    }

    static func injectDirectFlagships(into map: inout [String: Entry], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
        let flagships: [Entry] = [
            Entry(id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai", providerName: "OpenAI",
                  inputPerM: 10.00, outputPerM: 50.00, cacheReadPerM: 1.00, contextK: 872,
                  benchmarks: benchmarks["gpt-6-astra"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 85.2, lcb: 81.0, source: "OpenAI"),
                  docUrl: "https://platform.openai.com/docs/models", description: "OpenAI premier frontier flagship model for complex coding, computer use & autonomous agents (90% prompt cache savings)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 90, discountLabel: "-90% CACHED", discountDetail: "90% prompt cache savings ($10.00 → $1.00 / 1M cache read)"),
            Entry(id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", providerName: "OpenAI",
                  inputPerM: 2.50, outputPerM: 10.00, cacheReadPerM: 0.50, contextK: 1050,
                  benchmarks: benchmarks["gpt-5.6-sol"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 83.0, lcb: 80.0, source: "OpenAI"),
                  docUrl: "https://platform.openai.com/docs/models", description: "OpenAI premier flagship tier for complex reasoning & multi-step coding agents (50% promo reduction)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 50, discountLabel: "-50% PROMO", discountDetail: "50% promotional reduction ($5.00 → $2.50 / 1M input, $20.00 → $10.00 / 1M output)",
                  originalInputPerM: 5.00, originalOutputPerM: 20.00),
            Entry(id: "gpt-5-sol", name: "GPT-5 Sol", provider: "openai", providerName: "OpenAI",
                  inputPerM: 2.50, outputPerM: 10.00, cacheReadPerM: 0.50, contextK: 256,
                  benchmarks: benchmarks["gpt-5-sol"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 81.5, lcb: 78.0, source: "OpenAI"),
                  docUrl: "https://platform.openai.com/docs/models", description: "OpenAI premier flagship tier for complex reasoning & multi-step coding agents (50% promo reduction)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 50, discountLabel: "-50% PROMO", discountDetail: "50% promotional reduction ($5.00 → $2.50 / 1M input, $20.00 → $10.00 / 1M output)",
                  originalInputPerM: 5.00, originalOutputPerM: 20.00),
            Entry(id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai", providerName: "OpenAI",
                  inputPerM: 1.20, outputPerM: 4.80, cacheReadPerM: 0.15, contextK: 1050,
                  benchmarks: benchmarks["gpt-5.6-terra"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 74.0, lcb: 70.0, source: "OpenAI"),
                  docUrl: "https://platform.openai.com/docs/models", description: "OpenAI balanced all-rounder tier for daily professional workflows (20% promo reduction)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 20, discountLabel: "-20% PROMO", discountDetail: "20% promotional reduction ($1.50 → $1.20 / 1M input, $6.00 → $4.80 / 1M output)",
                  originalInputPerM: 1.50, originalOutputPerM: 6.00),
            Entry(id: "gpt-5-terra", name: "GPT-5 Terra", provider: "openai", providerName: "OpenAI",
                  inputPerM: 1.20, outputPerM: 4.80, cacheReadPerM: 0.15, contextK: 256,
                  benchmarks: benchmarks["gpt-5-terra"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 72.0, lcb: 68.5, source: "OpenAI"),
                  docUrl: "https://platform.openai.com/docs/models", description: "OpenAI balanced all-rounder tier for daily professional workflows (20% promo reduction)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 20, discountLabel: "-20% PROMO", discountDetail: "20% promotional reduction ($1.50 → $1.20 / 1M input, $6.00 → $4.80 / 1M output)",
                  originalInputPerM: 1.50, originalOutputPerM: 6.00),
            Entry(id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", providerName: "OpenAI",
                  inputPerM: 0.10, outputPerM: 0.40, cacheReadPerM: 0.025, contextK: 1050,
                  benchmarks: benchmarks["gpt-5.6-luna"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 54.0, lcb: 52.0, source: "OpenAI"),
                  docUrl: "https://platform.openai.com/docs/models", description: "OpenAI high-speed lightweight tier for fast summaries & cost-sensitive tasks",
                  reasoning: true, toolCall: true, vision: true, openWeights: false),
            Entry(id: "gpt-5-luna", name: "GPT-5 Luna", provider: "openai", providerName: "OpenAI",
                  inputPerM: 0.10, outputPerM: 0.40, cacheReadPerM: 0.025, contextK: 128,
                  benchmarks: benchmarks["gpt-5-luna"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 52.0, lcb: 50.0, source: "OpenAI"),
                  docUrl: "https://platform.openai.com/docs/models", description: "OpenAI high-speed lightweight tier for fast summaries & cost-sensitive tasks",
                  reasoning: true, toolCall: true, vision: true, openWeights: false),
            Entry(id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", provider: "google", providerName: "Google",
                  inputPerM: 0.15, outputPerM: 0.60, cacheReadPerM: 0.038, contextK: 1000,
                  benchmarks: benchmarks["gemini-3.7-flash"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 67.0, lcb: 65.0, source: "Google"),
                  docUrl: "https://ai.google.dev/pricing", description: "Google next-gen hybrid reasoning & coding flash model (75% context caching savings)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 75, discountLabel: "-75% CACHED", discountDetail: "75% context caching discount ($0.15 → $0.038 / 1M cache read)"),
            Entry(id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", provider: "google", providerName: "Google",
                  inputPerM: 0.15, outputPerM: 0.60, cacheReadPerM: 0.038, contextK: 1000,
                  benchmarks: benchmarks["gemini-3.5-flash"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 65.0, lcb: 62.0, source: "Google"),
                  docUrl: "https://ai.google.dev/pricing", description: "Google high-speed multimodal reasoning model",
                  reasoning: true, toolCall: true, vision: true, openWeights: false),
            Entry(id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google", providerName: "Google",
                  inputPerM: 1.25, outputPerM: 5.00, cacheReadPerM: 0.31, contextK: 2000,
                  benchmarks: benchmarks["gemini-2.5-pro"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 63.8, lcb: 60.5, source: "Google"),
                  docUrl: "https://ai.google.dev/pricing", description: "Google premier frontier multimodal reasoning model",
                  reasoning: true, toolCall: true, vision: true, openWeights: false),
            Entry(id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google", providerName: "Google",
                  inputPerM: 0.15, outputPerM: 0.60, cacheReadPerM: 0.038, contextK: 1000,
                  benchmarks: benchmarks["gemini-2.5-flash"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 55.0, lcb: 54.0, source: "Google"),
                  docUrl: "https://ai.google.dev/pricing", description: "Google high-performance multimodal flash model",
                  reasoning: true, toolCall: true, vision: true, openWeights: false),
            Entry(id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "deepseek", providerName: "DeepSeek",
                  inputPerM: 0.15, outputPerM: 0.60, cacheReadPerM: 0.003, contextK: 1000,
                  benchmarks: benchmarks["deepseek-v4.1-flash"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 78.0, lcb: 74.0, source: "DeepSeek"),
                  docUrl: "https://api-docs.deepseek.com/quick_start/pricing", description: "DeepSeek current flagship (off-peak shown; peak 2x; surpasses V4 Pro, faster + cheaper)",
                  reasoning: true, toolCall: true, vision: true, openWeights: true),
            Entry(id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro", provider: "deepseek", providerName: "DeepSeek",
                  inputPerM: 0.66, outputPerM: 1.98, cacheReadPerM: 0.022, contextK: 1000,
                  benchmarks: benchmarks["deepseek-v4-pro-0813"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? benchmarks["deepseek-v4-pro"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 72.0, lcb: 68.0, source: "DeepSeek"),
                  docUrl: "https://api-docs.deepseek.com/quick_start/pricing", description: "DeepSeek V4 Pro 0813 (off-peak shown; peak 2x; routes to V4.1 Flash from 2026-09-14 billed at Flash)",
                  reasoning: true, toolCall: true, vision: false, openWeights: true),
            Entry(id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic", providerName: "Anthropic",
                  inputPerM: 10.00, outputPerM: 50.00, cacheReadPerM: 0.25, contextK: 1000,
                  benchmarks: benchmarks["claude-fable-5-1"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 84.0, lcb: 80.5, source: "Anthropic"),
                  docUrl: "https://docs.anthropic.com/en/docs/about-claude/models", description: "Anthropic frontier reasoning & software engineering model (97.5% prompt cache savings)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 90, discountLabel: "-90% CACHED", discountDetail: "97.5% prompt cache read discount ($10.00 → $0.25 / 1M)"),
            Entry(id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic", providerName: "Anthropic",
                  inputPerM: 5.00, outputPerM: 25.00, cacheReadPerM: 0.50, contextK: 1000,
                  benchmarks: benchmarks["claude-opus-5"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 82.0, lcb: 79.0, source: "Anthropic"),
                  docUrl: "https://docs.anthropic.com/en/docs/about-claude/models", description: "Anthropic premier flagship for autonomous coding & deep architecture (90% prompt cache savings)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 90, discountLabel: "-90% CACHED", discountDetail: "90% prompt cache read discount ($5.00 → $0.50 / 1M)"),
            Entry(id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic", providerName: "Anthropic",
                  inputPerM: 5.00, outputPerM: 25.00, cacheReadPerM: 0.50, contextK: 1000,
                  benchmarks: benchmarks["claude-opus-4-6"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 76.5, lcb: 74.0, source: "Anthropic"),
                  docUrl: "https://docs.anthropic.com/en/docs/about-claude/models", description: "Anthropic flagship model for complex coding & architecture (90% prompt cache savings)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 90, discountLabel: "-90% CACHED", discountDetail: "90% prompt cache read discount ($5.00 → $0.50 / 1M)"),
            Entry(id: "claude-3.7-sonnet", name: "Claude 3.7 Sonnet", provider: "anthropic", providerName: "Anthropic",
                  inputPerM: 3.00, outputPerM: 15.00, cacheReadPerM: 0.30, contextK: 200,
                  benchmarks: benchmarks["claude-3.7-sonnet"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 70.3, lcb: 71.0, source: "Anthropic"),
                  docUrl: "https://docs.anthropic.com/en/docs/about-claude/models", description: "Anthropic premier industry benchmark model for coding & agentic workflows (90% prompt cache savings)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 90, discountLabel: "-90% CACHED", discountDetail: "90% prompt cache read discount ($3.00 → $0.30 / 1M)"),
            Entry(id: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet", provider: "anthropic", providerName: "Anthropic",
                  inputPerM: 3.00, outputPerM: 15.00, cacheReadPerM: 0.30, contextK: 200,
                  benchmarks: benchmarks["claude-3.5-sonnet"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 65.0, lcb: 67.0, source: "Anthropic"),
                  docUrl: "https://docs.anthropic.com/en/docs/about-claude/models", description: "Anthropic premier all-rounder model for coding & agents (90% prompt cache savings)",
                  reasoning: false, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 90, discountLabel: "-90% CACHED", discountDetail: "90% prompt cache read discount ($3.00 → $0.30 / 1M)"),
            Entry(id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", providerName: "Anthropic",
                  inputPerM: 1.00, outputPerM: 5.00, cacheReadPerM: 0.10, contextK: 200,
                  benchmarks: benchmarks["claude-haiku-4-5"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 40.6, lcb: 43.1, source: "Anthropic"),
                  docUrl: "https://docs.anthropic.com/en/docs/about-claude/models", description: "Anthropic high-speed lightweight model for quick tasks & summaries",
                  reasoning: false, toolCall: true, vision: true, openWeights: false),
            Entry(id: "claude-3.5-haiku", name: "Claude 3.5 Haiku", provider: "anthropic", providerName: "Anthropic",
                  inputPerM: 0.80, outputPerM: 4.00, cacheReadPerM: 0.08, contextK: 200,
                  benchmarks: benchmarks["claude-3.5-haiku"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 40.6, lcb: 43.1, source: "Anthropic"),
                  docUrl: "https://docs.anthropic.com/en/docs/about-claude/models", description: "Anthropic high-speed lightweight model for cost-sensitive tasks",
                  reasoning: false, toolCall: true, vision: true, openWeights: false)
        ]
        for f in flagships {
            let key = "\(f.provider)/\(f.id)".lowercased()
            map[key] = f
            map[f.id.lowercased()] = f
        }
        applyDeepSeekAuthoritativeOverlay(into: &map, benchmarks: benchmarks)
    }

    /// Overwrites stale models.dev DeepSeek rows (which lag official pricing and
    /// lack V4.1) with authoritative https://api-docs.deepseek.com/quick_start/pricing
    /// values (off-peak base; peak 2x). Runs inside injectDirectFlagships so every
    /// load path — fast-local, cache, remote, fallback — gets correct pricing.
    static func applyDeepSeekAuthoritativeOverlay(into map: inout [String: Entry], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
        let flashBench = benchmarks["deepseek-v4.1-flash"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 78.0, lcb: 74.0, source: "DeepSeek")
        let proBench = benchmarks["deepseek-v4-pro-0813"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? benchmarks["deepseek-v4-pro"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 72.0, lcb: 68.0, source: "DeepSeek")
        func flashEntry(id: String, name: String) -> Entry {
            Entry(id: id, name: name, provider: "deepseek", providerName: "DeepSeek",
                  inputPerM: 0.15, outputPerM: 0.60, cacheReadPerM: 0.003, contextK: 1000,
                  benchmarks: flashBench,
                  docUrl: "https://api-docs.deepseek.com/quick_start/pricing",
                  description: "DeepSeek V4.1 Flash (off-peak shown; peak 2x; legacy alias routes to V4.1-Flash)",
                  reasoning: true, toolCall: true, vision: true, openWeights: true)
        }
        func proEntry(id: String, name: String) -> Entry {
            Entry(id: id, name: name, provider: "deepseek", providerName: "DeepSeek",
                  inputPerM: 0.66, outputPerM: 1.98, cacheReadPerM: 0.022, contextK: 1000,
                  benchmarks: proBench,
                  docUrl: "https://api-docs.deepseek.com/quick_start/pricing",
                  description: "DeepSeek V4 Pro 0813 (off-peak shown; peak 2x; routes to V4.1 Flash from 2026-09-14 billed at Flash)",
                  reasoning: true, toolCall: true, vision: false, openWeights: true)
        }
        // Legacy aliases that DeepSeek routes to V4.1-Flash (docs footnote 1).
        for alias in ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v4-flash-vision-exp", "deepseek/deepseek-flash", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4-flash-vision-exp"] {
            map[alias] = flashEntry(id: alias.contains("/") ? String(alias.split(separator: "/").last ?? "deepseek-v4.1-flash") : alias, name: "DeepSeek V4.1 Flash")
        }
        // Stale models.dev Pro rows → authoritative Pro pricing + 1M context.
        for key in ["deepseek-v4-pro", "deepseek/deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek/deepseek-v4-pro-0813", "deepseek-v4-pro-0423", "deepseek/deepseek-v4-pro-0423"] {
            let base = key.contains("/") ? String(key.split(separator: "/").last ?? "deepseek-v4-pro-0813") : key
            map[key] = proEntry(id: base, name: "DeepSeek V4 Pro")
        }
    }

    static func fetchLiveZaiModels(into map: inout [String: Entry], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
        let keys = PlanLimitsEngine.authKeys()
        guard let key = keys["zai-coding-plan"] ?? keys["zai"], !key.isEmpty else { return }
        guard let u = URL(string: "https://open.bigmodel.cn/api/paas/v4/models") else { return }
        var req = URLRequest(url: u, timeoutInterval: 5.0)
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 5) == .timedOut { return }
        guard let data, let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let list = obj["data"] as? [[String: Any]] else { return }
        for item in list {
            guard let modelId = item["id"] as? String, !modelId.isEmpty else { continue }
            let key = "glm/\(modelId)".lowercased()
            let canon = canonicalIdentity(provider: "glm", model: modelId)
            let bench = benchmarks[modelId.lowercased()] ?? benchmarks[canon.family]

            let isFlash = modelId.lowercased().contains("flash")
            let isAirOrTurbo = modelId.lowercased().contains("air") || modelId.lowercased().contains("turbo")
            let inCost: Double
            let outCost: Double
            let cacheCost: Double
            if isFlash {
                inCost = 0.01
                outCost = 0.01
                cacheCost = 0.005
            } else if isAirOrTurbo {
                inCost = 0.14
                outCost = 0.14
                cacheCost = 0.03
            } else {
                inCost = 0.70
                outCost = 0.70
                cacheCost = 0.14
            }

            if map[key] == nil {
                map[key] = Entry(
                    id: modelId,
                    name: bench?.name ?? canon.displayName,
                    provider: "glm",
                    providerName: "Zhipu AI",
                    inputPerM: inCost,
                    outputPerM: outCost,
                    cacheReadPerM: cacheCost,
                    contextK: 128,
                    benchmarks: bench.map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) },
                    docUrl: "https://open.bigmodel.cn/dev/api",
                    description: "Discovered via live Zhipu GLM API",
                    reasoning: modelId.contains("5") || modelId.contains("reasoner"),
                    toolCall: true,
                    vision: modelId.contains("v") || isFlash
                )
            }
        }
    }

    /// Dynamically ingests newly released models and context windows from Codex CLI cache (~/.codex/models_cache.json).
    /// Discovers cutting-edge OpenAI models like GPT-6 Astra, Daybreak, GPT-5.6 Sol/Terra/Luna with live net pricing.
    static func fetchCodexCachedModels(into map: inout [String: Entry], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
        let candidates = [
            NSString("~/.codex/models_cache.json").expandingTildeInPath,
            NSString("~/.config/codex/models_cache.json").expandingTildeInPath,
        ]
        for path in candidates {
            guard FileManager.default.fileExists(atPath: path),
                  let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let list = obj["models"] as? [[String: Any]] else { continue }

            for item in list {
                guard let slug = (item["slug"] as? String) ?? (item["name"] as? String), !slug.isEmpty else { continue }
                let dispName = item["display_name"] as? String
                let maxCtx = item["max_context_window"] as? Int ?? 128000
                let contextK = max(128, maxCtx / 1000)
                let canon = canonicalIdentity(provider: "openai", model: slug)
                let bench = benchmarks[slug.lowercased()] ?? benchmarks[canon.family]
                let lower = slug.lowercased()

                let inCost: Double
                let outCost: Double
                let cacheCost: Double
                var origIn: Double? = nil
                var origOut: Double? = nil
                var discPct: Int? = nil
                var discLbl: String? = nil
                var discDet: String? = nil

                if lower.contains("astra") || lower.contains("gpt-6-astra") {
                    inCost = 10.00
                    outCost = 50.00
                    cacheCost = 1.00
                    discPct = 90
                    discLbl = "-90% CACHED"
                    discDet = "90% prompt caching discount ($10.00 → $1.00 / 1M cache read)"
                } else if lower.contains("daybreak") {
                    inCost = 10.00
                    outCost = 50.00
                    cacheCost = 1.00
                    discPct = 90
                    discLbl = "-90% CACHED"
                    discDet = "90% prompt caching discount ($10.00 → $1.00 / 1M cache read)"
                } else if lower.contains("sol") || lower.contains("gpt-reserve") {
                    inCost = 2.50
                    outCost = 10.00
                    cacheCost = 0.50
                    origIn = 5.00
                    origOut = 20.00
                    discPct = 50
                    discLbl = "-50% PROMO"
                    discDet = "50% promotional reduction ($5.00 → $2.50 in / $20.00 → $10.00 out)"
                } else if lower.contains("terra") || lower.contains("codex-auto-review") {
                    inCost = 1.20
                    outCost = 4.80
                    cacheCost = 0.15
                    origIn = 1.50
                    origOut = 6.00
                    discPct = 20
                    discLbl = "-20% PROMO"
                    discDet = "20% promotional reduction ($1.50 → $1.20 in / $6.00 → $4.80 out)"
                } else if lower.contains("luna") {
                    inCost = 0.10
                    outCost = 0.40
                    cacheCost = 0.025
                } else if lower.contains("5.5") {
                    inCost = 2.00
                    outCost = 8.00
                    cacheCost = 0.40
                } else if lower.contains("mini") {
                    inCost = 0.25
                    outCost = 1.00
                    cacheCost = 0.05
                } else if lower.contains("spark") {
                    inCost = 0.50
                    outCost = 2.00
                    cacheCost = 0.10
                } else {
                    inCost = 2.50
                    outCost = 10.00
                    cacheCost = 0.50
                }

                let modelName = lower.contains("astra") ? "GPT-6 Astra" : (bench?.name ?? (dispName != nil && !dispName!.isEmpty ? formatModelDisplayName(dispName!) : canon.displayName))

                let entry = Entry(
                    id: slug,
                    name: modelName,
                    provider: "openai",
                    providerName: "OpenAI",
                    inputPerM: inCost,
                    outputPerM: outCost,
                    cacheReadPerM: cacheCost,
                    contextK: contextK,
                    benchmarks: bench.map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) },
                    docUrl: "https://platform.openai.com/docs/models",
                    description: "Dynamically discovered OpenAI model from live Codex runtime (\(dispName ?? slug))",
                    reasoning: true,
                    toolCall: true,
                    vision: true,
                    openWeights: false,
                    discountPercent: discPct,
                    discountLabel: discLbl,
                    discountDetail: discDet,
                    originalInputPerM: origIn,
                    originalOutputPerM: origOut
                )

                let key1 = "openai/\(slug)".lowercased()
                let key2 = slug.lowercased()
                map[key1] = entry
                map[key2] = entry
            }
            break
        }
    }

    /// Dynamically queries OpenAI API models endpoint if credentials are present.
    static func fetchLiveOpenAIModels(into map: inout [String: Entry], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
        let keys = PlanLimitsEngine.authKeys()
        let envKey = ProcessInfo.processInfo.environment["OPENAI_API_KEY"]
        var token = envKey ?? keys["openai"]
        if token == nil || token!.isEmpty {
            let path = ProcessInfo.processInfo.environment["OPENCODE_AUTH"]
                ?? NSString(string: "~/.local/share/opencode/auth.json").expandingTildeInPath
            if let data = FileManager.default.contents(atPath: path),
               let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let entry = root["openai"] as? [String: Any] {
                token = (entry["access"] as? String) ?? (entry["key"] as? String)
            }
        }
        guard let token, !token.isEmpty else { return }

        guard let u = URL(string: "https://api.openai.com/v1/models") else { return }
        var req = URLRequest(url: u, timeoutInterval: 4.0)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 4) == .timedOut { return }
        guard let data, let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let list = obj["data"] as? [[String: Any]] else { return }

        for item in list {
            guard let modelId = item["id"] as? String, !modelId.isEmpty else { continue }
            let lower = modelId.lowercased()
            guard lower.contains("gpt") || lower.contains("astra") || lower.contains("o1") || lower.contains("o3") || lower.contains("o4") else { continue }
            let canon = canonicalIdentity(provider: "openai", model: modelId)
            let bench = benchmarks[lower] ?? benchmarks[canon.family]

            let inCost: Double = lower.contains("astra") ? 10.00 : (lower.contains("sol") ? 2.50 : (lower.contains("terra") ? 1.20 : 0.15))
            let outCost: Double = lower.contains("astra") ? 50.00 : (lower.contains("sol") ? 10.00 : (lower.contains("terra") ? 4.80 : 0.60))
            let cacheCost: Double = lower.contains("astra") ? 1.00 : (lower.contains("sol") ? 0.50 : (lower.contains("terra") ? 0.15 : 0.038))

            let key = "openai/\(modelId)".lowercased()
            if map[key] == nil {
                map[key] = Entry(
                    id: modelId,
                    name: bench?.name ?? canon.displayName,
                    provider: "openai",
                    providerName: "OpenAI",
                    inputPerM: inCost,
                    outputPerM: outCost,
                    cacheReadPerM: cacheCost,
                    contextK: lower.contains("astra") ? 872 : 256,
                    benchmarks: bench.map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) },
                    docUrl: "https://platform.openai.com/docs/models",
                    description: "Discovered via live OpenAI API (\(modelId))",
                    reasoning: true,
                    toolCall: true,
                    vision: true,
                    openWeights: false,
                    discountPercent: lower.contains("astra") ? 90 : (lower.contains("sol") ? 50 : nil),
                    discountLabel: lower.contains("astra") ? "-90% CACHED" : (lower.contains("sol") ? "-50% PROMO" : nil),
                    originalInputPerM: lower.contains("sol") ? 5.00 : nil,
                    originalOutputPerM: lower.contains("sol") ? 20.00 : nil
                )
            }
        }
    }

    /// DeepSeek: authoritative pricing overlay + live model enumeration.
    /// models.dev lags official pricing and lacks V4.1, so this runs on every
    /// refresh path (no auth needed for the pricing page; /models needs a key):
    /// 1. Scrape https://api-docs.deepseek.com/quick_start/pricing for current
    ///    Flash/Pro $/1M figures and apply them when they parse sanely.
    /// 2. If DEEPSEEK_API_KEY (or opencode `deepseek` key) exists, list
    ///    https://api.deepseek.com/models so brand-new ids appear immediately
    ///    with tier-estimated pricing until docs/models.dev confirm.
    static func fetchLiveDeepSeekModels(into map: inout [String: Entry], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
        if let pricing = Self.scrapeDeepSeekPricing() {
            Self.applyDeepSeekScrapedPricing(into: &map, pricing: pricing, benchmarks: benchmarks)
        }
        let keys = PlanLimitsEngine.authKeys()
        let env = ProcessInfo.processInfo.environment
        guard let token = env["DEEPSEEK_API_KEY"] ?? keys["deepseek"], !token.isEmpty,
              let u = URL(string: "https://api.deepseek.com/models") else { return }
        var req = URLRequest(url: u, timeoutInterval: 5.0)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 5) == .timedOut { return }
        guard let data,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let list = obj["data"] as? [[String: Any]] else { return }
        for item in list {
            guard let modelId = item["id"] as? String, !modelId.isEmpty else { continue }
            let key = "deepseek/\(modelId)".lowercased()
            if map[key] != nil { continue }
            let lower = modelId.lowercased()
            let bench = benchmarks[lower] ?? benchmarks["deepseek-v4.1-flash"]
            let isPro = lower.contains("pro")
            let entry = Entry(
                id: modelId,
                name: bench?.name ?? formatModelDisplayName(modelId),
                provider: "deepseek",
                providerName: "DeepSeek",
                inputPerM: isPro ? 0.66 : 0.15,
                outputPerM: isPro ? 1.98 : 0.60,
                cacheReadPerM: isPro ? 0.022 : 0.003,
                contextK: 1000,
                benchmarks: bench.map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) },
                docUrl: "https://api-docs.deepseek.com/quick_start/pricing",
                description: "Discovered via live DeepSeek API (\(modelId); off-peak shown, peak 2x)",
                reasoning: true,
                toolCall: true,
                vision: lower.contains("vision") || lower.contains("flash"),
                openWeights: true
            )
            map[key] = entry
            map[lower] = entry
        }
    }

    struct DeepSeekScrapedPricing: Equatable {
        var flashInput: Double
        var flashOutput: Double
        var flashCache: Double
        var proInput: Double
        var proOutput: Double
        var proCache: Double
    }

    /// Parses the official DeepSeek pricing table. The table is row-major with
    /// Flash/Pro columns: per price type (cache-hit, cache-miss, output) the
    /// cells run Flash-off, Pro-off, Flash-peak, Pro-peak, i.e. 12 values:
    /// [fCache, pCache, fCachePeak, pCachePeak, fMiss, pMiss, fMissPeak,
    ///  pMissPeak, fOut, pOut, fOutPeak, pOutPeak]. Returns nil when the page
    /// shape changes so we keep last-known-good hardcoded pricing.
    static func scrapeDeepSeekPricing(html: String? = nil) -> DeepSeekScrapedPricing? {
        let page: String
        if let html { page = html }
        else {
            guard let u = URL(string: "https://api-docs.deepseek.com/quick_start/pricing"),
                  let text = fetchText(url: u, timeout: 8) else { return nil }
            page = text
        }
        let lower = page.lowercased()
        guard let s = lower.range(of: "model version")?.lowerBound,
              let e = lower.range(of: "concurrency limit")?.upperBound else { return nil }
        // Map ranges back onto the original page via offsets.
        let startOff = lower.distance(from: lower.startIndex, to: s)
        let endOff = lower.distance(from: lower.startIndex, to: e)
        let chars = Array(page)
        guard startOff >= 0, endOff <= chars.count, startOff < endOff else { return nil }
        let table = String(chars[startOff..<min(endOff, startOff + 12000)])
        var values: [Double] = []
        // Match $ amounts like $0.003, $1.32, $3.96 (also tolerates $0.3).
        let pattern = try? NSRegularExpression(pattern: #"\$(\d+(?:\.\d+)?)"#)
        let ns = table as NSString
        for m in pattern?.matches(in: table, range: NSRange(location: 0, length: ns.length)) ?? [] {
            if m.numberOfRanges > 1, let v = Double(ns.substring(with: m.range(at: 1))) {
                values.append(v)
            }
        }
        // Expect exactly the 12 pricing cells; otherwise the page changed.
        guard values.count == 12, values.allSatisfy({ $0 > 0 && $0 < 100 }) else { return nil }
        let fCache = values[0], pCache = values[1]
        let fCachePeak = values[2], pCachePeak = values[3]
        let fMiss = values[4], pMiss = values[5]
        let fMissPeak = values[6], pMissPeak = values[7]
        let fOut = values[8], pOut = values[9]
        let fOutPeak = values[10], pOutPeak = values[11]
        // Sanity: cache-hit < cache-miss < output per tier, Flash cheaper than
        // Pro, peaks above off-peaks. Guards against mis-ordered parses.
        guard fCache < fMiss, fMiss < fOut,
              pCache < pMiss, pMiss < pOut,
              fMiss < pMiss, fOut < pOut,
              fCachePeak > fCache, fMissPeak > fMiss, fOutPeak > fOut,
              pCachePeak > pCache, pMissPeak > pMiss, pOutPeak > pOut else { return nil }
        return DeepSeekScrapedPricing(
            flashInput: fMiss, flashOutput: fOut, flashCache: fCache,
            proInput: pMiss, proOutput: pOut, proCache: pCache
        )
    }

    static func applyDeepSeekScrapedPricing(into map: inout [String: Entry], pricing: DeepSeekScrapedPricing, benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
        // Only touch entries whose pricing actually changed (keeps revision
        // bumps meaningful and avoids churning models-cache.json every poll).
        func withPricing(_ e: Entry, input: Double, output: Double, cache: Double, desc: String) -> Entry {
            var c = e
            c.inputPerM = input
            c.outputPerM = output
            c.cacheReadPerM = cache
            c.contextK = 1000
            c.docUrl = "https://api-docs.deepseek.com/quick_start/pricing"
            c.description = desc
            return c
        }
        let flashDesc = "DeepSeek V4.1 Flash live pricing (off-peak $\(pricing.flashInput)/$\(pricing.flashOutput) per 1M; peak 2x)"
        let proDesc = "DeepSeek V4 Pro live pricing (off-peak $\(pricing.proInput)/$\(pricing.proOutput) per 1M; peak 2x; routes to Flash from 2026-09-14)"
        for (key, entry) in map {
            let lower = key.lowercased()
            let isFlashKey = lower.contains("v4.1") && lower.contains("flash") || lower.hasSuffix("deepseek-flash") || lower.contains("deepseek-v4-flash")
            let isProKey = lower.contains("v4-pro")
            if isFlashKey, entry.inputPerM != pricing.flashInput || entry.outputPerM != pricing.flashOutput {
                map[key] = withPricing(entry, input: pricing.flashInput, output: pricing.flashOutput, cache: pricing.flashCache, desc: flashDesc)
            } else if isProKey, entry.inputPerM != pricing.proInput || entry.outputPerM != pricing.proOutput {
                map[key] = withPricing(entry, input: pricing.proInput, output: pricing.proOutput, cache: pricing.proCache, desc: proDesc)
            }
        }
        _ = benchmarks
    }

    /// Anthropic: enumerate live model ids when a key is available so new
    /// Claude releases appear before models.dev updates. Pricing stays with
    /// models.dev / synthesis (the list endpoint carries no pricing).
    static func fetchLiveAnthropicModels(into map: inout [String: Entry], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
        let env = ProcessInfo.processInfo.environment
        let keys = PlanLimitsEngine.authKeys()
        guard let token = env["ANTHROPIC_API_KEY"] ?? keys["anthropic"] ?? keys["claude"], !token.isEmpty,
              let u = URL(string: "https://api.anthropic.com/v1/models?limit=100") else { return }
        var req = URLRequest(url: u, timeoutInterval: 5.0)
        req.setValue(token, forHTTPHeaderField: "x-api-key")
        req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 5) == .timedOut { return }
        guard let data,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let list = obj["data"] as? [[String: Any]] else { return }
        for item in list {
            guard let modelId = item["id"] as? String, !modelId.isEmpty else { continue }
            let key = "anthropic/\(modelId)".lowercased()
            if map[key] != nil { continue }
            let lower = modelId.lowercased()
            let bench = benchmarks[lower]
            let synth = synthesizeDynamicEntry(for: lower)
            let entry = Entry(
                id: modelId,
                name: bench?.name ?? synth?.name ?? formatModelDisplayName(modelId),
                provider: "anthropic",
                providerName: "Anthropic",
                inputPerM: synth?.inputPerM ?? 3.00,
                outputPerM: synth?.outputPerM ?? 15.00,
                cacheReadPerM: synth?.cacheReadPerM ?? 0.30,
                contextK: 200,
                benchmarks: bench.map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) },
                docUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
                description: "Discovered via live Anthropic API (\(modelId); pricing pending models.dev)",
                reasoning: true, toolCall: true, vision: true, openWeights: false
            )
            map[key] = entry
        }
    }

    /// Gemini: enumerate live model ids when a key is available so new Gemini
    /// releases appear before models.dev updates. Pricing stays with
    /// models.dev / synthesis (the list endpoint carries no pricing).
    static func fetchLiveGeminiModels(into map: inout [String: Entry], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
        let env = ProcessInfo.processInfo.environment
        let keys = PlanLimitsEngine.authKeys()
        guard let token = env["GEMINI_API_KEY"] ?? env["GOOGLE_API_KEY"] ?? keys["gemini"] ?? keys["google"], !token.isEmpty,
              let u = URL(string: "https://generativelanguage.googleapis.com/v1beta/models?key=\(token)&pageSize=100") else { return }
        guard let obj = fetchJSON(url: u, timeout: 6) as? [String: Any],
              let list = obj["models"] as? [[String: Any]] else { return }
        for item in list {
            let raw = (item["name"] as? String) ?? ""
            let modelId = raw.split(separator: "/").last.map(String.init) ?? raw
            guard !modelId.isEmpty else { continue }
            let lower = modelId.lowercased()
            guard lower.contains("gemini") || lower.contains("gemma") || lower.contains("imagen") || lower.contains("veo") else { continue }
            let key = "google/\(modelId)".lowercased()
            if map[key] != nil { continue }
            let bench = benchmarks[lower]
            let synth = synthesizeDynamicEntry(for: lower)
            let entry = Entry(
                id: modelId,
                name: bench?.name ?? synth?.name ?? formatModelDisplayName(modelId),
                provider: "google",
                providerName: "Google",
                inputPerM: synth?.inputPerM ?? 0.15,
                outputPerM: synth?.outputPerM ?? 0.60,
                cacheReadPerM: synth?.cacheReadPerM,
                contextK: 1000,
                benchmarks: bench.map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) },
                docUrl: "https://ai.google.dev/pricing",
                description: "Discovered via live Gemini API (\(modelId); pricing pending models.dev)",
                reasoning: true, toolCall: true, vision: true, openWeights: false
            )
            map[key] = entry
        }
    }

    /// OpenRouter: universal keyless live catalog (~400+ models, ~60 vendors).
    /// This is the primary future-model feed alongside models.dev: brand-new
    /// labs and releases appear here (often same-day) with per-token pricing,
    /// no API key needed. Strictly additive — never overwrites positive
    /// pricing (authoritative direct/overlay pricing always wins); only adds
    /// missing ids and backfills zero-priced rows.
    static func fetchLiveOpenRouterModels(into map: inout [String: Entry], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
        guard let u = URL(string: "https://openrouter.ai/api/v1/models"),
              let obj = fetchJSON(url: u, timeout: 12) as? [String: Any],
              let list = obj["data"] as? [[String: Any]] else { return }
        let parsed = parseOpenRouterModels(list: list, benchmarks: benchmarks)
        applyOpenRouterEntries(into: &map, parsed: parsed)
    }

    /// OpenRouter vendor prefix → canonical Token Horizon provider id.
    /// Unknown vendors pass through (canonicalIdentity still families them by
    /// model substring, so brand-new labs dedup correctly on arrival).
    static func openRouterProvider(for vendor: String) -> (id: String, name: String) {
        switch vendor.lowercased() {
        case "openai": return ("openai", "OpenAI")
        case "anthropic": return ("anthropic", "Anthropic")
        case "google": return ("google", "Google")
        case "deepseek": return ("deepseek", "DeepSeek")
        case "qwen": return ("alibaba", "Alibaba Cloud")
        case "z-ai": return ("glm", "Zhipu AI")
        case "moonshotai": return ("kimi", "Moonshot Kimi")
        case "minimax": return ("minimax", "MiniMax")
        case "x-ai": return ("xai", "xAI")
        case "mistralai": return ("mistral", "Mistral")
        case "meta-llama", "meta": return ("meta", "Meta")
        case "cohere": return ("cohere", "Cohere")
        case "perplexity": return ("perplexity", "Perplexity")
        case "amazon": return ("amazon", "Amazon Web Services")
        case "nvidia": return ("nvidia", "NVIDIA")
        case "microsoft": return ("microsoft", "Microsoft")
        default: return (vendor.lowercased(), vendor)
        }
    }

    /// Pure parse of OpenRouter /api/v1/models rows → catalog entries keyed by
    /// "provider/model". Per-token price strings ×1M. Separated for testing.
    static func parseOpenRouterModels(list: [[String: Any]], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) -> [String: Entry] {
        var out: [String: Entry] = [:]
        func perM(_ v: Any?) -> Double {
            if let n = v as? NSNumber { return n.doubleValue * 1_000_000 }
            if let s = v as? String, let d = Double(s) { return d * 1_000_000 }
            return 0
        }
        for item in list {
            guard let rawId = item["id"] as? String, !rawId.isEmpty else { continue }
            let parts = rawId.split(separator: "/", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            let prov = openRouterProvider(for: parts[0])
            let modelId = parts[1]
            let lower = modelId.lowercased()
            let pricing = item["pricing"] as? [String: Any] ?? [:]
            let inp = perM(pricing["prompt"])
            let outp = perM(pricing["completion"])
            let cache = perM(pricing["input_cache_read"])
            let ctx = (item["context_length"] as? NSNumber)?.intValue ?? 0
            let arch = item["architecture"] as? [String: Any] ?? [:]
            let inMods = (arch["input_modalities"] as? [String] ?? []).map { $0.lowercased() }
            let params = (item["supported_parameters"] as? [String] ?? []).map { $0.lowercased() }
            let bench = benchmarks[lower] ?? benchmarks["\(prov.id)/\(lower)"]
            let displayName: String
            if let n = item["name"] as? String, !n.isEmpty {
                // "Vendor: Model Name" → strip vendor prefix, keep model name.
                let stripped = n.split(separator: ":").dropFirst().joined(separator: ":").trimmingCharacters(in: .whitespaces)
                displayName = stripped.isEmpty ? formatModelDisplayName(modelId) : stripped
            } else {
                displayName = formatModelDisplayName(modelId)
            }
            let isFree = inp == 0 && outp == 0
            let entry = Entry(
                id: modelId,
                name: displayName,
                provider: prov.id,
                providerName: prov.name,
                inputPerM: inp,
                outputPerM: outp,
                cacheReadPerM: cache > 0 ? cache : nil,
                contextK: max(0, ctx / 1000),
                benchmarks: bench.map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) },
                docUrl: "https://openrouter.ai/models?q=\(rawId)",
                description: isFree
                    ? "Free tier via OpenRouter (\(rawId))"
                    : "Live pricing via OpenRouter (\(rawId))",
                reasoning: params.contains("reasoning") || params.contains("include_reasoning") || lower.contains("reason") || lower.contains("think"),
                toolCall: params.contains("tools") || params.contains("tool_choice") ? true : nil,
                vision: inMods.contains("image") ? true : nil,
                openWeights: nil
            )
            out["\(prov.id)/\(modelId)".lowercased()] = entry
        }
        return out
    }

    /// Merges parsed OpenRouter rows: inserts missing ids, backfills zero-priced
    /// rows, never touches positively-priced entries.
    static func applyOpenRouterEntries(into map: inout [String: Entry], parsed: [String: Entry]) {
        for (key, entry) in parsed {
            if let existing = map[key] {
                if existing.inputPerM == 0 && existing.outputPerM == 0
                    && (entry.inputPerM > 0 || entry.outputPerM > 0) {
                    var merged = existing
                    merged.inputPerM = entry.inputPerM
                    merged.outputPerM = entry.outputPerM
                    if merged.cacheReadPerM == nil { merged.cacheReadPerM = entry.cacheReadPerM }
                    if merged.contextK == 0 { merged.contextK = entry.contextK }
                    if merged.description == nil { merged.description = entry.description }
                    if merged.docUrl == nil { merged.docUrl = entry.docUrl }
                    map[key] = merged
                }
            } else {
                map[key] = entry
            }
        }
    }

    private static func inferProvider(from match: String) -> (id: String, name: String) {
        let m = match.lowercased()
        if m.contains("claude") { return ("anthropic", "Anthropic") }
        if m.contains("gpt") || m.hasPrefix("o1") || m.hasPrefix("o3") { return ("openai", "OpenAI") }
        if m.contains("gemini") || m.contains("gemma") { return ("google", "Google") }
        if m.contains("deepseek") { return ("deepseek", "DeepSeek") }
        if m.contains("qwen") { return ("alibaba", "Alibaba") }
        if m.contains("kimi") { return ("moonshot", "Moonshot") }
        if m.contains("glm") { return ("zhipu", "Zhipu AI") }
        if m.contains("minimax") { return ("minimax", "MiniMax") }
        if m.contains("muse") || m.contains("ox-") || m.contains("x-preview") { return ("opencode", "OpenCode") }
        if m.contains("grok") { return ("xai", "xAI") }
        if m.contains("llama") { return ("meta", "Meta") }
        if m.contains("codestral") || m.contains("mistral") { return ("mistral", "Mistral") }
        return ("other", "Other")
    }

    static func loadBenchmarks() -> [String: (name: String, swe: Double?, lcb: Double?, source: String)] {
        let bundled = Bundle.main.path(forResource: "benchmarks", ofType: "json")
        let fallback = NSString(string: "~/.config/token-horizon/benchmarks.json").expandingTildeInPath
        let projectFallback = "Resources/benchmarks.json"
        let path = bundled ?? (FileManager.default.fileExists(atPath: fallback) ? fallback : projectFallback)
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = obj["entries"] as? [[String: Any]] else { return [:] }
        var out: [String: (String, Double?, Double?, String)] = [:]
        for e in entries {
            guard let match = e["match"] as? String else { continue }
            let name = e["name"] as? String ?? match
            let swe = (e["swe"] as? NSNumber)?.doubleValue
            let lcb = (e["lcb"] as? NSNumber)?.doubleValue
            let src = e["source"] as? String ?? ""
            out[match.lowercased()] = (name, swe, lcb, src)
        }
        return out
    }
}
