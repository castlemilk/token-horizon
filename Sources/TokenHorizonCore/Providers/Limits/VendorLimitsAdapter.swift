import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Base class for per-vendor plan/quota adapters.
///
/// One subclass per vendor (Providers/<Vendor>/). The base class provides
/// the shared plumbing: bearer-auth JSON GET/POST, JSON tree digging, date/number
/// coercion, and the `VendorAuth` credential chain. Subclasses must override
/// `fetch()` and typically `auth`; returning [] from fetch means "vendor not
/// configured/unreachable" and is silent by design.
open class VendorLimitsAdapter: Meterable {
    public let provider: String

    public init(provider: String) {
        self.provider = provider
    }

    open var meterVendorKey: String { provider }
    open var defaultMeterTarget: URL? { meterTarget }

    /// Credential chain for this vendor. Empty by default (vendor needs no auth).
    open var auth: VendorAuth { VendorAuth() }

    /// Labeled credentials for quota fetching (multi-account). Default: the
    /// whole auth chain flattened (profile dirs vend one entry per file).
    /// Override for directory-per-account layouts (e.g. `~/.claude*`).
    open func credentials() -> [(label: String, credential: String)] {
        auth.resolveAll()
    }

    private let backoffLock = NSLock()
    private var backoffUntil: [String: Date] = [:]

    /// Per-host 429 backoff: skip requests while inside the window so one
    /// throttled account doesn't burn the quota of the others.
    public func isBackedOff(host: String) -> Bool {
        backoffLock.lock(); defer { backoffLock.unlock() }
        return (backoffUntil[host] ?? .distantPast) > Date()
    }

    public func noteStatus(host: String, status: Int, retryAfter: TimeInterval? = nil) {
        guard status == 429 else { return }
        backoffLock.lock()
        backoffUntil[host] = Date().addingTimeInterval(retryAfter ?? 60)
        backoffLock.unlock()
        FileHandle.standardError.write("token-horizon: \(provider) 429 on \(host) — backing off\n".data(using: .utf8)!)
    }

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
    /// 401/403 are logged to stderr so expired keys don't silently drop rows.
    /// 429 responses arm a per-host backoff window (see `isBackedOff`).
    func performJSON(_ req: URLRequest, timeout: TimeInterval) -> [String: Any]? {
        if let host = req.url?.host, isBackedOff(host: host) { return nil }
        var data: Data?
        var status = 0
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(status) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + timeout) == .timedOut { return nil }
        if let host = req.url?.host { noteStatus(host: host, status: status) }
        if status == 401 || status == 403 {
            FileHandle.standardError.write("token-horizon: \(provider) quota 401/403 — credential expired, re-auth required\n".data(using: .utf8)!)
            return nil
        }
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    /// Blocking raw request (for adapters that parse non-JSON or need the body).
    func performRaw(_ req: URLRequest, timeout: TimeInterval) -> Data? {
        if let host = req.url?.host, isBackedOff(host: host) { return nil }
        var data: Data?
        var status = 0
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, resp, _ in
            status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(status) { data = d }
            sema.signal()
        }.resume()
        if sema.wait(timeout: .now() + timeout) == .timedOut { return nil }
        if let host = req.url?.host { noteStatus(host: host, status: status) }
        if status == 401 || status == 403 {
            FileHandle.standardError.write("token-horizon: \(provider) quota 401/403 — credential expired, re-auth required\n".data(using: .utf8)!)
        }
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

    // MARK: - Coercion (delegate to shared QuotaParsers)

    func number(_ v: Any?) -> Double? { QuotaParsers.number(v) }

    func epoch(_ v: Any?) -> Date? { QuotaParsers.epoch(v) }

    func parseISO(_ s: String?) -> Date? { QuotaParsers.parseISO(s) }

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
