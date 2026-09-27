# th/d-prefix-cache: T1 prefix cache (+ T1b GQA-grouped eager attention, T1c blit-free checkpoints)

Written 2026-09-26 by the th/d-prefix-cache agent (continuation run; final). M5 Max (40-core GPU, 128 GB), Qwen3.8-27B-4bit + DFlash draft,
private port :8043, every GPU run inside `$P/bin/gpu-lock`, fresh server per arm. Tags: [M] measured, [D] derived.

- **Branch:** `th/d-prefix-cache` (worktree `/Users/benebsworth/projects/token-horizon/.worktrees/th/d-prefix-cache`), from `main` @`521c6e0`, **head `0407f89`** (21 commits, 8 files, +2410/−73). Clean tree. Not pushed.
- **Work dir:** `$P/work/th-d-prefix-cache/` — `bench/` (client `pc_client.py`, arm runner `arm.sh`, sessions `d2.sh` `d3.sh` `d5.sh`, specs `spec_a3.json` `spec_smoke.json` `spec_diag.json` `spec_edge.json`, analysis `analyze_a3.py` `analyze_d5.py` `tables_d5.py` `cmp_arms.py`), `bin/` (frozen binaries), `logs/d2/` `logs/d3/` `logs/d5/` (+ `logs/d5-fail1/`: the aborted first attempt) with runs.jsonl, server logs, `analysis_*.md`, `tables_d5.md`.
- **Binaries (`bin/`):** base `th-engine-base-521c6e0` (sha256 `66e99644…` = main); **head `th-engine-T1z-bfb8f10e` (`0407f89`, sha256 `bfb8f10e8acb0e060917e05a23a70dbfe6a24a0354834c56696c16c0e438d592` = the worktree build)**; `T1w-3299c992` (`7c2407f`, d3 + the d5 reference arms); `T1a-547c7459` (`3a3a49b`, d3 negative control); `T1c-a4d06f6a` (`c6aab3e`, d2).

## 0. Summary

- **T1 prefix cache, default on** (`TH_PREFIX_CACHE=0` off, `=grid` strict-main-identity mode, `=miss` A/B reference). A checkpoint = one slot's GDN recurrent + conv state, K/V rows and DFlash capture rows at a chunk boundary, keyed by (token prefix, prefill step, chunk history). **A hit is bit-identical to the same request's uncached prefill:** cache-on vs `=miss` 42/42 texts and 42/42 per-round `[dflash]` logs in d2 (2 arms), d3 (3 pairs) and d5 (merge-768 plan), and the head vs `7c2407f` 42/42 · 42/42 on 3 pairs through 17 hits per arm (1.4k, multi-turn, system prompt, 8k, sampled); Metal unit tests and the real-model `TH_TEST_ROLLBACK` prefix-restore gate (0 differing logits/state/K-V/verify elements, slot 0→0 and 0→1).
- **Repeated 1.4k-prefix TTFT (d5, head, load 9–19, thermal 1–2): median 162 ms, mean 156 ms (22 requests, 112–180 ms) vs main 3230 / 3280 ms in the same hold → 21×** (target ≈150–250 ms: met; Splash's quiet figure is 143 ms). By suffix length: 24 rows 112–143 ms, 34 rows 155–180, 46 rows 160–177. The previous head (`7c2407f`) measured 213 / 207 ms in the same hold, so T1b + T1c cut a hit by ~50 ms. Other hit groups: multi-turn turn 2/3 367–414 ms (10×), a shared system prompt 149–154 ms (21×), 8k exact repeat 495–550 ms (7424 cached) and 119–132 ms (7552), a different question after the same 8k document 3.6–4.1 s (6656 grid checkpoint; main 21.9–23.8 s).
- **T1b (`e45bfdc` + fix `0407f89`): GQA-grouped eager attention**, default on (`TH_ATTN_GQA=0` = old path). Every prefill chunk > 8 rows and every hit suffix went through an eager attention that broadcast K/V to all 24 q heads. Grouping the 6 q heads per KV head runs the same dot products through the same kernels: **0 differing bits on all 10 model shapes** (`TH_BENCH_ATTN` on the real function with the model's cache layouts), unit tests, and **main vs head `TH_PREFIX_CACHE=0`: 42/42 texts and 42/42 round logs** (incl. 8k prompts). Per attention layer: **4.9× at a 24-row suffix over 1432 keys (7.04 → 1.43 ms, −90 ms per forward)**, 5.8× at 12 rows, 4.1× at 46, 2.1× at 126 rows over 7550 keys (−400 ms per forward), 1.08–1.27× for 384–896-row prefill chunks (−97 ms per cold 1.45k prefill, −226 ms per 8k chunk). GPU-side 1.4k hit: 118 ms vs 185 ms with `TH_ATTN_GQA=0` (same binary, same hold).
- **T1c (`02976a4`): checkpoint copies as compute dispatches** (one 32-bit word-copy kernel per tensor instead of ~100 blits per checkpoint, each of which ended the compute encoder and waited on every live fence). Synced diag: capture 8.5–17.5 ms at 1.4k (d3: 28–50 ms), 45–60 ms at 8k (d3: 56–77), restore 3.5–5.0 ms (d3: 8–16). Bit-exact for every bit pattern (unit test); hit == miss unchanged.
- **Uncached TTFT: no regression measured.** d5 ctxcold (3 uncached ~1.45k prompts per arm): head 3241 ms (6 requests) vs main 3431 (3) vs head `=0` 3274 (3). In-process `TH_BENCH_PLAN` (GQA on): the default cache plan vs main's chunks −1.3 … +2.9% at 1.4k and +0.2% at 8k, inside the ±4% noise band (two identical plans measured 157 ms apart); with `TH_ATTN_GQA=0` the plan costs +2.6–5.1% (d2/d3: +2.7–13.9%). The merge knob (`TH_PREFIX_CACHE_MERGE`, `ec0fab2`) stays at 1024 (= `835bb44`): no merge setting beat it outside the noise, and it keeps the 8k grid checkpoint shared in both question orders.
- **Identity vs main:** bench prompts 18/18 (T=0 + seeds 1/3/5) identical in every mode; `TH_PREFIX_CACHE=0` 42/42 · 42/42 (d2; d5 incl. T1b/T1c); `=grid` 42/42 · 42/42 incl. hits (d3); default mode 34/42 texts — 8 long chat prompts diverge from token 2–68 (the plan's separate tail chunk after the block-aligned turn end; same 8 requests and positions in d2, d3 and d5, and with merge 768).
- **Two bugs found and fixed here.** (1) `7c2407f`: `21d0211` skipped the draft-ring warm-up when the first token already ended the request, which changed the next request's draft proposals vs main (d3 edge arms: pre-fix 12/12 texts but 8/12 round logs; fixed 12/12 · 12/12 at TH_BATCH=1 and 2). (2) `0407f89`: T1b fed the time-major V view that `attn_forward`'s cache cat returns straight into the gemm (Metal rejects that rhs layout); d5's first real-model forward failed on it before any measurement (`logs/d5-fail1`), fixed with a 4-head V copy, and the test gap was closed (CPU layout test + Metal test on the cache layout).
- **Cold 1.45k prefill vs Splash's 1.7 s:** quiet th 2.51 s (Phase C) vs Splash 1.71–1.94 s → 1.29–1.47×. The eager attention is ~640 ms of it [D, from the per-layer bench over main's 3 chunks]; T1b removes ~97 ms. candle's fused MLX flash attention (`candle_nn::ops::sdpa`, causal with the query offset, GQA, head_dim 256; probe in `4f9e367`) runs the prefill shapes in 1.3–3.8 ms/layer (5.4–7.4× faster than grouped, max|Δ| 0.003–0.047, **not bitwise**): ~87 ms per 1.45k prefill instead of ~545 → quiet cold ≈ 1.96 s [D]. At 8k attention dominates (512 rows over 7168 keys: 91 ms/layer grouped vs 10 ms sdpa). This is the next lever (it changes numerics vs main).
- **Gates (head):** 0 warnings at every commit; unit tests **52/52** (incl. `gqa_tests` on both cache layouts, `gqa_layout_tests`, `outbuf::tests`, `merge_limit`); `TH_TEST_ROLLBACK` **exit 0** at TH_BATCH=1 and 2; TH_BATCH=2 13/13 HTTP 200 with concurrent restores of one checkpoint, all identity checks true, errors 0; no-draft path miss == hit (d3); every server started was stopped.

## 1. Commits (`git log main..th/d-prefix-cache`, oldest first)

| sha | item | what |
|---|---|---|
| `bdccf2a` | T1 core | prefix cache: slot-state checkpoints keyed by token prefix; canonical chunk plan; LRU store; `prefill_slot` shared by the single-slot loop and batch admit; stats |
| `e7fc8b7` | T1 | key = (tokens, step, chunk history); a hit refreshes shorter matches (shared system prompt stays warm) |
| `bcce352` | T1 test mode | `TH_PREFIX_CACHE=miss`: the cache's plan, never restore/capture (A/B reference) |
| `b6f59ef` | T1 stats | `/v1/messages usage.cache_read_input_tokens` |
| `2e35b8b` | gate | `TH_TEST_ROLLBACK` probe: real-model prefix-restore bitwise gate (slot 0 and, with TH_BATCH>=2, slot 1) |
| `772696d` | T1 policy | grid checkpoint below the end checkpoint (another question after the same document); default entries 4 → 8 |
| `4bbbbf7` | diag | `TH_DEBUG_PREFILL`: synced per-phase prefill timing (off by default) |
| `21d0211` | TTFT | emit the first token before the draft-ring warm-up (both DFlash paths) |
| `af327ca` | test | grid checkpoint unit test |
| `fdf7e3e` | bench | `TH_BENCH_PLAN` probe (base grid vs cache plan vs hit, in-process alternating) |
| `c6aab3e` | T1 memory | checkpoints keep a compact copy of only the reachable capture rows |
| `d5af523` | T1 mode | `TH_PREFIX_CACHE=grid`: main's chunk plan, grid-split checkpoints only (strict main identity) |
| `4234cbc` | T1 speed | checkpoint copies into uninitialised buffers (no blit fills) |
| `835bb44` | T1 plan | cache plan keeps main's chunk count (merge the grid split before a turn-end split) |
| `3a3a49b` | probe | `TH_BENCH_ATTN`: eager prefill attention cost vs a GQA-grouped variant |
| **`7c2407f`** | fix | draft-ring warm-up also runs when a request ends at its first token (single-slot `engine.rs:790`, batch `admit` `:1818`) |
| **`e45bfdc`** | T1b | GQA-grouped eager attention: `qwen35.rs` `attn_eager` (:4021, called from `attn_forward` :4001), `TH_ATTN_GQA` (:1612, read once), `gqa_tests` (:5609); `TH_BENCH_ATTN` times the real function and counts differing bits |
| **`02976a4`** | T1c | `outbuf::copy_uninit` / `cat0_uninit` (`outbuf.rs:51` / `:72`, word-copy kernel `:104`) for capture/restore (`qwen35.rs` `state_copy_uninit` :1646); unit test `outbuf::tests` |
| **`ec0fab2`** | T1 knob | `TH_PREFIX_CACHE_MERGE` (merged-chunk row limit, default 1024, `prefix_cache.rs:35` / `:216`); `TH_BENCH_PLAN_MERGE` variants |
| **`4f9e367`** | probe/test | `TH_BENCH_ATTN` sdpa variant (probe only); `merge_limit` test simulates both sharing orders |
| **`0407f89`** | T1b fix | contiguous V in the grouped path (`qwen35.rs:4056`; the cache cat hands V over time-major); mask in q's dtype; `gqa_layout_tests` (:5678, CPU) + Metal test on the cache layout; bench uses the model's layouts |

## 2. Design

A **checkpoint** is one slot's full decode state at prompt position `pos`, captured right after the prefill chunk that ends there (`qwen35.rs` `PrefixState` :1998, `prefix_capture` :3173, `prefix_restore` :3264):

| part | how it is stored | size at pos 1408 / 7424 |
|---|---|---|
| GDN committed recurrent [48,128,128] f32 + conv window [3,10240] bf16, 48 layers | bit-exact word copy | 151 MB / 151 MB |
| attention K/V rows `0..pos`, 16 layers | an exact-size contiguous prefill tensor is shared (never written in place again); otherwise a contiguous copy (V arrives time-major) | 92 MB / 486 MB |
| DFlash capture rows `[pos-2047, pos)` (all any longer prompt's draft warm-up reads) | one compact group of fresh buffers | 72 MB / 105 MB |

**Identity by construction.** The prefill kernels are not row-count invariant (split-K tiles <= 128 rows, legacy tile above, fused kernels <= 8), so the state at `pos` depends on the chunk boundaries that produced it. Every prompt runs one deterministic **chunk plan** (`prefix_cache.rs` `plan` :166), hit or miss, and each checkpoint stores the boundaries it was computed through; a lookup (:292) accepts only a checkpoint whose history equals the new prompt's own plan up to it, so a restored request runs exactly the chunks its uncached prefill runs. Default plan: the `prefill_step` (512) grid plus `TH_PREFIX_CACHE_BLOCK`-aligned (128) splits at the first message boundary and at every chat turn end (`<|im_end|>\n` then `<|im_start|>assistant`); an off-grid split replaces the grid split just before it when the merged chunk has <= `TH_PREFIX_CACHE_MERGE` (1024) rows. Prompts shorter than one block (the three bench prompts) keep the plain grid: byte-identical to main.

Checkpoints per prompt: the aligned last turn end (multi-turn continuation, exact repeats, and — because 1427/1437/1449 all align to 1408 — different short questions after the same passage), the aligned first boundary (a long system prompt shared by different conversations), and the last surviving grid split below the end one (a different question after the same document).

- **Store:** LRU, `TH_PREFIX_CACHE_ENTRIES` (8) and `TH_PREFIX_CACHE_MB` (4096); a lookup touches every usable match; `POST /engine/kv/clear` drops all checkpoints.
- **Knobs (all read once):** `TH_PREFIX_CACHE=0|miss|grid`, `TH_PREFIX_CACHE_BLOCK` (128), `TH_PREFIX_CACHE_MARGIN` (16), `TH_PREFIX_CACHE_MERGE` (1024), `TH_ATTN_GQA` (on). Compressed-KV (`kv_quant`) slots bypass the cache.
- **Slots:** checkpoints are shared read-only across slots under `TH_BATCH>1` (restore copies the GDN state into the slot's committed parity, shares K/V, re-seeds the capture rows).
- **Stats (additive only):** `th_stats.cached_tokens`, `usage.prompt_tokens_details.cached_tokens`, `/v1/messages usage.cache_read_input_tokens`, `RequestRecord.cached_tokens`, `/status prefix_cache {enabled, plan_only, grid_only, max_entries, max_bytes, block, margin, entries, bytes, hits, misses, bypassed, reused_tokens, inserts, evictions, errors}` (`server.rs:115`, `state.rs:201`). `prefill_tps` counts forwarded tokens only.
- **TTFT reorder (`21d0211` + `7c2407f`):** the draft-ring warm-up (34–40 ms at 1.4k in d5) runs after the first token is emitted (then a sync, so round 1's timing excludes it), and also when that token ended the request. Same kernels on the same inputs.
- **Request path:** `engine.rs::prefill_slot` (:515), called from the single-slot loop (:727) and batch `admit` (:1752).

## 3. Results

### 3.1 Sessions and machine state

| session | binaries | when | content | conditions |
|---|---|---|---|---|
| d2 | `c6aab3e` | 14:43–15:27 | base1 on1 miss1 off1 on2 base2 + gates + diag + benches | thermal 1–2, load 21–71, other GPU up to 571 ms/s |
| d3 | `7c2407f` (+ `3a3a49b` control) | 16:27–17:14 | edge arms (base-e off-e old-e base-eb2 off-eb2) → base1 on1 grid1 miss1 on2 base2 → gates, diag, benches | thermal 1–2, load 54–225, other GPU mostly < 100 ms/s |
| d5-fail1 | `4f9e367` | 19:44 | unit tests 51/51, then the first real-model forward failed (T1b V layout) → abort; no measurements | — |
| **d5** | **`0407f89` (head)** + `7c2407f` + base | 20:24–21:02 (after 7652 s + 1914 s of lock waits) | unit tests → rollback probes → `TH_BENCH_ATTN` → `TH_BENCH_PLAN` → diag → base1 offx1 onw1 onx1 onx2 onw2 onm1 missm1 → TH_BATCH=2 smoke | **load 9–34, thermal 1–2**, other GPU mean 28–76 ms/s (max 369 on missm1) |

d5 arms: `base` = main, `offx` = head `TH_PREFIX_CACHE=0`, `onw` = `7c2407f` default, `onx` = head default, `onm` = head `TH_PREFIX_CACHE_MERGE=768`, `missm` = head `=miss` + merge 768. Every arm runs the identical 43-request `spec_a3.json` (warm-up, the 3 bench prompts T=0 ×3 and T=0.6/0.95/20 seeds 1/3/5, ctx1500 = the 1373-token passage + each bench prompt T=0 ×3 + 2 sampled, ctxcold = nonce + passage (uncached everywhere), multi-turn turn 2/3 on the passage, a passage-as-system-prompt pair, 8k = 28.6 KB document + 2 questions each asked twice, then `kv/clear` + ctx1500/code). Same sequence ⇒ same draft-ring history per arm (main's anchor off-by-one makes outputs depend on the previous request), so arms compare request by request. Absolute times are inflated by throttling and host load (d5 main's cold 1.45k TTFT 3.2–3.4 s vs 2.45–2.51 s quiet); ratios within a hold and the in-process probes are the reliable numbers; identity results are unaffected.

### 3.2 Repeated-prefix TTFT (client TTFT = first streamed token)

d5, mean / median per group over the group's arms (analysis: `logs/d5/analysis_d5.md`):

| request group (prompt tokens) | cached | **onx (head)** | onw (`7c2407f`) | onm (merge 768) | base (main) | offx (head `=0`) | missm | head vs main |
|---|---|---|---|---|---|---|---|---|
| ctx1500 ×9 (1432–1454), T=0 | 1408 | **154 / 161** | 205 / 207 | 151 / 158 | 3277 / 3224 | 3303 / 3239 | 3291 / 3266 | **21.3×** |
| ctx1500 sampled ×2 | 1408 | 167 / 165 | 216 / 214 | 160 / 160 | 3293 | 3337 | 3258 | 19.7× |
| multi-turn turn 2 (1545) / turn 3 (1681) | 1408 / 1536 | 367, 369 / 398, 414 | 512, 522 / 626, 728 | 371 / 429 | 3678 / 4103 | 3366 / 3705 | 3476 / 3835 | 10.1× |
| system prompt = passage, 2nd user message (1442) | 1408 | 154, 149 | 209, 212 | 162 | 3254 | 3101 | 3140 | 21.5× |
| 8k exact repeat (7550) | 7424 | 550, 495 | 828, 870 | 525 | 23442 | 21902 | 23082 | 45× |
| 8k other question (7560), grid checkpoint | 6656 | 4101, 3577 | 4084, 4009 | 3772 | 23807 | 21866 | 22732 | 6.2× |
| 8k exact repeat (7560) | 7552 | 132, 119 | 122, 123 | 124 | 25236 | 21658 | 24416 | 200× |

- **Pooled ctx1500 + ctx1500s (22 requests per binary): head median 162 ms / mean 156 ms (112–180); `7c2407f` 213 / 207; main 3230 / 3280; engine-side TTFT (th_stats) equals client TTFT within 1 ms.** Splash quiet (Phase C): 143 ms.
- **Where a d5 hit goes** (`TH_DEBUG_PREFILL`, synced phases): lookup + restore 3.5–5.0 ms; suffix forward 99–104 ms (24 rows at pos 1408), 128 ms (34), 145 ms (46), 535 ms (126 rows at 7424), 131 ms (8 rows, fused path, at 7552); client / template / sample ≈ 15–20 ms; the draft warm-up (34–37 ms) runs after the first token. d3 (`7c2407f`): restore 8–16 ms, 24-row suffix 165–183 ms.
- **The 8k "other question" hit** restores the grid checkpoint 6656 (+896 rows ≈ 3.8 s); `TH_PREFIX_CACHE=grid` restores 7168 there (d3: 2.3 s) because the merged 8k plan drops 7168 (§3.5).
- `TH_BENCH_PLAN` GPU side (d5, in-process): 1.4k hit 118 ms (+24 rows) / 193 ms (+46), 8k hit 569 ms (+126), vs main's cold prefill 3115 / 3459 / 22878 ms → 26× / 18× / 40×; grid-mode hits 938 / 1085 / 1522 ms.
- d3 (`7c2407f`, load 60–225): pooled 1.4k median 259 / mean 270 ms vs main 3347 / 3372 (12.5×); d2 (`c6aab3e`): medians 232–244 ms.
- `/status prefix_cache` after each on-arm (d5): hits 17, misses 26, inserts 17, evictions 7, errors 0, reused 41472 tokens, 2 entries / 532 MB at the end (onm: 18 inserts, 592 MB).

### 3.3 Identity (texts and per-round `[dflash]` logs, request by request)

| comparison | texts | round logs | meaning |
|---|---|---|---|
| **d5 base1 vs offx1** (head `TH_PREFIX_CACHE=0`) | **42/42** | **42/42** | T1b + T1c + knobs + warm-up fix == main, incl. 8k prompts (many eager-attention chunks) |
| **d5 onw1 vs onx1 / onx2 / onw2** | **42/42 ×3** | **42/42 ×3** | T1b + T1c bit-transparent through 17 hits and every miss per arm |
| **d5 missm1 vs onm1** (merge 768) | **42/42** | **42/42** | hit == miss for a non-default plan |
| d3 on1 vs miss1, on2 vs miss1, on1 vs on2 | 42/42 ×3 | 42/42 ×3 | hit == miss (`7c2407f`) |
| d3 base1 vs grid1, base2 vs grid1 | 42/42 ×2 | 42/42 ×2 | `TH_PREFIX_CACHE=grid` == main, hits included |
| d2 base1 vs off1; on1 vs miss1, on2 vs miss1 | 42/42; 42/42 ×2 | 42/42; 42/42 ×2 | `=0` == main; hit == miss (`c6aab3e`) |
| d3 edge arms, main vs `7c2407f` `=0`, TH_BATCH=1 / 2 | 12/12 / 12/12 | 12/12 / 12/12 | requests ending at their first token leave main's ring history |
| d3 edge arms, main vs `3a3a49b` (pre-fix) `=0` | 12/12 | **8/12** | negative control: the 4 requests after a max_tokens=1 request drafted differently |
| d5 base1 vs onx1, base1 vs onm1 (default plans) | 34/42 | 25/42 | bench prompts ×(3 T=0 + 3 seeds) and ctx1500 T=0 identical; diverging: ctx1500 sampled s3 @63, s5 @11, ctxcold code @39, long @68, multi-turn turn 3 @17, system-prompt code @2, 8k code (both) @6 (first differing token) — the separate tail chunk after the turn-end split; same in d2 and d3 |

- TH_BATCH=2 (d5 head, `pc_batch2.py`): 13/13 HTTP 200; two concurrent pairs each restored the same 1408 checkpoint into slots 0 and 1 (cached 1408 on all four); solo code miss == hit == hit-after-pairs; long miss == hit-after-pairs == hit; N2 mixed pair (T=0 + T=0.6 s5) fine; `/status` hits 8, misses 5, errors 0; hit TTFT 153–175 ms. d3: same, 13/13.
- No-draft single slot (n-gram path, d3): miss == hit == hit2 (cached 1408, TTFT 4305 → 288 / 341 ms).

### 3.4 T1b: grouped vs broadcast eager attention (d5 `TH_BENCH_ATTN`, the real `attn_eager` with the model's layouts — K head-major, V time-major; synced median of 7, one attention layer)

| seq | kv | broadcast (old) ms | **grouped (T1b)** ms | speedup | saved per forward (×16 layers) | bits differ | sdpa (probe) ms | sdpa vs grouped | max\|broadcast − sdpa\| |
|---|---|---|---|---|---|---|---|---|---|
| 12 | 1420 | 6.65 | 1.14 | 5.82× | 88 ms | 0/73728 | 1.11 | 1.03× | 0.0078 |
| 24 | 1432 | 7.04 | 1.43 | 4.92× | 90 ms | 0/147456 | 0.65 | 2.22× | 0.0029 |
| 46 | 1454 | 8.00 | 1.97 | 4.05× | 96 ms | 0/282624 | 0.80 | 2.48× | 0.0029 |
| 126 | 7550 | 48.13 | 23.12 | 2.08× | 400 ms | 0/774144 | 4.46 | 5.18× | 0.0312 |
| 384 | 1408 | 16.60 | 13.94 | 1.19× | 43 ms | 0/2359296 | 2.57 | 5.43× | 0.0156 |
| 408 | 1432 | 17.49 | 13.78 | 1.27× | 59 ms | 0/2506752 | 2.23 | 6.17× | 0.0156 |
| 512 | 512 | 7.80 | 7.21 | 1.08× | 9 ms | 0/3145728 | 1.26 | 5.74× | 0.0312 |
| 512 | 1024 | 14.82 | 13.06 | 1.13× | 28 ms | 0/3145728 | 1.97 | 6.63× | 0.0469 |
| 896 | 1408 | 30.75 | 28.50 | 1.08× | 36 ms | 0/5505024 | 3.83 | 7.44× | 0.0312 |
| 512 | 7168 | 105.46 | 91.36 | 1.15× | 226 ms | 0/3145728 | 10.02 | 9.12× | 0.0312 |

- Why it is bitwise equal: both forms are candle MLX "nn" gemms (steel tiles, 8×8 MMA accumulated in k order, no split-K), per-row reductions sized by the row length only, and element-wise mask/softmax ops on the same operand pairs; q head h = g·6 + r reads KV head g in both.

### 3.5 Uncached prefill cost

d5 `TH_BENCH_PLAN` (prompt = probe ids cycled, turn end at 1408 / 7424, one process per line, kinds alternating run by run; median (min) ms; `tables_d5.md`):

| GQA | n | main's chunks | cache plan merge 1024 (default) | merge 768 | merge 0 | hit | grid-mode hit | bitwise |
|---|---|---|---|---|---|---|---|---|
| on | 1432 | 3115 (2673) | [512,1408]: 3205 (+2.9%) | [512,1024,1408]: 2983 (−4.3%) | same plan as 768: 3140 (+0.8%) | 1408+24: 118 | 1024+408: 938 | hit==cache, ghit==base PASS |
| on | 1454 | 3459 (3327) | 3413 (−1.3%) | 3272 (−5.4%) | same plan as 768: 3517 (+1.7%) | 1408+46: 193 | 1024+430: 1085 | PASS / PASS |
| on | 7550 | 22878 (21773) | [..,6656,7424]: 22933 (+0.2%) | same plan as 1024: 22086 (−3.5%) | [..,6656,7168,7424]: 22450 (−1.9%) | 7424+126: 569 | 7168+382: 1522 | PASS / PASS |
| off | 1432 | 3391 (3295) | 3564 (+5.1%) | 3502 (+3.3%) | — | 185 | 1009 | PASS / PASS |
| off | 1454 | 3412 (3322) | 3508 (+2.8%) | 3501 (+2.6%) | — | 258 | 1084 | PASS / PASS |

- **Noise band ±4%:** the same plan measured −4.3% and +0.8% (1432), −5.4% and +1.7% (1454), +0.2% and −3.5% (8k). With GQA on, no merge setting is distinguishable from main's chunks; with it off, the cache plans cost +2.6–5.1% (d3, merged, GQA off: +6.5–13.9%; d2, unmerged: +2.7–3.3%). Per-layer costs explain why the gap closed: with GQA the merged 896-row chunk's attention is 28.5 ms/layer vs 27.0 ms for the two chunks it replaces, and it saves one weight sweep (≈90 ms).
- **Merge default kept at 1024:** `merge_limit` shows 768 opens a grid-checkpoint sharing hole (two questions after one 8k document: the 7560-token prompt keeps 7168, the 7550-token one drops it, so "7560 first" leaves 7550 without a hit); 1024 and 0 share in both orders, and 0 adds a chunk to every long miss.
- **End to end (d5 ctxcold, 3 uncached ~1.45k prompts per arm):** base 3431 (median 3498), offx 3274, onw 3242 (6), **onx 3241 (6)**, onm 3266, missm 3251 ms — no regression; arm-to-arm spread ~±150 ms.
- Captures (d5 diag): 8.5–17.5 ms each at 1.4k, 45–60 ms at 8k (V is copied out of its time-major layout); two per uncached long chat prompt.

### 3.6 Decode

Decode is untouched by construction (the restore happens before the first token; the post-prefill slot state is the uncached one bit for bit; round logs match `=miss` and main). d5 pooled loop tok/s (Σtokens/Σround-ms; ms/round; tokens/round):

| mode | base | offx | onw | **onx** | onm | missm |
|---|---|---|---|---|---|---|
| T=0 bench prompts | 64.64 (59.45, 3.843) | 62.37 | 67.51 | **65.93 (58.28, 3.843)** | 64.83 | 64.99 |
| T=0.6 bench prompts | 61.15 (58.70, 3.590) | 59.77 | 63.02 | 61.65 (58.22, 3.590) | 59.65 | 59.06 |
| ctx1500 T=0 | 57.02 (67.03, 3.822) | 54.90 | 57.16 | 55.96 (68.29, 3.822) | 54.89 | 51.05 |
| 8k | 34.63 (112.1, 3.882) | 35.27 | 39.11 | 37.83 (112.6, 4.258) | 37.97 | 37.18 |

(Spread between arms of one binary is ±3%, following host load; tokens/round are identical where the texts are.)

### 3.7 Cold ~1.45k prefill and the gap to Splash's 1.7 s

| measurement | th | note |
|---|---|---|
| Phase C quiet ctxcold TTFT (1437–1459 tok), main | 2511 ms | Splash 1944 ms (s1), 1711–1732 ms (bench-quiet s3): **gap 1.29–1.47×** |
| d5 ctxcold TTFT (load 9–19, thermal 1–2) | main 3431, head 3241 (default) / 3274 (`=0`) | inflated ~1.3× |
| d5 `TH_BENCH_PLAN` main's chunks, n=1432 ([0,512) [512,1024) [1024,1432)) | 3115 ms median (GQA on), 3391 (GQA off) | separate processes; the difference is inside the noise band |
| d5 eager attention of those 3 chunks (§3.4, ×16 layers) | broadcast 642 ms → grouped 545 ms → sdpa 87 ms | [D] sum of 512:512 + 512:1024 + 408:1432 |
| d5 synced chunks (diag, head miss) | [0,512) 940–1183 ms, [512,1408) 2011–2175 ms, [1408,1432) 111–171 ms | |

- [D] Quiet th ≈ 2.51 s; T1b takes ~0.1 s of eager attention off it (→ ≈ 2.41 s); the remaining ~0.7 s gap to Splash's 1.71 s is ~0.46 s of unfused attention (grouped 545 ms vs a fused flash kernel's ~87 ms) plus the Q4 prefill GEMM rate (d2: 473–475 tok/s at m=512/1024, one big chunk is not faster). A fused causal flash attention (candle's `sdpa` or a Splash-style kernel) would bring quiet cold 1.45k to ≈ 1.96 s and cut 8k prefill roughly in half (512 rows over 7168 keys: 91 → 10 ms/layer), at the price of numerics that differ from main (max|Δ| 0.003–0.047 per element).

## 4. Gates

| gate | result |
|---|---|
| V-build (`cargo build --release`) | 0 warnings, 0 errors at every commit |
| unit tests (`cargo test --release`) | **head 52/52** (incl. `qwen35::gqa_tests::grouped_attention_is_bitwise_equal_to_broadcast` on contiguous and time-major V, `qwen35::gqa_layout_tests` (CPU), `outbuf::tests::copies_are_bit_exact`, `prefix_cache::tests::merge_limit`, the 2 Metal `prefix_tests`, 3 `gdn_parity_tests`); d3 48/48; d2 47/47 |
| `TH_TEST_ROLLBACK=1` probe, TH_BATCH=1 (head) | **exit 0**: rollback state-bitwise PASS; prefix restore at 16 slot0→slot0 logits/state/verify/checkpoint ≠ 0/0/0/0 PASS; logits rollback test PASS (worst \|Δ\| 0.125 at kept=1, refwd 0, argmax 68/68/68) |
| `TH_TEST_ROLLBACK=1` probe, TH_BATCH=2 (head) | **exit 0**: + slot isolation true/true, prefix restore slot0→slot1 0/0/0/0 PASS |
| end-to-end hit == miss | d5: missm1 vs onm1 42/42 · 42/42, onw vs onx 42/42 · 42/42 ×3; d3 and d2: 42/42 · 42/42 on every pair |
| T=0 identity vs main (3 bench prompts + long-context arms) | `=0` 42/42 · 42/42 (d5 head); `=grid` 42/42 · 42/42 (d3); default: bench prompts 18/18, long chat prompts 34/42 by design (§3.3) |
| sampled pass (seeds 1, 3, 5) | 9 bench + 2 ctx1500 sampled requests per arm: identical across on / miss / main / `=0` wherever the plan matches (§3.3) |
| TH_BATCH=2 smoke | d5 head: 13/13 HTTP 200, identity checks true, errors 0, panics 0 |
| no-draft (n-gram path) | d3: miss == hit == hit2, cached 1408 |
| `/status`, `th_stats` | additive only (`prefix_cache`; `cached_tokens`, `prompt_tokens_details`, `cache_read_input_tokens`) |
| processes | every server started was stopped (arm.sh / d5.sh kill their own PID); listeners after d5: :8001 (Codex), :8090, :8091 — none ours |

## 5. Notes, limits, next

- **Default mode changes long-prompt numerics vs main** (a separate tail chunk after the block-aligned turn end); hits are bit-identical to the same server's misses. `TH_PREFIX_CACHE=grid` = strict main identity with ~6× slower 1.4k hits than default (938 ms vs 118 ms GPU side).
- **Checkpoint granularity:** block 128 → a hit's suffix is up to ~127 + generation-prompt rows (24–46 at 1.4k; 126 on the 8k short question). Memory ~315 MB per 1.4k checkpoint, ~740 MB per 8k one; up to two per uncached long prompt; the 4096 MiB cap holds ~5 8k checkpoints.
- **Next levers (measured here):** (1) fused causal flash attention for prefill chunks (§3.4/§3.7: 5.4–9.1× per layer over grouped for 384–896-row chunks; cold 1.45k ≈ −0.46 s, 8k ≈ −50%; not bitwise); (2) the Q4 prefill GEMM rate; (3) `clear_kv_cache` still zero-fills the GDN state with blit `Tensor::zeros` twice per single-slot request (`set_kv_quant` + `clear_kv_cache`) — the encoder-switch cost T1c removed from checkpoints, and a hit overwrites that state anyway; (4) an end-of-prompt checkpoint with the stored last logits would make exact repeats restore-only.
- **Anchor off-by-one** (known, not fixed here): ring slot `n_prompt` is attended before it is committed, so outputs depend on the previous request in the slot; `7c2407f` keeps that history identical to main's. `th/c-loop-anchor` @`68f3423` fixes the off-by-one itself.
- Not done: capture after a completed request (post-decode state is not bit-identical to a prefill of the same tokens → would break hit == miss); Splash was not re-run (its figures are Phase C's quiet ones).
