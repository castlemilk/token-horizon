# Synthetic analytics fixtures — Token Horizon Track 5

**Everything in this directory is invented.** These fixtures are a reproducible specification example, not customer records, product telemetry, provider prices, invoice evidence or measured production performance. No prompts, responses, credentials, session titles, private project paths or real identities are included.

The companion [verifier](../validation/verify_synthetic.py) is a small standard-library Python oracle for the proposal's arithmetic. It does **not** implement an ingestion service, real authentication/RBAC, a privacy-preserving query service or complete production semantics. Track 6 owns the detailed production token/context accounting contract.

## Files

| File | Purpose |
|---|---|
| `ledger_fixture.jsonl` | 32 delivery rows: 29 logical requests for the main tenant, one superseded revision, one duplicate delivery and one collision in a different tenant |
| `identity_fixture.json` | Six observed profiles, two additional members without telemetry consent, overlapping Orion/Lyra crews, two synthetic projects |
| `coverage.json` | Separate source/day coverage and explicit complete-zero, unknown, outage, stale and late/provisional states; timezone cases |
| `expected_metrics.json` | Hand-specified oracle values with units, range and as-of timestamps |
| `../validation/verify_synthetic.py` | Deterministic verifier; standard library only and no network |
| `../validation/synthetic_results.json` | Actual output of the isolated verifier; 69/69 synthetic checks passed |

## Reproduce

From the deliverable root, run:

```bash
python3 validation/verify_synthetic.py
```

Python's standard `zoneinfo` module uses installed IANA timezone data. No packages or external services are required in the environment used for the recorded run. The verifier writes only `validation/synthetic_results.json` unless `--output` is supplied. Its exit code is nonzero on an assertion mismatch. Input SHA-256 values are included in the output so changed examples are identifiable.

## Identity and scope

The principal tenant is `tenant_demo_orion`. Actors `u01`–`u06` have one observed profile each. Orion has these six observed members plus `u07` and `u08`, whose roster records explicitly say telemetry consent is absent. Those two people must not be represented as zero-use users. Thus the example has **8 joined members, 6 published profiles and 6 observed actors**.

Lyra contains `u01`–`u05`. Crew totals represent full-history member contributions, mirroring the product distinction under review. They are not exclusive cost allocations. Orion has 2,960,000 tokens; Lyra has 2,240,000. Adding them gives 5,200,000 contributions while unique tenant use remains 2,960,000.

A second tenant deliberately reuses the event ID of u01's first request but contains 999,999 tokens. Scope is applied before deduplication; those tokens cannot enter Orion's query. This is a fixture assertion, **not proof that a production server enforces tenant isolation**.

Actor IDs, provider/model IDs, project IDs and session IDs are invented. Projects are explicit fixture labels; nothing is inferred from content. Session identifiers preserve two distinct sessions per actor: “first” on 11–12 November and “second” on 13, 16–17 November. “First” and “second” are opaque fixture suffixes, not session titles.

## Generation rules and corrections

The UTC event dates 11, 12, 13, 16 and 17 November 2026 use factors 1, 2, 3, 4 and 5. Actor i has i × 10,000 × factor display tokens. u06's 13 November event is missing. For this artificial example only, input is 75%, output is 25%, and display tokens equal input + output. No statement about production cache or reasoning inclusion should be derived from that simplification.

u02's 12 November event has a later revision: **30,000 tokens and USD3.75 provider-reported cost**, replacing **40,000 tokens and USD5.00**. The revision retains the original occurrence timestamp. u01's 11 November event is delivered twice at the same revision and counts once.

The event/revision identity includes tenant, source and event IDs. A duplicate with conflicting same-revision payload is rejected by the oracle rather than silently selected. Revision ordering and source IDs are trusted only because this is a deterministic fixture; real producer identity and conflict resolution need separate design and verification.

u06's 17 November request occurs at 02:00 UTC but arrives on 18 November at 05:00 UTC. Its **300,000 tokens and USD4.00 estimate** are excluded from the 00:00 as-of result and included at 06:00. The record stays assigned to 17 November. Coverage remains partial because the manifest marks it provisional until 11:00 and separately marks u04 stale for six hours.

## Exact expected results

Range is **[2026-11-11T00:00:00Z, 2026-11-18T00:00:00Z)**. The initial as-of is **18 November 00:00 UTC** and revised as-of is **06:00 UTC**.

| Metric | Initial | Revised |
|---|---:|---:|
| Distinct logical requests | 28 | 29 |
| Display tokens | 2,660,000 | 2,960,000 |
| Estimated metered amount, USD | 23.60 | 27.60 |
| Provider-reported amount, USD | 36.25 | 36.25 |
| Visible known-cost rows / all rows | 18/28 | 19/29 |
| Distinct sessions | 12 | 12 |
| Observed actors | 6 | 6 |

Amounts remain **separate cost bases**. An estimate is not an invoice. A provider-reported amount is not automatically a reconciled invoice either. Unknown and withheld amounts are null. u05 has an explicit known-zero amount, but its measurement basis is unresolved; this is not evidence of a provider-reported charge, catalog estimate, invoice or zero total operating cost.

### Availability and measurement basis are separate

The legacy `cost_basis` field in this small fixture is a **simplified scenario discriminator**, retained so the accepted oracle and output identifiers remain stable. It mixes the scenario tags `estimated_metered`, `provider_reported`, `known_zero`, `unknown` and `withheld`; it is **not the proposed production basis schema**. Each delivery now also carries the separate fields:

| Scenario | `cost_availability` | `cost_measurement_basis` | Amount | Rate eligibility |
|---|---|---|---|---|
| Estimated | `known` | `estimated_metered` | Explicit decimal | Estimated denominator |
| Provider reported | `known` | `provider_reported` | Explicit decimal | Reported denominator |
| Known zero, basis unresolved (u05) | `known_zero` | null | `0.00` | Neither basis-specific denominator |
| Unknown | `unknown` | null | null | Neither |
| Withheld | `withheld` | null | null | Neither |

Thus **19/29 is coverage of authorized visible amounts**, including five explicit zero amounts. It is not coverage of verified price/billing provenance. u05's 750,000 tokens remain separately identifiable but cannot join a reported or estimated rate until their basis is established. **If a zero amount has a verified `provider_reported` or `estimated_metered` basis, its compatible tokens must be included in that basis-specific denominator.** Zero itself is never grounds for excluding an otherwise eligible record. The oracle's existing scenario-based calculation is valid only for these explicitly defined fixture cases; it is not a general production cost classifier.

At the revised as-of:

- Estimated metered amount: **USD27.60 / 870,000 covered tokens × 1,000,000 = USD31.72413793 per million covered tokens**.
- Provider-reported amount: **USD36.25 / 290,000 covered tokens × 1,000,000 = USD125.00000000 per million covered tokens**.
- Visible known-cost row coverage: **19/29 = 65.51724138%**. Five rows are unknown and five withheld.
- The arithmetic mean of individual estimated row rates is **USD72.59259259**, which is deliberately different. A group rate must use the ratio of sums on the same eligible cohort.

These arbitrary amounts test accounting distinctions; they are not prices for real providers/models. No combined “cash spent” total is asserted.

## Missing data and zeroes

| UTC day | Observed tokens | Coverage state |
|---|---:|---|
| 11 November | 210,000 | Complete |
| 12 November | 410,000 | Complete; correction applied |
| 13 November | 450,000 | Partial; u06 has a three-hour outage |
| 14 November | null | Unknown coverage across all six sources |
| 15 November | 0 | Explicit complete zero-activity day |
| 16 November | 840,000 | Complete |
| 17 November | 1,050,000 | Partial; late/provisional u06 and stale u04 |

The numeric observed sums reconcile to 2,960,000. Null is not silently converted to zero, and partial data is not labelled a complete day. Coverage comes from the separate manifest; request presence alone does not establish completeness.

## Timezone and privacy assertions

One event at **11 November 23:30 UTC** belongs to **12 November in Australia/Melbourne**. UTC daily data cannot be relabelled as local-day totals without rebucketing timestamped data. The separate spring-forward example verifies **4 October 2026 in Melbourne lasts 23 elapsed hours**, from 3 October 14:00 UTC to 4 October 13:00 UTC.

The cohort oracle demonstrates a proposed k=5 minimum: all six actors can aggregate, a four-actor filtered subset is suppressed, and a five-of-six query is also suppressed when the full total is visible because the complement would expose one actor. Suppressed results contain null, not the hidden value.

This small illustration is **not complete privacy protection**. Production needs authorization first, coordinated hierarchical suppression, query-history/differencing controls across time and dimensions, export policy and review. The fixture does not establish differential privacy or anonymization.

## Recorded validation scope

The isolated run passed **69 checks**, including duplicate delivery, revision correction, historical as-of results, late arrival, tenant collision, half-open UTC ranges, ratios of sums, cost-basis/null handling, roster/consent distinction, overlapping crews, unknown versus explicit-zero days, timezone/DST cases and small-cohort/complement suppression.

No production source suite, installed application, live API, account permission, service performance, retention job or deployed feature was tested by this oracle.

