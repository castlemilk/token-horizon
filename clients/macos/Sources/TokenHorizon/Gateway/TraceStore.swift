import Foundation

// TraceStore fronts the gateway's observability API for the dashboard.
// The sidecar owns capture/storage; the app reads through :8765 (LocalServer
// reverse-proxies gateway routes via GatewayBridge). Polling only runs while
// the TRACES tab is visible — loopback GETs are cheap but there's no reason
// to burn them on a hidden tab.
final class TraceStore: ObservableObject {
    static let shared = TraceStore()

    @Published private(set) var traces: [GatewayTrace] = []
    @Published private(set) var stats: GatewayStats?
    @Published private(set) var sessions: [GatewaySessionStats] = []
    @Published private(set) var online = false
    @Published private(set) var memoryTraces = 0
    @Published private(set) var dayFiles = 0
    @Published private(set) var storeBytes: Int64 = 0

    private var timer: Timer?
    private var inFlight = false
    var windowHours = 24

    private let base = "http://127.0.0.1:8765"

    func startPolling() {
        refresh()
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() {
        guard !inFlight else { return }
        inFlight = true
        let group = DispatchGroup()
        var newTraces: [GatewayTrace]?
        var newStats: GatewayStats?
        var newSessions: [GatewaySessionStats]?
        var counts: (Int, Int, Int64)?
        var reachable = false

        group.enter()
        get("/traces?limit=100") { data in
            defer { group.leave() }
            guard let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let list = obj["traces"] else { return }
            reachable = true
            counts = (obj["memory"] as? Int ?? 0,
                      obj["dayFiles"] as? Int ?? 0,
                      (obj["bytes"] as? NSNumber)?.int64Value ?? 0)
            if let tdata = try? JSONSerialization.data(withJSONObject: list) {
                newTraces = try? JSONDecoder().decode([GatewayTrace].self, from: tdata)
            }
        }
        group.enter()
        get("/proxy/stats?hours=\(windowHours)") { data in
            defer { group.leave() }
            guard let data else { return }
            newStats = try? JSONDecoder().decode(GatewayStats.self, from: data)
        }
        group.enter()
        get("/traces/sessions?hours=\(windowHours)&limit=60") { data in
            defer { group.leave() }
            guard let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let list = obj["sessions"],
                  let sdata = try? JSONSerialization.data(withJSONObject: list) else { return }
            newSessions = try? JSONDecoder().decode([GatewaySessionStats].self, from: sdata)
        }
        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            self.inFlight = false
            self.online = reachable
            if let newTraces { self.traces = newTraces }
            if let newStats { self.stats = newStats }
            if let newSessions { self.sessions = newSessions }
            if let counts { (self.memoryTraces, self.dayFiles, self.storeBytes) = counts }
        }
    }

    /// Estimated USD cost for token counts via the model catalog. The
    /// gateway deliberately records null cost (no pricing dependency); the
    /// app owns the catalog and enriches at read time.
    func estimatedCost(provider: String, model: String, input: Int, output: Int, cached: Int) -> Double? {
        guard let entry = ModelCatalog.shared.lookup(id: model)
            ?? ModelCatalog.shared.lookup(id: "\(provider)/\(model)") else { return nil }
        var cost = Double(input) * entry.inputPerM / 1_000_000
        cost += Double(output) * entry.outputPerM / 1_000_000
        if cached > 0, let cacheRate = entry.cacheReadPerM {
            cost += Double(cached) * cacheRate / 1_000_000
        }
        return cost
    }

    private func get(_ path: String, done: @escaping (Data?) -> Void) {
        guard let url = URL(string: base + path) else {
            done(nil)
            return
        }
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { data, _, _ in done(data) }.resume()
    }
}
