import XCTest
@testable import TokenHorizon

final class WidgetDeepLinkTests: XCTestCase {
    func testWidgetActionsRouteToHostApp() {
        XCTAssertEqual(WidgetDeepLink.action(.sync).absoluteString, "tokenhorizon://sync")
        XCTAssertEqual(WidgetDeepLink.action(.signIn).absoluteString, "tokenhorizon://signin")
        for action in WidgetDeepLink.Action.allCases {
            XCTAssertEqual(WidgetDeepLink.action(from: WidgetDeepLink.action(action)), action)
        }
        XCTAssertEqual(WidgetDeepLink.action(from: URL(string: "TOKENHORIZON://SIGNIN/")!), .signIn)
    }

    func testActionParserLeavesNavigationAndUnrelatedURLsAlone() {
        let navigation = [WidgetDeepLink.window("hours"), WidgetDeepLink.page(1),
                          WidgetDeepLink.page(-1), URL(string: "tokenhorizon://dashboard")]
        for url in navigation.compactMap({ $0 }) {
            XCTAssertNil(WidgetDeepLink.action(from: url))
        }
        for raw in ["https://sync", "tokenhorizon://unknown", "tokenhorizon://sync/nested",
                    "tokenhorizon://signin?token=private", "tokenhorizon://sync#ignored",
                    "tokenhorizon://user:password@sync", "tokenhorizon://sync:8765"] {
            XCTAssertNil(WidgetDeepLink.action(from: URL(string: raw)!))
        }
    }
}
