import Foundation

/// The catalogue of models the bundled engines can serve on this machine,
/// reconciled against the hardware so the app can show the best options.
///
/// The catalogue is a curated resource (`Resources/local-models.json`,
/// refreshed by `scripts/refresh-local-models.py`, which takes the download
/// sizes from the Hugging Face API). The reconciliation is pure: a catalogue
/// row × a machine → a fit verdict, serve ceilings, and the reasons a row
/// made the list. Nothing here talks to the network.
///
/// Ranking answers "what are the best options for THIS machine": a model that
/// leaves the machine usable beats one that barely fits, and among models
/// that run comfortably, the more capable (larger) one wins.
enum LocalModelCatalog {

    struct Model: Equatable {
        let id: String              // HF repo
        let name: String
        let engine: String          // "thengine" | "splash" | "mlx"
        let family: String          // qwen3 | qwen3_5 | qwen2 | llama
        let paramsB: Double
        let quant: String
        let sizeGB: Double          // download
        let residentGB: Double      // weights + runtime, fixed
        let contextK: Int           // native window
        let capabilities: [String]
        let minRAMGB: Int
        let recommendedRAMGB: Int
        let license: String
        let file: String?           // explicit GGUF inside the repo
        let tokenizer: String?      // sibling repo for a GGUF

        /// Model spec handed to the engine's serve: `repo:file` when a file is
        /// pinned, else the bare repo.
        var modelSpec: String {
            guard let file, !file.isEmpty else { return id }
            return "\(id):\(file)"
        }
    }

    /// One catalogue row reconciled against a machine, with the throughput
    /// profile's verdict.
    struct Recommendation: Equatable {
        let model: Model
        let fit: HardwareProfile.Fit
        let maxMemoryGB: Int
        let maxContextK: Int
        /// Decode throughput: measured on this machine when the profile has a
        /// run, else estimated from the chip's memory bandwidth. `measured`
        /// says which.
        let tokPerSec: Double
        let tokPerSecMeasured: Bool
        /// Why this row is on the list, most user-meaningful first.
        let reasons: [String]
    }

    // MARK: - Loading

    private static let lock = NSLock()
    private static var cached: [Model]?

    static func models() -> [Model] {
        lock.lock()
        if let cached { lock.unlock(); return cached }
        lock.unlock()

        var models: [Model] = []
        if let path = ModelCatalog.resourceJSONPath("local-models"),
           let data = FileManager.default.contents(atPath: path),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let entries = obj["models"] as? [[String: Any]] {
            models = entries.compactMap { Self.model(from: $0) }
        }
        lock.lock()
        cached = models
        lock.unlock()
        return models
    }

    /// Tests and tooling load a catalogue from disk, so the parser is not
    /// welded to the bundled resource.
    static func decode(_ data: Data) -> [Model] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = obj["models"] as? [[String: Any]] else { return [] }
        return entries.compactMap { model(from: $0) }
    }

    private static func model(from dict: [String: Any]) -> Model? {
        guard let id = dict["id"] as? String, !id.isEmpty,
              let name = dict["name"] as? String,
              let engine = dict["engine"] as? String,
              let sizeGB = dict["sizeGB"] as? Double,
              let residentGB = dict["residentGB"] as? Double,
              let contextK = dict["contextK"] as? Int else { return nil }
        return Model(
            id: id,
            name: name,
            engine: engine,
            family: dict["family"] as? String ?? "",
            paramsB: dict["paramsB"] as? Double ?? 0,
            quant: dict["quant"] as? String ?? "",
            sizeGB: sizeGB,
            residentGB: residentGB,
            contextK: contextK,
            // The resource spells this `capabilities`; early rows used `caps`.
            capabilities: (dict["capabilities"] as? [String]) ?? (dict["caps"] as? [String]) ?? [],
            minRAMGB: dict["minRAMGB"] as? Int ?? 0,
            recommendedRAMGB: dict["recommendedRAMGB"] as? Int ?? Int((residentGB * 1.5).rounded(.up)),
            license: dict["license"] as? String ?? "",
            file: dict["file"] as? String,
            tokenizer: dict["tokenizer"] as? String
        )
    }

    // MARK: - Reconciliation

    /// The models this machine can run, best options first.
    ///
    /// A model that leaves the machine usable outranks one that barely fits,
    /// and among models that run comfortably the more capable (larger) one
    /// wins. The fit verdict and the serve ceilings are the engine's own
    /// analysis (`HardwareProfile`); the reasons are the human explanation.
    ///
    /// Splash's machine floor (M3+, 36 GB) applies to Splash's own roster —
    /// TH Engine GGUF rows carry their own per-model floor (`minRAMGB`) and
    /// run wherever the weights fit, which is most machines.
    static func reconciled(models: [Model], machine: HardwareProfile.Machine,
                           engine: String? = nil, map: HardwareMap? = nil) -> [Recommendation] {
        let profile = map ?? HardwareMap.load()
        var rows = models
        if let engine, !engine.isEmpty {
            rows = rows.filter { $0.engine == engine }
        }
        var recommendations: [(model: Model, fit: HardwareProfile.Fit, tight: Bool, slow: Bool,
                               tokPerSec: Double, measured: Bool,
                               ceilings: (maxMemoryGB: Int, maxContextK: Int))] = []
        for model in rows {
            let engineModel = HardwareProfile.EngineModel(
                id: model.id, displayName: model.name,
                packageGB: model.sizeGB, residentGB: model.residentGB,
                kind: model.family, recommendedRAMGB: Double(model.recommendedRAMGB)
            )
            // Splash rows take Splash's machine floor; TH Engine rows run
            // wherever the weights fit (their own floor comes from the row).
            let fit: HardwareProfile.Fit
            if model.engine == "splash" {
                fit = HardwareProfile.fit(engineModel, on: machine)
            } else {
                let ram = machine.physicalMemoryGB
                if ram < model.residentGB + 8 || ram < Double(model.minRAMGB) {
                    fit = .unsupported
                } else if ram < Double(model.recommendedRAMGB) {
                    fit = .tight
                } else if ram >= Double(model.recommendedRAMGB) * 2 {
                    fit = .generous
                } else {
                    fit = .comfortable
                }
            }
            guard fit != .unsupported else { continue }
            let ceilings = HardwareProfile.recommendedCeilings(engineModel, on: machine)
            let tight = fit == .tight
            let spec = model.modelSpec
            let measured = profile.measured(spec: spec, engine: model.engine)
            // A known download size IS the bytes streamed per decoded token —
            // every weight is read once per token — so the estimate follows the
            // real quantisation rather than a label.
            let tokPerSec = measured?.tokPerSec
                ?? profile.estimateTokPerSec(paramsB: model.paramsB, quant: model.quant,
                                             downloadGB: model.sizeGB)
            // A model that fits but decodes below the interactive floor is the
            // wrong recommendation on this machine, however capable.
            let slow = tokPerSec < HardwareMap.interactiveFloor
            recommendations.append((model, fit, tight, slow, tokPerSec, measured != nil, ceilings))
        }
        // Comfortable and generous both mean "the machine stays usable"; tight
        // means something else has to give, and a model that decodes below the
        // interactive floor is the wrong recommendation however capable —
        // both rank below the rest.
        let ranked = recommendations.sorted { a, b in
            if a.slow != b.slow { return !a.slow }
            if a.tight != b.tight { return !a.tight }
            if a.model.paramsB != b.model.paramsB { return a.model.paramsB > b.model.paramsB }
            return a.model.name < b.model.name
        }
        return ranked.map { item in
            var reasons = reasons(for: item.model, fit: item.fit, machine: machine,
                                  ceilings: item.ceilings, tight: item.tight)
            let throughput = item.tokPerSec >= 1 ? "~\(Int(item.tokPerSec.rounded())) tok/s" : "<1 tok/s"
            reasons.insert("\(item.measured ? "measured" : "estimated") \(throughput) on this machine", at: 0)
            return Recommendation(model: item.model, fit: item.fit,
                           maxMemoryGB: item.ceilings.maxMemoryGB, maxContextK: item.ceilings.maxContextK,
                           tokPerSec: item.tokPerSec, tokPerSecMeasured: item.measured,
                           reasons: reasons)
        }
    }

    static func recommendations(for machine: HardwareProfile.Machine,
                                engine: String? = nil, limit: Int = 6,
                                map: HardwareMap? = nil) -> [Recommendation] {
        Array(reconciled(models: models(), machine: machine, engine: engine, map: map).prefix(limit))
    }

    /// Every catalogue row that runs on this machine, best first — the full
    /// list behind the top-five recommendation card.
    static func runnable(for machine: HardwareProfile.Machine, engine: String,
                         map: HardwareMap? = nil) -> [Recommendation] {
        reconciled(models: models(), machine: machine, engine: engine, map: map)
    }

    /// Engines present in the catalogue, in a stable display order.
    static func engines() -> [String] {
        let order = ["thengine", "splash", "mlx"]
        let present = Set(models().map(\.engine))
        return order.filter { present.contains($0) } + present.subtracting(order).sorted()
    }

    /// Human name for an engine id.
    static func engineLabel(_ engine: String) -> String {
        switch engine {
        case "thengine": return "TH ENGINE"
        case "splash": return "SPLASH"
        case "mlx": return "MLX"
        default: return engine.uppercased()
        }
    }

    private static func reasons(for model: Model, fit: HardwareProfile.Fit,
                                machine: HardwareProfile.Machine,
                                ceilings: (maxMemoryGB: Int, maxContextK: Int), tight: Bool) -> [String] {
        var reasons: [String] = []
        let spare = Int(machine.physicalMemoryGB - model.residentGB)
        if fit == .generous {
            reasons.append("plenty of headroom — \(Int(spare)) GB free for context and apps")
        } else if tight {
            reasons.append("runs, but little memory left for anything else")
        } else {
            reasons.append("fits in \(Int(machine.physicalMemoryGB)) GB with ~\(Int(spare)) GB to spare")
        }
        reasons.append("context ceiling \(ceilings.maxContextK)K at a \(ceilings.maxMemoryGB) GB budget")
        if model.contextK > 0 {
            reasons.append("\(model.paramsB)B params · \(model.contextK / 1000)M-token window")
        }
        if !model.capabilities.isEmpty {
            reasons.append(model.capabilities.joined(separator: " · "))
        }
        reasons.append("downloads \(model.sizeGB) GB on first run")
        return reasons
    }
}
