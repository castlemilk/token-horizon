# th/d-sampled: R0b sampled-acceptance study + S1 GPU-side sampled acceptance + B1 block verification

Written 2026-09-26 by the th/d-sampled agent. §0–§7 were reconstructed from the run artifacts after review; §8 (Review fixes) records the review round. M5 Max (40-core GPU, 128 GB), Qwen3.8-27B-4bit + DFlash draft,
private port :8042, every GPU run inside `$P/bin/gpu-lock`, fresh server per arm, `TH_DEBUG_TIMING=1`.
Tags: [M] measured, [D] derived.

- **Branch:** `th/d-sampled` (worktree `/Users/benebsworth/projects/token-horizon/.worktrees/th/d-sampled`), from `main` @`521c6e0`, head `8946bce`. Not pushed.
- **Work dir:** `W=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC/work/th-d-sampled/` (`tools/`, `bin/`, `runs/`). Session logs: `runs/<session>.session.out`, per-request records `runs/<session>/runs.jsonl` (+ server logs sliced by byte offset).
- **Machine state:** heavily shared. Four phase-D lanes build and benchmark concurrently, and unrelated jobs outside the lanes run too (an ML Python job at ~490% CPU, a VM, xctest, Docker). During the m1 arms the 1-min load was 7–94 and thermal pressure was level 1–2. The GPU lock was contended, with waits of 15–60 min.
  - Acceptance (tokens/round) and correctness results do not depend on load.
  - Timing from m1 is **not** a standing measurement (§5).
  - The quiet re-measure is §8.3.

## 0. Summary

| commit | item | default | sampled streams vs 521c6e0 |
|---|---|---|---|
| `da7718e` | **R0b** instrumentation: `TH_ACCEPT_STATS=1` (Rao-Blackwellised per-round acceptance), `TH_TOP_P=renorm` (Splash/HF top-p semantics), `TH_DRAFT_FILTER=1` (request top-k/top-p on the draft's 16 candidates) | all off | unchanged |
| `ee270c6` | **S1** sampled DFlash acceptance on the GPU (`sample_kernel.rs`: `ts_topk` + `ts_accept` in the verify command buffer, 16-word readback), bit-exact CPU reference, `TH_SAMPLE=gpu\|cpu\|check` | `gpu` | change once (same distribution); T=0 unchanged |
| `2664850` | **B1** block verification (Sun et al. 2024) on GPU + CPU, `TH_SPEC_VERIFY=block` | token rule | none by default |
| `c81d9da` | **Z1** cache-friendly `global_z` on the CPU path (same bits) | on | unchanged |
| `33d6398` | **B1 default**: block verification where the GPU kernel serves the request (top-k 1..=32, no repeat penalty), token rule on the CPU path; `TH_SPEC_VERIFY=block\|token` forces | auto | change once more for GPU-servable requests |
| `8946bce` | **review fix**: no full-vocabulary sort for sampled rows without top-k (§8.1) | on | only requests with no top-k **and** no top-p (id-order walk); everything else bit-identical |

Where the evidence stands:

- **Correctness [M]:**
  - GPU == CPU bit for bit: unit test 160 trials × 2 rules; `TH_SAMPLE=check` 2178 + 222 rounds (S1) and 2128 + 182 rounds (B1 block rule), 0 mismatches.
  - `TH_TEST_ROLLBACK` PASS on every binary tested.
  - T=0 texts identical to base on every arm compared.
  - B1 is exact by enumeration (300 toy models, both rules, 1e-12) and by Monte Carlo (4 × 300k).
  - Review-fix head `8946bce`: §8.4.
- **Acceptance [M]:**
  - The PHASEC sampled tokens/round gap (3.590 vs 4.014, 0.894×) was mostly small-sample noise. R0b over 15 prompts × 5 seeds: base 4.140 vs Splash 4.131 (1.002 [0.967, 1.036]). On the 3 bench prompts × 20 seeds: 0.963 [0.916, 1.016].
  - Top-p semantics and draft filtering have no significant effect.
  - Block verification: +0.91% tokens/round on the same drafted blocks, CI [0.40%, 1.42%]. Realized, it runs 1.031× Splash [1.004, 1.061] and 1.022× the S1 token rule [0.988, 1.065].
- **Timing:**
  - m1 (§5) ran at load 7–94, thermal 1–2, with a ±17% arm-to-arm spread on the identical T=0 path. Only the host phase deltas on byte-identical streams hold up: S1 removes 3.5–5.7 ms/round of `rest`.
  - The quiet re-measure could not be run: load1 never fell below 6 during the review round (min 7.97 over 124 samples, §8.3).
  - The moderate-load fallback m3m (one hold, thermal 0 at arm start, load 11–27, base2 lost to a load spike) reads, `8946bce` vs base1:
    - sampled loop tok/s **1.152×** [1.089, 1.225] (ms/round 0.893, tokens/round 1.029);
    - T=0 / ctx 1.45k / ctx 8k 0.98–0.99× on identical texts (unchanged code; this is the noise control);
    - ctxs 0.971× [0.910, 1.030].
  - **The standing (sampled 0.876× Splash) is not updated.** A quiet same-session run is still needed.

## 1. Builds

Frozen copies in `$W/bin/`. sha256 prefixes [M]:

| label | commit | binary | sha256 | ran in |
|---|---|---|---|---|
| base | `521c6e0` (= main, = integration-2) | `th-engine-base-521c6e0` | `66e99644…` | r0b, t1, m1 (base1/base2/base3), m3t |
| R0b | `da7718e` | `th-engine-R0b-da7718e` (= `A2-wip`) | `afa35125…` | r0b3 (filt, filtrenorm, stats2) |
| S1 | `ee270c6` | `th-engine-S1-ee270c6` | `91d6af86…` | v1 gates, t1 |
| Z1 | `c81d9da` | `th-engine-Z1-c81d9da` | `d3d1861f…` | m1 gates + stats + tok/blk/cpu arms |
| B1 default | `33d6398` | `th-engine-B1a-33d6398` = `th-engine-final` = `B1a-wip` = `B1d-Z1` (byte-identical) | `a023ca58…` | m1 **b1d arm only** (t0 + sampled); m3g as the pre-fix reference |
| review fix | `8946bce` | `th-engine-R1-8946bce` | `cf8c2941…` | m3g, m3t |
| tests @8946bce | `8946bce` | `th-engine-tests-R1-8946bce` | `a8400e85…` | m3g |

## 2. R0b: why th's sampled tokens/round trailed Splash's

PHASEC §1.1 measured sampled (T 0.6 / top-p 0.95 / top-k 20) tokens/round of 3.590 for th against 4.014 for Splash (0.894×) over 3 bench prompts × seeds 1, 3, 5 (9 requests per engine). R0b re-measured it with more requests, and with a paired Rao-Blackwellised per-round acceptance that is independent of the sampled trajectory.

| comparison (sampled) | th | reference | ratio [95% CI, prompt-cluster bootstrap] | source |
|---|---|---|---|---|
| base vs Splash 1.0, 15 prompts × seeds 1,3,5,7,9 | 4.140 (2097 rounds) | 4.131 (2172 batches) | **1.002** [0.967, 1.036] | r0b base1, v1 splash1 [M] |
| base vs Splash 1.0, 3 bench prompts × seeds 11..49 odd | 3.743 | 3.886 | **0.963** [0.916, 1.016] | m1 b3: base3, splash3 [M] |
| `TH_TOP_P=renorm` vs global | 4.147 | 4.140 | 1.002 [0.964, 1.044] | r0b2 renorm [M] |
| `TH_DRAFT_FILTER=1` vs off | 4.184 | 4.140 | 1.011 [0.977, 1.042] | r0b3 filt [M] |
| draft filter + renorm vs off | 4.174 | 4.140 | 1.008 [0.974, 1.046] | r0b3 filtrenorm [M] |

- **Rao-Blackwellised, on the same drafted blocks** (r0b2/r0b3 stats arms, 2172 rounds):
  - E[accepted | block] is 3.154 under global and 3.154 under renorm top-p (ratio 0.9999). The kept set differs on 3.8% of rows; the mean kept count is 2.30 (global) vs 2.21 (renorm), and 54.7% of rows keep exactly one token.
  - Draft filtering raises the acceptance overlap from 3.170 to 3.182 (+0.4%) [M].
  - Per-position acceptance a_i is 0.806, 0.745, 0.669, 0.637, 0.609, 0.579, 0.538 [M].
- **Acceptance histogram**, base th sampled (2097 rounds), share of rounds accepting 0…7 proposals: 19.4, 17.6, 14.2, 9.6, 7.3, 4.2, 4.8, 22.9% [M].
- **Conclusion [D]:**
  - th's token-rule acceptance matches Splash's within noise, so there is no acceptance defect.
  - The sampled gap in PHASEC was per-round cost (sampled rounds +2.3 ms over greedy: `[8, vocab]` readback + CPU `dist_vec`/`spec_accept_step`) plus sampling noise in tokens/round. S1 targets the first.
  - B1 (block verification) adds acceptance beyond the token rule, which both engines used.
  - Renorm and the draft filter stay opt-in and off.

## 3. S1: sampled acceptance on the GPU (`ee270c6`)

- **Design:**
  - `ts_topk` runs one 1024-thread threadgroup per verify row. It computes the exact top-k (k ≤ 32) by (logit desc, id asc) via the k-th largest lane maximum and a candidate pool, plus the full-vocab partition `Z` for candle's global top-p rule (lane-strided partials + a fixed binary tree).
  - `ts_accept` runs one thread per slot. It performs the acceptance chain: target filter, the division-free `u·q·S < w` test, and residual/bonus draws.
  - Both are encoded in the verify command buffer. The host reads back a 16-word result block (emitted ids, accepted count, uniforms consumed) instead of the `[8, 248320]` bf16 logits (~4 MB).
  - Uniforms are 24-bit (xorshift64* top 24 bits, one stream step per draw, staged by the host; the RNG re-advances by the consumed count).
  - The CPU reference (`cpu_row_dist` + `accept_chain`) uses the same arithmetic: `th_expf` from exact ops + explicit fma, and f32 sums in the kernel's order. Kernels compile with safe math and fp contraction off.
  - `TH_SAMPLE=cpu` runs the reference. `TH_SAMPLE=check` runs both per round and logs `[samplecheck]`.
  - The CPU path also serves repeat-penalty requests, top-k 0 / > 32, the prefill anchor and the non-draft loop. `top_k: 0` means "no top-k"; it panicked in 521c6e0 (`select_nth_unstable_by(k - 1)`).
- **Gates [M]:**
  - `gpu_accept_matches_cpu_reference`: 160 random 248k-vocab trials × {token, block}, 0 mismatches, consumed count included.
  - v1 gates on the S1 binary `91d6af86`:
    - `TH_TEST_ROLLBACK=1 TH_BATCH=2` probe: rc 0, "rollback state-bitwise: PASS".
    - `TH_BATCH=2 TH_SAMPLE=check` smoke: 222 rounds, 0 mismatches.
    - Single-slot `TH_SAMPLE=check` (15 prompts × 5 seeds + T=0 15 + ctx 1.45k × 3 + ctx 8k × 2): **2178 rounds, 0 mismatches**.
  - m1 identity on Z1:
    - `TH_SAMPLE=cpu` vs gpu: texts identical 72/72 (t0, ctx, sampled, ctxs); cpu1 vs cpu2 72/72; tok1 vs tok2 72/72.
    - T=0 vs base: base1 vs tok1 18/18; base1 vs chk 20/20 (t0 15, ctx 3, ctx8k 2).
- **Host cost [M, m1, identical streams]:**
  - In-binary `TH_SAMPLE=cpu` vs gpu on 45/45 identical sampled requests: `rest` falls from 5.08 to 1.59 ms/round.
  - Base vs S1 on the 6/45 byte-identical sampled requests: `rest` falls from 7.61 to 1.91 ms/round (−5.70). ctxs 3/9: from 9.66 to 1.03.
  - Whole-round deltas in the same pairs (step +1.01 ms cpu→gpu, −0.70 ms base→tok) are inside m1's load noise (§5).
- **Z1 (`c81d9da`) [M, micro-bench under load]:**
  - `global_z` walked the row lane by lane: 1024 passes with a 4 KB stride.
  - Walking it in 1024-wide chunks keeps the same bits and cut its cost from 0.79 to 0.19 ms per 248k row.
  - `cpu_row_dist` at k 20 went from 1.78 to 0.75–0.84 ms per row (pre-S1 `dist_vec`: 0.97).
  - Test `global_z_matches_strided_order` confirms bit identity.

## 4. B1: block verification (`2664850`, default `33d6398`)

- **Rule:**
  - The token rule accepts proposal i with probability min(1, p/q) and stops at the first rejection.
  - Block verification (Sun et al. 2024, Alg. 2) carries c_i = min(1, c_{i−1}·p_i/q_i), R_i = Σ_x (c_i·p_{i+1}(x) − q_{i+1}(x))⁺ and h_i = R_i / (R_i + 1 − c_i). It accepts τ = the last i + 1 with η_i < h_i and draws the correction from (c_{τ−1}·p_τ − q_τ)⁺.
  - The output has the same distribution as the token rule, and never fewer accepted tokens in expectation.
  - Implemented division-free (c as a pair (n, d)), bit-exact between `ts_accept` and `accept_block`; it consumes exactly vlen + 1 uniforms.
- **Exactness tests [M]:**
  - `block_rule_is_exact_by_enumeration`: 300 random sparse / point-mass / support-mismatched toy models; both rules reproduce the target joint to 1e-12; Σ E[τ] block / token = 1.0387.
  - `accept_block_is_exact_monte_carlo`: the f32 implementation end to end, 4 instances × 300k trials, within 5σ. Accepted per round, token vs block: 2.219 / 2.332, 3.618 / 3.878, 0.889 / 0.892, 2.402 / 2.674.
  - `accept_block_matches_analytic_rule`: 2000 realistic blocks; the f32 decision equals the analytic τ, and 678 blocks accepted all 7.
  - `gpu_accept_matches_cpu_reference` covers both rules.
- **Acceptance gain [M]:**
  - Same drafted blocks, Rao-Blackwellised (m1 stats arm, Z1 + `TH_ACCEPT_STATS=1`, 15 prompts × 5 seeds, 2161 rounds): E[accepted] rises from 3.1935 to 3.2318, i.e. tokens/round ×**1.0091** [1.0040, 1.0142].
  - Realized (m1 gates chk arm, `TH_SPEC_VERIFY=block TH_SAMPLE=check`, 15 prompts × 5 seeds): 4.260 tokens/round.
    - vs S1 token rule 4.167: 1.022 [0.988, 1.065].
    - vs base 4.140: 1.029 [0.985, 1.081].
    - vs Splash 1.0 4.131: **1.031** [1.004, 1.061].
  - B1 accept histogram (2044 rounds), share of rounds accepting 0…7: 19.4, 17.2, 12.3, 9.2, 6.5, 5.8, 4.9, 24.5%.
- **Default (`33d6398`):**
  - The rule depends only on the request's parameters (`gpu_servable_request`: top-k 1..=32 and no repeat penalty in effect), never on the execution path. `TH_SAMPLE=cpu` / `check` therefore replay the same stream.
  - GPU-servable requests use block verification: `ts_accept`'s extra work is a few µs of one thread.
  - CPU-path requests keep the token rule. There the block rule needs all 8 row distributions (~0.8 ms each) while the token rule stops at the first rejection (~4.1 rows).
- **Gates on the B1 code [M, m1, Z1 binary `d3d1861f` with `GATE_ENV=TH_SPEC_VERIFY=block`]:**
  - Tests 45/45.
  - `TH_TEST_ROLLBACK` rc 0 (state-bitwise PASS).
  - `TH_BATCH=2 TH_SAMPLE=check`: 182 rounds, 0 mismatches.
  - b2 T=0 slots identical to integration-2's base 6/6.
  - Single-slot chk (15 prompts × seeds 1..9 odd + T=0 15 + ctx 1.45k × 3 + ctx 8k × 2): **2128 rounds, 0 mismatches**.
- **Coverage of `33d6398` itself:**
  - Its binary (`a023ca58`) ran only in m1's b1d arm: t0 + sampled, 15 prompts × seeds 1,3,5, adjacent to the palindrome, not inside it. Sampled texts were identical to blk1/blk2 (Z1 + `TH_SPEC_VERIFY=block`) 45/45, and T=0 identical to base1 15/15.
  - Its check-mode coverage transfers from `c81d9da` because the commit is rule selection only. `git show 33d6398` touches only `engine.rs`: `Sampler.gpu_servable`, `spec_verify_forced` / `spec_verify_rule` (replacing `block_verify`), `gpu_servable_request`, and test `b1_default_rule_by_request`. Kernels and CPU reference are untouched.
  - The review round re-ran all gates on `8946bce`, which contains it (§8.4).

## 5. Timing, m1 session: heavily loaded, NOT a standing measurement

m1 (17:14–18:14) ran a palindrome on :8042: base1 tok1 blk1 cpu1 cpu2 blk2 tok2 base2, then the adjacent b1d arm.

- base = 521c6e0.
- tok / blk / cpu = the Z1 binary: GPU token rule / `TH_SPEC_VERIFY=block` / `TH_SAMPLE=cpu`.
- Suite: p15 × seeds 1,3,5 sampled + t0 + ctx (1.45k T=0) + ctxs (1.45k sampled); base1 also ctx8k.

Per-arm conditions [M]:

| arm | load1 | thermal | external GPU ms/s | sampled ms/round | sampled tok/round | sampled loop tok/s | t0 ms/round |
|---|---|---|---|---|---|---|---|
| base1 | 18.7–93.6 | 2 | 27.0 | 67.80 | 4.109 | 60.60 | 62.82 |
| tok1 | 53.7–77.8 | 2 | 24.1 | 66.32 | 4.124 | 62.18 | 74.28 |
| blk1 | 16.4–30.1 | 1–2 | 23.4 | 55.75 | 4.189 | 75.14 | 58.96 |
| cpu1 | 7.2–18.3 | 1–2 | 23.9 | 53.58 | 4.124 | 76.96 | 52.67 |
| cpu2 | 41.9–85.4 | 2 | 38.1 | 69.92 | 4.124 | 58.98 | 69.06 |
| blk2 | 19.4–51.4 | 2 | 59.3 | 61.15 | 4.189 | 68.50 | 64.79 |
| tok2 | 18.2–31.4 | 2 | 50.5 | 59.19 | 4.124 | 69.66 | 65.48 |
| base2 | 15.8–29.4 | 2 | 49.5 | 60.95 | 4.109 | 67.42 | 62.25 |
| b1d (`33d6398`) | 13.0–20.2 | 2 | 30.6 | 58.06 | 4.189 | 72.14 | 62.38 |

- **Noise:**
  - The T=0 path is identical code in every arm (argmax rows), yet it read 52.67–74.28 ms/round (±17%).
  - Base read 67.42 tok/s sampled in base2 against 72.58 in the quiet PHASEC standing (−7%).
  - That drift is the size of the effects claimed.
- **Not established by m1:**
  - The previously quoted headline (sampled 58.06 vs 60.95 ms/round, 72.14 vs 67.42 loop tok/s) is b1d against base2: a single adjacent arm against one palindrome arm, both at load 13–29 and thermal 2.
  - The same holds for the bootstrap ratios over both arms: blk/base sampled tok/s 1.123 [1.049, 1.201], ms/round 0.908 [0.880, 0.930], tokens/round 1.019 [0.954, 1.092]. The blk vs tok arms differ by 11.5% on the identical T=0 path, so load contaminates these ratios.
  - Long-context timing of head vs base: m1 timed ctx/ctxs for tok/blk/cpu vs base, but ctx8k for base1 only, and `33d6398` ran no long-context arm.
- **What m1 does support [M]:** the host `rest` phase on byte-identical requests (§3), i.e. −3.5 to −5.7 ms/round of CPU work per sampled round.
- **t1** (11:24–13:23, base / S1 gpu / S1 cpu) is **invalid**: external GPU contention put every arm at 162–660 ms/round. The one exception is base2's ctx mode at 62 ms. t1 is not used anywhere.

## 6. Standing vs Splash

The standing remains PHASEC's quiet session (main `521c6e0`, s1+s2): T=0 1.031×, sampled **0.876×**, ctx 1.45k 0.782×, ctxcold 0.794×.

- R0b changes the reading of the sampled number: its tokens/round component is 0.963–1.002 with larger samples [M], not 0.894.
- No quiet session of this branch exists. The best same-session evidence is m3m (§8.3, moderate load): sampled loop tok/s 1.152× base.
- Applied to the standing, that is an [E] projection of ≈ 1.01× Splash (0.95–1.07×). It is not a standing.

## 7. Not done / known limits

- **Splash** was not re-timed alongside `8946bce`. The Splash references in §2 and §4 are acceptance only: v1 splash1 and m1 b3 splash3, from sessions without a th arm in the same hold, with thermal level 2.
- **Block verification on the CPU path** stays off by default (cost argument above). `TH_SPEC_VERIFY=block` forces it and is exact there too.
- **Tail precision:** on no-top-k requests (CPU only), the f32 running sum of the categorical walk absorbs tail weights below half an ulp of the running sum. Those ids become unreachable.
  - This comes from S1's f32 arithmetic (pre-S1 `dist_vec` summed in f64).
  - It predates the fix, and id order loses less: each id's threshold is at most the rank-order one. Worst |s − exact|/exact on synthetic heavy-tailed rows: 6.0e-4 in id order vs 1.1e-3 in rank order (§8.1).

## 8. Review fixes (2026-09-26 evening, head `8946bce`)

The review raised three must-fix findings. Fix commit: `8946bce` "review fix — no full-vocab sort for sampled rows without top-k", one file, `engine/src/sample_kernel.rs`.

- Binaries: `th-engine-R1-8946bce` sha256 `cf8c294169146f34…`; tests `th-engine-tests-R1-8946bce` `a8400e8568ddc516…`.
- Build: `cargo build --release` in the worktree, 0 warnings.
- Sessions: gates **m3g** (`tools/m3g_session.sh`, 19:44–20:00, one gpu-lock hold); timing **m3t** (`tools/m3t_session.sh` via `tools/run_m3t.sh`, §8.3).
- Analysis: `tools/analyze_m3.sh`.

### 8.1 Finding 1 (high): full-vocabulary sort for sampled rows without top-k (fixed)

**Bug.** `cpu_row_dist` (`sample_kernel.rs:219` before the fix) always ran `idx.sort_unstable_by(cmp)`. With top-k off (`k == n`), that is an indirect sort of all 248,320 ids per verified row. The pre-S1 `dist_vec` did not sort at all without top-p; with top-p it sorted all n weights too.

**Which requests were affected.** Narrower than the finding assumed. Measured in m3g:

- **Requests that omit `top_k` are not affected.** The server config starts from `EngineConfig::default()` (`main.rs:132`), which sets `top_k: Some(20)`, `top_p: Some(0.8)` (`state.rs:70-71`). `--top-k` only overrides that. So an OpenAI-style `{"temperature": 0.7}` request resolves to top-k 20 and takes the GPU path.
  - m3g arms `omitn` / `omitf` (temperature 0.6 only, `TH_SAMPLE=check`): 225 GPU-checked rounds each, 0 mismatches; texts identical between `8946bce` and `33d6398` 9/9.
- **`top_k = None` is unreachable at runtime.** `POST /engine/config {"top_k": null}` returns `ok` and leaves `top_k = 20` (m3g `nullcfg`: GET /engine/config read `top_k=20 top_p=0.8`). serde maps `null` onto the outer `None` of `ConfigPatch.top_k: Option<Option<usize>>`, i.e. no change.
- **Affected shapes:**
  - An explicit `"top_k": 0`, a common "disabled" convention. It is legal since S1 and panicked in 521c6e0.
  - `top_k >= vocab`, which was reachable in 521c6e0 too.
  - Either with or without top-p. For the token rule, every verified row paid the sort, about 4 rows/round.

**Fix** (`sample_kernel.rs`):

- `cpu_row_dist` (`:232`) dispatches on the shape. When `k == n`:
  - no top-p goes to `full_vocab_dist` (`:253`);
  - global top-p goes to `top_p_prefix_dist` (`:284`);
  - anything else goes to `sorted_row_dist` (`:326`), which is the old body, byte for byte.
- **`full_vocab_dist`** (no top-k, no top-p): the whole vocabulary in id order.
  - One linear max (N2 tie rule: lowest id among equal maxima) and one exp/sum pass.
  - Every id keeps the **same `w` bits** as in the rank-ordered form.
  - `sample_dist`, the `accept_chain` residual and `accept_block` are categorical walks over (id, w) pairs, so the distribution is unchanged. A given uniform lands on a different token, so **this class's sampled streams change** (same distribution).
  - No weight at all (all −inf/NaN, or 1/T overflowing) is deterministic on the same token as before.
  - The walk can never fall through to a zero-weight id: s ≥ 1 (the max's weight is exactly 1) and u ≤ 1 − 2⁻²⁴, so u·s < s strictly.
- **`top_p_prefix_dist`** (no top-k, global top-p, the default semantics): sorts only the candidates with key > θ, where θ = m + T·ln((1 − top_p)/(2n)).
  - Those candidates form a rank prefix. The mass below θ is at most (1 − top_p)/2 ≤ (1 − top_p)·Z/2, so top-p's cut lands inside the prefix unless top_p is within f32 rounding of 1.
  - Inside the prefix, `w`, `keep` and `s` are the full sort's, **bit for bit**. When the cut is not decided inside the prefix, it returns `None` and the full sort runs.
  - **Streams unchanged.**
- **Unchanged:** top-k 1..vocab−1 (CPU or GPU), and renorm top-p without top-k (opt-in `TH_TOP_P=renorm`: its limit is a rank-order sum over all n, so it keeps the full sort).
- The `RowDist` and module docs now state the id-order case. The module doc's stale `TH_SAMPLE_CPU=1` / `TH_SAMPLE_CHECK=1` names are corrected to `TH_SAMPLE=cpu|check`.

**Tests** (`sample_kernel.rs` tests; 48 pass, 1 ignored bench):

- `full_vocab_dist_matches_sorted` (`:1328`):
  - Shapes: 24 LM-like rows (248k / 5000 / 1025 ids; bf16 ties; NaN / −inf / ±0) × {k 0, k n+5, top_p 0, top_p 1.5}.
  - Checks: id order; `w` bits per id equal to the rank-ordered form; `s` and every probability within f32 summation error of the exact sum. Worst |s − exact|/exact: id order 6.0e-4, rank order 1.1e-3.
  - Degenerate rows (all −inf, all NaN, 1/T = ∞ with ties) pick the same deterministic token.
- `top_p_prefix_matches_full_sort` (`:1385`): the result equals the full sort's `RowDist` bit for bit, on 357 prefix-path rows over 5 top_p values and 5 temperatures (flat rows included). A saturating row forces the fallback, as do degenerate rows (6 declines).
- `accept_chain_is_exact_at_one_position` (`:1441`): now also on an id-order full-vocab row. The empirical emitted distribution matches p within 5σ over 200k trials.
- `bench_row_dist` (`:1542`, `#[ignore]`): micro-bench against a verbatim copy of the pre-S1 `dist_vec` (`pre_s1_dist_vec`, `:1500`).

**Micro-bench** (median ms per 248,320-token row, 8 rows × 5, M5 Max; run inside the m3g gpu-lock hold at CPU load 13) [M]:

| request class | pre-S1 `dist_vec` (521c6e0) | S1 before the fix | **`8946bce`** | kept ids |
|---|---|---|---|---|
| T 0.7, no top-k, no top-p | 0.844 | 5.114 | **0.343** | 248,320 |
| T 0.6, no top-k, top-p 0.95 | 3.221 | 5.172 | **0.460** | 2.6 |
| T 0.7, no top-k, top-p 0.8 | 3.167 | 5.156 | **0.521** | 2.0 |
| T 0.6, top-k 40, top-p 0.95 (unchanged path) | 0.483 | 0.417 | 0.429 | 2.6 |
| T 0.6, top-k 20, top-p 0.95 (unchanged path) | 0.490 | 0.423 | 0.419 | 2.6 |
| token-rule round, no top-k / top-p (6.69 rows/round) | — | 41.51 (mean 36.20) | **3.00** (mean 2.89) | |

- Two earlier runs outside the lock at load ≈31 read 1.08–1.90 / 9.16–15.15 / 0.46–0.76 ms for the first row: the ratios hold, the absolute values scale with load.
- The finding estimated 15–25 ms/row and +50–100 ms/round. Measured, the pre-fix cost is 5–15 ms/row and ~36–66 ms per 6.7-row round.

**End to end** (m3g, fresh server per arm, 3 bench prompts × seeds 1, 3, 5, T 0.6; load 12–26, thermal 1–2) [M]:

| arm | binary | request | texts | ms/round | **rest** ms/round | tok/round |
|---|---|---|---|---|---|---|
| k40n / k40f | `8946bce` / `33d6398` | top_k 40, top_p 0.95 (CPU path, unchanged code) | **identical 9/9** | 74.50 / 71.07 | 4.95 / 2.52 | 3.705 / 3.705 |
| k0p95n / k0p95f | `8946bce` / `33d6398` | top_k 0, top_p 0.95 (prefix path) | **identical 9/9** | 70.27 / 81.85 | **2.80 / 24.01** | 3.705 / 3.705 |
| k0p1n, k0p1n2 / k0p1f | `8946bce` ×2 / `33d6398` | top_k 0, top_p 1.0 (id-order path) | n vs n2 identical 9/9 (deterministic); vs f 3/9 (stream change, by design: the 3 identical are the short prompt; the other 6 first diverge at re-tokenized #4–#63) | 58.94, 59.39 / 86.52 | **4.47, 2.88 / 33.00** | 4.293 / 3.742 |
| k0p1b | `8946bce` + `TH_SPEC_VERIFY=block` | top_k 0, top_p 1.0 | (block rule: other stream) | 64.28 | 11.86 | 3.664 |
| omitn / omitf | `8946bce` / `33d6398` + `TH_SAMPLE=check` | temperature only (server top-k 20 / top-p 0.8) | **identical 9/9** | 63.66 / 60.67 | 0.65 / 0.15 | 3.928 / 3.928 |

- **The fix removes 21–30 ms/round of host work** for no-top-k requests: `rest` 24.0 → 2.8 (prefix path, identical tokens) and 33.0 → 2.9–4.5 (id order).
- The remaining `rest` is of the same order as the base's pre-S1 sampled cost (PHASEC: 2.2 ms at load 2–5): the token rule still reads back the `[8, vocab]` rows for the CPU path.
- Whole-round differences on unchanged paths (k40, omit) are load noise at load 12–26 (±3 ms).
- The tokens/round gap between k0p1n and k0p1f is 9 requests of trajectory noise (different streams), not an effect.
- `TH_SPEC_VERIFY=block` on id-order full-vocab rows costs more (`rest` 11.9 ms). `block_resid` looks up q for all 248k kept ids on all 8 rows. Block is not the default on the CPU path (B1 auto = token rule there).

### 8.2 Finding 2 (high): the report was a stub (fixed)

§0–§7 above are written from the run artifacts:

- r0b / r0b2 / r0b3 (acceptance study), v1 (S1 gates + Splash acceptance arm), t1 (invalid, contention), m1 (B1 gates, stats, loaded timing palindrome, b1d identity, b3 acceptance).
- A binary sha table (§1) and per-arm load/thermal (§5).

It states that `33d6398`'s binary (`a023ca58`) ran only in the b1d arm. Its check-mode coverage transfers from `c81d9da` because the commit only selects the rule (§4).

### 8.3 Finding 3 (high): quiet re-measure. Attempted; the quiet condition was never reached; a moderate-load session was run instead

**Strict quiet attempt (m3t).**

- Protocol (`tools/run_m3t.sh` → `tools/m3t_session.sh`): hold the gpu-lock, then wait inside it (GPU idle) up to 900 s for load1 < 6 **and** thermal 0. Then run the ABBA base1 new1 new2 base2 on :8042 with a fresh server per arm. Per-arm gates: load1 < 6 (≤ 900 s), thermal 0 (≤ 420 s), CPU idle ≥ 85%, external GPU ≤ 60 ms/s.
- Suite per arm: p15 × seeds 1,3,5,7,9 sampled + t0 15 + ctx 1.45k × 3 + ctxs 1.45k × 3 prompts × seeds 1,3,5 + ctx ≈8k × 2.
- Timeline:
  - Queued 20:14.
  - Lock acquired 21:02:34, after 48 min behind th-d-longctx `holdS.sh` and th-d-prefix-cache `d5.sh`.
  - Thermal reached 0 within the hold, but load1 stayed at 8–21.
  - Released at 21:17:36 ("not quiet inside the lock (load1 10.67 thermal 0) - exit 3").
- **Machine log** (`runs/m3t.machine.log`, 124 one-minute samples, 20:03–21:55): load1 **never < 6**. The minimum was 7.97 (21:16, while this lane held the lock idle); load1 was < 8 once; the maximum was 96.5 (21:49).
- Load sources, none of them this lane's:
  - An unrelated **CPU-only ML server outside the lanes**: `addr/scripts/ml` `scripts.ml.server --port 18090`, pid 8947, up since ~16:09, running in bursts at ~4.6 cores plus 4 workers at 1–1.5 cores each. It was not touched.
  - The other lanes' builds and benchmark sessions, a VM (0.5–1.6 cores), Docker, Xcode builds, and from ~22:00 a self-hosted GitHub Actions runner job (golangci-lint at ~9.4 cores, go compile, node).
- The GPU itself was quiet between arms: external 27–37 ms/s at the gates, mostly WindowServer.
- The strict launcher stayed armed until it was stopped at the end of this round (§8.5). No quiet window appeared.

**Moderate-load fallback (m3m).**

- Setup (`tools/m3m_session.sh`, one gpu-lock hold 21:17:37–21:53:27): same ABBA and suite as m3t, fresh servers on :8042, default env (B1 auto).
  - Gates: thermal 0 before each arm; **no load gate**; load and thermal recorded per request.
  - Binaries: base `66e99644…` (521c6e0), new `cf8c2941…` (8946bce).
- **base2 is excluded:** a load spike to 56–106 hit just before it. Its thermal gate timed out at level 1 after 422 s, and external GPU during the arm was 87.8 ms/s (> 60). Its T=0 control read 73.26 ms/round against base1's 50.27 on identical code.
- The comparison is therefore **base1 vs new1 + new2**. It has no second base arm, so drift is bounded only by the T=0 control below.

| arm | load1 (mean) | thermal at request start | external GPU ms/s | t0 ms/round | sampled ms/round | sampled tok/round | sampled loop tok/s | sampled rest ms | ctx ms/round | ctxs ms/round | ctx8k ms/round |
|---|---|---|---|---|---|---|---|---|---|---|---|
| base1 | 10.7–27.0 (14.3) | 0 at arm start, then 2 (81/104 requests) | 51.0 | 50.27 | 61.67 | 4.140 | 67.14 | 4.67 | 70.49 | 76.48 | 120.36 |
| new1 | 14.0–23.8 (18.7) | 0 → 1–2 (78/104) | 28.7 | 48.86 | 57.26 | 4.260 | 74.39 | 0.97 | 73.08 | 72.14 | 121.30 |
| new2 | 11.2–17.8 (14.3) | 0 → 1–2 (83/104) | 39.6 | 53.27 | 52.94 | 4.260 | 80.47 | 0.68 | 69.66 | 71.59 | 121.70 |
| ~~base2~~ | 56.5–105.8 (86.5) | 2 (104/104) | 87.8 | 73.26 | 77.06 | 4.140 | 53.73 | 10.04 | 84.08 | 96.33 | 134.42 |

new (1 + 2) / base1, ratio of sums, prompt-cluster bootstrap (B = 5000) [M]:

| mode | ms/round | tokens/round | **loop tok/s** | texts |
|---|---|---|---|---|
| t0 (control: identical code path) | 1.016 [0.978, 1.050] | 1.000 | 0.984 [0.952, 1.023] | identical 15/15 |
| ctx 1.45k T=0 | 1.012 [1.008, 1.017] | 1.000 | 0.988 [0.984, 0.992] | identical 3/3 |
| ctx ≈8k T=0 | 1.009 [0.996, 1.043] | 1.000 | 0.991 [0.959, 1.004] | identical 2/2 |
| **sampled** (15 prompts × 5 seeds) | **0.893** [0.839, 0.934] (61.67 → 55.10) | 1.029 [0.985, 1.081] (4.140 → 4.260) | **1.152** [1.089, 1.225] (67.14 → 77.31) | streams differ (B1), 1/75 identical |
| ctxs 1.45k sampled (3 × 3) | 0.940 [0.928, 0.953] (76.48 → 71.87) | 0.912 [0.844, 0.981] | 0.971 [0.910, 1.030] | 1/9 identical |

- **TTFT** (median ms), base1 vs new1 / new2:
  - t0: 171 vs 176 / 181
  - sampled: 191 vs 196 / 183
  - ctx: 3535 vs 3532 / 3392
  - ctxs: 3539 vs 3683 / 3354
  - ctx8k: 30279 vs 30757 / 31334

  Prefill is unchanged code; the differences are within arm spread.
- **Identity [M]:**
  - T=0 (t0 + ctx + ctx8k) new vs base: **20/20** in each pair, so no first-divergence position.
  - Within each binary, arms are deterministic: base1 = base2 and new1 = new2, 104/104 each.
  - The default sampled class (top-k 20, GPU path, block rule) on `8946bce` equals `33d6398`'s b1d arm 45/45 (+ t0 15/15). The fix does not touch the default path.
- **Interpretation:**
  - The T=0 / ctx / ctx8k rows are unchanged code and read 1.009–1.016 ms/round, which bounds the arm-to-arm noise at ±3–5%.
  - The sampled round is 6.6 ms shorter (0.893×), outside that band. It matches the host saving: `rest` 4.67 → 0.68–0.97 ms (S1), plus smaller enqueue / propose. It also matches m1's byte-identical `rest` delta (§3).
  - Tokens/round 1.029 is B1 on this fixed suite (deterministic streams: base 4.140, new 4.260, the same values as r0b base1 and m1 chk).
  - Net sampled loop tok/s: **1.152×** [1.089, 1.225].
  - ctxs (9 requests, the same streams as m1's blk arms): realized tokens/round 0.912. Block verification cannot lower expected acceptance (§4: exact by enumeration; +0.9% on the same blocks), so this is trajectory variance over 9 requests. The Rao-Blackwellised check was run at short context only.
- **Standing: NOT updated.**
  - The conditions do not meet the standard: load1 10.7–27 vs PHASEC's 2–5, thermal 1–2 within arms, one base arm.
  - The standing stays at PHASEC's sampled 0.876× Splash (§6).
  - [E] projection only: if the m3m ratio held under quiet conditions, sampled would be ≈ 72.58 × 1.152 = 83.6 tok/s vs Splash's 82.89, i.e. ≈ 1.01× (0.95–1.07× from the ratio CI).
  - Confirming it needs a quiet same-session th/Splash run.
- **Reproduce:**
  - quiet: `bash $W/tools/run_m3t.sh <deadline-epoch>`
  - moderate: `$P/bin/gpu-lock -- bash $W/tools/m3m_session.sh $W/runs/m3m`
  - analysis: `TDIR=runs/m3m bash $W/tools/analyze_m3.sh t` (its pooled rows include base2; the base1-only numbers above come from `r0b_analyze.py` on base1 + new1 + new2).

### 8.4 Gates on `8946bce` (m3g, 19:44–20:00, load 12–26, thermal 1–2; not a timing session) [M]

- **Unit tests:** 48 passed, 0 failed, 1 ignored (`bench_row_dist`). This includes `gpu_accept_matches_cpu_reference` (160 trials × 2 rules, 0 mismatches) and the three new tests above.
- **`TH_TEST_ROLLBACK=1 TH_BATCH=2` probe:** rc 0, "rollback state-bitwise: PASS" (worst rollback |Δ| 0.125 at kept=1, refwd |Δ| 0, argmax 68/68/68).
- **`TH_BATCH=2 --draft`, `TH_SAMPLE=check`, default env (B1 auto → block for top-k 20):**
  - 13/13 HTTP 200, 0 errors, max trigram repeat 0.172.
  - **182 rounds, 0 mismatches.**
  - Mixed-batch identity holds (mix1-t0 = mix2-t0 = the solo t0; mix1-s5 = mix2-s5).
  - T=0 slots identical to integration-2's base 6/6.
- **Single-slot `TH_SAMPLE=check`, default env:**
  - Suite: 15 prompts × seeds 1, 3 sampled + T=0 15 + ctx 1.45k × 3 + ctx ≈8k × 2.
  - **867 rounds, 0 mismatches**; 0 panics / warnings / errors.
  - All 50 texts are identical to m1's chk arm (Z1 + `TH_SPEC_VERIFY=block`, same seeds).
- **T=0 identity vs base 521c6e0:**
  - t0 15 + ctx 3 + ctx8k 2: **20/20 identical** (chk vs m1 base1).
  - First-divergence positions: none, as no text differs.
- **Fixed request classes:** see the table in §8.1. The prefix path and the unchanged paths are text-identical to `33d6398` (9/9 each). The id-order path is deterministic (9/9 across two servers).
- No server logged a panic or ERROR, and all servers were stopped (port :8042 free afterwards).

### 8.5 State at the end of the review round (22:10)

- **Git:** `th/d-sampled` head `8946bce` (on `33d6398`). The worktree is clean. Not pushed; main and its working tree untouched.
- **Processes:** every server this lane started is stopped (:8042 free). No gpu-lock waiter of this lane remains, and the strict launcher and machine logger are stopped. :8000 and :8001 were never touched.
- **New artifacts** in `$W`:
  - `runs/m3g/` (gates + fixed-class arms);
  - `runs/m3m/` (moderate-load ABBA);
  - `runs/m3t.session.out` (strict attempt) and `runs/m3t.machine.log` (load/thermal/lock-holder samples);
  - `tools/{m3g,m3t,m3m}_session.sh`, `tools/run_m3t.sh`, `tools/sess3.sh` (sess2 + per-arm load gate), `tools/analyze_m3.sh`;
  - `tools/r0b_client.py` gained `--omit` and `--config-patch` (backward compatible);
  - binaries `bin/th-engine-R1-8946bce`, `bin/th-engine-tests-R1-8946bce`.
- **Still open:**
  1. **The quiet same-session timing** of `8946bce` vs base and Splash 1.0 (load1 < 6, thermal 0), including 1.45k and 8k arms. Command: `bash $W/tools/run_m3t.sh <deadline>`; add a Splash arm via `splash:splash1` in `sess3.sh`. This machine currently also hosts a self-hosted GitHub Actions runner (golangci-lint at ~9 cores during this round), an ML server (pid 8947) and a VM, so it has to be scheduled when those are idle.
  2. A long-context Rao-Blackwellised acceptance check (`TH_ACCEPT_STATS=1` on the ctxs suite), to close out the 9-request ctxs tokens/round reading (0.912) directly.
  3. Optional: `TH_SPEC_VERIFY=block` on CPU-path no-top-k rows costs 11.9 ms/round of `rest` (a q lookup per kept id). It is not a default path. If the forced rule matters there, a per-row q map would cut it.
