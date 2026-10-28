import XCTest
@testable import TokenHorizon

/// The local-model catalogue reconciled against a machine: what can run here,
/// best options first. Pure logic — a catalogue row × a machine probe → a fit
/// verdict, serve ceilings and the reasons a row made the list.
final class LocalModelCatalogTests: XCTestCase {

    private let m64 = HardwareProfile.Machine(chipName: "Apple M5 Max", physicalMemoryGB: 64,
                                               macosMajor: 26, macosMinor: 4,
                                               chipGeneration: 5, chipTier: .max)
    /// Room for the 32B, but only just: the recommended RAM tier (48 GB) is
    /// above this machine, so the 32B is a tight fit here.
    private let m40 = HardwareProfile.Machine(chipName: "Apple M4 Pro", physicalMemoryGB: 40,
                                              macosMajor: 26, macosMinor: 4,
                                              chipGeneration: 4, chipTier: .pro)
    private let m16 = HardwareProfile.Machine(chipName: "Apple M4", physicalMemoryGB: 16,
                                              macosMajor: 26, macosMinor: 4,
                                              chipGeneration: 4, chipTier: .base)
    private let m8 = HardwareProfile.Machine(chipName: "Apple M2", physicalMemoryGB: 8,
                                             macosMajor: 26, macosMinor: 4,
                                             chipGeneration: 2, chipTier: .base)

    /// A deterministic hardware profile for the machine under test: the
    /// declared chip's published bandwidth, no measurements. Without it
    /// `reconciled` probes the host — fine on a fast Mac, but a weak CI
    /// runner would mark big models slow and flip every ranking assertion.
    private func map(for machine: HardwareProfile.Machine) -> HardwareMap {
        HardwareMap(machine: .init(chip: machine.chipName, memoryGB: Int(machine.physicalMemoryGB),
                                   bandwidthGBs: HardwareMap.bandwidthGBs(chip: machine.chipName)),
                    measurements: [])
    }

    private func model(_ name: String, paramsB: Double, sizeGB: Double, residentGB: Double,
                       recommendedRAMGB: Int, engine: String = "thengine") -> LocalModelCatalog.Model {
        LocalModelCatalog.Model(id: "test/\(name)", name: name, engine: engine, family: "qwen3",
                                paramsB: paramsB, quant: "Q4_K_M", sizeGB: sizeGB, residentGB: residentGB,
                                contextK: 32768, capabilities: ["tools"], minRAMGB: 0,
                                recommendedRAMGB: recommendedRAMGB, license: "apache-2.0",
                                file: nil, tokenizer: nil)
    }

    private var catalogue: [LocalModelCatalog.Model] {
        [model("Qwen3 32B", paramsB: 32.7, sizeGB: 19.8, residentGB: 21.0, recommendedRAMGB: 48),
         model("Qwen3 14B", paramsB: 14.8, sizeGB: 9.0, residentGB: 10.2, recommendedRAMGB: 24),
         model("Qwen3 8B", paramsB: 8.2, sizeGB: 5.0, residentGB: 6.2, recommendedRAMGB: 16),
         model("Qwen3 4B", paramsB: 4.0, sizeGB: 2.5, residentGB: 3.7, recommendedRAMGB: 12)]
    }

    /// Best options first: on a machine with room, the most capable model that
    /// still fits comfortably leads, and models that would squeeze the machine
    /// rank below anything that leaves it usable.
    func testReconciliation_ranksComfortableFitAboveTightByCapability() {
        let recs = LocalModelCatalog.reconciled(models: catalogue, machine: m64, map: map(for: m64))
        XCTAssertEqual(recs.first?.model.name, "Qwen3 32B", "the largest comfortable model leads on a 64 GB machine")
        XCTAssertEqual(recs.first?.fit, .comfortable)
        // The 14B has generous headroom but is less capable; it must not lead.
        XCTAssertLessThan(recs.first!.model.paramsB, 33)
        for rec in recs {
            XCTAssertNotEqual(rec.fit, .unsupported)
            XCTAssertFalse(rec.reasons.isEmpty, "every recommendation explains itself")
        }
    }

    /// A small machine gates the big models out entirely — and says why.
    func testReconciliation_smallMachineGetsTheSmallModels() {
        let recs = LocalModelCatalog.reconciled(models: catalogue, machine: m16, map: map(for: m16))
        XCTAssertEqual(recs.first?.model.name, "Qwen3 8B", "the 8B leads on a 16 GB machine")
        XCTAssertFalse(recs.contains { $0.model.paramsB > 10 }, "a 14B+ model must not be offered to a 16 GB machine — its resident footprint plus the 8 GB engine floor does not fit")
        XCTAssertTrue(recs.allSatisfy { $0.fit != .unsupported })
    }

    /// Below the engine's floor, the reconciliation offers nothing rather
    /// than a model that would make the machine unusable.
    func testReconciliation_tinyMachineOffersNothing() {
        XCTAssertTrue(LocalModelCatalog.reconciled(models: catalogue, machine: m8, map: map(for: m8)).isEmpty)
    }

    /// The catalogue can be filtered to one engine's back end — including MLX,
    /// which has no catalogue of its own beyond these rows.
    func testReconciliation_engineFilter() {
        let catalogue = catalogue + [model("Qwen3.8 27B Splash", paramsB: 27, sizeGB: 17.4,
                                           residentGB: 18.6, recommendedRAMGB: 48, engine: "splash"),
                                     model("Qwen3 8B MLX", paramsB: 8.2, sizeGB: 4.6,
                                           residentGB: 6.2, recommendedRAMGB: 16, engine: "mlx")]
        let thengine = LocalModelCatalog.reconciled(models: catalogue, machine: m64, engine: "thengine", map: map(for: m64))
        XCTAssertTrue(thengine.allSatisfy { $0.model.engine == "thengine" })
        let splash = LocalModelCatalog.reconciled(models: catalogue, machine: m64, engine: "splash", map: map(for: m64))
        XCTAssertTrue(splash.allSatisfy { $0.model.engine == "splash" })
        let mlx = LocalModelCatalog.reconciled(models: catalogue, machine: m64, engine: "mlx", map: map(for: m64))
        XCTAssertEqual(mlx.map(\.model.name), ["Qwen3 8B MLX"])
        XCTAssertEqual(mlx.first?.fit, .generous, "MLX rows are reconciled like any other engine")
    }

    /// Throughput selects models better than fit alone: a 70B that fits but
    /// decodes below the interactive floor ranks below a 32B that streams —
    /// and a measured number always beats the bandwidth estimate.
    func testReconciliation_slowModelsRankBelowInteractiveOnes() throws {
        let big = model("Big 70B", paramsB: 70, sizeGB: 42, residentGB: 44, recommendedRAMGB: 60)
        let mid = model("Qwen3 32B", paramsB: 32.7, sizeGB: 19.8, residentGB: 21, recommendedRAMGB: 48)
        let bigMachine = HardwareProfile.Machine(chipName: "Apple M5 Ultra", physicalMemoryGB: 256,
                                                 macosMajor: 26, macosMinor: 4,
                                                 chipGeneration: 5, chipTier: .ultra)
        // The profile is for the machine under test: an Ultra's bandwidth makes
        // the 70B's estimate interactive, so it leads.
        let ultra = HardwareMap(machine: .init(chip: bigMachine.chipName, memoryGB: 256, bandwidthGBs: 650),
                                measurements: [])
        let unmeasured = LocalModelCatalog.reconciled(models: [big, mid], machine: bigMachine, map: ultra)
        XCTAssertEqual(unmeasured.first?.model.name, "Big 70B")

        // A measured profile that says the 70B crawls flips the ranking.
        let slow = ultra.record(HardwareMap.Measurement(modelSpec: "test/Big 70B", engine: "thengine",
                                                        quant: "Q4_K_M", paramsB: 70, tokPerSec: 3,
                                                        promptTokPerSec: nil, measuredAt: Date(), source: "gateway"))
        let measured = LocalModelCatalog.reconciled(models: [big, mid], machine: bigMachine, map: slow)
        XCTAssertEqual(measured.first?.model.name, "Qwen3 32B", "a 3 tok/s 70B is the wrong recommendation")
        XCTAssertFalse(measured.first!.tokPerSecMeasured, "the 32B is ranked on its estimate")
        XCTAssertTrue(measured.first!.reasons.first!.contains("estimated"))
        let slowRow = try XCTUnwrap(measured.last)
        XCTAssertEqual(slowRow.model.name, "Big 70B")
        XCTAssertTrue(slowRow.tokPerSecMeasured, "the 70B's crawl is a measurement")
        XCTAssertTrue(slowRow.reasons.first!.contains("3 tok/s"))
    }

    /// Serve ceilings come from the engine's own analysis, not the model's
    /// native window: a comfortable fit gets the full context, anything
    /// tighter gets a conservative ceiling that still covers agentic loops.
    func testServeCeilings_followTheFit() throws {
        // On 64 GB every catalogue row fits comfortably or generously.
        let recs = LocalModelCatalog.reconciled(models: catalogue, machine: m64, map: map(for: m64))
        let generous = try XCTUnwrap(recs.first { $0.fit == .generous })
        XCTAssertGreaterThanOrEqual(generous.maxContextK, 32)
        XCTAssertGreaterThan(generous.maxMemoryGB, Int(generous.model.residentGB))
        // On 40 GB the 32B still runs but is a tight fit, and it gets the
        // conservative context ceiling.
        let tightRecs = LocalModelCatalog.reconciled(models: catalogue, machine: m40, map: map(for: m40))
        let tight = try XCTUnwrap(tightRecs.first { $0.fit == .tight })
        XCTAssertEqual(tight.model.name, "Qwen3 32B")
        XCTAssertEqual(tight.maxContextK, 32, "a tight fit gets the conservative context ceiling")
        XCTAssertGreaterThan(tight.maxMemoryGB, Int(tight.model.residentGB), "the memory ceiling covers the weights")
    }

    /// The bundled catalogue must parse and carry the fields the reconciliation
    /// and the serve path need — a malformed resource would silently empty the
    /// ENGINE tab's recommendations.
    func testBundledCatalogue_parsesAndCarriesServeFields() {
        let models = LocalModelCatalog.models()
        XCTAssertGreaterThanOrEqual(models.count, 20, "the bundled catalogue is the rich local roster, not a stub")
        for m in models {
            XCTAssertFalse(m.id.isEmpty)
            XCTAssertGreaterThan(m.sizeGB, 0, "\(m.name) must state a download size")
            XCTAssertGreaterThan(m.residentGB, 0, "\(m.name) must state a resident footprint")
            XCTAssertGreaterThan(m.contextK, 0, "\(m.name) must state a context window")
            XCTAssertTrue(["thengine", "splash", "mlx"].contains(m.engine), "\(m.name) must name a supervised engine")
            XCTAssertFalse(m.capabilities.isEmpty, "\(m.name) must state its capabilities")
        }
        // Every pinned GGUF row must carry the tokenizer sibling repo (a GGUF
        // ships no tokenizer.json, and the engine needs one to load). Directory
        // repos (MLX checkpoints, Splash packages) ship their own tokenizer.
        for m in models where m.engine == "thengine" && m.file != nil {
            XCTAssertNotNil(m.tokenizer, "\(m.name) must carry a tokenizer repo for GGUF serving")
        }
    }

    /// Three engines, one row each per model: the picker and the
    /// `ForEach(id: \.modelSpec)` in the UI both rely on that.
    func testBundledCatalogue_coversEveryEngineWithUniqueSpecs() {
        let models = LocalModelCatalog.models()
        XCTAssertEqual(LocalModelCatalog.engines(), ["thengine", "splash", "mlx"])
        let specs = models.map(\.modelSpec)
        XCTAssertEqual(Set(specs).count, specs.count, "a duplicate model spec would collide in the UI list")
        for engine in ["thengine", "splash", "mlx"] {
            XCTAssertGreaterThanOrEqual(models.filter { $0.engine == engine }.count, 2,
                                        "\(engine) must offer real choice, not a single row")
        }
        // The catalogue's whole point: on a big Mac each engine has something
        // that runs, and the rows carry ceilings to serve it.
        let big = HardwareProfile.Machine(chipName: "Apple M5 Max", physicalMemoryGB: 128,
                                          macosMajor: 26, macosMinor: 4,
                                          chipGeneration: 5, chipTier: .max)
        for engine in LocalModelCatalog.engines() {
            let runnable = LocalModelCatalog.runnable(for: big, engine: engine, map: map(for: big))
            XCTAssertFalse(runnable.isEmpty, "\(engine) must have a runnable row on a 128 GB Mac")
            for rec in runnable {
                XCTAssertGreaterThan(rec.maxMemoryGB, 0)
                XCTAssertGreaterThan(rec.maxContextK, 0)
                XCTAssertGreaterThan(rec.tokPerSec, 0, "\(rec.model.name) must carry a throughput figure")
            }
        }
    }

    /// A small Mac is exactly where the MoE estimate matters: Flint 3/4-bit
    /// fits a 32 GB Mac, and priced as a dense 40B on a 120 GB/s bus it would
    /// fall under the interactive floor and be ranked below everything.
    func testBundledFlintRows_areEstimatedAsMoE() throws {
        let models = LocalModelCatalog.models()
        let flint = try XCTUnwrap(models.first { $0.id == "mlx-community/flint-mixed-3-4bit" })
        XCTAssertEqual(flint.activeParamsB, 2.5)
        let m32 = HardwareProfile.Machine(chipName: "Apple M4", physicalMemoryGB: 32,
                                          macosMajor: 26, macosMinor: 4,
                                          chipGeneration: 4, chipTier: .base)
        let map = HardwareMap(machine: .init(chip: m32.chipName, memoryGB: 32, bandwidthGBs: 120),
                              measurements: [])
        let rec = try XCTUnwrap(LocalModelCatalog.reconciled(models: [flint], machine: m32, map: map).first)
        XCTAssertGreaterThan(rec.tokPerSec, HardwareMap.interactiveFloor)
        XCTAssertTrue(rec.reasons.contains { $0.contains("2.5B active") && $0.contains("262K-token") })
    }

    /// Early rows spelled capabilities `caps`; both spellings must survive the
    /// decode, and a row without a real download size is rejected rather than
    /// presented as a model you can fetch.
    func testDecode_readsCapabilitiesAndRejectsSizelessRows() throws {
        let json = """
        {"models": [
          {"id": "a/one", "name": "One", "engine": "mlx", "sizeGB": 4.6, "residentGB": 6.0,
           "contextK": 32768, "caps": ["tools", "code"]},
          {"id": "a/two", "name": "Two", "engine": "thengine", "sizeGB": 5.0, "residentGB": 6.2,
           "contextK": 32768, "capabilities": ["thinking"]},
          {"id": "a/three", "name": "Three", "engine": "thengine", "contextK": 32768}
        ]}
        """
        let models = LocalModelCatalog.decode(Data(json.utf8))
        XCTAssertEqual(models.count, 2, "a row with no download size must not enter the catalogue")
        XCTAssertEqual(models[0].capabilities, ["tools", "code"])
        XCTAssertEqual(models[1].capabilities, ["thinking"])
        XCTAssertEqual(LocalModelCatalog.engineLabel("mlx"), "MLX")
    }
}
