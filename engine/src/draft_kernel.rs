//! Fused Metal kernels for the DFlash draft model — mirrors the
//! target-model kernel strategy (one dispatch where the eager chain
//! runs a dozen). All ops are bf16-in/bf16-out with f32 accumulation.

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::{draft_attn, draft_conv_fused, draft_norm_rope};

#[cfg(all(feature = "metal", target_os = "macos"))]
mod metal_impl {
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
    const int r = int(i) / 5120;
    const int g = c / 16;
    const int off = p.stage * 640;
    const float t0 = float(dyn[r * 1280 + off + g])
                   + float(base[p.stage * 2 * 5120 + c]);
    const float t1 = float(dyn[r * 1280 + off + 320 + g])
                   + float(base[(p.stage * 2 + 1) * 5120 + c]);
    const float prev = r > 0 ? float(x[i - 5120]) : 0.0f;
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
        let out = Tensor::zeros((1, 8, 5120), DType::BF16, x.device())?;
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
            MTLSize { width: 8 * 5120, height: 1, depth: 1 },
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
        let out = Tensor::zeros((rows, heads, 128), DType::BF16, x.device())?;
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
        let out = Tensor::zeros((8, 32, 128), DType::BF16, q.device())?;
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
}
