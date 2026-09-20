import Foundation
import TokenHorizonCore

enum ModelsPipeline {
    struct TopPickModel: Identifiable, Equatable {
        var id: String { row.id }
        let rank: Int
        let row: ModelRow
        let valueScore: Double
        let rawScore: Double
        let perfScore: Double
        let blendedCostPerM: Double
        let badge: String
        let badgeColor: String
        let reason: String

        static func == (lhs: TopPickModel, rhs: TopPickModel) -> Bool {
            lhs.rank == rhs.rank && lhs.id == rhs.id && lhs.valueScore == rhs.valueScore && lhs.badge == rhs.badge
        }
    }

    struct Result {
        let base: [ModelRow]
        let filtered: [ModelRow]
        let scopeCounts: [ModelFilterScope: Int]
        let localCount: Int
        let topPicks: [TopPickModel]
        var baseKey: String
    }

    static func compute(
        search: String,
        scope: ModelFilterScope,
        sortColumn: ModelTableColumn,
        sortAscending: Bool,
        catalog: [ModelCatalog.Entry],
        syntheticModels: [ModelUsage],
        usageModels: [ModelUsage]
    ) -> Result {
        let clock = ContinuousClock()
        let t0 = clock.now

        var rowMap: [String: ModelRow] = [:]
        var hostCounts: [String: Int] = [:]
        var isPrimaryEntry: [String: Bool] = [:]
        // Memoize catalog lookups: the same model id can appear in many
        // synthetic/usage rows, and a miss costs an O(n) suffix scan in
        // ModelCatalog.lookup. One dict lookup per row instead.
        var lookupMemo: [String: ModelCatalog.Entry?] = [:]
        func memoizedLookup(id: String) -> ModelCatalog.Entry? {
            if let hit = lookupMemo[id] { return hit }
            let entry = ModelCatalog.shared.lookup(id: id)
            lookupMemo[id] = entry
            return entry
        }
        let totalExpected = catalog.count + syntheticModels.count + usageModels.count
        rowMap.reserveCapacity(totalExpected)
        hostCounts.reserveCapacity(totalExpected)
        isPrimaryEntry.reserveCapacity(totalExpected)

        for cat in catalog {
            let canon = ModelCatalog.canonicalIdentity(provider: cat.provider, model: cat.id)
            let familyKey = canon.family
            hostCounts[familyKey, default: 0] += 1
            let isPrimary = cat.provider.lowercased() == canon.providerId
            let existingIsPrimary = isPrimaryEntry[familyKey] ?? false
            if let existing = rowMap[familyKey] {
                var mergedCat = existing.catalog ?? cat
                if isPrimary && !existingIsPrimary {
                    mergedCat = cat
                    mergedCat.name = canon.displayName
                    mergedCat.providerName = canon.providerName
                    isPrimaryEntry[familyKey] = true
                } else if !isPrimary && existingIsPrimary {
                    // Authoritative provider entry is already set. Do not allow aggregator pricing to corrupt it.
                    if mergedCat.benchmarks == nil && cat.benchmarks != nil { mergedCat.benchmarks = cat.benchmarks }
                    if mergedCat.docUrl == nil && cat.docUrl != nil { mergedCat.docUrl = cat.docUrl }
                    if mergedCat.description == nil && cat.description != nil { mergedCat.description = cat.description }
                } else {
                    if isPrimary { isPrimaryEntry[familyKey] = true }
                    if mergedCat.inputPerM == 0 && cat.inputPerM > 0 { mergedCat.inputPerM = cat.inputPerM }
                    if mergedCat.outputPerM == 0 && cat.outputPerM > 0 { mergedCat.outputPerM = cat.outputPerM }
                    if mergedCat.cacheReadPerM == nil && cat.cacheReadPerM != nil { mergedCat.cacheReadPerM = cat.cacheReadPerM }
                    if mergedCat.contextK == 0 && cat.contextK > 0 { mergedCat.contextK = cat.contextK }
                    if mergedCat.benchmarks == nil && cat.benchmarks != nil { mergedCat.benchmarks = cat.benchmarks }
                    if mergedCat.reasoning == nil && cat.reasoning != nil { mergedCat.reasoning = cat.reasoning }
                    if mergedCat.vision == nil && cat.vision != nil { mergedCat.vision = cat.vision }
                    if mergedCat.openWeights == nil && cat.openWeights != nil { mergedCat.openWeights = cat.openWeights }
                    if mergedCat.discountPercent == nil && cat.discountPercent != nil { mergedCat.discountPercent = cat.discountPercent }
                    if mergedCat.discountLabel == nil && cat.discountLabel != nil { mergedCat.discountLabel = cat.discountLabel }
                    if mergedCat.discountDetail == nil && cat.discountDetail != nil { mergedCat.discountDetail = cat.discountDetail }
                    if mergedCat.originalInputPerM == nil && cat.originalInputPerM != nil { mergedCat.originalInputPerM = cat.originalInputPerM }
                    if mergedCat.originalOutputPerM == nil && cat.originalOutputPerM != nil { mergedCat.originalOutputPerM = cat.originalOutputPerM }
                }
                mergedCat.provider = canon.providerId
                mergedCat.providerName = canon.providerName
                mergedCat.name = canon.displayName
                var u = existing.usage
                u.provider = canon.providerId
                u.model = canon.family
                if u.contextK == 0 && cat.contextK > 0 { u.contextK = cat.contextK }
                rowMap[familyKey] = ModelRow(usage: u, catalog: mergedCat, hostCount: hostCounts[familyKey] ?? 1)
            } else {
                isPrimaryEntry[familyKey] = isPrimary
                var updatedCat = cat
                updatedCat.name = canon.displayName
                updatedCat.provider = canon.providerId
                updatedCat.providerName = canon.providerName
                let usage = ModelUsage(
                    provider: canon.providerId,
                    model: canon.family,
                    tokensAll: 0,
                    tokensToday: 0,
                    cost: 0,
                    messages: 0,
                    free: cat.inputPerM == 0 && cat.outputPerM == 0,
                    cacheReadAll: 0,
                    estCost: 0,
                    contextK: cat.contextK,
                    isLocal: canon.providerId == "ollama"
                )
                rowMap[familyKey] = ModelRow(usage: usage, catalog: updatedCat, hostCount: 1)
            }
        }

        for m in syntheticModels {
            let canon = ModelCatalog.canonicalIdentity(provider: m.provider, model: m.model)
            let familyKey = canon.family
            hostCounts[familyKey, default: 0] += 1
            let cat = memoizedLookup(id: m.model) ?? memoizedLookup(id: canon.family)
            if let existing = rowMap[familyKey] {
                var u = existing.usage
                u.isLocal = true
                if m.tokPerSec != nil { u.tokPerSec = m.tokPerSec }
                if m.promptTokPerSec != nil { u.promptTokPerSec = m.promptTokPerSec }
                if m.paramSize != nil { u.paramSize = m.paramSize }
                if m.quant != nil { u.quant = m.quant }
                if m.contextK > 0 { u.contextK = m.contextK }
                if !m.capabilities.isEmpty { u.capabilities = m.capabilities }
                if m.localModelName != nil { u.localModelName = m.localModelName }
                rowMap[familyKey] = ModelRow(usage: u, catalog: existing.catalog ?? cat, hostCount: hostCounts[familyKey] ?? 1)
            } else {
                var u = m
                u.model = canon.family
                u.isLocal = true
                var newCat = cat ?? ModelCatalog.Entry(
                    id: canon.family,
                    name: canon.displayName,
                    provider: canon.providerId,
                    providerName: canon.providerName,
                    inputPerM: 0,
                    outputPerM: 0,
                    contextK: m.contextK,
                    openWeights: true
                )
                newCat.name = canon.displayName
                newCat.providerName = canon.providerName
                rowMap[familyKey] = ModelRow(usage: u, catalog: newCat, hostCount: 1)
            }
        }

        for m in usageModels {
            let canon = ModelCatalog.canonicalIdentity(provider: m.provider, model: m.model)
            let familyKey = canon.family
            let cat = memoizedLookup(id: m.model) ?? memoizedLookup(id: canon.family)
            if let existing = rowMap[familyKey] {
                var u = existing.usage
                var catMerged = existing.catalog ?? cat
                u.provider = canon.providerId
                u.model = canon.family
                u.tokensAll += m.tokensAll
                u.tokensToday += m.tokensToday
                u.cost += m.cost
                u.messages += m.messages
                if m.tokPerSec != nil { u.tokPerSec = m.tokPerSec }
                if m.contextK > 0 { u.contextK = m.contextK }
                if m.localModelName != nil { u.localModelName = m.localModelName }
                if catMerged != nil {
                    if catMerged!.inputPerM == 0 && (cat?.inputPerM ?? 0) > 0 { catMerged!.inputPerM = cat!.inputPerM }
                    if catMerged!.outputPerM == 0 && (cat?.outputPerM ?? 0) > 0 { catMerged!.outputPerM = cat!.outputPerM }
                }
                if u.cost == 0, let c = catMerged, (c.inputPerM > 0 || c.outputPerM > 0) {
                    let blended = (c.inputPerM * 0.20 + c.outputPerM * 0.20 + (c.cacheReadPerM ?? (c.inputPerM * 0.10)) * 0.60) / 1_000_000.0
                    u.estCost = Double(u.tokensAll) * blended
                }
                rowMap[familyKey] = ModelRow(usage: u, catalog: catMerged, hostCount: hostCounts[familyKey] ?? 1)
            } else {
                var u = m
                u.provider = canon.providerId
                u.model = canon.family
                u.isLocal = canon.providerId == "ollama"
                if u.cost == 0, let c = cat, (c.inputPerM > 0 || c.outputPerM > 0) {
                    let blended = (c.inputPerM * 0.20 + c.outputPerM * 0.20 + (c.cacheReadPerM ?? (c.inputPerM * 0.10)) * 0.60) / 1_000_000.0
                    u.estCost = Double(u.tokensAll) * blended
                }
                var newCat = cat ?? ModelCatalog.Entry(
                    id: canon.family,
                    name: canon.displayName,
                    provider: canon.providerId,
                    providerName: canon.providerName,
                    inputPerM: cat?.inputPerM ?? 0,
                    outputPerM: cat?.outputPerM ?? 0,
                    contextK: m.contextK > 0 ? m.contextK : (cat?.contextK ?? 128)
                )
                newCat.name = canon.displayName
                newCat.provider = canon.providerId
                newCat.providerName = canon.providerName
                rowMap[familyKey] = ModelRow(usage: u, catalog: newCat, hostCount: 1)
            }
        }

        var base = Array(rowMap.values)

        // Measured rates for local rows come from the generic inference
        // telemetry store (populated by request meters) — never from probing.
        for i in base.indices where base[i].isLocal {
            var u = base[i].usage
            if u.tokPerSec == nil || u.promptTokPerSec == nil {
                let key = u.localModelName ?? u.model
                if let sample = InferenceTelemetryStore.shared.latest(for: key) {
                    if u.tokPerSec == nil { u.tokPerSec = sample.tokPerSec }
                    if u.promptTokPerSec == nil { u.promptTokPerSec = sample.promptTokPerSec }
                }
            }
            base[i] = ModelRow(usage: u, catalog: base[i].catalog, hostCount: base[i].hostCount)
        }

        // Single combined scope+search pass (was two filter passes with an
        // intermediate array). Scope predicate first (cheap bool checks),
        // search second (string matching).
        let q = search.lowercased().trimmingCharacters(in: .whitespaces)
        let hasQuery = !q.isEmpty
        func passesScope(_ row: ModelRow) -> Bool {
            switch scope {
            case .all: return true
            case .cloud: return !row.isLocal
            case .local: return row.isLocal
            case .freeOpen: return row.isFree || row.isLocal
            case .benchmarked: return row.sweScore != nil || row.lcbScore != nil
            case .active: return row.usage.tokensAll > 0 || row.usage.cost > 0
            }
        }
        func passesSearch(_ row: ModelRow) -> Bool {
            guard hasQuery else { return true }
            // Lowercased-contains is cheaper than repeated ICU
            // localizedCaseInsensitiveContains and matches the already-lowered q.
            if row.displayName.lowercased().contains(q) { return true }
            if row.usage.model.lowercased().contains(q) { return true }
            if row.usage.provider.lowercased().contains(q) { return true }
            if row.providerDisplay.lowercased().contains(q) { return true }
            if let d = row.catalog?.description, d.lowercased().contains(q) { return true }
            if let p = row.usage.paramSize, p.lowercased().contains(q) { return true }
            if let qt = row.usage.quant, qt.lowercased().contains(q) { return true }
            return false
        }
        var list: [ModelRow] = []
        list.reserveCapacity(base.count)
        for row in base where passesScope(row) && passesSearch(row) {
            list.append(row)
        }

        list.sort { a, b in
            let asc = sortAscending
            switch sortColumn {
            case .model:
                let cmp = a.displayName.caseInsensitiveCompare(b.displayName)
                if cmp != .orderedSame { return asc ? (cmp == .orderedAscending) : (cmp == .orderedDescending) }
            case .context:
                if a.contextK != b.contextK { return asc ? (a.contextK < b.contextK) : (a.contextK > b.contextK) }
            case .inputPrice:
                if a.inputPrice != b.inputPrice { return asc ? (a.inputPrice < b.inputPrice) : (a.inputPrice > b.inputPrice) }
            case .outputPrice:
                if a.outputPrice != b.outputPrice { return asc ? (a.outputPrice < b.outputPrice) : (a.outputPrice > b.outputPrice) }
            case .cachePrice:
                let av = a.cachePrice ?? 0
                let bv = b.cachePrice ?? 0
                if av != bv { return asc ? (av < bv) : (av > bv) }
            case .sweBench:
                let av = a.sweScore ?? -1
                let bv = b.sweScore ?? -1
                if av != bv { return asc ? (av < bv) : (av > bv) }
            case .codingLCB:
                let av = a.lcbScore ?? -1
                let bv = b.lcbScore ?? -1
                if av != bv { return asc ? (av < bv) : (av > bv) }
            case .speed:
                let av = a.usage.tokPerSec ?? -1
                let bv = b.usage.tokPerSec ?? -1
                if av != bv { return asc ? (av < bv) : (av > bv) }
            case .usage:
                if a.usage.tokensAll != b.usage.tokensAll { return asc ? (a.usage.tokensAll < b.usage.tokensAll) : (a.usage.tokensAll > b.usage.tokensAll) }
            }
            return asc ? (a.id < b.id) : (a.id > b.id)
        }

        // Single pass for scope counts + discount fingerprint (was two passes).
        var allCount = 0
        var cloudCount = 0
        var localCount = 0
        var freeOpenCount = 0
        var benchmarkedCount = 0
        var activeCount = 0
        var discountFingerprint = 0

        for row in base {
            allCount += 1
            if row.isLocal {
                localCount += 1
            } else {
                cloudCount += 1
            }
            if row.isFree || row.isLocal {
                freeOpenCount += 1
            }
            if row.sweScore != nil || row.lcbScore != nil {
                benchmarkedCount += 1
            }
            if row.usage.tokensAll > 0 || row.usage.cost > 0 {
                activeCount += 1
            }
            if row.hasDiscount { discountFingerprint += (row.discountPercent ?? 1) }
        }

        var counts: [ModelFilterScope: Int] = [:]
        counts[.all] = allCount
        counts[.cloud] = cloudCount
        counts[.local] = localCount
        counts[.freeOpen] = freeOpenCount
        counts[.benchmarked] = benchmarkedCount
        counts[.active] = activeCount

        let topPicks = computeTopPicks(from: base)

        let elapsedMs = (clock.now - t0) / .milliseconds(1)
        let baseKey = "\(catalog.count)-\(usageModels.count)-\(syntheticModels.count)-\(search)-\(scope.rawValue)-\(sortColumn.rawValue)-\(sortAscending)-\(discountFingerprint)"

        NSLog("[ModelsPipeline] compute: \(String(format: "%.1f", elapsedMs))ms, base=\(base.count), filtered=\(list.count), picks=\(topPicks.count), input=\(catalog.count)")

        return Result(base: base, filtered: list, scopeCounts: counts, localCount: localCount, topPicks: topPicks, baseKey: baseKey)
    }

    /// Selects the top 10 models based on coding/reasoning performance and blended token cost.
    /// Continually reranks dynamically when discounts, promotions, or pricing changes occur.
    static func computeTopPicks(from base: [ModelRow]) -> [TopPickModel] {
        var candidates: [(row: ModelRow, perf: Double, cost: Double, rawScore: Double)] = []
        candidates.reserveCapacity(min(base.count, 200))

        for row in base {
            let idLower = row.id.lowercased()
            // Fast substring pre-checks before the heavier displayName/description work.
            if idLower.contains("x-preview") || idLower.contains("ox-alpha") { continue }
            if row.displayName.lowercased().contains("deprecated") { continue }
            if let d = row.catalog?.description, d.lowercased().contains("deprecated") { continue }

            let swe = row.sweScore.map { ($0 <= 1.0 && $0 > 0) ? $0 * 100.0 : $0 }
            let lcb = row.lcbScore.map { ($0 <= 1.0 && $0 > 0) ? $0 * 100.0 : $0 }
            guard swe != nil || lcb != nil else { continue }

            let perf: Double
            if let s = swe, let l = lcb {
                perf = (s * 0.65) + (l * 0.35)
            } else if let s = swe {
                perf = s
            } else if let l = lcb {
                perf = l
            } else {
                continue
            }

            // Quality floor: candidate must exhibit solid general coding capability
            guard perf >= 35.0 else { continue }

            // 3:1 input to output token ratio for blended prompt/completion pricing with net pricing
            let blendedCost: Double
            if row.isLocal || (row.isFree && row.inputPrice == 0 && row.outputPrice == 0) {
                blendedCost = 0.04
            } else {
                blendedCost = max(0.04, row.blendedNetCost)
            }

            // Balanced Pareto value scoring function:
            // High capability weighting with frontier premium for SWE/LCB >= 80% (exceptional reasoning & autonomous coding capability),
            // combined with net token pricing efficiency and active prompt cache/promotional discounts.
            let costFactor = log2(1.0 + blendedCost * 2.5) + 1.2
            var perfFactor = pow(perf / 50.0, 2.6)
            if perf >= 83.0 {
                perfFactor *= 2.20 // Premier Frontier Flagship (Astra, Opus 5, Daybreak)
            } else if perf >= 80.0 {
                perfFactor *= 1.35 // Frontier S-tier premium (Sol, Claude 3.7)
            } else if perf >= 75.0 {
                perfFactor *= 1.18
            }

            // Promotional and prompt cache discount incentive: extra bonus boost when active discount is detected
            let discountBonus: Double
            if row.hasDiscount, let disc = row.discountPercent, disc > 0 {
                discountBonus = 1.0 + (Double(disc) / 100.0) * 0.25
            } else if row.netSavingsPercent > 0 {
                discountBonus = 1.0 + (Double(row.netSavingsPercent) / 100.0) * 0.20
            } else {
                discountBonus = 1.0
            }

            let rawScore = (perfFactor * 100.0 / costFactor) * discountBonus
            candidates.append((row, perf, blendedCost, rawScore))
        }

        candidates.sort { $0.rawScore > $1.rawScore }

        let top10 = Array(candidates.prefix(10))
        guard let maxScore = top10.first?.rawScore, maxScore > 0 else { return [] }

        return top10.enumerated().map { index, item in
            let rank = index + 1
            let normScore = 75.0 + (item.rawScore / maxScore) * 24.5
            let valueScore = min(99.9, Double(round(normScore * 10) / 10))

            let badge: String
            let badgeColor: String
            if item.row.hasDiscount && (item.row.discountPercent ?? 0) >= 20 {
                badge = item.row.discountLabel ?? "PROMO DEAL"
                badgeColor = "green"
            } else if item.row.isLocal {
                badge = "FREE LOCAL"
                badgeColor = "blue"
            } else if item.perf >= 80.0 {
                badge = "FRONTIER S-TIER"
                badgeColor = "purple"
            } else if item.cost <= 0.35 {
                badge = "VALUE KING"
                badgeColor = "cyan"
            } else if rank == 1 {
                badge = "TOP VALUE"
                badgeColor = "yellow"
            } else if (item.row.lcbScore ?? 0) >= 70.0 {
                badge = "LCB LEADER"
                badgeColor = "orange"
            } else {
                badge = "TOP PICK"
                badgeColor = "cyan"
            }

            var reasonParts: [String] = []
            if let swe = item.row.sweScore {
                reasonParts.append(String(format: "SWE %.1f%%", swe))
            }
            if let lcb = item.row.lcbScore {
                reasonParts.append(String(format: "LCB %.1f%%", lcb))
            }
            if item.row.hasDiscount, let label = item.row.discountLabel {
                reasonParts.append(label)
            }
            if item.cost < 0.1 {
                reasonParts.append("Free/Local")
            } else if item.row.netSavingsPercent > 0 {
                reasonParts.append(String(format: "$%.2f/1M net", item.cost))
            } else {
                reasonParts.append(String(format: "$%.2f/1M", item.cost))
            }
            let reason = reasonParts.joined(separator: " · ")

            return TopPickModel(
                rank: rank,
                row: item.row,
                valueScore: valueScore,
                rawScore: item.rawScore,
                perfScore: item.perf,
                blendedCostPerM: item.cost,
                badge: badge,
                badgeColor: badgeColor,
                reason: reason
            )
        }
    }
}
