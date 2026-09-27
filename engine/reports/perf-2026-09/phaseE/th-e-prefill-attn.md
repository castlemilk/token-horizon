# th/e-prefill-attn: fused causal prefill attention (E1)

Written 2026-09-27 by the th/e-prefill-attn agent (items 1–2), finished by its continuation (final hold, gates, item 3). Tags: [M] measured, [D] derived, [E] estimate.

- **Hardware and model:** M5 Max (40-core GPU, 128 GB), Qwen3.8-27B-4bit (`$TGT`) + DFlash draft (`$DRAFT`).
- **Measurement rules:** private port :8051, every GPU run inside `$P/bin/gpu-lock`, fresh server per arm.
- **Branch:** `th/e-prefill-attn`, worktree `.worktrees/th/e-prefill-attn`, started from `main` @`e452a7b`. Three commits on the branch; not pushed.
- **Work dir:** `$W = $P/work/th-e-prefill-attn`:
  - `bin/`: frozen binaries, hold and gate scripts
  - `bench/`: session harness `s.sh`, `pa_client.py`, `analyze.py`; session `s1/`
  - `logs/`: kernel benches, logits probes, tests; `logs/final/`: the final hold (gates, chunk bench, rotated A/B, item-3 gates)

| label | commit | th-engine sha256 | test binary sha256 |
|---|---|---|---|
| base | `main` @`e452a7b` (the `.worktrees/report/integration-3` build) | `eb3497fbb194857e…` | — |
| item 1 (server A/B s1) | `70409a9` | `0600dbcace4467b1…` | — |
| item 2 | `3c33c30` | `cf578ecd8d74c311…` | `ce3ec96a4ccfa01d…` |
| **final** | **`12087ec`** (item 3) | **`089c589e01e203ae…`** | `f81731e6a6f1799e…` |

Rebuilding each commit from source reproduces these hashes exactly, so the gated binaries are the committed code.

## 0. Summary

1. **Item 1 (`70409a9`, default on): a fused causal flash-attention kernel for prefill chunks of more than 8 rows** (`attn_kernel.rs` `attn_prefill`; `qwen35.rs` `attn_forward` → `attn_fused_out`).
   - **Structure:** after MLX 0.32.2's `attention_nax_dsplit` (M5 neural-accelerator attention, MIT): register-resident 16×16 fragments, per-simdgroup MPP `matmul2d` 16×32×16, 32-key blocks, the head dim split across a simdgroup pair, online softmax in f32.
   - **Additions:**
     - GQA-fused rows: the 6 q heads of a KV head in one threadgroup, sharing every K/V load.
     - The chunk's causal query offset.
     - Strided K/V read straight from the model's caches (head- or time-major).
     - The sigmoid output gate fused into the epilogue.
     - Deterministic, and chunk-invariant bit for bit.
   - **Mask and cat removed:** the host-built causal mask is gone from the fused path. When the KV-capacity buffer is written in place, the exact-length K/V `cat` is gone too.
   - **Fallbacks and knobs:** eager fallback for everything else. `TH_PREFILL_ATTN=eager` gives the old path, bitwise equal to main (§5). Knobs are read once.
2. **Found on the way:** with this NAX fragment layout, a **strict-precision f32 left operand gives garbage**, and a relaxed one rounds to about f16. bf16 and half operands are exact (`nax_fragment_mma_matches_cpu`).
   - MLX feeds P·V an f32 left operand in relaxed mode.
   - Here P·V takes **f16 probabilities scaled by 2^15**: values down to 2^-29 of the row max stay normal f16, and the scale folds exactly into the final reciprocal.
3. **Accuracy** [M, §2.1]:
   - **Against an f32 reference:** the fused output's max|Δ| is **0.0021** on unit-range data (output-rounding level; final build, all shapes) and **0.008–0.015** on the bench shapes. The current grouped eager path is 0.045–0.11 and candle's sdpa 0.02–0.04: the fused kernel is the most accurate of the three.
   - **Last-prefill-position logits, fused vs eager:** max|Δ| 0.16 / 0.25 / 0.50 / 0.16 at 512 / 1450 / 4096 / 7900 tokens, KL ≤ 1.2e-3 nats, argmax equal, top-10 10/10 (item-2-era build e1v; final build: not re-probed, see §2.3).
   - **That is the size of the engine's own plan-dependent noise floor.** Splitting a 24-row tail chunk off the same eager prefill, as the prefix cache's default plan does for chat prompts, moves the logits by 0.19 / 0.13 / 0.41 / 0.16 (KL ≤ 9.4e-4).
   - **The 0.05 logit target is not reachable in absolute terms.** The logits are bf16, so one ulp is 0.125 at |logit| 16–32, and the eager path itself misses 0.05 under a chunking change.
4. **Kernel speed** [M, §2.2]:
   - **Per attention layer:** **6–10× faster than the grouped eager path** on 512–896-row chunks (512:512 3.70 → 0.38 ms; 896:1408 17.6 → 1.9; 512:7168 53.7 → 8.2) and **1.2–2.4× faster than candle sdpa**.
   - **Whole cold prefills** (16 attention layers, 512-row chunks, one run): grouped eager **60 / 363 / 2562 / 8767 ms → final kernel 5 / 42 / 329 / 1175 ms** at 512 / 1450 / 4096 / 7900 tokens, i.e. 7.5–12× less. candle sdpa would be 15 / 85 / 522 / 1707 ms.
5. **Server A/B** (session s1 on item 1, ABBA base/new/new/base, one gpu-lock hold, 144/144 requests OK; §3):

| request class | base e452a7b | item 1 70409a9 | Δ |
|---|---|---|---|
| **cold ≈1.45k TTFT** (9 nonces × 2 arms) | 2739 mean / 2662 median ms | **2417 / 2458** | **−322 ms mean (−11.8 %)**, −205 median |
| **cold ≈7.9k TTFT** (3 nonces × 2 arms) | 21.32 s mean / 20.04 median | **13.01 / 13.07** | **−8.3 s mean (−39 %)**, −7.0 s median |
| 8k exact repeat (after each cold 7.9k) | 1084 mean / 569 median ms | **445 / 378** | −191 ms median |
| warm 1.4k-prefix hit (ctx1500) | 139 / 149 ms | **130 / 137** | −9 ms |
| first 8k request of an arm (ctx8k #1, 0 cached) | 29.1 s (thermal 2, load1 49) / 22.6 s | **12.4 / 17.4 s** | −11 s mean (base_1 thermal-confounded) |
| decode T=0, 3 bench prompts × 3, identical texts | 43.81 ms/round | 42.20 | **0.963 (no regression)** |
| peak phys_footprint, cold 7.9k | 47.5 GB (+11.4 over pre-request) | **31.7 GB (+5.0)** | **−56 % transient** |

   - **In-model probe:** it agrees with the server A/B: prefill 1450 tokens −318 / −478 ms, 4096 −1.75 / −2.06 s, 7900 −7.2 / −7.6 s (1.46–1.50×), two sessions (§2.3).
   - **The final build vs item 1** [M kernel, D TTFT]:
     - Item 2's default runs at the same speed as item 1 (ABAB kernel bench +0.6 %).
     - Item 3 then cuts the whole-prefill attention time by ≈15 % (§2.2). That is ≈ −4 to −8 ms per cold 1.45k prefill and ≈ −150 to −225 ms per cold 7.9k prefill on top of the s1 numbers.
     - That is below the server A/B's resolution, so it was not server-measured.
   - **vs the brief's expectation** (cold 1.45k ≈ −0.45 s, 8k ≈ −50 %): measured −0.32 s at 1.45k and −39 % at 7.9k TTFT (8k prefill 1.46–1.50× in-model).
   - **Why the 1.45k saving is smaller than expected:** the expectation assumed the grouped eager attention costs ≈545 ms at 1.45k. On this build it costs ≈360 ms: 3.7 + 17.6 + 1.1 ms/layer × 16 over the server's actual chunks [512, 896, 41].
6. **Identity** (§4):
   - **Item 1, s1** (T=0 base vs new): **26/36 streams identical**. Greedy 9/9 and ctx1500 9/9, plus all short prompts.
   - **The 10 divergences** are at emitted-id index 14–113 on the ≥ 256-key near-tie class. Three of them (ctxcold long#2@14, long#3@52, code#1@113) are the positions the integration-3 report found for i3 vs main.
   - **Determinism:** each binary is deterministic across its own arms (36/36 and 36/36).
   - **Final build** (prefix-cache spec_a3, 43 requests): vs base 21/42 texts · 9/42 round logs. Item 1 vs base was 28/42 · 9/42 on the same spec, so both are the same near-tie class.
7. **Gates** (§5, final hold 16:14–16:47, one gpu-lock hold):
   - **Passed:**
     - V-build 0 warnings (release + tests) on 3c33c30 and 12087ec.
     - Unit tests 81 passed / 0 failed on 3c33c30 and 12087ec.
     - `TH_TEST_ROLLBACK` rc 0 on 18- and 1450-token prompts, TH_BATCH=1 and 2, with the `TH_GDN_COMMIT=step` discrimination still rc 1.
     - TH_BATCH=2 smoke: 35/35 HTTP 200, samplecheck 311 rounds 0 mismatches, hit == miss across 2 slots.
     - Prefix cache hit == miss 42/42 · 42/42.
     - `TH_PREFILL_ATTN=eager` == main 42/42 · 42/42.
     - `TH_KV_CAP_PREFILL=0` == default 42/42 · 42/42.
     - Final 12087ec == 3c33c30 42/42 · 42/42.
   - **Failed:** one expectation. Item 2 (3c33c30) vs item 1 (70409a9) is **21/42 · 12/42, not 42/42**. Item 2's refactored default is the same algorithm but not bitwise equal to item 1: most likely f32 FMA contraction of the running row sum. It runs at the same speed.
8. **Item 2 (`3c33c30`, default off):** tuning shapes for the kernel via `TH_PREFILL_ATTN_VARIANT`:
   - Shapes: per-head rows, 1/4 row groups, relaxed MPP, BK 64, double-buffered score exchange, skip-unit-rescale, q re-read per block.
   - Measured in holds hv1 / hv2, none paid (§2.2). The q-reload shape was the exception: hv2 ran at load1 ≈ 90 and hid its gain; it became item 3.
   - Dropped: a two-accumulator-chain shape (30–45 % slower, and one build miscompiled it) and wrong-result diagnostic modes.
9. **Item 3 (`12087ec`, default on): the default shape becomes `g2q`.** q is re-read from L1 per key block instead of held in 32 registers.
   - **Bitwise equal to `g2`:** asserted by the unit test, and 42/42 · 42/42 at server level.
   - **Faster:** in a rotated-order A/B over every chunk of a cold prefill, the whole-prefill attention time falls to **0.84–0.85× of `g2`** (mean of 4 runs; 0.86–0.91× in the two runs where `g2` went first). `TH_PREFILL_ATTN_VARIANT=g2` keeps the held-q kernel.

## 1. What changed

| commit | item | default | files |
|---|---|---|---|
| `70409a9` | **E1** fused causal prefill attention + integration + probes + tests | **on** (`TH_PREFILL_ATTN=eager` = old path) | attn_kernel.rs (+862), qwen35.rs (+121), attn_bench.rs (+158), main.rs (+91) |
| `3c33c30` | kernel shape variants (`TH_PREFILL_ATTN_VARIANT`), bench occupancy print, tests over every shape, probe noise floor | off. Default `g2` = item 1's algorithm, but **not bitwise equal** to it (§5) | attn_kernel.rs, attn_bench.rs, main.rs, qwen35.rs |
| `12087ec` | default `g2` → `g2q` (q re-read per key block) | **on** (bitwise equal to `g2`; `TH_PREFILL_ATTN_VARIANT=g2` = the held-q kernel) | attn_kernel.rs (DEFAULT + docs + test), qwen35.rs (docs) |

**Kernel** (`attn_kernel.rs` `PREFILL_SRC` / `attn_prefill`, Metal 4 language):

- **Grid and threadgroups:** grid (query blocks, KV heads), 128 threads (2 row groups × a simdgroup pair).
  - A threadgroup owns 32 fused rows of one KV head.
  - A fused row is (query row, q head of the group), so the group's 6 heads share every K/V fragment load.
- **Per 32-key block:**
  - q·kᵀ over each simdgroup's half of the head dim: 8 MPP 16×32×16 matmuls, bf16 × bf16 → f32. The final default re-reads the q fragment per block rather than holding the 128-channel half in registers.
  - The pair adds its partial scores through threadgroup memory: two barriers, and a + b == b + a, so both halves hold identical scores.
  - Scale folded with log2(e); a per-row causal limit (`pos + row`); keys ≥ kv are never loaded, so exact-length caches are safe.
  - Online softmax in f32 (MLX's row-reduction order).
  - O rescale, then f16 probabilities × 2^15, then P·V over the simdgroup's half: 8 matmuls, half × bf16 → f32.
- **Epilogue:** `O · 1/(sum·2^15)`, sigmoid gate from the packed qkv lanes (as `attn_decode`), written as the `[seq, 24·256]` rows o_proj consumes.
- **Determinism and invariance:**
  - Key blocks are absolute (0, 32, 64, …) and processed in order.
  - Key 0 is visible to every row, so the running max is finite after block 0.
  - Later fully masked blocks add exact zeros and a factor of exactly 1.0, so a row's result is independent of its chunk and tile.
  - Tested bitwise: rows 40–99 of a [0,100) chunk == a [40,100) chunk, every shape.

**Integration** (`qwen35.rs`):

- **Routing:** `attn_forward` routes a chunk to the fused kernel when all of these hold: seq > 8, Metal, bf16, a supported geometry, a compiled pipeline (`prefill_attn_variant`), and no `TH_PREFILL_ATTN=eager`. TurboQuant slots keep `attn_quant`.
- **K/V storage:** stored exactly as before: in place into the KV-capacity buffer, or (re)allocated / exact-length when `TH_KV_CAP_PREFILL=0`. The kernel then reads the cache rows `0..pos+seq`.
- **Copies removed:** in the in-place case the exact-length `cat` (two [4, kv, 256] copies per layer) and the host-built causal mask are no longer made.
- **Knobs, read once:** `TH_PREFILL_ATTN=eager`, `TH_PREFILL_ATTN_VARIANT`, `TH_PREFILL_ATTN_GATE=0`.
- **Probe hook:** one atomic A/B hook (`prefill_attn_force_eager`) serves the in-process probe. It is a relaxed load, not an env read.
- **Unchanged / safe:**
  - `/status` and `th_stats` are unchanged.
  - No `MetalStorage::new(buffer.clone())`: outputs are `outbuf::kernel_out`, and each element is written once (the grid covers every row; padding rows are never stored).

**Probes and tests:**

- `TH_BENCH_PREFILL_ATTN=seq:kv,...` (no model): grouped eager vs sdpa vs fused variants, and max|Δ| against an f32 reference.
- `TH_BENCH_PREFILL_LOGITS=N,...` (in-model):
  - Eager vs fused prefill of the 8k passage in the engine's 512-row chunks, alternated.
  - Reports per-chunk ms and logits max|Δ| / bf16 ulp / KL / top-10, against a tail-chunk noise floor.
- Unit tests:
  - `prefill_library_compiles`, `nax_fragment_mma_matches_cpu`.
  - `prefill_attention_matches_reference`: f32 reference, both cache layouts, 11 (seq, pos) shapes off every tile boundary, gate on/off, determinism, chunk invariance, and variant equality (every 32-key shape, including `g2`, bitwise equal to DEFAULT).

## 2. Kernel-level results

### 2.1 Accuracy

- **Unit data** (q scaled so scores have std ≈3, K/V uniform ±1): 11 (seq, pos) shapes × both layouts × 13 shape variants × gate on/off.
  - Fused vs the f32 reference, worst max|Δ| **0.00208**, strict and relaxed alike [M, final hold, 3c33c30 test binary; 12087ec's suite passes the same assertions].
  - That is half a bf16 ulp at the output magnitude.
- **Bench data** (`TH_BENCH_PREFILL_ATTN`, N(0,1) K/V, score std 4, max|Δ| vs the f32 reference):

| seq:kv | grouped eager (current) | candle sdpa | **fused** |
|---|---|---|---|
| 512:512 | 0.0695 | 0.0308 | **0.0141** |
| 896:1408 | 0.1020 | 0.0362 | **0.0146** |
| 24:1432 | 0.0452 | 0.0213 | **0.0078** |
| 126:7550 | 0.0829 | 0.0240 | **0.0078** |
| 512:4096 | 0.1078 | 0.0371 | **0.0148** |
| 512:7168 | 0.0993 | 0.0273 | **0.0079** |

- **Why fused and eager differ:**
  - The eager path rounds scores, the masked scores and the probabilities to bf16.
  - The fused kernel keeps scores and statistics in f32 and rounds probabilities to f16.
  - So fused vs eager differences (0.07–0.11) are almost entirely the eager path's own error.

### 2.2 Speed

**Kernel shapes** (per attention layer, host-synced, median of 7 × `reps` calls, 4 rotating K/V sets; hold hv1 10:55, load1 ≈19, thermal 0–1; build e1v):

| seq:kv | grouped eager | candle sdpa | **g2** (item-2 default) | g1 | g4 | ph2 | g2x | g1x | g2s | g1s | g2k64 | g1k64 | g1k64x | g1k64xs | g2c † | g1c † | g2xcs † | g1xcs † |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 512:512 | 3.70 | 0.896 | 0.384 | **0.363** | 0.405 | 0.394 | 0.398 | 0.387 | 0.391 | 0.393 | 0.514 | 0.466 | 0.554 | 0.501 | 0.532 | 0.468 | 0.572 | 0.570 |
| 896:1408 | 17.56 | 3.086 | 1.910 | **1.852** | 1.998 | 1.869 | 2.015 | 2.015 | 1.925 | 1.986 | 2.513 | 2.410 | 2.897 | 2.623 | 2.773 | 2.520 | 3.050 | 3.205 |
| 24:1432 | 0.85 | 0.498 | 0.583 | 0.598 | 0.494 | 0.460 | 0.453 | **0.431** | 0.480 | 0.496 | 0.536 | 0.501 | 0.500 | 0.476 | 0.535 | 0.484 | 0.533 | 0.527 |
| 126:7550 | 13.29 | 3.898 | 2.435 | 2.387 | 3.074 | 2.399 | 2.527 | **2.376** | 2.551 | 2.595 | 3.288 | 2.974 | 3.485 | 3.022 | 3.578 | 2.837 | 3.611 | 3.362 |
| 512:4096 | 30.77 | 6.009 | **4.491** | 4.652 | 4.954 | 4.744 | 5.014 | 4.977 | 4.926 | 5.172 | 6.233 | 6.285 | 7.295 | 6.391 | 6.908 | 6.280 | 7.501 | 7.701 |
| 512:7168 | 53.70 | 9.737 | 8.156 | 8.196 | 8.486 | **8.120** | 8.561 | 8.616 | 8.295 | 8.697 | 10.953 | 10.952 | 12.980 | 11.119 | 11.716 | 11.355 | 12.638 | 14.166 |

- Times are ms per attention layer (median). **Bold** = the fastest kept shape in the row.
- † = two-accumulator-chain shapes. They are **not in the final build**: 30–45 % slower, and `g2xcs` miscompiled in build e1w (max|Δ| 1.92 vs the f32 reference at seq 9, `logs/hv2/tests_prefill.txt`; correct in e1v, same source semantics).
- **Headline, per attention layer:**
  - 6–10× faster than the grouped eager path on 512–896-row chunks.
  - 1.2–2.4× faster than candle sdpa, which runs one q head per threadgroup on the ALU MMA path.
  - About 2× faster than grouped on hit suffixes (24–46 rows). Those launch only 20–36 threadgroups, so the GPU is under-filled; a key split would help there (§6).
- **Where the time goes** (hv2 diagnostics under load1 ≈90, every column 25–50 % inflated): removing the softmax, the P·V matmul or the q·k matmul made the kernel *no faster*.
  - Item 3 is consistent with register pressure / occupancy: the same work with 32 fewer live registers is ≈15 % faster.
  - That points at latency hiding (K/V fragment loads issued right before each matmul, the exchange barriers), not arithmetic [E].

**Whole cold prefills, per layer** [M, final hold, chunk bench at 16:15, load1 13–18, thermal 1→2; the 512-row chunks of the grid plan; `logs/final/bench_chunks.txt`, `bin/ptotals.py`]:

| prompt tokens | chunks | grouped eager ms/layer (×16 per prefill) | sdpa ms/layer (×16) | `g2` ms/layer (×16) | **`g2q` (final) ms/layer (×16)** | final vs grouped | final vs sdpa |
|---|---|---|---|---|---|---|---|
| 512 | 1 | 3.76 (60) | 0.92 (15) | 0.39 (6) | **0.32 (5)** | 11.9× | 2.9× |
| 1450 | 3 | 22.7 (363) | 5.3 (85) | 2.91 (47) | **2.65 (42)** | 8.6× | 2.0× |
| 4096 | 8 | 160.1 (2562) | 32.6 (522) | 23.26 (372) | **20.56 (329)** | 7.8× | 1.6× |
| 7900 | 16 | 548.0 (8767) | 106.7 (1707) | 82.73 (1324) | **73.46 (1175)** | 7.5× | 1.5× |

(The server's cold 1.45k plan is [512, 896, 41] rows, not the grid. The totals above are the probe's grid plan, the same as §2.3.)

**Item 3: `g2` vs the q-reload shapes, whole cold prefills** [M, final hold 16:15–16:42, load1 13–18, thermal 2]:

- Four runs over all 17 chunk shapes: the chunk bench above plus three rotated-order rounds from `bin/extra_q.sh`. Each variant runs right after the others on the same K/V (`logs/final/q/rotated_summary.md`).

| N (tokens) | `g2` mean of 4, ms/layer (×16) | `g2q` mean (×16) | `g2q`/`g2` (range over the 4 runs) | `g1q`/`g2` |
|---|---|---|---|---|
| 512 | 0.44 (7) | 0.37 (6) | 0.839 (0.748–0.933) | 0.811 |
| 1450 | 3.06 (49) | 2.57 (41) | 0.840 (0.763–0.908) | 0.842 |
| 4096 | 23.70 (379) | 20.06 (321) | 0.846 (0.819–0.884) | 0.829 |
| 7900 | 92.55 (1481) | 78.50 (1256) | 0.848 (0.779–0.896) | 0.836 |

- **Orders:** `g2,g2q,g1q` (chunk bench), `g2,g2q,g1q`, `g1q,g2q,g2`, `g2q,g1q,g2`.
- **Position effect:** a mild one exists. Between the two equal-speed q shapes, the later one ran −1 % to +7.5 % relative to the earlier. But `g2` was the slowest in every run, including both runs where it went first. Those two runs are the conservative bound: 0.86–0.91× at 1450–7900 tokens (0.82–0.88× at 512).
- **`g1q` vs `g2q`:** within noise (0.985× mean). `g2q` keeps `g2`'s threadgroup shape, so it is the default.
- **Per shape:** `g2q` beat `g2` on all 17 chunk shapes in the first run (−9 to −19 %, except 426:1450 at −3 %).
- **Why hv2 missed it:** hv2 (load1 ≈ 90) had it mixed, from −17 % to +14 % per shape, which is why item 2 left it off.

**Item 1 vs item 2 default, same speed** [M, ABAB `70409a9`/`3c33c30`/`70409a9`/`3c33c30`, `g2`, 6 shapes, thermal 2; `logs/final/equiv_*.txt`]:

- Summed medians 20.86 vs 20.98 ms (+0.6 %); per shape −2.8 to +12 %, noise at thermal 2.
- On the same seeded inputs the fused-vs-grouped max|Δ| differs between the builds (896:1408 0.0938 vs 0.1005; 126:7550 0.0781 vs 0.0850). The kernels are not bitwise equal (§5).

### 2.3 In-model prefill (`TH_BENCH_PREFILL_LOGITS`, passage8k ids, 512-row chunks, synced per chunk, eager/fused alternated ×3)

| prompt tokens | eager ms | fused ms | Δ | session |
|---|---|---|---|---|
| 1450 | 2385 / 3139 | 2067 / 2661 | −318 / −478 ms (1.15× / 1.18×) | 09:48 (item-1 build, load1 ≈21) / hv1 10:57 (e1v, ≈22, thermal 2 at the end) |
| 4096 | 7953 / 10532 | 6201 / 8469 | −1.75 / −2.06 s (1.28× / 1.24×) | |
| 7900 | 21620 / 24104 | 14377 / 16471 | **−7.24 / −7.63 s (1.50× / 1.46×)** | |

Per-chunk growth at 7.9k:

- The eager chunk time rises from 0.9 s to 1.8–1.9 s as keys grow to 7.7k.
- The fused chunk time rises from 0.80 s to 1.0–1.1 s. The residual growth is larger than the kernel bench alone predicts, so part is thermal/clock.

Logits at the last prompt position (hv1, build e1v):

| N | fused vs eager | noise floor: eager + 24-row tail chunk vs eager grid | fused + tail vs fused grid |
|---|---|---|---|
| 512 | max\|Δ\| 0.156 (5 ulp at 5.8), KL 6.6e-7, top-10 max\|Δlogp\| 0.125, argmax =, top-10 10/10 | 0.188, KL 1.2e-6, 9/10 | 0.156, KL 1.0e-6 |
| 1450 | 0.250, KL 6.6e-4, 0.114, =, 10/10 | 0.133, KL 6.3e-4, 10/10 | 0.156, KL 2.9e-5 |
| 4096 | 0.500, KL 1.2e-3, 0.078, =, 10/10 | 0.406, KL 9.4e-4, 10/10 | 0.203, KL 8.4e-4 |
| 7900 | 0.156, KL 6.0e-7, 0.125, =, 10/10 | 0.164, KL 2.7e-7, 10/10 | 0.125, KL 5.0e-7 |

- The eager path is itself invariant to the chunk size for chunks > 128 rows (512 vs 256: 0 differing logits). Only a small tail chunk (≤ 128 rows, other GEMM tiles) moves it.
- That tail split is what the default prefix-cache plan does for every chat prompt.

- **The final build (12087ec) was not re-probed.** A queued 5-minute `TH_BENCH_PREFILL_LOGITS` hold (`bin/hold_logits.sh`) was cancelled unrun behind two other lanes' multi-hour sessions.
- **Why the numbers above still apply:**
  - The final kernel differs from the probed ones only in f32 rounding: it passes the same f32-reference bound (0.00208 on unit data), and its server identity class vs base is unchanged (§4).
  - The fused kernels are 5–13× closer to the f32 reference than the eager path (§2.1). So fused-vs-eager logit differences are dominated by the eager path's own bf16 error, whichever fused build is used.
- **Reproduce:** `$P/bin/gpu-lock -- bash $W/bin/hold_logits.sh` (writes `logs/final/logits_final.txt`).

## 3. Server A/B (session s1 on item 1 `70409a9`, 10:03–10:55, one gpu-lock hold)

- **Harness** (`$W/bench/s.sh`, `pa_client.py`, from integration-3's `bq_client.py`):
  - ABBA arms base_1 → new_2 → new_3 → base_4, fresh server per arm on :8051 (`TH_DEBUG_TIMING=1`), `--draft`, T=0 unless noted, max_tokens 128.
  - Warm-up: short prompt, then passage + "Say hi.".
  - greedy 3×3; ctx1500 3×3 (warm 1.4k-prefix hits).
  - ctxcold: 3 prompts × 3 unique nonces `Note k.` (cold ≈1.45k).
  - ctx8k: 3 prompts on the 7.9k passage (the first cold-ish, then other questions after the same document).
  - ctx8kcold: 3 unique nonces `Mark k.` + 7.9k passage (cold), each followed by its exact repeat.
  - 8k requests wait (outside the timed window, ≤ 240 s) for thermal level 0.
  - A phys_footprint sampler (fpguard 64 GB) ran over both binaries all session: no guard event.
- **Conditions:**
  - The machine was heavily shared: unrelated `golangci-lint` at ~8 cores, a VM, other lanes. load1 at request start was 9–49 (base arms median ≈21, new arms ≈10–17).
  - The per-arm gate (thermal 0 + load1 < 12 held 20 s) timed out at 300 s on every arm and proceeded.
  - Thermal at request start: 0 on 129/144 requests; 1–2 on 15, mostly at the end of base_4's ctxcold and base_1's first ctx8k.
  - Same-binary spread is therefore large (greedy ms/round 41.25 vs 46.37 between the two base arms). ABBA pooling is the reliable figure.

| arm | cold 1.45k TTFT mean (9) | cold 7.9k TTFT (3) | 8k exact repeat (3) | warm 1.4k hit mean (9) | greedy ms/round | load1 median | requests at thermal ≠ 0 |
|---|---|---|---|---|---|---|---|
| base_1 | 2602 | 22.0 / 20.5 / 28.5 s | 508 / 565 / 685 ms | 141 | 41.25 | 21.1 | 2/36 |
| new_2 | 2310 | 13.4 / 13.6 / 12.3 s | 352 / 848 / 404 ms | 132 | 42.41 | 17.3 | 1/36 |
| new_3 | 2524 | 12.2 / 13.8 / 12.7 s | 320 / 336 / 409 ms | 128 | 41.98 | 10.2 | 0/36 |
| base_4 | 2877 | 19.1 / 19.6 / 18.3 s | 475 / 3699 / 573 ms | 137 | 46.37 | 20.3 | 5/36 |

Pooled (both arms; `$W/bench/s1/analysis.md`):

| mode | n / binary | TTFT mean / median base → new | ms/round base → new (ratio) | tok/round base / new | peak fp GB base → new (max increment over pre-request) |
|---|---|---|---|---|---|
| greedy | 18 | 149 / 158 → 142 / 147 | 43.81 → 42.20 (**0.963**) | 3.843 / 3.843 | 21.6 → 21.3 (+0.1 / +0.1) |
| ctx1500 | 18 | 139 / 149 → 130 / 137 | 42.69 → 42.46 (0.995) | 3.822 / 3.822 | 21.9 → 21.7 (+0.4 / +0.4) |
| ctxcold | 18 | **2739 / 2662 → 2417 / 2458** | 43.10 → 45.51 (texts differ) | 4.275 / 4.143 | 27.0 → 25.6 (+2.0 / +1.7) |
| ctx8k | 6 | 9407 / 1858 → 5645 / 1702 | 44.56 → 44.44 | 3.861 / 3.900 | 37.0 → 29.2 (+11.4 / +4.7) |
| ctx8kcold | 6 | **21320 / 20038 → 13011 / 13068** | 44.83 → 44.79 | 3.658 / 3.795 | **47.5 → 31.7 (+11.4 / +5.0)** |
| ctx8krep | 6 | 1084 / 569 → 445 / 378 | 45.69 → 44.64 | 3.658 / 3.795 | 38.6 → 28.0 (+0.5 / +0.2) |

- **Decode.** The verify path (≤ 8 rows) returns before any changed code, so decode is untouched by construction.
  - The greedy ratio of sums over identical texts is 0.963, and ctx1500's is 0.995. The 8k decode rounds are equal or faster.
  - ctxcold's ms/round moves because its texts differ (tokens/round 4.275 vs 4.143) and new_3 ran it at 46.98 vs new_2 at 44.03: noise.
- **Cold 7.9k.** base_1's 28.5 s request ran at load1 22 after two at load1 38–41. Without it, the base mean is 19.9 s, and new is still −6.9 s (−35 %).
- **Engine-side prefill rate** (th_stats `prefill_tps`, host enqueue): ctxcold 1784 → 2822 tok/s median, ctx8kcold 414 → 636. With the mask and cat gone, the host enqueues the forwards faster.
- **Carrying these to the final build:**
  - Item 2 runs at the same speed as item 1 (§2.2), and item 3 is ≈15 % less prefill-attention time on top.
  - Decode is untouched by construction in all three.
  - The final build's server-level identity and gates are in §4–§5. Its cold TTFT was not re-measured at server level: the expected extra −4 to −225 ms is below the s1 spread.

## 4. Identity

- **T=0, base vs item 1** (s1, emitted id streams from the `[dflash]` logs, per (mode, prompt, iteration), every arm pair base_1/base_4 × new_2/new_3): **26/36 identical**.

| mode | identical | first divergence (emitted-id index) |
|---|---|---|
| greedy (3 × 3) | 9/9 | — |
| ctx1500 (3 × 3) | 9/9 | — |
| ctxcold (3 × 3) | 3/9 (short) | code #1 @113, #2 @38, #3 @54; long #1 @67, #2 @14, #3 @52 |
| ctx8k (3) | 1/3 (short) | code @29, long @20 |
| ctx8kcold (3) | 2/3 | code @29 |
| ctx8krep (3) | 2/3 | code @29 |

  - **Why they differ:** these are not bitwise-equal kernels, so near-ties can flip. The positions are the known near-tie class: integration-3 found i3 vs main at ctxcold code #1 @113, long #2 @14, long #3 @52, and ctx8k code @29/30.
  - **What stays identical:** short prompts and the bench prompts are identical everywhere, including the 58–80-row bench-prompt prefills and the 1.4k warm hits (whose checkpoints were captured through the fused kernel).
- **Determinism:** base_1 vs base_4 36/36, new_2 vs new_3 36/36.
- **Final build vs base** (prefix-cache spec_a3, 43 requests / 42 compared, final hold; `logs/final/gates/cmp_*.md`):

| pair | identical texts · round logs |
|---|---|
| base e452a7b vs 3c33c30 (= final 12087ec bitwise) | 21/42 · 9/42 |
| base vs item 1 70409a9 | 28/42 · 9/42 |
| `TH_PREFILL_ATTN=eager` (3c33c30 binary) vs base | **42/42 · 42/42** |
| item 1 vs item 2 | 21/42 · 12/42 |
| final 12087ec vs 3c33c30 | **42/42 · 42/42** |

  - **Where the final build diverges from base:** it matches base on the 58-token short prompts. It diverges on the 68-token code prompt (T=0 text at char 105) and in round logs of the 80-token prompt; item 1 matched base on both in s1.
  - **Why that is not an accuracy statement:** each build flips a different subset of near-ties. The fused kernels are 5–13× closer to the f32 reference than the eager path (§2.1).
  - **Max|Δ| on logits:** the last-prefill-position figures are in §2.3.

## 5. Gates (final hold 16:14:56–16:47:23; lock acquired after a 1 h 56 min wait; load1 13–58, thermal 1–2; `logs/hold_final2.out`, `logs/final/`)

| gate | build | result |
|---|---|---|
| V-build: `cargo build --release` + `cargo test --release --no-run` | 3c33c30, 12087ec | 0 warnings each; rebuilds bit-identical to the frozen binaries |
| full unit suite | 3c33c30 / 12087ec | **81 passed, 0 failed, 1 ignored** / **81 passed, 0 failed, 1 ignored** (12087ec's suite also asserts `g2` == DEFAULT bitwise) |
| prefill kernel tests | 3c33c30 | 3/3; f32 reference worst max\|Δ\| 0.00208 (strict and relaxed); chunk invariance 0/368640 differing elements for ph4, g2, g1, g4r, g2k64, g1k64xs, g2xsq |
| `TH_TEST_ROLLBACK=1 TH_BATCH=2`, 18 tokens | 3c33c30 | **rc 0**; state-bitwise PASS; prefix restore at 16 slot0→0 / slot0→1: logits≠0 state≠0 verify≠0 checkpoint≠0; logits verdict PASS (worst 0.129 at kept=1, argmax 68/68/68) |
| `TH_TEST_ROLLBACK=1`, TH_BATCH=1 | 3c33c30 | **rc 0**; state-bitwise PASS; prefix restore PASS; verdict PASS |
| `TH_TEST_ROLLBACK=1 TH_BATCH=2`, 1450 tokens (prefill through the fused kernel; restore at 1448) | 3c33c30 / 12087ec | **rc 0 / rc 0**; state-bitwise PASS; prefix restore slot0→0 / slot0→1 0 diffs; per-kept \|Δ\| kept=1 0.156, kept=4/7/8 0.000 (identical numbers on both builds) |
| same probe, reference arms | base e452a7b / 3c33c30 + `TH_PREFILL_ATTN=eager` | rc 0 / rc 0; kept=1 0.219, kept=4/7/8 0.000 |
| `TH_GDN_COMMIT=step` discrimination | 3c33c30 | **rc 1** as designed (state-bitwise mismatch detected) |
| TH_BATCH=2 smoke (`TH_SAMPLE=check`, `--draft`): batch2_client, pc_batch2, batch2_long (1.45k and 8k pairs) | 3c33c30 | 35/35 HTTP 200, 0 errors; samplecheck **311 rounds, 0 mismatches**; under 2 slots hit == miss (code, long, also after concurrent pairs); T=0 reproducible across repeats; 0 panics / WARN / ERROR; 0 eager fallbacks |
| prefix cache on vs `=miss` (spec_a3) | 3c33c30 | **42/42 · 42/42** (hit == miss); on-arm `/status`: hits 17, misses 26, inserts 17, evictions 7, errors 0 |
| prefix cache on vs `=0` | 3c33c30 | 33/42 · 21/42: the default plan's known numerics class vs the grid plan (integration-3 35/42, th/e-ttft-regression 31/42); `=0` vs `=miss` the same 33/42 · 21/42 |
| `TH_PREFILL_ATTN=eager` vs main e452a7b | 3c33c30 | **42/42 · 42/42** (the old path is bit-exact) |
| `TH_KV_CAP_PREFILL=0` (exact-length caches, time-major V) vs default | 3c33c30 | **42/42 · 42/42** (both cache layouts give the same bits) |
| final vs item 2 | 12087ec vs 3c33c30 | **42/42 · 42/42**; 0 panics, 0 errors, 0 fallbacks |
| item 2 vs item 1 (expected 42/42) | 3c33c30 vs 70409a9 | **21/42 · 12/42: expectation failed** (below) |

- **Item 2 is not bitwise equal to item 1.** The 3c33c30 refactor keeps item 1's algorithm (same fragment loop, exchange layout, masks, max order, P conversion for BK = 32). It restructures the running row sum from `sum = sum·factor + s0 + s1` into `rs = sum·factor; rs += s` per fragment.
  - Under Metal's default fast-math, this plausibly changed f32 FMA contraction [E]. The ulp-level change in the row sum flips bf16 output rounding and then T=0 near-ties.
  - Both kernels pass the same f32-reference test, and they run at the same speed (+0.6 %, §2.2).
  - The item-2 report text claimed "same computation, gate `pc_e1`". That claim is corrected here and in 12087ec's commit message.
- **The 1450-token rollback probe prints `rollback test: … argmax ref=68 rb=13 ctl=68 FAIL` on every build.** That includes main e452a7b and the eager path. The exit code, set by state-bitwise + prefix-restore only, is 0 everywhere.
  - The verdict compares the argmax at `pos+4` (`v_ref`: a continuous 4-row forward, `main.rs:291–294`) with the worst kept case's logits. At 1450 tokens that case is kept = 1 (`v_test` at `pos+1`, `main.rs:351–354`, verdict `:387`), a different context.
  - The same-context comparisons are exact at kept = 4/7/8. kept = 1 is the decode path's 8-row-vs-1-row shape noise (0.156 fused, 0.219 eager), because the prefill kernel only produces the shared 1450-token prefix.
  - A probe fix (compare `v_test` with the kept case's own continuous forward) is out of scope here.

## 6. Next levers

1. **Key-split for short suffixes over long contexts:** prefix-cache hits (24–46 rows at 1.4k, 104–126 rows at 7.8k) and the last partial chunk.
   - The fused kernel launches only 20–96 threadgroups there, e.g. 2.4 ms/layer at 126:7550.
   - Fix: split the keys across threadgroups with a fixed-order reduce (N3's scheme).
   - Payoff [E]: about −30 ms on the 8k exact repeat (378 ms) and −5 ms on a 1.4k hit.
2. **Kernel throughput at long context:** the final kernel does ≈11–12 TFLOPS effective at 512:7168 (87 GFLOP of useful causal work in 7.4–7.9 ms) against a ≥ 25 TFLOPS MPP GEMM rate.
   - Item 3's register saving paid ≈15 %, and removing whole matmuls did not (hv2). Latency hiding is the lever, not arithmetic.
   - Candidates:
     - stage K/V blocks in threadgroup memory shared by the 4 simdgroups (each 16×16 fragment is read from device memory right before its matmul);
     - prefetch the next block's first fragments;
     - a 3-simdgroup-pair threadgroup now that registers are freed.
   - Payoff [E]: at most ≈0.5 s of the 13 s cold 7.9k TTFT and ≈20 ms at 1.45k.
3. **`TH_PREFILL_SYNC`:** the per-chunk pool trim past 2048 tokens was added for the eager path's transients, which are gone.
   - Measured transient at 7.9k: +5.0 GB with the trim.
   - Candidate: turning it off would save one host bubble per chunk (≈10–30 ms, 11 chunks at 8k). Needs a footprint check at 12k–16k.
4. **The rest of the cold-TTFT gap to Splash** (1.45k 2.42 s vs Splash 1.84 s in integration-3's session; 7.9k 13.0 s vs 8.0 s) is the prefill GEMM rate and the capture / KV-capacity costs: other lanes (th/e-prefill-gemm, th/e-ttft-regression).
   - **Merge note** (checked with `git merge-tree` against the current tips, then built in a detached scratch worktree, since removed; not GPU-gated):
     - **th/e-prefill-gemm @`73fe6ab`** merges cleanly.
     - **th/e-ttft-regression @`0a87c22`** (also `25dab25` before it) conflicts in one hunk of `qwen35.rs` `attn_forward`: the prefill KV store. Its `kv_cap_mode()` / `kv_store_direct` replaces `kv_cap_prefill()`.
     - **Resolution:**
       1. Take ttft-regression's store unchanged.
       2. Put E1's `let fused = prefill_attn_variant(device, seq, q.dtype(), l.n_heads, l.n_kv, l.head_dim);` before it.
       3. Put E1's `if let Some(var) = fused { drop((k_all, v_all)); return Self::attn_fused_out(l, kc, vc, &q, qkv, &gate, pos, seq, var); }` after it.
       4. Drop E1's in-place early return. The Direct store already builds no `cat`: it returns views of the capacity buffer the kernel reads.
     - **Result:** `cargo build --release` and `cargo test --release --no-run` succeed with 0 warnings on both `25dab25` and `0a87c22`. On top of ttft-regression the resolution is purely additive: 4 hunks, +109 lines in `qwen35.rs` (`$W/logs/merge_ttft_0a87c22_resolution_vs_theirs.patch`).

## Appendix A: reproduce

```sh
P=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC; W=$P/work/th-e-prefill-attn
WT=$($P/bin/wt-bootstrap th/e-prefill-attn); (cd $WT/engine && cargo build --release && cargo test --release --no-run)
# unit tests (GPU): prefill_library_compiles, nax_fragment_mma_matches_cpu, prefill_attention_matches_reference
$P/bin/gpu-lock -- $WT/engine/target/release/deps/th_engine-<hash> prefill --nocapture
# kernel bench (no model):
$P/bin/gpu-lock -- env TH_BENCH_PREFILL_ATTN=512:512,896:1408,24:1432,126:7550,512:4096,512:7168 \
    TH_BENCH_PREFILL_ATTN_VARIANTS=g2q,g2,g1q th-engine probe --model x --tokens 1
# in-model eager vs fused prefill + logits:
$P/bin/gpu-lock -- env TH_BENCH_PREFILL_LOGITS=512,1450,4096,7900 TH_BENCH_PREFILL_IDS=$P/work/th-d-longctx/bench/passage8k.ids \
    th-engine probe --model $TGT --tokens 9930,9372,53589
# server A/B (ABBA, :8051) + analysis:
$P/bin/gpu-lock -- bash $W/bench/s.sh $W/bench/s1 ; python3 $W/bench/analyze.py $W/bench/s1
# final hold: prefill tests, chunk-shape bench (-> ptotals.py), 70409a9-vs-3c33c30 ABAB, gates_e.sh,
# then extra_q.sh (rotated g2/g2q/g1q A/B, item-3 unit suite + rollback probes incl. base/eager references, pc_q arm):
$P/bin/gpu-lock -- bash $W/bin/hold_final2.sh
python3 $W/bin/ptotals.py $W/logs/final/bench_chunks.txt
# gates alone (7 prefix-cache arms incl. pc_nocap = TH_KV_CAP_PREFILL=0):
$P/bin/gpu-lock -- bash $W/bin/gates_e.sh $W/logs/gates <bin> <testbin>
python3 $P/work/integration-3/gates-tools/cmp_arms.py $W/logs/final/gates/pc pc_base pc_e1   # any pair
```

## Appendix B: cleanup

- **Processes:** every server this lane started was stopped by its script.
  - s1 arms, the gates' b2c + 7 prefix-cache arms (pids 41553, 43469, 46242, 50792, 57427, 59547, 65244, 70118), and extra_q's pc_q (85058).
  - After the hold: no listener on :8051, no process of this lane. The live :8001 engine (pid 78860) and :8000 were never touched.
- **Git:** two detached scratch worktrees for the merge checks (`$W/scratch-merge`, `$W/scratch-merge2`) were aborted and removed (`git worktree remove --force`). The main working tree was never edited, built or reset. Commits only on `th/e-prefill-attn`, not pushed.
- **Kept for reproduction:** frozen binaries in `$W/bin`: base, 70409a9, 3c33c30, 12087ec (+ test binaries), the intermediate builds e1a/e1probe/e1v/e1w/e1x, and the `*-item3-cand` copies (bit-identical to 12087ec).
- **Queued logits hold:** the `hold_logits.sh` gpu-lock waiter (pid 92403) was stopped before it acquired the lock. Nothing ran, and no process of this lane remains.
