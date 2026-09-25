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

    fn linear(&self, x: &Tensor) -> Result<Tensor> {
        let dims = x.dims().to_vec();
        let in_d = *dims.last().unwrap();
        let rows: usize = dims[..dims.len() - 1].iter().product();
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if x.device().is_metal() && in_d % 32 == 0 {
            if rows == 1 {
                // fused dequant-matvec — reads packed weights only
                let xv = x.reshape((in_d,))?.contiguous()?;
                if self.tiled && std::env::var("TH_QMM_SCALAR").is_err() {
                    let xv8 = xv.reshape((1, in_d))?;
                    let y8 = self.wq.apply_op3_no_bwd(
                        &self.sb,
                        &xv8,
                        &crate::quant_kernel::AffineQmpp {
                            inp: self.inp,
                            out: self.out,
                            padded: self.out.div_ceil(256) * 256,
                            m: 1,
                            up_tile: 0,
                            sgs: 2,
                            tile: 64,
                        },
                    )?;
                    let y = y8.narrow(0, 0, 1)?.contiguous()?;
                    let mut out = dims;
                    *out.last_mut().unwrap() = self.out;
                    return Ok(y.reshape(out)?);
                }
                let y = if std::env::var("TH_QMV_SG").is_ok()
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
                // cooperative-tensor (MPP) path on tiled weights — the
                // fastest measured variant (n64 split4), env-gated A/B
                if self.tiled && std::env::var("TH_QMM_SCALAR").is_err() {
                    let y8 = self.wq.apply_op3_no_bwd(
                        &self.sb,
                        &xv,
                        &crate::quant_kernel::AffineQmpp {
                            inp: self.inp,
                            out: self.out,
                            padded: self.out.div_ceil(256) * 256,
                            m: rows,
                            up_tile: 0,
                            sgs: 2,
                            tile: 64,
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
                    && std::env::var("TH_QMM_SCALAR").is_err()
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
            // prefill: cooperative-tensor kernel on tiled weights
            if self.tiled && std::env::var("TH_QMM_SCALAR").is_err() {
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
    pub(crate) fn gate_up_act(&self, x: &Tensor) -> Option<Result<Tensor>> {
        let dims = x.dims().to_vec();
        let rows: usize = dims[..dims.len() - 1].iter().product();
        let in_d0 = *dims.last().unwrap();
        // prefill path: two-pass gate→scratch + up·silu(gate)
        if rows > 8
            && self.tiled
            && self.out % 2 == 0
            && (self.out / 2) % 256 == 0
            && std::env::var("TH_QMM_SCALAR").is_err()
        {
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if x.device().is_metal() {
                let xv = x.reshape((rows, in_d0)).ok()?.contiguous().ok()?;
                let half = self.out / 2;
                let padded = self.out.div_ceil(256) * 256;
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
                            Ok(yp
                                .narrow(0, 0, rows)?
                                .narrow(1, 0, half)?
                                .contiguous()?
                                .reshape(out)?)
                        }),
                );
            }
        }
        // m==1 wastes 7/8 of the MMA work — the qmv path wins there
        if !(2..=8).contains(&rows) || self.out % 2 != 0 {
            return None;
        }
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if x.device().is_metal()
            && self.gs == 64
            && self.inp % 64 == 0
            && std::env::var("TH_QMM_SCALAR").is_err()
        {
            let in_d = *dims.last().unwrap();
            let half = self.out / 2;
            if self.tiled && half % 256 == 0 {
                let xv = x.reshape((rows, in_d)).ok()?.contiguous().ok()?;
                let padded = self.out.div_ceil(256) * 256;
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
                                sgs: 2,
                                tile: 64,
                            },
                        )
                        .map_err(Into::into)
                        .and_then(|y8| {
                            let mut out = dims.clone();
                            *out.last_mut().unwrap() = half;
                            Ok(y8
                                .narrow(0, 0, rows)?
                                .contiguous()?
                                .reshape(out)?)
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
                y.reshape(out).map_err(Into::into)
            })());
        }
        None
    }
}

/// Tile a packed weight for the MPP path — the cooperative-tensor
/// kernels need the [tile][group][col] layout. Default on for Metal;
/// `TH_QMM_MPP=0` keeps the row-major layout + scalar/sg kernels.
pub(crate) fn maybe_tiled(l: Lin) -> Result<Lin> {
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
    match l {
        Lin::Dense(w) => linear(x, w),
        Lin::Quant(q) => q.linear(x),
    }
}

/// Row-concatenate projection weights so one matmul produces all their
/// outputs — the caller narrows the fused result back into the parts.
/// All inputs must share `inp`/`gs` and quantisation kind. Bitwise
/// identical to separate projections (each output row is independent).
fn fuse_lins(lins: &[Lin]) -> Result<Lin> {
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

/// x / sqrt(mean(x²) + eps) * w — fused Metal kernel, f32 accumulation
/// inside the shader (weights already carry the +1 offset from conversion).
pub(crate) fn rms_norm(x: &Tensor, w: &Tensor, eps: f64) -> Result<Tensor> {
    candle_nn::ops::rms_norm(x, w, eps as f32).map_err(Into::into)
}

/// Fused `x + r` residual + `rms_norm(x+r)·w` on Metal — one dispatch
/// producing both streams. Falls back to eager ops elsewhere.
fn add_rms_norm(
    x: &Tensor,
    r: &Tensor,
    w: &Tensor,
    eps: f64,
) -> Result<(Tensor, Tensor)> {
    #[cfg(all(feature = "metal", target_os = "macos"))]
    if x.device().is_metal() && x.is_contiguous() && r.is_contiguous() {
        let seq = x.dim(1)?;
        let c = x.dim(2)?;
        let out = x.apply_op3_no_bwd(
            r,
            w,
            &crate::gdn_kernel::AddRmsNorm { t: seq, c, eps: eps as f32 },
        )?;
        // out is [2, T, C] — plane 0 = residual, plane 1 = normed
        let res = out.narrow(0, 0, 1)?;
        let nrm = out.narrow(0, 1, 1)?;
        return Ok((res, nrm));
    }
    let res = x.add(r)?;
    let nrm = rms_norm(&res, w, eps)?;
    Ok((res, nrm))
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

struct GdnState {
    conv: Tensor,      // [k-1, conv_dim] bf16 rolling inputs
    recurrent: Tensor, // [Hv, Dv, Dk] f32
}

/// Per-GDN-layer intermediates stashed during a spec-decode verify pass
/// so a partial accept can roll forward only the committed rows instead
/// of re-running the whole model (`rollback_verify`).
#[derive(Default)]
struct GdnVerifyCache {
    /// Raw in_proj_qkv output [seq, conv_dim] — the depthwise-conv input;
    /// needed to rebuild the (k-1)-row conv window.
    qkv: Option<Tensor>,
    /// Normed scan inputs packed [seq, 2*Hk+Hv, Dk] — rescan source.
    pack: Option<Tensor>,
    /// [seq, 2*Hv] f32 — gate/beta projections.
    ab: Option<Tensor>,
}

/// Pre-verify state for speculative decode rollback. Conv views and KV
/// tensors are never mutated in place (cat/narrow allocate new buffers),
/// so clones are cheap; the fused kernel does update `recurrent` in
/// place, so the live tensor is swapped for a fresh copy and the
/// snapshot keeps the original.
#[derive(Clone)]
pub struct Snapshot {
    gdn: Vec<Option<(Tensor, Tensor)>>,
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
    gdn: Vec<Option<GdnState>>,
    kv: Vec<Option<(Tensor, Tensor)>>, // [n_kv, seq, head_dim] bf16
    /// TurboQuant-compressed KV (full-attention layers only) — used
    /// instead of `kv` when `tq` is set.
    kvq: Vec<crate::turboquant::QuantKv>,
    tq: Option<crate::turboquant::TurboQuant>,
    /// DFlash draft — when set, `forward`/`forward_multi` capture
    /// hidden states at the DFlash capture layers for the draft ring.
    draft: Option<crate::dflash::Draft>,
    /// Captured post-layer hiddens for the capture layers, in
    /// (call, layer) order — each entry [seq, 5120].
    captures: Vec<Tensor>,
    /// Per-layer verify intermediates (GDN layers only) from the most
    /// recent multi-row forward — consumed by `rollback_verify`.
    vcache: Vec<GdnVerifyCache>,
    pub kv_tokens: usize,
    debug: bool,
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
        let mut gdn = Vec::with_capacity(cfg.num_hidden_layers);
        let mut kv = Vec::with_capacity(cfg.num_hidden_layers);
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
                let conv_dim = 2 * cfg.linear_num_key_heads
                    * cfg.linear_key_head_dim
                    + cfg.linear_num_value_heads * cfg.linear_value_head_dim;
                gdn.push(Some(GdnState {
                    conv: Tensor::zeros(
                        (cfg.linear_conv_kernel_dim - 1, conv_dim),
                        DType::BF16,
                        device,
                    )?,
                    recurrent: Tensor::zeros(
                        (
                            cfg.linear_num_value_heads,
                            cfg.linear_value_head_dim,
                            cfg.linear_key_head_dim,
                        ),
                        DType::F32,
                        device,
                    )?,
                }));
                kv.push(None);
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
        }
        Ok(Self {
            embed,
            layers,
            norm,
            lm_head,
            cfg: cfg.clone(),
            device: device.clone(),
            gdn,
            kv,
            kvq: vec![crate::turboquant::QuantKv::default(); cfg.num_hidden_layers],
            tq: None,
            draft: None,
            captures: Vec::new(),
            vcache: (0..cfg.num_hidden_layers)
                .map(|_| GdnVerifyCache::default())
                .collect(),
            kv_tokens: 0,
            debug: std::env::var("TH_DEBUG_LAYERS").is_ok(),
        })
    }

    /// Enable TurboQuant-compressed KV caches on the full-attention
    /// layers. Called post-load when EngineConfig.kv_quant is set.
    pub fn enable_kv_quant(&mut self) -> Result<()> {
        if self.tq.is_none() {
            self.tq = Some(crate::turboquant::TurboQuant::new(
                self.cfg.head_dim,
                &self.device,
            )?);
        }
        Ok(())
    }

    /// Runtime toggle — only safe between requests (the generation loop
    /// clears caches at request start anyway).
    pub fn set_kv_quant(&mut self, on: bool) -> Result<()> {
        if on {
            self.enable_kv_quant()?;
        } else {
            self.tq = None;
        }
        self.clear_kv_cache();
        Ok(())
    }


    /// Snapshot all mutable state for speculative-verify rollback.
    pub fn snapshot(&mut self) -> Result<Snapshot> {
        let mut gdn = Vec::with_capacity(self.gdn.len());
        for st in self.gdn.iter_mut() {
            match st {
                Some(s) => {
                    // real device copy — the kernel writes in place
                    let copy = s.recurrent.affine(1.0, 0.0)?;
                    let orig = std::mem::replace(&mut s.recurrent, copy);
                    gdn.push(Some((s.conv.clone(), orig)));
                }
                None => gdn.push(None),
            }
        }
        Ok(Snapshot {
            gdn,
            kv: self.kv.clone(),
            kvq: self.kvq.clone(),
            kv_tokens: self.kv_tokens,
        })
    }

    /// Restore a snapshot taken by `snapshot()`. The snapshot's
    /// recurrent buffers are copied rather than adopted so a snapshot
    /// stays immutable and may be restored (or cloned) more than once.
    pub fn restore(&mut self, snap: Snapshot) -> Result<()> {
        for (st, s) in self.gdn.iter_mut().zip(snap.gdn) {
            if let (Some(st), Some((conv, rec))) = (st, s) {
                st.conv = conv;
                st.recurrent = rec.affine(1.0, 0.0)?;
            }
        }
        self.kv = snap.kv;
        self.kvq = snap.kvq;
        self.kv_tokens = snap.kv_tokens;
        Ok(())
    }

    /// Roll back a verify pass keeping only the first `kept` input rows
    /// committed: restores the pre-verify snapshot, then re-applies the
    /// committed rows from the cached scan inputs and truncates the
    /// attention KV — avoiding a full model re-forward per round.
    pub fn rollback_verify(&mut self, snap: Snapshot, kept: usize) -> Result<()> {
        let new_len = snap.kv_tokens + kept;
        for (i, sg) in snap.gdn.into_iter().enumerate() {
            let Some((conv, rec)) = sg else { continue };
            let Some(st) = self.gdn[i].as_mut() else { continue };
            let vc = self.vcache[i].qkv.take().zip(
                self.vcache[i]
                    .pack
                    .take()
                    .zip(self.vcache[i].ab.take()),
            );
            let Kind::Gdn(l) = &self.layers[i].kind else { continue };
            match vc {
                Some((qkv, (pack, ab))) => {
                    // conv window = last (k-1) rows of
                    // [pre-verify window | kept raw qkv rows]
                    let kept_qkv = qkv.narrow(0, 0, kept)?;
                    st.conv = Tensor::cat(&[&conv, &kept_qkv], 0)?
                        .narrow(0, kept, l.conv_k - 1)?
                        .contiguous()?;
                    // rescan the kept rows from the pre-verify state —
                    // the fused kernel updates `recurrent` in place, so
                    // copy the snapshot buffer first (snapshots must
                    // stay immutable for reuse)
                    st.recurrent = rec.affine(1.0, 0.0)?;
                    let pack = pack.narrow(0, 0, kept)?;
                    if std::env::var("TH_DEBUG_ROLLBACK").is_ok() {
                        {
                            let (st, _) = pack.storage_and_layout();
                            if let candle_core::Storage::Metal(st) = &*st
                            {
                                eprintln!(
                                    "  [rb-dbg] layer {i} pack_buf={:p}",
                                    st.buffer().as_ref()
                                );
                            }
                        }
                        // dump raw values: stashed pack v-region row0,
                        // stashed qkv row0, snapshot conv row0
                        let pv = pack
                            .to_dtype(DType::F32)?
                            .flatten_all()?
                            .to_vec1::<f32>()?;
                        let qv = qkv
                            .narrow(0, 0, 1)?
                            .to_dtype(DType::F32)?
                            .flatten_all()?
                            .to_vec1::<f32>()?;
                        let cv = conv
                            .narrow(0, 0, 1)?
                            .to_dtype(DType::F32)?
                            .flatten_all()?
                            .to_vec1::<f32>()?;
                        eprintln!(
                            "  [rb-dbg] layer {i} kept={kept} pack[v0]={:.3} {:.3} {:.3} qkv0={:.3} {:.3} {:.3} conv0={:.3} {:.3} {:.3}",
                            pv[2 * l.key_dim],
                            pv[2 * l.key_dim + 1],
                            pv[2 * l.key_dim + 2],
                            qv[0], qv[1], qv[2],
                            cv[0], cv[1], cv[2],
                        );
                    }
                    // ab stashed as the strided [1, seq, 96] projection
                    // view — squeeze to [seq, 96] then take kept rows
                    let ab = ab.squeeze(0)?.narrow(0, 0, kept)?;
                    let _ = Self::gdn_scan(
                        l, st, &mut None, &pack, &ab, kept,
                        &self.device,
                    )?;
                }
                _ => {
                    // no cached intermediates — plain restore
                    st.conv = conv;
                    st.recurrent = rec.affine(1.0, 0.0)?;
                }
            }
        }
        for (i, skv) in snap.kv.into_iter().enumerate() {
            if skv.is_none() {
                continue;
            }
            // cap-buffer caches keep the stale tail — reads are bounded
            // by kv_tokens so truncation is just the length update;
            // the quantised cache is length-tracked separately
            self.kvq[i].truncate(new_len)?;
        }
        self.kv_tokens = new_len;
        Ok(())
    }

    pub fn clear_kv_cache(&mut self) {
        for g in self.gdn.iter_mut().flatten() {
            g.recurrent = Tensor::zeros_like(&g.recurrent).unwrap();
            g.conv = Tensor::zeros_like(&g.conv).unwrap();
        }
        for kv in self.kv.iter_mut().flatten() {
            *kv = (
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
            );
        }
        for q in self.kvq.iter_mut() {
            *q = crate::turboquant::QuantKv::default();
        }
        if let Some(d) = self.draft.as_mut() {
            d.clear();
        }
        self.captures.clear();
        for v in self.vcache.iter_mut() {
            *v = GdnVerifyCache::default();
        }
        self.kv_tokens = 0;
    }

    // MARK: - DFlash draft integration

    pub fn set_draft(&mut self, draft: crate::dflash::Draft) {
        self.draft = Some(draft);
    }

    pub fn has_draft(&self) -> bool {
        self.draft.is_some()
    }

    pub fn device(&self) -> &Device {
        &self.device
    }

    /// Drain accumulated captures → [rows, 25600] bf16. Each forward
    /// call pushes the five capture layers' [seq, 5120] hiddens in
    /// order — concat per call along the feature dim, then stack calls
    /// along rows. Rows map to the positions of the forwards since the
    /// last drain (prefill: rows are positions 0..P-1 of the prompt).
    pub fn take_captures(&mut self) -> Result<Option<Tensor>> {
        if self.captures.is_empty() {
            return Ok(None);
        }
        let mut calls = Vec::new();
        for group in self.captures.chunks_exact(5) {
            calls.push(Tensor::cat(group, 1)?); // [seq, 25600]
        }
        self.captures.clear();
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
    pub fn draft_prefill(&mut self) -> Result<()> {
        let caps = self.take_captures()?;
        if let (Some(d), Some(c)) = (self.draft.as_mut(), caps) {
            let p = c.dim(0)?;
            let keep = p.min(crate::dflash::WINDOW - 1);
            let start = p - keep;
            d.commit(&c.narrow(0, start, keep)?.contiguous()?, start, keep)?;
        }
        Ok(())
    }

    /// Draft-commit `rows` entries from `captured` ([rows, 25600])
    /// starting at absolute position `start_pos`.
    pub fn draft_commit(&mut self, captured: &Tensor, start_pos: usize, rows: usize) -> Result<()> {
        if let Some(d) = self.draft.as_mut() {
            d.commit(captured, start_pos, rows)?;
        }
        Ok(())
    }

    /// Run the 8-row draft block for `anchor` at position `pos` and
    /// chain the proposal block. `temp`/`uniform` control greedy vs
    /// sampled chaining.
    pub fn draft_propose(
        &mut self,
        anchor: u32,
        pos: usize,
        temp: Option<f64>,
        uniform: impl FnMut() -> f64,
    ) -> Result<crate::dflash::Proposal> {
        let draft = self.draft.as_mut().context("draft not loaded")?;
        let embed = &self.embed;
        let lm_head = &self.lm_head;
        draft.propose(embed, lm_head, anchor, pos, temp, uniform)
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
    /// same recurrence serves prefill and decode. `vc`, when set, stashes
    /// the raw scan inputs for `rollback_verify`.
    fn gdn_forward(
        l: &GdnLayer,
        st: &mut GdnState,
        vc: &mut Option<GdnVerifyCache>,
        x: &Tensor,
        eps: f64,
    ) -> Result<Tensor> {
        let seq = x.dim(1)?;
        let conv_dim = 2 * l.key_dim + l.value_dim;
        // one fused projection → split [qkv | z | a|b] — strided views
        // feed the kernels directly (no contiguous copies)
        let fused = lin_apply(x, &l.in_all)?; // [1, seq, conv+val+96]
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
        if x.device().is_metal()
            && std::env::var("TH_GDN_EAGER").is_err()
        {
            if seq <= 8 && std::env::var("TH_GDN_STEP").is_err() {
                // one dispatch: conv+silu, l2norm, delta scan, gated norm
                let gated = Tensor::zeros(
                    (seq, l.value_dim),
                    DType::BF16,
                    x.device(),
                )?;
                let pack = Tensor::zeros(
                    (seq, conv_dim),
                    DType::BF16,
                    x.device(),
                )?;
                crate::gdn_kernel::gdn_fused_step(
                    &qkv, &st.conv, &l.conv, &st.recurrent, &ab, &z,
                    &l.norm_w, &gated, &pack, seq, l.num_k_heads,
                    l.num_v_heads, l.head_k, l.head_v, eps as f32,
                    l.a_log64, l.dt_bias64,
                )?;
                // new conv window = last (k-1) rows of [state | inputs]
                st.conv = if seq >= l.conv_k - 1 {
                    qkv.narrow(0, seq + 1 - l.conv_k, l.conv_k - 1)?
                } else {
                    Tensor::cat(
                        &[
                            &st.conv
                                .narrow(0, seq, l.conv_k - 1 - seq)?,
                            &qkv,
                        ],
                        0,
                    )?
                    .contiguous()?
                };
                if let Some(c) = vc.as_mut() {
                    c.pack = Some(pack);
                    c.ab = Some(ab.clone());
                }
                return lin_apply(
                    &gated.unsqueeze(0)?,
                    &l.out,
                );
            }
            let conv_out = st
                .conv
                .apply_op3_no_bwd(
                    &qkv,
                    &l.conv,
                    &crate::gdn_kernel::GdnConv {
                        t: seq,
                        c: conv_dim,
                        k: l.conv_k,
                    },
                )?;
            // new window = last (k-1) rows of [state | inputs]
            st.conv = if seq >= l.conv_k - 1 {
                qkv.narrow(0, seq + 1 - l.conv_k, l.conv_k - 1)?
            } else {
                Tensor::cat(
                    &[
                        &st.conv
                            .narrow(0, seq, l.conv_k - 1 - seq)?,
                        &qkv,
                    ],
                    0,
                )?
                .contiguous()?
            };
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
            let out = Self::gdn_scan(
                l,
                st,
                vc,
                &pack,
                &ab,
                seq,
                x.device(),
            )?;
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
            return lin_apply(
                &gated.reshape((1, seq, l.value_dim))?,
                &l.out,
            );
        }

        // ---- eager fallback (CPU / non-Metal) ----
        let qkv = qkv.contiguous()?;
        let z = z.contiguous()?;
        let ab = ab.contiguous()?;
        let conv_in = Tensor::cat(&[&st.conv, &qkv], 0)?; // [k-1+seq, conv_dim]
        let conv_out = conv_silu(&conv_in, &l.conv, seq, conv_dim, l.conv_k)?;
        st.conv =
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
        let out =
            Self::gdn_scan(l, st, vc, &pack, &ab, seq, x.device())?;

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

    /// The gated-delta recurrent scan. On Metal a single fused kernel
    /// handles the whole sequence (decay/beta computed in-shader); the
    /// eager fallback keeps CPU correctness.
    ///
    /// `q`,`k` are normed `[seq, num_k_heads, head_k]`, `v` is
    /// `[seq, num_v_heads, head_v]`, `ab` is `[1, seq, 2*num_v_heads]`.
    /// Returns `[seq, num_v_heads, head_v]`; `st.recurrent` is updated.
    /// `vc`, when set, stashes the packed scan inputs.
    /// `pack` is the conv output — its flat `[q|k|v]` channel order is
    /// already the scan's packed layout, so the kernel reads it directly
    /// (a `[T, 2Hk+Hv, Dw]` view or the flat `[T, conv]` form — identical
    /// element order). `ab` is the strided bf16 `[a|b]` projection view;
    /// the kernel converts in-register. `vc`, when set, stashes the
    /// packed scan inputs for `rollback_verify`.
    fn gdn_scan(
        l: &GdnLayer,
        st: &mut GdnState,
        vc: &mut Option<GdnVerifyCache>,
        pack: &Tensor,
        ab: &Tensor,
        seq: usize,
        dev: &Device,
    ) -> Result<Tensor> {
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if dev.is_metal() {
            let ab_v = if std::env::var("TH_GDN_AB_CONTIG").is_ok() {
                ab.contiguous()?
            } else {
                ab.clone()
            };
            if let Some(c) = vc.as_mut() {
                c.ab = Some(ab_v.clone());
            }
            return Ok(pack.apply_op3_no_bwd(
                &ab_v,
                &st.recurrent,
                &crate::gdn_kernel::GdnStep {
                    t: seq,
                    hk: l.num_k_heads,
                    hv: l.num_v_heads,
                    dk: l.head_k,
                    dv: l.head_v,
                    a_log: l.a_log64,
                    dt_bias: l.dt_bias64,
                },
            )?);
        }
        let _ = dev;

        let q = pack.narrow(1, 0, l.num_k_heads)?; // [seq, hk, dk]
        let k = pack.narrow(1, l.num_k_heads, l.num_k_heads)?;
        let v = pack.narrow(1, 2 * l.num_k_heads, l.num_v_heads)?;
        let ab2 = if ab.dims().len() == 3 {
            ab.squeeze(0)?
        } else {
            ab.clone()
        };

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

        let mut outs = Vec::with_capacity(seq);
        for t in 0..seq {
            let g_t = g.i(t)?.unsqueeze(1)?.unsqueeze(2)?; // [48,1,1]
            let k_t = k.i(t)?;                             // [48,128]
            let v_t = v.i(t)?;                             // [48,128]
            let q_t = q.i(t)?;                             // [48,128]
            let b_t = beta.i(t)?.unsqueeze(1)?;            // [48,1]
            st.recurrent = st.recurrent.broadcast_mul(&g_t)?;
            // state S[h, dv, dk]: kv_mem/readout contract dk (last axis)
            let kv_mem = st
                .recurrent
                .broadcast_mul(&k_t.unsqueeze(1)?)?
                .sum(D::Minus1)?; // [48,128]
            let delta = v_t.sub(&kv_mem)?.broadcast_mul(&b_t)?;
            st.recurrent = st
                .recurrent
                .add(&delta.unsqueeze(2)?.broadcast_mul(&k_t.unsqueeze(1)?)?)?;
            outs.push(
                st.recurrent
                    .broadcast_mul(&q_t.unsqueeze(1)?)?
                    .sum(D::Minus1)?,
            ); // [48,128]
        }
        Ok(Tensor::stack(&outs, 0)?) // [seq, 48, 128]
    }

    /// Full attention with per-head output gate, GQA, partial rope.
    /// When `tq` is set the KV cache is TurboQuant-compressed (`kvq`)
    /// instead of raw bf16 (`kvc`).
    fn attn_forward(
        l: &AttnLayer,
        kvc: &mut (Tensor, Tensor),
        kvq: &mut crate::turboquant::QuantKv,
        tq: Option<&crate::turboquant::TurboQuant>,
        x: &Tensor,
        pos: usize,
        eps: f64,
        device: &Device,
    ) -> Result<Tensor> {
        let seq = x.dim(1)?;
        // one fused projection → split [q|gate | k | v]
        let qd = l.n_heads * 2 * l.head_dim;
        let kd = l.n_kv * l.head_dim;
        let qkv = lin_apply(x, &l.in_qkv)?; // [1,seq,qd+2kd]

        #[cfg(all(feature = "metal", target_os = "macos"))]
        if device.is_metal()
            && tq.is_none()
            && seq <= 8
            && std::env::var("TH_NO_ATTN_FUSED").is_err()
        {
            let (kc, vc) = kvc;
            Self::ensure_kv(kc, vc, pos + seq, device)?;
            let q_buf = Tensor::zeros(
                (seq, l.n_heads, l.head_dim),
                DType::BF16,
                device,
            )?;
            crate::attn_kernel::attn_prepare(
                &qkv, &l.q_norm, &l.k_norm, &l.cos, &l.sin, &q_buf,
                kc, vc, pos, seq, l.n_heads, l.n_kv, l.head_dim,
                l.rot_dim / 2, eps as f32,
            )?;
            let out = Tensor::zeros(
                (seq, l.n_heads * l.head_dim),
                DType::BF16,
                device,
            )?;
            crate::attn_kernel::attn_decode(
                &q_buf, kc, vc, &qkv, &out, pos, seq, l.n_heads, l.n_kv,
                l.head_dim, l.rot_dim / 2,
            )?;
            if std::env::var("TH_DEBUG_ATTN").is_ok() {
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
                let qd_ = q_buf.to_dtype(DType::F32)?.flatten_all()?.to_vec1::<f32>()?;
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
            return lin_apply(&out.unsqueeze(0)?, &l.o);
        }

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
        // narrow to the committed prefix — the cache may be a
        // fixed-capacity buffer whose tail is uninitialised
        let k_pre = if kc.dim(1)? > pos { kc.narrow(1, 0, pos)? } else { kc.clone() };
        let v_pre = if vc.dim(1)? > pos { vc.narrow(1, 0, pos)? } else { vc.clone() };
        let k_all = Tensor::cat(&[k_pre, k.squeeze(0)?], 1)?;
        let v_all = Tensor::cat(&[v_pre, v], 1)?;
        *kc = k_all.clone();
        *vc = v_all.clone();
        let kv_seq = k_all.dim(1)?;

        let rep = l.n_heads / l.n_kv;
        let k_r = k_all
            .unsqueeze(1)?
            .broadcast_as((l.n_kv, rep, kv_seq, l.head_dim))?
            .reshape((l.n_heads, kv_seq, l.head_dim))?
            .unsqueeze(0)?; // [1, 24, kv, 256]
        let v_r = v_all
            .unsqueeze(1)?
            .broadcast_as((l.n_kv, rep, kv_seq, l.head_dim))?
            .reshape((l.n_heads, kv_seq, l.head_dim))?
            .unsqueeze(0)?;

        let scale = (l.head_dim as f64).powf(-0.5);
        let scores = q
            .contiguous()?
            .matmul(&k_r.transpose(D::Minus2, D::Minus1)?.contiguous()?)
            .with_context(|| {
                format!(
                    "attn q@k q={:?}/{:?} k_r={:?}",
                    q.shape(),
                    q.layout().stride(),
                    k_r.shape()
                )
            })?
            .affine(scale, 0.0)?;
        // seq==1 decode attends over the whole cache — no mask needed
        let probs = if seq == 1 {
            candle_nn::ops::softmax(&scores, D::Minus1)?
        } else {
            let mut mask = vec![f32::NEG_INFINITY; seq * kv_seq];
            for i in 0..seq {
                for m in mask.iter_mut().skip(i * kv_seq).take(pos + i + 1) {
                    *m = 0.0;
                }
            }
            let mask_t = Tensor::from_vec(mask, (1, 1, seq, kv_seq), device)?
                .to_dtype(DType::BF16)?;
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
        let out = out
            .squeeze(0)?
            .transpose(0, 1)?
            .reshape((seq, l.n_heads * l.head_dim))?;
        let out = out.broadcast_mul(&candle_nn::ops::sigmoid(
            &gate.reshape((seq, l.n_heads * l.head_dim))?,
        )?)?;
        lin_apply(&out.unsqueeze(0)?, &l.o)
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
        let ncap = (cap * 2).max(need).max(2048);
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
            let mut mask = vec![f32::NEG_INFINITY; seq * kv_seq];
            for i in 0..seq {
                for m in mask.iter_mut().skip(i * kv_seq).take(pos + i + 1) {
                    *m = 0.0;
                }
            }
            let mask_t = Tensor::from_vec(mask, (seq, 1, kv_seq), device)?;
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
        lin_apply(&out.unsqueeze(0)?, &l.o)
    }

    /// tokens at absolute position `pos` → logits (vocab,) for the last.
    pub fn forward(&mut self, tokens: &[u32], pos: usize) -> Result<Tensor> {
        self.forward_inner(tokens, pos, true)
    }

    /// Same, but logits for every position — `[seq, vocab]`. Used by the
    /// speculative-verify pass.
    pub fn forward_multi(&mut self, tokens: &[u32], pos: usize) -> Result<Tensor> {
        self.forward_inner(tokens, pos, false)
    }

    fn forward_inner(
        &mut self,
        tokens: &[u32],
        pos: usize,
        last_only: bool,
    ) -> Result<Tensor> {
        let seq = tokens.len();
        let ids = Tensor::new(tokens, &self.device)?;
        let mut x = self.embed.i(&ids)?.unsqueeze(0)?; // [1, seq, hidden]
        // stash GDN scan inputs during multi-row verify passes so a
        // partial accept can re-apply committed rows without a re-forward
        let cache_verify = !last_only && seq <= 16;
        if cache_verify {
            for v in self.vcache.iter_mut() {
                *v = GdnVerifyCache::default();
            }
        }
        let phase_t = std::env::var("TH_PHASE_TIME").is_ok()
            .then(std::time::Instant::now);
        let mut h_next: Option<Tensor> = None;
        for i in 0..self.layers.len() {
            let layer = &self.layers[i];
            let h = match h_next.take() {
                Some(v) => v,
                None => rms_norm(&x, &layer.input_norm, self.cfg.rms_norm_eps)?,
            };
            let r = match &layer.kind {
                Kind::Gdn(l) => {
                    let mut st = self.gdn[i].take().unwrap();
                    let mut vc = cache_verify.then(GdnVerifyCache::default);
                    let r = Self::gdn_forward(
                        l, &mut st, &mut vc, &h, self.cfg.rms_norm_eps,
                    );
                    self.vcache[i] = vc.unwrap_or_default();
                    self.gdn[i] = Some(st);
                    r?
                }
                Kind::Attn(l) => {
                    let mut kvc = self.kv[i].take().unwrap();
                    let mut kvq = std::mem::take(&mut self.kvq[i]);
                    let r = Self::attn_forward(
                        l, &mut kvc, &mut kvq, self.tq.as_ref(), &h, pos,
                        self.cfg.rms_norm_eps, &self.device,
                    );
                    self.kv[i] = Some(kvc);
                    self.kvq[i] = kvq;
                    r?
                }
            };
            // fused: x += r; h2 = rms_norm(x)·post_norm — one dispatch
            let (xn, h2) =
                add_rms_norm(&x, &r, &layer.post_norm, self.cfg.rms_norm_eps)?;
            // fused gate|up projection with in-kernel silu·mul epilogue
            // (eager narrow + silu·mul fallback off-Metal / prefill)
            let act = match &layer.mlp.gate_up {
                Lin::Quant(q) => match q.gate_up_act(&h2) {
                    Some(r) => r?,
                    None => {
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
                        candle_nn::ops::silu(&gate)?.mul(&up)?
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
                    candle_nn::ops::silu(&gate)?.mul(&up)?
                }
            };
            let mlp = lin_apply(&act, &layer.mlp.down)?;
            if i + 1 < self.layers.len() {
                // fused: x += mlp; h_next = rms_norm(x)·next input_norm
                let (xn2, hn) = add_rms_norm(
                    &xn,
                    &mlp,
                    &self.layers[i + 1].input_norm,
                    self.cfg.rms_norm_eps,
                )?;
                x = xn2;
                h_next = Some(hn);
            } else {
                x = xn.add(&mlp)?;
            }
            if self.draft.is_some()
                && crate::dflash::CAPTURE_LAYERS.contains(&i)
            {
                self.captures.push(x.squeeze(0)?.contiguous()?);
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
        let x = rms_norm(&x, &self.norm, self.cfg.rms_norm_eps)?;
        if let Some(t0) = phase_t {
            self.device.synchronize()?;
            eprintln!(
                "[phase] seq={seq} layers={:.1}ms",
                t0.elapsed().as_secs_f64() * 1e3
            );
        }
        let t1 = phase_t.map(|_| std::time::Instant::now());
        self.kv_tokens = pos + seq;
        if last_only {
            let last = x.narrow(1, seq - 1, 1)?; // [1, 1, hidden]
            let logits =
                lin_apply(&last, &self.lm_head)?.reshape((self.cfg.vocab_size,))?;
            return Ok(logits.to_dtype(DType::F32)?);
        }
        // [1, seq, vocab] — keep bf16 (halves the accept readback)
        let out = lin_apply(&x, &self.lm_head)?.squeeze(0)?;
        if let Some(t) = t1 {
            self.device.synchronize()?;
            eprintln!("[phase] lm_head={:.1}ms", t.elapsed().as_secs_f64() * 1e3);
        }
        Ok(out)
    }
}
