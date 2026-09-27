# th-engine model optimisation playbook

> **What this is.** The runbook for a *new model optimisation job* on th-engine: take a new checkpoint (a Qwen4-class hybrid, a MoE, an MTP-headed model, a non-Qwen family, a new quant format) from "it loads" to a gated, measured standing against the best competing engine on the same Mac, without re-discovering what the 2026-09 program learned. Every stage lists its commands, its exit gate and the evidence behind it, so an agent team (orchestrator, lanes, reviewers, integrator) or a single engineer can execute it.
>
> **Evidence base.** Over 2026-09-25..28 a multi-phase program (phases B–E plus the bench-quiet protocol session) moved th-engine's T=0 loop tok/s against Splash 1.0, on Qwen3.8-27B-4bit + DFlash on an M5 Max, from 0.52× on a loaded machine [B §1.1] [D] to a first quiet standing of 0.840× [BQ §0], then 1.031× [C §0], 1.243× [D §0] and 1.203× [E §0] (per-phase table and caveats: §11.1). Every number below is quoted, with a citation key, from those reports (`engine/reports/perf-2026-09/`) or from a vendored reference-engine file (`S:` / `X:` paths), or is tagged [D] with its inputs; the analyses in `engine/docs/analysis/` are cited for design and inventory, not as the source of a figure. Code references are `file:line` under `engine/src/` at `main` @`b31ca91` unless another path is given.
>
> **Status.** Written against `b31ca91`. The harness that §0.4 describes as living under the git-excluded `.worktrees/` is now versioned at `engine/tools/perf/` (see its README for provenance; script-internal paths still follow the `.worktrees/` layout they were written in). GENERALISATION-PLAN G0 covers the remaining hardening. Review dispositions: Appendix D.
>
> **Companions.** [`GENERALISATION-PLAN.md`](GENERALISATION-PLAN.md) lists the engine changes that make this job cheaper (descriptor, route plan, tune tables, drafter trait, perf CI). For depth: [`analysis/pathway-catalogue.md`](analysis/pathway-catalogue.md) (lever families L01–L19), [`analysis/coupling-audit.md`](analysis/coupling-audit.md) (every Qwen3.8 coupling, with IDs such as G-02 or A-01), [`analysis/landscape-and-onboarding.md`](analysis/landscape-and-onboarding.md) (reference engines, next models, autotune and CI design).

## Conventions

| key | report (under `engine/reports/perf-2026-09/`) | key | report |
|---|---|---|---|
| [B] | `PHASEB-REPORT.md` | [CL] | `th-c-loop.md` |
| [Bb] | `PHASEB-baseline.md` | [CG] | `th-c-gdn-parity.md` |
| [BQ] | `bench-quiet.md` | [CP] | `th-c-ports.md` |
| [C] | `PHASEC-REPORT.md` | [DL] | `phaseD/th-d-longctx.md` |
| [D] | `phaseD/PHASED-REPORT.md` | [DG] | `phaseD/th-d-gpu-tail.md` |
| [E] | `phaseE/PHASEE-REPORT.md` | [DS] | `phaseD/th-d-sampled.md` |
| [K45] | `impl-th-wp2-matmul-roofline.md` | [DP] | `phaseD/th-d-prefix-cache.md` |
| [T2] | `impl-th-wp10-prefill-tiles.md` | [EA] | `phaseE/th-e-prefill-attn.md` |
| [U1] | `impl-th-wp1-utf8-stream.md` | [EG] | `phaseE/th-e-prefill-gemm.md` |
| [RI] | `review-integ.md` | [ET] | `phaseE/th-e-ttft-regression.md` |

- Analyses under `engine/docs/analysis/`: [AUD] `coupling-audit.md`, [CAT] `pathway-catalogue.md`, [LAND] `landscape-and-onboarding.md`. Reference engines: `S:` = `docs/splash/…`, `X:` = `docs/MTPLX/…`.
- `[B §2.1]` means section 2.1 of that report. Tags: **[M]** measured, **[D]** derived here from cited figures, **[E]** an estimate made in a report, **[I]** this document's inference (an [I] never carries a number), **[ext]** a web-only figure with no vendored source (context only, never an input to a decision rule).
- "Qwen3.8" means `mlx-community/Qwen3.8-27B-4bit` (`$TGT`) plus Splash's packaged DFlash draft (`$DRAFT`) on an M5 Max (40-core GPU, 128 GB). The reference engine is Splash 1.0 (brew).
- A "round" is one speculative decode round: propose, verify, accept/commit. Loop tok/s, ms/round and tokens/round are defined in §3.1.
- If you add a number to this file, cite the report or vendored file that carries it, or tag it [D] with its inputs.

---

## Quick-start checklist (one page)

Run top to bottom. Tick a box only when its gate passed and its evidence (log path plus binary sha256) sits in the job's work dir.

**Stage 0: prepare** (§0.4)
- [ ] Artifact pinned: repo id and revision; sha256 of `config.json`, `generation_config.json`, the tokenizer files, the chat template and `model.safetensors.index.json` [LAND §5].
- [ ] Harness available and hashed: `gpu-lock`, `gpu-lock-quiet`, `wt-bootstrap` (point its hard-coded `SEED` at a built tree), session runner, client, analysis scripts, passages (sha1 `a886db14acc4`, `6ab8ad9a056a`), footprint guard, samplers. None of these are in git today (§0.4).
- [ ] Baseline binary frozen and hashed (no th build embeds a git sha [ET header]); private port chosen; `:8001` left alone.

**Stage 1: correctness** (§1). Nothing is timed until this stage is green.
- [ ] Geometry pre-flight (§1.2): every SILENT or PANIC trap passes, or the op is routed to its eager oracle and a guard is added.
- [ ] `cargo build --release` with 0 warnings; `cargo test --release` all pass; `TH_MPP_PROBE=1` prints no `err` / `->` line (it covers the Q4 MPP library only); the first real forwards compile the geometry-templated pipelines with no `[attn] … unsupported` / `unavailable` line or `compile failed` WARN (§1.3).
- [ ] Last-prefill-position logits vs the reference (mlx-lm on the same pack) sit inside th's own tail-chunk noise floor (`TH_BENCH_PREFILL_LOGITS`).
- [ ] `TH_TEST_ROLLBACK=1` exits 0 at `TH_BATCH=1` and `2`, on 18- and ≈1450-token prompts, and with `TH_ATTN_SPLIT_MIN=1`; with `TH_GDN_COMMIT=step` it must exit **1**.
- [ ] `MTL_SHADER_VALIDATION=1` on every new path: 0 "Invalid device load". Long prompts run under a phys_footprint guard.
- [ ] Server smokes: `TH_BATCH=1/2/4`, `TH_SAMPLE=check` with 0 mismatches, prefix cache hit == miss 42/42 · 42/42, `--kv-quant`, no-draft, `/status` keys additive, a CJK stream with 0 U+FFFD.
- [ ] Product contract (§1.7, never on `:8001`): `/status` carries what the app and the Go daemon read; the model has a serve path, with its draft, in both clients (GENERALISATION-PLAN G8a) or the gap is recorded.
- [ ] Golden T=0 id streams recorded per prompt × mode: the identity baseline.

**Stage 2: floors and baseline** (§2)
- [ ] F_bw, F_k and the draft floor computed; per-class GB/s table from `TH_BENCH_Q4` (serial mode).
- [ ] Verify-width ladder `TH_BENCH_MULTI=8,7,6,5,4,3,2,1`.
- [ ] First quiet same-session standing vs the best competitor (§2.4): per mode; split into per-round × tokens/round where the competitor exposes rounds (§3.1 adapters), else client wall tok/s on identical requests; TTFT classes; peak phys_footprint.
- [ ] Gap attributed three ways: host idle, GPU work above F_k (`TH_GPU_PROF=1`, used to rank only), tokens/round on identical text.

**Stage 3: protocol** (§3), used by every A/B from here on
- [ ] One `gpu-lock` hold; fresh server per arm; palindrome arm order; thermal and load gates with redo rules; explicit sampling (0.6 / 0.95 / 20, odd seeds); ratio of sums; a T=0 control arm.

**Stage 4: triage** (§4, §5)
- [ ] Symptom → lever family; rank by expected Δms/round (or Δtokens/round) per unit of effort; apply the decision trees; one lever family per lane.

**Stages 5 and 6: lanes and review** (§6, §7)
- [ ] Each lane has its own worktree, port and frozen binaries, follows the lever template (read-once env arm, bitwise test that fails under a one-ulp mutation, in-binary A/B including long-context and sampled arms) and writes a lane report.
- [ ] Each branch is reviewed through the memory, numerics and state-machine lenses, every finding is verified by its own agent, and the checklist in §7.3 is walked.

**Stage 7: integrate** (§8)
- [ ] Pairwise `merge-tree` matrix; one `--no-ff` merge per lane; semantic-merge review; full gate suite on the merged head; "new kernel off == lane final" merge check.

**Stage 8: final A/B and landing** (§9, §10)
- [ ] Palindrome of new / base / old / competitor; the quiet replicate is the standing; identity pass; logits dumps; report in the §10 format; landing notes with ownership sign-off.

---

## 0. Running the job

### 0.1 Shape of the job

| stage | output | exit gate | cost precedent |
|---|---|---|---|
| 0 Prepare | pinned artifact, harness, frozen baseline | harness runs one smoke session end to end | Phase B found harness pieces missing and rebuilt them by hand [K45 §0] |
| 1 Correctness | model loads; logits inside the noise floor; state gate; smokes; golden ids | §1.9 table all green | the Phase E gate suite took one ≈43 min hold [E §4.1] [D] |
| 2 Floors and baseline | F_bw, F_k, verify ladder, first standing, gap split | per-mode table with conditions and binary sha256 | the Phase D final hold ran ≈2 h [D §1.1] [D] |
| 3 Protocol | the session recipe every A/B uses | — | — |
| 4 Triage | ranked lever list, one lane each | orchestrator sign-off | — |
| 5 Lanes | one branch per lever family plus a lane report | lane gates and a quiet A/B | 3–4 lanes per phase in C–E (§11) |
| 6 Review | a verdict per branch | mergeable, or every must-fix fixed | 14 confirmed bugs in Phase B's commits [B §0] |
| 7 Integrate | integration branch | full gate suite on the merged head | 3 semantic merge fixes in integration-3 [D §0] |
| 8 Final A/B | standing report and landing notes | quiet replicate and identity pass | 24 arms, 748 requests in Phase E [E §0] |

### 0.2 Roles

- **Orchestrator.** Owns triage, the lane list, the merge rule and the final standing. Twice a truncated lane list meant a review verdict never reached the integrator, and the lane merged on its own gates [D §3; E §3]; the orchestrator checks that every verdict arrives.
- **Lane agent.** One lever family, one branch, its own worktree and private port, a lane report.
- **Review agents.** Three lenses: memory, numerics and state machine [B §2].
- **Verification agents.** One per finding, in a private worktree, under `gpu-lock`. The verifier re-grades severity, often downward [B §2].
- **Integrator / final-A/B agent.** Builds the integration branch, runs the gate suite and the final same-session A/B, and writes the phase report [C, D, E headers].

### 0.3 Ground rules

| # | rule | why (evidence) |
|---|---|---|
| 1 | Work only in worktrees (`wt-bootstrap <branch> [start]`). Never edit, build or reset the main working tree. | Every phase report records the main tree untouched [C §5.1; D §5; E §5]; another developer works there concurrently. |
| 2 | Every GPU-timed run goes through one exclusive `gpu-lock`. Builds need no lock. | 5–7 agents queued on the GPU at once in Phase B [K45 §0]; a GPU user that took no lock (`replayd`, 44–87 % GPU) contaminated rounds 2–3 of a session [K45 §5.3]. |
| 3 | A private port per lane. Never touch `:8001` (the app-attached engine). Run the competitor only on a free port and never beside a th server; Splash and MTPLX both default to `:8000` (`X: README.md:193`). | Splash's memory governor refused to start with th resident: 17,355,931,648 B needed plus 13,743,895,347 B protected (≈17.4 + 13.7 GB) [Bb] [D]. |
| 4 | Freeze binaries, identify them by sha256, and `cmp` them against the worktree build. | No th build embeds a git sha [ET header]; the same code built at another path differs only in LC_UUID and the code signature [BQ §1]; MTPLX A/B-tested a stale binary twice (`X: mistakes/two-ab-rounds-measured-a-stale-2-7-binary-…md`). |
| 5 | Keep the old path behind a read-once env arm. | In-binary arms located regressions directly: the KV-capacity TTFT cost via `TH_KV_CAP_PREFILL=0`, the MEM-2 cost via `TH_OUT_ZEROS=1` [D §1.5; CP §4]. |
| 6 | No per-call env reads on hot paths; compile every routed pipeline at load (today only `pf_warm` and `qmvt_warm` do; the GDN step and split / prefill attention compile on first use, §1.3). | ≈70 `getenv` per round were found [RI should-fix 4]; lazy compiles landed on first requests [B §3.1]; `pf_warm` builds 26 pipelines, 1.4 s on a never-seen binary path [EG §5]. |
| 7 | A number from a loaded or throttled machine is never a standing. | A loaded ×1.301 became ×1.194 quiet and was withdrawn [DG §0]; throttling moved th/Splash by ≈8 % [BQ §0]. |
| 8 | Nothing is pushed; landing is the maintainer's call. Changes to `dflash.rs`, `draft_kernel.rs`, `engine.rs`, `main.rs`, `model.rs` and `qwen35.rs` need the other developer's sign-off. | [C §5.3; D §5; E §5] |

### 0.4 Stage 0: harness inventory and preparation

| piece | location today | tracked? | what it does | source |
|---|---|---|---|---|
| `gpu-lock` | `.worktrees/_phaseC/bin/gpu-lock` | no | `gpu-lock [--timeout S] -- <cmd>`: flock on `/tmp/th-engine-gpu.lock`, default timeout 7200 s (exit 75), holder pid and command written into the lock file | the script |
| `gpu-lock-quiet` | `.worktrees/_phaseC/work/th-d-gpu-tail/bench/gpu-lock-quiet` | no | takes the lock only once load1 has held below a threshold (§3.3) | [DG R2] |
| `wt-bootstrap` | `.worktrees/_phaseC/bin/wt-bootstrap` | no | `wt-bootstrap <branch> [start]` creates `.worktrees/<branch>` (new branch from `start`, default `main`), APFS-clones `engine/target/release` so builds are incremental, prints the path; idempotent. `REPO` and `SEED=$REPO/.worktrees/report/integration-2/engine/target/release` are hard-coded (lines 5–6): without that worktree the clone fails under `set -e`, so point `SEED` at any built `target/release` (G0 parameterises it) | the script |
| session runner | `.worktrees/_phaseC/work/integration-4/bench/fin4d.sh` (lineage `q.sh` → `fin.sh` → `fin4.sh` → `fin4b.sh` → `fin4c.sh` → `fin4d.sh`) | no | gated palindrome sessions, fresh server per arm, samplers, redo policy | [E App. A] |
| client | `bench/bq4_client.py` | no | the per-arm suite; one `runs.jsonl` record per request | [E App. A; C App. A] |
| analysis | `q4_analyze.py`, `ab4.py`, `ttft4.py`, `fp4.py`, `conds4.py`, `logits_cmp.py`, `gates-tools/cmp_arms.py` | no | ratio of sums, phases, identity, TTFT, footprint, conditions | [E App. A] |
| samplers and guard | `work/integration-4/bench/gpufreq.py` (IOReport P-states, no root) and `gpuq.py` (other GPU clients); `work/integration-4/bin/fpmon.py` (phys_footprint sampler); `work/integration-3/bin/fpguard.py` (footprint guard) | no | conditions and memory safety | [BQ §2; E §1.1] |
| gate script | `work/integration-4/bin/gates4.sh` | no | the Stage 7 gate suite (§8.3) | [E §4.1, App. A] |
| passages | `passage.txt` (sha1 `a886db14acc4`, 1373 tokens), `passage8k.txt` (sha1 `6ab8ad9a056a`, 7853 tokens) | no | ctx1500, ctxcold and ctx8k suites | [D §1.1; E §1.1] |
| `mtlc3.m` interposer | `work/th-c-loop/mtlc/` | no | Metal call counts per round: syncs, encoders, dispatches, fills | [CL §5] |
| standalone GEMM harness | `work/th-e-prefill-gemm/harness/*.swift` | no | GPU-timestamped kernel µs against the MMA-only ceiling | [EG §3] |
| `TH_BENCH_ROUND` | branch `th/d-longctx-probe` @`5090f18` | branch only | load-robust in-process round A/B (min/p25 estimators, KL and top-20 numerics) | [DL §0, §1.1] |
| in-repo probes | `engine/src/main.rs` and others (Appendix A) | yes | kernel, forward, prefill, TTFT and rollback probes | — |
| `scripts/bench-engines.sh` | repo | yes | the stock bench; its "decode" figure is overstated, so never use it for a standing | [Bb caveat 3; B §1.1] |

`.worktrees/` is excluded by `.git/info/exclude`, so none of the untracked pieces survive a fresh clone. Phase B found `wt-bootstrap`, `qbench`, `mtlcount`, `parse_log.py` and `waitquiet.py` missing, and its synthesis had been wiped by a scratchpad reset [K45 §0; B header]. **Stage 0 therefore starts by copying these into the job's work dir and recording their sha256.** GENERALISATION-PLAN phase G0 moves them into `engine/bench/` for good.

```sh
export REPO=/Users/benebsworth/projects/token-horizon
export P=$REPO/.worktrees/_phaseC                 # harness root until engine/bench/ exists
export JOB=<model-short-name>; export W=$P/work/$JOB; mkdir -p $W/{bin,bench,logs,ids}
export TGT=<local pack dir>; export DRAFT=<draft dir, if any>
( cd "$TGT" && shasum -a 256 config.json generation_config.json tokenizer*.json \
    chat_template.jinja model.safetensors.index.json ) > $W/artifact.sha256   # drop files the pack lacks
WT=$($P/bin/wt-bootstrap th/$JOB-base main)
(cd $WT/engine && cargo build --release && cargo test --release --no-run)
cp $WT/engine/target/release/th-engine $W/bin/th-engine-base-$(git -C $WT rev-parse --short HEAD)
shasum -a 256 $W/bin/* $P/bin/* > $W/SHA256SUMS
```

---

## 1. Stage 1: correctness bring-up

Every later lever is judged against the gates built here, so no timing happens until this stage is green [CAT §0.1].

### 1.1 Pin, inspect, classify

1. **Read the config field by field** against what th reads. Appendix B of [AUD] is the Qwen3.8 read/ignored table. th never reads `layer_types`, `attn_output_gate`, `output_gate_type`, `rope_type` or scaling, `quantization`, `mtp_num_hidden_layers` or `generation_config.json` [AUD F4, App. B], so check each of these by hand for the new model.
2. **Classify the tier** [LAND §5, Day 0]: **A** same family, new sizes; **B** known ops, new shapes or a new quant format; **C** new op types; **D** autoregressive-only for now.
3. **Fit the memory.** Add up:
   - weights, per quant scheme;
   - KV bytes per token = Σ over attention layers of n_kv × head_dim × 2 × dtype bytes [LAND §5]. Check on Qwen3.8: 16 × 4 × 256 × 2 × 2 B = 64 KiB per token, which matches the reported K+V row size [ET §2.2] [D];
   - recurrent state per slot = Σ over recurrent layers of Hv × Dv × Dk × 4 B per parity. Check on Qwen3.8: 48 × 48 × 128 × 128 × 4 B ≈ 151 MB, which matches both the 37.7M-element state [CG §0] and the 151 MB GDN part of a checkpoint [DP §2] [D];
   - allocations, not logical bytes: candle 0.11 rounds every pooled Metal buffer up to a power of two (`buf_size`, `candle-core-0.11.0/src/metal_backend/device.rs:336-338`), so each 3 MiB layer state costs 4 MiB and each 60 KiB conv window 64 KiB; the second parity is 48 × (4 MiB + 64 KiB) = 195 MiB, exactly the measured +≈195 MiB per slot [CG §2] [D];
   - the draft or MTP head;
   - the prefix-cache budget (default 4096 MiB, `prefix_cache.rs:107`);
   - the prefill transient (Qwen3.8 cold 7.9k at integration-4: +3.4 GB [E §1.5]).

### 1.2 Geometry pre-flight: the SILENT traps

These are the places where a new geometry produces wrong numbers with no error, a panic, or a silent slow path. Check every row before timing anything. A row that fails is either fixed (template or guard) or routed to its eager oracle. The source for every row is [AUD §0.2, §3, App. A].

| check | Qwen3.8 value | hard-coded at | if violated | action |
|---|---|---|---|---|
| GDN key head dim (DK) | 128 | fused step / wide step / commit: `gdn_kernel.rs:373-426, 567-620, 1411-1450`; the only guard is `dk != dv` at `gdn_kernel.rs:1116` | **SILENT** at decode (prefill is DK-generic) | eager oracle (`TH_GDN_EAGER=1`) or template the kernel (GENERALISATION-PLAN G6) |
| GDN value head dim (DV) with presum on | 128 | presum epilogue `gdn_kernel.rs:447-460`; guard checks only `dv % 64` at `gdn_kernel.rs:1218` | **SILENT** wrong out-projection sums (review should-fix #1, still open [RI; C §3]) | `TH_Q4_PRESUM=0`, or fix the guard |
| GDN conv taps | 4 | `gdn_kernel.rs:1160-1166` | LOUD at the first decode | template (G6) |
| GDN value heads (Hv) | 48 | `[0.0f32; 64]` tables, `qwen35.rs:3060-3067`; `gdn_kernel.rs:55-56` | **PANIC** at load for Hv > 64 | widen the tables |
| GDN layers | 48 | `COMMIT_MAX_LAYERS` = 56, `gdn_kernel.rs:1304` | LOUD at the first partial accept | `TH_GDN_COMMIT_ALL=0` |
| attention head dim, prepare/decode | 256 | `attn_kernel.rs:134-205, 218-266` (32 lanes × 8 channels); unguarded at `qwen35.rs:4416-4419`. The group is generic: the decode dispatch is `32 × (nh / nkv)` threads (`attn_kernel.rs:589-593`; the "192 threads" comment at `:218` is Qwen3.8's group 6) | **SILENT** | `TH_NO_ATTN_FUSED=1`, or template (G6) |
| GQA group, split verify attention | 6 | 256 threads per threadgroup (`attn_kernel.rs:1079-1081`), 4 per fused row of M = 8 × group rows (`:655-658`), so group ≤ 8; the guard at `:909` checks only `nh % nkv`, `d % 32`, `d ≤ 1024`; both tests use group 6 (`:1943-1966`) | **SILENT** for group 9–15 once ≥ 256 keys are visible (rows ≥ 64 are never soft-maxed); at group 16 the default f32-probability tile (`:91`) declares 33.5 KiB of threadgroup arrays (`:730-735`), over the 32 KiB limit [D], so expect a logged fallback | `TH_ATTN_SPLIT=0`; the group guard (G1); widen (G6) |
| fused prefill attention | head_dim 256, group ≤ 16 | `attn_kernel.rs:1613-1615` (guarded) | SLOW eager fallback | a kernel variant (G6) |
| quant scheme | affine 4-bit, group 64, no per-module overrides | `qwen35.rs:169` | LOUD, or SILENT if shapes happen to line up | QuantScheme (G6) |
| weight prefix | `language_model` | `qwen35.rs:3009` | LOUD | descriptor (G1) |
| `head_dim` absent from config | explicit 256 | serde default 256, `qwen35.rs:43-44, 65` | **SILENT** | descriptor: required field |
| layer schedule | `(i+1) % 4` | `qwen35.rs:100-102`; `layer_types` ignored | LOUD (tensor names differ) | descriptor |
| RoPE scaling | `rope_type: default`; the pack also carries `mrope_interleaved: true`, `mrope_section: [11, 11, 10]` (ignored; harmless for text positions [AUD C-04]) | only θ and partial factor read, `qwen35.rs:71-79` | **SILENT** past the base context | descriptor |
| gated attention / gated norm | `attn_output_gate` true, `output_gate_type` `swish` | assumed [AUD C-09]; the GDN norm is hard-coded `silu(z)` (`gdn_kernel.rs:430-443, 624-637`) | **SILENT** if the model changes them; the Qwen4 preview's is `sigmoid` (§12) | descriptor flags |
| RMSNorm weight convention | +1 already applied by the MLX converter | `qwen35.rs:8-9` | **SILENT** on raw `(1 + w)` checkpoints | descriptor |
| per-row add + RMSNorm width | 5120 | C ≤ 7936, `gdn_kernel.rs:2139` (fallback `:2207`) | SLOW (legacy kernel) for hidden ≥ 8192 | widen staging; a hyper-connection trunk needs a new op instead (§12) |
| model routing | `qwen3_5` | `model.rs:639`; `qwen3_5_moe` then fails on `mlp.gate_proj` (`qwen35.rs:3043-3049`) | LOUD | backend work (G4/G7) |
| process-global pipeline caches | one geometry per process | `gdn_step` / `gdn_lib`: `gdn_kernel.rs:671, 759-777, 2303-2330`; QMV/QMM/DEQ: `quant_kernel.rs:2571-2574` | **SILENT** once a second geometry (a drafter, an MTP head) shares the process | key them like `GeomCache` (`attn_kernel.rs:316`) |
| prefill core count | 40 | `pf_env` default, `quant_kernel.rs:5109-5112` (decode uses `gpu_cores()`, `quant_kernel.rs:61`) | SLOW on other GPUs | `TH_GPU_CORES=<n>`; fix in G0 |
| DFlash draft geometry | Qwen3.8-27B DFlash2 | `dflash.rs:30-52` | LOUD (section sizes) for any other target | DFlash descriptor (G5) |
| chat turn marks | ChatML | `engine.rs:482-496` | prefix cache falls back to grid splits | chat adapter (G1) |
| chat template source | `chat_template.jinja` | loads by HF id do not fetch it (`model.rs:464-469`) | silent ChatML fallback template | load from a local dir |
| tokenizer format | `tokenizer.json` | the only format loaded (`model.rs:466` by HF id, `:601` / `:714` from a dir); `--tokenizer` reaches only GGUF loads (`model.rs:431-438`) | LOUD for a SentencePiece-only (`tokenizer.model`) pack | convert it, or the G1 tokenizer adapter |

**Eager oracle.** `TH_GDN_EAGER=1 TH_NO_ATTN_FUSED=1 TH_QMM_SCALAR=1 TH_PREFILL_ATTN=eager` routes the hot ops to their reference paths [AUD §6, R12]. The eager GDN path was updated for G1a parity but never exercised on the real model [CG §5], so validate the oracle on Qwen3.8 first.

### 1.3 Build, unit tests, pipeline compile

```sh
BIN=$W/bin/th-engine-base-<sha>
(cd $WT/engine && cargo build --release && cargo test --release)          # 0 warnings; all pass
$P/bin/gpu-lock -- env TH_MPP_PROBE=1 $BIN probe --model x --tokens 1 2>&1 | grep -iE 'err|->'   # main.rs:234: expect no output
$P/bin/gpu-lock -- env TH_PF_COMPILE=1 $BIN probe --model x --tokens 1    # main.rs:190: prefill tile library; rc is the gate
```

- **What the two probes cover.** `TH_MPP_PROBE` compiles the Q4 MPP library only (`MPP_SRC`: `ALL_MPP_KERNELS` plus the three prefill MPP functions, `quant_kernel.rs:2578-2644`), with no GPU work; it prints failures (`err`, `ERR`, or `lang 4.0 -> …` when Metal 4 is missing, `quant_kernel.rs:2605-2640`) and always exits 0, hence the grep. `TH_PF_COMPILE` fails with a non-zero exit.
- **The real compile gate is the first forwards.** Geometry-templated pipelines compile on first use with the model's dims: the GDN step (the first caller's HK/HV/DK/DV, `gdn_kernel.rs:759-777`) and keyed `gdn_pipe` (`:962`), attention prepare / decode (`GeomCache`, `attn_kernel.rs:316`), the split kernel (`render_split`, `:855-866`) and fused prefill attention (`:1613+`); only `qmvt_warm` (`quant_kernel.rs:3008`) and `pf_warm` (`:4786`) run at load, and a failure there is only a WARN (`qwen35.rs:2985-3006`). So run §1.4's `--dump` prefill, §1.5's 1450-token R0a (its verify forwards see ≥ 256 keys and take the split route) and §1.6's served run with the draft under `MTL_SHADER_VALIDATION=1`, and count any `[attn] … unsupported` / `unavailable` line or `compile failed` WARN as a failed route: those fallbacks are logged, not fatal (`attn_kernel.rs:910-921, 1633-1640`). GENERALISATION-PLAN G1 adds `th-engine inspect --compile` to do this without weights.

- The unit suite grew 10 → 24 → 37 → 78 → 92 tests over the program [B §3.1, §3.4; C §4; D §4.1; E §4.1]. Every bitwise test must fail under a one-ulp mutation [DG §3].
- `MPP_SRC` compiles once per process [K45 §1]; `pf_warm` builds 26 pipelines and runs the cooperative-tensor layout probes at load, and an unprobed or failing shape never routes to the vector tile [EG §5].

### 1.4 Reference outputs and logits parity

```sh
# prompt ids through th's own chat rendering; no model load, no GPU, so no lock (main.rs:166-184)
TH_TOKENIZE=$W/ids/p1450long.txt $BIN probe --model "$TGT" --tokens 1 > $W/ids/p1450long.ids
# th last-prefill-position logits (f32 little-endian)
$P/bin/gpu-lock -- $BIN probe --model "$TGT" --tokens "$(cat $W/ids/p1450long.ids)" --dump $W/logs/p1450long.th.f32
# the same through the eager oracle (for SILENT suspects)
$P/bin/gpu-lock -- env TH_GDN_EAGER=1 TH_NO_ATTN_FUSED=1 TH_QMM_SCALAR=1 TH_PREFILL_ATTN=eager \
  $BIN probe --model "$TGT" --tokens "$(cat $W/ids/p1450long.ids)" --dump $W/logs/p1450long.eager.f32
# th's own plan-dependent noise floor, eager vs fused, in 512-row chunks (main.rs:874)
$P/bin/gpu-lock -- env TH_BENCH_PREFILL_LOGITS=512,1450,4096,7900 TH_BENCH_PREFILL_IDS=$W/ids/passage8k.ids \
  $BIN probe --model "$TGT" --tokens <3 ids>
```

- **References.** mlx-lm on the exact quantized pack is the quantized truth, because th loads mlx-lm packs (`$TGT` is `mlx-community/Qwen3.8-27B-4bit` [K45 §6]); transformers in bf16 is the semantic truth [LAND §5, Day 0].
- **Pass.** Argmax equal; top-10 10/10; max|Δ| (in bf16 ulp) and KL no worse than th's own tail-chunk noise floor for the same prompt. Qwen3.8 reference points: fused vs eager max|Δ| 0.16–0.50, KL ≤ 1.2e-3, floor 0.13–0.41 [E §4.2]. An absolute 0.05-logit target is unreachable, since one bf16 ulp is 0.125 at |logit| 16–32 [EA §0].
- **Quant quality.** Top-1 agreement and KL of the pack against bf16 on a mixed corpus. MTPLX's 4-bit dynamic pack reads 96.0 % / KL 0.012 (`X: README.md:106`).

### 1.5 State-bitwise rollback gate (R0a)

```sh
for env in "TH_BATCH=2" "TH_BATCH=1" "TH_BATCH=2 TH_ATTN_SPLIT_MIN=1"; do
  $P/bin/gpu-lock -- env TH_TEST_ROLLBACK=1 $env $BIN probe --model "$TGT" --tokens "$IDS18"; echo "rc=$?"   # 0
done
$P/bin/gpu-lock -- env TH_TEST_ROLLBACK=1 TH_BATCH=2 $BIN probe --model "$TGT" --tokens "$IDS1450"; echo "rc=$?"  # 0
$P/bin/gpu-lock -- env TH_TEST_ROLLBACK=1 TH_BATCH=2 TH_GDN_COMMIT=step $BIN probe --model "$TGT" --tokens "$IDS18"; echo "rc=$?"  # 1
```

- **What it proves.** After a partial accept, every recurrent-state element equals a forward of the kept rows, bit for bit; slots are isolated (`qwen35.rs:5427` `rollback_state_check`, `:5541` `slot_isolation_check`; probe at `main.rs:245`) [CG §3]. The exit code is the gate.
- **Discrimination.** `TH_GDN_COMMIT=step` restores the pre-G1a rollback and must exit 1. On the pre-G1a code the gate found 1.3M–6.3M of 37.7M elements differing in all 48 layers [CG §0].
- **Known artefact.** At long prompts the legacy-logits line prints FAIL on every build, because it compares argmaxes at two different positions (`main.rs:408-417`) [E §3; EA §5].
- **Limit.** R0a checks the state machine against a *fused* kept-row scan, not the kernel math; pair it with the eager oracle [AUD G-13]. A model with a new state kind (QSA ring, n-gram conv state, sliding-window KV, MTP cache) needs the gate extended first (GENERALISATION-PLAN, StateSpec) [LAND §4.6 G14].

### 1.6 Shader validation and the memory guard

```sh
MTL_SHADER_VALIDATION=1 MTL_SHADER_VALIDATION_REPORT_TO_STDERR=1 \
  $BIN serve --model "$TGT" --draft "$DRAFT" --port $PORT     # then drive the new paths; expect 0 "Invalid device load"
```

- MEM-1 (a 2 MiB read from a 64 KiB tensor) produced 157 reports, although the output compare missed it [B §2.1]. `MTL_DEBUG_LAYER=1` aborted on an `int3` vs `[i32;3]` argument mismatch [B §2.4].
- Watch phys_footprint (`proc_pid_rusage`), never RSS: RSS read 4.2 GB at a 119 GB footprint [DL §6.1]. Guard at 48 or 64 GB. Keep in-model probes at ≤ 7.9k keys: a 32k in-process probe rebooted the 128 GB machine at 130.9 GB resident [DL §6.1].

### 1.7 Server smokes

Run the Stage 7 suite (§8.3) against the single baseline binary. The minimum set: `TH_BATCH=2 --draft TH_SAMPLE=check` (T=0, sampled and mixed pairs); `TH_BATCH=4 --draft` plus `POST /engine/kv/clear`; single-slot `TH_SAMPLE=check`; `--kv-quant --draft`; no draft, single slot and `TH_BATCH=2` (exactly one WARN); prefix cache on / `=miss` / `=0` over the 43-request `spec_a3`; `/status` key-path diff; a streamed CJK prompt with 0 U+FFFD [E §4.1; U1].

**Product contract** (on the lane's port; never `:8001`):
- `/status` carries `instance.model` and `instance.pid` (both app clients drop a payload without `instance`: `clients/macos/Sources/TokenHorizon/Engine/EngineSupervisor.swift:262`, `daemons/go/internal/engine/supervisor.go:161, 174`) and what the ENGINE tab shows: `maximum_context_tokens`, `metrics.decode_tps`, `rss_bytes`, `requests.completed` (`UI/EngineTab.swift:115-128`). The Go daemon forwards the whole payload in `GET /engine` (`supervisor.go:254-266`), so diff every key path.
- The model is servable from the product. Today that works only with an explicit spec, `POST :8765/engine/serve {"backend":"thengine","model":"<id or dir>"}` (`Server/LocalServer.swift:266-280`), and DFlash attaches only to model specs containing `qwen3.8` and `27` (`EngineSupervisor.swift:49-55`). The ENGINE tab offers only the three GGUF catalog rows (`EngineTab.swift:265-305`; `Engine/THEngineCatalog.swift:26-42`), and the Go daemon mirrors them (`daemons/go/internal/engine/catalog.go:39-48`) and never passes `--draft` (`supervisor.go:59-67`). Until GENERALISATION-PLAN G8a adds the model to both clients, record it as a gap.
- Serving it from the ENGINE tab on `:8001` is the maintainer's landing step (§9.3).

### 1.8 Identity baseline

- Record, per (mode, prompt, iteration, seed): the T=0 emitted id stream and the text sha, with `</think>` stripped (th streams it as content, Splash drops it) [BQ §5.2].
- Every build must be text-identical across its own arms (integration-4: 59/59 request groups [E §1.6]).
- Expect near-ties: 1.68 % of token-deciding T=0 rows on Qwen3.8 had an exact bf16 top-1 tie [B §2.1]. A divergence that recurs at the same positions across builds is a near-tie flip, not a bug [CAT §4.6].

### 1.9 Stage 1 exit

| gate | pass |
|---|---|
| geometry pre-flight (§1.2) | every row passes or is routed to eager with a guard |
| build and unit suite | 0 warnings; all pass; mutation-checked |
| compile (§1.3) | `TH_MPP_PROBE` no `err` / `->` line; `TH_PF_COMPILE` rc 0; the first forwards log no `[attn] … unsupported` / `unavailable` line or `compile failed` WARN |
| logits parity (§1.4) | inside th's noise floor; argmax and top-10 equal |
| R0a (§1.5) | rc 0 on every variant; the `step` arm rc 1 |
| shader validation | 0 reports |
| server smokes (§1.7) | all HTTP 200; 0 panic / ERROR; `TH_SAMPLE=check` 0 mismatches; hit == miss 42/42 · 42/42 |
| identity baseline | golden id streams recorded; each arm deterministic |
| product contract (§1.7) | consumed `/status` keys present; a serve path with the draft in both clients, or the G8a gap recorded |

---

## 2. Stage 2: floors and the first baseline

### 2.1 Decode floors

| floor | definition | Qwen3.8 value | how to get it for a new model |
|---|---|---|---|
| **F_bw** | bytes streamed per verify round ÷ measured bandwidth | 29.8 ms/round [B §1.1]; its inputs are lost (below) | sum the bytes one round reads (weights, lm_head, draft, recurrent state, K/V); say which bandwidth figure you divide by |
| **verify matmul fit** | Σ over projection classes of calls × best µs per call | ≈30.9 ms/round = gate_up 188.5 µs × 64, down 125.3 × 64, in_all 103.7 × 48, out 41.6 × 48, in_qkv 99.1 × 16, o 54.6 × 16, lm_head 1347 × 1 [B §4.2] | `TH_BENCH_Q4=1` in serial mode, one row per class |
| **F_k** | every matmul at its measured fit, zero overhead | ≈36 ms/round [B §1.1, §4.3] | fit plus the non-matmul minimum; the derivation lived in a synthesis document that is not in the repo [CAT §3.1], so recompute it |
| **draft floor** | draft bytes streamed ÷ bandwidth | ≈2.93 ms for 1.65 GB [B §4.2] | from the drafter's weights and the rows it runs |

- **Bandwidth figures.** The program brief gives ≈565 GB/s measured on this machine; the reports themselves do not record it. The best Q4 kernels reach 530–535 GB/s [K45 §5.2], and MTPLX quotes a 614 GB/s bus for the chip (`X: mtplx/kernels/ternary_qmv.py:9`). Record which one a floor uses.
- **F_bw arithmetic.** The synthesis that computed 29.8 ms is not in the repo [B §1.1]. From the per-class bytes below: 100.3 × 64 + 50.1 × 64 + 47.5 × 48 + 17.7 × 48 + 41.3 × 16 + 17.7 × 16 + 715 ≈ 14.41 GB of weights per verify forward, 16.06 GB with the 1.65 GB draft [K45 §3.1; B §4.2] [D]. 29.8 ms then implies ≈539 GB/s with the draft or ≈484 GB/s without it, [B]'s draft floor (1.65 GB in 2.93 ms) implies ≈563 GB/s, and the ≥ 0.3 GB of recurrent-state reads and writes per round (151 MB each way) is in neither sum [D]. The surviving figures do not pin one basis: compute a new model's F_bw from scratch (the G0 floors tool) and state its bytes and bandwidth.
- **Per-class bytes on Qwen3.8** (useful to sanity-check a new model's table): gate_up 100.3 MB, down 50.1 MB, in_all 47.5 MB, out 17.7 MB, in_qkv 41.3 MB, o 17.7 MB, lm_head 715 MB per call [K45 §3.1].
- **Per-dispatch ramp.** ≈8 µs; together with 65 or 80 threadgroups on 40 cores it kept `in_all` and `down` below the 480 GB/s target, which the reports called a fusion problem rather than a tile problem [K45 §3.1, §8].
- **MoE.** Bytes per round depend on the *union* of experts the verify rows touch, so compute F_bw per verify width [LAND §5, Day 2] [I].
- **Gap to F_k over the program:** 18.5 ms (B) → ≈11.2 ms (C) → ≈3.5 ms (D, E) [B §4.3; C §6.1; D §1.2; E §6.2]. Use it as the headroom estimate for GPU-side work.

### 2.2 Prefill floor

Add three parts [LAND §5, Day 2]:

- GEMM FLOPs ÷ the measured MMA-only ceiling (int4 × bf16: 61–65 TFLOPS [EG §3]; the vector tile reaches 91 % of it [EG §0]);
- attention FLOPs ÷ the fused-attention rate (≈11–12 TFLOPS effective at 512:7168 [EA §6]);
- the sequential GDN scan (145 ms at 1.45k, 750 ms at 7.9k on Qwen3.8 [EG §2]).

In situ the GEMMs ran at ≈70–75 % of the isolated rate [EG §10]. A new quant format needs its own MMA-ceiling measurement before any prefill floor means anything [LAND §4.5].

### 2.3 In-process probes

| probe | command | answers | Qwen3.8 reference |
|---|---|---|---|
| verify-width ladder | `TH_BENCH_MULTI=8,7,6,5,4,3,2,1 TH_BENCH_MULTI_ITERS=5 th-engine probe --model $TGT --tokens $IDS` (`main.rs:451`) | the whole-forward cost per verify width; whether "verify all" (L1) transfers | fwd8 39.70, fwd7 40.00, fwd6 40.20, fwd5 40.20, fwd4 40.80, fwd3 40.60, fwd2 41.50 ms: m = 8 was the cheapest [CL §3] |
| per-class kernel rate | `TH_BENCH_Q4=1 [TH_BENCH_Q4_M=5]` (`main.rs:440`; serial by default, a buffer barrier after every call) | µs and GB/s per projection class against ≥ 480 GB/s | gate_up 532–535 GB/s; in_all 457–460; down 444 plain / 400 PreSums [K45 §5.2] |
| decode tile sweep | `TH_BENCH_Q4=1 TH_BENCH_Q4_SWEEP=1` (`qwen35.rs:917`) | tiles × presum × persistent-group counts per shape | the existing policies won every shape except the unfused draft gate/up (N256 sg8, 122.3 vs 137.0 µs) [K45 §3.2] |
| numerics per class | `TH_BENCH_LIN=1\|dec\|pf` (`main.rs:427`) | max\|Δ\| vs a scalar reference | its timing is not a signal: A/A band 0.73–1.40 [U1] |
| prefill forward | `TH_GPU_PROF=1 TH_BENCH_PREFILL=512,896,1415 [TH_BENCH_PREFILL_LARGE_ONLY=1]` (`main.rs:492`) | whole-forward GPU-busy ms per routing | GPU-busy timing, because host-timed sweeps drifted ±40 % [EG §2] |
| chunk size | `TH_GPU_PROF=1 TH_BENCH_STEPS=512,256,1024` (`main.rs:550`) | prefill chunk-size A/B in one process | keep 512 (1024 was +8–12 %) until fused attention; re-run after [EG §7] |

### 2.4 First quiet baseline against the best competitor

Run it under the Stage 3 protocol. Choose in this order [LAND §5, Day 2]: Splash if it ships a package for the model; else MTPLX (native MTP heads, day-0 ports: `X: HISTORY.md:46, 48`); mlx-lm as the autoregressive baseline; llama.cpp with `--mtp` (`X: HISTORY.md:36, 42`). **Against a non-Splash competitor the standing is client wall tok/s on identical requests, measured the same way for th; the per-round × tokens/round split is reported for th alone** unless the competitor exposes a verified per-verify count (§3.1 adapters). Report per mode:

- loop tok/s and like-for-like tok/s, split as per-round ratio × tokens/round ratio [E §0];
- tokens/round on byte-identical text;
- TTFT classes and peak phys_footprint;
- a conditions table (§10).

Note the competitor's own prefix cache: Splash served 32–64 prompt tokens from cache even on the short bench prompts [BQ §4.1].

### 2.5 Attribute the gap three ways

1. **Host idle** = client decode-wall slope − ioreg GPU-busy slope [BQ §2]. On th this is a lower bound (overlapping command buffers are double-counted; idle once went negative) [B §4.2; C §1.1].
2. **GPU work above F_k.** Round phases from `TH_DEBUG_TIMING=1` (`engine.rs:300-304`; the `[dflash]` line at `engine.rs:1137-1141`): propose, verify host encode (= `[verify] enqueue` − propose), verify GPU tail + readback, rest [C §1.5]. Per-region GPU ms from R0c: `TH_GPU_PROF=1 [TH_GPU_PROF_EVERY=1] [CANDLE_METAL_COMPUTE_PER_BUFFER=1]` (`gpuprof.rs:305`; armed at `main.rs:109-110`). With one dispatch per command buffer it adds ≈5 µs per buffer and its profiled arm ran 9.3 ms/round slower, so use it to *rank*, never to sum savings [DG §2, §4].
3. **Tokens/round** on byte-identical greedy text (rounds = th logged + 1; Splash `decode_batches`; other engines per §3.1) [C §1.6].

On Qwen3.8 the first attribution found about 90 % of the ms/round gap was GPU idle while the host worked [B §1.1]: the structural fixes came before the kernel ones (§4.4).

---

## 3. Stage 3: the measurement protocol

Almost every wrong conclusion the reports caught was a protocol failure, not a code failure [CAT §4]. Use this recipe for every A/B, including the Stage 2 baseline.

### 3.1 Metric definitions

| metric | definition | source |
|---|---|---|
| loop tok/s | Σ emitted tokens ÷ Σ round-ms over the logged `[dflash]` rounds; excludes the prefill-sampled first token and the final unlogged round. Splash: `decode_output_tokens / decode_wall_ms` from `/status` deltas. | [C header; B §0] |
| ms/round, tokens/round | from the same sums | [BQ §2] |
| like-for-like tok/s | [Σ(completion − 1) ÷ Σ rounds_all] ÷ ms/round; removes Splash's prefill-sampled token; moves ratios by ≤ 0.01 | [BQ §2] |
| standing | per mode: per-round ratio × tokens/round ratio (e.g. 1.203 = 1.199 × 1.004) | [E §0] |
| TTFT | client time to the first streamed content or reasoning delta; engine TTFT splits into host enqueue and rest | [BQ §2; D §1.5] |
| first-token gap | 1st → 2nd streamed delta (Splash streams both together, so it does not compare across engines) | [E §1.4] |
| memory | peak phys_footprint minus the pre-request footprint | [E §1.5] |
| modes | greedy T=0; sampled (temperature 0.6, top_p 0.95, top_k 20, seeds 1/3/5, all sent explicitly); ctx1500 (warm prefix); ctxcold (nonce, cold prefix); ctx8k | [E §1.1] |

**Competitor adapters.** The loop tok/s, rounds and standing definitions above are Splash's. For other engines:

| competitor | tok/s source | rounds | comparable with th |
|---|---|---|---|
| Splash | `/status` deltas: `decode_output_tokens / decode_wall_ms` [E header] | `decode_batches` [BQ §2] | loop and like-for-like tok/s, ms/round, tokens/round on identical text, the per-round × tokens/round standing |
| MTPLX | per-request records at `GET /metrics` (`latest`, `recent`): `decode_tok_s`, `decode_elapsed_s`, `completion_tokens` (`X: mtplx/server/openai.py:32001-32008, 16603-16619`) | `verify_calls` beside `mtp_depth`, `accepted_drafts`, `drafted_tokens` (`openai.py:16632-16640`): one target verify per depth-k MTP round | client wall tok/s always; tokens per verify only after checking on the pinned version that `verify_calls` counts one target forward per round [I] |
| mlx-lm (autoregressive) | client wall clock; no engine counter assumed [I] | none: one token per forward | client wall tok/s |
| llama.cpp | client wall clock; server timing fields only after checking them on the pinned build [I] | only with `--mtp` | client wall tok/s; tokens/round only if the build exposes a verify count |

Client wall tok/s is the harness's `client dec tok/s` = Σ(completion − 1) ÷ Σ(request total − TTFT), its "like-for-like client view (identical for both engines)" (`.worktrees/_phaseC/work/th-d-longctx/bench/analyze.py:11-12`; a column of [BQ §4.1]), on byte-identical requests with explicit sampling parameters.

Always use ratio of sums. The stock `bench-engines.sh` "decode" figure overstated every engine (th 39.2 vs 33.0 measured; Splash 76.7 vs 63.8) [Bb caveat 3; B §1.1].

### 3.2 Session recipe

**Setup**

1. Build in a worktree; freeze each binary, record its sha256, `cmp` it against the worktree build [BQ §1].
2. Take **one** `gpu-lock` hold for the whole session [BQ §2].
3. Use a private port; start Splash only on a free `:8000` and only while no th server is up [Bb].

**Arms**

4. Order the arms as a **palindrome**, so every engine has one arm in each half, e.g. `new base splash old | old splash base new` [E §1.1].
5. Start a **fresh server per arm**: `env -u TH_BATCH TH_DEBUG_TIMING=1 th-engine serve --model $TGT --draft $DRAFT --port $PORT` [BQ §1].
6. Send two unrecorded warm-ups: a short prompt, then passage + "Say hi." (this primes the caching engines) [BQ §2; D §1.1].
7. **Suite per arm** [BQ §2; D §1.1; E §1.1]:
   - greedy: 3 bench prompts (short / code / long = 58 / 68 / 80 prompt tokens) × 3, max_tokens 128;
   - sampled: the 3 prompts × seeds 1/3/5;
   - ctx1500: the 1373-token passage (sha1 `a886db14acc4`) + prompt, a warm hit on caching engines;
   - ctxcold: a unique nonce `Note k.` + passage + prompt;
   - ctx8k: `passage8k.txt` (sha1 `6ab8ad9a056a`, 7853 tokens) + prompt;
   - a TTFT block: cold 1.45k with nonces, exact repeats, another question after the same document, cold 7.9k, multi-turn turns 1–3, max_tokens 16.

**Recording**

8. Per request, outside the timed window: server-log byte offsets, the competitor's `/status` deltas, ioreg GPU ns and `ps` CPU time of the engine pid, load1 and thermal level [BQ §2].
9. For the whole session: `top -l 0 -s 3`, a thermal loop, IOReport P-states (`gpufreq.py`), per-arm GPU time of other clients (`gpuq.py`), and a phys_footprint guard (64 GB) [D §1.1; E §1.1].

**Cleanup**

10. th servers: SIGTERM, then KILL, then a port check. Splash: SIGINT, then TERM/KILL of every descendant including `serve-native`. Release the lock [C App. B; E App. B].

### 3.3 Gating and redo rules

| session | gate before each arm | redo rule | source |
|---|---|---|---|
| bench-quiet | thermal level 0 (`notifyutil -g com.apple.system.thermalpressurelevel`); CPU idle ≥ 85 %; other GPU clients ≤ 60 ms/s | — | [BQ §2] |
| gpu-tail quiet re-measure | thermal 0 **and** load1 < 5, both held 30 s | redo if > 10 % of requests start at load1 ≥ 8, any at ≥ 12, > 10 % at thermal ≥ 2, or any error; keep dirty attempts under `attempts/` | [DG R3] |
| Phase D final | thermal 0 + load1 < 6 held 30 s (≤ 300 s; first arm ≤ 900 s) → "pass"; else thermal 0 + load1 < 9 held 30 s (≤ 600 s more) → "pass2"; else "soft" | redo on > 10 % of requests at thermal ≥ 2, > 25 % at load1 ≥ 12, any at ≥ 18, or any error | [D §1.1] |
| Phase E final (a noisier machine) | tier 1: thermal 0 + load1 < 12 held 30 s; tier 2: thermal ≤ 1 + load1 < 25 + CPU idle ≥ 25 % held 30 s (≤ 7 min); else "soft" | one attempt per arm, redo only on errors | [E §1.1] |

- **8k requests** wait outside the timed window (≤ 240 s) for thermal ≤ 1 (Phase E) or 0 (Phase D): cold 8k prefills heat the SoC to level 2 within one request [D §1.1; E §1.1].
- **`gpu-lock-quiet`** takes the lock only after load1 has stayed below a threshold, so the lock is never held idle behind a gate on a noisy machine [DG R2].
- **Run TTFT requests back to back.** Under swap, idle gaps let the compressor page the model out: a 3 s gap produced a "+313 ms first-token gap" that was later withdrawn [ET §0].
- **The standing comes from the quiet replicate**; a loaded replicate is only a cross-check [E §0].

### 3.4 Estimators and statistics

- **Ratio of sums over pooled arms**, then a per-arm drift check. In Phase D each engine's two arms agreed to 0.1–0.7 % on ms/round [D §1.1].
- **In-process probes on a loaded machine:** use `min`. `TH_BENCH_ROUND` reports the median over processes of each process's min [DL §1.1, §4.3].
- **TTFT:** pair samples by position (arm k of each label, same request position) and bootstrap. The first cold request of an arm is the fastest [ET §3.2; EG §9.5].
- **Tokens/round and loop tok/s:** prompt-cluster bootstrap with B = 5000 [DS §8.3].
- **Keep a T=0 control on unchanged code inside the same arms.** It bounds arm-to-arm noise (±3–5 % at load 11–27) [DS §8.3].
- **Acceptance** is compared on identical text, or with Rao-Blackwellised E[accepted | block] on the same drafted blocks (`TH_ACCEPT_STATS=1`, `engine.rs:1713`) [DS §2]. Nine fixed sampled streams are not evidence: Phase C's 0.894× sampled acceptance gap read 1.002× over 15 prompts × 5 seeds [C §1.6; DS §2].

### 3.5 Identity accounting

- Normalise (`</think>` stripped) and report the first divergence as a character index plus a re-tokenized token index [BQ §2].
- **Near-tie class on the Qwen3.8 suite:** code prompt emitted id 22 ("Need produce / provide"); ctxcold code @113, long @14 and @52; ctx8k code @29/30 [E §1.6; D §1.3]. A new model has its own near-ties: record them in the baseline.
- **Server identity unit:** 42/42 texts · 42/42 per-round `[dflash]` logs over the 43-request `spec_a3` (e.g. `cmp_arms.py <dir> pc_miss pc_on`) [DP §3.3; E §4.1].
- **Batched identity** needs identical batch composition: different Σ rows take different kernels [B §2.2; RI].

### 3.6 What contamination does

| effect | observed | source |
|---|---|---|
| CPU load on a host-bound loop | 63.1 → 104.5 ms/round (load 2.3–3.5 → 26–49); GPU-busy also rose 55.9 → 63.0 | [B §1.2] |
| CPU load once the loop is GPU-bound | +5–14 % ms/round in sampled / ctx modes at load1 ≈45–49, all host-side | [E §1.1] |
| GPU contention | moves the GPU tail: 39.2 vs 33.0 ms at equal load1 | [E §1.1] |
| thermal throttling | Splash −11 %, th −3 %, so th/Splash read ≈8 % high | [BQ §0] |
| loaded lane A/B | ×1.301 loaded vs ×1.194 quiet; the loaded base arm was 45 % inflated | [DG §0, R3] |
| swap and idle paging | a paged-out engine took 90.6 s for a cold 8k; 3 s idle gaps produced a "+313 ms first-token gap" that was withdrawn | [ET §0, §3.2] |
| shader cache keyed per binary path | a never-run path recompiles every kernel on its first request | [T2 §Measurements] |
| sequential sweeps / separate processes | identical kernels drifted up to 2×; one forward drifted up to 30 % across processes | [T2 §Measurements] |
| per-arm spread of one binary | ±7 % (prefill-gemm host), ±8 % (Phase E S1), ±3–5 % (Phase E S2) | [EG §0; E §1.1] |

### 3.7 What decides policy

- **The in-situ forward decides; the kernel bench does not.** `TH_BENCH_Q4` mis-ranked the N256 PreSums tiles by 27–28 %; Depth-4 pipelining won 3–4 % in the bench and lost 0.4–6 ms in situ [K45 §3.1, §4]. Decide with `TH_BENCH_MULTI` (env arms of one binary, interleaved) and then the server A/B [K45 §2].
- **Report "moved" separately from "removed".** Deferred checkpoint builds moved ≈46 ms at 7.9k into the first-token gap [ET §3.4]; the KV-capacity prefill saved ≈11 ms of decode per request and cost ≈90–100 ms of TTFT [D §1.5].
- **Every claim needs a long-context and a sampled arm.** Short-context greedy alone hid N3/N4 and the sampled `rest` cost [BQ §4.4; C §1.5].

---

## 4. Stage 4: lever triage

### 4.1 Symptom → lever family

Read the Stage 2 attribution and start with the largest bucket. The family IDs are those of [CAT §5], which has a full card (mechanism, detection signal, gates, pitfalls, code anchors) for each.

| what the measurement shows | look at |
|---|---|
| idle (round − GPU-busy) above ~1 ms; propose or host encode dominate; ms/round moves with CPU load | L02 host idle and sync count, L03 allocation |
| many blit fills or blit encoders per round; host encode grows after syncs | L03, L04 dispatch count and command buffers |
| a decode matmul class far below ≈480 GB/s; prefill GEMM TFLOPS far below the MMA ceiling | L05 quant tiles, L06 producer-emitted sums and fusion, L13 prefill tiles |
| the round grows with context (propose and/or verify GPU tail) | L09 split-key decode attention, L07a draft attention |
| tokens/round below the reference on byte-identical text; capped chains | L07b acceptance and verify length |
| the sampled round costs more than the greedy one (`rest` phase) | L07c GPU accept, L16 sampling paths |
| snapshot or rollback host time; state-bitwise mismatches | L08 state snapshot and rollback |
| cold TTFT dominated by `attn.core` / Q4 GEMMs / `gdn.core` | L10 / L13 / L12 |
| repeated prefixes pay the full prefill | L14 prefix cache |
| cold TTFT regressed after a "decode-side" change | L11 KV layout, L17 TTFT |
| phys_footprint spikes on long prompts | L18 memory transients |
| arms of one binary disagree with each other | L19 thermal and DVFS; §3.3 |

Source: [CAT §0.2].

### 4.2 Expected ms/round per effort

Rank candidate levers by **expected gain ÷ effort** [I]:

1. **Expected gain.** Take the *measured excess* in the bucket the lever attacks (from §2.5), and scale it by what the Qwen3.8 precedent recovered of the same bucket (the table below). Tokens/round gains convert exactly: loop tok/s = tokens/round ÷ ms/round, so a fractional tokens/round gain *x* is worth the same as cutting ms/round by *x* / (1 + *x*) [D].
2. **Effort.** Use the size classes of [AUD §5] (estimates: S ≤ 1 day, M 2–5 days, L 1–3 weeks, XL > 3 weeks), informed by the lane precedent's size below.
3. **Transfer grade** [CAT §5.1]: **A** engine mechanics, transfers as-is; **S** transfers after re-tuning; **X** architecture- or draft-specific, rebuild it. Discount S and X levers until the new model's own probe confirms the bucket.

| bucket (measure it on the new model) | Qwen3.8 excess when attacked | lever(s) | recovered on Qwen3.8 [M] | lane precedent | grade |
|---|---|---|---|---|---|
| host idle (round − GPU slope) | 7.1 ms/round [C §1.5] | G1a parity state; D1 one propose sync | idle 7.1 → 1.3 ms/round; G1a −6.35, D1 −0.91 ms/round [C §0] | G1a: 2 commits, +1076/−480 lines [CG §1]; D1: 1 commit [CL §1] | A (G1a is X per state kind) |
| verify GPU tail above the matmul fit | ≈7.5 ms over the ≈30.9 ms fit [C §6.1] | per-row add+RMSNorm, GDN step widths, one-dispatch commit, draft select / ring / presum | −7.71 ms/round T=0 quiet, ≈7.1 ms of it verify-forward GPU work [DG R3] | 15 commits, 8 files, +2948/−203 [DG §1] | A method, S kernels |
| matmul classes below target GB/s | fwd8 47.00 ms on main [B §3.1] | K1 / P0 / K2 / K45 decode tiles and presum blocks | fwd8 −6.75 ms; e2e T=0 −12.0 % ms/round [B §3.1] | 9 commits [B §3.1] | S (X for a new quant) |
| propose above the draft floor | 6.2 ms vs ≈2.9 ms floor [C §6.1] | D1, MEM-4, draft presum / select / ring | propose 6.2 → 5.78 ms [C §1.5; D §1.2] | spread over lanes | X (draft-specific) |
| context growth of the round | +14.3 ms at ≈1.45k vs Splash +1.1 [C §0] | N3 split-key decode attention; N4 split draft attention | growth to 7.9k +2.9 ms (Splash +2.7); ctx8k 108.62 → 42.41 ms/round together with the GPU-tail kernels [D §0, §1.2] | 7 commits [D §4] | S |
| sampled round − greedy round | +2.3 ms [C §1.5] | S1 GPU accept (+ B1 block verification) | +0.43 ms; −2.96 ms/round in-binary [D §1.2] | 6 commits [D §4] | A |
| tokens/round deficit on identical text | 163 vs 147 rounds; 21 % of rounds capped [BQ §4.3] | L1 verify all 7 | +12.5 % tokens/round on 15 prompts [CL §3]; 151 vs 147 rounds after [C §1.6] | 1 policy commit [CL §1] | A rule, X quality |
| cold TTFT | 2530 vs 1835 ms at 1.45k [D §1.4] | fused prefill attention; vector-epilogue GEMM tile; TTFT-regression fixes | 1659 vs 1647 ms, quiet [E §1.4] | 3 + 5 + 10 commits [E §4] | S / X |
| repeated-prefix TTFT | 2451 vs 143 ms with no prefix cache [C §6.2] | T1 prefix cache, then full (restore-only) checkpoints | 1.4k repeat 139 / 146 ms [D §1.4]; exact repeats 24 / 22 ms [E §0] | 21 commits [D §3] | A framework, X checkpoint content |
| long-prompt memory transient | cold 7.9k peak 47.2 GB on main [E §1.5] | one causal mask per forward, pool trim, fused attention | 27.9 GB [E §1.5] | inside the longctx and prefill-attn lanes | A |

### 4.3 Calibrating the estimates

Estimates written before a lane ran, against what the lane then measured:

| lever | estimate (before) | measured (after) | source |
|---|---|---|---|
| G1a parity state | −7.8 to −10.2 ms/round [E] | −6.35 ms/round | [B §5.2; CG §0] |
| L1 verify all 7 | +8 to +11 % tokens/round [E] | +12.5 % (15-prompt set); +8.3 % on identical text in the Phase C session | [B §4.3; CL §3; C §2.4] |
| everything delivered in B, plus L1 | ≈70–73 tok/s T=0 [E] | 81.49 tok/s (G1a was not in the estimate) | [B §4.3; C §1.4] |
| N3 + N4 at ≈1.45k | ≈61.4 → ≈50–52 ms/round [E] | ctx1500 62.6 → 49.75 ms/round (lane) | [C §6.2; D §2.1] |
| S1 GPU accept | ≈−2 ms/round sampled [E] | −2.96 ms/round in-binary | [C §6.2; D §1.2] |
| short-context GPU-tail work | ≈1.5–3 ms/round [E] | −7.71 ms/round quiet; the loaded claim of −15.84 was withdrawn | [C §6.2; DG §0, R3] |
| fused prefill attention | cold 1.45k ≈ −0.46 s, 8k ≈ −50 % [E] | −0.32 s (−11.8 %) and −39 %; the estimate assumed 545 ms of eager attention at 1.45k, the build had ≈360 ms | [D §6.2; EA §0] |
| cold-TTFT regression fix | ≈110–140 ms below old main [E] | −110 to −137 ms vs old main's clean arms | [D §1.5; E §2.3] |

Lesson [I]: estimates got the order of magnitude and missed in both directions, once by a factor of several. The only answer is the quiet in-situ A/B, and a loaded A/B can overstate by about 2× in the other direction [DG R3].

### 4.4 Default order (what paid on Qwen3.8)

Use it as a prior, not a plan; the new model's own buckets decide [LAND §5, Day 6–N].

1. Host idle and syncs: G1a −6.35 ms/round; D1 took syncs from 6 to 2 per round [C §2].
2. Verify width: L1 +12.5 % tokens/round [CL §3].
3. Kernel fit for the new shapes: K1/K2/K45 −6.75 ms at fwd8 [B §3.1].
4. Long-context attention: context growth to 7.9k +2.9 ms vs +61.1 on main [D §0].
5. The sampled path on the GPU: −2.96 ms/round [D §1.2].
6. The prefix cache: repeated 1.4k prefix 139 / 146 ms vs 2546 ms on main [D §0].
7. Prefill attention, GEMM and GDN scan: cold 1.45k −456 ms vs integration-3 [E §0].
8. Memory: cold 7.9k peak 47.2 → 27.9 GB [E §0].

The largest early wins were structural. At the start th did only about 4 ms more GPU work per round than Splash; the rest of the gap was GPU idle [B §1.1].

---

## 5. Decision trees

### 5.1 Which speculative strategy

```
new model passes Stage 1
│
├─ Q1  MTP weights trained with THIS trunk present in the pack?
│      Check the tensors (mtp.* or a sidecar), not just the config: the Qwen3.8 MLX export
│      declares mtp_num_hidden_layers = 1 but ships 0 mtp.* tensors of the 2180 in its
│      safetensors index [AUD §4c].
│      yes → candidate: native MTP        (not in th today; GENERALISATION-PLAN G5)
├─ Q2  A trained external draft for THIS exact target?
│      A Splash package built for it: manifest upstream.target.repo_id == the target repo when
│      present (WARN on a revision mismatch), and always the geometry checks (codebook rows =
│      vocab, hidden size, capture layers < layer count) [AUD D-06].
│      yes → candidate: DFlash            (th parses only the Qwen3.8-27B DFlash2 geometry,
│                                          dflash.rs:30-52; any other needs G5's descriptor)
├─ Q3  An official assistant drafter (Gemma 4 style, reads the target KV)?
│      yes → candidate: assistant pair    (G5)
└─ always candidates: n-gram (--spec-tokens, qwen3_5 backends) and plain AR
        │
        ▼
  measure every candidate on the identical-text suite (T=0 and sampled; bench, 15-prompt set,
  1.45k, 8k), quiet protocol, and pick the best loop tok/s:
      loop tok/s   = tokens/round ÷ (propose + verify(width) + rest)
      tokens/round = 1 + Σ_k Π_{i≤k} a_i      (a_i = per-position acceptance)
        │
        ├─ width:  verify ladder flat (fwd8 ≤ fwd2)?  yes → verify every proposal (L1)
        │                                            no (e.g. MoE) → pick width from ladder × a_i
        ├─ depth (MTP): sweep per machine; keep a depth only if it beats AR
        ├─ concurrency: TH_BATCH > 1 needed?  today only with DFlash (engine.rs:113-124)
        └─ gates: T=0 text identical to plain decode (modulo near-ties); TH_SAMPLE=check 0
                  mismatches; R0a covering the drafter's state; many-seed acceptance with a CI
```

Evidence for the tree:

- **Acceptance profile.** Rao-Blackwellised per-position acceptance for Qwen3.8 + DFlash (sampled) fell from 0.806 at position 1 to 0.538 at position 7 [DS §2].
- **L1's premise** is written into the code: "verify at m ≤ 8 is weight-bandwidth bound, so rows 3..8 cost well under a millisecond" (`engine.rs:307-315`). It held on the 27B (fwd8 the cheapest shape [CL §3]); a MoE routes each verify row to its own experts, so re-measure it [AUD S-02] [I].
- **Draft provenance.** `upstream` is optional converter metadata: Splash's own validator never reads it (`S: runtime/model/ModelDescriptor.mm:135-300`) and its test fixture omits it (`S: dev/tests/test_models.py:90-108`). The program's own pair differs on revision: the installed manifest (`~/Library/Application Support/Splash/models/incoai/Qwen3.8-27B-Splash/manifest.json`, schema 3) declares target `mlx-community/Qwen3.8-27B-4bit` @`3e6447f0…`, while `$TGT` is snapshot `10c35ca…` [K45 §6]. So match the repo id, warn on the revision, never gate on it.
- **External data points** [ext] (H200, SGLang, Qwen3.8-27B, concurrency 1; web source W7 of [LAND §4.4], not vendored): built-in 7-token MTP 1.96–2.59× over AR, DFlash 2 2.67–3.43×; at concurrency 32 MTP fell to 0.77–1.04× while DFlash 2 stayed at 1.01–1.45×. MTPLX reports 2.24× over plain decoding on an M5 Max with the model's own MTP heads (`X: README.md:15`). Only relative conclusions transfer to Apple silicon, and none of these figures enters the tree: it decides on the new model's own measurements.
- **n-gram is not free but pays.** Plain decode on the K7 build ran 28.21 tok/s with n-gram spec 4 against 23.02 with `--spec-tokens 0` [B §3.1].
- **Batching was weak here.** B = 4 gave 72.4 tok/s aggregate vs 48.2 single-stream [B §2.2]; at nb ≥ 2 the draft MLP cost ≈930 µs per layer at 16 rows vs ≈300 µs at 8 [K45 §9.6].
- **Acceptance is workload-dependent.** Put an edit-heavy class beside fresh generation in the suite [LAND §7.2] [I].

### 5.2 Autotune, table, or rule

```
does the knob change output bits?
├─ no  → class A: grid / threadgroup shape, simdgroups per head, same-order pipelining, layout
│        keep the RULE as the default; tune offline per (shape set, GPU family, core count);
│        on an unknown GPU a first-load tune is allowed (opt-in) if a self-check follows;
│        promote only after an in-situ confirmation (TH_BENCH_MULTI / TH_BENCH_PREFILL)
├─ yes, distribution-preserving → class B: split-K vs sequential K, split counts, reduction
│        trees, intermediate precision, fused vs unfused rounding
│        OFFLINE ONLY; promote only with an identity re-baseline + first-divergence report,
│        logits inside the noise floor, and a many-seed acceptance A/B
└─ policy → class C: verify width, speculative depth, chunk plan, prefix plan, sampling-rule
         eligibility; tune per model (depth also per machine); gate on end-to-end loop tok/s,
         acceptance, TTFT and memory
then:  winner specific to a few exact shapes → a table entry (like DECODE_TILE_TABLE,
       quant_kernel.rs:218-219);  winner that generalises by shape class → change the rule
```

- **Promotion threshold for a timing win** (Splash's tuner, `S: dev/tuning/Tuning.hpp:23-24, 50-52`): at least 12 paired samples in alternating order (up to 64), timing spread ≤ 10 %, paired-gain spread ≤ 5 %, and a conservative gain ≥ 3 %. Splash emits the winners as code and says "if a margin matters, change the rules in runtime/ops, not a table" (`S: dev/tuning/tune_kernels.mm:527-528`).
- **Numerics classes** are from [LAND §8.2]. Both engines saw class-B changes move acceptance: Splash withdrew split-K one-lane defaults after acceptance reductions (`S: dev/benchmarks/device-policy.md:13-18`), and rejected a parallel softmax-denominator reduction that passed numerical tests (`S: dev/benchmarks/remaining-decode-optimizations.md:17-22`); th's Gate A kept split-K (§5.3) [B §3.1].
- **What the program's own autotune found.** The K45 sweep (tiles × presum × persistent groups over every 27B class and the draft shapes) confirmed the existing group policies on every shape but one, the unfused draft gate/up (−11 %); persistent-group overrides were slower (gate_up at 40 / 34 / 60 groups: 290–312 µs vs 194 µs at 68) [K45 §3.2]. Expect a sweep to mostly confirm the rules; its value is catching the exceptions and validating the rules on new shapes.
- **Never time kernels on a request path, never tune class B or C at load, never trust a cached table across engine builds** [LAND §8.5].

### 5.3 When split-K, and when to split keys

```
is the op a reduction over a long axis whose natural grid under-fills the GPU?
  examples: decode Q4 at m ≤ 8 (N = 5120); decode attention over thousands of keys; draft
  attention on 8 threadgroups; fused prefill attention on short suffixes (20–96 threadgroups)
├─ no  → keep it sequential
└─ yes → split, with a FIXED-ORDER reduce (determinism) and page- or tile-aligned capacity;
         it changes rounding, so gate it as class B (§5.2)
```

| case | ruling on Qwen3.8 | source |
|---|---|---|
| decode Q4, N = 5120 | split-K kept: sequential K cost +19.2 % ms/round for −0.031 ± 0.043 tokens/round | [B §3.1] |
| prefill Q4, m > 128 | split-K on the prefill tiles ties at best and adds fp32 partial traffic: not used | [EG §4] |
| prefill Q4, m ≤ 128 | the T2 small-M tiles include split-K variants | [B §3.1; T2] |
| decode attention (N3) | split at ≥ 256 visible keys; splits = clamp(ceil(pages / 8), 16, 32) with 32-key pages; 16–32 threadgroups per KV head fill the 40 cores (`attn_kernel.rs:90-94`) | [DL §2.1–2.2] |
| draft attention (N4) | 64 threadgroups instead of 8; one split is bitwise-equal to the old kernel | [DL §3] |
| lowering N3's threshold to 64–128 keys | would save 0.5–0.7 ms/round at bench context but changes bench-context numerics: needs a new identity baseline | [DL §1.2] |
| short prefill suffixes over long contexts | a key split is the proposed next lever (the fused kernel launches only 20–96 threadgroups there) | [EA §6] |

Capacity must be a whole number of pages. A non-page-aligned KV capacity made a prefix-cache hit and its miss take different attention kernels until a semantic merge fix aligned it [D §4].

### 5.4 When to fuse

```
signal present?
  (a) many small latency-bound dispatches (≈8 µs ramp each); a class under its GB/s target
      that no tile / group / depth sweep fixes ("a fusion problem, not a tile problem")
  (b) a consumer recomputes what its producer already had (input sums, pad copies)
  (c) blit fills or allocations splitting compute encoders
  (d) a per-layer dispatch loop that could be one grid
└─ yes → can the fused form keep the exact accumulation order and lane pattern?
         ├─ yes → build it bitwise-by-construction; unit test that fails under a one-ulp mutation
         └─ no  → it is a numerics change (class B): gate it on acceptance, not only on T=0 text
         then decide IN SITU (TH_BENCH_MULTI / server A/B), never on the kernel bench
```

| evidence | source |
|---|---|
| (a) per-dispatch ramp ≈8 µs; `in_all` / `down` capped below 480 GB/s by ramp + grid shape | [K45 §3.1, §8] |
| (b) presum blocks (producer-emitted input sums): −3.60 / −4.10 / −3.20 ms per forward at fwd8 / fwd5 / fwd1, bitwise | [B §3.1; K45 §1] |
| (c) `Tensor::zeros` blit fills split the encoder: +2.84 ms/round (95 % CI 2.18–3.50) | [B §2.1] |
| (d) one dispatch for every GDN rollback commit (`gdn_commit_all`, estimated 0.2–0.4 ms) | [CG §5; DG §2] |
| fused draft gate/up: draft MLP at 8 rows 339.1 → 302.5 µs; rounding silu·mul once instead of twice changed draft proposals and sampled trajectories | [K45 §1, §9.2] |
| **anti-signals (measured losers):** two-stream fused gate/up in prefill ran 2.8–3× slower (spill); a double-buffered K loop lost 9 %; PreSums on the N256 / paired tiles +1.7 / +2.4 ms in situ; Depth-4 pipelining +0.4 to +6 ms in situ; a rows-in-flight GDN kernel had no in-situ win and changed DFlash proposals in 4 of 6 greedy requests at 27B | [EG §0; K45 §2, §4; DG §2] |

### 5.5 Bitwise, or a noise-floor gate?

- **Bitwise (preferred).** A unit test that fails under a one-ulp mutation, plus the real-model server identity (42/42 · 42/42). A tiny test shape is not enough: a GDN kernel was bitwise on the tiny shape and not at 27B [DG §2].
- **Not bitwise** (e.g. fused prefill attention). Ship all four of: accuracy vs an f32/f64 reference at least as good as the path it replaces (fused 0.0021 on unit data vs grouped eager 0.045–0.11 [EA §0]); last-prefill-position logits inside the engine's own tail-chunk noise floor [E §4.2]; a first-divergence pass with every divergence on the known near-tie class (26/36 streams identical, the rest at known positions [E §1.6]); and a new identity baseline for the levers that follow.
- **Refactors break bitwise equality.** A "same algorithm" refactor of the fused attention kernel was not bitwise, most likely from FMA contraction under fast-math [EA §5]. Re-run the bitwise gate after every kernel refactor.

### 5.6 When to stop working on a kernel

- The whole verify matmul set sits at its measured fit: "the matmuls themselves are no longer the gap" [B §4.3].
- A tile sits at ≈90 % of the isolated MMA-only ceiling: the prefill vector tile reached 91 %, and both cheap ways to hide the remaining epilogue lost or tied ("the tile is done") [EG §3, §10]. The in-situ shortfall (≈70–75 % of isolated) is an in-situ effect, not a tile problem [EG §10].
- Removing whole stages makes the kernel no faster: removing the softmax, the P·V or the q·k matmul did not speed up the fused attention kernel, so the lever is latency hiding (the q re-read shape gained ≈15 % from freeing registers) [EA §2.2].

---

## 6. Stage 5: implement in isolated worktrees

### 6.1 Lane setup

```sh
LANE=<lever>; WT=$($P/bin/wt-bootstrap th/$JOB-$LANE main)
LW=$P/work/$JOB-$LANE; mkdir -p $LW/{bin,bench,logs}
PORT=<unique per lane; never 8001; 8000 is the competitor's>
(cd $WT/engine && cargo build --release && cargo test --release --no-run)
BIN=$LW/bin/th-engine-$LANE-$(git -C $WT rev-parse --short HEAD); cp $WT/engine/target/release/th-engine $BIN
shasum -a 256 $LW/bin/* > $LW/bin/SHA256SUMS
# the in-process A/B that decides policy: env arms of ONE binary, interleaved
for arm in "" "<OLD_PATH_ENV>=<value>"; do
  $P/bin/gpu-lock -- env $arm TH_BENCH_MULTI=8,5,1 TH_BENCH_MULTI_ITERS=5 $BIN probe --model "$TGT" --tokens "$IDS"
done
```

Every lane in the program had its own port (for example :8015, :8031, :8032, :8042, :8044, :8051–:8053) [K45; CL; CG; DS; DG; EA; ET; EG headers]. Keep a port registry in the job dir.

### 6.2 The lever template

A lever is done when all of these hold [CAT R7]:

1. **The old path is a read-once env arm** (`OnceLock`), e.g. `TH_Q4_PRESUM=0`, `TH_PREFILL_ATTN=eager`, `TH_GDN_COMMIT=step` (Appendix B). The arm removes build, binary-path and shader-cache confounds [DG §2].
2. **A bitwise unit test that fails under a one-ulp mutation** [DG §3], or, for a numerics change, the noise-floor protocol of §5.5.
3. **An in-process interleaved A/B** (`TH_BENCH_MULTI`, `TH_BENCH_PREFILL`, `TH_BENCH_TTFT`). The paired Δ is the robust quantity [DL §1.1; CAT §4.4].
4. **A quiet server A/B** under §3, with a long-context arm and a sampled arm [BQ §4.4; C §1.5].
5. **Every number tagged** [M] / [D] / [E], with the build and the conditions (§10). Loaded numbers are withdrawn, not caveated [DG R1].
6. **New outputs are fresh pool buffers** (`outbuf::kernel_out`, `outbuf.rs:31`), never `MetalStorage::new` over a cloned buffer [K45 §7; C §4].
7. **Pipelines compile at load; no env read on a hot path** [T2; RI should-fix 4].
8. **"Moved" is reported separately from "removed"**, e.g. decode saved vs TTFT paid [D §1.5; ET §3.4].

### 6.3 Lane report skeleton

```markdown
# th/<job>-<lane>: <lever family> (<items>)
Written <date> by the <lane> agent. Tags: [M] measured, [D] derived, [E] estimate.
- Branch / base sha / head sha / worktree / work dir / private port. Not pushed.
- Binaries: label | commit | sha256 | used in
## 0. Summary        item | commit | default | measured effect [M] | decision
## 1. Commits        sha | item | old-path env arm | files
## 2. Design         what changed, with file:line
## 3. Method         sessions, arms, gates, conditions per arm (load1, thermal, other GPU ms/s)
## 4. Results        in-process A/B; quiet server A/B; per-round phases; identity
## 5. Gates          unit (count, bitwise tests); R0a + step arm; smokes; hit == miss; shader validation
## 6. Tried and dropped (with numbers; code removed)
## 7. Merge notes    files touched, expected conflicts, ownership sign-off needed
## 8. Not done / limits
## 9. Reproduce and cleanup
```

### 6.4 Lane rules

- **One lever family per lane; one commit per item**, so a failing item can be dropped. K45 shipped (a), (c), (d) and dropped (b) with its numbers [K45 §0].
- **Remove measured losers** rather than leaving them behind switches, and record their numbers [K45 §4].
- **Correctness fixes land regardless of gain.** A gain-only lane rule parked the correct anchor off-by-one fix in Phase C [CL §6]; it landed in Phase E, acceptance-neutral [ET §3.7].
- **Declare which streams change.** For example, the S1 review fix changed only no-top-k, no-top-p requests (id-order walk) and left everything else bit-identical [DS §8.1].
- **Give every probe a unique env name.** Two lanes' probes both read `TH_BENCH_ATTN`, which made one unreachable until a semantic merge fix [D §4].
- **Decide on paired in-process data while the machine is shared; claim only from quiet server data.** CPU load swung between 7 and 29 while 5–7 agents queued on the lock [K45 §0].

---

## 7. Stage 6: per-branch adversarial review

### 7.1 Procedure

1. Review the branch diff against its base through three lenses: **memory**, **numerics**, **state machine** [B §2].
2. Hand each finding to its own **verification agent**, which reproduces it in a private worktree under `gpu-lock` (fault injector, probe, shader validation) and re-grades severity [B §2].
3. Issue a verdict: **mergeable**, **needs-fix** with a must-fix list, or mergeable with a condition (e.g. prefill-attn's measurement condition, met at integration [E §3]).
4. The lane runs a fix pass, re-runs its gates and appends a "Review fixes" section [K45 §9; DG R1–R6; DS §8].
5. The orchestrator confirms every verdict reached the integrator [D §3; E §3].
6. Review the integration head too. The integration-sim review found no must-fix and seven should-fix items [RI].

**Merge rule:** status done, and review mergeable or its must-fix items fixed [E §3].

### 7.2 Bug classes (what the program actually hit)

| class | what happened | caught by | cheapest detector |
|---|---|---|---|
| untracked `Arc` (storage escape) | `MetalStorage::new(existing.clone())` let candle's pool recycle a live buffer: silent state corruption, acceptance collapses | review, repeated as a static check at every integration | grep for `MetalStorage::new(` over cloned buffers [C §4; D §4.1; E §4] |
| aliasing "copies" | in candle 0.11 Metal, `Tensor::copy()` aliases the buffer and `affine(1, 0)` flushes −0.0 | the state-bitwise gate | use `slice_set` or the word-copy kernel [CG §2] |
| zero-fill blits | `Tensor::zeros` split the compute encoder: +2.84 ms/round | interposer counts | `TH_OUT_ZEROS` arm; `outbuf::kernel_out` [B §2.1; CP §4] |
| shape confusion / out-of-bounds read | draft `o_proj` read 2 MiB from a 64 KiB tensor 5× per propose, at 32× the MMA work; fixing it gave +4.7 % tok/s | `MTL_SHADER_VALIDATION` (157 reports) | shader validation on every new path [B §2.1] |
| first-caller pipeline cache | `gdn_lib` compiled with the first caller's dims (MEM-12); N3's first cache repeated it | review | two geometries in one process; `GeomCache` [B §2.3; DL §2.1] |
| unguarded hard-coded dims | head_dim 256, DK 128, conv_k 4, contiguous draft inputs (MEM-8) | review | the §1.2 pre-flight [B §2.3] |
| position off-by-one | the DFlash anchor ran one position late (KV row attended as zeros, RoPE +1) | review + a position probe | a position probe like `TH_CHECK_POS` (branch-only, `28acf03`) [B §2.3; ET §3.7] |
| capacity-dependent routing | a non-page-aligned KV capacity sent a prefix-cache hit and its miss to different kernels | semantic merge review | hit == miss gate [D §4] |
| non-bitwise "refactor" | FMA contraction under fast-math changed a same-algorithm kernel | the 42/42 server identity arm | re-run bitwise gates after any refactor [EA §5] |
| MPP strict-precision f32 left operand | garbage in the NAX fragment layout | unit test vs CPU | `nax_fragment_mma_matches_cpu` [EA §0] |
| pool growth in unsynced prefill | candle frees pooled buffers only at a sync and the pool is wired: a 32k probe rebooted the machine | phys_footprint guard | footprint guard; one mask per forward; pool trim [DL §6] |
| implementation-defined MPP layout | cooperative-tensor layout differs by shape | load-time probe | `pf_vec_layout_check` (`quant_kernel.rs:4690`) [EG §5] |
| cross-request state leak | draft rings not cleared; a skipped warm-up changed the next request's proposals | same request run 1st vs 5th | run each request alone and after others [B §2.3; DP §0] |
| state-machine error path | `take().unwrap()` then `?` poisoned a slot, killed the scheduler, `/health` stayed green | fault injectors | restore before `?`; `catch_unwind`; errors reach the client [B §2.2] |
| metric timer before a sync | batch `decode_tps` 126.1 reported vs 50.1 wall; `prefill_tps` ≈3.7× high | wall-clock cross-check | every metric timer ends at a sync [B §2.2; BQ §5] |
| per-slot config leak | an admission flipped another slot's kv_quant mode: live stream degenerated | unit test + e2e | per-slot config with a test [B §2.2] |
| tie-rule mismatch | GPU argmax lowest index vs CPU last index; 1.68 % of T=0 rows tie | cross-path identity | one tie rule everywhere [B §2.1] |
| non-finite tails | recycled buffers holding −inf multiplied by masked zero probabilities | review | zero tails by compute, not blit [ET §2.1] |
| threadgroup memory at the 32 KiB limit | `r32n256s8` uses exactly 32 KiB of static memory; a compile failure elsewhere would 500 every request of that shape | review | compile on the target GPU; keep a fallback [RI] |
| lazy compiles | tile libraries compiled mid-decode on first use | review | compile at load [B §3.1; T2] |
| tiny-shape-only proof | a GDN kernel bitwise on the tiny test shape was not at 27B | real-model identity | a real-model identity arm [DG §2] |
| layout-specific failure | T1b fed a time-major V view into gemm, which Metal rejects; tests covered only contiguous V | first real-model forward | test both cache layouts [DP §0] |

### 7.3 Review checklist

Walk it on every lane branch and again on the integration head. Condensed from [CAT §7.2].

**Memory, aliasing and bounds**
1. No `MetalStorage::new(...)` over a clone of an existing buffer; every output is a fresh pool buffer.
2. Bit-exact copies use `slice_set` or the word-copy kernel.
3. Every uninitialised output is fully written: a zeros-vs-empty arm gives identical streams.
4. `MTL_SHADER_VALIDATION=1` on the new paths: 0 reports.
5. Masked or padding rows that kernels read are finite, zeroed by compute.
6. Every kernel geometry assumption has a Rust guard with a fallback (head_dim, DK/DV, conv taps, quant group, GQA ratio) **and a unit test over every template parameter**: the split kernel compiles and runs for groups it computes wrongly (9–15), and both of its tests use group 6 (`attn_kernel.rs:655-658, 1943-1966`).
7. Pipeline and library caches are keyed by geometry.
8. Long prompts run under a phys_footprint guard; views and long-lived small tensors can pin large buffers [B §2.3 MEM-7; DL §6.2].

**Numerics and identity**
9. A "bitwise by construction" claim ships with a mutation-checked unit test **and** a real-model server identity arm.
10. After any kernel refactor, re-check bitwise equality.
11. One tie rule on every path.
12. Row-count and chunking dependence is understood (canonical chunk plans for caching; slot invariance for batched tiles) [DP §2; T2].
13. A lever that is not bitwise ships the §5.5 noise-floor argument.

**State machine and contracts**
14. No `take().unwrap()` + `?` on slot state; the scheduler survives errors; errors reach the client and the counters.
15. Per-slot configuration never leaks across slots; admin endpoints skip live slots [B §2.2].
16. The snapshot contract is explicit (a light snapshot is valid for one forward) and a stale restore is an error [CG §5].
17. Position and length bookkeeping is probed against the KV count.
18. The same request 1st vs 5th in one process gives identical proposals.

**Measurement integrity**
19. Every timer that feeds a metric ends at a sync.
20. Odd seeds and explicit sampling parameters (the sampler seeds with `seed | 1`, `engine.rs:1367`).
21. Profiler-mode per-item numbers rank; they are never summed into savings.
22. Claims come from gated palindromes with redo rules; loaded numbers are withdrawn.
23. The build is the sha256 of a frozen binary; each new binary path gets a warm-up (shader cache).
24. No per-call env reads on hot paths.

**Merge**
25. A clean `git merge-tree` does not mean it compiles or behaves: build, test and re-run the gates on the merged head.
26. Every lane's probe is still reachable after the merge.
27. Every review verdict reached the integrator.

**Performance acceptance**
28. Policy is decided by the in-situ forward A/B, not the isolated kernel bench.
29. The old path stays as a read-once env arm.
30. Every routed pipeline compiles at load.
31. "Moved vs removed" is checked (TTFT vs decode, first-token gap).
32. A long-context arm and a sampled arm are included.

---

## 8. Stage 7: integrate

### 8.1 Procedure

```sh
# 1. pairwise conflict matrix, read-only (a clean pair can still fail semantically, §8.2)
for a in $LANES; do for b in $LANES; do [ "$a" \< "$b" ] || continue
  GIT_OPTIONAL_LOCKS=0 git -C $REPO merge-tree --write-tree --name-only "$a" "$b" >/dev/null || echo "conflict: $a x $b"
done; done
# 2. integration branch: one --no-ff merge per lane (so any lane can be dropped), build after each
IWT=$($P/bin/wt-bootstrap report/$JOB-integration main); IW=$P/work/$JOB-integration; mkdir -p $IW/{bin,logs}
for l in $ORDER; do
  git -C $IWT merge --no-ff "$l" || break
  (cd $IWT/engine && cargo build --release && cargo test --release --no-run) || break    # 0 warnings
done
# 3. freeze, then the whole gate suite in ONE gpu-lock hold
cp $IWT/engine/target/release/th-engine $IW/bin/th-engine-int-$(git -C $IWT rev-parse --short HEAD); shasum -a 256 $IW/bin/*
G_LOGITS=1 $P/bin/gpu-lock -- bash $IW/bin/gates.sh $IW/logs/gates      # a gates4.sh-class script (§8.3)
python3 $IW/gates-tools/cmp_arms.py $IW/logs/gates/pc pc_miss pc_on    # any pair of prefix-cache arms
```

The Phase E version of these commands is in [E App. A].

### 8.2 Semantic-merge classes seen

| class | example | source |
|---|---|---|
| type error behind a clean textual merge | E0308: T2's rows > 8 branch returned `Result<Tensor>` inside K45's tuple-returning `gate_up_act_ps` | [B §3.4] |
| compile error where `merge-tree` reported no conflict | T2 × `clear_kv_cache(slot)` | [B §3.1; T2] |
| an auto-merged file that did not compile | K45 × the multi-slot refactor: `propose_batch` still used `DraftLayer.gate` / `.up` | [K45 §9] |
| test-only compile error | E0063, a test-model field added by another lane | [D §4] |
| behavioural: capacity alignment | the KV-capacity buffer was not page-aligned, so hit and miss took different kernels | [D §4] |
| behavioural: probe routing | two probes read `TH_BENCH_ATTN`; one became unreachable | [D §4] |
| a per-call env read reintroduced by a resolution | one side still read `TH_NO_ATTN_FUSED` per call; the resolution kept the read-once form | [D §4] |
| two lanes rewriting one hot function | the fused prefill route vs the new KV store in `qwen35.rs` `attn_forward` | [E §4] |

Most conflicts landed in `qwen35.rs`: all 9 hunks of integration-3 and the single hunk of integration-4 [D §0; E §4].

### 8.3 The gate suite on the merged head

| # | gate | command shape | pass | integration-4 result [E §4.1] |
|---|---|---|---|---|
| 1 | unit suite | `cargo test --release` | all pass | 92 passed, 0 failed, 1 ignored |
| 2 | R0a variants | `TH_TEST_ROLLBACK=1` × {`TH_BATCH=2`, `TH_BATCH=1`, `TH_ATTN_SPLIT_MIN=1`, a 1450-token prompt} | rc 0 | rc 0 on all four |
| 3 | discrimination arm | the same with `TH_GDN_COMMIT=step` | rc 1 | rc 1 |
| 4 | two slots | `TH_BATCH=2 --draft TH_SAMPLE=check`: T=0 / sampled / mixed pairs, concurrent restores of one checkpoint, 1.45k and 8k pairs | all HTTP 200; 0 mismatches; 0 panic / WARN / ERROR | 35/35; samplecheck 313 rounds, 0 mismatches |
| 5 | four slots | `TH_BATCH=4 --draft` + `POST /engine/kv/clear` + after-clear | all HTTP 200; 0 U+FFFD | 16/16 + 3/3 |
| 6 | single-slot sampling check | `TH_SAMPLE=check`: GPU block rule, no-top-k CPU paths, temperature-only, 1.45k sampled, T=0 | 0 mismatches | 14/14; 205 rounds, 0 mismatches |
| 7 | TurboQuant | `--kv-quant --draft` | texts identical to the previous build | 4/4 identical |
| 8 | no draft | single slot (short, 1.45k, 8k), then `TH_BATCH=2` without `--draft` | all HTTP 200; exactly one WARN | 9/9; 3/3 with the one WARN |
| 9 | prefix cache | 43-request `spec_a3`: on / `=miss` / `=0` | hit == miss 42/42 · 42/42 | 42/42 · 42/42 |
| 10 | store modes | `TH_KV_CAP_PREFILL=legacy` and `=0` vs default | 42/42 · 42/42 each | 42/42 · 42/42 each |
| 11 | merge check | the new kernel switched off (e.g. `TH_PREFILL_ATTN=eager`) vs the preceding lane's final | 42/42 · 42/42 | 42/42 · 42/42 |
| 12 | `/status` contract | key-path diff of the full payload, plus the keys both app clients read (§1.7) | additions only; no consumed key changes meaning | 46 → 49 paths, 0 removed |
| 13 | logs | grep every server and probe log | 0 panic, 0 ERROR | 0 and 0 |
| 14 | logits | `TH_BENCH_PREFILL_LOGITS=512,1450,4096,7900` on the integration binary | inside the noise floor | [E §4.2] table |

The hold grew with the suite: ≈2 min in Phase C, ≈13 min in Phase D, ≈43 min in Phase E [C §4; D §4.1; E §4.1] [D].

---

## 9. Stage 8: final same-session A/B and landing

### 9.1 Session design (Phase E's, the most complete)

- **Engines:** new (the integration head), base (current main), old (the previous standing's binary), the competitor [E header].
- **Block S** (decode): 8-arm palindrome `new base comp old | old comp base new`; warm-ups; greedy 3 × 3, sampled seeds 1/3/5, ctx1500 3 × 3, ctxcold 3 prompts × 3 nonces (back-to-back cold prefills); max_tokens 128 [E §1.1].
- **Block L** (TTFT and long context): 8-arm palindrome; the TTFT block of §3.2, with every request first waiting outside the timed window for thermal ≤ 1 (≤ 240 s) plus 1 s idle; then ctx8k 3 × 3 at T=0 behind the same gate [E §1.1].
- **Gates:** §3.3; record the conditions of every request.
- **Standing:** the quiet replicate. Phase E ran block S twice; its S2 replicate (8 arms, all clean, request-start load1 medians 7.2–15.2, thermal 0–1) is the standing, and the loaded S1 is reported beside it [E §0].

```sh
F_ORDER_S="new_1 base_2 comp_3 old_4 old_5 comp_6 base_7 new_8" F_BLOCKS=S F_ARM_TRIES_S=1 F_LOAD_MAX2=25 \
  F_GATE_WAIT2=420 F_GATE_CPU_IDLE=25 F_REQ_CPU_IDLE=0 F_THERM_WAIT=120 F_THERM_OK=1 \
  $P/bin/gpu-lock -- bash $W/bench/fin4d.sh $W/bench/final_s            # block L: F_BLOCKS=L
$P/bin/gpu-lock -- bash $W/bench/logits_dump.sh $W/logs/logits_dump      # cross-binary last-position logits
bash $W/bench/mkfinal.sh      # all.md (q4_analyze), ab_*.md (ab4), ttft.md (ttft4), fp.md (fp4), conds4.md
```

(Phase E's exact invocation, with its own arm labels, is in [E App. A].)

### 9.2 Analysis

- Pooled per engine × mode, ratio of sums, both arms, per-arm drift [E §1.2].
- Ratios as per-round × tokens/round; flag every tokens/round component measured on texts that differ [E §0].
- Round decomposition per engine and mode [E §1.3].
- TTFT per class with position-paired Δ and 95 % CI [E §1.4].
- Peak phys_footprint and its increment. Splash's footprint excludes its file-backed weights, so only increments compare [E §1.5].
- Identity: each engine's determinism across its arms; a 36-stream first-divergence pass against base; rounds on byte-identical text against the competitor; cross-binary last-position logits (`probe --dump` + `cmp`) [E §1.6].

### 9.3 Landing

- `git merge-tree --write-tree main report/<integration>` must be clean, and the merged tree's `engine/` must equal the gated tree's, so the gated binary is what lands [E §5].
- Fast-forward if `main` is an ancestor; otherwise a `--no-ff` merge. Nothing is pushed without the maintainer [E §5].
- Landing notes list every API or behaviour change, every new knob (all read once), the `/status` key diff, and the files in the other developer's area that need sign-off. Restarting the live `:8001` engine is the maintainer's call [E §5].
- The product path is part of landing: the maintainer serves the model from the ENGINE tab (or `POST :8765/engine/serve`) and `GET :8765/engine` shows it serving with the expected `instance.model` (§1.7).

---

## 10. Reporting template

Every phase report and lane report follows this shape; it is the shape of [C], [D] and [E].

```markdown
# <job / phase> report: <new> vs <base> vs <old> vs <competitor>
Written <date, time, TZ> by <agent>, for the maintainer.
- Repo; main sha at start and end; main tree and :8001 untouched.
- Hardware: <chip, GPU cores, RAM, macOS>. Model: <repo@revision> (+ draft). Competitor: <engine, version, model, port>.
- Builds (frozen copies in $W/bin/):
  | label | commit | sha256 | notes |
- Metric conventions: loop tok/s, like-for-like, sampled parameters, ratio of sums, TTFT definition, tags.
## 0. Summary      standing per mode = per-round × tokens/round; TTFT; memory; gates; verdicts; conditions
## 1. Standing
### 1.1 Sessions and conditions
  session log: | session | window | arms kept | notes |
  per kept arm: | arm | gate | load1 min / med / max | thermal@start counts | other GPU ms/s | CPU idle % |
### 1.2 Decode      | engine | mode | n / logged rounds | tok/round | ms/round (arm 1 / arm 2) | loop tok/s | lfl | TTFT |
### 1.3 Where the round goes   propose | verify host encode | verify GPU tail + readback | rest | round
### 1.4 TTFT        per class, with the paired Δ and its 95 % CI
### 1.5 Memory      peak phys_footprint and increment
### 1.6 Identity, determinism, logits
## 2. What each lane delivered (lane-measured, with conditions)
## 3. Review verdicts and merge decisions
## 4. Integration: merges (conflicts, resolutions, semantic fixes) and gates
## 5. Landing: merge-tree result; API / behaviour changes; new knobs; ownership
## 6. Remaining gaps and next levers, ranked by user-visible gain, each with the gap it closes [M]
## Withdrawn claims (what and why)
## Appendix A: reproduce (exact commands)
## Appendix B: cleanup (processes and how each was stopped; ports and lock free; git state)
```

**Rules for every number.**

- It names its build (a label that resolves to a sha256 in the builds table) and its session (which resolves to the per-arm load1 and thermal table) [B §0; E §1.1].
- It carries a tag: [M], [D] or [E].
- It is a ratio of sums; it is a standing only if it comes from the quiet replicate.
- A number that does not transfer is withdrawn, with the reason, not caveated [DG R2; ET §0].

---

## 11. Time and cost expectations (phases B–E)

### 11.1 Per phase

Windows are report timestamps (AEST); durations derived from them are [D].

| phase | window | lanes | integration | gate hold | final A/B | outcome | review |
|---|---|---|---|---|---|---|---|
| B | baseline 09-25 23:11–23:18 [Bb]; report 09-26 ≈05:30 [B] | 5 implementation branches, plus a verification / fix branch per confirmed bug [B §3] | integration-sim: 3 conflict hunks + 1 semantic fix; 24/24 tests [B §0] | — | two short A/B sessions, 05:13–05:23 [B §1.2] | 63.1 → 54.5 ms/round (−13.6 %) [B §0]; the start was 0.52× Splash T=0 on a loaded machine [B §1.1] [D] | 14 confirmed bugs [B §0] |
| bench-quiet | 09-26 06:11–07:38 [BQ] | — | — | — | 3 ABBA sessions, 540 requests [BQ] | the protocol; 0.840× Splash T=0 [BQ §0] | — |
| C | lane sessions from 05:40 [CP]; report 09-26 ≈08:50 [C] | 3 [C §2] | 3 mechanical hunks, 0 semantic; 37/37 tests; fast-forward of 47 commits [C §0, §5] | ≈2 min [C §4] | 20 + 8 min (s1, s2) [C §1.1–1.2] | 1.031× Splash T=0; +24.2 % [C §0] | all three mergeable, no must-fix [C §3] |
| D | lane sessions from 09-26 11:24 [DS §5] to 09-27 04:46 [DG R3]; report 09-27 ≈09:00 [D] | 4 [D §2] | 9 hunks + 3 semantic fixes; 78/78 tests; 18 files +9990/−667 [D §0, §4] | ≈13 min [D §4.1] | ≈2 h (306 requests) + a 20 min TTFT A/B [D §1.1, §1.5] | 1.243× Splash T=0; ctx8k 2.499× main [D §0] | one must-fix (load-inflated claims), one needs-fix (3 must-fix), one verdict never received [D §3] |
| E | lane sessions from 09-27 09:00 [ET]; gates 18:46–19:30; report 09-28 ≈00:45 [E] | 3 [E §2] | 1 conflict hunk; 92 tests; 13 files +4246/−240 [E §0, §4] | ≈43 min [E §4.1] | 24 arms, 748 requests over 19:35–00:29, with seven gating restarts; the quiet S2 block alone ≈34 min [E §0, §1.1] | 1.203× Splash T=0; cold 1.45k TTFT parity [E §0] | two mergeable (one with a measurement condition), one verdict never received [E §3] |

**Reading the outcome column.** Standings are per session, not a time series of the code: in Phase E's session the Phase D build (main `e452a7b` = integration-3) read 1.155×, against its own 1.243× in Phase D [E §0]. Phase B's 0.52× (33.0 vs 63.8 loop tok/s) ran at load1 26–49 and is not a standing (§0.3 rule 7) [B §1.1] [D]. The "0.56×" of earlier drafts is either B's loaded ms/round ratio (58.9 vs 104.5) or the pre-program quiet reference at T=0.6 with mismatched top_p (40.65 vs 72.4 tok/s) [B §1.1] [D]; neither is a T=0 loop tok/s standing.

### 11.2 Where the time went

- **Waiting for the GPU.** 5–7 agents queued on the lock [K45 §0]; lock waits of 15–60 min [DS §0], 48 min [DS §8.3] and 1 h 56 min [EA §5].
- **Waiting for quiet.** Load1 never fell below 6 in 124 one-minute samples (≈2 h) of one review round [DS §8.3], nor from 19:31 to 00:45 on another night [DG R3]. Phase E's final hold was stopped and restarted seven times to change gating [E §0].
- **Re-measuring.** A loaded gain had to be re-measured quiet and halved [DG R3]; two first-run TTFT claims were withdrawn [ET §0]; a lane's quiet re-measure never found a quiet window and fell back to a moderate-load session [DS §8.3].
- **Rebuilding the harness.** Phase B recreated missing tools [K45 §0]; the session runner went through five versions inside Phase E [E App. A].

### 11.3 Budgeting rules [I]

1. Build or vendor the harness first (§0.4); every phase that skipped this paid for it.
2. Book quiet GPU windows, or a dedicated machine, for Stage 2 baselines and Stage 8 standings; lane decisions can run on paired in-process probes in the meantime.
3. Plan one full gate hold per integration (the last one was ≈43 min) and more as the suite grows.
4. Plan the final A/B as the long pole: hours, not minutes, on a shared machine.
5. Expect review to find real defects, at every phase, and expect at least one semantic merge fix whenever two lanes edit the same hot function in `qwen35.rs`.

---

## 12. Model-class adaptations

| class | first failure today | needed before Stage 1 passes | what changes in Stages 2–5 | engine prerequisites (GENERALISATION-PLAN) |
|---|---|---|---|---|
| (a) Qwen4-class dense hybrid | LOUD unless `model_type` starts with `qwen3_5` (`model.rs:639`); then SILENT for GDN DK ≠ 128, attention head_dim ≠ 256, a GQA group of 9–15 in split decode (the preview's is 12) or a non-swish GDN norm gate (the preview's is sigmoid), PANIC for Hv > 64, LOUD above 56 GDN layers [AUD §0.3; §1.2] | the §1.2 pre-flight (`TH_ATTN_SPLIT=0` until the group guard lands); descriptor fields (`layer_types`, gate kinds, RoPE type, quant block) | re-derive tile tables and split policies; check DV and group size against the presum producers; a new draft or an MTP head; a fresh acceptance study [CAT §8.2] | G1, G2, G3, G8a; G6 for new dims, a group > 8 or a new gate kind; G5 for MTP |
| (b) MoE | LOUD at load: `qwen3_5_moe` looks for `mlp.gate_proj` (`qwen35.rs:3043-3049`) [AUD §4b]; stacked `[E, out, in/8]` expert tensors would then fail the 2-D loaders (`qwen35.rs:174-187, 212-225`) | a MoE FFN and a stacked-expert loader, gather-Q4 decode / verify kernels, a grouped prefill GEMM | F_bw per verify width; re-measure the verify ladder before adopting L1; the presum chain stops at the router [AUD N-05] | G4, G7; the streaming loader (R13) for packs above ~60 GB |
| (c) native MTP heads, no Splash draft | runs, with n-gram speculation only and batching off (`engine.rs:113-124`) [AUD §0.3] | nothing | the §5.1 depth sweep; the drafter's state in R0a and in prefix checkpoints | G4 (StateSpec), G5 |
| (d) non-Qwen (Gemma 4, Llama) | LOUD: `unsupported safetensors model_type` (`model.rs:691`); GGUF Llama runs on candle's kernels with none of th's features [AUD §4d] | an attention-only backend on th's kernels: head_dim 128 / 512 variants, no gate, optional q/k norm, RoPE variants, sliding-window ring caches, GeGLU, sandwich norms, `(1 + w)` norms, a tied lm_head, chat marks from the template | rollback is KV truncation (L08 and L12 do not apply); L09 and L10 dominate [CAT §8.2] | G1, G4, G6, G7 and the chat adapter |
| (e) new quant format | LOUD or SILENT: bits 4 and group 64 hard-coded (`qwen35.rs:169`) [AUD Q-01] | QuantScheme parsing including per-module overrides; a CPU reference dequant | a new decode / prefill kernel family; re-measure the MMA ceiling and the floors; presum only for affine formats with a per-group bias [AUD Q-05] | G1 (quant map), G6 (R5), G3 |

The next models' specifics are in [LAND §4]: the Qwen4 architecture preview (Qwen3.8-Flash-Next, `X: mtplx/models/qwen4_exp.py:73-111`: 48 layers at `full_attention_interval` 4 = 36 GDN + 12 sparse-attention, GDN geometry equal to the 27B's but a sigmoid norm gate, 24 q / 2 KV heads (group 12), 512-expert top-10 MoE, 4-stream hyper-connections over hidden 2560 with grouped norms, an n-gram embedding, an MTP head, YaRN) and Gemma 4 (sliding + global attention with head_dim 512 on global layers, KV sharing, per-layer embeddings, a parallel dense + MoE FFN, assistant drafters that read the target's KV).

---

## Appendix A: probe and harness reference

`main.rs` probes are env-gated and run through `th-engine probe --model <dir> --tokens <ids> [--dump <file>]`.

| env | where | purpose | note |
|---|---|---|---|
| `TH_TOKENIZE=<file>` | `main.rs:166-184` | print server-rendered prompt ids | no model load, no GPU |
| `TH_PF_COMPILE` | `main.rs:190` | compile-only check of the prefill tile library | |
| `TH_BENCH_DRAFT_ATTN` | `main.rs:204` | N4 draft-attention kernel bench | no model |
| `TH_BENCH_PREFILL_ATTN=seq:kv,…` (`_VARIANTS`) | `main.rs:212` | fused prefill attention vs grouped vs sdpa, error vs an f32 reference | no model |
| `TH_BENCH_ATTN` | `main.rs:221` | a value without `:` runs the N3 decode-attention bench (no model); `seq:kv` runs the T1b eager bench | |
| `TH_BENCH_ALLOC` | `main.rs:228` | allocation-path microbench | |
| `TH_MPP_PROBE` | `main.rs:234` | compile the Q4 MPP library (`ALL_MPP_KERNELS` + three prefill MPP functions, `quant_kernel.rs:2578-2644`), no GPU work | prints failures, always exits 0; not a geometry compile gate (§1.3) |
| `TH_TEST_ROLLBACK` | `main.rs:245` | R0a state-bitwise and prefix-restore gates; exit code is the gate | |
| `TH_BENCH_LIN=1\|dec\|pf` (`TH_BENCH_PF_M`) | `main.rs:427`; `qwen35.rs:2677` | V-lin max\|Δ\| and per-class timing; prefill tile sweep | timing is not a signal [U1] |
| `TH_BENCH_Q4` (`_SWEEP`, `_SERIAL`, `_ONLY`, `_M`) | `main.rs:440`; `qwen35.rs:910-936` | decode kernel µs / GB/s; the K45 autotune sweep | draft classes are literal shapes (`qwen35.rs:995-1009`) |
| `TH_BENCH_DRAFT_MLP` | `main.rs:446` | draft MLP at propose / batched shapes | |
| `TH_BENCH_MULTI` (`_ITERS`) | `main.rs:451, 472` | in-process whole forward per verify width | decides policy |
| `TH_BENCH_PREFILL` (`_LARGE_ONLY`) | `main.rs:492, 502` | in-process prefill A/B | GPU-busy timed with `TH_GPU_PROF=1` |
| `TH_BENCH_STEPS` (`_REPS`) | `main.rs:550, 560` | prefill chunk-size A/B | |
| `TH_BENCH_PLAN` (`_STEP`, `_REPS`, `_MERGE`) | `main.rs:611, 634-636` | prefix-cache plan vs grid vs hit | |
| `TH_BENCH_TTFT` (`_KINDS`, `_REPS`, `_GAP_MS`, `_THERM`, `_IDS`; `TH_BENCH_DRAFT`) | `main.rs:774, 1110-1127` | in-process cold-TTFT kinds | |
| `TH_BENCH_PREFILL_LOGITS` (`TH_BENCH_PREFILL_IDS`, `_REPS`, `_STEP`) | `main.rs:874-890` | eager vs fused last-position logits plus the tail-chunk noise floor | |
| `TH_BENCH_BATCH` | `main.rs:972` | batched verify A/B with a slot-invariance check | |
| `TH_GPU_PROF` (`_EVERY`) | `gpuprof.rs:305-312`; armed at `main.rs:109-110` | R0c per-(phase, region, kernel) GPU ms; `gpuprof::drain_busy_ms` at `gpuprof.rs:403` | rank only [DG §4] |
| `TH_DEBUG_TIMING` | `engine.rs:300-304`; `[dflash]` line at `engine.rs:1137-1141` | per-round phases | `[verify] enqueue` includes propose [B §2.4] |
| `TH_DEBUG_PREFILL` | `engine.rs:454` | synced prefill phases | |
| `TH_ACCEPT_STATS` | `engine.rs:1713` | Rao-Blackwellised acceptance | |
| `TH_SAMPLE=gpu\|cpu\|check` | `engine.rs:1538` | GPU vs CPU acceptance, or both with a per-round check | |
| `TH_BENCH_GDN` (`_N`) | `gdn_kernel.rs:2694-2697` | GDN step / commit kernel bench (cargo test) | |
| `TH_OUT_ZEROS` | `outbuf.rs:19` | zero-fill every kernel output (coverage proof arm) | |
| `TH_BENCH_ROUND` | branch `th/d-longctx-probe` @`5090f18` | load-robust in-process round A/B | not on main; port it (G0) [DL §0] |

## Appendix B: in-binary old-path arms

| arm | restores | lever | bitwise vs default | source |
|---|---|---|---|---|
| `TH_Q4_PRESUM=0` | no presum blocks | K45(a) | yes (bit-neutral) | [K45 §9.4] |
| `TH_Q4_POLICY=legacy` | the pre-K1/K2 decode tile policy | K1 / K2 | no (tile numerics) | [K45 §9.4] |
| `TH_Q4_PS_FAMILIES=…` | the PreSums family set | K45 | yes | [K45 §1; RI] |
| `TH_M1_PATH=mpp` | the pre-K7 m = 1 route | K7 | reproduces base bitwise | [C §5.3; CP §2] |
| `TH_VERIFY_ADAPTIVE=1` | the adaptive verify length | L1 | no | [CL §0] |
| `TH_GDN_COMMIT=step` | pre-G1a rollback numerics; the R0a discrimination arm | G1a | no, by design | [CG §2–§3] |
| `TH_GDN_COMMIT_ALL=0`, `TH_ARN_LEGACY=1`, `TH_GDN_WSG=8`, `TH_CAND_SORT=legacy`, `TH_DRAFT_RING=legacy`, `TH_DRAFT_PS=0` | the pre-gpu-tail kernels | gpu-tail | yes | [DG §2] |
| `TH_OUT_ZEROS=1` | zero-filled kernel outputs | MEM-2 | yes (proves full coverage) | [CP §4] |
| `TH_ATTN_SPLIT=0`, `TH_ATTN_SPLIT_MIN=<n>` | single-pass decode attention; the split threshold | N3 | a threshold change is not | [D §5; DL §1.2] |
| `TH_DRAFT_ATTN_SPLIT=0` | 8-threadgroup draft attention | N4 | one split is bitwise | [D §5; DL §3] |
| `TH_SAMPLE=cpu`, `TH_SPEC_VERIFY=token` | CPU accept; the token rule | S1 / B1 | GPU == CPU bitwise | [D §1.2; DS §3] |
| `TH_PREFIX_CACHE=0\|miss\|grid` | no cache; the plan without captures; the grid plan | T1 | `=0` and `=grid` == main | [D §2.4] |
| `TH_ATTN_GQA=0` | broadcast eager attention | T1b | yes | [D §2.4] |
| `TH_PREFILL_ATTN=eager`, `TH_PREFILL_ATTN_VARIANT=g2` | eager prefill attention; the held-q kernel | E1 | eager == main; g2 == g2q | [EA §1; E §4.1] |
| `TH_PF_LARGE=0`, `TH_PF=0` | the legacy m > 128 op; no tile routes | E1(b) / T2 | the vector tile is bitwise | [EG §1; B §3.1] |
| `TH_KV_CAP_PREFILL=legacy\|0`, `TH_KV_RESERVE=0`, `TH_PREFIX_CACHE_KV=copy`, `TH_PREFIX_CACHE_DEFER=0`, `TH_PREFIX_CACHE_FULL=0`, `TH_PREFILL_HEAD=1` | pre-ttft-regression store, reserve and checkpoint behaviour | ttft-regression | 42/42 · 42/42 | [E §2.3, §4.1] |

## Appendix C: known artefacts (not bugs)

| artefact | what it is | source |
|---|---|---|
| `TH_TEST_ROLLBACK` legacy-logits "FAIL" at long prompts | compares argmaxes at two different positions (`main.rs:408-417`); the exit code is the gate | [E §3; EA §5] |
| kept = 1 logits \|Δ\| ≈0.125–0.22 in the rollback probe | the m = 1 path's shape noise, not rollback | [C §4; EA §5] |
| near-tie positions on the Qwen3.8 suite | code prompt emitted id 22; ctxcold code @113, long @14 / @52; ctx8k code @29/30 | [E §1.6; D §1.3] |
| batch-mode greedy output varies with co-scheduling | different Σ rows take different kernels | [RI] |
| prefix cache default plan vs `=0` on long chat prompts | 32–35 of 42 texts identical; `=grid` gives strict identity | [D §4.1; E §4.1] |
| `</think>` streaming | th streams it as content, Splash drops it | [BQ §5] |
| `th_stats.prefill_tps` | host enqueue rate, not wall rate | [BQ §5] |
| ioreg GPU-busy on th | double-counts overlapping command buffers | [B §4.2] |
| omitted `top_k` | resolves to the server default 20 (`state.rs:70-71`), so the request takes the GPU accept path | [DS §8.1] |
| `seed \| 1` | seeds 2k and 2k+1 collide (`engine.rs:1367`) | [B §2.4] |

## Appendix D: critique dispositions

Review: [`analysis/CRITIQUE.md`](analysis/CRITIQUE.md) (2026-09-28). Every item was re-checked against the code at `b31ca91` before it was applied; "partly rebutted" means the evidence changed the fix. The critique's "missing" items 1–6 and 9–11 are covered by H1, H2, M1–M5 and L1; items 7 and 8 have their own rows.

| item | disposition | evidence | changed (playbook / plan) |
|---|---|---|---|
| H1 split decode at GQA > 8 | fixed and sharpened: group 9–15 is SILENT, group 16 exceeds the 32 KiB threadgroup budget [D], and a widening must keep or change the 8-simdgroup MPP scope, not just the thread count. The wrong "fits" claim came from [LAND §4.1] | `attn_kernel.rs:655-658, 730-735, 762-767, 909, 1079-1081, 1966` | §1.2, §7.3, §12 / §1, §3.1, §5.5, G1, G2, G6, §12(a) |
| H2 product reachability | fixed (G8 split into G8a now, G8b later); partly rebutted: the app already reaches the pack through `POST :8765/engine/serve` with an explicit spec (DFlash attaches by substring), while the ENGINE tab rows and the Go daemon (no `--draft`) do not. Stage 1 checks the contract on the lane's port; the ENGINE-tab serve is a landing step, because Stage 1 must not touch `:8001` | `LocalServer.swift:266-280`; `EngineSupervisor.swift:49-55`; `EngineTab.swift:265-305`; `supervisor.go:59-67` | quick-start, §1.7, §1.9, §8.3, §9.3 / §0.3, §4.2, §10 |
| M1 headline | fixed: 0.52× loaded → 0.840× → 1.031× → 1.243× → 1.203×. Added: "0.56×" equally matches B's pre-program quiet T=0.6 reference (40.65 vs 72.4 tok/s), and standings are per session (Phase E measured Phase D's build at 1.155×) | `PHASEB-REPORT.md:79-83, 96, 103-107`; `PHASEE-REPORT.md:27` | header, §11.1 / §1 |
| M2 compile gate | fixed; added that `TH_MPP_PROBE` always exits 0 and that split / prefill-attention fallbacks are log lines, not errors | `main.rs:234-240`; `quant_kernel.rs:2578-2644`; `attn_kernel.rs:910-921, 1633-1640` | quick-start, §1.3, §1.9, App. A / §5.5, G1 |
| M3 `/status` | fixed: new keys only, `maximum_context_tokens` keeps its meaning, the Go daemon named as the second consumer | `server.rs:92`; `EngineTab.swift:123`; `supervisor.go:161, 174, 254-266` | §1.7, §8.3 / §4, §5.4, G8b, §10.4 |
| M4 draft provenance | fixed: `repo_id` when present, a revision warning, the geometry checks always | `ModelDescriptor.mm:135-300`; `test_models.py:90-108`; manifest @`3e6447f0…` vs `$TGT` @`10c35ca…` | §5.1 / §6.3, G8b |
| M5 competitor metrics | fixed: adapter table; a non-Splash standing is client wall tok/s on identical requests. Refinement: MTPLX exposes a round analogue (`verify_calls`), usable once checked | `X: mtplx/server/openai.py:16603-16640, 32001-32008`; harness `analyze.py:11-12` | §2.4, §3.1 / §13 |
| M6 sourcing | fixed: vendored paths for every MTPLX and Splash figure; web-only figures tagged [ext] and kept out of decision rules. Corrections: the 614 GB/s file is `mtplx/kernels/ternary_qmv.py:9`; "about half the memory" is MTPLX's own wording (`README.md:96-97`) | in place | conventions, §0.3, §1.4, §2.1, §5.1–5.2 / §2, §5–6, §8, §11–13 |
| L1 derived figures | fixed; F_bw partly rebutted: the surviving figures do not pin one basis (≈539 or ≈484 GB/s from the weight sum, ≈563 GB/s from B's draft floor, state traffic in neither), so the arithmetic is shown with "recompute". 151 MB vs 195 MiB reconciled: candle's power-of-two pool rounding gives exactly 195 MiB | `PHASEB-baseline.md:157`; `PHASEB-REPORT.md:107, 686`; `candle-core-0.11.0/src/metal_backend/device.rs:336-338` | §0.3, §1.1, §2.1 / §5.4 |
| L2 harness inventory | fixed; G0 parameterises `wt-bootstrap` | `.worktrees/_phaseC/bin/wt-bootstrap:5-6` | quick-start, §0.4 / G0 |
| L3 anchors | fixed: `qwen35.rs:43-44`, `attn_kernel.rs:589-593`, the mrope fields, `main.rs:408-417` | — | §1.2, §1.5, App. C / §3.1, G0 |
| L4 invariant 21 | fixed: a "what G8 does not change" list. Correction: the developer path is `EngineSupervisor.swift:102`, not `:100` | `gateway/infer.go:28`; `gateway/config.go:77` | — / §10.1 |
| L5 hyper-connections | fixed with corrected arithmetic: the preview's hidden is 2560, so the widened residual is 10240 (still > 7936), and its norm is grouped, so the need is a new op rather than a wider kernel | `X: mtplx/models/qwen4_exp.py:73, 103, 666-683, 1110-1111` | §1.2, §12 / §6.1–6.2, §12(a) |
| L6 untracked | fixed: status lines in both headers | `git status` at `b31ca91` | headers |
| missing #7: tokenizer | added: only `tokenizer.json` loads, `--tokenizer` reaches only GGUF (LOUD) | `model.rs:431-438, 466, 601, 714` | §1.2 / §9 |
| missing #8: MoE weight layout | added | `qwen35.rs:174-187, 212-225, 853, 1544`; `X: mtplx/models/qwen4_exp.py:2426, 2449-2455` | §12 / §12(b) |
| new: GDN norm gate (found while checking L5) | the Qwen4 preview's GDN norm gate is `sigmoid`; th hard-codes `silu(z)` and never reads `output_gate_type`: SILENT | `X: mtplx/models/qwen4_exp.py:92, 686-688`; `gdn_kernel.rs:430-443, 624-637` | §1.2, §12 / §0, §3.1, §12(a) |

Not applied (this edit's write scope is `engine/docs/`; code and reports are read-only): the guard, the stale `:218` comment and the new tests (plan G1, G2); the old headline in `engine/reports/perf-2026-09/README.md` and [LAND §0]; the split-decode claim in [LAND §4.1].
