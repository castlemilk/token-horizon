import Foundation

/// The hardware mapping profile: what each model actually runs like on this
/// machine, accumulated from measurements and used to select models better.
///
/// Two halves:
///
/// **Measured.** Every local inference surface that reports throughput lands
/// here — Ollama's speed benchmark, the MLX runner's tok/s, the gateway's
/// traced local engines. Keyed by model spec + quantisation, because that is
/// what varies the bytes-per-token.
///
/// **Estimated.** For a model with no measurement, decode throughput is
/// bounded by memory bandwidth: tokens stream from weights once per token, so
/// tok/s ≈ utilisation × bandwidth / bytes-per-token. The bandwidth table is
/// per chip (Apple publishes the figures); utilisation is a conservative
/// 0.7 — real decode leaves room for sampling and KV reads. Estimates are
/// flagged as such wherever they are shown.
///
/// Selection uses both: a measured number always wins, and an estimate below
/// the interactive floor down-ranks a model that would otherwise fit.
struct HardwareMap: Codable {

    struct Measurement: Codable, Equatable {
        var modelSpec: String        // engine's serve spec ("Qwen/Qwen3-32B-GGUF:Qwen3-32B-Q4_K_M.gguf")
        var engine: String           // "thengine" | "splash" | "ollama" | "mlx"
        var quant: String            // "Q4_K_M" | "Splash" | …
        var paramsB: Double
        var tokPerSec: Double
        var promptTokPerSec: Double?
        var measuredAt: Date
        var source: String           // "ollama-bench" | "mlx" | "gateway"
    }

    struct Machine: Codable, Equatable {
        var chip: String             // "Apple M5 Max"
        var memoryGB: Int
        var bandwidthGBs: Double     // the chip's published figure
    }

    var machine: Machine
    var measurements: [Measurement]

    // MARK: - Lookup

    /// The best measurement for a model spec: exact spec first, then the same
    /// repo at any quantisation, then a prefix match on the family. The last
    /// entry wins — `record` replaces in place, so insertion order is
    /// chronological.
    func measured(spec: String, engine: String? = nil) -> Measurement? {
        let keyed = measurements
            .filter { engine == nil || $0.engine == engine }
            .filter { $0.modelSpec == spec }
        if let last = keyed.last { return last }
        let bare = spec.split(separator: ":").first.map(String.init) ?? spec
        let repo = measurements
            .filter { engine == nil || $0.engine == engine }
            .filter { $0.modelSpec.split(separator: ":").first.map(String.init) == bare }
        return repo.last
    }

    // MARK: - Estimation

    /// Published memory bandwidth by chip family, GB/s. Conservatively rounded
    /// to the figures Apple states for the tier; an unknown chip falls back to
    /// the base-tier figure for its generation.
    static func bandwidthGBs(chip: String) -> Double {
        let n = chip.lowercased()
        let gen = Int(n.range(of: #"M(\d+)"#, options: .regularExpression).map { n[$0].dropFirst() } ?? "0") ?? 0
        if n.contains("ultra") { return max(600, Double(gen) * 130) }
        if n.contains("max") { return max(300, Double(gen) * 90) }
        if n.contains("pro") { return max(150, Double(gen) * 50) }
        return max(100, Double(gen) * 10)
    }

    /// Approximate bytes per decoded token for a quantisation. Q4_K_M averages
    /// ~0.57 bytes per weight; the unquantised formats are their float width.
    static func bytesPerToken(paramsB: Double, quant: String) -> Double {
        let q = quant.uppercased()
        if q.contains("Q8") { return paramsB * 1.05 }
        if q.contains("Q6") { return paramsB * 0.82 }
        if q.contains("Q5") { return paramsB * 0.70 }
        if q.contains("Q4") { return paramsB * 0.57 }
        if q.contains("Q3") { return paramsB * 0.45 }
        if q.contains("Q2") { return paramsB * 0.35 }
        if q.contains("F16") || q.contains("FP16") || q.contains("SPLASH") { return paramsB * 2.0 }
        return paramsB * 0.57
    }

    /// Estimated decode throughput for a model on this machine.
    func estimateTokPerSec(paramsB: Double, quant: String) -> Double {
        let bytes = HardwareMap.bytesPerToken(paramsB: paramsB, quant: quant)
        guard bytes > 0 else { return 0 }
        return (machine.bandwidthGBs * 0.7 / bytes).rounded(.down)
    }

    /// Below this, interactive use (agentic loops, streaming) feels broken —
    /// the model may fit but it is the wrong recommendation.
    static let interactiveFloor: Double = 6

    // MARK: - Persistence

    static func load() -> HardwareMap {
        let path = Self.fileURL
        guard let data = FileManager.default.contents(atPath: path.path),
              let map = try? JSONDecoder().decode(HardwareMap.self, from: data) else {
            let chip = ProcessInfo.processInfo.processorCount > 0 ? SystemStats.cpuBrandString() : "unknown"
            let mem = ProcessInfo.processInfo.physicalMemory / 1_073_741_824
            return HardwareMap(
                machine: Machine(chip: chip, memoryGB: Int(mem), bandwidthGBs: bandwidthGBs(chip: chip)),
                measurements: []
            )
        }
        return map
    }

    func record(_ measurement: Measurement) -> HardwareMap {
        var copy = self
        copy.measurements.removeAll { $0.modelSpec == measurement.modelSpec && $0.engine == measurement.engine }
        copy.measurements.append(measurement)
        return copy
    }

    func save() {
        let url = Self.fileURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(self) {
            try? data.write(to: url)
        }
    }

    static var fileURL: URL {
        let base = NSString(string: "~/.config/token-horizon").expandingTildeInPath
        return URL(fileURLWithPath: base).appendingPathComponent("hardware-map.json")
    }
}
