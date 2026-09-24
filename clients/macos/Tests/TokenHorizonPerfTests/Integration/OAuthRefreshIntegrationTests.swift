import XCTest
import Foundation
import Network
@testable import TokenHorizon

/// Integration tests for OAuth token refresh + write-back, exercised over
/// real loopback HTTP against a mock token endpoint. Covers the contract
/// that keeps quota polling alive without ever launching `claude`/`codex`:
/// request shape (grant_type/client_id/refresh_token), refresh-token
/// rotation persisted back into the store the CLI reads, the race guard
/// that adopts the CLI's tokens when it rotated first, endpoint fallback,
/// and the wham/usage quota fetch end to end.
final class OAuthRefreshIntegrationTests: XCTestCase {

    // MARK: - Loopback mock OAuth server

    private final class MockOAuthServer {
        struct Recorded {
            var method: String
            var path: String
            var headers: [String: String]
            var body: String
            var json: [String: Any]? {
                guard let d = body.data(using: .utf8) else { return nil }
                return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            }
        }

        private var listener: NWListener?
        private let queue = DispatchQueue(label: "th-test-mock-oauth")
        private let lock = NSLock()
        private var requests: [Recorded] = []
        private var routes: [String: [(status: Int, body: String)]] = [:]
        private(set) var port: UInt16 = 0

        var recorded: [Recorded] { lock.lock(); defer { lock.unlock() }; return requests }

        func respond(_ path: String, status: Int, body: String) {
            lock.lock(); routes[path] = [(status, body)]; lock.unlock()
        }

        /// Ordered responses consumed one per hit; the last repeats.
        func respondSequence(_ path: String, _ responses: [(Int, String)]) {
            lock.lock(); routes[path] = responses; lock.unlock()
        }

        func start() throws {
            let l = try NWListener(using: .tcp, on: .any)
            listener = l
            l.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
            let ready = DispatchSemaphore(value: 0)
            l.stateUpdateHandler = { state in
                if case .ready = state { ready.signal() }
            }
            l.start(queue: queue)
            XCTAssertEqual(ready.wait(timeout: .now() + 5), .success, "mock listener never became ready")
            guard let p = l.port else {
                XCTFail("mock listener has no port")
                return
            }
            port = p.rawValue
        }

        func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)\(path)")! }

        func stop() {
            listener?.cancel()
            listener = nil
        }

        private func handle(_ conn: NWConnection) {
            conn.start(queue: queue)
            receive(conn, Data())
        }

        private func receive(_ conn: NWConnection, _ buffer: Data) {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] chunk, _, isComplete, _ in
                guard let self else { return }
                var data = buffer
                if let chunk { data.append(chunk) }
                if let req = Self.parse(data) {
                    self.serve(conn, req)
                } else if isComplete {
                    conn.cancel()
                } else {
                    self.receive(conn, data)
                }
            }
        }

        private static func parse(_ data: Data) -> (method: String, path: String, headers: [String: String], body: String)? {
            guard let headEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
            let head = String(decoding: data[..<headEnd.lowerBound], as: UTF8.self)
            var lines = head.components(separatedBy: "\r\n")
            let requestLine = lines.removeFirst()
            let parts = requestLine.split(separator: " ")
            guard parts.count >= 2 else { return nil }
            var headers: [String: String] = [:]
            var contentLength = 0
            for line in lines {
                guard let colon = line.firstIndex(of: ":") else { continue }
                let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                headers[name] = value
                if name == "content-length" { contentLength = Int(value) ?? 0 }
            }
            let bodyData = data[headEnd.upperBound...]
            guard bodyData.count >= contentLength else { return nil }
            return (String(parts[0]), String(parts[1]), headers,
                    String(decoding: bodyData.prefix(contentLength), as: UTF8.self))
        }

        private func serve(_ conn: NWConnection, _ req: (method: String, path: String, headers: [String: String], body: String)) {
            lock.lock()
            requests.append(Recorded(method: req.method, path: req.path, headers: req.headers, body: req.body))
            var route = routes[req.path]
            let response: (status: Int, body: String)
            if let first = route?.first {
                response = first
                if route!.count > 1 { route!.removeFirst() }
                routes[req.path] = route
            } else {
                response = (404, "{\"error\":\"not_found\"}")
            }
            lock.unlock()

            let reasons = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 500: "Server Error"]
            let wire = "HTTP/1.1 \(response.status) \(reasons[response.status] ?? "X")\r\nContent-Type: application/json\r\nContent-Length: \(response.body.utf8.count)\r\nConnection: close\r\n\r\n\(response.body)"
            conn.send(content: Data(wire.utf8), completion: .contentProcessed { _ in conn.cancel() })
        }
    }

    // MARK: - Helpers

    private var tempDirs: [String] = []

    override func tearDown() {
        ClaudeDiscovery.shared.tokenEndpointOverride = nil
        for dir in tempDirs { try? FileManager.default.removeItem(atPath: dir) }
        tempDirs = []
        super.tearDown()
    }

    private func makeTempDir() throws -> String {
        let dir = NSTemporaryDirectory() + "th-oauth-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        tempDirs.append(dir)
        return dir
    }

    private func writeJSON(_ obj: [String: Any], to path: String, perm: Int = 0o600) throws {
        let data = try JSONSerialization.data(withJSONObject: obj)
        try data.write(to: URL(fileURLWithPath: path))
        try FileManager.default.setAttributes([.posixPermissions: perm], ofItemAtPath: path)
    }

    private func readJSON(_ path: String) -> [String: Any]? {
        guard let d = FileManager.default.contents(atPath: path) else { return nil }
        return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
    }

    /// Unsigned JWT good enough for expiry/account-claim parsing — the mock
    /// never validates signatures, same as production (API validates).
    private func makeJWT(exp: TimeInterval, accountId: String = "acct-1") -> String {
        func b64(_ s: String) -> String {
            Data(s.utf8).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        let payload = "{\"exp\":\(Int(exp)),\"https://api.openai.com/auth\":{\"chatgpt_account_id\":\"\(accountId)\"}}"
        return "\(b64("{\"alg\":\"RS256\"}")).\(b64(payload)).fakesig"
    }

    private func makeClaudeDir(access: String = "old-at", refresh: String = "old-rt",
                               expiresAtMs: Double = 0) throws -> String {
        let dir = try makeTempDir()
        try writeJSON([
            "claudeAiOauth": [
                "accessToken": access,
                "refreshToken": refresh,
                "expiresAt": expiresAtMs,
                "scopes": ["user:inference"],
            ] as [String: Any]
        ], to: "\(dir)/.credentials.json")
        return dir
    }

    // MARK: - Claude refresh

    func testClaudeRefresh_expiredFileCredentials_refreshesRotatesWritesBack() throws {
        let server = MockOAuthServer()
        try server.start(); defer { server.stop() }
        server.respond("/v1/oauth/token", status: 200,
                       body: #"{"access_token":"new-at","refresh_token":"new-rt","expires_in":28800}"#)

        let pastMs = (Date().timeIntervalSince1970 - 3600) * 1000
        let dir = try makeClaudeDir(access: "old-at", refresh: "old-rt", expiresAtMs: pastMs)

        let discovery = ClaudeDiscovery.shared
        discovery.tokenEndpointOverride = [server.url("/v1/oauth/token")]

        let token = discovery.findAccessToken(for: dir)
        XCTAssertEqual(token, "new-at")

        // Rotated credentials persisted back into the file the CLI reads.
        let oauth = (readJSON("\(dir)/.credentials.json")?["claudeAiOauth"]) as? [String: Any]
        XCTAssertEqual(oauth?["accessToken"] as? String, "new-at")
        XCTAssertEqual(oauth?["refreshToken"] as? String, "new-rt")
        let expiresAt = (oauth?["expiresAt"] as? NSNumber)?.doubleValue ?? 0
        XCTAssertGreaterThan(expiresAt, Date().timeIntervalSince1970 * 1000)
        // Sibling fields preserved.
        XCTAssertEqual((oauth?["scopes"] as? [String])?.first, "user:inference")
        // 0600 preserved through the atomic rewrite.
        let perm = (try FileManager.default.attributesOfItem(atPath: "\(dir)/.credentials.json"))[.posixPermissions] as? Int
        XCTAssertEqual(perm, 0o600)

        // Request shape matches the Anthropic refresh contract.
        XCTAssertEqual(server.recorded.count, 1)
        let req = server.recorded[0]
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.path, "/v1/oauth/token")
        XCTAssertEqual(req.headers["content-type"], "application/json")
        XCTAssertEqual(req.json?["grant_type"] as? String, "refresh_token")
        XCTAssertEqual(req.json?["refresh_token"] as? String, "old-rt")
        XCTAssertEqual(req.json?["client_id"] as? String, OAuthRefresh.claudeClientID)
    }

    func testClaudeRefresh_fallsBackToSecondEndpoint() throws {
        let server = MockOAuthServer()
        try server.start(); defer { server.stop() }
        server.respond("/v1/oauth/token", status: 200,
                       body: #"{"access_token":"fb-at","refresh_token":"fb-rt","expires_in":28800}"#)

        let dir = try makeClaudeDir(expiresAtMs: (Date().timeIntervalSince1970 - 60) * 1000)
        let discovery = ClaudeDiscovery.shared
        // First endpoint refused (nothing listens on :1) → second wins.
        discovery.tokenEndpointOverride = [URL(string: "http://127.0.0.1:1/v1/oauth/token")!,
                                         server.url("/v1/oauth/token")]

        XCTAssertEqual(discovery.findAccessToken(for: dir), "fb-at")
        XCTAssertEqual(server.recorded.count, 1)
    }

    func testClaudeRefresh_freshTokenSkipsNetwork() throws {
        let server = MockOAuthServer()
        try server.start(); defer { server.stop() }
        server.respond("/v1/oauth/token", status: 200,
                       body: #"{"access_token":"should-not-be-used","expires_in":1}"#)

        let dir = try makeClaudeDir(access: "fresh-at",
                                    expiresAtMs: (Date().timeIntervalSince1970 + 7200) * 1000)
        let discovery = ClaudeDiscovery.shared
        discovery.tokenEndpointOverride = [server.url("/v1/oauth/token")]

        XCTAssertEqual(discovery.findAccessToken(for: dir), "fresh-at")
        XCTAssertEqual(server.recorded.count, 0, "fresh token must not hit the token endpoint")
    }

    func testClaudeRefresh_invalidGrant_keepsStaleAndThrottles() throws {
        let server = MockOAuthServer()
        try server.start(); defer { server.stop() }
        server.respond("/v1/oauth/token", status: 400, body: #"{"error":"invalid_grant"}"#)

        let dir = try makeClaudeDir(access: "dead-at", refresh: "dead-rt",
                                    expiresAtMs: (Date().timeIntervalSince1970 - 60) * 1000)
        let discovery = ClaudeDiscovery.shared
        discovery.tokenEndpointOverride = [server.url("/v1/oauth/token")]

        XCTAssertEqual(discovery.findAccessToken(for: dir), "dead-at")
        XCTAssertEqual(discovery.findAccessToken(for: dir), "dead-at")
        XCTAssertEqual(server.recorded.count, 1,
                       "a rejected refresh must back off, not retry every poll")

        let oauth = (readJSON("\(dir)/.credentials.json")?["claudeAiOauth"]) as? [String: Any]
        XCTAssertEqual(oauth?["refreshToken"] as? String, "dead-rt", "failed refresh must not touch the store")
    }

    func testClaudeRefresh_raceGuard_adoptsCLIRotatedToken() throws {
        let dir = try makeClaudeDir(access: "old-at", refresh: "rt-1",
                                    expiresAtMs: (Date().timeIntervalSince1970 - 60) * 1000)
        let discovery = ClaudeDiscovery.shared
        guard let creds = discovery.readCredentials(for: dir) else {
            XCTFail("no credentials read")
            return
        }
        // CLI rotated between our read and our write-back.
        try writeJSON(["claudeAiOauth": ["accessToken": "cli-at", "refreshToken": "rt-2",
                                         "expiresAt": (Date().timeIntervalSince1970 + 28800) * 1000]],
                      to: "\(dir)/.credentials.json")

        let ours = OAuthRefresh.RefreshedTokens(accessToken: "our-at", refreshToken: "our-rt",
                                                expiresAt: Date().addingTimeInterval(28800), idToken: nil)
        let adopted = discovery.writeBackRefreshed(ours, to: creds)
        XCTAssertEqual(adopted, "cli-at", "must adopt the store's newer token, not resurrect ours")

        let oauth = (readJSON("\(dir)/.credentials.json")?["claudeAiOauth"]) as? [String: Any]
        XCTAssertEqual(oauth?["refreshToken"] as? String, "rt-2", "CLI rotation must survive")
        XCTAssertEqual(oauth?["accessToken"] as? String, "cli-at")
    }

    func testParseKeychainAccount() {
        let attrs = """
        keychain: "/Users/x/Library/Keychains/login.keychain-db"
        attributes:
            "acct"<blob>="benebsworth"
            "svce"<blob>="Claude Code-credentials"
        """
        XCTAssertEqual(ClaudeDiscovery.parseKeychainAccount(attrs), "benebsworth")
        XCTAssertNil(ClaudeDiscovery.parseKeychainAccount("no acct here"))
        XCTAssertNil(ClaudeDiscovery.parseKeychainAccount(nil))
    }

    // MARK: - Codex / OpenAI refresh

    private func makeCodexAuthFile(access: String, refresh: String = "rt.1.x",
                                   accountId: String = "acct-9") throws -> String {
        let dir = try makeTempDir()
        let path = "\(dir)/auth.json"
        try writeJSON([
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": NSNull(),
            "tokens": ["id_token": "id.tok", "access_token": access,
                       "refresh_token": refresh, "account_id": accountId],
            "last_refresh": "2026-09-01T00:00:00.000Z",
        ], to: path)
        return path
    }

    func testOpenAIAuth_prefersFresherSource() throws {
        let freshJWT = makeJWT(exp: Date().timeIntervalSince1970 + 100_000)
        let staleJWT = makeJWT(exp: Date().timeIntervalSince1970 - 100_000)
        let codexPath = try makeCodexAuthFile(access: freshJWT)

        let ocDir = try makeTempDir()
        let ocPath = "\(ocDir)/opencode-auth.json"
        try writeJSON(["openai": ["type": "oauth", "access": staleJWT, "refresh": "rt-oc",
                                  "expires": (Date().timeIntervalSince1970 - 1000) * 1000,
                                  "accountId": "acct-oc"]], to: ocPath)

        let auth = PlanLimitsEngine.openaiAuth(codexPaths: [codexPath], opencodePaths: [ocPath])
        XCTAssertEqual(auth?.source, .codexFile(path: codexPath), "fresher expiry must win")
        XCTAssertEqual(auth?.accountId, "acct-9")

        // Reverse: opencode fresh, codex stale → opencode wins.
        let ocFresh = "\(ocDir)/opencode-fresh.json"
        try writeJSON(["openai": ["access": freshJWT, "refresh": "rt-oc",
                                  "expires": (Date().timeIntervalSince1970 + 200_000) * 1000,
                                  "accountId": "acct-oc"]], to: ocFresh)
        let staleCodex = try makeCodexAuthFile(access: staleJWT)
        let auth2 = PlanLimitsEngine.openaiAuth(codexPaths: [staleCodex], opencodePaths: [ocFresh])
        XCTAssertEqual(auth2?.source, .opencodeFile(path: ocFresh))
    }

    func testCodexRefresh_expiredJWT_refreshesAndWritesBackCodexFormat() throws {
        let server = MockOAuthServer()
        try server.start(); defer { server.stop() }
        let newJWT = makeJWT(exp: Date().timeIntervalSince1970 + 700_000)
        server.respond("/oauth/token", status: 200,
                       body: "{\"access_token\":\"\(newJWT)\",\"refresh_token\":\"rt.2.y\",\"expires_in\":2419200,\"id_token\":\"new-id.tok\"}")

        let staleJWT = makeJWT(exp: Date().timeIntervalSince1970 - 1000)
        let path = try makeCodexAuthFile(access: staleJWT, refresh: "rt.1.x")

        guard let auth = PlanLimitsEngine.openaiAuth(codexPaths: [path], opencodePaths: []) else {
            XCTFail("no auth parsed")
            return
        }
        XCTAssertEqual(auth.source, .codexFile(path: path))

        let fresh = PlanLimitsEngine.ensureFreshOpenAIAuth(auth, endpointOverride: server.url("/oauth/token"))
        XCTAssertEqual(fresh.accessToken, newJWT)
        XCTAssertEqual(fresh.refreshToken, "rt.2.y")

        // File rewritten in Codex's format: tokens rotated, last_refresh bumped,
        // auth_mode preserved.
        let root = readJSON(path)
        XCTAssertEqual(root?["auth_mode"] as? String, "chatgpt")
        let tokens = root?["tokens"] as? [String: Any]
        XCTAssertEqual(tokens?["access_token"] as? String, newJWT)
        XCTAssertEqual(tokens?["refresh_token"] as? String, "rt.2.y")
        XCTAssertEqual(tokens?["id_token"] as? String, "new-id.tok")
        XCTAssertEqual(tokens?["account_id"] as? String, "acct-9")
        XCTAssertNotEqual(root?["last_refresh"] as? String, "2026-09-01T00:00:00.000Z")

        let req = server.recorded.first
        XCTAssertEqual(req?.json?["grant_type"] as? String, "refresh_token")
        XCTAssertEqual(req?.json?["refresh_token"] as? String, "rt.1.x")
        XCTAssertEqual(req?.json?["client_id"] as? String, OAuthRefresh.codexClientID)
    }

    func testCodexRefresh_opencodeEntry_writesBackMsExpiry() throws {
        let server = MockOAuthServer()
        try server.start(); defer { server.stop() }
        let newJWT = makeJWT(exp: Date().timeIntervalSince1970 + 700_000)
        server.respond("/oauth/token", status: 200,
                       body: "{\"access_token\":\"\(newJWT)\",\"refresh_token\":\"rt-oc-2\",\"expires_in\":3600}")

        let dir = try makeTempDir()
        let path = "\(dir)/auth.json"
        try writeJSON([
            "openai": ["type": "oauth", "access": makeJWT(exp: Date().timeIntervalSince1970 - 10),
                       "refresh": "rt-oc-1", "expires": 0, "accountId": "acct-oc"],
            "zai": ["key": "unrelated-provider-entry"],
        ], to: path)

        guard let auth = PlanLimitsEngine.openaiAuth(codexPaths: [], opencodePaths: [path]) else {
            XCTFail("no auth parsed")
            return
        }
        let fresh = PlanLimitsEngine.ensureFreshOpenAIAuth(auth, endpointOverride: server.url("/oauth/token"))
        XCTAssertEqual(fresh.accessToken, newJWT)

        let root = readJSON(path)
        let entry = root?["openai"] as? [String: Any]
        XCTAssertEqual(entry?["access"] as? String, newJWT)
        XCTAssertEqual(entry?["refresh"] as? String, "rt-oc-2")
        let expires = (entry?["expires"] as? NSNumber)?.doubleValue ?? 0
        XCTAssertGreaterThan(expires, Date().timeIntervalSince1970 * 1000)
        // Other providers untouched.
        XCTAssertEqual((root?["zai"] as? [String: Any])?["key"] as? String, "unrelated-provider-entry")
    }

    func testCodexRefresh_raceGuard_adoptsFileAuth() throws {
        let staleJWT = makeJWT(exp: Date().timeIntervalSince1970 - 1000)
        let path = try makeCodexAuthFile(access: staleJWT, refresh: "rt-1")
        guard let auth = PlanLimitsEngine.openaiAuth(codexPaths: [path], opencodePaths: []) else {
            XCTFail("no auth parsed")
            return
        }
        // CLI rotated first.
        let cliJWT = makeJWT(exp: Date().timeIntervalSince1970 + 500_000, accountId: "acct-9")
        try writeJSON([
            "tokens": ["access_token": cliJWT, "refresh_token": "rt-2", "account_id": "acct-9"],
            "last_refresh": "2026-09-22T00:00:00Z",
        ], to: path)

        let ours = OAuthRefresh.RefreshedTokens(accessToken: "our-at", refreshToken: "our-rt",
                                                expiresAt: Date().addingTimeInterval(3600), idToken: nil)
        let adopted = PlanLimitsEngine.writeBackOpenAI(ours, to: auth)
        XCTAssertEqual(adopted.accessToken, cliJWT)
        let tokens = readJSON(path)?["tokens"] as? [String: Any]
        XCTAssertEqual(tokens?["refresh_token"] as? String, "rt-2", "CLI rotation must survive")
    }

    func testCodexRefresh_failureKeepsStaleAuthAndThrottles() throws {
        let server = MockOAuthServer()
        try server.start(); defer { server.stop() }
        server.respond("/oauth/token", status: 400, body: #"{"error":"invalid_grant"}"#)

        let staleJWT = makeJWT(exp: Date().timeIntervalSince1970 - 1000)
        let path = try makeCodexAuthFile(access: staleJWT, refresh: "rt-dead")
        guard let auth = PlanLimitsEngine.openaiAuth(codexPaths: [path], opencodePaths: []) else {
            XCTFail("no auth parsed")
            return
        }
        let out1 = PlanLimitsEngine.ensureFreshOpenAIAuth(auth, endpointOverride: server.url("/oauth/token"))
        let out2 = PlanLimitsEngine.ensureFreshOpenAIAuth(auth, endpointOverride: server.url("/oauth/token"))
        XCTAssertEqual(out1.accessToken, staleJWT)
        XCTAssertEqual(out2.accessToken, staleJWT)
        XCTAssertEqual(server.recorded.count, 1, "rejected refresh must throttle")

        let tokens = readJSON(path)?["tokens"] as? [String: Any]
        XCTAssertEqual(tokens?["refresh_token"] as? String, "rt-dead")
    }

    // MARK: - wham/usage end to end

    func testWhamUsage_overLoopback_sendsAuthHeadersAndParsesLimits() throws {
        let server = MockOAuthServer()
        try server.start(); defer { server.stop() }
        server.respond("/backend-api/wham/usage", status: 200, body: """
        {
          "plan_type": "pro",
          "rate_limit": {
            "allowed": true,
            "limit_reached": false,
            "primary_window": {
              "used_percent": 17,
              "limit_window_seconds": 604800,
              "reset_at": 1788660440
            }
          },
          "additional_rate_limits": [
            {
              "limit_name": "GPT-5.3-Codex-Spark",
              "rate_limit": {
                "primary_window": {
                  "used_percent": 0,
                  "limit_window_seconds": 18000,
                  "reset_at": 1788098989
                }
              }
            }
          ]
        }
        """)

        let limits = PlanLimitsEngine.fetchWhamUsage(
            access: "live-at", accountId: "acct-9",
            baseURL: server.url("/backend-api/wham/usage").absoluteString)

        XCTAssertEqual(server.recorded.count, 1)
        let req = server.recorded[0]
        XCTAssertEqual(req.method, "GET")
        XCTAssertEqual(req.headers["authorization"], "Bearer live-at")
        XCTAssertEqual(req.headers["chatgpt-account-id"], "acct-9")

        let primary = limits.first { $0.label == "7d" }
        XCTAssertNotNil(primary)
        XCTAssertEqual(primary?.provider, "codex")
        XCTAssertEqual(primary?.usedPercent ?? -1, 17)
        XCTAssertEqual(primary?.detail, "83% left")

        let spark = limits.first { $0.label == "gpt-5.3-codex-spark 5h" }
        XCTAssertNotNil(spark)
        XCTAssertEqual(spark?.usedPercent ?? -1, 0)
    }

    // MARK: - Pure helpers

    func testNeedsRefresh_windowBoundaries() {
        let now = Date()
        XCTAssertTrue(OAuthRefresh.needsRefresh(expiresAt: now.addingTimeInterval(-1), now: now))
        XCTAssertTrue(OAuthRefresh.needsRefresh(expiresAt: now.addingTimeInterval(200), now: now),
                      "inside the 5-minute skew must refresh early")
        XCTAssertFalse(OAuthRefresh.needsRefresh(expiresAt: now.addingTimeInterval(3600), now: now))
        XCTAssertFalse(OAuthRefresh.needsRefresh(expiresAt: nil, now: now))
    }

    func testJWTExpiryAndAccountClaim() {
        let exp = Date().timeIntervalSince1970 + 1234
        let jwt = makeJWT(exp: exp, accountId: "acct-42")
        XCTAssertEqual(OAuthRefresh.jwtExpiry(jwt)?.timeIntervalSince1970 ?? -1, exp, accuracy: 1)
        XCTAssertEqual(PlanLimitsEngine.chatgptAccountID(fromJWT: jwt), "acct-42")
        XCTAssertNil(OAuthRefresh.jwtExpiry("not-a-jwt"))
        XCTAssertEqual(PlanLimitsEngine.chatgptAccountID(fromJWT: "not-a-jwt"), "")
    }
}
