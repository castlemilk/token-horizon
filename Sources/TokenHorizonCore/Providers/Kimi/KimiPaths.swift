import Foundation

/// ONE home for Kimi file locations — sessions (wire.jsonl tailing,
/// consolidation, poller status) and OAuth credential files (limits).
/// Env overrides replace their corresponding default dotdir only:
/// KIMI_CODE_HOME → ~/.kimi-code, KIMI_HOME → ~/.kimi.
public enum KimiPaths {

    /// Kimi home directories, code-home first. Never empty.
    public static func homes() -> [String] {
        let env = ProcessInfo.processInfo.environment
        let home = Platform.paths.homeDirectory.path
        let code = env["KIMI_CODE_HOME"].flatMap { $0.isEmpty ? nil : $0 }
            ?? home + "/.kimi-code"
        let classic = env["KIMI_HOME"].flatMap { $0.isEmpty ? nil : $0 }
            ?? home + "/.kimi"
        return code == classic ? [code] : [code, classic]
    }

    /// wire.jsonl session roots (KimiConsolidator, UsageEngine, FilePoller).
    public static func sessionDirs() -> [String] {
        homes().map { $0 + "/sessions" }
    }

    /// OAuth credential files, one per profile (KimiLimitsEngine).
    public static func credentialFiles() -> [String] {
        homes().map { $0 + "/credentials/kimi-code.json" }
    }
}
