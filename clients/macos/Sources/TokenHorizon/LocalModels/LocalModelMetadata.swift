import Foundation

/// JSON values returned by local model runtimes. Keeping the tree instead of
/// flattening it means new Ollama and MLX fields are visible without an app
/// update to the parser.
enum LocalMetadataValue: Equatable, Codable {
    case string(String)
    case number(String)
    case bool(Bool)
    case object([String: LocalMetadataValue])
    case array([LocalMetadataValue])
    case null

    private enum CodingKeys: String, CodingKey {
        case type
        case value
    }

    private enum ValueType: String, Codable {
        case string
        case number
        case bool
        case object
        case array
        case null
    }

    init?(jsonObject: Any) {
        if jsonObject is NSNull {
            self = .null
        } else if let object = jsonObject as? [String: Any] {
            var values: [String: LocalMetadataValue] = [:]
            for (key, value) in object {
                guard let converted = LocalMetadataValue(jsonObject: value) else { continue }
                values[key] = converted
            }
            self = .object(values)
        } else if let array = jsonObject as? [Any] {
            self = .array(array.compactMap { LocalMetadataValue(jsonObject: $0) })
        } else if let string = jsonObject as? String {
            self = .string(string)
        } else if let bool = jsonObject as? Bool {
            self = .bool(bool)
        } else if let number = jsonObject as? NSNumber {
            let type = String(cString: number.objCType)
            if type == "c" || type == "B" {
                self = .bool(number.boolValue)
            } else {
                self = .number(number.stringValue)
            }
        } else {
            return nil
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(ValueType.self, forKey: .type)
        switch type {
        case .string:
            self = .string(try container.decode(String.self, forKey: .value))
        case .number:
            self = .number(try container.decode(String.self, forKey: .value))
        case .bool:
            self = .bool(try container.decode(Bool.self, forKey: .value))
        case .object:
            self = .object(try container.decode([String: LocalMetadataValue].self, forKey: .value))
        case .array:
            self = .array(try container.decode([LocalMetadataValue].self, forKey: .value))
        case .null:
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .string(let value):
            try container.encode(ValueType.string, forKey: .type)
            try container.encode(value, forKey: .value)
        case .number(let value):
            try container.encode(ValueType.number, forKey: .type)
            try container.encode(value, forKey: .value)
        case .bool(let value):
            try container.encode(ValueType.bool, forKey: .type)
            try container.encode(value, forKey: .value)
        case .object(let value):
            try container.encode(ValueType.object, forKey: .type)
            try container.encode(value, forKey: .value)
        case .array(let value):
            try container.encode(ValueType.array, forKey: .type)
            try container.encode(value, forKey: .value)
        case .null:
            try container.encode(ValueType.null, forKey: .type)
        }
    }

    var scalarText: String? {
        switch self {
        case .string(let value): return value
        case .number(let value): return value
        case .bool(let value): return value ? "true" : "false"
        case .null: return "null"
        case .object, .array: return nil
        }
    }

    var displayText: String {
        if let scalarText { return scalarText }
        switch self {
        case .object(let values): return "{\(values.count) fields}"
        case .array(let values): return "[\(values.count) items]"
        case .string, .number, .bool, .null: return scalarText ?? ""
        }
    }

    func firstScalar(matching keys: Set<String>) -> (key: String, value: String)? {
        switch self {
        case .object(let values):
            for key in values.keys.sorted() {
                guard let value = values[key] else { continue }
                if keys.contains(key.lowercased()), let text = value.scalarText {
                    return (key, text)
                }
            }
            for key in values.keys.sorted() {
                if let result = values[key]?.firstScalar(matching: keys) {
                    return result
                }
            }
        case .array(let values):
            for value in values {
                if let result = value.firstScalar(matching: keys) {
                    return result
                }
            }
        case .string, .number, .bool, .null:
            break
        }
        return nil
    }

    var jsonObject: Any {
        switch self {
        case .string(let value): return value
        case .number(let value):
            if let integer = Int64(value) { return integer }
            if let decimal = Double(value) { return decimal }
            return value
        case .bool(let value): return value
        case .object(let values): return values.mapValues(\.jsonObject)
        case .array(let values): return values.map(\.jsonObject)
        case .null: return NSNull()
        }
    }
}

struct LocalModelMetadata: Equatable, Identifiable {
    var backend: String
    var model: String
    var sections: [String: LocalMetadataValue]
    var error: String?

    var id: String { "\(backend)/\(model)" }
}

/// Reads configuration that is available locally for an MLX model directory.
/// This is deliberately independent from UsageEngine and is called off-main
/// when a runner detail sheet is opened.
enum MLXModelInspector {
    private static let configFiles = [
        "config.json",
        "generation_config.json",
        "tokenizer_config.json",
        "tokenizer.json",
        "special_tokens_map.json",
        "preprocessor_config.json",
        "processor_config.json",
        "adapter_config.json",
        "model.safetensors.index.json"
    ]

    static func modelDirectory(for model: String) -> URL? {
        var path = model.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        if path.hasPrefix("file://"), let fileURL = URL(string: path) {
            path = fileURL.path
        }
        path = NSString(string: path).expandingTildeInPath
        guard path.contains("/") || path.hasPrefix(".") else { return nil }

        let url: URL
        if path.hasPrefix("/") {
            url = URL(fileURLWithPath: path)
        } else {
            url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(path)
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return nil
        }
        return url.standardizedFileURL
    }

    static func metadata(for model: String, command: String? = nil) -> LocalModelMetadata? {
        guard let directory = modelDirectory(for: model) else { return nil }
        let fileManager = FileManager.default
        var sections: [String: LocalMetadataValue] = [:]
        var totalBytes: UInt64 = 0
        var fileCount = 0
        var fileValues: [String: LocalMetadataValue] = [:]

        let keys: Set<URLResourceKey> = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        if let enumerator = fileManager.enumerator(at: directory, includingPropertiesForKeys: Array(keys), options: [.skipsPackageDescendants]) {
            while let url = enumerator.nextObject() as? URL {
                guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else { continue }
                let size = UInt64(max(values.fileSize ?? 0, 0))
                totalBytes += size
                fileCount += 1

                let relative = url.path.replacingOccurrences(of: directory.path + "/", with: "")
                if fileValues.count < 512 {
                    var fileInfo: [String: LocalMetadataValue] = [
                        "size_bytes": .number(String(size)),
                        "size": .string(ByteCountFormatter.string(fromByteCount: Int64(min(size, UInt64(Int64.max))), countStyle: .file))
                    ]
                    if let modified = values.contentModificationDate {
                        fileInfo["modified_at"] = .string(ISO8601DateFormatter().string(from: modified))
                    }
                    fileValues[relative] = .object(fileInfo)
                }
            }
        }

        let format = modelFormat(files: fileValues.keys)
        var overview: [String: LocalMetadataValue] = [
            "path": .string(directory.path),
            "size_bytes": .number(String(totalBytes)),
            "size": .string(ByteCountFormatter.string(fromByteCount: Int64(min(totalBytes, UInt64(Int64.max))), countStyle: .file)),
            "file_count": .number(String(fileCount)),
            "format": .string(format)
        ]
        if fileValues.count < fileCount {
            overview["file_listing"] = .string("Showing first 512 files")
        }
        if let command, !command.isEmpty {
            overview["command"] = .string(command)
        }
        if let quantization = inferredQuantization(path: directory.path, sections: sections) {
            overview["quantization"] = .string(quantization)
        }
        sections["overview"] = .object(overview)
        if !fileValues.isEmpty {
            sections["files"] = .object(fileValues)
        }

        for file in configFiles {
            let url = directory.appendingPathComponent(file)
            guard let data = try? Data(contentsOf: url), data.count <= 16 * 1024 * 1024,
                  let object = try? JSONSerialization.jsonObject(with: data),
                  let value = LocalMetadataValue(jsonObject: object) else { continue }
            sections["config / \(file)"] = value
        }

        if let quantization = inferredQuantization(path: directory.path, sections: sections) {
            var inferred = (sections["overview"]?.objectValue ?? [:])
            inferred["quantization"] = .string(quantization)
            sections["overview"] = .object(inferred)
        }

        return LocalModelMetadata(backend: "mlx", model: model, sections: sections, error: nil)
    }

    private static func modelFormat(files: Dictionary<String, LocalMetadataValue>.Keys) -> String {
        let extensions = files.map { URL(fileURLWithPath: $0).pathExtension.lowercased() }
        if extensions.contains("safetensors") { return "safetensors" }
        if extensions.contains("gguf") { return "gguf" }
        if extensions.contains("npz") { return "npz" }
        if extensions.contains("mlx") { return "mlx" }
        return "unknown"
    }

    private static func inferredQuantization(path: String, sections: [String: LocalMetadataValue]) -> String? {
        let quantizationKeys: Set<String> = [
            "quantization",
            "quantization_level",
            "quant_method",
            "bits",
            "bit_width",
            "weight_bits"
        ]
        if let result = sections.values.lazy.compactMap({ $0.firstScalar(matching: quantizationKeys) }).first {
            return "\(result.key)=\(result.value)"
        }

        let lowercased = path.lowercased()
        for hint in ["4bit", "8bit", "int4", "int8", "q4", "q5", "q6", "q8", "fp16", "bf16", "f16", "f32"] {
            if lowercased.contains(hint) { return hint }
        }
        return nil
    }
}

private extension LocalMetadataValue {
    var objectValue: [String: LocalMetadataValue]? {
        if case .object(let value) = self { return value }
        return nil
    }
}
