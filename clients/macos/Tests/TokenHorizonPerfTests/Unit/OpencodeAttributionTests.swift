import Foundation
import SQLite3
import XCTest
@testable import TokenHorizon

/// A session created on a previous day keeps accruing tokens today. The
/// per-tool "today" figures and hourly history must come from message
/// timestamps — keying them on `session_v2.time_created` pins the whole
/// session to its creation day and reports zero forever after.
final class OpencodeAttributionTests: XCTestCase {
    private var root: URL!
    private var store: DurableStore!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-oc-attribution-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = DurableStore(cacheDirectory: root.appendingPathComponent("cache"),
                             notificationCenter: NotificationCenter())
    }

    override func tearDownWithError() throws {
        store.flushEngineState()
        try? FileManager.default.removeItem(at: root)
    }

    private func exec(_ db: OpaquePointer?, _ sql: String) {
        XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK)
    }

    /// Builds a v2 opencode db: one session created `sessionAgeHours` ago,
    /// plus one assistant message yesterday and one today.
    private func makeDatabase() throws -> (path: String, todayStart: Date) {
        let dbPath = root.appendingPathComponent("opencode.db").path
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(dbPath, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        exec(db, """
        CREATE TABLE session_v2 (
            id text PRIMARY KEY, directory text NOT NULL DEFAULT '', title text,
            cost real DEFAULT 0, tokens_input integer DEFAULT 0,
            tokens_output integer DEFAULT 0, tokens_reasoning integer DEFAULT 0,
            tokens_cache_read integer DEFAULT 0, tokens_cache_write integer DEFAULT 0,
            model text, time_created integer NOT NULL, time_updated integer NOT NULL);
        CREATE TABLE session_message (
            id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL,
            seq integer NOT NULL, time_created integer NOT NULL,
            time_updated integer NOT NULL, data text NOT NULL);
        """)
        let todayStart = Calendar.current.startOfDay(for: Date())
        let todayMs = Int(todayStart.timeIntervalSince1970 * 1000)
        let yesterdayMs = todayMs - 4 * 3_600_000            // 4h before midnight
        let createdMs = todayMs - 30 * 3_600_000             // session born yesterday
        let nowMs = todayMs + Int(Date().timeIntervalSince(todayStart) * 1000)
        exec(db, """
        INSERT INTO session_v2 VALUES
          ('s1','/tmp/proj','fixture session',2.5,5000000,500000,0,0,0,'fixture-model',\(createdMs),\(nowMs));
        """)
        func message(_ id: String, _ type: String, _ ms: Int, _ data: String) {
            exec(db, "INSERT INTO session_message VALUES ('\(id)','s1','\(type)',1,\(ms),\(ms),'\(data)');")
        }
        // yesterday's assistant row — belongs to yesterday even though the
        // session total still sits on s1.
        message("m1", "assistant", yesterdayMs,
                #"{"model":{"providerID":"fixture-provider","id":"fixture-model"},"tokens":{"input":700,"output":300},"cost":1.0}"#)
        // today's assistant row — 250 tokens in 100/150, plus a user row that
        // must never count.
        message("m2", "assistant", nowMs,
                #"{"model":{"providerID":"fixture-provider","id":"fixture-model"},"tokens":{"input":100,"output":150},"cost":0.25}"#)
        message("m3", "user", nowMs, #"{"role":"user"}"#)
        return (dbPath, todayStart)
    }

    private func makeEngine(_ dbPath: String) -> UsageEngine {
        var inputs = UsageEngineInputs()
        inputs.opencodeDatabasePaths = [dbPath]
        return UsageEngine(inputs: inputs, durableStore: store)
    }

    func testSessionCreatedYesterdayStillCountsTodaysMessages() throws {
        let (dbPath, _) = try makeDatabase()
        let snap = makeEngine(dbPath).snapshot()
        let oc = try XCTUnwrap(snap.perTool.first { $0.tool == "opencode" })
        XCTAssertEqual(oc.tokensToday, 250)
        XCTAssertEqual(oc.inputTokensToday, 100)
        XCTAssertEqual(oc.outputTokensToday, 150)
        XCTAssertEqual(oc.requestsToday, 1)
        XCTAssertEqual(oc.costToday, 0.25, accuracy: 0.001)
        XCTAssertEqual(oc.tokensAllTime, 5_500_000)
        XCTAssertEqual(oc.requestsAllTime, 2)
    }

    func testModelAndDailyHistoryAttributeToMessageTime() throws {
        let (dbPath, todayStart) = try makeDatabase()
        let snap = makeEngine(dbPath).snapshot()
        let model = try XCTUnwrap(snap.models.first { $0.model == "fixture-model" })
        XCTAssertEqual(model.tokensToday, 250)
        XCTAssertEqual(model.requestsToday, 1)
        XCTAssertEqual(model.provider, "fixture-provider")
        let dayStart = Int(todayStart.timeIntervalSince1970)
        let todayEntry = snap.modelDaily.first { $0.model == "fixture-model" && $0.day == dayStart }
        XCTAssertEqual(todayEntry?.tokens, 250)
        let yesterdayStart = dayStart - 86_400
        let yesterdayEntry = snap.modelDaily.first { $0.model == "fixture-model" && $0.day == yesterdayStart }
        XCTAssertEqual(yesterdayEntry?.tokens, 1_000)
    }
}
