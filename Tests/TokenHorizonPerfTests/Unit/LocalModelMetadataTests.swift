import XCTest
@testable import TokenHorizon

final class LocalModelMetadataTests: XCTestCase {

    func testLocalMetadataValue_primitives() {
        let strVal = LocalMetadataValue(jsonObject: "test-string")
        XCTAssertEqual(strVal, .string("test-string"))
        XCTAssertEqual(strVal?.scalarText, "test-string")
        XCTAssertEqual(strVal?.displayText, "test-string")

        let numVal = LocalMetadataValue(jsonObject: 42)
        XCTAssertEqual(numVal, .number("42"))
        XCTAssertEqual(numVal?.scalarText, "42")

        let boolVal = LocalMetadataValue(jsonObject: true)
        XCTAssertEqual(boolVal, .bool(true))
        XCTAssertEqual(boolVal?.scalarText, "true")

        let nullVal = LocalMetadataValue(jsonObject: NSNull())
        XCTAssertEqual(nullVal, .null)
        XCTAssertEqual(nullVal?.scalarText, "null")
    }

    func testLocalMetadataValue_nestedObjectAndArray() {
        let raw: [String: Any] = [
            "name": "qwen2.5-coder-7b",
            "context_length": 32768,
            "quantization": "4bit",
            "tags": ["code", "instruct", "tools"]
        ]

        guard let val = LocalMetadataValue(jsonObject: raw) else {
            XCTFail("Failed to parse nested dictionary")
            return
        }

        if case .object(let dict) = val {
            XCTAssertEqual(dict["name"], .string("qwen2.5-coder-7b"))
            XCTAssertEqual(dict["context_length"], .number("32768"))
            XCTAssertEqual(dict["quantization"], .string("4bit"))
            if case .array(let tags)? = dict["tags"] {
                XCTAssertEqual(tags.count, 3)
                XCTAssertEqual(tags[0], .string("code"))
            } else {
                XCTFail("tags is not an array")
            }
        } else {
            XCTFail("val is not an object")
        }
    }

    func testLocalMetadataValue_firstScalarMatching() {
        let raw: [String: Any] = [
            "architecture": [
                "weight_bits": 4,
                "head_dim": 128
            ]
        ]
        guard let val = LocalMetadataValue(jsonObject: raw) else {
            XCTFail("Failed to convert object")
            return
        }

        let match = val.firstScalar(matching: ["weight_bits", "quantization"])
        XCTAssertNotNil(match)
        XCTAssertEqual(match?.key, "weight_bits")
        XCTAssertEqual(match?.value, "4")
    }

    func testLocalMetadataValue_codableRoundtrip() throws {
        let original: LocalMetadataValue = .object([
            "model": .string("deepseek-coder-v2"),
            "context_k": .number("128"),
            "is_local": .bool(true),
            "layers": .array([.number("1"), .number("2")]),
            "null_field": .null
        ])

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(LocalMetadataValue.self, from: data)

        XCTAssertEqual(original, decoded)
    }

    func testMLXModelInspector_modelDirectoryValidation() {
        XCTAssertNil(MLXModelInspector.modelDirectory(for: "not-a-path"))
        XCTAssertNil(MLXModelInspector.modelDirectory(for: "/non/existent/path/for/sure/12345"))

        let tmpDir = FileManager.default.temporaryDirectory.standardizedFileURL
        let resolved = MLXModelInspector.modelDirectory(for: tmpDir.path)
        XCTAssertNotNil(resolved)
    }
}
