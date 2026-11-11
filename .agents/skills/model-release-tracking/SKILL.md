---
name: model-release-tracking
description: Use when a model provider releases, renames, reprices, reroutes or deprecates a model, when adding a model to the Token Horizon benchmark registry, when checking what changed under an existing model id, or when comparing a new model with its predecessor and writing the release note. It covers benchmarks/lib/lab/llm-benchmark/registry.ts, the claude-family, claude-effort and claude-smoke sweep profiles, the report's scopes, vendor-claimed versus measured scores, and the release note.
---

# Model release tracking (benchmark side)

This skill covers the benchmark side of a model change: confirming the id, writing the registry entry, running the release comparison and writing it up. The product's model catalogue is a separate system; section 2 says how the two relate.

Every sweep in this skill makes paid API calls. Get the operator's approval, state the budget cap, and run `--dump-config` before any run.

Paths start at the token-horizon root. Commands run from `benchmarks/` unless stated.

---

## 1. Vocabulary

- **Model id** (`BenchmarkModel.id`): the key used in `results.json` (`modelId`), the response cache, the profile lists and `--model`. Never reuse an id for a different model or a different pin.
- **API id** (`apiModelId`): the string sent to the provider. A base entry omits it because its id is the API id. An effort variant sets it.
- **Base entry**: the model at the provider's documented default effort, for example `claude-opus-5-5` pinned to `medium`.
- **Effort variant**: the same API id and prices with a different pinned effort, for example `claude-opus-5-5-high`. It is its own board row because effort is part of what is measured. Its `baseModelId` names the base.
- **Predecessor**: the previous model in the same family and tier, named in the release note (for example `claude-opus-5` for `claude-opus-5-5`, and `claude-fable-5-1` for `claude-fable-5-2`).

## 2. How this relates to the product catalogue

- The product catalogue (see the `model-catalog` skill) discovers models from models.dev, live provider lists, usage data and its own benchmark tables. It does not read the registry, and the registry does not feed the app.
- A new model can appear in the app with no registry entry, and a registry entry does not make a model appear in the app.
- Registry prices are entered by hand from the provider's own pricing page. Aggregators (LiteLLM, models.dev, OpenRouter) are cross-checks only.
- The product already separates provider-announced scores (`clients/macos/Resources/benchmarks.json`, flagged `approx`) from leaderboard scores (`benchmarks-sourced.json`). Section 7 applies the same separation to the harness.
- Do not copy catalogue scores into registry blurbs. The `glm-5.3-coding-plan` blurb already quotes catalogue scores; do not add more of that pattern.
- Curated scores live in `clients/macos/Resources/benchmarks.json`, the single source of truth; edit it directly. `python3 scripts/update-catalog.py` only reports where its curated list differs from that file, and writes only with `--add-missing` or `--overwrite` (`model-catalog` skill, section 2).

## 3. Sources and their authority

Trust them in this order.

1. **The provider's own model list, pricing page and model docs.** This is the authority. For Anthropic the list is the Models API (section 4); the docs are the Claude Platform models overview, which is the `modelCardUrl` on every Anthropic entry.
2. **The provider's deprecation page.** For Anthropic: at least 60 days' notice for publicly released models on Anthropic-operated platforms. Amazon Bedrock and Google-managed Google Cloud set their own dates. Active models can carry a tentative "not sooner than" date, and the page has a separate table of API parameter deprecations.
3. **OpenRouter's models endpoint.** Useful fields: `expiration_date`, `default_effort`, `supported_efforts`, `alias_target` and `pricing`. A top-level price does not cover every request: `pricing` can carry time-window and prompt-length overrides, so read the overrides before pricing a request.
4. **LiteLLM's `model_prices_and_context_window.json` and models.dev's `api.json`.** Both are community-maintained. The LiteLLM file is per token and has sparse fields (`deprecation_date`, `reasoning_effort_levels`). The models.dev file has `status: deprecated`. Cross-check only.
5. **Landscape notes from 2026-11-10.** They are not in the repository. Treat them as leads: their secondary figures (leaderboards, company numbers) go stale quickly, so re-check any of them against the provider before use.

Retired ids can reroute. Gemini reroutes named ids on fixed dates. OpenAI maps some retired ids to a successor with a changed request shape. A tracker must watch the id, the served model and the price separately.

## 4. Confirm the id with the provider

For Anthropic, list the models with the key from `ANTHROPIC_API_KEY_FILE` and print ids only. The key file's location is personal configuration that the operator supplies. Refer to it only by that variable name. Never print, copy or log the key, the headers or the response body.

The sweep uses `ANTHROPIC_API_KEY` when that variable is set, and reads `ANTHROPIC_API_KEY_FILE` only otherwise. A missing, unreadable or empty file, with no environment key, stops an Anthropic sweep. The snippet below reads the file, so it checks the file's key whatever the environment holds.

```sh
umask 077
f="${ANTHROPIC_API_KEY_FILE:?set ANTHROPIC_API_KEY_FILE}"; f="${f/#\~/$HOME}"
h=$(mktemp)
k=$(grep -E '^(export )?ANTHROPIC_API_KEY=' "$f" | head -n 1 | sed 's/[[:space:]]#.*$//' | cut -d= -f2- | tr -d "\"'")
[ -n "$k" ] || { [ "$(grep -c . "$f")" -eq 1 ] && k=$(head -n 1 "$f" | sed 's/[[:space:]]#.*$//'); }
printf 'x-api-key: %s\n' "$k" > "$h"
unset k
curl -sSf 'https://api.anthropic.com/v1/models?limit=1000' -H @"$h" -H 'anthropic-version: 2023-06-01' | jq -r '.data[].id'
rm -f "$h"
```

- The new id must appear in the output. If `has_more` is true in the response, repeat the call with `after_id` set to `last_id`.
- For the released date, print only that field: `jq -r --arg id "<id>" '.data[] | select(.id == $id) | .created_at'`.
- If the id is missing, check the spelling against the release post and the deprecation page before concluding that it is retired. Do not add a registry entry for an id the list does not show.
- For other providers, use that provider's own list endpoint with its own key variable. OpenAI's list carries `shutdown_date`. OpenRouter's models endpoint carries `expiration_date` and the effort fields.

## 5. Write the registry entries

File: `benchmarks/lib/lab/llm-benchmark/registry.ts`, in the Anthropic block after `claude-4`. Field definitions: `benchmarks/lib/lab/llm-benchmark/types.ts` (`BenchmarkModel`).

1. **Base entry.** Pin `reasoningEffort` to the provider's documented default, checked on the day you write it. The current pins are Fable 5.2 `high`, Opus 5.5 `medium`, Sonnet 5.5 `high` and Haiku 5.5 `medium`.
2. **Effort variants.** Add `<base>-<level>` entries for the levels the comparison needs. Each sets `apiModelId` to the base's API id and `baseModelId` to the base's registry id, copies the base's two prices and `contextWindow` exactly, sets `reasoningEffort` and the tag `effort:<level>`, and says "Same API model and prices as <base>" in the blurb. `registry.test.ts` fails when an effort variant's API id or prices differ from its base.
3. **Accepted efforts.** `low`, `medium`, `high`, `xhigh` and `max`. Never `ultra`: the Anthropic runner rejects it. Haiku 4.5 accepts no effort, so its entry pins none (tag `effort:none`).
4. **Thinking.** Set `thinking: 'adaptive'` only on Opus 4.6, Opus 4.7, Opus 4.8 and Sonnet 4.6. The 5.x entries carry no `thinking` key, and the tests enforce both rules.
5. **Prices.** Divide the provider's USD price per million tokens by 1,000, exactly, and write a decimal literal. $0.10 per million input is `0.0001`. $0.50 per million output is `0.0005`. $8 per million input is `0.008`. Do not round or estimate. Cache, batch, priority and long-context prices are not in the registry: state any tier that matters in the blurb. Haiku 5.5's prices apply to prompts of 100,000 tokens or fewer, which every benchmark task is.
6. **Price under review.** A positive price below one US cent per million tokens (a per-1k value below `0.00001`) is flagged by the report (`PRICE_REVIEW_BELOW_PER_M` in `benchmarks/lib/lab/report/board.ts`). The flag hides the cost. Keep a price the provider states, expect the flag, and say so in the release note. A price of exactly zero means a free or subscription route and is not a review case. Example at the time of writing: `gemini-3.6-flash` (OpenRouter).
7. **Never guess a price.** If the provider's page does not state it, leave the entry out and say why. An aggregator figure may appear in the release note only as "aggregator-sourced, unconfirmed".
8. **`contextWindow`** from the provider's documentation. **`maxOutputTokens`** only when the provider's cap is below the runner default of 128,000 (the default was raised from 64,000 on 2026-11-10, and the cap includes reasoning tokens). Haiku 4.5 is set to 32,000.
9. **`released`** as ISO `yyyy-mm-dd`, from the provider list's `created_at` or the announcement. Older entries use `yyyy-mm`; use the full date for new ones.
10. **`tags`, `blurb`.** Factual, with no superlatives and no scores. The blurb states the effort pin.
11. **Copy the existing pattern** for `company`, `family`, `vendorUrl` and `modelCardUrl`. Put the new base entry and its variants ahead of the older entries of the family: the Anthropic list runs newest first, directly after `claude-4`. Do not reorder existing entries.
12. **Identity rules.** Built-in ids must be unique. A plugin model that reuses a built-in model id throws when the registry mounts. Never delete an entry that has results: `registry.test.ts` requires every result to reference a valid model. Mark retirement in the release note instead.

Checks, all free: `npx vitest run lib/lab/llm-benchmark/registry.test.ts`, then `npm run typecheck`, then `task dump -- --model <id> --task <one task>` (prints the effective config and runs nothing).

## 6. Run the release comparison

Profiles in `lib/lab/llm-benchmark/sweep-profiles.json`:

- `claude-family`: Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 at their registry efforts, on the 11 headline tasks. 3 iterations, concurrency 2, 25-minute per-call cap, 1 retry, $45 cap per model.
- `claude-effort`: the effort variants (Haiku 5.5 and Sonnet 5.5 at low and xhigh, Opus 5.5 at low and high, Fable 5.2 at low) on the same 11 tasks. Same shape, $30 cap per model.
- `claude-smoke`: Haiku 5.5 on the seven smoke tasks, a wiring check. 3 iterations, $2 cap. Its outcomes are never ranked.

**Headline ids.** The claude-family profile sets them, so pass `--task` only to narrow a run: tic-tac-toe, gateway-console, voxel-lighthouse, car-racer, orbit-lab, pathfinding-lab, rlc-response-lab, bicycle-blueprint, sector-clock, kanban-keyboard-undo, seat-pricing. The first four come from plugins (tic-tac-toe from community-tasks, gateway-console from gateway-tasks, voxel-lighthouse and car-racer from visual-games). The seven Horizon tasks come from horizon-suite. `--task` takes task ids, not slugs, and naming a task whose plugin the sweep does not mount is fatal.

**Preconditions.** No other sweep or monitor is running: `pgrep -fl 'run-benchmark.mjs|sweep-recovery.mjs'` must print nothing. Two processes share `.cache/llm-benchmark-responses.json`, which each loads once and rewrites whole (`cache.ts`), so a concurrent run loses paid cached responses. If a sweep is live, wait for it. `benchmarks/` is committed. The `run` and `profile` Taskfile tasks refuse to start while `lib/lab/llm-benchmark/results.json` is untracked. The direct `npm run bench` commands below skip that check, so confirm tracking yourself, or run the family sweep as `task bench:profile -- claude-family --model <new>,<predecessor>`. Make git commits only if the operator asks.

1. **Plan.** `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_AUTH_TOKEN npm run bench -- --profile claude-family --model <new>,<predecessor> --dump-config`. Check the models, three iterations, concurrency 2, the 25-minute per-call cap, one retry, the $45 cap per model, and that the sandbox line reads `chromium`.
2. **Pilot.** One headline task, one iteration, the new model only, with a small cap. `mkdir -p tmp`, then `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_AUTH_TOKEN RESULTS_OUT_PATH=tmp/pilot-<new>.json npm run bench -- --profile smoke --model <new> --task <one> --timeout-ms 1500000 --max-retries 1 --budget-max-usd <n>`. The runner's default per-call cap is 10 minutes, which a high-effort answer at the 128,000-token cap can exceed; a call cut off by the cap is still billed. The scratch file starts as a copy of the board, so the committed `results.json` is not written. Find the pilot record by `.runLogRef.runId` equal to the printed sweep root and `.iterations == 1`. Check that it is complete and not truncated, and check its effort with `head -n 1 sweeps/<run-id>/<new>-<one>.jsonl | jq -r .configSnapshot.reasoningEffort`. The pilot's paid reply is cached, so the family run pays only for iterations it has not yet seen.
3. **Family run.** `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_AUTH_TOKEN npm run bench -- --profile claude-family --model <new>,<predecessor>`. Precedence is flag, then environment, then profile, then default, so `--model` replaces the profile's four-model list. The predecessor is re-run here so that both models are scored under the same scorer version and task versions. Do not compare with stored records from before the run. While it runs:
   - At most one artifact is scored in the browser at a time (`BENCH_SCORE_CONCURRENCY`, default 1). Generation is not limited, only browser scoring.
   - A truncated or refused iteration does not end its pair: the remaining iterations still run.
   - A check that times out is rescored once after a 2-second wait. If the rescore also times out, the harness waits, probes a fresh browser, rescores once more, and stops the sweep without writing a record for that pair.
   - Browser death is detected from the Browser object only, never from error text.
4. **Verify.** `npx tsx scripts/verify-results.mjs`. Confirm on both models' new records: `scorerVersion: 2`, `scoreAllTrials` present, and the same `promptBundle` (same prompt and prelude). Note any record carrying `budgetExceeded` or `quotaNextResetAt`, because it stopped early.
5. **Report.** `npx tsx report/capture-isolation-test.mjs` first (stop on exit 1), then `npx tsx report/capture.mjs --models <new>,<predecessor> --tasks <the headline ids under "Headline ids" above>`, then `npx tsx report/build.mjs`, then `npx tsx report/dist-check.mjs` (stop on exit 1), then `node report/serve.mjs 8787` to look locally. Read steps 1 and 1a of `benchmarks/report/README.md` first.
   - Capture renders stored HTML in headless Chromium with Chromium's sandbox and web security left on. Every connection goes to a proxy at `127.0.0.1:9` that is not listening, loopback is not bypassed, WebRTC may not send UDP outside that proxy, and each request is also aborted at the route level. `report/capture-isolation-test.mjs` checks the network block with a hostile artifact.
   - The page never runs model-written HTML. Each gallery item shows two stored captures, the check results, and the cost, tokens and time. To run an artifact again, use the command its dialog gives, which scores it inside the harness sandbox.
6. **Compare.** Put `score` and `scoreAllTrials` side by side, with completed and requested iterations, failure reasons and cost per task run. The report keeps scorer versions apart: Headline tasks, Horizon tasks and Smoke tier hold only version-2 records, and Earlier runs (scorer v1) is a separate scope labelled not comparable. Never rank version 1 and version 2 records together, including outside the report. Never rank a record that a budget or quota stop cut short.

## 7. Vendor-claimed and measured scores

- **Vendor-claimed**: numbers the provider publishes about its model (launch post, model card, its own benchmark tables), with the settings it states.
- **Measured**: our records in `results.json`, produced by `scripts/run-benchmark.mjs` under a known scorer version.
- Keep vendor numbers out of `registry.ts`, `results.json`, blurbs and report data. Record them only in the release note under "Vendor-claimed, not measured here", with the source URL, the date you read it and the settings given.
- Never sort, rank or chart a vendor number beside a measured one. Do not say a measured score confirms a vendor claim unless the settings match, and then say so.
- An aggregator leaderboard is someone else's measurement. Record it with the same separation, and with its version.

## 8. Change under the same id

| What changed | How to detect it | What to do |
|---|---|---|
| Price | Provider pricing page, cross-checked against LiteLLM or OpenRouter | Update the base and every variant (the tests require them equal). Note the date and both prices in the release note. |
| Documented default effort | Provider docs | Decide whether the id still means the old pin. Either keep the pin and note the change, or add a new variant. Never silently re-pin. |
| Pinned effort or API id | Your own diff of the registry | Add a new id (or rely on the Anthropic key), re-run (see the cache hazard below), run a new family comparison, and state in the release note that older records used the old setting. |
| Retirement or deprecation | Deprecation page; `expiration_date`, `shutdown_date`, `deprecation_date` fields | Record the provider's date. Keep the entry, and drop the model from profiles. |
| Reroute | `alias_target` on OpenRouter; provider deprecation notices (Gemini reroutes `gemini-2.5-pro` and `gemini-2.5-flash` on 2026-12-01; OpenAI maps `gpt-5-pro` and `o3-pro` to `gpt-5.6-sol` with reasoning mode `pro`) | Treat the old records as the old model. Record the reroute date and the new served model. |
| API parameter or version | Anthropic's parameter deprecation table | Anthropic's API version 2026-10-21 removes `temperature`, `top_p` and `top_k` (a 400 on non-default values). The Anthropic runner sends none of them, so the harness is not affected, but check any new parameter before relying on it. |

The Anthropic runner never lets another model answer (it sends no fallbacks), so a retired Anthropic id should fail rather than be served by a different model. This is inferred from the code and not tested. Check the run's failure reason and do not hide it.

**Cache hazard.** `buildCacheKey` in `benchmarks/lib/lab/llm-benchmark/cache.ts` keys a reply on the model id it is given, task id, prompt hash, iteration index and the frame-prelude fingerprint. For Anthropic entries that id comes from `cacheModelKey` (`runners/provider.ts`) and also names the API id, effort, thinking mode and output cap, so a changed Anthropic pin already misses the cache; do not bust for it. For other providers the key is the registry id alone, so a changed pin or API id needs a new registry id (section 1), not a reused one. Price is not in the key: a replay is priced from the current registry. Never use `--bust-cache` or `BUST=1` for single-model work. It skips reading and writing the response cache, so every call is paid and no answer is stored. `task cache:clear` deletes the whole response cache (`benchmarks/.cache/llm-benchmark-responses.json`) for every model, so avoid it for single-model work too.

## 9. Limits to state in every note

- The family profile runs three iterations per task, so a headline comparison has at most three values per task per model. The report withholds an interval when a figure rests on fewer than six iteration values (`MIN_INTERVAL_VALUES` in `board.ts`). Check the scope before quoting one.
- One run on one date. Provider behaviour can change between runs.
- Compare like effort with like effort (base with base, `low` with `low`).
- Say which tasks ran. Smoke tasks are harness checks and are never ranked.
- Output caps changed on 2026-11-10: the Anthropic default went from 64,000 to 128,000 tokens including reasoning. Pairs that reached the old cap were re-run. Check a record's date before comparing long tasks across that line.
- Scorer version 2 is not fully comparable with version 1 on the legacy canvas tasks (`docs/lab/llm-benchmark/scorer-changelog.md`). Do not mix versions.
- State the failure reasons (`truncated`, `empty_body`, `model_error` and so on) and any refusals, which are billed.

## 10. Release note template

```
Model: <name> (<id>; API id <apiModelId>), released <date> (source: <provider list or page>, read <date>)
Predecessor: <id>
Registry change: <added | changed | retired>; base effort <level>; variants <list>; per 1k input / output <values>
Provider facts: context <n>; max output <n or default>; price under review: <yes | no>
Measured here (scorer version 2): tasks <ids and versions>; iterations <n> requested per task, <n> completed; run ids <list>; budget stops <none | list>
Results: model | score | scoreAllTrials | completed / requested | failure reasons | cost per task run
Predecessor on the same run: same columns
Vendor-claimed, not measured here: <metric, value, source URL, date read, settings>
Limits: <sample size, one run, scorer comparability, effort match, price flag, anything not re-checked>
```

## 11. Checklist

- [ ] No other sweep or monitor is running (`pgrep -fl 'run-benchmark.mjs|sweep-recovery.mjs'` prints nothing).
- [ ] Operator approved the spend; `--dump-config` shows the intended models, iterations, caps and `chromium` sandbox.
- [ ] `results.json` tracking checked by hand (the direct `npm run bench` commands skip the Taskfile guard).
- [ ] Id confirmed in the provider's own list; only ids printed; key file referred to by name only.
- [ ] Release and deprecation dates read from the provider's pages; URLs and read dates recorded.
- [ ] Base effort equals the documented default; every variant matches its base's API id and prices.
- [ ] Prices converted by exact division by 1,000; none guessed; price-under-review noted if flagged.
- [ ] `contextWindow`, `maxOutputTokens` (only if below 128,000), `released` (`yyyy-mm-dd`), tags and blurb set; no scores in the blurb.
- [ ] No `thinking` key on 5.x entries; no effort on Haiku 4.5.
- [ ] `registry.test.ts`, `npm run typecheck` and `npm test` pass.
- [ ] Pilot run checked; family run includes the predecessor; `verify-results` is clean.
- [ ] Both models' new records carry `scorerVersion: 2`, `scoreAllTrials` and the same `promptBundle`.
- [ ] Vendor numbers kept out of the registry, `results.json`, blurbs and report data.
- [ ] Any change under an existing id was checked against section 8, and a changed non-Anthropic pin got a new id.
- [ ] Release note written, with sample size and limits.
- [ ] `update-catalog.py` not run with `--overwrite`; no key material printed, copied or logged.
