import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

<<<<<<<< HEAD:Sources/TokenHorizon/LocalModels/OllamaClient.swift
struct OllamaModel: Codable {
    var name: String
    var size: UInt64
    var modifiedAt: String
    var capabilities: [String]
    var details: [String: String]
    var tokPerSec: Double?
    var promptTokPerSec: Double?
    var modelID: String? = nil
    var digest: String? = nil
    var sizeVRAM: UInt64? = nil
    var rawMetadata: LocalMetadataValue? = nil
========
public struct OllamaModel: Codable {
    public var name: String
    public var size: UInt64
    public var modifiedAt: String
    public var capabilities: [String]
    public var details: [String: String]
    public var tokPerSec: Double?
    public var promptTokPerSec: Double?
>>>>>>>> c0b8275 (Split portable server side into TokenHorizonCore + OS seam interfaces):Sources/TokenHorizonCore/OllamaClient.swift
}

public struct OllamaSpeedBenchmark: Codable {
    public var tokPerSec: Double
    public var promptTokPerSec: Double?
    public var evalCount: Int
    public var evalDurationNs: UInt64
    public var timestamp: Date
}

public final class OllamaClient {
    /// Platform seam: route through a request meter to measure the client's own
    /// traffic (e.g. point at an OllamaMeter listen port). Default talks to Ollama directly.
    public static var baseURLProvider: () -> URL? = { nil }

    private static let lock = NSLock()
    private static var benchmarkCache: [String: OllamaSpeedBenchmark] = [:]
    private static var inProgressBenchmarks: Set<String> = []
    private static var cacheLoaded = false

    private static func endpoint(_ path: String) -> URL? {
        let base = baseURLProvider() ?? URL(string: "http://127.0.0.1:11434")
        return base?.appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path)
    }

    private static var cacheFilePath: String {
        Platform.paths.configDirectory.appendingPathComponent("ollama-benchmarks.json").path
    }

    private static func ensureCacheLoaded() {
        lock.lock()
        defer { lock.unlock() }
        if cacheLoaded { return }
        cacheLoaded = true
        guard let data = FileManager.default.contents(atPath: cacheFilePath),
              let decoded = try? JSONDecoder().decode([String: OllamaSpeedBenchmark].self, from: data) else {
            return
        }
        benchmarkCache = decoded
    }

    private static func saveCache() {
        lock.lock()
        let copy = benchmarkCache
        lock.unlock()
        let url = URL(fileURLWithPath: cacheFilePath)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(copy) {
            try? data.write(to: url)
        }
    }

    public static func cachedBenchmark(for model: String) -> OllamaSpeedBenchmark? {
        ensureCacheLoaded()
        lock.lock()
        defer { lock.unlock() }
        return benchmarkCache[model] ?? benchmarkCache[model.lowercased()]
    }

    public static func isBenchmarking(model: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return inProgressBenchmarks.contains(model) || inProgressBenchmarks.contains(model.lowercased())
    }

    public static func fetchInstalled() -> [OllamaModel] {
        ensureCacheLoaded()
        guard let data = requestData(path: "/api/tags"),
              let json = try? JSONSerialization.jsonObject(with: data),
              let obj = json as? [String: Any],
              let models = obj["models"] as? [[String: Any]] else { return [] }
        return models.compactMap { m in
            guard let name = m["name"] as? String else { return nil }
            let size = (m["size"] as? NSNumber)?.uint64Value ?? 0
            let modified = m["modified_at"] as? String ?? ""
            let caps = m["capabilities"] as? [String] ?? []
            var details: [String: String] = [:]
            if let d = m["details"] as? [String: Any] {
                for (k, v) in d {
                    details[k] = LocalMetadataValue(jsonObject: v)?.displayText ?? "\(v)"
                }
            }
            let bm = cachedBenchmark(for: name)
            let measuredTokPerSec = OllamaTelemetryStore.shared.recentTokPerSec(for: name)
            return OllamaModel(name: name, size: size, modifiedAt: modified, capabilities: caps, details: details,
                               tokPerSec: measuredTokPerSec ?? bm?.tokPerSec, promptTokPerSec: bm?.promptTokPerSec,
                               modelID: m["model"] as? String,
                               digest: m["digest"] as? String,
                               sizeVRAM: (m["size_vram"] as? NSNumber)?.uint64Value,
                               rawMetadata: LocalMetadataValue(jsonObject: m))
        }
    }

    public static func benchmark(model: String, completion: ((OllamaSpeedBenchmark?) -> Void)? = nil) {
        lock.lock()
        if inProgressBenchmarks.contains(model) {
            lock.unlock()
            completion?(nil)
            return
        }
        inProgressBenchmarks.insert(model)
        lock.unlock()

        DispatchQueue.global(qos: .userInitiated).async {
            defer {
                lock.lock()
                inProgressBenchmarks.remove(model)
                lock.unlock()
            }
            guard let url = endpoint("/api/generate") else {
                completion?(nil)
                return
            }
            var req = URLRequest(url: url, timeoutInterval: 25)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let payload: [String: Any] = [
                "model": model,
                "prompt": "Write a short 25-word summary of modern computing architecture.",
                "stream": false,
                "think": false,
                "options": [
                    "num_ctx": 8192,
                    "num_predict": 35,
                    "temperature": 0.1
                ]
            ]
            req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
            var respData: Data?
            let sema = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: req) { d, resp, _ in
                if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                    respData = d
                }
                sema.signal()
            }.resume()

            if sema.wait(timeout: .now() + 25) == .timedOut {
                completion?(nil)
                return
            }

            guard let respData,
                  let obj = try? JSONSerialization.jsonObject(with: respData) as? [String: Any],
                  let evalCount = (obj["eval_count"] as? NSNumber)?.intValue,
                  let evalDuration = (obj["eval_duration"] as? NSNumber)?.uint64Value,
                  evalDuration > 0 else {
                completion?(nil)
                return
            }

            let tokSec = Double(evalCount) / (Double(evalDuration) / 1_000_000_000.0)
            var promptTokSec: Double? = nil
            if let pCount = (obj["prompt_eval_count"] as? NSNumber)?.intValue,
               let pDur = (obj["prompt_eval_duration"] as? NSNumber)?.uint64Value,
               pDur > 0 {
                promptTokSec = Double(pCount) / (Double(pDur) / 1_000_000_000.0)
            }

            let result = OllamaSpeedBenchmark(tokPerSec: tokSec,
                                              promptTokPerSec: promptTokSec,
                                              evalCount: evalCount,
                                              evalDurationNs: evalDuration,
                                              timestamp: Date())
            lock.lock()
            benchmarkCache[model] = result
            lock.unlock()
            saveCache()
            NotificationCenter.default.post(name: .refreshModelExtras, object: nil)
            completion?(result)
        }
    }

<<<<<<<< HEAD:Sources/TokenHorizon/LocalModels/OllamaClient.swift
    static func modelCard(for name: String) -> [String: Any]? {
        guard case .object(let values) = requestJSON(path: "/api/show", method: "POST", body: ["name": name]) else {
            return nil
        }
        return values.mapValues(\.jsonObject)
    }

    /// Load the complete local model description without blocking the UI. The
    /// request is routed through OllamaTelemetryProxy when it is running.
    static func fetchModelMetadata(for name: String, completion: @escaping (LocalModelMetadata) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            let installed = fetchInstalled().first { model in
                model.name.caseInsensitiveCompare(name) == .orderedSame
                    || model.modelID?.caseInsensitiveCompare(name) == .orderedSame
            }
            let requestName = installed?.name ?? name
            let card = requestJSON(path: "/api/show", method: "POST", body: ["name": requestName])
            let running = runningModel(from: requestJSON(path: "/api/ps"), matching: requestName)
            let metadata = makeModelMetadata(name: requestName, installed: installed, card: card, running: running)
            DispatchQueue.main.async {
                completion(metadata)
            }
        }
    }

    static func fetchModelMetadata(for name: String) async -> LocalModelMetadata {
        await withCheckedContinuation { continuation in
            fetchModelMetadata(for: name) { metadata in
                continuation.resume(returning: metadata)
            }
        }
    }

    static func makeModelMetadata(name: String, installed: OllamaModel?, card: LocalMetadataValue?, running: LocalMetadataValue? = nil) -> LocalModelMetadata {
        var sections: [String: LocalMetadataValue] = [:]
        if let raw = installed?.rawMetadata {
            sections["installed /api/tags"] = raw
        }
        if let card {
            sections["configuration /api/show"] = card
        }
        if let running {
            sections["loaded /api/ps"] = running
        }

        let error: String?
        if card == nil && installed == nil {
            error = "Ollama did not return metadata for this model. Check that the Ollama daemon is running."
        } else if card == nil {
            error = "The model is installed, but Ollama did not return its /api/show configuration."
        } else {
            error = nil
        }
        return LocalModelMetadata(backend: "ollama", model: name, sections: sections, error: error)
    }

    /// Matches an /api/ps entry to a model name. Internal for unit tests.
    static func runningModel(from value: LocalMetadataValue?, matching name: String) -> LocalMetadataValue? {
        guard case .object(let object) = value,
              case .array(let models) = object["models"] else { return nil }
        return models.first { model in
            guard case .object(let values) = model else { return false }
            let candidate = values["name"]?.scalarText ?? values["model"]?.scalarText
            return candidate?.caseInsensitiveCompare(name) == .orderedSame
        }
    }

    private static func requestData(path: String, method: String = "GET", body: [String: Any]? = nil) -> Data? {
        guard let url = endpoint(path) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 4)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }

========
    public static func modelCard(for name: String) -> [String: Any]? {
        guard let url = endpoint("/api/show") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 4)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name])
>>>>>>>> c0b8275 (Split portable server side into TokenHorizonCore + OS seam interfaces):Sources/TokenHorizonCore/OllamaClient.swift
        var data: Data?
        let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { responseData, response, _ in
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                data = responseData
            }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 4) == .timedOut { return nil }
        return data
    }

    private static func requestJSON(path: String, method: String = "GET", body: [String: Any]? = nil) -> LocalMetadataValue? {
        guard let data = requestData(path: path, method: method, body: body),
              let object = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return LocalMetadataValue(jsonObject: object)
    }
}
