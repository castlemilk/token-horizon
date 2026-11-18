#!/usr/bin/env python3
"""Deterministic, stdlib-only Track 5 fixture oracle. NOT a backend implementation.

No network, account access, database writes, prompt content, or provider calls.
The checks validate invented examples and proposal arithmetic only.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_EVEN
from hashlib import sha256
import json
from pathlib import Path
import sys
from zoneinfo import ZoneInfo


# Legacy fixture scenario tags, not the production measurement-basis schema.
# u05 known_zero has cost_measurement_basis=null, so it belongs to visible
# amount coverage but neither estimated nor reported rate denominator.
VISIBLE_AMOUNT_SCENARIOS = {"estimated_metered", "provider_reported", "known_zero"}
UTC = timezone.utc


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def rounded(value):
    return str(value.quantize(Decimal("0.00000001"), rounding=ROUND_HALF_EVEN))


def canonical_rows(rows, tenant, as_of, start, end):
    """Scope first; deduplicate deliveries; select latest revision known as of cutoff.

    This fixture has trustworthy synthetic source IDs and revisions. Production
    identity/correlation contracts must be separately specified and validated.
    """
    scoped = [r for r in rows if r["tenant_id"] == tenant
              and instant(r["received_at"]) <= instant(as_of)
              and instant(start) <= instant(r["occurred_at"]) < instant(end)]
    deliveries = {}
    duplicate_count = 0
    for row in sorted(scoped, key=lambda r: (r["received_at"], r["delivery_id"])):
        key = (row["tenant_id"], row["source_id"], row["event_id"], row["revision"])
        if key in deliveries:
            clean = lambda r: {k: v for k, v in r.items() if k not in {"received_at", "delivery_id"}}
            if clean(row) != clean(deliveries[key]):
                raise ValueError("Conflicting duplicate revision must be quarantined")
            duplicate_count += 1
        else:
            deliveries[key] = row
    newest = {}
    for row in deliveries.values():
        key = (row["tenant_id"], row["source_id"], row["event_id"])
        if key not in newest or row["revision"] > newest[key]["revision"]:
            newest[key] = row
    result = sorted(newest.values(), key=lambda r: (r["occurred_at"], r["actor_id"]))
    return result, {
        "scoped_deliveries": len(scoped),
        "duplicate_deliveries": duplicate_count,
        "superseded_revisions": len(deliveries) - len(newest),
    }


def aggregate(rows):
    totals = defaultdict(lambda: Decimal("0"))
    denominators = defaultdict(int)
    basis_counts = defaultdict(int)
    for row in rows:
        basis_counts[row["cost_basis"]] += 1
        if row["cost_basis"] in VISIBLE_AMOUNT_SCENARIOS:
            if row["cost_amount_usd"] is None:
                raise ValueError("Visible-amount scenario requires an explicit amount")
            totals[row["cost_basis"]] += Decimal(row["cost_amount_usd"])
            denominators[row["cost_basis"]] += row["display_tokens"]
        elif row["cost_amount_usd"] is not None:
            raise ValueError("Unknown/withheld must not expose an amount")
    output = {
        "unique_requests": len({(r["tenant_id"], r["logical_request_id"]) for r in rows}),
        "display_tokens": sum(r["display_tokens"] for r in rows),
        "input_tokens": sum(r["input_tokens"] for r in rows),
        "output_tokens": sum(r["output_tokens"] for r in rows),
        "distinct_sessions": len({(r["tenant_id"], r["actor_id"], r["session_id"]) for r in rows}),
        "observed_actors": len({r["actor_id"] for r in rows}),
        "visible_known_cost_rows": sum(basis_counts[b] for b in VISIBLE_AMOUNT_SCENARIOS),
        "visible_known_cost_denominator": len(rows),
    }
    for basis in VISIBLE_AMOUNT_SCENARIOS:
        output[basis + "_usd"] = format(totals[basis], ".2f")
        output[basis + "_token_denominator"] = denominators[basis]
    for basis in ["estimated_metered", "provider_reported", "known_zero", "unknown", "withheld"]:
        output[basis + "_rows"] = basis_counts[basis]
    for basis, label in [("estimated_metered", "estimated"), ("provider_reported", "reported")]:
        output[label + "_usd_per_million_covered_tokens"] = (
            rounded(totals[basis] * 1000000 / denominators[basis]) if denominators[basis] else None
        )
    output["visible_known_cost_row_percentage"] = (
        rounded(Decimal(output["visible_known_cost_rows"]) * 100 / len(rows)) if rows else None
    )
    return output


def daily_series(rows, coverage):
    values = defaultdict(int)
    counts = defaultdict(int)
    for row in rows:
        day = instant(row["occurred_at"]).date().isoformat()
        values[day] += row["display_tokens"]
        counts[day] += 1
    manifests = defaultdict(list)
    for record in coverage["source_days"]:
        manifests[record["day"]].append(record)
    output = {}
    for day, records in sorted(manifests.items()):
        statuses = {r["status"] for r in records}
        status = "complete" if statuses == {"complete"} else ("unknown" if statuses == {"unknown"} else "partial")
        value = values[day] if counts[day] or status == "complete" else None
        output[day] = {"tokens": value, "status": status}
    return output


def privacy_oracle(rows, actors, k=5, visible_population=None):
    """Illustrative cohort threshold plus complementary-subset guard.

    Not differential privacy and not a complete differencing protection system.
    A production query service needs coordinated releases, query-history controls,
    hierarchical suppression and policy review across time/range/dimensions.
    """
    chosen = [r for r in rows if r["actor_id"] in actors]
    observed = {r["actor_id"] for r in chosen}
    if len(observed) < k:
        return {"status": "suppressed", "tokens": None}
    if visible_population is not None:
        complement = set(visible_population) - observed
        if 0 < len(complement) < k:
            return {"status": "suppressed", "tokens": None}
    return {"status": "visible", "tokens": sum(r["display_tokens"] for r in chosen)}


def run(data):
    ledger_path = data / "ledger_fixture.jsonl"
    rows = [json.loads(line) for line in ledger_path.read_text().splitlines() if line]
    coverage = json.loads((data / "coverage.json").read_text())
    identity = json.loads((data / "identity_fixture.json").read_text())
    expected = json.loads((data / "expected_metrics.json").read_text())
    checks = []

    def check(name, actual, wanted):
        checks.append({"name": name, "passed": actual == wanted, "actual": actual, "expected": wanted})

    check("every ledger row explicitly synthetic", all(r.get("synthetic") is True for r in rows), True)
    check("physical delivery count", len(rows), expected["delivery_checks"]["physical_rows"])
    check("input plus output equals fixture display tokens", all(r["input_tokens"] + r["output_tokens"] == r["display_tokens"] for r in rows), True)
    check("cost amounts are decimal strings or null", all(r["cost_amount_usd"] is None or isinstance(r["cost_amount_usd"], str) for r in rows), True)

    start, end = expected["range"]["from_inclusive"], expected["range"]["to_exclusive"]
    tenant = expected["tenant_id"]
    latest, diagnostics = canonical_rows(rows, tenant, expected["latest"]["as_of"], start, end)
    initial, _ = canonical_rows(rows, tenant, expected["initial"]["as_of"], start, end)
    latest_metrics = aggregate(latest)
    initial_metrics = aggregate(initial)
    orion = next(c for c in identity["crews"] if c["crew_id"] == "crew_orion")
    lyra = next(c for c in identity["crews"] if c["crew_id"] == "crew_lyra")
    latest_metrics["joined_members"] = len(orion["member_actor_ids"])
    latest_metrics["published_profiles"] = sum(len(a["profile_ids"]) for a in identity["actors"] if a["telemetry_consent"])
    lyra_tokens = sum(r["display_tokens"] for r in latest if r["actor_id"] in lyra["published_actor_ids"])
    latest_metrics.update(lyra_tokens=lyra_tokens, summed_crew_contributions_tokens=latest_metrics["display_tokens"] + lyra_tokens, unique_tenant_tokens=latest_metrics["display_tokens"])
    for key, wanted in expected["latest"].items():
        if key != "as_of": check("latest metric: " + key, latest_metrics[key], wanted)
    for key, wanted in expected["initial"].items():
        if key != "as_of": check("initial metric: " + key, initial_metrics[key], wanted)
    check("one duplicate delivery removed", diagnostics["duplicate_deliveries"], 1)
    check("one superseded revision removed", diagnostics["superseded_revisions"], 1)
    check("tenant-scoped deliveries", diagnostics["scoped_deliveries"], 31)
    corrected = next(r for r in latest if r["actor_id"] == "u02" and r["occurred_at"].startswith("2026-11-12"))
    check("correction replaces prior value", [corrected["revision"], corrected["display_tokens"], corrected["cost_amount_usd"]], [2, 30000, "3.75"])
    check("correction retains event date", corrected["occurred_at"], "2026-11-12T02:00:00Z")
    no_duplicate = [r for r in rows if not r["delivery_id"].endswith("-retry")]
    dedup_again, _ = canonical_rows(no_duplicate, tenant, expected["latest"]["as_of"], start, end)
    check("retry does not change canonical values", aggregate(dedup_again), aggregate(latest))
    before, _ = canonical_rows(rows, tenant, "2026-11-18T04:59:59Z", start, end)
    after, _ = canonical_rows(rows, tenant, "2026-11-18T05:00:00Z", start, end)
    check("late record excluded before receipt", sum(r["display_tokens"] for r in before), 2660000)
    check("late record included at as-of receipt", sum(r["display_tokens"] for r in after), 2960000)
    check("late row preserves original occurrence", next(r for r in after if r["actor_id"] == "u06" and r["received_at"] == "2026-11-18T05:00:00Z")["occurred_at"], "2026-11-17T02:00:00Z")
    others, _ = canonical_rows(rows, "tenant_demo_other", expected["latest"]["as_of"], start, end)
    check("same event ID in another tenant remains isolated", aggregate(others)["display_tokens"], 999999)
    check("other tenant has one request", aggregate(others)["unique_requests"], 1)
    check("colliding event ID deliberately present", others[0]["event_id"] in {r["event_id"] for r in latest}, True)
    one_day, _ = canonical_rows(rows, tenant, expected["latest"]["as_of"], start, "2026-11-12T00:00:00Z")
    check("UTC interval includes start and excludes next midnight", sum(r["display_tokens"] for r in one_day), 210000)

    days = daily_series(latest, coverage)
    check("daily series with explicit coverage", days, expected["daily_latest"])
    check("unknown day is null", days["2026-11-14"]["tokens"], None)
    check("complete empty day is zero", days["2026-11-15"]["tokens"], 0)
    check("partial days retain observed sum with partial status", [days["2026-11-13"]["status"], days["2026-11-17"]["status"]], ["partial", "partial"])
    check("daily numeric values reconcile", sum(v["tokens"] for v in days.values() if v["tokens"] is not None), latest_metrics["display_tokens"])
    estimate_rows = [r for r in latest if r["cost_basis"] == "estimated_metered"]
    mean_of_rates = sum(Decimal(r["cost_amount_usd"]) * 1000000 / r["display_tokens"] for r in estimate_rows) / len(estimate_rows)
    check("ratio of sums differs from invalid mean of row rates", rounded(mean_of_rates) != latest_metrics["estimated_usd_per_million_covered_tokens"], True)
    check("unknown and withheld amounts remain null", all(r["cost_amount_usd"] is None for r in latest if r["cost_basis"] in {"unknown", "withheld"}), True)
    check("known-zero amounts are explicit zero", all(Decimal(r["cost_amount_usd"]) == 0 for r in latest if r["cost_basis"] == "known_zero"), True)
    check("cost bases remain separate; no asserted invoice total", "invoice_total_usd" in latest_metrics, False)
    check("overlapping crew contributions exceed unique use", latest_metrics["summed_crew_contributions_tokens"] > latest_metrics["unique_tenant_tokens"], True)
    check("unconsented members have no telemetry rows", {r["actor_id"] for r in latest}.intersection({a["actor_id"] for a in identity["actors"] if not a["telemetry_consent"]}), set())

    melbourne = ZoneInfo("Australia/Melbourne")
    check("UTC date can differ from display timezone", instant("2026-11-11T23:30:00Z").astimezone(melbourne).date().isoformat(), "2026-11-12")
    dst_start = datetime(2026, 10, 4, tzinfo=melbourne).astimezone(UTC)
    dst_end = datetime(2026, 10, 5, tzinfo=melbourne).astimezone(UTC)
    check("Melbourne DST day has 23 elapsed hours", int((dst_end - dst_start).total_seconds() / 3600), 23)
    check("DST UTC start", dst_start.isoformat().replace("+00:00", "Z"), "2026-10-03T14:00:00Z")
    check("DST UTC end", dst_end.isoformat().replace("+00:00", "Z"), "2026-10-04T13:00:00Z")
    check("DST spring-forward skips 02 local hour", instant("2026-10-03T16:30:00Z").astimezone(melbourne).hour, 3)
    population = {r["actor_id"] for r in latest}
    check("all-six aggregate meets k5", privacy_oracle(latest, population, visible_population=population)["status"], "visible")
    check("four-actor filter suppressed", privacy_oracle(latest, {"u01", "u02", "u03", "u04"}, visible_population=population), {"status": "suppressed", "tokens": None})
    check("five-of-six differencing guard", privacy_oracle(latest, {"u01", "u02", "u03", "u04", "u05"}, visible_population=population), {"status": "suppressed", "tokens": None})

    # A conflicting same-revision delivery is a data-quality error, not silently last-write-wins.
    conflict = dict(rows[0])
    conflict["display_tokens"] += 1
    conflict["delivery_id"] += "-conflicting"
    conflict_raised = False
    try:
        canonical_rows(rows + [conflict], tenant, expected["latest"]["as_of"], start, end)
    except ValueError:
        conflict_raised = True
    check("conflicting duplicate revision rejected", conflict_raised, True)

    # JSON-friendly check output, including the empty-set check above.
    checks = json.loads(json.dumps(checks, default=lambda v: sorted(v) if isinstance(v, set) else str(v)))
    files = ["ledger_fixture.jsonl", "coverage.json", "identity_fixture.json", "expected_metrics.json"]
    return {
        "status": "PASS" if all(c["passed"] for c in checks) else "FAIL",
        "scope": "Synthetic specification oracle only. Not production telemetry, a benchmark, backend/RBAC verification, or deployed behavior.",
        "fixture_version": "track5-synthetic-v1",
        "checks_passed": sum(c["passed"] for c in checks),
        "checks_total": len(checks),
        "input_sha256": {name: sha256((data / name).read_bytes()).hexdigest() for name in files},
        "latest_synthetic_metrics": latest_metrics,
        "invalid_mean_of_estimated_row_rates_for_comparison_only": rounded(mean_of_rates),
        "checks": checks,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path(__file__).resolve().parents[1] / "data")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "synthetic_results.json")
    args = parser.parse_args()
    result = run(args.data)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": result["status"], "checks_passed": result["checks_passed"], "checks_total": result["checks_total"], "output": str(args.output), "scope": result["scope"]}))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
