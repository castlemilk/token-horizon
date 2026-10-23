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
        let recs = LocalModelCatalog.reconciled(models: catalogue, machine: m64)
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
        let recs = LocalModelCatalog.reconciled(models: catalogue, machine: m16)
        XCTAssertEqual(recs.first?.model.name, "Qwen3 8B", "the 8B leads on a 16 GB machine")
        XCTAssertFalse(recs.contains { $0.model.paramsB > 10 }, "a 14B+ model must not be offered to a 16 GB machine — its resident footprint plus the 8 GB engine floor does not fit")
        XCTAssertTrue(recs.allSatisfy { $0.fit != .unsupported })
    }

    /// Below the engine's floor, the reconciliation offers nothing rather
    /// than a model that would make the machine unusable.
    func testReconciliation_tinyMachineOffersNothing() {
        XCTAssertTrue(LocalModelCatalog.reconciled(models: catalogue, machine: m8).isEmpty)
    }

    /// The catalogue can be filtered to one engine's back end.
    func testReconciliation_engineFilter() {
        let catalogue = catalogue + [model("Qwen3.8 27B Splash", paramsB: 27, sizeGB: 17.4,
                                           residentGB: 18.6, recommendedRAMGB: 48, engine: "splash")]
        let thengine = LocalModelCatalog.reconciled(models: catalogue, machine: m64, engine: "thengine")
        XCTAssertTrue(thengine.allSatisfy { $0.model.engine == "thengine" })
        let splash = LocalModelCatalog.reconciled(models: catalogue, machine: m64, engine: "splash")
        XCTAssertTrue(splash.allSatisfy { $0.model.engine == "splash" })
    }

    /// Serve ceilings come from the engine's own analysis, not the model's
    /// native window: a comfortable fit gets the full context, anything
    /// tighter gets a conservative ceiling that still covers agentic loops.
    func testServeCeilings_followTheFit() throws {
        // On 64 GB every catalogue row fits comfortably or generously.
        let recs = LocalModelCatalog.reconciled(models: catalogue, machine: m64)
        let generous = try XCTUnwrap(recs.first { $0.fit == .generous })
        XCTAssertGreaterThanOrEqual(generous.maxContextK, 32)
        XCTAssertGreaterThan(generous.maxMemoryGB, Int(generous.model.residentGB))
        // On 40 GB the 32B still runs but is a tight fit, and it gets the
        // conservative context ceiling.
        let tightRecs = LocalModelCatalog.reconciled(models: catalogue, machine: m40)
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
        XCTAssertGreaterThanOrEqual(models.count, 8, "the bundled catalogue must not be empty")
        for m in models {
            XCTAssertFalse(m.id.isEmpty)
            XCTAssertGreaterThan(m.sizeGB, 0, "\(m.name) must state a download size")
            XCTAssertGreaterThan(m.residentGB, 0, "\(m.name) must state a resident footprint")
            XCTAssertGreaterThan(m.contextK, 0, "\(m.name) must state a context window")
            XCTAssertTrue(["thengine", "splash"].contains(m.engine), "\(m.name) must name a bundled engine")
        }
        // Every GGUF row must carry the tokenizer sibling repo (a GGUF ships
        // no tokenizer.json, and the engine needs one to load).
        for m in models where m.engine == "thengine" {
            XCTAssertNotNil(m.tokenizer, "\(m.name) must carry a tokenizer repo for GGUF serving")
        }
    }
}
