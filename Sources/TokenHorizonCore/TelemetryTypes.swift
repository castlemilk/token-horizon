import Foundation

/// One completed Ollama generation, parsed from streaming response metadata.
public struct OllamaTelemetrySample: Equatable {
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
public final class OllamaTelemetryStore {
    public static let shared = OllamaTelemetryStore()

    private let lock = NSLock()
    private var latestSamples: [String: OllamaTelemetrySample] = [:]

    public init() {}

    public func record(_ sample: OllamaTelemetrySample) {
        lock.lock()
        latestSamples[sample.model.lowercased()] = sample
        if latestSamples.count > 256 {
            let oldest = latestSamples.values
                .sorted { $0.completedAt < $1.completedAt }
                .prefix(latestSamples.count - 256)
            for sample in oldest { latestSamples.removeValue(forKey: sample.model.lowercased()) }
        }
        lock.unlock()
    }

    public func latest(for model: String) -> OllamaTelemetrySample? {
        lock.lock()
        defer { lock.unlock() }
        return latestSamples[model.lowercased()]
    }
}
