# Token Horizon: team and individual analytics
## Track 5 research and implementation specification

**Research date:** 18 November 2026, Australia/Melbourne  
**Repository:** https://github.com/castlemilk/token-horizon  
**Source baseline:** main at b468206e9378c8d7a6788b67072494982e7de17d  
**Commit timestamp:** 2026-11-18T07:35:19Z  
**Status:** read-only research; reviewable proposals; no production changes  
**Track boundary:** Track 2 owns identity, teams and the management shell. Track 6 owns canonical token, request, context and cost semantics. This document owns analytics questions, views, metric populations, range/filter contracts, comparisons, drilldowns, exports and acceptance.

## 1. Recommendation

**Improve the trustworthiness of the existing analytics before adding a private team dashboard.** The live public product and inspected source already establish substantial published-profile Workspace and team analytics; the source also contains provider/model views and native local analytics. A second generic dashboard would duplicate existing work. The most valuable increment is a common measurement contract, applied first to current views, then to a properly authorized private reporting service. [S01] [S02] [S03] [S04]

The sequence should be:

1. Repair calendar-range, denominator, missing-data and public-response inconsistencies. Preserve existing snapshot reconciliation and ownership safeguards.
2. Add explicit cost states, capture freshness and source-coverage metadata. Keep old payloads conservative.
3. Make self analytics and existing public team analytics coherent under the supported data grain.
4. Introduce private project/team allocation and admin data-quality reporting only after tenant authorization, consent, retention and ingestion contracts exist.
5. Add reproducible exports and coverage-aware advisories on that foundation.

The proposed dashboards answer concrete questions: What changed in my observed usage? Which models or projects account for a known cost? Which sources are missing? Can this total be reconciled? They do not rank employee productivity, task quality or business value from token volume.

### Highest-priority findings

| Finding | Evidence and implication | Disposition |
| --- | --- | --- |
| Calendar windows are inconsistent | Workspace and one worker helper select the last N reported dates. Sparse activity can bring much older observations into a nominal recent window. | P0 repair; extend [#13](https://github.com/castlemilk/token-horizon/issues/13) and [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-06/13. |
| A weekly ratio can use an all-time denominator | The worker selects week tokens but today-or-all-time request counts. Workspace labels its request card separately, but there is no shared query contract. | P0 repair; show unavailable until a same-window denominator exists. |
| Missing days are not represented consistently | Community team history uses null gaps; team detail converts absent dates to zero-height values and divides by all selected days. | P0 repair; explicit reported-zero, missing and partial states. |
| Cost zero, withheld and unknown collapse together | The publisher writes zero when cost sharing is off; current Workspace deliberately displays a dash and explains the ambiguity. | P0 schema extension, with backwards-compatible unknown state. |
| Public response uses a denylist | The sanitizer does not remove a legacy email field populated in auth/claim paths. An isolated synthetic check confirms retention by the helper. | P0 privacy repair; allowlisted public DTO. No live leak established. |
| Teams are membership contributions | The same profile contributes its full published history to every joined team. Summing teams is not unique organization usage or expense allocation. | Preserve current public semantics; separate future private allocation. |
| Export control is not a complete export capability | allowDownload is persisted, but the inspected report renderer and backend do not establish a corresponding enforced CSV/PDF export route. | Treat export as proposed until implemented and tested. |

Evidence: [S03] [S04] [S05] [S06] [S08]. Source findings are not blanket claims about every client or deployed release.

## 2. Evidence, provenance and limits

### Evidence classes used in this document

- **Live observed:** behavior seen on the anonymous public website or returned by the hosted connector during this study.
- **Source-present:** implementation read at the exact pinned commit. This does not prove deployment, release distribution or runtime success.
- **Measured in isolation:** a deterministic synthetic calculation or extracted helper/SQL check executed locally. It is not production performance or customer behavior.
- **Inferred:** a consequence of inspected code whose complete live path was not exercised.
- **Proposed:** a design, API, policy, budget or acceptance test requiring implementation and review.

The repository metadata identified main as the default branch. The commit is a model-catalog refresh dated 18 November 2026. The recursive tree was complete, with 2,031 tree entries and no truncation. Source files were fetched by immutable ref through the connected GitHub reader; no shared checkout was edited. A second main-branch read during final review returned the same commit. Source manifests retain file/blob identity for the UI and backend audit. [S00]

### What was inspected

**Source and context.** README, PRODUCT, DESIGN, LEADERBOARD, AGENTS, sync-consistency documentation; the web Workspace and SPA; native history/team views; both React client families; Swift usage/publication/persistence paths; Cloudflare storage, history, team membership, auth and public response paths; Go usage records, SQLite schema/queries, annotations and outbox; gateway storage; and relevant existing tests. These are targeted source inspections, not a full-repository security or correctness certification.

**Issue inventory.** The all-state GitHub inventory returned 46 numbered records: 31 regular issues, all open, and 15 PRs. An explicit closed-state query confirmed zero closed regular issues. Of the PRs, two were open drafts, twelve merged and one closed unmerged. All titles/bodies were retrieved; relevant analytics, privacy, provenance, performance and fixture bodies and available comments were inspected. Counts describe the retrieval date, not a permanent repository property. [I00]

**Public product.** README and repository context identify https://token-horizon.dev as canonical. Search verified the landing page and its explicit demo labels. Browser inspection exercised the anonymous Teams directory, Comparison to Over time, seven-day selection and the daily-value table, a linked public team detail page, and signed-out Workspace. The Teams interface visibly distinguishes published profiles and members, states UTC history and partial coverage, and warns that token volume is activity rather than productivity. Workspace visibly says that it reads published snapshots and that live traces/device telemetry remain local. [S19] [L01] [L02] [L03]

**Hosted connection.** A successful overview read returned hosted mode, published-community scope and no device traces. Only this capability result is retained in deliverables; real profile records, account usage values and model-catalog payloads are not included. No private account/profile lookup was needed.

### What this study did not establish

- The production deployment SHA or whether every inspected source change is live.
- Current native macOS, Windows or Linux release behavior.
- A signed-in Workspace flow, private device totals, private traces, personal prompts, invoice reconciliation or organizational cost totals.
- A production tenant analytics API, private ingestion receiver, admin role hierarchy or working CSV/PDF export.
- Current production latency, scale, retention guarantees, alert delivery or customer demand.
- Full end-to-end application test results. Only the explicitly listed synthetic checks were run.

Search alone returned an incomplete JS shell for Teams and could not retrieve two dynamic routes; anonymous browser inspection resolved the live-view questions. Private sign-in was not attempted. No secret, personal usage record, real profile handle, private project title or real-user screenshot appears in the supplied dataset or wireframes.

## 3. Current system audit

### 3.1 There are distinct data planes

| Data plane | Current source and storage | Safe interpretation |
| --- | --- | --- |
| Native local usage | Swift UsageEngine reads local tool data, persists incremental engine state and hourly/model aggregates; history and trend APIs feed native/UI clients. | Local observations with parser-specific accounting and coverage. Not automatically cloud-visible. |
| Local metered core | Go usage_event stores events in SQLite; file_annotation adds tool identity/reported-cost annotations at read time; canonicalization keeps raw spellings and resolves aliases on reads. | Potentially useful event-grain foundation, with source-specific provenance. Its schema is not a tenant authorization model. |
| Published community | LeaderboardStore creates a bounded profile snapshot; Cloudflare/R2 stores and reconciles it, then builds public profile, team and provider views. | Voluntarily published, potentially partial profile history. Public membership sums are contributions. |
| Local request traces | Gateway/daemon trace stores contain optional bodies and measured timings; hosted tools do not expose them. | Local troubleshooting only unless a separately authorized, content-minimized future service is designed. |
| Configurable Go cloud sync | An outbox sends usage batches to a configured /ingest endpoint. A production receiver and tenant/reporting contract were not established in this audit. | Source-present transport, not proof of hosted enterprise analytics. |

Sources: [S05] [S07] [S08] [S09] [S10] [S11] [S24] [S25] [S28].

The public profile plane must not become a surrogate private tenant plane merely by hiding a page behind sign-in. Public team IDs, profile handles, provider account IDs and billing tenants are different identities. Track 2 must provide verified tenant context; Track 5 must consume it server-side.

### 3.2 Existing correctness work to preserve

The source already has meaningful reconciliation mechanisms: coherent native capture, collectedAt distinct from publication updatedAt, conditional R2 writes with ETag retry, stale-capture rejection, idempotent bucket replacement, downward corrections, retention of remote-only days and complete replacement of a covered day's model grouping. If model splits overrun an authoritative total, the history reconciler retains the total as unresolved Other instead of guessing shares. [S06] [S07] [S12]

This means the next implementation should extend existing history/version contracts. It should not re-add cumulative publishes as increments, replace daily history with differences between ranking snapshots, or implement an unrelated second synchronization path.

### 3.3 Published payload limits affect analytics

The inspected native publisher provides top model histories plus Other, bounded daily and hourly history, a limited set of projects, and a small recent-session list. Source inspection identifies top eight project basenames and six recent sessions; the UI can display more rows than the publisher supplies. These are not exhaustive project/session datasets. Session titles are blank by default, while some metadata remains published. Costs can be zeroed when not shared. [S05]

The practical consequences are:

- A recent-session list is not a session-count denominator.
- A top-project list cannot establish complete project allocation or spend shares.
- Provider attribution from an all-time model list cannot be applied retrospectively to every daily bucket.
- Missing projects and missing costs need explicit unknown/withheld states.
- Multiple profiles owned by one person are not automatically distinct people, and multiple devices publishing overlapping data cannot safely be summed without shared identity/deduplication evidence.
- Published daily data, including the UI's UTC-labelled series, cannot support arbitrary intraday filters or timezone rebucketing. Preserve the publisher's original boundary convention before claiming a timezone conversion.

### 3.4 Existing dashboard capability matrix

| Surface | Present capability | Constraint for Track 5 |
| --- | --- | --- |
| Published Workspace | Overview, Models & costs, Activity, Optimize; selected owned profile/public preview; explicit loading, empty, failed and stale states. | One published profile, not private live usage. Summary period and breakdown scopes differ. |
| Public profile | Provider histories, cost/model breakdowns, activity/date inspection, project/session metadata and comparisons. | Public opt-in data; social ranking must remain separate from operational interpretation. |
| Teams directory | Today, seven-day and all-time comparisons; total/per-reporting-profile normalization; UTC 7/30/119-day histories, day inspector and exact table. | Member count, profile count and reporting-profile count are different. Provider mix remains all time. |
| Public team detail | Membership/publication counts, daily history, daily average/peak, provider mix and shared estimates. | Missing dates currently become zero-height chart points; all-time contributions are overlapping membership sums. |
| Native history | Local trend windows and activity history. | Average can be per active bucket, not per calendar day. Source grain and units must be explicit. |
| Native Teams | Cloud aggregates with a labelled local fallback and refresh errors. | Some member details remain all time when the top period changes. |
| React clients | Local usage/trends/limits and table views, differing by client family. | Null/error behavior and temporal scope are not consistent across clients; release parity unverified. |
| Billing destination | Routes to the selected profile's Models & costs Workspace section. | Does not establish provider invoices, organization billing or budget enforcement. |

Sources: [S01] [S02] [S03] [S04] [S13] [S14] [S15] [S26].

## 4. Source-derived repairs and isolated evidence

### 4.1 Use calendar boundaries rather than a count of reported dates

In docs/workspace.js, chart data uses the last seven reported date keys for Today/7 days and last 28 for All time. The worker's aggregateUsageHistory similarly slices observed dates. An extracted synthetic helper check requested seven days while supplying seven observed dates aged 90, 70, 60, 40, 20, 10 and 0 days; the helper retained the 90-day-old point because it selected seven observed dates. This is an isolated reproduction of the helper behavior, not a measurement of any live person's chart. [S03] [S08]

**Repair:** build the requested calendar bucket domain first, select points inside it, preserve absent points as unknown, and disclose source coverage. Legacy summary scalars should keep a Snapshot day / At publication label when their original timezone/range is unknown.

**Acceptance:** a seven-day UTC query must never return a point outside its half-open UTC range; missing days remain null; reported zero remains zero; Today does not show an unlabeled seven-date graph.

### 4.2 Ratios must use the same population and range

Worker ranking rows select a period score but choose requestsToday for Today and requestsAll otherwise. With period=week, a seven-day numerator can therefore be divided by all-time requests. Global KPIs/history are also calculated from all entries, even when the ranking table is filtered by team or league. That may be intentional for a community overview, but it is unsuitable as an implied global filter. [S08]

**Repair:** either return a filtered aggregate under an explicit scope descriptor, or label the unfiltered block Community / All time and visually separate it. Suppress the weekly average until an exact weekly request denominator exists. Do not derive one by proportional allocation.

**Acceptance:** every ratio returns numerator, denominator, units and eligible-record count; all filter-sensitive blocks share a query fingerprint. Global blocks disclose a different scope. A zero denominator returns null with a reason, never 0 or Infinity.

### 4.3 Preserve missingness across chart, table and average

Community team history uses reported ? tokens : null. Individual team detail retains a reported flag internally but charts all points as numeric tokens and divides total by the full selected day count. Native history has another denominator: active nonzero buckets. These calculations answer different questions. [S04] [S13]

**Repair:** use a shared typed reading with reported_zero, observed, partial, missing and unsupported states. Offer a clearly named observed subtotal and, when useful, a per-reported-day average. A full calendar-day average should be withheld when completeness is unknown, or explicitly labelled a lower-bound observed rate with its denominator. Do not present it as complete average activity.

### 4.4 Make cost availability explicit

Current Workspace intentionally explains that a dash means zero, hidden or unavailable. This is a safe display of an ambiguous payload, not a frontend bug to “fix” by showing zero. The publisher must first emit availability and basis separately. [S03] [S05]

**Repair:** value can be 0 with known_zero status; unavailable or withheld uses null. Distinguish provider-reported usage cost, catalog estimate, API-equivalent value of a subscription, subscription charges and invoice totals. Their reconciliation is a separate feature. Track 6 and [#19](https://github.com/castlemilk/token-horizon/issues/19) own the underlying accounting contract.

Current Go CostSource="reported" means a tool/file annotation took precedence; it does not identify a provider billing API. The compatibility /stats path prefers list-price CostEquivalent where present. Preserve those meanings in current UI labels. The synthetic fixture's provider_reported class is a proposed example, not evidence of a deployed provider integration. Its estimated_metered class has no catalog rate/version evidence and must not be relabelled catalog-priced. [S09] [S22]

### 4.5 Replace public-response denylisting with an allowlist

The inspected sanitizer removes claimTokenHash, ownerId, identityId and accountEmail but not googleEmail. Auth/claim source paths populate googleEmail, and the public profile route uses the sanitizer. An isolated synthetic object retained that field after sanitization. No live email was retrieved, exported or verified. [S08]

**Repair:** define an explicit public-profile DTO; explicitly project approved metadata; omit private identity fields, internal accounting keys, raw paths and unapproved session fields. Validate both shallow and nested payloads. Existing public responses should not inherit new private fields by default.

**Acceptance:** synthetic sentinel values inserted into every private field never appear in public JSON, search, share cards, exports or error payloads. Owner-only fields remain available only through the authorized private DTO. This is a source-derived release gate for expanding analytics, not a claim that production was exploited.

### 4.6 Keep local query parity in scope without blocking the whole track

Synthetic SQLite checks against inspected Go query expressions found: a Product filter can reference the annotation alias without a required join; aggregate cost can differ from the effective annotation-resolved event cost; missing throughput observations remain in the weighted denominator and depress the result as if they contributed zero. Product here means tool/product attribution, not an organizational project ID. These checks did not launch a daemon or exercise the full service. [S09]

**Repair:** reuse one authorization/filter/provenance projection for event lists and aggregates; average measured throughput over measured observations only. Include local API parity cases in [#13](https://github.com/castlemilk/token-horizon/issues/13), coordinated with the local-core owner. Do not claim latency or throughput is available in published Workspace until a supported data source exists.

## 5. Proposed dashboard hierarchy

All new screens in this section are proposals. The supplied wireframes are synthetic and offline; role navigation illustrates information architecture, not working authentication.

### 5.1 Self: understand and reconcile my usage

Entry is a verified owned profile for today's published Workspace, or an explicit local device source. A future private organizational source is a third distinct option, visible only with its own capability. Never silently fall back from one to another.

The first screen should show the selected source, owner, window, timezone, captured-through timestamp, published/ingested timestamp and coverage state before metrics. Cards show observed tokens, same-window requests when supported, separate known cost bases, and active sessions only when the source supports complete session identity. Existing model/provider concentration and Optimize review suggestions are useful; keep them evidence-based and avoid savings claims. [S03]

The main chart leads to an exact daily table, then a model/provider breakdown with the identical predicate. Activity opens session metadata in scope. A local trace link is owner-only and should say Open on this device; a hosted view must not imply the trace was uploaded.

When the source has only top-N project metadata, label it Published projects / partial list and disable exhaustive allocation analysis. When cost is unknown, offer Inspect pricing coverage, not an apparently precise budget forecast.

### 5.2 Team: understand shared cost and data coverage

Keep two meanings visibly distinct:

- **Current public crew analysis:** published profile contributions under current membership, potentially overlapping with other crews, full published history. Preserve the current labels and history controls.
- **Proposed private team analysis:** authorized tenant facts attributed by explicit event/project/account rules. Its default grouping is project, model, provider or source. Named-user reconciliation requires a separate capability and purpose; there is no productivity rank.

A private overview shows roster count, opted-in/configured reporting population and actually observed population separately. It shows known estimates and reported costs with coverage, unassigned projects, freshness, and changes in the reporting population. A falling cost must not be celebrated if a collector went offline.

A useful default workflow is: known cost increased -> inspect contributing projects -> compare model/provider composition under the same window -> inspect authorized metadata -> decide whether to investigate routing, pricing, missing allocation or a workload change. It is not evidence that a model switch will preserve quality or yield savings.

### 5.3 Admin: operate the measurement system

This is a proposed data-quality and governance view, not a currently demonstrated enterprise feature.

Show source heartbeats/watermarks, missing periods, parser/schema failures, late records, duplicate suppression, corrections, unresolved attribution, price coverage, retention/deletion lag and export audit. Tenant admins do not acquire prompt-body access by virtue of this role. Finance viewers can reconcile approved amounts without seeing session titles. Track 2 owns membership/role/consent controls; Track 5 links to those controls rather than rebuilding them.

The priority action list should contain measurement tasks such as Investigate three-hour gap, Review cost provenance or Resolve unknown project. It must not label a person as underperforming or unproductive.

### 5.4 View states and accessible interaction

Preserve the existing distinction between checking identity, finding owned profiles, selecting one, loading a snapshot, genuinely empty, stale-but-readable and failed. Add unsupported grain, partial coverage and privacy-suppressed states. Unknown data must never flash as zero while loading. [S01] [S03] [S16]

Every chart needs an equivalent table, keyboard selection, explicit units, a visible date/scope and a textual missing-data legend. Hover may add detail but must not be the only way to obtain it. Keep series stable across comparisons, use no smoothing across gaps, and retain the existing chart-host reuse. Selection must not change authorization or silently expand a date range.

## 6. Proposed analytics contract

### 6.1 Query envelope

A proposed analytics response should carry:

~~~json
{
  "schema_version": "analytics-v1-proposal",
  "metric_version": "track6-pending",
  "scope": {"kind": "private_tenant", "tenant_id": "tenant_demo_orion"},
  "range": {
    "start": "2026-11-11T00:00:00Z",
    "end_exclusive": "2026-11-18T00:00:00Z",
    "timezone": "UTC",
    "granularity": "day"
  },
  "as_of": "2026-11-18T06:00:00Z",
  "filters": {"project_ids": [], "provider_ids": []},
  "attribution_mode": "unique_tenant_events",
  "data_revision": "synthetic-r2",
  "cost_basis": ["provider_reported", "catalog_estimate"],
  "coverage": {"status": "partial", "expected_population_known": true},
  "suppression": {"policy_version": "proposal-k5-v1"},
  "truncated": false
}
~~~

This is an interface proposal, not an existing endpoint. The server derives allowed tenant/scopes from the authenticated principal; an arbitrary tenant_id in a request does not grant access. Query fingerprints include permissions/policy version, not just visible filters. Response fields identify actual supported dimensions and grain.

### 6.2 Dimensions and attribution

| Dimension | Required meaning | Missing/ambiguous policy |
| --- | --- | --- |
| Tenant | Server-bound private data boundary; unrelated to public crew ID. | Deny if absent for private reads. |
| Actor | Verified organizational principal or explicitly mapped service account. | Unknown actor stays unknown; an API key is not assumed to be a person. |
| Profile/device/source | Distinct collection and publication identities. | Never merge by display name or email domain. |
| Team | Either current public membership contribution or explicit private attribution. | Mode is mandatory; do not mix modes in one total. |
| Project | Stable tenant-scoped ID, explicit SDK/config mapping or reviewed rule. | Unassigned remains a first-class bucket; never infer from private prompt text. |
| Session | Stable source-qualified session ID and complete observed span. | Unknown session excluded from session denominators; metadata count still visible. |
| Provider | Serving provider/gateway, separately from model publisher and tool. | Raw value retained privately; normalized alias/version declared. |
| Model | Requested and resolved identifiers when available, normalization version. | Unknown remains visible; do not silently merge dissimilar variants. |
| Cost | Currency, basis, availability and provenance version. | Unknown/withheld/unsupported are not zero. |
| Source class | Metered event, provider report, local file, published bucket, inferred annotation. | Preserve source precision and limitations through every aggregation. |

### 6.3 Metric dictionary

For all metrics below, let Q be the authorized, de-duplicated, revision-selected records inside the same half-open query window and filters. Let K be the subset with a compatible known cost basis/currency, R the subset with a valid canonical request identity, and S the subset with a session identity. Counts and costs are not automatically available in every legacy source. Track 6 supplies normalized token values and the request/attempt taxonomy.

#### Usage and population

| Metric | Numerator / denominator or operation | Null, coverage and availability |
| --- | --- | --- |
| Observed tokens | Sum normalized display_tokens over Q; no denominator. | Label observed when coverage incomplete. Never add raw cache/reasoning subsets again. Available from published totals at supported grain. |
| Canonical model requests | Distinct canonical request IDs in R; no denominator. | If records are only parser observations, label Observed usage records instead. Do not use row count as universal request count. |
| Attempts | Distinct attempt IDs for eligible transport operations. | Separate from logical requests; source-dependent, local event plane only until supported privately. |
| Tokens per request | Sum tokens over the same R / count requests in R. | Show numerator/denominator and exclusion count. Null at zero denominator. Never divide weekly tokens by lifetime requests. |
| Observed actors | Distinct verified actor IDs with an eligible observation. | Not seats, profiles or productive employees. Requires private identity mapping. |
| Published profiles | Distinct profiles in the authorized/public profile dataset. | May exceed people; publication is voluntary. Current public metric. |
| Reporting profiles | Distinct profiles with an explicit value for the selected published window. | Reported zero qualifies. Missing window is excluded and disclosed. |
| Reporting participation | Observed eligible actors / configured opted-in actors expected in the window. | Null if expected population unknown; never use all roster members by default. Not productivity/adoption success. |
| Active sessions | Distinct session IDs in S with observed eligible activity in Q. | A partial recent list cannot supply this. A session spanning windows counts in each relevant window; do not sum per-day session counts as unique sessions. |
| Active models/providers/projects | Distinct resolved IDs with positive eligible usage in Q. | State identity definition and unresolved count; current all-time model count remains separately labelled. |

#### Costs and comparisons

| Metric | Numerator / denominator or operation | Null, coverage and availability |
| --- | --- | --- |
| Tool/file-reported cost | Sum effective file-annotation amounts in K, by currency. | Current Go reported provenance means a tool/file annotation, not a provider invoice. Preserve source and price coverage. |
| Provider-reported usage cost | Sum comparable provider-source amounts in K, by currency. | Proposed until a verified source is connected. A usage cost record is not an invoice or proof of payment. |
| Estimated API-equivalent value | Sum event-time list-price equivalents over eligible observations. | Current compatibility /stats can prefer this value. It does not measure subscription charges, paid spend or realized savings. |
| Catalog-estimated cost | Sum event-time estimate amounts in K using a pinned price version. | Separate card/series from reported cost; no current-price repricing of history without explicit scenario mode. |
| Known-zero cost | Exact zero with explicit known_zero status. | Not interchangeable with free-plan coverage, unknown price or withheld cost. |
| Visible cost-amount coverage | Count Q with authorized visible known amounts, including explicit zero / count Q eligible for cost reporting. | Identifies amount availability. An unresolved cost basis may still exclude a known amount from every basis-specific sum/rate. State exclusions; withholding must not expose hidden amounts. |
| Cost-basis coverage | Count eligible records with identified comparable basis/currency / count eligible records in the same scope. | Separate from visible-amount coverage. A known zero still needs provenance before entering a basis-specific denominator. |
| Known-cost token coverage | Tokens in K / tokens in Q where the same token metric is valid. | A percentage of observed tokens, not proof of full invoices or all activity. |
| Cost per 1,000 known-cost tokens | 1,000 × sum amount in K / sum tokens in K. | Calculate separately by basis/currency. Do not divide known costs by all tokens, including unpriced records. |
| Cost share | Cost of selected group in K / total K cost under identical filters. | Null if total is zero; explicitly excludes unknown/withheld amounts. |
| Usage share | Group tokens / total tokens in Q. | Include Unassigned/Other in the denominator; supplementary suppression may be needed. |
| Absolute change | Current comparable aggregate minus baseline comparable aggregate. | Suppress or qualify when population/coverage/grain differs materially. |
| Relative change | 100 × (current - baseline) / baseline. | Baseline 0 -> New/no percentage if current positive; both 0 -> no change with no percentage; missing -> unavailable. |
| Estimate budget use | Comparable estimate amount / explicitly configured estimate budget in the same currency/window. | Advisory only, after a budget contract. Not a provider hard cap; not current hosted capability. |

#### Data quality and supported operational metrics

| Metric | Numerator / denominator or operation | Null, coverage and availability |
| --- | --- | --- |
| Collection freshness | as_of minus newest successful source watermark. | Do not substitute publication time. No source manifest -> unknown, not fresh. |
| Publish lag | published_at minus collected_at for the same snapshot. | Null for legacy missing timestamp; distinguish stale capture from a fast republish. |
| Source-time coverage | Observed or attested covered source-seconds / expected eligible source-seconds over configured intervals. | Requires heartbeat/manifest. No events alone cannot establish missingness or zero activity. |
| Late arrival rate | Observations received after configured lateness threshold / eligible received observations. | Threshold and event-time basis are explicit; revisions are not new requests. |
| Duplicate delivery rate | Suppressed duplicate deliveries / total eligible deliveries. | Operational ingest metric, not user usage. Conflicts quarantined separately. |
| Correction count | Accepted newer revisions changing a previously visible fact. | Recompute affected buckets; preserve as-of reproducibility. Downward corrections valid. |
| Unknown-project share | Observed tokens or compatible costs lacking project ID / same eligible total. | Explicit unit. Do not force allocations just to improve this number. |
| Error rate | Terminal failed attempts / terminal attempts with known outcome. | Local measured/request plane only. Missing outcomes not counted as success; no current hosted promise. |
| Latency p50/p95 | Quantile over eligible measured duration observations. | Exact observations or mergeable distributions; never average p95s. Minimum sample disclosure; no fabricated local/cloud parity. |
| Generation throughput | Known measured output tokens / known measured generation duration under agreed semantics. | Track 6 owns timing boundaries. Unknown timings excluded, not zero. No inference from CPU/RAM. |

External checks support using explicit grouped usage windows, keeping cost and usage endpoints distinct, and aggregating distributions rather than precomputed quantiles. OpenAI's current cost API supports daily buckets, while usage supports minute/hour/day; unsupported grouping combinations can fail. Anthropic's current analytics API is beta and has its own authorization and dimensions. These are feasibility references for a future adapter, not integrations verified in Token Horizon. [P01] [P02] [P03] [P04]

Cost sums remain separate by currency and basis. Cross-currency totals require an explicit conversion scenario, a pinned FX source/date and both original and converted values; no such conversion is implemented or exercised here. Refunds, credits and later invoice adjustments must retain their own ledger provenance rather than silently rewriting usage volume. [S09] [S22]

## 7. Time, range, granularity and comparison rules

### Time contract

Store event instants in UTC with their original precision; retain collection and receipt timestamps separately. Every query uses start-inclusive/end-exclusive boundaries. Display both the selected IANA timezone and the resulting UTC interval in query details and exports. The user-facing default for this study is Australia/Melbourne; the synthetic fixtures use UTC explicitly.

A seven-day completed window means seven local calendar dates ending at the most recent completed local midnight. Today is a separate partial-day mode. For a same-elapsed-time comparison, record exactly which cutoffs were used. Do not compare a partial today to a full yesterday without labelling the mismatch.

DST days may be 23 or 25 hours. A daily bucket is a calendar boundary, not always 86,400 elapsed seconds. Repeated local hours need offset labels. Weeks start Monday unless a tenant setting explicitly selects another convention, and that setting is versioned with the query.

The inspected clients do not all start from the same day convention: Swift groups UTC-aligned hours with Calendar.current; Go supports fixed epoch-aligned bucket sizes and UTC backfill days. A common UI therefore needs source boundary metadata. It cannot fix legacy ambiguity by changing the timezone label alone. [S09] [S28]

### Grain capability rules

- Event timestamps can support exact timezone boundaries at their recorded precision.
- UTC hourly data can support another timezone only when requested boundaries align with those source buckets. Half-hour/quarter-hour offsets cannot be reconstructed by splitting an hour evenly.
- UTC daily buckets remain UTC daily. Arbitrary viewer-local days cannot be recovered.
- Legacy Today/7d scalars retain their publisher-defined snapshot basis until the source reports the original boundaries.
- A request for unsupported grain returns an explicit capability result and offers a supported choice. It must not silently resample or distribute totals.

Proposed display ladder: up to 48 hours at hour grain when available; 7/30/90 days at day grain; longer windows at week/month grain after a tested rollup contract. Preserve current 7/30/119 UTC-day public views. Top-N selection is stable across the compared windows; Other is the exact remainder, never a second allocation.

### Comparability envelope

A comparison must match scope, identities, attribution mode, dimensions, metric version, currency/basis, timezone, duration rule and retention horizon. Show current/baseline reporting counts and coverage. If a new source, actor or project appears, show Population changed and optionally a clearly labelled matched-cohort comparison. Do not exclude inconvenient observations silently.

A prior-period trend should be unavailable when the data only contains one cumulative snapshot. Snapshot deltas can measure change in published totals, but late uploads, corrections and membership changes prevent them from becoming reliable activity-by-day or “improvement” measurements. [S06] [S08]

## 8. Attribution, missing data and ingestion semantics

### Identity and deduplication

A future private fact key must be tenant-qualified and source-qualified. Provider request ID alone may collide across vendors or accounts. Prefer a canonical request/attempt identity from the collector, together with source observation ID and revision. Store raw observations separately from the selected fact and retain the reason for selection.

When gateway and file records describe the same request, preserve one chargeable fact and its linked observations. A source-confidence rank may select a preferred measurement, but same-rank conflicting values require quarantine/reconciliation, not silent max or arbitrary last-write. Track 6 owns this canonicalization; Track 5 consumes the decision and shows unresolved coverage.

Retries of a delivery are not new requests. Retries of an upstream attempt may incur additional usage and should remain separate under a logical request. A profile appearing in two public crews is not an ingestion duplicate; it is an intentional membership contribution.

### Late and corrected data

Use event time for the analytical bucket, received_at for ingest-health measures, and as_of for reproducibility. Late data recomputes the original bucket and marks it revised; it does not become usage on upload day. Preserve current whole-day snapshot replacement and correction behavior. [S06] [S12]

A proposed default provisional window is 72 hours for new private ingest, configurable by source latency. This is a UI finality policy, not permission to drop older legitimate corrections. If a late record falls outside retained detail, quarantine or apply an auditable aggregate correction according to retention policy; never rewrite silently.

Exports and advisories bind to a data revision. A query at the earlier as_of should remain reproducible for the defined audit horizon, or clearly return Revision no longer retained. “Final” means settled under the configured policy, not mathematically immune to future provider adjustments.

### Missingness states

| State | Chart/table behavior | Aggregation behavior |
| --- | --- | --- |
| Observed positive | Numeric value with provenance. | Include in observed subtotal. |
| Reported zero | Visible zero marker and 0 in table. | Include in reported coverage/eligible denominator. |
| Partial | Numeric observed subtotal with partial marker. | Include observed amount; prevent complete-rate claims. |
| Missing/unreported | Gap and Not reported. | Do not coerce to zero or interpolate. |
| Withheld | Withheld/hidden marker only where authorized. | Do not allow totals or complementary filters to reveal the amount. |
| Unsupported | Not supported by this source. | Exclude from metric eligibility and state why. |
| Stale | Retain valid snapshot with original range/timestamp. | Do not relabel its Today as the viewer's current day. |
| Privacy suppressed | Suppressed, with policy-level reason. | Apply complementary suppression to totals and exports. |

## 9. Filters, drilldowns, exports and advisories

### Filter and drilldown semantics

Filter dimensions are ANDed; multiple values within one dimension are ORed. Date, tenant and actor authorization are mandatory predicates applied before grouping. Unknown/Unassigned are selectable values, not missing UI rows. Search filters display values, not hidden raw prompts. Filters are never authorization.

A click on a card, series, bar or table row should preserve the exact range, source, cost basis, attribution mode and query revision. Breadcrumbs state each added predicate. A selected model in a top-N series opens its exact rows; Other opens an aggregate explanation and authorized remaining groups, with privacy suppression preserved.

Private URLs may encode non-secret scope references but never bearer tokens, raw prompts or sensitive project names. The server resolves IDs against permissions. Current all-time panels stay labelled all time until they can obey the unified filter; do not make a common toolbar imply unsupported filtering.

### Export proposal

Start with JSON and aggregate CSV. PDF is a presentation of the same query result, not a separate calculation. The inspected allowDownload preference should either be implemented end-to-end or clearly disabled until supported. [S04] [S08]

Every export includes a manifest: tenant/scope kind, redacted stable IDs, schema and metric versions, half-open UTC interval, IANA timezone, granularity, source/cost basis, as_of/data revision, currency, filters, sort, coverage numerator/denominator, suppression policy, truncation status, retention horizon and checksum. No raw prompt/response, credential, email, full filesystem path or private session title is exported by default.

Authorize at job creation, execution and download; recheck membership/consent before release. Cache/export keys include tenant and effective permission/policy version. Short-lived signed downloads do not override revocation; use a permission-checked download proxy for private exports. A user-downloaded file cannot subsequently be recalled, so preview the fields and scope before generation.

CSV must use a real encoder, not string concatenation. Untrusted text can become spreadsheet formulas; quoting alone is insufficient. Provide a spreadsheet-safe mode with an explicitly tested target application and a lossless JSON alternative. Test delimiters, quotes, Unicode formula-prefix variants and save/reopen behavior. No universal CSV sanitization guarantee is claimed. [P05]

Suggested initial limits are 50,000 rows per asynchronous detailed export, 24-hour server artifact expiry and a visible no-silent-truncation result. These are proposed implementation bounds, not current service limits. Large exports can offer aggregate grain or a narrower range.

### Advisories and alerts

**Current evidence:** Workspace has evidence-based review suggestions and stale-snapshot notices. Hosted published snapshots cannot substantiate live latency/error/quota or spend-anomaly alerts; local limits/trace capabilities are a separate source plane. [S03] [S10]

**Phase 1:** improve on-screen stale, missing-source, unpriced-model and unreconciled-total notices. These require no third-party delivery.

**Phase 2 proposal:** budget and source-freshness alerts become available only when the metric has a supported source, expected coverage and authorized configuration. Evaluate comparable complete windows; suppress when stale, partial, suppressed or below a minimum sample count. Show exactly why an alert is paused.

Use a stable rule+scope+window incident key, a configurable cooldown, explicit recovery and retraction/amendment after a correction. Cap repeated notifications and never send prompts, titles or named-user “low activity” alerts. Channel configuration and consent belong to Track 2. No alert, notification or external message was created in this research.

## 10. Privacy, RBAC, tenant isolation and retention

### 10.1 Proposed authorization matrix

This is a backend permission proposal, not a description of current roles.

| Viewer | Default analytics access | Separate grant required |
| --- | --- | --- |
| Public visitor | Existing allowlisted voluntarily published profile/crew data. | No private tenant or device data. |
| Individual member | Own authorized private observations and owned published profile; safe team aggregates under policy. | Named peers, finance detail, export and local traces outside own device. |
| Team analyst | Project/provider/model aggregates within assigned team scopes. | Named-person reconciliation and detail export. |
| Finance viewer | Approved cost-basis reconciliation, allocation and invoice references if implemented. | Session content/titles or unrelated operational identity. |
| Tenant admin | Source health, role/consent/retention configuration, aggregate access audit. | Content access is not implied by administration. |
| Service collector | Write observations for its bound tenant/source; read minimal acknowledgements. | General analytics read or cross-tenant discovery. |

A private query checks the principal's current tenant membership, permitted projects/teams and field-level grants server-side. Use deny-by-default for new fields and endpoints. Public profile visibility is an explicit publication state, not a permission inherited from private membership. Leaving a team revokes future private query/export access; it does not retroactively make previously public data private.

### 10.2 Consent and minimization

Private collection and public publication need separate, understandable choices. Capture metadata by default; keep prompt/response bodies off the analytics path. Project labels and session timing can themselves be sensitive. Prefer tenant-specific aliases and opaque IDs; avoid full paths, email addresses and inferred private project names. Document which collectors are active, which fields they transmit and when the policy changed.

Retain existing explicit ownership selection and stale-auth-response protections. A delayed response for an old account must not render after identity or tenant changes. No personal view falls back to the first community profile. [S01] [S16] [S27]

The public DTO allowlist repair is an immediate source-derived requirement. A future private schema should not be embedded in the public R2 profile and then rely on a display filter to hide it.

### 10.3 Aggregation protection

For broadly shared private reports, propose a default threshold of five distinct consented actors for a group, with at least seven days of temporal aggregation. This is a design default, not a legal guarantee and not an existing behavior. Own-user views remain available. A specially authorized finance/person-level reconciliation workflow is separately governed; it does not masquerade as anonymous analytics.

The proposed analyst wireframe uses an explicitly restricted daily-detail capability to illustrate gaps and zeroes. A broadly shared report uses seven-day-or-coarser buckets instead. The wireframe suppresses a five-of-six subset and its complementary contribution sum: a nominal five-actor threshold does not justify exposing a single actor by subtraction. The offline fixture retains the exact synthetic values solely as a reviewer oracle.

Thresholds alone do not prevent reconstruction. Apply complementary suppression to totals and Other; constrain arbitrary overlapping cohort filters; use stable bucket definitions; limit repeated differencing queries; and do not expose suppressed counts through chart tooltips, empty-state variations or exports. Public data already deliberately published by its owner has a different policy, which must remain explicit.

A multi-team public contribution sum is safe only as that labelled social metric. A private organization total must union canonical facts once; charge allocation uses an explicit assignment or fractions summing to one. Historical allocation changes are effective-dated and auditable, not inferred from current membership.

### 10.4 Retention: distinguish technical bounds from policy

Current source has several bounded histories: approximately 17-week native published daily series; roughly 120-day hourly publication; 130-day cloud history reconciliation bounds; short history summaries and bounded snapshots. Gateway storage documents 30 day-files and a 256 MiB size bound, with capped bodies; file-count/size pruning is not a guaranteed wall-clock TTL. Go usage_event rows are unbounded by default: TH_RETENTION_DAYS enables pruning on store open. The separate Go trace table has an approximately 2,000-row cap, checked every 64 insertions, plus optional age pruning. These heterogeneous technical limits do not establish a full cloud deletion, export expiry or enterprise retention policy. [S05] [S06] [S10] [S20] [S21] [S23]

Proposed private defaults, subject to explicit product approval:

- Request metadata detail: 30 days; optional shorter retention.
- Hourly rollups: 90 days; daily privacy-safe rollups: up to 13 months.
- Generated export objects: 24 hours; downloaded copies are outside recall.
- Data-quality/audit metadata: 90 days by default, without prompts or raw identities beyond necessary access records.
- Revocation prevents new private reads immediately; deletion jobs target live detail/rollup/cache removal within 24 hours, with documented backup expiry no longer than 30 days.

These are proposed SLOs, not present guarantees. Retention should be visible before collection. Rollups must support deletion or recomputation; retained raw-detail expiry must not leave an undeletable per-person aggregate. If safe removal would expose a remaining small cohort, suppress or recompute the affected cells. Keep an audit receipt of the deletion action without retaining the deleted usage itself.

## 11. Performance budgets and validation

### Existing source budgets to preserve

The current hermetic chart benchmark declares 120 profiles/30 days and a 3,000-model catalog fixture. Its thresholds are: cold first chart 1,500 ms; warm view switch median 60 ms and p95 150 ms; table search including debounce 260 ms; no extra warm chart mounts; model explorer search 300 ms and at most 60 DOM rows. These are source-defined regression gates, not production measurements from this study. [#44](https://github.com/castlemilk/token-horizon/issues/44) records an earlier budget failure; do not relax a threshold to hide it. [S17] [I23] [I44]

### Additional proposed budgets

| Area | Proposed target and workload | Verification |
| --- | --- | --- |
| Aggregate API | p95 server time <=500 ms for a 30-day query over 10 million synthetic events with pre-aggregation; <=1 s for 90 days. | Fixed machine/data manifest, 20 warmup +100 measured calls, tenant skew and concurrent-query cases; report cold separately. |
| Interactive payload | <=250 KB compressed for initial aggregate; <=1,000 plotted points and <=8 series per panel. | Fixture byte and DOM/series counts; explicit pagination/Other. |
| Detail query | p95 <=800 ms for a 100-row cursor page with supported selective filters. | Index-plan inspection and tenant-bound scans; no unbounded offset paging. |
| Private caching | No cross-tenant hits; permissions/policy/data-revision in key; targeted invalidation on consent/revocation. | Negative authorization and stale-cache fixtures. |
| Export | Async 50,000-row job completes within 30 s at documented load; no silent truncation. | Isolated generated dataset, checksum/card-table parity and mid-job revocation. |
| UI | Preserve existing 60/150 ms switch budget; responsive at 390 px and 1440 px; keyboard/table parity. | Existing fixture harness plus new cases; no live provider calls. |

Targets are planning proposals. Benchmarks must report environment, commit, workload distribution, p50/p95, errors and resource usage. Do not quote sub-25 ms marketing latency as evidence. Use pre-aggregated additive sums/counts and mergeable histograms; p95 cannot be averaged across models, users or days. [P04]

### Acceptance suite

| ID | Scenario and required result | Existing anchor |
| --- | --- | --- |
| A01 | Seven-day query with a 90-day-old observation excludes it; reports seven calendar buckets. | [#13](https://github.com/castlemilk/token-horizon/issues/13), [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-06 |
| A02 | Weekly numerator cannot use all-time requests; absent same-window denominator -> unavailable. | [#13](https://github.com/castlemilk/token-horizon/issues/13) |
| A03 | Two positives, one explicit zero and four missing days stay distinct in chart/table/export. | [#13](https://github.com/castlemilk/token-horizon/issues/13), [#23](https://github.com/castlemilk/token-horizon/issues/23) |
| A04 | Team/league filter affects all scoped metrics; intentional global blocks expose a separate scope. | [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-13 |
| A05 | Known zero, unknown, withheld, reported and estimated costs render distinctly; basis totals never silently mix. | [#19](https://github.com/castlemilk/token-horizon/issues/19), [#13](https://github.com/castlemilk/token-horizon/issues/13) |
| A06 | Duplicate delivery counts once; newer correction replaces; late observation changes original day; prior as_of stays reproducible. | [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-04/06 |
| A07 | Same event ID in another tenant never affects totals or cache; signed-out/forged scopes denied. | [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-32, Track 2 |
| A08 | Public DTO excludes synthetic email/credential/path/private-title sentinels, including nested new fields. | [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-25, [#13](https://github.com/castlemilk/token-horizon/issues/13) |
| A09 | Overlapping crews yield contribution sums; organization union and allocated cost reconcile separately. | [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-08/32 |
| A10 | Product/tool filter, event list and aggregate costs use the same effective annotation projection; missing latency/TPS is excluded. | [#13](https://github.com/castlemilk/token-horizon/issues/13) |
| A11 | Melbourne DST start is 23 hours, DST end 25; hourly duplicate labels show offsets; daily-only UTC source rejects unsupported timezone. | [#13](https://github.com/castlemilk/token-horizon/issues/13) |
| A12 | Login/tenant switch during delayed query never renders old-user data; export revoked mid-flight cannot be downloaded. | [#23](https://github.com/castlemilk/token-horizon/issues/23), [#36](https://github.com/castlemilk/token-horizon/issues/36), Track 2 |
| A13 | Fewer-than-five actor cell and complementary totals are suppressed; differencing/export cannot reveal it. | [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-25/32 |
| A14 | Export manifest matches on-screen query/revision; amounts and nulls reconcile; text cannot execute formulas in declared target reader. | [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-25, [#16](https://github.com/castlemilk/token-horizon/issues/16) |
| A15 | Source outage suppresses spend/usage-change advisory; correction updates/retracts incident without duplicate notification. | [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-13/14 |
| A16 | Retention removes detail and affected person-level rollups/caches; expired/revoked download fails; audit receipt excludes deleted usage. | [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-32 |
| A17 | Keyboard reads every chart value; partial/unknown states announced; 390 px has no document overflow. | [#23](https://github.com/castlemilk/token-horizon/issues/23) |
| A18 | Existing render budgets pass unchanged on pinned baseline and proposed views; new API/export workloads record environment. | [#23](https://github.com/castlemilk/token-horizon/issues/23), [#44](https://github.com/castlemilk/token-horizon/issues/44), [#26](https://github.com/castlemilk/token-horizon/issues/26) |

Only a subset of these is demonstrated by the supplied synthetic oracle. Passing that oracle does not satisfy production authorization, export, performance, retention or end-to-end release gates.

## 12. Prioritized, deduplicated backlog

These are backlog-ready drafts, not newly created issues. Effort is a planning estimate in engineering days after dependencies are agreed; rows overlap and should not be blindly summed. Reuse [#12](https://github.com/castlemilk/token-horizon/issues/12) as parent, [#13](https://github.com/castlemilk/token-horizon/issues/13) for measurement integrity, and the existing pricing/privacy/performance work. Product acceptance belongs jointly to the indicated tracks.

### T5-01 — Correct current ranges, scopes and denominators

**Priority:** P0. **Estimate:** 3–5 days. **Risk:** medium.  
**Existing anchors:** [#13](https://github.com/castlemilk/token-horizon/issues/13); [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-06/13.  
**Problem:** nominal recent windows and per-request values can combine different temporal populations.  
**Scope:** calendar-domain construction; explicit legacy scalar scope; weekly ratio availability; consistent filter descriptors; individual team missing-day handling. Preserve already-correct community history.  
**Likely paths:** docs/workspace.js, docs/leaderboard.html, cloudflare/src/index.js, cloudflare/src/usage-history.js; native UsageHistoryViews.swift only for naming/denominator parity.  
**Dependencies:** Track 6 metric IDs; no private tenant service needed for repair.  
**Acceptance:** A01–A04, A11, A17. Sparse/all-zero/stale fixtures must pass.

### T5-02 — Allowlist public analytics responses

**Priority:** P0. **Estimate:** 2–4 days. **Risk:** high privacy sensitivity.  
**Existing anchors:** [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-25/32; [#13](https://github.com/castlemilk/token-horizon/issues/13).  
**Scope:** public DTO projection, removal of legacy email exposure paths, nested field schema validation and public/share/export sentinel tests. Keep private ownership fields in explicitly authorized endpoints.  
**Likely paths:** cloudflare/src/index.js, cloudflare/src/connector.js and public/shared report tests.  
**Dependencies:** Track 2 private/public capability definitions.  
**Acceptance:** A08, A12; no public output gains fields merely because the storage schema expands. Verification must use synthetic identities.

### T5-03 — Version cost availability and measurement coverage

**Priority:** P0. **Estimate:** 4–7 days. **Risk:** high semantic compatibility.  
**Existing anchors:** [#19](https://github.com/castlemilk/token-horizon/issues/19); [#13](https://github.com/castlemilk/token-horizon/issues/13); [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-03/07/09.  
**Scope:** nullable costs with basis/currency/status/provenance; source capability/coverage; capture vs publish timestamps; legacy unknown fallback.  
**Likely paths:** native Models.swift and LeaderboardStore.swift, Go usage/types.go and DTOs, Cloudflare validation, Workspace cards.  
**Dependencies:** Track 6 owns token/cost meaning and price validity; Track 2 owns field visibility.  
**Acceptance:** A02, A05, A06. Do not retroactively label every legacy zero as free.

### T5-04 — Align local aggregate and detail projections

**Priority:** P0 for affected local APIs. **Estimate:** 2–4 days. **Risk:** medium.  
**Existing anchor:** [#13](https://github.com/castlemilk/token-horizon/issues/13).  
**Scope:** Product filter join correctness; effective reported-cost projection shared by events/buckets/aggregates; measured-only timing denominators.  
**Likely paths:** daemons/go/internal/store/query.go and source-matched query tests.  
**Dependencies:** Local-core owner and Track 6.  
**Acceptance:** A10; exact equality between filtered rows and aggregate output, including annotations and missing fields. This is not a request to rewrite the local collector.

### T5-05 — Unify self analysis and auditable drilldown

**Priority:** P1 after T5-01/03. **Estimate:** 4–7 days. **Risk:** medium.  
**Existing anchors:** [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-13; [#13](https://github.com/castlemilk/token-horizon/issues/13).  
**Scope:** supported range header; exact query details; same-predicate model/provider and date drilldowns; inspectable unknown/Other; selected-profile state retention; source-specific unsupported controls.  
**Likely paths:** docs/workspace.js, docs/workspace.css, scripts/test-workspace-ui.mjs.  
**Dependencies:** Track 2 shell/profile selection contract; Track 6 normalized metrics.  
**Acceptance:** A01–A05, A12, A17. No fake local/private/live source on the hosted page.

### T5-06 — Define private tenant allocation and reporting facts

**Priority:** P0 foundation for any private team/admin release; P1 scheduling after current repairs.  
**Estimate:** 10–15 days for a bounded metadata-only vertical slice. **Risk:** high.  
**Existing anchors:** [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-03–08/30/32; [#13](https://github.com/castlemilk/token-horizon/issues/13).  
**Scope:** authenticated tenant-bound ingest/read contract, canonical observation/revision envelope, explicit project mapping, unique-event union, effective-dated allocation and unassigned bucket. Avoid a new analytics store until existing local/outbox contracts are reconciled.  
**Suggested new paths, subject to architecture decision:** docs/analytics-contract.md; cloudflare/src/analytics-contract.js; cloudflare/analytics-contract.test.mjs. These are recommendations, not files added to the repository. Do not put private facts into the existing public leaderboard document.  
**Dependencies:** Track 2 tenant/RBAC/consent and Track 6 canonical IDs/cost semantics.  
**Acceptance:** A06–A10, A12, A16; reject cross-tenant IDs at ingest/query/export. Identify the actual private receiver before estimating production rollout.

### T5-07 — Add private team analysis and admin measurement health

**Priority:** P1 after T5-06. **Estimate:** 6–10 days. **Risk:** medium/high.  
**Existing anchors:** [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-09/13/31/32.  
**Scope:** project/provider/model concentration, reporting populations, allocation/unknowns, source gaps/corrections/duplicates, retention/export audit. Preserve public crew contribution semantics.  
**Likely paths:** existing SPA/Workspace components or a bounded extracted analytics module; new API only behind the verified private capability.  
**Dependencies:** Track 2 navigation and role grants; T5-03/06; no knowledge-graph ingestion required.  
**Acceptance:** A07, A09, A12, A13, A17. No employee token leaderboard or unsupported invoice card.

### T5-08 — Implement reproducible authorized exports

**Priority:** P1 after common query/permissions. **Estimate:** 4–6 days. **Risk:** high privacy sensitivity.  
**Existing anchors:** [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-25; [#16](https://github.com/castlemilk/token-horizon/issues/16) for preview conventions; [#13](https://github.com/castlemilk/token-horizon/issues/13).  
**Scope:** JSON/aggregate CSV from the same versioned query, preview manifest, authorized asynchronous jobs, revocation-aware retrieval, tested spreadsheet-safe output, explicit truncation/expiry.  
**Suggested paths:** separate analytics-export module and tests; update allowDownload only after server enforcement exists.  
**Dependencies:** T5-02/03/06; Track 2 permissions.  
**Acceptance:** A12–A14/A16. Existing report preference alone does not pass.

### T5-09 — Add coverage-aware advisories

**Priority:** P2. **Estimate:** 3–5 days after trustworthy metrics. **Risk:** medium.  
**Existing anchors:** [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-13/14; [#13](https://github.com/castlemilk/token-horizon/issues/13).  
**Scope:** source freshness, unknown-price and allocation notices first; optional estimate-budget incidents after explicit capability. No anomaly model needed for initial release.  
**Dependencies:** T5-03/06; separately authorized delivery and consent from Track 2.  
**Acceptance:** A15; no alert on missingness, no savings claim, no hard enforcement claim for traffic outside the meter.

### T5-10 — Extend privacy, retention, accessibility and performance gates

**Priority:** P0 throughout. **Estimate:** 5–8 days spread across delivery. **Risk:** high if deferred.  
**Existing anchors:** [#23](https://github.com/castlemilk/token-horizon/issues/23), [#44](https://github.com/castlemilk/token-horizon/issues/44), [#36](https://github.com/castlemilk/token-horizon/issues/36), [#26](https://github.com/castlemilk/token-horizon/issues/26); [#12](https://github.com/castlemilk/token-horizon/issues/12) THR-25/32; [#39](https://github.com/castlemilk/token-horizon/issues/39) for hermetic MCP tests.  
**Scope:** complement suppression, tenant cache keys, revocation/deletion tests, exact fixture parity, existing performance gates plus bounded API/export load.  
**Dependencies:** Track 2 and source owners.  
**Acceptance:** A07/A08/A12–A18. All default tests remain hermetic and cannot publish telemetry.

### Existing work not to duplicate

PR [#4](https://github.com/castlemilk/token-horizon/pull/4) already introduced metadata coverage and hosted/local separation; PR [#5](https://github.com/castlemilk/token-horizon/pull/5) already improved MCP estimate/invoice provenance. Both merged on 7 October 2026, without merger itself proving deployment. PR [#8](https://github.com/castlemilk/token-horizon/pull/8) supplies identity/auth infrastructure, not enterprise admin roles. PR [#25](https://github.com/castlemilk/token-horizon/pull/25) is an open draft limited to default-disabled homepage marketing analytics and explicitly excludes dashboard/account/profile telemetry; it is not this track's measurement foundation. [#24](https://github.com/castlemilk/token-horizon/pull/24) is its closed-unmerged predecessor. Coordinate fixture/test edits around [#45](https://github.com/castlemilk/token-horizon/pull/45) rather than duplicating its animation-sampling patch. [I04] [I05] [I08] [I25] [I45]

## 13. Synthetic dataset and verification package

The supplied fixture has two synthetic tenants, six observed actors, overlapping crews, an explicit unreported day, a fully reported zero day, partial source periods, a duplicate delivery, a downward correction and a late observation. All identifiers, amounts and activity are invented; no model prices or customer usage are implied.

For the UTC window 11 November inclusive through 18 November exclusive, at 18 November 06:00Z:

| Synthetic measure | Expected value | Meaning |
| --- | --- | --- |
| Unique Orion tokens | 2,960,000 | Canonical latest facts, tenant isolated. |
| Canonical requests | 29 | Duplicate removed; correction replaces. |
| Observed actors / opted-in / roster | 6 / 6 / 8 | Distinct populations. |
| Sessions | 12 | Fixture keys tenant + actor + session; a production contract also needs source qualification. |
| Estimated metered amount (synthetic) | USD 27.60 | Kept separate from reported cost; no catalog rate/version evidence in this fixture. |
| Provider-reported usage cost (synthetic class) | USD 36.25 | Invented provider-source example, not invoice/paid spend or a verified integration. |
| Known visible cost rows | 19 / 29 | Five unknown and five withheld rows remain distinct. |
| Estimated-cost token denominator | 870,000 | Only comparable estimate-bearing records. |
| Reported-cost token denominator | 290,000 | Only comparable reported-cost records. |
| Lyra contribution tokens | 2,240,000 | Overlapping crew. |
| Summed crew contributions | 5,200,000 | Must not replace unique tenant total. |
| Earlier as_of tokens | 2,660,000 | At 18 November 2026, 00:00 UTC; late observation not yet visible. |

Daily tokens are 210,000; 410,000; 450,000; unknown; 0; 840,000; 1,050,000. The unknown day must not be converted to zero. Nov 13 and Nov 17 are partial even after late ingestion; a complete dollar total cannot be inferred from their observed subtotals.

In this small fixture, cost_basis is a legacy scenario discriminator; the additive cost_availability and cost_measurement_basis fields express the proposed separation. The five known-zero rows have visible zero amounts but unresolved measurement basis. They count toward 19/29 visible-amount coverage and belong to neither estimated nor provider-reported rate denominators. A zero amount with a verified provider-reported basis would belong in that basis's denominator. This distinction prevents silently excluding comparable free observations from a cost-intensity ratio.

The verifier checks identity/revisions, delivery deduplication, as-of selection, tenant scoping, matched cost denominators, ratio-of-sums behavior, missing/zero distinction, membership overlap, timezone/DST examples and an illustrative threshold rule. **69/69 checks passed.** This validates the fixture and oracle only. It does not implement production storage, authentication, suppression against differencing, retention deletion or notification delivery.

Additional source checks evaluate extracted pure helpers and SQLite expressions against synthetic values. They reproduce the calendar-date selection, contribution overlap, sanitizer retention and local-query concerns described above. Their scripts/results are included with provenance so reviewers can inspect exactly what was exercised.

Three original wireframes illustrate self, restricted team-analyst and admin data-quality views. Their SVG and HTML carry visible proposal/synthetic/not-implemented labels. SVG parsing, JavaScript syntax and fixture checks passed, and the rasterized layouts were visually reviewed. A local browser launch failed before page load because the environment denied its process-singleton socket; no elevation was attempted. Consequently interactive behavior, assistive-technology behavior and responsive rendering of the HTML remain untested proposals. Static layout review is not an end-to-end UI test.

## 14. Delivery and cross-track contracts

| Track | Required handoff to/from Track 5 |
| --- | --- |
| Track 2: UI/team management | Verified tenant/principal/capabilities; current membership; field permissions; consent/revocation signals; navigation hooks. Track 5 supplies analytics entry points and state requirements, not invitations/settings redesign. |
| Track 6: token/context analytics | Versioned normalized token/cost/request/timing semantics, source coverage and canonical observation identity. Track 5 supplies denominator/filter/aggregation needs and consumes the approved metric IDs. |
| Track 3: knowledge graph | Optional stable project/entity IDs under existing permissions. No raw-prompt mining or graph dependency for initial analytics. |
| Track 4: SEO | Public/community routes retain appropriate discovery; private analytics/export URLs excluded from indexing. No private query values in metadata or public sitemaps. |
| Track 1: market research | Validate persona and willingness to pay for reconciliation/team reporting. This study does not assert customer demand, revenue or measured productivity. |

A feasible first milestone is **current analytics correctness + public DTO safety + richer availability fields**. It can be reviewed independently of a private enterprise architecture. The next milestone is a single metadata-only private query through the full identity, ingestion, authorization and retention path. Private team/admin UI should remain capability-gated until that path passes negative tests.

## 15. Source register

All repository source citations below refer to the pinned commit. Line ranges are provided in the companion audit notes where relevant; the source links remain immutable. Public documentation was retrieved on 18 November 2026. External API capabilities may change and must be rechecked before implementation.

### Repository source

- [S00] Repository metadata, branch and commit: https://github.com/castlemilk/token-horizon/commit/b468206e9378c8d7a6788b67072494982e7de17d
- [S01] PRODUCT.md: current product purpose, published-only scope and unavailable/zero rules.
- [S02] LEADERBOARD.md: architecture/context, current team history and multi-membership sections; some earlier narrative is stale.
- [S03] docs/workspace.js: lines 57–89 freshness; 141–196 summary/chart; 217–246 model/session/project/source views.
- [S04] docs/leaderboard.html: 5291–5457 team views; 5814 allowDownload UI; 6412–6464 shared report rendering; 3313–3415 Workspace identity.
- [S05] clients/macos/Sources/TokenHorizon/Leaderboard/LeaderboardStore.swift: bounded publication, costs/titles and contribution data.
- [S06] cloudflare/src/usage-history.js: authoritative bucket replacement and reconciliation.
- [S07] docs/sync-consistency.md: capture/publication/ETag/correction invariants.
- [S08] cloudflare/src/index.js: 228–245 sanitizer; 307–345 observed-date history; 480–520 team aggregation; 873–1000 ranking/KPIs; public profile/auth/claim paths.
- [S09] daemons/go/internal/store/query.go: event filtering, effective annotations and aggregate/timing queries.
- [S10] gateway/README.md and gateway/store.go: local trace scope and storage bounds.
- [S11] daemons/go/internal/store/schema.go; daemons/go/internal/usage/types.go; daemons/go/internal/cloudsync/sync.go.
- [S12] cloudflare/src/leaderboard-storage.js and cloudflare/usage-history.test.mjs.
- [S13] clients/macos/Sources/TokenHorizon/UI/UsageHistoryViews.swift.
- [S14] clients/macos/Sources/TokenHorizon/UI/TeamsViews.swift.
- [S15] clients/crossplatform/app/components/token-horizon/tokens-tab.tsx and clients/app/app/components/token-horizon/activity-tab.tsx.
- [S16] scripts/test-workspace-ui.mjs and scripts/test-profile-ui.mjs: inspected regression cases, not run as a full suite.
- [S17] scripts/bench-leaderboard.mjs: defined fixture thresholds, not current production measurements.
- [S18] DESIGN.md: current Quiet precision identity and accessible analytics principles.

- [S19] README.md: authoritative public product links.
- [S20] daemons/go/internal/store/store.go: unbounded default usage retention and optional pruning on open.
- [S21] daemons/go/internal/store/trace.go: local trace limits and measured operational metrics.
- [S22] daemons/go/internal/api/compat.go: compatibility /stats cost-equivalent precedence.
- [S23] gateway/store.go: ring, file-count, body-size and directory-size bounds.
- [S24] daemons/go/internal/usage/types.go: local metered observation fields.
- [S25] daemons/go/internal/cloudsync/sync.go: configured outbox transport.
- [S26] clients/app/app/components/token-horizon/activity-tab.tsx: separate client behavior.
- [S27] scripts/test-profile-ui.mjs: inspected public-profile regression cases.
- [S28] clients/macos/Sources/TokenHorizon/Usage/UsageEngine.swift: local capture, timezone grouping and parser-health source.
- [S29] cloudflare/usage-history.test.mjs: existing source reconciliation tests, inspected rather than run as a full suite.

### Live product and primary references

- [L01] https://token-horizon.dev/ — verified canonical landing page, illustrative demos.
- [L02] https://token-horizon.dev/teams — anonymous live comparisons/history/table observed.
- [L03] https://token-horizon.dev/leaderboard.html?view=dashboard — anonymous published-only Workspace state observed.
- [P01] OpenAI Completions Usage API: explicit half-open window, grouping and minute/hour/day grain.
- [P02] OpenAI Costs API: daily grain and supported grouping constraints.
- [P03] Anthropic Usage and Cost Analytics API: beta usage/cost dimensions, scopes and endpoint distinction.
- [P04] Prometheus Histograms and summaries: aggregate distributions rather than precomputed quantiles.
- [P05] OWASP CSV Injection: spreadsheet formula risks and target-dependent mitigation.

### Issue links and deduplication anchors

The numbered issue links below are authoritative issue records. Proposed T5 identifiers in this document are local planning IDs only. No issue or PR was created or modified.

| Existing record | Observed state; last update (UTC) | Track 5 disposition |
| --- | --- | --- |
| [#12: [Research preservation] Token Horizon direction and validation backlog — 2026-11-11](https://github.com/castlemilk/token-horizon/issues/12) | Open issue; 2026-11-11 04:42:31 | Parent roadmap; reuse THR subitems and link local T5 drafts. |
| [#13: [Proposed] TH-UI-01 Truthful observability and request-attempt detail](https://github.com/castlemilk/token-horizon/issues/13) | Open issue; 2026-11-11 04:42:46 | Measurement integrity, request/attempt semantics, current correctness. |
| [#19: [SEO][High] Expose reproducible pricing provenance and freshness in catalog comparisons](https://github.com/castlemilk/token-horizon/issues/19) | Open issue; 2026-11-18 03:56:17 | Price versions, freshness and cost provenance. |
| [#23: [SEO][Medium] Complete rendered, accessibility, performance and indexing validation](https://github.com/castlemilk/token-horizon/issues/23) | Open issue; 2026-11-18 03:56:52 | Accessibility, rendered behavior and performance gates. |
| [#44: [CI][P1] Explain the render-budget failure without relaxing its threshold](https://github.com/castlemilk/token-horizon/issues/44) | Open issue; 2026-11-17 04:00:09 | Diagnose existing render failure; preserve its threshold. |
| [#36: [CI][P1] Consolidate browser fixtures and orchestration without deleting scenarios](https://github.com/castlemilk/token-horizon/issues/36) | Open issue; 2026-11-17 03:59:06 | Reuse fixture lifecycle and isolation work. |
| [#26: [CI][P1] Give local and CI checks one authoritative command manifest](https://github.com/castlemilk/token-horizon/issues/26) | Open issue; 2026-11-18 00:30:40 | Use authoritative test command manifest. |
| [#39: [CI][P2] Make the default MCP test command hermetic](https://github.com/castlemilk/token-horizon/issues/39) | Open issue; 2026-11-17 03:59:43 | Keep default MCP checks hermetic. |
| [#41: [CI][P1] Verify catalog commit-to-publication lineage](https://github.com/castlemilk/token-horizon/issues/41) | Open issue; 2026-11-17 03:59:59 | Do not infer deployed code from source commit; publication lineage. |
| [#16: [Proposed] TH-UI-04 Reviewed work handoff, plans and setup evidence](https://github.com/castlemilk/token-horizon/issues/16) | Open issue; 2026-11-11 04:42:56 | Reuse reviewed handoff/preview conventions; analytics export remains new scope. |
| [#4: Add MCP app extensions and reliable metadata traces](https://github.com/castlemilk/token-horizon/pull/4) | Merged PR; 2026-10-07 21:40:49 | Merged 7 Oct; preserve hosted/local metadata separation. |
| [#5: Clarify MCP usage labels and cost provenance](https://github.com/castlemilk/token-horizon/pull/5) | Merged PR; 2026-10-07 22:04:28 | Merged 7 Oct; extend existing estimate/invoice distinctions. |
| [#8: Add managed account sign-in for website and MCP review access](https://github.com/castlemilk/token-horizon/pull/8) | Merged PR; 2026-10-24 06:38:42 | Merged 24 Oct; identity infrastructure is not enterprise RBAC. |
| [#25: feat: prepare isolated opt-in homepage analytics (clean scope)](https://github.com/castlemilk/token-horizon/pull/25) | Open draft PR; 2026-11-17 03:13:03 | Open draft: homepage-only opt-in GA4, excluded from dashboard telemetry. |
| [#24: feat: prepare opt-in homepage analytics](https://github.com/castlemilk/token-horizon/pull/24) | Closed unmerged PR; 2026-11-17 03:13:20 | Closed unmerged predecessor; do not revive as analytics foundation. |
| [#45: test: wait for observable ASCII animation progress](https://github.com/castlemilk/token-horizon/pull/45) | Open draft PR; 2026-11-17 04:51:33 | Open draft: coordinate fixture/animation sampling changes. |

The complete 46-record inventory and per-record disposition are in issue-map.json. Dates above are GitHub updated_at timestamps, not an assertion that implementation shipped at that moment.

[S00]: https://github.com/castlemilk/token-horizon/commit/b468206e9378c8d7a6788b67072494982e7de17d
[S01]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/PRODUCT.md
[S02]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/LEADERBOARD.md
[S03]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/workspace.js
[S04]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html
[S05]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Leaderboard/LeaderboardStore.swift
[S06]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/usage-history.js
[S07]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/sync-consistency.md
[S08]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js
[S09]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/store/query.go
[S10]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/README.md
[S11]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/store/schema.go
[S12]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/leaderboard-storage.js
[S13]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/UI/UsageHistoryViews.swift
[S14]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/UI/TeamsViews.swift
[S15]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/crossplatform/app/components/token-horizon/tokens-tab.tsx
[S16]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/test-workspace-ui.mjs
[S17]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/bench-leaderboard.mjs
[S18]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/DESIGN.md
[L01]: https://token-horizon.dev/
[L02]: https://token-horizon.dev/teams
[L03]: https://token-horizon.dev/leaderboard.html?view=dashboard
[P01]: https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions
[P02]: https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs
[P03]: https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api
[P04]: https://prometheus.io/docs/practices/histograms/
[P05]: https://community.owasp.org/attacks/CSV_Injection
[I00]: https://api.github.com/repos/castlemilk/token-horizon/issues?state=all&per_page=100&page=1&sort=created&direction=desc
[I04]: https://github.com/castlemilk/token-horizon/pull/4
[I05]: https://github.com/castlemilk/token-horizon/pull/5
[I08]: https://github.com/castlemilk/token-horizon/pull/8
[I12]: https://github.com/castlemilk/token-horizon/issues/12
[I13]: https://github.com/castlemilk/token-horizon/issues/13
[I16]: https://github.com/castlemilk/token-horizon/issues/16
[I19]: https://github.com/castlemilk/token-horizon/issues/19
[I23]: https://github.com/castlemilk/token-horizon/issues/23
[I25]: https://github.com/castlemilk/token-horizon/pull/25
[I26]: https://github.com/castlemilk/token-horizon/issues/26
[I36]: https://github.com/castlemilk/token-horizon/issues/36
[I39]: https://github.com/castlemilk/token-horizon/issues/39
[I44]: https://github.com/castlemilk/token-horizon/issues/44
[I45]: https://github.com/castlemilk/token-horizon/pull/45


[S19]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/README.md
[S20]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/store/store.go
[S21]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/store/trace.go
[S22]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/api/compat.go
[S23]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/store.go
[S24]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/usage/types.go
[S25]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/cloudsync/sync.go
[S26]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/app/app/components/token-horizon/activity-tab.tsx
[S27]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/test-profile-ui.mjs
[S28]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Usage/UsageEngine.swift
[S29]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/usage-history.test.mjs