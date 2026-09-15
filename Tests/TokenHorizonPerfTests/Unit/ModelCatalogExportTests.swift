import XCTest
@testable import TokenHorizon

/// Contract tests for the web catalog export (`/models/catalog` +
/// `docs/data/models.json`): the dashboard depends on these keys and shapes.
final class ModelCatalogExportTests: XCTestCase {

    func testPayload_carriesSchemaAndCounts() throws {
        let payload = ModelCatalogExport.payload()
        XCTAssertEqual(payload["schemaVersion"] as? Int, 1)
        XCTAssertEqual(payload["count"] as? Int, (payload["models"] as? [[String: Any]])?.count)
        XCTAssertNotNil(payload["generatedAt"] as? Int)
        XCTAssertNotNil(payload["catalogCount"] as? Int)
        XCTAssertFalse((payload["providers"] as? [[String: Any]])?.isEmpty ?? true)
    }

    func testModels_exposeExplorerFields() throws {
        let payload = ModelCatalogExport.payload()
        let models = try XCTUnwrap(payload["models"] as? [[String: Any]], "models array missing")
        XCTAssertFalse(models.isEmpty, "live cache or built-in flagships must yield entries")
        for row in models.prefix(50) {
            XCTAssertNotNil(row["id"] as? String)
            XCTAssertNotNil(row["name"] as? String)
            XCTAssertNotNil(row["provider"] as? String)
            XCTAssertNotNil(row["providerName"] as? String)
            XCTAssertNotNil(row["category"] as? String)
            XCTAssertTrue(row["inputPerM"] != nil && row["outputPerM"] != nil,
                          "pricing keys must always be present for the explorer columns")
        }
    }

    func testTopPicks_areRankedAndScored() throws {
        let picks = try XCTUnwrap(ModelCatalogExport.payload()["topPicks"] as? [[String: Any]],
                                   "topPicks array missing")
        XCTAssertFalse(picks.isEmpty)
        let ranks = picks.compactMap { $0["rank"] as? Int }
        XCTAssertEqual(ranks, Array(1...picks.count), "picks must be 1..n in order")
        for pick in picks {
            XCTAssertNotNil(pick["id"] as? String)
            XCTAssertNotNil(pick["valueScore"] as? Double)
            XCTAssertNotNil(pick["badge"] as? String)
            XCTAssertNotNil(pick["reason"] as? String)
        }
    }

    func testBenchmarks_includeCuratedAuxiliaryScores() throws {
        let payload = ModelCatalogExport.payload()
        let models = try XCTUnwrap(payload["models"] as? [[String: Any]])
        let withSwe = models.filter { ($0["benchmarks"] as? [String: Any])?["swe"] != nil }
        XCTAssertFalse(withSwe.isEmpty, "at least the curated flagship benchmarks must surface")
        // AIME/GPQA only exist in Resources/benchmarks.json; when that file is
        // reachable (repo checkout) the export enriches the same rows.
        let aux = ModelCatalogExport.auxiliaryBenchmarks()
        if !aux.isEmpty {
            let enriched = models.contains { row in
                let bench = row["benchmarks"] as? [String: Any]
                return bench?["aime"] != nil || bench?["gpqa"] != nil
            }
            XCTAssertTrue(enriched, "benchmarks.json entries must enrich exported rows")
        }
    }

    func testData_isValidJSON() throws {
        let data = ModelCatalogExport.data()
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["schemaVersion"] as? Int, 1)
    }

    func testCategory_neverEmpty() throws {
        let models = try XCTUnwrap(ModelCatalogExport.payload()["models"] as? [[String: Any]])
        for row in models {
            let category = row["category"] as? String ?? ""
            XCTAssertFalse(category.isEmpty)
        }
    }
}
