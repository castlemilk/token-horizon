# Token Horizon SEO research and implementation specification

## Track 4 | 18 November 2026 | Reviewable research, not a deployed change

**Recommendation:** finish URL consistency, public catalog rendering, and catalog publication evidence before expanding the content footprint. Token Horizon already has substantial metadata, robots, schema and privacy-related indexing controls. The highest-value next step is to complete and validate the existing work under issues #18-#23, #41 and #46.

This study stayed in the requested read-only research scope. It did not change a shared repository, create an issue or PR, merge, deploy, publish a website, submit a sitemap, change authentication or permissions, buy services, or contact third parties. The artifacts are isolated drafts. Proposed implementation, acceptance criteria, page designs and effort estimates are explicitly untested.

### The decisions this report supports

1. **Repair known URL-policy drift first.** The sitemap still advertises the old teams destination and .html article aliases. The article redirect/canonical conflict is already documented in #46; its current source is corroborated, while the exact live redirect chain could not be freshly reconfirmed in the later blocked HTTP batch.
2. **Make the catalog useful before JavaScript runs.** The source serves an empty application mount with metadata injected into the head. The browser successfully rendered Explorer and Cheapest, so this is a resilience and extraction opportunity, not proof Google cannot index the product.
3. **Resolve the source-to-public catalog discrepancy.** The browser displayed a 5 November catalog snapshot; the pinned source export is dated 18 November. This substantiates #41's investigation, without isolating publication, cache or fallback as the cause.
4. **Publish evidence-bearing content in a small program.** Start with a cost guide, a context guide and revisions to existing methodology, privacy and setup documentation. Eight useful briefs do not require eight new URLs.
5. **Retain privacy boundaries.** Tenant analytics, account views, invitations and all shared-report pages remain outside public indexing and discovery. Public catalog facts and synthetic examples are the permitted content inputs.
6. **Treat unavailable measurements as gaps.** OpenSEO's connection expired. No Search Console, GA4, Bing property data, traffic, rankings, keyword volumes, backlink metrics, field Core Web Vitals or search uplift was measured.

Evidence: [repository revision][S01], [route metadata][S04], [public application source][S05], [sitemap][S06], [catalog export][S10], [existing SEO backlog][I18], [canonical issue][I46], [publication issue][I41].

## 1. Provenance, terminology and boundaries

### Repository and product identity

| Item | Observed evidence |
|---|---|
| Repository | https://github.com/castlemilk/token-horizon |
| Branch | main; the head was rechecked during report preparation and remained unchanged |
| Immutable commit | b468206e9378c8d7a6788b67072494982e7de17d |
| Commit timestamp | 18 November 2026, 07:35:19 UTC / 18:35:19 AEDT |
| Commit subject | catalog: refresh model list (2026-11-18) |
| Authoritative public origin | https://token-horizon.dev/ |
| Domain evidence | README badge/introduction and Cloudflare custom-domain configuration; repository homepage metadata itself was null |
| Source scope | Untruncated recursive tree of 2,031 entries; 72 selected source files/assets verified against Git blob identities, plus a separate immutable catalog-blob inspection |
| Live/source identity limit | The production Worker revision was not established. Current main is not automatically the deployed revision |

The public site is static HTML, CSS and vanilla JavaScript under docs/, served through a Cloudflare Worker and its ASSETS binding. The Worker runs first. This is not a Next.js application, and a framework migration is unnecessary for the proposed fixes. OAuth/MCP routing wraps the site Worker; data and public metadata have separate contracts. The configuration also references www.token-horizon.dev and a legacy host, but their complete current redirect matrices were not established. [S02][S03][S12]

### Evidence labels used throughout

| Label | Meaning |
|---|---|
| **Measured / observed public** | An HTTP response, public browser state or deterministic local test actually observed in this study; method and scope are stated |
| **Source-only** | Behavior present at the immutable revision, without assuming it is deployed |
| **Historical evidence** | A dated issue, comment or PR reports an earlier observation; it is not relabelled as a fresh test |
| **Inferred** | A reasoned explanation or likely implication that still needs a discriminating check |
| **Proposed / untested** | A design, repair, acceptance test, content brief, threshold or effort estimate not implemented by this study |
| **Not tested / unavailable** | A capability or measurement that was unavailable or outside the bounded sample; it is not a failure or a pass |

“Current” means current in the stated source or public observation. “Shipped” is used only where live behavior or a specific release/publication receipt supports it. A merged PR, source test, generated file, browser render and search-engine outcome are separate evidence states.

All user-facing dates use Melbourne time where a local time is helpful. UTC timestamps remain intact in the evidence bundle. Early HTTP timestamps are response Date-header values, not independently logged local acquisition times. The browser's exact observation time was not logged; its observations occurred during this 18 November study.

## 2. Checks completed and access gaps

### Executed capabilities

| Capability | What actually ran | Practical limit |
|---|---|---|
| Repository inspection | Pinned files, routing, metadata, sitemap, robots, docs, catalog exporter, workflows and tests | Selected relevant source; no entire product security or release certification |
| Backlog review | Bounded open/closed issue inventory, topical searches, relevant full issues/comments and PRs | No independent search total or pagination cursor was exposed |
| Source test suite | 9 Worker metadata tests and 5 static site SEO tests passed, with no dependency installation | Synthetic ASSETS/storage fixtures and filesystem assertions; no live routing or indexing proof |
| Public HTTP, early sample | robots.txt 200; sitemap.xml 200; www homepage request ended at apex 200 | Homepage output truncated; intermediate redirect code/hops not retained |
| Public browser | Explorer and Cheapest rendered; their title, canonical, H1 and robots values were read | Providers attempt timed out in automation; Plans/mobile/error states were not verified |
| Limited keyboard check | First Tab focused Skip to content; Enter focused the main catalog container | One keyboard path, not a complete accessibility audit |
| Existing SEO skill | Exact offline snapshot and relationship analyzers ran on two separate capture batches | Zero complete eligible HTML pages in the analyzer input; only robots/sitemap were analyzable |
| Source HTML parsing | Nine selected static files parsed for head/H1/noscript/alt/schema element counts | Presence/counts do not establish quality, rendering or WCAG conformance |
| Primary guidance | Current official Google, OpenAI, Cloudflare, W3C and web.dev documentation | Platform guidance does not reveal Token Horizon property settings or outcomes |

The existing test commands were:

~~~sh
node --test cloudflare/page-metadata.test.mjs
node scripts/test-site-seo.mjs
~~~

They ran against the isolated pinned copy using Node v24.22.1. Results were **14 passed, 0 failed, 0 skipped**. These commands did not install packages or touch live usage data. The test files are [S13] and [S14].

### Public acquisition outcomes, without overstating them

The early unauthenticated GETs used the explicit user agent TokenHorizon-ReadOnly-Research/1.0. The response Date headers were 08:11:53 UTC for robots, 08:12:00 UTC for sitemap and 08:12:12 UTC for the homepage. The robots body was 682 bytes; the sitemap body was 965 bytes. The homepage was followed from www to the apex, but only its first 20,000 decoded characters were retained in the tool output, so it was marked incomplete.

A later predefined HTTP batch used Python-urllib/3.12, no cookies or authentication and an identity encoding request. It had 27 planned URLs; 24 outcomes were serialized before the 55-second bound ended. Those outcomes contained **18 HTTP 403 responses and 6 timeouts**. The 403 body identified Cloudflare Access Denied, error 1010. The remaining three host/scheme variants have no reliable result. There were no further HTTP probes, fingerprint changes or attempts to bypass the denial.

Cloudflare documents 1010 as a client-signature access denial. This establishes a refusal of that HTTP client in that sample. It does not establish a Googlebot block, site-wide outage or user-visible failure. The successful public browser renders are separate evidence. Differences in client and time prevent attributing the outcome solely to the user-agent string. [P04]

The browser's later Providers action hit a protocol timeout; a follow-up state read also timed out. This is an automation coverage limit, not a measured INP or site-speed failure. Explorer and Cheapest observations remain valid; Providers and Plans are not claimed verified.

### SEO skill provenance and actual coverage

No SEO-specific skill appeared in the fully paged runtime skill catalogs or in the Token Horizon repository tree. An applicable existing draft was accessible in skunkworq/skunkworq-skills PR #32: portfolio-seo-audit, revision **0b456a340126e868559e0ce750ba7a2ccf855510**. Its instructions, evidence contract, runner, upstream coverage and capability adapter were read. The two independent, standard-library-only scripts were reviewed and fetched unchanged; their Git blob identities were verified. [K01]

The early analyzer run counted **one User-agent declaration, one sitemap declaration and 13 sitemap loc elements**. It correctly skipped the truncated homepage. The late run included 18 query-free records: 15 blocked responses and 3 timeouts, all not-tested. Six query-bearing captures were excluded intact because the runner disallows query URLs; no query was stripped and relabelled.

The relationship analyzer flagged five sitemap targets as “invalid-or-sensitive-target” solely because they contain public query parameters outside its accepted input policy. **This is a tool limitation, not five invalid URLs or SEO defects.** Seven other destinations were outside the sample. No complete HTML metadata, canonical-target, heading or schema assessment can be attributed to these offline runs.

This was not a native/full claude-seo run. No upstream bundle was installed, and no fixture result is presented as production evidence.

### Unavailable or deliberately unperformed

OpenSEO returned UNAUTHORIZED with an expired-connection/reauthentication message. The user explicitly instructed that it remain disconnected; it was not reconnected. No paid OpenSEO operation, account change, settings update or authentication flow ran.

Search Console URL Inspection and search performance, GA4, Bing Webmaster property data, CrUX/RUM, Lighthouse/PageSpeed lab runs, rich-results validation, a full crawl, screen-reader testing and mobile/reflow testing remain unavailable or not run. No rankings, traffic, CTR, conversions, keyword volumes, backlinks, indexed-page count or causal uplift is supplied.

## 3. What is already implemented and worth preserving

The source contains titles, descriptions, canonical tags, robots policy, Open Graph/Twitter metadata, social images and JSON-LD. Ordinary collection metadata is deliberately independent of model/usage storage, avoiding a data lookup merely to generate a document head. A generic “add SEO tags” ticket would duplicate existing work. [S04][S05]

The homepage, documentation and both articles contain substantive static HTML. The selected source parser found one H1, title and canonical in each of those five pages. The homepage also contains two noscript fallbacks. The selected source files had no image missing an alt attribute; that says nothing about whether every alternative is appropriate. [S15][S16][S17][S18][S19]

Known workspace, billing, settings, sign-in, invitation and report routes receive noindex treatment in the Worker metadata contract. Sensitive report HTML uses private, no-store and no public schema; all `/s/<id>` report pages are excluded from indexing even when link sharing is public. The common JSON helper adds an X-Robots-Tag noindex header. These are source and fixture-tested strengths, not a fresh cross-tenant authorization audit. [S04][S12][S13]

The catalog exporter preserves unknown pricing separately from explicit free or plan-covered states and carries approximation labels for benchmark data. That is a useful foundation for source-backed content. Preserve these distinctions while improving field-level provenance and explanatory copy. [S09]

Robots allows the public site and specific public rendering APIs while disallowing the wider API namespace, OAuth, MCP and bundled internal/source directories. A crawlable data endpoint can carry noindex so a renderer can use it without treating the JSON itself as a search landing page. Robots and noindex still do not protect confidential data; authorization and cache isolation do that. [S07][S12][P03]

## 4. Findings: evidence, consequence and confidence

### F1. Source and loaded catalog snapshots differ

**Classification:** observed public/source discrepancy. **Confidence:** high that the two dates differ; cause unresolved. **Owner:** existing #41, with #19.

The public model explorer displayed **Catalog snapshot · Nov 5, 2026**. The pinned catalog contains generatedAt **1794987318**, or **18 November 2026, 07:35:18 UTC**. The UI derives its visible snapshot date directly from the loaded catalog's generatedAt value. The source catalog has 2,186 model records, 157 provider records and 13 plans; these are source counts, not measured live inventory. [S05][S10]

The source build object records builtAt 07:35:13 UTC, version 0.5.2 and commit 56841ba. That short SHA is the parent source revision from which the export was generated. It is expected to differ from the later commit that adds the generated artifact. Acceptance must trace the relationship rather than demand identical SHAs.

The refresh workflow regenerates and commits the catalog. It contains no Worker-deployment step. The app fetches /api/models/catalog with a static-file fallback, and the Worker has separate caching behavior. These facts justify investigating publication/cache/data-path lineage, but do not prove which path produced the browser observation. Do not describe every rate, the whole site or every user as thirteen days stale. [S11][S12][I41]

**Decision:** establish a traceable export-to-served digest and per-field verification dates before making “current pricing” or “always in sync” promises. Source docs currently imply scheduled regeneration prevents app/web drift; revise that claim to distinguish generation from publication. [S16]

### F2. Catalog body depends on JavaScript

**Classification:** source-only initial-body observation plus successful public rendered evidence. **Confidence:** high. **Owner:** #18; validation #23.

The shared application document contains an empty main mount at docs/leaderboard.html line 696. Its initial parsed HTML has no H1 and no noscript. The Worker replaces/injects head metadata rather than rendering catalog records into the body. The browser then fetches catalog JSON and constructs the model UI. [S04][S05][S12]

The public browser successfully rendered an Explorer H1, a self-canonical /models URL, index/follow robots and model options. The observed virtualized viewport contained 20 option elements and no anchors inside those model rows. That is a sample of the rendered DOM, not a claim that every link in the application is JavaScript-only; other model navigation anchors exist in source.

Cheapest also rendered with its own H1 and title. Its browser URL included view=models&tab=cheapest, while its canonical correctly omitted the redundant view parameter. These two views have distinct visible purposes. Providers and Plans still need the rendered comparison required by #20.

Google documents JavaScript crawling/rendering, so the evidence does not justify “Google cannot index the catalog.” A small public HTML renderer would reduce reliance on rendering/data availability and improve link extraction and non-JavaScript access. [P01]

**Decision:** use the existing static/Worker architecture to generate a bounded public catalog summary and a small reviewed model-detail pilot; progressively enhance the same content. Do not render private account usage or produce every filter/model-pair permutation.

### F3. Article canonical policy remains inconsistent with reported clean serving

**Classification:** current source + same-day historical HTTP evidence; exact fresh chain not reconfirmed. **Confidence:** high in source policy, bounded in current deployment. **Owner:** #46.

Both article heads, their social/schema URLs, blog/docs links, sitemap and llms.txt use .html document URLs. Issue #46 records an 18 November probe where pricing-evidence.html redirected with 307 to the extensionless article, whose canonical pointed back to .html. The later HTTP sample in this study was blocked or timed out, so the report does not claim it independently reproduced that exact chain. [S06][S08][S16][S17][S18][S19][I46]

This is a redirect/canonical conflict, not necessarily an HTTP redirect loop. Passing tests do not rebut it: static assertions explicitly expect the .html canonicals, while Worker tests stub asset requests as 200. [S13][S14]

**Decision:** align each article's terminal 200 document, canonical, JSON-LD, sitemap, llms link and internal links. Retain source filenames if useful; document URLs need not have the same suffix. Verify actual ASSETS behavior before choosing the exact redirect implementation. Google recommends consistent canonical signals. [P02]

### F4. Teams discovery still advertises an obsolete destination

**Classification:** fresh sitemap body + source route discrepancy. **Confidence:** high. **Owner:** #20, validation #23.

The successfully retrieved sitemap has 13 entries, including /leaderboard?view=teams. Current Worker source redirects that document route to /teams with 302, and metadata uses /teams as canonical. llms.txt also advertises the old destination. The live redirect was not freshly measured in this study. [S06][S08][S12]

**Decision:** replace this sitemap/discovery alias with /teams and ensure current nav links resolve consistently. If a legacy document move is permanent, choose and test a durable redirect policy; do not alter the separate legacy JSON API contract. Thirteen sitemap entries are not thirteen indexed pages.

### F5. Metadata policy is duplicated and needs one contract

**Classification:** source-only maintainability/parity risk. **Confidence:** high in duplication, unmeasured search impact. **Owner:** #20/#23.

Static HTML, cloudflare/src/page-metadata.js and client syncDiscoveryMetadata maintain overlapping titles, canonical and schema policy. The browser's rendered model title differs from the initial Worker title while the observed canonical agrees. Different wording alone is not a defect. The client also has a claim-query noindex condition absent from the server helper; this is a parity-test candidate, not evidence of leaked private data. [S04][S05]

**Decision:** define one public route/publication registry and test initial HTML, history navigation and rendered state against it. Preserve private precedence and remove private identifiers from canonical/social metadata.

### F6. Pricing claims need more precise evidence and scope

**Classification:** source-only data contract and editorial opportunity. **Confidence:** high. **Owner:** #19; dependencies #12/#13/#41.

The export records generation/build metadata, but the inspected contract does not provide a standard field-level official source, observation/effective date, currency, unit and offer conditions for every displayed price. A new export timestamp cannot stand in for verification of every upstream fact. The plan artifact separately says plansUpdatedAt 15 September 2026. This is a source date, not proof each plan is wrong. [S09][S10]

The Cheapest calculation selects positive input prices, pairs an output rate from the listing and calculates discount relative to direct input price. It does not establish the cheapest total workload or an independently cheapest output provider. The public label should explain the ranking dimension, especially before using “cheapest” as a content promise. [S05]

Existing documentation and the pricing case study classify local models as free. Clarify “no hosted provider per-token charge” separately from hardware, electricity, hosting or licensing cost. An ID containing “free” does not establish present offer eligibility. These refinements are already anticipated by #19's comment. [S16][S18][I19]

A possible wording contradiction was rejected during review: the docs say costs are never estimated **from resource usage**, not that rate-based cost estimates never exist. That is compatible with the later “not provider invoices” caveat. It should not be filed as a defect.

### F7. Access behavior varies across the observed methods

**Classification:** client-specific public access observation. **Confidence:** high for the recorded outcomes, no Googlebot diagnosis. **Owner:** #18/#23.

Early robots/sitemap requests succeeded, the browser rendered two public catalog views, and the later default-client batch received Cloudflare 1010 denials/timeouts. An older #23 comment reports a successful default-client /models GET at 03:54 UTC. All outcomes must remain dated and method-specific. [I18][I23][P04]

**Decision:** when a maintainer later has authorized edge/verified-crawler evidence, diagnose which rules and request classes affect legitimate search access. Do not weaken WAF settings broadly, spoof crawlers or interpret this research client's refusal as Google's index state.

### F8. Performance and accessibility require measured follow-through

**Classification:** source-size facts, limited browser observations and untested optimization hypotheses. **Owner:** #23/#44/#26.

The shared source shell is **483,610 bytes**; the catalog source artifact is **3,419,188 bytes**. Those are repository sizes, not compressed transfer bytes, parse cost, LCP or INP. Route-independent CSS/vendors and the large shared shell suggest useful code-splitting and data-delivery experiments after a lab baseline, not a measured “slow site” verdict. [S05][S10]

The Explorer keyboard skip path worked. Its observed DOM had no image missing an alt attribute, and controls exposed names in the accessibility tree. No complete keyboard journey, screen-reader test, contrast audit, responsive reflow test, chart alternative review or WCAG conformance assessment ran.

**Decision:** target WCAG 2.2 AA in the future validation matrix. Keep field goals of LCP at most 2.5 seconds, INP at most 200 ms and CLS at most 0.1 at the 75th percentile, segmented by device, separate from lab and CI budgets. Historical issue #44's view-switch timing is not field CWV. [P09][P10][I44]

## 5. Public URL and indexing specification

This is a proposed consolidation of the current contract, not a deployed route migration.

| Surface | Observed/source status | Proposed indexing decision |
|---|---|---|
| / | Substantive static product page; apex canonical | Index; retain truthful platform/release scope and public install links |
| /docs/, /blog/ | Substantive source HTML and sitemap entries | Index; improve task links and maintain one canonical for each explanation |
| Two blog articles | Source canonicals use .html; historical clean-serving conflict | Resolve #46, then list only terminal canonical URLs |
| /models | Metadata in initial head; catalog body client-rendered; browser verified | Retain indexable; add meaningful initial HTML; keep application enhancement |
| /models?tab=cheapest | Own canonical/H1 observed after rendering | Retain only with explicit ranking scope, provenance and distinct useful content |
| /models?tab=providers and tab=plans | Source self-canonicals; rendered checks incomplete | Decide under #20 after content comparison; avoid automatic blanket noindex |
| /leaderboard and leagues view | Public source routes; sitemap entries | Retain only intentionally published community content; do not expand personal-data discovery |
| /teams | Canonical in source; sitemap still old alias | Use /teams in public discovery; distinguish public community rankings from private tenant analytics |
| /benchmarks/ | Sitemap entry and merged PR #17 evidence | Verify current route/body/schema/status before claiming live benchmark completeness |
| ?model=, sort/filter/search/tracking variants | Application state, generally collection canonical | Keep useful app state; consolidate equivalent variants; no automatic combinatorial pages |
| `/u/<handle>`, `/t/<team>` | Public publication-dependent routes in source | No new sitemap enumeration; explicit publication/search consent and field allowlist required |
| Workspace/billing/settings, login/connect/OAuth | Sensitive/account routes with source noindex policy | Keep non-indexed; maintain auth, private cache and metadata boundaries |
| `/s/<id>`, invitations, restricted shares | Source noindex/private policy | Keep all shares non-indexed, including public-link reports; exclude from public discovery |

A noindex directive must be readable by a crawler to act as an indexing instruction; blanket disallow is not a substitute. For confidential resources, never make the sensitive data accessible merely so a crawler can read noindex. Return safe anonymous/error content and enforce authorization independently. [P03]

Existing public rendering APIs may remain fetchable while carrying noindex. Do not indiscriminately block the data or JavaScript needed to render allowed public pages. Do not use canonical to merge genuinely distinct, useful new model pages back into a generic hub. [P01][P02]

## 6. Priorities, dependencies, effort and risk

Effort is an untested planning estimate in engineer-days for a maintainer familiar with this repository. It excludes deployment approval, unavailable account access, external review delays and search-engine recrawl. Ranges overlap; they are not an additive delivery promise.

| Priority and existing owner | Proposed bounded result | Effort / main dependency |
|---|---|---|
| P1: #46 | Article canonical, redirect, sitemap and link agreement | 0.5-1.5 days; confirm actual asset-serving convention |
| P1: #20 | Teams sitemap/llms correction and URL-policy table | 0.5-1 day; preserve legacy API contract |
| P1: #41 + #19 | Export/build/publication lineage and visible freshness distinctions | 1-3 days investigation; publisher/cache evidence determines repair size |
| P1: #18 + #23 | Legitimate crawler-access diagnosis without broad security relaxation | 0.5-2 days investigation; authorized edge/crawler evidence |
| P1: #18 | Useful initial catalog HTML and crawlable reviewed entity links | 3-6 days; public-only renderer and stable catalog input |
| P2: #19 | Price/plan source evidence, conditions and scoped comparison copy | 3-6 days schema/UI work; provider evidence and Track 6 semantics |
| P2: #20 + #23 | Shared metadata/indexation registry and parity coverage | 2-4 days; route agreement with UI/team track |
| P2: #23 + #26 | Real asset-routing, privacy and rendered regression gates | 2-4 days; existing CI command-manifest work |
| P2: #21 + #19 | One cost guide, one context guide, three existing-doc revisions | 1-2 days per reviewed guide/revision; provenance and product truth gates |
| P2: #22 | Crawlable hosted/local MCP guide and llms policy consistency | 0.5-1.5 days; exact supported connector contracts |
| P3: #23 + #44 | Measured performance optimization and expanded accessibility checks | Baseline first; size repair only after actual bottleneck evidence |

**Recommended sequence:** correct the small canonical/sitemap inconsistencies; establish publication/access evidence in parallel; implement public HTML and one route contract; finish provenance; publish a deliberately small content batch only after its gates pass. Measure outcomes later with authorized first-party data. The user has not authorized publication through this research task.

The largest implementation risks are leaking personalized data into a shared renderer/cache, breaking legacy API or static-mirror routes during URL normalization, asserting refreshed prices without evidence, and spending on broad content before basic publication is reliable.

## 7. Backlog-ready refinements to existing issues

The following descriptions can be copied into the named existing issues by a future authorized task. No new issue identifiers are invented and nothing was posted.

### A. #46: normalize article terminal URLs and all discovery signals

**Problem and evidence:** source .html canonicals and links remain; the existing issue reports an alias redirect to an extensionless document that canonicals back to the alias.

**Implementation proposal:** preserve source filenames if convenient. Choose the public terminal convention after a permitted route check. Update docs/blog/pricing-evidence.html, docs/blog/why-token-horizon.html, docs/blog/index.html, docs/docs/index.html, docs/sitemap.xml and docs/llms.txt together. Update scripts/test-site-seo.mjs and add real asset-routing coverage. Consider explicit Worker normalization only where its interaction with ASSETS is understood. [S06][S08][S12][S14][S16][S17][S18][S19]

**Acceptance tests, unrun:** each canonical article URL returns 200 HTML and does not redirect; each legacy alias follows the documented permanent policy with at most one document redirect; canonical, og:url and Article URL agree; the canonical never points to an alias that redirects away; sitemap and crawlable article links use the terminal URL; host/path/query handling preserves intended navigation; no OAuth/API contract is changed.

**Risk/dependency:** mirror compatibility and edge HTML handling. A static regex test alone cannot close the issue.

### B. #20: one route policy for public discovery and private views

**Problem and evidence:** obsolete teams sitemap entry, three policy locations and unfinished rendered comparison of parameter tabs.

**Implementation proposal:** add a small shared public-page registry, consumed by the Worker, static generator and client metadata synchronizer. Start with existing routes; a candidate path is cloudflare/src/public-page-manifest.js or shared JSON. Generate sitemap and llms public-page links from an explicit allowlist. Replace the teams alias. Keep cheapest/providers/plans self-canonical only when each retained view satisfies a distinct documented search task.

**Acceptance tests, unrun:** the same route table drives initial and rendered expectations; tab/host/slash variants resolve consistently; arbitrary sort/filter/model/search inputs do not explode the sitemap; sensitive share/invite/signin/claim and account-view combinations never enter public metadata; private routes retain noindex after client navigation; public entity aliases resolve predictably; equivalent state variants consolidate without erasing meaningful public distinctions.

**Risk/dependency:** UI/team track owns navigation and tenant separation. Test mixed parameters instead of assuming the helper's behavior equals every routed response. No private disclosure was demonstrated here.

### C. #18: render a useful public catalog before hydration

**Problem and evidence:** empty source mount, metadata-only Worker injection, JS/data-dependent model body.

**Implementation proposal:** a pure public build step reads the approved catalog export and produces a bounded H1, scope/methodology, evidence date, selected records and real detail/methodology links. Candidate path: scripts/build-public-catalog-pages.mjs. Integrate the HTML into the existing route/ASSETS design and progressively enhance it. Create a reviewed pilot of up to six entity pages only after identity/provenance requirements pass; the cap is an editorial proposal, not a target to fill with weak pages.

**Acceptance tests, unrun:** with JavaScript disabled and the catalog API unavailable, the hub and pilot page retain their main answer, public rows, units, unknown states and descriptive anchors; hydration does not duplicate H1/schema/canonical; rendered and initial statements agree; HTML is equivalent for humans and crawlers; unsupported entities return a real 404; thin/unreviewed entities never enter sitemap; the renderer has no access to account, R2 usage or prompt data.

**Risk/dependency:** model route shape must coexist with current /models handling. Prefer a focused public renderer over a framework rewrite. Performance improvement is to be measured, not assumed.

### D. #41: prove catalog export, public artifact and visible snapshot lineage

**Problem and evidence:** source generatedAt 18 November versus public browser snapshot 5 November; scheduled source refresh does not itself prove Worker publication.

**Implementation proposal:** record generator/source revision, artifact commit, generatedAt, content digest and deployed public artifact identity separately. Explain which API/static fallback serves the catalog. Make publication/cache state observable without exposing credentials. Correct documentation that equates regeneration with app/web synchronization.

**Acceptance tests, unrun:** a synthetic fixture traverses source, export and served asset with a matching content digest; expected build-parent and artifact-commit relationships are accepted; visible snapshot derives from the actual served artifact; cache invalidation/fallback behavior is documented and tested; failure does not advertise a fresh snapshot; plan/price observation dates remain independent of export dates.

**Risk/dependency:** no production publisher or cache was inspected through credentials. This is a scoped investigation and specification, not authority to deploy or purge.

### E. #19: make price, plan and “cheapest” claims reproducible

**Problem and evidence:** existing truthful price states need field-level evidence; ranking dimension and local cost wording require precision.

**Implementation proposal:** extend the public evidence model where absent: entity/provider ID, original source URL, observed/effective date, currency/unit, region/tier, input/output/cache categories, offer conditions, expiry, availability and evidence class. Preserve unknowns. Explain that input-rate ordering is not a total-workload optimization. Attach provenance/freshness to every price view, not just Explorer.

**Acceptance tests, unrun:** one public displayed rate can be reproduced from its official source and assumptions; an unknown price never renders as zero; promotional/free labels require current evidence and conditions; plan access never implies a per-token API rate; zero provider charge is separate from local operating cost; stale facts are visibly stale and cannot justify an unqualified cheapest claim; approximate or provider-reported benchmarks remain labelled; no private usage data becomes a catalog fact.

**Risk/dependency:** Track 6 owns token and cost semantics; Track 1 owns positioning; #12 THR-07 already owns tariff/source versioning. This task refines those contracts instead of duplicating them.

### F. #23 with #26: verify real routes, privacy parity and rendering

**Problem and evidence:** 14 source checks pass while tests embed legacy URL assumptions and mock all asset requests as 200.

**Implementation proposal:** retain those useful tests, add an actual ASSETS integration fixture and a small allowed public route matrix after a separately authorized deployment. A candidate new script is scripts/test-public-routes.mjs. Add the exact commands to the authoritative local/CI manifest under #26 rather than creating a competing test entry point.

**Acceptance tests, unrun:** article aliases/final URLs, teams and models slash forms, content negotiation, conditional requests, unknown documents and private response classes have asserted status/header/body outcomes; source and hydrated metadata agree; public views have useful content/links; load/error/empty states are accessible; all fixture identities and reports are synthetic. A failing or blocked HTTP client is reported distinctly from a page defect.

**Risk/dependency:** actual browser and edge environments are required for some gates. Passing fixtures must never be reported as Google indexing, field CWV or live cross-tenant security results.

### G. #21 with #19: turn discovery into a supported next step

**Problem and evidence:** existing public catalog and documentation can support useful task-based content, but roadmap proposals and platform differences must remain explicit.

**Implementation proposal:** add contextual links from public catalog/methodology into one verified setup flow. Identify supported OS/build/instrumentation, prerequisites, first-success check, privacy scope and cleanup. Distinguish download selection, installation and first valid tracked activity. Reuse current docs rather than generating one article per tool logo.

**Acceptance tests, unrun:** every capability claim maps to inspected release/source and, where required, tested behavior; macOS notch/widget claims are not assigned to Windows/Linux; no paid plan or team capability is invented; a worked setup has a synthetic expected result and no embedded credential; unsupported cases receive explicit limitations; the journey is usable without uploading a prompt.

**Risk/dependency:** Track 2 owns onboarding and UI; Track 5 owns any future private usage/activation evidence. A public content event is not proof of successful installation.

### H. #22: separate human MCP documentation from protocol endpoints

**Problem and evidence:** llms.txt links /mcp/public while robots disallows /mcp. The docs emphasize local/source servers; README separately explains the hosted OAuth connector.

**Implementation proposal:** provide one ordinary crawlable HTML guide explaining hosted public tools, authorized account scope, local stdio/engine capabilities, errors and version compatibility. Link the guide from llms.txt and relevant docs; keep protocol invocation endpoints restricted according to their purpose. Do not open private APIs to search crawlers merely to satisfy a discovery checklist.

**Acceptance tests, unrun:** the guide's examples match actual contracts and use synthetic data; hosted tools are never described as reading unpublished local traces; llms links resolve to intended public references; private/account/report routes remain absent; search and training crawler policy are documented separately; there is no claim that llms.txt is a Google ranking requirement.

## 8. Evidence-led content program and concrete page briefs

The priorities below reflect product relevance, existing content gaps and available primary evidence. They are **content hypotheses**, not measured keyword opportunities. No volume, difficulty, ranking or traffic estimates were obtained. Market sizing belongs to Track 1.

Primary provider documentation supports these educational intents: Claude separates cache-related billing categories and explains how history, tools and generated output consume context; OpenAI documents separate ChatGPT/API billing while allowing eligible subscription-linked API credits. These are evidence of real conceptual complexity, not evidence of search volume. The briefs require rechecking exact model and offer conditions at publication time. [P16][P17][P18]

The existing pricing-evidence article is a dated 15 September engineering case study about pricing-state correction. Its historical counts are explicitly tied to that fix; retain their dates rather than treating them as current statistics. Current docs already cover usage sources, plan limits, catalog semantics, publishing/privacy, MCP, gateway and setup. [S16][S18]

### Brief 1: calculate API cost with explicit assumptions

**Disposition:** new distinct guide; proposed /guides/llm-api-costs. **Owner:** #19/#21; Track 6 dependency.

**Title/H1 proposal:** “Calculate LLM API costs from input, output and cached tokens.”

**Intent:** a developer needs to reconcile a scenario with billable categories, not merely sort headline prices. The distinctive value is a reproducible synthetic calculation and an explicit separation of published rate, estimated charge and actual invoice.

**Content outline:** define units; normalize input/output/cache buckets; show one complete synthetic scenario; explain what is excluded; identify service-tier, regional, tool/storage and discount caveats; link to the model evidence and existing pricing-state explanation. Place a modest calculator on the same canonical page initially.

**Evidence gate:** official current provider rate/usage documentation and the actual Token Horizon accounting contract. Unknown categories must stay unknown. If input totals include cached tokens, normalize before applying separate cache prices.

**Acceptance:** the arithmetic is tested against fixed synthetic fixtures; the result is readable before interaction; examples never contain customer prompts; the method identifies rate date/currency and exclusions; no universal savings claim. CTA: open a supported public comparison or a verified setup guide.

### Brief 2: understand prompt-cache economics

**Disposition:** start as a substantial section of Brief 1; extract /guides/prompt-caching-costs only when it has sufficient independent depth. **Owner:** #19; Track 6 dependency.

**Title/H1 proposal:** “When prompt caching changes API costs.”

**Intent and original value:** explain a cold request, eligible repeated prefix, cache write/read and expiration with a transparent hypothetical sequence. Separate an assumed hit rate from a measured one, and provider-reported categories from inferred reuse.

**Evidence gate:** the exact provider's cache rules, rates, lifetime, eligibility and service constraints. Do not assume one provider's cache accounting applies to another.

**Acceptance:** cold/hit/expired calculations are reproducible; no double-counted cache buckets; scenarios that do not save money are visible; dates and conditions are adjacent to rates. Link to the parent cost method and a verified model evidence page. A short rewording of the cost guide does not justify a new URL.

### Brief 3: distinguish context capacity from token consumption

**Disposition:** new explanatory intent; proposed /guides/context-window-and-token-usage. **Owner:** #19/#21; Track 6, with Track 3 for memory claims.

**Title/H1 proposal:** “Context windows, output limits and token usage explained.”

**Intent and original value:** help a builder understand why a request/session reaches a limit, using an annotated synthetic turn with system/tool/history/current-input/output components. Distinguish advertised capacity, provider-reported consumption, local estimates and measured task reliability.

**Outline:** capacity versus consumption; turn accumulation; tools/reasoning; output reservation; compaction/truncation; instrumentation coverage; what the product can and cannot infer.

**Evidence gate:** current model/provider accounting specifications and actual instrumentation fields. No claim that a larger context window guarantees better long-task performance.

**Acceptance:** every numerical example is synthetic or directly sourced; unknown coverage is explicit; a text/table equivalent accompanies any graphic; unimplemented memory or knowledge-graph behavior is labelled proposed. CTA: relevant catalog context filter and cost-methodology guide.

### Brief 4: publish a curated model evidence page

**Disposition:** small new document pilot after #18/#19/#20/#41. Candidate route convention: `/models/<provider>/<model>/`, subject to routing review.

**Title proposal:** “Model name: published API pricing, context and availability.”

**Intent and original value:** answer one entity-specific decision with exact IDs, provider listings, dated source evidence, units/conditions, capability/limit distinctions, missing fields and one reproducible scenario. Avoid a thin copy of a vendor card or a catalog drawer.

**Publication gate:** stable entity identity, enough verified facts, a distinct useful explanation, review owner and a maintenance path. Select up to six candidates based on evidence completeness and relevance; no specific model is endorsed in this report.

**Acceptance:** useful initial HTML, one self-canonical, valid entity status, real internal anchors, truthful schema, explicit stale/unknown states and controlled aliases; unsupported IDs return 404; no automatic model/provider/use-case or pairwise permutations. CTA: comparison with a justified alternative, methodology and supported tracking setup.

### Brief 5: clarify subscriptions, API billing and credits

**Disposition:** strengthen current Plans/docs/pricing content first; separate buyer guide only if a maintained entitlement matrix warrants it. **Owner:** #19/#21; Track 1 and Track 5 dependencies.

**Intent:** understand app access, API consumption, credits, quota, renewal and expiry without conflating them.

**Required original value:** source-backed entitlement rows with observation/effective date, region/tier, eligibility and exclusions; a synthetic monthly scenario; explicit unknown/negotiated terms. Plan coverage must not be inferred from a model name or broad marketing claim.

**Acceptance:** each material entitlement has an authoritative source/date; export freshness does not overwrite plan-verification date; credits are distinguished from subscriptions and pay-as-you-go rates; no universal eligibility promise; no page per plan/region permutation. Use a single maintained explanation linked from Plans and the cost guide.

### Brief 6: document where usage data is stored and shared

**Disposition:** expand the existing docs privacy section; extract /docs/privacy-and-data-flow only if its field-level matrix justifies a reference page. **Owner:** #21/#22; Tracks 2/3/5/6 dependencies.

**Intent and original value:** show local versus hosted/public/private data flows, connector boundaries, consent, role access, retention, deletion and report revocation for the actual release.

**Evidence gate:** code plus behavior where a privacy promise depends on deployment. Current noindex source is not proof of tenant isolation, encryption or compliance. Avoid broad “nothing ever leaves the device” claims when publication is explicitly supported.

**Acceptance:** every product-specific claim points to the relevant contract; synthetic actors only; no private URLs, prompts, session titles or usage records; public publication and search discoverability are separate choices; documented retention distinguishes defaults from proposed policy. CTA: supported setup and existing privacy controls, with no settings changed by the guide itself.

### Brief 7: one supported integration quickstart

**Disposition:** refactor a task from current docs, keeping a central index; do not publish one page per logo. **Owner:** #21/#22.

**Title proposal:** “Track a supported coding tool with Token Horizon.”

**Required contents:** exact OS/build/tool prerequisites; minimal supported setup; first successful collection check; what is counted; known unsupported data; local/hosted boundary; troubleshooting; uninstall/revoke path. Hosted MCP and local stdio/engine instructions must not be mixed.

**Acceptance:** examples map to actual contracts and contain no credential literals; an unexecuted setup is labelled untested until a separate isolated run verifies it; expected output is synthetic; first tracked activity is distinguished from a successful download. Link from the relevant catalog or methodology decision, not a generic sitewide keyword footer.

### Brief 8: maintain comparison methodology

**Disposition:** consolidate existing pricing evidence into one evergreen method if needed; preserve the dated engineering case study. **Owner:** #19, linked to #20.

**Intent:** let users judge whether a comparison fits their workload before trusting a discount or ordering.

**Required contents:** model/provider identity and aliases; source precedence; input-rate ordering versus total workload cost; paired output rates; cache/tier/region assumptions; direct versus reseller listings; benchmark approximation and uncertainty; missing/stale data; correction workflow.

**Acceptance:** one synthetic comparison can be reproduced; published figures, estimates and measured results are visibly distinct; no “best” or quality-equivalence claim from cost alone; the calculation is linked rather than duplicated from Brief 1; existing pages use descriptive links to the maintained methodology.

### Recommended first content batch

Prepare **one cost guide with a caching section, one context guide, and three revisions**: pricing/comparison methodology, privacy/data flow and one supported integration quickstart. Follow with the small model-page pilot only after its data/rendering gates. This is a proposal to refine the prior strategy already preserved in #18, not a new authority to publish. [I18]

## 9. Original page proposal: evidence before the CTA

**PROPOSAL - not implemented UI. All model names, rates and examples below are synthetic.**

A model-detail page should answer a decision in readable HTML before offering complex interaction. It can inherit the current mineral-green/cream visual language while making evidence and unknowns more prominent.

| Region | Proposed content and behavior |
|---|---|
| Identity | Breadcrumb links, exact model/provider identifiers, supported availability and a short scope statement |
| Evidence summary | Publication/verification state; separate export date and fact-verification date; source links adjacent to claims |
| Comparable facts | Input/output/cache units, context/output limits and conditions; unknown remains visibly unknown |
| Worked scenario | Synthetic workload with reproducible arithmetic and exclusions; no prompt upload required |
| Method and limitations | Ranking dimension, vendor versus independent evidence, approximate benchmarks and availability caveats |
| Next step | Public comparison, methodology and supported setup links; no account requirement to read the evidence |

Synthetic example: 1,000,000 uncached input tokens at USD 2 per million plus 250,000 output tokens at USD 8 per million gives an estimated USD 4 provider charge. Cache rate is unknown and not used. Tool/storage/tax/discount effects are excluded. These fictional rates demonstrate the layout and arithmetic only.

The companion vector wireframe in the evidence bundle and PDF illustrates this hierarchy. It is not a screenshot, a real product rate card or proof of implementation. Track 2 owns visual refinement; Track 6 owns calculation semantics; Track 4 owns crawlable content, URL identity and evidence placement.

## 10. Validation specification and release gates

All tests below are proposed except the explicitly executed checks in section 2.

| Gate | Passing evidence required | Existing owner |
|---|---|---|
| Canonical terminal URLs | GET/HEAD and final HTML agree; terminal 200; aliases follow documented policy; canonical/schema/links/sitemap aligned | #46/#20 |
| Initial public content | H1, main explanation, selected facts, dates/unknowns and descriptive anchors remain without JS/API | #18 |
| Hydration parity | Same meaning and canonical/robots/schema after load, tab change, history navigation and error fallback | #20/#23 |
| Sitemap | XML parses; only allowed canonical public documents; no personal/share/auth URLs; lastmod reflects meaningful change if used | #20/#23 |
| Data lineage | Source/generator/artifact/deployed digest and visible snapshot are traceable; plan/price dates independent | #41/#19 |
| Structured data | JSON syntax plus truthful visible-content parity and relevant current feature requirements | #23 |
| Privacy | Synthetic anonymous/owner/member/admin/other-tenant tests; no unauthorized data in HTML/API/schema/OG/cache | #23 with Tracks 2/5 |
| Accessibility | Keyboard, focus, reflow, names, contrast, reduced motion, dialogs and table/chart alternatives; WCAG 2.2 AA target | #23 |
| Lab performance | Repeatable route/device/network baseline and asset/interaction diagnosis; no relabelling as field data | #23/#44 |
| Field performance | Authorized real-user dataset with population/date/percentile/device context; unknown if absent | #23 |
| Content | Primary evidence, reproducible example, distinct intent, reviewer, update trigger and no unsupported shipped claims | #19/#21 |
| Search outcomes | Authorized property evidence for actual indexing and impressions; no guarantees from headers/tests | #23 |

A sitemap should list preferred canonical pages. Its lastmod, if added, should reflect a material content change rather than every build. Crawlable links should be real href anchors with useful context, including the proposed model page and methodology relationships. [P05][P06]

Structured-data syntax is not rich-result eligibility. Existing homepage SoftwareApplication metadata has useful semantics, but this report does not claim eligibility: Google's current software-app feature requires truthful offer and rating/review evidence in addition to an app name. Do not fabricate reviews or a zero price. Google removed FAQ rich-result display from 7 May 2026; useful FAQ prose may remain, but FAQ-rich-result uplift is not a valid objective. [P07][P08]

### Proposed synthetic negative cases

Use two fictional tenants and explicit roles in an isolated test environment. A member of Tenant A must not obtain Tenant B records by changing an ID, navigating a cached report, requesting a social image or calling the underlying API. An expired/revoked report returns safe content; page, metadata and image caches do not retain sensitive fields. Private query identifiers never appear in analytics, canonical tags, sitemaps or llms files.

These are acceptance requirements, not claims of current vulnerabilities. Existing noindex/source tests cover only part of this matrix.

## 11. Privacy, consent, retention and measurement design

The public publishing pipeline should accept only product documentation, approved public model/provider facts and synthetic/anonymized illustrations. It must not import personal usage records, raw prompts, trace bodies, session titles, user emails, credentials, tenant identifiers or bearer-share values. Avoid assuming pseudonymous user IDs are anonymous.

Separate three permissions: access to data inside an account/tenant, publication to a chosen audience, and discoverability in public search. A public-link report is still not a search publication decision. Preserve the current noindex treatment for all report links. Any future public profile/team search publication should be explicit, reversible, field-limited and tested with revocation and cache invalidation.

Tenant authorization belongs on every data/API/media path. Robots rules, noindex, canonical tags and unguessable links are insufficient access control. SEO-generated HTML must not depend on a signed-in session or share a cache key with a personalized response.

Retention must be documented per data class and enforced by the owning product track. A proposed public acquisition event policy is aggregate-only, without raw query strings, prompt content, user handles or cross-device/private-usage joins. Aggregate at collection and do not persist raw events by default. Any proposed minimized event-level collection requires a separate reviewed field allowlist, purpose, consent/RBAC model and deletion deadline. A maximum 30-day window is only a planning option for that separate design, not current policy. Delete purpose-limited data on schedule and restrict access by role.

PR #25 is **open, draft and unmerged** at 71312217bdf3f3a7d28a3b86fea78e42b5f9ecb1. Its inspected proposal is default-disabled, explicit-opt-in, canonical-homepage-only GA4, excluding query/hash URLs and respecting DNT/GPC. It does not establish current analytics deployment, a public catalog funnel or any traffic baseline. PR #24 is closed/unmerged and superseded. Any broader event scope requires its own reviewed contract; this SEO report does not authorize activating either. [PR25][PR24]

### Measurement once authorized evidence is available

Start with available first-party aggregate exports rather than inventing a baseline. Record source, property, date window, timezone, filters, device and data completeness. Measure eligible canonical pages, observed index status, impressions/clicks and query-to-page intent; distinguish new-page discovery from mature-page changes. Compare like-for-like windows and document releases/confounders before interpreting effects.

A future catalog-to-install measurement should count meaningful public decisions and supported next-step selection. It must not imply installation or first valid usage from a download click. Avoid hidden identity linkage into private usage analytics. Track 5 owns any legitimate activation measurement and consent/RBAC model.

This study has no Search Console/GA4/Bing property baseline and makes no SEO ROI or conversion-uplift forecast.

## 12. AI-search discoverability

The practical work is readable public content, accurate entity identity, source evidence, stable URLs and clear distinctions between public data and authorized tools. The current llms file can remain a maintained interoperability aid, but it should point at final public documentation and explain hosted/local boundaries under #22.

Google's current guidance says normal SEO foundations remain relevant, does not require special AI schema, and says llms.txt does not affect Search visibility. Do not make an “AI SEO score,” tiny text chunks or mass-produced question pages the objective. [P11]

Current Google documentation describes a Search generative AI inclusion control and a dedicated impressions report, rolled out worldwide from 31 August 2026. Token Horizon's control value, inheritance, eligibility, report presence and impressions are unknown. Nothing was changed. These are future read-only measurement possibilities, not a reason to reconnect during this task. [P12][P13]

OpenAI documents separate roles for OAI-SearchBot (search), GPTBot (training-related crawl) and ChatGPT-User (user-initiated retrieval). Search discoverability does not imply training consent. Any intended bot policy should be explicit and checked by a maintainer without weakening general protections; this report makes no claim that those bots successfully crawled Token Horizon. [P14]

For content, prioritize source-attributed facts, defined units, date/conditions, reproducible examples and correction history. These help readers and retrieval systems understand the claim; they do not guarantee citation. Avoid publishing every model/use-case/comparison permutation. Google's scaled-content policy concerns large amounts of low-value material made primarily to manipulate rankings, regardless of generation method. [P15]

## 13. Deduplication and cross-track ownership

### Existing items to reuse

| Existing item | Observed state | Disposition in this study |
|---|---|---|
| #18 catalog rendering/access | Open; updated 18 November | Extend with two browser observations, client-specific denial and public HTML proposal |
| #19 pricing evidence/freshness | Open; updated 18 November | Add field-level evidence, scoped comparison semantics and content acceptance |
| #20 parameter indexation | Open; updated 17 November | Add route registry, teams sitemap fix and remaining rendered comparison |
| #21 supported activation | Open; updated 17 November | Refine task guides and truthful public next steps |
| #22 llms/MCP policy | Open; updated 17 November | Clarify documentation versus invocation and hosted versus local |
| #23 validation | Open; updated 18 November | Preserve partial coverage; add real asset/privacy/rendered gates |
| #46 article URL consistency | Open; updated 18 November | Exact existing owner; no duplicate canonical ticket |
| #41 publication lineage | Open; updated 17 November | Strengthened by source/visible-snapshot discrepancy |
| #26 local/CI command manifest | Open; updated 18 November | Integrate new gates without dropping current CI checks |
| #44 view-switch CI budget | Open; updated 17 November | Coordinate measured performance work; do not call it field CWV |

The issue inventory returned **31 open issues and 0 closed issues**, with up to 100 requested per status search. PR search returned **14**: two open drafts, one closed/unmerged draft and eleven merged. No independent total, cursor or truncation flag was exposed, so these are bounded returned counts, not proven exhaustive repository history.

Full relevant issue bodies were read for #12-#16, #18-#23, #26, #41, #44 and #46; comments were read for #18, #19 and #23. Full PRs #25 and #17 were inspected. #24's full fetch failed, but its closed/unmerged/superseded state was available in the PR inventory. PR #17's merged benchmark work does not establish the current deployed revision. [I12][I18][I19][I20][I21][I22][I23][I26][I41][I44][I46][PR17]

### Cross-track contracts

| Track | Dependency supplied to SEO | SEO boundary |
|---|---|---|
| 1. Market/opportunities | Audience, real task demand, positioning and evidence-backed differentiation | No market size, traffic or keyword-volume claims invented here |
| 2. UI/team management | Navigation, shared metadata contract, accessibility, roles/public-versus-private team surfaces | Wireframe is a proposal; no team UI implementation claim |
| 3. Knowledge graph | Stable model/provider identity, public provenance relationships and any memory claims | No private knowledge graph rendered for acquisition |
| 5. Team/individual analytics | Tenant/RBAC, consent, retention and legitimate activation evidence | No personal usage records or employee analytics in public SEO |
| 6. Token/context analytics | Billable buckets, estimates versus counters, cache/context semantics and model limits | Content cannot outrun the accounting/instrumentation contract |

Roadmap issues #12-#16 contain proposed routing, handoff, local lifecycle and analytics work. They are not evidence that those features are delivered. Public content should use a claim matrix linking every capability to source/release/live evidence or explicitly label it proposed.

## 14. Source register and reproducibility

### Repository evidence

All S-references use the immutable b468206e9378c8d7a6788b67072494982e7de17d revision. The evidence bundle includes the selected-source manifest and redacted measurement records; it does not include credentials, personal usage records, raw challenge bodies or private account responses.

- **S01:** commit metadata; branch/head was independently rechecked during preparation.
- **S02:** README, authoritative origin and product/connector boundaries.
- **S03:** cloudflare/wrangler.toml, route/ASSETS architecture.
- **S04:** cloudflare/src/page-metadata.js, source metadata/private policy.
- **S05:** docs/leaderboard.html, empty mount at line 696; catalog fetch at 3874-3916; snapshot at 4277-4280; comparison calculation at 4683-4707.
- **S06-S08:** sitemap, robots and llms documents.
- **S09-S10:** Swift export contract and generated catalog; catalog Git blob 1e89f78729b8770d5c633fcf8a6c9f491a3d7132.
- **S11-S12:** scheduled export and site Worker routing/cache/private responses.
- **S13-S14:** executed metadata and static SEO tests.
- **S15-S19:** homepage, docs, blog index and two article sources.
- **S20:** CI invocation evidence.
- **K01:** existing draft portfolio-seo-audit skill, exact revision 0b456a340126e868559e0ce750ba7a2ccf855510.

A future maintainer should rerun the existing local tests on the actual repair branch, add the specific missing regression, and then run the permitted deployment/route check under separate authorization. This study's stopped HTTP collection should not be resumed automatically. A browser render, a source test and Google-selected canonical/index state remain separate checks.

### Primary-source guidance used

All were retrieved on 18 November 2026. Dates below are documentation dates when observed; an absent date is not invented.

| Reference | Authority and topic | Date/context |
|---|---|---|
| P01 | Google JavaScript SEO basics | Updated 4 March 2026 in retrieved documentation |
| P02 | Google canonicalization | Updated 10 July 2026 |
| P03 | Google noindex | Current official document; property behavior not inspected |
| P04 | Cloudflare error 1010 | Updated 24 October 2026 |
| P05 | Google sitemap guidance | Updated 8 July 2026 |
| P06 | Google crawlable links | Official guidance; no specific update date asserted |
| P07 | Google SoftwareApplication rich results | Updated 8 September 2026 |
| P08 | Google documentation updates | FAQ removal effective 7 May 2026 |
| P09 | web.dev Core Web Vitals | Updated 31 October 2024; used for targets, not site metrics |
| P10 | W3C WCAG 2.2 | Normative accessibility reference; no conformance claim |
| P11 | Google generative AI optimization | Updated 10 July 2026 |
| P12-P13 | Search Console AI control/report | Worldwide rollout note 31 August 2026 |
| P14 | OpenAI crawler documentation | Official current page; no update date asserted |
| P15 | Google spam policies | Updated 28 August 2026 in retrieved documentation |
| P16 | Claude pricing | Official rate-category reference; no exact update date asserted |
| P17 | Claude context windows | Official accounting reference; no exact update date asserted |
| P18 | OpenAI ChatGPT/API billing | Current official billing/credit distinction; no inferred absolute update date |

### Deliverable status

This report, its wireframe and backlog refinements are complete research artifacts. The source tests and bounded observations are complete within their stated scope. All implementation proposals, broader accessibility/performance checks, production fixes and search-outcome measurements remain unimplemented or untested. No shared project state was changed.

[S01]: https://github.com/castlemilk/token-horizon/commit/b468206e9378c8d7a6788b67072494982e7de17d
[S02]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/README.md
[S03]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/wrangler.toml
[S04]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/page-metadata.js
[S05]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html
[S06]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/sitemap.xml
[S07]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/robots.txt
[S08]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/llms.txt
[S09]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Catalog/ModelCatalogExport.swift
[S10]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/data/models.json
[S11]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/.github/workflows/models-refresh.yml
[S12]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js
[S13]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/page-metadata.test.mjs
[S14]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/test-site-seo.mjs
[S15]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/index.html
[S16]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/docs/index.html
[S17]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/blog/index.html
[S18]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/blog/pricing-evidence.html
[S19]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/blog/why-token-horizon.html
[S20]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/.github/workflows/ci.yml
[K01]: https://github.com/skunkworq/skunkworq-skills/blob/0b456a340126e868559e0ce750ba7a2ccf855510/portfolio-seo-audit/SKILL.md
[I12]: https://github.com/castlemilk/token-horizon/issues/12
[I18]: https://github.com/castlemilk/token-horizon/issues/18
[I19]: https://github.com/castlemilk/token-horizon/issues/19
[I20]: https://github.com/castlemilk/token-horizon/issues/20
[I21]: https://github.com/castlemilk/token-horizon/issues/21
[I22]: https://github.com/castlemilk/token-horizon/issues/22
[I23]: https://github.com/castlemilk/token-horizon/issues/23
[I26]: https://github.com/castlemilk/token-horizon/issues/26
[I41]: https://github.com/castlemilk/token-horizon/issues/41
[I44]: https://github.com/castlemilk/token-horizon/issues/44
[I46]: https://github.com/castlemilk/token-horizon/issues/46
[PR17]: https://github.com/castlemilk/token-horizon/pull/17
[PR24]: https://github.com/castlemilk/token-horizon/pull/24
[PR25]: https://github.com/castlemilk/token-horizon/pull/25
[P01]: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
[P02]: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
[P03]: https://developers.google.com/search/docs/crawling-indexing/block-indexing
[P04]: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/
[P05]: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
[P06]: https://developers.google.com/search/docs/crawling-indexing/links-crawlable
[P07]: https://developers.google.com/search/docs/appearance/structured-data/software-app
[P08]: https://developers.google.com/search/updates
[P09]: https://web.dev/articles/vitals
[P10]: https://www.w3.org/TR/WCAG22/
[P11]: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
[P12]: https://support.google.com/webmasters/answer/16908024
[P13]: https://support.google.com/webmasters/answer/16984139
[P14]: https://developers.openai.com/api/docs/bots
[P15]: https://developers.google.com/search/docs/essentials/spam-policies


[P16]: https://platform.claude.com/docs/en/about-claude/pricing
[P17]: https://platform.claude.com/docs/en/build-with-claude/context-windows
[P18]: https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform
