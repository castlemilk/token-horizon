# K45: matmul roofline (th/wp2-matmul-roofline)

> **Review-fix pass (2026-09-26): rebased onto main `cf3e5f7`, all gates re-run and passing — see §9.** The shas in §1–§8 are the pre-rebase ones: 3e5cba5 → `05b861f` (K45a), a7c8ade → `5e72124` (K45c), 6ef4247 → `e6d7382` (K45d). The th/wp2-q4-decode base 7557c93..970b1f5 is now `47ae79a..7cdb6b2`, and `5a93868` (TH_BENCH_DRAFT_MLP) is new. Branch HEAD = `5a93868`, a fast-forward of main. §7's "Codex's multi-slot WIP" merge note is resolved by §9.1.

**Status: done.** Three commits on `th/wp2-matmul-roofline` (not pushed), on top of `th/wp2-q4-decode` = `970b1f5`:

| sha | item | one line |
|---|---|---|
| `3e5cba5` | K45(a) | Producer-emitted Q4 input sums ("presum blocks"). Pad copies and the 96 GDN zero-fill blits removed; the split-K tiles skip the in-kernel sums. Bit-identical. |
| `a7c8ade` | K45(c) | `TH_BENCH_Q4_SWEEP` per-shape autotune (tiles × presum × group counts, target and draft shapes) → one table entry (draft gate/up 17408×5120 → N256 sg8, −11%). |
| `6ef4247` | K45(d) | DFlash draft gate/up fused onto the N256 two-stream tile with the silu·mul epilogue. The down projection gets a presum block. T=0 output identical. |

Dropped, with measurements (§4):
- (b) sb-pairs repack: the in-situ bench of the repacked tile lost, and the output was not bit-identical;
- Depth-4 pipelining;
- PreSums + periodic barrier;
- PreSums on the N256/paired tiles (kept off by policy).

Headline numbers (details in §2 and §5):
- **In-situ forward, commit A:** fwd8 43.6 → **40.5 ms (−7.1%)**, fwd5 43.6 → **40.5 ms**, fwd1 45.6 → **42.95 ms (−5.8%)**. Session6; session5 had −4.0 / −3.9 / −3.0 ms. Probe top-8 logits identical.
- **End to end, branch head 6ef4247 vs 970b1f5, 3 interleaved rounds pooled (session6):**
  - all requests: 64.13 → **61.46 ms/round**, 54.16 → **60.42 loop tok/s (+11.6%)**;
  - T=0: 62.76 → **57.77 ms/round (−8.0%)**, 55.67 → **60.48 tok/s (+8.6%)**, with tokens/round unchanged at 3.494.
  - verify 50.8 → 47.5 ms/round; the verify enqueue share (CPU) fell by ~3–4 ms/round.
- **Commit A alone** (its only uncontaminated round; rounds 2–3 overlapped an external GPU consumer): 65.08 → **58.37 ms/round (−10.3%)**, 53.37 → **59.50 tok/s (+11.5%)**. **12/12 requests token-identical to base in all 3 rounds**, T=0 and sampled.
- **Kernel GB/s vs the ≥480 GB/s target (TH_BENCH_Q4, serial mode, 3e5cba5):**
  - gate_up **532–535** — met; it was already met by K1 at base, 518–530;
  - in_all **457–460** — not met (base kernel 427–457 depending on session);
  - down **444** plain / 400 with PreSums (the in-situ A/B prefers PreSums, §2) — not met.
  - out +10%, in_qkv +4% from PreSums.

Context:
- Worktree `/Users/benebsworth/projects/token-horizon/.worktrees/th/wp2-matmul-roofline`. Base for all A/B is `970b1f5` unless labelled `44aed06`.
- Private port 8015. Every GPU run went through `$SP/bin/gpu-lock`. Main working tree, :8000 and :8001 untouched. No serve or probe process is left running; :8015 is free.

## 0. Environment notes (things the task text assumed that were not true)

- `$SP/understand/*` (SYNTHESIS.md, CRITIQUE.md, reader reports) had been wiped by a scratchpad reset. I recovered them verbatim from the workflow transcripts (last `Write` + later `Edit`s replayed) into `/tmp/k45u/` and used SYNTHESIS v2 §3.0 / §3.4 K45 from there.
- `$SP/bin/wt-bootstrap`, `$SP/bench/qbench`, `$SP/mtlcount`, `$SP/parse_log.py`, `waitquiet.py` did not exist. I created the worktree by hand (`git worktree add -b th/wp2-matmul-roofline .worktrees/th/wp2-matmul-roofline th/wp2-q4-decode`, target/release APFS-cloned from the wp2-q4-decode worktree) and used the in-engine `TH_BENCH_Q4` bench (real weights, every layer's tensor per pass) instead of qbench. New helper scripts are in `$SP/phaseB/k45/`.
- `$SP/bin/th-engine-44aed06` already existed (sha256 `8800724ea990…`); my own base build of `970b1f5` is `$SP/phaseB/k45/th-engine-base-970b1f5` (sha256 `0f4f15c4a5ba…`).
- The machine was shared: 5–7 agents queued on the GPU lock, and CPU load average swung between 7 and 29 (other agents' cargo builds). The lock serializes the GPU but not the CPU; verify enqueue is CPU-bound (~10 ms/round), so e2e runs drift by several ms/round over minutes. I therefore gate on in-process A/Bs (`TH_BENCH_MULTI` forward timings, interleaved rounds, several variants per session) and use interleaved e2e ABAB rounds, never single runs.

## 1. What changed (commits on th/wp2-matmul-roofline, not pushed)

### 3e5cba5 K45(a): producer-emitted Q4 input sums ("presum blocks")

Every MPP decode tile (m <= 8) recomputed the per-(quant group, row) input sums in every threadgroup (`q4_store_input_sums`, a threadgroup barrier every 4 quant groups), and every m < 8 projection first ran the pad copy (`affine_q4_mpp_pad` + a pooled x8 buffer). A **presum block** is the zero-padded [8, in] bf16 operand followed by the f32 sums `[in/64][8]` (`quant_kernel::presum_block_bytes`). The producer writes it once with the tiles' exact lane pattern `simd_sum(x[64g+l] + x[64g+32+l])`, so results are bit-identical (verified: bench Δpath = 0, probe top-1 logits identical, e2e ids identical at T=0 and sampled — §5).

Producers:
- `gdn_kernel::AddRmsNorm { sums: true }`, new kernel `add_rmsnorm_sums` (T <= 8): the output buffer is `res [T,C] | nrm [8,C] (rows >= T zero) | sums`. It feeds GDN `in_all`, attention `in_qkv` and MLP `gate_up`. The per-element math is the same as `add_rmsnorm`.
- The N256 gate_up tile, `AffineQmpp { emit_sums: true }` (`EmitSums` template, unguarded store of all 8 rows). The silu·mul outputs are staged in threadgroup memory (4 KB) and the down projection's sums are written after the 8-row block.
- `gdn_fused_step(.., sums: true)`: the gated-norm stage writes the out projection's block (each value head owns quant groups 2hv and 2hv+1; rows >= T are zeroed). Both outputs (`gated`, `pack`) are now allocated uninitialized (`quant_kernel::AllocBf16`: a pooled buffer, no dispatch) because the kernel writes every element. This removes **two zero-fill blits per GDN layer (96 per forward)**.

Consumers:
- `QLin::linear_ps` / `gate_up_act_ps` / `lin_apply_ps` bind the block directly at any m. There is no pad copy and no x8 allocation, also for K > 8192, where P0 kept the pad.
- `AffineQmpp` validates the block (16-byte offset, buffer length >= offset + block) and bails otherwise.
- The PreSums tile variants (`affine_q4_mpp_*_ps`) stage the sums into dynamic threadgroup memory once per dispatch and drop the recompute and its barriers.
- **Policy `quant_kernel::ps_family_on`, default `split,split_long`:** only the split-K tiles (n64s4 / n32s4) take the PreSums kernel on their presum inputs. In production that is out, in_qkv and down; attention `o` has no presum producer yet (§8). The N256 and paired tiles (in_all, gate_up, lm_head) bind the block but keep recomputing the sums, because their PreSums twins were slower in situ (§2).
- Switches (all read once, `OnceLock`):
  - `TH_Q4_PRESUM=0` or `TH_Q4_POLICY=legacy` turns the whole path off;
  - `TH_Q4_PS_FAMILIES=a,b|all|none` overrides the policy (A/B only).

Also in this commit:
- `MPP_SRC` is compiled once per process. Before, it was compiled once per entry point (~10 × 0.4–0.8 s at first use).
- `mpp_probe` now builds every MPP pipeline.
- The two per-layer `std::env::var` reads in `gdn_forward` (`TH_GDN_EAGER`, `TH_GDN_STEP`) are cached once.
- `TH_BENCH_Q4` gained:
  - a `path+ps` arm (presum-block input);
  - `+ps` and bind-only (`+pb`) candidates;
  - a default serial mode that puts a buffer barrier after every call, like the forward's dependent chain (`TH_BENCH_Q4_SERIAL=0` restores the old overlapping mode);
  - `TH_BENCH_Q4_ONLY=`;
  - an emit check that runs down on the emitted block, on an attach-op block and on a recompute, and requires max|Δ| = 0 between them.
- `TH_BENCH_MULTI` accepts a comma list (`8,5,1`) and `TH_BENCH_MULTI_ITERS`.
- `quant_kernel::Q4AttachSums` builds a block from any activation. It is used by the bench only.

### a7c8ade K45(c): decode-tile autotune sweep and a draft gate/up table entry

- `TH_BENCH_Q4_SWEEP=1` is a Splash `tune-kernels`-style sweep over:
  - every tile family, each plain and with a presum input;
  - persistent-group counts {1,2,3,4,6,8} × cores plus the full grid;
  - all 27B projection classes;
  - the DFlash draft shapes (dyn 1280×5120, qkv 6144×5120, o_proj 5120×4096, gate/up 17408×5120, fc 5120×25600 at m=4, selector 256×5120 at m=7, lm_head at m=7). These are timed on prefix views of target tensors (timing and cross-kernel Δ only).
- Result: the existing group policies (full grid / one resident wave) win every shape.
- The only tile change is the unfused draft gate/up (17408×5120): N256 sg8, 122.3 vs 137.0 µs (−11%). It is now in `DECODE_TILE_TABLE`, with a unit-test case. The full table is in §3.

### 6ef4247 K45(d): DFlash draft gate/up fused onto the N256 two-stream tile

- `DraftLayer.gate` and `.up` are loaded row-major, fused (`fuse_lins`, now `pub(crate)`) and then tiled, so the draft MLP runs `gate_up_act_ps` (the target's N256 two-stream tile with the silu·mul epilogue).
- This replaces two projections plus an eager silu plus a mul, and hands `down` a presum block.
- Numerics: silu·mul is now rounded once, as in the target kernel, instead of twice. Draft proposals can therefore change. Target greedy output is unaffected (T=0 ids identical); sampled trajectories differ from base (§5).

## 2. In-situ forward A/B: the gate that decided the policy

- **Method.**
  - Full model forward in one process: `TH_BENCH_MULTI=8,5,1 TH_BENCH_MULTI_ITERS=5 th-engine probe` (wall time of forward_multi plus readback).
  - Variants are env switches of one binary (`$SP/phaseB/k45/th-engine-k45-wip6`, whose kernels at default settings are exactly those of 3e5cba5), interleaved over 3 rounds.
  - 15 samples per cell; base has 9 samples, because 970b1f5 supports only a single m per process.
- **Session:** `$SP/phaseB/k45/s5`, script `session5.sh`, load average 7.5–15.5.
- Probe top-1 logit is identical in all 24 runs (`279:15.6875`).

| variant (wip6 env) | fwd8 median (min) ms | fwd5 median (min) ms | fwd1 median (min) ms |
|---|---|---|---|
| base 970b1f5 | 44.40 (43.2) | 43.60 (43.2) | ~45.3 (session2) |
| **default: presum, PreSums on split + split_long** | **40.40 (39.8)** | **39.70 (39.5)** | **42.30 (41.7)** |
| PreSums on split (K <= 8192) only | 40.90 (40.3) | 41.10 (40.1) | 42.50 (41.6) |
| bind-only everywhere (`TH_Q4_PS_FAMILIES=none`) | 41.50 (40.8) | 41.70 (41.0) | 43.60 (42.4) |
| PreSums everywhere (`=all`) | 42.10 (41.4) | 42.10 (41.6) | 43.20 (42.4) |
| Depth-4 on N256 (`TH_Q4_DEPTH=n256`) | 40.80 (40.1) | 40.50 (39.8) | 42.60 (42.3) |
| presum off (`TH_Q4_PRESUM=0`) | 43.80 (43.2) | 44.20 (43.7) | 45.80 (45.1) |

Reading of the table (differences between rows):

| step | fwd8 | fwd5 |
|---|---|---|
| presum blocks bound directly, pads removed, GDN zero-fill blits removed (bind-only vs presum-off) | −2.3 ms | −2.5 ms |
| PreSums kernels on the split-K tiles (default vs bind-only) | −1.1 ms | −2.0 ms |
| PreSums on the N256/paired tiles too (all vs default) | +1.7 ms | +2.4 ms (excluded) |

**Net vs 970b1f5: fwd8 −4.0 ms (−9.0%), fwd5 −3.9 ms (−8.9%), fwd1 ≈ −3.0 ms (−6.6%).**

Earlier session4 (`s4`, wip5, 3 samples each, load average 16–29) had the same ordering:

| variant | fwd8 median | fwd5 median |
|---|---|---|
| gu + n256 bind-only (= today's default) | 40.8 | 40.6 |
| bind-only everywhere | 41.0 | 41.0 |
| PreSums + a barrier every 4 groups | 41.8 | 41.0 |
| PreSums everywhere | 43.8–45.2 | 42.5–47.6 |
| Depth-4 on every family | 46.3 | 45.7 |
| presum off | 47.2 | 45.2 |

Session2 (`s2`, wip3 = staged PreSums on every family) had fwd8 42.1 vs 43.9 (presum off), fwd5 42.1 vs 43.3, fwd1 41.6 vs 44.6. Base 970b1f5 in the same session: fwd5 43.8, fwd1 45.2.

## 3. Kernel-level numbers (TH_BENCH_Q4, real weights, all layers per pass, host-timed µs/call → GB/s)

### 3.1 Production path per class, serial mode, quiet GPU

Session2 (`s2/c3.q4serial.log`, wip3; kernel code identical to 3e5cba5 for these arms).

| class (bytes/call) | base path (policy tile) | best K45 in-situ config | notes |
|---|---|---|---|
| gate_up (100.3 MB) | 189.1 µs **530 GB/s** (N256 gu, in-kernel sums) | same kernel + emit (`path`) 189.1 µs, 530 GB/s | PreSums twin 242–245 µs (bench) — excluded |
| down (50.1 MB) | 125.4 µs 400 GB/s (n64s4 + pad) | n64s4 PreSums on a presum block; bench 134.8, in situ faster (§2 split_long row) | bench and in-situ disagree; in situ wins |
| in_all (47.5 MB) | 111.2 µs 427 GB/s (N256 sg8) | bound directly, in-kernel sums, 111.2 µs | PreSums 142.6 (bench); D4 107.6 in bench but lost in situ |
| out (17.7 MB) | 49.3 µs 359 GB/s | **n64s4 PreSums 43.8–44.0 µs, 402–404 GB/s (−11%)** | |
| in_qkv (41.3 MB) | 112.2 µs 368 GB/s | **n64s4 PreSums 106.5 µs, 387 GB/s (−5%)** | |
| o (17.7 MB) | 61.4 µs 288 GB/s | n64s4 PreSums 54.0 µs, 328 GB/s (−12%) | not used: the attention output is not a presum block |
| lm_head (715 MB) | 1389 µs 515 GB/s (paired sg4) | unchanged | n32s4+ps 1345 µs (−3%) would need an attach dispatch; not taken |

**Target ≥480 GB/s on gate_up/down/in_all:**
- gate_up: **met** (518–530 GB/s). It was already met at 970b1f5 by K1.
- in_all and down: **not met**. The best in-bench numbers are 427–441 GB/s (in_all) and 400–428 GB/s (down).
- The fixed per-dispatch ramp (~8 µs) plus 65 / 80 threadgroups on 40 cores cap these two below 480 with the current tile families. No tile, group count or depth variant in the sweep beat the policy on them.

Bench caveats:
- The TH_BENCH_Q4 `+ps` arms mis-rank the N256 PreSums kernels (27–28% slower in the bench, far less in situ). The bench feeds every call the same attach-op block.
- Only the forward A/B (§2) decided policy. Session3 (`s3`) ran right after a long session and was thermally/contention-noisy (min/median spreads of 30–60%); I did not use it for decisions.

### 3.2 Autotune sweep (TH_BENCH_Q4_SWEEP=1, session1 `s1/candA.probe8.log`, table `$SP/phaseB/k45/sweep_table_s1.md`)

| shape (N×K, m) | policy path µs (GB/s) | best candidate µs (GB/s) | best without presum |
|---|---|---|---|
| gate_up 34816×5120, 8 | 195.5 (513) | n256_gu_sg8 195.6 (513) | = policy |
| down 5120×17408, 8 | 117.7 (426) | n64s4 117.2 (428) | = policy |
| in_all 16480×5120, 8 | 116.7 (407) | n32s4+ps 112.1 (423) | N256 sg8 = policy |
| out 5120×6144, 8 | 54.0 (328) | n64s4+ps 46.3 (382) | n64s4 = policy |
| in_qkv 14336×5120, 8 | 118.0 (350) | n32s4+ps 106.5 (388) | n64s4 = policy |
| o 5120×6144, 8 | 63.7 (278) | n32s4+ps 56.0 (316) | n64s4 = policy |
| lm_head 248320×5120, 8 | 1572.8 (455) | n32s4+ps 1505.9 (475) | p256 g160 = policy |
| draft dyn 1280×5120, 8 | 36.4 (101) | n32s4+ps 31.8 (116) | n64s4 = policy |
| draft qkv 6144×5120, 8 | 60.6 (292) | n32s4+ps 50.3 (351) | n64s4 = policy |
| draft o 5120×4096, 8 | 36.5 (323) | n32s4+ps 31.1 (379) | n64s4 = policy |
| **draft gate/up 17408×5120, 8** | 137.0 (366) | **n256_sg8 122.3 (410)** | **N256 sg8 → table entry** |
| draft fc 5120×25600, 4 | 169.7 (435) | n64s4 168.7 (437) | = policy |
| draft selector 256×5120, 7 | 32.8 (22) | n64s4+ps 25.2 (29) | = policy |
| lm_head m=7 | 1607.6 (445) | n32s4+ps 1507.3 (474) | p256 g160 = policy |

- Every persistent-group override ({1,2,3,4,6,8} × 40 cores, full grid) was slower than or equal to the policy. For example, gate_up at 40, 34 or 60 groups ran 290–312 µs vs 194 µs at 68.
- The `+ps` wins on the draft and lm_head shapes need presum inputs. Those producers are the candle rms_norm and the draft's dconv / rms_norm, which do not emit blocks yet. That is follow-up work: an estimated −5 to −10 µs per draft projection call and −40 to −60 µs per lm_head call.

## 4. Tried and dropped (measured losers; code removed, not left behind switches)

- **(b) sb-pairs repack: (scale, bias) interleaved as one bfloat2 per (tile, group, col), an in-situ bench of one repacked tile per class (session3).**
  - Gate_up, in_all and in_qkv got slower (gate_up +13% vs `+ps`); down, out and o were flat or slower.
  - It was also not bit-identical (Δpath 2^-8: FMA contraction changed under fast-math).
  - A lane-interleaved weight repack cannot help the MPP tiles: `matmul2d` already reads one contiguous 8 KB (tile, group) block per quant group, and the lane→element mapping of the cooperative load is not ours to choose. Dropped.
- **Depth-4 pipelining (four quant groups in flight, same accumulation order, bit-identical).**
  - Bench: in_all −3 to −4%.
  - In situ: +0.4 / +0.8 ms (N256 only) and +2 to +6 ms (every family). Dropped.
- **PreSums + an execution barrier every 4 groups:** in situ ≈ bind-only (41.8 vs 41.0 ms fwd8), no gain over the default. Dropped.
- **PreSums reading the sums straight from device memory (first version, `wip1`):** superseded by threadgroup staging. It was the same in situ and worse in the bench.
- **Attach-sums for non-producer inputs** (lm_head, attention o, draft projections), i.e. `Q4AttachSums` replacing the pad copy: not taken. The in-situ PreSums loss on paired/N256 tiles leaves only o (16 calls/forward) and draft shapes, worth ≈0.1 ms, which is below the e2e noise. The op stays for the bench.

## 5. End-to-end A/B (serve on :8015, TH_DEBUG_TIMING=1)

- **Prompts:** the 3 bench prompts (short / code / long).
- **Per arm:** T=0 × 1, then sampled (T=0.6, top_p 0.95, top_k 20, seeds 1, 2, 3), 128 max tokens; 12 scored requests.
- **Metrics:** ratio of sums over the [dflash] rounds of the arm: Σtokens / Σstep-ms, ms/round, tokens/round.
- **Ids** are the emitted lists of the [dflash] lines, compared per request. The first token, sampled from the prefill, is not in the log.

### 5.1 Earlier sessions (development builds)

| session | arm (build) | ms/round | tokens/round | loop tok/s | propose / verify ms | ids vs base |
|---|---|---|---|---|---|---|
| s0 | base 970b1f5 | 63.65 | 3.473 | 54.56 | 10.5 / 50.6 | — |
| s0 | 44aed06 | 66.05 | 3.498 | 52.96 | 10.4 / 53.2 | T=0 3/3 equal; sampled differs (K1 changed gate_up numerics) |
| s1 ABBA | base, base | 69.42, 64.10 | 3.473 | 50.03, 54.19 | | |
| s1 ABBA | wip1 (device-read presum, all families) ×2 | 63.78, 62.80 | 3.473 | 54.46, 55.30 | 10.7 / 50.1 | **12/12 identical** |
| s2 ABBA | base, base | 63.80, 78.18 | 3.473 | 54.44, 44.43 | | CPU load 9–11, drifting: unusable for timing |
| s2 ABBA | wip3 (staged presum, all families) ×2 | 72.78, 72.41 | 3.473 | 47.72, 47.97 | | **12/12 identical** |
| s4 ×3 interleaved, pooled | base 970b1f5 | 63.76 | 3.473 | 54.47 | 10.72 / 50.55 | — |
| s4 ×3 interleaved, pooled | wip5 (presum all families + draft fusion) | 60.69 | 3.714 | 61.20 | 10.45 / 47.62 | T=0 3/3 equal; sampled code/long differ (draft fusion) |

### 5.2 Gates on the commit builds (session6, `$SP/phaseB/k45/s6`, script `session6.sh`)

Binaries:
- base `th-engine-base-970b1f5` (sha256 `0f4f15c4a5ba…`);
- A `th-engine-k45a-3e5cba5` (built from 3e5cba5, clean tree, sha256 `ebd0565cc111…`);
- C `th-engine-k45d-cand` (a7c8ade + the K45(d) diff; byte-identical to the build of 6ef4247, `cmp` equal).

| gate | base 970b1f5 | 3e5cba5 (K45a) | verdict |
|---|---|---|---|
| V-build | — | builds; only the pre-existing `draft_kernel.rs` unused-import warning; `cargo test --release` 10/10 | pass |
| V-lin max\|Δ\| vs scalar (77 entries) | — | none worse than base | pass |
| V-lin timing (1 tensor × 10, host-timed) | | every class equal within noise except the first class (gate_up), which was 2–3× slower in A's run on all arms, including the untouched scalar AffineQmm | a first-class DVFS / warm-up artifact of the V-lin method; the interleaved Q4 bench below shows no regression |
| V-multi 8, median (min), 2 rounds | 43.60 (43.3) ms, n=6 | **40.50 (39.9) ms, n=10** | −3.1 ms (−7.1%) |
| V-multi 5 | 43.6 (s5) | **40.50 (39.9)** | −3.1 ms |
| V-multi 1 | 45.60 (45.2) ms, n=6 | **42.95 (42.4) ms** | −2.65 ms (−5.8%) |
| probe top-8 logits | | identical (diff of 8 lines = empty) | bitwise |
| V-roll (`TH_TEST_ROLLBACK=1`) | | PASS, worst \|Δ\| 0.1289 at kept=1 (same value as the pre-K45 builds), argmax ref=rb=ctl=68 | pass |

TH_BENCH_Q4 on 3e5cba5 (serial, interleaved passes, quiet GPU, µs/call → GB/s):

| class | `path` (plain operand) | `path+ps` (production presum operand) |
|---|---|---|
| gate_up | 187.5 → **535 GB/s** | 188.5 → **532 GB/s** |
| down | 113.0 → 444 GB/s | 125.3 → 400 GB/s. Bench says PreSums is slower here; in situ the `split_long` PreSums row wins, see §2 |
| in_all | 103.9 → 457 GB/s | 103.7 → 458 GB/s |
| out | 46.0 → 384 GB/s | **41.6 → 425 GB/s (−10%)** |
| in_qkv | 103.4 → 399 GB/s | **99.1 → 417 GB/s (−4%)** |
| o | 54.6 → 324 GB/s | 51.8 → 342 GB/s (o is not fed a block in production) |
| lm_head | 1349.8 → 530 GB/s | 1347.1 → 531 GB/s |

The emit check (down on the emitted vs attached vs recomputed sums) gave max|Δ| = 0.000000, and P0 pad-vs-direct max|Δ| = 0 for every class.

### 5.3 End to end on the commit builds (session6: base / A / C interleaved × 3 rounds)

**Contamination.** `replayd`, the macOS screen-recording daemon, which does not take the lock, ran bursts of 44–87% GPU from about 02:34. `s6/gpu_watch.log` sampled it every 2 s for round 3: base_3 had a mean of 48%, A_3 44% and C_3 45%. It also hit A_2: `gpuusers` at 02:34:47 showed replayd at 69%, while A_2 had a propose median of 13 ms vs 10 ms elsewhere. Round 1 was clean: the GPU was quiet before and after every arm, and load average was 7–9.

| round | arm | ms/round | tokens/round | loop tok/s | T=0 ms/round | T=0 tok/s | propose / verify (mean ms) | ids |
|---|---|---|---|---|---|---|---|---|
| 1 (clean) | base 970b1f5 | 65.08 | 3.473 | 53.37 | 61.66 | 56.66 | 11.07 / 51.12 | — |
| 1 (clean) | **A 3e5cba5** | **58.37** | 3.473 | **59.50** | **56.52** | **61.82** | 10.14 / **45.48** | **12/12 = base** |
| 1 (clean) | C 6ef4247 | 62.78* | 3.714 | 59.16 | **55.57** | **62.87** | 12.76* / 47.12 | T=0 3/3 = base |
| 2 | base | 63.32 | 3.473 | 54.85 | 64.04 | 54.55 | 10.57 / 50.32 | 12/12 = base_1 |
| 2 | A (replayd) | 83.29 | 3.473 | 41.70 | 72.51 | 48.18 | 19.53 / 58.23 | 12/12 = base |
| 2 | C | 61.84 | 3.714 | 60.05 | 59.39 | 58.83 | 10.78 / 48.47 | T=0 3/3 = base |
| 3 (replayd) | base | 63.98 | 3.473 | 54.29 | 62.59 | 55.82 | 10.50 / 50.94 | 12/12 = base_1 |
| 3 (replayd) | A | 64.59 | 3.473 | 53.77 | 68.69 | 50.86 | 11.79 / 50.21 | 12/12 = base |
| 3 (replayd) | C | 59.76 | 3.714 | 62.14 | 58.34 | 59.88 | 10.34 / 46.93 | T=0 3/3 = base |
| **pooled** | base | **64.13** | 3.473 | **54.16** | **62.76** | **55.67** | 10.71 / 50.79 | |
| **pooled** | C | **61.46** | 3.714 | **60.42** | **57.77** | **60.48** | 11.29 / 47.51 | |

\* C_1's s2 requests hit a transient stall: propose ran 23–43 ms on short/code s2 against 9–11 ms on every other request. The T=0 columns are unaffected.

- **Target change.** Commits A and C share the target computation, so C's verify time measures the target change across all rounds: verify 50.3–51.1 → 46.9–48.5 ms.
- **Draft fusion (C vs A, same round).** T=0 propose 9.89 → 9.42 ms in the clean round. Session4 pooled showed 10.72 → 10.45.
- **Sampled identity.** C's sampled requests diverge from A and base only on the code and long prompts (first divergence at id #24–#79). The short prompts stay identical.
- **Sampled acceptance.** C's sampled tokens/round (3.794 vs 3.466) is a property of those different, fully deterministic trajectories (fixed seeds 1–3). It is not evidence of a better draft: at T=0, tokens/round is unchanged at 3.494.
- **Rest of the gates.** The same session ran V-lin (none worse), V-multi (A −3.1 ms fwd8/fwd5, −2.65 ms fwd1), V-roll (PASS) and identical probe top-8 logits (§5.2).

## 6. Exact commands

All scripts live in `$SP/phaseB/k45/`: `probe_session.sh`, `multi.sh`, `multi2.sh`, `serve_session.sh`, `k45_client.py`, `parse_k45.py`, `multi_summary.py`, `sweep_table.py`, `session{0..6}.sh`. Raw logs are in `s0 … s6`.

```sh
export SP=/private/tmp/claude-501/-Users-benebsworth-projects-token-horizon/23793a29-ce9d-4130-926c-f9e358304530/scratchpad K=$SP/phaseB/k45
export TGT="$HOME/.cache/huggingface/hub/models--mlx-community--Qwen3.8-27B-4bit/snapshots/10c35caafbb80f7dc6a7a432cdd11af10a6d4818"
export DRAFT="$HOME/Library/Application Support/Splash/models/incoai/Qwen3.8-27B-Splash/draft"
IDS=$(cat $SP/phaseB/u1/probe18.txt)          # 760,3841,13477,...,321 (18 ids)
WT=/Users/benebsworth/projects/token-horizon/.worktrees/th/wp2-matmul-roofline
(cd $WT/engine && cargo build --release && cargo test --release)          # V-build: only the pre-existing draft_kernel.rs warning; 10/10 tests
TH_MPP_PROBE=1 $WT/engine/target/release/th-engine probe --model x --tokens 1   # compiles MPP_SRC once, builds every pipeline (no GPU work)
$SP/bin/gpu-lock -- env TH_BENCH_LIN=1 $BIN probe --model "$TGT" --tokens "$IDS"                 # V-lin
$SP/bin/gpu-lock -- env TH_BENCH_Q4=1 [TH_BENCH_Q4_SWEEP=1] [TH_BENCH_Q4_M=5] $BIN probe --model "$TGT" --tokens "$IDS"
$SP/bin/gpu-lock -- env TH_BENCH_MULTI=8,5,1 TH_BENCH_MULTI_ITERS=5 [TH_Q4_PS_FAMILIES=..|TH_Q4_PRESUM=0] $BIN probe --model "$TGT" --tokens "$IDS"   # V-multi
$SP/bin/gpu-lock -- env TH_TEST_ROLLBACK=1 $BIN probe --model "$TGT" --tokens "$IDS"             # V-roll
$SP/bin/gpu-lock -- $K/serve_session.sh LABEL $BIN $K/sN     # serve on :8015 with TH_DEBUG_TIMING=1: warmup + 3 prompts T=0 (128 tok) + 3 seeds x 3 prompts sampled (0.6/0.95/20)
python3 $K/parse_k45.py $K/sN base_1 cand_1 ...              # ratio-of-sums loop tok/s, ms/round, tokens/round, first-divergence per request
python3 $K/multi_summary.py $K/sN                            # fwd8/5/1 median (min) per variant
python3 $K/sweep_table.py $K/s1/candA.probe8.log             # autotune table
```

## 7. Merge notes

- **K7 (th/wp2-m1-decode, 4bb1731, same parent 970b1f5) and this branch both edit these places:**
  - `QLin::linear`'s `rows == 1` branch;
  - `gate_up_act`'s m = 1 decline;
  - the `TH_BENCH_Q4` candidate list.
- **Resolving K7:**
  - Keep K7's AffineQmvT routing at m = 1. A presum block is also a plain [1, in] tensor, so qmvt can read it; ignore the `presum` flag at rows == 1.
  - Optionally stop `add_rms_norm_ps` from emitting sums at T == 1: the work is wasted there but harmless.
  - Keep this branch's `linear_ps` / `gate_up_act_ps` signatures for 2 <= m <= 8.
- **Codex's multi-slot WIP in main (dflash/engine/qwen35/model):**
  - The forward plumbing adds one `bool` per activation in `forward_inner`, `gdn_forward` and `attn_forward` (`x_ps`), which it passes to `lin_apply_ps`.
  - A batched path with rows > 8 simply gets `presum = false` (`add_rms_norm_ps` only emits for T <= 8).
  - `dflash.rs` (K45d) changes `DraftLayer { gate, up }` → `gate_up`. `propose_batch` in main needs the same three-line swap as `propose`.
- **Untracked-Arc class:** every new output is a fresh pool buffer (`new_buffer_builder` → `MetalStorage::new(fresh)`), and inputs are only bound. No `MetalStorage` is ever built from a cloned existing buffer.

## 8. Follow-ups this work points at (not done)

- **Attention output as a presum block.** `attn_decode` writes o's operand. Adding the block would enable the split PreSums tile there too: bench −12% on o (61.4 → 54.0 µs), plus no pad copy at m < 8. About −0.15 ms/verify.
- **Draft producers emitting presum blocks** (dconv / rms_norm in dflash.rs):
  - bench n32s4/n64s4+ps is −14 to −17% on draft qkv (60.6 → 50.3 µs), −14% on o_proj, −13% on dyn and −24% on the selector;
  - lm_head at m = 7 would gain −4 to −6%, but only if paired/N256 PreSums stops losing in situ, which it does today.
- **in_all / down below 480 GB/s.** The remaining gap is the per-dispatch ramp plus the grid shape (65 / 80 threadgroups on 40 cores). It points at F1-style fusion (hiding the ramp) rather than at more tile variants: the sweep exhausted groups × tiles × depth.

## 9. Review fixes (fix pass, 2026-09-26)

Finding addressed (high, must-fix): the branch conflicted textually and semantically with main's multi-slot refactor (de110be..cf3e5f7), and the auto-merged `dflash.rs` did not compile (`propose_batch` still used `DraftLayer.gate` / `.up`).

**Result: rebased onto main `cf3e5f7`, all gates pass. HEAD = `5a93868`, a fast-forward of main.** The branch carries 9 commits. `git range-diff` shows the five th/wp2-q4-decode commits and K45(c) as `=` (identical patches). Only K45(a) and K45(d) changed (`!`), and one bench commit is new.

| pre-rebase | rebased | item | range-diff |
|---|---|---|---|
| 7557c93 | `47ae79a` | K1: verify gate/up on the N256 two-stream tile | = |
| d1385c5 | `aef01c3` | P0: skip the pad dispatch at m=8 | = |
| a870933 | `2eadc10` | K2: per-shape decode tile table + paired N256 lm_head | = |
| 3a74e18 | `7b5d5f2` | TH_BENCH_Q4: interleaved passes + pad-copy arm | = |
| 970b1f5 | `7cdb6b2` | P0: keep the pad copy for long-K inputs | = |
| 3e5cba5 | **`05b861f`** | K45(a): presum blocks, conflicts resolved onto the multi-slot forward | ! |
| a7c8ade | `5e72124` | K45(c): autotune sweep + draft gate/up table entry | = |
| 6ef4247 | **`e6d7382`** | K45(d): draft gate/up fused; `propose_batch` fixed via shared `DraftLayer::mlp` | ! |
| — | **`5a93868`** | new: `TH_BENCH_DRAFT_MLP` (draft MLP at propose / batched-propose shapes) | new |

th/wp2-q4-decode (`970b1f5`) itself was not rebased. This branch contains its five commits, rebased.

### 9.1 Code changes (file:line at 5a93868)

**K45(a), `05b861f`.** Main's signatures are kept: `gdn_forward(l, st, vc, fused, seq, eps)` (`engine/src/qwen35.rs:2457`) and `attn_forward(.., qkv, pos, seq, ..)` (`qwen35.rs:2762`).
- The block from the original branch is ported into main's `gdn_forward`: `AllocBf16` outputs + `gdn_fused_step(.., ps)` + `lin_apply_ps(&gated, &l.out, ps)`, at `qwen35.rs:2490-2535`. In that code, `x.device()` became `fused.device()`, and the `TH_GDN_EAGER` / `TH_GDN_STEP` reads are cached.
- `forward_inner` (`qwen35.rs:3100`) and `forward_batch` (`qwen35.rs:3251`) now both:
  - carry `h_next: Option<(Tensor, bool)>`;
  - compute in_all and in_qkv at the call site as `lin_apply_ps(&h, .., h_ps)` (3131/3143 and 3286/3305);
  - use `add_rms_norm_ps` after attention and for the next layer (3157/3193 and 3327/3363);
  - use `gate_up_act_ps(&h2, h2_ps)` (3162 and 3329), with the eager fallbacks returning `(act, false)`;
  - call `lin_apply_ps(&act, down, act_ps)` (3190 and 3361).
- No call site of `lin_apply(&h, ..)`, `add_rms_norm(` or `gate_up_act(` is left in either loop.

**K45(d), `e6d7382`.** `DraftLayer::mlp` (`engine/src/dflash.rs:217`) holds the MLP body and is shared by `propose` (`dflash.rs:447`) and `propose_batch` (`dflash.rs:773`).
- Body: `gate_up_act_ps`, then `lin_apply_ps(down, inter_ps)`.
- The eager fallback narrows the fused projection on `gu.rank() - 1`. That is dim 2 for both `[1, 8, 2*INTER]` and `[1, B*8, 2*INTER]`, the same dim as the original `narrow(2, ..)`.

**`5a93868`.** `TH_BENCH_DRAFT_MLP=1 th-engine probe` (`qwen35.rs:1123`, hook at `main.rs:305`). It runs on the target's MLP weights, which have the draft's shapes (gate/up 17408×5120, down 5120×17408), over the first 16 layers (distinct tensors), with interleaved passes and a buffer barrier after each call. Arms, each followed by down:
- `sep`: two projections + eager silu·mul, i.e. main's draft path. The fused tiled weight is split back into two exact tiled weights.
- `fused`: `gate_up_act_ps` + down with its presum flag.
- `narrow`: the eager fallback.

**Untracked-Arc class:** this fix pass adds no custom op and builds no `MetalStorage`. The bench's split weights are `narrow` views (the MPP kernels honour storage offsets) plus one `Tensor::cat`.

### 9.2 The review's `propose_batch` premise, measured

`gate_up_act_ps` does **not** decline at B*8 > 8 rows.
- Its first branch (`qwen35.rs:597-636`) takes rows > 8 on tiled Metal weights with (out/2) % 256 == 0 (17408 = 68×256), and runs the two-pass prefill gate/up tile (`AffineQmppPrefill`, `up_tile`).
- The narrow fallback is reached only off-Metal or with `TH_QMM_MPP=0`.

`TH_BENCH_DRAFT_MLP`, 5a93868, 16 layers × 9 passes, µs per layer (median), from `g1/wp2.dmlp.log`:

| rows | sep (main's draft MLP) | fused (branch) | narrow (fallback) | fused max\|Δ\| vs sep |
|---|---|---|---|---|
| 8 (propose) | 339.1 | **302.5 (x0.893)** | 367.0 (x1.084) | 0.0078 |
| 16 (propose_batch, B=2) | 977.7 | **933.6 (x0.956)** | 973.3 (x0.999) | 0.25 at \|y\|max 46.25 (1 bf16 ulp) |
| 24 (B=3) | 973.6 | **928.4 (x0.954)** | 993.4 (x1.016) | 0.25 |
| 32 (B=4) | 980.2 | **934.6 (x0.952)** | 1007.1 (x1.025) | 0.25 |

- Above 8 rows, `narrow` equals `sep` bit for bit, which cross-checks the weight split.
- Numerics: silu·mul is rounded once instead of twice. This is the same class of change K45(d) already makes at 8 rows. Draft proposals at TH_BATCH ≥ 2 can therefore differ from main by ulps. Target outputs at T=0 do not (§9.4).

### 9.3 Presum coverage at TH_BATCH ≥ 2 (as the review stated; now explicit)

- `forward_batch`'s activation is `[1, Σseq, C]`, and `add_rms_norm_ps` emits a block only when Σseq ≤ 8. That happens only when one slot is active (nb=1, 8 rows).
- At nb ≥ 2 (Σseq ≥ 16), in_all, in_qkv, gate_up and down take the plain >8-row path. There is no K45 effect there, and the rows are bit-identical to main (verified, §9.4).
- The per-slot GDN step + out projection runs inside `gdn_forward` at seq_b = 8. At nb ≥ 2 the out projection therefore still gets its presum block and the uninitialised (AllocBf16) outputs.
- A presum variant for >8-row activations is not implemented (follow-up, §9.6).

### 9.4 Gates

All numbers use two binaries built in the worktree from clean checkouts:
- base: main `cf3e5f7`, `$SP/phaseB/wp2fix/th-engine-main-cf3e5f7`, sha256 `545e5462efb6…`;
- candidate: rebased `5a93868`, `$SP/phaseB/wp2fix/th-engine-wp2-5a93868`, sha256 `5fcad74fb8bc…` (`th-engine-wp2-5a93868`; the identical file `th-engine-wp2-c017459` is the same tree `e3aae7c`: c017459 was the same commit before its trailer was amended, and the bytes are identical).

The forward_batch dumps use scratch probe builds: the same two shas plus the uncommitted `TH_TEST_BATCH_DUMP` patch (`$SP/phaseB/wp2fix/batch_dump_probe.py`), which dumps the logits of `forward_batch` for:
- nb=2: slots 0 and 1 × 8 rows;
- then nb=1: slot 0 × 8 rows.

Every GPU run went through `$SP/bin/gpu-lock`, and every serve used :8015.

| gate | result |
|---|---|
| V-build | pass. All 9 rebased commits build with 0 warnings (`wp2fix/per_commit_build.txt`). `cargo test --release` at 5a93868: 10/10. |
| U1 unit tests | n/a on this branch: U1 is th/wp1-utf8-stream. The branch's own suite passes 10/10 (above). |
| V-lin (`TH_BENCH_LIN`) | pass. 28/28 max\|Δ\| entries equal to main; none worse (`wp2fix/vlin_cmp.py g1/main.vlin.log g1/wp2.vlin.log`). |
| V-roll (`TH_TEST_ROLLBACK=1`) | **PASS** on 5a93868: worst rollback\|Δ\| 0.1289 (kept=1), refwd\|Δ\| 0, argmax ref=rb=ctl=68. Main: PASS, 0.1875. |
| probe top-8 (18-token prefill) | identical to main |
| forward_batch dump, 5a93868 vs main | nb=2 rows (16 rows, presum off): **bitwise equal**. nb=1 rows (8 rows, presum on): max\|Δ\| 0.094, argmax 8/8. |
| forward_batch dump, 5a93868 presum on vs `TH_Q4_PRESUM=0` | **bitwise equal, 24/24 rows**. K45(a) is bit-neutral in both loops, including the per-slot GDN out-projection blocks at nb=2. |
| forward_batch dump, 5a93868 `TH_Q4_POLICY=legacy` vs main | **bitwise equal, 24/24 rows**. The nb=1 difference above is entirely K1/K2's decode-tile policy (pre-K45 commits). A repeat run is also bitwise equal (deterministic). |
| V-multi (`TH_BENCH_MULTI=8,5,1`, 4 interleaved rounds × 3 iters, n=12, `wp2fix/g1`) | main: fwd8 47.00 (min 46.5), fwd5 46.45 (45.9), fwd1 46.30 (45.3) ms. 5a93868: fwd8 **40.25** (39.4), fwd5 **39.55** (39.2), fwd1 **41.70** (41.3). Δ −6.75 / −6.90 / −4.60 ms (K1/K2/P0 + K45). |
| K45(a) share (same binary, `TH_Q4_PRESUM=0`, 4 interleaved rounds, `wp2fix/g2`) | default: fwd8 40.20 (39.2), fwd5 39.40 (39.2), fwd1 41.75 (41.4). Presum off: 43.80 (43.0), 43.50 (43.2), 44.95 (44.6). Δ **−3.60 / −4.10 / −3.20 ms**, matching pre-rebase session5 (−3.4 / −4.5 / −3.5). |
| T=0 A/B, TH_BATCH=1 (k45_client; 4 rounds ABAB + BABA) | **T=0 3/3 token-identical to main in all 4 rounds (12/12).** Sampled: short prompts identical; code/long diverge at id #33 / #41 / #50. That is deterministic: main is 12/12 and 5a93868 12/12 identical to themselves across rounds. This is the known K1/K2 + K45(d) numerics effect (§5.1: 44aed06 vs 970b1f5). |
| T=0 A/B, TH_BATCH=2 (pair_client, 2 rounds ABAB) | **T=0 6/6 text-identical to main in both rounds (12/12).** The round composition was identical: 43 nb=2 + 64 nb=1 rounds in every arm. Sampled pairs diverge, deterministically (both builds 12/12 identical to themselves). |

**pair_client:** the first pair request is sent, then the second 30 ms later, so it arrives during the first one's prefill and joins after its first round. There are 3 T=0 pairs (short+code, long+code, long+short) and 3 sampled pairs (code+long, seeds s / s+10, T=0.6, top_p 0.95, top_k 20), 128 tokens each.

**E2E metrics, TH_BATCH=1, ratio of sums over the [dflash] rounds.**
- The clean rounds are 1, 3 and 4.
- Round 2 drifted: main's last four requests ran +5–8 ms/round, and 5a93868 ran +3–10 ms/round throughout. The 2 s GPU snapshots were quiet; the likely cause is thermal/contention after ~12 min of continuous GPU gates.
- Rounds 3–4 ran in BA order with 20 s cool-downs under a 2 s GPU watcher. The watcher saw no foreign consumer above 77 ms per window (WindowServer), across 114 windows.

| arm | subset | ms/round | tokens/round | loop tok/s | propose / verify ms |
|---|---|---|---|---|---|
| main cf3e5f7 | all (rounds 1, 3, 4) | 66.61 | 3.498 | 52.52 | 10.46 / 53.55 |
| **5a93868** | all (rounds 1, 3, 4) | **58.50** | 3.714 | **63.49** (+20.9%) | 9.87 / 46.19 |
| main cf3e5f7 | T=0 (rounds 1, 3, 4) | 64.11 | 3.450 | 53.81 | 10.02 / 53.08 |
| **5a93868** | T=0 (rounds 1, 3, 4) | **56.40** (−12.0%) | 3.494 | **61.95** (+15.1%) | 9.49 / 45.92 |
| main / 5a93868 | all, rounds 1–4 incl. drift | 66.72 / 60.47 | 3.498 / 3.714 | 52.43 / 61.41 | |
| main / 5a93868 | T=0, rounds 1–4 | 63.91 / 58.63 | 3.450 / 3.494 | 53.98 / 59.59 | |

Sampled tokens/round (3.794 vs 3.515) reflects different, deterministic trajectories, not a better draft (see §5.3).

**TH_BATCH=2.** main's `[batch]` line `total` = propose + verify **enqueue**. It excludes the verify GPU time, the readback and accept/commit/rollback, so it is not a round time. I report wall-clock aggregate throughput instead: Σ completion tokens / Σ pair wall, where pair wall = max(A, B + 30 ms).

| arm | all: agg tok/s (round 1, round 2, pooled) | T=0: agg tok/s (round 1, round 2, pooled) | [batch] nb=2 propose / verify-enqueue ms |
|---|---|---|---|
| main cf3e5f7 | 45.02, 46.99 → **45.98** | 48.27, 51.06 → **49.63** | 33.1 / 11.0, 32.2 / 10.6 |
| 5a93868 | 50.75, 51.74 → **51.24** (+11.4%) | 53.74, 55.21 → **54.47** (+9.7%) | 31.8 / 8.9, 31.1 / 8.7 |

### 9.5 Commands (all under `$SP/phaseB/wp2fix/`)

```sh
WT=/Users/benebsworth/projects/token-horizon/.worktrees/th/wp2-matmul-roofline
(cd $WT && git rebase main)       # K45(a) conflicts resolved by hand; K45(d) propose_batch fixed in the amended commit
for c in $(git -C $WT rev-list --reverse main..HEAD); do git -C $WT checkout -q --detach $c; (cd $WT/engine && cargo build --release); done   # per_commit_build.txt
(cd $WT/engine && cargo test --release)                                    # 10/10
python3 batch_dump_probe.py $WT/engine/src/main.rs  # scratch probe build (then git checkout -- main.rs), for cf3e5f7 and 5a93868
$SP/bin/gpu-lock -- ./gates.sh g1     # probe top-8, V-lin, V-roll, forward_batch dumps, V-multi x4 (main vs wp2), TH_BENCH_DRAFT_MLP
$SP/bin/gpu-lock -- ./gates2.sh g2    # dump TH_Q4_PRESUM=0 + repeat; V-multi x4 wp2 default vs TH_Q4_PRESUM=0
$SP/bin/gpu-lock -- ./e2e.sh e1       # dump TH_Q4_POLICY=legacy; TH_BATCH=1 ABAB (k45_client); TH_BATCH=2 ABAB (pair_client) on :8015
$SP/bin/gpu-lock -- ./e2e_b.sh e1     # TH_BATCH=1 rounds 3-4, BA order, 20 s cool-downs, gpu_watch.log
python3 compare_dump.py A.f32 B.f32; python3 vlin_cmp.py; python3 $SP/phaseB/k45/multi_summary.py g1|g2
python3 $SP/phaseB/k45/parse_k45.py e1 main_b1_1 wp2_b1_1 ...; python3 $SP/phaseB/k45/pool_e2e.py e1 main:main_b1_1,main_b1_3,main_b1_4 wp2:wp2_b1_1,wp2_b1_3,wp2_b1_4
python3 parse_pairs.py e1 main_b2_1 wp2_b2_1 main_b2_2 wp2_b2_2; python3 pairs_wall.py e1 main_b2_1 wp2_b2_1 main_b2_2 wp2_b2_2
```

Summaries are in `summary_g12.txt`, `e2e_b1.txt`, `e2e_b1_all.txt`, `e2e_b1_clean.txt`, `e2e_b2.txt`, `e2e_b2_wall.txt`, `cmp_main_vs_legacy.txt` and `gpu_watch_summary.txt`. No serve or probe process is left running, and :8015 is free. :8000 and :8001 (pid 16917, started 25 Sep 20:16, not mine) were untouched.

### 9.6 Observations for the orchestrator (not fixed here)

- **Batching does not pay off yet.** At nb ≥ 2, every target and draft projection runs through the >8-row prefill tiles, which pad to 32-row blocks.
  - The draft MLP costs ~930 µs per layer at 16 rows vs ~300 µs at 8 rows (3.1×). Two single-slot proposes would be cheaper than one batched propose.
  - TH_BATCH=2 aggregate wall throughput on 5a93868 (51.2 tok/s all, 54.5 tok/s T=0) is only ~10% above single-stream wall throughput. At TH_BATCH=1, a 128-token T=0 request runs at ~49.5 tok/s wall on 5a93868 (code 2523 ms, long 2653 ms, `e1/wp2_b1_1`).
  - th/wp10-prefill-tiles (M16/M24/M32 row tiles) targets exactly these shapes.
- **Per-slot out projection.** `forward_batch` runs the GDN out projection per slot inside `gdn_forward`, so the 17.7 MB weight is swept B times per GDN layer. Hoisting it needs a multi-slot presum block, or the plain path over the concatenated rows.
- **Presum above 8 rows** (for the batched activation) would need a presum-consuming prefill-tile variant.
