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
        let listings = listingsByFamily(catalog)
        var planCounts: [String: Int] = [:]
        let models = result.base.map { row -> [String: Any] in
            var dict = rowPayload(row, aux: aux, listings: listings[row.usage.model] ?? [])
            let planIds = planIds(for: row, listings: listings, plans: plans)
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

    /// One provider listing of a family, with implausible cache prices dropped
    /// (a cache read can never cost more than a fresh input token).
    struct Listing {
        var provider: String
        var inputPerM: Double
        var outputPerM: Double
        var cacheReadPerM: Double?

        var payload: [String: Any] {
            var dict: [String: Any] = [
                "provider": provider,
                "inputPerM": inputPerM,
                "outputPerM": outputPerM
            ]
            if let c = cacheReadPerM { dict["cacheReadPerM"] = c }
            return dict
        }
    }

    /// Unique provider listings per family (cheapest per provider wins).
    static func listingsByFamily(_ catalog: [ModelCatalog.Entry]) -> [String: [Listing]] {
        var out: [String: [Listing]] = [:]
        for entry in catalog {
            let canon = ModelCatalog.canonicalIdentity(provider: entry.provider, model: entry.id)
            var cache = entry.cacheReadPerM
            if let c = cache, c > entry.inputPerM, entry.inputPerM > 0 { cache = nil }
            let listing = Listing(provider: entry.provider.lowercased(),
                                  inputPerM: entry.inputPerM,
                                  outputPerM: entry.outputPerM,
                                  cacheReadPerM: cache)
            var list = out[canon.family] ?? []
            if let idx = list.firstIndex(where: { $0.provider == listing.provider }) {
                let existing = list[idx]
                if listing.inputPerM < existing.inputPerM
                    || (listing.inputPerM == existing.inputPerM && listing.outputPerM < existing.outputPerM) {
                    list[idx] = listing
                }
                out[canon.family] = list
            } else {
                list.append(listing)
                out[canon.family] = list
            }
        }
        return out
    }

    static func planIds(for row: ModelRow, listings: [String: [Listing]], plans: [[String: Any]]) -> [String] {
        let familySources = Set((listings[row.usage.model] ?? []).map { $0.provider })
        guard !familySources.isEmpty else { return [] }
        return plans.compactMap { plan -> String? in
            let providers = (plan["providers"] as? [String] ?? []).map { $0.lowercased() }
            guard providers.contains(where: { familySources.contains($0) }) else { return nil }
            return plan["id"] as? String
        }
    }

    // MARK: - Name accuracy

    /// Lab / reseller prefix words that carry no model identity. Stripped from
    /// the front of names before stemming so "OpenAI GPT 5.5" and "GPT-5.5"
    /// collapse to one listing.
    static let stemPrefixWords: Set<String> = [
        "openai", "anthropic", "google", "deepmind", "gemini", "grok", "xai", "x-ai",
        "zhipu", "zai", "glm", "moonshot", "kimi", "minimax", "mistral", "meta",
        "nvidia", "amazon", "aws", "cohere", "perplexity", "deepseek", "alibaba",
        "qwen", "microsoft", "azure", "stepfun", "xiaomi", "bytedance", "upstage",
        "llama", "gpt", "claude", "vercel", "gitlab", "huggingface", "togetherai",
        "deepinfra", "fireworks", "novita", "edenai", "nano", "nanogpt", "kilo",
        "openrouter", "requesty", "orcarouter", "crossmodel", "llmgateway", "poe",
        "thegridai", "regolo", "umans", "scnet", "volcengine", "tencent", "baidu",
    ]

    /// Identity stem for dedupe: lowercase alphanumerics, leading lab/brand
    /// words removed. Punctuation and prefix variants of one model share it.
    static func nameStem(_ name: String) -> String {
        var tokens = name.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        while tokens.count > 1, stemPrefixWords.contains(tokens[0]) { tokens.removeFirst() }
        return tokens.joined()
    }

    /// Restores version dots the display formatter splits: family `gpt-5-1`
    /// renders as "GPT 5 1"; join adjacent single digits when the family pairs
    /// them (`5-1` → `5.1`). Purely a display fix — never changes identity.
    static func cleanDisplayName(_ name: String, family: String) -> String {
        let parts = family.lowercased().split(separator: "-").map(String.init)
        var out = name
        var i = 0
        while i + 1 < parts.count {
            let a = parts[i], b = parts[i + 1]
            if a.count == 1, a.allSatisfy(\.isNumber), b.count == 1, b.allSatisfy(\.isNumber) {
                out = out.replacingOccurrences(of: "\(a) \(b)", with: "\(a).\(b)")
            }
            i += 1
        }
        return out
    }

    // MARK: - Row serialization

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

    private static func rowPayload(_ row: ModelRow, aux: [String: AuxBenchmarks], listings: [Listing]) -> [String: Any] {
        let name = cleanDisplayName(row.displayName, family: row.usage.model)
        var dict: [String: Any] = [
            "id": row.id,
            "name": name,
            "stem": nameStem(name),
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
        var flags: [String] = []
        if let cp = row.cachePrice, row.inputPrice > 0, cp > row.inputPrice {
            // Drop impossible cache pricing rather than reporting it.
            flags.append("implausible_cache_price")
        } else if let cp = row.cachePrice {
            dict["cacheReadPerM"] = cp
        }
        if let oi = row.catalog?.originalInputPerM { dict["originalInputPerM"] = oi }
        if let oo = row.catalog?.originalOutputPerM { dict["originalOutputPerM"] = oo }
        if priceKnown {
            dict["effectiveInputPerM"] = row.effectiveInputPrice
            dict["blendedNetCost"] = row.blendedNetCost
            dict["netSavingsPercent"] = row.netSavingsPercent
        }
        // Provider listing spread: the canonical row shows the lab/direct
        // price, but gateways often sell the same family cheaper. Report the
        // cheapest known positive listing so "from $X" is truthful.
        if !listings.isEmpty {
            let sorted = listings.sorted { a, b in
                let ap = a.inputPerM > 0 ? a.inputPerM : Double.greatestFiniteMagnitude
                let bp = b.inputPerM > 0 ? b.inputPerM : Double.greatestFiniteMagnitude
                if ap != bp { return ap < bp }
                return a.outputPerM < b.outputPerM
            }
            dict["listingCount"] = listings.count
            dict["listings"] = sorted.prefix(8).map { $0.payload }
            if let cheapest = sorted.first(where: { $0.inputPerM > 0 }) {
                let canonical = row.isLocal ? 0 : row.inputPrice
                if canonical <= 0 || cheapest.inputPerM < canonical {
                    dict["priceFrom"] = cheapest.inputPerM
                    dict["priceFromProvider"] = cheapest.provider
                    dict["priceFromOutputPerM"] = cheapest.outputPerM
                }
            }
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
        if !flags.isEmpty { dict["flags"] = flags }
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
