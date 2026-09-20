import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Point-in-time counters scraped from a runtime's Prometheus /metrics endpoint.
public struct RuntimeMetrics {
    public var promptTokensTotal: Double = 0
    public var generationTokensTotal: Double = 0
    /// Per-model cumulative counters (from metric labels; empty when the
    /// runtime does not label series, e.g. single-model llama.cpp).
    public var perModel: [String: (prompt: Double, generation: Double)] = [:]
    public var extra: [String: Double] = [:]

    public init() {}
}

/// One user-managed self-hosted endpoint: where the runtime serves, and
/// optionally which loopback port the request meter should listen on.
public struct RuntimeEndpoint: Codable, Equatable {
    public var url: String          // e.g. "http://gpu-box.local:8000"
    public var meterPort: Int?      // if set, daemon relays/meters this endpoint
    public var label: String?

    public init(url: String, meterPort: Int? = nil, label: String? = nil) {
        self.url = url
        self.meterPort = meterPort
        self.label = label
    }

    public var asDict: [String: Any] {
        var d: [String: Any] = ["url": url]
        if let meterPort { d["meterPort"] = meterPort }
        if let label { d["label"] = label }
        return d
    }

    public init?(dict: [String: Any]) {
        guard let url = dict["url"] as? String else { return nil }
        self.url = url
        self.meterPort = dict["meterPort"] as? Int
        self.label = dict["label"] as? String
    }
}

/// External view of one self-managed runtime (vLLM, SGLang, llama.cpp, ...).
public struct RuntimeSnapshot {
    public var vendor: String
    public var displayName: String
    public var running: Bool
    public var pids: [Int32]
    public var port: Int?
    public var generationTokensTotal: Double?
    public var promptTokensTotal: Double?
    /// Measured generation throughput (counter delta between polls).
    public var tokPerSec: Double?
    /// Measured prompt throughput.
    public var promptTokPerSec: Double?
    /// Vendor-specific extras (GPU cache usage, queue depth, ...).
    public var extra: [String: Double]
    public var sampledAt: Date

    public init(vendor: String, displayName: String, running: Bool, pids: [Int32] = [],
                port: Int? = nil, generationTokensTotal: Double? = nil,
                promptTokensTotal: Double? = nil, tokPerSec: Double? = nil,
                promptTokPerSec: Double? = nil, extra: [String: Double] = [:],
                sampledAt: Date = Date()) {
        self.vendor = vendor
        self.displayName = displayName
        self.running = running
        self.pids = pids
        self.port = port
        self.generationTokensTotal = generationTokensTotal
        self.promptTokensTotal = promptTokensTotal
        self.tokPerSec = tokPerSec
        self.promptTokPerSec = promptTokPerSec
        self.extra = extra
        self.sampledAt = sampledAt
    }
}

/// Base class for self-managed inference runtimes (Providers/<Vendor>/).
///
/// Detection is process-based via `Platform.systemStats` (cross-platform);
/// telemetry comes from each runtime's Prometheus /metrics endpoint — no
/// traffic proxying required. Subclasses declare ports, process signatures,
/// and counter names; the base class does the rest.
open class LocalInferenceRuntime: Meterable {
    public let vendor: String
    public let displayName: String
    public let defaultPorts: [Int]
    /// Lowercase substrings matched against process command names.
    public let processSignatures: [String]

    open var meterVendorKey: String { vendor }
    /// Loopback port the AUTO-started request meter listens on for this
    /// runtime (deterministic, stable across restarts, surfaced via
    /// GET /meters so users can point their clients at it). Nil = this
    /// runtime gets no auto-meter (settings/env meters still work).
    open var defaultMeterListenPort: UInt16? { nil }
    open var defaultMeterTarget: URL? {
        configuredEndpoints.lazy.compactMap { URL(string: $0.url) }.first
            ?? defaultPorts.first.map { URL(string: "http://127.0.0.1:\($0)")! }
    }

    /// Prometheus counter names summed for prompt tokens.
    open var promptCounterNames: [String] { [] }
    /// Prometheus counter names summed for generated tokens.
    open var generationCounterNames: [String] { [] }
    /// Additional gauge/counter names surfaced as `extra`.
    open var extraMetricNames: [String] { [] }

    // MARK: - Meterable (dual tracking: Prometheus counters + request metering)

    /// The runtime's server is the meter's upstream. Priority: explicit
    /// target arg → first user-configured endpoint → detected loopback port.
    open func makeMeter(listenPort: UInt16, target: URL?, store: UsageStoring?) -> RequestMeter? {
        guard ConsentManager.shared.isGranted(.metering) else { return nil }
        let fallbackPort = defaultPorts.first ?? 8080
        let upstream = target
            ?? configuredEndpoints.lazy.compactMap { URL(string: $0.url) }.first
            ?? URL(string: "http://127.0.0.1:\(activePort() ?? fallbackPort)")!
        return OpenAICompatibleMeter(vendor: vendor, listenPort: listenPort, targetBase: upstream,
                                     store: store, sourceKind: .selfManaged)
    }

    /// Label keys carrying the served model name (vLLM uses `model_name`,
    /// SGLang `model`). Empty for runtimes without per-model series.
    open var modelLabelKeys: [String] { ["model_name", "model"] }

    public init(vendor: String, displayName: String, defaultPorts: [Int], processSignatures: [String]) {
        self.vendor = vendor
        self.displayName = displayName
        self.defaultPorts = defaultPorts
        self.processSignatures = processSignatures
    }

    /// Running processes matching this runtime's signatures (via the OS backend).
    public func detectProcesses() -> [ProcSample] {
        guard let stats = Platform.systemStats else { return [] }
        return stats.processSamples().all.filter { sample in
            let cmd = sample.command.lowercased()
            return processSignatures.contains { cmd.contains($0) }
        }
    }

    /// Result of an HTTP liveness/workload probe against a runtime endpoint.
    public struct RuntimeProbe {
        public var url: URL
        /// Raw metrics text when the probe target is Prometheus (nil for API probes).
        public var text: String?
        /// Workload gauges surfaced on the snapshot (loaded models, VRAM, ...).
        public var extra: [String: Double]
        public init(url: URL, text: String? = nil, extra: [String: Double] = [:]) {
            self.url = url; self.text = text; self.extra = extra
        }
    }

    /// HTTP probe — THE liveness signal. Works for local and remote endpoints
    /// alike; process detection (ps) only decorates local snapshots with pids.
    /// Default: first configured/detected /metrics URL answering 2xx.
    /// Runtimes without Prometheus (Ollama) override with their native API.
    open func probe() -> RuntimeProbe? {
        for url in metricsURLs() {
            if let text = fetchMetricsText(url: url) {
                return RuntimeProbe(url: url, text: text)
            }
        }
        return nil
    }

    /// User-configured endpoints (Settings) — self-hosters may run this
    /// runtime on remote/other hosts. Cloud providers never get this; their
    /// API base is fixed on the provider class.
    public var configuredEndpoints: [RuntimeEndpoint] {
        SettingsStore.shared.runtimeEndpoints[vendor] ?? []
    }

    /// Candidate /metrics URLs: configured endpoints first, then detected
    /// loopback ports.
    public func metricsURLs() -> [URL] {
        var urls = configuredEndpoints.compactMap { URL(string: $0.url + "/metrics") }
        for port in defaultPorts {
            if let url = URL(string: "http://127.0.0.1:\(port)/metrics") { urls.append(url) }
        }
        return urls
    }

    /// First candidate /metrics URL answering with 2xx.
    public func activeMetricsURL() -> URL? {
        for url in metricsURLs() {
            if fetchMetricsText(url: url) != nil { return url }
        }
        return nil
    }

    /// First candidate port answering GET /metrics with 2xx.
    public func activePort() -> Int? {
        for port in defaultPorts {
            if let url = URL(string: "http://127.0.0.1:\(port)/metrics"),
               fetchMetricsText(url: url) != nil { return port }
        }
        return nil
    }

    public func fetchMetricsText(port: Int) -> String? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/metrics") else { return nil }
        return fetchMetricsText(url: url)
    }

    public func fetchMetricsText(url: URL) -> String? {
        let r = HTTP.send(URLRequest(url: url, timeoutInterval: 1.5), timeout: 2)
        guard (200..<300).contains(r.status), let data = r.data,
              let text = String(data: data, encoding: .utf8),
              // Content check: any 2xx page on a default port (e.g. an MLX or
              // Ollama server) must not read as a Prometheus runtime.
              text.contains("# HELP") || text.contains("# TYPE") else { return nil }
        return text
    }

    /// Minimal Prometheus text parser: sums samples by metric name
    /// (labels collapsed — cardinality stays bounded by construction).
    public func parsePrometheus(_ text: String) -> [String: Double] {
        var sums: [String: Double] = [:]
        for line in text.split(separator: "\n") {
            guard let first = line.first, first != "#" else { continue }
            let name: Substring
            let valuePart: Substring
            if let brace = line.firstIndex(of: "{") {
                name = line[..<brace]
                guard let close = line.firstIndex(of: "}"),
                      let space = line[close...].firstIndex(of: " ") else { continue }
                valuePart = line[line.index(after: space)...]
            } else {
                guard let space = line.firstIndex(of: " ") else { continue }
                name = line[..<space]
                valuePart = line[line.index(after: space)...]
            }
            guard let value = Double(valuePart.trimmingCharacters(in: .whitespaces)) else { continue }
            sums[String(name), default: 0] += value
        }
        return sums
    }

    /// Label-aware variant: per-model sums for the token counters.
    public func parsePrometheusPerModel(_ text: String) -> [String: (prompt: Double, generation: Double)] {
        let counterNames = Set(promptCounterNames + generationCounterNames)
        guard !counterNames.isEmpty, !modelLabelKeys.isEmpty else { return [:] }
        var out: [String: (prompt: Double, generation: Double)] = [:]
        for line in text.split(separator: "\n") {
            guard let first = line.first, first != "#",
                  let brace = line.firstIndex(of: "{"),
                  let close = line.firstIndex(of: "}"),
                  let space = line[close...].firstIndex(of: " ") else { continue }
            let name = String(line[..<brace])
            guard counterNames.contains(name),
                  let value = Double(line[line.index(after: space)...].trimmingCharacters(in: .whitespaces)) else { continue }
            let labels = String(line[line.index(after: brace)..<close])
            var model: String?
            for key in modelLabelKeys {
                if let range = labels.range(of: "\(key)=\"") {
                    let rest = labels[range.upperBound...]
                    if let endQuote = rest.firstIndex(of: "\"") {
                        model = String(rest[..<endQuote])
                        break
                    }
                }
            }
            guard let model, !model.isEmpty else { continue }
            var counts = out[model] ?? (0, 0)
            if promptCounterNames.contains(name) { counts.prompt += value }
            if generationCounterNames.contains(name) { counts.generation += value }
            out[model] = counts
        }
        return out
    }

    /// Map parsed Prometheus series onto runtime counters.
    public func metrics(from values: [String: Double]) -> RuntimeMetrics {
        var m = RuntimeMetrics()
        m.promptTokensTotal = promptCounterNames.reduce(0) { $0 + (values[$1] ?? 0) }
        m.generationTokensTotal = generationCounterNames.reduce(0) { $0 + (values[$1] ?? 0) }
        for name in extraMetricNames {
            if let v = values[name] { m.extra[name] = v }
        }
        return m
    }
}
