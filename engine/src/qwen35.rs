// Qwen3.5 hybrid (Gated DeltaNet + periodic full attention) — the
// architecture Splash's 27B package implements, ported from the mlx-lm
// reference (mlx_lm/models/qwen3_5.py + gated_delta.py).
//
// Loads MLX-affine-quantized safetensors directly: a quantized weight is
// stored as `name.weight` U32 [out, in*bits/32] plus `name.scales` /
// `name.biases` BF16 [out, in/group_size]; we dequantize to BF16 at load.
// Norm and conv weights are stored unquantized (norm weights already
// carry the +1 offset — the converter pre-sanitized them).
//
// Per-layer layout (64 layers, (i+1) % 4 == 0 → full attention):
//   linear_attention (48 layers):
//     in_proj_qkv [10240×5120] → q[2048]|k[2048]|v[6144]
//     in_proj_z   [6144×5120]  → output gate
//     in_proj_b/a [48×5120]    → beta / decay input per v-head
//     conv1d depthwise k=4 + silu, recurrent gated delta rule in F32,
//     gated RMSNorm (norm then ×silu(z)), out_proj [5120×6144]
//   full_attention (16 layers):
//     q_proj [12288×5120] → per-head [256|256] query|gate split
//     k/v_proj [1024×5120] (4 kv heads), per-head q/k RMSNorm,
//     interleaved RoPE on first 64 of 256 dims (θ=1e7),
//     sigmoid output gate, o_proj [5120×6144]
//   mlp: swiglu 5120→17408

use anyhow::{bail, Context, Result};
use candle_core::{D, DType, Device, IndexOp, Tensor};
use rayon::prelude::*;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
pub struct Qwen35Config {
    pub hidden_size: usize,
    #[allow(dead_code)]
    pub intermediate_size: usize,
    pub num_hidden_layers: usize,
    pub num_attention_heads: usize,
    pub num_key_value_heads: usize,
    #[allow(dead_code)]
    pub vocab_size: usize,
    #[serde(default = "d_eps")]
    pub rms_norm_eps: f64,
    #[serde(default = "d_hd")]
    pub head_dim: usize,
    #[serde(default = "d_fai")]
    pub full_attention_interval: usize,
    #[serde(default)]
    pub linear_num_key_heads: usize,
    #[serde(default)]
    pub linear_num_value_heads: usize,
    #[serde(default = "d_khd")]
    pub linear_key_head_dim: usize,
    #[serde(default = "d_vhd")]
    pub linear_value_head_dim: usize,
    #[serde(default = "d_ck")]
    pub linear_conv_kernel_dim: usize,
    #[serde(default)]
    pub tie_word_embeddings: bool,
    #[serde(default)]
    pub rope_parameters: Option<RopeParams>,
    #[serde(default)]
    pub max_position_embeddings: usize,
}
fn d_eps() -> f64 { 1e-6 }
fn d_hd() -> usize { 256 }
fn d_fai() -> usize { 4 }
fn d_khd() -> usize { 128 }
fn d_vhd() -> usize { 128 }
fn d_ck() -> usize { 4 }

#[derive(Debug, Clone, Deserialize)]
pub struct RopeParams {
    #[serde(default = "d_theta")]
    pub rope_theta: f64,
    #[serde(default = "d_prf")]
    pub partial_rotary_factor: f64,
}
fn d_theta() -> f64 { 10_000_000.0 }
fn d_prf() -> f64 { 0.25 }

impl Qwen35Config {
    /// Config may be flat or nested under `text_config` (multimodal wrapper).
    pub fn from_json(v: &serde_json::Value) -> Result<Self> {
        let text = v.get("text_config").cloned().unwrap_or_else(|| v.clone());
        let mut c: Self = serde_json::from_value(text)?;
        if c.head_dim == 0 {
            c.head_dim = c.hidden_size / c.num_attention_heads;
        }
        if c.max_position_embeddings == 0 {
            c.max_position_embeddings = v["max_position_embeddings"]
                .as_u64()
                .unwrap_or(262144) as usize;
        }
        if c.rope_parameters.is_none() {
            c.rope_parameters =
                serde_json::from_value(v["rope_parameters"].clone()).ok();
        }
        Ok(c)
    }
    fn is_linear(&self, i: usize) -> bool {
        (i + 1) % self.full_attention_interval != 0
    }
}

// MARK: - MLX affine dequant

/// Dequantize an MLX affine-packed matrix to BF16 host data, one row per
/// rayon thread. weight: U32 [out, in*bits/32] — `bits` nibbles-packed
/// values per word, LSB first. scales/biases: BF16 [out, in/group_size].
fn dequant_affine(
    w: &[u32],
    scales: &[half::bf16],
    biases: &[half::bf16],
    out: usize,
    inp: usize,
    bits: usize,
    gs: usize,
) -> Vec<half::bf16> {
    let per_word = 32 / bits;
    let mask = (1u32 << bits) - 1;
    let mut res = vec![half::bf16::ZERO; out * inp];
    res.par_chunks_exact_mut(inp).enumerate().for_each(|(o, rrow)| {
        let wrow = &w[o * (inp / per_word)..(o + 1) * (inp / per_word)];
        let srow = &scales[o * (inp / gs)..(o + 1) * (inp / gs)];
        let brow = &biases[o * (inp / gs)..(o + 1) * (inp / gs)];
        for i in 0..inp {
            let g = i / gs;
            let q = (wrow[i / per_word] >> ((i % per_word) * bits)) & mask;
            rrow[i] =
                half::bf16::from_f64(q as f64 * srow[g].to_f64() + brow[g].to_f64());
        }
    });
    res
}

/// Sharded safetensors source: parses all headers up front, dequantizes
/// MLX triples (`weight`/`scales`/`biases`) to BF16 on `device` at get().
struct Weights {
    tensors: HashMap<String, Tensor>,
    device: Device,
    bits: usize,
    gs: usize,
}

impl Weights {
    fn load(files: &[std::path::PathBuf], device: &Device) -> Result<Self> {
        let mut tensors = HashMap::new();
        for f in files {
            let raw = std::fs::read(f).with_context(|| f.display().to_string())?;
            let st = safetensors::SafeTensors::deserialize(&raw)
                .with_context(|| f.display().to_string())?;
            for (name, view) in st.tensors() {
                let dtype = match view.dtype() {
                    safetensors::Dtype::U32 => DType::U32,
                    safetensors::Dtype::BF16 => DType::BF16,
                    safetensors::Dtype::F32 => DType::F32,
                    safetensors::Dtype::F16 => DType::F16,
                    other => bail!("{name}: unsupported dtype {other:?}"),
                };
                let t = Tensor::from_raw_buffer(
                    view.data(),
                    dtype,
                    view.shape(),
                    &Device::Cpu,
                )?;
                tensors.insert(name.to_string(), t);
            }
        }
        Ok(Self { tensors, device: device.clone(), bits: 4, gs: 64 })
    }

    /// `key` is the tensor prefix without `.weight`; a `key.scales`
    /// sibling marks an MLX-quantized triple.
    fn get(&self, key: &str) -> Result<Tensor> {
        let wname = format!("{key}.weight");
        if self.tensors.contains_key(&format!("{key}.scales")) {
            let w = self.tensors.get(&wname).with_context(|| wname.clone())?;
            let s = self
                .tensors
                .get(&format!("{key}.scales"))
                .with_context(|| format!("{key}.scales"))?;
            let b = self
                .tensors
                .get(&format!("{key}.biases"))
                .with_context(|| format!("{key}.biases"))?;
            let dims = w.dims();
            let (out, in_pack) = (dims[0], *dims.last().unwrap());
            let inp = in_pack * (32 / self.bits);
            let wv: Vec<u32> = w.flatten_all()?.to_vec1()?;
            let sv: Vec<half::bf16> =
                s.flatten_all()?.to_dtype(DType::BF16)?.to_vec1()?;
            let bv: Vec<half::bf16> =
                b.flatten_all()?.to_dtype(DType::BF16)?.to_vec1()?;
            let data = dequant_affine(&wv, &sv, &bv, out, inp, self.bits, self.gs);
            return Tensor::from_vec(data, (out, inp), &self.device)
                .with_context(|| format!("dequant {key}"));
        }
        // bare parameter (A_log, dt_bias) or plain `key.weight`
        let t = self
            .tensors
            .get(&wname)
            .or_else(|| self.tensors.get(key))
            .with_context(|| wname.clone())?;
        t.to_dtype(DType::BF16)?
            .to_device(&self.device)
            .map_err(Into::into)
    }

    /// Projection weight: keeps MLX 4-bit packing on Metal (fused
    /// dequant-matvec reads ~4× less memory per token), dequantizes
    /// eagerly elsewhere.
    fn get_lin(&self, key: &str) -> Result<Lin> {
        let wname = format!("{key}.weight");
        if self.tensors.contains_key(&format!("{key}.scales")) {
            let w = self.tensors.get(&wname).with_context(|| wname.clone())?;
            let s = self
                .tensors
                .get(&format!("{key}.scales"))
                .with_context(|| format!("{key}.scales"))?;
            let b = self
                .tensors
                .get(&format!("{key}.biases"))
                .with_context(|| format!("{key}.biases"))?;
            let dims = w.dims();
            let (out, in_pack) = (dims[0], *dims.last().unwrap());
            let inp = in_pack * (32 / self.bits);
            let ng = inp / self.gs;
            if self.device.is_metal() {
                let wq = w.to_device(&self.device)?; // U32 [out, in/8]
                let sb = Tensor::cat(
                    &[
                        &s.reshape((out, ng))?
                            .to_dtype(DType::BF16)?
                            .to_device(&self.device)?,
                        &b.reshape((out, ng))?
                            .to_dtype(DType::BF16)?
                            .to_device(&self.device)?,
                    ],
                    1,
                )?
                .contiguous()?; // [out, 2*ng]
                return Ok(Lin::Quant(QLin {
                    wq,
                    sb,
                    out,
                    inp,
                    gs: self.gs,
                    tiled: false,
                }));
            }
            let wv: Vec<u32> = w.flatten_all()?.to_vec1()?;
            let sv: Vec<half::bf16> =
                s.flatten_all()?.to_dtype(DType::BF16)?.to_vec1()?;
            let bv: Vec<half::bf16> =
                b.flatten_all()?.to_dtype(DType::BF16)?.to_vec1()?;
            let data = dequant_affine(&wv, &sv, &bv, out, inp, self.bits, self.gs);
            return Ok(Lin::Dense(
                Tensor::from_vec(data, (out, inp), &self.device)
                    .with_context(|| format!("dequant {key}"))?,
            ));
        }
        Ok(Lin::Dense(self.get(key)?))
    }
}

/// A linear projection — either a dense bf16 weight or a packed
/// MLX-affine 4-bit weight evaluated by the fused kernels.
pub(crate) enum Lin {
    Dense(Tensor), // [out, in] bf16
    Quant(QLin),
}

#[derive(Clone)]
pub(crate) struct QLin {
    pub(crate) wq: Tensor,  // [out, in/8] u32 packed nibbles
    pub(crate) sb: Tensor,  // [out, 2*ng] bf16 — scales|biases
    pub(crate) out: usize,
    pub(crate) inp: usize,
    pub(crate) gs: usize,
    /// Splash-style `[tile][group][col]` storage — see `Self::tiled`.
    pub(crate) tiled: bool,
}

impl QLin {
    pub(crate) fn new(wq: Tensor, sb: Tensor, out: usize, inp: usize, gs: usize) -> Self {
        Self { wq, sb, out, inp, gs, tiled: false }
    }
}

impl QLin {
    /// CPU fallback for the packed form (dequantize, then matmul).
    fn cpu_dequant(&self) -> Result<Tensor> {
        let wv: Vec<u32> = self.wq.flatten_all()?.to_vec1()?;
        let ng = self.inp / self.gs;
        let sbv: Vec<half::bf16> = self
            .sb
            .flatten_all()?
            .to_dtype(DType::BF16)?
            .to_vec1()?;
        let (sv, bv) = sbv.split_at(self.out * ng);
        // sb is [out, 2*ng] row-major: scales row then biases row
        let mut sv2 = vec![half::bf16::ZERO; self.out * ng];
        let mut bv2 = vec![half::bf16::ZERO; self.out * ng];
        for o in 0..self.out {
            sv2[o * ng..(o + 1) * ng]
                .copy_from_slice(&sv[o * 2 * ng..o * 2 * ng + ng]);
            bv2[o * ng..(o + 1) * ng]
                .copy_from_slice(&sv[o * 2 * ng + ng..(o + 1) * 2 * ng]);
        }
        let _ = bv;
        let data =
            dequant_affine(&wv, &sv2, &bv2, self.out, self.inp, 4, self.gs);
        Tensor::from_vec(data, (self.out, self.inp), &self.wq.device())
            .map_err(Into::into)
    }

    /// K7: the m = 1 `AffineQmvT` matvec on tiled weights. `xv` is the
    /// one activation row as a contiguous `[in]` tensor. `up_row == 0`:
    /// plain projection → `[out]`; `up_row > 0`: fused [gate | up] weight
    /// with the up stream at row `up_row` → silu(gate)·up `[up_row]`.
    /// `None` when the kernel doesn't apply (untiled / non-64 groups /
    /// scalar reference / `TH_M1_PATH=mpp` / misaligned input) — the
    /// caller keeps its previous path.
    fn qmvt_m1(&self, xv: &Tensor, up_row: usize) -> Result<Option<Tensor>> {
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if xv.device().is_metal()
            && self.tiled
            && self.gs == 64
            && self.inp % 64 == 0
            && !crate::quant_kernel::qmm_scalar()
            && crate::quant_kernel::m1_path().qmvt(up_row > 0)
            && xv.layout().start_offset() % 8 == 0
        {
            let gate_up = up_row > 0;
            let out = if gate_up { up_row } else { self.out };
            return Ok(Some(self.wq.apply_op3_no_bwd(
                &self.sb,
                xv,
                &crate::quant_kernel::AffineQmvT {
                    inp: self.inp,
                    out,
                    tiles: self.out.div_ceil(256),
                    up_row,
                    cfg: crate::quant_kernel::qmvt_cfg(out, self.inp, gate_up),
                },
            )?));
        }
        let _ = (xv, up_row);
        Ok(None)
    }

    #[allow(dead_code)]
    fn linear(&self, x: &Tensor) -> Result<Tensor> {
        self.linear_ps(x, false)
    }

    /// `linear` with `presum`: `x` is a K45 presum block (its producer
    /// emitted the zero-padded 8-row operand + input sums), which the
    /// decode MPP tiles bind directly. Ignored on every other path — a
    /// presum block is also an ordinary [rows, in] tensor.
    pub(crate) fn linear_ps(&self, x: &Tensor, presum: bool) -> Result<Tensor> {
        let dims = x.dims().to_vec();
        let in_d = *dims.last().unwrap();
        let rows: usize = dims[..dims.len() - 1].iter().product();
        // The Metal kernels size their reads from `self.inp`, not from
        // x — a mismatched last dim is a silent GPU over-read (the MPP
        // pad pass reads rows*inp elements). Fail loudly instead.
        if in_d != self.inp {
            bail!(
                "QLin::linear: x last dim {in_d} != weight inp {} (x {:?})",
                self.inp,
                dims
            );
        }
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if x.device().is_metal() && in_d % 32 == 0 {
            if rows == 1 {
                // fused dequant-matvec — reads packed weights only
                let xv = x.reshape((in_d,))?.contiguous()?;
                if self.tiled && !crate::quant_kernel::qmm_scalar() {
                    // K7: tiled-layout matvec — no pad dispatch, no 8-row
                    // MMA block around the one live row
                    if let Some(y) = self.qmvt_m1(&xv, 0)? {
                        let mut out = dims;
                        *out.last_mut().unwrap() = self.out;
                        return Ok(y.reshape(out)?);
                    }
                    let xv8 = xv.reshape((1, in_d))?;
                    // K2: per-shape decode tile (n64s4 unless listed)
                    let (tile, sgs) =
                        crate::quant_kernel::plain_tile(self.out, self.inp).tile_sgs();
                    let y8 = self.wq.apply_op3_no_bwd(
                        &self.sb,
                        &xv8,
                        &crate::quant_kernel::AffineQmpp {
                            inp: self.inp,
                            out: self.out,
                            padded: self.out.div_ceil(256) * 256,
                            m: 1,
                            up_tile: 0,
                            sgs,
                            tile,
                            presum,
                            emit_sums: false,
                            groups: 0,
                            flags: 0,
                        },
                    )?;
                    let y = y8.narrow(0, 0, 1)?.contiguous()?;
                    let mut out = dims;
                    *out.last_mut().unwrap() = self.out;
                    return Ok(y.reshape(out)?);
                }
                let y = if crate::quant_kernel::qmv_sg()
                    && self.gs == 64
                    && self.inp % 64 == 0
                {
                    self.wq.apply_op3_no_bwd(
                        &self.sb,
                        &xv,
                        &crate::quant_kernel::AffineQsg {
                            inp: self.inp,
                            out: self.out,
                            m: 1,
                            aux: 0,
                            tiled: self.tiled,
                        },
                    )?
                } else {
                    self.wq.apply_op3_no_bwd(
                        &self.sb,
                        &xv,
                        &crate::quant_kernel::AffineQmv {
                            inp: self.inp,
                            out: self.out,
                            gs: self.gs,
                            tiled: self.tiled,
                        },
                    )?
                };
                let mut out = dims;
                *out.last_mut().unwrap() = self.out;
                return Ok(y.reshape(out)?);
            }
            if rows <= 8 {
                let xv = x.reshape((rows, in_d))?.contiguous()?;
                // cooperative-tensor (MPP) path on tiled weights — K2's
                // per-shape tile table (`plain_tile`: n64s4 by default,
                // N256 sg8 on GDN in_all, paired N256 sg4 on lm_head)
                if self.tiled && !crate::quant_kernel::qmm_scalar() {
                    let (tile, sgs) =
                        crate::quant_kernel::plain_tile(self.out, self.inp).tile_sgs();
                    let y8 = self.wq.apply_op3_no_bwd(
                        &self.sb,
                        &xv,
                        &crate::quant_kernel::AffineQmpp {
                            inp: self.inp,
                            out: self.out,
                            padded: self.out.div_ceil(256) * 256,
                            m: rows,
                            up_tile: 0,
                            sgs,
                            tile,
                            presum,
                            emit_sums: false,
                            groups: 0,
                            flags: 0,
                        },
                    )?;
                    let y = y8.narrow(0, 0, rows)?.contiguous()?;
                    let mut out = dims;
                    *out.last_mut().unwrap() = self.out;
                    return Ok(y.reshape(out)?);
                }
                // Splash-style fragment-direct MMA path — default; the
                // scalar qmm remains for A/B + non-64 group layouts.
                let y = if self.gs == 64
                    && self.inp % 64 == 0
                    && !crate::quant_kernel::qmm_scalar()
                {
                    self.wq.apply_op3_no_bwd(
                        &self.sb,
                        &xv,
                        &crate::quant_kernel::AffineQsg {
                            inp: self.inp,
                            out: self.out,
                            m: rows,
                            aux: 0,
                            tiled: self.tiled,
                        },
                    )?
                } else {
                    // scalar fallback — packed weight read once per call
                    self.wq.apply_op3_no_bwd(
                        &self.sb,
                        &xv,
                        &crate::quant_kernel::AffineQmm {
                            inp: self.inp,
                            out: self.out,
                            gs: self.gs,
                            m: rows,
                            tiled: self.tiled,
                        },
                    )?
                };
                let mut out = dims;
                *out.last_mut().unwrap() = self.out;
                return Ok(y.reshape(out)?);
            }
            // small-M prefill tiles (T2): exact [rows, out] output, tile
            // chosen per shape by `pf_route` (None → legacy path below).
            // Only for shape-consistent inputs: the fused draft_attn hands
            // o_proj [1, 8, 32, 128] (8 rows of 4096 read as 256 x 128),
            // which the legacy path has always absorbed by treating the
            // buffer as 256 x 4096 (rows 0..7 valid, the rest read out of
            // bounds and discarded) — keep that behaviour byte-for-byte.
            if self.tiled && in_d == self.inp {
                if let Some(cfg) =
                    crate::quant_kernel::pf_route(rows, self.out, self.inp, false)
                {
                    let xv = x.reshape((rows, in_d))?.contiguous()?;
                    let y = self.wq.apply_op3_no_bwd(
                        &self.sb,
                        &xv,
                        &crate::quant_kernel::AffineQpf {
                            inp: self.inp,
                            out: self.out,
                            padded: self.out.div_ceil(256) * 256,
                            m: rows,
                            up_tile: 0,
                            cfg,
                            // E1(c): > 8 rows + presum = a prefill presum
                            // block (the decode block only exists at <= 8)
                            presum,
                            emit: false,
                        },
                    )?;
                    let mut out = dims;
                    *out.last_mut().unwrap() = self.out;
                    return Ok(y.reshape(out)?);
                }
            }
            // prefill: cooperative-tensor kernel on tiled weights
            if self.tiled && !crate::quant_kernel::qmm_scalar() {
                let xv = x.reshape((rows, in_d))?.contiguous()?;
                let yp = self.wq.apply_op3_no_bwd(
                    &self.sb,
                    &xv,
                    &crate::quant_kernel::AffineQmppPrefill {
                        inp: self.inp,
                        out: self.out,
                        padded: self.out.div_ceil(256) * 256,
                        m: rows,
                        up_tile: 0,
                    },
                )?;
                let out_pad = self.out.div_ceil(256) * 256;
                let y = yp
                    .narrow(0, 0, rows)?
                    .narrow(1, 0, self.out)?
                    .contiguous()?;
                let mut out = dims;
                *out.last_mut().unwrap() = self.out;
                let _ = out_pad;
                return Ok(y.reshape(out)?);
            }
            // prefill: dequantize into scratch, then a normal bf16 gemm
            let w = self.wq.apply_op2_no_bwd(
                &self.sb,
                &crate::quant_kernel::AffineDequant {
                    inp: self.inp,
                    out: self.out,
                    gs: self.gs,
                    tiled: self.tiled,
                },
            )?;
            return linear(x, &w);
        }
        linear(x, &self.cpu_dequant()?)
    }

    /// Repack to Splash's `[tile=row/256][group][col=row%256]` layout:
    /// a simdgroup's 16-row fragment loads then hit one contiguous 512B
    /// span instead of eight 32B rows strided by `in/2`. Rows pad to a
    /// 256 multiple (zero nibbles + zero scale/bias → discarded output).
    ///
    /// Currently unused: measured +~7% on the sg kernel but ~-50% on
    /// qmv's row-streaming M=1 path — a net loss. Kept (with the
    /// kernels' `tiled` addressing flags) for the eventual
    /// `q4_mpp_tiles` port, which needs this layout.
    #[allow(dead_code)]
    pub(crate) fn tiled(mut self) -> Result<Self> {
        if self.tiled
            || self.gs != 64
            || self.inp % 64 != 0
            || !self.wq.device().is_metal()
        {
            return Ok(self);
        }
        let ng = self.inp / 64;
        let tiles = self.out.div_ceil(256);
        let padded = tiles * 256;
        let wv: Vec<u32> = self.wq.flatten_all()?.to_vec1()?;
        let sv: Vec<half::bf16> = self
            .sb
            .flatten_all()?
            .to_dtype(DType::BF16)?
            .to_vec1()?;
        let mut w2 = vec![0u32; padded * ng * 8];
        let mut s2 = vec![half::bf16::ZERO; 2 * padded * ng];
        let bias_base = padded * ng;
        // per-tile destination chunks are disjoint — parallel repack
        let nthr = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(8)
            .min(tiles);
        let wv = &wv;
        let sv = &sv;
        let out = self.out;
        let w_chunk = tiles.div_ceil(nthr) * ng * 2048;
        let s_chunk = tiles.div_ceil(nthr) * ng * 256;
        let (sc2, bi2) = s2.split_at_mut(bias_base);
        std::thread::scope(|scope| {
            let chunk_t = tiles.div_ceil(nthr);
            for (i, ((wi, sci), bii)) in w2
                .chunks_mut(w_chunk)
                .zip(sc2.chunks_mut(s_chunk))
                .zip(bi2.chunks_mut(s_chunk))
                .enumerate()
            {
                let t_start = i * chunk_t;
                let t_end = (t_start + chunk_t).min(tiles);
                scope.spawn(move || {
                    for t in t_start..t_end {
                        for g in 0..ng {
                            let dbase = (t - t_start) * ng * 2048 + g * 2048;
                            let sbase = (t - t_start) * ng * 256 + g * 256;
                            let grow = t * 256;
                            let rows = (out - grow).min(256);
                            for col in 0..rows {
                                let row = grow + col;
                                wi[dbase + col * 8..dbase + col * 8 + 8]
                                    .copy_from_slice(
                                        &wv[row * ng * 8 + g * 8..][..8],
                                    );
                                sci[sbase + col] = sv[row * 2 * ng + g];
                                bii[sbase + col] = sv[row * 2 * ng + ng + g];
                            }
                        }
                    }
                });
            }
        });
        self.wq =
            Tensor::from_vec(w2, (padded * ng * 8,), &self.wq.device())?;
        self.sb =
            Tensor::from_vec(s2, (2 * padded * ng,), &self.sb.device())?;
        self.tiled = true;
        Ok(self)
    }

    /// Fused gate/up activation for a [gate | up] packed projection —
    /// the kernel emits silu(gate)·up directly. `None` when the fast
    /// path doesn't apply (caller falls back to narrow+silu·mul).
    #[allow(dead_code)]
    pub(crate) fn gate_up_act(&self, x: &Tensor) -> Option<Result<Tensor>> {
        self.gate_up_act_ps(x, false).map(|r| r.map(|(t, _)| t))
    }

    /// `gate_up_act` with K45 presum blocks: `presum` = `x` is one (see
    /// `linear_ps`); the returned flag = the activation is one too (the
    /// N256 two-stream tile stored all 8 rows and emitted the down
    /// projection's input sums), so `down` can take `presum: true`.
    pub(crate) fn gate_up_act_ps(
        &self,
        x: &Tensor,
        presum: bool,
    ) -> Option<Result<(Tensor, bool)>> {
        let dims = x.dims().to_vec();
        let rows: usize = dims[..dims.len() - 1].iter().product();
        let in_d0 = *dims.last().unwrap();
        // prefill path: two-pass gate→scratch + up·silu(gate)
        if rows > 8
            && self.tiled
            && self.out % 2 == 0
            && (self.out / 2) % 256 == 0
            && !crate::quant_kernel::qmm_scalar()
        {
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if x.device().is_metal() {
                let xv = x.reshape((rows, in_d0)).ok()?.contiguous().ok()?;
                let half = self.out / 2;
                let padded = self.out.div_ceil(256) * 256;
                // small-M prefill tiles (T2): fused or two-pass gate/up
                // (shape-consistent inputs only, as in `linear`)
                if let Some(cfg) = (in_d0 == self.inp)
                    .then(|| crate::quant_kernel::pf_route(rows, half, self.inp, true))
                    .flatten()
                {
                    // E1(c): the vec up·silu pass emits the down projection's
                    // prefill presum block
                    let emit = cfg.vec && crate::quant_kernel::pf_presum_on(rows);
                    return Some(
                        self.wq
                            .apply_op3_no_bwd(
                                &self.sb,
                                &xv,
                                &crate::quant_kernel::AffineQpf {
                                    inp: self.inp,
                                    out: half,
                                    padded,
                                    m: rows,
                                    up_tile: half / 256,
                                    cfg,
                                    presum,
                                    emit,
                                },
                            )
                            .map_err(Into::into)
                            .and_then(|y| {
                                let mut out = dims.clone();
                                *out.last_mut().unwrap() = half;
                                Ok((y.reshape(out)?, emit))
                            }),
                    );
                }
                return Some(
                    self.wq
                        .apply_op3_no_bwd(
                            &self.sb,
                            &xv,
                            &crate::quant_kernel::AffineQmppPrefill {
                                inp: self.inp,
                                out: half,
                                padded,
                                m: rows,
                                up_tile: half / 256,
                            },
                        )
                        .map_err(Into::into)
                        .and_then(|yp| {
                            let mut out = dims.clone();
                            *out.last_mut().unwrap() = half;
                            Ok((
                                yp.narrow(0, 0, rows)?
                                    .narrow(1, 0, half)?
                                    .contiguous()?
                                    .reshape(out)?,
                                false,
                            ))
                        }),
                );
            }
        }
        // K7: m = 1 — tiled matvec with the fused silu·mul epilogue
        // (the MMA tiles would waste 7/8 of their work on padded rows).
        // A K45 presum block is also a plain [1, in] row, so `presum` is
        // ignored here, and the activation is returned as a plain tensor
        // (flag false): at m = 1 `down` takes the qmvt matvec as well,
        // which needs no input sums.
        if rows == 1 && self.out % 2 == 0 {
            let half = self.out / 2;
            let y = x
                .reshape((in_d0,))
                .and_then(|v| v.contiguous())
                .map_err(anyhow::Error::from)
                .and_then(|xv| self.qmvt_m1(&xv, half));
            return match y {
                Ok(Some(y)) => {
                    let mut out = dims.clone();
                    *out.last_mut().unwrap() = half;
                    Some(y.reshape(out).map(|y| (y, false)).map_err(Into::into))
                }
                Ok(None) => None,
                Err(e) => Some(Err(e)),
            };
        }
        // m==1 wastes 7/8 of the MMA work — the qmv path wins there
        if !(2..=8).contains(&rows) || self.out % 2 != 0 {
            return None;
        }
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if x.device().is_metal()
            && self.gs == 64
            && self.inp % 64 == 0
            && !crate::quant_kernel::qmm_scalar()
        {
            let in_d = *dims.last().unwrap();
            let half = self.out / 2;
            if self.tiled && half % 256 == 0 {
                let xv = x.reshape((rows, in_d)).ok()?.contiguous().ok()?;
                let padded = self.out.div_ceil(256) * 256;
                // K1: N256 two-stream tile (sequential K) by default
                let (tile, sgs) = crate::quant_kernel::gate_up_tile();
                // K45: the N256 tile emits the down projection's presum
                // block (the split-K legacy tile has no such epilogue)
                let emit = tile == 256 && sgs == 8 && crate::quant_kernel::presum_enabled();
                return Some(
                    self.wq
                        .apply_op3_no_bwd(
                            &self.sb,
                            &xv,
                            &crate::quant_kernel::AffineQmpp {
                                inp: self.inp,
                                out: half,
                                padded,
                                m: rows,
                                up_tile: half / 256,
                                sgs,
                                tile,
                                presum,
                                emit_sums: emit,
                                groups: 0,
                                flags: 0,
                            },
                        )
                        .map_err(Into::into)
                        .and_then(|y8| {
                            let mut out = dims.clone();
                            *out.last_mut().unwrap() = half;
                            Ok((
                                y8.narrow(0, 0, rows)?.contiguous()?.reshape(out)?,
                                emit,
                            ))
                        }),
                );
            }
            return Some((|| {
                let xv = x.reshape((rows, in_d))?.contiguous()?;
                let y = self.wq.apply_op3_no_bwd(
                    &self.sb,
                    &xv,
                    &crate::quant_kernel::AffineQsg {
                        inp: self.inp,
                        out: self.out / 2,
                        m: rows,
                        aux: self.out / 2,
                        tiled: self.tiled,
                    },
                )?;
                let mut out = dims;
                *out.last_mut().unwrap() = self.out / 2;
                Ok((y.reshape(out)?, false))
            })());
        }
        None
    }
}

/// Tile a packed weight for the MPP path — the cooperative-tensor
/// kernels need the [tile][group][col] layout. Default on for Metal;
/// `TH_QMM_MPP=0` keeps the row-major layout + scalar/sg kernels.
pub(crate) fn maybe_tiled(l: Lin) -> Result<Lin> {
    // resolve the IORegistry core count at load, not on the first request
    let _ = crate::quant_kernel::gpu_cores();
    if std::env::var("TH_QMM_MPP").map_or(true, |v| v != "0") {
        l.tiled()
    } else {
        Ok(l)
    }
}

impl Lin {
    /// Repack a packed weight into the tiled fragment layout — no-op
    /// for dense weights and non-Metal devices. Enabled via
    /// `maybe_tiled` (`TH_QMM_MPP`).
    pub(crate) fn tiled(self) -> Result<Lin> {
        match self {
            Lin::Quant(q) => Ok(Lin::Quant(q.tiled()?)),
            d => Ok(d),
        }
    }
}

/// x [.., in] @ w.t() for either weight representation.
pub(crate) fn lin_apply(x: &Tensor, l: &Lin) -> Result<Tensor> {
    lin_apply_ps(x, l, false)
}

/// `lin_apply` whose input may be a K45 presum block (`QLin::linear_ps`).
pub(crate) fn lin_apply_ps(x: &Tensor, l: &Lin, presum: bool) -> Result<Tensor> {
    match l {
        Lin::Dense(w) => linear(x, w),
        Lin::Quant(q) => q.linear_ps(x, presum),
    }
}

/// `TH_BENCH_Q4=1 th-engine probe …` — decode-projection bench on the
/// real weights (WP-2's companion to `bench_lin`). Per projection class
/// it times a pass over every layer's tensor — distinct weights, so the
/// pass streams from DRAM like the real forward (one repeated 17.7 MB
/// tensor would sit in the ~32 MB SLC) — through the production entry
/// points (`gate_up_act` / `linear`: whatever the tile policy picks),
/// the same path on a 2-byte-misaligned copy of the input (always takes
/// the pad copy: P0's reference arm), the K45 presum path (the input as
/// a presum block — what `add_rms_norm_ps` / the gate_up tile hand the
/// next projection), then explicit `AffineQmpp` tiles, each plain and
/// with a presum input (`+ps`). Passes are interleaved — each pass times
/// every candidate once, start rotated — and `xR vs path` is the median
/// per-pass ratio, so drift in GPU/memory contention cancels. max|Δ| is
/// vs the scalar `AffineQmm` reference on the class's first tensor;
/// Δpath is vs the production path's output (0 = bit-identical).
/// Host-timed (sync → enqueue a pass → sync), so µs/call includes ~2-5 µs
/// of encode. Env: `TH_BENCH_Q4_M` (rows, default 8),
/// `TH_BENCH_Q4_PASSES` (default 7), `TH_BENCH_Q4_SWEEP=1` (K45 autotune:
/// persistent-group sweeps per tile family, plus the DFlash draft shapes
/// timed on reinterpreted target tensors — timing/Δ only, the values are
/// meaningless), `TH_BENCH_Q4_ONLY=<class,..>` (subset).
#[cfg(all(feature = "metal", target_os = "macos"))]
pub(crate) fn bench_q4_decode(model: &Qwen35, device: &Device) -> Result<()> {
    use crate::quant_kernel::{AffineQmm, AffineQmpp, Q4AttachSums};
    let env_n = |k: &str, d: usize| {
        std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
    };
    let rows = env_n("TH_BENCH_Q4_M", 8).clamp(1, 8);
    let passes = env_n("TH_BENCH_Q4_PASSES", 7).max(1);
    let sweep = std::env::var("TH_BENCH_Q4_SWEEP").as_deref() == Ok("1");
    // serial (default): a buffer-scope barrier after every call, so calls
    // run back to back like the forward's dependent chain; `=0` lets
    // independent calls overlap on the concurrent encoder (the pre-K45
    // bench behaviour — it hides each dispatch's ramp and tail)
    let serial = std::env::var("TH_BENCH_Q4_SERIAL").as_deref() != Ok("0");
    let barrier = || -> Result<()> {
        if serial {
            if let Device::Metal(md) = device {
                use candle_metal_kernels::utils::EncoderProvider;
                let enc = md.command_encoder()?;
                let enc_ref = &enc;
                let e: &candle_metal_kernels::metal::ComputeCommandEncoder =
                    enc_ref.encoder().as_ref();
                e.insert_memory_barrier();
            }
        }
        Ok(())
    };
    let only: Option<Vec<String>> = std::env::var("TH_BENCH_Q4_ONLY")
        .ok()
        .map(|v| v.split(',').map(|s| s.trim().to_string()).collect());
    let cores = crate::quant_kernel::gpu_cores();
    let quant = |l: &Lin| match l {
        Lin::Quant(q) if q.tiled => Some(q.clone()),
        _ => None,
    };
    let gdn = |f: fn(&GdnLayer) -> &Lin| {
        model
            .layers
            .iter()
            .filter_map(|l| match &l.kind {
                Kind::Gdn(g) => quant(f(g)),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let attn = |f: fn(&AttnLayer) -> &Lin| {
        model
            .layers
            .iter()
            .filter_map(|l| match &l.kind {
                Kind::Attn(a) => quant(f(a)),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    // a tiled weight reinterpreted as a smaller [out, inp] tiled weight
    // (prefix views of the packed buffers) — draft-shape timing only
    let view = |q: &QLin, out: usize, inp: usize| -> Option<QLin> {
        let padded = out.div_ceil(256) * 256;
        let (nw, ns) = (padded * inp / 8, 2 * padded * (inp / 64));
        if q.wq.elem_count() < nw || q.sb.elem_count() < ns {
            return None;
        }
        Some(QLin {
            wq: q.wq.flatten_all().ok()?.narrow(0, 0, nw).ok()?,
            sb: q.sb.flatten_all().ok()?.narrow(0, 0, ns).ok()?,
            out,
            inp,
            gs: 64,
            tiled: true,
        })
    };
    let gate_ups: Vec<QLin> =
        model.layers.iter().filter_map(|l| quant(&l.mlp.gate_up)).collect();
    let in_alls = gdn(|g| &g.in_all);
    let outs = gdn(|g| &g.out);
    // (tag, tensors, gate_up, rows, synthetic)
    let mut classes: Vec<(String, Vec<QLin>, bool, usize, bool)> = vec![
        ("gate_up".into(), gate_ups.clone(), true, rows, false),
        ("down".into(), model.layers.iter().filter_map(|l| quant(&l.mlp.down)).collect(), false, rows, false),
        ("in_all".into(), in_alls.clone(), false, rows, false),
        ("out".into(), outs.clone(), false, rows, false),
        ("in_qkv".into(), attn(|a| &a.in_qkv), false, rows, false),
        ("o".into(), attn(|a| &a.o), false, rows, false),
        ("lm_head".into(), quant(&model.lm_head).into_iter().collect(), false, rows, false),
    ];
    if sweep {
        // DFlash draft projections (dflash.rs DraftLayer / Draft): propose
        // runs 8 rows through each layer, 7 through lm_head/selector; the
        // commit runs `retained` rows through fc (4 ~ a typical round)
        let mk = |src: &[QLin], out: usize, inp: usize| -> Vec<QLin> {
            src.iter().filter_map(|q| view(q, out, inp)).collect()
        };
        classes.push(("d_dyn".into(), mk(&in_alls, 1280, 5120), false, 8, true));
        classes.push(("d_qkv".into(), mk(&in_alls, 6144, 5120), false, 8, true));
        classes.push(("d_o".into(), mk(&outs, 5120, 4096), false, 8, true));
        classes.push(("d_gate".into(), mk(&gate_ups, 17408, 5120), false, 8, true));
        classes.push(("d_fc".into(), mk(&gate_ups, 5120, 25600), false, 4, true));
        classes.push(("d_sel".into(), mk(&in_alls, 256, 5120), false, 7, true));
        classes.push(("lm_head_m7".into(), quant(&model.lm_head).into_iter().collect(), false, 7, false));
    }
    eprintln!(
        "q4 bench: m={rows} passes={passes} sweep={sweep} serial={serial} policy={:?} gpu_cores={cores} pad_skip={} presum={}",
        crate::quant_kernel::q4_policy_mode(),
        crate::quant_kernel::pad_skip_enabled(),
        crate::quant_kernel::presum_enabled(),
    );
    let max_abs = |a: &Tensor, b: &Tensor| -> Result<f32> {
        Ok(a.sub(b)?.abs()?.flatten_all()?.max(0)?.to_scalar::<f32>()?)
    };
    for (tag, qs, gate_up, rows, synthetic) in &classes {
        let (gate_up, rows) = (*gate_up, *rows);
        if let Some(o) = &only {
            if !o.iter().any(|c| c == tag) {
                continue;
            }
        }
        let Some(q0) = qs.first() else { continue };
        let half = q0.out / 2;
        let xv: Vec<f32> = (0..rows * q0.inp)
            .map(|i| ((i * 2654435761) % 1000) as f32 / 500.0 - 1.0)
            .collect();
        let x = Tensor::from_vec(xv, (rows, q0.inp), device)?.to_dtype(DType::BF16)?;
        // K45 presum block of the same input (8 zero-padded rows + sums)
        let x_ps = x
            .apply_op1_no_bwd(&Q4AttachSums { m: rows, inp: q0.inp })?
            .narrow(0, 0, rows)?;
        let y_ref = q0.wq.apply_op3_no_bwd(
            &q0.sb,
            &x,
            &AffineQmm { inp: q0.inp, out: q0.out, gs: q0.gs, m: rows, tiled: q0.tiled },
        )?;
        // the kernels round gate/up to bf16 before silu(gate)·up
        let reference = if gate_up {
            let g = y_ref.narrow(1, 0, half)?.to_dtype(DType::F32)?;
            let u = y_ref.narrow(1, half, half)?.to_dtype(DType::F32)?;
            candle_nn::ops::silu(&g)?.mul(&u)?
        } else {
            y_ref.to_dtype(DType::F32)?
        };
        let ref_mag = reference.abs()?.flatten_all()?.max(0)?.to_scalar::<f32>()?;
        let n_out = if gate_up { half } else { q0.out };
        let bytes = q0.out * q0.inp / 2 + q0.out * (q0.inp / 64) * 4;
        let n_calls = qs.len().max(8); // lm_head: 8 calls of one 715 MB tensor
        let path = |q: &QLin, x: &Tensor, ps: bool| -> Result<Tensor> {
            if gate_up {
                match q.gate_up_act_ps(x, ps) {
                    Some(r) => Ok(r?.0),
                    // the forward's eager fallback (pre-K7 m = 1 route)
                    None if rows == 1 => {
                        let gu = q.linear_ps(x, ps)?;
                        let gate = gu.narrow(D::Minus1, 0, half)?.contiguous()?;
                        let up = gu.narrow(D::Minus1, half, half)?.contiguous()?;
                        Ok(candle_nn::ops::silu(&gate)?.mul(&up)?)
                    }
                    None => bail!("gate_up_act declined m={rows}"),
                }
            } else {
                q.linear_ps(x, ps)
            }
        };
        let y_path = path(q0, &x, false)?.to_dtype(DType::F32)?;
        // the same input at a 2-byte offset can't be bound directly, so it
        // always goes through the pad copy (P0's reference arm)
        let flat = Tensor::cat(
            &[&Tensor::zeros(1, DType::BF16, device)?, &x.flatten_all()?],
            0,
        )?;
        let x_mis = flat.narrow(0, 1, rows * q0.inp)?.reshape((rows, q0.inp))?;
        if rows == 8 && !synthetic {
            // P0 check: pad copy vs direct binding must be bitwise equal
            let y_pad = path(q0, &x_mis, false)?.to_dtype(DType::F32)?;
            eprintln!(
                "q4[{tag} m=8] P0 pad-copy-vs-direct max|Δ|={:.6} (pad_skip={})",
                max_abs(&y_pad, &y_path)?,
                crate::quant_kernel::pad_skip_enabled()
            );
        }
        if gate_up && crate::quant_kernel::presum_enabled() {
            // K45 emit check: the gate_up tile's emitted sums must equal
            // the attach-op sums of the same activation (down's operand)
            if let Some(Ok((act, true))) = q0.gate_up_act_ps(&x_ps, true) {
                let att = act
                    .apply_op1_no_bwd(&Q4AttachSums { m: rows, inp: half })?
                    .narrow(0, 0, rows)?;
                // identical sums ⇒ identical down outputs: emitted block
                // vs attach-op block vs in-kernel recompute on a copy
                let mut dmax = f32::NAN;
                if let Some(dq) = quant(&model.layers[0].mlp.down) {
                    let y1 = dq.linear_ps(&act, true)?.to_dtype(DType::F32)?;
                    let y2 = dq.linear_ps(&att, true)?.to_dtype(DType::F32)?;
                    let y3 = dq.linear_ps(&act.copy()?, false)?.to_dtype(DType::F32)?;
                    dmax = max_abs(&y1, &y2)?.max(max_abs(&y1, &y3)?);
                }
                eprintln!(
                    "q4[{tag} m={rows}] K45 down on emitted vs attached vs recomputed sums max|Δ|={dmax:.6}"
                );
            }
        }
        let (p_tile, p_sgs) = if gate_up {
            crate::quant_kernel::gate_up_tile()
        } else {
            crate::quant_kernel::plain_tile(q0.out, q0.inp).tile_sgs()
        };
        // candidates: the production path, the production path on the
        // misaligned input (= with the pad copy), the presum path, then
        // explicit tiles (plain / +ps) with optional group overrides. At
        // m = 1 (K7) the production path is the tiled qmvt matvec (it reads
        // the one live row and ignores the presum flag); the misaligned arm
        // is dropped there (qmvt declines a 2-byte offset, so it would time
        // the fallback, not the path) and the pre-K7 route (MPP decode tile,
        // plain and on the presum block; gate/up + eager narrow + silu·mul),
        // every qmvt config and the qmv / sg kernels on the tiled layout
        // are added as arms.
        type Cand<'a> = (String, Box<dyn Fn(&QLin, usize) -> Result<Tensor> + 'a>);
        let path_label = if rows == 1 && crate::quant_kernel::m1_path().qmvt(gate_up) {
            let c = crate::quant_kernel::qmvt_cfg(
                if gate_up { half } else { q0.out },
                q0.inp,
                gate_up,
            );
            format!("path qmvt r{}s{}", c.rpl, c.sgs)
        } else {
            format!("path t{p_tile}s{p_sgs}")
        };
        let mut cands: Vec<Cand> =
            vec![(path_label, Box::new(|q: &QLin, _| path(q, &x, false)))];
        if rows > 1 {
            cands.push(("path+pad".to_string(), Box::new(|q: &QLin, _| path(q, &x_mis, false))));
        }
        cands.push(("path+ps".to_string(), Box::new(|q: &QLin, _| path(q, &x_ps, true))));
        if rows == 1 {
            let (x, x_ps) = (&x, &x_ps);
            for ps in [false, true] {
                cands.push((
                    format!("pre-K7 mpp{}", if ps { "+ps" } else { "" }),
                    Box::new(move |q: &QLin, _| -> Result<Tensor> {
                        let (tile, sgs) =
                            crate::quant_kernel::plain_tile(q.out, q.inp).tile_sgs();
                        let op = AffineQmpp {
                            inp: q.inp,
                            out: q.out,
                            padded: q.out.div_ceil(256) * 256,
                            m: 1,
                            up_tile: 0,
                            sgs,
                            tile,
                            presum: ps,
                            emit_sums: false,
                            groups: 0,
                            flags: 0,
                        };
                        let xin = if ps { x_ps } else { x };
                        let y = q.wq.apply_op3_no_bwd(&q.sb, xin, &op)?.narrow(0, 0, 1)?.contiguous()?;
                        if !gate_up {
                            return Ok(y);
                        }
                        let h = q.out / 2;
                        let gate = y.narrow(D::Minus1, 0, h)?.contiguous()?;
                        let up = y.narrow(D::Minus1, h, h)?.contiguous()?;
                        Ok(candle_nn::ops::silu(&gate)?.mul(&up)?)
                    }),
                ));
            }
            for cfg in crate::quant_kernel::QMVT_KERNELS {
                cands.push((
                    format!("qmvt r{}s{}", cfg.rpl, cfg.sgs),
                    Box::new(move |q: &QLin, _| -> Result<Tensor> {
                        let h = if gate_up { q.out / 2 } else { 0 };
                        let op = crate::quant_kernel::AffineQmvT {
                            inp: q.inp,
                            out: if gate_up { h } else { q.out },
                            tiles: q.out.div_ceil(256),
                            up_row: h,
                            cfg,
                        };
                        Ok(q.wq.apply_op3_no_bwd(&q.sb, x, &op)?.reshape((1, ()))?)
                    }),
                ));
            }
            if !gate_up {
                cands.push((
                    "qmv tiled".to_string(),
                    Box::new(move |q: &QLin, _| -> Result<Tensor> {
                        let op = crate::quant_kernel::AffineQmv {
                            inp: q.inp,
                            out: q.out,
                            gs: q.gs,
                            tiled: q.tiled,
                        };
                        Ok(q.wq.apply_op3_no_bwd(&q.sb, x, &op)?.reshape((1, ()))?)
                    }),
                ));
            }
            cands.push((
                "sg tiled".to_string(),
                Box::new(move |q: &QLin, _| -> Result<Tensor> {
                    let h = q.out / 2;
                    let op = crate::quant_kernel::AffineQsg {
                        inp: q.inp,
                        out: if gate_up { h } else { q.out },
                        m: 1,
                        aux: if gate_up { h } else { 0 },
                        tiled: q.tiled,
                    };
                    Ok(q.wq.apply_op3_no_bwd(&q.sb, x, &op)?.reshape((1, ()))?)
                }),
            ));
        }

        let tiles = q0.out.div_ceil(256);
        // (label, tile, sgs, groups override, presum, emit, flags)
        let mut cfgs: Vec<(String, usize, usize, usize, bool, bool, u32)> = Vec::new();
        let mut add = |label: &str, tile: usize, sgs: usize, groups: usize| {
            for ps in [false, true] {
                let l = format!("{label}{}", if ps { "+ps" } else { "" });
                cfgs.push((l, tile, sgs, groups, ps, false, 0));
            }
        };
        if gate_up {
            add("n32s4_gu", 64, 2, 0);
            add("n256_gu_sg8", 256, 8, 0);
            add("n256_gu_sg4", 256, 4, 0);
            if sweep {
                let pairs = tiles / 2;
                for g in [cores, pairs.div_ceil(2), 3 * cores / 2, pairs] {
                    if g > 0 && g <= pairs {
                        add(&format!("n256_gu_sg8_g{g}"), 256, 8, g);
                        add(&format!("n256_gu_sg4_g{g}"), 256, 4, g);
                    }
                }
            }
        } else {
            add("n64s4", 64, 2, 0);
            add("n32s4", 32, 1, 0);
            add("n256_sg8", 256, 8, 0);
            add("p256_sg4", 256, 4, 0);
            if sweep {
                for mult in [1usize, 2, 3, 4, 6, 8] {
                    let g = mult * cores;
                    if g < tiles {
                        add(&format!("n256_sg8_g{g}"), 256, 8, g);
                        add(&format!("p256_sg4_g{g}"), 256, 4, g);
                    }
                }
                add(&format!("n256_sg8_g{tiles}"), 256, 8, tiles);
                add(&format!("p256_sg4_g{tiles}"), 256, 4, tiles);
            }
        }
        {
            // K45: the production presum+emit gate_up, and presum blocks
            // bound directly with in-kernel sums (bind only — the
            // production form for the N256 families)
            use crate::quant_kernel::QMPP_BIND_ONLY;
            let (pt, ps_) = (p_tile, p_sgs);
            if gate_up {
                cfgs.push(("n256_gu_sg8+ps+es".into(), 256, 8, 0, true, true, 0));
            }
            cfgs.push((format!("t{pt}s{ps_}+pb"), pt, ps_, 0, true, gate_up, QMPP_BIND_ONLY));
            if !gate_up && !(pt == 256 && ps_ == 8) {
                cfgs.push(("n256_sg8+pb".into(), 256, 8, 0, true, false, QMPP_BIND_ONLY));
            }
        }
        for (label, tile, sgs, groups, ps, emit, flags) in cfgs {
            let (x, x_ps) = (&x, &x_ps);
            cands.push((
                label,
                Box::new(move |q: &QLin, _| -> Result<Tensor> {
                    let op = AffineQmpp {
                        inp: q.inp,
                        out: if gate_up { q.out / 2 } else { q.out },
                        padded: q.out.div_ceil(256) * 256,
                        m: rows,
                        up_tile: if gate_up { q.out / 2 / 256 } else { 0 },
                        sgs,
                        tile,
                        presum: ps,
                        emit_sums: emit,
                        groups,
                        flags,
                    };
                    let xin = if ps { x_ps } else { x };
                    Ok(q.wq.apply_op3_no_bwd(&q.sb, xin, &op)?.narrow(0, 0, rows)?)
                }),
            ));
        }
        // interleaved timing: every pass times each candidate once (start
        // rotated per pass), so slow drift in GPU/memory contention hits all
        // candidates alike; the per-pass ratio vs the path cancels it
        let nc = cands.len();
        for (_, f) in &cands {
            for _ in 0..2 {
                for i in 0..n_calls {
                    let _ = f(&qs[i % qs.len()], i % qs.len())?;
                    barrier()?;
                }
            }
        }
        device.synchronize()?;
        let mut us = vec![Vec::with_capacity(passes); nc];
        for pass in 0..passes {
            for k in 0..nc {
                let c = (pass + k) % nc;
                let f = &cands[c].1;
                device.synchronize()?;
                let t = std::time::Instant::now();
                for i in 0..n_calls {
                    let _ = f(&qs[i % qs.len()], i % qs.len())?;
                    barrier()?;
                }
                device.synchronize()?;
                us[c].push(t.elapsed().as_secs_f64() * 1e6 / n_calls as f64);
            }
        }
        let median = |v: &[f64]| -> f64 {
            let mut v = v.to_vec();
            v.sort_by(|a, b| a.total_cmp(b));
            v[v.len() / 2]
        };
        for (c, (label, f)) in cands.iter().enumerate() {
            let y = f(q0, 0)?.to_dtype(DType::F32)?;
            let ratios: Vec<f64> = us[c].iter().zip(&us[0]).map(|(a, b)| a / b).collect();
            let (med, mn) = (median(&us[c]), us[c].iter().cloned().fold(f64::MAX, f64::min));
            eprintln!(
                "q4[{tag} m={rows}] {label:<20} {med:8.1}us/call (min {mn:8.1}) {:5.0} GB/s  x{:.3} vs path  max|Δ|ref={:.5} Δpath={:.5}  |ref|max={ref_mag:.2}  [{}x{}, {} tensors x{passes}]",
                bytes as f64 / (med * 1e-6) / 1e9,
                median(&ratios),
                max_abs(&y, &reference)?,
                max_abs(&y, &y_path)?,
                n_out,
                q0.inp,
                qs.len(),
            );
        }
    }
    Ok(())
}

/// `TH_BENCH_DRAFT_MLP=1 th-engine probe …` — the DFlash draft MLP
/// (`dflash.rs` `DraftLayer::mlp`) at the propose shape (8 rows) and the
/// batched-propose shapes (B*8 rows). The target's MLP weights have the
/// draft's shapes (gate and up 17408x5120, down 5120x17408), so a pass
/// runs the first `TH_BENCH_DRAFT_MLP_LAYERS` (default 16) layers'
/// distinct tensors and streams from DRAM like the draft's five layers.
/// Arms, each ending in `down`:
/// - `sep`: gate and up as two projections + eager silu·mul (the draft
///   MLP before K45(d)); gate/up are the fused tiled weight split back
///   into two tiled weights (exact values, no requantisation);
/// - `fused`: `gate_up_act_ps` + `down` with the returned presum flag
///   (K45(d): N256 two-stream tile at <= 8 rows, the two-pass prefill
///   gate/up tile above 8);
/// - `narrow`: one projection over the fused weight + narrow +
///   silu·mul (the eager fallback when `gate_up_act_ps` declines).
/// Passes are interleaved (start rotated) with a buffer barrier after
/// every call; µs/call is host-timed. max|Δ| is vs `sep` on layer 0.
/// Env: `TH_BENCH_DRAFT_MLP_ROWS` (default `8,16,24,32`),
/// `TH_BENCH_Q4_PASSES` (default 7).
#[cfg(all(feature = "metal", target_os = "macos"))]
pub(crate) fn bench_draft_mlp(model: &Qwen35, device: &Device) -> Result<()> {
    let env_n = |k: &str, d: usize| {
        std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
    };
    let passes = env_n("TH_BENCH_Q4_PASSES", 7).max(1);
    let nlayers = env_n("TH_BENCH_DRAFT_MLP_LAYERS", 16).max(1);
    let rows_list: Vec<usize> = std::env::var("TH_BENCH_DRAFT_MLP_ROWS")
        .unwrap_or_else(|_| "8,16,24,32".into())
        .split(',')
        .filter_map(|v| v.trim().parse().ok())
        .collect();
    let barrier = || -> Result<()> {
        if let Device::Metal(md) = device {
            use candle_metal_kernels::utils::EncoderProvider;
            let enc = md.command_encoder()?;
            let enc_ref = &enc;
            let e: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            e.insert_memory_barrier();
        }
        Ok(())
    };
    // fused tiled [gate | up] -> two tiled weights: wq tiles are
    // outermost ([tile][group][2048 u32]); sb is [scales | biases], each
    // [tile][group][256] — gate = tiles 0..ht, up = tiles ht..2ht
    let split = |q: &QLin| -> Result<(QLin, QLin)> {
        let ng = q.inp / 64;
        let half = q.out / 2;
        if !q.tiled || q.out % 2 != 0 || half % 256 != 0 {
            bail!("draft-mlp bench: gate_up {}x{} is not a tiled 256-aligned pair", q.out, q.inp);
        }
        let ht = half / 256;
        let (nw, ns) = (ht * ng * 2048, ht * ng * 256);
        let bias_base = q.out.div_ceil(256) * 256 * ng;
        let wq = q.wq.flatten_all()?;
        let sb = q.sb.flatten_all()?;
        let mk = |t: usize| -> Result<QLin> {
            Ok(QLin {
                // a view — the MPP kernels honour storage start offsets
                wq: wq.narrow(0, t * nw, nw)?,
                sb: Tensor::cat(
                    &[&sb.narrow(0, t * ns, ns)?, &sb.narrow(0, bias_base + t * ns, ns)?],
                    0,
                )?,
                out: half,
                inp: q.inp,
                gs: q.gs,
                tiled: true,
            })
        };
        Ok((mk(0)?, mk(1)?))
    };
    let quant = |l: &Lin| match l {
        Lin::Quant(q) if q.tiled => Some(q.clone()),
        _ => None,
    };
    // (gate_up, gate, up, down) per layer
    let mut ws: Vec<(QLin, QLin, QLin, QLin)> = Vec::new();
    for l in model.layers.iter().take(nlayers) {
        let (Some(gu), Some(dn)) = (quant(&l.mlp.gate_up), quant(&l.mlp.down)) else {
            continue;
        };
        let (g, u) = split(&gu)?;
        ws.push((gu, g, u, dn));
    }
    let Some(w0) = ws.first() else {
        bail!("draft-mlp bench: no tiled MLP weights")
    };
    let (half, inp) = (w0.1.out, w0.0.inp);
    eprintln!(
        "draft-mlp bench: layers={} passes={passes} rows={rows_list:?} policy={:?} presum={} [gate/up {half}x{inp}, down {}x{}]",
        ws.len(),
        crate::quant_kernel::q4_policy_mode(),
        crate::quant_kernel::presum_enabled(),
        w0.3.out,
        w0.3.inp,
    );
    let max_abs = |a: &Tensor, b: &Tensor| -> Result<f32> {
        Ok(a.to_dtype(DType::F32)?
            .sub(&b.to_dtype(DType::F32)?)?
            .abs()?
            .flatten_all()?
            .max(0)?
            .to_scalar::<f32>()?)
    };
    let median = |v: &[f64]| -> f64 {
        let mut v = v.to_vec();
        v.sort_by(|a, b| a.total_cmp(b));
        v[v.len() / 2]
    };
    for &rows in &rows_list {
        let xv: Vec<f32> = (0..rows * inp)
            .map(|i| ((i * 2654435761) % 1000) as f32 / 500.0 - 1.0)
            .collect();
        let x = Tensor::from_vec(xv, (1, rows, inp), device)?.to_dtype(DType::BF16)?;
        type Arm<'a> = (&'static str, Box<dyn Fn(&(QLin, QLin, QLin, QLin)) -> Result<Tensor> + 'a>);
        let x = &x;
        let arms: Vec<Arm> = vec![
            (
                "sep",
                Box::new(move |w: &(QLin, QLin, QLin, QLin)| -> Result<Tensor> {
                    let g = w.1.linear_ps(x, false)?;
                    let u = w.2.linear_ps(x, false)?;
                    let inter = candle_nn::ops::silu(&g)?.mul(&u)?;
                    w.3.linear_ps(&inter, false)
                }),
            ),
            (
                "fused",
                Box::new(move |w: &(QLin, QLin, QLin, QLin)| -> Result<Tensor> {
                    let Some(r) = w.0.gate_up_act_ps(x, false) else {
                        bail!("gate_up_act_ps declined rows={rows}")
                    };
                    let (inter, ps) = r?;
                    w.3.linear_ps(&inter, ps)
                }),
            ),
            (
                "narrow",
                Box::new(move |w: &(QLin, QLin, QLin, QLin)| -> Result<Tensor> {
                    let gu = w.0.linear_ps(x, false)?;
                    let last = gu.rank() - 1;
                    let g = gu.narrow(last, 0, half)?.contiguous()?;
                    let u = gu.narrow(last, half, half)?.contiguous()?;
                    let inter = candle_nn::ops::silu(&g)?.mul(&u)?;
                    w.3.linear_ps(&inter, false)
                }),
            ),
        ];
        let na = arms.len();
        for (_, f) in &arms {
            for w in &ws {
                let _ = f(w)?;
                barrier()?;
            }
        }
        device.synchronize()?;
        let mut us = vec![Vec::with_capacity(passes); na];
        for pass in 0..passes {
            for k in 0..na {
                let a = (pass + k) % na;
                device.synchronize()?;
                let t = std::time::Instant::now();
                for w in &ws {
                    let _ = (arms[a].1)(w)?;
                    barrier()?;
                }
                device.synchronize()?;
                us[a].push(t.elapsed().as_secs_f64() * 1e6 / ws.len() as f64);
            }
        }
        let y_ref = (arms[0].1)(w0)?;
        let ref_mag = y_ref
            .to_dtype(DType::F32)?
            .abs()?
            .flatten_all()?
            .max(0)?
            .to_scalar::<f32>()?;
        for (a, (label, f)) in arms.iter().enumerate() {
            let y = f(w0)?;
            let ratios: Vec<f64> = us[a].iter().zip(&us[0]).map(|(p, q)| p / q).collect();
            let mn = us[a].iter().cloned().fold(f64::MAX, f64::min);
            eprintln!(
                "dmlp[rows={rows:2}] {label:<7} {:8.1}us/call (min {mn:8.1})  x{:.3} vs sep  max|Δ|sep={:.5}  |sep|max={ref_mag:.2}",
                median(&us[a]),
                median(&ratios),
                max_abs(&y, &y_ref)?,
            );
        }
    }
    Ok(())
}

/// Row-concatenate projection weights so one matmul produces all their
/// outputs — the caller narrows the fused result back into the parts.
/// All inputs must share `inp`/`gs` and quantisation kind. Bitwise
/// identical to separate projections (each output row is independent).
pub(crate) fn fuse_lins(lins: &[Lin]) -> Result<Lin> {
    match lins {
        [Lin::Quant(..), ..] => {
            let mut wqs = Vec::with_capacity(lins.len());
            let mut sbs = Vec::with_capacity(lins.len());
            let mut out = 0usize;
            let (mut inp, mut gs) = (0usize, 0usize);
            for l in lins {
                let Lin::Quant(q) = l else {
                    bail!("fuse_lins: mixed quantisation")
                };
                if inp == 0 {
                    inp = q.inp;
                    gs = q.gs;
                } else if q.inp != inp || q.gs != gs {
                    bail!("fuse_lins: in/gs mismatch")
                }
                wqs.push(&q.wq);
                sbs.push(&q.sb);
                out += q.out;
            }
            Ok(Lin::Quant(QLin {
                wq: Tensor::cat(&wqs, 0)?.contiguous()?,
                sb: Tensor::cat(&sbs, 0)?.contiguous()?,
                out,
                inp,
                gs,
                tiled: false,
            }))
        }
        [Lin::Dense(..), ..] => {
            let ws: Vec<&Tensor> = lins
                .iter()
                .map(|l| match l {
                    Lin::Dense(t) => Ok(t),
                    _ => bail!("fuse_lins: mixed quantisation"),
                })
                .collect::<Result<_>>()?;
            Ok(Lin::Dense(Tensor::cat(&ws, 0)?))
        }
        _ => bail!("fuse_lins: empty"),
    }
}

// MARK: - math helpers

/// `TH_GDN_EAGER` set: GDN layers take the eager ops. Read once (the
/// forward used to look it up per layer per call).
fn gdn_eager() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_GDN_EAGER").is_ok())
}

/// `TH_GDN_STEP` set: seq <= 8 GDN layers skip the one-dispatch fused
/// step (conv / qknorm / scan / gatenorm kernels instead). Read once.
fn gdn_no_step() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_GDN_STEP").is_ok())
}

/// G1a A/B arm: `TH_GDN_COMMIT=step` rolls fused verifies back with the
/// pre-G1a numerics — a `gated_delta_step` re-scan of the stashed pack —
/// instead of the fused-step commit (bit-identical to a kept-row
/// forward). The fused verify then also writes the pack stash. Read once.
fn gdn_commit_step() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_GDN_COMMIT").as_deref() == Ok("step"))
}

/// `TH_NO_ATTN_FUSED`: attention layers take the eager ops instead of
/// the fused prepare + decode kernels. Read once (it was looked up per
/// attention layer per forward).
#[cfg(all(feature = "metal", target_os = "macos"))]
fn no_attn_fused() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_NO_ATTN_FUSED").is_ok())
}

/// The additive causal mask of the eager (seq > 8) attention paths:
/// `[seq, kv_seq]` with 0 where row i may attend key j (j <= pos + i) and
/// -inf elsewhere, in `dtype`. Built once per (seq, pos, kv_seq, dtype,
/// device) and shared by every attention layer of the forward (the
/// callers reshape the contiguous tensor — a view). candle 0.11 uploads
/// host data into a fresh wired buffer that stays in the pool until the
/// next sync (`MetalDevice::new_buffer_with_data`), and the chunked
/// prefill (engine.rs) never syncs between chunks: one f32 mask per
/// attention layer per 512-row chunk grew the pool by
/// 16 x sum_c (512 x 512c x 4 B) — 2 GiB over an 8k prompt, 32 GiB over
/// a 32k one (th/d-longctx). Same values as the per-layer build, so the
/// output is unchanged.
fn causal_mask(seq: usize, pos: usize, kv_seq: usize, dtype: DType, device: &Device) -> Result<Tensor> {
    type Entry = ((usize, usize, usize, DType), Device, Tensor);
    thread_local! {
        static CACHE: std::cell::RefCell<Vec<Entry>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    let key = (seq, pos, kv_seq, dtype);
    let hit = CACHE.with(|c| {
        c.borrow().iter().find(|(k, d, _)| *k == key && d.same_device(device)).map(|(_, _, t)| t.clone())
    });
    if let Some(t) = hit {
        return Ok(t);
    }
    let mut mask = vec![f32::NEG_INFINITY; seq * kv_seq];
    for i in 0..seq {
        for m in mask.iter_mut().skip(i * kv_seq).take(pos + i + 1) {
            *m = 0.0;
        }
    }
    let t = Tensor::from_vec(mask, (seq, kv_seq), device)?.to_dtype(dtype)?;
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        // one entry per dtype (bf16: fused-capable slots, f32: TurboQuant):
        // the previous forward's mask is released here
        c.retain(|(k, _, _)| k.3 != dtype);
        c.push((key, device.clone(), t.clone()));
    });
    Ok(t)
}

/// Prefill pool trim threshold (`TH_PREFILL_SYNC`, read once). A long
/// prompt is prefilled as back-to-back 512-row forwards (engine.rs) with
/// no host sync in between, and candle 0.11 releases pooled buffers only
/// at a sync (`drop_unused_buffers`); every chunk's eager-attention
/// transients ([24, 512, kv] scores/probs, the [24, kv, 256] K/V
/// broadcasts, growing with kv and rounded up to power-of-two buckets)
/// then stay allocated — and wired, via the residency set — until the end
/// of the prompt (th/d-longctx: a 24k-token prefill reached a 119 GB
/// phys_footprint). A prefill forward (seq > 8) that starts at pos >= this
/// threshold first syncs, bounding the pool to about one chunk's working
/// set. Default 2048: prompts up to 2048 + one chunk never sync (bench
/// contexts and ~1.5k prompts unchanged). `TH_PREFILL_SYNC=off` disables
/// it; `=N` sets the threshold. Output is unchanged (a sync only waits).
fn prefill_sync_min() -> usize {
    static V: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *V.get_or_init(|| match std::env::var("TH_PREFILL_SYNC") {
        Ok(v) if v.trim() == "off" => usize::MAX,
        Ok(v) => v.trim().parse().unwrap_or(2048),
        Err(_) => 2048,
    })
}

/// The fused rollback commits of all GDN layers go out as ONE dispatch
/// (`gdn_kernel::gdn_commit_all`) instead of one `gdn_fused_step` per
/// layer. `TH_GDN_COMMIT_ALL=0` restores the per-layer dispatches (A/B).
/// Read once.
fn gdn_commit_all_on() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_GDN_COMMIT_ALL").as_deref() != Ok("0"))
}

/// Eager attention (chunks of more than 8 rows: prefill) groups the q
/// heads per KV head (`[n_kv, rep*seq, d]` against the n_kv K/V heads)
/// instead of broadcasting K and V to every q head. Same kernels on the
/// same values per output element (bit-identical, see TH_BENCH_ATTN);
/// saves the per-layer `[n_heads, kv, d]` K, K^T and V copies, which
/// dominate prefill chunks at long context. `TH_ATTN_GQA=0` restores
/// the broadcast path (A/B reference). Read once.
fn attn_gqa() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_ATTN_GQA").as_deref() != Ok("0"))
}

/// E1 routing (read once): prefill chunks (seq > 8 rows) take the fused
/// causal flash kernel `attn_kernel::attn_prefill` instead of the eager
/// matmul/mask/softmax/matmul chain. `TH_PREFILL_ATTN=eager` keeps the
/// eager path (A/B reference); `TH_PREFILL_ATTN_VARIANT` picks the kernel
/// shape (`g2q` default: GQA-fused rows, 2 row groups of 16 per
/// threadgroup, q re-read per key block; `g2` = the same kernel holding q
/// in registers, bitwise equal and slower; `ph4` = MLX's per-head layout
/// with 4 row groups, `r` suffix = MPP relaxed precision);
/// `TH_PREFILL_ATTN_GATE=0` applies the output gate outside the kernel.
/// Not bitwise equal to the eager path
/// (f32 scores and softmax, f16 probabilities; eager rounds scores and
/// probabilities to bf16) — closer to an f32 reference (TH_BENCH_PREFILL_ATTN).
fn prefill_attn_cfg() -> Option<crate::attn_kernel::PrefillVariant> {
    static V: std::sync::OnceLock<Option<crate::attn_kernel::PrefillVariant>> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        if std::env::var("TH_PREFILL_ATTN").is_ok_and(|v| v.trim() == "eager") {
            return None;
        }
        let var = match std::env::var("TH_PREFILL_ATTN_VARIANT") {
            Ok(n) => crate::attn_kernel::PrefillVariant::parse(&n).unwrap_or_else(|| {
                eprintln!("[attn] TH_PREFILL_ATTN_VARIANT={n:?} not understood; default variant");
                crate::attn_kernel::PrefillVariant::DEFAULT
            }),
            Err(_) => crate::attn_kernel::PrefillVariant::DEFAULT,
        };
        let gate = var.gate && std::env::var("TH_PREFILL_ATTN_GATE").as_deref() != Ok("0");
        Some(crate::attn_kernel::PrefillVariant { gate, ..var })
    })
}

/// In-process A/B hook (`TH_BENCH_PREFILL_LOGITS`): route every prefill
/// chunk to the eager attention while set. One relaxed load per attention
/// layer call; never set on the serving path.
static PREFILL_FORCE_EAGER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn prefill_attn_force_eager(on: bool) {
    PREFILL_FORCE_EAGER.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// The fused prefill kernel variant for this attention call, or `None`
/// for the eager path: Metal, bf16, a prefill chunk (seq > 8; the decode
/// kernels serve <= 8), a supported geometry and a compiled pipeline.
fn prefill_attn_variant(
    device: &Device,
    seq: usize,
    dtype: DType,
    nh: usize,
    nkv: usize,
    d: usize,
) -> Option<crate::attn_kernel::PrefillVariant> {
    if seq <= 8 || dtype != DType::BF16 || !crate::attn_kernel::prefill_supported(nh, nkv, d) {
        return None;
    }
    if PREFILL_FORCE_EAGER.load(std::sync::atomic::Ordering::Relaxed) {
        return None;
    }
    let var = prefill_attn_cfg()?;
    #[cfg(all(feature = "metal", target_os = "macos"))]
    if let Device::Metal(md) = device {
        return crate::attn_kernel::metal_impl::prefill_pipe(md, nh, nkv, d, var).map(|_| var);
    }
    let _ = device;
    None
}

/// `TH_DEBUG_ROLLBACK`: per-layer rollback dumps. Read once.
fn debug_rollback() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_DEBUG_ROLLBACK").is_ok())
}

/// `TH_GDN_AB_CONTIG`: contiguous gate projections for the step scan.
/// Read once.
#[cfg(all(feature = "metal", target_os = "macos"))]
fn gdn_ab_contig() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_GDN_AB_CONTIG").is_ok())
}

/// Bit-exact copy of a state tensor into a fresh buffer. On Metal,
/// candle 0.11's `Tensor::copy()` is an alias (`try_clone` shares the
/// `Arc<Buffer>`) and `affine(1, 0)` maps -0.0 to +0.0; `slice_set` into
/// fresh zeros is a true copy on every backend.
fn state_copy(t: &Tensor) -> Result<Tensor> {
    let out = Tensor::zeros(t.shape(), t.dtype(), t.device())?;
    out.slice_set(&t.contiguous()?, 0, 0)?;
    Ok(out)
}

/// Bit-exact copy of a state tensor into a fresh buffer for the T1
/// prefix cache (capture/restore): `outbuf::copy_uninit` — one compute
/// dispatch per tensor instead of `state_copy`'s blit fill + blit copy
/// (each ends candle's compute encoder and waits on every live fence;
/// ~100 per checkpoint).
fn state_copy_uninit(t: &Tensor) -> Result<Tensor> {
    Ok(crate::outbuf::copy_uninit(t)?)
}

/// (parity `cur`, parity `1 - cur`) of a double-buffered state pair.
fn parity_pair(p: &mut [Tensor; 2], cur: usize) -> (&Tensor, &mut Tensor) {
    let [a, b] = p;
    if cur == 0 {
        (&*a, b)
    } else {
        (&*b, a)
    }
}

/// x / sqrt(mean(x²) + eps) * w — fused Metal kernel, f32 accumulation
/// inside the shader (weights already carry the +1 offset from conversion).
pub(crate) fn rms_norm(x: &Tensor, w: &Tensor, eps: f64) -> Result<Tensor> {
    candle_nn::ops::rms_norm(x, w, eps as f32).map_err(Into::into)
}

/// Fused `x + r` residual + `rms_norm(x+r)·w` on Metal — one dispatch
/// producing both streams. Falls back to eager ops elsewhere.
#[allow(dead_code)]
fn add_rms_norm(
    x: &Tensor,
    r: &Tensor,
    w: &Tensor,
    eps: f64,
) -> Result<(Tensor, Tensor)> {
    let (res, nrm, _) = add_rms_norm_ps(x, r, w, eps)?;
    Ok((res, nrm))
}

/// `add_rms_norm` that, at decode shapes (T <= 8), emits the normed plane
/// as a K45 presum block (`quant_kernel::presum_block_bytes`) — the third
/// value says so, and the next projection takes it with `presum: true`
/// (no pad copy, no in-kernel input sums). Values are bit-identical.
/// Prefill (eager attention) writes K/V into a contiguous capacity buffer
/// instead of leaving an exact-length view for the first verify to regrow.
/// `TH_KV_CAP_PREFILL=0` restores the old behaviour (A/B). Read once.
fn kv_cap_prefill() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_KV_CAP_PREFILL").as_deref() != Ok("0"))
}

/// `TH_ARN_LEGACY=1`: the pre-R0c single-threadgroup add+RMSNorm kernels
/// (A/B arm; outputs are bit-identical either way). Read once.
fn arn_legacy() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_ARN_LEGACY").as_deref() == Ok("1"))
}

fn add_rms_norm_ps(
    x: &Tensor,
    r: &Tensor,
    w: &Tensor,
    eps: f64,
) -> Result<(Tensor, Tensor, bool)> {
    #[cfg(all(feature = "metal", target_os = "macos"))]
    if x.device().is_metal() && x.is_contiguous() && r.is_contiguous() {
        let seq = x.dim(1)?;
        let c = x.dim(2)?;
        let sums = crate::quant_kernel::presum_enabled()
            && (1..=8).contains(&seq)
            && c % 64 == 0
            && x.dim(0)? == 1;
        // E1(c): long-prompt chunks — the normed plane as a prefill presum
        // block (the next projection's vec tile skips its pf_prep pass)
        let pfsums = !sums
            && seq > 8
            && c % 64 == 0
            && c <= 7936
            && x.dim(0)? == 1
            && !arn_legacy()
            && crate::quant_kernel::pf_presum_on(seq);
        let out = x.apply_op3_no_bwd(
            r,
            w,
            &crate::gdn_kernel::AddRmsNorm { t: seq, c, eps: eps as f32, sums, pfsums, legacy: arn_legacy() },
        )?;
        // out is [2, T, C] — plane 0 = residual, plane 1 = normed
        let res = out.narrow(0, 0, 1)?;
        let nrm = out.narrow(0, 1, 1)?;
        return Ok((res, nrm, sums || pfsums));
    }
    let res = x.add(r)?;
    let nrm = rms_norm(&res, w, eps)?;
    Ok((res, nrm, false))
}

/// Eager depthwise causal conv + SiLU — `conv_in` is
/// [(k-1+seq), conv_dim] (state window prepended); returns
/// [seq, conv_dim]. CPU/non-Metal fallback for `GdnConv`.
fn conv_silu(
    conv_in: &Tensor,
    w: &Tensor,
    seq: usize,
    conv_dim: usize,
    conv_k: usize,
) -> Result<Tensor> {
    if seq == 1 {
        return Ok(candle_nn::ops::silu(
            &conv_in.broadcast_mul(&w.t()?)?.sum(0)?,
        )?
        .unsqueeze(0)?);
    }
    let mut acc =
        Tensor::zeros((seq, conv_dim), DType::BF16, conv_in.device())?;
    for j in 0..conv_k {
        let seg = conv_in.narrow(0, j, seq)?;
        let tap = w.i((.., j))?.unsqueeze(0)?;
        acc = acc.broadcast_add(&seg.broadcast_mul(&tap)?)?;
    }
    candle_nn::ops::silu(&acc).map_err(Into::into)
}

/// log(1 + e^x), stable form: relu(x) + log(1 + e^{-|x|}).
fn softplus(x: &Tensor) -> Result<Tensor> {
    let relu = x.clamp(0.0, f64::INFINITY)?;
    let neg_abs = x.abs()?.neg()?;
    Ok(relu.broadcast_add(&neg_abs.exp()?.affine(1.0, 1.0)?.log()?)?)
}

/// x [.., in] @ w.t() where w is [out, in]. Flattens batch dims so the
/// Metal gemm sees a plain 2D×2D — `broadcast_matmul` would otherwise
/// materialise a copy of the full weight per call.
fn linear(x: &Tensor, w: &Tensor) -> Result<Tensor> {
    let dims = x.dims().to_vec();
    let in_d = *dims.last().unwrap();
    let out_d = w.dim(0)?;
    let flat = x.reshape(((), in_d))?;
    let y = flat.matmul(&w.t()?).with_context(|| {
        format!(
            "linear x={:?}/{:?} w={:?}/{:?}",
            flat.shape(),
            flat.layout().stride(),
            w.shape(),
            w.layout().stride()
        )
    })?;
    let mut out = dims;
    *out.last_mut().unwrap() = out_d;
    Ok(y.reshape(out)?)
}

// MARK: - layers

struct GdnLayer {
    in_all: Lin,     // [16480, 5120] — fused [qkv | z | a|b]
    conv: Tensor,    // [10240, 4] depthwise taps
    a_log: Tensor,   // [48] f32
    dt_bias: Tensor, // [48] f32
    a_log64: [f32; 64],   // kernel param tables (zero-padded)
    dt_bias64: [f32; 64],
    norm_w: Tensor,  // [128]
    ones_dk: Tensor, // [head_k] ones — unit weight for fused rms_norm
    out: Lin,        // [5120, 6144]
    key_dim: usize,
    value_dim: usize,
    num_k_heads: usize,
    num_v_heads: usize,
    head_k: usize,
    head_v: usize,
    conv_k: usize,
}

struct AttnLayer {
    in_qkv: Lin,    // [14336, 5120] — fused [q|gate | k | v]
    o: Lin,         // [5120, 6144]
    q_norm: Tensor, // [256]
    k_norm: Tensor,
    cos: Tensor,    // [max_pos, rot/2] f32
    sin: Tensor,
    n_heads: usize,
    n_kv: usize,
    head_dim: usize,
    rot_dim: usize,
}

struct Mlp {
    gate_up: Lin,   // [2*17408, 5120] — fused [gate | up]
    down: Lin,
    inter: usize,
}

enum Kind {
    Gdn(GdnLayer),
    Attn(AttnLayer),
}

struct Layer {
    input_norm: Tensor,
    kind: Kind,
    post_norm: Tensor,
    mlp: Mlp,
}

// MARK: - state

/// One GDN layer's recurrent state, double-buffered per slot (G1a
/// parity state, Splash's current/next scheme): `conv[p]` is the
/// [k-1, conv_dim] bf16 rolling-input window and `rec[p]` the
/// [Hv, Dv, Dk] f32 delta state of parity `p`. The committed state lives
/// in parity `Slot::gdn_par.cur`; every forward reads it and writes the
/// other parity out of place, then the slot flips — so the pre-verify
/// state survives a verify untouched and a partial accept re-scans only
/// the kept rows from it (`rollback_verify`), with no snapshot copies.
/// Both buffers are exclusively owned by their slot (never shared with a
/// snapshot, another slot or a view that a kernel could write through).
pub(crate) struct GdnState {
    pub(crate) conv: [Tensor; 2],
    pub(crate) rec: [Tensor; 2],
}

impl GdnState {
    fn zeros(conv_rows: usize, conv_dim: usize, hv: usize, dv: usize, dk: usize, device: &Device) -> Result<Self> {
        let c = || Tensor::zeros((conv_rows, conv_dim), DType::BF16, device);
        let r = || Tensor::zeros((hv, dv, dk), DType::F32, device);
        Ok(GdnState { conv: [c()?, c()?], rec: [r()?, r()?] })
    }
}

/// Which parity holds a slot's committed GDN state, and what each parity
/// holds: `ids[p]` is a content version (0 = invalid / being written),
/// unique per slot for its lifetime, so a light [`Snapshot`] can tell
/// whether its state is still resident in either buffer.
#[derive(Clone, Copy, Debug)]
pub(crate) struct GdnParity {
    pub(crate) cur: usize,
    ids: [u64; 2],
    next: u64,
}

impl GdnParity {
    fn new() -> Self {
        GdnParity { cur: 0, ids: [1, 0], next: 2 }
    }

    fn fresh(&mut self) -> u64 {
        let id = self.next;
        self.next += 1;
        id
    }

    /// A forward is about to write parity `1 - cur`: that buffer stops
    /// holding any snapshot's state. Returns the parity to read.
    fn begin(&mut self) -> usize {
        self.ids[1 - self.cur] = 0;
        self.cur
    }

    /// The forward completed for every layer: commit the written parity.
    /// (A forward that errors never flips — the committed parity is
    /// intact because nothing writes it in place.)
    fn flip(&mut self) {
        self.cur ^= 1;
        self.ids[self.cur] = self.fresh();
    }

    /// The committed parity was rewritten in place of its old content
    /// (rollback re-scan, deep restore, clear).
    fn rewrote_cur(&mut self) {
        self.ids[self.cur] = self.fresh();
    }
}

/// Per-GDN-layer intermediates stashed during a spec-decode verify pass
/// so a partial accept can roll forward only the committed rows instead
/// of re-running the whole model (`rollback_verify`).
#[derive(Default)]
struct GdnVerifyCache {
    /// Raw in_proj_qkv output [seq, conv_dim] — the depthwise-conv input;
    /// needed to rebuild the (k-1)-row conv window (and the fused-step
    /// commit's input rows).
    qkv: Option<Tensor>,
    /// Normed scan inputs packed [seq, 2*Hk+Hv, Dk] — step-rescan source
    /// (non-fused verifies, or `TH_GDN_COMMIT=step`).
    pack: Option<Tensor>,
    /// [seq, 2*Hv] bf16 — gate/beta projections (strided view).
    ab: Option<Tensor>,
    /// The verify ran `gdn_fused_step`: commit with the same kernel so
    /// the kept-row state is bit-identical to a kept-row forward.
    fused: bool,
}

/// Per-request decode state — one batch slot. Batched verify runs
/// matmuls over the flat row space once and dispatches the stateful
/// kernels per slot on narrowed views.
pub struct Slot {
    pub(crate) gdn: Vec<Option<GdnState>>,
    pub(crate) kv: Vec<Option<(Tensor, Tensor)>>,
    pub(crate) kvq: Vec<crate::turboquant::QuantKv>,
    pub(crate) kv_tokens: usize,
    /// This slot's attention cache mode (TurboQuant `kvq` vs raw `kv`).
    /// Per-slot so one request's mode never changes under another's
    /// in-flight state; the shared `tq` context is immutable.
    pub(crate) kv_quant: bool,
    /// G1a: parity holding the committed GDN state (all layers flip
    /// together, once per completed forward).
    pub(crate) gdn_par: GdnParity,
    vcache: Vec<GdnVerifyCache>,
    captures: Vec<Tensor>,
    /// T1: absolute position of the first row in `captures` — 0 except
    /// after a prefix restore, which re-seeds the capture rows the draft
    /// ring warm-up needs from the checkpoint. Read by `draft_prefill`.
    capture_base: usize,
    pub draft: Option<crate::dflash::Draft>,
}

impl Slot {
    /// Fresh zeroed state for one slot — the layer list determines
    /// which per-layer tensors each slot owns.
    fn new(
        cfg: &Qwen35Config,
        layers: &[Layer],
        device: &Device,
    ) -> Result<Slot> {
        let mut gdn = Vec::with_capacity(layers.len());
        let mut kv = Vec::with_capacity(layers.len());
        let mut kvq = Vec::with_capacity(layers.len());
        for l in layers {
            if matches!(l.kind, Kind::Gdn(_)) {
                let conv_dim = 2 * cfg.linear_num_key_heads
                    * cfg.linear_key_head_dim
                    + cfg.linear_num_value_heads * cfg.linear_value_head_dim;
                gdn.push(Some(GdnState::zeros(
                    cfg.linear_conv_kernel_dim - 1,
                    conv_dim,
                    cfg.linear_num_value_heads,
                    cfg.linear_value_head_dim,
                    cfg.linear_key_head_dim,
                    device,
                )?));
                kv.push(None);
            } else {
                gdn.push(None);
                kv.push(Some((
                    Tensor::zeros(
                        (cfg.num_key_value_heads, 0, cfg.head_dim),
                        DType::BF16,
                        device,
                    )?,
                    Tensor::zeros(
                        (cfg.num_key_value_heads, 0, cfg.head_dim),
                        DType::BF16,
                        device,
                    )?,
                )));
            }
            kvq.push(crate::turboquant::QuantKv::default());
        }
        Ok(Slot {
            gdn,
            kv,
            kvq,
            kv_tokens: 0,
            kv_quant: false,
            gdn_par: GdnParity::new(),
            vcache: (0..layers.len()).map(|_| GdnVerifyCache::default()).collect(),
            captures: Vec::new(),
            capture_base: 0,
            draft: None,
        })
    }
}

/// T1 prefix-cache checkpoint of one slot at KV position `pos`, taken
/// right after a prefill chunk ending at `pos` (see `prefix_cache.rs`).
/// Every tensor is private to the checkpoint and never written again:
/// the GDN state is a bit-exact copy of the committed parity; each
/// attention K/V is exactly `[n_kv, pos, d]` — a slot that restores it
/// holds it at full capacity, so its next write grows into a fresh buffer
/// (`ensure_kv` / the eager path's cat) instead of writing in place; the
/// capture rows are a compact copy (one group, fresh buffers) that
/// `take_captures` only reads. Restoring into several slots at once is
/// therefore safe: they share only read-only buffers.
pub struct PrefixState {
    pos: usize,
    /// per layer: (conv window, recurrent state) for GDN layers
    gdn: Vec<Option<(Tensor, Tensor)>>,
    /// per layer: (K, V) rows 0..pos for attention layers
    kv: Vec<Option<(Tensor, Tensor)>>,
    /// one capture group (5 tensors, one per capture layer) covering
    /// absolute positions `caps_base..pos`, `caps_base = pos-(WINDOW-1)`
    /// or 0 — enough for the draft ring warm-up of any longer prompt (its
    /// last WINDOW-1 rows)
    caps: Vec<Tensor>,
    caps_base: usize,
    bytes: usize,
}

impl PrefixState {
    pub fn pos(&self) -> usize {
        self.pos
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

fn tensor_bytes(t: &Tensor) -> usize {
    t.elem_count() * t.dtype().size_in_bytes()
}

/// Pre-verify state for speculative decode rollback. KV tensors are
/// never mutated in place for the rows a snapshot covers, so clones are
/// cheap. GDN state (G1a): a *light* snapshot (`snapshot`) records only
/// the committed parity's content id — no copies — and stays restorable
/// while that parity survives, i.e. across the one following forward
/// (the verify), which writes the other parity. A *deep* snapshot
/// (`snapshot_deep`, probes that restore one state many times) holds
/// bit-exact copies of the committed conv windows and recurrent states.
#[derive(Clone)]
pub struct Snapshot {
    gdn_id: u64,
    gdn_deep: Option<Vec<Option<(Tensor, Tensor)>>>,
    kv: Vec<Option<(Tensor, Tensor)>>,
    kvq: Vec<crate::turboquant::QuantKv>,
    kv_tokens: usize,
}

pub struct Qwen35 {
    embed: Tensor,
    layers: Vec<Layer>,
    norm: Tensor,
    lm_head: Lin,
    cfg: Qwen35Config,
    device: Device,
    tq: Option<crate::turboquant::TurboQuant>,
    /// Per-request state — always ≥1 slots; slot count is the decode
    /// batch width.
    pub slots: Vec<Slot>,
    /// Shared DFlash draft weights — set once, slots own rings.
    draft_w: Option<crate::dflash::DraftWeights>,
    debug: bool,
    /// `[layers, 2, 64]` f32 GDN gate constants (a_log | dt_bias per
    /// layer row, zero rows for attention layers) for the one-dispatch
    /// rollback commit — built on first use.
    gdn_consts: Option<Tensor>,
}

impl Qwen35 {

    /// Microbench: time the two packed-decode kernels on a mid-layer
    /// gate|up projection (out=34816, in=5120 — the largest matmul).
    #[cfg(all(feature = "metal", target_os = "macos"))]
    pub(crate) fn bench_lin(&self, device: &Device) -> Result<()> {
        let gdn = self.layers.iter().find_map(|l| match &l.kind {
            Kind::Gdn(g) => Some(g),
            _ => None,
        });
        let attn = self.layers.iter().find_map(|l| match &l.kind {
            Kind::Attn(a) => Some(a),
            _ => None,
        });
        let mut suite: Vec<(&str, &Lin)> = vec![
            ("gate_up", &self.layers[0].mlp.gate_up),
            ("down", &self.layers[0].mlp.down),
            ("lm_head", &self.lm_head),
        ];
        if let Some(g) = gdn {
            suite.push(("in_all", &g.in_all));
            suite.push(("out", &g.out));
        }
        if let Some(a) = attn {
            suite.push(("in_qkv", &a.in_qkv));
            suite.push(("o", &a.o));
        }
        for (tag, l) in suite {
            let Lin::Quant(q) = l else { continue };
            // deterministic x so both kernels see identical inputs
            let xv: Vec<f32> = (0..8 * q.inp)
                .map(|i| ((i * 2654435761) % 1000) as f32 / 100.0 - 5.0)
                .collect();
            let x = Tensor::from_vec(xv, (8, q.inp), device)?
                .to_dtype(DType::BF16)?;
            // correctness: scalar vs sg
            let ya = self.warm_mm(q, &x)?.to_dtype(DType::F32)?;
            let yb = self.warm_sg(q, &x)?.to_dtype(DType::F32)?;
            let d = ya.sub(&yb)?.abs()?.max(0)?.max(0)?.to_scalar::<f32>()?;
            eprintln!("qmm[{tag}] max|Δ| scalar-vs-sg = {d:.5}");
            // cooperative-tensor (MPP) path on a tiled copy
            let qt = q.clone().tiled()?;
            // prefill (m=64): mpp vs dequant+gemm correctness+time
            {
                let m = 64usize;
                let xp = x.narrow(0, 0, 8)?; // reuse first rows' pattern
                let xv2: Vec<f32> = (0..m * q.inp)
                    .map(|i| ((i * 2654435761) % 1000) as f32 / 100.0 - 5.0)
                    .collect();
                let _ = xp;
                let xp = Tensor::from_vec(xv2, (m, q.inp), device)?
                    .to_dtype(DType::BF16)?;
                // reference: dequant + matmul (CPU-free)
                let wd = qt
                    .wq
                    .apply_op2_no_bwd(
                        &qt.sb,
                        &crate::quant_kernel::AffineDequant {
                            inp: qt.inp,
                            out: qt.out,
                            gs: qt.gs,
                            tiled: qt.tiled,
                        },
                    )?;
                let ya = linear(&xp, &wd)?.to_dtype(DType::F32)?;
                let yb = qt
                    .wq
                    .apply_op3_no_bwd(
                        &qt.sb,
                        &xp,
                        &crate::quant_kernel::AffineQmppPrefill {
                            inp: qt.inp,
                            out: qt.out,
                            padded: qt.out.div_ceil(256) * 256,
                            m,
                            up_tile: 0,
                        },
                    )?
                    .narrow(0, 0, m)?
                    .narrow(1, 0, qt.out)?
                    .contiguous()?
                    .to_dtype(DType::F32)?;
                let d = ya
                    .sub(&yb)?
                    .abs()?
                    .max(0)?
                    .max(0)?
                    .to_scalar::<f32>()?;
                eprintln!("qmm[{tag}:prefill m64] max|Δ| = {d:.5}");
                for _ in 0..2 {
                    let _ = qt.wq.apply_op3_no_bwd(
                        &qt.sb,
                        &xp,
                        &crate::quant_kernel::AffineQmppPrefill {
                            inp: qt.inp,
                            out: qt.out,
                            padded: qt.out.div_ceil(256) * 256,
                            m,
                            up_tile: 0,
                        },
                    )?;
                }
                let t0 = std::time::Instant::now();
                for _ in 0..10 {
                    let _ = qt.wq.apply_op3_no_bwd(
                        &qt.sb,
                        &xp,
                        &crate::quant_kernel::AffineQmppPrefill {
                            inp: qt.inp,
                            out: qt.out,
                            padded: qt.out.div_ceil(256) * 256,
                            m,
                            up_tile: 0,
                        },
                    )?;
                }
                let _ = yb.max(0)?.max(0)?.to_scalar::<f32>()?; // sync
                let ms = t0.elapsed().as_secs_f64() * 1e3 / 10.0;
                let bytes = q.inp * q.out / 2 + q.inp * q.out / 64 * 4;
                eprintln!(
                    "qmm[{tag}:prefill m64] {ms:.2}ms  {:.0} GB/s  {:.0} tok-rows/s",
                    bytes as f64 / ms / 1e6,
                    m as f64 / ms * 1e3
                );
            }
            let t = std::time::Instant::now();
            let yc = qt
                .wq
                .apply_op3_no_bwd(
                    &qt.sb,
                    &x,
                    &crate::quant_kernel::AffineQmpp {
                        inp: qt.inp,
                        out: qt.out,
                        padded: qt.out.div_ceil(256) * 256,
                        m: 8,
                        up_tile: 0,
                        sgs: 8,
                        tile: 256,
                        presum: false,
                        emit_sums: false,
                        groups: 0,
                        flags: 0,
                    },
                )?
                .narrow(0, 0, 8)?
                .to_dtype(DType::F32)?;
            let d = ya.sub(&yc)?.abs()?.max(0)?.max(0)?.to_scalar::<f32>()?;
            eprintln!("qmm[{tag}] max|Δ| scalar-vs-mpp = {d:.5}");
            for (sgs, tile) in [(8usize, 256usize), (4, 256), (1, 32), (2, 64)] {
                for _ in 0..2 {
                    let _ = qt.wq.apply_op3_no_bwd(
                        &qt.sb, &x,
                        &crate::quant_kernel::AffineQmpp {
                            inp: qt.inp, out: qt.out,
                            padded: qt.out.div_ceil(256) * 256,
                            m: 8, up_tile: 0, sgs,
                            tile,
                            presum: false,
                            emit_sums: false,
                            groups: 0,
                            flags: 0,
                        },
                    )?;
                }
                let t0 = std::time::Instant::now();
                for _ in 0..10 {
                    let _ = qt.wq.apply_op3_no_bwd(
                        &qt.sb, &x,
                        &crate::quant_kernel::AffineQmpp {
                            inp: qt.inp, out: qt.out,
                            padded: qt.out.div_ceil(256) * 256,
                            m: 8, up_tile: 0, sgs,
                            tile,
                            presum: false,
                            emit_sums: false,
                            groups: 0,
                            flags: 0,
                        },
                    )?;
                }
                let _ = yc.to_vec2::<f32>()?; // sync
                let ms = t0.elapsed().as_secs_f64() * 1e3 / 10.0;
                let bytes = q.inp * q.out / 2 + q.inp * q.out / 64 * 4;
                eprintln!(
                    "qmm[{tag}:mpp sg{sgs} t{tile}] {ms:.2}ms  {:.0} GB/s  ({}x{})",
                    bytes as f64 / ms / 1e6,
                    q.out, q.inp
                );
                let _ = t;
            }
            // K7: m = 1 tiled matvec (the decode route) vs the scalar
            // m = 1 reference; gate_up also as the fused silu·mul form
            // vs eager f32 silu(gate)·up on the bf16 scalar halves
            {
                use crate::quant_kernel::{qmvt_cfg, AffineQmm, AffineQmvT};
                let x1 = x.narrow(0, 0, 1)?.contiguous()?;
                let x1v = x1.reshape((qt.inp,))?;
                let y1 = qt
                    .wq
                    .apply_op3_no_bwd(
                        &qt.sb,
                        &x1,
                        &AffineQmm { inp: qt.inp, out: qt.out, gs: qt.gs, m: 1, tiled: qt.tiled },
                    )?
                    .flatten_all()?;
                let mut forms = vec![(false, qt.out, 0usize)];
                if tag == "gate_up" {
                    forms.push((true, qt.out / 2, qt.out / 2));
                }
                for (gu, out, up_row) in forms {
                    let cfg = qmvt_cfg(out, qt.inp, gu);
                    let op = AffineQmvT {
                        inp: qt.inp,
                        out,
                        tiles: qt.out.div_ceil(256),
                        up_row,
                        cfg,
                    };
                    let yq = qt.wq.apply_op3_no_bwd(&qt.sb, &x1v, &op)?.to_dtype(DType::F32)?;
                    let want = if gu {
                        let g = y1.narrow(0, 0, out)?.to_dtype(DType::F32)?;
                        let u = y1.narrow(0, out, out)?.to_dtype(DType::F32)?;
                        candle_nn::ops::silu(&g)?.mul(&u)?
                    } else {
                        y1.to_dtype(DType::F32)?
                    };
                    let d = yq.sub(&want)?.abs()?.max(0)?.to_scalar::<f32>()?;
                    for _ in 0..2 {
                        let _ = qt.wq.apply_op3_no_bwd(&qt.sb, &x1v, &op)?;
                    }
                    device.synchronize()?;
                    let t0 = std::time::Instant::now();
                    for _ in 0..10 {
                        let _ = qt.wq.apply_op3_no_bwd(&qt.sb, &x1v, &op)?;
                    }
                    device.synchronize()?;
                    let ms = t0.elapsed().as_secs_f64() * 1e3 / 10.0;
                    let bytes = q.inp * q.out / 2 + q.inp * q.out / 64 * 4;
                    eprintln!(
                        "qmm[{tag}:qmvt{} m1 r{}s{}] {ms:.2}ms  {:.0} GB/s  max|Δ| vs scalar m1 = {d:.5}",
                        if gu { " gate_up" } else { "" },
                        cfg.rpl,
                        cfg.sgs,
                        bytes as f64 / ms / 1e6,
                    );
                }
            }
            // gate/up epilogue vs eager silu(gate)*up
            if q.out % 2 == 0 {
                let half = q.out / 2;
                let gu = yb.reshape((8, q.out))?;
                let gate = gu.narrow(1, 0, half)?.contiguous()?;
                let up = gu.narrow(1, half, half)?.contiguous()?;
                let eager =
                    candle_nn::ops::silu(&gate)?.mul(&up)?.to_dtype(DType::F32)?;
                let fused = q
                    .wq
                    .apply_op3_no_bwd(
                        &q.sb,
                        &x,
                        &crate::quant_kernel::AffineQsg {
                            inp: q.inp,
                            out: half,
                            m: 8,
                            aux: half,
                            tiled: q.tiled,
                        },
                    )?
                    .to_dtype(DType::F32)?;
                let d = eager
                    .sub(&fused)?
                    .abs()?
                    .max(0)?
                    .max(0)?
                    .to_scalar::<f32>()?;
                eprintln!("qmm[{tag}] max|Δ| gate-up-vs-eager = {d:.5}");
            }
        for (name, sg) in [("scalar", false), ("sg", true)] {
            for _ in 0..2 {
                // warm
                let _ = if sg {
                    self.warm_sg(q, &x)?
                } else {
                    self.warm_mm(q, &x)?
                };
            }
            let t = std::time::Instant::now();
            let iters = 10;
            for _ in 0..iters {
                let y = if sg {
                    self.warm_sg(q, &x)?
                } else {
                    self.warm_mm(q, &x)?
                };
                let _ = y;
            }
            device.synchronize()?;
            let ms = t.elapsed().as_secs_f64() * 1e3 / iters as f64;
            let gb = (q.out * q.inp) as f64 * 0.5 / 1e9
                + (q.out * q.inp / 64 * 4) as f64 / 1e9;
            eprintln!(
                "qmm[{tag}:{name}] {ms:.2}ms  {:.0} GB/s  ({}x{})",
                gb / (ms / 1e3),
                q.out,
                q.inp
            );
        }
        }
        Ok(())
    }

    /// TH_BENCH_LIN prefill sweep (T2): per projection and M, the legacy
    /// `AffineQmppPrefill`, the routed path (`QLin::linear` /
    /// `gate_up_act`) and explicit `AffineQpf` configs — ms per call
    /// (min, and median as `med=`, over interleaved rounds), weight GB/s,
    /// TFLOPS, max|Δ| vs an fp32 reference (dequantized weights, fp32
    /// gemm, no intermediate rounding) and vs legacy (0 = bitwise
    /// identical). Candidates are timed round-robin with a rotated start
    /// each round, so GPU clock/thermal drift (measured: up to 2x over a
    /// sequential sweep) lands evenly instead of on whichever config runs
    /// last. Env: `TH_BENCH_PF_M=16,32` M list (default 16,32,64,128,512);
    /// `TH_BENCH_PF_ALL=1` every instantiated config; `TH_BENCH_PF_ONLY=
    /// down,out` shapes; `TH_BENCH_PF_SHAPES=r16n128s4,..` tile shapes;
    /// `TH_BENCH_PF_ROUNDS` (default 5).
    #[cfg(all(feature = "metal", target_os = "macos"))]
    pub(crate) fn bench_prefill(&self, device: &Device) -> Result<()> {
        use crate::quant_kernel::{AffineQmppPrefill, AffineQpf, PfCfg};
        let env_list = |k: &str| -> Option<Vec<String>> {
            std::env::var(k).ok().map(|s| {
                s.split(',')
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect()
            })
        };
        let ms_list: Vec<usize> = env_list("TH_BENCH_PF_M")
            .map(|v| v.iter().filter_map(|t| t.parse().ok()).collect())
            .unwrap_or_else(|| vec![16, 32, 64, 128, 512]);
        let all = std::env::var("TH_BENCH_PF_ALL").is_ok();
        let only = env_list("TH_BENCH_PF_ONLY");
        // restrict tile shapes, e.g. "r16n128s4,r32n256s8"
        let shapes_only = env_list("TH_BENCH_PF_SHAPES");
        let rounds: usize = std::env::var("TH_BENCH_PF_ROUNDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5)
            .max(1);
        let gdn = self.layers.iter().find_map(|l| match &l.kind {
            Kind::Gdn(g) => Some(g),
            _ => None,
        });
        let attn = self.layers.iter().find_map(|l| match &l.kind {
            Kind::Attn(a) => Some(a),
            _ => None,
        });
        // draft-commit shapes at prefill (TTFT): draft_prefill runs the
        // DFlash fc [5120 x 25600] and each draft layer's qkv [6144 x 5120]
        // over every prompt row. The batched draft propose (TH_BATCH > 1)
        // runs every draft projection over B*8 rows: besides qkv and down
        // (= the target's down shape) that is attn_dyn/mlp_dyn [1280 x
        // 5120], gate and up as two single-stream [17408 x 5120] matrices,
        // and the selector [256 x 5120] over B*7 rows. Probe mode loads no
        // draft, so time synthetic tiled weights of those shapes (values
        // don't matter).
        let synth: Vec<(&str, Lin)> = [
            ("d_fc", 5120usize, 25600usize),
            ("d_qkv", 6144, 5120),
            ("d_dyn", 1280, 5120),
            ("d_gate", 17408, 5120),
            ("d_sel", 256, 5120),
        ]
            .into_iter()
            .map(|(tag, out, inp)| -> Result<(&str, Lin)> {
                let ng = inp / 64;
                let wq: Vec<u32> = (0..out * inp / 8)
                    .map(|i| (i as u32).wrapping_mul(2654435761))
                    .collect();
                let sb: Vec<half::bf16> = (0..out * 2 * ng)
                    .map(|i| half::bf16::from_f32(if i % (2 * ng) < ng { 0.01 } else { -0.08 }))
                    .collect();
                let q = QLin::new(
                    Tensor::from_vec(wq, (out, inp / 8), device)?,
                    Tensor::from_vec(sb, (out, 2 * ng), device)?,
                    out,
                    inp,
                    64,
                );
                Ok((tag, Lin::Quant(q.tiled()?)))
            })
            .collect::<Result<_>>()?;
        let mut suite: Vec<(&str, &Lin, bool)> = vec![
            ("gate_up", &self.layers[0].mlp.gate_up, true),
            ("down", &self.layers[0].mlp.down, false),
        ];
        if let Some(g) = gdn {
            suite.push(("in_all", &g.in_all, false));
            suite.push(("out", &g.out, false));
        }
        if let Some(a) = attn {
            suite.push(("in_qkv", &a.in_qkv, false));
            suite.push(("o", &a.o, false));
        }
        // the batched verify (TH_BATCH > 1) runs lm_head over all B*8 rows,
        // the batched draft propose over B*7
        suite.push(("lm_head", &self.lm_head, false));
        for (tag, l) in &synth {
            suite.push((tag, l, false));
        }
        let maxd = |a: &Tensor, b: &Tensor| -> Result<f32> {
            Ok(a.sub(b)?.abs()?.flatten_all()?.max(0)?.to_scalar::<f32>()?)
        };
        type Cand<'a> = (String, Box<dyn Fn() -> Result<Tensor> + 'a>);
        for (tag, l, gu) in suite {
            if only.as_ref().is_some_and(|o| !o.iter().any(|t| t == tag)) {
                continue;
            }
            let Lin::Quant(q) = l else { continue };
            if !q.tiled {
                eprintln!("pf[{tag}] not tiled — skipped");
                continue;
            }
            let wd = q.wq.apply_op2_no_bwd(
                &q.sb,
                &crate::quant_kernel::AffineDequant {
                    inp: q.inp,
                    out: q.out,
                    gs: q.gs,
                    tiled: q.tiled,
                },
            )?;
            let wf = wd.to_dtype(DType::F32)?;
            let n = if gu { q.out / 2 } else { q.out };
            let padded = q.out.div_ceil(256) * 256;
            let up_tile = if gu { n / 256 } else { 0 };
            let bytes = (q.inp * q.out / 2 + q.inp * q.out / 64 * 4) as f64;
            let ng = q.inp / 64;
            for &m in &ms_list {
                let xv: Vec<f32> = (0..m * q.inp)
                    .map(|i| ((i * 2654435761) % 1000) as f32 / 100.0 - 5.0)
                    .collect();
                let x = Tensor::from_vec(xv, (m, q.inp), device)?.to_dtype(DType::BF16)?;
                let yref = {
                    let y = x.to_dtype(DType::F32)?.matmul(&wf.t()?)?;
                    if gu {
                        let g = y.narrow(1, 0, n)?;
                        let u = y.narrow(1, n, n)?;
                        candle_nn::ops::silu(&g)?.mul(&u)?
                    } else {
                        y
                    }
                };
                let flops = 2.0 * (m * q.out * q.inp) as f64;
                let mut cands: Vec<Cand> = Vec::new();
                let (xr, qr) = (&x, q);
                cands.push((
                    "legacy".into(),
                    Box::new(move || -> Result<Tensor> {
                        Ok(qr
                            .wq
                            .apply_op3_no_bwd(
                                &qr.sb,
                                xr,
                                &AffineQmppPrefill { inp: qr.inp, out: n, padded, m, up_tile },
                            )?
                            .narrow(0, 0, m)?
                            .narrow(1, 0, n)?
                            .contiguous()?)
                    }),
                ));
                let label = crate::quant_kernel::pf_route(m, n, q.inp, gu)
                    .map_or("legacy".to_string(), |c| c.label());
                cands.push((
                    format!("routed:{label}"),
                    Box::new(move || -> Result<Tensor> {
                        if gu {
                            match qr.gate_up_act(xr) {
                                Some(r) => r,
                                None => anyhow::bail!("gate_up_act: no fast path"),
                            }
                        } else {
                            qr.linear(xr)
                        }
                    }),
                ));
                for &(r, tn, sg) in crate::quant_kernel::pf_shapes() {
                    // skip row tiles that pad more than the 32-row tiling
                    if !all && m.div_ceil(r) * r > m.div_ceil(32) * 32 {
                        continue;
                    }
                    let shape = format!("r{r}n{tn}s{sg}");
                    if shapes_only.as_ref().is_some_and(|o| !o.contains(&shape)) {
                        continue;
                    }
                    let base = PfCfg::new(r, tn, sg);
                    let mut cfgs = vec![base];
                    // E1: the vectorized-epilogue tile (bitwise equal to the
                    // legacy op; only where the layout probe passes)
                    let dev_m = match device {
                        Device::Metal(d) => Some(d),
                        _ => None,
                    };
                    if dev_m.is_some_and(|d| {
                        crate::quant_kernel::pf_vec_layout_ok(d, &PfCfg { vec: true, ..base })
                    }) {
                        cfgs.push(PfCfg { vec: true, ..base });
                    }
                    if gu {
                        cfgs.push(PfCfg { fused: true, ..base });
                    } else {
                        for k in [2usize, 4, 8] {
                            // split-K only pays while the output tiles
                            // alone under-fill the GPU
                            if ng % k == 0 && (all || m.div_ceil(r) * n.div_ceil(tn) < 640) {
                                cfgs.push(PfCfg { splits: k, ..base });
                            }
                        }
                    }
                    for cfg in cfgs {
                        let op = AffineQpf { inp: q.inp, out: n, padded, m, up_tile, cfg, presum: false, emit: false };
                        cands.push((
                            cfg.label(),
                            Box::new(move || -> Result<Tensor> {
                                Ok(qr.wq.apply_op3_no_bwd(&qr.sb, xr, &op)?)
                            }),
                        ));
                    }
                }
                // correctness: one evaluation each
                let yleg = (cands[0].1)()?.to_dtype(DType::F32)?;
                let mut deltas = Vec::with_capacity(cands.len());
                for (_, f) in &cands {
                    let y = f()?.to_dtype(DType::F32)?;
                    deltas.push((maxd(&yref, &y)?, maxd(&yleg, &y)?));
                }
                // calibrate ~8ms trials, then interleaved rounds. With
                // TH_GPU_PROF=1 a trial is timed by the GPU-exclusive busy
                // time of its command buffers (R0c), not host wall time —
                // robust to host load (E1: the wall-clock sweep drifted
                // +-40% on a loaded machine)
                let gpu_t = crate::gpuprof::on();
                let mut iters = Vec::with_capacity(cands.len());
                for (_, f) in &cands {
                    let _ = f()?;
                    device.synchronize()?;
                    let t = std::time::Instant::now();
                    let _ = f()?;
                    device.synchronize()?;
                    let one = t.elapsed().as_secs_f64();
                    iters.push(((0.008 / one.max(1e-6)).ceil() as usize).clamp(2, 100));
                }
                let nc = cands.len();
                let stride = (nc / rounds).max(1);
                let mut samples: Vec<Vec<f64>> = vec![Vec::with_capacity(rounds); nc];
                for r in 0..rounds {
                    for j in 0..nc {
                        let i = (j + r * stride) % nc;
                        let f = &cands[i].1;
                        let _ = f()?;
                        device.synchronize()?;
                        let _ = crate::gpuprof::drain_busy_ms();
                        let t = std::time::Instant::now();
                        for _ in 0..iters[i] {
                            let _ = f()?;
                        }
                        device.synchronize()?;
                        let ms = if gpu_t {
                            crate::gpuprof::drain_busy_ms()
                        } else {
                            t.elapsed().as_secs_f64() * 1e3
                        };
                        samples[i].push(ms / iters[i] as f64);
                    }
                }
                for (i, (name, _)) in cands.iter().enumerate() {
                    let mut v = samples[i].clone();
                    v.sort_by(|a, b| a.total_cmp(b));
                    let (ms, med) = (v[0], v[v.len() / 2]);
                    eprintln!(
                        "pf[{tag:7} m={m:3}] {name:>16} {ms:8.3}ms {:6.0} GB/s {:5.1} TFLOPS  Δref={:.4} Δlegacy={:.4} med={med:.3}ms",
                        bytes / ms / 1e6,
                        flops / ms / 1e9,
                        deltas[i].0,
                        deltas[i].1
                    );
                }
            }
        }
        Ok(())
    }

    #[cfg(all(feature = "metal", target_os = "macos"))]
    fn warm_sg(&self, q: &QLin, x: &Tensor) -> Result<Tensor> {
        q.wq.apply_op3_no_bwd(
            &q.sb,
            x,
            &crate::quant_kernel::AffineQsg {
                inp: q.inp,
                out: q.out,
                m: 8,
                aux: 0,
                tiled: q.tiled,
            },
        )
        .map_err(Into::into)
    }

    #[cfg(all(feature = "metal", target_os = "macos"))]
    fn warm_mm(&self, q: &QLin, x: &Tensor) -> Result<Tensor> {
        q.wq.apply_op3_no_bwd(
            &q.sb,
            x,
            &crate::quant_kernel::AffineQmm {
                inp: q.inp,
                out: q.out,
                gs: q.gs,
                m: 8,
                tiled: q.tiled,
            },
        )
        .map_err(Into::into)
    }

    pub fn load(
        files: &[std::path::PathBuf],
        cfg: &Qwen35Config,
        device: &Device,
    ) -> Result<Self> {
        // prefill tile libraries (rows > 8 routing) compile here, not
        // lazily inside the first prompt or TH_BATCH > 1 decode round
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if let Device::Metal(d) = device {
            if std::env::var("TH_QMM_MPP").map_or(true, |v| v != "0") {
                let t = std::time::Instant::now();
                match crate::quant_kernel::pf_warm(d) {
                    Ok(0) => {}
                    Ok(n) => tracing::info!(
                        pipelines = n,
                        ms = format!("{:.0}", t.elapsed().as_secs_f64() * 1e3),
                        "prefill tile libraries compiled"
                    ),
                    Err(e) => tracing::warn!(error = %e, "prefill tile library compile failed"),
                }
                // K7: the m = 1 matvec pipelines (plain decode, draft
                // commits of one row) — one library compile at load
                let t = std::time::Instant::now();
                match crate::quant_kernel::qmvt_warm(d) {
                    Ok(0) => {}
                    Ok(n) => tracing::info!(
                        pipelines = n,
                        ms = format!("{:.0}", t.elapsed().as_secs_f64() * 1e3),
                        "m=1 qmvt pipelines compiled"
                    ),
                    Err(e) => tracing::warn!(error = %e, "m=1 qmvt pipeline compile failed"),
                }
            }
        }
        let w = Weights::load(files, device)?;
        let p = "language_model";
        let embed = w.get(&format!("{p}.model.embed_tokens"))?;
        let lm_head = if cfg.tie_word_embeddings {
            Lin::Dense(embed.clone())
        } else {
            maybe_tiled(w.get_lin(&format!("{p}.lm_head"))?)?
        };
        let norm = w.get(&format!("{p}.model.norm"))?;
        let rp = cfg.rope_parameters.clone().unwrap_or(RopeParams {
            rope_theta: d_theta(),
            partial_rotary_factor: d_prf(),
        });
        let rot_dim = (cfg.head_dim as f64 * rp.partial_rotary_factor) as usize;
        // Interleaved (GPT-J) convention: adjacent pairs (2i, 2i+1),
        // inv_freq_i = θ^(-2i/rot_dim).
        let half = rot_dim / 2;
        let inv: Vec<f32> = (0..half)
            .map(|i| rp.rope_theta.powf(-((2 * i) as f64) / rot_dim as f64) as f32)
            .collect();
        let pos: Vec<f32> =
            (0..cfg.max_position_embeddings).map(|p| p as f32).collect();
        let inv_t = Tensor::from_vec(inv, (half,), device)?;
        let pos_t =
            Tensor::from_vec(pos, (cfg.max_position_embeddings,), device)?;
        let freqs =
            pos_t.unsqueeze(1)?.broadcast_mul(&inv_t.unsqueeze(0)?)?;
        let (cos, sin) = (freqs.cos()?, freqs.sin()?);

        let mut layers = Vec::with_capacity(cfg.num_hidden_layers);
        for i in 0..cfg.num_hidden_layers {
            let lp = format!("{p}.model.layers.{i}");
            let input_norm = w.get(&format!("{lp}.input_layernorm"))?;
            let post_norm = w.get(&format!("{lp}.post_attention_layernorm"))?;
            let mlp = Mlp {
                gate_up: maybe_tiled(fuse_lins(&[
                    w.get_lin(&format!("{lp}.mlp.gate_proj"))?,
                    w.get_lin(&format!("{lp}.mlp.up_proj"))?,
                ])?)?,
                down: maybe_tiled(
                    w.get_lin(&format!("{lp}.mlp.down_proj"))?,
                )?,
                inter: cfg.intermediate_size,
            };
            if cfg.is_linear(i) {
                let conv3 = w.get(&format!("{lp}.linear_attn.conv1d"))?;
                let a_log = w
                    .get(&format!("{lp}.linear_attn.A_log"))?
                    .to_dtype(DType::F32)?;
                let dt_bias = w
                    .get(&format!("{lp}.linear_attn.dt_bias"))?
                    .to_dtype(DType::F32)?;
                let mut a_log64 = [0.0f32; 64];
                let mut dt_bias64 = [0.0f32; 64];
                for (i, v) in a_log.to_vec1::<f32>()?.iter().enumerate() {
                    a_log64[i] = *v;
                }
                for (i, v) in dt_bias.to_vec1::<f32>()?.iter().enumerate() {
                    dt_bias64[i] = *v;
                }
                layers.push(Layer {
                    input_norm,
                    kind: Kind::Gdn(GdnLayer {
                        // one fused projection → [qkv | z | a|b]
                        in_all: maybe_tiled(fuse_lins(&[
                            w.get_lin(&format!(
                                "{lp}.linear_attn.in_proj_qkv"
                            ))?,
                            w.get_lin(&format!(
                                "{lp}.linear_attn.in_proj_z"
                            ))?,
                            w.get_lin(&format!(
                                "{lp}.linear_attn.in_proj_a"
                            ))?,
                            w.get_lin(&format!(
                                "{lp}.linear_attn.in_proj_b"
                            ))?,
                        ])?)?,
                        conv: conv3.squeeze(2)?,
                        a_log,
                        dt_bias,
                        a_log64,
                        dt_bias64,
                        norm_w: w.get(&format!("{lp}.linear_attn.norm"))?,
                        ones_dk: Tensor::ones(
                            cfg.linear_key_head_dim,
                            DType::BF16,
                            device,
                        )?,
                        out: maybe_tiled(w.get_lin(&format!(
                            "{lp}.linear_attn.out_proj"
                        ))?)?,
                        key_dim: cfg.linear_num_key_heads
                            * cfg.linear_key_head_dim,
                        value_dim: cfg.linear_num_value_heads
                            * cfg.linear_value_head_dim,
                        num_k_heads: cfg.linear_num_key_heads,
                        num_v_heads: cfg.linear_num_value_heads,
                        head_k: cfg.linear_key_head_dim,
                        head_v: cfg.linear_value_head_dim,
                        conv_k: cfg.linear_conv_kernel_dim,
                    }),
                    post_norm,
                    mlp,
                });
            } else {
                layers.push(Layer {
                    input_norm,
                    kind: Kind::Attn(AttnLayer {
                        // one fused projection → [q|gate | k | v]
                        in_qkv: maybe_tiled(fuse_lins(&[
                            w.get_lin(&format!("{lp}.self_attn.q_proj"))?,
                            w.get_lin(&format!("{lp}.self_attn.k_proj"))?,
                            w.get_lin(&format!("{lp}.self_attn.v_proj"))?,
                        ])?)?,
                        o: maybe_tiled(
                            w.get_lin(&format!("{lp}.self_attn.o_proj"))?,
                        )?,
                        q_norm: w.get(&format!("{lp}.self_attn.q_norm"))?,
                        k_norm: w.get(&format!("{lp}.self_attn.k_norm"))?,
                        cos: cos.clone(),
                        sin: sin.clone(),
                        n_heads: cfg.num_attention_heads,
                        n_kv: cfg.num_key_value_heads,
                        head_dim: cfg.head_dim,
                        rot_dim,
                    }),
                    post_norm,
                    mlp,
                });

            }
        }
        let nslots = std::env::var("TH_BATCH")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1usize)
            .clamp(1, 8);
        let slots = (0..nslots)
            .map(|_| Slot::new(cfg, &layers, device))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            embed,
            layers,
            norm,
            lm_head,
            cfg: cfg.clone(),
            device: device.clone(),
            slots,
            draft_w: None,
            tq: None,
            debug: std::env::var("TH_DEBUG_LAYERS").is_ok(),
            gdn_consts: None,
        })
    }

    /// Number of decode slots (TH_BATCH, default 1).
    pub fn nslots(&self) -> usize {
        self.slots.len()
    }

    /// Keep only the first `n` (>=1) decode slots.
    pub fn truncate_slots(&mut self, n: usize) {
        self.slots.truncate(n.max(1));
    }

    /// Enable TurboQuant-compressed KV caches on the full-attention
    /// layers. Called post-load when EngineConfig.kv_quant is set.
    pub fn enable_kv_quant(&mut self) -> Result<()> {
        self.ensure_tq()?;
        for sl in self.slots.iter_mut() {
            sl.kv_quant = true;
        }
        Ok(())
    }

    /// Build the shared (immutable) TurboQuant context once. It is never
    /// dropped at runtime: modes are per slot, so dropping it would
    /// switch live slots' attention cache mid-generation.
    fn ensure_tq(&mut self) -> Result<()> {
        if self.tq.is_none() {
            self.tq = Some(crate::turboquant::TurboQuant::new(
                self.cfg.head_dim,
                &self.device,
            )?);
        }
        Ok(())
    }

    /// Runtime toggle for every slot — only safe between requests (the
    /// single-slot generation loop clears caches at request start).
    pub fn set_kv_quant(&mut self, on: bool) -> Result<()> {
        if on {
            self.ensure_tq()?;
        }
        for b in 0..self.slots.len() {
            self.slots[b].kv_quant = on;
            self.clear_kv_cache(b);
        }
        Ok(())
    }

    /// Per-slot admission-time variant: sets and clears only `slot` —
    /// other slots may be mid-decode and keep their own mode.
    pub fn set_kv_quant_slot(&mut self, on: bool, slot: usize) -> Result<()> {
        if on {
            self.ensure_tq()?;
        }
        self.slots[slot].kv_quant = on;
        self.clear_kv_cache(slot);
        Ok(())
    }

    /// The TurboQuant context iff `slot` runs in compressed-KV mode.
    fn slot_tq(&self, slot: usize) -> Option<&crate::turboquant::TurboQuant> {
        self.tq.as_ref().filter(|_| self.slots[slot].kv_quant)
    }


    /// Light snapshot of all mutable state for speculative-verify
    /// rollback (G1a): no GPU work — the GDN state is the committed
    /// parity's content id; the verify that follows writes the other
    /// parity, leaving this state intact for `rollback_verify`/`restore`.
    pub fn snapshot(&mut self, slot: usize) -> Result<Snapshot> {
        let sl = &self.slots[slot];
        Ok(Snapshot {
            gdn_id: sl.gdn_par.ids[sl.gdn_par.cur],
            gdn_deep: None,
            kv: sl.kv.clone(),
            kvq: sl.kvq.clone(),
            kv_tokens: sl.kv_tokens,
        })
    }

    /// Deep snapshot: bit-exact copies of the committed GDN state, for
    /// callers that restore one state many times or across several
    /// forwards (probes). Restoring copies again, so it stays reusable.
    pub fn snapshot_deep(&mut self, slot: usize) -> Result<Snapshot> {
        let mut snap = self.snapshot(slot)?;
        let sl = &self.slots[slot];
        let cur = sl.gdn_par.cur;
        snap.gdn_deep = Some(
            sl.gdn
                .iter()
                .map(|st| match st {
                    Some(g) => Ok(Some((state_copy(&g.conv[cur])?, state_copy(&g.rec[cur])?))),
                    None => Ok(None),
                })
                .collect::<Result<_>>()?,
        );
        Ok(snap)
    }

    /// Restore a snapshot. Light: the snapshot's GDN state must still be
    /// resident in one parity (at most one forward since) — the slot
    /// flips back to it. Deep: its copies are copied (never adopted) into
    /// the committed parity, so the snapshot stays immutable.
    pub fn restore(&mut self, slot: usize, snap: Snapshot) -> Result<()> {
        let sl = &mut self.slots[slot];
        let cur = sl.gdn_par.cur;
        match &snap.gdn_deep {
            Some(deep) => {
                for (st, d) in sl.gdn.iter_mut().zip(deep) {
                    if let (Some(st), Some((conv, rec))) = (st, d) {
                        st.conv[cur] = state_copy(conv)?;
                        st.rec[cur] = state_copy(rec)?;
                    }
                }
                sl.gdn_par.ids[1 - cur] = 0;
                sl.gdn_par.rewrote_cur();
            }
            None => {
                if sl.gdn_par.ids[cur] != snap.gdn_id {
                    if snap.gdn_id != 0 && sl.gdn_par.ids[1 - cur] == snap.gdn_id {
                        sl.gdn_par.cur = 1 - cur;
                    } else {
                        bail!(
                            "restore: slot {slot} no longer holds snapshot state {} (parity ids {:?}, cur {cur})",
                            snap.gdn_id,
                            sl.gdn_par.ids
                        );
                    }
                }
            }
        }
        sl.kv = snap.kv;
        sl.kvq = snap.kvq;
        sl.kv_tokens = snap.kv_tokens;
        Ok(())
    }

    /// Roll back a verify pass keeping only the first `kept` input rows
    /// committed: re-scans the committed rows from the pre-verify state —
    /// the intact other parity (light snapshot) or the deep copies — into
    /// the committed parity, and truncates the attention KV. Fused
    /// verifies commit through `gdn_fused_step` in commit mode (the same
    /// instruction stream as the verify, so the state equals a kept-row
    /// forward bit for bit); step verifies (and `TH_GDN_COMMIT=step`)
    /// re-scan the stashed pack with `gated_delta_step`. No state copies,
    /// no allocations of state buffers.
    pub fn rollback_verify(&mut self, slot: usize, snap: Snapshot, kept: usize) -> Result<()> {
        let dev = self.device.clone();
        // one-dispatch commit: the per-layer gate constants, built once
        let batch_commit = dev.is_metal() && gdn_commit_all_on() && !gdn_commit_step();
        if batch_commit && self.gdn_consts.is_none() {
            let mut c = vec![0f32; self.layers.len() * 128];
            for (i, layer) in self.layers.iter().enumerate() {
                if let Kind::Gdn(l) = &layer.kind {
                    c[i * 128..i * 128 + 64].copy_from_slice(&l.a_log64);
                    c[i * 128 + 64..i * 128 + 128].copy_from_slice(&l.dt_bias64);
                }
            }
            self.gdn_consts = Some(Tensor::from_vec(c, (self.layers.len(), 2, 64), &dev)?);
        }
        let consts = self.gdn_consts.clone();
        // (layer, kept input rows, pre-verify window, pre-verify state,
        // kept ab rows, committed state, committed window)
        #[allow(clippy::type_complexity)]
        let mut batch: Vec<(usize, Tensor, Tensor, Tensor, Tensor, Tensor, Tensor)> = Vec::new();
        let sl = &mut self.slots[slot];
        let new_len = snap.kv_tokens + kept;
        let cur = sl.gdn_par.cur;
        let light = snap.gdn_deep.is_none();
        if light && (snap.gdn_id == 0 || sl.gdn_par.ids[1 - cur] != snap.gdn_id) {
            bail!(
                "rollback_verify: slot {slot} pre-verify state {} not resident (parity ids {:?}, cur {cur})",
                snap.gdn_id,
                sl.gdn_par.ids
            );
        }
        let mut rewrote = false;
        crate::gpuprof::phase("rollback");
        crate::gpuprof::region("gdn.commit");
        for (i, layer) in self.layers.iter().enumerate() {
            let Kind::Gdn(l) = &layer.kind else { continue };
            let Some(st) = sl.gdn[i].as_mut() else { continue };
            let vc = std::mem::take(&mut sl.vcache[i]);
            // pre-verify (source) state
            let (src_conv, src_rec) = match &snap.gdn_deep {
                Some(d) => match &d[i] {
                    Some((c, r)) => (c.clone(), r.clone()),
                    None => continue,
                },
                None => (st.conv[1 - cur].clone(), st.rec[1 - cur].clone()),
            };
            let rows = vc.qkv.as_ref().map(|q| q.dim(0)).transpose()?.unwrap_or(0);
            if light && rows > 0 && kept >= rows {
                // every verified row kept: the committed parity already
                // holds exactly that state
                continue;
            }
            rewrote = true;
            if debug_rollback() {
                if let Some(q) = vc.qkv.as_ref() {
                    let qv = q.narrow(0, 0, 1)?.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
                    let cv = src_conv.narrow(0, 0, 1)?.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
                    eprintln!(
                        "  [rb-dbg] layer {i} kept={kept}/{rows} fused={} qkv0={:.3} {:.3} {:.3} conv0={:.3} {:.3} {:.3}",
                        vc.fused, qv[0], qv[1], qv[2], cv[0], cv[1], cv[2],
                    );
                }
            }
            match vc {
                #[cfg(all(feature = "metal", target_os = "macos"))]
                GdnVerifyCache { qkv: Some(qkv), ab: Some(ab), fused: true, .. }
                    if batch_commit && consts.is_some() && kept <= 8 =>
                {
                    // collected: all layers commit in one dispatch below
                    let x = qkv.narrow(0, 0, kept)?;
                    let abk = ab.narrow(ab.rank() - 2, 0, kept)?;
                    batch.push((
                        i, x, src_conv, src_rec, abk,
                        st.rec[cur].clone(), st.conv[cur].clone(),
                    ));
                }
                #[cfg(all(feature = "metal", target_os = "macos"))]
                GdnVerifyCache { qkv: Some(qkv), ab: Some(ab), fused: true, .. }
                    if !gdn_commit_step() && dev.is_metal() =>
                {
                    // fused-step commit of the kept rows: state + conv
                    // window only, from the intact pre-verify parity
                    let x = qkv.narrow(0, 0, kept)?;
                    let abk = ab.narrow(ab.rank() - 2, 0, kept)?;
                    crate::gdn_kernel::gdn_fused_step(
                        &x, &src_conv, &l.conv, &src_rec, &st.rec[cur],
                        &st.conv[cur], &abk, None, &l.norm_w, None, None,
                        kept, l.num_k_heads, l.num_v_heads, l.head_k,
                        l.head_v, self.cfg.rms_norm_eps as f32, l.a_log64,
                        l.dt_bias64, false,
                    )?;
                }
                GdnVerifyCache { qkv: Some(qkv), pack: Some(pack), ab: Some(ab), .. } => {
                    // step re-scan of the kept rows from the stashed pack
                    let kept_qkv = qkv.narrow(0, 0, kept)?;
                    Self::gdn_conv_commit(l, &src_conv, &kept_qkv, &mut st.conv[cur], kept, &dev)?;
                    // ab stashed as the strided [1, seq, 96] projection
                    // view (or [seq, 96]) — take kept rows
                    let ab = if ab.rank() == 3 { ab.squeeze(0)? } else { ab };
                    let ab = ab.narrow(0, 0, kept)?;
                    let _ = Self::gdn_scan(
                        l, &src_rec, &mut st.rec[cur], &mut None,
                        &pack.narrow(0, 0, kept)?, &ab, kept, false, &dev,
                    )?;
                }
                _ => {
                    // no cached intermediates — plain restore of the
                    // pre-verify state (as before G1a)
                    st.conv[cur] = state_copy(&src_conv)?;
                    st.rec[cur] = state_copy(&src_rec)?;
                }
            }
        }
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if let (Some(consts), Some((i0, ..))) = (consts.as_ref(), batch.first()) {
            // every collected layer's fused-step commit in one dispatch:
            // the same instruction stream as the per-layer commit (state
            // bit-identical to a kept-row forward — the R0a gate)
            let Kind::Gdn(l) = &self.layers[*i0].kind else {
                bail!("rollback_verify: batched commit on a non-GDN layer {i0}")
            };
            let list: Vec<crate::gdn_kernel::GdnCommitLayer<'_>> = batch
                .iter()
                .map(|(i, x, sc, sr, abk, so, co)| {
                    let Kind::Gdn(li) = &self.layers[*i].kind else { unreachable!() };
                    crate::gdn_kernel::GdnCommitLayer {
                        xnew: x,
                        conv_in: sc,
                        cw: &li.conv,
                        state_in: sr,
                        ab: abk,
                        state_out: so,
                        conv_out: co,
                        layer: *i,
                    }
                })
                .collect();
            crate::gdn_kernel::gdn_commit_all(
                &list, consts, kept, l.num_k_heads, l.num_v_heads, l.head_k, l.head_v,
            )?;
        }
        drop(batch);
        let sl = &mut self.slots[slot];
        if rewrote || !light {
            sl.gdn_par.rewrote_cur();
        }
        for (i, skv) in snap.kv.into_iter().enumerate() {
            if skv.is_none() {
                continue;
            }
            // cap-buffer caches keep the stale tail — reads are bounded
            // by kv_tokens so truncation is just the length update;
            // the quantised cache is length-tracked separately
            sl.kvq[i].truncate(new_len)?;
        }
        sl.kv_tokens = new_len;
        Ok(())
    }

    pub fn clear_kv_cache(&mut self, slot: usize) {
        let sl = &mut self.slots[slot];
        // walk the layer kinds (not `.flatten()`) so per-layer state an
        // aborted forward failed to hand back is rebuilt, never skipped
        for (i, layer) in self.layers.iter().enumerate() {
            match &layer.kind {
                // a fresh sequence reads the committed parity: zero it;
                // the other parity is fully overwritten by the next
                // forward (Splash: "parity one is fully overwritten by
                // the first transition")
                Kind::Gdn(l) => match sl.gdn[i].as_mut() {
                    Some(g) => {
                        let cur = sl.gdn_par.cur;
                        g.rec[cur] = Tensor::zeros_like(&g.rec[cur]).unwrap();
                        g.conv[cur] = Tensor::zeros_like(&g.conv[cur]).unwrap();
                    }
                    None => {
                        sl.gdn[i] = Some(
                            GdnState::zeros(
                                l.conv_k - 1,
                                2 * l.key_dim + l.value_dim,
                                l.num_v_heads,
                                l.head_v,
                                l.head_k,
                                &self.device,
                            )
                            .unwrap(),
                        );
                    }
                },
                Kind::Attn(_) => {
                    sl.kv[i] = Some((
                        Tensor::zeros(
                            (self.cfg.num_key_value_heads, 0, self.cfg.head_dim),
                            DType::BF16,
                            &self.device,
                        )
                        .unwrap(),
                        Tensor::zeros(
                            (self.cfg.num_key_value_heads, 0, self.cfg.head_dim),
                            DType::BF16,
                            &self.device,
                        )
                        .unwrap(),
                    ));
                }
            }
        }
        for q in sl.kvq.iter_mut() {
            *q = crate::turboquant::QuantKv::default();
        }
        match sl.draft.as_mut() {
            Some(d) => d.clear(),
            // a ring lost to an aborted round is rebuilt at admission
            None if self.draft_w.is_some() => {
                sl.draft = crate::dflash::Draft::new(&self.device).ok();
            }
            None => {}
        }
        sl.captures.clear();
        sl.capture_base = 0;
        for v in sl.vcache.iter_mut() {
            *v = GdnVerifyCache::default();
        }
        let cur = sl.gdn_par.cur;
        sl.gdn_par.ids[1 - cur] = 0;
        sl.gdn_par.rewrote_cur();
        sl.kv_tokens = 0;
    }

    // MARK: - T1 prefix cache

    /// Can `slot` be checkpointed / restored? (Raw attention cache only —
    /// the TurboQuant cache is not captured.)
    pub fn prefix_capable(&self, slot: usize) -> bool {
        !self.slots[slot].kv_quant
    }

    /// Checkpoint `slot` at its current KV position (call right after the
    /// prefill chunk that ended there). GPU copies are enqueued in stream
    /// order — no host sync. Copies the GDN state (~151 MB on Qwen3.8-27B)
    /// and the draft capture rows (<= WINDOW-1 rows, 51 KB each); K/V are
    /// shared when exact-size (see [`PrefixState`]).
    pub fn prefix_capture(&mut self, slot: usize) -> Result<PrefixState> {
        let sl = &self.slots[slot];
        anyhow::ensure!(!sl.kv_quant, "prefix capture: slot {slot} runs compressed KV");
        let pos = sl.kv_tokens;
        let cur = sl.gdn_par.cur;
        let mut bytes = 0usize;
        let mut gdn = Vec::with_capacity(sl.gdn.len());
        let mut kv = Vec::with_capacity(sl.kv.len());
        for (i, layer) in self.layers.iter().enumerate() {
            match &layer.kind {
                Kind::Gdn(_) => {
                    let st = sl.gdn[i].as_ref().context("prefix capture: gdn state missing")?;
                    let (c, r) = (state_copy_uninit(&st.conv[cur])?, state_copy_uninit(&st.rec[cur])?);
                    bytes += tensor_bytes(&c) + tensor_bytes(&r);
                    gdn.push(Some((c, r)));
                    kv.push(None);
                }
                Kind::Attn(_) => {
                    let (k, v) = sl.kv[i].as_ref().context("prefix capture: kv state missing")?;
                    // exactly [n_kv, pos, d]: share an exact-size prefill
                    // cache (never written in place again), copy the live
                    // rows out of a capacity buffer into a fresh one
                    // (`Tensor::copy` is NOT a copy on Metal in candle
                    // 0.11 — try_clone shares the buffer)
                    let exact = |t: &Tensor| -> Result<Tensor> {
                        let rows = t.dim(1)?;
                        anyhow::ensure!(rows >= pos, "prefix capture: kv has {rows} rows < pos {pos}");
                        Ok(if rows == pos && t.is_contiguous() {
                            t.clone()
                        } else {
                            state_copy_uninit(&t.narrow(1, 0, pos)?)?
                        })
                    };
                    let (k, v) = (exact(k)?, exact(v)?);
                    bytes += tensor_bytes(&k) + tensor_bytes(&v);
                    gdn.push(None);
                    kv.push(Some((k, v)));
                }
            }
        }
        // capture rows since the last drain cover capture_base..pos. Keep
        // exactly what a longer prompt's draft warm-up can reach — its last
        // WINDOW-1 rows start at or after pos-(WINDOW-1) — as ONE compact
        // group: a fresh [rows, hidden] tensor per capture layer. (The live
        // capture tensors are views that pin their forward's whole
        // [2, T, hidden] residual|normed output, twice their size, so
        // holding them would break the byte cap.) Row order and values are
        // unchanged: `take_captures` concatenates the same rows.
        let mut caps = Vec::new();
        let mut caps_base = 0;
        if sl.draft.is_some() && !sl.captures.is_empty() {
            anyhow::ensure!(sl.captures.len() % 5 == 0, "prefix capture: capture groups misaligned");
            let need_from = pos.saturating_sub(crate::dflash::WINDOW - 1).max(sl.capture_base);
            let (mut row, mut from) = (sl.capture_base, None);
            let mut kept: Vec<&[Tensor]> = Vec::new();
            for group in sl.captures.chunks_exact(5) {
                let rows = group[0].dim(0)?;
                if row + rows > need_from {
                    from.get_or_insert(row);
                    kept.push(group);
                }
                row += rows;
            }
            anyhow::ensure!(row == pos, "prefix capture: capture rows end at {row}, kv at {pos}");
            if let Some(from) = from {
                let skip = need_from - from;
                for j in 0..5 {
                    let mut parts: Vec<Tensor> = kept.iter().map(|g| g[j].clone()).collect();
                    if skip > 0 {
                        let r0 = parts[0].dim(0)?;
                        parts[0] = parts[0].narrow(0, skip, r0 - skip)?;
                    }
                    // fresh exact-size buffer, compute copies (a 1-part
                    // Tensor::cat would be a clone)
                    let t = crate::outbuf::cat0_uninit(&parts)?;
                    bytes += tensor_bytes(&t);
                    caps.push(t);
                }
                caps_base = need_from;
            }
        }
        Ok(PrefixState { pos, gdn, kv, caps, caps_base, bytes })
    }

    /// Put `slot` into the checkpointed state (the slot should have been
    /// cleared for the new request; its mode must be raw KV). The GDN
    /// state is copied into the committed parity (the checkpoint stays
    /// immutable); K/V and capture rows are shared read-only; the draft
    /// ring restarts empty and is warmed by `draft_prefill` after the
    /// suffix prefill — from the restored capture rows plus the suffix's,
    /// i.e. the same rows, committed the same way, as an uncached prefill.
    pub fn prefix_restore(&mut self, slot: usize, p: &PrefixState) -> Result<()> {
        let sl = &mut self.slots[slot];
        anyhow::ensure!(!sl.kv_quant, "prefix restore: slot {slot} runs compressed KV");
        anyhow::ensure!(
            p.gdn.len() == sl.gdn.len() && p.kv.len() == sl.kv.len(),
            "prefix restore: layer count mismatch"
        );
        let cur = sl.gdn_par.cur;
        for (i, g) in p.gdn.iter().enumerate() {
            if let Some((conv, rec)) = g {
                let st = sl.gdn[i].as_mut().context("prefix restore: gdn state missing")?;
                st.conv[cur] = state_copy_uninit(conv)?;
                st.rec[cur] = state_copy_uninit(rec)?;
            }
        }
        sl.gdn_par.ids[1 - cur] = 0;
        sl.gdn_par.rewrote_cur();
        for (i, kv) in p.kv.iter().enumerate() {
            if let Some((k, v)) = kv {
                sl.kv[i] = Some((k.clone(), v.clone()));
            }
        }
        for q in sl.kvq.iter_mut() {
            *q = crate::turboquant::QuantKv::default();
        }
        for v in sl.vcache.iter_mut() {
            *v = GdnVerifyCache::default();
        }
        if let Some(d) = sl.draft.as_mut() {
            d.clear();
        }
        sl.captures = if sl.draft.is_some() { p.caps.clone() } else { Vec::new() };
        sl.capture_base = if sl.draft.is_some() { p.caps_base } else { 0 };
        sl.kv_tokens = p.pos;
        Ok(())
    }

    // MARK: - DFlash draft integration

    /// Attach shared draft weights; every slot gets a fresh ring.
    pub fn set_draft(&mut self, w: crate::dflash::DraftWeights) -> Result<()> {
        for s in self.slots.iter_mut() {
            s.draft = Some(crate::dflash::Draft::new(&self.device)?);
        }
        self.draft_w = Some(w);
        Ok(())
    }

    pub fn has_draft(&self) -> bool {
        self.draft_w.is_some()
    }

    pub fn device(&self) -> &Device {
        &self.device
    }

    /// Drain accumulated captures → [rows, 25600] bf16. Each forward
    /// call pushes the five capture layers' [seq, 5120] hiddens in
    /// order — concat per call along the feature dim, then stack calls
    /// along rows. Rows map to the positions of the forwards since the
    /// last drain (prefill: rows are positions 0..P-1 of the prompt).
    pub fn take_captures(&mut self, slot: usize) -> Result<Option<Tensor>> {
        let sl = &mut self.slots[slot];
        if sl.captures.is_empty() {
            return Ok(None);
        }
        crate::gpuprof::phase("captures");
        let mut calls = Vec::new();
        for group in sl.captures.chunks_exact(5) {
            calls.push(Tensor::cat(group, 1)?); // [seq, 25600]
        }
        sl.captures.clear();
        let t = if calls.len() == 1 {
            calls.pop().unwrap()
        } else {
            Tensor::cat(&calls, 0)?
        };
        Ok(Some(t))
    }

    /// Warm the draft ring with the prefill captures accumulated since
    /// the last `take_captures`. Only the last `WINDOW-1` positions can
    /// ever be attended, so earlier prompt rows are skipped.
    pub fn draft_prefill(&mut self, slot: usize) -> Result<()> {
        let rows = self.draft_warmup_rows(slot)?;
        crate::gpuprof::phase("draft_prefill");
        let (w, sl) = (self.draft_w.as_ref(), &mut self.slots[slot]);
        if let (Some(w), Some(d), Some((c, start, keep))) = (w, sl.draft.as_mut(), rows) {
            w.commit(d, &c, start, keep)?;
        }
        Ok(())
    }

    /// The draft ring warm-up input (drains the captures): the capture
    /// rows since the last drain narrowed to the last WINDOW-1 positions —
    /// (rows [keep, 25600], first absolute position, keep). T1: after a
    /// prefix restore the rows start at the checkpoint's `capture_base`,
    /// not 0; the selected rows (the prompt's last WINDOW-1 positions) are
    /// the same either way.
    fn draft_warmup_rows(&mut self, slot: usize) -> Result<Option<(Tensor, usize, usize)>> {
        let base = std::mem::take(&mut self.slots[slot].capture_base);
        let Some(c) = self.take_captures(slot)? else {
            return Ok(None);
        };
        let end = base + c.dim(0)?;
        let keep = end.min(crate::dflash::WINDOW - 1);
        let start = end - keep;
        let off = start
            .checked_sub(base)
            .context("draft_prefill: restored capture rows miss the warm-up window")?;
        Ok(Some((c.narrow(0, off, keep)?.contiguous()?, start, keep)))
    }

    /// Draft-commit `rows` entries from `captured` ([rows, 25600])
    /// starting at absolute position `start_pos`.
    pub fn draft_commit(&mut self, slot: usize, captured: &Tensor, start_pos: usize, rows: usize) -> Result<()> {
        if let (Some(w), Some(d)) = (self.draft_w.as_ref(), self.slots[slot].draft.as_mut()) {
            crate::gpuprof::phase("draft_commit");
            w.commit(d, captured, start_pos, rows)?;
        }
        Ok(())
    }

    /// Run the 8-row draft block for `anchor` at position `pos` and
    /// chain the proposal block. `temp`/`uniform` control greedy vs
    /// sampled chaining.
    pub fn draft_propose(
        &mut self,
        slot: usize,
        anchor: u32,
        pos: usize,
        temp: Option<crate::dflash::DraftSampling>,
        uniform: impl FnMut() -> f64,
    ) -> Result<crate::dflash::Proposal> {
        let w = self.draft_w.as_ref().context("draft not loaded")?;
        let d = self.slots[slot].draft.as_mut().context("draft ctx")?;
        // R0c: one decode round starts with its propose
        crate::gpuprof::round();
        crate::gpuprof::phase("propose");
        w.propose(d, &self.embed, &self.lm_head, anchor, pos, temp, uniform)
    }

    /// Batched draft proposals: one draft forward over all slots'
    /// `[anchor, mask×7]` blocks. Returns per-slot proposals.
    pub fn draft_propose_batch(
        &mut self,
        slots: &[usize],
        anchors: &[u32],
        poss: &[usize],
        temps: &[Option<crate::dflash::DraftSampling>],
        uniform: &mut dyn FnMut(usize) -> f64,
    ) -> Result<Vec<crate::dflash::Proposal>> {
        let w = self.draft_w.as_ref().context("draft not loaded")?;
        crate::gpuprof::round();
        crate::gpuprof::phase("propose_b");
        // move each slot's ring ctx out — disjoint-index mutable borrows.
        // Every taken ctx goes back before any Err is returned, and the
        // hand-back is infallible (no placeholder ring allocation).
        let mut ctxs: Vec<crate::dflash::Draft> =
            Vec::with_capacity(slots.len());
        for &b in slots {
            match self.slots[b].draft.take() {
                Some(d) => ctxs.push(d),
                None => {
                    for (&sb, d) in slots.iter().zip(ctxs) {
                        self.slots[sb].draft = Some(d);
                    }
                    bail!("draft ctx missing for slot {b}");
                }
            }
        }
        let mut refs: Vec<&mut crate::dflash::Draft> =
            ctxs.iter_mut().collect();
        let r = w.propose_batch(
            refs.as_mut_slice(), &self.embed, &self.lm_head,
            anchors, poss, temps, uniform,
        );
        drop(refs);
        for (&b, d) in slots.iter().zip(ctxs) {
            self.slots[b].draft = Some(d);
        }
        r
    }

    /// Interleaved-pair RoPE on the first `rot` dims of `x`
    /// ([b, heads, seq, dim]) at absolute positions pos..pos+seq.
    fn rope(
        x: &Tensor,
        cos: &Tensor,
        sin: &Tensor,
        pos: usize,
        rot: usize,
    ) -> Result<Tensor> {
        let d = x.dims().to_vec();
        let (b, h, seq, dim) = (d[0], d[1], d[2], d[3]);
        let rot_part = x.narrow(D::Minus1, 0, rot)?;
        let rest = x.narrow(D::Minus1, rot, dim - rot)?;
        // MLX traditional=False == GPT-NeoX convention: pairs (i, i+rot/2)
        let x1 = rot_part.narrow(D::Minus1, 0, rot / 2)?;
        let x2 = rot_part.narrow(D::Minus1, rot / 2, rot / 2)?;
        let c = cos
            .narrow(0, pos, seq)?
            .reshape((1, 1, seq, rot / 2))?
            .to_dtype(x.dtype())?;
        let s = sin
            .narrow(0, pos, seq)?
            .reshape((1, 1, seq, rot / 2))?
            .to_dtype(x.dtype())?;
        let r1 = x1.broadcast_mul(&c)?.broadcast_sub(&x2.broadcast_mul(&s)?)?;
        let r2 = x2.broadcast_mul(&c)?.broadcast_add(&x1.broadcast_mul(&s)?)?;
        let rotated = Tensor::cat(&[&r1, &r2], D::Minus1)?;
        let _ = (b, h, seq, dim);
        Ok(Tensor::cat(&[&rotated, &rest], D::Minus1)?)
    }

    /// Gated delta rule for `x` [1, seq, hidden]. Sequential scan — the
    /// same recurrence serves prefill and decode. G1a parity state: reads
    /// the committed conv window / recurrent state of parity `cur` and
    /// writes the post-`seq`-row state to parity `1 - cur` (the caller
    /// flips the slot once every layer succeeded). `vc`, when set, stashes
    /// the raw scan inputs for `rollback_verify`.
    fn gdn_forward(
        l: &GdnLayer,
        st: &mut GdnState,
        cur: usize,
        vc: &mut Option<GdnVerifyCache>,
        fused: &Tensor,
        seq: usize,
        eps: f64,
    ) -> Result<Tensor> {
        let nxt = 1 - cur;
        let conv_dim = 2 * l.key_dim + l.value_dim;
        // `fused` = in_all projection [1, seq, conv+val+96] — may be a
        // slot row-slice of a batched projection; strided views feed
        // the kernels directly (no contiguous copies)
        let qkv = fused
            .narrow(D::Minus1, 0, conv_dim)?
            .squeeze(0)?; // [seq, conv] strided
        let z = fused.narrow(D::Minus1, conv_dim, l.value_dim)?;
        let ab = fused.narrow(
            D::Minus1,
            conv_dim + l.value_dim,
            2 * l.num_v_heads,
        )?;
        if let Some(c) = vc.as_mut() {
            c.qkv = Some(qkv.clone());
        }

        #[cfg(all(feature = "metal", target_os = "macos"))]
        if fused.device().is_metal() && !gdn_eager() {
            if seq <= 8 && !gdn_no_step() {
                // one dispatch: conv+silu, l2norm, delta scan, gated norm,
                // plus the new conv window — parity cur in, nxt out.
                // K45: the kernel writes every element of both outputs, so
                // they are allocated uninitialized (no zero-fill blits), and
                // `gated` is the out projection's presum block (8 rows +
                // input sums, emitted by the gated-norm stage)
                use crate::quant_kernel::AllocBf16;
                let ps = crate::quant_kernel::presum_enabled() && l.value_dim % 64 == 0;
                let gated = if ps {
                    use crate::quant_kernel::presum_block_bytes;
                    qkv.apply_op1_no_bwd(&AllocBf16 {
                        elems: presum_block_bytes(l.value_dim) / 2,
                        rows: seq,
                        cols: l.value_dim,
                    })?
                } else {
                    // MEM-2: gdn_fused_step writes every y[t, hv*dv + d] (the
                    // gated-norm stage covers all seq rows) — no zero-fill blit.
                    // (G1a: the pack stash below is already uninitialised.)
                    crate::outbuf::kernel_out((seq, l.value_dim), DType::BF16, fused.device())?
                };
                // the normed pack is only needed by a step re-scan
                let pack = if vc.is_some() && gdn_commit_step() {
                    Some(qkv.apply_op1_no_bwd(&AllocBf16 {
                        elems: seq * conv_dim,
                        rows: seq,
                        cols: conv_dim,
                    })?)
                } else {
                    None
                };
                crate::gpuprof::region("gdn.core");
                crate::gdn_kernel::gdn_fused_step(
                    &qkv, &st.conv[cur], &l.conv, &st.rec[cur], &st.rec[nxt],
                    &st.conv[nxt], &ab, Some(&z), &l.norm_w, Some(&gated),
                    pack.as_ref(), seq, l.num_k_heads, l.num_v_heads, l.head_k,
                    l.head_v, eps as f32, l.a_log64, l.dt_bias64, ps,
                )?;
                if let Some(c) = vc.as_mut() {
                    c.pack = pack;
                    c.ab = Some(ab.clone());
                    c.fused = true;
                }
                crate::gpuprof::region("gdn.out");
                return lin_apply_ps(&gated.unsqueeze(0)?, &l.out, ps);
            }
            crate::gpuprof::region("gdn.core");
            let conv_out = st.conv[cur]
                .apply_op3_no_bwd(
                    &qkv,
                    &l.conv,
                    &crate::gdn_kernel::GdnConv {
                        t: seq,
                        c: conv_dim,
                        k: l.conv_k,
                    },
                )?;
            // new window = last (k-1) rows of [state | inputs], copied
            // into the other parity (no view pins the projection output)
            crate::gdn_kernel::gdn_conv_carry(&st.conv[cur], &qkv, &st.conv[nxt], seq, l.conv_k)?;
            // rmsnorm·scale on the q/k channels of conv_out (+ v
            // copy-through) — the scan reads the result directly since
            // its flat layout IS the qkv pack the kernel wants
            let pack = conv_out.apply_op1_no_bwd(&crate::gdn_kernel::GdnQkNorm {
                t: seq,
                hk: l.num_k_heads,
                hv: l.num_v_heads,
                dk: l.head_k,
                dv: l.head_v,
            })?;
            if let Some(c) = vc.as_mut() {
                c.pack = Some(pack.clone());
            }
            let (rin, rout) = parity_pair(&mut st.rec, cur);
            let out = Self::gdn_scan(
                l,
                rin,
                rout,
                vc,
                &pack,
                &ab,
                seq,
                true,
                fused.device(),
            )?
            .context("gdn scan output")?;
            // gated RMSNorm fused: rmsnorm(out)·w ⊙ silu(z)
            let gated = out.apply_op3_no_bwd(
                &z,
                &l.norm_w,
                &crate::gdn_kernel::GdnGateNorm {
                    t: seq,
                    hv: l.num_v_heads,
                    dv: l.head_v,
                    z_stride: z.stride()[z.dims().len() - 2],
                    eps: eps as f32,
                },
            )?;
            crate::gpuprof::region("gdn.out");
            return lin_apply(
                &gated.reshape((1, seq, l.value_dim))?,
                &l.out,
            );
        }

        // ---- eager fallback (CPU / non-Metal) ----
        let qkv = qkv.contiguous()?;
        let z = z.contiguous()?;
        let ab = ab.contiguous()?;
        let conv_in = Tensor::cat(&[&st.conv[cur], &qkv], 0)?; // [k-1+seq, conv_dim]
        let conv_out = conv_silu(&conv_in, &l.conv, seq, conv_dim, l.conv_k)?;
        st.conv[nxt] =
            conv_in.narrow(0, conv_in.dim(0)? - (l.conv_k - 1), l.conv_k - 1)?;

        let q = conv_out
            .narrow(D::Minus1, 0, l.key_dim)?
            .reshape((seq, l.num_k_heads, l.head_k))?;
        let k = conv_out
            .narrow(D::Minus1, l.key_dim, l.key_dim)?
            .reshape((seq, l.num_k_heads, l.head_k))?;
        let v = conv_out
            .narrow(D::Minus1, 2 * l.key_dim, l.value_dim)?
            .reshape((seq, l.num_v_heads, l.head_v))?;

        // reference: q = dk^-1·rms_norm(q), k = dk^-0.5·rms_norm(k)
        // (rms_norm ≡ sqrt(dk)·l2norm — same thing, but the fused kernel)
        let inv = (l.head_k as f64).powf(-0.5);
        let q = candle_nn::ops::rms_norm(&q, &l.ones_dk, 1e-6)?
            .affine(inv * inv, 0.0)?;
        let k = candle_nn::ops::rms_norm(&k, &l.ones_dk, 1e-6)?
            .affine(inv, 0.0)?;

        // recurrent scan — fused single-dispatch Metal kernel when
        // available, per-token eager ops otherwise. Returns
        // [seq, num_v_heads, head_v] (bf16 fused / f32 eager).
        let pack = Tensor::cat(&[q, k, v], 1)?;
        if let Some(c) = vc.as_mut() {
            c.pack = Some(pack.clone());
        }
        let (rin, rout) = parity_pair(&mut st.rec, cur);
        let out = Self::gdn_scan(l, rin, rout, vc, &pack, &ab, seq, true, fused.device())?
            .context("gdn scan output")?;

        // gated RMSNorm: fused rms_norm(out)·w × silu(z)
        let n = candle_nn::ops::rms_norm(
            &out.to_dtype(DType::BF16)?,
            &l.norm_w,
            eps as f32,
        )?;
        let zr = z.reshape((seq, l.num_v_heads, l.head_v))?;
        let gated = n.broadcast_mul(&candle_nn::ops::silu(&zr)?)?;
        lin_apply(&gated.reshape((1, seq, l.value_dim))?, &l.out)
    }

    /// G1a: write the conv window after `t` input rows — the last k-1
    /// rows of [src | x] — into `dst` (the committed parity during a
    /// rollback, never `src`).
    fn gdn_conv_commit(
        l: &GdnLayer,
        src: &Tensor,
        x: &Tensor,
        dst: &mut Tensor,
        t: usize,
        dev: &Device,
    ) -> Result<()> {
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if dev.is_metal() {
            crate::gdn_kernel::gdn_conv_carry(src, x, dst, t, l.conv_k)?;
            return Ok(());
        }
        let _ = dev;
        *dst = Tensor::cat(&[src, &x.contiguous()?], 0)?
            .narrow(0, t, l.conv_k - 1)?
            .contiguous()?;
        Ok(())
    }

    /// The gated-delta recurrent scan. On Metal a single fused kernel
    /// handles the whole sequence (decay/beta computed in-shader); the
    /// eager fallback keeps CPU correctness. G1a: out of place — reads
    /// `rec_in`, writes the post-scan state into `rec_out` (a distinct
    /// parity buffer; the eager path replaces it).
    ///
    /// `pack` is the conv output — its flat `[q|k|v]` channel order is
    /// already the scan's packed layout, so the kernel reads it directly
    /// (a `[T, 2Hk+Hv, Dw]` view or the flat `[T, conv]` form — identical
    /// element order). `ab` is the strided bf16 `[a|b]` projection view;
    /// the kernel converts in-register. Returns `[seq, num_v_heads,
    /// head_v]` when `want_y` (the eager path always computes it). `vc`,
    /// when set, stashes the gate projections for `rollback_verify`.
    #[allow(clippy::too_many_arguments)]
    fn gdn_scan(
        l: &GdnLayer,
        rec_in: &Tensor,
        rec_out: &mut Tensor,
        vc: &mut Option<GdnVerifyCache>,
        pack: &Tensor,
        ab: &Tensor,
        seq: usize,
        want_y: bool,
        dev: &Device,
    ) -> Result<Option<Tensor>> {
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if dev.is_metal() {
            let ab_v = if gdn_ab_contig() {
                ab.contiguous()?
            } else {
                ab.clone()
            };
            if let Some(c) = vc.as_mut() {
                c.ab = Some(ab_v.clone());
            }
            let y = if want_y {
                Some(pack.apply_op1_no_bwd(&crate::quant_kernel::AllocBf16 {
                    elems: seq * l.num_v_heads * l.head_v,
                    rows: seq,
                    cols: l.num_v_heads * l.head_v,
                })?)
            } else {
                None
            };
            crate::gdn_kernel::gdn_step(
                &crate::gdn_kernel::GdnStep {
                    t: seq,
                    hk: l.num_k_heads,
                    hv: l.num_v_heads,
                    dk: l.head_k,
                    dv: l.head_v,
                    a_log: l.a_log64,
                    dt_bias: l.dt_bias64,
                },
                pack,
                &ab_v,
                rec_in,
                rec_out,
                y.as_ref(),
            )?;
            return Ok(match y {
                Some(y) => Some(y.reshape((seq, l.num_v_heads, l.head_v))?),
                None => None,
            });
        }
        let _ = (dev, want_y);

        let q = pack.narrow(1, 0, l.num_k_heads)?; // [seq, hk, dk]
        let k = pack.narrow(1, l.num_k_heads, l.num_k_heads)?;
        let v = pack.narrow(1, 2 * l.num_k_heads, l.num_v_heads)?;
        let ab2 = if ab.dims().len() == 3 {
            ab.squeeze(0)?
        } else {
            ab.clone()
        };
        if let Some(c) = vc.as_mut() {
            c.ab = Some(ab2.clone());
        }

        // share each k/q head across num_v/num_k v-heads
        let rep = l.num_v_heads / l.num_k_heads;
        let expand = |t: &Tensor| -> Result<Tensor> {
            if rep == 1 {
                return Ok(t.clone());
            }
            let (s, d) = (t.dims()[0], t.dims()[2]);
            Ok(t.unsqueeze(2)?
                .broadcast_as((s, l.num_k_heads, rep, d))?
                .reshape((s, l.num_v_heads, d))?)
        };
        let q = expand(&q.to_dtype(DType::F32)?)?;
        let k = expand(&k.to_dtype(DType::F32)?)?;
        let v = v.to_dtype(DType::F32)?;

        // decay g = exp(-exp(A_log)·softplus(a + dt_bias)), f32
        let a_f = ab2.narrow(D::Minus1, 0, l.num_v_heads)?.to_dtype(DType::F32)?;
        let b_f = ab2
            .narrow(D::Minus1, l.num_v_heads, l.num_v_heads)?
            .to_dtype(DType::F32)?;
        let g = softplus(&a_f.broadcast_add(&l.dt_bias)?)?
            .broadcast_mul(&l.a_log.exp()?.neg()?)?
            .exp()?; // [seq, 48]
        let beta = candle_nn::ops::sigmoid(&b_f)?;

        let mut rec = rec_in.clone();
        let mut outs = Vec::with_capacity(seq);
        for t in 0..seq {
            let g_t = g.i(t)?.unsqueeze(1)?.unsqueeze(2)?; // [48,1,1]
            let k_t = k.i(t)?;                             // [48,128]
            let v_t = v.i(t)?;                             // [48,128]
            let q_t = q.i(t)?;                             // [48,128]
            let b_t = beta.i(t)?.unsqueeze(1)?;            // [48,1]
            rec = rec.broadcast_mul(&g_t)?;
            // state S[h, dv, dk]: kv_mem/readout contract dk (last axis)
            let kv_mem = rec
                .broadcast_mul(&k_t.unsqueeze(1)?)?
                .sum(D::Minus1)?; // [48,128]
            let delta = v_t.sub(&kv_mem)?.broadcast_mul(&b_t)?;
            rec = rec.add(&delta.unsqueeze(2)?.broadcast_mul(&k_t.unsqueeze(1)?)?)?;
            outs.push(
                rec
                    .broadcast_mul(&q_t.unsqueeze(1)?)?
                    .sum(D::Minus1)?,
            ); // [48,128]
        }
        *rec_out = rec;
        Ok(Some(Tensor::stack(&outs, 0)?)) // [seq, 48, 128]
    }

    /// Full attention with per-head output gate, GQA, partial rope.
    /// When `tq` is set the KV cache is TurboQuant-compressed (`kvq`)
    /// instead of raw bf16 (`kvc`).
    fn attn_forward(
        l: &AttnLayer,
        kvc: &mut (Tensor, Tensor),
        kvq: &mut crate::turboquant::QuantKv,
        tq: Option<&crate::turboquant::TurboQuant>,
        qkv: &Tensor,
        pos: usize,
        seq: usize,
        eps: f64,
        device: &Device,
    ) -> Result<Tensor> {
        // `qkv` = in_qkv projection [1,seq,qd+2kd] — may be a slot
        // row-slice of a batched projection
        let qd = l.n_heads * 2 * l.head_dim;
        let kd = l.n_kv * l.head_dim;

        // TurboQuant slots (`tq`) never take the fused/split kernels —
        // they run `attn_quant` below on the compressed cache.
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if device.is_metal() && tq.is_none() && seq <= 8 && !no_attn_fused() {
            crate::gpuprof::region("attn.core");
            let (kc, vc) = kvc;
            Self::ensure_kv(kc, vc, pos + seq, device)?;
            // N3: past `TH_ATTN_SPLIT_MIN` visible keys the split-key
            // kernel replaces the single-pass one (same result contract;
            // q goes to the tile's KV-head-major layout, padded to 8 rows)
            let split = crate::attn_kernel::split_plan(
                device, pos, seq, kc.dim(1)?, l.n_heads, l.n_kv, l.head_dim,
            );
            // MEM-2: uninitialised outputs — attn_prepare writes every
            // q_buf[row, head, 0..d] (256 threads per (head, row): tid <
            // rp writes the rotated pair, tid >= 2rp the pass-through), and
            // attn_decode every out[row, h*d + c] (one simdgroup per q head,
            // 8 channels per lane). Both kernels assume d = 256 (Qwen3.8's
            // head_dim; the MEM-8 review noted it is not guarded) — the
            // zero fill never covered a wrong head_dim either. The split
            // tile reads all 8 q rows: with `qrows` set, attn_prepare
            // writes the padding rows of a short block (seq < 8, plain
            // decode) as zeros, so the tile buffer is fully written too.
            let q_buf = match split {
                None => crate::outbuf::kernel_out(
                    (seq, l.n_heads, l.head_dim),
                    DType::BF16,
                    device,
                )?,
                Some(_) => crate::outbuf::kernel_out(
                    (l.n_kv * crate::attn_kernel::SPLIT_QROWS * (l.n_heads / l.n_kv), l.head_dim),
                    DType::BF16,
                    device,
                )?,
            };
            crate::attn_kernel::attn_prepare(
                &qkv, &l.q_norm, &l.k_norm, &l.cos, &l.sin, &q_buf,
                kc, vc, pos, seq, l.n_heads, l.n_kv, l.head_dim,
                l.rot_dim / 2, eps as f32,
                if split.is_some() { crate::attn_kernel::SPLIT_QROWS } else { 0 },
            )?;
            let out = crate::outbuf::kernel_out(
                (seq, l.n_heads * l.head_dim),
                DType::BF16,
                device,
            )?;
            match split {
                // the reduce writes every out[row, h*d + c] too (one
                // threadgroup per (kv head, fused row), one thread per c)
                Some(splits) => crate::attn_kernel::attn_decode_split(
                    &q_buf, kc, vc, &qkv, &out, pos, seq, l.n_heads, l.n_kv,
                    l.head_dim, splits,
                )?,
                None => crate::attn_kernel::attn_decode(
                    &q_buf, kc, vc, &qkv, &out, pos, seq, l.n_heads, l.n_kv,
                    l.head_dim, l.rot_dim / 2,
                )?,
            }
            // TH_DEBUG_ATTN (read once): per-layer fused-vs-eager diffs
            if crate::attn_kernel::metal_impl::debug_attn() {
                eprintln!("  [attn-cfg] nh={} nkv={} hd={} rd={} pos={} seq={} cap={}",
                    l.n_heads, l.n_kv, l.head_dim, l.rot_dim, pos, seq, kc.dim(1).unwrap_or(0));
                // eager reference for the same inputs — recompute
                // norm/rope/attn eagerly and diff (cache untouched:
                // eager path reads the prefix only)
                let qg = qkv
                    .narrow(D::Minus1, 0, qd)?
                    .contiguous()?
                    .reshape((seq, l.n_heads, 2 * l.head_dim))?;
                let q0 = qg.narrow(D::Minus1, 0, l.head_dim)?;
                let gate0 = qg.narrow(D::Minus1, l.head_dim, l.head_dim)?;
                let k0 = qkv
                    .narrow(D::Minus1, qd, kd)?
                    .contiguous()?
                    .reshape((seq, l.n_kv, l.head_dim))?;
                let v0 = qkv
                    .narrow(D::Minus1, qd + kd, kd)?
                    .contiguous()?
                    .reshape((seq, l.n_kv, l.head_dim))?;
                let q0 = rms_norm(&q0.contiguous()?, &l.q_norm, eps)?;
                let k0 = rms_norm(&k0.contiguous()?, &l.k_norm, eps)?;
                let q0 = q0.transpose(0, 1)?.unsqueeze(0)?;
                let k0 = k0.transpose(0, 1)?.unsqueeze(0)?;
                let _v0 = v0.transpose(0, 1)?;
                let q0 = Self::rope(&q0, &l.cos, &l.sin, pos, l.rot_dim)?;
                let k0 = Self::rope(&k0, &l.cos, &l.sin, pos, l.rot_dim)?;
                // diff q/k vs kernel-written buffers — both to
                // [seq, heads, d] order before flatten
                // (the split tile's KV-head-major q is permuted back to
                // [seq, heads, d] for the diff)
                let q_rows = match split {
                    None => q_buf.clone(),
                    Some(_) => {
                        let grp = l.n_heads / l.n_kv;
                        q_buf
                            .reshape((l.n_kv, crate::attn_kernel::SPLIT_QROWS, grp, l.head_dim))?
                            .narrow(1, 0, seq)?
                            .permute((1, 0, 2, 3))?
                            .reshape((seq, l.n_heads, l.head_dim))?
                    }
                };
                let qd_ = q_rows.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
                let qr_ = q0.squeeze(0)?.transpose(0, 1)?.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
                let dq = qd_.iter().zip(&qr_).map(|(a,b)| (a-b).abs()).fold(0.0f32, f32::max);
                if dq > 1.0 {
                    eprintln!("    [q0]  kern={:?}", &qd_[..8]);
                    eprintln!("    [q0]  eagr={:?}", &qr_[..8]);
                }
                let kr_ = k0.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
                let kw = kc.narrow(1, pos, seq)?.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
                let kw0 = kc.narrow(1, 0, 1)?.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
                eprintln!("    [krow0] {:?}", &kw0[..16]);
                let dbg = kc.narrow(1, 0, 1)?.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
                eprintln!("    [dbg] kc[0]={} kc[200..206]={:?}", dbg[0], &dbg[200..206]);
                let all = kc.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
                let mut hits = Vec::new();
                for (i, v) in all.iter().enumerate() {
                    let iv = *v;
                    if (iv >= 33.0 && iv <= 55.0 && iv.fract() == 0.0) || iv == 66.0 || iv == 77.0 || iv == 88.0 || iv == 99.0 {
                        hits.push((i, iv));
                    }
                }
                eprintln!("    [markers] {:?}", &hits[..hits.len().min(60)]);
                let dk = kw.iter().zip(&kr_).map(|(a,b)| (a-b).abs()).fold(0.0f32, f32::max);
                if dk > 1.0 {
                    eprintln!("    [k0]  kern={:?}", &kw[..8]);
                    eprintln!("    [k0]  eagr={:?}", &kr_[..8]);
                    eprintln!("    [k0]  kern2={:?}", &kw[256..264]);
                    eprintln!("    [k0]  eagr2={:?}", &kr_[256..264]);
                }
                eprintln!("  [attn] seq={seq} pos={pos} qΔ={dq:.4} kΔ={dk:.4}");
                // eager attention over the cap-buffer prefix
                let k_all = kc.narrow(1, 0, pos + seq)?.clone();
                let v_all = vc.narrow(1, 0, pos + seq)?.clone();
                let rep = l.n_heads / l.n_kv;
                let kv_seq = pos + seq;
                let k_r = k_all.unsqueeze(1)?
                    .broadcast_as((l.n_kv, rep, kv_seq, l.head_dim))?
                    .reshape((l.n_heads, kv_seq, l.head_dim))?
                    .unsqueeze(0)?;
                let v_r = v_all.unsqueeze(1)?
                    .broadcast_as((l.n_kv, rep, kv_seq, l.head_dim))?
                    .reshape((l.n_heads, kv_seq, l.head_dim))?
                    .unsqueeze(0)?;
                let scale = (l.head_dim as f64).powf(-0.5);
                let scores = q0.contiguous()?
                    .matmul(&k_r.transpose(D::Minus2, D::Minus1)?.contiguous()?)?
                    .affine(scale, 0.0)?;
                let probs = if seq == 1 {
                    candle_nn::ops::softmax(&scores, D::Minus1)?
                } else {
                    let mut mask = vec![f32::NEG_INFINITY; seq * kv_seq];
                    for i in 0..seq {
                        for m in mask.iter_mut().skip(i * kv_seq).take(pos + i + 1) { *m = 0.0; }
                    }
                    let mask_t = Tensor::from_vec(mask, (1, 1, seq, kv_seq), device)?.to_dtype(DType::BF16)?;
                    candle_nn::ops::softmax(&scores.broadcast_add(&mask_t)?, D::Minus1)?
                };
                let out_e = probs.matmul(&v_r.contiguous()?)?
                    .squeeze(0)?.transpose(0, 1)?
                    .reshape((seq, l.n_heads * l.head_dim))?;
                let out_e = out_e.broadcast_mul(&candle_nn::ops::sigmoid(
                    &gate0.reshape((seq, l.n_heads * l.head_dim))?,
                )?)?;
                let of = out.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
                let oe = out_e.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
                let do_ = of.iter().zip(&oe).map(|(a,b)| (a-b).abs()).fold(0.0f32, f32::max);
                eprintln!("  [attn] seq={seq} pos={pos} outΔ={do_:.4}");
            }
            crate::gpuprof::region("attn.o");
            return lin_apply(&out.unsqueeze(0)?, &l.o);
        }
        crate::gpuprof::region("attn.core");

        let qg = qkv
            .narrow(D::Minus1, 0, qd)?
            .contiguous()?
            .reshape((seq, l.n_heads, 2 * l.head_dim))?;
        let q = qg.narrow(D::Minus1, 0, l.head_dim)?; // [seq, 24, 256]
        let gate = qg.narrow(D::Minus1, l.head_dim, l.head_dim)?;
        let k = qkv
            .narrow(D::Minus1, qd, kd)?
            .contiguous()?
            .reshape((seq, l.n_kv, l.head_dim))?;
        let v = qkv
            .narrow(D::Minus1, qd + kd, kd)?
            .contiguous()?
            .reshape((seq, l.n_kv, l.head_dim))?;

        let q = rms_norm(&q.contiguous()?, &l.q_norm, eps)?;
        let k = rms_norm(&k.contiguous()?, &l.k_norm, eps)?;

        // → [1, heads, seq, dim] for rope + batched matmul
        let q = q.transpose(0, 1)?.unsqueeze(0)?;
        let k = k.transpose(0, 1)?.unsqueeze(0)?;
        let v = v.transpose(0, 1)?; // [4, seq, 256]
        let q = Self::rope(&q, &l.cos, &l.sin, pos, l.rot_dim)?;
        let k = Self::rope(&k, &l.cos, &l.sin, pos, l.rot_dim)?;

        if let Some(tq) = tq {
            return Self::attn_quant(tq, l, kvq, &q, &k, &v, &gate, seq, pos, device);
        }

        let (kc, vc) = kvc;
        // E1: the fused causal prefill kernel reads K/V straight from the
        // cache after the store below, so the exact-length cat is only built
        // when something needs it (the eager path, or a (re)allocation)
        let fused = prefill_attn_variant(device, seq, q.dtype(), l.n_heads, l.n_kv, l.head_dim);
        let need = pos + seq;
        if fused.is_some() && kv_cap_prefill() && kc.dim(1)? >= need && kc.is_contiguous() && vc.is_contiguous() {
            kc.slice_set(&k.squeeze(0)?.contiguous()?, 1, pos)?;
            vc.slice_set(&v.contiguous()?, 1, pos)?;
            return Self::attn_fused_out(l, kc, vc, &q, qkv, &gate, pos, seq, fused.unwrap());
        }
        // narrow to the committed prefix — the cache may be a
        // fixed-capacity buffer whose tail is uninitialised
        let k_pre = if kc.dim(1)? > pos { kc.narrow(1, 0, pos)? } else { kc.clone() };
        let v_pre = if vc.dim(1)? > pos { vc.narrow(1, 0, pos)? } else { vc.clone() };
        let k_all = Tensor::cat(&[k_pre, k.squeeze(0)?], 1)?;
        let v_all = Tensor::cat(&[v_pre, v.clone()], 1)?;
        if kv_cap_prefill() {
            // store into a contiguous capacity buffer — the decode path's
            // attn_prepare appends in place, so the first verify no longer
            // regrows it. The old exact-length `k_all`/`v_all` caches were
            // non-contiguous views (cat's transposed fallback for the
            // transposed `v`), and the first verify's ensure_kv re-copied
            // all 32 of them through the generic strided kernel (~0.3-0.4 ms
            // each, ~11 ms per request, R0c). Same capacity rule as
            // ensure_kv's first growth. Rows >= kv_tokens are never read,
            // EXCEPT row n_prompt: the DFlash anchor off-by-one (engine.rs,
            // fixed on th/c-loop-anchor, not merged) attends it before any
            // forward writes it — hence the zero fill below.
            let need = pos + seq;
            let (nkv, hd) = (k_all.dim(0)?, k_all.dim(2)?);
            if kc.dim(1)? >= need && kc.is_contiguous() && vc.is_contiguous() {
                kc.slice_set(&k.squeeze(0)?.contiguous()?, 1, pos)?;
                vc.slice_set(&v.contiguous()?, 1, pos)?;
            } else {
                // whole 256-row blocks, as in ensure_kv: the N3 split kernel
                // reads full 32-key pages and falls back to the single-pass
                // kernel on a capacity that is not page-aligned
                // (`split_plan`) — which would also make a request's
                // numerics depend on where its capacity was first allocated
                let ncap = (need * 2).max(2048).next_multiple_of(256);
                // zero-filled like ensure_kv's pad (NOT outbuf::kernel_out):
                // with an uninitialised tail the first verify produced
                // garbage — see the fix commit / th-d-gpu-tail report
                let nk = Tensor::zeros((nkv, ncap, hd), DType::BF16, device)?;
                let nv = Tensor::zeros((nkv, ncap, hd), DType::BF16, device)?;
                nk.slice_set(&k_all.contiguous()?, 1, 0)?;
                nv.slice_set(&v_all.contiguous()?, 1, 0)?;
                *kc = nk;
                *vc = nv;
            }
        } else {
            *kc = k_all.clone();
            *vc = v_all.clone();
        }
        if let Some(var) = fused {
            drop((k_all, v_all));
            return Self::attn_fused_out(l, kc, vc, &q, qkv, &gate, pos, seq, var);
        }

        let out = Self::attn_eager(
            &q, &k_all, &v_all, pos, seq, l.n_heads, l.n_kv, l.head_dim, attn_gqa(), device,
        )?;
        let out = out.broadcast_mul(&candle_nn::ops::sigmoid(
            &gate.reshape((seq, l.n_heads * l.head_dim))?,
        )?)?;
        crate::gpuprof::region("attn.o");
        lin_apply(&out.unsqueeze(0)?, &l.o)
    }

    /// E1: the fused causal prefill attention (`attn_kernel::attn_prefill`)
    /// over the cache rows `0..pos+seq` (just stored), gated (fused into the
    /// kernel's epilogue unless `TH_PREFILL_ATTN_GATE=0`), then o_proj.
    #[allow(clippy::too_many_arguments)]
    fn attn_fused_out(
        l: &AttnLayer,
        kc: &Tensor,
        vc: &Tensor,
        q: &Tensor,
        qkv: &Tensor,
        gate: &Tensor,
        pos: usize,
        seq: usize,
        var: crate::attn_kernel::PrefillVariant,
    ) -> Result<Tensor> {
        let q = if q.stride()[3] == 1 { q.clone() } else { q.contiguous()? };
        let out = crate::attn_kernel::attn_prefill(
            &q,
            kc,
            vc,
            if var.gate { Some(qkv) } else { None },
            pos,
            seq,
            l.n_heads,
            l.n_kv,
            l.head_dim,
            var,
        )?;
        let out = if var.gate {
            out
        } else {
            out.broadcast_mul(&candle_nn::ops::sigmoid(&gate.reshape((seq, l.n_heads * l.head_dim))?)?)?
        };
        crate::gpuprof::region("attn.o");
        lin_apply(&out.unsqueeze(0)?, &l.o)
    }

    /// Eager attention for `seq` query rows at positions `pos..pos+seq`
    /// over keys `0..kv` (causal): `q` [1, n_heads, seq, d] post-rope,
    /// `k_all`/`v_all` [n_kv, kv, d] → [seq, n_heads*d] (before the output
    /// gate). `grouped` (T1b, `TH_ATTN_GQA`): q head h = g*rep + r reads
    /// KV head g, so the rep heads of group g are the rows of one
    /// [rep*seq, d] matrix — per output element the same dot products,
    /// mask and softmax rows through the same kernels (MLX nn gemm, all
    /// tiles BK = 16, no split-K; per-row reductions sized by kv only) as
    /// the broadcast form, without its three [n_heads, kv, d] copies (K,
    /// K^T, V) per layer. Bitwise equal: `gqa_tests`, TH_BENCH_ATTN.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn attn_eager(
        q: &Tensor,
        k_all: &Tensor,
        v_all: &Tensor,
        pos: usize,
        seq: usize,
        n_heads: usize,
        n_kv: usize,
        head_dim: usize,
        grouped: bool,
        device: &Device,
    ) -> Result<Tensor> {
        let kv_seq = k_all.dim(1)?;
        let rep = n_heads / n_kv;
        let scale = (head_dim as f64).powf(-0.5);
        if grouped && seq > 1 {
            let qg = q.squeeze(0)?.contiguous()?.reshape((n_kv, rep * seq, head_dim))?;
            let kt = k_all.transpose(1, 2)?.contiguous()?; // [n_kv, d, kv]
            let scores = qg.matmul(&kt)?.affine(scale, 0.0)?.reshape((n_kv, rep, seq, kv_seq))?;
            // one mask per forward, shared by every attention layer
            // (`causal_mask`; in q's dtype: bf16 on the model path)
            let mask_t = causal_mask(seq, pos, kv_seq, q.dtype(), device)?
                .reshape((1, 1, seq, kv_seq))?;
            let probs = candle_nn::ops::softmax(&scores.broadcast_add(&mask_t)?, D::Minus1)?
                .reshape((n_kv, rep * seq, kv_seq))?;
            return Ok(probs
                // V arrives time-major from the cache cat ([n_kv, kv, d] with
                // strides [d, n_kv*d, 1]) — gemm needs it contiguous
                .matmul(&v_all.contiguous()?)? // [n_kv, rep*seq, d]
                .reshape((n_heads, seq, head_dim))?
                .transpose(0, 1)?
                .reshape((seq, n_heads * head_dim))?);
        }
        let k_r = k_all
            .unsqueeze(1)?
            .broadcast_as((n_kv, rep, kv_seq, head_dim))?
            .reshape((n_heads, kv_seq, head_dim))?
            .unsqueeze(0)?; // [1, 24, kv, 256]
        let v_r = v_all
            .unsqueeze(1)?
            .broadcast_as((n_kv, rep, kv_seq, head_dim))?
            .reshape((n_heads, kv_seq, head_dim))?
            .unsqueeze(0)?;
        let scores = q
            .contiguous()?
            .matmul(&k_r.transpose(D::Minus2, D::Minus1)?.contiguous()?)
            .with_context(|| {
                format!("attn q@k q={:?}/{:?} k_r={:?}", q.shape(), q.layout().stride(), k_r.shape())
            })?
            .affine(scale, 0.0)?;
        // seq==1 decode attends over the whole cache — no mask needed
        let probs = if seq == 1 {
            candle_nn::ops::softmax(&scores, D::Minus1)?
        } else {
            // one mask per forward, shared by every attention layer
            // (`causal_mask`: a per-layer upload grew candle's pool
            // quadratically over a chunked long prompt)
            let mask_t = causal_mask(seq, pos, kv_seq, q.dtype(), device)?
                .reshape((1, 1, seq, kv_seq))?;
            candle_nn::ops::softmax(&scores.broadcast_add(&mask_t)?, D::Minus1)?
        };
        let out = probs.matmul(&v_r.contiguous()?).with_context(|| {
            format!(
                "attn probs@v probs={:?}/{:?} v_r={:?}/{:?}",
                probs.shape(),
                probs.layout().stride(),
                v_r.shape(),
                v_r.layout().stride()
            )
        })?; // [1, 24, seq, 256]
        Ok(out.squeeze(0)?.transpose(0, 1)?.reshape((seq, n_heads * head_dim))?)
    }

    /// Grow the fixed-capacity KV caches to hold `need` rows. Appended
    /// in place by `attn_prepare`; rows past `kv_tokens` are ignored, so
    /// growth just widens dim 1.
    fn ensure_kv(
        kc: &mut Tensor,
        vc: &mut Tensor,
        need: usize,
        dev: &Device,
    ) -> Result<()> {
        let cap = kc.dim(1)?;
        if cap >= need {
            return Ok(());
        }
        // whole 256-row blocks: the N3 split kernel reads full 32-key
        // pages past `need` (masked), so capacity is page-aligned
        let ncap = (cap * 2).max(need).max(2048).next_multiple_of(256);
        let (nh, hd) = (kc.dim(0)?, kc.dim(2)?);
        for t in [&mut *kc, &mut *vc] {
            let pad =
                Tensor::zeros((nh, ncap - cap, hd), DType::BF16, dev)?;
            *t = Tensor::cat(&[&*t, &pad], 1)?;
        }
        Ok(())
    }

    /// TurboQuant attention path: k/v are encoded into the compressed
    /// cache and attention runs in rotated space (rotate the query once,
    /// rotate the output back once — the cache is never de-rotated).
    /// `q`,`k` are post-rope [1, heads, seq, d]; `v` is [n_kv, seq, d].
    fn attn_quant(
        tq: &crate::turboquant::TurboQuant,
        l: &AttnLayer,
        kvq: &mut crate::turboquant::QuantKv,
        q: &Tensor,
        k: &Tensor,
        v: &Tensor,
        gate: &Tensor,
        seq: usize,
        pos: usize,
        device: &Device,
    ) -> Result<Tensor> {
        let delta = tq.encode(&k.squeeze(0)?, v)?;
        tq.append(kvq, delta)?;
        let kv_seq = kvq.len();

        let q2 = q.squeeze(0)?.transpose(0, 1)?; // [seq, 24, d]
        let (qr, sq) = tq.rotate_q(&q2)?; // f32

        let rep = l.n_heads / l.n_kv;
        let scale = (l.head_dim as f64).powf(-0.5);
        let mut scores_g = Vec::with_capacity(l.n_kv);
        for g in 0..l.n_kv {
            let qr_g = qr.narrow(1, g * rep, rep)?; // [seq, rep, d]
            let sq_g = sq.narrow(1, g * rep, rep)?;
            scores_g.push(tq.scores(&qr_g, &sq_g, kvq, g)?); // [seq,rep,T]
        }
        let scores = Tensor::cat(&scores_g, 1)?.affine(scale, 0.0)?;

        let probs = if seq == 1 {
            candle_nn::ops::softmax(&scores, D::Minus1)?
        } else {
            let mask_t = causal_mask(seq, pos, kv_seq, DType::F32, device)?
                .reshape((seq, 1, kv_seq))?;
            candle_nn::ops::softmax(
                &scores.broadcast_add(&mask_t)?,
                D::Minus1,
            )?
        };

        let mut outs = Vec::with_capacity(l.n_kv);
        for g in 0..l.n_kv {
            let w_g = probs.narrow(1, g * rep, rep)?; // [seq, rep, T]
            outs.push(tq.values(&w_g, kvq, g)?); // [seq, rep, d] f32
        }
        let out = Tensor::cat(&outs, 1)?.to_dtype(DType::BF16)?;
        let out = out
            .reshape((seq, l.n_heads * l.head_dim))?
            .broadcast_mul(&candle_nn::ops::sigmoid(
                &gate.reshape((seq, l.n_heads * l.head_dim))?,
            )?)?;
        crate::gpuprof::region("attn.o");
        lin_apply(&out.unsqueeze(0)?, &l.o)
    }

    /// tokens at absolute position `pos` → logits (vocab,) for the last.
    pub fn forward(&mut self, slot: usize, tokens: &[u32], pos: usize) -> Result<Tensor> {
        self.forward_inner(slot, tokens, pos, true)
    }

    /// Same, but logits for every position — `[seq, vocab]`. Used by the
    /// speculative-verify pass.
    pub fn forward_multi(&mut self, slot: usize, tokens: &[u32], pos: usize) -> Result<Tensor> {
        self.forward_inner(slot, tokens, pos, false)
    }

    fn forward_inner(
        &mut self,
        slot: usize,
        tokens: &[u32],
        pos: usize,
        last_only: bool,
    ) -> Result<Tensor> {
        let seq = tokens.len();
        // long-prompt prefill: trim candle's pool before the next chunk
        // (`prefill_sync_min`)
        if seq > 8 && pos > 0 && pos >= prefill_sync_min() {
            self.device.synchronize()?;
        }
        crate::gpuprof::phase(if seq > 8 { "prefill" } else if last_only { "fwd1" } else { "verify" });
        crate::gpuprof::region("embed");
        let ids = Tensor::new(tokens, &self.device)?;
        let mut x = self.embed.i(&ids)?.unsqueeze(0)?; // [1, seq, hidden]
        // stash GDN scan inputs during multi-row verify passes so a
        // partial accept can re-apply committed rows without a re-forward
        let cache_verify = !last_only && seq <= 16;
        if cache_verify {
            for v in self.slots[slot].vcache.iter_mut() {
                *v = GdnVerifyCache::default();
            }
        }
        // G1a: GDN layers read parity `cur`, write the other; the slot
        // flips only after every layer succeeded
        let cur = self.slots[slot].gdn_par.begin();
        let phase_t = std::env::var("TH_PHASE_TIME").is_ok()
            .then(std::time::Instant::now);
        // K45: (normed input, is it a presum block)
        let mut h_next: Option<(Tensor, bool)> = None;
        for i in 0..self.layers.len() {
            let layer = &self.layers[i];
            let (h, h_ps) = match h_next.take() {
                Some(v) => v,
                None => {
                    crate::gpuprof::region("norm.in");
                    (rms_norm(&x, &layer.input_norm, self.cfg.rms_norm_eps)?, false)
                }
            };
            let r = match &layer.kind {
                Kind::Gdn(l) => {
                    // K45: `h` may be a presum block (add_rms_norm_ps)
                    crate::gpuprof::region("gdn.in_all");
                    let fused = lin_apply_ps(&h, &l.in_all, h_ps)?;
                    let mut st = self.slots[slot].gdn[i]
                        .take()
                        .context("forward: slot gdn state missing")?;
                    let mut vc = cache_verify.then(GdnVerifyCache::default);
                    let r = Self::gdn_forward(
                        l, &mut st, cur, &mut vc, &fused, seq,
                        self.cfg.rms_norm_eps,
                    );
                    self.slots[slot].vcache[i] = vc.unwrap_or_default();
                    self.slots[slot].gdn[i] = Some(st);
                    r?
                }
                Kind::Attn(l) => {
                    crate::gpuprof::region("attn.qkv");
                    let qkv = lin_apply_ps(&h, &l.in_qkv, h_ps)?;
                    let mut kvc = self.slots[slot].kv[i]
                        .take()
                        .context("forward: slot kv state missing")?;
                    let mut kvq = std::mem::take(&mut self.slots[slot].kvq[i]);
                    let r = Self::attn_forward(
                        l, &mut kvc, &mut kvq, self.slot_tq(slot), &qkv, pos,
                        seq, self.cfg.rms_norm_eps, &self.device,
                    );
                    self.slots[slot].kv[i] = Some(kvc);
                    self.slots[slot].kvq[i] = kvq;
                    r?
                }
            };
            // fused: x += r; h2 = rms_norm(x)·post_norm — one dispatch
            crate::gpuprof::region("norm.post");
            let (xn, h2, h2_ps) =
                add_rms_norm_ps(&x, &r, &layer.post_norm, self.cfg.rms_norm_eps)?;
            crate::gpuprof::region("mlp.gate_up");
            // fused gate|up projection with in-kernel silu·mul epilogue
            // (eager narrow + silu·mul fallback off-Metal / prefill);
            // act_ps = the N256 tile emitted a presum block for `down`
            let (act, act_ps) = match &layer.mlp.gate_up {
                Lin::Quant(q) => match q.gate_up_act_ps(&h2, h2_ps) {
                    Some(r) => r?,
                    None => {
                        let gu = lin_apply_ps(&h2, &layer.mlp.gate_up, h2_ps)?;
                        let gate = gu
                            .narrow(D::Minus1, 0, layer.mlp.inter)?
                            .contiguous()?;
                        let up = gu
                            .narrow(
                                D::Minus1,
                                layer.mlp.inter,
                                layer.mlp.inter,
                            )?
                            .contiguous()?;
                        (candle_nn::ops::silu(&gate)?.mul(&up)?, false)
                    }
                },
                _ => {
                    let gu = lin_apply(&h2, &layer.mlp.gate_up)?;
                    let gate = gu
                        .narrow(D::Minus1, 0, layer.mlp.inter)?
                        .contiguous()?;
                    let up = gu
                        .narrow(D::Minus1, layer.mlp.inter, layer.mlp.inter)?
                        .contiguous()?;
                    (candle_nn::ops::silu(&gate)?.mul(&up)?, false)
                }
            };
            crate::gpuprof::region("mlp.down");
            let mlp = lin_apply_ps(&act, &layer.mlp.down, act_ps)?;
            crate::gpuprof::region("norm.next");
            if i + 1 < self.layers.len() {
                // fused: x += mlp; h_next = rms_norm(x)·next input_norm
                let (xn2, hn, hn_ps) = add_rms_norm_ps(
                    &xn,
                    &mlp,
                    &self.layers[i + 1].input_norm,
                    self.cfg.rms_norm_eps,
                )?;
                x = xn2;
                h_next = Some((hn, hn_ps));
            } else {
                x = xn.add(&mlp)?;
            }
            if self.slots[slot].draft.is_some()
                && crate::dflash::CAPTURE_LAYERS.contains(&i)
            {
                crate::gpuprof::region("capture");
                self.slots[slot]
                    .captures
                    .push(x.squeeze(0)?.contiguous()?);
            }
            if self.debug {
                let xf = x.to_dtype(DType::F32)?;
                let mean = xf.abs()?.mean_all()?.to_scalar::<f32>()?;
                let last = xf
                    .i((0, seq - 1, 0..8.min(self.cfg.hidden_size)))?
                    .to_vec1::<f32>()?;
                eprintln!("L{i:02} mean|x|={mean:.4} x[-1,:8]={last:?}");
            }
        }
        crate::gpuprof::region("norm.final");
        let x = rms_norm(&x, &self.norm, self.cfg.rms_norm_eps)?;
        if let Some(t0) = phase_t {
            self.device.synchronize()?;
            eprintln!(
                "[phase] seq={seq} layers={:.1}ms",
                t0.elapsed().as_secs_f64() * 1e3
            );
        }
        let t1 = phase_t.map(|_| std::time::Instant::now());
        self.slots[slot].kv_tokens = pos + seq;
        self.slots[slot].gdn_par.flip();
        crate::gpuprof::region("lm_head");
        if last_only {
            let last = x.narrow(1, seq - 1, 1)?; // [1, 1, hidden]
            let logits =
                lin_apply(&last, &self.lm_head)?.reshape((self.cfg.vocab_size,))?;
            let logits = logits.to_dtype(DType::F32)?;
            crate::gpuprof::region("post");
            return Ok(logits);
        }
        // [1, seq, vocab] — keep bf16 (halves the accept readback)
        let out = lin_apply(&x, &self.lm_head)?.squeeze(0)?;
        // the caller's argmax / readback lands here
        crate::gpuprof::region("post");
        if let Some(t) = t1 {
            self.device.synchronize()?;
            eprintln!("[phase] lm_head={:.1}ms", t.elapsed().as_secs_f64() * 1e3);
        }
        Ok(out)
    }

    /// Batched verify forward: `seqs[b]` token rows for slot `b` at
    /// position `poss[b]`. The matmuls run once over the flat
    /// `[1, Σseq, hidden]` activation — one weight sweep serves all
    /// slots; the stateful ops (GDN step, attention) dispatch per slot
    /// on narrowed views so caches, recurrent state and verify caches
    /// stay strictly per-request. Returns `[Σseq, vocab]` bf16.
    pub fn forward_batch(
        &mut self,
        slots: &[usize],
        seqs: &[&[u32]],
        poss: &[usize],
    ) -> Result<Tensor> {
        let nb = seqs.len();
        let mut offs = Vec::with_capacity(nb + 1);
        offs.push(0usize);
        for sq in seqs {
            offs.push(offs.last().unwrap() + sq.len());
        }
        let flat: Vec<u32> =
            seqs.iter().flat_map(|s| s.iter().copied()).collect();
        crate::gpuprof::phase("vbatch");
        crate::gpuprof::region("embed");
        let ids = Tensor::new(flat.as_slice(), &self.device)?;
        let mut x = self.embed.i(&ids)?.unsqueeze(0)?; // [1, total, hidden]
        for &sb in slots {
            for v in self.slots[sb].vcache.iter_mut() {
                *v = GdnVerifyCache::default();
            }
        }
        // G1a: per-slot parity — read `curs[b]`, write the other
        let curs: Vec<usize> = slots
            .iter()
            .map(|&sb| self.slots[sb].gdn_par.begin())
            .collect();
        let eps = self.cfg.rms_norm_eps;
        // K45: (normed input, is it a presum block) — as in forward_inner.
        // add_rms_norm_ps only emits blocks for Σseq <= 8 rows, so wider
        // batches take the plain path; per-slot ops (GDN step + out
        // projection, attention) run at seq_b rows either way.
        let mut h_next: Option<(Tensor, bool)> = None;
        for i in 0..self.layers.len() {
            let layer = &self.layers[i];
            let (h, h_ps) = match h_next.take() {
                Some(v) => v,
                None => {
                    crate::gpuprof::region("norm.in");
                    (rms_norm(&x, &layer.input_norm, eps)?, false)
                }
            };
            let r = match &layer.kind {
                Kind::Gdn(l) => {
                    crate::gpuprof::region("gdn.in_all");
                    let fused = lin_apply_ps(&h, &l.in_all, h_ps)?;
                    let mut parts = Vec::with_capacity(nb);
                    for b in 0..nb {
                        let sb = slots[b];
                        let seq_b = seqs[b].len();
                        let fv = fused.narrow(1, offs[b], seq_b)?;
                        let mut st = self.slots[sb].gdn[i]
                            .take()
                            .context("forward_batch: slot gdn state missing")?;
                        let mut vc = Some(GdnVerifyCache::default());
                        // hand the state back BEFORE propagating an Err —
                        // an early `?` left gdn[i] = None and the next
                        // forward on this slot panicked the th-batch thread
                        let o = Self::gdn_forward(
                            l, &mut st, curs[b], &mut vc, &fv, seq_b, eps,
                        );
                        self.slots[sb].vcache[i] = vc.unwrap_or_default();
                        self.slots[sb].gdn[i] = Some(st);
                        parts.push(o?);
                    }
                    Tensor::cat(&parts, 1)?
                }
                Kind::Attn(l) => {
                    crate::gpuprof::region("attn.qkv");
                    let qkv = lin_apply_ps(&h, &l.in_qkv, h_ps)?;
                    let mut parts = Vec::with_capacity(nb);
                    for b in 0..nb {
                        let sb = slots[b];
                        let seq_b = seqs[b].len();
                        let qv = qkv.narrow(1, offs[b], seq_b)?;
                        let mut kvc = self.slots[sb].kv[i]
                            .take()
                            .context("forward_batch: slot kv state missing")?;
                        let mut kvq =
                            std::mem::take(&mut self.slots[sb].kvq[i]);
                        let o = Self::attn_forward(
                            l, &mut kvc, &mut kvq, self.slot_tq(sb),
                            &qv, poss[b], seq_b, eps, &self.device,
                        );
                        self.slots[sb].kv[i] = Some(kvc);
                        self.slots[sb].kvq[i] = kvq;
                        parts.push(o?);
                    }
                    Tensor::cat(&parts, 1)?
                }
            };
            crate::gpuprof::region("norm.post");
            let (xn, h2, h2_ps) =
                add_rms_norm_ps(&x, &r, &layer.post_norm, eps)?;
            crate::gpuprof::region("mlp.gate_up");
            let (act, act_ps) = match &layer.mlp.gate_up {
                Lin::Quant(q) => match q.gate_up_act_ps(&h2, h2_ps) {
                    Some(r) => r?,
                    None => {
                        let gu = lin_apply_ps(&h2, &layer.mlp.gate_up, h2_ps)?;
                        let gate = gu
                            .narrow(D::Minus1, 0, layer.mlp.inter)?
                            .contiguous()?;
                        let up = gu
                            .narrow(
                                D::Minus1,
                                layer.mlp.inter,
                                layer.mlp.inter,
                            )?
                            .contiguous()?;
                        (candle_nn::ops::silu(&gate)?.mul(&up)?, false)
                    }
                },
                _ => {
                    let gu = lin_apply(&h2, &layer.mlp.gate_up)?;
                    let gate = gu
                        .narrow(D::Minus1, 0, layer.mlp.inter)?
                        .contiguous()?;
                    let up = gu
                        .narrow(
                            D::Minus1,
                            layer.mlp.inter,
                            layer.mlp.inter,
                        )?
                        .contiguous()?;
                    (candle_nn::ops::silu(&gate)?.mul(&up)?, false)
                }
            };
            crate::gpuprof::region("mlp.down");
            let mlp = lin_apply_ps(&act, &layer.mlp.down, act_ps)?;
            crate::gpuprof::region("norm.next");
            if i + 1 < self.layers.len() {
                let (xn2, hn, hn_ps) = add_rms_norm_ps(
                    &xn,
                    &mlp,
                    &self.layers[i + 1].input_norm,
                    eps,
                )?;
                x = xn2;
                h_next = Some((hn, hn_ps));
            } else {
                x = xn.add(&mlp)?;
            }
            if crate::dflash::CAPTURE_LAYERS.contains(&i) {
                crate::gpuprof::region("capture");
                let x2 = x.squeeze(0)?.contiguous()?;
                for b in 0..nb {
                    let sb = slots[b];
                    if self.slots[sb].draft.is_some() {
                        let rows = seqs[b].len();
                        self.slots[sb].captures.push(
                            x2.narrow(0, offs[b], rows)?.contiguous()?,
                        );
                    }
                }
            }
        }
        for b in 0..nb {
            self.slots[slots[b]].kv_tokens = poss[b] + seqs[b].len();
            self.slots[slots[b]].gdn_par.flip();
        }
        crate::gpuprof::region("norm.final");
        let x = rms_norm(&x, &self.norm, eps)?;
        crate::gpuprof::region("lm_head");
        let out = lin_apply(&x, &self.lm_head)?.squeeze(0)?; // [total, vocab]
        crate::gpuprof::region("post");
        Ok(out)
    }
}

// MARK: - R0a state-bitwise rollback gate (TH_TEST_ROLLBACK probe)

/// One keep count of [`Qwen35::rollback_state_check`]: bit-level
/// mismatch counts of the post-round GDN state (recurrent f32 elements,
/// conv-window bf16 elements, summed over all GDN layers) against three
/// references built from the same pre-verify state.
#[cfg(all(feature = "metal", target_os = "macos"))]
#[derive(Debug, Default, Clone)]
pub(crate) struct RollbackStateCheck {
    pub kept: usize,
    pub layers: usize,
    pub rec_elems: usize,
    pub conv_elems: usize,
    /// vs the fused-step kernel scanning only the kept rows (the stashed
    /// verify inputs) — the gate: a round must leave exactly the state
    /// a kept-row forward produces
    pub rec_diff_f: usize,
    /// of `rec_diff_f`: +0.0 vs -0.0 only (numerically equal)
    pub rec_zsign_f: usize,
    pub rec_max_f: f32,
    pub conv_diff_f: usize,
    pub layers_bad_f: usize,
    /// info: vs the `gated_delta_step` rescan of the same rows
    pub rec_diff_s: usize,
    pub rec_max_s: f32,
    /// info: vs a continuous forward of only the kept rows (later layers
    /// carry matmul batch-shape noise, so not expected bitwise)
    pub rec_diff_c: usize,
    pub rec_max_c: f32,
    pub conv_diff_c: usize,
    /// the fused kernel's written conv window vs the host-built reference
    pub conv_kernel_diff: usize,
}

#[cfg(all(feature = "metal", target_os = "macos"))]
impl RollbackStateCheck {
    pub fn ok(&self) -> bool {
        self.layers > 0
            && self.rec_diff_f == 0
            && self.conv_diff_f == 0
            && self.conv_kernel_diff == 0
    }
}

/// Bit-level f32 comparison: (differing elements, max |a-b|).
#[cfg(all(feature = "metal", target_os = "macos"))]
fn bits_diff_f32(a: &Tensor, b: &Tensor) -> Result<(usize, f32)> {
    let va = a.flatten_all()?.to_vec1::<f32>()?;
    let vb = b.flatten_all()?.to_vec1::<f32>()?;
    anyhow::ensure!(va.len() == vb.len(), "f32 compare: {} vs {}", va.len(), vb.len());
    let (mut n, mut mx) = (0usize, 0f32);
    for (x, y) in va.iter().zip(vb.iter()) {
        if x.to_bits() != y.to_bits() {
            n += 1;
            let d = (x - y).abs();
            mx = if d.is_nan() { f32::INFINITY } else { mx.max(d) };
        }
    }
    Ok((n, mx))
}

/// Mismatching f32 elements that are numerically equal (+0.0 vs -0.0).
#[cfg(all(feature = "metal", target_os = "macos"))]
fn zero_sign_diff_f32(a: &Tensor, b: &Tensor) -> Result<usize> {
    let va = a.flatten_all()?.to_vec1::<f32>()?;
    let vb = b.flatten_all()?.to_vec1::<f32>()?;
    Ok(va.iter().zip(vb.iter()).filter(|(x, y)| x.to_bits() != y.to_bits() && x == y).count())
}

/// Bit-level bf16 comparison: differing elements.
#[cfg(all(feature = "metal", target_os = "macos"))]
fn bits_diff_bf16(a: &[half::bf16], b: &[half::bf16]) -> Result<usize> {
    anyhow::ensure!(a.len() == b.len(), "bf16 compare: {} vs {}", a.len(), b.len());
    Ok(a.iter().zip(b.iter()).filter(|(x, y)| x.to_bits() != y.to_bits()).count())
}

#[cfg(all(feature = "metal", target_os = "macos"))]
impl Qwen35 {
    fn gdn_layer_ids(&self) -> Vec<usize> {
        (0..self.layers.len())
            .filter(|&i| matches!(self.layers[i].kind, Kind::Gdn(_)))
            .collect()
    }

    /// Deep copies of `slot`'s committed GDN state per GDN layer:
    /// (conv window [k-1, conv_dim] bf16, recurrent [hv, dv, dk] f32).
    pub(crate) fn gdn_state_copy(&self, slot: usize) -> Result<Vec<(Tensor, Tensor)>> {
        let cur = self.slots[slot].gdn_par.cur;
        self.gdn_layer_ids()
            .iter()
            .map(|&i| {
                let st = self.slots[slot].gdn[i].as_ref().context("gdn state missing")?;
                Ok((state_copy(&st.conv[cur])?, state_copy(&st.rec[cur])?))
            })
            .collect()
    }

    /// R0a gate for one keep count: runs one engine round on `slot` at
    /// `pos` (snapshot → verify `seq` → rollback_verify(kept), skipped
    /// on a full accept like the DFlash loop) and compares the committed
    /// GDN state bit for bit against a reference fused scan of only the
    /// kept rows from a deep copy of the pre-verify state (plus info
    /// references). Leaves `slot` restored to its pre-verify state.
    pub(crate) fn rollback_state_check(
        &mut self,
        slot: usize,
        pos: usize,
        seq: &[u32],
        kept: usize,
    ) -> Result<RollbackStateCheck> {
        anyhow::ensure!(kept >= 1 && kept <= seq.len() && seq.len() <= 8, "kept {kept} / seq {}", seq.len());
        let dev = self.device.clone();
        let ids = self.gdn_layer_ids();
        let pre = self.gdn_state_copy(slot)?;
        let keep = self.snapshot_deep(slot)?;
        // the engine's round
        let snap = self.snapshot(slot)?;
        let _ = self.forward_multi(slot, seq, pos)?;
        let stash: Vec<(Tensor, Tensor)> = ids
            .iter()
            .map(|&i| {
                let vc = &self.slots[slot].vcache[i];
                Ok((
                    vc.qkv.clone().context("verify stash: qkv")?,
                    vc.ab.clone().context("verify stash: ab")?,
                ))
            })
            .collect::<Result<_>>()?;
        if kept < seq.len() {
            self.rollback_verify(slot, snap, kept)?;
        } else {
            drop(snap);
        }
        let rb = self.gdn_state_copy(slot)?;
        // continuous kept-row forward from the same pre-verify state
        self.restore(slot, keep.clone())?;
        let _ = self.forward_multi(slot, &seq[..kept], pos)?;
        let cont = self.gdn_state_copy(slot)?;
        self.restore(slot, keep)?;

        let mut r = RollbackStateCheck { kept, layers: ids.len(), ..Default::default() };
        for (j, &i) in ids.iter().enumerate() {
            let Kind::Gdn(l) = &self.layers[i].kind else { continue };
            let conv_dim = 2 * l.key_dim + l.value_dim;
            let (qkv, ab) = &stash[j];
            let (pre_conv, pre_rec) = &pre[j];
            let x = qkv.narrow(0, 0, kept)?; // [kept, conv] strided
            let abk = ab.narrow(ab.rank() - 2, 0, kept)?;
            // reference F: the fused step kernel in forward mode (writes y
            // and pack too — not the commit path) over only the kept rows,
            // out of place into fresh buffers
            let rec_f = Tensor::zeros_like(pre_rec)?;
            let conv_f = Tensor::zeros_like(pre_conv)?;
            let y = Tensor::zeros((kept, l.value_dim), DType::BF16, &dev)?;
            let pk = Tensor::zeros((kept, conv_dim), DType::BF16, &dev)?;
            crate::gdn_kernel::gdn_fused_step(
                &x, pre_conv, &l.conv, pre_rec, &rec_f, &conv_f, &abk,
                Some(&x) /* z: y only */, &l.norm_w, Some(&y), Some(&pk),
                kept, l.num_k_heads, l.num_v_heads, l.head_k, l.head_v,
                self.cfg.rms_norm_eps as f32, l.a_log64, l.dt_bias64, false,
            )?;
            // info reference S: gated_delta_step over the same normed rows
            let rec_s = Tensor::zeros_like(pre_rec)?;
            let ab2 = if abk.rank() == 3 { abk.squeeze(0)? } else { abk.clone() };
            crate::gdn_kernel::gdn_step(
                &crate::gdn_kernel::GdnStep {
                    t: kept,
                    hk: l.num_k_heads,
                    hv: l.num_v_heads,
                    dk: l.head_k,
                    dv: l.head_v,
                    a_log: l.a_log64,
                    dt_bias: l.dt_bias64,
                },
                &pk,
                &ab2,
                pre_rec,
                &rec_s,
                None,
            )?;
            // reference conv window: last k-1 rows of [pre window | kept rows]
            let pc = pre_conv.flatten_all()?.to_vec1::<half::bf16>()?;
            let xr = x.contiguous()?.flatten_all()?.to_vec1::<half::bf16>()?;
            let all: Vec<half::bf16> = pc.iter().chain(xr.iter()).copied().collect();
            let win = &all[kept * conv_dim..];
            // the kernel's in-shader window carry must match the host one
            r.conv_kernel_diff +=
                bits_diff_bf16(&conv_f.flatten_all()?.to_vec1::<half::bf16>()?, win)?;
            let (rb_conv, rb_rec) = &rb[j];
            let rbc = rb_conv.flatten_all()?.to_vec1::<half::bf16>()?;
            let (df, mf) = bits_diff_f32(rb_rec, &rec_f)?;
            let cf = bits_diff_bf16(&rbc, win)?;
            let (ds, ms) = bits_diff_f32(rb_rec, &rec_s)?;
            let (dc, mc) = bits_diff_f32(rb_rec, &cont[j].1)?;
            let cc = bits_diff_bf16(&rbc, &cont[j].0.flatten_all()?.to_vec1::<half::bf16>()?)?;
            r.rec_elems += rb_rec.elem_count();
            r.conv_elems += rbc.len();
            r.rec_diff_f += df;
            if df > 0 {
                r.rec_zsign_f += zero_sign_diff_f32(rb_rec, &rec_f)?;
            }
            r.rec_max_f = r.rec_max_f.max(mf);
            r.conv_diff_f += cf;
            r.layers_bad_f += (df + cf > 0) as usize;
            r.rec_diff_s += ds;
            r.rec_max_s = r.rec_max_s.max(ms);
            r.rec_diff_c += dc;
            r.rec_max_c = r.rec_max_c.max(mc);
            r.conv_diff_c += cc;
        }
        Ok(r)
    }

    /// Slot isolation (needs >= 2 slots): a round on `other` must leave
    /// `slot`'s committed GDN state bitwise untouched, and the same round
    /// on two identically-prefilled slots must produce bitwise-equal
    /// states. Returns (untouched, equal); leaves both slots restored.
    pub(crate) fn slot_isolation_check(
        &mut self,
        slot: usize,
        other: usize,
        prompt: &[u32],
        seq: &[u32],
        kept: usize,
    ) -> Result<(bool, bool)> {
        let same = |a: &[(Tensor, Tensor)], b: &[(Tensor, Tensor)]| -> Result<bool> {
            for ((ac, ar), (bc, br)) in a.iter().zip(b.iter()) {
                if bits_diff_f32(ar, br)?.0 != 0 {
                    return Ok(false);
                }
                let (x, y) = (
                    ac.flatten_all()?.to_vec1::<half::bf16>()?,
                    bc.flatten_all()?.to_vec1::<half::bf16>()?,
                );
                if bits_diff_bf16(&x, &y)? != 0 {
                    return Ok(false);
                }
            }
            Ok(a.len() == b.len() && !a.is_empty())
        };
        let pos = prompt.len();
        let keep_s = self.snapshot_deep(slot)?;
        let keep_o = self.snapshot_deep(other)?;
        // identical histories: fresh prefill of the same prompt on both
        for s in [slot, other] {
            self.clear_kv_cache(s);
            let _ = self.forward(s, prompt, 0)?;
        }
        let before = self.gdn_state_copy(slot)?;
        let round = |m: &mut Self, s: usize| -> Result<()> {
            let snap = m.snapshot(s)?;
            let _ = m.forward_multi(s, seq, pos)?;
            if kept < seq.len() {
                m.rollback_verify(s, snap, kept)?;
            }
            Ok(())
        };
        round(self, other)?;
        let after = self.gdn_state_copy(slot)?;
        let untouched = same(&before, &after)?;
        round(self, slot)?;
        let equal = same(&self.gdn_state_copy(slot)?, &self.gdn_state_copy(other)?)?;
        self.restore(slot, keep_s)?;
        self.restore(other, keep_o)?;
        Ok((untouched, equal))
    }

    /// Host bits of what a later forward of `slot` reads: each GDN
    /// layer's committed state (conv window, recurrent) and each attention
    /// layer's live K/V rows (`0..kv_tokens`).
    pub(crate) fn slot_state_bits(&self, slot: usize) -> Result<Vec<Vec<u32>>> {
        let sl = &self.slots[slot];
        let cur = sl.gdn_par.cur;
        let mut out = Vec::new();
        for (i, layer) in self.layers.iter().enumerate() {
            match &layer.kind {
                Kind::Gdn(_) => {
                    let g = sl.gdn[i].as_ref().context("gdn state missing")?;
                    out.push(tensor_bits(&g.conv[cur])?);
                    out.push(tensor_bits(&g.rec[cur])?);
                }
                Kind::Attn(_) => {
                    let (k, v) = sl.kv[i].as_ref().context("kv state missing")?;
                    out.push(tensor_bits(&k.narrow(1, 0, sl.kv_tokens)?)?);
                    out.push(tensor_bits(&v.narrow(1, 0, sl.kv_tokens)?)?);
                }
            }
        }
        Ok(out)
    }

    /// T1 prefix-cache gate on the real model (TH_TEST_ROLLBACK probe):
    /// the uncached prefill of `prompt` on `slot` in the chunks `[0, at)`,
    /// `[at, n)` — checkpointing at `at` on the way — against restoring
    /// that checkpoint into the cleared slot `into` (may be `slot`) and
    /// prefilling only `[at, n)`. Bit-compares the last-row logits, the
    /// post-prefill slot state (GDN + K/V), the next verify's logits
    /// (`seq` at `n`), and the checkpoint before vs after the restored
    /// slot's forwards. Leaves `slot` as it found it and `into` cleared.
    pub(crate) fn prefix_restore_check(
        &mut self,
        slot: usize,
        into: usize,
        prompt: &[u32],
        at: usize,
        seq: &[u32],
    ) -> Result<PrefixRestoreCheck> {
        let n = prompt.len();
        anyhow::ensure!(at > 0 && at < n, "prefix check: split {at} outside (0, {n})");
        let keep = self.snapshot_deep(slot)?;
        // uncached reference, checkpoint at `at` on the way
        self.clear_kv_cache(slot);
        let _ = self.forward(slot, &prompt[..at], 0)?;
        let ck = self.prefix_capture(slot)?;
        let ck_bits = ck.state_bits()?;
        let l_ref = tensor_bits(&self.forward(slot, &prompt[at..], at)?)?;
        let s_ref = self.slot_state_bits(slot)?;
        let v_ref = tensor_bits(&self.forward_multi(slot, seq, n)?)?;
        // restored: checkpoint + the suffix only
        self.clear_kv_cache(into);
        self.prefix_restore(into, &ck)?;
        let l_got = tensor_bits(&self.forward(into, &prompt[at..], at)?)?;
        let s_got = self.slot_state_bits(into)?;
        let v_got = tensor_bits(&self.forward_multi(into, seq, n)?)?;
        let r = PrefixRestoreCheck {
            pos: at,
            logits_diff: bit_diffs(&[l_ref], &[l_got]),
            state_diff: bit_diffs(&s_ref, &s_got),
            verify_diff: bit_diffs(&[v_ref], &[v_got]),
            ckpt_diff: bit_diffs(&ck_bits, &ck.state_bits()?),
        };
        self.clear_kv_cache(into);
        self.restore(slot, keep)?;
        Ok(r)
    }
}

/// [`Qwen35::prefix_restore_check`]: bit-mismatch counts of the restored
/// path against the uncached prefill — all must be zero.
#[cfg(all(feature = "metal", target_os = "macos"))]
#[derive(Debug, Default, Clone)]
pub(crate) struct PrefixRestoreCheck {
    /// checkpoint position (prompt tokens restored)
    pub pos: usize,
    /// last prompt row's logits (f32 elements)
    pub logits_diff: usize,
    /// post-prefill committed GDN state + live K/V elements
    pub state_diff: usize,
    /// the next verify's logits (bf16 elements)
    pub verify_diff: usize,
    /// the checkpoint's own tensors before vs after the restored slot's
    /// forwards (a restore must never be written through)
    pub ckpt_diff: usize,
}

#[cfg(all(feature = "metal", target_os = "macos"))]
impl PrefixRestoreCheck {
    pub fn ok(&self) -> bool {
        self.logits_diff == 0 && self.state_diff == 0 && self.verify_diff == 0 && self.ckpt_diff == 0
    }
}

/// Host bit patterns of a float tensor (f32 as-is, other dtypes via
/// bf16) — the T1 prefix-cache bitwise checks.
#[cfg(all(feature = "metal", target_os = "macos"))]
pub(crate) fn tensor_bits(t: &Tensor) -> Result<Vec<u32>> {
    Ok(match t.dtype() {
        DType::F32 => t.flatten_all()?.to_vec1::<f32>()?.iter().map(|v| v.to_bits()).collect(),
        _ => t
            .to_dtype(DType::BF16)?
            .flatten_all()?
            .to_vec1::<half::bf16>()?
            .iter()
            .map(|v| v.to_bits() as u32)
            .collect(),
    })
}

/// Differing elements between two lists of bit vectors (a count or
/// length mismatch counts the whole longer side as differing).
#[cfg(all(feature = "metal", target_os = "macos"))]
fn bit_diffs(a: &[Vec<u32>], b: &[Vec<u32>]) -> usize {
    if a.len() != b.len() {
        return a.iter().chain(b).map(|v| v.len()).sum::<usize>().max(1);
    }
    a.iter()
        .zip(b)
        .map(|(x, y)| {
            if x.len() != y.len() {
                x.len().max(y.len()).max(1)
            } else {
                x.iter().zip(y).filter(|(p, q)| p != q).count()
            }
        })
        .sum()
}

#[cfg(all(feature = "metal", target_os = "macos"))]
impl PrefixState {
    /// Host bits of every stored tensor (GDN states, K/V, capture rows).
    pub(crate) fn state_bits(&self) -> Result<Vec<Vec<u32>>> {
        let mut out = Vec::new();
        for (c, r) in self.gdn.iter().flatten() {
            out.push(tensor_bits(c)?);
            out.push(tensor_bits(r)?);
        }
        for (k, v) in self.kv.iter().flatten() {
            out.push(tensor_bits(k)?);
            out.push(tensor_bits(v)?);
        }
        for t in &self.caps {
            out.push(tensor_bits(t)?);
        }
        Ok(out)
    }
}

/// G1a parity state: model-free (tiny random-weight, all-GDN qwen3_5)
/// checks of the double-buffered GDN state machinery on the Metal device —
/// the R0a state-bitwise rollback gate over kept = 1..8 across chained
/// rounds, slot isolation, and light-snapshot restore/staleness rules.
/// Skips when no Metal device exists.
#[cfg(all(test, feature = "metal", target_os = "macos"))]
mod gdn_parity_tests {
    use super::*;

    fn fill(dims: &[usize], seed: u64, scale: f32, dev: &Device) -> Result<Tensor> {
        let n: usize = dims.iter().product();
        let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let v: Vec<f32> = (0..n)
            .map(|_| {
                s ^= s >> 12;
                s ^= s << 25;
                s ^= s >> 27;
                let u = (s.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f32
                    / (1u64 << 53) as f32;
                (u * 2.0 - 1.0) * scale
            })
            .collect();
        Ok(Tensor::from_vec(v, dims, dev)?.to_dtype(DType::BF16)?)
    }

    /// 2 linear-attention layers, hk=1 / hv=3 (REP 3: exercises the
    /// q/k owner writes), dk=dv=128 (the fused kernel's head width), 4-tap
    /// conv, 2 slots.
    fn tiny_gdn(dev: &Device) -> Result<Qwen35> {
        let (hidden, inter, vocab, hk, hv, d) = (64usize, 128usize, 97usize, 1usize, 3usize, 128usize);
        let cfg = Qwen35Config::from_json(&serde_json::json!({
            "hidden_size": hidden, "intermediate_size": inter,
            "num_hidden_layers": 2, "num_attention_heads": 2,
            "num_key_value_heads": 1, "vocab_size": vocab, "head_dim": 256,
            "full_attention_interval": 4, "max_position_embeddings": 4096,
            "linear_num_key_heads": hk, "linear_num_value_heads": hv,
            "linear_key_head_dim": d, "linear_value_head_dim": d,
            "linear_conv_kernel_dim": 4,
        }))?;
        let (key_dim, value_dim) = (hk * d, hv * d);
        let conv_dim = 2 * key_dim + value_dim;
        let ones = |n: usize| Tensor::ones(n, DType::BF16, dev);
        let mut layers = Vec::new();
        for li in 0..2u64 {
            let a_log: Vec<f32> = (0..hv).map(|h| -0.5 + 0.3 * h as f32 + 0.1 * li as f32).collect();
            let dt: Vec<f32> = (0..hv).map(|h| 0.1 * h as f32 - 0.2).collect();
            let (mut a64, mut d64) = ([0f32; 64], [0f32; 64]);
            a64[..hv].copy_from_slice(&a_log);
            d64[..hv].copy_from_slice(&dt);
            layers.push(Layer {
                input_norm: ones(hidden)?,
                kind: Kind::Gdn(GdnLayer {
                    in_all: Lin::Dense(fill(&[conv_dim + value_dim + 2 * hv, hidden], 10 + li, 0.25, dev)?),
                    conv: fill(&[conv_dim, 4], 20 + li, 0.5, dev)?,
                    a_log: Tensor::from_vec(a_log, hv, dev)?,
                    dt_bias: Tensor::from_vec(dt, hv, dev)?,
                    a_log64: a64,
                    dt_bias64: d64,
                    norm_w: ones(d)?,
                    ones_dk: ones(d)?,
                    out: Lin::Dense(fill(&[hidden, value_dim], 30 + li, 0.1, dev)?),
                    key_dim,
                    value_dim,
                    num_k_heads: hk,
                    num_v_heads: hv,
                    head_k: d,
                    head_v: d,
                    conv_k: 4,
                }),
                post_norm: ones(hidden)?,
                mlp: Mlp {
                    gate_up: Lin::Dense(fill(&[2 * inter, hidden], 40 + li, 0.2, dev)?),
                    down: Lin::Dense(fill(&[hidden, inter], 50 + li, 0.15, dev)?),
                    inter,
                },
            });
        }
        let slots = (0..2)
            .map(|_| Slot::new(&cfg, &layers, dev))
            .collect::<Result<Vec<_>>>()?;
        Ok(Qwen35 {
            embed: fill(&[vocab, hidden], 5, 1.0, dev)?,
            layers,
            norm: ones(hidden)?,
            lm_head: Lin::Dense(fill(&[vocab, hidden], 6, 0.3, dev)?),
            cfg,
            device: dev.clone(),
            tq: None,
            slots,
            draft_w: None,
            debug: false,
            gdn_consts: None,
        })
    }

    fn metal() -> Option<Device> {
        Device::new_metal(0).ok()
    }

    fn states_equal(a: &[(Tensor, Tensor)], b: &[(Tensor, Tensor)]) -> Result<bool> {
        for ((ac, ar), (bc, br)) in a.iter().zip(b.iter()) {
            if bits_diff_f32(ar, br)?.0 != 0 {
                return Ok(false);
            }
            let (x, y) = (
                ac.flatten_all()?.to_vec1::<half::bf16>()?,
                bc.flatten_all()?.to_vec1::<half::bf16>()?,
            );
            if bits_diff_bf16(&x, &y)? != 0 {
                return Ok(false);
            }
        }
        Ok(a.len() == b.len())
    }

    /// Every round of a chained decode (verify 8 rows, keep 1..8 — full
    /// accepts interleaved with partial ones, so both parities carry the
    /// committed state over time) leaves exactly the state of a fused scan
    /// of only the kept rows; the slots stay isolated.
    #[test]
    fn gdn_parity_rollback_state_bitwise_over_chained_rounds() -> Result<()> {
        let Some(d) = metal() else {
            eprintln!("[gdn-parity] skipped: needs a Metal device");
            return Ok(());
        };
        let mut m = tiny_gdn(&d)?;
        let prompt: Vec<u32> = (0..11u32).map(|i| (i * 7 + 3) % 97).collect();
        m.forward(0, &prompt, 0)?;
        let mut pos = prompt.len();
        let mut bad = Vec::new();
        for (round, &kept) in [3usize, 8, 1, 5, 8, 8, 2, 7, 4, 6, 8].iter().enumerate() {
            let seq: Vec<u32> = (0..8u32).map(|i| (round as u32 * 13 + i * 5 + 1) % 97).collect();
            for k in 1..=8 {
                let r = m.rollback_state_check(0, pos, &seq, k)?;
                if !r.ok() {
                    bad.push((round, k, r.rec_diff_f, r.conv_diff_f, r.conv_kernel_diff));
                }
            }
            // advance for real: one engine round keeping `kept` rows
            let snap = m.snapshot(0)?;
            m.forward_multi(0, &seq, pos)?;
            if kept < seq.len() {
                m.rollback_verify(0, snap, kept)?;
            }
            pos += kept;
            assert_eq!(m.slots[0].kv_tokens, pos);
        }
        assert!(bad.is_empty(), "state-bitwise mismatches (round, kept, rec, conv, kernel-conv): {bad:?}");
        let (untouched, equal) = m.slot_isolation_check(0, 1, &prompt, &[9, 8, 7, 6, 5, 4, 3, 2], 3)?;
        assert!(untouched, "a round on slot 1 changed slot 0's committed state");
        assert!(equal, "the same round on two identical slots diverged");
        Ok(())
    }

    /// Light snapshots flip back across exactly one forward (the verify's
    /// pre-state is the intact parity) and refuse to restore once a second
    /// forward overwrote it; deep snapshots restore any number of times.
    #[test]
    fn gdn_parity_light_snapshot_restore_rules() -> Result<()> {
        let Some(d) = metal() else {
            eprintln!("[gdn-parity] skipped: needs a Metal device");
            return Ok(());
        };
        let mut m = tiny_gdn(&d)?;
        let prompt: Vec<u32> = (0..9u32).map(|i| (i * 5 + 2) % 97).collect();
        m.forward(0, &prompt, 0)?;
        let pos = prompt.len();
        let pre = m.gdn_state_copy(0)?;
        let deep = m.snapshot_deep(0)?;
        // one forward: restorable, state bitwise back
        let snap = m.snapshot(0)?;
        m.forward_multi(0, &[1, 2, 3, 4], pos)?;
        assert!(!states_equal(&pre, &m.gdn_state_copy(0)?)?, "the forward did not advance the state");
        m.restore(0, snap.clone())?;
        assert!(states_equal(&pre, &m.gdn_state_copy(0)?)?, "light restore did not return the pre-state");
        assert_eq!(m.slots[0].kv_tokens, pos);
        // restoring the same light snapshot again is a no-op
        m.restore(0, snap.clone())?;
        assert!(states_equal(&pre, &m.gdn_state_copy(0)?)?);
        // two forwards: the pre-state parity was overwritten
        m.forward_multi(0, &[1, 2, 3, 4], pos)?;
        m.forward_multi(0, &[5, 6], pos + 4)?;
        assert!(m.restore(0, snap.clone()).is_err(), "stale light snapshot restored");
        assert!(m.rollback_verify(0, snap, 1).is_err(), "stale light snapshot rolled back");
        // deep snapshots survive any number of forwards and restores
        for _ in 0..2 {
            m.restore(0, deep.clone())?;
            assert!(states_equal(&pre, &m.gdn_state_copy(0)?)?, "deep restore mismatch");
            m.forward_multi(0, &[7, 8, 9], pos)?;
        }
        // clear: fresh zero state, old snapshots no longer resident
        let snap2 = m.snapshot(0)?;
        m.clear_kv_cache(0);
        assert!(m.restore(0, snap2).is_err(), "snapshot from before a clear restored");
        for (c, r) in m.gdn_state_copy(0)? {
            assert!(c.flatten_all()?.to_vec1::<half::bf16>()?.iter().all(|v| v.to_bits() == 0));
            assert!(r.flatten_all()?.to_vec1::<f32>()?.iter().all(|v| v.to_bits() == 0));
        }
        Ok(())
    }
}

/// T1 prefix cache: model-free (tiny random-weight hybrid qwen3_5: three
/// GDN layers + one full-attention layer, 2 slots) checks on the Metal
/// device — a restored checkpoint + suffix prefill in the canonical chunk
/// plan is bitwise identical to the uncached prefill (logits, GDN state,
/// K/V rows, and the next verify's logits), checkpoints are never written
/// by the slots that restore them, and slots stay isolated. Skips when no
/// Metal device exists.
#[cfg(all(test, feature = "metal", target_os = "macos"))]
mod prefix_tests {
    use super::*;

    fn fill(dims: &[usize], seed: u64, scale: f32, dev: &Device) -> Result<Tensor> {
        let n: usize = dims.iter().product();
        let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let v: Vec<f32> = (0..n)
            .map(|_| {
                s ^= s >> 12;
                s ^= s << 25;
                s ^= s >> 27;
                let u = (s.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f32
                    / (1u64 << 53) as f32;
                (u * 2.0 - 1.0) * scale
            })
            .collect();
        Ok(Tensor::from_vec(v, dims, dev)?.to_dtype(DType::BF16)?)
    }

    fn tiny_hybrid(dev: &Device) -> Result<Qwen35> {
        let (hidden, inter, vocab, hk, hv, d) = (64usize, 128usize, 97usize, 1usize, 3usize, 128usize);
        let (nh, nkv, hd, maxpos) = (2usize, 1usize, 256usize, 4096usize);
        let cfg = Qwen35Config::from_json(&serde_json::json!({
            "hidden_size": hidden, "intermediate_size": inter,
            "num_hidden_layers": 4, "num_attention_heads": nh,
            "num_key_value_heads": nkv, "vocab_size": vocab, "head_dim": hd,
            "full_attention_interval": 4, "max_position_embeddings": maxpos,
            "linear_num_key_heads": hk, "linear_num_value_heads": hv,
            "linear_key_head_dim": d, "linear_value_head_dim": d,
            "linear_conv_kernel_dim": 4,
            "rope_parameters": {"rope_theta": 10000.0, "partial_rotary_factor": 0.25},
        }))?;
        let (key_dim, value_dim) = (hk * d, hv * d);
        let conv_dim = 2 * key_dim + value_dim;
        let ones = |n: usize| Tensor::ones(n, DType::BF16, dev);
        let mlp = |li: u64| -> Result<Mlp> {
            Ok(Mlp {
                gate_up: Lin::Dense(fill(&[2 * inter, hidden], 40 + li, 0.2, dev)?),
                down: Lin::Dense(fill(&[hidden, inter], 50 + li, 0.15, dev)?),
                inter,
            })
        };
        let mut layers = Vec::new();
        for li in 0..3u64 {
            let a_log: Vec<f32> = (0..hv).map(|h| -0.5 + 0.3 * h as f32 + 0.1 * li as f32).collect();
            let dt: Vec<f32> = (0..hv).map(|h| 0.1 * h as f32 - 0.2).collect();
            let (mut a64, mut d64) = ([0f32; 64], [0f32; 64]);
            a64[..hv].copy_from_slice(&a_log);
            d64[..hv].copy_from_slice(&dt);
            layers.push(Layer {
                input_norm: ones(hidden)?,
                kind: Kind::Gdn(GdnLayer {
                    in_all: Lin::Dense(fill(&[conv_dim + value_dim + 2 * hv, hidden], 10 + li, 0.25, dev)?),
                    conv: fill(&[conv_dim, 4], 20 + li, 0.5, dev)?,
                    a_log: Tensor::from_vec(a_log, hv, dev)?,
                    dt_bias: Tensor::from_vec(dt, hv, dev)?,
                    a_log64: a64,
                    dt_bias64: d64,
                    norm_w: ones(d)?,
                    ones_dk: ones(d)?,
                    out: Lin::Dense(fill(&[hidden, value_dim], 30 + li, 0.1, dev)?),
                    key_dim,
                    value_dim,
                    num_k_heads: hk,
                    num_v_heads: hv,
                    head_k: d,
                    head_v: d,
                    conv_k: 4,
                }),
                post_norm: ones(hidden)?,
                mlp: mlp(li)?,
            });
        }
        let rot_dim = hd / 4;
        let half = rot_dim / 2;
        let inv: Vec<f32> = (0..half)
            .map(|i| 10000f64.powf(-((2 * i) as f64) / rot_dim as f64) as f32)
            .collect();
        let posv: Vec<f32> = (0..maxpos).map(|p| p as f32).collect();
        let freqs = Tensor::from_vec(posv, (maxpos,), dev)?
            .unsqueeze(1)?
            .broadcast_mul(&Tensor::from_vec(inv, (half,), dev)?.unsqueeze(0)?)?;
        let (cos, sin) = (freqs.cos()?, freqs.sin()?);
        layers.push(Layer {
            input_norm: ones(hidden)?,
            kind: Kind::Attn(AttnLayer {
                in_qkv: Lin::Dense(fill(&[nh * 2 * hd + 2 * nkv * hd, hidden], 1, 0.25, dev)?),
                o: Lin::Dense(fill(&[hidden, nh * hd], 2, 0.1, dev)?),
                q_norm: ones(hd)?,
                k_norm: ones(hd)?,
                cos,
                sin,
                n_heads: nh,
                n_kv: nkv,
                head_dim: hd,
                rot_dim,
            }),
            post_norm: ones(hidden)?,
            mlp: mlp(3)?,
        });
        let slots = (0..2)
            .map(|_| Slot::new(&cfg, &layers, dev))
            .collect::<Result<Vec<_>>>()?;
        Ok(Qwen35 {
            embed: fill(&[vocab, hidden], 5, 1.0, dev)?,
            layers,
            norm: ones(hidden)?,
            lm_head: Lin::Dense(fill(&[vocab, hidden], 6, 0.3, dev)?),
            cfg,
            device: dev.clone(),
            tq: None,
            slots,
            draft_w: None,
            debug: false,
            gdn_consts: None,
        })
    }

    fn metal() -> Option<Device> {
        Device::new_metal(0).ok()
    }

    /// Canonical-chunk prefill of `prompt[from..]` (chunks of `step`
    /// anchored at 0), capturing at `ck`. Returns (last logits, capture).
    fn prefill(
        m: &mut Qwen35,
        slot: usize,
        prompt: &[u32],
        from: usize,
        step: usize,
        ck: Option<usize>,
    ) -> Result<(Vec<u32>, Option<PrefixState>)> {
        let (mut pos, mut last, mut cap) = (from, None, None);
        while pos < prompt.len() {
            let end = ((pos / step + 1) * step).min(prompt.len());
            last = Some(m.forward(slot, &prompt[pos..end], pos)?);
            pos = end;
            if Some(pos) == ck {
                cap = Some(m.prefix_capture(slot)?);
            }
        }
        Ok((tensor_bits(&last.context("empty prompt")?)?, cap))
    }

    #[test]
    fn prefix_restore_bitwise_matches_uncached_prefill() -> Result<()> {
        let Some(d) = metal() else {
            eprintln!("[prefix-cache] skipped: needs a Metal device");
            return Ok(());
        };
        let mut m = tiny_hybrid(&d)?;
        let step = 16;
        let prompt: Vec<u32> = (0..53u32).map(|i| (i * 7 + 3) % 97).collect();
        let seq8: Vec<u32> = (0..8u32).map(|i| (i * 11 + 5) % 97).collect();
        let n = prompt.len();

        // uncached reference, checkpoint at 32 on the way
        m.clear_kv_cache(0);
        let (l_ref, cap) = prefill(&mut m, 0, &prompt, 0, step, Some(32))?;
        let cap = cap.context("no capture at 32")?;
        assert_eq!(cap.pos(), 32);
        let ck0 = cap.state_bits()?;
        let s_ref = m.slot_state_bits(0)?;
        let v_ref = tensor_bits(&m.forward_multi(0, &seq8, n)?)?;

        // restored: same logits, same state, same next verify
        m.clear_kv_cache(0);
        m.prefix_restore(0, &cap)?;
        assert_eq!(m.slots[0].kv_tokens, 32);
        let (l_got, _) = prefill(&mut m, 0, &prompt, 32, step, None)?;
        assert!(l_got == l_ref, "suffix-prefill logits differ from the uncached prefill");
        assert!(m.slot_state_bits(0)? == s_ref, "post-prefill state differs from the uncached prefill");
        let v_got = tensor_bits(&m.forward_multi(0, &seq8, n)?)?;
        assert!(v_got == v_ref, "next verify logits differ after a restore");

        // the same checkpoint in slot 1 with a different suffix: slot 0 is
        // untouched, and slot 1 matches its own uncached reference
        let s0 = m.slot_state_bits(0)?;
        let mut other = prompt[..32].to_vec();
        other.extend((0..27u32).map(|i| (i * 3 + 1) % 97));
        m.clear_kv_cache(1);
        m.prefix_restore(1, &cap)?;
        let (l1, _) = prefill(&mut m, 1, &other, 32, step, None)?;
        m.forward_multi(1, &seq8, other.len())?;
        assert!(m.slot_state_bits(0)? == s0, "a restore + prefill on slot 1 changed slot 0");
        m.clear_kv_cache(1);
        let (l1_ref, _) = prefill(&mut m, 1, &other, 0, step, None)?;
        assert!(l1 == l1_ref, "slot 1's restored prefill differs from its uncached prefill");

        // nobody wrote the checkpoint: two restores, prefills and verifies
        // later it is bit-for-bit the captured state
        assert!(cap.state_bits()? == ck0, "a restoring slot wrote into the checkpoint");

        // capacity-buffer capture (after a <= 8-row fused step the K/V
        // live in a grown buffer): the live rows are copied out
        m.clear_kv_cache(0);
        prefill(&mut m, 0, &prompt, 0, step, None)?;
        m.forward_multi(0, &seq8[..4], n)?;
        let cap2 = m.prefix_capture(0)?;
        assert_eq!(cap2.pos(), n + 4);
        for (k, _) in cap2.kv.iter().flatten() {
            assert_eq!(k.dim(1)?, n + 4, "capacity-buffer capture must be exact-size");
        }
        let s2 = m.slot_state_bits(0)?;
        let after = tensor_bits(&m.forward_multi(0, &seq8[4..], n + 4)?)?;
        m.clear_kv_cache(1);
        m.prefix_restore(1, &cap2)?;
        assert!(m.slot_state_bits(1)? == s2, "restored state differs from the captured slot");
        assert!(tensor_bits(&m.forward_multi(1, &seq8[4..], n + 4)?)? == after);
        Ok(())
    }

    /// Do two tensors live in the same device buffer? (candle 0.11's
    /// `same_storage` is private.) Metal buffers compare by identity.
    fn shares_buffer(a: &Tensor, b: &Tensor) -> bool {
        let (ga, _) = a.storage_and_layout();
        let (gb, _) = b.storage_and_layout();
        match (&*ga, &*gb) {
            (candle_core::Storage::Metal(x), candle_core::Storage::Metal(y)) => x.buffer() == y.buffer(),
            _ => false,
        }
    }

    /// Synthetic capture groups (5 per forward chunk, f32, value = absolute
    /// row + 10000·layer, so every row is distinct and exact) ending at
    /// `upto`; `from` = first row.
    fn cap_groups(chunks: &[(usize, usize)], w: usize, dev: &Device) -> Result<Vec<Tensor>> {
        let mut out = Vec::new();
        for &(a, b) in chunks {
            for j in 0..5 {
                let v: Vec<f32> = (a..b)
                    .flat_map(|r| (0..w).map(move |c| (r + 10000 * j) as f32 + c as f32 / 8.0))
                    .collect();
                out.push(Tensor::from_vec(v, (b - a, w), dev)?);
            }
        }
        Ok(out)
    }

    /// Put `slot` at KV position `pos` with synthetic capture groups (the
    /// K/V rows are zeros — only the capture path is under test).
    fn fake_prefilled(m: &mut Qwen35, slot: usize, chunks: &[(usize, usize)], w: usize) -> Result<()> {
        let dev = m.device.clone();
        let pos = chunks.last().map(|c| c.1).unwrap_or(0);
        m.clear_kv_cache(slot);
        let sl = &mut m.slots[slot];
        sl.draft = Some(crate::dflash::Draft::new(&dev)?);
        for kv in sl.kv.iter_mut().flatten() {
            let (nkv, hd) = (kv.0.dim(0)?, kv.0.dim(2)?);
            *kv = (
                Tensor::zeros((nkv, pos, hd), DType::BF16, &dev)?,
                Tensor::zeros((nkv, pos, hd), DType::BF16, &dev)?,
            );
        }
        sl.captures = cap_groups(chunks, w, &dev)?;
        sl.capture_base = 0;
        sl.kv_tokens = pos;
        Ok(())
    }

    /// A checkpoint keeps exactly the capture rows a longer prompt's draft
    /// warm-up can reach — the last WINDOW-1 before it — as one compact
    /// group of fresh buffers, and a restored slot's warm-up input
    /// (checkpoint rows + the suffix's) equals the uncached slot's, row for
    /// row, bit for bit. Covers the trimmed case (checkpoint past WINDOW),
    /// a multi-group short prompt and a single group (which must be copied
    /// out of the live capture buffer, not shared).
    #[test]
    fn prefix_capture_rows_feed_an_identical_draft_warmup() -> Result<()> {
        let Some(d) = metal() else {
            eprintln!("[prefix-cache] skipped: needs a Metal device");
            return Ok(());
        };
        let mut m = tiny_hybrid(&d)?;
        let w = 4usize;
        let win = crate::dflash::WINDOW - 1;
        for (ckpt_chunks, suffix) in [
            // 2600-row checkpoint: rows 553.. kept, 41 rows of the 512 group dropped
            (vec![(0usize, 512usize), (512, 1024), (1024, 1536), (1536, 2048), (2048, 2560), (2560, 2600)], (2600usize, 2650usize)),
            (vec![(0, 512), (512, 600)], (600, 640)),
            (vec![(0, 300)], (300, 305)),
        ] {
            let pos = ckpt_chunks.last().unwrap().1;
            let need_from = pos.saturating_sub(win);
            fake_prefilled(&mut m, 0, &ckpt_chunks, w)?;
            let live = m.slots[0].captures.clone();
            let cap = m.prefix_capture(0)?;
            assert_eq!(cap.pos(), pos);
            assert_eq!((cap.caps_base, cap.caps.len()), (need_from, 5), "checkpoint at {pos}: one group from {need_from}");
            let want = cap_groups(&[(need_from, pos)], w, &d)?;
            for j in 0..5 {
                assert_eq!(cap.caps[j].dims(), &[pos - need_from, w]);
                assert!(tensor_bits(&cap.caps[j])? == tensor_bits(&want[j])?, "checkpoint rows, layer {j}");
                assert!(live.iter().all(|t| !shares_buffer(t, &cap.caps[j])), "checkpoint rows share a live capture buffer");
            }
            let ck0 = cap.state_bits()?;
            // uncached: slot 0 continues with the suffix chunk
            m.slots[0].captures.extend(cap_groups(&[suffix], w, &d)?);
            // cached: slot 1 restores the checkpoint, then the same suffix
            m.clear_kv_cache(1);
            m.slots[1].draft = Some(crate::dflash::Draft::new(&d)?);
            m.prefix_restore(1, &cap)?;
            assert_eq!((m.slots[1].kv_tokens, m.slots[1].capture_base), (pos, need_from));
            m.slots[1].captures.extend(cap_groups(&[suffix], w, &d)?);
            let (r0, s0, k0) = m.draft_warmup_rows(0)?.context("uncached warm-up rows")?;
            let (r1, s1, k1) = m.draft_warmup_rows(1)?.context("restored warm-up rows")?;
            let n = suffix.1;
            assert_eq!((s0, k0), (n - n.min(win), n.min(win)));
            assert_eq!((s1, k1), (s0, k0), "warm-up window differs after a restore");
            assert!(tensor_bits(&r1)? == tensor_bits(&r0)?, "warm-up rows differ after a restore (checkpoint at {pos})");
            assert!(cap.state_bits()? == ck0, "the restored slot's drain touched the checkpoint");
            assert!(m.slots[1].captures.is_empty() && m.slots[1].capture_base == 0);
        }
        Ok(())
    }
}

/// MEM-6 regression: a batch admission's kv_quant mode must never change
/// the attention-cache mode of a slot that is already mid-decode.
/// Tiny 1-layer attention-only qwen3_5 (dense bf16 weights, 2 slots);
/// drives the real `set_kv_quant_slot` / `forward` / `forward_batch`
/// code on the Metal device, where raw-mode steps with seq<=8 take the
/// fused attn_prepare/attn_decode path (needs head_dim 256). Skips when
/// no Metal device exists (candle's CPU backend has no bf16 matmul).
#[cfg(test)]
mod mem6_tests {
    use super::*;

    fn fill(dims: &[usize], seed: u64, scale: f32, dev: &Device) -> Result<Tensor> {
        let n: usize = dims.iter().product();
        let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let v: Vec<f32> = (0..n)
            .map(|_| {
                s ^= s >> 12;
                s ^= s << 25;
                s ^= s >> 27;
                let u = (s.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f32
                    / (1u64 << 53) as f32;
                (u * 2.0 - 1.0) * scale
            })
            .collect();
        Ok(Tensor::from_vec(v, dims, dev)?.to_dtype(DType::BF16)?)
    }

    fn tiny(dev: &Device) -> Result<Qwen35> {
        let (hidden, nh, nkv, hd, inter, vocab, maxpos) =
            (64usize, 2usize, 1usize, 256usize, 128usize, 97usize, 4096usize);
        let cfg = Qwen35Config::from_json(&serde_json::json!({
            "hidden_size": hidden, "intermediate_size": inter,
            "num_hidden_layers": 1, "num_attention_heads": nh,
            "num_key_value_heads": nkv, "vocab_size": vocab, "head_dim": hd,
            "full_attention_interval": 1, "max_position_embeddings": maxpos,
            "rope_parameters": {"rope_theta": 10000.0, "partial_rotary_factor": 0.25},
        }))?;
        let rot_dim = hd / 4;
        let half = rot_dim / 2;
        let inv: Vec<f32> = (0..half)
            .map(|i| 10000f64.powf(-((2 * i) as f64) / rot_dim as f64) as f32)
            .collect();
        let pos: Vec<f32> = (0..maxpos).map(|p| p as f32).collect();
        let freqs = Tensor::from_vec(pos, (maxpos,), dev)?
            .unsqueeze(1)?
            .broadcast_mul(&Tensor::from_vec(inv, (half,), dev)?.unsqueeze(0)?)?;
        let (cos, sin) = (freqs.cos()?, freqs.sin()?);
        let ones = |n: usize| Tensor::ones(n, DType::BF16, dev);
        let qkv_out = nh * 2 * hd + 2 * nkv * hd;
        let layers = vec![Layer {
            input_norm: ones(hidden)?,
            kind: Kind::Attn(AttnLayer {
                in_qkv: Lin::Dense(fill(&[qkv_out, hidden], 1, 0.25, dev)?),
                o: Lin::Dense(fill(&[hidden, nh * hd], 2, 0.1, dev)?),
                q_norm: ones(hd)?,
                k_norm: ones(hd)?,
                cos,
                sin,
                n_heads: nh,
                n_kv: nkv,
                head_dim: hd,
                rot_dim,
            }),
            post_norm: ones(hidden)?,
            mlp: Mlp {
                gate_up: Lin::Dense(fill(&[2 * inter, hidden], 3, 0.2, dev)?),
                down: Lin::Dense(fill(&[hidden, inter], 4, 0.15, dev)?),
                inter,
            },
        }];
        let slots = (0..2)
            .map(|_| Slot::new(&cfg, &layers, dev))
            .collect::<Result<Vec<_>>>()?;
        Ok(Qwen35 {
            embed: fill(&[vocab, hidden], 5, 1.0, dev)?,
            layers,
            norm: ones(hidden)?,
            lm_head: Lin::Dense(fill(&[vocab, hidden], 6, 0.3, dev)?),
            cfg,
            device: dev.clone(),
            tq: None,
            slots,
            draft_w: None,
            debug: false,
            gdn_consts: None,
        })
    }

    fn dev() -> Option<Device> {
        #[cfg(all(feature = "metal", target_os = "macos"))]
        {
            Device::new_metal(0).ok()
        }
        #[cfg(not(all(feature = "metal", target_os = "macos")))]
        {
            None
        }
    }

    /// Slot A (0) prefills 12 tokens and runs one 4-row verify step in
    /// `a_mode`; optionally slot B (1) is then admitted in `b_mode`
    /// (set_kv_quant_slot + prefill) exactly like engine::admit; then A
    /// runs its next 4-row step. Returns (A's step logits, A's kvq len,
    /// A's raw-kv row capacity) after that step.
    fn run(d: &Device, a_mode: bool, b: Option<bool>) -> Result<(Vec<f32>, usize, usize)> {
        let mut m = tiny(d)?;
        let pa: Vec<u32> = (0..12u32).map(|i| (i * 7 + 3) % 97).collect();
        let pb: Vec<u32> = (0..9u32).map(|i| (i * 5 + 1) % 97).collect();
        m.set_kv_quant_slot(a_mode, 0)?;
        m.forward(0, &pa, 0)?;
        m.forward_batch(&[0], &[&[11, 22, 33, 44]], &[12])?;
        if let Some(b_mode) = b {
            m.set_kv_quant_slot(b_mode, 1)?;
            m.forward(1, &pb, 0)?;
        }
        let l = m.forward_batch(&[0], &[&[5, 17, 29, 41]], &[16])?;
        let v = l.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
        let kvq = m.slots[0].kvq[0].len();
        let cap = m.slots[0].kv[0].as_ref().unwrap().0.dim(1)?;
        Ok((v, kvq, cap))
    }

    fn maxd(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
    }

    #[test]
    fn mem6_admission_mode_never_changes_inflight_slot() -> Result<()> {
        let Some(d) = dev() else {
            eprintln!("[mem6-unit] skipped: needs a Metal device");
            return Ok(());
        };
        let mut bad = Vec::new();
        for a_mode in [false, true] {
            let (reference, rq, rc) = run(&d, a_mode, None)?;
            let refmax = reference.iter().fold(0.0f32, |m, x| m.max(x.abs()));
            for b_mode in [a_mode, !a_mode] {
                let (got, q, c) = run(&d, a_mode, Some(b_mode))?;
                let dd = maxd(&reference, &got);
                eprintln!(
                    "[mem6-unit] dev={:?} A.kv_quant={a_mode} B.kv_quant={b_mode}: \
                     A step-logits max|Δ| vs solo = {dd:.6} (max|ref|={refmax:.4}); \
                     A kvq_len solo/with-B = {rq}/{q}; A raw-kv cap solo/with-B = {rc}/{c}",
                    d.location()
                );
                if dd > 1e-6 {
                    bad.push((a_mode, b_mode, dd));
                }
            }
        }
        assert!(bad.is_empty(), "in-flight slot A corrupted by B's admission: {bad:?}");
        Ok(())
    }
}

/// T1b: the GQA-grouped eager attention (`attn_eager(grouped)`) is
/// bitwise equal to the broadcast form it replaces, over the prefill chunk
/// shapes that reach it (seq 9..513 rows, tiny to long contexts, both GEMM
/// tile regimes) at Qwen3.8's head layout (24 q heads, 4 KV heads, d 256)
/// and another GQA ratio. Skips when no Metal device exists.
#[cfg(all(test, feature = "metal", target_os = "macos"))]
mod gqa_tests {
    use super::*;

    fn fill(dims: &[usize], seed: u64, scale: f32, dev: &Device) -> Result<Tensor> {
        let n: usize = dims.iter().product();
        let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let v: Vec<f32> = (0..n)
            .map(|_| {
                s ^= s >> 12;
                s ^= s << 25;
                s ^= s >> 27;
                let u = (s.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f32
                    / (1u64 << 53) as f32;
                (u * 2.0 - 1.0) * scale
            })
            .collect();
        Ok(Tensor::from_vec(v, dims, dev)?.to_dtype(DType::BF16)?)
    }

    #[test]
    fn grouped_attention_is_bitwise_equal_to_broadcast() -> Result<()> {
        let Ok(dev) = Device::new_metal(0) else {
            return Ok(());
        };
        let mut seed = 1u64;
        for &(nh, nkv, d) in &[(24usize, 4usize, 256usize), (8, 2, 64)] {
            for &(seq, pos) in &[
                (2usize, 0usize),
                (9, 0),
                (12, 100),
                (24, 1408),
                (46, 1408),
                (126, 700),
                (200, 0),
                (384, 1024),
                (513, 511),
            ] {
                let kv = pos + seq;
                seed += 3;
                let q = fill(&[1, nh, seq, d], seed, 1.0, &dev)?;
                // head-major contiguous K/V, and the layout attn_forward's
                // cache cat produces (V time-major: a transposed [kv, n_kv, d])
                let k = fill(&[nkv, kv, d], seed + 1, 1.0, &dev)?;
                let v = fill(&[nkv, kv, d], seed + 2, 1.0, &dev)?;
                let v_tm = v.transpose(0, 1)?.contiguous()?.transpose(0, 1)?;
                assert!(!v_tm.is_contiguous() || kv == 1 || nkv == 1);
                for (layout, vv) in [("contiguous", &v), ("time-major V", &v_tm)] {
                    let b = Qwen35::attn_eager(&q, &k, vv, pos, seq, nh, nkv, d, false, &dev)?;
                    let g = Qwen35::attn_eager(&q, &k, vv, pos, seq, nh, nkv, d, true, &dev)?;
                    assert_eq!(b.dims(), &[seq, nh * d]);
                    assert_eq!(g.dims(), b.dims());
                    let (bb, gb) = (tensor_bits(&b)?, tensor_bits(&g)?);
                    let diff = bb.iter().zip(&gb).filter(|(x, y)| x != y).count();
                    assert_eq!(diff, 0, "heads {nh}/{nkv} d {d} seq {seq} pos {pos} {layout}: {diff} elements differ");
                }
            }
        }
        Ok(())
    }
}

/// T1b layout regression (CPU, f32 — runs without a GPU): `attn_forward`
/// builds K/V with `Tensor::cat(&[cache, new], 1)`; for V the new rows are
/// a transposed view, so the cat returns a time-major [n_kv, kv, d] view
/// (strides [d, n_kv*d, 1]) — also from an empty cache at pos 0. The
/// grouped path must accept that layout (it did not: "Invalid matmul
/// arguments" on the first real prefill) and agree with the broadcast
/// form.
#[cfg(test)]
mod gqa_layout_tests {
    use super::*;

    fn fill(dims: &[usize], seed: u64) -> Result<Tensor> {
        let n: usize = dims.iter().product();
        let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let v: Vec<f32> = (0..n)
            .map(|_| {
                s ^= s >> 12;
                s ^= s << 25;
                s ^= s >> 27;
                ((s.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f32 / (1u64 << 53) as f32) * 2.0 - 1.0
            })
            .collect();
        Ok(Tensor::from_vec(v, dims, &Device::Cpu)?)
    }

    #[test]
    fn grouped_attention_accepts_the_cache_layouts() -> Result<()> {
        let dev = Device::Cpu;
        let (nh, nkv, d) = (8usize, 2usize, 32usize);
        for &(pos, seq) in &[(0usize, 9usize), (0, 18), (40, 12), (100, 30)] {
            let kv = pos + seq;
            let q = fill(&[1, nh, seq, d], 1 + pos as u64)?;
            // as attn_forward: the cache (empty at pos 0) + the new rows, V new rows transposed
            let k_cache = if pos == 0 { Tensor::zeros((nkv, 0, d), DType::F32, &dev)? } else { fill(&[nkv, pos, d], 2)? };
            let v_cache = if pos == 0 { Tensor::zeros((nkv, 0, d), DType::F32, &dev)? } else { fill(&[pos, nkv, d], 3)?.transpose(0, 1)? };
            let k_new = fill(&[nkv, seq, d], 4)?;
            let v_new = fill(&[seq, nkv, d], 5)?.transpose(0, 1)?; // [nkv, seq, d] view
            let k_all = Tensor::cat(&[k_cache, k_new], 1)?;
            let v_all = Tensor::cat(&[v_cache, v_new], 1)?;
            assert_eq!(v_all.dims(), &[nkv, kv, d]);
            let b = Qwen35::attn_eager(&q, &k_all, &v_all, pos, seq, nh, nkv, d, false, &dev)?;
            let g = Qwen35::attn_eager(&q, &k_all, &v_all, pos, seq, nh, nkv, d, true, &dev)?;
            assert_eq!(g.dims(), &[seq, nh * d]);
            let diff = (b - g)?.abs()?.flatten_all()?.max(0)?.to_scalar::<f32>()?;
            assert!(diff < 1e-5, "pos {pos} seq {seq} (v contiguous: {}): max|broadcast - grouped| = {diff}", v_all.is_contiguous());
        }
        Ok(())
    }
}

#[cfg(test)]
mod causal_mask_tests {
    use super::*;

    /// The shared eager-attention mask: 0 on and below the causal
    /// diagonal (key j <= pos + row), -inf above; cached per key and
    /// dtype (a second dtype does not evict the first; a new key for the
    /// same dtype replaces it and still builds the right values).
    #[test]
    fn causal_mask_values_and_cache() -> Result<()> {
        let dev = Device::Cpu;
        let want = |seq: usize, pos: usize, kv: usize| -> Vec<f32> {
            (0..seq * kv)
                .map(|i| if i % kv <= pos + i / kv { 0.0 } else { f32::NEG_INFINITY })
                .collect()
        };
        let get = |seq, pos, kv, dt| -> Result<Vec<f32>> {
            Ok(causal_mask(seq, pos, kv, dt, &dev)?
                .to_dtype(DType::F32)?
                .flatten_all()?
                .to_vec1::<f32>()?)
        };
        for (seq, pos, kv) in [(3usize, 2usize, 5usize), (9, 0, 9), (4, 7, 11), (3, 2, 5)] {
            assert_eq!(get(seq, pos, kv, DType::BF16)?, want(seq, pos, kv), "bf16 {seq} {pos} {kv}");
            assert_eq!(get(seq, pos, kv, DType::F32)?, want(seq, pos, kv), "f32 {seq} {pos} {kv}");
        }
        // same key twice: the cached tensor (same storage) comes back
        let a = causal_mask(5, 3, 8, DType::BF16, &dev)?;
        let b = causal_mask(5, 3, 8, DType::BF16, &dev)?;
        let (sa, sb) = (a.storage_and_layout().0, b.storage_and_layout().0);
        assert!(std::ptr::eq(&*sa, &*sb), "second call must reuse the cached mask");
        Ok(())
    }
}

#[cfg(test)]
mod qlin_shape_tests {
    use super::*;

    /// QLin::linear must reject an input whose last dim is not the
    /// weight's `inp`: the Metal kernels size their reads from `inp`, so
    /// a mismatch was a silent over-read (the fused draft attention fed
    /// o_proj [1,8,32,128] = 256 rows x 128 against inp 4096).
    #[test]
    fn qlin_linear_rejects_in_dim_mismatch() {
        let dev = Device::Cpu;
        let (out, inp) = (64usize, 4096usize);
        let q = QLin::new(
            Tensor::zeros((out, inp / 8), DType::U32, &dev).unwrap(),
            Tensor::zeros((out, 2 * inp / 64), DType::BF16, &dev).unwrap(),
            out,
            inp,
            64,
        );
        let bad = Tensor::zeros((1, 8, 32, 128), DType::BF16, &dev).unwrap();
        let err = q.linear(&bad).unwrap_err().to_string();
        assert!(err.contains("x last dim 128 != weight inp 4096"), "{err}");
        // (a matching-shape CPU call is not exercised here: the CPU
        // fallback `cpu_dequant` indexes the scale half with the full
        // row stride and panics for out >= 2 — separate, pre-existing.)
    }
}

/// K7: the m = 1 tiled matvec (`AffineQmvT`) against the scalar
/// `AffineQmm` reference on random packed weights — every instantiated
/// config, ragged row counts (partial threadgroups), K-slices that come
/// out empty (ng < simdgroups), the fused gate/up epilogue with an up
/// stream that is and is not tile-aligned, and the `QLin` routing.
#[cfg(all(test, feature = "metal", target_os = "macos"))]
mod qmvt_tests {
    use super::QLin;
    use crate::quant_kernel::{AffineQmm, AffineQmvT, QmvtCfg};
    use candle_core::{DType, Device, Tensor};

    fn lcg(seed: &mut u64) -> u64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *seed >> 33
    }

    /// random `[out, in]` MLX-affine weight (row-major), tiled like the
    /// model's projections
    fn rand_qlin(dev: &Device, out: usize, inp: usize, seed: u64) -> QLin {
        let mut s = seed;
        let ng = inp / 64;
        let words: Vec<u32> = (0..out * inp / 8)
            .map(|_| (lcg(&mut s) as u32) ^ ((lcg(&mut s) as u32) << 16))
            .collect();
        let mut sbv = vec![half::bf16::ZERO; out * 2 * ng];
        for o in 0..out {
            for g in 0..ng {
                let sc = 0.002 + (lcg(&mut s) % 1000) as f32 * 2e-5;
                let bi = ((lcg(&mut s) % 2001) as f32 - 1000.0) * 1e-4;
                sbv[o * 2 * ng + g] = half::bf16::from_f32(sc);
                sbv[o * 2 * ng + ng + g] = half::bf16::from_f32(bi);
            }
        }
        let wq = Tensor::from_vec(words, (out, inp / 8), dev).unwrap();
        let sb = Tensor::from_vec(sbv, (out, 2 * ng), dev).unwrap();
        QLin::new(wq, sb, out, inp, 64).tiled().unwrap()
    }

    fn rand_x(dev: &Device, inp: usize, seed: u64) -> Tensor {
        let mut s = seed;
        let v: Vec<f32> = (0..inp)
            .map(|_| ((lcg(&mut s) % 4001) as f32 - 2000.0) / 1000.0)
            .collect();
        Tensor::from_vec(v, (inp,), dev).unwrap().to_dtype(DType::BF16).unwrap()
    }

    fn scalar_ref(q: &QLin, x: &Tensor) -> Vec<f32> {
        let op = AffineQmm { inp: q.inp, out: q.out, gs: 64, m: 1, tiled: q.tiled };
        q.wq.apply_op3_no_bwd(&q.sb, &x.reshape((1, q.inp)).unwrap(), &op)
            .unwrap()
            .flatten_all()
            .unwrap()
            .to_dtype(DType::F32)
            .unwrap()
            .to_vec1()
            .unwrap()
    }

    fn to_f32(t: &Tensor) -> Vec<f32> {
        t.flatten_all().unwrap().to_dtype(DType::F32).unwrap().to_vec1().unwrap()
    }

    /// bf16 outputs from two f32 accumulation orders: at most one bf16
    /// rounding step apart (2^-7 relative, floored for near-zero rows)
    fn assert_close(tag: &str, got: &[f32], want: &[f32]) {
        assert_eq!(got.len(), want.len(), "{tag}: len");
        let mag = want.iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(mag > 0.0, "{tag}: degenerate reference");
        let mut worst = 0f32;
        for (i, (a, b)) in got.iter().zip(want).enumerate() {
            let tol = 2f32.powi(-7) * b.abs().max(0.02 * mag);
            let d = (a - b).abs();
            assert!(d <= tol, "{tag}: row {i}: got {a} want {b} (|Δ| {d} > {tol})");
            worst = worst.max(d / mag);
        }
        eprintln!("{tag}: max|Δ|/max|ref| = {worst:.2e}");
    }

    const PLAIN: [QmvtCfg; 6] = crate::quant_kernel::QMVT_KERNELS;
    const GATE_UP: [QmvtCfg; 6] = crate::quant_kernel::QMVT_KERNELS;

    #[test]
    fn qmvt_plain_matches_scalar() {
        let Ok(dev) = Device::new_metal(0) else { return };
        // (out, ng): ragged rows, ng < 8 (empty K-slices), uneven slices
        for (case, &(out, ng)) in [(520usize, 7usize), (256, 80), (1000, 17), (72, 96)].iter().enumerate() {
            let inp = ng * 64;
            let q = rand_qlin(&dev, out, inp, 11 + case as u64);
            let x = rand_x(&dev, inp, 97 + case as u64);
            let want = scalar_ref(&q, &x);
            for cfg in PLAIN {
                let op = AffineQmvT { inp, out, tiles: out.div_ceil(256), up_row: 0, cfg };
                let y = q.wq.apply_op3_no_bwd(&q.sb, &x, &op).unwrap();
                assert_eq!(y.dims(), &[out]);
                let got = to_f32(&y);
                assert_close(&format!("plain {out}x{inp} {cfg:?}"), &got, &want);
                // deterministic: fixed reduction order
                let again = to_f32(&q.wq.apply_op3_no_bwd(&q.sb, &x, &op).unwrap());
                assert_eq!(got, again, "plain {out}x{inp} {cfg:?}: not deterministic");
            }
            // QLin routing at rows == 1 == the configured kernel
            let cfg = crate::quant_kernel::qmvt_cfg(out, inp, false);
            let op = AffineQmvT { inp, out, tiles: out.div_ceil(256), up_row: 0, cfg };
            let direct = to_f32(&q.wq.apply_op3_no_bwd(&q.sb, &x, &op).unwrap());
            let routed = q.linear(&x.reshape((1, 1, inp)).unwrap()).unwrap();
            assert_eq!(routed.dims(), &[1, 1, out]);
            assert_eq!(to_f32(&routed), direct, "QLin::linear m=1 routing");
        }
    }

    #[test]
    fn qmvt_gate_up_matches_scalar() {
        let Ok(dev) = Device::new_metal(0) else { return };
        // half % 256 == 0 (tile-aligned up stream) and not; ragged rows
        for (case, &(half, ng)) in [(256usize, 7usize), (264, 80), (512, 17), (1000, 6)].iter().enumerate() {
            let inp = ng * 64;
            let out = 2 * half;
            let q = rand_qlin(&dev, out, inp, 211 + case as u64);
            let x = rand_x(&dev, inp, 307 + case as u64);
            let y = scalar_ref(&q, &x);
            // the MPP gate/up epilogue form on bf16-rounded gate/up
            let want: Vec<f32> = (0..half)
                .map(|i| {
                    let (g, u) = (y[i], y[half + i]);
                    half::bf16::from_f32(g / (1.0 + (-g).exp()) * u).to_f32()
                })
                .collect();
            for cfg in GATE_UP {
                let op = AffineQmvT { inp, out: half, tiles: out.div_ceil(256), up_row: half, cfg };
                let yq = q.wq.apply_op3_no_bwd(&q.sb, &x, &op).unwrap();
                assert_eq!(yq.dims(), &[half]);
                let got = to_f32(&yq);
                assert_close(&format!("gate_up {half}x{inp} {cfg:?}"), &got, &want);
                let again = to_f32(&q.wq.apply_op3_no_bwd(&q.sb, &x, &op).unwrap());
                assert_eq!(got, again, "gate_up {half}x{inp} {cfg:?}: not deterministic");
            }
            // gate_up_act at m = 1 now takes the fused kernel
            let cfg = crate::quant_kernel::qmvt_cfg(half, inp, true);
            let op = AffineQmvT { inp, out: half, tiles: out.div_ceil(256), up_row: half, cfg };
            let direct = to_f32(&q.wq.apply_op3_no_bwd(&q.sb, &x, &op).unwrap());
            let fused = q
                .gate_up_act(&x.reshape((1, 1, inp)).unwrap())
                .expect("gate_up_act declined m=1")
                .unwrap();
            assert_eq!(fused.dims(), &[1, 1, half]);
            assert_eq!(to_f32(&fused), direct, "gate_up_act m=1 routing");
        }
    }

    #[test]
    fn qmvt_rejects_misaligned_input() {
        let Ok(dev) = Device::new_metal(0) else { return };
        // K % 1024 == 0: the fallback's split-K MPP tile needs it
        let (out, inp) = (256usize, 1024usize);
        let q = rand_qlin(&dev, out, inp, 5);
        let x = rand_x(&dev, inp + 1, 6).narrow(0, 1, inp).unwrap();
        let op = AffineQmvT { inp, out, tiles: 1, up_row: 0, cfg: QmvtCfg::R4S8 };
        assert!(q.wq.apply_op3_no_bwd(&q.sb, &x, &op).is_err());
        // QLin falls back to the MPP route (its pad kernel reads x as
        // scalars) instead of failing. The reference needs a fresh
        // offset-0 tensor: `copy()` keeps the layout offset and the
        // scalar qmm reads x as uint4 vectors.
        let xa = Tensor::from_vec(x.to_vec1::<half::bf16>().unwrap(), (inp,), &dev).unwrap();
        let want = scalar_ref(&q, &xa);
        let y = q.linear(&x.reshape((1, 1, inp)).unwrap()).unwrap();
        assert_close("misaligned fallback", &to_f32(&y), &want);
    }
}
