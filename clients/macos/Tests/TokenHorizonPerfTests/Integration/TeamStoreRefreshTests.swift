import Combine
import Foundation
import XCTest
@testable import TokenHorizon

/// Exercises the real asynchronous refresh state machine through URLSession.
/// Each test owns its transport, clock and leaderboard rows; no singleton,
/// live account or machine preferences participate.
final class TeamStoreRefreshTests: XCTestCase {
    private let teamId = "maxxers-test-membership"

    private func localEntries() -> [LeaderboardEntry] {
        ["ben", "akshay"].map { handle in
            LeaderboardEntry(id: "local:\(handle)", handle: handle, team: "maxxers", teamId: teamId,
                             tokensToday: 10, tokens7d: 100, tokensAll: 200,
                             costToday: 0, cost7d: 0, costAll: 0, streakDays: 0,
                             topModel: "m", hardware: "h", isLocal: handle == "ben",
                             updatedAt: Date(timeIntervalSince1970: 1_700_000_000))
        }
    }

    private func cloudPayload(members: Int = 2, tokens: Int = 900) throws -> Data {
        let users: [[String: Any]] = members == 1
            ? [["handle": "ben", "tokensAll": tokens]]
            : [["handle": "ben", "tokensAll": tokens - 300], ["handle": "akshay", "tokensAll": 300]]
        return try JSONSerialization.data(withJSONObject: [
            "teams": [["team": "maxxers", "teamId": teamId, "tokens": tokens,
                       "members": members, "memberCount": 2, "users": users]]
        ])
    }

    private func store(_ transport: TeamRefreshTransport, clock: TeamRefreshClock) -> TeamStore {
        let entries = localEntries()
        return TeamStore(session: transport.session, localEntries: { entries },
                         cloudBaseURL: { transport.baseURL }, now: { clock.now })
    }

    func testPublicStalenessUsesTheRefreshClock() {
        let clock = TeamRefreshClock()
        let entries = localEntries()
        let board = TeamStore(localEntries: { entries }, cloudBaseURL: { nil }, now: { clock.now })
        XCTAssertTrue(board.isStale())
        board.refresh()
        XCTAssertFalse(board.isStale())
        clock.advance(TeamStore.staleAfter)
        XCTAssertFalse(board.isStale())
        clock.advance(1)
        XCTAssertTrue(board.isStale())
    }

    func testForcedRefreshDuringOlderFetchCoalescesIntoOneFreshMembershipRequest() throws {
        let firstStarted = expectation(description: "older fetch started")
        let followupStarted = expectation(description: "forced follow-up started")
        let transport = TeamRefreshTransport { _, index in
            if index == 1 { firstStarted.fulfill() }
            if index == 2 { followupStarted.fulfill() }
        }
        defer { transport.close() }
        let board = store(transport, clock: TeamRefreshClock())
        let oldCompleted = expectation(description: "older response completed")
        board.refresh { snapshot in
            XCTAssertEqual(snapshot.teams.first?.members, 1)
            oldCompleted.fulfill()
        }
        wait(for: [firstStarted], timeout: 10)

        // A sync acknowledgement can arrive while a pre-sync GET is pending.
        // Several acknowledgements must queue one fetch rather than lose the
        // refresh, or leave this tab showing the old single-member response.
        for _ in 0..<3 { board.refresh(force: true) }
        try transport.reply(status: 200, headers: ["ETag": "before-sync"], data: cloudPayload(members: 1))
        wait(for: [oldCompleted, followupStarted], timeout: 10)

        let freshMembership = expectation(description: "fresh membership published")
        let subscription = board.$teams.sink { rows in
            if rows.first?.members == 2, rows.first?.tokens == 900 { freshMembership.fulfill() }
        }
        defer { subscription.cancel() }
        try transport.reply(status: 200, headers: ["ETag": "after-sync"], data: cloudPayload())
        wait(for: [freshMembership], timeout: 10)

        let requests = transport.requests
        XCTAssertEqual(requests.count, 2, "queued forced refreshes produce exactly one follow-up")
        XCTAssertEqual(requests[1].cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertNil(requests[1].value(forHTTPHeaderField: "If-None-Match"),
                     "the follow-up must fetch the membership that changed during the old GET")
        XCTAssertEqual(board.snapshot().source, .cloud)
        XCTAssertEqual(board.snapshot().teams.first?.teamId, teamId)
        XCTAssertEqual(board.snapshot().teams.first?.users.map(\.handle).sorted(), ["akshay", "ben"])
    }

    func testNotModifiedResponseRevalidatesTheActualCloudRows() throws {
        let requestsStarted = [expectation(description: "initial GET"), expectation(description: "conditional GET")]
        let transport = TeamRefreshTransport { _, index in
            if index <= requestsStarted.count { requestsStarted[index - 1].fulfill() }
        }
        defer { transport.close() }
        let clock = TeamRefreshClock()
        let board = store(transport, clock: clock)
        let initialCompleted = expectation(description: "cloud rows loaded")
        board.refresh { _ in initialCompleted.fulfill() }
        wait(for: [requestsStarted[0]], timeout: 10)
        try transport.reply(status: 200, headers: ["ETag": "members-v1"], data: cloudPayload())
        wait(for: [initialCompleted], timeout: 10)
        let previous = board.snapshot()

        clock.advance(TeamStore.staleAfter + 1)
        let revalidated = expectation(description: "cloud rows revalidated")
        board.refresh { snapshot in
            XCTAssertEqual(snapshot.source, .cloud)
            XCTAssertEqual(snapshot.teams, previous.teams)
            XCTAssertNil(snapshot.lastError)
            XCTAssertEqual(snapshot.lastFetchAt, clock.now)
            revalidated.fulfill()
        }
        wait(for: [requestsStarted[1]], timeout: 10)
        XCTAssertEqual(transport.requests[1].value(forHTTPHeaderField: "If-None-Match"), "members-v1")
        try transport.reply(status: 304)
        wait(for: [revalidated], timeout: 10)
    }

    func testNewPayloadWithoutETagDoesNotSendThePreviousRowsValidator() throws {
        let started = (1...3).map { expectation(description: "GET \($0)") }
        let transport = TeamRefreshTransport { _, index in
            if index <= started.count { started[index - 1].fulfill() }
        }
        defer { transport.close() }
        let clock = TeamRefreshClock()
        let board = store(transport, clock: clock)
        let first = expectation(description: "first payload loaded")
        board.refresh { _ in first.fulfill() }
        wait(for: [started[0]], timeout: 10)
        try transport.reply(status: 200, headers: ["ETag": "members-v1"], data: cloudPayload(members: 1))
        wait(for: [first], timeout: 10)

        clock.advance(TeamStore.staleAfter + 1)
        let second = expectation(description: "replacement payload loaded")
        board.refresh { snapshot in
            XCTAssertEqual(snapshot.teams.first?.members, 2)
            second.fulfill()
        }
        wait(for: [started[1]], timeout: 10)
        XCTAssertEqual(transport.requests[1].value(forHTTPHeaderField: "If-None-Match"), "members-v1")
        try transport.reply(status: 200, data: cloudPayload())
        wait(for: [second], timeout: 10)

        clock.advance(TeamStore.staleAfter + 1)
        let third = expectation(description: "next fetch completed")
        board.refresh { _ in third.fulfill() }
        wait(for: [started[2]], timeout: 10)
        XCTAssertNil(transport.requests[2].value(forHTTPHeaderField: "If-None-Match"),
                     "a new 200 without an ETag clears the old payload's validator")
        try transport.reply(status: 200, data: cloudPayload(tokens: 1_200))
        wait(for: [third], timeout: 10)
        XCTAssertEqual(board.snapshot().teams.first?.tokens, 1_200)
    }

    func testExpiredCloudFailureFallsBackLocallyAndCannotPromoteThoseRowsOn304() throws {
        let started = (1...4).map { expectation(description: "GET \($0)") }
        let transport = TeamRefreshTransport { _, index in
            if index <= started.count { started[index - 1].fulfill() }
        }
        defer { transport.close() }
        let clock = TeamRefreshClock()
        let board = store(transport, clock: clock)
        let first = expectation(description: "cloud payload loaded")
        board.refresh { _ in first.fulfill() }
        wait(for: [started[0]], timeout: 10)
        try transport.reply(status: 200, headers: ["ETag": "old-cloud-rows"], data: cloudPayload())
        wait(for: [first], timeout: 10)

        clock.advance(3_601)
        let offline = expectation(description: "local fallback loaded")
        board.refresh { snapshot in
            XCTAssertEqual(snapshot.source, .local)
            XCTAssertEqual(snapshot.teams.first?.tokens, 400)
            XCTAssertEqual(snapshot.teams.first?.members, 2, "disk membership still keeps both users together")
            XCTAssertNotNil(snapshot.lastError)
            offline.fulfill()
        }
        wait(for: [started[1]], timeout: 10)
        try transport.fail(URLError(.notConnectedToInternet))
        wait(for: [offline], timeout: 10)

        clock.advance(TeamStore.staleAfter + 1)
        let rejected304 = expectation(description: "unmatched cache response rejected")
        board.refresh { snapshot in
            XCTAssertEqual(snapshot.source, .local, "304 without a cloud validator cannot certify local rows")
            XCTAssertEqual(snapshot.teams.first?.tokens, 400)
            XCTAssertTrue(snapshot.lastError?.contains("without a matching cloud payload") ?? false)
            rejected304.fulfill()
        }
        wait(for: [started[2]], timeout: 10)
        XCTAssertNil(transport.requests[2].value(forHTTPHeaderField: "If-None-Match"),
                     "the old validator was discarded with the cloud payload")
        try transport.reply(status: 304)
        wait(for: [rejected304], timeout: 10)

        clock.advance(TeamStore.staleAfter + 1)
        let recovered = expectation(description: "cloud membership recovered")
        board.refresh { snapshot in
            XCTAssertEqual(snapshot.source, .cloud)
            XCTAssertEqual(snapshot.teams.first?.teamId, self.teamId)
            XCTAssertEqual(snapshot.teams.first?.members, 2)
            XCTAssertEqual(snapshot.teams.first?.tokens, 1_200)
            XCTAssertNil(snapshot.lastError)
            recovered.fulfill()
        }
        wait(for: [started[3]], timeout: 10)
        XCTAssertNil(transport.requests[3].value(forHTTPHeaderField: "If-None-Match"))
        try transport.reply(status: 200, data: cloudPayload(tokens: 1_200))
        wait(for: [recovered], timeout: 10)
    }

    func testBriefOutageRetainsTheCloudPayloadAndItsValidator() throws {
        let started = (1...3).map { expectation(description: "GET \($0)") }
        let transport = TeamRefreshTransport { _, index in
            if index <= started.count { started[index - 1].fulfill() }
        }
        defer { transport.close() }
        let clock = TeamRefreshClock()
        let board = store(transport, clock: clock)
        let loaded = expectation(description: "cloud loaded")
        board.refresh { _ in loaded.fulfill() }
        wait(for: [started[0]], timeout: 10)
        try transport.reply(status: 200, headers: ["ETag": "trusted-cloud"], data: cloudPayload())
        wait(for: [loaded], timeout: 10)
        let previous = board.snapshot()

        clock.advance(TeamStore.staleAfter + 1)
        let retained = expectation(description: "trusted cloud retained")
        board.refresh { snapshot in
            XCTAssertEqual(snapshot.source, .cloud)
            XCTAssertEqual(snapshot.teams, previous.teams)
            XCTAssertEqual(snapshot.lastFetchAt, previous.lastFetchAt)
            XCTAssertNotNil(snapshot.lastError)
            retained.fulfill()
        }
        wait(for: [started[1]], timeout: 10)
        try transport.fail(URLError(.timedOut))
        wait(for: [retained], timeout: 10)

        let revalidated = expectation(description: "retained cloud revalidated")
        board.refresh { snapshot in
            XCTAssertEqual(snapshot.teams, previous.teams)
            XCTAssertNil(snapshot.lastError)
            revalidated.fulfill()
        }
        wait(for: [started[2]], timeout: 10)
        XCTAssertEqual(transport.requests[2].value(forHTTPHeaderField: "If-None-Match"), "trusted-cloud")
        try transport.reply(status: 304)
        wait(for: [revalidated], timeout: 10)
    }
}

private final class TeamRefreshClock {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 1_700_000_000)
    var now: Date { lock.lock(); defer { lock.unlock() }; return date }
    func advance(_ interval: TimeInterval) {
        lock.lock()
        date = date.addingTimeInterval(interval)
        lock.unlock()
    }
}

private final class TeamRefreshTransport {
    let session: URLSession
    let baseURL: String
    private let host: String
    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    private var pending: [TeamRefreshURLProtocol] = []

    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return recorded }

    init(onRequest: @escaping (URLRequest, Int) -> Void) {
        host = "\(UUID().uuidString.lowercased()).teams.invalid"
        baseURL = "https://\(host)"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TeamRefreshURLProtocol.self]
        configuration.urlCache = nil
        session = URLSession(configuration: configuration)
        TeamRefreshURLProtocol.install(host: host) { [weak self] task in
            guard let self else { return }
            self.lock.lock()
            self.recorded.append(task.request)
            self.pending.append(task)
            let index = self.recorded.count
            self.lock.unlock()
            onRequest(task.request, index)
        }
    }

    private func next() throws -> TeamRefreshURLProtocol {
        lock.lock()
        defer { lock.unlock() }
        return try XCTUnwrap(pending.isEmpty ? nil : pending.removeFirst(), "no intercepted request to complete")
    }

    func reply(status: Int, headers: [String: String] = [:], data: Data? = nil) throws {
        let task = try next()
        let response = try XCTUnwrap(HTTPURLResponse(url: try XCTUnwrap(task.request.url),
                                                   statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers))
        task.client?.urlProtocol(task, didReceive: response, cacheStoragePolicy: .notAllowed)
        if let data { task.client?.urlProtocol(task, didLoad: data) }
        task.client?.urlProtocolDidFinishLoading(task)
    }

    func fail(_ error: Error) throws {
        let task = try next()
        task.client?.urlProtocol(task, didFailWithError: error)
    }

    func close() {
        session.invalidateAndCancel()
        TeamRefreshURLProtocol.remove(host: host)
        lock.lock()
        pending.removeAll()
        lock.unlock()
    }
}

private final class TeamRefreshURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var handlers: [String: (TeamRefreshURLProtocol) -> Void] = [:]

    static func install(host: String, handler: @escaping (TeamRefreshURLProtocol) -> Void) {
        lock.lock()
        handlers[host] = handler
        lock.unlock()
    }

    static func remove(host: String) {
        lock.lock()
        handlers.removeValue(forKey: host)
        lock.unlock()
    }

    override static func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".teams.invalid") == true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        let handler = Self.handlers[request.url?.host ?? ""]
        Self.lock.unlock()
        if let handler { handler(self) } else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
        }
    }
    override func stopLoading() {}
}
