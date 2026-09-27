# bench-quiet: th-integration vs th-main vs Splash 1.0, same session and same protocol

Written 2026-09-26 (06:11–07:38 AEST) by the bench-quiet agent.

- Three complete ABBA sessions: s1, s2, s3. That is 540 requests with 540 OK, 180 per session.
- s1 and s3 ran with the GPU at nominal clocks. s2 ran while the GPU was throttling (§3.2).
- Tags: [M] measured, [D] derived.

## 0. Answer

**th-integration / Splash 1.0, loop tok/s** (ratio of sums; same session; fresh server per arm; order integ, main, splash, splash, main, integ):

| mode | **s1 + s3 pooled (nominal GPU)** | s1 | s3 | s2 (throttled GPU, reference only) |
|---|---|---|---|---|
| **T=0** | **0.840** (65.95 / 78.56) | 0.843 | 0.837 | 0.909 |
| **T=0.6** (top_p 0.95, top_k 20, seeds 1/3/5) | **0.667** (55.27 / 82.93) | 0.659 ‡ | 0.674 | 0.734 |
| T=0, about 1.45k-token context (`ctx1500`) | 0.616 (49.43 / 80.20) | 0.625 | 0.608 | 0.692 |
| T=0, about 1.45k context, Splash prefix cache defeated (`ctxcold`) | 0.622 (55.99 / 90.04) | 0.622 | 0.621 | 0.658 |

‡ 0.680 if only the uncontended s1 integ1 arm is used (§3.1).

- **The two nominal sessions agree within 1–2%.** In s3, 179 of 180 requests started at thermal pressure 0, and decode windows ran at about 1600 MHz (P13) on both engines.
  - Per-arm loop tok/s at T=0 in s3: th-integ 66.09 / 65.97, Splash 79.07 / 78.78, th-main 54.16 / 54.58.
  - s1 per-arm: 66.07 / 65.68, 77.54 / 78.85, 52.86 / 54.49.
- **s2 is the throttled session and flatters th.** Splash's per-request ms/round rose from 47.4 to 59.6 within each arm, and long-prompt prefill was 20–29% slower for both engines.
  - Splash slowed 11% (48.1 → 53.4 ms/round) and th-integ only 3% (54.7 → 56.3), so s2 overstates th's ratio by about 8%.
  - Do not use s2 for vs-Splash ratios.
- **T=0 gap [M/D]:** 0.840 = per-round time 0.876 × tokens/round 0.958.
  - **Per-round time:** Splash 47.90 vs th-integ 54.67 ms/round.
  - **GPU-busy per round is the same:** th-integ 47.6–47.8 vs Splash 47.1–47.8 ms (ioreg slope). th's figure is an upper bound.
  - **The 6.8 ms/round difference is th's host idle:** 7.1 ms/round, against Splash's 0.9.
  - **Tokens/round:** on byte-identical greedy text (7 groups, 597 tokens), Splash needs **147 rounds and th-integ 163** (4.061 vs 3.663 tok/round).
  - th's adaptive `verify_len` stopped a round whose next draft proposal was the target's argmax on **96 of 456 T=0 rounds (21%)**.
- **T=0.6 gap:** 0.667 = per-round 0.834 (48.40 vs 58.04 ms) × tokens/round 0.799 (4.014 vs 3.208).
  - th's sampled round costs +2.4–2.7 ms more than its greedy round (s3, and s1 integ1). Almost all of that is host time: `rest` +1.6, verify +0.5, propose +0.3. Splash's sampled round costs +0.3–0.7 ms more.
  - Splash gets *more* tokens/round sampled than greedy (4.014 vs 3.763). th gets fewer (3.208 vs 3.605). Splash is higher on 9 of 9 prompt×seed pairs, but that is 9 fixed samples; see §4.3.
- **Long context is th's biggest loss.** At about 1.45k tokens:
  - th-integ's round grows **+15.2 ms** in s1 (54.73 → 69.92) and +16.3 in s3 on the uncontended integ2 arm.
  - Of the s1 growth, propose adds +6.6 and the verify GPU tail +8.3; host encode is unchanged.
  - Splash's round grows **+0.2 to +0.7 ms**.
- **th-integration vs th-main:** **1.221×** at T=0 (54.67 vs 63.87 ms/round), 1.075× at T=0.6, 1.110× at ctx1500. This reproduces Phase B (54.5 vs 63.1 ms/round).
- **Splash is faster than every earlier Splash reference.** Nominal: 47.9 ms/round and 78.6 tok/s at T=0.
  - Phase B measured 58.9 ms/round and 63.8 tok/s at load 26–49, and a "quiet" 51.3 / 72.4.
  - Phase B's claim that th does *less* GPU work per round than Splash (46.9 vs 50.9–58.7 ms) does not hold within one session. At nominal clocks the two are equal. th is lower only when the GPU throttles (s2: 49.8 vs 54.9).

## 1. Builds (verified)

| label | build | binary | how it ran |
|---|---|---|---|
| **th-integ** | `report/integration-sim` @`8d5b6d5`, worktree `.worktrees/report-integration-sim`, 0 tracked changes. `cargo build --release` was a no-op (0.2 s). | `engine/target/release/th-engine`, sha256 `e91a30d2afb70b2ba2a4d78294b0ca49ee922038d1fa1289f18e168c5e656b34`, the same as Phase B's `th-engine-integ-8d5b6d5` | Fresh `env -u TH_BATCH TH_DEBUG_TIMING=1 th-engine serve --model $TGT --draft $DRAFT --port 8051` per arm |
| **th-main** | `bench-main` @`cf3e5f7`, created by `$P/bin/wt-bootstrap bench-main cf3e5f7`, 0 tracked changes. `cargo build --release` took 32 s. | sha256 `1f4fbca344cebb8b89653eb25f99df414aade4b8ab0d7e5ea475ba6b8542d1fa`. It differs from Phase B's `th-engine-main-cf3e5f7` (`545e5462…`) in 48 bytes only: LC_UUID (offset about 2025) and one code-signature page hash (offset 15932110 onward; LC_CODE_SIGNATURE dataoff 15931936). Same code, different build path. | Same as th-integ |
| **Splash** | Splash 1.0 (brew, `/opt/homebrew/Cellar/splash/1.0`), `incoai/Qwen3.8-27B-Splash`. `/status` schema 5; KV dtype `q8s8_f32_scale_per_token_head_k_token_major_v_dimension_major`. | — | `:8000` was free. `splash serve --model incoai/Qwen3.8-27B-Splash` started fresh per arm (ready in 4–5 s) and was SIGINT-stopped after it. `:8000` was free after every session. |

- th arms ran one at a time on private port :8051, the first free port in 8051–8059.
- The live `:8001` (pid 16917) was never touched.
- No commits: nothing in the engine changed. The harness is untracked in the `bench-main` worktree.

## 2. Protocol

- **Session:** `$P/bin/gpu-lock -- bash session.sh <dir>` holds one lock for arms integ1 → main1 → splash1 → splash2 → main2 → integ2. Each arm starts its own server and stops it afterwards.
- **Before each arm:**
  - An env snapshot: loadavg, `top` CPU idle, memory, swap, `pmset -g therm`, and (s3 only) the thermal pressure level.
  - s3 only: a thermal-nominal wait for `notifyutil -g com.apple.system.thermalpressurelevel == 0`, at most 420 s before the first arm and 150 s later. The waits were 0–70 s.
  - A CPU-quiet wait: idle ≥ 85% on a 1 s `top` sample, at most 180 s.
  - `gpuq.py waitquiet 60 3 90`: other clients at most 60 ms/s of GPU time.
  - An ioreg snapshot.
- **After each arm:** the ioreg delta of non-engine GPU time.
- **Session-long background samplers:** `top -l 0 -s 3` (per-request CPU idle is joined from it). s3 also ran the thermal level every 2 s and IOReport GPU P-state residency in 2 s windows (`gpufreq.py`, no root; P1–P13 = 338–1620 MHz from the pmgr `voltage-states9` table).
- **Per arm (client `bq_client.py`):** two warm-ups, not recorded: `"Say hi."` and `passage + "Say hi."`, both T=0 with 32 tokens. Then:
  - `greedy`: the 3 bench prompts × 3 iterations, T=0, max_tokens 128. The prompts are short/code/long, with the same text as `bench-engines-port.sh`.
  - `sampled`: the 3 prompts × seeds 1, 3, 5 at T=0.6 / top_p 0.95 / top_k 20, set explicitly; max_tokens 128.
  - `ctx1500`: a fixed 1373-token passage + `"\n\n"` + the bench prompt, 3 × 3, T=0. That gives 1432/1442/1454 prompt tokens. The passage is the tag-stripped prose of `docs/blog/why-token-horizon.html` + `pricing-evidence.html` at `cf3e5f7` (sha1 `a886db14acc4`, built by `mkpassage.py`).
  - `ctxcold` (added): `"Note <k>.\n"` + passage + prompt k, one per prompt, T=0 (1437/1447/1459 tokens). The leading nonce limits Splash's prefix-cache reuse to the 32-token template block, so TTFT is a cold long prefill on both engines.
- **Per request, outside the timed window:** th server-log byte offsets (the `[dflash]`/`[verify]` lines), Splash `/status` deltas, ioreg `accumulatedGPUTime` and `ps` CPU time of the engine pids, loadavg, and (s3) thermal level.
- **SSE:** read with `readline()`. TTFT is the first content or reasoning delta.
- **Metrics:**
  - **loop tok/s** = Σtokens / Σround-ms. For th this is over the logged `[dflash]` rounds, which exclude the first token and the final unlogged round. For Splash it is `decode_output_tokens / decode_wall_ms`. tok/round and ms/round come from the same sums.
  - **like-for-like tok/s** = [Σ(comp−1) / Σrounds_all] / ms_round. rounds_all is th's logged rounds + 1, and Splash's `decode_batches`.
    - Splash's `decode_output_tokens` equals completion tokens on all 180 Splash requests, so its own convention counts the prefill-sampled token. The like-for-like figure removes it.
    - It moves the ratios by at most 0.01.
  - **GPU-busy ms/round** is the least-squares slope of per-request engine GPU ms against rounds_all; the intercept absorbs prefill.
    - **idle** = the client decode-wall slope minus the GPU slope.
    - On th, ioreg can double-count overlapping command buffers, so th's GPU-busy is an upper bound and its idle a lower bound.
- **Output identity:**
  - T=0 texts are compared after removing `</think>`. th streams it as a content delta; Splash drops it at the switch from reasoning to content. With that token removed the texts are byte-identical.
  - First divergence is reported as a character index and a re-tokenized token index.

## 3. Conditions

### 3.1 Per arm

GPU was quiet before and during every arm in all three sessions: other clients used 23.5–39.4 ms/s before and 25.8–39.7 ms/s during, mostly WindowServer at about 2.5%. Memory free was 71–86%. Swap used was 33.1 GB and unchanged (pre-existing).

| session | arm | pre-arm load1 | CPU idle % during (mean / min) | thermal level during (s3) | GPU during arm: active % / MHz / P13 share (s3) | long-prompt prefill tok/s (GPU-speed proxy) |
|---|---|---|---|---|---|---|
| s1 | integ1 | 5.67 | 87.9 / 81.2 | — | — | 615 |
| s1 | main1 | 2.16 | 83.7 / 43.2 | — | — | 611 |
| s1 | splash1 | 3.31 | 87.9 / 77.6 | — | — | 854 |
| s1 | splash2 | 4.18 | 90.5 / 88.9 | — | — | 935 |
| s1 | main2 | 3.50 | 88.7 / 82.3 | — | — | 630 |
| s1 | integ2 | 4.01 | 79.6 / 11.7 | — | — | 593 |
| s2 | integ1 | 4.20 | 86.7 / 63.3 | — | — | 465 |
| s2 | main1 | 2.26 | 85.8 / 60.6 | — | — | 490 |
| s2 | splash1 | 3.48 | 81.6 / 65.4 | — | — | 676 |
| s2 | splash2 | 4.08 | 81.3 / 68.2 | — | — | 667 |
| s2 | main2 | 3.60 | 82.1 / 57.6 | — | — | 524 |
| s2 | integ2 | 3.92 | 84.0 / 66.3 | — | — | 569 |
| s3 | integ1 | 28.31 (spike from the previous lock holder; 1-min load 14 at arm start) | 76.1 / 11.6 | 0 ×43, 1 ×1 | 91% / 1467 / 56% | 528 |
| s3 | main1 | 5.22 | 88.7 / 80.7 | 0 ×46, 1 ×1 | 93% / 1527 / 65% | 571 |
| s3 | splash1 | 3.90 | 90.2 / 83.7 | 0 ×24 | 91% / 1541 / 74% | 760 |
| s3 | splash2 | 1.72 | 89.7 / 84.3 | 0 ×21, 1 ×3 | 89% / 1573 / 85% | 878 |
| s3 | main2 | 1.87 | 89.4 / 82.9 | 0 ×47, 1 ×1 | 92% / 1524 / 65% | 569 |
| s3 | integ2 | 1.44 | 83.8 / 68.2 | 0 ×42, 1 ×1 | 91% / 1496 / 61% | 552 |

- **Prefill proxy.** For th: prompt tokens / client TTFT over the 12 ctx requests. For Splash: `/status` `prefill_input_tokens / prefill_wall_ms` over the 3 ctxcold requests (uncached rows only).
- **GPU clock inside decode.** Using only the 2 s IOReport windows that lie at least 80% inside one request's decode phase (s3), both engines ran at the top P-state:
  - th-integ greedy: 1606 MHz, P13 99% of active time.
  - th-integ sampled: 1588 MHz, P13 94%.
  - th-main: 1600 MHz, P13 97–98%.
  - Splash sampled: 1605 MHz, P13 98%.
  - So th's per-round gap is **not** a DVFS artefact. The lower arm-level averages for th come from prefill and inter-request gaps.
- **CPU contention events.** These are requests with CPU idle below 75%, which overlapped sibling `rustc` / `cargo test` builds of other agents:
  - s1: main1 greedy long#1–#3 (63/48/61%), main1 sampled short#1–#3 and code#1 (69–74%), integ2 sampled long#1–#3 (65/52/35%), integ2 ctx1500 short#1 and ctxcold long#1 (65–66%).
  - s3: integ1 ctx1500 code#1–#2 (43/60%) and ctxcold code#1 (56%).
  - The visible effects:
    - s1 integ2 sampled long#2/#3 ran 69.5 / 64.8 ms/round, against 57.4 / 56.5 in integ1 on the same text.
    - s3 integ1 ctx1500 code#1 ran 79.1 ms/round, against 71.0 in integ2.
  - `BQ_MIN_IDLE=75 analyze.py` drops these requests. The T=0 ratio is unchanged (s1: 0.843). The T=0.6 filter is not like-for-like, because it removes only one arm's long prompts.

### 3.2 Why s2 is excluded from the headline

- **Splash drifted within every arm.** Per-request ms/round on the code/long prompts, in session order:

  | session | arm | ms/round per request |
  |---|---|---|
  | s1 | splash1 | 48.1 49.2 48.9 48.7 48.4 48.3 48.4 48.5 48.3 48.5 48.8 48.7 (flat) |
  | s3 | splash1 / splash2 | 47.6–48.4 throughout |
  | s2 | splash1 | 48.4 53.7 59.6 55.5 52.4 52.9 51.9 58.9 55.7 53.0 51.7 54.4 |
  | s2 | splash2 | 52.9 54.1 53.8 55.7 54.5 53.4 53.5 55.0 58.0 55.7 53.2 53.3 |

  Each s2 Splash arm starts at s1 speed (47.4–48.4 on the short prompts) and then rises.
- **Prefill slowed in s2.** Long-prompt prefill throughput dropped 20–29% (Splash 854–935 → 667–676 tok/s; th 593–630 → 465–569).
- **Nothing else changed.** CPU idle (81–87%) and non-engine GPU time (25–40 ms/s) were the same as in s1.
- **Thermal pressure was elevated around it.** It read 1 (moderate) at 06:44–06:59 and 2 (heavy) at 07:16, and was not sampled during s1/s2. Other agents held the GPU lock back to back between my sessions.
- **Recovery before s3.** A 40–70 s GPU-idle wait brought the level back to 0 before each s3 arm. Under sustained load it climbed back to 1 within about 90 s.
- **Effect on the engines.** Splash is fully GPU-bound (idle ≤ 1.7 ms/round), so it lost 11%. th-integ lost 3%.
- **Mechanism: not measured.** s2 has no clock sampling. Candidates are th's lower average power from host gaps, or a bandwidth-bound versus compute-bound mix.

## 4. Results

### 4.1 Pooled, nominal sessions (s1 + s3): 36 requests per engine and mode (12 for ctxcold)

| engine (build) | mode | n | rounds (logged) | tok/round | ms/round | **loop tok/s** | like-for-like tok/s | client dec tok/s | TTFT mean / med ms | GPU-busy ms/round | idle ms/round |
|---|---|---|---|---|---|---|---|---|---|---|---|
| th-integ `8d5b6d5` | T=0 | 36 | 912 | 3.605 | 54.67 | **65.95** | 65.53 | 65.31 | 165 / 173 | 47.7 | 7.1 |
| th-integ | T=0.6 | 36 | 1020 | 3.208 | 58.04 | **55.27** | 55.48 | 55.22 | 166 / 174 | 48.4 | 10.0 |
| th-integ | ctx1500 | 36 | 948 | 3.506 | 70.94 | **49.43** | 48.82 | 48.67 | 2549 / 2502 | 63.8 | 7.2 |
| th-integ | ctxcold | 12 | 272 | 4.015 | 71.71 | **55.99** | 55.78 | 55.62 | 2509 / 2468 | 64.1 | 7.4 |
| th-main `cf3e5f7` | T=0 | 36 | 960 | 3.450 | 63.87 | **54.02** | 53.38 | 53.23 | 182 / 188 | 56.4 | 7.8 |
| th-main | T=0.6 | 36 | 972 | 3.391 | 65.94 | **51.42** | 51.09 | 50.92 | 182 / 190 | 56.5 | 9.3 |
| th-main | ctx1500 | 36 | 948 | 3.506 | 78.77 | **44.51** | 43.97 | 43.84 | 2451 / 2435 | 69.0 | 9.6 |
| th-main | ctxcold | 12 | 284 | 3.817 | 78.99 | **48.32** | 48.59 | 48.47 | 2380 / 2416 | 72.3 | 6.4 |
| Splash 1.0 | T=0 | 36 | 912 | 3.763 | 47.90 | **78.56** | 77.73 | 80.28 | 157 / 142 | 47.5 | 0.9 |
| Splash 1.0 | T=0.6 | 36 | 856 | 4.014 | 48.40 | **82.93** | 82.06 | 85.00 | 138 / 137 | 47.3 | 1.5 |
| Splash 1.0 | ctx1500 | 36 | 888 | 3.878 | 48.36 | **80.20** | 79.36 | 82.07 | 158 / 142 † | 48.0 | 0.7 |
| Splash 1.0 | ctxcold | 12 | 260 | 4.415 | 49.04 | **90.04** | 89.10 | 92.76 | 1732 / 1711 | 50.3 | ≈0 |

† Splash reused 1408–1440 prompt tokens from its prefix cache on every ctx1500 request, and 32–64 tokens on the bench prompts. th has no prefix cache.

**Ratios (s1 + s3):**

| mode | th-integ / Splash | like-for-like | Splash / th-integ ms/round | tok/round ratio | th-main / Splash | th-integ / th-main |
|---|---|---|---|---|---|---|
| T=0 | **0.840** | 0.843 | 0.876 | 0.958 | 0.688 | 1.221 |
| T=0.6 | **0.667** | 0.676 | 0.834 | 0.799 | 0.620 | 1.075 |
| ctx1500 | 0.616 | 0.615 | 0.682 | 0.904 | 0.555 | 1.110 |
| ctxcold | 0.622 | 0.626 | 0.684 | 0.909 | 0.537 | 1.159 |

### 4.2 Per session

| session | engine | T=0 ms/round / tok/s | T=0.6 ms/round / tok/s | ctx1500 ms/round / tok/s | ctxcold ms/round / tok/s | T=0 TTFT mean |
|---|---|---|---|---|---|---|
| s1 06:11–06:22 | th-integ | 54.73 / 65.88 | 58.74 / 54.61 ‡ | 69.92 / 50.15 | 71.49 / 56.16 | 165 |
| s1 | th-main | 64.29 / 53.67 | 65.85 / 51.49 | 78.78 / 44.51 | 79.11 / 48.25 | 183 |
| s1 | Splash | 48.13 / 78.19 | 48.46 / 82.84 | 48.33 / 80.24 | 48.92 / 90.25 | 157 |
| s3 07:22–07:38 | th-integ | 54.60 / 66.03 | 57.34 / 55.95 | 71.96 / 48.73 | 71.93 / 55.82 | 164 |
| s3 | th-main | 63.46 / 54.37 | 66.03 / 51.35 | 78.76 / 44.52 | 78.87 / 48.40 | 182 |
| s3 | Splash | 47.68 / 78.93 | 48.35 / 83.02 | 48.39 / 80.15 | 49.15 / 89.83 | 156 |
| s2 06:29–06:42 (throttled) | th-integ | 56.28 / 64.06 | 58.86 / 54.50 | 71.33 / 49.16 | 71.73 / 55.97 | 165 |
| s2 | th-main | 65.45 / 52.71 | 67.52 / 50.22 | 80.08 / 43.78 | 82.33 / 46.36 | 187 |
| s2 | Splash | 53.42 / 70.44 | 54.05 / 74.26 | 54.62 / 71.01 | 51.92 / 85.04 | 162 |

‡ s1's integ2 sampled long prompts overlapped a rustc build (§3.1). The s1 integ1 arm alone gives 56.96 ms/round and 56.31 tok/s (ratio 0.680).

- **tokens/round is identical in every session.** th-integ 3.605 / 3.208 / 3.506 / 4.015; th-main 3.450 / 3.391 / 3.506 / 3.817; Splash 3.763 / 4.014 / 3.878 / 4.415 (T=0 / T=0.6 / ctx1500 / ctxcold).
- **Outputs are deterministic.** All 90 (engine, mode, prompt, seed/iter) text sets are identical between s1 and s2, and all 54 (engine, mode, prompt, seed) sets between s1 and s3. T=0 repeats within an arm are identical.

**th per-round breakdown (s1; s3 within ±0.5 ms), mean per logged round in ms:**

| build | mode | propose | verify total | verify host encode (enqueue − propose) | verify GPU tail + readback | rest | step p10 / p50 / p90 |
|---|---|---|---|---|---|---|---|
| th-integ | T=0 | 7.9 | 45.8 | 8.1 | 37.7 | 1.0 | 53.0 / 54.4 / 56.1 |
| th-integ | T=0.6 | 9.0 | 46.8 | 8.8 | 38.2 | 2.8 | 55.4 / 57.1 / 64.0 |
| th-integ | ctx1500 | 14.5 | 54.4 | 8.3 | 46.0 | 1.1 | 68.2 / 69.5 / 71.3 |
| th-main | T=0 | 10.2 | 53.1 | 9.9 | 43.2 | 1.1 | 62.0 / 63.3 / 68.3 |
| th-main | T=0.6 | 10.2 | 52.8 | 9.9 | 43.0 | 2.7 | 64.1 / 65.4 / 67.4 |
| th-main | ctx1500 | 16.6 | 61.2 | 9.9 | 51.3 | 1.0 | 77.0 / 78.3 / 80.6 |

In s3 the sampled-minus-greedy cost is +0.3 propose, +0.5 verify and +1.6 rest: +2.4 ms from the components, +2.7 ms from ms/round.

### 4.3 Tokens/round on byte-identical greedy text

Texts are compared after `</think>` normalisation. The groups are the same in all three sessions.

| context | prompt | text sha1 (norm) | completion | th-integ rounds | th-main rounds | Splash rounds |
|---|---|---|---|---|---|---|
| bench (58–80 tok) | short | `43eabd4b648d` | 30 | 8 | 8 | 6 |
| bench | long | `fdf57afa832f` | 128 | 39 | 39 | 36 |
| ctx1500 | short | `df5669d90e80` | 31 | 7 | 7 | 7 |
| ctx1500 | code | `155e1756f2a9` | 128 | 38 | 38 | 36 |
| ctx1500 | long | `91a6e28ec79a` | 128 | 37 | 37 | 31 |
| ctxcold | short | `f2a246c5cab8` | 31 | 5 | 5 | 4 |
| ctxcold | long | `f83eaac3b479` | 128 | 29 | (text differs) | 27 |
| ctxcold | code | `df926a54dde5` | 128 | 37 | 38 | (text differs) |

- Rounds are counted as th's logged rounds + 1 (the final round) and Splash's `decode_batches`.
- **th-integ vs Splash:** 7 groups, 597 tokens, **163 vs 147 rounds**, 3.663 vs 4.061 tok/round. Splash needs 0.902× the rounds.
- **th-main vs Splash:** 6 groups, 470 tokens, 134 vs 120 rounds (0.896×).
- **th-integ vs th-main:** 7 groups, 171 vs 172 rounds.
- **Where the T=0 texts diverge:**
  - bench/code: th-integ diverges from th-main and Splash at char 105 (re-tokenized token #23): " Need produce" vs " Need provide". This is the known integration near-tie. th-main and Splash diverge later, at char 337 (#66).
  - ctxcold/code: th vs Splash at char 532 (#108).
  - ctxcold/long: th-main vs the other two at char 76 (#15).
- **Splash always drafts 7 per round:** 3192 drafted over 456 rounds at T=0.
- **th's adaptive `verify_len` (engine.rs:431 @`8d5b6d5`) cuts off correct chains.**
  - A capped chain is a `[dflash]` round with `acc == len(emitted) − 1`, `emitted[:acc] == prop[:acc]` and `emitted[acc] == prop[acc]`. The chain stopped at `verify_len`, and the next draft proposal was the target's argmax.
  - Counts: th-integ T=0 **96 of 456 rounds (21.1%)**, ctx1500 108 of 474 (22.8%), th-main T=0 108 of 480 (22.5%).
  - So "always verify 7" (L1) gains at least 1 token in each of those rounds: at least +0.21 tok/round (3.605 → ≥ 3.816, +5.8%) on this suite, before counting longer chains. That is consistent with the 9.8% round gap to Splash on identical text.

**Sampled (T=0.6) tokens/round, (comp−1)/rounds_all, per prompt × seed.** Texts differ between engines; each is deterministic per seed.

| engine | code s1 / s3 / s5 | long s1 / s3 / s5 | short s1 / s3 / s5 |
|---|---|---|---|
| th-integ | 3.85 / 3.17 / 3.85 | 2.82 / 3.43 / 2.35 | 4.83 / 3.75 / 3.62 |
| th-main | 3.43 / 3.53 / 3.73 | 2.76 / 3.85 / 3.02 | 4.14 / 3.62 / 3.22 |
| Splash | 4.23 / 4.10 / 5.08 | 3.26 / 3.53 / 3.53 | 5.00 / 5.80 / 4.83 |

- Splash is higher than th-integ on 9 of 9 pairs, and higher than th-main on 8 of 9.
- Splash's sampled accept rate (1280/2996 = 0.427) is above its greedy rate (0.391).
- The direction is consistent, but there are only 9 samples per engine. A many-seed study (R0b) should test whether th's p/q acceptance is the cause (`spec_accept_step`, engine.rs:937 @`8d5b6d5`).

### 4.4 Long context (about 1.45k tokens, T=0)

| engine | ms/round, bench → ctx1500 | Δ | where the Δ lands (th) | GPU-busy, bench → ctx1500 |
|---|---|---|---|---|
| th-integ | s1 54.73 → 69.92; s3 54.60 → 71.96 | **+15.2** (s1), +17.4 (s3; +16.3 on uncontended integ2) | propose 7.9 → 14.5; verify host encode 8.1 → 8.3 (unchanged); verify GPU tail + readback 37.7 → 46.0 | 47.8 → 59.6 (s1) |
| th-main | s1 64.29 → 78.78; s3 63.46 → 78.76 | +14.5, +15.3 | propose +6.4; GPU tail +8.1 | 56.9 → 64.8 (s1) |
| Splash 1.0 | s1 48.13 → 48.33; s3 47.68 → 48.39 | **+0.2, +0.7** | — | 47.8 → 47.9 (s1) |

- The context-dependent cost sits in GPU work in both the draft (propose ends in host syncs on its GPU work) and the target verify.
- That fits Phase B's N4 (`draft_attn` on 8 threadgroups) and N3 (`attn_decode` without a split along keys). The attribution is inferred; I did not time the kernels.
- The integration does not touch either kernel: the Δ is the same on main.
- All three ctx1500 prompts produced byte-identical text on all three engines. On that identical text th-integ runs 0.616× Splash.

### 4.5 TTFT

| prompt set | th-integ | th-main | Splash 1.0 |
|---|---|---|---|
| bench prompts, 58–80 tokens, T=0 (s1 + s3, mean / med ms) | 165 / 173 | 182 / 188 | 157 / 142 (32–64 tokens from prefix cache) |
| ctx1500, 1432–1454 tokens, passage repeated | 2549 / 2502 | 2451 / 2435 | 158 / 142 (1408–1440 tokens cached) |
| ctxcold, 1437–1459 tokens, cold | 2509 / 2468 (≈ 580 tok/s) | 2380 / 2416 | 1732 / 1711 (≈ 840 tok/s) |
| ctxcold, s1 only | 2402 / 2394 | 2329 / 2307 | 1657 / 1690 |

- **Short prompts:** T2 prefill tiles cut TTFT 9% (165 vs 182 ms).
- **About 1.45k-token prefill:** T2 does not help. Per-arm minimum TTFT is integ 2246–2461 vs main 2224–2402 ms, within about 3% (integ is not faster).
- **Cold long prefill:** th is about 1.45× slower than Splash.
- **Repeated long prefix:** Splash's prefix cache makes it about 16× faster. th has no prefix cache (T1 is not implemented).
- **Where Splash's TTFT lands:** client TTFT arrives 55–70 ms after `prefill_wall_ms` ends (server-side first token is 49–63 ms after prefill), roughly one decode round.

## 5. Bugs and anomalies found

1. **th `th_stats.prefill_tps` is timed at enqueue and overstated about 3.7×.**
   - In engine.rs:352-355 @`8d5b6d5`, `prefill_ms_total += t.elapsed()` wraps `inner.backend.forward(chunk, pos, &device)` with no GPU sync.
   - So the ctx requests report 1890–2380 tok/s while wall-clock prefill is 465–630 tok/s (prompt tokens / TTFT). main has the same code.
   - This is Phase B R0a's "sync the prefill timer", now quantified.
   - Fix: sync, or read back `last_logits`, before stopping the timer; or derive prefill_tps from TTFT.
2. **`</think>` streaming differs.** th emits `</think>` as a `content` delta; Splash drops it at the reasoning→content switch. Any byte-identity check across the engines has to strip it.
3. **th's sampled path adds +2.4–2.7 ms of host work per round** (+1.6 in `rest`).
   - The cause is the `[n+1, vocab]` bf16 `to_vec2` readback plus CPU `dist_vec` / `spec_accept_step` (engine.rs:461 and :488-527 @`8d5b6d5`).
   - The equivalent cost in Splash is +0.3–0.7 ms. This is S1 (GPU accept) territory.
4. **Thermal state is a first-order benchmark variable on this machine.**
   - After about an hour of back-to-back GPU sessions, thermal pressure rises from 0 to 1 within about 90 s of sustained decode.
   - When throttled, Splash loses 11% and th 3% (s2), which distorts th/Splash ratios by about 8%.
   - Future vs-Splash benches should gate each arm on `notifyutil -g com.apple.system.thermalpressurelevel == 0`. `session.sh` now does.

## 6. What these numbers imply (T=0, nominal) [D]

- **Host idle is 7.1 ms/round on th and 0.9 on Splash.** Removing it would put th-integ at about 47.5 ms/round, roughly equal to Splash's 47.9: D1 remainder, S1, X1/X2.
- **The rest of the T=0 gap is tokens/round.** Splash needs 9.8% fewer rounds on identical text, and at least 5.8% of that is visible as capped correct chains: L1, plus the anchor fix.
- **T=0.6:** the host sample path (+2.4–2.7 ms/round) and the acceptance gap (3.21 vs 4.01 tok/round) are each worth about 5–20%.
- **At ≥ 1.4k context:** N3 + N4 (+15–17 ms/round) dominate. Splash is context-flat at this length.

## 7. Reproduce

```sh
P=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC
Q=/Users/benebsworth/projects/token-horizon/.worktrees/bench-main/.bench-quiet
$P/bin/wt-bootstrap bench-main cf3e5f7 && (cd /Users/benebsworth/projects/token-horizon/.worktrees/bench-main/engine && cargo build --release)
$P/bin/gpu-lock -- bash $Q/session.sh $Q/s4            # arms: integ1 main1 splash1 splash2 main2 integ2 (2nd arg overrides)
PY=~/.local/share/uv/tools/headroom-ai/bin/python        # has `tokenizers` (re-tokenized divergence index)
$PY $Q/analyze.py $Q/s1,$Q/s3 md                         # pooled / per-arm / per-prompt / identity / identical-text rounds (also raw|json)
BQ_MIN_IDLE=75 $PY $Q/analyze.py $Q/s1 md                # drop CPU-contended requests
python3 $Q/conditions.py $Q/s3; python3 $Q/cpuctx.py $Q/s3; python3 $Q/headline.py $Q/s1 $Q/s3
```

All files are under `/Users/benebsworth/projects/token-horizon/.worktrees/bench-main/.bench-quiet/`. Nothing is committed; the harness is untracked in the `bench-main` worktree.
- **Harness:** `session.sh`, `bq_client.py`, `mkpassage.py`, `passage.txt`, `gpuq.py` (a copy of the baseline probe), `gpufreq.py` (IOReport GPU P-states, no root), `analyze.py`, `conditions.py`, `cpuctx.py`, `headline.py`.
- **Per session** (`s1/`, `s2/`, `s3/`): `session.out`, `runs.jsonl` (full text, deltas, `/status` deltas, GPU/CPU ms, log offsets, thermal), `*.server.log` (th `[dflash]` rounds), `*.status*.json`, `env.jsonl`, `quiet.jsonl`, `contention.jsonl`, `top.log`, `analysis.{md,json}`, `raw.md`, `conditions.md`, `cpuctx.md`. s3 also has `thermal.log` and `gpufreq.jsonl`.
- **Pooled:** `s13/analysis.md` is the headline, `s12/` and `s123/` are the other combinations, and `headline_s1s2.md` / `headline_s3.md` are summaries.
- **`smoke/`:** a pipeline check (integ + Splash, 1 iteration). `$P/bin/aggregate.py` reads the same `runs.jsonl` and gives the same loop tok/s.
