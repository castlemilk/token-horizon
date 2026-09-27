# Phase B report: th-engine vs Splash after the 2026-09-25 commits

Written 2026-09-26 ~05:30 AEST by the report agent, for the maintainer.

- **Repo:** `/Users/benebsworth/projects/token-horizon`. `main` = `cf3e5f7`. The main working tree is clean: `git diff -- engine/src` was empty at 05:1x, read with `GIT_OPTIONAL_LOCKS=0`. The other developer's multi-slot refactor (`snapshot(slot)`/`restore(slot,..)`/`rollback_verify(slot,..)`), which the brief described as uncommitted, has landed as `de110be` → `502cf15` → `cf3e5f7`. Their commit messages carry "Generated with Devin".
- **Hardware:** M5 Max, 40-core GPU, 128 GB, macOS 26.5.1.
- **Model:** Qwen3.8-27B-4bit (`$TGT`) + DFlash draft (`$DRAFT`). Splash 1.0 (brew) serves `incoai/Qwen3.8-27B-Splash`.
- **Metric conventions:**
  - Loop tok/s = Σtokens / Σround-ms over the logged `[dflash]` rounds. The first token (sampled from prefill) and the final, unlogged round are excluded unless stated.
  - "T=0.6" always means temperature 0.6, top_p 0.95, top_k 20, sent explicitly.
  - Every number names its build.
  - Tags: [M] measured, [D] derived, [E] estimate.
- **Inputs:**
  - Baseline: `.worktrees/bench-base-44aed06/.bench-baseline/baseline.md`.
  - Commit review and verification: the phase-B subagent outputs, the verify/fix branches, and the `$SP/phaseB/*` reports.
  - Roadmap: SYNTHESIS v2 and CRITIQUE. These were wiped from `$SP/understand/` and I read them from the verbatim recovery in `/tmp/k45u/`.
  - New for this report: two A/B sessions on an integration merge of all delivered branches (§3.4, §4).

## 0. Summary

1. **Baseline (one session, 23:11–23:18).** Splash 1.0 decodes **1.93× faster** than th-44aed06 in loop tok/s: 63.8 vs 33.0 at T=0, 60.8 vs 31.3 at T=0.6.
   - th's rounds were 1.77× slower (104.5 vs 58.9 ms at T=0).
   - Per round, th did only about 4 ms more GPU work than Splash (63–65 vs 59–61 ms). The rest was GPU idle, 36–42 ms per round.
   - That session had CPU load 26–49, and th is host-bound, so the ratio is inflated by contention (§1.2).
2. **th at low CPU load (this report, load 2.3–3.5).** main `cf3e5f7` runs **63.1 ms/round, 54.7 tok/s** at T=0. GPU-busy is 55.9 ms/round and idle about 7.5.
3. **Confirmed bugs, 14 in total** (§2).
   - **6 in the seven perf commits:**
     - MEM-1/N1: draft `o_proj` reads 2 MiB from a 64 KiB tensor on every propose.
     - MEM-2: `Tensor::zeros` blit fills split the compute encoder.
     - MEM-4: dead ring gathers.
     - N2: argmax tie rule.
     - N3/N4: attention kernels that do not scale with context.
   - **8 in the multi-slot refactor.** All are TH_BATCH>1 only, and the live :8001 runs TH_BATCH=4.
     - B1/MEM-5: the scheduler thread dies.
     - M1: decode_tps is inflated 2.5–4×.
     - M2/MEM-6: kv_quant cross-slot corruption.
     - M3: kv_clear wipes a live slot.
     - M4: failed admissions return an empty 200.
     - M5: no-draft batching fails.
     - MEM-3: 40 MiB allocated per slot per round.
     - N2 in mixed batches.
   - Fixes exist on branches for all except N3/N4, which have only probe-only prototypes.
4. **Branches delivered (§3).**
   - `th/wp2-matmul-roofline` @`5a93868`: K1+P0+K2+K45, the largest win.
   - `th/wp10-prefill-tiles` @`dc203fd`: T2 TTFT, plus −20% ms/round in batched decode.
   - `th/wp1-utf8-stream` @`3d8a2c6`: U1 correctness.
   - `th/wp2-m1-decode` @`4bb1731`: K7, plain decode +14%.
   - `th/wp2-q4-decode` @`970b1f5`: superseded by the roofline branch.
   - All three that are rebased onto main fast-forward. K7 must be ported onto the K45 head.
5. **Integration measured (§3.4, §4).** I merged K45 + U1 + T2 + six bug fixes as `report/integration-sim` @`8d5b6d5`. Resolving it took 3 conflict hunks and 1 semantic compile fix. It builds with 0 warnings and passes 24/24 tests.
   - Against main `cf3e5f7`, same session, ABCCBA then ABBA, T=0: **63.1 → 54.5 ms/round (−13.6%)** and **54.7 → 66.1 tok/s**. At equal tokens/round that is 63.2 tok/s: 3.605 vs 3.450, because one prompt's text changed.
   - GPU-busy fell 55.9 → 46.9 ms/round; idle stayed about 7.7.
   - TTFT median fell 192 → 175 ms.
6. **Against Splash.** 54.5 ms/round falls between Splash's earlier quiet 51.3 ms/round and today's loaded 58.9. th's GPU work per round is now *below* Splash's (46.9 vs 50.9–58.7; a cross-session comparison, and th's ioreg figure is an upper bound).
   - What remains is host idle (about 7.7 vs about 0.4 ms) and tokens/round. On the one prompt whose greedy text is identical, th needs 39 rounds and Splash 36.
   - There is no same-session Splash A/B at low load; it is item 1 of §5.
7. **Remaining gap to the kernel floor F_k (about 36 ms):** about 18.5 ms/round. That is idle (at least 7.7 ms) plus GPU work beyond the matmul fit (at most 10.9 ms).
8. **Cheapest next lever:** L1, always verify 7 proposals. The live build, which always verifies 8 rows, emitted the same greedy text as th-44aed06 on all 3 bench prompts with **+10.8% tokens/round**, at about 0 ms cost (§5).

## 1. Where we stand now

### 1.1 Baseline: th-44aed06 vs live :8001 vs Splash, same session

Source: `.worktrees/bench-base-44aed06/.bench-baseline/baseline.md` (and `agg.md`, `runs.jsonl`, `gpufit.json`).

- **Session:** 23:11:25–23:18:29 on 2026-09-25, one `gpu-lock` hold.
- **Arm order:** A1 th → C1 live → B1 splash → B2 splash → C2 live → A2 th.
- **Per arm:** 1 warm-up request, then 3 iterations × 3 prompts at T=0.6, then the same at T=0. Prompts are short/code/long, max_tokens 128. That gives 18 requests per engine per mode.

| engine (build) | mode | loop tok/s | ms/round | tokens/round | TTFT median ms | GPU-busy ms/round | GPU idle ms/round | n |
|---|---|---|---|---|---|---|---|---|
| th-44aed06: `44aed06168dc`, clean worktree, sha256 `9a6bad74…`, :8010, single-slot loop | T=0 | **33.0** (A1 33.1, A2 32.9) | 104.5 | 3.450 | 229 | 63.0 | ≈41 | 18 req, 480 logged rounds (+18 final) |
| th-44aed06 | T=0.6 | **31.3** (A1 29.7, A2 33.0) | 100.7 | 3.149 | 240 | 64.8 | ≈36 | 18 req, 522 logged (+18) |
| live-8001: WT-dirty build, mtime 18:08:16 (between `502cf15` and `cf3e5f7`), sha256 `16a60397…`, pid 16917, TH_BATCH=4 (all requests nb=1) | T=0 | **40.5** | 94.5 | 3.824 | 203 | 64.1 | ≈30 | 18 req, 444 rounds |
| live-8001 | T=0.6 | **38.2** | 91.5 | 3.494 | 211 | 69.7 | ≈22 | 18 req, 486 rounds |
| Splash 1.0 (brew); started on the free :8000 and stopped afterwards | T=0 | **63.8** | 58.9 | 3.763 | 152 (prefix-cache hits) | 58.7 | ≈0–4 | 18 req, 456 rounds |
| Splash 1.0 | T=0.6 | **60.8** | 61.2 | 3.722 | 159 (prefix-cache hits) | 61.0 | ≈0–4 | 18 req, 468 rounds |

- **Ratios (loop tok/s):**
  - Splash / th-44aed06: **1.93×** at T=0, **1.94×** at T=0.6.
  - Splash / live: 1.58× and 1.59×.
  - live / th: 1.23× and 1.22×.
  - ms/round, th vs Splash: 1.77× at T=0, 1.65× at T=0.6.
- **Where th's time went (th-44aed06, mean per logged round, T=0):**
  - propose 25.8 ms;
  - snapshot + verify encode 37.7 ms;
  - GPU wait + readback 36.7 ms;
  - rest 3.9 ms.
  - About 90% of the ms/round gap to Splash was GPU idle while the host worked. th's GPU work per round was only about 4 ms (6–7%) more than Splash's.
- **Tokens/round.**
  - At T=0: th 3.450, live 3.824, Splash 3.763.
  - On "long", where all three engines produced byte-identical greedy text (sha1 `fdf57afa832f`): th needed 39 rounds, live 37, Splash 36.
  - th-44aed06 uses an adaptive `verify_len` (`round(accept_ema)+1`, clamped to 2..7; engine.rs:344 at 44aed06, :431 at the integration head). Live and Splash always verify all 7 proposals.
- **Conditions:**
  - GPU quiet: other clients used at most 4.3% of GPU time during arms.
  - CPU **not** quiet: 1-min load 26–49 during the arms (sibling rustc builds, a VM, python jobs). Swap peaked at 16.7 GB.
  - A smoke pass at load about 15 (same th binary) ran **72.9 ms/round / 47.3 tok/s** at T=0, against 104.5 / 33.0 in the main pass.
  - Splash also ran slower than its earlier quiet baseline: 58.9–61.2 vs 51.3 ms/round.
- **Caveats:**
  - th's T=0.6 output is deterministic, because no seed was sent and the default is seed 1. So its T=0.6 tokens/round rests on 3 distinct samples.
  - TTFT is not like-for-like: Splash served 32–64 prompt tokens per request from its prefix cache, and th has no prefix cache.
  - The stock script's "decode" figure is overstated: th 39.2, Splash 76.7, and live **93.2 / 107.9**. The live figure is the M1 bug (§2.2).
- **Earlier quiet reference (SYNTHESIS §0, HEAD `441acec`, before today's commits):**
  - th 87.2 ms/round, 3.545 tokens/round, 40.65 tok/s.
  - Splash 1.0 51.3 ms/round, 3.71 tokens/round, 72.4 tok/s.
  - That run was T=0.6 with the bench sending no top_p, so th used 0.8 and Splash 0.95.
  - Floors: bandwidth 29.8 ms/round; kernel floor F_k ≈ 36 ms/round.

### 1.2 The same engine at low CPU load (this report's sessions)

Two sessions, all runs under `gpu-lock`, fresh server per arm on the private port :8029, `TH_DEBUG_TIMING=1`.

- **s1:** 05:13–05:18, load 2.5–3.5. Order main → roof → integ → integ → roof → main.
- **s2:** 05:20–05:23, load 2.3–2.6. Order main → integ → integ → main, with per-request ioreg GPU time and process CPU time.
- **Client:** 3 bench prompts at T=0, plus T=0.6 with seeds 1, 3 and 5. Odd seeds are used because the sampler seeds with `seed|1`, so even and odd pairs collide.
- **GPU state:** quiet before and after every arm (WindowServer about 3%).

**main `cf3e5f7`** (sha256 `545e5462efb6…`, the same binary as the wp2 fix pass):

| | s1 | s2 |
|---|---|---|
| T=0 ms/round | 63.00 | 63.13 |
| T=0 tokens/round | 3.450 | 3.450 |
| T=0 tok/s | 54.76 | 54.65 |
| GPU-busy (slope) | — | 55.9 ms/round |
| host CPU | — | 18.1 ms/round |
| idle | — | about 7.5 ms/round |

- Passes are repeatable to ±0.5 ms/round, and T=0 and seeded outputs are 12/12 identical across passes.
- main `cf3e5f7` is th-44aed06 plus the multi-slot refactor. Its B=1 path runs the same single-slot loop and kernels. At T=0 it reproduces th-44aed06's baseline tokens/round exactly (3.450, with the same 8 / 36 / 39 rounds on short / code / long).
- So the difference from §1.1 (104.5 → 63.1 ms/round) comes from load, not code: most of th's 36–42 ms/round of idle there was **CPU contention on a host-bound loop**.
- GPU-busy itself also rises under CPU load: 63.0 at load 26–49 vs 55.9 here, from shared memory bandwidth.
- Any th-vs-Splash ratio must be measured in one session at one load level; §5, item 1.

## 2. Bugs in today's commits

- **How these were verified:** three review lenses (memory, numerics, state machine) over `c5ca3fa..44aed06` plus `de110be..cf3e5f7`. Each finding was then checked by its own verification agent in a private worktree under `gpu-lock`.
- **Line numbers:** `@44aed06` or `@cf3e5f7` as stated. Most review lines are `cf3e5f7` positions.
- **Severity:** the verifier's re-assessment, which is often a downgrade from the reviewer's.

### 2.1 Confirmed: the seven perf commits (`c5ca3fa..44aed06`)

#### MEM-1 / N1: draft `o_proj` reads 2 MiB from a 64 KiB tensor

**Introduced:** `90cbcfe`. **Severity:** high (a blocker downgraded by both verifiers: the out-of-bounds access is read-only and the garbage rows are discarded).

- **What:** the fused `draft_attn` returns `[8,32,128]`, and `.unsqueeze(0)` makes it `[1,8,32,128]` (dflash.rs:442@44aed06, :461@cf3e5f7). `QLin::linear` then reads in_d=128 and rows=256, and runs `AffineQmppPrefill{inp:4096, m:256}`.
  - Its pad pass reads 256×4096 bf16 (2 MiB) from a 64 KiB tensor, 5 times per propose.
  - At HEAD, `propose_batch` reads B × 2 MiB.
  - It also does 32× the MMA work of the correct shape.
  - The output is right only because `draft_conv_fused` reads rows 0..7.
- **Evidence:**
  - Build: `verify-memory-MEM1-r2` @`7164c2a`.
  - `MTL_SHADER_VALIDATION=1` reports 157× "Invalid device load" in `affine_q4_mpp_pad`.
  - The live counter shows exactly 5 mismatches per propose.
  - Buffers of 64 KiB–256 KiB are read 1.8–2.0 MB past their end.
  - `TH_QMM_MPP=0` makes **every DFlash request return HTTP 500** (verify-numerics-N1-oproj @`a351820`).
  - `TH_QMM_SCALAR=1` fails with "shape mismatch in matmul".
- **Measured impact:**
  - Propose 11.20 → 9.30 ms and **+4.7% loop tok/s** on identical T=0 streams (46.50 → 48.69 tok/s, 322 rounds each; `7164c2a`).
  - 1.5–2.5 ms per propose (`a351820` vs `4f823af`).
  - In the integration head: propose 9.4 → 8.0 ms (`5a93868` → `8d5b6d5`, s1).
- **Fix:**
  - `fix-N1-oproj-shape` @`8bcc3f3`: `4f823af` does the reshape to `[1,8,4096]` and adds a `QLin::linear` in_d≠inp guard; `8bcc3f3` adds the test. Ship the guard with the reshape: the guard alone fails every request.
  - Alternative: `verify-memory-MEM1` @`b9e7971` (the reshape plus `check_x_extent` in every Q4 op).
- **Repro:**
  - Model-free: `TH_MEM1_UNIT=1 th-engine probe --model x --tokens 1` on `7164c2a`.
  - Or: `TH_QMM_MPP=0 th-engine serve --model $TGT --draft $DRAFT` followed by any request, which returns 500.

#### MEM-2 / N10: `Tensor::zeros` outputs are blit fills that split the compute encoder

**Introduced:** `0ee13e6` (GDN gated/pack), `f1533e5` (attention q_buf/out), `90cbcfe` (3 draft outputs). **Severity:** moderate.

- **What:** candle's `allocate_zeros` blit-fills a buffer from the shared pool, which ends the open compute encoder. All 7 outputs are fully overwritten by their kernels, so the fill is wasted.
- **Counts per round, zeros vs empty:** +128 fills per verify, +35 per propose, +5 per commit; 118 extra compute-encoder restarts; about 11.8k extra `waitForFence`; about 150 MB of fill traffic. Dispatch counts are identical.
- **Measured impact** (`verify-memory-MEM2-repro` @`20d8380`, T=0, identical tokens):
  - Verify: +2.66 to +2.87 ms per round.
  - Whole round: +2.84 ms (95% CI 2.18–3.50).
  - tok/s: −1.3% to −3.4%.
- **Fix:** `Tensor::empty` at the 7 sites (`verify-memory-MEM2` @`324f448`, `outbuf::kernel_out`). This commit conflicts with main in draft_kernel.rs and needs a re-port.
- **Status after K45:** K45(a) `05b861f` allocates the two GDN outputs uninitialised on the presum path, which removes 96 of the 128 verify fills. Still using zeros at the integration head:
  - qwen35.rs:2906-2907 (non-presum GDN path);
  - qwen35.rs:3185 and :3195 (attention);
  - draft_kernel.rs:202, :262 and :307.

#### MEM-4: dead ring gathers before the fused `draft_attn` early return

**Introduced:** `90cbcfe`. **Severity:** minor.

- **What:** `Draft::attention` builds the host id list, uploads it, and runs two `index_select` gathers. It then takes the fused `draft_attn` early return and discards the result.
- **Measured impact:**
  - Per propose: +0.15 ms at ring 128, +0.34 at 512, +0.88 at 1024, +1.40 at 2048 (microbench).
  - End to end: paired Δpropose median +0.97 ms per round at ring 2048 (`verify-memory-MEM4b` @`1b2e548`/`b7284a9`).
  - The N4 verifier measured 2.25 ms per round at a full ring.
- **Fix:** `verify-memory-MEM4b` @`b0681a7`, on 44aed06. It conflicts with main's dflash.rs; re-port it by moving dflash.rs:436-449 below :450-462 @cf3e5f7.

#### N2: greedy tie rule differs between paths

**Introduced:** `ba8ee49`. **Severity:** moderate.

- **What:** the verify path now uses Metal argmax, which picks the lowest index on ties. `Sampler::dist_vec` greedy uses `max_by`, which picks the last. The CPU path covers the anchor token, the plain loop, penalty requests and mixed batches.
- **Measured impact:**
  - 86 of 5122 token-deciding T=0 rows (**1.68%**) had an exact bf16 top-1 tie.
  - No emitted token is wrong, and T>0 is unaffected.
  - T=0 identity checks across paths or builds fail at the first tie: 4/4 prompts diverged within 44–234 tokens.
- **Fix:** `verify-numerics-N2-tie` @`786490f` (a strict `>` scan plus a unit test). It conflicts with main's engine.rs, so cherry-pick only the `dist_vec` hunk and the test.

#### N3: `attn_decode` has no split along keys

**Introduced:** `f1533e5`. **Severity:** major at ≥4k context, minor at ≤1k.

- **What:** each simdgroup walks the whole context serially. The cost is 0.25–0.40 ms per 1k keys per layer.
- **Measured** (build `575b5b4` = 44aed06 + probe):
  - Attention time over 16 layers: 1.98 ms per round at 512 context, 9.39 at 2k, **47.7 at 8k**, 99.7 at 16k.
  - Server verify segment: 59.98 ms (842-token prompt), 102.69 ms (8160), 154.08 ms (16272).
  - This is not a regression: the eager path it replaced is 4–8× slower.
- **Prototype, probe-only** (`verify-numerics-N3-attn` @`4f998f4`): split-K cuts verify forward 98.3 → 61.2 ms at 8k and 150.4 → 75.3 ms at 16k; max|Δ| ≤ 5e-4.
- **Fix:** none on a merge branch. This maps to SYNTHESIS A1/A2.

#### N4: `draft_attn` runs on 8 threadgroups

**Introduced:** `90cbcfe`. **Severity:** major at ≥2k context, negligible when short.

- **Measured:** 1.70–1.76 ms per call at ring 2048, i.e. 8.5–8.8 ms per propose.
- **Prototype** (`verify-numerics-N4-draftattn` @`1738e0a`, `draft_attn_split`, 64 threadgroups):
  - 0.136 ms per call at ring 2048 (12.7× faster).
  - In situ on a 2581-token prompt: propose 24.09 → 13.18 ms, round 96.69 → 85.00 ms (−12%).
  - T=0 text is identical when combined with the MEM-1 and MEM-4 fixes.
- **Fix:** none on a merge branch. This maps to SYNTHESIS D4.

### 2.2 Confirmed: the multi-slot refactor (`de110be..cf3e5f7`, the other developer's code)

- **Scope:** all of these need TH_BATCH>1. The default TH_BATCH=1 path is unaffected.
- **Exposure:** the live :8001 (pid 16917) runs TH_BATCH=4 and has every one of them.
- **Introduced:** every entry below was introduced in `de110be`.

#### B1 / MEM-5: one error permanently kills the batch scheduler

**Severity:** high. It should block making TH_BATCH>1 a default.

- **What:** `forward_batch` moves slot state out with `take().unwrap()` and applies `?` before putting it back. Any Err poisons the slot. The next admission then panics the `th-batch` thread at qwen35.rs:2472 or :2484.
- **Reproduced** with the fault injectors `f819bdc` and `cb2adcf`:
  - an in-flight stream is silently truncated;
  - the next request gets HTTP 200 with empty content;
  - every request after that gets "batch queue full";
  - `/health`, `/ready` and `/status` stay green.
- **Fix:** `verify-statemachine-B1` @`b5f1457`. It restores state before `?`, replaces `unwrap` with `.context()?`, makes `clear_kv_cache` rebuild missing state, hands draft rings back, wraps admit and batch_round in `catch_unwind`, reports admit errors to the client, and reports a disconnected scheduler as such. It supersedes MEM-5 `8664fcc` and MEM-3 `7167b6d`.

#### M1: batch round timing stops at encode, so decode_tps is inflated

**Severity:** major, for metrics only.

- **What:** `step_ms` is taken right after `forward_batch` returns, which only encodes the GPU work. The GPU verify, the readback and accept are excluded from decode_tps and `/status` for **every** TH_BATCH>1 request.
- **Measured on `cf3e5f7`, TH_BATCH=4:**
  - A single T=0 stream reports 126.1 tok/s against 50.1 by wall clock.
  - Four concurrent T=0 streams report 179.6 tok/s aggregate against 72.4 real.
  - The B=1 path gives 48.2.
  - The ~85–108 tok/s that :8001 reports about itself, and de110be's "~195 tok/s aggregate", are both this artifact.
- **Fix:** `verify-statemachine-M1` @`c498244`.

#### M2 / MEM-6: an admission can flip another slot's kv_quant mode

**Severity:** major (silent corruption).

- **Trigger:** a kv_quant change via `POST /engine/config` followed by a concurrent admission.
- **What:** `set_kv_quant_slot` flips the model-wide TurboQuant mode at every admission, so a live slot starts using a raw or quantised cache it never filled.
- **Measured:**
  - Unit test: logit diff 4.27 / 2.73 on the bug build, 0 on the fix.
  - End to end, the in-flight request degenerates: "The Long History of the Long History…" 57 times, and "and open" 112 times.
- **Fix:** `verify-memory-MEM6-r2-clean` @`0188158` (per-slot `kv_quant` plus a unit test, which passes in the integration run). The alternative `verify-statemachine-M2` @`07dc538` conflicts with it; pick one.

#### M3: `POST /engine/kv/clear` wipes a live slot

**Severity:** moderate. No in-repo caller uses the endpoint.

- **What:** under batch mode the endpoint clears slot 0 between rounds, even while a request is running on it.
- **Reproduced:** the output diverges at exactly the clear point and the model forgets the prompt. The TH_BATCH=1 control is safe.
- **Fix:** `verify-statemachine-M3` @`316c18a`.

#### M4: failed admissions return an empty 200 and leak requests_active

**Severity:** major (client-visible).

- **Trigger:** any batch admission error, e.g. a template raise for a `developer` role or a system message that is not first.
- **Reproduced:** HTTP 200 with empty content, and `requests_active` leaks (4 after 5 requests).
- **Fix:** `verify-statemachine-M4` @`8d49fdf`. B1 `b5f1457` also sends the Error and decrements the counter, which covers the core of M4.

#### M5: TH_BATCH>1 without `--draft` fails every request

**Severity:** minor (loud, opt-in).

- **What:** every request fails after its first token with "draft not loaded".
- **Fix:** `verify-statemachine-M5` @`5c4da25`, which falls back to a single slot. Do not merge the probe tip `28acf03`.

#### MEM-3: 40 MiB allocated per slot per round

**Severity:** major.

- **What:** `draft_propose_batch` allocates a fresh, zero-filled 40 MiB Draft ring per slot per round as a `mem::replace` placeholder. A failed allocation strands the remaining slots permanently.
- **Measured:** +4.61 ± 1.03 ms per round at nb=4 (per-round alternation, build `8308b4f`). Proposals are bitwise identical.
- **Fix:** `7167b6d`, or the same change inside B1 `b5f1457`.

#### N2 in batch mode

**Severity:** moderate. Found by code reading.

- **What:** if one slot in a batch is sampled, *all* slots, including T=0 ones, go through the CPU tie rule.
- **Fix:** `786490f`, re-ported (see §2.1).

**Also observed, but not a bug by itself:** at TH_BATCH≥2, greedy output depends on co-scheduling and admission timing.

- Within one binary, a zh prompt gave 156 vs 230 tokens (U1 fix pass).
- MEM-3 saw 3–4 distinct outputs in 20 runs.
- Consequence: T=0 identity A/Bs in batch mode need the same batch composition.
- Batching also pays little so far: B=4 gives 72.4 tok/s aggregate vs 48.2 single-stream (`cf3e5f7`, M1 verification).

### 2.3 Unconfirmed, or impact not measured

**Anchor off-by-one.** Pre-existing; `f1533e5` changed how it shows up. Mechanism confirmed; acceptance impact unmeasured.

- **What:** after the prefill anchor is emitted, `pos += 1` runs before the anchor is forwarded (engine.rs:364 single-slot and :1224 batch, @cf3e5f7). Every verify, draft and commit therefore runs one position late:
  - target KV row P is never written but is attended (it is zero under the fused cache write);
  - draft ring position P is never committed;
  - generated tokens get RoPE +1.
- **Probe:** `TH_CHECK_POS=1` (`verify-statemachine-M5` @`28acf03`) prints `forward_inner slot=0 pos=72 kv_tokens=71` on the first verify.
- **Fix:** `review/statemachine` @`d523828` fixes the single-slot path only. It merges clean on main and on the integration head. Not benchmarked; a 48-token greedy text was unchanged.
- **Priority:** it could explain part of the tokens/round gap, so measure it.

**Review-only findings (not runtime-verified):**

| ID | Introduced in | Finding |
|---|---|---|
| MEM-7 | `c5ca3fa` | The strided conv-window view pins every GDN layer's in_all output through prefill: about 12.9 GB at an 8k prompt. |
| MEM-9 | `f1533e5` | `attn_prepare` reads the rope table past `max_position_embeddings` with no bound check. |
| MEM-10 / N5 / m3 | `5edd9a3` | Draft prefill commits WINDOW−1 rows but attention reads WINDOW, and `Draft::clear` does not zero the rings. The first propose after a >2047-token prefill therefore reads one stale slot. Related: the N2 verifier saw a deterministic **cross-request draft-state leak**: the same request run 1st vs 5th in one process gets different proposals from round 14. |
| MEM-8 / N7 / m4 | today's kernels | head_dim 256, DK 128, conv_k 4 and contiguous draft inputs are hard-coded with no Rust-side guards. |
| MEM-11 | — | Capture groups misalign on error paths (`chunks_exact(5)`). |
| MEM-12 / N8 | — | `gdn_lib` is compiled with the first caller's dims. |
| m6 | — | Per-layer `std::env::var` calls on the hot path. K45 caches `TH_GDN_EAGER`/`TH_GDN_STEP`; `TH_NO_ATTN_FUSED`, `TH_DEBUG_ATTN`, `TH_DEBUG_ROLLBACK` and `TH_DRAFT_EAGER` remain. |
| m7 | multi-slot | Synchronous prefill in `admit` stalls every live slot. |
| m8 | multi-slot | The batch `accept_ema` is not clamped. |
| N6 | — | Rounding-point differences vs eager and Splash. These are parity notes, not bugs. |
| m5, N9 | — | The snapshot doc comment and several other comments are stale. |
| MEM-13 / m9 | pre-existing | Snapshot copies 48 × 3 MiB per slot per round (this is SYNTHESIS G1a). |

### 2.4 Pre-existing problems surfaced while verifying (not from today's commits)

**Measurement pitfalls:**
- **Seed collisions.** The sampler seeds with `seed | 1` (engine.rs:686@44aed06), so seeds 2k and 2k+1 produce the same stream. Seed-paired A/Bs silently double-count.
- **`TH_TEST_ROLLBACK` is not a trustworthy gate.**
  - It already FAILs on untouched 44aed06: kept=1 flips the argmax 13→68.
  - Its kept=8 "self" check is not state-bitwise. The `gdn_scan` rescan and `gdn_fused_step` differ in 6,278,466 of 37.7M recurrent f32 elements (max 1.9e-6; K7 `diag3`).
  - SYNTHESIS R0a's state-bitwise rollback gate is still needed.
- **`prefill_tps` is encode time.** `prefill_ms_total` is timed without a sync (engine.rs:1169-1174 and :302-307@cf3e5f7). It reports 7,300–19,400 tok/s against a real ~420.
- **The `[verify] enqueue=` log line includes propose.** It is timed from round start.
- **The `/metrics` decode histogram** labels buckets one step low, and its HELP text says "per-token" where it means per round.
- **`$SP/work/gpuusers.py` attributes GPU time to the wrong process.**

**Robustness and code bugs:**
- `server.rs:218-230` returns 200 / "stop" with zero usage when the channel closes without a Done event.
- Concurrent requests can share an id (`chatcmpl-18d893086040e010` appeared twice).
- `QLin::cpu_dequant` slices with a 2·ng stride and panics for out ≥ 2.
- `affine_q4_mpp_pad` declares `constant int3& dims` but the host passes `[i32;3]`, so `MTL_DEBUG_LAYER=1` aborts (quant_kernel.rs:1845-1846 and :1981-1983@44aed06).

## 3. Branches delivered

**Worktrees:** `/Users/benebsworth/projects/token-horizon/.worktrees/<branch>`. Nothing has been pushed.

**How the merge checks were run:**
- Merge status comes from `git merge-tree --write-tree` against `main` (`cf3e5f7`), run with `GIT_OPTIONAL_LOCKS=0`. It writes objects only and never touches the main tree.
- "FF" means main is an ancestor of the branch.
- The other developer's uncommitted diff (`git diff -- engine/src` on the main tree) was **empty** at 05:1x, so there was nothing uncommitted to check for overlap. Their refactor is already in main, and every conflict below is against it.

### 3.1 Implementation branches

#### th/wp2-matmul-roofline @`5a93868`: K1 + P0 + K2 + K45(a,c,d), rebased

**What it contains:** 9 commits, fast-forward of main.
- `47ae79a` K1: verify gate/up on the N256 two-stream tile.
- `aef01c3` / `7cdb6b2` P0: skip the pad copy at m=8, but keep it when K > 8192.
- `2eadc10` K2: per-shape tile table, the Splash paired lm_head, IORegistry core count.
- `7b5d5f2`: bench.
- `05b861f` K45(a): producers emit Q4 input sums ("presum blocks"); pad copies and the 96 GDN zero-fill blits are gone.
- `5e72124` K45(c): autotune sweep.
- `e6d7382` K45(d): draft gate/up fused onto the N256 two-stream tile.
- `5a93868`: bench.

**Measured, fix pass** (base main `cf3e5f7`, sha256 `545e5462…`; candidate `5a93868`, sha256 `5fcad74f…`):

| metric | main cf3e5f7 | 5a93868 | Δ |
|---|---|---|---|
| V-multi fwd8 / fwd5 / fwd1, median ms | 47.00 / 46.45 / 46.30 | 40.25 / 39.55 / 41.70 | −6.75 / −6.90 / −4.60 |
| K45(a) alone (same binary vs `TH_Q4_PRESUM=0`), fwd8 / fwd5 / fwd1 | — | — | −3.60 / −4.10 / −3.20 ms |
| E2E TH_BATCH=1, T=0 (rounds 1, 3, 4): ms/round | 64.11 | 56.40 | −12.0% |
| same: tok/s | 53.81 | 61.95 | +15.1% |
| same: tokens/round | 3.450 | 3.494 | |
| TH_BATCH=2, wall aggregate tok/s | 45.98 | 51.24 | +11.4% |

**Measured, this report's s1** (T=0, ABCCBA):
- 63.00 → **55.99 ms/round (−11.1%)** and 54.76 → 62.39 tok/s.
- Verify phase 52.3 → 45.6 ms.
- Identical T=0 text on 3/3 prompts in both passes.

**Kernel level** (K45 serial bench on `3e5cba5`):
- gate_up 532–535 GB/s, meeting the ≥480 target; it was already met by K1.
- in_all 457–460 GB/s and down 444 GB/s plain / 400 GB/s PreSums: target not met.
- out −10% and in_qkv −4% with PreSums.

**Pre-rebase K1/P0/K2 results** (`970b1f5` vs `44aed06`):
- Paired E2E: −3.16 ± 1.20 ms/round (−3.4%, n=36).
- 33-request acceptance study: −4.42 ± 0.73 ms/round (−6.0%), Δtokens/round −0.063 ± 0.087.
- Gate A: sequential-K costs +19.2% ms/round for −0.031 ± 0.043 tokens/round, so split-K was kept on N=5120.

**Gates:**
- V-build: 0 warnings on all 9 commits. Tests 10/10.
- V-lin: 28/28 max|Δ| equal to main.
- V-roll: PASS (0.1289; main 0.1875).
- Probe top-8 identical.
- forward_batch dumps: bitwise equal at nb=2, and 24/24 with `TH_Q4_POLICY=legacy`.
- T=0: 12/12 identical at TH_BATCH=1 and 12/12 at TH_BATCH=2.

**Review:**
- Verdict **needs-fix**, on a high finding: it conflicted with the multi-slot refactor. The fix pass rebased it. It has not been re-reviewed since.
- Still open (medium): the `down` (K=17408) PreSums default (`split_long`, quant_kernel.rs:300) contradicts the kernel bench (125.3 vs 113.0 µs) and P0's own finding. It rests on a sub-noise in-situ delta and was not addressed.
- Still open (low):
  - presum flags are trusted without a real guard;
  - the gdn presum sums hard-code DV=128;
  - the PreSums threadgroup-memory bound ignores static usage;
  - the effect of K45(d)'s draft numerics on acceptance is uncharacterised;
  - a dead `(17408, 5120)` table entry.

**Merge:**
- FF onto main.
- Conflicts with B1 (2 trivial hunks) and T2 (1 hunk plus 1 semantic compile error), both resolved in §3.4.
- Conflicts with K7 (below).
- It contains `th/wp2-q4-decode` and supersedes it.

#### th/wp2-q4-decode @`970b1f5`: K1 + P0 + K2 on 44aed06

- **Review:** mergeable.
- **Status:** superseded. The same patches are rebased inside `th/wp2-matmul-roofline` (range-diff `=`). Do not merge separately.

#### th/wp2-m1-decode @`4bb1731`: K7 (m=1 tiled matvec + fused gate/up), on `970b1f5`

**Measured** (base `970b1f5` vs `4bb1731`, clean session 02:37–02:49, ABBA, :8016):

| metric | base 970b1f5 | 4bb1731 | Δ |
|---|---|---|---|
| Plain decode, no `--draft`, n-gram spec 4, T=0: tok/s | 24.66 | **28.21** | +14.4% |
| same: ms/round | 49.68 | 43.43 | |
| `--spec-tokens 0`: tok/s | 20.52 | 23.02 | +12.2% |
| V-multi fwd1 | 44.52 ms | 40.07 ms | −10% |
| m=1 projections per token | 32.27 ms | 27.48 ms | |
| DFlash T=0: tok/s | 57.32 | 57.56 | unchanged |
| DFlash T=0: ms/round | 60.95 | 60.70 | unchanged |

- DFlash T=0 token ids are identical in 8 passes.
- DFlash sampled texts change, because the draft's m=1 commits round differently.
- `TH_M1_PATH=mpp` reproduces base bitwise.
- **Gates:** 14/14 tests; V-lin byte-identical on unchanged kernels.
- **Review:** mergeable, with low findings:
  - a `gate_up_act` rows==1 error now fails the request instead of falling back;
  - three QMVT library compiles land on the first request.
- **Merge:**
  - Clean against main by itself. The review built the merge `th/review-wp2-m1-merge` @`7545a3b`: it builds and passes 14/14.
  - **Not compatible with the K45 branch as-is.** As a branch it conflicts in 37 hunks, because both carry K1–P0 under different shas. Even the cherry-pick of `970b1f5..4bb1731` onto `5a93868` conflicts in 4 hunks (about 177 lines): the quant_kernel.rs re-export list, and in qwen35.rs the `qmvt_m1` insertion point and the bench's `gate_up_act` vs `gate_up_act_ps`.
  - Also conflicts with fix-N1 `8bcc3f3` (both add a test module at the end of qwen35.rs).
  - **Port it onto the integration head.** K45 §7 gives the resolution: keep AffineQmvT at m=1 and ignore the presum flag at rows==1.

#### th/wp10-prefill-tiles @`dc203fd`: T2 small-M prefill tiles, rebased onto cf3e5f7

**What it contains:** FF of main.
- `0451fd5`: Splash N128×4sg tile plus rows>8 routing.
- `434a4db`: M16/M24/M32 tiles.
- `e1b6323`: split-K.
- `b2cd3c9`: bench.
- `8cd93db`: batched-shape bench.
- `25c6f93`: compile the tile libraries at load.
- `dc203fd`: lm_head policy.

**Measured, prefill:**
- In-process forward, tiles/legacy (`25c6f93`, median of 6): 0.522 at m=16, 0.663 at 32, 0.854 at 58, 0.844 at 64, 0.885 at 68, 0.896 at 80, 0.886 at 128. Above m=128 it routes to legacy, because m=512 was 4.3% slower with tiles.
- Cold TTFT (pre-rebase `1de5480` vs `44aed06`, fresh server per request):
  - short 177.4 → 157.7 ms;
  - code 212.4 → 189.5 ms;
  - long 204.4 → 188.6 ms (−8% to −11%).

**Measured, batched decode** (main `cf3e5f7` vs `dc203fd`):
- TH_BATCH=4: **187.67 → 151.35 ms/round (−19.4%)**, 65.63 → 78.39 tok/s.
- TH_BATCH=2 (`25c6f93`): 122.53 → 97.93 ms/round (−20.1%), 51.15 → 65.77 tok/s.
- Single-slot decode is unchanged, because verify rows stay ≤ 8.

**Gates:**
- V-build: 0 warnings on all 7 commits. Tests 11/11.
- V-lin decode: 28/28 identical.
- Prefill: Δref identical to legacy; Δlegacy ≤ 1 bf16 ulp.
- T=0 single-slot: short and code identical; long diverges at token 119/125 (1-ulp prefill numerics).
- `TH_PF=0`: 20/20 T=0 slots identical to main.
- Determinism: 129/129 set-runs.

**Review:**
- Verdict **needs-fix**, on two findings: high, it did not compile once merged (`clear_kv_cache(slot)`); medium, it routed batched decode rows through the tiles unmeasured.
- The fix pass rebased it and measured and accepted the batched routing. It has not been re-reviewed since.
- Still open:
  - slot invariance is off by 1 ulp at the 8-simdgroup and fused gate/up tiles;
  - `pf_route` reads its own `TH_GPU_CORES` (default 40) rather than K2's `gpu_cores()`. Unify after the merge.

**Merge:**
- FF onto main.
- Against the K45 branch: 1 re-export hunk, plus a **semantic** compile error (E0308): T2's rows>8 `AffineQpf` branch returns `Result<Tensor>` inside K45's `gate_up_act_ps -> Result<(Tensor,bool)>`. Fixed in integration commit `8d5b6d5` (return `(y, false)`).
- Against K7: 1 hunk.

#### th/wp1-utf8-stream @`3d8a2c6`: U1 UTF-8-safe detokenization

**What it contains:** `4c84f0a` and `3d8a2c6` on cf3e5f7 (FF).

**Measured:**
- Chinese prompt at T=0: U+FFFD in the stream **36 → 0**. Sampled: 18 → 0.
- CJK stops: `stop:["🍂"]` never fired on base and now cuts correctly. `stop:["秋"]` leaked 2 characters on base and now cuts correctly.
- Token ids: identical on 18/18 single-slot requests and on 6/6 batched nb=1 requests.
- CPU cost: +0.09–0.15 µs per token. No speed claim.

**Gates:**
- 0 warnings. Tests 17/17, plus the reviewer's 7 adversarial tests including a 3000-case fuzz.
- V-lin: 28/28 identical. V-multi equal.
- V-contract: `/status` and `th_stats` keys unchanged.

**Review:**
- Verdict **needs-fix** twice, on a high finding: it conflicted with main and broke the batched path after merge. Fixed by the rebase and a new interleaved-slots test. Not re-reviewed since.
- Still open (low):
  - SSE deltas are no longer one per token, and the first content delta can lag the first token. This affects bench TTFT.
  - Holdback is unbounded on a continuous invalid-UTF-8 tail (O(n²)).
  - Held-back text is dropped on the cancel path.
  - The real-tokenizer test skips silently when the snapshot is missing.

**Merge:** FF and clean. It conflicts only with M4 `8d49fdf` (engine.rs, 1 hunk).

### 3.2 Fix branches produced by verification

| branch @ sha | fixes | vs main | vs the rest | recommendation |
|---|---|---|---|---|
| `fix-N1-oproj-shape` @`8bcc3f3` | MEM-1/N1 | clean | conflicts with K7 (qwen35.rs test module at EOF) and with `b9e7971` (same dflash line) | **merge** |
| `verify-memory-MEM1` @`b9e7971` | MEM-1 plus `check_x_extent` in every Q4 op | clean | its quant_kernel.rs extent guards apply cleanly on the integration head; dflash.rs duplicates 8bcc3f3 | port only the quant_kernel.rs hunk |
| `verify-statemachine-B1` @`b5f1457` | B1/MEM-5, MEM-3, admit→Error (the core of M4) | FF | 2 trivial hunks vs K45; conflicts with `7167b6d`, `8664fcc` and M4 | **merge** (keep `lin_apply_ps` and `.context()?`) |
| `verify-statemachine-M1` @`c498244` | M1 | FF | clean | **merge** |
| `verify-statemachine-M3` @`316c18a` | M3 | FF | conflicts with M4 | **merge** |
| `verify-statemachine-M5` @`5c4da25` | M5 | clean (fix commit only; the tip `28acf03` is a probe) | clean | **merge `5c4da25`** |
| `verify-memory-MEM6-r2-clean` @`0188158` | M2/MEM-6 plus a regression test | FF | conflicts only with the alternative `07dc538` | **merge** (preferred over `07dc538`) |
| `verify-statemachine-M2` @`07dc538` | M2 (alternative) | clean (cherry-pick) | conflicts with `0188158` | drop |
| `verify-statemachine-M4` @`8d49fdf` | M4 (`fill_slots` plus a unit test) | FF | conflicts with U1, B1 and M3 | drop; port its unit test onto B1 |
| `verify-memory-MEM3-fix` @`7167b6d` / `verify-memory-MEM5-fb` @`8664fcc` | MEM-3 / MEM-5 | clean | both are inside B1 | drop |
| `verify-numerics-N2-tie` @`786490f` | N2 | conflict (engine.rs) | — | re-port the `dist_vec` hunk and test only |
| `verify-memory-MEM4b` @`b0681a7` | MEM-4 | conflict (dflash.rs) | — | re-port (move the gather below the fused return) |
| `verify-memory-MEM2` @`324f448` | MEM-2 | conflict (draft_kernel.rs; qwen35.rs on the integration head) | GDN sites already fixed by K45 | re-port for the 5 remaining sites |
| `review/statemachine` @`d523828` | anchor off-by-one (single-slot only) | clean | clean on the integration head | measure first; the batch path at engine.rs:1224 needs the same fix |

**Probe-only branches (do not merge):**
- `verify-numerics-N3-attn` @`4f998f4`: split-K attention prototype, the starting point for A1/A2.
- `verify-numerics-N4-draftattn` @`1738e0a`/`dd28d2a`: `draft_attn_split` prototype, the starting point for the N4 fix.
- Plus `verify-memory-MEM1-r2`, `-MEM2-repro`, `-MEM3-batch`, `verify-numerics-N1-oproj`, `verify-statemachine-B1` tip `b161314` (a test-only injector), and the probe commits `f9420e1`, `28acf03` and `7d8aa63`.

### 3.3 Conflict matrix

From pairwise `git merge-tree`. Branches not based on cf3e5f7 were re-checked by merging their commits directly, because normalising them onto main first created criss-cross merge bases and two false conflicts (fix-N1 × MEM-6 and K7 × MEM-6). Both merge clean directly and in the sequence of §3.4. Pairs not listed merge clean.

| pair | file(s) | size |
|---|---|---|
| wp2-matmul-roofline × wp2-m1-decode (as branches) | main.rs, quant_kernel.rs, qwen35.rs | 37 hunks (as a K7 cherry-pick: 4 hunks, about 177 lines) |
| wp2-matmul-roofline × wp10-prefill-tiles | quant_kernel.rs | 1 hunk (re-exports) + E0308 semantic |
| wp2-matmul-roofline × B1 | qwen35.rs (`forward_inner`) | 2 hunks, 22 lines |
| wp10 × wp2-m1-decode | quant_kernel.rs | 1 hunk |
| wp2-m1-decode × fix-N1 | qwen35.rs (test module at EOF) | 1 hunk |
| fix-N1 × MEM1 `b9e7971` | dflash.rs | 1 hunk, 7 lines |
| wp1-utf8 × M4 | engine.rs (EOF test region) | 1 hunk |
| B1 × M4 | engine.rs | 3 hunks, 103 lines |
| M3 × M4 | engine.rs | 1 hunk, 18 lines |
| B1 × MEM3-fix; B1 × MEM5-fix | qwen35.rs | superseded |
| MEM6 × M2 | qwen35.rs | alternatives |

### 3.4 Integration simulation and recommended merge order

I built the merge in a new worktree, `.worktrees/report-integration-sim`, on branch `report/integration-sim` (not pushed). It started from main plus a fast-forward of `5a93868`, then merged the rest:

| # | commit | step |
|---|---|---|
| 1 | FF `5a93868` | th/wp2-matmul-roofline |
| 2 | `310aebb` | U1 `3d8a2c6` |
| 3 | `cfac392` | M1 `c498244` |
| 4 | `bb4292d` | M3 `316c18a` |
| 5 | `a41bcb6` | M5 `5c4da25` |
| 6 | `f02d53f` | MEM-6 `0188158` |
| 7 | `1ec710a` | fix-N1 `8bcc3f3` |
| 8 | `beae488` | B1 `b5f1457`: resolved 2 hunks in `forward_inner`, keeping `lin_apply_ps(&h, .., h_ps)` and `.take().context(..)?` |
| 9 | `7034d4a` | T2 `dc203fd`: resolved the re-export hunk (K45 list plus T2's cfg-gated `pf_*` line) |
| 10 | `8d5b6d5` | semantic fix for T2 × K45 in `gate_up_act_ps` |

**Result @`8d5b6d5`:**
- `cargo build --release` gives 0 warnings.
- `cargo test --release` passes **24/24**, including the 9 `utf8_stream` tests, the `pf_tests` and `mem6_admission_mode_never_changes_inflight_slot`.
- Binary: `$SP/phaseB/report-work/e2e/th-engine-integ-8d5b6d5`, sha256 `e91a30d2afb7…`, cmp-identical to the worktree's release build.
- A TH_BATCH=2 smoke (2 T=0 pairs and 2 sampled pairs, 128 tokens): 9/9 HTTP 200, no errors, no degenerate repetition (max trigram-repeat 0.097). Reported `decode_tps` was 44.6–56.4 per stream, now consistent with wall time because M1 is in.

**Recommended merge order.** This is the order above, and each step is either clean or resolved exactly as in `report/integration-sim`:
1. roofline;
2. U1;
3. M1;
4. M3;
5. M5;
6. MEM-6;
7. fix-N1;
8. B1;
9. T2.

Then port these onto the result, each small:
- K7;
- the N2 `dist_vec` hunk;
- MEM-4;
- the remaining MEM-2 sites;
- `b9e7971`'s `check_x_extent`;
- d523828, extended to the batch path, after an acceptance A/B.

Drop `th/wp2-q4-decode`, `th/review-wp2-m1-merge`, `7167b6d`, `8664fcc`, `07dc538`, `8d49fdf` and `b9e7971` as a whole.

**Ownership.** Per the brief, the other developer's area is engine/src/{dflash,draft_kernel,engine,main,model,qwen35}.rs. Almost every step touches it:
- **Step 1 (K45):** the presum plumbing in qwen35.rs `forward_inner`/`forward_batch`, and dflash.rs `DraftLayer::mlp`, which `propose` and `propose_batch` share.
- **Step 2 (U1):** engine.rs `emit_token`, plus 2 lines in the batch `Run`/`admit`.
- **Steps 3–8:** the batched and slot logic itself:
  - engine.rs: `batch_loop`/`admit`/`batch_round`/`finish_run`/`kv_clear`;
  - qwen35.rs: `Slot`, `forward_batch`, `draft_propose_batch`, `set_kv_quant_slot`, `clear_kv_cache`;
  - dflash.rs: `attention`;
  - model.rs: slot APIs.
- **Step 9 (T2):** qwen35.rs `QLin` routing and main.rs probe blocks. Most of it lives in quant_kernel.rs, which is outside their area, as are gdn_kernel.rs and attn_kernel.rs.
- **Follow-ups:** the N2, MEM-4, anchor and L1 follow-ups also land in engine.rs and dflash.rs.

Their sign-off is needed. Merging the sequence as a unit through them avoids a second round of conflicts. Their tree had no uncommitted edits at 05:1x.

## 4. Round budget after merging, vs Splash and F_k

### 4.1 Measured: main vs roofline vs integration at low CPU load

Sessions s1 and s2 are described in §1.2. Every arm is a fresh server on :8029.

| build | session | T=0 ms/round | T=0 tokens/round | T=0 tok/s | all ms/round | all tokens/round | all tok/s | T=0 propose / verify / rest ms | TTFT median ms |
|---|---|---|---|---|---|---|---|---|---|
| main `cf3e5f7` (`545e5462…`) | s1, 2 passes | 63.00 | 3.450 | 54.76 | 65.02 | 3.406 | 52.38 | 9.6 / 52.3 / 1.1 | 194 / 210 |
| main `cf3e5f7` | s2, 2 passes | 63.13 | 3.450 | 54.65 | 64.96 | 3.406 | 52.43 | 9.7 / 52.4 / 1.0 | 192 / 193 |
| roofline `5a93868` (`5fcad74f…`) | s1, 2 passes | 55.99 | 3.494 | 62.39 | 57.90 | 3.609 | 62.32 | 9.4 / 45.6 / 1.0 | 212 / 210 |
| **integration `8d5b6d5`** (`e91a30d2…`) | s1, 2 passes | **54.66** | 3.605 | **65.95** | 56.39 | 3.249 | 57.62 | 8.0 / 45.7 / 1.0 | 191 / 191 |
| **integration `8d5b6d5`** | s2, 2 passes | **54.53** | 3.605 | **66.12** | 56.26 | 3.249 | 57.75 | 8.1 / 45.6 / 0.9 | 175 / 175 |

- **Per-round speedup, T=0:** −13.2% (s1) and −13.6% (s2) vs main. vs the roofline branch alone it is −1.3 ms, mostly propose: 9.4 → 8.0 ms, which is the MEM-1/N1 fix.
- **Tokens/round.**
  - On the two prompts whose T=0 text is identical across builds (short, long), the logged rounds are 45 (main), 44 (roofline) and 45 (integration): unchanged.
  - Integration's 3.605 comes from the "code" prompt, whose greedy text diverged at id #22 (a numerics near-tie), giving 31 rounds instead of 35.
  - At main's 3.450 tokens/round, integration's per-round time works out to **63.2 tok/s (+15.6%)**.
- **Sampled tokens/round** (9 fixed-seed requests per build) are 3.391 / 3.649 / 3.146 for main / roofline / integration, at near-identical ms/round.
  - Per-request values range from 2.36 to 5.00, and the trajectories diverge between builds from id #14–#99.
  - T=0 acceptance on identical text is unchanged, so there is no sign of a systematic draft regression.
  - A many-seed acceptance study (R0b; also requested by the K45 review) is needed before reading anything into sampled tokens/round.
- **Determinism:** each build's outputs are 12/12 identical across its passes and sessions.
- **TTFT:** integration median 175 vs main 192 ms in s2 (short prompt 148 vs 168). This is T2; th still has no prefix cache.
- **TH_BATCH=2 smoke on the integration:** passes (§3.4).

### 4.2 Where the integration's round goes (T=0, s2)

| phase | main `cf3e5f7` | integration `8d5b6d5` | Splash 1.0 (§1.1, load 26–49) |
|---|---|---|---|
| propose (draft forward + select; ends in 5 host syncs) | 9.7 | 8.1 | — |
| verify host encode (`[verify] enqueue` − propose; includes `snapshot()`) | 9.5 | 7.8 | — |
| verify GPU tail + readback | 43.0 | 37.7 | — |
| rest (accept, commit, rollback, emit) | 1.0 | 0.9 | — |
| **round** | **63.1** | **54.5** | **58.9** (51.3 in the earlier quiet session) |
| GPU-busy (ioreg slope vs rounds; an upper bound for multi-CB th) | 55.9 | 46.9 | 58.7 (50.9 quiet) |
| idle = round − GPU-busy (a lower bound for th) | ≥7.5 | ≥7.7 | ≈0.2 (0.4 quiet) |
| server-process CPU time | 18.1 | 15.1 | — |
| tokens/round | 3.450 | 3.605 (3.450 on identical text) | 3.763 |
| loop tok/s | 54.65 | 66.12 (63.2 at equal tokens/round) | 63.8 (72.4 quiet, at T=0.6) |

- The integration removes about **9 ms of GPU work per round**: K1/K2/K45 kernels, the MEM-1 GEMM waste, and the GDN zero fills. Idle is unchanged at about 7.7 ms.
- **th now does less GPU work per round than Splash 1.0** (46.9 vs 50.9–58.7 ms). The remaining difference is host idle plus tokens/round.
- The ioreg per-process counter was validated only on Splash's one-CB-per-round engine. On th it can double-count overlapping CBs (SYNTHESIS §1.1 caveat). So th's GPU-busy is an upper bound and its idle a lower bound.

**Composition of the integration's 46.9 ms GPU-busy [D]:**
- The verify matmuls account for **about 30.9 ms**. This is the K45 serial-bench per-class time (`3e5cba5`/`5a93868`) times its calls: gate_up 188.5 µs ×64, down 125.3 ×64, in_all 103.7 ×48, out 41.6 ×48, in_qkv 99.1 ×16, o 54.6 ×16, lm_head 1347 ×1. That already sits at the SYNTHESIS matmul fit (30.9 ms).
- The other **about 16 ms** is:
  - the draft forward and select (1.65 GB streamed; bandwidth floor 2.93 ms);
  - verify attention, GDN, norms and captures;
  - commit and rollback rescans;
  - dispatch gaps.
- That split is **unmeasured**. It needs R0c's per-CB GPU intervals; the counter source survives at `/tmp/mem2v/mtlc/mtlc.m`.

### 4.3 Projection: everything delivered merged, and the gap to F_k

| item | state | Δ ms/round (bench context, 58–80-token prompts) | Δ tokens/round | basis |
|---|---|---|---|---|
| integration `8d5b6d5` | built, measured | 54.5 (from 63.1) | 3.45–3.61 | [M] §4.1 |
| K7 port | needs port | ≈0 on DFlash (plain decode +14%) | 0 | [M] `4bb1731`: 60.95 vs 60.70 ms/round |
| MEM-2 remaining sites (32 attention fills per verify, ~40 draft fills) | re-port | −0.8 to −1.2 | 0 | [E] 72/168 of the measured −2.84 ms |
| MEM-4 dead gathers | re-port | −0.15 to −0.3 (ring ≤ 250) | 0 | [M] microbench |
| N2, `check_x_extent` | port | 0 | 0 (identity / safety only) | — |
| anchor off-by-one (`d523828` + batch path) | needs A/B | ≈0 | unknown | not measured |
| **all delivered work merged** | | **≈53.0–53.5 ms/round** | ≈3.45–3.6 | **≈64–68 tok/s at T=0** [E] |
| + L1: always verify 7 (next sprint, effort S) | not implemented | ≈0 | **+8 to +11%** | [M, indirect]: live vs th-44aed06 on identical text |
| **delivered work + L1** | | ≈53 | ≈3.75–3.9 | **≈70–73 tok/s** [E] |

**Against Splash 1.0:**
- Today's measurement: 58.9 ms/round, 3.763 tokens/round, 63.8 tok/s at T=0, CPU load 26–49.
- Earlier quiet measurement: 51.3 ms/round, 3.71 tokens/round, 72.4 tok/s at T=0.6.
- The projected th (delivered work + L1) is at or slightly above Splash-as-measured-today, and roughly at parity with Splash-quiet. Both comparisons cross sessions, so treat them as ±10%.
- SYNTHESIS's target of ≥1.10× shipped Splash 1.0.2 is not reached by delivered work plus L1. It needs idle removal and draft/attention GPU work (§5).

**Against the floors:**
- F_k ≈ 36 ms/round (all matmuls at the measured fit, zero overhead); F_bw 29.8.
- The integration is **18.5 ms/round above F_k**: at least 7.7 ms idle, plus at most 10.9 ms of GPU work beyond the matmul fit.
- After the projection, about **17 ms** remains.
- The matmuls themselves are no longer the gap. in_all and down still miss 480 GB/s, but the whole verify matmul set is at the fit. The gap is GPU work outside the verify matmuls (≤16 ms, which includes the draft forward; split unknown) and host idle.

**Scope limits of this projection:**
- **Long context is not covered.** At 8k context the attention kernel (N3) adds about 45 ms per round and the draft attention (N4) about 8.5–11 ms per round. Their prototypes cut about 37 and 11 ms respectively.
- **Plain decode (no `--draft`)** is a separate track: K7 gives 28.2 tok/s (vs 24.7 base). SYNTHESIS PD1 expected 23–24; the MTPLX reference is 30.4.
- **TTFT:** integration 175 ms median, warm process, no prefix cache. Splash was 149–159 ms, but with prefix-cache hits (T1 not implemented).

## 5. Recommended next items (SYNTHESIS §3.4)

### 5.1 Status of the SYNTHESIS §3.4 items

**Done on main today (the seven perf commits):**
- A1 first cut: fused attention `f1533e5`, but without split-K (N3); Gate C not run.
- D2: GPU-resident draft ring, `5edd9a3`.
- D4 part: fused draft conv, norm+rope and attention, `90cbcfe`, with the N4 occupancy problem.
- D1 part: 14 codebook syncs → 2 (`90cbcfe`) plus cross-slot gathers (`cf3e5f7`). 5 syncs per propose remain.
- GDN fusion: `c5ca3fa`, `0ee13e6`.
- Greedy verify readback 4 MB → 36 B: `ba8ee49`.

**Delivered on branches:**
- K1, K2, P0 (a measured E2E no-op), K45 (≥480 GB/s on gate_up only), K7, T2, U1.
- H1q: Q4 and GDN env reads cached.
- K3' part: K45's uninitialised outputs plus presum blocks.
- Gate A part: split-K vs sequential-K on th only.

**Not started:** R0a, R0b, R0c, B0, A0 (th vs Splash acceptance), **L1**, Q1, **G1a**, G1b, S1, EQ1, T1, D3, X1, X2, X3, A2, F2, K6, V1, V3, G2, C1b.

### 5.2 Next sprint, in order

"Other dev" means files in the other developer's area: engine/src/{dflash,draft_kernel,engine,main,model,qwen35}.rs, and in particular the batched and slot code.

| # | item | expected gain (basis) | files | owner / coordination |
|---|---|---|---|---|
| 1 | **Same-session Splash re-baseline at low CPU load.** V-bench-style, using the ABBA harness in `.worktrees/bench-base-44aed06/.bench-baseline/`. It needs :8000 and about 17 GB free: the Splash memory governor refused to start with th resident, so stop :8001 or use an idle machine. B0 (Splash 1.0 → 1.0.2) needs user go-ahead. | makes every vs-Splash number valid | scripts only | — |
| 2 | **L1: always verify 7.** Set `verify_len = PROPOSALS` in the single-slot loop (engine.rs:431 on the integration head). | **+10.8% tokens/round at T=0, +11.0% at T=0.6**, on identical text (live vs th-44aed06, §1.1), at ≈0 ms (fwd2 ≈ fwd8) [M indirect]; effort S | engine.rs | other dev's file (single-slot loop) |
| 3 | **Anchor off-by-one:** `d523828`, plus the same change in the batch loop (engine.rs:1224). | tokens/round unknown; KV row P is currently attended as zeros [probe-confirmed] | engine.rs | other dev (batch loop) |
| 4 | **Land the integration** (§3.4 order) plus the small ports (K7, N2, MEM-4, the rest of MEM-2, `check_x_extent`). Then restart :8001 from the merged build: pid 16917 is the stale 18:08 dirty build, has every §2.2 bug, and reports M1-inflated decode_tps. | −8.6 ms/round measured (§4.1); −1 to −1.5 more [E] | engine, qwen35, dflash, quant_kernel, gdn_kernel, main | other dev must sign off on the batched-path fixes |
| 5 | **G1a: host-side GDN parity state** (two persistent state buffers, out-of-place GdnStep). Land R0a's state-bitwise rollback gate first; today's `TH_TEST_ROLLBACK` cannot serve as a gate. | −7.8 to −10.2 ms/round [E, SYNTHESIS at 441acec]. `snapshot()` still copies 48 × 3 MiB per slot per round (the MEM-3 verifier measured 24.3 ms/round of snapshot at nb=4) | qwen35.rs `snapshot`/`restore`/`rollback_verify(slot)`; gdn_kernel.rs | qwen35 slot API is the other dev's; gdn_kernel.rs is not |
| 6 | **Host idle:** D1 remainder (5 propose syncs → 1: the three `cand_tables` readbacks at dflash.rs:577/582/602 and 2× `gather_cb` at :549, line numbers @8d5b6d5); Q1 decode-thread QoS; then S1 (GPU accept, 12-u32 result block) and X1/X2 (own queue, one CB per round). | idle is ≥7.7 ms/round quiet and 36–42 ms under load 26–49; th's CPU sensitivity is the main practical risk | dflash.rs, engine.rs, new sample_kernel.rs, new runtime/ | other dev (dflash, engine) |
| 7 | **Long context:** N3 → A1/A2 split-K attention (prototype `4f998f4`); N4 → draft_attn split (prototype `1738e0a`). Gate C: ≤1.5× Splash per layer at 128/512/2K/8K. | −37 ms/round at 8k and −75 at 16k (N3); −11 ms/round at ≥2k (N4) [M prototypes] | attn_kernel.rs + qwen35.rs `attn_forward` (N3); dflash.rs + draft_kernel.rs (N4) | N4 part is the other dev's |
| 8 | **R0 harness:** R0a (rollback gate v2 state-bitwise, fix the `seed \| 1` seeding, sync the prefill timer, time `[verify] enqueue` from `t_prop`, histogram labels); R0b (`gen` + acc30 + a many-seed acceptance A/B, which also settles §4.1's sampled spread and K45(d)); R0c (mtlcount v2 per-CB intervals, bench-th-vs-splash.sh). | enabler: every numerics decision and Gate A | main.rs (probe), engine.rs timers, scripts, engine/tools | main.rs and engine.rs are the other dev's; tools and scripts are free |
| 9 | **K45 follow-ups:** re-measure or turn off the `down` split_long PreSums default (medium review finding); attention-output presum block (bench −12% on `o`); draft presum producers (bench −13% to −24% on draft projections); carry presum-ness in the type. | ≈0.3–1 ms [E] | quant_kernel.rs, gdn_kernel.rs, attn_kernel.rs, dflash.rs | dflash part is the other dev's |
| 10 | **Before TH_BATCH>1 becomes a default:** all §2.2 fixes merged, T2 merged, hoist the per-slot `out` projection, presum for >8-row activations (K45 §9.6). | today B=4 gives 72.4 tok/s aggregate vs 48.2 single-stream (M1 verification, `cf3e5f7`) | qwen35.rs `forward_batch` | other dev |

## Appendix A: how this report's numbers were produced

`SP=/private/tmp/claude-501/-Users-benebsworth-projects-token-horizon/23793a29-ce9d-4130-926c-f9e358304530/scratchpad`, `W=$SP/phaseB/report-work`.

**Merge analysis** (read-only for the main tree):
- `GIT_OPTIONAL_LOCKS=0 git merge-tree --write-tree --name-only main <sha>` and variants.
- Scripts: `$W/mt.sh` (each branch vs main → `$W/mt_main.txt`), `$W/seq.sh` (sequential orders via merge-tree + commit-tree, with no refs → `$W/seqA.txt`, `seqB.txt`, `seqC.txt`), `$W/pairs.sh` (pairwise matrix → `$W/pairs.txt`), and direct re-checks for branches not based on cf3e5f7.
- Conflict excerpts: `$W/conf_*.txt`. Hunk counts: `$W/conf_counts.txt`.

**Integration branch:**
```sh
git worktree add -b report/integration-sim .worktrees/report-integration-sim main
cp -c -R .worktrees/th/wp2-matmul-roofline/engine/target .worktrees/report-integration-sim/engine/target   # APFS clone
git merge --ff-only th/wp2-matmul-roofline
git merge --no-ff <3d8a2c6 | c498244 | 316c18a | 5c4da25 | 0188158 | 8bcc3f3 | b5f1457 | th/wp10-prefill-tiles>
# conflict resolutions: see commits beae488 (B1), 7034d4a (T2 re-exports), 8d5b6d5 (E0308 semantic fix)
(cd engine && cargo build --release && cargo test --release)    # 0 warnings; 24 passed
```
`$SP/bin/wt-bootstrap` does not exist, so the worktree was created by hand.

**E2E sessions** (all under `$SP/bin/gpu-lock`, private port :8029):
```sh
$SP/bin/gpu-lock -- $W/e2e/session.sh    # s1: unit tests, then main, roof, integ, integ, roof, main; then TH_BATCH=2 smoke on integ
$SP/bin/gpu-lock -- $W/e2e/session2.sh   # s2: main, integ, integ, main, with per-request ioreg GPU ns + process CPU time
python3 $SP/phaseB/k45/parse_k45.py $W/e2e/s1 main_1 main_2 roof_1 roof_2 integ_1 integ_2    # ratio of sums, token identity
python3 $SP/phaseB/k45/pool_e2e.py  $W/e2e/s2 main:main_3,main_4 integ:integ_3,integ_4
python3 $W/e2e/gpufit.py            $W/e2e/s2 main:main_3,main_4 integ:integ_3,integ_4        # GPU-busy / CPU / wall slopes vs rounds
python3 $W/e2e/ttft.py              $W/e2e/s2 main_3 main_4 integ_3 integ_4
```
- Clients:
  - `$W/e2e/client.py`: the k45 client with seeds 1, 3, 5.
  - `$W/e2e/client2.py`: the same plus the GPU and CPU probes.
  - `$W/e2e/batch2_client.py`.
- Outputs: `$W/e2e/session.out`, `session2.out`, `s1_{pool,parse,ttft,batch2}.txt` and `s2_{gpufit,pool,ttft,ident}.txt`. Raw logs and JSONL are in `$W/e2e/s1/` and `$W/e2e/s2/`.
- Binaries:
  - main: `$SP/phaseB/wp2fix/th-engine-main-cf3e5f7` (sha256 `545e5462efb6…`)
  - roofline: `$SP/phaseB/wp2fix/th-engine-wp2-5a93868` (`5fcad74fb8bc…`)
  - integration: `$W/e2e/th-engine-integ-8d5b6d5` (`e91a30d2afb7…`)

**Other inputs:**
- Phase-B subagent structured outputs, extracted to `$W/so/*.txt`: reviews, verifications, implementations, fixes.
- Implementation reports: `$SP/phaseB/impl-th-wp1-utf8-stream.md`, `impl-th-wp10-prefill-tiles.md`, `impl-th-wp2-matmul-roofline.md`, `impl-th/wp2-m1-decode.md`.
- The wp2-q4-decode result exists only as the structured output relayed in the task, because that agent wrote no report file.

**Cleanup:**
- **Servers:** 11 th-engine servers were started on :8029 (7 in s1, 4 in s2). Each was stopped with SIGTERM by `serve.sh`. Afterwards no `th-engine serve` process is left except the pre-existing pid 16917, and :8029 is free.
- **Ports :8000 and :8001:** never touched. :8001 is still pid 16917; :8000 was not listening.
- **Main working tree:** not modified; read only, with `GIT_OPTIONAL_LOCKS=0`.
- **New worktree:** `.worktrees/report-integration-sim`, branch `report/integration-sim` at `8d5b6d5` (9 merge/fix commits on `5a93868`, trailer `Co-Authored-By: Claude Opus 5.5`, not pushed). Keep it as the merge reference, or delete it with `git worktree remove .worktrees/report-integration-sim && git branch -D report/integration-sim`.
- **Dangling objects:** `merge-tree` and `commit-tree` left unreferenced objects behind; `git gc` will remove them.
