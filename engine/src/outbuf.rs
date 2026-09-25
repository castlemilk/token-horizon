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
