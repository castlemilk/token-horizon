import Foundation

/// Explicit inputs for an engine detached from provider-home discovery.
/// Empty sources stay empty; callers opt into each file or telemetry input.
/// The app omits this configuration and retains live discovery and watching.
struct UsageEngineInputs {
    var claudeDirectories: [String] = []
    var codexDirectories: [String] = []
    var kimiDirectories: [String] = []
    var genericSources: [(tool: String, dirs: [String])] = []
    var devinDirectories: [String] = []
    var devinSessionsDatabase: String?
    var opencodeDatabasePaths: [String] = []
    var watchesFiles = false
    var localLLMSummary: () -> LocalLLMSummary = {
        LocalLLMSummary(todayTokens: 0, allTokens: 0, messagesToday: 0,
                        messagesAll: 0, models: [:], hourlyBuckets: [:])
    }
}
