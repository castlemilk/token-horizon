# th/e-ttft-regression: cold-TTFT regression removed, restore-only exact repeats, zero-copy checkpoints

Written 2026-09-27 by the th/e-ttft-regression agent (first run 09:00–13:20, continuation 14:12–18:10). M5 Max (40-core
GPU, 128 GB), Qwen3.8-27B-4bit + DFlash draft, private port :8052, every GPU run inside `$P/bin/gpu-lock`, fresh
server per arm. Tags: [M] measured, [D] derived, [E] estimate. `P=.worktrees/_phaseC`, `W=$P/work/th-e-ttft-regression`.

- **Branch** `th/e-ttft-regression`, worktree `/Users/benebsworth/projects/token-horizon/.worktrees/th/e-ttft-regression`,
  from `main` @`e452a7b`, **head `0a87c22`** (10 commits, 8 files, +1862/−195: engine.rs, main.rs, model.rs, outbuf.rs,
  prefix_cache.rs, qwen35.rs, server.rs, state.rs). Clean tree. Not pushed; nothing committed to main; the main working
  tree, :8001 (pid 78860) and :8000 were never touched.
- **Binaries** (`$W/bin/`, sha256 prefix): base = main `e452a7b` `th-engine-base-e452a7b` `eb3497fbb194857e`; old main
  `521c6e0` `th-engine-old-521c6e0` `66e99644402995638d92`; prev = the first run's head `25dab25`
  `th-engine-final-25dab25` `74247002a7332112`; **final `0a87c22` `th-engine-final-0a87c22` `c5dcb15661c95869`**
  (tests `th-engine-tests-final-0a87c22` `298e45f7d7611653`). No build embeds a git sha; each frozen binary is a copy of
  the worktree build at that commit.

## 0. Summary

1. **All four items landed; item 4 is opt-in.** (1) anchor fix cherry-picked and kept (neutral within CI); the
   KV-capacity prefill rebuilt without the blit zero fill and the per-chunk `cat` + copy (so `TH_KV_CAP_PREFILL`
   stays on); (2) checkpoint captures deferred past the first token, clear/restore allocation-free, checkpoints
   **view** the slot's K/V instead of copying it, K/V capacity reserved once per prefill; (3) prompt-end checkpoint
   with the last logits: an exact repeat runs no forward; (4) assistant-start split + checkpoint, **default off**
   (turn 2 −55 ms, but it adds a chunk to every cold chat prompt). Extra: no lm_head on non-final prefill chunks.
2. **Cold 1.45k TTFT: below old main 521c6e0 and below integration-3** [M]:
   - session D (one hold, 12-arm interleave base/prev/old x 4, 6 back-to-back cold prompts per arm = 24 per engine):
     **prev 2427 mean / 2477 median vs base 2551 / 2565: paired −123 ms, 95 % CI [−179, −74]**; vs old 3091 / 3063
     (paired −664 [−919, −417], inflated by two old arms whose host enqueue ran +300 ms; old's two clean arms → **−110
     to −137 ms**). Session B (first run): 2446 / 2453 vs old 2606 / 2596 (−160 / −143) vs base median 2579.
   - **final 0a87c22 = prev on the TTFT path** (session E, 6 cold 1.45k per engine): 2603 / 2632 vs prev 2650 / 2622
     (paired −46 [−216, +115]) vs base 3135 / 3097 (−531 [−858, −217]); cold 1.44k chat turn (mt1): 2415 vs 2480 vs
     3356. Target "faster than 521c6e0": met.
3. **Exact repeats are restore-only** [M]: **1.4k repeat 13–16 ms engine** (base 156–189: it re-prefills 52 rows);
   **7.9k repeat 19–34 ms** (base 611–675; target ≤ 200 ms: met ~7x); E4: of a 7.5k full hit's 20.6–22.1 ms engine
   TTFT, the cache lookup + restore is 1.6–2.2 ms (synced), the rest is per-request host work (template, tokenizer,
   clears, first sample).
4. **Partial hits / long prompts** [M, final, session E]: other question after the 1.4k passage 93 ms (base 120);
   multi-turn turn 2 / 3: 304 / 326 ms (base 378 / 417); other question after the 8k document 397 ms (base 562);
   **cold 7.9k 20.4 s median (base 22.3, prev 23.5; 4 each, thermal-confounded)**; session D back-to-back: prev 18.5–18.7
   s vs base 20.0–20.2 s (−7.5 %).
5. **Cost moved, not removed** — the deferred checkpoint build sits between the 1st and 2nd streamed token. First-token
   gap, final vs base (session E, paired): cold 1.45k **+5 ms [−4, +15]**, exact repeats −9 / +2, partial hits −1 / +2,
   multi-turn ±4, **cold 7.9k +62 ms [+32, +90]** (+46 ms in the build + warm-up phase after subtracting round 1 — the
   synced build alone is 14.5 ms at 7.5k, the rest unattributed — and the remainder round-1 thermal); the build is GDN
   copies + capture rows (the zero-copy K/V change did not move the gap measurably).
6. **Decode unchanged** [M]: final 42.82 ms/round vs prev 43.11 (0.993, interleaved arms, same tokens/round) vs the
   clean base arm 43.18; session B prev 41.02 vs base 41.02 (1.000). T=0 bench prompts × 3, ratio of sums.
7. **Identity** [M]: final vs prev **bit-identical everywhere measured** (session E: 23/23 texts · 23/23 per-round logs
   on the TTFT suite; every gate output: spec_a3 on / miss / off / legacy 42/42 · 42/42 each, TH_BATCH=2 35/35, TH_BATCH=4
   19/19, no-draft 9/9, kv-quant 4/4). Hit == miss 42/42 · 42/42; the three new A/B arms (`TH_KV_CAP_PREFILL=legacy`,
   `TH_PREFIX_CACHE_KV=copy`, `TH_KV_RESERVE=0`) == default 42/42 · 42/42 each; prefill logits 0 of 248,320 bits differ
   across every KV store / head / capture mode. The anchor fix is the only numerics change vs integration-3 (decode
   only; first divergence token 2–114, median 36 over 20 of 42 streams).
8. **Gates on the final binary: all pass** (§5): 85/85 unit tests; `TH_TEST_ROLLBACK` rc 0 x3, `TH_GDN_COMMIT=step` rc
   1 as designed; TH_BATCH=2 35/35 HTTP 200 + samplecheck 293 rounds / 0 mismatches; TH_BATCH=4 19/19 + kv/clear;
   kv-quant 4/4; `/status` / `th_stats` only gain keys; 0 warnings at every commit.
9. **Withdrawn from the first run's report:** "tokenisation is the 8k full-hit floor" (session A's 121–125 ms ran at
   load1 up to 166; back-to-back the 7.9k full hit is 19–34 ms) and the "+313 ms first-token gap on the 8k partial hit"
   as a code cost (session B's 3 s idle gaps let the compressor page the engine out; back-to-back +7 ms). The zero-copy
   K/V change (this run) was motivated by the latter; measured, it is latency-neutral (§3.4) and saves memory (§2.2).

## 1. Commits (`git log e452a7b..th/e-ttft-regression`, oldest first)

| sha | item | what | default / knob (read once) |
|---|---|---|---|
| `ff1157b` | 1 anchor | cherry-pick of th/c-loop-anchor `68f3423`: `pos` stays = committed KV count after the prefill anchor (single-slot DFlash loop and batch `admit`, engine.rs) | on |
| `d67ed72` | 1 KV cap | `KvCap::Direct` prefill store (`kv_store_direct` qwen35.rs:4646): the chunk's rows are written in place into the capacity buffer, attention reads views; a new buffer is uninitialised and only its tail is zeroed, by one compute dispatch (`outbuf::zero_rows` outbuf.rs:108) | Direct; `TH_KV_CAP_PREFILL=legacy` / `=0` |
| `182397f` | TTFT extra | non-final prefill chunks skip the final norm + lm_head (`forward_nohead` qwen35.rs:4794) | on; `TH_PREFILL_HEAD=1` |
| `7a87d26` | 2 | holds during the prefill, one build after the first token (`prefix_hold` qwen35.rs:3452, `prefix_build` :3487; engine.rs `PendingCaptures` :528, `finish_captures` :728); allocation-free clear (`outbuf::zero_all` :159, a shared zero-row K/V pair) and restore (`outbuf::copy_into` :174) | deferred; `TH_PREFIX_CACHE_DEFER=0` |
| `1446cc9` | 3 | prompt-end ("full") checkpoint with the last f32 logits; an exact repeat restores it and runs no forward (`ChunkPlan::history_at` prefix_cache.rs:196, `lookup` :400); `/status prefix_cache.full`, `.full_hits` | on; `TH_PREFIX_CACHE_FULL=0` |
| `6e839b7` | 4 | split + checkpoint at assistant-message starts (`assistant_starts` prefix_cache.rs:168, `plan_with` :229); `/status prefix_cache.asst` | **off**; `TH_PREFIX_CACHE_ASST=1` |
| `25dab25` | probes | `TH_BENCH_TTFT` (main.rs `bench_ttft` :909), `TH_BENCH_ALLOC` (outbuf.rs `bench_alloc` :196) | probes only |
| `5c40234` | 2 | checkpoints **view** the slot's K/V buffer (no K/V copy in the build); `outbuf::copy_rows` (:133: rows 0..r of a tensor or a dim-1 view, one strided compute copy); K/V growth in `kv_store_direct` and `ensure_kv` (qwen35.rs:4685) copies straight from a restored view (no temporary), pad zeroed by compute (no blit, no `cat`) | on; `TH_PREFIX_CACHE_KV=copy`; `=legacy` also restores `ensure_kv`'s blit pad + cat |
| `803bd53` | 2 | K/V capacity **reserved once per prefill** (`kv_reserve` qwen35.rs:3728, engine.rs `prefill_slot` :556, `KV_RESERVE_MAX_EXTRA` :542): `max(n + min(max_tokens, 2048) + 16, 2048)` rows in 256-row blocks before the first chunk; a full hit reserves with the deferred build (skipped when the first token ends the request); `ModelBackend::kv_reserve` (model.rs:317) | on; `TH_KV_RESERVE=0` |
| `0a87c22` | 2 | view policy `ck_kv_view_ok` (qwen35.rs:1828): view while the pinned extra ≤ max(1/3 of the exact bytes, 48 MiB), else copy the exact rows | on (`=copy` forces copy) |

- 0 warnings, 0 errors at every commit (`cargo build --release` + `cargo test --release --no-run`). New knobs are
  `OnceLock` reads (or `PrefixCacheConfig::from_env` at load); no per-call env reads.
- No `MetalStorage::new(buffer.clone())`. New buffers are `Tensor::empty` fully written before any read, or compute-zeroed;
  in-place writes only go to buffers a slot owns (its GDN parities; its K/V rows at or past `kv_tokens`), never to a
  row a checkpoint holds.
- Unit tests 85 (+1 ignored). New: `copy_rows_is_bit_exact_and_bounded` (outbuf.rs:603), `kv_reserve_keeps_rows_and_results`
  (qwen35.rs:6129), `ck_kv_view_policy` (:6099), `prefix_build_deferred_matches_immediate_captures` (:6009, now also: every
  checkpoint views the live K/V buffer and stays bit-exact while the live slot's verify appends in place),
  `full_checkpoint_serves_exact_repeats_only` (prefix_cache.rs:637), `assistant_start_splits` (:680),
  `shared_parts_count_once` (:712).

## 2. Design

### 2.1 Items 1–3 and the head skip

- **Anchor fix** (`ff1157b`): decode positions only (RoPE −1 on generated tokens, row `n_prompt` written by the first
  verify, draft ring slot `n_prompt` committed); prefill logits unchanged.
- **Direct KV store** (`d67ed72`): integration-3 did, per chunk and attention layer, a `cat` of the whole prefix plus,
  on growth, two blit `Tensor::zeros` (each ends candle's compute encoder and waits on every live fence) and a copy of the
  `cat`. Now in-place rows + views (same values, layouts, kernels → bitwise). The unwritten tail must stay finite
  whatever the anchor (N3's split tile multiplies whole 32-key V pages by masked zero probabilities; a recycled buffer can
  hold `-inf`), so "drop the zero fill" became "zero only the tail, by one compute dispatch".
- **No head on non-final chunks** (`182397f`): ≈1.5–2 ms per skipped chunk [E] (2 chunks at 1.45k, 15 at 7.9k).
- **Deferred captures** (`7a87d26`): the prefill only holds GDN state — a copy when a later chunk overwrites its parity
  (for a 1.45k chat prompt the 512 grid checkpoint: one copy of 96 buffers / 151 MB on the TTFT path), else just the
  parity + content id; the build runs after the first token, before the draft warm-up (drains the capture rows) and the
  first decode forward (rewrites a held parity); a stale parity fails the build (tested). The clear that ran twice per
  request with ≈256 blit encoders now zeroes in place (host 6–11 → 0.4–0.8 ms).
- **Full checkpoint** (`1446cc9`): key = splits + n, so it serves an identical prompt (or a longer one whose plan splits
  there); a hit samples the first token from the stored logits with the request's own sampler (bit-identical).

### 2.2 Zero-copy K/V checkpoints, one-shot reservation, view policy (`5c40234`, `803bd53`, `0a87c22`)

- **Why a checkpoint may view the live K/V buffer:** rows below `kv_tokens` are never written again — decode appends at
  `kv_tokens` (≥ n ≥ every checkpoint position; `rollback_verify` only lowers it to a committed count ≥ n); growth copies
  into a new buffer; clear / restore / snapshot-restore replace the tensor. A slot that restores the view holds exactly
  `pos` rows, so its first write grows into its own buffer (`copy_rows` straight from the view). Concurrent slots only
  read the shared rows.
- **Why reserve:** the store's own `max(2·need, 2048)` rule grew a 7.9k prompt 2048 → 5120 → 11264 rows mid-prefill;
  after a restore it sized the buffer at twice the prompt (a view would pin 2x); a full hit's first verify doubled the
  restored rows. Capacity never changes numerics (N3's split plan depends on the visible keys; capacity stays
  page-aligned) — gated: `TH_KV_RESERVE=0` == default 42/42 · 42/42.
- **View policy:** a view pins the whole buffer; with the 2048-row floor a 128-token prompt would pin 16x its rows.
  `ck_kv_view_ok` views while the extra ≤ max(1/3, 48 MiB): 1.45k (+39 MB [D]; measured: spec_a3's end state, 3 entries,
  670.9 MB viewed vs 631.2 MB with `TH_PREFIX_CACHE_KV=copy`) and 8k (+17 MB) view; 600 tokens (+95 MB) or 1.45k at
  `max_tokens` 2048 (+139 MB) copy.
- **K/V work per request, 25dab25 → 0a87c22** [D; Qwen3.8-27B K+V = 64 KiB per row over 16 layers]:

| request | 25dab25 | 0a87c22 |
|---|---|---|
| cold 1.45k | 2048-row buffer allocated in chunk 1; the build copies 1459 rows (95 MB fresh) after token 1 | the same buffer, reserved before chunk 1; the build views it |
| cold 7.9k | growth 2048 → 5120 → 11264 rows (1.21 GB allocated, 7168 rows copied) mid-prefill; the build copies 7940 rows (0.52 GB) | one 8192-row reserve (0.54 GB); the build views it |
| 8k partial hit (7808 restored) | the view made contiguous (0.51 GB temporary), copied into a 15872-row buffer (1.04 GB); the build copies 7917 rows (0.52 GB) | 8192-row reserve, rows copied straight from the view; the build views it |
| 8k full hit | the first verify doubles the restored rows: blit pad + `cat` into 16128 rows (1.06 GB) | 8192-row reserve after token 1 (compute copy + compute zero) |

- **Measured effect** (§3.2–3.4): outputs bit-identical, TTFT and first-token gap equal to 25dab25 within noise on every
  class (the build's cost is its GDN copies, not the K/V copy); at cold 7.9k all 4 paired requests were faster than
  25dab25 (−0.5 to −5.6 s, and one 25dab25 request stalled 90.6 s paging) — consistent with 0.5–1.5 GB less allocation
  per 8k request (full hit −0.52, cold −1.19, partial hit −1.53 GB [D]) under 42–58 GB of swap, not conclusive. Kept on for the memory; droppable as a unit (the top three
  commits) or at runtime (`TH_PREFIX_CACHE_KV=copy TH_KV_RESERVE=0`).

### 2.3 Item 4 — assistant-start split (`6e839b7`, default off)

`TH_PREFIX_CACHE_ASST=1` adds a split + checkpoint at every `<|im_start|>assistant\n`: the next turn restores the previous
prompt's generation-prompt start (1446 of 1448) instead of the block-aligned turn end (1408). Price: one more ~2-row
chunk (a full weight sweep, ≈ one decode step, ≈30 ms [E]) on every cold chat prompt. "Checkpoint every N rows near the
end" has the same cost structure: a checkpoint must be a chunk boundary of both the caching and the reusing request's
plan (hit == miss is bitwise because the restored request runs its own remaining chunks), so every extra near-end
checkpoint is an extra small chunk on every cold prompt; not implemented.

## 3. Results

### 3.1 Sessions and machine state

| session | binary | when | content | conditions |
|---|---|---|---|---|
| A (`logs/sA`) | wip2 (≈25dab25 minus the anchor fix) | 11:00–11:27 | unit tests; in-process probe; spec_a3 on/miss; anchor acceptance | load1 15–166, thermal 1–2 |
| B (`logs/sB`) | wip3a (= 25dab25 server path) | 11:27–13:08 | TTFT palindrome base/new/old/old/new/base (per-request gate + 3 s idle); gates | load1 11–148, thermal 0–2, swap 33–39 GB |
| D (`logs/sD`) | prev 25dab25 | 14:32–15:14 | c: cold-1.45k 12-arm interleave; r: back-to-back repeats; probe | load1 15–31, thermal 0 (24/72 cold requests at 1), swap 37.6 GB, other GPU clients 130–410 ms/s |
| **E** (`logs/sE`) | **final 0a87c22** | **16:47–17:53** | E0 unit tests; E1 TTFT/decode palindrome base/prev/new/new/prev/base; E2 gates (`gates/gates_e.sh`); E3 item 4; E4 8k phase split | **load1 13–28, thermal 0–1 at request start (hold began at 2; arm gates 21–166 s), swap 42–58 GB, other GPU clients 10–433 ms/s (median 170–190); prev_5 and base_6 ended their arms with 0.12 / 0.30 GB of a ~19 GB engine resident (paged out)** |

### 3.2 Cold TTFT

**Session D, part c** (`logs/sD/c`, `gates/cold_an.py`; client TTFT = first streamed token; enqueue = prompt /
`th_stats.prefill_tps`; rest = engine TTFT − enqueue):

| engine (4 arms x 6) | TTFT mean / median / min ms | arm means | enqueue median | rest median | load1 median |
|---|---|---|---|---|---|
| prev 25dab25 | **2427 / 2477 / 2085** | 2512 2377 2422 2397 | 630 | 1836 | 15.9 |
| base e452a7b | 2551 / 2565 / 2119 | 2764 2434 2554 2451 | 731 | 1829 | 18.2 |
| old 521c6e0 | 3091 / 3063 / 2270 | 2590 **3696 3541** 2538 | 803 | 2236 | 17.3 |

- Arms `base_1 new_2 old_3 new_4 base_5 old_6 | old_7 base_8 new_9 old_10 new_11 base_12`, arm gate thermal 0 held 20 s.
- **prev − base −123 ms mean / −98 median, paired 95 % CI [−179, −74]** (same arm index + request position, n = 24,
  bootstrap 10k). Host enqueue −101 ms median.
- prev − old −664 [−919, −417] with all arms; old_6 / old_7 ran every request with host enqueue 830–1071 ms vs 664–775 in
  old_3 / old_10 (thermal 0–1, other GPU 167–234 ms/s vs neighbours' 137–188; host-side, cause unidentified). Old's
  clean arms 2590 / 2538 → **−110 (2 paired arms) to −137 ms**.
- Position matters (first cold request of an arm ≈ 2.1 s, requests 3–6 ≈ 2.5–2.6 s, every engine) → position pairing.
- Session B (first run): prev 2446 / 2453 (min 2345) vs old 2606 / 2596 vs base median 2579.

**Session E, E1 — final vs prev vs base** (`logs/sE/t`, `gates/e_an.py`; arms `base_1 prev_2 new_3 new_4 prev_5 base_6`;
spec_e: dec 3x3, cold 1.45k x3 (two nonce'd), exact repeat x2, other question, multi-turn 1–3, cold 7.9k, 8k exact
repeat x2, 8k other question, nonce'd cold 7.9k; back-to-back, 1 s idle, thermal-0 gate (≤ 120 s) before each cold 8k):

| class (cached, final) | final mean / med (n) | prev | base | final − prev, paired [95 % CI] | final − base, paired [95 % CI] |
|---|---|---|---|---|---|
| cold 1.45k (0) | **2603 / 2632** (6) | 2650 / 2622 | 3135 / 3097 | −46 [−216, +115] | **−531 [−858, −217]** |
| multi-turn 1 = cold 1.44k chat (0) | 2415 (2) | 2480 | 3356 | −66 [−86, −45] | −941 [−1417, −465] |
| exact repeat 1.4k (1460, full) | **14 / 14** (4) | 15 / 14 | 173 / 174 | −1 [−2, +1] | **−159 [−175, −143]** |
| other question 1.4k (1408) | 93 (2) | 92 | 120 | +1 [−5, +6] | −27 [−33, −21] |
| multi-turn 2 (1408) | 304 (2) | 316 | 378 | −12 [−28, +3] | −75 [−121, −29] |
| multi-turn 3 (1536) | 326 (2) | 336 | 417 | −9 [−35, +16] | −90 [−156, −25] |
| cold 7.9k (0) | **20430 / 20456** (4) | 39294 / 23516 | 22317 / 22298 | 4/4 pairs faster (−497, −936, −5624, −68401) | −1887 [−4494, +728] |
| exact repeat 7.9k (7940, full) | **26 / 26** (4) | 27 / 27 | 656 / 653 | −1 [−7, +5] | **−630 [−638, −619]** |
| other question 8k (7808) | 397 (2) | 417 | 562 | −21 [−46, +5] | −165 [−176, −155] |
| short prompts (dec, 58–80 tokens) | 143 / 148 (18) | 146 / 151 | 165 / 161 | −3 [−8, +2] | −22 [−33, −12] |

- Cold 7.9k: 3 of the 6 gated second cold 7.9k requests started at thermal 1 after the 120 s gate cap (prev_2 25.8 s,
  new_3 20.2 s, prev_5 90.6 s — prev_5's engine was paged out by the end of its arm, RSS 0.12 GB).
- base's cold 1.45k is slow in E (base_6 3.4–3.8 s ran under 408–433 ms/s of other GPU clients, load1 25); session D's
  interleave is the base comparison to quote (−123 ms); E establishes final = prev.

### 3.3 Exact repeats, partial hits (session D, part r, back-to-back, prev binary)

| request (prompt tokens) | prev (cached) | base (cached) | Δ |
|---|---|---|---|
| cold 1.45k (1460) | 2218, 2231 (0) | 2245, 2224 (0) | −10 |
| exact repeat 1.4k x2 | **13, 14, 14, 15** (1460, full) | 157, 159, 160, 162 (1408) | **−145 (11x)** |
| other question, 1.4k (1438) | 87, 88 (1408) | 107, 109 (1408) | −20 |
| cold 7.9k (7940) | 18476, 18714 (0) | 19962, 20232 (0) | **−1502 (−7.5 %)** |
| exact repeat 7.9k x2 | **20, 20, 25, 26** (7940, full) | 611, 622, 643, 643 (7808) | **−607 (27x)** |
| other question after the 8k document (7918) | 398, 399 (7808) | 530, 550 (7808) | −141 |

- Texts: prev vs base 7/8 identical (other-question 1.4k differs at char 8: the anchor fix); base_4 == base_1 and new_3 ==
  new_2 8/8 · 8/8.
- Cold 7.9k −1.5 s: no per-chunk `cat` of the whole prefix (≈3.9 GB of copies at 7.9k [E]), no inline captures, no head
  on 15 chunks — not separated.
- **E4 phase split** (final, `TH_DEBUG_PREFILL=1`, synced phases, 7550-token prompt; `logs/sE/dbg8k.log`): full hit
  engine TTFT 20.6 / 22.1 ms (client 21.2 / 22.8), of which `prefill_slot` (lookup + restore) 1.6 / 2.2 ms; after the
  first token: reserve 11.9 / 15.5 ms, draft warm-up 35.0 / 37.6 ms. Cold: reserve 12.5 ms before chunk 1, build 14.5 ms
  and warm-up 69.5 ms after the first token. [D] ≈19 ms of the 7.5k full hit is per-request host work (template,
  tokenizer on ~28 KB, two clears, first sample); the 1.4k full hit's is ≈12 ms.

### 3.4 First-token gap (1st → 2nd streamed delta: deferred build + draft warm-up + round 1)

| class | final (E) | prev (E) | base (E) | final − base, paired [95 % CI] | gap − round 1, medians final / prev / base | prev (D, back-to-back) | base (D) |
|---|---|---|---|---|---|---|---|
| cold 1.45k | 89 | 90 | 85 | **+5 [−4, +15]** | 45 / 46 / 36 | 87 | 74 |
| exact repeat 1.4k | 71 | 74 | 80 | −9 [−17, −2] | 30 / 29 / 34 | 73 | 72 |
| other question 1.4k | 76 | 75 | 77 | −1 [−9, +6] | 34 / 34 / 32 | 76 | 71 |
| multi-turn 1 / 2 / 3 | 89 / 84 / 95 | 95 / 95 / 92 | 93 / 87 / 91 | −4 / −3 / +4 | 42–52 / 49–52 / 37–41 | — | — |
| cold 7.9k | 192 | 164 | 127 | **+62 [+32, +90]** | 122 / 115 / 76 | 135 | 120 |
| exact repeat 7.9k | 100 | 94 | 102 | +2 [−7, +11] | 53 / 39 / 49 | 91 | 93 |
| other question 8k | 104 | 106 | 102 | +2 [−8, +12] | 58 / 60 / 50 | 99 | 92 |
| short prompts | 42 | 43 | 46 | −6 [−9, −3] | — | — | — |

- final − prev: −11 to +8 ms on every class except cold 7.9k (+19 [+3, +36]: round 1 of new_3's second cold 8k ran at
  thermal 1, 100 ms; new_4's under 280–310 ms/s of other GPU clients; gap − round 1: 122 vs 115). The 7.9k exact
  repeat's +8 [+5, +14] is the reserve now running before round 1 (round 1 43–48 ms vs prev's 51–58, whose regrowth
  ran inside it).
- The remaining cold-prompt cost vs base sits in the build + warm-up phase (gap − round 1): ≈+10 ms at 1.45k, ≈+46 ms at
  7.9k. The build itself (2–3 GDN copies of 96 fresh buffers / 151 MB + the capture-row copy) measured 14.5 ms synced at
  7.5k (E4); the rest of the 7.9k delta is unattributed (allocation stalls under 42–58 GB of swap are the likely
  candidate). See §6.

### 3.5 Decode (dec class: 3 bench prompts x 3, T=0, 128 tokens, ratio of sums over the logged `[dflash]` rounds)

| arm (session E) | rounds | tok/round | ms/round | loop tok/s | load1 med | other GPU med ms/s |
|---|---|---|---|---|---|---|
| base_1 | 210 | 3.843 | **43.18** | 88.99 | 17.4 | 38 |
| prev_2 | 192 | 4.141 | 41.45 | 99.90 | 13.2 | 58 |
| new_3 | 192 | 4.141 | 43.45 | 95.29 | 20.5 | 76 |
| new_4 | 192 | 4.141 | 42.19 | 98.14 | 17.2 | 151 |
| prev_5 | 192 | 4.141 | 44.78 | 92.46 | 22.4 | 250 |
| base_6 | 210 | 3.843 | 55.74 | 68.94 | 26.1 | 217 (paged) |

- **final / prev = 42.82 / 43.11 = 0.993** (ABBA, identical token streams); final / base_1 = 0.992; session B prev / base
  = 41.02 / 41.02 = 1.000. Tokens/round 4.141 vs 3.843 = the anchor fix on the code prompt (text changes) and the long
  prompt (36 vs 37 rounds on identical text); the 30-prompt study (§3.7) finds it neutral.

### 3.6 In-process attribution (`TH_BENCH_TTFT`, session D probe, prev binary)

1459 tokens (splits [512, 1408]), 8 reps per kind rotated run by run, 1 s gap + thermal-0 gate before every run:

| kind | what | TTFT median / min ms | host enqueue median | capture host ms |
|---|---|---|---|---|
| `cap-leg-head` | integration-3's path: inline captures, legacy store, head on every chunk | 2414 / 2202 | **732** | 32.1 |
| `cap` | inline captures, direct store, head skip | 2340 / 2133 | 733 | 11.8 |
| `dcap-leg-head` | deferred, legacy store + head | 2360 / 2216 | 683 | 22.8 |
| `dcap` | deferred (the default) | 2401 / 2128 | **642** | 23.8 (hold + post-token build) |
| `miss` | no captures | 2387 / 2247 | 639 | — |

- **First-token logits: 0 of 248,320 bits differ** across all kinds (and in session A at 1459 / 7900 tokens).
- In-process TTFT medians are within noise (±60 ms; spread 300–500 ms per kind): the prefill is GPU-bound. Host enqueue:
  inline captures +94 ms, legacy store + head +41 ms, deferred holds +3 ms. The server-level −123 ms (§3.2) also includes
  what the probe holds constant (integration-3's clear with ≈256 blit encoders).

### 3.7 Item 1 decision: the anchor fix re-measured (session A)

`spec_acc` (30 prompts T=0 + 15 x seeds 1/3/5 sampled, 256 tokens), same binary with / without the fix, paired bootstrap
over prompts: T=0 tokens/round **0.9812 [0.9568, 1.0069]**, sampled **1.0052 [0.9648, 1.0445]** → both CIs contain 1.0 →
neutral → **kept** (so `TH_KV_CAP_PREFILL` stays on, rebuilt). T=0 streams 7/30 identical (first divergence token 1–222,
median 58), sampled 2/45.

### 3.8 Item 4 — `TH_PREFIX_CACHE_ASST=1` (session E, E3; arms `def_1 asst_2 amiss_3 asst_4 def_5`, `logs/sE/a`)

| class | asst mean / med (cached) | default (cached) | asst − default, paired [95 % CI] |
|---|---|---|---|
| multi-turn 2 (1551 tokens) | **269 / 268** (1446) | 324 / 327 (1408) | **−55 [−73, −36]** |
| multi-turn 3 (1687) | 340 / 341 (1549) | 357 / 360 (1536) | −16 [−38, +7] |
| cold 1.45k / cold chat turn 1 | 2450 / 2606 | 2801 / 2961 | not resolvable: def_1 was a slow arm (3.1–3.6 s); vs the clean def_5, asst +46 to +520 ms by position |

- Hit == miss with the split: asst_2 and asst_4 vs amiss_3 **12/12 · 12/12** each; def_1 == def_5 12/12 · 12/12.
- On ASST cold requests the host enqueue rises +280–600 ms: the 2-row tail chunk takes the fused decode path, which waits
  on the queued prefill (host time moves; the extra GPU work is one weight sweep, ≈30 ms [E]).
- **Decision: default off.** A −55 ms win on a continuation turn does not justify ≈+30 ms (or more) on every cold chat
  prompt by default; continuation-heavy deployments can set `TH_PREFIX_CACHE_ASST=1`.

## 4. Identity

| comparison | texts | per-round logs | meaning |
|---|---|---|---|
| **final vs prev**, E1 TTFT suite (all classes incl. full / partial hits, cold 1.45k / 7.9k, multi-turn) | **23/23** (x3 arms) | **23/23** | the three new commits are bit-transparent |
| final vs prev, gates: spec_a3 on / miss / off / legacy | **42/42 each** | **42/42 each** | |
| final vs prev, gates: TH_BATCH=2 (13 + 13 + 9), TH_BATCH=4 (16 + 3), no-draft (5 + 4), kv-quant (4) | **all identical** | — | |
| **hit == miss**, final (spec_a3, 42 requests incl. 10 full + 7 partial hits) | **42/42** | **42/42** | restores bitwise equal to the uncached prefill |
| `TH_KV_CAP_PREFILL=legacy` (integration-3's store + growth) / `TH_PREFIX_CACHE_KV=copy` / `TH_KV_RESERVE=0` vs default, final | 42/42 each | 42/42 each | |
| cache on vs off (grid plan), final | 31/42 | 25/42 | the default plan's known long-chat-prompt numerics class (integration-3: 35/42) |
| first run's binary without the anchor fix vs integration-3's gate arms (on and miss) | 42/42 · 42/42 each | — | every non-anchor change is bitwise equal to integration-3 |
| prev/final vs integration-3 (miss arms) | 22/42 | 9/42 | the anchor fix changes decode: first differing token 2–114, median 36 (20 streams) |
| kv-quant, final vs integration-3 | 0/4 | — | first differing char 8–113 (after the first tokens; T=0 near-tie "Need produce / provide" on code): the anchor fix — final == prev 4/4 |
| in-process first-token logits, all KV stores x head x capture modes (sessions A, D) | 0 / 248,320 bits | — | max\|Δ\| = 0 at the last prefill position |
| no-draft (n-gram) vs integration-3 (incl. 1.45k / 8k) | 9/9 | — | untouched |

## 5. Gates (final binary, session E, `logs/sE/gates`, `gates/gates_e.sh`)

| gate | result |
|---|---|
| V-build | **0 warnings, 0 errors** at every commit (`cargo build --release` + `cargo test --release --no-run`) |
| unit tests | **85 passed, 0 failed, 1 ignored** (`bench_row_dist`), twice (E0, E2) |
| `TH_TEST_ROLLBACK=1 TH_BATCH=2` (18 tokens) | **rc 0**: state-bitwise PASS; prefix restore at 16 slot0→0 and slot0→1: logits / state / verify / checkpoint ≠ 0/0/0/0; legacy logits PASS (worst \|Δ\| 0.125, argmax 68/68/68) |
| same, TH_BATCH=1 | **rc 0** |
| same, 1450-token prompt | **rc 0** (prefix restore at 1448, both slots, 0/0/0/0; the legacy-logits line prints "FAIL (argmax ref=68 rb=13)": the known artefact comparing argmaxes at two positions, PHASED §4.1) |
| same, `TH_GDN_COMMIT=step` (discrimination) | **rc 1**, as designed |
| TH_BATCH=2 `--draft TH_SAMPLE=check` | batch2 13, pc_batch2 13, batch2_long 9: **35/35 HTTP 200**, 0 U+FFFD; **samplecheck 293 rounds, 0 mismatches**; concurrent full-checkpoint restores into both slots; `/status prefix_cache` hits 16 (12 full), errors 0; 0 panic / WARN / ERROR |
| TH_BATCH=4 `--draft` + `POST /engine/kv/clear` | **16/16 + 3/3 HTTP 200**; kv/clear `{"cleared":[0,1,2,3],"ok":true,"prefix_cache_dropped":0,"skipped_live":[]}` |
| no draft, single slot (plain decode, 1.45k, 8k) | **9/9 HTTP 200**, texts == prev == integration-3 |
| `--kv-quant --draft` | **4/4 HTTP 200** on final and on prev, texts identical |
| prefix cache on / `=miss` / `=0` / `legacy` / `KV=copy` / `KV_RESERVE=0` (spec_a3, 42 requests each) | 252/252 OK; identities in §4; on-arm `/status`: hits 17 (10 full), misses 26, inserts 31, evictions 16, errors 0, reused 41,894 tokens |
| `/status` / `th_stats` contract | additive only: `prefix_cache.full`, `.full_hits`, `.asst` (first run); none this run |
| processes | every server / probe started by a session script on :8052 and stopped by it (SIGTERM → 20 s → KILL, port check) |

## 6. Notes, limits, next

- **The build's GDN copies are the remaining cost** (cold prompts' first-token gap: ≈+10 ms at 1.45k, ≈+46 ms at 7.9k vs
  base, of which the synced build is 14.5 ms at 7.5k; plus one GDN copy on the TTFT path when a mid grid checkpoint
  exists, +3 ms host enqueue in the probe). A
  swap-based hold (move the parity's tensors into the checkpoint, give the slot a set recycled from evicted checkpoints)
  would make both allocation-free: ≈5–40 ms [E], below this host's noise at 1.45k, visible at 7.9k.
- Full hits pay ≈19 ms of per-request host work at 7.5k (template + tokenizer + clears + first sample, §3.3); a
  rendered-prompt → ids cache would take most of it.
- Cold 7.9k (≈18.5–20.5 s vs Splash ≈8 s) and cold 1.45k (≈2.4–2.6 s vs Splash 1.84 s) are prefill attention + GEMM
  rate (th/e-prefill-attn, th/e-prefill-gemm). With this lane, th's repeat and follow-up TTFTs (1.4k repeat 13–16 ms,
  7.9k repeat 19–34 ms, 8k follow-up ≈0.4 s) are below the Splash figures in PHASED §1.4 (142–158 / 154 / 241 ms; not
  re-measured here).
- This host ran at 42–58 GB of swap during session E; engines idle for a few seconds get paged out (session B's +313 ms,
  prev_5's 90.6 s cold 8k). Every comparison here is interleaved in one hold and paired; absolute ms are host-specific.

## 7. Landing

- `main` moved to `d8545d7` during this run (15 commits since `e452a7b`, none under `engine/`); `git merge-tree
  --write-tree main th/e-ttft-regression` is clean (rc 0, read-only check). The branch touches only engine sources the
  other developer owns (engine.rs, main.rs, model.rs, qwen35.rs) plus outbuf.rs, prefix_cache.rs, server.rs, state.rs.
- Behaviour changes for them: DFlash decode positions (anchor fix: decode numerics change vs integration-3, neutral
  acceptance); checkpoint builds after the first token; exact repeats restore-only; checkpoints hold views of the slot's
  K/V buffer; one K/V reservation per prefill. Runtime A/B knobs (all read once): `TH_KV_CAP_PREFILL=legacy|0`,
  `TH_PREFILL_HEAD=1`, `TH_PREFIX_CACHE_DEFER=0`, `TH_PREFIX_CACHE_FULL=0`, `TH_PREFIX_CACHE_ASST=1`,
  `TH_PREFIX_CACHE_KV=copy`, `TH_KV_RESERVE=0`. The top three commits (`5c40234`, `803bd53`, `0a87c22`) are
  latency-neutral memory changes and can be dropped as a unit without affecting the rest.

## Appendix A: reproduce

```sh
P=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC; W=$P/work/th-e-ttft-regression
WT=$($P/bin/wt-bootstrap th/e-ttft-regression)      # head 0a87c22
(cd $WT/engine && cargo build --release && cargo test --release --no-run)   # 0 warnings
$P/bin/gpu-lock -- bash $W/gates/sessD1.sh              # session D on 25dab25: cold interleave, repeats, probe
$P/bin/gpu-lock -- bash $W/gates/sessE.sh               # session E on 0a87c22: unit tests, E1 TTFT/decode, gates_e.sh, E3, E4
python3 $W/gates/cold_an.py $W/logs/sD/c new base old   # §3.2 session D table + paired CIs
python3 $W/gates/headline.py $W/logs/sD/r base new base # §3.3
python3 $W/gates/e_an.py $W/logs/sE/t new prev base     # §3.2 E1 / §3.4 paired tables
python3 $W/gates/headline.py $W/logs/sE/t prev base prev new   # E1 decode + medians
python3 $W/gates/cmp_arms.py $W/logs/sE/gates/pc pc_miss pc_on # hit == miss (and pc_leg / pc_copy / pc_nores / pc_off)
python3 $W/gates/cmp_arms.py $W/logs/sE/a amiss_3 asst_2 asst_4  # item 4 hit == miss; e_an.py $W/logs/sE/a asst def
```

## Appendix B: cleanup

- Session D: 16 th-engine servers + 1 probe; session E: 6 E1 + 11 gate + 5 item-4 + 1 debug servers and 4 rollback probes —
  all on :8052, each stopped by its script. After session E only :8001 (pid 78860), :8090, :8091, :8095 listen (none
  ours); :8052 free; no process of this lane is left. `/tmp/th-engine-gpu.lock` released on exit.
- Git: branch `th/e-ttft-regression` @`0a87c22` (10 commits on `e452a7b`, trailer `Co-Authored-By: Claude Opus 5.5 (1M
  context)`), not pushed; main untouched. Remove with `git worktree remove .worktrees/th/e-ttft-regression && git
  branch -D th/e-ttft-regression`.
