# Token Horizon Track 5 — issue and project-context audit

**Audit date:** 18 November 2026 (Australia/Melbourne); GitHub timestamps below are UTC.
**Source baseline:** `main` at `b468206e9378c8d7a6788b67072494982e7de17d`.
**Mode:** read-only. No issue, comment, PR, repository, permission, setting, deployment or third-party message was changed.
**Purpose:** deduplicate analytics-view work and constrain proposals to the current product/data contract.

## Coverage and exact inventory

The [all-state issues endpoint](https://api.github.com/repos/castlemilk/token-horizon/issues?state=all&per_page=100&page=1&sort=created&direction=desc) returned **46 numbered objects**, below the 100-row page limit. GitHub's endpoint includes PRs:

- **31 regular issues: 31 open, zero closed.**
- **15 PRs: two open drafts, 13 closed.**
- Of the 13 closed PRs, **12 are merged** and **#24 is closed unmerged**.
- A second [closed-state inventory](https://api.github.com/repos/castlemilk/token-horizon/issues?state=closed&per_page=100&page=1) independently returned the same 13 closed PRs and no closed regular issue.

All 46 titles, states, dates and bodies were retrieved; the substantive overlap bodies were read in detail (#12–16, #19, #23, #26, #30, #33, #36, #38–41, #44; PRs #4, #5, #8, #11, #24, #25, #45). All available comments on the six records carrying comments (#18, #19, #23, #24, #26, #27) were retrieved. Comments on #19/#23 refine current provenance/rendered-validation acceptance. The long #26 historical research preservation is context, not a new test result.

Public primary project documents inspected at the pinned commit: [PRODUCT.md](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/PRODUCT.md), [LEADERBOARD.md](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/LEADERBOARD.md), [docs/sync-consistency.md](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/sync-consistency.md), and current [render budget source](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/bench-leaderboard.mjs). AGENTS.md was retrieved for implementation constraints; no repo work was performed.

The README and LEADERBOARD designate **https://token-horizon.dev/** and **https://token-horizon.dev/leaderboard** as canonical. Live-page verification belongs to the root study; this sub-audit did not infer deployment from GitHub state.

## The strongest existing anchors

| Existing record | State and latest issue update | Existing scope | Track 5 treatment |
|---|---|---|---|
| [#12](https://github.com/castlemilk/token-horizon/issues/12) — preserved research roadmap | Open; 2026-11-11 04:42:31Z | THR-03 accounting records; 04 observation identity; 05 reconciliation; 06 snapshot correction; 07 tariff provenance; 08 private allocation; 09 capability registry; 10 core integrations; 12 plans; 13 daily budget view; 25 publication preview; 30 agency attribution; 31 cost to serve; 32 private team collaboration | Primary parent. Attach this specification or create carefully bounded child tasks only after review; do not recreate these epics. |
| [#13](https://github.com/castlemilk/token-horizon/issues/13) — truthful observability | Open; 2026-11-11 04:42:46Z | Request/attempt identity, requested vs actual model/provider, reported/inferred/missing/partial usage, measured timing, retries/cancellation, cost categories, stale/denied states | Extend with analytics query, denominator, filtering, drilldown and export acceptance. Track 6 owns token/context details. |
| [#16](https://github.com/castlemilk/token-horizon/issues/16) — work handoff, plans, setup | Open; 2026-11-11 04:42:56Z | Reviewed context export; destinations/capabilities; renewals/commitments vs observed usage; secret exclusion and partial export | Dependency for plan-state cards and explicit export preview. Do not duplicate handoff workflow or memory integration. |
| [#19](https://github.com/castlemilk/token-horizon/issues/19) — pricing provenance | Open; 2026-11-18 03:56:17Z | Exact identity/currency/unit/cache/source/date, free/covered/unavailable/unpriced/stale; builds on THR-07 | Reuse provenance contract in cost cards, comparisons and exports. Detailed rates remain Track 6 / catalog owner work. |
| [#23](https://github.com/castlemilk/token-horizon/issues/23) — rendered/a11y/performance validation | Open; 2026-11-18 03:56:52Z | Desktop/mobile, keyboard/screen reader, loading/empty/error, lab/field performance, indexing | Add Track 5 route/state cases; no separate generic accessibility/performance epic. SEO remains Track 4. |
| [#44](https://github.com/castlemilk/token-horizon/issues/44) — render-budget diagnosis | Open; 2026-11-17 04:00:09Z | Historical view-switch median 62.1ms versus 60ms threshold, p95 128.9ms versus 150ms; explain cause without relaxing budgets | Preserve budget and add analytics workloads. Historical figures are issue-reported; not remeasured here. |
| [#36](https://github.com/castlemilk/token-horizon/issues/36) — browser fixture lifecycle | Open; 2026-11-17 03:59:06Z | Shared fixture setup, network blocking, contexts/cleanup and scenario parity | Place synthetic tenant/privacy/export/late-data tests in this fixture effort. Do not create competing harness. |
| [#26](https://github.com/castlemilk/token-horizon/issues/26) — authoritative checks | Open; 2026-11-18 00:30:40Z | Preserve CI superset; single manifest and explicit result propagation | Wire analytics test cases through the agreed manifest. |
| [#39](https://github.com/castlemilk/token-horizon/issues/39) — hermetic default MCP tests | Open; 2026-11-17 03:59:43Z | Replace potentially live default tests with owned fixtures; publish separately opt-in | Never validate this research with a test command that might publish personal telemetry. |
| [#41](https://github.com/castlemilk/token-horizon/issues/41) — publication lineage | Open; 2026-11-17 03:59:59Z | Trace source commit to actual published catalog/deployment evidence | Preserve source-only vs deployed distinctions; no deploy was verified in this sub-audit. |

### Closed/merged work that must not be recreated

- **[PR #4](https://github.com/castlemilk/token-horizon/pull/4)** merged 2026-10-07 21:40:49Z (merge `5c0e34e1956f1b0be648aded145b25e7d953f954`): metadata-only MCP surfaces, hosted/local separation, full-stream gateway usage extraction, requested/returned IDs, completion/usage coverage, optional body capture, cancellation finalization. The PR explicitly said feature deployment and routing activation had not occurred at its original completion. Merger proves source inclusion, not current production activation.
- **[PR #5](https://github.com/castlemilk/token-horizon/pull/5)** merged 2026-10-07 22:04:28Z (merge `624464e33a1b5f8d7ecb297c4f58b1c6c3c93851`): readable MCP usage labels, grouped values, USD formatting and explicit estimate/invoice provenance. Extend this principle across views instead of reopening the same fix.
- **[PR #8](https://github.com/castlemilk/token-horizon/pull/8)** merged 2026-10-24 06:38:42Z: independent managed-account identity namespace, provider verification, HttpOnly sessions and scope preservation. Not evidence of enterprise admin roles.
- **[PR #11](https://github.com/castlemilk/token-horizon/pull/11)** merged 2026-11-05 05:31:49Z: durable MCP refresh rotation and retry behavior. It is existing auth infrastructure, not an analytics ingestion system.
- **[PR #25](https://github.com/castlemilk/token-horizon/pull/25)** remains an open draft at `71312217bdf3f3a7d28a3b86fea78e42b5f9ecb1`, explicitly restricted to default-disabled homepage GA4. It excludes native, dashboard, account and profile telemetry. It supersedes [closed-unmerged #24](https://github.com/castlemilk/token-horizon/pull/24). Do not treat marketing analytics as Track 5 usage telemetry.
- **[PR #45](https://github.com/castlemilk/token-horizon/pull/45)** remains an open draft addressing [#27](https://github.com/castlemilk/token-horizon/issues/27) animation sampling. Coordinate test edits rather than duplicating its one-file patch.

## Existing capabilities the proposed specification must preserve

These are **source/documented behavior**, not new runtime measurements from this sub-audit.

1. **Owned-profile Workspace already exists.** PRODUCT.md and LEADERBOARD.md describe Overview, Models & costs, Activity and Optimize, loading owned profiles from a verified account endpoint. It analyzes published snapshots, not private device data. No profile or community total may substitute for the current person's unavailable data. The present empty/loading/error/retained-stale-snapshot states are a foundation, not future inventions.

2. **Team comparison and daily history already exist.** Today / last seven days / all time comparisons, all-time provider mix, 7/30/119-day UTC team histories, omitted missing days, retained explicit zeroes, no interpolation, keyboard day inspector and exact table, and public team detail `stats.daily` are documented in LEADERBOARD.md lines 583–641. Existing lines use top four teams plus Other; identities remain stable by all-time usage. A proposal for another generic team trend chart would duplicate this work. Better increments are denominator/coverage clarity, authorized attribution, reproducible custom filters and exact export.

3. **Membership does not imply coverage.** Account members, published profiles and profiles reporting the chosen window are separate populations. Current team sums are voluntarily published contributions. A profile contributes full published history once to each joined team. Combining teams double-counts overlapping profiles by design. Global uniqueness is per published profile, not demonstrated unique person or charge. Private cost allocation needs THR-08 rather than summing community/team totals.

4. **Snapshot correction safeguards already exist.** `docs/sync-consistency.md` states coherent capture under engine lock and SQLite read transaction; original UTC-hour/day keys; `collectedAt` capture ordering distinct from `updatedAt` publication; conditional R2 ETag commit/retry; complete incoming model group replacement per covered day; remote-only days retained; idempotent retries; downward corrections; stale capture rejection. Cumulative ranking snapshots are not daily usage. Daily totals remain authoritative when split groups disagree, with unresolved Other. Proposed new event provenance must retain these controls.

5. **Privacy is not a cosmetic view switch.** Published metadata may be visible while titles/costs are hidden. Current team reports check authoritative membership, not name/domain. Existing sharing/owner capabilities do not establish a general tenant-admin analytics service. PRODUCT.md rejects unsupported Comment/Edit matrices and local-only default rules as capabilities. An admin hierarchy needs explicit backend permissions and a tenant dataset before a UI can claim them.

6. **Documentation contains historical drift.** LEADERBOARD.md's early Screen 7 section describes client-side “Default Sharing Rules,” whereas PRODUCT.md explicitly excludes them from current capabilities. LEADERBOARD.md repeats an older “weekly” catalog refresh description and older schema versions. Use source inspection to settle such conflicts and label documentation claims; do not treat every checkmark as a runtime receipt.

7. **No token-based productivity ranking.** PRODUCT.md explicitly describes tokens as activity, not productivity. Existing public league/MMR/efficiency calculations must not become team-performance, employee value or task quality metrics. Outcome or quality analysis needs explicit task outcomes and comparable cohorts, as #12 already says.

## Canonical backlog location

The final, deduplicated backlog is section 12 of `../token-horizon-track5-specification.md`. That specification owns the T5-01 through T5-10 identifiers, effort estimates, dependencies and acceptance mapping. Preliminary sub-audit planning rows are intentionally omitted here to prevent conflicting identifiers. `../issue-map.json` preserves the complete issue inventory and final per-record disposition.

## Existing performance values and what is not measured

Current `scripts/bench-leaderboard.mjs` declares: cold load→chart **1,500ms**, view switch median **60ms**, p95 **150ms**, search→table **260ms**, idle check **150ms**, **zero** extra chart mounts after warmup, explorer search **300ms**, max **60** DOM rows for a 3,000-model list. These are existing thresholds, not measurements made in this audit. #44's historical failure should remain its own diagnosis.

No tests, local daemon, provider inference, production telemetry publish, signing-in flow or private data query was executed here. No live latency, scale limit, request completeness rate, customer usage, cost total or savings is claimed. Source/documentation support does not by itself establish a currently deployed or working feature.

## Files

The packaged [issue-map.json](../issue-map.json) retains all 46 record identifiers, titles, states, update dates, URLs and final Track 5 dispositions. Raw issue bodies, comments and complete repository source copies are intentionally excluded. The adjacent source manifests and immutable links identify the inspected evidence without redistributing historical usage examples.

