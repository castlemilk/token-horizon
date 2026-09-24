import Foundation

/// One completed-request summary reported by a local runner's own
/// `/metrics` endpoint (mlx-vlm format). Values are measured by the runner;
/// nothing here is inferred from process resource usage.
struct MLXServerMetrics: Equatable {
    var prefillTokPerSec: Double?
    var decodeTokPerSec: Double?
    var ttftSeconds: Double?
    var promptTokens: Int?
    var completionTokens: Int?
    var measuredAt: Date

    /// Parse the mlx-vlm `/metrics` body. The `latest` request summary is the
    /// only object used; `null`/missing `latest` means no request has
    /// completed yet. Internal for hermetic unit tests.
    static func parse(_ data: Data, measuredAt: Date = Date()) -> MLXServerMetrics? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let latest = object["latest"] as? [String: Any] else { return nil }

        func double(_ key: String) -> Double? {
            guard let number = latest[key] as? NSNumber else { return nil }
            return number.doubleValue
        }
        func int(_ key: String) -> Int? {
            guard let number = latest[key] as? NSNumber else { return nil }
            return number.intValue
        }

        let timestamp = double("timestamp_unix").map { Date(timeIntervalSince1970: $0) }
        return MLXServerMetrics(
            prefillTokPerSec: double("prefill_tok_s"),
            decodeTokPerSec: double("decode_tok_s"),
            ttftSeconds: double("ttft_s"),
            promptTokens: int("prompt_tokens"),
            completionTokens: int("completion_tokens"),
            measuredAt: timestamp ?? measuredAt
        )
    }
}

/// Resolves the metrics endpoint for a locally launched MLX HTTP server.
enum MLXServerEndpoint {
    /// Builds the `/metrics` URL from a runner command's `--host`/`--port`
    /// arguments, defaulting to the mlx-lm/mlx-vlm default of 8080.
    /// Internal for hermetic unit tests.
    static func metricsURL(in command: String) -> URL? {
        let arguments = MLXObserver.commandArguments(command)
        guard arguments.contains(where: { argument in
            let value = argument.lowercased()
            return value.contains("mlx_vlm") || value.contains("mlx-vlm")
                || value.contains("mlx_lm") || value.contains("mlx-lm")
        }) else { return nil }

        var host = "127.0.0.1"
        var port = 8080
        for (index, argument) in arguments.enumerated() {
            if argument == "--host", arguments.indices.contains(index + 1) {
                host = arguments[index + 1]
            } else if argument.hasPrefix("--host=") {
                host = String(argument.dropFirst("--host=".count))
            } else if argument == "--port", arguments.indices.contains(index + 1),
                      let value = Int(arguments[index + 1]) {
                port = value
            } else if argument.hasPrefix("--port="), let value = Int(argument.dropFirst("--port=".count)) {
                port = value
            }
        }
        if host.isEmpty || host == "0.0.0.0" { host = "127.0.0.1" }
        return URL(string: "http://\(host):\(port)/metrics")
    }
}

/// Short-lived cache of runner `/metrics` readings so the 2-second MLX
/// sampling tick never pays more than one loopback request per runner.
final class MLXServerMetricsStore {
    static let shared = MLXServerMetricsStore()

    private struct Entry {
        var metrics: MLXServerMetrics
        var fetchedAt: Date
    }

    private static let ttl: TimeInterval = 2.0
    private static let staleLimit: TimeInterval = 30.0
    private let lock = NSLock()
    private var cache: [String: Entry] = [:]

    /// Returns the latest reading for a runner. Serves a fresh cache hit,
    /// otherwise performs one short loopback GET. On failure, a recent
    /// cached reading (up to 30s old) is returned so a transient blip does
    /// not blank the tracker.
    func metrics(for url: URL, now: Date = Date()) -> MLXServerMetrics? {
        let key = url.absoluteString
        lock.lock()
        let cached = cache[key]
        lock.unlock()
        if let cached, now.timeIntervalSince(cached.fetchedAt) < Self.ttl {
            return cached.metrics
        }

        if let data = Self.httpGet(url), let metrics = MLXServerMetrics.parse(data, measuredAt: now) {
            lock.lock()
            cache[key] = Entry(metrics: metrics, fetchedAt: now)
            lock.unlock()
            return metrics
        }

        lock.lock()
        defer { lock.unlock() }
        guard let cached, now.timeIntervalSince(cached.fetchedAt) < Self.staleLimit else { return nil }
        return cached.metrics
    }

    /// Test seam: inject a measurement without a live runner.
    func record(_ metrics: MLXServerMetrics, for url: URL, at date: Date = Date()) {
        lock.lock()
        cache[url.absoluteString] = Entry(metrics: metrics, fetchedAt: date)
        lock.unlock()
    }

    /// Test seam: drop all cached measurements.
    func reset() {
        lock.lock()
        cache.removeAll()
        lock.unlock()
    }

    private static func httpGet(_ url: URL) -> Data? {
        var request = URLRequest(url: url, timeoutInterval: 1)
        request.httpMethod = "GET"
        var data: Data?
        let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { responseData, response, _ in
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                data = responseData
            }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 1) == .timedOut { return nil }
        return data
    }
}
