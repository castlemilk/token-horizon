# Offline source checks

These checks reproduce selected behavior in **Token Horizon main, commit `b468206e9378c8d7a6788b67072494982e7de17d`**, using only invented records. They run entirely offline with Node.js and Python's standard-library `sqlite3`.

Run from any directory:

```bash
node /absolute/path/to/source-checks/check_cloud.mjs
python3 /absolute/path/to/source-checks/check_sql.py
```

Each script prints results and rewrites its corresponding `cloud-results.json` or `sql-results.json` next to the script. Both first verify the SHA-256 of their packaged source evidence. A successful exit means **the audited behavior was reproduced**, not that the application meets a release gate or has been repaired.

## What is included

- `cloud-helpers.mjs`: exact code-only helper excerpts, including actual provider normalization, team-ID validation, team membership extraction and display formatting. Added provenance comments and a test export list are the only assembly additions. No helper logic is stubbed. The harness freezes its process-local clock at 18 November 2026; it does not change the source functions.
- `sql-evidence.json`: exact usage-event/file-annotation table definitions and relevant SQL expressions, plus small Go query-context excerpts showing the joins and cost-precedence branch. Extraction removes only Go literal delimiters or SQL-list punctuation. The complete source files are deliberately excluded.
- `provenance.json`: pinned repository/commit, original file paths and line spans, returned Git blob SHAs, verified full-source byte hashes, per-excerpt hashes and assembled snippet hashes. Full-source bytes were verified against their returned Git blob SHA before extracting these excerpts.
- Two small test scripts and their result files. All fixtures are synthetic; output uses only invented counts, amounts and field names.

## Cases and limits

| Case | Reproduction | What it does not prove |
| --- | --- | --- |
| Calendar window | Seven observed dates spanning 90 days survive a request for seven days in the inspected helper. | That a live person's chart contained this pattern or that a particular deployment matches the pinned source. |
| Membership contributions | One 100-token synthetic profile in two valid synthetic teams contributes 100 to each. | An error in the intended public crew metric; it demonstrates why that metric is not unique tenant spend allocation. |
| Public field sanitization | A synthetic `googleEmail` sentinel remains while specified private keys are stripped. Only retained key names are printed. | Any live email disclosure, production exploit or full application security result. |
| Product filter | The exact predicate requires alias `fa`, which the inspected aggregate queries omit. A minimal SQLite expression reproduces its unresolved-column error. | Execution of the compiled Go API. Product means tool/product attribution, not project allocation. |
| Cost reconciliation | A raw aggregate returns 0 while the included event-precedence rule would select a synthetic 0.25 file annotation. | Invoice, paid spend or provider API accuracy. The comparator SQL is authored equivalent logic, clearly marked in the script. |
| Missing throughput | One 50 tok/s observation and one equally weighted unknown yield 25 under the source expression, versus 50 over supported observations. | A production latency/rate benchmark or a universal timing definition. Track 6 must define the final metric. |

No network request, credentials, user files, running daemon, shared repository mutation, account query or third-party message is required. These are source-function/expression checks; they are not HTTP integration tests, full Go/native tests, authorization tests, performance measurements or completed fixes.

The source-level email-field path is documented in the companion `source-evidence.md`: the worker itself fills that field from a verified Google identity on publish/claim, and the public route passes the entry through this sanitizer. Reachability in source does not establish a production disclosure. This package contains no real email values or profile records.
