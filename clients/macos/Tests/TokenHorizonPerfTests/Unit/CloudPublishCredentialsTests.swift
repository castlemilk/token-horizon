import XCTest
@testable import TokenHorizon

final class CloudPublishCredentialsTests: XCTestCase {
    private struct Entry: Encodable {
        var handle = "ben"
        var tokensAll = 42
        var updatedAt = Date(timeIntervalSince1970: 1234)
        var claimToken: String? = nil
    }

    private func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    func testAPIEndpointResolution() {
        let cases: [(String, String?)] = [
            ("https://board.example", "https://board.example/api/leaderboard"),
            ("https://board.example/leaderboard/", "https://board.example/leaderboard"),
            ("http://localhost:8787/team/api/", "http://localhost:8787/team/api/leaderboard"),
            ("https://board.example/team/api/leaderboard?token=secret#ignored", "https://board.example/team/api/leaderboard"),
            ("file:///tmp/board", nil), ("https://user:secret@board.example", nil), ("board.example", nil)
        ]
        for (base, expected) in cases {
            XCTAssertEqual(CloudPublishCredentials.endpointURL(baseURL: base)?.absoluteString, expected, base)
        }
    }

    func testCredentialKeysNormalizeOnlyEquivalentEndpointAndHandle() {
        let key = CloudPublishCredentials.storageKey(endpoint: URL(string: "https://board.example/api/leaderboard")!, handle: "ben")
        XCTAssertNotNil(key)
        XCTAssertEqual(key, CloudPublishCredentials.storageKey(endpoint: URL(string: "HTTPS://BOARD.EXAMPLE:443/api/leaderboard/")!, handle: " @Ben "))
        let distinct: [(String, String)] = [
            ("https://other.example/api/leaderboard", "ben"),
            ("http://board.example/api/leaderboard", "ben"),
            ("https://board.example:8443/api/leaderboard", "ben"),
            ("https://board.example/team/api/leaderboard", "ben"),
            ("https://board.example/api/leaderboard", "other"),
            ("https://board.example/api/leaderboard", "ben\nother")
        ]
        for (endpoint, handle) in distinct {
            XCTAssertNotEqual(key, CloudPublishCredentials.storageKey(endpoint: URL(string: endpoint)!, handle: handle), endpoint)
        }
        XCTAssertNil(CloudPublishCredentials.storageKey(endpoint: URL(string: "file:///tmp/board")!, handle: "ben"))
        XCTAssertNil(CloudPublishCredentials.storageKey(endpoint: URL(string: "https://board.example")!, handle: " "))
    }

    func testStoredCredentialMapRoundTripsWithoutSharingAcrossProfilesOrHosts() throws {
        let first = CloudPublishCredentials.storageKey(endpoint: URL(string: "https://a.example/api/leaderboard")!, handle: "ben")!
        let second = CloudPublishCredentials.storageKey(endpoint: URL(string: "https://b.example/api/leaderboard")!, handle: "ben")!
        let third = CloudPublishCredentials.storageKey(endpoint: URL(string: "https://a.example/api/leaderboard")!, handle: "other")!
        let map = [first: "original-secret"]
        let restored = try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(map))
        XCTAssertEqual(restored[first], "original-secret")
        XCTAssertNil(restored[second])
        XCTAssertNil(restored[third])
    }

    func testPublishBodyPreservesUsageAndDateAndAddsOnlyProvidedCredential() throws {
        for token in [nil, "", "  ", "saved-secret", " saved-secret ", "bad\nsecret"] as [String?] {
            let body = try CloudPublishCredentials.requestBody(entry: Entry(claimToken: "untrusted-entry-field"), claimToken: token)
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(payload["handle"] as? String, "ben")
            XCTAssertEqual(payload["tokensAll"] as? Int, 42)
            XCTAssertEqual(payload["updatedAt"] as? Double, 1234)
            XCTAssertEqual(payload["claimToken"] as? String, CloudPublishCredentials.validatedToken(token))
        }
    }

    func testCaptureRequiresSuccessfulBoundedResponseForRequestProfile() throws {
        let cases: [([String: Any], String?)] = [
            (["ok": true, "handle": "ben", "claimToken": "issued-secret"], "issued-secret"),
            (["ok": true, "handle": "@BEN", "claimToken": " issued-secret "], "issued-secret"),
            (["ok": true, "handle": "other", "claimToken": "wrong-profile-secret"], nil),
            (["ok": false, "handle": "ben", "claimToken": "error-secret"], nil),
            (["ok": 1, "handle": "ben", "claimToken": "non-boolean-ok-secret"], nil),
            (["ok": "true", "handle": "ben", "claimToken": "string-ok-secret"], nil),
            (["handle": "ben", "claimToken": "missing-ok-secret"], nil),
            (["ok": true, "claimToken": "missing-handle-secret"], nil),
            (["ok": true, "handle": "ben", "claimToken": NSNull()], nil),
            (["ok": true, "handle": "ben", "claimToken": "bad\nsecret"], nil),
            (["ok": true, "handle": "ben", "claimToken": String(repeating: "s", count: 4097)], nil)
        ]
        for (response, expected) in cases {
            XCTAssertEqual(CloudPublishCredentials.responseClaimToken(data: try json(response), expectedHandle: "ben"), expected)
        }
        XCTAssertNil(CloudPublishCredentials.responseClaimToken(data: Data("bad-json".utf8), expectedHandle: "ben"))
        XCTAssertNil(CloudPublishCredentials.responseClaimToken(data: try json(["ok": true, "handle": "ben", "claimToken": "issued", "extra": String(repeating: "x", count: 65536)]), expectedHandle: "ben"))
        XCTAssertNil(CloudPublishCredentials.responseClaimToken(data: nil, expectedHandle: "ben"))
    }

    func testFailureMessagesExplainOwnershipWithoutEchoingServerSecrets() throws {
        let anonymous = CloudPublishCredentials.failureMessage(statusCode: 403, data: try json(["error": "Profile @sensitive created anonymously. Provide your claim token sensitive-secret."]))
        XCTAssertTrue(anonymous.contains("anonymous profile"))
        XCTAssertTrue(anonymous.contains("original claim token"))
        let claimed = CloudPublishCredentials.failureMessage(statusCode: 403, data: try json(["error": "Profile @sensitive is claimed by a verified account. Sign in as the owner to publish updates. sensitive-secret"]))
        XCTAssertTrue(claimed.contains("linked to a web account"))
        for message in [anonymous, claimed,
                        CloudPublishCredentials.failureMessage(statusCode: 403, data: try json(["error": "sensitive-secret"])),
                        CloudPublishCredentials.failureMessage(statusCode: 401, data: try json(["error": "sensitive-secret"])),
                        CloudPublishCredentials.failureMessage(statusCode: 500, data: try json(["error": "sensitive-secret"]))] {
            XCTAssertFalse(message.contains("sensitive"))
        }
        XCTAssertTrue(CloudPublishCredentials.failureMessage(statusCode: 307, data: nil).contains("final cloud URL"))
    }
}
