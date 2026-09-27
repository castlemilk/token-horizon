# Phase B baseline: th-engine 44aed06 vs Splash 1.0 vs live :8001 (same session)

Session 2026-09-25 AEST. Main palindrome 23:11:25–23:18:29, smoke pass 23:08:26–23:10:01.
M5 Max (40-core GPU, 128 GB), macOS 26.5.1 (25F80), AC power, `pmset -g therm`: no thermal/perf warnings.
Model: Qwen3.8-27B-4bit (`$TGT`) + DFlash draft (`$DRAFT`) for th; `incoai/Qwen3.8-27B-Splash` for Splash. Same chat-template token counts: 58/68/80 prompt tokens on both engines.

## Builds

| label | build | how it ran |
|---|---|---|
| **th-44aed06** | commit `44aed06168dc`, worktree `.worktrees/bench-base-44aed06`, 0 tracked changes. `cargo build --release` was a no-op (binary from 17:33). sha256 `9a6bad744a230bf25b09e2baa6ac2bc0494ac499ec07051caced0d102e5b1202` | `TH_DEBUG_TIMING=1 th-engine serve --model $TGT --draft $DRAFT --port 8010`, TH_BATCH unset, so the single-slot dflash loop. pid 40379 served smoke/A1. It was stopped so Splash could get its memory, then restarted as pid 95539 for A2 (same binary). |
| **live-8001** ("WT-dirty"; the task's `@17:17` label is stale) | `/Users/benebsworth/projects/token-horizon/engine/target/release/th-engine`, mtime 18:08:16, inode 87957265 (the same file as the running image), sha256 `16a6039714ca…`. It was built between 502cf15 (18:05:48) and cf3e5f7 (18:13:22); the `[batch]`/`[pb]` log lines exist in both. | pid **16917**, started 20:16:14 (the machine rebooted at 19:42:28, so pid 74910 from 17:17 is gone). Launched as `cd engine && TH_BATCH=4 TH_DEBUG_TIMING=1 nohup ./target/release/th-engine serve … --port 8001 > /tmp/th_serve_c.log`, so it runs the batched lockstep loop. All my requests ran with nb=1 (930 of 930 `[batch]` lines). I only read from it; it was not restarted. |
| **splash** | Splash 1.0 (brew, `/opt/homebrew/Cellar/splash/1.0`) | `:8000` was free, so I started it myself at 23:13:46 (`nohup splash serve --model incoai/Qwen3.8-27B-Splash`, pid 83784 plus native child 87598). Ready at 23:14:08. Stopped at 23:15:46 with SIGINT ("Stopping · releasing engine resources"). `:8000` was free again afterwards. |

## Method

- **Harness:** a copy of `scripts/bench-engines.sh` with the port as a parameter (`.bench-baseline/bench-engines-port.sh`; diff it against `bench-engines.orig.sh`). The prompts (short/code/long), `max_tokens` 128, the readline SSE `measure()` and the aggregation are unchanged. Additions:
  - explicit sampling fields in the request body;
  - per-request records written to `runs.jsonl`: full text, sha1, server-log byte offsets, Splash `/status` deltas, and per-pid ioreg `accumulatedGPUTime`. All of these probes run outside the timed window.
- **Arm order:** A1 th → C1 live → B1 splash → B2 splash → C2 live → A2 th. This is ABBA for th vs Splash, with the live build placed symmetrically.
- **Each arm:** one unrecorded warmup, then T=0.6 / top_p 0.95 / top_k 20 (3 iterations × 3 prompts), then T=0 (3 × 3). That gives 18 requests per arm and 36 per engine.
- **GPU lock:** the whole palindrome ran under one `gpu-lock` hold (flock on `/tmp/th-engine-gpu.lock`).
- **Per-round statistics:**
  - th-44aed06: from its `[dflash]`/`[verify]` lines (TH_DEBUG_TIMING).
  - live-8001: from the `[batch]` line count and client wall time.
  - Splash: from `/status` deltas (`scheduler.decode_batches`, `metrics.decode_output_tokens`/`decode_wall_ms`/`drafted_tokens`/`accepted_draft_tokens`).
  - GPU-busy ms/round: the least-squares slope of per-request engine GPU ms against rounds (18 requests per row; the intercept absorbs prefill).

## Headline (both arms pooled, ratio of sums)

| engine | mode | req | rounds | tok/round | ms/round | **loop tok/s** | client decode tok/s Σ(comp−1)/Σ(total−TTFT) | TTFT median ms | GPU-busy ms/round | stock script "decode" |
|---|---|---|---|---|---|---|---|---|---|---|
| th-44aed06 | T=0.6 | 18 | 522 logged (+18 final) | 3.149 | 100.7 | **31.3** | 30.9 | 240 | 64.8 | 38.1 |
| th-44aed06 | T=0 | 18 | 480 logged (+18 final) | 3.450 | 104.5 | **33.0** | 32.6 | 229 | 63.0 | 39.2 |
| live-8001 | T=0.6 | 18 | 486 | 3.494 | 91.5 | **38.2** | 38.2 | 211 | 69.7 | 107.9 (bogus) |
| live-8001 | T=0 | 18 | 444 | 3.824 | 94.5 | **40.5** | 40.5 | 203 | 64.1 | 93.2 (bogus) |
| splash | T=0.6 | 18 | 468 | 3.722 | 61.2 | **60.8** | 60.8 | 159 (prefix-cache hits) | 61.0 | 71.2 |
| splash | T=0 | 18 | 456 | 3.763 | 58.9 | **63.8** | 64.1 | 152 (prefix-cache hits) | 58.7 | 76.7 |

**How each row is counted:**
- **th-44aed06:** figures cover the logged `[dflash]` rounds, i.e. Σemitted/Σstep. The last round of each request is never logged (`break 'dflash` runs before the eprintln). Counting it, from the client side:
  - T=0.6: 540 rounds, 3.144 tok/round, 101.6 ms/round.
  - T=0: 498 rounds, 3.410 tok/round, 104.5 ms/round.
- **live-8001:** ms/round = client decode wall ÷ `[batch]` rounds; tok/round = Σ(comp−1) ÷ rounds.
- **splash:** from `/status` deltas. Counted from the client side, (comp−1)/rounds gives 3.684 / 3.724 tok/round and 60.6 / 58.1 ms/round.

**Ratios (loop tok/s):**

| comparison | T=0 | T=0.6 |
|---|---|---|
| Splash / th-44aed06 | 1.93× | 1.94× |
| Splash / live | 1.58× | 1.59× |
| live / th-44aed06 | 1.23× | 1.22× |

ms/round, th-44aed06 vs Splash: 1.77× at T=0, 1.65× at T=0.6.

## Per arm (drift check)

| arm | engine | mode | rounds | tok/round | ms/round | loop tok/s | TTFT mean |
|---|---|---|---|---|---|---|---|
| A1 | th-44aed06 | T=0.6 | 261 | 3.149 | 105.9 | 29.7 | 236 |
| A1 | th-44aed06 | T=0 | 240 | 3.450 | 104.1 | 33.1 | 228 |
| C1 | live-8001 | T=0.6 | 243 | 3.494 | 93.2 | 37.5 | 201 |
| C1 | live-8001 | T=0 | 222 | 3.824 | 90.9 | 42.1 | 199 |
| B1 | splash | T=0.6 | 228 | 3.838 | 63.8 | 60.2 | 176 |
| B1 | splash | T=0 | 228 | 3.763 | 59.2 | 63.6 | 145 |
| B2 | splash | T=0.6 | 240 | 3.612 | 58.8 | 61.4 | 629 (memory-governor waits) |
| B2 | splash | T=0 | 228 | 3.763 | 58.7 | 64.1 | 824 (memory-governor waits) |
| C2 | live-8001 | T=0.6 | 243 | 3.494 | 89.7 | 38.9 | 207 |
| C2 | live-8001 | T=0 | 222 | 3.824 | 98.1 | 39.0 | 197 |
| A2 | th-44aed06 | T=0.6 | 261 | 3.149 | 95.5 | 33.0 | 233 |
| A2 | th-44aed06 | T=0 | 240 | 3.450 | 104.8 | 32.9 | 238 |

Drift from the first arm to the second stays within ±10% for every engine, with no one-way trend.

**Spread across per-request repeats with identical tokens (min / median / max client ms/round):**

| engine | T=0.6 | T=0 | per-request variation |
|---|---|---|---|
| th-44aed06 | 92.3 / 98.8 / 125.1 | 79.0 / 99.6 / 131.5 | max/min up to 1.40× on the same text (e.g. A1 T=0.6 long: 92.7 / 124.7 / 114.5; A2 T=0 long: 125.6 / 109.0 / 89.4) |
| live-8001 | 74.9 / 90.1 / 97.6 | 78.1 / 91.8 / 103.0 | max/min up to 1.22× |
| splash | 42.2 / 60.0 / 66.0 | 41.0 / 57.9 / 65.4 | usually ≤1.08× on the same text; 1.25× once (B2 code#2, which hit a memory-governor wait) |

## Where the time goes

**th-44aed06, mean per logged round:**

| component | T=0.6 | T=0 |
|---|---|---|
| propose | 23.6 ms | 25.8 ms |
| snapshot + verify encode (`[verify] enqueue` 52.0 / 63.5 ms, which includes propose) | 28.4 ms | 37.7 ms |
| GPU wait + readback | 42.0 ms | 36.7 ms |
| rest (accept / commit / rollback) | 6.9 ms | 3.9 ms |

Step p10 / p50 / p90: 84.5 / 94.2 / 124.3 ms at T=0.6 and 78.8 / 94.0 / 138.3 ms at T=0.

**Acceptance per round:**

| engine | counts |
|---|---|
| th-44aed06, T=0 | acc 0:96, 1:102, 2:84, 3:54, 4:48, 5:48, 6:24, 7:24 |
| th-44aed06, T=0.6 | acc 0:126, 1:126, 2:78, 3:54, 4:60, 5:48, 6:12, 7:18 |
| Splash, T=0 | 1248 of 3192 drafted accepted (39.1%) |
| Splash, T=0.6 | 1267 of 3276 drafted accepted (38.7%) |

The adaptive `verify_len` in 44aed06 (`round(accept_ema) + 1`, clamped to 2..7; engine.rs:344) caps acceptance on some rounds. The live build and Splash always verify all 7.

**Same greedy text, rounds needed.** The "long" prompt produced identical text (sha1 `fdf57afa832f`) on all three engines, so acceptance is compared on equal output:

| engine | rounds per request |
|---|---|
| th-44aed06 | 39 |
| live-8001 | 37 |
| Splash | 36 |

**GPU-busy vs wall time per round:**

| engine | GPU-busy ms/round | wall ms/round | GPU idle per round |
|---|---|---|---|
| th-44aed06 | 63–65 | 101–105 | 36–42 ms (36–40% of the round) |
| live-8001 | 64–70 | 91–95 | 22–30 ms |
| Splash | 59–61 | 59–61 | about 0–4 ms (93–100% busy) |

Per round, th-44aed06 does only about 4 ms (6–7%) more GPU work than Splash. About 90% of the ms/round gap (39.5 ms at T=0.6, 45.6 ms at T=0) is host-side GPU idle.

## Conditions and contention

**GPU: quiet.** Before each arm, other GPU clients used 25.8–60.7 ms/s (utilisation mean 0.5–1.1%). During arms they used 26.7–43.0 ms/s, 4.3% of GPU time at most (WindowServer and ghostty).

**CPU: not quiet.** 18 cores (6 performance + 12 efficiency). The load came from sibling agents' rustc builds, the Virtualization VM, xctest, python ML jobs and a GitHub runner.

| arm | pre-check | other GPU ms/s pre / during | engine GPU ms | load 1/5/15 min | mem free | top CPU users |
|---|---|---|---|---|---|---|
| sA | 23:08:29 | 56.9 / 37.0 | 12034 | 14.8/17.3/19.3 | 51% | rustc 693%, VM 141% |
| sC | 23:08:52 | 58.9 / 38.8 | 13399 | 14.9/17.2/19.2 | 50% | VM 239%, python 111% |
| A1 | 23:11:32 | 52.3 / 42.7 | 37748 | 35.1/21.9/20.6 | 74% | VM 111%, xctest 74%, rustc 72% |
| C1 | 23:12:44 | 49.2 / 43.0 | 32755 | 49.3/29.1/23.4 | 59% | VM 244%, rustc 173%, python 161% |
| B1 | 23:14:13 | 57.8 / 39.2 | 28847 | 33.9/28.6/23.7 | 76% | VM 630%, bfs 363%, rustc 192% |
| B2 | 23:14:57 | 59.1 / 40.6 | 28640 | 29.5/28.1/23.8 | 63% | rustc 619%, bfs 244%, VM 166% |
| C2 | 23:16:24 | 25.8 / 28.0 | 35078 | 26.4/27.5/24.0 | 35% | rustc 196%, VM 186%, Runner.Worker 154% |
| A2 | 23:17:24 | 26.4 / 26.7 | 35579 | 34.2/29.0/24.8 | 52% | rustc 346% + 200% + 132% |

Swap peaked at 16.7 GB around 23:08 and was 1.7 GB by 23:16.

**th-44aed06 is host-bound and sensitive to CPU contention.** Smoke pass at load about 15 (23:08; same binary and process as A1; ITERS=1; 3 requests per mode):

| mode | ms/round | tok/round | tok/s | `[verify] enqueue` | propose |
|---|---|---|---|---|---|
| T=0.6 | 77.6 | 3.149 | 40.6 | 28.3 ms | 13.3 ms |
| T=0 | 72.9 | 3.450 | 47.3 | 28.5 ms | 12.9 ms |

In the main pass the same two figures were 52–63 ms (enqueue) and 24–26 ms (propose). Over the same interval, GPU ms per round (total ÷ rounds, prefill included) moved much less: 67.5 / 65.4 in the smoke pass vs 71.1 / 67.7 in the main pass, about 3–4 ms, against 23–32 ms of extra wall time. The spread across identical-token repeats (max/min up to 1.40×) points the same way. This comes from the timings, not a direct measurement: thread-level CPU time was not captured, because the supplementary pass that would have captured it was cancelled (below).

**Splash is slower than its earlier quiet baseline too:** 58.9–61.2 ms/round now vs 51.3 before; GPU-busy 59–61 vs 50.9 ms (the earlier GPU figure may have been measured differently). Today's absolute numbers are therefore pessimistic for every engine; the ratios are the comparable output.

**Splash memory governor:**
- The first Splash start at 23:06:33, with th-44aed06 resident, was refused: `needs 17355931648 bytes plus 13743895347 bytes protected for macOS, but only 21294497792 bytes are currently available`. That is why th-44aed06 was stopped during B1/B2.
- In B2, 7 requests found the prefix cache evicted ("cached 0"). They waited 1.2–1.7 s at admission (`Memory: growth paused; waiting=1` in `splash.log`), giving TTFT of 1.37–1.89 s.
- Decode speed was unaffected. Splash TTFT with those stalls excluded: mean 174 / median 157 ms at T=0.6, mean 157 / median 149 ms at T=0.

## Caveats (read before using these numbers)

1. **TTFT is not like-for-like.** After warmup, every Splash request had 32–64 of its 58–80 prompt tokens served from Splash's prefix cache (`splash.log` "cached 32/64"). The th engines have no prefix cache and prefill in full. th vs live TTFT is a fair comparison: median 229–240 ms vs 203–211 ms.
2. **th T=0.6 output is deterministic.** No seed is sent in the request, so the engine default seed is used, which puts the Sampler at seed max(1)=1. All 6 repetitions of each prompt gave identical text, so th's T=0.6 tok/round rests on only 3 distinct samples. Splash samples fresh each request. For tok/round across engines, use the T=0 rows, or send a per-request `seed` (th reads `body.seed`, `server.rs:187`).
3. **The stock script's `decode` number overstates throughput:**
   - th-44aed06: 38–39 reported vs 31–33 measured.
   - live-8001: 93–108 reported vs 38–41 measured (2.3–2.8×).
   - Splash: 71–77 reported vs 61–64 measured.

   For live-8001 the cause is in `batch_round`: `step_ms` is set from `t_verify` (engine.rs@502cf15/cf3e5f7 lines 1298–1299 and 1429). `t_verify` is read immediately after `forward_batch` enqueues the work, before the argmax/logits readback that actually waits for the GPU (line 1313). So `decode_ms_total` and `observe_decode` leave out the GPU wait and the accept/commit/rollback work. The "~85 tok/s" the live build reports about itself is this artifact.

   For Splash, `stream_tokens_per_second` leaves out the first emitted block.
4. **Greedy output agreement:**
   - th-44aed06 and live-8001 match on every prompt (6/6 repetitions each).
   - Splash matches th on "long".
   - On "short" the difference is only rendering: th streams a literal `</think>`, while Splash moves reasoning into `reasoning_content` and drops the tag. Both produced 30 tokens.
   - On "code" the output genuinely diverges at about char 337 (th: "User only asks write function"; Splash: "User asks write a Python function"), a numeric near-tie.
5. **Results history file:** results were written to `.bench-baseline/engine-bench.json` (via `BENCH_OUT`), not `~/.config/token-horizon/engine-bench.json`, so partial arms stay out of the app's ENGINE tab.
6. **Supplementary pass cancelled:** a second pass was planned (fresh th process, per-request seeds, per-request process CPU time) but was cancelled unrun. After waiting 12 minutes it was still queued behind about 15 other `gpu-lock` jobs, and I cancelled it before it could start a server after I returned. `supp.sh` is ready to rerun as is.

## Recommendation for later comparisons

- Measure every change as an A/B interleaved against `th-engine-44aed06` inside the same `gpu-lock` hold (ABBA).
- Compare ratios (ms/round, and T=0 tok/round and loop tok/s), not the absolute numbers above.
- Record the 1-minute load average with each run. The th host-bound loop moves by 20–35% with background CPU load (77.6 vs 100.7 ms/round at T=0.6); Splash barely moves.

## Raw per-request data (generated by aggregate.py)

### Per-request raw

| arm | engine | mode | prompt#i | p_tok | comp | ttft ms | total ms | rounds | tok/round | ms/round(int) | client ms/round | GPU ms | sha1 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 | th-44aed06 | sampled | short#1 | 58 | 30 | 214 | 910 | 7 | 3.83 | 95.6 | 99.3 | 646 | f61d81388f4a |
| A1 | th-44aed06 | sampled | short#2 | 58 | 30 | 235 | 1023 | 7 | 3.83 | 108.0 | 112.5 | 719 | f61d81388f4a |
| A1 | th-44aed06 | sampled | short#3 | 58 | 30 | 198 | 1003 | 7 | 3.83 | 99.2 | 115.1 | 635 | f61d81388f4a |
| A1 | th-44aed06 | sampled | code#1 | 68 | 128 | 253 | 4004 | 37 | 3.50 | 100.9 | 101.4 | 3053 | 7026f3107608 |
| A1 | th-44aed06 | sampled | code#2 | 68 | 128 | 248 | 3904 | 37 | 3.50 | 98.1 | 98.8 | 2907 | 7026f3107608 |
| A1 | th-44aed06 | sampled | code#3 | 68 | 128 | 234 | 4064 | 37 | 3.50 | 103.4 | 103.5 | 2686 | 7026f3107608 |
| A1 | th-44aed06 | sampled | long#1 | 80 | 128 | 252 | 4537 | 46 | 2.78 | 92.7 | 93.2 | 3356 | 9c64605e7744 |
| A1 | th-44aed06 | sampled | long#2 | 80 | 128 | 252 | 6007 | 46 | 2.78 | 124.7 | 125.1 | 3065 | 9c64605e7744 |
| A1 | th-44aed06 | sampled | long#3 | 80 | 128 | 239 | 5540 | 46 | 2.78 | 114.5 | 115.2 | 3061 | 9c64605e7744 |
| A1 | th-44aed06 | greedy | short#1 | 58 | 30 | 199 | 856 | 8 | 3.86 | 81.3 | 82.0 | 623 | f61d81388f4a |
| A1 | th-44aed06 | greedy | short#2 | 58 | 30 | 203 | 847 | 8 | 3.86 | 79.3 | 80.5 | 639 | f61d81388f4a |
| A1 | th-44aed06 | greedy | short#3 | 58 | 30 | 201 | 890 | 8 | 3.86 | 84.5 | 86.2 | 660 | f61d81388f4a |
| A1 | th-44aed06 | greedy | code#1 | 68 | 128 | 242 | 4976 | 36 | 3.54 | 132.5 | 131.5 | 2375 | 5ae613fd18ac |
| A1 | th-44aed06 | greedy | code#2 | 68 | 128 | 229 | 4140 | 36 | 3.54 | 108.8 | 108.6 | 2432 | 5ae613fd18ac |
| A1 | th-44aed06 | greedy | code#3 | 68 | 128 | 234 | 3716 | 36 | 3.54 | 95.6 | 96.7 | 2447 | 5ae613fd18ac |
| A1 | th-44aed06 | greedy | long#1 | 80 | 128 | 239 | 4173 | 39 | 3.29 | 100.6 | 100.9 | 2612 | fdf57afa832f |
| A1 | th-44aed06 | greedy | long#2 | 80 | 128 | 260 | 4137 | 39 | 3.29 | 98.1 | 99.4 | 2598 | fdf57afa832f |
| A1 | th-44aed06 | greedy | long#3 | 80 | 128 | 247 | 4280 | 39 | 3.29 | 103.5 | 103.4 | 2583 | fdf57afa832f |
| C1 | live-8001 | sampled | short#1 | 58 | 30 | 173 | 698 | 6 | 4.83 | (n/a) | 87.4 | 517 | f61d81388f4a |
| C1 | live-8001 | sampled | short#2 | 58 | 30 | 179 | 707 | 6 | 4.83 | (n/a) | 88.0 | 526 | f61d81388f4a |
| C1 | live-8001 | sampled | short#3 | 58 | 30 | 189 | 768 | 6 | 4.83 | (n/a) | 96.4 | 524 | f61d81388f4a |
| C1 | live-8001 | sampled | code#1 | 68 | 128 | 212 | 3823 | 37 | 3.43 | (n/a) | 97.6 | 2573 | e1e8d6e511c4 |
| C1 | live-8001 | sampled | code#2 | 68 | 128 | 216 | 3533 | 37 | 3.43 | (n/a) | 89.7 | 2584 | e1e8d6e511c4 |
| C1 | live-8001 | sampled | code#3 | 68 | 128 | 213 | 3733 | 37 | 3.43 | (n/a) | 95.1 | 2533 | e1e8d6e511c4 |
| C1 | live-8001 | sampled | long#1 | 80 | 128 | 210 | 3534 | 38 | 3.34 | (n/a) | 87.5 | 2586 | 3e1eddb83430 |
| C1 | live-8001 | sampled | long#2 | 80 | 128 | 207 | 3763 | 38 | 3.34 | (n/a) | 93.6 | 2552 | 3e1eddb83430 |
| C1 | live-8001 | sampled | long#3 | 80 | 128 | 210 | 3900 | 38 | 3.34 | (n/a) | 97.1 | 2524 | 3e1eddb83430 |
| C1 | live-8001 | greedy | short#1 | 58 | 30 | 174 | 643 | 6 | 4.83 | (n/a) | 78.1 | 507 | f61d81388f4a |
| C1 | live-8001 | greedy | short#2 | 58 | 30 | 177 | 668 | 6 | 4.83 | (n/a) | 81.8 | 499 | f61d81388f4a |
| C1 | live-8001 | greedy | short#3 | 58 | 30 | 178 | 659 | 6 | 4.83 | (n/a) | 80.2 | 517 | f61d81388f4a |
| C1 | live-8001 | greedy | code#1 | 68 | 128 | 203 | 2819 | 31 | 4.10 | (n/a) | 84.4 | 2119 | 5ae613fd18ac |
| C1 | live-8001 | greedy | code#2 | 68 | 128 | 207 | 2931 | 31 | 4.10 | (n/a) | 87.8 | 2108 | 5ae613fd18ac |
| C1 | live-8001 | greedy | code#3 | 68 | 128 | 204 | 3129 | 31 | 4.10 | (n/a) | 94.4 | 2078 | 5ae613fd18ac |
| C1 | live-8001 | greedy | long#1 | 80 | 128 | 218 | 3593 | 37 | 3.43 | (n/a) | 91.2 | 2473 | fdf57afa832f |
| C1 | live-8001 | greedy | long#2 | 80 | 128 | 222 | 3806 | 37 | 3.43 | (n/a) | 96.9 | 2464 | fdf57afa832f |
| C1 | live-8001 | greedy | long#3 | 80 | 128 | 204 | 3729 | 37 | 3.43 | (n/a) | 95.3 | 2444 | fdf57afa832f |
| B1 | splash | sampled | short#1 | 58 | 30 | 146 | 409 | 6 | 5.00 | 51.7 | 43.8 | 362 | 43eabd4b648d |
| B1 | splash | sampled | short#2 | 58 | 30 | 144 | 354 | 5 | 6.00 | 51.7 | 42.2 | 334 | 43eabd4b648d |
| B1 | splash | sampled | short#3 | 58 | 47 | 146 | 787 | 12 | 3.92 | 56.8 | 53.4 | 711 | 32e3f19f759f |
| B1 | splash | sampled | code#1 | 68 | 128 | 255 | 2236 | 30 | 4.27 | 66.7 | 66.0 | 2064 | a0a552279143 |
| B1 | splash | sampled | code#2 | 68 | 128 | 157 | 1840 | 27 | 4.74 | 63.3 | 62.3 | 1708 | a03b2a71b346 |
| B1 | splash | sampled | code#3 | 68 | 128 | 157 | 2383 | 34 | 3.76 | 65.9 | 65.5 | 2180 | d05e03cbc7f7 |
| B1 | splash | sampled | long#1 | 80 | 128 | 258 | 2569 | 36 | 3.56 | 65.0 | 64.2 | 2419 | 63b56e7caa1f |
| B1 | splash | sampled | long#2 | 80 | 128 | 161 | 2276 | 33 | 3.88 | 64.4 | 64.1 | 2069 | 274a38882505 |
| B1 | splash | sampled | long#3 | 80 | 128 | 155 | 3038 | 45 | 2.84 | 63.8 | 64.1 | 2800 | 2ed84bc24efc |
| B1 | splash | greedy | short#1 | 58 | 30 | 141 | 395 | 6 | 5.00 | 49.8 | 42.3 | 374 | 43eabd4b648d |
| B1 | splash | greedy | short#2 | 58 | 30 | 143 | 403 | 6 | 5.00 | 50.3 | 43.3 | 376 | 43eabd4b648d |
| B1 | splash | greedy | short#3 | 58 | 30 | 136 | 398 | 6 | 5.00 | 51.0 | 43.6 | 368 | 43eabd4b648d |
| B1 | splash | greedy | code#1 | 68 | 128 | 146 | 2274 | 34 | 3.76 | 63.2 | 62.6 | 2153 | e7d6dc3214d5 |
| B1 | splash | greedy | code#2 | 68 | 128 | 153 | 2175 | 34 | 3.76 | 60.2 | 59.5 | 2057 | e7d6dc3214d5 |
| B1 | splash | greedy | code#3 | 68 | 128 | 137 | 2223 | 34 | 3.76 | 61.5 | 61.4 | 2053 | e7d6dc3214d5 |
| B1 | splash | greedy | long#1 | 80 | 128 | 151 | 2267 | 36 | 3.56 | 59.3 | 58.8 | 2124 | fdf57afa832f |
| B1 | splash | greedy | long#2 | 80 | 128 | 149 | 2273 | 36 | 3.56 | 59.1 | 59.0 | 2119 | fdf57afa832f |
| B1 | splash | greedy | long#3 | 80 | 128 | 149 | 2198 | 36 | 3.56 | 56.7 | 56.9 | 2033 | fdf57afa832f |
| B2 | splash | sampled | short#1 | 58 | 30 | 162 | 420 | 6 | 5.00 | 50.7 | 43.0 | 379 | 43eabd4b648d |
| B2 | splash | sampled | short#2 | 58 | 30 | 153 | 423 | 6 | 5.00 | 53.4 | 45.0 | 400 | 43eabd4b648d |
| B2 | splash | sampled | short#3 | 58 | 39 | 142 | 673 | 11 | 3.55 | 52.1 | 48.2 | 624 | cde177cb1924 |
| B2 | splash | sampled | code#1 | 68 | 128 | 259 | 2121 | 29 | 4.41 | 63.8 | 64.2 | 1868 | dd3383f8e74f |
| B2 | splash | sampled | code#2 | 68 | 128 | 161 | 2127 | 33 | 3.88 | 59.9 | 59.6 | 1962 | 5380f6ec895f |
| B2 | splash | sampled | code#3 | 68 | 128 | 148 | 2079 | 32 | 4.00 | 59.8 | 60.3 | 1881 | f0c8b1de8537 |
| B2 | splash | sampled | long#1 | 80 | 128 | 1450 | 3608 | 38 | 3.37 | 57.3 | 56.8 | 2282 | acf98e68f025 |
| B2 | splash | sampled | long#2 | 80 | 128 | 1815 | 4854 | 50 | 2.56 | 59.4 | 60.8 | 2895 | 0524ee786b9c |
| B2 | splash | sampled | long#3 | 80 | 128 | 1368 | 3401 | 35 | 3.66 | 58.0 | 58.1 | 2098 | 4aca91ffba45 |
| B2 | splash | greedy | short#1 | 58 | 30 | 1444 | 1690 | 6 | 5.00 | 48.7 | 41.0 | 436 | 43eabd4b648d |
| B2 | splash | greedy | short#2 | 58 | 30 | 157 | 403 | 6 | 5.00 | 48.7 | 41.1 | 337 | 43eabd4b648d |
| B2 | splash | greedy | short#3 | 58 | 30 | 1489 | 1736 | 6 | 5.00 | 49.0 | 41.2 | 414 | 43eabd4b648d |
| B2 | splash | greedy | code#1 | 68 | 128 | 240 | 2323 | 34 | 3.76 | 61.8 | 61.3 | 2173 | e7d6dc3214d5 |
| B2 | splash | greedy | code#2 | 68 | 128 | 1891 | 3652 | 34 | 3.76 | 52.8 | 51.8 | 1903 | e7d6dc3214d5 |
| B2 | splash | greedy | code#3 | 68 | 128 | 173 | 2397 | 34 | 3.76 | 65.8 | 65.4 | 2241 | e7d6dc3214d5 |
| B2 | splash | greedy | long#1 | 80 | 128 | 1705 | 3758 | 36 | 3.56 | 56.8 | 57.0 | 2086 | fdf57afa832f |
| B2 | splash | greedy | long#2 | 80 | 128 | 173 | 2376 | 36 | 3.56 | 61.0 | 61.2 | 2089 | fdf57afa832f |
| B2 | splash | greedy | long#3 | 80 | 128 | 149 | 2263 | 36 | 3.56 | 59.1 | 58.7 | 2095 | fdf57afa832f |
| C2 | live-8001 | sampled | short#1 | 58 | 30 | 167 | 624 | 6 | 4.83 | (n/a) | 76.1 | 503 | f61d81388f4a |
| C2 | live-8001 | sampled | short#2 | 58 | 30 | 159 | 608 | 6 | 4.83 | (n/a) | 74.9 | 503 | f61d81388f4a |
| C2 | live-8001 | sampled | short#3 | 58 | 30 | 173 | 650 | 6 | 4.83 | (n/a) | 79.5 | 540 | f61d81388f4a |
| C2 | live-8001 | sampled | code#1 | 68 | 128 | 213 | 3732 | 37 | 3.43 | (n/a) | 95.1 | 3099 | e1e8d6e511c4 |
| C2 | live-8001 | sampled | code#2 | 68 | 128 | 228 | 3635 | 37 | 3.43 | (n/a) | 92.1 | 2961 | e1e8d6e511c4 |
| C2 | live-8001 | sampled | code#3 | 68 | 128 | 239 | 3587 | 37 | 3.43 | (n/a) | 90.5 | 2867 | e1e8d6e511c4 |
| C2 | live-8001 | sampled | long#1 | 80 | 128 | 236 | 3570 | 38 | 3.34 | (n/a) | 87.7 | 2814 | 3e1eddb83430 |
| C2 | live-8001 | sampled | long#2 | 80 | 128 | 230 | 3537 | 38 | 3.34 | (n/a) | 87.0 | 2781 | 3e1eddb83430 |
| C2 | live-8001 | sampled | long#3 | 80 | 128 | 222 | 3729 | 38 | 3.34 | (n/a) | 92.3 | 2743 | 3e1eddb83430 |
| C2 | live-8001 | greedy | short#1 | 58 | 30 | 180 | 676 | 6 | 4.83 | (n/a) | 82.6 | 522 | f61d81388f4a |
| C2 | live-8001 | greedy | short#2 | 58 | 30 | 178 | 679 | 6 | 4.83 | (n/a) | 83.5 | 533 | f61d81388f4a |
| C2 | live-8001 | greedy | short#3 | 58 | 30 | 179 | 679 | 6 | 4.83 | (n/a) | 83.3 | 516 | f61d81388f4a |
| C2 | live-8001 | greedy | code#1 | 68 | 128 | 210 | 3403 | 31 | 4.10 | (n/a) | 103.0 | 2172 | 5ae613fd18ac |
| C2 | live-8001 | greedy | code#2 | 68 | 128 | 200 | 3275 | 31 | 4.10 | (n/a) | 99.2 | 2150 | 5ae613fd18ac |
| C2 | live-8001 | greedy | code#3 | 68 | 128 | 207 | 3264 | 31 | 4.10 | (n/a) | 98.6 | 2135 | 5ae613fd18ac |
| C2 | live-8001 | greedy | long#1 | 80 | 128 | 207 | 3934 | 37 | 3.43 | (n/a) | 100.7 | 2546 | fdf57afa832f |
| C2 | live-8001 | greedy | long#2 | 80 | 128 | 216 | 4026 | 37 | 3.43 | (n/a) | 103.0 | 2523 | fdf57afa832f |
| C2 | live-8001 | greedy | long#3 | 80 | 128 | 195 | 3610 | 37 | 3.43 | (n/a) | 92.3 | 2538 | fdf57afa832f |
| A2 | th-44aed06 | sampled | short#1 | 58 | 30 | 234 | 881 | 7 | 3.83 | 91.1 | 92.6 | 558 | f61d81388f4a |
| A2 | th-44aed06 | sampled | short#2 | 58 | 30 | 192 | 848 | 7 | 3.83 | 87.1 | 93.7 | 584 | f61d81388f4a |
| A2 | th-44aed06 | sampled | short#3 | 58 | 30 | 210 | 902 | 7 | 3.83 | 94.8 | 98.9 | 574 | f61d81388f4a |
| A2 | th-44aed06 | sampled | code#1 | 68 | 128 | 237 | 3651 | 37 | 3.50 | 91.7 | 92.3 | 2510 | 7026f3107608 |
| A2 | th-44aed06 | sampled | code#2 | 68 | 128 | 243 | 3719 | 37 | 3.50 | 93.5 | 94.0 | 2468 | 7026f3107608 |
| A2 | th-44aed06 | sampled | code#3 | 68 | 128 | 246 | 3816 | 37 | 3.50 | 95.4 | 96.5 | 2484 | 7026f3107608 |
| A2 | th-44aed06 | sampled | long#1 | 80 | 128 | 241 | 4723 | 46 | 2.78 | 96.7 | 97.4 | 3010 | 9c64605e7744 |
| A2 | th-44aed06 | sampled | long#2 | 80 | 128 | 247 | 4649 | 46 | 2.78 | 95.7 | 95.7 | 3039 | 9c64605e7744 |
| A2 | th-44aed06 | sampled | long#3 | 80 | 128 | 249 | 4915 | 46 | 2.78 | 100.8 | 101.4 | 3021 | 9c64605e7744 |
| A2 | th-44aed06 | greedy | short#1 | 58 | 30 | 200 | 831 | 8 | 3.86 | 78.0 | 79.0 | 636 | f61d81388f4a |
| A2 | th-44aed06 | greedy | short#2 | 58 | 30 | 193 | 829 | 8 | 3.86 | 77.1 | 79.5 | 638 | f61d81388f4a |
| A2 | th-44aed06 | greedy | short#3 | 58 | 30 | 333 | 993 | 8 | 3.86 | 80.7 | 82.5 | 614 | f61d81388f4a |
| A2 | th-44aed06 | greedy | code#1 | 68 | 128 | 225 | 3963 | 36 | 3.54 | 103.7 | 103.8 | 2375 | 5ae613fd18ac |
| A2 | th-44aed06 | greedy | code#2 | 68 | 128 | 229 | 3823 | 36 | 3.54 | 100.0 | 99.9 | 2366 | 5ae613fd18ac |
| A2 | th-44aed06 | greedy | code#3 | 68 | 128 | 270 | 4480 | 36 | 3.54 | 116.2 | 116.9 | 2365 | 5ae613fd18ac |
| A2 | th-44aed06 | greedy | long#1 | 80 | 128 | 235 | 5115 | 39 | 3.29 | 125.6 | 125.1 | 2594 | fdf57afa832f |
| A2 | th-44aed06 | greedy | long#2 | 80 | 128 | 226 | 4461 | 39 | 3.29 | 109.0 | 108.6 | 2560 | fdf57afa832f |
| A2 | th-44aed06 | greedy | long#3 | 80 | 128 | 229 | 3737 | 39 | 3.29 | 89.4 | 89.9 | 2605 | fdf57afa832f |

### Greedy (T=0) output identity

- short: th-44aed06@A1: f61d81388f4a,f61d81388f4a,f61d81388f4a; live-8001@C1: f61d81388f4a,f61d81388f4a,f61d81388f4a; splash@B1: 43eabd4b648d,43eabd4b648d,43eabd4b648d; splash@B2: 43eabd4b648d,43eabd4b648d,43eabd4b648d; live-8001@C2: f61d81388f4a,f61d81388f4a,f61d81388f4a; th-44aed06@A2: f61d81388f4a,f61d81388f4a,f61d81388f4a
- code: th-44aed06@A1: 5ae613fd18ac,5ae613fd18ac,5ae613fd18ac; live-8001@C1: 5ae613fd18ac,5ae613fd18ac,5ae613fd18ac; splash@B1: e7d6dc3214d5,e7d6dc3214d5,e7d6dc3214d5; splash@B2: e7d6dc3214d5,e7d6dc3214d5,e7d6dc3214d5; live-8001@C2: 5ae613fd18ac,5ae613fd18ac,5ae613fd18ac; th-44aed06@A2: 5ae613fd18ac,5ae613fd18ac,5ae613fd18ac
- long: th-44aed06@A1: fdf57afa832f,fdf57afa832f,fdf57afa832f; live-8001@C1: fdf57afa832f,fdf57afa832f,fdf57afa832f; splash@B1: fdf57afa832f,fdf57afa832f,fdf57afa832f; splash@B2: fdf57afa832f,fdf57afa832f,fdf57afa832f; live-8001@C2: fdf57afa832f,fdf57afa832f,fdf57afa832f; th-44aed06@A2: fdf57afa832f,fdf57afa832f,fdf57afa832f

## Files and commands

All paths are under `/Users/benebsworth/projects/token-horizon/.worktrees/bench-base-44aed06/.bench-baseline/`. The scratchpad was withdrawn mid-task, so everything was moved here.

| file | contents |
|---|---|
| `baseline.md` | this report |
| `agg.md` | full aggregation |
| `runs.jsonl` | 108 per-request records |
| `smoke.jsonl` | smoke-pass records |
| `th-44aed06.log`, `th-44aed06-b.log` | th-44aed06 server logs (TH_DEBUG_TIMING) |
| `/tmp/th_serve_c.log` | live build's log (byte offsets are in `runs.jsonl`) |
| `splash.log` | Splash server log |
| `quiet.jsonl`, `contention.jsonl`, `env.jsonl` | GPU and CPU conditions per arm |
| `gpufit.json` | GPU-busy per round fits |
| `th-engine-44aed06` | APFS clone of the binary. A copy was also made at `$SP/bin/th-engine-44aed06` before the scratchpad was withdrawn. |
| `full.sh` (palindrome), `supp.sh`, `common.sh`, `bench-engines-port.sh`, `aggregate.py`, `gpuq.py`, `gpu-lock`, `lock-deadline.py` | scripts |

To reproduce:

```
cd .bench-baseline
./gpu-lock -- bash full.sh
python3 aggregate.py runs.jsonl > agg.md
```
