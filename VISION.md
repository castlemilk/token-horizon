# Token Horizon: vision

Draft for the owner's review, 2026-11-10. Section 1 describes what exists and section 2 the research. The rest is proposed and is not built, deployed or public unless the text says so.

## 1. What Token Horizon is today

Token Horizon measures AI model usage on a person's own machine, through a macOS app, a Go gateway and a Go daemon, and lets that person publish a summary of it by choice. A Cloudflare Worker with R2 and KV serves token-horizon.dev as static HTML, CSS and vanilla JavaScript, with no D1 database and no Durable Objects (`cloudflare/wrangler.toml`). The public site has individual and team rankings, public profiles, crews with invites, shared reports and a model catalogue exported from the app. The last export read holds 2,049 models, 113 of them with benchmark scores copied from vendor announcements and public boards. Token Horizon has published no evaluation that it ran itself, and it has no comments, follows, reactions or threads. An account is an immutable Google, GitHub or Firebase subject, and "equal email addresses do not link accounts" (`cloudflare/AUTH.md`).

This week a task-benchmark harness was copied into the working tree under `benchmarks/`. It is uncommitted and not public.

## 2. The gap

The landscape research is dated 2026-11-10. Numbers in brackets refer to the Landscape section, which gives each source's date and URL.

1. **A score belongs to a configuration, not to a model name.** A paper of 5 November 2026 found that harness choice moves one model's Terminal-Bench accuracy by about 20 points, which its authors attribute largely to speed under the default time budget [1]. In a December 2025 snapshot of tau2-bench-verified, one model scores 62.07%, 78.16% and 80.30% at medium, high and extra-high reasoning effort, for $16.44, $27.86 and $53.12 a run [2].
2. **Benchmarks are repaired and disowned while their numbers stay in circulation.** Terminal-Bench 2.1 (6 May 2026) repaired 28 of 89 tasks, and one unchanged model and harness rose 12.1 points [3]. OpenAI stopped reporting SWE-bench Verified on 23 February 2026, and in July 2026 retracted its recommendation of SWE-bench Pro without naming a replacement [4]. Token Horizon's own catalogue still sorts by a SWE column fed by SWE-bench Verified data.
3. **Referees have interests.** Arena's policy, last updated 1 September 2026, lets providers "test multiple variants of their models before making them public", shares the results privately and lets a provider withdraw a model [5]. Arena reports more than $100M in annualised revenue, which press coverage attributes to an evaluation product sold to model labs and enterprises [6]. None of this shows that a published score is wrong.
4. **Catalogues change without a history.** OpenRouter's models guide has no changelog or price-change notice, and a third-party diff found 35 of 665 routes repriced between 28 October and 5 November 2026 [7]. On 1 December 2026 Google reroutes two Gemini 2.5 identifiers to lower-tier models, while the identifier a caller sends stays the same [8].
5. **Discussion happens away from the evidence.** Epoch takes feedback by form or email, and the research found no discussion feature on the measured-benchmark sites it read [9]. The nearest precedent is Hugging Face Community Evals (4 February 2026), where a score is a pull request that people can discuss and that the model's author can close [10]. OpenRouter states that a higher token total "shows how much a model is used, not which model is best for a task" [11]. The research did not identify a product that puts a person's own published usage beside task results that can be re-checked.

It is a judgement that findings 1 to 4 are failures of provenance, versioning, uncertainty and disclosure, and that Token Horizon cannot match these sites' volume of runs. It can publish fewer results, each complete enough to check, beside the usage data and catalogue it already holds.

## 3. Four pillars

1. **Usage** (exists). What people chose to publish about the models they use.
2. **Ledger** (extends the catalogue). Releases, prices, effort options, deprecations and reroutes as dated change notices.
3. **Evidence** (starts with the harness). Tasks that ask a model for a self-contained artefact or program, scored by deterministic checks.
4. **Discussion** (not built). Posts anchored to a record, a check, a task version or a change notice.

The ledger marks a record stale when its model changes, and a tracked release triggers a sweep whose measured difference from the previous model opens a release page. Evidence gives discussion something exact to point at. An accepted note or an upheld dispute produces a new check or task version. Usage shows which models and harnesses people publish, which is one input when choosing what to run next. It is never presented as a quality signal: "Token volume describes activity, not productivity" (PRODUCT.md).

## 4. The unit of evidence

The unit is the **evidence record**: one model configuration attempting one task version a stated number of times. It states:

- the model, the identifier sent and the identifier the provider reports serving;
- the harness and its version, the reasoning effort and the budget;
- the task version, and the trials requested, completed and failed;
- every check's outcome and the content hash of each artefact scored;
- cost and token counts, marked as provider-reported, estimated or unavailable;
- who ran it, who paid, and what interests they disclosed.

In this document's judgement, a result is trustworthy when five rules hold and its provenance level is stated.

- **Compare like with like.** Scores are ranked together only when harness, effort, budget and task version match.
- **Supersede, never edit.** A corrected check or task makes a new version, and earlier records stay reachable and labelled.
- **Count every trial.** Failed trials and checks that throw count against the score. A score shows its trial count and an interval, and overlapping intervals are shown as ties.
- **Say unavailable.** "Missing values are unavailable, not fabricated measurements" (PRODUCT.md).
- **Score with programs.** Checks are deterministic, so anyone can re-run them on the stored artefact without calling a model.

Provenance has four levels. **Cited** (0): a number published elsewhere, with publisher, URL and date, never ranked with the others. **Submitted** (1): a bundle from a named account whose files match their hashes. **Rescored** (2): the pinned checks, re-run on the bundle's artefacts, give the same results, though nothing yet shows that the named model produced them. **Reproduced** (3): a separate run of the same configuration, by a party with no disclosed tie to the model's vendor, gives an overlapping interval. Maintainer runs start at level 2 and carry the same disclosure as everyone else's.

## 5. The discussion layer

It is for disputing a check or record with the evidence attached, explaining why two configurations of one model differ, comparing models under a stated constraint such as a cost budget, and proposing task repairs.

A post that makes a claim links at least one record, or one external source with its URL and date. If the linked record is later superseded, the post says so. Vendors take part in the open: their posts are labelled, their re-run requests are published as separate labelled records, and they cannot hide or close anything. Posting never requires publishing usage.

The first version is the smallest one that the available moderators can run: signed-in, anchored, plain-text notes that are reviewed before they appear.

It is not a general forum, a feed, a follower graph, direct messaging, reactions, or votes that move a score. One simulation on historical Arena votes found that a few hundred rigged votes could shift a ranking [13].

## 6. Principles

- Every public number links to its record: "Put the measurement's scope and publication limits beside the result" (PRODUCT.md).
- Every view states its purpose, whose data it shows and the supported next action (DESIGN.md).
- Publishing is a separate, explicit act, and "Prompts and device traces remain private" (PRODUCT.md).
- Model-generated HTML is untrusted, and a sandboxed frame does not contain it: on 2026-11-10 a test artifact running in a `sandbox="allow-scripts"` frame with a no-network content policy still made HTTP requests, TCP connections and WebRTC traffic from a full Chrome build. Public pages therefore show captures taken in an isolated headless browser with its network blocked. If running artifacts are ever offered, they run from a separate registrable domain that holds no cookies, behind an explicit click, with the network exposure stated beside the button.
- Public pages stay static, with locally vendored libraries (PRODUCT.md).

## 7. Non-goals

These are proposals for the owner to confirm.

- A single composite index of model quality.
- A preference arena, or any vote that changes a score.
- Private pre-release testing for vendors, paid placement or paid evaluation.
- Model-judged headline scores [12].
- Hosted inference, or server-side storage of provider keys.

## 8. Audience

PRODUCT.md records the primary audience as an open decision: "builders and small crews, organisation managers, or both." This vision does not settle it. As a judgement, the pillars above serve a person choosing a model, harness and effort setting for their own work, which is closer to builders and crews. Organisation managers would need governance and spend views that are not described here.

## Landscape, as of 2026-11-10

Each entry was read or checked on 2026-11-10. Dates are the source's own.

1. "Benchmarks as Software", arXiv 2611.08417, v1 5 November 2026: a harness effect of about 20 points on GPT 5.4. https://arxiv.org/html/2611.08417
2. tau2-bench-verified README, December 2025 snapshot: GPT-5.2 rows, costs averaged over five runs. https://github.com/amazon-agi/tau2-bench-verified
3. Terminal-Bench 2.1 release post, 6 May 2026: Claude Opus 4.6 in Claude Code rose from 58.0% to 70.1%. Versions 3.0, 4.0 and 4.1 have followed. https://www.tbench.ai/news/terminal-bench-2-1
4. OpenAI Developers post, 23 February 2026. https://x.com/OpenAIDevs/status/2026002219909427270 OpenAI, "Separating signal from noise in coding evaluations", July 2026 (8 July per press coverage): about 30% of SWE-bench Pro tasks estimated broken. Read through mirrors. https://openai.com/index/separating-signal-from-noise-coding-evaluations/ and https://gigazine.net/gsc_news/en/20260709-openai-coding-evaluations/
5. Arena leaderboard policy, last updated 1 September 2026. https://arena.ai/blog/policy
6. Arena Series B post, 8 October 2026: "exceeded $100M in annualized revenue". https://arena.ai/blog/series-b TechCrunch, 29 June 2026, on the source of that revenue. https://techcrunch.com/2026/06/29/arena-the-ai-leaderboard-everyone-uses-is-now-a-100m-business/
7. OpenRouter models guide. https://openrouter.ai/docs/guides/overview/models Third-party diff of its models endpoint, 28 October to 5 November 2026. https://www.digitalapplied.com/blog/ai-api-price-changes-retirements-november-2026
8. Gemini API deprecations page: `gemini-2.5-pro` and `gemini-2.5-flash` reroute on 1 December 2026 to a Flash and a Flash-Lite model. https://aistudio.google.com/docs/deprecations
9. Epoch AI Benchmarking Hub: feedback by form or email. https://epoch.ai/benchmarks
10. Hugging Face Community Evals, beta launched 4 February 2026. https://huggingface.co/blog/community-evals
11. OpenRouter rankings, usage data through 9 November 2026. The page also shows benchmark scores from other sites. https://openrouter.ai/rankings
12. Arena, post on self-preference in LLM judges, 30 September 2026: a model judging battles that include its own answer picked that answer 58% of the time, against 34% for human voters. The effect varied by judge. https://arena.ai/blog/llm-judge-self-preference
13. Min et al., arXiv 2501.17858, revised 10 August 2025: a simulation. Arena has since added defences. https://arxiv.org/abs/2501.17858
