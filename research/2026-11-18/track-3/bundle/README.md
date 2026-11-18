# Token Horizon - Track 3 research pack

**Read-only research and proposals, 18 November 2026 (Australia/Melbourne).**

Source baseline: `castlemilk/token-horizon`, `main`, `b468206e9378c8d7a6788b67072494982e7de17d` (18 November 2026, 07:35:19 UTC). Shared repositories, issues, PRs, deployments, publication settings and permissions were not changed.

## Read first

- `Token-Horizon-Track-3-Knowledge-Graph-Specification.pdf`: complete 34-page report, original views, source register and 10 proposed backlog slices.
- `Token-Horizon-Track-3-Knowledge-Graph-Specification.md`: editable source of the same substantive specification; relative images resolve within this pack.
- `evidence-register.json`: sanitized source baseline, 58 inspected repository paths with blob hashes, dated issue inventory and public/context links. It contains no raw account data.

## Reviewable proposals

- `views/`: two original SVG/PNG wireframes and design rationale, explicitly labeled PROPOSAL / SYNTHETIC DATA / NOT IMPLEMENTED.
- `contracts/`: draft OpenAPI 3.1, reviewed-bundle JSON Schema, a synthetic example and limitations. These endpoints are not implemented.
- `reference/`: isolated SQLite schema, synthetic fixtures, Python invariant checker and measured result receipt. This is not Token Horizon production code or a migration.
- `artifact-validation.json`: checks performed on the deliverable itself, with their limitations.
- `SHA256SUMS`: integrity hashes of the final pack files, excluding itself.

## Measured reference result

25/25 named invariant cases passed in a fresh in-memory SQLite fixture with 76 node versions and 56 edges. The final run used Python 3.12.14 / SQLite 3.53.1 and took 0.3827 seconds including fixture setup per case. That timing does not establish product latency, security, scalability or utility.

A deliberately constructed handoff query returns the same three required items through graph traversal and an ordinary fixed SQL join. It supports the feasibility of the relational representation; it does not establish a graph's superiority over a strong relational baseline.

Reproduce from `reference/` with:

```bash
python3 validate.py --output results.json
```

It requires Python's standard SQLite module with FTS5, uses synthetic data only, makes no network calls and installs nothing. Review the explicit omissions in `reference/README.md` before reusing any code. The API proposal has additional production controls, including opaque authorized-view tokens, which the toy does not implement.

## Decision

Start with reviewed versioned handoff files. Add a bounded SQLite evidence projection only when it improves source explanation, stale-context detection or continuation over manifest/search baselines. Extend existing issues #12 and #16, coordinating #13/#19/#26/#39/#41. New graph infrastructure, hosted private memory and semantic extraction remain gated proposals.
