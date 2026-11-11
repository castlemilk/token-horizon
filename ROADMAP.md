# Token Horizon: roadmap

Draft for the owner's review, 2026-11-10; Phase 0 updated 2026-11-12. VISION.md defines the evidence record and the provenance levels used here. Only Phase 0 has a date. Each later phase starts when the exit criteria before it pass. Tool names marked proposed do not exist yet.

Two rules hold for all new work. They, and the order of the phases, are judgements. Every write is a new object, and one job compiles each index. Model-generated HTML never runs on the product origin.

## Phase 0: this week (2026-11-10 to 2026-11-12)

**Goal.** A local harness with sound scoring, one sweep, and a report the owner can review before anything is public.

**State on 2026-11-12.** The report's public build is live at https://token-horizon.dev/benchmarks/ (Worker version b26693e6, deployed from local branch `deploy-benchmarks-report`, commit 3b0aa2f on 714cc27; not yet on `main`). Everything else below is committed on the local branch `benchmarks-harness`, which is not pushed, so the harness itself is not public.

- The task-benchmark harness is in `benchmarks/`, copied from the owner's personal site at commit `a1d5193` (the site's published pages are unchanged).
- Scoring is version 2 (`benchmarks/docs/lab/llm-benchmark/scorer-changelog.md`): a check that throws, times out or is skipped keeps its points in the denominator; a failed browser never produces a structure-only score; every record carries an all-trials score in which a failed iteration counts as zero; one artifact is scored at a time, a timed-out check is rescored, and a machine that cannot keep time stops the sweep instead of publishing.
- A streaming Anthropic runner pins reasoning effort per registry entry, sends no sampling parameters, allows no fallback model, and records provider-reported tokens and cost. Each call may produce 128,000 output tokens; the first pass used 64,000, and every pair that reached it was re-run.
- Six new tasks with 66 checks between them (the Horizon suite) passed adversarial review and ran. A seventh, `seat-pricing`, is held back: its contrast check is not yet reliable. Three more fix-and-review rounds on 2026-11-12 did not pass; the open findings, and the choice between a paint check, a computed-style check and an unscored check, are in `benchmarks/lib/lab/llm-benchmark/plugins/horizon-suite/README.md`.
- The first sweep: Claude Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 on ten headline tasks, and six effort variants on the six new tasks; 3 iterations each; 258 billed calls costing US$114.39. Opus 5.5 at high effort on the six new tasks followed: 18 billed calls, US$8.87. One of those calls was first refused by the account's spend limit and re-run once the limit was raised. In all, 276 billed calls costing US$123.26.
- A local report (`benchmarks/report/`) shows score against cost, a model-by-task heat map, effort comparisons on shared tasks, reliability, speed, per-check pass rates and a gallery of captures. Model-written HTML never runs in the reader's browser.
- Three agent skills: `benchmark-run`, `benchmark-task-authoring`, `model-release-tracking`. The 15 existing skills were checked against the code and 98 stale claims corrected.
- Defects found in that audit and fixed: the Gemini 3.6 Flash price was 500 times too low in the registry (its 8 earlier records are repriced); the seeded `claude-4` entry is marked historical and cannot be run; `scripts/update-catalog.py` reports differences and writes only with `--add-missing` or `--overwrite`; the Go Z.ai adapter's used-share reading is pinned by a test. The matching Swift changes (Z.ai used share, the Alibaba retry re-sending its request, the user catalogue file read before the bundled one) are in files that also hold the owner's uncommitted work, so they are left in the working tree, uncommitted.

**Infrastructure.** None new: repository files, a local browser and one provider API key.

**Skills and tools.** The three skills above, and the harness's seven read-only MCP tools: `bench_list_models`, `bench_list_tasks`, `bench_get_result`, `bench_get_trace`, `bench_related_runs`, `bench_resolve_ref`, `bench_checks_used`.

**Exit criteria, as they stand.**

1. Met. Tests show that a throwing check and a failed iteration each lower a score.
2. Met. Each version-2 record states iterations requested and completed, with provider-reported tokens and cost.
3. Not met. `orbit-lab` has every configuration at 100, and on the headline tasks the four Claude models' 95% intervals overlap, because three iterations per task is a small sample. The effort comparisons show clearer differences (Fable 5.2 at low effort matched its high-effort score at under a third of the cost; Haiku 5.5 did worse at higher effort; Opus 5.5 at high effort scored 95.6 on the six new tasks against 96.1 at medium, at about 1.7 times the cost per attempt). Next: recalibrate saturated checks and run more iterations.
4. Met in a stronger form. No artifact runs in the report at all: a sandboxed frame with a no-network policy was measured reaching the network, so the report shows captures only, and a test checks the built page contains no frame and no artifact text.
5. Met. The three skills exist with `name` and `description` frontmatter and were verified against the tree.

**Deferred.** Publishing the harness: the public report hides its reproduce commands until `benchmarks/` is in the public repository. The public build (`npx tsx report/build.mjs --target public --out <dir>`) shows scorer-version-2 runs only. `seat-pricing`, until its contrast check passes review or is redesigned (about US$11 to run once it does). Agent-CLI runs of Claude models: the audited Claude Code runner overwrites `~/.claude/settings.json` on each call and estimates tokens from character counts. Other vendors.

## Phase 1: Evidence record

**Goal.** Every number on the report resolves to one record.

**Deliverables.**

- Record schema v1 with a digest, and task versions hashed over prompt, checks and scorer version.
- `bench://` references emitted and pinned by digest. The scheme is defined in `benchmarks/lib/lab/llm-benchmark/bench-ref.ts`, whose comment says nothing emits it yet.
- Trial counts, intervals, a "tied" label, and a measured repeatability figure for each check. The audit found none.
- A disclosure on every record, a methodology page, and a dated changelog of task and scorer versions. The seven older tasks are labelled smoke tasks and left out of summary scores.

**Infrastructure.** Repository files. Harness tests run in CI; sweeps do not.

**Skills and tools.** Skill: produce, verify and cite a record. Local tools (proposed): `bench_get_record`, `bench_verify_record`, and `bench_compare`, which refuses mismatched configurations.

**Exit criteria.**

1. Verification rehashes every artefact, and no field is null without an explicit `unavailable`.
2. Re-running the pinned checks on stored artefacts reproduces the stored results, or the check is listed with its flake rate.
3. Every chart point links to its record.

**Deferred.** Hosting; other people's records.

## Phase 2: Public read

**Goal.** Publish maintainer-run records and the report on token-horizon.dev with no write path.

**Deliverables.**

- `/benchmarks` and a static page per record, task version and model, starting from an image concept (DESIGN.md). Each record page says what was measured, who ran it and at what level, and offers three actions: inspect, reproduce locally, dispute.
- Every maintainer run, including reruns and poor results, and measured results in the `/models` drawer, separate from cited scores.
- Dispute opens a prefilled GitHub issue carrying the record reference, as the interim discussion channel.
- Terms, a takedown contact, and results from at least one other vendor before any cross-vendor ranking.

**Infrastructure.** Summaries in git under `docs/data/`. Artefacts and redacted run logs in R2 under content hashes, outside `docs/`, so neither Worker assets nor the Pages mirror carries them. Pages show captures taken by the harness in headless Chromium with the network blocked; no page on the product origin runs model-written HTML, because a sandboxed frame with a no-network policy was measured reaching the network (VISION.md, principles). The Worker serves stored artefacts only as downloads, as `text/plain` with `nosniff`.

**Skills and tools.** Skill: rebuild and verify the report. Hosted, read-only (proposed): `get_benchmark_record`, `list_benchmark_records`, and measured results in the existing `compare_models`.

**Exit criteria.**

1. A test over the built pages shows that no page contains model-written HTML or a frame that runs it, and that artefact downloads are served as `text/plain`.
2. The pages pass render budgets added to the existing `task bench-leaderboard` gate.
3. From any score a reader reaches its artefact, checks and run log in two steps.
4. A second machine reproduces one published record within its interval.

**Deferred.** Any signed-in action.

## Phase 3: Ledger

**Goal.** Record what changed about a model and mark the evidence it affects.

**Deliverables.**

- A daily catalogue snapshot and a diff that emits change notices: release, price, context, effort options, status, deprecation date, reroute. A notice marks earlier records of that model stale.
- A curated file of deprecation and reroute dates, changed by pull requests that cite a source, with deprecations.info as a cross-check (https://deprecations.info/, checked 2026-11-10).
- A release page per tracked release: the measured difference from the predecessor on the same tasks by effort tier, with intervals and cost, beside the vendor's claimed scores as level 0 citations.
- A Changes tab in `/models`, a feed and a costed rerun queue.
- Agent-CLI runners that leave user settings untouched and record provider-reported usage.

**Infrastructure.** The existing scheduled workflow. Snapshots in R2, which needs one CI secret, or on a git branch.

**Skills and tools.** The release-tracking skill drafts notices and release pages. Proposed tools: `get_model_changes`, `get_model_history`, `bench_list_stale_records`.

**Exit criteria.**

1. The generator, run twice over the same snapshots, yields identical notices.
2. Fixtures detect reprices, status changes, changed deprecation dates and reroutes, and a rerouted benchmarked identifier marks its records stale.
3. Fourteen consecutive UTC days of snapshots exist, and a missed day displays as not captured.
4. Every level 0 score has a publisher, URL and date, or is hidden.

**Deferred.** Canary prompts for unannounced model changes, until the Phase 1 repeatability figures give a noise floor. Alerts and watchlists.

## Phase 4: Reviewed notes

**Goal.** The smallest discussion layer that is safe to run: signed-in people correct the record, at a cost of one human decision per post.

**Deliverables.**

- Two post types: a check note (one check of one iteration) and a record dispute.
- Plain text with a length cap, no links or markup, and a daily limit per account, all enforced in the Worker.
- Every post is held until a moderator decides, and published posts show the outcome. An accepted note produces a new task or scorer version.
- A display name separate from any usage profile, an affiliation label, a report action and a public moderation log.
- A content policy, and a Worker variable that closes all write paths, following `PROMPTS_PUBLIC`.

**Infrastructure.** One R2 object per post and a per-anchor index written only by the moderator action, so there is one writer. KV for approximate rate limits. Authors are keyed by `sha256(ownerId)`, and `ownerId` is never returned (AGENTS.md).

**Skills and tools.** Skill: triage notes, where the agent drafts and a person decides. Hosted, read-only (proposed): `list_notes`.

**Exit criteria.**

1. A test shows no unreviewed text is reachable from a public URL.
2. A post cannot be saved without a resolvable anchor, and a post on a superseded record displays that.
3. The form closes with a stated reason when pending posts exceed the cap.
4. A named moderator and a target time to decision are published.

**Deferred.** Replies, unreviewed posting, agent-authored posts.

## Phase 5: Contributed evidence

**Goal.** Accept records the maintainers did not pay to generate, without lowering the trust of the set.

**Deliverables.**

- A bundle format with an allow-listed schema, `pack` and `verify` commands, and a manifest shown before upload.
- An upload endpoint behind sign-in with its own OAuth scope. The desktop credential is not reused: it "authorizes only usage publication to its exact profile" (`cloudflare/AUTH.md`).
- An offline rescoring job that assigns level 1 or 2. A matching independent run gives level 3.
- A variant ledger on each record page: every submission for that model and task version, withdrawn ones included.

**Infrastructure.** One immutable R2 object per bundle and a job that rebuilds the indexes. Rescoring runs in a container with no secrets, no network and no home directory, because the audited harness starts Chromium with `--no-sandbox --disable-web-security` and gives Python programs no permission boundary.

**Skills and tools.** Skill: pack and submit a bundle with a disclosure. Proposed tools: `bench_pack_bundle`, `bench_verify_bundle`, and, hosted under the new scope, `submit_evidence_bundle`.

**Exit criteria.**

1. Tests reject a bundle with a changed byte, an unknown task digest, a missing iteration or a field outside the schema.
2. A bundle whose artefacts do not reproduce its claimed checks is published at level 1 with the mismatch stated.
3. In a fixture, a second account's run raises a record to level 3, and a run by an account with a disclosed vendor tie does not.

**Deferred.** Third-party tasks; private held-out tasks.

## Phase 6: Open threads

**Goal.** Replies and model-choice questions, limited to anchors and to moderation capacity.

**Deliverables.** Replies on records and release pages. Questions with fields for task, budget and constraints, where an answer must cite a record, a change notice or a dated external source. Standing gates (account age, accepted contributions) for posting without prior review. Labelled vendor accounts with no power to hide or close.

**Infrastructure.** The first phase with several signed-in writers to one collection, secondary indexes and deletes that must propagate. The Worker has no database today (open decision 7).

**Skills and tools.** Skill: answer a question with citations. Proposed read-only tool: `get_thread`.

**Exit criteria.** A test rejects an answer without a citation. A moderator can hide all content by one account in one logged action. No payload contains `ownerId` or an email address.

**Deferred, with no phase assigned.** Follows, feeds, direct messages, reactions, blind preference votes, reputation scores.

## Record sketches

- **EvidenceRecord.** `id` (digest); `status` (current, superseded, withdrawn); `model` {catalogue id, id sent, id served}; `harness` {name, version, commit}; `effort`; `budget`; `task` {id, version digest}; `trials` {requested, completed, failed}; per trial: artefact hash, `checks[]` {name, status, points, maxPoints}, tokens, usage source (`reported`, `estimated`, `unavailable`), cost; `score` {value, interval}; `runner` {handle, paidBy, disclosure}; `provenance` {level, reproducedBy}.
- **TaskVersion.** id; version digest; checks; scorer version; models used in authoring; published date; status (active, smoke, retired).
- **ChangeNotice.** id; model id; kind; before; after; observedAt; source URL; affected record ids.
- **Anchor.** kind (record, check, task version, change notice); `bench://` reference; digest at posting time.
- **Post.** id; anchor; type; author key; display name; affiliation; body; `evidence[]`; state (pending, published, hidden, removed); decision.
- **Bundle.** manifest (path, SHA-256 and size of each file); record; artefacts as text; redacted run log; disclosure; submitter (immutable provider subject).

## Risks

- **Cost of runs.** Effort variants multiply spend. Mitigation: budget caps, a cost estimate before each sweep, cost on every record, contributed bundles.
- **Abuse and moderation load.** Mitigation: review before publication, plain text, a queue cap, a switch that closes writes, a public log, no votes.
- **Conflicts of interest.** The first sweep covers one vendor, and the maintainers choose what runs. Mitigation: a disclosure and payer on every record, a funding statement, every maintainer run published, no vendor-tied run at level 3.
- **Contamination and gaming.** Public tasks can enter training data, and an artefact can target the checks. METR judged at least 16% of successful runs on tasks of eight hours or longer, by frontier models shared with it, illegitimate (Frontier Risk Report, 19 May 2026, https://metr.org/blog/2026-05-19-frontier-risk-report/). Mitigation: versioned tasks with published dates, dated retirement, level 1 left out of rankings, check notes.
- **Privacy.** Mitigation: an allow-listed bundle schema and redaction. No usage data or gateway traces in bundles or posts ("traces are never published", README.md).
- **Legal exposure of hosted generated content.** Provider terms on publishing outputs were not researched. Mitigation: non-HTML storage, frames with no network, a takedown route, legal advice before Phase 2.

## Open decisions for the owner

Each has a recommended answer in `ROADMAP-DECISIONS.md`, with the reasoning, what it costs and what would change it. Four are the owner's alone (1, 5, 9, 10): for those it gives a default and the question to answer. Nothing below is adopted until the owner accepts it.

| # | Decision | Recommended answer | Whose call |
| --- | --- | --- | --- |
| 1 | Primary audience, which PRODUCT.md leaves open | Default: builders and small crews | Owner only |
| 2 | Whether the Phase 2 report is public and mirrored on Pages | Public on token-horizon.dev after Phase 1 passes; not on the Pages mirror | Recommendation |
| 3 | Whether readers can ever run artefacts | Captures only | Recommendation |
| 4 | Minimum trials, the interval method, and the provenance level for default rankings | 5 trials to rank, 10 on headline tasks; paired bootstrap over tasks, tied unless the difference's 95% interval excludes zero; level 2 and above | Recommendation |
| 5 | Who moderates, and the target time to decision | Default: the owner, 5 working days, at most 20 pending | Owner only |
| 6 | Snapshot store: R2 or a git branch | A dedicated git branch (the refresh job runs, but its commits reach the site only on a manual Worker deploy) | Recommendation |
| 7 | Database for Phase 6 | Decide when Phase 6 starts; then D1 as an index rebuildable from R2 objects | Recommendation |
| 8 | The order of Phases 4 and 5 | Phase 5's local half (bundle, pack, verify, offline rescoring) first, then Phase 4, then hosted upload | Recommendation |
| 9 | Funding and its disclosure | Default: self-funded, payer on every record, no vendor money until a written policy exists | Owner only |
| 10 | Licence and withdrawal terms (the root has no licence file) | Default: Apache-2.0 for code, CC BY 4.0 for records; withdrawal removes files but keeps the digest and ledger entry | Owner only |
| 11 | Whether agents and vendors may post | Vendors yes, labelled; agents draft only | Recommendation |
| 12 | Private held-out tasks, and blind preference votes | Neither; keep each hidden-input version private, publish its digest, reveal it at rotation | Recommendation |
