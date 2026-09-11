import XCTest
@testable import TokenHorizon

/// Repeatable tick profiler. OPT-IN ONLY: runs exclusively under
/// `TH_PROFILE=1` (`make profile`), otherwise passes instantly. Prints a
/// timing table via NSLog — no timing assertions (machine-dependent; budgets
/// live in ModelsPipelinePerfTests/ScopeCountsCachingTests). Structural
/// assertions double as correctness checks.
///
/// What it measures on the REAL machine (live $HOME, read-only except the
/// same durable-cache writes the app itself performs):
/// snapshot cold/warm medians, history + trends, listing walk, and pipeline
/// compute cold (fresh ids) vs warm (memoized).
final class TickPerfHarnessTests: XCTestCase {

    private var enabled: Bool {
        ProcessInfo.processInfo.environment["TH_PROFILE"] != nil
    }

    func testTickPerf_table() {
        guard enabled else { return }

        let eng = UsageEngine()

        // Snapshot: 1 cold (fills sqlite + listing caches) then warm medians.
        let coldSnap = ms { _ = eng.snapshot() }
        var snaps: [Double] = []
        for _ in 0..<15 { snaps.append(ms { _ = eng.snapshot() }) }
        snaps.sort()
        NSLog("[TickPerf] snapshot cold=%.1fms warm-median=%.1f warm-p90=%.1f",
              coldSnap, snaps[7], snaps[13])

        // History + trends (bounded days to keep the harness fast).
        let hist = timed { eng.history(days: 30) }
        XCTAssertEqual(hist.value.points.count, 30)
        NSLog("[TickPerf] history(30d)=%.1fms", hist.ms)
        let trends = timed { eng.trendHistory(window: .month) }
        XCTAssertEqual(trends.value.count, TrendWindow.month.spec.count)
        NSLog("[TickPerf] trends(1M)=%.1fms", trends.ms)

        // Listing walk across the real scan roots.
        let fm = FileManager.default
        var roots: [String] = []
        roots += ClaudeDiscovery.discoverDirectories().flatMap { ["\($0)/projects"] }
        roots += UsageEngine.codexScanDirs
        roots += UsageEngine.genericSources.flatMap { $0.dirs }
        roots = roots.filter { fm.fileExists(atPath: $0) }
        var walks: [Double] = []
        for _ in 0..<5 {
            walks.append(ms {
                for r in roots {
                    let excl: Set<String> = r.contains("antigravity")
                        ? UsageEngine.excludedDirNames(for: "agy") : []
                    _ = eng.listedFiles(fm: fm, root: r, rel: "", suffix: ".jsonl", excluding: excl)
                }
            })
        }
        walks.sort()
        let listed = eng.listedFiles(fm: fm, root: roots.first ?? "/tmp", rel: "", suffix: ".jsonl")
        NSLog("[TickPerf] listing roots=%d files(first)=%d median=%.1fms",
              roots.count, listed.count, walks[2])

        // Pipeline compute: cold ids vs memoized warm ids (same process).
        guard let url = Bundle.module.url(forResource: "catalog-7300", withExtension: "json", subdirectory: "Fixtures")
            ?? Bundle.module.url(forResource: "catalog-7300", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let catalog = try? JSONDecoder().decode([ModelCatalog.Entry].self, from: data) else {
            NSLog("[TickPerf] catalog fixture missing — skipping compute")
            return
        }
        // Order matters: the memo is process-global, so the truly-cold run
        // on the real ids comes first; the zzcold- run re-cools with fresh
        // ids; the trailing runs on real ids are memo hits.
        let coldMs = ms {
            _ = ModelsPipeline.compute(search: "", scope: .all, sortColumn: .sweBench,
                                       sortAscending: false, catalog: catalog,
                                       syntheticModels: [], usageModels: [])
        }
        let coldCatalog: [ModelCatalog.Entry] = catalog.map { e in
            var c = e; c.id = "zzcold-" + e.id; return c
        }
        _ = ModelsPipeline.compute(search: "", scope: .all, sortColumn: .sweBench,
                                   sortAscending: false, catalog: coldCatalog,
                                   syntheticModels: [], usageModels: [])
        let warmMs = ms {
            _ = ModelsPipeline.compute(search: "", scope: .all, sortColumn: .sweBench,
                                       sortAscending: false, catalog: catalog,
                                       syntheticModels: [], usageModels: [])
        }
        let warm2Ms = ms {
            _ = ModelsPipeline.compute(search: "", scope: .all, sortColumn: .sweBench,
                                       sortAscending: false, catalog: catalog,
                                       syntheticModels: [], usageModels: [])
        }
        let base = ModelsPipeline.compute(search: "", scope: .all, sortColumn: .sweBench,
                                          sortAscending: false, catalog: catalog,
                                          syntheticModels: [], usageModels: [])
        XCTAssertGreaterThan(base.base.count, 1000)
        NSLog("[TickPerf] compute cold=%.1fms warm=%.1fms/%.1fms base=%d",
              coldMs, warmMs, warm2Ms, base.base.count)
    }

    @discardableResult
    private func ms(_ work: () -> Void) -> Double {
        let t0 = DispatchTime.now(); work()
        return Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000
    }

    private func timed<T>(_ work: () -> T) -> (value: T, ms: Double) {
        let t0 = DispatchTime.now(); let v = work()
        return (v, Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000)
    }
}
