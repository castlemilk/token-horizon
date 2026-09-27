# Critique: MODEL-OPTIMISATION-PLAYBOOK.md and GENERALISATION-PLAN.md

> Adversarial review of `engine/docs/MODEL-OPTIMISATION-PLAYBOOK.md` and `engine/docs/GENERALISATION-PLAN.md` against the code at `main` @`b31ca91` (`engine/src/`, the Swift `Engine/` sources, the Go daemon's `internal/engine/`, the gateway) and the primary reports in `engine/reports/perf-2026-09/`. Written 2026-09-28. Every finding below names the line it checked; figures are quoted from the report that carries them (`FILE:line`). Nothing here is a new measurement.

## 0. Verdict

**Structurally sound and unusually well anchored, but not yet safe to hand to a Qwen4 / MoE / MTP job as written.** Of ≈120 `file:line` anchors checked, all but two trivial off-by-ones resolve to the code they describe; of ≈150 quoted figures, all trace to a report (or to a vendored reference-engine source) once hyphen/en-dash differences are ignored; every `TH_*` environment name in both documents exists in `engine/src` at `b31ca91`, except the two the documents themselves flag as branch-only (`TH_BENCH_ROUND` @`5090f18`, `TH_CHECK_POS` @`28acf03`, both real commits). The protocol content the phases fought for (thermal and load gates, ratio of sums, timer-before-sync artefacts, the untracked-`Arc` class, withdrawn load-inflated claims) is present and cited correctly.

What must change before these documents are committed:

1. **One factual contradiction that would ship a SILENT kernel.** The plan's Qwen4 work package says Flash-Next's attention "fits … the split decode"; the split-key kernel is pinned to GQA ≤ 8 by its 256-thread dispatch, the guard does not check the group, and the plan's own §3.1 says so (A-03). A Qwen4-class model with 24 q heads and 2 KV heads runs the decode attention wrong with no error.
2. **The compile gate is weaker than described.** `TH_MPP_PROBE` compiles the Q4 MPP library, not "every MPP pipeline"; the geometry-templated GDN/attention/split/prefill pipelines compile on first forward with the model's dims, so a new geometry's compile failure surfaces at Stage 1.4, not 1.3.
3. **The headline "0.56× → 1.20×" mixes metrics and a loaded number.** 0.56 is 1/1.77, Phase B's *ms/round* ratio from a load1 26–49 session; 1.20 is a quiet *loop tok/s* standing. The loop tok/s figure in the same B table is 0.52×.
4. **The app/daemon half of the plan is mis-prioritised.** Neither the Swift ENGINE tab nor the Go daemon can serve a `qwen3_5` safetensors pack today (three GGUF Qwen3 catalog entries, no free-text model), so the entire optimised path is unreachable from the product; the plan puts the fix last (G8, "low"). The Go daemon is also a second `/status` consumer the plan never names.
5. **Splash-specific metric definitions** (`decode_output_tokens / decode_wall_ms`, `decode_batches`) have no adapter for the competitors a Qwen4 job would actually face (MTPLX, mlx-lm, llama.cpp).

Everything else is LOW: derived figures tagged as quoted, a few anchors to tighten, harness pieces missing from the inventory, and guard rails for invariant 21 that should be written down even though nothing proposed violates them.

---

## 1. Issues

Severity: **HIGH** = would produce a wrong result or a wrong decision in the next job; **MEDIUM** = a gate, number or contract that is weaker or different from what the document says; **LOW** = precision, tagging, inventory.

### 1.1 HIGH

#### H1. Plan §12(a) says Flash-Next's attention fits the split decode; it does not (GQA > 8 is SILENT)

- **Claim.** GENERALISATION-PLAN.md §12(a): "Its attention (24 q heads, 2 KV heads, head_dim 256) fits the fused prefill's limits (group 12 ≤ 16) and the split decode [LAND §4.1]."
- **Code.** `attn_split_mpp` is dispatched with a fixed 256-thread threadgroup (`engine/src/attn_kernel.rs:1079-1081`: `MTLSize { width: nkv, height: splits }` × `MTLSize { width: 256 }`). Inside, `M = TH_QROWS * TH_GRP` (`:719`; `TH_QROWS` = `SPLIT_QROWS` = 8, `:43`) and the page softmax covers only `LPR * M` threads with `LPR = TH_PAGE / 8 = 4` (`:655-658`: `if (tid >= LPR * M) return;`). So 256 threads cover 64 fused rows = 8 q-rows × **GRP ≤ 8**. At GRP = 12 the rows 64..95 are never soft-maxed and the running accumulator for those (row, head) pairs is garbage. The geometry guard at `:909` checks `nh % nkv`, `d % SPLIT_PAGE` (= 32, `:41`) and `d ≤ 1024` — not the group. `prefill_supported` (`:1613-1615`) does bound the group (≤ 16) — that is where the "group 12 ≤ 16" in the claim comes from, and it applies to prefill only.
- **Internal contradiction.** The plan's own §3.1 row A-03 says "split verify attention covers GQA ≤ 8 … SILENT (inferred)", and the playbook §1.2 repeats it. §12(a) contradicts both.
- **What is right nearby.** `attn_decode` (single-pass) *is* GQA-generic: its dispatch is `32 * (nh / nkv)` threads (`attn_kernel.rs:589-593`), so the plan's A-01 (head_dim 256 only) is correct for that kernel. The comment at `:218` ("192 threads") is stale — 192 = 6 simdgroups = Qwen3.8's group — and is what makes A-01 look GQA-coupled to a reader.
- **Fix.** (a) Correct §12(a): Flash-Next's decode attention falls back to `attn_decode` (single pass) until the split kernel is templated for GRP > 8, which makes N3's long-context win (D §0: growth to 7.9k +2.9 ms vs +61.1 on main) unavailable to that model. (b) In G1 add `nh / nkv <= 8` (more precisely `4 * 8 * (nh/nkv) <= 256`) to the guard at `attn_kernel.rs:909` so the route is LOUD or falls to single pass with a logged reason. (c) In G6 make the threadgroup size `4 * M` (≤ 1024) a render-time constant of `render_split` (`:856-862`). (d) Upgrade the playbook §1.2 row from "(inferred)" to verified with the thread arithmetic above, and add GQA ∈ {12, 16} to the R12 sweep values in plan §10.1 G2 (it lists {1, 6, 8, 16}, which skips the Flash-Next value). (e) Fix the `:218` comment.

#### H2. The product cannot reach the optimised path; the plan schedules the fix last

- **Claim.** GENERALISATION-PLAN.md §4.2 B6 and §10.1 G8 ("server and app contract … M … low: the `/status` contract only gains keys"); the roadmap places G8 after G4–G7. The playbook has no stage that checks the served model is reachable from the app.
- **Code.** `clients/macos/Sources/TokenHorizon/UI/EngineTab.swift:303` calls `sup.serve(model: m.modelSpec, tokenizer: m.tokenizerRepo, …)` over `THEngineCatalog.catalog` only — three GGUF Qwen3 entries (`Engine/THEngineCatalog.swift:25-42`); `:244` sends `HardwareProfile.catalog` ids (Splash's roster, `Engine/HardwareProfile.swift:87-95`) to Splash. The only `TextField`s are max-mem / max-ctx (`EngineTab.swift:205-210`); there is no free-text model or local-dir entry. The Go daemon mirrors the same three GGUF entries (`daemons/go/internal/engine/catalog.go:40-48`) and has no `--draft` handling at all. Consequently `mlx-community/Qwen3.8-27B-4bit` + DFlash — the subject of every report — cannot be served from the app or the daemon, and the DFlash auto-attach in `EngineSupervisor.swift:52-55` (`contains("qwen3.8") && contains("27")`) is unreachable from the UI.
- **Why HIGH.** The user's stated goal is "fast to support new/different models". A new model that passes every engine gate but cannot be selected in the product is not supported. It is not an engine-correctness defect, so the rest of the plan's ordering (G0–G3 first) is right; but the catalog/fit half of G8 belongs beside G1, not after G7.
- **Fix.** Split G8: (i) *now* — a th-engine catalog entry for the optimised pack (kind `safetensors`, draft dir, resident GB from [E §1.5] / [DP §2]) in **both** `THEngineCatalog.swift` and `daemons/go/internal/engine/catalog.go`, plus a local-directory model entry in the ENGINE tab; (ii) *after G1* — entries and fit derived from `th-engine inspect`. Add to the playbook a Stage 1 smoke "served from the app: ENGINE tab → serve → `/engine` shows the model" so the product path is part of "correct".

### 1.2 MEDIUM

#### M1. "0.56× → 1.20×" is a derived ms/round ratio from a loaded session, compared with a quiet loop tok/s standing

- **Claim.** Playbook header and §0 ("took th-engine from 0.56× to 1.20× Splash 1.0 T=0 decode … [B §1.1; E §0]"), repeated in `engine/reports/perf-2026-09/README.md` and the plan §1.
- **Report.** `PHASEB-REPORT.md:79-83` gives, for the same session: Splash / th **loop tok/s 1.93×** at T=0 (33.0 vs 63.8 → **0.52×**) and **ms/round 1.77×** (104.5 vs 58.9 → 0.565×). No report prints "0.56×" (the only `0.56` hits are `70.56` ms values in C and D). `PHASEE-REPORT.md:23` defines the 1.203× standing as loop tok/s = per-round 1.199 × tokens/round 1.004 from the quiet S2 replicate. The B session ran at load1 26–49 (`PHASEB-REPORT.md:95`); by the playbook's own rule 7 (§0.3) "a number from a loaded or throttled machine is never a standing".
- **Problem.** Start and end use different metrics (ms/round vs loop tok/s), the start is untagged [D], and it violates the document's own rule. The honest trajectory is 0.52× loaded [B §1.1] → 0.840× first quiet standing [BQ §0] → 1.031× [C §0] → 1.243× [D §0] → 1.203× [E §0].
- **Fix.** Replace with "loop tok/s 0.52× (loaded, load1 26–49) [B §1.1] [D]; first quiet standing 0.840× [BQ §0]; final 1.203× [E §0]" in the playbook header, plan §1, and the reports README.

#### M2. `TH_MPP_PROBE` does not "compile every MPP pipeline"; geometry-templated pipelines compile on first forward

- **Claim.** Playbook quick-start (Stage 1) and §1.3: "`TH_MPP_PROBE=1 th-engine probe --model x --tokens 1` compiles every MPP pipeline"; §1.9 gate row; Appendix A: "compile every MPP pipeline, no GPU work".
- **Code.** `main.rs:234-240` calls `quant_kernel::mpp_probe`, which (`quant_kernel.rs:2578-2644`) compiles a header probe, then `MPP_SRC`, then builds one pipeline per `ALL_MPP_KERNELS` entry plus `affine_q4_mpp_pf_sums` / `_prefill` / `_prefill_up`. That is the Q4 MPP decode/prefill library only. Everything geometry-templated compiles later with the *model's* dims: the GDN step (`gdn_kernel.rs:671`, `:759-777`, first caller's HK/HV/DK/DV), `gdn_pipe` (`:962`), attention prepare/decode via `GeomCache` (`attn_kernel.rs:316`), the split kernel via `render_split` (`:856-862`), fused prefill attention (`:1613+`), `qmvt_warm` (`quant_kernel.rs:3008`) and `pf_warm` (`:4786`) at model load.
- **Problem.** For a new geometry the Stage 1.3 tick gives false confidence: a template that does not compile at DK = 64 or GRP = 12 fails at the first forward (Stage 1.4), where the playbook is already trying to interpret logits.
- **Fix.** Reword the three places to "compiles the Q4 MPP library (`ALL_MPP_KERNELS` + prefill MPP functions)". Make the real compile gate explicit: "load the model, run one eager and one fused forward under `MTL_SHADER_VALIDATION=1`; every geometry-templated pipeline compiles here". In the plan, add to G1/R14 a `th-engine inspect --compile` that instantiates every pipeline the route plan would use for the descriptor's geometry without weights.

#### M3. `/status`: a value-semantics change presented as additive, and a second consumer the plan never names

- **Claim.** Plan §5.4: "`/status` then reports a context limit derived from the plan instead of `max_position_embeddings` (`server.rs:92`)"; §10.1 G8: "low: the `/status` contract only gains keys"; §4.2 B6 names the Swift catalog and `EngineSupervisor.swift` as the consumers.
- **Code.** `server.rs:92` emits `maximum_context_tokens` from `model_meta["context_length"]`, which is `cfg.max_position_embeddings` (`model.rs:664`, `:706`). `EngineTab.swift:123` reads `maximum_context_tokens`. Changing its value is a semantic change to a consumed key, not an addition. The Go daemon also probes `/status` and requires `instance` (`daemons/go/internal/engine/supervisor.go:161`, `:174`), mirroring `EngineSupervisor.swift:252-277`.
- **Fix.** Add new keys (`memory_plan.max_context_tokens`, `arch`, `routes`, `capabilities`, `build`) and leave `maximum_context_tokens` as it is, or declare the change and update `EngineTab.swift:123`. List the Go daemon as a `/status` consumer in B6/G8 and include both clients in the key-path-diff gate (playbook §8.3 row 12).

#### M4. The DFlash descriptor's `upstream.target` is converter provenance, not Splash's validated schema, and its revision does not match th's target

- **Claim.** Plan §6.3: "a `DFlashDescriptor` parsed from the Splash manifest (schema 3 and 4: `execution_geometry`, `format`, `upstream.target`, the v4 `draft` block) and validated against the target … matching upstream id"; plan §10.1 G8 (X-04) and playbook §5.1 Q2 "manifest `upstream.target` equals the target id".
- **Evidence.** The installed package does carry it: `~/Library/Application Support/Splash/models/incoai/Qwen3.8-27B-Splash/manifest.json` has `upstream.target.repo_id = mlx-community/Qwen3.8-27B-4bit`, `revision 3e6447f0…`. But Splash's own runtime never reads `upstream` (`docs/splash/runtime/model/ModelDescriptor.mm:135-300` validates `schema_version`, `execution_geometry`, `format`, `model`, and for schema 4 `target` and `draft`); the test fixture omits it (`docs/splash/dev/tests/test_models.py:92-108`). And th's `$TGT` snapshot is `10c35caafbb…` (`impl-th-wp2-matmul-roofline.md:278`) — a different revision from the draft's declared upstream. A strict "upstream id must match" rule applied to revisions would reject the program's own Qwen3.8 + DFlash pairing.
- **Fix.** Validate on `upstream.target.repo_id` when the key exists and *warn* on revision mismatch; when absent, fall back to the geometry checks the plan already lists (codebook rows = vocab, multiple of 512, hidden, capture layers < layer count). State in §6.3 and X-04 that `upstream` is optional converter metadata.

#### M5. Metric definitions are Splash-specific; no adapter for the competitors a Qwen4 job will face

- **Claim.** Playbook §3.1 defines loop tok/s for the competitor as `decode_output_tokens / decode_wall_ms` from `/status` deltas and rounds as Splash `decode_batches` (`PHASEC-REPORT.md:16`, `:171`; `bench-quiet.md:77-78`, `:226`). §2.4 lists MTPLX, mlx-lm and llama.cpp as candidates; plan §13 leaves "which competitor" as an open question.
- **Problem.** Qwen4 has no Splash package. MTPLX's MTP round (depth k, one verify) is not th's DFlash round; mlx-lm has no rounds; llama.cpp exposes them only with `--mtp`. Tokens/round, like-for-like tok/s and the "per-round × tokens/round" standing decomposition (§3.1, §9.2) are undefined for them, and the playbook's identical-text accounting relies on the competitor logging rounds.
- **Fix.** Add a competitor adapter table to §3.1: engine → where tok/s comes from (client wall clock, engine counter), whether rounds exist and how they are defined, what is comparable (wall tok/s on identical text always; tokens/round only when both engines expose rounds). Decide in §2.4 that for non-Splash competitors the standing is like-for-like wall tok/s, with the per-round split reported for th only.

#### M6. Figures cited only to the same-day analysis documents

- **Claim.** Playbook conventions: "If you add a number to this file, cite the report that carries it." Several numbers cite only [LAND]/[AUD]/[CAT] — untracked siblings written the same day, not primary sources.
- **Examples and where they actually resolve.** 614 GB/s (playbook §2.1) → `landscape-and-onboarding.md:544` → `docs/MTPLX/mtplx/ternary_qmv.py:9-10`; H200/SGLang speedups (§5.1) → LAND §4.4 → a web source (W7), not vendored; MTPLX 64.4 vs 52.6 tok/s (plan §8, [CAT §8.2]) → `docs/MTPLX/README.md:24`; 0.773 vs 0.387 (plan §6.6) → `docs/MTPLX/mtplx/hy_v3_mtp_patch.py:21`; 96.0 % / KL 0.012 → `docs/MTPLX/README.md:106`; Splash tuner 12 / 64 pairs, 10 % / 5 % / 3 % → `docs/splash/dev/tuning/Tuning.hpp:23-24, 50-52` (verified exact); 84,240 combinations → `docs/splash/dev/benchmarks/device-policy.md:76` (verified).
- **Fix.** Cite the vendored path directly wherever one exists; tag web-only figures `[ext]` and keep them out of decision rules (the §5.1 tree already uses them only as "relative conclusions transfer" — keep it that way).

### 1.3 LOW

#### L1. Derived figures tagged as quoted, and one unexplained juxtaposition

- Splash governor "≈17.4 GB needed plus ≈13.7 GB protected [Bb]" (playbook §0.3 rule 3): `PHASEB-baseline.md:157` gives bytes (`17355931648` + `13743895347`); the GB values are [D].
- F_bw 29.8 ms/round (`PHASEB-REPORT.md:107`): its inputs are lost (`landscape-and-onboarding.md:543`). It is re-derivable from the playbook's own per-class bytes ([K45 §3.1]): 100.3 × 64 + 50.1 × 64 + 47.5 × 48 + 17.7 × 48 + 41.3 × 16 + 17.7 × 16 + 715 ≈ 14.41 GB target + 1.65 GB draft ≈ 16.06 GB per round; ÷ 29.8 ms ⇒ ≈ 539 GB/s implied — i.e. the floor was computed at the measured best-kernel rate (530–535 GB/s, [K45 §5.2]), not the brief's 565 GB/s. Show this arithmetic in §2.1 so the floor stops depending on a missing document.
- Plan §5.4 places "one parity ≈ 151 MB [DP §2]" beside "the second parity cost +≈195 MiB per slot [CG §2]" (`th-c-gdn-parity.md:85`). 151 MB = 144 MiB; the 51 MiB gap (conv windows are ≈3 MB) is unexplained. Reconcile or drop the juxtaposition.

#### L2. Harness inventory gaps (playbook §0.4)

- `gpu-lock-quiet` is cited ([DG R2], §3.3) but absent from the table; it lives at `.worktrees/_phaseC/work/th-d-gpu-tail/bench/gpu-lock-quiet`.
- `fpguard.py` is at `work/integration-3/bin/`, `fpmon.py` at `work/integration-4/bin/` (the table gives no paths for the samplers/guard).
- `wt-bootstrap` hard-codes `SEED=$REPO/.worktrees/report/integration-2/engine/target/release`; Stage 0 fails on a machine where that worktree is gone. Parameterise in G0.
- Verified as described: `gpu-lock` (flock, 7200 s default, exit 75, pid + cmd in the lock file), `wt-bootstrap` default start `main`, `fin4d.sh` `F_*` names (`F_ORDER_S F_BLOCKS F_ARM_TRIES_S F_LOAD_MAX2 F_GATE_WAIT2 F_GATE_CPU_IDLE F_REQ_CPU_IDLE F_THERM_WAIT F_THERM_OK` all exist), `gates4.sh` `G_LOGITS`, passages (sha1 `a886db14acc4` / `6ab8ad9a056a` match), `mtlc3.m`, the Swift GEMM harness, `.git/info/exclude` → `.worktrees/`.

#### L3. Anchors to tighten

- `qwen35.rs:44-45` for the `head_dim` serde default → the attribute and field are `:43-44` (`d_hd` at `:65` is right).
- Plan §1 "attention prepare / decode … A-01": cite the dispatch (`attn_kernel.rs:589-593`, `32 * (nh / nkv)` threads) rather than the stale `:218` comment; see H1(e).
- Playbook §1.2 RoPE row says "none (`default`)"; the pack's `rope_parameters` also carries `mrope_interleaved: true`, `mrope_section: [11, 11, 10]` (config.json of snapshot `10c35ca`), ignored per AUD C-04 and harmless for text positions. List them so a reviewer does not rediscover the field.
- Playbook Appendix C / §1.5: the legacy-logits line is `main.rs:408-416` (PASS/FAIL at `:413-416`); fine as `409-416`.

#### L4. Invariant-21 guard rails are respected but unstated

Nothing proposed breaks attach-or-spawn, `/status` probing (both clients require only `instance`), or the gateway's prefix-only routing (`gateway/infer.go:28`: `/th-engine` → `ProviderTHEngine`; `gateway/config.go:77`). Add an explicit "does not change" list to G8: (a) `inspect` registry tiers and model-id classification never feed gateway auto-routing — th-engine stays prefix-only (AGENTS.md invariant 21); (b) an app-spawned `th-engine inspect` never touches `:8001`, never runs inside a `gpu-lock` measurement window, and `stop()` semantics are untouched; (c) removing the absolute developer path (`EngineSupervisor.swift:100`) changes dev-build discovery — keep `TOKEN_HORIZON_TH_ENGINE_BIN` as the documented override.

#### L5. Hyper-connections are listed in G7 but not connected to the limits they hit

Flash-Next's 4-stream residual (plan §5.1, §12(a)) means per-row add + RMSNorm widths of 4 × 5120 = 20480 > `ARN_P_MAX_C` = 7936 (`gdn_kernel.rs:2139`; `:2207` falls to the legacy kernel — SLOW, the playbook §1.2 row), and the DFlash / MTP tap ("which stream, before or after the read projection") becomes part of `TapSpec` (plan §6.1). Neither consequence is named.

#### L6. Both documents and their evidence are untracked

`engine/docs/` and `engine/reports/perf-2026-09/README.md` are `??` in `git status`; the harness they depend on is under `.worktrees/` (excluded). G0 is the right fix; the documents should say so in their headers until it lands.

---

## 2. What is missing

1. **A GQA > 8 guard and test** for the split-key attention kernel (`attn_kernel.rs:909`), and GQA 12 in the R12 sweep — the Flash-Next value (H1).
2. **The Go daemon as a mirror surface**: `/status` consumer (`supervisor.go:161,174`), catalog (`catalog.go:40-48`), no `--draft` support; B6/G8 must list it and AGENTS.md's "keep both copies in sync" rule applies (M3, H2).
3. **A product-reachability smoke** in Stage 1 (serve from the ENGINE tab / daemon, `/engine` shows the model) and a th-engine catalog entry for the optimised pack (H2).
4. **A compile-all gate for new geometries** (`th-engine inspect --compile`, or "one eager + one fused forward under shader validation") replacing the overstated `TH_MPP_PROBE` tick (M2).
5. **Competitor metric adapters** for MTPLX / mlx-lm / llama.cpp, and a rule for what "standing" means when the competitor exposes no rounds (M5).
6. **Draft-vs-target provenance check**: compare `upstream.target.repo_id`/`revision` with the loaded snapshot and warn — today the installed draft declares `3e6447f…` while th loads `10c35ca…` (M4).
7. **Tokenizer availability**: `model.rs:465` fetches `tokenizer.json` only; a pack that ships only `tokenizer.model` (SentencePiece) or a `--tokenizer` override path belongs in the plan's §9 chat/generation adapter alongside BOS/EOS.
8. **MoE weight layout**: MLX MoE packs stack experts as 3-D tensors (`switch_mlp.*.weight [E, out, in/8]` plus `scales`/`biases`); `Weights::get_lin`, `fuse_lins` (`qwen35.rs:1544`) and `maybe_tiled` (`:853`) assume 2-D. The plan's §12(b) "stacked experts" should name the loader/repack change and that `Q4AttachSums` presums stop at the router (it does say the latter).
9. **An "already general" claim that needs a test, not a comment**: plan §1 lists `attn_decode` as head_dim-coupled only; that is right by the dispatch, but the R12 sweep should include GQA ∈ {2, 12, 16} for both `attn_decode` and the split kernel so the claim is guarded.
10. **F_bw arithmetic** in the playbook §2.1 so the floor is re-derivable (L1).
11. **A one-line trajectory table** (loaded 0.52× → quiet 0.840× → 1.031× → 1.243× → 1.203×) replacing the mixed-metric headline (M1).

---

## 3. What checked out (coverage statement)

So the reader knows what was verified and does not have to redo it:

- **Environment names.** Every `TH_*` name in both documents appears in `engine/src` (`grep -oh '"TH_[A-Z0-9_]*"'`), including the in-binary old-path arms of playbook Appendix B (`TH_Q4_PRESUM`, `TH_Q4_POLICY`, `TH_Q4_PS_FAMILIES`, `TH_M1_PATH`, `TH_VERIFY_ADAPTIVE`, `TH_GDN_COMMIT`, `TH_GDN_COMMIT_ALL`, `TH_ARN_LEGACY`, `TH_GDN_WSG`, `TH_CAND_SORT`, `TH_DRAFT_RING`, `TH_DRAFT_PS`, `TH_OUT_ZEROS`, `TH_ATTN_SPLIT[_MIN]`, `TH_DRAFT_ATTN_SPLIT`, `TH_SAMPLE`, `TH_SPEC_VERIFY`, `TH_PREFIX_CACHE*`, `TH_ATTN_GQA`, `TH_PREFILL_ATTN[_VARIANT]`, `TH_PF[_LARGE]`, `TH_KV_CAP_PREFILL`, `TH_KV_RESERVE`, `TH_PREFILL_HEAD`, `TH_GPU_CORES`, `TH_PHASE_TIME`, `TH_BENCH_GDN[_N]`), and `CANDLE_METAL_COMPUTE_PER_BUFFER` (`gpuprof.rs:20-21, 388-390`). `TH_BENCH_ROUND` and `TH_CHECK_POS` are absent from `main`, as stated; commits `5090f18` and `28acf03` and branch `th/d-longctx-probe` exist.
- **`main.rs` probe anchors** (Appendix A): `TH_TOKENIZE` :172, `TH_PF_COMPILE` :190, `TH_BENCH_DRAFT_ATTN` :204, `TH_BENCH_PREFILL_ATTN` :212, `TH_BENCH_ATTN` :221 (no-colon form) / :778 (`seq:kv`), `TH_BENCH_ALLOC` :228, `TH_MPP_PROBE` :234, `TH_TEST_ROLLBACK` :245, `TH_BENCH_LIN` :427, `TH_BENCH_Q4` :440, `TH_BENCH_DRAFT_MLP` :446, `TH_BENCH_MULTI[_ITERS]` :451/:472, `TH_BENCH_PREFILL[_LARGE_ONLY]` :492/:502, `TH_BENCH_STEPS[_REPS]` :550/:560, `TH_BENCH_PLAN[_MERGE]` :611/:636, `TH_BENCH_TTFT` :774 (+ :1110-1127), `TH_BENCH_PREFILL_LOGITS/_IDS/_REPS/_STEP` :874-890, `TH_BENCH_BATCH` :972, `gpuprof::init()` armed at :109-110 — all exact.
- **Kernel/engine anchors** (playbook §1.2, plan §1, §3.1): `gdn_kernel.rs` :55-56 (`[f32; 64]`), :109-112 (HK/HV/DK/DV substitution), :118, :373-376 and :567-570 (`DK / 32`, `lane * 4 + i`), :447-460 (presum epilogue at 64/96 + lane), :671 / :759-777 (first-caller `PIPELINE`), :846, :962 (`gdn_pipe`), :1116 (`dk != dv` only), :1160-1166 (`[3, conv_dim]`), :1218 (`dv % 64`), :1304 / :1501-1502 (`COMMIT_MAX_LAYERS`, bails), :2139 / :2207 (`ARN_P_MAX_C` 7936, legacy fallback), :2303-2306 (`QKN_PIPE`/`GNORM_PIPE`), :2694-2697; `attn_kernel.rs` :90-94, :134, :218, :316 (`GeomCache`), :654-658, :856-862, :909, :1613-1615; `quant_kernel.rs` :55-78 (`gpu_cores`), :195-244, :205, :218-219 (`DECODE_TILE_TABLE`), :252, :299, :2571-2574 (`OnceLock` statics), :2578, :2964, :3008, :4690, :4786, :5109-5112 (`unwrap_or(40)`), :5117, :5254; `qwen35.rs` :8-9, :31-103, :65, :71-79, :100-102, :169 (`bits: 4, gs: 64`, `quantization` never read), :853, :910/:917/:936, :995-1009, :1544, :1849, :2084, :2102, :2677, :3009, :3043-3049, :3060-3067, :3308, :3412-3417, :3832, :4397, :4416-4419, :4812, :4984 (`seq <= 16`), :4993 (`TH_PHASE_TIME` per call), :5427, :5541, :5769, :5970; `engine.rs` :105-109, :113-124, :139-143, :300-304, :307-320, :454, :482-496, :657-665, :831, :931, :1137-1141, :1152, :1289, :1367 (`seed | 1`), :1538, :1713, :2160, :2267, :2503; `model.rs` :18-25, :65-371, :122-131, :464-469 (HF loads fetch `config.json`, `tokenizer.json`, `tokenizer_config.json` only — the pack keeps its template solely in `chat_template.jinja`, verified), :639, :691; `dflash.rs` :30-52, :48; `sample_kernel.rs` :48, :62-64; `prefix_cache.rs` :37-39, :107, :252-258; `server.rs` :38 (`/health` exists), :81-112, :92; `state.rs` :69-71; `template.rs` :78-83, :269-275 (ChatML fallback); `api.rs` :8-25; `outbuf.rs` :19, :31, :108, :133; `gpuprof.rs` :134, :142, :305, :403; `THEngineCatalog.swift` :25-42; `EngineSupervisor.swift` :49-58, :96-104; `HardwareProfile.swift` :56-135.
- **Pack facts** (snapshot `10c35ca…`): `model_type qwen3_5` nested under `text_config` (handled, `qwen35.rs:82-98`), `head_dim 256`, `layer_types` 64 entries, `full_attention_interval 4`, `attn_output_gate true`, `output_gate_type swish`, `quantization {affine, 4, 64}`, `mtp_num_hidden_layers 1` with **0** `mtp.*` tensors among 2180, `generation_config` temperature 1.0 / top_k 20 / top_p 0.95, `tokenizer_config.json` has no `chat_template`. All as [AUD] states.
- **Report figures** (spot-checked to the line): 14 confirmed bugs (`PHASEB-REPORT.md:26`); +2.84 ms (95 % CI 2.18–3.50) (`:178`); 2 MiB from 64 KiB (`:143-148`); syncs 6 → 2 (`PHASEC-REPORT.md:202`); 151 vs 147 rounds (`:32`); gates hold 08:12:24–08:14:36 (`:290`); throttling Splash −11 % / th −3 % / ≈8 % (`bench-quiet.md:293`); idle ≥ 85 %, ≤ 60 ms/s (`:64-65`); loop tok/s and `decode_batches` definitions (`:77-78`, `:226`); 2× and 30 % drift (`impl-th-wp10-prefill-tiles.md:76-78`); `MetalStorage::new` rule (`impl-th-wp2-matmul-roofline.md:308`); missing harness pieces (`:39`); RIF 4/6 requests (`th-d-gpu-tail.md:54`); DG gates load1 < 5 and redo rules (`:112-123`); Phase D gates (`PHASED-REPORT.md:50`), gate hold 06:05:29–06:18:27 (`:248`), f2 06:28–08:30 (`:22, :44`); Phase E 24 arms / 748 requests (`PHASEE-REPORT.md:23`), gates 18:46–19:30, S2 23:55–00:29 (`:70-77`), tier gates (`:64`); `+8–12 %` at 1024 rows (`th-e-prefill-gemm.md:26`), 91 % / 61–65 TFLOPS (`:19`); 195 MiB (`th-c-gdn-parity.md:85`), eager path untested (`:186`); candle 50-encoder batching (`th-d-longctx.md:362`), 64-command-buffer cap (`:55`); "no build embeds a git sha" (`th-e-ttft-regression.md:14`; no `build.rs`, `server.rs:86` uses `CARGO_PKG_VERSION`). The [D]-tagged durations (≈2 min, ≈13 min, ≈43 min, ≈2 h, ≈34 min) follow from those timestamps.
- **Protocol content the task asked to check.** Thermal/load gating with redo rules (§3.3, all four sessions' thresholds match the reports), ratio of sums (§3.1, §3.4), timer artefacts (`decode_tps` 126.1 vs 50.1, `prefill_tps` ≈3.7× — §7.2, App. C), the untracked-`Arc` class (§6.2 item 6, §7.2 row 1, §7.3 item 1), load-inflated claims withdrawn (§0.3 rule 7, §3.6, §4.3, §11.5) — present and correctly cited.

---

## 4. Verification log

Method, for reproducibility: `sed -n` on every `file:line` range both documents cite (≈120 anchors) and comparison with the described content; `grep -oh '"TH_[A-Z0-9_]*"' engine/src/*.rs` against every env name in both documents; a scripted presence sweep of ≈150 quoted figures over `engine/reports/perf-2026-09/**/*.md` followed by manual look-up of every miss (all but the ones in §1.2 M1 / §1.3 L1 were en-dash vs hyphen); direct reads of `docs/splash/dev/tuning/Tuning.hpp`, `docs/splash/dev/benchmarks/device-policy.md`, `docs/splash/runtime/model/ModelDescriptor.mm`, `docs/splash/dev/tests/test_models.py`, `docs/MTPLX/README.md`, `docs/MTPLX/mtplx/hy_v3_mtp_patch.py`, the installed Splash manifest, the local HF snapshot's `config.json` / `generation_config.json` / `tokenizer_config.json` / `model.safetensors.index.json`; `git cat-file -t` for `5090f18` and `28acf03`; the `.worktrees/_phaseC` harness scripts and work directories; the Swift `Engine/` and `UI/EngineTab.swift` sources, `daemons/go/internal/engine/{catalog,supervisor}.go`, `gateway/{infer,config}.go`. No binaries were built or run and no GPU work was done.
