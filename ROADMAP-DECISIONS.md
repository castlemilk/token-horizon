# Token Horizon: recommended answers to the roadmap's open decisions

Drafted 2026-11-11 against the working tree (ROADMAP.md, VISION.md, PRODUCT.md, README.md, `benchmarks/`, `cloudflare/`). These are recommendations for the owner to accept or reject; none is adopted until the owner says so. The numbered decisions match "Open decisions for the owner" in ROADMAP.md.

Four decisions are yours alone: 1 (audience), 5 (who moderates), 9 (funding) and 10 (licence). For those I give a default and the question to answer. The other eight are recommendations you can accept or reject.

Three things I did not verify: whether the GitHub repository is public, what provider terms say about publishing model outputs, and whether the catalogue refresh job is still running on origin (see decision 6).

| # | Decision | Recommendation | Whose call |
| --- | --- | --- | --- |
| 1 | Primary audience | Default: builders and small crews | Owner only |
| 2 | Public report, Pages mirror | Public on token-horizon.dev after Phase 1 passes; not mirrored on Pages | Recommendation |
| 3 | Running artefacts | Captures only | Recommendation |
| 4 | Trials, interval, provenance level | 5 trials minimum, 10 on headline tasks; paired bootstrap over tasks; level 2 and above | Recommendation |
| 5 | Moderator and time to decision | Default: you, 5 working days, cap of 20 pending | Owner only |
| 6 | Snapshot store | A dedicated git branch | Recommendation |
| 7 | Phase 6 database | D1 as a rebuildable index over R2 objects; decide when Phase 6 starts | Recommendation |
| 8 | Order of Phases 4 and 5 | Local half of 5 first, then 4, then hosted upload | Recommendation |
| 9 | Funding and disclosure | Default: self-funded, payer on every record, no vendor money yet | Owner only |
| 10 | Licence and withdrawal | Default: Apache-2.0 for code, CC BY 4.0 for records | Owner only |
| 11 | Agents and vendors posting | Vendors yes, labelled; agents draft only | Recommendation |
| 12 | Held-out tasks, preference votes | No private tasks and no votes; rotate hidden inputs instead | Recommendation |

## 1. Primary audience (owner only)

**Default:** builders and small crews.

**Why:** PRODUCT.md says the current public copy already addresses builders and crews, and VISION.md section 8 judges that the four pillars serve "a person choosing a model, harness and effort setting for their own work". What exists (the notch app, per-provider plan limits, crews with invites, in README.md) is built for an individual and a small group.

**What it costs:** no governance, spend-control or single-sign-on views for organisation managers, and none are described in the roadmap.

**What would change it:** evidence that organisations are the ones asking, such as team sign-ups from company domains or requests for spend reports.

**Question to answer:** who do you want coming back each week: the person choosing a model for their own work, or the person accountable for a team's spend? "Both" means the roadmap needs a second set of views that nobody has scoped.

## 2. Whether the Phase 2 report is public and mirrored on Pages

**Recommendation:** publish it on token-horizon.dev once Phase 1's exit criteria pass, and keep it off the GitHub Pages mirror.

**Why:** `cloudflare/wrangler.toml` serves `../docs` as Worker assets and `.github/workflows/pages.yml` uploads the same `docs/` on every push to main, so anything placed there appears on two origins. Only the Worker can set the headers Phase 2 depends on (`text/plain` with `nosniff` for artefact downloads), and a takedown or withdrawal has to work in one place. Phase 0 criterion 3 is not met (intervals overlap, `orbit-lab` is at 100 for every configuration), so publishing today would show a ranking the data does not support.

**What it costs:** the Pages workflow needs a path exclusion or a redirect for `/benchmarks`, and the report waits for Phase 1. It also waits for the legal check on provider terms that ROADMAP.md lists as not researched.

**What would change it:** if you decide to retire the Pages mirror altogether, the mirroring question goes away. If you want early feedback before Phase 1, share the local `benchmarks/report/dist` build privately instead of publishing.

## 3. Whether readers can ever run artefacts

**Recommendation:** stay with captures only.

**Why:** VISION.md section 6 records that a `sandbox="allow-scripts"` frame with a no-network policy still made HTTP, TCP and WebRTC connections on 2026-11-10. The report already enforces captures only: `benchmarks/report/README.md` describes the isolated capture browser and `capture-isolation-test.mjs`, and a test checks the built page has no frame. A reader who wants to run an artefact gets the local command from the record dialog.

**What it costs:** readers cannot play the games or drive the simulators in the browser, and two fixed captures per cell can miss behaviour that the checks measure.

**What would change it:** disputes that repeatedly turn on behaviour the captures cannot show. Even then, the separate cookie-less domain needs buying, the legal check done, and the network exposure stated beside the button, as VISION.md already says.

## 4. Minimum trials, interval method, provenance level for default rankings

**Recommendation:** a cell needs 5 completed-or-failed trials to be ranked and 10 on headline tasks; compare two configurations with a paired bootstrap over tasks and label them tied unless the 95% interval of the difference excludes zero; rank level 2 and above by default.

**Why:** the first sweep ran 3 iterations per cell and the four Claude models' intervals overlap on the headline tasks (ROADMAP.md, Phase 0 criterion 3). The report already draws a 95% bootstrap interval "where there are enough iteration values" (`benchmarks/report/template/index.html`), so this extends the existing method to the difference between two rows. Maintainer runs start at level 2 (VISION.md section 4), so a higher bar would leave the default ranking empty until Phase 5.

**What it costs:** the first sweep was 258 calls for US$114.39. The same matrix at 10 trials is roughly US$380 per vendor, and each new vendor multiplies it. More trials do nothing for a saturated task, so recalibrate `orbit-lab` first.

**What would change it:** the Phase 1 repeatability figures. If checks rarely flake and trial-to-trial spread is small, 5 everywhere is enough. If spread is large, set the trial count from the difference you want to detect instead of a fixed number. Once level 3 records exist in volume, consider making level 3 the default.

## 5. Who moderates, and the target time to decision (owner only)

**Default:** you are the one named moderator, with a target of 5 working days and a cap of 20 pending posts that closes the form.

**Why:** Phase 4 holds every post until a person decides, and its exit criteria require a published name and target time. The repository shows one maintainer. The triage skill in Phase 4 lets an agent draft the decision, which cuts the time per post but not the need for a person.

**What it costs:** a standing weekly commitment. A target you miss in public is worse than a slow one you keep.

**What would change it:** a second person you trust to decide, which allows a shorter target and cover for absences.

**Question to answer:** how many hours a week will you give this, and is there a second moderator? If the answer is "none and no", do not start Phase 4: the Phase 2 GitHub issue route already takes disputes.

## 6. Snapshot store: R2 or a git branch

**Recommendation:** a dedicated git branch, with the catalogue written in a stable sorted form.

**Why:** `.github/workflows/models-refresh.yml` already commits `docs/data/models.json` on a schedule with the repository's own token, so a branch needs no new secret, while R2 needs one. The file is 3.2 MB, and git history gives anyone a diff between two days without a Worker route, which suits a ledger whose point is a checkable history. A separate branch also stops snapshot commits from triggering the Pages deploy on `docs/**`.

**What it costs:** repository growth (the pack is already 120 MB) and a branch every full clone fetches. It differs from the Phase 2 pattern of R2 objects under content hashes.

**What would change it:** snapshots more often than daily, a branch that grows past a few hundred megabytes, or a private repository, where outside readers could not see the history anyway.

**Check first:** local history has 95 commits to `docs/data/models.json` from 2026-09-15 to 2026-10-28 and none since. If origin shows the same gap, the refresh job has stalled, and Phase 3's 14 consecutive days cannot start until it is fixed.

## 7. Database for Phase 6

**Recommendation:** do not decide now; when Phase 6 starts, use D1 as an index that can be rebuilt from R2 objects.

**Why:** the Worker has R2 and KV only (`cloudflare/wrangler.toml`), and Phases 4 and 5 are designed around one writer per index, so they need no database. Phase 6 needs several writers to one collection, secondary indexes and "hide all content by one account in one logged action", which per-anchor R2 objects cannot do without scanning. Keeping posts as immutable R2 objects and D1 as the compiled index preserves the roadmap rule that every write is a new object.

**What it costs:** the first database in the project: migrations, backups, a new binding, and VISION.md's "no D1 database" statement changes.

**What would change it:** Phase 4 volume. If reviewed notes arrive at a few a week, stay on per-anchor R2 objects with the moderator as the only writer and do not build open threads.

## 8. The order of Phases 4 and 5

**Recommendation:** split Phase 5: build the bundle format, `pack`, `verify` and offline rescoring first, then Phase 4, then the hosted upload endpoint.

**Why:** Phase 2 exit criterion 4 already requires a second machine to reproduce a published record, which needs a bundle that can be packed and verified, and none of that needs hosting. The first sweep covers one vendor and the maintainers pay for every run (ROADMAP.md, risks), and independent reproduction is the only route to level 3. The first hosted write path should be the smaller one: capped plain text held for review, not file uploads rescored in a container.

**What it costs:** until the upload endpoint exists, bundles arrive by pull request or issue attachment and are processed by hand. Phase 5 is finished later than it would be if done in one piece.

**What would change it:** if nobody offers to run bundles, do Phase 4 first as written. If contributed bundles arrive faster than you can handle by hand, bring the upload endpoint forward.

## 9. Funding and its disclosure (owner only)

**Default:** self-funded, with the payer stated on every record and a one-paragraph funding statement on the methodology page; accept no vendor credits or sponsorship until you have written the policy.

**Why:** VISION.md section 7 already proposes ruling out paid placement, paid evaluation and private pre-release testing, and the record sketch carries `runner.paidBy` and a disclosure. VISION.md section 2 criticises a referee whose revenue comes from the labs it ranks, so the project's own funding will be read against that.

**What it costs:** run volume is limited by what you will spend. See the figures in decision 4.

**What would change it:** contributed bundles (Phase 5) reducing the bill, or a sponsor with no models in the rankings.

**Question to answer:** what monthly amount will you spend on runs, and would you take credits from a vendor whose models you rank? If yes, the terms I would attach are: public, unconditional, named on each record they paid for, and those runs never count as independent reproduction.

## 10. Licence and withdrawal terms (owner only)

**Default:** Apache-2.0 for code, tasks and checks; CC BY 4.0 for records and summaries; a withdrawn contribution is marked withdrawn and its files removed, while its digest and ledger entry stay.

**Why:** the repository root has no licence file, so by default nobody else has permission to run the harness, and Phase 2 offers "reproduce locally" on every record. Phase 5's variant ledger lists withdrawn submissions, so withdrawal cannot mean erasure of the fact that a submission existed. AGENTS.md says ported Gamma components must carry their licence, so third-party terms need an inventory before any licence is chosen.

**What it costs:** a permissive licence lets anyone, including a vendor or a competitor, reuse the harness and tasks. The ownership of model-written artefacts is unsettled and depends on provider terms that have not been researched.

**What would change it:** wanting changes shared back (a copyleft licence), or keeping the macOS app closed while opening only `benchmarks/`.

**Question to answer:** may others reuse this commercially, and does the app get the same licence as the benchmark? Take legal advice on the artefacts before Phase 2, as ROADMAP.md already says.

## 11. Whether agents and vendors may post

**Recommendation:** vendors may post from Phase 4, labelled and with no power to hide or close; agents may draft but not post.

**Why:** VISION.md section 5 already sets the vendor rule, and vendors are the people most likely to find a broken check in their own model's record. Every Phase 4 post is held for review, so a labelled vendor post carries no more risk than any other. Phase 4 defers agent-authored posts, and the queue costs one human decision per post, which automated posting would exhaust.

**What it costs:** the affiliation label is self-declared, because accounts are provider subjects with no employer check (`cloudflare/AUTH.md`). People who use an agent to write still post under their own account and limit.

**What would change it:** vendor posts taking up most of the queue (give them a separate quota), or standing gates in Phase 6 that would let a trusted account's agent post with a label.

## 12. Private held-out tasks, and blind preference votes

**Recommendation:** no private tasks and no preference votes; hold out inputs instead, by keeping the current hidden-input version private, publishing its digest and revealing it at each rotation.

**Why:** VISION.md lists a preference arena as a non-goal and cites a simulation in which a few hundred rigged votes shifted a ranking. A private task breaks the rule that anyone can re-run the checks on a stored artefact. The Horizon suite already separates hidden constants into each task's `hidden.ts` with a `HIDDEN_VERSION`, and its README says rotation matters if the repository becomes public, so the mechanism exists.

**What it costs:** between rotations, outsiders cannot rescore a current record themselves and must rely on the maintainers' rescoring job. Hidden inputs in a public repository are not hidden, so they must live outside it. A task whose prompt is public can still enter training data.

**What would change it:** scores on a task rising across model releases while its rotated-input scores do not, which would show contamination that input rotation cannot fix. That would justify a small private set, reported separately and never ranked with the public tasks.
