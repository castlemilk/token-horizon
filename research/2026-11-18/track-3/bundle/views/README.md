# Original knowledge graph view proposals

**PROPOSAL · SYNTHETIC DATA · NOT IMPLEMENTED**

These two original static wireframes illustrate proposed Token Horizon knowledge graph and context handoff behavior. They are not screenshots of the current product and do not establish that any controls, content API, graph storage, delivery integration or telemetry has been implemented. All project names, source references, timestamps, decisions, context contents and quantities are synthetic. Example timestamps use Australia/Melbourne time (AEDT).

## Files

| View | Editable vector | Rendered preview |
| --- | --- | --- |
| Context evidence | `context-evidence-proposal.svg` | `context-evidence-proposal.png` |
| Review handoff | `review-handoff-proposal.svg` | `review-handoff-proposal.png` |

Each SVG and PNG is 1440 × 960 pixels. The SVGs contain text and vector shapes, without embedded screenshots, external assets, scripts or network references. The PNGs were rendered locally with the already-installed Inkscape renderer and visually inspected. No application interaction, responsive behavior or accessibility conformance was tested.

## Context evidence

The synthetic task **Resume parser review** is scoped to **Orion demo**. Its selected approved decision is `decision v3`. The optional graph shows the two-hop chain `source r7 → decision v3 → bundle v4`, with exact references distinguished from reviewed relations. Suggested relations have a separate legend style and are not presented as accepted evidence. A parallel evidence list provides the same visible references and states.

The explanation panel connects each item to its source and review state. Inclusion in a bundle does not establish that a client received or used the item. The time panel separates the example current time from the example known-at time, records the indexed source revision and communicates coverage limits. It provides no hidden-node labels, degrees or counts.

For implementation, the Current and Known at controls should map to explicitly documented valid-time and recorded-time semantics in the shared contract; these static labels alone do not implement bitemporal querying. Deletion and consent revocation must still suppress content in historical views.

## Review handoff

The selected synthetic bundle is `bundle v4`, with **Codex** as its proposed destination. It includes reviewed decision and constraint references plus a verification reference that still points to `source r6` while the selected revision is `source r7`. The stale verification blocks export until it is resolved and the user confirms the reviewed source/destination scope.

The view separates three states:

- **Available:** selected references are reviewable locally.
- **Returned:** this example state has returned no payload to a client.
- **Inserted:** unknown; a client insertion receipt would be needed to assert insertion.

The displayed token budget is an illustrative estimate, not measured token usage, a client context inspection, or a claim that any content was inserted. Omission policy reasons are visible without displaying private item labels or counts. **Local content / No team sharing** remains explicit. Export saves a reviewed local bundle; client insertion is a separate action whose evidence must be recorded separately.

Buttons, checkboxes and tabs are static proposed controls. No actual export, transfer or insertion was performed.

## Proposed accessibility and keyboard behavior

- Make the list an equivalent first-class view, with semantic table headers, source links and text states. The graph must be optional for completing the task.
- Present an ordered source-to-decision-to-bundle explanation in ordinary document reading order. Do not require perception of position, arrows or color to understand provenance.
- All actual controls should be reachable with Tab and activate with Enter or Space as appropriate. Source inspection should move focus into an explicitly titled panel and restore it to the initiating control when closed; Escape should close that panel where safe.
- Provide a visible focus indicator, sufficient target size and an explicit accessible name for every graph node, relation, selection checkbox and destination control. Avoid hundreds of canvas objects in the default tab sequence; provide a navigable list instead.
- State **Approved**, **Pinned**, **Stale**, **Unknown**, **Not returned** and any truncation in text. Color is supplementary.
- Announce changes to stale/review/export state through a concise live region. Explain why export is disabled and expose the review action in the tab order.
- Support text enlargement, responsive stacking and reduced motion. These are implementation acceptance criteria, not verified properties of these static images.

## Implementation dependencies

These views depend on a versioned evidence/bundle contract, exact source revision references, review state, freshness and deletion propagation, bounded authorization-aware retrieval, and separate available/returned/inserted receipts. They do not assume Swift owns a SQLite store. The proposed derived index should follow each platform's existing ownership model. Content endpoints also depend on the native server's explicit local binding, principal/capability enforcement and origin checks before exposing sensitive content.

