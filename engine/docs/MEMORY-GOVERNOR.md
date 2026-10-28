# th-engine memory governor (memgov)

> Load-time memory planning + live accounting for th-engine. Implements the
> `MemoryPlan` sketched in [`GENERALISATION-PLAN.md`](GENERALISATION-PLAN.md)
> §5.4 and gives the supervisor/app the numbers it needs to manage model
> memory instead of guessing from RSS.

## What it does

1. **Weights residency without the slurp** — `qwen35::Weights::load` used to
   `std::fs::read` every safetensors file up front: peak heap = the whole
   checkpoint before the first tensor reached the device. It now mmaps each
   file and deserializes zero-copy from its pages, holding one file's
   mapping at a time. Tensors are byte-identical either way (`from_raw_buffer`
   inputs unchanged); `TH_MEM_LOAD=eager` restores the old arm for A/B.
2. **A plan at load** — weights Σ bytes and the Metal pow2-pooled allocation
   (every pooled buffer rounds to a power of two —
   `candle-core/src/metal_backend/device.rs:336-338`), KV bytes per token
   under bf16 (`layers × kv_heads × head_dim × 4`) vs TurboQuant
   (`layers × kv_heads × 172 B`, layout-fixed per `turboquant.rs:1-27`),
   KV allocation at the admitted context ceiling, and an admission verdict
   against the budget-else-device-limit.
3. **Enforcement where it is honest** — an *explicit* budget
   (`--max-mem-gb` / `TH_MAX_MEM_GB`) that the plan exceeds is a hard load
   failure with an actionable message. Exceeding only the device working-set
   limit (`recommendedMaxWorkingSetSize`, else `hw.memsize`) is a loud warn —
   Metal would OOM at runtime and you deserve to know before that.
4. **Live accounting** — `/status` `memory` gains additive keys (G8b: the
   pre-existing `rss_bytes` keys are untouched): `weights_bytes`,
   `weights_alloc_bytes`, `kv_bytes_per_token`, `kv_live_bytes`,
   `prefix_cache_bytes`, `budget_bytes`, `device_limit_bytes`, `pressure`
   (0..1+ of the ceiling, `null` when unknown), `admission`, and the full
   `plan`. `GET /engine/memory` serves the same block plus the live
   `max_mem_gb` tunable. Prometheus: `th_weights_bytes`, `th_kv_bytes_est`,
   `th_memory_pressure`.
5. **App surface** — the supervisor forwards the serve payload's
   `max_memory_gb` to th-engine as `--max-mem-gb` (previously ignored there);
   the ENGINE tab status line shows `weights … · mem N%` when the engine
   publishes it.

## What it is not

An evictor. Live KV is never dropped under a running request, and there is
no background reaper — enforcement is admission at load plus reporting.
Weight-residency *tiering* (hot-page retention, expert streaming for MoE) is
the G7 streaming-loader seam this module plants the flag on: the mmap loader
is the exact place per-tensor residency decisions attach when a MoE
architecture lands.

## Byte math (cited)

| quantity | formula | source |
|---|---|---|
| KV bf16 / token·head | `head_dim × 2 B × 2 (K+V)` | `qwen35.rs` cache shape `[nkv, cap, hd]` BF16 |
| KV TurboQuant / token·head | `104 (K) + 68 (V)` | `turboquant.rs:1-27` layout doc |
| Metal allocation | `Σ next_pow2(per-tensor bytes)` | §5.4, candle pooled device |
| GDN state | per-slot recurrent state (parity) | not yet measured — `gdn_state_bytes: null` |

## Knobs

| knob | meaning |
|---|---|
| `--max-mem-gb <f64>` | explicit admission budget (GiB); plan over it refuses to load |
| `TH_MAX_MEM_GB` | env fallback when the flag is absent |
| `TH_MEM_MARGIN_GB` | activation/scratch margin (default 1 GiB) |
| `TH_MEM_LOAD=eager` | restore the fs::read loader arm (A/B) |

## A/B protocol

Load-time only, so a plain paired run suffices: same model, `TH_MEM_LOAD`
flipped between runs, compare peak `phys_footprint` during load (the
playbook's footprint guard) and load wall time. Decode/prefill numbers are
out of scope — the loader change is host-copy plumbing only. Unit gates:
`cargo test --release memgov` (formulas, pow2 rounding, budget resolution,
admission bands, pressure math).

## Status

- qwen3_5 (Metal BF16 perf path): full plan + mmap loader.
- GGUF / dense safetensors backends: `/status` memory keys publish with
  `weights_bytes: 0` + `admission: "unknown"` until those loaders grow the
  same walk — additive keys, so nothing downstream breaks meanwhile.
