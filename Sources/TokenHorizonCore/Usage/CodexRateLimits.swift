import Foundation

/// Codex `token_count` payloads carry the account's rate-limit windows as
/// `payload.rate_limits.{primary,secondary}` — parsed ONCE here and shared
/// by the UsageEngine backfill scanner (CodexRate) and the CodexConsolidator
/// (LimitSnapshot rows).
public enum CodexRateLimits {

    public struct Window {
        public let usedPercent: Double
        public let windowMinutes: Int
        /// Epoch seconds when the window resets (0 when absent).
        public let resetsAt: Double

        public var resetDate: Date? {
            resetsAt > 0 ? Date(timeIntervalSince1970: resetsAt) : nil
        }
    }

    /// All windows present in a `token_count` payload, keyed as on the wire
    /// ("primary" / "secondary"). Missing/malformed windows are skipped.
    public static func parse(_ payload: [String: Any]) -> [String: Window] {
        guard let rateLimits = payload["rate_limits"] as? [String: Any] else { return [:] }
        var out: [String: Window] = [:]
        for key in ["primary", "secondary"] {
            guard let w = rateLimits[key] as? [String: Any],
                  let used = (w["used_percent"] as? NSNumber)?.doubleValue else { continue }
            out[key] = Window(
                usedPercent: used,
                windowMinutes: (w["window_minutes"] as? NSNumber)?.intValue ?? 0,
                resetsAt: (w["resets_at"] as? NSNumber)?.doubleValue ?? 0)
        }
        return out
    }
}
