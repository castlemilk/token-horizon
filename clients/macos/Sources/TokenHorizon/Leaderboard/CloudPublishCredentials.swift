import Foundation

/// Anonymous publishing credentials stay separate from public leaderboard
/// entries. These pure helpers are also used by SettingsStore's private map.
enum CloudPublishCredentials {
    static func endpointURL(baseURL: String) -> URL? {
        guard var url = URLComponents(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              url.host?.isEmpty == false, url.user == nil, url.password == nil else { return nil }
        var path = url.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        if !path.hasSuffix("/leaderboard") {
            path += path.hasSuffix("/api") ? "/leaderboard" : "/api/leaderboard"
        }
        url.percentEncodedPath = path
        url.query = nil
        url.fragment = nil
        return url.url
    }

    static func effectiveHandle(_ raw: String) -> String {
        var handle = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if handle.hasPrefix("@") { handle.removeFirst() }
        return handle.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func storageKey(endpoint: URL, handle: String) -> String? {
        let identity = effectiveHandle(handle)
        guard !identity.isEmpty,
              var url = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              url.host?.isEmpty == false, url.user == nil, url.password == nil else { return nil }
        url.scheme = url.scheme?.lowercased()
        url.host = url.host?.lowercased()
        if (url.scheme == "https" && url.port == 443) || (url.scheme == "http" && url.port == 80) { url.port = nil }
        var path = url.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        url.percentEncodedPath = path
        url.query = nil
        url.fragment = nil
        guard let normalized = url.url?.absoluteString,
              let bytes = try? JSONSerialization.data(withJSONObject: [normalized, identity]),
              let key = String(data: bytes, encoding: .utf8) else { return nil }
        return key
    }

    static func validatedToken(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty, token.utf8.count <= 4096,
              !token.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
        return token
    }

    static func requestBody<Entry: Encodable>(entry: Entry, claimToken: String?) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        let encoded = try encoder.encode(entry)
        guard var payload = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            throw NSError(domain: "TokenHorizon", code: 500,
                          userInfo: [NSLocalizedDescriptionKey: "Failed to serialize entry JSON."])
        }
        // Never allow a credential-bearing field from an entry/snapshot to win.
        payload.removeValue(forKey: "claimToken")
        if let token = validatedToken(claimToken) { payload["claimToken"] = token }
        return try JSONSerialization.data(withJSONObject: payload)
    }

    static func responseClaimToken(data: Data?, expectedHandle: String) -> String? {
        guard let data, !data.isEmpty, data.count <= 65536,
              let response = try? JSONDecoder().decode(PublishResponse.self, from: data), response.ok,
              effectiveHandle(response.handle) == effectiveHandle(expectedHandle),
              !effectiveHandle(expectedHandle).isEmpty else { return nil }
        return validatedToken(response.claimToken)
    }

    static func failureMessage(statusCode: Int, data: Data?) -> String {
        switch statusCode {
        case 401:
            return "Your saved cloud connection was rejected. Click Sync now to sign in and reconnect."
        case 403:
            // Classify bounded known server phrases; never echo arbitrary
            // response text, profile handles, tokens, or upstream diagnostics.
            let raw = responseObject(data)?["error"] as? String ?? ""
            let error = raw.utf8.count <= 2048 ? raw.lowercased() : ""
            if error.contains("claim token") || error.contains("created anonymously") {
                return "This anonymous profile needs its original claim token. Connect from the Mac that created it, restore the token in Advanced connection, or choose a new handle when signing in."
            }
            if error.contains("is claimed by a verified account") || error.contains("sign in as the owner") {
                return "This profile is linked to a web account. Click Sync now and sign in as its owner, or choose a different handle."
            }
            return "This profile is protected. Click Sync now to sign in as its owner, or choose a different handle."
        case 300..<400:
            return "Cloud redirected this publish. Set the final cloud URL in Advanced connection and try again."
        default:
            return "Cloud publish returned HTTP \(statusCode). Try Sync now again."
        }
    }

    private static func responseObject(_ data: Data?) -> [String: Any]? {
        guard let data, !data.isEmpty, data.count <= 65536 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private struct PublishResponse: Decodable {
        let ok: Bool
        let handle: String
        let claimToken: String?
    }
}

/// A redirect can resend a POST body to another host even after Foundation
/// removes its Authorization header. Claim tokens must remain on their endpoint.
final class CloudPublishRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
