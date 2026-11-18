# Token Horizon — Track 5 analytics research package

**Read-only research dated 18 November 2026 (Australia/Melbourne).** Repository baseline: `castlemilk/token-horizon`, default branch `main`, commit `b468206e9378c8d7a6788b67072494982e7de17d`, committed at `2026-11-18T07:35:19Z`. A final-review branch read returned the same commit. The deployed website SHA was not established.

## Start here

- **token-horizon-track5-specification.pdf** — the complete research and implementation specification, with original proposed-screen appendix.
- **token-horizon-track5-specification.md** — editable source of the complete specification. Its section 12 is the canonical T5-01 through T5-10 backlog.
- **wireframes.html** — self-contained, offline proposal for self, restricted team-analyst and admin data-quality views. Open locally in a browser. It makes no network calls; all observations are invented.
- **visuals/** — original labelled SVG and PNG wireframes, suitable for review and annotation.
- **data/** — a synthetic ledger, identity/coverage manifests, expected metrics and an explanatory README.
- **validation/** — reproducible synthetic checks, privacy-safe source-function/SQL reproductions and their exact outputs.
- **source-evidence.md** — concise explanation and immutable source links for the reproduced findings.
- **issue-map.json** — all 46 inspected issue/PR records, with state, update date, URL and Track 5 disposition; no issue bodies or personal text.
- **evidence/** — source manifests, provenance, source audit notes, deduplication notes and redacted live observations. Raw repository copies are excluded.

## Main recommendation

Repair analytics trust and public-response boundaries before expanding private team reporting. Existing Workspace/team histories should be extended rather than rebuilt. Calendar windows, ratio populations, unknown/zero/withheld costs, missing days and profile/team attribution need a consistent contract. Private team/admin screens depend on Track 2 tenant/RBAC/consent and Track 6 canonical token/request/cost semantics.

The public sanitizer finding is source-reachable and reproduced only with synthetic sentinels. No live email value was queried or a production disclosure established. Current Go `reported` cost means a tool/file annotation, not an invoice or a verified provider billing API. Public crew totals are overlapping membership contributions, not unique organizational spend.

## Reproduce the bounded checks

Run from this package directory:

```bash
python3 validation/verify_synthetic.py
node validation/source-checks/check_cloud.mjs
python3 validation/source-checks/check_sql.py
```

The first command passes **69/69 checks** of the invented fixture and arithmetic. The source checks reproduce six observed helper/SQL behaviors using exact, hashed code excerpts plus clearly labelled authored comparators. They require Python's standard library (with IANA timezone data) and Node; no network, packages, credentials, provider calls or running Token Horizon service are needed. Scripts rewrite only their result JSON files next to themselves.

A pass in the source checks means the reviewed behavior was reproduced. It does not mean a proposed repair was implemented. No full application test suite, native application, real tenant authorization, production performance, deployed export, deletion job or alert delivery was tested.

## Interpretation and privacy boundaries

Evidence is labelled as live observed, source-present, measured in isolation, inferred or proposed. Only the anonymous public product was inspected. No signed-in account, private device trace, raw prompt, real usage record, private project title, credential or real-user screenshot is included.

The fixture has 29 canonical requests and 2,960,000 observed tokens at its revised as-of. The estimated metered amount is USD27.60 and the separate synthetic provider-reported amount is USD36.25. These are invented values, not provider prices or customer spending. Complete cost cannot be inferred from partial/withheld observations.

The analyst proposal illustrates a separate restricted daily-detail grant. Broadly shared private reports require proposed minimum cohort and time thresholds plus complementary suppression. A five-of-six subset is suppressed when its complement could reveal one person. Exact overlap values remain in the reviewer oracle only. Role navigation and illustrative JSON export in the HTML are design demonstrations, not authentication or a secure service.

SVG/JavaScript parsing, fixture consistency and rasterized layout review were performed. A local browser launch failed before page load because the environment denied its process-singleton socket; interactive HTML behavior, responsive layout and assistive-technology behavior remain untested. The PDF is a static document, not implemented UI.

## Scope and change control

This is Track 5 only. Track 2 owns the management shell/identity/roles; Track 6 owns detailed token/context and accounting semantics. Other track handoffs are documented without creating competing projects.

No shared repository, issue, PR, permission, setting, deployment or publication was changed; no paid service or third-party messaging was used. All T5 backlog items, engineering-day estimates, new retention policies and performance targets are reviewable proposals.
