import Foundation

/// Fan-out engine over the per-vendor adapters in `Vendors/Limits/<Vendor>/`.
///
/// Adding a vendor:
///   1. Subclass `VendorLimitsAdapter` in `Vendors/Limits/<Vendor>/` (override `fetch()`).
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
    ]

    public static func fetchAll() -> [ProviderLimit] {
        vendors.flatMap { $0.fetch() }
    }

    /// Back-compat shim — implementation moved to the adapter base class.
    public static func authKeys() -> [String: String] {
        CredentialSource.opencodeAuthFileKeys()
    }
}
