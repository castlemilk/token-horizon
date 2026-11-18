> Preservation copy. Original report and companion-relative links are available in [bundle/](bundle/). See [handoff index](../README.md) for backlog reconciliation and evidence limits.

# Token Horizon — Track 2 research and specification

## Interface, team management and scoped member usage

**Research date:** 18 November 2026, Australia/Melbourne (AEDT).  
**Repository:** [castlemilk/token-horizon](https://github.com/castlemilk/token-horizon).  
**Inspected branch:** `main`.  
**Pinned commit:** [`b468206e9378c8d7a6788b67072494982e7de17d`](https://github.com/castlemilk/token-horizon/commit/b468206e9378c8d7a6788b67072494982e7de17d), authored 18 November 2026 at 07:35:19 UTC / 18:35:19 AEDT; commit message: catalog refresh. The branch still resolved to this SHA at the final source check.  
**Public product:** [token-horizon.dev](https://token-horizon.dev/), identified from the pinned README, not inferred from its name.  
**Status:** Read-only research, source inspection and isolated design/specification artifacts. All new routes, roles, retention defaults, DTOs and wireframes below are **proposed, unimplemented and untested**. No repository, issue, PR, deployment, public page, account setting or permission was changed.

Companion: **token-horizon-track2-wireframes.pdf**, nine annotated boards. The review bundle also contains PNGs, a board index and this complete Markdown report. Every person, organization, email address, cost, count and chart in the proposals is synthetic. Actual public profile identities and usage values observed during inspection are intentionally omitted.

---

## 1. Decision and recommended direction

**Preserve Token Horizon’s existing Quiet precision identity and add a separately authorized private workspace layer.** The visual system is already coherent. The largest gap is the difference between today’s public community teams and the proposed administrative workspace: identity, access, attribution and lifecycle must be explicit before a member-level accounting interface can be trustworthy.

The recommendation has three parts:

1. **Improve the current product immediately through bounded interface work.** Preserve owned-profile discovery and clear snapshot labels; fix the specific source-level navigation and share-control semantics identified below; bring mobile, keyboard and state verification under the existing test backlog.
2. **Define a private workspace as a new security and data boundary.** It must have its own immutable ID, verified membership, scoped records, grants and retention policy. Existing community membership does not authorize it. Joining does not import personal history or publish a profile.
3. **Separate people administration from named usage review.** Members see their own attributed work usage. Aggregate review requires an explicit capability. Named cost attribution requires an additional purpose-bound capability and a visible policy. No role receives prompts, session titles, raw traces or employee productivity rankings through these screens.

This follows the project’s existing direction toward a daily private work and budget view, while respecting the fact that broader private collaboration remains a proposed later-stage roadmap item. It does not silently reprioritize or close that roadmap. [S01][S02][S24][S25]

### The most consequential findings

| Finding | Evidence classification | Product implication |
| --- | --- | --- |
| The site and repository already use Mineral, Graphite, Forest and Signal, with an eclipse/horizon identity and semantic theme tokens. | Current public observation + current source | Extend the system; a wholesale rebrand would add cost without addressing the central problem. |
| Current Teams are voluntary public community crews with owner/member roles. | Current public observation + current source | Do not describe them as private organization tenancy or an employer dashboard. |
| Every owned published profile contributes its full published history to every joined team. | Current source | Overlapping community totals cannot become unique work or financial allocation by changing a label. Track 5 owns replacement semantics. |
| Workspace already distinguishes verified self, explicit public preview, checking, loading, empty and failed states. | Current source; signed-out state observed publicly | Preserve these safeguards. The proposal is not starting with a blank dashboard. |
| Current report scope `org` checks whether owner and recipient share any authoritative team; the UI says so. | Current source | A specifically selected private workspace audience is a new contract with migration implications. This is not presented as a hidden defect in the current promise. |
| An off-by-default publication option can include session-title text. | Current source | Do not claim all session-derived text always stays local. Administrative DTOs must exclude titles structurally. |
| No private admin role, member suspension/removal or ownership-transfer contract was found in the inspected team handler. | Bounded current-source absence | These require backend work; drawing controls does not establish their existence. |
| The repository already has relevant research and verification issues. | Current issue/PR inventory | Refine #12, #13 and #23, and propose bounded children only where needed. |

Evidence: [S01][S02][S05][S06][S08][S09][S11][S30][S12][S13][S14][S15][S20][S24][S26][S27].

## 2. Scope, method and evidence limits

This study owns visual direction, information architecture, interaction/state design, team administration, permission presentation and the access boundary around per-user usage. It does **not** redefine token accounting, cost formulas, billing reconciliation, coverage denominators, allocation, deduplication or suppression algorithms. Those are Track 5 dependencies. Token/context semantics belong to Track 6; knowledge-content permissions belong to Track 3; SEO belongs to Track 4; packaging and demand validation belong to Track 1.

### Evidence labels used in this report

| Label | Meaning |
| --- | --- |
| **Current public / observed** | Rendered public UI was inspected during this session. It is available behavior, not proof of its serving commit. |
| **Current source / source-only** | Read in actual files at the pinned main commit. Authenticated or native behavior was not necessarily executed. |
| **Measured** | A named calculation or artifact check was performed here, with its scope stated. No production performance, conversion or adoption measurement is claimed. |
| **Historical** | Existing issue, PR, report or concept evidence. A past test claim was not rerun unless explicitly stated. |
| **Inferred** | Reasoned consequence of inspected evidence; not a verified runtime fact. |
| **Proposed** | Original requirement, layout, estimate, API or test to review and implement later. |

### What was inspected

- GitHub repository metadata, current branch and commit; the complete recursive tree; targeted source for routing, Workspace, theme tokens, Teams, invitations, authentication, report access, native Teams and publishing; relevant existing UI tests.
- All-state issue collection: **46 records**, comprising **31 open regular issues, zero closed regular issues, 12 merged PRs, two open draft PRs and one closed/unmerged PR**. A separate all-state PR read reconciled the 15 PRs. The collection fit in one page of 100; this is a complete inventory at read time, not a claim of permanent completeness. [S26][S27]
- Existing Token Horizon project context, including the Space root and 32-item roadmap; preserved UI, analytics and historical concept context. Context is treated as proposal/history unless corroborated by current code. [S24][S25]
- The canonical public landing page, rendered Teams directory and expandable team row, a synthetic no-match team search, and the signed-out Workspace entry. Browser captures were used internally for inspection and are not included as deliverables.
- Current W3C, OWASP, NIST and narrowly selected Langfuse primary documentation. Access date for external sources is 18 November 2026. Vendor features are dated observations; this is not a market survey. [E01]–[E11]

### Access and validation gaps

1. **No deployed SHA was established.** Main and the visible public UI agree on major surfaces, but that is not a build-provenance check. PR #3 documents historical source/deployment drift; its old live verification is not today’s proof. [S28]
2. **No sign-in or live management mutation was performed.** Invitation creation/delivery/acceptance, profile claim, role changes, sharing changes, suspension, removal, transfer and account settings were not exercised. Private access remains a source audit, not a penetration test.
3. **No native app or repository test suite was run.** Existing tests were inspected/inventoried. No dependencies were installed. Public desktop rendering was inspected; live narrow-viewport, assistive-technology and full keyboard audits remain open.
4. **Web retrieval had representation gaps.** Direct web retrieval of the GitHub homepage failed while the connected GitHub source reader worked. The web text extractor could not access the `leaderboard.html?view=dashboard` URL and returned a generic shell for `/teams`; the browser rendered the actual public states. Those extractor results are not treated as evidence the product is broken.
5. **No private telemetry, prompts or credentials were requested.** The hosted connector’s published-data scope does not provide unpublished device totals or local traces. Public rankings were not substituted for personal usage.
6. **The original research conversation linked by older project records was not independently inspected.** Accessible preserved source, issues and Pages were read instead. Older generated images were not used as proof of implementation.
7. **The NIST publication overview was read, not the full SP 800-188 report.** Its de-identification governance point is used narrowly. [E10]

## 3. Actual routes, components and states

### Route and surface inventory

| Surface | Current behavior | Evidence / limit |
| --- | --- | --- |
| `/` | Light Mineral canvas, dark header, Forest actions, illustrative interactive product tour, public discovery and installation. The tour labels sample data. | Rendered public observation; README identifies the host. [S01][P01] |
| `/teams` | Public standings, search/sort, expandable team information, comparison/history controls and provider mix. Text explains published coverage and overlapping memberships. | Rendered directory, expansion and no-match state observed; source inspected. [S06][P02] |
| `/t/:id` | Public team detail and analytics; membership management is a separate account operation. | Source-only in this study; no specific team URL or personal values reproduced. [S06] |
| `/leaderboard.html?view=dashboard` | “Workspace” analyzes a selected published profile; signed-out state offers sign-in and deliberate public-handle preview. | Signed-out rendering observed. Full owned-profile selection source inspected. [S05][P03] |
| `view=billing` | Model costs delegates to Workspace’s Models & costs section for the selected profile. | Source-only; not an invoice-management system. [S07] |
| `view=settings` | Report sharing verifies owned profile and lists supported share/audience states. | Source-only; no report or permissions were changed. [S07][S11][S30] |
| `/u/:handle` and legacy player views | Public profile exploration. Published title metadata may exist if enabled by the publisher. | Source-only; administrative proposals do not consume this payload. [S05][S13] |
| `/invite/:token`, `/join/:token` | Community invitation entry, sign-in and intentional join; membership does not require a published profile. | Source + fixture tests inspected; no real token opened or used. [S08][S09][S18][S34] |
| Team-management dialog | Select among the account’s teams; owner controls invitations/icons; member can leave a selected team. | Source-only. Existing role vocabulary is owner/member. [S08][S09] |
| `/login`, account sign-in | Existing provider-subject identity contracts; managed sign-in is gated by current configuration. | AUTH documentation and merged PR #8, not live auth verification. [S10][S33] |
| `/connect`, hosted MCP | Hosted public/published account surfaces; separate local server accesses local engine capabilities. | README/skill contract; private local data was not queried. [S01][S10] |
| Native macOS Teams | SwiftUI view presents cloud/public aggregates; management directs to the web. | Source-only; native readability and behavior not executed. [S16][S32] |
| Native web destinations | Central URL construction for workspace, teams, profiles, sharing and sign-in; local labels do not prove authoritative team membership. | Source-only. [S16][S32] |

### Existing implementation assets worth retaining

`docs/workspace.js` already does the difficult first-step work: account checking is distinct from profile discovery, a successful empty account is distinct from a request failure, and a deliberate public preview is distinct from verified self. One verified-owned profile may open automatically; multiple profiles require a selection. Account changes invalidate private state. Scope and publication freshness remain visible. [S05][S14]

The shared API helper avoids private-response caching and rejects stale private responses after identity changes. It also guards authenticated requests to custom API origins. Existing team membership updates use versioned records, compare-and-swap retry and tombstones; stale secondary indexes are not treated as authority. These are useful baselines, but do not establish isolation for new private workspace routes. [S09][S14]

The interface already has native dialogs, labeled single-choice controls, an original icon-action vocabulary, persistent descriptions, focus restoration and reduced-motion handling. Workspace charts include accessible summaries; Teams has an exact-day/table pattern that can inform future accounting charts. [S02][S04][S05][S08][S17][S31]

### Specific bounded findings

**F01 — Naming has outgrown the data contract.** “Workspace” currently means published-profile analysis. A future private organization view could be confused with it. Proposed remedy: label the existing destination **My published profiles / Published usage**, preserve legacy deep links, and reserve **Private workspace** for a server-authorized tenant. Validate the naming with users before changing global navigation. This is an inference from current copy and source, not measured confusion. [S02][S05][P03]

**F02 — Public community totals are not work allocation.** Profiles can contribute their entire history to more than one crew. Do not import those totals as post-join employee usage, project cost or unique organization spend. A private collector/ledger must supply the replacement scope. [S01][S09]

**F03 — Administration needs new capabilities.** Current owner/member invitations are real; administrator delegation, targeted private invites, suspension/removal and ownership transfer are not in the inspected handler. The proposal extends capability, not merely the form styling. [S08][S09]

**F04 — Selected-audience reporting is a new rule.** Current `org` sharing means any shared team. It is accurately described today. A workspace-selected report must bind one tenant and explicit audience, preserve or explicitly migrate existing links, and never reinterpret a legacy report as narrower than its actual enforcement. [S11][S30]

**F05 — Some share controls need native semantics.** In `docs/leaderboard.html:5824–5829`, scope/options are clickable `div.opt` controls; the inspected handler at `5865–5867` wires click behavior. The public-link switch has its own semantics. Replace the scope/options with fieldset/legend plus native radios/checkboxes. This is a static source finding; a full live keyboard test was not performed. [S11][S30]

**F06 — Sidebar navigation can use real links.** The legacy renderer at `docs/leaderboard.html:1903–1916` builds `div role=link` controls. Real anchors would restore native copy-link, modified-click and new-tab behavior while preserving routing. [S17][S31]

**F07 — Unknown and zero need a typed upstream distinction.** Current Workspace honestly explains that a cost dash can mean zero, hidden or unavailable because the published payload does not distinguish them. Track 2 should not guess a new value. Track 5 must supply statuses; the display then renders the reason. [S05]

**F08 — Session-title publication needs precise language.** The current native option is off by default, and inspected publication code can send the first 80 title characters when enabled. Raw gateway bodies are a different local feature. Exclude both content and session-derived text from the new administrative contract; do not inherit public-profile fields and hide them in CSS. [S12][S13]

**F09 — Existing state handling should be extended.** Empty, error, loading, signed-out, historical and deliberate-public-preview states already exist. Add tenant-denied, role-changed, invitation lifecycle and policy states to that vocabulary. Do not replace it with one spinner or a zero-filled dashboard. [S05][S14][S18][S34]

**F10 — Native and web density require different verification.** Some native Teams labels are explicitly small in SwiftUI source. Web token contrast does not validate native text size. This study specifies an accessible web admin surface and a clear native handoff; a native redesign remains a bounded follow-up. [S16][S32]

## 4. Visual and interaction direction

### Extend Quiet precision

Keep the eclipse mark and horizon seam, locally bundled Hubot Sans for display, JetBrains Mono for technical values, and system text for body/control readability. Maintain Mineral (`#f3f4ef`), Graphite (`#121714`), Forest (`#235e43`) and Signal (`#b6f2cf`) as brand pigments while components use semantic tokens. Provider colors identify providers only; permission and failure states use dedicated semantic roles. [S02][S03][S04]

The proposals use an opaque information canvas, a quiet dark scope rail, strong section titles and a restrained metric hierarchy. Primary scope, audience, period and freshness sit above charts. Dense details are progressively disclosed: first totals and coverage, then provider allocation, then an explicitly authorized member view. Decorative motion does not animate accounting data or interrupt administration.

Use a consistent spacing scale of 4/8/12/16/24/32 px and 44 px minimum interactive targets as a product design rule. Favor 14–16 px body/control text; labels carrying consent or permission meaning must not be tiny metadata. Desktop tables align numbers right and names left. On mobile, move to labeled records, stacked cards and full-width review panels rather than shrinking text.

These are proposed implementation choices aligned with the incumbent system. The boards are precise layout proposals, not screenshots of shipped UI. They embed instances of the repository’s existing Hubot Sans and JetBrains Mono font assets for fidelity; they do not introduce a new font dependency. [S03]

### Measured token contrast, not a conformance claim

The following ratios were calculated in this session from declared hex values using sRGB relative luminance. They do not include opacity, overlays, actual computed styles, focus placement, all chart colors or native controls.

| Declared pair | Calculated ratio |
| --- | ---: |
| `#121714` on `#f3f4ef` | 16.40:1 |
| `#56635a` on `#f3f4ef` | 5.71:1 |
| `#235e43` on white | 7.63:1 |
| `#b6f2cf` on `#151e18` | 13.48:1 |

The values come from `docs/theme.css:3–58`; they support reuse of the palette, not a page-wide accessibility pass. [S04]

### Progressive disclosure rules

1. Always show workspace identity, self/aggregate/named scope, period, currency when relevant, source freshness and completeness.
2. Place provider/model detail under explicit drilldown. Show exact data in an accessible table as well as a chart.
3. Put membership actions in **People**, separate from **Usage**. A roster is not an employee scorecard.
4. Explain a permission before presenting a disabled or denied action. Do not reveal another member’s data or existence just to explain a denial.
5. Keep a visible policy entry in self view: what was contributed, who can view it, and retention.
6. Keep public discovery and voluntary community participation accessible as separate destinations. A scope switch is not a publication action.

## 5. Proposed information architecture

The following route map is **new design**, not an inventory of existing endpoints.

| Proposed destination | Purpose | Required authority |
| --- | --- | --- |
| `/me/published` | Existing owned published-profile experience, with deliberate public preview kept distinct | Existing account ownership/public-preview contracts |
| `/w/:workspaceId/overview` | Private workspace aggregate, coverage and permitted next steps | Active membership + aggregate capability; suppression policy applies |
| `/w/:workspaceId/me` | My attributed work usage | Active membership; subject resolved from current identity |
| `/w/:workspaceId/usage` | Authorized aggregate breakdown | Aggregate capability |
| `/w/:workspaceId/usage/members` | Alphabetical named accounting selector | Aggregate + named capability and policy |
| `/w/:workspaceId/usage/members/:memberId` | A specific member’s work-only accounting | Tenant and member authorization + named capability |
| `/w/:workspaceId/people` | Membership roster and lifecycle | Owner/admin; limited membership facts only for other users |
| `/w/:workspaceId/people/invitations` | Pending/expired/revoked invitation lifecycle | Owner/admin within grantable role range |
| `/w/:workspaceId/settings/access` | Roles, grants, policy and relevant audit | Owner for changes; member-readable current policy summary |
| `/w/:workspaceId/sources` | Work source scope and collection status | Source-specific manage/read capability; no raw credentials |

Keep `/teams`, `/t/:id`, `/u/:handle` and legacy published routes intact. If the existing Workspace label changes, preserve the old route as an alias/redirect to the same published-data behavior. A URL restores a selected context, never authorization.

### Workspace switching

The switcher lists only authorized private memberships and clearly separates links to published profiles and community exploration. For a handful of workspaces, a native select may be sufficient. If searchable, use a proper combobox/dialog pattern with explicit commit; typing or focusing an item does not switch the tenant. [E04]

On commit, clear protected prior content, cancel in-flight work, update the route, resolve current membership/grants, then fetch the new scope. Cache and request keys include principal, tenant, subject, grant revision, policy revision, range and filter contract. A delayed response from the previous workspace must be discarded even if it was valid when sent.

If access disappeared, display a scoped denial and safe destinations. Do not fall back to the first public profile, a different tenant, or an old cached member report. Opening the desktop app from a published web preview continues to mean the viewer’s local app, not remote access to the publisher’s machine. [S05][S14]

## 6. Permission model

### Current versus proposed

**Current:** community team owner/member; public published contributions; owned-profile report controls; any-shared-team `org` report access. These are real existing contracts. [S08][S09][S11][S30]

**Proposed:** three base roles—Member, Workspace admin, Owner—plus explicit usage capabilities. This minimizes role proliferation and makes the sensitive grant visible. “Usage reviewer” and “Attribution reviewer” may be display presets for capabilities, not extra authority inferred from job title.

| Capability | Meaning | Proposed default |
| --- | --- | --- |
| `usage.self.read` | My own attributed workspace usage | Active members |
| `usage.aggregate.read` (**A**) | Permitted aggregate work usage | Explicit grant; not implied by membership administration |
| `usage.member.read` (**N**) | Named member accounting, within the disclosed purpose | Explicit grant in addition to A; no automatic owner/admin access |
| `usage.export` (**E**) | Export already-authorized workspace summaries | Separate grant; named export also requires N |
| `members.manage` | Invite/manage ordinary members | Admin/owner, within role limits |
| `policy.manage` | Change purpose, retention and usage grants | Owner, with versioning, notice and audit |

All capabilities are scoped to one workspace and require current active membership. A service identity used for ingestion is not a human member, and the creator of a service key is not automatically the person responsible for every request. These are proposed product rules based on the inspected identity model and least-privilege guidance. [S10][E05][E06]

### Effective permission matrix

“Grant” below means the server verifies the current explicit grant and policy, not a client-side toggle. N requires A. Small-cohort or differencing-sensitive aggregate results can require N or be suppressed even when A is present.

| Action or data | Visitor / removed | Member | Workspace admin | Owner |
| --- | --- | --- | --- | --- |
| Public community data | Existing public contract | Existing public contract | Existing public contract | Existing public contract |
| Own local/private personal history | Never via team API | Not exposed by team API | Not exposed by team API | Not exposed by team API |
| Own attributed workspace summary | No | Yes | Yes | Yes |
| Aggregate workspace usage | No | A grant | A grant | A grant |
| Named member accounting | No | A + N grant | A + N grant | A + N grant |
| Full administrative roster | No | No; own membership and policy only | Yes | Yes |
| Minimal named selector for accounting | No | With N; no unnecessary contact details | With N | With N |
| Invite Member | No | No | Yes | Yes |
| Invite/promote Admin or Owner | No | No | No | Owner-controlled review; owner acceptance required |
| Suspend/remove ordinary Member | No | No | Yes, within policy | Yes |
| Suspend/remove Admin/Owner | No | No | No | Yes, subject to last-owner protection |
| Grant A/N/E or change retention | No | No | No | Explicit versioned action with notice/audit |
| Export own summary | No | If workspace self-export policy permits | Same | Same |
| Export aggregate / named records | No | A + E / A + N + E | Same | Same |
| View prompts, titles, responses, raw traces, commands or paths | No | No | No | No |
| See another person’s personal workspace | No | No | No | No |
| Transfer ownership / close workspace | No | No | No | Separate reviewed operation; not implemented here |

An owner can authorize themselves to review usage, so this is not a promise that owners can never obtain the data. The difference is that access is explicit, purpose-bound, logged and visible under policy, rather than an invisible consequence of an admin role. For customers requiring separation of duties, dual approval is a later extension; this report does not imply it already exists.

The board personas illustrate combinations: Avery is a Member with self scope; Casey is an Owner with aggregate review; Riley is an Admin with explicitly granted aggregate/named accounting; Jules is a suspended Member. They are fictional and not user accounts.

### Why this split is feasible

Langfuse’s current AI Gateway setup documents a gateway role that can see its own usage without project access, and a default usage-only ingestion mode. This is useful evidence that self scope and minimal collection are practical product patterns. Its broader project roles can include traces/prompts, so copying its role labels would not satisfy Token Horizon’s narrower administrative promise. [E08][E09]

## 7. Membership and invitation lifecycle

### Current community flow to preserve

The existing source supports owner-created reusable bearer invitation links, a 30-day expiry, retirement and selected-team leave. Membership is additive and account-based; owners cannot leave through the current endpoint. The source does not provide the private-role lifecycle specified below. [S08][S09]

### Proposed private invitation flow

1. **Choose workspace and recipients.** Default role is Member. Validate addresses without exposing unrelated account existence. Synthetic examples use `example.test`.
2. **Review effective access.** Show exact workspace, recipients, role, expiry, relevant policy and the fact that no device/history is connected. Invitations do not grant N by default.
3. **Create a bound invitation.** Proposed expiry is seven days. Store token hashes, not recoverable raw invitation credentials in logs. The invitation is single-use and bound to the intended verified identity/recipient policy. An opaque URL token selects a record; it does not itself prove membership.
4. **Preview without side effects.** Opening a link with GET never accepts it; mail scanners or prefetchers must not join. Sign-in is separate from acceptance.
5. **Accept atomically.** Verify intended recipient, unexpired/unrevoked state, workspace availability and the inviter’s current authority. Create one membership, consume the invite and record policy acceptance in one serialized operation.
6. **Select a work source separately.** Joining alone never starts collection, imports historical public totals or publishes anything. Optional local contribution needs an exact-field preview and separate opt-in.

Resend invalidates the prior token. Repeated acceptance is idempotent for the same legitimate membership and does not create duplicates. A role selected when the invitation was sent cannot survive the inviter losing authority. Failed delivery is distinct from invitation creation; a retry does not create unbounded active invitations. Actual email delivery is outside this research and was not attempted.

### Membership transitions

| Transition | Proposed authority and behavior | UI state / recovery |
| --- | --- | --- |
| Invitation → active member | Correct recipient, current grant authority and atomic acceptance | Show role/policy; then optional source setup |
| Active → suspended | Admin for ordinary members; owner for privileged roles | Revoke protected access and future member-source ingestion; explain retained accounting |
| Suspended → active | Authorized restore; re-evaluate grants and source authorization | Do not silently restore expired elevated grants |
| Active/suspended → removed | Authorized removal, last-owner invariant | Clear protected views; revoke sessions/credentials scoped to this membership |
| Active → leave | Member intentionally leaves; owner must satisfy transfer rule | Explain future ingestion stop and historical retention |
| Owner transfer → pending | Owner nominates eligible active recipient | Existing owner remains responsible until acceptance |
| Pending transfer → accepted | Recipient accepts; serialize with demotions/removals | Confirm current owner set and grant changes |
| Returning former member | New membership lifecycle | No automatic resurrection of old invitations or grants |

Role changes carry a membership/policy version. Stale writes receive a conflict and refresh the preview. Last-owner protection must hold under concurrent actions, not only a disabled UI button. Define a server-side authorization ordering point: operations checked after committed removal or revocation are denied. Queued exports and new downloads reauthorize. Clients discard stale responses and clear protected content when the changed grant is known; already authorized/transmitted bytes or downloaded files cannot be recalled. Source/service credentials with a broader lifetime must have explicitly documented reassignment/revocation behavior.

Retained historical records do not confer continued access. Removing a member is not equivalent to deleting their historical accounting; the UI explains the configured retention and deletion process. Conversely, keeping historical accounting is not permission to keep ingesting new activity.

## 8. Self, aggregate and named usage views

### My workspace usage

Resolve the subject from the authenticated principal and selected active membership. Do not accept arbitrary member IDs on a self endpoint. Show only records attributed to work sources explicitly assigned to this workspace. Display audience and retention near the scope header, with access to the actual policy and contributed-field list.

If no records exist, say **No attributed records in this period**. Offer range, source and attribution checks. Never translate missing telemetry into “inactive employee”, “low adoption” or “underperforming”. A connected source can be delayed, unassigned, excluded or unavailable; each is a data condition.

### Workspace aggregate

Start with a bounded overview: period, currency, estimated-versus-billed status, source coverage and aggregate usage. Give provider/model breakdowns and exact-value table access before advanced analytics. Show service/unassigned usage as an explicit bucket when Track 5’s contract supports it; do not allocate it to the key’s owner by assumption.

Aggregates can expose individuals through small cohorts or subtraction. A simple threshold such as five people is only a candidate test fixture, not an anonymity guarantee. Ordinary members get self-only by default. A totals viewer without named authority must not receive identifying small-cohort or differencing results. Track 5 must deliver suppression and filter rules before those aggregate views ship. NIST’s overview supports evaluating disclosure risk and sharing model rather than treating masked names as sufficient de-identification. [E10]

### Named accounting

Use **Workspace usage for Avery Chen** with workspace, purpose, time range, coverage and freshness. A user should never mistake it for their self view. The selector defaults to alphabetical order/search. Cost sorting, if later needed for an explicit accounting task, requires an intentional view and must not become a leaderboard, badge or performance judgment.

Every successful named accounting read/export requires a minimized audit event containing scoped actor/target IDs, authorization outcome, purpose, current and collection-policy revisions, time and request ID, without usage content. Relevant denied attempts record a reason and request ID without leaking foreign-person details. If the mandatory audit cannot be committed, named access fails closed with a recoverable state; the UI may say “Access recorded” only under this contract.

The first release should show provider/model accounting summaries and source provenance, not precise working-hour timelines. No prompts, outputs, titles, local project paths, shell commands, private repository names, heatmap-based attendance claims, productivity ranks, streaks or inferred efficiency scores appear. The same exclusions apply to tooltips, accessibility labels, error strings, exports and background payloads.

### Scope and cost copy examples — proposed

| Situation | Suggested copy |
| --- | --- |
| Own contribution | “My workspace usage · Studio North · Work sources only” |
| Authorized named view | “Workspace usage for Avery Chen · Cost allocation · Access recorded” |
| Estimate | “Estimated model cost · USD · Not a provider invoice” |
| Missing cost basis | “Cost unavailable · No verified price for this scope” |
| Partial sources | “3 of 4 work sources reporting · One source needs attention” |
| Unassigned identity | “Unassigned records · Included in totals where supported” |
| Lost role | “Your access changed. Open your own usage or switch workspace.” |
| No source | “No workspace usage yet. Joining does not connect your device.” |

The numerical examples are synthetic. Exact metric wording and status mappings require Track 5 sign-off.

## 9. Privacy, consent, retention and exports

### Minimum collection contract

Proposed administrative ingestion is an allowlist of tenant/source identity, reporting period, provider/model identifiers, provider-reported numeric usage, cost-status metadata and attribution evidence references. Do not copy the public profile or local trace object into a private workspace and depend on frontend hiding.

Exclude prompts, completions, session titles, raw request/response bodies, tool arguments, shell commands, file paths, private repository names, freeform project strings, credentials and personal account identifiers not required for verified membership. Project allocation may later use explicitly approved opaque IDs and user-controlled aliases; that is not permission to ingest local directory names.

Optional personal-device contribution requires per-workspace/per-source opt-in, a clear destination and audience, field preview, effective date and historical-backfill choice. **Backfill is off by default.** A workspace-managed source may have an organization policy rather than an optional employee consent model; the UI must describe that honestly and must not pretend that employment consent is automatically freely given. This report defines product safeguards, not jurisdiction-specific legal compliance.

Public community sharing remains separate. Neither joining a public crew, signing in, joining a private workspace nor enabling cost accounting turns on public publication or knowledge-graph/context sharing.

### Proposed retention defaults to validate

| Data class | Candidate policy | Important distinction |
| --- | --- | --- |
| Named work summaries | 90 days by default; shorter where sufficient | A different period requires an explicit product/policy decision and visible effective date |
| Eligible non-identifying aggregates | 13 months | Only if re-identification and differencing risks are controlled; otherwise retain under named-data limits |
| Invitation token | Seven-day expiry; single-use | Expiry is enforced server-side; raw tokens never become analytics |
| Generated export download | Maximum 24 hours; reauthorize at download | Revoking download cannot erase a file already downloaded by an authorized recipient |
| Minimal access/role audit | Proposed 90 days pending security/retention review | Store action, scoped actor/target IDs, decision, time and policy revision; no usage content archive |
| Deleted data in backups | Proposed bounded expiry of at most 30 days | This is a design target to prove, not an existing deletion guarantee |

Distinguish **stop future contribution**, **remove access**, **hide a view**, **revoke a share**, **delete retained records** and **expire backups**. They are different operations. Langfuse’s own retention documentation makes a comparable distinction between history that can be viewed and data that is actually deleted. Token Horizon should make its own contract explicit rather than borrowing that vendor’s windows. [E11]

Each retained record and rollup preserves its collection-policy revision, permitted audience and purpose. A later named-access grant cannot override those historical restrictions. Broadening from aggregate-only to named access applies prospectively; historical broadening requires a separate explicit authorization for the precise source, period and new purpose from the appropriate contributor or source authority. Notice alone does not authorize historical access. Existing public-profile title-sharing settings must not override the administrative allowlist.

### Tenant enforcement beyond the screen

Bind verified identity to current membership and grants on every protected operation. Apply the same scope at query, cache, storage, export and asynchronous job boundaries. Client-provided tenant/member IDs are selectors, never authorization. Opaque IDs reduce enumeration but do not replace checks. Private summaries use no shared public cache; sensitive client state is cleared on sign-out, workspace change and privilege loss. [E05][E06]

Choose an atomic storage/serialization approach capable of membership-role-grant changes and last-owner invariants. Current R2-style account CAS is useful precedent, but does not prove atomic multi-principal owner transfer. The implementation may require an authoritative coordinator/transaction boundary; select the mechanism in the backend design review rather than pretending the UI can solve it. [S09]

## 10. Proposed API and component contract

This section is a review interface for engineering and Track 5, not a statement that the endpoints or schema exist.

### Read endpoints

| Proposed endpoint | Server-enforced scope |
| --- | --- |
| `GET /api/workspaces` | Current caller’s authorized private memberships only |
| `GET /api/workspaces/:id/me/usage` | Caller’s own work subject; no arbitrary member selector |
| `GET /api/workspaces/:id/usage` | A grant + suppression/filter policy |
| `GET /api/workspaces/:id/members/:memberId/usage` | Tenant membership + A + N + current purpose/policy + target membership/retention + each record’s collection-policy audience |
| `GET /api/workspaces/:id/members` | Administrative roster scope; separate minimized selector for accounting |
| `GET /api/workspaces/:id/policy` | Member-readable effective audience, fields, purpose and retention |

Mutations for invitation, membership, grants and ownership require explicit commands, idempotency keys where appropriate and expected-version guards. Do not reuse community endpoints with an ambiguous boolean such as `private=true`. Invite preview GET is side-effect free. Exports require E and reauthorization at queue execution and download.

### Synthetic display envelope for Track 5 review

```json
{
  "schema_version": "proposed.track2-display.v1",
  "scope": {
    "kind": "workspace_aggregate",
    "workspace_id": "ws_demo_north",
    "subject": null,
    "policy_revision": 3,
    "grant_revision": 7
  },
  "period": {
    "start": "2026-11-11T00:00:00Z",
    "end_exclusive": "2026-11-18T00:00:00Z",
    "timezone": "UTC"
  },
  "freshness": {
    "as_of": "2026-11-18T08:00:00Z",
    "status": "partial"
  },
  "coverage": {
    "sources_reporting": 3,
    "sources_expected": 4,
    "attribution_status": "partial"
  },
  "metrics": [
    {
      "id": "estimated_model_cost",
      "value": 128.40,
      "currency": "USD",
      "status": "estimated",
      "basis": "rate_card_snapshot"
    },
    {
      "id": "reported_tokens",
      "value": 12800000,
      "status": "reported"
    }
  ],
  "allowed_actions": ["view_provider_breakdown"],
  "retention": { "named_days": 90 },
  "content_fields": "excluded"
}
```

The envelope deliberately omits person data for an aggregate. It does not define the calculation behind cost, token totals, coverage, suppression or attribution. Track 5 must approve the vocabulary and replace provisional fields as needed. In production, `allowed_actions` informs the UI but does not replace endpoint enforcement. Unknown metrics carry `value: null` with a reason/status; an error never masquerades as numerical zero.

### Source-aware implementation seams

| Current file(s) | Proposed change boundary |
| --- | --- |
| `docs/workspace.js`, `docs/workspace.css` | Preserve published view. Extract reusable scope header, metric/status and table patterns before introducing private data. |
| `docs/leaderboard.html` | Preserve account-revision invalidation and focus restoration. Add distinct private route mounting; replace legacy pseudo-links and share scope divs with native controls. |
| `docs/team-invites.js` | Preserve community crew behavior. Extract generic accessible dialog/state primitives; do not silently change reusable crew invitations into targeted private invites. |
| `docs/theme.css`, `docs/horizon-system.css`, `docs/icon-actions.js` | Reuse semantic themes and original action primitives. Add only genuinely new semantic states. |
| `cloudflare/src/team-invites.js` | Keep existing public community contract and current account-CAS behavior. Do not treat current owner/member as complete private RBAC. |
| `cloudflare/src/index.js` | Route new private handlers through verified identity; selected-audience reporting needs an explicit versioned contract. |
| **New, proposed:** `cloudflare/src/workspaces/authorization.js`, `membership.js`, `usage-view.js` | Isolated tenant authorization, lifecycle and allowlisted display responses. Paths are recommendations, not existing files. |
| **New, proposed:** `docs/workspace-context.js`, `docs/workspace-people.js` | Scope navigation and member management with explicit current-authorization states. Avoid another large inline renderer. |
| `clients/macos/.../App/WebDestination.swift` | Preserve safe web handoff. Add private destinations only after the web contract is verified; never infer membership from a local team label. |
| `scripts/test-workspace-ui.mjs`, `scripts/test-team-invites-ui.mjs` | Reuse synthetic fixtures and regression style. Add tenant/capability, lifecycle and stale-response cases, without weakening existing tests. |

A framework migration is not required to obtain the first improvements. The current vanilla JavaScript/CSS/SVG stack can support the bounded shell and controls. Evaluate larger restructuring against actual maintainability/performance evidence, not as a prerequisite for drawing the proposed screens. [S02][S04][S05][S08][S14][S18][S34]

## 11. Annotated wireframe specification

The PDF is the visual reference for these proposals. It is a static review artifact: no button sends email, changes access or queries real data. Page labels explicitly say **PROPOSED UI · SYNTHETIC DATA**.

| Board | What it resolves | Key states / requirements |
| --- | --- | --- |
| **01 — Workspace overview** | Aggregate first; persistent private scope and date; coverage precedes chart interpretation | Partial reporting; estimated cost; authorized next steps; no employee ranking |
| **02 — People** | Membership management separate from Usage | Member/Admin/Owner; active/suspended; pending invitations tab; alphabetical records; explicit usage grant |
| **03 — Named accounting** | Clearly identifies the other person and purpose | A + N gate; work-only records; source coverage; separate self endpoint |
| **04 — Scope switching / self view** | Private workspaces distinct from published profiles/community | Explicit selection, no prior-tenant flash, policy entry, separate source opt-in |
| **05 — Invite and accept** | Review before sending; invitee understands role and policy | Targeted recipient, Member default, seven-day proposed expiry, no automatic collection |
| **06 — Lifecycle dialogs** | Suspend, remove and transfer explain consequences | Last-owner protection, atomic changes, retained-history explanation, reason/audit |
| **07 — Mobile** | Same permissions with stacked layouts | Self, aggregate, People and access-changed states; readable labels and touch controls |
| **08 — State board** | Trustworthy loading/empty/error/denied language | No fake zeros, no inactivity inference, stale snapshot recovery, cached-data clearing |
| **09 — Data and access policy** | Audience, excluded fields and retention are inspectable | Explicit grants; proposed retention defaults; minimal audit; policy revision |

### Desktop behavior

Use one scope rail and a 55–64 px top context bar; the scope header survives drilldown. Main panels prioritize one decision per area. Tables may scroll within their own container; the document does not widen because of a long email or name. Expanded detail is a route or a properly named panel with a predictable back destination. Table sorting persists only within the same authorized scope.

### Mobile behavior

At narrow widths, replace the rail with a labeled workspace switcher and menu. Stack member records with clear role/state labels; keep the action menu at least 44 px in both dimensions. Use full-screen review sheets or dialogs for complex invites/role changes, with visible cancel and final review. Place sticky actions so focus and validation messages remain visible. Date/coverage labels remain in the first screenful where feasible.

Board 07 is a design at a compact phone-like width, not proof of a production viewport test. Implementation must also handle 320 CSS px reflow, 200% text enlargement and 400% browser zoom where applicable.

## 12. Required state model

| State | Display | Allowed next action / guard |
| --- | --- | --- |
| Checking identity | Named checking step; no account values | Complete verification; no public fallback |
| Loading memberships | Skeleton/status for authorized scope discovery | Retry bounded read; do not imply no memberships |
| Choosing scope | Authorized choices with role | Explicit commit; no selection on focus |
| Loading usage | Current scope + skeleton, no old numbers | Cancel/discard old requests |
| No workspace | Explain creation/invitation path | Create only if eligible; no accidental public team conversion |
| Member, no source | Explain joining versus collecting | Review approved source setup |
| No attributed records | Explain selected range/coverage | Review sources; never label person inactive |
| Filter no-match | Show active filters and clear action | Clear search/filter without clearing authorization |
| Partial | Preserve valid included data; identify missing category | Scoped retry/details; Track 5 reason code |
| Stale | Last successful as-of time; uncertainty | Refresh same scope; no fake live badge |
| Read error | Name failed stage, safe recovery | Retry; preserve only legitimate non-sensitive state |
| Denied / revoked | Clear protected payload; explain access changed | Own usage or authorized scope switch |
| Invite pending | Recipient, role, expiry, delivery state | Revoke/resend within current authority |
| Invite expired/revoked | Cannot join; request fresh invitation | Do not automatically broaden or restore |
| Wrong account | Explain intended-account requirement without leaking unnecessary details | User chooses supported sign-in path |
| Concurrent role change | Updated effective access summary | Review refreshed version; no stale overwrite |
| Pending mutation | Specific action in progress, cancel rules | Avoid optimistic privilege claims |
| Mutation failure | Action not confirmed; reconcile actual state | Idempotent retry after state read |

Apply status semantics consistently in page text, ARIA announcements and API codes. An announcement does not routinely move keyboard focus. Existing source handling provides a starting point for checking/loading/empty/error states. [S05][S18][S34]

## 13. Accessibility and performance acceptance

**Target:** WCAG 2.2 AA for the implemented web flows, plus Token Horizon’s 44 px interaction rule. This report does not claim present conformance. The AA target-size criterion uses 24 × 24 CSS px with exceptions; 44 × 44 is the stronger product rule. Verify normal text at 4.5:1, qualifying large text and essential non-text cues at 3:1, reflow, focus visibility and accessible authentication. [E01][E02][E03]

Use native semantic controls where possible: anchors for navigation, radios for one-of-many scope, checkboxes for options and tables with headers for accounting. An icon’s accessible name belongs to its button/link, and help must remain available without hover. Permission meaning cannot depend only on color.

Modal invite/removal/transfer views move focus inside, constrain the tab sequence, make background content inert, support cancel/Escape appropriately and restore focus to a valid opener. Preserve the existing fallback focus manager when an opener was replaced. Latency-sensitive tabs use manual activation rather than triggering requests while users arrow through choices. [E04][E07][E12][S17][S31]

Proposed verification includes keyboard-only completion, VoiceOver/Safari and NVDA with a supported browser, actual version recording, long names, RTL-safe layout where supported, 320 px reflow, 200% text zoom, 400% browser zoom, high contrast, reduced motion and error announcements. Screenshot review alone is insufficient.

Performance work should extend existing bounded chart/runtime behavior and repository test budgets. Scope switching clears old content immediately, then shows a truthful loading state. Avoid fetching all members or all historical records merely to render an aggregate. Use bounded pagination and authorized query limits. Do not introduce polling that resembles an employee presence monitor. These are performance/security design requirements, not measured latency claims. [S02][S18][S34][S29]

## 14. Prioritized, backlog-ready work

**Priority meaning:** P0 is a prerequisite to making the proposed private-data promise; it does not mean a proven production emergency. P1 is the first useful pilot experience after those prerequisites. P2 is expansion after validation. Effort is a directional engineering estimate for an experienced contributor, excluding the deeper Track 5 collection/ledger work. Dependencies, code extraction, review and shared QA overlap, so do not add the estimates into a delivery commitment.

### Existing issue and PR reconciliation

| Existing record | Verified status/date | How this study uses it |
| --- | --- | --- |
| [#12](https://github.com/castlemilk/token-horizon/issues/12) | Open, 11 Nov 2026 | Canonical umbrella: THR-02 current contract, THR-08 private allocation, THR-13 daily view, THR-25 publication preview, THR-32 private collaboration |
| [#13](https://github.com/castlemilk/token-horizon/issues/13) | Open, 11 Nov | Truthful data/provenance/state presentation; do not duplicate metric semantics |
| [#23](https://github.com/castlemilk/token-horizon/issues/23) | Open, 17 Nov; updated 18 Nov | Shared rendered/mobile/accessibility/state/performance verification gate |
| [#18](https://github.com/castlemilk/token-horizon/issues/18), [#19](https://github.com/castlemilk/token-horizon/issues/19) | Open, 17 Nov; updated 18 Nov | Public rendering and pricing-state vocabulary; historical access errors are not assumed current |
| [#21](https://github.com/castlemilk/token-horizon/issues/21), [#22](https://github.com/castlemilk/token-horizon/issues/22) | Open, 17 Nov | Honest setup/activation and private/public discovery boundaries |
| [#26](https://github.com/castlemilk/token-horizon/issues/26), [#36](https://github.com/castlemilk/token-horizon/issues/36) | Open, 17 Nov | Test manifest/fixture organization; extend existing suite |
| [PR #2](https://github.com/castlemilk/token-horizon/pull/2) | Merged 8 Oct | Focus restoration is already present; preserve it |
| [PR #3](https://github.com/castlemilk/token-horizon/pull/3) | Merged 8 Oct | Historical source/deployment reconciliation; not proof of today’s deployment SHA |
| [PR #5](https://github.com/castlemilk/token-horizon/pull/5) | Merged 8 Oct | Current MCP usage labels and estimate provenance are precedent |
| [PR #8](https://github.com/castlemilk/token-horizon/pull/8) | Merged 24 Oct | Managed sign-in exists in current gated source; older login concepts are incomplete history |
| [PR #11](https://github.com/castlemilk/token-horizon/pull/11) | Merged 5 Nov | Refresh/reconnect semantics already exist; do not invent silent recovery |
| [PR #24](https://github.com/castlemilk/token-horizon/pull/24) | Closed unmerged 17 Nov | Closing is not shipping; superseded analytics draft |
| [PR #25](https://github.com/castlemilk/token-horizon/pull/25) | Open draft, 17 Nov | Homepage-only, default-disabled analytics proposal; excludes account/dashboard telemetry; not evidence of measured team use |
| [PR #45](https://github.com/castlemilk/token-horizon/pull/45) | Open draft, 17 Nov | Animation-test work; not assumed in main or deployed |

All 31 open regular issue IDs at read time: **#12–16, #18–23, #26–44, #46**. There were no closed regular issues. All 15 PRs were inventoried; twelve were merged, #24 was closed/unmerged, and #25/#45 were drafts. No issue was created or updated by this study. [S26][S27]

### Proposed review units

| Draft ID | Priority and outcome | Existing mapping | Dependency / effort / material risk |
| --- | --- | --- | --- |
| **T2-01** | P0: scope vocabulary and private-data contract | #12 THR-02/08/32 | Track 5 identity/attribution; 3–5 days; risk of relabeling public history as private work |
| **T2-02** | P1 now: native links and accessible share choices | #23, #12 THR-02 | Preserve #2 focus behavior; 2–4 days; regression in auth/dialog flows |
| **T2-03** | P0 for private pilot: tenant authorization, grants and atomic membership authority | #12 THR-08/32; bounded child candidate | Verified identity, storage serialization; 2–4 weeks; cross-tenant and stale-grant exposure |
| **T2-04** | P1: authorized scope switcher and self/team shell | #12 THR-13/32 | T2-01/03; 5–8 days; prior-scope cache flash |
| **T2-05** | P1: targeted private invitations and People roster | #12 THR-32; child candidate | T2-03; 1–2 weeks; invite reuse/wrong-account/escalation |
| **T2-06** | P1: role changes, suspension, removal and ownership transfer | #12 THR-32; child candidate | T2-03/05; 1–2 weeks; owner orphaning and residual access |
| **T2-07** | P1: self and aggregate work-usage presentation | #12 THR-08/13, #13 | Track 5 approved envelope + suppression; 5–8 UI days after API; false confidence from partial data |
| **T2-08** | P2: purpose-bound named accounting | #12 THR-08/13/32, #13 | A/N grants, notice, Track 5 attribution; 5–8 UI days after API; surveillance/inference and identity ambiguity |
| **T2-09** | P0 before private report sharing: exact workspace audience and preview | #12 THR-25/32; #16 cross-link only | Existing any-team semantics/migration; 1–2 weeks; accidental broadening of existing links |
| **T2-10** | P0: inspectable contribution, retention and deletion policy | #12 THR-02/25/32 | Collection design, privacy/backup behavior; 3–5 days UI/spec plus backend; promising deletion that is only hiding |
| **T2-11** | P1: shared states, mobile density and Quiet precision components | #12 THR-13, #13, #23 | Reuse current tokens/actions; 4–7 days; inconsistent authority/state presentation |
| **T2-12** | P0 gate / P1 implementation: role/state/device acceptance suite | #23, #26, #36 | Completed slices + synthetic fixtures; 5–8 days incremental; untested lifecycle races |

### Backlog-ready acceptance by review unit

**T2-01 — Private scope contract.** Document immutable person, published profile, public crew, private workspace, source identity and service identity separately. State which historical records can enter a workspace and who authorizes them. Two overlapping public teams must not grant private access or produce a unique-cost sum. Acceptance: tests A01/A02/A06/A26 and Track 5 contract review.

**T2-02 — Concrete accessibility repair.** Replace the inspected pseudo-links and share-option divs with semantic elements; retain current routes, checked state, names and opener restoration. Acceptance: keyboard activation, modified-click/copy-link and dialog tests A18/A19; source diff limited to relevant primitives. No new metrics or telemetry.

**T2-03 — Server authority.** Define workspace membership/grant revisions, deny-by-default query paths and atomic owner/lifecycle invariants. Administration and named usage are separate capabilities. Acceptance: cross-tenant/member substitution, stale role, cache, export and concurrent-owner cases A01–A05/A10/A12/A13.

**T2-04 — Scope shell.** Render only scopes from current server authority. Switching clears old protected content before loading; route state is not permission. Acceptance: slow old response cannot repaint new tenant, sign-out clears private state, public fallback never occurs, focus returns correctly. Tests A04/A05/A18.

**T2-05 — Private invitation flow.** Member default, recipient binding, expiry/revoke/resend, review screen and side-effect-free preview. Keep existing crew links working under their original contract. Acceptance: A07–A09 plus per-recipient validation, pending/delivery-failed distinction and narrow-mobile completion.

**T2-06 — Lifecycle management.** Support suspended/removed/returning states and accepted ownership transfer. No optimistic success before confirmed server result. Acceptance: last-owner concurrency, invitation authority after demotion, session/export invalidation and retained-history copy A09–A13/A17.

**T2-07 — Useful self/aggregate view.** Render Track 5’s status envelope with coverage, source time, cost basis and accessible values. Self subject is server-derived. Acceptance: known zero, unknown, stale and partial remain distinct; suppressed results do not expose named values; no productivity interpretations. Tests A02/A14–A16/A20.

**T2-08 — Named accounting.** Provide alphabetical selector and work-only member drilldown with purpose/audience notice. There is no leaderboard or minute-level work timeline. Acceptance: no N means no named payload, hidden prefetch, export or accessibility-label disclosure; sensitive-field fixture is absent from all serialized outputs. Tests A03/A06/A12/A15/A26/A27.

**T2-09 — Selected audience.** Bind the report to one selected workspace/audience/version; preview exact fields, identities, expiry and download consequences. Existing any-team links remain explicitly legacy or are deliberately migrated/revoked. Acceptance: unrelated shared-team membership grants nothing; leaving revokes access; no legacy link is silently broadened or described falsely. Tests A11/A12.

**T2-10 — Contribution and retention.** Show per-source optional opt-in, future-only default, audience and actual retention. Stop-contribution and deletion are separate operations. Acceptance: joining uploads no history; retained records expire from primary/derived caches and backups per tested policy; a UI date filter is not called deletion. Tests A06/A13/A17.

**T2-11 — Responsive state system.** Implement the board vocabulary in shared components using existing semantic themes. Preserve scope and controls at narrow widths; no decorative data. Acceptance: every fixture in section 12 has coherent desktop/mobile rendering; keyboard and assistive technology can complete actual tasks. Tests A18–A22.

**T2-12 — Verification gate.** Extend the authoritative test manifest and existing fixtures rather than copying a second generic suite. Record source SHA, device/browser/AT version and actual outcome for each runtime test. Acceptance: all P0 security fixtures pass before private pilot; scope-specific a11y regressions pass; performance budgets remain intact. Existing issues remain open until their full scope is satisfied.

### Recommended sequence

**First review increment:** T2-01 and T2-02. They establish vocabulary and address concrete current-source accessibility/navigation gaps without requiring a new analytics platform.

**Private self/aggregate pilot:** T2-03/04/05/06/07/10/11 with T2-12 gates. Restrict initial scope to explicitly enrolled work sources and current authorized users. If Track 5 cannot establish reliable attribution/coverage, ship the truthful setup/self states and keep aggregate/named claims unavailable.

**Named accounting and private sharing:** T2-08/09 after purpose, audience, source attribution, retention and inference controls are reviewed. Wider collaboration remains tied to THR-32’s existing demand/operational validation rather than assumed enterprise expansion.

## 15. Acceptance test catalog

These are **recommended tests, not executed tests**. Use two synthetic workspaces, multiple identities, service records, expired grants and deterministic delayed responses. No production invite or private history is needed.

| ID | Priority | Given / action | Required result |
| --- | --- | --- | --- |
| A01 | P0 | Caller in North requests West IDs through path, body, filter, export and cache | No West values, names or counts; uniform authorized failure |
| A02 | P0 | Member calls self endpoint with another member selector | Server ignores/rejects arbitrary subject; only verified self can be returned |
| A03 | P0 | Admin/Owner without N requests named usage, selector, prefetch or export | Denied; role administration does not imply usage access |
| A04 | P0 | North read is delayed; viewer switches to West | North content is cleared immediately and late response is discarded |
| A05 | P0 | Revoke N before the final authorization check; separately test revocation after an already authorized response | Later-checked operations deny; jobs/downloads reauthorize; informed clients discard/clear stale data. Already transmitted bytes are not claimed recallable |
| A06 | P0 | Local fixture contains prompt/title/path/command fields; member joins workspace | No history imported on join; forbidden fields absent from payloads, logs, previews, exports and ARIA text |
| A07 | P0 | Link scanner GETs invite repeatedly | No membership or consent change |
| A08 | P0 | Expired, revoked, replayed, wrong-account or replaced invite is accepted | No unauthorized membership; clear safe recovery without enumeration |
| A09 | P0 | Inviter is demoted after sending; recipient accepts | Current grant authority checked atomically; old invitation cannot elevate |
| A10 | P0 | Two owners concurrently remove/demote each other | At least one active owner remains; stale operation conflicts |
| A11 | P0 | Report owner and recipient share another public crew but not selected private workspace | Private report denied; legacy scope not silently reinterpreted |
| A12 | P0 | Authorized export is queued, then member removed or policy narrowed | Reauthorize generation and download; no public cache or surviving unauthorized URL |
| A13 | P0 | Member suspended/removed; retrying client or service sends new events | Membership-bound collection/read stops; separately owned service policy is explicit |
| A14 | P0 | Data has true zero, absent price, hidden value, partial source and stale snapshot | Distinct states; no conversion of error/unknown to zero or invoice |
| A15 | P0 | Small cohort, overlapping filters, adjacent windows or self-subtraction can isolate a colleague | Suppress/coarsen or require disclosed named authority; no “anonymous” claim |
| A16 | P1 | Shared service key has multiple operators and no verified person attribution | Service/Unassigned bucket; key creator is not assigned all usage |
| A17 | P0 | Retention deadline passes; member leaves; later rejoin occurs | Actual retained-data policy enforced; old grants not resurrected; accessible history is not confused with deletion |
| A18 | P1 | Keyboard-only switch, invite, role change, cancel and back navigation | Visible focus; correct names; no unexpected tenant change; opener restored |
| A19 | P1 | Native radio/checkbox/link replacements and modal background | Checked state exposed; correct keyboard semantics; background inert; valid cancel |
| A20 | P1 | Screen reader reads chart/estimate/partial states and exact values | Meaning conveyed without color/hover; status announced without focus churn |
| A21 | P1 | 320 px layout, text enlargement, zoom, long names and mobile keyboard | No lost scope, hidden action or document-wide overflow; controls usable |
| A22 | P1 | Reduced motion or missing chart/decorative runtime | Static useful state remains; no animation needed to interpret usage |
| A23 | P1 | Failed role mutation with uncertain network result | Read authoritative state before retry; no falsely optimistic grant |
| A24 | P1 | Successful empty account versus failed identity/profile discovery | Distinct state and recovery; no public/default-profile substitution |
| A25 | P1 | New private UI added to existing fixture manifest | Existing current-team, profile/focus and animation budgets still pass; no parallel duplicate harness |
| A26 | P0 | Grant N today and request yesterday’s records collected under aggregate-only terms | Named results remain denied unless a separate valid source/period/purpose authorization permits historical broadening; notice alone is insufficient |
| A27 | P0 | Successful named read/export, denied attempt and audit-service failure | Minimized events are committed as specified; no content or foreign-person leak; mandatory-audit failure blocks named access |

### Proposed usability study, not yet conducted

Use synthetic workspaces and five representative participants per major role segment as an initial formative study, not a statistical efficacy claim. Ask them to identify current scope, distinguish public from private data, invite a Member, explain the recipient’s access, find their own work usage, diagnose a missing source and explain what removal does. For authorized reviewers, ask why a named member view is available and which fields are excluded. Record task errors and misunderstandings; do not instrument real employee activity or contact participants during this research.

Suggested exit criteria: no participant mistakes community history for organization-attributed spend; no participant believes joining publishes data; no participant mistakes estimated cost for an invoice; no critical keyboard/authorization failure. Quantitative time targets should follow a baseline study rather than invented before/after claims.

## 16. Cross-track dependency contract

| Track | This study needs | This study supplies | Release dependency |
| --- | --- | --- | --- |
| **1 — Market** | Validated team accounting job, buyer/user distinction and acceptable privacy model | Bounded self/aggregate/named concept and operational cost implications | Demand gates for broad private collaboration; no price recommendation here |
| **3 — Knowledge graph** | Separate content ownership and reviewed sharing model | Explicit rule that membership/usage grants do not expose context or prompts | No automatic context inheritance from workspace join |
| **4 — SEO** | Public route/canonical policy and private-page indexing exclusions | Proposed route boundaries and preserved legacy aliases | Authentication protects private data; robots rules do not |
| **5 — Analytics** | Typed metric/cost status, identity/attribution, coverage, correction times, dedupe, windows, suppression/differencing | Scope/role matrix, display envelope, missing-state fixtures, exact drilldown needs | Blocking dependency before private aggregate/named claims |
| **6 — Token/context** | Reported/inferred/missing token definitions and provider limits | UI exclusion of prompt/context content; progressive detail only when permitted | Do not relabel token volume as quality, productivity or context understanding |

### Questions to resolve with Track 5 before implementation

1. What is the immutable attribution key: verified human membership, source account, service identity, project allocation or a combination? What evidence supports each mapping?
2. How are pre-join events, late arrivals, corrections, reassigned sources and rejoined memberships handled without rewriting historical ownership silently?
3. Which cost basis is shown, and which are explicitly non-additive: provider bill, rate-card estimate, subscription allocation, quota or API equivalent?
4. What exactly does “sources reporting” mean, and what is the status when expected sources are unknown?
5. How do unknown, hidden, suppressed, unavailable and measured zero differ in the API?
6. Which aggregate queries can isolate an individual, and how are repeated/overlapping queries controlled?
7. Which daily/date/timezone contract is stable across web, native and exports?
8. How do deletion and retention propagate into aggregates, corrections, cached results and downloaded exports?

The study documents these handoffs. It does not claim coordination or acceptance by the other independent research tracks.

## 17. Verification performed for this deliverable

**Performed:** repository/source reads at the recorded SHA; current issue/PR inventory; comparison with existing project research; bounded public desktop UI interactions (navigation, public row expansion, synthetic search); primary-source checks; four static color-pair calculations; generation and rendering of all nine PDF boards; visual review of the contact sheet and full-size key boards; artifact content/link/privacy checks.

**Not performed:** installation/build/runtime tests of Token Horizon; native app interaction; production sign-in, permissions or invitations; API mutation or exploit testing; live data retention/deletion tests; full keyboard/screen-reader/mobile conformance audit; production performance or business-outcome measurement; user usability sessions. Static visual quality does not establish interactive correctness or accessible PDF conformance.

The current source already contains relevant fixture coverage; this study inspected it rather than claiming a fresh pass. Recommended acceptance tests are deliberately labeled unexecuted. The proposed screens are original authored vectors using synthetic examples, and no actual profile screenshot, private prompt, secret, account token or usage record is included in the review bundle.

## 18. Evidence register

Repository sources below are pinned to the same immutable SHA. Line anchors identify the inspected code regions; URLs remain usable even if main changes. Source statements and public observations remain separate.

### Repository and project sources

- **S01 — README / public product and team contribution semantics.** `README.md`, especially public links and lines 199–201. [Pinned file](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/README.md).
- **S02 — Current design contract.** `DESIGN.md`, purpose/ownership/states and interaction rules. [Pinned file](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/DESIGN.md).
- **S03 — Design-system specification and fonts.** `token-horizon-design-system/DESIGN_SYSTEM.md`; `docs/fonts/HubotSansVF-Regular.ttf`, `docs/fonts/JetBrainsMono-Regular.ttf`. [Specification](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/token-horizon-design-system/DESIGN_SYSTEM.md).
- **S04 — Runtime theme/action primitives.** `docs/theme.css:3–58`, `docs/horizon-system.css`, `docs/icon-actions.js`. [Theme](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/theme.css#L3-L58), [actions](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/icon-actions.js).
- **S05 — Workspace render and states.** `docs/workspace.js:69–149,152–196,233–320`, `docs/workspace.css`; controller `docs/leaderboard.html:3328–3408`. [Renderer](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/workspace.js), [controller](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L3328-L3408).
- **S06 — Teams directory/detail.** `docs/leaderboard.html:5221–5390,5466–5489,5565–5620`; `docs/teams.css`. [Source region](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L5221-L5620).
- **S07 — Model costs/report-settings routes.** `docs/leaderboard.html:5624–5741`. [Pinned region](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L5624-L5741).
- **S08 — Team management/invite UI.** `docs/team-invites.js:78–102,215–273`; `docs/leaderboard.html:3181–3298`. [UI](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/team-invites.js), [controller](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L3181-L3298).
- **S09 — Authoritative community membership.** `cloudflare/src/team-invites.js:1–12,187–251,254–398`. [Pinned file](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/team-invites.js).
- **S10 — Browser identity/authentication.** `cloudflare/AUTH.md:1–19,65–76,93–136`; owned profile discovery `cloudflare/src/index.js:839–861`. [Auth](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/AUTH.md), [profile authority](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js#L839-L861).
- **S11 — Sharing enforcement and UI.** `cloudflare/src/index.js:2542–2583`; `docs/leaderboard.html:5785–5870`. [Enforcement](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js#L2542-L2583), [UI](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L5785-L5870).
- **S12 — Native publication option/default.** `clients/macos/Sources/TokenHorizon/UI/DashboardTabs.swift:2282–2293`; `.../Persistence/SettingsStore.swift:53`. [Control](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/UI/DashboardTabs.swift#L2282-L2293), [default](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Persistence/SettingsStore.swift#L53).
- **S13 — Published title emission.** `clients/macos/Sources/TokenHorizon/Leaderboard/LeaderboardStore.swift:893`; display `docs/workspace.js:233–235`. [Publisher](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Leaderboard/LeaderboardStore.swift#L893).
- **S14 — Private caching/account races.** `docs/leaderboard.html:1512–1573,1605–1637`. [Pinned region](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L1512-L1637).
- **S15 — Current product truth.** `PRODUCT.md:13–43`; `LEADERBOARD.md:662–689` and older presentation section `195–199`. [Product](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/PRODUCT.md), [community contract](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/LEADERBOARD.md#L662-L689).
- **S16 — Native Teams and web handoff.** `clients/macos/Sources/TokenHorizon/UI/TeamsViews.swift:1–175`; `.../App/WebDestination.swift:3–89`. [Teams](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/UI/TeamsViews.swift), [handoff](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/App/WebDestination.swift).
- **S17 — Navigation and focus.** `docs/leaderboard.html:1894–1916,5942–5984`. [Navigation](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L1894-L1916), [focus](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L5942-L5984).
- **S18 — Existing synthetic UI tests.** `scripts/test-workspace-ui.mjs`, `scripts/test-team-invites-ui.mjs`, `scripts/test-team-flow-ui.mjs`. [Workspace](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/test-workspace-ui.mjs), [invites](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/test-team-invites-ui.mjs). Inspected, not run.
- **S19 — Historical concepts.** `token-horizon-wireframes-images/REVIEW.md`, `design/login-uplift/README.md`, `design/profile-uplift/README.md`. [Historical review](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/token-horizon-wireframes-images/REVIEW.md). Text/provenance inspected; older pixels not used as current-state proof.
- **S20 — Existing usage-label precedent.** `mcp/ui/overview.js:25–97`. [Pinned file](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/mcp/ui/overview.js).
- **S24 — Project context.** [Token Horizon Space root](https://chatgpt.com/space/page_6af3b3f3a6308191a3b0fed46bc74230), research baseline 11 November 2026; current read 18 November.
- **S25 — Existing 32-item roadmap.** [Roadmap and validation backlog](https://chatgpt.com/space/page_896b1fdbd8888191812bca8ea37b72c0); [issue #12](https://github.com/castlemilk/token-horizon/issues/12). Proposed learning/implementation work, not shipped claims.
- **S26 — Complete current issue inventory.** [All-state issue endpoint](https://api.github.com/repos/castlemilk/token-horizon/issues?state=all&per_page=100&page=1&sort=created&direction=desc), read 18 November; individual issue links in section 14.
- **S27 — Current PR inventory.** [All-state PR endpoint](https://api.github.com/repos/castlemilk/token-horizon/pulls?state=all&per_page=100), read 18 November.
- **S28 — Relevant merged/historical PRs.** [#2](https://github.com/castlemilk/token-horizon/pull/2), [#3](https://github.com/castlemilk/token-horizon/pull/3), [#5](https://github.com/castlemilk/token-horizon/pull/5), [#8](https://github.com/castlemilk/token-horizon/pull/8), [#11](https://github.com/castlemilk/token-horizon/pull/11); merge dates/status in section 14.
- **S29 — Verification and animation work.** [#23](https://github.com/castlemilk/token-horizon/issues/23), [#26](https://github.com/castlemilk/token-horizon/issues/26), [#27](https://github.com/castlemilk/token-horizon/issues/27), [#36](https://github.com/castlemilk/token-horizon/issues/36), [#44](https://github.com/castlemilk/token-horizon/issues/44), [draft PR #45](https://github.com/castlemilk/token-horizon/pull/45).

- **S30–S34 — Direct subreferences.** S30 is the server sharing enforcement region linked under S11; S31 is the focus manager under S17; S32 is the web handoff under S16; S33 is merged PR #8; S34 is the invitation test file under S18. These direct references prevent a grouped label from pointing only to a neighboring UI file.

### Public product observations

- **P01:** [Canonical landing page](https://token-horizon.dev/). Browser-rendered visual/AX inspection and web text read on 18 November 2026. Sample tour recognized as illustrative; no download/install performed.
- **P02:** [Teams](https://token-horizon.dev/teams). Browser-rendered standings, expanded row and synthetic no-match search observed. Actual identities/metrics not reproduced; no team created/joined/changed.
- **P03:** [Workspace entry](https://token-horizon.dev/leaderboard.html?view=dashboard). Signed-out state inspected; no authentication performed. Browser rendered it while web text retrieval could not access that URL.
- **P04:** [Product documentation](https://token-horizon.dev/docs/). Read as corroborating public documentation; implementation and current source take precedence where old copy conflicts.

### External primary sources

- **E01:** W3C, [WCAG 2.2](https://www.w3.org/TR/WCAG22/), retrieved version identifies Recommendation dated 12 December 2024; accessed 18 November 2026.
- **E02:** W3C, [Understanding Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum), accessed 18 November 2026.
- **E03:** W3C, [Understanding Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow), accessed 18 November 2026.
- **E04:** W3C APG, [Combobox Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/), accessed 18 November 2026.
- **E05:** OWASP, [Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), accessed 18 November 2026. Used for least privilege, default deny and per-request enforcement principles.
- **E06:** OWASP, [Multi-Tenant Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html), accessed 18 November 2026. Used for verified tenant context and cross-layer isolation principles.
- **E07:** W3C APG, [Modal Dialog Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) and [Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/), accessed 18 November 2026.
- **E08:** Langfuse, [AI Gateway team setup](https://langfuse.com/docs/gateway/get-started/admin-setup), accessed 18 November 2026; page describes beta capability, not a Token Horizon feature.
- **E09:** Langfuse, [Role-Based Access Controls](https://langfuse.com/docs/administration/rbac), accessed 18 November 2026. Role names are not adopted as equivalent permissions.
- **E10:** NIST, [De-Identifying Government Datasets: Techniques and Governance](https://www.nist.gov/publications/de-identifying-government-datasets-techniques-and-governance), SP 800-188 publication overview, created 14 September 2023 and updated 18 November 2024; accessed 18 November 2026. Overview only; full report not inspected.
- **E12:** W3C APG, [Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/), accessed 18 November 2026.
- **E11:** Langfuse, [Data Retention](https://langfuse.com/docs/administration/data-retention), accessed 18 November 2026; used only for the distinction between access windows and deletion, not its commercial plans or exact retention settings.

---

**Review decision requested by this specification, not an action taken:** accept the scope/permission contract, choose a bounded private self/aggregate pilot, and preserve named accounting/private sharing as separately gated work. The artifacts are ready for review; all implementation, publication and production-change holds remain intact.

[S01]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/README.md
[S02]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/DESIGN.md
[S03]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/token-horizon-design-system/DESIGN_SYSTEM.md
[S04]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/theme.css
[S05]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/workspace.js
[S06]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L5221-L5620
[S07]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L5624-L5741
[S08]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/team-invites.js
[S09]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/team-invites.js
[S10]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/AUTH.md
[S11]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L5785-L5870
[S12]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/UI/DashboardTabs.swift#L2282-L2293
[S13]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/Leaderboard/LeaderboardStore.swift#L893
[S14]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L1512-L1637
[S15]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/PRODUCT.md
[S16]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/UI/TeamsViews.swift
[S17]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L1894-L1916
[S18]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/test-workspace-ui.mjs
[S19]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/token-horizon-wireframes-images/REVIEW.md
[S20]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/mcp/ui/overview.js
[S24]: https://chatgpt.com/space/page_6af3b3f3a6308191a3b0fed46bc74230
[S25]: https://chatgpt.com/space/page_896b1fdbd8888191812bca8ea37b72c0
[S26]: https://api.github.com/repos/castlemilk/token-horizon/issues?state=all&per_page=100&page=1&sort=created&direction=desc
[S27]: https://api.github.com/repos/castlemilk/token-horizon/pulls?state=all&per_page=100
[S28]: https://github.com/castlemilk/token-horizon/pull/3
[S29]: https://github.com/castlemilk/token-horizon/issues/23
[P01]: https://token-horizon.dev/
[P02]: https://token-horizon.dev/teams
[P03]: https://token-horizon.dev/leaderboard.html?view=dashboard
[P04]: https://token-horizon.dev/docs/
[E01]: https://www.w3.org/TR/WCAG22/
[E02]: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum
[E03]: https://www.w3.org/WAI/WCAG22/Understanding/reflow
[E04]: https://www.w3.org/WAI/ARIA/apg/patterns/combobox/
[E05]: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
[E06]: https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html
[E07]: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
[E08]: https://langfuse.com/docs/gateway/get-started/admin-setup
[E09]: https://langfuse.com/docs/administration/rbac
[E10]: https://www.nist.gov/publications/de-identifying-government-datasets-techniques-and-governance
[E11]: https://langfuse.com/docs/administration/data-retention

[S30]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js#L2542-L2583
[S31]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/docs/leaderboard.html#L5942-L5984
[S32]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/clients/macos/Sources/TokenHorizon/App/WebDestination.swift#L3-L89
[S33]: https://github.com/castlemilk/token-horizon/pull/8
[S34]: https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/scripts/test-team-invites-ui.mjs
[E12]: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/