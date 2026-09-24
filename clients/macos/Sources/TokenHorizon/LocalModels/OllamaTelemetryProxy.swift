import Foundation
import Network
import os

private let proxyLog = Logger(subsystem: "com.tokenhorizon.app", category: "ollama-proxy")

struct OllamaTelemetrySample: Equatable {
    var model: String
    var completedAt: Date
    var evalCount: Int
    var evalDurationNs: UInt64
    var promptEvalCount: Int?
    var promptEvalDurationNs: UInt64?

    var tokPerSec: Double? {
        guard evalCount > 0, evalDurationNs > 0 else { return nil }
        return Double(evalCount) / (Double(evalDurationNs) / 1_000_000_000)
    }

    var promptTokPerSec: Double? {
        guard let count = promptEvalCount,
              let duration = promptEvalDurationNs,
              count > 0, duration > 0 else { return nil }
        return Double(count) / (Double(duration) / 1_000_000_000)
    }
}

struct LocalModelUsageRecord: Codable {
    var model: String
    var promptTokens: Int = 0
    var evalTokens: Int = 0
    var totalTokens: Int = 0
    var messages: Int = 0
    var lastUsed: Date = Date()
    var hourlyBuckets: [Int: Int] = [:]
}

struct LocalLLMTelemetryState: Codable {
    var version: Int = 1
    var models: [String: LocalModelUsageRecord] = [:]
}

struct LocalLLMSummary {
    var todayTokens: Int
    var allTokens: Int
    var messagesToday: Int
    var messagesAll: Int
    var models: [String: (today: Int, all: Int, prompt: Int, eval: Int, messages: Int)]
    var hourlyBuckets: [Int: Int]
}

final class OllamaTelemetryStore {
    static let shared = OllamaTelemetryStore()

    private static let maxModels = 256
    private static let recentSampleLimit = 8
    private static let minimumRateTokens = 8
    private let lock = NSLock()
    private var latestSamples: [String: OllamaTelemetrySample] = [:]
    private var recentSamples: [String: [OllamaTelemetrySample]] = [:]
    private var isLoaded = false
    private var isSavePending = false
    private var usageRecords: [String: LocalModelUsageRecord] = [:]

    private static var storageURL: URL {
        let dir = NSString(string: "~/.config/token-horizon").expandingTildeInPath
        return URL(fileURLWithPath: dir).appendingPathComponent("localllm-usage.json")
    }

    private func ensureLoadedLocked() {
        if isLoaded { return }
        isLoaded = true
        guard let data = try? Data(contentsOf: Self.storageURL),
              let state = try? JSONDecoder().decode(LocalLLMTelemetryState.self, from: data) else {
            return
        }
        usageRecords = state.models
    }

    private func scheduleSaveLocked() {
        if isSavePending { return }
        isSavePending = true
        let snapshot = LocalLLMTelemetryState(version: 1, models: usageRecords)
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.isSavePending = false
            self.lock.unlock()
            guard let encoded = try? JSONEncoder().encode(snapshot) else { return }
            let url = Self.storageURL
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? encoded.write(to: url, options: .atomic)
        }
    }

    func record(_ sample: OllamaTelemetrySample) {
        let key = sample.model.lowercased()
        let promptTokens = sample.promptEvalCount ?? 0
        let evalTokens = sample.evalCount
        let totalTokens = promptTokens + evalTokens
        let hourBucket = Int(sample.completedAt.timeIntervalSince1970 / 3600) * 3600

        lock.lock()
        ensureLoadedLocked()
        latestSamples[key] = sample
        var recent = recentSamples[key, default: []]
        recent.append(sample)
        if recent.count > Self.recentSampleLimit {
            recent.removeFirst(recent.count - Self.recentSampleLimit)
        }
        recentSamples[key] = recent
        if latestSamples.count > Self.maxModels {
            let oldestKeys = latestSamples
                .sorted { $0.value.completedAt < $1.value.completedAt }
                .prefix(latestSamples.count - Self.maxModels)
                .map(\.key)
            for k in oldestKeys {
                latestSamples.removeValue(forKey: k)
                recentSamples.removeValue(forKey: k)
            }
        }

        if totalTokens > 0 {
            var rec = usageRecords[key] ?? LocalModelUsageRecord(model: sample.model)
            rec.promptTokens += promptTokens
            rec.evalTokens += evalTokens
            rec.totalTokens += totalTokens
            rec.messages += 1
            rec.lastUsed = sample.completedAt
            rec.hourlyBuckets[hourBucket, default: 0] += totalTokens
            let cutoff = hourBucket - (90 * 86_400)
            rec.hourlyBuckets = rec.hourlyBuckets.filter { $0.key >= cutoff }
            usageRecords[key] = rec
            scheduleSaveLocked()
        }
        lock.unlock()
    }

    func latest(for model: String) -> OllamaTelemetrySample? {
        lock.lock()
        defer { lock.unlock() }
        return latestSamples[model.lowercased()]
    }

    /// A weighted recent rate avoids letting a one-token completion replace a useful throughput reading.
    func recentTokPerSec(for model: String) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        let samples = recentSamples[model.lowercased()] ?? []
        let measured = samples.filter { $0.evalCount > 0 && $0.evalDurationNs > 0 }
        let tokenCount = measured.reduce(0) { $0 + $1.evalCount }
        let durationNs = measured.reduce(0.0) { $0 + Double($1.evalDurationNs) }
        guard tokenCount >= Self.minimumRateTokens, durationNs > 0 else { return nil }
        return Double(tokenCount) * 1_000_000_000 / durationNs
    }

    func usage(for model: String) -> (tokensToday: Int, tokensAll: Int, messages: Int) {
        let key = model.lowercased()
        lock.lock()
        ensureLoadedLocked()
        let rec = usageRecords[key]
        lock.unlock()

        guard let rec else { return (0, 0, 0) }
        let todayStart = Int(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970)
        var todayTokens = 0
        for (h, count) in rec.hourlyBuckets where h >= todayStart {
            todayTokens += count
        }
        return (todayTokens, rec.totalTokens, rec.messages)
    }

    func summary() -> LocalLLMSummary {
        lock.lock()
        ensureLoadedLocked()
        let records = usageRecords
        lock.unlock()

        let todayStart = Int(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970)
        var totalToday = 0
        var totalAll = 0
        var msgToday = 0
        var msgAll = 0
        var modelMap: [String: (today: Int, all: Int, prompt: Int, eval: Int, messages: Int)] = [:]
        var hourlyMerged: [Int: Int] = [:]

        for (key, rec) in records {
            var modelToday = 0
            for (h, count) in rec.hourlyBuckets {
                hourlyMerged[h, default: 0] += count
                if h >= todayStart {
                    modelToday += count
                }
            }
            if modelToday > 0 {
                msgToday += rec.messages
            }
            totalToday += modelToday
            totalAll += rec.totalTokens
            msgAll += rec.messages
            let name = rec.model.isEmpty ? key : rec.model
            modelMap[name] = (today: modelToday, all: rec.totalTokens, prompt: rec.promptTokens, eval: rec.evalTokens, messages: rec.messages)
        }

        return LocalLLMSummary(
            todayTokens: totalToday,
            allTokens: totalAll,
            messagesToday: msgToday,
            messagesAll: msgAll,
            models: modelMap,
            hourlyBuckets: hourlyMerged
        )
    }

    func resetForTesting() {
        lock.lock()
        latestSamples.removeAll()
        recentSamples.removeAll()
        usageRecords.removeAll()
        isLoaded = true
        lock.unlock()
    }
}

final class OllamaTelemetryProxy {
    static let shared = OllamaTelemetryProxy()

    private let queue = DispatchQueue(label: "tokenhorizon.ollama-proxy", qos: .utility)
    private let stateLock = NSLock()
    private let upstreamHost: NWEndpoint.Host
    private let upstreamPort: NWEndpoint.Port
    private var listener: NWListener?
    private var activePort: UInt16?
    private var shouldRun = false

    var port: UInt16? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return activePort
    }

    var proxyURL: URL? {
        guard let port else { return nil }
        return URL(string: "http://127.0.0.1:\(port)")
    }

    private init() {
        let upstream = ProcessInfo.processInfo.environment["TOKEN_HORIZON_OLLAMA_UPSTREAM"] ?? "127.0.0.1:11434"
        let pieces = upstream.split(separator: ":", maxSplits: 1).map(String.init)
        upstreamHost = NWEndpoint.Host(pieces.first ?? "127.0.0.1")
        upstreamPort = NWEndpoint.Port(rawValue: UInt16(pieces.count > 1 ? pieces[1] : "11434") ?? 11434) ?? 11434
    }

    func start() {
        stateLock.lock()
        let alreadyStarted = shouldRun
        shouldRun = true
        stateLock.unlock()
        guard !alreadyStarted else { return }
        let requested = UInt16(ProcessInfo.processInfo.environment["TOKEN_HORIZON_OLLAMA_PROXY_PORT"] ?? "11435") ?? 11435
        startListener(at: requested, remaining: 20)
    }

    private func startListener(at requested: UInt16, remaining: Int) {
        guard requested < UInt16.max, remaining > 0 else { return }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        guard let endpoint = NWEndpoint.Port(rawValue: requested) else {
            return
        }
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: endpoint)
        guard let newListener = try? NWListener(using: params) else {
            if requested < UInt16.max { startListener(at: requested + 1, remaining: remaining - 1) }
            return
        }

        stateLock.lock()
        guard shouldRun else {
            stateLock.unlock()
            newListener.cancel()
            return
        }
        listener = newListener
        stateLock.unlock()
        newListener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        newListener.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                proxyLog.info("Ollama telemetry proxy listening on 127.0.0.1:\(requested)")
                self?.stateLock.lock()
                self?.activePort = requested
                self?.stateLock.unlock()
            } else if case .failed = state {
                proxyLog.error("Ollama telemetry proxy could not bind port \(requested)")
                self?.stateLock.lock()
                self?.listener = nil
                self?.activePort = nil
                let shouldRetry = self?.shouldRun == true
                self?.stateLock.unlock()
                if shouldRetry, remaining > 1 {
                    self?.startListener(at: requested + 1, remaining: remaining - 1)
                }
            }
        }
        newListener.start(queue: queue)
    }

    func stop() {
        stateLock.lock()
        let current = listener
        listener = nil
        activePort = nil
        shouldRun = false
        stateLock.unlock()
        current?.cancel()
    }

    static func parseTelemetry(model: String? = nil, responseBody: Data, completedAt: Date = Date(), elapsedDurationNs: UInt64? = nil) -> OllamaTelemetrySample? {
        let objects = JSONObjects(in: responseBody)
        for object in objects.reversed() {
            let resolvedModel = model ?? (object["model"] as? String)
            guard let activeModel = resolvedModel, !activeModel.isEmpty else { continue }

            // 1. Ollama native format: done == true, eval_count, eval_duration
            if let done = object["done"] as? Bool, done,
               let evalCount = number(object["eval_count"])?.intValue,
               let evalDuration = number(object["eval_duration"])?.uint64Value,
               evalCount >= 0, evalDuration > 0 {
                return OllamaTelemetrySample(
                    model: activeModel,
                    completedAt: completedAt,
                    evalCount: evalCount,
                    evalDurationNs: evalDuration,
                    promptEvalCount: number(object["prompt_eval_count"])?.intValue,
                    promptEvalDurationNs: number(object["prompt_eval_duration"])?.uint64Value
                )
            }

            // 2. OpenAI-compatible format: usage: { completion_tokens, prompt_tokens, total_tokens }
            if let usage = object["usage"] as? [String: Any],
               let completionTokens = number(usage["completion_tokens"])?.intValue,
               completionTokens >= 0 {
                let promptTokens = number(usage["prompt_tokens"])?.intValue
                let durationNs = elapsedDurationNs ?? 1_000_000_000
                return OllamaTelemetrySample(
                    model: activeModel,
                    completedAt: completedAt,
                    evalCount: completionTokens,
                    evalDurationNs: max(durationNs, 1),
                    promptEvalCount: promptTokens,
                    promptEvalDurationNs: nil
                )
            }
        }
        return nil
    }

    /// Pure JSON-number coercion. Internal for hermetic unit tests.
    static func number(_ value: Any?) -> NSNumber? {
        if let number = value as? NSNumber { return number }
        if let string = value as? String { return NSNumber(value: Double(string) ?? 0) }
        return nil
    }

    static func JSONObjects(in data: Data) -> [[String: Any]] {
        let payload = decodeChunkedBody(data)
        var objects: [[String: Any]] = []

        if let root = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] {
            objects.append(root)
            return objects
        }

        let text = String(decoding: payload, as: UTF8.self)
        for line in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) {
            var trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("data:") {
                trimmed = trimmed.dropFirst(5).trimmingCharacters(in: .whitespaces)
            }
            guard !trimmed.isEmpty, trimmed != "[DONE]",
                  let lineData = trimmed.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
                continue
            }
            objects.append(object)
        }
        return objects
    }

    /// Strips HTTP headers / chunked framing. Internal for hermetic tests.
    static func decodeChunkedBody(_ data: Data) -> Data {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return data }
        let header = String(decoding: data[..<headerEnd.lowerBound], as: UTF8.self).lowercased()
        guard header.contains("transfer-encoding: chunked") else { return data[headerEnd.upperBound...] }

        return decodeChunkedPayload(Data(data[headerEnd.upperBound...]))
    }

    static func decodeChunkedPayload(_ data: Data) -> Data {
        var output = Data()
        output.reserveCapacity(data.count)
        var index = 0
        while index < data.count {
            guard let lineEnd = data[index...].range(of: Data("\r\n".utf8)) else { break }
            let sizeText = String(decoding: data[index..<lineEnd.lowerBound], as: UTF8.self)
            guard let size = Int(sizeText.split(separator: ";", maxSplits: 1).first ?? "", radix: 16), size >= 0 else { break }
            index = lineEnd.upperBound
            guard index + size <= data.count else { break }
            output.append(data[index..<(index + size)])
            index += size
            guard index + 2 <= data.count else { break }
            index += 2
            if size == 0 { break }
        }
        return output
    }

    private func accept(_ client: NWConnection) {
        client.stateUpdateHandler = { state in
            if case .failed = state { client.cancel() }
            if case .cancelled = state { client.cancel() }
        }
        client.start(queue: queue)
        receiveRequest(client, buffer: Data())
    }

    private func receiveRequest(_ client: NWConnection, buffer: Data) {
        client.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if !done, error == nil, buffer.count < 1_048_576 {
                    self.receiveRequest(client, buffer: buffer)
                } else {
                    client.cancel()
                }
                return
            }

            let header = Data(buffer[..<headerEnd.lowerBound])
            let body = Data(buffer[headerEnd.upperBound...])
            if Self.isChunked(header) {
                guard let messageLength = Self.chunkedMessageLength(body) else {
                    if !done, error == nil, buffer.count < 16_777_216 {
                        self.receiveRequest(client, buffer: buffer)
                    } else {
                        client.cancel()
                    }
                    return
                }
                let wireBody = Data(body.prefix(messageLength))
                self.forward(header: header, body: wireBody, parsedBody: Self.decodeChunkedPayload(wireBody), client: client)
            } else {
                let contentLength = Self.contentLength(header)
                guard body.count >= contentLength else {
                    self.receiveRequest(client, buffer: buffer)
                    return
                }
                let requestBody = Data(body.prefix(contentLength))
                self.forward(header: header, body: requestBody, parsedBody: requestBody, client: client)
            }
        }
    }

    private func forward(header: Data, body: Data, parsedBody: Data, client: NWConnection) {
        let upstream = NWConnection(host: upstreamHost, port: upstreamPort, using: .tcp)
        let request = Self.upstreamHeader(header) + Data("\r\n\r\n".utf8) + body
        let requestInfo = Self.requestInfo(header: header, body: parsedBody)
        if requestInfo.path == "/api/generate" || requestInfo.path == "/api/chat" {
            TokenHorizonTelemetry.shared.recordOllamaRequest(model: requestInfo.model)
        }
        let accumulator = ResponseAccumulator(model: requestInfo.model)

        upstream.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            if case .ready = state {
                upstream.send(content: request, completion: .contentProcessed { error in
                    if error != nil {
                        client.cancel()
                        upstream.cancel()
                    } else {
                        self.receiveResponse(upstream, client: client, accumulator: accumulator)
                    }
                })
            } else if case .failed = state {
                client.cancel()
            }
        }
        upstream.start(queue: queue)
    }

    private func receiveResponse(_ upstream: NWConnection, client: NWConnection, accumulator: ResponseAccumulator) {
        upstream.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                accumulator.append(data)
                client.send(content: data, completion: .contentProcessed { [weak self] sendError in
                    guard let self else { return }
                    if sendError != nil || error != nil || done {
                        accumulator.finish()
                        client.cancel()
                        upstream.cancel()
                    } else {
                        self.receiveResponse(upstream, client: client, accumulator: accumulator)
                    }
                })
            } else {
                if !done, error == nil {
                    self.receiveResponse(upstream, client: client, accumulator: accumulator)
                } else {
                    accumulator.finish()
                    client.cancel()
                    upstream.cancel()
                }
            }
        }
    }

    private static func contentLength(_ header: Data) -> Int {
        let text = String(decoding: header, as: UTF8.self)
        return text.split(separator: "\r\n").first(where: { $0.lowercased().hasPrefix("content-length:") })
            .flatMap { Int($0.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces) ?? "") } ?? 0
    }

    private static func isChunked(_ header: Data) -> Bool {
        String(decoding: header, as: UTF8.self)
            .split(separator: "\r\n")
            .contains { line in
                let lower = line.lowercased()
                return lower.hasPrefix("transfer-encoding:") && lower.contains("chunked")
            }
    }

    private static func chunkedMessageLength(_ data: Data) -> Int? {
        var index = 0
        while index < data.count {
            guard let lineEnd = data[index...].range(of: Data("\r\n".utf8)) else { return nil }
            let sizeText = String(decoding: data[index..<lineEnd.lowerBound], as: UTF8.self)
            guard let size = Int(sizeText.split(separator: ";", maxSplits: 1).first ?? "", radix: 16), size >= 0 else { return nil }
            index = lineEnd.upperBound
            guard index + size + 2 <= data.count else { return nil }
            index += size
            guard data[index..<(index + 2)] == Data("\r\n".utf8) else { return nil }
            index += 2
            if size == 0 { return index }
        }
        return nil
    }

    private static func upstreamHeader(_ header: Data) -> Data {
        let lines = String(decoding: header, as: UTF8.self).split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let requestLine = lines.first else { return header }
        var forwarded = [String(requestLine)]
        for line in lines.dropFirst() {
            let lower = line.lowercased()
            if lower.hasPrefix("connection:") || lower.hasPrefix("proxy-connection:") { continue }
            forwarded.append(String(line))
        }
        forwarded.append("Connection: close")
        return Data(forwarded.joined(separator: "\r\n").utf8)
    }

    private static func requestInfo(header: Data, body: Data) -> (model: String?, path: String) {
        let lines = String(decoding: header, as: UTF8.self).split(separator: "\r\n")
        let requestParts = lines.first?.split(separator: " ") ?? []
        let path = requestParts.count > 1 ? String(requestParts[1]) : "/"
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        return (object?["model"] as? String, path)
    }

    private final class ResponseAccumulator {
        let model: String?
        private var data = Data()
        private var notified = false
        private let startTime = DispatchTime.now()

        init(model: String?) { self.model = model }

        func append(_ bytes: Data) {
            guard !notified, data.count < 2_097_152 else { return }
            data.append(bytes.prefix(2_097_152 - data.count))
        }

        func finish() {
            guard !notified else { return }
            notified = true
            let elapsedNs = DispatchTime.now().uptimeNanoseconds - startTime.uptimeNanoseconds
            guard let sample = OllamaTelemetryProxy.parseTelemetry(model: model, responseBody: data, completedAt: Date(), elapsedDurationNs: elapsedNs) else { return }
            OllamaTelemetryStore.shared.record(sample)
            TokenHorizonTelemetry.shared.recordOllama(sample)
            NotificationCenter.default.post(name: .ollamaTelemetryUpdated, object: sample)
        }
    }
}
