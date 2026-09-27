# th/c-gdn-parity: G1a, persistent double-buffered GDN parity state

Written 2026-09-26 ~06:55 AEST. Branch `th/c-gdn-parity`. Worktree `/Users/benebsworth/projects/token-horizon/.worktrees/th/c-gdn-parity`. Base: `report/integration-sim` @`8d5b6d5`. Nothing was pushed.

## 0. Result

| | base `8d5b6d5` | G1a `a93f982` | Δ |
|---|---|---|---|
| T=0 ms/round (s3, 4 arms each, identical tokens) | 55.04 | **48.69** | **−6.35 (−11.5%)** |
| T=0 loop tok/s | 65.50 | **74.04** | +13.0% |
| verify host encode (`[verify] enqueue` − propose; includes `snapshot()`) | 8.00 | **2.72** | −5.28 |
| propose / rest | 8.18 / 1.02 | 7.44 / 0.47 | −0.74 / −0.55 |
| GPU-busy ms/round (ioreg slope) | 48.36 | 47.38 | −0.98 |
| idle (Phase-B definition: ms/round − GPU slope) | 6.68 | **1.31** | −5.37 |
| host CPU ms/round (slope) | 15.67 | 8.39 | −7.28 |
| TH_BATCH=2, nb=2 rounds, ms/round | 87.8 | **76.4** | **−11.4 (−13%)** |
| verify forward alone, `TH_BENCH_MULTI` fwd8 / fwd1 (median, n=20) | 39.90 / 41.85 | 40.05 / 41.40 | noise |

- **Expected −7 to −10 ms/round.** Measured −6.35 at T=0 and −6.46 across all requests single-slot, and −11.4 at TH_BATCH=2. It pays off, so it is **on by default**.
- **The round is now GPU-bound:** 1.3 ms idle of 48.7 ms at T=0. The rest of the gap to the kernel floor is GPU work.
- **R0a state-bitwise gate** (`TH_TEST_ROLLBACK`, exits 1 on failure):
  - **Before (base code):** FAIL, rc=1, on kept=1..7. 1.3M–6.3M of 37.7M recurrent f32 elements differ, max |Δ| 3.8e-6, in all 48 layers.
  - **After:** PASS, rc=0. For kept=1..8 the recurrent state is 0/37,748,736 different and the conv windows 0/1,474,560. Slot isolation holds.
- **Semantics:**
  - T=0: 3/3 bench prompts are token-identical to base, in every arm.
  - Sampled: 3/9 requests are identical. The other 6 diverge at ids #33–#94, because rollback numerics are now exact (§3).
  - The A/B arm `TH_GDN_COMMIT=step` keeps the old rollback numerics inside the new parity machinery. It is **48/48 token-identical to base, T=0 and sampled**, at ≈+0.4 ms/round against the default.
- **TH_BATCH=2 smoke:** passes. All 4 arms returned 9/9 HTTP 200 with no errors and max trigram-repeat ≤0.097. The T=0 batch texts are identical to base.

## 1. Commits (on `th/c-gdn-parity`, trailer `Co-Authored-By: Claude Opus 5.5`)

| sha | item | files |
|---|---|---|
| `79cfba4` | **R0a state-bitwise rollback gate** in `TH_TEST_ROLLBACK`, against the base code (so the gate could run "before") | main.rs, qwen35.rs (+309 lines) |
| `a93f982` | **G1a** parity state + commit kernel + tests | gdn_kernel.rs, qwen35.rs, main.rs, model.rs (+1076 −480 lines) |

Binaries used for every number:
- base `8d5b6d5`: sha256 `e91a30d2afb7` (the integration build).
- c1 `79cfba4`: `0e4a165069ef`.
- c2 `a93f982`: `e68241b23cc1`.

Copies are in `$P/work/c-gdn-parity/bin/`.

## 2. Design (line numbers @`a93f982`)

**State: `qwen35.rs:1642` `GdnState { conv: [Tensor; 2], rec: [Tensor; 2] }`.**
- Each slot owns, per GDN layer, two conv windows ([3, 10240] bf16) and two recurrent states ([48, 128, 128] f32).
- These buffers are allocated once per slot (`Slot::new`) and never shared with another slot, a snapshot or a view.

**Parity: `qwen35.rs:1660` `GdnParity { cur, ids[2] }`.**
- The committed state is in parity `cur`, and `ids[p]` is a content version.
- `begin()` (1679) invalidates the other parity.
- `flip()` (1687) runs once per completed forward, after all 64 layers. It is called at `forward_inner` :3824 and `forward_batch` :3994.
- A forward that errors never flips. The committed parity stays intact because nothing writes it in place.

**Kernels (`gdn_kernel.rs`).**
- `gdn_fused_step` (kernel :290, wrapper :724):
  - Reads the state and conv window from parity p and writes the post-T-row state and the new conv window to parity 1-p.
  - The window carry is done in-shader (:332). The owner of each k-head writes the q/k channels and each v-head writes its own channels.
  - **Commit mode** (`z`/`y` = None) returns before the gated norm (:428). It re-scans the kept rows through the identical instruction stream, so the committed state is bit-identical to a forward of those rows.
  - The step-rescan `pack` stash is now written only when it is needed.
  - The wrapper bails if a state or conv output aliases its input, or if the window is not [3, conv_dim]. The shader hard-codes 4 conv taps; this partly addresses MEM-8.
- `gated_delta_step` → `gdn_step()` (kernel :118, fn :495): out of place, optional `y`. It replaces the in-place CustomOp3. It serves the prefill path (seq > 8) and `TH_GDN_STEP`.
- `gdn_conv_carry` (kernel :676, fn :1039): copies the window into the other parity on the non-fused path. No view pins the `in_all` projection output any more, which is a side-fix for MEM-7.

**Snapshot and rollback (`qwen35.rs`).**
- `snapshot()` (:2615) is light: it records the committed parity's id and does no GPU work. It is valid across the one forward that follows.
- `snapshot_deep()` (:2629; also `model.rs:197`) makes bit-exact copies, for probes that restore one state many times.
- `restore()` (:2649):
  - Light snapshot: flips back if the state is still resident; otherwise it returns an error. It never silently restores the wrong state.
  - Deep snapshot: copies into the committed parity.
- `rollback_verify()` (:2692) re-scans only the kept rows. It reads from the intact parity (light) or the deep copies, and writes into the committed parity with one fused commit dispatch per layer, with no state allocations. A full accept (kept ≥ rows) is a no-op.
- `TH_GDN_COMMIT=step` (:1432, read once) switches the rollback to the old `gated_delta_step` re-scan of the stash, as an A/B arm.

**Removed per round, per slot:**
- 48 `affine` copies of 4 MiB in `snapshot()`.
- 48 more in `rollback_verify()`.
- The cat + contiguous conv-window copies.
- 48 pack allocations of 160 KiB.
- The per-call env reads `TH_DEBUG_ROLLBACK` and `TH_GDN_AB_CONTIG`, now cached.

**Bit-exact copies: `state_copy` (:1455).** In candle 0.11 Metal, `Tensor::copy()` aliases the buffer (`try_clone` is an Arc clone), and `affine(1, 0)` flushes −0.0 to +0.0. So copies use `slice_set` into fresh zeros. No `MetalStorage::new(existing.clone())` was introduced, which avoids the untracked-Arc bug class.

**Memory.**
- Persistent: +≈195 MiB per slot for the second parity.
- Gone: 192 MiB of transient copies per slot per round.
- RSS after a run: base 19.93 GB, c2 19.95 GB (from `/status memory.rss_bytes`).

**Unchanged:** callers in engine.rs, `/status`, `th_stats`, and the public signatures `snapshot(slot)` / `restore(slot, snap)` / `rollback_verify(slot, snap, kept)`.

**In-tree callers audited:**
- engine.rs :444/:550 (DFlash B=1), :619/:665 (n-gram restore + re-forward), :1466/:1592 (batch). All restore or roll back across exactly one forward.
- The main.rs probes that restore across more than one forward now use `snapshot_deep`: main.rs:234-235 and :481.

## 3. Semantics and validation

**R0a gate** (`qwen35.rs:4104` `rollback_state_check`, :4218 `slot_isolation_check`; main.rs:203-229, exit at :339-341).
- For each kept=1..8, the probe runs a real engine round: light snapshot → verify 8 rows → `rollback_verify(kept)`, skipped at kept=8 as in the loop.
- It then compares every GDN layer's committed state bit for bit against a reference: a forward-mode `gdn_fused_step` over only the kept rows, starting from a deep copy of the pre-verify state.
- It also checks the kernel's written conv window against a host-built window.
- For information it prints the diff against a `gated_delta_step` re-scan and against a continuous kept-row `forward_multi`.
- With `TH_BATCH=2` it adds slot isolation: a round on slot 1 leaves slot 0 untouched, and the same round on both slots is bitwise equal.

| run (build, env) | kept=1..7 recurrent ≠ ref | kept=8 | conv ≠ ref | slot isolation | verdict |
|---|---|---|---|---|---|
| before: c1 `79cfba4` (base code) | 1,325,021 / 2,383,003 / 3,272,650 / 4,112,239 / 4,958,000 / 5,694,885 / 6,272,759 (max 1.9–3.8e-6, 48/48 layers) | 0 | 0 | ok | **FAIL rc=1** |
| after: c2 `a93f982` | 0 at every kept | 0 | 0 (kernel window = host window) | ok / ok | **PASS rc=0** |
| after, `TH_GDN_COMMIT=step` | same counts as before | 0 | 0 | ok | FAIL rc=1 (the gate discriminates) |

- In c2, the rollback state also equals a **real `forward_multi` of the kept rows** for kept=2..8: 0 of 37.7M elements differ in all 48 layers.
  - On base, the same comparison differed by exactly the step-vs-fused amount.
  - kept=1 differs in every build (36.9M elements, max 1e-2). A 1-row forward takes different matmul kernels upstream, so this is batch-shape noise and not rollback.
- Legacy logits check:
  - Before: worst |Δ| 0.1094 at kept=1, 0.0938 at kept=4, 0.0781 at kept=7, and 0.0938 at kept=8 (self).
  - After: 0.1094 at kept=1 (the m=1 path), and **0.0000** at kept=4, 7 and 8. argmax ref=rb=ctl=68.
- Logs: `$P/work/c-gdn-parity/runs/probe/roll_{before_c1,after_c2,after_c2_step}.log`.

**Unit tests** (`qwen35.rs:4275` `gdn_parity_tests`). These use a tiny all-GDN model: hk=1, hv=3, dk=dv=128, 2 slots, on Metal.
- The state-bitwise gate over 11 chained rounds with kept=1..8 each, plus slot isolation.
- Light-snapshot rules: restore across one forward; error after two or after a clear; deep snapshots restorable repeatedly.
- Mutation check: with `TH_GDN_COMMIT=step` the chained-round test fails, as intended.
- `cargo test --release`: 26/26 pass (24 existing + 2 new). The build has 0 warnings.

**Why T=0 is identical and sampled differs.**
- The parity machinery by itself changes no numerics. The `step` arm reproduces base token for token on 48/48 request pairs (session s2).
- The default fused commit makes the post-rollback state equal the state the verify's accepted logits came from. The old re-scan differed from it by up to 3.8e-6 in up to 6.8M elements.
- On the 3 bench prompts at T=0 that difference never flips an argmax. Sampled trajectories flip at ids #33–#94 (code s1/s3/s5 at #43/#33/#40; long s1/s3/s5 at #50/#94/#35). Every build is deterministic across its own arms: base vs base 144/144 identical.
- If byte-identity with the old streams is preferred, set `TH_GDN_COMMIT=step` as the default. That costs ≈0.4 ms/round and gives up the exact-rollback property.

## 4. Measurements

**Method.**
- Every arm is a fresh server on :8032 with `TH_DEBUG_TIMING=1`, run under `gpu-lock`.
- Client: warm-up, then the 3 bench prompts at T=0, then T=0.6 / top_p 0.95 / top_k 20 with seeds 1, 3 and 5. max_tokens 128.
- Metrics are ratio-of-sums over the logged `[dflash]` rounds.
- GPU and CPU are ioreg / ps per request. Slopes are least-squares fits against rounds+1.
- Load and GPU-quiet are recorded before every arm; other clients used 25–37 ms/s of GPU, which is WindowServer.

**s3, 06:42–06:49, load 2.7–5.7. ABBA×2: base, c2, c2, base, base, c2, c2, base. This is the headline.**

| build | subset | rounds | tok/round | ms/round | loop tok/s | propose | verify encode | GPU wait+rb | rest | GPU-busy Σ / slope | host CPU | idle (ms/round − GPU slope) | TTFT med |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| base | t0 | 304 | 3.605 | 55.04 | 65.50 | 8.18 | 8.00 | 37.88 | 1.02 | 52.49 / 48.36 | 15.67 | 6.68 | 174 |
| c2 | t0 | 304 | 3.605 | **48.69** | **74.04** | 7.44 | 2.72 | 38.04 | 0.47 | 51.46 / 47.38 | 8.39 | 1.31 | 171 |
| base | sampled | 1044 | 3.146 | 57.01 | 55.18 | 8.44 | 8.12 | 37.88 | 2.52 | 52.10 / 48.01 | 16.75 | 9.00 | 173 |
| c2 | sampled | 1004 | 3.287 | **50.53** | 65.05 | 7.73 | 2.72 | 37.89 | 2.23 | 50.99 / 46.39 | 9.63 | 4.14 | 172 |
| base | all | 1348 | 3.249 | 56.56 | 57.44 | 8.38 | 8.09 | 37.88 | 2.18 | 52.18 / 48.08 | 16.69 | 8.49 | 174 |
| c2 | all | 1308 | 3.361 | **50.10** | 67.08 | 7.66 | 2.72 | 37.92 | 1.82 | 51.10 / 46.55 | 9.51 | 3.55 | 172 |

- Per-arm T=0 ms/round: base 55.83 / 54.94 / 54.58 / 54.81; c2 48.93 / 48.12 / 49.60 / 48.13. Every base arm is ≥5 ms slower than every c2 arm.
- Sampled tokens/round differ only because the trajectories diverged. At base's 3.146 tokens/round, c2's ms/round gives 62.3 tok/s against 55.2.

**s2, 06:23–06:30, load 2.6–7.2. ABCCBA: base, c2, step, step, c2, base, then TH_BATCH=2 ABBA.**
- First half, clean (per arm, T=0 ms/round / tok/s):
  - base_1: 54.47 / 66.2.
  - c2_1: 48.33 / 74.6.
  - step_1: 48.94 / 73.7.
  - step_2: 48.50 / 74.3.
- Step arm: verify encode 2.9–3.0 ms against 2.6–2.7 for c2, because it also writes the pack stash, and rest 0.50–0.58 against 0.33–0.50. So the step arm costs ≈+0.4 ms/round against the default.
- Second half, perturbed: GPU wait+rb rose to 44.5 (c2_2 sampled) and 42.2 (base_2), with GPU-busy up to 58 ms/round on both builds. This came from outside the GPU-quiet check, probably memory-bandwidth contention.
  - Still: base_2 T=0 60.32 vs c2_2 T=0 48.36.
  - Pooled s2 T=0: 57.40 → 48.34.

**TH_BATCH=2, s2** (`batch2_client.py`: a warm-up, then 2 concurrent T=0 pairs and 2 sampled pairs).

| arm | HTTP 200 | nb=2 rounds | nb=2 ms/round (propose+snapshots / verify enqueue / readback / accept) | nb=1 ms/round |
|---|---|---|---|---|
| b2_base_1 | 9/9 | 95 | 89.50 (21.85 / 7.34 / 21.61 / 38.69) | 59.70 |
| b2_c2_1 | 9/9 | 95 | **76.90** (11.09 / 5.56 / 21.83 / 38.42) | 53.27 |
| b2_c2_2 | 9/9 | 95 | **75.93** (10.93 / 5.42 / 21.38 / 38.20) | 53.31 |
| b2_base_2 | 9/9 | 95 | 86.09 (21.04 / 7.09 / 20.71 / 37.23) | 58.06 |

- No errors. Finish reasons were {stop 2, length 7} in every arm. Max trigram-repeat was 0.097 for base and 0.089 for c2. Completion tokens were 996 in every arm.
- T=0 batch texts: 4/4 identical between base and c2. Sampled: 4/4 diverge (chars 126–165). Each build reproduces its own outputs across both of its arms.

**`TH_BENCH_MULTI=8,1`, 5 iterations; s1 and s3, ABBA each** (the forward alone, no snapshot or rollback).
- fwd8 median: base 39.90 vs c2 40.05. The minima are 39.30 in both.
- fwd1: base 41.85 vs c2 41.40.
- The out-of-place writes plus the in-shader window carry cost nothing measurable. The whole gain comes from snapshot and rollback.

## 5. Notes for the orchestrator

1. **Ownership.** qwen35.rs slot state, snapshot/restore/rollback and the forwards, plus model.rs and main.rs, are the other developer's area. The public API is unchanged apart from the new `snapshot_deep`. It needs their sign-off.
2. **Light-snapshot contract.** `snapshot()` is now valid for exactly one following forward on that slot. `restore()` and `rollback_verify()` return an error otherwise; they never silently restore a stale state. Any future caller that restores across several forwards must use `snapshot_deep()`.
3. **The default changes sampled trajectories.** The rollback now commits with the fused kernel. T=0 on the bench prompts is unchanged. `TH_GDN_COMMIT=step` gives base-identical streams.
4. **Untested paths.** The eager path (CPU / `TH_GDN_EAGER`) was updated for parity but not exercised on the real model. The prefill (seq > 8: `gdn_step` + `gdn_conv_carry`) runs on every request and is covered by T=0 identity. The batch path is covered by the smoke test and the batch T=0 identity.
5. **Follow-ups not done:**
   - One dispatch for all 48 layers' commits, like Splash's `verify_gdn_commit`, would save ≈0.2–0.4 ms.
   - The remaining MEM-2 zero-fill (`gated` on the non-presum path, `TH_Q4_PRESUM=0` only).
6. **Cleanup.**
   - All servers I started (18 on :8032) were stopped by `serve.sh`, and :8032 is free.
   - :8000 was never used. :8001 is still pid 16917, untouched.
   - The main working tree was not touched.

## 6. Reproduce

```sh
P=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC; W=$P/work/c-gdn-parity
(cd /Users/benebsworth/projects/token-horizon/.worktrees/th/c-gdn-parity/engine && cargo build --release && cargo test --release)
$P/bin/gpu-lock -- $W/bin/probe.sh roll_after_c2 $W/bin/th-engine-c2-a93f982 TH_TEST_ROLLBACK=1 TH_BATCH=2   # gate; rc=1 on mismatch
$P/bin/gpu-lock -- $W/bin/session1.sh   # after-probes (default + step) + TH_BENCH_MULTI ABBA
$P/bin/gpu-lock -- $W/bin/session2.sh   # e2e ABCCBA base/c2/step + TH_BATCH=2 ABBA
$P/bin/gpu-lock -- $W/bin/session3.sh   # before-probe (c1) + e2e ABBA x2 + TH_BENCH_MULTI ABBA
python3 $W/bin/e2e_report.py $W/runs/e2e3 base:base_1,base_4,base_5,base_8 c2:c2_2,c2_3,c2_6,c2_7
python3 $W/bin/e2e_report.py $W/runs/e2e base:base_1,base_2 c2:c2_1,c2_2 step:step_1,step_2
python3 $W/bin/b2_report.py $W/runs/e2e b2_base_1 b2_c2_1 b2_c2_2 b2_base_2
```

Raw data:
- `$W/runs/{e2e,e2e3,probe}/` (server logs, jsonl, gpu before/after).
- `$W/runs/s3_e2e.md`, `s2_e2e.md`, `s2_b2.txt`, `session{1,2,3}.out`.
