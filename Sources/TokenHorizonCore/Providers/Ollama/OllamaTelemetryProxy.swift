#if os(macOS)
import Foundation
import Network

// OllamaTelemetrySample and OllamaTelemetryStore live in TokenHorizonCore.

public final class OllamaTelemetryProxy {
    public static let shared = OllamaTelemetryProxy()

    private let queue = DispatchQueue(label: "tokenhorizon.ollama-proxy", qos: .utility)
    private let stateLock = NSLock()
    private let upstreamHost: NWEndpoint.Host
    private let upstreamPort: NWEndpoint.Port
    private var listener: NWListener?
    private var activePort: UInt16?
    private var shouldRun = false

    public var port: UInt16? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return activePort
    }

    public var proxyURL: URL? {
        guard let port else { return nil }
        return URL(string: "http://127.0.0.1:\(port)")
    }

    private init() {
        let upstream = ProcessInfo.processInfo.environment["TOKEN_HORIZON_OLLAMA_UPSTREAM"] ?? "127.0.0.1:11434"
        let pieces = upstream.split(separator: ":", maxSplits: 1).map(String.init)
        upstreamHost = NWEndpoint.Host(pieces.first ?? "127.0.0.1")
        upstreamPort = NWEndpoint.Port(rawValue: UInt16(pieces.count > 1 ? pieces[1] : "11434") ?? 11434) ?? 11434
    }

    public func start() {
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
                NSLog("Ollama telemetry proxy listening on 127.0.0.1:\(requested)")
                self?.stateLock.lock()
                self?.activePort = requested
                self?.stateLock.unlock()
            } else if case .failed = state {
                NSLog("Ollama telemetry proxy could not bind port \(requested)")
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

    public func stop() {
        stateLock.lock()
        let current = listener
        listener = nil
        activePort = nil
        shouldRun = false
        stateLock.unlock()
        current?.cancel()
    }

    public static func parseTelemetry(model: String, responseBody: Data, completedAt: Date = Date()) -> OllamaTelemetrySample? {
        for object in JSONObjects(in: responseBody) {
            guard let done = object["done"] as? Bool, done,
                  let evalCount = number(object["eval_count"])?.intValue,
                  let evalDuration = number(object["eval_duration"])?.uint64Value,
                  evalCount >= 0, evalDuration > 0 else { continue }
            return OllamaTelemetrySample(
                model: model,
                completedAt: completedAt,
                evalCount: evalCount,
                evalDurationNs: evalDuration,
                promptEvalCount: number(object["prompt_eval_count"])?.intValue,
                promptEvalDurationNs: number(object["prompt_eval_duration"])?.uint64Value
            )
        }
        return nil
    }

    private static func number(_ value: Any?) -> NSNumber? {
        if let number = value as? NSNumber { return number }
        if let string = value as? String { return NSNumber(value: Double(string) ?? 0) }
        return nil
    }

    private static func JSONObjects(in data: Data) -> [[String: Any]] {
        let text = String(decoding: decodeChunkedBody(data), as: UTF8.self)
        var objects: [[String: Any]] = []
        for line in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) {
            guard let lineData = String(line).data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { continue }
            objects.append(object)
        }
        if let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
            objects.append(object)
        }
        return objects
    }

    private static func decodeChunkedBody(_ data: Data) -> Data {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return data }
        let header = String(decoding: data[..<headerEnd.lowerBound], as: UTF8.self).lowercased()
        guard header.contains("transfer-encoding: chunked") else { return data[headerEnd.upperBound...] }

        return decodeChunkedPayload(Data(data[headerEnd.upperBound...]))
    }

    private static func decodeChunkedPayload(_ data: Data) -> Data {
        var output = Data()
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

        init(model: String?) { self.model = model }

        func append(_ bytes: Data) {
            guard !notified, data.count < 2_097_152 else { return }
            data.append(bytes.prefix(2_097_152 - data.count))
        }

        func finish() {
            guard !notified else { return }
            notified = true
            guard let model,
                  let sample = OllamaTelemetryProxy.parseTelemetry(model: model, responseBody: data) else { return }
            OllamaTelemetryStore.shared.record(sample)
            TokenHorizonTelemetry.shared.recordOllama(sample)
            NotificationCenter.default.post(name: .ollamaTelemetryUpdated, object: sample)
        }
    }
}

#endif // os(macOS)
