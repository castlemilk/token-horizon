# th-engine optimisation pathway catalogue

> **What this is.** The optimisation space that the 2026-09-25..28 performance program explored on th-engine, organised as reusable lever families. It is meant for the next "new model optimisation job" (Qwen4, Gemma 4, an MoE or MTP-headed model, a new quant format), run by agents or by people.
>
> **Sources.** Distilled 2026-09-28 from `engine/reports/perf-2026-09/` (phases B–E, committed in `3b8a675`) and the engine source at `b31ca91`. At that commit the engine tree equals integration-4 `c2c1532`.
>
> **Conventions.**
> - Every figure is quoted from a report and carries a citation key (§1).
> - Unless stated otherwise, figures are for Qwen3.8-27B-4bit + the DFlash draft on an Apple M5 Max (40-core GPU, 128 GB, ≈565 GB/s measured). The reference engine is Splash 1.0 (brew). Decode figures are T=0 loop tok/s by ratio of sums.
> - Tags follow the reports: **[M]** measured, **[D]** derived, **[E]** estimate. This document adds **[I]** for its own inference; no number is ever attached to an [I].
> - Code references are `file:line` at `b31ca91`, under `engine/src/` unless a path is given.

## Contents

0. How to use this catalogue
1. Sources and citation keys
2. The trajectory: what moved the needle, in order
3. Floors and the round budget (L01)
4. The measurement protocol
5. Lever families L02–L19
6. Validation gates
7. Adversarial-review findings and the review checklist
8. Model dependence and the next-model playbook
9. Open pathways at HEAD
10. Harness and artifact inventory
11. Recommendations for the next model optimisation job

---

## 0. How to use this catalogue

### 0.1 Order of work for a new model

1. **Correctness infrastructure first (§6).** Get these running before any speed work:
   - a T=0 identity baseline against a reference implementation;
   - the state-bitwise rollback gate, for any model with recurrent state;
   - batch smokes;
   - the V-contract check.

   Every later lever is judged against these gates.
2. **Floors (§3).** Compute the bandwidth floor and the kernel-achievable floor for the new weights. Then record how far above them the first build sits.
3. **Baseline against a reference engine (§4).** Use one session, the protocol, and gated palindrome arms. Split the result into a per-round ratio and a tokens/round ratio.
4. **Phase split.** Break the decode round into propose / host encode / GPU tail / rest (`TH_DEBUG_TIMING`, engine.rs:1139). Break prefill into regions with R0c (`TH_GPU_PROF=1`, gpuprof.rs:305). Read the *detection signal* of each family in §5 and start with the largest.
5. **Implement one lever per branch or lane.** Put each behind a read-once env A/B arm and give it a bitwise unit test where the design allows. Measure it in-binary and ABBA, and tag every number [M]/[D]/[E].
6. **Review each branch with the checklist (§7.2).** Run the full gate suite again on the integration head: semantic merge bugs are real (§7.1).
7. **Check §8 before assuming a Qwen3.8 gain transfers.**

### 0.2 Triage: symptom → lever family

| What the measurement shows | Look at |
|---|---|
| idle = round − GPU-busy is more than ~1 ms; propose / host encode dominate; ms/round moves with CPU load | L02 host idle, L03 allocation |
| many blit fills or blit encoders per round; host encode inflated after syncs | L03, L04 |
| phys_footprint spikes during long prompts, even though RSS looks small | L18 |
| decode matmul GB/s far below ~480; prefill GEMM TFLOPS far below the MMA ceiling | L05, L06, L13 |
| the decode round grows with context (propose and/or verify GPU tail) | L09 (and L07a draft attention) |
| tokens/round below the reference on byte-identical text; capped chains | L07b |
| sampled round costs more than the greedy round (`rest` phase) | L07c, L16 |
| snapshot or rollback host time; state-bitwise mismatches | L08 |
| cold TTFT dominated by `attn.core` / Q4 GEMMs / `gdn.core` | L10 / L13 / L12 |
| repeated prefixes pay the full prefill | L14 |
| cold TTFT regressed after a "decode-side" change | L11, L17 |
| arms of one binary disagree with each other | L19 and §4 |

---

## 1. Sources and citation keys

All paths are under `engine/reports/perf-2026-09/`. A key like `[C §2.2]` means section 2.2 of that report.

| key | file | content |
|---|---|---|
| [B] | `PHASEB-REPORT.md` | baseline vs Splash; 14 confirmed bugs; kernel branches; integration-sim `8d5b6d5`; floors |
| [Bb] | `PHASEB-baseline.md` | same-session baseline th-44aed06 vs live :8001 vs Splash (loaded machine); raw per-request data |
| [BQ] | `bench-quiet.md` | the first thermal- and CPU-gated protocol; integration-sim vs main vs Splash; the throttling finding |
| [C] | `PHASEC-REPORT.md` | integration-2 `521c6e0` (L1, D1, G1a, K7, N2, MEM-2, MEM-4): 1.03× Splash |
| [D] | `phaseD/PHASED-REPORT.md` | integration-3 `e452a7b` (N3/N4, gpu-tail, S1/B1, prefix cache): 1.24× |
| [E] | `phaseE/PHASEE-REPORT.md` | integration-4 `c2c1532` (fused prefill attention, prefill GEMM, TTFT regression): 1.20× decode, cold-TTFT parity at 1.45k |
| [K45] | `impl-th-wp2-matmul-roofline.md` | K1/P0/K2/K45: decode tile policy, presum blocks, autotune sweep |
| [T2] | `impl-th-wp10-prefill-tiles.md` | small-M prefill tiles; batched-decode routing |
| [U1] | `impl-th-wp1-utf8-stream.md` | UTF-8-safe streaming; V-lin timing-noise study |
| [RI] | `review-integ.md` | adversarial review of integration-sim |
| [CL] | `th-c-loop.md` | L1 verify-all-7, Q1 QoS, D1 one propose sync, anchor off-by-one |
| [CG] | `th-c-gdn-parity.md` | R0a state-bitwise gate, G1a parity state |
| [CP] | `th-c-ports.md` | K7 m=1 matvec, N2 tie rule, MEM-2, MEM-4 |
| [DL] | `phaseD/th-d-longctx.md` | N3 split-key decode attention, N4 draft attention, long-prompt memory |
| [DG] | `phaseD/th-d-gpu-tail.md` | R0c profiler, GPU-tail kernels, the load-inflated claim that was withdrawn |
| [DS] | `phaseD/th-d-sampled.md` | R0b acceptance study, S1 GPU accept, B1 block verification |
| [DP] | `phaseD/th-d-prefix-cache.md` | T1 prefix cache, T1b grouped eager attention, T1c blit-free checkpoints |
| [EA] | `phaseE/th-e-prefill-attn.md` | E1 fused causal prefill attention (NAX) |
| [EG] | `phaseE/th-e-prefill-gemm.md` | E1(b) vectorized-epilogue prefill Q4 tile; chunk size; presum for prefill |
| [ET] | `phaseE/th-e-ttft-regression.md` | anchor fix, KvCap::Direct, deferred and restore-only checkpoints |

Secondary sources:
- `docs/MTPLX/README.md` and `docs/MTPLX/mistakes/*.md`, cited as [MTPLX].
- The repo's `AGENTS.md` invariant 21 (engine sidecar), cited as [AGENTS].

---

## 2. The trajectory: what moved the needle, in order

### 2.1 T=0 decode against Splash 1.0, same session

| build | phase | th ms/round | tokens/round | th loop tok/s | Splash tok/s | th / Splash | source |
|---|---|---|---|---|---|---|---|
| `441acec` | pre-program quiet reference | 87.2 | 3.545 | 40.65 | 72.4 | **0.56** [D] | [B §1.1] |
| `44aed06` | Phase B baseline, CPU load 26–49 | 104.5 | 3.450 | 33.0 | 63.8 | 0.52 | [B §0, §1.1] |
| `cf3e5f7` (main) | bench-quiet, nominal GPU | 63.87 | 3.450 | 54.02 | 78.56 | 0.688 | [BQ §4.1] |
| `8d5b6d5` integration-sim | bench-quiet | 54.67 | 3.605 | 65.95 | 78.56 | 0.840 | [BQ §4.1] |
| `521c6e0` integration-2 | Phase C s1+s2 | 47.16 | 3.843 | 81.49 | 78.97 | **1.031** (pooled) | [C §1.1–1.2] |
| `e452a7b` integration-3 | Phase D f2 | 39.53 | 3.843 | 97.20 | 78.22 | **1.243** | [D §1.1] |
| `c2c1532` integration-4 | Phase E S2 | 40.49 | 3.778 | 93.31 | 77.55 | **1.203** | [E §1.2] |

Notes on the table:
- The `441acec` row is not like-for-like. It was run at T=0.6 with no `top_p` sent, so th sampled with 0.8 and Splash with 0.95 [B §1.1].
- The `44aed06` row is inflated by CPU contention on a host-bound loop. The same binary ran 63.1 ms/round at load 2.3–3.5 [B §1.2].
- End-state standing in the other modes (integration-4 / Splash) [E §0]:
  - decode: sampled 1.115, ctx1500 1.179, ctxcold 1.213, ctx8k 1.026;
  - TTFT: cold 1.45k 1659 vs 1647 ms (quiet, 1.01×); cold 7.9k 11.77 vs 10.16 s (1.16×); exact repeats 24 / 22 ms vs 220 / 354 ms.

### 2.2 What each phase changed

**B, `cf3e5f7` → `8d5b6d5`, −8.6 ms/round.** About 9 ms of GPU work per round went away [B §4.2]. The sources were:
- the K1/K2/K45 decode tiles and presum blocks;
- the MEM-1 wasted GEMM;
- the GDN zero fills.

Host idle stayed at about 7.7 ms.

**C, `8d5b6d5` → `521c6e0`, +24.2% T=0 [C §2.4].**
- Structural host work: G1a −6.35 ms/round and D1 −0.91 ms/round.
- Acceptance: L1, +8.3% tokens/round on identical text.
- Idle fell from 7.1 to 1.3 ms/round. The round became GPU-bound [C §1.5].

**D, `521c6e0` → `e452a7b`, +20.1% T=0, ×2.5 at 8k [D §0].**
- GPU-tail kernels took out −7.06 ms of the verify GPU tail.
- N3/N4 made the round context-flat: +2.9 ms from bench context to 7.9k, against Splash's +2.7.
- S1 GPU accept; T1 prefix cache.

**E, `e452a7b` → `c2c1532`, prefill only [E §0].**
- Fused prefill attention, the vec GEMM tile, the TTFT regression removed, and restore-only repeats.
- Decode per round is equal within noise: T=0 ratio of sums 0.993 over both replicates [E §1.2].

### 2.3 Lessons from the trajectory

These are [I], but each follows directly from the cited numbers:
- **The largest early wins were structural.** Host syncs, state copies and allocation came before kernel wins. When the program started, th's GPU work per round was only about 4 ms (6–7%) more than Splash's; about 90% of the ms/round gap was GPU idle while the host worked [B §1.1].
- **Acceptance (tokens/round) is as valuable as kernel speed.** L1 alone was worth +12.5% tokens/round [CL §3].
- **Long context and prefill are separate programs from short-context decode.** They need their own kernels (N3, E1, and a chunked GDN scan that is still open).

---

## 3. Floors and the round budget (L01)

### 3.1 Definitions

- **F_bw, the bandwidth floor.** Bytes streamed per verify round divided by the measured bandwidth. On Qwen3.8-27B it is **29.8 ms/round** [B §1.1].
- **F_k, the kernel-achievable floor.** Every matmul at its measured per-dispatch fit with zero overhead. It is **≈36 ms/round** [B §1.1, §4.3].
  - The per-dispatch ramp is ≈8 µs. Together with the threadgroup count on 40 cores, it caps `in_all` and `down` below the 480 GB/s target [K45 §3.1, §8].
  - The full F_k derivation lived in SYNTHESIS v2. SYNTHESIS was wiped from the scratchpad and recovered only to `/tmp/k45u/` [B header; K45 §0], so it is **not in the repo** (recommendation R5).

### 3.2 Budget decomposition used by every phase

- **Verify matmul fit:** ≈30.9 ms/round. This is per-class K45 serial-bench time × calls: gate_up 188.5 µs ×64, down 125.3 ×64, in_all 103.7 ×48, out 41.6 ×48, in_qkv 99.1 ×16, o 54.6 ×16, lm_head 1347 ×1 [B §4.2].
- **Draft forward:** 1.65 GB streamed, a bandwidth floor of ≈2.93 ms [B §4.2].
- **Gap to F_k over time:**

  | build | gap to F_k | of which | source |
  |---|---|---|---|
  | B integration | 18.5 ms | idle ≥ 7.7 + GPU work beyond the fit ≤ 10.9 | [B §4.3] |
  | C | ≈11.2 ms | idle ≈ 1.3; ≈ 7.5 of the verify tail beyond the matmul fit; ≈ 3.3 draft-side | [C §6.1] |
  | D | ≈3.5 ms | — | [D §1.2] |
  | E | ≈3.5 ms | plus ≈ 1 ms over D's round, attributed to other GPU clients (55–94 vs 28–37 ms/s) | [E §1.3, §6.2] |

- **Other ceilings recorded:**

  | ceiling | value | source |
  |---|---|---|
  | prefill Q4 MMA-only (int4 × bf16) | 61–65 TFLOPS; the vec tile reaches 91% of it | [EG §3] |
  | in-situ prefill GEMM | ≈70–75% of the isolated rate | [EG §10] |
  | split-key decode attention at 8k | 261 GB/s effective vs ≈500 achievable | [DL §2.2] |
  | fused prefill attention at 512:7168 | ≈11–12 TFLOPS effective vs ≥25 TFLOPS MPP GEMM | [EA §6] |

### 3.3 Detection signals

- Phase split against GPU-busy: round − ioreg GPU slope = idle.
- A per-class GB/s table from `TH_BENCH_Q4` (main.rs:440), in serial mode with a buffer barrier per call [K45 §1].
- Per-region GPU ms from R0c.

### 3.4 Pitfalls

- **The ioreg GPU-busy slope double-counts overlapping command buffers on th.** Validated only on Splash's one-CB-per-round engine. So th's GPU-busy is an upper bound and its idle a lower bound (it went negative once) [B §4.2; C §1.1].
- **Cross-session GPU-busy comparisons are unsafe.** Phase B's claim that th did less GPU work per round than Splash did not survive a same-session run; at nominal clocks the two were equal [BQ §0].
- **A profiled run is not the served run.** `CANDLE_METAL_COMPUTE_PER_BUFFER=1` adds ≈5 µs per command buffer, and the profiling arm ran 9.3 ms/round slower [DG §2, §4].

### 3.5 Model dependence

**S.** The method transfers. Recompute everything from the new model's safetensors byte counts, re-measure the per-dispatch fit with `TH_BENCH_Q4`, and use the new layer mix.

---

## 4. The measurement protocol

The protocol is itself a deliverable of the program. Almost every wrong conclusion the reports caught was a protocol failure, not a code failure (§4.7, §7.1).

### 4.1 Metric definitions

**Decode throughput.**
- **Loop tok/s** = Σ emitted tokens / Σ round-ms over the logged `[dflash]` rounds (engine.rs:1139). The prefill-sampled first token and the final, unlogged round are excluded [B §0; C header].
- **Splash** is measured as `decode_output_tokens / decode_wall_ms` from `/status` deltas.
- **Like-for-like** removes Splash's prefill-sampled token: [Σ(comp−1)/Σrounds_all]/ms_round. It moves ratios by at most 0.01 [BQ §2].
- A ratio against the reference is always reported as **per-round ratio × tokens/round ratio**, e.g. 1.203 = 1.199 × 1.004 [E §0].
- **Ratio of sums everywhere.** The stock `scripts/bench-engines.sh` "decode" figure overstated every engine. It read th 39.2 vs 33.0 measured, Splash 76.7 vs 63.8, and the live :8001 build 93–108 vs 38–41, the last because of bug M1 [Bb caveat 3; B §1.1].

**Sampling settings.**
- **"Sampled" / "T=0.6"** means temperature 0.6, top_p 0.95, top_k 20, all sent explicitly.
- Use **odd seeds** (1/3/5): the sampler seeds with `seed | 1` (engine.rs:1367), so seeds 2k and 2k+1 collide [B §2.4].
- Without an explicit seed the default seed makes "sampled" output identical across repeats: 6 repetitions become 3 distinct samples [Bb caveat 2].

**GPU time.**
- **GPU-busy ms/round** is the least-squares slope of per-request engine GPU ms (ioreg `accumulatedGPUTime`) against rounds_all; the intercept absorbs the prefill.
- **idle** = client decode-wall slope − GPU slope [BQ §2].
- The slope is an upper bound for th, which has several overlapping command buffers per round, and it is meaningless when an arm mixes cold prefills and cache hits [B §4.2; D §1.1].

**Latency and memory.**
- **TTFT** is client time to the first streamed content or reasoning delta [BQ §2].
- **Engine TTFT** splits into *enqueue* (prompt / `th_stats.prefill_tps`, which is host enqueue because the prefill timer is unsynced, engine.rs:657-665) and *rest* (GPU drain + first sample) [D §1.5; DL §4.1].
- **First-token gap** is the time from the 1st to the 2nd streamed delta [E §1.4].
- **Memory** is peak phys_footprint minus the pre-request footprint (`proc_pid_rusage`) [E §1.5].

**Acceptance.**
- **Tokens/round on byte-identical text:** rounds = th logged rounds + 1; for Splash, `decode_batches` [C §1.6].

### 4.2 Session recipe (every phase used a variant of this)

**Setup.**
1. **Build in a worktree** (`.worktrees/_phaseC/bin/wt-bootstrap <branch> [start]`, with an APFS-cloned `target/`). Never edit, build or reset the main tree while another agent works there.
2. **Freeze binaries.** Copy each binary out, record its sha256, and `cmp` it against the worktree build.
   - Rebuilding at a different path changes only LC_UUID and the code signature [BQ §1].
   - No th build embeds a git sha [ET header].
   - The app-side equivalent is AGENTS.md invariant 13.
3. **Hold one exclusive `gpu-lock`** (flock on `/tmp/th-engine-gpu.lock`) for the whole session. Builds need no lock.
4. **Ports.** Use a private port per lane. Never touch :8001 (the app-attached engine).
   - Start Splash only on a free :8000, and only while no th server is up.
   - Splash's memory governor refused to start with th resident: it needed ≈17.4 GB plus ≈13.7 GB protected [Bb].

**Arms.**
5. **Arm order is a palindrome**, so every engine has one arm in each half, e.g. `new base splash old | old splash base new` [E §1.1].
   - Start a fresh server per arm, with `TH_DEBUG_TIMING=1` and `TH_BATCH` unset.
   - Send two unrecorded warm-ups: a short prompt, then passage + "Say hi." (this primes the caching engines) [BQ §2; D §1.1].
6. **Suite per arm** [BQ §2; D §1.1; E §1.1]:
   - greedy: 3 bench prompts × 3 (short / code / long = 58 / 68 / 80 prompt tokens), 128 max tokens;
   - sampled: seeds 1/3/5;
   - **ctx1500**: the 1373-token passage (sha1 `a886db14acc4`) + prompt, which is a warm hit on caching engines;
   - **ctxcold**: a unique nonce `Note k.` + passage + prompt;
   - **ctx8k**: `passage8k.txt` (sha1 `6ab8ad9a056a`, 7853 tokens) + prompt;
   - a **TTFT spec**: cold 1.45k with nonces, exact repeats, another question after the same document, cold 7.9k, and multi-turn turns 1–3.

**Recording.**
7. **Per request, outside the timed window,** record [BQ §2]:
   - server-log byte offsets;
   - Splash `/status` deltas;
   - ioreg GPU ns and `ps` CPU time of the engine pid;
   - load1 and thermal level.
8. **Run samplers for the whole session:** `top -l 0 -s 3`, a thermal loop, IOReport P-states (`gpufreq.py`), per-arm deltas for other GPU clients (`gpuq.py`), and a phys_footprint guard (64 GB) [D §1.1; E §1.1].

**Analysis and cleanup.**
9. **Analysis:**
   - ratio of sums per engine × mode;
   - a per-arm drift check;
   - per-round phases;
   - identity and first divergence;
   - identical-text rounds;
   - a conditions table [C App. A].
10. **Cleanup** [C App. B; E App. B]:
    - Stop th servers with SIGTERM → KILL plus a port check.
    - Stop Splash with SIGINT → TERM/KILL, including its `serve-native` child.
    - Release the lock.

### 4.3 Gating and redo rules (as they evolved)

**bench-quiet** [BQ §2]. Before each arm:
- thermal pressure level 0 (`notifyutil -g com.apple.system.thermalpressurelevel`);
- CPU idle ≥ 85%;
- other GPU clients ≤ 60 ms/s.

**gpu-tail quiet re-measure** [DG R3].
- Hard gate: thermal 0 **and** load1 < 5, both held for 30 s.
- Redo an arm if >10% of its requests start at load1 ≥ 8, any start at ≥ 12, >10% run at thermal ≥ 2, or any errors. Keep the dirty attempts under `attempts/`.
- Use `gpu-lock-quiet`, which only takes the lock while load1 has stayed below a threshold, so the lock is never held idle behind a gate.

**Phase D final** [D §1.1].
- Two-tier gate: thermal 0 + load1 < 6 held 30 s, then thermal 0 + load1 < 9, then soft.
- Redo on mid-arm contamination.
- Each ctx8k request waits, outside the timed window, for thermal 0: cold 8k prefills heat the SoC to level 2 within one request, and the first final hold was aborted for this.

**Phase E** [E §1.1] (a noisier machine).
- Tier 1: thermal 0 + load1 < 12. Tier 2: thermal ≤ 1 + load1 < 25 + CPU idle ≥ 25%.
- One attempt per arm; per-request thermal gates in block L.
- Redoing was dropped: 18 back-to-back cold prefills heat the SoC, so a redo cannot fix that arm.
- The decode standing comes from the quiet replicate; the loaded replicate is reported beside it.

### 4.4 Instruments

| instrument | what it measures | caveat | source |
|---|---|---|---|
| `TH_DEBUG_TIMING=1` (engine.rs:302) | `[dflash]` propose / verify / rest, `vlen`, `prop_ms` (:1139); `[verify] enqueue` and gpu+readback (:1050) | `[verify] enqueue` is timed from round start, so it includes propose: subtract it | [B §2.4; CL §2] |
| ioreg `accumulatedGPUTime` | GPU-busy slope | double-counts overlapping CBs on th | [B §4.2] |
| IOReport P-states (`gpufreq.py`, no root) | GPU clock per 2 s window (P1–P13 = 338–1620 MHz) | use windows at least 80% inside one decode | [BQ §2, §3.1] |
| R0c `TH_GPU_PROF=1` (gpuprof.rs:305) | exclusive GPU ms per (phase, region, kernel); markers are relaxed no-ops when off | with `CANDLE_METAL_COMPUTE_PER_BUFFER=1`, +≈5 µs per CB: use it to rank, not to claim savings | [DG §2, §4] |
| `gpuprof::drain_busy_ms` (gpuprof.rs:403) | GPU-busy-timed sweeps and probes | host wall-clock sweeps drifted ±40% under load | [EG §1–2] |
| `mtlc` Metal interposer (`DYLD_INSERT_LIBRARIES`) | per round: `waitUntilCompleted`, commits, encoders, dispatches, fills | counts only, not timing; its source is out of the repo | [CL §5] |
| `MTL_SHADER_VALIDATION=1` | out-of-bounds device loads | MEM-1 produced 157 reports; `MTL_DEBUG_LAYER=1` aborted on an arg-type mismatch | [B §2.1, §2.4; RI] |
| phys_footprint (`proc_pid_rusage`) guard | real footprint, including candle's private Metal pool | ps RSS is blind: 4.2 GB at a 119 GB footprint | [DL §6.1] |
| standalone GPU-timestamp harness | isolated kernel µs against the MMA-only ceiling | in situ ≈70–75% of the isolated rate | [EG §3, §10] |
| in-process interleaved probes (`TH_BENCH_MULTI`, `_PREFILL`, `_BATCH`, `_TTFT`, `_PREFILL_LOGITS`; `TH_BENCH_ROUND` on a probe branch) | paired A/B inside one process, from restored state | the probe loop is not the server loop; the paired Δ is the robust quantity | [DL §1.1; T2; ET §3.6] |
| `th-engine probe --dump` | last-position logits file | compare bytes (`cmp`) | [EG §8; E §1.6] |

### 4.5 Estimators and statistics

- **Ratio of sums over pooled arms.** Check that each engine's two arms agree; in Phase D they agreed to 0.1–0.7% on ms/round [D §1.1].
- **On a loaded machine, use `min`** as the contention-robust estimator for in-process probes [DL §4.3]. `TH_BENCH_ROUND` reports the median over processes of each process's min [DL §1.1].
- **Pair TTFT samples by position** (arm k of each label, same request position) and bootstrap them. The first cold request of an arm is the fastest (≈2.1 s against 2.5–2.6 s) [ET §3.2; EG §9.2].
- **Tokens/round and loop tok/s** get a prompt-cluster bootstrap (B = 5000) [DS §8.3].
- **Keep a T=0 control on unchanged code** inside the same arms. It bounds the arm-to-arm noise: ±3–5% at load 11–27 [DS §8.3].
- **Acceptance** is compared on identical text, or with Rao-Blackwellised E[accepted | block] on the same drafted blocks, which does not depend on the sampled trajectory [DS §2].
  - Nine fixed sampled streams are not evidence. Phase C's 0.894× acceptance gap became 1.002× over 75 streams [C §6.2; DS §2].

### 4.6 Identity accounting

- **Normalise before comparing.** T=0 texts are compared after stripping `</think>`, which th streams as content and Splash drops [BQ §5.2].
- **Report the first divergence** as a character index plus a re-tokenized token index [BQ §2].
- **Determinism:** each engine must be text-identical across its own arms; integration-4 was 59/59 [E §1.6].
- **Near-tie class.** A divergence that recurs at the same positions across builds is a rounding flip at a near-tie, not a bug. Known positions [BQ §4.3; D §1.3; E §1.6]:
  - "Need produce / provide" at token 22–23;
  - ctxcold code @113, long @14 and @52;
  - ctx8k code @29/30.
- **The server-level identity unit** is "42/42 texts · 42/42 per-round `[dflash]` logs" over the 43-request `spec_a3` [DP §3.3].
- **Batched identity** needs identical batch composition [B §2.2; RI].

### 4.7 What contamination does to the numbers

| effect | observed | source |
|---|---|---|
| CPU load on a host-bound loop | 63.1 → 104.5 ms/round (load 2.3–3.5 → 26–49); GPU-busy also rose 55.9 → 63.0 (shared memory bandwidth) | [B §1.2] |
| CPU load once the loop is GPU-bound | load1 ≈45–49: +5–14% ms/round in sampled/ctx modes, all of it host-side | [E §1.1] |
| 18 CPU spinners, one per core | +5.7 to +6.6 ms/round at T=0, with or without QoS | [CL §4] |
| GPU contention | it moves the GPU tail: 39.2 vs 33.0 ms at equal load1 | [E §1.1] |
| thermal throttling | Splash −11%, th −3%, so th/Splash reads ≈8% high; a throttled Splash arm would have read 1.109× | [BQ §3.2; C §1.2] |
| loaded lane A/B | ×1.301 loaded vs ×1.194 quiet; the base arm was 45% inflated | [DG §4, R3] |
| swap / idle paging (42–58 GB swap) | an engine paged out → a 90.6 s cold 8k; 3 s idle gaps → "+313 ms first-token gap" (withdrawn) | [ET §0, §3.2] |
| shader cache keyed per binary path | a never-run path recompiles every kernel on its first request | [T2 methodology] |
| sequential sweeps / separate processes | identical kernels drifted up to 2×; the same forward drifted up to 30% across processes | [T2 methodology] |
| V-lin single-shot timing | A/A geomean band 0.73–1.40 on identical kernels | [U1 review fixes] |
| a GPU user that does not take the lock | replayd bursts of 44–87% GPU contaminated rounds 2–3 | [K45 §5.3] |
| per-arm spread of one binary | ±7% (EG host); ±8% S1 / ±3–5% S2 | [EG §0; E §1.1] |

MTPLX logged the same failure classes independently [MTPLX mistakes/]:
- `back-to-back-ab-arms-on-the-27b-read-a-30-percent-thermal-throttle-as-a-policy-effect…`
- `two-ab-rounds-measured-a-stale-2-7-binary…`
- `piped-build-output-masked-a-failed-swift-build…`
- `mean-tps-and-sliding-averages-hid-thirty-sub-second-emit-silences…`: felt smoothness is the p99 inter-emit gap. This one is relevant to the U1 SSE cadence and the first-token gap.

### 4.8 Reporting rules

- Tag every number [M]/[D]/[E]. Name the build (sha256) and state per-arm load and thermal conditions [B §0].
- **Withdraw figures that do not transfer.** gpu-tail withdrew ×1.301 [DG R2]; ttft-regression withdrew two first-run claims [ET §0].
- **Keep the old path as a read-once env arm.** It removes build, binary-path and shader-cache confounds [DG §2].
- **Separate "cost moved" from "cost removed."** Deferred captures moved ≈+46 ms at 7.9k into the first-token gap [ET §3.4].

---

## 5. Lever families

### 5.1 How to read the cards

Each lever family is a card with the same fields: **mechanism**, **detection signal**, **measured on Qwen3.8**, **validation gates**, **pitfalls**, **model dependence**, **code anchors**, and **still open** where it applies.

Model dependence uses three grades:
- **A**: architecture-agnostic engine mechanics. It transfers as-is.
- **S**: transfers after re-tuning for the new shapes or hardware (re-run the sweep or probe).
- **X**: architecture- or draft-specific. Rebuild it for the new architecture, or it does not apply.

### 5.2 Overview

| # | family | detection signal (harness) | best measured Qwen3.8 effect | main gates | dep. |
|---|---|---|---|---|---|
| L01 | floors / roofline (§3) | F_bw, F_k vs round; GPU-busy slope; `TH_BENCH_Q4` | targeting only: gap to F_k went 18.5 → ≈3.5 ms | — | S |
| L02 | host idle & sync count | idle = round − GPU slope; syncs per round (interposer); `TH_DEBUG_TIMING` phases | G1a −6.35 ms/round; D1 −0.91; idle 7.1 → 1.3 | R0a; T=0 identity | A |
| L03 | buffer pool / allocation | fills and blit encoders per round; host encode after syncs; `TH_OUT_ZEROS` arm | MEM-2 fills +2.84 ms/round removed; N3 scratch ctx8k −14.5% | `TH_OUT_ZEROS` identity; shader validation | A |
| L04 | dispatch count & CBs | dispatches/encoders per round; R0c regions; 64-CB cap | GPU-tail kernels: T=0 ×1.194 (−7.7 ms/round) | bitwise unit tests with mutation check | A/S |
| L05 | quant matmul tiles & autotune | `TH_BENCH_Q4` GB/s vs ≥ 480; `TH_BENCH_Q4_SWEEP`; `TH_BENCH_MULTI` | K1/P0/K2/K45: T=0 64.11 → 56.40 ms/round (−12%); K7 plain +9.4% | V-lin; V-multi; probe logits; T=0 identity | S/X |
| L06 | producer-emitted sums / fusion | recompute barriers, pad copies; `TH_Q4_PRESUM=0` arm | presum −3.2 to −4.1 ms per forward | emit check max\|Δ\| 0; presum on/off identical | S/X |
| L07a | draft cost | propose ms vs ≈2.9 ms draft floor; propose growth with ring length | N1 +4.7% tok/s; N4 4.63 → 0.47 ms/propose at a 1.45k ring | split1 bitwise; T=0 identity | X |
| L07b | acceptance & verify length | capped chains; identical-text rounds; R0b / `TH_ACCEPT_STATS` | L1 +12.5% tokens/round; B1 ×1.0091 | B1 exactness tests; check mode | A/X |
| L07c | sampled accept on GPU | sampled − greedy round delta (`rest`) | S1 −2.96 ms/round in-binary | `TH_SAMPLE=check` 0 mismatches | A |
| L08 | state snapshot / rollback | host encode incl. `snapshot()`; R0a mismatch counts | G1a −6.35 ms/round; TH_BATCH=2 −13% | R0a + `TH_GDN_COMMIT=step` must fail | X |
| L09 | attention decode (split-key) | round growth vs context; per-layer attention ms | ctx8k 108.62 → 42.41 ms/round | split vs single-pass test; R0a split-everywhere | S |
| L10 | attention prefill (fused flash) | R0c `attn.core` share; `TH_BENCH_PREFILL_ATTN` | cold 7.9k TTFT −39%; 1.45k −11.8% | eager arm bitwise; logits vs noise floor | S/X |
| L11 | KV layout / capacity / quant | K/V cat + regrowth in prefill; TTFT split | KV-cap regression +90–100 ms found and removed; Direct store | KV-mode arms 42/42 | A/S |
| L12 | GDN scan | R0c `gdn.core`; µs per call | open: 145 ms at 1.45k, 750 ms at 7.9k is the target | R0a; prefill logits | X |
| L13 | prefill GEMM tiles & chunk size | in-situ TFLOPS vs MMA ceiling; `TH_BENCH_STEPS` | E1(b) GEMMs −12/−14% (normalised); T2 short TTFT −8 to −11% | bitwise vec tile; policy tests | S/X |
| L14 | prefix cache & checkpoints | TTFT on repeats and follow-ups; hit == miss | exact repeats 13–34 ms; 1.4k prefix 21× | hit == miss; `=0` / `=grid` == main; restore probe | A/X |
| L15 | batching (multi-slot) | aggregate vs single stream; composition | T2 routing −19.4% ms/round at TH_BATCH=4 | TH_BATCH smokes; composition-matched identity | A/S |
| L16 | sampling paths | `rest` ms; per-row distribution cost; tie rate | full-vocab-sort fix −21 to −30 ms/round (top_k 0) | check mode; exactness; tie tests | A |
| L17 | TTFT / first-token gap | enqueue vs rest; 1st → 2nd delta gap | ttft-regression cold 1.45k −123 ms | first-token logits bitwise; hit == miss | A |
| L18 | memory transients | phys_footprint peak per request | 8k transient +17.3 → +7.2 GB; 7.9k +12.6 → +3.4 GB | footprint guard; TTFT unchanged | A |
| L19 | thermal / DVFS | thermal level, P-state residency, arm drift | protocol: throttling skews ratios ≈8% | gating rules (§4.3) | hw |

### L02 Host idle and sync count

**Mechanism.** The decode round is host-driven: encode propose → sync → encode verify → sync → accept / commit / roll back. Host work between syncs is GPU idle. candle also purges its buffer pool at every sync (L03), so extra syncs make allocation expensive too. Splash runs one command buffer and one host sync per round [C §6.1].

**Detection signal.**
- idle = client round − ioreg GPU slope; this is a lower bound for th [BQ §2].
- Round phases from `TH_DEBUG_TIMING` (engine.rs:1139): propose / verify / rest. Host encode = `[verify] enqueue` − propose (engine.rs:1050).
- Host syncs per round from the `mtlc` interposer [CL §5].
- Sensitivity test: run the same binary under CPU load. A host-bound loop moves (63.1 → 104.5 ms/round) [B §1.2].

**Measured on Qwen3.8.**
- **Baseline `44aed06`.** About 90% of the ms/round gap to Splash was GPU idle; th's GPU work per round was only about 4 ms more than Splash's [B §1.1].
- **D1: host-resident 254 MB codebooks and one packed readback.**
  - `waitUntilCompleted` per round 6.00 → 2.00; propose 8.27 → 7.36 ms; round −0.91 ms (−1.6%) [CL §5].
  - That is ≈0.23 ms per removed sync.
- **G1a** (see L08). Verify host encode 8.00 → 2.72 ms; idle 6.68 → 1.31 ms/round; host CPU 15.67 → 8.39 ms/round; round −6.35 ms [CG §0].
- **Combined (integration-2).** Idle 7.1 → 1.3 ms/round and server CPU 15.8 → 4.5 ms/round; the round is now GPU-bound [C §1.5].
- **Readback size.**
  - The greedy verify readback shrank from 4 MB to 36 B (Metal argmax) [B §5.1].
  - The S1 sampled readback is 16 words instead of `[8, 248320]` bf16 [DS §3].
- **Q1: decode thread at USER_INTERACTIVE QoS.** −0.27 ms/round ambient and −0.47 with 18 spinners, both inside the arm spread, so the default is off [CL §4].
  - The thread already blocks in `waitUntilCompleted` for ~38 ms per round, so the scheduler boosts it on wake-up.
  - The loaded slowdown also raised GPU-busy, which QoS cannot fix.

**Validation gates.** Token identity (D1: 24/24) [CL §5]; R0a for G1a (L08); interposer counts before and after.

**Pitfalls.**
- `[verify] enqueue` includes propose [B §2.4].
- Shortening host encode can *raise* the measured verify GPU tail, because less GPU work overlaps the encode: 37.6 → 38.4 ms while GPU-busy fell 47.7 → 45.7 [C §1.5].
- Loaded sessions inflate the host phases: propose +1–3 ms and host encode +1.4–2.8 ms at load1 ≈45–49 [E §1.1].

**Model dependence: A.** The sync count follows the speculative scheme (select → verify → accept), not the layer types [I].

**Code anchors.**
- engine.rs:1000 / :1007 / :1047 (`t_prop`, `t_fwd_enqueue`, `t_verify`); :338 `decode_qos`.
- dflash.rs:259 `pred_cb: Vec<bf16>`; :674 `cand_tables` (one packed readback); :1017 `gather_cb` (host).

**Still open.** X1/X2, an own queue with one CB per round, is worth at most the remaining ≈1.3 ms of idle [C §6.2]. Integration-3 idle was ≈1.1 ms [D §1.2].

### L03 Buffer pool and allocation behaviour

**Mechanism.**
- candle 0.11 frees pooled buffers only at a host sync, and inserts every buffer it allocates into an `MTLResidencySet`, so the pool is wired [DL §6.2].
- `Tensor::zeros` is a blit fill. It ends the open compute encoder and waits on every live fence [B §2.1; ET §2.1].
- So every fresh buffer after a sync costs a new wired MTLBuffer plus a residency commit, and every zero fill splits the encoder.

**Detection signal.**
- Interposer fills and blit encoders per round. The integration head had 72 fills and ~100 blit encoders splitting 110–120 compute encoders per round [CL §9].
- Host encode that grows after syncs.
- The in-binary `TH_OUT_ZEROS=1` arm (outbuf.rs:16).
- The `TH_BENCH_ALLOC` probe (main.rs:228 → outbuf.rs:196).

**Measured on Qwen3.8.**
- **MEM-2: seven zero-filled kernel outputs.** +128 fills per verify, +35 per propose, +5 per commit; 118 extra compute-encoder restarts; ≈11.8k extra `waitForFence`; ≈150 MB of fill traffic.
  - Cost: **+2.84 ms/round** (95% CI 2.18–3.50) [B §2.1].
  - K45(a) removed 96 of the 128 verify fills. Porting the last 5 sites gave −0.37 ms/round [CP §4.3].
- **MEM-3.** A fresh zero-filled 40 MiB draft ring per slot per round cost +4.61 ± 1.03 ms/round at nb=4 [B §2.2].
- **Snapshot copies** were 48 × 3 MiB per slot per round; the MEM-3 verifier measured 24.3 ms/round of snapshot at nb=4 [B §2.3, §5.2]. G1a removed per round per slot:
  - 96 × 4 MiB state copies;
  - the conv-window cat and contiguous copies;
  - 48 pack allocations.

  The cost is +≈195 MiB persistent per slot; the gain is −192 MiB transient per round [CG §2; C §2.2].
- **N3 persistent partials scratch.** The pool trim at every sync used to re-create 32 buffers per verify. ctx8k 64.86 → 55.45 ms/round (−14.5%); host encode 7.2 → 3.5 ms [DL §1.4].
- **T1c: checkpoint copies as compute dispatches.** Previously about 100 blits per checkpoint. Capture 28–50 → 8.5–17.5 ms at 1.4k; restore 8–16 → 3.5–5.0 ms [DP §0].
- **Inline prefix captures** (≈130 fresh `Tensor::empty`, ≈315 MB at 1408) cost ≈+125–170 ms of cold TTFT in situ; the allocation mechanism is [E] [D §1.5]. Measured host enqueue: inline +94 ms, deferred +3 ms [ET §3.6].
- **Allocation-free clear.** The clear used to run twice per request with ≈256 blit encoders. Host time 6–11 → 0.4–0.8 ms [ET §2.1].
- **K/V reserved once per prefill.** A 7.9k prompt stopped regrowing 2048 → 5120 → 11264 rows mid-prefill (1.21 GB allocated, 7168 rows copied); it now takes one 8192-row reserve (0.54 GB) [ET §2.2].

**Validation gates.**
- `TH_OUT_ZEROS=1` vs default must give identical streams: any unwritten element reads stale data in one arm and zeros in the other [CP §4.2].
- `MTL_SHADER_VALIDATION=1`.
- KV arms (`TH_KV_RESERVE=0`, `TH_PREFIX_CACHE_KV=copy`) must be 42/42 · 42/42 [ET §4].

**Pitfalls.**
- **The untracked-Arc class.** `MetalStorage::new(existing_buffer.clone())` escapes candle's pool accounting, and the pool later recycles a live buffer. The symptom is silent: acceptance collapses to 0 [T2 review; K45 §7].
  - Every integration re-checked the "MetalStorage clone-escape class" [C §4; D §4.1; E §4].
  - All new outputs must be fresh pool buffers (`outbuf::kernel_out`, `new_buffer_builder`).
- **Copies that are not copies.** In candle 0.11 Metal, `Tensor::copy()` is an Arc clone (it aliases), and `affine(1, 0)` flushes −0.0 to +0.0. Use `slice_set` or the word-copy kernel for bit-exact copies [CG §2].
- **Some memory must stay initialised.**
  - `ensure_kv` growth stayed zero-filled while the anchor off-by-one existed [CP §4.1].
  - K/V tails must stay finite (L11).
- **Bucket reuse.** Pool reuse hands any free bucket at least as large as the request, so small long-lived tensors can pin large buckets [DL §6.2].

**Model dependence: A.**

**Code anchors.**
- outbuf.rs:31 `kernel_out`, :51 `copy_uninit`, :108 `zero_rows`, :133 `copy_rows`, :159 `zero_all`, :174 `copy_into`.
- quant_kernel.rs:3413 `AllocBf16`; attn_kernel.rs:950 `split_scratch`.
- qwen35.rs:1789 `state_copy`, :1800 `state_copy_uninit`, :3832 `kv_reserve`; engine.rs:542 / :641 reserve sizing.

### L04 Dispatch count and command buffers

**Mechanism.**
- The per-dispatch ramp is ≈8 µs [K45 §3.1], and small latency-bound kernels dominate the non-matmul GPU time.
- candle commits a command buffer every 50 encoders (`CANDLE_METAL_COMPUTE_PER_BUFFER`).
- A `newCommandQueue` caps uncompleted CBs at 64, and `commandBuffer()` blocks the host at the cap. A 512-row prefill forward is ≈1000 dispatches, i.e. ≈20 CBs [DL §4.2].

**Detection signal.**
- Interposer counts per round. `8d5b6d5` had 812 dispatches, 110 compute and 95 blit encoders, 22.6 commits, 72 fills and 6 syncs [CL §5].
- R0c regions (`TH_GPU_PROF=1`) with one dispatch per CB, for ranking only [DG §2].
- A shift between enqueue and rest: at the 64-CB cap, the host waits in a different place, but the total does not change [DL §4.2].

**Measured on Qwen3.8 (quiet ABBA).** The gpu-tail lane made these changes:
- one dispatch for every GDN rollback commit;
- add+RMSNorm with one threadgroup per row (the old kernel walked 160 dependent loads per lane);
- the GDN step at 32 simdgroups per head;
- ChunkTop16 draft select;
- one ring-write dispatch per layer;
- draft presum producers;
- head views.

Together: T=0 **47.46 → 39.75 ms/round (×1.194)**, sampled ×1.174, ctx1500 ×1.144, ctxcold ×1.158, ctx8k ×1.108. About 7.1 of the 7.7 ms is verify-forward GPU work; the draft-side items together are worth ≈0.3 ms/round [DG R3].

Also:
- **MEM-4, dead ring gathers.** +0.15 ms per propose at ring 128, up to +1.40 at 2048 [B §2.1]. Ported: propose 17.09 → 15.78 ms at a 1.8k ring [CP §5.2].
- **Per-call env reads.** ≈70 `getenv` per round [RI]; `TH_DRAFT_EAGER` alone was 35 per propose [CP §5.1].

**Validation gates.** Bitwise-by-construction unit tests, each of which fails under a one-ulp mutation [DG §3]:
- `add_rmsnorm_per_row_matches_legacy_bitwise`
- `gdn_widths_match_original_bitwise`
- `cand_packed_fused_matches_sort_bitwise`
- `ring_write_matches_scatter_bitwise`
- `draft_presum_producers_match_plain_bitwise`

Plus T=0 identical id streams: greedy 36/36, ctx1500 36/36, ctxcold 12/12 [DG R3].

**Pitfalls.**
- **Profiler-mode per-item numbers are not savings.** "Verify norms 10.66 → 1.96 ms/round" was withdrawn [DG §4].
- **Loaded A/Bs overstate latency-bound kernel wins by about 2×** [DG §4].
- **A tiny-shape test is not enough.** The rows-in-flight GDN kernel was bit-identical on the tiny test shape, not identical at 27B, and had no in-situ win, so it was removed [DG §2].

**Model dependence.** A for the method. S for which kernels dominate: Qwen3.8 has 48 GDN and 16 attention layers [DL §4.2].

**Code anchors.**
- gpuprof.rs:134 `phase`, :142 `region`, :305 `init`; qwen35.rs:4975-5095 region markers.
- gdn_kernel.rs:1467 `gdn_commit_all`, :1973 `add_rmsnorm_p`, :904 `TH_GDN_WSG`.
- quant_kernel.rs:496 `ChunkTop16`, :694 `draft_ring_write`.

### L05 Quant matmul tile policy and autotune (decode m ≤ 8, and m = 1)

**Mechanism.** Affine Q4 (group-64) matmuls run on MPP cooperative-tensor tiles. The policy chooses:
- the tile family;
- split-K or sequential K;
- persistent group counts;
- a paired N256 tile for very wide outputs (lm_head);
- whether the pad copy is skipped.

m = 1 uses a tiled matvec (K7).

**Detection signal.**
- `TH_BENCH_Q4=1` (main.rs:440): per-class µs → GB/s against a ≥480 GB/s target. Serial mode adds a buffer barrier after every call, like the forward's dependent chain [K45 §1].
- `TH_BENCH_Q4_SWEEP=1` (qwen35.rs:917): sweep tiles × presum × group counts.
- `TH_BENCH_MULTI=8,5,1` (main.rs:451): in-process full forward. **This is the gate that decides policy** [K45 §2].
- V-lin `TH_BENCH_LIN` (main.rs:427) for max|Δ|.

**Measured on Qwen3.8.**
- **K1 / P0 / K2 / K45 (roofline branch).** E2E T=0 64.11 → 56.40 ms/round (−12.0%), +15.1% tok/s; V-multi fwd8 47.00 → 40.25 ms [B §3.1].
  - Kernel rates: gate_up 532–535 GB/s (target met); in_all 457–460 and down 444 plain / 400 PreSums (target not met) [B §3.1].
- **The verify matmul set now sits at the matmul fit (≈30.9 ms/round).** The matmuls are no longer the gap [B §4.2–4.3].
- **Autotune.** The existing group policies win every shape. Only the unfused draft gate/up 17408×5120 changed: N256 sg8 at 122.3 µs vs 137.0 (−11%). Persistent-group overrides were slower: gate_up at 40/34/60 groups ran 290–312 µs vs 194 µs at 68 [K45 §3.2].
- **Gate A.** Sequential-K cost +19.2% ms/round for −0.031 ± 0.043 tokens/round, so split-K stays on N=5120 [B §3.1].
- **K7, m=1 `AffineQmvT` + fused silu·mul.** Plain decode 26.29 → 28.75 tok/s (+9.4%); fwd1 41.70 → 37.70 ms; m=1 projections 31.9 → 27.6 ms/token. DFlash is unchanged [CP §2.2].
- **Tried and dropped, with numbers** [K45 §4]:
  - an sb-pairs repack: slower, and not bit-identical;
  - Depth-4 pipelining: −3–4% in the bench, but +0.4 to +6 ms in situ;
  - PreSums with a periodic barrier.

**Validation gates.**
- V-lin: 28/28 max|Δ| equal.
- V-multi.
- Probe top-8 logits identical.
- T=0 12/12 identical.
- forward_batch dumps bitwise equal at nb=2 [B §3.1].
- `TH_M1_PATH=mpp` reproduces the base bitwise [CP §2].

**Pitfalls.**
- **The isolated bench and the in-situ forward disagree.** The bench mis-ranked the N256 PreSums tiles by 27–28%. For `down` split_long, the bench said slower but in situ it won, and the review judged the difference sub-noise (it would need ≥ 6 passes at load < 3 to settle) [K45 §3.1; RI].
- **V-lin single-shot timing is not a regression signal** (A/A band 0.73–1.40) [U1].
- **in_all and down below 480 GB/s are a fusion problem, not a tile problem.** The cause is the per-dispatch ramp plus 65/80 threadgroups on 40 cores [K45 §8].
- **Compile everything at load.** `MPP_SRC` is now compiled once per process instead of ~10 × 0.4–0.8 s on first use [K45 §1]. `qmvt_warm` builds 12 pipelines in 62 ms at load [CP §2.1].

**Model dependence: S, and X for a new quant format.**
- `DECODE_TILE_TABLE` is keyed on exact (out, in) pairs (quant_kernel.rs:218-219).
- Weights load as 4-bit, group 64 (qwen35.rs:169), and every fast path checks `gs == 64` (qwen35.rs:328, :415, :477, :594, :784).
- `PAD_SKIP_MAX_IN` = 8192 was tuned on this model's K values (quant_kernel.rs:252).
- New shapes silently take the generic rule: n64s4 split-K, or Paired256 when very wide (quant_kernel.rs:231-243).

**Code anchors.**
- quant_kernel.rs:27-44 `TH_Q4_POLICY`, :61 `gpu_cores`, :2964 `AffineQmvT`, :3008 `qmvt_warm`, :3188 `AffineQmpp`.
- qwen35.rs:324 `qmvt_m1`, :361 `linear_ps`, :674 `gate_up_act_ps`, :910 `bench_q4_decode`.

### L06 Producer-emitted sums and fusion

**Mechanism.**
- Affine dequant needs per-(quant group, row) input sums. The decode tiles recomputed them in every threadgroup (a barrier every 4 groups), and m < 8 projections also needed a pad copy.
- A **presum block** is the zero-padded `[8, in]` bf16 activation followed by f32 sums `[in/64][8]`. The producer writes it once, using the tiles' exact lane pattern, so the result is bit-identical [K45 §1]. Producers:
  - add+RMSNorm;
  - the N256 gate_up epilogue;
  - the GDN gated-norm stage.
- Related fusions:
  - the gate/up two-stream tile with a silu·mul epilogue (K1 on the target, K45(d) on the draft);
  - fused rmsnorm + rope + K/V cache append (`attn_prepare`);
  - sigmoid output gates in epilogues.

**Detection signal.** Recompute barriers and pad copies in the tile path; the in-binary arms `TH_Q4_PRESUM=0` and `TH_Q4_PS_FAMILIES`; the `path+ps` bench arm.

**Measured on Qwen3.8.**
- **K45(a), same binary vs `TH_Q4_PRESUM=0`:** fwd8 / fwd5 / fwd1 −3.60 / −4.10 / −3.20 ms [B §3.1]. The split [K45 §2]:
  - binding the block directly (pads and 96 GDN zero-fill blits gone): −2.3 / −2.5 ms;
  - PreSums kernels on the split-K tiles: −1.1 / −2.0 ms;
  - PreSums on the N256 / paired tiles: +1.7 / +2.4 ms, so it is excluded.
- **In situ,** presum on vs off is worth ≈1.5–2.5 ms/round [RI].
- **K45(d)** fused the draft gate/up: the draft MLP at 8 rows went 339.1 → 302.5 µs [K45 §9.2].
- **Draft presum producers** are part of the ≈0.3 ms/round of draft-side items [DG R3].
- **Prefill presum (E1(c))** is below the noise floor (≤ ≈1% of a forward), so it is opt-in via `TH_PF_PRESUM=1` [EG §6].

**Validation gates.**
- Emit check: run `down` on the emitted, attached and recomputed sums; max|Δ| must be 0 [K45 §5.2].
- Presum on/off is token-identical across 7 streams × 4 arms [RI].
- `pf_presum_chain_matches_prep_bitwise` [EG §6].

**Pitfalls.**
- **Rounding once instead of twice changes draft proposals.** The fused silu·mul changes sampled trajectories even when the target's T=0 output is identical [K45 §1].
- **The GDN presum producer hard-codes two quant groups per value head (DV = 128).** The Rust guard checks only `dv % 64`. This is review should-fix #1 and is **still open at HEAD** (gdn_kernel.rs:457-458, :651-652; guard at :1218) [RI].
- **Presum only applies at Σseq ≤ 8.** Batched rounds with nb ≥ 2 get no K45 effect [K45 §9.3].
- **Threadgroup-memory budgets must count static arrays.** `r32n256s8` declares exactly 32 KiB of static threadgroup memory, which is the Apple limit [RI].

**Model dependence: S/X.** The block layout assumes group size 64 (`presum_block_bytes`, quant_kernel.rs:272). The producer set depends on the architecture (RMSNorm before each projection; the GDN gated norm).

**Code anchors.**
- quant_kernel.rs:272 `presum_block_bytes`, :289 `presum_enabled`, :307 `ps_family_on`, :3360 `Q4AttachSums` (bench-only).
- gdn_kernel.rs:1922 `add_rmsnorm_sums`, :2075 `add_rmsnorm_pfsums_p`.
- qwen35.rs:881 `lin_apply_ps`, :1927 `add_rms_norm_ps`; dflash.rs:226 `DraftLayer::mlp`.

**Still open** [K45 §8]:
- An attention-output presum block: −12% on `o` in the bench, ≈−0.15 ms per verify.
- A presum-consuming tile for more than 8 rows.

### L07 Speculative decoding

#### L07a Draft cost

**Mechanism.** The DFlash draft proposes 7 tokens per round with a codebook-driven select (top-16 candidates per position). It has 5 layers, is conditioned on 5 target hidden captures, and keeps a 2048-row ring window (dflash.rs:30-48) [AGENTS inv. 21]. Cost = draft forward + select + ring commit.

**Detection signal.**
- Propose ms against the draft bandwidth floor: ≈2.9 ms for 1.65 GB streamed [B §4.2; C §6.1].
- Propose growth with ring length: +5.8 ms at ≈1.45k context before N4 [C §6.1].
- Probes: `TH_BENCH_DRAFT_ATTN` (main.rs:204) and `TH_BENCH_DRAFT_MLP` (main.rs:446).
- `MTL_SHADER_VALIDATION=1`.

**Measured on Qwen3.8.**
- **N1, the o_proj shape bug.** A `[1,8,32,128]` view was read as 256 rows × 4096: 2 MiB from a 64 KiB tensor, 5 times per propose, at 32× the MMA work. Fixing it: propose 11.20 → 9.30 ms, +4.7% loop tok/s [B §2.1].
- **N4, `draft_attn_split`** (64 threadgroups instead of 8): per propose 4.63 → 0.47 ms at a 1.45k ring, 8.09 → 0.68 at 2048 [DL §3.2].
- **Integration-3 propose:** 5.78 ms at bench context and 6.50 ms at 7.9k; main was 16.39 [D §1.2].
- MEM-4 (L04), D1 (L02), and the draft-side items in the gpu-tail bundle (L04).

**Validation gates.**
- `draft_attn_split` with 1 split is bit-identical to `draft_attn`, so every round up to ring 248 keeps base numerics [DL §3].
- T=0 identity.
- 0 "Invalid device load" under shader validation [RI].

**Pitfalls.**
- **Draft numerics changes alter proposals.** Acceptance and sampled trajectories move even when T=0 target text does not.
- **Draft state leaks across requests.** Ring slots were never cleared or committed, and a skipped warm-up changed the next request's proposals [B §2.3 MEM-10; DP §0].
- **Propose ends in a host sync,** so any host work inside it is fully visible [CP §4.3].

**Model dependence: X.** The draft is Splash's MDFD packed draft for this exact target. The constants at dflash.rs:30-48 are DRAFT_LAYERS 5, HIDDEN 5120, INTER 17408, HEADS 32 / KV_HEADS 8 / HEAD_DIM 128, WINDOW 2048, TOPK 16, CB_ROWS 248320 and CAPTURE_LAYERS [5, 19, 33, 47, 61]. A new target needs a new draft, or an MTP head: MTPLX runs "the model's own MTP head" as an exact speculative decoder with no second draft model [MTPLX README].

**Code anchors.**
- dflash.rs:493 `propose`, :567 `attention`, :674 `cand_tables`, :780 `select_walk`, :893 `propose_batch`.
- draft_kernel.rs:20 `draft_nsplit_for`, :31 `draft_attn_nsplit`, :566 `draft_attn_split`.

#### L07b Acceptance and verify length

**Mechanism.** tokens/round = 1 + accepted proposals. The verify rows are the anchor plus the proposals.

**Detection signal.**
- **Capped chains:** rounds where every verified proposal was accepted and the next proposal was the target's argmax [BQ §4.3].
- **Rounds on byte-identical greedy text against the reference** [C §1.6].
- **Many-seed Rao-Blackwellised acceptance** with `TH_ACCEPT_STATS=1` (engine.rs:1713) [DS §2].
- **Verify cost by row count** (`TH_BENCH_MULTI=8,…,2`) [CL §3].

**Measured on Qwen3.8.**
- **L1, verify all 7.**
  - The adaptive cap had bound on 35.5% (T=0) and 33.7% (sampled) of rounds.
  - On a 15-prompt T=0 set: **3.821 → 4.299 tokens/round (+12.5%)**, 69.0 → 79.3 tok/s (+14.8%).
  - fwd8 at 39.70 ms is the cheapest verify shape (fwd2 41.50) [CL §3].
- **R0b.** Phase C's sampled gap was sample noise: over 15 prompts × 5 seeds, th 4.140 vs Splash 4.131 (1.002 [0.967, 1.036]). Top-p renorm and draft filtering had no significant effect. Per-position acceptance falls from 0.806 to 0.538 [DS §2].
- **B1, block verification** (Sun et al. 2024): ×1.0091 [1.0040, 1.0142] on the same drafted blocks; realized 1.031× Splash [1.004, 1.061] [DS §4].
- **Anchor off-by-one fix.** Correct, and acceptance-neutral: T=0 0.981 [0.957, 1.007], sampled 1.005 [0.965, 1.045] [ET §3.7].
- **Residual gap.**
  - On identical text: th 130 rounds vs Splash 127 (0.977) [E §1.6].
  - ctx8k: 3.726 vs 4.145 tokens/round on differing texts; open [E §6.1].

**Validation gates.**
- B1 is exact by enumeration (300 toy models, 1e-12) and by Monte Carlo (4 × 300k) [DS §4].
- `TH_SAMPLE=check`.

**Pitfalls.**
- **Nine streams cannot separate a rule from trajectory luck** [C §6.2]. Different texts make tokens/round incomparable.
- **The `seed | 1` collision is still present at HEAD** (engine.rs:1367).
- **A "gain-only" merge rule can hold back a correct fix.** The lane rule parked the anchor fix although it was correct [CL §6]; it landed in Phase E for correctness [ET].

**Model dependence.** A for the rules (L1, B1, S1). X for draft quality and the best verify depth. MTPLX auto-tunes MTP depth per model and machine; on a 16 GB M4 a 9B model lands on depth 1, 14.4 → 23.0 tok/s [MTPLX README].

**Code anchors.** engine.rs:429 `dflash_verify_len`, :315 `verify_adaptive`, :1681 `spec_verify_rule`; sample_kernel.rs:421 `accept_chain`, :514 `accept_block`.

#### L07c Sampled acceptance on the GPU (S1)

**Mechanism.** Sampled acceptance used to run on the CPU after an `[8, vocab]` bf16 readback. S1 encodes two kernels into the verify command buffer and reads back a 16-word block [DS §3]:
- `ts_topk`: exact top-k up to 32, plus the full-vocab partition Z;
- `ts_accept`: the acceptance chain.

**Detection signal.** The sampled round minus the greedy round; the `rest` phase.

**Measured on Qwen3.8.**
- **Before S1,** a sampled round cost +2.3 ms over greedy (`rest` 2.2 vs 0.1 ms) [C §1.5].
- **S1 removes 3.5–5.7 ms/round of `rest`** on byte-identical requests [DS §0].
- **In-binary** (integration-3 vs `TH_SAMPLE=cpu TH_SPEC_VERIFY=token`): −2.96 ms/round. A sampled round now costs **+0.43 ms** over greedy; main was +3.69 and Splash +1.32 [D §1.2].

**Validation gates.**
- `gpu_accept_matches_cpu_reference` (160 trials × 2 rules).
- `TH_SAMPLE=check`: 518 checked rounds, 0 mismatches, at integration-4 [E §0].
- Kernels compile with safe math and fp contraction off. The CPU reference uses the same arithmetic (`th_expf`, explicit fma, f32 sums in kernel order) [DS §3].

**Pitfalls.**
- **Path selection depends on the request** (engine.rs:1687). Top-k 1..32 with no repeat penalty takes the GPU path; everything else takes the CPU reference (L16).
- **The server default sends omitted fields to the GPU path.** Omitted `top_k` resolves to 20 (state.rs:69-71) [DS §8.1].

**Model dependence: A.** Vocab size only affects scratch and per-row cost. sample_kernel.rs:48-64 ties `ROWS`, `PROP` and `DTOPK` to the dflash constants.

**Code anchors.** sample_kernel.rs:725 `ts_topk`, :882 `ts_accept`, :232 `cpu_row_dist`; engine.rs:1538 `TH_SAMPLE`.

### L08 State snapshot and rollback (GDN parity buffers)

**Mechanism.** A verify advances the recurrent state by 8 rows. After a partial accept, the state must equal a forward of the kept rows only.
- **Before G1a:** `snapshot()` copied every GDN layer's state each round, and the rollback re-scanned with a different kernel, so it was not bitwise.
- **G1a:** each slot owns two persistent parities per GDN layer.
  - Layers read parity p and write parity 1−p, and the slot flips once per completed forward. A failed forward never flips.
  - The rollback is **one fused commit dispatch per layer** that re-scans the kept rows through the verify's own instruction stream. The committed state is therefore bit-identical to a forward of the kept rows [CG §2; C §2.2].

**Detection signal.**
- Verify host encode, which includes `snapshot()` [C §1.5].
- The `rest` phase, which includes the rollback.
- R0a mismatch counts.

**Measured on Qwen3.8.**
- **G1a:** T=0 **55.04 → 48.69 ms/round (−6.35, −11.5%)**; verify host encode 8.00 → 2.72 ms; idle 6.68 → 1.31; TH_BATCH=2 nb=2 rounds 87.8 → 76.4 ms (−13%). The forward alone is unchanged [CG §0].
- **`gdn_commit_all`:** every layer's commit in one dispatch (estimated 0.2–0.4 ms) shipped with the gpu-tail bundle [CG §5; DG §2].

**Validation gates.**
- **R0a:** `TH_TEST_ROLLBACK=1 [TH_BATCH=2] th-engine probe` (main.rs:245; gate at :253; exits 1 at :420-421).
  - On the base code it FAILed: 1.3M–6.3M of 37.7M recurrent f32 elements differed, in all 48 layers.
  - After G1a it PASSes: 0 differences at every kept = 1..8, conv windows included, with slot isolation [CG §3].
- **Discrimination arm:** `TH_GDN_COMMIT=step` must FAIL (rc 1), so the gate is shown to still discriminate [CG §3].
- **Unit tests:** `gdn_parity_rollback_state_bitwise_over_chained_rounds` and the light-snapshot rules test.

**Pitfalls.**
- **The old `TH_TEST_ROLLBACK` was not a gate.** It FAILed on untouched code, and its kept=8 self check was not state-bitwise: the scan rescan and `gdn_fused_step` differed in 6,278,466 of 37.7M elements [B §2.4].
- **A light snapshot is valid for exactly one following forward.** Restoring across several forwards needs `snapshot_deep` [CG §5].
- **Exact rollback changes sampled trajectories** relative to the old rescan. T=0 bench prompts are unchanged; `TH_GDN_COMMIT=step` reproduces the old streams [CG §3].
- **The legacy-logits line prints a spurious FAIL at long prompts.** It compares argmaxes at two different positions (main.rs:409-416). The exit code is the gate [DL §5; EA §5].

**Model dependence: X.** Every recurrent-state layer type needs this: GatedDeltaNet here, and MTPLX describes the Qwen4-architecture preview as still hybrid GatedDeltaNet [MTPLX README]. Pure-attention stacks roll back by truncating `kv_tokens` [I]. Baked-in shapes:
- conv window `[3, 10240]` bf16;
- recurrent state `[48, 128, 128]` f32;
- the shader hard-codes 4 conv taps [CG §2].

**Code anchors.**
- qwen35.rs:2084 `GdnState`, :2102 `GdnParity`, :3231 `snapshot`, :3245 `snapshot_deep`, :3265 `restore`, :3308 `rollback_verify`, :3444 the `gdn_commit_all` call, :5427 `rollback_state_check`, :5541 `slot_isolation_check`.
- gdn_kernel.rs:290 `gdn_fused_step` (host :1013), :1341 / :1467 `gdn_commit_all`, :870 / :1766 `gdn_conv_carry`.
- model.rs:234-262.

### L09 Attention decode (split-key), plus draft attention

**Mechanism.**
- The single-pass `attn_decode` walks every key serially per simdgroup, costing 0.25–0.40 ms per 1k keys per layer [B §2.1 N3].
- **N3** is an MPP tile over (kv head, split) with 48 fused query rows per kv head (8 rows × 6 q heads), so one K/V page read serves every row. The online softmax is per row, and the reduce runs in fixed order, so the result is deterministic [DL §2.1].
- **N4** does the same for the draft: split keys over 64 threadgroups (L07a).

**Detection signal.**
- Round growth from bench context to ctx1500 to ctx8k, split into propose vs GPU tail.
- `TH_BENCH_ATTN=1`: a no-model kernel bench (main.rs:221 → attn_bench.rs).
- `TH_BENCH_ROUND`: an in-process 4-arm round A/B, on the probe branch only (§10).

**Measured on Qwen3.8.**
- **Before N3,** attention over 16 layers cost 1.98 ms/round at 512 keys, 9.39 at 2k, 47.7 at 8k and 99.7 at 16k [B §2.1].
- **N3 kernel:** 9.7–28× faster at 512–32k keys. Verify attention over 16 layers: 9.1 → 0.60 ms at 1.45k, 51.6 → 2.06 at 8k, 209 → 7.4 at 32k [DL §0].
- **Paired round Δ in process,** at L = 1450 / 7900: −17.4 / −64.1 ms, of which N3 −10.5 / −54.6 and N4 −6.8 / −10.7 [D §2.1].
- **Server, main → integration-3:** the ctx8k round went 108.62 → 42.41 ms/round (together with the gpu-tail kernels). Context growth from bench to 7.9k is now +2.9 ms, against Splash's +2.7 [D §0, §1.2].

**Policy.**
- splits = clamp(ceil(pages / 8), 16, 32), with 32-key pages. Only at ≥ 256 visible keys: the bench prompts peak at ≈180 keys, so they stay bit-identical [DL §2.1].
- 16–32 threadgroups per kv head fill the 40-core GPU; more splits only add partials traffic [DL §2.2].

**Validation gates.**
- `split_attention_matches_single_pass`: both cache layouts, seq 1/3/8, page boundaries, determinism [DL §5].
- R0a with `TH_ATTN_SPLIT_MIN=1` (split at every length) and on a 1450-token prompt.
- Precision against an f64 reference equals the single-pass kernel's at every L up to 32k, peaked attention included [DL §2.2].
- kv-quant slots stay on `attn_quant`, with texts identical to base.

**Pitfalls.**
- **Capacity must be whole 32-key pages,** or `split_plan` falls back to single-pass. A prefix-cache hit (exact-size restore) and its miss would then take different kernels. This was a semantic merge fix: `next_multiple_of(256)` [D §4].
- **Rows past the visible keys must be finite** (L11).
- **Pipeline caches must be keyed per geometry.** A process-global `OnceLock` baked the first caller's geometry into every later one; `GeomCache` fixed it [DL §2.1].
- **bf16 probabilities are 25% faster but deviate 2–4× more** [DL §2.1].
- **Lowering the threshold to 64–128 keys** would save 0.5–0.7 ms/round at bench context, but it changes bench-context numerics, so it needs a new identity baseline [DL §1.2].

**Model dependence: S.** The page size, split policy and threshold were tuned for 40 cores and 4 KV heads × 6-way GQA × head_dim 256. The tile itself is geometry-templated (`TH_DIM` / `TH_QROWS` / `TH_PAGE`, attn_kernel.rs:858).

**Code anchors.**
- attn_kernel.rs:34 `split_count`, :41 `SPLIT_PAGE`, :66 `split_cfg`, :90-94 defaults, :316 `GeomCache`, :709 `attn_split_mpp`, :819 `attn_split_reduce`, :950 `split_scratch`, :1004 `attn_decode_split`, :1104 `split_plan`.
- qwen35.rs:4410 / :4449 routing, :4851 `ensure_kv`.

**Still open.** The split kernel runs at 261 GB/s at 8k against ≈500 achievable. Closing that is worth ≈1 ms/round at 8k and ≈4 ms at 32k [DL §7].

### L10 Attention prefill (grouped eager → fused causal flash)

**Mechanism.**
- **The eager path** materialised `[24, 512, kv]` scores per layer per chunk, uploaded a host-built causal mask, and broadcast K/V to all 24 q heads.
- **T1b** groups the 6 q heads of each KV head through the same kernels, and stays bitwise.
- **E1** is a fused causal flash kernel after MLX `attention_nax_dsplit` [EA §0–1]:
  - MPP 16×32×16 NAX fragments over 32-key blocks, with the head dim split across a simdgroup pair;
  - online softmax in f32;
  - GQA-fused rows, and the chunk's causal offset;
  - K/V read strided straight from the caches;
  - the sigmoid gate in the epilogue;
  - deterministic and chunk-invariant.

**Detection signal.**
- R0c `attn.core` share of prefill GPU time: 24% at 1.45k and 46% at 7.9k on `e452a7b` [EG §2].
- Probes: `TH_BENCH_PREFILL_ATTN=seq:kv,…` (main.rs:212), `TH_BENCH_ATTN=seq:kv` for T1b (main.rs:778), and `TH_BENCH_PREFILL_LOGITS` (main.rs:874).

**Measured on Qwen3.8.**
- **T1b:** 4.9× per layer at a 24-row suffix over 1432 keys; 1.08–1.27× on 384–896-row chunks. That is −97 ms per cold 1.45k prefill and −226 ms per 8k chunk [DP §0].
- **E1:**
  - Per layer: 6–10× the grouped eager path, and 1.2–2.4× candle `sdpa`.
  - Whole-prefill attention: 363 → 42 ms at 1450 tokens, 8767 → 1175 ms at 7900.
  - Server cold TTFT: **1.45k 2739 → 2417 ms (−11.8%)**, **7.9k 21.3 → 13.0 s (−39%)**.
  - Cold-7.9k transient footprint: +11.4 → +5.0 GB [E §2.1].
- **g2q** re-reads q per key block, which frees 32 live registers. Whole-prefill attention drops to 0.84–0.85× of g2 [EA §0].

**Validation gates.**
- `prefill_attention_matches_reference` [EA §1]: f32 reference, both layouts, 11 shapes, chunk invariance, and variant equality.
- `TH_PREFILL_ATTN=eager` is bit-exact to main, 42/42 · 42/42 [EA §5].
- **Last-prefill-position logits against the eager path's own noise floor** (a tail-chunk split). Fused vs eager: max|Δ| 0.16–0.50 (5–16 bf16 ulp), KL ≤ 1.2e-3, argmax the same, top-10 10/10 [E §4.2].
- A 36-stream T=0 first-divergence pass: 26/36 identical; the divergences are all on the known near-tie class [E §1.6].

**Pitfalls.**
- **Not bitwise vs eager,** so the change needs its own identity baseline and a noise-floor argument. An absolute 0.05-logit target is unreachable: the eager path itself moves 0.13–0.41 under a chunking change [EA §0].
- **NAX precision trap.** With this fragment layout, a strict-precision f32 left operand gives garbage and a relaxed one rounds to about f16. So P·V takes f16 probabilities × 2^15 [EA §0].
- **Refactors can break bitwise equality.** A "same algorithm" refactor was not bitwise, most likely from FMA contraction under fast-math [EA §5]. One two-accumulator variant miscompiled in one build [EA §2.2].
- **The bottleneck is latency hiding, not arithmetic.** Removing the softmax, P·V or q·k made the kernel no faster [EA §2.2].
- **Short suffixes under-fill the GPU.** They launch only 20–96 threadgroups [EA §6].

**Model dependence: S/X.** `prefill_supported` requires head_dim 256 and a GQA group ≤ 16 (attn_kernel.rs:1613-1614); anything else silently falls back to grouped eager. Sparse or sliding-window attention (the Qwen4 preview uses "Qwen Sparse Attention" per [MTPLX README]) is not handled [I].

**Code anchors.**
- qwen35.rs:1718 `prefill_attn_cfg`, :1748 `prefill_attn_variant`, :1701 `attn_gqa`, :4620 / :4660 the fused route, :4677 `attn_fused_out`, :4721 `attn_eager`, :1634 `causal_mask`.
- attn_kernel.rs:1154 `PREFILL_SRC`, :1504 `PrefillVariant`, :1525 `DEFAULT` (g2q), :1671 `attn_prefill`.

**Still open** [EA §6]:
- Stage K/V in threadgroup memory, prefetch, or add a third simdgroup pair. The kernel runs ≈11–12 TFLOPS effective at 512:7168 against ≥25 TFLOPS for MPP GEMM.
- A key split for short suffixes.

### L11 KV layout, capacity and KV quantisation

**Mechanism.**
- KV caches are contiguous per layer, `[n_kv, cap, head_dim]`, head- or time-major.
- Capacity grows in 256-row blocks; since Phase E it is reserved once per prefill.
- The prefill writes its chunks in place (`KvCap::Direct`, via views), and checkpoints view the slot's K/V.

**Detection signal.**
- A per-chunk `cat` of the whole prefix, plus regrowth copies during prefill.
- Blit zero fills on growth.
- The TTFT split into enqueue vs rest [D §1.5].

**Measured on Qwen3.8.**
- **A regression, found and removed.** gpu-tail's KV-capacity prefill (a zero-filled `[4, ≥2048, 256]` K and V per layer plus a copy of the cat) cost ≈+90–100 ms of cold 1.45k TTFT, for an ≈11 ms decode saving once per request [D §1.5].
- **KvCap::Direct plus the head skip:** host enqueue −41 ms [E §2.3].
- **The whole ttft-regression lane:** cold 1.45k −123 ms [−179, −74] [E §2.3].
- **Checkpoint views:** 0.5–1.5 GB less allocation per 8k request [ET §2.2]; the steady state after 8k traffic is ≈12 GB below main [E §1.5].
- **Row size:** K+V is 64 KiB per row over 16 layers [ET §2.2].

**KV quantisation (TurboQuant, `--kv-quant`).**
- Slots bypass N3, the fused prefill and the prefix cache; their texts stayed byte-identical across the integrations [D §4.1; E §4.1].
- It is lossy on this model: the prompt gets misquoted at token ~11 [RI].
- The admission-time model-wide mode flip corrupted live slots (M2/MEM-6) [B §2.2].
- Reference point: Splash reports KV dtype `q8s8_f32_scale_per_token_head_k_token_major_v_dimension_major` [BQ §1]. 8-bit KV was not tried on th.

**Validation gates.**
- The store-mode arms `TH_KV_CAP_PREFILL=legacy|0`, `TH_PREFIX_CACHE_KV=copy` and `TH_KV_RESERVE=0` are each 42/42 · 42/42 [ET §4].
- Unit tests `kv_reserve_keeps_rows_and_results` and `copy_rows_is_bit_exact_and_bounded` [ET §1].

**Pitfalls.**
- **Tails must be zeroed, because they must be finite.** N3's tile multiplies whole 32-key V pages by masked zero probabilities, and a recycled buffer can hold −inf [ET §2.1].
- **Capacity must be page-aligned** (L09).
- **A view pins the whole buffer.** The view policy therefore allows at most max(1/3, 48 MiB) of extra pinned bytes [ET §2.2].
- **Rows below `kv_tokens` must never be written again.** The checkpoint views rely on it [ET §2.2].

**Model dependence.** A for the mechanics; S for row bytes and the capacity policy. Sliding-window layers would need ring KV and different checkpoint semantics [I].

**Code anchors.**
- qwen35.rs:1849 `KvCap`, :1855 `kv_cap_mode`, :1901 `ck_kv_view_ok`, :3832 `kv_reserve` (cap at :3843), :4812 `kv_store_direct`, :4851 `ensure_kv`.
- engine.rs:542 / :641; turboquant.rs.

### L12 GDN scan (sequential vs chunked)

**Mechanism.**
- **Decode** uses `gdn_fused_step`: qk-norm, conv, scan and gated norm fused, out-of-place over the parities, 32 simdgroups per value head.
- **Prefill** uses `gated_delta_step`: **one sequential pass per layer per chunk** over the chunk's tokens [EG §10].

**Detection signal.**
- R0c region `gdn.core`, which covers conv + qk-norm + the sequential scan + gate-norm:
  - on `e452a7b`: 144.8 ms (6%) at 1459 tokens and 750.2 ms (4%) at 7929 [EG §2];
  - after E1: 165 ms (7%) and 881 ms (5%) [EG §10].
- 763 µs per 512-row call [EG §10].
- The `TH_BENCH_GDN=1` cargo-test bench (gdn_kernel.rs:2694).

**Measured on Qwen3.8.**
- The decode widths (32 simdgroups instead of 8, bit-identical) are part of the gpu-tail bundle [DG §2].
- The G1a prefill carry was *not* a cost: synced four-build A/B, and a carry on/off A/B [DL §4].
- **A chunked prefill scan is not implemented yet.** Phase E ranks it lever #1 for the remaining cold 7.9k gap (11.8 vs 10.2 s) [E §6.2].

**Validation gates.**
- R0a.
- Prefill logits.
- A chunked (WY / parallel-scan) form will round differently, so it needs the noise-floor protocol of L10 plus hit == miss (L14) [I].

**Pitfalls.**
- **The 64-CB cap moves host waits,** which made a non-regression look like +2.4% on 6-vs-6 medians [DL §4].
- **The eager GDN path (`TH_GDN_EAGER`) was updated for parity but never exercised on the real model** [CG §5].

**Model dependence: X.** GatedDeltaNet-specific: HK/HV/DK/DV are compile-time constants (gdn_kernel.rs:112, :196, :308) and the conv has 4 taps. MTPLX describes the Qwen4-architecture preview as hybrid GatedDeltaNet [MTPLX README].

**Code anchors.** gdn_kernel.rs:118 `gated_delta_step`, :290 `gdn_fused_step`, :484 `gdn_fused_step_w`, :689 `gdn_step`, :904 `TH_GDN_WSG`, :945 `TH_GDN_CSG`; qwen35.rs:4045 `gdn_forward`.

### L13 Prefill GEMM tiles and chunk size

**Mechanism.** Rows > 8 route to prefill tiles:
- **T2 small-M tiles for m ≤ 128:** Splash's N128×4sg tile, M16/M24/M32 row tiles, and split-K [T2].
- **E1(b) vectorized-epilogue tile `r32n128s4+v` for m > 128** [EG §5]:
  - one 8-byte scale load, one 8-byte bias load and one row sum per 4-column cooperative-tensor run;
  - a parallel sums pass;
  - no pad or narrow copies.

**Detection signal.**
- R0c per-region prefill GPU ms and in-situ TFLOPS. On `e452a7b` the Q4 GEMMs were 69% of 1.45k prefill GPU time at 43.8 TFLOPS in situ [EG §2].
- `TH_BENCH_LIN=pf`, GPU-busy-timed [EG §4].
- The standalone harness against the MMA-only ceiling [EG §3].
- `TH_BENCH_PREFILL` (main.rs:492; `_LARGE_ONLY` at :502) and `TH_BENCH_STEPS` (main.rs:550).

**Measured on Qwen3.8.**
- **T2.** In-process forward, tiles / legacy: 0.522 at m=16 up to 0.886 at m=128. m=512 was 4.3% slower, so the route is capped at 128. Cold TTFT −8 to −11% on 58–80-token prompts [B §3.1].
- **E1(b), kernel level** [EG §0]: gate −7%, down −17%, out/o −25%; 91% of the MMA-only ceiling (61–65 TFLOPS int4 × bf16).
- **E1(b), in situ** [E §2.2]:
  - Q4 GEMMs 1928 → 1606 ms at 1.45k (36.6 → 43.9 TFLOPS) and 10369 → 8672 ms at 7.9k;
  - prefill −13% / −9% (−8% / −7% after normalising for unchanged regions);
  - unprofiled cold 1.45k −119 ms (95% CI −197..−45).
- **Chunk size: keep 512.**
  - 256 ties.
  - 1024 is +8–12%, because the eager attention wasted the masked triangle.
  - Last-token logits are bitwise identical at every chunk size [EG §7].

**Validation gates.**
- `pf_vec_matches_legacy_bitwise`; final-vs-base logits byte-identical.
- The pf policy tests, including `pf_policy_only_returns_warmed_shapes` [T2].
- A load-time layout probe (`pf_vec_layout_check`), because the MPP cooperative-tensor layout is implementation-defined [EG §5].

**Pitfalls.**
- **Compile the tile libraries at load.** `pf_warm` builds 26 pipelines: 1.4 s on a never-seen binary path [EG §5].
- **No fallback if an `AffineQpf` pipeline fails** (should-fix #5) [RI].
- **The 8-simdgroup and fused gate/up tiles are 1-ulp slot-variant** [T2 obs. 1].
- **The in-situ GEMM rate is ≈70–75% of the isolated rate** [EG §10].
- **Formula changes break bitwise equality.** Explicit FMA forms changed 0.02–0.05% of outputs by 1 ulp [EG §3].
- **A double-buffered K loop loses 9%** (register pressure) [EG §3].
- **`pf_env` reads `TH_GPU_CORES` with default 40** instead of `gpu_cores()`. Should-fix #2, still open at HEAD (quant_kernel.rs:5108-5111) [RI].

**Model dependence: S, and X for a new quant format** (`pf_route` requires `inp % 64 == 0`, quant_kernel.rs:5119).

**Code anchors.**
- quant_kernel.rs:3740 `AffineQmppPrefill`, :4690 `pf_vec_layout_check`, :4786 `pf_warm`, :4841 `AffineQpf`, :5102 `pf_env`, :5117 `pf_route`, :5206 `pf_policy_large`, :5254 `pf_policy`.
- qwen35.rs:2677 `bench_prefill`.

**Still open.** Re-run 1024 / 2048-row chunks now that fused attention removed the masked-triangle waste; Splash prefills up to 2048 rows per batch [EG §7; E §6.2].

### L14 Prefix cache and checkpoints

**Mechanism.**
- A checkpoint is one slot's state at a chunk boundary: GDN recurrent + conv state, K/V rows, and DFlash capture rows. It is keyed by (token prefix, prefill step, chunk history).
- The prefill kernels are **not row-count invariant**, so a restored request could diverge from its uncached run. To prevent that:
  - every prompt runs one canonical chunk plan;
  - a lookup accepts only a checkpoint whose history equals the new prompt's own plan.

  A hit is therefore **bit-identical** to the uncached prefill [DP §2].

**Detection signal.**
- TTFT on repeats, multi-turn and shared system prompts, against the reference.
- `/status prefix_cache` counters.
- `TH_DEBUG_PREFILL` synced phases.
- `TH_BENCH_PLAN` (main.rs:611) and `TH_BENCH_TTFT` (main.rs:774).

**Measured on Qwen3.8.**
- **Repeated 1.4k prefix:** 162 ms median vs main's 3230 ms, 21× (loaded session) [DP §0]. Quiet, in Phase D: 139 / 146 ms vs Splash 158 / 142 [D §1.4].
- **Full checkpoint with the last logits** makes exact repeats restore-only [ET §0]:
  - 1.4k repeat 156–189 → 13–16 ms;
  - 7.9k repeat 611–675 → 19–34 ms (engine time).
- **Integration-4 against Splash** [E §0, §1.4]:
  - exact repeats 24 / 22 ms vs 220 / 354 ms;
  - another question after the same document 99 / 235 ms vs 1652 / 9737 ms, because Splash missed 6 of 8 such requests.
- **Checkpoint sizes at 1408 / 7424 tokens:** GDN 151 MB, K/V 92 / 486 MB, capture rows 72 / 105 MB [DP §2].

**Validation gates.**
- **hit == miss** (`TH_PREFIX_CACHE=miss`): 42/42 texts · 42/42 per-round logs.
- `=0` equals main, and `=grid` equals main including hits.
- The real-model prefix-restore gate inside `TH_TEST_ROLLBACK`: logits / state / verify / checkpoint differences 0/0/0/0, slot 0→0 and 0→1.
- TH_BATCH=2 concurrent restores of one checkpoint [DP §4; E §4.1].

**Pitfalls.**
- **The default plan changes long-chat-prompt numerics** relative to the grid plan (34/42). `grid` gives strict identity with ≈6× slower hits (938 vs 118 ms GPU-side) [DP §5].
- **A skipped draft-ring warm-up leaked across requests.** When the first token ended a request, the warm-up was skipped, and the next request's proposals changed; fixed in `7c2407f` [DP §0].
- **Capturing after a completed request would break hit == miss:** the post-decode state is not bit-identical to a prefill of the same tokens [DP §5].
- **Deferred builds become a first-token gap** (L17).
- **An assistant-start split** saves 55 ms on turn 2 but costs ≈+30 ms on every cold chat prompt, so it is opt-in [ET §3.8].

**Model dependence.** A for the framework. X for what a checkpoint must hold:
- recurrent state cannot be truncated, so hybrids need block-aligned state checkpoints [I];
- pure-attention stacks could instead reuse paged KV at 32-token granularity, as Splash does [D §1.4] [I];
- capture rows are specific to the DFlash draft.

**Code anchors.**
- prefix_cache.rs:46 `PrefixCacheConfig`, :94 `from_env` (defaults at :106-113), :176 `ChunkPlan`, :196 `history_at`, :216 `plan`, :400 `lookup`.
- qwen35.rs:2255 `PrefixState`, :3545 `prefix_capture`, :3556 `prefix_hold`, :3591 `prefix_build`, :3773 `prefix_restore`.
- engine.rs:528 `PendingCaptures`, :556 `prefill_slot`, :728 `finish_captures`.

**Still open** [E §6.2]:
- Swap-based holds, to close the deferred-build gap (+24–28 ms).
- A rendered-prompt → ids cache for full hits (≈12–19 ms of host work).

### L15 Batching (multi-slot)

**Mechanism.** `TH_BATCH>1` runs a lockstep batched DFlash loop. The Σseq = 8·nb verify rows share the projections; GDN state is per slot.

**Detection signal.**
- Aggregate wall tok/s against a single stream.
- The `[batch]` line (engine.rs:2485). It measures through readback only after the M1 fix.
- `TH_BENCH_BATCH` (main.rs:972): an in-process batched verify with a slot-invariance check.

**Measured on Qwen3.8.**
- **Batching paid little.** B=4 gave 72.4 tok/s aggregate vs 48.2 single-stream (`cf3e5f7`) [B §2.2].
- **T2 routing of rows > 8** [T2]:
  - TH_BATCH=4: 187.67 → 151.35 ms/round (−19.4%), 65.63 → 78.39 tok/s;
  - TH_BATCH=2: 122.53 → 97.93 ms/round (−20.1%).
- **G1a:** nb=2 rounds 87.8 → 76.4 ms (−13%) [CG §0].
- **Why batching is structurally weak here** [K45 §9.6]:
  - the draft MLP costs ≈930 µs per layer at 16 rows vs ≈300 µs at 8 rows (3.1×), so two single-slot proposes would be cheaper than one batched propose;
  - the per-slot GDN out projection sweeps its 17.7 MB weight B times per layer.
- **nb=1 batch mode verified all 7 before L1** (L1 for free): 117 tok/s reported on one prompt [RI].

**Validation gates** [C §4; D §4.1; E §4.1; T2]:
- TH_BATCH=2 smokes: 13/13 in C, 35/35 in D/E.
- TH_BATCH=4 smokes: 16/16, plus kv/clear.
- Max trigram-repeat ≤ ~0.1; 0 U+FFFD.
- N2 mixed pairs must match all-greedy pairs.
- A `TH_PF=0` control: 20/20 identical to main.

**Pitfalls.**
- **Greedy output depends on co-scheduling and admission timing.** Different Σseq takes different kernels, so identity A/Bs need identical batch composition [B §2.2; RI].
- **Review found a cluster of state-machine bugs** [B §2.2] (§7):
  - B1: the scheduler dies after one error;
  - M1: decode_tps inflated 2.5–4×;
  - M2: kv_quant flips on another slot;
  - M3: kv/clear wipes a live slot;
  - M4: empty 200 responses;
  - M5: no-draft batching fails;
  - MEM-3: 40 MiB allocated per slot per round.
- **Presum is inactive at nb ≥ 2** [K45 §9.3].
- **A synchronous prefill in `admit` stalls every live slot** (m7) [B §2.3].

**Model dependence.** A for the scheduler; S for the row tiles. MoE would change which rows share weights, because experts are routed per row [I].

**Code anchors.** engine.rs:2057 `batch_loop`, :2152 `admit`, :2267 `batch_round`; qwen35.rs:5153 `forward_batch`, :3968 `draft_propose_batch`; dflash.rs:893 `propose_batch`.

### L16 Sampling paths

**Mechanism.** Greedy picks come from GPU argmax rows. Sampled acceptance runs on the GPU (L07c) or through the CPU reference: repeat penalty, top-k 0 or > 32, the prefill anchor, and the plain loop.

**Measured and found on Qwen3.8.**
- **N2, the tie rule.** 86 of 5122 token-deciding T=0 rows (1.68%) had an exact bf16 top-1 tie [B §2.1].
  - Fix: one strict-`>` scan (lowest index) on every path.
  - Greedy slots now read argmax rows even in mixed batches; before, one sampled mate pushed the whole batch through the CPU tie rule [CP §3].
- **The full-vocab sort bug** [DS §8.1].
  - With `top_k: 0` (or ≥ vocab), S1's `cpu_row_dist` sorted all 248,320 ids per verified row: 5–15 ms per row, ~36–66 ms per 6.7-row round.
  - Fix: an id-order full-vocab distribution and a top-p prefix distribution. `rest` fell 24.0 → 2.8 ms/round (top_k 0 + top_p 0.95) and 33.0 → 2.9–4.5 (top_k 0, top_p 1).
- **Z1, cache-friendly `global_z`:** 0.79 → 0.19 ms per 248k row, with the same bits [DS §3].
- **Default config** [DS §8.1]:
  - temperature 0.7, top_p 0.8, top_k 20 (state.rs:69-71), so a request that omits fields takes the GPU path;
  - `{"top_k": null}` through `/engine/config` is a no-op (serde);
  - `top_k: 0` used to panic [DS §3].
- **Seeds:** `seed | 1` (engine.rs:1367) and `seed.max(1)` (engine.rs:866) [B §2.4; Bb].
- **Tail precision:** the f32 running sum absorbs tail weights below half an ulp, so those ids become unreachable on no-top-k CPU rows [DS §7].
- **Streaming (U1).** UTF-8-safe incremental detokenization [U1]:
  - a Chinese prompt went from 36 to 0 U+FFFD;
  - CJK stop strings cut correctly;
  - cost +0.09–0.15 µs per token.
  - Side effect: SSE deltas are no longer one per token, which changes how benches read TTFT [B §3.1].

**Validation gates.**
- `n2_greedy_tie_rule_matches_argmax`, `full_vocab_dist_matches_sorted`, `top_p_prefix_matches_full_sort`, `accept_chain_is_exact_at_one_position` [DS §8.1].
- `TH_SAMPLE=check`.
- The `utf8_stream_*` tests, which have mutation checks [U1].

**Model dependence: A.** Vocab size sets the per-row cost.

**Code anchors.**
- engine.rs:1823 `greedy_argmax`, :1836 `greedy_rows`, :1644 `TH_TOP_P`, :1657-1687 rule selection, :1951 `emit_token`.
- sample_kernel.rs:180 `global_z`, :253 `full_vocab_dist`, :284 `top_p_prefix_dist`.

### L17 TTFT and the first-token gap

**Mechanism and decomposition.**
- Engine TTFT = host enqueue of the prefill forwards + rest (GPU drain + first sample) [D §1.5].
  - Enqueue is prompt / `prefill_tps`, because the prefill timer at engine.rs:657-665 is unsynced.
- First-token gap = 1st → 2nd streamed delta [E §1.4].
- Tools: `TH_DEBUG_PREFILL` gives synced phases; `TH_BENCH_TTFT` (main.rs:774 → :1086) runs in-process kinds from integration-3's path to the default.

**Measured levers on Qwen3.8.**
- T2 short-prompt tiles: cold TTFT −8 to −11% [B §3.1].
- Emitting the first token before the draft-ring warm-up: −34–40 ms at 1.4k [D §2.4; DP §2].
- T1b: −97 ms at cold 1.45k [DP §0].
- E1 fused attention (L10) and E1(b) GEMMs (L13).
- **The ttft-regression lane:** cold 1.45k −123 ms [−179, −74] [E §2.3; ET]. Its parts:
  - the Direct store;
  - deferred, allocation-free captures;
  - allocation-free clear and restore;
  - no final norm + lm_head on non-final chunks, ≈1.5–2 ms per chunk [E §2.3].

**Regressions to watch.** Integration-3's cold 1.45k was +109 to +130 ms behind main [D §1.5]:
- inline checkpoint captures, ≈+125–170 ms;
- the KV-capacity prefill, ≈+90–100 ms.

**Standing** [E §1.4].
- Cold 1.45k, quiet: 1659 vs Splash 1647 ms (1.01×); back-to-back: 2102 vs 1917 (1.10×).
- Cold 7.9k: 11.77 vs 10.16 s (1.16×).

**First-token gap.** The deferred build moved cost after token 1. Integration-4 vs main: 97 vs 73 ms at cold 1.45k, 153 vs 125 at 7.9k [E §1.4]. Splash streams its first two deltas together (gap 0), so this metric does not compare across engines [E §1.4].

**Pitfalls.**
- **`prefill_tps` is enqueue time,** 3.7× above the wall-clock rate [BQ §5.1]. It was later used deliberately as the enqueue split.
- **Contention hits cold TTFT hard:** +31% at 1.45k when load1 was ≈60 [E §1.4].
- **Idle gaps page the model out** at 42–58 GB of swap, so run TTFT requests back to back [ET §6; EG §9.1].
- **Position effects:** pair samples by position [ET §3.2].
- **Report cost moved separately from cost removed** [ET §0].

**Model dependence: A.** The shares of attention, GEMM and GDN in a prefill are model-specific.

### L18 Memory transients

**Mechanism.** The chunked prefill never synced between chunks, so candle's wired pool grew roughly quadratically with prompt length [DL §6.2]. The growing buffers were:
- a fresh causal mask per layer;
- `[24, 512, kv]` score chains;
- K/V broadcasts.

**Detection signal.** phys_footprint (`proc_pid_rusage` RUSAGE_INFO_V2, or `footprint -p`), not ps RSS [DL §6.1]; a per-request peak footprint monitor.

**Measured on Qwen3.8.**
- **What happened.** A 32k in-process probe **rebooted the machine** at 130.9 GB resident and 117.8 GB wired. A 24k server prefill reached a 119 GB footprint [DL §6.1].
- **Fixes: one causal mask per forward, plus a pool trim between chunks past 2048 tokens** (`TH_PREFILL_SYNC`). The 8k increment fell +17.3 → +7.2 GB, 12k went from >48 GB (killed) to 37.8 GB, and TTFT was unchanged [DL §6.3].
- **E1 fused attention:** the cold 7.9k transient fell +11.4 → +5.0 GB [EA §0].
- **Integration-4 vs main:** cold 7.9k peak 47.2 → 27.9 GB (+12.6 → +3.4 GB) [E §1.5].

**Validation gates.** A 48 / 64 GB footprint guard in every long-context hold. The trim only waits, so TTFT and outputs must be unchanged [DL §6.3].

**Pitfalls.**
- **RSS watchdogs are blind** to candle's StorageModePrivate pool, and the pool is wired, so the rest of the system starves [DL §6.2].
- **`TH_PREFILL_SYNC` was added for the eager path's transients,** which are now gone. It costs a host bubble per chunk (≈10–30 ms) and is a candidate to disable, after a 12–16k footprint check [EA §6; E §6.2].

**Model dependence: A.**

**Code anchors.** qwen35.rs:1634 `causal_mask`, :1676 `prefill_sync_min`, :4975 the trim.

### L19 Thermal and DVFS

**Evidence.**
- **Throttling skews ratios.**
  - In a throttled session, Splash's ms/round climbed from 47.4 to 59.6 within its arms. Splash lost 11% and th 3%, so th/Splash read ≈8% high [BQ §0, §3.2].
  - Phase C's throttled Splash arm would have read 1.109× [C §1.2].
- **Latency-bound kernels lose more at throttled clocks,** so loaded/throttled A/Bs overstate kernel wins: ×1.301 loaded vs ×1.194 quiet [DG §4].
- **DVFS was not the per-round gap.** Inside decode both engines ran at the top P-state (≈1600 MHz, P13 residency 94–99%) [BQ §3.1].
- **Mild thermal did not matter:** level 1–2 on long requests did not move ms/round in Phase C [C §1.1].
- **Cold prefills heat the SoC quickly.**
  - Cold 8k prefills on an old build reach level 2 within one request [D §1.1].
  - 18 back-to-back cold prefills put 16/36 requests at level 2 [E §1.1].

**Protocol consequences** (§4.3):
- gate each arm on thermal pressure 0, and record the level per request;
- exclude throttled arms;
- add per-request thermal waits for 8k;
- sample P-states.

MTPLX recorded the same failure [MTPLX mistakes/ `back-to-back-ab-arms-on-the-27b-read-a-30-percent-thermal-throttle…`].

**Model dependence: hardware and protocol.** It applies to every model. Bigger weights and longer prefills heat faster [I].

---

## 6. Validation gates

Gates are what let a multi-phase, multi-lane program merge cleanly: 92 tests plus the probes below at integration-4 [E §4.1]. **A lever without a gate that can fail is not done.**

### 6.1 The gates

| gate | what it proves | how to run | pass | discrimination / control | source |
|---|---|---|---|---|---|
| V-build | compiles cleanly at every commit | `cargo build --release` + `cargo test --release --no-run` | 0 warnings, 0 errors | per-commit builds when rebasing | [K45 §9.4; E §4.1] |
| unit suite | kernel and policy correctness | `cargo test --release` | all pass (10 → 24 → 37 → 78 → 92 over the program) | each bitwise test must fail under a one-ulp mutation | [B §3.4; C §4; D §4.1; E §4.1; DG §3] |
| **R0a state-bitwise rollback** | committed recurrent state after rollback == forward of the kept rows, bit for bit; slot isolation | `TH_TEST_ROLLBACK=1 TH_BATCH=2 th-engine probe --model $TGT --tokens <ids>` (main.rs:245) | rc 0 | **`TH_GDN_COMMIT=step` must give rc 1** | [CG §3; C §4] |
| R0a variants | the same, through new kernels | also `TH_BATCH=1`; `TH_ATTN_SPLIT_MIN=1`; a 1450-token prompt (fused prefill + split attention) | rc 0 | the legacy-logits line may print FAIL at long prompts (artefact, main.rs:409-416) | [D §4.1; E §4.1] |
| prefix-restore gate | restore == uncached prefill (logits / state / verify / checkpoint) | inside the `TH_TEST_ROLLBACK` probe | 0/0/0/0, slot 0→0 and 0→1 | — | [DP §4] |
| T=0 identity vs base | numerics unchanged, or changed only at known near-ties | per (prompt, iteration) id streams + text sha, every arm pair; `</think>` stripped | identical, or divergences inside the near-tie class with an index | every build must match itself across arms | [BQ §2; E §1.6] |
| **server identity on `spec_a3`** (43 requests) | cache, store and kernel modes are bit-transparent | e.g. `cmp_arms.py <dir> pc_miss pc_on` | 42/42 texts · 42/42 per-round logs | hit == miss; `=0` == main; `=grid` == main; KV-mode arms; fused-kernel-off == lane (merge check) | [DP §3.3; E §4.1] |
| V-lin | per-class max\|Δ\| vs a scalar / fp32 reference | `TH_BENCH_LIN=1\|dec\|pf` (main.rs:427) | decode 28/28 equal; prefill Δref identical, Δlegacy ≤ 1 bf16 ulp | its timing is **not** a signal (A/A band 0.73–1.40) | [T2; U1] |
| V-multi | in-process full-forward time (the tile-policy decider) | `TH_BENCH_MULTI=8,5,1 TH_BENCH_MULTI_ITERS=5` (main.rs:451) | faster or equal | env arms of one binary, interleaved | [K45 §2] |
| logits probes | prefill numerics | probe top-8 on 18 fixed ids; `probe --dump` + `cmp`; `TH_BENCH_PREFILL_LOGITS` (main.rs:874) | identical, or within the tail-chunk noise floor (argmax equal, top-10 10/10) | noise floor = eager + 24-row tail vs eager grid | [K45 §5.2; EG §8; E §4.2] |
| sampling check | GPU accept == CPU reference | `TH_SAMPLE=check` in single-slot and TH_BATCH=2 suites | 0 mismatches (D 476 rounds, E 518) | exactness by enumeration and Monte Carlo | [DS §3–4; D §0; E §0] |
| batch smokes | the state machine under concurrency | TH_BATCH=2: batch2 + pc_batch2 + batch2_long; TH_BATCH=4: spec_batch4 + kv/clear | 35/35 and 16/16 + 3/3 HTTP 200; 0 panic/WARN/ERROR; trigram-repeat ≤ ~0.1; 0 U+FFFD | N2 mixed pairs == all-greedy pairs | [C §4; D §4.1; E §4.1] |
| no-draft / fallback | plain n-gram path; M5 fallback | single slot; TH_BATCH=2 without `--draft` | texts identical to base; exactly one WARN | — | [C §4] |
| `--kv-quant` | TurboQuant slots untouched | `--kv-quant --draft` | T=0 texts identical to base | — | [D §4.1] |
| V-contract | API compatibility | `/status` key paths and `th_stats` keys | additive only (29 → 46 → 49 paths) | — | [C §4; D §4.1; E §4.1] |
| shader validation | no out-of-bounds device access | `MTL_SHADER_VALIDATION=1 MTL_SHADER_VALIDATION_REPORT_TO_STDERR=1` | 0 "Invalid device load" | MEM-1 produced 157 | [B §2.1; RI] |
| static greps | no untracked-Arc escapes; no per-call env reads | grep for `MetalStorage::new(` over cloned buffers; `std::env::var` on hot paths | none added | — | [C §4; D §4.1; E §4.1] |
| memory guard | long prompts stay bounded | phys_footprint guard at 48 / 64 GB | no guard event | — | [DL §6; E §1.1] |
| in-binary A/B arms | the old path still exists and behaves as before | e.g. `TH_OUT_ZEROS=1`, `TH_Q4_PRESUM=0`, `TH_PF=0`, `TH_M1_PATH=mpp`, `TH_PREFILL_ATTN=eager`, `TH_KV_CAP_PREFILL=legacy\|0`, `TH_GDN_COMMIT=step`, `TH_SAMPLE=cpu`, `TH_ATTN_SPLIT=0`, `TH_DRAFT_ATTN_SPLIT=0` | bitwise levers: arm == default; numerics-changing levers: arm == old build | — | [CP §4; DG §2; EA §5] |

### 6.2 Named bitwise unit tests (all present at HEAD)

**Kernels.**
- `split_attention_matches_single_pass`, `draft_attn_split_matches_single_pass`
- `add_rmsnorm_per_row_matches_legacy_bitwise`, `gdn_widths_match_original_bitwise`
- `cand_packed_fused_matches_sort_bitwise`, `ring_write_matches_scatter_bitwise`, `draft_presum_producers_match_plain_bitwise`
- `grouped_attention_is_bitwise_equal_to_broadcast`
- `prefill_attention_matches_reference`, `nax_fragment_mma_matches_cpu`
- `pf_vec_matches_legacy_bitwise`, `pf_presum_chain_matches_prep_bitwise`
- `copy_rows_is_bit_exact_and_bounded`

**State and caching.**
- `gdn_parity_rollback_state_bitwise_over_chained_rounds`
- `prefix_restore_bitwise_matches_uncached_prefill`, `prefix_build_deferred_matches_immediate_captures`, `full_checkpoint_serves_exact_repeats_only`
- `kv_reserve_keeps_rows_and_results`
- `mem6_admission_mode_never_changes_inflight_slot`

**Sampling.**
- `gpu_accept_matches_cpu_reference`, `block_rule_is_exact_by_enumeration`
- `full_vocab_dist_matches_sorted`, `top_p_prefix_matches_full_sort`
- `n2_greedy_tie_rule_matches_argmax`

**Policy and streaming.**
- `pf_policy_only_returns_warmed_shapes`
- `utf8_stream_*`

Sources: [D §4.1; E §4.1; C §4; U1].

---

## 7. Adversarial-review findings and the review checklist

### 7.1 Ledger: what review and verification caught

Each finding was reviewed by its own lens (memory, numerics, state machine), then checked by a separate verification agent in a private worktree [B §2].

**Phase B: the seven perf commits** [B §2.1].

| id | class | symptom / measured impact | lesson |
|---|---|---|---|
| MEM-1 / N1 | shape / out-of-bounds read | draft `o_proj` read 2 MiB from a 64 KiB tensor 5× per propose at 32× the MMA work; `TH_QMM_MPP=0` made every DFlash request return 500; fixing it gave +4.7% tok/s | guard `in_d == inp` in Rust (the guard alone fails every request, so ship it with the reshape); run shader validation |
| MEM-2 / N10 | allocation | `Tensor::zeros` blit fills split the compute encoder: +2.84 ms/round | kernel outputs are uninitialised pool buffers, proved by the `TH_OUT_ZEROS` arm |
| MEM-4 | dead work | ring gathers computed, then discarded: up to +1.40 ms/propose at ring 2048 | remove work before an early return |
| N2 | cross-path numerics | GPU argmax picks the lowest index, CPU `max_by` the last; 1.68% of T=0 rows tie | one tie rule everywhere |
| N3 / N4 | scaling | attention not split over keys: 47.7 ms/round at 8k; draft attention on 8 threadgroups | every perf claim needs a long-context arm |

**Phase B: the multi-slot refactor** [B §2.2].

| id | class | symptom / measured impact | lesson |
|---|---|---|---|
| B1 / MEM-5 | state machine | `take().unwrap()` then `?` poisoned a slot; the scheduler thread panicked; health endpoints stayed green | restore state before propagating errors; `catch_unwind`; report failures |
| M1 | metric | `decode_tps` stopped at encode: 126.1 tok/s reported vs 50.1 by wall clock | every timer ends at a sync |
| M2 / MEM-6 | cross-slot state | an admission flipped the model-wide kv_quant mode; the live slot degenerated ("…Long History…" ×57) | per-slot config, with a unit test |
| M3 | admin endpoint | `kv/clear` wiped a live slot | admin actions skip live slots and report it |
| M4 | error path | failed admission returned HTTP 200 with empty content; `requests_active` leaked | errors reach the client and the counters |
| M5 | config | TH_BATCH>1 without `--draft` failed every request | degrade loudly to a safe mode |
| MEM-3 | allocation | a 40 MiB zero-filled ring placeholder per slot per round: +4.61 ms/round at nb=4 | no allocation inside the round loop |

**Phase B: review-only, or unconfirmed at the time** [B §2.3–2.4].

| id | class | finding | outcome / lesson |
|---|---|---|---|
| anchor off-by-one | position bookkeeping | `pos += 1` before the anchor forward: KV row P attended as zeros, ring slot P never written, RoPE +1 | fixed in E (`ff1157b`), acceptance-neutral [ET §3.7]; probe positions (`TH_CHECK_POS`-style) |
| MEM-7 | memory | a strided conv-window view pinned every GDN layer's in_all output through prefill (≈12.9 GB at 8k) | views can pin memory; G1a's out-of-place carry removed it [CG §2] |
| MEM-9 | bounds | rope table read past `max_position_embeddings` | guard table reads |
| MEM-10 / N5 | cross-request state | draft rings not zeroed; the same request run 1st vs 5th diverged from round 14 | run each request in isolation and after others, and compare |
| MEM-8 / N7 | hard-coded geometry | head_dim 256, DK 128, conv_k 4 and contiguous draft inputs, with no Rust guards | §8.1 inventory |
| MEM-12 / N8 | pipeline cache | `gdn_lib` compiled with the first caller's dims | key caches by geometry (N3's `GeomCache` later hit the same class) [DL §2.1] |
| m6 | host overhead | per-layer `std::env::var` on hot paths (≈70 getenv/round [RI]) | `OnceLock`; `TH_PHASE_TIME` is still read per forward (qwen35.rs:4993) |
| m7 | latency | synchronous prefill in `admit` stalls every live slot | open |
| measurement | metrics | the `seed \| 1` collision; the old `TH_TEST_ROLLBACK` was not state-bitwise; `prefill_tps` is encode time (7,300–19,400 tok/s reported vs ≈420 real); `[verify] enqueue` includes propose; `/metrics` labels one bucket low; `gpuusers.py` misattributed GPU time | §4 rules |
| robustness | API | 200/"stop" with zero usage when the channel closes; duplicate completion ids; `cpu_dequant` stride panic; `int3` vs `[i32;3]` → `MTL_DEBUG_LAYER` abort | — |

**Integration-sim review** [RI]. Should-fix items and their state at HEAD:
1. **GDN presum hard-codes DV = 128.** Open (gdn_kernel.rs:457-458, :1218).
2. **`pf_env` uses 40 cores.** Open (quant_kernel.rs:5108).
3. Stale comment.
4. **Per-call env reads.** Partly fixed; `TH_PHASE_TIME` remains.
5. **No fallback when an `AffineQpf` pipeline fails.** Open.
6. **Bench code lives in qwen35.rs.** Open: :910, :1367, :2356, :2677.
7. `Q4AttachSums` is bench-only production code.

Also noted in that review:
- `r32n256s8` uses exactly the 32 KiB threadgroup-memory limit. A compile failure on another GPU would be only a WARN, then HTTP 500 on every request with that shape.
- Greedy output depends on co-scheduling in batch mode.

**Branch rebases and merges** [K45 §9; T2 fixes; U1 fixes; B §3.4].
- The auto-merged `dflash.rs` did not compile (K45 × multi-slot).
- E0061 (T2 × `clear_kv_cache(slot)`) appeared although `git merge-tree` reported no conflict.
- E0308 (U1 × `Run.text_out`; T2 × K45 tuple return).
- T2 routed batched decode rows through the new tiles unmeasured, and compiled tile libraries lazily in the middle of decode.

**Phase D.**
- **gpu-tail must-fix R1: load-inflated claims.** ×1.301 was withdrawn; the quiet result is ×1.194 [DG].
- **sampled findings** [DS §8]:
  - F1: a full-vocab sort per row for `top_k: 0`;
  - F2: a stub report;
  - F3: no quiet window was ever available.
- **Semantic merge fixes in integration-3** [D §4]:
  - the KV-capacity buffer was not page-aligned, so a prefix-cache hit and its miss would take different attention kernels;
  - two probes both read `TH_BENCH_ATTN`, which made one of them unreachable;
  - E0063, a test-model field.
- **Prefix-cache lane** [DP §0]:
  - a skipped warm-up changed the next request's proposals;
  - T1b fed a time-major V view into gemm, which Metal rejects. It was caught only on the first real-model forward, because the tests covered only contiguous V.
- **gpu-tail** [DG §2]:
  - an uninitialised capacity buffer plus the anchor off-by-one collapsed `--draft` streams (fixed by `e3a4463`);
  - the rows-in-flight kernel was bitwise on the tiny shape but not at 27B.
- **Orchestration:** two lanes' review verdicts never reached the integrator (the lane list was truncated), so they were merged on their own gates [D §3; E §3].

**Phase E.**
- **Item 2 of prefill-attn was not bitwise equal to item 1** (FMA contraction under fast-math). The claim was corrected [EA §5].
- **NAX:** a strict-precision f32 left operand gives garbage [EA §0].
- **A miscompiled kernel variant** in one build [EA §2.2].
- **Two first-run claims withdrawn** as load or paging artefacts [ET §0].
- **"Drop the zero fill" became "zero only the tail, by compute"**, because tails must stay finite [ET §2.1].
- A displaced doc comment [E §4].

### 7.2 Review checklist (run on every lane branch and again on the integration head)

**Memory, aliasing and bounds.**
1. No `MetalStorage::new(...)` over a clone of an existing buffer. Every output is a fresh pool buffer (`outbuf::kernel_out`, `new_buffer_builder`) [K45 §7; C §4].
2. Bit-exact copies use `slice_set` or the word-copy kernel. `Tensor::copy()` aliases, and `affine(1, 0)` flushes −0.0 [CG §2].
3. Every uninitialised output is fully written by its kernel. Prove it with a zeros-vs-empty arm giving identical streams [CP §4.2].
4. Run `MTL_SHADER_VALIDATION=1` on the new paths: 0 "Invalid device load" [RI].
5. Masked or padding rows that kernels read must be finite; zero tails by compute, not blit [ET §2.1].
6. Every kernel geometry assumption has a Rust guard that falls back (head_dim, DK/DV, conv taps, quant group, GQA ratio) [B MEM-8; RI #1].
7. Pipeline and library caches are keyed by geometry, never a process-global first caller [DL §2.1].
8. Long-prompt runs go under a phys_footprint guard, not RSS [DL §6.1]. Views and long-lived small tensors can pin large buffers [B MEM-7; DL §6.2].

**Numerics and identity.**
9. A "bitwise by construction" claim ships with a unit test that fails under a one-ulp mutation [DG §3], **and** a real-model server identity arm (42/42 · 42/42). Tiny shapes are not enough [DG §2; DP §0].
10. After any kernel refactor, re-check bitwise equality: fast-math FMA contraction changes results [EA §5; K45 §4].
11. One tie rule on every path [B N2].
12. Row-count or chunking dependence is understood: canonical chunk plans for caching [DP §2]; slot invariance for batched tiles [T2].
13. A lever that is not bitwise ships with a noise-floor argument (last-position logits vs the engine's own chunking noise, plus a first-divergence pass) [E §4.2].

**State machine and contracts.**
14. No `take().unwrap()` + `?` on slot state. Restore before propagating; `catch_unwind` the scheduler; errors reach the client and the counters [B §2.2].
15. Per-slot configuration never leaks across slots; admin endpoints skip live slots [B M2, M3].
16. The snapshot contract is explicit (light = one forward) and a stale restore is an error [CG §5].
17. Position and length bookkeeping is probed against the KV count [B §2.3].
18. Cross-request state: the same request 1st vs 5th in one process gives identical proposals [B MEM-10; DP §0].

**Measurement integrity.**
19. Every timer that feeds a metric ends at a sync (M1, `prefill_tps`, `[verify] enqueue`) [B §2.4; BQ §5].
20. Odd seeds; explicit sampling parameters [B §2.4].
21. Profiler-mode per-item numbers are used to rank, never summed into savings [DG §4].
22. Claims come from thermal- and load-gated palindromes with redo rules; a load-inflated number is withdrawn, not caveated [DG R1].
23. The build is identified by the sha256 of a frozen binary; each binary path gets a warm-up (shader cache) [T2; BQ §1].
24. No per-call env reads on hot paths (`OnceLock`) [RI #4].

**Merge.**
25. `git merge-tree` clean does not mean it compiles or behaves: build, test and re-run the gates on the merged head. Semantic conflicts seen: E0308, E0061, E0063, capacity alignment, env-name collisions in the probe dispatch [B §3.4; T2; D §4].
26. Every lane's probe is still reachable after the merge [D §4; E §4].
27. Review verdicts actually reached the integrator [D §3; E §3].

**Performance acceptance.**
28. Policy is decided by the in-situ forward A/B, not the isolated kernel bench [K45 §2, §3.1].
29. The old path stays as a read-once env arm [DG §2].
30. Every routed pipeline compiles at load; no first-request compile [T2 fix 4; CP §2.1].
31. Check "moved vs removed" (first-token gap, TTFT vs decode trade-offs). The KV-capacity prefill saved ≈11 ms per request and cost ≈90–100 ms of TTFT [D §1.5].
32. Include a long-context arm and a sampled arm. Short-context greedy alone hid N3/N4 and the sampled `rest` cost [BQ §4.4; C §1.5].

---

## 8. Model dependence and the next-model playbook

### 8.1 Hard-coded assumptions (verified at `b31ca91`)

| assumption | where | levers affected | if a new model violates it |
|---|---|---|---|
| affine Q4, 4-bit, group 64 | qwen35.rs:169 (`bits: 4, gs: 64`); `gs == 64` gates at qwen35.rs:328, :415, :477, :594, :784; `inp % 64` in `pf_route` (quant_kernel.rs:5119); presum layout `inp / 64` (quant_kernel.rs:272) | L05, L06, L13 | slow fallbacks, no presum; a new quant format needs a new kernel family |
| decode tile table keyed on exact Qwen3.8 shapes | quant_kernel.rs:218-219 | L05 | the generic rule applies silently (n64s4 / Paired256) |
| pad-skip limit tuned on this model's K | quant_kernel.rs:252 (`PAD_SKIP_MAX_IN` = 8192) | L05 | pad vs direct choice may be suboptimal |
| 40 GPU cores in the prefill policy | quant_kernel.rs:5108-5111 (`pf_env`), vs `gpu_cores()` at :61 | L13 | wrong occupancy targets on other GPUs |
| DFlash draft dimensions, ring window, codebook rows, capture layers | dflash.rs:30-48 (`CAPTURE_LAYERS` [5,19,33,47,61] at :48) | L07a, L14 capture rows | the draft is per-target: a new target needs a new draft or an MTP head |
| draft kernel geometry (rows 8, hidden 5120, heads 32 / kv 8 / head_dim 128, dyn 1280 / 320 groups) | draft_kernel.rs:112-195 | L07a | — |
| 7 proposals, 8 verify rows | dflash.rs:40; engine.rs:429; sample_kernel.rs:62-64 | L07b, L07c | re-derive the verify depth |
| GDN presum sums: two quant groups per value head (DV 128) | gdn_kernel.rs:457-458, :651-652; guard at :1218 checks only `dv % 64` | L06, L08 | **silently wrong** out-projection sums |
| GDN compile-time geometry and 4 conv taps | gdn_kernel.rs:112, :196, :308 [CG §2] | L08, L12 | — |
| fused prefill attention needs head_dim 256 and GQA ≤ 16 | attn_kernel.rs:1613-1614 | L10 | silent fallback to grouped eager |
| N3 split policy (256-key threshold, 16/32 splits, 32-key pages) | attn_kernel.rs:41, :90-94 | L09 | suboptimal splits |
| KV capacity in 256-row blocks; reserve ≥ 2048 rows | qwen35.rs:3843, :4642, :4825; engine.rs:542 | L11 | — |
| prefix cache block 128, merge 1024, 12 entries, 4096 MiB; Qwen chat-turn markers | prefix_cache.rs:106-113, :136 (`ChatMarks`) | L14 | checkpoint size scales with state size; other templates get no turn-aligned checkpoints |
| GPU top-k ≤ 32 | sample_kernel.rs:48 (`KMAX`) | L07c | larger top-k takes the CPU path |

### 8.2 What transfers, by target type

Everything in this subsection is [I] except the cited MTPLX facts.

**(a) A dense successor with the same hybrid** (GDN + gated attention).
- Engine-level families transfer: L02, L03, L04 method, L07b/c, L08, L11, L14 framework, L16–L19.
- Re-derive the tile tables and split policies (L05, L09, L13).
- Check DV / group size against the presum producers (L06).
- Check head_dim against the fused prefill (L10).
- Build a new draft (L07a).
- Run a fresh acceptance study.

**(b) A MoE hybrid.** MTPLX describes Qwen 3.8 Flash Next as "Qwen's 125B-A6B preview" of the Qwen4 architecture: hybrid GatedDeltaNet + mixture of experts + Qwen Sparse Attention + a 51B-parameter n-gram table [MTPLX README].
- The dense-matmul levers (L05, L06, L13) change shape. The verify rows route to different experts, so the bandwidth floor depends on the *union* of experts the verify rows touch.
- L1's premise, "fwd8 is the cheapest verify shape" [CL §3], must therefore be re-measured.
- Sparse attention needs its own decode and prefill kernels.
- The GDN levers (L08, L12) and the engine levers transfer.

**(c) An MTP-headed model.** MTPLX runs the model's own MTP head as the exact speculative decoder, with no second draft model, and auto-tunes the depth [MTPLX README].
- The DFlash-specific parts of L07a (ring, codebooks, capture rows, ChunkTop16 select, N4) are replaced by the MTP head's forward.
- These transfer: L07b (depth / verify length, B1), L07c (S1), L08, and L14 without capture rows.

**(d) A pure-attention model** (a Gemma-class stack).
- L08 and L12 do not apply; rollback becomes a `kv_tokens` truncation.
- L09 and L10 dominate. Check head_dim against the fused-prefill gate (§8.1).
- The prefix cache could reuse KV pages directly.

**(e) A new quant format.**
- Every Q4 kernel, the presum layout and the tile tables need a new family, and the floors change (bytes per weight).
- MTPLX data point: Ternary Bonsai 2 27B decodes at 64.4 tok/s against 52.6 for 4-bit Qwen 3.8 27B in the same session, at about half the memory [MTPLX README].

### 8.3 Re-derivation steps for any new model

1. **Floors:** bytes per pass, the per-dispatch fit (`TH_BENCH_Q4`, serial mode), and the MMA-only ceiling (standalone harness) [§3; EG §3].
2. **Identity baselines:**
   - T=0 against a reference implementation, and between the engine's own paths;
   - the near-tie class;
   - the prefill-logits noise floor from a tail-chunk split [§4.6; E §4.2].
3. **Sweeps** [K45; EG; DL; EA]:
   - `TH_BENCH_Q4_SWEEP` for decode tiles;
   - `TH_BENCH_LIN=pf` for prefill tiles;
   - `TH_ATTN_SPLITS` / `TH_ATTN_SPLIT_MIN` for N3;
   - `TH_DRAFT_ATTN_SPLIT` / `_KEYS` for N4;
   - `TH_BENCH_STEPS` for chunk size;
   - `TH_PREFILL_ATTN_VARIANT` for E1 shapes.
4. **An acceptance study:** many prompts × seeds, identical-text rounds, `TH_ACCEPT_STATS` [DS §2].
5. **The state-bitwise rollback gate** for every recurrent layer type [CG §3].
6. **A footprint sweep** at 4k / 8k / 12k / 16k prompts under the guard [DL §6.3].
7. **A thermally gated same-session baseline** against the reference engine (§4).

---

## 9. Open pathways at HEAD (ranked by user-visible gain where the reports rank them)

| # | pathway | gap it targets [M] | expected payoff (as cited) | starting point | source |
|---|---|---|---|---|---|
| 1 | chunked (WY / parallel-scan) GDN prefill | sequential `gated_delta_step`: 145 ms at 1.45k, 750 ms at 7.9k | the larger part of the cold 7.9k gap after attention (11.8 vs 10.2 s) | gdn_kernel.rs:118; qwen35.rs:4045 | [E §6.2; EG §10] |
| 2 | fused prefill attention throughput + key split for short suffixes | ≈11–12 TFLOPS effective at 512:7168; 20–96 threadgroups on suffixes | ≤ ≈0.5 s at cold 7.9k, ≈20 ms at 1.45k [E]; ≈30 ms on 8k partial hits [E] | attn_kernel.rs:1154 | [EA §6; E §6.2] |
| 3 | larger prefill chunks (1024 / 2048) and `TH_PREFILL_SYNC` off | one host bubble per chunk (≈10–30 ms × 15 chunks at 8k) plus per-chunk weight sweeps | unknown; needs a 12–16k footprint re-check | main.rs:550; qwen35.rs:1676 | [E §6.2; EA §6] |
| 4 | ctx8k acceptance study on identical text | tokens/round 3.73 vs 4.15 on differing texts | unknown until measured | dflash.rs ring window; N4 | [E §6.2] |
| 5 | swap-based holds for the deferred checkpoint build | first-token gap +24–28 ms vs main | ≈5–40 ms [E] | qwen35.rs:3556 / :3591 | [ET §6; E §6.2] |
| 6 | the last ≈1 ms over integration-3's round and ≈3.5 ms over F_k | 40.49 vs 39.53 ms (contention) and vs ≈36 | needs R0c on a quiet machine | gpuprof.rs; dflash.rs | [E §6.2] |
| 7 | rendered-prompt → ids cache for full hits | ≈12–19 ms of host work per exact repeat | exact repeats 15–34 → ≈5 ms [E] | server.rs, engine.rs | [E §6.2; ET §3.3] |
| 8 | re-measure `TH_PF_PRESUM=1`; consider `TH_PREFIX_CACHE_ASST=1` | ≤ 1% of a forward; −55 ms on continuation turns | small | quant_kernel.rs; prefix_cache.rs | [E §6.2] |
| 9 | N3 split threshold 256 → 64–128 keys | 0.5–0.7 ms/round at bench context | ≈1–1.5% at T=0; changes numerics | attn_kernel.rs:90 | [DL §1.2, §7] |
| 10 | split-attention bandwidth (261 → ≈500 GB/s) | ≈1 ms/round at 8k, ≈4 ms at 32k | bf16 probabilities (−25%, noisier) or double-buffered pages | attn_kernel.rs:709 | [DL §7] |
| 11 | X1/X2: one command buffer per round | the remaining ≈1.1–1.3 ms of idle | ≤ ≈1.3 ms | engine.rs round loop | [C §6.2; D §1.2] |
| 12 | attention-output presum; presum for more than 8 rows; hoisting the per-slot out projection in batch | o: −12% in the bench; batched GDN out swept B times | ≈−0.15 ms per verify [E]; batch unknown | quant_kernel.rs; qwen35.rs:5153 | [K45 §8, §9.6] |
| 13 | 8-bit KV (Splash uses q8s8 KV) | not measured on th | unknown [I] | turboquant.rs, attn_kernel.rs | [BQ §1] |
| 14 | should-fix debt still open at HEAD | correctness on new models, measurement integrity | — | see the list below | [RI; §7.1] |

The should-fix debt in row 14:
- the DV = 128 guard (gdn_kernel.rs:1218);
- `pf_env` cores (quant_kernel.rs:5108);
- `TH_PHASE_TIME` read per forward (qwen35.rs:4993);
- no `AffineQpf` fallback;
- bench code in qwen35.rs;
- the legacy-logits line of the rollback probe (main.rs:409-416);
- `seed | 1` (engine.rs:1367);
- the unsynced `prefill_tps` timer (engine.rs:657-665).

---

## 10. Harness and artifact inventory

### 10.1 Probes in the repo (env-gated; `main.rs` unless noted)

| env | line | purpose |
|---|---|---|
| `TH_GPU_PROF`, `TH_GPU_PROF_EVERY` | gpuprof.rs:305-312 (armed at main.rs:110) | R0c per-(phase, region, kernel) GPU time |
| `TH_DEBUG_TIMING` | engine.rs:302 | per-round `[dflash]` / `[verify]` / `[batch]` phases |
| `TH_DEBUG_PREFILL` | engine.rs:454 | synced prefill phases (lookup / restore / chunks / holds) |
| `TH_TEST_ROLLBACK` | :245 (gate :253, exit :420-421) | R0a state-bitwise and prefix-restore gates |
| `TH_MPP_PROBE` | :234 | compile every MPP pipeline, no GPU work |
| `TH_PF_COMPILE` | :190 | compile-only check of the prefill tile library |
| `TH_TOKENIZE` | :172 | print server-rendered prompt ids for probes |
| `TH_BENCH_LIN` (=1\|dec\|pf; `TH_BENCH_PF_M`) | :427 (qwen35.rs:2677) | V-lin max\|Δ\| + per-class timing; prefill sweep |
| `TH_BENCH_Q4` (`_SWEEP`, `_SERIAL`, `_ONLY`, `_M`) | :440 (qwen35.rs:910-936) | decode kernel GB/s; autotune sweep |
| `TH_BENCH_DRAFT_MLP` | :446 | draft MLP at propose / batched shapes |
| `TH_BENCH_MULTI` (`_ITERS`) | :451 | V-multi in-process forward |
| `TH_BENCH_PREFILL` (`_LARGE_ONLY`) | :492 / :502 | in-process prefill A/B (legacy vs tiles, or m > 128 only) |
| `TH_BENCH_STEPS` (`_REPS`) | :550 | prefill chunk-size A/B |
| `TH_BENCH_PLAN` (`_MERGE`, `_STEP`, `_REPS`) | :611 | cache plan vs grid vs hit |
| `TH_BENCH_TTFT` (`_KINDS`, `_REPS`, `_GAP_MS`, `_THERM`, `_IDS`, `TH_BENCH_DRAFT`) | :774 (fn at :1086) | in-process cold-TTFT kinds |
| `TH_BENCH_ATTN` | :221 (no `:` → N3 no-model bench) / :778 (`seq:kv` → T1b bench) | decode / eager attention kernels |
| `TH_BENCH_PREFILL_ATTN` (`_VARIANTS`) | :212 | fused prefill attention vs grouped vs sdpa |
| `TH_BENCH_DRAFT_ATTN` | :204 | N4 draft attention kernel |
| `TH_BENCH_PREFILL_LOGITS` (`_IDS`, `_REPS`, `_STEP`) | :874 | eager vs fused last-position logits + noise floor |
| `TH_BENCH_BATCH` | :972 | batched verify A/B + slot invariance |
| `TH_BENCH_ALLOC` | :228 (outbuf.rs:196) | allocation-path microbench |
| `TH_BENCH_GDN` | gdn_kernel.rs:2694 (cargo test) | GDN step / commit kernel bench |
| `TH_ACCEPT_STATS`, `TH_SAMPLE=check` | engine.rs:1713, :1538 | Rao-Blackwellised acceptance; GPU vs CPU accept check |

### 10.2 Probes that exist only on branches

These are not on main. Port them before the next job.
- `TH_BENCH_ROUND`, the in-process 4-arm long-context round A/B with KL / top-20: `th/d-longctx-probe` @`5090f18` [DL §0].
- `TH_BENCH_ZEROS`, the MEM-2 microbench: `th/c-ports-mem2bench` @`af0e850` [CP §0].
- `TH_PF_ROWINV`, the row-invariance probe: a patch in the wp10 worktree [T2].
- `TH_MEM1_UNIT` (`7164c2a`), `TH_CHECK_POS` (`28acf03`), and `TH_TEST_BATCH_DUMP`, an uncommitted patch [B §2; K45 §9.4].

### 10.3 Harness outside the repo

`.worktrees/` is excluded by `.git/info/exclude:7`, so none of this is versioned:
- **`.worktrees/_phaseC/bin/`:** `gpu-lock` (the flock wrapper), `wt-bootstrap` (worktree + APFS-cloned target), `aggregate.py`, `bench-engines-port.sh`.
- **Per-lane `work/*/bench/`:**
  - session scripts, from `session.sh` through `fin.sh` to `fin4d.sh`;
  - the client, from `bq_client.py` to `bq4_client.py`;
  - analysis: `q4_analyze.py`, `ab4.py`, `ttft4.py`, `fp4.py`, `conds4.py`, `logits_cmp.py`;
  - samplers: `gpufreq.py`, `gpuq.py`;
  - the footprint guard, `fpguard.py` / `fpmon.py`;
  - the passages: `passage.txt` (sha1 `a886db14acc4`) and `passage8k.txt` (sha1 `6ab8ad9a056a`).
- **The integration gate scripts** (`work/integration-{2,3,4}/bin/gates*.sh`, e.g. `work/integration-4/bin/gates4.sh`, plus `gates-tools/cmp_arms.py`).
- **The `mtlc3.m` interposer** (`work/th-c-loop/mtlc/`) and the standalone GEMM harness (`work/th-e-prefill-gemm/harness/*.swift`).

Phase B already lost time to missing harness pieces: `wt-bootstrap`, `qbench`, `mtlcount`, `parse_log.py` and `waitquiet.py` did not exist, and SYNTHESIS was wiped [K45 §0; B App. A]. **Vendoring this harness into the repo is the single highest-leverage preparation for the next job** (recommendation R1).

### 10.4 In-repo scripts

- `scripts/bench-engines.sh`: the stock bench. Its "decode" figure is overstated; use ratio-of-sums loop tok/s [Bb caveat 3].
- `scripts/start-engine.sh`.
- The reports: `engine/reports/perf-2026-09/` (§1).

---

## 11. Recommendations for the next model optimisation job

These are referenced from the sections above. Payoff statements cite measured precedents; mechanisms marked [I] are this document's inference.

| # | recommendation | mechanism | effort | payoff / precedent |
|---|---|---|---|---|
| R1 | Vendor the measurement harness into the repo (e.g. `engine/bench/`) | `gpu-lock`, `wt-bootstrap`, the gated palindrome session runner (fin4d.sh lineage), `bq4_client.py`, analysis scripts, passages with their sha1, footprint guard, P-state and GPU-client samplers, the `mtlc` interposer, the standalone GEMM harness; port `TH_BENCH_ROUND` to main | M | Each phase re-created or reworked the harness: Phase B found `wt-bootstrap`, `qbench`, `mtlcount`, `parse_log.py` and `waitquiet.py` missing, and Phase E went through `fin4` → `fin4d` [K45 §0; B App. A; E App. A]. This makes §4 executable in one command. |
| R2 | Make model geometry explicit: a per-model shape manifest checked at load | Guards with logged fallbacks for every §8.1 assumption; fix the DV = 128 presum guard first (gdn_kernel.rs:1218) | M | Turns silent wrong or slow paths into loud ones (MEM-8, RI #1). |
| R3 | Replace compiled tuning constants with a per-(model, GPU) calibration step | Run the §8.3 sweeps; write the decode tile table, prefill policy, split counts and chunk size to a file; use `gpu_cores()` everywhere | M | K2/K45(c) autotune found −11% on one shape [K45 §3.2]; wrong core counts skew occupancy (RI #2). |
| R4 | One in-repo gate script for §6.1 | Port `gates4.sh`: tests, R0a variants plus the step-discrimination arm, batch smokes in check mode, prefix-cache on/miss/0, kv-quant, no-draft, V-contract, shader validation, logits probe | S–M | Semantic merge bugs were caught only by full gate runs on merged heads [D §4; E §4]. |
| R5 | Commit the floors derivation | A small tool: bytes per pass from safetensors, the per-dispatch fit from `TH_BENCH_Q4` serial mode → F_bw, F_k | S | Targets from day one; SYNTHESIS is not in the repo [B header]. |
| R6 | Pay the measurement-integrity debt at HEAD | Sync or rename `prefill_tps` (engine.rs:657-665); remove the `seed \| 1` collision (engine.rs:1367; changes sampled streams, so gate it); read `TH_PHASE_TIME` once (qwen35.rs:4993); fix the legacy-logits line (main.rs:409-416); add an `AffineQpf` fallback | S | Every one of these misled at least one lane (§7.1). |
| R7 | Adopt the lever template | Read-once env arm + bitwise unit test with a mutation check (or the noise-floor protocol) + in-binary A/B + long-context and sampled arms + [M]/[D]/[E] tagging | S | The C, D and E integration heads merged with no open must-fix item [C §3; D §3; E §3]. In-binary arms located regressions directly: the KV-capacity TTFT cost via `TH_KV_CAP_PREFILL=0`, the MEM-2 cost via `TH_OUT_ZEROS=1` [D §1.5; CP §4]. |
| R8 | Schedule quiet measurement windows, or a dedicated machine | Tiered thermal + load gates, redo rules, standings only from quiet replicates | S (process) | Loaded runs overstated a gain by about 2× and forced withdrawals [DG §4]; in Phase D, load1 never fell below 6 across 124 one-minute samples (≈2 h) [DS §8.3]. |
| R9 | Plan MoE / MTP / sparse-attention work items explicitly | Expert-GEMM tiles and routing-aware verify cost (re-measure verify cost vs rows before adopting L1); an MTP-head verify loop replacing the DFlash-specific parts; sparse / sliding attention kernels. Keep the engine-level levers | L | [I]. The Qwen4-architecture preview is hybrid GDN + MoE + sparse attention + an n-gram table [MTPLX README]. |
| R10 | Move bench code out of qwen35.rs | Create `engine/src/bench.rs` (RI should-fix #6); port the probe-branch harnesses (§10.2) | S–M | Lower merge-conflict surface in the most-edited file [RI; D §4]. |
