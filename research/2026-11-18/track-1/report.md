# Token Horizon: market research and opportunity specification

**Track 1 · 18 November 2026 · Australia/Melbourne**  
**Status:** completed read-only investigation; all opportunity designs, commercial offers and experiments below are proposed and untested.  
**Repository baseline:** `castlemilk/token-horizon`, `main`, `b468206e9378c8d7a6788b67072494982e7de17d`.  
**Scope:** positioning, competitors, buyers, differentiation, distribution, business model and falsifiable commercial experiments. UI, team administration, knowledge graph, SEO implementation and detailed analytics contracts remain with the other five tracks.

## 1. Recommendation

**Keep the existing Claude Code/Codex daily workflow as the product foundation, and test a much narrower commercial outcome: an understandable, evidence-backed explanation of AI spending and plan availability that leads to a useful budget or renewal decision.** The most promising initial payer hypothesis is a technical founder or engineering lead who personally manages multiple paid AI relationships. Start with a private local review and manually verifiable plan/billing records. A corporate reporting backend is a later dependency, not a prerequisite for finding out whether the job matters.

The proposed offer is:

> Understand what you paid, what usage was observed, what that usage would cost at published rates, what remains unknown, and what decision you can reasonably make next.

This is an original positioning proposal, not current product copy or a proven competitive advantage. The investigation found no evidence sufficient to call this a validated business. It did find substantial existing product machinery, a relevant prior research backlog, and a crowded market that makes a broad “all your AI usage in one dashboard” proposition difficult to defend.

Three decisions follow:

1. **Treat trust and interpretation as the first product test.** Distinguish cash payments, fixed commitments, credit consumption, API-equivalent estimates, allocation and incomplete coverage. Test whether people understand and use that distinction, rather than assuming more accurate-looking numbers will sell.
2. **Compare against actual substitutes before expanding.** Free local tools already cover tokens and quotas; paid products already cover team and client attribution. Require a buyer to name a consequential task that their present tools do not adequately finish.
3. **Update existing issue #12 and its THR items.** The core recommendation is an evidence-driven refinement of the 11 November roadmap. It is not a new parallel roadmap, and this report creates no GitHub issues or PRs. [[R12], [P03]]

### What changed relative to the earlier study

The prior market page and issue #12 already proposed trustworthy spending, a daily two-harness view, personal US$12/month and workspace US$49/US$99 hypotheses, plus agency attribution as an alternative. Those remain untested. This pass adds closer direct competitors, current buyer-owned evidence, a release/source/publication separation, and stricter substitute and accounting gates. It downgrades generic private analytics and client invoicing as differentiators. [[R12], [P03]]

**Decision confidence:** high that the broad category is competitive; medium that the current code is a useful starting point for a narrow prototype; low that any proposed segment will pay sustainably. No revenue, retention, active-user or conversion baseline was established.

## 2. Evidence method and boundaries

### Evidence labels used throughout

| Label | Meaning in this report |
| --- | --- |
| **Public-current** | A public page or connected read returned the stated content on 18 November 2026. Marketing claims remain vendor claims. |
| **Released** | A release record and its named assets were observed. Installation and runtime behavior were not verified. |
| **Source-only** | Code or documentation exists at the pinned repository commit. This does not establish deployment. |
| **Measured** | A narrow observation made during this study, such as returned catalog metadata or inventory counts. It is not a product benchmark or customer outcome. |
| **Prior proposal** | An earlier issue, PR or project document describes intended work or a learning target. |
| **Inferred** | Reasoning from the evidence, with uncertainty retained. |
| **Proposed** | A new/refined design, experiment, acceptance criterion or planning estimate. Not implemented or tested here. |

All public competitor and research sources were retrieved on **18 November 2026**. Explicit publication dates are recorded where present; otherwise the source is an undated current page. A freshly retrieved page is not necessarily a newly published event. Advertised pricing establishes an offer, not sales, willingness to pay or implementation quality.

The investigation used authorized read-only GitHub and Token Horizon catalog reads, public primary sources, and read-only access to the existing Token Horizon project pages. Repository source and the complete available issue/PR collection were inspected. Relevant comments and PR histories were reviewed where they changed deduplication or release interpretation. No Token Horizon or competitor source code was executed, no installer was run, and no paid inference or commercial service was used.

No shared repository, issue, PR, deployment, Page, account permission or service setting was changed. No external messages, customer interviews, offers or payments were sent or arranged. This document is the isolated deliverable. It contains synthetic examples only; it does not contain private prompts, personal usage records, credentials or customer identities.

### Important access and measurement gaps

| Gap | What was available | Consequence |
| --- | --- | --- |
| Installed product | Current source, public documentation and release metadata | No claim that current source features are in a user's installed binary or that setup succeeds. |
| Production revision | Public pages and hosted catalog response; no authoritative deployment receipt | Public content cannot be assigned the pinned Git SHA. |
| Dynamic web behavior | Text/HTML retrieval of homepage, docs, models and teams | No rendered-browser acceptance, accessibility or performance measurement. Models/teams retrieval exposed a limited shell. |
| `/connect` and `/api/health` | Public retrieval failed through the research service | Exact access gap only; not evidence the product is down. Public catalog read succeeded separately. |
| Private usage and customer economics | Intentionally not requested | No user totals, subscriber counts, retention, revenue, CAC or cost-to-serve measurement. |
| Windows/Linux distribution | Source and packaging contracts; latest and ten recent release entries | No Windows/Linux package was observed in those release assets; other review artifacts or channels are not ruled out. |
| Competitor execution | Official pages/documentation only | No independent security audit, installed feature test or billing reconciliation. |
| Customer demand | Surveys, buyer-owned engineering reports, vendor offers and prior hypotheses | No direct Token Horizon interview, purchase or renewal evidence. |

## 3. Actual Token Horizon baseline

### 3.1 Source, release and public product are different evidence objects

The default branch was `main`, pinned at **`b468206e9378c8d7a6788b67072494982e7de17d`**, committed **18 November 2026 at 07:35:19 UTC / 18:35:19 AEDT**, message `catalog: refresh model list (2026-11-18)`. The README identifies **https://token-horizon.dev/** as the public product. [[R01], [R02]]

The latest published release returned by GitHub was **v0.5.2**, published **28 October 2026 at 07:33:44 UTC / 18:33:44 AEDT**, resolving to **`4ebad0b69c3113509f974438e46238631d52d77c`**. Its assets were a macOS DMG, ZIP, checksums and product film. That is evidence of published artifacts, not a runtime verification of notarization or current-main functionality. [[R03]]

The public homepage advertises desktop usage, costs, plan limits, local inference, optional sharing, and model comparison. It labels its tour and community preview as illustrative. The public documentation distinguishes macOS native surfaces from the portable Windows/Linux dashboard. No own paid tariff or working checkout was established on the inspected surfaces. [[P01], [P02]]

### 3.2 Capability and architecture map

| Capability | Current evidence | Commercial implication |
| --- | --- | --- |
| Native macOS notch, menu bar, dashboard and widgets | README and native source; older macOS release assets exist | A useful habitual entry point. It does not by itself distinguish the product from free menu-bar alternatives. |
| Local usage parsing across coding tools | `UsageEngine.swift`, `Usage/Models.swift`; Claude/Codex and other sources described | Reuse this for a bounded two-tool pilot. Do not build a new ingestion platform before demand is established. |
| Costs and plans | Token-based cost paths and curated `ModelPlanIndex.swift` | These describe usage value/eligibility. They are not a ledger of payments or proof of purchased entitlement. |
| Local Go gateway | `gateway/config.go`, `proxy.go`, `trace.go`, `store.go` | Provider-reported usage, timing, capture mode and coverage can support evidence. Off-path/native/cloud traffic is not automatically covered. |
| Cloud snapshots | `docs/sync-consistency.md`, `cloudflare/src/usage-history.js` | Existing original timestamps, replacement/idempotency and correction rules are valuable foundations; preserve them. |
| Teams and hosted Workspace | `PRODUCT.md`, `team-invites.js`, cloud source | Current web analysis concerns voluntarily published profiles. Account membership and publication are separate. This is not demonstrated private corporate finance tenancy. |
| Hosted MCP | `cloudflare/CONNECTOR.md`, `connector.js`; successful public catalog read | A real discovery channel and agent-readable catalog. Hosted access cannot inspect local traces or unpublished usage. |
| Windows/Linux app | `clients/app/README.md`, Electron/Go packaging contracts | Source-present. A public cross-platform promise must be reconciled with released-package evidence before acquisition experiments. |
| Knowledge/handoff/routing expansion | Issues #14–16 and #12 | Proposed follow-on work. It should not be bundled into the first commercial proof. |

Sources: [[R01], [R04], [R05], [R06], [R07], [R08], [R09], [R10], [R11], [R13], [R14], [R15], [R16], [R28], [R29], [R30], [R31]]. These are source findings, not an end-to-end acceptance result.

### 3.3 Trust gaps that matter to positioning

**Catalog freshness has two separate clocks.** The hosted public model search returned `catalog_total=2074` and `generated_at=1793821960`, which is **4 November 2026, 19:52:40 UTC / 5 November, 06:52:40 AEDT**. At the pinned commit, `docs/data/models.json` has `generatedAt=1794987318`, **18 November, 07:35:18 UTC**, `count=2186`, and 2,186 model rows. It also has a separate `catalogCount=10340`; that field must not be presented as 10,340 verified models. Count definitions are not assumed identical across interfaces. The timestamps establish a publication/freshness discrepancy in the inspected paths, without proving the cause. [[M01], [R17]]

The same source export labels its 13-plan artifact `plansUpdatedAt=2026-09-15`. Regenerating a catalog does not prove individual offers were reverified. Existing **#41** owns publication lineage and **#19** owns pricing provenance/freshness. The correct market promise is dated, inspectable evidence, not an unsupported claim of universally live prices. [[R17], [R18], [R19]]

**Cost interpretation requires an audit before selling financial accuracy.** `UsageEngine.swift` uses an explicit cost when available and otherwise calls `estimateTokenCost`. That function contains family-specific tariff assumptions, a catalog fallback and a zero return when pricing remains unresolved after requesting refresh. This is a source-level risk for distinguishing unknown cost from zero cost; it is not an observed incorrect customer invoice. A historical article's “No estimates” wording is inconsistent with that implementation. Merged PR #5 already improves cost provenance in MCP; acceptance should extend across surfaces under existing items. [[R05], [R20], [R21]]

**Privacy documentation also differs from implementation.** The root README describes full local bodies. The pinned gateway code defaults to metadata capture and retains bodies only when `TOKEN_HORIZON_CAPTURE_BODIES` equals `"1"`; metadata mode removes raw error text. Switching capture off does not establish deletion of previously stored content. This is a documentation inconsistency, not evidence of a leak, and the installed release's configuration was not inspected. [[R01], [R07], [R08], [R28], [R30]]

**Public teams are not a private financial workspace.** `PRODUCT.md` expressly limits hosted Workspace to published snapshots and says usage volume is activity, not productivity. Existing crew owner/member checks and account ownership are useful, but do not demonstrate finance roles, client-restricted access, private cost allocation or full enterprise administration. [[R04], [R10]]

## 4. Existing research and backlog reconciliation

The existing **Token Horizon** project root and **Market landscape and commercial options** page were read. The market page was created and updated on 11 November 2026. Its daily work/spending thesis, free-tool warnings, US$12 and US$49/US$99 pricing hypotheses, and agency alternative are preserved here as prior proposals. No results proving those experiments ran were found. [[P03], [P04], [R12]]

The repository issue collection returned **46 records** with an empty second page: **31 standalone issues, all open; 15 PRs, of which 2 were open and 13 closed**. Twelve closed PRs were merged. **PR #24 was closed unmerged** and replaced by open **PR #25**. There were no closed standalone issues to cite. Closed and merged records were inspected rather than treating closure as evidence of a feature being live. [[R22]]

| Existing item | Current state | Relevance to this study |
| --- | --- | --- |
| #12, THR-01–32 | Open research-preservation issue | Parent for buyer discovery, money semantics, reconciliation, two-tool pilot, offers and cost to serve. |
| #13 | Open, proposed truthful observability | Coverage, request/attempt identity and display provenance are dependencies. |
| #14 | Open, proposed routing simulation | Keep simulated choices visibly separate from routing/enforcement; defer until a decision need is proven. |
| #15 | Open, proposed read-only local inventory | Supports eventual local/cloud comparisons; not required for first spending test. |
| #16 | Open, proposed reviewed handoff/plans | Plan inventory may support the wedge; broad continuity belongs to the relevant track. |
| #18, #19 | Open SEO rendering and pricing-evidence issues | Acquisition must rely on inspectable, current evidence. |
| #21, #23 | Open activation and validation issues | Own catalog-to-supported-install and measurement acceptance. |
| #41 | Open publication-lineage issue | Source refresh cannot be sold as deployed freshness without proof. |
| PR #5 | Closed, merged | Prior cost-provenance work exists; extend, do not recreate it. |
| PR #4 | Closed, merged | Metadata-trace/MCP source work; its description does not claim deployment. |
| PR #24 → #25 | Closed unmerged → open | Proposed default-disabled homepage opt-in analytics. No established conversion funnel. |

Relevant current comments were considered: #19 already addresses local total operating cost versus zero provider charge; #23 says an older `/models` 403 was not reproduced on 18 November, while rendered acceptance remains open. This report does not revive that old access failure as a current product defect. The 17 November SEO material preserved under #18 already observed the older hosted catalog snapshot. [[R23], [R24], [R25]]

## 5. Competitive landscape

### 5.1 Closest substitutes

All rows describe inspected primary offers or documentation, not independently tested competitor implementations. Prices are recorded as displayed on **18 November 2026**. Currency is explicit only where the source establishes it. Different billing units are not directly comparable.

| Alternative | Job already covered | Advertised commercial basis | Implication |
| --- | --- | --- | --- |
| **ccusage** | Local multi-agent usage, daily/session views, token/cache estimates and JSON export; documentation distinguishes estimates from billing | Open-source local CLI; no subscription requirement found in the inspected guide | Basic multi-tool local visibility is a strong free substitute. [[C01]] |
| **Tokscale** | Local terminal tracker with optional public submission and community/model discovery | Open-source tracker; no paid tracker offer established | Optional publication and multi-agent tracking are already combined elsewhere. [[C02]] |
| **CodexBar** | Menu-bar quota windows, resets, balances and source-dependent cost/billing views | Official site says free and open source | Even “which paid tool has capacity now?” needs differentiation beyond aggregation. [[C03]] |
| **Tallyhook** | Claude Code/Codex team/client grouping, invoice lines, CSV, budgets and report links | **US$49/workspace/month** up to 5 collectors; **US$149** up to 20, then **US$7** per additional collector. It labels costs API list-price equivalents | Direct competition to THR-30. Client attribution is not an empty market. [[C04]] |
| **LobsterOne** | macOS quota/spend views, personal analytics and private team views | Individual free; team **$4.90/seat/month**. Currency not explicit in inspected text | Privacy and affordable team dashboards are baseline competition. Its page limits Cursor capture to the Claude Code plugin. [[C05]] |
| **WakaTime** | Cross-tool AI adoption, estimated spending and engineering activity | Team **$21/developer/month**, or **$19.25 equivalent billed $231 yearly**; currency not explicit in inspected text | Developer distribution and team analytics already converge. [[C06], [C07]] |
| **DX** | Organizational coding-tool costs, tokens/credits, teams/contributors and output association | Requires Data Cloud plus supported sources; no reliable public amount established | Broad team/FinOps reporting is contested. Its docs explain several invoice-basis and coverage limitations. [[C08]] |
| **Provider-native dashboards** | Cursor team analytics/CSV, Claude organizational analytics, OpenAI usage/status and plan views | Bundled with eligible plans/roles; analytics/API access varies | Single-provider buyers may have little incremental need. Do not assume personal plans expose enterprise APIs. [[C09], [C10], [C11]] |
| **Spreadsheet plus receipts and exports** | Payments, renewals and allocations chosen by the buyer | Internal effort, no separate specialized subscription required | Must be included in interviews and time-to-answer comparisons. Cost is a hypothesis until measured. |

Tallyhook's security page says all members of a workspace can see all clients. That provides a specific access-boundary question for agency discovery, not proof agencies require another product. DX already documents meaningful source and pricing limitations; merely adding an “estimated” label is not a unique differentiator. [[C12], [C08]]

### 5.2 Adjacent alternatives set the expansion boundary

Langfuse's current offer combines tracing, evaluations and a gateway, with a free tier and Core advertised at $29/month including 100,000 platform units. Those units are not tokens. LiteLLM documents spending by keys/users/teams across provider APIs. OpenRouter couples model discovery to procurement, logs and spending controls. These products make a generic production-AI observability or gateway expansion a separate, demanding market. Integrate where useful; do not assume the existing local sidecar creates a reason for platform teams to switch. [[C13], [C14], [C15]]

The 11 November study also considered Helicone, Portkey, Braintrust, CloudZero, Artificial Analysis and evaluation/memory infrastructure. This pass prioritizes closer coding-workflow substitutes instead of repeating that whole adjacent matrix. Their prior prices are not silently carried forward as current facts. [[P03]]

### 5.3 Competition does not prove demand for Token Horizon

An advertised US$49 product shows a possible pricing reference, not its sales or profitability. An open-source repository shows an alternative and ecosystem activity, not how many people would buy an independent layer. No market share, conversion, paid-user estimate or TAM has been inferred from stars, leaderboard entries, downloads or model counts.

The question worth testing is narrower: **does a buyer repeatedly need a defensible spending/plan decision that remains awkward after trying a suitable free counter, a native dashboard or an existing paid reporting tool?** If the answer is no, the rational result is to retain a useful free/local product or pursue another validated job, not add breadth to justify a subscription.

## 6. Market signals: what is established and what is missing

| Primary evidence | Narrow conclusion supported | Limit |
| --- | --- | --- |
| **State of FinOps 2026** | AI cost visibility, allocation and value assessment are prominent practitioner concerns | 1,192 community respondents; 47% large enterprise, 33% enterprise and 20% SMB, where SMB means under 1,000 employees. This does not validate a 2–10-person buyer or a TAM. Avoid treating an ambiguously current/future “98%” headline as a clean adoption statistic. [[S01]] |
| **Stack Overflow 2026 AI survey** | Better output quality was reported as a switching reason more often than lower cost: 25.1% versus 6.4%; 33.7% reported no switch | Self-selected survey, varying denominators, not purchases or analytics demand. Methodology reports 30,903 valid responses, fielded 23 June–5 August. [[S02], [S03]] |
| **Uber engineering, 27 August 2026** | A buyer operates cross-tool cost analysis alongside workflow and quality considerations | Self-reported large-company implementation. It also demonstrates the internal-build substitute; its savings cannot be projected onto Token Horizon. [[S04]] |
| **incident.io engineering, 14 October 2026** | Cost reporting can remain coarser than a desired workflow breakdown: an agent run may combine implementation and QA | One implementation, not a general API guarantee or evidence of third-party purchasing. [[S05]] |
| **DORA, 2 June 2026** | Guidance supports measuring outcomes in context and cautions against rewarding raw token consumption | Guidance, not a new causal productivity estimate. [[S06]] |
| **METR, 24 February 2026** | Its later productivity experiment encountered selection and concurrent-agent time-measurement problems | Neither a universal AI slowdown nor a universal speedup can be inferred. [[S07]] |

**Commercial interpretation, inferred:** activity growth increases the number of possible spending decisions, but not necessarily willingness to buy a dashboard. Quality, interruption avoidance and explaining a budget may matter more than choosing the cheapest model. The best discovery prompt is therefore “show the last decision you could not confidently make,” not “would you like to save on tokens?”

There is no primary evidence here that Token Horizon has a reachable group of paying customers, an economic acquisition channel or permission to use customer data. Australian customer accessibility, procurement preference and local currency needs must be established in interviews. The market references are global; an Australian location is not itself a moat.

## 7. Buyer segments and jobs to be done

The segment sizes below are **proposed recruitment boundaries**, not discovered demographics or market counts.

| Segment | User, payer and trigger | Completed job to test | Present alternatives | Initial decision |
| --- | --- | --- | --- | --- |
| Technical founder/lead of a **2–10 developer** team with multiple paid AI relationships | Founder/lead uses and controls budget; renewal, unexpected bill or plan constraint triggers review | Explain payments and observed consumption, resolve or disclose discrepancies, record one plan/budget decision | Receipts/spreadsheet, native views, free local tools, Tallyhook/LobsterOne | **Primary commercial hypothesis**, starting with a single authorized local review |
| Independent developer with several subscriptions | Same person uses and pays; quota interruption or renewal | Know usable allowance and whether a plan change is justified | CodexBar, ccusage, native dashboards | Strong product-fit entry channel; payment confidence low |
| Small consultancy/agency with multiple client projects | Developer collects; owner/project lead allocates; client may need to accept charge basis | Produce a client-accepted allocation with explicit rules and no hidden unsupported costs | Tallyhook, spreadsheets, fixed-fee pricing | **Challenger under THR-30**, not automatic fallback |
| DevEx/platform/FinOps organization | Manager uses; procurement/finance/security approve | Org-wide governance, cost allocation, engineering context | DX, WakaTime, FinOps/BI tools, internal platforms | Defer until small-team value and administration are proven |
| Local-model practitioner | Individual/lab evaluates hardware and cloud choices | Reproduce a task at an acceptable cost/latency/quality level | Existing benchmarks, scripts, native tools | Watch; needs outcome evidence, not another token chart |

A qualified prospect must have a recent recurring incident, an actual workaround, an identifiable decision owner, permission for the minimal necessary metadata and a reason the existing substitute is inadequate. “Uses three tools” alone is too weak. A team using one provider with a satisfactory dashboard is a useful negative case, not a prospect to persuade into unnecessary complexity.

The proposed recruitment refinement changes the earlier “three AI tools weekly” criterion to **at least two distinct paid relationships plus a recent decision problem**, while recording actual tool count. This tests financial complexity rather than maximizing integration count. It is an explicit proposed change to THR-01, not a claim that the earlier criterion was implemented.

## 8. Ranked opportunity briefs

The ranking uses architecture fit, ability to test cheaply, buyer clarity and competitive pressure. These are ordinal judgments. There is no invented weighted market score.

### Rank 1 — A private AI plan and spending review

**Decision:** test. **Evidence confidence:** medium for the problem class, low for this segment's willingness to pay.

**Buyer/job.** A founder or engineering lead managing multiple paid AI accounts needs to answer a specific question before a renewal or budget discussion. The result is a reviewed explanation and a recorded decision, including “keep the current setup because the alternatives are not justified.” It should reduce uncertainty without forcing a provider change.

**Offer hypothesis.** Import or manually enter a small plan/payment inventory; combine it with consented local Claude Code/Codex observations; keep invoice facts and API-equivalent values separate; show source gaps and dated assumptions; produce a concise private review. An allowance/reset panel can support daily use, but the paid result must be more than that panel.

**Why this product can test it.** Local parsers, the model/plan index, trace metadata, history and native surfaces already exist in source. A bounded local prototype can use those plus manually verified records. No new general-purpose gateway, knowledge graph, autonomous agent or company-wide ingestion system is needed to test comprehension and recurring value. [[R05], [R06], [R07], [R08], [R09], [R11]]

**Differentiation hypothesis.** Decision clarity and reproducibility across financial bases, with a customer-controlled local workflow. This is not a feature monopoly; it must beat the customer's actual combination of free/native tools. An accurate explanation that does not alter a decision may be valuable, but its payment value must be measured rather than assumed.

**Planning estimate.** A focused local prototype: **5–10 engineering days after trust/semantics work**, plus discovery and review. This assumes one experienced contributor, two existing parsers, synthetic/manual records, no new synchronization backend and no release work. It is not a delivery commitment.

**Dependencies.** #12 THR-02–07 and THR-09–13; #13 for coverage; #19/#41 for catalog evidence. Track 6 supplies cost/usage semantics, Track 5 supplies useful decision/report measures, Track 2 supplies clear controls when the concept moves beyond a local single-user prototype.

**Main risks.** Free substitutes suffice; pain is monthly rather than daily; unsupported provider access; fragile price/plan data; confusion about credits; high support cost at a small monthly price. Do not promise hard caps on spending outside a controlled path.

**Pass/fail.** First pass a synthetic interpretation test. Then retain the existing 6/10 week-two-use target, requiring a named useful decision rather than passive views. Add a second renewal/close cycle. If usage is only occasional, test an episodic review product instead of assuming a subscription.

### Rank 2 — Client-accepted agency allocation

**Decision:** investigate as a challenger. **Evidence confidence:** medium that alternatives serve the job; low that an unmet paid gap exists.

**Buyer/job.** An agency owner needs an allocation accepted by the client or internal project owner. The output must say whether a line is actual expenditure passed through, a contractually agreed equivalent charge, allocated overhead or a fixed fee. Those are different commercial policies.

**Offer hypothesis.** A reviewed report that reconciles to a stated underlying basis, separates subscription allocation from metered charges, retains exceptions and allows client-scoped exports. Initial evaluation can be a synthetic/private document workflow. It does not require immediately building a billing platform.

**Competitive test.** Tallyhook already has a direct offer. Show that alternative openly. Ask whether the buyer needs actual payment reconciliation, historical price evidence, a different access boundary or another specific result enough to switch. Do not claim that API-equivalent charges are automatically billable to a client. [[C04], [C12]]

**Architecture fit.** Project observations can be an input; current public team totals cannot become unique private costs by summing them. A real shared product needs tenant-scoped allocation records, roles, invitation revocation and a reviewed export contract. [[R04], [R10], [R12]]

**Planning estimate.** **3–5 research/delivery days** to prepare and evaluate a bounded manual/synthetic reporting pilot. A production tenancy/billing estimate is deliberately withheld until Track 2 and Track 5 define requirements. Do not confuse a small report prototype with a small finance platform.

**Dependencies.** #12 THR-08, THR-30–32; money semantics and coverage from Rank 1; Track 2 RBAC/client isolation; Track 5 allocation; Track 6 observation identity.

**Main risks.** Fixed-fee agency contracts make token allocation irrelevant; clients reject the basis; attribution remains too coarse; support/reconciliation consumes the margin; existing tools finish the job.

**Pass/fail.** Preserve the existing five-team/two-paid-pilot goal in THR-30, adding client acceptance and a second reporting cycle. Stop if no specific unresolved job survives comparison with Tallyhook or a spreadsheet, or if no acceptable allocation is possible without content collection the buyer will not permit.

### Rank 3 — Evidence-rich catalog decisions that activate the local product

**Decision:** test as distribution, not a separate validated business. **Evidence confidence:** high that catalog/MCP surfaces exist, low that traffic converts into retained users.

**Buyer/job.** Someone deciding between specific model/provider/plan options needs conditions, dates and a supported next step. The completed result is a correct choice or an informed decision that evidence is insufficient, followed by useful tracking if relevant.

**Offer hypothesis.** Maintain a small set of high-quality decision pages and machine-readable evidence records around demonstrated user questions. Show exact model/provider identity, price basis, effective/review dates, cache and plan conditions, and OS/support prerequisites. Connect to an explicit local tracking task rather than a generic signup.

**Why now.** The current source/hosted discrepancy is a practical demonstration that publication provenance matters to trust. It is not evidence that buyers will pay for a catalog. OpenRouter and the free trackers already combine discovery with other workflows. [[M01], [R17], [R18], [R19], [C02], [C15]]

**Planning estimate.** **2–4 content/product days** for three narrow decision pages and a synthetic comprehension protocol, after evidence freshness and rendering gates. SEO engineering and analytics activation are separate work owned by their existing issues.

**Dependencies.** #19, #21, #23, #41; Track 4 owns implementation and indexing. Public MCP is an available distribution interface; it should preserve citation/freshness/unknown states rather than convert a catalog guess into confident advice.

**Main risks.** Many low-intent visitors, stale data, catalog maintenance cost, incumbents with direct procurement, model/version churn and unverified data reuse rights.

**Pass/fail.** A small prospective study should measure correct interpretation, completion of the specific supported setup, and later use. It must not equate a download click with installation or a model-page visit with a decision. No existing traffic or conversion baseline is asserted.

### Directions to defer

Broad enterprise FinOps, employee productivity scoring, a generic LLM observability platform, autonomous routing, large-scale memory infrastructure, a new evaluation runner and a social-network expansion all add buyers, risks and dependencies. They do not strengthen the first proof automatically. Existing local-model and community capabilities may remain useful, but commercial expansion should be pulled by observed decisions and repeated paid use. Context/handoff work remains a bounded Track 3 dependency under #16, not a new project in this market study.

## 9. Original proposal: the decision record

**This is a low-fidelity information proposal, not implemented UI. All values below are synthetic USD examples.** It is intended to test the job before Track 2 designs a production screen.

### Reviewed AI spending — example month

| Question | Proposed display | Evidence and limitation |
| --- | --- | --- |
| What left the bank? | **US$160 paid** | Subscription A $100 + Subscription B $20 + prepaid API credits purchased $40. Synthetic receipts. |
| What was consumed from credits? | **US$15 used; US$25 remaining** | Opening balance zero, no expiry/refund, $40 purchased. This consumption is not added again to $160 cash paid. |
| What is the usage worth at list rates? | **US$380 API equivalent** | A separate estimate from observed tokens and a dated price snapshot. It is neither a payment nor a saving. |
| What will renew? | **US$120 scheduled commitments** | Next-cycle plan entries, assuming unchanged terms; not an additional current-month cash charge. |
| What is missing? | **One authorized source unobserved; 47 unpriced requests** | Unknown money remains unknown. “Two sources present” is not a completeness percentage. |
| What should I do? | **Review the missing source before changing the plan** | A proposed action with its evidence and unresolved assumptions, not an automatic cancellation. |

The review should allow a reader to move from a total to its records, then to the original source/period and any correction. It should keep observed usage, inferred allocation and chosen policy visually and structurally separate. The same record can support a local view, a redacted export or a later private-team report without pretending those audiences are interchangeable.

### Minimum semantic contract, proposed

Each financial record needs a type such as `cash_payment`, `fixed_commitment`, `credit_purchase`, `credit_consumption`, `metered_charge`, `api_equivalent_estimate` or `allocation`. Include currency, period, source, observed time, effective time, scope, price version, correction lineage and reconciliation status. Missing values remain nullable/unknown. Estimate confidence does not turn a figure into an invoice fact.

A source-observation record needs tool/version, account scope, device-local identity, measurement window, capture mode, usage coverage and the evidence linking it to a request/attempt where available. A separate report states which populations and sources are included. Do not infer coverage completeness from the number of successful collectors alone.

This extends #12 THR-03–08. It is not a request to replace the existing snapshot/idempotency system. Provider-specific cache/reasoning semantics and request identities belong to Track 6. Allocations need an explicit denominator and policy; the same usage can contribute to public groups without those group totals becoming additive cash charges. [[R09], [R12]]

## 10. Business model and pricing hypotheses

### 10.1 Preserve a useful free local product

A free local tier can retain usage visibility, transparent coverage, basic catalog access and export. It offers a reason to adopt without claiming that adoption will convert into payment. Removing export to manufacture dependence would weaken the proposed trust position.

The paid boundary should be a repeated completed job: accepted reconciliation, a reliable plan review, authorized history across devices if requested, or a private team review with clear administration. Do not charge for a vague promise to reduce spend, and do not add expensive AI inference to generate generic commentary on a chart.

### 10.2 Test the existing anchors, with explicit alternatives

| Hypothesis | Scope to show before asking for commitment | Evidence needed |
| --- | --- | --- |
| **US$12/month personal**, carried from THR-29 | A defined recurring review/history benefit beyond free counters; exact supported sources and limitations | Payments and week-four use, with a named decision. Free interest is not payment evidence. |
| **US$49 or US$99/workspace/month**, carried from #12 | Included participants/collectors, report cadence, retention, support and permissions specified | A budget owner accepts the offer and a second cycle remains useful; compare directly with existing paid alternatives. |
| **Episodic review**, price to discover | A bounded renewal or month-close review with a clear output and exception policy | Buyer values the completed review even without daily engagement. Do not force monthly billing onto an annual job. |

These are **proposed prices in US dollars**, not Token Horizon's current tariff or evidence of what the market will bear. Recruitment in Australia should establish preferred purchase currency and procurement requirements; no exchange-rate conversion is assumed here.

Avoid inference-spend percentage revenue as the default. It creates a conflict when the product should sometimes recommend spending less or retaining a flat plan. If affiliate or referral revenue is explored later, rankings must be independent and the relationship disclosed beside the recommendation. Selling raw user usage or cross-tenant benchmark data is outside the proposed offer.

### 10.3 Unit economics: a sensitivity exercise, not a forecast

Use:

`contribution = net subscription revenue − payments/hosting/storage − support and reconciliation labor − source-maintenance allocation − other variable delivery cost`

As a deliberately simple **synthetic planning example**, assume labor costs US$60/hour and non-labor variable cost is US$2/account/month. At US$12, ten minutes of monthly support consumes the remaining US$10 before acquisition, engineering or overhead. At US$49, thirty minutes of support consumes US$30, leaving US$17 under those assumptions. These values are arithmetic illustrations, not measured Token Horizon costs or a gross-margin forecast.

Measure time spent on onboarding, missing data, provider changes, billing disputes, refunds and report corrections. A local architecture may reduce storage expense while increasing connector support. A “small” customer is not automatically inexpensive to serve. THR-31 should gate expansion, including source licensing and the cost of maintaining dated price/plan evidence. [[R12]]

## 11. Distribution: test the path to a useful decision

| Channel hypothesis | Existing asset | Smallest proposed test | Failure signal |
| --- | --- | --- | --- |
| Existing local tool users | Native app, CLI, release links | A clear local review entry point with an explicit source list and synthetic example | Installs do not lead to a usable observation or repeated decision. |
| Narrow model/plan questions | Public catalog, documentation and MCP | Three evidence-rich pages, each linked to one supported tracking task | Readers compare prices but have no need for the local product. |
| Open-source workflow communities | Public source and exportable evidence | Later authorized publication of a useful method/example, with corrections and alternatives | Attention comes only from launch novelty or founder participation. |
| Agency/accounting workflow | Existing project attribution concepts | Later authorized interviews around an actual prior reporting cycle | No budget owner, no accepted charge basis, or incumbent already adequate. |
| Agent-assisted discovery | Hosted public catalog MCP | Verify that an agent can reproduce a dated comparison and communicate unknowns | Uncited or stale recommendations create more support than activation. |

These are channel hypotheses. No outreach, content publication, ads, partnership or analytics activation occurred in this task. There is no evidence of an existing audience large enough to support a revenue plan.

**Measurement contract.** Keep these events separate: decision-page viewed, evidence understood, supported installer selected, installation confirmed by the local product, first eligible observation, completed review, repeat useful review, paid continuation. Do not attach private prompts, usernames, project paths, query strings or profile handles to marketing analytics. Optional participant-managed study records can test early hypotheses before production telemetry exists.

Open PR #25 is default-disabled, homepage-only opt-in analytics preparation. It does not prove installation or native activation and must not be silently expanded to private product telemetry. #21/#23 and Track 4 own acquisition/activation verification. The research can use a manually administered, consented protocol while those gates remain open. [[R26], [R27]]

## 12. Staged experiments and decision gates

All counts, timings and thresholds in this section are **proposed learning choices**, not statistical proof, market forecasts or commitments to conduct outreach. The numerical goals already recorded in #12 are preserved and explicitly distinguished from new gates.

| Stage | Protocol | Advance evidence | Stop, narrow or revisit | Planning effort |
| --- | --- | --- | --- | --- |
| **E0 — Truth packet** | Reconcile source/release/public statements; prepare six synthetic financial/coverage fixtures | All monetary bases labeled, no unknown-as-zero, privacy/capture copy matches tested version, source/publication dates explicit | Any unresolved contradiction blocks an accuracy/privacy claim | 2–4 engineering/review days; no schedule promised |
| **E1 — Buyer evidence** | Retain 15 interviews; proposed split 5 budget-owning founders/leads, 5 individuals, 5 agency owners; ask about last incidents before concept | Preserve earlier gate: at least 8/15 have concrete recent recurring pain/workaround. Add at least 3 identifiable budget owners willing to evaluate a specified offer | If 10/15 have a satisfactory substitute requiring under roughly 30 minutes/month, narrow the job. Segment disagreement requires targeted follow-up, not pooled success | 3–5 researcher days plus recruiting elapsed time |
| **E2 — Substitute/comprehension test** | Eight evaluators compare synthetic Token Horizon decision record with their normal/free/native alternative; agencies also see Tallyhook's offer | 7/8 distinguish cash, credit use and equivalent value; all critical privacy/accounting errors resolved; at least 6/8 correctly identify unknown coverage | Stop if clarity is no better or users cannot name a consequential decision | 2–3 study days, excluding prototype |
| **E3 — Local pilot** | Ten qualified users, two supported tools, explicit coverage, reversible setup; no forced cloud publishing | Preserve 6/10 using independently on at least three days in week two and naming a useful decision; at least 4 repeat the review in week four | Curiosity-only use, unresolved accuracy, or support burden prevents expansion; monthly-only use suggests episodic product | 5–10 prototype days after E0, then four-week observation |
| **E4 — Personal price** | After useful behavior, a separately authorized real offer to 20 qualified prospects around the existing US$12 anchor | Preserve five payments plus continued week-four use; record alternatives shown and refusals | Waitlists, compliments and free-pilot participation do not pass; no recurring use means revisit billing cadence | 1–2 offer-analysis days plus observation |
| **E5 — Agency challenger** | Existing THR-30: five suitable teams receive a concrete proposed scope/price; later authorized pilot | Preserve two paid pilots; add accepted allocation basis, no material unexplained discrepancy, and second-cycle use | Reject if fixed fees make attribution irrelevant, client basis is unacceptable, or existing tool is sufficient | 3–5 preparation/delivery days per bounded pilot; live tenancy excluded |
| **E6 — Acquisition proof** | Three narrow decision pages tested with ten appropriate evaluators before any wider promotion | Proposed 8/10 interpret price basis/freshness correctly and 6/10 complete a supported local first observation; measure later repeated review separately | Clicks without supported setup or useful repeat behavior do not justify scaling SEO spend | 2–4 content/study days after prerequisite gates |

Do not add these efforts together as a sprint estimate. Some overlap, recruiting and billing cycles dominate elapsed time, and failed early gates should cancel later work. A production private-team rollout requires its own implementation estimate and security acceptance.

### Interview questions that can disconfirm the idea

Ask for the last actual bill, renewal, quota interruption or allocation request, using redacted examples only with permission. What decision had to be made? Who authorized it? How was it answered last time? What took time or remained unknown? What consequence followed? Which free/native/paid alternatives were tried? What data would they refuse to expose? What budget already exists for solving the job?

Only after documenting that history should the interviewer show a scope and price. Ask what would prevent purchase and what would make the buyer cancel after the first month. Record “no problem,” “existing tool sufficient,” “cannot grant access,” “not my budget” and “not recurring” as distinct outcomes. Do not relabel them as onboarding objections without evidence.

### Outcome record, proposed

For each evaluation retain a pseudonymous study ID, segment, source of recruitment, previous workaround, last incident date, job frequency, budget owner confirmed or unknown, accepted data scope, alternative shown, task outcome, time/assistance, chosen action, stated objection and commercial state. Commercial states must distinguish offered, accepted in principle, paid, renewed and cancelled. Keep personal identities in a separate consent-controlled recruitment store, not product telemetry or this research artifact.

## 13. Backlog-ready proposed items, mapped to existing issues

**No new issues should be created from this table without another reconciliation.** Each ID below is a report-local identifier for an acceptance extension or experiment under an existing item. Functional owners are proposed roles, not assignments. Engineering days assume an experienced contributor and exclude procurement/release time.

### MKT-01 — Refresh the buyer-evidence plan

- **Priority / parent:** P0; #12 THR-01. Proposed owner: product research.
- **Problem:** existing hypotheses lack verified recent incidents, budget owners and substitute comparisons.
- **Deliverable:** revised interview protocol, segment ledger and anonymized evidence template; preserve the original 15-person target and explicitly document the recruitment refinement.
- **Acceptance:** each positive case contains a recent job/workaround, frequency, decision owner, permission boundary and alternative; negative cases retained; no feature-pitch-only interview counted. Pass/fail uses E1.
- **Dependency / effort / risk:** none beyond authorized future recruitment; 3–5 researcher days plus elapsed recruiting. Main risk is convenience-sample enthusiasm. No outreach is authorized by this report.

### MKT-02 — Product claim and release truth packet

- **Priority / parent:** P0; #12 THR-02, #13, #41. Proposed owner: product/engineering.
- **Problem:** current source, published packages and public descriptions are not interchangeable.
- **Deliverable:** versioned claim matrix with source SHA, release SHA, public artifact digest, test evidence and explicit unsupported states.
- **Acceptance:** every tested launch/accuracy/privacy claim names the version and observation; macOS/portable capabilities separated; README capture conflict resolved in a future reviewed change; no missing package represented as verified.
- **Dependency / effort / risk:** read-only lineage and isolated fixtures first; 2–4 days. Risk: overstating a documentation correction as runtime proof.

### MKT-03 — Financial basis and unknown-state specification

- **Priority / parent:** P0; #12 THR-03–07, #13, #19. Proposed owner: accounting-domain product engineer with Track 6.
- **Problem:** a numeric cost field cannot safely stand for payments, usage estimates and allocations at once.
- **Deliverable:** record taxonomy and six synthetic fixtures covering fixed plan, prepayment, metered consumption, missing price, duplicate observation and price revision.
- **Acceptance:** $100 subscription plus $250 equivalent is never displayed as $350 cash; a credit purchase is not re-counted when consumed; unknown remains unknown; historical evidence is reproducible; a correction preserves lineage; exact currency/period shown.
- **Dependency / effort / risk:** existing snapshot rules preserved; 3–5 specification/fixture days, implementation separately estimated. Risk: false precision where provider data is incomplete.

### MKT-04 — Catalog provenance and publication evidence

- **Priority / parent:** P0 dependency; #19 and #41, with #12 THR-07. Proposed owner: existing catalog/publication owners.
- **Problem:** a current source generation timestamp and a current offer-verification date are different facts.
- **Deliverable:** sample lineage from source input through generated artifact to deployed content, including per-offer reviewed/effective times.
- **Acceptance:** inspected public digest/revision agrees with intended source or visible discrepancy; stale plans are labeled; a sampled price can be reproduced from an authoritative offer; invalid/unpriced/plan-covered/free states remain separate.
- **Dependency / effort / risk:** existing CI/publication gates; 1–3 diagnostic days, repair estimate follows cause. No deployment is authorized. Risk: assuming a publisher failed without a receipt.

### MKT-05 — Test the decision record against substitutes

- **Priority / parent:** P0 experiment; #12 THR-05/13/29, #13. Proposed owner: product research with Track 2.
- **Problem:** technical correctness may not produce understandable or valued decisions.
- **Deliverable:** E2 protocol using this report's original synthetic card and comparator tasks.
- **Acceptance:** predefined money/unknown comprehension questions, consistent task dataset, assistance recorded, failures retained; meet E2 before price-led promotion.
- **Dependency / effort / risk:** MKT-03; 2–3 study days. Risk: a contrived fixture that advantages the concept; use participants' normal alternative and counterbalance order.

### MKT-06 — Bounded two-tool local pilot

- **Priority / parent:** P1 after gates; #12 THR-09–13. Proposed owner: local app engineering/product.
- **Problem:** repeat utility and interruption/decision benefit are not measured.
- **Deliverable:** local Claude Code/Codex review prototype with manual inventory, visible coverage and reversible setup.
- **Acceptance:** source-specific capture/rollback verified with synthetic data; no public profile required; E3 retention plus named decisions; collector failures in observation mode do not block the underlying tool.
- **Dependency / effort / risk:** MKT-02/03/05; 5–10 prototype days then observation. Risk: integration maintenance overwhelms a simple benefit.

### MKT-07 — Personal price and cadence experiment

- **Priority / parent:** P1 after utility; #12 THR-29/31. Proposed owner: product/commercial research.
- **Problem:** earlier US$12 is a hypothesis, not validated pricing.
- **Deliverable:** concrete offer with source coverage, support/retention and cancellation/export terms, plus episodic alternative if behavior warrants.
- **Acceptance:** E4; record real payments separately from intent; refusal reasons and support effort included; no claimed savings derived from API-equivalent totals.
- **Dependency / effort / risk:** E3 and separate authority for future offers/payments; 1–2 preparation days plus study. Risk: high-touch delivery masquerades as self-serve economics.

### MKT-08 — Agency allocation challenger

- **Priority / parent:** P1 challenger; #12 THR-08/30/31/32. Proposed owner: research with Tracks 2 and 5.
- **Problem:** agency fallback now has a direct competitor and an unproven charge basis.
- **Deliverable:** comparison with Tallyhook/spreadsheet, explicit client contract basis and redacted report acceptance.
- **Acceptance:** E5; allocations sum to the chosen reconciled denominator; overlapping teams do not duplicate costs; no client can view another client's report; exports identify estimates/unknowns and agreement basis.
- **Dependency / effort / risk:** MKT-03 and privacy gates; 3–5 days for manual prototype; production backend unestimated. Risk: client disputes and low recurrence.

### MKT-09 — Acquisition-to-utility measurement plan

- **Priority / parent:** P1 dependency; #21/#23; #25 retained as an open PR, not merged scope. Proposed owner: Track 4/product research.
- **Problem:** visits/download clicks do not prove activation or commercial value.
- **Deliverable:** E6 and separate event definitions for decision, download, local first observation and useful return.
- **Acceptance:** no private content/identifiers in marketing events; explicit opt-in where required by existing design; unsupported OS states visible; no activation inferred from a click; no existing analytics baseline fabricated.
- **Dependency / effort / risk:** MKT-02/04, existing consent gates; 2–4 study/content days. Risk: marketing success optimizes a different job from product retention.

### MKT-10 — Private finance boundary before team pilots

- **Priority / parent:** P0 before private cloud ingestion; #12 THR-08/25/32, with Track 2. Proposed owner: identity/data engineer.
- **Problem:** public crew roles and report audiences do not establish private financial tenancy.
- **Deliverable:** tenant/RBAC/consent/retention contract and adversarial synthetic acceptance cases; no live-data trial before it passes.
- **Acceptance:** guessed IDs and switched tenant parameters reveal no records; contributor cannot view another member's restricted financial detail; finance access grants no content access; revoked invites/tokens and cached exports obey declared policy; read and export paths enforce the same boundary.
- **Dependency / effort / risk:** Track 2 architecture; 3–5 design/fixture days, production implementation separately estimated. Risk: accidental employee surveillance or cross-client disclosure.

### MKT-11 — Cost-to-serve and provider-drift ledger

- **Priority / parent:** P1, required before expansion; #12 THR-31 and #19. Proposed owner: product operations/engineering.
- **Problem:** small monthly prices may not support manual corrections and connector maintenance.
- **Deliverable:** per-cohort delivery-cost model with anonymized support minutes, source review, storage, payment and exception costs.
- **Acceptance:** replace assumptions with observations after each pilot cycle; founder labor assigned a disclosed replacement rate; refunds/rework included; recommendation compares contribution across tested packages without asserting a forecast.
- **Dependency / effort / risk:** later pilot observations; 1–2 setup days plus ongoing recording. Risk: hiding work in uncounted founder time.

### MKT-12 — Expansion decision and stop record

- **Priority / parent:** P1 decision gate; #12 overall; #14–16 as dependencies only. Proposed owner: product owner.
- **Problem:** feature breadth can expand faster than evidence of a recurring job.
- **Deliverable:** decision memo after two relevant review cycles: continue, narrow to episodic review, move to agency challenger, retain free utility, or stop commercial expansion.
- **Acceptance:** recommendation cites paid/retained behavior, substitute performance, cost to serve, trust failures and unresolved data; explicitly records which hypotheses failed; no automatic handoff to broad memory, routing or enterprise buildout.
- **Dependency / effort / risk:** E1–E5 as applicable; 1 review day. Risk: renaming a failed idea without new evidence.

## 14. Privacy, trust and defensibility

### 14.1 Trust is required; it is not an automatic moat

Several close alternatives already promise that prompts/code remain local. Tokscale's privacy policy also illustrates that metadata can include identifying tool/device/timing information and that voluntarily submitted profiles may be public and indexable. LobsterOne states 90-day raw-metric retention with longer aggregate retention. These policies are vendor statements, not security audits. They demonstrate why “no prompts” is an incomplete privacy explanation. [[C16], [C17]]

For Token Horizon's proposed paid workflow, require:

- **Separate purposes and consent:** local observation, optional content capture, cloud synchronization, team allocation and public publication are distinct actions. Joining a team does not publish usage. Finance access does not imply prompt access.
- **Minimized collection:** counts, financial evidence and explicit allocation metadata only. No raw prompts, responses, source code, private session titles, emails, repository paths or environment contents in standard exports. Hashes/pseudonyms may still be linkable and must not be called anonymous.
- **Tenant and role boundaries:** a dedicated private workspace namespace; owner, finance reviewer, contributor and limited viewer semantics agreed by Track 2. Scope every read, query, export, cache and background aggregation on the server. Public crews remain separate.
- **Retention by data class:** proposed pilot default is no content collection, 30-day raw metadata retention and 90-day derived study records, each explicitly agreed; bills stay in a customer-controlled location when possible. A production financial-history schedule requires a separate decision. Deletion covers raw/derived data, indexes, exports under service control and backup expiry. Do not promise erasure of files already downloaded by others.
- **Revocation and correction:** removing a grant stops future use and invalidates service-controlled access according to a documented bound. Corrections retain enough provenance for a reviewer to understand what changed, while respecting deletion requirements.
- **No productivity rank from consumption:** team/project/use-case review can describe activity and expense. It cannot infer individual output quality or employment performance from tokens, lines or PR counts alone.

These are product requirements and test constraints, not a claim of legal compliance or a completed security certification. No new permission scopes are prescribed to repair an access gap.

### 14.2 What could accumulate, if customers repeatedly use it

| Potential asset | Why it might help | Why it is not yet a moat |
| --- | --- | --- |
| Reliable source-specific reconciliation fixtures | Reduces regressions and makes explanations reproducible | Competitors can build fixtures; value depends on maintenance and real usage. |
| Dated plan/price/coverage evidence | Supports historical decisions and correction handling | Public data is copyable; rights, freshness and cost of maintenance matter. |
| Customer-approved history of decisions | Makes later reviews more useful within a workspace | Permission is not exclusivity; retain export and deletion. |
| Repeat distribution for a narrow job | Lowers acquisition cost and helps recruit appropriate buyers | No effective channel has been measured. |
| Operational reputation for honest exceptions | May reduce buyer verification burden | Trust has to be earned repeatedly; a privacy slogan is insufficient. |

**Software-copy test:** if a competitor copies the screens and schema, the remaining value must be dependable maintenance, accepted evidence and an economical relationship. None is established today.

**100× cheaper-intelligence test:** cheaper analysis makes generic advice and dashboards easier to reproduce. Normalizing changing external evidence and taking responsibility for a useful reviewed result may remain valuable, but only if buyers still need that result.

**Buyer-bargaining test:** if the customer keeps most automation savings, the offer must survive on low support cost and a specific recurring outcome. Avoid pricing solely as a share of hypothetical token savings.

**Scenario stress:** concentrated or expensive AI increases supplier-dependence risk; cheap widely available agents increase internal-build pressure; fewer employees or tighter budgets make another subscription harder to justify. Robotics does not create a material direct advantage for this software wedge. These are scenarios, not dated forecasts or assigned probabilities.

## 15. Cross-track dependency contract

| Other track | What Track 1 needs | What remains with that track | Release/experiment implication |
| --- | --- | --- | --- |
| **2 — UI and team management** | Understandable scope/consent, later private finance roles and client boundaries | Production flows, navigation, visual design, invitations/RBAC implementation | A local study can proceed first; shared private-data pilots wait for tenant tests. |
| **3 — Knowledge graph** | Optional references to decisions and evidence, with source/retention rules | Handoff schemas, retrieval, memory graph and usefulness evaluation | No graph is required for first spending proof. Reuse #16/THR-17–19 later. |
| **4 — SEO** | Dated decision pages, correct model provenance, truthful OS activation and consented measurement | Indexation, rendering, metadata, performance and channel execution | #19/#21/#23/#41 gate wider catalog distribution. |
| **5 — Team/individual analytics** | Review completion, allocations, population/coverage and useful-return definitions | Cohorts, charts, reporting model and private aggregation | No token-based employee score; public profiles do not stand for all employees. |
| **6 — Token/context analytics** | Reported versus estimated quantities, cache/reasoning normalization, request identity, unknowns | Detailed telemetry and context measurement contracts | Financial claims wait on semantics; context offered/inserted/used remains distinct. |

This report assigns no owner and changes no other track's scope. The market outcome can be tested with a small local record before deep integration; that keeps commercial uncertainty visible instead of hiding it inside a large platform project.

## 16. Decision and next review

The next useful investment is **a truth packet and substitute-based customer discovery**, followed only by the smallest local decision prototype that the evidence justifies. The product already has enough machinery to test the job; expanding the feature list is not the main uncertainty.

Revisit the direction after the first 15 qualified interviews and the synthetic comparison. Advance only with a specific unresolved task and a payer. Revisit again after repeat use and a second relevant spending cycle. Preserve failures and refusals in #12's research record rather than opening a renamed duplicate.

The evidence would change this recommendation if: native/free products already solve the target job; the useful decision requires unavailable or unacceptable data; agency clients reject allocation; buyers only need an occasional review; provider maintenance makes the offer uneconomic; or another track demonstrates repeated paid value from a different job. Those outcomes should redirect investment rather than be treated as a reason to build more dashboards.

## Appendix A. Source register

All sources were accessed on **18 November 2026**. Repository file URLs are pinned to the recorded commit. `M01` is a live connected-read observation, not a webpage or private account record. Public sources are primary publisher/vendor material unless explicitly labeled as prior project research.

### Repository and project evidence

| ID | Evidence / date | URL |
| --- | --- | --- |
| R01 | README at pinned commit; authoritative product link | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/README.md |
| R02 | Head commit, 18 Nov 2026 07:35:19 UTC | https://github.com/castlemilk/token-horizon/commit/b468206e9378c8d7a6788b67072494982e7de17d |
| R03 | v0.5.2 release, published 28 Oct 2026 | https://github.com/castlemilk/token-horizon/releases/tag/v0.5.2 |
| R04 | Product purpose, current audience uncertainty and publication boundaries | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/PRODUCT.md |
| R05 | Usage implementation and estimated-cost function | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Usage/UsageEngine.swift |
| R06 | Usage models | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Usage/Models.swift |
| R07 | Gateway capture configuration | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/config.go |
| R08 | Gateway metadata/content capture behavior | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/proxy.go |
| R09 | Snapshot and correction contract | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/sync-consistency.md |
| R10 | Team identity and owner/member guards | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/team-invites.js |
| R11 | Curated plan/model index | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Catalog/ModelPlanIndex.swift |
| R12 | Preserved 11 Nov research and THR-01–32 | https://github.com/castlemilk/token-horizon/issues/12 |
| R13 | Hosted connector contract | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/CONNECTOR.md |
| R14 | Hosted connector implementation and scope | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/connector.js |
| R15 | Portable desktop packaging/source contract | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/app/README.md |
| R16 | Proposed truthful observability, 11 Nov | https://github.com/castlemilk/token-horizon/issues/13 |
| R17 | Pinned catalog; blob SHA 1e89f78729b8770d5c633fcf8a6c9f491a3d7132 | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/data/models.json |
| R18 | Price evidence/freshness issue, created 17 Nov | https://github.com/castlemilk/token-horizon/issues/19 |
| R19 | Publication-lineage issue, created 17 Nov | https://github.com/castlemilk/token-horizon/issues/41 |
| R20 | Historical product article source; wording compared with code | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/blog/why-token-horizon.html |
| R21 | Merged cost-provenance PR | https://github.com/castlemilk/token-horizon/pull/5 |
| R22 | Complete issue/PR collection, state all; page 2 empty | https://api.github.com/repos/castlemilk/token-horizon/issues?state=all&per_page=100 |
| R23 | Preserved SEO findings, 17 Nov | https://github.com/castlemilk/token-horizon/issues/18#issuecomment-6965239775 |
| R24 | Pricing/TCO clarification, 18 Nov | https://github.com/castlemilk/token-horizon/issues/19#issuecomment-6968555867 |
| R25 | Access retest/rendering gate, 18 Nov | https://github.com/castlemilk/token-horizon/issues/23#issuecomment-6968564846 |
| R26 | Open isolated opt-in homepage analytics PR | https://github.com/castlemilk/token-horizon/pull/25 |
| R27 | Supported activation issue | https://github.com/castlemilk/token-horizon/issues/21 |
| R28 | Gateway contract, capture, retention and transport limitations | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/README.md |
| R29 | Gateway trace schema | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/trace.go |
| R30 | Bounded local trace storage | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/store.go |
| R31 | Cloud snapshot history implementation | https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/usage-history.js |
| P01 | Public homepage; current retrieved text, illustrative demo labels | https://token-horizon.dev/ |
| P02 | Public documentation; current retrieved text | https://token-horizon.dev/docs/ |
| P03 | Prior market page, content updated 11 Nov 2026; read directly | https://chatgpt.com/space/page_3c5424bd852c8191a6718b65858d8933 |
| P04 | Existing Token Horizon project root; read directly | https://chatgpt.com/space/page_6af3b3f3a6308191a3b0fed46bc74230 |
| M01 | Public Token Horizon catalog search: query `claude`, cloud scope, name sort, unified, limit 2; `catalog_total=2074`, `generated_at=1793821960`; no account/profile request | Connected public catalog read; corresponding public surface https://token-horizon.dev/models |

### Competitor evidence

| ID | Primary source and date context | URL |
| --- | --- | --- |
| C01 | ccusage guide, current undated page | https://ccusage.com/guide/ |
| C02 | Tokscale tracker, current undated page | https://tokscale.ai/tracker |
| C03 | CodexBar official site, repo-linked; current page | https://codexbar.app/ |
| C04 | Tallyhook pricing, current page; explicit USD | https://tallyhook.dev/pricing |
| C05 | LobsterOne product/pricing, current page; currency unconfirmed | https://lobsterone.ai/ |
| C06 | WakaTime AI product, current page | https://wakatime.com/ai |
| C07 | WakaTime pricing, current page; currency unconfirmed | https://wakatime.com/pricing |
| C08 | DX AI cost management, current documentation | https://docs.getdx.com/reports/ai-cost-management/ |
| C09 | Cursor usage analytics, current documentation | https://cursor.com/docs/account/teams/analytics |
| C10 | Claude Code analytics, help page displays relative update date | https://support.claude.com/en/articles/12157520-claude-code-usage-analytics |
| C11 | OpenAI Codex plan/usage help, current official page | https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan |
| C12 | Tallyhook security, last updated 19 Sep 2026; vendor statements | https://tallyhook.dev/security |
| C13 | Langfuse pricing, current page | https://langfuse.com/pricing |
| C14 | LiteLLM spend tracking, current documentation | https://docs.litellm.ai/docs/proxy/cost_tracking |
| C15 | OpenRouter pricing/features, current page | https://openrouter.ai/pricing |
| C16 | Tokscale privacy, updated 30 Jul 2026 | https://tokscale.ai/privacy |
| C17 | LobsterOne privacy, updated Mar 2026 | https://lobsterone.ai/privacy/ |

### Market and measurement signals

| ID | Primary source and event/publication date | URL |
| --- | --- | --- |
| S01 | State of FinOps 2026; exact publication day not established | https://data.finops.org/ |
| S02 | Stack Overflow 2026 AI survey | https://survey.stackoverflow.co/2026/ai |
| S03 | Survey methodology; fielded 23 Jun–5 Aug 2026 | https://survey.stackoverflow.co/2026/methodology |
| S04 | Uber buyer-owned engineering account, 27 Aug 2026 | https://www.uber.com/gb/en/blog/efficient-software-factory/ |
| S05 | incident.io buyer-owned engineering account, 14 Oct 2026 | https://incident.io/blog/we-gave-cloud-agents-a-phone-to-qa |
| S06 | DORA measurement guidance, 2 Jun 2026 | https://dora.dev/insights/finding-balance-in-the-era-of-tokenmaxxing/ |
| S07 | METR experiment-design update, 24 Feb 2026 | https://metr.org/blog/2026-02-24-uplift-update/ |

## Appendix B. Suggested eventual repository handoff paths

These paths are **proposals only**. No files were added to the repository.

- `docs/research/2026-11-18-market-track1.md` — this evidence/decision record after review.
- `docs/research/market-experiments.md` — an extension of #12's existing experiment ledger, if no more authoritative ledger already exists.
- `docs/specs/financial-evidence.md` — money/coverage semantics owned jointly with Tracks 5/6; reconcile existing specs before creating.
- `docs/research/fixtures/spending-review-synthetic.json` — safe fixtures only, after the contract is agreed.

The actual local implementation touchpoints are `Usage/UsageEngine.swift`, `Usage/Models.swift`, `Catalog/ModelPlanIndex.swift`, the gateway metadata code and the existing snapshot contract. Cloud finance scope must be designed explicitly before changing public team/profile handlers. This research recommends no code diff because the commercial and semantic gates should precede implementation.

---

**Verification statement:** repository/source reads, issue/PR inventory, project-page reads, public-page retrieval and one public catalog query were completed. Product installs, runtime accuracy, privacy behavior, tenant isolation, financial reconciliation, customer demand, payment conversion and experiment outcomes were not tested. Every proposed threshold and mock record is labeled accordingly.

## Appendix C. Complete observed issue and PR index

Read-only snapshot, 18 November 2026. All 46 records from the state-all collection are represented; a second page returned no further records. This index records status, not deployment or completed acceptance. No author identity or private record is included.

| Number | Type | Observed state | Title |
| --- | --- | --- | --- |
| [#1](https://github.com/castlemilk/token-horizon/pull/1) | PR | merged | crossplatform daemon + ui |
| [#2](https://github.com/castlemilk/token-horizon/pull/2) | PR | merged | Fix dashboard search synchronization and login focus restoration |
| [#3](https://github.com/castlemilk/token-horizon/pull/3) | PR | merged | Preserve live dashboard changes while releasing CI fixes |
| [#4](https://github.com/castlemilk/token-horizon/pull/4) | PR | merged | Add MCP app extensions and reliable metadata traces |
| [#5](https://github.com/castlemilk/token-horizon/pull/5) | PR | merged | Clarify MCP usage labels and cost provenance |
| [#6](https://github.com/castlemilk/token-horizon/pull/6) | PR | merged | Engine: rich local-run roster across TH Engine, Splash and MLX + supervised MLX backend |
| [#7](https://github.com/castlemilk/token-horizon/pull/7) | PR | merged | Clarify the hosted MCP plan model limit |
| [#8](https://github.com/castlemilk/token-horizon/pull/8) | PR | merged | Add managed account sign-in for website and MCP review access |
| [#9](https://github.com/castlemilk/token-horizon/pull/9) | PR | merged | Publish MCP app domain verification |
| [#10](https://github.com/castlemilk/token-horizon/pull/10) | PR | merged | Update hosted MCP SDK dependencies |
| [#11](https://github.com/castlemilk/token-horizon/pull/11) | PR | merged | Make hosted MCP refresh rotation durable |
| [#12](https://github.com/castlemilk/token-horizon/issues/12) | Issue | open | [Research preservation] Token Horizon direction and validation backlog — 2026-11-11 |
| [#13](https://github.com/castlemilk/token-horizon/issues/13) | Issue | open | [Proposed] TH-UI-01 Truthful observability and request-attempt detail |
| [#14](https://github.com/castlemilk/token-horizon/issues/14) | Issue | open | [Proposed] TH-UI-02 Explainable draft routing simulation |
| [#15](https://github.com/castlemilk/token-horizon/issues/15) | Issue | open | [Proposed] TH-UI-03 Local host inventory and model lifecycle |
| [#16](https://github.com/castlemilk/token-horizon/issues/16) | Issue | open | [Proposed] TH-UI-04 Reviewed work handoff, plans and setup evidence |
| [#17](https://github.com/castlemilk/token-horizon/pull/17) | PR | merged | Publish the benchmark report at /benchmarks/ |
| [#18](https://github.com/castlemilk/token-horizon/issues/18) | Issue | open | [SEO][High] Investigate catalog rendering and request-dependent access |
| [#19](https://github.com/castlemilk/token-horizon/issues/19) | Issue | open | [SEO][High] Expose reproducible pricing provenance and freshness in catalog comparisons |
| [#20](https://github.com/castlemilk/token-horizon/issues/20) | Issue | open | [SEO][Medium] Decide parameter-view indexation after rendered-content comparison |
| [#21](https://github.com/castlemilk/token-horizon/issues/21) | Issue | open | [SEO][Medium] Connect model discovery to supported desktop activation |
| [#22](https://github.com/castlemilk/token-horizon/issues/22) | Issue | open | [SEO][Medium] Align llms.txt discovery with public MCP documentation policy |
| [#23](https://github.com/castlemilk/token-horizon/issues/23) | Issue | open | [SEO][Medium] Complete rendered, accessibility, performance and indexing validation |
| [#24](https://github.com/castlemilk/token-horizon/pull/24) | PR | closed, unmerged | feat: prepare opt-in homepage analytics |
| [#25](https://github.com/castlemilk/token-horizon/pull/25) | PR | open | feat: prepare isolated opt-in homepage analytics (clean scope) |
| [#26](https://github.com/castlemilk/token-horizon/issues/26) | Issue | open | [CI][P1] Give local and CI checks one authoritative command manifest |
| [#27](https://github.com/castlemilk/token-horizon/issues/27) | Issue | open | [CI][P1] Replace fixed-time animation sampling with observable progress |
| [#28](https://github.com/castlemilk/token-horizon/issues/28) | Issue | open | [CI][P2] Include both installed npm lockfiles in cache identity |
| [#29](https://github.com/castlemilk/token-horizon/issues/29) | Issue | open | [CI][P3] Remove the ineffective gateway dependency-cache configuration |
| [#30](https://github.com/castlemilk/token-horizon/issues/30) | Issue | open | [CI][P2] Make the focused performance command actually focused |
| [#31](https://github.com/castlemilk/token-horizon/issues/31) | Issue | open | [CI][P2] Remove optional film rendering from the mandatory native-release path |
| [#32](https://github.com/castlemilk/token-horizon/issues/32) | Issue | open | [CI][P2] Make report-generation failures explicit and retain bounded diagnostics |
| [#33](https://github.com/castlemilk/token-horizon/issues/33) | Issue | open | [CI][P1] Replace the synthetic scope-count benchmark with production-cache coverage |
| [#34](https://github.com/castlemilk/token-horizon/issues/34) | Issue | open | [CI][P1] Stop executing the complete Swift suite twice on every PR |
| [#35](https://github.com/castlemilk/token-horizon/issues/35) | Issue | open | [CI][P1] Introduce trusted, toolchain-specific native build caches |
| [#36](https://github.com/castlemilk/token-horizon/issues/36) | Issue | open | [CI][P1] Consolidate browser fixtures and orchestration without deleting scenarios |
| [#37](https://github.com/castlemilk/token-horizon/issues/37) | Issue | open | [CI][P2] Give scheduled catalog refresh a smaller, verifiable build boundary |
| [#38](https://github.com/castlemilk/token-horizon/issues/38) | Issue | open | [CI][P2] Make LocalServer integration tests prove both lifecycle outcomes |
| [#39](https://github.com/castlemilk/token-horizon/issues/39) | Issue | open | [CI][P2] Make the default MCP test command hermetic |
| [#40](https://github.com/castlemilk/token-horizon/issues/40) | Issue | open | [CI][P0] Establish the intended Cuttlefish project, rig and execution contract |
| [#41](https://github.com/castlemilk/token-horizon/issues/41) | Issue | open | [CI][P1] Verify catalog commit-to-publication lineage |
| [#42](https://github.com/castlemilk/token-horizon/issues/42) | Issue | open | [CI][P2] Prove a dependency map before enabling selective execution |
| [#43](https://github.com/castlemilk/token-horizon/issues/43) | Issue | open | [CI][P3] Measure superseded PR work before adding cancellation |
| [#44](https://github.com/castlemilk/token-horizon/issues/44) | Issue | open | [CI][P1] Explain the render-budget failure without relaxing its threshold |
| [#45](https://github.com/castlemilk/token-horizon/pull/45) | PR | open | test: wait for observable ASCII animation progress |
| [#46](https://github.com/castlemilk/token-horizon/issues/46) | Issue | open | [SEO][Medium] Align article canonical URLs with redirects and discovery links |

<!-- Source reference links for exportable Markdown. -->
[R01]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/README.md
[R02]: https://github.com/castlemilk/token-horizon/commit/b468206e9378c8d7a6788b67072494982e7de17d
[R03]: https://github.com/castlemilk/token-horizon/releases/tag/v0.5.2
[R04]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/PRODUCT.md
[R05]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Usage/UsageEngine.swift
[R06]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Usage/Models.swift
[R07]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/config.go
[R08]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/proxy.go
[R09]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/sync-consistency.md
[R10]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/team-invites.js
[R11]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Catalog/ModelPlanIndex.swift
[R12]: https://github.com/castlemilk/token-horizon/issues/12
[R13]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/CONNECTOR.md
[R14]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/connector.js
[R15]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/app/README.md
[R16]: https://github.com/castlemilk/token-horizon/issues/13
[R17]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/data/models.json
[R18]: https://github.com/castlemilk/token-horizon/issues/19
[R19]: https://github.com/castlemilk/token-horizon/issues/41
[R20]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/blog/why-token-horizon.html
[R21]: https://github.com/castlemilk/token-horizon/pull/5
[R22]: https://api.github.com/repos/castlemilk/token-horizon/issues?state=all&per_page=100
[R23]: https://github.com/castlemilk/token-horizon/issues/18#issuecomment-6965239775
[R24]: https://github.com/castlemilk/token-horizon/issues/19#issuecomment-6968555867
[R25]: https://github.com/castlemilk/token-horizon/issues/23#issuecomment-6968564846
[R26]: https://github.com/castlemilk/token-horizon/pull/25
[R27]: https://github.com/castlemilk/token-horizon/issues/21
[P01]: https://token-horizon.dev/
[P02]: https://token-horizon.dev/docs/
[P03]: https://chatgpt.com/space/page_3c5424bd852c8191a6718b65858d8933
[P04]: https://chatgpt.com/space/page_6af3b3f3a6308191a3b0fed46bc74230
[C01]: https://ccusage.com/guide/
[C02]: https://tokscale.ai/tracker
[C03]: https://codexbar.app/
[C04]: https://tallyhook.dev/pricing
[C05]: https://lobsterone.ai/
[C06]: https://wakatime.com/ai
[C07]: https://wakatime.com/pricing
[C08]: https://docs.getdx.com/reports/ai-cost-management/
[C09]: https://cursor.com/docs/account/teams/analytics
[C10]: https://support.claude.com/en/articles/12157520-claude-code-usage-analytics
[C11]: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
[C12]: https://tallyhook.dev/security
[C13]: https://langfuse.com/pricing
[C14]: https://docs.litellm.ai/docs/proxy/cost_tracking
[C15]: https://openrouter.ai/pricing
[C16]: https://tokscale.ai/privacy
[C17]: https://lobsterone.ai/privacy/
[S01]: https://data.finops.org/
[S02]: https://survey.stackoverflow.co/2026/ai
[S03]: https://survey.stackoverflow.co/2026/methodology
[S04]: https://www.uber.com/gb/en/blog/efficient-software-factory/
[S05]: https://incident.io/blog/we-gave-cloud-agents-a-phone-to-qa
[S06]: https://dora.dev/insights/finding-balance-in-the-era-of-tokenmaxxing/
[S07]: https://metr.org/blog/2026-02-24-uplift-update/
[M01]: https://token-horizon.dev/models
[R28]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/README.md
[R29]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/trace.go
[R30]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/gateway/store.go
[R31]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/usage-history.js