import Foundation

/// Web-facing catalog export.
///
/// Serializes the same family-deduped catalog the MODELS tab renders (plus
/// top picks and provider rollups) into the static artifact published at
/// `docs/data/models.json` and served by token-horizon.dev/models.
/// `scripts/refresh-models.sh` regenerates it; `--export-model-catalog` runs
/// the identical code path headlessly so the web list can never drift from
/// the app list.
enum ModelCatalogExport {
    static let schemaVersion = 1

    /// Merged catalog rows, augmented with benchmark fields the app's
    /// `Entry.Benchmarks` does not carry (AIME/GPQA + approx flag).
    static func payload(usageModels: [ModelUsage] = []) -> [String: Any] {
        let catalog = ModelCatalog.shared.allEntries()
        let result = ModelsPipeline.compute(
            search: "",
            scope: .all,
            sortColumn: .sweBench,
            sortAscending: false,
            catalog: catalog,
            syntheticModels: [],
            usageModels: usageModels
        )
        let aux = auxiliaryBenchmarks()
        let plansDoc = loadPlans()
        let plans = plansDoc.plans
        let sources = sourceProvidersByFamily(catalog)
        var planCounts: [String: Int] = [:]
        let models = result.base.map { row -> [String: Any] in
            var dict = rowPayload(row, aux: aux)
            let planIds = planIds(for: row, sources: sources, plans: plans)
            if !planIds.isEmpty {
                dict["plan"] = planIds[0]
                dict["plans"] = planIds
                for id in planIds { planCounts[id, default: 0] += 1 }
            }
            return dict
        }
        let picks = result.topPicks.map { pickPayload($0) }

        var providerCounts: [String: [String: Any]] = [:]
        for row in result.base {
            let key = row.usage.provider
            var entry = providerCounts[key] ?? ["id": key, "name": row.providerDisplay, "models": 0]
            entry["models"] = (entry["models"] as? Int ?? 0) + 1
            providerCounts[key] = entry
        }
        let providers = providerCounts.values.sorted {
            (($0["models"] as? Int) ?? 0) > (($1["models"] as? Int) ?? 0)
        }
        let plansPayload = plans.map { plan -> [String: Any] in
            var enriched = plan
            enriched["modelCount"] = planCounts[plan["id"] as? String ?? ""] ?? 0
            return enriched
        }

        return [
            "schemaVersion": schemaVersion,
            "generatedAt": Int(Date().timeIntervalSince1970),
            "build": ["version": BuildInfo.version, "commit": BuildInfo.commit, "builtAt": BuildInfo.builtAt],
            "count": models.count,
            "catalogCount": catalog.count,
            "providers": providers,
            "plans": plansPayload,
            "plansUpdatedAt": plansDoc.updatedAt,
            "topPicks": picks,
            "models": models
        ]
    }

    /// Pretty, key-sorted JSON: stable diffs for the committed artifact.
    static func data(usageModels: [ModelUsage] = []) -> Data {
        let obj = payload(usageModels: usageModels)
        var opts: JSONSerialization.WritingOptions = [.prettyPrinted, .sortedKeys]
        if #available(macOS 10.15, *) { opts.insert(.withoutEscapingSlashes) }
        return (try? JSONSerialization.data(withJSONObject: obj, options: opts)) ?? Data("{}".utf8)
    }

    @discardableResult
    static func write(path: String, usageModels: [ModelUsage] = []) -> Int {
        let url = URL(fileURLWithPath: NSString(string: path).expandingTildeInPath)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        do {
            try data(usageModels: usageModels).write(to: url)
            return 0
        } catch {
            FileHandle.standardError.write(Data("export failed: \(error.localizedDescription)\n".utf8))
            return 1
        }
    }

    /// Headless CLI entry. `--refresh` pulls models.dev/OpenRouter/provider
    /// feeds first (same merge as the app's periodic refresh); otherwise the
    /// on-disk `models-cache.json` is exported as-is.
    static func runCLI(path: String, refresh: Bool) -> Int32 {
        if refresh { ModelCatalog.fetchAndMerge() }
        let payloadSize = data().count
        let rc = write(path: path)
        if rc == 0 {
            FileHandle.standardError.write(Data("wrote \(payloadSize) bytes to \(path)\n".utf8))
        }
        return Int32(rc)
    }

    // MARK: - Curated subscription plans

    /// Loads Resources/plans.json (bundle → user override → repo fallback).
    /// The file is curated by hand — plan tiers come from provider docs, not
    /// from the model feeds — so it is never generated.
    static func loadPlans() -> (plans: [[String: Any]], updatedAt: String) {
        let bundled = Bundle.main.path(forResource: "plans", ofType: "json")
        let userOverride = NSString(string: "~/.config/token-horizon/plans.json").expandingTildeInPath
        let projectFallback = "Resources/plans.json"
        let path = bundled ?? (FileManager.default.fileExists(atPath: userOverride) ? userOverride : projectFallback)
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let plans = obj["plans"] as? [[String: Any]] else { return ([], "") }
        return (plans, obj["updatedAt"] as? String ?? "")
    }

    /// Every raw provider id that merged into a canonical family — plan
    /// providers (kimi-for-coding, github-copilot, …) live there, not on the
    /// canonical provider, so plan linkage needs the source set.
    static func sourceProvidersByFamily(_ catalog: [ModelCatalog.Entry]) -> [String: Set<String>] {
        var out: [String: Set<String>] = [:]
        for entry in catalog {
            let canon = ModelCatalog.canonicalIdentity(provider: entry.provider, model: entry.id)
            out[canon.family, default: []].insert(entry.provider.lowercased())
        }
        return out
    }

    static func planIds(for row: ModelRow, sources: [String: Set<String>], plans: [[String: Any]]) -> [String] {
        let familySources = sources[row.usage.model] ?? []
        guard !familySources.isEmpty else { return [] }
        return plans.compactMap { plan -> String? in
            let providers = (plan["providers"] as? [String] ?? []).map { $0.lowercased() }
            guard providers.contains(where: { familySources.contains($0) }) else { return nil }
            return plan["id"] as? String
        }
    }

    // MARK: - Row serialization

    private static func rowPayload(_ row: ModelRow, aux: [String: AuxBenchmarks]) -> [String: Any] {
        var dict: [String: Any] = [
            "id": row.id,
            "name": row.displayName,
            "provider": row.usage.provider,
            "providerName": row.providerDisplay,
            "category": category(for: row),
            "contextK": row.contextK,
            "isLocal": row.isLocal,
            "isFree": row.isFree,
            "hostCount": row.hostCount
        ]
        if let perf = perfScore(row) { dict["perfScore"] = perf }
        // Pricing accuracy: zero prices are only meaningful with positive
        // evidence (paid prices, explicit free tier, or local). Plan-covered
        // models and missing provider pricing both serialize
        // priceKnown=false so the web list renders "—" instead of a fake $0.
        let priceKnown = row.isLocal || row.isFree || row.inputPrice > 0 || row.outputPrice > 0
        dict["priceKnown"] = priceKnown
        dict["inputPerM"] = row.inputPrice
        dict["outputPerM"] = row.outputPrice
        if let cp = row.cachePrice { dict["cacheReadPerM"] = cp }
        if let oi = row.catalog?.originalInputPerM { dict["originalInputPerM"] = oi }
        if let oo = row.catalog?.originalOutputPerM { dict["originalOutputPerM"] = oo }
        if priceKnown {
            dict["effectiveInputPerM"] = row.effectiveInputPrice
            dict["blendedNetCost"] = row.blendedNetCost
            dict["netSavingsPercent"] = row.netSavingsPercent
        }
        if row.hasDiscount {
            var discount: [String: Any] = [:]
            if let p = row.discountPercent { discount["percent"] = p }
            if let l = row.discountLabel { discount["label"] = l }
            if let d = row.discountDetail { discount["detail"] = d }
            if !discount.isEmpty { dict["discount"] = discount }
        }

        var capabilities: [String: Any] = [:]
        if let r = row.catalog?.reasoning { capabilities["reasoning"] = r }
        if let t = row.catalog?.toolCall { capabilities["toolCall"] = t }
        if let v = row.catalog?.vision { capabilities["vision"] = v }
        if let o = row.catalog?.openWeights { capabilities["openWeights"] = o }
        if !capabilities.isEmpty { dict["capabilities"] = capabilities }

        if let bench = benchmarkPayload(row, aux: aux) { dict["benchmarks"] = bench }
        if let d = row.catalog?.description, !d.isEmpty { dict["description"] = d }
        if let u = row.docUrl?.absoluteString, !u.isEmpty { dict["docUrl"] = u }
        return dict
    }

    private static func benchmarkPayload(_ row: ModelRow, aux: [String: AuxBenchmarks]) -> [String: Any]? {
        var dict: [String: Any] = [:]
        if let swe = row.sweScore { dict["swe"] = swe }
        if let lcb = row.lcbScore { dict["lcb"] = lcb }
        if let source = row.catalog?.benchmarks?.source, !source.isEmpty { dict["source"] = source }
        if let extra = aux[normalized(row.usage.model)] ?? aux[normalized(row.displayName)] ?? aux[normalized(row.id)] {
            if let aime = extra.aime { dict["aime"] = aime }
            if let gpqa = extra.gpqa { dict["gpqa"] = gpqa }
            if extra.approx { dict["approx"] = true }
        }
        return dict.isEmpty ? nil : dict
    }

    /// Weighted coding/reasoning score mirroring ModelsPipeline.computeTopPicks.
    private static func perfScore(_ row: ModelRow) -> Double? {
        let swe = row.sweScore.map { ($0 <= 1.0 && $0 > 0) ? $0 * 100.0 : $0 }
        let lcb = row.lcbScore.map { ($0 <= 1.0 && $0 > 0) ? $0 * 100.0 : $0 }
        if let s = swe, let l = lcb { return (s * 0.65) + (l * 0.35) }
        return swe ?? lcb
    }

    private static func category(for row: ModelRow) -> String {
        if row.isLocal { return "local" }
        if let d = row.catalog?.description, d.lowercased().contains("deprecated") { return "legacy" }
        if row.displayName.lowercased().contains("deprecated") { return "legacy" }
        guard let perf = perfScore(row) else {
            return row.isFree ? "free" : "unrated"
        }
        if perf >= 80.0 { return "frontier" }
        if perf >= 60.0 { return "balanced" }
        if perf >= 35.0 && row.blendedNetCost <= 1.0 { return "value" }
        return "efficient"
    }

    private static func pickPayload(_ pick: ModelsPipeline.TopPickModel) -> [String: Any] {
        let priceKnown = pick.row.isLocal || pick.row.isFree
            || pick.row.inputPrice > 0 || pick.row.outputPrice > 0
        // Unknown-price picks must not advertise a fabricated $0.04/1M rate.
        var reason = pick.reason
        if !priceKnown {
            reason = reason.split(separator: "·")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.hasSuffix("/1M") }
                .joined(separator: " · ")
        }
        var dict: [String: Any] = [
            "rank": pick.rank,
            "id": pick.row.id,
            "name": pick.row.displayName,
            "provider": pick.row.usage.provider,
            "providerName": pick.row.providerDisplay,
            "valueScore": pick.valueScore,
            "perfScore": pick.perfScore,
            "blendedCostPerM": pick.blendedCostPerM,
            "priceKnown": priceKnown,
            "badge": pick.badge,
            "badgeColor": pick.badgeColor,
            "reason": reason
        ]
        if let swe = pick.row.sweScore { dict["swe"] = swe }
        if let lcb = pick.row.lcbScore { dict["lcb"] = lcb }
        return dict
    }

    // MARK: - Auxiliary benchmarks (AIME/GPQA live only in benchmarks.json)

    struct AuxBenchmarks {
        var aime: Double?
        var gpqa: Double?
        var approx: Bool
    }

    private static func normalized(_ s: String) -> String {
        s.lowercased().replacingOccurrences(of: "_", with: "-").trimmingCharacters(in: .whitespaces)
    }

    static func auxiliaryBenchmarks() -> [String: AuxBenchmarks] {
        let bundled = Bundle.main.path(forResource: "benchmarks", ofType: "json")
        let fallback = NSString(string: "~/.config/token-horizon/benchmarks.json").expandingTildeInPath
        let projectFallback = "Resources/benchmarks.json"
        let path = bundled ?? (FileManager.default.fileExists(atPath: fallback) ? fallback : projectFallback)
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = obj["entries"] as? [[String: Any]] else { return [:] }
        var out: [String: AuxBenchmarks] = [:]
        for e in entries {
            guard let match = e["match"] as? String else { continue }
            let aux = AuxBenchmarks(
                aime: (e["aime"] as? NSNumber)?.doubleValue,
                gpqa: (e["gpqa"] as? NSNumber)?.doubleValue,
                approx: (e["approx"] as? Bool) ?? false
            )
            out[normalized(match)] = aux
            if let name = e["name"] as? String { out[normalized(name)] = aux }
        }
        return out
    }
}
