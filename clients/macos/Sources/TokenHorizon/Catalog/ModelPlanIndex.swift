import Foundation

/// Which subscription plan(s) a model row is covered by, as a filter choice.
enum ModelPlanFilter: Equatable, Hashable {
    /// No plan filtering — every row passes.
    case all
    /// Only rows covered by this `plans.json` id (e.g. `opencode-zen`).
    case plan(String)
    /// Only rows no curated plan covers.
    case uncovered

    /// Stable string for recompute keys and `?plan=` query params.
    var rawValue: String {
        switch self {
        case .all: return "all"
        case .uncovered: return "uncovered"
        case .plan(let id): return id
        }
    }

    init(rawValue: String) {
        switch rawValue.lowercased().trimmingCharacters(in: .whitespaces) {
        case "", "all": self = .all
        case "uncovered", "none": self = .uncovered
        default: self = .plan(rawValue.lowercased().trimmingCharacters(in: .whitespaces))
        }
    }
}

/// Curated subscription-plan coverage for the model catalog.
///
/// `Resources/plans.json` is hand-maintained (never generated): each plan lists
/// the **raw** models.dev provider ids it sells through (`opencode-go`,
/// `zai-coding-plan`, `github-copilot`, …). The catalog's canonical merge
/// rewrites every row's provider to the lab id (`glm`, `anthropic`, …), so the
/// plan ids are gone by the time a row reaches the UI — coverage has to be
/// resolved from the raw sources grouped by canonical family. That is exactly
/// the pass `ModelsPipeline.compute` already runs, so it gathers the sources
/// there and only the matching rule lives here.
///
/// This is the single implementation of that rule; `ModelCatalogExport`
/// delegates to it so the web catalog and the app can never drift.
enum ModelPlanIndex {

    struct Plan: Equatable {
        let id: String
        let name: String
        /// Short monospace pill label for dense table rows (`ZEN`, `GLM`, …).
        let short: String
        let docUrl: String?
        let summary: String
        let providers: [String]

        static func == (lhs: Plan, rhs: Plan) -> Bool { lhs.id == rhs.id }
    }

    // MARK: - Curated plan file

    private static let plansLock = NSLock()
    private static var cachedPlans: (plans: [Plan], updatedAt: String)?

    /// Plans are a curated build artifact, so they are loaded once per process
    /// rather than re-read from disk on every pipeline run (the MODELS tab
    /// recomputes every couple of seconds).
    static func plans() -> (plans: [Plan], updatedAt: String) {
        plansLock.lock()
        if let hit = cachedPlans { plansLock.unlock(); return hit }
        plansLock.unlock()

        let doc = ModelCatalogExport.loadPlans()
        let plans: [Plan] = doc.plans.compactMap { dict in
            guard let id = dict["id"] as? String, !id.isEmpty else { return nil }
            let name = dict["name"] as? String ?? id
            return Plan(
                id: id.lowercased(),
                name: name,
                short: (dict["short"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? derivedShort(from: name),
                docUrl: dict["docUrl"] as? String,
                summary: dict["summary"] as? String ?? "",
                providers: (dict["providers"] as? [String] ?? []).map { $0.lowercased() }
            )
        }
        let result = (plans, doc.updatedAt)
        plansLock.lock()
        cachedPlans = result
        plansLock.unlock()
        return result
    }

    /// Fallback pill label for a plan that shipped without an explicit `short`.
    static func derivedShort(from name: String) -> String {
        let words = name
            .replacingOccurrences(of: "/", with: " ")
            .components(separatedBy: .whitespaces)
            .filter { !$0.isEmpty }
        guard let first = words.first else { return String(name.prefix(7)).uppercased() }
        return String(first.prefix(7)).uppercased()
    }

    /// Plans covering a set of plan ids, in curated order.
    static func covering(planIds: [String]) -> [Plan] {
        guard !planIds.isEmpty else { return [] }
        let all = plans().plans
        return planIds.compactMap { id in all.first { $0.id == id } }
    }

    // MARK: - Matching rule (the one true implementation)

    /// Plans covering a family, given the raw source provider ids selling it.
    static func planIds(familySources: Set<String>, plans: [[String: Any]]) -> [String] {
        guard !familySources.isEmpty else { return [] }
        return plans.compactMap { plan -> String? in
            let providers = (plan["providers"] as? [String] ?? []).map { $0.lowercased() }
            guard providers.contains(where: { familySources.contains($0) }) else { return nil }
            return plan["id"] as? String
        }
    }

    static func planIds(familySources: Set<String>, plans: [Plan]) -> [String] {
        guard !familySources.isEmpty else { return [] }
        return plans.compactMap { plan in
            plan.providers.contains(where: { familySources.contains($0) }) ? plan.id : nil
        }
    }
}
