# Phase C report: integration-2 vs 8d5b6d5 vs main vs Splash 1.0

Written 2026-09-26 ~08:50 AEST by the integration-2 / final-A/B agent, for the maintainer.

- **Repo:** `/Users/benebsworth/projects/token-horizon`. `main` = `cf3e5f7`, unchanged since Phase B. The main working tree had 0 tracked changes (read-only, `GIT_OPTIONAL_LOCKS=0`); it was never edited, built or reset.
- **Hardware:** M5 Max, 40-core GPU, 128 GB, macOS 26.5.1. **Model:** Qwen3.8-27B-4bit (`$TGT`) + DFlash draft (`$DRAFT`). **Splash 1.0** (brew) serves `incoai/Qwen3.8-27B-Splash`.
- **Builds** (frozen copies in `$W/bin/`, `W=$P/work/integration-2`, `P=.worktrees/_phaseC`):

| label | build | sha256 |
|---|---|---|
| **th-integ2** | `report/integration-2` @`521c6e0` (this report) | `66e99644402995638d921e8e53cb6fc1f12d1d8fbcfea12c71de2c238f6cb133` |
| th-integ | `report/integration-sim` @`8d5b6d5` (Phase B integration) | `e91a30d2afb70b2ba2a4d78294b0ca49ee922038d1fa1289f18e168c5e656b34` |
| th-main | `main` @`cf3e5f7` (the bench-main build) | `1f4fbca344cebb8b89653eb25f99df414aade4b8ab0d7e5ea475ba6b8542d1fa` |
| Splash | Splash 1.0, `/opt/homebrew/Cellar/splash/1.0` | — |

- **Metric conventions** (as in Phase B and bench-quiet): loop tok/s = Σtokens / Σround-ms over the logged `[dflash]` rounds (the prefill-sampled first token and the final unlogged round excluded); Splash: `decode_output_tokens / decode_wall_ms` from `/status` deltas; "like-for-like" removes Splash's prefill-sampled token. "T=0.6" = temperature 0.6, top_p 0.95, top_k 20, seeds 1/3/5 (odd: the sampler seeds with `seed|1`). Ratio of sums everywhere. Tags: [M] measured, [D] derived, [E] estimate.
- **Inputs:** `PHASEB-REPORT.md`, `bench-quiet.md`, `review-integ.md`, `th-c-loop.md`, `th-c-gdn-parity.md`, `th-c-ports.md` (all in `$P/reports/`).

## 0. Summary

1. **integration-2 is built and passes every gate.** `report/integration-2` @`521c6e0` = `8d5b6d5` + **th/c-loop** `be12e45` + **th/c-gdn-parity** `a93f982` + **th/c-ports** `7253731`: all three lanes are done, reviewed mergeable, with no must-fix items, and the integration-head review had none open either. Three conflict hunks, all mechanical (§5.2). 0 warnings; **37/37 tests**; R0a state-bitwise rollback gate **PASS** (and FAIL under `TH_GDN_COMMIT=step`, so it still discriminates); TH_BATCH=2 13/13 and TH_BATCH=4 16/16 HTTP 200 with N2's mixed-batch identity holding; kv/clear, no-draft single-slot and the no-draft TH_BATCH=2 fallback all pass (§4).
2. **Standing vs Splash 1.0, same session** (s1: 8-arm palindrome, :8035, load 1.9–5.1, every Splash request at thermal level 0):
   - **T=0: 1.032×** (81.49 vs 78.97 tok/s; like-for-like 1.052). th's round is now shorter than Splash's (47.16 vs 47.66 ms) and it emits more tokens per round (3.843 vs 3.763).
   - T=0.6: **0.876×** (72.58 vs 82.89) = per-round 0.979 × tokens/round 0.894.
   - ≈1.45k-token context: **0.782×** (ctx1500, 62.20 vs 79.53) and 0.793× (ctxcold, Splash prefix cache defeated).
   - **Replicate s2** (splash1, new1, new2, splash2): 1.029× / 0.876× / 0.781× / 0.795× against the nominal Splash arm. The second Splash arm ran throttled at thermal level 2 throughout and is excluded (with it, s2 would flatter th to 1.109×). Pooled s1+s2: **1.031× / 0.876× / 0.782× / 0.794×**.
   - **Before Phase C** (bench-quiet s1+s3, integration `8d5b6d5`): 0.840× / 0.667× / 0.616× / 0.622×. This session reproduces those baselines within 0.8% (T=0: integ 65.61 vs 65.95, main 54.42 vs 54.02, Splash 78.97 vs 78.56 tok/s).
3. **integration-2 vs `8d5b6d5`, same session: +24.2% at T=0** (65.61 → 81.49 tok/s; 54.95 → 47.16 ms/round; 3.605 → 3.843 tokens/round), +29.7% sampled, +24.3% ctx1500, +24.5% ctxcold. Against main `cf3e5f7`: **1.498× / 1.412× / 1.398× / 1.464×.**
   - The lanes compose additively: the expected T=0 Δ is ≈ −7.7 ms/round (G1a −6.35, D1 −0.91, MEM-2 −0.37, the rest ≈0) and the measured Δ is −7.79.
   - Host idle 7.1 → 1.3 ms/round, host CPU 15.8 → 4.5 ms/round, GPU-busy 47.7 → 45.7 ms/round (Splash 47.5).
   - T=0 text is identical to `8d5b6d5` on 8 of 9 prompt groups; every build is deterministic across its arms (120/120 text sets).
4. **What is left against Splash is long context and sampled acceptance, not the short-context round.** On byte-identical greedy text th needs 151 rounds where Splash needs 147 (it was 163 vs 147). At ≈1.45k context th's round grows +14.3 ms (propose +5.8, verify GPU tail +8.4) and Splash's +1.1.
5. **Gap to the kernel floor** (F_k ≈ 36 ms): ≈11.2 ms/round at bench context, now almost all GPU work (idle ≈1.3 ms) (§6.1).
6. **Next three levers** (§6.2): (1) long-context attention, N4 `draft_attn_split` + N3 split-K `attn_decode` (prototypes exist); (2) sampled decode, R0b acceptance study + S1 GPU accept; (3) R0c per-CB timing, then the short-context fusions. TTFT is the largest user-visible gap outside decode (no prefix cache: 2451 vs 143 ms on a repeated 1.4k prefix).
7. **Landing:** `main` is an ancestor of `report/integration-2`, so it lands as a **fast-forward** (47 commits); `merge-tree` against main is clean. It touches all six engine files the other developer owns; they need to sign off, in particular on G1a's light-snapshot contract and N2's `batch_round` change (§5.3). Nothing was pushed.

## 1. Standing vs Splash

### 1.1 Final session s1 (08:15–08:35, one gpu-lock hold)

- **Harness:** bench-quiet's client and prompts (`bq_client.py`, the same short/code/long prompts and the same 1373-token passage, sha1 `a886db14acc4`), with a fourth engine added (`$W/bench/session.sh`).
- **Order:** new1 → splash1 → integ1 → main1 → main2 → integ2 → splash2 → new2. This is a palindrome, so every engine has one arm in each half.
- **Servers:** fresh per arm. th arms ran one at a time on :8035 (`env -u TH_BATCH TH_DEBUG_TIMING=1 th-engine serve --draft`). Splash started fresh on the free :8000 for each of its arms and was SIGINT-stopped afterwards. No th server was up while Splash ran.
- **Gates before each arm:** thermal pressure level 0 (wait ≤ 420 s before the first arm, ≤ 150 s later), CPU idle ≥ 85%, and other GPU clients ≤ 60 ms/s.
- **Suite per arm:** 2 warm-ups, then:
  - greedy: 3 prompts × 3, T=0, 128 tokens;
  - sampled: 3 prompts × seeds 1/3/5;
  - ctx1500: passage + prompt, 3 × 3, T=0;
  - ctxcold: nonce + passage + prompt, 1 per prompt.
- **Requests:** 240, all OK.

| engine (build) | mode | n req / logged rounds | tok/round | ms/round | **loop tok/s** | like-for-like | TTFT mean / med ms | GPU-busy / idle ms/round | load1 at request start |
|---|---|---|---|---|---|---|---|---|---|
| **th-integ2** `521c6e0` | T=0 | 18 / 420 | 3.843 | **47.16** | **81.49** | 82.21 | 163 / 172 | 45.7 / 1.3 | 3.34–4.04 |
| th-integ2 | T=0.6 | 18 / 458 | 3.590 | 49.46 | **72.58** | 72.21 | 164 / 173 | 46.1 / 2.9 | 3.36–4.04 |
| th-integ2 | ctx1500 | 18 / 438 | 3.822 | 61.44 | **62.20** | 60.82 | 2502 / 2451 | 64.3 / −2.9 ‡ | 2.38–4.04 |
| th-integ2 | ctxcold | 6 / 124 | 4.371 | 61.69 | **70.85** | 70.82 | 2511 / 2510 | 60.1 / 1.2 | 2.16–4.11 |
| th-integ `8d5b6d5` | T=0 | 18 / 456 | 3.605 | 54.95 | **65.61** | 65.19 | 165 / 173 | 47.7 / 7.1 | 2.35–4.13 |
| th-integ | T=0.6 | 18 / 510 | 3.208 | 57.34 | **55.94** | 56.15 | 166 / 172 | 47.9 / 9.0 | 2.52–3.73 |
| th-integ | ctx1500 | 18 / 474 | 3.506 | 70.07 | **50.04** | 49.42 | 2451 / 2429 | 64.6 / 5.3 | 2.18–3.50 |
| th-integ | ctxcold | 6 / 136 | 4.015 | 70.56 | **56.90** | 56.69 | 2453 / 2455 | 65.6 / 4.7 | 2.35–2.61 |
| th-main `cf3e5f7` | T=0 | 18 / 480 | 3.450 | 63.40 | **54.42** | 53.78 | 181 / 185 | 56.0 / 7.3 | 2.53–3.80 |
| th-main | T=0.6 | 18 / 486 | 3.391 | 65.99 | **51.39** | 51.05 | 183 / 190 | 56.3 / 9.5 | 2.24–4.15 |
| th-main | ctx1500 | 18 / 474 | 3.506 | 78.82 | **44.48** | 43.94 | 2549 / 2551 | 74.2 / 4.6 | 1.98–3.87 |
| th-main | ctxcold | 6 / 142 | 3.817 | 78.87 | **48.40** | 48.66 | 2437 / 2431 | 70.5 / 8.0 | 1.90–2.93 |
| Splash 1.0 | T=0 | 18 / 456 | 3.763 | 47.66 | **78.97** | 78.14 | 153 / 139 † | 47.5 / 0.6 | 3.20–4.82 |
| Splash 1.0 | T=0.6 | 18 / 428 | 4.014 | 48.43 | **82.89** | 82.02 | 138 / 139 † | 47.1 / 1.8 | 3.10–5.03 |
| Splash 1.0 | ctx1500 | 18 / 444 | 3.878 | 48.77 | **79.53** | 78.70 | 160 / 143 † | 48.7 / 0.6 | 2.91–4.79 |
| Splash 1.0 | ctxcold | 6 / 130 | 4.415 | 49.45 | **89.29** | 88.36 | 1944 / 1950 | 50.3 / ≈0 | 2.91–5.14 |

† Prefix-cache hits: 32–64 tokens reused on the bench prompts and 1408–1440 on ctx1500. th has no prefix cache.
‡ On th, ioreg can double-count overlapping command buffers, so th's GPU-busy is an upper bound and its idle a lower bound (here negative).

**Ratios (loop tok/s; like-for-like in brackets; split into the per-round ratio × the tokens/round ratio):**

| mode | th-integ2 / Splash | th-integ / Splash | th-main / Splash | th-integ2 / th-integ | th-integ2 / th-main |
|---|---|---|---|---|---|
| T=0 | **1.032** (1.052) = 1.011 × 1.021 | 0.831 (0.834) | 0.689 | **1.242** | **1.498** |
| T=0.6 | **0.876** (0.880) = 0.979 × 0.894 | 0.675 (0.685) | 0.620 | 1.297 | 1.412 |
| ctx1500 | **0.782** (0.773) = 0.794 × 0.985 | 0.629 (0.628) | 0.559 | 1.243 | 1.398 |
| ctxcold | **0.793** (0.802) = 0.802 × 0.990 | 0.637 (0.642) | 0.542 | 1.245 | 1.464 |

- **Per-arm drift, T=0 loop tok/s (arm 1 / arm 2):** th-integ2 81.44 / 81.55; Splash 78.91 / 79.02; th-integ 65.48 / 65.73; th-main 54.37 / 54.46. The other modes repeat about as closely.
- **Conditions:**
  - Pre-arm 1-min load was 2.05–4.38 (1.90–5.14 at request starts). Mean CPU idle during arms was 86–90%.
  - Other GPU clients used 23–40 ms/s before arms and 26–32 ms/s during them, mostly WindowServer at about 2%.
  - During arms the GPU was 90–94% active at 1500–1561 MHz (active-weighted).
  - Swap stayed at 32.9 GB used, pre-existing and unchanged.
- **Thermal:**
  - Every Splash request ran at level 0.
  - Level 1–2 appeared only at the end of integ1 and new2, on their ctx1500-long and ctxcold requests (14 requests). It had no measurable effect on ms/round: new2's ctx1500-long ran 61.2–61.3 ms/round at levels 1–2, against new1's 61.5–61.9 at level 0.
  - Splash was never throttled, so the ratios are not flattered by it.
- **Identity (T=0, after `</think>` normalisation):**
  - th-integ2 is byte-identical to th-integ on 8 of 9 prompt groups. ctxcold/code diverges at re-tokenized token #122 of 128.
  - th-integ2 is byte-identical to Splash on 7 groups. greedy/code diverges at token #23 (" Need produce" vs " Need provide", the known integration near-tie) and ctxcold/code at #108.
  - All 120 (engine, mode, prompt, seed/iteration) text sets are identical between each engine's two arms.

### 1.2 Replicate s2 (08:36–08:44, one gpu-lock hold)

- **Order:** splash1 → new1 → new2 → splash2, with the same gates and client.
- **splash2 was throttled.** The pre-arm check read level 0 at 08:42:38, but splash2 then ran at thermal pressure level 2 for its whole arm: 26/26 samples, GPU at 1246 MHz, P13 residency 0%. Its T=0 round rose to 55.03 ms (splash1: 47.60).
- **splash2 is excluded from the ratios**, following bench-quiet's rule: throttling costs Splash about 11% and th about 3%. With splash2 included, s2 would read 1.109× at T=0.

| mode | th-integ2 (new1 + new2): tok/s (ms/round, tok/round) | Splash splash1 | th-integ2 / Splash, s2 | s1 | **s1 + s2 pooled** |
|---|---|---|---|---|---|
| T=0 | 81.36 (47.23, 3.843) | 79.05 (47.60, 3.763) | 1.029 | 1.032 | **1.031** |
| T=0.6 | 72.66 (49.40, 3.590) | 82.96 (48.39, 4.014) | 0.876 | 0.876 | **0.876** |
| ctx1500 | 62.29 (61.35, 3.822) | 79.73 (48.64, 3.878) | 0.781 | 0.782 | **0.782** |
| ctxcold | 71.09 (61.48, 4.371) | 89.46 (49.36, 4.415) | 0.795 | 0.793 | **0.794** |

- **Per arm, s2, T=0:** th-integ2 81.44 / 81.27; splash1 79.05.
- **Load:** pre-arm 2.68–6.11 (2.72–6.45 at request starts). new1 started just after a load spike to 6.1, and its T=0 number (81.44) did not move.
- **Identity:** th-integ2's and Splash's texts are identical between s1 and s2 (36/36 text sets).
- Pooled s1 + s2 (36 th-integ2 requests and 27 nominal Splash requests per mode): th-integ2 81.42 vs Splash 79.00 tok/s at T=0; 72.62 vs 82.91 sampled; 62.25 vs 79.60 ctx1500; 70.97 vs 89.35 ctxcold.

### 1.3 The earlier quiet bench (bench-quiet s1 + s3, 06:11–07:38, nominal GPU clocks)

Source: `$P/reports/bench-quiet.md` §4.1 (harness `.worktrees/bench-main/.bench-quiet/`, same client and protocol as §1.1, order integ, main, splash, splash, main, integ; :8051; s2 of that bench was GPU-throttled and is excluded, as there).

| engine (build) | mode | n req / logged rounds | tok/round | ms/round | **loop tok/s** | TTFT mean / med ms | GPU-busy / idle ms/round |
|---|---|---|---|---|---|---|---|
| th-integ `8d5b6d5` (e91a30d2afb7) | T=0 | 36 / 912 | 3.605 | 54.67 | **65.95** | 165 / 173 | 47.7 / 7.1 |
| th-integ | T=0.6 | 36 / 1020 | 3.208 | 58.04 | **55.27** | 166 / 174 | 48.4 / 10.0 |
| th-integ | ctx1500 | 36 / 948 | 3.506 | 70.94 | **49.43** | 2549 / 2502 | 63.8 / 7.2 |
| th-integ | ctxcold | 12 / 272 | 4.015 | 71.71 | **55.99** | 2509 / 2468 | 64.1 / 7.4 |
| th-main `cf3e5f7` (1f4fbca344ce) | T=0 | 36 / 960 | 3.450 | 63.87 | **54.02** | 182 / 188 | 56.4 / 7.8 |
| th-main | T=0.6 | 36 / 972 | 3.391 | 65.94 | **51.42** | 182 / 190 | 56.5 / 9.3 |
| th-main | ctx1500 | 36 / 948 | 3.506 | 78.77 | **44.51** | 2451 / 2435 | 69.0 / 9.6 |
| th-main | ctxcold | 12 / 284 | 3.817 | 78.99 | **48.32** | 2380 / 2416 | 72.3 / 6.4 |
| Splash 1.0 | T=0 | 36 / 912 | 3.763 | 47.90 | **78.56** | 157 / 142 † | 47.5 / 0.9 |
| Splash 1.0 | T=0.6 | 36 / 856 | 4.014 | 48.40 | **82.93** | 138 / 137 † | 47.3 / 1.5 |
| Splash 1.0 | ctx1500 | 36 / 888 | 3.878 | 48.36 | **80.20** | 158 / 142 † | 48.0 / 0.7 |
| Splash 1.0 | ctxcold | 12 / 260 | 4.415 | 49.04 | **90.04** | 1732 / 1711 | 50.3 / ≈0 |

† prefix-cache hits (32–64 tokens on the bench prompts, 1408–1440 on ctx1500).

### 1.4 Then and now

| mode | th-integ `8d5b6d5` / Splash, bench-quiet s1+s3 | th-integ `8d5b6d5` / Splash, this s1 | **th-integ2 `521c6e0` / Splash, s1+s2** |
|---|---|---|---|
| T=0 | 0.840 | 0.831 | **1.031** |
| T=0.6 | 0.667 | 0.675 | **0.876** |
| ctx1500 | 0.616 | 0.629 | **0.782** |
| ctxcold | 0.622 | 0.637 | **0.794** |

- The same builds in both sessions agree to within 0.8% at T=0: th-integ 65.95 then vs 65.61 now; th-main 54.02 vs 54.42; Splash 78.56 vs 78.97. The ratios can therefore be compared across the two sessions.
- Phase B's cross-session estimate for "delivered work + L1" was ≈70–73 tok/s at T=0 [E]. The measured 81.4 tok/s is higher because G1a (−6.35 ms/round) was not in that estimate.

### 1.5 Where the round goes (T=0, s1, mean per logged round, ms)

| phase | th-main `cf3e5f7` | th-integ `8d5b6d5` | **th-integ2 `521c6e0`** | Splash 1.0 |
|---|---|---|---|---|
| propose (draft forward + select; ends in the round's first host sync) | 9.7 | 8.2 | **6.2** | — |
| verify host encode (`[verify] enqueue` − propose; includes `snapshot()`) | 10.1 | 8.2 | **2.1** | — |
| verify GPU tail + readback | 42.6 | 37.6 | 38.4 | — |
| rest (accept, commit, rollback, emit) | 1.0 | 1.1 | **0.1** | — |
| **round** | 63.40 | 54.95 | **47.16** | 47.66 |
| GPU-busy (ioreg slope vs rounds; upper bound for th) | 56.0 | 47.7 | 45.7 | 47.5 |
| idle = round − GPU slope (lower bound for th) | 7.3 | 7.1 | **1.3** | 0.6 |
| server-process CPU (slope) | 18.7 | 15.8 | **4.5** | 1.3 |
| tokens/round | 3.450 | 3.605 | 3.843 | 3.763 |
| loop tok/s | 54.42 | 65.61 | **81.49** | 78.97 |
| step p10 / p50 / p90 | 61.9 / 63.0 / 64.7 | 53.3 / 54.5 / 56.4 | 45.9 / 46.9 / 47.5 | — |

- G1a accounts for most of the drop in host encode (8.2 → 2.1 ms): `snapshot()` no longer copies state.
- The propose drop (8.2 → 6.2 ms) matches the lanes' own propose deltas: D1 −0.91, G1a −0.74, MEM-2 −0.26, K7 −0.2.
- The verify GPU tail rises slightly (37.6 → 38.4 ms) even though GPU-busy per round falls (47.7 → 45.7) [D]. With host encode 6 ms shorter, less of the verify's GPU work overlaps the encode, so more of it lands after `enqueue`.
- th's round is now GPU-bound, like Splash's. Its per-round GPU time (≤45.7 ms) is at or below Splash's 47.5.
- Sampled rounds on th-integ2 cost +2.3 ms over greedy (49.46 vs 47.16 ms): `rest` is 2.2 vs 0.1 ms, from the `[8, vocab]` bf16 readback plus CPU `dist_vec` / `spec_accept_step`. Splash's sampled round costs +0.8 ms over its greedy one.

### 1.6 Tokens per round on byte-identical greedy text (s1; rounds = th logged + 1, Splash `decode_batches`)

| pair | groups | tokens | rounds A / B | tok/round A / B |
|---|---|---|---|---|
| th-integ2 vs Splash | 7 | 597 | **151 / 147** | 3.954 / 4.061 (Splash needs 0.974× the rounds) |
| th-integ vs Splash | 7 | 597 | 163 / 147 | 3.663 / 4.061 (0.902×) |
| th-integ2 vs th-integ | 8 | 724 | 180 / 195 | 4.022 / 3.713 (+8.3%, L1) |

Per group, th-integ2 vs Splash:

| group | th-integ2 rounds | Splash rounds |
|---|---|---|
| greedy/short | 6 | 6 |
| greedy/long | 38 | 36 |
| ctx1500/short | 7 | 7 |
| ctx1500/code | **35** | 36 |
| ctx1500/long | 34 | 31 |
| ctxcold/short | 4 | 4 |
| ctxcold/long | 27 | 27 |

The residual T=0 acceptance gap is ≈2.7% of rounds. Sampled is the real acceptance gap: tokens/round 3.590 vs 4.014 (0.894). By prompt, short 4.93 vs 5.35, code 3.84 vs 4.47, long 3.21 vs 3.46.

## 2. What each lane delivered (measured)

Every lane started from `report/integration-sim` @`8d5b6d5` (sha256 `e91a30d2afb7`) and measured itself against that binary, same session, fresh server per arm, under `gpu-lock`, T=0 plus 0.6/0.95/20 with seeds 1, 3, 5, ratio of sums. Numbers below are the lanes' own [M] results (reports in `$P/reports/`); §2.4 is this report's same-session measurement of all three combined.

### 2.1 th/c-loop @`be12e45` — L1, Q1, D1 (report `th-c-loop.md`)

| item | commit | default | measured effect | basis |
|---|---|---|---|---|
| **L1** always verify 7 proposals (8 rows) | `868fe34` | on (`TH_VERIFY_ADAPTIVE=1` = legacy EMA rule) | 15-prompt T=0 set: **3.821 → 4.299 tokens/round (+12.5%)**, 69.0 → 79.3 tok/s (+14.8%). 3 bench prompts T=0: 3.605 → 4.410, 63.9 → 79.1 tok/s; sampled 3.146 → 3.938, 53.1 → 67.8 tok/s (+27.7%). fwd8 is the cheapest verify shape (39.7 ms vs fwd2 41.5). The adaptive cap had bound on 35.5% (T=0) / 33.7% (sampled) of rounds | s_2 palindrome, s_3 15-prompt set, s_L1 histograms; load 2.2–5.9 |
| **D1** host-resident codebooks, one propose sync | `d84bd7d` | on | host syncs/round **6 → 2** (interposer); propose 8.27 → 7.36 ms, round −0.91 ms (−1.6%); outputs identical 24/24; batched `[pb] cand_tables` 9.09 → 7.90 ms | s_4 ABBA, load 2.8–3.9 |
| **Q1** decode thread at USER_INTERACTIVE | `2498d35`, `be12e45` | **off** (`TH_DECODE_QOS=interactive` opt-in) | −0.27 ms/round ambient, −0.47 with 18 CPU spinners (load 8 → 31): inside the arm spread; host encode and idle unchanged | s_2, s_4 |
| anchor off-by-one (d523828 + batch path) | `68f3423` on **th/c-loop-anchor** | not merged | 15-prompt T=0: 4.299 → 4.286 tokens/round (−0.3%), ms/round unchanged; correct but no gain | s_3 |
| **head vs base** | `be12e45` | | T=0 55.46 → 54.65 ms/round, 3.605 → 4.410 tok/round, **65.0 → 80.7 tok/s (+24.2%)**; all 24 requests 57.3 → 71.8 (+25.3%); TTFT unchanged; TH_BATCH=2 9/9 | s_5 ABBA, load 2.5–3.4 |

### 2.2 th/c-gdn-parity @`a93f982` — R0a, G1a (report `th-c-gdn-parity.md`)

| item | commit | measured effect | basis |
|---|---|---|---|
| **R0a** state-bitwise rollback gate (`TH_TEST_ROLLBACK`, exits 1) | `79cfba4` | on base code: **FAIL** (1.3M–6.3M of 37.7M recurrent f32 differ, all 48 layers); after G1a: **PASS** (0 differences at every kept=1..8, conv windows too, slot isolation ok); `TH_GDN_COMMIT=step`: FAIL (the gate discriminates) | probe |
| **G1a** persistent double-buffered GDN parity state per slot | `a93f982` | T=0 **55.04 → 48.69 ms/round (−6.35, −11.5%)**, 65.50 → 74.04 tok/s on identical tokens; verify host encode 8.00 → 2.72 ms; idle 6.68 → 1.31 ms/round; host CPU 15.67 → 8.39 ms/round; sampled 57.01 → 50.53 ms/round; TH_BATCH=2 nb=2 rounds 87.8 → 76.4 ms (−13%); forward alone (TH_BENCH_MULTI) unchanged; RSS +≈195 MiB/slot persistent, −192 MiB transient/round | s3 ABBA×2, load 2.7–5.7 |

Removed per round per slot: 96 × 4 MiB state copies (snapshot + rollback), the conv cat/contiguous copies, 48 pack allocations. The rollback is one fused commit dispatch per layer re-scanning the kept rows through the verify's instruction stream, so the committed state is bit-identical to a forward of the kept rows.

### 2.3 th/c-ports @`7253731` — K7, N2, MEM-2, MEM-4 (report `th-c-ports.md`)

| item | commit | measured effect | basis |
|---|---|---|---|
| **K7** m=1 tiled matvec + fused silu·mul (port of `4bb1731` over K45) | `6da668d` | plain decode (no `--draft`) **26.29 → 28.75 tok/s (+9.4%)** T=0; V-multi fwd1 41.70 → 37.70 ms; m=1 projections 31.9 → 27.6 ms/token; DFlash unchanged (55.12 vs 54.64 ms/round, noise); `TH_M1_PATH=mpp` = base bitwise | S1/S2/S3 |
| **N2** one greedy tie rule; greedy slots read argmax rows in mixed batches | `8ed2ac1` | correctness: a T=0 slot's text no longer depends on a sampled batch mate (`83e6baa4` → `5ae613fd`); perf 0 (54.31 vs 54.48 ms/round) | S2/S3 |
| **MEM-2** no zero-fill blits at the 5 remaining sites | `8b431f3` | −0.37 ms/round (in-binary ABBA `TH_OUT_ZEROS=1` vs default), −0.26 ms propose; bitwise identical 13/13 | S2/S3 + microbench |
| **MEM-4** skip dead draft ring gathers | `7253731` | at a 1.8k ring: **propose 17.09 → 15.78 ms (−1.31)**, round −0.96; ≈0 at bench context; bitwise identical | S2 |
| **head vs base** | `7253731` | T=0 55.12 → 54.35 ms/round (−1.4%); ctx2k 74.72 → 73.18 (−2.1%) | S2 palindrome, load 2.5–4.5 |

### 2.4 All three combined, same session (this report, s1)

Same session, 8d5b6d5 → 521c6e0 (s1, both arms of each build; ratio of sums):

| mode | ms/round | tokens/round | loop tok/s | Δ tok/s |
|---|---|---|---|---|
| T=0 | 54.95 → **47.16** (−7.79, −14.2%) | 3.605 → 3.843 (+6.6%) | 65.61 → **81.49** | **+24.2%** |
| T=0.6 | 57.34 → 49.46 (−7.88, −13.7%) | 3.208 → 3.590 (+11.9%) | 55.94 → 72.58 | +29.7% |
| ctx1500 | 70.07 → 61.44 (−8.63, −12.3%) | 3.506 → 3.822 (+9.0%) | 50.04 → 62.20 | +24.3% |
| ctxcold | 70.56 → 61.69 (−8.87, −12.6%) | 4.015 → 4.371 (+8.9%) | 56.90 → 70.85 | +24.5% |

- **Additivity.** The lanes' own T=0 deltas against 8d5b6d5 predict ≈ −7.7 ms/round: G1a −6.35, D1 −0.91, MEM-2 −0.37, and ≈0 each for L1, K7, N2 and MEM-4 at bench context. The measured delta is −7.79, so nothing was lost in the merge.
- **Where the time went, T=0 phases:**
  - propose 8.2 → 6.2 ms (D1, G1a, MEM-2, K7);
  - verify host encode 8.2 → 2.1 ms (G1a);
  - verify GPU tail 37.6 → 38.4 ms (less GPU work now overlaps the shorter encode; GPU-busy falls 47.7 → 45.7);
  - rest 1.1 → 0.1 ms (G1a's one fused rollback dispatch per layer);
  - idle 7.1 → 1.3 ms/round and server CPU 15.8 → 4.5 ms/round.
- **Longer context (ctx1500):** propose 14.7 → 12.0 ms (MEM-4 + D1).
- **Tokens/round.** On byte-identical text the gain is +8.3% (195 → 180 rounds for 724 tokens), all from L1. On this suite L1 gains less than c-loop measured on the 3 bench prompts (+22%). There, the code prompt's greedy text changed to a more draftable one; here the combined build emits 8d5b6d5's text on 8/9 groups. c-loop's 15-prompt set (+12.5%) is the better estimate of L1 alone.
- **TTFT:**
  - Bench prompts: 173 → 172 ms median, unchanged.
  - Cold ≈1.45k-token prefill (ctxcold): 2453 → 2511 ms mean (+2.4%). Both arms of each build agree to within ±8 ms (integ 2449 / 2457, integ2 2510 / 2511), so the difference is real but small. It is not attributed; the likely candidate is G1a's out-of-place GDN prefill path (`gdn_step` + `gdn_conv_carry`, seq > 8), which no lane timed at long prompts.
  - ctx1500 TTFT spreads 2337–2599 ms between arms of the same build, too widely to resolve this.
- **Sampled trajectories** differ from 8d5b6d5, as expected: G1a's exact rollback, L1's extra acceptance draws, and K7's m=1 draft commits all change them. Each build is deterministic per seed.

### 2.5 Not merged

| branch @ sha | why | merge state vs integration-2 |
|---|---|---|
| th/c-loop-anchor @`68f3423` | anchor off-by-one fix (single-slot + batch): correct (KV row P is attended as zero, draft ring slot P never written), but −0.3% tokens/round on 15 prompts; kept off by the lane's rule | merges clean (`merge-tree` rc=0) |
| th/c-ports-mem2bench @`af0e850` | MEM-2 interleaved microbench, probe only | — |
| verify-numerics-N3-attn @`4f998f4` | split-K `attn_decode` prototype, probe only | merges clean |
| verify-numerics-N4-draftattn @`1738e0a`/`dd28d2a` | `draft_attn_split` prototype | conflicts in dflash.rs, engine.rs, main.rs |
| `b9e7971` `check_x_extent` (Phase B follow-up) | not ported by any lane | — |

## 3. Review verdicts

| branch @ head | review verdict | must-fix | status in integration-2 |
|---|---|---|---|
| th/c-loop @`be12e45` (L1 `868fe34`, Q1 `2498d35` + `be12e45`, D1 `d84bd7d`) | **mergeable** | none | merged (`7349e07`) |
| th/c-gdn-parity @`a93f982` (R0a `79cfba4`, G1a `a93f982`) | **mergeable** | none | merged (`b1566c1`) |
| th/c-ports @`7253731` (K7 `6da668d`, N2 `8ed2ac1`, MEM-2 `8b431f3`, MEM-4 `7253731`) | **mergeable** | none | merged (`521c6e0`) |
| report/integration-sim @`8d5b6d5` (integration head review, `review-integ.md`) | **mergeable as a unit, no must-fix** | none | the base of integration-2 |

Should-fix items from the integration-head review, state at `521c6e0` (none blocking, none addressed by a lane unless stated):
1. `gdn_fused_step` presum sums hard-code two quant groups per value head (DV=128): the Rust guard (gdn_kernel.rs:870) still checks only `dv % 64 == 0`. Open (G1a kept the same sums code).
2. `pf_env()` reads `TH_GPU_CORES` with default 40 instead of K2's `gpu_cores()` (`pf_env`, quant_kernel.rs:4149-4162). Open.
3. Stale "o_proj over-read byte-for-byte" comment in `linear_ps` (qwen35.rs:510-516). Open.
4. Per-call env reads: **partly fixed** — `TH_DRAFT_EAGER` (D1 and MEM-4), `TH_DEBUG_TIMING` (L1, D1), `TH_DEBUG_ROLLBACK` and `TH_GDN_AB_CONTIG` (G1a) are now read once. Still per call: `TH_NO_ATTN_FUSED`, `TH_DEBUG_ATTN`, `TH_PHASE_TIME`.
5. No fallback when an `AffineQpf` pipeline is unavailable. Open.
6. Bench code in qwen35.rs (`bench_q4_decode`, `bench_prefill`, `bench_draft_mlp`); K7 added more arms to `bench_q4_decode`. Open (suggest `engine/src/bench.rs`).
7. `Q4AttachSums` is bench-only production code. Open.

Lane-level notes the lanes themselves raised (not review findings): G1a's light-snapshot contract (§5.3); the default commit changes sampled trajectories vs 8d5b6d5 (T=0 bench prompts unchanged; `TH_GDN_COMMIT=step` gives base-identical streams); N2's `batch_round` change touches the other developer's batched path and needs their sign-off; the eager GDN path (`TH_GDN_EAGER`, CPU) was updated for parity but not exercised on the real model.

## 4. integration-2: build and gates

**Branch** `report/integration-2` @`521c6e0`, worktree `/Users/benebsworth/projects/token-horizon/.worktrees/report/integration-2`, created by `$P/bin/wt-bootstrap report/integration-2` (start `report/integration-sim` @`8d5b6d5`). Three `--no-ff` merges, in this order: `7349e07` (th/c-loop `be12e45`), `b1566c1` (th/c-gdn-parity `a93f982`), `521c6e0` (th/c-ports `7253731`). Not pushed.

**Must-fix items from the integration-head review:** none were open (the review verdict on `8d5b6d5` was "mergeable as a unit, no must-fix"), so none were applied.

**Binary:** `engine/target/release/th-engine` @`521c6e0`, sha256 `66e99644402995638d921e8e53cb6fc1f12d1d8fbcfea12c71de2c238f6cb133` (copy: `$W/bin/th-engine-i2-521c6e0`, cmp-identical to the worktree build).

All gates ran in one `gpu-lock` hold (08:12:24–08:14:36, load 2.5–3.7), private port :8035, script `$W/bin/gates.sh`, logs `$W/logs/gates/` and `$W/logs/gates.out` (`W=$P/work/integration-2`).

| gate | result |
|---|---|
| `cargo build --release` | **0 warnings** (33 s incremental) |
| `cargo test --release` (release test binary `th_engine-404afa4a59ca4dd5`, sha256 `500fb23217a9…`) | **37/37 pass** (24 from 8d5b6d5 + 5 c-loop + 2 c-gdn-parity + 6 c-ports), 6.9 s; includes `gdn_parity_rollback_state_bitwise_over_chained_rounds`, `gdn_parity_light_snapshot_restore_rules`, `n2_greedy_tie_rule_matches_argmax`, `qmvt_*`, `cand_tables_packed_readback_is_exact`, `mem6_admission_mode_never_changes_inflight_slot`, `utf8_stream_qwen_tokenizer` (real tokenizer present) |
| R0a state-bitwise rollback gate: `TH_TEST_ROLLBACK=1 TH_BATCH=2 th-engine probe` | **PASS, rc=0** ("rollback state-bitwise: PASS"; slot isolation checked at TH_BATCH=2; legacy logits check PASS, argmax ref=rb=ctl=68) |
| same with `TH_GDN_COMMIT=step` (discrimination arm) | **FAIL, rc=1**, as intended: the gate still discriminates on the merged build |
| legacy logits worst \|Δ\| at kept=1 | 0.1250 (c-gdn-parity head: 0.1094). kept=1 is the m=1 forward, which K7 now routes through `AffineQmvT`; batch-shape rounding, not rollback (kept=2..8: 0.0000 refwd \|Δ\|) |
| TH_BATCH=2 `--draft` smoke (c-ports `batch2_client.py`: warm-up, 2 T=0 pairs, 2 sampled pairs, 2 N2 mixed T=0+sampled pairs) | **13/13 HTTP 200**, 0 errors, 0 panics/WARN/ERROR in the log, max trigram-repeat 0.098. N2: the T=0 "code" text is identical in the all-greedy pair and in both mixed pairs (`5ae613fd18`, the same sha1 c-ports measured on c2..c4) |
| TH_BATCH=4 `--draft` smoke (review-integ `spec_batch4`: 4-way mixed incl. streamed CJK, 4-way greedy, 6-deep queue, solo) | **16/16 HTTP 200**, 0 errors, 0 panics/WARN/ERROR, 0 U+FFFD, max trigram-repeat 0.089. Greedy identity inside the arm: code and short identical between the 4-way-greedy and 6-queue groups; long and CJK diverge (the known co-scheduling effect, PHASEB §2.2) |
| `POST /engine/kv/clear` on the idle TH_BATCH=4 server, then solo + a mixed pair | `{"cleared":[0,1,2,3],"ok":true,"skipped_live":[]}`; afterwards 3/3 HTTP 200, and the solo code T=0 text is **identical** to the pre-clear solo (`3fa3ed27b5`): G1a's parity reset in `clear_kv_cache` leaves no stale state |
| no draft, single slot (plain decode, n-gram spec) | 5/5 HTTP 200; T=0 repeat identical |
| no draft, TH_BATCH=2 (M5 fallback) | 3/3 HTTP 200; one WARN "TH_BATCH>1 requires --draft; batched decode disabled, serving single-slot"; `features.batch_slots: 1`, `model.decode_slots: 1` |
| V-contract (`/status` key paths, `th_stats` keys; bench arms new1 vs integ1) | **PASS**: 29 = 29 paths, `th_stats` {decode_tps, prefill_tps, total_ms, ttft_ms} unchanged |
| MetalStorage clone-escape class | none introduced by the merge (the resolution uses `outbuf::kernel_out` = `Tensor::empty`; lanes: `state_copy` uses `slice_set`, qmvt outputs are fresh buffers) |
| per-call env reads | none added. Still per call (pre-existing on main, review should-fix #4): `TH_NO_ATTN_FUSED` (qwen35.rs:3609) and `TH_DEBUG_ATTN` (:3639, attn_kernel.rs:251/:296) per attention layer, `TH_PHASE_TIME` per forward (qwen35.rs:3955) |
| determinism | every th build is text-identical across its own arms in the bench (§1) |

## 5. Landing on main

### 5.1 merge-tree against main

Read-only, with `GIT_OPTIONAL_LOCKS=0`, at 08:1x and again at report time:

- `git merge-tree --write-tree --name-only main report/integration-2` → **clean**. The result tree `dd047b7787746679e1bb8cb02614a62bcb02c5aa` is exactly `report/integration-2^{tree}`, because `main` (`cf3e5f7`) is an ancestor of the branch: landing is a **fast-forward** of 47 commits (36 non-merge + 11 merge).
- The main working tree had 0 tracked changes (`git status --porcelain --untracked-files=no` empty; the untracked `.claude/`, `docs/.agents/`, `docs/MTPLX/` are not engine code). `main` has not moved since Phase B.
- If `main` moves before landing, re-run the same `merge-tree` first. Any new conflict will land in the other developer's files (below), most likely `engine.rs`, `qwen35.rs` or `dflash.rs`.

### 5.2 Exact merge order (the first-parent history of `report/integration-2`)

| # | commit on report/integration-2 | step | resolution |
|---|---|---|---|
| 1 | FF to `5a93868` | th/wp2-matmul-roofline: K1, P0 (×2), K2, K45(a,c,d), 2 bench commits | fast-forward of main |
| 2 | `310aebb` | U1 `3d8a2c6` | clean |
| 3 | `cfac392` | M1 `c498244` | clean |
| 4 | `bb4292d` | M3 `316c18a` | clean |
| 5 | `a41bcb6` | M5 `5c4da25` | clean |
| 6 | `f02d53f` | MEM-6 `0188158` | clean |
| 7 | `1ec710a` | fix-N1 `8bcc3f3` | clean |
| 8 | `beae488` | B1 `b5f1457` | 2 hunks in `forward_inner`: keep `lin_apply_ps(&h, .., h_ps)` and `.take().context(..)?` |
| 9 | `7034d4a` | T2 `dc203fd` | 1 hunk: quant_kernel.rs re-exports (K45 list + T2's cfg-gated `pf_*` line) |
| 10 | `8d5b6d5` | semantic fix T2 × K45 | E0308 in `gate_up_act_ps`: the T2 rows>8 arm returns `(y, false)` |
| 11 | `7349e07` | **th/c-loop `be12e45`** (L1, Q1, D1, Q1 opt-in) | clean |
| 12 | `b1566c1` | **th/c-gdn-parity `a93f982`** (R0a, G1a) | clean |
| 13 | `521c6e0` | **th/c-ports `7253731`** (K7, N2, MEM-2, MEM-4) | 3 hunks, below |

Conflict notes for step 13 (pairwise `merge-tree`: c-loop × c-gdn-parity clean; c-loop × c-ports conflicts in dflash.rs + engine.rs; c-gdn-parity × c-ports conflicts in qwen35.rs):

1. **dflash.rs, EOF helpers.** D1 (c-loop) and MEM-4 (c-ports) each added a OnceLock `draft_eager()` with identical semantics (`TH_DRAFT_EAGER` read once). Kept c-loop's copy plus its `debug_timing()`; MEM-4's call sites use the same function name. No behaviour change.
2. **engine.rs, EOF tests.** Both appended test modules. Kept both: c-loop `dflash_policy` + `decode_qos_tests`, c-ports `n2_tie_tests`.
3. **qwen35.rs, `gdn_forward` fused-step output allocation** (`gdn_forward`, qwen35.rs:3291-3314 @521c6e0). Kept G1a's structure: `gated` allocated here, the normed `pack` stash only when a step re-scan needs it (`gdn_commit_step()`, already an uninitialised `AllocBf16`). Applied MEM-2 to the one zero fill that remained: the non-presum `gated` is now `outbuf::kernel_out` (`TH_OUT_ZEROS=1` restores the fill). The G1a kernel writes every `y[t < T, hv·DV + d]` in its gated-norm stage (gdn_kernel.rs:431-446), so the uninitialised buffer is fully covered. Default path (presum on) is unaffected: it uses the K45 `AllocBf16` block.

The alternative is to land lanes individually in the order 11 → 12 → 13 and resolve exactly as in `521c6e0` (the resolutions are in its commit message).

### 5.3 Ownership

The other developer's area is `engine/src/{dflash,draft_kernel,engine,main,model,qwen35}.rs`. Against `main`, integration-2 changes all six of them; `gdn_kernel.rs`, `quant_kernel.rs`, `server.rs` and the new `outbuf.rs` are outside it.

| file | +/− vs main (of which Phase C, vs 8d5b6d5) | Phase C lanes touching it | theirs? |
|---|---|---|---|
| qwen35.rs | +2661 / −323 (+1306 / −223) | c-gdn-parity (Slot GDN state, `snapshot`/`restore`/`rollback_verify`, both forwards), c-ports (K7 m=1 route, MEM-2 sites, K7 bench arms) | yes |
| engine.rs | +966 / −78 (+373 / −33) | c-loop (single-slot DFlash loop: L1, Q1 guard, timers), c-ports (N2: `greedy_argmax`, `greedy_rows`, per-slot argmax in `batch_round`) | yes |
| dflash.rs | +184 / −65 (+133 / −55) | c-loop (D1 host codebooks, one packed readback), c-ports (MEM-4 gathers below the fused return) | yes |
| main.rs | +241 / −16 (+48 / −4) | c-gdn-parity (R0a gate in `TH_TEST_ROLLBACK`, `snapshot_deep` in probes), c-ports (`mod outbuf`) | yes |
| model.rs | +17 / −0 (+10 / −0) | c-gdn-parity (`snapshot_deep` on the backend trait) | yes |
| draft_kernel.rs | +9 / −3 (+9 / −3) | c-ports (MEM-2: 3 draft outputs uninitialised) | yes |
| gdn_kernel.rs | +546 / −241 (+417 / −232) | c-gdn-parity (parity-in/parity-out `gdn_fused_step`, commit mode, out-of-place `gdn_step`, `gdn_conv_carry`) | no |
| quant_kernel.rs | +2510 / −116 (+525 / −2) | c-ports (K7 `AffineQmvT` + `qmvt_warm`) | no |
| outbuf.rs | +38 (new) (+38) | c-ports (`kernel_out`, `TH_OUT_ZEROS`) | no |
| server.rs | +3 / −2 (0) | none (U1, Phase B) | no |

What changes for them (API and behaviour):
- `snapshot(slot)` is now **light**: it records the committed GDN parity and is valid across exactly one following forward on that slot. `restore`/`rollback_verify` return an error on a stale light snapshot instead of restoring wrong state. Callers that restore across several forwards must use the new `snapshot_deep()` (model.rs). All in-tree callers were audited by the lane (engine.rs DFlash B=1, n-gram restore, batch).
- The single-slot DFlash loop always verifies 8 rows (L1); `TH_VERIFY_ADAPTIVE=1` restores the EMA rule. The batch path already verified 7.
- The DFlash pred/succ codebooks (254 MB) live on the host (D1).
- N2: greedy picks use the lowest-index tie rule on every path, and `batch_round` reads argmax rows for greedy slots even when a batch mate samples.
- Default T=0 streams change vs main (m=8 verify everywhere, exact rollback, K7 m=1 rounding); `TH_GDN_COMMIT=step` restores the old rollback numerics, `TH_M1_PATH=mpp` the old m=1 route.
- New knobs, all read once: `TH_VERIFY_ADAPTIVE`, `TH_DECODE_QOS`, `TH_GDN_COMMIT`, `TH_OUT_ZEROS`, `TH_M1_PATH`, `TH_TEST_ROLLBACK` (state-bitwise gate, exits 1 on mismatch).
- `/status` and `th_stats`: unchanged (29 = 29 key paths; `th_stats` keys {decode_tps, prefill_tps, total_ms, ttft_ms}).
- After landing, the live :8001 (pid 16917, the stale 18:08 dirty build with every Phase B §2.2 bug) should be restarted from the merged build. That is the maintainer's call; this report did not touch it.

## 6. Remaining gap to the kernel floor, and the next three levers

### 6.1 The gap at bench context (T=0, s1)

| | th-integ2 `521c6e0` | Splash 1.0 | floor |
|---|---|---|---|
| ms/round | **47.16** | 47.66 | F_k ≈ 36 (all matmuls at the measured fit, zero overhead; SYNTHESIS/Phase B), F_bw 29.8 |
| GPU-busy ms/round (ioreg slope; an upper bound for th) | 45.7 | 47.5 | |
| idle = round − GPU slope (a lower bound for th) | 1.3 | 0.6 | 0 |
| phases [M] | propose 6.2 · verify host encode 2.1 · verify GPU tail + readback 38.4 · rest 0.1 | one CB + one sync per round | |

- **Gap to F_k: ≈11.2 ms/round (24% of the round).** [D] It is now almost all GPU work: host idle is ≈1.3 ms, so ≈9.7 ms (≤ 45.7 − 36) is GPU time above the matmul floor.
- Where that GPU time sits, from the phase split [D, not per-kernel]: the verify tail is 38.4 ms against the verify matmul fit of 30.9 ms, so ≈7.5 ms is attention, GDN scan/commit, norms, captures, the lm_head beyond fit and dispatch gaps; the propose is 6.2 ms against a draft bandwidth floor of 2.9 ms, so ≈3.3 ms is draft-side. The per-kernel split is unmeasured; it needs R0c's per-CB GPU intervals (`/tmp/mem2v/mtlc/mtlc.m`, `$P/work/th-c-loop/mtlc/mtlc3.m`).
- **The context-dependent part is the real gap to Splash.** At ≈1.45k context th's round grows **+14.3 ms** (47.16 → 61.44: propose +5.8, verify GPU tail +8.4, host encode +0.1) while Splash's grows +1.1 (47.66 → 48.77). That is Phase B's N4 (`draft_attn` on 8 threadgroups) and N3 (`attn_decode` without a key split), untouched by Phase C.

### 6.2 The next three levers (ranked by expected gain against Splash)

| # | lever | the gap it closes [M] | expected [E] | starting point | files / owner |
|---|---|---|---|---|---|
| 1 | **Long-context attention: N4 `draft_attn_split` + N3 split-K `attn_decode`** | ctx1500 is **0.782×** Splash; +14.3 ms/round of context growth vs Splash's +1.1 | N4: propose +5.8 → ≈+1 ms at 1.45k (prototype: 12.7× per call at ring 2048; in situ propose 24.09 → 13.18 ms at 2.6k). N3: most of the +8.4 ms GPU tail at 1.45k, −37 ms/round at 8k (prototype: verify forward 98.3 → 61.2 ms). Together ≈61.4 → ≈50–52 ms/round at 1.45k ⇒ ≈0.92–0.96× Splash there, and the only way to stay usable at ≥ 4k | `verify-numerics-N3-attn` @`4f998f4` (merges clean into integration-2), `verify-numerics-N4-draftattn` @`1738e0a`/`dd28d2a` (conflicts in dflash.rs, engine.rs, main.rs); Gate C: ≤ 1.5× Splash per layer at 128/512/2k/8k | attn_kernel.rs + qwen35.rs `attn_forward` (N3); draft_kernel.rs + dflash.rs (N4, other developer's files) |
| 2 | **Sampled decode: acceptance (R0b) and GPU accept (S1)** | sampled is **0.876×** Splash = per-round 0.979 × tokens/round **0.894** (3.590 vs 4.014); Splash gains tokens/round when sampling (3.763 → 4.014), th loses them (3.843 → 3.590); th's sampled round costs +2.3 ms over greedy (`rest` 2.2 vs 0.1 ms: the [8, vocab] bf16 `to_vec2` + CPU `dist_vec`/`spec_accept_step` per row) | S1 (GPU top-k/Z + accept, a 12-u32 result block): ≈−2 ms/round ⇒ ≈+4% sampled; acceptance parity with Splash: up to +12% | R0b first: a many-seed th-vs-Splash acceptance study (9 fixed samples cannot separate the p/q rule from trajectory luck), then `spec_accept_step` (engine.rs) and a new sample kernel | engine.rs (other developer), new sample_kernel.rs |
| 3 | **Short-context GPU work above F_k: R0c per-CB timing first, then the small fusions** | the ≈9.7 ms of GPU time above F_k at bench context (§6.1); its split is unmeasured | one dispatch for all 48 GDN commits (G1a follow-up, 0.2–0.4 ms); draft presum producers (bench −13% to −24% on the draft projections, i.e. part of the ≈3.3 ms draft excess); K45 `down` split_long default and attention-output presum (≈0.3–1 ms); X1/X2 (one command buffer per round) is now worth at most the remaining ≈1.3 ms of idle. Together ≈1.5–3 ms/round ⇒ ≈+3–6% at T=0 | R0c counter source (`mtlc3.m`), `th/c-gdn-parity` notes §5, K45 report §9 | qwen35.rs, dflash.rs (other developer), gdn_kernel.rs, quant_kernel.rs |

Not a decode lever, but the largest user-visible gap: **TTFT.** Splash serves the repeated 1.4k passage from its prefix cache at 143 ms median against th's 2451 ms (T1 not implemented), and cold 1.45k prefill is 1950 vs 2510 ms (th 1.29× slower). For agent traffic with long, repeated system prompts, T1 (prefix cache) is worth more than any remaining decode item.

Smaller open items: the anchor off-by-one fix (`th/c-loop-anchor` @`68f3423`, correct, no speed effect, merges clean); review should-fix 1 (DV=128 guard in the GDN presum producer), 2 (`pf_env` `TH_GPU_CORES`), 5 (no `AffineQpf` fallback); the last per-call env reads (`TH_NO_ATTN_FUSED`, `TH_DEBUG_ATTN`, `TH_PHASE_TIME`); `prefill_tps` timed at enqueue (bench-quiet §5.1); `check_x_extent` (`b9e7971`).

## Appendix A: reproduce

```sh
P=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC; W=$P/work/integration-2
WT=$($P/bin/wt-bootstrap report/integration-2)          # .worktrees/report/integration-2, start 8d5b6d5
git -C $WT merge --no-ff th/c-loop                       # 7349e07, clean
git -C $WT merge --no-ff th/c-gdn-parity                 # b1566c1, clean
git -C $WT merge --no-ff th/c-ports                      # 521c6e0, 3 hunks resolved as in §5.2
(cd $WT/engine && cargo build --release && cargo test --release --no-run)   # 0 warnings
$P/bin/gpu-lock -- bash $W/bin/gates.sh $W/logs/gates   # tests, R0a gate (+step arm), TH_BATCH=2/4, kv/clear, no-draft
$P/bin/gpu-lock -- bash $W/bench/session.sh $W/bench/s1                                  # 8-arm palindrome
$P/bin/gpu-lock -- bash $W/bench/session.sh $W/bench/s2 "splash1 new1 new2 splash2"      # replicate
PY=~/.local/share/uv/tools/headroom-ai/bin/python        # has `tokenizers` for the re-tokenized divergence index
$PY $W/bench/analyze.py $W/bench/s1 md                   # pooled / per-arm / per-prompt / identity / identical-text rounds
python3 $W/bench/phases.py $W/bench/s1                   # round breakdown + ratios
python3 $W/bench/conditions.py $W/bench/s1               # per-arm load, CPU idle, thermal, GPU clocks
# s2n = s2 without the throttled splash2 arm (runs.jsonl filtered on arm != splash2, top.log copied); s12n = s1 + s2n
$PY $W/bench/analyze.py $W/bench/s1,$W/bench/s2n md; python3 $W/bench/phases.py $W/bench/s1,$W/bench/s2n
```

- `session.sh` is bench-quiet's `session.sh` with a 4th engine, a fixed private port (:8035, `BQ_PORT`) and frozen binaries: `$W/bin/th-engine-i2-521c6e0` (66e996444029), `th-engine-integ-8d5b6d5` (e91a30d2afb7, = the Phase B integration binary), `th-engine-main-cf3e5f7` (1f4fbca344ce, the bench-quiet main build). The client `bq_client.py`, `analyze.py` (+ th-integ2), `gpuq.py`, `gpufreq.py` and `passage.txt` (sha1 a886db14acc4) are copies from `.worktrees/bench-main/.bench-quiet/`.
- Raw data: `$W/bench/s1/` (and `s2/`): `runs.jsonl` (text, deltas, /status deltas, GPU/CPU ms, log offsets, load, thermal per request), `*.server.log`, `env.jsonl`, `quiet.jsonl`, `contention.jsonl`, `top.log`, `thermal.log`, `gpufreq.jsonl`; `$W/bench/s1.session.out`.

## Appendix B: cleanup

- **Processes started, and how each was stopped:**
  - Gates: 4 th-engine servers on :8035 (b2, b4, nd1, nd2), 2 `th-engine probe` runs and 1 unit-test run.
  - Bench s1: 6 th-engine servers on :8035 and 2 Splash servers on :8000.
  - Bench s2: 2 th-engine servers on :8035 and 2 Splash servers on :8000.
  - th servers: SIGTERM, with a KILL fallback.
  - Splash: SIGINT, then TERM/KILL for any leftover pid, including the `splash serve-native` child. Splash only ever ran on a free :8000, and never at the same time as a th server.
  - Per-session samplers (`top`, the thermal loop, `gpufreq.py`) were killed by the session's EXIT trap. The two log monitors were stopped.
- **After the last session:**
  - Only pid 16917 listens on :8001, and it was never touched.
  - :8000 and :8035 are free.
  - No th-engine, splash, session or sampler process of mine is left.
  - `/tmp/th-engine-gpu.lock` is free.
- **Git:**
  - New worktree `.worktrees/report/integration-2`, branch `report/integration-2` @`521c6e0`: 3 merge commits on `8d5b6d5`, trailer `Co-Authored-By: Claude Opus 5.5 (1M context)`. Not pushed. Remove it with `git worktree remove .worktrees/report/integration-2 && git branch -D report/integration-2`.
  - Nothing was committed to main, and the main working tree was never edited, built or reset.
  - `merge-tree` left unreferenced objects behind; `git gc` removes them.
- **Work dir:** `$W` = `.worktrees/_phaseC/work/integration-2`, containing `bin/` (frozen binaries, gates, clients), `logs/gates/`, `bench/` (harness, `s1/`, `s2/`, `s2n/`, `s12/`, `s12n/`) and `draft/` (report sections).
