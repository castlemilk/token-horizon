import Foundation

/// One completed generation from a self-managed runtime (parsed from response metadata).
public struct InferenceTelemetrySample: Equatable {
    public var model: String
    public var completedAt: Date
    public var evalCount: Int
    public var evalDurationNs: UInt64
    public var promptEvalCount: Int?
    public var promptEvalDurationNs: UInt64?

    public init(model: String, completedAt: Date, evalCount: Int, evalDurationNs: UInt64,
                promptEvalCount: Int? = nil, promptEvalDurationNs: UInt64? = nil) {
        self.model = model
        self.completedAt = completedAt
        self.evalCount = evalCount
        self.evalDurationNs = evalDurationNs
        self.promptEvalCount = promptEvalCount
        self.promptEvalDurationNs = promptEvalDurationNs
    }

    public var tokPerSec: Double? {
        guard evalCount > 0, evalDurationNs > 0 else { return nil }
        return Double(evalCount) / (Double(evalDurationNs) / 1_000_000_000)
    }

    public var promptTokPerSec: Double? {
        guard let count = promptEvalCount,
              let duration = promptEvalDurationNs,
              count > 0, duration > 0 else { return nil }
        return Double(count) / (Double(duration) / 1_000_000_000)
    }
}

/// Bounded in-memory store of the most recent sample per model.
public final class InferenceTelemetryStore {
    public static let shared = InferenceTelemetryStore()

    private let lock = NSLock()
    private var latestSamples: [String: InferenceTelemetrySample] = [:]
    private var dayTokens: [Int: Int] = [:]
    private var totalTokens = 0
    private var totalMessages = 0

    public init() {}

    public func record(_ sample: InferenceTelemetrySample) {
        lock.lock()
        latestSamples[sample.model.lowercased()] = sample
        if latestSamples.count > 256 {
            let oldest = latestSamples.values
                .sorted { $0.completedAt < $1.completedAt }
                .prefix(latestSamples.count - 256)
            for sample in oldest { latestSamples.removeValue(forKey: sample.model.lowercased()) }
        }
        let day = DayBoundary.start(ofTs: Int(sample.completedAt.timeIntervalSince1970))
        dayTokens[day, default: 0] += sample.evalCount
        totalTokens += sample.evalCount
        totalMessages += 1
        let cutoff = Int(Date().timeIntervalSince1970) - 370 * 86_400
        for key in dayTokens.keys where key < cutoff { dayTokens[key] = nil }
        lock.unlock()
    }

    public func latest(for model: String) -> InferenceTelemetrySample? {
        lock.lock()
        defer { lock.unlock() }
        return latestSamples[model.lowercased()]
    }

    /// Rollup for the local-models card: today's + all-time measured tokens,
    /// request count, and models with a recent sample.
    public func summary(now: Date = Date()) -> TelemetrySummary {
        lock.lock(); defer { lock.unlock() }
        let today = DayBoundary.start(ofTs: Int(now.timeIntervalSince1970))
        return TelemetrySummary(
            todayTokens: dayTokens[today] ?? 0,
            allTokens: totalTokens,
            messagesAll: totalMessages,
            models: latestSamples.keys.sorted())
    }
}

/// Card rollup over the bounded telemetry store.
public struct TelemetrySummary: Codable, Equatable {
    public var todayTokens: Int
    public var allTokens: Int
    public var messagesAll: Int
    public var models: [String]

    public init(todayTokens: Int = 0, allTokens: Int = 0, messagesAll: Int = 0, models: [String] = []) {
        self.todayTokens = todayTokens
        self.allTokens = allTokens
        self.messagesAll = messagesAll
        self.models = models
    }
}

// Back-compat aliases (pre-rename names used by the app target and metrics).
public typealias OllamaTelemetrySample = InferenceTelemetrySample
public typealias OllamaTelemetryStore = InferenceTelemetryStore
