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
}

private extension LocalMetadataValue {
    subscript(key: String) -> LocalMetadataValue? {
        if case .object(let values) = self { return values[key] }
        return nil
    }
}
