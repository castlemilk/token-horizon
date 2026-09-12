import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// One fully-observed HTTP exchange, captured by a RequestMeter relay.
public struct MeteredExchange {
    public var method = ""
    public var path = ""
    public var requestBody = Data()
    /// Client headers, lowercase names (User-Agent etc. for product sniffing).
    public var requestHeaders: [String: String] = [:]
    public var status = 0
    /// Response headers, lowercase names (request-id extraction for dedup).
    public var responseHeaders: [String: String] = [:]
    public var responseBody = Data()
    public var startedAt = Date()
    public var firstByteAt: Date?
    public var completedAt = Date()

    public init() {}

    public var durationMs: Int {
        Int(completedAt.timeIntervalSince(startedAt) * 1000)
    }
    public var timeToFirstByteMs: Int? {
        firstByteAt.map { Int($0.timeIntervalSince(startedAt) * 1000) }
    }
}

/// Base class for request-path token measurement ("the listener").
///
/// A meter is a loopback HTTP relay: clients (CLI tools, SDKs, local
/// OpenAI-compatible servers) point their base URL at the meter; the meter
/// forwards every request to the real API and streams the response back
/// byte-for-byte while accumulating a copy. When the exchange completes it
/// derives a UsageEvent — token-type breakdown, measured generation tok/s
/// (output over body-streaming time), prompt-processing rate (input over
/// time-to-first-byte), context occupancy, cost — and stores it via
/// `UsageStoring`.
///
/// Subclasses implement ONLY the wire-format parsing:
///   - `shouldMeter`     which paths count (default: POST)
///   - `model(for:)`     selected model from request/response
///   - `usage(from:)`    TokenBreakdown from response (SSE or JSON)
///   - optionally `sessionID(for:)`, `cost(for:tokens:)`, `rates(from:tokens:)`
///
/// Concurrency: every connection runs independently; events arrive in
/// parallel and are stored idempotently. Thread-safe.
open class RequestMeter: NSObject, URLSessionDataDelegate {
    /// Vendor key stamped on emitted events ("openai", "vllm", ...).
    public let vendor: String
    /// Real upstream API base ("https://api.anthropic.com", "http://127.0.0.1:8000").
    public let targetBase: URL
    public let listenPort: UInt16

    /// Destination for measured events. Nil = parse but don't persist (probe mode).
    public var store: UsageStoring?
    public var sourceKind: SourceKind
    /// Metered traffic is measured, but the user chose to route through us:
    /// self-reported until reconciled against a server-side record.
    /// Meters measure live traffic: `.measured` until the provider's own file
    /// record cross-checks the event (store reconciliation → `.reconciled`).
    public var attestation: Attestation = .measured
    public var machineID: String = MachineIdentity.current
    public var machineAlias: String = MachineIdentity.alias

    private var listenFD: Int32 = -1
    private let stateLock = NSLock()
    /// task identity -> in-flight connection state
    private var inflight: [Int: Connection] = [:]
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)

    public init(vendor: String, listenPort: UInt16, targetBase: URL,
                store: UsageStoring? = nil, sourceKind: SourceKind = .external) {
        self.vendor = vendor
        self.listenPort = listenPort
        self.targetBase = targetBase
        self.store = store
        self.sourceKind = sourceKind
        super.init()
        _ = session
    }

    // MARK: - Subclass contract

    /// Which exchanges to measure. Default: POST requests.
    open func shouldMeter(method: String, path: String) -> Bool { method == "POST" }

    /// All JSON objects carried by SSE `data:` lines (`[DONE]` skipped).
    /// Shared by every SSE meter — subclass usage parsers iterate this.
    public func sseObjects(_ text: String) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for line in text.components(separatedBy: "\n") {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard payload != "[DONE]", let data = payload.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            out.append(obj)
        }
        return out
    }

    /// Selected model for the exchange (request body, path, or response).
    open func model(for exchange: MeteredExchange) -> String { "" }

    /// Token breakdown parsed from the completed response. Nil = not metered.
    open func usage(from exchange: MeteredExchange) -> TokenBreakdown? { nil }

    /// Client session correlation, when the wire format carries it.
    open func sessionID(for exchange: MeteredExchange) -> String? { nil }

    /// Provider request id for cross-channel dedup (see UsageEvent.requestID).
    /// Wire formats override: Anthropic → `request-id` response header,
    /// OpenAI-compatible → body `id`.
    open func requestID(for exchange: MeteredExchange) -> String? { nil }

    /// Configured thinking/reasoning effort from the REQUEST. Every vendor
    /// encodes this differently — subclasses parse the native form and
    /// normalize to "off"/"low"/"medium"/"high"/"adaptive".
    open func thinkingLevel(for exchange: MeteredExchange) -> (level: String, raw: String)? { nil }

    /// Explicit product label (set per meter via TH_METERS `vendor:port@product`).
    public var productLabel: String?

    /// Product-level attribution with provenance: which client TOOL made this
    /// request (claude-code, codex, pi, opencode...) and HOW we know.
    /// Product is orthogonal to vendor — claude code can hit kimi's API.
    /// Default: explicit label (.explicitLabel), else User-Agent sniffing
    /// (.headerSniffed). A later file annotation with the same provider
    /// request id overrides sniffed labels (.fileJoined) but never an
    /// explicit one.
    open func productAttribution(for exchange: MeteredExchange) -> (product: String, source: ProductSource)? {
        if let productLabel { return (productLabel, .explicitLabel) }
        guard let ua = exchange.requestHeaders["user-agent"]?.lowercased() else { return nil }
        let table: [(String, String)] = [
            ("claude-cli", "claude-code"), ("claude_code", "claude-code"),
            ("codex_cli_rs", "codex"), ("codex", "codex"),
            ("opencode", "opencode"),
            ("kimi", "kimi-cli"),
            ("gemini-cli", "gemini-cli"), ("gemini_cli", "gemini-cli"),
            ("pi-ai", "pi"), ("pi/", "pi"),
            ("aider", "aider"), ("cursor", "cursor"), ("continue", "continue"),
            ("python-", "python-sdk"), ("node", "node-sdk"),
            ("curl", "curl"),
        ]
        for (needle, product) in table where ua.contains(needle) { return (product, .headerSniffed) }
        return nil
    }

    /// Product-level attribution: which client TOOL made this request
    /// (claude-code, codex, pi, opencode...). Default: explicit label, else
    /// User-Agent sniffing. Product is orthogonal to vendor — codex CLI can
    /// hit OpenAI or a local runtime.
    open func product(for exchange: MeteredExchange) -> String? {
        productAttribution(for: exchange)?.product
    }

    /// Pseudonymous account the request is billed to, derived from the
    /// credential on the wire (Authorization / x-api-key hash — the raw
    /// credential is never persisted). Empty when the request carries no
    /// credential (local runtimes).
    open func accountID(for exchange: MeteredExchange) -> String? {
        let key = AccountKey.forRequestHeaders(vendor: vendor, headers: exchange.requestHeaders)
        return key.isEmpty ? nil : key
    }

    /// SECOND provider id for the same request, when the wire format has two
    /// (see UsageEvent.requestIDAlt). Default: none.
    open func requestIDAlt(for exchange: MeteredExchange) -> String? { nil }

    // MARK: - Wire rate limits (limits channel, source #1: the meter itself)

    /// Rate-limit snapshots parsed from RESPONSE headers of this exchange.
    /// OpenAI-compatible vendors emit `x-ratelimit-*`; AnthropicMeter
    /// overrides for `anthropic-ratelimit-*`. These are the freshest limits
    /// signal available (every response, per account, zero extra calls) and
    /// feed the same limit_snapshot table as the quota-API pollers.
    open func limitSnapshots(for exchange: MeteredExchange) -> [LimitSnapshot] {
        let h = exchange.responseHeaders
        var out: [LimitSnapshot] = []
        for (kind, resetKey) in [("requests", "x-ratelimit-reset-requests"),
                                 ("tokens", "x-ratelimit-reset-tokens")] {
            guard let limit = headerDouble(h, "x-ratelimit-limit-\(kind)"),
                  let remaining = headerDouble(h, "x-ratelimit-remaining-\(kind)"),
                  limit > 0 else { continue }
            let usedPercent = min(max((1 - remaining / limit) * 100, 0), 100)
            let resetsAt = h[resetKey].flatMap { parseResetDuration($0) }
                .map { exchange.completedAt.addingTimeInterval($0) }
            out.append(LimitSnapshot(
                recordedAt: exchange.completedAt,
                machineID: machineID,
                provider: vendor,
                accountID: accountID(for: exchange) ?? "",
                label: "\(kind) (wire)",
                usedPercent: usedPercent,
                resetsAt: resetsAt,
                detail: "\(Int(remaining))/\(Int(limit)) remaining"))
        }
        return out
    }

    func headerDouble(_ headers: [String: String], _ name: String) -> Double? {
        guard let raw = headers[name] else { return nil }
        return Double(raw)
    }

    /// OpenAI reset values are durations ("500ms", "1m2.5s", "20s"), not
    /// timestamps. Returns seconds; nil when unparsable.
    func parseResetDuration(_ raw: String) -> TimeInterval? {
        var total = 0.0
        var matched = false
        let pattern = #"(\d+(?:\.\d+)?)(ms|s|m|h)"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
        let ns = raw as NSString
        for m in re.matches(in: raw, range: NSRange(location: 0, length: ns.length)) {
            guard m.numberOfRanges == 3, let value = Double(ns.substring(with: m.range(at: 1))) else { continue }
            matched = true
            switch ns.substring(with: m.range(at: 2)) {
            case "ms": total += value / 1000
            case "s": total += value
            case "m": total += value * 60
            case "h": total += value * 3600
            default: break
            }
        }
        return matched ? total : nil
    }

    /// Context occupancy semantics differ per wire format (OpenAI's
    /// prompt_tokens INCLUDE cached tokens; Anthropic's input_tokens exclude
    /// cache read/write). Override accordingly. Default: input + cacheWrite.
    open func contextOccupancy(tokens: TokenBreakdown) -> Int? {
        tokens.input + tokens.cacheWrite
    }

    /// Cost decision for the exchange (CostEngine: plan vendors zero,
    /// API-billed vendors from catalog pricing). Vendor/tool-reported cost
    /// from files overrides later via the annotation sweep.
    open func costDecision(for exchange: MeteredExchange,
                           tokens: TokenBreakdown) -> (cost: Double, source: CostSource) {
        CostEngine.decide(vendor: vendor, model: model(for: exchange), tokens: tokens)
    }

    /// Cost in USD for the exchange (ModelCatalog pricing or vendor-reported).
    open func cost(for exchange: MeteredExchange, tokens: TokenBreakdown) -> Double {
        costDecision(for: exchange, tokens: tokens).cost
    }

    /// Measured rates. Generation tok/s = output tokens over body-streaming
    /// duration (first byte → completion). Prompt tok/s = input tokens over
    /// time-to-first-byte (includes queueing; end-to-end measurement).
    open func rates(from exchange: MeteredExchange, tokens: TokenBreakdown) -> (prompt: Double?, generation: Double?) {
        var generation: Double?
        if let firstByte = exchange.firstByteAt {
            let dur = exchange.completedAt.timeIntervalSince(firstByte)
            if tokens.output > 0, dur > 0.05 {
                generation = Double(tokens.output) / dur
            }
        }
        var prompt: Double?
        if let ttfb = exchange.firstByteAt?.timeIntervalSince(exchange.startedAt),
           ttfb > 0.02, tokens.input > 0 {
            prompt = Double(tokens.input) / ttfb
        }
        return (prompt, generation)
    }

    /// Finalize an exchange into an event. Override for full control.
    open func event(from exchange: MeteredExchange) -> UsageEvent? {
        guard shouldMeter(method: exchange.method, path: exchange.path),
              let tokens = usage(from: exchange), tokens.total > 0 else { return nil }
        let model = model(for: exchange)
        let rates = rates(from: exchange, tokens: tokens)
        let thinking = thinkingLevel(for: exchange)
        let attribution = productAttribution(for: exchange)
        let costDecision = costDecision(for: exchange, tokens: tokens)
        return UsageEvent(
            timestamp: exchange.completedAt,
            machineID: machineID,
            machineAlias: machineAlias,
            source: sourceKind,
            vendor: vendor,
            model: model,
            tokens: tokens,
            contextOccupancy: contextOccupancy(tokens: tokens),
            contextLimit: ModelCatalog.shared.lookup(id: Canonical.model(vendor: vendor, model: model)).map { $0.contextK * 1000 },
            cost: costDecision.cost,
            promptTokPerSec: rates.prompt,
            generationTokPerSec: rates.generation,
            latencyMs: exchange.durationMs,
            sessionID: sessionID(for: exchange),
            thinkingLevel: thinking?.level,
            thinkingRaw: thinking?.raw,
            product: attribution?.product,
            productSource: attribution?.source,
            costSource: costDecision.source,
            accountID: accountID(for: exchange),
            requestID: requestID(for: exchange),
            requestIDAlt: requestIDAlt(for: exchange),
            attestation: attestation)
    }

    // MARK: - Relay lifecycle

    public func start() {
        guard ConsentManager.shared.isGranted(.metering) else { return }
        guard listenFD < 0 else { return }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = listenPort.bigEndian
        addr.sin_addr = in_addr(s_addr: INADDR_LOOPBACK.bigEndian)
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        guard fd >= 0 else { return }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        let bound = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, listen(fd, 16) == 0 else {
            close(fd)
            return
        }
        listenFD = fd
        DispatchQueue(label: "tokenhorizon.meter.\(vendor).accept", qos: .utility).async { [weak self] in
            self?.acceptLoop()
        }
    }

    public func stop() {
        let fd = listenFD
        listenFD = -1
        if fd >= 0 { close(fd) }
    }

    private func acceptLoop() {
        while true {
            let fd = listenFD
            guard fd >= 0 else { return }
            let conn = accept(fd, nil, nil)
            guard conn >= 0 else {
                if errno == EINTR { continue }
                return
            }
            DispatchQueue(label: "tokenhorizon.meter.\(vendor).conn", qos: .utility).async { [weak self] in
                self?.handleConnection(conn)
            }
        }
    }

    // MARK: - Connection handling

    private final class Connection {
        let clientFD: Int32
        var exchange = MeteredExchange()
        var responseStarted = false
        init(clientFD: Int32) { self.clientFD = clientFD }
    }

    private func handleConnection(_ fd: Int32) {
        let conn = Connection(clientFD: fd)
        conn.exchange.startedAt = Date()
        guard let (header, rest) = readHeader(fd),
              let request = parseRequestHead(header) else {
            close(fd)
            return
        }
        conn.exchange.method = request.method
        conn.exchange.path = request.path
        for (name, value) in request.headers {
            conn.exchange.requestHeaders[name.lowercased()] = value
        }

        // Read the full request body (Content-Length or chunked).
        var body = rest
        if let contentLength = request.contentLength {
            body = readExact(fd, count: contentLength, initial: rest) ?? Data()
        } else if request.chunked {
            body = readChunked(fd, initial: rest) ?? Data()
        }
        conn.exchange.requestBody = body

        // Forward upstream (robust base+path join: avoid // and missing /).
        let base = targetBase.absoluteString.hasSuffix("/") ? String(targetBase.absoluteString.dropLast()) : targetBase.absoluteString
        let path = request.path.hasPrefix("/") ? request.path : "/\(request.path)"
        guard let url = URL(string: base + path) else {
            close(fd)
            return
        }
        var upstream = URLRequest(url: url)
        upstream.httpMethod = request.method
        for (name, value) in request.headers {
            let lower = name.lowercased()
            // Strip hop-by-hop + Host + encoding (identity keeps bodies parseable).
            if ["host", "connection", "content-length", "accept-encoding",
                "transfer-encoding", "keep-alive"].contains(lower) { continue }
            upstream.setValue(value, forHTTPHeaderField: name)
        }
        if !body.isEmpty { upstream.httpBody = body }
        upstream.timeoutInterval = 600

        let task = session.dataTask(with: upstream)
        stateLock.lock()
        inflight[task.taskIdentifier] = conn
        stateLock.unlock()
        task.resume()
    }

    // MARK: - URLSessionDataDelegate (streaming tee)

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                           didReceive response: URLResponse,
                           completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let conn = takeConn(dataTask, removing: false),
              let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        conn.exchange.status = http.statusCode
        for (key, value) in http.allHeaderFields {
            conn.exchange.responseHeaders[String(describing: key).lowercased()] = String(describing: value)
        }
        // Forward status + headers immediately; body follows close-delimited.
        var lines = ["HTTP/1.1 \(http.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: http.statusCode))"]
        for (key, value) in http.allHeaderFields {
            let name = String(describing: key)
            let lower = name.lowercased()
            if ["content-length", "transfer-encoding", "connection",
                "content-encoding"].contains(lower) { continue }
            lines.append("\(name): \(value)")
        }
        lines.append("Connection: close")
        lines.append("")
        lines.append("")
        writeAll(conn.clientFD, Data(lines.joined(separator: "\r\n").utf8))
        conn.responseStarted = true
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let conn = takeConn(dataTask, removing: false) else { return }
        if conn.exchange.firstByteAt == nil { conn.exchange.firstByteAt = Date() }
        conn.exchange.responseBody.append(data)
        writeAll(conn.clientFD, data)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           didCompleteWithError error: Error?) {
        guard let conn = takeConn(task, removing: true) else { return }
        conn.exchange.completedAt = Date()
        close(conn.clientFD)
        if conn.exchange.status >= 200, conn.exchange.status < 300 {
            let exchange = conn.exchange
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let self else { return }
                if let event = self.event(from: exchange) {
                    try? self.store?.insertMetered([event])
                }
                // Wire rate limits ride every response — capture them into the
                // limits timeline regardless of whether the exchange metered.
                let snapshots = self.limitSnapshots(for: exchange)
                if !snapshots.isEmpty { try? self.store?.recordLimits(snapshots) }
            }
        }
    }

    private func takeConn(_ task: URLSessionTask, removing: Bool) -> Connection? {
        stateLock.lock(); defer { stateLock.unlock() }
        if removing { return inflight.removeValue(forKey: task.taskIdentifier) }
        return inflight[task.taskIdentifier]
    }

    // MARK: - Wire helpers

    private struct RequestHead {
        var method = ""
        var path = ""
        var headers: [(String, String)] = []
        var contentLength: Int?
        var chunked = false
    }

    private func parseRequestHead(_ header: Data) -> RequestHead? {
        guard let text = String(data: header, encoding: .utf8) else { return nil }
        var lines = text.components(separatedBy: "\r\n")
        guard let first = lines.first else { return nil }
        let parts = first.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        var head = RequestHead()
        head.method = String(parts[0])
        head.path = String(parts[1])
        for line in lines.dropFirst() where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            head.headers.append((name, value))
            if name.lowercased() == "content-length" { head.contentLength = Int(value) }
            if name.lowercased() == "transfer-encoding", value.lowercased().contains("chunked") {
                head.chunked = true
            }
        }
        return head
    }

    private func readHeader(_ fd: Int32) -> (Data, Data)? {
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 16 * 1024)
        while data.count < 1024 * 1024 {
            let n = recv(fd, &buf, buf.count, 0)
            guard n > 0 else { return nil }
            data.append(contentsOf: buf[..<n])
            if let range = data.range(of: Data([13, 10, 13, 10])) {
                return (data[..<range.lowerBound], data[range.upperBound...])
            }
        }
        return nil
    }

    private func readExact(_ fd: Int32, count: Int, initial: Data) -> Data? {
        var data = initial
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while data.count < count {
            let n = recv(fd, &buf, min(buf.count, count - data.count), 0)
            guard n > 0 else { return nil }
            data.append(contentsOf: buf[..<n])
        }
        return Data(data.prefix(count))
    }

    private func readChunked(_ fd: Int32, initial: Data) -> Data? {
        var buffer = initial
        var body = Data()
        func fill(_ need: Int) -> Bool {
            var scratch = [UInt8](repeating: 0, count: max(need, 4096))
            while buffer.count < need {
                let n = recv(fd, &scratch, scratch.count, 0)
                guard n > 0 else { return false }
                buffer.append(contentsOf: scratch[..<n])
            }
            return true
        }
        while true {
            guard fill(3) else { return nil }
            guard let lineEnd = buffer.range(of: Data([13, 10])) else { return nil }
            let sizeText = String(decoding: buffer[..<lineEnd.lowerBound], as: UTF8.self)
                .split(separator: ";").first.map(String.init) ?? ""
            guard let size = Int(sizeText, radix: 16) else { return nil }
            buffer = buffer[lineEnd.upperBound...]
            if size == 0 { return body }
            guard fill(size + 2) else { return nil }
            body.append(buffer[..<size])
            buffer = buffer[(size + 2)...]
        }
    }

    private func writeAll(_ fd: Int32, _ data: Data) {
        data.withUnsafeBytes { ptr in
            guard let base = ptr.baseAddress else { return }
            var sent = 0
            while sent < data.count {
                let n = send(fd, base + sent, data.count - sent, 0)
                if n <= 0 { return }
                sent += n
            }
        }
    }
}
