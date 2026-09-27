# Adversarial review: report/integration-sim @8d5b6d5 vs main @cf3e5f7

Reviewer worktree: `.worktrees/review-integ` (branch `review-integ` @8d5b6d5, no source
changes; release build sha256 `4f49179ac36e…`, differs from Phase B's `e91a30d2…` only by
the embedded worktree path). Main reference binary: `$SP/phaseB/wp2fix/th-engine-main-cf3e5f7`.
All servers on :8034, fresh per arm, `TH_DEBUG_TIMING=1`, under `gpu-lock`. Machine load
during the runtime session was 4–10 (sibling rustc + a VM), i.e. higher than Phase B's 2.5;
absolute ms/round here are therefore ~2 ms above §4.1 of PHASEB-REPORT, but every A/B below
is same-session.

Diff reviewed: `git diff main...report/integration-sim -- engine/` = 8 files, +4356/−332
(quant_kernel.rs +2085, qwen35.rs +1533, engine.rs +640, main.rs +207, gdn_kernel.rs +144,
dflash.rs +67, model.rs +7, server.rs +5). gdn_kernel.rs was not in the task's file list but
carries the K45 presum producers (`add_rmsnorm_sums`, `gdn_fused_step{sums}`).

## Verdict

**Mergeable as a unit — no must-fix found.** Every path Phase B could not exercise that I
could reach behaves correctly: TH_BATCH=2 mixed T=0/sampled slots (incl. 4-deep queue),
`--kv-quant` in batch mode plus a live `/engine/config` flip, TH_BATCH>1 without `--draft`,
3989-token context, 608/118-token prompts through the new prefill tiles, the K=17408 `down`
projection under all three presum policies, `POST /engine/kv/clear` against live slots, CJK
streaming. 39 requests → 39× HTTP 200, 0 panics, 0 WARN/ERROR in server logs, 0 U+FFFD.
T=0 output is token-identical to main on 6 of 8 prompts (the two divergences are the known
numerics near-ties: code at emitted id #22 as in PHASEB §4.1; CJK at #75). Presum on/off and
family choice are bit-identical at the token level across 7 streams × 4 arms.

Should-fix items (none blocking) are listed below; the main one the other developer should
know about is that greedy output under TH_BATCH>1 depends on co-scheduling (pre-existing on
main, not introduced here, but the integration makes it more visible because nb=1 batch mode
is now much faster than the single-slot loop).

## Static review findings

### Semantic merge fix T2×K45 (`gate_up_act_ps` tuple return) — correct
`qwen35.rs:628-777`. All five return arms carry the right presum flag: T2 `AffineQpf`
(rows>8) → `(y, false)`; legacy `AffineQmppPrefill` (rows>8) → `(…, false)`; K1 N256 tile
(rows 2..=8) → `(y, emit)` where `emit = tile==256 && sgs==8 && presum_enabled()`; `AffineQsg`
fallback → `(y, false)`; rows==1 → `None`. A >8-row activation can never be a presum block
(producers only emit at T ≤ 8, `add_rms_norm_ps` qwen35.rs:1451 gates on `(1..=8).contains(&seq)
&& x.dim(0)==1`), so `(y,false)` on the T2 arm is the only correct value. Both callers
(`forward_inner` qwen35.rs:~3560, `forward_batch` ~3730) thread `act_ps` into
`lin_apply_ps(&act, &down, act_ps)`; the eager fallbacks return `false`. In batch mode with
nb ≥ 2, Σseq = 8·nb ≥ 16, so the shared projections never see a presum block — the presum
path in `forward_batch` is only reached at nb=1 (same shape as the single-slot loop) and per
slot inside `gdn_forward`.

### Presum block contract (K45) — guarded, layout consistent
- Layout `presum_block_bytes(inp) = 8·inp·2 + (inp/64)·8·4` (quant_kernel.rs:~262): zero-padded
  [8, inp] bf16 then f32 sums `[inp/64][8]`. Producers: `add_rmsnorm_sums` (gdn_kernel.rs:
  `out = res[T,C] | nrm[8,C] | sums`, `nrm = out.narrow(0,1,1)` has offset T·C → the kernel
  reads sums at `input + 8·in_dim` relative to the bound offset ✓), `gdn_fused_step{sums}`
  (y = `AllocBf16{elems: presum_block_bytes(dv·hv)/2, rows: seq}`), and the N256 gate_up
  `EmitSums` epilogue (`osums = output + 8·out_dim`, y_buf sized `presum_block_bytes(out)/2`).
- Consumer guard (quant_kernel.rs:~2588-2603): `x_off % 16 == 0 && buffer.length() >=
  x_off + presum_block_bytes(inp) && elem_count == m·inp`, else bail. The Phase B review's
  "presum flags are trusted without a real guard" is addressed at the op level. Residual
  risk: a pooled buffer that is large enough but does not hold a block would pass; the only
  way to reach that is a caller passing `presum: true` for a copied tensor, and every caller
  derives the flag from the producing op on the same tensor (`nrm`, `gated.unsqueeze(0)`,
  `y8.narrow(0,0,rows)` — all views, no `.contiguous()` copies). No such call exists.
- Producer guard for `gdn_fused_step` (gdn_kernel.rs:779-787) checks buffer length and
  `dv % 64 == 0 && (hv·dv) % 64 == 0`.
- Alignment: block offsets are `T·C·2` bytes; with `C % 64 == 0` this is always 16-aligned.
- Threadgroup memory: PreSums staging bound `8·ng·4 ≤ 24 KiB` plus static arrays (`otile`
  4 KiB, split `partials` 8 KiB at TileN=64) stays under 32 KiB for every shape of this model
  (worst: N64s4Ps at K=17408 → 8.7 KiB staged + 8 KiB partials).

### Untracked-Arc class (MetalStorage::new over a cloned buffer)
Every `MetalStorage::new` in the diff wraps a buffer freshly obtained from
`device.new_buffer_builder()` (gdn_kernel.rs:1271 `arn.y`; quant_kernel.rs:2071
`qmpp.y`, :2670 `q4.presum`, :2863 `alloc.bf16`, `qpf.y`). `AllocBf16` returns an
uninitialised pooled buffer with `rows·cols ≤ elems`; the fused GDN kernel writes every
element of both outputs (rows T..7 zeroed explicitly). No `buffer().clone().into()` was added
(the two pre-existing sites attn_kernel.rs:213 / draft_kernel.rs:185 are unchanged and not
storage escapes). Clean.

### P0 / K > 8192
`PAD_SKIP_MAX_IN = 8192` (quant_kernel.rs:251). `direct = presum || (m==8 && elems==8·inp &&
x_off%16==0 && inp ≤ 8192 && pad_skip_enabled())` — a presum block is always bound directly
(that is the point: `down` K=17408 receives gate_up's emitted block); with `TH_Q4_PRESUM=0`
`down` keeps the pad copy at every m. Runtime: token-identical across presum on/off (below),
so the K>8192 direct-vs-copy paths agree.

### Presum default (`split,split_long`) — in-situ wash
`ps_family_on` default `"split,split_long"` (quant_kernel.rs:~290): `down` (K=17408, N64Split4
per `plain_tile_for`) takes the `N64s4Ps` kernel. The K45 kernel bench had the PreSums twin
10% slower on `down` (125.3 vs 113.0 µs ×64 calls ≈ +0.8 ms/round). Same-session ABBA below
cannot resolve that: default vs `TH_Q4_PS_FAMILIES=split` differ by ≤ 0.3 ms/round on code_t0
in both orderings, inside noise. Not a correctness issue; either default is defensible.
Recommendation: keep, or flip to `split` on the strength of the kernel bench — needs ≥ 6 passes
at load < 3 to decide.

### Batch-mode state machine (B1/M1/M3/M5/MEM-6 as merged)
- `forward_inner`/`forward_batch` hand state back before `?` in all four branches
  (qwen35.rs:~3525-3560, ~3690-3730); `.take().context(..)?` replaces `unwrap`.
- `clear_kv_cache` (qwen35.rs:2636) walks `layer.kind` and rebuilds missing GDN/KV state with
  shapes matching `Slot::new` (`(conv_k-1, 2·key_dim+value_dim)`, `(num_v_heads, head_v,
  head_k)`); rebuilds a lost draft ring when `draft_w` is present.
- `draft_propose_batch` (qwen35.rs:2784) hands rings back infallibly (no 40 MiB placeholder).
- `batch_loop` wraps `admit` and `batch_round` in `catch_unwind` (engine.rs:1249, 1272);
  tokio's `MutexGuard` does not poison, so the scheduler survives. Verified indirectly: no
  scheduler death across 14 + 5 + 3 batch requests.
- `set_kv_quant` (all slots) is reachable only from `generate_blocking` (engine.rs:331, single
  slot, lock held for the whole request); batch admissions use `set_kv_quant_slot`
  (engine.rs:1336) and `slot_tq` (qwen35.rs:2496) selects the TurboQuant context per slot.
  `/engine/config` in batch mode only updates `state.config`; slots adopt it at admission.
- `kv_clear` (engine.rs:219) clears idle slots only, reports `skipped_live`; `kv_tokens` is
  zeroed only when nothing was skipped.
- `Engine::new` truncates slots when `TH_BATCH>1 && !has_draft()` before the scheduler is
  spawned; `live`, `job_tx`, `decode_slots` all use the truncated count.

### Invariant 21 / HTTP contract
Only additions: `/status.features.batch_slots`, `/status.model.decode_slots`,
`POST /engine/kv/clear` → `{ok, cleared[], skipped_live[]}` (kept `ok`). `th_stats` keys
unchanged. The Swift `EngineSupervisor` reads `/status.instance` + generic fields only
(EngineSupervisor.swift:21,131,252); the gateway parses nothing th-engine-specific. Safe.

### Prefill tiles (T2) host/kernel consistency
`AffineQpf` (quant_kernel.rs:~3480-3640): `pf_prep` reads only `row < m` rows, writes `xp`
only when `copy != 0` (buffer 1 is bound read-only to x otherwise); sums layout
`[(row/R)·ng + g]·R + row%R` matches the tile's `sums + tg.x·ng·Rows` / `gs[q·Rows+row]`;
output `y` is exactly `[m, out]`, cooperative full-tile store only when `live == Rows &&
origin+TileN ≤ out`, guarded element stores otherwise; split-K partials `[splits][m][out]`
reduced in fixed order. `pf_policy_only_returns_warmed_shapes` keeps `pf_warm` in sync with
the policy so no request pays a lazy compile (load log: "prefill tile libraries compiled
pipelines=10 ms=2..341"). `r32n256s8` declares `tsums[32·256]` f32 = exactly 32 KiB of
static threadgroup memory — at the Apple limit; it works on this GPU (routed at m=128) but a
compile failure on another GPU is only a WARN at load and would then 500 every rows>8 request
of that shape (no legacy fallback inside `linear_ps`/`gate_up_act_ps` on `AffineQpf` Err).

## Should-fix (non-blocking)

1. **`gdn_fused_step` presum sums hard-code two quant groups per value head (DV=128).**
   gdn_kernel.rs kernel lines `sums[(2*hv)*8 + t]` / `sums[(2*hv+1)*8 + t]` (≈:405-425); the
   Rust guard at gdn_kernel.rs:782 only requires `dv % 64 == 0`. A model with `head_v = 256`
   would get silently wrong `out`-projection sums under presum. Guard `dv == 128` (bail or fall
   back to `sums:false`) or index by `g = (hv*dv)/64 + j` over `dv/64` groups.
2. **`pf_env()` re-reads `TH_GPU_CORES` with default 40 instead of `gpu_cores()`**
   (quant_kernel.rs:3666-3676 vs :54-75). Decode policy uses the IORegistry count, prefill
   policy uses 40 unless overridden — divergent occupancy targets on any non-40-core GPU.
   Known open item from the T2 review; one-line fix.
3. **Stale comment in `linear_ps`** (qwen35.rs:467-475): the T2 block still explains that
   `in_d == self.inp` exists to "keep the [1,8,32,128] o_proj over-read byte-for-byte";
   fix-N1 made that shape a hard error at :335. Delete the paragraph (the `in_d == self.inp`
   test is now redundant but harmless).
4. **Per-call env reads still in hot paths** (pre-existing on main, not introduced here, but
   the integration cached only the Q4/GDN ones): `TH_NO_ATTN_FUSED` + `TH_DEBUG_ATTN` per
   attention layer per forward (qwen35.rs:3181, 3204), `TH_GDN_AB_CONTIG` per GDN layer
   (:3074), `TH_DRAFT_EAGER` per draft layer per propose (dflash.rs:490, 985, 1002),
   `TH_PHASE_TIME` per forward (:3517), `TH_DEBUG_ROLLBACK` (:2572), `TH_DEBUG_TIMING` per
   round (engine.rs:464, 565, 1610). ~70 `getenv` per round. Same `OnceLock` treatment.
5. **No fallback when an `AffineQpf` pipeline is unavailable** (see T2 section). Wrap the
   `pf_route` arm in `linear_ps`/`gate_up_act_ps` so an `Err` from `AffineQpf` falls through
   to `AffineQmppPrefill`, or make `pf_warm` failure disable routing (`pf_force_legacy(true)`).
6. **~800 lines of bench code landed in qwen35.rs** (`bench_q4_decode` :838-1400,
   `bench_prefill` :1972-2250, `bench_draft_mlp`) — the other developer's production module.
   Suggest `engine/src/bench.rs` (cfg(feature) or plain module) before or right after merge.
7. `Q4AttachSums` (quant_kernel.rs:~2640) is bench-only production code; fine to keep, but
   mark it so.

## What will surprise the other developer

- **Greedy output under TH_BATCH>1 is a function of co-scheduling.** Measured: `mixA_code_t0`
  (nb≈2) == `q4_code_t0` (nb≈2) byte-for-byte, but `solo_code_t0` (nb=1) diverges from both
  at word ~33, and from the single-slot loop's `code_t0` at the same point. Cause: Σseq=8·nb
  rows route the shared projections through different kernels (8-row decode tiles at nb=1;
  T2 `r16n128s4`/legacy prefill tiles at nb≥2) whose rounding differs by ~1 ulp; near-ties
  flip. Pre-existing on main (legacy prefill tiles had the same property), unchanged in kind
  by T2. Consequence for their measurements: T=0 identity A/Bs in batch mode need identical
  batch composition (PHASEB §2.2 already says this).
- **Batch mode at nb=1 is now the fastest way to run one stream.** Always-verify-7 (batch) vs
  the single-slot adaptive `verify_len` (2..7): code_t0 20 rounds / 128 tokens = 6.4 tok/round
  at 54.8 ms/round → 117 tok/s reported (wall 1.25 s incl. prefill), against the single-slot
  loop's 3.9 tok/round at 56.6 ms/round → 70 tok/s on the same build (different greedy text
  from word 33, so not a like-for-like acceptance number; long_t0 and short_t0 came out
  3.37/5.0 tok/round in batch vs 3.29/3.86 single-slot). This is L1 for free, and it also
  means `/status` decode_tps from the live :8001 (TH_BATCH=4) and from a TH_BATCH=1 box are
  not comparable even after the M1 fix.
- `TH_BATCH>1` without `--draft` now silently degrades to one slot (WARN "TH_BATCH>1 requires
  --draft; batched decode disabled, serving single-slot", `features.batch_slots: 1`).
- New env knobs: `TH_Q4_POLICY={tuned|legacy|seq}`/`TH_Q4_SEQ`, `TH_Q4_PAD=1`,
  `TH_Q4_PRESUM=0`, `TH_Q4_PS_FAMILIES=…`, `TH_PF={0|r16n128s4[+k4][+gu]}`, `TH_BENCH_Q4`,
  `TH_BENCH_Q4_*`, `TH_BENCH_PREFILL`, `TH_BENCH_BATCH`, `TH_BENCH_DRAFT_MLP`, `TH_PF_COMPILE`,
  `TH_TEST_TOKENIZER`. `TH_GPU_CORES` is now read once (ioreg default) for decode.
- `QLin::linear`/`gate_up_act`/`add_rms_norm` are `#[allow(dead_code)]` wrappers; the live
  entry points are `linear_ps`/`gate_up_act_ps`/`add_rms_norm_ps`/`lin_apply_ps`.
- `DraftLayer` lost `gate`/`up` for a fused `gate_up` (dflash.rs:~200-235, fused before tiling
  at load); `Slot` gained `kv_quant`; `ModelInner` gained `live`; `Engine::kv_clear` returns
  a JSON value; `Run.text_out`/`generate_blocking.text_out` are `TextOut`, SSE deltas are no
  longer one-per-token.

## Runtime evidence (session 1, 05:53–05:59, :8034, gpu-lock held throughout)

Loads at arm start: batch 5.2, kvq 6.9, nodraft 6.4, main1 6.1, integ1 10.3, split 5.9,
nops ~6, integ1_b ~6, split_b ~6. GPU otherwise quiet (WindowServer only). Build shas:
integ = review-integ `4f49179a…` (source 8d5b6d5), main = `545e5462…` (cf3e5f7).

### TH_BATCH=2 --draft (integ) — 14/14 HTTP 200, 0 panics, 0 WARN
| group | requests | result |
|---|---|---|
| mixed | code T=0 + long T=0.6 s3 | 200/200, 42 rounds, mean nb 1.67, 77.3 ms/round |
| 4 concurrent (queue depth 2) | code T=0, long s1, short T=0, code s5 | 4× 200, 61 rounds, nb 1.56, 74.8 ms/round, rep3 ≤ 0.044 |
| solo (nb=1) | code / long / short T=0 | 20 / 38 / 6 rounds, 54.8 / 55.9 / 56.7 ms/round, 6.4 / 3.4 / 5.0 tok/round |
| CJK stream T=0, 96 tok | 96 deltas, 0 U+FFFD | `stop:["秋"]` cut after 8 tokens at the right character |
| CJK + code concurrent streams | 0 U+FFFD, CJK text identical to solo CJK | |
| `POST /engine/kv/clear` ×6 during group 2 | `{"cleared":[],"skipped_live":[0,1]}` ×5, one `cleared:[0,1]` between groups | M3 correct |
| `/status` | `features.batch_slots: 2`, `model.decode_slots: 2` | additive |

### TH_BATCH=2 --draft --kv-quant (integ) — 5/5 + flip test, 0 panics
87 ms/round at nb=1 (eager attention), 124 at nb≈1.6. Texts differ from raw-KV from word 11
("reverses a Python? linked list") — TurboQuant lossiness, pre-existing. Live flip: long T=0
in flight, `POST /engine/config {kv_quant:false}` at +0.8 s, code T=0 admitted → code came out
with the raw-KV prefix (flip honoured for the new slot), the in-flight long stream stayed
coherent (rep3 0.000) and matched its solo kv_quant run through word 33 (divergence there is
the co-scheduling effect; a same-composition control is in session 2).

### TH_BATCH=2 without --draft (integ) — M5
WARN logged once at load, `features.batch_slots: 1`, `decode_slots: 1`; two concurrent T=0
and one solo request all 200 via the single-slot n-gram loop (24–37 tok/s).

### Single slot, main vs integ (same session, T=0 solo, ratio of sums)
| prompt | main cf3e5f7 ms/round · tok/round · tok/s | integ 8d5b6d5 | Δ ms/round | T=0 ids |
|---|---|---|---|---|
| code (68 tok) | 64.29 · 3.543 · 55.1 | 56.55 · 3.935 · 69.6 | −12.0% | diverge at emitted id #22 (3300 vs 7936) |
| long (80) | 64.41 · 3.289 · 51.1 | 56.50 · 3.289 · 58.2 | −12.3% | identical (125 ids) |
| short (58) | 65.89 · 3.857 · 58.5 | 57.39 · 3.857 · 67.2 | −12.9% | identical |
| CJK (71, 96 tok) | 63.95 · 2.043 · 32.0 | 56.56 · 2.022 · 35.8 | −11.6% | diverge at #75 |
| p118 (tiles prefill) | 67.74 · 5.70 | 54.71 · 6.67 | −19% | text identical |
| p608 (512 legacy + 96 tiles) | 75.51 · 4.357 · 57.7 | 61.46 · 4.429 · 72.1 | −18.6% | text identical |
| p3989 (4k ctx) | 100.77 · 3.389 · 33.6 (verify 78.2, propose 21.4) | 91.34 · 3.588 · 39.3 (70.7 / 19.7) | −9.4% | identical (61 ids) |
| 3-prompt T=0 total | 64.29 ms/round | 56.59 | −12.0% | |

Seeded (0.6/0.95/20, seeds 1/3/5) streams are deterministic per build (12/12 identical across
integ arms) and differ between builds from id #26/#68 (code_s1/long_s3), as expected.

### Presum policy ABBA (integ, single slot, T=0 solo code/long/short)
| arm | code ms/round | long | short | 3-prompt | ids vs integ1 |
|---|---|---|---|---|---|
| default (`split,split_long`) A | 56.55 | 56.50 | 57.39 | 56.59 | — |
| `TH_Q4_PS_FAMILIES=split` A | 56.85 | 57.23 | 55.89 | 57.03 | identical 7/7 |
| `TH_Q4_PRESUM=0` | 57.98 | 58.74 | 59.19 | 58.67 | identical 7/7 |
| default B | 55.13 | 74.20* | 64.99* | 62.26* | identical 7/7 |
| `split` B | 54.85 | 54.97 | 55.59 | 54.94 | identical 7/7 |

\* host-contention outlier (propose 18.4 ms vs 8.1). Reading: presum on saves ~1.5–2.5
ms/round vs off; `split_long` PreSums on `down` is indistinguishable from recompute in situ
(≤ 0.3 ms either way on code in both orders). All 4 arms × 7 streams are id-identical to the
default arm, i.e. presum is bit-identical at the token level, and the build is deterministic
run to run.

## Session 2 (06:09–06:11, gpu-lock acquired after 758 s behind `session_L1.sh`; loads 5.6–8.5)

- **`cargo test --release`** in `.worktrees/review-integ/engine`: 24 passed / 0 failed in
  8.8 s, including `qwen35::mem6_tests::mem6_admission_mode_never_changes_inflight_slot`
  (real Metal device), the 9 `utf8_stream` tests, `pf_tests` and `plain_tile_table`.
- **Metal shader validation** (`MTL_SHADER_VALIDATION=1 MTL_SHADER_VALIDATION_REPORT_TO_STDERR=1`,
  banner "Metal GPU Validation Enabled" present in both logs):
  - TH_BATCH=1 `--draft`, short + code prompts, 24 tokens each (prefill 58/68 rows → T2
    tiles; decode 3..8 rows → presum blocks, P0 direct bind, pad copy, EmitSums, N64s4Ps
    on `down` K=17408): **0 "Invalid device load" reports** (the same detector produced 157
    for MEM-1 on 44aed06).
  - TH_BATCH=2 `--draft`, code + long concurrent (Σseq=16 → `r16n128s4(+k2/+k4)`/legacy
    prefill tiles on the shared projections, per-slot GDN presum blocks, lm_head at 16 rows):
    **0 reports**. Both arms 200/200, 0 panics.
- **kv_quant same-composition control** (long T=0, code T=0 admitted +0.8 s, both
  `kv_quant=true`): 200/200, 0 panics. `ctrl_long_t0` vs the flip arm's `flip_long_t0`
  diverge at word 43 — admission landed on a different round (the flip arm had a PATCH in
  between and the raw-KV code slot finished at a different time), so round-by-round nb
  differs and the co-scheduling numerics apply; not a corruption signal (no repetition, and
  the MEM-6 unit test is the definitive mechanism check). **Observation:** every kv_quant code
  run misquotes the prompt at token ~11 — solo `"reverses a Python? linked list"`, co-scheduled
  `"reverses a Python function that reverses a linked list"` (rep3 0.19 from that echo, then
  coherent) — while the raw-KV slot in the identical composition (`flip_code_t0_kq0`) is clean.
  Consistent with TurboQuant lossiness on this model (pre-existing; `--kv-quant` is documented
  as a long-context/eager path), not with the MEM-6 cross-slot flip (which produced 57× loops).
  Worth a fixed-composition quality check (`TH_BENCH_BATCH`-style) before anyone relies on
  kv_quant in batch mode.
- **TH_BATCH=4 `--draft`** (the live :8001 configuration): 16/16 HTTP 200, 0 panics, 0 WARN,
  `features.batch_slots: 4`. Groups: 4-way mixed (2 T=0 + 2 sampled, one streamed CJK) 48
  rounds at mean nb 2.40, 93.4 ms/round; 4-way greedy 45 rounds, nb 2.56, 95.3 ms/round;
  6-deep queue (4 live + 2 queued; queued CJK TTFT 4.9 s as expected) 77 rounds, nb 2.35,
  89.9 ms/round; nb=1 solo code 20 rounds, 54.2 ms/round, 117 tok/s. Greedy identity inside
  the arm: long/short/CJK byte-identical between the 4-way-greedy and 6-queue groups; code
  diverges at word 36 (co-scheduling). `b4_solo_code_t0` is byte-identical to the TH_BATCH=2
  `solo_code_t0` (553 chars): at fixed composition the batch path is deterministic across
  slot counts. 0 U+FFFD across all streamed CJK.

Total across both sessions: 71 requests, 71× HTTP 200, 0 panics, 0 WARN/ERROR (other than the
intended M5 fallback WARN), 0 U+FFFD.

## Commands
```
$P/bin/wt-bootstrap review-integ                 # worktree + APFS-cloned target
(cd .worktrees/review-integ/engine && cargo build --release)   # 34 s incremental, 0 warnings
$P/bin/gpu-lock -- /tmp/ri/session.sh            # arms: batch, kvq(+flip), nodraft, main1(+long), integ1(+long), split, nops, integ1_b, split_b
$P/bin/gpu-lock -- /tmp/ri/session2.sh           # cargo test, val1/val2 (shader validation), kvq_ctrl, batch4
python3 /tmp/ri/agg.py /tmp/ri/run/<arm>.jsonl [--ids]   # ratio-of-sums per group from [dflash]/[batch] log slices
python3 /tmp/ri/cmp.py A.jsonl B.jsonl [tagA=tagB]        # first text divergence
```
Raw: `/tmp/ri/run/*.{log,jsonl,status,kvclear}`, `/tmp/ri/run/session*.out`. Helpers:
`/tmp/ri/{serve.sh,stop.sh,client.py,cmp.py,agg.py,mkprompt.py,to.py}`.
Processes: every server I started was stopped (`stop.sh` per arm); :8000 untouched (never
started Splash); :8001 pid 16917 untouched.
