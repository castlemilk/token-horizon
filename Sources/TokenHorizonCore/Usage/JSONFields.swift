import Foundation

/// Shared JSON field extraction for file/wire parsers (UsageEngine,
/// FileConsolidator subclasses). Values arrive as JSONSerialization types
/// (NSNumber/String), never trusted to be well-formed.
public enum JSONFields {

    /// Numeric field as a non-negative Int (0 when absent/malformed/negative).
    public static func int(_ dict: [String: Any], _ key: String) -> Int {
        max(0, (dict[key] as? NSNumber)?.intValue ?? 0)
    }

    /// ISO-8601 string (with/without fractional seconds) or epoch number
    /// (seconds, or milliseconds when > 1e12) → Date.
    public static func timestamp(_ any: Any?) -> Date? {
        if let s = any as? String {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = iso.date(from: s) { return d }
            iso.formatOptions = [.withInternetDateTime]
            return iso.date(from: s)
        }
        if let n = any as? NSNumber {
            let v = n.doubleValue
            return Date(timeIntervalSince1970: v > 1e12 ? v / 1000 : v)
        }
        return nil
    }
}
