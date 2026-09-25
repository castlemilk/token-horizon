//! Fused full-attention kernels for the verify/decode path:
//!
//! - `attn_prepare`: one threadgroup per (row, head) computes the
//!   per-head rmsnorm + weight, applies partial rotary (NeoX pairs), and
//!   writes q into a scratch buffer while appending k/v directly into
//!   the fixed-capacity caches at `pos` — replacing the per-layer
//!   narrow→contiguous→rms_norm→rope→cat chain (~20 dispatches) plus the
//!   O(context) cache copy every step.
//! - `attn_decode`: one threadgroup per (kv-head, row), one simdgroup
//!   per query head — online-softmax flash decode over the cache with
//!   the output gate's sigmoid fused into the epilogue — replacing the
//!   matmul→affine→softmax→matmul→sigmoid→mul chain.

#[cfg(all(feature = "metal", target_os = "macos"))]
mod metal_impl {
    use candle_core::{DType, Result, Storage, Tensor};
    use candle_metal_kernels::metal::{Buffer, ComputePipeline};
    use candle_metal_kernels::utils::EncoderProvider;
    use objc2_metal::MTLSize;
    use std::sync::OnceLock;

    const SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct AttnPrepParams {
    int pos;
    int qkv_stride;
    int khs;
    int kts;
    int vhs;
    int vts;
    float eps;
    float _pad;
};

// grid (HN + 2*HKV, SEQ) threadgroups x 256 threads — one (head, row)
// per threadgroup. Q rows are normed+roped into q_out; K rows are
// normed+roped into the cache at pos+row; V rows are copied verbatim.
kernel void attn_prepare(
    device const bfloat* qkv   [[buffer(0)]],
    device const bfloat* qn    [[buffer(1)]],
    device const bfloat* kn    [[buffer(2)]],
    device const float*  rcos  [[buffer(3)]],
    device const float*  rsin  [[buffer(4)]],
    device bfloat* q_out       [[buffer(5)]],
    device bfloat* kc          [[buffer(6)]],
    device bfloat* vc          [[buffer(7)]],
    constant AttnPrepParams& p [[buffer(8)]],
    uint2 tgp  [[threadgroup_position_in_grid]],
    uint  tid  [[thread_index_in_threadgroup]],
    uint  lane [[thread_index_in_simdgroup]],
    uint  sg   [[simdgroup_index_in_threadgroup]])
{
    const uint head = tgp.x, row = tgp.y;
    const uint pos = p.pos + row;
    device const bfloat* src;
    device bfloat* dst;
    device const bfloat* w;
    if (head < HN) {
        src = qkv + row * p.qkv_stride + head * 2 * DIM;
        w = qn;
        dst = q_out + (row * HN + head) * DIM;
    } else if (head < HN + HKV) {
        const uint hk = head - HN;
        src = qkv + row * p.qkv_stride + HN * 2 * DIM + hk * DIM;
        w = kn;
        dst = kc + hk * p.khs + pos * p.kts;
    } else {
        const uint hv = head - HN - HKV;
        src = qkv + row * p.qkv_stride + (HN * 2 + HKV) * DIM + hv * DIM;
        device bfloat* vd = vc + hv * p.vhs + pos * p.vts;
        vd[tid] = src[tid];
        return;
    }
    threadgroup float red[8];
    threadgroup bfloat nrm[DIM];
    const float e = float(src[tid]);
    const float ss = simd_sum(e * e);
    if (lane == 0) red[sg] = ss;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tid == 0) {
        float t = 0.0f;
        for (int i = 0; i < 8; ++i) t += red[i];
        red[0] = rsqrt(t / float(DIM) + p.eps);
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    nrm[tid] = bfloat(e * red[0] * float(w[tid]));
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tid < ROTP) {
        const float a = float(nrm[tid]);
        const float b = float(nrm[tid + ROTP]);
        const float c = rcos[pos * ROTP + tid];
        const float s = rsin[pos * ROTP + tid];
        dst[tid]      = bfloat(a * c - b * s);
        dst[tid + ROTP] = bfloat(b * c + a * s);
    } else if (tid >= 2 * ROTP) {
        dst[tid] = nrm[tid];
    }
}

struct AttnDecParams {
    int kv_len;      // pos + seq
    int qkv_stride;
    int khs;
    int kts;
    int vhs;
    int vts;
    int causal_base; // pos — row r attends [0, base + r]
    int _pad;
};

// grid (HKV, SEQ) threadgroups x 192 threads — sg s owns q head
// kvh*GRP + s (GRP = HN/HKV). Each lane owns channels lane*8..+8.
kernel void attn_decode(
    device const bfloat* q_buf [[buffer(0)]],
    device const bfloat* kc    [[buffer(1)]],
    device const bfloat* vc    [[buffer(2)]],
    device const bfloat* qkv   [[buffer(3)]],
    device bfloat*       out   [[buffer(4)]],
    constant AttnDecParams& p  [[buffer(5)]],
    uint2 tgp  [[threadgroup_position_in_grid]],
    uint  lane [[thread_index_in_simdgroup]],
    uint  sg   [[simdgroup_index_in_threadgroup]])
{
    const uint kvh = tgp.x, row = tgp.y;
    const uint qh = kvh * GRP + sg;
    const uint lim = p.causal_base + row + 1;
    device const bfloat* qr = q_buf + (row * HN + qh) * DIM;
    float qv[8], acc[8];
    for (int i = 0; i < 8; ++i) {
        qv[i] = float(qr[lane * 8 + i]);
        acc[i] = 0.0f;
    }
    const float scale = rsqrt(float(DIM));
    float m = -INFINITY, l = 0.0f;
    device const bfloat* kr = kc + (ulong)kvh * p.khs;
    device const bfloat* vr = vc + (ulong)kvh * p.vhs;
    for (uint t = 0; t < lim; ++t) {
        float part = 0.0f;
        for (int i = 0; i < 8; ++i)
            part += qv[i] * float(kr[t * p.kts + lane * 8 + i]);
        const float s = simd_sum(part) * scale;
        const float mn = max(m, s);
        const float f = exp(m - mn);
        const float pw = exp(s - mn);
        l = l * f + pw;
        m = mn;
        for (int i = 0; i < 8; ++i)
            acc[i] = acc[i] * f + pw * float(vr[t * p.vts + lane * 8 + i]);
    }
    const float inv_l = 1.0f / l;
    device const bfloat* g =
        qkv + row * p.qkv_stride + qh * 2 * DIM + DIM;
    for (int i = 0; i < 8; ++i) {
        const uint c = lane * 8 + i;
        const float gg = float(g[c]);
        out[(row * HN + qh) * DIM + c] =
            bfloat(acc[i] * inv_l / (1.0f + exp(-gg)));
    }
}
"#;

    fn render(nh: usize, nkv: usize, d: usize, rp: usize) -> String {
        let mut s = String::new();
        s.push_str(&format!(
            "constant uint HN = {};\nconstant uint HKV = {};\n\
             constant uint GRP = {};\nconstant uint DIM = {};\n\
             constant uint ROTP = {};\n",
            nh,
            nkv,
            nh / nkv,
            d,
            rp
        ));
        s.push_str(SRC);
        s
    }

    #[repr(C)]
    struct PrepParams {
        pos: i32,
        qkv_stride: i32,
        khs: i32,
        kts: i32,
        vhs: i32,
        vts: i32,
        eps: f32,
        _pad: f32,
    }

    #[repr(C)]
    struct DecParams {
        kv_len: i32,
        qkv_stride: i32,
        khs: i32,
        kts: i32,
        vhs: i32,
        vts: i32,
        causal_base: i32,
        _pad: i32,
    }

    static PIPES: OnceLock<(ComputePipeline, ComputePipeline)> =
        OnceLock::new();

    /// Buffer + byte-offset pair for a tensor (layout must have a
    /// contiguous inner dim; strided rows are fine).
    fn msl_buf(t: &Tensor, elem_size: usize) -> Result<(Buffer, usize)> {
        let (st, l) = t.storage_and_layout();
        match &*st {
            Storage::Metal(m) => Ok((
                m.buffer().clone(),
                l.start_offset() * elem_size,
            )),
            _ => candle_core::bail!("attn kernel: non-Metal tensor"),
        }
    }

    /// Norm + rope q/k, append k/v into the caches at `pos`, write
    /// normed+roped q to `q_out` ([seq, nh, d]). All tensors bf16 except
    /// f32 cos/sin.
    pub fn attn_prepare(
        qkv: &Tensor,
        q_norm: &Tensor,
        k_norm: &Tensor,
        cos: &Tensor,
        sin: &Tensor,
        q_out: &Tensor,
        k_cache: &Tensor,
        v_cache: &Tensor,
        pos: usize,
        seq: usize,
        nh: usize,
        nkv: usize,
        d: usize,
        rp: usize,
        eps: f32,
    ) -> Result<()> {
        let (s_q, l_q) = qkv.storage_and_layout();
        let Storage::Metal(s_q) = &*s_q else {
            candle_core::bail!("attn_prepare: non-Metal qkv")
        };
        if l_q.stride().last() != Some(&1) {
            candle_core::bail!("attn_prepare: qkv inner dim must be contiguous");
        }
        use candle_core::backend::BackendStorage;
        let device = s_q.device();
        if PIPES.get().is_none() {
            let raw = device.metal_device();
            if std::env::var("TH_DEBUG_ATTN").is_ok() {
                std::fs::write("/tmp/attn_src.metal", render(nh, nkv, d, rp)).ok();
            }
            let lib = raw
                .new_library_with_source(
                    &render(nh, nkv, d, rp),
                    None,
                )
                .map_err(candle_core::Error::wrap)?;
            let f1 = lib
                .get_function("attn_prepare", None)
                .map_err(candle_core::Error::wrap)?;
            let f2 = lib
                .get_function("attn_decode", None)
                .map_err(candle_core::Error::wrap)?;
            let p1 = raw
                .new_compute_pipeline_state_with_function(&f1)
                .map_err(candle_core::Error::wrap)?;
            let p2 = raw
                .new_compute_pipeline_state_with_function(&f2)
                .map_err(candle_core::Error::wrap)?;
            let _ = PIPES.set((p1, p2));
        }
        let (p_prep, _) = PIPES.get().unwrap();

        let encoder =
            device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("attn_prepare");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(p_prep);
        let cap = k_cache.dim(1)?;
        let k_st = k_cache.stride();
        let v_st = v_cache.stride();
        if k_st[2] != 1 || v_st[2] != 1 {
            candle_core::bail!("attn_prepare: kv cache inner dim must be contiguous");
        }
        let (qn_b, qn_o) = msl_buf(q_norm, 2)?;
        let (kn_b, kn_o) = msl_buf(k_norm, 2)?;
        let (rc_b, rc_o) = msl_buf(cos, 4)?;
        let (rs_b, rs_o) = msl_buf(sin, 4)?;
        let (qo_b, qo_o) = msl_buf(q_out, 2)?;
        let (kc_b, kc_o) = msl_buf(k_cache, 2)?;
        let (vc_b, vc_o) = msl_buf(v_cache, 2)?;
        if std::env::var("TH_DEBUG_ATTN").is_ok() {
            eprintln!(
                "  [prep] kc_len={:?} kc_off={} cap={} pos={} seq={} kc_dt={:?} kc_dims={:?} kc_stride={:?}",
                kc_b.length(), kc_o, cap, pos, seq, k_cache.dtype(),
                k_cache.shape().dims(), k_cache.stride()
            );
        }
        enc.set_input_buffer(
            0,
            Some(s_q.buffer()),
            l_q.start_offset() * DType::BF16.size_in_bytes(),
        );
        enc.set_input_buffer(1, Some(&qn_b), qn_o as _);
        enc.set_input_buffer(2, Some(&kn_b), kn_o as _);
        enc.set_input_buffer(3, Some(&rc_b), rc_o as _);
        enc.set_input_buffer(4, Some(&rs_b), rs_o as _);
        enc.set_output_buffer(5, Some(&qo_b), qo_o as _);
        enc.set_output_buffer(6, Some(&kc_b), kc_o as _);
        enc.set_output_buffer(7, Some(&vc_b), vc_o as _);
        let params = PrepParams {
            pos: pos as i32,
            qkv_stride: l_q.stride()[l_q.shape().dims().len() - 2] as i32,
            khs: k_st[0] as i32,
            kts: k_st[1] as i32,
            vhs: v_st[0] as i32,
            vts: v_st[1] as i32,
            eps,
            _pad: 0.0,
        };
        enc.set_bytes(8, &params);
        enc.dispatch_thread_groups(
            MTLSize {
                width: nh + 2 * nkv,
                height: seq,
                depth: 1,
            },
            MTLSize { width: 256, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(())
    }

    /// Fused decode attention over the cache: `out[r, h*d + c]` =
    /// softmax(q·Kᵀ)·V with the output gate's sigmoid applied, for
    /// `seq` query rows attending causally to `pos + r`.
    #[allow(clippy::too_many_arguments)]
    pub fn attn_decode(
        q_buf: &Tensor,   // [seq, nh, d]
        k_cache: &Tensor, // [nkv, cap, d]
        v_cache: &Tensor,
        qkv: &Tensor,     // [1, seq, packed] — gate region source
        out: &Tensor,     // [seq, nh*d]
        pos: usize,
        seq: usize,
        nh: usize,
        nkv: usize,
        d: usize,
        rp: usize,
    ) -> Result<()> {
        let (s_q, l_q) = qkv.storage_and_layout();
        let Storage::Metal(s_q) = &*s_q else {
            candle_core::bail!("attn_decode: non-Metal qkv")
        };
        use candle_core::backend::BackendStorage;
        let device = s_q.device();
        if PIPES.get().is_none() {
            let raw = device.metal_device();
            let lib = raw
                .new_library_with_source(
                    &render(nh, nkv, d, rp),
                    None,
                )
                .map_err(candle_core::Error::wrap)?;
            let f1 = lib
                .get_function("attn_prepare", None)
                .map_err(candle_core::Error::wrap)?;
            let f2 = lib
                .get_function("attn_decode", None)
                .map_err(candle_core::Error::wrap)?;
            let p1 = raw
                .new_compute_pipeline_state_with_function(&f1)
                .map_err(candle_core::Error::wrap)?;
            let p2 = raw
                .new_compute_pipeline_state_with_function(&f2)
                .map_err(candle_core::Error::wrap)?;
            let _ = PIPES.set((p1, p2));
        }
        let (_, p_dec) = PIPES.get().unwrap();

        let k_st = k_cache.stride();
        let v_st = v_cache.stride();
        if k_st[2] != 1 || v_st[2] != 1 {
            candle_core::bail!("attn_decode: kv cache inner dim must be contiguous");
        }
        let encoder =
            device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("attn_decode");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(p_dec);
        let (qb_b, qb_o) = msl_buf(q_buf, 2)?;
        let (kc_b, kc_o) = msl_buf(k_cache, 2)?;
        let (vc_b, vc_o) = msl_buf(v_cache, 2)?;
        let (ot_b, ot_o) = msl_buf(out, 2)?;
        enc.set_input_buffer(0, Some(&qb_b), qb_o as _);
        enc.set_input_buffer(1, Some(&kc_b), kc_o as _);
        enc.set_input_buffer(2, Some(&vc_b), vc_o as _);
        enc.set_input_buffer(
            3,
            Some(s_q.buffer()),
            l_q.start_offset() * DType::BF16.size_in_bytes(),
        );
        enc.set_output_buffer(4, Some(&ot_b), ot_o as _);
        let params = DecParams {
            kv_len: (pos + seq) as i32,
            qkv_stride: l_q.stride()[l_q.shape().dims().len() - 2] as i32,
            khs: k_st[0] as i32,
            kts: k_st[1] as i32,
            vhs: v_st[0] as i32,
            vts: v_st[1] as i32,
            causal_base: pos as i32,
            _pad: 0,
        };
        enc.set_bytes(5, &params);
        enc.dispatch_thread_groups(
            MTLSize {
                width: nkv,
                height: seq,
                depth: 1,
            },
            MTLSize {
                width: 32 * (nh / nkv),
                height: 1,
                depth: 1,
            },
        );
        drop(encoder);
        Ok(())
    }
}

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::{attn_decode, attn_prepare};

#[cfg(not(all(feature = "metal", target_os = "macos")))]
pub mod stub {
    #![allow(unused_imports)]
    use super::*;
    use candle_core::{Result, Tensor};

    pub fn attn_prepare(
        _: &Tensor,
        _: &Tensor,
        _: &Tensor,
        _: &Tensor,
        _: &Tensor,
        _: &Tensor,
        _: &Tensor,
        _: &Tensor,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
        _: f32,
    ) -> Result<()> {
        candle_core::bail!("attn_prepare: Metal only")
    }

    pub fn attn_decode(
        _: &Tensor,
        _: &Tensor,
        _: &Tensor,
        _: &Tensor,
        _: &Tensor,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
    ) -> Result<()> {
        candle_core::bail!("attn_decode: Metal only")
    }
}

#[cfg(not(all(feature = "metal", target_os = "macos")))]
pub use stub::{attn_decode, attn_prepare};
