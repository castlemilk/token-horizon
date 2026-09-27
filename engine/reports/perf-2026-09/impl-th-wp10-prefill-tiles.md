> **Provenance.** The original wp10 implementation report was written inside the worktree, at `engine/target/wp10/wp10-prefill-tiles.md` (gitignored). It was never copied to `$SP/phaseB/`. It is reproduced verbatim below, down to the "Review fixes" heading. Its numbers, shas and line references are for the **pre-rebase** commits on `44aed06`: `1327a11`, `872a0fd`, `1de5480` and `dbf01ad`. The **Review fixes** section at the end is current. The branch is rebased onto main `cf3e5f7`, and the rebased shas are listed there.

# T2 / wp10 — small-M prefill tiles (TTFT)

Branch `th/wp10-prefill-tiles`, worktree `/Users/benebsworth/projects/token-horizon/.worktrees/th/wp10-prefill-tiles`,
base `44aed06`. Nothing pushed, main untouched. All files below are relative to
`engine/target/wp10/` in that worktree (gitignored).

## Commits (one per item)

| sha | item | files |
|---|---|---|
| `1327a11` | **Splash Apple10 N128×4sg prefill tile** + `pf_prep` + `AffineQpf` + rows>8 routing hook in `QLin` (`pf_route`) + bench tooling (`TH_BENCH_LIN=1\|dec\|pf`, `TH_BENCH_PREFILL`, `TH_PF_COMPILE`) | quant_kernel.rs, qwen35.rs, main.rs |
| `872a0fd` | **batched row tiles** M16/M24/M32 × N128/N256 × 4/8 simdgroups (8-sg = staged sums, Splash's StagedSums form) + fused two-stream gate/up tile; policy | quant_kernel.rs, qwen35.rs |
| `1de5480` | **split-K** for narrow projections (fp32 partial epilogue + fixed-order `pf_reduce`); policy | quant_kernel.rs, qwen35.rs |
| `dbf01ad` | bench: in-process interleaved legacy/tile prefill A/B (`pf_force_legacy`, relaxed atomic, off by default; no behaviour change) | quant_kernel.rs, main.rs |

Binaries (clean builds of exactly those trees): `th-engine-base` (44aed06), `th-engine-c1-1327a11`,
`th-engine-c2-872a0fd`, `th-engine-c3-1de5480`, `th-engine-c4-dbf01ad`. The base A/B binary is my own
clean 44aed06 build in this worktree (`$SP/bin/th-engine-44aed06` already existed, made by another agent).

Branch history was rewritten twice before finishing (never pushed): (1) a shape guard (below) was
added to the routing hook, (2) tile routing was capped at m≤128 after the in-process A/B showed m=512
4.3% slower. Session-1 measurements were taken on the pre-rewrite builds `b33b26e`/`c29a5fd`/`fcfb1a2`;
their routing is identical to the final commits for every shape in those benches except m=512
(then tile-routed, now legacy). Session-2 E2E used `706db92`/`018c22f` (guard, pre-cap): routing
identical to `872a0fd`/`1de5480` for all M≤128, i.e. every E2E prompt (58/68/80 tokens incl. the draft
commit). The final build `dbf01ad` was re-validated directly (A/B forward, logits, V-multi, routed
V-lin table, one E2E arm).

## What changed and why

- `AffineQpf` (self-contained `PF_SRC`, prefill region of quant_kernel.rs; decode tiles untouched):
  - `pf_prep`: pads x to whole row tiles and emits per-(row, quant-group) input sums in ONE dispatch
    (legacy: pad + a single-threadgroup-per-32-rows sums kernel).
  - `pf_tile<Rows,TileN,Sgs,Mode,Staged>`: port of Splash `q4_mpp_prefill_tile`
    (docs/splash/runtime/metal/kernels/prefill/linear_q4.metal): 4 simdgroups read sums from device
    memory (the Apple10 `prefill_linear_q4_n128_sg4` form, 0 B threadgroup memory); 8 simdgroups stage
    them in threadgroup memory (256 groups/refill, = legacy structure); cooperative store for interior
    tiles, guarded stores on the ragged edge → output is exactly `[m,out]` in a fresh buffer (no
    `narrow`+`contiguous` copy; no untracked-Arc aliasing — only fresh pool buffers are returned).
    Rows 16/24/32 = `q4_mpp_tile_batched` M16/M24/M32. Epilogues: plain, up·silu(gate) (two-pass
    gate/up), fp32 split partial.
  - `pf_tile_gu`: two-stream gate/up tile (silu(gate)·up in one pass).
  - `pf_reduce`: deterministic fixed-order split-K reduction + epilogue.
  - Grid has row tiles fastest (the pre-reboot WIP had column tiles fastest: each row tile re-streamed
    the whole weight matrix).
  - Libraries compile lazily per tile shape (cold compile of the whole family 1.6-3.7 s, cached 5-12 ms;
    a cold process pays only for routed shapes).
  - Every read buffer bound with `set_input_buffer`, every written one with `set_output_buffer`, so
    candle 0.11's concurrent-encoder barrier tracking orders prep → tile → up|reduce.
- Routing (`QLin::linear` rows>8 and `gate_up_act` rows>8) via `pf_route` (env read once:
  `TH_PF=0` legacy, `TH_PF=r16n128s4[+k4][+gu]` force, `TH_QMM_SCALAR` off, `TH_GPU_CORES` default 40).
  Final policy (m>128 → legacy):
  - narrow (≤2 n128 column tiles/core: N=5120 down/out/o/draft fc, 6144 draft qkv), m≤128:
    r16n128s4 + split-K ×4 (grid ≤5 tiles/core, i.e. m≤16) else ×2;
  - wide single-stream (in_all 16480, in_qkv 14336): m≤16 r16n128s4+k2, 16<m≤128 r32n256s8 (staged);
  - gate/up: m≤16 fused r16n128s4+gu; 17..127 legacy; m=128 r32n256s8.
  - 24-row tiles instantiated (forceable) but never won; not routed.
- **Bug found (pre-existing in 44aed06 and main):** the fused `draft_attn` returns `[8,32,128]` and
  dflash.rs `.unsqueeze(0)` → the DFlash `o_proj` (inp 4096) receives `[1,8,32,128]`; `QLin::linear`
  sees rows=256, in_d=128 and the legacy prefill kernel treats the buffer as 256×4096: rows 0..7 are
  correct (used), rows 8..255 are computed from **out-of-bounds reads** and discarded — a 256-row
  prefill GEMM on every draft propose (×5 layers). `AffineQpf`'s shape check rejected it
  (`affine-qpf: x [256, 128] != [256, 4096]` → HTTP 500 in the first E2E run). Scope-respecting fix:
  tile routing only when `in_d == inp`; that input keeps its legacy behaviour byte-for-byte. The real
  fix (reshape to `[1,8,4096]` before o_proj in dflash.rs → 8-row decode path) is outside this scope and
  in Codex's actively edited file; it should also make propose cheaper.

## Measurements

Hardware M5 Max 40c. GPU-timed runs all under the shared `/tmp/th-engine-gpu.lock`
(`bin/gpu-lock`). Machine load avg 10-48 from other agents during runs.

### Methodology findings
- A sequential kernel sweep drifted up to 2× (legacy at m=16 vs m=32 — identical padded work — read
  1.02 vs 0.77 ms). The prefill sweep now times all candidates round-robin (5 rounds, rotated start).
- Cross-process forward timings drifted up to 30% (same legacy m=512 forward: 931 ms at a session's
  start, 698 ms at its end) → the forward A/B is in-process interleaved (`dbf01ad`).
- `th_stats.prefill_tps` = n_prompt / time spent *encoding* the forward chunks (`forward()` does not
  sync), so it is not a GPU prefill throughput; TTFT is the reliable TTFT metric.
- Metal's shader cache is keyed per binary location: a never-run binary path recompiles every kernel on
  its first request. E2E pass 1 warmed each binary; the cold loop ran after.
- Real bench prompt sizes with the chat template: short 58, code 68, long 80 tokens.

### V-lin prefill half (kernel, `TH_BENCH_LIN=pf`, legacy vs routed, same process, interleaved)
Final build `dbf01ad` (`runs/s2/routed-c4n.txt`); ms, speedup, routed config. Δref (vs fp32
reference) identical for legacy and routed in every cell (gate_up 0.394, down 0.388, in_all 0.079,
out 0.315, in_qkv 0.071, o 0.246-0.305, d_fc 0.115, d_qkv 0.069); Δlegacy ≤ 0.0625 (≤1 bf16 ulp).

| proj | m=16 | m=32 | m=58 | m=64 | m=68 | m=80 | m=128 | m=512 |
|---|---|---|---|---|---|---|---|---|
| gate_up | .394→.317 1.24× gu | legacy | legacy | legacy | legacy | legacy | 1.825→1.722 1.06× | legacy |
| down | .733→.131 5.60× k4 | .679→.217 3.13× | .657→.413 1.59× | .697→.413 1.69× | .721→.542 1.33× | .745→.491 1.52× | 1.289→.726 1.78× | legacy |
| in_all | .251→.138 1.82× | .232→.191 1.21× | .406→.387 1.05× | .417→.376 1.11× | .510→.413 1.23× | .539→.440 1.23× | .688→.606 1.14× | legacy |
| out | .241→.051 4.73× | .231→.076 3.04× | .231→.144 1.60× | .230→.136 1.69× | .251→.171 1.47× | .256→.179 1.43× | .408→.337 1.21× | legacy |
| in_qkv | .216→.095 2.27× | .212→.193 1.10× | .372→.378 0.98× | .371→.365 1.02× | .483→.415 1.16× | .494→.428 1.15× | .562→.530 1.06× | legacy |
| o | .251→.050 5.02× | .234→.074 3.16× | .226→.141 1.60× | .221→.130 1.70× | .234→.166 1.41× | .241→.167 1.44× | .385→.243 1.58× | legacy |
| d_fc | .918→.186 4.94× | .904→.298 3.03× | .877→.563 1.56× | .940→.571 1.65× | 1.039→.815 1.27× | 1.078→.805 1.34× | 1.817→1.105 1.64× | legacy |
| d_qkv | .177→.046 3.85× | .169→.072 2.35× | .188→.131 1.44× | .188→.129 1.46× | .296→.158 1.87× | .307→.156 1.97× | .313→.245 1.28× | legacy |

GB/s / TFLOPS examples (routed): down m=16 396 GB/s 22.6 TF (legacy 72 GB/s 4.1 TF); out m=16
306 GB/s; d_fc m=16 389 GB/s; in_all m=128 34 TF; gate_up m=16 324 GB/s 18.4 TF. Full per-config
tables with GB/s/TFLOPS/Δ: `runs/sweep-wip5.log` (+ `.grid`, `.bestfinal.txt`), per-item routed
tables `runs/s1/routed.txt` (c1/c2/c3) and `runs/s2/routed-c4n.txt` (final).
Per item (routed vs legacy, `runs/s1/routed.txt`): **C1** only in_all 1.12-1.21× / in_qkv 1.24-1.27×
at m=58/64, everything else legacy; **C2** 1.1-1.5× on most shapes but **0.88× down / 0.75× draft fc at
m=68/80** (16-row unsplit tiles on large K), gate/up 1.24× at m=16; **C3** as the final table.
Decode half (`TH_BENCH_LIN=dec`, `runs/s1/deccmp.txt`, base vs c3): every max|Δ| identical, timings
within single-trial noise — decode kernels untouched.

### V-multi (`TH_BENCH_MULTI`, decode path, must be unchanged)
fwd1 / fwd8 ms: base 45.7-47.9 / 50.6-51.6; c1 45.4-48.2 / 46.6-48.6; c2 45.1-46.2 / 46.7-48.0;
c3 45.6-46.9 / 46.8-48.3; final dbf01ad 45.5-47.0 / 47.4-48.3. No change.

### Prefill logits (61-token prefill, `--dump`, vs base)
c1 max|Δ|=0.0000 (bitwise); c2, c3, final 0.125; argmax 3362 everywhere; top-8 set identical (order of
near-ties differs for c3/final). `TH_PF=0` on the c3 build: bitwise identical to base.

### Prefill forward (target model, synced), in-process interleaved legacy vs tiles, final build `dbf01ad`
(`runs/s2/probe.c4n.log`; med of 6 alternating runs each):

| m | 16 | 32 | 58 | 64 | 68 | 80 | 128 | 512 |
|---|---|---|---|---|---|---|---|---|
| legacy ms | 104.3 | 111.9 | 155.5 | 150.0 | 190.2 | 177.2 | 257.7 | 828.0 |
| tiles ms | 56.9 | 74.9 | 132.4 | 129.2 | 166.4 | 160.2 | 222.6 | 823.0 (legacy-routed) |
| ratio | 0.546 | 0.669 | 0.851 | 0.861 | 0.875 | 0.904 | 0.864 | 0.994 |

Pre-cap build `5ebbd8e` (same run type, `runs/s2/probe.c4.log`): 0.529 / 0.662 / 0.861 / 0.868 / 0.869 /
0.893 / 0.878 / **1.043 at m=512 (931.9→971.6 ms)** → the reason for the m≤128 cap.
(Session-1 sequential per-commit forward runs, drift-confounded: `runs/s1/probe8.*.log`.)

### E2E A/B (:8013, TH_DEBUG_TIMING=1, 3 prompts × (2× T=0 + 3 sampled 0.6/0.95/20, seeded), max_tokens 128)
Session 2, ABBA order (base,c1,c2,c3 then c3,c2,c1,base), fresh server per arm (`runs/s2/e2eagg.txt`):

| | cold TTFT short (arm 1st req) | T=0 TTFT mean short/code/long | T=0 loop ms/round, tok/round, tok/s | sampled loop |
|---|---|---|---|---|
| base 44aed06 | 169.0, 179.3 | 170.7 / 193.5 / 202.6 | 70.45, 3.450, 48.97 | 74.28, 3.641, 49.02 |
| c1 1327a11 | 169.6, 167.8 | 166.5 / 192.2 / 204.6 | 68.18, 3.450, 50.60 | 72.83, 3.641, 49.99 |
| c2 (706db92≡872a0fd) | 172.8, 168.5 | 176.0 / 221.3 / 223.3 | 72.54, 3.395, 46.80 | 73.85, 3.278, 44.40 |
| c3 (018c22f≡1de5480) | 152.2, 147.8 | **148.8 / 177.0 / 183.2** | 69.89, 3.438, 49.18 | 73.81, 3.512, 47.59 |
| final dbf01ad (1 arm) | 149.6 | 174.2 / 238.6 / 187.7* | 85.90*, 3.438, 40.02 | 74.80, 3.512, 46.96 |

\* the single final-build arm had two externally disturbed requests (decode 160/130 ms/round,
TTFT 199/304 ms); its undisturbed requests match c3 (short 146-150, code 165-182, long 175-195 ms).
Loop = Σtokens/Σround-ms over the logged [dflash] rounds. Decode is unaffected (verify rows ≤ 8); the
ms/round spread is thermal/CPU noise (base itself 63.8-70.5 across sessions).
T=0 token identity vs base (first divergence, emitted-token index): **c1 identical on all 15 requests
(both sessions)**; c2/c3/final: short and code identical, **long diverges at index 119 of ~125** in every
run (deterministic; prefill numerics differ by ≤1 bf16 ulp). Sampled runs (seeded) diverge early as
expected once probabilities differ. base vs base (two passes/sessions): identical.
c2 alone is *slower* in TTFT at 68/80 (+28/+21 ms) — consistent with its 0.75-0.88× large-K narrow
tiles at m=68/80; split-K (c3) recovers and inverts that.

### Cold TTFT A/B (fresh server per request, T=0, max_tokens 16, 2 reps, order rotated; `runs/s2/cold.jsonl`)

| prompt | base ttft_ms | c3 ttft_ms | Δ | th_stats prefill_tps base → c3 |
|---|---|---|---|---|
| short (58) | 182.4, 172.5 (177.4) | 166.1, 149.2 (157.7) | −19.7 ms (−11%) | 2411 → 2240 |
| code (68) | 232.0, 192.9 (212.4) | 197.4, 181.6 (189.5) | −22.9 ms (−11%) | 2409 → 2340 |
| long (80) | 208.9, 200.0 (204.4) | 189.4, 187.9 (188.6) | −15.8 ms (−8%) | 3091 → 2947 |

(prefill_tps is encode-time based — see methodology — and does not move.)

## Items that did not pay / notes
- Splash's N128×4sg tile alone (C1) beats legacy only for the wide projections at 33..64 rows; its
  32-row tiles starve the N=5120 projections and lose on gate/up → routed narrowly.
- 16-row unsplit tiles (C2) regress large-K narrow projections at m=68/80; split-K (C3) fixes it.
- Tile routing above m=128: per-kernel wins but the whole m=512 forward was 4.3% slower → legacy.
- gate/up at 17..127 rows: no tile beat legacy (3-9% behind) → legacy. It is now the largest prefill
  cost at the bench sizes (~0.7 ms at m=58/64, 1.4 ms at 68/80 ×64 layers).
- 24-row tiles never won; the fused gate/up tile only wins at m≤16.
- SYNTHESIS.md §3.0/§3.4 and reader reports were wiped by the 19:42 reboot; worked from the task text.

## Commands
```
W=engine/target/wp10; TGT=...; lock=$W/bin/gpu-lock
cargo build --release                                  # per commit (V-build), see git log
$lock -- $W/bin/lin.sh <bin> out.log TH_BENCH_LIN=pf TH_BENCH_PF_M=16,32,58,64,68,80,128,512 [TH_BENCH_PF_SHAPES=r16n128s4,r32n256s8]
$lock -- $W/bin/lin.sh <bin> out.log TH_BENCH_LIN=dec  # decode half
TH_BENCH_MULTI=8|1 TH_BENCH_PREFILL=16,32,58,64,68,80,128,512 <bin> probe --model $TGT --tokens $(cat $W/runs/ids61.txt) --dump logits.bin
$lock -- $W/bin/session1.sh ; $lock -- $W/bin/session2.sh   # vsession / vlin / e2esession (arm.sh + e2e.py) / cold.sh
python3 $W/bin/e2eagg.py $W/runs/s2 base c1 c2 c3 ; python3 $W/bin/coldsum.py $W/runs/s2/cold.jsonl
TH_PF_COMPILE=1 <bin> probe --model x --tokens 1       # compile-only check of the tile library
```
All servers/probes I started were killed (arm.sh / cold.sh kill their server); :8000/:8001 untouched.

---

## Review fixes (fix pass, 2026-09-26): rebased onto main `cf3e5f7`; batched-decode routing measured and accepted

### Findings addressed

1. **[high, must-fix] Does not compile once merged with main.**
   - Main landed `de110be`, `502cf15` and `cf3e5f7` (per-slot state and batched decode behind `TH_BATCH>1`) after this branch's base `44aed06`.
   - Main changed the signature to `ModelBackend::clear_kv_cache(&mut self, slot: usize)` (model.rs:219).
   - The branch's `TH_BENCH_PREFILL` probe called `clear_kv_cache()` with no argument. The merged tree failed with E0061 at main.rs:358, even though `git merge-tree` reported no textual conflict.
2. **[medium, must-fix] `pf_route` engaged, unmeasured, in main's batched decode path.**
   - The rows > 8 hook in `QLin::linear` / `gate_up_act` cannot tell prefill from decode.
   - A `TH_BATCH=B` round on main pushes rows > 8 through it in two places:
     - the target verify (`forward_batch`), with 8·nb flat rows through in_all / in_qkv / gate_up / out / o / down / lm_head;
     - the draft propose (`propose_batch`), with 8·nb rows through attn_dyn / qkv / gate / up / down / mlp_dyn, and 7·nb rows through lm_head and the selector.
   - The tile libraries also compiled lazily, so the first batched round could pay the compile.

### What was done (worktree `.worktrees/th/wp10-prefill-tiles`, branch `th/wp10-prefill-tiles`)

1. **Rebase onto `cf3e5f7`.** The worktree was detached at `cf3e5f7` and the four commits were cherry-picked in order.
   - **`1327a11` → `0451fd5`.** Its original 5-run `TH_BENCH_PREFILL` loop now calls `loaded.backend.clear_kv_cache(0)`, with the comment "forward() runs decode slot 0".
   - **`872a0fd` → `434a4db`, `1de5480` → `e1b6323`.** Unchanged.
   - **`dbf01ad` → `b2cd3c9`.** This commit rewrites that block into the interleaved legacy/tile A/B, so its cherry-pick conflicted in main.rs. The resolution keeps the commit's own block, with `clear_kv_cache(0)` in its `fwd` closure (main.rs:359).
   - `git range-diff 44aed06..dbf01ad cf3e5f7..b2cd3c9` shows commits 2 and 3 as `=`. Commits 1 and 4 differ only in the `clear_kv_cache(0)` lines.
   - Every rebased commit builds with `cargo build --release`: **0 warnings, 0 errors**.
   - The routing hook sits in code main did not touch: `QLin::linear` and `gate_up_act` are byte-identical between `44aed06` and `cf3e5f7`.
2. **Finding 2: measured, then accepted. No prefill-only gate.**
   - Tile routing cuts batched-decode rounds by about 20% (numbers below).
   - The T=0 divergences are 1-ulp near-tie flips.
   - With `TH_PF=0`, the branch is token-identical to main.
   - One shape was tuned (lm_head, item 5).
   - `dflash.rs` was not touched.
3. **New commit `8cd93db`: bench coverage for the batched-decode shapes.** Bench-only; no routing or kernel change.
   - The `TH_BENCH_LIN=pf` sweep (`bench_prefill`) now covers:
     - the real lm_head [248320×5120];
     - synthetic draft attn_dyn/mlp_dyn [1280×5120];
     - draft gate and up, as single-stream [17408×5120];
     - the draft selector [256×5120].
   - New `TH_BENCH_BATCH=2,3,4` probe (needs `TH_BATCH` ≥ nb):
     - every slot is prefilled with the probe ids, then nb×8 verify rows run through `forward_batch`;
     - legacy and tile routing alternate run by run, from restored per-slot state, with `synchronize()` after the restores so they stay untimed;
     - it prints ms (min and median), and the max|d| and argmax agreement of tiles vs legacy;
     - it compares each arm against the single-slot 8-row verify (`forward_multi`, decode kernels);
     - it reports slot invariance: slot b's rows against slot 0's rows for the same input.
4. **New commit `25c6f93`: tile libraries compile at model load.**
   - `pf_warm` compiles exactly what `pf_route` can pick under the current env: `pf_prep`/`pf_reduce` plus the policy's two shapes (`PF_POLICY_SHAPES` = r16n128s4, r32n256s8), or the `TH_PF`-forced shape. That is 10 pipelines.
   - It is called from `Qwen35::load` when weights are tiled, and is a no-op under `TH_PF=0` / `TH_QMM_SCALAR`.
   - The env read moved into `pf_env()` with unchanged semantics.
   - Every candidate server log shows `prefill tile libraries compiled pipelines=10 ms=2..7` (warm shader cache). No request pays a compile any more.
   - Three new unit tests in `quant_kernel::metal_impl::pf_tests`:
     - `pf_parse_round_trips_labels`;
     - `pf_policy_table`, which covers the model's prefill shapes and every batched-decode shape;
     - `pf_policy_only_returns_warmed_shapes`, a sweep over m 9..160, 8 outs, 5 inps and 10/40/80 cores. It checks that the policy returns only instantiated, valid, warmed configs.
5. **New commit `dc203fd`: lm_head tile policy.**
   - The 248k-column lm_head reaches the rows > 8 routing only in batched rounds, and it fell into the wide-projection policy.
   - Interleaved sweep on the real weights (median ms; one sweep, s3), comparing legacy with the two tile routes lm_head had before this commit (`+k2`, r32n256s8) and the unsplit tile it routes now:

     | m | legacy | unsplit r16n128s4 | old route: r16n128s4+k2 | old route: r32n256s8 |
     |---|---|---|---|---|
     | 14 | 2.091 | 1.641 | 1.883 | — |
     | 16 | 2.224 | 1.764 | 1.901 | — |
     | 21 | 2.581 | — | — | 2.745 |
     | 24 | 2.715 | — | — | 2.838 |
     | 28 | 2.732 | — | — | 2.876 |
     | 32 | 2.747 | — | — | 2.847 |

   - With 1940 column tiles (48 per core) the grid is already full. Split-K therefore only adds partial-sum traffic, and above 16 rows no tile beats legacy.
   - New `pf_policy` branch for more than 16 column tiles per core (only lm_head on this model): unsplit r16n128s4 at m ≤ 16, legacy above.
   - Re-measured on the final build in s4:
     - m=14: 1.767 → 1.585 ms (routed = unsplit tile);
     - m=16: 1.761 → 1.608 ms;
     - m=17–32: routed = legacy, at 1.767–1.796 ms. r32n256s8 would take 1.892–1.927.
   - Routed lm_head is now **bitwise equal to legacy** (Δlegacy 0.0000).
   - Outputs are identical to r7 in every compared run: all 56 batched T=0 slots and 22 sampled slots (TH_BATCH=2 pass 1; TH_BATCH=4 passes 1–2), and all 15 single-slot requests (T=0 and sampled).

**Branch state:**

- History: `cf3e5f7 ← 0451fd5 ← 434a4db ← e1b6323 ← b2cd3c9 ← 8cd93db ← 25c6f93 ← dc203fd`.
- `git merge-tree --write-tree cf3e5f7 HEAD` is clean, and main is an ancestor, so the merge is a fast-forward.
- The worktree is clean. Nothing was pushed, and main was not touched.

### Builds used below (all clean trees, `cargo build --release` in this worktree; binaries in `engine/target/wp10/`)

| label | commit | binary | sha256 |
|---|---|---|---|
| main | `cf3e5f7` (built from a detached checkout of main in this worktree) | `th-engine-main-cf3e5f7` | `4e12d56b07e5…` |
| r7 (s3 candidate) | `25c6f93` | `th-engine-r7-25c6f93` | `b76d16366577…` |
| r8 (final = HEAD) | `dc203fd` | `th-engine-r8-dc203fd` (cmp-identical to `target/release/th-engine`) | `e7cdf46406de…` |

- r8 differs from r7 only in the lm_head route at rows > 8.
- The two builds' T=0 and sampled outputs are identical in every compared batched and single-slot run (above). The r7 E2E numerics (token identity, acceptance) therefore carry over to r8 unchanged; only timing needed re-measuring.

### Gates

Runs:

- **s3:** 03:03–03:20, one gpu-lock hold, candidate r7.
- **s4:** 03:25–03:36, one hold, final r8.

All E2E runs used a fresh server on the private port **:8013** with `TH_DEBUG_TIMING=1`. :8000 and :8001 were never touched.

| gate | result |
|---|---|
| **V-build** | **PASS.** 0 warnings, 0 errors for each of the 7 branch commits and for main `cf3e5f7`. |
| **Unit** | **PASS.** `cargo test --release`: **11/11**, the 8 pre-existing tests plus the 3 new `pf_tests`. U1 has no tests on this branch. |
| **V-lin, decode half** (`TH_BENCH_LIN=dec`, main vs r7) | **PASS.** All **28/28** max\|Δ\| lines are identical, as expected since the decode kernels are untouched. Single-shot timing, cand/main geomean 1.021 [0.88, 1.29], is inside the A/A noise band documented in the U1 report. |
| **V-lin, prefill half** (`TH_BENCH_LIN=pf`, r7: 12 projections × m ∈ {14, 16, 21, 24, 28, 32, 58, 64, 80, 128}; r8: lm_head × m ∈ {14, 16, 17, 21, 24, 28, 32}) | **PASS.** In all 120 + 7 cells, routed Δref (vs the fp32 reference) equals legacy's exactly. Max routed Δlegacy is 0.0625, i.e. 1 bf16 ulp. Timings are in the table below. |
| **V-multi** (`TH_BENCH_MULTI=8` and `=1`) | **PASS: equal or faster.** fwd1: main 45.1–49.2 ms, r7 45.6–49.0, r8 44.9–45.7. fwd8: main 51.3–51.8, r7 47.2–48.3, r8 46.9–48.3. See note ¹. |
| **Prefill logits** (61-token prefill, main vs r7) | max\|Δ\|=0.125, argmax 3362 in both, top-8 set identical (near-tie order differs). This matches the pre-rebase c2/c3/final. |
| **In-process prefill A/B** (`TH_BENCH_PREFILL`, r7, legacy vs tiles, median of 6 each; TTFT path) | Tiles/legacy by m: 16: 0.522, 32: 0.663, 58: 0.854, 64: 0.844, 68: 0.885, 80: 0.896, 128: 0.886. Pre-rebase: 0.546 / 0.669 / 0.851 / 0.861 / 0.875 / 0.904 / 0.864. |
| **In-process batched-verify A/B** (`TH_BENCH_BATCH`, `TH_BATCH=4`; r7 in s3, r8 in s4; 2 repeats each; see table) | **PASS.** Median ms, legacy → tiles: nb=2 −35.6 to −47.2 ms (ratio 0.656–0.682); nb=3 −25 to −31 ms (0.78–0.80); nb=4 −25 to −33 ms (0.80–0.82). The verify logits are no further from the reference than legacy's are; see below the table. |
| **T=0 A/B, single slot** (e2e.py, 15 requests: 6 T=0 + 9 sampled) | **PASS.** Short and code are identical to main. Long diverges at emitted token 119 of 125, deterministically, as in the pre-rebase review (≤ 1 ulp prefill numerics). Sampled runs diverge early, as expected. r8 == r7 on all 15. |
| **Batched, `TH_BATCH=2`** (ABBA in s3; one AB pair in s4) | **PASS; accepted with numbers.** Pooled over s3: **122.53 → 97.93 ms/round (−20.1%)**, 6.268 → 6.441 tok/round, **51.15 → 65.77 tok/s (+28.6%)**. T=0 slot outputs match main in **18/32**. Divergence points: long@8, story@110, sql@83, story@51 (real prompt). Each point reproduces exactly across reps and passes. |
| **Batched, `TH_BATCH=4`** (BAAB in s3; ABBA in s4) | **PASS; accepted with numbers.** Pooled over s4 (final r8, no concurrent work from this agent): **187.67 → 151.35 ms/round (−19.4%)**, 12.318 → 11.865 tok/round, **65.63 → 78.39 tok/s (+19.4%)**. s3 gave +19.6%. T=0 slot outputs match main in **12/40**. |
| **Control: `TH_PF=0`, TH_BATCH=4** (r7 binary, legacy routing everywhere) | **PASS.** **20/20** T=0 slot outputs identical to main, with an identical composition in every set-run. The tile routing is therefore the only behavioural difference from main in the batched path. |
| **Determinism and admission** | Every T=0 set-run in every arm is identical rep1 vs rep2 and pass 1 vs pass 2. **129/129** scored batched set-runs (s3 + s4) start at nb=B. No `batch round failed` or `admit failed` lines, no errors, no panics. The token-attribution check (attributed == streamed) passes in every set-run. |

¹ fwd8 has been consistently about 3.5 ms faster than base on every branch build since `1327a11`, in the pre-rebase review as well. Only the preceding 61-token prompt prefill differs, since it is tile-routed. The fwd8 pass itself runs the untouched decode kernels, with identical max|Δ| in V-lin dec. The likely cause is buffer-pool state left by the prefill, a probe-mode artifact rather than a kernel change; it is unconfirmed.

**V-lin prefill half, batched-decode shapes.** r7 in s3, min ms legacy → routed, then routed config:

| proj | m=14 (7·nb, nb=2) | m=16 (8·nb, nb=2) | m=24 (nb=3) | m=32 (nb=4) |
|---|---|---|---|---|
| down | .823→.144 5.72× k4 | .740→.131 5.65× k4 | .737→.222 3.32× k2 | .723→.222 3.26× k2 |
| gate_up | .378→.305 1.24× gu | .352→.294 1.20× gu | legacy | legacy |
| in_all | .274→.137 2.00× k2 | .259→.139 1.86× k2 | .261→.223 1.17× s8 | .258→.216 1.19× s8 |
| out / o | 4.7× / 4.8× k4 | 4.6× / 4.7× k4 | 3.1× / 3.1× k2 | 3.1× / 3.0× k2 |
| in_qkv | 2.19× k2 | 2.20× k2 | 1.10× s8 | 1.11× s8 |
| draft qkv / attn_dyn / selector | 3.6× / 4.7× / 5.0× | 3.8× / 4.8× / 5.0× | 2.2× / 4.4× / 4.9× | 2.3× / 4.8× / 5.0× |
| draft gate / up (single-stream) | 1.49× k2 | 1.60× k2 | 1.10× s8 | 1.12× s8 |
| lm_head (r8 route) | 1.10× unsplit | 1.09× unsplit | legacy | legacy |

- "s8" is r32n256s8; lm_head timings are from s4.
- Per-cell details, with med, Δref and Δlegacy:
  - `runs/s3/pfroute.txt`, from `runs/s3/vlin-pf.cand.log`;
  - `runs/s4/vlin-pf.cand.log`, for lm_head on r8.

**In-process batched-verify A/B** (median ms, legacy → tiles):

| nb (rows) | s3 r7, run 1 | s3 r7, run 2 | s4 r8, run 1 | s4 r8, run 2 |
|---|---|---|---|---|
| 2 (16) | 137.4→90.2 (0.656) | 121.1→80.5 (0.665) | 111.9→76.3 (0.682) | 113.1→76.3 (0.675) |
| 3 (24) | 141.7→110.7 (0.782) | 145.0→114.5 (0.790) | 126.8→101.5 (0.801) | 128.6→103.2 (0.803) |
| 4 (32) | 154.8→124.1 (0.802) | 166.2→133.3 (0.802) | 141.2→115.9 (0.821) | 142.7→117.4 (0.823) |

The logit numerics are identical across all 12 runs:

- **Tiles vs legacy:** max\|d\| 0.156 at nb=2 and 0.125 at nb=3/4. Argmax agrees on 16/16, 24/24 and 32/32 rows.
- **Against the single-slot 8-row verify:** legacy and tiles both give max\|d\| 0.125 with 100% argmax agreement. This is the batch-shape noise main already has.
- **Slot invariance:** legacy **0.0000**, tiles **0.1250**. Observation 1 localises this to the 8-simdgroup and fused gate/up tiles.

### Batched decode A/B in detail (finding 2)

**How the numbers are computed.**

- **Per-round wall ms** comes from the timestamped `[batch]` lines.
- **Tokens per round** come from the SSE bursts.
- **Excluded rounds:** each set-run's first round, because it contains the admission prefills.
- **Aggregation:** ratio of sums over all scored rounds, whatever nb they ran at.
- **Workload:** sampled runs use 0.6 / 0.95 / 20, seeded per slot, and every request is capped at max_tokens=128.

| session / arm | order | rounds | ms/round | tok/round | per-slot tok/round | loop tok/s |
|---|---|---|---|---|---|---|
| s3 TH_BATCH=2 main | 1, 4 | 426 + 426 | 122.97, 122.09 | 6.268 | 3.527 | 50.97, 51.34 |
| s3 TH_BATCH=2 r7 | 2, 3 | 417 + 417 | 99.91, 95.95 | 6.441 | 3.475 | 64.47, 67.13 |
| **s3 TH_BATCH=2 pooled** | | 852 / 834 | **122.53 → 97.93** | 6.268 → 6.441 | 3.527 → 3.475 | **51.15 → 65.77 (+28.6%)** |
| s3 TH_BATCH=4 r7 | 1, 4 | 289 + 289 | 171.13, 140.46 | 11.865 | 3.474 | 69.33, 84.48 |
| s3 TH_BATCH=4 main ² | 2, 3 | 277 + 277 | 194.42, 192.55 | 12.318 | 3.607 | 63.35, 63.97 |
| s3 TH_BATCH=4 pooled | | 554 / 578 | 193.49 → 155.79 | 12.318 → 11.865 | 3.607 → 3.474 | 63.66 → 76.16 (+19.6%) |
| s3 TH_BATCH=4 r7 `TH_PF=0` (control) | 5 | 277 | 162.64 | 12.318 | 3.607 | 75.73 |
| s4 TH_BATCH=4 r8 | 1, 4 | 289 + 289 | 137.32, 165.39 | 11.865 | 3.474 | 86.41, 71.74 |
| s4 TH_BATCH=4 main | 2, 3 | 277 + 277 | 188.76, 186.58 | 12.318 | 3.607 | 65.26, 66.02 |
| **s4 TH_BATCH=4 pooled (final)** | | 554 / 578 | **187.67 → 151.35** | 12.318 → 11.865 | 3.607 → 3.474 | **65.63 → 78.39 (+19.4%)** |
| s4 TH_BATCH=2 main → r8 ³ | 5, 6 | 426 / 417 | 125.26 → 110.56 | 6.268 → 6.441 | 3.527 → 3.475 | 50.04 → 58.26 (+16.4%) |
| s4 TH_BATCH=2, excluding 2 disturbed set-runs in both arms | | 347 / 335 | 124.72 → 99.08 | 6.285 → 6.540 | 3.541 → 3.517 | 50.40 → 66.01 (+31.0%) |

- **Full-batch rounds only.**
  - nb=2: iso T=0 135.81 → 101.20 ms, iso sampled 142.37 → 103.84, real T=0 137.33 → 101.69 (s3 pooled).
  - nb=4: iso T=0 202.40 → 163.43, iso sampled 227.08 → 185.02, real T=0 194.91 → 155.02 (s4 pooled).
  - That is −34 to −42 ms per round.
- **nb=1 rounds** (steady state, s3) are the noise reference: they route no rows through the tiles.
  - They measured main 68.6 vs r7 74.3 ms at TH_BATCH=2, and main 82.4 vs r7 76.2 at TH_BATCH=4.
  - That is ±6 ms per round in either direction.
- **Timing noise.** The machine was shared, with loadavg 4–16 from other agents during the arms.
  - The same binary varied by up to 20% between passes: r8 TH_BATCH=4 gave 137.3 vs 165.4 ms/round.
  - The `TH_PF=0` control (legacy routing) ran in a quiet slot and measured 162.6 ms/round, below both main TH_BATCH=4 arms of s4 (186–189). That gap is noise between identical GPU work.
  - Even so, in every order-balanced pairing, **every candidate arm is faster than every main arm at the same B**: TH_BATCH=2 96.0–110.6 vs 122.1–125.3 ms/round; TH_BATCH=4 137.3–171.1 vs 186.6–194.4.
  - The in-process interleaved probe isolates the verify alone, and it agrees in sign and size.
- ² s3's main TH_BATCH=4 arms overlapped this agent's own niced `cargo test`/`cargo build` (loadavg 13.6–16.1). s4 re-ran TH_BATCH=4 order-balanced, with no concurrent work from this agent.
- ³ Two set-runs in s4's r8 TH_BATCH=2 arm have single external stalls, one round of 568 ms and one of 483 ms: iso set0 rep1 and iso set1 rep2.

**T=0 per-slot identity vs main.**

- **Divergence texts** (first divergent token, main | cand) are all near-synonym choices at near ties:
  - "Need **produce** final" | "Need **summarize** key design constraints";
  - "It was green **and cold**" | "green **glass**";
  - "(customer_id, **total**_value" | "**order**_value";
  - "Need likely exactly or **around** 150" | "**about** 150";
  - "It's a story, **likely** prose" | "**so likely** prose";
  - "Could show a **conceptual example of chaining**" | "**a minimal hash map**";
  - "Compare load factor, **memory**," | "**performance**,".
- **These are numerics flips, not a bug:**
  - the verify logits are no further from the reference than legacy's are (max\|d\| 0.125, argmax 100%);
  - `TH_PF=0` restores bitwise identity with main;
  - there is no acceptance collapse, garbage or error. The untracked-Arc failure mode showed as acceptance collapsing to 0.
- **Composition caveat.** Divergence changes when a slot finishes, so the nb composition differs between arms from that point on. Main's batched output is itself composition-dependent (U1 fix pass). Here, main makes the hash@106 choice in opposite directions in set0 (slot 3) and set1 (slot 2), which have different co-scheduling: "conceptual example" vs "a minimal hash map". The candidate flips the same pair.

**Acceptance** (per request: tokens per round it took part in; s3, r7 = r8 outputs):

| group | TH_BATCH=2 main → cand | TH_BATCH=4 main → cand |
|---|---|---|
| T=0, output identical to main (same text; draft routed) | 3.275 → **3.323** (+1.5%, n=18) | 3.948 → **4.032** (+2.1%, n=12) |
| T=0, diverged: shared prefix only | 5.000 → 4.930 | 3.665 → 3.654 |
| T=0, diverged: whole request (different text after the divergence; 4 / 8 distinct texts) | 4.116 → 3.514 | 3.466 → 3.192 |
| sampled (seeded) | 3.561 → 3.848 | 3.791 → 3.777 |

- On identical text, acceptance is equal or higher, so the routed draft projections do not hurt the proposals.
- The lower whole-arm per-slot tok/round (−1.5% / −3.7%) comes from the diverged T=0 texts after their divergence point. On their shared prefix, acceptance is equal.

### Decision on finding 2: accept; no gate

- **Batched decode is the case that gains most.**
  - At 16–32 rows, main's legacy `AffineQmppPrefill` runs at most one threadgroup per core on the N=5120 projections.
  - The tiles cut the verify forward by 25–47 ms and the full round by about 20% (+19 to +29% loop tok/s at TH_BATCH=2 and 4).
- **Gating would forfeit that gain.** Either proposed gate would keep these rounds on legacy:
  - a `prefill: bool` argument;
  - routing only when m > 8·TH_BATCH.
- **What the numerics show.** Divergences are 1-ulp near-tie flips; acceptance on identical text is unchanged or better; `TH_PF=0` gives bitwise identity with main.
- **Mid-decode compile risk is removed** by `pf_warm` (25c6f93).
- **The one shape that did not pay (lm_head above 16 rows)** now routes to legacy (dc203fd).

### Other observations (not fixed here)

1. **Slot invariance is no longer bitwise at the tiles.**
   - Given identical inputs and state, slot b's verify logits match slot 0's to within 0.125 (1 bf16 ulp at the logit scale). Legacy matches bitwise.
   - Accuracy vs the fp32 reference is unchanged in every cell (Δref identical), and every run is deterministic.
   - **Located with a diagnostic probe, not committed.**
     - The patch is `engine/target/wp10/rowinv-probe.patch` (`TH_PF_ROWINV=1`, no model) and the binary is `th-engine-rowinv-dc203fd+probe`.
     - Output is in `runs/s5/rowinv.log`, from one gpu-lock hold at 03:49.
     - Method: all rows of x identical, then max\|y[r] − y[0]\| on synthetic tiled weights for down, out, in_all, gate_up and lm_head, at m = 16, 24 and 32.
   - **Probe results:**
     - legacy, r16n128s4 and r32n128s4, with or without split-K (+k2/+k4): **bitwise row-invariant**;
     - the 8-simdgroup tiles r32n256s8 and r16n256s8: rows 8.. of each row tile differ from rows 0–7 by 1 bf16 ulp (0.0005–0.03 at those magnitudes), on down, in_all, gate_up and lm_head;
     - the fused gate/up tile r16n128s4+gu: rows 8–15 differ;
     - the out projection shows no difference in any config.
   - **Routed decode shapes this affects:**
     - gate_up at nb=2 (+gu);
     - in_all / in_qkv at nb=3/4 (r32n256s8);
     - draft gate/up at 17..32 rows (r32n256s8).
   - Consequence: at the 1-ulp level, a request's batched T=0 output can depend on which slot it lands in. Main's batched output already depends on composition (U1 fix pass).
   - **Follow-up option, not done here.** In this sweep r16n128s4 + split-K beat r32n256s8 at 17..32 rows, and it is row-invariant:
     - in_qkv, m=24: 0.169 vs 0.201 ms;
     - in_all, m=21–28: 0.211–0.217 vs 0.216–0.224 ms;
     - draft gate, m=21–28: 0.186–0.209 vs 0.194–0.213 ms.
   - Routing 17..32 wide rows that way would make nb=3/4 rounds fully slot-invariant, since gate_up and lm_head are legacy there. It needs its own prefill and E2E re-validation.
2. **Pre-existing on main; scales with `TH_BATCH` (for Codex: `dflash.rs`).**
   - `draft_attn(..).unsqueeze(0)` hands `o_proj` a tensor of shape [1, 8·nb, 32, 128]. `QLin` reads it as 256·nb rows × 128.
   - The legacy prefill kernel treats that buffer as 256·nb × 4096. At TH_BATCH=4 that is a 1024-row GEMM per draft layer (×5 layers per propose), and it reads about 7.75 MB past a 256 KB buffer.
   - Only rows 0..8·nb are used. They are correct, and the rest is discarded.
   - The branch's shape guard keeps this input on its legacy behaviour, byte for byte.
   - Suggested fix: `.reshape((1, 8*nb, 4096))` before `o_proj`. That would give an 8·nb-row tile route and also make propose cheaper.
3. **Merge note for Codex's multi-slot WIP (main working tree).** The branch touches the same three files, `main.rs`, `qwen35.rs` and `quant_kernel.rs`.
   - `qwen35.rs` changes:
     - an added `QLin::linear` / `gate_up_act` routing block;
     - `bench_prefill` bench code;
     - a `pf_warm` call at the top of `Qwen35::load`.
   - `main.rs`: probe-mode blocks only.
   - None of these touches the slot APIs, beyond the `clear_kv_cache(0)` calls on slot 0 in probe mode.

### Exact commands (this fix pass)

```sh
export SP=/private/tmp/claude-501/-Users-benebsworth-projects-token-horizon/23793a29-ce9d-4130-926c-f9e358304530/scratchpad
WT=/Users/benebsworth/projects/token-horizon/.worktrees/th/wp10-prefill-tiles; W=$WT/engine/target/wp10
# rebase: detached replay onto main
git -C $WT switch --detach cf3e5f7
git -C $WT cherry-pick 1327a11   # + clear_kv_cache(0), build, amend -> 0451fd5
git -C $WT cherry-pick 872a0fd 1de5480   # -> 434a4db e1b6323 (build each)
git -C $WT cherry-pick dbf01ad   # conflict in main.rs: keep the A/B block + clear_kv_cache(0) -> b2cd3c9
git -C $WT branch -f th/wp10-prefill-tiles HEAD && git -C $WT switch th/wp10-prefill-tiles
git -C $WT range-diff 44aed06..dbf01ad cf3e5f7..b2cd3c9
# + 8cd93db (bench coverage), 25c6f93 (pf_warm + pf_tests), dc203fd (lm_head policy)
(cd $WT/engine && cargo build --release && cargo test --release)   # 0 warnings; 11 passed
# main binary: detached cf3e5f7 in this worktree -> $W/th-engine-main-cf3e5f7
# GPU (one gpu-lock hold each; fresh server per arm on :8013)
$SP/bin/gpu-lock -- $W/bin/s3.sh   # smoke, pf compile, V-lin dec x2 + pf, V-multi 8/1 x2, prefill A/B, TH_BENCH_BATCH, 8 batched arms ABBA/BAAB, 2 single-slot arms, TH_PF=0 control
$SP/bin/gpu-lock -- $W/bin/s4.sh   # final r8: V-lin pf (lm_head), V-multi, TH_BENCH_BATCH, TH_BATCH=4 ABBA, TH_BATCH=2 AB, single-slot arm
# row-invariance diagnostic (uncommitted; patch saved, tree restored and rebuilt to dc203fd)
git -C $WT apply $W/rowinv-probe.patch && (cd $WT/engine && cargo build --release)   # -> $W/th-engine-rowinv-dc203fd+probe
$SP/bin/gpu-lock -- env TH_PF_ROWINV=1 $W/th-engine-rowinv-dc203fd+probe probe --model x --tokens 1   # runs/s5/rowinv.log
# analysis
python3 $W/bin/batch_agg.py $W/runs/s3 main.b2 cand.b2            # also main.b4 cand.b4 candpf0.b4; s4: main.b4 r8.b4 / main.b2 r8.b2
python3 $W/bin/slot_acc.py  $W/runs/s3 main.b2 cand.b2            # acceptance same/diverged
python3 $W/bin/divtext.py   $W/runs/s3/main.b4.p1.json $W/runs/s3/cand.b4.p1.json
python3 $W/bin/pfroute.py   $W/runs/s3/vlin-pf.cand.log
python3 $W/bin/cmp.py       $W/runs/s3/main1.p1.json $W/runs/s4/r8s1.p1.json
```

**Harness and artifacts** (under `$W = engine/target/wp10/`, gitignored):

- **New scripts** in `bin/`:
  - `arm2.sh`: server arm with ts.py timestamping, `/status` capture and load logging;
  - `ts.py`;
  - `batch_e2e.py`: deterministic batched admission, iso/real sets;
  - `batch_agg.py`, `slot_acc.py`, `divtext.py`, `pfroute.py`;
  - `s3.sh`, `s4.sh`, `s3sum.sh`.
- **Outputs:**
  - `runs/s3/`: `session.log`, per-arm `*.server.log`, `*.json`, `*.status.json`, `vlin-*.log`, `probe*.log`, `logits61.*.bin`, `agg.b{2,4}.txt`, `acc.b{2,4}.txt`, `cmp.single.txt`, `pfroute.txt`.
  - `runs/s4/`: the same set for r8.
- **Binaries:** `th-engine-main-cf3e5f7`, `th-engine-r{4..8}-<sha>`, `th-engine-rowinv-dc203fd+probe`.
- **Row-invariance diagnostic:** `rowinv-probe.patch` and `runs/s5/rowinv.log`.

### Cleanup

- Every server was started by `arm2.sh` on :8013, and all were stopped with SIGTERM plus wait inside the arm:
  - s3: 12 servers;
  - s4: 7 servers;
  - the arm logs `WARN pid still alive` if a server survives, and none did.
- The probes, including the row-invariance probe, were one-shot processes.
- The probe patch was reverted with `git checkout`, and `target/release/th-engine` was rebuilt: it is cmp-identical to the r8 binary (HEAD `dc203fd`).
- Nothing listens on :8013.
- :8000 and :8001 were never touched. The live :8001 is still pid 16917.
- The main working tree was never modified; it was only read, with `GIT_OPTIONAL_LOCKS=0`.

### Verdict

- **Both must-fix findings are resolved.**
  - `th/wp10-prefill-tiles` fast-forwards onto main `cf3e5f7` and builds with 0 warnings.
  - All 11 tests pass.
- **The batched decode path is measured.**
  - Routing is accepted: −20% ms/round and +19–29% loop tok/s at TH_BATCH=2 and 4.
  - T=0 divergences from main are 1-ulp near-tie flips; `TH_PF=0` is token-identical to main.
  - Tile libraries are now compiled at load, and lm_head routes to legacy above 16 rows.
- **Every gate passes:** V-build, unit tests, V-lin (decode half identical; prefill Δref identical, Δlegacy ≤ 1 ulp), V-multi, single-slot T=0 A/B, and batched TH_BATCH=2/4 A/B with the TH_PF=0 control.
