# Phase D report: integration-3 vs main 521c6e0 vs Splash 1.0

Written 2026-09-27 ~09:00 AEST by the integration-3 / final-A/B agent, for the maintainer.

- **Repo:** `/Users/benebsworth/projects/token-horizon`. `main` = `521c6e0` (integration-2, unchanged since Phase C). The main working tree had 0 tracked changes (read with `GIT_OPTIONAL_LOCKS=0`); it was never edited, built or reset.
- **Hardware:** M5 Max, 40-core GPU, 128 GB. **Model:** Qwen3.8-27B-4bit (`$TGT`) + DFlash draft (`$DRAFT`). **Splash 1.0** (brew) serves `incoai/Qwen3.8-27B-Splash` on the free :8000.
- **Builds** (frozen copies in `$W/bin/`, `W=$P/work/integration-3`, `P=.worktrees/_phaseC`):

| label | build | sha256 |
|---|---|---|
| **th-i3** (`th-new` in the tables) | `report/integration-3` @`e452a7b` (this report) | `eb3497fbb194857e…` (= the worktree build) |
| th-i3-s0 (`th-new-s0`) | the same binary with `TH_SAMPLE=cpu TH_SPEC_VERIFY=token` (host CPU accept + token rule, i.e. th/d-sampled switched off in-binary) | `eb3497fbb194857e…` |
| th-main (`th-base`) | `main` @`521c6e0` (= integration-2) | `66e99644402995638d921e8e53cb6fc1f12d1d8fbcfea12c71de2c238f6cb133` |
| Splash | Splash 1.0, `/opt/homebrew/Cellar/splash/1.0` | — |

- **Metric conventions** (as in Phases B/C): loop tok/s = Σtokens / Σround-ms over the logged `[dflash]` rounds (prefill-sampled first token and the final unlogged round excluded); Splash: `decode_output_tokens / decode_wall_ms` from `/status` deltas; "like-for-like" (lfl) removes Splash's prefill-sampled token. "Sampled" = temperature 0.6, top_p 0.95, top_k 20, seeds 1/3/5. Ratio of sums everywhere. Tags: [M] measured, [D] derived, [E] estimate.
- **Inputs:** `PHASEC-REPORT.md`, `bench-quiet.md`, and the four lane reports in `$P/reports/phaseD/` (`th-d-longctx.md`, `th-d-gpu-tail.md`, `th-d-sampled.md`, `th-d-prefix-cache.md`).

## 0. Summary

1. **integration-3 is built and passes every gate.** `report/integration-3` @`e452a7b` = main + **th/d-longctx** `3cba876` + **th/d-gpu-tail** `cafc6ae` + **th/d-sampled** `8946bce` + **th/d-prefix-cache** `0407f89` (four `--no-ff` merges, in that order). 9 conflict hunks, all in qwen35.rs, plus **three semantic fixes** the textual merge did not show: the KV-capacity prefill buffer is now page-aligned (otherwise a prefix-cache hit and its miss take different attention kernels), `TH_BENCH_ATTN` routing between the two lanes' probes, and a test-model field (§4). 0 warnings; **78/78 tests** (+1 ignored bench); 4 rollback/prefix-restore probes rc 0 and the `TH_GDN_COMMIT=step` discrimination arm rc 1; TH_BATCH=2 35/35 and TH_BATCH=4 19/19 HTTP 200; GPU-vs-CPU sampling check 476 rounds, 0 mismatches; **prefix-cache hit == miss 42/42 texts and 42/42 per-round logs**; kv-quant and no-draft T=0 texts byte-identical to main; `/status` only gains keys (§4.1).
2. **Standing vs Splash 1.0, one gpu-lock hold** (f2, 06:28–08:30; block S = 8-arm palindrome, block L = 6-arm palindrome for ctx8k; every arm gated on thermal 0, all 14 arms clean on the first attempt; §1):

| mode | th-i3 / Splash (lfl) | th-main / Splash | th-i3 / th-main | Phase C th-main / Splash |
|---|---|---|---|---|
| T=0 | **1.243** (1.267) — 97.20 vs 78.22 tok/s | 1.035 | **1.201** | 1.031 |
| sampled | **1.317** (1.335) — 106.94 vs 81.20 | 0.864 | **1.525** | 0.876 |
| ctx1500 (≈1.44k, warm prefix) | **1.202** (1.188) — 93.29 vs 77.62 | 0.794 | **1.513** | 0.782 |
| ctxcold (≈1.45k, cold) | **1.245** (1.266) — 105.23 vs 84.53 | 0.834 | **1.493** | 0.794 |
| ctx8k (≈7.9k) | **1.117** (1.103) — 91.04 vs 81.54 | 0.447 | **2.499** | — |

   - th-i3's round is **39.53 ms vs Splash's 48.11** at T=0, 40.97 vs 49.97 at ≈1.44k and 42.41 vs 50.84 at ≈7.9k: context growth from bench context to 7.9k is now **+2.9 ms** (Splash +2.7; main +61.1).
   - th-main and Splash reproduce their Phase C quiet numbers within 1 % (T=0 47.49 vs 47.16 ms/round; 48.11 vs 47.66), so the sessions compare.
   - The sampled ratio contains a tokens/round component (4.274 vs 4.014) measured on only 9 distinct streams; the per-round ratio is 1.237. With the R0b 75-stream acceptance result (th ≈ Splash, B1 +0.9 to +2.9 %) the expected sampled standing is ≈1.24–1.27× [D].
3. **TTFT:** a repeated 1.4k prefix now costs **139 ms mean / 146 median (Splash 158 / 142; main 2546)**; short prompts 145 / 154 (Splash 152 / 137). Prefill is th's remaining loss: cold 1.45k **2530 ms vs Splash 1835 (1.38×)**; first 8k request 17.2 s vs 8.0 s; exact 8k repeat 509 vs 154 ms.
   - **Cold prefill regressed vs main: +109 to +130 ms (+4.6–5.4 %) at 1.45k.** An in-binary palindrome (§1.5) attributes it: the prefix cache's two checkpoint captures per uncached prompt cost ≈125–170 ms and gpu-tail's KV-capacity prefill ≈90–100 ms; with both switched off (`TH_PREFIX_CACHE=0 TH_KV_CAP_PREFILL=0`) i3 is 112–137 ms *faster* than main (T1b grouped attention, first token before the draft warm-up).
4. **What each lane delivered** (§2): longctx took the context growth out of the round (its own A/B: ctx1500 62.6 → 49.8 ms/round, ctx8k 109–113 → 55–61); gpu-tail took ≈7.7 ms/round of verify GPU work out at every context (quiet ABBA ×1.194 T=0); sampled took the sampled-round host cost out (−2.96 ms/round in-binary here) and showed Phase C's acceptance gap was sample noise; prefix-cache made repeated-prefix TTFT ≈18× faster here (21× in its loaded run), bit-exact to the uncached prefill.
5. **Review verdicts** (§3): longctx mergeable; gpu-tail's must-fix (load-inflated claims) fixed by its quiet re-measure; sampled needs-fix with its two code/report must-fixes fixed and its third (quiet re-measure) answered by this hold; prefix-cache's verdict never reached this agent (the task text was truncated). Each lane is one merge commit, so any one can be dropped.
6. **Landing:** `main` is an ancestor of `report/integration-3` — a **fast-forward** of 53 commits (§5). It changes all six engine files the other developer owns; they need to sign off on the prefix-cache default, the GPU sampled-acceptance default and the `DraftSampling` signature change. Nothing was pushed.
7. **Next levers** (§6): (1) prefill attention — a fused causal kernel for chunks > 8 rows (cold 1.45k ≈ −0.46 s, 8k ≈ −50 %; not bitwise); (2) remove the cold-TTFT regression: `TH_KV_CAP_PREFILL` off by default (≈ −90 ms) and allocation-free / deferred checkpoint captures (≈ −130 ms) (§1.5); (3) the prefill Q4 GEMM rate; (4) restore-only exact repeats (end-of-prompt checkpoint with stored logits); (5) the remaining ≈3.5 ms/round above the kernel floor, now attributable with the R0c profiler.

## 1. Standing vs Splash

### 1.1 Final session f2 (06:28–08:30, one gpu-lock hold)

- **Harness:** `$W/bench/fin.sh` — th/d-gpu-tail's quiet-session harness (itself bench-quiet's) with a fixed private port **:8045**, bench-quiet's client and prompts (3 bench prompts, the 1373-token passage sha1 `a886db14acc4`, th/d-longctx's 7853-token `passage8k.txt` sha1 `6ab8ad9a056a`), fresh server per arm, one server at a time, Splash only on the free :8000 and never beside a th server, phys_footprint guard (64 GB, no event).
- **Block S** (greedy, sampled, ctx1500, ctxcold), palindrome **i3_1 → i3s0_2 → splash_3 → base_4 → base_5 → splash_6 → i3s0_7 → i3_8**; i3s0 arms run greedy + sampled only.
- **Block L** (ctx8k), palindrome **i3_9 → splash_10 → base_11 → base_12 → splash_13 → i3_14**; each ctx8k request first waits (outside the timed window, ≤ 240 s) for thermal level 0 — main has no prefix cache, so its nine cold 8k prefills per arm heat the GPU (the first attempt, `f1`, reached level 2 within one 8k prefill and was stopped; nothing from f1 is used).
- **Suite per arm:** 2 warm-ups (short; passage + "Say hi."), then 3 prompts × 3 iterations per mode: greedy T=0; sampled seeds 1/3/5; **ctx1500** = passage + prompt, T=0 — the warm-up already primed the passage, so on the two caching engines these are warm prefix hits (the "repeated prefix" case); **ctxcold** = a unique nonce (`Note 1..9`) + passage + prompt, T=0 — never cached; **ctx8k** = 8k passage + prompt, T=0 — the first request of an arm is (mostly) cold, the rest are exact repeats or a different question after the same document. max_tokens 128. 306 requests, all OK.
- **Gate before every arm** (checked last, right before the server starts): thermal pressure 0 **and** 1-min load < 6 held 30 s (≤ 300 s; first arm ≤ 900 s) → "pass"; else thermal 0 and load < 9 held 30 s (≤ 600 s more) → "pass2"; else thermal 0 alone → "soft". Arms are redone on mid-arm contamination (> 10 % of requests at thermal ≥ 2, > 25 % at load1 ≥ 12, any at ≥ 18, or any error). The idle machine sat at load1 7.5–11 (an unrelated CPU ML server, pid 8947, ≈1.3 cores; Docker; a VM) — the same background the sampled lane could never get below 6.

**Conditions** (load1 / thermal at request start; `f2/analysis/{conds,gates}.md`):

| arm | gate (wait) | load1 min / median / max | thermal at request start |
|---|---|---|---|
| i3_1 | pass (799 s) | 4.82 / 5.80 / 7.21 | 0 ×36 |
| i3s0_2 | pass (125 s) | 7.29 / 7.39 / 7.70 | 0 ×18 |
| splash_3 | pass (30 s) | 4.44 / 4.97 / 8.62 | 0 ×34, 1 ×2 |
| base_4 | pass2 (608 s) | 6.03 / 6.90 / 12.64 | 0 ×27, 1 ×7, 2 ×2 |
| base_5 | pass2 (331 s) | 3.34 / 4.40 / 7.11 | 0 ×27, 1 ×8, 2 ×1 |
| splash_6 | pass (105 s) | 4.06 / 4.81 / 6.15 | 0 ×36 |
| i3s0_7 | pass2 (738 s) | 7.65 / 8.06 / 8.88 | 0 ×18 |
| i3_8 | pass (246 s) | 5.01 / 5.75 / 7.25 | 0 ×35, 1 ×1 |
| i3_9 | pass (146 s) | 6.60 / 7.01 / 7.09 | 0 ×9 |
| splash_10 | pass2 (341 s) | 5.46 / 5.76 / 6.98 | 0 ×9 |
| base_11 | pass2 (437 s) | 6.89 / 8.95 / 12.91 | 0 ×9 (code#1, long#1 waited ≈62 s for level 0) |
| base_12 | pass (120 s) | 4.67 / 8.77 / 9.72 | 0 ×9 (code#1, long#1 waited ≈63 s for level 0) |
| splash_13 | soft (903 s) | 7.27 / 8.55 / 10.21 | 0 ×9 |
| i3_14 | pass (116 s) | 4.53 / 4.92 / 5.35 | 0 ×9 |

- Request-start load1 was 3.3–12.9 (PHASEC s1: 1.9–5.1). It does not move these GPU-bound numbers at the reported precision: the two arms of every engine agree to 0.1–0.7 % on ms/round (table below), base_4 (mean load1 8.25) and base_5 (4.50) agree to 0.3 %, and main and Splash reproduce their Phase C quiet standing within 1 %. The th-i3 arms ran at equal or *higher* load than the Splash and main arms of the same block, so nothing flatters th.
- GPU clock / other GPU clients: WindowServer ≈3 %, other clients 28–37 ms/s at the gates.

**Pooled per engine × mode (both arms, ratio of sums):**

| engine | mode | n / logged rounds | tok/round | ms/round (arm 1 / arm 2) | **loop tok/s** | lfl | TTFT mean / med ms | GPU-busy / idle ms/round |
|---|---|---|---|---|---|---|---|---|
| **th-i3** | T=0 | 18 / 420 | 3.843 | **39.53** (39.54 / 39.53) | **97.20** | 98.06 | 145 / 154 | 39.2 / 1.1 |
| th-i3 | sampled | 18 / 380 | 4.274 | **39.96** (39.76 / 40.16) | **106.94** | 107.26 | 148 / 158 | 39.3 / 1.5 |
| th-i3 | ctx1500 | 18 / 438 | 3.822 | **40.97** (40.80 / 41.13) | **93.29** | 91.22 | **139 / 146** (1408 cached) | 40.5 / 0.9 |
| th-i3 | ctxcold | 18 / 378 | 4.275 | **40.63** (40.71 / 40.55) | **105.23** | 105.91 | 2530 / 2540 | 38.1 / 2.9 |
| th-i3 | ctx8k | 18 / 432 | 3.861 | **42.41** (42.34 / 42.48) | **91.04** | 88.97 | 2365 / 517 | — † |
| th-i3-s0 | T=0 | 18 / 420 | 3.843 | 39.62 (39.69 / 39.54) | 97.00 | 97.86 | 145 / 154 | 39.3 / 1.3 |
| th-i3-s0 | sampled | 18 / 440 | 3.705 | 42.92 (42.75 / 43.10) | 86.30 | 86.47 | 148 / 158 | 39.9 / 3.6 |
| th-main | T=0 | 18 / 420 | 3.843 | 47.49 (47.55 / 47.43) | 80.93 | 81.64 | 161 / 166 | 46.1 / 1.2 |
| th-main | sampled | 18 / 458 | 3.590 | 51.18 (51.48 / 50.89) | 70.13 | 69.78 | 165 / 169 | 46.8 / 3.9 |
| th-main | ctx1500 | 18 / 438 | 3.822 | 61.99 (62.17 / 61.81) | 61.65 | 60.28 | 2546 / 2553 | 56.8 / 5.0 |
| th-main | ctxcold | 18 / 372 | 4.366 | 61.92 (62.06 / 61.78) | 70.50 | 70.56 | 2400 / 2381 | 60.5 / 1.3 |
| th-main | ctx8k | 18 / 414 | 3.957 | 108.62 (108.70 / 108.54) | 36.42 | 36.19 | 19895 / 19958 | — † |
| Splash 1.0 | T=0 | 18 / 456 | 3.763 | 48.11 (48.28 / 47.94) | 78.22 | 77.40 | 152 / 137 ‡ | 48.1 / 0.5 |
| Splash | sampled | 18 / 428 | 4.014 | 49.43 (49.88 / 48.99) | 81.20 | 80.35 | 139 / 138 ‡ | 48.7 / 1.7 |
| Splash | ctx1500 | 18 / 444 | 3.878 | 49.97 (50.74 / 49.20) | 77.62 | 76.81 | 158 / 142 ‡ (1408–1440 cached) | 50.0 / 0.7 |
| Splash | ctxcold | 18 / 412 | 4.180 | 49.44 (50.01 / 48.88) | 84.53 | 83.65 | 1835 / 1835 | 49.3 / 0.6 |
| Splash | ctx8k | 18 / 414 | 4.145 | 50.84 (50.95 / 50.72) | 81.54 | 80.68 | 1962 / 158 ‡ | — † |

† The GPU-busy slope (ioreg GPU ms vs rounds, intercept = prefill) is meaningless when an arm mixes cold prefills and cache hits. ‡ Splash prefix-cache hits: 32–64 tokens on the bench prompts, 1408–1440 on ctx1500, 1408 / 7872 / 7904 on ctx8k.

**Ratios** (loop tok/s; lfl in brackets; = per-round ratio × tokens/round ratio):

| mode | th-i3 / Splash | th-main / Splash | th-i3-s0 / Splash | th-i3 / th-main |
|---|---|---|---|---|
| T=0 | **1.243** (1.267) = 1.217 × 1.021 | 1.035 (1.055) | 1.240 | **1.201** |
| sampled | **1.317** (1.335) = 1.237 × 1.065 | 0.864 (0.868) | 1.063 | **1.525** |
| ctx1500 | **1.202** (1.188) = 1.220 × 0.986 | 0.794 (0.785) | — | **1.513** |
| ctxcold | **1.245** (1.266) = 1.217 × 1.023 | 0.834 (0.844) | — | **1.493** |
| ctx8k | **1.117** (1.103) = 1.199 × 0.931 | 0.447 (0.449) | — | **2.499** |

- **The round.** th-i3's round is 17–20 % shorter than Splash's in every mode (per-round 1.199–1.237); Splash's cost growth from bench context to 7.9k is +2.7 ms, th-i3's +2.9 ms (main's +61.1).
- **Tokens/round.** Where the texts are identical the engines need nearly the same rounds (§1.3); the per-mode tokens/round ratios mostly reflect different texts. The ctx8k 0.931 comes from the code/long prompts, where the texts differ (§1.3).
- **Sampled.** The tokens/round component (4.274 vs 4.014) is measured on 9 distinct streams per engine (each engine is deterministic across its arms). R0b (th/d-sampled, 75 streams) measured th's token-rule acceptance at 1.002× Splash and B1's gain at +0.9 % on the same drafted blocks (+2.9 % realized). So the robust part here is the per-round 1.237; the expected standing is ≈1.24–1.27× [D], and 1.317 is this suite's value.

### 1.2 Where the round goes (th arms; mean per logged round, ms)

| phase | main T=0 | **i3 T=0** | main ctx1500 | **i3 ctx1500** | main ctx8k | **i3 ctx8k** | main sampled | **i3 sampled** | i3-s0 sampled |
|---|---|---|---|---|---|---|---|---|---|
| propose (draft forward + select) | 6.35 | **5.78** | 12.12 | **6.27** | 16.39 | **6.50** | 6.81 | 5.84 | 6.26 |
| verify host encode | 2.12 | 1.99 | 2.26 | 2.17 | 3.27 | 2.29 | 2.31 | 2.14 | 2.20 |
| verify GPU tail + readback | 38.58 | **31.52** | 47.19 | **32.27** | 88.47 | **33.35** | 38.88 | 31.70 | 31.74 |
| rest (accept, commit, emit) | 0.11 | 0.00 | 0.16 | 0.00 | 0.24 | 0.00 | 3.18 | **0.01** | 2.76 |
| **round** | 47.49 | **39.53** | 61.99 | **40.97** | 108.62 | **42.41** | 51.18 | **39.96** | 42.92 |

- **T=0, −7.95 ms:** the GPU tail −7.06 (gpu-tail's add+RMSNorm/GDN/commit kernels; its own quiet A/B: −7.71 ms/round T=0, ≈7.1 of it in the verify GPU tail) and propose −0.57. th-i3's GPU-busy slope is 39.2 ms/round (Splash 48.1); idle ≈1.1 ms. Gap to the kernel floor F_k ≈ 36 ms: ≈3.5 ms/round [D].
- **ctx1500, −21.0 ms:** GPU tail −14.9 (N3 split-key attention + gpu-tail), propose −5.85 (N4). **ctx8k, −66.2 ms:** GPU tail −55.1, propose −9.9, host encode −1.0 (N3's persistent scratch).
- **Sampled, in-binary (i3 vs i3-s0, same binary, adjacent arms):** −2.96 ms/round (42.92 → 39.96): `rest` 2.76 → 0.01 (S1's GPU accept replaces the `[8, vocab]` readback + CPU accept) and propose −0.42; GPU tail unchanged. The T=0 control in the same arms is identical code and reads 39.62 vs 39.53 ms (−0.2 %), although the i3-s0 arms ran at higher load (7.3–8.9). th-i3's sampled round now costs **+0.43 ms** over its greedy round (main +3.69, Splash +1.32).

### 1.3 T=0 identity, determinism, identical-text rounds

- **Determinism:** every engine is text-identical across its own two arms — th-i3 45/45 (mode, prompt, iteration, seed) groups, th-main 45/45, Splash 45/45, th-i3-s0 18/18.
- **th-i3 vs th-main** (emitted id streams + text sha, per (prompt, iteration), all arm pairs; `ab.py`): greedy **36/36** identical; ctx1500 **36/36**; ctxcold **20/36** — code#1 first differs at id **113**, code#2 at **121**, long#2 at **14**, long#3 at **52**; ctx8k **12/36** — short identical, code at id **29** (all three), long at id **90**. By text: greedy 9/9, ctx1500 9/9, ctxcold 5/9, ctx8k 3/9. These are the ≥ 256-key near-tie class th/d-longctx reported (N3 rounds 1–2 ulp differently; its session: ctxcold/code #122, ctxcold/long #15, ctx8k/code #30, ctx8k/long #19) plus the prefix cache's chunk plan on long chat prompts.
- **th-i3 vs Splash:** greedy 6/9 texts (code diverges at re-tokenized token #23, " Need produce" / " Need provide" — the known near-tie, the same as main vs Splash); ctx1500 9/9; ctxcold 4/9 (main vs Splash 4/9); ctx8k 3/9 (main vs Splash 6/9: at 8k/code main and Splash agree and th-i3 differs at token #30; at 8k/long all three differ, Splash at #19, th-i3 vs main at #91).
- **Sampled** streams differ from main by design (S1's f32 arithmetic and B1's block rule change the trajectory, not the distribution): 4/36 identical; th-i3-s0's differ too (S1's CPU reference replaced main's f64 `dist_vec`).
- **Rounds on byte-identical text** (block S): th-i3 vs Splash 6 groups, 470 tokens, **124 vs 120 rounds** (Splash needs 0.968×; Phase C: 151 vs 147, 0.974×); th-i3 vs th-main 7 groups, 153 vs 153 rounds (identical — every lane keeps T=0 draft proposals at bench context bit-identical).

### 1.4 TTFT (client, first streamed token; `f2/analysis/ttft.md`)

| request class | th-i3 mean / median (cached tokens) | Splash | th-main |
|---|---|---|---|
| short prompts (58–80 tok), T=0 | 145 / 154 (0) | 152 / 137 (32–64) | 161 / 166 |
| repeated 1.4k prefix (ctx1500) | **139 / 146** (1408) | 158 / 142 (1408–1440) | 2546 / 2553 |
| cold ≈1.45k (ctxcold) | **2530 / 2540** (0); prefill 572 tok/s | 1835 / 1835 (32); 789 tok/s | 2400 / 2381 |
| first 8k request of an arm | **17,188** (512 reused) | 7,985 (1408 reused) | 19,887 |
| 8k exact repeat | **509** (7808) | 154 (7904) | 20,180 |
| 8k, other question after the same document | **521** (7808) | long#1 241 (7872 reused), code#1 8,634 (1408 reused) | 19,045 |

- **Repeated prefixes are solved:** the 1.4k repeat is at parity with Splash (mean 12 % faster, median 3 % slower) and ≈18× faster than main; a different question after the same 8k document is served from the same 7808-token checkpoint in ≈0.5 s.
- **Exact 8k repeats:** 509 vs 154 ms. th's end checkpoint is block-aligned (7808), so a repeat re-prefills 104–126 rows through the eager attention over 7.8k keys; Splash reuses 7904 (32-token blocks).
- **Cold prefill is th's loss:** 1.38× Splash at 1.45k (main 1.31×), 2.15× on the first 8k request (Splash also reused 1408 tokens of it; th-i3 512).
- **Cold 1.45k vs main: +130 ms (+5.4 %).** Consistent across arms (th-i3 2534 / 2525, main 2396 / 2404). th_stats split it into host enqueue of the prefill forwards (prompt / `prefill_tps`: 780 vs 689 ms median) and the rest (GPU drain + first sample: 1758 vs 1700). Attribution: §1.5.

### 1.5 Cold-prefill TTFT attribution (in-binary A/B, session t1, 08:30–08:50, one gpu-lock hold)

- **Setup** (`$W/bench/ttft_ab.sh`): 12-arm palindrome **base i3 kv0 pc0 miss both | both miss pc0 kv0 i3 base** on :8045, fresh server per arm, gate thermal 0 + load1 < 9 held 20 s (gates passed at load1 5.3–8.0, thermal 0 on every request). Suite: warm-ups + ctxcold 3 prompts × 3 unique nonces (T=0; the same requests as f2's ctxcold). 108 requests.
- Configs: base = main; i3 = default; kv0 = `TH_KV_CAP_PREFILL=0` (gpu-tail's prefill capacity buffer off); pc0 = `TH_PREFIX_CACHE=0` (T1 plan + checkpoint captures off; T1b GQA stays on); miss = `TH_PREFIX_CACHE=miss` (T1 plan on, captures off); both = kv0 + pc0.

| config | TTFT mean / median ms (per arm) | enqueue med ms | rest med ms | paired Δ vs i3, mean / median ms |
|---|---|---|---|---|
| base (main) | 2359 / 2356 (2342 / 2376) | 666 | 1692 | −109 / −124 |
| **i3** | 2468 / 2447 (2464 / 2473) | 722 | 1727 | — |
| kv0 | 2370 / 2408 (2417 / 2323) | 725 | 1678 | **−98 / −87** |
| pc0 | 2331 / 2338 (2398 / 2264) | 677 | 1661 | −137 / −110 |
| miss | 2299 / 2341 (2302 / 2296) | 648 | 1687 | **−169 / −125** |
| both | **2247 / 2299** (2247 / 2247) | 600 | 1696 | −221 / −173 (vs main **−112 / −137**) |

(enqueue = prompt / `th_stats.prefill_tps`, i.e. the host enqueue of the prefill forwards, which are not synced; rest = engine TTFT − enqueue = GPU drain + first sample.)

- **Reading [M; arm-to-arm spread up to ±70 ms, so ±50 ms per figure]:** i3 is +109 ms (+4.6 %) behind main here (f2: +130 ms). Two merged paths cost it and the rest of the merge gains back:
  - **prefix-cache checkpoint captures ≈ +125–170 ms** (i3 vs miss; two captures per uncached long prompt, at 512 and 1408): mostly host enqueue (+74 ms) plus GPU drain (+40 ms). The lane's synced diag measured 8.5–17.5 ms per capture; the in-situ cost is several times that. [E] Most likely host-side allocation: every capture takes ≈130 fresh `Tensor::empty` buffers (≈315 MB at 1408, GDN state + K/V + capture rows), each a new wired MTLBuffer plus residency-set commit on the prefill's enqueue path. In the merged build the capture also copies K (not only V) out of the capacity buffer: 16 more copies per capture.
  - **KV-capacity prefill ≈ +90–100 ms** (i3 vs kv0; zero-filled `[4, ≥2048, 256]` K and V per attention layer plus a copy of the `cat` into it). gpu-tail's own quiet re-measure saw +2.9 % (+73 ms) at 1.43k from the same path. Its benefit is ≈11 ms once per request (the first verify no longer regrows 32 caches).
  - **the cache's chunk plan ≈ −32 ms** (miss vs pc0: the merged 896-row chunk saves a weight sweep), and **everything else ≈ −110 to −140 ms** (both vs main: T1b's grouped eager attention ≈ −97 ms, the first token before the draft warm-up ≈ −35 ms, one causal mask per forward).
- **So the fix is known [D]:** `TH_KV_CAP_PREFILL=0` by default (or drop its zero fill and the double write once the anchor off-by-one fix `68f3423` lands) and cheaper captures (a reused checkpoint arena instead of fresh allocations, or captures deferred past the first token — K/V rows below `pos` are append-only and the GDN parity state is double-buffered) would put i3's cold 1.45k TTFT ≈110–140 ms *below* main's (≈2.25 s here, vs Splash 1.84 s). Not changed in integration-3: both are lane defaults; this report measured the merged defaults.

## 2. What each lane delivered (lane-measured, then combined)

Every lane started from main `521c6e0` (sha256 `66e99644…`) and measured against that binary: fresh server per arm, gpu-lock, ratio of sums. Numbers are the lanes' own [M] results (reports in `$P/reports/phaseD/`); lane sessions ran on a shared, often heavily loaded machine, so only the quiet or load-matched figures are quoted. §1 is this report's same-session measurement of all four combined.

### 2.1 th/d-longctx @`3cba876` — N3, N4, long-prompt memory (report `th-d-longctx.md`)

| item | commit | default | measured effect | basis |
|---|---|---|---|---|
| **N3** split-key `attn_decode` (MPP tile over (kv head, split), 48 fused query rows per kv head, fixed-order reduce) + persistent partials scratch | `97fffcf`, `3cba876` | on at ≥ 256 visible keys (bench prompts peak ≈180 keys → bit-identical to main there) | verify attention ×16 layers: 9.1 → 0.60 ms at 1.45k, 51.6 → 2.06 at 8k, 209 → 7.4 at 32k; precision vs f64 equal to the single-pass kernel; scratch: ctx8k 64.9 → 55.5 ms/round, host encode 7.2 → 3.5 | no-model kernel bench; in-binary palindrome |
| **N4** `draft_attn_split` (64 TGs, split keys; port of 1738e0a/dd28d2a without its per-call env reads) | `bc94adb` | on (1 split = bit-identical to `draft_attn` up to ring 248) | per propose 4.63 → 0.47 ms at a 1.45k ring, 8.09 → 0.68 at 2048 | kernel bench |
| long-prompt memory: one causal mask per forward; pool trim between prefill chunks at pos ≥ 2048 (`TH_PREFILL_SYNC`) | `a5b911f`, `d0ac219` | on | 8k prefill footprint +17.3 → +7.2 GB; 12k 48+ GB (killed) → 37.8 GB; TTFT unchanged. Found after a 32k probe rebooted the machine (130.9 GB resident) | phys_footprint guard |
| item 3 (G1a "+2.4 % cold prefill") | — | — | not a regression (+1.0 % ± 1.4 % pooled; synced 4-build A/B and carry on/off A/B show no cost) | re-analysis |
| **head vs base** | `d0ac219` / `3cba876` | | ctx1500 **62.6 → 49.75 ms/round** (load-matched arm; loop tok/s 61.0 → 80.1); ctx8k 109.4/113.4 → 60.6/57.3 (1.85×), 55.5 with the scratch; in-process paired round Δ at L = 1450 / 7900: −17.4 / −64.1 ms (N3 −10.5 / −54.6, N4 −6.8 / −10.7); 8k round = **1.15×** the short-context round (base 2.26×); T=0 bench prompts bit-identical | session sZ/sS (load 8–34, thermal 0–2) + in-process probe |

### 2.2 th/d-gpu-tail @`cafc6ae` — R0c profiler + short-context GPU-tail kernels (report `th-d-gpu-tail.md`)

| item | commit | old path (read once) | notes |
|---|---|---|---|
| R0c per-command-buffer GPU profiler | `6339308` | `TH_GPU_PROF` unset = off | region markers are relaxed-load no-ops when disarmed |
| one dispatch for all GDN rollback commits | `beb4cc0` | `TH_GDN_COMMIT_ALL=0` | |
| add+RMSNorm one threadgroup per row | `a01aaec` | `TH_ARN_LEGACY=1` | bit-identical |
| GDN fused step 32 simdgroups/head | `276008c` | `TH_GDN_WSG=8` | bit-identical |
| draft select ChunkTop16 (+ shuffles) | `9e2296a`, `a25d799` | `TH_CAND_SORT=legacy` | bit-identical |
| prefill K/V into a capacity buffer (+ zero fill) | `413d8ef`, `e3a4463` | `TH_KV_CAP_PREFILL=0` | the zero fill covers the unfixed anchor off-by-one row |
| draft ring write, draft presum producers, head views | `caf7f9d`, `7260520`, `be05f50` | `TH_DRAFT_RING=legacy`, `TH_DRAFT_PS=0` | bit-identical |
| RIF kernel added then removed | `63ea5be`, `cafc6ae` | — | no in-situ win; not identical at 27B |
| **head vs base, quiet re-measure (q1, load 4–8.6, thermal 0)** | | | T=0 **47.46 → 39.75 ms/round (×1.194)**, sampled ×1.174, ctx1500 ×1.144, ctxcold ×1.158, ctx8k ×1.108 (108.35 → 97.77); ≈7.1 of the 7.7 ms is verify-forward GPU work; tokens/round and T=0 id streams identical (36/36, 36/36, 12/12, 12/12). Same hold vs Splash: 1.231 / 1.044 / 0.909 / 0.904. Long-prompt TTFT +2.9 % at 1.43k (suspect: the KV-capacity path) |

### 2.3 th/d-sampled @`8946bce` — R0b, S1, B1 (report `th-d-sampled.md`)

| item | commit | default | measured effect |
|---|---|---|---|
| **R0b** acceptance study + instrumentation (`TH_ACCEPT_STATS`, `TH_TOP_P=renorm`, `TH_DRAFT_FILTER`) | `da7718e` | off | Phase C's sampled tokens/round gap (0.894×) was mostly sample noise: 15 prompts × 5 seeds, th 4.140 vs Splash 4.131 (1.002 [0.967, 1.036]); top-p semantics and draft filtering: no significant effect |
| **S1** sampled acceptance on the GPU (`ts_topk` + `ts_accept` in the verify CB, 16-word readback; bit-exact CPU reference; `TH_SAMPLE=gpu\|cpu\|check`) | `ee270c6`, `c81d9da` | gpu | host `rest` −3.5 to −5.7 ms/round on byte-identical requests; GPU == CPU 0 mismatches over thousands of checked rounds |
| **B1** block verification (Sun et al. 2024), default where the GPU kernel serves the request | `2664850`, `33d6398` | auto (top-k 1..32, no repeat penalty) | exact by enumeration and Monte Carlo; tokens/round ×1.0091 [1.0040, 1.0142] on the same drafted blocks; realized 1.031× Splash [1.004, 1.061] |
| review fix: no full-vocab sort for no-top-k rows | `8946bce` | on | `rest` 24.0 → 2.8 ms/round (top_k 0 + top_p 0.95), 33.0 → 2.9–4.5 (top_k 0, top_p 1) |
| **head vs base** | | | m3m (moderate load 11–27, one base arm): sampled loop tok/s **1.152×** [1.089, 1.225] (ms/round 0.893, tokens/round 1.029); T=0/ctx controls 0.98–0.99×. No quiet run existed (load1 never < 6 during the review round) |

### 2.4 th/d-prefix-cache @`0407f89` — T1, T1b, T1c (report `th-d-prefix-cache.md`)

| item | commit(s) | default | measured effect |
|---|---|---|---|
| **T1** prefix cache: slot-state checkpoints (GDN recurrent+conv, K/V rows, DFlash capture rows) keyed by (tokens, prefill step, chunk history); canonical chunk plan; LRU (8 entries / 4096 MiB); `TH_PREFIX_CACHE=0\|miss\|grid` | `bdccf2a` … `ec0fab2` | on | **a hit is bit-identical to the same request's uncached prefill** (hit vs `=miss` 42/42 texts · 42/42 round logs in every session); repeated 1.4k-prefix TTFT **162 ms median vs main 3230 ms (21×, loaded d5)**; multi-turn 10×, system prompt 21×, 8k repeat 45–200×, other question after the same 8k doc 6.2× |
| **T1b** GQA-grouped eager attention | `e45bfdc`, fix `0407f89` | on (`TH_ATTN_GQA=0`) | bitwise equal on all 10 model shapes; 4.9× per layer at a 24-row suffix over 1432 keys; −97 ms per cold 1.45k prefill, −226 ms per 8k chunk |
| **T1c** checkpoint copies as compute dispatches | `02976a4` | on | capture 8.5–17.5 ms at 1.4k (was 28–50), restore 3.5–5.0 ms |
| TTFT: first token before the draft-ring warm-up (+ the warm-up still runs when the first token ends the request) | `21d0211`, `7c2407f` | on | −34–40 ms TTFT at 1.4k; history identical to main |
| identity | | | `=0` == main 42/42 · 42/42; `=grid` == main incl. hits; default plan 34/42 (8 long chat prompts diverge at near-ties from the separate tail chunk) |

## 3. Review verdicts and merge decisions

The merge rule: status done, and review mergeable or its must-fix items fixed.

| branch @ head | status | review verdict | must-fix items | decision |
|---|---|---|---|---|
| th/d-longctx @`3cba876` | complete (N3, N4 on by default; item 3 closed without code; memory fixes) | **mergeable** | none | merged (`bf14487`) |
| th/d-gpu-tail @`cafc6ae` | done (15 commits; lane agent left no report, rebuilt from artifacts) | must-fix **R1** (high): "perf claims are load-inflated; re-measure quiet" | R1 **fixed**: the s9 ×1.301 was withdrawn and a quiet ABBA (q1, gated thermal 0 + load1 < 5, contaminated arms redone) measured ×1.194 T=0; no code change was required | merged (`eca5763`). Note: this lane was missing from the orchestrator's lane list (the list was truncated); its report shows done + must-fix fixed, and it is in the requested merge order |
| th/d-sampled @`8946bce` | findings 1 and 2 fixed, finding 3 open | **needs-fix** | 1 (high, full-vocab sort for no-top-k rows): **fixed** in `8946bce` and re-gated; 2 (high, stub report): **fixed**; 3 (high, quiet re-measure): a measurement item — the lane could not get a quiet window (load1 min 7.97 over 2 h) | merged (`5e70fb3`) — the code must-fixes are fixed; finding 3 carries no code change and is re-measured here in one hold (§1: default vs the in-binary `TH_SAMPLE=cpu TH_SPEC_VERIFY=token` arm, vs main and vs Splash). The merge is one commit and can be dropped if the orchestrator reads the rule strictly |
| th/d-prefix-cache @`0407f89` | DONE (21 commits, clean tree) | **not received** — the lane entry in the orchestrator's task text was cut off after its status | unknown | merged (`e452a7b`) on the lane's own gates (52/52 tests, rollback + prefix-restore gates, hit == miss 42/42 · 42/42) plus the integration-3 gates (§4.1). The merge is one commit and can be dropped if its review turns up a must-fix |

Open items the lanes raised themselves (not review findings): the anchor off-by-one (`th/c-loop-anchor` @`68f3423`, still unmerged; gpu-tail's capacity buffers zero-fill because of it, and T1's `7c2407f` keeps main's ring history because of it); N3's split threshold stays at 256 keys (lowering it changes bench-context numerics); the legacy-logits line of `TH_TEST_ROLLBACK` compares argmaxes at different positions at long prompts (main.rs, cosmetic); the prefix cache's default plan changes long-chat-prompt numerics vs main (`TH_PREFIX_CACHE=grid` = strict main identity).

## 4. integration-3: merges and gates

**Branch** `report/integration-3` @`e452a7b`, worktree `/Users/benebsworth/projects/token-horizon/.worktrees/report/integration-3`, created by `$P/bin/wt-bootstrap report/integration-3` (start `main` @`521c6e0`, target seeded from integration-2). Four `--no-ff` merges in the requested order. Not pushed.

| # | merge commit | lane @ head | conflicts | resolution / semantic fixes |
|---|---|---|---|---|
| 1 | `bf14487` | **th/d-longctx** @`3cba876` (7 commits) | none (lane base = main) | — |
| 2 | `eca5763` | **th/d-gpu-tail** @`cafc6ae` (15 commits) | qwen35.rs, 3 hunks | (1) helper block after `gdn_commit_step()`: kept both sides (longctx `no_attn_fused()`/`causal_mask()`/`prefill_sync_min()` + gpu-tail `gdn_commit_all_on()`); (2) `attn_forward` fused branch: longctx's read-once `!no_attn_fused()` + gpu-tail's `gpuprof::region("attn.core")` (gpu-tail still read `TH_NO_ATTN_FUSED` per call); (3) `forward_inner` entry: longctx's pool trim, then gpu-tail's `gpuprof` phase/region markers. **Semantic fix:** gpu-tail's KV-capacity prefill buffer (`413d8ef`) was sized `(need*2).max(2048)`, not page-aligned; longctx's `split_plan` (attn_kernel.rs:1099-1113) falls back to the single-pass kernel when the capacity is not a whole number of 32-key pages, so decode numerics would have depended on where a slot's capacity was first allocated — a prefix-cache hit (exact-size restore → regrow at the suffix, e.g. 2·1442 = 2884 rows) would take the single-pass kernel while the miss (grid capacity 2048) takes the split kernel. Now `.next_multiple_of(256)` like `ensure_kv` (qwen35.rs:4235). Rows past the visible keys stay zero-filled and masked: output unchanged. |
| 3 | `5e70fb3` | **th/d-sampled** @`8946bce` (6 commits) | none | `DraftSampling` replaces `Option<f64>` temps in propose/select; compiles against gpu-tail's ChunkTop16 select unchanged. New knobs read once. |
| 4 | `e452a7b` | **th/d-prefix-cache** @`0407f89` (21 commits) | qwen35.rs, 6 hunks | (1) helper block: kept all + T1b `attn_gqa()`; (2) `draft_prefill`: T1's `draft_warmup_rows()` (restored `capture_base`) + gpu-tail's `phase("draft_prefill")`; (3–6) `attn_forward` eager tail / new `attn_eager()`: kept gpu-tail's KV-capacity store (with the 256-row alignment) ahead of the `attn_eager` call (T1's side had reverted to storing the exact-length `cat`), kept `region("attn.o")`, took T1b's `attn_eager` body, and replaced its per-call mask closure (grouped and broadcast paths) with longctx's shared `causal_mask()` in q's dtype (qwen35.rs:4293, :4329) — so `a5b911f`'s long-prompt pool fix survives the refactor (same values). **Semantic fixes:** `main.rs:196` — longctx's no-model N3 bench and T1b's eager-attention bench both read `TH_BENCH_ATTN` and the longctx check returned first, making T1b's `TH_BENCH_ATTN=seq:kv,...` probe unreachable; a value containing `:` now selects T1b's bench. `qwen35.rs:5534` — T1's tiny test model gets `gdn_consts: None` (field added by gpu-tail's `gdn_commit_all`; E0063 in `cargo test` only). Checked, no change needed: `prefix_capture` copies the live rows out of gpu-tail's capacity buffers (only exact-size contiguous tensors are shared, and those are never written in place again); `gdn_commit_all` binds per-layer state by GPU address per call; restores allocate via `Tensor::empty` (pool, resident). |

- Pairwise `merge-tree` (read-only) before merging: longctx × gpu-tail, longctx × prefix-cache and gpu-tail × prefix-cache conflict in qwen35.rs; every pair with th/d-sampled is clean.
- Diff vs main: 18 files, +9990 / −667 (engine/src only + Cargo.toml/lock: objc2/block2 become direct deps, both were already in the graph). 53 commits (49 non-merge + 4 merge). Main is an ancestor: landing is a **fast-forward**.
- Build: `cargo build --release` **0 warnings, 0 errors** after every merge; `cargo test --release --no-run` clean.

### 4.1 Gates (one gpu-lock hold 06:05:29–06:18:27, private port :8045, `$W/bin/gates3.sh`, logs `$W/logs/gates/`, load 8–19, thermal 0–2)

Binaries: `th-engine-i3-e452a7b` sha256 `eb3497fbb194857e…` (= the worktree build), tests `th-engine-tests-i3-e452a7b` `6719c3328dc00731…`.

| gate | result |
|---|---|
| `cargo test --release` | **78 passed, 0 failed, 1 ignored** (`bench_row_dist`) = 37 (main) + 9 longctx + 6 gpu-tail + 11 sampled + 15 prefix-cache; every lane's bitwise gate present and passing (`split_attention_matches_single_pass`, `draft_attn_split_matches_single_pass`, `add_rmsnorm_per_row_matches_legacy_bitwise`, `gdn_widths_match_original_bitwise`, `cand_packed_fused_matches_sort_bitwise`, `ring_write_matches_scatter_bitwise`, `draft_presum_producers_match_plain_bitwise`, `gpu_accept_matches_cpu_reference`, `block_rule_is_exact_by_enumeration`, `full_vocab_dist_matches_sorted`, `top_p_prefix_matches_full_sort`, `grouped_attention_is_bitwise_equal_to_broadcast`, `prefix_restore_bitwise_matches_uncached_prefill`, `gdn_parity_rollback_state_bitwise_over_chained_rounds`, `n2_greedy_tie_rule_matches_argmax`, …) |
| `TH_TEST_ROLLBACK=1 TH_BATCH=2` probe (18-token prompt) | **rc 0**: R0a state-bitwise PASS; T1 prefix restore slot0→slot0 and slot0→slot1: logits/state/verify/checkpoint ≠ 0/0/0/0 PASS; legacy logits PASS (worst \|Δ\| 0.125 at kept=1, refwd 0, argmax 68/68/68) |
| same, `TH_BATCH=1` | **rc 0** (state-bitwise PASS, prefix restore slot0→slot0 PASS) |
| same, `TH_ATTN_SPLIT_MIN=1` (N3 split at every length) | **rc 0** |
| same on a **1450-token prompt** (N3 in verify / `rollback_verify` / continuous forward; prefix restore at 1448) | **rc 0** (state-bitwise PASS, prefix restore 0/0/0/0 both slots). Its legacy-logits line prints "FAIL (argmax ref=68 rb=13)": the known check artefact th-d-longctx §5 documents (compares argmaxes at two different positions); the exit code comes from the state-bitwise gate |
| same with `TH_GDN_COMMIT=step` (discrimination arm) | **rc 1**, as designed |
| `TH_BATCH=2 --draft TH_SAMPLE=check`: batch2 (T=0/sampled/N2 mixed pairs) + pc_batch2 (concurrent restores of one checkpoint into both slots) + batch2_long (1.45k pairs, 8k pair) | **35/35 HTTP 200**, 0 panic/WARN/ERROR; **samplecheck 273 rounds, 0 mismatches**; all T=0 slots **byte-identical to integration-2 (= main)** incl. both N2 mixed pairs (`5ae613fd18`); prefix cache: miss == hit == hit-after-pairs (code), hits 8 / misses 18 / errors 0; 1.45k T=0 repeats identical (`155e1756f2`, `91a6e28ec7`, the lanes' shas) |
| `TH_BATCH=4 --draft` spec_batch4 + `POST /engine/kv/clear` + after-clear | **16/16 + 3/3 HTTP 200**, 0 panic/WARN/ERROR, 0 U+FFFD; kv/clear `{"cleared":[0,1,2,3],"ok":true,"prefix_cache_dropped":0,"skipped_live":[]}` (field added by T1) |
| single slot `TH_SAMPLE=check` (sampled 3×3 GPU path/block rule, `top_k 0`+`top_p 0.95` prefix path, `top_k 0`+`top_p 1` id-order path, temperature-only, 1.45k sampled, T=0) | **14/14 HTTP 200; samplecheck 203 rounds, 0 mismatches** |
| `--kv-quant --draft` single slot | **4/4**; the **3 T=0 texts are byte-identical to base 521c6e0** (TurboQuant bypasses N3 and the prefix cache); sampled differs (S1/B1/N4 change sampled trajectories) |
| no draft, single slot (short + 1.45k + 8k plain decode) | **9/9**; the 4 long-spec texts are byte-identical to base |
| no draft, `TH_BATCH=2` | 3/3; the expected single WARN ("requires --draft"), `batch_slots 1` |
| prefix cache on / `=miss` / `=0` over spec_a3 (43 requests: bench, ctx1500, ctxcold, multi-turn, system prompt, 8k, kv/clear) | **hit == miss: 42/42 texts and 42/42 per-round `[dflash]` logs**; on vs `=0`: 35/42 texts (the lane's "default plan changes long-chat-prompt numerics" class; lane d5: 34/42); `/status prefix_cache` hits 17, misses 26, inserts 17, evictions 7, errors 0, reused 41,472 tokens; 1.4k hit TTFT 104–156 ms, 8k exact repeat 498 ms (7424 cached), grid hit 2.7 s (6656 cached) vs cold 16.9 s |
| `/status` contract | 29 → 46 key paths, **0 removed** (added: `prefix_cache.*`); `th_stats` gains `cached_tokens` (additive) |
| per-call env reads | none added: every new knob is a `OnceLock` read (sampled: `TH_SAMPLE`, `TH_SPEC_VERIFY`, `TH_TOP_P`, `TH_DRAFT_FILTER`, `TH_ACCEPT_STATS`; longctx fixed `TH_NO_ATTN_FUSED`/`TH_DEBUG_ATTN`, and the merge kept that) |
| MetalStorage clone-escape class | none introduced by the resolutions (capacity buffers are `Tensor::zeros`; captures `Tensor::empty` + compute copy; no `MetalStorage::new(buffer.clone())`) |

## 5. Landing on main

- `main` = `521c6e0` (unchanged since Phase C); the main working tree had 0 tracked changes (read-only, `GIT_OPTIONAL_LOCKS=0`); it was never edited, built or reset.
- `main` is an ancestor of `report/integration-3`: landing is a **fast-forward** of 53 commits (49 non-merge + 4 merge). If `main` moves first, re-run `git merge-tree --write-tree main report/integration-3`; any new conflict will most likely be in qwen35.rs, engine.rs or dflash.rs.
- Alternative: land the lanes one by one in the same order and resolve exactly as in `eca5763` and `e452a7b` (the resolutions and the three semantic fixes are in those commit messages).

**Ownership.** The other developer's files are `engine/src/{dflash,draft_kernel,engine,main,model,qwen35}.rs`; integration-3 changes all six (qwen35.rs +1244 / −71, engine.rs +846 / −297, dflash.rs +513 / −50, draft_kernel.rs +413 / −1, main.rs +303 / −1, model.rs +42 / −2). Outside it: attn_kernel.rs, attn_bench.rs (new), gdn_kernel.rs, gpuprof.rs (new), quant_kernel.rs, sample_kernel.rs (new), prefix_cache.rs (new), outbuf.rs, server.rs, state.rs, Cargo.toml/lock.

**What changes for them (API / behaviour):**
- **Prefix cache on by default** (T1): `prefill_slot` (engine.rs) is the single prefill path for the single-slot loop and batch admit; checkpoints are shared read-only across slots; `POST /engine/kv/clear` drops them. Default-plan long chat prompts can differ from main at near-ties; `TH_PREFIX_CACHE=grid` gives strict main identity, `=0` disables.
- **First token is emitted before the draft-ring warm-up** (both DFlash paths); the warm-up still runs when the first token ends the request.
- **Sampled DFlash acceptance runs on the GPU** for top-k 1..32 without a repeat penalty, with **block verification** (same output distribution; sampled streams change once vs main); other requests take the bit-exact CPU reference with the token rule. `top_k: 0` means "no top-k" (it panicked on main). `DraftSampling` replaces `Option<f64>` in `draft_propose[_batch]` (model.rs, qwen35.rs, dflash.rs).
- **Long context:** N3 split-key decode attention at ≥ 256 keys and N4 split draft attention (T=0 bench-prompt numerics unchanged; ≥ 256-key requests change at 1–2 ulp near-ties); KV capacity grows in 256-row blocks; long prefills sync every chunk past 2048 tokens.
- **gpu-tail kernels**: all bit-identical by construction and test; the prefill writes K/V into a zero-filled capacity buffer.
- `/status`: `prefix_cache.*` added (29 → 46 key paths, none removed); `th_stats.cached_tokens`, `usage.prompt_tokens_details.cached_tokens`, `/v1/messages usage.cache_read_input_tokens` added; `kv/clear` reply gains `prefix_cache_dropped`.
- **New knobs, all read once:** longctx `TH_ATTN_SPLIT`, `TH_ATTN_SPLITS`, `TH_ATTN_SPLIT_MIN/BASE/PPS/CAP`, `TH_ATTN_SPLIT_P`, `TH_ATTN_SPLIT_SCRATCH`, `TH_DRAFT_ATTN_SPLIT`, `TH_DRAFT_ATTN_KEYS`, `TH_PREFILL_SYNC`; gpu-tail `TH_GPU_PROF[_EVERY]`, `TH_GDN_COMMIT_ALL`, `TH_ARN_LEGACY`, `TH_GDN_WSG`, `TH_GDN_CSG`, `TH_CAND_SORT`, `TH_KV_CAP_PREFILL`, `TH_DRAFT_RING`, `TH_DRAFT_PS`; sampled `TH_SAMPLE`, `TH_SPEC_VERIFY`, `TH_TOP_P`, `TH_DRAFT_FILTER`, `TH_ACCEPT_STATS`; prefix-cache `TH_PREFIX_CACHE[_BLOCK/_ENTRIES/_MARGIN/_MB/_MERGE]`, `TH_ATTN_GQA`, `TH_DEBUG_PREFILL`; probes `TH_BENCH_ATTN*` (`seq:kv` list = T1b bench, otherwise N3 bench), `TH_BENCH_DRAFT_ATTN`, `TH_BENCH_GDN*`, `TH_BENCH_PLAN*`.
- After landing, the live :8001 (pid 71621) is still the old app-attached build; restarting it is the maintainer's call. This report did not touch it.

## 6. Remaining gaps and next levers

### 6.1 Where th-i3 stands

| | th-i3 `e452a7b` | Splash 1.0 | note |
|---|---|---|---|
| T=0 round, bench context | **39.53 ms** | 48.11 | F_k ≈ 36 ms (all matmuls at the measured fit, zero overhead); th-i3 GPU-busy 39.2, idle ≈1.1 |
| round at ≈7.9k | **42.41** | 50.84 | growth +2.9 vs +2.7 ms |
| sampled round − greedy round | **+0.43** | +1.32 | main +3.69 |
| tokens/round on byte-identical text | 124 rounds | 120 rounds | Splash needs 0.968× (Phase C 0.974×) |
| repeated 1.4k prefix TTFT | **139 / 146 ms** | 158 / 142 | parity |
| cold 1.45k TTFT | 2530 ms | **1835** | 1.38× |
| first 8k request TTFT | 17.2 s | **8.0 s** | 2.15× |
| exact 8k repeat TTFT | 509 ms | **154** | 3.3× |

Decode is now ahead of Splash in every measured mode. What is left is **prefill** (every cold or partially cold request) and the last ≈3.5 ms/round above the kernel floor.

### 6.2 Next levers, ranked by user-visible gain

| # | lever | gap it closes [M] | expected [E] | starting point |
|---|---|---|---|---|
| 1 | **Fused causal attention for prefill chunks (> 8 rows)** — candle's `sdpa` (MLX flash kernel; causal with query offset, GQA, head_dim 256) or the N3 tile generalised to 512-row query blocks with split keys | cold 1.45k 2530 vs 1835 ms; first 8k 17.2 vs 8.0 s; 8k repeat 509 vs 154 ms (the repeat re-prefills 104–126 rows over 7.8k keys) | prefix-cache lane probe: 5.4–9.1× per layer over the grouped eager path (1.45k prefill attention ≈545 → ≈87 ms; 8k chunk 91 → 10 ms/layer) ⇒ cold 1.45k ≈ −0.46 s, 8k ≈ −50 %, and the `[24, 512, kv]` transients that drive long-prompt memory disappear. **Not bitwise** vs main (max\|Δ\| 0.003–0.047): needs its own identity baseline | `TH_BENCH_ATTN` sdpa variant (`4f9e367`), th-d-longctx §7 item 1; qwen35.rs `attn_eager`, attn_kernel.rs |
| 2 | **Cold-prefill regression vs main** (+109 to +130 ms at 1.45k, §1.4/§1.5) | th-i3 2530 vs main 2400 ms (f2); 2468 vs 2359 (t1) | captures ≈ +125–170 ms → a reused checkpoint arena (no fresh wired buffers per capture) or captures deferred past the first token; KV-capacity prefill ≈ +90–100 ms → default `TH_KV_CAP_PREFILL=0` (or no zero fill / no double write after `68f3423`). Both off measured −112 / −137 ms vs main | qwen35.rs `prefix_capture`, `attn_forward` KV-capacity store; outbuf.rs |
| 3 | **Prefill Q4 GEMM rate** | th-i3 prefills ≈572 tok/s end to end at 1.45k vs Splash ≈789 | the rest of the cold gap after #1 (≈0.25 s at 1.45k) | T2 prefill tiles, quant_kernel.rs; th-d-prefix-cache §3.7 |
| 4 | **Restore-only exact repeats**: an end-of-prompt checkpoint that also stores the last logits (and finer granularity near the end) | 8k exact repeat 509 vs 154 ms; 1.4k hits re-prefill 24–46 rows | repeats ≈ restore + sample (≈10–20 ms + client) | th-d-prefix-cache §5 item 4 |
| 5 | **The last ≈3.5 ms/round above F_k** at bench context | 39.53 vs ≈36 ms | per-kernel attribution first (R0c: `TH_GPU_PROF=1`, now merged); candidates: draft side (propose 5.8 ms vs a ≈2.9 ms bandwidth floor), N3 threshold 256 → 64–128 keys (≈0.5–0.7 ms/round, changes bench-context numerics), lm_head / norms beyond fit | gpuprof.rs, dflash.rs, attn_kernel.rs `split_cfg` |
| 6 | **Long-context tokens/round** | ctx8k 3.861 vs Splash 4.145 (texts differ on 2 of 3 prompts) | unknown; needs an 8k acceptance study on identical text (R0b-style, many prompts) before any change | dflash.rs ring window, N4 |

Smaller open items: the DFlash anchor off-by-one (`th/c-loop-anchor` @`68f3423`, correct, not merged — it is why gpu-tail's capacity buffers must be zero-filled and why T1 keeps main's ring history); the legacy-logits line of `TH_TEST_ROLLBACK` at long prompts (compares argmaxes at different positions, main.rs); `TH_PHASE_TIME` is still read per forward; review should-fix items 1/2/5 from Phase C (DV=128 guard in the GDN presum producer, `pf_env` `TH_GPU_CORES`, no `AffineQpf` fallback) are untouched; sampled 1.45k/8k (ctxs) timing and a long-context Rao-Blackwellised acceptance check were not run here.

## Appendix A: reproduce

```sh
P=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC; W=$P/work/integration-3
WT=$($P/bin/wt-bootstrap report/integration-3)                 # .worktrees/report/integration-3, start main 521c6e0
git -C $WT merge --no-ff th/d-longctx                           # bf14487, clean
git -C $WT merge --no-ff th/d-gpu-tail                          # eca5763, 3 hunks in qwen35.rs + KV-cap page alignment
git -C $WT merge --no-ff th/d-sampled                           # 5e70fb3, clean
git -C $WT merge --no-ff th/d-prefix-cache                      # e452a7b, 6 hunks in qwen35.rs + TH_BENCH_ATTN routing + test field
(cd $WT/engine && cargo build --release && cargo test --release --no-run)   # 0 warnings
# frozen: $W/bin/th-engine-i3-e452a7b (eb3497fbb194857e…), th-engine-tests-i3-e452a7b (6719c3328dc00731…),
#         th-engine-base-521c6e0 (66e99644…, = main = integration-2)
$P/bin/gpu-lock -- bash $W/bin/gates3.sh $W/logs/gates          # tests, 5 rollback probes, TH_BATCH=2/4, check mode, kv-quant,
                                                                 # no-draft, prefix cache on/miss/off
python3 $W/gates-tools/cmp_arms.py $W/logs/gates/pc pc_miss pc_on   # hit == miss (runs.jsonl = pc_runs.jsonl)
$P/bin/gpu-lock -- bash $W/bench/fin.sh $W/bench/f2              # final hold: block S (8-arm palindrome, 4 modes) + block L
                                                                 # (6-arm palindrome, ctx8k, per-request thermal-0 gate)
bash $W/bench/fin_report.sh $W/bench/f2                          # -> f2/analysis/{all,raw,ab_i3_base,ab_s0,conds,gates}.md
python3 $W/bench/ttft_split.py $W/bench/f2                       # TTFT by cache class
```

- `fin.sh` is th/d-gpu-tail's `q.sh` harness reworked: fixed private port :8045, a fourth arm kind (`i3s0` = the i3 binary with `TH_SAMPLE=cpu TH_SPEC_VERIFY=token`), two-tier per-arm gate (thermal 0 + load1 < 6 held 30 s within 300 s — 900 s for the first arm — else < 9 within 600 s more, else thermal 0 alone), redo on mid-arm contamination (≤ 2 attempts; > 10 % of requests at thermal ≥ 2, > 25 % at load1 ≥ 12, any at ≥ 18, or any error), phys_footprint guard (64 GB) over `$W/bin/th-engine*`, and the per-request thermal-0 wait for ctx8k.
- Client `bench/bq_client.py` (bench-quiet's, from th/d-gpu-tail) with two additions: ctxcold runs 3 × 3 with a unique nonce per request (`Note 1..9`; iteration 1 keeps the historical `Note 1/2/3`), and `--therm-gate-modes` waits outside the timed window for thermal 0 (recorded as `therm_wait_s`). Passages: `passage.txt` sha1 `a886db14acc4` (1373 tokens), `passage8k.txt` sha1 `6ab8ad9a056a` (7853 tokens).
- Analysis: `q_analyze.py` (integration-2 `analyze.py` + th-new-s0), `ab.py` (th phases + id-stream identity), `ttft_split.py`.
- `f1/` is the first attempt of the final hold (06:22–06:26), stopped by me after its first arm: the cold 8k prefills at the end of the arm drove thermal pressure to level 2 within one request. Nothing from f1 is used in the tables.

## Appendix B: cleanup

- **Processes started, and how each was stopped:**
  - Gates (06:05–06:18): 5 `th-engine probe` runs, 1 unit-test run, 9 th-engine servers on :8045 (b2c, b4, s1c, kvq, nd1, nd2, pc_on, pc_miss, pc_off), each SIGTERM → KILL by `gates3.sh`.
  - Final hold attempt f1 (06:22–06:26): 1 th-engine server on :8045; stopped by me (SIGTERM to the session script, whose EXIT trap stopped the server and the samplers; two orphaned sampler shells were then TERMed by pid).
  - Final hold f2 (06:28–08:30): 10 th-engine servers on :8045 and 4 Splash servers (plus their `serve-native` children) on the free :8000, SIGINT → TERM/KILL of any leftover pid; the session's `top`, thermal loop, `gpufreq.py` and phys_footprint guard were killed by its EXIT trap. The guard logged no event.
  - TTFT A/B t1 (08:30–08:50): 12 th-engine servers on :8045, each SIGTERM → KILL.
  - All background waiters and log monitors of this agent were stopped.
- **After the last session:** only pid 71621 listens on :8001 (never touched); :8000 and :8045 are free; no th-engine, splash, session or sampler process of this agent is left; `/tmp/th-engine-gpu.lock` is free.
- **Git:**
  - New worktree `.worktrees/report/integration-3`, branch `report/integration-3` @`e452a7b`: 4 merge commits on `521c6e0`, trailer `Co-Authored-By: Claude Opus 5.5 (1M context)`. Not pushed. Remove with `git worktree remove .worktrees/report/integration-3 && git branch -D report/integration-3`.
  - Nothing was committed to main; the main working tree was never edited, built or reset. The lane branches are unchanged.
- **Work dir:** `$W` = `.worktrees/_phaseC/work/integration-3`: `bin/` (frozen binaries, `gates3.sh`, `fpguard.py`), `gates-tools/` (clients and specs copied from the lanes), `logs/gates/`, `bench/` (harness, `f1/` aborted, `f2/` final hold with `analysis/`, `f2S/` and `f2L/` block views, `t1/` TTFT A/B), `draft/` (report sections), `notes/`.
