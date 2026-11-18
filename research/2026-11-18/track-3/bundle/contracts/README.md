# Draft contracts — not deployed or runtime validated

All identifiers and content in the example are synthetic. These files describe a proposed API and reviewed context-bundle format. They do not implement authentication, source authorization, retention, concurrency, token counting, export signing or deletion.

- `openapi.yaml`: OpenAPI 3.1 proposal; fixed recipes, strict request objects, independently gated export and deletion. No server URL is supplied because these endpoints do not exist.
- `context-bundle.schema.json`: JSON Schema 2020-12 for the example manifest. Schema validity cannot establish correct consent, rights or freshness.
- `bundle-example.json`: one invented reviewed decision with a source revision, review snapshot, destination and expiry. The example has no insertion receipt.

Production should bind the manifest to a canonical serialization and integrity digest. The trusted service derives workspace and actor from authentication; caller-provided strings never grant access. Preview and export use an opaque authorized-view token externally. Server-held state binds source versions and deletion generations, and rechecks current rights immediately before releasing bytes. Global epoch/revision counters are internal; unrelated hidden writes must not visibly change tokens or force re-review. Caller-provided tokens grant no authority. Reviewed/exported bundles exclude suggestions and unapproved items. Insertion is represented only by a separate authenticated receipt, outside this schema. The bundle's workspace reference is descriptive output, not an authorization input.

The main report is the governing proposal. The smaller reference Python model tests selected invariants with trusted synthetic subjects; it is not an HTTP/MCP implementation of this contract.
