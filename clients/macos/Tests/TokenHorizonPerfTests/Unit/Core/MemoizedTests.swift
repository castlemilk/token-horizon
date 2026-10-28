import XCTest
@testable import TokenHorizon

/// The HTTP-seam memos guarantee: at most ONE recomputation in flight, and
/// callers arriving mid-recompute receive the last value instead of queueing
/// their own compute. Regression context: /history, /trends and friends each
/// started their own engine collect behind a long scan — a ~90-thread
/// dispatch convoy that hung the whole API.
final class MemoizedTests: XCTestCase {

    func testMemoizedValue_servesLastValueWhileRecomputing() {
        let computing = expectation(description: "compute started")
        let release = DispatchSemaphore(value: 0)
        var computes = 0
        let counter = NSLock()
        let memo = MemoizedValue<Int>(ttl: 60) { () -> Int in
            counter.lock(); computes += 1; counter.unlock()
            computing.fulfill()
            release.wait()
            return 42
        }

        var first: Int?
        let done = expectation(description: "first caller finished")
        DispatchQueue.global().async {
            first = memo.get()
            done.fulfill()
        }
        wait(for: [computing], timeout: 2)

        // Second caller during the compute: last value (nil, cold start),
        // and it must NOT start a second compute.
        XCTAssertEqual(memo.get(), nil)
        counter.lock(); XCTAssertEqual(computes, 1); counter.unlock()

        release.signal()
        wait(for: [done], timeout: 2)
        XCTAssertEqual(first, 42)
        XCTAssertEqual(memo.get(), 42, "fresh within ttl")
        counter.lock(); XCTAssertEqual(computes, 1, "no recompute within ttl"); counter.unlock()
    }

    func testMemoizedValue_recomputesAfterTTL() {
        var value = 1
        let memo = MemoizedValue<Int>(ttl: 0.05) { value }
        XCTAssertEqual(memo.get(), 1)
        value = 2
        XCTAssertEqual(memo.get(), 1, "still fresh")
        usleep(80_000) // let the ttl lapse
        XCTAssertEqual(memo.get(), 2, "recomputed after ttl")
    }

    func testKeyedMemo_singleFlightIsPerKey() {
        let computing = expectation(description: "key A compute started")
        let release = DispatchSemaphore(value: 0)
        let memo = KeyedMemo<String, Int>(ttl: 60) { key in
            if key == "A" {
                computing.fulfill()
                release.wait()
                return 1
            }
            return 2
        }

        var a: Int?
        let done = expectation(description: "key A finished")
        DispatchQueue.global().async {
            a = memo.get("A")
            done.fulfill()
        }
        wait(for: [computing], timeout: 2)

        // Key B computes independently while A is in flight...
        XCTAssertEqual(memo.get("B"), 2)
        // ...and a second A caller gets the last value, not a second compute.
        XCTAssertEqual(memo.get("A"), nil)

        release.signal()
        wait(for: [done], timeout: 2)
        XCTAssertEqual(a, 1)
        XCTAssertEqual(memo.get("A"), 1)
    }

    func testKeyedMemo_cachesPerKey() {
        var computes: Set<String> = []
        let lock = NSLock()
        let memo = KeyedMemo<String, Int>(ttl: 60) { key in
            lock.lock(); computes.insert(key); lock.unlock()
            return key.count
        }
        XCTAssertEqual(memo.get("abc"), 3)
        XCTAssertEqual(memo.get("ab"), 2)
        XCTAssertEqual(memo.get("abc"), 3, "cached per key")
        lock.lock(); XCTAssertEqual(computes, ["abc", "ab"]); lock.unlock()
    }
}
