# Portfolio SEO audit — bounded offline execution
Date: 18 November 2026, Australia/Melbourne. Early timestamps below are exact **HTTP response Date-header values**, not separately measured local acquisition times. Late timestamps are the collector-supplied acquisition fields. This note records an additional executable follow-up to the issue/context audit.

## Source custody and execution

Inspected existing draft skill: [skunkworq/skunkworq-skills PR #32](https://github.com/skunkworq/skunkworq-skills/pull/32), immutable head **`0b456a340126e868559e0ce750ba7a2ccf855510`**.

Read in full before execution:

- `portfolio-seo-audit/SKILL.md`
- `references/evidence-contract.md`
- `references/snapshot-runner.md`
- `references/upstream-coverage.md`
- `references/openseo-adapter.md`
- `scripts/audit_snapshot.py`
- `scripts/audit_relationships.py`

The two scripts were saved unchanged to a temporary research directory. Their Git blob SHA-1 hashes were recomputed from local bytes and matched the connected GitHub fetch results exactly:

| Script | Bytes | Git blob SHA-1 | SHA-256 |
| --- | ---: | --- | --- |
| `audit_snapshot.py` | 8,806 | `39a09a63d38f1b6ac61a94a74ca309e52d6ea988` | `79efcb9433c074e447bb467639c98ae017ecb2a2b3ae11d43b33e384f93bfaa0` |
| `audit_relationships.py` | 5,991 | `1901681fc22aafa985743339bf45c4fd1de66b08` | `6b22d7a4310d6cfee5e4eda9b254ad9ed916d066fe2fc11d5909db9d10e45378` |

Review confirmed standard-library parsing and file I/O only: no network acquisition, subprocess, credential access or execution of page scripts. XML DTD/entity declarations are rejected before the sitemap parsing path. No package installation, source modification, upstream native/full claude-seo execution, paid service or OpenSEO authentication action occurred.

Each script was run once against each of two separate snapshot batches. All four invocations exited **0**, and every result was inspected. This means the bounded analyzer ran successfully; it does **not** mean the site passed an SEO audit. Unit fixtures were not rerun and are not claimed as tests performed here.

Invocation:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 audit_snapshot.py early_snapshot.json --output early_observations.json
PYTHONDONTWRITEBYTECODE=1 python3 audit_relationships.py early_snapshot.json --output early_relationships.json
PYTHONDONTWRITEBYTECODE=1 python3 audit_snapshot.py late_snapshot.json --output late_observations.json
PYTHONDONTWRITEBYTECODE=1 python3 audit_relationships.py late_snapshot.json --output late_relationships.json
```

## Input conversion and limits

The parent supplied fresh anonymous public-response capture files `live_early_capture.json` and `live_capture.json`. The conversion kept the batches separate and did not mix repeated URLs across times.

- Preserved actual captured URLs, decoded response bodies, timestamps, status, role and blocked/truncated flags.
- Copied only Content-Type and X-Robots-Tag headers needed by this analyzer.
- Preserved failure state as an explicit truthy error flag.
- Excluded query-bearing URLs **without stripping their query or relabeling the capture**.
- No HTML repair, URL normalization, inferred status, invented timestamp or source-file modification.
- All included URLs use the verified `token-horizon.dev` origin with no credentials, query or fragment.
- Inputs remain under 100 records, 2 MiB per decoded body, and 24 MiB per file.
- Original-to-subset index mapping, inclusion/exclusion reasons and input/snapshot hashes are recorded in each manifest.

**Collector metadata correction:** the late input labels its user agent `Python-urllib/3.11`, but the parent confirmed the collector actually ran on Python **3.12.14** with no UA override. Its effective default UA was therefore **`Python-urllib/3.12`**. The late manifest records both the original erroneous label and the correction/basis. The original source capture was left intact. The parent subsequently verified the original early collector command: **GET, explicit UA `TokenHorizon-ReadOnly-Research/1.0`, no cookies/authentication**. The early manifest records that provenance. Its supplied `fetched_at` fields derive from **response Date headers**, not a separately recorded local clock; the analyzer output field name does not change that limitation. The homepage reader requested 30,000 bytes but output only the first 20,000 decoded characters, correctly preserving `truncated:true`.

Raw challenge bodies and full response captures are internal intermediates. The analyzer output emits hashes and counts/observations, not captured HTML, schema content, raw headers or private analytics.

## Measured subset: early captures

| Actual supplied response | HTTP Date UTC | Capture status | Offline result |
| --- | --- | ---: | --- |
| `https://token-horizon.dev/robots.txt` | 2026-11-18 08:11:53Z | 200; complete | `robots-lines-only`: **1 User-agent line; 1 sitemap declaration** |
| `https://token-horizon.dev/sitemap.xml` | 2026-11-18 08:12:00Z | 200; complete | `sitemap-structure-only`: **urlset; 13 loc elements** |
| `https://token-horizon.dev/` | 2026-11-18 08:12:12Z | 200; **truncated** | Correctly **not analyzed**; `response_unavailable` means incomplete input in this case, not an unavailable homepage |

**Sample size: 3. Analyzed raw HTML pages: 0.** The homepage's capture flag is preserved; it cannot support full-page element counts.

Body hashes of complete early robots/sitemap captures:

- Robots: `2e557edfb514c978a3dfb28ecc1ced1f8b4cd2fc0b4fd876623ec199ba767424`.
- Sitemap: `140865fdfa287ab10f37bc875bee7dc4be7a8eda0499680c3e49648c3f9d0356`.

These equal the earlier 18 November captures preserved in [#18's historical follow-up](https://github.com/castlemilk/token-horizon/issues/18#issuecomment-6966846511). The exact-body match supports stability of these two documents between those captures; it does not establish Google indexation, crawler access or complete site stability.

### Relationship analyzer interpretation

The early sitemap relationship report counted **13 locations**:

- **1 captured target**: the homepage, which remains not analyzed because its capture is truncated.
- **7 not-in-sample targets**: missing coverage, not broken pages.
- **5 `invalid-or-sensitive-target` results**: the existing runner deliberately refuses query-bearing URLs. Manual inspection confirms these are the public `view=teams`, `view=leagues`, and model `tab=cheapest/providers/plans` sitemap locations. **This label does not mean five sitemap URLs are invalid, private, sensitive or SEO defects.** It is an analyzer limitation.
- No canonical or hreflang page relationships were analyzed, because no complete raw HTML page qualified.
- Duplicate capture URLs: 0.

### Manual examination, distinct from analyzer counts

The complete early robots body explicitly states that public pages/rendering data are crawlable and private HTML uses noindex; its comment says robots is not access control. It contains allow exceptions under `/api/` and specific disallows, including `/mcp`; interpretation must respect the full matching rules. The offline counter does not evaluate which user agents may fetch which URL.

The complete early sitemap lists home, leaderboard, teams/leagues query views, model explorer and three model tabs, docs, benchmarks, blog index, and two `.html` article aliases. This independently confirms **current discovery entries** in that capture. It does not freshly reproduce the article redirect/canonical mismatch: the late article probes were unavailable, and that mismatch remains supported by the earlier issue evidence plus source inspection until a successful fresh response comparison is available.

## Measured subset: late captures

The serialized outcomes in the parent late batch carry times from 08:57:50 to 08:58:34 UTC. The collector planned **27 requests**, serialized **24 outcomes** before its 55-second timeout, and left **3 host/scheme variants without reliable serialized outcomes**. Missing results do not prove those requests were unattempted or that no network occurred; their status remains unknown.

- Source records: **24**.
- Query-bearing records excluded intact: **6**.
- Query-free included records: **18**.
- Included results: **15 blocked HTTP 403 responses; 3 timed-out requests with no status**.
- Analyzed raw HTML pages: **0**.
- All 18 records correctly reported `analysis:not-tested` and `response_unavailable`.
- Relationship pages: **0**; analyzable sitemaps: **0**; duplicate capture URLs: **0**.

The parent identified a Cloudflare access-denied response with code 1010 and stopped further HTTP probes. This analyzer itself does not diagnose the edge policy, distinguish crawler behavior or make a site-outage claim. Root browser observations are a separate evidence method.

The unsupported public query captures remain available to the parent as original evidence. They were not silently removed from the research denominator or converted into query-free pages.

## Capabilities run versus unavailable

| Capability | This execution |
| --- | --- |
| Existing portfolio SEO methodology | Applied to provenance, scope, observation classification and honest access limits |
| Offline raw-response analyzer | **Ran**, separate early and late batches |
| Offline cross-page relationship analyzer | **Ran**, separate early and late batches; actual matched scope described above |
| Validated full raw HTML metadata/heading/image counts | **Unavailable for these capture batches**; complete HTML never qualified |
| Robots policy interpretation | Manual review separate from line counts; not evaluated by script |
| Sitemap XML structure/count | Measured on the complete early sitemap only |
| Article alias/canonical fresh verification | Not resolved by this execution |
| Browser rendering, keyboard/mobile/a11y | Not measured by this analyzer; parent evidence must be reported separately |
| Structured-data semantics/rich-result eligibility | Not tested |
| Lab performance / field CWV | Not tested |
| Search Console / rankings / traffic / keyword volume / backlinks | Not tested; parent confirmed expired OpenSEO auth, no reconnect attempted |
| Full crawl / native full claude-seo | Not run |
| Fixtures/unit tests for these scripts | Not rerun; no fixture result presented as a live-site measurement |

The `not-tested` fields in script output describe **this analyzer's scope**, not whether another part of the parent audit performed a separate browser/source/manual check.

## Output inventory

All paths below are under `research/seo_skill_runtime/`:

- `early_observations.json`
- `early_relationships.json`
- `early_manifest.json`
- `late_observations.json`
- `late_relationships.json`
- `late_manifest.json`
- This execution note is `../seo_skill_execution.md`.

The `*_snapshot.json` inputs and downloaded scripts are temporary working material, not recommended user-facing attachments. No shared repository, issue, comment, deployment, analytics setting, permission or account was changed.

