//! Output allocation for custom kernels that write every element of
//! their output (MEM-2). `Tensor::zeros` on Metal is a blit
//! `fill_buffer`: it ends candle's shared compute encoder, opens a blit
//! encoder (a waitForFence on every live fence) and forces the next
//! compute op to open a fresh encoder. An uninitialised pooled buffer
//! (`Tensor::empty` — the same allocation K45's `AllocBf16` makes) costs
//! no encoder switch and no fill traffic. Where a consumer does need
//! zeros (K45 presum-block pad rows), the producing kernel writes them.
//!
//! `TH_OUT_ZEROS=1` (read once) restores the zero-filled allocation at
//! every `kernel_out` site — the in-binary A/B arm.

use candle_core::{DType, Device, Result, Shape, Tensor};

/// Whether `kernel_out` zero-fills (the A/B arm). Read once per process.
pub fn zero_outs() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        let on = matches!(std::env::var("TH_OUT_ZEROS").as_deref(), Ok(v) if v != "0");
        if on {
            tracing::info!("TH_OUT_ZEROS: kernel outputs zero-filled (MEM-2 A/B arm)");
        }
        on
    })
}

/// Output tensor for a kernel that overwrites every element before any
/// read. Callers uphold that contract — each call site states its
/// kernel's coverage; an unwritten element would expose stale pool
/// contents.
pub fn kernel_out<S: Into<Shape>>(shape: S, dtype: DType, dev: &Device) -> Result<Tensor> {
    if zero_outs() {
        Tensor::zeros(shape, dtype, dev)
    } else {
        // SAFETY: the paired kernel writes all elements (see call site).
        unsafe { Tensor::empty(shape, dtype, dev) }
    }
}

/// Bit-exact copy of `t` into a fresh buffer without a blit (T1 prefix-
/// cache capture/restore). `Tensor::empty` + `slice_set` of a contiguous
/// source is a blit `copy_from_buffer` in candle 0.11: like the zero fill
/// above it ends the shared compute encoder and waits on every live fence
/// — ~100 of them per checkpoint (48 GDN layers x conv + recurrent state),
/// 28-50 ms per mid-prefill capture on a loaded host. Contiguous Metal
/// sources are copied by one compute dispatch that moves 32-bit words (no
/// float conversion: -0.0, subnormals and NaN payloads survive); a strided
/// source's `contiguous()` is already a fresh copy by a compute kernel.
/// Falls back to the blit copy off Metal or when the byte offset / length
/// is not a multiple of 4.
pub fn copy_uninit(t: &Tensor) -> Result<Tensor> {
    if !t.is_contiguous() {
        return t.contiguous();
    }
    #[cfg(all(feature = "metal", target_os = "macos"))]
    {
        // SAFETY: on Ok(true) the dispatch wrote every byte of `out`
        let out = unsafe { Tensor::empty(t.shape(), t.dtype(), t.device())? };
        if metal_copy::copy_into(t, &out, 0)? {
            return Ok(out);
        }
    }
    // SAFETY: slice_set below overwrites all elements (same shape, offset 0)
    let out = unsafe { Tensor::empty(t.shape(), t.dtype(), t.device())? };
    out.slice_set(t, 0, 0)?;
    Ok(out)
}

/// `Tensor::cat(parts, 0)` into a fresh buffer without blits (contiguous
/// parts with equal trailing dims — the checkpoint's capture rows): one
/// compute copy per part at its row offset. Falls back to `Tensor::cat`.
pub fn cat0_uninit(parts: &[Tensor]) -> Result<Tensor> {
    match parts {
        [] => candle_core::bail!("cat0_uninit: no parts"),
        [t] => return copy_uninit(t),
        _ => {}
    }
    #[cfg(all(feature = "metal", target_os = "macos"))]
    if parts.iter().all(|t| t.is_contiguous()) {
        let first = &parts[0];
        let tail = &first.dims()[1..];
        if parts.iter().all(|t| t.rank() == first.rank() && &t.dims()[1..] == tail && t.dtype() == first.dtype()) {
            let rows: usize = parts.iter().map(|t| t.dim(0)).sum::<Result<usize>>()?;
            let mut dims = first.dims().to_vec();
            dims[0] = rows;
            // SAFETY: when every part is copied, the parts cover all rows
            let out = unsafe { Tensor::empty(dims, first.dtype(), first.device())? };
            let row_bytes = tail.iter().product::<usize>() * first.dtype().size_in_bytes();
            let mut off = 0usize;
            let mut all = true;
            for t in parts {
                all &= metal_copy::copy_into(t, &out, off)?;
                off += t.dim(0)? * row_bytes;
            }
            if all {
                return Ok(out);
            }
        }
    }
    Tensor::cat(parts, 0)
}

#[cfg(all(feature = "metal", target_os = "macos"))]
mod metal_copy {
    use candle_core::{Result, Storage, Tensor};
    use candle_metal_kernels::metal::ComputePipeline;
    use candle_metal_kernels::utils::EncoderProvider;
    use objc2_metal::MTLSize;
    use std::sync::OnceLock;

    const SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;
kernel void th_copy_words(device const uint *src [[buffer(0)]],
                          device uint *dst [[buffer(1)]],
                          constant uint &n [[buffer(2)]],
                          uint i [[thread_position_in_grid]]) {
    if (i < n) dst[i] = src[i];
}
"#;

    static PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    /// Copy contiguous `src` into `dst` at byte offset `dst_off` (+ dst's
    /// own start offset) with one compute dispatch. Ok(false) (nothing
    /// enqueued) unless both are Metal, `src` is contiguous, and every
    /// offset and the length are multiples of 4 bytes that fit in `dst`.
    pub(super) fn copy_into(src: &Tensor, dst: &Tensor, dst_off: usize) -> Result<bool> {
        if !src.device().is_metal() || !dst.device().is_metal() || !src.is_contiguous() {
            return Ok(false);
        }
        let len = src.elem_count() * src.dtype().size_in_bytes();
        let (sst, sl) = src.storage_and_layout();
        let (dst_st, dl) = dst.storage_and_layout();
        let (Storage::Metal(s), Storage::Metal(d)) = (&*sst, &*dst_st) else {
            return Ok(false);
        };
        let s_off = sl.start_offset() * src.dtype().size_in_bytes();
        let d_off = dl.start_offset() * dst.dtype().size_in_bytes() + dst_off;
        let d_len = dst.elem_count() * dst.dtype().size_in_bytes();
        if len == 0
            || len % 4 != 0
            || s_off % 4 != 0
            || d_off % 4 != 0
            || dst_off + len > d_len
            || len / 4 > u32::MAX as usize
        {
            return Ok(false);
        }
        use candle_core::backend::BackendStorage;
        let device = s.device();
        if PIPE.get().is_none() {
            let raw = device.metal_device();
            let lib = raw.new_library_with_source(SRC, None).map_err(candle_core::Error::wrap)?;
            let f = lib.get_function("th_copy_words", None).map_err(candle_core::Error::wrap)?;
            let p = raw.new_compute_pipeline_state_with_function(&f).map_err(candle_core::Error::wrap)?;
            let _ = PIPE.set(p);
        }
        let n = (len / 4) as u32;
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("th_copy_words");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder = enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(PIPE.get().unwrap());
        enc.set_input_buffer(0, Some(s.buffer()), s_off);
        enc.set_output_buffer(1, Some(d.buffer()), d_off);
        enc.set_bytes(2, &n);
        let tg = 256usize;
        enc.dispatch_thread_groups(
            MTLSize { width: (n as usize).div_ceil(tg), height: 1, depth: 1 },
            MTLSize { width: tg, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(true)
    }
}

/// `copy_uninit` / `cat0_uninit` are bit-exact for every bit pattern
/// (random f32 / bf16 words: -0.0, subnormals, inf, NaN payloads), on the
/// compute path and on each fallback (odd byte length, misaligned offset,
/// strided source), and `cat0_uninit` equals `Tensor::cat`. Skips when no
/// Metal device exists.
#[cfg(all(test, feature = "metal", target_os = "macos"))]
mod tests {
    use super::*;
    use candle_core::{DType, Device};

    fn words(n: usize, seed: u64) -> Vec<u32> {
        let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        (0..n)
            .map(|i| {
                s ^= s >> 12;
                s ^= s << 25;
                s ^= s >> 27;
                let w = (s.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 32) as u32;
                // force the special classes to show up
                match i % 8 {
                    0 => 0x8000_0000,          // -0.0
                    1 => w & 0x807f_ffff,      // ± subnormal
                    2 => 0x7f80_0000 | w,      // inf / NaN with payload
                    _ => w,
                }
            })
            .collect()
    }

    fn bits(t: &Tensor) -> Result<Vec<u32>> {
        Ok(match t.dtype() {
            DType::F32 => t.flatten_all()?.to_vec1::<f32>()?.iter().map(|v| v.to_bits()).collect(),
            _ => t.flatten_all()?.to_vec1::<half::bf16>()?.iter().map(|v| v.to_bits() as u32).collect(),
        })
    }

    #[test]
    fn copies_are_bit_exact() -> Result<()> {
        let Ok(dev) = Device::new_metal(0) else {
            return Ok(());
        };
        let f = Tensor::from_vec(words(48 * 128 + 4, 1).into_iter().map(f32::from_bits).collect::<Vec<_>>(), (48 * 128 + 4,), &dev)?
            .reshape((1, 48 * 128 + 4))?;
        let b = Tensor::from_vec(
            words(3 * 1027, 2).into_iter().map(|w| half::bf16::from_bits(w as u16)).collect::<Vec<_>>(),
            (3, 1027),
            &dev,
        )?;
        let cases: Vec<(&str, Tensor)> = vec![
            ("f32 contiguous", f.clone()),
            ("bf16 even length", b.narrow(1, 0, 1026)?.contiguous()?),
            ("bf16 odd length (fallback)", Tensor::from_vec(vec![half::bf16::from_bits(0x8000), half::bf16::from_bits(1), half::bf16::from_bits(0x7fc1)], (3,), &dev)?),
            ("bf16 misaligned offset (fallback)", b.flatten_all()?.narrow(0, 1, 100)?),
            ("bf16 strided (contiguous())", b.t()?),
        ];
        for (name, t) in cases {
            let c = copy_uninit(&t)?;
            assert_eq!(c.dims(), t.dims(), "{name}");
            assert!(c.is_contiguous(), "{name}");
            assert_eq!(bits(&c)?, bits(&t)?, "{name}: bits changed");
        }
        // cat0: compute path (aligned rows) and fallback (bf16 rows of 1027 = odd bytes)
        let p1 = b.narrow(1, 0, 1026)?.contiguous()?;
        let p2 = Tensor::from_vec(words(5 * 1026, 3).into_iter().map(|w| half::bf16::from_bits(w as u16)).collect::<Vec<_>>(), (5, 1026), &dev)?;
        let p3 = p2.narrow(0, 1, 2)?;
        let got = cat0_uninit(&[p1.clone(), p2.clone(), p3.clone()])?;
        assert_eq!(bits(&got)?, bits(&Tensor::cat(&[p1, p2, p3], 0)?)?, "cat0 compute path");
        let q = b.narrow(0, 1, 2)?;
        let got = cat0_uninit(&[b.clone(), q.clone()])?;
        assert_eq!(bits(&got)?, bits(&Tensor::cat(&[b, q], 0)?)?, "cat0 fallback");
        Ok(())
    }
}
