import Foundation

/// Generic bounded rolling series.
///
/// Extracts the ad-hoc `append` + `removeFirst(count - limit)` pattern
/// currently hand-rolled in `UIModel` (fine/coarse system history) and
/// `MLXHistory` (fine samples + 30s rollups) into one tested type.
///
/// This file is ADDITIVE: existing call sites are untouched. Migrate them one
/// at a time (each is a mechanical swap) once this type has proven itself in
/// tests. Bounds mirror the documented windows: fine cap 1,800 @ 2s (~1h),
/// coarse cap 2,880 @ 30s (~24h) — pass the cap in, never hard-code it here.
struct BoundedSeries<Element> {
    private(set) var values: [Element] = []
    let capacity: Int

    init(capacity: Int) {
        precondition(capacity > 0, "BoundedSeries capacity must be positive")
        self.capacity = capacity
    }

    var count: Int { values.count }
    var isEmpty: Bool { values.isEmpty }
    var oldest: Element? { values.first }
    var newest: Element? { values.last }

    mutating func append(_ element: Element) {
        values.append(element)
        trim()
    }

    mutating func append(contentsOf elements: [Element]) {
        values.append(contentsOf: elements)
        trim()
    }

    mutating func removeAll() {
        values.removeAll()
    }

    func suffix(_ maxLength: Int) -> [Element] {
        Array(values.suffix(maxLength))
    }

    private mutating func trim() {
        if values.count > capacity {
            values.removeFirst(values.count - capacity)
        }
    }
}

extension BoundedSeries where Element == Double {
    /// Mean of the last `n` values (the "30-second average of 15 samples"
    /// rollup in one call). Returns 0 for an empty series.
    func averageOfLast(_ n: Int) -> Double {
        let tail = values.suffix(max(0, n))
        guard !tail.isEmpty else { return 0 }
        return tail.reduce(0, +) / Double(tail.count)
    }
}
