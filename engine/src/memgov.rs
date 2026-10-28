// Memory governor — explicit memory planning and accounting (GENERALISATION
// PLAN §5.4 "MemoryPlan", implemented).
//
// What this module is:
//   - A load-time PLAN: weights bytes (raw + Metal pow2-pooled allocation),
//     KV bytes per token under bf16 vs TurboQuant, projected working set at
//     the context ceiling, and an admission verdict against an explicit
//     operator budget or the device's recommended working set.
//   - A live ACCOUNTING surface: /status `memory` gains additive keys
//     (weights_bytes, kv_bytes, prefix_cache_bytes, budget_bytes,
//     device_limit_bytes, pressure) and /engine/memory exposes the full plan.
//     Existing keys (memory.rss_bytes, rss_bytes) are untouched — G8b:
//     additive only, never redefine.
//
// What this module is NOT:
//   - An evictor. Live KV is never dropped under a running request; the
//     governor's enforcement is admission at load (explicit budget only)
//     plus loud reporting. Residency *tiering* of weights (mmap advice,
//     hot-page retention) starts with the mmap loader in qwen35.rs and is
//     the G7 streaming-loader seam.
//
// Byte math citations: KV per-token·head bf16 = head_dim × 2 B × 2 (K+V)
// (512 B at head_dim 128); TurboQuant carries ~104 B K + ~68 B V per
// token·head regardless of head_dim (turboquant.rs:1-27 layout doc). Metal
// rounds every pooled buffer to a power of two
// (candle-core-0.11/src/metal_backend/device.rs:336-338, cited in
// GENERALISATION-PLAN §5.4), so `alloc_bytes` sums next_pow2 per tensor.

use candle_core::Device;
use serde::Serialize;

/// Fixed activation/scratch margin applied on top of weights + KV when
/// projecting the working set. Conservative default; override with
/// TH_MEM_MARGIN_GB.
pub const DEFAULT_MARGIN_BYTES: u64 = 1024 * 1024 * 1024;

/// TurboQuant compressed-KV bytes per token·head (K ~104 + V ~68) —
/// layout-fixed, independent of head_dim (turboquant.rs:1-27).
pub const TQ_K_BYTES_PER_TOKEN_HEAD: u64 = 104;
pub const TQ_V_BYTES_PER_TOKEN_HEAD: u64 = 68;

/// Geometry a backend reports about itself — everything the plan needs.
/// `kv_heads`/`head_dim` describe the full-attention cache; GDN layers keep
/// fixed recurrent state that lands in `gdn_state_bytes` when measurable.
#[derive(Debug, Clone)]
pub struct Geometry {
    pub full_attention_layers: usize,
    pub gdn_layers: usize,
    pub kv_heads: usize,
    pub head_dim: usize,
    pub kv_quant: bool,
    pub slots: usize,
    pub weights_bytes: u64,
    /// Σ next_pow2(per-tensor bytes) — what Metal actually reserves.
    pub weights_alloc_bytes: u64,
    /// Fixed per-slot GDN recurrent state (None: not measured this load).
    pub gdn_state_bytes: Option<u64>,
}

impl Geometry {
    /// Bytes one KV token occupies across all full-attention layers.
    pub fn kv_bytes_per_token(&self) -> u64 {
        let layers = self.full_attention_layers as u64;
        let heads = self.kv_heads.max(1) as u64;
        if self.kv_quant {
            layers * heads * (TQ_K_BYTES_PER_TOKEN_HEAD + TQ_V_BYTES_PER_TOKEN_HEAD)
        } else {
            // [nkv, tokens, head_dim] BF16, K and V.
            layers * heads * self.head_dim.max(1) as u64 * 4
        }
    }
}

/// The load-time memory plan — serialized into /status `memory.plan` and
/// served in full at /engine/memory.
#[derive(Debug, Clone, Serialize)]
pub struct MemoryPlan {
    pub weights_bytes: u64,
    /// Σ next_pow2(per-tensor bytes): what Metal's pooled allocator reserves.
    pub weights_alloc_bytes: u64,
    pub kv_bytes_per_token: u64,
    /// KV allocation at the admitted context ceiling (pow2-rounded per
    /// layer per K/V tensor — the allocator's actual footprint).
    pub kv_alloc_bytes_at_max_context: Option<u64>,
    pub max_context_tokens: Option<usize>,
    pub kv_quant: bool,
    pub slots: usize,
    pub gdn_layers: usize,
    pub full_attention_layers: usize,
    /// Fixed per-slot GDN recurrent state (None: not measured this load).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gdn_state_bytes: Option<u64>,
    pub device_limit_bytes: Option<u64>,
    pub budget_bytes: Option<u64>,
    /// "flag" (--max-mem-gb) | "env" (TH_MAX_MEM_GB) | "none"
    pub budget_source: &'static str,
    /// weights_alloc + kv_alloc + gdn_state + margin — the projected
    /// resident working set at the context ceiling.
    pub projected_working_set_bytes: Option<u64>,
    pub margin_bytes: u64,
    /// "fits" | "tight" | "exceeds" | "unknown" (no limit known).
    /// Admission against the operator budget when one is set, else the
    /// device working-set limit.
    pub admission: &'static str,
}

/// next_pow2 — Metal's pooled-buffer rounding (§5.4 allocation model).
pub fn pow2(n: u64) -> u64 {
    if n == 0 {
        return 0;
    }
    n.next_power_of_two()
}

/// KV allocation at `tokens` positions: per full-attention layer, K and V
/// are separate `[nkv, ncap, hd]` buffers, each pow2-rounded by the pooled
/// allocator. TurboQuant caches use the same grow math against their
/// smaller per-token footprint.
pub fn kv_alloc_bytes(g: &Geometry, tokens: usize) -> u64 {
    if g.full_attention_layers == 0 || g.kv_heads == 0 || g.head_dim == 0 {
        return 0;
    }
    let per_tensor = |rows: u64| pow2(rows * g.kv_heads as u64 * g.head_dim as u64 * 2);
    let (k, v) = if g.kv_quant {
        (
            pow2(tokens as u64 * g.kv_heads as u64 * TQ_K_BYTES_PER_TOKEN_HEAD),
            pow2(tokens as u64 * g.kv_heads as u64 * TQ_V_BYTES_PER_TOKEN_HEAD),
        )
    } else {
        (per_tensor(tokens as u64), per_tensor(tokens as u64))
    };
    (k + v) * g.full_attention_layers as u64 * g.slots.max(1) as u64
}

/// The device's working-set ceiling: Metal's recommendedMaxWorkingSetSize
/// when a Metal device is in play, else physical RAM (hw.memsize).
pub fn device_limit_bytes(dev: &Device) -> Option<u64> {
    #[cfg(all(feature = "metal", target_os = "macos"))]
    if let Device::Metal(md) = dev {
        let v = md.metal_device().recommended_max_working_set_size();
        if v > 0 {
            return Some(v as u64);
        }
    }
    physical_ram_bytes()
}

#[cfg(target_os = "macos")]
fn physical_ram_bytes() -> Option<u64> {
    let mut mib = [libc::CTL_HW, libc::HW_MEMSIZE];
    let mut val: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    let ok = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            &mut val as *mut u64 as *mut libc::c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (ok == 0 && val > 0).then_some(val)
}

#[cfg(not(target_os = "macos"))]
fn physical_ram_bytes() -> Option<u64> {
    None
}

/// Budget resolution order: explicit flag → TH_MAX_MEM_GB env → none.
/// Returns (bytes, source).
pub fn resolve_budget(flag: Option<f64>, env: Option<&str>) -> (Option<u64>, &'static str) {
    if let Some(gb) = flag.filter(|g| *g > 0.0) {
        return (Some((gb * 1024.0 * 1024.0 * 1024.0) as u64), "flag");
    }
    if let Some(env) = env {
        if let Ok(gb) = env.trim().parse::<f64>() {
            if gb > 0.0 {
                return (Some((gb * 1024.0 * 1024.0 * 1024.0) as u64), "env");
            }
        }
    }
    (None, "none")
}

fn margin_bytes() -> u64 {
    std::env::var("TH_MEM_MARGIN_GB")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|g| *g >= 0.0)
        .map(|g| (g * 1024.0 * 1024.0 * 1024.0) as u64)
        .unwrap_or(DEFAULT_MARGIN_BYTES)
}

/// Build the plan and score admission against budget-else-device-limit.
pub fn build_plan(
    g: &Geometry,
    max_context: Option<usize>,
    device_limit: Option<u64>,
    budget: Option<u64>,
    budget_source: &'static str,
) -> MemoryPlan {
    let kv_per_token = g.kv_bytes_per_token();
    let kv_alloc = max_context.map(|t| kv_alloc_bytes(g, t));
    let margin = margin_bytes();
    let projected = kv_alloc.map(|kv| {
        g.weights_alloc_bytes + kv + g.gdn_state_bytes.unwrap_or(0) + margin
    });
    let against = budget.or(device_limit);
    let admission = match (projected, against) {
        (None, _) => "unknown",
        (Some(_), None) => "unknown",
        (Some(p), Some(limit)) => {
            if p > limit {
                "exceeds"
            } else if p * 100 > limit * 85 {
                "tight"
            } else {
                "fits"
            }
        }
    };
    MemoryPlan {
        weights_bytes: g.weights_bytes,
        weights_alloc_bytes: g.weights_alloc_bytes,
        kv_bytes_per_token: kv_per_token,
        kv_alloc_bytes_at_max_context: kv_alloc,
        max_context_tokens: max_context,
        kv_quant: g.kv_quant,
        slots: g.slots,
        gdn_layers: g.gdn_layers,
        full_attention_layers: g.full_attention_layers,
        gdn_state_bytes: g.gdn_state_bytes,
        device_limit_bytes: device_limit,
        budget_bytes: budget,
        budget_source,
        projected_working_set_bytes: projected,
        margin_bytes: margin,
        admission,
    }
}

/// Live pressure: (weights_alloc + live KV + prefix cache) / ceiling.
/// None when no ceiling is known — /status reports null, not a fake number.
pub fn pressure(
    weights_alloc: u64,
    kv_live_bytes: u64,
    prefix_bytes: u64,
    ceiling: Option<u64>,
) -> Option<f64> {
    let ceiling = ceiling?;
    if ceiling == 0 {
        return None;
    }
    Some(((weights_alloc + kv_live_bytes + prefix_bytes) as f64 / ceiling as f64).min(f64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geo() -> Geometry {
        // Qwen3.8-class hybrid: 49 layers, every 3rd full-attention,
        // n_kv 4, head_dim 128, 16 full / 33 GDN (matches the layout doc
        // at qwen35.rs:18).
        Geometry {
            full_attention_layers: 16,
            gdn_layers: 33,
            kv_heads: 4,
            head_dim: 128,
            kv_quant: false,
            slots: 1,
            weights_bytes: 14_000_000_000,
            weights_alloc_bytes: 16_000_000_000,
            gdn_state_bytes: None,
        }
    }

    #[test]
    fn kv_bytes_bf16_formula() {
        // 16 layers × 4 heads × 128 dim × 2 B × 2 (K+V) = 16384 B/token.
        assert_eq!(geo().kv_bytes_per_token(), 16 * 4 * 128 * 4);
    }

    #[test]
    fn kv_bytes_quant_uses_layout_constants() {
        let mut g = geo();
        g.kv_quant = true;
        // 16 × 4 × (104 + 68) = 11008 B/token — ~1.5× less than bf16 here
        // (small head_dim); the win grows with head_dim (512 B bf16 at 128
        // is 172 B quant per token·head).
        assert_eq!(g.kv_bytes_per_token(), 16 * 4 * 172);
        assert!(g.kv_bytes_per_token() < geo().kv_bytes_per_token());
    }

    #[test]
    fn kv_alloc_pow2_rounds_per_tensor() {
        let g = geo();
        // 4096 tokens: one layer's K tensor rows = 4096 × 4 × 128 × 2 B
        // = 4 MiB exactly (already pow2) → K + V = 8 MiB × 16 layers.
        let exact = 4096u64 * 4 * 128 * 2;
        assert_eq!(exact, 4 * 1024 * 1024);
        assert_eq!(kv_alloc_bytes(&g, 4096), (exact * 2) * 16);
        // Non-pow2 rows round up: 1000 tokens → rows 1_000_000 B → pow2
        // 1_048_576.
        assert_eq!(kv_alloc_bytes(&g, 1000) / 16 / 2, pow2(1_000_000));
        // Slots multiply (every slot owns its cache).
        let mut g2 = geo();
        g2.slots = 3;
        assert_eq!(kv_alloc_bytes(&g2, 4096), kv_alloc_bytes(&g, 4096) * 3);
    }

    #[test]
    fn admission_verdicts() {
        let g = geo();
        // Budget 20 GiB, projected ~16 + kv + 1 margin → fits.
        let p = build_plan(&g, Some(4096), None, Some(20 * 1024 * 1024 * 1024), "flag");
        assert_eq!(p.admission, "fits");
        // Tight: budget above the projection but inside the 85 % band —
        // admission reads tight while projected·100 > limit·85, i.e. any
        // limit in (projected, projected/0.85].
        let projected = p.projected_working_set_bytes.unwrap();
        let tight_budget = projected * 115 / 100;
        let p = build_plan(&g, Some(4096), None, Some(tight_budget), "flag");
        assert_eq!(p.admission, "tight");
        // Exceeds.
        let p = build_plan(&g, Some(4096), None, Some(projected / 2), "flag");
        assert_eq!(p.admission, "exceeds");
        // No limit at all → unknown, never a fake verdict.
        let p = build_plan(&g, Some(4096), None, None, "none");
        assert_eq!(p.admission, "unknown");
        assert!(p.projected_working_set_bytes.is_some());
        // Context ceiling flows through (§5.4: memory_plan.max_context_tokens
        // beside the unchanged maximum_context_tokens).
        assert_eq!(p.max_context_tokens, Some(4096));
    }

    #[test]
    fn budget_resolution_order() {
        assert_eq!(resolve_budget(Some(24.0), Some("12")), (Some(24 * 1024 * 1024 * 1024), "flag"));
        assert_eq!(resolve_budget(None, Some("12"), ), (Some(12 * 1024 * 1024 * 1024), "env"));
        assert_eq!(resolve_budget(None, None), (None, "none"));
        assert_eq!(resolve_budget(Some(0.0), None), (None, "none"), "0 disables");
        assert_eq!(resolve_budget(None, Some("junk")), (None, "none"));
    }

    #[test]
    fn pressure_math() {
        assert_eq!(pressure(100, 50, 50, None), None);
        assert_eq!(pressure(100, 50, 50, Some(400)), Some(0.5));
        assert_eq!(pressure(100, 50, 50, Some(0)), None, "zero ceiling → null");
        assert_eq!(pressure(500, 0, 0, Some(100)), Some(5.0), "over-subscribe is reported, not clamped to 1");
    }

    #[test]
    fn pow2_basics() {
        assert_eq!(pow2(0), 0);
        assert_eq!(pow2(1), 1);
        assert_eq!(pow2(1_000_000), 1_048_576);
        assert_eq!(pow2(1 << 20), 1 << 20);
    }
}
