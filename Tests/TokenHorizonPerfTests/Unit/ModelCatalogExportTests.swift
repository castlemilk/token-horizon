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

    func testPricing_neverClaimsFreeWithoutEvidence() throws {
        // Regression: subscription-plan models (Kimi Code, Copilot, …) publish
        // `cost: 0`, which used to surface as "Free" with a fake $0.04 blended
        // price. Zero-price rows may only be free with explicit evidence.
        let models = try XCTUnwrap(ModelCatalogExport.payload()["models"] as? [[String: Any]])
        var unknown = 0
        for row in models {
            XCTAssertNotNil(row["priceKnown"] as? Bool, "every row carries priceKnown")
            let input = row["inputPerM"] as? Double ?? 0
            let output = row["outputPerM"] as? Double ?? 0
            guard input == 0, output == 0, row["isLocal"] as? Bool != true else { continue }
            let isFree = row["isFree"] as? Bool ?? false
            let known = row["priceKnown"] as? Bool ?? true
            if isFree {
                let hay = ((row["name"] as? String ?? "") + " " + (row["id"] as? String ?? "")).lowercased()
                XCTAssertTrue(hay.contains("free"),
                              "zero-price row claimed free without evidence: \(row["id"] as? String ?? "?")")
                XCTAssertTrue(known, "explicitly free rows must have known pricing")
            }
            if !known {
                unknown += 1
                XCTAssertNil(row["blendedNetCost"], "unknown pricing must not carry a blended cost")
                XCTAssertNil(row["effectiveInputPerM"], "unknown pricing must not carry an effective price")
            }
        }
        XCTAssertGreaterThan(unknown, 0, "catalog contains plan/unknown-priced rows to guard")
    }

    func testTopPicks_carryPriceKnown() throws {
        let picks = try XCTUnwrap(ModelCatalogExport.payload()["topPicks"] as? [[String: Any]])
        for pick in picks {
            XCTAssertNotNil(pick["priceKnown"] as? Bool)
        }
    }

    func testPlans_carryTiersAndModelLinkage() throws {
        let payload = ModelCatalogExport.payload()
        let plans = try XCTUnwrap(payload["plans"] as? [[String: Any]], "plans array missing")
        XCTAssertFalse(plans.isEmpty, "curated plans.json must ship")
        XCTAssertNotNil(payload["plansUpdatedAt"] as? String)
        let ids = Set(plans.compactMap { $0["id"] as? String })
        XCTAssertTrue(ids.contains("github-copilot"))
        // Curated tier data for the plans we have verified, docs for the rest.
        let copilot = try XCTUnwrap(plans.first { $0["id"] as? String == "github-copilot" })
        let tiers = try XCTUnwrap(copilot["tiers"] as? [[String: Any]])
        XCTAssertEqual(tiers.count, 7)
        XCTAssertEqual(tiers.first?["name"] as? String, "Free")
        XCTAssertEqual(tiers.first?["priceMonthly"] as? Double, 0)

        // Rows covered by a plan reference a curated plan id, and k3's plan is
        // Kimi Code rather than a fabricated price.
        let models = try XCTUnwrap(payload["models"] as? [[String: Any]])
        let linked = models.filter { ($0["plans"] as? [String])?.isEmpty == false }
        XCTAssertFalse(linked.isEmpty, "plan-covered rows must link to a plan")
        for row in linked {
            for planId in (row["plans"] as? [String]) ?? [] {
                XCTAssertTrue(ids.contains(planId), "row references unknown plan \(planId)")
            }
        }
        if let k3 = models.first(where: { $0["id"] as? String == "kimi/k3" }) {
            XCTAssertEqual(k3["plan"] as? String, "kimi-for-coding")
        }
    }
}
