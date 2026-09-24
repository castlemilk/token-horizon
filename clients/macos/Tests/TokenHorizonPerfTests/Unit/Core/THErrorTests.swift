import XCTest
@testable import TokenHorizon

/// Tests for the context-chained error type (`THError`).
final class THErrorTests: XCTestCase {

    struct Boom: Error, CustomStringConvertible {
        var description: String { "boom" }
    }

    func testBareError_describesItsContext() {
        XCTAssertEqual(String(describing: THError("loading sessions")), "loading sessions")
    }

    func testWrappedError_printsNewestFirst() {
        let err = THError("opening file", underlying: Boom()).wrapping("scanning codex dir")
        XCTAssertEqual(String(describing: err), "scanning codex dir: opening file: boom")
    }

    func testThreeDeepChain_preservesOrder() {
        let err = THError("l1", underlying: THError("l2", underlying: THError("l3")))
        XCTAssertEqual(String(describing: err), "l1: l2: l3")
    }

    func testUnderlying_isMatchableByType() {
        // The errors.As analogue: callers match the TYPED cause, never the string.
        let err: Error = THError("fetching limits", underlying: Boom())
        let typed = err as? THError
        XCTAssertNotNil(typed)
        XCTAssertTrue(typed?.underlying is Boom)
        XCTAssertEqual(typed?.context, "fetching limits")
    }
}
