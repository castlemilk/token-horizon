# Track 5 UI analytics source audit

**Status:** read-only source audit, not a deployed-system certification. No app was launched, no live personal profile was read, and no application tests were executed by this reviewer. Root is separately checking anonymous public routes. All product capabilities below are **source-present at the pinned commit** unless explicitly identified as a proposal.

**Repository:** https://github.com/castlemilk/token-horizon  
**Branch at retrieval:** main  
**Commit:** b468206e9378c8d7a6788b67072494982e7de17d  
**Commit date:** 2026-11-18T07:35:19Z  
**Audit date:** 2026-11-18 (Australia/Melbourne user date)  
**Evidence custody:** ui-source-manifest.json lists 14 fetched files and Git blob SHAs. Isolated source copies were read through the GitHub connector at this exact ref; raw source copies are omitted from this package to avoid redistributing historical user examples. No shared source modifications.

## Executive finding

Do not create a generic new dashboard or new team-history ticket. Source already has a substantial personal published Workspace, public individual profile, multi-team comparisons, UTC team histories, day inspection, model/provider analytics, native usage history, and a native reporting-only Teams tab. The highest-value Track 5 increment is a common analytics contract with explicit populations, coverage, costs, time windows, missingness, attribution and provenance, then consistent self/team/admin views consuming that contract. The current public social teams are not an enterprise tenant model, and sign-in does not turn public published snapshots into private device analytics.

The strongest immediate source findings are:

1. Workspace's Today / 7 days / All time control is explicitly a **Summary period**. Tokens/cost switch period, requests use today or all-time, model count is always all-time, model/project/source tables are all-time, and its graph uses the last 7 reported dates for Today and 7 days, or last 28 reported dates for All time. This is labelled in parts of the UI but is not a single filtered analysis. Sparse report dates can span more than a week. A new unified range must not silently claim those older breakdowns are filtered.
2. Costs intentionally collapse zero, hidden and unavailable into a dash. Safe presentation is already present; schema semantics remain unresolved. Do not reverse this to a fabricated zero or invoice total.
3. Community team history preserves unreported days as null; team detail history converts them to zero-height bars and divides its displayed Daily average by every day in the requested window. This is labelled as potentially partial, but the distinction is lost numerically. Native usage history averages only active nonzero buckets. Those are three different semantics that require explicit names and denominators.
4. Export capability is not established by the UI option. The share modal persists an Allow download (CSV / PDF) preference, while the inspected shared-report renderer exposes no CSV/PDF generation or download action. Backend reviewer independently found allowDownload only normalized, not enforced by an export route.
5. Existing public gamification includes rank, streak, percentile, MMR and Efficiency. Keep those out of operational self/team/admin decision KPIs; token volume cannot establish productivity.

## Evidence register / exact citations

Use the following immutable URLs; line numbers refer to fetched copies.

| ID | Evidence |
|---|---|
| U01 | [Workspace full source](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/workspace.js) |
| U02 | [SPA analytics source](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html) |
| U03 | [Current product contract](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/PRODUCT.md) |
| U04 | [Leaderboard design/alignment documentation](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/LEADERBOARD.md) |
| U05 | [Native history view](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/UI/UsageHistoryViews.swift) |
| U06 | [Native Teams view](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/UI/TeamsViews.swift) |
| U07 | [Crossplatform tokens view](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/crossplatform/app/components/token-horizon/tokens-tab.tsx) |
| U08 | [Electron app activity view](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/app/app/components/token-horizon/activity-tab.tsx) |
| U09 | [Existing render benchmark](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/bench-leaderboard.mjs) |
| U10 | [Workspace regression suite](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/test-workspace-ui.mjs) |
| U11 | [Public profile regression suite](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/test-profile-ui.mjs) |

## Implemented-source capability inventory

| Surface | Source-present behavior | Analytics limit / useful next increment |
|---|---|---|
| Workspace identity and scope | Owned-profile discovery; explicit public preview; signed-out / checking / loading profiles / choose / empty / failed states. No implicit choice of a community profile. U01 L69–138; SPA route controller L3313–3415. | This analyzes one published profile. It is not private per-user telemetry, a multi-profile union, or a tenant finance view. |
| Workspace freshness | Snapshot status, relative publish time, stale after 24 hours, tooltip with exact publication time; stale day/week labels become Snapshot day and 7 days at snapshot. U01 L57–89, L141–149. | Publish timestamp is not a capture watermark. Add collected-through / last ingest / expected source counts only when source contract exists. |
| Workspace summary | Tokens, estimated USD cost, requests, active models. U01 L141–149. | Requests has only Today/all-time; active models all-time. Zero/hidden/unavailable cost all dash. No previous-period comparison. |
| Workspace graph | Provider stacks from modelHistory; fallback daily/history total; top four providers plus Other; 7 or 28 **published dates**. U01 L152–196. | No calendar-fill, shared range, cost trend, timezone picker, or per-day drilldown/table. No distinction between incomplete provider day and zero in sums. |
| Workspace models | All-time model/provider tokens, estimates, requests; expanded input/output, search, sort and 50-row Show more; catalog cross-links. U01 L217–230. | No date/range filtering or stable export; no captured-cost coverage. |
| Workspace activity | Latest 5 or 100 sessions; title private placeholder; local-time metadata; up to 20 projects; all-time capture sources. U01 L233–246. | Session caps are a partial published list, not total sessions. Project/sources have no selectable temporal dimension or team cost allocation. |
| Workspace Optimize | Evidence-based model comparison, largest published model-cost concentration, largest published session. No savings assumed. U01 L204–214, L265. | Treat as review suggestions. No actual budget threshold, alert delivery or causal savings inference. |
| Individual public profile | Overview/Usage & Costs/Prompts/Projects/Comparisons/Achievements; per-profile 7/30-day UTC provider stacks; 17-week day picker; catalogue links; documented bounds. U02 L2911–3135. | Public gamification remains separate from operational analytics. Prompts tab is opt-in session titles, keyword-category inference, not a work-quality score. |
| Profile attribution | Duplicate provider-model/day rows use max; provider breakdown above known total is reset to Unattributed; remainder is Unattributed. U02 L2935–3021. | Conservative visualization exists. Do not infer provider allocation from all-time proportions. Cross-track semantic agreement still needed. |
| Public team comparisons | Today/Last 7 days/All time; totals or per reporting published profile; partial/missing-window labels; explicit multi-team double contribution note. U02 L5291–5315. | Membership, published profiles and reporting profiles are different denominators. Summing team totals is membership-weighted, not organization unique usage. |
| Community team history | 7/30/119-day UTC history, null gaps, top four teams plus Other, daily value table, keyboard day inspector, jump-to-peak; mode/window in URL. U02 L5259–5262, L5317–5403. | This already solves a substantial part of a generic request for team time series. Extend it rather than re-ticket it. |
| Individual team detail | UTC 7/30/119-day total, daily average, active days, peak, chart, day slider and exact daily table. U02 L5406–5457. | Missing dates are zero-filled; full-window denominator and active-day label need clearer coverage semantics. No all-member cost allocation/temporal join. |
| Team profile contributions | All-time public profile contributions and percentages with top-profile disclosure. U02 L5460–5463. | Preserve label as contribution, not employee productivity ranking. |
| Provider analytics | All-time published totals/costs/input/output/requests/users/shares and history, catalog cross-links. No latency/success columns. U02 L3576–3618; U04 Screen 5. | `cost / all tokens` may understate known-cost intensity when costs hidden. Serving provider vs model family is separately attributed. |
| Billing route | Simply opens Workspace Models & costs for selected profile. U02 L5627–5629. | Do not describe this as invoice reconciliation, organizational billing or budget management. |
| Shared reports | Audience/expiry/privacy configuration; read rendering includes totals, chart, calendar, model allocation, guarded sign-in/no-access states. U02 L5783–5913, L6412–6464. | CSV/PDF option at L5814 is not an implemented download path in inspected UI. Public access is separate from team management. |
| Native history | Local trend windows and 24/52-week calendar, responsive layout, reduced motion; average across active buckets. U05 L13–15, L33–73, L78–103. | Average uses nonzero buckets; label must specify units (hour/day/week) and denominator. No enterprise insight implied. |
| Native Teams | Read-only cloud aggregates with local published-entry fallback; explicit cloud/local badges, cached refresh errors; Today/week/all; account management links to web. U06 L3–6, L49–161. | Profile memberships and duplicated contributions explicit; selected member table remains ALL-TIME regardless of top period. U06 L328–368. |
| Crossplatform tokens | Local stats/trends/history/heatmap/limits polling, 1D/1W/1M/3M/1Y, tool/model/project/session tables. U07 L9–38, L70–188. | Missing stats default to zero and tables no data; distinguish collecting/failed from true zero. Model/project/session limits are 25/15/15, no complete dataset export shown. Existence in main is not proof of released distribution. |
| Electron app activity | Local tool totals and discovered Claude accounts. Null stats says Connecting; no usage says No usage recorded plus capture setup. U08 L38–81, L85–105. | No common range or historical analysis here; another client, not equivalent to web Workspace. Do not include emails from local data in team artifacts. |

## P0 source-derived repairs / contract work

### P0-A: Preserve missingness and show the denominator

**Finding:** teamDailyWindow deliberately includes `reported`, but teamHistoryHtml converts all points to `tokens` and has no nulls; the average is total / points.length. The community time-series correctly reads `reported ? tokens : null`. U02 L5365, L5406–5420. Native History average is total / nonzero active buckets, U05 L34–65.

**Recommendation:** share one typed reading `{ value, status, observed_sources, expected_sources }`; choose labels such as Calendar-day average (partial coverage), Average per reported day, or Average per active bucket. A missing day is visually gapped, a reported zero is visibly zero, and a partial day is marked. For inherited payloads expected-source denominator remains Unknown; do not manufacture completeness.

**Acceptance:** synthetic window with 7 calendar days, 2 reported positive days, 1 reported zero, 4 absent days. Show calendar denominator 7 and reported denominator 3 only where actual completeness supports them; gap count 4; chart table/chart same values; no false “0 usage” on absent days. A series whose only reported values are zero must still show a reported-zero state rather than Collecting history.

### P0-B: State scope without pretending old snapshots can be queried as events

**Finding:** U01 L142–149 chooses mixed summary denominators; chart L171 selects last 7/28 reported dates; models L218 and sources L246 explicitly all-time. U02 L3033–3035 explicitly says owner-local aggregate day/week cannot be assigned UTC boundaries from publication time.

**Recommendation:** Phase 1 preserve legacy panels with explicit independent scope badges, remove ambiguity around Today, and add coverage metadata. Phase 2 supports a single range through a real UTC/event or hourly contract; daily-only UTC history cannot be accurately rebucketed to arbitrary IANA zones. Do not rescale or interpolate historical snapshot scalars.

**Acceptance:** sparse dates, stale snapshot, Australian daylight-saving transition, viewer timezone changes, and near-midnight publication produce no reinterpreted legacy “today”; summary, chart, table, export each disclose their actual range; unavailable requested grain returns a declared limitation.

### P0-C: Cost availability and cost basis

**Finding:** U01 L18, L149 and U02 L2934 use positive-number checks; zero/hidden/unavailable are deliberately ambiguous; provider view ratios use total cost over all tokens (U02 L3580–3600). This cannot establish invoiced spending.

**Recommendation:** new contract distinguishes known zero, estimated, reported/billed, hidden, unknown, unsupported and currency. Sum known components; show amount plus coverage; denominator for cost intensity includes exactly the records whose costs are known and comparable. Track 6 owns token counting/reasoning/cache semantics and Track 1 owns commercial positioning. Avoid invented savings.

**Acceptance:** known zero stays 0.00; unavailable stays —; hidden never leaks through totals/differences; model and provider totals reconcile to same selected record set; refunds/adjustments remain separate ledger entries if eventually supported.

### P0-D: Retain identity and request isolation protections

**Finding:** current Workspace already resolves owned handles and does not fall back to another publisher. Private API reads bypass cache, force no-store and reject stale identity results (U02 L1520–1564). Tests exercise wrong-profile, stalled identity/profiles, old-session 401 races, and selected-profile reuse (U10 L110–380).

**Recommendation:** make these invariants release gates for new analytics, including URL filters, exports and downloadable job authorization. Track 2 supplies tenant context, authorization role and membership changes; Track 5 must not infer tenant privileges from public profile/team links.

**Acceptance:** switch user/tenant during slow query; revoke membership before export download; no earlier user's data survives or cached key collision; private read failure never shows 0, empty account or another profile.

## P1 additions supported by source dimensions

- **Self overview:** selected profile, data scope, freshness/coverage header; observed tokens, known cost estimates + coverage, request count + coverage; date-comparable trend only after contract. Model/provider concentration → model detail; project allocation → project detail; session metadata → local device trace action for owner. Existing Optimize suggestions remain review prompts.
- **Team overview:** selected authorized tenant/team, roster/reporting population and explicit attribution mode; totals, cost coverage, source freshness, provider/model/project stacks; project budgeting only once actual allocation exists. Default sorted project/model concentration, not named-user token rankings. Per-user breakdown is permissioned reconciliation with names masked where policy requires.
- **Admin measurement health:** source failures, last watermark, late records, duplicate suppression, attribution unknown, retention state, export audit. This is a proposed data-quality surface, not currently implemented enterprise admin.
- **Comparisons:** equal local calendar windows where event granularity supports it; explicit completed/partial-period cutoffs, consistent filters and denominator. Baseline zero displays New/No baseline; no infinite percentage. Changes in population or coverage flagged before presenting delta.
- **Drilldown:** top-level card → exact filtered breakdown → dated bucket → record/session metadata; preserve filter URL and query version. Every sum can be reconciled to a table. Unknown/Other is inspectable without identity leakage.
- **Export:** backend-generated filtered CSV/JSON plus metadata manifest; PDF is presentation only after CSV parity. Enforce the same tenant, scope, retention and redaction policy at job creation and fetch. Export schema documents timezone, half-open range, granularity, currency/basis, denominator, coverage, query version, as-of, suppression and truncation. The existing allowDownload field must either be enforced or removed until implemented. CSV formula escaping, bounded max rows and expiry are proposed requirements.
- **Alerts:** do not promise live cost/latency/anomaly alerts from hosted published snapshots. U01 L265 says latency/errors/cache/quota require local data; anomalyRows helper in U02 L2894 has no call site found. Start with on-screen stale/incomplete snapshot notices. Future budget/freshness alert policy needs reliable ingest/watermark and permissioned channel with cooldown/dedup/recovery; no notifications were sent in research.

## Existing performance/test evidence (not executed)

The existing hermetic benchmark defines 120 profiles/30 days and 3,000 catalog models. It is a regression budget, **not a measured production SLA**: U09 L6–29, L40–48, L275.

| Existing budget | Value |
|---|---:|
| Cold load to first chart | 1,500 ms |
| Warm view switch median / p95 | 60 / 150 ms |
| Search to table incl. debounce | 260 ms |
| Idle unchanged tick | 150 ms; no render |
| Extra chart mounts after warm-up | 0 |
| Model explorer search incl. debounce | 300 ms |
| Model explorer DOM window | max 60 rows |

SPA uses content-keyed chart definitions/mounted host reuse and null-capable line data (U02 L1322–1348), public-read TTL 30 seconds and full-body deadline 5 seconds (L1468–1488); private reads no-store (L1520–1564). Extend existing gates to new views. Do not replace them with invented current performance measurements. New tenant aggregation/data-cardinality load tests remain proposed.

U10 L381–413 covers private-title placeholders, model search/tabs, local-only boundary, and mobile overflow. U11 L168–215 and L368–406 cover local-window aggregate labels, UTC daily picker, explicit gateways, Unattributed remainder and missing/empty history fallbacks. These are important regression anchors; tests were inspected, not run.

## Cross-track boundaries

- **Track 2:** owns navigation/team-management shell, account lifecycle, tenant membership, role resolution and consent controls. Track 5 consumes a verified scope/permission object; does not redesign invites or duplicate crew UI.
- **Track 6:** owns canonical input/output/cache/reasoning/context meanings and data-quality source contracts. Track 5 owns numerator/denominator display, coverage, filters, ranges, comparison/export semantics. Shared contract must be versioned.
- **Track 3:** project/knowledge attribution may provide stable project IDs later. No content mining of prompts is necessary for analytics launch.
- **Track 1:** measured savings/ROI and budget monetization need validated costs and task outcomes; token volume alone is not productivity.
- **Track 4:** public discovery/community pages are separate from private analytics; never expose tenant filters or export URLs to SEO/indexing.

## Gaps and caveats

This audit did not establish current native build/release SHA, run local agents, read a user's unpublished device data, test tenant API behavior, execute browser export, or benchmark production. Source tree includes parallel clients with materially different behavior; do not infer parity from existence. Some LEADERBOARD.md screen checkmarks are historical narrative: current Billing is Workspace Models & costs and current Product explicitly excludes client-only default sharing toggles/unsupported Comment/Edit controls. Treat actual source as stronger evidence than stale narrative. No private personal usage, prompt text, credentials, or screenshots are in these notes.


