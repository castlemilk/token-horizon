import XCTest
@testable import TokenHorizon

final class WebDestinationTests: XCTestCase {
    func testCanonicalRoutes() {
        let routes: [(WebDestination, String)] = [
            (.workspace, "https://token-horizon.dev/leaderboard?view=dashboard&user=ben"),
            (.leaderboard, "https://token-horizon.dev/leaderboard"),
            (.models, "https://token-horizon.dev/models"),
            (.profile, "https://token-horizon.dev/u/ben"),
            (.claimHandle, "https://token-horizon.dev/leaderboard?view=players&user=ben&claim=1"),
            (.teams, "https://token-horizon.dev/leaderboard?view=teams"),
            (.webSettings, "https://token-horizon.dev/leaderboard?view=settings&user=ben"),
            (.signIn, "https://token-horizon.dev/leaderboard?view=dashboard&user=ben&signin=1")
        ]
        for (destination, expected) in routes {
            XCTAssertEqual(destination.url(handle: " @ben ").absoluteString, expected, "\(destination)")
        }
    }

    func testMissingProfileHandleOpensOwnedWorkspaceWithoutForcingSignIn() {
        XCTAssertEqual(WebDestination.profile.url(handle: "  "), WebDestination.workspace.url())
        let components = URLComponents(url: WebDestination.profile.url(), resolvingAgainstBaseURL: false)!
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "view", value: "dashboard")])
    }

    func testCustomCloudHostsAndDeploymentPrefixes() {
        let bases = [
            "https://board.example",
            "https://board.example/",
            "https://board.example/leaderboard",
            "https://board.example/api",
            "https://board.example/api/leaderboard/"
        ]
        for base in bases {
            XCTAssertEqual(WebDestination.models.url(baseURL: base).absoluteString, "https://board.example/models", base)
        }
        XCTAssertEqual(WebDestination.profile.url(baseURL: "http://localhost:8787/team/api/leaderboard?secret=hidden#ignored", handle: "ben").absoluteString,
                       "http://localhost:8787/team/u/ben")
        XCTAssertEqual(WebDestination.models.url(baseURL: "https://board.example/a%20b/").absoluteString,
                       "https://board.example/a%20b/models")
    }

    func testUnsupportedOrMissingBaseSchemeFallsBackToCanonicalHost() {
        for base in ["", "board.example", "file:///tmp/board", "javascript:alert(1)", "https:///", "tokenhorizon://dashboard"] {
            XCTAssertEqual(WebDestination.models.url(baseURL: base), WebDestination.models.url(), base)
        }
        XCTAssertEqual(WebDestination.leaderboard.url(baseURL: "https://user:password@board.example?secret=hidden#ignored").absoluteString,
                       "https://board.example/leaderboard")
    }

    func testProfileHandleCannotInjectPathQueryOrFragment() {
        for handle in ["name/other", "name?view=settings", "name#section", "name&signin=1", "name%2Fother", "名字"] {
            let url = WebDestination.profile.url(handle: handle)
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            XCTAssertNil(components.query, handle)
            XCTAssertNil(components.fragment, handle)
            let encodedHandle = String(components.percentEncodedPath.dropFirst("/u/".count))
            XCTAssertFalse(encodedHandle.contains("/"), handle)
            XCTAssertEqual(encodedHandle.removingPercentEncoding, handle)
        }
    }

    func testDotHandlesUseExistingQueryRouteToAvoidBrowserPathNormalization() {
        for handle in [".", ".."] {
            let components = URLComponents(url: WebDestination.profile.url(handle: handle), resolvingAgainstBaseURL: false)!
            XCTAssertEqual(components.path, "/leaderboard")
            XCTAssertEqual(components.queryItems, [URLQueryItem(name: "view", value: "players"), URLQueryItem(name: "user", value: handle)])
        }
    }

    func testWorkspaceHandleCannotInjectQueryFields() {
        let url = WebDestination.workspace.url(handle: "ben&signin=1#ignored")
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "view", value: "dashboard"), URLQueryItem(name: "user", value: "ben&signin=1#ignored")])
        XCTAssertNil(components.fragment)
    }

    func testClaimTargetsExactHandleWithoutCredentialsOrInjectedActions() {
        let target = "name/other&signin=1#part"
        let url = WebDestination.claimHandle.url(baseURL: "https://board.example/team/api?token=private#ignored", handle: target)
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        XCTAssertEqual(components.path, "/team/leaderboard")
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "view", value: "players"),
                                              URLQueryItem(name: "user", value: target), URLQueryItem(name: "claim", value: "1")])
        XCTAssertNil(components.fragment)
        XCTAssertFalse(url.absoluteString.contains("private"))
        XCTAssertFalse(url.absoluteString.contains("claimToken"))
        XCTAssertEqual(WebDestination.claimHandle.url(handle: " @ "), WebDestination.workspace.url())
    }
}
