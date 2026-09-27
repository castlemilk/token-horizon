# th-engine coupling audit: what is Qwen3.8 / `qwen3_5`-specific, what is architecture-agnostic

*Written 2026-09-28 for the "new model optimisation job" (a Qwen4-class model, a MoE, an MTP-headed model, Gemma or Llama, a new quant format). Snapshot: `main` @ `b31ca91`. This is a read-only analysis: no code was changed and no new measurements were taken.*

**Scope.** `engine/src/*.rs`, the Rust/candle engine (≈32k lines: `qwen35.rs`, `quant_kernel.rs`, `gdn_kernel.rs`, `attn_kernel.rs`, `draft_kernel.rs`, `sample_kernel.rs`, `dflash.rs`, `prefix_cache.rs`, `engine.rs`, `model.rs`, `server.rs`, `api.rs`, `state.rs`, `template.rs`, `turboquant.rs`, `outbuf.rs`, `gpuprof.rs`, `attn_bench.rs`, `main.rs`), plus the Swift supervisor and catalog in `clients/macos/Sources/TokenHorizon/Engine/`. The TypeScript files that share `engine/src/` (`server.ts`, `dag-runner.ts`, `cli.ts`, …; npm package `token-horizon-engine`, a "micro agent workflow engine") are a separate package and out of scope.

**Conventions.**

- `file:line` references are at `b31ca91`. Bare file names are in `engine/src/`. `reports/…` means `engine/reports/perf-2026-09/…`. `clients/…` and `docs/…` are relative to the repo root.
- Every number names its source: a phase report (e.g. `reports/phaseE/PHASEE-REPORT.md:27`), a measurement recorded in a code comment (e.g. `quant_kernel.rs:205`), a checkpoint file, or a reference engine's source. `[D]` marks a statement derived by reading code, not measured. `[E]` marks an estimate (the effort sizes in §5).
- **"Qwen3.8 config"** means `config.json` of the benchmark target `mlx-community/Qwen3.8-27B-4bit` (HF cache snapshot `10c35ca…`, `$TGT` in the reports). Its values: `model_type` `qwen3_5` (text `qwen3_5_text`); hidden 5120; 64 layers; `layer_types` = 3 × `linear_attention` then 1 × `full_attention`, repeating; GDN 16 key heads and 48 value heads of 128; attention 24 q heads and 4 kv heads of 256; `partial_rotary_factor` 0.25, `rope_theta` 1e7, `rope_type` `default`, `mrope_section` [11, 11, 10]; vocab 248320; `attn_output_gate` true; `output_gate_type` `swish`; `hidden_act` `silu`; `mtp_num_hidden_layers` 1, but the export carries 0 `mtp.*` tensors (and 333 `vision_tower.*` tensors); `quantization` {bits 4, group_size 64, mode `affine`} with no per-module overrides; `generation_config.json` temperature 1.0 / top_k 20 / top_p 0.95 and eos [248046, 248044].
- **Verdicts**, used in every "what breaks" column:
  - **OK**: works unchanged.
  - **SLOW**: correct, but on a fallback or untuned path.
  - **LOUD**: fails with an error at load, the first forward, or the first speculative round.
  - **SILENT**: runs and produces wrong numerics with no error. This is the class to eliminate first.
  - **PANIC**: the process panics.
  - **N/A**: the feature does not exist and needs new code.
- **Scenario columns:**
  - **(a)** a Qwen4-class *dense* hybrid (GDN + full attention) with different dims;
  - **(b)** a MoE (Qwen3.6-35B-A3B-class, or a Qwen4 Flash-Next-class MoE);
  - **(c)** a model with native MTP heads and no external (Splash) draft;
  - **(d)** a non-Qwen family (Gemma, Llama).

## 0. Summary

### 0.1 The shape of the code

th-engine has three layers, and they differ a lot in how portable they are.

1. **Architecture-agnostic shell (mostly OK).**
   - What it covers: HTTP and wire types (`server.rs`, `api.rs`), live config and counters (`state.rs`), the Jinja renderer (`template.rs`), the request loop with stop handling and UTF-8 streaming (`engine.rs`), the prefix-cache store and chunk-plan policy (`prefix_cache.rs`), the sampling and acceptance arithmetic (`sample_kernel.rs`), allocation helpers (`outbuf.rs`), the GPU profiler (`gpuprof.rs`), and TurboQuant (`turboquant.rs`, parameterised by `head_dim`).
   - The prefix cache describes itself as "backend-agnostic (the state type is a parameter)" (`prefix_cache.rs:37-39`).
   - The couplings here are policy defaults and token assumptions (ChatML turn marks, a `<s>` BOS, Qwen sampling defaults, DFlash-shaped proposals), not math.
2. **One model port: `qwen35.rs` + `gdn_kernel.rs` + `attn_kernel.rs` + `quant_kernel.rs`.** The Rust side reads most dims from `config.json`, but:
   - kernel-critical fields fall back to Qwen3.8 values when they are absent;
   - the Metal kernels bake in Qwen3.8 geometry that the Rust side never checks;
   - every tile policy was measured on Qwen3.8-27B shapes on the M5 Max 40-core GPU.
3. **One draft port: `dflash.rs` + `draft_kernel.rs` + the DFlash parts of `quant_kernel.rs` and `sample_kernel.rs`.**
   - Every dimension is a compile-time constant of `incoai/Qwen3.8-27B-DFlash2` (`dflash.rs:30-52`) and of Splash's MDFD0004 packed format.
   - Nothing is read from the Splash package manifest.

### 0.2 Findings

Details, and the complete list, are in §3.

| # | finding | where | class |
|---|---|---|---|
| F1 | GDN fused step and commit hard-code DK = 128: loops run `DK/32` times but address `lane*4 + i`, with four state registers per lane. The Rust guard checks only `dk == dv`. The presum epilogue hard-codes DV = 128, and its guard checks only `dv % 64`. | `gdn_kernel.rs:373-426, 567-620, 1411-1450, 447-460`; guards `1116, 1213-1224, 1498`; `reports/PHASEC-REPORT.md:272` | SILENT |
| F2 | Attention prepare and decode hard-code head_dim 256: prepare runs one thread per channel in a 256-thread group; decode runs 8 channels × 32 lanes. A code comment acknowledges the assumption; nothing guards it. | `attn_kernel.rs:134-205, 218-266, 516`; `qwen35.rs:4416-4419`; review MEM-8/N7/m4, `reports/PHASEB-REPORT.md:336` | SILENT |
| F3 | The split-key verify attention runs its softmax with 4 lanes per fused row inside a 256-thread group. That covers at most 64 fused rows, i.e. a GQA group of at most 8. Its guard checks only `nh % nkv`, `d % 32` and `d ≤ 1024`. [D] | `attn_kernel.rs:654-658, 1079-1082, 909` | SILENT (inferred) |
| F4 | Config parsing encodes Qwen3.8. `head_dim` defaults to 256, so the documented `hidden / heads` fallback is dead code. Other GDN and RoPE fields also default to Qwen3.8 values. Never read: `layer_types`, `attn_output_gate`, `output_gate_type`, `rope_type` and scaling, `quantization`, `mtp_num_hidden_layers`, `generation_config`. | `qwen35.rs:31-99` (`43-44, 65, 86-88`) | SILENT |
| F5 | Quant bits and group size are hard-coded to 4 and 64, per-module quant overrides are unsupported, and the weight prefix `language_model` is hard-coded. | `qwen35.rs:169, 3009` | LOUD or SILENT |
| F6 | Hard limits: more than 64 GDN value heads panics at load; more than 56 GDN layers makes the default one-dispatch rollback commit bail; a conv kernel other than 4 taps, or DK ≠ DV, fails at the first decode. | `qwen35.rs:3060-3067`; `gdn_kernel.rs:1303-1304, 1501-1503, 1116, 1160-1167` | PANIC or LOUD |
| F7 | Some process-global pipeline caches have no key. The `gdn_step` pipeline and `gdn_lib` compile with the first caller's HK/HV/DK/DV; QMV/QMM/DEQ compile with the first group size. | `gdn_kernel.rs:671, 759-777, 2303-2330`; `quant_kernel.rs:2571-2574, 2646-2668`; review MEM-12/N8, `reports/PHASEB-REPORT.md:338` | SILENT once a second geometry shares the process |
| F8 | The prefill tile policy takes its core count from `TH_GPU_CORES`, defaulting to 40, instead of the IORegistry probe the decode policy uses. The Q4 path assumes Metal 4 / MPP and has no capability fallback. | `quant_kernel.rs:5103-5114` vs `61-78`; `3320-3334`, `2578-2644` | SLOW, or LOUD on other GPUs |
| F9 | Every advanced feature exists only for `ModelBackend::Qwen35`: speculative decoding, DFlash, batching, prefix cache, TurboQuant, KV reserve. GGUF and dense backends get plain decode. MLX-quantized safetensors that are not `qwen3_5` do not load at all. | `model.rs:65-371, 621-711`; `engine.rs:105-143` | N/A |
| F10 | The only drafter is DFlash. The target captures at layers 5/19/33/47/61, prefix checkpoints store groups of 5 captures, and proposals are fixed 7 × 16 arrays that the GPU acceptance kernels consume. Batching requires a draft. There is no MTP path. | `dflash.rs:30-52, 347-353`; `qwen35.rs:5092-5099, 5297-5309, 3678-3713`; `sample_kernel.rs:62-64, 366-373`; `engine.rs:113-124` | N/A |
| F11 | Chat and tokenizer handling:<br>• turn detection works only for ChatML;<br>• BOS is added only if a `<s>` token exists;<br>• template kwargs are fixed (no `enable_thinking`, no tools);<br>• `generation_config.json` is ignored;<br>• loads by HF id do not fetch `chat_template.jinja`, which is where the Qwen3.8 MLX export keeps its only template. | `engine.rs:482-496, 831, 2160`; `template.rs:78-83`; `model.rs:464-469, 650-656` | SLOW, or output quality |
| F12 | Swift side: the th-engine catalog lists only GGUF Qwen3 models. Fit and eligibility come from Splash. DFlash auto-attach is a substring test on the model id plus "the first draft directory found". | `THEngineCatalog.swift:26-42`; `HardwareProfile.swift:61-135`; `EngineSupervisor.swift:49-84, 445-471` | N/A or LOUD |

### 0.3 What each target class hits first

Walk-throughs are in §4.

| scenario | first failure today | minimum to be correct | minimum to be fast |
|---|---|---|---|
| (a) Qwen4-class dense hybrid, new dims | LOUD at load if `model_type` is not `qwen3_5*` (`model.rs:639, 691`). If it routes: SILENT for GDN DK ≠ 128 or attention head_dim ≠ 256; PANIC for more than 64 value heads; LOUD at the first partial accept for more than 56 GDN layers. | R1 descriptor, R2 guards and route plan, R3 kernel templates for the new dims | also R6 retune, and a drafter (with no Splash draft it gets n-gram only and batching is off) |
| (b) MoE | LOUD at load: `qwen3_5_moe` routes to `Qwen35::load`, which looks for `mlp.gate_proj` (`qwen35.rs:3043-3049`) | MoE FFN (router, stacked experts, shared expert), gather-Q4 decode/verify kernels, grouped prefill GEMM | also a MoE-aware verify policy (L1's premise breaks) and a DFlash descriptor (Splash's MoE draft differs in every constant) |
| (c) native MTP heads, no Splash draft | runs, with n-gram speculation only and batching disabled | nothing | R7 drafter trait and R9 MTP head: load `mtp.*`, MTP KV cache with rollback, a final-hidden tap, depth-k propose |
| (d) Gemma / Llama | LOUD (`unsupported safetensors model_type`, `unsupported gguf architecture`), or candle's GGUF Llama with none of th's kernels or features | R4 attention-only backend on the fast kernels (head_dim 128; attention without gate or q/k norm; RoPE variants; sliding window; GeGLU; sandwich norms; tied lm_head), plus R10 chat adapter | also R6 retune and a drafter |

### 0.4 Recommended boundaries, in payoff-per-effort order

Details are in §5.

1. R1 `ArchDescriptor` derived at load (M).
2. R2 kernel geometry contracts and a route plan (M).
3. R10 chat, template and generation adapter (S–M).
4. R6 tile policy derived at load, with a persisted autotune (M).
5. R8 DFlash descriptor read from the Splash manifest (S–M).
6. R12 geometry-sweep tests and eager oracles (M).
7. R14 hardware capability probe (S–M).
8. R4 backend traits with per-layer mixer and FFN composition (L).
9. R3 kernel templates for the next dims (L).
10. R7 drafter trait (L).
11. R9 MTP head (L–XL).
12. R5 quant-scheme abstraction (L per format).
13. R11 server and Swift contract (M).
14. R13 streaming loader (M).

## 1. Method

- **What was read.** Every Rust file, end to end. For the hot files (`qwen35.rs`, `gdn_kernel.rs`, `attn_kernel.rs`, `quant_kernel.rs`, `dflash.rs`, `engine.rs`, `model.rs`) that includes their MSL sources, guards and tests.
- **What the constants were cross-checked against:**
  - the checkpoint's `config.json`;
  - the installed Splash package manifest (`~/Library/Application Support/Splash/models/incoai/Qwen3.8-27B-Splash/manifest.json`);
  - Splash's per-model layouts (`docs/splash/runtime/model/Qwen3_8.hpp`, `Qwen3_6Moe.hpp`, `ModelDescriptor.mm`);
  - MTPLX's MTP implementation (`docs/MTPLX/mtplx/mtp_patch.py`, `qwen3_5_mtp_patch.py`).
- **Earlier review findings.** Where a finding from an earlier review is still present at `b31ca91`, it keeps its ID: MEM-8, MEM-9 and MEM-12 (`reports/PHASEB-REPORT.md:329-344`), and the DV = 128 presum note (`reports/PHASEC-REPORT.md:272`).
- **What each coupling records:**
  - where it is (`file:line`);
  - what is baked in;
  - why it exists. This is usually a measured win, and it matters: generalising the coupling naïvely can give the win back;
  - a verdict per scenario.

## 2. How a model plugs in today

### 2.1 Load routing (`model.rs`)

| input | route | code |
|---|---|---|
| local dir | `load_safetensors_dir` → `load_dense` | `model.rs:431-439, 599-619` |
| local `.gguf` | `load_gguf` (single file only) | `model.rs:526-533` |
| HF id | `pick_weight_file` picks a `Q4_K_M` gguf if there is one, else the only gguf, else safetensors | `model.rs:441-500` |
| safetensors whose `model_type` (or `text_config.model_type`) starts with `qwen3_5` | `Qwen35::load`: Metal, BF16 activations, MLX affine Q4 weights | `model.rs:629-669` |
| safetensors `qwen2` / `qwen3` | candle-transformers on **CPU in F32**, described in the code as "a correctness/dev path" | `model.rs:671-692` |
| GGUF with `general.architecture` in {`qwen3`, `qwen2`, `llama`} | candle's quantized models on Metal | `model.rs:551-562` |
| anything else | `bail!` | `model.rs:561, 691` |

Two gaps follow from this routing:

- `starts_with("qwen3_5")` also matches `qwen3_5_moe` configs, and `qwen3_5_mtp` configs, whose trunk MTPLX describes as plain `qwen3_5_moe` (`docs/MTPLX/mtplx/qwen3_5_mtp_patch.py:1-20`). Those then fail inside `Qwen35::load` on missing MoE tensors.
- An MLX-quantized `qwen3` or `llama` safetensors checkpoint cannot load at all. The dense path hands the packed U32 weights, scales and biases to `VarBuilder` as if they were F32 [D].

### 2.2 The `ModelBackend` enum is the plug-in surface

- It has six variants (`model.rs:18-25`) and **28 methods**, each a `match` (`model.rs:65-371`). The snapshot, prefix and hold types have only a `Qwen35` variant (`model.rs:27-63`).
- The engine also downcasts directly, for TurboQuant enable (`engine.rs:105-109`) and prefix-cache enable (`engine.rs:139-143`). Most GPU probes downcast too (§3.13).

| capability | Qwen35 | GGUF (qwen2/qwen3/llama) | dense safetensors (qwen2/qwen3) |
|---|---|---|---|
| forward (last-position logits) | fused Metal kernels | candle quantized kernels | CPU F32 |
| `forward_multi` (verify rows) | yes | `bail!` (`model.rs:128-131`) | `bail!` |
| n-gram speculative decoding | yes (`spec_capable`, `model.rs:136-138`) | no | no |
| DFlash | yes | `bail!` (`model.rs:146-154`) | `bail!` |
| batched decode (`TH_BATCH`) | yes, with DFlash only (`engine.rs:113-124`) | 1 slot | 1 slot |
| prefix cache | yes, raw KV only (`qwen35.rs:3537-3539`) | disabled | disabled |
| TurboQuant KV | yes | silently does nothing | silently does nothing |
| KV reserve | yes | silently does nothing (`model.rs:317-322`) | silently does nothing |

What adding a backend costs today:

- a new variant, arms in up to 28 methods and 3 enums, and the engine downcasts;
- nothing forces the arms to agree. Non-Qwen arms return `Ok(())` without doing anything for `set_kv_quant`, `kv_reserve`, `draft_prefill`, `draft_commit` and `restore`.

### 2.3 Inside `Qwen35`

- **Layer composition** (`qwen35.rs:2020-2070`): `Layer { input_norm, kind: Gdn | Attn, post_norm, mlp }`. The schedule is `(i + 1) % full_attention_interval != 0 ⇒ GDN` (`qwen35.rs:100-102`).
- **Projections fused at load.** Each is a row concatenation of packed Q4 weights (`fuse_lins`, `1544-1586`), repacked into Splash's `[tile = row/256][group][col]` layout (`maybe_tiled` / `QLin::tiled`, `853-861, 592-660`):
  - GDN `in_all = [qkv ; z ; a ; b]` (`qwen35.rs:3072-3085`; split offsets at `4056-4067`);
  - attention `in_qkv = [q+gate per head ; k ; v]` (`3118-3122`; split at `4397-4398, 4574-4587`);
  - MLP `gate_up = [gate ; up]` (`3043-3046`).
- **Per-slot state** (`Slot`, `2163-2238`):
  - per GDN layer, a double-buffered `GdnState` (`2084-2095`) with parity bookkeeping (`2102-2139`);
  - per attention layer, raw bf16 K/V or a TurboQuant `QuantKv`;
  - verify caches (`2145-2158`);
  - DFlash capture rows and the draft ring.
- **Forward** (`forward_inner`, `4964-5145`), per layer:
  - norm → mixer → fused add + RMSNorm;
  - fused gate/up with a SiLU·mul epilogue → down;
  - fused add + RMSNorm of the next layer's input.

  K45 "presum" flags are threaded from producer to consumer. DFlash captures are taken after the layers listed in `CAPTURE_LAYERS`. The final norm and lm_head run last, and are skipped for prefill chunks that are not the prompt's last.
- **Routing by row count:**
  - projections: 1 row → K7 `AffineQmvT`; 2 to 8 rows → MPP decode tiles; more than 8 → prefill tiles (`pf_route`) or the legacy MPP prefill (`QLin::linear_ps`, `361-580`);
  - GDN: `seq ≤ 8` → the one-dispatch `gdn_fused_step`; otherwise conv → qknorm → `gated_delta_step` scan (`4072-4178`);
  - attention: `seq ≤ 8` → `attn_prepare` + `attn_decode` / `attn_decode_split`; otherwise the fused causal prefill kernel, or eager (`4402-4671`).

## 3. Coupling inventory

Each table row gives: **ID · where · what is baked in · why it exists · (a) · (b) · (c) · (d)**. "Derived" means computed from the checkpoint at load; "hard" means a literal in the code.

### 3.1 Config parsing (`Qwen35Config`, `qwen35.rs:31-103`)

| ID | where | baked in | why | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|---|---|
| C-01 | `qwen35.rs:43-44, 65, 86-88` | `head_dim` serde default **256**. The `if head_dim == 0 { hidden / heads }` fallback never fires, because the default is 256, not 0. | The Qwen3.8 config sets it explicitly. | SILENT if absent and not 256 | as (a) | OK | configs that omit `head_dim` get 256, then LOUD on tensor shapes |
| C-02 | `qwen35.rs:45-46, 66, 100-102` | Layer schedule is `(i+1) % full_attention_interval` (default **4**). Config `layer_types` (64 entries in the Qwen3.8 config) is ignored. | The 3:1 GDN:attention pattern of Qwen3-Next/3.5/3.8. | LOUD (tensor-name mismatch) if the pattern differs. It cannot go SILENT, because GDN and attention tensor names differ (`linear_attn` vs `self_attn`) [D]. | as (a). Splash validates `layer_types` for its MoE package (`docs/splash/runtime/model/ModelDescriptor.mm:222-236`). | OK | N/A: no GDN layers. With `full_attention_interval` absent it defaults to 4, then LOUD. |
| C-03 | `qwen35.rs:47-56, 67-69` | GDN key/value head dims default to **128**, conv kernel to **4**, head counts to 0. | Qwen3.8 values. | The kernels need DK = DV = 128 and 4 taps anyway (G-02, G-03). | Qwen3.6-35B-A3B keeps 128 (`Qwen3_6Moe.hpp:31-33`). | OK | N/A |
| C-04 | `qwen35.rs:71-79, 94-97` | `RopeParams { rope_theta = 1e7, partial_rotary_factor = 0.25 }`. `rope_type`, scaling factors, `mrope_section` and `mrope_interleaved` are ignored. | Qwen3.8 `rope_parameters` (`rope_type` default). | SILENT beyond the trained context if Qwen4 ships YaRN or linear scaling. | as (a) | OK | SILENT for Llama-3-style scaled RoPE [D]. θ defaults to the wrong value (Llama 5e5, Gemma 1e4/1e6) if the field is absent. |
| C-05 | `qwen35.rs:89-93, 3028-3035` | `max_position_embeddings` defaults to 262144. cos/sin tables `[max_pos, rot/2]` f32 are precomputed on the device. `attn_prepare` reads them with no bound check (MEM-9, `reports/PHASEB-REPORT.md:334`). | Qwen3.8 context. | OK (size grows with context × rot/2 [D]) | OK | OK | OK |
| C-06 | `qwen35.rs:39-40, 5131` | lm_head output reshaped to `vocab_size`. | n/a | OK | OK | OK | OK |
| C-07 | `qwen35.rs:3050` | A single dense MLP width, `intermediate_size`. No MoE fields. | Dense 27B. | OK | **N/A**: `num_experts`, `num_experts_per_tok`, `moe_intermediate_size`, shared expert | OK | OK |
| C-08 | `qwen35.rs:3010-3015` | Tied embeddings make `lm_head = Lin::Dense(embed)`: a BF16 matmul, not the Q4 kernels. The embedding is always dequantized to BF16. | Qwen3.8 is untied (`tie_word_embeddings` false). | SLOW if tied | n/a | n/a | SLOW for tied families (Gemma, small Qwen). The vocab matmul is the largest read in decode. |
| C-09 | `qwen35.rs:4397, 4666-4668`; `gdn_kernel.rs:256-257, 441-443` | `attn_output_gate` (true) and `output_gate_type` (`swish`) are assumed and never read. | Qwen3-Next/3.8 gated attention and gated RMSNorm. | SILENT if Qwen4 changes the gate | OK (3.6 keeps it) | OK | LOUD or N/A: there are no gate rows in `q_proj` |
| C-10 | `qwen35.rs:169` | Quant `bits: 4, gs: 64`. Config `quantization` is ignored. | The only format ever measured. | see §3.3 | | | |
| C-11 | `state.rs:66-83` | Sampling defaults 0.7 / 0.8 / 20, `prefill_step` 512, `spec_tokens` 4. `generation_config.json` (Qwen3.8: 1.0 / 20 / 0.95) is never read. | Qwen non-thinking defaults. | quality drifts from the model card | as (a) | as (a) | Gemma and Llama cards differ |
| C-12 | none | `mtp_num_hidden_layers` (1 in the Qwen3.8 config) is ignored. | There is no MTP runtime. | N/A | N/A | **N/A** (§4c) | n/a |
| C-13 | `model.rs:646-649, 727-733` | EOS comes from the top-level `eos_token_id`, then from `text_config`. | Qwen3.8's top level carries [248046, 248044]; `text_config` carries only 248044. | OK if the top level is complete | OK | OK | OK, but `generation_config.json` eos lists are ignored |
| C-14 | `qwen35.rs:3141-3145` | The number of decode slots comes from `TH_BATCH` (clamped to 1..=8), read inside the model loader. | n/a | OK | OK | OK | OK |

### 3.2 Weight naming, layout and loading

| ID | where | baked in | why | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|---|---|
| W-01 | `qwen35.rs:3009` | Tensor prefix `language_model`, the multimodal-wrapper layout. The Qwen3.8 MLX export has `language_model.*` plus 333 `vision_tower.*` tensors; the vision tensors are ignored. | Qwen3.8 MLX export. | LOUD for a text-only export (`model.*`) | as (a) | as (a) | LOUD |
| W-02 | `qwen35.rs:3039-3127` | Tensor names: `input_layernorm`, `post_attention_layernorm`, `mlp.{gate,up,down}_proj`, `linear_attn.{conv1d, A_log, dt_bias, in_proj_qkv, in_proj_z, in_proj_a, in_proj_b, norm, out_proj}`, `self_attn.{q,k,v,o}_proj`, `q_norm`, `k_norm`. | mlx-lm `qwen3_5` naming. | OK if Qwen4 keeps the names | **LOUD**. MoE blocks are `mlp.gate`, stacked `mlp.switch_mlp.*` and `mlp.shared_expert*` (`docs/MTPLX/mtplx/expert_layout.py:9`, `a3b_whole_moe.py:357-359`). | `mtp.*` tensors are never requested | LOUD. Gemma has `pre_feedforward_layernorm` / `post_feedforward_layernorm`; Llama has no `q_norm` / `k_norm`. |
| W-03 | `qwen35.rs:4056-4067, 4397-4398, 4574-4587` | Split offsets of the fused projections: `z` starts after conv_dim; `a` and `b` together are `2·Hv`; each head is `[q ; gate]` halves. | One matmul per mixer. | OK while the layout holds | OK | OK | N/A |
| W-04 | `qwen35.rs:8-9, 1814-1818` | RMSNorm weights are assumed to be **already +1-offset** by the converter (mlx-lm's sanitize step). | MLX exports. | OK for MLX exports | OK | MTP norms need the same convention; MTPLX guards against applying the shift twice (`docs/MTPLX/mtplx/qwen3_5_mtp_patch.py`, module docstring). | SILENT for raw HF Gemma checkpoints, which use the `(1 + w)` convention [D] |
| W-05 | `qwen35.rs:146-170, 212-263` | The loader reads whole shards into host memory and keeps a CPU copy of every tensor until `load` returns. Tiling repacks through host vectors (`592-660`). | Simple, and fast enough at 27B. | OK at 27B or smaller | Peak is about 2× the weight bytes [D]. A Flash-Next-class MoE (about 74-83 GB resident per `docs/MTPLX/README.md:74-75`) cannot load on a 128 GB Mac. | OK | OK |

### 3.3 Quantization formats

**Accepted today:**

- `qwen3_5` path: MLX affine 4-bit with group size 64. The weight is `w = q·scale + bias`; nibbles are LSB-first, 8 per `u32`; scales and biases are bf16, shaped `[out, in/64]` (`qwen35.rs:105-134, 138-207`). Norms, conv taps, `A_log` and `dt_bias` are unquantized bf16/f16/f32 (`qwen35.rs:153-159, 198-206`).
- GGUF: whatever candle's quantized `qwen2` / `qwen3` / `llama` models support, single file only (`model.rs:526-562`). None of th's kernels apply.
- Dense bf16 safetensors for `qwen2` / `qwen3`: CPU F32.

| ID | where | baked in | why and effect |
|---|---|---|---|
| Q-01 | `qwen35.rs:169, 225-227` | `bits = 4`, `gs = 64`, and `inp = in_pack × 32 / bits`. | The only format measured. The config `quantization` block ({bits 4, group_size 64, mode affine} for Qwen3.8) is ignored. A mixed-precision export (per-module overrides; MTPLX "dynamic 4-bit" packs, `docs/MTPLX/README.md:74`) gets the wrong `inp`: LOUD on shapes, or SILENT if the shapes happen to line up [D]. |
| Q-02 | `quant_kernel.rs:1135-1143, 1158-1163` | Decode arithmetic assumes 4-bit unsigned codes. The fragment-direct kernels use the bit pattern `(0x4300 OR q)`, which is exactly bf16 (128 + q), and subtract `128·Σx` per group. | Port of Splash's `linear_q4_sgmatrix`. The trick needs codes below 128: 4-bit fits, 8-bit does not [D]. |
| Q-03 | `quant_kernel.rs:1202, 3542-3545`; `qwen35.rs:328, 594-599` | Group size 64 in every MPP, sg, prefill and qmvt kernel. Only the scalar `qmv` / `qmm` / `dequant` kernels are templated on `{GS}` (`quant_kernel.rs:1077`). | MLX's default group size. |
| Q-04 | `qwen35.rs:582-660` | Tiled storage `[tile = row/256][group][col]`, rows padded to 256. | Splash `q4_storage_n = 256` (installed manifest field `format.q4_storage_n`). |
| Q-05 | `quant_kernel.rs:265-297` | K45 presum blocks: producers emit input sums per (64-group, row) so consumers do not recompute them. | Valid for any affine format **with a per-group bias**, because the sums multiply the bias. Meaningless for symmetric or FP formats. |
| Q-06 | `model.rs:530-533, 489-491` | GGUF is single-file only, and `Q4_K_M` is preferred. | n/a |

**What a new format needs.** Every format below needs the same base work:

- descriptor parsing, including per-module overrides;
- a CPU reference dequant for tests;
- a tiled repack;
- an m = 1 kernel (qmvt family), m ≤ 8 decode tiles (MPP) and prefill tiles (pf);
- the fused gate/up epilogue;
- tile-policy and autotune entries, bench classes, and a parity test.

The per-format differences:

| format | decode math change | presum (K45) | notes |
|---|---|---|---|
| MLX affine 8-bit, 2/3/5/6-bit, or mixed ("dynamic") | template the bit width; replace the +128 bf16 trick for codes of 8 bits and up | keeps working (still affine) | Cheapest: same layout family, with `bits` read per module from `quantization`. |
| MXFP4 (MLX `mode` other than `affine`) | FP4 E2M1 lookup table, power-of-two shared scale per 32 | drop (no bias) | MLX signals it in the same `quantization.mode` field th ignores today. |
| NVFP4 | FP4 E2M1 lookup table, FP8 E4M3 scale per 16, plus a tensor scale | drop | Group 16 needs new tile K-steps. |
| Ternary (Bonsai-style) | {−1, 0, +1} × group scale, 2-bit or base-3 packing | drop | MTPLX runs "Ternary Bonsai 2 27B" (`docs/MTPLX/README.md:24`), so the format matters on Macs. |
| GGUF K-quants on the fast path | 256-element super-blocks with 6-bit sub-scales | partial | Today these run only through candle's own kernels. |

### 3.4 GDN kernels and the parity / rollback state machine

| ID | where | baked in | why | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|---|---|
| G-01 | `gdn_kernel.rs:109-112, 975-985` | HK/HV/DK/DV are substituted into the MSL at each compile. | Registers are sized at compile time. | derived | derived | derived | N/A |
| G-02 | `gdn_kernel.rs:373-426` (fused), `567-620` (wide), `1411-1450` (commit) | **DK = 128**: loops run `DK/32` times but index `lane*4 + i`, with four state registers `s0..s3` per lane. The only guard is `dk == dv` (`1116`, `1498`). `gated_delta_step`, the prefill scan, is DK-generic (`n_per_t = DK/32`, `133-146`). | Splash's GDN kernel shape: one simdgroup row per dv. | **SILENT** for DK ≠ 128 (decode is wrong, prefill is right) | OK (3.6 uses 128) | OK | N/A |
| G-03 | `gdn_kernel.rs:334-362, 1377-1407` | 4-tap conv (3-row window). | Qwen3.8 `linear_conv_kernel_dim` is 4. | LOUD at the first decode (`1160-1167`, `reports/th-c-gdn-parity.md:62`). The prefill `gdn_conv` is K-generic (`846-883`). | OK | OK | N/A |
| G-04 | `gdn_kernel.rs:55-56, 91-92, 267-268`; `qwen35.rs:3060-3067, 3313-3320` | Per-head gate constants live in `[f32; 64]` tables (`Hv ≤ 64`); `gdn_consts` is `[layers, 2, 64]`. | Passed to the kernel by value. | **PANIC** at load for Hv > 64 (index out of bounds) | OK (3.6 uses 32) | OK | N/A |
| G-05 | `gdn_kernel.rs:289, 1315, 1116, 1498`; `qwen35.rs:3373` | `TMAX = 8` rows for the fused step and the commit. | The DFlash verify block is 8 rows. | OK | OK | OK (depth ≤ 7) | N/A |
| G-06 | `gdn_kernel.rs:1303-1304, 1501-1503` | `COMMIT_MAX_LAYERS = 4096 / sizeof(CommitDesc)` = 56, because descriptors go through `set_bytes`. | One-dispatch commit of all GDN layers. | **LOUD** at the first partial accept of a DFlash round for more than 56 GDN layers (the n-gram path restores and re-forwards instead; workaround: `TH_GDN_COMMIT_ALL=0`) | depends on depth | as (b) | N/A |
| G-07 | `gdn_kernel.rs:148-156, 221-222, 323-329, 383-384`; `qwen35.rs:4199-4205` | Gated-delta-rule semantics:<br>• decay `g = exp(−e^{A_log}·softplus(a + dt_bias))`;<br>• `β = sigmoid(b)`;<br>• q × 1/DK and k × 1/√DK after a unit-weight RMSNorm with a **literal eps of 1e-6**;<br>• gated RMSNorm with SiLU(z). | The Qwen3-Next / 3.5 reference (`qwen35.rs:1-3`). | SILENT if Qwen4 changes any of it (e.g. `output_gate_type`) | OK | OK | N/A |
| G-08 | `gdn_kernel.rs:447-460`; guard `1213-1224` | The presum epilogue sums exactly two 64-groups per value head (DV = 128); the guard checks only `dv % 64`. | K45 lane pattern. | SILENT for DV ≠ 128 with presum on (`reports/PHASEC-REPORT.md:272`) | OK | OK | N/A |
| G-09 | `gdn_kernel.rs:671, 759-777, 2303-2330` vs `955-997` | `gdn_step`'s `PIPELINE` and `gdn_lib` (QkNorm/GateNorm) compile once, with the first caller's dims. The fused and commit kernels use the keyed `gdn_pipe`. | History: written before keying existed. | SILENT once a second GDN geometry shares the process (MEM-12/N8, `reports/PHASEB-REPORT.md:338`) | as (a) | an MTP head built from GDN layers would trip it | N/A |
| G-10 | `qwen35.rs:2074-2139, 2141-2158, 3227-3297, 3299-3464` | **The state machine (G1a parity):**<br>• each GDN layer holds two parities;<br>• a forward reads `cur` and writes `1−cur`, and all layers flip together;<br>• a light snapshot is just a content id, valid across exactly one forward;<br>• `rollback_verify` re-scans the kept rows from the intact parity, using the fused commit, bit-identical to a kept-row forward. | It removed the per-round snapshot copies, part of the −6.35 ms/round G1a win (`reports/PHASEC-REPORT.md:29`). | generic in dims | generic | generic | attention-only models need only KV truncation |
| G-11 | `qwen35.rs:4984, 3412-3417, 3462` | Verify intermediates are stashed only for `seq ≤ 16`. Without them, `rollback_verify` restores the pre-verify GDN state while `kv_tokens` still advances by `kept`. | Verify widths never exceed 8 today. | latent: a drafter with more than 16 verify rows would be SILENT [D] | as (a) | OK | N/A |
| G-12 | `qwen35.rs:3607-3621` | Invariant: K/V rows below `kv_tokens` are never rewritten, so checkpoints can *view* the slot's K/V instead of copying it. | Zero-copy prefix checkpoints. | OK | OK | OK | breaks for sliding-window ring caches (Gemma's local layers) [D] |
| G-13 | `qwen35.rs:5324-5365, 5427+`; `main.rs:245-423` | The R0a gate compares the fused rollback against a *fused* kept-row scan. | Validates the state machine, bit for bit. | It does **not** catch G-02-class kernel math errors; that needs an eager oracle (`TH_GDN_EAGER=1`, `qwen35.rs:1590-1595`). | as (a) | as (a) | n/a |
| G-14 | `qwen35.rs:2084-2095`; `engine.rs:698` | GDN state per slot = 2 parities × `[Hv, Dv, Dk]` f32, plus conv windows. A code comment gives "~151 MB" per checkpoint for Qwen3.8. | n/a | scales with dims (belongs in the memory plan) | n/a | n/a | n/a |

### 3.5 Full attention

| ID | where | baked in | why | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|---|---|
| A-01 | `attn_kernel.rs:134-205, 516` (prepare), `218-266` (decode) | **head_dim 256**. Prepare runs one thread per channel in a 256-thread group, with an 8-simdgroup reduction. Decode runs 8 channels × 32 lanes. | Qwen3.8's head_dim. The fusion covers norm, RoPE and the cache append. | **SILENT** for anything other than 256. It is unguarded (`qwen35.rs:4416-4419`; MEM-8/N7/m4). | OK (3.6 uses 256) | OK | **SILENT** for head_dim 128 models (Llama 3, some Gemma sizes; read the config) |
| A-02 | `attn_kernel.rs:1611-1615` | Fused causal prefill requires `d == 256` and a GQA group of at most 16. This one is guarded; otherwise it falls back to eager. | The fragment loop is built for 2 × 8 fragments of 16 channels. | SLOW if not 256 | OK | OK | SLOW |
| A-03 | `attn_kernel.rs:654-658, 1079-1082, 909` | Split-key verify runs 4 lanes per fused row in 256 threads, so it needs `8 × GRP ≤ 64`, i.e. GRP ≤ 8. The guard checks only `nh % nkv`, `d % 32` and `d ≤ 1024` [D]. | Splash's verify tile. | SILENT for GRP > 8 once 256 or more keys are visible (`SPLIT_MIN_KEYS`, `attn_kernel.rs:90`) | 3.6 has GRP 8 (`Qwen3_6Moe.hpp:35-36`) | OK | Llama-3 70B (GRP 8) is OK; models with GRP 16 go SILENT |
| A-04 | `attn_kernel.rs:589-593` | Single-pass decode uses `32 × GRP` threads, so GRP ≤ 32. | One simdgroup per q head. | OK | OK | OK | OK |
| A-05 | `attn_kernel.rs:164, 258-264, 849`; `qwen35.rs:4574-4579, 4666-4668, 4936-4940` | **Gated attention.** `q_proj` rows are `[q ; gate]` per head. The sigmoid gate is fused into decode and the split reduce with no flag to turn it off, optional in prefill (`PA_GATE`), and also applied in the TurboQuant and eager paths. | Qwen3.8 `attn_output_gate`. | OK | OK | The MTP layer is the same class (`docs/MTPLX/mtplx/mtp_patch.py:908-915, 975`). | **N/A**: needs an ungated variant |
| A-06 | `attn_kernel.rs:181-193`; `qwen35.rs:4589-4590` | Per-head q/k RMSNorm is always applied. | Qwen3 family. | OK | OK | OK | Llama has none, so this needs a flag |
| A-07 | `attn_kernel.rs:195-201`; `qwen35.rs:4010-4037` | **NeoX half-split partial RoPE** on the first `rot` dims (`ROTP = rot/2`). The load-time comment says "Interleaved (GPT-J) convention" (`qwen35.rs:3022-3023`), but every code path pairs `(i, i + rot/2)`. | Qwen3.8: partial factor 0.25 of 256. | OK | OK | OK | Full rotary works (`rot = d`). Families with GPT-J interleaving need a flag. |
| A-08 | `attn_kernel.rs:240, 863, 1587`; `qwen35.rs:4735, 4910` | Score scale is the literal `1/√d`. | Standard. | OK | OK | OK | Gemma's `query_pre_attn_scalar` and logit soft-capping: N/A |
| A-09 | none | No sliding window, sinks, ALiBi, attention bias or sparse attention. | Qwen3.8 needs none of them. | Qwen4's "Qwen Sparse Attention" (`docs/MTPLX/README.md:72`) is **N/A** | n/a | n/a | Gemma's local/global layers are N/A |
| A-10 | `qwen35.rs:3832-3859, 4812-4884` | K/V is `[n_kv, cap, d]` bf16, capacity in 256-row blocks with a 2048-row floor. | Page-aligned for the split kernel (`reports/phaseD/PHASED-REPORT.md:21`). | derived | derived | derived | derived |
| A-11 | `attn_kernel.rs:82-94` | Split defaults: minimum 256 keys, base 16, 8 pages per split, cap 32, f32 probabilities. | Tuned on the M5 Max 40-core (comment at `82-89`). | may be SLOW on other GPUs | as (a) | as (a) | as (a) |
| A-12 | `turboquant.rs:32-45, 174`; `qwen35.rs:3537-3539, 4400-4403` | TurboQuant is eager ops, generic in `head_dim`. It disables the fused kernels and the prefix cache. | v1. | OK | OK | OK | OK |
| A-13 | `attn_kernel.rs:311-351` | `GeomCache` keys pipelines by `(nh, nkv, d, rp)`. | Lets one process run several geometries. | **A good pattern to copy** (for G-09 and Q-03) | n/a | n/a | n/a |

### 3.6 Norms, MLP and the K45 presum chain

| ID | where | baked in | why | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|---|---|
| N-01 | `qwen35.rs:1816-1818, 1927-1963` | RMSNorm only: no LayerNorm, no bias. eps comes from the config, except the literal 1e-6 in the GDN q/k norm and in DFlash. | Qwen family. | OK | OK | OK | OK for Llama and Gemma (both RMSNorm); for the weight convention see W-04 |
| N-02 | `gdn_kernel.rs:2137-2139, 2207`; `qwen35.rs:1946` | The per-row fused add + RMSNorm handles `C ≤ 7936` (32 KiB of threadgroup staging). Above that it uses the legacy single-threadgroup kernel ("~84 µs per 8 × 5120 call", R0c note at `gdn_kernel.rs:1867-1871`) and skips the prefill presum. | R0c latency fix. | SLOW for hidden sizes of 8192 or more | OK (2048) | OK | SLOW for 8192-wide models |
| N-03 | `qwen35.rs:5047-5075`; `quant_kernel.rs:153-166` | MLP is SwiGLU. The N256 two-stream gate/up tile carries the SiLU·mul epilogue and emits `down`'s presum block. It needs `(out/2) % 256 == 0` (`qwen35.rs:790`). | K1: the split-K tile it replaced measured 10-15 % slower on this shape (`quant_kernel.rs:156-160`). | OK if widths are 256-aligned; otherwise the eager epilogue (SLOW) | **N/A** (experts) | OK | GeGLU (Gemma) is N/A |
| N-04 | `qwen35.rs:2065-2070` | A layer has only an input norm and a post-attention norm. | Qwen. | OK | OK | OK | Gemma's sandwich norms are N/A |
| N-05 | `qwen35.rs:1927-1963, 4082-4119, 674-847` | Presum flags chain from producer to consumer: add + norm → `in_all` / `in_qkv` / `gate_up`; gate_up → `down`; GDN gated norm → `out`. | K45(a): −3.2 to −4.1 ms per forward (`reports/PHASEB-REPORT.md:393`). | OK if every consumer is affine Q4 with `in % 64 == 0` | MoE experts break the chain | OK | OK |

### 3.7 Kernel tile tables and shape/hardware-keyed constants

| ID | constant / policy | where | derived or hard | origin |
|---|---|---|---|---|
| T-01 | `DECODE_TILE_TABLE`: {(16480, 5120) → N256 sg8; (17408, 5120) → N256 sg8}. Other shapes get n64s4; very wide shapes (at least 8 × cores tiles) get Paired256. | `quant_kernel.rs:202-244` | **hard** table plus a shape rule | Measured: in_all N256 sg8 117.7 µs vs n64s4 131.3 (`quant_kernel.rs:205`); draft gate/up −11 % (`209-210`). Produced offline by `TH_BENCH_Q4_SWEEP` (`qwen35.rs:888-1345`; `reports/impl-th-wp2-matmul-roofline.md:10, 159-178`). The `(17408, 5120)` entry was flagged dead after K45(d) (`reports/PHASEB-REPORT.md:430`). |
| T-02 | Gate/up tile: N256 sg8 two-stream (policies `seq` and `tuned`), n32s4 (`legacy`). | `quant_kernel.rs:153-166` | rule | Splash `n256_gate_up` |
| T-03 | `PAIRED256_TILES_PER_CORE = 8` and `…_WAVE_GROUPS_PER_CORE = 4`. `mpp_groups` is Splash's `decodeGroups`: {3, 3, 8} × cores. | `quant_kernel.rs:195-200, 3474-3512` | **derived at call time** from tiles × cores | Splash constants |
| T-04 | `PAD_SKIP_MAX_IN = 8192` | `quant_kernel.rs:246-252` | hard | Measured: binding the input directly is 0.5-7 % faster up to K 6144 and 2.4-3.8 % slower at K 17408. |
| T-05 | `QMVT_WIDE_ROWS = 8192`; `qmvt_cfg_for` picks r1s8 at 8192 rows or more, r2s4 below. | `quant_kernel.rs:434-458` | rule | Per-shape µs table at `quant_kernel.rs:441-447`. |
| T-06 | `ps_family_on` defaults to {`split`, `split_long`}. | `quant_kernel.rs:299-318` | hard default | In-situ A/B. One open review item on `down` (`reports/PHASEB-REPORT.md:424`). |
| T-07 | `PF_SHAPES` (8 row × col × sg shapes), `PF_POLICY_SHAPES`, `PF_LARGE_SHAPES`. `pf_policy` has rules on `tiles_n` vs cores and on m; m > 128 goes to the 32×128 vec tile. | `quant_kernel.rs:4523-4534, 4772-4776, 5200-5294` | **rules, derived at call time** from shape and cores | `TH_BENCH_LIN=pf` sweep on the 27B and draft shapes (`quant_kernel.rs:5233-5253`); `reports/phaseE/th-e-prefill-gemm.md`. |
| T-08 | `pf_env` core count = `TH_GPU_CORES`, else **40**. | `quant_kernel.rs:5103-5114` | **hard default (a bug)** | The decode side uses `gpu_cores()`, which reads the IORegistry (`quant_kernel.rs:55-78`). |
| T-09 | Vec-tile layout probe per shape, run at load. | `quant_kernel.rs:4673-4770` | **probed at load** | A good pattern: implementation-defined MPP layouts are verified, not assumed. |
| T-10 | Split-attention defaults; draft-attention split (at most 8 splits, 256 keys per split). | `attn_kernel.rs:82-94`; `draft_kernel.rs:8-43` | hard | M5 Max sweeps (`reports/phaseD/th-d-longctx.md`). |
| T-11 | Unit tests pin the 27B shapes (`LM_HEAD`, `IN_ALL`, `IN_QKV`, `OUT_O`, `DOWN`) and the pf policy table. | `quant_kernel.rs:5902-5992, 5318-5349` | test data | Regression tests of the rules, not a model contract. |

**Tile choice changes numerics, not just speed.** Split-K and sequential-K round differently, and that changes acceptance. Phase B kept split-K on the N = 5120 shapes because sequential-K cost "+19.2 % ms/round for −0.031 ± 0.043 tokens/round" (`reports/PHASEB-REPORT.md:412`). Any autotune for a new model must gate numerics-changing picks on the identity and acceptance gates, not only on µs.

### 3.8 The DFlash draft contract

| ID | where | baked in |
|---|---|---|
| D-01 | `dflash.rs:30-52` | `DRAFT_LAYERS` 5, `HIDDEN` 5120, `QKV` 6144, `ATTN` 4096, `INTER` 17408, `DYN` 1280, `HEADS` 32, `KV_HEADS` 8, `HEAD_DIM` 128, `ROWS` 8, `PROPOSALS` 7, `WINDOW` 2048, `RANK` 256, `TOPK` 16, `CB_ROWS` 248320, `TARGET_HIDDEN` 25600, `MASK_TOKEN` 248070, `CAPTURE_LAYERS` [5, 19, 33, 47, 61], θ 1e7. |
| D-02 | `dflash.rs:50-104, 357-412, 112-159` | Splash's packed format: magic `MDFD0004`, 16 KiB-aligned sections, `layer-{i}.bin` and `model.bin` with (layer, type) headers, exact section sizes. Q4 is repacked from Splash tiles (`out % 256`, `in % 64`, group 64). |
| D-03 | `dflash.rs:490-509, 557, 685-686`; `quant_kernel.rs:592-600` | The draft **shares the target's embedding and lm_head**. Codebooks are `[CB_ROWS, 256]`. The top-16 is taken over `CB_ROWS / 512` = 485 chunks of 512 columns, so vocab must equal `CB_ROWS` and be a multiple of 512. |
| D-04 | `qwen35.rs:5092-5099, 5297-5309, 3885-3902, 3678-3713, 3923-3935` | Target-side contract: after each layer in `CAPTURE_LAYERS`, push `x` (hidden 5120). Drains concatenate groups of **5**. Prefix checkpoints keep groups of 5. The ring warm-up takes the last `WINDOW − 1` rows. |
| D-05 | `draft_kernel.rs:112-113, 120-141, 148-239`; `quant_kernel.rs:661-681, 787-1024` | The draft kernels hard-code 5120 / 1280 / 640 / 320 / 128, 32 heads and a 2048 window. The code says why: "draft dims are fixed by the checkpoint". |
| D-06 | none | **The manifest is never read.** The installed Splash package's `manifest.json` (schema 3) carries:<br>• `execution_geometry`: `draft_proposal_tokens` 7, `draft_query_rows` 8, `draft_sliding_window` 2048, `target_verify_rows` 8, `maximum_batch_width` 4;<br>• `format`: `q4_bits` 4, `q4_group_size` 64, `q4_storage_n` 256, `draft_layer_magic` MDFD0004;<br>• `upstream.target`: `mlx-community/Qwen3.8-27B-4bit`.<br>None of it is read or checked against the loaded target. |
| D-07 | `clients/…/EngineSupervisor.swift:49-84` | Swift passes `--draft` when the model id contains "qwen3.8" and "27", using the first `<org>/<pkg>/draft` directory that has `model.bin` and `layer-0.bin`. |

**Splash already has the descriptor th lacks.**

- **Per-model layouts.**
  - Qwen3.8 (`docs/splash/runtime/model/Qwen3_8.hpp:21-43`): capture layers {5, 19, 33, 47, 61}, mask token 248070.
  - Qwen3.6 MoE (`Qwen3_6Moe.hpp:21-45`): capture layers {1, 6, 11, 16, 22, 27, 32, 37}, hidden 2048, 40 layers, 256 experts with 8 per token, mask token **248077**.
- **Manifest validation.** Splash validates a v4 manifest's draft block (`ModelDescriptor.mm:238-251, 253-317`): architecture `DFlash2DraftModel`, layers, hidden, intermediate, sliding window, block size, dynamic-conv sizes, selector rank and top-k, and `target_capture_layers`.
- **What th does with the MoE draft today.** Pointing th's `--draft` at the MoE package's draft fails at the first section-size check (LOUD) [D], and every constant in D-01 would be wrong for it anyway.

**A model with no Splash draft** gets n-gram speculation only (`engine.rs:1152-1289`; `spec_tokens` defaults to 4) and loses batching (`engine.rs:113-124`).

**A model with native MTP heads** needs a different kind of drafter (§4c):

- the target tap is the *final* hidden state, not five mid-stack layers;
- drafting is k sequential m = 1 steps, not one 8-row block;
- the drafter has its own KV cache, which must be rolled back.

### 3.9 Speculative loop, sampling and acceptance

| ID | where | baked in | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|---|
| S-01 | `engine.rs:931-1150` vs `1152-1289` | The single-slot loop branches on `has_draft()`: DFlash or n-gram. The verify block is the anchor plus `dflash::PROPOSALS` (`427-435, 1001-1003`). | OK | OK | **N/A**: needs a loop that works with any drafter | OK |
| S-02 | `engine.rs:307-320` | Policy L1, "verify all 7", justified in the code as "verify at m ≤ 8 is weight-bandwidth bound, so rows 3..8 cost well under a millisecond". | OK (dense) | **The premise breaks**: each verify row routes to its own experts, so extra rows are not free [D] | depends on the target | OK |
| S-03 | `engine.rs:113-124, 2267-2503` | Batching works only with DFlash (`draft_propose_batch`). | n-gram only, so batching is off | as (a) | N/A | as (a) |
| S-04 | `sample_kernel.rs:47-64, 366-373, 700, 803-804` | GPU acceptance takes a `dflash::Proposal`. `ROWS` 8, `PROP` 7 and `DTOPK` 16 are compiled into the MSL. `q_of` looks the drafted token up in the 16-candidate table and returns 0 if it is not there. | OK | OK | Reusable **if** the MTP drafter samples from its own top-16-truncated distribution; residuals are then exact [D]. | OK |
| S-05 | `engine.rs:1343-1454, 1996-2010, 899` | Sampler RNG and policy, n-gram N = 3, `spec_k ≤ 7`: all generic. | OK | OK | OK | OK |
| S-06 | `quant_kernel.rs:3539-3541`; `gdn_kernel.rs:289`; `qwen35.rs:4403`; `attn_kernel.rs:43`; `sample_kernel.rs:51` | **Verify width ≤ 8 across the whole stack**: decode tiles, GDN fused step, attention decode, split q tile, staged uniforms. | OK | OK | MTP depth ≤ 7 is OK. Block drafters wider than 8 fall back to prefill paths (SLOW), and wider than 16 they hit G-11. | OK |

### 3.10 Prefix cache (T1)

| ID | where | baked in | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|---|
| P-01 | `prefix_cache.rs:37-39, 216-302, 400-413` | The store and the chunk plan are backend-agnostic. The key is (token prefix, `step`, the plan's boundary history). That identity-by-construction rule is what made a hit bit-exact with a miss (42/42 texts and per-round logs, `reports/phaseE/PHASEE-REPORT.md:22`). | OK | OK | OK | OK |
| P-02 | `engine.rs:482-496`; `prefix_cache.rs:134-172` | Turn boundaries are ChatML token ids (`<\|im_start\|>`, `<\|im_end\|>`, `\n`, `assistant`). Without them (`None`), the plan falls back to margin and grid splits only (`prefix_cache.rs:252-258`). | OK (ChatML) | OK | OK | SLOW reuse: follow-up turns hit only the 512-token grid splits [D] (not measured) |
| P-03 | `engine.rs:139-143`; `qwen35.rs:3537-3539` | Enabled only for `Qwen35`, and only with raw KV. | n/a | n/a | n/a | N/A for other backends |
| P-04 | `qwen35.rs:2241-2296, 3591-3764` | A checkpoint holds GDN parity copies, K/V views, **5** DFlash capture groups, and the logits. | OK | OK | MTP KV rows must be added, or recomputed | KV-only checkpoints would be simpler |
| P-05 | `prefix_cache.rs:61-65, 106-107`; `qwen35.rs:1893-1903`; `engine.rs:698-699` | Caps of 12 entries and 4096 MiB; 48 MiB view slack; checkpoints only for prompts of at least `block` tokens, because "a checkpoint's GDN state is ~151 MB whatever the prompt length". | re-size from the memory plan | as (a) | as (a) | attention-only: cost is per token only |

### 3.11 Tokenizer, template, EOS, generation defaults

| ID | where | baked in | effect on new models |
|---|---|---|---|
| K-01 | `model.rs:713-716, 564-568` | `tokenizer.json` is required (GGUF needs `--tokenizer`). | OK |
| K-02 | `model.rs:650-656, 584, 697, 464-469, 418-428` | The template comes from `tokenizer_config.json`'s `chat_template`, then from `chat_template.jinja` (qwen3_5 path only). GGUF and dense read only `tokenizer_config.json`. Loads by HF id never download `chat_template.jinja`. | The benchmark target keeps its template **only** in `chat_template.jinja` (checked in the HF snapshot). A cold start by HF id falls back to the ChatML fallback template without any warning. |
| K-03 | `template.rs:78-83`; `engine.rs:831, 2160`; `main.rs:178` | Render context: `messages`, `add_generation_prompt: true`, `bos_token` = `"<s>"` only if that token exists, `eos_token` `""`. | Llama 3 and Gemma templates expect their own BOS (`<\|begin_of_text\|>`, `<bos>`). There is no `enable_thinking` (the Qwen3.8 template thinks unless `enable_thinking` is false) and no `tools`. |
| K-04 | `engine.rs:833-838` | The prompt is encoded with `add_special_tokens = false`. | BOS must come from the template (see K-03). |
| K-05 | `template.rs:269-281` | The fallback template is ChatML. | Wrong for non-ChatML families. |
| K-06 | `api.rs:55-67` | Only text content parts are kept. | Multimodal inputs are dropped. |
| K-07 | `engine.rs:1893-1990`; `reports/impl-th-wp1-utf8-stream.md:100` | UTF-8 streaming is decoder-generic (byte-level BPE and SentencePiece are both tested). | OK |
| K-08 | `template.rs:342-358`; `engine.rs:2604-2622, 2724` | Tests read a local Qwen3.8 template path, the HF-cache Qwen3.8 tokenizer, and token id 248046. | The tests depend on the local environment. |

### 3.12 Server contract

| ID | where | baked in |
|---|---|---|
| V-01 | `server.rs:81-112` | `/status` reports:<br>• `model` = load metadata (`format`, `model_type`, `context_length`, `files`, `decode_slots`);<br>• `maximum_context_tokens` = `max_position_embeddings` (262144 for Qwen3.8), not a limit derived from memory;<br>• `features` = {`spec_decode`, `kv_quant`, `dflash`, `batch_slots`}.<br>There is no architecture descriptor, no reason when a capability is off, and no memory plan. |
| V-02 | `api.rs:8-25, 88-97` | The request types carry no template kwargs, tools, reasoning controls or images. |
| V-03 | `state.rs:85-137` | The model, the draft and `kv_quant` can only be set at load time. |

### 3.13 Harnesses and probes

| class | harnesses | coupling |
|---|---|---|
| backend-generic (go through `ModelBackend`) | `TH_BENCH_MULTI`, `TH_BENCH_PREFILL`, `TH_BENCH_STEPS`, `TH_BENCH_TTFT`, `TH_GPU_PROF`, `TH_DEBUG_TIMING` (`main.rs:451-610, 774-776`) | OK for any backend with `forward_multi` |
| downcast to `Qwen35` | `TH_TEST_ROLLBACK` (R0a and prefix restore, `main.rs:245-423`), `TH_BENCH_LIN` (`427-438`), `TH_BENCH_Q4[_SWEEP]` (`440-444`), `TH_BENCH_DRAFT_MLP` (`446-450`), `TH_BENCH_PLAN` (`611-773`, needs prefix capture) | Projection classes are discovered by layer kind (generic), but the DFlash draft classes are literal shapes (`qwen35.rs:995-1009, 2716-2722`). |
| Qwen3.8 geometry as literals | `TH_BENCH_ATTN seq:kv` (24/4/256, `main.rs:777-872`, at `790`), `attn_bench.rs:36-40` (NH 24, NKV 4, HD 256, RP 32), attention tests (`attn_kernel.rs:1939-2010`) | Should read geometry from the loaded model. |
| model-free tests | tiny GDN and hybrid models (`qwen35.rs:5746-5941, 5950-6139`) | They use DK = DV = 128 and head_dim 256 ("the fused kernel's head width", `qwen35.rs:5766-5770`), so they cannot detect geometry couplings. |

### 3.14 Swift side (`clients/macos/Sources/TokenHorizon/Engine/`)

| ID | where | baked in |
|---|---|---|
| X-01 | `THEngineCatalog.swift:24-42, 68-78` | The curated catalog has three GGUF Qwen3 entries (32B and 8B Q4_K_M, 0.6B Q8_0). The `qwen3_5` MLX fast path is not in it. The payload carries no architecture, format, draft/MTP or memory metadata. |
| X-02 | `HardwareProfile.swift:56-135`; `EngineSupervisor.swift:442-471` | Eligibility (M3 or newer, macOS 26.4+, 36 GB) and fit come from Splash. The fit catalog is Splash's two packages: Qwen3.8 27B dense (resident 16.2 GB) and Qwen3.6 35B-A3B MoE (18.5 GB). th-engine models get no fit at all. |
| X-03 | `EngineSupervisor.swift:45-58` | th-engine args: `--tokenizer` and `--max-context` = K × 1024. The latter is a request ceiling, not a memory plan. |
| X-04 | `EngineSupervisor.swift:49-84` | DFlash auto-attach fires when the model id contains "qwen3.8" and "27", and takes the first draft directory it finds. With a second Splash package installed it can pick a mismatched draft, and engine load then fails (LOUD). |
| X-05 | `EngineSupervisor.swift:98-104` | A developer's absolute build path is in the binary search list. |

## 4. Scenario walk-throughs

### 4a. Qwen4-class dense hybrid with different dims

**Assumptions.** A GDN + full-attention hybrid whose dims differ from Qwen3.8 (hidden size, layer count, head counts, possibly head dims, a new layer schedule), with an MTP head and no Splash draft.

MTPLX describes the Qwen4 preview it serves as "a hybrid GatedDeltaNet mixture of experts with Qwen Sparse Attention and a 51B-parameter n-gram table" (`docs/MTPLX/README.md:72`). The dense variant here is the optimistic case. The MoE, sparse-attention and n-gram-table parts belong to (b) and to new mixer kinds (A-09).

**What happens today, in order:**

1. **Routing.** `model_type` must start with `qwen3_5` (`model.rs:639`). Otherwise the load stops at the `bail!` in `model.rs:691` (LOUD, with a clear message).
2. **Config.** Missing fields get Qwen3.8 values (C-01…C-05). `layer_types` is ignored, so a schedule other than 3:1 shows up as a missing-tensor error (LOUD). YaRN or other scaled RoPE is dropped (SILENT past the base context).
3. **Load.**
   - Hv > 64: PANIC (G-04).
   - A weight prefix other than `language_model`: LOUD (W-01).
   - Mixed-bit quant: LOUD or SILENT (Q-01).
4. **First prefill.** The prefill paths are the most generic. `gated_delta_step` is DK-generic and the prefill conv is K-generic. The fused causal attention checks `d == 256` and otherwise falls back to eager (SLOW). A hidden size of 8192 or more uses the legacy add + norm kernel (SLOW, N-02).
5. **First decode.**
   - DK ≠ DV, or conv ≠ 4 taps: LOUD (G-02 and G-03 guards).
   - DK = DV ≠ 128: **SILENT** (G-02).
   - Attention head_dim ≠ 256: **SILENT** (A-01).
   - GQA > 8: SILENT once 256 keys are visible (A-03).
6. **Speculation.**
   - With no Splash draft, only n-gram speculation runs, and batching is off.
   - With a DFlash draft trained for the new target, every D-01 constant differs, so draft load fails (LOUD).
   - More than 56 GDN layers: the one-dispatch commit bails at the first partial accept (LOUD, G-06).
7. **Performance.** The tile tables miss the new shapes, which fall back to n64s4 (SLOW, by up to the K2 deltas; T-01). On a Mac without a 40-core GPU the prefill policy still assumes 40 cores (T-08).

**Minimal path:**

1. R1 descriptor: schedule from `layer_types`, gate flags, RoPE type, the quant block.
2. R2 guards: every SILENT above becomes a LOUD with a reason.
3. R3 kernel templates for the specific new dims (GDN DK, attention D, GQA).
4. R12 parity against the eager oracle on a prompt set.
5. R6 retune.
6. R7 and R9: the MTP drafter.

### 4b. MoE (Qwen3.6-35B-A3B-class; Qwen4 Flash-Next-class)

1. **Load fails on the FFN.** `qwen3_5_moe` passes the routing test and then fails in `Qwen35::load` on `…mlp.gate_proj` (LOUD, W-02). The mixers themselves would fit today's kernels for Qwen3.6-35B-A3B: Splash's layout keeps GDN head dim 128, attention head dim 256, GQA 16/2 = 8, 32 RoPE pairs, θ 1e7 and period 4 (`docs/splash/runtime/model/Qwen3_6Moe.hpp:24-40`). So the gap is the FFN, not the attention/GDN stack.
2. **What is needed:**
   - a MoE FFN: router top-k with `norm_topk_prob`, stacked experts, and a shared expert with its sigmoid gate;
   - a gather-Q4 kernel family for m ≤ 8, for decode and verify (up to `rows × k` distinct experts per call);
   - a grouped, token-sorted prefill GEMM;
   - MoE entries in the tile policy;
   - a new K45 design, because the presum chain stops at the router.
3. **The economics of speculation change.** S-02's premise (extra verify rows are almost free) no longer holds, so L1 "verify all 7" and the adaptive policy must be re-measured. MTPLX ships dedicated MoE MTP batching code (`docs/MTPLX/mtplx/a3b_mtp_batch.py`), a hint that this path needs its own tuning.
4. **DFlash.** The MoE target's draft differs in every constant (8 capture layers, hidden 2048, mask token 248077, a schema-4 manifest), so R8 is a prerequisite.
5. **Scale.** Flash-Next-class packs need about 74-83 GB resident (`docs/MTPLX/README.md:74-75`) plus an n-gram table streamed from SSD (`README.md:78`). th's loader peaks near twice the weight bytes [D] (W-05), so R13 comes first.

### 4c. Native MTP heads, no external draft

**Today.** The config declares `mtp_num_hidden_layers` 1, the MLX export drops the `mtp.*` tensors (0 in the benchmark target), and th ignores both. The result is n-gram speculation and no batching.

**What an MTPLX-style MTP drafter needs in th.** The reference contract is `docs/MTPLX/mtplx/mtp_patch.py:795-812, 978-1040` and `qwen3_5_mtp_patch.py:1-40`.

- **Weights.**
  - `mtp.pre_fc_norm_embedding` and `mtp.pre_fc_norm_hidden`.
  - `mtp.fc`: 2H → H over `[embedding ; hidden]`; the concat order is configurable.
  - `mtp.layers.{0..n}`: a full-attention decoder layer of the trunk's own class (gated attention, q/k norm, partial RoPE, dense or MoE FFN).
  - `mtp.norm`, plus the shared lm_head and embeddings.
  - These often live in a separate `model-mtp-head.safetensors`.
  - Config keys: `mtp_num_hidden_layers` or `num_nextn_predict_layers` (`mtp_patch.py:252-254`).
- **Target tap.** The trunk's final hidden state (pre-norm or post-norm variant, `mtp_patch.py:842-860`) at every committed position. This replaces `CAPTURE_LAYERS` (D-04) with a "final hidden" tap.
- **Drafter state.** A per-slot KV cache for the MTP layer(s). Snapshot and rollback are length truncation (like `QuantKv::truncate`). The cache must be included in prefix checkpoints (P-04).
- **Propose.** k autoregressive m = 1 steps (k ≤ 7 because of S-06). The K7 qmvt kernels and the fused attention decode already serve m = 1. `mtp.fc` has `in = 2H`, so `in % 64` holds.
- **Accept.** A `Proposal` with at most 7 tokens and, per position, the drafter's top-16-truncated distribution. With that, `sample_kernel` works unchanged (S-04).
- **Engine.** One speculative loop and one batch round that work with any drafter (R7), replacing the `has_draft()` DFlash branches (S-01, S-03).

### 4d. Non-Qwen family (Gemma, Llama)

**Today.**

- Llama or Gemma safetensors: `unsupported safetensors model_type` (LOUD, `model.rs:691`).
- GGUF `llama`: candle's quantized Llama on Metal, plain decode only.
- GGUF Gemma: `unsupported gguf architecture` (`model.rs:561`).

**Fast-path requirements.** An attention-only backend built from the existing pieces (QLin kernels, attention decode/prefill, KV cache, prefix cache with KV-only checkpoints, rollback by KV truncation), plus:

- head_dim 128 decode kernels (A-01);
- attention without the gate, and with q/k norm optional (A-05, A-06);
- RoPE variants, including Llama-3 scaling (C-04, A-07);
- an attention-scale override and logit soft-capping;
- sliding-window layers with ring caches (A-09, G-12);
- GeGLU and sandwich norms (N-03, N-04);
- the `(1 + w)` norm convention (W-04);
- a tied lm_head on the Q4 kernels (C-08);
- attention bias, for Qwen2-style checkpoints.

**Gemma 4 specifics** should be taken from its own `config.json` at onboarding time. MTPLX runs Gemma 4 as an "assistant pair" with a tuned draft block size (`docs/MTPLX/README.md:132`), i.e. as a separate-draft family, not with MTP heads.

**Chat.** Non-ChatML turn marks (P-02), BOS from `tokenizer_config.json` (K-03), and a fallback template other than ChatML (K-05).

## 5. Recommended abstraction boundaries

**Effort sizes [E]:** **S** is at most 1 day, **M** 2-5 days, **L** 1-3 weeks, **XL** more than 3 weeks.

**Invariant for every recommendation:** today's Qwen3.8 path stays bit-identical. The existing gates verify that (`reports/phaseE/PHASEE-REPORT.md:22`):

- the R0a state-bitwise rollback gate;
- prefix cache hit == miss;
- T=0 text identity;
- the GPU-vs-CPU sampling check.

### R1: `ArchDescriptor`, derived and validated at load (M)

One struct, built from `config.json` (and `text_config`), the `quantization` block, `generation_config.json`, `tokenizer_config.json` and, for drafts, the package manifest. It is logged at startup and served in `/status`.

```rust
pub struct ArchDescriptor {
    pub model_type: String,
    pub weight_prefix: String,            // "language_model.model" | "model" (W-01)
    pub hidden: usize, pub vocab: usize, pub max_pos: usize,
    pub layers: Vec<LayerSpec>,           // from layer_types; the interval only as a fallback (C-02)
    pub norm: NormSpec,                   // rms, eps, weight_offset_applied (W-04, N-01)
    pub attn: Option<AttnSpec>,           // heads, kv, head_dim (required: C-01),
                                          // rope: RopeSpec { theta, partial, style: NeoX | GptJ, scaling },
                                          // gate: None | Sigmoid, qk_norm, scale, window, softcap (A-05..A-09)
    pub gdn: Option<GdnSpec>,             // hk, hv, dk, dv, conv_k, gate: Swish, qk_scale (G-07)
    pub ffn: FfnSpec,                     // Dense { inter, act } | Moe { experts, top_k, inter, shared_inter, norm_topk }
    pub quant: QuantScheme,               // plus per-module overrides (Q-01)
    pub tie_embeddings: bool,
    pub mtp: Option<MtpSpec>,             // layers, concat order, hidden variant (C-12)
    pub eos: Vec<u32>, pub bos: Option<String>,
    pub gen_defaults: SamplingDefaults,   // from generation_config.json (C-11)
}
pub enum LayerSpec { Gdn, FullAttn, SlidingAttn { window: usize }, SparseAttn /* future */ }
```

- **Removes:** C-01…C-14, W-01, and the parsing half of Q-01.
- **Rule for defaults:** kernel-critical fields are required or computed, never defaulted to Qwen3.8 values.
- **Rule for unknown semantics:** a field that changes semantics in a way th does not support (`rope_type` other than default, `quantization.mode` other than affine, an unknown layer type) is a load error that names the field.

### R2: kernel geometry contracts and a route plan (M)

- **Contracts.** Each fused kernel family exposes `fn supports(&ArchDescriptor, phase) -> Result<(), Reason>`.
- **Route plan.** `Qwen35::load` (and later every backend) builds a `RoutePlan` once. For each op and phase it records the choice (fused kernel, generic kernel, or eager), logs it, and serves it in `/status`.
- **Guards it adds right away:**
  - GDN DK == 128 (G-02);
  - DV == 128 when presum is on (G-08);
  - attention d == 256 for prepare/decode (A-01);
  - GQA ≤ 8 for the split kernel (A-03);
  - Hv ≤ 64 as an error, not a panic (G-04);
  - at most 56 GDN layers for the batched commit, or a per-layer fallback (G-06);
  - C ≤ 7936 for the per-row add + norm (N-02).
- **Result:** every SILENT in §3 becomes either a route to the eager path or a LOUD error with a named reason.
- **Patterns already in the repo to copy:** the prefill vec-tile layout probe (T-09) and `GeomCache` (A-13).

### R3: generalise the kernel templates for the next dims (L)

- **GDN** fused step, wide variant and commit: template on `PER = DK/32` with register arrays instead of `s0..s3`; conv taps `K` as a define; `TMAX` stays 8; presum sums over `DV/64` groups.
- **Attention** prepare/decode: threads per (head, row) = `D` (or `D/2` with two channels per thread); decode channels per lane = `D/32`; defines `HAS_GATE`, `HAS_QK_NORM`, `ROPE_STYLE`, `SCALE` and `WINDOW` (the prefill kernel already has `PA_GATE`); split kernel GRP up to 16 (512 threads, or 8 lanes per row).
- **Caches:** key every pipeline cache by all the constants it bakes in (G-09; QMV/QMM/DEQ by group size, `quant_kernel.rs:2571-2574`), and move the commit descriptors from `set_bytes` into a buffer (G-06).
- **Payoff:** covers the plausible Qwen4 geometry changes and the attention side of Llama and Gemma.

### R4: backend traits and per-layer composition (L)

Replace the 28-method enum (`model.rs:65-371`) with capability traits, and build models from per-layer parts:

```rust
pub trait TextModel {
    fn forward(&mut self, slot: usize, tokens: &[u32], pos: usize, out: Logits) -> Result<Tensor>;
    fn slots(&mut self) -> &mut dyn SlotManager;                    // nslots, clear, kv_reserve
    fn spec(&mut self) -> Option<&mut dyn SpecState>;               // snapshot / restore / rollback_verify
    fn prefix(&mut self) -> Option<&mut dyn PrefixCheckpointing>;   // hold / build / restore
    fn taps(&mut self) -> Option<&mut dyn HiddenTaps>;              // capture points the drafter declares
    fn describe(&self) -> &ArchDescriptor;
}
enum Mixer { Gdn(GdnLayer), Attn(AttnLayer), SlidingAttn(..) }     // each owns its state and checkpoint impl
enum Ffn { Dense(Mlp), Moe(MoeBlock) }
```

- `Qwen35` becomes "hybrid decoder = [Mixer] × [Ffn]".
- An attention-only Llama, Gemma or Qwen3-dense model is the same decoder with only `Mixer::Attn`.
- candle's GGUF and dense wrappers implement only `forward` and `slots`.
- The parity/rollback machinery (G-10) moves behind `SpecState`, per mixer. A new state type (SSM, ring cache) then brings its own snapshot, rollback and checkpoint code instead of editing `rollback_verify`.

### R5: `QuantScheme` per tensor (L per format)

- **Type.** `QLin` carries a scheme: `Affine { bits, group }`, `Mxfp4 { group: 32 }`, `Nvfp4 { group: 16 }`, `Ternary { group }` or `Gguf(ty)`, resolved per module from `quantization` and its overrides.
- **Routing.** Kernel families are chosen per scheme through R2's route plan. Tiling, tile policies and benches are shared infrastructure. Presum (Q-05) is enabled only for schemes with a per-group bias.
- **Order:**
  1. MLX affine 8-bit and mixed, which loads MTPLX-style "dynamic" packs;
  2. the FP4 formats;
  3. ternary.

### R6: tile policy derived at load, with a persisted autotune (M)

1. Fix T-08 first: the prefill policy should use `gpu_cores()`.
2. Keep the shape *rules* (T-02, T-03, T-05, T-07) as defaults, and turn `DECODE_TILE_TABLE` (T-01) into a seed.
3. Add `th-engine tune --model <dir>`. It runs the existing `TH_BENCH_Q4_SWEEP` and `TH_BENCH_LIN=pf` machinery over the model's own projection classes (from the descriptor) and over the drafter's shapes (from its descriptor, replacing the literals at `qwen35.rs:995-1009, 2716-2722`). It writes `tiles-<gpu-family>-<cores>-<shape-hash>.json`, which is loaded at startup.
4. Accept numerics-changing picks (split-K ↔ sequential-K) only after the identity and acceptance gates pass (§3.7).

### R7: `Drafter` trait (L)

```rust
pub trait Drafter {
    fn taps(&self) -> TapSpec;                                   // layers, or FinalHidden { pre_norm }
    fn warm(&mut self, slot: usize, taps: &Tensor, start: usize) -> Result<()>;
    fn propose(&mut self, slot: usize, anchor: u32, pos: usize,
               s: Option<DraftSampling>, rng: &mut dyn FnMut() -> f64) -> Result<Proposal>;
    fn commit(&mut self, slot: usize, taps: &Tensor, start: usize, rows: usize) -> Result<()>;
    fn rollback(&mut self, slot: usize, keep: usize) -> Result<()>;
    fn checkpoint(&self, slot: usize, pos: usize) -> Option<DrafterCheckpoint>;
}
pub struct Proposal { pub tokens: ArrayVec<u32, 7>, pub q: ArrayVec<ArrayVec<(u32, f32), 16>, 7> }
```

- Implementations: `NGram`, `DFlash(DFlashDescriptor)`, `Mtp(MtpSpec)`.
- The engine keeps one speculative loop and one batch round, parameterised by the drafter.
- `CAPTURE_LAYERS` (D-04) and the 5-group checkpoint layout (P-04) come from `TapSpec`.
- `sample_kernel` keeps its arithmetic, with `ROWS`, `PROP` and `DTOPK` as upper bounds.

### R8: DFlash descriptor from the Splash manifest (S-M)

- **Parse** `manifest.json` (schema 3 and 4): `execution_geometry`, `format`, `upstream.target`, the v4 `draft` block (layers, hidden, intermediate, sliding window, block size, dynamic-conv sizes, selector rank and top-k, `target_capture_layers`), and the mask token.
- **Validate** against the target and fail with a named mismatch: vocab must equal the codebook rows and be a multiple of 512; hidden must match; capture layers must be below the layer count; the upstream target id must match.
- **Constants:** D-01's constants become descriptor fields, passed to `draft_kernel`'s MSL as defines.
- **Swift (X-04)** matches drafts by the manifest's upstream target instead of by substrings.

### R9: MTP head drafter (L-XL)

See §4c. Build order:

1. a loader for `mtp.*`, from the main shards or a sidecar file;
2. the MTP block, on the existing attention and QLin kernels;
3. a per-slot MTP KV cache with truncation rollback;
4. the final-hidden tap;
5. depth-k propose;
6. acceptance through `sample_kernel`;
7. a prefix-checkpoint part;
8. the batch round.

**Gate:** greedy text identical to plain decode at T=0, plus a sampled-distribution check like MTPLX's thousand-sample comparison (`docs/MTPLX/README.md:34`).

### R10: chat, template and generation adapter (S-M)

- **Turn marks discovered from the template,** replacing `chat_marks` (P-02): render two short conversations, diff the token streams, and record the turn-end and assistant-start sequences (ChatML, Llama 3 headers, Gemma turns).
- **BOS and EOS** from `tokenizer_config.json`'s special tokens and from `generation_config.json` (K-03, C-13). **Sampling defaults** from `generation_config.json` (C-11).
- **Template kwargs** passed through (`enable_thinking`, `tools`) (K-03, V-02). **Download `chat_template.jinja`** on loads by HF id (K-02).

### R11: server and Swift contract (M)

- **`/status` additions:**
  - `arch` (R1);
  - `routes` (R2);
  - `capabilities`, with a reason when one is off ("dflash: no draft");
  - `memory_plan`: weights, KV bytes per token, recurrent state per slot, checkpoint bytes.
- **`th-engine inspect <model>`** classifies a checkpoint before load (compare MTPLX's verified / family-compatible / AR-only / incompatible classes, `docs/MTPLX/README.md:263-265`). It feeds `THEngineCatalog` (X-01) and a th-engine fit computed from `memory_plan` (X-02).
- **Cleanup:** remove the absolute developer path (X-05).

### R12: geometry-sweep tests and eager oracles (M)

- **Parameterise the tiny models** (`qwen35.rs:5769-5835, 5970-6068`) over DK ∈ {64, 128, 256}, Hk:Hv ∈ {1:1, 1:3, 16:48}, conv K ∈ {3, 4}, head_dim ∈ {128, 256}, GQA ∈ {1, 6, 8, 16}, and dense vs MoE FFN.
- **Compare each fused path against the eager oracle** that already exists in the binary (`TH_GDN_EAGER`, `TH_NO_ATTN_FUSED`, `TH_QMM_SCALAR`, `TH_PREFILL_ATTN=eager`). R0a validates the state machine; the oracle validates the math (G-13).
- **Harnesses** read geometry from the loaded model (§3.13). The 27B-shape policy tests (T-11) become descriptor-driven tables.
- **First gate for any new model:** logits parity on a fixed prompt set against the reference implementation (mlx-lm), before any performance work.

### R13: streaming loader (M)

mmap each shard, create device tensors directly from the mapped bytes, repack and tile one tensor at a time, and drop host copies immediately (W-05). This is needed before any model larger than about 60 GB.

### R14: hardware capability probe at load (S-M)

- Probe Metal 4 / MPP support once. That means promoting `mpp_probe` (`quant_kernel.rs:2578-2644`) from a diagnostic to a gate.
- Record the GPU family and core count, and use one core count everywhere (T-08).
- When MPP is missing, route the Q4 path to the non-MPP kernels (the `TH_QMM_MPP=0` equivalents).
- Log which policies were measured on this GPU class.

### Dependency order

1. R1, then R2.
2. Then R10, R14, R6, R8 and R12, in any order.
3. Then R4.
4. Then R3, R5 and R7, in any order.
5. Then R9, then R11.
6. R13 can go anywhere, but must land before the first large model.

## 6. Using this audit in a new-model optimisation job

| step | coupling IDs to clear | gate that proves it (existing harness) |
|---|---|---|
| 1. Inspect the checkpoint | C-*, W-01/02, Q-01 | The R1 descriptor prints, and every unknown semantic field is an error. |
| 2. Correctness on eager paths | A-05…A-09, G-07, N-03/04, K-* | Logits parity vs mlx-lm; runs with `TH_GDN_EAGER=1 TH_NO_ATTN_FUSED=1 TH_QMM_SCALAR=1`. |
| 3. Kernel coverage | G-02/03/04/06/08, A-01/03, N-02 | The R2 route plan shows no eager fallback on hot ops; the fused path matches the eager oracle (R12). |
| 4. State machine | G-10/11/12 | `TH_TEST_ROLLBACK=1`: the R0a state-bitwise gate and the prefix-restore probe (`main.rs:245-423`), plus its `TH_GDN_COMMIT=step` discrimination arm (`reports/PHASEC-REPORT.md:21`). |
| 5. Baseline performance | T-* | The bench-quiet protocol (`reports/bench-quiet.md:58-80`): one `gpu-lock` hold, a fresh server per arm, palindrome/ABBA arm order, gates on thermal 0 + CPU idle + a quiet GPU, ratio of sums, explicit sampling params. `TH_GPU_PROF=1` for per-command-buffer timing. |
| 6. Tile retune | T-01…T-08 | `TH_BENCH_Q4[_SWEEP]`, `TH_BENCH_LIN=pf`, and interleaved `TH_BENCH_PREFILL` A/B. Numerics-changing picks go through step 4 and T=0 text identity first. |
| 7. Speculation | D-*, S-* | T=0 text identical to plain decode; `TH_SAMPLE=check` GPU-vs-CPU acceptance with 0 mismatches (`reports/phaseE/PHASEE-REPORT.md:22`); acceptance studies over many streams, R0b-style (`reports/phaseD/PHASED-REPORT.md:34`). |
| 8. TTFT / prefix cache | P-*, K-02/03 | Prefix hit == miss, on texts and per-round logs (`reports/phaseE/PHASEE-REPORT.md:22`); `TH_BENCH_PLAN`, `TH_BENCH_TTFT`. |
| 9. Ship | X-*, V-* | `/status` shows arch, routes and capabilities; the Swift catalog has an entry with a fit computed from the memory plan. |

## Appendix A: hard-coded constant index

| constant | value | where | kind | origin |
|---|---|---|---|---|
| `head_dim` default | 256 | `qwen35.rs:65` | hard default | Qwen3.8 |
| `full_attention_interval` default | 4 | `qwen35.rs:66` | hard default | Qwen3.8 |
| GDN head dims default | 128 / 128 | `qwen35.rs:67-68` | hard default | Qwen3.8 |
| conv kernel default | 4 | `qwen35.rs:69` | hard default | Qwen3.8 |
| RoPE θ / partial factor defaults | 1e7 / 0.25 | `qwen35.rs:78-79` | hard default | Qwen3.8 |
| `max_position_embeddings` fallback | 262144 | `qwen35.rs:92` | hard default | Qwen3.8 |
| quant bits / group | 4 / 64 | `qwen35.rs:169` | hard | MLX default |
| weight prefix | `language_model` | `qwen35.rs:3009` | hard | MLX multimodal export |
| GDN gate-constant table size | 64 | `qwen35.rs:3060-3061`; `gdn_kernel.rs:55-56` | hard | kernel params passed by value |
| GDN DK in the fused kernels | 128 | `gdn_kernel.rs:373-426, 1411-1450` | hard (implicit) | Splash kernel shape |
| GDN conv taps in the fused kernels | 4 | `gdn_kernel.rs:334-362` | hard | Qwen3.8 |
| GDN `TMAX` | 8 | `gdn_kernel.rs:289, 1315` | hard | verify block |
| max layers per batched commit | 56 | `gdn_kernel.rs:1304` | derived: 4 KiB / 72 B | `set_bytes` limit |
| GDN q/k norm eps | 1e-6 | `gdn_kernel.rs:221, 383-384`; `qwen35.rs:4202-4204` | hard | reference |
| per-row add+norm max C | 7936 | `gdn_kernel.rs:2139` | hard | 32 KiB staging |
| attention head dim in prepare/decode | 256 | `attn_kernel.rs:134-266` | hard (implicit) | Qwen3.8 |
| fused prefill attention limits | d == 256, GRP ≤ 16 | `attn_kernel.rs:1613-1615` | guarded | kernel design |
| split attention | page 32, q rows 8, at most 128 splits; GRP ≤ 8 (implicit) | `attn_kernel.rs:41-45, 654-658` | hard | Splash tile |
| split policy | min 256 keys, base 16, 8 pages per split, cap 32, f32 p | `attn_kernel.rs:90-94` | hard | M5 Max sweep |
| GPU core count default | 40 | `quant_kernel.rs:72, 5112` | hard default | M5 Max |
| decode tile table | 2 shapes | `quant_kernel.rs:218-219` | hard | K2 / K45 sweeps |
| Paired256 constants | 8 tiles/core, 4 groups/core | `quant_kernel.rs:197-200` | hard | Splash |
| pad-skip max K | 8192 | `quant_kernel.rs:252` | hard | measured |
| qmvt wide-row threshold | 8192 | `quant_kernel.rs:436` | hard | measured |
| presum group | 64 | `quant_kernel.rs:272-274` | hard | Q4 group size |
| prefill tile shapes | 8 | `quant_kernel.rs:4525-4534` | hard | sweep |
| `ChunkTop16` | 512-column chunks, top-16 | `quant_kernel.rs:496-570` | hard | DFlash |
| draft ring head dim | 128 | `quant_kernel.rs:678-680` | hard | DFlash |
| draft conv presum | C 5120, dyn 1280 | `quant_kernel.rs:844-862, 962` | hard | DFlash |
| DFlash constants | see D-01 | `dflash.rs:30-52` | hard | DFlash2 checkpoint |
| sample kernel | KMAX 32, NU 8, NT 1024, POOL 1024, ROWS 8, PROP 7, DTOPK 16 | `sample_kernel.rs:47-64` | hard | DFlash round; Splash's top-k cap |
| n-gram N / `spec_k` | 3 / ≤ 7 | `engine.rs:1997, 899` | hard | n/a |
| KV reserve extra max | 2048 | `engine.rs:542` | hard | n/a |
| KV capacity | 256-row blocks, 2048 floor | `qwen35.rs:3843, 4825, 4863` | hard | split-kernel pages |
| prefill sync threshold | 2048 | `qwen35.rs:1676-1683` | hard | candle buffer-pool behaviour |
| prefill step default | 512 | `state.rs:59-61` | hard | n/a |
| sampling defaults | 0.7 / 0.8 / 20 | `state.rs:69-71` | hard | Qwen non-thinking |
| prefix cache defaults | 12 entries, 4096 MiB, block 128, margin 16, merge 1024 | `prefix_cache.rs:41-42, 106-110` | hard defaults | n/a |
| checkpoint view slack | max(exact / 3, 48 MiB) | `qwen35.rs:1901-1903` | hard | n/a |
| `TH_BATCH` clamp | 1..=8 | `qwen35.rs:3141-3145` | hard | n/a |
| ChatML marks | 4 token strings | `engine.rs:490-495` | hard | Qwen template |
| BOS probe | `"<s>"` | `engine.rs:831, 2160` | hard | Llama-2 convention |

## Appendix B: Qwen3.8 config fields, read vs ignored

Fields are in `text_config` unless marked (top).

| field | value (benchmark target) | read by th? | consequence |
|---|---|---|---|
| `model_type` (top) | `qwen3_5` | yes (routing) | `model.rs:629-639` |
| `hidden_size`, `num_hidden_layers`, `intermediate_size` | 5120, 64, 17408 | yes | n/a |
| `num_attention_heads` / `num_key_value_heads` | 24 / 4 | yes | GQA 6 (A-03 limit is 8) |
| `head_dim` | 256 | yes (defaults to 256) | C-01 |
| `vocab_size` | 248320 | yes | `qwen35.rs:5131`; must equal DFlash `CB_ROWS` (D-03) |
| `rms_norm_eps` | 1e-6 | yes, except at the literal-1e-6 sites | N-01 |
| `full_attention_interval` | 4 | yes | C-02 |
| `layer_types` | 64 entries | **no** | C-02 |
| `linear_num_key_heads` / `linear_num_value_heads` | 16 / 48 | yes | G-04 limit is 64 |
| `linear_key_head_dim` / `linear_value_head_dim` | 128 / 128 | yes (the kernels need 128) | G-02 |
| `linear_conv_kernel_dim` | 4 | yes (the kernels need 4) | G-03 |
| `rope_parameters.rope_theta` / `.partial_rotary_factor` | 1e7 / 0.25 | yes | C-04 |
| `rope_parameters.rope_type`, `mrope_section`, `mrope_interleaved` | `default`, [11, 11, 10], true | **no** | C-04 (text-only positions [D]) |
| `partial_rotary_factor` (at `text_config` level) | 0.25 | **no** (only the `rope_parameters` copy is read) | C-04 |
| `max_position_embeddings` | 262144 | yes | C-05 |
| `tie_word_embeddings` | false | yes | C-08 |
| `attn_output_gate` | true | **no** (assumed) | C-09, A-05 |
| `output_gate_type` | `swish` | **no** (assumed) | C-09, G-07 |
| `hidden_act` | `silu` | **no** (assumed) | N-03 |
| `attention_bias` | false | **no** (assumed false) | A-09 |
| `mtp_num_hidden_layers` / `mtp_use_dedicated_embeddings` | 1 / false | **no** | C-12, §4c |
| `mamba_ssm_dtype` | `float32` | no (the state is f32 anyway) | G-14 |
| `eos_token_id` (top) | [248046, 248044] | yes | C-13 |
| `quantization` (top): bits, group_size, mode | 4, 64, `affine` | **no** | Q-01 |
| `generation_config` (top, and the file) | temperature 1.0, top_k 20, top_p 0.95 | **no** | C-11 |
| `vision_config`, image/video token ids (top) | present | no (text only) | K-06 |
