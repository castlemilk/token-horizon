import SwiftUI

struct ModelRow: Identifiable {
    let usage: ModelUsage
    let catalog: ModelCatalog.Entry?
    var hostCount: Int = 1
    var id: String { "\(usage.provider)/\(usage.model)" }

    var displayName: String {
        if let catName = catalog?.name, !catName.isEmpty && catName != catalog?.id {
            return catName
        }
        return usage.model
    }

    var providerDisplay: String {
        if isLocal { return "Ollama (Local)" }
        if let p = catalog?.providerName, !p.isEmpty { return p }
        switch usage.provider.lowercased() {
        case "claude", "anthropic": return "Anthropic"
        case "codex", "openai": return "OpenAI"
        case "kimi", "kimi-coding-plan", "moonshot": return "Moonshot Kimi"
        case "glm", "zai", "zai-coding-plan", "zhipu": return "Zhipu AI"
        case "minimax", "minimax-coding-plan": return "MiniMax"
        case "alibaba", "alibaba-token-plan", "qwen", "bailian": return "Alibaba Cloud"
        case "upstage": return "Upstage"
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

    var isLocal: Bool {
        usage.provider.lowercased() == "ollama" || usage.isLocal
    }

    var localModelName: String {
        usage.localModelName ?? usage.model
    }

    var isFree: Bool {
        if isLocal { return true }
        if inputPrice > 0 || outputPrice > 0 { return false }
        return usage.free
    }

    var inputPrice: Double {
        if isLocal { return 0 }
        return catalog?.inputPerM ?? 0
    }

    var outputPrice: Double {
        if isLocal { return 0 }
        return catalog?.outputPerM ?? 0
    }

    var cachePrice: Double? {
        if isLocal { return 0 }
        return catalog?.cacheReadPerM
    }

    var hasDiscount: Bool {
        (catalog?.discountPercent != nil && catalog?.discountPercent != 0) || (catalog?.originalInputPerM != nil && (catalog?.originalInputPerM ?? 0) > inputPrice)
    }

    var discountPercent: Int? {
        catalog?.discountPercent
    }

    var discountLabel: String? {
        if let lbl = catalog?.discountLabel, !lbl.isEmpty { return lbl }
        if let p = discountPercent, p > 0 { return "-\(p)%" }
        return nil
    }

    var discountDetail: String? {
        catalog?.discountDetail
    }

    var originalInputPriceText: String? {
        guard let orig = catalog?.originalInputPerM, orig > inputPrice else { return nil }
        return orig < 0.01 ? String(format: "$%.4f", orig) : String(format: "$%.2f", orig)
    }

    var originalOutputPriceText: String? {
        guard let orig = catalog?.originalOutputPerM, orig > outputPrice else { return nil }
        return orig < 0.01 ? String(format: "$%.4f", orig) : String(format: "$%.2f", orig)
    }

    var inputPriceText: String {
        if isLocal { return "$0.00" }
        if inputPrice > 0 {
            return inputPrice < 0.01 ? String(format: "$%.4f", inputPrice) : String(format: "$%.2f", inputPrice)
        }
        return isFree ? "Free" : "—"
    }

    var outputPriceText: String {
        if isLocal { return "$0.00" }
        if outputPrice > 0 {
            return outputPrice < 0.01 ? String(format: "$%.4f", outputPrice) : String(format: "$%.2f", outputPrice)
        }
        return isFree ? "Free" : "—"
    }

    var cachePriceText: String {
        if isLocal { return "$0.00" }
        if let cp = cachePrice, cp > 0 {
            return cp < 0.01 ? String(format: "$%.4f", cp) : String(format: "$%.2f", cp)
        }
        return "—"
    }

    /// Net effective input price per 1M tokens factoring in prompt caching (80% typical agent cache hit rate) or promotional discounts.
    var effectiveInputPrice: Double {
        if isLocal || isFree { return 0.0 }
        if let cp = cachePrice, cp > 0, cp < inputPrice {
            return (inputPrice * 0.20) + (cp * 0.80)
        }
        if let disc = discountPercent, disc > 0 {
            return inputPrice * (1.0 - Double(disc) / 100.0)
        }
        return inputPrice
    }

    var effectiveInputPriceText: String {
        if isLocal || isFree { return "$0.00" }
        return effectiveInputPrice < 0.01 ? String(format: "$%.4f", effectiveInputPrice) : String(format: "$%.2f", effectiveInputPrice)
    }

    var effectiveOutputPrice: Double {
        if isLocal || isFree { return 0.0 }
        return outputPrice
    }

    /// Blended net cost per 1M tokens across a standard 3:1 prompt to completion ratio, accounting for net prompt caching discounts and promo rates.
    var blendedNetCost: Double {
        if isLocal || isFree { return 0.04 }
        let blended = (effectiveInputPrice * 3.0 + effectiveOutputPrice) / 4.0
        return max(0.04, blended)
    }

    var blendedNetCostText: String {
        if isLocal || isFree { return "$0.00" }
        return blendedNetCost < 0.01 ? String(format: "$%.4f", blendedNetCost) : String(format: "$%.2f", blendedNetCost)
    }

    /// Percentage savings achieved by prompt caching and active promotional discounts vs nominal gross price.
    var netSavingsPercent: Int {
        let gross = (inputPrice * 3.0 + outputPrice) / 4.0
        guard gross > 0.001 else { return 0 }
        let savings = (gross - blendedNetCost) / gross * 100.0
        return max(0, min(99, Int(round(savings))))
    }

    var contextK: Int {
        if usage.contextK > 0 { return usage.contextK }
        return catalog?.contextK ?? 0
    }

    var contextText: String {
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

    var sweScore: Double? {
        catalog?.benchmarks?.swe
    }

    var sweText: String {
        if let s = sweScore { return String(format: "%.1f%%", s) }
        return "—"
    }

    var costText: String {
        if usage.cost > 0 { return UsageSnapshot.cost(usage.cost) }
        if isFree { return "Free" }
        if inputPrice > 0 { return String(format: "$%.2f", inputPrice) }
        return "—"
    }

    var lcbScore: Double? {
        catalog?.benchmarks?.lcb
    }

    var lcbText: String {
        if let l = lcbScore { return String(format: "%.1f%%", l) }
        return "—"
    }

    var speedText: String {
        if let tps = usage.tokPerSec, tps > 0 {
            return String(format: "%.1f t/s", tps)
        }
        if isLocal {
            return "Local"
        }
        return "API"
    }

    var promptSpeedText: String? {
        guard let ptps = usage.promptTokPerSec, ptps > 0 else { return nil }
        return String(format: "%.0f p-t/s", ptps)
    }

    var effectiveCost: Double { max(usage.cost, usage.estCost) }

    var usageCostText: String {
        if usage.cost > 0 { return UsageSnapshot.cost(usage.cost) }
        if usage.estCost > 0 { return UsageSnapshot.cost(usage.estCost) }
        return isFree ? "Free" : "—"
    }

    var docUrl: URL? {
        ModelCatalog.docUrl(for: isLocal ? "ollama" : usage.provider, model: localModelName, catalogEntry: isLocal ? nil : catalog)
    }
}

enum ModelTableColumn: String, CaseIterable, Identifiable {
    case model = "MODEL"
    case context = "CTX"
    case inputPrice = "IN / 1M"
    case outputPrice = "OUT / 1M"
    case cachePrice = "CACHE"
    case sweBench = "SWE-BENCH"
    case codingLCB = "LCB"
    case speed = "SPEED"
    case usage = "USAGE"
    var id: String { rawValue }
}

enum ModelFilterScope: String, CaseIterable, Identifiable {
    case all = "ALL"
    case cloud = "CLOUD"
    case local = "LOCAL"
    case freeOpen = "FREE / OPEN"
    case benchmarked = "BENCHMARKED"
    case active = "USED"
    var id: String { rawValue }
}

struct ModelRowView: View {
    let row: ModelRow
    var compact: Bool
    var showUsage: Bool = false
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 6) {
            // Model + Provider Logo
            HStack(spacing: 6) {
                ProviderLogoView(provider: row.isLocal ? "ollama" : row.usage.provider,
                                 model: row.isLocal ? row.localModelName : row.usage.model,
                                 size: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.displayName)
                        .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    HStack(spacing: 3) {
                        Text(row.providerDisplay)
                            .font(.system(size: 7.5, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.45))
                            .lineLimit(1)
                        if let d = row.discountLabel {
                            Text(d)
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .padding(.horizontal, 3).padding(.vertical, 0.5)
                                .background(Capsule().fill(Color.green.opacity(0.25)))
                                .foregroundStyle(Color.green)
                        }
                        if row.isLocal {
                            Text("LOCAL")
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .padding(.horizontal, 3).padding(.vertical, 0.5)
                                .background(Capsule().fill(Color.teal.opacity(0.25)))
                                .foregroundStyle(Color.teal)
                        } else if row.catalog?.reasoning == true {
                            Text("REASONING")
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .padding(.horizontal, 3).padding(.vertical, 0.5)
                                .background(Capsule().fill(Color.indigo.opacity(0.28)))
                                .foregroundStyle(Color(red: 0.65, green: 0.65, blue: 1.0))
                        } else if row.isFree {
                            Text("FREE")
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .padding(.horizontal, 3).padding(.vertical, 0.5)
                                .background(Capsule().fill(Color.green.opacity(0.22)))
                                .foregroundStyle(Color.green)
                        }
                        if row.hostCount > 1 {
                            Text("\(row.hostCount) hosts")
                                .font(.system(size: 6.5, weight: .semibold, design: .monospaced))
                                .padding(.horizontal, 3).padding(.vertical, 0.5)
                                .background(Capsule().fill(Color.white.opacity(0.12)))
                                .foregroundStyle(Color.white.opacity(0.6))
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Context / Param Size
            VStack(alignment: .center, spacing: 1) {
                Text(row.contextText)
                    .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(row.contextText != "—" ? .white.opacity(0.85) : .secondary)
                if let q = row.usage.quant {
                    Text(q)
                        .font(.system(size: 6.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .frame(width: compact ? 42 : 52, alignment: .center)

            // Input Price / 1M
            VStack(alignment: .trailing, spacing: 0) {
                if let orig = row.originalInputPriceText {
                    Text(orig)
                        .font(.system(size: 6.5, design: .monospaced))
                        .strikethrough()
                        .foregroundStyle(.secondary)
                }
                Text(row.inputPriceText)
                    .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(row.hasDiscount ? .green : (row.inputPrice == 0 && row.isFree ? .green : .white.opacity(0.85)))
            }
            .frame(width: compact ? 52 : 62, alignment: .trailing)

            // Output Price / 1M
            VStack(alignment: .trailing, spacing: 0) {
                if let orig = row.originalOutputPriceText {
                    Text(orig)
                        .font(.system(size: 6.5, design: .monospaced))
                        .strikethrough()
                        .foregroundStyle(.secondary)
                }
                Text(row.outputPriceText)
                    .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(row.hasDiscount ? .green : (row.outputPrice == 0 && row.isFree ? .green : .white.opacity(0.85)))
            }
            .frame(width: compact ? 54 : 64, alignment: .trailing)

            // Cache Price / 1M
            VStack(alignment: .trailing, spacing: 0) {
                Text(row.cachePriceText)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.45))
            }
            .frame(width: compact ? 48 : 58, alignment: .trailing)

            // Benchmark (SWE-bench Verified)
            VStack(alignment: .trailing, spacing: 1) {
                if let swe = row.sweScore {
                    HStack(spacing: 3) {
                        Text(String(format: "%.1f%%", swe))
                            .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(swe >= 70 ? .green : (swe >= 60 ? .cyan : (swe >= 50 ? .blue : .yellow)))
                    }
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(
                        RoundedRectangle(cornerRadius: 3)
                            .fill((swe >= 70 ? Color.green : (swe >= 60 ? Color.cyan : Color.blue)).opacity(0.12))
                    )
                } else {
                    Text("—").font(.system(size: 8.5, design: .monospaced)).foregroundStyle(.secondary)
                }
            }
            .frame(width: compact ? 56 : 68, alignment: .trailing)

            // Coding (LCB)
            VStack(alignment: .trailing, spacing: 1) {
                if let lcb = row.lcbScore {
                    Text(String(format: "%.1f%%", lcb))
                        .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(.cyan.opacity(0.9))
                } else {
                    Text("—").font(.system(size: 8.5, design: .monospaced)).foregroundStyle(.secondary)
                }
            }
            .frame(width: compact ? 46 : 56, alignment: .trailing)

            // Speed (tok/s for local models)
            VStack(alignment: .trailing, spacing: 1) {
                if row.isLocal {
                    if OllamaClient.isBenchmarking(model: row.localModelName) {
                        HStack(spacing: 2) {
                            ProgressView().scaleEffect(0.5).frame(width: 10, height: 10)
                            Text("test…").font(.system(size: 7.5, design: .monospaced)).foregroundStyle(.cyan)
                        }
                    } else if let tps = row.usage.tokPerSec, tps > 0 {
                        Button {
                            OllamaClient.benchmark(model: row.localModelName)
                        } label: {
                            VStack(alignment: .trailing, spacing: 0) {
                                Text(String(format: "%.1f t/s", tps))
                                    .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(.teal)
                                if let ptps = row.promptSpeedText {
                                    Text(ptps)
                                        .font(.system(size: 6.5, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .help("Click to re-benchmark speed")
                    } else {
                        Button {
                            OllamaClient.benchmark(model: row.localModelName)
                        } label: {
                            Text("⚡ Test")
                                .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                                .padding(.horizontal, 4).padding(.vertical, 1.5)
                                .background(RoundedRectangle(cornerRadius: 3).fill(Color.cyan.opacity(0.2)))
                                .foregroundStyle(.cyan)
                        }
                        .buttonStyle(.plain)
                        .help("Benchmark tokens/sec for \(row.usage.model)")
                    }
                } else {
                    Text("API").font(.system(size: 8, design: .monospaced)).foregroundStyle(.white.opacity(0.3))
                }
            }
            .frame(width: compact ? 58 : 72, alignment: .trailing)

            // Optional Usage Column
            if showUsage {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(row.usage.tokensAll > 0 ? UsageSnapshot.tokens(row.usage.tokensAll) : "—")
                        .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(row.usage.tokensAll > 0 ? .white : .secondary)
                    if row.usage.cost > 0 {
                        Text(UsageSnapshot.cost(row.usage.cost))
                            .font(.system(size: 7, design: .monospaced))
                            .foregroundStyle(.orange)
                    }
                }
                .frame(width: compact ? 74 : 90, alignment: .trailing)
            }

            // Link Out
            Group {
                if row.isLocal {
                    Image(systemName: "info.circle")
                        .font(.system(size: 10.5))
                        .foregroundStyle(isHovered ? Color.teal : Color.teal.opacity(0.7))
                } else if let url = row.docUrl {
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Image(systemName: "arrow.up.right.square")
                            .font(.system(size: 10.5))
                            .foregroundStyle(isHovered ? Color.white : Color.white.opacity(0.5))
                    }
                    .buttonStyle(.plain)
                    .help("Open official documentation for \(row.displayName)")
                } else {
                    Color.clear.frame(width: 14)
                }
            }
            .frame(width: 22, alignment: .center)
        }
        .padding(.vertical, 4).padding(.horizontal, 6)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.white.opacity(isHovered ? 0.05 : 0.015))
        )
        .contentShape(Rectangle())
        .onHover { h in isHovered = h }
    }
}

// MARK: - Top Picks Panel & Card

struct TopPicksPanel: View {
    let topPicks: [ModelsPipeline.TopPickModel]
    @Binding var isExpanded: Bool
    let onSelect: (ModelRow) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Header Row
            HStack(spacing: 6) {
                HStack(spacing: 4) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 8.5, weight: .bold))
                        .foregroundStyle(.yellow)
                    Text("TOP PICKS")
                        .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.white)
                    Text("· VALUE & PERFORMANCE")
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 3) {
                    Circle().fill(Color.green).frame(width: 5, height: 5)
                    Text("LIVE RERANK")
                        .font(.system(size: 6.5, weight: .bold, design: .monospaced))
                        .foregroundStyle(.green.opacity(0.9))
                }
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(Capsule().fill(Color.green.opacity(0.12)))

                Spacer()

                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 3) {
                        Text(isExpanded ? "COLLAPSE" : "EXPAND (10)")
                            .font(.system(size: 7, weight: .bold, design: .monospaced))
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 7, weight: .bold))
                    }
                    .foregroundStyle(.white.opacity(0.6))
                    .padding(.horizontal, 6).padding(.vertical, 2.5)
                    .background(Capsule().fill(Color.white.opacity(0.07)))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 8).padding(.top, 4)

            if isExpanded && !topPicks.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(topPicks) { pick in
                            TopPickCardView(pick: pick) {
                                onSelect(pick.row)
                            }
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 6)
                }
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.black.opacity(0.35))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.white.opacity(0.1), lineWidth: 1)
                )
        )
    }
}

struct TopPickCardView: View {
    let pick: ModelsPipeline.TopPickModel
    let action: () -> Void
    @State private var isHovered = false

    private var rankBadgeColor: Color {
        switch pick.rank {
        case 1: return Color.yellow
        case 2: return Color.white.opacity(0.9)
        case 3: return Color.orange
        default: return Color.cyan.opacity(0.8)
        }
    }

    private var badgePillColor: Color {
        switch pick.badgeColor {
        case "green": return .green
        case "purple": return .purple
        case "blue": return .blue
        case "orange": return .orange
        case "yellow": return .yellow
        default: return .cyan
        }
    }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                // Top Row: Rank & Value Score
                HStack(alignment: .center, spacing: 4) {
                    HStack(spacing: 2) {
                        Text("#\(pick.rank)")
                            .font(.system(size: 8, weight: .heavy, design: .monospaced))
                            .foregroundStyle(rankBadgeColor)
                    }
                    .padding(.horizontal, 4).padding(.vertical, 1.5)
                    .background(Capsule().fill(rankBadgeColor.opacity(0.18)))

                    Text(pick.badge)
                        .font(.system(size: 6.5, weight: .bold, design: .monospaced))
                        .foregroundStyle(badgePillColor)
                        .padding(.horizontal, 4).padding(.vertical, 1.5)
                        .background(Capsule().fill(badgePillColor.opacity(0.15)))
                        .lineLimit(1)

                    Spacer(minLength: 2)

                    HStack(spacing: 1) {
                        Text("★")
                            .font(.system(size: 7))
                            .foregroundStyle(.yellow)
                        Text(String(format: "%.1f", pick.valueScore))
                            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.9))
                    }
                }

                // Model Name
                Text(pick.row.displayName)
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                // Provider & Context
                HStack(spacing: 4) {
                    Text(pick.row.providerDisplay)
                        .font(.system(size: 7.5, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.5))
                        .lineLimit(1)
                    Spacer()
                    Text(pick.row.contextText)
                        .font(.system(size: 7.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.4))
                }

                Divider().overlay(Color.white.opacity(0.08))

                // Benchmarks & Pricing Row
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if let swe = pick.row.sweScore {
                        HStack(spacing: 1.5) {
                            Text("SWE")
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .foregroundStyle(.cyan.opacity(0.7))
                            Text(String(format: "%.1f%%", swe))
                                .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                                .foregroundStyle(.cyan)
                        }
                    } else if let lcb = pick.row.lcbScore {
                        HStack(spacing: 1.5) {
                            Text("LCB")
                                .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                                .foregroundStyle(.orange.opacity(0.7))
                            Text(String(format: "%.1f%%", lcb))
                                .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                                .foregroundStyle(.orange)
                        }
                    }

                    Spacer()

                    if pick.row.isFree || pick.row.isLocal {
                        Text("FREE")
                            .font(.system(size: 7.5, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.green)
                    } else {
                        VStack(alignment: .trailing, spacing: 0) {
                            if let orig = pick.row.originalInputPriceText {
                                Text(orig)
                                    .strikethrough()
                                    .font(.system(size: 6.5, design: .monospaced))
                                    .foregroundStyle(.secondary)
                            }
                            Text(pick.row.inputPriceText)
                                .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                                .foregroundStyle(pick.row.hasDiscount ? .green : .white.opacity(0.85))
                        }
                    }
                }

                // Discount Detail / Blended Rate
                HStack(spacing: 3) {
                    if let disc = pick.row.discountLabel {
                        Text(disc)
                            .font(.system(size: 6.5, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.green)
                    }
                    Text(String(format: "$%.2f/1M", pick.blendedCostPerM))
                        .font(.system(size: 6.5, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.45))
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 6.5))
                        .foregroundStyle(.white.opacity(isHovered ? 0.8 : 0.2))
                }
            }
            .padding(7)
            .frame(width: 175)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isHovered ? Color.white.opacity(0.09) : Color.white.opacity(0.04))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(isHovered ? rankBadgeColor.opacity(0.5) : Color.white.opacity(0.08), lineWidth: 1)
                    )
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}

struct ModelDetailView: View {
    let row: ModelRow
    @Environment(\.dismiss) var dismiss
    @State private var localMetadata: LocalModelMetadata?
    @State private var localMetadataLoading = false

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    ProviderLogoView(provider: row.isLocal ? "ollama" : row.usage.provider,
                                     model: row.isLocal ? row.localModelName : row.usage.model,
                                     size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.displayName).font(.system(size: 16, weight: .bold, design: .monospaced)).foregroundStyle(.white)
                        Text(row.providerDisplay).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                        HStack(spacing: 4) {
                            if let d = row.discountLabel { pill(d, color: .green) }
                            if row.isLocal { pill("LOCAL", color: .teal) }
                            if row.catalog?.reasoning == true { pill("REASONING", color: .indigo) }
                            if row.catalog?.toolCall == true { pill("TOOLS", color: .cyan) }
                            if row.catalog?.vision == true { pill("VISION", color: .purple) }
                            if row.isFree { pill("FREE", color: .green) }
                        }
                    }
                    Spacer()
                    if let url = row.docUrl {
                        Button { NSWorkspace.shared.open(url) } label: {
                            Label("Docs", systemImage: "arrow.up.right.square").font(.system(size: 10, weight: .semibold, design: .monospaced))
                        }.buttonStyle(.bordered).controlSize(.small)
                    }
                }
                if let desc = row.catalog?.description, !desc.isEmpty {
                    Text(desc).font(.system(size: 10, design: .monospaced)).foregroundStyle(.white.opacity(0.75)).fixedSize(horizontal: false, vertical: true)
                        .padding(8).background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                }
                if let dDetail = row.discountDetail ?? (row.hasDiscount ? "\(row.discountLabel ?? "Promotional discount") applied" : nil) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Discounts & Promotions").font(.system(size: 9, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
                        HStack(spacing: 8) {
                            Image(systemName: "tag.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(.green)
                            Text(dDetail)
                                .font(.system(size: 9.5, design: .monospaced))
                                .foregroundStyle(.green)
                            Spacer()
                            if let pct = row.discountPercent {
                                Text("-\(pct)%")
                                    .font(.system(size: 9, weight: .heavy, design: .monospaced))
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(Capsule().fill(Color.green.opacity(0.25)))
                                    .foregroundStyle(.green)
                            }
                        }
                        .padding(8)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.green.opacity(0.08)))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.green.opacity(0.2), lineWidth: 1))
                    }
                }
                HStack(spacing: 14) {
                    detailStat("Context", row.contextText, sub: row.usage.quant != nil ? row.usage.quant! : nil)
                    detailStat("In / 1M", row.inputPriceText, sub: row.originalInputPriceText != nil ? "was \(row.originalInputPriceText!)" : nil)
                    detailStat("Out / 1M", row.outputPriceText, sub: row.originalOutputPriceText != nil ? "was \(row.originalOutputPriceText!)" : nil)
                    detailStat("Cache / 1M", row.cachePriceText, sub: nil)
                    detailStat("Net / 1M", row.blendedNetCostText, sub: row.netSavingsPercent > 0 ? "-\(row.netSavingsPercent)% net savings" : "3:1 blended")
                }
                if let bench = row.catalog?.benchmarks {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Benchmarks").font(.system(size: 9, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                            if let v = bench.swe { benchCard("SWE-bench Verified", v, source: bench.source) }
                            if let v = bench.lcb { benchCard("LiveCodeBench", v, source: bench.source) }
                            // DeepSWE and extended benchmarks reserved for future catalog entries
                            if row.catalog?.benchmarks != nil && bench.swe == nil && bench.lcb == nil {
                                Text("No published scores for this model variant").font(.system(size: 8.5, design: .monospaced)).foregroundStyle(.secondary)
                            }
                        }
                        if !bench.source.isEmpty {
                            Text("Source: \(bench.source)").font(.system(size: 7, design: .monospaced)).foregroundStyle(.white.opacity(0.3))
                        }
                    }
                    .padding(8).background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                }
                if row.usage.tokensAll > 0 {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Your Usage").font(.system(size: 9, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
                        HStack(spacing: 16) {
                            detailStat("Tokens", UsageSnapshot.tokens(row.usage.tokensAll), sub: "\(UsageSnapshot.tokens(row.usage.tokensToday)) today")
                            detailStat("Cost", row.costText, sub: nil)
                            if row.usage.cacheReadAll > 0 {
                                let pct = Int(Double(row.usage.cacheReadAll) / Double(max(row.usage.tokensAll, 1)) * 100)
                                detailStat("Cache hit", "\(pct)%", sub: "\(UsageSnapshot.tokens(row.usage.cacheReadAll)) cached")
                            }
                        }
                    }.padding(8).background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                }
                if row.isLocal {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("LOCAL MODEL CONFIGURATION").font(.system(size: 9, weight: .heavy, design: .monospaced)).foregroundStyle(.tertiary).kerning(1)
                        if localMetadataLoading && localMetadata == nil {
                            HStack(spacing: 6) {
                                ProgressView().scaleEffect(0.55)
                                Text("Loading complete runtime metadata…")
                                    .font(.system(size: 8.5, design: .monospaced)).foregroundStyle(.secondary)
                            }
                        }
                        if let localMetadata {
                            LocalModelMetadataView(metadata: localMetadata)
                        } else if !localMetadataLoading {
                            Text("No local configuration metadata was found.")
                                .font(.system(size: 8.5, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                    }.padding(8).background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
                    .task(id: row.localModelName) { await loadLocalMetadata() }
                }
            }.padding(16)
        }
        .frame(width: 620, height: 620)
        .background(Color(nsColor: .windowBackgroundColor))
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }

    private func loadLocalMetadata() async {
        localMetadata = nil
        localMetadataLoading = true
        let modelName = row.localModelName
        let metadata: LocalModelMetadata?
        if MLXModelInspector.modelDirectory(for: modelName) != nil {
            metadata = await Task.detached(priority: .utility) {
                MLXModelInspector.metadata(for: modelName)
            }.value
        } else {
            metadata = await OllamaClient.fetchModelMetadata(for: modelName)
        }
        guard !Task.isCancelled else { return }
        localMetadata = metadata
        localMetadataLoading = false
    }
    private func pill(_ t: String, color: Color) -> some View {
        Text(t).font(.system(size: 6.5, weight: .heavy, design: .monospaced)).padding(.horizontal, 4).padding(.vertical, 1).background(Capsule().fill(color.opacity(0.22))).foregroundStyle(color)
    }
    private func detailStat(_ label: String, _ value: String, sub: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 7, weight: .heavy, design: .monospaced)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 11, weight: .bold, design: .monospaced)).foregroundStyle(.white)
            if let s = sub { Text(s).font(.system(size: 7, design: .monospaced)).foregroundStyle(.white.opacity(0.4)) }
        }
    }
    private func benchCard(_ title: String, _ value: Double, source: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 7, weight: .heavy, design: .monospaced)).foregroundStyle(.secondary)
            HStack(spacing: 4) {
                Text(String(format: "%.1f%%", value)).font(.system(size: 13, weight: .bold, design: .monospaced)).foregroundStyle(value >= 70 ? .green : value >= 60 ? .cyan : .yellow)
                Spacer()
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.1)).frame(height: 4)
                    Capsule().fill(value >= 70 ? Color.green : value >= 60 ? Color.cyan : Color.yellow).frame(width: max(2, CGFloat(value / 100 * 60)), height: 4)
                }.frame(width: 60)
            }
        }.padding(6).background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.03)))
    }
}

