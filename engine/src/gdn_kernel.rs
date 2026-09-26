//! Fused Metal kernel for the Gated DeltaNet recurrent step.
//!
//! Ports mlx-lm's `gated_delta_step` shader (gated_delta.py) into a
//! candle `CustomOp3`. One dispatch per layer replaces the eager
//! per-token scan (~40 tensor ops/token → 1 kernel per sequence chunk).
//!
//! Buffers (one slot per dispatch):
//!   qkv   [T, 2*Hk+Hv, Dw] bf16  rows = [q heads | k heads | v heads]
//!   ab    [T, 2*Hv]      bf16  rows = [a | b] raw projections
//!   state [Hv, Dv, Dk]   f32   recurrent state
//!   y     [T, Hv, Dv]    bf16  output
//! Params are passed by value: T + per-head A_log/dt_bias constants
//! (Hv ≤ 64). g = exp(-exp(A_log)·softplus(a+dt_bias)) and
//! β = sigmoid(b) are computed inside the kernel — zero eager ops.
//!
//! G1a parity state: every state-carrying kernel here reads the
//! recurrent state / conv window from one buffer (parity p) and writes
//! the result to a *different* buffer (parity 1-p) — never in place — so
//! the pre-verify state survives a speculative verify and a partial
//! accept re-scans only the committed rows from it (Splash's
//! current/next scheme, `docs/splash/runtime/metal/kernels/decode/
//! gdn.metal`). Written buffers are bound as outputs so candle's encoder
//! hazard tracking barriers the next consumer. The persistent buffers
//! belong to the caller (the slot); nothing here wraps an existing
//! buffer in a new `MetalStorage`.

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::{
    AddRmsNorm, GdnCommitLayer, GdnConv, GdnGateNorm, GdnQkNorm, GdnStep, gdn_commit_all,
    gdn_conv_carry, gdn_fused_step, gdn_step,
};

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

    /// One GDN recurrent scan over `T` tokens for a single layer
    /// ([`gdn_step`]). `a_log`/`dt_bias` are the layer's gate constants
    /// (Hv floats each, zero-padded to 64). Dims are baked into the shader
    /// at compile time.
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
        write_y: i32,
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
    int write_y;
};

constant constexpr int HK = {HK};
constant constexpr int HV = {HV};
constant constexpr int DK = {DK};
constant constexpr int DV = {DV};

// grid (32, Dv, Hv) threads, threadgroup (32, 4, 1):
// one simdgroup (x-lane) per (dv, hv) — each lane owns Dk/32 state elems.
// Out of place (G1a): reads `state` (parity p), writes `state_out`
// (parity 1-p); `y` only when write_y (a rollback re-scan skips it).
kernel void gated_delta_step(
    device const bfloat* qkv   [[buffer(0)]],
    device const bfloat* ab    [[buffer(1)]],
    device const float*  state [[buffer(2)]],
    device bfloat*       y     [[buffer(3)]],
    constant GdnParams&  p     [[buffer(4)]],
    device float*        state_out [[buffer(5)]],
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
    device const float* s_ = state + (hv * DV + dv) * DK;
    device float* so_ = state_out + (hv * DV + dv) * DK;
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
        if (p.write_y && lane == 0) y_[t * HV * DV + dv] = bfloat(out);
    }
    for (int i = 0; i < n_per_t; ++i) so_[dk0 + i] = s[i];
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
    int sums;    // K45: y is a Q4 presum block (8 rows + input sums)
    int commit;  // G1a rollback re-scan: state + conv window only
    int pack;    // write the step-rescan stash `pack`
};

// One-dispatch GDN step: conv+silu, per-head l2norm, delta recurrence
// and the gated output norm — one threadgroup per value head, 256
// threads. Sibling threadgroups sharing a k-head recompute its q/k
// conv+norm (registers are cheaper than a global round-trip); the
// hv%3==0 owner also writes them into `pack` for the verify stash
// (when p.pack). Delta state lives in registers across all T rows and
// writes back once. Exact-op parity with conv -> qknorm -> scan ->
// gatenorm: bf16 rounding at the conv, pack and out boundaries.
//
// G1a parity state: reads the recurrent state `dsi` and conv window
// `cst` (parity p) and writes the post-T-row state `dso` and window
// `cso` (parity 1-p), never in place. commit=1 is the rollback re-scan
// of the kept rows from the intact parity: the identical instruction
// stream through the recurrence (so the state is bit-identical to a
// kept-row forward), stopping before the gated norm (no y, no pack).
constant constexpr int TMAX = 8;
kernel void gdn_fused_step(
    device const bfloat* xnew  [[buffer(0)]],
    device const bfloat* cst   [[buffer(1)]],
    device const bfloat* cw    [[buffer(2)]],
    device const float*  dsi   [[buffer(3)]],
    device const bfloat* ab    [[buffer(4)]],
    device const bfloat* zz    [[buffer(5)]],
    device const bfloat* nw    [[buffer(6)]],
    device bfloat*       y     [[buffer(7)]],
    device bfloat*       pack  [[buffer(8)]],
    constant GdnFusedParams& p [[buffer(9)]],
    device float*        dso   [[buffer(10)]],
    device bfloat*       cso   [[buffer(11)]],
    uint hv  [[threadgroup_position_in_grid]],
    uint tid [[thread_index_in_threadgroup]],
    uint lane [[thread_index_in_simdgroup]],
    uint sg  [[simdgroup_index_in_threadgroup]])
{
    constexpr int C = 2 * HK * DK + HV * DV;
    constexpr int REP = HV / HK;
    const uint hk = hv / REP;
    const int T = p.t;
    const bool owner = (hv % REP) == 0;

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

    // ---- conv window carry: new row r = source row T + r of [cst | xnew]
    // (this head's v channels; its k-head's q/k channels by the owner) ----
    for (uint w = tid; w < uint(3 * DK) * 3u; w += 256) {
        const int i = int(w) % (3 * DK);
        const int r = int(w) / (3 * DK);
        if (i < 2 * DK && !owner) continue;
        int g;
        if (i < DK) g = int(hk) * DK + i;
        else if (i < 2 * DK) g = HK * DK + int(hk) * DK + (i - DK);
        else g = 2 * HK * DK + int(hv) * DV + (i - 2 * DK);
        const int s = T + r;
        cso[r * C + g] = s < 3 ? cst[s * p.ss + g] : xnew[(s - 3) * p.xs + g];
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
            if (p.pack) pack[t * C + g] = bfloat(sv);   // v rows go raw to the stash
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // ---- per-row l2norm on q/k (all siblings recompute; owner writes pack) ----
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
            if (owner && p.pack) {
                pack[t * C + hk * DK + e] = qb;
                pack[t * C + HK * DK + hk * DK + e] = kb;
            }
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // ---- delta recurrence: one simdgroup per dv row, stride 8 ----
    for (uint dv = sg; dv < uint(DV); dv += 8) {
        device const float* sr = dsi + (hv * DV + int(dv)) * DK;
        device float* sw = dso + (hv * DV + int(dv)) * DK;
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
        sw[4 * lane + 0] = s0; sw[4 * lane + 1] = s1;
        sw[4 * lane + 2] = s2; sw[4 * lane + 3] = s3;
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (p.commit) return;   // rollback re-scan: no gated norm / y

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
            const bfloat yv = bfloat(
                ov[t * DV + d] * inv * float(nw[d]) * zf / (1.0f + exp(-zf)));
            y[t * HV * DV + hv * DV + d] = yv;
            if (p.sums) ov[t * DV + d] = float(yv);
        }
        if (p.sums) {
            // K45: this head's two quant groups of the out projection's
            // input sums, in the Q4 decode tiles' lane pattern
            // simd_sum(y[64g + l] + y[64g + 32 + l]) (bit-identical)
            simdgroup_barrier(mem_flags::mem_threadgroup);
            device float* sums = (device float*)(y + 8 * HV * DV);
            const float s0 = simd_sum(ov[t * DV + lane] + ov[t * DV + 32 + lane]);
            const float s1 =
                simd_sum(ov[t * DV + 64 + lane] + ov[t * DV + 96 + lane]);
            if (lane == 0) {
                sums[(2 * hv) * 8 + t] = s0;
                sums[(2 * hv + 1) * 8 + t] = s1;
            }
        }
    }
    if (p.sums && int(sg) >= T) {
        // presum block padding: rows T..7 of this head are zero
        const int t = int(sg);
        for (int i = 0; i < DV / 32; ++i)
            y[t * HV * DV + hv * DV + lane * 4 + i] = bfloat(0.0f);
        if (lane == 0) {
            device float* sums = (device float*)(y + 8 * HV * DV);
            sums[(2 * hv) * 8 + t] = 0.0f;
            sums[(2 * hv + 1) * 8 + t] = 0.0f;
        }
    }
}

"#;

    static PIPELINE: OnceLock<ComputePipeline> = OnceLock::new();

    fn metal_of<'a>(
        g: &'a std::sync::RwLockReadGuard<'a, Storage>,
        what: &str,
    ) -> Result<&'a MetalStorage> {
        match &**g {
            Storage::Metal(m) => Ok(m),
            _ => candle_core::bail!("{what}: Metal only"),
        }
    }

    /// Out-of-place GDN scan over `p.t` rows (G1a): reads the recurrent
    /// state from `state_in` (parity p, never written) and writes the
    /// post-scan state to `state_out` (parity 1-p, a distinct buffer),
    /// plus the per-row outputs into `y` ([T, Hv*Dv] bf16) when given.
    /// `qkv` is the contiguous normed [q|k|v] pack [T, conv]; `ab` a
    /// strided [.., T, 2*Hv] bf16 view with a contiguous inner dim.
    pub fn gdn_step(
        p: &GdnStep,
        qkv: &Tensor,
        ab: &Tensor,
        state_in: &Tensor,
        state_out: &Tensor,
        y: Option<&Tensor>,
    ) -> Result<()> {
        let (g_qkv, l_qkv) = qkv.storage_and_layout();
        let s_qkv = metal_of(&g_qkv, "gated-delta-step")?;
        let (g_ab, l_ab) = ab.storage_and_layout();
        let s_ab = metal_of(&g_ab, "gated-delta-step")?;
        let (g_si, l_si) = state_in.storage_and_layout();
        let s_si = metal_of(&g_si, "gated-delta-step")?;
        let (g_so, l_so) = state_out.storage_and_layout();
        let s_so = metal_of(&g_so, "gated-delta-step")?;
        let yg = y.map(|t| t.storage_and_layout());
        let s_y = match &yg {
            Some((g, _)) => Some(metal_of(g, "gated-delta-step")?),
            None => None,
        };
        let l_shape = l_ab.shape();
        let l_strides = l_ab.stride();
        if !(l_qkv.is_contiguous()
            && l_si.is_contiguous()
            && l_so.is_contiguous()
            && l_strides.last() == Some(&1)
            && yg.as_ref().map_or(true, |(_, l)| l.is_contiguous()))
        {
            candle_core::bail!(
                "gated-delta-step layouts: qkv {:?} state {:?}/{:?} must be \
                 contiguous; ab {:?} needs contiguous inner dim",
                l_qkv.shape(),
                l_si.shape(),
                l_so.shape(),
                l_shape
            );
        }
        if s_qkv.dtype() != DType::BF16
            || s_ab.dtype() != DType::BF16
            || s_si.dtype() != DType::F32
            || s_so.dtype() != DType::F32
            || s_y.map_or(false, |m| m.dtype() != DType::BF16)
        {
            candle_core::bail!("gated-delta-step dtypes: qkv/ab/y bf16, state f32");
        }
        let n_state = p.hv * p.dv * p.dk;
        if p.hv > 64 || p.dk != p.dv {
            candle_core::bail!("gated-delta-step dims: hv {} dk {} dv {}", p.hv, p.dk, p.dv);
        }
        if l_si.shape().elem_count() != n_state || l_so.shape().elem_count() != n_state {
            candle_core::bail!("gated-delta-step: state elems != {n_state}");
        }
        if yg.as_ref().map_or(false, |(_, l)| l.shape().elem_count() < p.t * p.hv * p.dv) {
            candle_core::bail!("gated-delta-step: y smaller than [{}, {}]", p.t, p.hv * p.dv);
        }
        // parity invariant: the source state is never the destination
        let f4 = DType::F32.size_in_bytes();
        if s_si.buffer() == s_so.buffer()
            && l_si.start_offset() == l_so.start_offset()
        {
            candle_core::bail!("gated-delta-step: state_in aliases state_out");
        }
        let ab_stride = if l_shape.dims().len() >= 2 {
            l_strides[l_shape.dims().len() - 2]
        } else {
            l_shape.elem_count()
        };

        let device = s_qkv.device();
        if PIPELINE.get().is_none() {
            let src = SOURCE_TMPL
                .replace("{HK}", &p.hk.to_string())
                .replace("{HV}", &p.hv.to_string())
                .replace("{DK}", &p.dk.to_string())
                .replace("{DV}", &p.dv.to_string());
            let raw = device.metal_device();
            let lib = raw
                .new_library_with_source(&src, None)
                .map_err(candle_core::Error::wrap)?;
            let f = lib
                .get_function("gated_delta_step", None)
                .map_err(candle_core::Error::wrap)?;
            let pl = raw
                .new_compute_pipeline_state_with_function(&f)
                .map_err(candle_core::Error::wrap)?;
            let _ = PIPELINE.set(pl);
        }
        let pipeline = PIPELINE.get().unwrap();

        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("gated_delta_step");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(pipeline);
        let params = GdnParams {
            t: p.t as i32,
            ab_stride: ab_stride as i32,
            a_log: p.a_log,
            dt_bias: p.dt_bias,
            write_y: y.is_some() as i32,
        };
        let b2 = DType::BF16.size_in_bytes();
        enc.set_input_buffer(0, Some(s_qkv.buffer()), l_qkv.start_offset() * b2);
        enc.set_input_buffer(1, Some(s_ab.buffer()), l_ab.start_offset() * b2);
        enc.set_input_buffer(2, Some(s_si.buffer()), l_si.start_offset() * f4);
        match (s_y, yg.as_ref()) {
            (Some(m), Some((_, l))) => {
                enc.set_output_buffer(3, Some(m.buffer()), l.start_offset() * b2)
            }
            // never written (write_y = 0); any valid binding
            _ => enc.set_output_buffer(3, Some(s_so.buffer()), l_so.start_offset() * f4),
        }
        enc.set_bytes(4, &params);
        enc.set_output_buffer(5, Some(s_so.buffer()), l_so.start_offset() * f4);
        enc.dispatch_threads(
            MTLSize { width: 32, height: p.dv, depth: p.hv },
            MTLSize { width: 32, height: 4, depth: 1 },
        );
        drop(encoder);
        Ok(())
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

// G1a: the new conv window — last K-1 rows of [state | x] — written to a
// distinct buffer (the other parity): out[r] = source row T + r.
// grid (C, K-1) — one thread per (channel, window row)
kernel void gdn_conv_carry(
    device const bfloat* state [[buffer(0)]],
    device const bfloat* x     [[buffer(1)]],
    device bfloat*       out   [[buffer(2)]],
    constant ConvParams& p     [[buffer(3)]],
    uint2 tgp [[thread_position_in_grid]])
{
    const int c = tgp.x;
    const int r = tgp.y;
    const int s = p.T + r;
    out[r * p.C + c] = s < p.K - 1
        ? state[s * p.s_stride + c]
        : x[(s - (p.K - 1)) * p.x_stride + c];
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
        sums: i32,
        commit: i32,
        pack: i32,
    }

    static FUSED_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    /// One-dispatch GDN step: conv+silu, l2norm, delta recurrence and
    /// gated norm in a single kernel (48 threadgroups x 256 threads).
    /// Mirrors the conv -> qknorm -> scan -> gatenorm chain bit-for-bit
    /// in bf16 rounding.
    ///
    /// G1a parity state: reads `state_in` / `conv_in` (parity p) and
    /// writes the post-`seq`-row recurrent state to `state_out` and the
    /// new conv window (last k-1 rows of [conv_in | xnew]) to `conv_out`
    /// (parity 1-p) — both distinct from their inputs. `pack`, when given,
    /// receives the normed q/k + raw v rows (the step-rescan stash).
    /// Commit mode (`z` and `y` both `None`, the rollback re-scan of the
    /// kept rows) writes only `state_out`/`conv_out`, through the same
    /// instruction stream as a forward of those rows.
    #[allow(clippy::too_many_arguments)]
    pub fn gdn_fused_step(
        xnew: &Tensor,      // [seq, conv_dim] strided view of the fused proj
        conv_in: &Tensor,   // [k-1, conv_dim] bf16 — parity p (read)
        cw: &Tensor,        // [conv_dim, k] bf16
        state_in: &Tensor,  // [hv, dv, dk] f32 — parity p (read)
        state_out: &Tensor, // [hv, dv, dk] f32 — parity 1-p (written)
        conv_out: &Tensor,  // [k-1, conv_dim] bf16 contiguous — parity 1-p (written)
        ab: &Tensor,        // [.., seq, 2*hv] strided
        z: Option<&Tensor>, // [.., seq, hv*dv] strided; None = commit mode
        normw: &Tensor,     // [dv] bf16
        y: Option<&Tensor>, // [seq, hv*dv] bf16 out; None = commit mode
        pack: Option<&Tensor>, // [seq, conv_dim] bf16 out (stash) or None
        seq: usize,
        hk: usize,
        hv: usize,
        dk: usize,
        dv: usize,
        eps: f32,
        a_log: [f32; 64],
        dt_bias: [f32; 64],
        sums: bool,
    ) -> Result<()> {
        let commit = z.is_none();
        if commit != y.is_none() || (commit && (sums || pack.is_some())) {
            candle_core::bail!("gdn_fused_step: commit mode takes no z/y/pack/sums");
        }
        if seq == 0 || seq > 8 || dk != dv {
            candle_core::bail!("gdn_fused_step: seq {} / dk {} / dv {}", seq, dk, dv);
        }
        let (g_x, l_x) = xnew.storage_and_layout();
        let s_x = metal_of(&g_x, "gdn_fused_step")?;
        let (g_st, l_st) = conv_in.storage_and_layout();
        let s_st = metal_of(&g_st, "gdn_fused_step")?;
        let (g_w, l_w) = cw.storage_and_layout();
        let s_w = metal_of(&g_w, "gdn_fused_step")?;
        let (g_si, l_si) = state_in.storage_and_layout();
        let s_si = metal_of(&g_si, "gdn_fused_step")?;
        let (g_so, l_so) = state_out.storage_and_layout();
        let s_so = metal_of(&g_so, "gdn_fused_step")?;
        let (g_co, l_co) = conv_out.storage_and_layout();
        let s_co = metal_of(&g_co, "gdn_fused_step")?;
        let (g_ab, l_ab) = ab.storage_and_layout();
        let s_ab = metal_of(&g_ab, "gdn_fused_step")?;
        let (g_nw, l_nw) = normw.storage_and_layout();
        let s_nw = metal_of(&g_nw, "gdn_fused_step")?;
        let zg = z.map(|t| t.storage_and_layout());
        let yg = y.map(|t| t.storage_and_layout());
        let pg = pack.map(|t| t.storage_and_layout());
        let s_z = match &zg { Some((g, _)) => Some(metal_of(g, "gdn_fused_step")?), None => None };
        let s_y = match &yg { Some((g, _)) => Some(metal_of(g, "gdn_fused_step")?), None => None };
        let s_pk = match &pg { Some((g, _)) => Some(metal_of(g, "gdn_fused_step")?), None => None };
        let conv_dim = 2 * hk * dk + hv * dv;
        if !(l_x.stride().last() == Some(&1)
            && l_st.stride().last() == Some(&1)
            && l_ab.stride().last() == Some(&1)
            && zg.as_ref().map_or(true, |(_, l)| l.stride().last() == Some(&1))
            && l_w.is_contiguous()
            && l_si.is_contiguous()
            && l_so.is_contiguous()
            && l_co.is_contiguous()
            && l_nw.is_contiguous()
            && yg.as_ref().map_or(true, |(_, l)| l.is_contiguous())
            && pg.as_ref().map_or(true, |(_, l)| l.is_contiguous()))
        {
            candle_core::bail!(
                "gdn_fused_step layouts: x {:?} st {:?} ab {:?} w {:?} si {:?} so {:?} co {:?}",
                l_x.shape(), l_st.shape(), l_ab.shape(), l_w.shape(),
                l_si.shape(), l_so.shape(), l_co.shape()
            );
        }
        // the kernel hard-codes a 4-tap conv (3-row window) and DK == DV
        if l_st.shape().dims() != [3, conv_dim] || l_co.shape().dims() != [3, conv_dim] {
            candle_core::bail!(
                "gdn_fused_step: conv windows {:?} -> {:?}, want [3, {conv_dim}]",
                l_st.shape(),
                l_co.shape()
            );
        }
        let n_state = hv * dv * dk;
        if l_si.shape().elem_count() != n_state || l_so.shape().elem_count() != n_state {
            candle_core::bail!("gdn_fused_step: state elems != {n_state}");
        }
        let b2 = DType::BF16.size_in_bytes();
        let f4 = DType::F32.size_in_bytes();
        // parity invariant: outputs never alias the inputs they replace
        if (s_si.buffer() == s_so.buffer()
            && l_si.start_offset() == l_so.start_offset())
            || (s_st.buffer() == s_co.buffer()
                && l_st.start_offset() == l_co.start_offset())
        {
            candle_core::bail!("gdn_fused_step: state/conv output aliases its input");
        }
        if s_x.dtype() != DType::BF16 || s_w.dtype() != DType::BF16
            || s_st.dtype() != DType::BF16 || s_ab.dtype() != DType::BF16
            || s_co.dtype() != DType::BF16 || s_nw.dtype() != DType::BF16
            || s_z.map_or(false, |m| m.dtype() != DType::BF16)
            || s_y.map_or(false, |m| m.dtype() != DType::BF16)
            || s_pk.map_or(false, |m| m.dtype() != DType::BF16)
            || s_si.dtype() != DType::F32 || s_so.dtype() != DType::F32
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
            zs: zg.as_ref().map_or(0, |(_, l)| row_str(l)) as i32,
            eps,
            a_log,
            dt_bias,
            sums: sums as i32,
            commit: commit as i32,
            pack: pack.is_some() as i32,
        };
        if let (true, Some(sy), Some((_, l_y))) = (sums, s_y, yg.as_ref()) {
            // K45: y must hold the whole presum block (8 rows + sums) and
            // the kernel's 8-simdgroup row mapping needs hv*dv % 64 == 0
            let need = l_y.start_offset() * b2
                + crate::quant_kernel::presum_block_bytes(hv * dv);
            if sy.buffer().length() < need || dv % 64 != 0 || (hv * dv) % 64 != 0 {
                candle_core::bail!(
                    "gdn_fused_step: presum y buffer {} < {need}",
                    sy.buffer().length()
                );
            }
        }

        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("gdn_fused_step");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(pipeline);
        enc.set_input_buffer(0, Some(s_x.buffer()), l_x.start_offset() * b2);
        enc.set_input_buffer(1, Some(s_st.buffer()), l_st.start_offset() * b2);
        enc.set_input_buffer(2, Some(s_w.buffer()), l_w.start_offset() * b2);
        enc.set_input_buffer(3, Some(s_si.buffer()), l_si.start_offset() * f4);
        enc.set_input_buffer(4, Some(s_ab.buffer()), l_ab.start_offset() * b2);
        // commit mode never reads z/nw nor writes y/pack: bind any valid
        // buffers (the input x / the conv output) as placeholders
        match (s_z, zg.as_ref()) {
            (Some(m), Some((_, l))) => enc.set_input_buffer(5, Some(m.buffer()), l.start_offset() * b2),
            _ => enc.set_input_buffer(5, Some(s_x.buffer()), l_x.start_offset() * b2),
        }
        enc.set_input_buffer(6, Some(s_nw.buffer()), l_nw.start_offset() * b2);
        match (s_y, yg.as_ref()) {
            (Some(m), Some((_, l))) => enc.set_output_buffer(7, Some(m.buffer()), l.start_offset() * b2),
            _ => enc.set_output_buffer(7, Some(s_co.buffer()), l_co.start_offset() * b2),
        }
        match (s_pk, pg.as_ref()) {
            (Some(m), Some((_, l))) => enc.set_output_buffer(8, Some(m.buffer()), l.start_offset() * b2),
            _ => enc.set_output_buffer(8, Some(s_co.buffer()), l_co.start_offset() * b2),
        }
        enc.set_bytes(9, &params);
        enc.set_output_buffer(10, Some(s_so.buffer()), l_so.start_offset() * f4);
        enc.set_output_buffer(11, Some(s_co.buffer()), l_co.start_offset() * b2);
        enc.dispatch_thread_groups(
            MTLSize { width: hv, height: 1, depth: 1 },
            MTLSize { width: 256, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(())
    }

    // -- one dispatch for every layer's rollback commit -------------------

    /// One GDN layer's rollback commit for [`gdn_commit_all`]: the
    /// `gdn_fused_step` commit-mode operands of that layer.
    pub struct GdnCommitLayer<'a> {
        /// the stashed verify input rows [>= kept, conv_dim] (strided view)
        pub xnew: &'a Tensor,
        /// pre-verify conv window [3, conv_dim] bf16 (read)
        pub conv_in: &'a Tensor,
        /// depthwise taps [conv_dim, 4] bf16
        pub cw: &'a Tensor,
        /// pre-verify recurrent state [hv, dv, dk] f32 (read)
        pub state_in: &'a Tensor,
        /// the stashed [a | b] rows [.., >= kept, 2*hv] (strided view)
        pub ab: &'a Tensor,
        /// committed-parity state / window (written)
        pub state_out: &'a Tensor,
        pub conv_out: &'a Tensor,
        /// row of `consts` holding this layer's a_log / dt_bias
        pub layer: usize,
    }

    /// Mirrors `GdnCommitDesc` in COMMIT_SRC: GPU addresses (byte offsets
    /// applied) + row strides in elements.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CommitDesc {
        xnew: u64,
        cst: u64,
        cw: u64,
        dsi: u64,
        ab: u64,
        dso: u64,
        cso: u64,
        xs: i32,
        ss: i32,
        abs_: i32,
        layer: i32,
    }

    /// set_bytes carries at most 4 KiB — 56 layers of descriptors.
    const COMMIT_MAX_LAYERS: usize = 4096 / std::mem::size_of::<CommitDesc>();

    const COMMIT_SRC: &str = r#"
#include <metal_stdlib>
#include <metal_math>
using namespace metal;

constant constexpr int HK = {HK};
constant constexpr int HV = {HV};
constant constexpr int DK = {DK};
constant constexpr int DV = {DV};
constant constexpr int TMAX = 8;

struct GdnCommitDesc {
    device const bfloat* xnew;
    device const bfloat* cst;
    device const bfloat* cw;
    device const float*  dsi;
    device const bfloat* ab;
    device float*        dso;
    device bfloat*       cso;
    int xs;
    int ss;
    int abs_;
    int layer;
};

// G1a follow-up: every GDN layer's rollback commit in ONE dispatch, grid
// (HV, layers) — Splash's verify_gdn_commit shape. Per (hv, layer) this is
// gdn_fused_step's commit=1 instruction stream verbatim (gate/beta, conv
// window carry, conv+silu, l2norm, delta recurrence, state write-back),
// minus the work commit mode never consumes (q channels, the readout).
// Operands are reached through GPU addresses in `descs` (candle buffers
// are resident via the queue's residency set).
kernel void gdn_commit_all(
    constant GdnCommitDesc* descs [[buffer(0)]],
    device const float* consts    [[buffer(1)]],   // [layers][2][64]: a_log | dt_bias
    constant int& T_              [[buffer(2)]],
    uint2 tg   [[threadgroup_position_in_grid]],
    uint tid   [[thread_index_in_threadgroup]],
    uint lane  [[thread_index_in_simdgroup]],
    uint sg    [[simdgroup_index_in_threadgroup]])
{
    constexpr int C = 2 * HK * DK + HV * DV;
    constexpr int REP = HV / HK;
    const uint hv = tg.x;
    constant GdnCommitDesc& p = descs[tg.y];
    device const bfloat* xnew = p.xnew;
    device const bfloat* cst = p.cst;
    device const bfloat* cw = p.cw;
    device const bfloat* ab = p.ab;
    const uint hk = hv / REP;
    const int T = T_;
    const bool owner = (hv % REP) == 0;

    threadgroup float kn[TMAX * DK];
    threadgroup float vr[TMAX * DV];
    threadgroup float gdec[TMAX];
    threadgroup float bta[TMAX];

    {
        const float eA = exp(consts[p.layer * 128 + hv]);
        const float dtb = consts[p.layer * 128 + 64 + hv];
        for (int t = int(tid); t < T; t += 256) {
            const float ap = float(ab[t * p.abs_ + hv]) + dtb;
            gdec[t] = exp(-eA * (ap > 30.0f ? ap : log(1.0f + exp(ap))));
            bta[t] = 1.0f / (1.0f + exp(-float(ab[t * p.abs_ + HV + hv])));
        }
    }

    // conv window carry: new row r = source row T + r of [cst | xnew]
    for (uint w = tid; w < uint(3 * DK) * 3u; w += 256) {
        const int i = int(w) % (3 * DK);
        const int r = int(w) / (3 * DK);
        if (i < 2 * DK && !owner) continue;
        int g;
        if (i < DK) g = int(hk) * DK + i;
        else if (i < 2 * DK) g = HK * DK + int(hk) * DK + (i - DK);
        else g = 2 * HK * DK + int(hv) * DV + (i - 2 * DK);
        const int s = T + r;
        p.cso[r * C + g] = s < 3 ? cst[s * p.ss + g] : xnew[(s - 3) * p.xs + g];
    }

    // conv + silu on this head's k and v channels (q is never read here)
    for (uint w = tid; w < uint(2 * DK) * uint(T); w += 256) {
        const int i = DK + int(w) % (2 * DK);
        const int t = int(w) / (2 * DK);
        int g;
        if (i < 2 * DK) g = HK * DK + int(hk) * DK + (i - DK);
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
        if (i < 2 * DK) kn[t * DK + i - DK] = sv;
        else vr[t * DV + i - 2 * DK] = sv;
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // per-row l2norm on k
    for (int t = int(sg); t < T; t += 8) {
        float ks = 0.0f;
        for (int i = 0; i < DK / 32; ++i) {
            const float k = kn[t * DK + lane * 4 + i];
            ks += k * k;
        }
        ks = simd_sum(ks);
        const float ki = rsqrt(ks / DK + 1e-6f) * rsqrt(float(DK));
        for (int i = 0; i < DK / 32; ++i) {
            const int e = lane * 4 + i;
            const bfloat kb = bfloat(kn[t * DK + e] * ki);
            kn[t * DK + e] = float(kb);
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // delta recurrence: one simdgroup per dv row, stride 8
    for (uint dv = sg; dv < uint(DV); dv += 8) {
        device const float* sr = p.dsi + (hv * DV + int(dv)) * DK;
        device float* sw = p.dso + (hv * DV + int(dv)) * DK;
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
        }
        sw[4 * lane + 0] = s0; sw[4 * lane + 1] = s1;
        sw[4 * lane + 2] = s2; sw[4 * lane + 3] = s3;
    }
}
"#;

    static COMMIT_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    /// Every listed GDN layer's rollback commit (`gdn_fused_step` commit
    /// mode over the first `kept` stashed rows, pre-verify parity in,
    /// committed parity out) in ONE dispatch instead of one per layer.
    /// `consts` is `[n, 2, 64]` f32 (a_log | dt_bias per layer row).
    ///
    /// The kernel reaches the per-layer buffers through GPU addresses, so
    /// candle's encoder cannot see those reads/writes: a buffer barrier
    /// goes before the dispatch (inputs written earlier in this encoder)
    /// and after it (later readers of the written state, and pooled
    /// buffers the caller drops right after), and the first layer's state
    /// is bound as a tracked output so later encoders wait on this one's
    /// fence. The caller keeps every tensor alive across the call.
    #[allow(clippy::too_many_arguments)]
    pub fn gdn_commit_all(
        layers: &[GdnCommitLayer<'_>],
        consts: &Tensor,
        kept: usize,
        hk: usize,
        hv: usize,
        dk: usize,
        dv: usize,
    ) -> Result<()> {
        use objc2_metal::MTLBuffer as _;
        if layers.is_empty() {
            return Ok(());
        }
        if kept == 0 || kept > 8 || dk != dv || hv > 64 || hv % hk != 0 {
            candle_core::bail!("gdn_commit_all: kept {kept} hk {hk} hv {hv} dk {dk} dv {dv}");
        }
        if layers.len() > COMMIT_MAX_LAYERS {
            candle_core::bail!("gdn_commit_all: {} layers > {COMMIT_MAX_LAYERS}", layers.len());
        }
        let conv_dim = 2 * hk * dk + hv * dv;
        let n_state = hv * dv * dk;
        let (g_c, l_c) = consts.storage_and_layout();
        let s_c = metal_of(&g_c, "gdn_commit_all")?;
        if s_c.dtype() != DType::F32 || !l_c.is_contiguous() || l_c.dims().len() != 3
            || l_c.dims()[1..] != [2, 64]
        {
            candle_core::bail!("gdn_commit_all: consts {:?} must be contiguous f32 [n, 2, 64]", l_c.shape());
        }
        let n_consts = l_c.dims()[0];
        let b2 = DType::BF16.size_in_bytes() as u64;
        let f4 = DType::F32.size_in_bytes() as u64;
        let row_str = |l: &Layout| -> usize {
            let d = l.shape().dims();
            l.stride()[d.len() - 2]
        };
        let addr = |m: &MetalStorage, l: &Layout, esz: u64| -> u64 {
            m.buffer().as_ref().gpuAddress() + l.start_offset() as u64 * esz
        };
        let mut descs = [CommitDesc::default(); COMMIT_MAX_LAYERS];
        let mut first_out: Option<(candle_metal_kernels::metal::Buffer, usize)> = None;
        let device = s_c.device().clone();
        for (n, c) in layers.iter().enumerate() {
            let (g_x, l_x) = c.xnew.storage_and_layout();
            let s_x = metal_of(&g_x, "gdn_commit_all")?;
            let (g_st, l_st) = c.conv_in.storage_and_layout();
            let s_st = metal_of(&g_st, "gdn_commit_all")?;
            let (g_w, l_w) = c.cw.storage_and_layout();
            let s_w = metal_of(&g_w, "gdn_commit_all")?;
            let (g_si, l_si) = c.state_in.storage_and_layout();
            let s_si = metal_of(&g_si, "gdn_commit_all")?;
            let (g_ab, l_ab) = c.ab.storage_and_layout();
            let s_ab = metal_of(&g_ab, "gdn_commit_all")?;
            let (g_so, l_so) = c.state_out.storage_and_layout();
            let s_so = metal_of(&g_so, "gdn_commit_all")?;
            let (g_co, l_co) = c.conv_out.storage_and_layout();
            let s_co = metal_of(&g_co, "gdn_commit_all")?;
            // gdn_fused_step's checks, per layer
            if !(l_x.stride().last() == Some(&1)
                && l_st.stride().last() == Some(&1)
                && l_ab.stride().last() == Some(&1)
                && l_w.is_contiguous()
                && l_si.is_contiguous()
                && l_so.is_contiguous()
                && l_co.is_contiguous())
            {
                candle_core::bail!(
                    "gdn_commit_all layer {n} layouts: x {:?} st {:?} ab {:?} si {:?} so {:?} co {:?}",
                    l_x.shape(), l_st.shape(), l_ab.shape(), l_si.shape(), l_so.shape(), l_co.shape()
                );
            }
            let xd = l_x.shape().dims();
            let abd = l_ab.shape().dims();
            if l_st.shape().dims() != [3, conv_dim]
                || l_co.shape().dims() != [3, conv_dim]
                || xd.len() != 2
                || xd[1] != conv_dim
                || xd[0] < kept
                || abd.len() < 2
                || abd[abd.len() - 2] < kept
                || abd[abd.len() - 1] < 2 * hv
                || l_w.shape().elem_count() != conv_dim * 4
                || l_si.shape().elem_count() != n_state
                || l_so.shape().elem_count() != n_state
                || c.layer >= n_consts
            {
                candle_core::bail!(
                    "gdn_commit_all layer {n}: x {:?} ab {:?} windows {:?}/{:?} kept {kept} layer {} of {n_consts}",
                    l_x.shape(), l_ab.shape(), l_st.shape(), l_co.shape(), c.layer
                );
            }
            if (s_si.buffer() == s_so.buffer() && l_si.start_offset() == l_so.start_offset())
                || (s_st.buffer() == s_co.buffer() && l_st.start_offset() == l_co.start_offset())
            {
                candle_core::bail!("gdn_commit_all layer {n}: state/conv output aliases its input");
            }
            if s_x.dtype() != DType::BF16 || s_w.dtype() != DType::BF16
                || s_st.dtype() != DType::BF16 || s_ab.dtype() != DType::BF16
                || s_co.dtype() != DType::BF16
                || s_si.dtype() != DType::F32 || s_so.dtype() != DType::F32
            {
                candle_core::bail!("gdn_commit_all layer {n}: dtypes");
            }
            descs[n] = CommitDesc {
                xnew: addr(s_x, l_x, b2),
                cst: addr(s_st, l_st, b2),
                cw: addr(s_w, l_w, b2),
                dsi: addr(s_si, l_si, f4),
                ab: addr(s_ab, l_ab, b2),
                dso: addr(s_so, l_so, f4),
                cso: addr(s_co, l_co, b2),
                xs: row_str(l_x) as i32,
                ss: row_str(l_st) as i32,
                abs_: row_str(l_ab) as i32,
                layer: c.layer as i32,
            };
            if first_out.is_none() {
                first_out = Some((s_so.buffer().clone(), l_so.start_offset() * f4 as usize));
            }
        }
        if COMMIT_PIPE.get().is_none() {
            let src = COMMIT_SRC
                .replace("{HK}", &hk.to_string())
                .replace("{HV}", &hv.to_string())
                .replace("{DK}", &dk.to_string())
                .replace("{DV}", &dv.to_string());
            let raw = device.metal_device();
            let lib = raw
                .new_library_with_source(&src, None)
                .map_err(candle_core::Error::wrap)?;
            let f = lib
                .get_function("gdn_commit_all", None)
                .map_err(candle_core::Error::wrap)?;
            let pipe = raw
                .new_compute_pipeline_state_with_function(&f)
                .map_err(candle_core::Error::wrap)?;
            let _ = COMMIT_PIPE.set(pipe);
        }
        let pipeline = COMMIT_PIPE.get().unwrap();
        let t = kept as i32;
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("gdn_commit_all");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        // inputs may have been written earlier in this encoder (untracked)
        enc.insert_memory_barrier();
        enc.set_compute_pipeline_state(pipeline);
        enc.set_bytes_directly(
            0,
            layers.len() * std::mem::size_of::<CommitDesc>(),
            descs.as_ptr() as *const std::ffi::c_void,
        );
        enc.set_input_buffer(1, Some(s_c.buffer()), l_c.start_offset() * f4 as usize);
        enc.set_bytes(2, &t);
        if let Some((b, off)) = first_out.as_ref() {
            // tracked output: later encoders wait on this encoder's fence
            enc.set_output_buffer(3, Some(b), *off);
        }
        enc.dispatch_thread_groups(
            MTLSize { width: hv, height: layers.len(), depth: 1 },
            MTLSize { width: 256, height: 1, depth: 1 },
        );
        // later dispatches of this encoder must see the written state
        enc.insert_memory_barrier();
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

    static CARRY_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    /// G1a: write the new conv window — the last `k-1` rows of
    /// [conv_in | x] for a `t`-row input — into `conv_out` (the other
    /// parity; contiguous [k-1, C], never `conv_in`). `conv_in`/`x` may be
    /// strided views with a contiguous inner dim.
    pub fn gdn_conv_carry(
        conv_in: &Tensor,
        x: &Tensor,
        conv_out: &Tensor,
        t: usize,
        k: usize,
    ) -> Result<()> {
        let (g_s, l_s) = conv_in.storage_and_layout();
        let s_s = metal_of(&g_s, "gdn-conv-carry")?;
        let (g_x, l_x) = x.storage_and_layout();
        let s_x = metal_of(&g_x, "gdn-conv-carry")?;
        let (g_o, l_o) = conv_out.storage_and_layout();
        let s_o = metal_of(&g_o, "gdn-conv-carry")?;
        let c = l_o.shape().dims().last().copied().unwrap_or(0);
        if l_s.stride().last() != Some(&1)
            || l_x.stride().last() != Some(&1)
            || !l_o.is_contiguous()
            || l_o.shape().dims() != [k - 1, c]
            || l_s.shape().dims() != [k - 1, c]
            || l_x.shape().dims().last() != Some(&c)
            || l_x.shape().elem_count() < t * c
        {
            candle_core::bail!(
                "gdn-conv-carry layouts: state {:?} x {:?} out {:?} (t {t}, k {k})",
                l_s.shape(),
                l_x.shape(),
                l_o.shape()
            );
        }
        if s_s.dtype() != DType::BF16 || s_x.dtype() != DType::BF16 || s_o.dtype() != DType::BF16 {
            candle_core::bail!("gdn-conv-carry dtypes: bf16 only");
        }
        let b2 = DType::BF16.size_in_bytes();
        if s_s.buffer() == s_o.buffer()
            && l_s.start_offset() == l_o.start_offset()
        {
            candle_core::bail!("gdn-conv-carry: conv_out aliases conv_in");
        }
        let device = s_x.device();
        if CARRY_PIPE.get().is_none() {
            let raw = device.metal_device();
            let lib = raw
                .new_library_with_source(CONV_SRC, None)
                .map_err(candle_core::Error::wrap)?;
            let f = lib
                .get_function("gdn_conv_carry", None)
                .map_err(candle_core::Error::wrap)?;
            let pl = raw
                .new_compute_pipeline_state_with_function(&f)
                .map_err(candle_core::Error::wrap)?;
            let _ = CARRY_PIPE.set(pl);
        }
        let pipeline = CARRY_PIPE.get().unwrap();
        let row = |l: &Layout| -> usize {
            let d = l.shape().dims();
            if d.len() >= 2 { l.stride()[d.len() - 2] } else { d[0] }
        };
        let params = ConvParams {
            t: t as i32,
            c: c as i32,
            k: k as i32,
            x_stride: row(l_x) as i32,
            s_stride: row(l_s) as i32,
        };
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("gdn_conv_carry");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(pipeline);
        enc.set_input_buffer(0, Some(s_s.buffer()), l_s.start_offset() * b2);
        enc.set_input_buffer(1, Some(s_x.buffer()), l_x.start_offset() * b2);
        enc.set_output_buffer(2, Some(s_o.buffer()), l_o.start_offset() * b2);
        enc.set_bytes(3, &params);
        enc.dispatch_threads(
            MTLSize { width: c, height: k - 1, depth: 1 },
            MTLSize { width: c.min(256), height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(())
    }

    /// Fused residual add + RMSNorm: `out[0] = x + r` (the new residual
    /// stream) and `out[1] = rms_norm(out[0]) * w`. Replaces two
    /// dispatches per layer boundary.
    pub struct AddRmsNorm {
        pub t: usize,
        pub c: usize,
        pub eps: f32,
        /// K45: emit the normed plane as a Q4 presum block — 8 rows (rows
        /// >= t zero) followed by the f32 per-(group, row) input sums the
        /// MPP decode tiles would recompute (`quant_kernel::
        /// presum_block_bytes`). Requires t <= 8 and c % 64 == 0; the
        /// residual and normed values are bit-identical to `sums: false`.
        pub sums: bool,
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

// K45 presum form (T <= 8, C % 64 == 0; one threadgroup, simdgroup = row):
// out = res [T, C] | nrm [8, C] (rows >= T zero) | sums [C/64][8] f32.
// Same per-element arithmetic as add_rmsnorm; the sums use the Q4 decode
// tiles' lane pattern simd_sum(x[64g + l] + x[64g + 32 + l]).
kernel void add_rmsnorm_sums(
    device const bfloat* x   [[buffer(0)]],
    device const bfloat* r   [[buffer(1)]],
    device const bfloat* w   [[buffer(2)]],
    device bfloat*       out [[buffer(3)]],
    constant ArnParams&  p   [[buffer(4)]],
    uint  lane [[thread_index_in_simdgroup]],
    uint  sg [[simdgroup_index_in_threadgroup]])
{
    const int t = sg;
    const int ng = p.C / 64;
    device bfloat* nrm = out + (p.T + t) * p.C;
    device float* sums = (device float*)(out + (p.T + 8) * p.C);
    if (t >= p.T) {
        for (int c = lane; c < p.C; c += 32) nrm[c] = bfloat(0.0f);
        for (int g = lane; g < ng; g += 32) sums[g * 8 + t] = 0.0f;
        return;
    }
    device const bfloat* xr = x + t * p.C;
    device const bfloat* rr = r + t * p.C;
    device bfloat* res = out + t * p.C;
    float ss = 0.0f;
    for (int c = lane; c < p.C; c += 32) {
        const float v = float(xr[c]) + float(rr[c]);
        res[c] = bfloat(v);
        ss += v * v;
    }
    ss = simd_sum(ss);
    const float inv = rsqrt(ss / float(p.C) + p.eps);
    for (int g = 0; g < ng; ++g) {
        const int c0 = g * 64 + lane;
        const bfloat a = bfloat(float(res[c0]) * inv * float(w[c0]));
        const bfloat b = bfloat(float(res[c0 + 32]) * inv * float(w[c0 + 32]));
        nrm[c0] = a;
        nrm[c0 + 32] = b;
        const float s = simd_sum(float(a) + float(b));
        if (lane == 0) sums[g * 8 + t] = s;
    }
}
"#;

    static ARN_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static ARN_SUMS_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

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
            if ARN_PIPE.get().is_none() || ARN_SUMS_PIPE.get().is_none() {
                let raw = device.metal_device();
                let lib = raw
                    .new_library_with_source(ARN_SRC, None)
                    .map_err(candle_core::Error::wrap)?;
                for (cell, name) in
                    [(&ARN_PIPE, "add_rmsnorm"), (&ARN_SUMS_PIPE, "add_rmsnorm_sums")]
                {
                    let f = lib
                        .get_function(name, None)
                        .map_err(candle_core::Error::wrap)?;
                    let p = raw
                        .new_compute_pipeline_state_with_function(&f)
                        .map_err(candle_core::Error::wrap)?;
                    let _ = cell.set(p);
                }
            }
            if self.sums && (self.t == 0 || self.t > 8 || self.c % 64 != 0) {
                candle_core::bail!(
                    "add-rmsnorm sums needs t in 1..=8 and c % 64 == 0 (t {}, c {})",
                    self.t,
                    self.c
                );
            }
            let pipeline = if self.sums {
                ARN_SUMS_PIPE.get().unwrap()
            } else {
                ARN_PIPE.get().unwrap()
            };

            let y_elems = 2 * self.t * self.c;
            // presum form: residual [t, c], then the 8-row normed block +
            // sums (crate::quant_kernel::presum_block_bytes)
            let alloc_elems = if self.sums {
                self.t * self.c + crate::quant_kernel::presum_block_bytes(self.c) / 2
            } else {
                y_elems
            };
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(alloc_elems, DType::BF16)
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
                MTLSize {
                    width: if self.sums { 1 } else { self.t.div_ceil(8) },
                    height: 1,
                    depth: 1,
                },
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