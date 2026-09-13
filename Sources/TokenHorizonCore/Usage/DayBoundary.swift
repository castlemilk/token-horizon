import Foundation

/// THE day boundary. Everything stored and served is UTC — day buckets,
/// "today" splits, streaks, heatmap cells — and local time is inferred by
/// the frontend at render time only. Never use Calendar.current.startOfDay
/// for data boundaries (it bakes the server's timezone into stored/served
/// shapes and disagrees across machines).
public enum DayBoundary {
    /// UTC-midnight epoch seconds for the day containing `ts`.
    public static func start(ofTs ts: Int) -> Int { ts / 86_400 * 86_400 }

    /// UTC-midnight Date for the day containing `date`.
    public static func start(of date: Date) -> Date {
        Date(timeIntervalSince1970: TimeInterval(start(ofTs: Int(date.timeIntervalSince1970))))
    }

    /// A gregorian calendar pinned to UTC — for weekday/hour extraction
    /// (activity heatmap) without server-timezone leakage.
    public static var utcCalendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }
}
