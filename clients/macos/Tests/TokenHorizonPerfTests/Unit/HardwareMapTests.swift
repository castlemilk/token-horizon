import XCTest
@testable import TokenHorizon

/// The hardware mapping profile: measured throughput per model, a
/// bandwidth-derived estimate for everything else, and the selection rule —
/// a model that decodes below the interactive floor is the wrong
/// recommendation however capable.
final class HardwareMapTests: XCTestCase {

    private let machine = HardwareMap.Machine(chip: "Apple M5 Max", memoryGB: 64, bandwidthGBs: 546)

    private func map(_ measurements: [HardwareMap.Measurement]) -> HardwareMap {
        HardwareMap(machine: machine, measurements: measurements)
    }

    private func measurement(_ spec: String, tokPerSec: Double) -> HardwareMap.Measurement {
        HardwareMap.Measurement(modelSpec: spec, engine: "thengine", quant: "Q4_K_M", paramsB: 32.7,
                                tokPerSec: tokPerSec, promptTokPerSec: nil,
                                measuredAt: Date(), source: "gateway")
    }

    /// Bytes per token follows the quantisation: a Q4_K_M 32B moves ~18 GB per
    /// token, an 8-bit one moves twice that.
    func testBytesPerToken_followsQuantisation() {
        XCTAssertEqual(HardwareMap.bytesPerToken(paramsB: 32.7, quant: "Q4_K_M"), 32.7 * 0.57, accuracy: 0.01)
        XCTAssertEqual(HardwareMap.bytesPerToken(paramsB: 32.7, quant: "Q8_0"), 32.7 * 1.05, accuracy: 0.01)
    }

    /// The estimate is bandwidth-bound: tok/s ≈ utilisation × bandwidth /
    /// bytes-per-token. For a 32B Q4 on a 546 GB/s Max: 0.7 × 546 / 18.6 ≈ 20.
    func testEstimate_isBandwidthBound() {
        let map = map([])
        let estimate = map.estimateTokPerSec(paramsB: 32.7, quant: "Q4_K_M")
        XCTAssertEqual(estimate, (machine.bandwidthGBs * 0.7 / (32.7 * 0.57)).rounded(.down), accuracy: 1)
        XCTAssertGreaterThan(estimate, HardwareMap.interactiveFloor, "a 32B Q4 on a Max tier is interactive")
    }

    /// A measurement outranks the estimate for the same model, and recording a
    /// new measurement replaces the old one for that spec.
    func testMeasured_beatsEstimate_andNewestWins() {
        let spec = "Qwen/Qwen3-32B-GGUF:Qwen3-32B-Q4_K_M.gguf"
        let now = map([measurement(spec, tokPerSec: 21.0)])
        XCTAssertEqual(now.measured(spec: spec)?.tokPerSec, 21.0)
        let updated = now.record(measurement(spec, tokPerSec: 18.0))
        XCTAssertEqual(updated.measured(spec: spec)?.tokPerSec, 18.0,
                       "a new measurement replaces the old one for the same spec")
    }

    /// The record/reload round trip must preserve the profile — a lost
    /// measurement is a lost calibration.
    func testRoundTrip_preservesMeasurements() throws {
        var m = map([measurement("a", tokPerSec: 20)])
        m.machine = machine
        let data = try JSONEncoder().encode(m)
        let back = try JSONDecoder().decode(HardwareMap.self, from: data)
        XCTAssertEqual(back.measurements.first?.tokPerSec, 20)
        XCTAssertEqual(back.machine.chip, "Apple M5 Max")
    }
}
