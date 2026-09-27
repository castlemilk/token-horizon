# th/c-loop: L1 (verify all 7), Q1 (decode QoS), D1 (one propose sync), anchor off-by-one

Written 2026-09-26 by the th/c-loop agent. Everything here is measured on the M5 Max (40-core GPU, 128 GB, macOS 26.5.1), Qwen3.8-27B-4bit + DFlash draft, private port :8031, every GPU-timed run inside `$P/bin/gpu-lock`, fresh server per arm, `TH_DEBUG_TIMING=1`. Tags: [M] measured, [D] derived.

- **Branch:** `th/c-loop` (worktree `/Users/benebsworth/projects/token-horizon/.worktrees/th/c-loop`), started from `report/integration-sim` @`8d5b6d5`. Not pushed.
- **Parked:** `th/c-loop-anchor` @`68f3423` (= th/c-loop's D1 commit + the anchor fix). Not in th/c-loop, see §6.
- **Work dir (scripts, logs, binaries):** `/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC/work/th-c-loop/` (`tools/`, `bin/`, `s_L1/`, `s_2/`, `s_3/`, `s_4/`, `s_5/`).

## 0. Summary

| item | shipped as | effect [M] | decision |
|---|---|---|---|
| **L1** always verify 7 (8 rows) | `868fe34`, default on; `TH_VERIFY_ADAPTIVE=1` restores the old rule (read once) | T=0 3 prompts: **3.605 → 4.410 tokens/round (+22%)**, 56.39 → 55.78 ms/round, **63.9 → 79.1 tok/s (+23.7%)**. Sampled (0.6/0.95/20, seeds 1,3,5): 3.146 → 3.938, 59.24 → 58.05 ms/round, 53.1 → 67.8 tok/s (+27.7%). 15-prompt T=0 set: 3.821 → 4.299 (+12.5%), 69.0 → 79.3 tok/s (+14.8%). fwd8 is the *cheapest* verify shape (39.7 ms vs fwd2 41.5). | **default on** |
| **Q1** decode thread at USER_INTERACTIVE | `2498d35` (default on) then `be12e45` (default off, `TH_DECODE_QOS=interactive` opt-in) | load 3-6: −0.27 ms/round (57.54 → 57.27), host encode 7.97 → 8.05 ms, idle 8.6 → 8.7 ms: nothing. 18 default-QoS spinners on 18 cores (load 8 → 31): −0.47 ms/round (61.88 → 61.41), inside the arm spread. Tokens identical. | **default off** (no measurable gain) |
| **D1** host-resident codebooks, 1 propose sync | `d84bd7d` | Host syncs (`waitUntilCompleted`) per round **6.00 → 2.00** (interposer count, slope over 4 requests); commits/round 23.4 → 19.6. Propose **8.27 → 7.36 ms**, ms/round 56.99 → 56.08 (−1.6%), tok/s 70.97 → 72.13 (ABBA, load 3-4). Outputs identical (24/24). Batched propose: cand_tables+gathers 9.09 → 7.90 ms. | **default on** |
| **anchor off-by-one** (d523828 + batch path) | `68f3423` on `th/c-loop-anchor` only | T=0 15-prompt set: **4.299 → 4.286 tokens/round (−0.3%)**, 79.27 → 79.23 tok/s; 3 bench prompts 4.410 → 3.899 (one prompt's text flip); sampled 3.938 → 3.717. No gain. | **not in th/c-loop** (task rule: fix only on a tokens/round gain) |

**Head `be12e45` (L1 + D1, Q1 opt-in) vs base `8d5b6d5`** (s_5, ABBA, load 2.5–3.4): T=0 **55.46 → 54.65 ms/round, 3.605 → 4.410 tokens/round, 65.0 → 80.7 tok/s (+24.2%)**; all 24 requests 56.74 → 56.35 ms/round, 3.249 → 4.045, **57.3 → 71.8 tok/s (+25.3%)**; propose 8.23 → 7.44 ms; TTFT median 175 = 175 ms; TH_BATCH=2 smoke 9/9 OK.

## 1. Commits and binaries

| sha | item | summary |
|---|---|---|
| `868fe34` | L1 | single-slot DFlash verifies all 7 proposals; `TH_VERIFY_ADAPTIVE=1` = legacy `round(ema)+1` clamp 2..7 (OnceLock, logged at load); `TH_DEBUG_TIMING` read once; `[dflash]` line gains trailing `vlen=`/`prop_ms=` (existing fields unchanged). Test `engine::dflash_policy`. |
| `2498d35` | Q1 | `decode_qos` guard: single-slot `spawn_blocking` thread raised for the request and restored on drop; `th-batch` thread raised once. `TH_DECODE_QOS` read once. Tests `engine::decode_qos_tests`. |
| `d84bd7d` | D1 | pred/succ codebooks (2 × [248320, 256] bf16 = 254 MB) moved from Metal buffers to host `Vec<bf16>`; `cand_tables` packs top-16 values + ids (u32 < 512, exact in f32) + selector rows into one f32 readback; host `gather_cb`; `TH_DRAFT_EAGER`/`TH_DEBUG_TIMING` in dflash.rs read once. Tests `dflash::tests::cand_tables_packed_readback_is_exact`, `gather_cb_host_rows`. |
| `be12e45` | Q1 | QoS default flipped to off (measurements in the commit message); `enter_with(Mode)` so the raise/restore test is env-independent. |
| `68f3423` | anchor | (branch `th/c-loop-anchor` only) `pos` stays = committed KV count after the prefill anchor, single-slot (engine.rs:552 @d84bd7d) and batch admit (`run.pos`, engine.rs:1534 @d84bd7d). |

Key sites at `be12e45`: engine.rs:274 `verify_adaptive`, :388 `dflash_verify_len`, :583 call site, :297 `mod decode_qos`, :207/:146 guards; dflash.rs:257 `pred_cb: Vec<bf16>`, :561 `cand_tables`, :589 the single readback, :844 `gather_cb`, :1036 `draft_eager`.

Binaries (`work/th-c-loop/bin/`, sha256 prefix): base `th-engine-base-8d5b6d5` `e91a30d2afb7` (cmp-identical to the Phase B integration binary), `th-engine-L1-868fe34` `474d4023e23a`, `th-engine-Q1-2498d35` `776fa0ac3041`, `th-engine-D1-d84bd7d` `7b5bd8460f41`, `th-engine-anchor-68f3423` `0a8ea43126b7`, `th-engine-final-be12e45` `7c7925c51583`.

## 2. Method

- **Client** (`tools/client.py`, = Phase B client2): warm-up, then short/code/long at T=0 (128 tokens), then the same 3 at T=0.6/top_p 0.95/top_k 20 with seeds 1, 3, 5 (odd: the sampler seeds with `seed|1`). Per request it records the server-log line range, ioreg GPU ns and `ps` CPU time of the server pid.
- **Metrics** (`tools/analyze.py`): loop tok/s = Σtokens/Σstep-ms over logged `[dflash]` rounds (first token and the final unlogged round excluded, as in Phase B); ms/round; tokens/round; propose ms (`prop_ms`, float; the base binary only logs the integer `propose=` field, so base propose is a mean of rounded values); host encode = `[verify] enqueue` − propose (includes `snapshot()`); GPU wait+readback; rest; GPU-busy, host-CPU and client-wall slopes vs rounds (ioreg); idle = wall slope − GPU-busy slope.
- **Identity:** texts compared per request; first divergence as completion-token index (#0 = the prefill token) from the logged emitted ids (`tools/firstdiv.py`).
- **Sessions** (1-min load avg at arm starts; GPU-quiet check before every arm: other processes 22–70 ms/s of GPU, median 31 ms/s ≈ 3%):
  - s_L1 06:00–06:04, load 4.2–8.5: fwd ladder 8..2 (base); base, L1, L1, base, L1+`TH_VERIFY_ADAPTIVE=1`.
  - s_2 07:03–07:11, load 2.8–5.9: TH_BENCH_MULTI=8,1 base/head; palindrome Q1off, Q1on, D1, anchor, base | base, anchor, D1, Q1on, Q1off (Q1off/Q1on = the Q1 binary with `TH_DECODE_QOS=off`/default); TH_BATCH=2 smoke (anchor binary, base).
  - s_3 07:11–07:18, load 2.2–3.3: Metal command-stream counts (interposer, not timed); plain greedy reference (no draft, `--spec-tokens 0`); 15-prompt T=0 acceptance set: base, then D1, anchor, anchor, D1.
  - s_4 07:18–07:22: ambient ABBA Q1on, D1, D1, Q1on (load 2.8–3.9); then 18 `yes` spinners (default QoS, one per core) and ABBA of the D1 binary with `TH_DECODE_QOS=off` vs its then-default `interactive`, short client (T=0 ×3 + seed 1 ×3), load 7.7 → 30.5.
  - s_5: head `be12e45` vs base, ABBA, + TH_BATCH=2 smoke on the head (§7).
- s_2's D1_1 arm was hit by an external CPU burst (load 3.81 → 5.92; host encode max 43.6 ms in one request): its D1 numbers are shown but the D1 verdict rests on s_4's ABBA. Session s_L1's base arms ran slow (host CPU 21.4 vs 15.3 ms/round in the equivalent adaptive arm), so L1 verdicts use s_2 (palindromic).

## 3. L1: verify all 7 proposals

**Why it pays:** the adaptive cap bound often. Base rounds (s_L1, identical in the `TH_VERIFY_ADAPTIVE=1` arm) had mean verify length 4.55 (T=0) / 4.05 (sampled), and **35.5% / 33.7% of rounds were capped** (every verified proposal accepted, chain cut by the cap). With L1, 31.1% / 18.8% of rounds accept all 7 [M, `s_L1/acchist.txt`]. Mean accepted/round, 15-prompt set: 2.821 → 3.299 (full-7 accepts 26.7%).

**Verify cost by row count** (TH_BENCH_MULTI, base binary, median of 5, ms): fwd8 **39.70**, fwd7 40.00, fwd6 40.20, fwd5 40.20, fwd4 40.80, fwd3 40.60, fwd2 41.50. m=8 is the cheapest shape measured, so verifying all rows adds no target-forward time. (Interposer counts: L1 runs ~10 more dispatches and blit encoders per round than base, 822 vs 812; the extra per-round work is elsewhere, e.g. commit/rollback of more rows, and is inside the ms/round below.)

**E2E, s_2 (palindromic, 2 arms each), base `8d5b6d5` vs L1 behaviour (Q1 binary, `TH_DECODE_QOS=off`):**

| subset | base ms/rnd | base tok/rnd | base tok/s | L1 ms/rnd | L1 tok/rnd | L1 tok/s | Δ tok/s |
|---|---|---|---|---|---|---|---|
| T=0 (6 req) | 56.39 | 3.605 | 63.93 | 55.78 | 4.410 | 79.05 | **+23.7%** |
| sampled (18 req) | 59.24 | 3.146 | 53.10 | 58.05 | 3.938 | 67.83 | **+27.7%** |
| all (24 req) | 58.60 | 3.249 | 55.45 | 57.54 | 4.045 | 70.30 | **+26.8%** |

Phases, all, base → L1: propose 8.77 → 8.46, host encode 8.83 → 7.97, GPU wait+readback 38.59 → 38.36, rest 2.39 → 2.73 ms; GPU-busy slope 49.5 → 49.0, idle 9.3 → 8.6 ms/round. TTFT median 174 → 172 ms. Repeat arms: base_1/base_2 56.41/56.38 (T=0), L1 56.47/55.10.

**15-prompt T=0 acceptance set (s_3, 1 base arm, 2 D1 arms; D1 is token-identical to L1):** 459 → 408 rounds for 1754 tokens each: **3.821 → 4.299 tokens/round (+12.5%)**, 55.35 → 54.23 ms/round, **69.04 → 79.27 tok/s (+14.8%)**. Per prompt L1 has higher tokens/round on 13/15 and ties on 2 (x_email, x_rust); e.g. x_sql 40 → 26 rounds, code 31 → 19, x_regex 32 → 28.

**Token identity (T=0) vs base:** short identical; code diverges at token #42, long at #120 (of 128). 15-prompt set: 5/15 identical, others diverge at #30–#120. Cause: verify always runs m=8 kernels and the rollback rescan runs in different rounds, which flips near-ties later in the stream (same class as the Phase B code-prompt divergence). Sampled: diverges at #15–#40 (more acceptance steps draw more uniforms). The code prompt's post-divergence text is unusually draftable (19 vs 31 rounds), which inflates the 3-prompt T=0 gain; on the two near-identical texts (short, long) rounds go 45 → 42, and the 15-prompt set is the better estimate (+12.5% tokens/round).

## 4. Q1: decode thread at QOS_CLASS_USER_INTERACTIVE

Confirmed applied: with `interactive` the server logs `decode thread QoS raised from=Some(QOS_CLASS_DEFAULT) to=Some(QOS_CLASS_USER_INTERACTIVE)` on the first request; the head (`off`) logs no raise.

| condition | arms | ms/round all (T=0) | host encode ms | propose ms | GPU-busy / host CPU / idle ms/round |
|---|---|---|---|---|---|
| load 2.8–5.9 (s_2), `off` | Q1off_1, Q1off_2 | 57.54 (55.78) | 7.97 | 8.46 | 49.0 / 17.5 / 8.6 |
| same, `interactive` | Q1on_1, Q1on_2 | 57.27 (55.39) | 8.05 | 8.42 | 48.5 / 17.5 / 8.7 |
| 18 spinners, load 7.7→30.5 (s_4, D1 binary), `off` | L_Q1off_1, _2 | 61.88 (60.41) | 9.12 | 10.36 | — (short client, no ioreg) |
| same, `interactive` | L_Q1on_1, _2 | 61.41 (59.50) | 8.86 | 10.27 | — |

- Δ = −0.27 (ambient) and −0.47 ms/round (loaded), smaller than the arm-to-arm spread (Q1off 57.84/57.23, L_Q1off 61.28/62.48). Host encode and idle do not move. Outputs 12/12 and 6/6 identical.
- Why [E]: the thread blocks in `waitUntilCompleted` for ~38 ms of every round, so the timeshare scheduler already boosts it on wake-up. 18 pure-CPU spinners cost only +5.7 to +6.6 ms/round at T=0 (53.79 ambient → 59.50 / 60.41) with or without QoS. The Phase B slowdown under load (63 → 104.5 ms/round at load 26–49) came with GPU-busy rising too (55.9 → 63.0, Phase B §1.2) [D], i.e. shared-memory-bandwidth contention, which QoS cannot fix.
- Decision: kept, default off (`be12e45`), `TH_DECODE_QOS=interactive|initiated` opt-in.

## 5. D1: one host sync per propose

**Sync sites** (static, per propose @`8d5b6d5` dflash.rs): `cand_tables` :577 `vals…to_vec2::<f32>()`, :582 `ids…to_vec2::<u32>()`, :602 `sel…to_vec2()`; `gather_cb` :549 called twice (:537 pred, :538 succ; :808/:809 in `propose_batch`) = **5**. At `d84bd7d`: **1** (`cand_tables` :589, one `to_vec1` of `cat[top_v, top_i, sel_f]`); the codebook gather is host-only. The verify readback (engine.rs argmax `to_vec1` / `to_vec2`) is the round's other sync.

**Runtime count** (s_3; `libmtlc3.dylib` = the MEM-2 `mtlc2` interposer + a SIGUSR1 mark, injected with `DYLD_INSERT_LIBRARIES`; one mark after each request; least-squares slope over warm-up + 3 T=0 requests; `s_3/syncs.txt`):

| build | waitUntilCompleted / round | commits / round | compute encoders / round | blit encoders / round | dispatches / round | fills / round | CB GPU ms / round |
|---|---|---|---|---|---|---|---|
| base 8d5b6d5 | **6.00** (intercept 1.0) | 22.6 | 110 | 95 | 812 | 72 | 47.50 |
| L1+Q1 2498d35 | **6.00** | 23.4 | 120 | 105 | 822 | 72 | 47.71 |
| +D1 d84bd7d | **2.00** | 19.6 | 117 | 101 | 822 | 72 | 47.58 |

**Timing, s_4 ambient ABBA (Q1on_3, D1_3, D1_4, Q1on_4; load 2.8–3.9; tokens 12/12 identical):**

| | propose ms (T=0) | host encode | GPU wait+rb | rest | ms/round all (T=0) | tok/s all (T=0) | GPU-busy / host CPU / idle |
|---|---|---|---|---|---|---|---|
| Q1 `2498d35` | 8.27 (7.90) | 8.13 | 37.89 | 2.70 | 56.99 (54.72) | 70.97 (80.59) | 48.3 / 17.2 / 8.4 |
| D1 `d84bd7d` | **7.36 (6.99)** | 8.07 | 37.93 | 2.70 | **56.08 (53.79)** | **72.13 (81.98)** | 47.6 / 16.4 / 8.4 |

- Propose −0.91 ms and round −0.91 ms (−1.6%), ≈0.23 ms per removed sync; arms repeat to ±0.1 (D1 56.07/56.09, Q1 57.10/56.88). s_2's clean D1_2 arm agrees (propose 7.57 vs 8.42); D1_1 there was disturbed (§2).
- The saving is host round-trip idle: the interposer's CB GPU time per round is flat (47.71 → 47.58 ms, s_3 T=0 count runs), so idle ≈ s_4 round − CB GPU goes 9.3 → 8.5 ms [D, mixes the two sessions]. (The ioreg slopes, GPU-busy 48.3 → 47.6 and idle 8.4 → 8.4, carry ±0.7 ms of fit noise.) What is left is structural: propose ends in a sync and the host then encodes the whole verify (≈8 ms) before the GPU has work.
- Batched path (TH_BATCH=2 smoke, s_2): `[pb] cand_tables` (sort + readbacks + gathers) 9.09 → 7.90 ms per round; nb=2 propose 21.75 → 20.77 ms.
- Memory: 254 MB leaves the Metal pool/residency set and lands on the host heap (same unified memory).
- Numerics: every value reaching `select_walk` is bit-identical to the old path by construction (same f32 sort outputs, same bf16→f32 codebook rows; unit test vs a full host sort); outputs text-identical to the parent on 24/24 requests (s_2 + s_4).

## 6. Anchor off-by-one (review/statemachine d523828), measured both ways

Change (`68f3423`, `th/c-loop-anchor`): drop `pos += 1` after emitting the prefill anchor (single-slot) and `run.pos += 1` in batch `admit`, so the anchor is forwarded at `pos` = committed KV count.

| set | without fix (D1 `d84bd7d`) | with fix (`68f3423`) |
|---|---|---|
| 3 bench prompts, T=0 (s_2) | 4.410 tok/rnd (D1 = Q1 tokens), 55.39 ms/rnd (Q1on arms; D1_1 was disturbed) | **3.899**, 56.49 |
| 3 prompts × seeds 1,3,5 (s_2) | 3.938 | **3.717** |
| 15 prompts, T=0 (s_3, 2 arms each) | **4.299** tok/rnd, 54.23 ms/rnd, 79.27 tok/s | **4.286**, 54.09, 79.23 |

- The 3-prompt drop is the code prompt: with the fix its greedy text reverts to base's text (tokens #42 on), which takes 28 rounds instead of 19; long 37 → 36, short 5 → 5. With the fix all 3 T=0 texts equal base's.
- Plain greedy reference (no draft, `--spec-tokens 0`, same kernels as main's plain loop): texts identical to plain on 4/15 without the fix and 2/15 with it; most divergences sit at the same token for both (e.g. x_hist, x_json, x_math, x_regex, x_rust, x_story), i.e. m=8 verify vs m=1 decode numerics, not the phantom row. So the fix does not measurably move DFlash output toward plain decode either.
- ms/round is unaffected. The fix is still correct (target KV row P is attended as zeros; draft ring slot P is never written and holds the previous request's K/V), but per the task rule it is not in th/c-loop. It is ready on `th/c-loop-anchor` (both paths) if the maintainers want it for correctness/determinism.

## 7. Head `be12e45` vs base `8d5b6d5` (s_5)

Session 07:38–07:41, load 2.5–3.4, GPU quiet (other clients ≤ 4%), arms base_1, final_1, final_2, base_2, then the TH_BATCH=2 smoke on the head. The head logs `qos=Off` and `verify="all 7 proposals"` at load.

| subset | base ms/rnd | tok/rnd | tok/s | head ms/rnd | tok/rnd | tok/s | Δ tok/s |
|---|---|---|---|---|---|---|---|
| T=0 (6 req) | 55.46 | 3.605 | 65.00 | 54.65 | 4.410 | 80.70 | **+24.2%** |
| sampled (18 req) | 57.11 | 3.146 | 55.08 | 56.85 | 3.938 | 69.26 | **+25.7%** |
| all (24 req) | 56.74 | 3.249 | 57.27 | 56.35 | 4.045 | 71.78 | **+25.3%** |

- Arms: base 55.80/55.13 (T=0), head 55.29/54.00.
- Phases (all), base → head: propose 8.23 → 7.44, host encode 8.35 → 8.15, GPU wait+readback 37.98 → 38.03, rest 2.13 → 2.72 ms (more rows committed/rolled back and more sampled accept steps per round); GPU-busy slope 48.2 → 47.7, host CPU 16.7 → 16.5, idle 8.6 → 8.7 ms/round (ioreg).
- TTFT median 175.3/174.3 → 175.4/174.6 ms (unchanged).
- Identity vs base: T=0 short identical, code from token #42, long from #120; sampled from #15–#40 (§3). Head arms identical to each other (12/12).
- vs Phase B's integration number (54.53 ms/round, 3.605, 66.12 tok/s at T=0, load 2.3–2.6): the base re-measures at 55.46 / 65.0 here.

## 8. Gates

| gate | result |
|---|---|
| V-build | 0 warnings at 868fe34, 2498d35, d84bd7d, 68f3423, be12e45 (`cargo build --release`) |
| unit tests | `cargo test --release` 25/25 @868fe34, 27/27 @2498d35, 29/29 @d84bd7d, 29/29 @be12e45 |
| TH_BENCH_MULTI=8,1 (s_2) | base fwd8 39.70 / fwd1 44.20 ms; head (anchor binary; probe path untouched by these commits) 39.40 / 42.70 (fwd1 gap = first-run drift; no kernel changed) |
| token identity | Q1 = L1 (12/12); D1 = Q1 (24/24); every binary identical across its own arms (e.g. base_1 = base_2 12/12, acc_D1_1 = acc_D1_2 15/15) |
| V-contract | `/status` key paths 29 = 29, `th_stats` keys {decode_tps, prefill_tps, total_ms, ttft_ms} unchanged, head vs base (s_5) and L1 vs base (s_L1): PASS (`tools/contract.py`) |
| TH_BATCH=2 smoke (s_2, anchor binary = D1 + fix) | 9/9 HTTP 200, no errors, max trigram-repeat 0.089 (base 0.097), 996 completion tokens each |
| TH_BATCH=2 smoke on head `be12e45` (s_5) | **PASS**: 9/9 HTTP 200, no errors/panics in the log, finish 2 stop + 7 length, max trigram-repeat 0.097, 996 completion tokens; nb=2 rounds 83.1 ms (base s_2: 84.4), `[pb] cand_tables` 7.89 ms (base 9.09) |
| env reads | L1/Q1/D1 knobs and `TH_DEBUG_TIMING`/`TH_DRAFT_EAGER` are OnceLock'd; still per call in qwen35.rs (not touched): `TH_PHASE_TIME` per forward, `TH_DEBUG_ROLLBACK` per GDN layer in `rollback_verify` |

## 9. Findings for the next items

- **72 blit fills per round** remain (interposer, all builds): the MEM-2 `Tensor::zeros` sites. With ~100 blit encoders per round each splitting the compute encoder (110–120 compute encoders/round), this is the largest remaining encoder-churn source. Re-port `verify-memory-MEM2` @324f448 for the attention/draft sites.
- **Sampled accept is CPU-heavy:** rest is 3.2 ms/round sampled vs 1.2 at T=0 (L1); `dist_vec` runs a full-vocab `select_nth_unstable` + full-vocab `exp` per consumed row (~0.5 ms/row). A GPU top-k/Z (S1) or a heap top-k would cut it.
- **Idle ≈ 8.4 ms/round is now structural:** 2 syncs/round, with the whole verify encode (≈8 ms) after propose's sync. Next: X1/X2 (encode verify behind the draft, one CB per round) or GPU-side select.

## 10. Reproduce and cleanup

```sh
P=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC; WD=$P/work/th-c-loop
(cd /Users/benebsworth/projects/token-horizon/.worktrees/th/c-loop/engine && cargo build --release && cargo test --release)
$P/bin/gpu-lock -- $WD/tools/session_L1.sh      # s_L1
$P/bin/gpu-lock -- $WD/tools/session_2.sh       # s_2, then s_3 (session_3.sh) and s_4 (session_4.sh) in the same hold
$P/bin/gpu-lock -- $WD/tools/session_5.sh       # s_5 head vs base
$WD/tools/an2.sh                                  # s_2 tables
python3 $WD/tools/analyze.py $WD/s_4 Q1on:Q1on_3,Q1on_4 D1:D1_3,D1_4
python3 $WD/tools/syncs.py $WD/s_3 count_base count_Q1 count_D1 count_anchor
python3 $WD/tools/perprompt.py $WD/s_3 acc_base acc_D1_1 acc_anchor_1 plain_base --ref plain_base
# interposer: clang -dynamiclib -fno-objc-arc -O2 -framework Foundation -framework Metal -o $WD/mtlc/libmtlc3.dylib $WD/mtlc/mtlc3.m
```

Cleanup: every server was started by `tools/serve.sh`/`serve4.sh` on :8031 and stopped with SIGTERM (KILL fallback); no `yes` spinner left (checked `pgrep -x yes` = 0). :8000 was never touched; :8001 is still pid 16917.
