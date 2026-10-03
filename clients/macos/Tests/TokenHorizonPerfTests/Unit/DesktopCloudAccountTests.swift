import CryptoKit
import Foundation
import XCTest
@testable import TokenHorizon

final class DesktopCloudAccountTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let endpoint = URL(string: "https://board.example/api/leaderboard")!
    private let token = "thd_" + String(repeating: "a", count: 64)

    private final class Storage {
        var data: Data?
        var writes = 0
        var fails = false
        init(_ data: Data? = nil) { self.data = data }
        func write(_ data: Data?) throws {
            writes += 1
            if fails { throw NSError(domain: "KeychainTest", code: -1) }
            self.data = data
        }
    }

    private func account(handle: String = "ben", endpoint: String = "https://board.example/api/leaderboard",
                         token: String? = nil, expiresAt: Date? = nil) -> DesktopCloudAccount {
        DesktopCloudAccount(endpoint: endpoint, handle: handle, accessToken: token ?? self.token,
            expiresAt: expiresAt ?? now.addingTimeInterval(3600),
            user: DesktopCloudAccount.User(provider: "google", sub: "verified-user", name: "Ben",
                                          email: nil, picture: nil, login: nil))
    }

    private func store(_ storage: Storage) -> DesktopCloudAccountStore {
        DesktopCloudAccountStore(read: { storage.data }, write: storage.write)
    }

    private func response() -> [String: Any] {
        ["accessToken": token, "handle": "BEN", "expiresAt": now.addingTimeInterval(3600).timeIntervalSince1970 * 1000,
         "user": ["provider": "google", "sub": "verified-user", "name": "Ben"]]
    }

    func testAuthRoutesRetainDeploymentPrefixAndAcceptLegacyPublishEndpoint() {
        for path in ["/api/leaderboard", "/leaderboard", "/api/leaderboard/"] {
            XCTAssertEqual(CloudSignInController.authURL(endpoint: URL(string: "https://board.example" + path)!, action: "start").absoluteString,
                           "https://board.example/api/desktop/start")
        }
        for path in ["/team/api/leaderboard", "/team/leaderboard"] {
            XCTAssertEqual(CloudSignInController.authURL(endpoint: URL(string: "https://board.example" + path)!, action: "revoke").absoluteString,
                           "https://board.example/team/api/desktop/revoke")
        }
    }

    func testSavedCredentialRoundTripsAndBindsToEndpointAndHandle() throws {
        let storage = Storage()
        let first = store(storage)
        try first.save(account(endpoint: "https://BOARD.example:443/team/api/leaderboard/"))
        XCTAssertEqual(storage.writes, 1)
        let restored = store(storage)
        XCTAssertEqual(restored.account(baseURL: "https://board.example/team", handle: " @BEN ", now: now)?.accessToken, token)
        let distinct: [(String, String)] = [
            ("https://other.example/team", "ben"), ("http://board.example/team", "ben"),
            ("https://board.example:8443/team", "ben"), ("https://board.example", "ben"),
            ("https://board.example/team", "another"), ("https://board.example/team", "")
        ]
        for (base, handle) in distinct {
            XCTAssertNil(restored.account(baseURL: base, handle: handle, now: now), "\(base) \(handle)")
        }
    }

    func testExpiryRequiresMoreThanThirtySecondsRemaining() throws {
        let storage = Storage()
        let saved = store(storage)
        for seconds in [-1.0, 0, 29, 30, 31] {
            try saved.save(account(expiresAt: now.addingTimeInterval(seconds)))
            XCTAssertEqual(saved.account(baseURL: "https://board.example", handle: "ben", now: now) != nil,
                           seconds > 30, "Remaining lifetime: \(seconds)")
        }
    }

    func testInvalidSavedCredentialCannotAuthorizePublication() throws {
        for value in [Data("bad-json".utf8),
                      try JSONEncoder().encode(account(token: "provider-token")),
                      try JSONEncoder().encode(account(token: "thd_invalid")),
                      try JSONEncoder().encode(account(endpoint: "file:///tmp/profile"))] {
            let restored = store(Storage(value))
            XCTAssertNil(restored.account(baseURL: "https://board.example", handle: "ben", now: now))
            XCTAssertNil(restored.account(baseURL: "https://board.example", handle: "", now: now))
        }
    }

    func testFailedKeychainSavePreservesPreviousCredential() throws {
        let storage = Storage()
        let saved = store(storage)
        try saved.save(account())
        let previous = storage.data
        storage.fails = true
        XCTAssertThrowsError(try saved.save(account(handle: "another", token: "thd_" + String(repeating: "b", count: 64))))
        XCTAssertEqual(storage.data, previous)
        XCTAssertEqual(saved.account(baseURL: "https://board.example", handle: "ben", now: now)?.accessToken, token)
        XCTAssertNil(saved.account(baseURL: "https://board.example", handle: "another", now: now))
    }

    func testInvalidationOnlyClearsTheRejectedCredential() throws {
        let storage = Storage()
        let saved = store(storage)
        try saved.save(account())
        saved.invalidate(accessToken: "old-token")
        XCTAssertEqual(storage.writes, 1)
        XCTAssertNotNil(saved.account(baseURL: "https://board.example", handle: "ben", now: now))
        saved.invalidate(accessToken: token)
        XCTAssertEqual(storage.writes, 2)
        XCTAssertNil(storage.data)
        XCTAssertNil(saved.account(baseURL: "https://board.example", handle: "ben", now: now))
    }

    func testRejectedCredentialStopsWorkingEvenWhenKeychainDeletionFails() throws {
        let storage = Storage()
        let saved = store(storage)
        try saved.save(account())
        storage.fails = true
        saved.invalidate(accessToken: token)
        XCTAssertNil(saved.account(baseURL: "https://board.example", handle: "ben", now: now))
    }

    func testExplicitSignOutReportsKeychainFailureAndCanRetry() throws {
        let storage = Storage()
        let saved = store(storage)
        try saved.save(account())
        storage.fails = true
        XCTAssertThrowsError(try saved.clear())
        XCTAssertNotNil(saved.account(baseURL: "https://board.example", handle: "ben", now: now))
        storage.fails = false
        try saved.clear()
        XCTAssertNil(storage.data)
        XCTAssertNil(saved.account(baseURL: "https://board.example", handle: "ben", now: now))
    }

    func testPKCEEncodingMatchesRFC7636Challenge() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        let challenge = CloudSignInController.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        XCTAssertEqual(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(CloudSignInController.base64URL(Data([0xfb, 0xff, 0xff])), "-___")
        XCTAssertEqual(CloudSignInController.base64URL(Data(repeating: 0, count: 32)).count, 43)
    }

    func testSignInLinksRequireSecureSameOriginWithoutURLCredentials() {
        let valid = URL(string: "https://board.example/connect?desktop=transaction")!
        XCTAssertTrue(CloudSignInController.isAuthorizationURL(valid, endpoint: endpoint))
        let invalid = [
            "https://other.example/connect", "http://board.example/connect",
            "https://board.example:8443/connect", "https://user:secret@board.example/connect",
            "https://board.example/connect#fragment", "https://board.example/login"
        ]
        for raw in invalid {
            XCTAssertFalse(CloudSignInController.isAuthorizationURL(URL(string: raw)!, endpoint: endpoint), raw)
        }
        let loopback = URL(string: "http://127.0.0.1:8787/api/leaderboard")!
        XCTAssertTrue(CloudSignInController.isAuthorizationURL(URL(string: "http://127.0.0.1:8787/connect")!, endpoint: loopback))
        XCTAssertTrue(CloudSignInController.isSecure(URL(string: "http://localhost:8787/connect")!))
        XCTAssertFalse(CloudSignInController.isSecure(URL(string: "http://board.example/connect")!))
        XCTAssertFalse(CloudSignInController.isSecure(URL(string: "file:///tmp/connect")!))
    }

    func testExchangeResponseCreatesBoundCredentialAndNormalizesHandle() throws {
        let parsed = try CloudSignInController.account(from: response(), endpoint: endpoint, now: now)
        XCTAssertEqual(parsed.endpoint, endpoint.absoluteString)
        XCTAssertEqual(parsed.handle, "ben")
        XCTAssertEqual(parsed.accessToken, token)
        XCTAssertEqual(parsed.expiresAt, now.addingTimeInterval(3600))
        XCTAssertEqual(parsed.user.provider, "google")
        XCTAssertEqual(parsed.user.sub, "verified-user")
        var github = response()
        github["user"] = ["provider": "github", "sub": "github-user", "login": "octocat"]
        XCTAssertEqual(try CloudSignInController.account(from: github, endpoint: endpoint, now: now).user.provider, "github")
    }

    func testExchangeRejectsMalformedOrExpiredCredentialsAndIdentity() {
        let mutations: [(String, Any)] = [
            ("accessToken", "thd_invalid"), ("accessToken", "thd_" + String(repeating: "A", count: 64)),
            ("accessToken", "provider-token"), ("accessToken", token + "\nsecret"),
            ("handle", ""), ("handle", "."), ("handle", ".."), ("handle", "@ben"),
            ("handle", "ben/other"), ("handle", "ben\nother"), ("handle", String(repeating: "b", count: 65)),
            ("expiresAt", now.addingTimeInterval(30).timeIntervalSince1970 * 1000),
            ("expiresAt", now.addingTimeInterval(-1).timeIntervalSince1970 * 1000),
            ("expiresAt", "future"),
            ("user", ["provider": "unknown", "sub": "verified-user"]),
            ("user", ["provider": "google", "sub": ""]),
            ("user", ["provider": "google"]), ("user", "invalid"), ("user", NSNull())
        ]
        for (key, value) in mutations {
            var invalid = response()
            invalid[key] = value
            XCTAssertThrowsError(try CloudSignInController.account(from: invalid, endpoint: endpoint, now: now), key)
        }
    }
}
