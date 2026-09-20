import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// A decoded HTTP/1.x request hitting the loopback API.
public struct HTTPRequest {
    public let method: String
    /// Raw path including the query string.
    public let path: String
    public let body: Data
    /// Header values keyed by lowercased header name.
    public let headers: [String: String]

    public init(method: String, path: String, body: Data, headers: [String: String] = [:]) {
        self.method = method
        self.path = path
        self.body = body
        self.headers = headers
    }
}

/// Response to a loopback API call.
public struct HTTPResponse {
    public var status: Int
    public var contentType: String
    public var body: Data

    public init(status: Int = 200, contentType: String = "application/json", body: Data) {
        self.status = status
        self.contentType = contentType
        self.body = body
    }

    public func serialized(corsOrigin: String? = nil) -> Data {
        let reason: String
        switch status {
        case 200: reason = "OK"
        case 400: reason = "Bad Request"
        case 404: reason = "Not Found"
        case 413: reason = "Content Too Large"
        case 500: reason = "Internal Server Error"
        case 503: reason = "Service Unavailable"
        default: reason = "OK"
        }
        var header = "HTTP/1.1 \(status) \(reason)\r\n"
            + "Content-Type: \(contentType)\r\n"
        // Reflect only trusted local webview origins (see transport); never "*",
        // which would let any website read local usage data cross-origin.
        if let corsOrigin {
            header += "Access-Control-Allow-Origin: \(corsOrigin)\r\n"
                + "Vary: Origin\r\n"
        }
        header += "Content-Length: \(body.count)\r\n"
            + "Connection: close\r\n\r\n"
        return Data(header.utf8) + body
    }
}

public typealias HTTPHandler = (HTTPRequest) -> HTTPResponse

/// Loopback HTTP server abstraction. Every host (macOS app and headless
/// daemon alike) uses `POSIXLoopbackHTTPServer` — one transport, one router.
public protocol LocalHTTPServing: AnyObject {
    /// Actual bound port (0 until started).
    var port: UInt16 { get }
    func start(preferredPort: UInt16)
    func stop()
}

extension LocalHTTPServing {
    public func start() { start(preferredPort: 8765) }
}

#if !os(Windows)

/// Minimal dependency-free HTTP/1.1 loopback server built on BSD sockets.
/// Compiles on macOS (Darwin) and Linux (Glibc); used where Network.framework
/// is unavailable. Binds 127.0.0.1, scans upward
/// from the preferred port, one request per connection, Connection: close.
public final class POSIXLoopbackHTTPServer: LocalHTTPServing {
    public private(set) var port: UInt16 = 0
    private let handler: HTTPHandler
    private var listenFD: Int32 = -1
    private var running = false
    private let lock = NSLock()

    public init(handler: @escaping HTTPHandler) {
        self.handler = handler
    }

    public func start(preferredPort: UInt16 = 8765) {
        lock.lock()
        defer { lock.unlock() }
        guard !running else { return }
        for attempt in 0..<20 {
            let candidate = preferredPort &+ UInt16(attempt)
            if let fd = Self.bindSocket(port: candidate) {
                listenFD = fd
                port = candidate
                running = true
                break
            }
        }
        guard running else { return }
        DispatchQueue(label: "tokenhorizon.http.accept", qos: .utility).async { [weak self] in
            self?.acceptLoop()
        }
    }

    public func stop() {
        lock.lock()
        running = false
        let fd = listenFD
        listenFD = -1
        lock.unlock()
        if fd >= 0 { close(fd) }
    }

    private static func bindSocket(port: UInt16) -> Int32? {
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        guard fd >= 0 else { return nil }
        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: in_addr_t(0x7F000001).bigEndian) // 127.0.0.1
        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0, listen(fd, 16) == 0 else {
            close(fd)
            return nil
        }
        return fd
    }

    private func acceptLoop() {
        while true {
            lock.lock()
            let fd = listenFD
            let isRunning = running
            lock.unlock()
            guard isRunning, fd >= 0 else { return }
            let conn = accept(fd, nil, nil)
            if conn < 0 {
                if errno == EINTR { continue }
                if !isRunning { return }
                continue
            }
            DispatchQueue.global(qos: .utility).async { [weak self] in
                self?.handleConnection(conn)
            }
        }
    }

    /// Origins trusted to read the loopback API from a webview: the Tauri
    /// shell (`tauri://localhost` on macOS/Linux, `http://tauri.localhost` on
    /// Windows) and local dev servers on any port. Anything else gets no CORS
    /// header, so arbitrary websites can't read local usage data cross-origin.
    private static func corsOrigin(for request: HTTPRequest) -> String? {
        guard let origin = request.headers["origin"],
              let host = URL(string: origin)?.host?.lowercased()
        else { return nil }
        switch host {
        case "tauri.localhost", "localhost", "127.0.0.1", "::1", "[::1]":
            return origin
        default:
            return nil
        }
    }

    private static func writeAll(_ fd: Int32, _ data: Data) {
        data.withUnsafeBytes { ptr in
            var sent = 0
            while sent < data.count {
                guard let base = ptr.baseAddress else { return }
                let n = write(fd, base.advanced(by: sent), data.count - sent)
                if n <= 0 { return }
                sent += n
            }
        }
    }

    private func handleConnection(_ fd: Int32) {
        defer { close(fd) }
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)

        // Read until end of headers.
        var headEnd: Range<Data.Index>?
        while headEnd == nil {
            let n = chunk.withUnsafeMutableBytes { ptr -> Int in
                read(fd, ptr.baseAddress, ptr.count)
            }
            guard n > 0 else { return }
            buffer.append(contentsOf: chunk[0..<n])
            headEnd = buffer.range(of: Data("\r\n\r\n".utf8))
            if buffer.count > 1_048_576 { return }
        }
        guard let headRange = headEnd else { return }

        let headText = String(decoding: buffer[..<headRange.lowerBound], as: UTF8.self)
        var body = Data(buffer[headRange.upperBound...])
        let lines = headText.components(separatedBy: "\r\n")
        let parts = lines.first.map { $0.split(separator: " ") } ?? []
        let method = parts.count > 0 ? String(parts[0]) : ""
        let rawPath = parts.count > 1 ? String(parts[1]) : "/"
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if !name.isEmpty { headers[name] = value }
        }
        let contentLength = headers["content-length"].flatMap { Int($0) } ?? 0
        guard contentLength <= 4_194_304 else {
            let resp = HTTPResponse(status: 413, body: Data("{\"error\":\"body too large\"}".utf8))
            Self.writeAll(fd, resp.serialized())
            return
        }
        while body.count < contentLength {
            let n = chunk.withUnsafeMutableBytes { ptr -> Int in
                read(fd, ptr.baseAddress, min(ptr.count, contentLength - body.count))
            }
            guard n > 0 else { return }
            body.append(contentsOf: chunk[0..<n])
        }

        let request = HTTPRequest(method: method, path: rawPath, body: body, headers: headers)
        let cors = Self.corsOrigin(for: request)

        // CORS preflight: answered by the transport, never routed.
        if method == "OPTIONS", request.headers["access-control-request-method"] != nil {
            var head = "HTTP/1.1 200 OK\r\n"
            if let cors {
                head += "Access-Control-Allow-Origin: \(cors)\r\n"
                    + "Vary: Origin\r\n"
                    + "Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n"
                    + "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
                    + "Access-Control-Max-Age: 600\r\n"
            }
            head += "Content-Length: 0\r\nConnection: close\r\n\r\n"
            Self.writeAll(fd, Data(head.utf8))
            return
        }

        let response = handler(request)
        Self.writeAll(fd, response.serialized(corsOrigin: cors))
    }
}

#else

public final class POSIXLoopbackHTTPServer: LocalHTTPServing {
    public private(set) var port: UInt16 = 0
    public init(handler: @escaping HTTPHandler) {}
    public func start(preferredPort: UInt16) {}
    public func stop() {}
}

#endif // !os(Windows)
