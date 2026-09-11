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
    /// Canonical alias map (google ↔ gemini).
    public static let aliases: [String: String] = ["google": "gemini", "gemini": "google"]

    /// Every Meterable in the process (runtimes + quota adapters + Kimi).
    public static var meterables: [Meterable] {
        var out: [Meterable] = []
        out += InferenceMonitor.shared.runtimes.map { $0 as Meterable }
        out += PlanLimitsEngine.vendors.map { $0 as Meterable }
        out.append(KimiLimitsEngine.shared as Meterable)
        return out
    }

    /// All meterable keys (runtimes + external vendors + aliases).
    public static var availableVendors: [String] {
        var keys = meterables.map(\.meterVendorKey)
        for (from, to) in aliases where keys.contains(from) && !keys.contains(to) {
            keys.append(to)
        }
        return keys
    }

    public static func make(vendor: String, port: UInt16, target: URL?,
                            store: UsageStoring?) -> RequestMeter? {
        let key = vendor.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // Protocol-driven lookup first (adapters/runtimes own their wire format).
        if let m = meterables.first(where: { $0.meterVendorKey.lowercased() == key }) {
            return m.makeMeter(listenPort: port, target: target, store: store)
        }
        // Alias fallback (google ↔ gemini share GeminiMeter via adapter).
        if let alias = aliases[key],
           let m = meterables.first(where: { $0.meterVendorKey.lowercased() == alias }) {
            return m.makeMeter(listenPort: port, target: target, store: store)
        }
        // Codex/OpenAI have no quota adapter — OpenAI-compatible meter.
        if key == "codex" || key == "openai" {
            return OpenAICompatibleMeter(vendor: key, listenPort: port,
                                         targetBase: target ?? URL(string: "https://api.openai.com")!,
                                         store: store, sourceKind: .external)
        }
        // Unknown vendor with an explicit target: OpenAI-compatible default.
        if let target {
            return OpenAICompatibleMeter(vendor: vendor, listenPort: port, targetBase: target,
                                         store: store, sourceKind: .external)
        }
        return nil
    }
}
