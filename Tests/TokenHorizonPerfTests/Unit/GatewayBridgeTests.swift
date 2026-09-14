import XCTest
@testable import TokenHorizon

// GatewayBridge tests: ownership matrix, URL joining, and graceful 503s
// when the sidecar is down. The sidecar's own behavior is pinned by the Go
// suite (gateway/*_test.go), not here.

final class GatewayBridgeTests: XCTestCase {
    func testOwns() {
        XCTAssertTrue(GatewayBridge.owns(method: "GET", route: "/traces"))
        XCTAssertTrue(GatewayBridge.owns(method: "GET", route: "/traces/abc-123"))
        XCTAssertTrue(GatewayBridge.owns(method: "GET", route: "/proxy/stats"))
        XCTAssertTrue(GatewayBridge.owns(method: "GET", route: "/proxy/config"))
        XCTAssertTrue(GatewayBridge.owns(method: "POST", route: "/traces/clear"))
        XCTAssertTrue(GatewayBridge.owns(method: "GET", route: "/traces/clear"))
        XCTAssertFalse(GatewayBridge.owns(method: "GET", route: "/stats"))
        XCTAssertFalse(GatewayBridge.owns(method: "POST", route: "/traces"))
        XCTAssertFalse(GatewayBridge.owns(method: "DELETE", route: "/traces/abc"))
        XCTAssertFalse(GatewayBridge.owns(method: "GET", route: "/health"))
    }

    func testTargetURL() {
        let base = URL(string: "http://127.0.0.1:11436")!
        XCTAssertEqual(GatewayBridge.targetURL(base: base, path: "/traces?limit=5")?.absoluteString,
                       "http://127.0.0.1:11436/traces?limit=5")
        XCTAssertEqual(GatewayBridge.targetURL(base: base, path: "proxy/stats")?.absoluteString,
                       "http://127.0.0.1:11436/proxy/stats")
    }

    private func code(of data: Data) -> Int {
        let head = String(decoding: data.prefix(64), as: UTF8.self)
        let parts = head.components(separatedBy: " ")
        return parts.count > 1 ? Int(parts[1]) ?? 0 : 0
    }

    private func jsonResponse(method: String, path: String, body: Data = Data(), baseURL: URL?) -> (Int, Any?) {
        let data = GatewayBridge.response(method: method, path: path, body: body, baseURL: baseURL) { obj, status in
            let payload = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
            let header = "HTTP/1.1 \(status) OK\r\nContent-Length: \(payload.count)\r\n\r\n"
            return Data(header.utf8) + payload
        }!
        let sep = Data("\r\n\r\n".utf8)
        let range = data.range(of: sep)!
        let payload = data[range.upperBound...]
        return (code(of: data), try? JSONSerialization.jsonObject(with: Data(payload)))
    }

    func testUnavailableGateway503() {
        let (noBase, noBaseJSON) = jsonResponse(method: "GET", path: "/traces", baseURL: nil)
        XCTAssertEqual(noBase, 503)
        XCTAssertNotNil((noBaseJSON as? [String: Any])?["error"])

        // Port 1 refuses instantly on loopback: no hang, still 503.
        let dead = URL(string: "http://127.0.0.1:1")!
        let (refused, refusedJSON) = jsonResponse(method: "GET", path: "/proxy/stats?hours=24", baseURL: dead)
        XCTAssertEqual(refused, 503)
        XCTAssertNotNil((refusedJSON as? [String: Any])?["error"])
    }

    // MARK: Ingest route (sidecar -> app Ollama continuity)

    private func stubServer() -> LocalServer {
        LocalServer(
            statsProvider: { UsageSnapshot.empty },
            sysProvider: { SystemStats.Snapshot() },
            historyProvider: { _ in (points: [], streak: 0) },
            trendsProvider: { _ in [] },
            limitsProvider: { [] },
            processesProvider: { (all: [], byCPU: [], byMem: [], byDisk: [], byNet: []) },
            onEvent: { _ in },
            onCacheReset: nil)
    }

    private func call(_ srv: LocalServer, _ method: String, _ path: String, body: Data) -> (Int, Any?) {
        let data = LocalServer.handle(method: method, path: path, body: body, server: srv)
        let sep = Data("\r\n\r\n".utf8)
        guard let range = data.range(of: sep) else { return (0, nil) }
        let head = String(decoding: data[..<range.lowerBound], as: UTF8.self)
        let parts = head.components(separatedBy: "\r\n").first?.components(separatedBy: " ") ?? []
        let code = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        return (code, try? JSONSerialization.jsonObject(with: Data(data[range.upperBound...])))
    }

    func testIngestOllama() {
        OllamaTelemetryStore.shared.resetForTesting()
        let body = Data(#"{"model":"ingest-test","evalCount":100,"evalDurationNs":2000000000,"promptEvalCount":20,"completedAt":1786000000}"#.utf8)
        let (code, json) = call(stubServer(), "POST", "/ingest/ollama", body: body)
        XCTAssertEqual(code, 200)
        XCTAssertEqual((json as? [String: Any])?["ok"] as? Bool, true)
        let usage = OllamaTelemetryStore.shared.usage(for: "ingest-test")
        XCTAssertEqual(usage.tokensAll, 120)
        XCTAssertEqual(usage.messages, 1)
    }

    func testIngestOllamaRejectsBadSamples() {
        let (code, _) = call(stubServer(), "POST", "/ingest/ollama", body: Data("{}".utf8))
        XCTAssertEqual(code, 400)
        let (code2, _) = call(stubServer(), "POST", "/ingest/ollama",
                              body: Data(#"{"model":"x","evalCount":1,"evalDurationNs":0}"#.utf8))
        XCTAssertEqual(code2, 400)
    }
}
