# th-engine: engine landscape and new-model onboarding

> **What this is.** A procedure for the next "new model optimisation job" on th-engine (Qwen4, Gemma 4, an MoE or MTP-headed model, a new quant format), plus the evidence it rests on. It covers:
> - how the reference engines make new models cheap to onboard;
> - what the next models will ask of the engine;
> - a day-0 → day-N onboarding procedure;
> - what to autotune and cache per (model, GPU);
> - what to automate as a model perf CI.
>
> **Companion.** `pathway-catalogue.md` (same directory) catalogues the optimisation levers themselves. This document refers to it for per-lever detail and does not repeat it.
>
> **Written** 2026-09-28 against `main` @`b31ca91`. The engine tree there is integration-4 (`c2c1532`), per `engine/reports/perf-2026-09/phaseE/PHASEE-REPORT.md`.

**Conventions**

- Every figure carries a source. No number here is invented. A figure that came from a document no longer in the repo says so.
- Source prefixes:
  - **R:** th perf reports under `engine/reports/perf-2026-09/` (path shortened to the file name, or `phaseD/…` / `phaseE/…`).
  - **C:** th source under `engine/src/` at `b31ca91`.
  - **S:** Splash, vendored at `docs/splash/` (incoai/splash@134807b).
  - **X:** MTPLX, vendored at `docs/MTPLX/`.
  - **W:** a web source (URL in Appendix A).
- Tags: **[M]** measured (by the cited source), **[D]** derived here from cited figures, **[E]** estimate, **[I]** inference with no number attached.
- The reports refer to `$P`, `$W` and `$SP`. These are `.worktrees/_phaseC/…` and a scratchpad that no longer exists. None of the harness scripts they name are tracked in git (see §2.2 and Rec 1).

---

## 0. Summary

1. **Where th stands.**
   - The 2026-09 program took th from **0.56×** Splash 1.0 to **1.20×** in four days, on one model that was already ported.
     - Start: the quiet T=0.6 reference, 40.65 vs 72.4 tok/s (R: PHASEB-REPORT.md:103-106).
     - End: T=0, 40.49 vs 48.53 ms/round (R: phaseE/PHASEE-REPORT.md:25-27).
   - Most of the gain came from **model-agnostic methods**: removing host syncs, exact state rollback, verifying every draft row, split-key attention, GPU-side sampled acceptance, a bit-exact prefix cache, and fused prefill attention.
   - A smaller part was **shape-specific tuning**: the decode tile table and the prefill vector-epilogue tile. The lever-by-lever account is in `pathway-catalogue.md`.
2. **What a new model actually costs** is not re-tuning the kernels that exist. It is three other things:
   - (a) new operator types;
   - (b) new recurrent state that must be snapshotted, rolled back and prefix-checkpointed **bit-exactly**;
   - (c) re-establishing measurement truth. The reports show how easily that goes wrong:
     - loaded A/Bs overstated a gain by about 2× (×1.301 claimed, ×1.194 quiet; R: phaseD/th-d-gpu-tail.md:12-19, :142);
     - a throttled session flattered th by about 8% against Splash (R: bench-quiet.md:25-27);
     - three engine-reported metrics were wrong (§2.1).
3. **th-engine is a single-architecture engine today.** The assumptions are hard-wired:
   - routing by `qwen3_5*` model_type (C: model.rs:637-669);
   - MLX affine 4-bit group 64 hard-coded (C: qwen35.rs:169);
   - DFlash draft geometry as constants (C: dflash.rs:30-51);
   - a decode tile table keyed on 27B shapes at 40 cores (C: quant_kernel.rs:202-244);
   - fused prefill attention for head_dim 256 only (C: attn_kernel.rs:1611-1615);
   - GDN hard-coded to a 4-tap conv and DK == DV (C: gdn_kernel.rs:1160);
   - ChatML-only prefix-cache turn marks (C: engine.rs:482-496).

   §4.6 lists each assumption and what it breaks.
4. **How the reference engines onboard models:**
   - **Splash:** closed, compile-time layouts, validated field by field against a package manifest (S: runtime/model/ModelDescriptor.mm:135-145, :375-400), plus an offline paired-sample autotuner that prints code, not a serving cache (S: dev/tuning/tune_kernels.mm:1-6, :523-544).
   - **MTPLX:**
     - an architecture registry with support tiers;
     - a per-pack runtime contract that carries exactness and speed evidence (X: mtplx/backends/registry.py:35-80, :650-745);
     - load-time kernel self-checks (X: mtplx/kernel_selfcheck.py:1-35);
     - per-machine tuning of speculative depth only (X: README.md:171-179).
   - **mlx-lm and llama.cpp:** config-driven model modules plus weight-name mapping. llama.cpp adds a per-op backend conformance suite (W1–W4).
5. **The next models.** Qwen4 has not shipped (W5). Its public architecture preview, Qwen3.8-Flash-Next (2026-08-26), adds:
   - a mixture of experts (512 experts, top-10);
   - a 4-branch gated residual (hyper-connections);
   - Qwen Sparse Attention with a learned indexer;
   - a 51B-parameter n-gram embedding that can be offloaded;
   - a multi-step-trained MTP head.

   Sources: W6; X: mtplx/models/qwen4_exp.py:1-34, :70-126. Its GDN geometry (16 key heads, 48 value heads, 128-dim heads, 4-tap conv) matches the 27B's, so th's GDN kernels carry over. Almost everything around them is new (§4.1).
6. **The speculative strategy is a per-model decision** (§7).
   - Qwen3.8-27B, concurrency 1, on an H200 (W7): its built-in 7-token MTP gives **1.96–2.59×** over autoregressive decode; DFlash 2 gives **2.67–3.43×**.
   - MTPLX runs native MTP heads on Apple silicon (X: README.md:15).
   - th has only DFlash, parsing Splash's packaged MDFD draft (C: dflash.rs:51), plus n-gram lookup.
7. **The procedure** (§5):
   - **Day 0:** triage, reference outputs, golden fixtures.
   - **Day 1:** correctness bring-up: op tests, logits within the noise floor, the state-bitwise gate.
   - **Day 2:** floors, then the first quiet baseline against the best competitor.
   - **Day 3:** choose the speculative strategy.
   - **Days 4–5:** autotune and write the (model, GPU) table.
   - **Day 6–N:** the lever loop.
8. **Autotuning must separate numerics classes** (§8).
   - Bitwise-identical schedule variants are safe to tune per GPU.
   - Numerics-changing variants are not: split-K versus sequential-K, split counts, precision. They change speculative acceptance on th (R: PHASEB-REPORT.md:412) and on Splash (S: dev/benchmarks/device-policy.md:13-18; dev/benchmarks/remaining-decode-optimizations.md:17-22). Tune them offline, behind identity and acceptance gates.
9. **Commit the harness first** (Rec 1).
   - Nothing in the program's benchmark and gate harness is tracked: `gpu-lock`, `wt-bootstrap`, `bq4_client.py`, `fin4d.sh`, `gates4.sh`, `fpmon.py`/`fpguard.py`, the analysis scripts. `git ls-files` finds none of them; they live under `.worktrees/_phaseC/`.
   - The program already lost its synthesis once to a scratchpad reset (R: PHASEB-REPORT.md:16; impl-th-wp2-matmul-roofline.md:38).
10. **Model perf CI** (§9), in four tiers (CI-0 to CI-3):
    - **per commit:** build, bitwise unit gates, CPU-only policy tests;
    - **per engine PR, on the GPU:** state-bitwise rollback, prefix-cache hit == miss, T=0 identity against golden ids, GPU == CPU sampling, the verify-width ladder;
    - **nightly, quiet palindrome:** ms/round, tokens/round on identical text, TTFT classes and peak `phys_footprint`, with a same-code T=0 control arm to bound noise.
    - **weekly:** a same-session competitor run and a many-seed acceptance study.

---

## 1. The job, and what "done" means

### 1.1 Metrics (use these definitions and no others)

| metric | definition | source |
|---|---|---|
| loop tok/s | Σtokens / Σround-ms over the logged `[dflash]` rounds. Excludes the first token (sampled from prefill) and the final, unlogged round. The competitor's figure comes from its own `/status` deltas. | R: PHASEC-REPORT.md:16 |
| ms/round, tokens/round | from the same sums as loop tok/s | R: bench-quiet.md:77 |
| like-for-like tok/s | [Σ(comp − 1) / Σrounds_all] / ms_round; removes the competitor's prefill-sampled token | R: bench-quiet.md:78-80 |
| tokens/round on identical text | rounds needed on byte-identical greedy text. The only fair acceptance comparison across builds or engines; different texts are trajectory noise. | R: bench-quiet.md:211-229; phaseE/PHASEE-REPORT.md:153, :214 |
| round decomposition | propose · verify host encode · verify GPU tail + readback · rest; GPU-busy and idle from the ioreg slope | R: PHASEC-REPORT.md:149-169 |
| TTFT classes | short; cold ≈1.45k; repeated prefix; exact repeat; another question after the same document; multi-turn; cold ≈7.9k | R: phaseE/PHASEE-REPORT.md:170-184 |
| memory | peak `phys_footprint` via `proc_pid_rusage`. **Not** RSS, which cannot see candle's private Metal pool. | R: phaseD/th-d-longctx.md:447-451 |
| identity | T=0 emitted-id streams plus text sha; first divergence as a re-tokenized index; strip `</think>` before comparing | R: bench-quiet.md:84-86 |

**Modes.** Every standing is reported per mode, each as the per-round ratio × the tokens/round ratio (R: PHASEC-REPORT.md:74-81):

- greedy (T=0);
- sampled (temperature 0.6, top_p 0.95, top_k 20, seeds 1/3/5);
- ctx1500 (warm prefix);
- ctxcold (a nonce makes the prefix cold);
- ctx8k.

### 1.2 Stage gates

| stage | output | exit criterion |
|---|---|---|
| D0 triage | descriptor diff against supported families; support tier; memory fit; reference outputs; fixture manifest | the reference runs, and the fixtures are committed or hashed |
| D1 correctness | model loads; per-op tests; logits; state gate; server smokes | every gate in §2.3 green; golden T=0 id streams recorded |
| D2 baseline | floors; quiet same-session standing against the best competitor | a per-mode table with conditions, build sha and binary sha256 |
| D3 speculation | drafter and verify width/depth chosen | loop tok/s for each option on the identical-text suite, plus a many-seed acceptance study |
| D4–5 tuning | a (model, GPU) table | winners confirmed in situ; identity unchanged, or re-baselined with a divergence report |
| D6–N levers | ranked lever list, one lane each | each lever: a quiet A/B, gates, a lane report, adversarial review |

---

## 2. Transferable lessons (onboarding-relevant subset)

The full lever catalogue is in `pathway-catalogue.md`. This section keeps only what a new-model job must carry over **before** any speed work: which metrics to trust, how to run a session, the correctness gates, and the bug classes to look for.

### 2.1 Metrics that lied (re-check each one on a new model)

| what lied | by how much | fix / rule | source |
|---|---|---|---|
| `th_stats.prefill_tps`, timed at enqueue with no sync | overstated about 3.7× (1890–2380 reported vs 465–630 tok/s wall) | use client TTFT, or sync before stopping the timer. Phase D deliberately used the enqueue figure as a *host-enqueue* measure. | R: bench-quiet.md:282-286; PHASEB-REPORT.md:354; phaseD/PHASED-REPORT.md:164 |
| batch `decode_tps` stopped at encode (bug M1) | 126.1 reported vs 50.1 tok/s wall | time to readback | R: PHASEB-REPORT.md:249-258 |
| the `[verify] enqueue` log line | includes propose | time it from the end of propose | R: PHASEB-REPORT.md:355 |
| ioreg GPU-busy on th | double-counts overlapping command buffers | treat as an upper bound; idle is then a lower bound, and can go negative | R: PHASEB-REPORT.md:681; PHASEC-REPORT.md:72 |
| `ps` RSS | 4.2 GB RSS at a 119 GB footprint | watchdogs read `phys_footprint` | R: phaseD/th-d-longctx.md:447-451 |
| sampler seeding with `seed \| 1` | seeds 2k and 2k+1 give the same stream | use odd seeds | R: PHASEB-REPORT.md:349 |
| no seed sent | T=0.6 output is deterministic: 3 distinct samples, not 9 | send seeds | R: PHASEB-baseline.md:164 |
| R0c profiler with one command buffer per op | about +5 µs per CB; the profiled arm ran +9.3 ms/round | use it to *rank* kernels, not to measure savings | R: phaseD/th-d-gpu-tail.md:40, :76-79 |
| kernel micro-bench rankings | `TH_BENCH_Q4`'s `+ps` arms mis-rank the N256 PreSums tiles | only the in-process whole-forward A/B decides policy | R: impl-th-wp2-matmul-roofline.md:155-157 |
| isolated GEMM harness rate | in situ ≈70–75% of the isolated rate | quote in-situ TFLOPS | R: phaseE/th-e-prefill-gemm.md:287 |
| sampled tokens/round from 9 fixed streams | Phase C's 0.894× gap was mostly noise: 1.002× over 75 streams | run many seeds and prompts; Rao-Blackwellise | R: phaseD/th-d-sampled.md:34, :60-81 |
| mean tok/s as a smoothness measure | hid 22–30 gaps ≥ 200 ms per turn | record p95/max inter-emit gaps | X: mistakes/mean-tps-and-sliding-averages-…md:3-36 |

### 2.2 Session protocol (the quiet A/B)

1. **One exclusive GPU lock** around every GPU-timed run: `gpu-lock`, a flock on `/tmp/th-engine-gpu.lock` (`.worktrees/_phaseC/bin/gpu-lock`, untracked). Builds need no lock.
2. **Frozen binaries**, identified by sha256.
   - Start a fresh server per arm, on a private port.
   - Run a competitor on its own port, never beside a th server. Splash's memory governor refused to start with th resident (R: PHASEB-baseline.md:157).
   - Verify binary provenance before any verdict. MTPLX A/B-tested a stale binary twice (X: mistakes/two-ab-rounds-measured-a-stale-2-7-binary-…md; mistakes/piped-build-output-masked-…md).
3. **Palindrome arm order**, so every engine has one arm in each half (R: PHASEC-REPORT.md:42; phaseE/PHASEE-REPORT.md:62-63).
4. **Gate every arm, and redo contaminated arms.**
   - Gate on thermal pressure level 0, 1-min load below a threshold held for 30 s, CPU idle, and other processes' GPU ms/s.
   - Redo an arm when a set share of its requests start at thermal ≥ 2 or at high load.
   - Sources: R: bench-quiet.md:61-65; phaseD/PHASED-REPORT.md:50; phaseE/PHASEE-REPORT.md:64; phaseD/th-d-gpu-tail.md:115-117.
5. **Record per request, outside the timed window:**
   - server-log byte offsets;
   - the competitor's `/status` deltas;
   - ioreg GPU ms and `ps` CPU ms of the engine;
   - load and thermal level.

   Source: R: bench-quiet.md:74.
6. **Sampling and aggregation.**
   - Always send explicit sampling parameters (0.6 / 0.95 / 20) and odd seeds.
   - Report ratio of sums, plus per-arm drift.
   - A quiet replicate (Phase E's S2) is the standing; a loaded replicate is only a cross-check (R: phaseE/PHASEE-REPORT.md:54, :109).
7. **Thermal state is a first-order variable.**
   - Throttling cost Splash 11% and th 3% (R: bench-quiet.md:25-27, :291-294).
   - Back-to-back cold 8k prefills reach thermal level 2 within one request (R: phaseD/PHASED-REPORT.md:48).
   - An ABBA order does not cancel a *saturating* thermal drift. Cool down to the starting die temperatures between arms (X: mistakes/back-to-back-ab-arms-…md:9-19).
8. **Paging.** Under swap, idle gaps let the compressor page the model out. Run TTFT requests back to back (R: phaseE/th-e-prefill-gemm.md:206; phaseE/th-e-ttft-regression.md:57-60).
9. **Memory guard.**
   - Run a `phys_footprint` guard on every long-prompt process.
   - Keep in-model probes at ≤ 7.9k keys.
   - A 32k in-process probe once reached 130.9 GB resident on the 128 GB machine and rebooted it (R: phaseD/th-d-longctx.md:442-451, :495).
10. **th is host-sensitive.**
    - At load 26–49, th's round rose from 63.1 to 104.5 ms (R: PHASEB-REPORT.md:129-133).
    - Even after host idle was removed, a saturated CPU still costs 5–14% (R: phaseE/PHASEE-REPORT.md:109).
    - Quiet windows are scarce on this shared machine: load1 never fell below 6 in the 124 one-minute samples of one two-hour review round (R: phaseD/th-d-sampled.md:297).

### 2.3 Correctness gates

| gate | proves | how | source |
|---|---|---|---|
| bitwise kernel unit tests with a one-ulp mutation check | a new kernel reproduces the old one bit for bit, and the test can fail | `cargo test --release`; each test must fail under a one-ulp mutation | R: phaseD/th-d-gpu-tail.md:60; phaseD/PHASED-REPORT.md:254 |
| reference-tolerance tests | a non-bitwise kernel is at least as accurate as the path it replaces | compare against an f32/f64 CPU reference, over layouts, tile boundaries and determinism | R: phaseD/th-d-longctx.md:264, :268-306; phaseE/th-e-prefill-attn.md:133 |
| `MTL_SHADER_VALIDATION=1` | no out-of-bounds or uninitialised reads | it caught a 2 MiB read from a 64 KiB tensor that the output compare missed | R: PHASEB-REPORT.md:152-158 |
| state-bitwise rollback (R0a) | snapshot / rollback / commit leave every recurrent-state element bit-identical to a forward of the kept rows | `TH_TEST_ROLLBACK=1 [TH_BATCH=2]` exits 1 on any mismatch. The discrimination arm `TH_GDN_COMMIT=step` must **fail**. Also run a 1450-token variant and `TH_ATTN_SPLIT_MIN=1`. | R: th-c-gdn-parity.md:95-111; PHASEC-REPORT.md:296-297; phaseE/PHASEE-REPORT.md:294-298 |
| (the rollback gate before R0a) | — | the old `TH_TEST_ROLLBACK` was not state-bitwise, and failed on untouched code | R: PHASEB-REPORT.md:350-353 |
| prefix-cache hit == miss | a restored request runs exactly the chunks its uncached prefill would run | 42/42 texts and 42/42 per-round logs, cache on vs `=miss` | R: phaseD/th-d-prefix-cache.md:12, :58; phaseD/PHASED-REPORT.md:266 |
| GPU == CPU sampling | the GPU accept kernel is bit-exact to the CPU reference | `TH_SAMPLE=check`: 0 mismatches over thousands of rounds | R: phaseD/th-d-sampled.md:94-98 |
| exactness of the acceptance rule | the distribution is preserved | enumeration on toy models, plus Monte Carlo | R: phaseD/th-d-sampled.md:119-123 |
| T=0 identity and first divergence | a change is numerically neutral, or flips only known near-ties | emitted ids across all arm pairs | R: phaseD/PHASED-REPORT.md:129; phaseE/PHASEE-REPORT.md:213 |
| last-prefill-position logits against a noise floor | a non-bitwise prefill stays inside the engine's own plan-dependent noise | `TH_BENCH_PREFILL_LOGITS`: max\|Δ\| in bf16 ulp, KL, argmax, top-10, against the tail-chunk split | R: phaseE/PHASEE-REPORT.md:312-324; phaseE/th-e-prefill-attn.md:227-237 |
| API contract | `/status` and `th_stats` only gain keys | key-path diff | R: phaseE/PHASEE-REPORT.md:309 |
| batch and mode smokes | TH_BATCH=2/4, kv/clear, no-draft, kv-quant all work | smoke clients | R: phaseE/PHASEE-REPORT.md:299-304 |

Two caveats:

- **Batch co-scheduling.** At TH_BATCH ≥ 2, greedy output depends on batch composition. Identity checks there need the same composition in both arms (R: PHASEB-REPORT.md:310-314).
- **Ties are common.** 1.68% of token-deciding T=0 rows had an exact bf16 top-1 tie (R: PHASEB-REPORT.md:203). A new model will show near-tie divergences; that is not by itself a bug.

### 2.4 Bug classes to grep for in every new kernel and port

| class | what happened | source |
|---|---|---|
| untracked `Arc` | `MetalStorage::new(buffer.clone())` let the candle pool recycle a buffer that was still live, silently corrupting state | R: th-c-gdn-parity.md:82; PHASEC-REPORT.md:305 |
| aliasing copies | in candle 0.11 Metal, `Tensor::copy()` aliases the buffer and `affine(1, 0)` flushes −0 to +0. Bit-exact copies need `slice_set` into fresh buffers. | R: th-c-gdn-parity.md:82 |
| zero-fill blits | each `Tensor::zeros` blit splits the compute encoder: +2.84 ms/round | R: PHASEB-REPORT.md:170-184 |
| shape confusion | a wrong unsqueeze caused a 2 MiB read from a 64 KiB tensor, 5× per propose, and 32× the MMA work | R: PHASEB-REPORT.md:143-168 |
| per-call env reads | `std::env::var` on the hot path | R: PHASEB-REPORT.md:339; PHASEC-REPORT.md:275 |
| first-caller pipeline caches | a pipeline compiled with the first caller's dims (MEM-12), fixed by keying on geometry (`GeomCache`) | R: PHASEB-REPORT.md:338; phaseD/th-d-longctx.md:261 |
| unguarded hard-coded dims | head_dim 256, DK 128, conv_k 4 and contiguous inputs, with no Rust-side guard (MEM-8) | R: PHASEB-REPORT.md:336 |
| position off-by-one | the DFlash anchor ran one position late | R: PHASEB-REPORT.md:319-327; fixed per phaseE/PHASEE-REPORT.md:251 |
| capacity-dependent routing | a non-page-aligned KV capacity made a prefix-cache hit and its miss take different kernels | R: phaseD/PHASED-REPORT.md:240 |
| fast-math "refactors" | FMA contraction made a same-algorithm refactor non-bitwise | R: phaseE/th-e-prefill-attn.md:339-343 |
| MPP f32 left operand | a strict-precision f32 left operand produces garbage in the NAX fragment layout | R: phaseE/th-e-prefill-attn.md:34-36 |
| pool growth | candle frees pooled buffers only at a host sync, and the pool is wired, so an unsynced chunked prefill grows roughly quadratically | R: phaseD/th-d-longctx.md:453-461 |
| command-buffer cap | candle commits every 50 encoders; 64 uncompleted command buffers block the host | R: phaseD/th-d-longctx.md:360-365 |
| implementation-defined MPP layout | the cooperative-tensor layout needs a load-time probe per shape | R: phaseE/th-e-prefill-gemm.md:122 |

---

## 3. How the reference engines make new models cheap to onboard

### 3.1 Splash (C++/Metal, incoai; vendored at `docs/splash`)

**Mechanisms**

- **Package.**
  - Layout: `manifest.json`, packed `target/`, `draft/` and `vision/` weights, and `tokenizer/`.
  - The manifest lists artifact paths, sizes and SHA-256 digests. Schema 3 is dense (`splash-packed-q4`); schema 4 is MoE (`splash-packed-q4-moe`).
  - "New architectures require engine support; ordinary HF weights need conversion." (S: DEVELOPMENT.md:116-126.)
- **Descriptor.**
  - A `ModelDescriptor` is a closed `std::variant` of compile-time layouts (`Qwen3_8Layout`, `Qwen3_6MoeLayout`), plus draft and vision layouts, capabilities, and the KV and state layouts (S: runtime/model/ModelDescriptor.hpp:17-34).
  - The layouts are constexpr geometry: capture layers, mask and stop tokens, GDN and attention widths (S: runtime/model/Qwen3_8.hpp:19-70; runtime/model/Qwen3_6Moe.hpp:19-76).
- **Validation.** `inspectModelPackage` dispatches on `format.name`. Every execution-semantic field in the manifest must *equal* the runtime's constant (S: ModelDescriptor.mm:23-31, :135-145, :375-400). It also validates:
  - tokenizer hidden size, vocab and max positions (:184-203);
  - MoE layer types and capture layers (:222-251).
- **One execution contract**, compile-time (S: runtime/model/Model.hpp:261-281):
  - max batch 4;
  - prefill budget 2048;
  - 8 draft query rows;
  - 7 proposals;
  - 8 verify rows;
  - 2048 tokens of draft context.
- **Weights.** 16 KiB-aligned sections of a no-copy mmap Metal buffer; Q4 group 64; storage N 256 (S: runtime/model/WeightStore.hpp:16-20, :35-55).
- **Operator choices.**
  - `ExecutionPlans` holds `OperatorChoices`: a map from workload (shape × rows or lanes × phase × epilogue) to a kernel configuration.
  - Missing keys use the shipped baseline.
  - Choices are installed at startup and immutable after Ready (S: runtime/ops/ExecutionPlans.hpp:23-35, :72-95).
- **`tune-kernels`, offline.**
  - Workloads come from the *loaded* package: distinct projections per shape, with representative layers retained (S: dev/tuning/TuningWorkloads.cpp:68-168). Probe sizes are rows 64/256/512/1024/2048 and decode widths 1–4 (S: dev/tuning/TuningWorkloads.hpp:15-17).
  - Samples are paired, in alternating order, 12–64 pairs. A candidate qualifies only with a timing spread ≤ 10%, a paired-gain spread ≤ 5% and a conservative gain ≥ 3% (S: dev/tuning/Tuning.hpp:23-24, :33-53, :126-139).
  - It stops on memory pressure or on `thermalState ≥ Serious` (S: tune_kernels.mm:390-394).
  - `--confirm` times whole prefill/decode graphs, defaults vs winners (S: tune_kernels.mm:273-338).
  - Output is C++ `choices.*.push_back(...)` lines under the comment "if a margin matters, change the rules in runtime/ops, not a table" (S: tune_kernels.mm:523-544).
- **Device policy: rules, not tables.**
  - Selection is by GPU family, IORegistry core count and shape (S: dev/benchmarks/device-policy.md:21-28).
  - "no … startup benchmarks or per-model/per-SKU tables" (:3-6).
  - The tuner "does not persist a serving profile" (:60).
  - "Promote a default change only after repeatable whole-model A/B results, unchanged correctness/state-restoration behavior, and acceptable speculative acceptance and memory use" (:62-66).
  - CPU-only policy tests cover 84,240 decode workload/device combinations (:76).
- **Numerics ↔ acceptance.** Two findings show numeric tests alone do not qualify a kernel:
  - Apple10 split-K one-lane defaults were withdrawn "after reproducible speculative-acceptance reductions on some M5 prompts" (S: device-policy.md:13-18).
  - A parallel softmax-denominator reduction "passed numerical tests but changed speculative acceptance enough to reduce throughput on some prompts; it was rejected" (S: dev/benchmarks/remaining-decode-optimizations.md:17-22).
- **References.** An fp32 numpy "executable specification" writes small deterministic parity fixtures (pixels, grid, fp32 embeddings), which native tests grade against (S: dev/tools/vision_reference.py:1-16; dev/tests/fixtures/vision-parity/).
- **Design stance.** "The runtime, scheduler, cache, and API are shared. Everything else is rebuilt per model": a draft trained for the model; kernels "written and tuned by our in-house kernel agents for the model's dimensions"; a memory plan computed per machine (S: README.md:155-170).

**Copy:**
- manifest validation that fails fast;
- collecting tuning workloads from the loaded model;
- the paired tuning policy, with pressure and thermal aborts and whole-graph confirmation;
- rules over tables for defaults;
- acceptance as a promotion gate;
- executable-spec fixtures.

**Do not copy:** closed compile-time layouts. There, every new model is a new C++ layout, a packer and new kernels. th should derive its descriptor from `config.json` and keep constant specialisation inside kernels, not in model identity [I].

### 3.2 MTPLX (Python/MLX + Metal; vendored at `docs/MTPLX`)

- **Architecture registry.**
  - Each row carries arch_id, family, backend, support level, runtime compatibility, aliases, config markers, family gate, references and notes (X: mtplx/backends/registry.py:99-131).
  - Tiers, with exit codes: verified, family-compatible-unverified, architecture-compatible-unverified, incompatible, no-MTP, AR-only (X: registry.py:35-45).
  - `mtplx inspect` classifies a model before anything runs: "There are no silent fallbacks" (X: README.md:263-265).
- **Per-pack runtime contract**, `mtplx_runtime.json` (X: registry.py:18, :650-745, :958-977):
  - required: `mtplx_version`, `arch_id`, `mtp_depth_max`, `recommended_profile`, `exactness_baseline`, `verified_on`;
  - optional: draft lm-head and sampler, `mtp_contract`, env overrides, a recommended generation mode with its evidence, speed evidence, `min_engine_version`.
  - Blocking statuses and verdicts include `mtp_acceptance_collapsed` and `no_mtp_depth_beat_ar` (X: registry.py:53-80).
- **MTP wiring is a contract with degrees of freedom:** base and hidden variant (pre_norm / post_norm / …), concat order, position mode, MTP quantization (X: mtplx/mtp_patch.py:49-60). The wiring must be *measured*: Hy3's head reaches teacher-forced agreement 0.773 on the post-final-norm hidden vs 0.387 on the pre-norm hidden (X: registry.py:606-614).
- **MTP is optional.** "MTP is an accelerator, never a load requirement": any checkpoint whose trunk can be built runs autoregressively at worst (X: registry.py:1307-1317). An MTP sidecar is never attached to an arbitrary trunk (X: README.md:187).
- **Names.**
  - Fresh `model_type` strings map to modules through the declared HF class (X: registry.py:1238-1252).
  - Guessed pre-release Qwen4 aliases were removed; only the T-0 strings `qwen4_exp`, `qwen4_exp_text` and `Qwen4ExpForConditionalGeneration` remain (X: registry.py:244-254).
- **Day-0 practice.**
  - Qwen 3.8 27B shipped on day one (X: HISTORY.md:46).
  - The Flash-Next backend was written from transformers' `modular_qwen4_exp.py`, read nine hours after the weight drop, reusing mlx-lm's GDN and qwen3_next MoE blocks (X: mtplx/models/qwen4_exp.py:5-34). It shipped three days after the drop (X: HISTORY.md:48).
- **Load-time kernel self-check.**
  - At model load, each engaged custom-kernel lane runs once on tiny tensors in the model's dtype and quant format, against stock MLX.
  - A mismatching lane is disabled for the process and reported in `/health`.
  - Thresholds sit about 10× above the lane's accumulation-order ULP band and about 10× below what a broken kernel produces (X: mtplx/kernel_selfcheck.py:1-35).
- **Auto-tune: depth only, per machine.**
  - Runs the real model at each MTP depth against autoregressive decode, fans pinned. It saves a depth only if one beats AR (X: README.md:135, :171-179).
  - Tune key: SHA-256 over model identity, hardware (chip, family, hw_model, machine), software versions, backend and settings (X: mtplx/commands/public.py:4532-4565).
  - Save and lookup must derive the key through one constructor. A hand-rebuilt key once re-tuned on every start (X: public.py:4483-4494; mistakes/wizard-rebuilt-the-tune-state-key-…md).
- **Quality evidence per pack:**
  - 4-bit dynamic: 96.0% top-1 agreement with bf16, KL 0.012; 8-bit: 99.3%, KL 0.0005 (X: README.md:106-108).
  - Ternary GEMV: mean KL 2.92e-6 against stock's 3.02e-6 over 1,630 teacher-forced verify positions (X: mtplx/kernels/ternary_qmv.py:17-22).
  - Stock 2-bit kernels run ALU-bound at 250–420 GB/s (X: ternary_qmv.py:7-10).
- **Exactness evidence.** 1,000 four-token samples from the fast path match 1,000 from the plain path within the plain path's own noise, at T=1, top-p 0.95, top-k 20 (X: README.md:34; HISTORY.md:52).
- **Mistakes corpus.** 43 post-mortems. The ones that apply here: thermal cooldowns, p99 emit gaps, stale binaries, and micro-benchmarks presented as real-route speed (X: `docs/MTPLX/mistakes/`).

**Copy:**
- registry plus tiers plus `inspect`;
- a per-model contract that carries its evidence;
- kernel self-checks at load;
- a one-constructor tune key;
- teacher-forced quality gates;
- native MTP as a first-class drafter.

**Note:** MTPLX's kernels sit on MLX. th owns its kernels in MSL through candle, so it inherits candle's pool and command-buffer behaviour (§2.4).

### 3.3 mlx-lm (the fastest source of a working reference)

- **Adding an architecture.**
  - A new architecture is `mlx_lm/models/<model_type>.py`, named exactly as the config's `model_type`, with `ModelArgs.from_dict` and an optional `sanitize()` for weight rewrites: MoE expert stacking, prefix strips.
  - Start from the closest existing model (W1; W2).
  - `MODEL_REMAPPING` maps HF model types to modules (W2).
- **MoE.** `SwitchLinear` / `QuantizedSwitchLinear` over `gather_mm` / `gather_qmm` (W2).
- **Quant modes.** affine, mxfp4, nvfp4 and mxfp8, with mixed-bit recipes through `--quant-predicate` (W2; W8).
- **Gotchas** that a th loader reading mlx-lm packs must not repeat:
  - per-module quantization overrides are silently dropped when `sanitize()` renames weights (W9, issue #1924);
  - FP8 compressed-tensors checkpoints silently load as 4-bit affine (W9, issue #1865);
  - NVFP4's per-tensor scale cannot be set through the converter. Perplexity is +5.03% over bf16 as shipped vs +2.60% with the scale set; affine64 is +2.71% at the same 4.503 bpw; affine128 beats mxfp4 at 4.253 bpw (W10).
- **Relevance to th.** th's fast target *is* an mlx-lm pack: `$TGT` = `mlx-community/Qwen3.8-27B-4bit` (R: impl-th-wp2-matmul-roofline.md:278). So th's loader must honour the same `quantization` config.

### 3.4 llama.cpp (the conformance model)

- **Adding a model** (W3):
  - convert with `convert_hf_to_gguf.py` and `@ModelBase.register`;
  - add the `gguf-py` `MODEL_ARCH` / `MODEL_TENSORS` entries and `tensor_mapping` block mappings;
  - use the `set_gguf_parameters` / `modify_tensors` hooks. Constant tensor edits happen at conversion; constant scales become metadata keys;
  - in C++: an `llm_arch` entry, name tables, the loader, and the graph builder.
- **Validation.**
  - `test-backend-ops` runs every op on every backend against the CPU reference, with NMSE thresholds, in test and perf modes (W4).
  - Adding `MTL_SHADER_VALIDATION` surfaces NaNs that a plain compare misses (W4).
  - `compare-llama-bench.py` and `compare-commits.sh` diff performance across commits (W4).
- **MTP.** Beta support merged 2026-05-16 (PR #22673, behind `--mtp`). Qwen3-Next MTP followed 2026-08-03 (PR #25589) (W11; X: HISTORY.md:36, :42).

**Copy:** a per-op conformance matrix (op × dtype × shape × GPU family vs reference) and a per-commit performance database [I].

### 3.5 Side by side

| | Splash | MTPLX | mlx-lm | llama.cpp | th-engine today |
|---|---|---|---|---|---|
| model identity | closed compile-time layout per package format | registry row plus per-pack contract | `model_type` → module | `general.architecture` → `llm_arch` | `model_type` prefix `qwen3_5` (C: model.rs:639) |
| onboarding unit | C++ layout + packer + kernels | Python model module + MTP wiring + evidence | one Python file | converter + C++ graph | Rust model file + custom MSL kernels |
| correctness reference | fp32 numpy executable spec, parity fixtures | stock MLX (kernel self-check); plain-path sampling | transformers | CPU backend (`test-backend-ops`) | per-kernel bitwise/f64 tests; R0a; ad-hoc logits dumps (no golden fixtures) |
| tuning | offline paired `tune-kernels` → code | per-machine MTP depth | fixed kernel heuristics [I] | hand-tuned per-backend thresholds [I] | offline sweeps (`TH_BENCH_Q4_SWEEP`, `TH_BENCH_LIN=pf`) → hand-copied table (C: quant_kernel.rs:202-219) |
| per machine | memory plan; core-count rules | depth tune; FP16 packs for M1/M2 | — | — | `gpu_cores()` from IORegistry (C: quant_kernel.rs:55-78); prefill route still defaults to 40 cores (C: quant_kernel.rs:5103-5115) |
| speculation | trained DFlash 2 draft per model | native MTP heads; Gemma assistant pairs | MTP branch (W11) | `--mtp` beta | DFlash (Splash's MDFD draft), n-gram |

---

## 4. What the next models look like, and where th breaks

### 4.1 Qwen3.8-Flash-Next = the Qwen4 architecture preview

The Qwen blog body could not be fetched; the figures below come from the SGLang day-0 post (W6), MTPLX's port (X) and a secondary summary (W5).

| component | spec | source | th today | new work |
|---|---|---|---|---|
| size | 125B main + 51B n-gram embedding, 6B active, 4B MTP head | W5; W6 | — | memory plan for a MoE at about 74–83 GB resident and 78–87 GiB peak on a Mac (MTPLX packs; X: README.md:74-75, :129-130) |
| layers | 48 = 36 GDN + 12 QSA (3 : 1) | W6 | `is_linear = (i+1) % interval` (C: qwen35.rs:100-102) | read `layer_types` from config (X: qwen4_exp.py:83, :150-156; Splash validates it: S: ModelDescriptor.mm:222-236) |
| GDN | 16 key heads, 48 value heads, dk = dv = 128, 4-tap conv | X: qwen4_exp.py:87-91 | **same** as 27B (S: Qwen3_8.hpp:31-33); fits the kernel hard-codes (C: gdn_kernel.rs:1160, :1215-1218) | re-tune for hidden 2560 |
| attention | hidden 2560, 24 q heads, **2** KV heads, head_dim 256, vocab 248320 | X: qwen4_exp.py:73-79 | fused prefill needs d = 256 and ≤ 16 heads per group (C: attn_kernel.rs:1611-1615): 24/2 = 12, OK. Split decode needs d % page == 0 (C: attn_kernel.rs:909): OK. | QSA masking (below) |
| MoE | 512 experts, top-10, expert intermediate 640, shared expert 640 | X: qwen4_exp.py:95-100; W6 | **none** | expert GEMV/GEMM gather kernels, router, shared expert, expert-tile tuning (Splash has these: S: runtime/ops/MoE.cpp; dev/tuning/MoeTuning.cpp) |
| gated residual (hyper-connections) | 4 widened residual streams, low-rank read mix (320), per-stream write gates. **No** input/post-attention layernorms and **no** final norm. | X: qwen4_exp.py:11-15, :103-104 | the fused add+RMSNorm producers and presum blocks assume a plain residual + norm (R: impl-th-wp2-matmul-roofline.md:49-52) | fused HC read/write kernels. SGLang’s mix/combine kernels are 2.05× / 1.96× faster at kernel level at M = 4, measured on B300 (W6). |
| QSA (Qwen Sparse Attention) | indexer with 4 × 128-dim query heads and 1 shared key head; every 4 keys compressed; top 512 blocks → 2048 positions (+0–3 tail); a 4-slot raw-key ring per request | W6; X: qwen4_exp.py:106-111 | none | indexer, top-k, sparse GQA (prefill and decode); **new cache state** in rollback and checkpoints |
| n-gram embedding (PLE) | 51.2B parameters (≈95.4 GiB bf16); 8 bigram + 8 trigram hash rows × 160 values per token at block index 1; short-conv state `[10240, 9]` | W6 | none | SSD/mmap row gather with prefetch (MTPLX streams it from SSD; X: qwen4_exp.py:20-25; README.md:78). The short-conv state is **recurrent state**: it joins rollback and checkpoints. |
| MTP | head trained over multiple steps. SGLang "MTP-213" (2 draft steps, top-k 1, 3 draft tokens per verification): accept length 3.3, 540 tok/s at batch 1, TP4 B200, NVFP4 | W5; W6 | none | a native MTP drafter (§7) |
| context | 262,144 native; static YaRN for 1M | X: qwen4_exp.py:175-200 | RoPE theta only (C: qwen35.rs:71-79) | YaRN; long-context memory plan |
| norms | zero-centered RMSNorm (+1 applied in `sanitize`); the GDN gated norm is one-centered | X: qwen4_exp.py:31-34 | assumes the converter already applied the +1 (C: qwen35.rs:8-9) | norm convention per tensor, in the descriptor |

### 4.2 Qwen4 itself

- Not released as of 2026-09-28. At Apsara (2026-09-22) the Qwen lead said it is in training and coming "very soon", with no specs (W5).
- Treat Flash-Next as the best available specification. Whether its components persist unchanged into Qwen4 cannot be verified yet (W5).

### 4.3 Gemma 4 (W12; W13)

- **Attention.**
  - Sliding-window layers (window 512 or 1024) alternate with global layers.
  - head_dim is 256 on sliding layers and **512** on global layers, which tie K and V.
  - QK-norm with attention scale 1.0; logit soft-capping.
- **KV sharing.** Across layers on E2B/E4B.
- **Per-layer embeddings (PLE).** On the E-series.
- **FFN.** 26B-A4B runs a dense GeGLU FFN *in parallel* with a 128-expert top-8 MoE.
- **MTP "assistant" drafters** (4 layers). They share the target's input embeddings and its **KV cache**, and consume the target's last-layer activations (W12; mlx-vlm README in W13).
- **What breaks in th:**
  - prefill fused attention needs a d = 512 variant (C: attn_kernel.rs:1611-1615);
  - sliding-window KV rings;
  - a non-ChatML template makes `chat_marks` return `None` (C: engine.rs:482-496), so the prefix cache falls back to the grid plan;
  - the assistant reads target KV rather than captured hidden states (th's DFlash wiring: C: dflash.rs:48).

### 4.4 The speculative landscape (Qwen3.8-27B, H200, SGLang; W7)

| method | acceptance length, GSM8K / HumanEval / MT-Bench | speedup over AR at concurrency 1 | at concurrency 32 |
|---|---|---|---|
| built-in 7-token MTP | 5.02 / 3.91 / 3.74 | 1.96–2.59× | 0.77–1.04× |
| DSpark (community) | 4.36 / 3.30 / 3.01 | 2.00–2.69× | 0.74–1.13× |
| DFlash 2 (2B, bf16) | 5.46 / 4.39 / 4.10 | 2.67–3.43× | 1.01–1.45× |

- These are H200 figures. On Apple silicon only *relative* conclusions transfer [I].
- MTPLX reports 2.24× over plain decoding on an M5 Max with the model's own MTP heads (X: README.md:15).
- th's standing already includes the DFlash draft. On byte-identical text, th needs 130 rounds where Splash needs 127 (R: phaseE/PHASEE-REPORT.md:214).

### 4.5 Quant formats on Apple GPUs

- **th:** loads MLX affine 4-bit group 64 only (C: qwen35.rs:146-169).
- **MTPLX packs:**
  - dynamic 4-bit, with the sparse-attention projections at 8-bit;
  - an 8-bit group-64 body plus MTP head;
  - a 4-bit group-32 n-gram table (X: README.md:74-76);
  - Prism's ternary 2-bit container: group 128 with biases == −scales (X: ternary_qmv.py:3-6).
- **Splash:** q4 group 64, plus q8 in the MoE package (S: ModelDescriptor.mm:260-268).
- **M5 neural accelerators.** They are reached only through Metal 4 MPP `matmul2d` / cooperative tensors; `simdgroup_matrix` code runs on the ordinary ALUs (W14). MLX gates its NAX path on macOS 26.2 and GPU generation ≥ 17. MLX ≤ 0.30.4 mis-enabled it on A18-class GPUs and returned wrong numbers (W14; W15).
  - th's decode, prefill and attention kernels use MPP heavily (e.g. R: phaseE/th-e-prefill-attn.md:25). M1–M4 support therefore needs fallbacks plus a self-check [I].
- **Prefill ceilings are per format.** The int4 × bf16 MMA ceiling measured 61–65 TFLOPS (R: phaseE/th-e-prefill-gemm.md:92). A new format needs its own ceiling measurement before any prefill floor means anything.

### 4.6 th-engine gap matrix

| # | assumption | where | breaks for | work item |
|---|---|---|---|---|
| G1 | route only `model_type` starting with `qwen3_5` | C: model.rs:637-669 | every other family, including `qwen4_exp` | architecture registry with tiers (Rec 4) |
| G2 | `Qwen35Config` field set | C: qwen35.rs:32-69 | MoE, hyper-connections, QSA, PLE, MTP, sliding windows, per-layer head dims | a descriptor derived from config that errors on unknown semantic fields |
| G3 | layer type from `(i+1) % full_attention_interval` | C: qwen35.rs:100-102 | explicit `layer_types` | read `layer_types` |
| G4 | `bits: 4, gs: 64` hard-coded | C: qwen35.rs:169 | mixed packs, 8-bit, ternary, FP4 | a per-tensor QuantSpec (Rec 5) |
| G5 | norm +1 already applied by the converter | C: qwen35.rs:8-9 | raw HF checkpoints (X: qwen4_exp.py:31-34) | norm convention per tensor |
| G6 | dense safetensors run CPU F32, qwen2/qwen3 only; GGUF only via candle qwen2/qwen3/llama | C: model.rs:551-562, :671-676 | a fast path for any new arch | none: these are development paths |
| G7 | decode tile table and paired rule tuned for 27B at 40 cores | C: quant_kernel.rs:202-244 | new shapes fall back to `n64s4` | tune job plus a table per (model, GPU) (Rec 7) |
| G8 | prefill routing reads `TH_GPU_CORES`, default 40 | C: quant_kernel.rs:5103-5115 (review should-fix #2, R: PHASEC-REPORT.md:273) | other GPUs | use `gpu_cores()` (C: quant_kernel.rs:55-78) |
| G9 | fused prefill attention requires d == 256 and nh/nkv ≤ 16 | C: attn_kernel.rs:1611-1615 | Gemma 4 global layers (d = 512); GQA groups > 16 | kernel variants; the eager fallback is slow and memory-heavy (R: phaseD/th-d-longctx.md:497-502) |
| G10 | GDN: 4-tap conv, DK == DV, hv·dv % 64 == 0; the presum sums assume DV = 128 | C: gdn_kernel.rs:1160-1166, :1215-1218; R: PHASEC-REPORT.md:272 | other GDN geometries | geometry guards plus variants |
| G11 | DFlash geometry as constants, including capture layers [5, 19, 33, 47, 61] and magic `MDFD0004` | C: dflash.rs:30-51 | any other target or draft; HF-format DFlash 2 checkpoints (2B, bf16; W7) | drafter trait plus a draft descriptor (Rec 6) |
| G12 | 7 proposals / 8 verify rows | C: dflash.rs:40; engine.rs:428-434 | MTP depths 1–5 (X: README.md:130) | verify width per drafter, tuned per model |
| G13 | ChatML marks for the prefix-cache plan | C: engine.rs:482-496; prefix_cache.rs:136-170 | Gemma-style templates | marks from the template |
| G14 | snapshot/rollback/checkpoint cover GDN recurrent + conv state, K/V and capture rows | R: phaseD/th-d-prefix-cache.md:50-56 | new state kinds: PLE conv, QSA ring, sliding KV, MTP caches | a StateSpec plus a generic R0a gate (Rec 3) |
| G15 | the app catalog lists GGUF Qwen3 only | `clients/macos/Sources/TokenHorizon/Engine/THEngineCatalog.swift:26-31` | exposing new models in the app | catalog entries per onboarded model |
| G16 | TurboQuant `kv_quant` bypasses N3 and the prefix cache | R: phaseD/PHASED-REPORT.md:263 | long-context memory plans for large models | revisit after G14 |

---

## 5. The day-0 → day-N procedure

"Day" is the gate order, not a promise. MTPLX's fastest onboarding of a genuinely new architecture (Flash-Next) took three days from weight drop to a shipped backend (X: HISTORY.md:48; qwen4_exp.py:31). Its same-family 27B took one day (X: HISTORY.md:46).

### Day 0: triage, reference, fixtures

1. **Pin the artifact.** Record:
   - repo id and revision;
   - sha256 of `config.json`, `generation_config.json`, the tokenizer files, the chat template and `model.safetensors.index.json`.

   MTPLX pins a revision and verifies the shard layout, tokenizer, generation config, special tokens and chat template before it will load a model (X: README.md:276-280).
2. **Inspect.**
   - Map every config field to the descriptor and flag unknown semantic fields.
   - List the ops of each layer type.
   - For each kernel lane, evaluate its geometry guard (§4.6) to predict its route: fused, eager fallback, or unsupported.
   - Assign a tier:
     - **A:** same family, new sizes;
     - **B:** known ops, new shapes or quant format;
     - **C:** new op types;
     - **D:** autoregressive-only for now.
   - Manual today; Rec 4 automates it.
3. **Fit memory.** Add up:
   - weights, per QuantSpec;
   - KV bytes per token: attention layers × KV heads × head_dim × 2 × dtype bytes [D];
   - recurrent state per slot (a 27B GDN checkpoint is 151 MB; R: phaseD/th-d-prefix-cache.md:54);
   - the draft or MTP head;
   - the prefix-cache budget (default 4096 MiB; R: phaseD/th-d-prefix-cache.md:62);
   - the prefill transient (27B cold 7.9k: +3.4 GB at i4; R: phaseE/PHASEE-REPORT.md:203).

   Compare the total against the recommended working set. Splash admits against `recommendedMaxWorkingSetBytes` minus a margin (S: tune_kernels.mm:383-389).
4. **Get reference outputs.**
   - **transformers** in bf16 (fp32 where it fits): semantic truth.
   - **mlx-lm** on the exact quantized pack: quantized truth, since th loads mlx-lm packs.
   - If mlx-lm lacks the architecture, write a one-file module from the transformers code first. MTPLX did this within hours of the weight drop (X: qwen4_exp.py:31).
5. **Build golden fixtures.** Commit the small ones; hash the large ones (Splash's pattern: S: dev/tools/vision_reference.py:1-16).
   - **Prompts:** reuse the suite th already benchmarks, rendered through the model's own chat template:
     - the 3 bench prompts;
     - the 1373-token passage (sha1 `a886db14acc4`);
     - the 7853-token passage (sha1 `6ab8ad9a056a`);
     - the 15-prompt acceptance set.

     Sources: R: phaseD/PHASED-REPORT.md:46; th-c-loop.md:63; phaseD/th-d-sampled.md:66.
   - **Per prompt:**
     - token ids;
     - last-position f32 logits (top-64 plus a full-vocab hash);
     - 128 greedy continuation ids;
     - hidden states at a few layers, for debugging;
     - teacher-forced 8-row verify windows, for speculative work.
   - **Quant quality:** top-1 agreement and KL of the quantized pack against bf16 on a mixed corpus (MTPLX's metric: X: README.md:106-108).

**Exit:** a descriptor diff, tier, memory fit and fixture manifest (proposed home: `engine/tests/golden/<model>/` [I]).

### Day 1: correctness bring-up

1. **Loader.** Descriptor-driven, with a per-tensor QuantSpec (Rec 5) and per-tensor norm conventions. Unknown semantic fields are errors, not silent defaults.
2. **Eager path first.** Build every new op from candle ops first, with a per-op test against the reference activations.
3. **New kernels.**
   - Bitwise against eager where the math allows it; otherwise within f32/f64 tolerance.
   - A one-ulp mutation check, and an `MTL_SHADER_VALIDATION=1` run.
   - Rust-side geometry guards (MEM-8) and geometry-keyed pipeline caches (MEM-12).
   - Outputs through `outbuf::kernel_out`: no zero-fill blits and no clone escape (§2.4).
4. **Logits.** Compare `th-engine probe --dump` at the last prefill position against the reference:
   - report max|Δ| in bf16 ulp, KL, argmax and top-10;
   - read it against th's own tail-chunk noise floor for the same prompt (R: phaseE/PHASEE-REPORT.md:316-321).
5. **State.** Declare every recurrent tensor (Rec 3) and extend the R0a gate. It needs:
   - a discrimination arm that must fail;
   - slot isolation at TH_BATCH=2;
   - a long-prompt variant.
6. **Greedy continuation.** It must match the reference, or diverge only at near-ties (§2.3 caveat).
7. **Server smokes:**
   - TH_BATCH=1, 2 and 4;
   - UTF-8 streaming including CJK (U1: R: PHASEB-REPORT.md:517-521);
   - stop strings;
   - the `/status` contract;
   - kv/clear.

**Exit:** every §2.3 gate green, and the golden T=0 id streams (per prompt, per mode) recorded as this model's identity baseline for CI.

### Day 2: floors and the first quiet baseline

1. **Decode floors.**
   - **F_bw** = bytes streamed per round ÷ measured bandwidth.
     - The program's F_bw was 29.8 ms/round (R: PHASEB-REPORT.md:107). Its inputs lived in a synthesis document that is no longer in the repo; the brief gives ≈565 GB/s measured.
     - The best Q4 kernels reached 530–535 GB/s (R: impl-th-wp2-matmul-roofline.md:236-242). MTPLX quotes a 614 GB/s bus for the same chip (X: ternary_qmv.py:9-10). Record which bandwidth figure a floor uses.
   - **F_k** = Σ over matmul classes of (calls per round × best measured µs per call).
     - The 27B's verify matmuls sum to 30.9 ms (R: PHASEB-REPORT.md:684), and F_k ≈ 36 ms/round overall (R: PHASEB-REPORT.md:107).
     - The draft's bandwidth floor was 2.93 ms for 1.65 GB streamed (R: PHASEB-REPORT.md:686).
   - **MoE.** Bytes per round depend on how many *distinct* experts the verify rows touch, so compute F_bw per verify width [I].
2. **Prefill floor.** The sum of three parts:
   - GEMM FLOPs ÷ the measured MMA ceiling (61–65 TFLOPS int4 × bf16; R: phaseE/th-e-prefill-gemm.md:92);
   - attention FLOPs ÷ the fused-attention rate (≈11–12 TFLOPS effective at 512:7168; R: phaseE/th-e-prefill-attn.md:355);
   - the sequential GDN scan (145 ms at 1.45k on the 27B; R: phaseE/th-e-prefill-gemm.md:289).
3. **In-process probes** (§6 rows 4–6):
   - the verify-width ladder `TH_BENCH_MULTI=8,7,…,1`. On the 27B, fwd8 was the *cheapest* shape: 39.70 ms vs 41.50 at fwd2 (R: th-c-loop.md:51);
   - `TH_BENCH_LIN`;
   - `TH_BENCH_Q4` in serial mode;
   - `TH_BENCH_PREFILL`.
4. **Quiet session against the best competitor**, same harness (§2.2).
   - Candidates:
     - Splash, if it ships a package for the model;
     - MTPLX, which covers many architectures and native MTP;
     - mlx-lm, as the autoregressive baseline;
     - llama.cpp with `--mtp`.
   - Note the competitor's prefix-cache effect on TTFT: Splash served 32–64 prompt tokens from its cache on the bench prompts (R: bench-quiet.md:168).
   - Report per mode:
     - loop tok/s and like-for-like;
     - the per-round × tokens/round decomposition;
     - tokens/round on identical text;
     - TTFT classes;
     - peak `phys_footprint`;
     - conditions.
5. **Attribute the gap** three ways:
   - host idle: round − GPU-busy;
   - GPU work above F_k: R0c per-region timing, `TH_GPU_PROF=1`;
   - tokens/round.

   The 27B's first attribution found about 90% of the ms/round gap was GPU idle while the host worked (R: PHASEB-REPORT.md:89).

**Exit:** the baseline table, the gap decomposition and the floors.

### Day 3: speculative strategy

See §7.

### Days 4–5: autotune and the (model, GPU) table

See §8.

### Day 6–N: the lever loop

**Order.** This is the order in which levers paid on the 27B; `pathway-catalogue.md` has the detail.

1. Host idle and syncs: G1a −6.35 ms/round; D1 cut syncs from 6 to 2 per round (R: PHASEC-REPORT.md:202, :212).
2. Verify width and depth: L1 gave +12.5% tokens/round (R: PHASEC-REPORT.md:201).
3. Kernel fit for the new shapes: K1/K2/K45 took −6.75 ms at fwd8 (R: PHASEB-REPORT.md:392).
4. Long-context attention: context growth to 7.9k fell to +2.9 ms, against +61.1 on main (R: phaseD/PHASED-REPORT.md:32).
5. The sampled path on the GPU: −2.96 ms/round (R: phaseD/PHASED-REPORT.md:124).
6. The prefix cache: a repeated 1.4k prefix in 139/146 ms (mean/median) vs 2546 ms on main (R: phaseD/PHASED-REPORT.md:35).
7. Prefill attention, GEMM and GDN scan: cold 1.45k −456 ms vs integration-3 (R: phaseE/PHASEE-REPORT.md:49).
8. Memory: the cold 7.9k peak fell from 47.2 to 27.9 GB (R: phaseE/PHASEE-REPORT.md:49).

**Process that worked** (R: PHASEB-REPORT.md:137, :369-372, :562-579; PHASEC-REPORT.md:309-343):

- One lane per worktree (`wt-bootstrap`), with a private port, gpu-lock and frozen binaries.
- A lane report tagged [M]/[D]/[E]; the old path kept behind a read-once env switch; bitwise tests.
- Adversarial review through three lenses (memory, numerics, state machine), with each finding verified by its own agent.
- An integration branch, with:
  - a pairwise `git merge-tree` conflict matrix;
  - explicit semantic-merge fixes, because a textual merge hides them (R: phaseD/PHASED-REPORT.md:240).
- A final quiet A/B against main and the competitor.
- Landing notes that list API and behaviour changes and every new knob.

---

## 6. Harness run-book (order, purpose, thresholds)

| # | step | command | answers | gate | source |
|---|---|---|---|---|---|
| 0 | build and test | `cd engine && cargo build --release && cargo test --release` | compiles clean; bitwise and exactness unit gates | 0 warnings; all pass | R: phaseE/PHASEE-REPORT.md:284, :293 |
| 1 | pipeline compile | `TH_MPP_PROBE=1 th-engine probe --model x --tokens 1` (C: main.rs:234) | every MPP pipeline compiles on this GPU and OS; no GPU work | no failure | R: impl-th-wp2-matmul-roofline.md:283 |
| 2 | no-model kernel benches | `TH_BENCH_ATTN=1 [TH_BENCH_ATTN_TM=1] [TH_BENCH_ATTN_QSCALE=6] TH_BENCH_ATTN_REF_MAX=32768` (C: main.rs:221); `TH_BENCH_PREFILL_ATTN=seq:kv,…` (C: main.rs:212); `TH_BENCH_DRAFT_ATTN=1` (C: main.rs:204); `TH_BENCH_GDN` (C: gdn_kernel.rs); `TH_BENCH_ALLOC` (C: main.rs:228) | time and error against an f32/f64 reference at the new geometry, 512–32k keys | error ≤ the path it replaces | R: phaseD/th-d-longctx.md:266-310, :524-525; phaseE/th-e-prefill-attn.md:384-385 |
| 3 | correctness probes | `probe --dump`; `TH_BENCH_PREFILL_LOGITS=512,1450,4096,7900 TH_BENCH_PREFILL_IDS=<ids>` (C: main.rs:874); `TH_TEST_ROLLBACK=1 [TH_BATCH=2] [TH_ATTN_SPLIT_MIN=1]` on 18- and 1450-token prompts, plus the `TH_GDN_COMMIT=step` arm (C: main.rs:245) | logits against the reference and the noise floor; state-bitwise rollback and prefix restore | rc 0; the discrimination arm rc 1 | R: phaseE/PHASEE-REPORT.md:294-298, :312-324 |
| 4 | real-weight kernel benches | `TH_BENCH_LIN=1\|dec\|pf` (C: main.rs:427); `TH_BENCH_Q4=1 [TH_BENCH_Q4_SWEEP=1] [TH_BENCH_Q4_M=5]` (C: main.rs:440; serial by default); `TH_BENCH_DRAFT_MLP=1` (C: main.rs:446) | µs and GB/s per projection class; candidate tiles; max\|Δ\| against scalar | V-lin: nothing worse than base | R: impl-th-wp2-matmul-roofline.md:134-179, :284-285 |
| 5 | in-situ forward — **this decides policy** | `TH_BENCH_MULTI=8,5,1 TH_BENCH_MULTI_ITERS=5` (C: main.rs:451); variants as env switches of one binary, interleaved | whole-forward ms at each verify width | ≥ 3 interleaved rounds | R: impl-th-wp2-matmul-roofline.md:92-119 |
| 6 | prefill probes | `TH_GPU_PROF=1 TH_BENCH_PREFILL=512,896,1415 [TH_BENCH_PREFILL_LARGE_ONLY=1]` (C: main.rs:492); `TH_BENCH_STEPS=512,256,1024` (C: main.rs:550); `TH_BENCH_PLAN` (C: main.rs:611); `TH_BENCH_TTFT` (C: main.rs:774); `TH_BENCH_BATCH` (C: main.rs:972) | prefill GPU-busy per routing; chunk size; prefix-plan cost; TTFT by kind | min over alternating runs | R: phaseE/th-e-prefill-gemm.md:125-157, :303-305 |
| 7 | server gates | a `gates4.sh`-class script: TH_BATCH=2/4 smokes, `TH_SAMPLE=check`, prefix cache on / `=miss` / `=0`, kv-quant, no-draft, the `/status` contract | end-to-end correctness | hit == miss 42/42 · 42/42; 0 samplecheck mismatches; 0 panic/ERROR lines | R: phaseE/PHASEE-REPORT.md:289-310 |
| 8 | profiling | `TH_DEBUG_TIMING=1` phase split (C: engine.rs:300-304; log line :1139); `TH_GPU_PROF=1 [TH_GPU_PROF_EVERY=1] [CANDLE_METAL_COMPUTE_PER_BUFFER=1]` (C: main.rs:109; gpuprof.rs:1-30); the `mtlc3.m` Metal interposer for sync and encoder counts | where the round goes; syncs per round | use to rank only: profiled runs are inflated | R: th-c-loop.md:84-92; phaseD/th-d-gpu-tail.md:40, :76-79 |
| 9 | quiet server A/B, plus competitor | a `fin4d.sh`-class palindrome with `bq4_client.py` and `fpmon.py`; analysis with `q4_analyze.py`, `ab4.py`, `ttft4.py`, `fp4.py`, `conds4.py` | the standing | §2.2 gates; per-arm drift within S2's ±3–5% | R: phaseE/PHASEE-REPORT.md:59-64, :109, :390-400 |
| 10 | acceptance study | `TH_ACCEPT_STATS=1` (Rao-Blackwellised), 15 prompts × 5 seeds; `TH_SPEC_VERIFY=block\|token`; `TH_TOP_P=renorm`; `TH_DRAFT_FILTER=1` | tokens/round, independent of any one trajectory | CI from a prompt-cluster bootstrap | R: phaseD/th-d-sampled.md:18, :60-81 |

- **`TH_BENCH_ROUND` is not on main.** This is the load-robust, in-process 4-arm round A/B that separated N3 from N4. It exists only on the probe branch `th/d-longctx-probe` @`5090f18` (R: phaseD/th-d-longctx.md:23-25); a grep of `engine/src/main.rs` finds no match. Porting it is Rec 10.
- **The bench scripts are not in the repo.** Every script named in rows 7–9 lives under `.worktrees/_phaseC/work/integration-4/{bench,bin}/` and `.worktrees/_phaseC/bin/`, untracked (Rec 1).

---

## 7. Choosing the speculative strategy

### 7.1 Options

| option | needs | exactness | extra memory | engineering in th | evidence |
|---|---|---|---|---|---|
| autoregressive only | nothing | exact | none | exists: the plain path with K7's m=1 matvec, 28.75 tok/s on the 27B (R: PHASEC-REPORT.md:220) | MTPLX saves no depth when nothing beats AR (X: README.md:173) |
| n-gram / prompt lookup | nothing | exact | none | exists: `--spec-tokens` (R: PHASEB-REPORT.md:449-450) | pays even on the bench prompts: 27B plain decode on the K7 build ran 28.21 tok/s with n-gram spec 4 vs 23.02 with `--spec-tokens 0` (R: PHASEB-REPORT.md:449-450) |
| native MTP head | MTP weights trained with *this* trunk | exact under rejection sampling | small; the Flash-Next head is 4B (W5) | new: reuses the target's layer kernels; needs the wiring contract (X: mtp_patch.py:49-60) and depth tuning | 1.96–2.59× over AR at c=1 for the 27B's built-in MTP on H200 (W7); 2.24× on an M5 Max with MTPLX (X: README.md:15) |
| external trained draft (DFlash-class, EAGLE-3) | a draft trained for the exact target | exact | DFlash 2 is 2B params, bf16 (W7) | exists for the 27B (Splash's MDFD draft); a new target needs a new draft and a draft descriptor | 2.67–3.43× at c=1 on H200 (W7); th reached 1.20× Splash with it (R: phaseE/PHASEE-REPORT.md:25-27) |
| assistant pair (Gemma 4) | the official assistant checkpoint | exact | a 4-layer drafter | new: the drafter reads the target's KV | up to about 3× (W12) |

### 7.2 Procedure

1. **Availability.** Keep only the options that exist for the model. Never attach an MTP head that was not trained with this trunk (X: README.md:187).
2. **Cost model.**
   - loop tok/s = tokens/round ÷ ms/round, where ms/round = propose + verify(width) + rest.
   - Take verify(width) from the `TH_BENCH_MULTI` ladder, and propose time from the drafter's own forward (DFlash propose was 5.91 ms on the 27B; R: phaseE/PHASEE-REPORT.md:160).
   - Expected tokens/round = 1 + Σₖ Πᵢ≤ₖ aᵢ, where aᵢ is the per-position acceptance [D, the standard identity]. Measured Rao-Blackwellised aᵢ for the 27B with DFlash (sampled) ran from 0.806 at position 1 to 0.538 at position 7 (R: phaseD/th-d-sampled.md:75).
3. **Measure; do not assume.** For each option, run a quiet session on the identical-text suite: bench prompts, the 15-prompt set, and 1.45k and 8k contexts, at T=0 and sampled. Report:
   - loop tok/s;
   - tokens/round on identical text;
   - many-seed acceptance, with a CI.
4. **Width and depth.**
   - Verify every proposal when the verify ladder is flat. On the 27B, fwd8 was cheapest, and the adaptive cap had cost 12.5% tokens/round (R: th-c-loop.md:47-51; PHASEC-REPORT.md:201).
   - On a MoE target the ladder may not be flat, because extra rows touch extra experts [I]. Measure it.
   - For MTP, sweep depth per machine, as MTPLX does (X: README.md:171-179).
5. **Re-gate after kernel changes.** Kernel numerics move acceptance. Any change on the verify or draft path must be re-gated on tokens/round (R: PHASEB-REPORT.md:412; S: device-policy.md:13-18; S: remaining-decode-optimizations.md:17-22).
6. **Concurrency.**
   - At c=32 on H200, MTP and DSpark fell below AR on most tasks while DFlash 2 stayed at ≥ 1.0× (W7).
   - th's batching paid little so far: B=4 gave 72.4 tok/s aggregate vs 48.2 single-stream at `cf3e5f7` (R: PHASEB-REPORT.md:315).
   - Decide per deployment: a single interactive user, or agent fan-out.
7. **Workload.** Acceptance depends on the workload for every drafter. MTPLX's best 27B figure, 87.6 tok/s with MTP heads, came from rewriting a file the model had just written (X: README.md:29). Put an edit-heavy class in the acceptance suite, beside the fresh-generation prompts [I].
8. **Long context.** At 8k, th's tokens/round trailed Splash's (3.726 vs 4.145, on texts that differ; R: phaseE/PHASEE-REPORT.md:353). Run an 8k acceptance study on identical text before changing anything (R: phaseE/PHASEE-REPORT.md:368).
9. **Exactness gates for the chosen path:**
   - GPU == CPU sampling;
   - block-rule and token-rule exactness tests;
   - state-bitwise rollback that covers the drafter's own state.

---

## 8. Autotuning and the (model, GPU) cache

### 8.1 What is tunable today

| knob | default | numerics class | how it was decided | source |
|---|---|---|---|---|
| decode Q4 tile per (out, in) at m ≤ 8 | table plus rules: N64Split4 / N256Sg8, Paired256 when there are ≥ 8 tiles per core | B (split-K vs sequential-K rounds differently) | K2/K45 sweep, then an in-situ forward A/B | C: quant_kernel.rs:195-244; R: impl-th-wp2-matmul-roofline.md:76-84 |
| persistent group count | full grid, or one resident wave | A when the accumulation order is unchanged [I] | K45 sweep: no override won | R: impl-th-wp2-matmul-roofline.md:178 |
| PreSums families | `split,split_long` | A (bitwise) | in-situ forward A/B | C: quant_kernel.rs:299-310; R: impl-th-wp2-matmul-roofline.md:58, :104-119 |
| P0 pad skip | K ≤ 8192 | A (bitwise) | `TH_BENCH_Q4` path+pad arm | C: quant_kernel.rs:246-252 |
| m=1 path | AffineQmvT | B | K7 A/B | R: PHASEC-REPORT.md:220 |
| prefill tile, m ≤ 128 | `pf_policy` (r16/r24/r32 tiles, split-K) | B | T2 A/B | R: PHASEB-REPORT.md:470-491 |
| prefill tile, m > 128 | `r32n128s4+v` | A against legacy (bitwise) | sweep plus in-situ | C: quant_kernel.rs:5200-5211; R: phaseE/th-e-prefill-gemm.md:98-116 |
| decode attention split threshold and count | 256 keys; 16 splits up to 4k, 32 from 8k | B | kernel sweep plus round A/B | C: attn_kernel.rs:66-90; R: phaseD/th-d-longctx.md:253-256, :307-308 |
| draft attention splits | ceil((ring + 8) / 256), at most 8 | B (a single split is bitwise) | kernel bench | R: phaseD/th-d-longctx.md:320 |
| GDN step simdgroups per head | 32 | A (bitwise) | quiet A/B | R: phaseD/th-d-gpu-tail.md:43 |
| prefill attention variant | `g2q` | A against `g2` (bitwise); B against eager | rotated A/B | R: phaseE/th-e-prefill-attn.md:84-86 |
| prefill chunk size | 512 | A for logits: bitwise across chunk sizes above 128 rows | `TH_BENCH_STEPS` | R: phaseE/th-e-prefill-gemm.md:144-157 |
| prefix-cache block / merge | 128 / 1024 | C (the default plan changes numerics against the grid plan) | `TH_BENCH_PLAN` plus a sharing simulation | R: phaseD/th-d-prefix-cache.md:58, :150 |
| verify width / speculative depth | 8 rows | C | acceptance study | R: th-c-loop.md:47-65 |
| GPU accept eligibility | top-k 1..32, no repeat penalty | C (block rule vs token rule) | exactness plus acceptance | R: phaseD/th-d-sampled.md:131-134 |

### 8.2 Numerics classes decide *where* a knob may be tuned

- **Class A: bitwise-identical schedules.**
  - Examples: grid shapes, threadgroups per row, simdgroups per head, pipelining that keeps the accumulation order, memory layouts.
  - Safe to tune per GPU, and on an unknown GPU even at first load, provided a self-check follows.
  - Still needs in-situ confirmation, because micro-benchmarks mis-rank (R: impl-th-wp2-matmul-roofline.md:155-157).
- **Class B: numerics changes that preserve the distribution.**
  - Examples: split-K vs sequential K; split counts; reduction trees; intermediate precision; fused vs unfused rounding. `TH_ATTN_SPLIT_P=bf16` makes the split kernel about 25% faster with 2–4× the deviation (R: phaseD/th-d-longctx.md:251).
  - Tune **offline only**.
  - Gates:
    - re-baseline T=0 identity, with a first-divergence report;
    - logits within the noise floor;
    - a many-seed acceptance A/B.
  - Both engines saw acceptance move under changes of this kind (§3.1; R: PHASEB-REPORT.md:412).
- **Class C: policy.**
  - Examples: verify width, speculative depth, the chunk plan, the prefix plan, sampling-rule eligibility.
  - Tune per model; depth also per machine.
  - Gate on end-to-end loop tok/s, acceptance, TTFT and memory.

### 8.3 Measurement policy for the tune job

- **Workloads.** Start every candidate list with the shipped baseline, and collect workloads from the loaded model: distinct shapes, representative layers (S: TuningWorkloads.cpp:68-168).
- **Samples.** Paired, in alternating order, at least 12 pairs. A candidate qualifies only with a bounded spread and a conservative gain of ≥ 3% (S: Tuning.hpp:23-24, :47-53).
- **Aborts.** Stop on memory pressure, on thermal state ≥ serious, or when the load gate fails (S: tune_kernels.mm:390-394; §2.2).
- **Timing.** GPU timestamps, not host timers. Host-timed sweeps drifted ±40% between identical kernels on the loaded machine (R: phaseE/th-e-prefill-gemm.md:63).
- **In-situ confirmation.** Re-time each winner in context:
  - whole forward at each verify width (`TH_BENCH_MULTI`);
  - whole prefill (`TH_BENCH_PREFILL`);
  - whole graph, defaults vs winners (S: tune_kernels.mm:273-338).
- **Class B winners** pass the identity and acceptance gates before promotion (§8.2).
- **Evidence.** Emit every candidate's paired gain, not just the winner (S: tune_kernels.mm:439-459).

### 8.4 The cache key

- **One constructor.** Hash a canonical JSON, and have the writer and the reader call the same constructor, with a parity test. MTPLX shipped a hand-rebuilt key that re-tuned on every start (X: public.py:4483-4494; mistakes/wizard-rebuilt-…md).
- **Key material:**
  - **model:** weight-manifest digest (index plus per-shard size and sha256); a hash of the architecture descriptor, meaning the shape set actually dispatched; the QuantSpec map.
  - **GPU:**
    - chip string;
    - Apple GPU family;
    - IORegistry `gpu-core-count` (C: quant_kernel.rs:80-146);
    - recommended max working set.
  - **software:**
    - macOS version, which determines the Metal compiler and NAX gating (W14);
    - engine git sha;
    - an MSL source hash per kernel library;
    - candle version.
  - **tuner:** candidate-set version; policy mode (e.g. `TH_Q4_POLICY`); measurement-policy version.
- **Storage.**
  - Ship tables in the repo per (architecture shape set, GPU family, core-count bucket), reviewed like code. This follows Splash's "change the rules in runtime/ops, not a table" (S: tune_kernels.mm:527-528).
  - An optional user-local cache holds class-A results for unknown GPUs [I].
- **Invalidation.** Any change to a key field invalidates the entry. Never serve a table whose kernel-source hash differs from the binary's.

### 8.5 First-load behaviour

- **Do:**
  - resolve the key, then load the matching table or fall back to rules;
  - compile pipelines at load. T2 moved the tile-library compile to load (R: PHASEB-REPORT.md:478), and `MPP_SRC` compiles once per process (R: impl-th-wp2-matmul-roofline.md:64);
  - run the layout probes (`pf_warm` and the cooperative-tensor layout check; R: phaseE/th-e-prefill-gemm.md:122);
  - run a self-check per kernel lane and disable any lane that fails, reporting it in `/health` (X: kernel_selfcheck.py:1-35; Rec 8).
- **Do not:**
  - time kernels on a request path;
  - tune class B or class C knobs at load;
  - trust a cached table across engine builds.
- **Optional, opt-in, for an unknown GPU:** class-A tuning with pressure and thermal aborts, persisted under the key.

---

## 9. Model perf CI

### 9.1 Tiers

| tier | trigger | runtime | contents | passes when |
|---|---|---|---|---|
| CI-0 | every commit | CPU, plus Metal unit tests | `cargo build --release` with 0 warnings; `cargo test --release` (bitwise kernel gates, exactness tests); CPU-only routing-policy tests over shape × core count × family, like Splash's (S: device-policy.md:76) | all green |
| CI-1 | any PR touching `engine/` | GPU under gpu-lock. The Phase D and E gate holds took about 13 and 43 min (R: phaseD/PHASED-REPORT.md:248; phaseE/PHASEE-REPORT.md:289). | for every onboarded model: R0a rollback (discrimination arm, TH_BATCH=2, long prompt); prefix cache on / miss / 0; `TH_SAMPLE=check`; T=0 id streams against the golden set; logits against golden and the noise floor; TH_BATCH=2/4 smokes; the `/status` contract; the `TH_BENCH_MULTI` ladder against the last main | every gate exact; the ladder within noise |
| CI-2 | nightly, in a quiet window | GPU. An 8-arm block took about 34 min (Phase E S2), and the 14-arm Phase D hold about 2 h (R: phaseE/PHASEE-REPORT.md:77; phaseD/PHASED-REPORT.md:22). | a palindrome against the previous main (`fin4d.sh` class): ms/round, tokens/round on identical text, loop tok/s per mode, TTFT classes, peak `phys_footprint`; plus a T=0 control arm | no regression beyond the noise band (§9.2) |
| CI-3 | weekly or before a release | GPU, hours | same-session comparison against the competitors; a many-seed acceptance study; an 8k acceptance study; memory at 12k–16k under the guard | a standing report |

### 9.2 Metrics and thresholds

- **ms/round per mode.** Fail when the paired ratio's CI falls outside the noise band. Take the band from measured noise, not a guess:
  - the same-session T=0 control arm of unchanged code (m3m bounded the noise at ±3–5%; R: phaseD/th-d-sampled.md:342);
  - per-arm spread (S2: ±3–5%; R: phaseE/PHASEE-REPORT.md:109).
- **tokens/round.** Compare only on byte-identical text. Otherwise report "texts differ".
- **Identity.** T=0 id streams must match the golden set exactly, unless the PR declares a numerics change. If it does, require:
  - a first-divergence report;
  - logits within the noise floor;
  - an acceptance A/B.
- **TTFT** per class; **peak `phys_footprint`**, under a guard.
- **Ceilings.** Set gate ceilings just above the measured-good distribution. MTPLX's old gate failed only on gaps > 2 s, so the whole 0.2–0.8 s freeze regime passed green (X: mistakes/mean-tps-…md:30-32).

### 9.3 Contamination

- Gate every arm (§2.2), and redo contaminated arms.
- Record conditions per request.
- Discard a session whose control arm moves outside the band.

### 9.4 Artifacts

- **Per request, `runs.jsonl`:** text, ids, deltas, `/status` deltas, GPU and CPU ms, load, thermal level and log offsets (R: PHASEC-REPORT.md:420).
- **Per run:** binary sha256, git sha, model digest and the tune key.
- **Output:** a markdown summary, and results stored per commit for trend queries, in the style of llama.cpp's compare database (W4).

### 9.5 What not to automate

- Promoting loaded numbers to a standing: the ×1.301 claim had to be withdrawn (R: phaseD/th-d-gpu-tail.md:66-80).
- Promoting class-B changes without acceptance evidence.

---

## 10. Recommendations (priority order)

| # | title | mechanism | effort | payoff |
|---|---|---|---|---|
| 1 | **Commit the harness** | Move `gpu-lock`, `wt-bootstrap`, `bq4_client.py`, `fin4d.sh`, `gates4.sh`, `fpmon.py`/`fpguard.py`, `q4_analyze.py`/`ab4.py`/`ttft4.py`/`fp4.py`/`conds4.py`, `gpuq.py`/`gpufreq.py`, `mtlc3.m` and the passages from `.worktrees/_phaseC/` into `engine/bench/`. Parametrise by model: prompt ids come from the model's own tokenizer and template. Add a protocol README (§2.2). | S–M (1–2 days) | Every job starts at Phase-E methodology. Removes a single point of failure that already struck: the synthesis and scratchpad were lost (R: PHASEB-REPORT.md:16; PHASEB-baseline.md:310). |
| 2 | **Reference and golden-fixture pipeline** | `engine/tools/reference/` runs transformers (bf16/fp32) and mlx-lm (the quantized pack) over the fixture set. It writes ids, last-position logits, greedy ids, teacher-forced verify windows, and quant top-1/KL against bf16. A comparator in `th-engine probe` reports ulps, KL, argmax, top-10 and first divergence against the noise floor. | M (2–3 days) | Day-1 correctness in hours, and a per-model identity baseline for CI. th has no golden fixtures today. |
| 3 | **StateSpec and a generic state-bitwise gate** | Each model declares every recurrent tensor per layer type (GDN recurrent and conv, PLE conv, QSA ring, sliding-window KV, MTP caches). Snapshot, restore, rollback and prefix capture iterate the spec. R0a becomes spec-driven, with a discrimination arm and slot isolation. | M (3–5 days) | The prerequisite for speculative decode and prefix caching on any stateful architecture. This gate exposed the 1.3M–6.3M-element rollback inexactness that G1a then fixed, for −6.35 ms/round (R: th-c-gdn-parity.md:22; PHASEC-REPORT.md:212). |
| 4 | **Model descriptor, architecture registry and `th-engine inspect`** | Derive the descriptor from `config.json`: layer types, per-layer head dims, GQA, MoE, residual kind, norm conventions, rope kind, quant map, chat marks. Registry tiers and exit codes follow MTPLX. Add Rust-side geometry guards for every kernel lane (MEM-8), and report each lane as routed, fallback or unsupported. `inspect` prints the tier, memory fit, predicted routes and floors. Update `THEngineCatalog.swift` for each onboarded model. | M–L (1–2 weeks) | Onboarding becomes filling in a descriptor and implementing only the genuinely new ops, instead of grep-and-fix. Fails loudly instead of silently taking slow paths. |
| 5 | **Per-tensor QuantSpec** | Parse `quantization` (global plus per-module overrides, keyed on checkpoint names *before* any rename: the mlx-lm #1924 trap). Route each tensor to a kernel family. Add affine-8 and ternary-2 first (both are in current MTPLX packs), then FP4. Gate each pack on top-1/KL against bf16. | loader S; M per kernel family | Loads mixed-precision Optimized-Speed/Quality packs and unblocks FP4 checkpoints. |
| 6 | **Drafter trait and native MTP** | A `Drafter` with propose / commit / snapshot / rollback, implemented by DFlash, n-gram, native MTP (reusing the target's layer kernels, with a wiring contract) and assistant pairs. Verify width per drafter. Depth tuned per (model, machine) and saved only when it beats AR. | L (1–3 weeks) | Speculative decode for any MTP-bearing model without waiting for a trained draft. On H200: MTP 1.96–2.59× over AR, DFlash 2 2.67–3.43× (W7). |
| 7 | **`th-engine tune` and versioned (model, GPU) tables** | Unify `TH_BENCH_Q4_SWEEP`, `TH_BENCH_LIN=pf` and the attention/draft split sweeps. Collect workloads from the loaded model; apply Splash's paired policy with pressure aborts; confirm in situ; tag each knob's numerics class; emit JSON tables plus evidence under the §8.4 key. First load does lookup, compile and self-check only. | M–L | Replaces the hand-copied `DECODE_TILE_TABLE`; makes M3/M4/M5 Pro portable; makes K2/K45-class wins repeatable per model (−6.75 ms at fwd8 on the 27B; R: PHASEB-REPORT.md:392). |
| 8 | **Load-time kernel self-check** | At load, run each custom kernel once on tiny tensors in the model's dtype and quant format, against eager. Put the threshold between the ULP band and corruption. On a mismatch, disable the lane and report it in `/health`. | S–M | Safety on unmeasured GPU families and OS updates. MLX's NAX mis-gating returned wrong numbers silently (W15). |
| 9 | **Model perf CI, tiers CI-0 to CI-3** (§9) | Build it on Rec 1 and Rec 2. | M | Catches regressions and loaded-number errors automatically. The ×1.301 claim was withdrawn only at review (R: phaseD/th-d-gpu-tail.md:66-80). |
| 10 | **Port `TH_BENCH_ROUND` to main** | Bring in the probe-branch round A/B (@`5090f18`) and make it model-agnostic. | S | Load-robust in-process attribution per lever. It split N3 from N4 at 1450 keys: −10.5 and −6.8 ms (R: phaseD/th-d-longctx.md:137). |
| 11 | **Close the measurement debts** | Sync the prefill timer, or derive it from TTFT. Make the `TH_TEST_ROLLBACK` legacy-logits line compare the same position. Use `gpu_cores()` in `pf_env`. Stop reading `TH_PHASE_TIME` per forward. | S | Fewer false alarms; correct routing on GPUs that do not have 40 cores (R: bench-quiet.md:282-286; phaseE/PHASEE-REPORT.md:297; PHASEC-REPORT.md:273; phaseD/PHASED-REPORT.md:317). |
| 12 | **Op roadmap for Qwen4-class models** | In dependency order: chunked GDN prefill (already the top 27B lever: 145 ms at 1.45k, 750 ms at 7.9k; R: phaseE/PHASEE-REPORT.md:365) → MoE expert kernels, routing and tuning → fused hyper-connection read/write → the QSA indexer, sparse attention and ring state → PLE SSD gather and conv state → native MTP (Rec 6) → YaRN. For Gemma 4: d = 512 attention variants, a sliding-window KV ring, KV sharing, and an assistant drafter. | L (weeks) | Support for the Qwen4 architecture preview and Gemma 4. |

---

## 11. Risks and open questions

- **Qwen4 may diverge from its preview.** The model card frames Flash-Next only as a preview (W5).
- **MoE verify cost on Apple is unmeasured.** How it scales with rows and distinct experts touched is an assumption here [I]. It decides whether "verify all rows" still pays.
- **candle 0.11 constraints:**
  - the pool is trimmed only at host syncs, and is wired;
  - command buffers are batched at 50 encoders;
  - there are no MoE gather kernels;
  - custom ops carry their own bug classes (§2.4).
- **Draft source.** th's DFlash path uses Splash's packaged draft (`$DRAFT` under `~/Library/Application Support/Splash/…`; R: impl-th-wp2-matmul-roofline.md:279). A new target needs one of: a Splash package, a converter from HF-format DFlash 2 checkpoints (W7), or native MTP.
- **Quiet windows are rare on this shared machine** (R: phaseD/th-d-sampled.md:286-302). CI tier CI-2 needs a reserved window or a dedicated machine.
- **Portability.** th's kernels use MPP/cooperative tensors heavily, and the neural accelerators arrive only with M5. M1–M4 need ALU fallbacks plus self-checks [I].
- **Headroom.** The MTPLX Flash-Next packs are about 74–83 GB resident, with 78–87 GiB peaks (X: README.md:74-75, :129-130). On the 128 GB machine that leaves little room for probes, so the footprint guard is mandatory.
- **Open questions:**
  - Should th adopt a packed, validated format (Splash-style mmap sections plus a manifest), or stay on HF/MLX packs plus a descriptor? [I]
  - Who reviews and owns the tuned tables?
  - Which competitor is the standing reference for models Splash does not package? MTPLX is the likely one.

---

## Appendix A: sources

**th reports** (`engine/reports/perf-2026-09/`), by name:

- PHASEB-baseline.md, PHASEB-REPORT.md, bench-quiet.md
- impl-th-wp2-matmul-roofline.md, impl-th-wp10-prefill-tiles.md, impl-th-wp1-utf8-stream.md, review-integ.md
- th-c-loop.md, th-c-gdn-parity.md, th-c-ports.md, PHASEC-REPORT.md
- phaseD/PHASED-REPORT.md, th-d-longctx.md, th-d-gpu-tail.md, th-d-sampled.md, th-d-prefix-cache.md
- phaseE/PHASEE-REPORT.md, th-e-prefill-attn.md, th-e-prefill-gemm.md, th-e-ttft-regression.md

**th code** (`engine/src/` at `b31ca91`):

| area | references |
|---|---|
| model loading | model.rs:18-25 (backend enum), :551-562 (GGUF archs), :637-669 (qwen3_5 routing), :671-676 (dense CPU path) |
| qwen35.rs | :1-23 (layout), :32-69 (config), :71-79 (rope), :100-102 (layer type), :146-169 (quant hard-code), :1748-1762 (prefill attention routing) |
| quant_kernel.rs | :55-146 (core count), :195-244 (decode tiles), :246-252 (pad skip), :286-310 (presum), :5103-5145 (prefill routing), :5200-5211 (large-m tile) |
| attn_kernel.rs | :66-90 (split config), :900-914 (split geometry), :1611-1615 (prefill geometry) |
| gdn_kernel.rs | :1160-1166, :1215-1218 |
| dflash.rs | :30-51 |
| engine.rs | :300-304, :309-315, :428-434, :482-496, :1139 |
| prefix_cache.rs | :136-170 |
| main.rs (probe dispatch) | :109, :172, :204, :212, :221, :228, :234, :245, :427, :440, :446, :451, :492, :550, :611, :774, :874, :972 |
| gpuprof.rs | :1-30 |
| app catalog | `clients/macos/Sources/TokenHorizon/Engine/THEngineCatalog.swift:1-31` |

**Splash** (`docs/splash/`):

| area | references |
|---|---|
| model descriptors and layouts | `runtime/model/ModelDescriptor.hpp:17-34`; `ModelDescriptor.mm:23-31, :135-145, :184-251, :260-268, :375-400`; `Qwen3_8.hpp:19-70`; `Qwen3_6Moe.hpp:19-76`; `Model.hpp:247-281`; `WeightStore.hpp:16-55` |
| operator plans | `runtime/ops/ExecutionPlans.hpp:23-133` |
| tuning | `dev/tuning/tune_kernels.mm:1-6, :46-54, :273-338, :383-399, :426-461, :523-544`; `Tuning.hpp:23-24, :33-53, :126-139`; `TuningWorkloads.cpp:68-168`; `TuningWorkloads.hpp:15-17` |
| benchmark notes | `dev/benchmarks/device-policy.md:3-6, :13-18, :21-28, :60-66, :76, :98-103`; `remaining-decode-optimizations.md:17-22` |
| reference fixtures | `dev/tools/vision_reference.py:1-16`; `dev/tests/fixtures/vision-parity/` |
| docs | `README.md:155-170`; `DEVELOPMENT.md:116-126` |

**MTPLX** (`docs/MTPLX/`):

| area | references |
|---|---|
| docs | `README.md:15, :29, :34, :72-78, :104-108, :129-135, :171-187, :263-280`; `HISTORY.md:26-54`; `P61_DELTAS.md:7-13` |
| registry | `mtplx/backends/registry.py:18-80, :99-131, :236-268, :606-614, :650-745, :958-977, :1238-1252, :1307-1317` |
| models and kernels | `mtplx/models/qwen4_exp.py:1-34, :70-126, :175-200`; `mtplx/kernel_selfcheck.py:1-35`; `mtplx/kernels/ternary_qmv.py:1-50`; `mtplx/mtp_patch.py:49-60` |
| tuning key | `mtplx/commands/public.py:4483-4494, :4532-4565` |
| post-mortems | `mistakes/` (thermal cooldowns; mean-tps vs p99 gaps; stale binaries; wizard tune key; text-only microbenchmarks) |

**Web.** Items marked *(search summary)* come from search-result summaries, not a fetched page. Treat them as secondary.

| id | source | fetched? |
|---|---|---|
| W1 | mlx-lm CONTRIBUTING.md — https://github.com/ml-explore/mlx-lm/blob/main/CONTRIBUTING.md | search summary |
| W2 | mlx-lm model architectures (DeepWiki) — https://deepwiki.com/ml-explore/mlx-lm/5-model-architectures ; convert.py — https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/convert.py | search summary |
| W3 | llama.cpp HOWTO-add-model.md — https://github.com/ggml-org/llama.cpp/blob/master/docs/development/HOWTO-add-model.md | fetched |
| W4 | llama.cpp `test-backend-ops` / Metal validation / bench compare — https://github.com/ggml-org/llama.cpp/issues/4545 ; https://github.com/ggml-org/llama.cpp/blob/master/tools/llama-bench/README.md ; https://github.com/ggml-org/llama.cpp/blob/master/docs/ops.md | search summary |
| W5 | Qwen4 status and Flash-Next summaries — https://www.yottalabs.ai/post/qwen-4-release-date-what-is-known-how-to-prepare-2026 ; https://blog.buildfastwithai.com/qwen3-8-flash-next-preview ; https://qwen.ai/blog?id=qwen3.8-flash-next (body not retrievable) ; https://arxiv.org/pdf/2608.30320 | search summary |
| W6 | SGLang day-0 support for Qwen3.8-Flash-Next — https://www.lmsys.org/blog/2026-08-26-qwen-flash-next/ ; vLLM recipe — https://recipes.vllm.ai/Qwen/Qwen3.8-Flash-Next | fetched (lmsys) |
| W7 | DFlash 2 model card — https://huggingface.co/z-lab/Qwen3.8-27B-DFlash2 ; DFlash paper — https://arxiv.org/pdf/2602.06036 | fetched (card) |
| W8 | `mlx.core.quantize` modes — https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.quantize.html | search summary |
| W9 | mlx-lm issues #1924 and #1865 — https://github.com/ml-explore/mlx-lm/issues/1924 ; https://github.com/ml-explore/mlx-lm/issues/1865 | search summary |
| W10 | "The best 4-bit format in MLX…" — https://dev.to/mihai_leanzero/the-best-4-bit-format-in-mlx-is-the-one-its-own-converter-sets-up-to-lose-4dne | search summary |
| W11 | llama.cpp MTP PR #22673 — https://github.com/ggml-org/llama.cpp/pull/22673 ; https://llmrequirements.com/news/2026-05-17-llama-cpp-mtp-merged ; Qwen3-Next MTP PR #25589 (X: HISTORY.md:42); mlx-lm MTP PR #990 (X: HISTORY.md:34) | search summary |
| W12 | Gemma 4 MTP — https://ai.google.dev/gemma/docs/mtp/overview ; https://blog.google/innovation-and-ai/technology/developers-tools/multi-token-prediction-gemma-4/ | search summary |
| W13 | Gemma 4 architecture — https://huggingface.co/blog/gemma4 ; https://docs.nvidia.com/nemo/megatron-bridge/0.5.1/apidocs/bridge/bridge.models.gemma.gemma4_bridge.html ; https://github.com/Blaizzy/mlx-vlm/blob/main/mlx_vlm/speculative/drafters/gemma4_assistant/README.md | search summary |
| W14 | M5 neural accelerators — https://machinelearning.apple.com/research/exploring-llms-mlx-m5 ; https://github.com/bisand/kvad/issues/52 ; https://github.com/ml-explore/mlx/issues/4525 | search summary |
| W15 | MLX NAX mis-gating fixed in 0.30.5 — https://github.com/Edge0-AI/Edge0/pull/9 | search summary |

## Appendix B: lever and gate IDs used above

| ID | meaning |
|---|---|
| K1 / K2 / K45 / K7 | decode matmul tiles / per-shape tile table / presum blocks + autotune + draft gate-up fusion / m=1 matvec |
| P0 | pad-copy skip |
| T2 | small-M prefill tiles |
| U1 | UTF-8-safe streaming |
| L1 | verify all 7 proposals |
| D1 | host-resident codebooks, one propose sync |
| Q1 | decode-thread QoS |
| G1a | double-buffered GDN parity state |
| R0a / R0b / R0c | state-bitwise rollback gate / acceptance study / per-command-buffer profiler |
| N2 / N3 / N4 | greedy tie rule / split-key decode attention / split draft attention |
| MEM-1 … MEM-12 | memory-review findings (§2.4) |
| S1 / B1 | GPU sampled acceptance / block verification |
| T1 / T1b / T1c | prefix cache / GQA-grouped eager attention / blit-free checkpoints |
| E1 | used by two Phase E lanes: fused causal prefill attention (th-e-prefill-attn) and the prefill GEMM items E1(a)–(d) (th-e-prefill-gemm) |

Definitions are in the phase reports; `pathway-catalogue.md` maps them to lever families.
