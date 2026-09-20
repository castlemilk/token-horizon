import Foundation

/// DB-backed activity heatmap: 7 (Mon-first) x 24 local-hour token grid over
/// the trailing `days`.
///
/// Generic over the storage backend (`S: UsageStoring`) so the same logic
/// serves sqlite today and Postgres/HTTP tomorrow — and so tests can inject
/// an in-memory fake. Resolution is hourly regardless of the store's finest
/// tick; larger horizons reuse the same grid shape (counts just grow).
public enum ActivityHeatmap {
    public static func grid<S: UsageStoring>(
        days: Int = 28,
        now: Date = Date(),
        store: S,
        filter: UsageFilter = UsageFilter()
    ) throws -> [[Int]] {
        let cal = DayBoundary.utcCalendar   // UTC grid; local rendering is the frontend's job
        let span = max(1, days)
        let startDay = DayBoundary.start(of: now).addingTimeInterval(TimeInterval(-(span - 1) * 86_400))
        let buckets = try store.buckets(from: startDay, to: now,
                                        bucketSeconds: 3_600, filter: filter)
        var grid = Array(repeating: Array(repeating: 0, count: 24), count: 7)
        for b in buckets {
            let tokens = b.tokens.total
            guard tokens > 0 else { continue }
            let date = Date(timeIntervalSince1970: TimeInterval(b.start))
            let row = (cal.component(.weekday, from: date) + 5) % 7
            let col = cal.component(.hour, from: date)
            guard (0..<7).contains(row), (0..<24).contains(col) else { continue }
            grid[row][col] += tokens
        }
        return grid
    }

    /// Pure fold used by tests and the in-memory fallback: (epoch, tokens)
    /// pairs into the same 7x24 grid.
    public static func fold(_ points: [(epoch: Int, tokens: Int)],
                            calendar cal: Calendar = .current) -> [[Int]] {
        var grid = Array(repeating: Array(repeating: 0, count: 24), count: 7)
        for p in points where p.tokens > 0 {
            let date = Date(timeIntervalSince1970: TimeInterval(p.epoch))
            let row = (cal.component(.weekday, from: date) + 5) % 7
            let col = cal.component(.hour, from: date)
            guard (0..<7).contains(row), (0..<24).contains(col) else { continue }
            grid[row][col] += p.tokens
        }
        return grid
    }
}
