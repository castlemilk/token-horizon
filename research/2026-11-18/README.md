# Token Horizon Pro research handoff · 18 November 2026

Five completed research streams, reconciled against main `b468206e9378c8d7a6788b67072494982e7de17d`. SEO (track 4) is still in progress using public/source evidence; OpenSEO reauthentication was unavailable. This is a research preservation PR, not an implementation, merge or release.

## Original reports and artifacts

- [1: Market research](track-1/report.md)
- [2: UI, team management and scoped usage](track-2/bundle/token-horizon-track2-research.md) · [original bundle](track-2/bundle/) · [wireframes PDF](track-2/bundle/token-horizon-track2-wireframes.pdf)
- [3: Knowledge integration](track-3/bundle/Token-Horizon-Track-3-Knowledge-Graph-Specification.md) · [original bundle](track-3/bundle/)
- [5: Team and individual analytics](track-5/bundle/token-horizon-track5-specification.md) · [original bundle](track-5/bundle/)
- [6: Token and context analytics](track-6/bundle/token-horizon-track6-research-spec.md) · [original bundle](track-6/bundle/)

Original bundles preserve supplied PDFs, PNG/SVG wireframes, manifests, synthetic fixtures and recorded reference-test results. Use the bundle report above for relative companion links. The top-level `report.md` copies are text preservation copies. `artifact-manifest.json` records content hashes for all preserved files except the manifest itself. No research script was executed during synchronization; JSON parsing and file integrity checks do not validate the application. Findings and claimed synthetic checks remain attributed to their source studies.

## Deduplicated backlog

54 report-local packages extend existing issues instead of creating parallel roadmaps:

| Track | Packages | Canonical backlog |
|---|---|---|
| Market | MKT-01–12 | [#12 acceptance extension](https://github.com/castlemilk/token-horizon/issues/12#issuecomment-6973851898) |
| UI/team | T2-01–12 | [#12 acceptance extension](https://github.com/castlemilk/token-horizon/issues/12#issuecomment-6973853286) |
| Knowledge | KG-01–10 | [#16 acceptance extension](https://github.com/castlemilk/token-horizon/issues/16#issuecomment-6973854630) |
| Analytics | T5-01–10 | [#13 acceptance extension](https://github.com/castlemilk/token-horizon/issues/13#issuecomment-6973855541) |
| Tokens/context | TC-01–10 | [#13 acceptance extension](https://github.com/castlemilk/token-horizon/issues/13#issuecomment-6973856687) |

Focused child issues own the immediate implementation slices; report packages referring to them are not separate implementations:

- [#48](https://github.com/castlemilk/token-horizon/issues/48): TC-01/04 token normalization and stream finality.
- [#49](https://github.com/castlemilk/token-horizon/issues/49): T5-02 public DTO allowlist.
- [#50](https://github.com/castlemilk/token-horizon/issues/50): T5-04/TC-03 SQL/effective-value/identity parity.
- [#51](https://github.com/castlemilk/token-horizon/issues/51): TC-02 body consent and native missingness.
- [#52](https://github.com/castlemilk/token-horizon/issues/52): T5-01 calendar scope and denominators.
- [#53](https://github.com/castlemilk/token-horizon/issues/53): T2-01/03/09 private authority and exact report audience, prerequisite for T5-06/MKT-10 and shared knowledge.

Reuse existing #19/#41 for tariff and publication lineage, #23/#44 for performance/accessibility validation, and #26/#36/#39 for hermetic test ownership. Preserve #12's original roadmap and #13–16's wider requirements. No existing issue is closed by these reports.

## Common boundaries

Correct counts, coverage and privacy claims before expanding views. Public crews are not private finance tenants. Cash, commitments, API equivalents and unknown costs remain separate. Token volume is not employee productivity. Context insertion does not prove causal model use. Source findings and copied-expression synthetic probes do not establish production exposure, installed behavior or invoice impact. No real private usage or prompts are included. Any implementation must preserve existing ownership, original timestamps, idempotence and downward-correction contracts.

[Project Space](https://chatgpt.com/space/page_6af3b3f3a6308191a3b0fed46bc74230) holds the maintained synthesis; this directory holds dated research evidence.
