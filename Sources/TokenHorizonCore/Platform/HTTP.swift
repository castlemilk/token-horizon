import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// ONE synchronous JSON-over-HTTP helper — kills the hand-rolled
/// URLSession+semaphore+box pattern that was scattered across adapters
/// (and triggered Swift 6 "mutation of captured var" diagnostics).
/// Blocking by design: callers are engines/adapters already running
/// off-main on utility queues. Never call from the main thread.
public enum HTTP {

    public struct Response {
        /// 0 = transport failure or timeout.
        public let status: Int
        public let data: Data?
        /// Response headers, lowercased keys.
        public let headers: [String: String]
        public var json: [String: Any]? {
            data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        }
    }

    private final class Box {
        let lock = NSLock()
        var status = 0
        var data: Data?
        var headers: [String: String] = [:]
        func set(status: Int, data: Data?, headers: [String: String]) {
            lock.lock()
            self.status = status
            self.data = data
            self.headers = headers
            lock.unlock()
        }
        func get() -> (Int, Data?, [String: String]) {
            lock.lock()
            defer { lock.unlock() }
            return (status, data, headers)
        }
    }

    /// Blocking request round-trip. Status 0 + nil data on transport
    /// failure or timeout.
    @discardableResult
    public static func send(_ request: URLRequest, timeout: TimeInterval = 10) -> Response {
        let box = Box()
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let http = response as? HTTPURLResponse
            let headers = (http?.allHeaderFields ?? [:]).reduce(into: [String: String]()) {
                $0["\($1.key)".lowercased()] = "\($1.value)"
            }
            box.set(status: http?.statusCode ?? 0, data: data, headers: headers)
            sema.signal()
        }.resume()
        _ = sema.wait(timeout: .now() + timeout)
        let (status, data, headers) = box.get()
        return Response(status: status, data: data, headers: headers)
    }

    /// GET expecting a JSON object. Nil on transport failure or non-JSON.
    /// The HTTP status is returned regardless of 2xx so callers can branch
    /// on 401/429.
    public static func getJSON(_ url: URL, headers: [String: String] = [:],
                               timeout: TimeInterval = 10) -> (status: Int, json: [String: Any])? {
        var req = URLRequest(url: url, timeoutInterval: timeout)
        for (key, value) in headers { req.setValue(value, forHTTPHeaderField: key) }
        let r = send(req, timeout: timeout)
        guard r.status > 0, let json = r.json else { return nil }
        return (r.status, json)
    }

    /// POST a JSON object body, expecting a JSON object (or empty) back.
    public static func postJSON(_ url: URL, headers: [String: String] = [:],
                                body: [String: Any], timeout: TimeInterval = 10) -> (status: Int, json: [String: Any])? {
        guard let payload = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (key, value) in headers { req.setValue(value, forHTTPHeaderField: key) }
        req.httpBody = payload
        let r = send(req, timeout: timeout)
        guard r.status > 0 else { return nil }
        return (r.status, r.json ?? [:])
    }
}
