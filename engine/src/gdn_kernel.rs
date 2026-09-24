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
pub use metal_impl::{AddRmsNorm, GdnConv, GdnStep};

#[cfg(all(feature = "metal", target_os = "macos"))]
mod metal_impl {
    use candle_core::backend::BackendStorage;
    use candle_core::{
        CpuStorage, CustomOp2, CustomOp3, DType, Layout, MetalStorage,
        Result, Shape,
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

    #[repr(C)]
    struct GdnParams {
        t: i32,
        a_log: [f32; 64],
        dt_bias: [f32; 64],
    }

    const SOURCE_TMPL: &str = r#"
#include <metal_stdlib>
#include <metal_math>
using namespace metal;

struct GdnParams {
    int T;
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
    device const float*  ab    [[buffer(1)]],
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
    device const float* a_ = ab + hv;
    device const float* b_ = ab + HV + hv;

    float s[n_per_t];
    for (int i = 0; i < n_per_t; ++i) s[i] = s_[dk0 + i];

    const float eA = exp(p.a_log[hv]);
    const float dtb = p.dt_bias[hv];

    for (int t = 0; t < p.T; ++t) {
        const int qo = t * qkv_stride;
        const float ap = a_[t * 2 * HV] + dtb;
        // softplus, overflow-safe: log(1+e^x) ≈ x for x > 30
        const float g = exp(-eA * (ap > 30.0f ? ap : log(1.0f + exp(ap))));
        const float beta = 1.0f / (1.0f + exp(-b_[t * 2 * HV]));

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
            if !(l_qkv.is_contiguous()
                && l_ab.is_contiguous()
                && l_state.is_contiguous())
            {
                candle_core::bail!(
                    "gated-delta-step requires contiguous inputs: \
                     qkv {:?} ab {:?} state {:?}",
                    l_qkv.shape(),
                    l_ab.shape(),
                    l_state.shape()
                );
            }
            if s_qkv.dtype() != DType::BF16
                || s_ab.dtype() != DType::F32
                || s_state.dtype() != DType::F32
            {
                candle_core::bail!(
                    "gated-delta-step dtypes: qkv bf16, ab f32, state f32"
                );
            }
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
                l_ab.start_offset() * DType::F32.size_in_bytes(),
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

    /// Depthwise causal conv + SiLU over the [window | inputs] buffer:
    /// `x` is [(k-1+T), C] bf16, `w` is [C, k] taps; output is
    /// [T, C] bf16. Replaces ~10 eager dispatches per layer.
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
    }

    const CONV_SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct ConvParams {
    int T;
    int C;
    int K;
};

// grid (C, T) — one thread per (channel, output row)
kernel void gdn_conv(
    device const bfloat* x   [[buffer(0)]],
    device const bfloat* w   [[buffer(1)]],
    device bfloat*       out [[buffer(2)]],
    constant ConvParams& p   [[buffer(3)]],
    uint2 tgp [[thread_position_in_grid]])
{
    const int c = tgp.x;
    const int t = tgp.y;
    float acc = 0.0f;
    for (int j = 0; j < p.K; ++j) {
        acc += float(w[c * p.K + j]) * float(x[(t + j) * p.C + c]);
    }
    out[t * p.C + c] = bfloat(acc / (1.0f + exp(-acc))); // silu
}
"#;

    static CONV_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    impl CustomOp2 for GdnConv {
        fn name(&self) -> &'static str {
            "gdn-conv"
        }

        fn cpu_fwd(
            &self,
            _: &CpuStorage,
            _: &Layout,
            _: &CpuStorage,
            _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("gdn-conv: Metal only")
        }

        fn metal_fwd(
            &self,
            s_x: &MetalStorage,
            l_x: &Layout,
            s_w: &MetalStorage,
            l_w: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            if !l_x.is_contiguous() || !l_w.is_contiguous() {
                candle_core::bail!(
                    "gdn-conv requires contiguous inputs: x {:?} w {:?}",
                    l_x.shape(),
                    l_w.shape()
                );
            }
            if s_x.dtype() != DType::BF16 || s_w.dtype() != DType::BF16 {
                candle_core::bail!("gdn-conv dtypes: x/w must be bf16");
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
                Some(s_x.buffer()),
                l_x.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_input_buffer(
                1,
                Some(s_w.buffer()),
                l_w.start_offset() * DType::BF16.size_in_bytes(),
            );
            enc.set_output_buffer(2, Some(&y_buf), 0);
            let params = ConvParams {
                t: self.t as i32,
                c: self.c as i32,
                k: self.k as i32,
            };
            enc.set_bytes(3, &params);
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
}
