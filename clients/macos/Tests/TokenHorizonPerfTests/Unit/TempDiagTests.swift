import XCTest
@testable import TokenHorizon

final class TempDiagTests: XCTestCase {
    func testDiag() {
        let big = LocalModelCatalog.Model(id: "test/Big 70B", name: "Big 70B", engine: "thengine", family: "qwen3",
                                          paramsB: 70, quant: "Q4_K_M", sizeGB: 42, residentGB: 44, contextK: 32768,
                                          capabilities: ["tools"], minRAMGB: 0, recommendedRAMGB: 60, license: "",
                                          file: nil, tokenizer: nil)
        let mid = LocalModelCatalog.Model(id: "test/Qwen3 32B", name: "Qwen3 32B", engine: "thengine", family: "qwen3",
                                          paramsB: 32.7, quant: "Q4_K_M", sizeGB: 19.8, residentGB: 21, contextK: 32768,
                                          capabilities: ["tools"], minRAMGB: 0, recommendedRAMGB: 48, license: "",
                                          file: nil, tokenizer: nil)
        let m = HardwareProfile.Machine(chipName: "Apple M5 Ultra", physicalMemoryGB: 256, macosMajor: 26, macosMinor: 4,
                                        chipGeneration: 5, chipTier: .ultra)
        let profile = HardwareMap.load()
        print("DIAG profile machine:", profile.machine.chip, profile.machine.bandwidthGBs, "measurements:", profile.measurements.count)
        for e in [big, mid] {
            print("DIAG", e.name, "est=", profile.estimateTokPerSec(paramsB: e.paramsB, quant: e.quant),
                  "measured=", profile.measured(spec: e.modelSpec)?.tokPerSec as Any)
        }
        let recs = LocalModelCatalog.reconciled(models: [big, mid], machine: m)
        for r in recs { print("DIAG rec", r.model.name, "tok=", r.tokPerSec, "measured=", r.tokPerSecMeasured, "fit=", r.fit) }
    }
}
