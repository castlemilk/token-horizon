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
        // Named aliases with class-supplied defaults.
        switch vendor {
        case "kimi":
            return AnthropicMeter(vendor: vendor, listenPort: port,
                                  targetBase: target ?? URL(string: "https://api.kimi.com")!,
                                  store: store, sourceKind: .external)
        case "gemini":
            return GeminiMeter(vendor: vendor, listenPort: port,
                               targetBase: target ?? URL(string: "https://generativelanguage.googleapis.com")!,
                               store: store, sourceKind: .external)
        case "ollama":
            return OllamaMeter(vendor: vendor, listenPort: port,
                               targetBase: target ?? URL(string: "http://127.0.0.1:11434")!,
                               store: store, sourceKind: .selfManaged)
        case "codex", "openai":
            return OpenAICompatibleMeter(vendor: vendor, listenPort: port,
                                         targetBase: target ?? URL(string: "https://api.openai.com")!,
                                         store: store, sourceKind: .external)
        default:
            break
        }
        // Registered runtime or limits adapter.
        if let runtime = InferenceMonitor.shared.runtimes.first(where: { $0.vendor == vendor }) {
            return runtime.makeMeter(listenPort: port, target: target, store: store)
        }
        if let adapter = PlanLimitsEngine.vendors.first(where: { $0.provider == vendor }) {
            return adapter.makeMeter(listenPort: port, target: target, store: store)
        }
        // Unknown vendor with an explicit target: OpenAI-compatible default.
        if let target {
            return OpenAICompatibleMeter(vendor: vendor, listenPort: port, targetBase: target,
                                         store: store, sourceKind: .external)
        }
        return nil
    }
}
