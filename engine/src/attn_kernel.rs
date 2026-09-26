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
}

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::{attn_decode, attn_decode_split, attn_prepare, split_plan};

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
}

#[cfg(not(all(feature = "metal", target_os = "macos")))]
pub use stub::{attn_decode, attn_decode_split, attn_prepare, split_plan};

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
