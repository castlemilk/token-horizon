import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Base class for per-vendor plan/quota adapters.
///
/// One subclass per vendor (ZhipuLimits, AlibabaLimits, ClaudeLimits, ...).
/// The base class provides the shared plumbing: bearer-auth JSON GET/POST,
/// JSON tree digging, and date/number coercion. Subclasses override `fetch()`
/// and return unified `ProviderLimit` rows; returning [] means "vendor not
/// configured/unreachable" and is silent by design.
public class VendorLimitsAdapter {
    public let provider: String

    public init(provider: String) {
        self.provider = provider
    }

    /// Override point. May block (called off-main via LimitsEngine.refreshIfDue).
    public func fetch() -> [ProviderLimit] { [] }

    // MARK: - Auth sources

    /// API keys stored by opencode (`~/.local/share/opencode/auth.json`).
    public static func opencodeAuthKeys() -> [String: String] {
        let path = ProcessInfo.processInfo.environment["OPENCODE_AUTH"]
            ?? NSString(string: "~/.local/share/opencode/auth.json").expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { return [:] }
        var out: [String: String] = [:]
        for (provider, entry) in obj {
            if let key = entry["key"] as? String, !key.isEmpty {
                out[provider] = key
            }
        }
        return out
    }

    // MARK: - HTTP helpers (blocking, JSON object in/out)

    func getJSON(url: String, key: String, timeout: TimeInterval = 8) -> [String: Any]? {
        guard let u = URL(string: url) else { return nil }
        var req = URLRequest(url: u, timeoutInterval: timeout)
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("opencode/1.0.0 (darwin; arm64)", forHTTPHeaderField: "User-Agent")
        return performJSON(req, timeout: timeout)
    }

    func postJSON(url: String, key: String, body: [String: Any], timeout: TimeInterval = 8) -> [String: Any]? {
        guard let u = URL(string: url) else { return nil }
        var req = URLRequest(url: u, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("opencode/1.0.0 (darwin; arm64)", forHTTPHeaderField: "User-Agent")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return performJSON(req, timeout: timeout)
    }

    /// Blocking JSON request; nil on transport error, non-2xx, or non-dict JSON.
    func performJSON(_ req: URLRequest, timeout: TimeInterval) -> [String: Any]? {
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + timeout) == .timedOut { return nil }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    /// Blocking raw request (for adapters that parse non-JSON or need the body).
    func performRaw(_ req: URLRequest, timeout: TimeInterval) -> Data? {
        var data: Data?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + timeout) == .timedOut { return nil }
        return data
    }

    // MARK: - JSON tree digging

    func findDict(containingAny keys: [String], in node: Any, depth: Int = 0) -> [String: Any]? {
        guard depth < 10 else { return nil }
        if let dict = node as? [String: Any] {
            if keys.contains(where: { dict[$0] != nil }) { return dict }
            for (_, v) in dict {
                if let found = findDict(containingAny: keys, in: v, depth: depth + 1) { return found }
            }
        } else if let array = node as? [Any] {
            for v in array {
                if let found = findDict(containingAny: keys, in: v, depth: depth + 1) { return found }
            }
        }
        return nil
    }

    func findObject(key: String, in node: Any, depth: Int = 0) -> Any? {
        guard depth < 8 else { return nil }
        if let dict = node as? [String: Any] {
            if let v = dict[key] { return v }
            for (_, v) in dict {
                if let found = findObject(key: key, in: v, depth: depth + 1) { return found }
            }
        } else if let array = node as? [Any] {
            for v in array {
                if let found = findObject(key: key, in: v, depth: depth + 1) { return found }
            }
        }
        return nil
    }

    // MARK: - Coercion

    func number(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue }
        if let s = v as? String { return Double(s) }
        return nil
    }

    func epoch(_ v: Any?) -> Date? {
        guard let n = v as? NSNumber else { return nil }
        let t = n.doubleValue
        return Date(timeIntervalSince1970: t > 1e12 ? t / 1000 : t)
    }

    func epochMS(_ v: Any?) -> Date? { epoch(v) }

    func parseISO(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    func cookieValue(name: String, from cookie: String) -> String? {
        for pair in cookie.split(separator: ";") {
            let trimmed = pair.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("\(name)=") {
                return trimmed.dropFirst(name.count + 1).removingPercentEncoding
            }
        }
        return nil
    }
}
