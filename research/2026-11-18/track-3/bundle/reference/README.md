# Synthetic SQLite evidence graph reference

**Proposal and isolated experiment — not Token Horizon production code, a migration, or a product benchmark.**

This companion to the Token Horizon Track 3 specification exercises selected authorization, provenance, temporal and deletion invariants using Python's standard library and an in-memory SQLite database. It imports no Token Horizon modules, uses no real accounts/usage/prompts, makes no network calls and installs nothing.

The research source baseline is `main` at `b468206e9378c8d7a6788b67072494982e7de17d`. That repository code was **not executed by this reference**.

## Files and execution

| File | Purpose |
|---|---|
| `schema.sql` | Proposed ordinary SQLite tables, workspace-composite keys, typed-edge constraints, immutable version rows and derived FTS5 index. |
| `fixture.json` | Entirely synthetic nodes, scopes, memberships, sources, bitemporal examples, evidence and deterministic fanout recipe. |
| `validate.py` | Reference implementation plus 25 meaningful invariant cases and two deliberately constructed retrieval examples. |
| `results.json` | Actual run results, runtime versions, input hashes, toy timings and explicit limitations. |

From this directory:

```bash
python3 validate.py --output results.json
```

The only runtime requirement is Python 3 with its standard `sqlite3` module compiled with FTS5. The recorded run used **Python 3.12.14 and SQLite 3.53.1 on Linux**. Each case gets a fresh in-memory database; the runner writes only its local result file.

## What is actually tested

The current fixture expands to **76 node versions, 56 edges and 76 FTS rows**. The results file records **25/25 passing cases**. These are reference invariants, not tests of Token Horizon's implementation.

| Case family | Failure that the fixture must detect |
|---|---|
| Tenant isolation and database constraints | Identical version IDs in two workspaces collide, a composite FK crosses workspaces, or a typed edge joins unsupported kinds. |
| Identity and membership | A public team membership grants private graph access; a caller reads another workspace simply by naming it. |
| Traversal | An unauthorized seed or hidden middle node can expose an otherwise visible downstream node, path or count. |
| Supporting evidence | A derived assertion survives unreadable evidence, or an edge with no/hidden supporting source becomes traversable. |
| Conjunctive scopes | Access to one of several required scopes is treated as sufficient. Empty scope requirements become public. |
| Export | A viewer exports; a read grant is mistaken for export authority; revoked read rights leave a fresh export possible; edge proof is omitted from export checks. |
| Revocation and caches | Membership, role, grant or source revocation leaves cached or previewed data available; a new projection revision leaves a complete-result cache stale. |
| Temporal semantics | A late correction is applied before it was known, erases the prior valid-time interval, or resurrects content after current access/source revocation. |
| Replay and immutability | Reimport creates another source row, silently changes an immutable version payload or resets a revoked source. |
| Bounded execution | A cycle repeats forever; fanout exceeds result budgets; a SQLite execution interruption returns an unsafe partial result. |
| Unknown and stale evidence | An unknown event timestamp is silently treated as current, or stale evidence is exported without refresh. |
| Deletion | Only the source disappears while derived synthesis, reviewed bundle, FTS hits or cache entries survive; a tombstoned version is replayed; revoked or unknown-time sources become impossible to erase. |
| Independent evidence | Deleting one constituent preserves a synthesis that required both; alternatively, an independently supported assertion is unnecessarily treated as the same synthesis. |
| Untrusted text | Stored instruction-like or SQL-like text is executed. |
| Ranking | A hidden matching document changes visible full-text ranking, ordering or result count. |

These cases contain several checks each. The summary count denotes named cases, not an assertion count.

## Minimal data model

Nodes have a `kind` constrained to **Project, Task, Bundle, ContextItem, SourceRevision, Session or Attempt**. The primary key is `(workspace_id, version_id)`; `logical_id` groups a subject's immutable historical versions. Every ordinary-table FK carries the workspace. A stable ID in workspace alpha has no meaning in beta without beta's own record and authorization.

`kg_edge_version` references immutable source/target node versions and allows a small enumerated set of typed relations: project containment/context, task bundle, bundle inclusion, context relation/citation, session project/attempt and attempt observation. It is a projection for specific questions, not an unrestricted user-defined query language.

`kg_node_evidence` and `kg_edge_evidence` link to `SourceRevision` rows with separately stored current lifecycle. **Every supporting input is required.** The reference does not treat two evidence rows as alternatives. A synthesis from sources A and B disappears if either is deleted or no longer readable. A claim independently supported by B is a separate assertion with its own ID and dependencies. Raw source revisions may be terminal; a source revision with upstream dependencies must authorize those inputs too. Its source type cannot bypass the evidence checks.

`kg_dependency` records derived-content dependencies. Evidence insertion also records its dependency, while reads and deletion closure independently consult direct evidence links. Bundle dependencies include each approved constituent, so removal invalidates the whole reviewed bundle version rather than quietly changing its contents.

Scope requirements are split into `kg_node_scope` and `kg_edge_scope` to retain real composite FKs. Effective access is the conjunction of the resource's requirements **and every required supporting resource**. There is no lowest-common-denominator or union-of-audiences shortcut.

## Authorization contract

The local functions accept a trusted synthetic `subject` argument. **This is not authentication.** A production handler must derive identity from the established session or delegated credential and must not accept an arbitrary caller-selected subject.

The reference checks:

1. Active membership in the exact workspace.
2. Readable seed and resource scope.
3. Every traversed edge and both endpoints.
4. Every required evidence source and transitive derivation input.
5. Current source lifecycle, even for historical queries.
6. At export, an export-capable role **and both read and export grants** for every resource and required source.
7. At edge export, both endpoint inclusion and the edge's own scope/evidence.
8. The current typed snapshot `(policy_epoch, graph_revision)` when reading a cache entry or completing an export preview; a missing/mismatched token never silently becomes current.

An absent resource and an unauthorized seed both return the same `not_available` shape. Query outputs include only authorized IDs, paths and visible result counts; they do not return inspected-hidden counts, corpus totals, hidden-degree statistics or hidden-source labels.

An owner needs an explicit, scoped `erase` grant to erase a source. Erasure authority is independent of content readability, source lifecycle and event time, so revoked/expired/unknown-time data can still be removed. Erasure responses identify only the requested source and completion state, never hidden descendants or their counts.

Projection triggers advance `graph_revision` for node, edge, scope, evidence, dependency, lifecycle and tombstone changes. Membership/grant changes advance the separate policy epoch. Cache entries also recheck current rights. The toy cache's `label` stands for a trusted canonical query key; a production key must include the seed, limits, valid/known cutoffs and permission mode. Arbitrary client labels are not safe cache keys.

A production design additionally needs transactionally consistent authorization snapshots, stale-session handling, scoped service identities, audit records, export byte limits and destination consent. This file does not implement that transport/service boundary.

## Temporal and lifecycle semantics

The two clocks are separate:

- `valid_from` / `valid_to`: when the assertion applies to the world.
- `recorded_from` / `recorded_to`: when this version belonged to the system's known state.

Intervals are half-open. The synthetic correction became known on 10 November but applies from 5 November. A query known on 8 November sees the original version. A later query for 7 November sees the correction. A later query for 3 November sees the preserved historical original interval.

The fixture inserts these preclosed intervals. It does **not** implement the atomic production writer that closes/splits recorded intervals while inserting replacement versions. Ambiguous visible versions fail explicitly rather than being picked arbitrarily.

An unknown `valid_from` is excluded from ordinary time-scoped retrieval. An explicit inspection may return it as unknown; export still denies it. Stale sources can be inspected, but are not exportable.

Current ACL and source lifecycle always override historical cutoffs. An old `known_at` is not a route to reading deleted or revoked material.

## Retrieval and explanation examples

The two examples are deliberately constructed to make the distinction between text matching and explicit relationships easy to inspect.

**Q1: reviewed task handoff.** The word “handoff” matches a glossary outside the approved repair bundle. The task's two-hop bundle relation yields the three required context items. An ordinary, fixed relational join yields the **same three items**. This proves the fixture can express the relationship without a specialized graph database. It does not prove that a graph outperforms a well-designed relational product.

**Q2: attempt explanation.** A cancellation keyword matches a different context item. The attempt's explicit observation and citation relations lead to its own context item and source. This is known fixture topology, not inferred factual correctness.

`results.json` records the exact result IDs, paths, known required items and single-run elapsed times. Q1 reports a depth truncation because one context item has an additional citation beyond the requested two-hop view; the required bundle members are all present. There is no claim of real-user utility, accuracy uplift, percentile latency, production scalability or customer cost saving.

Full-text search uses FTS5 **only to produce candidate IDs**. After current authorization, the reference computes a simple term count from visible text and uses immutable IDs for ties. It does not use `bm25`, global term frequencies or a total count from the private corpus. The fixture verifies that inserting a hidden matching document leaves visible IDs, scores and counts unchanged. ASCII tokenization and OR matching are intentionally simple; this is not a multilingual or phrase-search implementation.

## Bounds and deletion

The synthetic store is limited to 500 nodes and 1,000 edges. Traversal allows at most four hops, 100 returned nodes and 150 returned edges; tests use tighter budgets. Required-support recursion is limited to 12 resources. SQLite's progress handler can interrupt traversal; an interrupted operation returns no partial graph. These are illustrative bounds, not recommended production defaults. The reference does not establish constant-time noninterference. The inert-text case verifies SQL/data handling in this Python process; it does not establish an LLM's resistance to prompt injection.

Deleting a source first computes the complete dependency closure, including reviewed bundles and any all-required synthesis. In one local transaction it records tombstones, removes affected edges and nodes, removes their FTS entries and advances revision/epoch state. Cache entries for the workspace are purged. Reimport of a tombstoned version is rejected. A separately supported claim remains available. The closure is inspected by the tests through privileged local SQL, not disclosed in the source eraser's response.

**The erasure evidence is logical only:** rows, FTS matches and cache entries become unavailable. The in-memory experiment does not establish removal from SQLite free pages/WAL, disk snapshots, backups, logs, external exports or other recipients' copies. No embeddings exist in this prototype; a production vector index would need the same deletion/revocation controls.

## Explicit omissions

This reference is deliberately smaller than the proposed product. It has no real collector, OAuth server, HTTP/MCP transport, daemon integration, device synchronization, embedding model, extraction LLM, graph database, background worker, durable export store or production migration. It does not verify physical erasure, concurrent correction writers, end-to-end retention deadlines or durable multi-device revocation. Runtime measurements are toy observations only.

Use the passing cases as a reviewable contract seed. Port them to the actual implementation and its existing test commands; do not present this companion as proof that the production feature has shipped.


## Public snapshot boundary

The miniature model uses trusted internal `(policy_epoch, graph_revision)` pairs. The production API proposal instead exposes an opaque authorized-view snapshot, with global counters retained internally. This reference does not establish hidden-write timing or token noninterference; unrelated private writes must not become a public activity counter or a visible reason to re-review unchanged authorized content.
