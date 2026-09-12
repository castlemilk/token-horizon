import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public final class ModelCatalog {
    public static let shared = ModelCatalog()
    private let lock = NSLock()
    private var byId: [String: Entry] = [:]
    private var lastFetch: Date = .distantPast

    public struct Entry: Codable {
        public init(id: String, name: String, provider: String, providerName: String,
                    inputPerM: Double, outputPerM: Double, cacheReadPerM: Double? = nil,
                    contextK: Int, benchmarks: Benchmarks? = nil, docUrl: String? = nil,
                    description: String? = nil, reasoning: Bool? = nil, toolCall: Bool? = nil,
                    vision: Bool? = nil, openWeights: Bool? = nil,
                    discountPercent: Int? = nil, discountLabel: String? = nil,
                    discountDetail: String? = nil, originalInputPerM: Double? = nil,
                    originalOutputPerM: Double? = nil) {
            self.id = id
            self.name = name
            self.provider = provider
            self.providerName = providerName
            self.inputPerM = inputPerM
            self.outputPerM = outputPerM
            self.cacheReadPerM = cacheReadPerM
            self.contextK = contextK
            self.benchmarks = benchmarks
            self.docUrl = docUrl
            self.description = description
            self.reasoning = reasoning
            self.toolCall = toolCall
            self.vision = vision
            self.openWeights = openWeights
            self.discountPercent = discountPercent
            self.discountLabel = discountLabel
            self.discountDetail = discountDetail
            self.originalInputPerM = originalInputPerM
            self.originalOutputPerM = originalOutputPerM
        }

        public var id: String
        public var name: String
        public var provider: String
        public var providerName: String
        public var inputPerM: Double
        public var outputPerM: Double
        public var cacheReadPerM: Double?
        public var contextK: Int
        public var benchmarks: Benchmarks?
        public var docUrl: String?
        public var description: String?
        public var reasoning: Bool?
        public var toolCall: Bool?
        public var vision: Bool?
        public var openWeights: Bool?
        public var discountPercent: Int?
        public var discountLabel: String?
        public var discountDetail: String?
        public var originalInputPerM: Double?
        public var originalOutputPerM: Double?
    }

    public struct Benchmarks: Codable {
        public init(swe: Double? = nil, lcb: Double? = nil, source: String) {
            self.swe = swe
            self.lcb = lcb
            self.source = source
        }

        public var swe: Double?
        public var lcb: Double?
        public var source: String
    }

    public func lookup(id: String) -> Entry? {
        lock.lock(); defer { lock.unlock() }
        let clean = id.lowercased().trimmingCharacters(in: .whitespaces)
        if let exact = byId[clean] { return exact }
        let hyphens = clean.replacingOccurrences(of: "_", with: "-")
        if let h = byId[hyphens] { return h }
        let colons = clean.split(separator: ":").first.map(String.init) ?? clean
        if let c = byId[colons] { return c }
        for (k, v) in byId {
            if k.hasSuffix("/" + clean) || k.hasSuffix("/" + hyphens) || k.hasSuffix("/" + colons) {
                return v
            }
        }
        if clean.contains("sol") || clean.contains("gpt-5-sol") || clean.contains("gpt-sol") || clean.contains("gpt-5.6-sol") {
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
        if clean.contains("terra") || clean.contains("gpt-5-terra") || clean.contains("gpt-terra") || clean.contains("gpt-5.6-terra") {
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
        if clean.contains("luna") || clean.contains("gpt-5-luna") || clean.contains("gpt-luna") || clean.contains("gpt-5.6-luna") {
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
        if clean.contains("deepseek-v4-pro") {
            return Entry(
                id: "deepseek-v4-pro",
                name: "DeepSeek V4 Pro",
                provider: "deepseek",
                providerName: "DeepSeek",
                inputPerM: 0.14,
                outputPerM: 0.28,
                cacheReadPerM: 0.014,
                contextK: 128,
                benchmarks: Benchmarks(swe: 72.0, lcb: 68.0, source: "DeepSeek"),
                docUrl: "https://api-docs.deepseek.com/quick_start/pricing",
                description: "DeepSeek flagship coding and reasoning model",
                reasoning: true,
                toolCall: true,
                vision: false,
                openWeights: true
            )
        }
        if clean.contains("gemini-3.7-flash") || clean.contains("gemini-3.5-flash") {
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
        return nil
    }

    public func allEntries() -> [Entry] {
        lock.lock(); defer { lock.unlock() }
        return Array(byId.values)
    }

    public func getLastFetchTime() -> Date {
        lock.lock(); defer { lock.unlock() }
        return lastFetch
    }

    public func refreshRemote() {
        lock.lock()
        lastFetch = .distantPast
        lock.unlock()
        DispatchQueue.global(qos: .utility).async { Self.fetchAndMerge() }
    }

    public func ensureLoaded() {
        lock.lock()
        let stale = lastFetch == .distantPast
        lock.unlock()
        if stale { DispatchQueue.global(qos: .utility).async { Self.fetchAndMerge() } }
    }

    public static func formatModelDisplayName(_ modelId: String) -> String {
        var clean = modelId
            .replacingOccurrences(of: ":latest", with: "")
            .replacingOccurrences(of: "-latest", with: "")
            .replacingOccurrences(of: "_", with: "-")

        let datePattern = try? NSRegularExpression(pattern: #"-\d{8}$"#)
        clean = datePattern?.stringByReplacingMatches(in: clean, range: NSRange(clean.startIndex..., in: clean), withTemplate: "") ?? clean

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

    public static func canonicalIdentity(provider: String, model: String) -> (family: String, displayName: String, providerId: String, providerName: String) {
        let p = provider.lowercased()
        let m = model.lowercased()
            .replacingOccurrences(of: "_", with: "-")
            .replacingOccurrences(of: ":latest", with: "")
            .replacingOccurrences(of: ":", with: "-")

        // 1. Google Gemini, Gemma, Imagen & Veo (dynamic auto-discovery for all 3.x, 2.x, 1.x releases)
        if p.contains("google") || p.contains("vertex") || m.contains("gemini") || m.contains("gemma") || m.contains("imagen") || m.contains("veo") {
            let family = Canonical.familyID(m, extraStrips: Canonical.googleExtraStrips, folds: Canonical.geminiFolds)
            let name = formatModelDisplayName(family)
            return (family, name, "google", "Google")
        }

        // 2. Zhipu GLM Models (dynamic for releases like glm-5.3-flash, glm-5.3, glm-4-plus, glm-4-air, etc.)
        if p.contains("glm") || p.contains("zai") || p.contains("zhipu") || m.contains("glm") || m.contains("codegeex") {
            let family = Canonical.familyID(m)
            let name = formatModelDisplayName(family)
            return (family, name, "glm", "Zhipu AI")
        }

        // 3. Anthropic Claude Models (dynamic for all Claude 3.7, 3.5, 4.x, Sonnet, Opus, Haiku)
        if p.contains("anthropic") || p.contains("claude") || m.contains("claude") {
            let family = Canonical.familyID(m, folds: Canonical.claudeFolds)
            let name = formatModelDisplayName(family)
            return (family, name, "anthropic", "Anthropic")
        }

        // 4. OpenAI Models (dynamic for GPT-5 Sol, Terra, Luna, GPT-5, GPT-4o, GPT-4.5, o1, o3, o4)
        if p.contains("openai") || p.contains("codex") || m.contains("gpt") || m.contains("chatgpt") || m.contains("sol") || m.contains("terra") || m.contains("luna") || m.hasPrefix("o1") || m.hasPrefix("o3") || m.hasPrefix("o4") {
            let family = Canonical.familyID(m)
            if family == "sol" || family.contains("gpt-5-sol") || family.contains("gpt-sol") {
                return ("gpt-5-sol", "GPT-5 Sol", "openai", "OpenAI")
            }
            if family == "terra" || family.contains("gpt-5-terra") || family.contains("gpt-terra") {
                return ("gpt-5-terra", "GPT-5 Terra", "openai", "OpenAI")
            }
            if family == "luna" || family.contains("gpt-5-luna") || family.contains("gpt-luna") {
                return ("gpt-5-luna", "GPT-5 Luna", "openai", "OpenAI")
            }
            let name = formatModelDisplayName(family)
            return (family, name, "openai", "OpenAI")
        }

        // 5. DeepSeek Models (dynamic for V4 Pro, V3, R1, Coder)
        if p.contains("deepseek") || m.contains("deepseek") {
            let family = Canonical.familyID(m)
            let name = formatModelDisplayName(family)
            return (family, name, "deepseek", "DeepSeek")
        }

        // 6. Alibaba Qwen Models (dynamic for Qwen 3 Coder, 2.5, MoE)
        if p.contains("alibaba") || p.contains("qwen") || p.contains("bailian") || m.contains("qwen") {
            let family = Canonical.familyID(m, folds: Canonical.qwenFolds)
            let name = formatModelDisplayName(family)
            return (family, name, "alibaba", "Alibaba Cloud")
        }

        // 7. Moonshot Kimi (dynamic for K2, 1.5, etc.)
        if p.contains("moonshot") || p.contains("kimi") || m.contains("kimi") {
            let family = Canonical.familyID(m)
            let name = formatModelDisplayName(family)
            return (family, name, "kimi", "Moonshot Kimi")
        }

        // 8. MiniMax (dynamic for M3, 01, etc.)
        if p.contains("minimax") || m.contains("minimax") {
            let family = Canonical.familyID(m)
            let name = formatModelDisplayName(family)
            return (family, name, "minimax", "MiniMax")
        }

        // 9. xAI Grok (dynamic for Grok 4, Grok 3, Grok 2)
        if p.contains("xai") || m.contains("grok") {
            let family = Canonical.familyID(m)
            let name = formatModelDisplayName(family)
            return (family, name, "xai", "xAI")
        }

        // 10. Mistral & Codestral (dynamic)
        if p.contains("mistral") || m.contains("codestral") || m.contains("pixtral") || m.contains("mistral") {
            let family = Canonical.familyID(m)
            let name = formatModelDisplayName(family)
            return (family, name, "mistral", "Mistral")
        }

        // 11. Meta LLaMA (dynamic)
        if p.contains("meta") || m.contains("llama") {
            let family = Canonical.familyID(m)
            let name = formatModelDisplayName(family)
            return (family, name, "meta", "Meta")
        }

        // 12. Cohere Command & Embed
        if p.contains("cohere") || m.contains("command-r") || m.contains("command-light") || m.contains("cohere") {
            let family = Canonical.familyID(m)
            let name = formatModelDisplayName(family)
            return (family, name, "cohere", "Cohere")
        }

        // 13. Amazon Nova
        if p.contains("amazon") || p.contains("bedrock") || m.contains("nova-") || m.contains("amazon-nova") {
            let family = Canonical.familyID(m)
            let name = formatModelDisplayName(family)
            return (family, name, "amazon", "Amazon Web Services")
        }

        // 14. Perplexity Sonar
        if p.contains("perplexity") || m.contains("sonar") {
            let family = Canonical.familyID(m)
            let name = formatModelDisplayName(family)
            return (family, name, "perplexity", "Perplexity")
        }

        // 15. OpenCode models
        if m.contains("muse-spark") { return ("muse-spark-1.2", "Muse Spark 1.2", "opencode", "OpenCode") }
        if m.contains("x-preview") { return ("x-preview-f", "X-Preview-F", "opencode", "OpenCode") }
        if m.contains("ox-alpha") { return ("ox-alpha", "OX-Alpha", "opencode", "OpenCode") }

        // 16. Local custom models (e.g. ornith-1.5:35b)
        if m.contains("ornith") { return ("ornith-1.5-35b", "Ornith 1.5 35B", "ollama", "Ollama (Local)") }

        // Default: clean ID and provider
        let lastPart = model.split(separator: "/").last.map(String.init) ?? model
        let clean = lastPart.replacingOccurrences(of: ":", with: "-")
        return ("\(p)-\(clean.lowercased())", lastPart, p, provider)
    }

    public static func docUrl(for provider: String, model: String, catalogEntry: Entry? = nil) -> URL? {
        if let direct = catalogEntry?.docUrl, let u = URL(string: direct), !direct.isEmpty {
            return u
        }
        let p = provider.lowercased()
        let m = model.lowercased()
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
        if p.contains("ollama") {
            let base = m.components(separatedBy: ":").first ?? m
            return URL(string: "https://ollama.com/library/\(base)")
        }
        if p.contains("opencode") || p.contains("muse") {
            return URL(string: "https://opencode.ai")
        }
        return URL(string: "https://models.dev")
    }

    private static func fetchAndMerge() {
        let cachePath = Platform.paths.configDirectory.appendingPathComponent("models-cache.json").path
        let bm = loadBenchmarks()
        let catalog = ModelCatalog.shared
        // Try remote, fallback to cache
        if let url = URL(string: "https://models.dev/api.json"),
           let data = try? Data(contentsOf: url),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
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
            fetchLiveZaiModels(into: &map, benchmarks: bm)
            if let enc = try? JSONEncoder().encode(map) {
                try? enc.write(to: URL(fileURLWithPath: cachePath))
            }
            catalog.lock.lock(); catalog.byId = map; catalog.lastFetch = Date(); catalog.lock.unlock()
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .refreshModelExtras, object: nil)
            }
            return
        }

        if let data = try? Data(contentsOf: URL(fileURLWithPath: cachePath)),
           var decoded = try? JSONDecoder().decode([String: Entry].self, from: data) {
            injectDirectFlagships(into: &decoded, benchmarks: bm)
            fetchLiveZaiModels(into: &decoded, benchmarks: bm)
            catalog.lock.lock(); catalog.byId = decoded; catalog.lastFetch = Date(); catalog.lock.unlock()
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
        fetchLiveZaiModels(into: &fallbackMap, benchmarks: bm)
        catalog.lock.lock(); catalog.byId = fallbackMap; catalog.lastFetch = Date(); catalog.lock.unlock()
    }

    private static func injectDirectFlagships(into map: inout [String: Entry], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
        let flagships: [Entry] = [
            Entry(id: "gpt-5-sol", name: "GPT-5 Sol", provider: "openai", providerName: "OpenAI",
                  inputPerM: 2.50, outputPerM: 10.00, cacheReadPerM: 0.50, contextK: 256,
                  benchmarks: benchmarks["gpt-5-sol"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 81.5, lcb: 78.0, source: "OpenAI"),
                  docUrl: "https://platform.openai.com/docs/models", description: "OpenAI premier flagship tier for complex reasoning & multi-step coding agents (50% promo reduction)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 50, discountLabel: "-50% PROMO", discountDetail: "50% promotional reduction ($5.00 → $2.50 / 1M input, $20.00 → $10.00 / 1M output)",
                  originalInputPerM: 5.00, originalOutputPerM: 20.00),
            Entry(id: "gpt-5-terra", name: "GPT-5 Terra", provider: "openai", providerName: "OpenAI",
                  inputPerM: 1.20, outputPerM: 4.80, cacheReadPerM: 0.15, contextK: 256,
                  benchmarks: benchmarks["gpt-5-terra"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 72.0, lcb: 68.5, source: "OpenAI"),
                  docUrl: "https://platform.openai.com/docs/models", description: "OpenAI balanced all-rounder tier for daily professional workflows (20% promo reduction)",
                  reasoning: true, toolCall: true, vision: true, openWeights: false,
                  discountPercent: 20, discountLabel: "-20% PROMO", discountDetail: "20% promotional reduction ($1.50 → $1.20 / 1M input, $6.00 → $4.80 / 1M output)",
                  originalInputPerM: 1.50, originalOutputPerM: 6.00),
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
            Entry(id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek", providerName: "DeepSeek",
                  inputPerM: 0.14, outputPerM: 0.28, cacheReadPerM: 0.014, contextK: 128,
                  benchmarks: benchmarks["deepseek-v4-pro"].map { Benchmarks(swe: $0.swe, lcb: $0.lcb, source: $0.source) } ?? Benchmarks(swe: 72.0, lcb: 68.0, source: "DeepSeek"),
                  docUrl: "https://api-docs.deepseek.com/quick_start/pricing", description: "DeepSeek flagship MoE coding & reasoning model (90% prompt cache savings)",
                  reasoning: true, toolCall: true, vision: false, openWeights: true,
                  discountPercent: 90, discountLabel: "-90% CACHED", discountDetail: "90% discount on cache hits ($0.14 → $0.014 / 1M)")
        ]
        for f in flagships {
            let key = "\(f.provider)/\(f.id)".lowercased()
            map[key] = f
            map[f.id.lowercased()] = f
        }
    }

    private static func fetchLiveZaiModels(into map: inout [String: Entry], benchmarks: [String: (name: String, swe: Double?, lcb: Double?, source: String)]) {
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

    private static func loadBenchmarks() -> [String: (name: String, swe: Double?, lcb: Double?, source: String)] {
        let bundled = Bundle.main.path(forResource: "benchmarks", ofType: "json")
        let fallback = Platform.paths.configDirectory.appendingPathComponent("benchmarks.json").path
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
