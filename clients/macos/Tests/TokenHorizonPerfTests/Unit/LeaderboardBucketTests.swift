import Foundation
import SQLite3
import XCTest
@testable import TokenHorizon

/// Real parser/export and temporary-store tests. No provider homes, network,
/// shared durable caches or account/settings writes are involved.
final class LeaderboardBucketTests: XCTestCase {
    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("th-sync-buckets-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    private func data(tokens: Int, collectedAt: Date, hour: Int) -> LeaderboardSyncLocalData {
        var snapshot = UsageSnapshot()
        snapshot.tokensAllTime = tokens
        snapshot.updatedAt = collectedAt
        let day = Int(Calendar.current.startOfDay(for: Date(timeIntervalSince1970: Double(hour))).timeIntervalSince1970)
        return LeaderboardSyncLocalData(snapshot: snapshot,
                                        history: [HistoryPoint(day: day, tokens: tokens, cost: 0, byTool: ["fixture": tokens])],
                                        streak: 1, heatmap: nil,
                                        hourlyHistory: [LeaderboardHourlyPoint(hour: hour, tokens: tokens, cost: 0)])
    }

    func testAtomicExportCapturesChangingTelemetryOnceWithoutMovingHistoricalUsage() throws {
        let directory = try temporaryDirectory()
        let currentHour = Int(Date().timeIntervalSince1970) / 3600 * 3600
        let originalHour = currentHour - 3 * 86_400
        var reads = 0
        var inputs = UsageEngineInputs()
        inputs.localLLMSummary = {
            reads += 1
            let tokens = reads * 100
            return LocalLLMSummary(todayTokens: 0, allTokens: tokens, messagesToday: 0, messagesAll: 1,
                                   models: ["fixture": (today: 0, all: tokens, prompt: 40, eval: 60, messages: 1)],
                                   hourlyBuckets: [originalHour: tokens])
        }
        let store = DurableStore(cacheDirectory: directory, notificationCenter: NotificationCenter())
        let engine = UsageEngine(inputs: inputs, durableStore: store)
        let export = engine.leaderboardData(days: 7)

        XCTAssertEqual(reads, 1, "Totals and buckets must use one telemetry generation")
        XCTAssertEqual(export.snapshot.tokensAllTime, 100)
        XCTAssertEqual(export.snapshot.tokensToday, 0)
        XCTAssertEqual(export.history.reduce(0) { $0 + $1.tokens }, 100)
        XCTAssertEqual(export.history.last?.tokens, 0, "Sync day must not absorb historical usage")
        XCTAssertEqual(export.hourlyHistory, [LeaderboardHourlyPoint(hour: originalHour, tokens: 100, cost: 0)])
        XCTAssertEqual(export.heatmap?.flatMap { $0 }.reduce(0, +), 100)
        XCTAssertEqual(engine.cachedSnapshot()?.updatedAt, export.snapshot.updatedAt)
    }

    func testAtomicParserExportPreservesBucketsAcrossRetryAndNewUsage() throws {
        let fixture = try UsageEngineFixture()
        defer { try? fixture.remove() }
        let first = fixture.engine.leaderboardData(days: 7)
        let originalHours = try XCTUnwrap(first.hourlyHistory)
        XCTAssertEqual(originalHours.count, 2)
        XCTAssertEqual(originalHours.map(\.tokens), [70, 170])
        XCTAssertTrue(originalHours.allSatisfy { $0.hour % 3600 == 0 })
        XCTAssertEqual(first.snapshot.tokensAllTime, first.history.reduce(0) { $0 + $1.tokens })
        XCTAssertEqual(first.snapshot.tokensAllTime, originalHours.reduce(0) { $0 + $1.tokens })
        XCTAssertEqual(first.snapshot.modelDaily.reduce(0) { $0 + $1.tokens }, 240)

        let retry = fixture.engine.leaderboardData(days: 7)
        XCTAssertEqual(retry.hourlyHistory, originalHours, "Repeating Sync must not add or move buckets")
        XCTAssertEqual(retry.history.map(\.day), first.history.map(\.day))
        XCTAssertEqual(retry.history.map(\.tokens), first.history.map(\.tokens))

        try fixture.appendCodex(input: 7, output: 3)
        fixture.engine.noteFSEvents([], forceAll: true)
        let next = fixture.engine.leaderboardData(days: 7)
        XCTAssertEqual(next.snapshot.tokensAllTime, 250)
        XCTAssertEqual(next.hourlyHistory?.map(\.hour), originalHours.map(\.hour))
        XCTAssertEqual(next.hourlyHistory?.map(\.tokens), [70, 180])
        XCTAssertEqual(next.history.map(\.tokens), [0, 0, 0, 0, 0, 70, 180])
    }

    func testHourlyExportIsBoundedAndNeverInventsUndatedBuckets() throws {
        let directory = try temporaryDirectory()
        let hour = Int(Date().timeIntervalSince1970) / 3600 * 3600
        let originalHour = hour - 50 * 86_400
        var inputs = UsageEngineInputs()
        inputs.localLLMSummary = {
            LocalLLMSummary(todayTokens: 0, allTokens: 999, messagesToday: 0, messagesAll: 0, models: [:],
                            hourlyBuckets: [hour - 121 * 86_400: 10, originalHour: 7, hour + 3600: 20])
        }
        let store = DurableStore(cacheDirectory: directory, notificationCenter: NotificationCenter())
        let engine = UsageEngine(inputs: inputs, durableStore: store)
        let export = engine.leaderboardData()
        XCTAssertEqual(export.snapshot.tokensAllTime, 999)
        XCTAssertEqual(export.hourlyHistory, [LeaderboardHourlyPoint(hour: originalHour, tokens: 7, cost: 0)],
                       "Unknown cumulative remainder and future/expired hours must not become sync-hour usage")
    }

    func testOneCapturedDateControlsTodayAndHistoryAcrossMidnight() throws {
        let fixture = try UsageEngineFixture()
        defer { try? fixture.remove() }
        let calendar = Calendar.current
        let tomorrow = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date())))
        let now = tomorrow.addingTimeInterval(1)
        let export = fixture.engine.leaderboardData(days: 7, now: now)
        XCTAssertEqual(export.snapshot.updatedAt, now)
        XCTAssertEqual(export.snapshot.tokensToday, 0)
        XCTAssertEqual(export.snapshot.tokensAllTime, 240)
        XCTAssertEqual(export.history.last?.day, Int(tomorrow.timeIntervalSince1970))
        XCTAssertEqual(export.history.last?.tokens, 0)
        XCTAssertEqual(export.history[5].tokens, 170)
        XCTAssertEqual(export.hourlyHistory?.reduce(0) { $0 + $1.tokens }, 240)
    }

    func testStreakVisitsLocalMidnightAcrossBothDSTTransitions() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Australia/Melbourne"))
        for month in [4, 10] {
            let date = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: month, day: 6)))
            let today = Int(date.timeIntervalSince1970)
            let active = try Set((0..<4).map { offset in
                Int(try XCTUnwrap(calendar.date(byAdding: .day, value: -offset, to: date)).timeIntervalSince1970)
            })
            XCTAssertEqual(UsageEngine.streakDays(today: today, calendar: calendar) { active.contains($0) ? 1 : 0 }, 4)
            let tomorrow = Int(try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: date)).timeIntervalSince1970)
            XCTAssertEqual(UsageEngine.streakDays(today: tomorrow, calendar: calendar) { active.contains($0) ? 1 : 0 }, 4,
                           "Empty today must retain the same calendar-day grace streak")
        }
    }

    func testSQLiteExportRetainsOriginalHoursAndRefreshesTodayWithoutDatabaseChanges() throws {
        let directory = try temporaryDirectory()
        let path = directory.appendingPathComponent("opencode.db").path
        var connection: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(path, &connection, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil), SQLITE_OK)
        let database = try XCTUnwrap(connection)
        defer { sqlite3_close(database) }
        func execute(_ sql: String) {
            XCTAssertEqual(sqlite3_exec(database, sql, nil, nil, nil), SQLITE_OK, String(cString: sqlite3_errmsg(database)))
        }
        execute("PRAGMA journal_mode=WAL")
        execute("CREATE TABLE session (id TEXT, title TEXT, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, "
                + "tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL)")
        execute("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)")
        let now = Date()
        let currentHour = Int(now.timeIntervalSince1970) / 3600 * 3600
        let oldHour = currentHour - 3 * 86_400
        for (id, hour, tokens) in [("old", oldHour, 100), ("current", currentHour, 50)] {
            let millis = hour * 1000 + 1
            execute("INSERT INTO session VALUES ('\(id)', 'fixture', '/fixture', 'model', \(millis), \(millis), \(tokens), 0, 0, 0, 0, 0)")
            execute("INSERT INTO message VALUES ('\(id)', '\(id)', \(millis), '{\"role\":\"assistant\",\"modelID\":\"model\",\"providerID\":\"fixture\","
                    + "\"tokens\":{\"input\":\(tokens),\"output\":0,\"total\":\(tokens)}}')")
        }
        var inputs = UsageEngineInputs()
        inputs.opencodeDatabasePaths = [path]
        let store = DurableStore(cacheDirectory: directory.appendingPathComponent("cache"), notificationCenter: NotificationCenter())
        let engine = UsageEngine(inputs: inputs, durableStore: store)
        let first = engine.leaderboardData(days: 7, now: now)
        XCTAssertEqual(first.snapshot.tokensAllTime, 150)
        XCTAssertEqual(first.snapshot.tokensToday, 50)
        XCTAssertEqual(first.snapshot.models.reduce(0) { $0 + $1.tokensAll }, 150)
        XCTAssertEqual(first.hourlyHistory?.map(\.hour), [oldHour, currentHour])
        XCTAssertEqual(first.hourlyHistory?.map(\.tokens), [100, 50])

        let calendar = Calendar.current
        let tomorrow = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)))
        let next = engine.leaderboardData(days: 7, now: tomorrow.addingTimeInterval(1))
        XCTAssertEqual(next.snapshot.tokensToday, 0, "Today must roll over even when SQLite's fingerprint is unchanged")
        XCTAssertEqual(next.snapshot.models.reduce(0) { $0 + $1.tokensToday }, 0)
        XCTAssertEqual(next.hourlyHistory, first.hourlyHistory)

        execute("BEGIN IMMEDIATE")
        execute("UPDATE session SET tokens_input=20 WHERE id='old'")
        execute("UPDATE message SET data=json_set(data, '$.tokens.input', 20, '$.tokens.total', 20) WHERE id='old'")
        execute("COMMIT")
        let correction = engine.leaderboardData(days: 7, now: tomorrow.addingTimeInterval(2))
        XCTAssertEqual(correction.snapshot.tokensAllTime, 70)
        XCTAssertEqual(correction.snapshot.models.reduce(0) { $0 + $1.tokensAll }, 70)
        XCTAssertEqual(correction.hourlyHistory?.map(\.hour), [oldHour, currentHour])
        XCTAssertEqual(correction.hourlyHistory?.map(\.tokens), [20, 50])
        XCTAssertEqual(correction.history.reduce(0) { $0 + $1.tokens }, 70, "Newer lower corrections retain the same original dates")
    }

    func testStaleBackgroundStageCannotReplaceNewerManualBucketsIncludingAfterReload() throws {
        let path = try temporaryDirectory().appendingPathComponent("leaderboard.json").path
        let hour = Int(Date().timeIntervalSince1970) / 3600 * 3600 - 86_400
        let collectedAt = Date()
        let newer = data(tokens: 200, collectedAt: collectedAt, hour: hour)
        let older = data(tokens: 900, collectedAt: collectedAt.addingTimeInterval(-10), hour: hour + 3600)
        let board = LeaderboardStore(customPath: path)
        board.syncLocal(newer)
        board.syncLocal(older)
        XCTAssertEqual(board.localEntry()?.tokensAll, 200)
        XCTAssertEqual(board.localEntry()?.breakdown?.hourlyHistory, newer.hourlyHistory)

        let reloaded = LeaderboardStore(customPath: path)
        reloaded.syncLocal(older)
        XCTAssertEqual(reloaded.localEntry()?.tokensAll, 200)
        XCTAssertEqual(try XCTUnwrap(reloaded.localEntry()?.collectedAt).timeIntervalSince1970,
                       collectedAt.timeIntervalSince1970, accuracy: 0.000001)
    }

    func testNewerCorrectionMayLowerCountsAndEqualGenerationRetryDoesNotAccumulate() throws {
        let path = try temporaryDirectory().appendingPathComponent("leaderboard.json").path
        let board = LeaderboardStore(customPath: path)
        let hour = Int(Date().timeIntervalSince1970) / 3600 * 3600 - 86_400
        let collectedAt = Date()
        board.syncLocal(data(tokens: 900, collectedAt: collectedAt, hour: hour))
        let correction = data(tokens: 100, collectedAt: collectedAt.addingTimeInterval(1), hour: hour)
        board.syncLocal(correction)
        board.syncLocal(correction)
        XCTAssertEqual(board.localEntry()?.tokensAll, 100)
        XCTAssertEqual(board.localEntry()?.breakdown?.daily.map(\.tokens), [100])
        XCTAssertEqual(board.localEntry()?.breakdown?.hourlyHistory, correction.hourlyHistory)
    }

    func testWireRoundTripPreservesCollectionTimeAndOriginalHourAndDay() throws {
        let path = try temporaryDirectory().appendingPathComponent("leaderboard.json").path
        let board = LeaderboardStore(customPath: path)
        let hour = Int(Date().timeIntervalSince1970) / 3600 * 3600 - 3 * 86_400
        let collectedAt = Date().addingTimeInterval(-30)
        let export = data(tokens: 100, collectedAt: collectedAt, hour: hour)
        board.syncLocal(export)
        let entry = try XCTUnwrap(board.localEntry())
        let body = try CloudPublishCredentials.requestBody(entry: entry, claimToken: nil)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(payload["collectedAt"] as? Double), collectedAt.timeIntervalSince1970, accuracy: 0.000001)
        let parsed = try XCTUnwrap(LeaderboardStore.entryFromDict(payload))
        XCTAssertEqual(try XCTUnwrap(parsed.collectedAt).timeIntervalSince1970,
                       collectedAt.timeIntervalSince1970, accuracy: 0.000001)
        XCTAssertEqual(parsed.breakdown?.hourlyHistory, export.hourlyHistory)
        XCTAssertEqual(parsed.breakdown?.daily.first?.day, export.history.first?.day)
        XCTAssertNotEqual(parsed.breakdown?.hourlyHistory.first?.hour, Int(entry.updatedAt.timeIntervalSince1970) / 3600 * 3600)
    }

    func testLegacyEntryWithoutNewFieldsStillDecodes() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        let entry = try decoder.decode(LeaderboardEntry.self, from: Data(#"{"handle":"legacy","breakdown":{"daily":[]}}"#.utf8))
        XCTAssertNil(entry.collectedAt)
        XCTAssertEqual(entry.breakdown?.hourlyHistory, [])
    }

    func testServerStagingUsesAtomicProviderWithoutIndependentReads() {
        var calls = 0
        let export = data(tokens: 100, collectedAt: Date(), hour: 1_800_000_000)
        let server = LocalServer(
            statsProvider: { XCTFail("Must use atomic collector"); return .empty },
            sysProvider: { SystemStats.Snapshot() },
            historyProvider: { _ in XCTFail("Must use atomic collector"); return ([], 0) },
            trendsProvider: { _ in [] }, limitsProvider: { [] },
            processesProvider: { ([], [], [], [], []) },
            heatmapProvider: { _ in XCTFail("Must use atomic collector"); return [] },
            leaderboardDataProvider: { calls += 1; return export }, onEvent: { _ in })
        let actual = server.leaderboardData()
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(actual.snapshot.tokensAllTime, 100)
        XCTAssertEqual(actual.hourlyHistory, export.hourlyHistory)
        XCTAssertEqual(actual.history.map(\.day), export.history.map(\.day))
    }
}
