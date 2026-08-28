import Foundation

enum ModelsPipeline {
    struct Result {
        let base: [ModelRow]
        let filtered: [ModelRow]
        let scopeCounts: [ModelFilterScope: Int]
        let localCount: Int
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
        let t0 = Date()

        var rowMap: [String: ModelRow] = [:]
        var hostCounts: [String: Int] = [:]

        for cat in catalog {
            let canon = ModelCatalog.canonicalIdentity(provider: cat.provider, model: cat.id)
            let familyKey = canon.family
            hostCounts[familyKey, default: 0] += 1
            let isPrimary = cat.provider.lowercased() == canon.providerId
            if let existing = rowMap[familyKey] {
                let existingIsPrimary = (existing.catalog?.provider.lowercased() == canon.providerId)
                var mergedCat = existing.catalog ?? cat
                if isPrimary && !existingIsPrimary {
                    mergedCat = cat
                    mergedCat.name = canon.displayName
                    mergedCat.providerName = canon.providerName
                } else {
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
            let cat = ModelCatalog.shared.lookup(id: m.model) ?? ModelCatalog.shared.lookup(id: canon.family)
            if let existing = rowMap[familyKey] {
                var u = existing.usage
                u.isLocal = true
                if m.tokPerSec != nil { u.tokPerSec = m.tokPerSec }
                if m.promptTokPerSec != nil { u.promptTokPerSec = m.promptTokPerSec }
                if m.paramSize != nil { u.paramSize = m.paramSize }
                if m.quant != nil { u.quant = m.quant }
                if m.contextK > 0 { u.contextK = m.contextK }
                if !m.capabilities.isEmpty { u.capabilities = m.capabilities }
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
            let cat = ModelCatalog.shared.lookup(id: m.model) ?? ModelCatalog.shared.lookup(id: canon.family)
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
                if catMerged != nil {
                    if catMerged!.inputPerM == 0 && (cat?.inputPerM ?? 0) > 0 { catMerged!.inputPerM = cat!.inputPerM }
                    if catMerged!.outputPerM == 0 && (cat?.outputPerM ?? 0) > 0 { catMerged!.outputPerM = cat!.outputPerM }
                }
                rowMap[familyKey] = ModelRow(usage: u, catalog: catMerged, hostCount: hostCounts[familyKey] ?? 1)
            } else {
                var u = m
                u.provider = canon.providerId
                u.model = canon.family
                u.isLocal = canon.providerId == "ollama"
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

        let base = Array(rowMap.values)

        var list = base
        switch scope {
        case .all: break
        case .cloud: list = list.filter { !$0.isLocal }
        case .local: list = list.filter { $0.isLocal }
        case .freeOpen: list = list.filter { $0.isFree || $0.isLocal }
        case .benchmarked: list = list.filter { $0.sweScore != nil || $0.lcbScore != nil }
        case .active: list = list.filter { $0.usage.tokensAll > 0 || $0.usage.cost > 0 }
        }

        let q = search.lowercased().trimmingCharacters(in: .whitespaces)
        if !q.isEmpty {
            list = list.filter {
                $0.displayName.lowercased().contains(q)
                    || $0.usage.model.lowercased().contains(q)
                    || $0.usage.provider.lowercased().contains(q)
                    || $0.providerDisplay.lowercased().contains(q)
                    || ($0.catalog?.description?.lowercased().contains(q) ?? false)
                    || ($0.usage.paramSize?.lowercased().contains(q) ?? false)
                    || ($0.usage.quant?.lowercased().contains(q) ?? false)
            }
        }

        list.sort { a, b in
            let asc = sortAscending
            switch sortColumn {
            case .model:
                let cmp = a.displayName.localizedCaseInsensitiveCompare(b.displayName)
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

        var counts: [ModelFilterScope: Int] = [:]
        counts[.all] = base.count
        counts[.cloud] = base.filter { !$0.isLocal }.count
        counts[.local] = base.filter { $0.isLocal }.count
        counts[.freeOpen] = base.filter { $0.isFree || $0.isLocal }.count
        counts[.benchmarked] = base.filter { $0.sweScore != nil || $0.lcbScore != nil }.count
        counts[.active] = base.filter { $0.usage.tokensAll > 0 || $0.usage.cost > 0 }.count
        let localCount = counts[.local] ?? 0

        let elapsed = Date().timeIntervalSince(t0) * 1000
        let baseKey = "\(catalog.count)-\(usageModels.count)-\(syntheticModels.count)-\(search)-\(scope.rawValue)-\(sortColumn.rawValue)-\(sortAscending)"

        NSLog("[ModelsPipeline] compute: \(String(format: "%.1f", elapsed))ms, base=\(base.count), filtered=\(list.count), input=\(catalog.count)")

        return Result(base: base, filtered: list, scopeCounts: counts, localCount: localCount, baseKey: baseKey)
    }
}
