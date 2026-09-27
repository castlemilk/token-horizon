# th/d-longctx: long-context attention (N3 split-key `attn_decode`, N4 `draft_attn_split`), the G1a prefill check, and long-prompt memory

Written 2026-09-26 (final hold 19:06–19:44, scratch hold after it) by the th/d-longctx agent for the Phase D orchestrator.

- **Setup:** M5 Max, 40-core GPU, 128 GB. Qwen3.8-27B-4bit + DFlash draft.
- **Discipline:** private port :8041, every GPU-timed run inside `$P/bin/gpu-lock`, a fresh server per arm.
- **Tags:** [M] measured, [D] derived, [E] estimate.

**Repository**

- **Branch:** `th/d-longctx`, worktree `/Users/benebsworth/projects/token-horizon/.worktrees/th/d-longctx`, from `main` @`521c6e0`. Not pushed; nothing committed to main; the main working tree was never touched.

| # | commit | item | default | serving-path change? |
|---|---|---|---|---|
| 1 | `97fffcf` | **N3** split-key `attn_decode` (MPP tile, fixed-order reduce) | on at ≥ 256 visible keys | yes |
| 2 | `bc94adb` | **N4** `draft_attn_split` (64 threadgroups, split keys; port of 1738e0a/dd28d2a) | on (1 split = bit-identical up to ring 248) | yes |
| 3 | `770ce23` | N3 bench: `TH_BENCH_ATTN_QSCALE` (peaked-attention precision check) | — | no (probe) |
| 4 | `a5b911f` | one causal mask per forward in the eager attention paths (long-prompt pool growth) | on | yes (same values) |
| 5 | `d0ac219` | trim candle's pool between long-prompt prefill chunks (`TH_PREFILL_SYNC`, pos ≥ 2048) | on | yes (sync only) |
| 6 | `8272b5a` | N3 bench reports the routed split count (cap applied) | — | no (probe) |
| 7 | `3cba876` | N3 persistent split-partials scratch (no per-round re-allocation; `TH_ATTN_SPLIT_SCRATCH=0` = A/B arm) | on | yes (same kernels) |

- **Probe branch (not for merge):** `th/d-longctx-probe` @`5090f18`, worktree `.worktrees/th/d-longctx-probe`. It is `bc94adb` plus probe-only hooks:
  - `TH_BENCH_ROUND`: in-process 4-arm long-context round A/B with KL / top-20 numerics. `5090f18` also fixed a probe artefact: the old probe regrew the KV cache on every timed verify.
  - `TH_BENCH_PREFILL_AB=carry`: the item-3 A/B.
- **Work dir:** `$W = /Users/benebsworth/projects/token-horizon/.worktrees/_phaseC/work/th-d-longctx`, containing `bin/` (frozen binaries, hold scripts, `fpguard.py`), `bench/`, `logs/final2/` (final hold) and `logs/finalS/` (scratch hold).

**Frozen binaries** (in `$W/bin/`)

| label | build | sha256 |
|---|---|---|
| new (final hold) | `d0ac219` | `e30c570abd48a045…`; tests `ec1ea409ba995250…` |
| new + scratch (scratch hold) | `3cba876` | `e361f0e4a8ffd644…`; tests `1b74e68620bf19c8…` |
| base | `main` @`521c6e0` | `66e99644402995638d921e8e53cb6fc1f12d1d8fbcfea12c71de2c238f6cb133` (= PHASEC th-integ2) |
| probe | `th/d-longctx-probe` @`5090f18` | `c1732a0582935107…` |

`8272b5a` differs from the validated `d0ac219` only in `attn_bench.rs` (probe code). `3cba876` is `8272b5a` plus the scratch; its own gates and A/B are in §1.4.

**Machine state**

- The machine was shared all day by four Phase D lanes. It **rebooted at 16:03** during this lane's previous session: a 32k in-process probe exhausted memory (§6).
- Final hold (19:06–19:44): 1-min load 11–58; thermal pressure level 1–2 on most stages. In the session the two base arms started at level 0 and the two new arms at level 2. new2 also ran under a load spike (22–34, against 8–12 for the other arms).
- **Consequences for the numbers:**
  - The load- and thermal-robust estimates are the in-process paired A/Bs (§1.1).
  - In the session, new1 is the load-matched arm (load 11–16 against base's 8–11). It still ran at thermal level 1–2, which disadvantages the new arms.
  - Pooled session numbers are also given, with new2's contamination noted.

## 0. Summary

1. **N3 is done and on by default** (`97fffcf` + scratch `3cba876`). It is split-key `attn_decode` with a fixed-order reduce, so it is deterministic, and it keeps the fused norm + rope + cache-write prepare.
   - Kernel: 9.7–28× faster than the single-pass kernel at 512–32k keys. The 16-layer verify attention drops from 9.1 to 0.60 ms at 1.45k, 51.6 → 2.06 at 8k and 209 → 7.4 at 32k [M].
   - Precision against an f64 reference equals the single-pass kernel's at every L up to 32k, including peaked attention.
   - kv_quant (TurboQuant) slots stay on `attn_quant`; their T=0 texts are identical to base.
2. **N4 is ported and on by default** (`bc94adb`). One split is bit-identical to `draft_attn`, so all bench-context rounds keep base numerics. Per propose: 4.63 → 0.47 ms at a 1.45k ring and 8.09 → 0.68 at 2048 [M]. The conflicts with main in dflash.rs/engine.rs/main.rs were resolved by dropping the prototype's per-call env reads (MEM-4 and N1 already cover those paths).
3. **Item 3 is not a real regression; no fix.** The +2.4% was 6-vs-6 ctxcold medians. Pooled PHASEC data give +1.0% ± 1.4%. A synced 4-build forward A/B and an in-process carry-on/off A/B show no G1a prefill cost. What moved is where the host waits: the G1a carry dispatch hits the 64-command-buffer cap earlier (§4).
4. **Found and fixed: long-prompt memory** (`a5b911f`, `d0ac219`).
   - candle's wired buffer pool grew roughly quadratically over a chunked prefill. A 32k in-process probe rebooted the machine (16:03).
   - A 24k server prefill reached a 119 GB phys_footprint (18:25; ps RSS showed 4 GB, so RSS watchdogs are blind).
   - With both fixes: 8k 29.6 GB, 12k 37.8 GB, 16k 42.6 GB peak. Base and mask-fix-only are killed above 48 GB at 12k. TTFT is unchanged within noise (§6).
5. **Targets** (T=0; details in §1):

| target | result | status |
|---|---|---|
| ctx1500 round ≤ 52 ms | server, load-matched arm new1: **49.75 ms/round** (base 62.63 / 62.75; −20.6%, loop tok/s 80.1 vs 61.0) · in-process L=1450: 51.1 min / 53.2 median (base 66.9 / 70.8; paired Δ −17.4 = N3 −10.5, N4 −6.8) · pooled with the loaded new2 arm: 53.31 | **met** in the matched server arm; the in-process median is 1.2 ms over |
| 8k round ≤ 1.3× short context | server new1: ctx8k 60.55 / greedy 48.08 = **1.26** (pooled 58.90 / 54.27 = 1.09; base 2.26) · with the scratch (`3cba876`, §1.4): 55.45 / 48.19 = **1.15** · in-process: new@7900 / new@128 = **1.06** (base 2.40) | **met** |

   - ctx8k decode is **1.85×** base (65.8 vs 35.5 loop tok/s).
   - At 8k the verify GPU tail is back at its short-context level (38–43 ms). Most of the remaining 8k growth was host encode (new1 12.2 / 8.9 ms mean / median against 2.1 at short context), attributed to 32 partials buffers re-created after every sync. `3cba876` makes them persistent: in-binary palindrome A/B (identical texts), ctx8k 64.9 → 55.5 ms/round (−14.5%), host encode 7.2 → 3.5 ms; ctx1500 and greedy unchanged within noise (§1.4). With it the 8k round is **1.15×** the short-context round of the same session.
6. **Gates** (all run on both `d0ac219` and `3cba876`). 0 warnings; unit tests 46/46; R0a rollback state-bitwise PASS on four probes: default, forced split at every length, a 1450-token prompt, and `TH_GDN_COMMIT=step` (FAIL, as intended). TH_BATCH=2 short 13/13 and long 9/9; `--kv-quant` 4/4; no-draft 4/4. No panics, WARN or ERROR (§5).
7. **T=0 identity against base, same session:**
   - 8/12 prompt groups byte-identical: all 3 greedy (bench prompts), all 3 ctx1500, ctxcold/short, ctx8k/short.
   - 4 diverge at near-ties: ctxcold/code token #122, ctxcold/long #15, ctx8k/code #30, ctx8k/long #19. These positions and texts are identical to the previous session's bc94adb run, so they are deterministic.
   - In-model numerics: per-row KL(single ‖ split) ≤ 2.3e-3 nats; top-20 |Δlogit| ≤ 0.375; argmax rows agree 8/8 at every L except 7/8 at 1450.
8. **Not done / open:**
   - The split threshold stays at 256 keys to keep short-context T=0 identity. `TH_ATTN_SPLIT_MIN=1` would save a further 0.7 ms/round at 128 keys (−1.5%), at the cost of changing bench-context numerics (§1.2).
   - The remaining long-context TTFT gap is the O(L²) eager prefill attention: 16k takes 89 s. That is the next lever (§7).

## 1. Results against the targets

### 1.1 In-process round A/B (load-robust; final hold 19:22–19:25, load 12–18, thermal 1)

- **Probe:** `TH_BENCH_ROUND` (`5090f18`), 2 processes.
- **Per L:** prefill L ids of the fixed 7853-token passage in 512-row chunks, with the last 8 rows through the fused path as the server's first verify would take them. Then warm the draft ring. Then 12 blocks of the 4 arms, interleaved ABCD / DCBA.
- **Per iteration:** greedy propose (ends in one host sync) + verify (8 rows) + argmax readback, then a light-snapshot restore.
- **Arms:**
  - new = N3 + N4;
  - base = single-pass `attn_decode` + `draft_attn`;
  - n3 = N3 only (legacy draft attention);
  - n4 = N4 only (single-pass verify attention).
- The probe loop is not the server loop; paired deltas are the robust quantity.
- Statistic: median over the two processes of each process's min (and median).

_2 process(es); per L x arm: median over processes of each process's statistic (12 blocks x 4 arms, ABCD/DCBA)_

| L (keys) | arm | propose min / med ms | verify min / med ms | **round min** / p25 / med ms |
|---|---|---|---|---|
| 128 | new | 5.29 / 5.61 | 40.34 / 42.50 | **45.71** / 46.28 / 48.02 |
| 128 | base | 5.48 / 5.81 | 40.10 / 42.69 | **45.59** / 46.31 / 48.46 |
| 128 | n3 | 5.51 / 5.89 | 40.45 / 43.37 | **46.03** / 46.55 / 49.30 |
| 128 | n4 | 5.31 / 5.60 | 40.20 / 43.24 | **45.55** / 46.05 / 49.12 |
| 512 | new | 5.80 / 6.08 | 43.77 / 47.21 | **49.65** / 50.14 / 53.24 |
| 512 | base | 7.74 / 8.53 | 46.59 / 50.51 | **54.36** / 55.97 / 58.81 |
| 512 | n3 | 7.82 / 8.52 | 43.89 / 47.18 | **51.77** / 52.40 / 55.70 |
| 512 | n4 | 5.78 / 6.12 | 46.94 / 50.80 | **52.75** / 53.89 / 57.06 |
| 1450 | new | 6.17 / 6.47 | 44.88 / 46.80 | **51.08** / 52.87 / 53.17 |
| 1450 | base | 12.56 / 13.39 | 54.32 / 57.33 | **66.88** / 69.90 / 70.75 |
| 1450 | n3 | 12.73 / 13.36 | 44.87 / 46.68 | **57.69** / 59.54 / 60.19 |
| 1450 | n4 | 6.21 / 6.41 | 54.95 / 57.40 | **61.17** / 62.97 / 63.72 |
| 2048 | new | 6.47 / 6.83 | 45.98 / 49.20 | **52.45** / 54.59 / 56.03 |
| 2048 | base | 17.70 / 19.18 | 59.92 / 64.83 | **77.62** / 81.53 / 84.06 |
| 2048 | n3 | 17.72 / 18.99 | 45.81 / 48.50 | **63.54** / 66.13 / 67.42 |
| 2048 | n4 | 6.58 / 6.87 | 61.42 / 64.94 | **68.08** / 69.47 / 71.89 |
| 4096 | new | 6.04 / 6.20 | 43.06 / 44.23 | **49.14** / 49.78 / 50.46 |
| 4096 | base | 16.05 / 16.96 | 69.37 / 71.87 | **85.55** / 86.72 / 88.80 |
| 4096 | n3 | 16.14 / 16.71 | 43.01 / 44.46 | **59.14** / 59.75 / 61.17 |
| 4096 | n4 | 5.99 / 6.21 | 69.26 / 72.61 | **75.33** / 76.34 / 78.80 |
| 7900 | new | 5.96 / 6.13 | 42.55 / 44.66 | **48.50** / 50.52 / 50.70 |
| 7900 | base | 15.58 / 16.55 | 93.82 / 98.66 | **109.41** / 113.34 / 115.32 |
| 7900 | n3 | 15.94 / 16.69 | 43.30 / 45.36 | **59.33** / 60.70 / 62.06 |
| 7900 | n4 | 6.01 / 6.21 | 93.67 / 99.54 | **99.80** / 103.53 / 105.69 |

| L | paired round Δ vs new, per-block median (p25): base | n3-only (legacy draft_attn) | n4-only (single-pass attn) | new/base (round min) | new min / new@128 | base min / base@128 | prefill ms |
|---|---|---|---|---|---|---|---|
| 128 | +0.38 (-0.19) | +0.54 (-0.10) | -0.13 (-0.90) | 1.003 | 1.000 | 1.000 | 248 |
| 512 | +5.86 (+4.99) | +2.17 (+1.34) | +3.13 (+2.50) | 0.913 | 1.086 | 1.192 | 1146 |
| 1450 | +17.40 (+16.91) | +6.78 (+6.43) | +10.48 (+10.14) | 0.764 | 1.117 | 1.467 | 3766 |
| 2048 | +27.63 (+26.70) | +11.80 (+10.91) | +15.79 (+14.26) | 0.676 | 1.148 | 1.703 | 5438 |
| 4096 | +38.39 (+36.93) | +10.55 (+10.05) | +28.20 (+26.59) | 0.574 | 1.075 | 1.877 | 11402 |
| 7900 | +64.06 (+62.76) | +10.66 (+10.32) | +54.64 (+53.12) | 0.443 | 1.061 | 2.400 | 26778 |

(Numerics lines are identical in both processes; tabulated below.)

- **N3/N4 split** of the paired Δ (base − new):

| L | N3 (n4-only − new) | N4 (n3-only − new) | total | new/base, round min |
|---|---|---|---|---|
| 1450 | 10.5 | 6.8 | 17.4 | 0.764 |
| 2048 | 15.8 | 11.8 | 27.6 | 0.676 |
| 4096 | 28.2 | 10.6 | 38.4 | 0.574 |
| 7900 | 54.6 | 10.7 | 64.1 | 0.443 |

  N4's share flattens past 2k because the draft ring is capped at 2048.
- **Context growth.** new: round min 45.7 → 48.5 ms from 128 to 7900 keys (1.061×). base: 45.6 → 109.4 ms (2.40×).
  - Caveat: each process visits L in increasing order while the load was falling (18 → 12). The new-arm ratios therefore carry about ±5% of time drift; for example, new at 2048 (52.5) reads above new at 7900 (48.5).
- **Numerics, one fixed verify input per L:**

| L | max-row KL(single ‖ split), nats | top-20 max \|Δlogit\| | argmax rows agree | draft proposals, common prefix |
|---|---|---|---|---|
| 512 | 9.2e-4 | 0.125 | 8/8 | 7/7 |
| 1450 | 2.3e-3 | 0.25 | 7/8 | 1/7 |
| 2048 | 8.4e-4 | 0.125 | 8/8 | 7/7 |
| 4096 | 1.9e-3 | 0.19 | 8/8 | 7/7 |
| 7900 | 6.5e-4 | 0.375 | 8/8 | 7/7 |

  - Identical in both processes (deterministic).
  - The 1450 draft divergence is a greedy near-tie in the draft chain. Proposals only affect acceptance, not T=0 output.

### 1.2 N3 below the 256-key threshold (opt-in `TH_ATTN_SPLIT_MIN=1`, same probe, 1 process, 16 blocks)

| L | paired round Δ base − new, ms (p25) | of which N3 | KL, nats / top-20 \|Δ\| / argmax |
|---|---|---|---|
| 128 | +0.98 (+0.59) | +0.73 (+0.48) | 1.2e-3 / 0.125 / 8/8 |
| 192 | +1.44 (+1.22) | +1.48 (+0.58) | 5.0e-4 / 0.125 / 8/8 |
| 256 | +2.25 (+2.11) | +1.63 (+1.36) | 2.0e-3 / 0.25 / 8/8 |

- Splitting at bench context would save ≈0.5–0.7 ms/round (≈1–1.5%) but change bench-context T=0 numerics.
- The default stays at 256, so the bench prompts are bit-identical to base. Lowering it is a one-knob change for the orchestrator to decide, and would need its own identity re-baseline.

### 1.3 Session A/B (server, bench-quiet harness; final hold 19:25–19:44)

- **Arms:** palindrome base1 → new1 → new2 → base2 on :8041, a fresh server per arm (`TH_DEBUG_TIMING=1`, `--draft`), 33 requests per arm plus warm-ups, 132/132 OK.
- **Modes:**
  - greedy: 3 bench prompts × 3, T=0, 128 tokens;
  - sampled: seeds 1/3/5 at 0.6/0.95/20;
  - ctx1500: 1373-token passage, 3 × 3;
  - ctxcold: 1 per prompt;
  - ctx8k: 7853-token passage, 1 per prompt.
- **Conditions per arm** (load1 at request start):
  - base1: 8.9–11.2, thermal 0 (level 2 by ctxcold);
  - new1: 10.7–16.3, thermal 1–2;
  - new2: 15.0–34.2, thermal 2;
  - base2: 8.1–10.4, thermal 0–2.
- **Phases (ms per logged round).** Host encode = `[verify] enqueue` − propose.

| arm | mode | rounds | tok/round | propose | host encode mean / p50 | GPU tail + readback | **ms/round** | loop tok/s |
|---|---|---|---|---|---|---|---|---|
| base1 / base2 | greedy | 210 / 210 | 3.843 | 6.8 / 6.5 | 2.5 / 2.4 | 40.6 / 38.9 | 50.41 / 48.37 | 76.2 / 79.5 |
| **new1** / new2 | greedy | 210 / 210 | 3.843 | 6.2 / 7.6 | 2.1 / 2.6 | 39.3 / 49.7 | **48.08** / 60.47 | **79.9** / 63.6 |
| base1 / base2 | sampled | 229 / 229 | 3.590 | 6.9 / 7.0 | 2.3 / 2.6 | 39.4 / 39.1 | 51.07 / 51.50 | 70.3 / 69.7 |
| **new1** / new2 | sampled | 229 / 229 | 3.590 | 6.6 / 7.5 | 2.1 / 2.8 | 39.5 / 44.6 | **50.78** / 57.86 | **70.7** / 62.0 |
| base1 / base2 | ctx1500 | 219 / 219 | 3.822 | 12.2 / 12.3 | 2.5 / 2.8 | 47.4 / 47.1 | 62.63 / 62.75 | 61.0 / 60.9 |
| **new1** / new2 | ctx1500 | 210 / 210 | 3.986 | 6.7 / 8.7 | 3.4 / 5.3 | 39.2 / 42.1 | **49.75** / 56.87 | **80.1** / 70.1 |
| base1 / base2 | ctxcold | 62 / 62 | 4.371 | 12.4 / 12.5 | 2.5 / 2.8 | 48.6 / 47.8 | 63.95 / 63.67 | 68.4 / 68.7 |
| **new1** / new2 | ctxcold | 63 / 63 | 4.270 | 6.6 / 9.1 | 3.1 / 5.1 | 39.5 / 42.2 | **49.56** / 57.06 | **86.2** / 74.8 |
| base1 / base2 | ctx8k | 69 / 69 | 3.957 | 16.5 / 17.4 | 3.3 / 3.8 | 89.1 / 91.5 | 109.44 / 113.35 | 36.2 / 34.9 |
| **new1** / new2 | ctx8k | 71 / 71 | 3.873 | 9.1 / 7.6 | **12.2 / 8.9**, 6.0 / 5.5 | 38.2 / 43.1 | **60.55** / 57.25 | **64.0** / 67.7 |

**Pooled (both arms, ratio of sums), new / base:**

| mode | new ms/round | base ms/round | loop tok/s new / base | ratio |
|---|---|---|---|---|
| greedy | 54.27 | 49.39 | 70.8 / 77.8 | 0.910 ‡ |
| sampled | 54.32 | 51.29 | 66.1 / 70.0 | 0.944 ‡ |
| ctx1500 | 53.31 | 62.69 | 74.8 / 61.0 | **1.226** |
| ctxcold | 53.31 | 63.81 | 80.1 / 68.5 | **1.169** |
| ctx8k | 58.90 | 111.39 | 65.8 / 35.5 | **1.851** |

‡ The pooled short-context deficit is new2's load spike and thermal state. The load-matched arm new1 is at parity or better: 48.08 vs 50.41 / 48.37 greedy, 50.78 vs 51.07 / 51.50 sampled. That matches the in-process L=128 result (paired Δ +0.38 ms in new's favour) and the code: at bench context N3 is not routed, and N4's one split is bit-identical to the legacy kernel.

- **Tokens per round** on byte-identical text (8 groups, 626 tokens): new 156 rounds vs base 159 (4.013 vs 3.937 tokens/round). At ctx1500 the texts are identical but acceptance differs (3.986 vs 3.822), because N4's split rounding changes some draft proposals.
- **TTFT** (median of the arm medians): greedy 171 / 217 (new1 / new2) vs 175 / 163 (base1 / base2); ctx1500 2677 / 3293 vs 2450 / 2626; ctx8k 24631 / 26003 vs 22957 / 23762 ms. new1 is 4–7% above the base mean, but the two base arms differ from each other by 6–7%, and the new arms ran at thermal level 1–2. No TTFT change is resolved. Prefill code is unchanged apart from the mask and the pool trim, which are measured in §6 (TTFT 30.4 vs 30.1 s at 8k, trim on vs off, same binary and hold).

### 1.4 N3 persistent partials scratch (`3cba876`): in-binary A/B (scratch hold 20:00–20:24)

- **What changed:** before `3cba876`, `attn_decode_split` took its f32 partials and (max, sum) buffers from candle's pool on every call. candle trims that pool at every host sync, and each decode round ends in one, so every verify re-created 32 buffers: fresh MTLBuffers plus residency-set commits, in the host encode.
- **Setup:**
  - Binary `3cba876` (`e361f0e4…`). Arm A = `TH_ATTN_SPLIT_SCRATCH=0` (per-call allocation, i.e. the `d0ac219` behaviour); arm B = default (scratch).
  - Palindrome A1 → B1 → B2 → A2, :8041, a fresh server per arm; 84/84 requests OK.
  - Modes: greedy 3×3, ctx1500 3×3, ctx8k 3×1.
  - Conditions: load 11.8–20.8; A1 ran at thermal 2 with load ≈20 (disturbed); the other arms at thermal 0–2.

| mode | A1 / A2 ms/round (no scratch) | B1 / B2 ms/round (scratch) | host encode mean / p50, A → B | pooled A → B |
|---|---|---|---|---|
| greedy (control: N3 not routed) | 69.25 ‡ / 47.63 | 48.67 / 47.71 | 3.9 / 2.6 → 2.3 / 2.2 (A2 alone 2.2 / 2.1) | control |
| ctx1500 | 58.68 ‡ / 48.09 | 50.74 / 49.34 | 3.7 / 3.4 → 2.8 / 2.5 | not resolved (A2 is 1.9 ms *below* B) |
| ctx8k | 61.45 / 68.27 | 55.50 / 55.39 | **7.2 / 5.1 → 3.5 / 2.5** | **64.86 → 55.45 ms (−14.5%)** |

‡ A1: load spike and thermal level 2. Its greedy control, which the scratch cannot affect, is 21 ms/round slower than A2.

- **Result:** at 8k both A arms bracket both B arms, and the host encode halves. At 1.45k the effect is within noise; the partials there are 4 MiB-class against 8 MiB at 8k.
- **Text:** byte-identical in all 4 arms and identical to the final hold's `d0ac219` texts. Tokens/round are identical (3.843 / 3.986 / 3.873).
- **Gates on `3cba876`** (`$W/logs/finalS/gates-new/`):
  - unit tests 46/46;
  - R0a default PASS, forced split PASS, 1450-token prompt state-bitwise PASS, step FAIL rc 1 (as intended);
  - TH_BATCH=2 short 13/13 and long 9/9;
  - `--kv-quant` 4/4 and no-draft 4/4, all texts identical to `d0ac219`'s;
  - 0 panics, WARN or ERROR; no guard kills. The hold script's rc=1 is its final `cat guard.log` on a missing file.
- **With the scratch:** ctx8k round 55.45 ms against greedy 48.19 in the same session = **1.15× short context**.

## 2. N3: split-key `attn_decode` (commit `97fffcf`)

### 2.1 What changed

- **Kernel pair** (engine/src/attn_kernel.rs; MSL `attn_split_mpp` :704 and `attn_split_reduce` :814; host fn `attn_decode_split` :947):
  - The partial kernel's grid is (kv head, split) × 256 threads. Each threadgroup runs the whole GQA group of the verify block, M = 8 rows × 6 q heads = 48 fused query rows, over its share of 32-key pages.
  - MPP `matmul2d` (execution_simdgroups<8>) computes q·kᵀ (48×32×256) and p·v (48×256×32). One K/V page read therefore serves all 48 rows; the single-pass kernel and the 4f998f4 prototype read K/V once per row.
  - The online softmax is per row (`th_page_softmax` :642): 4 lanes per fused row with 8 keys each, xor-shuffle max/sum, and a relaxed-atomic rescale flag.
  - Each split writes f32 partials `[slot][48][256]` plus (max, sum). The reduce dispatch has one threadgroup per (kv head, fused row) and one thread per channel. It combines the splits **in split order** and applies the sigmoid output gate.
  - **Deterministic.** The partition is a pure function of (visible keys, splits) and the reduce order is fixed (unit test: bitwise-equal reruns).
  - Ported from Splash's `paged_attention_tile.h` verify tile (incoai/splash@134807b) onto our contiguous caches with element strides. Both layouts work: head-major `[nkv, cap, d]`, and the time-major view that the eager prefill's `cat` leaves (it persists through `ensure_kv`'s `cat`).
- **Precision.** p·v runs on f32 probabilities (`float × bfloat → float`, MPP-supported), the single-pass kernel's precision class. `TH_ATTN_SPLIT_P=bf16` selects Splash's bf16 tile: ≈25% faster split, with 2–4× larger deviation from the single-pass kernel.
- **Fused prepare kept.** `attn_prepare` (:418) still does rmsnorm + rope + K/V cache append in one dispatch. With `qrows = 8` it writes q in the tile's KV-head-major layout and zeroes a short block's padding rows in-kernel (no blit; MEM-2 style).
- **Routing** (`split_plan` :1048, knobs read once in `split_cfg` :66; call site qwen35.rs:3623 and :3662):
  - At visible keys ≥ `TH_ATTN_SPLIT_MIN` (256), the split kernel runs with `clamp(ceil(pages/8), 16, 32)` splits (≤ pages; `split_count` :34).
  - Below 256 keys the single-pass kernel runs unchanged. That covers every call of a short-prompt request (the bench prompts peak at ≈180 keys), so bench-context numerics are bit-identical to base.
  - `TH_ATTN_SPLIT=0` gives single-pass everywhere (the A/B arm); `TH_ATTN_SPLITS=N` pins the split count; `TH_ATTN_SPLIT_BASE/_PPS/_CAP` shape the policy.
  - The split kernel is used only when its MPP library compiles on the device and the cache holds whole pages (`split_pipes`: unsupported geometry or compile failure → single-pass, logged once).
- **kv_quant (TurboQuant) stays on its own path.** The fused block requires `tq.is_none()`, so TurboQuant slots fall through to the eager path, which returns `attn_quant` (qwen35.rs:3810) before any cache concat. They never reach either decode kernel. Gated with `--kv-quant --draft` (§5).
- **`ensure_kv`** (qwen35.rs:3886) grows capacity in whole 256-row blocks (`next_multiple_of(256)`, :3898), still doubling. The tile reads full 32-key pages. Rows past the visible keys are masked to −∞ before the exp, and they are finite (zero pad from `Tensor::zeros`, or stale K/V from rejected proposals), so 0 × row can never produce a NaN.
- **Partials workspace** (`3cba876`): `split_scratch` keeps one f32 partials + (max, sum) buffer pair per thread and device, grown to the largest request, instead of taking them from candle's pool per call. The pool is trimmed at every host sync, so every decode round used to re-create 32 buffers. Measured in §1.4: ctx8k −14.5% ms/round, identical output. `TH_ATTN_SPLIT_SCRATCH=0` is the A/B arm.
- **Pipeline cache per geometry** (`GeomCache` :316). The old process-global `OnceLock` baked the first caller's (nh, nkv, d, rp) into the kernels for every later geometry. That is latent in production (one model per process), but it made `mem6_admission_mode_never_changes_inflight_slot` (a tiny 2/1-head model) fail once the new 24/4-head split test ran first in the same test process ("in-flight slot A corrupted by B's admission", max|Δ| 6.3). The fast path is unchanged (a lock-free first slot).
- `TH_NO_ATTN_FUSED` and `TH_DEBUG_ATTN` are now read once (`no_attn_fused` qwen35.rs:1609, `debug_attn` attn_kernel.rs:358). They were read per attention layer per forward (review should-fix #4). `TH_PHASE_TIME` remains a per-forward read (not in this lane's files).
- **Probe.** `TH_BENCH_ATTN=1 th-engine probe --model x --tokens 1` loads no model (engine/src/attn_bench.rs; main.rs:189). `770ce23` adds `TH_BENCH_ATTN_QSCALE`, which scales q for the peaked-attention precision check (bench-only; no serving-path change).
- **Tests** (attn_kernel.rs tests): split policy, `split_for` routing, partition coverage, geometry cache, library compile (both p variants), and `split_attention_matches_single_pass`. The last covers both layouts, seq 1/3/8, page boundaries, 5 splits and determinism.

### 2.2 N3 kernel microbenchmark (TH_BENCH_ATTN, final hold 19:13, binary `d0ac219`)

Method: GPU timestamps, M5 Max 40-core, gpu-lock held, load 55–58. One call = one attention layer, and ×16 = one verify's 16 full-attention layers. "Cold": the bench rotates over per-layer caches, so the working set exceeds the SLC. max|Δ| is taken over the `[seq, 24×256]` bf16 output against the single-pass kernel and against an f64 CPU reference (checked here up to 32k).

- Production split count is `split_for`: 16 splits up to 4k keys, 32 from 8k (cap 32).
- The `d0ac219` bench printed 64/128 as its "policy" at 16k/32k: a bench-only labelling bug that ignored the cap, fixed in `8272b5a`. The rows below use the timing of the count the engine actually routes, the s32 column of the sweep.

**Engine layout (time-major, as the eager prefill leaves it), seq = 8, f32 probabilities (default):**

| L (keys) | single-pass ms/call | split ms/call (routed splits) | speedup | ×16 per verify, ms | max\|Δ\| split−single / single−ref / split−ref |
|---|---|---|---|---|---|
| 512 | 0.1975 | 0.0204 (16) | 9.7× | 3.16 → 0.33 | 0.00012 / 0.00065 / 0.00065 |
| 1450 | 0.5695 | 0.0373 (16) | 15.3× | 9.11 → 0.60 | 0.00024 / 0.00049 / 0.00049 |
| 2048 | 0.8127 | 0.0455 (16) | 17.9× | 13.00 → 0.73 | 0.00012 / 0.00024 / 0.00024 |
| 8192 | 3.2257 | 0.1285 (32) | 25.1× | 51.61 → 2.06 | 0.00012 / 0.00016 / 0.00016 |
| 16384 | 6.6080 | 0.2459 (32) | 26.9× | 105.73 → 3.93 | 0.00012 / 0.00011 / 0.00011 |
| 32768 | 13.0523 | 0.4647 (32) | 28.1× | 208.84 → 7.44 | 0.00012 / 0.00006 / 0.00006 |

**Head-major, f32 probabilities, seq = 1 (plain decode, padded tile) and seq = 8 (verify):**

| L | seq 1: single → split ms/call (splits) | seq 1 ×16 ms | seq 8: single → split ms/call (splits) | seq 8 ×16 ms | max\|Δ\| split−single (seq 1 / seq 8) |
|---|---|---|---|---|---|
| 512 | 0.2045 → 0.0178 (16) | 3.27 → 0.28 | 0.1944 → 0.0203 (16) | 3.11 → 0.32 | 0.00001 / 0.00049 |
| 1024 | 0.4159 → 0.0273 (16) | 6.65 → 0.44 | 0.4015 → 0.0294 (16) | 6.42 → 0.47 | 0.00012 / 0.00049 |
| 1450 | 0.5923 → 0.0359 (16) | 9.48 → 0.57 | 0.5671 → 0.0367 (16) | 9.07 → 0.59 | 0.00000 / 0.00012 |
| 2048 | 0.8288 → 0.0433 (16) | 13.26 → 0.69 | 0.8025 → 0.0446 (16) | 12.84 → 0.71 | 0.00024 / 0.00024 |
| 4096 | 1.6591 → 0.0744 (16) | 26.55 → 1.19 | 1.6102 → 0.0756 (16) | 25.76 → 1.21 | 0.00001 / 0.00012 |
| 8192 | 3.3257 → 0.1280 (32) | 53.21 → 2.05 | 3.2247 → 0.1293 (32) | 51.59 → 2.07 | 0.00006 / 0.00012 |
| 16384 | 6.6575 → 0.2424 (32) | 106.52 → 3.88 | 6.4598 → 0.2406 (32) | 103.36 → 3.85 | 0.00003 / 0.00006 |
| 32768 | 13.3454 → 0.4499 (32) | 213.53 → 7.20 | 12.9083 → 0.4639 (32) | 206.53 → 7.42 | 0.00006 / 0.00003 |

- Head-major seq=8 at L ≤ 384 is omitted. Those were the first points of the run (GPU clock ramping after the memory stage), and both kernels read 3× slower than in every other run; their earlier values are in `sec_micro.md` (0.0112 ms at L=128, 0.0130 at 256).
- **Peaked attention (q scale 6, the regime of real long-context heads), seq 8, head-major:**

| L | 512 | 2048 | 8192 | 16384 | 32768 |
|---|---|---|---|---|---|
| split−single | 0.00391 | 0.00781 | 0.00391 | 0.00391 | 0.00391 |
| single−ref | 0.00758 | 0.00780 | 0.00735 | 0.00781 | 0.00708 |
| split−ref | 0.00758 | 0.00780 | 0.00735 | 0.00781 | 0.00708 |

  split−ref equals single−ref at every L. The two kernels round the same computation differently, by 1–2 bf16 ulps at output magnitudes ≈1–2, and neither is less accurate against f64. (This run timed 64/128 splits at 16k/32k because of the label bug; more splits means more partial merges, so the precision result holds a fortiori for 32.)
- **Split-count sweep, seq 8** (ms/call, time-major; the routed count in bold): at 1450, s8 0.0476 / **s16 0.0373** / s32 0.0422 / s46 0.0542; at 8192, s8 0.2212 / s16 0.1435 / **s32 0.1285** / s64 0.1646 / s128 0.2063; at 16384, s16 0.2713 / **s32 0.2459** / s64 0.2724; at 32768, s16 0.5167 / **s32 0.4647** / s64 0.4687 / s128 0.5024.
  - 16–32 threadgroups per kv head fill the 40-core GPU. More splits only add partials traffic (splits × 196 KiB per call).
  - Default: 16 splits to 4k keys, 32 from 8k up. At 32k, 32 and 64 are within 1%.
- **Effective bandwidth** at 8k: 33.5 MB of K+V per layer in 0.1285 ms ≈ 261 GB/s. The whole 16-layer attention is ≈2 ms of a ≈48 ms round, so the remaining gap to ≈500 GB/s is worth ≈1 ms at 8k.

## 3. N4: `draft_attn_split` (commit `bc94adb`)

### 3.1 What changed

- **Kernel** (engine/src/draft_kernel.rs; MSL `draft_attn_split` :468, host fn :566; from `verify-numerics-N4-draftattn` @1738e0a):
  - There is one threadgroup per (kv head, row), 64 instead of `draft_attn`'s 8, with 4 × nsplit simdgroups. Simdgroup sg maps to (q head = sg & 3, key split = sg >> 2), and each runs an online softmax over its key slice.
  - The partials merge in threadgroup memory in split order (deterministic). Empty splits (`l == 0`) are skipped.
  - nsplit = 1 is `draft_attn`'s per-pair loop and epilogue, so its output is **bit-identical** (unit test `draft_attn_split_matches_single_pass` :56 at 5 ring/offset cases including wrapped windows; the probe checks 6 more). The split kernel is therefore the default at every ring length.
- **Policy** (`draft_nsplit_for` :20, `draft_attn_nsplit` :31, read once): splits = ceil((ring + 8) / 256) ≤ 8. That gives 1 split up to 248 committed keys (every bench-context round: base numerics), 6 at a 1450 ring, and 8 at the full 2048 window. `TH_DRAFT_ATTN_SPLIT=0` keeps the legacy `draft_attn` (the A/B arm), `=N` pins N; `TH_DRAFT_ATTN_KEYS` sets keys per split.
- **Port onto main** (1738e0a/dd28d2a conflicted in dflash.rs/engine.rs/main.rs). The prototype's per-call env reads are dropped: `TH_N4_MODEFILE` (a file read per call), `TH_DRAFT_SKIP_GATHER`, `TH_N4_FIXSHAPE`, and `TH_DRAFT_ATTN_SPLIT` per call. MEM-4 (main) already skips the dead ring gathers, and N1 (main) already reshapes the output to `[1, 8, 4096]` before o_proj. engine.rs needed no change.
  - **MEM-2.** The output buffer is uninitialised; split 0's simdgroups write every element.
  - `propose` and `propose_batch` both route through `DraftWeights::attention` (dflash.rs:496).
- **Probe.** `TH_BENCH_DRAFT_ATTN=1 th-engine probe --model x --tokens 1` (main.rs:181).

### 3.2 N4 kernel microbenchmark (TH_BENCH_DRAFT_ATTN, final hold 19:13, µs per call incl. encode, 200 reps)

| ring | draft_attn (8 TG) | split1 (64 TG) | split2 | split4 | split8 | policy (splits) | per propose (×5 layers), ms: old → policy |
|---|---|---|---|---|---|---|---|
| 0 | 24.1 | 7.2 | 6.2 | 6.8 | 8.9 | 7.2 (1) | 0.12 → 0.04 |
| 128 | 77.4 | 25.9 | 14.9 | 13.6 | 13.6 | 25.9 (1) | 0.39 → 0.13 |
| 248 | 116.4 | 44.2 | 24.9 | 22.1 | 21.0 | 44.2 (1) | 0.58 → 0.22 |
| 512 | 324.1 | 87.0 | 46.9 | 40.6 | 37.2 | 34.2 (3) | 1.62 → 0.17 |
| 1024 | 649.0 | 167.4 | 88.5 | 77.9 | 68.6 | 74.2 (5) | 3.25 → 0.37 |
| 1450 | 925.6 | 234.9 | 125.0 | 109.1 | 95.3 | 94.1 (6) | 4.63 → 0.47 |
| 2048 | 1617.2 | 434.1 | 222.5 | 153.0 | 136.2 | 136.2 (8) | 8.09 → 0.68 |

- Correctness (six ring/offset cases, including wrapped windows): max|Δ| against an f64 reference is identical for draft_attn and split1/2/4/8 at every case (0.00195 at ring 0 down to 0.00045 at 2048). **split1 is bit-identical to draft_attn**, which is why it is the default at every ring length ≤ 248.

## 4. Item 3: the "+2.4% cold-prefill regression" (G1a GDN prefill path)

**Verdict: not a real regression; no fix committed.** The +2.4% came from 6-vs-6 ctxcold medians in PHASEC s1. Three independent checks find no G1a prefill cost above ≈1%: PHASEC's own pooled data, a synced forward A/B across four builds, and an in-process A/B that removes the G1a conv carry. What moved is *where the host waits* (enqueue vs readback), not how long the prefill takes.

### 4.1 Re-analysis of PHASEC's own data (s1+s2, quiet machine, `$P/work/integration-2/bench/s1,s2`)

`th_stats.prefill_tps` is timed around the chunked `forward()` calls (engine.rs:504) with no sync. So `prompt_tokens / prefill_tps` is the host **enqueue** time of the three 512-token prefill forwards, and `ttft_ms − enqueue` is the **rest** (GPU drain + `draft_prefill` + first sample). Tool: `$W/bench/ttft_split.py`.

| build | mode | n | engine TTFT med [range] ms | enqueue med [range] ms | rest med [range] ms |
|---|---|---|---|---|---|
| integ `8d5b6d5` | ctxcold | 6 | 2455 [2358–2532] | **639** [613–659] | 1816 [1745–1901] |
| integ2 `521c6e0` | ctxcold | 12 | 2503 [2319–2553] | **708** [667–734] | 1794 [1637–1857] |
| integ `8d5b6d5` | ctx1500 | 18 | 2429 [2192–2695] | **639** [597–713] | 1771 [1594–2010] |
| integ2 `521c6e0` | ctx1500 | 36 | 2402 [2246–2705] | **692** [656–780] | 1716 [1585–1952] |
| main `cf3e5f7` | ctxcold | 6 | 2430 [2412–2465] | 654 [643–660] | 1784 [1756–1809] |

- ctx1500 is also a cold ≈1.45k prefill on th (no prefix cache), and there integ2 is *faster* by median.
- Means per request, both cold modes pooled: integ 2451 ± 140 ms (n=24), integ2 2476 ± 128 ms (n=48). Δ = **+25 ms (+1.0%), SE 34 ms**: not significant. Per-prompt mean differences range from −13 to +61 ms.
- The enqueue shift is robust: +53 ms (ctx1500) and +69 ms (ctxcold), with non-overlapping ctxcold ranges. A shorter rest offsets it (−55 / −22 ms).

### 4.2 Mechanism (code: candle 0.11 `metal/commands.rs`, `metal_backend/device.rs`)

- candle commits a command buffer every 50 `command_encoder()` calls (`CANDLE_METAL_COMPUTE_PER_BUFFER`, default 50).
- The queue comes from `newCommandQueue()`, so Metal caps uncompleted command buffers at 64, and `commandBuffer()` blocks the host at the cap.
- A 512-row prefill forward is ≈1000 dispatches (48 GDN layers × ≈13 + 16 eager attention layers × ≈28), i.e. ≈20 command buffers. A 3-chunk 1.45k prefill therefore sits at the cap.
- G1a adds one `gdn_conv_carry` dispatch per GDN layer per forward (48 per chunk, ≈+1 command buffer). The host reaches the cap earlier and waits inside `forward()` instead of in the final readback: enqueue grows, rest shrinks, and the sum is unchanged.
- G1a's prefill GPU work [D]:
  - the carry copies 3 × 10240 bf16 (60 KB) per layer, ≈48 tiny dispatches per chunk;
  - the scan is out of place but reads and writes 3 MiB per layer, exactly as the in-place kernel did (the same `gated_delta_step` body apart from the `state_out` binding);
  - `y` is allocated the same way (pooled `with_size_for`).
- Nothing else in `forward_inner` changed between 8d5b6d5 and 521c6e0 apart from the parity `begin()`/`flip()`.

### 4.3 Synced cold-prefill forward, four builds (hold P, 13:44–13:57, palindrome integ → g1a → base → new → new → base → g1a → integ)

`TH_BENCH_PREFILL=512,1440`: a fresh state per run, one forward over the whole prompt, and a synced last-row readback. Each cell holds 6 runs per routing, both T2 routings alternating in-process. The machine was heavily loaded (1-min load 30–72), so **min** is the contention-robust estimator.

| build | m=512 tiles min (run 1 / run 2) | m=1440 tiles min | m=1440 legacy min | m=1440 tiles med (run 1 / run 2) |
|---|---|---|---|---|
| integ `8d5b6d5` | 1179 / 1314 | 3308 / 3891 | 3372 / 3877 | 3646 / 4162 |
| g1a `a93f982` (8d5b6d5 + R0a + G1a) | 1204 / 1180 | 3556 / 4040 | 3360 / 3678 | 3704 / 4119 |
| base `521c6e0` (main) | 1297 / 1232 | 3336 / 3584 | 3364 / 3738 | 3456 / 4066 |
| new `bc94adb` | 1208 / 1312 | 3305 / 3515 | 3329 / 3642 | 3360 / 4074 |

- Best-of-both-runs at m=1440 (tiles, the production routing): integ 3308, base 3336 (+0.8%), new 3305 ms. g1a's tiles column is the outlier (3556); its legacy column (3360) is in line with the rest.
- Load explains the spread between runs of the same build (integ 3308 vs 3891) and dominates any build difference. No build is consistently slower.
- new = base at prefill, as expected: N3/N4 only change the seq ≤ 8 attention path and the draft attention, while prefill attention stays eager.

### 4.4 In-process A/B: G1a conv carry on vs skipped (hold Q, 15:27–15:31, probe `th/d-longctx-probe` `1c3d41f`)

`TH_BENCH_PREFILL_AB=carry TH_BENCH_PREFILL_CHUNK=512`: the server's 512-token chunking (1440 = 512 + 512 + 416). Runs alternate carry-on and carry-skipped (skipping the carry is timing-only, since the next chunk's conv window is then stale). 6 pairs plus warm-ups, a fresh state per run, 2 processes. Load 43–108, thermal level 2.

| m | rep | carry on: min / med ms | carry skipped: min / med ms | skipped − on (min / med) |
|---|---|---|---|---|
| 1440 | 1 | 3277 / 3383 | 3325 / 3538 | +48 / +155 |
| 1440 | 2 | 3351 / 3974 | 3411 / 4005 | +60 / +31 |
| 512 | 1 | 1080 / 1084 | 1070 / 1082 | −10 / −2 |
| 512 | 2 | 1089 / 1111 | 1093 / 1103 | +4 / −9 |

Removing the carry does not make the prefill faster, so it is not the source of any cost (resolution ≈1–2%). With §4.1–4.3, item 3 is closed without a code change. The real cold-prefill gap to Splash (1.95 vs 2.5 s at 1.45k) is prefill attention and matmul work (§7), not G1a.

## 5. Validation (final hold 19:06–19:44, binary `d0ac219`; `3cba876` re-gated in §1.4 with identical results)

Scripts `$W/bin/holdZ2.sh` → `gates_d.sh`. Logs are in `$W/logs/final2/gates-new/` and `gates-base/`; summary from `bin/gates_cmp.py`.

| gate | result |
|---|---|
| `cargo build --release` | **0 warnings** at every commit (the crate recompiles on each change; `cargo test --release --no-run` also clean) |
| unit tests (`th_engine-404afa4a59ca4dd5`, `d0ac219`) | **46/46 pass**. New tests: `split_count_policy`, `split_for_routes_by_threshold`, `split_library_compiles`, `split_attention_matches_single_pass` (GPU: both layouts, seq 1/3/8, page boundaries, 1/5/policy splits, bitwise reruns), `geom_cache_keys_by_geometry`, `split_partition_covers_pages_once`, `draft_attn_split_matches_single_pass` (split1 bit-identical, 5 ring/offset cases), `draft_nsplit_policy`, `causal_mask_values_and_cache` |
| R0a `TH_TEST_ROLLBACK=1 TH_BATCH=2` (18-token prompt) | **PASS, rc 0**: state-bitwise at kept=1..8, slot isolation, legacy logits PASS (argmax 68/68/68) |
| same with `TH_ATTN_SPLIT_MIN=1` (split kernel at every length, including stale finite rows past kv_tokens) | **PASS, rc 0** |
| same with `TH_GDN_COMMIT=step` (discrimination arm) | **FAIL, rc 1**, as intended |
| same on a **1450-token prompt** (fixed passage ids; split kernel in verify, `rollback_verify` and the continuous forward) | **state-bitwise PASS, rc 0** (rec≠ref 0 / 37.7M and conv≠ref 0 at every kept) |
| legacy logits check, 1450 prompt | per-position max\|Δ\|: kept=1 0.2188 (the m=1 vs m=8 shape rounding of K7's route; 0.125 at short context), kept=4/7/8 **0.0000**. Its PASS/FAIL line prints "FAIL (argmax ref=68 rb=13)" because it compares the argmax of the kept=4 reference (pos+4) with the worst case's logits (kept=1, **pos+1**), two different positions. This is a check artefact, not a rollback error: main.rs's legacy verdict should compare same-position argmaxes (a 1-line fix, left to main.rs's owner) |
| TH_BATCH=2 `--draft`, short pairs (`batch2_client.py`: warm-up, T=0 pairs, sampled pairs, N2 mixed pairs) | **13/13 HTTP 200**, max trigram-repeat 0.098 |
| TH_BATCH=2 `--draft`, long pairs (`batch2_long.py`: 1.45k T=0 pair ×2, a sampled 1.45k pair, an 8k T=0 pair; N3 in `forward_batch`, N4 in `propose_batch`) | **9/9 HTTP 200**. The T=0 repeats are identical (long `91a6e28ec7` and code `155e1756f2` in both, the same shas as the single-slot ctx1500 texts). 8k pair OK. Max trigram-repeat 0.085 |
| `--kv-quant --draft` single slot (1.45k T=0 ×2, short T=0, 1.45k sampled) | **4/4 HTTP 200**. The **3 T=0 texts are byte-identical to base**: TurboQuant slots stay on `attn_quant`. The sampled text differs from base at char 150 (N4 changes proposals, so the speculative-sampling path changes; the distribution does not) |
| no draft, single slot (plain decode: 1.45k T=0 ×2, 8k T=0, short T=0; seq=1 split path) | **4/4 HTTP 200**; **all 4 byte-identical to base** |
| server logs (b2, kvq, nd) | 0 panics, 0 WARN, 0 ERROR |
| memory guard | `fpguard.py` over every lane binary: the only kills were the two intended memory arms (§6) |
| per-call env reads | none added. The knobs are read once: `TH_ATTN_SPLIT*`, `TH_DRAFT_ATTN_SPLIT/KEYS`, `TH_PREFILL_SYNC`, `TH_ATTN_SPLIT_SCRATCH`. `TH_NO_ATTN_FUSED` / `TH_DEBUG_ATTN` moved from per-layer to once |
| MetalStorage clone-escape class | none. Every new output is `kernel_out` / `Tensor` / pool `new_buffer`; the scratch holds pool buffers by `Arc`, which is never aliased into a new `MetalStorage` |
| `/status`, `th_stats` | unchanged (no fields added or removed) |

**T=0 identity against base (session §1.3; after `</think>` normalisation, re-tokenised divergence index):**

| mode | short | code | long |
|---|---|---|---|
| greedy (bench prompts) | identical | identical | identical |
| ctx1500 | identical | identical | identical |
| ctxcold | identical | diverges at token #122 / 128 | diverges at #15 |
| ctx8k | identical | diverges at #30 | diverges at #19 |

- Each engine is text-identical across its own two arms.
- The four divergent texts are identical to those from the previous session's `bc94adb` binary (sP, 14:00). ctxcold/code's new text equals the Phase B integration build's text.
- These are near-ties under a 1–2-ulp attention change (§1.1 numerics), not a drift.

**Sampled pass (seeds 1/3/5, 0.6/0.95/20):** new1 50.78 ms/round vs base 51.07 / 51.50 at 3.590 tokens/round in all arms. At bench context N3 is not routed and N4's one split is bit-identical, so the sampled trajectories are the same.

## 6. Long-prompt memory: the 16:03 reboot, an 18:25 near-miss, and two fixes (`a5b911f`, `d0ac219`)

### 6.1 What happened

- **16:03 reboot.** The previous session's hold Q ran `TH_BENCH_ROUND=16384,32768` (probe `617f651`) after the 128..7900 arms.
  - L=16384 completed (prefill 92 s, `$W/logs/probeQ/round_long.log`). The 32768 prefill started ≈15:39 and was still running 20 minutes later.
  - 15:59:12: WindowServer userspace watchdog timeout (`/Library/Logs/DiagnosticReports/WindowServer-2026-09-26-155912.ips`: "40 seconds since last successful checkin"). The machine rebooted at 16:03.
  - The stackshot shows the probe process at **130.9 GB resident** on this 128 GB machine, with 401 s of system time. Machine-wide: 7.19 M wired pages (**117.8 GB wired**), 19.7 k free pages, 55.9 M swap-outs.
- **18:25 near-miss (this session).** The first final hold (`holdZ.sh`) started a memory probe on `a5b911f`: a server with the causal-mask fix, sending one T=0 request each at 2k/4k/8k/16k/24k prompt tokens.
  - 2k, 4k, 8k and 16k completed. TTFT was 3.4 / 12.0 / 28.5 / 87.6 s.
  - During the 24k prefill, `footprint -p` read **Footprint: 119 GB**: 100 GB "Owned physical footprint (unmapped) (graphics)", i.e. candle's *private* Metal pool, plus 18 GB IOAccelerator (weights).
  - Machine state at that point: 5% memory free, 7.33 M wired pages (120 GB), swap 58.7 of 60.4 GB. I SIGKILLed the server by hand and memory recovered to 71% free within seconds. The hold was aborted before any other stage ran.
  - **The RSS watchdog I had added (`memcap.sh`, the holdZ guard) never fired: `ps` RSS read 4.2 GB.** candle 0.11 allocates op outputs from a StorageModePrivate pool (`MetalDevice::new_buffer`, candle-core `metal_backend/device.rs:205-228`), which RSS does not count.
- All watchdogs now read **phys_footprint** through `proc_pid_rusage(RUSAGE_INFO_V2)`. `$W/bin/fpguard.py` checks every `$W/bin/th-engine*` process every 0.25 s and SIGKILLs above the cap. It was validated against `footprint -p` on the :8001 server (read-only: 20.3 GB both ways; ps RSS 9 MB).

### 6.2 Mechanism

- candle frees pooled buffers only at a host sync (`drop_unused_buffers`, device.rs:131, from `wait_until_completed` / `flush_and_wait_current`). Every buffer it allocates is also inserted into a `MTLResidencySet`, so the pool is wired: it cannot be paged out, and the rest of the system starves instead.
- The chunked prefill never syncs between chunks. That covers engine.rs:504 (single slot) and :1511 (batched admission), plus the `TH_BENCH_*` probes.
- Growing buffers in the eager (seq > 8) attention, per layer per 512-row chunk:
  - the host-uploaded causal mask: always a fresh buffer (`new_buffer_with_data`);
  - the `[24, 512, kv]` scores/affine/masked/softmax chain;
  - the `[24, kv, 256]` K/V broadcast copies and the transposed contiguous K.
- These grow with kv and are rounded up to power-of-two buckets. `find_available_buffer` hands any free bucket ≥ the request to it, so small long-lived tensors can hold large buckets. The high-water mark therefore climbs roughly quadratically with the prompt length. The footprint table below measures it.

### 6.3 Fixes

1. **`a5b911f`: one causal mask per forward.** `causal_mask()` (qwen35.rs) builds the `[seq, kv_seq]` mask once per (seq, pos, kv_seq, dtype, device) in a thread-local cache. All 16 attention layers share it through a view reshape. The values are the same, so output is unchanged; unit test `causal_mask_values_and_cache`.
   - Mask garbage per prefill drops from 16 × Σ_c(1 MiB × (c+1)) (2.1 GiB at 8k, 19.7 GiB at 24k, 32.5 GiB at 32k) to Σ_c(1 MiB × (c+1)) (136 MiB at 8k, 2 GiB at 32k) [D].
   - It also removes 15 of every 16 mask uploads (fresh wired buffer plus residency-set commit) per prefill chunk, and per decode round on `--kv-quant` slots (`attn_quant`).
   - **Necessary, not sufficient:** the 24k near-miss ran with this fix.
2. **`d0ac219`: trim the pool between long-prompt prefill chunks.** A prefill forward (seq > 8) starting at pos ≥ `TH_PREFILL_SYNC` (default 2048, read once) first calls `device.synchronize()`, so garbage is bounded to about one chunk's working set.
   - Prompts up to 2048 + one chunk never sync, so the bench contexts and ctx1500 are unchanged. `=off` disables it; `=N` sets the threshold.
   - A sync only waits, so output is unchanged. The cost is one host-encode bubble per chunk (≈10–30 ms against a ≥ 1 s chunk at ≥ 4k context).

**Measured (final hold 19:06–19:13, load 34–57, thermal 2).**

- **Method:** one server per arm (`--draft`, :8041), one T=0 request per prompt length in sequence (the passage prefix, repeated past 7853 tokens), max_tokens 4. phys_footprint is sampled every 0.25 s by `fpguard.py`, which also SIGKILLs above 48 GB. Logs: `$W/logs/final2/mem-*/`, `fp/`.
- **Cells:** peak GB (increment over the footprint just before that request), then TTFT. Every arm starts at 19.8 GB idle after load.

| prompt tokens | base `521c6e0` | new with `TH_PREFILL_SYNC=off` (mask fix only, = `a5b911f`) | **new `d0ac219`** (mask fix + pool trim) |
|---|---|---|---|
| 4k (4066) | 23.7 (+3.9) · 12.0 s | 23.8 (+4.0) · 12.6 s | 23.2 (+3.4) · 12.3 s |
| 8k (8218) | 38.2 (+17.3) · 29.9 s | 36.0 (+12.3) · 30.1 s | **29.6 (+7.2)** · 30.4 s |
| 12k (12268) | **killed at 48.0 GB** mid-prefill | **killed at 48.5 GB** mid-prefill | **37.8 (+12.9)** · 56.7 s |
| 16k (16380) | — | — | **42.6 (+14.1)** · 89.0 s |
| 24k | — | 119 GB at 18:25 (killed by hand; machine at 5% free, swap 58.7 / 60.4 GB) | not run |

- **The mask fix alone** cuts the 8k increment by 5.0 GB (17.3 → 12.3). **The trim** cuts it by another 5.1 GB, and turns 12k from over 48 GB into 37.8 GB.
- **TTFT** is the same within noise: 8k 29.9 / 30.1 / 30.4 s, 4k 12.0 / 12.6 / 12.3 s.
- **Between requests the server keeps some of the growth:** the pre-request footprint drifts 19.8 → 22.4 → 24.9 → 28.5 GB across the four requests of the trimmed arm (grown KV-cache capacity plus buffers still live at the last sync).
- **Extrapolation, trimmed build [E]:** the increment grows ≈0.9 GB per 1k tokens past 4k, so ≈50 GB at 24k and ≈55–60 GB at 32k. It stays bounded (roughly linear, no longer quadratic), but it is not small, which is why the prefill kernel is item 1 of §7.

### 6.4 What is left

- The eager prefill attention is O(L²) in time and allocates `[24, 512, kv]` transients per layer; at 16k it takes 88 s. The real fix for long-prompt TTFT *and* memory is a prefill attention kernel with split keys (the N3 tile generalised to 512-row query blocks), or at least key-blocked eager attention. That is the next long-context lever (§7).
- Long-lived small tensors can still hold large pool buckets within a chunk (captures, K/V `cat` outputs). With the trim this is bounded per chunk, not per prompt.
- **Operational rule for this lane:** every long-context process runs under `fpguard.py` (phys_footprint). In-model probes stay at ≤ 7900 keys. 16k–32k attention is covered by the no-model kernel bench, and the 16k server request runs under the 48 GB guard.

## 7. What is left for long context, ranked

1. **Prefill attention kernel (TTFT and memory).**
   - Cold prefill is O(L²) eager attention with materialised `[24, 512, kv]` scores/probs per layer per chunk: TTFT 12 s at 4k, 30 s at 8k, 57 s at 12k, 89 s at 16k [M, §6; load 35–57]. PHASEC quiet: 2.5 s at 1.45k vs Splash 1.95 s.
   - Those transients are also most of the long-prompt pool growth that §6 bounds but does not remove.
   - The N3 tile generalises directly: M = 512 query rows per kv head (a 3072-row tile over the 6-head group), split keys, fixed-order reduce, online softmax, with no score materialisation. Expected: prefill attention ≥ 10× faster at ≥ 4k [E] and footprint growth near zero.
   - Files: attn_kernel.rs + qwen35.rs `attn_forward` (the eager branch).
   - Together with prefix caching (th/d-prefix-cache), this is the largest remaining user-visible long-context gap.
2. **Default `TH_ATTN_SPLIT_MIN`: 256 → 64–128.** Measured ≈0.5–0.7 ms/round at 128–192 keys (§1.2), ≈1–1.5% at bench context. It changes bench-context T=0 numerics, so it needs a fresh identity baseline; left for the orchestrator to decide.
3. **Split kernel bandwidth.** 261 GB/s at 8k (f32 probabilities) against ≈500 achievable. That is worth ≈1 ms/round at 8k and ≈4 ms at 32k. Options:
   - bf16 probabilities (`TH_ATTN_SPLIT_P=bf16`: −25% split time, but 2–4× the deviation);
   - a wider page, or a K/V double buffer in threadgroup memory.
4. **Legacy logits verdict in `TH_TEST_ROLLBACK`** (main.rs, the owner's file). Compare the argmax at the same position. At long prompts it prints a spurious FAIL (§5); the state-bitwise gate, which sets the exit code, is unaffected.
5. **Candle pool fragmentation** (§6.4): small long-lived tensors grab large free buckets. If long prompts stay on the eager path, a per-attention-layer trim (sync) at pos ≥ 8k would bound the pool to one layer's working set, at ≈1% TTFT [E].

## Appendix A: reproduce

```sh
P=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC; W=$P/work/th-d-longctx
WT=$($P/bin/wt-bootstrap th/d-longctx)                        # .worktrees/th/d-longctx, from main 521c6e0
(cd $WT/engine && cargo build --release && cargo test --release --no-run)   # 0 warnings
# frozen in $W/bin: th-engine-new-d0ac219 (e30c570a…) + th-engine-tests-new-d0ac219 (ec1ea409…),
#   th-engine-new-3cba876 (e361f0e4…) + th-engine-tests-new-3cba876 (1b74e686…),
#   th-engine-base-521c6e0 (66e99644…, = main), th-engine-probe-round2 (c1732a05…, th/d-longctx-probe @5090f18)
$P/bin/gpu-lock -- bash $W/bin/holdZ2.sh     # final hold (log $W/logs/holdZ2.out, data $W/logs/final2/, session $W/bench/sZ/):
#   guard  python3 $W/bin/fpguard.py 48 OUT/fp            phys_footprint watchdog (NOT ps RSS) over $W/bin/th-engine*
#   0. $W/bin/memprobe2.sh OUT BIN "4096 8192 12288 16384" FPDIR [TH_PREFILL_SYNC=off]   server prefill footprint per L
#   1. TH_BENCH_ATTN=1 [TH_BENCH_ATTN_TM=1] [TH_BENCH_ATTN_QSCALE=6] TH_BENCH_ATTN_REF_MAX=32768 th-engine probe --model x --tokens 1
#      TH_BENCH_DRAFT_ATTN=1 th-engine probe --model x --tokens 1                          (no model load)
#   2. $W/bin/gates_d.sh OUT NEW full TESTBIN ; $W/bin/gates_d.sh OUT BASE base
#   3. TH_BENCH_ROUND=128,512,1450,2048,4096,7900 TH_BENCH_ROUND_ITERS=12 TH_BENCH_ROUND_DRAFT=$DRAFT \
#        TH_BENCH_ROUND_IDS=$W/bench/passage8k.ids th-engine-probe-round2 probe --model $TGT --tokens <18 ids>   (x2)
#      TH_ATTN_SPLIT_MIN=1 TH_BENCH_ROUND=128,192,256 ...                                   (N3 below threshold)
#   4. $W/bench/session_d.sh $W/bench/sZ "base1:th-base:BASE new1:th-new:NEW new2:th-new:NEW base2:th-base:BASE"
$P/bin/gpu-lock -- bash $W/bin/holdS.sh      # scratch hold: gates on 3cba876 + in-binary A/B TH_ATTN_SPLIT_SCRATCH=0 vs default ($W/bench/sS)
PY=~/.local/share/uv/tools/headroom-ai/bin/python                   # has `tokenizers` (re-tokenized divergence index)
$PY $W/bench/analyze.py $W/bench/sZ md ; python3 $W/bench/phases.py $W/bench/sZ
python3 $W/bench/round_tables2.py $W/logs/final2/round1.log,$W/logs/final2/round2.log
python3 $W/bench/micro_tables2.py $W/logs/final2 ; python3 $W/bin/gates_cmp.py $W/logs/final2/gates-new $W/logs/final2/gates-base
```

- Harness: bench-quiet's client (`bq_client.py`), plus a **ctx8k** mode.
  - greedy 3×3; sampled at seeds 1/3/5; ctx1500 3×3 on the 1373-token passage (sha1 `a886db14acc4`); ctxcold 3.
  - ctx8k is `passage8k.txt` + "\n\n" + bench prompt, T=0, 128 tokens, 1 per prompt per arm. `passage8k.txt` is sha1 `6ab8ad9a056a`, 7853 Qwen3.8 tokens: tag-stripped prose of the two blog posts + `docs/docs/index.html` + README.md at 521c6e0, cut at a sentence boundary by `bench/mkpassage8k.py`.
- `session_d.sh` is session.sh with arbitrary `label:engine:bin[:env[:modes]]` arms on :8041. It applies the thermal-0 / CPU-idle / GPU-quiet gates (after the wait limit it proceeds and records the state), and records per-request ioreg GPU ms, ps CPU ms, log offsets, load and thermal state.
- Item 3: `$W/bin/prefill1.sh` (hold P, 13:44, `TH_BENCH_PREFILL=512,1440`, palindrome over 4 builds) and holdQ §1 (15:27, carry A/B, probe `1c3d41f`).

## Appendix B: cleanup and side effects

- **Processes.** Every th-engine server or probe of this lane ran from `$W/bin/` on :8041, or as an in-process probe. Each was stopped by its script: SIGTERM, then KILL, with an EXIT trap. The phys_footprint guard ran for the whole of each hold and was killed on exit. Intended guard kills: two memory-arm servers at 48.0 / 48.5 GB (§6).
- **Aborted hold.** The first final hold (`holdZ.sh`, 18:14) was aborted at 18:25: I SIGKILLed its 119 GB server by hand and TERM/KILLed the hold script and the memory probe. Memory recovered to 71% free within seconds, and the lock passed to the next lane.
- **Untouched:** :8001 (pid 71621, the app-attached th-engine) and :8000 (Splash was not used in this lane).
- **After the last hold:** no process of this lane is left, :8041 is free, and `/tmp/th-engine-gpu.lock` was released on exit.
- **The 16:03 reboot** happened during the previous session of this lane: the 32k in-process probe (§6.1). Other lanes' processes died with it. The later lanes' logs show they re-queued.
- **Git:**
  - Branch `th/d-longctx` holds 7 commits on `521c6e0`, all with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - The probe branch `th/d-longctx-probe` holds 4 probe commits on `bc94adb` (not for merge).
  - Nothing was pushed, nothing was committed to main, and the main working tree was never edited, built or reset.
  - To remove: `git worktree remove .worktrees/th/d-longctx-probe && git branch -D th/d-longctx-probe` (and the same for `th/d-longctx` once merged or abandoned).
- **Work dir** `$W`: frozen binaries (~16 MB each) and logs. Safe to delete after review.
