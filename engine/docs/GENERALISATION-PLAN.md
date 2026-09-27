# th-engine generalisation plan

> **What this is.** What to change in th-engine so the *next* model is cheap to onboard and optimise: a Qwen4-class dense hybrid, a MoE, a model with native MTP heads, a non-Qwen family (Gemma 4, Llama), or a new quant format. It sets out the abstraction boundaries, a model descriptor, a tile and autotune cache derived at load and keyed by (model, GPU), a draft/MTP adapter interface, the pieces that are already general, a phased refactor roadmap with effort and risk, and a perf-CI proposal.
>
> **Evidence.** The code at `main` @`b31ca91` (`engine/src/`, about 32k lines of Rust and MSL) and the 2026-09 performance program's reports (`engine/reports/perf-2026-09/`). The three analyses in `engine/docs/analysis/` hold the full inventories this plan condenses: every coupling with its ID in [AUD], every lever family in [CAT], the reference engines and next models in [LAND].
>
> **Status.** Untracked at `b31ca91`, like the playbook; the harness both rely on lives under the git-excluded `.worktrees/`, and G0 moves it into the repo. Changes made after the adversarial review (`analysis/CRITIQUE.md`) are listed in the playbook's Appendix D.
>
> **Companion.** [`MODEL-OPTIMISATION-PLAYBOOK.md`](MODEL-OPTIMISATION-PLAYBOOK.md) is the runbook for the optimisation job itself. This plan is what to change in the engine so that the playbook's Stage 1 shrinks from "grep and fix" to "fill in a descriptor and implement only the genuinely new ops" [LAND §10 Rec 4].

## Conventions

- Citation keys are the playbook's: [B] `PHASEB-REPORT.md`, [Bb] `PHASEB-baseline.md`, [BQ] `bench-quiet.md`, [C] `PHASEC-REPORT.md`, [D] `phaseD/PHASED-REPORT.md`, [E] `phaseE/PHASEE-REPORT.md`, [K45] `impl-th-wp2-matmul-roofline.md`, [T2] `impl-th-wp10-prefill-tiles.md`, [U1] `impl-th-wp1-utf8-stream.md`, [RI] `review-integ.md`, [CL] `th-c-loop.md`, [CG] `th-c-gdn-parity.md`, [CP] `th-c-ports.md`, [DL] `phaseD/th-d-longctx.md`, [DG] `phaseD/th-d-gpu-tail.md`, [DS] `phaseD/th-d-sampled.md`, [DP] `phaseD/th-d-prefix-cache.md`, [EA] `phaseE/th-e-prefill-attn.md`, [EG] `phaseE/th-e-prefill-gemm.md`, [ET] `phaseE/th-e-ttft-regression.md` (all under `engine/reports/perf-2026-09/`); [AUD] `analysis/coupling-audit.md`, [CAT] `analysis/pathway-catalogue.md`, [LAND] `analysis/landscape-and-onboarding.md`. `S:` is Splash (`docs/splash/`), `X:` is MTPLX (`docs/MTPLX/`).
- Coupling IDs (C-01, W-02, Q-01, G-02, A-01, N-05, T-08, D-01, S-02, P-04, K-03, V-01, X-04) and recommendation IDs R1–R14 are [AUD]'s.
- Effort sizes are [AUD §5]'s estimates [E]: **S** ≤ 1 day, **M** 2–5 days, **L** 1–3 weeks, **XL** > 3 weeks. Risk grades are this plan's [I].
- Tags: [M] measured, [D] derived from cited figures, [E] an estimate made in a report, [I] this plan's inference (no number attached), [ext] a web-only figure with no vendored source (context only, never an input to a decision).
- Code references are `file:line` under `engine/src/` at `b31ca91` unless a path is given.

---

## 0. Summary

### 0.1 Where the engine stands

th-engine has three layers of very different portability [AUD §0.1]:

1. **An architecture-agnostic shell** (HTTP, config and counters, the Jinja renderer, the request loop, the prefix-cache store, sampling and acceptance arithmetic, allocation helpers, the GPU profiler, TurboQuant). Its couplings are policy defaults and token assumptions, not math.
2. **One model port** (`qwen35.rs` + `gdn_kernel.rs` + `attn_kernel.rs` + `quant_kernel.rs`). The Rust side reads most dims from `config.json`, but kernel-critical fields fall back to Qwen3.8 values when absent, the Metal kernels bake in Qwen3.8 geometry that the Rust side never checks, and every tile policy was measured on Qwen3.8-27B shapes on the M5 Max 40-core GPU.
3. **One draft port** (`dflash.rs` + `draft_kernel.rs`). Every dimension is a compile-time constant of the Qwen3.8-27B DFlash2 draft (`dflash.rs:30-52`); the Splash package manifest is never read [AUD D-06].

The plug-in surface is a six-variant enum with 28 matched methods (`model.rs:18-25, 65-371`), and every advanced feature (speculation, DFlash, batching, prefix cache, TurboQuant, KV reserve) exists only for the `Qwen35` variant [AUD F9]. The dangerous class is **SILENT**: a run that produces wrong numerics with no error. Several such paths exist today: GDN DK ≠ 128, DV ≠ 128 with presum, attention head_dim ≠ 256, a GQA group of 9–15 in split verify, a missing `head_dim`, RoPE scaling, output-gate semantics (including the GDN norm gate kind), the RMSNorm weight convention [AUD §0.2, §3; §3.1 here].

### 0.2 What each target class needs

| target | first failure today [AUD §0.3] | to be correct | to be fast | roadmap phases (§10) |
|---|---|---|---|---|
| (a) Qwen4-class dense hybrid, new dims | LOUD unless `model_type` starts with `qwen3_5` (`model.rs:639`); if it routes, SILENT for GDN DK ≠ 128, attention head_dim ≠ 256, a GQA group of 9–15 in split decode, or a non-swish GDN norm gate; PANIC for Hv > 64, LOUD above 56 GDN layers | descriptor, route plan and guards, kernel templates for the new dims | retune; a drafter (no Splash draft means n-gram only and no batching) | G0–G3, G6, G8a; G5 for MTP |
| (b) MoE | LOUD at load: `qwen3_5_moe` looks for `mlp.gate_proj` (`qwen35.rs:3043-3049`) | MoE FFN (router, stacked experts, shared expert), gather-Q4 decode / verify kernels, grouped prefill GEMM | a MoE-aware verify policy; a DFlash descriptor | G0–G4, G7 (+ streaming loader) |
| (c) native MTP heads, no Splash draft | runs with n-gram speculation only; batching disabled | nothing | drafter trait and MTP head | G0, G1, G4, G5 |
| (d) Gemma / Llama | LOUD (`unsupported safetensors model_type`, `model.rs:691`), or candle's GGUF Llama with none of th's kernels | an attention-only backend on th's kernels, plus the chat adapter | retune; a drafter | G0–G4, G6, G7 |
| (e) new quant format | LOUD or SILENT: bits 4, group 64 hard-coded (`qwen35.rs:169`) | quant map + a kernel family per scheme | tables for the new family; new floors | G1, G6, G3 |

### 0.3 The roadmap in one table

| phase | theme | main items | effort [E] | risk [I] |
|---|---|---|---|---|
| G0 | harness and measurement debt | vendor the harness, gate script, floors tool, `TH_BENCH_ROUND`, measurement fixes, build sha | S–M per item | low |
| G1 | descriptor, route plan, guards | R1, R2 (first: the split-kernel group guard), R10, R14 (+ `inspect --compile`), R8 | M, M, S–M, S–M, S–M | low–medium |
| G2 | correctness for new geometries | R12 sweep tests, golden fixtures, load-time self-check | M, M, S–M | low |
| G3 | tune job and (model, GPU) tables | R6 | M–L | medium |
| G4 | StateSpec and backend traits | generic state gate, R4 | M, L | high |
| G5 | drafter trait, DFlash descriptor, MTP | R7, R9 | L, L–XL | medium–high |
| G6 | kernel templates, first new quant scheme | R3, R5 | L, L per format | high (performance) |
| G7 | new operator families, streaming loader | MoE, hyper-connections, sparse / sliding attention, n-gram embedding, YaRN; R13 | L per family; M | high |
| G8a | product path for the optimised pack (now, beside G0–G1) | catalog entry + `--draft` in the Swift app and the Go daemon, a local-directory entry, spawn-args tests | S–M (estimate here) | low |
| G8b | server and app contract | R11: `/status` keys added (none redefined), `inspect` tiers, catalog and fit from `inspect` in both clients | M | low–medium |

Invariant for every phase: today's Qwen3.8 path stays bit-identical, proven by the existing gates (R0a, prefix hit == miss, T=0 text identity, GPU-vs-CPU sampling) [AUD §5].

---

## 1. What is already general (keep it; do not redo it)

These pieces already work for any geometry, or need only a named, small change. The caveat column is the coupling that remains.

| component | where | why it is general | remaining caveat |
|---|---|---|---|
| HTTP / OpenAI / Anthropic wire types, SSE | `server.rs`, `api.rs` | model-agnostic | request types carry no template kwargs, tools or images (V-02) |
| UTF-8-safe incremental detokenisation | `engine.rs:1893-1990` | decoder-agnostic: byte-level BPE and SentencePiece both tested [U1] | — |
| live config and counters | `state.rs` | generic | Qwen non-thinking sampling defaults 0.7 / 0.8 / 20 (`state.rs:69-71`); `generation_config.json` ignored (C-11) |
| Jinja chat renderer | `template.rs` | generic | the fallback template is ChatML (K-05); BOS probe `<s>` (K-03) |
| prefix-cache store and canonical chunk plan | `prefix_cache.rs:37-39` ("backend-agnostic, the state type is a parameter"), plan and lookup in the same file | identity by construction makes a hit bit-identical to a miss (42/42 texts and per-round logs [E §0]) | turn marks are ChatML token ids (`engine.rs:482-496`) (P-02) |
| sampling and acceptance arithmetic | `sample_kernel.rs` (`ts_topk`, `ts_accept`, CPU reference) | vocab-generic; token and block rules exact by enumeration and Monte Carlo [DS §3–4] | `ROWS` / `PROP` / `DTOPK` tied to the DFlash constants (`sample_kernel.rs:62-64`) (S-04) |
| allocation helpers | `outbuf.rs:31` `kernel_out`, `:108` `zero_rows`, `:133` `copy_rows` | shape- and dtype-generic | — |
| GPU profiler (R0c) | `gpuprof.rs:134` `phase`, `:142` `region`, `:305` `init`, `:403` `drain_busy_ms` | op-agnostic | region names are chosen per model |
| TurboQuant KV | `turboquant.rs` | parameterised by head_dim | disables the fused kernels and the prefix cache (A-12) |
| config dims | `qwen35.rs:31-103` | hidden, layers, heads, KV heads, head dims, vocab, eps, RoPE θ and partial factor are read, not literal | Qwen3.8 defaults when a field is absent (C-01…C-05) |
| geometry-keyed pipeline cache | `attn_kernel.rs:316` `GeomCache` | keyed by (nh, nkv, d, rp): several geometries per process | not yet used by `gdn_step` / `gdn_lib` / QMV–QMM–DEQ (G-09, Q-03) |
| GDN kernels compiled per geometry | `gdn_kernel.rs:109-112` (HK/HV/DK/DV substituted into the MSL); keyed `gdn_pipe` at `gdn_kernel.rs:962` | register sizing at compile time | fused step / commit still assume DK = 128 (G-02) |
| GDN prefill scan and conv | `gated_delta_step` (`gdn_kernel.rs:118`) is DK-generic; the prefill conv is K-generic (`gdn_kernel.rs:846-883`) | generic prefill path | the scan is sequential (L12, open) |
| split-key attention tile | `attn_kernel.rs:855-866` (`TH_DIM`, `TH_QROWS`, `TH_PAGE` defines) | geometry-templated | correct only for group ≤ 8 (256-thread dispatch, `:1079-1081`, vs 4 threads per fused row in the page softmax, `:655-658`); unguarded; tested only at group 6 (`:1943-1966`) (A-03) |
| G1a parity / rollback state machine | `qwen35.rs:2084` `GdnState`, `:2102` `GdnParity`, `:3308` `rollback_verify` | generic in dims | GDN-specific; one-dispatch commit ≤ 56 layers (G-06) |
| KV capacity, Direct store, reserve, checkpoint views | `qwen35.rs:1849` `KvCap`, `:3832` `kv_reserve`, `:4812` `kv_store_direct` | generic in dims | views rely on rows below `kv_tokens` never being rewritten, which ring caches break (G-12) |
| m = 1 matvec (K7) | `quant_kernel.rs:2964` `AffineQmvT`, `:3008` `qmvt_warm` | any (out, in) with `in % 64 == 0` | affine 4-bit group 64 |
| decode-tile rules | `quant_kernel.rs:195-244` | tile families chosen per call from shape × `gpu_cores()`; the table at `:218-219` is only a seed | the table is keyed on exact Qwen3.8 shapes (T-01) |
| prefill tile policy and layout probe | `quant_kernel.rs:5117` `pf_route`, `:5254` `pf_policy`, `:4690` `pf_vec_layout_check`, `:4786` `pf_warm` | rules from (m, out, in, cores); the implementation-defined MPP layout is verified at load (T-09) | core count defaults to 40 (`quant_kernel.rs:5109-5112`) (T-08) |
| GPU core-count probe | `quant_kernel.rs:55-78` `gpu_cores()` | IORegistry, per GPU | the prefill policy does not use it |
| projection fusing and tiled repack | `qwen35.rs:1544` `fuse_lins`, `:853` `maybe_tiled` | shape-generic, with 256-row / 64-column alignment | affine 4-bit group 64 |
| bench class discovery | `qwen35.rs:910` `bench_q4_decode` | target projection classes are found by layer kind | the draft classes are literal shapes (`qwen35.rs:995-1009`) |
| backend-generic probes | `TH_BENCH_MULTI`, `_PREFILL`, `_STEPS`, `_TTFT`, `TH_GPU_PROF`, `TH_DEBUG_TIMING` (`main.rs:451-610, 774`) | work through `ModelBackend` | only `Qwen35` implements `forward_multi` (`model.rs:122-131`) |
| R0a state-bitwise gate | `qwen35.rs:5427` `rollback_state_check`, `:5541` `slot_isolation_check`; `main.rs:245` | generic in dims | validates the state machine, not the kernel math (G-13) |
| engine-level speculative rules | L1 (`engine.rs:307-320`), S1 and B1 (`sample_kernel.rs`), the N2 tie rule, the anchor fix | model- and drafter-agnostic | L1's premise must be re-measured on MoE (S-02) |

**The methods are general too.** Most of the gain (T=0 loop tok/s from a first quiet 0.840× [BQ §0] to 1.203× [E §0] of Splash; Phase B's loaded start read 0.52× [B §1.1] [D]) came from model-agnostic methods: removing host syncs, exact state rollback, verifying every draft row, split-key attention, GPU-side sampled acceptance, a bit-exact prefix cache and fused prefill attention [LAND §0]. The protocol, the gates and the lever template are written down in the playbook (§3, §6.2, §8.3). The only thing missing is that the harness running them is not in git (G0).

---

## 2. Design principles

1. **Derive, never default.** Kernel-critical fields are required or computed; a field whose semantics th does not support is a load error that names the field [AUD R1].
2. **SILENT is a bug class.** Every fused kernel family states what it supports; a route plan picks fused, generic or eager per op and phase, logs why, and serves it at `/status` [AUD R2].
3. **Specialise inside kernels, not in model identity.** Descriptor fields become compile-time constants of the kernels, as `gdn_kernel.rs:109-112` already does. Splash's closed compile-time layouts make every model a new C++ layout, packer and kernel set; copy its manifest validation, not its closure [LAND §3.1].
4. **Rules over tables.** Defaults are shape rules; per-(shape set, GPU) tables are tune outputs, reviewed like code [LAND §3.1, §8.4].
5. **The numerics class decides where a knob may be tuned** (A: bitwise schedules, anywhere with a self-check; B: numerics-changing, offline with acceptance gates; C: policy, per model) [LAND §8.2].
6. **Qwen3.8 bit-identity is the regression oracle** for every refactor step [AUD §5].
7. **Speculation is optional.** Any trunk that builds runs autoregressively at worst; MTPLX: "MTP is an accelerator, never a load requirement" (`X: mtplx/backends/registry.py:1310`).
8. **Evidence travels with the artifact.** A per-model contract records what was verified, on which hardware, with which exactness baseline and speed evidence (MTPLX's `mtplx_runtime.json`, `X: mtplx/backends/registry.py:18`) [LAND §3.2].

---

## 3. Where the coupling is, and why it exists

### 3.1 Eliminate the SILENT and PANIC classes first

| ID | coupling | where | class | fixed by |
|---|---|---|---|---|
| G-02 | GDN fused step and commit assume DK = 128 (`lane*4 + i`, four state registers); the guard checks only `dk == dv` | `gdn_kernel.rs:373-426, 567-620, 1411-1450`; guard `:1116` | SILENT | G1 guard → G6 template |
| G-08 | the GDN presum epilogue assumes DV = 128; the guard checks only `dv % 64` (review should-fix #1, open) | `gdn_kernel.rs:447-460`; guard `:1218` | SILENT | G0 guard → G6 template |
| A-01 | attention prepare / decode assume head_dim 256 (32 lanes × 8 channels), unguarded; the group is generic (`32 × (nh / nkv)` threads, `attn_kernel.rs:589-593`; the "192 threads" comment at `:218` is stale) | `attn_kernel.rs:134-205, 218-266`; `qwen35.rs:4416-4419` | SILENT | G1 guard → G6 template |
| A-03 | split verify attention covers group ≤ 8: 256 threads (`attn_kernel.rs:1079-1081`), 4 per fused row, M = 8 × group rows (`:655-658`); the guard checks `nh % nkv`, `d % 32`, `d ≤ 1024` | `attn_kernel.rs:655-658, 909, 1079-1081` | SILENT for group 9–15 (by the thread arithmetic); at group 16 the default f32-probability tile declares 33.5 KiB of threadgroup arrays (`:91`, `:730-735`), over the 32 KiB limit [D] | G1 guard → G6 |
| C-01 | `head_dim` serde default 256; the documented `hidden / heads` fallback is dead code | `qwen35.rs:43-44, 65` | SILENT | G1 |
| C-04, C-09, W-04 | RoPE scaling ignored; output-gate semantics assumed (the GDN norm gate is hard-coded `silu(z)`, `gdn_kernel.rs:430-443, 624-637`, and `output_gate_type` is never read; the Qwen4 preview's is `sigmoid`, `X: mtplx/models/qwen4_exp.py:92, 686-688`); RMSNorm +1 assumed already applied | `qwen35.rs:71-79, 4397, 8-9` | SILENT | G1 |
| G-09, Q-03 | pipeline caches compiled with the first caller's geometry | `gdn_kernel.rs:671, 759-777, 2303-2330`; `quant_kernel.rs:2571-2574` | SILENT with a second geometry in the process | G1 (key them) |
| G-11 | verify intermediates stashed only for ≤ 16 rows | `qwen35.rs:4984, 3412-3417` | latent SILENT for wider drafters | G1 guard |
| G-04 | GDN gate constants in `[f32; 64]` tables | `qwen35.rs:3060-3067`; `gdn_kernel.rs:55-56` | PANIC for Hv > 64 | G1 |
| Q-01 | quant bits and group fixed at 4 / 64 | `qwen35.rs:169` | LOUD or SILENT | G1 (parse) → G6 (R5) |

### 3.2 Couplings that are measured wins

A coupling usually exists because it won a measurement; generalising it naïvely can give the win back [AUD §1]. Each of these needs a bitwise-equivalence test at the Qwen3.8 geometry when it is generalised.

| coupling | the win it carries | how to generalise without losing it |
|---|---|---|
| the presum chain assumes affine group-64 sums and DV = 128 in the GDN producer (Q-05, G-08, N-05) | −3.60 / −4.10 / −3.20 ms per forward at fwd8 / fwd5 / fwd1 [B §3.1] | sum over DV/64 groups; enable only for schemes with a per-group bias; keep the bitwise emit check (max\|Δ\| = 0) [K45 §5.2] |
| a decode tile table on exact shapes (T-01) | `in_all` N256 sg8 117.7 µs vs n64s4 131.3 (`quant_kernel.rs:205`); K1–K45 −12.0 % ms/round end to end [B §3.1] | keep the rules; the table becomes a per-(shape set, GPU) tune output (§5.6) |
| fused GDN step and commit at DK = 128 and 4 conv taps (G-02, G-03) | carries the G1a parity machinery (−6.35 ms/round) and the GPU-tail GDN widths [CG §0; DG §2] | template `PER = DK/32` register arrays and the tap count; keep a bitwise test at DK = 128 (the `gdn_widths_match_original_bitwise` pattern) |
| attention prepare / decode at head_dim 256 (A-01) | one dispatch for norm + RoPE + cache append | template channels per thread; bitwise at 256 |
| split-K on the N = 5120 decode shapes | sequential K cost +19.2 % ms/round for −0.031 ± 0.043 tokens/round [B §3.1] | tune per shape with the same end-to-end method (ms/round × tokens/round) |
| verify width ≤ 8 across the stack (S-06) | the whole decode / verify kernel set; L1 +12.5 % tokens/round [CL §3] | make the bound a descriptor-validated limit: > 8 rows routes to prefill paths (SLOW), > 16 rows is an error (G-11) |
| one-dispatch commit of ≤ 56 GDN layers (G-06) | part of the GPU-tail bundle (−7.71 ms/round quiet [DG R3]) | move the descriptors from `set_bytes` into a buffer (R3) |

---

## 4. Abstraction boundaries

### 4.1 Target architecture

```
 checkpoint (HF / MLX pack, draft package)
   │  B1  Inspector: config.json (+ text_config), quantization block, generation_config.json,
   │      tokenizer_config.json, chat template, draft manifest  ──►  ArchDescriptor (+ provenance)
   │                                                               ├─ StateSpec   (what must roll back / checkpoint)
   │                                                               ├─ MemoryPlan  (weights, KV/token, state/slot, checkpoints)
   │                                                               └─ ShapeSet    (every dispatched shape; feeds TuneKey)
   ▼
 B2  KernelFamily::supports(desc, phase)  ──►  RoutePlan  (op × phase → fused | generic | eager | unsupported, + reason)
                                                   ▲
 B5  TuneKey(ShapeSet, quant, GPU, build) ──► TuneTable (per-knob values + evidence; rules as fallback)
   │
   ▼
 B3  Model = Decoder { embed, [ Layer { Mixer, Ffn, norms } ], head }
      traits: TextModel · SlotManager · SpecState (per mixer) · PrefixCheckpointing · HiddenTaps
   │
   ▼
 B4  Engine: one speculative loop + one batch round, parameterised by a Drafter; Sampler; PrefixCache
   │
   ▼
 B6  Server /status { arch, routes, capabilities (+ reason), memory_plan, build }  ──►  th-engine inspect, Swift app, Go daemon
```

### 4.2 The boundaries

| boundary | contract | today | after |
|---|---|---|---|
| **B1** checkpoint → descriptor | `inspect(dir) -> Result<ArchDescriptor>`; an unknown semantic field is an error | `Qwen35Config` with Qwen3.8 serde defaults (`qwen35.rs:31-103`); routing on `model_type.starts_with("qwen3_5")` (`model.rs:639`) | one descriptor for every backend, logged at load and served at `/status` |
| **B2** descriptor → kernels | `supports(&ArchDescriptor, Phase) -> Result<(), Reason>` per kernel family; a `RoutePlan` built once | implicit; guards partial (`gdn_kernel.rs:1116, 1218`; `attn_kernel.rs:909, 1613`) | explicit; SILENT becomes an eager route or a named LOUD error |
| **B3** model → engine | `TextModel`, `SlotManager`, `SpecState`, `PrefixCheckpointing`, `HiddenTaps` | a 28-method enum; the engine downcasts for TurboQuant and the prefix cache (`engine.rs:105-109, 139-143`) | capability traits; a disabled capability reports a reason |
| **B4** target → drafter | the `Drafter` trait, `TapSpec`, `Proposal` | DFlash constants; `has_draft()` branches (`engine.rs:931-1150` vs `1152-1289`); batching is DFlash-only (`engine.rs:113-124`) | one loop; n-gram, DFlash, MTP and assistant drafters plug in |
| **B5** engine → tuning | `TuneKey` → `TuneTable` lookup at load, rules as the fallback | a literal `DECODE_TILE_TABLE` (`quant_kernel.rs:218-219`); the prefill policy assumes 40 cores (`quant_kernel.rs:5109-5112`) | per-(shape set, GPU) tables with evidence, reviewed like code |
| **B6** engine → app | `/status` with arch, routes, capabilities and memory plan; `th-engine inspect` | `/status` has no architecture, routes or memory plan and reports `max_position_embeddings` as `maximum_context_tokens` (`server.rs:92`), which the ENGINE tab displays (`EngineTab.swift:123`). Two mirrored consumers both require `instance`: the Swift app (`EngineSupervisor.swift:262`; three GGUF catalog entries, `THEngineCatalog.swift:26-42`; DFlash auto-attach by substring, `EngineSupervisor.swift:49-55`) and the Go daemon (`daemons/go/internal/engine/supervisor.go:161, 174`; the same catalog, `catalog.go:39-48`; no `--draft` at all, `supervisor.go:59-67`) | catalog entries and fit derived from `inspect` and the memory plan, in both clients (AGENTS.md: keep both copies in sync) |

---

## 5. The model descriptor

### 5.1 Fields

The sketch extends [AUD R1] with what the next models need: the Qwen4 architecture preview (Qwen3.8-Flash-Next: 36 GDN + 12 sparse-attention layers, a 512-expert top-10 MoE, 4-stream hyper-connections with no input / post-attention / final norms, an n-gram embedding with its own short-conv state, an MTP head, YaRN, zero-centred RMSNorm, a sigmoid GDN norm gate; `X: mtplx/models/qwen4_exp.py:11-34, 73-111`) and Gemma 4 (sliding + global attention, head_dim 512 on global layers, KV sharing, per-layer embeddings, a dense GeGLU FFN in parallel with a MoE) [LAND §4.1, §4.3].

```rust
/// Built once at load, logged, and served at /status. Kernel-critical fields have no defaults.
pub struct ArchDescriptor {
    pub provenance: Provenance,         // repo, revision, sha256 of config / index / shards / template
    pub model_type: String,             // routing key → registry tier
    pub weight_prefix: String,          // "language_model.model" | "model"                        (W-01)
    pub hidden: usize,
    pub vocab: usize,
    pub max_pos: usize,
    pub residual: ResidualSpec,         // Plain | HyperConnections { streams, read_rank }
    pub layers: Vec<LayerSpec>,         // from layer_types; full_attention_interval only as a fallback (C-02)
    pub embed: EmbedSpec,               // tie (C-08); extra: None | NgramHash { .. } | PerLayer { .. }
    pub norm: NormSpec,                 // eps; weight convention per tensor group                  (W-04, N-01)
    pub quant: QuantMap,                // default scheme + per-module overrides, keyed by checkpoint name (Q-01)
    pub mtp: Option<MtpSpec>,           // layers, source (inline | sidecar), concat order, hidden variant (C-12)
    pub tokens: TokenSpec,              // eos list, bos, chat marks discovered from the template  (C-13, K-03, P-02)
    pub gen_defaults: SamplingDefaults, // from generation_config.json                             (C-11)
}
pub struct LayerSpec { pub mixer: MixerSpec, pub ffn: FfnSpec, pub norms: LayerNorms } // input / post / sandwich (N-04)
pub enum MixerSpec {
    Gdn(GdnSpec),                       // hk, hv, dk, dv, conv_k, gate kind, q/k norm eps          (G-01…G-07)
    Attn(AttnSpec),
    SlidingAttn(AttnSpec, usize),       // window                                                  (A-09)
    SparseAttn(AttnSpec, SparseSpec),   // indexer heads / dim, block size, top-k blocks, raw-key ring
}
pub struct AttnSpec {
    pub heads: usize, pub kv_heads: usize, pub head_dim: usize,   // required, per layer         (C-01)
    pub rope: RopeSpec,                 // theta, partial, style NeoX | GptJ, scaling None | Yarn | Linear | Llama3, mrope (C-04, A-07)
    pub gate: Option<GateKind>,         // Sigmoid for Qwen3.8's attn_output_gate                  (A-05, C-09)
    pub qk_norm: bool,                  //                                                         (A-06)
    pub scale: Option<f32>, pub softcap: Option<f32>, pub bias: bool,  //                           (A-08, A-09)
    pub kv_share_with: Option<usize>,   // Gemma E-series KV sharing
}
pub enum FfnSpec {
    Dense { inter: usize, act: Act },                            // SwiGLU | GeGLU                    (N-03)
    Moe { experts: usize, top_k: usize, inter: usize, shared_inter: Option<usize>, norm_topk: bool }, (C-07)
    DenseParallelMoe { dense_inter: usize, moe: Box<FfnSpec> },  // Gemma 4 26B-A4B
}
```

| field group | source | consumers | removes |
|---|---|---|---|
| dims, layer list, mixers | `config.json` / `text_config` | loader, route plan, StateSpec, ShapeSet | C-01…C-05, C-07, C-14 (slot count moves to engine config) |
| weight prefix, tensor names | the safetensors index | loader | W-01, W-02 |
| quant map | the `quantization` block and per-module overrides | loader, kernel routing, presum policy | Q-01 (parsing half) |
| norm convention | converter provenance (MLX sanitize vs raw HF) | norm kernels, MTP head | W-04 |
| attention flags | `attn_output_gate`, `output_gate_type`, q/k norm tensors, `rope_parameters`, scale, softcap | attention kernels, route plan | C-09, A-05…A-09 |
| MTP | `mtp_num_hidden_layers` / `num_nextn_predict_layers` **and** the presence of `mtp.*` tensors | drafter | C-12 |
| tokens and generation | `generation_config.json`, `tokenizer_config.json`, the chat template | engine, template, prefix-cache plan | C-11, C-13, K-02…K-05, P-02 |

### 5.2 Validation rules

- **Required, never defaulted:** head_dim, GDN head dims and conv taps, the layer schedule, the quant scheme [AUD R1].
- **Unknown semantics are an error:** a `rope_type` th does not implement, a `quantization.mode` other than `affine` (until R5), an unknown layer type, an output-gate kind th does not implement [AUD R1, App. B].
- **Per-module quant overrides are keyed by checkpoint names before any rename.** mlx-lm silently drops overrides when `sanitize()` renames weights (issue #1924) and silently loads FP8 compressed-tensors checkpoints as 4-bit affine (issue #1865) [LAND §3.3] [ext].
- **Norm convention per tensor group**; MTP norms follow it, and the +1 shift is never applied twice [AUD W-04].
- **Check the MTP tensors, not only the config.** The Qwen3.8 MLX export declares `mtp_num_hidden_layers` 1 but ships 0 `mtp.*` tensors [AUD §4c].
- **Registry tiers with exit codes** (MTPLX's verified / family-compatible / architecture-compatible / incompatible / no-MTP / AR-only) make `inspect` classify a checkpoint before anything runs: "there are no silent fallbacks" (`X: mtplx/backends/registry.py:35-45`; `X: README.md:265`).

### 5.3 StateSpec: declare every piece of rollback-relevant state

Speculative decoding and the prefix cache both depend on snapshotting, rolling back and checkpointing state *bit-exactly*. Today that code knows about GDN recurrent and conv state, K/V and DFlash capture rows [LAND §4.6 G14]. A StateSpec makes it data:

```rust
pub struct StateSpec { pub per_layer: Vec<Vec<StateTensor>>, pub drafter: Vec<StateTensor> }
pub struct StateTensor {
    pub name: &'static str, pub shape: Vec<usize>, pub dtype: DType,
    pub rollback: Rollback,      // Parity (GDN) | Truncate (KV) | Ring { slots } | Recompute
    pub checkpoint: Checkpoint,  // Copy | ViewBelowKvTokens | None
}
```

| state kind | example | rollback | checkpoint | status |
|---|---|---|---|---|
| GDN recurrent + conv windows | Qwen3.8: 48 layers × [48, 128, 128] f32 + [3, 10240] bf16 | parity double buffer, fused commit re-scan | copy (GDN part ≈151 MB) | implemented (G1a) [CG §2; DP §2] |
| full-attention K/V | Qwen3.8: 64 KiB per token over 16 layers | truncate `kv_tokens` | view the rows below `kv_tokens` | implemented [ET §2.2] |
| DFlash capture rows | 5 capture groups | ring warm-up | copy | implemented, DFlash-specific (P-04) |
| sliding-window K/V | Gemma 4 local layers | ring | ring copy (views break, G-12) | missing |
| sparse-attention raw-key ring | Flash-Next QSA, a 4-slot ring per request [ext] | ring | copy | missing [LAND §4.1] |
| n-gram embedding short-conv state | Flash-Next `[10240, 9]` [ext] | parity or copy | copy | missing [LAND §4.1] |
| MTP head K/V | one or more MTP layers | truncate | copy or recompute | missing [AUD §4c] |

**The generic R0a gate** iterates the StateSpec: after a partial accept every declared tensor must equal a forward of the kept rows, bit for bit; each rollback kind gets a discrimination arm that must fail (the `TH_GDN_COMMIT=step` pattern); slot isolation at `TH_BATCH=2`; a long-prompt variant [LAND §10 Rec 3]. This gate is what exposed the 1.3M–6.3M-element rollback inexactness that G1a then fixed for −6.35 ms/round [CG §0].

### 5.4 MemoryPlan

| item | formula | Qwen3.8 check |
|---|---|---|
| weights | Σ tensor bytes per quant scheme | — |
| K/V per token | Σ over attention layers of n_kv × head_dim × 2 × dtype bytes [LAND §5] | 16 × 4 × 256 × 2 × 2 B = 64 KiB, matching [ET §2.2] [D] |
| recurrent state per slot | Σ StateSpec tensors, × 2 for parity kinds | one parity: 48 × 48 × 128 × 128 × 4 B ≈ 151 MB (144 MiB), matching [DP §2] and the 37.7M elements of [CG §0] [D] |
| allocation | Σ next_pow2(bytes) per pooled buffer: candle 0.11 rounds every pooled Metal buffer up to a power of two (`candle-core-0.11.0/src/metal_backend/device.rs:336-338`) | the second parity: 48 × (4 MiB for a 3 MiB state + 64 KiB for a 60 KiB conv window) = 195 MiB, exactly the measured +≈195 MiB per slot [CG §2] [D] |
| checkpoint | StateSpec checkpoint tensors | at 1408 / 7424 tokens: GDN 151 MB, K/V 92 / 486 MB, capture rows 72 / 105 MB [DP §2] |
| prefill transient | measured per model | cold 7.9k: +3.4 GB at integration-4 [E §1.5] |
| admission | against `recommendedMaxWorkingSetBytes` minus a margin (Splash's rule) | [LAND §5, Day 0] |

`/status` then gains `memory_plan.max_context_tokens`, derived from the plan, beside the unchanged `maximum_context_tokens` (= `max_position_embeddings`, `server.rs:92`; `model.rs:664, 706`) that the ENGINE tab displays (`EngineTab.swift:123`); redefining that key would be a contract change for both clients [AUD V-01]. Both clients then compute fit from the plan instead of from Splash's catalog (`HardwareProfile.swift:56-135`) [AUD X-02].

### 5.5 RoutePlan and kernel contracts

```rust
pub enum Route { Fused(&'static str), Generic(&'static str), Eager, Unsupported }
pub struct RouteEntry { pub op: Op, pub phase: Phase, pub route: Route, pub reason: Option<String> }
pub trait KernelFamily { fn supports(&self, d: &ArchDescriptor, p: Phase) -> Result<(), Reason>; }
```

Guards the plan adds immediately, each turning a SILENT into an eager route or a LOUD error with a reason [AUD R2]:

- GDN DK == 128 for the fused step and commit (G-02); DV == 128 when presum is on (G-08);
- attention head_dim == 256 for prepare / decode (A-01); `nh / nkv <= 8` for the split kernel, added to the geometry check in `split_pipes` (`attn_kernel.rs:909`) so the call falls back to single pass with the existing log line (A-03), with a unit test at groups 2, 12 and 16;
- Hv ≤ 64 as an error, not a panic (G-04); ≤ 56 GDN layers for the batched commit, else per-layer commits (G-06);
- C ≤ 7936 for the per-row add + RMSNorm (N-02); verify rows ≤ 16 (G-11); quant group 64 on the MPP, sg, prefill and qmvt families (Q-03).

Patterns already in the repo to copy: `GeomCache` (A-13) and the load-time vector-tile layout probe (T-09) [AUD R2].

**Compile gate.** `th-engine inspect --compile` builds every pipeline the route plan selects, for the descriptor's geometry, without weights. Today `TH_MPP_PROBE` compiles only the Q4 MPP library and always exits 0 (`main.rs:234-240`, `quant_kernel.rs:2578-2644`); the GDN step and the split and prefill attention pipelines compile on first use (`gdn_kernel.rs:759-777`; `attn_kernel.rs:899-925, 1613+`). A GDN compile failure errors the forward; the attention ones only log and fall back (`attn_kernel.rs:910-921, 1633-1640`).

### 5.6 The tile and autotune cache, derived at load and keyed by (model, GPU)

#### 5.6.1 Knob inventory

| knob | today | numerics class | decided by | source |
|---|---|---|---|---|
| decode Q4 tile per (out, in), m ≤ 8 | table + rules (`quant_kernel.rs:195-244`) | B | sweep, then in-situ forward A/B | [K45 §3.2; LAND §8.1] |
| persistent group count | full grid, or one resident wave | A | K45 sweep: no override won | [K45 §3.2] |
| PreSums families | `split,split_long` (`quant_kernel.rs:299-318`) | A | in-situ forward A/B | [K45 §2] |
| pad-copy skip | K ≤ 8192 (`quant_kernel.rs:252`) | A | `TH_BENCH_Q4` pad arm | [K45 §1] |
| m = 1 path | `AffineQmvT` | B | K7 A/B | [C §2.3] |
| prefill tile, m ≤ 128 | `pf_policy` | B | T2 A/B | [B §3.1] |
| prefill tile, m > 128 | `r32n128s4+v` | A vs legacy | sweep + in situ | [EG §4–5] |
| decode attention split threshold / count | 256 keys; 16 / 32 splits (`attn_kernel.rs:90-94`) | B | kernel sweep + round A/B | [DL §2] |
| draft attention splits | ≤ 8 | B (one split is bitwise) | kernel bench | [DL §3] |
| GDN step simdgroups per head | 32 | A | quiet A/B | [DG §2] |
| prefill attention variant | `g2q` | A vs `g2`; B vs eager | rotated A/B | [EA §2.2] |
| prefill chunk size | 512 | A for logits (bitwise across sizes above 128 rows) | `TH_BENCH_STEPS` | [EG §7] |
| prefix-cache block / merge | 128 / 1024 | C | `TH_BENCH_PLAN` + a sharing simulation | [LAND §8.1] |
| verify width / speculative depth | 8 rows | C | acceptance study | [CL §3] |
| GPU accept eligibility | top-k 1..32, no repeat penalty | C | exactness + acceptance | [DS §4] |

#### 5.6.2 The key

```rust
/// One constructor used by both writer and reader, with a parity test that save-key == lookup-key.
/// (MTPLX shipped a hand-rebuilt key that re-tuned on every start: X: mtplx/commands/public.py:4483-4494.)
pub struct TuneKey {
    pub shape_set: Digest,    // canonical ShapeSet: every dispatched (op, out, in, m-class), the attention
                              // and GDN geometry, and the drafter's shapes, all derived from the descriptor
    pub quant_map: Digest,
    pub gpu_family: String, pub gpu_cores: u32, pub chip: String,  // the gpu_cores() probe, quant_kernel.rs:55-78
    pub os_build: String,     // the Metal compiler and NAX gating move with macOS [LAND §4.5]
    pub msl_digest: Digest,   // every MSL source compiled into this binary
    pub engine_sha: String,   // needs build-time embedding: no th build embeds a git sha today [ET header]
    pub candle: String,
    pub tuner: TunerVersion,  // candidate-set version, policy mode, measurement-policy version
}
```

Design choice [I]: look tables up by shape set and quant map, not by the model's weight digest. Two checkpoints that dispatch identical shapes have identical timing; each entry records the model digest as provenance. [LAND §8.4] lists the same key material.

#### 5.6.3 Table format and storage

- One JSON file per (shape set, GPU family, core-count bucket), checked into the repo (e.g. `engine/tune/<arch>/<gpu>-<cores>.json`) and reviewed like code; an optional user-local cache holds class-A results for GPUs nobody has tuned [LAND §8.4].
- Every entry records: knob, shape, m-range, value, numerics class, and evidence (the paired gain of *every* candidate, not just the winner [LAND §8.3]; pair count and spreads; the in-situ confirmation; for class B, the identity and acceptance evidence).
- Any key-field change invalidates the entry; never serve a table whose MSL digest differs from the binary's [LAND §8.4].

```json
{ "key": { "shape_set": "<sha256>", "quant_map": "<sha256>", "gpu_family": "<family>", "gpu_cores": "<n>",
           "os_build": "<build>", "msl_digest": "<sha256>", "engine_sha": "<sha>", "tuner": "<version>" },
  "entries": [
    { "knob": "decode_tile", "shape": ["<out>", "<in>"], "m": "2..8", "value": "<tile family>", "class": "B",
      "evidence": { "candidates": "<paired gain per candidate>", "pairs": "<n>", "in_situ": "<TH_BENCH_MULTI result>",
                    "identity": "<re-baseline report>", "acceptance": "<A/B result>" } } ] }
```

#### 5.6.4 The tune job: `th-engine tune --model <dir>`

1. **Workloads** come from the descriptor's ShapeSet (target projection classes, drafter shapes, attention and GDN geometry), replacing the literal draft shapes in the bench (`qwen35.rs:995-1009`) [AUD R6]. Candidate 0 is the shipped rule; Splash likewise collects its workloads from the loaded package [LAND §3.1].
2. **Candidates:** the `TH_BENCH_Q4_SWEEP` space (tile families × presum × persistent groups), the `TH_BENCH_LIN=pf` prefill space, the attention and draft split counts [AUD R6].
3. **Timing:** GPU timestamps (host-timed sweeps drifted ±40 % [EG §2]); at least 12 paired samples in alternating order; qualify only with a timing spread ≤ 10 %, a paired-gain spread ≤ 5 % and a conservative gain ≥ 3 % (`S: dev/tuning/Tuning.hpp:23-24, 50-52`).
4. **Aborts:** memory pressure, thermal state ≥ serious, or a failed load gate [LAND §8.3].
5. **In-situ confirmation** of every winner: `TH_BENCH_MULTI` at each verify width, `TH_BENCH_PREFILL`, and whole-graph defaults vs winners [LAND §8.3]. The kernel bench alone mis-ranked tiles by 27–28 % [K45 §3.1].
6. **Class-B winners** need an identity re-baseline, logits inside the noise floor and a many-seed acceptance A/B before promotion [LAND §8.2].
7. **Acceptance test for the job itself:** on Qwen3.8 it must reproduce today's policy (the K45 sweep found the existing rules winning every shape except the unfused draft gate/up [K45 §3.2]), leaving Qwen3.8 bit-identical.

#### 5.6.5 First-load behaviour

- **Do:** resolve the key; load the matching table or fall back to the rules; compile every pipeline at load; run the cooperative-tensor layout probes; self-check each custom-kernel lane once on tiny tensors in the model's dtype and quant format against eager, disabling a failing lane and reporting it in `/health` (`X: mtplx/kernel_selfcheck.py:1-35`) [LAND §8.5, §10 Rec 8].
- **Do not:** time kernels on a request path; tune class-B or class-C knobs at load; trust a table across engine builds [LAND §8.5].
- **Optional, opt-in:** class-A tuning on an unknown GPU, with the aborts above, persisted under the key.

---

## 6. The draft / MTP adapter

### 6.1 What the engine needs from any drafter

- **Taps:** which target activations it consumes. DFlash reads five mid-stack layers (`CAPTURE_LAYERS` [5, 19, 33, 47, 61], `dflash.rs:48`); an MTP head reads the final hidden state (pre- or post-norm); a Gemma 4 assistant reads the target's KV and last-layer activations [AUD D-04, §4c; LAND §4.3]. On a hyper-connection trunk (the Qwen4 preview: 4 streams over hidden 2560, `X: mtplx/models/qwen4_exp.py:103, 1110`) a tap must also name the stream or the post-read mix [I].
- **Propose:** at most 7 tokens plus, per position, its top-16-truncated distribution. With that, `sample_kernel` accepts unchanged and its residuals are exact [AUD S-04].
- **Commit, rollback, checkpoint** of its own state, declared in the StateSpec (§5.3).
- **Limits of the current stack:** verify width ≤ 8 through decode tiles, the GDN fused step, attention decode, the split q tile and staged uniforms (S-06); a verify stash of ≤ 16 rows (G-11); GPU top-k ≤ 32 (`KMAX`, `sample_kernel.rs:48`).

### 6.2 Trait sketch

```rust
pub trait Drafter: Send {
    fn descriptor(&self) -> &DrafterDescriptor;   // kind, max proposals, preferred verify width, StateSpec part
    fn taps(&self) -> TapSpec;                     // Layers(Vec<usize>) | FinalHidden { pre_norm: bool } | TargetKv; + stream on HC trunks
    fn warm(&mut self, slot: usize, taps: &Tensor, start: usize) -> Result<()>;
    fn propose(&mut self, slot: usize, anchor: u32, pos: usize,
               s: Option<DraftSampling>, rng: &mut dyn FnMut() -> f64) -> Result<Proposal>;
    fn commit(&mut self, slot: usize, taps: &Tensor, start: usize, rows: usize) -> Result<()>;
    fn rollback(&mut self, slot: usize, keep: usize) -> Result<()>;
    fn checkpoint(&self, slot: usize, pos: usize) -> Option<DrafterCheckpoint>;
    fn restore(&mut self, slot: usize, ck: &DrafterCheckpoint) -> Result<()>;
    /// Batched propose; None = the engine proposes per slot.
    fn propose_batch(&mut self, _slots: &[usize], _anchors: &[u32]) -> Option<Result<Vec<Proposal>>> { None }
}
/// Consumed unchanged by sample_kernel's GPU accept (ROWS 8, PROP 7, DTOPK 16 become upper bounds).
pub struct Proposal {
    pub tokens: ArrayVec<u32, 7>,
    pub q: ArrayVec<ArrayVec<(u32, f32), 16>, 7>,
}
```

This is [AUD R7] plus `descriptor`, `restore` and `propose_batch`, which the batch round and the prefix cache need.

### 6.3 Implementations

| drafter | status | taps | state | work |
|---|---|---|---|---|
| n-gram | exists (`engine.rs:1152-1289`; `--spec-tokens`, default 4) | none | none (the target restores and re-forwards) | wrap it in the trait |
| DFlash | exists for the Qwen3.8-27B geometry only (`dflash.rs:30-52`) | 5 layers | a 2048-row ring; capture rows in prefix checkpoints (P-04) | a `DFlashDescriptor` parsed from the Splash manifest (schema 3 and 4: `execution_geometry`, `format`, the v4 `target` and `draft` blocks) and validated against the target: vocab equal to the codebook rows and a multiple of 512, matching hidden size, capture layers below the layer count. `upstream.target` is optional converter provenance that Splash's own validator never reads (`S: runtime/model/ModelDescriptor.mm:135-300`; absent from `S: dev/tests/test_models.py:90-108`): check `repo_id` when present and only warn on the revision (the installed package declares its target @`3e6447f0…`, `$TGT` is @`10c35ca…` [K45 §6]). D-01's constants become MSL defines [AUD R8]. Splash's MoE draft differs in every constant (8 capture layers, hidden 2048, mask token 248077, `S: runtime/model/Qwen3_6Moe.hpp:20-44`) [AUD §3.8] |
| native MTP | missing | final hidden | a per-slot MTP K/V cache (truncate) | the build order in §6.6 |
| assistant pair (Gemma 4) | missing | the target's KV + last-layer activations | shares the target's KV | after the attention-only backend (§7) |

### 6.4 Engine loop

- One speculative loop and one batch round, parameterised by the drafter, replacing the `has_draft()` branches (`engine.rs:931-1150` vs `1152-1289`) and the DFlash-only batch round (`engine.rs:2267-2503`) [AUD S-01, S-03]. Batching then stops requiring DFlash (`engine.rs:113-124`).
- Verify width becomes a per-drafter, per-model policy (class C). "Verify all" (L1) stays the default only where the verify ladder is flat, which held on the 27B (fwd8 the cheapest shape [CL §3]) and must be re-measured on a MoE [AUD S-02].
- S1 (GPU accept) and B1 (block verification) are drafter-agnostic and stay as they are [CAT §5 L07b–c].

### 6.5 Gates for every drafter

- T=0 text identical to plain decode, modulo known near-ties [AUD R9].
- `TH_SAMPLE=check`: 0 mismatches between GPU and CPU acceptance.
- A sampled-distribution check in the style of MTPLX's: 1000 four-token samples from the fast path against 1000 from the plain path at T=1, top-p 0.95, top-k 20 (`X: README.md:34`; `X: HISTORY.md:52`).
- R0a covering the drafter's declared state; prefix hit == miss including the drafter's checkpoint part.
- A many-seed acceptance study with a CI (R0b style) [DS §2].

### 6.6 MTP build order

From [AUD R9], with the wiring facts MTPLX learned:

1. A loader for `mtp.*`, from the main shards or a sidecar file (often `model-mtp-head.safetensors`); config keys `mtp_num_hidden_layers` or `num_nextn_predict_layers` [AUD §4c].
2. The MTP block on the existing attention and QLin kernels. `mtp.fc` has `in = 2H`, so `in % 64` holds, and the K7 m = 1 kernels already serve single-row steps [AUD §4c].
3. A per-slot MTP K/V cache with truncation rollback.
4. The final-hidden tap. The wiring (pre- or post-norm hidden, concat order, position mode) must be measured: one head reached teacher-forced agreement 0.773 on the post-norm hidden vs 0.387 on the pre-norm hidden (`X: mtplx/hy_v3_mtp_patch.py:21`; `X: mtplx/backends/registry.py:610`).
5. Depth-k propose (k ≤ 7, S-06).
6. Acceptance through `sample_kernel`, with q = the head's top-16-truncated distribution [AUD S-04].
7. The prefix-checkpoint part.
8. The batch round.

Depth is tuned per (model, machine) and saved only when it beats AR (`X: README.md:135, 171-179`). Never attach an MTP head that was not trained with this trunk [LAND §7.2].

---

## 7. Backend composition

Adding a backend today costs a new enum variant, arms in up to 28 methods and 3 enums, and the engine downcasts; nothing forces the arms to agree, and the non-Qwen arms return `Ok(())` without doing anything for `set_kv_quant`, `kv_reserve`, `draft_prefill`, `draft_commit` and `restore` [AUD §2.2]. The replacement [AUD R4]:

```rust
pub trait TextModel {
    fn forward(&mut self, slot: usize, tokens: &[u32], pos: usize, out: Logits) -> Result<Tensor>;
    fn slots(&mut self) -> &mut dyn SlotManager;                    // nslots, clear, kv_reserve
    fn spec(&mut self) -> Option<&mut dyn SpecState>;               // snapshot / restore / rollback_verify
    fn prefix(&mut self) -> Option<&mut dyn PrefixCheckpointing>;   // hold / build / restore
    fn taps(&mut self) -> Option<&mut dyn HiddenTaps>;              // the capture points a drafter declares
    fn describe(&self) -> &ArchDescriptor;
}
enum Mixer { Gdn(GdnLayer), Attn(AttnLayer), SlidingAttn(SlidingLayer), SparseAttn(SparseLayer) } // each owns its state
enum Ffn { Dense(Mlp), Moe(MoeBlock), DenseParallelMoe(Mlp, MoeBlock) }
```

Migration, in order, each step bit-identical on Qwen3.8:

1. Implement the traits on the existing `Qwen35` with no behaviour change.
2. Move the GDN parity / rollback machinery (G-10) behind `SpecState`, per mixer; a new state kind then brings its own snapshot, rollback and checkpoint code instead of editing `rollback_verify`.
3. The candle GGUF and dense wrappers implement only `forward` and `slots`; their capabilities report a reason ("no speculation: the backend lacks `forward_multi`").
4. Add the attention-only decoder (Llama, Gemma, Qwen3-dense) on th's QLin, attention decode / prefill, KV cache and a KV-only prefix checkpoint; rollback is `kv_tokens` truncation [AUD §4d].
5. Then MoE FFN, and sliding / sparse mixers (G7).

---

## 8. Quant scheme abstraction

- **A scheme per tensor.** `QLin` carries `Affine { bits, group }`, `Mxfp4 { group: 32 }`, `Nvfp4 { group: 16 }`, `Ternary { group }` or `Gguf(ty)`, resolved per module from `quantization` and its overrides [AUD R5].
- **Each scheme registers** a tiled repack, a CPU reference dequant, an m = 1 kernel (qmvt family), m ≤ 8 decode tiles, prefill tiles, the fused gate/up epilogue, bench classes and a parity test [AUD §3.3].
- **Presum only where it is meaningful:** the sums multiply the per-group bias, so the K45 blocks apply only to affine schemes with a bias (Q-05). The +128 bf16 trick in the fragment-direct decode kernels needs codes below 128: 4-bit fits, 8-bit does not (Q-02).
- **Order:** MLX affine 8-bit and mixed ("dynamic") packs first, then FP4 (MXFP4, NVFP4), then ternary [AUD R5; LAND §10 Rec 5].
- **Per format:** measure its MMA-only ceiling and recompute the floors before any prefill target means anything [LAND §4.5]; gate the pack on top-1 agreement and KL against bf16 (MTPLX: 4-bit dynamic 96.0 % / 0.012, 8-bit 99.3 % / 0.0005, `X: README.md:106, 108`).
- **Why it matters on Macs:** MTPLX measured Ternary Bonsai 2 27B at 64.4 tok/s against 52.6 for 4-bit Qwen 3.8 27B in the same session, "in about half the memory" (`X: README.md:24, 96-97`).

---

## 9. Chat, template and generation adapter

| today | where | change [AUD R10] |
|---|---|---|
| turn marks are ChatML token ids | `engine.rs:482-496` | discover them from the template: render two short conversations, diff the token streams, record the turn-end and assistant-start sequences (ChatML, Llama 3 headers, Gemma turns) |
| BOS added only if a `<s>` token exists | `engine.rs:831, 2160` | BOS / EOS from `tokenizer_config.json` special tokens and `generation_config.json` |
| sampling defaults 0.7 / 0.8 / 20 | `state.rs:69-71` | defaults from `generation_config.json` (Qwen3.8's is 1.0 / top-k 20 / top-p 0.95 [AUD App. B]) |
| fixed template kwargs (no `enable_thinking`, no tools) | `template.rs:78-83`; `api.rs:8-25` | pass kwargs through |
| HF-id loads never fetch `chat_template.jinja` | `model.rs:464-469` | download it; the Qwen3.8 MLX export keeps its only template there [AUD K-02] |
| only `tokenizer.json` loads; `--tokenizer` is ignored for safetensors | `model.rs:466, 601, 714`; `:431-438` | accept a SentencePiece `tokenizer.model`, or honour `--tokenizer` for safetensors dirs (LOUD today, not SILENT) |

Without discovered turn marks, a non-ChatML model's prefix cache falls back to margin and grid splits only (`prefix_cache.rs:252-258`), so follow-up turns reuse less [AUD P-02].

---

## 10. Phased refactor roadmap

### 10.1 Phases

| phase | items | effort [E] | risk [I] | gate that proves it | unlocks |
|---|---|---|---|---|---|
| **G0** harness and measurement debt | vendor the harness into `engine/bench/` (gpu-lock, gpu-lock-quiet, wt-bootstrap with its hard-coded `REPO` / `SEED` made parameters, session runner, client, analysis, samplers, footprint guard, passages, interposer, GEMM harness) [LAND Rec 1; CAT R1]; an in-repo gate script [CAT R4]; a floors tool (bytes per round from the safetensors, the per-dispatch fit from `TH_BENCH_Q4` → F_bw, F_k) [CAT R5]; port `TH_BENCH_ROUND` from `5090f18` [LAND Rec 10]; move the bench code into `bench.rs` [CAT R10; RI #6]; measurement debt: `pf_env` → `gpu_cores()` (`quant_kernel.rs:5109-5112`), sync or rename the prefill timer (`engine.rs:657-665`), fix the legacy-logits line (`main.rs:408-417`), read `TH_PHASE_TIME` once (`qwen35.rs:4993`), an `AffineQpf` fallback (RI #5), the `seed \| 1` collision (`engine.rs:1367`) [LAND Rec 11; CAT R6]; embed the git sha at build time and serve it in `/status`, as the app does (AGENTS.md invariant 13) [I] | harness S–M (1–2 days) [LAND Rec 1]; each debt S [LAND Rec 11]; gate script S–M; floors S; `TH_BENCH_ROUND` S; bench split S–M [CAT §11] | low. Two items change behaviour on purpose: the seed fix changes sampled streams and the core-count fix changes prefill routing on non-40-core GPUs; gate both as declared numerics changes | Qwen3.8 42/42 · 42/42, R0a and `TH_SAMPLE=check` unchanged, apart from the declared seed change | every later phase is measured with one command; the harness cannot be lost again |
| **G1** descriptor, route plan, guards | R1 ArchDescriptor (§5.1–5.2); R2 route plan and guards (§5.5), first the split-kernel group guard (`attn_kernel.rs:909`) and the stale `:218` comment; R10 chat and tokenizer adapter (§9); R14 hardware probe (promote `mpp_probe`, `quant_kernel.rs:2578-2644`, to a gate that exits non-zero; one core count everywhere; non-MPP routes where MPP is missing) and `th-engine inspect --compile` (§5.5); R8 DFlash descriptor (§6.3); key the process-global pipeline caches (G-09, Q-03) | M, M, S–M, S–M, S–M [AUD §5] | low–medium: parsing and guards; the Qwen3.8 descriptor must reproduce today's derived values exactly | Qwen3.8 bit-identical; synthetic configs across the R12 sweep values (below) give an eager route or a named error, never a silent run | new models fail loudly and name the reason; `/status` shows arch and routes |
| **G2** correctness for new geometries | R12: parameterise the tiny test models (`qwen35.rs:5769-5835, 5970-6068`) over DK ∈ {64, 128, 256}, Hk:Hv ∈ {1:1, 1:3, 16:48}, conv K ∈ {3, 4}, head_dim ∈ {128, 256}, GQA ∈ {1, 2, 6, 8, 12, 16} for both `attn_decode` and the split kernel (extend `split_library_compiles` and `split_attention_matches_single_pass`, both fixed at (24, 4, 256), `attn_kernel.rs:1943-1966`; group 12 should fail the second today [I]), dense vs MoE, and compare each fused path with its eager oracle [AUD R12]; a golden-fixture pipeline (transformers bf16 and mlx-lm on the pack → ids, last-position logits, greedy ids, teacher-forced verify windows, quant top-1 / KL) [LAND Rec 2]; the load-time kernel self-check [LAND Rec 8] | M; M (2–3 days); S–M | low | fused == eager on every tiny geometry; Qwen3.8's golden fixtures reproduce | correctness in hours on day 1; identity baselines for CI-1 |
| **G3** tune job and tables | R6: `th-engine tune`, `TuneKey`, JSON tables; `DECODE_TILE_TABLE` becomes a seed (§5.6) [AUD R6; LAND Rec 7] | M–L [LAND Rec 7] | medium: class-B picks change acceptance (Gate A [B §3.1]); the kernel bench mis-ranks [K45 §3.1] | on Qwen3.8 the job reproduces today's policy, so the engine stays bit-identical; every winner confirmed in situ | per-(model, GPU) tuning without hand-copied tables; M3 / M4 / M5 Pro portability |
| **G4** StateSpec and backend traits | the StateSpec and the spec-driven R0a (§5.3) [LAND Rec 3]; R4 capability traits and per-layer composition (§7) | M (3–5 days); L | high: touches `forward_inner` / `forward_batch` and the other developer's files; Phase B's multi-slot refactor carried 8 confirmed state-machine bugs [B §2.2] | R0a and its discrimination arm; hit == miss; `TH_BATCH=2/4` smokes; server identity 42/42 · 42/42 | attention-only models; new state kinds; MoE plumbing |
| **G5** drafter trait, DFlash descriptor, MTP | R7 (§6.2–6.4); R8 if not done in G1; R9 (§6.6); assistant pairs after G4 | L; S–M; L–XL [AUD §5] (drafter trait + native MTP together: L, 1–3 weeks [LAND Rec 6]) | medium–high: the DFlash path must stay bitwise (L1, B1, S1 unchanged); MTP adds state to rollback and checkpoints | DFlash streams bit-identical to today; the §6.5 gates for MTP | speculation for any MTP-bearing model without waiting for a trained draft |
| **G6** kernel templates, first new quant scheme | R3: GDN `PER = DK/32` register arrays, conv taps as a define, presum over DV/64 groups; attention prepare / decode channels per thread from D, with `HAS_GATE`, `HAS_QK_NORM`, `ROPE_STYLE`, `SCALE`, `WINDOW` defines; the split kernel beyond group 8 (loop the page softmax over fused rows inside the fixed 8-simdgroup MPP scope, `attn_kernel.rs:762-767`, or raise the threadgroup to 4·M together with that scope; re-budget threadgroup memory, which reaches 33.5 KiB at group 16 with f32 probabilities [D]); every pipeline cache keyed; commit descriptors in a buffer [AUD R3]; R5's first scheme, affine 8-bit / mixed (§8) | L; L per format (loader S, M per kernel family [LAND Rec 5]) | high for performance: a generic kernel can lose the specialised win (§3.2) | bitwise at the Qwen3.8 dims (widths-style tests) and eager-exact at the new dims; `TH_BENCH_MULTI` no regression; server identity | new dims and new quant formats on the fast path |
| **G7** new operator families, streaming loader | per target (§12): chunked GDN prefill (already the top 27B prefill lever: 145 ms at 1.45k and 750 ms at 7.9k of prefill GPU time [E §6.2]); MoE expert kernels, routing and tuning; fused hyper-connection read / write; the QSA indexer, sparse attention and its ring state; the n-gram embedding's SSD gather and conv state; YaRN; for Gemma 4, head_dim 512 attention, sliding-window rings and KV sharing [LAND Rec 12]; R13 streaming loader (mmap each shard, build device tensors from mapped bytes, repack per tensor, drop host copies) [AUD R13] | L (weeks) [LAND Rec 12]; M [AUD R13] | high: new operators and new state kinds | per-op tests against the reference; StateSpec R0a; memory plan within budget | the Qwen4 architecture preview and Gemma 4 |
| **G8a** product path (now, beside G0–G1) | a th-engine catalog entry for the optimised pack (kind safetensors, its draft dir, resident ≈21–25 GB and a 27.9 GB cold-7.9k peak phys_footprint [E §1.5] [D]) in both `Engine/THEngineCatalog.swift` and `daemons/go/internal/engine/catalog.go`; `--draft` handling in the Go daemon's `SpawnArgs` (`supervisor.go:59-67`); a local-directory model entry in the ENGINE tab (today only catalog rows, `EngineTab.swift:265-305`); spawn-args unit tests in both clients (none exist) | S–M (estimate here) | low | spawn-args tests; the maintainer serves the pack from the ENGINE tab and `GET /engine` shows it (playbook §9.3) | the optimised path is reachable from the product |
| **G8b** server and app contract | R11: `/status` gains `arch`, `routes`, `capabilities` with reasons, `memory_plan` (with `max_context_tokens`) and `build`, while `maximum_context_tokens` keeps its meaning (`EngineTab.swift:123`); `th-engine inspect` with registry tiers; catalog entries and fit from `inspect` in both clients; DFlash auto-attach by the manifest (X-04: `repo_id` match when present, revision warning, the geometry checks of §6.3); remove the absolute developer path (`EngineSupervisor.swift:102`), keeping `TOKEN_HORIZON_TH_ENGINE_BIN` as the override [AUD R11] | M | low–medium: two clients consume `/status` | key-path diff additive only; no key either client reads changes meaning | the app and the daemon can offer and size new models |

**What G8 does not change** (AGENTS.md invariant 21): th-engine stays prefix-only in the gateway (`/th-engine` → `ProviderTHEngine`, `gateway/infer.go:28`; upstream `gateway/config.go:77`), so `inspect` tiers and model-id classification never feed auto-routing; attach-or-spawn and `stop()` semantics stay as they are; an app-spawned `th-engine inspect` never binds `:8001` and never runs inside a `gpu-lock` measurement window.

### 10.2 Dependencies

```
G8a (no prerequisite; land it with G0)
G0 ──► G1 ──┬──► G2 ────────────┐
            ├──► G3 ────────────┤
            └──► G8b (keys)     │
                                ▼
                               G4 ──┬──► G5 ──► G8b (X-04 auto-attach)
                                    └──► G6 ──► G7
R13 (streaming loader, in G7) can land any time, but before the first model above ~60 GB [AUD R13].
```

This follows [AUD §5]'s order: R1 then R2; then R10, R14, R6, R8 and R12 in any order; then R4; then R3, R5 and R7; then R9, then R11, except that the catalog half of R11 (G8a) moves to the front: a model the product cannot serve is not supported [I].

### 10.3 Critical path per target

| target | minimum to be correct | minimum to be fast |
|---|---|---|
| (a) Qwen4-class dense hybrid | G0 → G1 → G2 (+ G8a to reach the product), plus G6 if the GDN or attention dims, the GQA group (> 8) or a gate kind differ | + G3; G4 → G5 for MTP |
| (b) MoE | G0 → G1 → G2 → G4 → G7 (MoE FFN, gather kernels), plus R13 for large packs | + G3 MoE entries; a MoE-aware verify policy; G5's DFlash descriptor |
| (c) native MTP | nothing: it runs today with n-gram speculation | G0 → G1 → G4 → G5 |
| (d) Gemma 4 / Llama | G0 → G1 → G4 (attention-only backend) → G6 (head dims, flags), plus G7 for sliding windows, plus the chat adapter | + G3; a drafter (G5) |
| (e) new quant format | G1 (quant map) → G6 (R5) | + G3; new floors |

### 10.4 Regression oracle for every step

Every step of every phase runs the playbook's Stage 7 suite (MODEL-OPTIMISATION-PLAYBOOK.md §8.3) on Qwen3.8 before it merges: the unit suite with every bitwise test; R0a and the `TH_GDN_COMMIT=step` discrimination arm; prefix hit == miss 42/42 · 42/42; T=0 text identity against the golden streams; `TH_SAMPLE=check` 0 mismatches; the `TH_BENCH_MULTI` ladder within noise; `/status` additive, with no consumed key redefined [AUD §5; E §4.1]. A step that changes Qwen3.8 numerics on purpose declares it and ships the noise-floor protocol (playbook §5.5).

---

## 11. Perf-CI proposal

### 11.1 Tiers

Adapted from [LAND §9.1]; durations are what the program's equivalent holds took.

| tier | trigger | runner | contents | passes when | duration precedent |
|---|---|---|---|---|---|
| CI-0 | every commit | CPU, plus Metal unit tests | `cargo build --release` with 0 warnings; `cargo test --release` (bitwise and exactness gates: 92 tests at integration-4 [E §4.1]); CPU-only routing-policy tests over shape × core count × GPU family (Splash runs 84,240 decode workload/device combinations this way, `S: dev/benchmarks/device-policy.md:76`); `TuneKey` parity test; descriptor tests over synthetic configs | all green | — |
| CI-1 | any PR touching `engine/` | GPU, under `gpu-lock` | for every onboarded model: R0a (discrimination arm, `TH_BATCH=2`, long prompt); prefix cache on / miss / 0; `TH_SAMPLE=check`; T=0 id streams against golden; logits against golden and the noise floor; `TH_BATCH=2/4` smokes; the `/status` contract, including both clients' keys; the `TH_BENCH_MULTI` ladder against the last main | every gate exact; the ladder within noise | the Phase D and E gate holds took ≈13 and ≈43 min [D §4.1; E §4.1] [D] |
| CI-2 | nightly, in a quiet window | GPU | a `fin4d`-class palindrome against the previous main: ms/round, tokens/round on identical text, loop tok/s per mode, TTFT classes, peak phys_footprint, plus a same-code T=0 control arm | no regression beyond the noise band (§11.2) | an 8-arm block ≈34 min (Phase E S2); the 14-arm Phase D hold ≈2 h [E §1.1; D §1.1] [D] |
| CI-3 | weekly, or before a release | GPU, hours | a same-session competitor comparison; a many-seed acceptance study; an 8k acceptance study; memory at 12k–16k under the guard | a standing report | — |

### 11.2 Thresholds

- **ms/round per mode.** Fail when the paired ratio's CI leaves the noise band. Take the band from measurement: the same-session T=0 control arm of unchanged code bounded noise at ±3–5 % (load 11–27) [DS §8.3], and Phase E's quiet replicate had a per-arm spread of ±3–5 % [E §1.1].
- **Tokens/round** is compared only on byte-identical text; otherwise the report says "texts differ".
- **Identity.** T=0 id streams must match the golden set exactly unless the PR declares a numerics change; a declared change then needs a first-divergence report, logits inside the noise floor and an acceptance A/B.
- **TTFT** per class, with position-paired CIs; **peak phys_footprint** under a guard.
- **Ceilings** sit just above the measured-good distribution. MTPLX's old gate failed only on gaps above 2 s, so the whole 0.2–0.8 s freeze regime passed green (`X: mistakes/mean-tps-and-sliding-averages-…md:30-32`).

### 11.3 Artifacts

- Per request, `runs.jsonl`: text, ids, deltas, `/status` deltas, GPU and CPU ms, load, thermal level, log offsets [C App. A].
- Per run: binary sha256, git sha (after G0), model digest, tune key.
- Output: a markdown summary in the playbook's §10 format, and results stored per commit for trend queries, in the style of llama.cpp's compare tooling [LAND §9.4].

### 11.4 Machine and scheduling

- CI-2 and CI-3 need a reserved quiet window or a dedicated machine: on the shared machine load1 never fell below 6 in 124 one-minute samples of one review round [DS §8.3], and quiet replicates were the only standings the program accepted [E §0].
- One `gpu-lock` for every GPU job, including CI; a phys_footprint guard on every long-prompt job (a 32k probe rebooted the machine [DL §6.1]); never a competitor beside a th server [Bb].

### 11.5 What not to automate

- Promoting loaded numbers to a standing: the ×1.301 claim had to be withdrawn [DG §0].
- Promoting class-B changes without acceptance evidence [LAND §9.5].

---

## 12. Per-target work packages

### (a) Qwen4-class dense hybrid

- Qwen4 had not shipped as of 2026-09-28; its public architecture preview is Qwen3.8-Flash-Next [LAND §4.2]. Its dims below are from MTPLX's port (`X: mtplx/models/qwen4_exp.py:73-111`).
- **GDN.** The geometry matches the 27B's (16 key heads, 48 value heads, dk = dv = 128, 4-tap conv, `:87-91`), so the step and commit kernels fit; **the norm gate does not**: `output_gate_type` is `sigmoid` (`:92`; `SigmoidRMSNormGated`, `:686-688`) where the 27B pack's is `swish`, and th hard-codes `silu(z)` (`gdn_kernel.rs:430-443, 624-637`) without reading the field. SILENT until the descriptor carries the gate kind (G1) and the epilogue takes it (G6).
- **Attention** (24 q heads, 2 KV heads, head_dim 256, `:75-77`): group 12 fits the fused prefill (group ≤ 16, `attn_kernel.rs:1613-1615`) and the single-pass decode kernel (`32 × group` threads, `:589-593`), but **not the split decode kernel** (group ≤ 8, §3.1 A-03), which today would run it wrong with no error; [LAND §4.1] says it fits, and that is wrong. Run it with `TH_ATTN_SPLIT=0` until the G1 guard lands; until G6 widens the kernel, the model forgoes N3's long-context win (Phase D: round growth from bench context to 7.9k +2.9 ms after N3 + N4, against +61.1 ms on the previous main [D §0]). The preview's attention layers are QSA sparse attention, which needs its own mixer anyway (G7); the group limit applies to every plain full-attention path on the way there.
- **Residual.** Hyper-connections widen the residual to 4 × 2560 = 10240 (`:103, 1110`) with a grouped RMSNorm (`:666-683, 1111`), no input or post-attention norms, and a gated rank-1 write (`:572-599`). That is a new fused op (G7), not a wider add + RMSNorm (whose per-row kernel stops at C ≤ 7936, `gdn_kernel.rs:2139, 2207`); th fails LOUD on the model today (`qwen4_exp_text` does not route, `model.rs:639, 691`; past routing, the missing `input_layernorm`, `qwen35.rs:3040`); and a DFlash or MTP tap must name the stream or the read mix (§6.1).
- Needed: descriptor fields for `layer_types`, gate kinds, YaRN and the zero-centred norms (G1); the split-kernel group guard (G1); a retune (G3); a drafter (G5); kernel templates where dims, group or gate kind differ (G6); the MoE and hyper-connection ops (G7); a catalog entry in both clients (G8a).

### (b) MoE

- A MoE FFN (router top-k with `norm_topk_prob`, stacked experts, a shared expert with its sigmoid gate), gather-Q4 kernels for m ≤ 8 (up to rows × k distinct experts per call), a grouped token-sorted prefill GEMM, MoE tile-policy entries, and a new presum design, because the chain stops at the router [AUD §4b].
- **Loader.** MLX MoE packs store the experts stacked with a leading expert axis (`switch_mlp.{gate,up,down}_proj.{weight,scales,biases}`; MTPLX concatenates `switch_mlp` gate / up on axis 1 but `shared_expert` on axis 0, `X: mtplx/models/qwen4_exp.py:2426, 2449-2455`). th's loaders take `dims[0]` as `out` (`Weights::get`, `qwen35.rs:174-187`; `get_lin`, `:212-225`), so a stacked tensor fails LOUD at the scales reshape, and `QLin`, `fuse_lins` (`:1544`) and the tiled repack (`maybe_tiled`, `:853`) are 2-D only. A stacked-expert `QLin` (or a per-expert split at load) and an expert-contiguous repack come before any gather kernel.
- Speculation economics change: extra verify rows touch extra experts, so re-measure the verify ladder before keeping L1 [AUD S-02; LAND §7.2].
- Scale: the Flash-Next packs are about 74–83 GB resident with 78–87 GiB peaks (`X: README.md:74-75, 129-130`), and th's loader peaks near twice the weight bytes, so R13 comes first [AUD W-05].
- The MoE target's DFlash draft differs in every constant, so R8 is a prerequisite [AUD §4b]. Splash's MoE ops and MoE tuner are the study material (`S: runtime/ops/MoE.cpp`, `S: dev/tuning/MoeTuning.cpp`) [LAND §4.1].

### (c) Native MTP heads

- Everything in §6.6. The preview's MTP head is 4B parameters, trained over multiple steps [ext] (web sources W5 / W6 of [LAND §4.1]). MTPLX auto-tunes depth per machine and saves a depth only if it beats AR (`X: README.md:135, 171-179`).

### (d) Gemma 4, Llama

- The attention-only backend (§7, step 4) with: head_dim 128 decode (A-01) and head_dim 512 variants for Gemma 4's global layers; attention without the gate and with q/k norm optional; RoPE variants including Llama-3 scaling; an attention-scale override and logit soft-capping; sliding-window ring caches (the checkpoint-view invariant G-12 breaks for them); GeGLU; sandwich norms; the `(1 + w)` norm convention; a tied lm_head on the Q4 kernels (C-08); attention bias for Qwen2-style checkpoints [AUD §4d; LAND §4.3].
- Gemma 4 adds KV sharing across layers (E-series), per-layer embeddings and a dense GeGLU FFN in parallel with a 128-expert top-8 MoE (26B-A4B); its assistant drafters share the target's embeddings and KV [LAND §4.3] [ext].
- The chat adapter (§9): non-ChatML turn marks, the model's own BOS, its generation defaults.

### (e) New quant format

- §8. Formats in current Mac packs: MTPLX's dynamic 4-bit with 8-bit sparse-attention projections, an 8-bit group-64 body, a 4-bit group-32 n-gram table (`X: README.md:74-76`), and a ternary 2-bit container (group 128, biases == −scales, `X: mtplx/kernels/ternary_qmv.py:3-6`); Splash uses q8 in its MoE package (`S: runtime/model/ModelDescriptor.mm:260-268`) [LAND §4.5].

---

## 13. Risks and open questions

- **Qwen4 may diverge from its preview** [LAND §11].
- **MoE verify cost on Apple is unmeasured.** How it scales with rows and distinct experts touched decides whether "verify all rows" still pays [LAND §11].
- **candle 0.11 constraints:** pooled buffers are freed only at host syncs and the pool is wired; command buffers are batched at 50 encoders with a 64-buffer cap that blocks the host; there are no MoE gather kernels; custom ops bring their own bug classes [LAND §11; DL §4.2].
- **Generalising a specialised kernel can lose its win** (§3.2) [I]. Keep the specialised variant selectable by the route plan until the generic one matches it in situ.
- **Draft source.** A new target needs a Splash package, a converter from HF-format DFlash 2 checkpoints, or native MTP [LAND §11].
- **Portability.** th's kernels use MPP / cooperative tensors heavily and the neural accelerators arrive only with M5; M1–M4 need ALU fallbacks and self-checks. MLX once mis-enabled its NAX path on A18-class GPUs and returned wrong numbers [LAND §4.5, §11] [ext].
- **Headroom.** 74–83 GB packs (`X: README.md:74-75`) on a 128 GB machine leave little room for probes, so the footprint guard is mandatory [LAND §11].
- **Ownership.** Most phases touch the other developer's files (`dflash.rs`, `draft_kernel.rs`, `engine.rs`, `main.rs`, `model.rs`, `qwen35.rs`) and need their sign-off [E §5].
- **Open questions** [LAND §11]: adopt a packed, validated format (Splash-style mmap sections plus a manifest), or stay on HF / MLX packs plus a descriptor? Who reviews and owns the tuned tables? (The competitor for models Splash does not package is settled in the playbook, §2.4 and §3.1: MTPLX first, standing on client wall tok/s over identical requests, the per-round split for th alone unless the competitor exposes a verified verify count.)
