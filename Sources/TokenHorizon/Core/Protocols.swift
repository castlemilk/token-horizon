import Foundation

/// Consumer-defined ports (Go analogue: "interfaces belong where they are
/// consumed, not where they are implemented").
///
/// Rules for adding to this file:
/// - Keep each protocol to 1–3 methods (Rob Pike: "the bigger the interface,
///   the weaker the abstraction"). Split, don't widen.
/// - A protocol earns its place at the 2nd implementation or a real test
///   seam — no speculative abstraction.
/// - Functions ACCEPT these protocols and RETURN concrete structs.
/// - Verify compliance at compile time (`_ = ... as any <Proto>` in tests).
///
/// `LocalServer` already follows this spirit with closure providers; these
/// protocols cover the engine side so `AppDelegate` wiring and future
/// view-model code can take fakes in tests.

/// Minimal read surface for usage snapshots (today/all-time, per-tool,
/// models, sessions). Satisfied by `UsageEngine` with no extra code.
protocol UsageSnapshotProviding {
    func snapshot() -> UsageSnapshot
}

/// History and trend aggregation over hourly buckets. Satisfied by
/// `UsageEngine` with no extra code.
protocol UsageHistoryProviding {
    func history(days: Int) -> (points: [HistoryPoint], streak: Int)
    func trendHistory(window: TrendWindow) -> [HistoryPoint]
}

/// Cached plan-limit rows with time-gated refresh. Satisfied by both
/// `PlanLimitsEngine` and `KimiLimitsEngine` (identical shapes) with no
/// extra code.
protocol LimitsProviding {
    func cachedLimits() -> [ProviderLimit]
    func refreshIfDue(maxAge: TimeInterval)
}

// Zero-body conformances: the engines already have exactly these shapes.
extension UsageEngine: UsageSnapshotProviding, UsageHistoryProviding {}
extension PlanLimitsEngine: LimitsProviding {}
extension KimiLimitsEngine: LimitsProviding {}
