//! Fused Metal kernel for the Gated DeltaNet recurrent step.
//!
//! Ports mlx-lm's `gated_delta_step` shader (gated_delta.py) into a
//! candle `CustomOp3`. One dispatch per layer replaces the eager
//! per-token scan (~40 tensor ops/token → 1 kernel per sequence chunk).
//!
//! Buffers (B=1 only — th-engine never batches):
//!   qkv   [T, 2*Hk+Hv, Dw] bf16  rows = [q heads | k heads | v heads]
//!   ab    [T, 2*Hv]      f32   rows = [a | b] raw projections
//!   state [Hv, Dv, Dk]   f32   recurrent state, updated in place
//!   y     [T, Hv, Dv]    bf16  output (returned)
//! Params are passed by value: T + per-head A_log/dt_bias constants
//! (Hv ≤ 64). g = exp(-exp(A_log)·softplus(a+dt_bias)) and
//! β = sigmoid(b) are computed inside the kernel — zero eager ops.
//!
//! The state buffer is bound as an *output* so candle's encoder hazard
//! tracking inserts a buffer barrier before the next consumer.

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::{AddRmsNorm, GdnConv, GdnGateNorm, GdnQkNorm, GdnStep, gdn_fused_step};

#[cfg(all(feature = "metal", target_os = "macos"))]
mod metal_impl {
    use candle_core::backend::BackendStorage;
    use candle_core::{
        CpuStorage, CustomOp1, CustomOp3, DType, Layout,
        MetalStorage, Result, Shape, Storage, Tensor,
    };
    use candle_metal_kernels::metal::ComputePipeline;
    use candle_metal_kernels::utils::EncoderProvider;
    use objc2_metal::MTLSize;
    use std::sync::OnceLock;

    /// One GDN recurrent scan over `T` tokens for a single layer.
    /// `a_log`/`dt_bias` are the layer's gate constants (Hv floats each,
    /// zero-padded to 64). Dims are baked into the shader at compile time.
    pub struct GdnStep {
        pub t: usize,
        pub hk: usize,
        pub hv: usize,
        pub dk: usize,
        pub dv: usize,
        pub a_log: [f32; 64],
        pub dt_bias: [f32; 64],
    }

    /// In-place rmsnorm+scale on the q/k channels of the packed conv
    /// output, then the scan reads it directly — replaces ~14 eager
    /// dispatches (two rms_norm chains, affines, cat, contiguous).
    /// q/k RMSNorm + per-head scaling over the conv output — the
    /// output is a fresh buffer with normed q/k and v copied through
    /// (out-of-place: in-place aliasing creates an `Arc<Buffer>` clone
    /// that the pool's `strong_count == 1` check can't see, so the
    /// pooled buffer gets recycled while still aliased). `x` is
    /// `[T, conv_dim]`: `[q(HK·DK) | k(HK·DK) | v(HV·DV)]`.
    /// Grid (2·HK + HV, T) — one threadgroup per head per row.
    pub struct GdnQkNorm {
        pub t: usize,
        pub hk: usize,
        pub hv: usize,
        pub dk: usize,
        pub dv: usize,
    }

    /// gated = rmsnorm(o)·w ⊙ silu(z) — replaces the ~7-op eager chain.
    pub struct GdnGateNorm {
        pub t: usize,
        pub hv: usize,
        pub dv: usize,
        /// z row stride in elements (view into the fused projection)
        pub z_stride: usize,
        pub eps: f32,
    }

    #[repr(C)]
    struct GdnParams {
        t: i32,
        ab_stride: i32,
        a_log: [f32; 64],
        dt_bias: [f32; 64],
    }

    const SOURCE_TMPL: &str = r#"
#include <metal_stdlib>
#include <metal_math>
using namespace metal;

struct GdnParams {
    int T;
    int ab_stride;
    float a_log[64];
    float dt_bias[64];
};

constant constexpr int HK = {HK};
constant constexpr int HV = {HV};
constant constexpr int DK = {DK};
constant constexpr int DV = {DV};

// grid (32, Dv, Hv) threads, threadgroup (32, 4, 1):
// one simdgroup (x-lane) per (dv, hv) — each lane owns Dk/32 state elems.
kernel void gated_delta_step(
    device const bfloat* qkv   [[buffer(0)]],
    device const bfloat* ab    [[buffer(1)]],
    device float*        state [[buffer(2)]],
    device bfloat*       y     [[buffer(3)]],
    constant GdnParams&  p     [[buffer(4)]],
    uint3 tgp [[thread_position_in_grid]],
    uint3 tgt [[thread_position_in_threadgroup]],
    uint  lane [[thread_index_in_simdgroup]])
{
    const int hv = tgp.z;
    const int hk = hv / (HV / HK);
    const int dk0 = tgt.x * (DK / 32);
    const int dv = tgp.y;
    constexpr int n_per_t = DK / 32;
    const int qkv_stride = (2 * HK + HV) * DK;

    device const bfloat* q_ = qkv + hk * DK;
    device const bfloat* k_ = qkv + (HK + hk) * DK;
    device const bfloat* v_ = qkv + (2 * HK + hv) * DV;
    device bfloat* y_ = y + hv * DV;
    device float* s_ = state + (hv * DV + dv) * DK;
    device const bfloat* a_ = ab + hv;
    device const bfloat* b_ = ab + HV + hv;

    float s[n_per_t];
    for (int i = 0; i < n_per_t; ++i) s[i] = s_[dk0 + i];

    const float eA = exp(p.a_log[hv]);
    const float dtb = p.dt_bias[hv];

    for (int t = 0; t < p.T; ++t) {
        const int qo = t * qkv_stride;
        const float ap = float(a_[t * p.ab_stride]) + dtb;
        // softplus, overflow-safe: log(1+e^x) ≈ x for x > 30
        const float g = exp(-eA * (ap > 30.0f ? ap : log(1.0f + exp(ap))));
        const float beta = 1.0f / (1.0f + exp(-float(b_[t * p.ab_stride])));

        float kv = 0.0f;
        for (int i = 0; i < n_per_t; ++i) {
            const int si = dk0 + i;
            s[i] *= g;
            kv += s[i] * float(k_[qo + si]);
        }
        kv = simd_sum(kv);

        const float delta = (float(v_[qo + dv]) - kv) * beta;

        float out = 0.0f;
        for (int i = 0; i < n_per_t; ++i) {
            const int si = dk0 + i;
            s[i] += float(k_[qo + si]) * delta;
            out += s[i] * float(q_[qo + si]);
        }
        out = simd_sum(out);
        if (lane == 0) y_[t * HV * DV + dv] = bfloat(out);
    }
    for (int i = 0; i < n_per_t; ++i) s_[dk0 + i] = s[i];
}

// rmsnorm·scale on the q and k head regions of the packed conv output
// [T, C]: q rows × DK^-1, k rows × DK^-0.5 (the reference
// normalisation: q = dk^-1·rms(q), k = dk^-0.5·rms(k), unit weights);
// the v region is copied through verbatim. Out-of-place: the verify
// cache stashes the result across forward calls, and an in-place
// buffer alias can't keep a pooled buffer alive (the pool's
// strong_count check only sees its own Arc<Buffer>).
// grid (2*HK + HV, T) threadgroups x 32 lanes — one head per group.
kernel void gdn_qknorm(
    device const bfloat* qkv [[buffer(0)]],
    device bfloat*       out [[buffer(1)]],
    constant int&     stride [[buffer(2)]],
    uint2 tgp  [[threadgroup_position_in_grid]],
    uint  lane [[thread_index_in_simdgroup]])
{
    const uint sg = tgp.x;
    constexpr int C = 2 * HK * DK + HV * DV;
    if (sg >= 2u * HK) {
        // v copy — verbatim
        const int h = sg - 2 * HK;
        for (int i = 0; i < DV / 32; ++i) {
            const int e = lane * (DV / 32) + i;
            out[tgp.y * C + 2 * HK * DK + h * DV + e] =
                qkv[tgp.y * stride + 2 * HK * DK + h * DV + e];
        }
        return;
    }
    const bool is_q = sg < (uint)HK;
    const int h = is_q ? sg : sg - HK;
    device const bfloat* x =
        qkv + tgp.y * stride + (is_q ? 0 : HK * DK) + h * DK;
    device bfloat* y =
        out + tgp.y * C + (is_q ? 0 : HK * DK) + h * DK;
    constexpr int PER = DK / 32;
    float xv[PER];
    float ss = 0.0f;
    for (int i = 0; i < PER; ++i) {
        xv[i] = float(x[lane * PER + i]);
        ss += xv[i] * xv[i];
    }
    ss = simd_sum(ss);
    const float inv = rsqrt(ss / DK + 1e-6f)
        * (is_q ? 1.0f / DK : rsqrt(float(DK)));
    for (int i = 0; i < PER; ++i)
        y[lane * PER + i] = bfloat(xv[i] * inv);
}

// Gated output norm: gated = (rmsnorm(o)·w) ⊙ silu(z), one head per
// threadgroup. `z` is a strided view of the fused projection output.
// grid (HV, T) threadgroups x 32 lanes.
kernel void gdn_gatenorm(
    device const bfloat* o     [[buffer(0)]],
    device const bfloat* z     [[buffer(1)]],
    device const bfloat* w     [[buffer(2)]],
    device bfloat*       gated [[buffer(3)]],
    constant int&  z_stride    [[buffer(4)]],
    constant float& eps        [[buffer(5)]],
    uint2 tgp  [[threadgroup_position_in_grid]],
    uint  lane [[thread_index_in_simdgroup]])
{
    const int h = tgp.x, t = tgp.y;
    device const bfloat* x  = o + t * (HV * DV) + h * DV;
    device const bfloat* zr = z + t * z_stride + h * DV;
    device bfloat* g = gated + t * (HV * DV) + h * DV;
    constexpr int PER = DV / 32;
    float xv[PER];
    float ss = 0.0f;
    for (int i = 0; i < PER; ++i) {
        xv[i] = float(x[lane * PER + i]);
        ss += xv[i] * xv[i];
    }
    ss = simd_sum(ss);
    const float inv = rsqrt(ss / DV + eps);
    for (int i = 0; i < PER; ++i) {
        const int d = lane * PER + i;
        const float zz = float(zr[d]);
        g[d] = bfloat(xv[i] * inv * float(w[d]) * zz
                      / (1.0f + exp(-zz)));
    }
}
struct GdnFusedParams {
    int t;
    int xs;      // xnew row stride
    int ss;      // conv-state row stride
    int abs_;    // ab row stride
    int zs;      // z row stride
    float eps;   // gatenorm eps
    float a_log[64];
    float dt_bias[64];
};

// One-dispatch GDN step: conv+silu, per-head l2norm, delta recurrence
// and the gated output norm — one threadgroup per value head, 256
// threads. Sibling threadgroups sharing a k-head recompute its q/k
// conv+norm (registers are cheaper than a global round-trip); the
// hv%3==0 owner also writes them into `pack` for the verify stash.
// Delta state lives in registers across all T rows and writes back
// once. Exact-op parity with conv -> qknorm -> scan -> gatenorm:
// bf16 rounding at the conv, pack and out boundaries.
constant constexpr int TMAX = 8;
kernel void gdn_fused_step(
    device const bfloat* xnew  [[buffer(0)]],
    device const bfloat* cst   [[buffer(1)]],
    device const bfloat* cw    [[buffer(2)]],
    device float*        dst   [[buffer(3)]],
    device const bfloat* ab    [[buffer(4)]],
    device const bfloat* zz    [[buffer(5)]],
    device const bfloat* nw    [[buffer(6)]],
    device bfloat*       y     [[buffer(7)]],
    device bfloat*       pack  [[buffer(8)]],
    constant GdnFusedParams& p [[buffer(9)]],
    uint hv  [[threadgroup_position_in_grid]],
    uint tid [[thread_index_in_threadgroup]],
    uint lane [[thread_index_in_simdgroup]],
    uint sg  [[simdgroup_index_in_threadgroup]])
{
    constexpr int C = 2 * HK * DK + HV * DV;
    constexpr int REP = HV / HK;
    const uint hk = hv / REP;
    const int T = p.t;

    threadgroup float qn[TMAX * DK];
    threadgroup float kn[TMAX * DK];
    threadgroup float vr[TMAX * DV];
    threadgroup float ov[TMAX * DV];
    threadgroup float gdec[TMAX];
    threadgroup float bta[TMAX];

    // g/beta per row — computed once, shared across sgs
    {
        const float eA = exp(p.a_log[hv]);
        const float dtb = p.dt_bias[hv];
        for (int t = int(tid); t < T; t += 256) {
            const float ap = float(ab[t * p.abs_ + hv]) + dtb;
            gdec[t] = exp(-eA * (ap > 30.0f ? ap : log(1.0f + exp(ap))));
            bta[t] = 1.0f / (1.0f + exp(-float(ab[t * p.abs_ + HV + hv])));
        }
    }

    // ---- conv + silu: this head's 384 channels x T rows ----
    for (uint w = tid; w < uint(3 * DK) * uint(T); w += 256) {
        const int i = int(w) % (3 * DK);   // local channel
        const int t = int(w) / (3 * DK);   // row
        int g;
        if (i < DK) g = int(hk) * DK + i;
        else if (i < 2 * DK) g = HK * DK + int(hk) * DK + (i - DK);
        else g = 2 * HK * DK + int(hv) * DV + (i - 2 * DK);
        float acc = 0.0f;
        for (int j = 0; j < 4; ++j) {
            const int r = t + j;
            const float v = r < 3
                ? float(cst[r * p.ss + g])
                : float(xnew[(r - 3) * p.xs + g]);
            acc += float(cw[g * 4 + j]) * v;
        }
        const float sv = float(bfloat(acc / (1.0f + exp(-acc))));
        if (i < DK) qn[t * DK + i] = sv;
        else if (i < 2 * DK) kn[t * DK + i - DK] = sv;
        else {
            vr[t * DV + i - 2 * DK] = sv;
            pack[t * C + g] = bfloat(sv);   // v rows go raw to the stash
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // ---- per-row l2norm on q/k (all siblings recompute; owner writes pack) ----
    const bool owner = (hv % REP) == 0;
    for (int t = int(sg); t < T; t += 8) {
        float qs = 0.0f, ks = 0.0f;
        for (int i = 0; i < DK / 32; ++i) {
            const float q = qn[t * DK + lane * 4 + i];
            const float k = kn[t * DK + lane * 4 + i];
            qs += q * q;
            ks += k * k;
        }
        qs = simd_sum(qs);
        ks = simd_sum(ks);
        const float qi = rsqrt(qs / DK + 1e-6f) / float(DK);
        const float ki = rsqrt(ks / DK + 1e-6f) * rsqrt(float(DK));
        for (int i = 0; i < DK / 32; ++i) {
            const int e = lane * 4 + i;
            const bfloat qb = bfloat(qn[t * DK + e] * qi);
            const bfloat kb = bfloat(kn[t * DK + e] * ki);
            qn[t * DK + e] = float(qb);
            kn[t * DK + e] = float(kb);
            if (owner) {
                pack[t * C + hk * DK + e] = qb;
                pack[t * C + HK * DK + hk * DK + e] = kb;
            }
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // ---- delta recurrence: one simdgroup per dv row, stride 8 ----
    for (uint dv = sg; dv < uint(DV); dv += 8) {
        device float* sr = dst + (hv * DV + int(dv)) * DK;
        float s0 = sr[4 * lane + 0], s1 = sr[4 * lane + 1];
        float s2 = sr[4 * lane + 2], s3 = sr[4 * lane + 3];
        for (int t = 0; t < T; ++t) {
            const float k0 = kn[t * DK + 4 * lane + 0];
            const float k1 = kn[t * DK + 4 * lane + 1];
            const float k2 = kn[t * DK + 4 * lane + 2];
            const float k3 = kn[t * DK + 4 * lane + 3];
            const float g = gdec[t];
            s0 *= g; s1 *= g; s2 *= g; s3 *= g;
            float kv = s0 * k0 + s1 * k1 + s2 * k2 + s3 * k3;
            kv = simd_sum(kv);
            const float delta = (vr[t * DV + int(dv)] - kv) * bta[t];
            s0 += k0 * delta; s1 += k1 * delta;
            s2 += k2 * delta; s3 += k3 * delta;
            float out = s0 * qn[t * DK + 4 * lane + 0]
                      + s1 * qn[t * DK + 4 * lane + 1]
                      + s2 * qn[t * DK + 4 * lane + 2]
                      + s3 * qn[t * DK + 4 * lane + 3];
            out = simd_sum(out);
            if (lane == 0) ov[t * DV + int(dv)] = float(bfloat(out));
        }
        sr[4 * lane + 0] = s0; sr[4 * lane + 1] = s1;
        sr[4 * lane + 2] = s2; sr[4 * lane + 3] = s3;
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // ---- gated rmsnorm: y = (rmsnorm(o)·w) ⊙ silu(z) ----
    for (int t = int(sg); t < T; t += 8) {
        float ss = 0.0f;
        for (int i = 0; i < DV / 32; ++i) {
            const float v = ov[t * DV + lane * 4 + i];
            ss += v * v;
        }
        ss = simd_sum(ss);
        const float inv = rsqrt(ss / DV + p.eps);
        for (int i = 0; i < DV / 32; ++i) {
            const int d = lane * 4 + i;
            const float zf = float(zz[t * p.zs + hv * DV + d]);
            y[t * HV * DV + hv * DV + d] = bfloat(
                ov[t * DV + d] * inv * float(nw[d]) * zf / (1.0f + exp(-zf)));
        }
    }
}

"#;

    static PIPELINE: OnceLock<ComputePipeline> = OnceLock::new();

    impl CustomOp3 for GdnStep {
        fn name(&self) -> &'static str {
            "gated-delta-step"
        }

        fn cpu_fwd(
            &self,
            _: &CpuStorage,
            _: &Layout,
            _: &CpuStorage,
            _: &Layout,
            _: &CpuStorage,
            _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("gated-delta-step: Metal only")
        }

        fn metal_fwd(
            &self,
            s_qkv: &MetalStorage,
            l_qkv: &Layout,
            s_ab: &MetalStorage,
            l_ab: &Layout,
            s_state: &MetalStorage,
            l_state: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            let l_shape = l_ab.shape();
            let l_strides = l_ab.stride();
            if !(l_qkv.is_contiguous()
                && l_state.is_contiguous()
                && l_strides.last() == Some(&1))
            {
                candle_core::bail!(
                    "gated-delta-step layouts: qkv {:?} state {:?} must be \
                     contiguous; ab {:?} needs contiguous inner dim",
                    l_qkv.shape(),
                    l_state.shape(),
                    l_shape
                );
            }
            if s_qkv.dtype() != DType::BF16
                || s_ab.dtype() != DType::BF16
                || s_state.dtype() != DType::F32
            {
                candle_core::bail!(
                    "gated-delta-step dtypes: qkv/ab bf16, state f32"
                );
            }
            let ab_stride = if l_shape.dims().len() >= 2 {
                l_strides[l_shape.dims().len() - 2]
            } else {
                l_shape.elem_count()
            };
            if self.hv > 64 || self.dk != self.dv {
                candle_core::bail!(
                    "gated-delta-step dims: hv {} dk {} dv {}",
                    self.hv,
                    self.dk,
                    self.dv
                );
            }

            let device = s_qkv.device();
            if PIPELINE.get().is_none() {
                let src = SOURCE_TMPL
                    .replace("{HK}", &self.hk.to_string())
                    .replace("{HV}", &self.hv.to_string())
                    .replace("{DK}", &self.dk.to_string())
                    .replace("{DV}", &self.dv.to_string());
                let raw = device.metal_device();
                let lib = raw
                    .new_library_with_source(&src, None)
                    .map_err(candle_core::Error::wrap)?;
                let f = lib
                    .get_function("gated_delta_step", None)
                    .map_err(candle_core::Error::wrap)?;
                let p = raw
                    .new_compute_pipeline_state_with_function(&f)
                    .map_err(candle_core::Error::wrap)?;
                let _ = PIPELINE.set(p);
            }
            let pipeline = PIPELINE.get().unwrap();

            let y_elems = self.t * self.hv * self.dv;
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(y_elems, DType::BF16)
                .with_label("gdn.y")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("gated_delta_step");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipeline);

            let params = GdnParams {
                t: self.t as i32,
                ab_stride: ab_stride as i32,
                a_log: self.a_log,
                dt_bias: self.dt_bias,
            };
            enc.set_input_buffer(
                0,
                Some(s_qkv.buffer()),
                l_qkv.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_input_buffer(
                1,
                Some(s_ab.buffer()),
                l_ab.start_offset() * DType::BF16.size_in_bytes(),
            );
            // state is read and written in place — bind as output so the
            // encoder's hazard tracking barriers the next consumer.
            enc.set_output_buffer(
                2,
                Some(s_state.buffer()),
                l_state.start_offset() * DType::F32.size_in_bytes(),
            );
            enc.set_output_buffer(3, Some(&y_buf), 0);
            enc.set_bytes(4, &params);

            enc.dispatch_threads(
                MTLSize { width: 32, height: self.dv, depth: self.hv },
                MTLSize { width: 32, height: 4, depth: 1 },
            );

            let storage =
                MetalStorage::new(y_buf, device.clone(), y_elems, DType::BF16);
            Ok((storage, Shape::from((self.t, self.hv, self.dv))))
        }
    }

    /// Depthwise causal conv + SiLU over a state window + strided input
    /// view — `state` is [(k-1), C] and `x` is [T, C] (possibly strided);
    /// the kernel reads source row r as `state[r]` when r < k-1 else
    /// `x[r-(k-1)]`, so no concatenated input is materialised. Output is
    /// [T, C] bf16. Replaces the cat + ~10 eager dispatches per layer.
    pub struct GdnConv {
        pub t: usize,
        pub c: usize,
        pub k: usize,
    }

    #[repr(C)]
    struct ConvParams {
        t: i32,
        c: i32,
        k: i32,
        x_stride: i32,
        s_stride: i32,
    }

    const CONV_SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct ConvParams {
    int T;
    int C;
    int K;
    int x_stride;
    int s_stride;
};

// grid (C, T) — one thread per (channel, output row)
kernel void gdn_conv(
    device const bfloat* state [[buffer(0)]],
    device const bfloat* x     [[buffer(1)]],
    device const bfloat* w     [[buffer(2)]],
    device bfloat*       out   [[buffer(3)]],
    constant ConvParams& p     [[buffer(4)]],
    uint2 tgp [[thread_position_in_grid]])
{
    const int c = tgp.x;
    const int t = tgp.y;
    float acc = 0.0f;
    for (int j = 0; j < p.K; ++j) {
        const int r = t + j;
        const float v = r < p.K - 1
            ? float(state[r * p.s_stride + c])
            : float(x[(r - (p.K - 1)) * p.x_stride + c]);
        acc += float(w[c * p.K + j]) * v;
    }
    out[t * p.C + c] = bfloat(acc / (1.0f + exp(-acc))); // silu
}

"#;

    #[repr(C)]
    struct GdnFusedParams {
        t: i32,
        xs: i32,
        ss: i32,
        abs_: i32,
        zs: i32,
        eps: f32,
        a_log: [f32; 64],
        dt_bias: [f32; 64],
    }

    static FUSED_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    /// One-dispatch GDN step: conv+silu, l2norm, delta recurrence and
    /// gated norm in a single kernel (48 threadgroups x 256 threads).
    /// `dstate` is updated in place; `pack` receives the normed q/k +
    /// raw v rows for the verify stash. Mirrors the conv -> qknorm ->
    /// scan -> gatenorm chain bit-for-bit in bf16 rounding.
    #[allow(clippy::too_many_arguments)]
    pub fn gdn_fused_step(
        xnew: &Tensor,    // [seq, conv_dim] strided view of the fused proj
        conv_st: &Tensor, // [k-1, conv_dim] bf16
        cw: &Tensor,      // [conv_dim, k] bf16
        dstate: &Tensor,  // [hv, dv, dk] f32 — mutated in place
        ab: &Tensor,      // [.., seq, 2*hv] strided
        z: &Tensor,       // [.., seq, hv*dv] strided
        normw: &Tensor,   // [dv] bf16
        y: &Tensor,       // [seq, hv*dv] bf16 out
        pack: &Tensor,    // [seq, conv_dim] bf16 out
        seq: usize,
        hk: usize,
        hv: usize,
        dk: usize,
        dv: usize,
        eps: f32,
        a_log: [f32; 64],
        dt_bias: [f32; 64],
    ) -> Result<()> {
        let (s_x, l_x) = xnew.storage_and_layout();
        let s_x = match &*s_x {
            Storage::Metal(m) => m,
            _ => candle_core::bail!("gdn_fused_step: Metal only"),
        };
        if seq > 8 || dk != dv {
            candle_core::bail!("gdn_fused_step: seq {} / dk {} / dv {}", seq, dk, dv);
        }
        let (s_st, l_st) = conv_st.storage_and_layout();
        let s_st = match &*s_st {
            Storage::Metal(m) => m,
            _ => candle_core::bail!("gdn_fused_step: Metal only"),
        };
        let (s_w, l_w) = cw.storage_and_layout();
        let s_w = match &*s_w {
            Storage::Metal(m) => m,
            _ => candle_core::bail!("gdn_fused_step: Metal only"),
        };
        let (s_ds, l_ds) = dstate.storage_and_layout();
        let s_ds = match &*s_ds {
            Storage::Metal(m) => m,
            _ => candle_core::bail!("gdn_fused_step: Metal only"),
        };
        let (s_ab, l_ab) = ab.storage_and_layout();
        let s_ab = match &*s_ab {
            Storage::Metal(m) => m,
            _ => candle_core::bail!("gdn_fused_step: Metal only"),
        };
        let (s_z, l_z) = z.storage_and_layout();
        let s_z = match &*s_z {
            Storage::Metal(m) => m,
            _ => candle_core::bail!("gdn_fused_step: Metal only"),
        };
        let (s_nw, l_nw) = normw.storage_and_layout();
        let s_nw = match &*s_nw {
            Storage::Metal(m) => m,
            _ => candle_core::bail!("gdn_fused_step: Metal only"),
        };
        let (s_y, l_y) = y.storage_and_layout();
        let s_y = match &*s_y {
            Storage::Metal(m) => m,
            _ => candle_core::bail!("gdn_fused_step: Metal only"),
        };
        let (s_pk, l_pk) = pack.storage_and_layout();
        let s_pk = match &*s_pk {
            Storage::Metal(m) => m,
            _ => candle_core::bail!("gdn_fused_step: Metal only"),
        };
        if !(l_x.stride().last() == Some(&1)
            && l_st.stride().last() == Some(&1)
            && l_ab.stride().last() == Some(&1)
            && l_z.stride().last() == Some(&1)
            && l_w.is_contiguous()
            && l_ds.is_contiguous()
            && l_nw.is_contiguous()
            && l_y.is_contiguous()
            && l_pk.is_contiguous())
        {
            candle_core::bail!(
                "gdn_fused_step layouts: x {:?} st {:?} ab {:?} z {:?} w {:?} ds {:?}",
                l_x.shape(), l_st.shape(), l_ab.shape(), l_z.shape(),
                l_w.shape(), l_ds.shape()
            );
        }
        let b2 = DType::BF16.size_in_bytes();
        if s_x.dtype() != DType::BF16 || s_w.dtype() != DType::BF16
            || s_st.dtype() != DType::BF16 || s_ab.dtype() != DType::BF16
            || s_z.dtype() != DType::BF16 || s_nw.dtype() != DType::BF16
            || s_y.dtype() != DType::BF16 || s_pk.dtype() != DType::BF16
            || s_ds.dtype() != DType::F32
        {
            candle_core::bail!("gdn_fused_step dtypes");
        }

        let device = s_x.device();
        if FUSED_PIPE.get().is_none() {
            let src = SOURCE_TMPL
                .replace("{HK}", &hk.to_string())
                .replace("{HV}", &hv.to_string())
                .replace("{DK}", &dk.to_string())
                .replace("{DV}", &dv.to_string());
            let raw = device.metal_device();
            let lib = raw
                .new_library_with_source(&src, None)
                .map_err(candle_core::Error::wrap)?;
            let f = lib
                .get_function("gdn_fused_step", None)
                .map_err(candle_core::Error::wrap)?;
            let pipe = raw
                .new_compute_pipeline_state_with_function(&f)
                .map_err(candle_core::Error::wrap)?;
            let _ = FUSED_PIPE.set(pipe);
        }
        let pipeline = FUSED_PIPE.get().unwrap();

        let row_str = |l: &Layout| -> usize {
            let d = l.shape().dims();
            l.stride()[d.len() - 2]
        };
        let params = GdnFusedParams {
            t: seq as i32,
            xs: row_str(l_x) as i32,
            ss: row_str(l_st) as i32,
            abs_: row_str(l_ab) as i32,
            zs: row_str(l_z) as i32,
            eps,
            a_log,
            dt_bias,
        };

        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("gdn_fused_step");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(pipeline);
        enc.set_input_buffer(0, Some(s_x.buffer()), l_x.start_offset() * b2);
        enc.set_input_buffer(1, Some(s_st.buffer()), l_st.start_offset() * b2);
        enc.set_input_buffer(2, Some(s_w.buffer()), l_w.start_offset() * b2);
        enc.set_output_buffer(
            3,
            Some(s_ds.buffer()),
            l_ds.start_offset() * DType::F32.size_in_bytes(),
        );
        enc.set_input_buffer(4, Some(s_ab.buffer()), l_ab.start_offset() * b2);
        enc.set_input_buffer(5, Some(s_z.buffer()), l_z.start_offset() * b2);
        enc.set_input_buffer(6, Some(s_nw.buffer()), l_nw.start_offset() * b2);
        enc.set_output_buffer(7, Some(s_y.buffer()), l_y.start_offset() * b2);
        enc.set_output_buffer(8, Some(s_pk.buffer()), l_pk.start_offset() * b2);
        enc.set_bytes(9, &params);
        enc.dispatch_thread_groups(
            MTLSize { width: hv, height: 1, depth: 1 },
            MTLSize { width: 256, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(())
    }

    static CONV_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    impl CustomOp3 for GdnConv {
        fn name(&self) -> &'static str {
            "gdn-conv"
        }

        fn cpu_fwd(
            &self,
            _: &CpuStorage,
            _: &Layout,
            _: &CpuStorage,
            _: &Layout,
            _: &CpuStorage,
            _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("gdn-conv: Metal only")
        }

        fn metal_fwd(
            &self,
            s_state: &MetalStorage,
            l_state: &Layout,
            s_x: &MetalStorage,
            l_x: &Layout,
            s_w: &MetalStorage,
            l_w: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            if l_x.stride().last() != Some(&1)
                || l_state.stride().last() != Some(&1)
                || !l_w.is_contiguous()
            {
                candle_core::bail!(
                    "gdn-conv layouts: x {:?} state {:?} need contiguous \
                     inner dim; w {:?} contiguous",
                    l_x.shape(),
                    l_state.shape(),
                    l_w.shape()
                );
            }
            if s_x.dtype() != DType::BF16
                || s_w.dtype() != DType::BF16
                || s_state.dtype() != DType::BF16
            {
                candle_core::bail!("gdn-conv dtypes: x/state/w must be bf16");
            }
            let device = s_x.device();
            if CONV_PIPE.get().is_none() {
                let raw = device.metal_device();
                let lib = raw
                    .new_library_with_source(CONV_SRC, None)
                    .map_err(candle_core::Error::wrap)?;
                let f = lib
                    .get_function("gdn_conv", None)
                    .map_err(candle_core::Error::wrap)?;
                let p = raw
                    .new_compute_pipeline_state_with_function(&f)
                    .map_err(candle_core::Error::wrap)?;
                let _ = CONV_PIPE.set(p);
            }
            let pipeline = CONV_PIPE.get().unwrap();

            let y_elems = self.t * self.c;
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(y_elems, DType::BF16)
                .with_label("gdn.conv_y")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("gdn_conv");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipeline);
            enc.set_input_buffer(
                0,
                Some(s_state.buffer()),
                l_state.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_input_buffer(
                1,
                Some(s_x.buffer()),
                l_x.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_input_buffer(
                2,
                Some(s_w.buffer()),
                l_w.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_output_buffer(3, Some(&y_buf), 0);
            let nd = l_x.shape().dims().len();
            let params = ConvParams {
                t: self.t as i32,
                c: self.c as i32,
                k: self.k as i32,
                x_stride: l_x.stride()[nd - 2] as i32,
                s_stride: l_state.stride()[l_state.shape().dims().len() - 2]
                    as i32,
            };
            enc.set_bytes(4, &params);
            // ≤1024 threads per group: 256 lanes × up to 4 rows
            enc.dispatch_threads(
                MTLSize { width: self.c, height: self.t, depth: 1 },
                MTLSize {
                    width: self.c.min(256),
                    height: self.t.min(4).max(1),
                    depth: 1,
                },
            );
            let storage =
                MetalStorage::new(y_buf, device.clone(), y_elems, DType::BF16);
            Ok((storage, Shape::from((self.t, self.c))))
        }
    }

    /// Fused residual add + RMSNorm: `out[0] = x + r` (the new residual
    /// stream) and `out[1] = rms_norm(out[0]) * w`. Replaces two
    /// dispatches per layer boundary.
    pub struct AddRmsNorm {
        pub t: usize,
        pub c: usize,
        pub eps: f32,
    }

    #[repr(C)]
    struct ArnParams {
        t: i32,
        c: i32,
        eps: f32,
    }

    const ARN_SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct ArnParams { int T; int C; float eps; };

// one threadgroup of 256 = 8 simdgroups, one sg per row
kernel void add_rmsnorm(
    device const bfloat* x   [[buffer(0)]],
    device const bfloat* r   [[buffer(1)]],
    device const bfloat* w   [[buffer(2)]],
    device bfloat*       out [[buffer(3)]],   // [2, T, C]
    constant ArnParams&  p   [[buffer(4)]],
    uint3 tg [[threadgroup_position_in_grid]],
    uint  lane [[thread_index_in_simdgroup]],
    uint  sg [[simdgroup_index_in_threadgroup]])
{
    const int t = tg.x * 8 + sg;
    if (t >= p.T) return;
    device const bfloat* xr = x + t * p.C;
    device const bfloat* rr = r + t * p.C;
    device bfloat* res = out + t * p.C;
    device bfloat* nrm = out + (p.T + t) * p.C;
    float ss = 0.0f;
    for (int c = lane; c < p.C; c += 32) {
        const float v = float(xr[c]) + float(rr[c]);
        res[c] = bfloat(v);
        ss += v * v;
    }
    ss = simd_sum(ss);
    const float inv = rsqrt(ss / float(p.C) + p.eps);
    for (int c = lane; c < p.C; c += 32) {
        nrm[c] = bfloat(float(res[c]) * inv * float(w[c]));
    }
}
"#;

    static ARN_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    impl CustomOp3 for AddRmsNorm {
        fn name(&self) -> &'static str {
            "add-rmsnorm"
        }

        fn cpu_fwd(
            &self,
            _: &CpuStorage,
            _: &Layout,
            _: &CpuStorage,
            _: &Layout,
            _: &CpuStorage,
            _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("add-rmsnorm: Metal only")
        }

        fn metal_fwd(
            &self,
            s_x: &MetalStorage,
            l_x: &Layout,
            s_r: &MetalStorage,
            l_r: &Layout,
            s_w: &MetalStorage,
            l_w: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            if !l_x.is_contiguous() || !l_r.is_contiguous() || !l_w.is_contiguous() {
                candle_core::bail!("add-rmsnorm requires contiguous inputs");
            }
            if s_x.dtype() != DType::BF16
                || s_r.dtype() != DType::BF16
                || s_w.dtype() != DType::BF16
            {
                candle_core::bail!("add-rmsnorm dtypes must be bf16");
            }
            let device = s_x.device();
            if ARN_PIPE.get().is_none() {
                let raw = device.metal_device();
                let lib = raw
                    .new_library_with_source(ARN_SRC, None)
                    .map_err(candle_core::Error::wrap)?;
                let f = lib
                    .get_function("add_rmsnorm", None)
                    .map_err(candle_core::Error::wrap)?;
                let p = raw
                    .new_compute_pipeline_state_with_function(&f)
                    .map_err(candle_core::Error::wrap)?;
                let _ = ARN_PIPE.set(p);
            }
            let pipeline = ARN_PIPE.get().unwrap();

            let y_elems = 2 * self.t * self.c;
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(y_elems, DType::BF16)
                .with_label("arn.y")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("add_rmsnorm");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipeline);
            enc.set_input_buffer(
                0,
                Some(s_x.buffer()),
                l_x.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_input_buffer(
                1,
                Some(s_r.buffer()),
                l_r.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_input_buffer(
                2,
                Some(s_w.buffer()),
                l_w.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_output_buffer(3, Some(&y_buf), 0);
            let params = ArnParams {
                t: self.t as i32,
                c: self.c as i32,
                eps: self.eps,
            };
            enc.set_bytes(4, &params);
            enc.dispatch_thread_groups(
                MTLSize { width: self.t.div_ceil(8), height: 1, depth: 1 },
                MTLSize { width: 256, height: 1, depth: 1 },
            );
            let storage =
                MetalStorage::new(y_buf, device.clone(), y_elems, DType::BF16);
            Ok((storage, Shape::from((2, self.t, self.c))))
        }
    }
    // ---- fused q/k norm + gated output norm (share the GdnStep source) ----

    static QKN_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static GNORM_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    fn gdn_lib(
        device: &candle_core::MetalDevice,
        hk: usize,
        hv: usize,
        dk: usize,
        dv: usize,
    ) -> Result<&'static candle_metal_kernels::metal::Library> {
        use std::sync::Mutex;
        static LIB: Mutex<Option<candle_metal_kernels::metal::Library>> =
            Mutex::new(None);
        let mut guard = LIB.lock().unwrap();
        if guard.is_none() {
            let src = SOURCE_TMPL
                .replace("{HK}", &hk.to_string())
                .replace("{HV}", &hv.to_string())
                .replace("{DK}", &dk.to_string())
                .replace("{DV}", &dv.to_string());
            let raw = device.metal_device();
            *guard = Some(
                raw.new_library_with_source(&src, None)
                    .map_err(candle_core::Error::wrap)?,
            );
        }
        Ok(unsafe { &*(guard.as_ref().unwrap() as *const _) })
    }

    impl CustomOp1 for GdnQkNorm {
        fn name(&self) -> &'static str {
            "gdn-qknorm"
        }

        fn cpu_fwd(
            &self,
            _: &CpuStorage,
            _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("gdn-qknorm: Metal only")
        }

        fn metal_fwd(
            &self,
            s_x: &MetalStorage,
            l_x: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            // strided rows OK — inner (channel) dim must be contiguous
            if l_x.stride().last() != Some(&1) {
                candle_core::bail!(
                    "gdn-qknorm needs contiguous inner dim: {:?}",
                    l_x.shape()
                );
            }
            if s_x.dtype() != DType::BF16 {
                candle_core::bail!("gdn-qknorm dtype: bf16 only");
            }
            let device = s_x.device();
            if QKN_PIPE.get().is_none() {
                let lib = gdn_lib(device, self.hk, self.hv, self.dk, self.dv)?;
                let f = lib
                    .get_function("gdn_qknorm", None)
                    .map_err(candle_core::Error::wrap)?;
                let p = device
                    .metal_device()
                    .new_compute_pipeline_state_with_function(&f)
                    .map_err(candle_core::Error::wrap)?;
                let _ = QKN_PIPE.set(p);
            }
            let pipeline = QKN_PIPE.get().unwrap();

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("gdn_qknorm");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipeline);
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(l_x.shape().elem_count(), DType::BF16)
                .with_label("gdn.qknorm")
                .build()
                .map_err(candle_core::Error::wrap)?;
            enc.set_input_buffer(
                0,
                Some(s_x.buffer()),
                l_x.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_output_buffer(1, Some(&y_buf), 0);
            let stride = if l_x.shape().dims().len() >= 2 {
                l_x.stride()[l_x.shape().dims().len() - 2] as i32
            } else {
                0i32
            };
            enc.set_bytes(2, &stride);
            enc.dispatch_thread_groups(
                MTLSize {
                    width: 2 * self.hk + self.hv,
                    height: self.t,
                    depth: 1,
                },
                MTLSize { width: 32, height: 1, depth: 1 },
            );
            let out = MetalStorage::new(
                y_buf,
                device.clone(),
                l_x.shape().elem_count(),
                DType::BF16,
            );
            Ok((out, l_x.shape().clone()))
        }
    }

    impl CustomOp3 for GdnGateNorm {
        fn name(&self) -> &'static str {
            "gdn-gatenorm"
        }

        fn cpu_fwd(
            &self,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("gdn-gatenorm: Metal only")
        }

        fn metal_fwd(
            &self,
            s_o: &MetalStorage,
            l_o: &Layout,
            s_z: &MetalStorage,
            l_z: &Layout,
            s_w: &MetalStorage,
            l_w: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            if !l_o.is_contiguous() || !l_w.is_contiguous() {
                candle_core::bail!("gdn-gatenorm: o/w must be contiguous");
            }
            if l_z.stride().last() != Some(&1) {
                candle_core::bail!(
                    "gdn-gatenorm needs contiguous z inner dim: {:?}",
                    l_z.shape()
                );
            }
            if s_o.dtype() != DType::BF16
                || s_z.dtype() != DType::BF16
                || s_w.dtype() != DType::BF16
            {
                candle_core::bail!("gdn-gatenorm dtypes: bf16 only");
            }
            let device = s_o.device();
            if GNORM_PIPE.get().is_none() {
                let lib = gdn_lib(
                    device,
                    1,
                    self.hv,
                    self.dv,
                    self.dv,
                )?;
                let f = lib
                    .get_function("gdn_gatenorm", None)
                    .map_err(candle_core::Error::wrap)?;
                let p = device
                    .metal_device()
                    .new_compute_pipeline_state_with_function(&f)
                    .map_err(candle_core::Error::wrap)?;
                let _ = GNORM_PIPE.set(p);
            }
            let pipeline = GNORM_PIPE.get().unwrap();

            let y_elems = self.t * self.hv * self.dv;
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(y_elems, DType::BF16)
                .with_label("gdn.gated")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("gdn_gatenorm");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipeline);
            enc.set_input_buffer(
                0,
                Some(s_o.buffer()),
                l_o.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_input_buffer(
                1,
                Some(s_z.buffer()),
                l_z.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_input_buffer(
                2,
                Some(s_w.buffer()),
                l_w.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_output_buffer(3, Some(&y_buf), 0);
            enc.set_bytes(4, &(self.z_stride as i32));
            enc.set_bytes(5, &self.eps);
            enc.dispatch_thread_groups(
                MTLSize {
                    width: self.hv,
                    height: self.t,
                    depth: 1,
                },
                MTLSize { width: 32, height: 1, depth: 1 },
            );
            let storage =
                MetalStorage::new(y_buf, device.clone(), y_elems, DType::BF16);
            Ok((storage, Shape::from((self.t, self.hv, self.dv))))
        }
    }

}