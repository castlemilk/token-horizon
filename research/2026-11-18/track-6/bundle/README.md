# Token Horizon Track 6 — review bundle

Research snapshot: **18 November 2026**. Repository branch **main**, commit **b468206e9378c8d7a6788b67072494982e7de17d**.

This is a read-only research/specification deliverable, prepared in regular Pro Chat. It contains no changes to Token Horizon, no real personal usage, no prompts, no credentials and no live provider requests. All diagnostic examples and wireframes are synthetic proposals, not implemented UI.

## Start here

- **token-horizon-track6-research-spec.html** — self-contained illustrated report, with embedded SVG proposals, section navigation and clickable evidence. Open locally in a browser; no server, external scripts, fonts or tracking required. External evidence opens only when selected.
- **token-horizon-track6-research-spec.md** — complete editable text of the report. Its image links resolve inside this bundle.
- **visuals/contact-sheet.png** — all three proposed views together. Individual SVG and PNG files are also included.
- **evidence-manifest.json** — exact repository/upstream pins, key blob SHAs, inspected-file index, official URLs, public catalog observation and access gaps.
- **issue-inventory.json** — the inspected 31 ordinary issues and 15 PRs, with dates/status and source URLs. No issues or PRs were created or modified.

## Isolated executable examples

Requires Python 3; uses only its standard library. From this directory:

```sh
python3 verify_contract.py
python3 daemon_sql_probe.py
```

`verify_contract.py` reads `token_context_fixtures.json`, executes **39 specification examples** and writes `spec_test_results.json` beside itself. At preparation, all 39 passed, with no failures/errors/skips. The fixture schema is `proposal-fixtures-v3`.

`daemon_sql_probe.py` runs selected source SQL expressions against a minimal synthetic in-memory schema. It prints the denominator, annotation-join and product-filter findings also recorded in `daemon-sql-synthetic-results.json`.

These are **not Token Horizon application tests**. They perform no network calls, inference, real database access or production imports. They do not establish installed behavior or production defect frequency. Native/Go suites, performance and privacy release gates remain unexecuted; the report specifies them.

## Status and reuse

The report separates current public text/catalog observations, source-only findings, measured synthetic experiments, inferences and proposed work. The ten TC items are local planning identifiers mapped to existing GitHub issues; they are not newly created tickets. Provider documentation was retrieved on the research date and may change; retain exact API/model/adapter revisions when implementing.

The SVG/PNG views are labelled **PROPOSED · SYNTHETIC DATA · NOT IMPLEMENTED**. They use original layouts and invented counts; no screenshots of private product data are present. Token volume is never treated as quality, productivity or access to hidden reasoning.

`artifact-checksums.json` supplies SHA-256 digests of the bundle files (excluding itself). This bundle does not include a repository checkout or copied personal data.
