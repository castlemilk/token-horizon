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

/// Base class for self-managed inference runtimes (Vendors/SelfManaged/<Vendor>/).
///
/// Detection is process-based via `Platform.systemStats` (cross-platform);
/// telemetry comes from each runtime's Prometheus /metrics endpoint — no
/// traffic proxying required. Subclasses declare ports, process signatures,
/// and counter names; the base class does the rest.
open class LocalInferenceRuntime {
    public let vendor: String
    public let displayName: String
    public let defaultPorts: [Int]
    /// Lowercase substrings matched against process command names.
    public let processSignatures: [String]

    /// Prometheus counter names summed for prompt tokens.
    open var promptCounterNames: [String] { [] }
    /// Prometheus counter names summed for generated tokens.
    open var generationCounterNames: [String] { [] }
    /// Additional gauge/counter names surfaced as `extra`.
    open var extraMetricNames: [String] { [] }

    // MARK: - Meterable (dual tracking: Prometheus counters + request metering)

    /// The runtime's own server is the meter's upstream. All supported
    /// runtimes speak the OpenAI wire format; override for others.
    open func makeMeter(listenPort: UInt16, target: URL?, store: UsageStoring?) -> RequestMeter? {
        let upstream = target ?? URL(string: "http://127.0.0.1:\(activePort() ?? defaultPorts[0])")!
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

    /// First candidate port answering GET /metrics with 2xx.
    public func activePort() -> Int? {
        for port in defaultPorts {
            if fetchMetricsText(port: port) != nil { return port }
        }
        return nil
    }

    public func fetchMetricsText(port: Int) -> String? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/metrics") else { return nil }
        let req = URLRequest(url: url, timeoutInterval: 1.5)
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 2) == .timedOut { return nil }
        guard let data else { return nil }
        return String(data: data, encoding: .utf8)
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
