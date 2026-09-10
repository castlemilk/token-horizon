import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct OllamaModel: Codable {
    public var name: String
    public var size: UInt64
    public var modifiedAt: String
    public var capabilities: [String]
    public var details: [String: String]
    public var tokPerSec: Double?
    public var promptTokPerSec: Double?
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
        NSString(string: "~/.config/token-horizon/ollama-benchmarks.json").expandingTildeInPath
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
        guard let url = endpoint("/api/tags") else { return [] }
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: URLRequest(url: url, timeoutInterval: 4)) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 4) == .timedOut { return [] }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = obj["models"] as? [[String: Any]] else { return [] }
        return models.compactMap { m in
            guard let name = m["name"] as? String else { return nil }
            let size = (m["size"] as? NSNumber)?.uint64Value ?? 0
            let modified = m["modified_at"] as? String ?? ""
            let caps = m["capabilities"] as? [String] ?? []
            var details: [String: String] = [:]
            if let d = m["details"] as? [String: Any] {
                for (k, v) in d { details[k] = "\(v)" }
            }
            let bm = cachedBenchmark(for: name)
            return OllamaModel(name: name, size: size, modifiedAt: modified, capabilities: caps, details: details,
                               tokPerSec: bm?.tokPerSec, promptTokPerSec: bm?.promptTokPerSec)
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
                DispatchQueue.main.async { completion?(nil) }
                return
            }
            var req = URLRequest(url: url, timeoutInterval: 25)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let payload: [String: Any] = [
                "model": model,
                "prompt": "Write a short 25-word summary of modern computing architecture.",
                "stream": false,
                "options": [
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
                DispatchQueue.main.async { completion?(nil) }
                return
            }

            guard let respData,
                  let obj = try? JSONSerialization.jsonObject(with: respData) as? [String: Any],
                  let evalCount = (obj["eval_count"] as? NSNumber)?.intValue,
                  let evalDuration = (obj["eval_duration"] as? NSNumber)?.uint64Value,
                  evalDuration > 0 else {
                DispatchQueue.main.async { completion?(nil) }
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

            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .refreshModelExtras, object: nil)
                completion?(result)
            }
        }
    }

    public static func modelCard(for name: String) -> [String: Any]? {
        guard let url = endpoint("/api/show") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 4)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name])
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + 4) == .timedOut { return nil }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }
}
