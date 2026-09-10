import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Base class for per-vendor plan/quota adapters.
///
/// One subclass per vendor (Vendors/Limits/<Vendor>/). The base class provides
/// the shared plumbing: bearer-auth JSON GET/POST, JSON tree digging, date/number
/// coercion, and the `VendorAuth` credential chain. Subclasses must override
/// `fetch()` and typically `auth`; returning [] from fetch means "vendor not
/// configured/unreachable" and is silent by design.
open class VendorLimitsAdapter {
    public let provider: String

    public init(provider: String) {
        self.provider = provider
    }

    /// Credential chain for this vendor. Empty by default (vendor needs no auth).
    open var auth: VendorAuth { VendorAuth() }

    /// Override point — required. May block (called off-main via
    /// LimitsEngine.refreshIfDue). Use `limit(...)` to build rows.
    open func fetch() -> [ProviderLimit] {
        fatalError("\(type(of: self)) must override fetch()")
    }

    // MARK: - Meterable (dual tracking: limits/files + request metering)

    /// Vendor's meterable API base. Nil = vendor exposes no meterable API.
    open var meterTarget: URL? { nil }

    /// Default: OpenAI-compatible wire format (most vendors). Override for
    /// Anthropic/Gemini-shaped APIs.
    open func makeMeter(listenPort: UInt16, target: URL?, store: UsageStoring?) -> RequestMeter? {
        guard let base = target ?? meterTarget else { return nil }
        return OpenAICompatibleMeter(vendor: provider, listenPort: listenPort, targetBase: base,
                                     store: store, sourceKind: .external)
    }

    /// Build a limit row: clamps to 0-100; `provider` defaults to this adapter's
    /// vendor but can be overridden (e.g. GeminiLimits also emits "agy" rows).
    public func limit(label: String, usedPercent: Double, resetsAt: Date? = nil,
                      detail: String = "", provider: String? = nil) -> ProviderLimit {
        ProviderLimit(provider: provider ?? self.provider, label: label,
                      usedPercent: min(max(usedPercent, 0), 100),
                      resetsAt: resetsAt, detail: detail)
    }

    // MARK: - Auth sources

    /// Back-compat shim — see `CredentialSource.opencodeKey`.
    public static func opencodeAuthKeys() -> [String: String] {
        CredentialSource.opencodeAuthFileKeys()
    }

    // MARK: - HTTP helpers (blocking, JSON object in/out)

    static var userAgent: String {
        // Keep the opencode UA string — some vendor gateways key off it.
        #if os(macOS)
        return "opencode/1.0.0 (darwin; arm64)"
        #elseif os(Linux)
        return "opencode/1.0.0 (linux; x86_64)"
        #else
        return "opencode/1.0.0 (windows; x86_64)"
        #endif
    }

    func getJSON(url: String, key: String, timeout: TimeInterval = 8) -> [String: Any]? {
        guard let u = URL(string: url) else { return nil }
        var req = URLRequest(url: u, timeoutInterval: timeout)
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        return performJSON(req, timeout: timeout)
    }

    func postJSON(url: String, key: String, body: [String: Any], timeout: TimeInterval = 8) -> [String: Any]? {
        guard let u = URL(string: url) else { return nil }
        var req = URLRequest(url: u, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
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
