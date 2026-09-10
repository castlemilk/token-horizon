#if os(macOS)
import Foundation
import Network

/// macOS loopback transport (NWListener). ALL route logic lives in core's
/// `CoreAPIRouter` — this type only frames bytes and delegates, so the app
/// and the headless daemon serve byte-identical APIs.
public final class LocalServer {
    private var listener: NWListener?
    public let router: CoreAPIRouter
    private(set) var port: UInt16 = 8765

    public init(router: CoreAPIRouter) {
        self.router = router
    }

    public func start() {
        for attempt in 0..<20 {
            let candidate = UInt16(8765 + attempt)
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            guard let p = NWEndpoint.Port(rawValue: candidate),
                  let l = try? NWListener(using: params, on: p) else { continue }
            listener = l
            port = candidate
            break
        }
        guard let listener else { return }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        listener.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.listener = nil }
        }
        listener.start(queue: DispatchQueue(label: "tokenhorizon.server"))
    }

    private func accept(_ conn: NWConnection) {
        conn.stateUpdateHandler = { state in
            if case .cancelled = state { conn.cancel() }
            if case .failed = state { conn.cancel() }
        }
        conn.start(queue: DispatchQueue(label: "tokenhorizon.conn.\(ObjectIdentifier(conn).hashValue)"))
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let range = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = Data(buf[..<range.lowerBound])
                var body = Data(buf[range.upperBound...])
                let headText = String(decoding: head, as: UTF8.self)
                let lines = headText.components(separatedBy: "\r\n")
                let parts = lines.first.map { $0.split(separator: " ") } ?? []
                let method = parts.count > 0 ? String(parts[0]) : ""
                let rawPath = parts.count > 1 ? String(parts[1]) : "/"
                let contentLength = lines.first(where: { $0.lowercased().hasPrefix("content-length:") })
                    .flatMap { Int($0.drop(while: { $0 != ":" }).dropFirst().trimmingCharacters(in: .whitespaces)) } ?? 0
                while body.count < contentLength, !done {
                    let remaining = contentLength - body.count
                    let sema = DispatchSemaphore(value: 0)
                    conn.receive(minimumIncompleteLength: remaining, maximumLength: remaining) { d, _, _, _ in
                        if let d { body.append(d) }
                        sema.signal()
                    }
                    sema.wait()
                }
                let response = self.router.route(HTTPRequest(method: method, path: rawPath, body: body))
                conn.send(content: response.serialized(), completion: .contentProcessed { _ in conn.cancel() })
            } else if error == nil && !done && buf.count < 1_048_576 {
                self.receive(conn, buffer: buf)
            } else {
                conn.cancel()
            }
        }
    }
}

#endif // os(macOS)
