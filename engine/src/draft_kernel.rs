//! Fused Metal kernels for the DFlash draft model — mirrors the
//! target-model kernel strategy (one dispatch where the eager chain
//! runs a dozen). All ops are bf16-in/bf16-out with f32 accumulation.

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::{bench_draft_attn, draft_attn, draft_attn_split, draft_conv_fused, draft_norm_rope};

/// Largest split count of `draft_attn_split` (8 x 128 threads = 1024,
/// the threadgroup limit).
pub const DRAFT_ATTN_MAX_SPLIT: usize = 8;
/// Keys per split the default N4 policy aims for.
pub const DRAFT_ATTN_KEYS_PER_SPLIT: usize = 256;

/// N4 split count for a draft attention call over `ring_len` committed
/// keys (+ the 8 block rows): `ceil((ring_len + 8) / keys_per_split)`
/// clamped to 1..=8. One split is the same per-pair loop and epilogue as
/// the 8-threadgroup `draft_attn` spread over 64 threadgroups — the same
/// output — so short rings keep the reference numerics while still
/// filling the GPU. Pure — see `draft_attn_nsplit` for the env form.
pub fn draft_nsplit_for(ring_len: usize, keys_per_split: usize) -> usize {
    (ring_len + 8)
        .div_ceil(keys_per_split.max(1))
        .clamp(1, DRAFT_ATTN_MAX_SPLIT)
}

/// The draft attention route for a call over `ring_len` keys, knobs read
/// once: `None` = the legacy 8-threadgroup `draft_attn`
/// (`TH_DRAFT_ATTN_SPLIT=0`, the A/B arm); `Some(n)` = `draft_attn_split`
/// with n splits — `TH_DRAFT_ATTN_SPLIT=N` pins n, otherwise
/// `draft_nsplit_for` with `TH_DRAFT_ATTN_KEYS` keys per split.
pub fn draft_attn_nsplit(ring_len: usize) -> Option<usize> {
    static CFG: std::sync::OnceLock<(Option<usize>, usize)> = std::sync::OnceLock::new();
    let (fixed, kps) = *CFG.get_or_init(|| {
        let num = |k: &str| std::env::var(k).ok().and_then(|v| v.trim().parse::<usize>().ok());
        (
            num("TH_DRAFT_ATTN_SPLIT").map(|n| n.min(DRAFT_ATTN_MAX_SPLIT)),
            num("TH_DRAFT_ATTN_KEYS").unwrap_or(DRAFT_ATTN_KEYS_PER_SPLIT).max(1),
        )
    });
    match fixed {
        Some(0) => None,
        Some(n) => Some(n),
        None => Some(draft_nsplit_for(ring_len, kps)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GPU: `draft_attn_split` at one split is `draft_attn` bit for bit;
    /// at 2..8 splits it is deterministic and within bf16 tolerance of it
    /// (wrapped ring windows included).
    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn draft_attn_split_matches_single_pass() -> candle_core::Result<()> {
        use candle_core::{DType, Device, Tensor};
        let Ok(dev) = Device::new_metal(0) else { return Ok(()) };
        let r = |sh: (usize, usize, usize)| -> candle_core::Result<Tensor> {
            Tensor::randn(0f32, 1.0, sh, &dev)?.to_dtype(DType::BF16)
        };
        let (q, rk, rv, bk, bv) =
            (r((8, 32, 128))?, r((8, 2048, 128))?, r((8, 2048, 128))?, r((8, 8, 128))?, r((8, 8, 128))?);
        let host = |t: &Tensor| -> candle_core::Result<Vec<f32>> {
            t.to_dtype(DType::F32)?.flatten_all()?.to_vec1()
        };
        for (ring, start) in [(0usize, 0usize), (37, 5), (300, 1900), (1450, 1000), (2048, 777)] {
            let base = host(&draft_attn(&q, &rk, &rv, &bk, &bv, ring, start)?)?;
            for ns in 1..=DRAFT_ATTN_MAX_SPLIT {
                let a = host(&draft_attn_split(&q, &rk, &rv, &bk, &bv, ring, start, ns)?)?;
                let b = host(&draft_attn_split(&q, &rk, &rv, &bk, &bv, ring, start, ns)?)?;
                assert!(a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()), "nondeterministic ring={ring} ns={ns}");
                if ns == 1 {
                    assert!(a.iter().zip(&base).all(|(x, y)| x == y), "split1 != draft_attn ring={ring}");
                } else {
                    let d = a.iter().zip(&base).map(|(x, y)| (x - y).abs()).fold(0f32, f32::max);
                    assert!(d < 2e-2, "ring={ring} ns={ns} max|d|={d}");
                }
            }
        }
        Ok(())
    }

    #[test]
    fn draft_nsplit_policy() {
        // (ring_len, keys per split) -> splits; ring + 8 block rows
        for (ring, kps, want) in [
            (0usize, 256usize, 1usize),
            (248, 256, 1), // 256 keys: still one split (reference numerics)
            (249, 256, 2),
            (1000, 256, 4),
            (1450, 256, 6),
            (2048, 256, 8),
            (2048, 128, 8), // capped at 8
            (100, 64, 2),
        ] {
            assert_eq!(draft_nsplit_for(ring, kps), want, "ring={ring} kps={kps}");
        }
    }
}

#[cfg(all(feature = "metal", target_os = "macos"))]
mod metal_impl {
    #[allow(unused_imports)]
    use candle_core::backend::BackendStorage;
    use candle_core::{DType, Layout, Result, Storage, Tensor};
    use candle_metal_kernels::metal::ComputePipeline;
    use candle_metal_kernels::utils::EncoderProvider;
    use objc2_metal::MTLSize;
    use std::sync::OnceLock;

    // ROWS=8, HIDDEN=5120, HEADS=32, KV_HEADS=8, HEAD_DIM=128,
    // WINDOW=2048 — draft dims are fixed by the checkpoint.
    const SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct ConvParams { int stage; int has_res; };

// out[r,c] = x[r,c]*(dyn[r, s*640 + c/16] + base[s*2,   c])
//          + x[r-1,c]*(dyn[r, s*640+320 + c/16] + base[s*2+1, c])
//          (+ res[r,c]); row -1 is zero.
kernel void draft_conv_fused(
    device const bfloat* x     [[buffer(0)]],
    device const bfloat* dyn   [[buffer(1)]],
    device const bfloat* base  [[buffer(2)]],
    device const bfloat* res   [[buffer(3)]],
    device bfloat*       out   [[buffer(4)]],
    constant ConvParams& p     [[buffer(5)]],
    uint i [[thread_position_in_grid]])
{
    const int c = int(i) % 5120;
    const int r = int(i) / 5120; // flat row across slots — blocks of 8
    const int g = c / 16;
    const int off = p.stage * 640;
    const float t0 = float(dyn[r * 1280 + off + g])
                   + float(base[p.stage * 2 * 5120 + c]);
    const float t1 = float(dyn[r * 1280 + off + 320 + g])
                   + float(base[(p.stage * 2 + 1) * 5120 + c]);
    // blocks of 8 rows per draft slot — never read across the boundary
    const float prev = (r & 7) > 0 ? float(x[i - 5120]) : 0.0f;
    float v = float(x[i]) * t0 + prev * t1;
    if (p.has_res) v += float(res[i]);
    out[i] = bfloat(v);
}

// Per-head rmsnorm(x)·w then NeoX rope (pairs i, i+64) with per-row
// cos/sin. [rows, heads, 128] — one threadgroup of 128 threads per
// (row, head).
kernel void draft_norm_rope(
    device const bfloat* x    [[buffer(0)]],
    device const bfloat* w    [[buffer(1)]],
    device const float*  rc   [[buffer(2)]],
    device const float*  rs   [[buffer(3)]],
    device bfloat*       out  [[buffer(4)]],
    constant int2&       hp   [[buffer(5)]], // [nheads, row_stride]
    uint2 tgp  [[threadgroup_position_in_grid]],
    uint  tid  [[thread_index_in_threadgroup]],
    uint  lane [[thread_index_in_simdgroup]],
    uint  sg   [[simdgroup_index_in_threadgroup]])
{
    const uint row = tgp.x, head = tgp.y;
    device const bfloat* src = x + row * hp.y + head * 128;
    device bfloat* dst = out + (row * hp.x + head) * 128;
    threadgroup float ssq[4];
    float v = float(src[tid]);
    float psum = v * v;
    psum = simd_sum(psum);
    if (lane == 0) ssq[sg] = psum;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    const float inv = rsqrt((ssq[0] + ssq[1] + ssq[2] + ssq[3]) / 128.0f
                            + 1e-6f);
    v *= inv * float(w[tid]);
    // NeoX pairs (i, i+64): thread i<64 rotates, thread i>=64 is the
    // second half — resolve once.
    if (tid < 64) {
        const float c = rc[row * 64 + tid];
        const float s = rs[row * 64 + tid];
        const float v2 = float(src[tid + 64]) * inv * float(w[tid + 64]);
        dst[tid] = bfloat(v * c - v2 * s);
        dst[tid + 64] = bfloat(v * s + v2 * c);
    }
}

struct AttnParams { int ring_len; int start_slot; int q_stride; int kv_stride; };

// Draft attention: 32 q heads x 8 rows over ring[ring_len] + block[8],
// bidirectional (no causal mask — DFlash blocks attend fully). One
// threadgroup per kv head, 8 simdgroups; sg s covers the (qhead,row)
// pairs s, s+8, s+16, s+24 → 4 sequential pairs.
kernel void draft_attn(
    device const bfloat* q     [[buffer(0)]], // [8, 32, 128]
    device const bfloat* ringk [[buffer(1)]], // [8, 2048, 128]
    device const bfloat* ringv [[buffer(2)]],
    device const bfloat* blk_k [[buffer(3)]], // [8, 8, 128]
    device const bfloat* blk_v [[buffer(4)]],
    device bfloat*       out   [[buffer(5)]], // [8, 32, 128]
    constant AttnParams& p     [[buffer(6)]],
    uint kvh  [[threadgroup_position_in_grid]],
    uint lane [[thread_index_in_simdgroup]],
    uint sg   [[simdgroup_index_in_threadgroup]])
{
    const int total = p.ring_len + 8;
    const float scale = rsqrt(128.0f);
    for (uint pair = sg; pair < 32; pair += 8) {
        const uint qh = pair >> 3;         // 0..3 (GQA head within group)
        const uint row = pair & 7u;         // 0..7
        const uint qhead = kvh * 4 + qh;
        float qv[4];
        for (int i = 0; i < 4; ++i)
            qv[i] = float(q[row * p.q_stride + qhead * 128 + lane * 4 + i]);
        float m = -INFINITY, l = 0.0f, acc[4] = {0, 0, 0, 0};
        for (int t = 0; t < total; ++t) {
            device const bfloat* kr;
            device const bfloat* vr;
            if (t < p.ring_len) {
                const uint slot = uint(p.start_slot + t) % 2048u;
                kr = ringk + kvh * 2048 * 128 + slot * 128;
                vr = ringv + kvh * 2048 * 128 + slot * 128;
            } else {
                const uint br = uint(t - p.ring_len);
                kr = blk_k + br * p.kv_stride + kvh * 128;
                vr = blk_v + br * p.kv_stride + kvh * 128;
            }
            float part = 0.0f;
            for (int i = 0; i < 4; ++i)
                part += qv[i] * float(kr[lane * 4 + i]);
            const float s = simd_sum(part) * scale;
            const float mn = max(m, s);
            const float f = exp(m - mn);
            const float pw = exp(s - mn);
            l = l * f + pw;
            m = mn;
            for (int i = 0; i < 4; ++i)
                acc[i] = acc[i] * f + pw * float(vr[lane * 4 + i]);
        }
        const float inv_l = 1.0f / l;
        for (int i = 0; i < 4; ++i)
            out[row * 32 * 128 + qhead * 128 + lane * 4 + i] =
                bfloat(acc[i] * inv_l);
    }
}
"#;

    static PIPE: OnceLock<(ComputePipeline, ComputePipeline, ComputePipeline)> =
        OnceLock::new();

    fn pipes(
        device: &candle_core::MetalDevice,
    ) -> Result<&'static (ComputePipeline, ComputePipeline, ComputePipeline)>
    {
        if PIPE.get().is_none() {
            let raw = device.metal_device();
            let lib = raw
                .new_library_with_source(SRC, None)
                .map_err(candle_core::Error::wrap)?;
            let mk = |n: &str| -> Result<ComputePipeline> {
                let f = lib
                    .get_function(n, None)
                    .map_err(candle_core::Error::wrap)?;
                raw.new_compute_pipeline_state_with_function(&f)
                    .map_err(candle_core::Error::wrap)
            };
            let _ = PIPE.set((
                mk("draft_conv_fused")?,
                mk("draft_norm_rope")?,
                mk("draft_attn")?,
            ));
        }
        Ok(PIPE.get().unwrap())
    }

    fn msl_buf(t: &Tensor, sz: usize) -> Result<(candle_metal_kernels::metal::Buffer, usize, Layout)> {
        let (s, l) = t.storage_and_layout();
        let s = match &*s {
            Storage::Metal(m) => m.clone(),
            _ => candle_core::bail!("draft_kernel: Metal only"),
        };
        Ok((s.buffer().clone(), l.start_offset() * sz, l.clone()))
    }

    /// out[r,c] = x·(dyn₀+base₀) + shift(x)·(dyn₁+base₁) [+res]
    pub fn draft_conv_fused(
        x: &Tensor,     // [1, 8, 5120] bf16
        dyn_: &Tensor,  // [1, 8, 1280] bf16
        base: &Tensor,  // [4, 5120] bf16
        res: Option<&Tensor>,
        stage: usize,
    ) -> Result<Tensor> {
        let device = match x.device() {
            candle_core::Device::Metal(d) => d.clone(),
            _ => candle_core::bail!("draft_conv_fused: Metal only"),
        };
        let (p_conv, _, _) = pipes(&device)?;
        let rows = x.dim(1)?;
        // MEM-2: one thread per element (dispatch_threads over exactly
        // rows * 5120) — every out[i] is written, no zero fill needed
        let out = crate::outbuf::kernel_out((1, rows, 5120), DType::BF16, x.device())?;
        let b2 = DType::BF16.size_in_bytes();
        let (xb, xo, _) = msl_buf(x, b2)?;
        let (db, dbo, _) = msl_buf(dyn_, b2)?;
        let (bb, bo, _) = msl_buf(base, b2)?;
        let (ob, oo, _) = msl_buf(&out, b2)?;
        let res_buf = match res {
            Some(r) => {
                let (b, o, _) = msl_buf(r, b2)?;
                (b, o)
            }
            None => (xb.clone(), 0),
        };
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("draft_conv_fused");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(p_conv);
        enc.set_input_buffer(0, Some(&xb), xo as _);
        enc.set_input_buffer(1, Some(&db), dbo as _);
        enc.set_input_buffer(2, Some(&bb), bo as _);
        enc.set_input_buffer(3, Some(&res_buf.0), res_buf.1 as _);
        enc.set_output_buffer(4, Some(&ob), oo as _);
        #[repr(C)]
        struct P {
            stage: i32,
            has_res: i32,
        }
        enc.set_bytes(
            5,
            &P {
                stage: stage as i32,
                has_res: res.is_some() as i32,
            },
        );
        enc.dispatch_threads(
            MTLSize { width: rows * 5120, height: 1, depth: 1 },
            MTLSize { width: 256, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(out)
    }

    /// rmsnorm(x)·w + NeoX rope — [8, heads, 128] in place on `out`.
    pub fn draft_norm_rope(
        x: &Tensor,   // [8, heads, 128] bf16
        w: &Tensor,   // [128] bf16
        cos: &Tensor, // [8, 64] f32
        sin: &Tensor,
    ) -> Result<Tensor> {
        let device = match x.device() {
            candle_core::Device::Metal(d) => d.clone(),
            _ => candle_core::bail!("draft_norm_rope: Metal only"),
        };
        let (rows, heads) = (x.dim(0)?, x.dim(1)?);
        if x.dim(2)? != 128 || cos.dim(0)? != rows {
            candle_core::bail!("draft_norm_rope: {:?}", x.shape());
        }
        let (_, p_nr, _) = pipes(&device)?;
        // MEM-2: a 128-thread group per (row, head); thread i < 64 writes
        // channels i and i + 64 — the whole [rows, heads, 128] output
        let out = crate::outbuf::kernel_out((rows, heads, 128), DType::BF16, x.device())?;
        let b2 = DType::BF16.size_in_bytes();
        let (xb, xo, l_x) = msl_buf(x, b2)?;
        let (wb, wo, _) = msl_buf(w, b2)?;
        let (cb, co, _) = msl_buf(cos, DType::F32.size_in_bytes())?;
        let (sb2, so, _) = msl_buf(sin, DType::F32.size_in_bytes())?;
        let (ob, oo, _) = msl_buf(&out, b2)?;
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("draft_norm_rope");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(p_nr);
        enc.set_input_buffer(0, Some(&xb), xo as _);
        enc.set_input_buffer(1, Some(&wb), wo as _);
        enc.set_input_buffer(2, Some(&cb), co as _);
        enc.set_input_buffer(3, Some(&sb2), so as _);
        enc.set_output_buffer(4, Some(&ob), oo as _);
        let rs = l_x.stride()[0] as i32;
        enc.set_bytes(5, &[heads as i32, rs]);
        enc.dispatch_thread_groups(
            MTLSize { width: rows, height: heads, depth: 1 },
            MTLSize { width: 128, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(out)
    }

    /// Bidirectional draft attention: 32 q heads x 8 rows over the
    /// committed ring (slots start_slot.. mod 2048) plus the 8 block
    /// rows' k/v. Returns [8, 32, 128].
    pub fn draft_attn(
        q: &Tensor,     // [8, 32, 128]
        ring_k: &Tensor, // [8, 2048, 128]
        ring_v: &Tensor,
        blk_k: &Tensor, // [8, 8, 128]
        blk_v: &Tensor,
        ring_len: usize,
        start_slot: usize,
    ) -> Result<Tensor> {
        let device = match q.device() {
            candle_core::Device::Metal(d) => d.clone(),
            _ => candle_core::bail!("draft_attn: Metal only"),
        };
        let (_, _, p_at) = pipes(&device)?;
        // MEM-2: 8 kv-head groups x 8 simdgroups cover all 32 (q head,
        // row) pairs per group, 4 channels per lane — every element
        let out = crate::outbuf::kernel_out((8, 32, 128), DType::BF16, q.device())?;
        let b2 = DType::BF16.size_in_bytes();
        let (qb, qo, l_q) = msl_buf(q, b2)?;
        let (kb, ko, _) = msl_buf(ring_k, b2)?;
        let (vb, vo, _) = msl_buf(ring_v, b2)?;
        let (bkb, bko, l_bk) = msl_buf(blk_k, b2)?;
        let (bvb, bvo, _) = msl_buf(blk_v, b2)?;
        let (ob, oo, _) = msl_buf(&out, b2)?;
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("draft_attn");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(p_at);
        enc.set_input_buffer(0, Some(&qb), qo as _);
        enc.set_input_buffer(1, Some(&kb), ko as _);
        enc.set_input_buffer(2, Some(&vb), vo as _);
        enc.set_input_buffer(3, Some(&bkb), bko as _);
        enc.set_input_buffer(4, Some(&bvb), bvo as _);
        enc.set_output_buffer(5, Some(&ob), oo as _);
        #[repr(C)]
        struct P {
            ring_len: i32,
            start_slot: i32,
            q_stride: i32,
            kv_stride: i32,
        }
        enc.set_bytes(
            6,
            &P {
                ring_len: ring_len as i32,
                start_slot: start_slot as i32,
                q_stride: l_q.stride()[0] as i32,
                kv_stride: l_bk.stride()[0] as i32,
            },
        );
        enc.dispatch_thread_groups(
            MTLSize { width: 8, height: 1, depth: 1 },
            MTLSize { width: 256, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(out)
    }

    // ---- N4: split-key draft attention --------------------------------
    //
    // `draft_attn` runs 8 threadgroups (one per kv head) whose simdgroups
    // walk all ring_len + 8 keys for 4 (q head, row) pairs each — 8 of the
    // GPU's 40 cores, 1.7 ms per call at a full 2048 ring (PHASEB N4).
    // The split form runs one threadgroup per (kv head, row) — 64 — with
    // 4 x nsplit simdgroups: sg -> (q head = sg & 3, split = sg >> 2),
    // each an online softmax over a 1/nsplit slice of the keys; the
    // partials merge in threadgroup memory in split order (fixed, so the
    // result is deterministic). nsplit = 1 is the same per-pair loop and
    // epilogue as `draft_attn` — bit-identical output.
    const SRC_SPLIT: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct AttnSplitParams { int ring_len; int start_slot; int q_stride; int kv_stride; int nsplit; };

kernel void draft_attn_split(
    device const bfloat* q     [[buffer(0)]], // [8, 32, 128]
    device const bfloat* ringk [[buffer(1)]], // [8, 2048, 128]
    device const bfloat* ringv [[buffer(2)]],
    device const bfloat* blk_k [[buffer(3)]], // [8, 8, 128]
    device const bfloat* blk_v [[buffer(4)]],
    device bfloat*       out   [[buffer(5)]], // [8, 32, 128]
    constant AttnSplitParams& p [[buffer(6)]],
    uint2 tgp  [[threadgroup_position_in_grid]],
    uint lane [[thread_index_in_simdgroup]],
    uint sg   [[simdgroup_index_in_threadgroup]])
{
    threadgroup float tm[32];
    threadgroup float tl[32];
    threadgroup float tacc[32 * 128];
    const uint kvh = tgp.x, row = tgp.y;
    const uint qh = sg & 3u;
    const int split = int(sg >> 2);
    const int total = p.ring_len + 8;
    const int chunk = (total + p.nsplit - 1) / p.nsplit;
    const int t0 = split * chunk;
    const int t1 = min(t0 + chunk, total);
    const float scale = rsqrt(128.0f);
    const uint qhead = kvh * 4 + qh;
    float qv[4];
    for (int i = 0; i < 4; ++i)
        qv[i] = float(q[row * p.q_stride + qhead * 128 + lane * 4 + i]);
    float m = -INFINITY, l = 0.0f, acc[4] = {0, 0, 0, 0};
    for (int t = t0; t < t1; ++t) {
        device const bfloat* kr;
        device const bfloat* vr;
        if (t < p.ring_len) {
            const uint slot = uint(p.start_slot + t) % 2048u;
            kr = ringk + kvh * 2048 * 128 + slot * 128;
            vr = ringv + kvh * 2048 * 128 + slot * 128;
        } else {
            const uint br = uint(t - p.ring_len);
            kr = blk_k + br * p.kv_stride + kvh * 128;
            vr = blk_v + br * p.kv_stride + kvh * 128;
        }
        float part = 0.0f;
        for (int i = 0; i < 4; ++i)
            part += qv[i] * float(kr[lane * 4 + i]);
        const float s = simd_sum(part) * scale;
        const float mn = max(m, s);
        const float f = exp(m - mn);
        const float pw = exp(s - mn);
        l = l * f + pw;
        m = mn;
        for (int i = 0; i < 4; ++i)
            acc[i] = acc[i] * f + pw * float(vr[lane * 4 + i]);
    }
    if (lane == 0) { tm[sg] = m; tl[sg] = l; }
    for (int i = 0; i < 4; ++i)
        tacc[sg * 128 + lane * 4 + i] = acc[i];
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (split == 0) {
        float M = -INFINITY;
        for (int s = 0; s < p.nsplit; ++s)
            if (tl[s * 4 + qh] > 0.0f) M = max(M, tm[s * 4 + qh]);
        float L = 0.0f, a[4] = {0, 0, 0, 0};
        for (int s = 0; s < p.nsplit; ++s) {
            const uint idx = uint(s) * 4 + qh;
            const float w = tl[idx] > 0.0f ? exp(tm[idx] - M) : 0.0f;
            L += tl[idx] * w;
            for (int i = 0; i < 4; ++i)
                a[i] += tacc[idx * 128 + lane * 4 + i] * w;
        }
        const float inv = 1.0f / L;
        for (int i = 0; i < 4; ++i)
            out[row * 32 * 128 + qhead * 128 + lane * 4 + i] = bfloat(a[i] * inv);
    }
}
"#;

    static PIPE_SPLIT: OnceLock<ComputePipeline> = OnceLock::new();

    fn pipe_split(device: &candle_core::MetalDevice) -> Result<&'static ComputePipeline> {
        if PIPE_SPLIT.get().is_none() {
            let raw = device.metal_device();
            let lib = raw
                .new_library_with_source(SRC_SPLIT, None)
                .map_err(candle_core::Error::wrap)?;
            let f = lib
                .get_function("draft_attn_split", None)
                .map_err(candle_core::Error::wrap)?;
            let p = raw
                .new_compute_pipeline_state_with_function(&f)
                .map_err(candle_core::Error::wrap)?;
            let _ = PIPE_SPLIT.set(p);
        }
        Ok(PIPE_SPLIT.get().unwrap())
    }

    /// Same contract as `draft_attn` — [8, 32, 128] out of 32 q heads x 8
    /// rows over the ring (slots start_slot.. mod 2048) plus the block's
    /// 8 k/v rows — on 64 threadgroups of 128 x nsplit threads.
    #[allow(clippy::too_many_arguments)]
    pub fn draft_attn_split(
        q: &Tensor,
        ring_k: &Tensor,
        ring_v: &Tensor,
        blk_k: &Tensor,
        blk_v: &Tensor,
        ring_len: usize,
        start_slot: usize,
        nsplit: usize,
    ) -> Result<Tensor> {
        let device = match q.device() {
            candle_core::Device::Metal(d) => d.clone(),
            _ => candle_core::bail!("draft_attn_split: Metal only"),
        };
        let nsplit = nsplit.clamp(1, super::DRAFT_ATTN_MAX_SPLIT);
        let p_at = pipe_split(&device)?;
        // MEM-2: split 0's 4 simdgroups write all 4 x 32 x 4 = 512 outputs
        // of their (kv head, row) group; 64 groups cover [8, 32, 128]
        let out = crate::outbuf::kernel_out((8, 32, 128), DType::BF16, q.device())?;
        let b2 = DType::BF16.size_in_bytes();
        let (qb, qo, l_q) = msl_buf(q, b2)?;
        let (kb, ko, _) = msl_buf(ring_k, b2)?;
        let (vb, vo, _) = msl_buf(ring_v, b2)?;
        let (bkb, bko, l_bk) = msl_buf(blk_k, b2)?;
        let (bvb, bvo, _) = msl_buf(blk_v, b2)?;
        let (ob, oo, _) = msl_buf(&out, b2)?;
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("draft_attn_split");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(p_at);
        enc.set_input_buffer(0, Some(&qb), qo as _);
        enc.set_input_buffer(1, Some(&kb), ko as _);
        enc.set_input_buffer(2, Some(&vb), vo as _);
        enc.set_input_buffer(3, Some(&bkb), bko as _);
        enc.set_input_buffer(4, Some(&bvb), bvo as _);
        enc.set_output_buffer(5, Some(&ob), oo as _);
        #[repr(C)]
        struct P {
            ring_len: i32,
            start_slot: i32,
            q_stride: i32,
            kv_stride: i32,
            nsplit: i32,
        }
        enc.set_bytes(
            6,
            &P {
                ring_len: ring_len as i32,
                start_slot: start_slot as i32,
                q_stride: l_q.stride()[0] as i32,
                kv_stride: l_bk.stride()[0] as i32,
                nsplit: nsplit as i32,
            },
        );
        enc.dispatch_thread_groups(
            MTLSize { width: 8, height: 8, depth: 1 },
            MTLSize { width: 128 * nsplit, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(out)
    }

    /// `TH_BENCH_DRAFT_ATTN=1 th-engine probe --model x --tokens 1` (no
    /// model load): correctness of `draft_attn` / `draft_attn_split`
    /// (nsplit 1, 2, 4, 8) against an f64 CPU reference and the eager
    /// fallback, plus per-call timing across ring lengths.
    pub fn bench_draft_attn(dev: &candle_core::Device) -> Result<()> {
        fn fill(n: usize, seed: u64, amp: f32) -> Vec<f32> {
            let mut s: u64 = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (0..n)
                .map(|_| {
                    s = s
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    let u = ((s >> 40) as f32) / ((1u64 << 24) as f32);
                    (u * 2.0 - 1.0) * amp
                })
                .collect()
        }
        let mk = |v: Vec<f32>, sh: (usize, usize, usize)| -> Result<Tensor> {
            Tensor::from_vec(v, sh, dev)?.to_dtype(DType::BF16)
        };
        let q = mk(fill(8 * 32 * 128, 1, 2.0), (8, 32, 128))?;
        let ring_k = mk(fill(8 * 2048 * 128, 2, 2.0), (8, 2048, 128))?;
        let ring_v = mk(fill(8 * 2048 * 128, 3, 1.0), (8, 2048, 128))?;
        let blk_k = mk(fill(8 * 8 * 128, 4, 2.0), (8, 8, 128))?;
        let blk_v = mk(fill(8 * 8 * 128, 5, 1.0), (8, 8, 128))?;
        let host = |t: &Tensor| -> Result<Vec<f32>> {
            t.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()
        };
        let (qr, rk, rv, bk, bv) =
            (host(&q)?, host(&ring_k)?, host(&ring_v)?, host(&blk_k)?, host(&blk_v)?);
        let reference = |l: usize, start: usize| -> Vec<f32> {
            let mut out = vec![0f32; 8 * 32 * 128];
            let sc = 1.0f64 / (128f64).sqrt();
            for row in 0..8 {
                for h in 0..32 {
                    let kvh = h / 4;
                    let qv = &qr[(row * 32 + h) * 128..(row * 32 + h + 1) * 128];
                    let kv = |t: usize| -> (&[f32], &[f32]) {
                        if t < l {
                            let slot = (start + t) % 2048;
                            let o = (kvh * 2048 + slot) * 128;
                            (&rk[o..o + 128], &rv[o..o + 128])
                        } else {
                            let o = ((t - l) * 8 + kvh) * 128;
                            (&bk[o..o + 128], &bv[o..o + 128])
                        }
                    };
                    let n = l + 8;
                    let mut s = vec![0f64; n];
                    for (t, st) in s.iter_mut().enumerate() {
                        let (k, _) = kv(t);
                        *st = qv.iter().zip(k).map(|(a, b)| *a as f64 * *b as f64).sum::<f64>() * sc;
                    }
                    let mx = s.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                    let mut den = 0f64;
                    let mut acc = [0f64; 128];
                    for (t, st) in s.iter().enumerate() {
                        let w = (st - mx).exp();
                        den += w;
                        let (_, v) = kv(t);
                        for d in 0..128 {
                            acc[d] += w * v[d] as f64;
                        }
                    }
                    for d in 0..128 {
                        out[(row * 32 + h) * 128 + d] = (acc[d] / den) as f32;
                    }
                }
            }
            out
        };
        let maxd = |a: &[f32], b: &[f32]| -> f32 {
            a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0f32, f32::max)
        };
        // ---- correctness (split1 must equal draft_attn bit for bit) ----
        let mut all_ok = true;
        for &(l, start) in &[(0usize, 0usize), (100, 0), (248, 1900), (1000, 1500), (2048, 0), (2048, 777)] {
            let r = reference(l, start);
            let f = host(&draft_attn(&q, &ring_k, &ring_v, &blk_k, &blk_v, l, start)?)?;
            let mut line = format!("[n4] check ring_len={l:4} start={start:4}: |fused-ref|={:.5}", maxd(&f, &r));
            for ns in [1usize, 2, 4, 8] {
                let sp = host(&draft_attn_split(&q, &ring_k, &ring_v, &blk_k, &blk_v, l, start, ns)?)?;
                let bits_equal = sp.iter().zip(&f).all(|(a, b)| a.to_bits() == b.to_bits());
                if ns == 1 && !bits_equal {
                    all_ok = false;
                }
                line += &format!(
                    " |split{ns}-ref|={:.5}{}",
                    maxd(&sp, &r),
                    if bits_equal { "(=fused)" } else { "" }
                );
            }
            eprintln!("{line}");
        }
        eprintln!("[n4] split1 bit-identical to draft_attn: {}", if all_ok { "yes" } else { "NO" });
        // ---- timing: GPU-inclusive wall per call over `reps` calls ----
        let reps: usize = std::env::var("TH_N4_REPS").ok().and_then(|s| s.parse().ok()).unwrap_or(200);
        let time = |f: &dyn Fn() -> Result<Tensor>| -> Result<f64> {
            for _ in 0..5 {
                let _ = f()?;
            }
            dev.synchronize()?;
            let t = std::time::Instant::now();
            for _ in 0..reps {
                let _ = f()?;
            }
            dev.synchronize()?;
            Ok(t.elapsed().as_secs_f64() * 1e6 / reps as f64)
        };
        eprintln!("[n4] reps={reps}; us/call (wall incl. encode); x5 = one propose's 5 draft layers");
        eprintln!("[n4] ring_len |  fused(8tg) | split1(64tg) split2  split4  split8 | policy");
        for &l in &[0usize, 64, 128, 248, 256, 512, 768, 1024, 1450, 1536, 2048] {
            let tf = time(&|| draft_attn(&q, &ring_k, &ring_v, &blk_k, &blk_v, l, 0))?;
            let mut ts = Vec::new();
            for ns in [1usize, 2, 4, 8] {
                ts.push(time(&|| draft_attn_split(&q, &ring_k, &ring_v, &blk_k, &blk_v, l, 0, ns))?);
            }
            let pol = super::draft_attn_nsplit(l);
            let tp = match pol {
                None => tf,
                Some(1) => ts[0],
                Some(2) => ts[1],
                Some(4) => ts[2],
                Some(8) => ts[3],
                Some(n) => time(&|| draft_attn_split(&q, &ring_k, &ring_v, &blk_k, &blk_v, l, 0, n))?,
            };
            let pol = pol.map_or("draft_attn".to_string(), |n| format!("split{n}"));
            eprintln!(
                "[n4] {l:8} | {tf:10.1}  | {:10.1} {:7.1} {:7.1} {:7.1} | {pol} {tp:.1} (x5 layers: fused {:.2} ms, policy {:.2} ms per propose)",
                ts[0], ts[1], ts[2], ts[3],
                5.0 * tf / 1e3,
                5.0 * tp / 1e3
            );
        }
        Ok(())
    }
}
