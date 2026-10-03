import Foundation
@testable import TokenHorizon

/// Two small provider streams exercise the real parsers and aggregation.
/// Every source and persisted file belongs to this temporary directory.
final class UsageEngineFixture {
    let root: URL
    let store: DurableStore
    let inputs: UsageEngineInputs
    let engine: UsageEngine
    private let codexFile: URL
    private let currentTimestamp: String

    init() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("th-engine-fixture-\(UUID().uuidString)")
        let codex = directory.appendingPathComponent("codex/sessions")
        let kimi = directory.appendingPathComponent("kimi/sessions")
        try FileManager.default.createDirectory(at: codex, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: kimi, withIntermediateDirectories: true)
        let now = Date()
        let calendar = Calendar.current
        let yesterday = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: now))
            ?? now.addingTimeInterval(-86_400)
        let previous = yesterday.addingTimeInterval(3600)
        let formatter = ISO8601DateFormatter()
        let current = formatter.string(from: now)
        let prior = formatter.string(from: previous)
        let codexURL = codex.appendingPathComponent("fixture.jsonl")
        let codexLines = [Self.codexRecord(timestamp: prior, input: 40, output: 10),
                          Self.codexRecord(timestamp: current, input: 100, output: 20)]
        try (codexLines.joined(separator: "\n") + "\n").write(to: codexURL, atomically: true, encoding: .utf8)
        let kimiLines = [
            Self.kimiRecord(date: previous, input: 15, output: 5),
            Self.kimiRecord(date: now, input: 30, output: 10, cacheRead: 5, cacheWrite: 5),
            #"{"type":"usage.record","model":"kimi-code/k3-fixture","usageScope":"session","usage":{"inputOther":999999},"time":\#(Int(now.timeIntervalSince1970 * 1000))}"#
        ]
        try (kimiLines.joined(separator: "\n") + "\n").write(to: kimi.appendingPathComponent("wire.jsonl"), atomically: true, encoding: .utf8)

        let isolatedStore = DurableStore(cacheDirectory: directory.appendingPathComponent("cache"),
                                         notificationCenter: NotificationCenter())
        var sources = UsageEngineInputs()
        sources.codexDirectories = [codex.path]
        sources.kimiDirectories = [kimi.path]
        root = directory
        store = isolatedStore
        inputs = sources
        engine = UsageEngine(inputs: sources, durableStore: isolatedStore)
        codexFile = codexURL
        currentTimestamp = current
    }

    func appendCodex(input: Int, output: Int) throws {
        let file = try FileHandle(forWritingTo: codexFile)
        defer { try? file.close() }
        try file.seekToEnd()
        try file.write(contentsOf: Data((Self.codexRecord(timestamp: currentTimestamp, input: input, output: output) + "\n").utf8))
    }

    func remove() throws {
        store.flushEngineState()
        try FileManager.default.removeItem(at: root)
    }

    private static func codexRecord(timestamp: String, input: Int, output: Int) -> String {
        #"{"timestamp":"\#(timestamp)","type":"token_usage_record","payload":{"model":"gpt-fixture","usage":{"input_tokens":\#(input),"output_tokens":\#(output)}}}"#
    }

    private static func kimiRecord(date: Date, input: Int, output: Int, cacheRead: Int = 0, cacheWrite: Int = 0) -> String {
        #"{"type":"usage.record","model":"kimi-code/k3-fixture","usageScope":"turn","usage":{"inputOther":\#(input),"output":\#(output),"#
            + #""inputCacheRead":\#(cacheRead),"inputCacheCreation":\#(cacheWrite)},"time":\#(Int(date.timeIntervalSince1970 * 1000))}"#
    }
}
