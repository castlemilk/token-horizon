> **Provenance.** The original U1 report was written to `$SP/phaseB/impl-th/wp1-utf8-stream.md` (the `/` in the branch name made a directory); that file and the `$SP/phaseB/u1/run{1,2}` artifacts it cites were lost in a scratchpad reset. The text down to "Review fixes" is recovered verbatim from the impl agent transcript. Its numbers and line references are for `2604f8c` on `44aed06`. The **Review fixes** section at the end is current: branch rebased onto `cf3e5f7`, head `3d8a2c6`. Note: `$SP/phaseB/u1/run1/` now holds **this fix pass's** data (labels `basecf3e5f7.*` and `cand3d8a2c6.*`), not the original run1. `$SP/phaseB/u1/ab_run.sh` and `u1_session.sh` were re-created with new arguments, and `ab_run_rev.sh` was not re-created.

# U1: UTF-8-safe incremental detokenization (th/wp1-utf8-stream)

- **Branch:** `th/wp1-utf8-stream`
- **Worktree:** `/Users/benebsworth/projects/token-horizon/.worktrees/th/wp1-utf8-stream`
- **Commit:** `2604f8c` on top of `44aed06`. One commit, clean tree, not pushed.
- **Base binary for A/B:** `$SP/bin/th-engine-44aed06` (sha256 `9a6bad744a23…`). Built in this worktree from untouched 44aed06.
- **Candidate binary:** `$SP/phaseB/u1/th-engine-727ba2c` (sha256 `ecf27b8b1399…`).
  - Built from `727ba2c`, the first version of this commit.
  - `2604f8c` amended it with one `cfg(test)`-only test.
  - Rebuilding `2604f8c` gives a **byte-identical** release binary (`cmp` equal, same sha256).
  - So every candidate number below is the build of `2604f8c`.

## Verdict

**Keep: correctness fix, default on, no switch.**

- **Chinese prompt end to end:**
  - base streams 36 U+FFFD at T=0 and 18 when sampled;
  - the candidate streams 0 in both.
- **Token ids:** identical on all 36 scored requests across 2 runs (T=0, sampled, and Chinese). No divergence anywhere.
- **Other outputs:** `completion_tokens`, `finish`, `/status` and `th_stats` are identical.
- **CPU cost:** +0.09–0.15 µs per token, measured.
- **Loop timing:** within noise. The machine was heavily contended, so see §5 before reading timing into anything.

## 1. What changed and why (`engine/src/engine.rs` only)

**The bug in base:**

- `emit_token` streamed `tokenizer.decode(&[tok], true)`, one token at a time.
- Qwen3.x uses byte-level BPE (ByteLevel decoder, `from_utf8_lossy`). A token can end part-way through a UTF-8 character, so CJK and emoji streamed as U+FFFD halves.
- `stop_hit` matched stop strings against that broken text.
- `truncate_at_stop` only trimmed a local `text_out`. The stop string had already been streamed. `server.rs` builds even the non-stream text by concatenating the deltas, so the truncation had no effect on output.

**The fix, by location (line numbers are at 2604f8c):**

- **engine.rs:255** — the one line inside `generate_blocking`: `let mut text_out = TextOut::default();`, previously `String::new()`. The `EmitCtx { text_out: &mut text_out, … }` literal is unchanged.
- **engine.rs:961 `struct TextOut`** — holds the decoded `text`, `sent` (bytes already streamed), and `prefix`/`read` offsets into `completion` with `prefix_text`. This is the TGI / `tokenizers::DecodeStream` prefix/read-offset scheme.
  - It stores plain offsets and borrows nothing. The cursor therefore survives a fresh `EmitCtx` per token, which is how the other developer's WIP batched path builds them.
- **engine.rs:976 `TextOut::advance`** — decodes `completion[prefix..]` and appends only what lies past `prefix_text`.
  - It holds back while the window still ends in U+FFFD, or when the new ids decode to nothing (skipped special tokens).
  - `flush` (the final token) forces the rest out as decoded.
  - If a decoder is not prefix-stable, it falls back to decoding the new ids alone.
  - The left context also fixes SentencePiece `Strip` decoders, which lost leading spaces one token at a time (test below).
- **engine.rs:1019 `emit_token`:**
  - EOS or length (`max_tokens`/`max_ctx`) marks the token as final, and the final token flushes.
  - EOS itself is never decoded.
  - Stop matching goes through `find_stop` (**:912**). It scans only the new tail plus an overlap of `len(stop)-1`, and takes the earliest match. The text is truncated there, the stop string is **not** sent, and `finish = "stop"`.
  - Without a stop hit, `stop_holdback` (**:929**) holds back a tail that could still become a stop string. This only happens when stops are set.
  - Deltas are sent only when non-empty.
  - A token that sends nothing still notices a dropped client through `tx.is_closed()`. This keeps per-token cancel latency the same, since base sent every token.
  - Finish precedence matches base:
    - A send failure on a non-EOS token means "cancelled".
    - EOS stays "stop".
    - A stop wins over length.
- **Removed:** `stop_hit` and `truncate_at_stop`, replaced by `find_stop` and `stop_holdback`.
- **Unchanged:** token ids, sampling, the decode loops, `completion`/`hist` pushes, `kv_tokens`, `FirstToken`, `/status`, `th_stats`, `server.rs`.
- **Requests without stop strings:** the only visible difference is that a delta can now carry more than one token's text, and never half a character.

### Merge note for the other developer's multi-slot WIP (main working tree)

- Their batched path builds `EmitCtx` in `admit()` and in `batch_round()`, once per token, and declares `Run { text_out: String }` with `text_out: String::new()`.
- After merging U1 it needs two edits:
  - `text_out: TextOut` in `struct Run`;
  - `text_out: TextOut::default()` in `admit()`.
- The `EmitCtx` literals themselves compile unchanged.

**Hunk locations for rebase planning (all outside their :144-575 region except :255):**

| Location | Content |
|---|---|
| :255 | one line |
| :909-1058 | stop helpers, `TextOut`, `EmitCtx`, `emit_token` |
| :1080-1350 | `#[cfg(test)] mod utf8_stream` |

Their diff touches :245, :315, :346-461, :530 and :576, so no textual overlap is expected.

## 2. Unit tests: `cargo test --release utf8_stream` (8 pass)

- **Location:** `engine/src/engine.rs:1080 mod utf8_stream`.
  - The crate is bin-only, so `engine/tests/*.rs` cannot reach `emit_token`.
  - The filter `utf8_stream` selects exactly these tests.
- **How they run:** every test drives the real `emit_token` with a fresh `EmitCtx` per token.
- **What they assert:**
  - concatenated deltas == `decode(all_ids)`;
  - no U+FFFD in any delta;
  - no empty deltas;
  - the finish reason.

| test (line) | what it proves |
|---|---|
| `utf8_stream_byte_tokens` (:1209) | Hermetic byte-level BPE where every byte is its own token, over `TEXT` = `"你好，世界！🙂👍🏽 これは日本語です。🎉 한국어 𠮷野家 🧑‍🚀 café ✓"`. Asserts the old per-token decode does produce U+FFFD. |
| `utf8_stream_straddling_tokens` (:1223) | Tokens that start and end mid-character: `[E4 BD][A0 E5][A5 BD F0][9F 99][82 21]` = "你好🙂!". |
| `utf8_stream_qwen_tokenizer` (:1238) | **Real Qwen3.8 tokenizer.json** from the HF snapshot, or `TH_TEST_TOKENIZER`. CJK and emoji ids from `encode(TEXT)`, which splits characters, plus `<\|im_end\|>`. Skips with a message if the file is missing. |
| `utf8_stream_cjk_stop_string` (:1254) | Stop `"世界"` on byte tokens: output `"你好，"`, finish stop, stop string never streamed. |
| `utf8_stream_stop_prefix_held_back` (:1263) | Stop `"abc"` on `"xxabxabcyy"`: the first "ab" is held, then released. Output `"xxabx"`. |
| `utf8_stream_flush_at_end` (:1273) | Held tail flushed at EOS and at max_tokens. A max_tokens cut mid-character flushes exactly `decode(ids)` = `"a\u{FFFD}"`. |
| `utf8_stream_cancel_while_held_back` (:1295) | Dropped receiver plus a held partial byte gives `Done("cancelled")`. |
| `utf8_stream_sentencepiece_decoder` (:1323) | Llama-style decoder (Replace ▁ / ByteFallback / Fuse / Strip). Base per-token output was `"Helloworld"` plus 3× U+FFFD; now exactly `"Hello world 你!"`. |

**Mutation checks (each one applied, run, then reverted):**

| Mutation | Tests that fail |
|---|---|
| Disable the U+FFFD holdback (`if false && …`) | byte_tokens, straddling, qwen, cjk_stop (4) |
| `stop_holdback` → 0 | cjk_stop, stop_prefix_held_back |
| Never flush | flush_at_end |
| Drop the `is_closed` check | cancel_while_held_back |

**Full suite:** `cargo test --release` gives 16 tests; 15 passed at `727ba2c`, and the 16th is the SentencePiece test.

**V-build:** `cargo build --release` has no new warnings. The only warning is the pre-existing `draft_kernel.rs:10` unused import, also present in base.

**CPU cost** (throwaway microbenchmark, not committed): real Qwen tokenizer, 2,200-token mixed English/CJK/emoji text, 5 passes.

| Path | ns/token | Notes |
|---|---|---|
| Old: `decode(&[t])` + whole-text `contains` | 334 | |
| New: `emit_token`, no stops | 422 | Includes `EmitCtx` + channel send; 1,960 deltas |
| New: `emit_token`, 1 stop | 481 | |

- The Δ of +0.09–0.15 µs/token is about 0.0005% of a ~25 ms token.
- There are no env reads on the per-call path. `TH_TEST_TOKENIZER` is read only in tests.

## 3. End-to-end A/B on :8014 (T=0 token identity, sampled, Chinese)

**Protocol:**

- Serve with `TH_DEBUG_TIMING=1 BIN serve --model $TGT --draft $DRAFT --port 8014`, one binary at a time, both under a single `gpu-lock` hold.
  - **run1:** base, then candidate.
  - **run2:** candidate, then base (reversed order, for an ABBA view).
- **Bench prompts:** the 3 prompts from `bench-engines.sh` (short, code, long), `max_tokens` 128, streaming.
  - **T=0:** ×2 reps.
  - **Sampled:** T=0.6, top_p 0.95, top_k 20 sent explicitly, seeds 1/2/3.
- **Chinese prompt:** "用中文写一首关于秋天的短诗（四行），每行末尾加一个表情符号🍂，然后用一句话解释诗的意境。", `max_tokens` 400.
  - T=0 streaming;
  - T=0 non-streaming, which gives the final text;
  - sampled seed 1, streaming.
- **Warm-up:** one request, not scored.
- **Token ids:** taken per request from the `[dflash] … emitted=[…]` lines in that request's server-log range.
  - TH_DEBUG_TIMING logs neither the first token nor the final round.
  - Coverage is therefore 1,942 of 2,015 completion tokens per run.
  - For the rest: `completion_tokens`, `finish` and the full SSE text are compared.

**Token-id identity (both runs):**

- 18/18 requests per run show **first divergence: none**.
- `completion_tokens` equal on 18/18 (2,015 total); `finish` equal on 18/18.
- SSE text byte-identical on 15/15 bench requests.
- Chinese text differs **only** where base emitted U+FFFD.
  - Removing U+FFFD from base and the non-BMP characters from the candidate gives equal strings.
  - The 12 🍂 emoji are 3 tokens each: 36 U+FFFD at T=0, 18 in the sampled run (6 🍂).
- T=0 is deterministic within each binary: rep1 ids == rep2 ids for all 3 prompts, in both binaries.

**Chinese end-to-end check (identical in run1 and run2):**

| | base 44aed06 | candidate 2604f8c |
|---|---|---|
| T=0 stream: completion tokens / deltas | 227 / 226 | 227 / 202 |
| U+FFFD in SSE deltas (T=0) | **36** (in 36 deltas) | **0** |
| U+FFFD in non-stream final text | 36 | 0 |
| concat(stream deltas) == non-stream final text | yes (both broken) | **yes** |
| U+FFFD, sampled seed 1 (131 tokens) | 18 | 0 |
| empty deltas | 0 | 0 |
| wire strictly valid UTF-8 | yes | yes |
| non-BMP chars (🍂) in text | 0 | 12 |

Candidate answer, excerpt: `风过枫林染晚霜🍂 / 雁声遥落旧池塘🍂 / 一盏茶凉秋意长🍂 / 人间忽晚又斜阳🍂`.

**Contract (V-contract):**

- The `/status` key paths are identical between base and candidate.
- `th_stats` keys are identical:
  - stream: `ttft_ms`, `decode_tps`, `prefill_tps`, `total_ms`;
  - non-stream: the same plus `spec_rounds` and `spec_accepted`.

## 4. Loop aggregates (TH_DEBUG_TIMING, ratio of sums, bench prompts only)

Tokens are the logged emitted tokens; the first token and the final round are excluded, identically in both arms.

| run | arm | group | rounds | tokens | ms/round | tokens/round | loop tok/s | propose / verify / rest (mean ms) |
|---|---|---|---|---|---|---|---|---|
| run1 (A→B) | base 44aed06 | T=0 | 160 | 552 | 135.52 | 3.450 | 25.46 | 40.9 / 89.1 / 5.5 |
| run1 | cand 2604f8c | T=0 | 160 | 552 | 111.60 | 3.450 | 30.91 | 22.2 / 86.0 / 3.5 |
| run1 | base | sampled | 235 | 826 | 131.76 | 3.515 | 26.68 | 33.5 / 86.0 / 12.2 |
| run1 | cand | sampled | 235 | 826 | 115.75 | 3.515 | 30.37 | 21.8 / 85.4 / 8.6 |
| run2 (B→A) | base | T=0 | 160 | 552 | 112.44 | 3.450 | 30.68 | 19.4 / 90.3 / 2.8 |
| run2 | cand | T=0 | 160 | 552 | 119.55 | 3.450 | 28.86 | 21.3 / 95.0 / 3.2 |
| run2 | base | sampled | 235 | 826 | 145.04 | 3.515 | 24.23 | 35.3 / 95.9 / 13.7 |
| run2 | cand | sampled | 235 | 826 | 110.04 | 3.515 | 31.94 | 18.7 / 83.7 / 7.7 |
| pooled | base | all bench | 790 | 2756 | 132.55 | 3.489 | 26.32 | |
| pooled | cand | all bench | 790 | 2756 | 113.98 | 3.489 | 30.61 | |

Tokens/round are identical by construction, because the token ids are identical.

## 5. Timing caveat: do not read a gain into §4

- **The machine was not quiet in any session:**
  - loadavg 25–66 on 18 cores, from concurrent agent cargo/LTO builds, a VM at 350% CPU, and Next.js builds;
  - "Codex (Service)", which belongs to the other developer and was not touched, at 21–40% GPU busy;
  - `waitquiet` timed out in all 4 sessions at 37–48% total GPU busy.
- **Why the candidate looks faster:** the base–candidate gap is almost entirely in the propose/rest tail.
  - Rounds with propose > 40 ms: base 110 (run1) and 72 (run2); candidate 6 and 0.
  - Verify medians are equal: 81/84 and 88/86 ms.
  - The propose tail is the CPU-contention / sync-wake signature (SYNTHESIS Q1). loadavg was rising during both base sessions (25.7→55.7 and 27.4→41.7) and falling during both candidate sessions.
  - The sign flips at T=0 between runs: base 135.5 vs 111.6 in run1, then 112.4 vs 119.6 in run2.
  - The same binary moves by 23 ms/round between runs.
- **Why U1 cannot be the cause:**
  - U1 changes no loop, GPU or sync code.
  - Its only cost is the +0.1 µs/token measured in §2.
  - The bench prompts produce the same number of SSE deltas in both arms (29/128/128).
- **Conclusion:** no regression. The ~14% candidate-favourable delta is contention noise.
- All numbers are far above the quiet 441acec baseline of 87.2 ms/round because of the contention. They are not comparable to other agents' quiet numbers.
- V-lin and V-multi were skipped as instructed: no kernel change. No GPU buffer or custom-op code was touched, so the untracked-Arc bug class does not apply.

## 6. Exact commands

```sh
export SP=/private/tmp/claude-501/-Users-benebsworth-projects-token-horizon/23793a29-ce9d-4130-926c-f9e358304530/scratchpad
WT=$($SP/bin/wt-bootstrap th/wp1-utf8-stream)          # /Users/benebsworth/projects/token-horizon/.worktrees/th/wp1-utf8-stream
(cd $WT/engine && cargo build --release) && cp $WT/engine/target/release/th-engine $SP/bin/th-engine-44aed06   # base, untouched 44aed06
# implement → commit 727ba2c (amended to 2604f8c: +1 cfg(test) test, binary byte-identical)
(cd $WT/engine && cargo test --release utf8_stream)   # 8 passed
(cd $WT/engine && cargo test --release)               # 16 total; 15 passed at 727ba2c + the SentencePiece test
(cd $WT/engine && cargo build --release) && cp $WT/engine/target/release/th-engine $SP/phaseB/u1/th-engine-727ba2c
# A/B (each session: serve on :8014 with TH_DEBUG_TIMING=1, u1_client.py, kill)
$SP/bin/gpu-lock --timeout 5400 -- $SP/phaseB/u1/ab_run.sh     $SP/phaseB/u1/run1   # base → cand
$SP/bin/gpu-lock --timeout 5400 -- $SP/phaseB/u1/ab_run_rev.sh $SP/phaseB/u1/run2   # cand → base
python3 $SP/phaseB/u1/u1_analyze.py  $SP/phaseB/u1/runN base44aed06 cand727ba2c     # ids A/B + aggregates + zh
python3 $SP/phaseB/u1/u1_contract.py $SP/phaseB/u1/runN base44aed06 cand727ba2c     # /status + th_stats keys
python3 $SP/phaseB/u1/u1_phase.py    $SP/phaseB/u1                                  # per-phase distributions
```

**Artifacts:**

- `$SP/phaseB/u1/run{1,2}/`, containing:
  - `{base44aed06,cand727ba2c}.{server.log,jsonl,status.json}`, with per-request SSE deltas;
  - `analysis.txt`, `contract.txt`, `ab_base44aed06_vs_cand727ba2c.json`, `ab_run.txt`.
- `$SP/phaseB/u1/phase.txt`, and `run1/zh_diff.txt`.
- Scripts: `u1_client.py`, `u1_session.sh`, `u1_analyze.py`, `u1_contract.py`, `u1_phase.py`, `ab_run.sh`, `ab_run_rev.sh`.

**Cleanup:**

- Every th-engine I started (pids 40528, 45208, 77682, 81355) was stopped with SIGTERM; nothing is listening on :8014.
- :8000 and :8001 were never touched.
- The main working tree was never modified. Only `git diff` was read, to plan hunks around the other developer's edits.

---

## Review fixes (fix pass, 2026-09-25/26): rebased onto main `cf3e5f7`

### Finding addressed

**[high, must-fix] Branch conflicted with main `cf3e5f7`, and the merged batched decode path did not compile.**

- Main landed `de110be`, `502cf15` and `cf3e5f7`: the multi-slot snapshot/restore/rollback refactor plus batched decode behind `TH_BATCH>1`.
- Both main and this branch appended after `ngram_draft`, so `git merge-tree` reported a conflict in `engine/src/engine.rs`.
- After a textual resolution, main's `Run.text_out: String` no longer type-checked. rustc gave E0308 at `EmitCtx { text_out: &mut run.text_out }` in `admit()` and `&mut r.text_out` in `batch_round()`: it expected `&mut TextOut` and found `&mut String`.

### What was done (worktree `.worktrees/th/wp1-utf8-stream`, branch `th/wp1-utf8-stream`)

1. **Rebase.** Ran `git rebase cf3e5f7`.
   - The conflict markers sat at engine.rs:1119/1581/1850.
   - Resolution: main's batched block (`// MARK: - batched decode` through the body of `finish_run`), then its closing `}` and a blank line, then the U1 `#[cfg(test)] mod utf8_stream`, then the shared trailing `}`.
   - Each side had lost its closing brace to that shared `}`, so both braces are restored.
2. **Two lines in main's batched code:**
   - engine.rs:1147, in `struct Run`: `text_out: String,` became `text_out: TextOut,`.
   - engine.rs:1278, in `admit()`: `text_out: String::new(),` became `text_out: TextOut::default(),`.
   - The `EmitCtx` literals at :1296 (`admit`) and :1476 (`batch_round`) are unchanged.
   - This is semantically correct: both sites build a fresh `EmitCtx` per token over the run's own `completion`, and the `TextOut` cursor is plain offsets.
3. **U1 commit, `2604f8c` → `4c84f0a`** (parent `cf3e5f7`).
   - One paragraph added to the commit message about the batched path.
   - `git range-diff 44aed06..2604f8c cf3e5f7..3d8a2c6` shows all U1 hunks unchanged. The only code delta is the two `Run` lines.
4. **New test commit `3d8a2c6`: `utf8_stream_interleaved_slots`** (engine.rs:1857, `cfg(test)` only).
   - Two slots, each with its own `TextOut`, and a fresh `EmitCtx` per token.
   - Lockstep rounds of 1..=8 tokens that end mid-character (the `admit`/`batch_round` shape).
   - Absolute KV positions offset by a per-slot prompt length.
   - A CJK stop string (`落叶`) on one slot.
   - Asserts that each slot's deltas equal its solo `stream()` output, with whole characters only.
   - Release binaries of `4c84f0a` and `3d8a2c6` are **byte-identical** (`cmp`, sha256 `476822a75022…`).

**Branch state:**

- `cf3e5f7 ← 4c84f0a (U1) ← 3d8a2c6 (test)`. Clean tree, not pushed.
- `git merge-tree --write-tree main th/wp1-utf8-stream` exits 0.
- main (`cf3e5f7`) is an ancestor, so the merge is a fast-forward.
- The main working tree has no uncommitted `engine/` changes at the time of this pass (checked read-only with `GIT_OPTIONAL_LOCKS=0`).

### Builds used below

| arm | commit | how | binary | sha256 |
|---|---|---|---|---|
| base | `cf3e5f7` clean | built in this worktree with a detached checkout, before the rebase | `$SP/phaseB/u1/th-engine-cf3e5f7` | `ba54c13cb83e…` |
| candidate | `3d8a2c6` clean (= `4c84f0a` binary) | built in this worktree | `$SP/phaseB/u1/th-engine-3d8a2c6` | `476822a75022…` |

### Gates

| gate | result |
|---|---|
| **V-build** | **PASS**. `cargo build --release` gives **0 warnings**; base `cf3e5f7` also gives 0. At `cf3e5f7` main added `#[allow(unused_imports)]` at draft_kernel.rs:10, so the old pre-existing warning is gone. |
| **Unit (U1)** | **PASS**. `cargo test --release` gives **17/17**: 8 pre-existing plus 9 `utf8_stream`. `cargo test --release utf8_stream` gives 9/9, including the real-Qwen-tokenizer case. |
| Reviewer adversarial tests (extra) | **PASS 7/7**, including the 3000-case fuzz. These are the 7 `review_*` tests from `$SP/review-u1-engine-with-review-tests.rs`, applied temporarily to the rebased tree, run, then reverted (not committed). |
| **V-lin** (`TH_BENCH_LIN=1 probe`, 18-token id list `$SP/phaseB/u1/probe18.txt`) | **PASS on correctness**: all 28 `max\|Δ\|` lines are identical base vs candidate, and the probe's top-8 logits are identical. Per-kernel single-shot ms/GB/s: geomean 1.103, range [0.93, 1.31]. That is inside the contemporaneous A/A noise band (0.73–1.40) for identical kernels, and the kernel source is untouched; see the V-lin timing noise section. |
| **V-multi 8** | **PASS**. fwd1: base 46.4 / 46.8 / 46.9 ms vs candidate 45.7 / 45.9 / 46.8. fwd8: base 49.1 / 48.5 / 48.5 vs candidate 49.1 / 48.4 / 48.5. |
| **T=0 A/B, single slot** (:8014, gpu-lock) | **PASS**. **18/18 requests: first divergence none.** Ids came from the `[dflash]` lines (1942 of 2015 completion tokens logged, the same coverage as the original run). completion_tokens (2015 total) and finish are equal on 18/18. Bench SSE text is byte-identical on 15/15. zh text differs only where base emitted U+FFFD. T=0 rep1 == rep2 within each binary. |
| **Batched path, `TH_BATCH=2`** (:8014, gpu-lock) | **PASS**. nb=1: 6/6 non-stop requests identical. nb=2: identical wherever the batch composition matched; divergences track composition, not U1 (details below). The candidate has 0 U+FFFD, 0 empty deltas and valid UTF-8 on all 16 scored batched requests (8 nb=1, 8 nb=2). No batch errors are logged in either arm. |
| **Stop strings** (new) | **PASS**. The candidate cuts exactly before the stop and never streams it, in single-slot, nb=1 and nb=2 alike. Base leaks the stop (秋) or never fires (🍂). |
| **V-contract** | **PASS**. `/status` key paths are identical. `th_stats` keys are identical in single-slot and batched sessions: stream gives `decode_tps, prefill_tps, total_ms, ttft_ms`; non-stream adds `spec_accepted, spec_rounds`. |

### Chinese prompt, end to end

`$SP/phaseB/u1/run1`; T=0 unless noted; max_tokens 400.

| | base single | cand single | base TH_BATCH nb=1 | cand TH_BATCH nb=1 |
|---|---|---|---|---|
| completion tokens | 227 | 227 | 228 | 228 |
| SSE deltas | 226 | 202 | 227 | 203 |
| U+FFFD in stream | **36** | **0** | **36** | **0** |
| U+FFFD in non-stream final text | 36 | 0 | 36 | 0 |
| concat(deltas) == non-stream final | yes | yes | yes | yes |
| U+FFFD, sampled (0.6/0.95/20; seed 1 single, seed 1 b1) | 18 (131 tok) | 0 (131 tok) | 33 (227 tok) | 0 (227 tok) |
| non-BMP chars (🍂) | 0 | 12 | 0 | 12 |
| empty deltas / invalid UTF-8 on the wire | 0 / no | 0 / no | 0 / no | 0 / no |

The batched path's greedy output (228 tokens) differs from single-slot (227) in **both** arms. It is a different kernel and row layout; it is a property of main, not of U1.

### Stop strings

T=0 zh prompt; compared with the same session's uncut T=0 zh run.

| request | base `cf3e5f7` | candidate `3d8a2c6` |
|---|---|---|
| `stop:["🍂"]`, single slot | never fires: 227 tokens, text == uncut zh (36 U+FFFD) | **24 tokens**, `finish=stop`, text == zh cut before 🍂 (`…每行末尾加一个表情符号`), 🍂 not streamed |
| `stop:["秋"]`, single slot | 8 tokens, but streams `…关于秋天的`: stop plus 2 chars leaked (`秋天的` is one token) | 8 tokens, text == zh cut before 秋 (`…写一首关于`, 12 chars), 7 deltas, 秋 not streamed |
| `stop:["🍂"]`, TH_BATCH nb=1 | never fires (228 tokens) | 24 tokens, cut before 🍂 |
| `stop:["秋"]`, TH_BATCH nb=1 | 8 tokens, leaks `秋天的` | 8 tokens, cut before 秋 |
| `stop:["🍂"]`, TH_BATCH nb=2 (paired) | never fires (230 tokens) | 24 tokens, cut before 🍂 |

In the single-slot session, the stop requests' logged ids are a prefix of the uncut zh ids in both arms.

### Batched decode (`TH_BATCH=2`): per-request A/B and batch composition

- **Sequential requests (nb=1).**
  - short/code/long: text byte-identical, same completion_tokens and finish.
  - zh T=0 stream, zh final and zh sampled: same completion_tokens (228/228/227) and finish.
  - The candidate text equals base with each U+FFFD run replaced by a U+FFFD-free character run (`fffd_consistent`).
  - Result: **6/6 identical**.
- **Concurrent pairs (nb=2).** Per-round `[batch] nb=` sequences in each pair's log range:

| pair (client start skew < 1 ms) | base: rounds → tokens | candidate: rounds → tokens |
|---|---|---|
| code + zh, rep1 | `nb2x32 nb1x38` → 128 + 230 | `nb1x1 nb2x32 nb1x28` → 128 + **156** |
| code + zh, rep2 | `nb2x32 nb1x38` → 128 + 230 | `nb2x32 nb1x38` → 128 + **230** (== base) |
| long + zh, sampled seed 2 | `nb1x1 nb2x42 nb1x21` → 128 + 220 | `nb1x1 nb2x43 nb1x1` → 128 + 120 |
| stop_leaf + zh final | `nb1x1 nb2x60 nb1x10` → 230 + **156** | `nb2x4 nb1x60` → **24** + 157 |

- Whenever the composition matched, the outputs matched: base rep1, base rep2 and cand rep2 give the same 230-token zh output, and code is exact in all four.
- The candidate's rep1 lost the admission race: one slot was admitted a round early (`nb1x1`), and zh came out at 156 tokens. **The candidate's rep1 ≠ its own rep2.**
- Base's output also changes with composition. In its zh-final pair (`nb1x1 nb2x60 nb1x10`), zh came out at 156 tokens, against 230 in its matched reps.
  - This is a *different* text from the candidate's 156-token rep1; the equal length is coincidental (checked with `fffd_consistent`).
  - The candidate's rep1 and rep2 diverge at character 68.
- In the stop pair, U1's correct 🍂 stop ends the partner at 24 tokens instead of 230. The zh request therefore runs mostly at nb=1, which changes its numerics (157 tokens).
- So nb=2 greedy output in main's batched path depends on co-scheduling and admission timing. U1 does not cause this; it is a finding for the batched-decode owner. U1's per-slot stream correctness under interleaving is pinned by `utf8_stream_interleaved_slots`.
- `[batch]` round means are informational only. base: nb=1 477 rounds at 45.3 ms, nb=2 166 at 62.8 ms. candidate: nb=1 430 at 39.8 ms, nb=2 111 at 76.3 ms. The round mixes differ, and `total` is measured t0→`forward_batch` return, so these are not a speed metric.

### V-lin timing noise: single-shot per-kernel timings are not a regression signal

- **What V-lin measures.** Each `qmm[...] ms/GB/s` line is one timed pass. U1 changes only engine.rs; `bench_lin` (qwen35.rs) and the Metal kernels are untouched, and the probe's top-8 logits are identical.
- **Correctness.** `max|Δ|` is identical on 28/28 lines. That is the correctness half of the V-lin criterion.
- **Timing, base `cf3e5f7` → cand `3d8a2c6` (run1, back to back).**
  - Geomean ratio over the 42 non-gate_up timing lines: **1.103**, range [0.93, 1.31].
  - gate_up / down: −17% to 0%. lm_head: mixed, −6% to +17%. in_all / out / in_qkv / o: −7% to +31%.
  - This is a drift within the session, not a per-kernel pattern.
- **Contemporaneous A/A band.** Same harness, same machine, same lock, wp2's `queue3` at 00:13–00:14, `…/wp2-q4-decode/engine/target/wp2/logs/probe-{base,k1,p0}-lin.log`.
  - K1 and P0 change only the m=2..8 decode routing. Every m=1 / prefill-m64 line excluding gate_up therefore runs identical kernels.
  - base 44aed06 → K1: geomean **0.728** [0.47, 1.07].
  - K1 → P0: **1.397** [0.89, 2.00].
  - base → P0: 1.017 [0.76, 1.38].
  - The U1 delta (1.103) is well inside this A/A noise.
- **V-multi**, the end-to-end forward over the same kernels, is equal: fwd1 median 46.8 vs 45.9 ms, fwd8 48.5 vs 48.5 ms.

### Loop timing, single slot

TH_DEBUG_TIMING `[dflash]`, bench prompts only, ratio of sums. First token and final round are excluded identically in both arms.

| run | arm | group | rounds | tokens | ms/round | tokens/round | loop tok/s | propose / verify / rest (mean ms) |
|---|---|---|---|---|---|---|---|---|
| run1 (base→cand) | base cf3e5f7 | T=0 | 160 | 552 | 98.22 | 3.450 | 35.12 | 21.4 / 74.3 / 2.6 |
| run1 | cand 3d8a2c6 | T=0 | 160 | 552 | 78.60 | 3.450 | 43.89 | 13.9 / 62.9 / 1.8 |
| run1 | base | sampled | 235 | 826 | 101.81 | 3.515 | 34.52 | 24.0 / 70.6 / 7.2 |
| run1 | cand | sampled | 235 | 826 | 81.88 | 3.515 | 42.93 | 14.5 / 61.6 / 5.8 |
| run1 | base | all bench | 395 | 1378 | 100.36 | 3.489 | 34.76 | 23.0 / 72.1 / 5.3 |
| run1 | cand | all bench | 395 | 1378 | 80.55 | 3.489 | 43.31 | 14.2 / 62.1 / 4.2 |

- **Per-round distribution (run1):**
  - base: propose p90 35 ms, max 161 ms, **25 rounds with propose > 40 ms**, verify median 69 ms.
  - candidate: propose p90 16 ms, max 29 ms, 0 such rounds, verify median 62 ms.
- **CPU load (not a quiet machine):**
  - base ran while loadavg rose from 30.3 to 47.7;
  - the candidate ran while it fell from 47.7 to 23.7.
- The GPU had no other users (WindowServer at 2.5–3.1%) and the lock was held throughout.
- U1 changes no loop, GPU or sync code. Its CPU cost is about +0.1 µs/token (§2), and the bench prompts send the same number of SSE deltas in both arms (29/128/128).
- **Order confound, not resolved in this pass.** The single-slot pair ran base first. A reversed-order run2 (plus a V-lin ABAB) was queued under gpu-lock at 00:03:14 and **cancelled at 00:57 without running**, after ~54 min of waiting: wp2's 50+ job `queue3` held the lock and 7–10 other clients were queued. No numbers exist from it.
- **Prior evidence with identical U1 code.** The original ABBA on 44aed06 (§4 above) had the sign flip at T=0 between orders: base 135.5 vs cand 111.6 in run1, then base 112.4 vs cand 119.6 in run2.
- **Conclusion.** No regression. The single-slot timing delta here is not attributable to U1, and no speed gain is claimed.

### Exact commands (this fix pass)

```sh
export SP=/private/tmp/claude-501/-Users-benebsworth-projects-token-horizon/23793a29-ce9d-4130-926c-f9e358304530/scratchpad
WT=/Users/benebsworth/projects/token-horizon/.worktrees/th/wp1-utf8-stream; U=$SP/phaseB/u1
# base binary: untouched cf3e5f7, built in this worktree
git -C $WT checkout --detach cf3e5f7 && (cd $WT/engine && cargo build --release) && cp $WT/engine/target/release/th-engine $U/th-engine-cf3e5f7
git -C $WT checkout th/wp1-utf8-stream && git -C $WT rebase cf3e5f7        # CONFLICT engine.rs (EOF hunk)
#   resolve: main batched block + '}' + mod utf8_stream + '}'; Run.text_out: TextOut; admit(): TextOut::default()
(cd $WT/engine && cargo build --release)                                  # V-build: 0 warnings
git -C $WT add engine/src/engine.rs && GIT_EDITOR=true git -C $WT rebase --continue && git -C $WT commit --amend -F <msg>   # 4c84f0a
# + utf8_stream_interleaved_slots → commit 3d8a2c6 (test-only; 4c84f0a/3d8a2c6 release binaries cmp-identical)
(cd $WT/engine && cargo test --release)                                   # 17 passed
(cd $WT/engine && cargo test --release utf8_stream)                       # 9 passed
cp $WT/engine/target/release/th-engine $U/th-engine-3d8a2c6
# GPU (one lock hold each):
$SP/bin/gpu-lock -- bash -c "$U/ab_run.sh $U/run1; $U/probe_run.sh $U/run1"   # run1: base.s cand.s cand.b(TH_BATCH=2) base.b, V-lin x2, V-multi 8 x2
$SP/bin/gpu-lock -- $U/run2.sh $U/run2                                        # run2 (V-lin ABAB + reversed pair): queued, CANCELLED before acquiring the lock
# analysis
python3 $U/u1_analyze.py     $U/runN basecf3e5f7.s cand3d8a2c6.s   # token-id A/B, loop aggregates, zh checks
python3 $U/u1_contract.py    $U/runN basecf3e5f7.s cand3d8a2c6.s   # (and .b) /status + th_stats keys
python3 $U/u1_fix_analyze.py $U/run1 basecf3e5f7 cand3d8a2c6       # batched A/B, stop strings, [batch] rounds
python3 $U/u1_phase.py       $U/runN basecf3e5f7.s cand3d8a2c6.s   # per-round phase distributions
python3 $U/probe_cmp.py      $U/run1 basecf3e5f7 cand3d8a2c6       # V-lin max|Δ| identity + timings, V-multi
```

**Harness and artifacts** (all under `$U = $SP/phaseB/u1`):

- **Scripts recovered from the impl transcript:** `u1_client.py` (extended with two stop-string requests), `u1_analyze.py`, `u1_contract.py`, `u1_phase.py`.
- **Scripts new or adapted:**
  - `u1_session.sh`: CLIENT argument plus extra env; a `gpuusers.py` snapshot replaces the lost `waitquiet.py` and `gpusnap.py`.
  - `u1_batch_client.py`: nb=1 sequential requests plus nb=2 barrier-synchronised pairs.
  - `u1_fix_analyze.py`, `probe_cmp.py`, `ab_run.sh`, `probe_run.sh`, `run2.sh`.
  - `probe18.txt`: 18 fixed Qwen ids, whole-word vocab pieces of "The quick brown fox jumps over the lazy dog. The capital of France is Paris, and".
- **Outputs:** `run1/` holds (`run2/` has only `driver.log`, since it was cancelled) `{label}.{server.log,jsonl,status.json}`, `*.vlin*.log`, `*.vmulti8.log`, `analysis.s.txt`, `phase.s.txt`, `contract.{s,b}.txt`, `fix_analysis.{txt,json}`, `probe_cmp.txt` and `driver.log`.

### Cleanup

- Four servers were started on :8014, one per run1 session: base.s pid 33564, cand.s 38119, cand.b 43208 and base.b 49523.
  - All four were stopped with SIGTERM inside the session script, and `kill -0` confirms each is gone.
  - Nothing is listening on :8014.
- The probe runs (V-lin/V-multi) were one-shot processes and have exited.
- The run2 gpu-lock waiter (pid 70412) was terminated before it acquired the lock, so it held nothing and started nothing.
- :8000 and :8001 were never touched. The live :8001 is pid 16917 (the brief's 74910 is stale).
- The main working tree was never modified. Its state was read with `GIT_OPTIONAL_LOCKS=0` only.
- The worktree is clean at `3d8a2c6`. Nothing was pushed.

### Verdict

**Must-fix finding resolved.**

- `th/wp1-utf8-stream` is `cf3e5f7 ← 4c84f0a ← 3d8a2c6`. It fast-forwards onto main, builds with 0 warnings, and passes 17/17 tests (plus the reviewer's 7 adversarial tests).
- The batched path (`TH_BATCH=2`) compiles and streams whole characters with correct stop handling.
- All gates pass: V-build, unit, V-lin (max|Δ| identical), V-multi, T=0 single-slot A/B (18/18 identical ids), batched A/B and V-contract.

**Open item for the batched-decode owner (not U1):**

- At nb=2, greedy output depends on co-scheduling and admission timing. Examples: zh T=0 gave 156 vs 230 tokens within one binary; the batched path gives 228 tokens vs 227 single-slot.
