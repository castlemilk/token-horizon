//! Fused Metal kernels for MLX affine-quantized weights.
//!
//! The checkpoint stores projections as packed U32 nibbles + per-group
//! bf16 scales/biases (`w = q·scale + bias`, group = GS, LSB-first).
//! Dequantizing to bf16 up front makes decode bandwidth-bound — a 27B
//! model reads ~54GB of weights per token (~130ms at ~500GB/s → ~7 tok/s
//! wall regardless of dispatch count). These kernels read the packed
//! form directly (~14GB/token → ~4× headroom).
//!
//!   AffineQmv     (wq, sb, x) → y[out]      fused dequant-matvec (seq=1)
//!   AffineDequant (wq, sb)    → w[out,in]   packed→bf16 scratch for the
//!                                           prefill gemm path
//!
//! `sb` packs scales and biases as [out, 2*ng]: columns [0,ng) are
//! scales, [ng,2ng) biases.

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::{AffineDequant, AffineQmv};

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

    /// Packed dims for one affine-quantized `[out, in]` weight.
    /// `gs` is baked into the shader (power of two; 64 for MLX defaults).
    pub struct AffineQmv {
        pub inp: usize,
        pub out: usize,
        pub gs: usize,
    }

    pub struct AffineDequant {
        pub inp: usize,
        pub out: usize,
        pub gs: usize,
    }

    #[repr(C)]
    struct QParams {
        in_dim: i32,
        out_dim: i32,
        ng: i32,
    }

    // words per row = IN/8; GS % 8 == 0 so a word never spans groups.
    const QMV_SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct QParams { int in_dim; int out_dim; int ng; };
constant constexpr int GS = {GS};

// 8 output rows per threadgroup — one simdgroup (32 lanes) per row.
// Each lane reads uint4 (16B = 32 nibbles) so rows walk memory in wide
// strides; x is shared across the 8 rows via L1/L2.
kernel void affine_qmv(
    device const uint*   wq [[buffer(0)]],
    device const bfloat* sb [[buffer(1)]],
    device const bfloat* x  [[buffer(2)]],
    device bfloat*       y  [[buffer(3)]],
    constant QParams&    p  [[buffer(4)]],
    uint3 tgpos [[threadgroup_position_in_grid]],
    uint  lane  [[thread_index_in_simdgroup]],
    uint  sg    [[simdgroup_index_in_threadgroup]])
{
    const int row = tgpos.x * 8 + sg;
    if (row >= p.out_dim) return;
    const int words = p.in_dim / 8;      // u32 per row
    const int words4 = words / 4;        // uint4 per row
    device const uint4* wrow =
        (device const uint4*)(wq + row * words);
    device const bfloat* srow = sb + row * 2 * p.ng;

    float acc = 0.0f;
    for (int w4 = lane; w4 < words4; w4 += 32) {
        const uint4 pack = wrow[w4];
        const int base = w4 * 32;
        // GS % 32 == 0 so a uint4 never spans a group boundary.
        const int g = base / GS;
        const float sc = float(srow[g]);
        const float bi = float(srow[p.ng + g]);
        const uint pw[4] = {pack.x, pack.y, pack.z, pack.w};
        for (int wd = 0; wd < 4; ++wd) {
            const uint pk = pw[wd];
            const int cb = base + wd * 8;
            for (int nib = 0; nib < 8; ++nib) {
                const float w =
                    float((pk >> (nib * 4)) & 0xF) * sc + bi;
                acc += w * float(x[cb + nib]);
            }
        }
    }
    acc = simd_sum(acc);
    if (lane == 0) y[row] = bfloat(acc);
}

// one threadgroup (256 threads) per output row — the v1 layout.
kernel void affine_qmv_v1(
    device const uint*   wq [[buffer(0)]],
    device const bfloat* sb [[buffer(1)]],
    device const bfloat* x  [[buffer(2)]],
    device bfloat*       y  [[buffer(3)]],
    constant QParams&    p  [[buffer(4)]],
    uint3 tgpos [[threadgroup_position_in_grid]],
    uint  tid   [[thread_index_in_threadgroup]],
    uint  lane  [[thread_index_in_simdgroup]],
    uint  sg    [[simdgroup_index_in_threadgroup]])
{
    const int row = tgpos.x;
    const int words = p.in_dim / 8;
    device const uint* wrow = wq + row * words;
    device const bfloat* srow = sb + row * 2 * p.ng;

    float acc = 0.0f;
    for (int wd = tid; wd < words; wd += 256) {
        const uint pack = wrow[wd];
        const int base = wd * 8;
        const int g = base / GS;
        const float sc = float(srow[g]);
        const float bi = float(srow[p.ng + g]);
        for (int nib = 0; nib < 8; ++nib) {
            const float w =
                float((pack >> (nib * 4)) & 0xF) * sc + bi;
            acc += w * float(x[base + nib]);
        }
    }
    acc = simd_sum(acc);
    threadgroup float red[8];
    if (lane == 0) red[sg] = acc;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tid == 0) {
        float t = red[0] + red[1] + red[2] + red[3]
                + red[4] + red[5] + red[6] + red[7];
        y[row] = bfloat(t);
    }
}
"#;

    const DEQ_SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct QParams { int in_dim; int out_dim; int ng; };
constant constexpr int GS = {GS};

kernel void affine_dequant(
    device const uint*   wq [[buffer(0)]],
    device const bfloat* sb [[buffer(1)]],
    device bfloat*       y  [[buffer(2)]],
    constant QParams&    p  [[buffer(3)]],
    uint idx [[thread_position_in_grid]])
{
    if (idx >= (uint)(p.in_dim * p.out_dim)) return;
    const int row = idx / p.in_dim;
    const int col = idx % p.in_dim;
    const uint pack = wq[row * (p.in_dim / 8) + col / 8];
    const float q = float((pack >> ((col % 8) * 4)) & 0xF);
    const int g = col / GS;
    y[idx] = bfloat(q * float(sb[row * 2 * p.ng + g])
                    + float(sb[row * 2 * p.ng + p.ng + g]));
}
"#;

    static QMV_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static QMV_V1_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static DEQ_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    fn compile(
        cell: &OnceLock<ComputePipeline>,
        src_tmpl: &str,
        gs: usize,
        fname: &str,
        device: &candle_core::MetalDevice,
    ) -> Result<()> {
        if cell.get().is_some() {
            return Ok(());
        }
        let src = src_tmpl.replace("{GS}", &gs.to_string());
        let raw = device.metal_device();
        let lib = raw
            .new_library_with_source(&src, None)
            .map_err(candle_core::Error::wrap)?;
        let f = lib
            .get_function(fname, None)
            .map_err(candle_core::Error::wrap)?;
        let p = raw
            .new_compute_pipeline_state_with_function(&f)
            .map_err(candle_core::Error::wrap)?;
        let _ = cell.set(p);
        Ok(())
    }

    fn check3(
        s: &MetalStorage,
        l: &Layout,
        want: DType,
        what: &str,
    ) -> Result<()> {
        if !l.is_contiguous() {
            candle_core::bail!("affine {what} not contiguous {:?}", l.shape());
        }
        if s.dtype() != want {
            candle_core::bail!("affine {what} dtype {:?} want {want:?}", s.dtype());
        }
        Ok(())
    }

    impl CustomOp3 for AffineQmv {
        fn name(&self) -> &'static str {
            "affine-qmv"
        }
        fn cpu_fwd(
            &self,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("affine-qmv: Metal only")
        }

        fn metal_fwd(
            &self,
            s_wq: &MetalStorage,
            l_wq: &Layout,
            s_sb: &MetalStorage,
            l_sb: &Layout,
            s_x: &MetalStorage,
            l_x: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            check3(s_wq, l_wq, DType::U32, "wq")?;
            check3(s_sb, l_sb, DType::BF16, "sb")?;
            check3(s_x, l_x, DType::BF16, "x")?;

            let device = s_wq.device();
            // v1 (one row per threadgroup) measured faster than the
            // 8-rows-per-group variant on M5 Max; keep both for A/B.
            let v2 = std::env::var("TH_QMV_V2").is_ok();
            let (cell, fname, groups) = if v2 {
                (&QMV_PIPE, "affine_qmv", self.out.div_ceil(8))
            } else {
                (&QMV_V1_PIPE, "affine_qmv_v1", self.out)
            };
            compile(cell, QMV_SRC, self.gs, fname, device)?;
            let pipeline = cell.get().unwrap();

            let y_buf = device
                .new_buffer_builder()
                .with_size_for(self.out, DType::BF16)
                .with_label("qmv.y")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("affine_qmv");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipeline);
            let params = QParams {
                in_dim: self.inp as i32,
                out_dim: self.out as i32,
                ng: (self.inp / self.gs) as i32,
            };
            enc.set_input_buffer(0, Some(s_wq.buffer()), l_wq.start_offset() * 4);
            enc.set_input_buffer(1, Some(s_sb.buffer()), l_sb.start_offset() * 2);
            enc.set_input_buffer(2, Some(s_x.buffer()), l_x.start_offset() * 2);
            enc.set_output_buffer(3, Some(&y_buf), 0);
            enc.set_bytes(4, &params);
            enc.dispatch_thread_groups(
                MTLSize {
                    width: groups,
                    height: 1,
                    depth: 1,
                },
                MTLSize { width: 256, height: 1, depth: 1 },
            );
            let storage = MetalStorage::new(
                y_buf,
                device.clone(),
                self.out,
                DType::BF16,
            );
            Ok((storage, Shape::from((self.out,))))
        }
    }

    impl CustomOp2 for AffineDequant {
        fn name(&self) -> &'static str {
            "affine-dequant"
        }
        fn cpu_fwd(
            &self,
            _: &CpuStorage, _: &Layout, _: &CpuStorage, _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("affine-dequant: Metal only")
        }

        fn metal_fwd(
            &self,
            s_wq: &MetalStorage,
            l_wq: &Layout,
            s_sb: &MetalStorage,
            l_sb: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            check3(s_wq, l_wq, DType::U32, "wq")?;
            check3(s_sb, l_sb, DType::BF16, "sb")?;

            let device = s_wq.device();
            compile(&DEQ_PIPE, DEQ_SRC, self.gs, "affine_dequant", device)?;
            let pipeline = DEQ_PIPE.get().unwrap();

            let elems = self.out * self.inp;
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(elems, DType::BF16)
                .with_label("dequant.w")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("affine_dequant");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipeline);
            let params = QParams {
                in_dim: self.inp as i32,
                out_dim: self.out as i32,
                ng: (self.inp / self.gs) as i32,
            };
            enc.set_input_buffer(0, Some(s_wq.buffer()), l_wq.start_offset() * 4);
            enc.set_input_buffer(1, Some(s_sb.buffer()), l_sb.start_offset() * 2);
            enc.set_output_buffer(2, Some(&y_buf), 0);
            enc.set_bytes(3, &params);
            let tg = 256usize;
            enc.dispatch_thread_groups(
                MTLSize {
                    width: elems.div_ceil(tg),
                    height: 1,
                    depth: 1,
                },
                MTLSize { width: tg, height: 1, depth: 1 },
            );
            let storage =
                MetalStorage::new(y_buf, device.clone(), elems, DType::BF16);
            Ok((storage, Shape::from((self.out, self.inp))))
        }
    }
}
