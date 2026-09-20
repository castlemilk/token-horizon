import Foundation

/// Fan-out engine over the per-vendor adapters in `Providers/<Vendor>/`.
///
/// Adding a vendor:
///   1. Subclass `VendorLimitsAdapter` in `Providers/<Vendor>/` (override `fetch()`).
///   2. Append an instance to `PlanLimitsEngine.vendors`.
/// UI, MCP, /limits, caching, refresh throttling and notifications all pick
/// it up automatically via the `LimitsEngine` base class.
public final class PlanLimitsEngine: LimitsEngine {
    public static let shared = PlanLimitsEngine()

    public init() {
        super.init(updatedNotification: .planLimitsUpdated)
    }

    public override func fetchLimits() -> [ProviderLimit] {
        Self.fetchAll()
    }

    /// Registered vendor adapters (one class per vendor). Append to register
    /// additional providers at runtime.
    public static var vendors: [VendorLimitsAdapter] = [
        ZhipuLimits(),
        MiniMaxLimits(),
        OpenCodeGoLimits(),
        AlibabaLimits(),
        GeminiLimits(),
        ClaudeLimits(),
        DeepSeekLimits(),
        CodexLimits(),
    ]

    /// Per-vendor last-good rows: a transient fetch failure (network blip,
    /// 429, a gateway omitting a window at exhaustion — cf. kimi/alibaba 5h)
    /// must not blank the vendor's meters; serve the previous rows for a
    /// grace period. Credentials that stopped RESOLVING = deliberate
    /// (signed out / key expired and removed) — rows drop immediately.
    private static let lastGoodLock = NSLock()
    private static var lastGood: [String: (rows: [ProviderLimit], at: Date)] = [:]
    /// Internal (not private) so tests can shrink the grace.
    static var lastGoodGrace: TimeInterval = 20 * 60

    public static func fetchAll() -> [ProviderLimit] {
        var out: [ProviderLimit] = []
        for vendor in vendors {
            let rows = vendor.fetch()
            if !rows.isEmpty {
                lastGoodLock.lock(); lastGood[vendor.provider] = (rows, Date()); lastGoodLock.unlock()
                out += rows
                continue
            }
            guard vendor.auth.resolve() != nil else {
                // No credential → vendor genuinely unconfigured/signed out.
                lastGoodLock.lock(); lastGood[vendor.provider] = nil; lastGoodLock.unlock()
                continue
            }
            lastGoodLock.lock()
            let stale = lastGood[vendor.provider]
            lastGoodLock.unlock()
            if let stale, Date().timeIntervalSince(stale.at) < lastGoodGrace {
                out += stale.rows
            }
        }
        return out
    }

    /// Back-compat shim — implementation moved to the adapter base class.
    public static func authKeys() -> [String: String] {
        CredentialSource.opencodeAuthFileKeys()
    }
}
