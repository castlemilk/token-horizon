import XCTest
@testable import TokenHorizon

/// Live lifecycle test for LocalServer over real loopback. Tolerant by
/// design: if the desktop app holds :8765 (normal on dev machines) the bind
/// fails and the test takes the graceful-report path; if the port is free
/// (CI) it round-trips real HTTP through accept/receive/handle, covering
/// the connection path end to end. Either outcome passes; only a hang,
/// crash, or exit fails.
///
/// NOTE: when this test binds :8765 itself it holds the port until the test
/// process exits. On dev machines the app normally holds it, so the test
/// takes the failure path and interferes with nothing.
final class LocalServerLifecycleTests: XCTestCase {

    private final class Counter {
        private let lock = NSLock()
        private var value = 0
        func increment() { lock.lock(); value += 1; lock.unlock() }
        func get() -> Int { lock.lock(); defer { lock.unlock() }; return value }
    }

    func testLifecycle_bindServesOrReportsGracefully() {
        let failures = Counter()
        let srv = LocalServer(
            statsProvider: { UsageSnapshot.empty },
            sysProvider: { SystemStats.Snapshot() },
            historyProvider: { _ in ([], 0) },
            trendsProvider: { _ in [] },
            limitsProvider: { [] },
            processesProvider: { ([], [], [], [], []) },
            onEvent: { _ in }, onCacheReset: nil)
        srv.onBindFailure = { failures.increment() }
        srv.start()

        var servedRounds = 0
        for _ in 0..<20 {
            if failures.get() > 0 { break }
            if getHealth() != nil {
                servedRounds += 1
                if servedRounds >= 3 { break }
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTAssertTrue(servedRounds >= 3 || failures.get() > 0,
                      "listener must either serve HTTP or report bind failure")
    }

    private func getHealth() -> [String: Any]? {
        guard let url = URL(string: "http://127.0.0.1:8765/health") else { return nil }
        var out: [String: Any]?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: url) { data, resp, _ in
            defer { sema.signal() }
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
                  let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            out = obj
        }.resume()
        _ = sema.wait(timeout: .now() + 2)
        return out
    }
}
