import XCTest
@testable import TokenHorizon

/// Tests for local-model metadata plumbing: JSON coercion, scalar search,
/// display text, and metadata assembly. Fully hermetic (no Ollama daemon).
final class OllamaMetadataTests: XCTestCase {

    func testInitFromJSONObject() {
        XCTAssertEqual(LocalMetadataValue(jsonObject: NSNull()), .null)
        XCTAssertEqual(LocalMetadataValue(jsonObject: "hi"), .string("hi"))
        XCTAssertEqual(LocalMetadataValue(jsonObject: true), .bool(true))
        XCTAssertEqual(LocalMetadataValue(jsonObject: 7), .number("7"))
        XCTAssertEqual(LocalMetadataValue(jsonObject: 2.5), .number("2.5"))
        let obj = LocalMetadataValue(jsonObject: ["a": 1, "b": "x", "c": [true, NSNull()]])
        XCTAssertEqual(obj?["a"] ?? nil, .number("1"))
        XCTAssertEqual(obj?["b"] ?? nil, .string("x"))
        if case .object(let values) = obj {
            XCTAssertEqual(values["c"], .array([.bool(true), .null]))
        } else {
            XCTFail("expected object")
        }
        // Unsupported payloads are skipped, never crash.
        XCTAssertNil(LocalMetadataValue(jsonObject: Date()))
    }

    func testScalarAndDisplayText() {
        XCTAssertEqual(LocalMetadataValue.string("s").scalarText, "s")
        XCTAssertEqual(LocalMetadataValue.number("3").scalarText, "3")
        XCTAssertEqual(LocalMetadataValue.bool(false).scalarText, "false")
        XCTAssertNil(LocalMetadataValue.array([]).scalarText)
        XCTAssertEqual(LocalMetadataValue.object(["a": .number("1"), "b": .number("2")]).displayText,
                       "{2 fields}")
        XCTAssertEqual(LocalMetadataValue.array([.null]).displayText, "[1 items]")
    }

    func testFirstScalarPrefersKeysThenDepth() {
        let v = LocalMetadataValue(jsonObject: ["z": ["model": "deep"], "name": "top"] as [String: Any])
        XCTAssertEqual(v?.firstScalar(matching: ["model"])?.value ?? nil, "deep")
        XCTAssertEqual(v?.firstScalar(matching: ["name"])?.value ?? nil, "top")
        XCTAssertNil(v?.firstScalar(matching: ["nope"]))
    }

    func testJsonObjectRoundTrip() {
        let v = LocalMetadataValue(jsonObject: ["n": 3, "s": "x", "b": false] as [String: Any])
        let back = v?.jsonObject as? [String: Any]
        XCTAssertEqual(back?["n"] as? Int64, 3)
        XCTAssertEqual(back?["s"] as? String, "x")
        XCTAssertEqual(back?["b"] as? Bool, false)
    }

    func testRunningModelMatching() {
        func obj(_ models: [[String: String]]) -> LocalMetadataValue {
            .object(["models": .array(models.map { m in
                .object(Dictionary(uniqueKeysWithValues: m.map { ($0.key, LocalMetadataValue.string($0.value)) }))
            })])
        }
        let ps = obj([["name": "Qwen3:8B"], ["model": "llama3"]])
        XCTAssertNotNil(OllamaClient.runningModel(from: ps, matching: "qwen3:8b"))
        XCTAssertNotNil(OllamaClient.runningModel(from: ps, matching: "LLAMA3"))
        XCTAssertNil(OllamaClient.runningModel(from: ps, matching: "missing"))
        XCTAssertNil(OllamaClient.runningModel(from: nil, matching: "qwen3"))
        XCTAssertNil(OllamaClient.runningModel(from: .string("x"), matching: "x"))
    }

    func testMakeModelMetadataSectionsAndErrors() {
        let installed = OllamaModel(name: "m", size: 1, modifiedAt: "", capabilities: [],
                                    details: [:], modelID: "mid", rawMetadata: .string("raw"))
        // Nothing at all → daemon error.
        let empty = OllamaClient.makeModelMetadata(name: "m", installed: nil, card: nil)
        XCTAssertNotNil(empty.error)
        XCTAssertTrue(empty.sections.isEmpty)
        // Installed only → config error, tags section present.
        let tagsOnly = OllamaClient.makeModelMetadata(name: "m", installed: installed, card: nil)
        XCTAssertNotNil(tagsOnly.error)
        XCTAssertNotNil(tagsOnly.sections["installed /api/tags"])
        // Card only → no error.
        let cardOnly = OllamaClient.makeModelMetadata(name: "m", installed: nil, card: .string("c"))
        XCTAssertNil(cardOnly.error)
        XCTAssertNotNil(cardOnly.sections["configuration /api/show"])
        // All three sections present when all inputs given.
        let full = OllamaClient.makeModelMetadata(name: "m", installed: installed,
                                                  card: .string("c"), running: .string("r"))
        XCTAssertNil(full.error)
        XCTAssertEqual(full.sections.count, 3)
        XCTAssertEqual(full.backend, "ollama")
        XCTAssertEqual(full.model, "m")
    }
}

private extension LocalMetadataValue {
    subscript(key: String) -> LocalMetadataValue? {
        if case .object(let values) = self { return values[key] }
        return nil
    }
}
