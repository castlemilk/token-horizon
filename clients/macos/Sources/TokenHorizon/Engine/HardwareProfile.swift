import Foundation

/// Hardware probe + per-model fit analysis for the local inference engine.
///
/// Splash's contract: Apple silicon M3+, macOS 26.4+ (placement-sparse
/// support), ≥36 GB unified memory. Each model package has a fixed resident
/// cost (weights + trained DFlash draft) plus a per-context KV/state cost,
/// so fit is decided against physical memory — not free memory at launch,
/// which fluctuates and would make the verdict unstable.
///
/// The engine itself computes its own memory budget from Metal's
/// recommendedWorkingSet; our job is to pick the *ceiling* that leaves the
/// machine usable (editor, browser, the OS) while a task runs.
enum HardwareProfile {

    // MARK: - Probe

    struct Machine {
        let chipName: String        // "Apple M5 Max"
        let physicalMemoryGB: Double
        let macosMajor: Int
        let macosMinor: Int
        let chipGeneration: Int     // M3 => 3, M5 Max => 5
        let chipTier: ChipTier

        enum ChipTier: Int { case base = 0, pro, max, ultra }
    }

    static func probe() -> Machine {
        let chip = SystemStats.cpuBrandString()
        let memBytes = ProcessInfo.processInfo.physicalMemory
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return Machine(chipName: chip,
                       physicalMemoryGB: Double(memBytes) / 1_073_741_824,
                       macosMajor: os.majorVersion,
                       macosMinor: os.minorVersion,
                       chipGeneration: Self.chipGeneration(from: chip),
                       chipTier: Self.chipTier(from: chip))
    }

    /// "Apple M5 Max" -> 5; unknown -> 0.
    static func chipGeneration(from name: String) -> Int {
        guard let range = name.range(of: #"M(\d+)"#, options: .regularExpression) else { return 0 }
        let digits = name[range].dropFirst()
        return Int(digits) ?? 0
    }

    static func chipTier(from name: String) -> Machine.ChipTier {
        let n = name.lowercased()
        if n.contains("ultra") { return .ultra }
        if n.contains("max") { return .max }
        if n.contains("pro") { return .pro }
        return .base
    }

    // MARK: - Eligibility

    /// Nil when the machine can host the engine; otherwise a human-readable
    /// blocker. Mirrors the native binary's own validation (macOS ≥26.4,
    /// Apple GPU family ≥9 ≈ M3+).
    static func eligibilityBlocker(_ m: Machine) -> String? {
        if m.chipGeneration > 0 && m.chipGeneration < 3 {
            return "Splash needs Apple silicon M3 or newer (found \(m.chipName))"
        }
        if m.macosMajor < 26 || (m.macosMajor == 26 && m.macosMinor < 4) {
            return "Splash needs macOS 26.4 or newer (found \(m.macosMajor).\(m.macosMinor))"
        }
        if m.physicalMemoryGB < 36 {
            return "Splash needs at least 36 GB unified memory (found \(Int(m.physicalMemoryGB)) GB)"
        }
        return nil
    }

    // MARK: - Model catalog + fit

    struct EngineModel {
        let id: String              // HF repo id
        let displayName: String
        let packageGB: Double       // download size
        let residentGB: Double      // weights + draft, fixed
        let kind: String            // "dense" | "moe"
        let recommendedRAMGB: Double
    }

    /// The official roster (splash install/catalog.py BUNDLED list). Static
    /// here — a refreshable catalog can come later once this surface settles.
    static let catalog: [EngineModel] = [
        EngineModel(id: "incoai/Qwen3.8-27B-Splash",
                    displayName: "Qwen3.8 27B",
                    packageGB: 17.4, residentGB: 16.2,
                    kind: "dense", recommendedRAMGB: 48),
        EngineModel(id: "incoai/Qwen3.6-35B-A3B-Splash",
                    displayName: "Qwen3.6 35B-A3B (MoE)",
                    packageGB: 20.9, residentGB: 18.5,
                    kind: "moe", recommendedRAMGB: 48),
    ]

    enum Fit: String {
        case unsupported   // below the engine's own floor
        case tight         // runs, but little room for anything else
        case comfortable   // recommended RAM tier
        case generous      // big headroom — larger context / concurrency OK

        var badge: String {
            switch self {
            case .unsupported: return "won't fit"
            case .tight: return "tight"
            case .comfortable: return "good fit"
            case .generous: return "plenty of headroom"
            }
        }
    }

    static func fit(_ model: EngineModel, on m: Machine) -> Fit {
        let ram = m.physicalMemoryGB
        if eligibilityBlocker(m) != nil || ram < model.residentGB + 8 {
            return .unsupported
        }
        if ram < model.recommendedRAMGB { return .tight }
        if ram >= model.recommendedRAMGB * 2 { return .generous }
        return .comfortable
    }

    /// Default ceilings for a serve, tuned to the machine. Memory budget
    /// leaves ~30% for OS + apps on small machines, less on big ones; context
    /// defaults to the model's full window when memory is generous, else a
    /// conservative 32K that still covers agentic coding loops.
    static func recommendedCeilings(_ model: EngineModel, on m: Machine)
        -> (maxMemoryGB: Int, maxContextK: Int) {
        let ram = m.physicalMemoryGB
        let reserve: Double = ram >= 96 ? ram * 0.25 : 12
        let budget = max(model.residentGB + 4, ram - reserve)
        let context: Int = fit(model, on: m) == .generous ? 128 : 32
        return (Int(budget.rounded(.down)), context)
    }
}
