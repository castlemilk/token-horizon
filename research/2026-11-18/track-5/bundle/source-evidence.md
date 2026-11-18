# Source evidence and offline reproductions

**Audit snapshot:** `castlemilk/token-horizon`, `main`, commit [`b468206e9378c8d7a6788b67072494982e7de17d`](https://github.com/castlemilk/token-horizon/commit/b468206e9378c8d7a6788b67072494982e7de17d), dated 18 November 2026. The checks below exercise selected code excerpts with synthetic inputs. They do not establish the deployed revision or measure production behavior.

The complete offline package is in `validation/source-checks/`. Its `README.md` has run instructions; `provenance.json` records original paths, exact line spans, verified Git blob hashes and SHA-256 checksums. Full raw source and real profile records are excluded.

## Reproduced observations

| Check | Synthetic result | Interpretation |
| --- | --- | --- |
| Calendar helper | Seven requested days retain seven observed dates aged 90, 70, 60, 40, 20, 10 and 0 days. | The helper selects the last N observed dates, not a calendar-bounded range. |
| Team aggregation | Unique synthetic profile tokens: 100. Two current team contributions: 100 each. Sum: 200. | Current public team semantics are overlapping membership contributions, not company spend allocation. |
| Public response sanitizer | A synthetic `googleEmail` field survives; `accountEmail`, `ownerId`, `identityId` and `claimTokenHash` do not. | Source-level allowlist gap. Only field names are emitted; no live leak was tested or established. |
| Product/tool filter | SQLite reports `no such column: fa.product` when the inspected predicate is used without its annotation join. | Event/list/aggregate filter parity needs a source-matched regression case. |
| Cost precedence | Raw aggregate: 0. Effective event cost after one invented file annotation: 0.25. | A shared effective-cost projection is needed for reconciliation. Reported here means tool/file-reported, not provider API or invoice data. |
| Missing throughput | Source weighted average: 25. Supported-observation-only average: 50. | Unsupported samples remain in the source denominator; missing timings need explicit exclusion and coverage. |

## Exact source anchors

- Calendar helper: [`cloudflare/src/index.js`, lines 307–345](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js#L307-L345).
- Membership contribution aggregation: [`index.js`, lines 478–512](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js#L478-L512); authoritative membership extraction: [`team-invites.js`, lines 93–96](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/team-invites.js#L93-L96).
- Sanitizer: [`index.js`, lines 228–245](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js#L228-L245). The worker fills `googleEmail` from verified identity during publish at [lines 1263–1269](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js#L1263-L1269) and [1330–1337](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js#L1330-L1337), and claim at [1430–1434](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js#L1430-L1434). The public profile response invokes the sanitizer at [1093](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/cloudflare/src/index.js#L1093). This is source reachability, not a tested production disclosure.
- Product filter: [`daemons/go/internal/store/query.go`, lines 90–94](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/store/query.go#L90-L94). Aggregate query joins: [230–241](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/store/query.go#L230-L241) and [288–305](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/store/query.go#L288-L305).
- Effective event cost precedence: [`query.go`, lines 156–162](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/store/query.go#L156-L162). Raw aggregate cost/weighted rate expressions: [295–298](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/store/query.go#L295-L298).

## Cost and measurement boundaries

Current Go event `CostSource="reported"` means a file annotation selected the effective amount. It does not imply provider-issued usage reporting, invoice reconciliation or payment. Its separate `CostEquivalent` is an event-time catalog/list-price estimate, and the compatibility `/stats` path prefers that estimate when non-null ([compat.go, lines 27–49](https://github.com/castlemilk/token-horizon/blob/b468206e9378c8d7a6788b67072494982e7de17d/daemons/go/internal/api/compat.go#L27-L49)). The main study's synthetic `provider_reported` metric is a proposed source category, not proof that a provider billing adapter is implemented.

Both offline scripts assert the **observed source behavior**. Successful execution means those observations were reproduced, not that the proposed repairs are implemented. The SQLite harness evaluates exact expressions with a minimal schema and an explicitly authored equivalent of the Go effective-cost branch. It does not compile or start the Go daemon. The Node harness uses exact helper bodies and dependencies with only its clock injected. It does not start the worker, run authentication or query any profile.

No production timing, native release behavior, live tenant isolation, provider invoice accuracy, real email disclosure or full application correctness claim is made from these checks. Their outputs and runtime versions are saved next to the scripts.
