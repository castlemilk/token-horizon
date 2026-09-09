import Foundation

public struct ModelRow: Identifiable {
    public init(usage: ModelUsage, catalog: ModelCatalog.Entry?, hostCount: Int = 1) {
        self.usage = usage
        self.catalog = catalog
        self.hostCount = hostCount
    }

    public let usage: ModelUsage
    public let catalog: ModelCatalog.Entry?
    public var hostCount: Int = 1
    public var id: String { "\(usage.provider)/\(usage.model)" }

    public var displayName: String {
        if let catName = catalog?.name, !catName.isEmpty && catName != catalog?.id {
            return catName
        }
        return usage.model
    }

    public var providerDisplay: String {
        if let p = catalog?.providerName, !p.isEmpty { return p }
        switch usage.provider.lowercased() {
        case "claude", "anthropic": return "Anthropic"
        case "codex", "openai": return "OpenAI"
        case "kimi", "kimi-coding-plan", "moonshot": return "Moonshot Kimi"
        case "glm", "zai", "zai-coding-plan", "zhipu": return "Zhipu AI"
        case "minimax", "minimax-coding-plan": return "MiniMax"
        case "alibaba", "alibaba-token-plan", "qwen", "bailian": return "Alibaba Cloud"
        case "opencode", "opencode-go": return "OpenCode"
        case "ollama": return "Ollama (Local)"
        case "google", "gemini": return "Google"
        case "agy", "antigravity": return "Antigravity"
        case "meta": return "Meta"
        case "mistral": return "Mistral"
        case "xai": return "xAI"
        case "cohere": return "Cohere"
        case "amazon", "nova": return "Amazon"
        case "perplexity": return "Perplexity"
        default: return usage.provider
        }
    }

    public var isLocal: Bool {
        usage.provider.lowercased() == "ollama" || (usage.tokPerSec != nil && usage.isLocal)
    }

    public var isFree: Bool {
        if isLocal { return true }
        if inputPrice > 0 || outputPrice > 0 { return false }
        return usage.free
    }

    public var inputPrice: Double {
        if isLocal { return 0 }
        return catalog?.inputPerM ?? 0
    }

    public var outputPrice: Double {
        if isLocal { return 0 }
        return catalog?.outputPerM ?? 0
    }

    public var cachePrice: Double? {
        if isLocal { return 0 }
        return catalog?.cacheReadPerM
    }

    public var hasDiscount: Bool {
        (catalog?.discountPercent != nil && catalog?.discountPercent != 0) || (catalog?.originalInputPerM != nil && (catalog?.originalInputPerM ?? 0) > inputPrice)
    }

    public var discountPercent: Int? {
        catalog?.discountPercent
    }

    public var discountLabel: String? {
        if let lbl = catalog?.discountLabel, !lbl.isEmpty { return lbl }
        if let p = discountPercent, p > 0 { return "-\(p)%" }
        return nil
    }

    public var discountDetail: String? {
        catalog?.discountDetail
    }

    public var originalInputPriceText: String? {
        guard let orig = catalog?.originalInputPerM, orig > inputPrice else { return nil }
        return orig < 0.01 ? String(format: "$%.4f", orig) : String(format: "$%.2f", orig)
    }

    public var originalOutputPriceText: String? {
        guard let orig = catalog?.originalOutputPerM, orig > outputPrice else { return nil }
        return orig < 0.01 ? String(format: "$%.4f", orig) : String(format: "$%.2f", orig)
    }

    public var inputPriceText: String {
        if isLocal { return "$0.00" }
        if inputPrice > 0 {
            return inputPrice < 0.01 ? String(format: "$%.4f", inputPrice) : String(format: "$%.2f", inputPrice)
        }
        return isFree ? "Free" : "—"
    }

    public var outputPriceText: String {
        if isLocal { return "$0.00" }
        if outputPrice > 0 {
            return outputPrice < 0.01 ? String(format: "$%.4f", outputPrice) : String(format: "$%.2f", outputPrice)
        }
        return isFree ? "Free" : "—"
    }

    public var cachePriceText: String {
        if isLocal { return "$0.00" }
        if let cp = cachePrice, cp > 0 {
            return cp < 0.01 ? String(format: "$%.4f", cp) : String(format: "$%.2f", cp)
        }
        return "—"
    }

    public var contextK: Int {
        if usage.contextK > 0 { return usage.contextK }
        return catalog?.contextK ?? 0
    }

    public var contextText: String {
        if contextK >= 1000 {
            return String(format: "%.1fM", Double(contextK) / 1000.0).replacingOccurrences(of: ".0M", with: "M")
        }
        if contextK > 0 {
            return "\(contextK)k"
        }
        if let p = usage.paramSize {
            return p
        }
        return "—"
    }

    public var sweScore: Double? {
        catalog?.benchmarks?.swe
    }

    public var sweText: String {
        if let s = sweScore { return String(format: "%.1f%%", s) }
        return "—"
    }

    public var costText: String {
        if usage.cost > 0 { return UsageSnapshot.cost(usage.cost) }
        if isFree { return "Free" }
        if inputPrice > 0 { return String(format: "$%.2f", inputPrice) }
        return "—"
    }

    public var lcbScore: Double? {
        catalog?.benchmarks?.lcb
    }

    public var lcbText: String {
        if let l = lcbScore { return String(format: "%.1f%%", l) }
        return "—"
    }

    public var speedText: String {
        if let tps = usage.tokPerSec, tps > 0 {
            return String(format: "%.1f t/s", tps)
        }
        if isLocal {
            return "Local"
        }
        return "API"
    }

    public var promptSpeedText: String? {
        guard let ptps = usage.promptTokPerSec, ptps > 0 else { return nil }
        return String(format: "%.0f p-t/s", ptps)
    }

    public var effectiveCost: Double { max(usage.cost, usage.estCost) }

    public var usageCostText: String {
        if usage.cost > 0 { return UsageSnapshot.cost(usage.cost) }
        if usage.estCost > 0 { return UsageSnapshot.cost(usage.estCost) }
        return isFree ? "Free" : "—"
    }

    public var docUrl: URL? {
        ModelCatalog.docUrl(for: usage.provider, model: usage.model, catalogEntry: catalog)
    }
}

public enum ModelTableColumn: String, CaseIterable, Identifiable {
    case model = "MODEL"
    case context = "CTX"
    case inputPrice = "IN / 1M"
    case outputPrice = "OUT / 1M"
    case cachePrice = "CACHE"
    case sweBench = "SWE-BENCH"
    case codingLCB = "LCB"
    case speed = "SPEED"
    case usage = "USAGE"
    public var id: String { rawValue }
}

public enum ModelFilterScope: String, CaseIterable, Identifiable {
    case all = "ALL"
    case cloud = "CLOUD"
    case local = "LOCAL"
    case freeOpen = "FREE / OPEN"
    case benchmarked = "BENCHMARKED"
    case active = "USED"
    public var id: String { rawValue }
}
