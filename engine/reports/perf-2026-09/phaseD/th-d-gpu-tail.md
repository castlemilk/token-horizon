# th/d-gpu-tail: R0c per-command-buffer GPU profiler + short-context GPU-tail kernels (PHASEC §6.2 lever 3)

- Branch `th/d-gpu-tail` @`cafc6ae`, 15 commits on main `521c6e0`. Worktree `/Users/benebsworth/projects/token-horizon/.worktrees/th/d-gpu-tail`.
- Work dir `$W` = `/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC/work/th-d-gpu-tail` (`bench/`, `bin/`, `runs/`).
- The lane agent left no report file. §0–§4 are rebuilt from its commits and run artifacts (`runs/s1`…`runs/s9`). "Review fixes" at the end is the fix for the review finding (load-inflated perf claims).
- Tags: [M] measured, [D] derived.

## 0. Summary

- **Code:** unchanged by the review (the finding is about measurement). Head stays `cafc6ae`, so the release binary measured below is the branch head.
- **The s9 speedup is withdrawn.** s9 measured ×1.301 T=0 loop tok/s (−15.84 ms/round) at 1-min load 14–48 and thermal pressure 1–2. That figure must not be quoted or used for standing.
- **Quiet re-measure** ("Review fixes" §R3). One gpu-lock hold; hard gate of thermal 0 + load1 < 5 before every arm; contaminated arms redone; fresh server per arm; ABBA against base `66e99644`:
  - T=0: **47.46 → 39.75 ms/round (−7.71 ms, ×1.194 loop tok/s)**
  - sampled: 50.71 → 43.19 (×1.174)
  - ctx1500: 61.92 → 54.14 (×1.144)
  - ctxcold: 62.20 → 53.71 (×1.158)
  - ctx8k: 108.35 → 97.77 (×1.108)
  - tokens/round are unchanged. Base reproduces PHASEC's quiet standing within 0.6–2.5 %.
  - The real saving is about half the s9 figure. It is ≈7 ms/round of verify-forward GPU work.
- **vs Splash 1.0, same hold:** T=0 **1.23×**, sampled **1.04×**, ctx1500 0.91×, ctxcold 0.90×. main's standing was 1.03 / 0.88 / 0.78 / 0.79.
- **Correctness:** every item is bit-identical by construction and by unit test. T=0 streams are identical to base in every session, quiet and loaded (§3, §R4).
- **New observation:** long-prompt TTFT is +2.9 % at 1.43k and +1.7 % at 7.9k on new; the leading suspect is the prefill KV-capacity path `413d8ef`/`e3a4463` (§R3.P). Short-prompt TTFT is −9 %.

## 1. Build

| binary | path | sha256 | provenance |
|---|---|---|---|
| new | `$W/bin/th-engine-n8-cafc6ae` | `a4ad94daad5433d2…` | `cargo build --release` at `cafc6ae` is a no-op, and `engine/target/release/th-engine` has the same sha (re-checked 19:37) |
| tests | `$W/bin/th-engine-tests-cafc6ae` | `f14c6444133752fb…` | byte-identical to `cargo test --release --no-run` at `cafc6ae` (`target/release/deps/th_engine-eb21235a5658b0cb`, re-built 19:38) |
| base | `$W/bin/th-engine-base-521c6e0` | `66e99644402995638d…` | main `521c6e0`, same as `.worktrees/report/integration-2/engine/target/release/th-engine` |

Files touched: `engine/src/gpuprof.rs` (new), `gdn_kernel.rs`, `quant_kernel.rs`, `qwen35.rs`, `dflash.rs`, `main.rs`, `Cargo.toml`/`Cargo.lock` (objc2/block2 become direct deps; both were already in the graph). 8 files, +2948/−203.

## 2. Commits (`git log --reverse main..th/d-gpu-tail`)

Every "old path" switch is read once.

| sha | item | what | old path |
|---|---|---|---|
| `6339308` | R0c | `gpuprof.rs`: armed only by `TH_GPU_PROF` (read once, before candle creates its device). Swizzles MTLCommandBuffer/encoder/dispatch to tag each dispatch with (phase, region, kernel). Prints exclusive GPU ms/round every `TH_GPU_PROF_EVERY` rounds. With `CANDLE_METAL_COMPUTE_PER_BUFFER=1` each dispatch is its own CB (≈5 µs per CB overhead). Region markers are relaxed-load no-ops when disarmed. | unset = off |
| `beb4cc0` | G1a follow-up | `gdn_commit_all`: one dispatch for every GDN layer's rollback commit (grid HV × layers). Replaces ≈38 per-layer dispatches. | `TH_GDN_COMMIT_ALL=0`; `TH_GDN_COMMIT=step` bypasses both |
| `a01aaec` | add+RMSNorm | `add_rmsnorm_p` / `add_rmsnorm_sums_p`: one threadgroup per row, replacing one 256-thread threadgroup for all rows. Same per-lane reduction order, so bit-identical. | `TH_ARN_LEGACY=1` |
| `276008c` | GDN step | `gdn_fused_step_w`: 32 simdgroups per value head, replacing 8. Same kernel text, only the strides change. Pipeline cache keyed by shape. | `TH_GDN_WSG=8` (original kernel) |
| `9e2296a` | draft select | `ChunkTop16`: exact per-512-column top-16 in one dispatch, using candle's identical bitonic network. Replaces the full-row argsort + gather + cast. | `TH_CAND_SORT=legacy` |
| `413d8ef` | prefill KV | prefill stores K/V in a capacity buffer, so the first verify skips 32 strided re-copies | `TH_KV_CAP_PREFILL=0` |
| `caf7f9d` | draft commit | `draft_ring_write`: one ring-write dispatch per layer; K/V are head views (no copies) | `TH_DRAFT_RING=legacy` |
| `a25d799` | draft select | ChunkTop16: 35 of the 45 network stages use `simd_shuffle_xor` instead of threadgroup memory + barriers | — |
| `7260520` | K45 follow-up | presum producers (`draft_rmsnorm_ps`, `draft_conv_ps`) for the draft's m ≤ 8 projections | `TH_DRAFT_PS=0` |
| `be05f50` | draft propose | q/k passed as head views of the qkv rows; drops 10 reshape copies per round | — |
| `e3a4463` | fix `413d8ef` | zero-fills the capacity buffers. The DFlash anchor off-by-one (`th/c-loop-anchor` `68f3423`, not merged) makes every verify read the never-written row `n_prompt`; uninitialised memory there collapsed `--draft` streams. | — |
| `f7a2e43` | test | the presum test now covers the paired lm_head-class tile | — |
| `91d04f4` | docs | doc comments and attributes only | — |
| `63ea5be` | GDN RIF | rows-in-flight GDN kernel (bit-identical on the tiny test shape) | — |
| `cafc6ae` | drop RIF | removes the RIF kernel. It had no in-situ win (fwd8 0.65 ms slower than Wide32, s7), and at 27B it changed DFlash proposals in 4/6 greedy requests. Default is Wide32 again. | — |

## 3. Correctness

These are the lane's own results (s9, 18:53–19:06). Every one was re-run twice during the review, in g1 and in q2's section G (§R4), with the same outcome.

- **Unit tests:** 43/43 pass. They include the bitwise gates: `add_rmsnorm_per_row_matches_legacy_bitwise`, `gdn_widths_match_original_bitwise`, `gdn_parity_rollback_state_bitwise_over_chained_rounds`, `cand_packed_fused_matches_sort_bitwise`, `ring_write_matches_scatter_bitwise`, `draft_presum_producers_match_plain_bitwise`. Each fails under a one-ulp mutation (per the commit messages).
- **R0a:** `TH_TEST_ROLLBACK=1 TH_BATCH=2` probe exits 0 (kept 1..8 `rec≠ref 0`; state-bitwise PASS; rollback PASS).
  - The `TH_GDN_COMMIT=step` variant exits **1, by design**. It is the pre-G1a negative control and fails with the counts `th-c-gdn-parity.md` documents for that arm.
- **TH_BATCH=2 --draft smoke:** 13/13 HTTP 200, no panic/error/WARN lines.
- **T=0 identity vs base:** greedy 36/36, ctx1500 36/36, ctxcold 12/12 (emitted id streams and text sha). Sampled seeds 1/3/5: 36/36 identical.

## 4. Lane timing, s1–s9: LOADED, superseded — do not quote

- **s9** (final A/B of `cafc6ae`, 18:54–19:03, one gpu-lock hold, fresh server per arm on :8044, ABBA base/new/new/base):
  - 1-min load 13.9–48.2 at request start (all 120 requests ≥ 5).
  - Thermal pressure level 1–2 on every request.
  - Base ran **68.48 ms/round T=0** against its quiet standing of **47.16** (PHASEC §1.1), i.e. +45%.
  - Every phase was inflated: propose 10.99 vs 6.2, host encode 4.81 vs 2.1, GPU tail + readback 51.49 vs 38.4, rest 1.30 vs 0.1 ms.
- The s9 result (new 52.64 ms/round, ×1.301 T=0, ×1.244 sampled, ×1.234 ctx1500, ×1.206 ctxcold; tokens/round unchanged) is internally consistent ABBA. It is still not transferable:
  - Latency-bound kernels (the old add+RMSNorm walks 160 dependent loads per lane; the old GDN step runs 16 serial rows per simdgroup) lose more at throttled clocks than the kernels that replaced them.
  - Applied to the quiet base, −15.84 ms/round would give ≈31.3 ms/round, which is below the ≈36 ms kernel floor F_k [D].
- **Per-item R0c numbers:**
  - Examples: "add+RMSNorm 127 calls × ≈83 µs = 10.5 ms/round", "verify norms 10.66 → 1.96 ms/round", "GDN step ≈38 µs/layer", "sort 656 µs/round".
  - All were taken with `CANDLE_METAL_COMPUTE_PER_BUFFER=1` (≈+5 µs per CB), in the same loaded sessions. The s9 profiling arm ran +9.3 ms/round slower than plain new in the same session.
  - They rank kernels. They are **not** in-situ savings. The code comments that quote them describe the old kernels' profiler-mode cost.
- **s1–s8** ran at load 13–34 and thermal 1–2 as well (commit `cafc6ae` states s7's conditions). Their A/B numbers are superseded in the same way.

## Review fixes

### R1. Finding (high, must-fix)

"Perf claims are load-inflated: every s9 arm ran at 1-min load 17–40 (thermal level 2 on ctx8k); re-measure on a quiet machine before landing or quoting."

The required fix:
- One gpu-lock hold, with load < 5 and thermal 0 gated per arm.
- A fresh server per arm on a private port.
- ABBA base (66e99644) / new (a4ad94da) / new / base for greedy, sampled 1/3/5, ctx1500 and ctxcold, plus Splash on a free :8000 if the comparison is wanted.
- Report ratio-of-sums loop tok/s, ms/round, tok/round, TTFT and load, and re-confirm T=0 identity.
- Do not propagate 1.30×.

### R2. What changed

- **Report:** the s9 ×1.301 / −15.84 ms/round and the per-item R0c "savings" are withdrawn (§4). The only perf numbers this report stands behind are the quiet ones in §R3.
- **Code:** none. No review-fix commit was made:
  - The finding concerns measurement only.
  - Any source edit would shift panic-location line numbers, so the binary would no longer be the one measured.
  - The branch stays at `cafc6ae`.
- **Harness (work dir, not the repo):**
  - `$W/bench/q.sh`: quiet session. Hard per-arm gate, then timing blocks with redo on mid-arm contamination, then in-process forward bench, then correctness gates. Details in §R5b.
  - `$W/bench/gpu-lock-quiet`: same flock as `$P/bin/gpu-lock`, but only tried while the 1-min load has stayed < 6 for 60 s, so the lock is never held idle behind the gate on a noisy machine.
  - `$W/bench/qrun.sh`: retry driver.
  - `$W/bench/q_report.sh`: analysis (ab.py + q_analyze.py + conditions/gates/multi tables).
  - `$W/bench/q_analyze.py`: the integration-2 `analyze.py` with engine names th-new/th-base and ctx8k added.

### R3. Quiet re-measure (session q1, 2026-09-27 01:06–02:52, one gpu-lock hold)

**How the session ran**
- The machine never reached load1 < 6 from 19:31 to 00:45: load1 7–93, from other projects' builds/lints and a CPU-heavy local ML server.
- q1 took the lock at 01:06:36 (load1 4.86).
- An earlier attempt (`runs/q1-aborted`, 00:46–00:59) aborted on the hard gate before its second arm and was discarded whole.
- **Hard gate before every arm:** thermal pressure level 0 **and** load1 < 5.0, both held for 30 s. It passed at load1 4.11–4.97, thermal 0, after waits of 141–1140 s (`runs/q1/gate.jsonl`).
- **Redo check after every arm:** the gate only holds at arm start, so an arm is redone when > 10 % of its requests start at load1 ≥ 8, or any at ≥ 12, or > 10 % at thermal ≥ 2, or any request errors.
  - Three attempts were redone: base_4 #1 (load1 up to 14.23), new_7 #1 (up to 9.28), base_9 #1 (8.61).
  - Only the clean attempt of each arm is in `runs.jsonl`. The dirty attempts stay in `attempts/`.
  - The redo rule is conservative: dirty base_4 #1 measured 47.53 ms/round greedy against 47.33 / 47.59 for the clean base arms.
- **Conditions in the kept arms:**
  - Request-start load1 medians 4.33–5.31, max 8.59. This includes our own server and client.
  - Thermal level 0 on 230 of 240 requests, 1 on 10, never 2. Splash arms were always at 0.
  - Compare s9: load1 13.9–48.2 on every request, thermal 1–2.
- **Setup per arm:** fresh server on :8044 (th) or the free :8000 (Splash), bq_client suite (2 warm-ups; greedy 3×3 T=0; sampled seeds 1/3/5 at T 0.6 / top_p 0.95 / top_k 20; ctx1500 3×3; ctxcold 3). max_tokens 128. Binaries per §1 (base `66e99644…`, new `a4ad94da…`).
- **Block C** (ctx8k ABBA base_9 new_10 new_11 base_12) was stopped at 03:22 after base_9 #1 was redone. No clean ctx8k arm was recorded, so there is no quiet 8k number. See §R6.

**Block A — base / new / new / base (the requested ABBA).** Ratio of sums over logged `[dflash]` rounds (`runs/q1/analysis/ab_A.md`, `headline_A.md`):

| mode | n req / rounds per engine | tok/round (both) | base ms/round (per arm) | **new ms/round** (per arm) | Δ ms/round | base → **new loop tok/s** | **new / base** | TTFT mean base → new |
|---|---|---|---|---|---|---|---|---|
| greedy T=0 | 18 / 420 | 3.843 | 47.46 (47.33 / 47.59) | **39.75** (39.77 / 39.73) | **−7.71 (−16.2 %)** | 80.98 → **96.68** | **×1.194** | 162 → 148 ms |
| sampled 1/3/5 | 18 / 458 | 3.590 | 50.71 (50.78 / 50.64) | **43.19** (43.50 / 42.88) | −7.52 (−14.8 %) | 70.79 → **83.11** | **×1.174** | 165 → 154 ms |
| ctx1500 (1432–1454 tok) | 18 / 438 | 3.822 | 61.92 (61.98 / 61.85) | **54.14** (54.12 / 54.16) | −7.78 (−12.6 %) | 61.73 → **70.60** | **×1.144** | 2559 → **2632 ms (+2.9 %)** |
| ctxcold (1437–1459 tok) | 6 / 124 | 4.371 | 62.20 (61.89 / 62.51) | **53.71** (53.55 / 53.87) | −8.49 (−13.7 %) | 70.27 → **81.38** | **×1.158** | 2476 → 2516 ms |

- **Base reproduces the quiet standing** (PHASEC §1.1: 47.16 / 49.46 / 61.44 / 61.69 ms/round) within +0.6 / +2.5 / +0.8 / +0.8 %. So these are quiet numbers, and the s9 base (68.48) was 45 % inflated.
- **Where the gain is.** Greedy phases per round, base → new:
  - propose 6.35 → 6.05, host encode 2.18 → 2.07, **verify GPU tail + readback 38.48 → 31.36**, rest 0.14 → 0.00 ms.
  - GPU-busy slope 46.2 → 39.2 ms/round; idle 1.4 / 1.4 [M, ioreg slope].
  - So ≈7.1 of the 7.7 ms is verify-forward GPU work (add+RMSNorm, GDN step, commit_all). The draft-side items together are worth ≈0.3 ms/round.
  - At ctx1500 the same split holds: GPU tail 47.07 → 40.01, propose 12.05 → 11.81.
- **Against the withdrawn claim:** quiet −7.71 ms/round and ×1.194, against s9's −15.84 ms/round and ×1.301. The loaded session overstated the saving by about 2×. New at 39.75 ms/round is ≈3.8 ms above F_k ≈ 36, not below it.
- **T=0 identity vs base** (emitted id streams + text sha; ab.py): greedy **36/36**, ctx1500 **36/36**, ctxcold **12/12** identical. Sampled seeds 1/3/5: 36/36 identical. Base is deterministic across its arms (9/9, 9/9, 9/9, 3/3 groups). There is no first divergence.
- **TTFT (new observation, not in the lane's claims):**
  - Short prompts (58 tokens) are faster on new: mean 162 → 148 ms.
  - The 1.43k-token prefill is **slower**: ctx1500 mean 2559 / 2558 ms (base arms) against 2623 / 2641 ms (new arms), i.e. +64 to +83 ms, consistent across the ABBA.
  - ctxcold is noisier: 2554 / 2397 vs 2531 / 2500.
  - Attribution is in §R3.P.

**Block B — Splash 1.0 palindrome** (splash_5, new_6, new_7, splash_8; same gates and client; `analysis/headline_B.md`, `all_B.md`):

| mode | engine | tok/round | ms/round (per arm) | **loop tok/s** | like-for-like | TTFT mean / med ms |
|---|---|---|---|---|---|---|
| T=0 | th-new `cafc6ae` | 3.843 | 40.26 (40.18 / 40.33) | **95.45** | 96.30 | 149 / 156 |
| T=0 | Splash 1.0 | 3.763 | 48.51 (48.47 / 48.56) | **77.57** | 76.76 | 155 / 140 |
| sampled | th-new | 3.590 | 42.26 (42.29 / 42.23) | **84.94** | 84.51 | 152 / 160 |
| sampled | Splash | 4.014 | 49.33 (49.03 / 49.63) | **81.37** | 80.51 | 136 / 137 |
| ctx1500 | th-new | 3.822 | 53.81 (53.82 / 53.80) | **71.03** | 69.45 | 2615 / 2615 |
| ctx1500 | Splash | 3.878 | 49.63 (48.87 / 50.38) | **78.15** | 77.34 | 157 / 141 (prefix cache) |
| ctxcold | th-new | 4.371 | 53.73 (53.89 / 53.57) | **81.35** | 81.32 | 2479 / 2445 |
| ctxcold | Splash | 4.415 | 49.07 (48.84 / 49.30) | **89.97** | 89.03 | 1873 / 1874 |

| mode | **th-new / Splash** loop (like-for-like) = per-round × tok/round | main `521c6e0` / Splash (PHASEC §1.1, for reference) |
|---|---|---|
| T=0 | **1.231** (1.255) = 1.205 × 1.021 | 1.032 |
| sampled | **1.044** (1.050) = 1.167 × 0.894 | 0.876 |
| ctx1500 | **0.909** (0.898) = 0.922 × 0.985 | 0.782 |
| ctxcold | **0.904** (0.913) = 0.913 × 0.990 | 0.793 |

- Splash in q1 ran 48.51 ms/round T=0, 1.8 % slower than PHASEC s1's 47.66. So the Splash ratios are about 2 % more favourable to th than a PHASEC-conditions Splash would give.
- The main/Splash column comes from a different session (PHASEC s1). Treat it as context, not a same-session ratio.
- **Identity new vs Splash** (T=0, after `</think>` normalisation): byte-identical on 7 of 9 groups.
  - greedy/code diverges at char 105 (" Need produce" / " Need provide": the known integration near-tie PHASEC §1.1 reports).
  - ctxcold/code diverges at char 532.
  - This is the same pattern PHASEC reports for main vs Splash, as expected, since new's ids equal base's.
- **Proposed standing (for the orchestrator to carry into PHASEC §1/§6; I did not edit the PHASEC report):** th/d-gpu-tail `cafc6ae` vs Splash 1.0, quiet, same session:
  - **T=0 1.23×, sampled 1.04×, ctx1500 0.91×, ctxcold 0.90×.**
  - Round 40.3 vs 48.5 ms. The gap to F_k ≈ 36 is ≈4 ms/round.
  - Long context is still th's loss. At ≈1.45k context the round grows +13.6 ms (40.26 → 53.81) against Splash's +1.1. The N3/N4 split-K attention work (PHASEC §6.2 lever 1) is untouched by this lane.

**Block C — ctx8k ABBA** (session q3, 04:11–04:46, one gpu-lock hold, same hard gate; 3-request arms are redone when more than 1 of 3 requests start at load1 ≥ 8; base_9 new_10 new_11 base_12):
- **Gates:** passed at load1 4.08–4.25, thermal 0, after 121–618 s waits. Request-start load1 4.3–8.8. Thermal 0 at every request start, 1 at the end of each arm's longest prompt.

| mode | n req / rounds per engine | tok/round | base ms/round (per arm) | **new ms/round** (per arm) | Δ | base → **new loop tok/s** | **new / base** | TTFT mean base → new |
|---|---|---|---|---|---|---|---|---|
| ctx8k (7912–7934 tok) | 6 / 162 | 3.444 | 108.35 (108.34 / 108.36) | **97.77** (97.87 / 97.68) | **−10.57 (−9.8 %)** | 31.79 → **35.23** | **×1.108** | 20365 → 20709 ms (+1.7 %) |

- **Phases, base → new:** propose 16.50 → 15.76, host encode 3.14 → 2.12, GPU tail + readback 88.25 → 79.57, rest 0.23 → 0.07 ms.
- **T=0 identity:** **12/12** identical (emitted ids + text sha). Base is deterministic across arms (3/3).
- **Against the loaded numbers:** s7's k8 run had base 126.85 / new 108.09, and s9's new_8k 115.51 (load1 39, thermal 2). Both were inflated.

### R3.P Long-prompt TTFT (new observation; attribution incomplete)

- **Observation (server TTFT; ABBA-consistent; not in the lane's claims):**
  - new's long-prompt TTFT is **slower**: ctx1500 +2.9 % (2559 → 2632 ms mean; per arm 2559 / 2558 vs 2623 / 2641) and ctx8k +1.7 % (20365 → 20709 ms; per arm 20461 / 20269 vs 20767 / 20651).
  - Short-prompt TTFT is **faster** (58 tokens: 162 → 148 ms).
  - The long-prompt delta is roughly proportional to prompt length (≈45–50 µs per prompt token).
- **In-process probe** (`TH_BENCH_PREFILL=64,512,1437`: target forward only, fresh state, 1 warm-up + 6 runs per routing; the "tiles" column is the default routing).
  - Hard-gated per probe: thermal 0 + load1 < 5 held 20 s.
  - Mirror order: base new kv0 arn arn kv0 new base, where kv0 = new with `TH_KV_CAP_PREFILL=0` (413d8ef/e3a4463 off) and arn = new with `TH_ARN_LEGACY=1`.
  - q2 got 3 probes before a gate timed out. q3 got 6 before its deadline.

| session / probe | m=64 med (min) ms | m=512 med (min) | m=1437 med (min) |
|---|---|---|---|
| q2 base_1 | 116.2 (115.8) | 795.4 (690.6) | 2520.1 (2458.9) |
| q2 new_2 | 108.7 (107.4) | 811.0 (695.9) | 2603.6 (2450.3) |
| q2 kv0_3 | 107.6 (106.9) | 777.6 (686.6) | 2556.6 (2447.0) |
| q3 base_1 | 117.9 (116.1) | 796.6 (691.5) | 2590.9 (2503.5) |
| q3 new_2 | 108.6 (107.7) | 778.4 (691.1) | 2587.8 (2517.7) |
| q3 kv0_3 | 107.8 (107.2) | 767.0 (685.9) | 2541.7 (2420.4) |
| q3 arn_4 | 116.5 (116.1) | 801.7 (697.7) | 2589.3 (2475.6) |
| q3 arn_5 | 117.2 (116.1) | 795.0 (697.3) | 2545.6 (2425.5) |
| q3 kv0_6 | 107.2 (106.8) | 751.7 (685.5) | 2463.6 (2320.4) |

- **Reading [M, small n]:**
  - **64 tokens:** new is 8–9 ms faster than base. That comes from the add+RMSNorm per-row kernel: `TH_ARN_LEGACY=1` puts it back to base's 116–117 ms in both arn probes, while kv0 stays at new's 107–108.
  - **1437 tokens:** run-to-run spread (±50–100 ms) is as large as the effect. new − base is +83 ms (q2) and −3 ms (q3), so the probe cannot confirm the server delta.
  - **The one consistent signal:** every kv0 probe (3/3) is faster than the new probe in its own session, by 47, 46 and 124 ms (medians).
  - **Conclusion:** the prefill KV-capacity path (`413d8ef` + `e3a4463`) is the leading suspect. At every attention layer it allocates and zero-fills two `[kv_heads, max(2·need, 2048), head_dim]` buffers (blit fills) and adds a `.contiguous()` + `slice_set` copy of K and V. Its intended saving was ≈11 ms in the first decode round.
  - The probe covers only the target forward. The draft prefill (`draft_prefill` → `commit`, ≤ 2047 rows, rewritten by `caf7f9d`/`be05f50`) is not in it.
- **Not resolved.** The confirming step is server TTFT arms (ctx1500 × 9 each) for new vs new `TH_KV_CAP_PREFILL=0` (and `TH_DRAFT_RING=legacy`) in one quiet hold. That is ≈25 min of quiet GPU time.
- **Size, for the landing decision:** at ctx1500 a 128-token reply saves ≈7.8 ms × ≈34 rounds ≈ 265 ms of decode and costs ≈73 ms of TTFT. So end-to-end is still a net win. A TTFT regression should still be fixed or explicitly accepted. The likely fix: drop the capacity path, or keep it without the zero fill once the anchor off-by-one fix `68f3423` lands.

### R3.D In-process forward bench (per-item check)

- Only the first probe of the mirror ran before the gate timeout (q2): base `TH_BENCH_MULTI=8,1` fwd8 median **39.15 ms** (min 39.00), fwd1 37.50.
- The new/arn/wsg8 probes did not pass their gates, so there is **no quiet per-item split**.
- The e2e phase split in Block A is the in-situ attribution this report stands behind: ≈7.1 of 7.7 ms/round is in the verify-forward GPU tail. That tail holds add+RMSNorm, the GDN step and the commit_all dispatch. The draft-side items are worth ≈0.3 ms/round.
- The loaded s9 in-process numbers (base fwd8 42.5 / 39.35, new 32.95 / 32.10) are superseded like everything else from s9.

### R4. Gates re-run

**g1** (`$W/runs/g1`, `bench/gates_only.sh`, 22:09–22:18, one gpu-lock hold; correctness only):
- The GPU lock happened to be free, but the machine was not quiet: load1 28–72, thermal 1–2.
- Same binaries as §1: base `66e99644…`, new `a4ad94da…`, tests `f14c6444…`.

| gate | result |
|---|---|
| build | `cargo build --release` at `cafc6ae`: no-op, `target/release/th-engine` = `a4ad94da…` (the measured binary). `cargo test --release --no-run` rebuilt the test binary byte-identical to `$W/bin/th-engine-tests-cafc6ae` (`f14c6444…`, `cmp`: 0 bytes differ). |
| unit tests | **43 / 43 pass** (3.65 s) |
| R0a `TH_TEST_ROLLBACK=1 TH_BATCH=2` | **rc=0**. State-bitwise PASS: kept 1..8 `rec≠ref 0/37748736`, `conv≠ref 0`, `layers≠ 0/48`; slot isolation true/true. Logits check: worst \|Δ\| 0.1250 at kept=1 (the m=1 path), 0.0000 at kept 4/7/8; argmax 68/68/68. |
| R0a with `TH_GDN_COMMIT=step` (negative control) | **rc=1, as designed.** This env restores the pre-G1a re-scan commit. It fails with the same counts th/c-gdn-parity documents for that arm (`th-c-gdn-parity.md` R0a table): 1,325,021 / 2,383,003 / 3,272,650 / 4,112,239 / 4,958,000 / 5,694,885 / 6,272,759 differing elements at kept 1..7 (max 1.9–3.8e-6), 0 at kept 8. So the gate still discriminates. The s9 run of this arm also exited 1 with identical counts. |
| TH_BATCH=2 `--draft` smoke | **13 / 13 HTTP 200**, max trigram-repeat 0.098, finishes {length, stop}, 0 panic/error/WARN lines in the server log |
| T=0 identity new vs base (emitted id streams + text sha, fresh server per arm) | greedy **9/9**, ctx1500 **9/9**, ctxcold **3/3**, ctx8k **3/3** identical. Sampled seeds 1/3/5: 9/9 identical. Base is deterministic across arms. |

The loaded g1 timings are one more reason not to trust loaded A/Bs. Take greedy new/base 53.21 vs 60.05 ms/round: here sampled new was *slower* than base (59.95 vs 57.31), while s9 had new ×1.244 faster. Under load, arm-to-arm noise is larger than the effect.

**q2 section G** (04:00–04:02, same binaries, after the q2 probes, in the same hold):
- unit tests **43/43**
- R0a **rc=0** (state-bitwise PASS; kept 1..8 `rec≠ref 0`)
- `TH_GDN_COMMIT=step` negative control rc=1 with the same documented counts
- TH_BATCH=2 `--draft` smoke **13/13 HTTP 200**, 0 panic/error/WARN lines

**T=0 identity in the quiet sessions (§R3):**
- new vs base: greedy 36/36, ctx1500 36/36, ctxcold 12/12, ctx8k 12/12, sampled 36/36 identical.
- new vs Splash: 7/9 groups byte-identical, the same pattern as main.

### R5. Reproduce

```bash
W=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC/work/th-d-gpu-tail
# full quiet session (blocks A B C D G): waits for load1 < 6 for 60 s before trying the lock; each arm is then
# hard-gated on thermal 0 + load1 < 5 held 30 s and redone on mid-arm contamination; retries on a block-A gate abort
bash $W/bench/qrun.sh
# follow-ups: ctx8k ABBA + prefill mirror + multi mirror under a deadline / correctness-only hold
$W/bench/gpu-lock-quiet --timeout 3600 --load 6.0 --hold 45 -- bash $W/bench/q3.sh $W/runs/q3
/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC/bin/gpu-lock -- bash $W/bench/gates_only.sh $W/runs/g1
# analysis
bash $W/bench/q_report.sh $W/runs/q1          # -> runs/q1/analysis/{ab_A,headline_A,headline_B,all_A,all_B,conds,gates}.md
python3 $W/bench/ab.py $W/runs/q3/c           # ctx8k ABBA + identity
```

### R5b. Harness notes (work dir, not committed)

- `bench/q.sh`: blocks A (ABBA) / B (Splash palindrome) / C (ctx8k) / D (multi) / G (gates), selected with `Q_BLOCKS`.
  - Hard gate per arm.
  - Redo on mid-arm contamination; attempts are kept under `attempts/`, and only clean attempts go into `runs.jsonl`.
  - Optional `Q_DEADLINE` bounds every gate.
- `bench/gpu-lock-quiet`: same flock as `$P/bin/gpu-lock`. It only tries the lock while load1 < L for H s.
- `bench/qrun.sh`: retries `q.sh` on a gate abort.
- `bench/q2.sh`, `bench/q3.sh`: follow-up holds. `bench/pf.sh`: prefill mirror. `bench/gates_only.sh`: correctness-only hold.
- `bench/q_report.sh` + `q_headline.py` + `q_analyze.py`: analysis. `q_analyze.py` is integration-2's `analyze.py` with th-base/th-new names and ctx8k added.
- Runs:
  - `runs/q1` (A + B; C stopped), `runs/q1-aborted` (discarded)
  - `runs/q2` (pf ×3, multi ×1, G), `runs/q3/{c,pf,d}` (C complete, pf ×6, D none)
  - `runs/g1` (loaded correctness hold)
- Analysis files: `runs/q1/analysis/{ab_A,headline_A,headline_B,all_A,all_B,conds,gates}.md`, `runs/q3/c/` (ab.py).

### R6. Not done / limits

- **No quiet per-item split** (in-process `TH_BENCH_MULTI` mirror): 1 of 8 probes passed its gate. The e2e phase split (§R3 Block A) is the in-situ attribution.
- **TTFT regression at long prompts** (+2.9 % at 1.43k, +1.7 % at 7.9k): observed and ABBA-consistent, with a leading suspect (§R3.P), but not confirmed with server arms.
- **Conditions:** "quiet" here means an arm-start gate of load1 < 5 with thermal 0, plus the redo rule.
  - Request-start load1 during kept arms reached 8.6 (block A/B) and 8.8 (block C). That includes our own server and client, which add ≈1–2.
  - PHASEC s1's request-start load1 was 1.9–5.1.
  - The contaminated-then-redone base_4 attempt (load1 up to 14.2) measured within 0.4 % of the clean base arms, so this residual load does not move the numbers at the reported precision.
- **Splash:** only the q1 block B session. Its T=0 round (48.51 ms) is 1.8 % slower than PHASEC s1's (47.66). A PHASEC-conditions Splash would put new/Splash at ≈1.21× rather than 1.23×.
- **No code change and no commit** (see §R2). The branch head stays `cafc6ae`, and the measured binary is its release build.
- The PHASEC report itself is not edited. The proposed standing values are in §R3 Block B for the orchestrator.

