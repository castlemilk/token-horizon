import Foundation

/// Dual-tracking contract: every vendor/runtime class can vend a request
/// listener (meter), giving each source TWO independent usage channels:
///   1. its native channel (limits API, log tailing, Prometheus counters)
///   2. request-path metering (this)
/// The two reconcile against each other — see Attestation.reconciled.
public protocol Meterable {
    /// Vendor key used on metered events ("claude", "vllm", ...).
    var meterVendorKey: String { get }
    /// Default upstream the meter relays to (vendor API base or runtime port).
    var defaultMeterTarget: URL? { get }
    /// Build the wire-format meter for this vendor/runtime. Nil = not meterable.
    func makeMeter(listenPort: UInt16, target: URL?, store: UsageStoring?) -> RequestMeter?
}

/// Builds meters for any registered vendor/runtime key.
public enum MeterRegistry {
    /// All meterable keys (runtimes + external vendors).
    public static var availableVendors: [String] {
        InferenceMonitor.shared.runtimes.map(\.vendor)
            + PlanLimitsEngine.vendors.map(\.provider)
            + ["kimi"]
    }

    public static func make(vendor: String, port: UInt16, target: URL?,
                            store: UsageStoring?) -> RequestMeter? {
        if let runtime = InferenceMonitor.shared.runtimes.first(where: { $0.vendor == vendor }) {
            return runtime.makeMeter(listenPort: port, target: target, store: store)
        }
        if let adapter = PlanLimitsEngine.vendors.first(where: { $0.provider == vendor }) {
            return adapter.makeMeter(listenPort: port, target: target, store: store)
        }
        if vendor == "kimi" {
            return AnthropicMeter(vendor: "kimi", listenPort: port,
                                  targetBase: target ?? URL(string: "https://api.kimi.com")!,
                                  store: store, sourceKind: .external)
        }
        return nil
    }
}
