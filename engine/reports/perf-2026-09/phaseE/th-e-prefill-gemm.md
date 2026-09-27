# th/e-prefill-gemm — prefill Q4 GEMM rate (E1)

Written 2026-09-27 by the th/e-prefill-gemm agent. Tags: [M] measured, [D] derived, [E] estimate.

- **Branch** `th/e-prefill-gemm` (worktree `/Users/benebsworth/projects/token-horizon/.worktrees/th/e-prefill-gemm`), from `main` @`e452a7b`, **head `73fe6ab`** (5 commits, 5 files, +1006/−44). Clean tree, not pushed. main, the main working tree, :8000 and :8001 (pid 78860) were never touched.
- **Work dir** `$W = /Users/benebsworth/projects/token-horizon/.worktrees/_phaseC/work/th-e-prefill-gemm/`: `bench/` (session scripts, clients, analysis), `harness/` (standalone GPU-timestamped Metal microbench), `bin/` (frozen binaries), `logs/` (sessions `s0`, `s1`, `all1`, `fin1`, `fin2`, builds; `*/analysis/*.md` = tabulated results).
- **Hardware / model** M5 Max 40c, 128 GB; Qwen3.8-27B-4bit + DFlash draft. Private port **:8053**; every GPU run inside `$P/bin/gpu-lock`. A foreign ML job (pid 8947, ~390 % CPU, 22 h) plus VMs kept load1 at 9–40 all day; thermal pressure 0–2.

| binary (`$W/bin/`) | commit | sha256 prefix | used in |
|---|---|---|---|
| `th-engine-base-e452a7b` | main `e452a7b` (= `report/integration-3`) | `eb3497fbb194857e` | every A/B |
| `th-engine-e1b-a24f939` | E1(b) | `55dcde9eac5d5e86` | s1 (sweep, logits) |
| `th-engine-e1-5118982` (+ tests `56c4ec970fb10e82`) | E1(b)+(c on)+(d) | `8a527b1afa1cbe3e` | all1 (in-process A/B, gates, server A/B) |
| **`th-engine-fin-73fe6ab`** (+ tests `2c86da428ad6c39d`) | **final head** (presum opt-in) | **`9b4fc684d5c89042`** | fin1 (final gates, profiled A/B, 8-arm A/B, batching diagnostic, logits), fin2 (fresh vs after-decode 8-arm A/B) |

## 0. Summary

1. **Paying, default on — E1(b) vectorized-epilogue prefill tile for m > 128** (`a24f939`). Long-prompt chunks ran the legacy `AffineQmppPrefill` (pad copy + one-threadgroup-per-32-rows serial sums pass + 32×256×8 tile with a scalar per-element epilogue + a narrow copy for GDN in_all). They now run `r32n128s4+v`: the same MMA with an epilogue that uses the cooperative tensor's runs of 4 columns (one 8-byte scale load, one 8-byte bias load, one row sum per run per quant group), a parallel sums pass, no pad/narrow copies. **Output bitwise equal to main** (unit test, sweep Δ = 0 on every shape, logits byte-identical, T=0 streams and prefix-cache gates identical — §8).
   - Kernel [M, harness, GPU timestamps]: gate 17408×5120 @M=1024 **3327 → 3085 µs (−7 %)**, down 5120×17408 **3885 → 3242 µs (−17 %)**, out/o 5120×6144 @M=512 **743 → 559 µs (−25 %)**; **91 % of the MMA-only ceiling** (2809 / 2979 / 510 µs; 61–65 TFLOPS int4×bf16).
   - In-engine sweep [M, real weights, GPU busy] at M = 512: gate_up −3 %, down −21 %, in_all −16 %, GDN out −28 %, qkv −12 %, attn o −21 % ⇒ ≈ −81 ms (−12 %) of Q4-GEMM time per 512-row chunk [D].
   - **Whole forward [M, in-process, alternating, GPU busy]: −4 to −8 % at 512–1415 rows**, two sessions: m=512 797 → 743 ms (min), 1008 → 946; m=896 1470 → 1398, 1835 → 1787; m=1415 2482 → 2468, 3073 → 2825; m=1024 −9 %, m=2048 −4 %.
   - **Server, profiled per region [M, fin1, final binary, palindrome base fin fin base, same prompts]: Q4 GEMMs 1928 → 1606 ms at 1.45k (36.6 → 43.9 TFLOPS in situ) and 10369 → 8672 ms at 7.9k (37.2 → 44.5 TFLOPS); prefill 2808 → 2443 ms (−13 %) and 21209 → 19276 ms (−9 %); every final request beat every base request.** Normalised by the unchanged regions (attention / GDN ran 2–5 % faster in the final arms): GEMMs −12 % / −14 %, whole prefill −8 % / −7 % [D].
   - **Server, default batching, profiled pair [M, fin1 s6]:** cold 1.45k TTFT 2597 / 2851 / 2757 → 1991 / 2338 / 2276 ms and GPU busy −17 to −23 %; 7.9k 20316 → 17176 ms (−15 %). The GPU is ≈ 94 % busy during these prefills, so TTFT tracks GPU time.
   - **Server, unprofiled cold TTFT [M, s3 + s5 + s7: 20 fresh-server arms in three palindromes, 66 position-matched pairs]: 1.45k −119 ms pooled (95 % CI −197..−45), median −26; −44 ms (−99..+10) without one slow base arm. 7.9k: s7 −1971 ms (4/4 pairs faster, −9.5 %), pooled median −648 ms.** Per-arm means of ONE binary spread ±7 % on this host (other GPU clients 8–25 % of the GPU, load1 12–31, 36 GB swap in use), so the unprofiled end-to-end gain (≈ −2 to −5 % at 1.45k) is smaller and noisier than the GPU-attributed −8 to −13 %; s7 found no regime in which the final binary is slower (fresh server −321 / after decode −253 ms, §9.5).
2. **Not paying → opt-in — E1(c) prefill presum blocks** (`792127e` + `73fe6ab`): the RMSNorm producers and the up·silu pass emit the next projection's input sums (the K45 idea for prefill rows). Bitwise; removes a pf_prep pass that costs 25 µs (K=5120) / 80 µs (K=17408) per call at m=1024 (≈1 % of a forward) — but the in-process A/B could not tell it apart from vec-only (§6). **`TH_PF_PRESUM=1` enables; default off.**
3. **Chunk size (E1(d)) — keep 512.** 256 ties, 1024 is +8–12 % slower, one 1415-row chunk +12 %: the GEMMs are compute-bound and row-parallel from M ≈ 256, and the eager attention wastes the masked triangle on bigger chunks. Last-token logits are bitwise identical for every chunk size. Revisit once a fused causal prefill attention lands (th/e-prefill-attn).
4. **Tried and dropped** (numbers in §3/§5): 64-row tiles (spill / below 32×128×4), 32×128×8 and 32×256×8 (slower), **double-buffered K loop (−9 % vs the vec tile)**, de-duplicated epilogue loads (tie), two-stream fused gate/up (2.8–3× slower in situ, spill), a half (fp16) A operand (MMA-only 2892 vs 2873 µs: no faster), split-K on the large-M route (ties at best), 16-row tiles at M ≥ 256.
5. **Gates (run on `5118982` in all1 AND on the final `73fe6ab` in fin1, same results):** unit 82 passed / 0 failed / 1 ignored (4 new tests); `TH_TEST_ROLLBACK` rc 0 ×3 (TH_BATCH=2, TH_BATCH=1, 1450-token prompt; the 1450-token legacy-logits "FAIL rb=13" line is printed identically by base); TH_BATCH=2 smoke all 200, T=0 reproducible (integration-3's shas); prefix cache hit == miss **42/42 texts · 42/42 round logs**; pc_on / pc_miss / pc_off vs integration-3's own gate arms **42/42 · 42/42 each**; **final-vs-base logits byte-identical** (1415-token prefill); T=0 identity **36/36 × {greedy, ctx1500, ctxcold}** (all1), **144/144 greedy + 96/96 ctxcold** (fin1 s5), **144/144 greedy + 48/48 + 48/48 cold** (fin2 s7); 0 panic / WARN / ERROR in every server log. Decode: the m ≤ 8 decode path is code-identical, the profiled decode rounds run the same 38 kernels with identical counts (GPU busy/round 42.8 base vs 41.9 final); server ratio of sums +0.36 % (all1), +3.5 % (fin1 s5, every component incl. host encode rose with host load) and −4.1 % (fin2 s7) — **pooled 43.84 → 43.73 ms/round (−0.2 %, 2100 rounds per label)**: unchanged.
6. **Where the long-prompt time still goes / next levers** (§10): on main the Q4 GEMMs were 69 % of the 1.45k prefill GPU time (eager attention 24 %) and 49 % at 7.9k (attention 46 %); with E1 they are 66 % / 45 % (attention 26 % / 50 %). The vec tile sits at 91 % of the MMA ceiling in isolation, so the next GEMM gains are in-situ effects (sustained clocks, dispatch shape), not the tile; the big remaining levers are the fused prefill attention (other lane), the sequential `gated_delta_step` scan (145 ms @1.45k, 750 ms @7.9k), the checkpoint/KV-capacity costs (th/e-ttft-regression) and, after fused attention, larger chunks (Splash prefills up to 2048 rows per batch).

## 1. Commits (`git log e452a7b..th/e-prefill-gemm`)

| sha | item | default | what |
|---|---|---|---|
| `9261593` | (a) tooling | — | `gpuprof::drain_busy_ms()`; `TH_BENCH_LIN=pf` and `TH_BENCH_PREFILL` time trials by GPU busy time under `TH_GPU_PROF=1`; probe `TH_TOKENIZE=<file>` (server rendering) |
| `a24f939` | **(b)** + (a) | **on** | `pf_vtile` vectorized-epilogue tile (`*_vpl` / `*_vus`), load-time cooperative-tensor layout probe (`PF_VPROBE`, `pf_vec_layout_check`), m > 128 → `r32n128s4+v` (`pf_policy_large`); `TH_PF_LARGE=0` = legacy op, `TH_PF_LARGE=<label>` forces a tile; sweep adds `+v` candidates; `TH_BENCH_PREFILL_LARGE_ONLY`; tests `pf_vec_matches_legacy_bitwise`, `pf_vec_layout_check_accepts_runs_rejects_others`, `pf_policy_large_table` |
| `792127e` | (c) | (was on) | prefill presum blocks: `AddRmsNorm { pfsums }` (`add_rmsnorm_pfsums_p`) and the up·silu pass (`AffineQpf { emit }`, `*_vuse`) emit the vec tile's input sums; `AffineQpf { presum }` skips `pf_prep`; test `pf_presum_chain_matches_prep_bitwise` |
| `5118982` | (d) tooling | — | `TH_BENCH_STEPS` probe (prefill chunk size A/B in one process) |
| `73fe6ab` | (c) | **off** | `TH_PF_PRESUM=1` opt-in (non-paying at the noise floor) |

Knobs (all read once via `OnceLock`): `TH_PF_LARGE`, `TH_PF_PRESUM`; bench-only env reads live in `probe`. No `/status` or `th_stats` fields changed. New Metal buffers are fresh allocations (`new_buffer_builder`); no `MetalStorage::new(existing.clone())`. Release build and release test build: **0 warnings** (`logs/build/fin_release.log`, `fin_tests.log`).

## 2. Where prefill time went on main (s0, `TH_GPU_PROF=1 CANDLE_METAL_COMPUTE_PER_BUFFER=1`, cold nonce prompts)

Server on :8053, base e452a7b; per-region GPU-exclusive ms from the R0c profiler (`logs/s0/prof.server.log`, `bench/prof_window.py`, `bench/prof_ab.py`). Load1 13–16, thermal 0. [M]

| region | 1459 tok ms | share | in-situ TFLOPS | 7929 tok ms | share | in-situ TFLOPS |
|---|---|---|---|---|---|---|
| mlp.gate_up (64 layers, two passes) | 700.7 | 30 % | 47.5 | 3700.4 | 21 % | 48.9 |
| mlp.down | 425.1 | 18 % | 39.2 | 2366.8 | 13 % | 38.2 |
| gdn.in_all (48) | 276.2 | 12 % | 42.8 | 1429.8 | 8 % | 44.9 |
| gdn.out (48) | 108.6 | 5 % | 40.6 | 602.7 | 3 % | 39.7 |
| attn.qkv (16) | 76.3 | 3 % | 44.9 | 394.6 | 2 % | 47.2 |
| attn.o (16) | 36.4 | 2 % | 40.4 | 200.2 | 1 % | 39.9 |
| **all Q4 GEMMs** | **1623.3** | **69 %** | **43.8** | **8694.5** | **49 %** | **44.4** |
| attn.core (eager attention) | 563.3 | 24 % | — | 8240.5 | 46 % | — |
| gdn.core (conv + qk-norm + sequential `gated_delta_step` + gate-norm) | 144.8 | 6 % | — | 750.2 | 4 % | — |
| norms, embed, lm_head, rest | ≈ 24 | 1 % | — | ≈ 140 | 1 % | — |
| **prefill GPU busy** | **2358.4** | | | **17819.0** | | |

- Every m > 128 chunk ran the legacy `AffineQmppPrefill`: (1) `affine_q4_mpp_pad` copies all of x into a 32-row-padded buffer (even when m % 32 == 0); (2) `affine_q4_mpp_pf_sums`, one threadgroup per 32 rows, serial over K/64 quant groups (122 µs at K = 5120, 490 µs at K = 17408 per call at m = 1024, §3); (3) the 32×256×8 tile, whose epilogue computes a 64-bit parameter index and two scalar bf16 loads per accumulator element per quant group; (4) a narrow + contiguous copy when out % 256 != 0 (GDN in_all, `copy2d_bf16` 114 µs/call at 1.45k). (2) and (3) are Splash's own prefill kernels (`docs/splash/runtime/metal/kernels/prefill/linear_q4.metal`: `prefill_linear_q4_sums32` + `q4_mpp_prefill_tile`; Splash pads its row arena instead of copying).
- Synced per-chunk wall (`TH_DEBUG_PREFILL`): [0,512) 684–820 ms, [512,1408) 1303–1624 ms; at 7.9k the 512-row chunks grow from 741 ms to 1611 ms with position (eager attention).
- The in-process wall-clock kernel sweep (main's host timing) drifted ±40 % between identical kernels on this loaded machine — hence GPU-timestamped tools (§3, `9261593`).

## 3. Kernel study — standalone GPU-timestamped harness (`$W/harness/`)

`bench.swift` / `gubench.swift` compile the engine's Metal source at runtime, lay out tiled Q4 weights exactly as `QLin::tiled` (weights/scales shared storage, activations/sums/outputs private — candle's modes), and time one command buffer of N serial dispatches per candidate by `GPUStartTime/GPUEndTime`, candidates interleaved over rounds. Outputs are compared bitwise against the legacy tile fed the legacy sums pass's sums.

**Clean run r4** (`harness/r4.txt`, 09:33; µs, TFLOPS at min):

| kernel | M=1024 17408×5120 (gate pass) | M=1024 5120×17408 (down) | M=512 5120×6144 (out/o) |
|---|---|---|---|
| legacy op (pad + sums pass + 32×256×8 tile) | 3327 (54.9) | 3885 (47.0) | 743 (43.3) |
| legacy tile only | 3209 (56.9) | 3411 (53.5) | 630 (51.1) |
| pre-E1 pf tile `r32n256s8` (not bitwise: ndiff 2438 / 1120 / 399) | 3414 (53.5) | 4474 (40.8) | 692 (46.5) |
| **vec 32×256×8** (staged sums) — bitwise = legacy | 3138 (58.2) | 3365 (54.2) | 611 (52.7) |
| **vec 32×128×4** (device sums) — bitwise = legacy | **3085 (59.2)** | **3242 (56.3)** | **559 (57.6)** |
| MMA-only ceiling 32×128×4 (no epilogue, wrong values) | 2809 (65.0) | 2978 (61.3) | 510 (63.1) |

**Addendum run v6b** (`logs/all1/v6b.txt`, 14:32, thermal 0, load1 16; µs at min, TFLOPS; ref = legacy op):

| kernel | M=1024 17408×5120 | M=1024 5120×17408 | bitwise |
|---|---|---|---|
| legacy op | 3436 (53.1) | 4083 (44.7) | ref |
| **vec 32×128×4** (`v5_base`, = engine `pf_vtile`) | **3141 (58.1)** | **3347 (54.5)** | yes |
| double-buffered K loop (`v5_pipe`, two quant groups' MMAs in flight) | 3439 (53.1) **+9.5 %** | 3651 (50.0) **+9.1 %** | yes |
| de-duplicated epilogue loads (`v7_dd`, named registers) | 3128 (58.4) −0.4 % | 3337 (54.7) −0.3 % (medians +2.5 / +3.4 %) | yes |
| ablation: no bias term / no scale term (wrong values) | 3101 / 3098 | 3137 / 3312 | — |
| MMA-only 32×128×4 / half-A MMA-only | 2873 (63.5) / 2892 | 3029 (60.3) / 3006 | — |
| legacy sums pass (`LEGACY_PS`) vs new `pf_prep` | 122 vs **25** | 490 vs **80** | — |

- **The MMA ceiling is ≈ 61–65 TFLOPS** (int4 × bf16 `matmul2d`, fp32 accumulate) for every tile tried; `relaxed_precision` changes nothing; a half A operand changes nothing. 64-row tiles are slower MMA-only (56–57 TFLOPS for 64×256×8 / 64×128×4 / 128×128×8; 63.6 for 64×256×16), 32×256×4 56.6.
- **The vec epilogue is bitwise equal to the legacy tile** (`ndiff 0` on 17.8 M / 5.2 M / 2.6 M outputs) in the source form `acc += p*s + sum*b`; explicit forms (`acc + fma(p,s,sum*b)`, `acc + fma(sum,b,p*s)`, `fma(p,s,fma(sum,b,acc))`, r4 `e1`–`e3`) each differ in 0.02–0.05 % of outputs by 1 bf16 ulp and are not faster. The MMA result is independent of the tile shape (32×128×4 == 32×256×8 bitwise).
- The remaining epilogue cost is ≈ 9 % over MMA-only (bias term ≈ 1–6 %, scale term ≈ 1 %); the double-buffered K loop (the decode tiles' "pipelined" form) loses 9 % — two live partials raise register pressure — and de-duplicating the loads ties: **the tile is done**.
- Cooperative-tensor layout (probe `harness/layout.swift`, `layout.out`): each thread holds Cap = Rows·TileN/(32·Sgs) elements as runs of 4 consecutive columns on one row — for 32×128×4, two column runs (c, c+64) × four rows (r, r+8, r+16, r+24).
- Also dropped: 64×256×8 and 64×128×4 vec tiles spill (12–15 TFLOPS); 64×256×16 57.8 / 51.5 TFLOPS (below 32×128×4); 32×128×8 48.7; a de-duplicated-load epilogue with register arrays spills (30–34 TFLOPS); two-partial fused gate/up tiles run 2.8–3× slower in situ (spill); main's 16-row fused gate/up tile (`GU_F16` = `r16n128s4+gu`) is not bitwise vs legacy (ndiff 1710, max|d| 0.25) and slower at M = 1024 (13.2 vs 8.0 ms, `logs/all1/gubench.txt`, thermal 2 — medians unreliable; the harness gate-only `GATE_*` comparison there reads different output buffers and is void).

## 4. (a) Autotune sweep extended to large M, per-shape pick

`TH_BENCH_LIN=pf` now times each trial by GPU busy time (`TH_GPU_PROF=1`, `9261593`) and adds every shape's `+v` candidate (`a24f939`). Session s1 (10:01–10:03, load1 22–35, thermal 1–2; `logs/s1/sweep.log`, 453 rows): real layer-0 weights (draft shapes synthetic), M ∈ {256, 512, 1024, 1450, 2048, 4096}, 5 interleaved rounds. Cell = legacy → `r32n128s4+v` median ms (ratio); every `+v` cell has Δlegacy = 0.0000 (bitwise). [M]

| proj | M=256 | M=512 | M=1024 | M=1450 | M=2048 | M=4096 |
|---|---|---|---|---|---|---|
| gate_up | 2.33 → 2.33 (1.00) | 5.07 → 4.92 (0.97) | 9.76 → 10.35 (1.06) | 13.68 → 13.80 (1.01) | 18.73 → 19.03 (1.02) | 35.75 → 37.32 (1.04) |
| down | 1.70 → 1.07 (0.63) | 2.63 → 2.08 (0.79) | 4.67 → 4.07 (0.87) | 6.12 → 5.31 (0.87) | 10.16 → 9.96 (0.98) | 21.29 → 21.40 (1.01) |
| in_all | 1.07 → 0.87 (0.81) | 2.17 → 1.82 (0.84) | 4.23 → 3.56 (0.84) | 6.17 → 5.47 (0.89) | 7.66 → 7.24 (0.95) | 16.18 → 15.30 (0.95) |
| out | 0.46 → 0.29 (0.62) | 0.87 → 0.62 (0.72) | 1.45 → 1.25 (0.86) | 2.19 → 1.88 (0.86) | 2.79 → 2.47 (0.88) | 6.40 → 5.55 (0.87) |
| in_qkv | 0.79 → 0.74 (0.93) | 1.63 → 1.43 (0.88) | 3.29 → 3.04 (0.92) | 4.74 → 4.54 (0.96) | 7.05 → 6.88 (0.97) | 13.71 → 13.28 (0.97) |
| o | 0.45 → 0.29 (0.63) | 1.34 → 1.06 (0.79) | 1.43 → 1.18 (0.83) | 2.17 → 1.68 (0.77) | 2.65 → 2.52 (0.95) | 6.35 → 5.79 (0.91) |
| d_fc | 2.25 → 1.42 (0.63) | 3.79 → 3.02 (0.80) | 7.83 → 6.64 (0.85) | 9.85 → 8.21 (0.83) | 14.51 → 13.34 (0.92) | 28.79 → 27.50 (0.96) |
| d_qkv | 0.39 → 0.33 (0.85) | 0.83 → 0.66 (0.80) | 1.35 → 1.14 (0.84) | 1.78 → 1.64 (0.92) | 2.53 → 2.26 (0.89) | 5.52 → 5.16 (0.93) |

- **Pick: `r32n128s4+v` for every shape at m > 128** (`pf_policy_large`). It wins down (0.63–0.87 up to M = 1450), in_all (0.81–0.95), GDN out / attn o (0.62–0.95), in_qkv (0.88–0.97) and the draft's prompt-row fc / qkv (0.63–0.95); from M ≈ 2048 the gap narrows to 0.92–1.01 as the legacy passes amortize.
- **gate_up is a tie** (0.97–1.06 by median; by min the vec path is 2–11 % ahead up to M = 2048: 1.72 vs 1.93, 4.63 vs 4.84, 9.28 vs 9.54, 12.72 vs 13.02, 17.21 vs 17.81 ms). `r32n256s8+v` is within ±3 %; the fused two-stream tiles lose badly (`r32n128s4+gu` / `r32n256s8+gu` 2.8–3.0×, `r16n128s4+gu` 1.2–1.6×). No per-shape exception was worth a second tile family.
- 16-row tiles lose at M ≥ 256 on every shape (down M = 512: `r16n128s4+v` 2.72 vs 2.08 ms; in_all M = 1024: 4.36 vs 3.56); split-K on the pf tiles at best ties (down M = 512: `r32n256s8+k4` 2.08 vs 2.08 ms) and costs fp32 partial traffic, so it stays out of the large-M route.
- Weighted per 512-row chunk (64 gate_up + 64 down + 48 in_all + 48 out + 16 qkv + 16 o): **686 → 605 ms of Q4 GEMM (−81 ms, −12 %)**; per 1024-row chunk 1272 → 1221 ms (−4 %, gate_up's median tie dominates) [D].

## 5. (b) The vectorized-epilogue tile for m > 128 (`a24f939`, default on)

- **What changed.** `pf_vtile` (PF_SRC) is pf_tile's math with an epilogue that exploits the cooperative-tensor layout: per quant group a run of 4 elements needs one 8-byte scale load, one 8-byte bias load and one row sum (legacy: a 64-bit parameter index + two scalar bf16 loads per element). The per-element arithmetic is the legacy tile's source form, and `pf_prep` computes the sums with the legacy sums pass's lane pattern (but one threadgroup per (quant group, 8 rows) instead of a serial loop), so **the output is bitwise equal to `AffineQmppPrefill`** — plain and up·silu, ragged rows (m % 32 != 0) and ragged columns (out % 128 != 0). The separate pad pass, the serial sums pass and the narrow copy are gone — `pf_prep` pads in the same pass as the sums, and only when m % 32 != 0 or the base is unaligned (per-call scratch 20–78 % smaller at M = 512–1024).
- **Route.** `pf_route(m > 128)` → `r32n128s4+v` for every projection (§4), incl. the draft's prompt-row fc / qkv. `TH_PF_LARGE=0` restores the legacy op; `TH_PF_LARGE=<label>` forces another tile; `TH_PF=0` / `TH_QMM_SCALAR` still disable every tile route. m ≤ 128 is untouched (`pf_policy` as on main) — decode, verify and the prefill tail chunk run exactly main's kernels.
- **Safety.** MPP's cooperative-tensor layout is implementation-defined, so `pf_warm` dispatches a probe per warmed shape and `pf_vec_layout_check` requires runs of 4 consecutive, 4-aligned columns on one row, all elements valid, each tile element owned once; an unprobed or failing shape never routes to `+v` (warn, legacy path). Load compiles 26 pipelines (was 10): 1.4 s on a never-seen binary path, a few ms from the shader cache; never on a request.
- **Unit tests (Metal):** `pf_vec_matches_legacy_bitwise` (6 shape/m cases incl. gate/up and ragged rows/columns, 0 differing bits), `pf_vec_layout_check_accepts_runs_rejects_others`, `pf_policy_large_table`.
- **Logits** after one 1415-token prefill forward (`probe --dump`, real prompt `ids/p1450long.ids`): **base == E1(b), byte-identical** (`logs/s1/logits1415.{base,new}.bin`). [M]
- **In-process forward A/B** (`TH_BENCH_PREFILL`, `TH_BENCH_PREFILL_LARGE_ONLY=1` toggles only the m > 128 route; whole forward incl. attention/GDN from a cleared slot; GPU busy ms; 6 alternating runs + warm-up; min / median): [M]

| m | s1 (10:00, load1 15–32, thermal 0–2; E1(b)) legacy → vec | ratio med (min) | all1 (13:21, load1 21–41, thermal 2; presum on) | ratio med (min) | all1 (13:24; `TH_PF_PRESUM=0` = final default) | ratio med (min) |
|---|---|---|---|---|---|---|
| 256 | 374 / 437 → 326 / 369 | 0.845 (0.870) | — | — | — | — |
| 512 | 797 / 848 → 743 / 770 | 0.908 (0.932) | 1008 / 1128 → 946 / 1045 | 0.926 (0.938) | 904 / 984 → 842 / 907 | 0.922 (0.931) |
| 896 | 1470 / 1523 → 1398 / 1561 | 1.025 (0.951) | 1835 / 1958 → 1787 / 1882 | 0.962 (0.974) | 1689 / 1854 → 1595 / 1766 | 0.952 (0.944) |
| 1024 | 1722 / 1763 → 1568 / 1656 | 0.939 (0.911) | — | — | — | — |
| 1415 | 2482 / 2636 → 2468 / 2516 | 0.954 (0.994) | 3073 / 3179 → 2825 / 3021 | 0.950 (0.919) | 2682 / 2805 → 2604 / 2715 | 0.968 (0.971) |
| 2048 | 4163 / 4210 → 4011 / 4075 | 0.968 (0.964) | — | — | — | — |

  The whole forward drops 4–8 % at 512–1415 rows (GEMMs are ≈ 70 % of a 512-row forward, ≈ 60 % of a 1415-row one-chunk forward, where the eager attention grows). For the server's cold 1459-token plan (chunks 512 + 896 + 51) the two large chunks sum to **2267 → 2141 ms (s1, min), 2843 → 2733 (all1), 2593 → 2437 (all1, final default)**: −110 to −156 ms, −4 to −6 % [D]. Absolute GPU times in all1 are ≈ 25 % higher than in s1 (thermal 2 all afternoon); the ratios agree.

## 6. (c) Prefill presum blocks (`792127e`; **opt-in since `73fe6ab`: `TH_PF_PRESUM=1`**)

- The K45 presum path was decode-only (T ≤ 8). With `pf_presum_on(m)` (m > 128, the vec route on and probed, `TH_PF_PRESUM=1`): `AddRmsNorm { pfsums }` writes the normed plane as a prefill presum block (rows zero-padded to 32, then f32 sums in the 32-row prefill layout, pf_prep's lane pattern) for in_all / in_qkv / gate_up, and the gate/up up·silu pass (`*_vuse`) stores whole 32-row tiles and writes the down projection's sums after a device barrier (Splash's `prefill_linear_q4_n256_up_silu_sums` idea); `AffineQpf { presum }` skips `pf_prep`. Unit test `pf_presum_chain_matches_prep_bitwise` (ragged T = 161 / 133, 0 differing bits for both producers and both consumers).
- Coverage: 3 of the 5 per-layer pf_prep passes (in_all or in_qkv, gate_up, down); not GDN out, attention o, layer 0's in_all.
- **Effect: below the noise floor.** Harness: `pf_prep` costs 25 µs at m = 1024, K = 5120 and 80 µs at K = 17408 (v6b) ⇒ ≤ ≈ 9 ms per 1024-row forward (≈ 1 %) before the producers' extra work [D]. In-process (all1, each run normalized by its own interleaved legacy runs): vec + presum / legacy **0.926 / 0.962 / 0.950** vs vec only **0.922 / 0.952 / 0.968** at m = 512 / 896 / 1415 (medians) — indistinguishable. **Per the lane rule it is now opt-in** (`73fe6ab`); the code stays (bitwise, tested) for re-measurement once attention stops dominating long chunks.

## 7. (d) Prefill chunk size (`TH_BENCH_STEPS`, all1 13:11–13:19, GPU busy ms, alternating in one process)

| prompt | step (chunks) | min | median | vs 512 (min / median) |
|---|---|---|---|---|
| 1415 tok (4 reps) | **512 (3)** | 2484 | 2971 | — |
| | 256 (6) | 2515 | 2889 | +1.2 % / −2.8 % |
| | 1024 (2) | 2720 | 3099 | +9.5 % / +4.3 % |
| | 1415 (1) | 2776 | 3128 | +11.8 % / +5.3 % |
| 7885 tok (2 reps) | **512 (16)** | 19752 | 23353 | — |
| | 256 (31) | 20073 | 21980 | +1.6 % / −5.9 % |
| | 1024 (8) | 21432 | 23503 | +8.5 % / +0.6 % |

- **Last-token logits are bitwise identical for every chunk size** (max|d| 0.0000, same argmax) — the chunked eager attention's masked entries contribute exact zeros and the GEMM tiles are row-invariant.
- **Keep 512.** The Q4 GEMMs are compute-bound and row-parallel from M ≈ 256 (§4: per-row time flat or worse from 512 to 1024 rows), so larger chunks do not help them, and dispatch overhead is negligible at this size (≈ 1000 dispatches per ≈ 700 ms chunk). The eager attention computes the full rows × (pos + rows) score block per chunk, so a 1024-row chunk wastes ≈ 2× the masked triangle (+8–12 % end to end). 256 ties 512 (within noise). The GDN scan (`gated_delta_step`, one dispatch per layer per chunk, sequential over the chunk's tokens: 145 ms at 1.45k, 750 ms at 7.9k) is independent of chunking. Revisit after th/e-prefill-attn's fused causal attention lands (Splash prefills up to 2048 rows per batch, `ExecutionLimits::prefillTokenBudget`).

## 8. Gates

**all1** (13:08–14:32, one gpu-lock hold, binary `8a527b1a…` = `5118982`, presum on): [M]

| gate | result |
|---|---|
| unit suite (release test binary `56c4ec97…`) | **82 passed, 0 failed, 1 ignored** (base: 78 + the 4 new tests) |
| `TH_TEST_ROLLBACK=1 TH_BATCH=2` (18 tokens) | **rc 0**: state-bitwise PASS; prefix restore slot0→slot0 / slot0→slot1 0/0/0/0 PASS; legacy logits worst 0.125, refwd 0, argmax 68/68/68 PASS |
| same `TH_BATCH=1` | **rc 0** (state-bitwise PASS, prefix restore PASS) |
| same, 1450-token prompt (vec route + presum inside the probe's prefill) | **rc 0** (state-bitwise PASS, prefix restore at 1448 PASS both slots); its legacy-logits line prints "FAIL (argmax ref=68 rb=13)" — the known check artefact (th-d-longctx §5; integration-3 prints the same) |
| `TH_BATCH=2 --draft`: batch2_client + batch2_long (1.45k pairs, 8k pair) | all HTTP 200, 0 panic/WARN/ERROR; **T=0 reproducible across repeats** (`long 91a6e28ec7`, `code 155e1756f2` — integration-3's shas) |
| prefix cache over spec_a3 (43 requests) | **hit == miss 42/42 texts · 42/42 round logs**; on vs `=0` 35/42 · 24/42 (main's known default-plan class; PHASED-REPORT: 35/42) |
| **new vs integration-3's own gate arms** (`merge_i3.py` + `cmp_arms.py`, `logs/all1/cmp_i3/`) | **pc_on 42/42 · 42/42, pc_miss 42/42 · 42/42, pc_off 42/42 · 42/42** — bitwise equal to main in every mode |
| server A/B T=0 identity (§9) | **36/36 greedy, 36/36 ctx1500, 36/36 ctxcold** identical id streams + texts vs base |
| decode T=0 (3 bench prompts × 3 × 4 arms, ratio of sums) | base 44.74 → new **44.90 ms/round (+0.36 %)**, tok/round 3.843 both (per-arm 43.93 / 45.56 vs 48.01 / 41.80: noise; m ≤ 128 path unchanged) |
| `/status` / `th_stats` | unchanged (no fields added or removed) |

**fin1** (15:14–, one gpu-lock hold, **final binary `9b4fc684…` = `73fe6ab`, presum off** — the shipped default path): [M]

| gate | result |
|---|---|
| unit suite (release test binary `2c86da42…`) | **82 passed, 0 failed, 1 ignored** |
| `TH_TEST_ROLLBACK=1` TH_BATCH=2 / TH_BATCH=1 / 1450-token | **rc 0 / rc 0 / rc 0**; state-bitwise PASS ×3, prefix restore bitwise PASS ×3; legacy logits 0.125 / 0.125 PASS, 1450-token 0.2188 "FAIL argmax rb=13" (same artefact, same values as all1; base's own run: see appendix line below) |
| `TH_BATCH=2 --draft` batch2_client + batch2_long | all HTTP 200, 0 panic/WARN/ERROR, **T=0 reproducible (`code 155e1756f2`, `long 91a6e28ec7`)** |
| prefix cache on / `=miss` / `=0` (spec_a3, 43 requests each) | **hit == miss 42/42 · 42/42**; on vs `=0` 35/42 · 24/42 (main's class) |
| **final vs integration-3's gate arms** | **pc_on 42/42 · 42/42, pc_miss 42/42 · 42/42, pc_off 42/42 · 42/42** |
| server logs (7 servers/probes) | 0 panic, 0 WARN, 0 ERROR |
| **final-vs-base logits** (1415-token one-chunk prefill, `probe --dump`, `logs/fin1/logits1415.{base,fin}.bin`) | **byte-identical (`cmp`)** |
| base's own 1450-token rollback probe (`logs/fin1/rb_long_base.log`) | rc 0, state-bitwise PASS, and the **same** "worst 0.2188 … argmax ref=68 rb=13 ctl=68 FAIL" line — a check artefact on main too |
| decode T=0 kernel sequence (profiled arms, 22 rounds × 2 arms per label) | the same 38 kernels per round with identical call counts; GPU busy per round base 42.8 / final 41.9 ms |
| T=0 identity in the 8-arm server A/B (§9.2) | **144/144 greedy, 96/96 ctxcold** identical to base |

## 9. Server A/B vs base

### 9.1 all1 s3 — 4-arm palindrome base_1 new_2 new_3 base_4 (13:43–14:32, binary `5118982`, presum on) [M]

Fresh server per arm; warm-up, greedy 3×3, ctx1500 3×3, ctxcold 3 prompts × 3 nonces, ctx8kcold 3 nonces (thermal-0 wait ≤ 180 s outside the timed window), rep8k (one 8k + 2 exact repeats). `logs/all1/analysis/{ttft,decode_identity}.md`.

| mode | base mean / median ms | new mean / median ms | new/base (mean / median) | paired mean Δ (n) |
|---|---|---|---|---|
| cold ≈1.45k (`ctxcold`, 18 per label) | 2615 / 2613 | 2597 / 2546 | 0.993 / 0.974 | −19 ms (9) |
| cold ≈7.9k (`ctx8kcold`, 6 per label) | 20091 / 19956 | 20912 / 19481 | 1.041 / 0.976 | +821 ms (3) |
| warm repeated 1.4k prefix (`ctx1500`) | 137 / 149 | 143 / 153 | 1.044 / 1.029 | +6 ms (9) |
| 8k exact repeat (`rep8k` 2nd/3rd) | 482–523 | 475–488 | — | — |
| short prompts (`greedy` TTFT) | 157 / 161 | 151 / 152 | 0.957 / 0.946 | −7 ms (9) |

- **Unresolved at this sample size.** Per-arm cold-1.45k means: base_1 2688, new_2 2767, new_3 2427, base_4 2543 — the two base arms differ by 145 ms and new_2 ran all nine requests at thermal pressure 1–2 (load1 15–19) while new_3 ran all nine at thermal 0. Thermal-0-matched subset (short + code prompts, start and end thermal 0): base 2557 ms (10 requests, two arms) vs new 2445 ms (6, one arm) = **−113 ms (−4.4 %)** — the size the in-process A/B predicts (−110 to −156 ms), but one new arm only.
- The 7.9k "+821 ms" is one request (new_3 long: 27.7 s at load1 43 after a 181 s thermal wait); medians favour new (−475 ms). All three slow 8k requests of the session (new_2 short 22.7 s after a 181 s wait, new_3 long 27.7 s after 181 s, base_4 rep8k-1 29.2 s after 163 s) followed long idle thermal waits, the rest ran 17.8–21.4 s: on this host (36 GB swap in use) idle gaps let the compressor take the model's pages (th/e-ttft-regression's finding), so fin1's A/B runs requests back to back with arm-level gates only.
- Warm / exact-repeat TTFT is unchanged by design (a 24–46-row or ≤ 8-row suffix runs the m ≤ 128 path).

### 9.2 fin1 s5 — 8-arm palindrome on the final binary (15:35–16:02) [M]

Arms `base_1 fin_2 fin_3 base_4 base_5 fin_6 fin_7 base_8`, fresh server each, thermal-only arm gate (thermal 0 held 20 s, waits 100–156 s; every request started at thermal 0), then back to back: warm-up, greedy 3×3 (T=0, 128 tokens), ctxcold 3 prompts × 2 nonces (max 128 tokens), ctx8kcold 1 prompt (max 16). `logs/fin1/analysis/{ttft,decode_identity}.md`; position-matched pairs (arm k of each label, same request position) with a 10k bootstrap.

| mode | base mean / median | final mean / median | final/base mean / median | paired mean Δ (95 % CI), n |
|---|---|---|---|---|
| cold ≈1.45k | 2690 / 2702 | 2664 / 2619 | 0.990 / 0.969 | **−27 ms (−107..+51)**, 24 |
| cold 7929 | 20575 / 20969 | 20166 / 20242 | 0.980 / 0.965 | −409 ms (−1458..+363), 4 |
| short-prompt TTFT (greedy) | 146 / 152 | 149 / 155 | 1.020 | +3 ms (+1..+5), 36 |
| **pooled s3 + s5, cold ≈1.45k** | | | | **−23 ms (−80..+32)**, 42 |

- Per-arm cold-1.45k means: base 2689 / 2844 / 2491 / 2738, final 2739 / 2697 / 2648 / 2572 — again a ±7 % spread within one binary. The final arms ran at higher host load (load1 median 24.6 vs 20.4).
- **This session alone does not establish an unprofiled cold-TTFT gain (≤ 4 % at 95 % confidence)**, while the GPU-attributed comparisons of the same binaries in the same hold show −13 % (§9.3) and −20 % (§9.4) of the cold prefill. §9.5 (fin2) repeated the palindrome with fresh-server and after-decode cold requests in every arm: −321 / −253 ms there, −119 ms (95 % CI −197..−45) pooled over s3 + s5 + s7 — s5 was the low end of a noisy distribution, not a regime in which E1 does not pay.
- **T=0 identity: 144/144 greedy and 96/96 ctxcold id streams + texts identical to base.**
- Decode (ratio of sums, 840 rounds per label): base 42.86 → final 44.34 ms/round (+3.5 %; per-arm base 42.38 / 45.58 / 42.02 / 41.47, final 44.21 / 46.09 / 42.89 / 44.19; tok/round 3.843 both); every component rose together (propose 6.41 → 6.73, host encode 2.66 → 2.88, GPU tail 33.46 → 34.37 ms). The decode path is code-identical (m ≤ 8 rows never reach the changed routes) and **the profiled arms show the same 38 kernels per decode round with identical call counts and GPU busy per round base 42.8 vs final 41.9 ms** (22 rounds × 2 arms each) — this is host-load noise, not a regression (all1 s3: +0.36 %).

### 9.3 fin1 profiled per-region A/B — base vs final, same prompts, palindrome base_1 fin_2 fin_3 base_4 [M]

Fresh server per arm (15:28–15:35, arm gates ≤ 60 s: thermal at start 2 / 0 / 1 / 1, load1 14–21), `TH_GPU_PROF=1 TH_GPU_PROF_EVERY=1 CANDLE_METAL_COMPUTE_PER_BUFFER=1`, warm-up then 3 cold ≈1.45k prompts (short / code / long, the same nonces in every arm) + 1 cold 7929-token prompt, back to back. Per-region phase=prefill GPU-exclusive ms, mean over requests (`logs/fin1/analysis/prof_ab.md`, `bench/prof_ab.py`). TFLOPS = target GEMM FLOPs / region ms.

| region | 1448 tok base ms | final ms | final/base | TFLOPS base → final | 7929 tok base ms | final ms | final/base | TFLOPS base → final |
|---|---|---|---|---|---|---|---|---|
| mlp.gate_up | 829.6 | 728.4 | 0.878 | 39.8 → 45.3 | 4392.9 | 3977.6 | 0.905 | 41.2 → 45.5 |
| mlp.down | 516.9 | 403.9 | **0.781** | 32.0 → 40.9 | 2858.7 | 2142.7 | **0.750** | 31.6 → 42.2 |
| gdn.in_all | 321.4 | 261.3 | 0.813 | 36.5 → 44.9 | 1696.4 | 1410.2 | 0.831 | 37.9 → 45.5 |
| gdn.out | 128.3 | 101.2 | 0.789 | 34.1 → 43.2 | 712.3 | 546.4 | 0.767 | 33.6 → 43.8 |
| attn.qkv | 89.1 | 77.3 | 0.868 | 38.2 → 44.0 | 468.4 | 413.0 | 0.882 | 39.8 → 45.1 |
| attn.o | 42.7 | 33.7 | 0.790 | 34.1 → 43.2 | 240.2 | 182.4 | 0.759 | 33.2 → 43.8 |
| **all Q4 GEMMs** | **1928.1** | **1605.8** | **0.833** | **36.6 → 43.9** | **10368.9** | **8672.3** | **0.836** | **37.2 → 44.5** |
| attn.core (unchanged code) | 674.3 | 637.7 | 0.946 | — | 9764.2 | 9558.6 | 0.979 | — |
| gdn.core (unchanged code) | 172.1 | 165.3 | 0.960 | — | 904.1 | 881.4 | 0.975 | — |
| norm.next + norm.post | 25.6 | 25.1 | 0.98 | — | 136.8 | 130.0 | 0.95 | — |
| **prefill phase total** | **2808.4** | **2442.6** | **0.870** | | **21208.6** | **19275.9** | **0.909** | |
| TTFT (client, profiled server) | 2847 | 2481 | 0.872 | | 21387 | 19434 | 0.909 | |

- **Every final request beat every base request**: 1.45k per-request prefill ms base 2958 / 2866 / 2888 (base_1), 2717 / 2735 / 2687 (base_4) vs final 2570 / 2588 / 2392 (fin_2), 2097 / 2458 / 2551 (fin_3); 7.9k base 21744 / 20673 vs final 19923 / 18629.
- The unchanged regions ran 2–5 % faster in the final arms (clock / thermal bias: base_1 started at thermal 2). Normalising by them, **the Q4 GEMMs are −12 % (1.45k) / −14 % (7.9k) and the whole prefill −8 % / −7 %** [D] — the same size as the in-process A/B (§5) and the sweep-weighted estimate (§4).
- The profiled runs put every op in its own command buffer, so absolute times are inflated vs unprofiled serving (base 2847 vs ≈ 2600 ms cold TTFT); the per-op buffer count is the same for both binaries except GDN in_all's legacy narrow copy.

### 9.4 fin1 s6 — default command-buffer batching, profiled (diagnostic) [M]

`TH_GPU_PROF=1` alone (candle's default 50 ops per command buffer: exact window busy / idle totals), fresh server, warm-up + 3 cold ≈1.45k + 1 cold 7929, back to back, fin_p (16:05) then base_p (16:08), both thermal 0:

| | base_p TTFT / GPU busy (ms) | fin_p TTFT / GPU busy | final/base busy |
|---|---|---|---|
| cold 1437 / 1447 / 1459 tok | 2597 / 2639, 2851 / 2886, 2757 / 2801 | 1991 / 2032, 2338 / 2380, 2276 / 2318 | 0.770 / 0.825 / 0.828 |
| cold 7929 tok | 20316 / 20195 | 17176 / 17095 | 0.846 |

- With default batching the GPU is busy ≈ 94 % of each prefill window (idle 140–185 ms per 1.45k window, 290–350 ms per 8k window, mostly outside the prefill), and TTFT tracks GPU busy: here the final binary was 18–23 % faster at 1.45k and 15 % at 7.9k (one pair, conditions matched only by the gate).
- The one-op-per-buffer unprofiled pair (`CANDLE_METAL_COMPUTE_PER_BUFFER=1`) was not usable: base_c 2396 / 2640 / 2703 / 19216 ms, fin_c 3295 / 2957 / 3149 / 25021 ms started at thermal 1 and overlapped an `ioreg` contention probe of mine (16:14:43–48) — discarded.

### 9.5 fin2 s7 — fresh-server vs after-decode cold TTFT, unprofiled (17:53–18:17) [M]

Palindrome `base_1 fin_2 fin_3 base_4 base_5 fin_6 fin_7 base_8`, fresh server each, thermal-only arm gate (≤ 120 s), then back to back: **A** warm-up + 3 cold ≈1.45k (nonces 1–3, max 16 tokens) → **G** greedy 3×3 (T=0, 128 tokens) → **D** 3 cold ≈1.45k (nonces 11–13) → **K** 1 cold 7929. Other GPU clients measured per phase by `ioreg` snapshots between phases (our server excluded). `logs/fin2/analysis/{s7,decode_identity}.md`, `bench/s7_an.py`.

| phase | base mean / median | final mean / median | final/base | paired mean Δ (95 % CI), n | without the slow base_4 arm (n) |
|---|---|---|---|---|---|
| A fresh server, cold 1.45k | 2660 / 2524 | 2339 / 2338 | 0.879 | **−321 ms (−608..−30)**, 12 | −93 ms (−288..+141), 9 |
| D after 9 decode requests, cold 1.45k | 2725 / 2618 | 2471 / 2480 | 0.907 | **−253 ms (−435..−87)**, 12 | −92 ms (−197..−4), 9 |
| K cold 7929 (after D) | 20731 / 20746 | 18760 / 19070 | 0.905 | **−1971 ms (−3264..−973)**, 4 — all 4 pairs faster | −1347 ms, 3 |

- Per-arm cold-1.45k means (A / D): base 2548 / 2554, **3366 / 3239 (base_4: thermal 1 at start, every request slow)**, 2449 / 2764, 2275 / 2340; final 2202 / 2512, 2363 / 2501, 2522 / 2510, 2269 / 2362. Other GPU clients during A: base 194 / 199 / 102 / 113 ms/s, final 170 / 195 / 247 / 107 ms/s (Codex Service ≈ 14 %, WindowServer ≈ 5 % of the GPU when sampled at 17:05) — comparable per label.
- Request position: the first cold request of an arm is the fastest (1934–2154 ms in 6 of 8 arms); D − A in the same arm and prompt: base +65 ms mean (−5 median), final +132 (+99). After decode traffic the final binary's advantage shrinks but stays negative in s7; s5's −27 ms (same order) was inside its noise.
- **Pooled over every unprofiled server session (s3 + s5 + s7, 20 arms, 66 position-matched pairs): cold 1.45k −119 ms (95 % CI −197..−45), median −26; without s7's base_4 arm −44 ms (−99..+10).** Cold 7.9k pooled (14 pairs) median −648 ms, mean −328 (−1475..+1059; s3's thermal-wait outliers).
- T=0 identity: fin vs base **144/144 greedy, 48/48 cold (A)**, finD vs baseD **48/48** (D). Decode (greedy, ratio of sums): base 44.36 → final 42.54 ms/round (**−4.1 %**, the opposite sign to s5) — pooled over s3 + s5 + s7 (2100 rounds per label): **43.84 → 43.73 ms/round (−0.2 %)**.

## 10. Where the long-prompt time goes after E1, and next levers

Final binary, fin1 profiled arms (§9.3), share of prefill-phase GPU ms: [M]

| | 1448 tok | share | 7929 tok | share |
|---|---|---|---|---|
| Q4 GEMMs (in situ 43.9 / 44.5 TFLOPS; 91 % of the MMA ceiling in isolation) | 1606 | 66 % | 8672 | 45 % |
| attn.core (eager, per chunk) | 638 | 26 % | 9559 | 50 % |
| gdn.core (conv, qk-norm, sequential `gated_delta_step`, gate-norm) | 165 | 7 % | 881 | 5 % |
| norms, lm_head, embed, rest | 34 | 1 % | 164 | 1 % |

- **GEMM tile: done.** The vec tile is at 91 % of the int4×bf16 MMA-only ceiling (61–65 TFLOPS) in isolation; the remaining epilogue work is ≈ 9 %, and the two cheap ways to hide it (pipelined K loop, de-duplicated loads) lose or tie. Splash's prefill tile (`q4_mpp_prefill_tile`) has the legacy scalar epilogue and the serial sums pass — th's long-prompt GEMMs are now faster than that design per call.
- **In-situ vs harness gap.** In the same fin1 hold the Q4 GEMMs ran at 36.6 (base) → 43.9 TFLOPS (final) in situ at 1.45k, vs 53–55 (legacy op) and 58–59 (vec tile) in the isolated harness: in situ ≈ 70–75 % of the isolated rate for both binaries (s0 on a quieter morning: base 43.8). Candidates: sustained GPU clock under seconds-long full-occupancy MMA load (the harness runs short bursts), other GPU clients (13–41 % of the GPU in th/e-ttft-regression's session D), and per-op command buffers in the profiled runs. Not a tile problem; a fair absolute number needs a quiet machine.
- **Attention** (24 % at 1.45k, 46 % at 7.9k on main) — th/e-prefill-attn's fused causal kernel (their s1: cold 1.45k −322 ms, 7.9k −8.3 s).
- **GDN scan**: `gated_delta_step` is one sequential pass per layer per chunk (763 µs per 512-row call; 145 ms at 1.45k, 750 ms at 7.9k); a chunked (WY / parallel-scan) formulation is the next prefill kernel after attention.
- **Chunking after fused attention**: re-run `TH_BENCH_STEPS` (512 / 1024 / 2048) once the masked-triangle waste is gone; the GEMMs are neutral to it.
- **Host / non-GPU time**: prefill GPU busy 2358 ms vs cold TTFT ≈ 2530 ms at 1.45k on main — checkpoint captures + KV-capacity prefill (th/e-ttft-regression).
- **Presum** (`TH_PF_PRESUM=1`): worth one re-measurement after attention shrinks (its ≤ 1 % share of a forward grows as the forward shrinks).

## 11. Reproduction

```bash
P=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC; W=$P/work/th-e-prefill-gemm
# build (worktree), 0 warnings
cd /Users/benebsworth/projects/token-horizon/.worktrees/th/e-prefill-gemm/engine && cargo build --release && cargo test --release --no-run
# harness (standalone Metal, GPU timestamps)
cd $W/harness && $P/bin/gpu-lock -- ./bench v6.metal 1024 17408 5120 v5_base_32_128_4:32:128:4 v5_pipe_32_128_4:32:128:4 v7_dd_32_128_4:32:128:4 mma_32_128_4:32:128:4 LEGACY:32:256:8 --lib2 mpp_src.metal --ref LEGACY --iters 4 --rounds 5
# sweep (a), in-process forward A/B (b/c), chunk size (d)
$P/bin/gpu-lock -- env TH_GPU_PROF=1 TH_BENCH_LIN=pf TH_BENCH_PF_M=256,512,1024,1450,2048,4096 TH_BENCH_PF_ROUNDS=5 $W/bin/th-engine-fin-73fe6ab probe --model "$TGT" --tokens 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18
$P/bin/gpu-lock -- env TH_GPU_PROF=1 TH_BENCH_PREFILL_LARGE_ONLY=1 TH_BENCH_PREFILL=512,896,1415 $W/bin/th-engine-fin-73fe6ab probe --model "$TGT" --tokens "$(cat $W/ids/p1450long.ids)"
$P/bin/gpu-lock -- env TH_GPU_PROF=1 TH_BENCH_STEPS=512,256,1024,1415 TH_BENCH_STEPS_REPS=4 $W/bin/th-engine-fin-73fe6ab probe --model "$TGT" --tokens "$(cat $W/ids/p1450long.ids)"
# sessions: all1 = bench/all.sh (unit, harness, big.sh: steps, benchpf, g3 gates, s3 server ABBA)
#           fin1 = bench/s4.sh (unit, g3 gates, profiled per-region A/B, s5 8-arm A/B, appendix: base rollback probe +
#                  final-vs-base logits, s6 batching diagnostic); fin2 = bench/s7.sh (fresh vs after-decode 8-arm A/B)
$P/bin/gpu-lock -- bash $W/bench/s4.sh $W/logs/fin1 $W/bin/th-engine-fin-73fe6ab $W/bin/th-engine-tests-fin-73fe6ab
$P/bin/gpu-lock -- bash $W/bench/s7.sh $W/logs/fin2 $W/bin/th-engine-fin-73fe6ab
bash $W/bench/analyze_all.sh $W/logs/all1; bash $W/bench/analyze_fin.sh $W/logs/fin1
python3 $W/bench/s7_an.py $W/logs/fin2; python3 $W/bench/ab.py $W/logs/fin2 --base base --modes greedy,ctxcold
# identity vs integration-3's gate arms (prefix cache on / miss / off)
python3 $P/work/th-e-ttft-regression/gates/merge_i3.py $W/logs/fin1/g3/cmp_i3 $W/logs/fin1/g3/pc_runs.jsonl && python3 $W/gates-tools/cmp_arms.py $W/logs/fin1/g3/cmp_i3 i3_on pc_on
```
