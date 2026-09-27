# th/c-ports: K7, N2, MEM-2 and MEM-4 ported onto report/integration-sim

Written 2026-09-26, 05:40–07:50 AEST.

- **Branch:** `th/c-ports`, 4 commits on `report/integration-sim` @`8d5b6d5`. Not pushed.
- **Worktree:** `/Users/benebsworth/projects/token-horizon/.worktrees/th/c-ports`, created with `wt-bootstrap th/c-ports`.
- **Probe-only side branch:** `th/c-ports-mem2bench` @`af0e850` (worktree `.worktrees/th/c-ports-mem2bench`). It adds the MEM-2 interleaved microbench (§4.3) on top of the branch head. **Do not merge it.**
- **Hardware and model:** M5 Max (40-core GPU, 128 GB), macOS 26.5.1. Qwen3.8-27B-4bit (`$TGT`) + DFlash draft (`$DRAFT`).
- **Private port:** :8033.
- **Work dir** `W=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC/work/th-c-ports`:
  - `bin/`: frozen binaries and scripts;
  - `logs/s1`, `logs/s2`, `logs/s3`: raw server logs and JSONL;
  - `logs/s*_parse.md`: tables.

**Binaries** (cp of each commit's `cargo build --release`; sha256 first 16 hex):

| label | commit | sha256 |
|---|---|---|
| base | `8d5b6d5` (report-integration-sim build) | `e91a30d2afb70b2b` (same as the phase-B integ binary) |
| c1 K7 | `6da668d` | `3ae141d10d4ef2cf` |
| c2 N2 | `8ed2ac1` | `3d6e6ce51f45044c` |
| c3 MEM-2 | `8b431f3` | `8ccd786ab505fb17` |
| c4 MEM-4 (branch head) | `7253731` | `7475e09800d88464` |
| mem2bench (probe only) | `af0e850` | `415b921149505e46` |

## 0. Summary

**Every port is kept and default-on.** All four build with 0 warnings. The unit tests are 30/30 at the head. The TH_BATCH=2 smoke passes 13/13 on each of c1..c4.

**1. K7** (`6da668d`). Plain decode (no `--draft`) gets faster. The DFlash path is unchanged.

| metric (build) | base | K7 |
|---|---|---|
| plain decode T=0, loop tok/s | 26.29 | **28.75 (+9.4%)** |
| plain decode T=0, ms per token | 38.03 | 34.79 |
| plain decode sampled, tok/s | 25.97 | 27.78 (+7.0%) |
| V-multi fwd1, ms | 41.70 | **37.70 (−4.0)** |
| V-multi fwd8, ms | 39.60 | 39.35 (unchanged) |
| m=1 projections per token, ms (kernel bench) | 31.9 | 27.6 |
| DFlash T=0, ms/round | 55.12 | 54.64 (−0.5, noise) |

- Plain-decode T=0 text is identical 3/3.
- DFlash T=0 token ids are identical on the 3 bench prompts, and the text is identical on the 1831-token prompt.
- The switch `TH_M1_PATH=mpp` reproduces base 12/12, bitwise, in plain decode.

**2. N2** (`8ed2ac1`). This is a correctness fix; its perf effect is 0 (S3 ABBA: 54.31 vs 54.48 ms/round).

- Greedy CPU picks now use the GPU argmax tie rule, the lowest index.
- In a batch, T=0 slots read argmax rows even when a batch mate samples.
- Proof, TH_BATCH=2: before N2 a T=0 request co-scheduled with a sampled one produced text `83e6baa4`. The same request co-scheduled with a T=0 mate produced `5ae613fd`. After N2 both give `5ae613fd`, reproducibly.
- Plain-decode T=0 changes at exactly one exact tie ("code" prompt, SSE delta 23: " produce" becomes " provide"). By construction that is a tie: the only change is the tie rule.

**3. MEM-2** (`8b431f3`). Zero-fill blits removed at the 5 remaining sites: attention q_buf/out, the 3 draft kernel outputs, and the non-presum GDN outputs.

- **Small but real:** −0.37 ms/round (T=0, in-binary ABBA, S3) and −0.33 to −0.49 (S2).
- Microbench, paired: propose **−0.26 ms**, verify −0.06 to −0.09 ms synced (−0.25 ms host enqueue), commit −0.04 ms.
- Outputs are bitwise identical to zero-fill: 13/13 request streams and argmax/proposal checks.

**4. MEM-4** (`7253731`). The dead ring gathers are skipped.

- At a 1831-token prompt (ring about 1.8k): **propose 17.09 → 15.78 ms (−1.31)** and 74.14 → 73.18 ms/round (−0.96).
- At bench context (ring ≤ 210) it is about 0 (−0.08 ms propose).
- Bitwise identical output, 13/13.

**Branch head vs base** (S2, same session, palindrome):

| subset | ms/round | loop tok/s | propose, ms |
|---|---|---|---|
| T=0 | 55.12 → **54.35** (−1.4%) | 65.41 → 66.34 | 8.06 → 8.01 |
| all (T=0 + sampled) | 56.50 → 56.02 | 57.51 → 57.43 | — |
| ctx2k (1831 tokens) | 74.72 → **73.18** (−2.1%) | 45.35 → 46.54 | 17.00 → 15.78 |

- On "all", tokens/round went 3.249 → 3.217, from sampled divergence (K7 draft-commit rounding).

## 1. Commits (`git log 8d5b6d5..th/c-ports`)

| # | sha | item | files | summary |
|---|---|---|---|---|
| 1 | `6da668d` | K7 port | quant_kernel.rs +, qwen35.rs + | AffineQmvT m=1 tiled matvec + fused silu·mul, ported over K45 presum; qmvt_warm at load |
| 2 | `8ed2ac1` | N2 | engine.rs | greedy_argmax (lowest index on ties) in dist_vec; per-slot greedy routing in batch_round; tests |
| 3 | `8b431f3` | MEM-2 | new outbuf.rs, main.rs, qwen35.rs, draft_kernel.rs | `outbuf::kernel_out` (uninitialised pooled buffer) at 5 remaining zero-fill sites; `TH_OUT_ZEROS=1` A/B arm |
| 4 | `7253731` | MEM-4 | dflash.rs | draft ring id upload + 2× index_select moved below the fused draft_attn return; TH_DRAFT_EAGER read once |

## 2. K7: m=1 decode on the tiled-layout matvec, from `th/wp2-m1-decode` @`4bb1731`

### 2.1 Port

**Method:** `git cherry-pick -n 4bb1731` on `8d5b6d5`. That gave 4 conflict hunks: 1 in the quant_kernel.rs re-exports and 3 in qwen35.rs. The phase-B report predicted exactly these.

**Resolution** (K45 §7 rule: keep AffineQmvT at m=1, ignore the presum flag at rows==1):

- **`QLin::linear_ps` rows==1** (qwen35.rs:381):
  - `qmvt_m1` (qwen35.rs:324) runs before the MPP decode tile and ignores `presum`. A K45 presum block is also a plain `[1, in]` row: the normed plane of `AddRmsNorm{sums}` sits at element offset t·c = 5120, which is 16 B aligned, so the qmvt alignment guard passes.
  - If qmvt declines (`TH_M1_PATH=mpp`, untiled weights, a misaligned input, or `TH_QMM_SCALAR`), the pre-K7 route runs unchanged, presum included.
- **`gate_up_act_ps` rows==1** (qwen35.rs:747): the fused qmvt gate/up returns `(act, false)`. The activation is never a presum block, and `down` takes qmvt at m=1 anyway, which needs no sums.
- **`bench_q4_decode` (`TH_BENCH_Q4_M=1`):**
  - Kept K45's `(q, i)` candidate signature and its `path+ps` arm.
  - Added K7's arms. "pre-K7 mpp" now runs both plain **and `+ps`**; `+ps` is the head's real pre-K7 route for presum-fed projections. Also added: all 6 qmvt configs, and qmv / sg on the tiled layout.
  - `path+pad` is skipped at m=1, because qmvt declines a 2-byte offset and the arm would time the fallback.
- **Addition, a review low finding on 4bb1731:** `quant_kernel::qmvt_warm` (quant_kernel.rs:2447) builds all 12 `affine_qmvt*` pipelines from **one** `QMVT_SRC` compile at model load, next to `pf_warm` (qwen35.rs:2514; 62 ms at load). Before, the first request paid one full-library compile per config. It is skipped under `TH_M1_PATH=mpp`.

**V-build:** 0 warnings. **Tests:** 28/28 on `6da668d`, under gpu-lock. These include the 3 `qmvt_tests` and `qmvt_policy_table`.

### 2.2 Measurements

**V-multi.** Session S1, 06:03–06:04. `TH_BENCH_MULTI=8,1 TH_BENCH_MULTI_ITERS=6`, ABBA (base, K7, K7, base). Load 4.7–6.3. The first sample of each probe is dropped.

| | base 8d5b6d5 | K7 6da668d | Δ |
|---|---|---|---|
| fwd1 median (n=16) | 41.70 ms | **37.70 ms** | −4.00 (−9.6%) |
| fwd8 median (n=10) | 39.60 ms | 39.35 ms | −0.25 (noise) |

**Kernel bench.** `TH_BENCH_Q4=1 TH_BENCH_Q4_M=1`, 9 passes on the c1 binary (`logs/s1/k7_q4m1.probe.log`). The "head route" column is the pre-K7 MPP m=1 tile with the presum input.

| class (calls/token) | K7 path µs (GB/s) | pre-K7 mpp µs | pre-K7 mpp+ps µs (head route) | max\|Δ\|ref K7 / pre-K7 |
|---|---|---|---|---|
| gate_up 2×17408×5120 (64) | 185.6 (540) | 215.8 | 208.0 | 0.00195 / 0.00360 |
| down 5120×17408 (64) | 92.3 (543) | 111.5 | 124.6 | 0 / 0 |
| in_all 16480×5120 (48) | 93.8 (506) | 104.6 | 101.9 | 0 / 1e-5 |
| out 5120×6144 (48) | 38.1 (464) | 46.2 | 41.8 | 0 / 0 |
| in_qkv 14336×5120 (16) | 93.0 (444) | 106.6 | 98.2 | 0 / 0.00024 |
| o 5120×6144 (16) | 47.4 (374) | 56.0 | 50.8 | 0 / 0 |
| lm_head 248320×5120 (1) | 1246 (574) | 1334 | 1341 | 0.00391 / 0.00781 |
| **Σ per token** | **27.6 ms** | 32.1 ms | 31.9 ms | |

- The pre-K7 gate/up epilogue (eager narrow ×2 + silu + mul) is not in the table. It costs extra dispatches.

**Plain decode, no `--draft`.** S1, 06:04–06:09. Default n-gram spec 4. ABBA base_p1, k7_p1, k7_p2, base_p2. Load 3.2–4.7. GPU quiet: other clients 29–41 ms/s. The client sends 3 bench prompts at T=0, plus seeds 1/3/5 at 0.6/0.95/20, max_tokens 128.

| pooled (2 passes each) | base: ms/token, tok/s | K7: ms/token, tok/s | Δ tok/s |
|---|---|---|---|
| T=0 (566 tokens) | 38.03, 26.29 | **34.79, 28.75** | **+9.4%** |
| sampled (1708 / 1732 tokens) | 38.50, 25.97 | 36.00, 27.78 | +7.0% |
| all | 38.38, 26.05 | 35.70, 28.01 | +7.5% |
| `[tok]` host enqueue per m=1 step | 2.31 ms | 1.82 ms | fewer dispatches per token (not re-counted) |

- **T=0 token identity:** 3/3 identical (short, code, long, 283 tokens each). This is better than K7's original base, where "long" diverged at 120.
- **Sampled:** 1/9 identical. The other 8 diverge at SSE delta 2–39, the expected rounding-under-sampling effect.
- **Determinism:** each build is 12/12 identical across its two passes. c1 also matches across sessions: `c1_pt` in S2 equals `k7_p1` in S1.
- **Switch check** (S3, `c1mpp_p`, 07:45): the c1 binary with `TH_M1_PATH=mpp` is **12/12 bitwise identical to base** (text and every SSE delta, T=0 and sampled). It runs 37.33 ms/token, against base 37.24–38.83. No qmvt pipelines were compiled.

**DFlash (`--draft`).** S2 palindrome, 06:48–06:58, 2 arms per build. Load 2.5–4.5. GPU quiet: other clients 25–49 ms/s.

| | base | K7 |
|---|---|---|
| T=0, ms/round | 55.12 | 54.64 |
| T=0, tok/round | 3.605 | 3.605 |
| T=0, loop tok/s | 65.41 | 65.98 |
| T=0, propose ms | 8.06 | 7.86 |
| sampled, ms/round | 56.90 | 57.08 |
| ctx2k (1831-token prompt), ms/round | 74.72 | 74.61 |

- Per-arm pairs flip sign (−1.20 then +0.25 ms), so this is **unchanged within noise**, as K7's own report found.
- T=0 ids are identical on the 3 bench prompts (76 rounds, 274 tokens).
- **ctx2k:** the text is identical, but the round structure moved from 36 to 37 logged rounds. K7's m=1 draft commits round differently, which changes proposals and acceptance.
- **Sampled:** 5/9 identical. code/s1, code/s3, long/s3 and long/s5 diverge at ids 86/34/110/64. Sampled tokens/round went 3.146 → 3.106 on 9 requests. K7's report noted this as expected. It is not an acceptance regression claim either way; that needs R0b.

**Verdict: keep, default-on.**

## 3. N2: one greedy tie rule, from `verify-numerics-N2-tie` @`786490f`

### 3.1 Port

- **The `dist_vec` hunk:** `greedy_argmax()` (engine.rs:998) is a strict-`>` scan: lowest index, NaN never wins, all -inf gives 0. `Sampler::dist_vec` greedy calls it (engine.rs:835).
- **Test:** re-written as `n2_tie_tests` (engine.rs:2072), not cherry-picked. It checks that `dist_vec` greedy, `spec_accept_step`'s greedy branch, candle CPU argmax, and Metal bf16/f32 argmax all pick the lowest index. The cases are exact duplicates, two distinct f32 values that round to one bf16, and a 3-way tie. It also checks the `greedy_rows` routing table.
- **Not ported:** the probe commit `b255f7b` (TH_TIE_PROBE / TH_ARGMAX_CPU).
- **Batch half, new code:**
  - `greedy_rows()` (engine.rs:1011) holds the "no temperature, no repeat penalty in effect" rule. The single-slot loop (engine.rs:452) and `batch_round` (engine.rs:1499) share it.
  - `batch_round` used a single `all_greedy` flag: one sampled slot sent **every** slot through `to_vec2` + `dist_vec`. Now the `[rows]` argmax readback runs whenever any slot is greedy, greedy slots read it, and only sampled slots take `to_vec2`.
  - Side effect: T=0 slots in mixed batches no longer pay a 4 MiB bf16 readback plus 2M f32 conversions per round.

**V-build:** 0 warnings. **Tests:** `n2_` 2/2. That run was not under gpu-lock; see §7. The full suite is 30/30 at the head.

### 3.2 Validation

- **TH_BATCH=2 smoke with mixed pairs** (S2, 07:00–07:03). The client adds 2 repeats of a pair: "code" at T=0 co-scheduled with "long" sampled at seed 5.
  - **c1 (pre-N2):** the mixed-pair T=0 code gives sha1 `83e6baa4` in both repeats. The same request in the all-T=0 pair gives `5ae613fd`.
  - **c2, c3, c4:** both give `5ae613fd`.
  - So the T=0 slot's output no longer depends on whether its mate samples: it takes the same argmax-row route. That tie was hit in real traffic.
  - Everything else in the smoke has the same sha1 on c1..c4.
- **Plain decode T=0** (S2, `c1_pt` vs `c2_pt`, CPU `dist_vec` path): short and long are identical. "code" diverges at SSE delta 23, after "…Include a docstring." Need". c1 continues " produce final with code…" and c2 " provide code. Need…". c1 → c2 changes only the tie rule, so this is an exact bf16 top-1 tie, now resolved to the lowest id as the GPU verify would.
- **DFlash single-slot:** c2 is 13/13 identical to c1 in both S2 passes, and 8/8 in S3. No tie fell on an anchor token in these prompts.
- **Perf:** there is no mechanism on the single-slot path; it changes one `dist_vec` per request (the anchor).
  - S2 showed c2 +2.4 ms/round at T=0, but one arm was an outlier (code/t0 60.4 ms/round, against 54–55 for every other arm).
  - The dedicated S3 palindrome (07:41–07:45, load 3.2–3.9) gives **c1 54.31 vs c2 54.48 ms/round at T=0** (per-pair +0.25 and +0.10) and ctx2k 74.23 vs 74.09. That is 0 within noise.

**Verdict: keep** (correctness; no speed claim).

## 4. MEM-2: in-kernel/uninitialised outputs, from `verify-memory-MEM2` @`324f448`

### 4.1 Port

- **New `engine/src/outbuf.rs`:** `kernel_out()` is `unsafe { Tensor::empty }`, a pooled uninitialised buffer, the same allocation K45's `AllocBf16` makes. `TH_OUT_ZEROS=1`, read once via OnceLock, restores `Tensor::zeros` at every site as the A/B arm.
- **Sites K45 left**, with the kernel coverage argued in comments:

| site | file:line | fills removed |
|---|---|---|
| attention q_buf | qwen35.rs:3432 | 16 per verify |
| attention out | qwen35.rs:3442 | 16 per verify |
| draft_conv_fused output | draft_kernel.rs:204 | 20 per propose |
| draft_norm_rope output | draft_kernel.rs:266 | 10 per propose + 5 per commit |
| draft_attn output | draft_kernel.rs:313 | 5 per propose |
| GDN `gated` + `pack`, non-presum path | qwen35.rs:3146-3147 | 0 by default: only with `TH_Q4_PRESUM=0`, the legacy policy, or value_dim%64≠0 |

- **Coverage** of the kernels whose outputs lost their fill:
  - attn_prepare: 256 threads per (head, row). tid<rp writes the rotated pair, tid≥2rp the pass-through.
  - attn_decode: one simdgroup per q head, 8 channels per lane.
  - draft_conv: one thread per element.
  - draft_norm_rope: 128 threads per (row, head), each writing i and i+64.
  - draft_attn: 8 kv groups × 32 (head, row) pairs × 4 channels per lane.
  - gdn_fused_step: all y rows; v by every hv; q/k by the hv%REP owners.
- **Left as zeros deliberately:**
  - `ensure_kv` growth (qwen35.rs:3666@7253731): the anchor off-by-one attends the never-written row P as zero, so it must stay zero.
  - Slot, ring and state init, and `clear_kv_cache`.

**V-build:** 0 warnings.

### 4.2 Identity (the coverage proof)

- c3 vs c2, and c3z (c3 + `TH_OUT_ZEROS=1`) vs c3: **13/13 identical** request streams in both S2 passes (T=0, sampled and ctx2k) and 8/8 in S3.
- In the microbench, argmax A==B and proposal tokens A==B in 24/24 pairs, with no drift within either mode.
- Any unwritten element would read stale pool data in one mode and zeros in the other.

### 4.3 Measurements

**In-process interleaved microbench.** S3, 07:41. Probe-only binary af0e850 = head + atomic toggle, `TH_BENCH_ZEROS=24 TH_BENCH_DRAFT=$DRAFT`. A (zeros) and B (empty) alternate every iteration with the state restored; 24 pairs. `logs/s3/mem2bench.probe.log`.

| path | A zeros, median | B empty, median | paired B−A, median (mean) |
|---|---|---|---|
| verify forward_multi(8): host enqueue | 5.571 ms | 5.381 ms | −0.262 (−0.245) |
| verify: enqueue + argmax readback (synced) | 49.659 ms | 49.601 ms | **−0.055 (−0.091)** |
| draft propose, greedy, including the select syncs | 6.375 ms | 6.071 ms | **−0.257 (−0.234)** |
| draft commit, 4 rows, synced | 0.885 ms | 0.856 ms | −0.039 (−0.035) |

- **Expected per round:** about −0.35 ms. In verify, most of the blit cost is host-side and hidden behind GPU execution. The propose ends in host syncs, so it shows.

**E2E, same binary.** c3z vs c3, i.e. `TH_OUT_ZEROS=1` vs default, ABBA inside the palindromes.

| session | subset | c3z ms/round | c3 ms/round | Δ | per-pair |
|---|---|---|---|---|---|
| S3 | T=0 | 54.54 | 54.17 | **−0.37** | −0.39, −0.34 |
| S3 | ctx2k | 74.27 | 73.87 | −0.40 | |
| S2 | T=0 | 54.96 | 54.47 | −0.49 | −0.03, −0.97 |
| S2 | all | 56.82 | 56.49 | −0.33 | |
| S2 | ctx2k | 75.07 | 74.14 | −0.93 | |

- Host enqueue per round drops about 0.75–0.95 ms, while gpu+readback rises about 0.5 ms. The loop is partly GPU-bound, so most of the saved host time is overlap.
- **V-multi** (S2, `TH_BENCH_MULTI=8,1`, ABBA c2 / c3 / c3z / c3z / c3 / c2): fwd8 39.45 / 39.30 / 40.25 and fwd1 37.60 / 37.20 / 38.35. The two c3z probes ran back to back in the middle of the sequence (06:58:50–06:59:14), just as a CPU-load spike began: the 1-min load went 3.2 → 6.4 by 06:59:14. So the c3z excess (about +0.9 ms, larger than c2's zero fills) is position-confounded; the interleaved microbench above is the clean number.

**Verdict: keep.** The gain is small, −0.35 to −0.5 ms/round (about 0.7%), which is below the phase-B estimate of −0.8 to −1.2 ms. The change is risk-free: bitwise-identical outputs and an A/B switch. Most of the pre-K45 MEM-2 cost (+2.84 ms) was the 96 GDN fills K45 already removed.

## 5. MEM-4: dead draft ring gathers, from `verify-memory-MEM4b` @`b0681a7`

### 5.1 Port

- In `DraftWeights::attention` (dflash.rs:474/495), the host id list, the `Tensor::new` upload (a fresh MTLBuffer per call) and the two `index_select` gathers (4 MiB each at l=2048) now run **only** on the eager tail. That tail is their only consumer; the fused `draft_attn` reads the ring in place.
- It covers `propose` and `propose_batch` (B×5 calls).
- **Also:** `TH_DRAFT_EAGER` is read once via `draft_eager()` (dflash.rs:980) instead of 35 `env::var` calls per propose (review m6; the no-per-call-env-reads rule).

**V-build:** 0 warnings. **Tests:** 30/30 on the head (the `th-engine-tests-c4-7253731` binary, run at the start of S2 under gpu-lock).

### 5.2 Measurements

S2 palindrome, c3 vs c4, 2 arms each. The ctx2k request has an 1831-token prompt, so the ring holds about 1.83–1.96k rows.

| | c3 | c4 | Δ | per-pair |
|---|---|---|---|---|
| ctx2k propose ms | 17.09 | **15.78** | **−1.31** | −1.35, −1.27 |
| ctx2k ms/round | 74.14 | 73.18 | −0.96 | −1.12, −0.79 |
| ctx2k loop tok/s | 45.93 | 46.54 | +1.3% | |
| T=0 bench prompts (ring 58–210): propose ms | 8.09 | 8.01 | −0.08 | |
| T=0 bench prompts: ms/round | 54.47 | 54.35 | −0.12 (noise) | |
| sampled: ms/round | 57.07 | 56.50 | −0.57 | |

- The ctx2k gain matches the phase-B microbench (+1.40 ms per propose at ring 2048, +0.88 at 1024).
- **Identity:** c4 vs c3 is 13/13 identical in both passes.

**Verdict: keep.** It pays with context length.

## 6. Branch head vs base, same session (S2, 06:48–06:58)

Palindrome base c1 c2 c3z c3 c4 | c4 c3 c3z c2 c1 base. Each arm is a fresh server on :8033 with `TH_DEBUG_TIMING=1`. The client sends a warm-up, 3 prompts at T=0, 9 sampled requests (0.6/0.95/20, seeds 1/3/5) and ctx2k at T=0, max_tokens 128. The table pools 2 arms per build. `logs/s2_parse.md`.

| build | T=0 ms/round | T=0 tok/round | T=0 loop tok/s | T=0 propose | T=0 verify | all ms/round | all tok/s | ctx2k ms/round | ctx2k propose | TTFT med |
|---|---|---|---|---|---|---|---|---|---|---|
| base 8d5b6d5 | 55.12 | 3.605 | 65.41 | 8.06 | 46.11 | 56.50 | 57.51 | 74.72 | 17.00 | 185 |
| c1 K7 | 54.64 | 3.605 | 65.98 | 7.86 | 45.80 | 56.54 | 56.90 | 74.61 | 16.92 | 189 |
| c2 N2 | 57.05* | 3.605 | 63.19* | 9.02* | 46.98 | 57.46 | 55.99 | 75.49 | 17.35 | 174 |
| c3z (c3, zeros) | 54.96 | 3.605 | 65.59 | 8.05 | 45.96 | 56.82 | 56.61 | 75.07 | 17.18 | 192 |
| c3 MEM-2 | 54.47 | 3.605 | 66.19 | 8.09 | 45.57 | 56.49 | 56.95 | 74.14 | 17.09 | 184 |
| **c4 head** | **54.35** | 3.605 | **66.34** | 8.01 | 45.57 | 56.02 | 57.43 | **73.18** | **15.78** | 191 |

\* c2_d1 was an environmental outlier (58.31 ms/round T=0). S3 re-measured c2 at 54.48, against c1 at 54.31.

- **Totals, base → head:** T=0 −0.77 ms/round (−1.4%). ctx2k −1.54 ms/round (−2.1%) and propose −1.22 ms.
- **Sampled:** ms/round unchanged, 56.90 → 56.50. Tokens/round 3.146 → 3.106, because 4/9 sampled texts differ from K7's draft commits.
- **Identity vs base:**
  - T=0 bench prompts: identical in all builds.
  - ctx2k: text identical in all builds; K7 changed the round count 36 → 37.
  - Sampled: from c1 on, 5/9 identical to base, and **c1 = c2 = c3 = c3z = c4 bitwise** (13/13 in each pair).
- **Per-arm load:** 1-min load 2.5–4.5, GPU quiet before every arm (other clients 25–49 ms/s, mostly WindowServer at about 3%).

## 7. Gates

| gate | result |
|---|---|
| V-build (`cargo build --release`) at each commit | 0 warnings at 6da668d, 8ed2ac1, 8b431f3, 7253731 (and 0 on af0e850) |
| unit tests | 28/28 at 6da668d (gpu-lock, 05:52); `n2_` 2/2 at 8ed2ac1; **30/30 at 7253731** (gpu-lock, S2 06:48) |
| K7 V-multi | fwd1 −4.0 ms (41.70 → 37.70), fwd8 unchanged |
| K7 plain-decode T=0 A/B | 3/3 identical; +9.4% loop tok/s |
| K7 DFlash A/B | T=0 3/3 identical ids; ms/round unchanged; ctx2k text identical |
| K7 switch `TH_M1_PATH=mpp` | 12/12 bitwise equal to base (plain, T=0 + sampled) |
| N2 | mixed-batch T=0 output now equals all-greedy-batch output (c1: `83e6baa4` ≠ `5ae613fd`; c2..c4: `5ae613fd`); plain T=0: 1 tie flip; DFlash 13/13 = c1; perf 0 |
| MEM-2 | 13/13 and 8/8 identical to zeros; microbench A==B; −0.37 ms/round (in-binary ABBA) |
| MEM-4 | 13/13 identical; ctx2k propose −1.31 ms |
| TH_BATCH=2 smoke (13 requests: 2 T=0 pairs, 2 sampled pairs, 2 mixed T=0 + sampled pairs, warm-up) | c1, c2, c3, c4 each 13/13 HTTP 200, 0 errors, max trigram-repeat 0.097, 1508 completion tokens, mixed pairs reproducible across repeats |
| `/status`, `th_stats` | no fields added, none removed |
| per-call env reads in hot paths | none added. `TH_DRAFT_EAGER` removed from the per-call path; `TH_OUT_ZEROS` and `TH_M1_PATH` are OnceLock. The pre-existing `TH_NO_ATTN_FUSED`/`TH_DEBUG_ATTN` reads in attention are untouched. |
| MetalStorage clone-escape class | none: qmvt outputs are fresh `new_buffer_builder` buffers; `kernel_out` is `Tensor::empty` |

**Deviation:** the `cargo test --release n2_` run at about 06:02 (2 tests, about 3 s) was **not** under gpu-lock. It ran a few ms of Metal argmax on a 3×248320 tensor while another agent (`th-c-loop` session_L1) held the lock. Every other GPU use was under the lock.

## 8. Method, commands, cleanup

**Setup:**
```sh
P=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC
W=$P/work/th-c-ports
WT=$($P/bin/wt-bootstrap th/c-ports)                      # 8d5b6d5
git -C $WT cherry-pick -n 4bb1731                          # K7; resolved as in §2.1; one commit per item
(cd $WT/engine && cargo build --release)                   # binaries copied to $W/bin/th-engine-<c#>-<sha>
```

**Sessions** (each one gpu-lock hold):
```sh
$P/bin/gpu-lock -- $W/bin/s1_k7.sh    # 06:03-06:09  K7 V-multi ABBA, TH_BENCH_Q4 m=1, plain-decode ABBA
$P/bin/gpu-lock -- $W/bin/s2_all.sh   # 06:48-07:03  tests; DFlash palindrome (12 arms); V-multi c2/c3/c3z; plain T=0 c1/c2; TH_BATCH=2 x4
$P/bin/gpu-lock -- $W/bin/s3.sh       # 07:41-07:46  MEM-2 microbench; T=0 palindrome c1 c2 c3z c3 x2; c1 TH_M1_PATH=mpp plain
```

**Analysis:**
```sh
python3 $W/bin/parse.py   $W/logs/s2 --group base:base_d1,base_d2 ... <labels>   # ratio-of-sums per arm and group, identity
python3 $W/bin/vmulti.py  $W/logs/s1 base:base_m1,base_m2 k7:k7_m1,k7_m2          # V-multi medians
```

**Scripts in `$W/bin/`:**
- `serve_arm.sh`: fresh server per arm; modes draft / plain / plain0 / batch2; records load and GPU-quiet before and after.
- `client.py`: log byte ranges and per-token SSE deltas; options `--long` and `--no-sampled`.
- `batch2_client.py`: the phase-B smoke plus the N2 mixed pairs.
- `probe.sh`, `parse.py`, `vmulti.py`, `gpuq.py`.

**Loop metric:** tok/s = Σ emitted / Σ `[dflash]` step-ms. It excludes the prefill-sampled first token and the final unlogged round. Plain decode: Σ(completion−1) / Σ((completion−1)/th_stats.decode_tps).

**Cleanup:**
- **Servers:** 31 th-engine servers were started on :8033 (S1 4, S2 18, S3 9) and 13 probe processes (S1 5, S2 6, S3 1, plus 1 trial). Every server was stopped with SIGTERM by `serve_arm.sh`; probes exit on their own.
- **After the sessions:** :8033 is free. Only pid 16917 is listening on :8001, untouched. :8000 was never touched and is not listening.
- **Main working tree:** never edited, built or reset.
- **Worktrees to keep:** `.worktrees/th/c-ports` (the deliverable) and `.worktrees/th/c-ports-mem2bench` (probe only). Remove the probe with `git worktree remove .worktrees/th/c-ports-mem2bench && git branch -D th/c-ports-mem2bench`.

**Coordination:** as in the phase-B report, engine.rs (N2), dflash.rs (MEM-4) and qwen35.rs (all four) are in the other developer's area. The batch_round change in N2 touches their batched path and needs their sign-off.
