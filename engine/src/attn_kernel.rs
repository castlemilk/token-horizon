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
//!   matmul→affine→softmax→matmul→sigmoid→mul chain. Every simdgroup
//!   walks the whole context serially, so it only fills `nkv * seq`
//!   threadgroups (32 for a verify block): fine for short contexts, the
//!   dominant verify cost past ~1k keys (PHASEB N3).
//! - `attn_decode_split` (N3): the split-key form. One threadgroup per
//!   (kv head, key split) runs the whole GQA group of the verify block —
//!   M = 8 rows x (heads per kv head) fused query rows — over its share
//!   of 32-key pages with MPP `matmul2d` for q·kᵀ and p·v (the K/V page
//!   is read once for all 48 query rows, not once per row), keeping a
//!   per-row online softmax; each split writes f32 partials + (max, sum)
//!   and a second dispatch combines the splits in a fixed order and
//!   applies the sigmoid gate. Deterministic: the partition depends only
//!   on (visible keys, split count), and the reduce order is fixed.
//!   Ported from Splash's `paged_attention_tile.h` verify tile
//!   (incoai/splash@134807b) onto our contiguous head- or time-major
//!   bf16 caches. `attn_prepare` writes q in the tile's KV-head-major
//!   layout when `qrows > 0`.

/// N3 split plan for `visible` keys: `max(base, ceil(pages / pps))`
/// splits (one split per `pps` 32-key pages past the base), capped at
/// `max_splits` and at the page count. Pure — the policy's unit tests
/// and the kernel's partition both derive from it.
pub fn split_count(visible: usize, base: usize, pps: usize, max_splits: usize) -> usize {
    let pages = visible.div_ceil(SPLIT_PAGE).max(1);
    let scaled = pages.div_ceil(pps.max(1));
    base.max(scaled).clamp(1, max_splits.max(1)).min(pages)
}

/// Keys per page of the split kernel's tile (the MPP n extent).
pub const SPLIT_PAGE: usize = 32;
/// Verify rows per query tile (the q tile is padded to this many rows).
pub const SPLIT_QROWS: usize = 8;
/// Partials workspace bound (splits per kv head).
pub const SPLIT_MAX: usize = 128;

/// N3 routing knobs, read once. `TH_ATTN_SPLIT=0` keeps every call on
/// the single-pass `attn_decode`; `TH_ATTN_SPLIT_MIN` is the smallest
/// visible-key count routed to the split kernel (below it every call —
/// all of a short-prompt request — keeps the single-pass kernel and its
/// exact numerics); `TH_ATTN_SPLITS` pins the split count;
/// `TH_ATTN_SPLIT_BASE` / `TH_ATTN_SPLIT_PPS` / `TH_ATTN_SPLIT_CAP` shape
/// `split_count`.
#[derive(Clone, Copy, Debug)]
pub struct SplitCfg {
    pub enabled: bool,
    pub min_keys: usize,
    pub base: usize,
    pub pps: usize,
    pub cap: usize,
    pub fixed: Option<usize>,
    /// p.v on f32 probabilities (`TH_ATTN_SPLIT_P=f32`) instead of bf16.
    pub p_f32: bool,
}

pub fn split_cfg() -> SplitCfg {
    static CFG: std::sync::OnceLock<SplitCfg> = std::sync::OnceLock::new();
    *CFG.get_or_init(|| {
        let num = |k: &str| std::env::var(k).ok().and_then(|v| v.trim().parse::<usize>().ok());
        SplitCfg {
            enabled: std::env::var("TH_ATTN_SPLIT").map_or(true, |v| v.trim() != "0"),
            min_keys: num("TH_ATTN_SPLIT_MIN").unwrap_or(SPLIT_MIN_KEYS),
            base: num("TH_ATTN_SPLIT_BASE").unwrap_or(SPLIT_BASE),
            pps: num("TH_ATTN_SPLIT_PPS").unwrap_or(SPLIT_PPS).max(1),
            cap: num("TH_ATTN_SPLIT_CAP").unwrap_or(SPLIT_CAP).clamp(1, SPLIT_MAX),
            fixed: num("TH_ATTN_SPLITS").filter(|&s| s > 0).map(|s| s.min(SPLIT_MAX)),
            p_f32: std::env::var("TH_ATTN_SPLIT_P").map_or(SPLIT_P_F32, |v| v.trim() == "f32"),
        }
    })
}

/// Defaults, tuned on the M5 Max 40-core GPU (TH_BENCH_ATTN sweep at
/// L = 128..32k, both cache layouts; th/d-longctx report §2): the split
/// kernel beats the single-pass one at every L >= 128 (6.8x at 256,
/// 15-19x at 1.45k, 25-29x at 8k), so the threshold only guards the
/// short-prompt numerics; f32 probabilities cost ~25% of the (tiny)
/// split time and keep the single-pass kernel's precision class; 16
/// splits (64 threadgroups) is best to ~4k keys, 32 from 8k up (more
/// splits only add partials traffic).
pub const SPLIT_MIN_KEYS: usize = 256;
pub const SPLIT_P_F32: bool = true;
pub const SPLIT_BASE: usize = 16;
pub const SPLIT_PPS: usize = 8;
pub const SPLIT_CAP: usize = 32;

/// The split count for a call at `visible` keys under `cfg`, or `None`
/// when the call stays on the single-pass kernel.
pub fn split_for(cfg: &SplitCfg, visible: usize) -> Option<usize> {
    if !cfg.enabled || visible < cfg.min_keys {
        return None;
    }
    let pages = visible.div_ceil(SPLIT_PAGE).max(1);
    Some(match cfg.fixed {
        Some(s) => s.min(pages),
        None => split_count(visible, cfg.base, cfg.pps, cfg.cap),
    })
}

#[cfg(all(feature = "metal", target_os = "macos"))]
pub(crate) mod metal_impl {
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
    int qrows;       // 0: q_out is [seq, HN, DIM]; >0: [HKV][qrows][GRP][DIM]
    int seq;         // live rows; rows seq..qrows (split tile padding) get zero q
    int _pad;
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
    if (row >= uint(p.seq)) {
        // split-tile padding row (never reduced): finite zero q, no K/V
        if (head < HN)
            q_out[(((head / GRP) * uint(p.qrows) + row) * GRP + head % GRP) * DIM + tid] = bfloat(0.0f);
        return;
    }
    device const bfloat* src;
    device bfloat* dst;
    device const bfloat* w;
    if (head < HN) {
        src = qkv + row * p.qkv_stride + head * 2 * DIM;
        w = qn;
        dst = p.qrows > 0
            ? q_out + (((head / GRP) * uint(p.qrows) + row) * GRP + head % GRP) * DIM
            : q_out + (row * HN + head) * DIM;
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

    pub(crate) fn render(nh: usize, nkv: usize, d: usize, rp: usize) -> String {
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
        qrows: i32,
        seq: i32,
        _pad: i32,
    }

    #[repr(C)]
    pub(crate) struct DecParams {
        pub kv_len: i32,
        pub qkv_stride: i32,
        pub khs: i32,
        pub kts: i32,
        pub vhs: i32,
        pub vts: i32,
        pub causal_base: i32,
        pub _pad: i32,
    }

    /// Pipelines compiled per attention geometry (the MSL bakes the dims
    /// in as constants). A process serving one model has one geometry —
    /// the lock-free `first` slot; a second geometry in the same process
    /// (unit tests mixing model shapes) goes through the keyed `rest`
    /// list instead of silently reusing the first geometry's kernels.
    pub(crate) struct GeomCache<T: 'static> {
        first: OnceLock<(Geom, &'static T)>,
        rest: std::sync::Mutex<Vec<(Geom, &'static T)>>,
    }

    type Geom = (usize, usize, usize, usize);

    impl<T: 'static> GeomCache<T> {
        const fn new() -> Self {
            Self { first: OnceLock::new(), rest: std::sync::Mutex::new(Vec::new()) }
        }

        #[cfg(test)]
        pub(crate) const fn new_for_tests() -> Self {
            Self::new()
        }

        pub(crate) fn get(&self, g: Geom, init: impl FnOnce() -> T) -> &'static T {
            let mut init = Some(init);
            let (k, v) = *self
                .first
                .get_or_init(|| (g, Box::leak(Box::new((init.take().unwrap())()))));
            if k == g {
                return v;
            }
            // a different geometry owns the fast slot (our closure did not
            // run, so `init` is still ours)
            let mut rest = self.rest.lock().unwrap();
            if let Some((_, v)) = rest.iter().find(|(k, _)| *k == g) {
                return v;
            }
            let v: &'static T = Box::leak(Box::new((init.take().unwrap())()));
            rest.push((g, v));
            v
        }
    }

    static PIPES: GeomCache<std::result::Result<(ComputePipeline, ComputePipeline), String>> =
        GeomCache::new();

    /// `TH_DEBUG_ATTN` (dump the rendered source, print cache layouts) —
    /// read once, not per layer call.
    pub(crate) fn debug_attn() -> bool {
        static ON: OnceLock<bool> = OnceLock::new();
        *ON.get_or_init(|| std::env::var("TH_DEBUG_ATTN").is_ok())
    }

    /// Buffer + byte-offset pair for a tensor (layout must have a
    /// contiguous inner dim; strided rows are fine).
    #[cfg(test)]
    pub(crate) fn msl_buf_pub(t: &Tensor, elem_size: usize) -> Result<(Buffer, usize)> {
        msl_buf(t, elem_size)
    }

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

    fn pipes(
        device: &candle_core::MetalDevice,
        nh: usize,
        nkv: usize,
        d: usize,
        rp: usize,
    ) -> Result<&'static (ComputePipeline, ComputePipeline)> {
        let compile = || -> Result<(ComputePipeline, ComputePipeline)> {
            let raw = device.metal_device();
            if debug_attn() {
                std::fs::write("/tmp/attn_src.metal", render(nh, nkv, d, rp)).ok();
            }
            let lib = raw
                .new_library_with_source(&render(nh, nkv, d, rp), None)
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
            Ok((p1, p2))
        };
        PIPES
            .get((nh, nkv, d, rp), || compile().map_err(|e| e.to_string()))
            .as_ref()
            .map_err(|e| candle_core::Error::Msg(format!("attn kernels: {e}")))
    }

    /// Norm + rope q/k, append k/v into the caches at `pos`, write
    /// normed+roped q to `q_out`. `qrows == 0`: q_out is [seq, nh, d]
    /// (the `attn_decode` layout); `qrows > 0`: q_out is KV-head-major
    /// [nkv][qrows][nh/nkv][d] (the `attn_decode_split` tile layout;
    /// rows seq..qrows are written as zeros). All tensors bf16 except
    /// f32 cos/sin.
    #[allow(clippy::too_many_arguments)]
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
        qrows: usize,
    ) -> Result<()> {
        let (s_q, l_q) = qkv.storage_and_layout();
        let Storage::Metal(s_q) = &*s_q else {
            candle_core::bail!("attn_prepare: non-Metal qkv")
        };
        if l_q.stride().last() != Some(&1) {
            candle_core::bail!("attn_prepare: qkv inner dim must be contiguous");
        }
        if qrows > 0 && qrows < seq {
            candle_core::bail!("attn_prepare: qrows {qrows} < seq {seq}");
        }
        use candle_core::backend::BackendStorage;
        let device = s_q.device();
        let (p_prep, _) = pipes(device, nh, nkv, d, rp)?;

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
        if debug_attn() {
            eprintln!(
                "  [prep] kc_len={:?} kc_off={} cap={} pos={} seq={} kc_dt={:?} kc_dims={:?} kc_stride={:?} qrows={qrows}",
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
            qrows: qrows as i32,
            seq: seq as i32,
            _pad: 0,
        };
        enc.set_bytes(8, &params);
        // qrows > 0: one row of threadgroups per tile row — rows past
        // `seq` zero their q (so an uninitialised tile buffer is fully
        // written), live rows are unchanged
        enc.dispatch_thread_groups(
            MTLSize {
                width: nh + 2 * nkv,
                height: if qrows > 0 { qrows } else { seq },
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
        let (_, p_dec) = pipes(device, nh, nkv, d, rp)?;

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

    // ------------------------------------------------------------------
    // N3: split-key verify attention (Metal 4 / MPP tensor_ops)
    // ------------------------------------------------------------------

    /// Tile: M = QROWS x GRP fused query rows (row-major in the
    /// KV-head-major q layout, so one M x D tensor per kv head), N = 32
    /// keys per page, D = head dim. Eight simdgroups run the two
    /// `matmul2d`s; 4 lanes per fused row run the page softmax.
    const SPLIT_SRC: &str = r#"
#include <MetalPerformancePrimitives/MetalPerformancePrimitives.h>
#include <metal_stdlib>
using namespace metal;
using namespace mpp::tensor_ops;

// TH_P_F32: probabilities stay f32 for p.v (float x bfloat -> float,
// the single-pass kernel's precision); else bf16 (Splash's tile).
#if TH_P_F32
typedef float prob_t;
typedef float4 prob4_t;
#define TH_PV_RELAXED false
#else
typedef bfloat prob_t;
typedef bfloat4 prob4_t;
#define TH_PV_RELAXED true
#endif

struct AttnSplitParams {
    uint visible;      // pos + seq: keys visible to the last active row
    uint causal_base;  // pos: row r attends keys [0, pos + r]
    uint active_rows;  // seq (<= TH_QROWS)
    uint splits;       // split count (grid.y of the split dispatch)
    uint khs;          // cache element strides
    uint kts;
    uint vhs;
    uint vts;
    uint qkv_stride;   // gate source row stride (elements)
    uint pad0;
    uint pad1;
    uint pad2;
};

// One page of the tile's online softmax: raw q.k scores (f32) become
// bf16 probabilities and the per-row running max / sum advance. Four
// lanes own one fused row, eight consecutive keys each, so the row max
// and sum are two xor shuffles. Threads past 4 x M only take part in
// the caller's barriers. Rows whose running max grew set the shared
// rescale flag (relaxed atomics; the caller's barriers order reset,
// set and read).
inline void th_page_softmax(
    threadgroup const float* scores, threadgroup prob_t* probs,
    threadgroup float* row_max, threadgroup float* row_sum,
    threadgroup float* prev_scale, threadgroup atomic_uint* rescale,
    uint token_start, uint visible, uint causal_base, uint active_rows,
    uint tid)
{
    constexpr uint N = TH_PAGE;
    constexpr uint M = TH_QROWS * TH_GRP;
    constexpr uint TPL = 8;
    constexpr uint LPR = N / TPL;
    if (tid >= LPR * M) return;
    const uint fr = tid / LPR;
    const uint col = (tid % LPR) * TPL;
    const uint qrow = fr / TH_GRP;
    const uint causal_end = causal_base + min(qrow, active_rows - 1) + 1;
    const uint limit = min(visible, causal_end);
    const uint token = token_start + col;
    threadgroup const float4* s4 =
        reinterpret_cast<threadgroup const float4*>(scores + fr * N + col);
    const float4 lo = s4[0] * TH_SCALE;
    const float4 hi = s4[1] * TH_SCALE;
    float s[TPL] = {lo.x, lo.y, lo.z, lo.w, hi.x, hi.y, hi.z, hi.w};
    float lmax = -INFINITY;
#pragma unroll
    for (uint j = 0; j < TPL; ++j) {
        s[j] = token + j < limit ? s[j] : -INFINITY;
        lmax = max(lmax, s[j]);
    }
    lmax = max(lmax, simd_shuffle_xor(lmax, 1));
    lmax = max(lmax, simd_shuffle_xor(lmax, 2));
    const float pmax = row_max[fr];
    const float nmax = max(pmax, lmax);
    float pr[TPL];
    float lsum = 0.0f;
#pragma unroll
    for (uint j = 0; j < TPL; ++j) {
        pr[j] = token + j < limit ? fast::exp(s[j] - nmax) : 0.0f;
        lsum += pr[j];
    }
    lsum += simd_shuffle_xor(lsum, 1);
    lsum += simd_shuffle_xor(lsum, 2);
    if (col == 0) {
        const float scale = (nmax == -INFINITY || nmax == pmax)
                                ? 1.0f : fast::exp(pmax - nmax);
        prev_scale[fr] = scale;
        row_sum[fr] = row_sum[fr] * scale + lsum;
        row_max[fr] = nmax;
        if (scale != 1.0f)
            atomic_store_explicit(rescale, 1u, memory_order_relaxed);
    }
    threadgroup prob4_t* p4 =
        reinterpret_cast<threadgroup prob4_t*>(probs + fr * N + col);
    p4[0] = prob4_t(float4(pr[0], pr[1], pr[2], pr[3]));
    p4[1] = prob4_t(float4(pr[4], pr[5], pr[6], pr[7]));
}

// grid (HKV, splits) x 256 threads. The threadgroup owns kv head
// group.x and pages [split * per, min(pages, +per)) of the visible keys;
// it writes f32 partials [slot][M][D] and (max, sum) [slot][M] for the
// fixed-order reduce. A split past the last page writes nothing (the
// reduce recomputes the partition and never reads it).
kernel void attn_split_mpp(
    device bfloat* q_kv          [[buffer(0)]],
    device bfloat* kc            [[buffer(1)]],
    device bfloat* vc            [[buffer(2)]],
    device float* partials       [[buffer(3)]],
    device float* stats          [[buffer(4)]],
    constant AttnSplitParams& p  [[buffer(5)]],
    uint2 group [[threadgroup_position_in_grid]],
    uint  tid   [[thread_index_in_threadgroup]])
{
    constexpr ushort M = TH_QROWS * TH_GRP;
    constexpr ushort N = TH_PAGE;
    constexpr ushort D = TH_DIM;
    const uint kvh = group.x, split = group.y;
    const uint pages = (p.visible + N - 1) / N;
    const uint per = (pages + p.splits - 1) / p.splits;
    const uint page_begin = split * per;
    if (page_begin >= pages)
        return;
    const uint page_end = min(pages, page_begin + per);

    alignas(16) threadgroup float scores[M * N];
    alignas(16) threadgroup prob_t probs[M * N];
    threadgroup float row_max[M];
    threadgroup float row_sum[M];
    threadgroup float prev_scale[M];
    threadgroup atomic_uint rescale;

    if (tid < M) {
        row_max[tid] = -INFINITY;
        row_sum[tid] = 0.0f;
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    device bfloat* kh = kc + ulong(kvh) * p.khs;
    device bfloat* vh = vc + ulong(kvh) * p.vhs;
    auto qt = tensor(q_kv + ulong(kvh) * M * D, dextents<int, 2>{D, M},
                     array<int, 2>{1, D});
    auto st = tensor(scores, dextents<int, 2>{N, M}, array<int, 2>{1, N});
    auto pt = tensor(probs, dextents<int, 2>{N, M}, array<int, 2>{1, N});
    auto q0 = qt.slice<D, M>(0, 0);
    auto p0 = pt.slice<N, M>(0, 0);
    auto kproto = tensor(kh, dextents<int, 2>{D, N}, array<int, 2>{1, int(p.kts)});
    auto vproto = tensor(vh, dextents<int, 2>{D, N}, array<int, 2>{1, int(p.vts)});
    auto k0 = kproto.slice<D, N>(0, 0);
    auto v0 = vproto.slice<D, N>(0, 0);
    // q.k^T: K pages are [N keys][D] rows (transposed right operand);
    // p.v: V pages are [N keys][D] = the K x N right operand as stored.
    constexpr auto qk_descriptor = matmul2d_descriptor(
        M, N, D, false, true, false, matmul2d_descriptor::mode::multiply);
    constexpr auto pv_descriptor = matmul2d_descriptor(
        M, D, N, false, false, TH_PV_RELAXED,
        matmul2d_descriptor::mode::multiply_accumulate);
    matmul2d<qk_descriptor, execution_simdgroups<8>> qk;
    matmul2d<pv_descriptor, execution_simdgroups<8>> pv;
    auto running = pv.template get_destination_cooperative_tensor<
        decltype(p0), decltype(v0), float>();
    const bool running_full =
        uint(running.get_capacity()) * (8u * 32u) == uint(M) * D;
#pragma unroll
    for (ushort i = 0; i < running.get_capacity(); ++i) {
        if (running_full || running.is_valid_element(i))
            running[i] = 0.0f;
    }

    for (uint page = page_begin; page < page_end; ++page) {
        const uint t0 = page * N;
        auto kt = tensor(kh + ulong(t0) * p.kts, dextents<int, 2>{D, N},
                         array<int, 2>{1, int(p.kts)});
        auto vt = tensor(vh + ulong(t0) * p.vts, dextents<int, 2>{D, N},
                         array<int, 2>{1, int(p.vts)});
        auto page_scores = qk.template get_destination_cooperative_tensor<
            decltype(q0), decltype(k0), float>();
        auto ks = kt.slice<D, N>(0, 0);
        qk.run(q0, ks, page_scores);
        page_scores.store(st.slice<N, M>(0, 0));
        if (tid == 0)
            atomic_store_explicit(&rescale, 0u, memory_order_relaxed);
        threadgroup_barrier(mem_flags::mem_threadgroup);
        th_page_softmax(scores, probs, row_max, row_sum, prev_scale,
                        &rescale, t0, p.visible, p.causal_base,
                        p.active_rows, tid);
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (atomic_load_explicit(&rescale, memory_order_relaxed)) {
#pragma unroll
            for (ushort i = 0; i < running.get_capacity(); ++i) {
                if (!running_full && !running.is_valid_element(i))
                    continue;
                auto c = running.get_multidimensional_index(i);
                running[i] *= prev_scale[c[1]];
            }
        }
        auto vs = vt.slice<D, N>(0, 0);
        pv.run(p0, vs, running);
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }
    const ulong slot = ulong(kvh) * p.splits + split;
    auto target = tensor(partials + slot * M * D, dextents<int, 2>{D, M},
                         array<int, 2>{1, D});
    running.store(target.slice<D, M>(0, 0));
    if (tid < M) {
        stats[(slot * M + tid) * 2] = row_max[tid];
        stats[(slot * M + tid) * 2 + 1] = row_sum[tid];
    }
}

// grid (HKV, seq * GRP) x D threads: one fused row per threadgroup, one
// output channel per thread. Combines the written splits in split order
// (fixed, so the result is deterministic), then applies the sigmoid
// output gate and writes out[row, head * D + c] ([seq, HN * D]).
kernel void attn_split_reduce(
    device const float* partials [[buffer(0)]],
    device const float* stats    [[buffer(1)]],
    device const bfloat* qkv     [[buffer(2)]],
    device bfloat* out           [[buffer(3)]],
    constant AttnSplitParams& p  [[buffer(4)]],
    uint2 tg  [[threadgroup_position_in_grid]],
    uint  tid [[thread_index_in_threadgroup]])
{
    constexpr uint M = TH_QROWS * TH_GRP;
    constexpr uint D = TH_DIM;
    const uint kvh = tg.x, fr = tg.y;
    const uint row = fr / TH_GRP, g = fr % TH_GRP;
    const uint pages = (p.visible + TH_PAGE - 1) / TH_PAGE;
    const uint per = (pages + p.splits - 1) / p.splits;
    const uint written = (pages + per - 1) / per;
    const ulong slot0 = ulong(kvh) * p.splits;
    float mx = -INFINITY;
    for (uint s = 0; s < written; ++s)
        mx = max(mx, stats[((slot0 + s) * M + fr) * 2]);
    float num = 0.0f, den = 0.0f;
    for (uint s = 0; s < written; ++s) {
        const ulong si = ((slot0 + s) * M + fr) * 2;
        const float w = fast::exp(stats[si] - mx);
        num += w * partials[((slot0 + s) * M + fr) * D + tid];
        den += w * stats[si + 1];
    }
    const uint qh = kvh * TH_GRP + g;
    const float gg = float(qkv[ulong(row) * p.qkv_stride + qh * 2 * D + D + tid]);
    out[(ulong(row) * TH_HN + qh) * D + tid] =
        bfloat(num / den / (1.0f + exp(-gg)));
}
"#;

    /// The split library source for one attention geometry; `p_f32`
    /// keeps the probabilities f32 for p.v (else bf16).
    pub(crate) fn render_split(nh: usize, nkv: usize, d: usize, p_f32: bool) -> String {
        format!(
            "#define TH_HN {nh}\n#define TH_HKV {nkv}\n#define TH_GRP {}\n\
             #define TH_DIM {d}\n#define TH_QROWS {}\n#define TH_PAGE {}\n\
             #define TH_SCALE {:.9e}f\n#define TH_P_F32 {}\n{SPLIT_SRC}",
            nh / nkv,
            super::SPLIT_QROWS,
            super::SPLIT_PAGE,
            1.0f64 / (d as f64).sqrt(),
            p_f32 as u32,
        )
    }

    /// Compile the split library (Metal 4 language: MPP tensor_ops).
    pub(crate) fn compile_split(
        raw: &candle_metal_kernels::metal::Device,
        nh: usize,
        nkv: usize,
        d: usize,
        p_f32: bool,
    ) -> Result<(ComputePipeline, ComputePipeline)> {
        let opts = objc2_metal::MTLCompileOptions::new();
        opts.setLanguageVersion(objc2_metal::MTLLanguageVersion::Version4_0);
        let lib = raw
            .new_library_with_source(&render_split(nh, nkv, d, p_f32), Some(&opts))
            .map_err(candle_core::Error::wrap)?;
        let mk = |n: &str| -> Result<ComputePipeline> {
            let f = lib.get_function(n, None).map_err(candle_core::Error::wrap)?;
            raw.new_compute_pipeline_state_with_function(&f)
                .map_err(candle_core::Error::wrap)
        };
        Ok((mk("attn_split_mpp")?, mk("attn_split_reduce")?))
    }

    /// The split kernel pair for one attention geometry.
    pub(crate) struct SplitPipes {
        pub part: ComputePipeline,
        pub reduce: ComputePipeline,
    }

    static SPLIT: GeomCache<Option<SplitPipes>> = GeomCache::new();

    /// Split pipelines, compiled once per attention geometry; `None` when
    /// the MPP library does not compile here (the caller keeps the
    /// single-pass kernel — logged once per geometry).
    pub(crate) fn split_pipes(
        device: &candle_core::MetalDevice,
        nh: usize,
        nkv: usize,
        d: usize,
    ) -> Option<&'static SplitPipes> {
        let p_f32 = super::split_cfg().p_f32;
        SPLIT
            .get((nh, nkv, d, p_f32 as usize), || {
                if nkv == 0 || nh % nkv != 0 || d % super::SPLIT_PAGE != 0 || d > 1024 {
                    eprintln!(
                        "[attn] split kernel: unsupported geometry nh={nh} nkv={nkv} d={d}; single-pass attention"
                    );
                    return None;
                }
                match compile_split(device.metal_device(), nh, nkv, d, p_f32) {
                    Ok((part, reduce)) => Some(SplitPipes { part, reduce }),
                    Err(e) => {
                        let m = e.to_string();
                        eprintln!(
                            "[attn] split kernel unavailable ({}); single-pass attention",
                            &m[..m.len().min(400)]
                        );
                        None
                    }
                }
            })
            .as_ref()
    }

    /// `TH_ATTN_SPLIT_SCRATCH=0` (read once): allocate the split partials
    /// per call from candle's pool (the A/B arm) instead of `split_scratch`.
    fn split_scratch_on() -> bool {
        static ON: OnceLock<bool> = OnceLock::new();
        *ON.get_or_init(|| std::env::var("TH_ATTN_SPLIT_SCRATCH").map_or(true, |v| v.trim() != "0"))
    }

    type Scratch = (candle_core::metal_backend::DeviceId, usize, usize, std::sync::Arc<Buffer>, std::sync::Arc<Buffer>);

    /// The split kernel's f32 partials + (max, sum) workspace, persistent
    /// per thread and device. Both are written by the partial dispatch and
    /// read by the reduce inside one `attn_decode_split` call, so one pair
    /// serves every layer: the next layer's write after this layer's read
    /// is the same buffer reuse candle's pool already makes within a
    /// forward (ordered by its hazard tracking). Held here (Arc count > 1),
    /// the buffers survive candle's pool trim at every host sync, so a
    /// decode round no longer re-creates 32 of them per verify after each
    /// sync (fresh allocations + residency-set commits: +1 ms/round of
    /// host encode at 1.45k and +3-10 ms at 8k, th/d-longctx sZ). Grows to
    /// the largest request seen.
    fn split_scratch(
        device: &candle_core::MetalDevice,
        acc_elems: usize,
        ml_elems: usize,
    ) -> Result<(std::sync::Arc<Buffer>, std::sync::Arc<Buffer>)> {
        if !split_scratch_on() {
            return Ok((
                device.new_buffer(acc_elems, DType::F32, "attn_split.acc")?,
                device.new_buffer(ml_elems, DType::F32, "attn_split.ml")?,
            ));
        }
        thread_local! {
            static S: std::cell::RefCell<Option<Scratch>> = const { std::cell::RefCell::new(None) };
        }
        S.with(|s| {
            let mut s = s.borrow_mut();
            if let Some((id, a, m, pa, pm)) = s.as_ref() {
                if *id == device.id() && *a >= acc_elems && *m >= ml_elems {
                    return Ok((pa.clone(), pm.clone()));
                }
            }
            let (a, m) = match s.as_ref() {
                Some((id, a, m, _, _)) if *id == device.id() => ((*a).max(acc_elems), (*m).max(ml_elems)),
                _ => (acc_elems, ml_elems),
            };
            let pa = device.new_buffer(a, DType::F32, "attn_split.acc")?;
            let pm = device.new_buffer(m, DType::F32, "attn_split.ml")?;
            *s = Some((device.id(), a, m, pa.clone(), pm.clone()));
            Ok((pa, pm))
        })
    }

    #[repr(C)]
    pub(crate) struct SplitParams {
        pub visible: u32,
        pub causal_base: u32,
        pub active_rows: u32,
        pub splits: u32,
        pub khs: u32,
        pub kts: u32,
        pub vhs: u32,
        pub vts: u32,
        pub qkv_stride: u32,
        pub _pad: [u32; 3],
    }

    /// Split-key decode attention (N3): same result contract as
    /// `attn_decode` — `out[r, h*d + c]` ([seq, nh*d]) = gated softmax
    /// attention of row r over keys [0, pos + r] — with q in the
    /// KV-head-major tile layout `q_kv` = [nkv][SPLIT_QROWS][nh/nkv][d]
    /// (from `attn_prepare(.., qrows = SPLIT_QROWS)`). The caches must
    /// hold `ceil((pos+seq)/32) * 32` rows (full pages are read; rows
    /// past pos+seq are masked). Partials come from candle's pool.
    #[allow(clippy::too_many_arguments)]
    pub fn attn_decode_split(
        q_kv: &Tensor,
        k_cache: &Tensor,
        v_cache: &Tensor,
        qkv: &Tensor,
        out: &Tensor,
        pos: usize,
        seq: usize,
        nh: usize,
        nkv: usize,
        d: usize,
        splits: usize,
    ) -> Result<()> {
        use super::{SPLIT_MAX, SPLIT_PAGE, SPLIT_QROWS};
        let (s_q, l_q) = qkv.storage_and_layout();
        let Storage::Metal(s_q) = &*s_q else {
            candle_core::bail!("attn_decode_split: non-Metal qkv")
        };
        use candle_core::backend::BackendStorage;
        let device = s_q.device();
        let Some(sp) = split_pipes(device, nh, nkv, d) else {
            candle_core::bail!("attn_decode_split: split pipelines unavailable")
        };
        let visible = pos + seq;
        let pages = visible.div_ceil(SPLIT_PAGE);
        if seq == 0 || seq > SPLIT_QROWS || splits == 0 || splits > SPLIT_MAX {
            candle_core::bail!("attn_decode_split: seq {seq} splits {splits}");
        }
        if k_cache.dim(1)? < pages * SPLIT_PAGE || v_cache.dim(1)? < pages * SPLIT_PAGE {
            candle_core::bail!(
                "attn_decode_split: cache {} rows < {} (full pages)",
                k_cache.dim(1)?,
                pages * SPLIT_PAGE
            );
        }
        let grp = nh / nkv;
        let m = SPLIT_QROWS * grp;
        if q_kv.elem_count() < nkv * m * d || !q_kv.is_contiguous() {
            candle_core::bail!("attn_decode_split: q_kv {:?}", q_kv.shape());
        }
        let k_st = k_cache.stride();
        let v_st = v_cache.stride();
        if k_st[2] != 1 || v_st[2] != 1 {
            candle_core::bail!("attn_decode_split: kv cache inner dim must be contiguous");
        }
        let (pacc, pml) = split_scratch(device, nkv * splits * m * d, nkv * splits * m * 2)?;
        let params = SplitParams {
            visible: visible as u32,
            causal_base: pos as u32,
            active_rows: seq as u32,
            splits: splits as u32,
            khs: k_st[0] as u32,
            kts: k_st[1] as u32,
            vhs: v_st[0] as u32,
            vts: v_st[1] as u32,
            qkv_stride: l_q.stride()[l_q.shape().dims().len() - 2] as u32,
            _pad: [0; 3],
        };
        let (qb_b, qb_o) = msl_buf(q_kv, 2)?;
        let (kc_b, kc_o) = msl_buf(k_cache, 2)?;
        let (vc_b, vc_o) = msl_buf(v_cache, 2)?;
        let (ot_b, ot_o) = msl_buf(out, 2)?;
        let encoder =
            device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("attn_decode_split");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(&sp.part);
        enc.set_input_buffer(0, Some(&qb_b), qb_o as _);
        enc.set_input_buffer(1, Some(&kc_b), kc_o as _);
        enc.set_input_buffer(2, Some(&vc_b), vc_o as _);
        enc.set_output_buffer(3, Some(&pacc), 0);
        enc.set_output_buffer(4, Some(&pml), 0);
        enc.set_bytes(5, &params);
        enc.dispatch_thread_groups(
            MTLSize { width: nkv, height: splits, depth: 1 },
            MTLSize { width: 256, height: 1, depth: 1 },
        );
        enc.set_compute_pipeline_state(&sp.reduce);
        enc.set_input_buffer(0, Some(&pacc), 0);
        enc.set_input_buffer(1, Some(&pml), 0);
        enc.set_input_buffer(
            2,
            Some(s_q.buffer()),
            l_q.start_offset() * DType::BF16.size_in_bytes(),
        );
        enc.set_output_buffer(3, Some(&ot_b), ot_o as _);
        enc.set_bytes(4, &params);
        enc.dispatch_thread_groups(
            MTLSize { width: nkv, height: seq * grp, depth: 1 },
            MTLSize { width: d, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(())
    }

    /// The split count for this call, or `None` for the single-pass
    /// kernel: the routing policy (`split_for`), the full-page capacity
    /// guard, and the pipelines' availability.
    pub fn split_plan(
        device: &candle_core::Device,
        pos: usize,
        seq: usize,
        cap: usize,
        nh: usize,
        nkv: usize,
        d: usize,
    ) -> Option<usize> {
        let visible = pos + seq;
        let s = super::split_for(&super::split_cfg(), visible)?;
        if seq == 0 || seq > super::SPLIT_QROWS
            || cap < visible.div_ceil(super::SPLIT_PAGE) * super::SPLIT_PAGE
        {
            return None;
        }
        match device {
            candle_core::Device::Metal(md) => split_pipes(md, nh, nkv, d).map(|_| s),
            _ => None,
        }
    }

    // ------------------------------------------------------------------
    // E1: fused causal prefill attention (Metal 4 / MPP NAX fragments)
    // ------------------------------------------------------------------

    /// Flash-style causal attention for prefill chunks (> 8 query rows).
    /// Structure after MLX's `attention_nax_dsplit` (steel/attn,
    /// mlx 0.32.2, Copyright © 2024-25 Apple Inc., MIT): register-resident
    /// 16x16 fragments fed to per-simdgroup MPP `matmul2d` (16x32x16,
    /// cooperative-tensor operands), BK = 32 keys per block, the head dim
    /// split across a pair of simdgroups (each owns 128 of 256 channels for
    /// q.k and p.v; the pair adds its partial q.k scores through
    /// threadgroup memory — a + b == b + a, so both halves see identical
    /// scores and row statistics), online softmax in f32 (exp2 with the
    /// log2(e) folded into the scale), f32 scores, row statistics and
    /// accumulators, f16 probabilities for p.v (scaled by 2^15; a strict
    /// f32 left operand does not take this fragment layout — see
    /// `nax_fragment_mma_matches_cpu`), bf16 in/out. Changes vs MLX:
    /// GQA-fused rows (`PA_GQA`: a
    /// threadgroup runs 16*WM fused rows (query row, q head of the group)
    /// of one KV head, so the group's six heads share every K/V fragment
    /// load), the causal limit per fused row with the chunk's query offset
    /// (`pos`), strided K/V straight from the model's caches (head- or
    /// time-major, inner dim contiguous; rows >= kv are never loaded), the
    /// output written as `[seq, HN*D]` rows, and the sigmoid output gate
    /// optionally fused into the epilogue (`PA_GATE`, as `attn_decode`).
    /// Deterministic: a row's key blocks are the absolute 32-key blocks
    /// 0..=(pos+row)/32 in order, whatever query tile holds it; blocks past
    /// a row's limit are masked to exact zeros.
    const PREFILL_SRC: &str = r#"
#include <MetalPerformancePrimitives/MetalPerformancePrimitives.h>
#include <metal_simdgroup>
#include <metal_stdlib>
using namespace metal;

struct PrefillAttnParams {
    int seq;    // query rows of the chunk
    int pos;    // absolute position of query row 0: row r sees keys [0, pos + r]
    int kv;     // pos + seq: rows of K/V that may be read
    int rows;   // fused rows: seq * GRP (GQA) or seq (per head)
    int q_hs;   // q element strides: head, row (inner dim contiguous)
    int q_ts;
    int k_hs;   // cache element strides: head, time
    int k_ts;
    int v_hs;
    int v_ts;
    int o_ts;   // out row stride (HN * D)
    int g_ts;   // gate source (packed qkv) row stride, PA_GATE only
};

constant constexpr float PA_NEG = -3.402823466e+38f; // lowest finite f32 (MLX finite_min)

constant constexpr float PA_PSCALE = 32768.0f;

typedef vec<float, 8> pa_ffrag;
typedef vec<bfloat, 8> pa_bfrag;
typedef vec<half, 8> pa_hfrag;

// NAX 16x16 fragment lane map (MLX BaseNAXFrag::get_coord): a lane holds
// rows fm and fm + 8, columns fn .. fn + 3.
inline short2 pa_coord(ushort lane) {
    const short qid = lane >> 2;
    const short fm = (qid & 4) | ((lane >> 1) & 3);
    const short fn = ((qid & 2) | (lane & 1)) * 4;
    return short2(fn, fm);
}

// C[16 x 32] += A[16 x 16] * B[16 x 32] on one simdgroup (B given as two
// 16x16 fragments; TB: B fragments are [n][k], i.e. B transposed).
template <typename CT, typename AT, typename BT, bool TB>
inline void pa_mma(thread vec<CT, 8>& c0, thread vec<CT, 8>& c1,
                   thread const vec<AT, 8>& a,
                   thread const vec<BT, 8>& b0, thread const vec<BT, 8>& b1) {
    constexpr auto desc = mpp::tensor_ops::matmul2d_descriptor(
        16, 32, 16, false, TB, PA_RELAXED,
        mpp::tensor_ops::matmul2d_descriptor::mode::multiply_accumulate);
    mpp::tensor_ops::matmul2d<desc, execution_simdgroup> op;
    auto ca = op.template get_left_input_cooperative_tensor<AT, BT, CT>();
    auto cb = op.template get_right_input_cooperative_tensor<AT, BT, CT>();
    auto cc = op.template get_destination_cooperative_tensor<
        metal::remove_addrspace_t<decltype(ca)>,
        metal::remove_addrspace_t<decltype(cb)>, CT>();
#pragma unroll
    for (short i = 0; i < 8; i++) ca[i] = a[i];
#pragma unroll
    for (short i = 0; i < 8; i++) { cb[i] = b0[i]; cb[8 + i] = b1[i]; }
#pragma unroll
    for (short i = 0; i < 8; i++) { cc[i] = c0[i]; cc[8 + i] = c1[i]; }
    op.run(ca, cb, cc);
#pragma unroll
    for (short i = 0; i < 8; i++) { c0[i] = cc[i]; c1[i] = cc[8 + i]; }
}

// 16 rows x 16 columns of a row-major bf16 matrix at `src` (row stride
// `ld`, column offset `c`), rows at or past `nrows` read as zero.
inline void pa_load(thread pa_bfrag& dst, device const bfloat* src, int ld,
                    short sm, short sn, int c, int nrows) {
#pragma unroll
    for (short i = 0; i < 2; i++) {
        const int r = sm + i * 8;
        device const bfloat* p = src + long(r) * ld + c + sn;
#pragma unroll
        for (short j = 0; j < 4; j++)
            dst[i * 4 + j] = r < nrows ? p[j] : bfloat(0.0f);
    }
}

inline void pa_load_full(thread pa_bfrag& dst, device const bfloat* src, int ld,
                         short sm, short sn, int c) {
#pragma unroll
    for (short i = 0; i < 2; i++) {
        device const bfloat* p = src + long(sm + i * 8) * ld + c + sn;
#pragma unroll
        for (short j = 0; j < 4; j++) dst[i * 4 + j] = p[j];
    }
}

// grid (query blocks, HKV [GQA] | HN) x (WM * 64) threads.
//   PA_BK      keys per block (32 | 64)
//   PA_XBUF    double-buffered score exchange: one barrier per block
//   PA_SKIPRS  skip the O rescale of a row whose max did not move (the
//              factor is then exactly 1.0: same bits)
//   PA_QRES    1: q half resident in registers (MLX dsplit); 0: re-read
//              from L1 per block (same values, fewer live registers)
[[kernel, max_total_threads_per_threadgroup(PA_WM * 64)]]
void prefill_attn(
    device const bfloat* Q      [[buffer(0)]],
    device const bfloat* K      [[buffer(1)]],
    device const bfloat* V      [[buffer(2)]],
    device bfloat* O            [[buffer(3)]],
    device const bfloat* G      [[buffer(4)]],
    constant PrefillAttnParams& p [[buffer(5)]],
    ushort lane [[thread_index_in_simdgroup]],
    ushort sg   [[simdgroup_index_in_threadgroup]],
    uint2 tid   [[threadgroup_position_in_grid]])
{
    constexpr int BQ = PA_WM * 16;   // fused rows per threadgroup
    constexpr int BK = PA_BK;        // keys per block
    constexpr int TK = BK / 16;      // 16-key score fragments per block
    constexpr int DH = PA_D / 2;     // channels per simdgroup of a pair
    constexpr int TDH = DH / 16;     // 16-channel fragments per half
    static_assert(TDH % 2 == 0 && TK % 2 == 0, "fragment pairs");

    const short rg = sg >> 1;        // row group (16 fused rows)
    const short dh = sg & 1;         // head-dim half
    const short2 sc = pa_coord(lane);
    const short sm = sc.y, sn = sc.x;

    // the threadgroup's fused rows [f0, f1) -> query rows [qmin, qmax]
    const int f0 = int(tid.x) * BQ;
    const int f1 = min(p.rows, f0 + BQ);
#if PA_GQA
    const int kvh = int(tid.y);
    const int qmin = f0 / PA_GRP, qmax = (f1 - 1) / PA_GRP;
#else
    const int kvh = int(tid.y) / PA_GRP;
    const int qmin = f0, qmax = f1 - 1;
#endif
    // key blocks: [0, kb_lim) visible to some row; below kb_min every key
    // is visible to every row of the threadgroup (no causal mask needed)
    const int kb_lim = (p.pos + qmax) / BK + 1;
    const int kb_min = (p.pos + qmin) / BK;

    // this thread's two rows (fm, fm + 8 of its simdgroup's 16)
    int head[2], qrow[2], lim[2];
    bool valid[2];
#pragma unroll
    for (short i = 0; i < 2; i++) {
        const int f = f0 + rg * 16 + sm + i * 8;
#if PA_GQA
        qrow[i] = f / PA_GRP;
        head[i] = kvh * PA_GRP + (f - qrow[i] * PA_GRP);
#else
        qrow[i] = f;
        head[i] = int(tid.y);
#endif
        valid[i] = f < p.rows;
        // last visible key; padding rows (never stored) see what the
        // threadgroup's last row sees
        lim[i] = p.pos + (valid[i] ? qrow[i] : qmax);
    }

    // this thread's two q row pointers (padding rows read row 0: finite,
    // never stored)
    device const bfloat* qp[2];
#pragma unroll
    for (short i = 0; i < 2; i++)
        qp[i] = Q + (valid[i] ? long(head[i]) * p.q_hs + long(qrow[i]) * p.q_ts : 0) + dh * DH + sn;
#if PA_QRES
    // q half resident in registers for the whole key loop
    pa_bfrag Qt[TDH];
#pragma unroll
    for (short i = 0; i < 2; i++) {
#pragma unroll
        for (short id = 0; id < TDH; id++) {
#pragma unroll
            for (short j = 0; j < 4; j++)
                Qt[id][i * 4 + j] = valid[i] ? qp[i][id * 16 + j] : bfloat(0.0f);
        }
    }
#endif

    pa_ffrag Ot[TDH];
#pragma unroll
    for (short id = 0; id < TDH; id++) Ot[id] = pa_ffrag(0.0f);
    float mx[2] = {PA_NEG, PA_NEG};
    float sum[2] = {0.0f, 0.0f};

    threadgroup float xchg[PA_XBUF ? 2 : 1][PA_WM][2][TK * 8 * 32];

    device const bfloat* Kh = K + long(kvh) * p.k_hs + dh * DH;
    device const bfloat* Vh = V + long(kvh) * p.v_hs + dh * DH;

    for (int kb = 0; kb < kb_lim; kb++) {
        const int k0 = kb * BK;
        const int nk = p.kv - k0;          // rows readable in this block
        const bool full = nk >= BK;
        device const bfloat* Kb = Kh + long(k0) * p.k_ts;
        device const bfloat* Vb = Vh + long(k0) * p.v_ts;

        // S = q . k^T over this half of the head dim
        pa_ffrag S[TK];
#pragma unroll
        for (short f = 0; f < TK; f++) S[f] = pa_ffrag(0.0f);
#pragma unroll
        for (short ik = 0; ik < TK; ik += 2) {
            device const bfloat* kr0 = Kb + long(ik * 16) * p.k_ts;
            device const bfloat* kr1 = Kb + long(ik * 16 + 16) * p.k_ts;
#pragma unroll
            for (short id = 0; id < TDH; id++) {
                pa_bfrag K0, K1;
                if (full) {
                    pa_load_full(K0, kr0, p.k_ts, sm, sn, id * 16);
                    pa_load_full(K1, kr1, p.k_ts, sm, sn, id * 16);
                } else {
                    pa_load(K0, kr0, p.k_ts, sm, sn, id * 16, nk - ik * 16);
                    pa_load(K1, kr1, p.k_ts, sm, sn, id * 16, nk - ik * 16 - 16);
                }
#if PA_QRES
                pa_mma<float, bfloat, bfloat, true>(S[ik], S[ik + 1], Qt[id], K0, K1);
#else
                // q re-read per block from L1 (32 fewer live registers)
                pa_bfrag qf;
#pragma unroll
                for (short i = 0; i < 2; i++) {
#pragma unroll
                    for (short j = 0; j < 4; j++) qf[i * 4 + j] = valid[i] ? qp[i][id * 16 + j] : bfloat(0.0f);
                }
                pa_mma<float, bfloat, bfloat, true>(S[ik], S[ik + 1], qf, K0, K1);
#endif
            }
        }
        // add the peer half's partial scores (same lane map)
        threadgroup float* mine = xchg[PA_XBUF ? (kb & 1) : 0][rg][dh];
        threadgroup const float* peer = xchg[PA_XBUF ? (kb & 1) : 0][rg][1 - dh];
#pragma unroll
        for (short f = 0; f < TK; f++) {
#pragma unroll
            for (short i = 0; i < 8; i++) mine[lane * (TK * 8) + f * 8 + i] = S[f][i];
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
#pragma unroll
        for (short f = 0; f < TK; f++) {
#pragma unroll
            for (short i = 0; i < 8; i++) S[f][i] += peer[lane * (TK * 8) + f * 8 + i];
        }
#if !PA_XBUF
        threadgroup_barrier(mem_flags::mem_threadgroup);
#endif

#pragma unroll
        for (short f = 0; f < TK; f++) S[f] *= PA_SCALE2;
        if (kb >= kb_min) {
#pragma unroll
            for (short i = 0; i < 2; i++) {
#pragma unroll
                for (short f = 0; f < TK; f++) {
#pragma unroll
                    for (short j = 0; j < 4; j++)
                        if (k0 + f * 16 + sn + j > lim[i]) S[f][i * 4 + j] = PA_NEG;
                }
            }
        }

        // online softmax (MLX row_reduce order: 4 elements, xor 1, xor 8,
        // fragments in key order)
#pragma unroll
        for (short i = 0; i < 2; i++) {
            float nmax = mx[i];
#pragma unroll
            for (short f = 0; f < TK; f++) {
                float m = max(max(S[f][i * 4], S[f][i * 4 + 1]), max(S[f][i * 4 + 2], S[f][i * 4 + 3]));
                m = max(m, simd_shuffle_xor(m, ushort(1)));
                m = max(m, simd_shuffle_xor(m, ushort(8)));
                nmax = max(nmax, m);
            }
            const float factor = fast::exp2(mx[i] - nmax);
            mx[i] = nmax;
            float rs = sum[i] * factor;
#pragma unroll
            for (short f = 0; f < TK; f++) {
#pragma unroll
                for (short j = 0; j < 4; j++) S[f][i * 4 + j] = fast::exp2(S[f][i * 4 + j] - nmax);
                float s = (S[f][i * 4] + S[f][i * 4 + 1]) + (S[f][i * 4 + 2] + S[f][i * 4 + 3]);
                s += simd_shuffle_xor(s, ushort(1));
                s += simd_shuffle_xor(s, ushort(8));
                rs += s;
            }
            sum[i] = rs;
#if PA_SKIPRS
            if (factor != 1.0f)
#endif
            {
#pragma unroll
                for (short id = 0; id < TDH; id++) {
#pragma unroll
                    for (short j = 0; j < 4; j++) Ot[id][i * 4 + j] *= factor;
                }
            }
        }
        // p.v operand: f16 probabilities scaled by 2^15 (PA_PSCALE) so a
        // probability down to 2^-29 of the row max stays a normal f16 (the
        // f32 row sums above use the unrounded values; the scale folds
        // exactly into the final reciprocal). A strict f32 left operand
        // does not take this fragment layout (garbage) and a relaxed one
        // rounds to ~f16 anyway (nax_fragment_mma_matches_cpu).
        pa_hfrag P[TK];
#pragma unroll
        for (short f = 0; f < TK; f++) {
#pragma unroll
            for (short k = 0; k < 8; k++) P[f][k] = half(S[f][k] * PA_PSCALE);
        }
        simdgroup_barrier(mem_flags::mem_none);

        // O += P . V over this half of the head dim
#pragma unroll
        for (short id = 0; id < TDH; id += 2) {
#pragma unroll
            for (short ik = 0; ik < TK; ik++) {
                pa_bfrag V0, V1;
                device const bfloat* vr = Vb + long(ik * 16) * p.v_ts;
                if (full) {
                    pa_load_full(V0, vr, p.v_ts, sm, sn, id * 16);
                    pa_load_full(V1, vr, p.v_ts, sm, sn, id * 16 + 16);
                } else {
                    pa_load(V0, vr, p.v_ts, sm, sn, id * 16, nk - ik * 16);
                    pa_load(V1, vr, p.v_ts, sm, sn, id * 16 + 16, nk - ik * 16);
                }
                pa_mma<float, half, bfloat, false>(Ot[id], Ot[id + 1], P[ik], V0, V1);
            }
        }
    }

#pragma unroll
    for (short i = 0; i < 2; i++) {
        if (!valid[i]) continue;
        const float rcp = 1.0f / (sum[i] * PA_PSCALE);
        device bfloat* op = O + long(qrow[i]) * p.o_ts + head[i] * PA_D + dh * DH + sn;
#if PA_GATE
        device const bfloat* gp =
            G + long(qrow[i]) * p.g_ts + head[i] * 2 * PA_D + PA_D + dh * DH + sn;
#endif
#pragma unroll
        for (short id = 0; id < TDH; id++) {
#pragma unroll
            for (short j = 0; j < 4; j++) {
                float v = Ot[id][i * 4 + j] * rcp;
#if PA_GATE
                v = v / (1.0f + exp(-float(gp[id * 16 + j])));
#endif
                op[id * 16 + j] = bfloat(v);
            }
        }
    }
}
"#;

    /// Compile-time shape of the prefill kernel (one pipeline each).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct PrefillVariant {
        /// GQA-fused rows (else one q head per threadgroup, MLX's layout).
        pub gqa: bool,
        /// MPP relaxed precision for both matmuls.
        pub relaxed: bool,
        /// Sigmoid output gate fused into the epilogue.
        pub gate: bool,
        /// Row groups (16 fused rows each) per threadgroup: 1, 2 or 4.
        pub wm: usize,
        /// Keys per block: 32 or 64.
        pub bk: usize,
        /// Double-buffered score exchange (one barrier per block).
        pub xbuf: bool,
        /// Skip the O rescale of rows whose max did not move (exact).
        pub skiprs: bool,
        /// Re-read q from L1 per block instead of holding it in registers.
        pub qreload: bool,
    }

    impl PrefillVariant {
        /// The shipped default (`TH_PREFILL_ATTN_VARIANT` unset): `g2q`.
        pub const DEFAULT: PrefillVariant = PrefillVariant {
            gqa: true, relaxed: false, gate: true, wm: 2, bk: 32, xbuf: false, skiprs: false, qreload: true,
        };

        fn key(&self) -> usize {
            (self.gqa as usize)
                | (self.relaxed as usize) << 1
                | (self.gate as usize) << 2
                | (self.xbuf as usize) << 3
                | (self.skiprs as usize) << 5
                | (self.qreload as usize) << 6
                | self.wm << 8
                | self.bk << 12
        }

        /// Parse a variant name: `g`|`ph` (GQA-fused | per-head rows), the
        /// row-group digit (1|2|4), then any of `r` (relaxed), `k64` (BK
        /// 64), `x` (double-buffered exchange), `s` (skip unit rescales),
        /// `q` (re-read q per block), `n` (unfused gate). `g2q` = DEFAULT:
        /// re-reading q from L1 (32 fewer live registers) is ~15 % faster
        /// over a whole cold prefill on the M5 Max than holding it (`g2`,
        /// the 70409a9 kernel) and bitwise equal to it; the other shapes did
        /// not pay (report th-e-prefill-attn §2.2) and stay selectable.
        pub fn parse(name: &str) -> Option<PrefillVariant> {
            let name = name.trim();
            let (gqa, rest) = match name.strip_prefix("ph") {
                Some(r) => (false, r),
                None => (true, name.strip_prefix('g')?),
            };
            let wm = rest.chars().next()?.to_digit(10)? as usize;
            let rest = &rest[1..];
            let bk = if rest.contains("k64") { 64 } else { 32 };
            let rest = rest.replace("k64", "");
            Some(PrefillVariant {
                gqa,
                relaxed: rest.contains('r'),
                gate: !rest.contains('n'),
                wm,
                bk,
                xbuf: rest.contains('x'),
                skiprs: rest.contains('s'),
                qreload: rest.contains('q'),
            })
        }
    }

    /// The prefill library source for one attention geometry + variant.
    pub(crate) fn render_prefill(nh: usize, nkv: usize, d: usize, v: PrefillVariant) -> String {
        format!(
            "#define PA_HN {nh}\n#define PA_HKV {nkv}\n#define PA_GRP {}\n#define PA_D {d}\n\
             #define PA_WM {}\n#define PA_GQA {}\n#define PA_RELAXED {}\n#define PA_GATE {}\n\
             #define PA_BK {}\n#define PA_XBUF {}\n#define PA_SKIPRS {}\n#define PA_QRES {}\n\
             #define PA_SCALE2 {:.9e}f\n{PREFILL_SRC}",
            nh / nkv,
            v.wm,
            v.gqa as u32,
            if v.relaxed { "true" } else { "false" },
            v.gate as u32,
            v.bk,
            v.xbuf as u32,
            v.skiprs as u32,
            !v.qreload as u32,
            std::f64::consts::LOG2_E / (d as f64).sqrt(),
        )
    }

    /// Compile the prefill kernel (Metal 4 language: MPP tensor_ops with
    /// cooperative-tensor operands).
    pub(crate) fn compile_prefill(
        raw: &candle_metal_kernels::metal::Device,
        nh: usize,
        nkv: usize,
        d: usize,
        v: PrefillVariant,
    ) -> Result<ComputePipeline> {
        let opts = objc2_metal::MTLCompileOptions::new();
        opts.setLanguageVersion(objc2_metal::MTLLanguageVersion::Version4_0);
        let lib = raw
            .new_library_with_source(&render_prefill(nh, nkv, d, v), Some(&opts))
            .map_err(candle_core::Error::wrap)?;
        let f = lib.get_function("prefill_attn", None).map_err(candle_core::Error::wrap)?;
        raw.new_compute_pipeline_state_with_function(&f).map_err(candle_core::Error::wrap)
    }

    static PREFILL: GeomCache<Option<ComputePipeline>> = GeomCache::new();

    /// Geometries the prefill kernel serves: head dim 256 (the fragment
    /// loop is built for 2 x 8 16-channel fragments), GQA groups up to 16.
    pub fn prefill_supported(nh: usize, nkv: usize, d: usize) -> bool {
        nkv > 0 && nh % nkv == 0 && nh / nkv <= 16 && d == 256
    }

    /// The prefill pipeline for one geometry + variant, compiled once;
    /// `None` when unsupported or the library does not compile here (the
    /// caller keeps the eager attention — logged once per key).
    pub(crate) fn prefill_pipe(
        device: &candle_core::MetalDevice,
        nh: usize,
        nkv: usize,
        d: usize,
        v: PrefillVariant,
    ) -> Option<&'static ComputePipeline> {
        PREFILL
            .get((nh, nkv, d, v.key()), || {
                if !prefill_supported(nh, nkv, d)
                    || !matches!(v.wm, 1 | 2 | 4)
                    || !matches!(v.bk, 32 | 64)
                {
                    eprintln!("[attn] prefill kernel: unsupported nh={nh} nkv={nkv} d={d} {v:?}; eager attention");
                    return None;
                }
                match compile_prefill(device.metal_device(), nh, nkv, d, v) {
                    Ok(p) => Some(p),
                    Err(e) => {
                        let m = e.to_string();
                        eprintln!("[attn] prefill kernel unavailable ({}); eager attention", &m[..m.len().min(600)]);
                        None
                    }
                }
            })
            .as_ref()
    }

    #[repr(C)]
    struct PrefillParams {
        seq: i32,
        pos: i32,
        kv: i32,
        rows: i32,
        q_hs: i32,
        q_ts: i32,
        k_hs: i32,
        k_ts: i32,
        v_hs: i32,
        v_ts: i32,
        o_ts: i32,
        g_ts: i32,
    }

    /// Fused causal prefill attention: `q` [1, nh, seq, d] (post-rope,
    /// inner dim contiguous), `k`/`v` [nkv, >= pos+seq, d] (any head/time
    /// strides, inner dim contiguous; rows >= pos+seq are never read) →
    /// `[seq, nh*d]` bf16, row r attending keys [0, pos + r]. With
    /// `v.gate` the sigmoid of `gate`'s gate lanes (packed qkv [1, seq, _],
    /// q head h's gate at h*2d + d) is applied (else the caller gates).
    #[allow(clippy::too_many_arguments)]
    pub fn attn_prefill(
        q: &Tensor,
        k: &Tensor,
        v: &Tensor,
        gate: Option<&Tensor>,
        pos: usize,
        seq: usize,
        nh: usize,
        nkv: usize,
        d: usize,
        var: PrefillVariant,
    ) -> Result<Tensor> {
        let (s_q, l_q) = q.storage_and_layout();
        let Storage::Metal(s_q) = &*s_q else {
            candle_core::bail!("attn_prefill: non-Metal q")
        };
        use candle_core::backend::BackendStorage;
        let device = s_q.device();
        let Some(pipe) = prefill_pipe(device, nh, nkv, d, var) else {
            candle_core::bail!("attn_prefill: pipeline unavailable")
        };
        let kv = pos + seq;
        let qd = q.dims();
        if qd.len() != 4 || qd[0] != 1 || qd[1] != nh || qd[2] != seq || qd[3] != d {
            candle_core::bail!("attn_prefill: q {:?}", q.shape());
        }
        let (q_st, k_st, v_st) = (l_q.stride(), k.stride(), v.stride());
        if q_st[3] != 1 || k_st[2] != 1 || v_st[2] != 1 {
            candle_core::bail!("attn_prefill: inner dims must be contiguous");
        }
        if k.dim(0)? != nkv || v.dim(0)? != nkv || k.dim(1)? < kv || v.dim(1)? < kv || k.dim(2)? != d {
            candle_core::bail!("attn_prefill: k {:?} v {:?} for {kv} keys", k.shape(), v.shape());
        }
        if var.gate != gate.is_some() {
            candle_core::bail!("attn_prefill: gate operand mismatch");
        }
        for t in [k, v] {
            if t.dtype() != DType::BF16 {
                candle_core::bail!("attn_prefill: bf16 only");
            }
        }
        if q.dtype() != DType::BF16 {
            candle_core::bail!("attn_prefill: bf16 only");
        }
        let grp = nh / nkv;
        let rows = if var.gqa { seq * grp } else { seq };
        let bq = 16 * var.wm;
        // every (row, head, channel) is written once (grid covers all rows)
        let out = crate::outbuf::kernel_out((seq, nh * d), DType::BF16, q.device())?;
        let (g_b, g_o, g_ts) = match gate {
            Some(g) => {
                let (b, o) = msl_buf(g, 2)?;
                let gl = g.layout();
                if gl.stride().last() != Some(&1) {
                    candle_core::bail!("attn_prefill: gate inner dim must be contiguous");
                }
                (Some(b), o, gl.stride()[gl.shape().dims().len() - 2])
            }
            None => (None, 0, 0),
        };
        let params = PrefillParams {
            seq: seq as i32,
            pos: pos as i32,
            kv: kv as i32,
            rows: rows as i32,
            q_hs: q_st[1] as i32,
            q_ts: q_st[2] as i32,
            k_hs: k_st[0] as i32,
            k_ts: k_st[1] as i32,
            v_hs: v_st[0] as i32,
            v_ts: v_st[1] as i32,
            o_ts: (nh * d) as i32,
            g_ts: g_ts as i32,
        };
        let (kb_b, kb_o) = msl_buf(k, 2)?;
        let (vb_b, vb_o) = msl_buf(v, 2)?;
        let (ob_b, ob_o) = msl_buf(&out, 2)?;
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("attn_prefill");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder = enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(pipe);
        enc.set_input_buffer(0, Some(s_q.buffer()), l_q.start_offset() * 2);
        enc.set_input_buffer(1, Some(&kb_b), kb_o as _);
        enc.set_input_buffer(2, Some(&vb_b), vb_o as _);
        enc.set_output_buffer(3, Some(&ob_b), ob_o as _);
        // unused without the gate: bind q again (never read)
        match &g_b {
            Some(b) => enc.set_input_buffer(4, Some(b), g_o as _),
            None => enc.set_input_buffer(4, Some(s_q.buffer()), 0),
        }
        enc.set_bytes(5, &params);
        enc.dispatch_thread_groups(
            MTLSize { width: rows.div_ceil(bq), height: if var.gqa { nkv } else { nh }, depth: 1 },
            MTLSize { width: 64 * var.wm, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(out)
    }
}

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::{
    attn_decode, attn_decode_split, attn_prefill, attn_prepare, prefill_supported, split_plan, PrefillVariant,
};

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
        _: usize,
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

    #[allow(clippy::too_many_arguments)]
    pub fn attn_decode_split(
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
        candle_core::bail!("attn_decode_split: Metal only")
    }

    pub fn split_plan(
        _: &candle_core::Device,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
    ) -> Option<usize> {
        None
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct PrefillVariant {
        pub gqa: bool,
        pub relaxed: bool,
        pub gate: bool,
        pub wm: usize,
        pub bk: usize,
        pub xbuf: bool,
        pub skiprs: bool,
        pub qreload: bool,
    }

    impl PrefillVariant {
        pub const DEFAULT: PrefillVariant = PrefillVariant {
            gqa: true, relaxed: false, gate: true, wm: 2, bk: 32, xbuf: false, skiprs: false, qreload: true,
        };

        pub fn parse(_: &str) -> Option<PrefillVariant> {
            None
        }
    }

    pub fn prefill_supported(_: usize, _: usize, _: usize) -> bool {
        false
    }

    #[allow(clippy::too_many_arguments)]
    pub fn attn_prefill(
        _: &Tensor,
        _: &Tensor,
        _: &Tensor,
        _: Option<&Tensor>,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
        _: PrefillVariant,
    ) -> Result<Tensor> {
        candle_core::bail!("attn_prefill: Metal only")
    }
}

#[cfg(not(all(feature = "metal", target_os = "macos")))]
pub use stub::{
    attn_decode, attn_decode_split, attn_prefill, attn_prepare, prefill_supported, split_plan, PrefillVariant,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_count_policy() {
        // (visible, base, pps) -> splits; pages = ceil(visible / 32)
        let cases = [
            (1usize, 16usize, 8usize, 1usize), // one page
            (100, 16, 8, 4),                   // capped at the page count
            (512, 16, 8, 16),                  // 16 pages, base 16
            (2048, 16, 8, 16),                 // 64 pages / 8 = 8 < base
            (8192, 16, 8, 32),                 // 256 pages / 8
            (32768, 16, 8, 128),               // 1024 / 8 = 128 = max
            (65536, 16, 8, 128),               // capped at SPLIT_MAX
            (8192, 32, 16, 32),                // Splash's rule: max(32, pages/16)
            (32768, 32, 16, 64),
        ];
        for (visible, base, pps, want) in cases {
            assert_eq!(
                split_count(visible, base, pps, SPLIT_MAX),
                want,
                "visible={visible} base={base} pps={pps}"
            );
        }
    }

    #[test]
    fn split_for_routes_by_threshold() {
        let cfg = SplitCfg { enabled: true, min_keys: 384, base: 16, pps: 8, cap: 32, fixed: None, p_f32: false };
        assert_eq!(split_for(&cfg, 383), None);
        assert_eq!(split_for(&cfg, 384), Some(12));
        assert_eq!(split_for(&cfg, 1450), Some(16));
        assert_eq!(split_for(&cfg, 8192), Some(32));
        assert_eq!(split_for(&cfg, 32768), Some(32)); // cap
        let off = SplitCfg { enabled: false, ..cfg };
        assert_eq!(split_for(&off, 8192), None);
        let pinned = SplitCfg { fixed: Some(64), ..cfg };
        assert_eq!(split_for(&pinned, 8192), Some(64));
        assert_eq!(split_for(&pinned, 400), Some(13)); // capped at the pages
    }

    /// The split library (Metal 4 / MPP) compiles for the Qwen3.8
    /// attention geometry — compile only, no GPU dispatch.
    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn split_library_compiles() {
        let Ok(candle_core::Device::Metal(md)) = candle_core::Device::new_metal(0) else {
            return; // no Metal device
        };
        for p_f32 in [false, true] {
            if let Err(e) = metal_impl::compile_split(md.metal_device(), 24, 4, 256, p_f32) {
                panic!("split attention library (p_f32={p_f32}): {e}");
            }
        }
    }

    /// GPU: the split kernel matches the single-pass kernel (same
    /// inputs, both cache layouts, verify and plain-decode row counts,
    /// page-boundary positions, stale finite rows past the visible keys)
    /// within bf16-probability tolerance, and two runs are bitwise equal.
    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn split_attention_matches_single_pass() -> candle_core::Result<()> {
        use candle_core::{DType, Device, Tensor};
        let dev = match Device::new_metal(0) {
            Ok(d) => d,
            Err(_) => return Ok(()), // no Metal device: nothing to check
        };
        let (nh, nkv, d, rp) = (24usize, 4usize, 256usize, 32usize);
        let grp = nh / nkv;
        let packed = nh * 2 * d + 2 * nkv * d;
        let Device::Metal(md) = &dev else { unreachable!() };
        // a compile error is a bug, not a skip (the engine targets Metal 4)
        metal_impl::compile_split(md.metal_device(), nh, nkv, d, split_cfg().p_f32)
            .expect("split attention library must compile");
        assert!(metal_impl::split_pipes(md, nh, nkv, d).is_some());
        let host = |t: &Tensor| -> candle_core::Result<Vec<f32>> {
            t.to_dtype(DType::F32)?.flatten_all()?.to_vec1()
        };
        let mut worst = 0f32;
        for &time_major in &[false, true] {
            for &(pos, seq) in &[(0usize, 1usize), (24, 8), (31, 1), (32, 8), (500, 8), (1450, 8), (1450, 3), (2040, 8)] {
                let visible = pos + seq;
                let cap = visible.next_multiple_of(256);
                let mk = || -> candle_core::Result<Tensor> {
                    if time_major {
                        Tensor::randn(0f32, 1.0, (cap, nkv, d), &dev)?.to_dtype(DType::BF16)?.transpose(0, 1)
                    } else {
                        Tensor::randn(0f32, 1.0, (nkv, cap, d), &dev)?.to_dtype(DType::BF16)
                    }
                };
                let (kc, vc) = (mk()?, mk()?);
                let q = Tensor::randn(0f32, 1.0, (seq, nh, d), &dev)?.to_dtype(DType::BF16)?;
                let qg = q.reshape((seq, nkv, grp, d))?.permute((1, 0, 2, 3))?;
                let q_kv = if seq < SPLIT_QROWS {
                    Tensor::cat(&[qg, Tensor::zeros((nkv, SPLIT_QROWS - seq, grp, d), DType::BF16, &dev)?], 1)?
                } else {
                    qg
                }
                .contiguous()?
                .reshape((nkv * SPLIT_QROWS * grp, d))?;
                let qkv = Tensor::randn(0f32, 1.0, (1, seq, packed), &dev)?.to_dtype(DType::BF16)?;
                let o1 = Tensor::zeros((seq, nh * d), DType::BF16, &dev)?;
                attn_decode(&q, &kc, &vc, &qkv, &o1, pos, seq, nh, nkv, d, rp)?;
                let reference = host(&o1)?;
                for splits in [1usize, 5, split_count(visible, SPLIT_BASE, SPLIT_PPS, SPLIT_MAX)] {
                    let o2 = Tensor::zeros((seq, nh * d), DType::BF16, &dev)?;
                    let o3 = Tensor::zeros((seq, nh * d), DType::BF16, &dev)?;
                    attn_decode_split(&q_kv, &kc, &vc, &qkv, &o2, pos, seq, nh, nkv, d, splits)?;
                    attn_decode_split(&q_kv, &kc, &vc, &qkv, &o3, pos, seq, nh, nkv, d, splits)?;
                    let (a, b) = (host(&o2)?, host(&o3)?);
                    assert!(
                        a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()),
                        "split not deterministic: tm={time_major} pos={pos} seq={seq} splits={splits}"
                    );
                    let md_ = a.iter().zip(&reference).map(|(x, y)| (x - y).abs()).fold(0f32, f32::max);
                    assert!(
                        md_.is_finite() && md_ < 2e-2,
                        "split vs single-pass max|d| {md_}: tm={time_major} pos={pos} seq={seq} splits={splits}"
                    );
                    worst = worst.max(md_);
                }
            }
        }
        eprintln!("split vs single-pass worst max|d| = {worst:.5}");
        Ok(())
    }

    /// Per-geometry pipeline cache: one value per key, stable across
    /// calls, a second geometry never aliases the first (the bug a
    /// process-global OnceLock had when unit tests mixed model shapes).
    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn geom_cache_keys_by_geometry() {
        static C: metal_impl::GeomCache<usize> = metal_impl::GeomCache::new_for_tests();
        let a = C.get((24, 4, 256, 32), || 1);
        let b = C.get((2, 1, 256, 32), || 2);
        let a2 = C.get((24, 4, 256, 32), || 99);
        let b2 = C.get((2, 1, 256, 32), || 99);
        assert_eq!((*a, *b, *a2, *b2), (1, 2, 1, 2));
        assert!(std::ptr::eq(a, a2) && std::ptr::eq(b, b2));
    }

    /// Deterministic bf16 fill in [-scale, scale] (xorshift).
    #[cfg(all(feature = "metal", target_os = "macos"))]
    fn fill_bf16(dims: &[usize], seed: u64, scale: f32, dev: &candle_core::Device) -> candle_core::Result<candle_core::Tensor> {
        let n: usize = dims.iter().product();
        let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let v: Vec<f32> = (0..n)
            .map(|_| {
                s ^= s >> 12;
                s ^= s << 25;
                s ^= s >> 27;
                ((s.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f32 / (1u64 << 53) as f32 * 2.0 - 1.0) * scale
            })
            .collect();
        candle_core::Tensor::from_vec(v, dims, dev)?.to_dtype(candle_core::DType::BF16)
    }

    /// f32 reference of the causal prefill attention (broadcast GQA,
    /// explicit -inf mask): q [1, nh, seq, d], k/v [nkv, kv, d] → [seq, nh*d].
    #[cfg(all(feature = "metal", target_os = "macos"))]
    fn prefill_reference(
        q: &candle_core::Tensor,
        k: &candle_core::Tensor,
        v: &candle_core::Tensor,
        pos: usize,
        seq: usize,
        nh: usize,
        nkv: usize,
        d: usize,
    ) -> candle_core::Result<candle_core::Tensor> {
        use candle_core::{DType, Tensor, D};
        let kv = pos + seq;
        let rep = nh / nkv;
        let f = |t: &Tensor| t.to_dtype(DType::F32);
        let kb = f(k)?.narrow(1, 0, kv)?.unsqueeze(1)?.broadcast_as((nkv, rep, kv, d))?.reshape((nh, kv, d))?;
        let vb = f(v)?.narrow(1, 0, kv)?.unsqueeze(1)?.broadcast_as((nkv, rep, kv, d))?.reshape((nh, kv, d))?;
        let s = f(q)?.squeeze(0)?.contiguous()?.matmul(&kb.transpose(1, 2)?.contiguous()?)?;
        let s = (s * (d as f64).powf(-0.5))?;
        let mut mask = vec![f32::NEG_INFINITY; seq * kv];
        for i in 0..seq {
            for m in mask.iter_mut().skip(i * kv).take(pos + i + 1) {
                *m = 0.0;
            }
        }
        let mask = Tensor::from_vec(mask, (1, seq, kv), q.device())?;
        let p = candle_nn::ops::softmax(&s.broadcast_add(&mask)?, D::Minus1)?;
        p.matmul(&vb.contiguous()?)?.transpose(0, 1)?.reshape((seq, nh * d))
    }

    /// E1 primitive: the NAX 16x16 fragment lane map + per-simdgroup MPP
    /// 16x32x16 matmul (cooperative-tensor operands) against a CPU matmul:
    /// B as stored ([k][n]) and transposed ([n][k]) with bf16 A, and the
    /// p.v operand types (A = f32 strict / f32 relaxed / half / bf16).
    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn nax_fragment_mma_matches_cpu() {
        use candle_metal_kernels::utils::EncoderProvider;
        let Ok(candle_core::Device::Metal(md)) = candle_core::Device::new_metal(0) else {
            return;
        };
        let src = metal_impl::render_prefill(24, 4, 256, metal_impl::PrefillVariant { gqa: false, gate: false, wm: 4, ..metal_impl::PrefillVariant::DEFAULT })
            + r#"
template <typename AT, bool RELAX>
inline void pr_mma(thread pa_ffrag& c0, thread pa_ffrag& c1, thread const vec<AT, 8>& a,
                   thread const pa_bfrag& b0, thread const pa_bfrag& b1, device float* cap) {
    constexpr auto desc = mpp::tensor_ops::matmul2d_descriptor(16, 32, 16, false, false, RELAX,
        mpp::tensor_ops::matmul2d_descriptor::mode::multiply_accumulate);
    mpp::tensor_ops::matmul2d<desc, execution_simdgroup> op;
    auto ca = op.template get_left_input_cooperative_tensor<AT, bfloat, float>();
    auto cb = op.template get_right_input_cooperative_tensor<AT, bfloat, float>();
    auto cc = op.template get_destination_cooperative_tensor<
        metal::remove_addrspace_t<decltype(ca)>, metal::remove_addrspace_t<decltype(cb)>, float>();
    cap[0] = ca.get_capacity(); cap[1] = cb.get_capacity(); cap[2] = cc.get_capacity();
    for (short i = 0; i < 8; i++) ca[i] = a[i];
    for (short i = 0; i < 8; i++) { cb[i] = b0[i]; cb[8 + i] = b1[i]; }
    for (short i = 0; i < 8; i++) { cc[i] = c0[i]; cc[8 + i] = c1[i]; }
    op.run(ca, cb, cc);
    for (short i = 0; i < 8; i++) { c0[i] = cc[i]; c1[i] = cc[8 + i]; }
}

kernel void nax_probe(device const bfloat* A [[buffer(0)]], device const bfloat* B [[buffer(1)]],
                      device float* C [[buffer(2)]], device const float* Af [[buffer(3)]],
                      ushort lane [[thread_index_in_simdgroup]]) {
    const short2 sc = pa_coord(lane);
    const short sm = sc.y, sn = sc.x;
    pa_bfrag a, b0, b1, t0, t1;
    pa_load_full(a, A, 16, sm, sn, 0);
    pa_load_full(b0, B, 32, sm, sn, 0);
    pa_load_full(b1, B, 32, sm, sn, 16);
    pa_load_full(t0, B + 16 * 32, 16, sm, sn, 0);
    pa_load_full(t1, B + 16 * 32 + 16 * 16, 16, sm, sn, 0);
    pa_ffrag c[12];
    for (short k = 0; k < 12; k++) c[k] = 0.0f;
    pa_mma<float, bfloat, bfloat, false>(c[0], c[1], a, b0, b1);
    pa_mma<float, bfloat, bfloat, true>(c[2], c[3], a, t0, t1);
    pa_ffrag af; vec<half, 8> ah; pa_bfrag ab;
    for (short i = 0; i < 2; i++) for (short j = 0; j < 4; j++) {
        const float x = Af[(sm + i * 8) * 16 + sn + j];
        af[i * 4 + j] = x; ah[i * 4 + j] = half(x); ab[i * 4 + j] = bfloat(x);
    }
    device float* cap = C + 3584;
    pr_mma<float, false>(c[4], c[5], af, b0, b1, cap);
    pr_mma<float, true>(c[6], c[7], af, b0, b1, cap + 3);
    pr_mma<half, false>(c[8], c[9], ah, b0, b1, cap + 6);
    pr_mma<bfloat, false>(c[10], c[11], ab, b0, b1, cap + 9);
    for (short k = 0; k < 6; k++)
    for (short i = 0; i < 2; i++) for (short j = 0; j < 4; j++) {
        const int r = sm + i * 8, cc = sn + j;
        C[k * 512 + r * 32 + cc] = c[2 * k][i * 4 + j];
        C[k * 512 + r * 32 + 16 + cc] = c[2 * k + 1][i * 4 + j];
    }
}
"#;
        let raw = md.metal_device();
        let opts = objc2_metal::MTLCompileOptions::new();
        opts.setLanguageVersion(objc2_metal::MTLLanguageVersion::Version4_0);
        let lib = raw.new_library_with_source(&src, Some(&opts)).expect("probe compiles");
        let f = lib.get_function("nax_probe", None).unwrap();
        let pipe = raw.new_compute_pipeline_state_with_function(&f).unwrap();
        let bf = |x: f32| half::bf16::from_f32(x);
        let a: Vec<f32> = (0..256).map(|i| ((i * 7 % 13) as f32 - 6.0) / 4.0 + (i % 3) as f32 * 0.0037).collect();
        let b: Vec<f32> = (0..512).map(|i| ((i * 5 % 11) as f32 - 5.0) / 4.0).collect();
        let mut bt = vec![0f32; 512];
        for k in 0..16 { for n in 0..32 { bt[n * 16 + k] = b[k * 32 + n]; } }
        let a_b: Vec<half::bf16> = a.iter().map(|&x| bf(x)).collect();
        let mut b_all: Vec<half::bf16> = b.iter().map(|&x| bf(x)).collect();
        b_all.extend(bt.iter().map(|&x| bf(x)));
        let dev = candle_core::Device::Metal(md.clone());
        let ta = candle_core::Tensor::from_vec(a_b, 256, &dev).unwrap();
        let tb = candle_core::Tensor::from_vec(b_all, 1024, &dev).unwrap();
        let taf = candle_core::Tensor::from_vec(a.clone(), 256, &dev).unwrap();
        let tc = candle_core::Tensor::zeros(4096, candle_core::DType::F32, &dev).unwrap();
        {
            let (ab, ao) = metal_impl::msl_buf_pub(&ta, 2).unwrap();
            let (bb, bo) = metal_impl::msl_buf_pub(&tb, 2).unwrap();
            let (cb, co) = metal_impl::msl_buf_pub(&tc, 4).unwrap();
            let (fb, fo) = metal_impl::msl_buf_pub(&taf, 4).unwrap();
            let encoder = md.command_encoder().unwrap();
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder = enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(&pipe);
            enc.set_input_buffer(0, Some(&ab), ao as _);
            enc.set_input_buffer(1, Some(&bb), bo as _);
            enc.set_output_buffer(2, Some(&cb), co as _);
            enc.set_input_buffer(3, Some(&fb), fo as _);
            enc.dispatch_thread_groups(objc2_metal::MTLSize { width: 1, height: 1, depth: 1 }, objc2_metal::MTLSize { width: 32, height: 1, depth: 1 });
            drop(encoder);
        }
        let c: Vec<f32> = tc.to_vec1().unwrap();
        let mm = |aa: &dyn Fn(usize) -> f32| -> Vec<f32> {
            let mut w = vec![0f32; 512];
            for r in 0..16 { for n in 0..32 { let mut s = 0f64; for k in 0..16 { s += aa(r * 16 + k) as f64 * bf(b[k * 32 + n]).to_f32() as f64; } w[r * 32 + n] = s as f32; } }
            w
        };
        let want_b = mm(&|i| bf(a[i]).to_f32());
        let want_f = mm(&|i| a[i]);
        let want_h = mm(&|i| half::f16::from_f32(a[i]).to_f32());
        let md_ = |x: &[f32], y: &[f32]| x.iter().zip(y).map(|(p, q)| (p - q).abs()).fold(0f32, f32::max);
        let names = ["bf16 NN", "bf16 NT", "f32-A strict", "f32-A relaxed", "half-A", "bf16-A (p.v form)"];
        let wants = [&want_b, &want_b, &want_f, &want_f, &want_h, &want_b];
        let mut bad = Vec::new();
        for k in 0..6 {
            let e = md_(&c[k * 512..(k + 1) * 512], wants[k]);
            eprintln!("nax probe {:18}: max|d| vs f64 CPU {e:.3e}", names[k]);
            if e > 1e-3 { bad.push(names[k]); }
        }
        eprintln!("capacities (left, right, dest): f32 strict {:?}, f32 relaxed {:?}, half {:?}, bf16 {:?}", &c[3584..3587], &c[3587..3590], &c[3590..3593], &c[3593..3596]);
        assert!(!bad.contains(&"bf16 NN") && !bad.contains(&"bf16 NT") && !bad.contains(&"bf16-A (p.v form)"), "NAX fragment mma layout mismatch: {bad:?}");
    }

    /// E1: every prefill kernel variant compiles (Metal 4 / MPP with
    /// cooperative-tensor operands) for Qwen3.8's geometry.
    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn prefill_library_compiles() {
        let Ok(candle_core::Device::Metal(md)) = candle_core::Device::new_metal(0) else {
            return;
        };
        let names = ["g1", "g2", "g4", "ph1", "ph2", "ph4", "g2r", "g2n", "g2k64", "g1k64", "g2x", "g1x", "g2s", "g2xs", "g1k64xs", "ph4k64", "g2q", "g1q", "g4q", "g2xsq"];
        for n in names {
            let v = metal_impl::PrefillVariant::parse(n).unwrap();
            if let Err(e) = metal_impl::compile_prefill(md.metal_device(), 24, 4, 256, v) {
                panic!("prefill attention library {n} {v:?}: {e}");
            }
        }
    }

    /// E1: the fused prefill kernel matches an f32 reference within bf16
    /// output rounding (both cache layouts, per-head and GQA-fused rows,
    /// chunk sizes / query offsets off every tile boundary, the fused
    /// gate), two runs are bitwise equal, and a row's result does not
    /// depend on the chunk that holds it (rows 40..100 of a [0, 100) chunk
    /// == rows 0..60 of a [40, 100) chunk, bit for bit).
    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn prefill_attention_matches_reference() -> candle_core::Result<()> {
        use candle_core::{DType, Device, Tensor};
        let Ok(dev) = Device::new_metal(0) else {
            return Ok(());
        };
        let (nh, nkv, d) = (24usize, 4usize, 256usize);
        let packed = nh * 2 * d + 2 * nkv * d;
        let host = |t: &Tensor| -> candle_core::Result<Vec<f32>> { t.to_dtype(DType::F32)?.flatten_all()?.to_vec1() };
        let maxd = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0f32, f32::max);
        let mut worst = [0f32; 2];
        let mut seed = 7u64;
        for &(seq, pos) in &[(9usize, 0usize), (16, 0), (17, 5), (64, 0), (65, 31), (100, 1000), (130, 1408), (24, 1408), (300, 2000), (512, 0), (512, 511)] {
            let kv = pos + seq;
            seed += 5;
            // q scaled so the scores are peaked (std ~3), as in the model
            let q = fill_bf16(&[1, nh, seq, d], seed, 3.0 * 1.7, &dev)?;
            let cap = kv.next_multiple_of(256);
            let k_hm = fill_bf16(&[nkv, cap, d], seed + 1, 1.0, &dev)?;
            let v_hm = fill_bf16(&[nkv, cap, d], seed + 2, 1.0, &dev)?;
            // the time-major layout attn_forward's cat hands over
            let v_tm = v_hm.narrow(1, 0, kv)?.transpose(0, 1)?.contiguous()?.transpose(0, 1)?;
            let k_tm = k_hm.narrow(1, 0, kv)?.transpose(0, 1)?.contiguous()?.transpose(0, 1)?;
            let reference = host(&prefill_reference(&q, &k_hm, &v_hm, pos, seq, nh, nkv, d)?)?;
            let qkv = fill_bf16(&[1, seq, packed], seed + 3, 2.0, &dev)?;
            let gate = qkv.narrow(2, 0, nh * 2 * d)?.reshape((seq, nh, 2 * d))?.narrow(2, d, d)?.reshape((seq, nh * d))?;
            let gated_ref: Vec<f32> = reference
                .iter()
                .zip(host(&gate)?)
                .map(|(r, g)| r / (1.0 + (-g).exp()))
                .collect();
            for (li, (kk, vv)) in [(&k_hm, &v_hm), (&k_tm, &v_tm)].into_iter().enumerate() {
                for name in ["ph4", "g2", "g1", "g4", "g4r", "g2k64", "g1k64xs", "g2x", "g2s", "g2xs", "g2q", "g1q", "g2xsq"] {
                    for gate_on in [false, true] {
                        {
                            {
                                let var = metal_impl::PrefillVariant { gate: gate_on, ..metal_impl::PrefillVariant::parse(name).unwrap() };
                                let relaxed = var.relaxed;
                                let g = if gate_on { Some(&qkv) } else { None };
                                let o1 = attn_prefill(&q, kk, vv, g, pos, seq, nh, nkv, d, var)?;
                                let o2 = attn_prefill(&q, kk, vv, g, pos, seq, nh, nkv, d, var)?;
                                let (a, b) = (host(&o1)?, host(&o2)?);
                                assert!(
                                    a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()),
                                    "not deterministic: seq {seq} pos {pos} layout {li} {var:?}"
                                );
                                let md_ = maxd(&a, if gate_on { &gated_ref } else { &reference });
                                assert!(md_.is_finite() && md_ < 1.6e-2, "seq {seq} pos {pos} layout {li} {var:?}: max|fused - f32 ref| {md_}");
                                worst[relaxed as usize] = worst[relaxed as usize].max(md_);
                            }
                        }
                    }
                }
            }
        }
        eprintln!("prefill fused vs f32 reference: worst max|d| strict {:.5}, relaxed {:.5}", worst[0], worst[1]);
        // chunk invariance: [0, 100) vs [40, 100) over the same K/V
        let q = fill_bf16(&[1, nh, 100, d], 99, 5.0, &dev)?;
        let k = fill_bf16(&[nkv, 256, d], 98, 1.0, &dev)?;
        let v = fill_bf16(&[nkv, 256, d], 97, 1.0, &dev)?;
        let q_tail = q.narrow(2, 40, 60)?.contiguous()?;
        for name in ["ph4", "g2", "g1", "g4r", "g2k64", "g1k64xs", "g2xsq"] {
            let var = metal_impl::PrefillVariant { gate: false, ..metal_impl::PrefillVariant::parse(name).unwrap() };
            let full = host(&attn_prefill(&q, &k, &v, None, 0, 100, nh, nkv, d, var)?.narrow(0, 40, 60)?)?;
            let tail = host(&attn_prefill(&q_tail, &k, &v, None, 40, 60, nh, nkv, d, var)?)?;
            let diff = full.iter().zip(&tail).filter(|(x, y)| x.to_bits() != y.to_bits()).count();
            eprintln!("prefill chunk invariance {name}: {diff}/{} elements differ", full.len());
            if !var.relaxed {
                assert_eq!(diff, 0, "{name}: a row's result depends on its chunk");
            }
        }
        // variants that keep the block structure (32 keys, one chain) are
        // bitwise equal to the default; others differ only by f32 rounding
        let q = fill_bf16(&[1, nh, 200, d], 77, 5.0, &dev)?;
        let k = fill_bf16(&[nkv, 1024, d], 76, 1.0, &dev)?;
        let v = fill_bf16(&[nkv, 1024, d], 75, 1.0, &dev)?;
        let d0 = host(&attn_prefill(&q, &k, &v, None, 700, 200, nh, nkv, d, metal_impl::PrefillVariant { gate: false, ..metal_impl::PrefillVariant::DEFAULT })?)?;
        for name in ["ph4", "ph2", "g2", "g1", "g4", "g2x", "g2s", "g1x", "g2xs", "g2q", "g1q"] {
            let var = metal_impl::PrefillVariant { gate: false, ..metal_impl::PrefillVariant::parse(name).unwrap() };
            let o = host(&attn_prefill(&q, &k, &v, None, 700, 200, nh, nkv, d, var)?)?;
            let diff = o.iter().zip(&d0).filter(|(x, y)| x.to_bits() != y.to_bits()).count();
            assert_eq!(diff, 0, "{name} differs from the default in {diff} elements");
        }
        Ok(())
    }

    /// Every page lands in exactly one split and the reduce's `written`
    /// count equals the number of non-empty splits (the kernel pair's
    /// shared partition).
    #[test]
    fn split_partition_covers_pages_once() {
        for visible in [1usize, 31, 32, 33, 385, 1450, 2048, 8190, 8200, 32776] {
            let pages = visible.div_ceil(SPLIT_PAGE);
            for splits in [1usize, 3, 16, 32, 64, 128] {
                let per = pages.div_ceil(splits);
                let mut seen = vec![0u32; pages];
                let mut nonempty = 0;
                for s in 0..splits {
                    let b = s * per;
                    if b >= pages {
                        continue;
                    }
                    nonempty += 1;
                    for pg in b..(b + per).min(pages) {
                        seen[pg] += 1;
                    }
                }
                assert!(seen.iter().all(|&c| c == 1), "visible={visible} splits={splits}");
                assert_eq!(pages.div_ceil(per), nonempty, "visible={visible} splits={splits}");
            }
        }
    }
}
