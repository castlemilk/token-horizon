import Foundation

/// Routes supported by the main web app. Keep links here so every native
/// surface opens the same destination and respects a configured cloud host.
enum WebDestination: CaseIterable {
    case workspace, leaderboard, models, profile, claimHandle, teams, webSettings, signIn

    static let defaultBaseURL = "https://token-horizon.dev"

    func url(baseURL: String = defaultBaseURL, handle: String = "") -> URL {
        var components = Self.baseComponents(baseURL)
        let profileHandle = handle.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "^@", with: "", options: .regularExpression)
        var route = "leaderboard"
        var query: [URLQueryItem] = []

        switch self {
        case .workspace, .signIn:
            // The workspace discovers profiles owned by a remembered browser
            // account when no handle is supplied. Signed-out visitors see its
            // existing sign-in CTA; browser auth does not authorize native sync.
            query.append(URLQueryItem(name: "view", value: "dashboard"))
            if !profileHandle.isEmpty { query.append(URLQueryItem(name: "user", value: profileHandle)) }
            if self == .signIn { query.append(URLQueryItem(name: "signin", value: "1")) }
        case .leaderboard:
            break
        case .models:
            // /models is the canonical catalog route, including on custom hosts.
            route = "models"
        case .profile:
            if profileHandle.isEmpty {
                query.append(URLQueryItem(name: "view", value: "dashboard"))
            } else if profileHandle == "." || profileHandle == ".." {
                // Browsers normalize dot path segments even when escaped.
                // The existing query route preserves these unusual handles.
                query.append(URLQueryItem(name: "view", value: "players"))
                query.append(URLQueryItem(name: "user", value: profileHandle))
            } else {
                route = "u/" + Self.pathComponent(profileHandle)
            }
        case .claimHandle:
            let target = profileHandle.trimmingCharacters(in: .whitespacesAndNewlines)
            if target.isEmpty {
                query.append(URLQueryItem(name: "view", value: "dashboard"))
            } else {
                // Open the manual claim dialog after remembered browser auth
                // hydrates. Anonymous write credentials never enter this URL.
                query.append(URLQueryItem(name: "view", value: "players"))
                query.append(URLQueryItem(name: "user", value: target))
                query.append(URLQueryItem(name: "claim", value: "1"))
            }
        case .teams:
            // This page provides the authenticated team-management modal. A local
            // team label is not proof of membership and is not passed as a filter.
            query.append(URLQueryItem(name: "view", value: "teams"))
        case .webSettings:
            query.append(URLQueryItem(name: "view", value: "settings"))
            if !profileHandle.isEmpty { query.append(URLQueryItem(name: "user", value: profileHandle)) }
        }

        components.percentEncodedPath += "/" + route
        components.queryItems = query.isEmpty ? nil : query
        // The base and routes above are validated and encoded independently.
        return components.url!
    }

    private static func baseComponents(_ raw: String) -> URLComponents {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var components = URLComponents(string: trimmed)
        if !["http", "https"].contains(components?.scheme?.lowercased() ?? "")
            || components?.host?.isEmpty != false || components?.url == nil {
            components = URLComponents(string: defaultBaseURL)
        }
        var base = components!
        // Settings may contain the legacy JSON endpoint. Retain any deployment
        // prefix while removing a known endpoint suffix. Do not carry API query
        // parameters, fragments, or URL credentials into a browser link.
        var path = base.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        for suffix in ["/api/leaderboard", "/leaderboard", "/models", "/login", "/api"] where path.hasSuffix(suffix) {
            path.removeLast(suffix.count)
            break
        }
        base.percentEncodedPath = path
        base.query = nil
        base.fragment = nil
        base.user = nil
        base.password = nil
        return base
    }

    private static func pathComponent(_ handle: String) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        return handle.addingPercentEncoding(withAllowedCharacters: allowed)!
    }
}
