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
}

// MARK: - math helpers

/// x / sqrt(mean(x²) + eps) * w — fused Metal kernel, f32 accumulation
/// inside the shader (weights already carry the +1 offset from conversion).
fn rms_norm(x: &Tensor, w: &Tensor, eps: f64) -> Result<Tensor> {
    candle_nn::ops::rms_norm(x, w, eps as f32).map_err(Into::into)
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
    in_qkv: Tensor,  // [10240, 5120]
    in_z: Tensor,    // [6144, 5120]
    in_b: Tensor,    // [48, 5120]
    in_a: Tensor,    // [48, 5120]
    conv: Tensor,    // [10240, 4] depthwise taps
    a_log: Tensor,   // [48] f32
    dt_bias: Tensor, // [48] f32
    norm_w: Tensor,  // [128]
    ones_dk: Tensor, // [head_k] ones — unit weight for fused rms_norm
    out: Tensor,     // [5120, 6144]
    key_dim: usize,
    value_dim: usize,
    num_k_heads: usize,
    num_v_heads: usize,
    head_k: usize,
    head_v: usize,
    conv_k: usize,
}

struct AttnLayer {
    q: Tensor,      // [12288, 5120] — per-head [q|gate] interleaved
    k: Tensor,      // [1024, 5120]
    v: Tensor,
    o: Tensor,      // [5120, 6144]
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
    gate: Tensor,
    up: Tensor,
    down: Tensor,
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

pub struct Qwen35 {
    embed: Tensor,
    layers: Vec<Layer>,
    norm: Tensor,
    lm_head: Tensor,
    cfg: Qwen35Config,
    device: Device,
    gdn: Vec<Option<GdnState>>,
    kv: Vec<Option<(Tensor, Tensor)>>, // [n_kv, seq, head_dim] bf16
    pub kv_tokens: usize,
    debug: bool,
}

impl Qwen35 {
    pub fn load(
        files: &[std::path::PathBuf],
        cfg: &Qwen35Config,
        device: &Device,
    ) -> Result<Self> {
        let w = Weights::load(files, device)?;
        let p = "language_model";
        let embed = w.get(&format!("{p}.model.embed_tokens"))?;
        let lm_head = if cfg.tie_word_embeddings {
            embed.clone()
        } else {
            w.get(&format!("{p}.lm_head"))?
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
                gate: w.get(&format!("{lp}.mlp.gate_proj"))?,
                up: w.get(&format!("{lp}.mlp.up_proj"))?,
                down: w.get(&format!("{lp}.mlp.down_proj"))?,
            };
            if cfg.is_linear(i) {
                let conv3 = w.get(&format!("{lp}.linear_attn.conv1d"))?;
                layers.push(Layer {
                    input_norm,
                    kind: Kind::Gdn(GdnLayer {
                        in_qkv: w
                            .get(&format!("{lp}.linear_attn.in_proj_qkv"))?,
                        in_z: w.get(&format!("{lp}.linear_attn.in_proj_z"))?,
                        in_b: w.get(&format!("{lp}.linear_attn.in_proj_b"))?,
                        in_a: w.get(&format!("{lp}.linear_attn.in_proj_a"))?,
                        conv: conv3.squeeze(2)?,
                        a_log: w
                            .get(&format!("{lp}.linear_attn.A_log"))?
                            .to_dtype(DType::F32)?,
                        dt_bias: w
                            .get(&format!("{lp}.linear_attn.dt_bias"))?
                            .to_dtype(DType::F32)?,
                        norm_w: w.get(&format!("{lp}.linear_attn.norm"))?,
                        ones_dk: Tensor::ones(
                            cfg.linear_key_head_dim,
                            DType::BF16,
                            device,
                        )?,
                        out: w.get(&format!("{lp}.linear_attn.out_proj"))?,
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
                        q: w.get(&format!("{lp}.self_attn.q_proj"))?,
                        k: w.get(&format!("{lp}.self_attn.k_proj"))?,
                        v: w.get(&format!("{lp}.self_attn.v_proj"))?,
                        o: w.get(&format!("{lp}.self_attn.o_proj"))?,
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
            kv_tokens: 0,
            debug: std::env::var("TH_DEBUG_LAYERS").is_ok(),
        })
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
        self.kv_tokens = 0;
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
    /// same recurrence serves prefill and decode.
    fn gdn_forward(l: &GdnLayer, st: &mut GdnState, x: &Tensor, eps: f64) -> Result<Tensor> {
        let seq = x.dim(1)?;
        let conv_dim = 2 * l.key_dim + l.value_dim;
        let qkv = linear(x, &l.in_qkv)?.squeeze(0)?; // [seq, 10240]
        let z = linear(x, &l.in_z)?;                 // [1, seq, 6144]
        let b = linear(x, &l.in_b)?;                 // [1, seq, 48]
        let a = linear(x, &l.in_a)?;                 // [1, seq, 48]

        // causal depthwise conv over [prev_state | inputs]
        let conv_in = Tensor::cat(&[&st.conv, &qkv], 0)?; // [k-1+seq, conv_dim]
        let conv_out = if seq == 1 {
            // single-step: out = Σ_j w[:,j]·conv_in[j] — one mul+sum
            candle_nn::ops::silu(
                &conv_in.broadcast_mul(&l.conv.t()?)?.sum(0)?,
            )?
            .unsqueeze(0)? // [1, conv_dim]
        } else {
            let mut acc =
                Tensor::zeros((seq, conv_dim), DType::BF16, x.device())?;
            for j in 0..l.conv_k {
                let seg = conv_in.narrow(0, j, seq)?;
                let tap = l.conv.i((.., j))?.unsqueeze(0)?;
                acc = acc.broadcast_add(&seg.broadcast_mul(&tap)?)?;
            }
            candle_nn::ops::silu(&acc)? // [seq, conv_dim]
        };
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
        let q = expand(&q)?;
        let k = expand(&k)?;

        // decay g = exp(-exp(A_log)·softplus(a + dt_bias)), f32
        let a_f = a.squeeze(0)?.to_dtype(DType::F32)?; // [seq, 48]
        let g = softplus(&a_f.broadcast_add(&l.dt_bias)?)?
            .broadcast_mul(&l.a_log.exp()?.neg()?)?
            .exp()?; // [seq, 48]
        let beta =
            candle_nn::ops::sigmoid(&b.squeeze(0)?.to_dtype(DType::F32)?)?;

        let q = q.to_dtype(DType::F32)?;
        let k = k.to_dtype(DType::F32)?;
        let v = v.to_dtype(DType::F32)?;

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
        let out = Tensor::stack(&outs, 0)?; // [seq, 48, 128]

        // gated RMSNorm: fused rms_norm(out)·w × silu(z)
        let n = candle_nn::ops::rms_norm(
            &out.to_dtype(DType::BF16)?,
            &l.norm_w,
            eps as f32,
        )?;
        let zr = z.reshape((seq, l.num_v_heads, l.head_v))?;
        let gated = n.broadcast_mul(&candle_nn::ops::silu(&zr)?)?;
        linear(&gated.reshape((1, seq, l.value_dim))?, &l.out)
    }

    /// Full attention with per-head output gate, GQA, partial rope.
    fn attn_forward(
        l: &AttnLayer,
        kvc: &mut (Tensor, Tensor),
        x: &Tensor,
        pos: usize,
        eps: f64,
        device: &Device,
    ) -> Result<Tensor> {
        let seq = x.dim(1)?;
        let qg = linear(x, &l.q)?.reshape((seq, l.n_heads, 2 * l.head_dim))?;
        let q = qg.narrow(D::Minus1, 0, l.head_dim)?; // [seq, 24, 256]
        let gate = qg.narrow(D::Minus1, l.head_dim, l.head_dim)?;
        let k = linear(x, &l.k)?.reshape((seq, l.n_kv, l.head_dim))?;
        let v = linear(x, &l.v)?.reshape((seq, l.n_kv, l.head_dim))?;

        let q = rms_norm(&q.contiguous()?, &l.q_norm, eps)?;
        let k = rms_norm(&k.contiguous()?, &l.k_norm, eps)?;

        // → [1, heads, seq, dim] for rope + batched matmul
        let q = q.transpose(0, 1)?.unsqueeze(0)?;
        let k = k.transpose(0, 1)?.unsqueeze(0)?;
        let v = v.transpose(0, 1)?; // [4, seq, 256]
        let q = Self::rope(&q, &l.cos, &l.sin, pos, l.rot_dim)?;
        let k = Self::rope(&k, &l.cos, &l.sin, pos, l.rot_dim)?;

        let (kc, vc) = kvc;
        let k_all = Tensor::cat(&[kc.clone(), k.squeeze(0)?], 1)?;
        let v_all = Tensor::cat(&[vc.clone(), v], 1)?;
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
        linear(&out.unsqueeze(0)?, &l.o)
    }

    /// tokens at absolute position `pos` → logits (vocab,) for the last.
    pub fn forward(&mut self, tokens: &[u32], pos: usize) -> Result<Tensor> {
        let seq = tokens.len();
        let ids = Tensor::new(tokens, &self.device)?;
        let mut x = self.embed.i(&ids)?.unsqueeze(0)?; // [1, seq, hidden]
        for i in 0..self.layers.len() {
            let layer = &self.layers[i];
            let h = rms_norm(&x, &layer.input_norm, self.cfg.rms_norm_eps)?;
            let r = match &layer.kind {
                Kind::Gdn(l) => {
                    let mut st = self.gdn[i].take().unwrap();
                    let r = Self::gdn_forward(l, &mut st, &h, self.cfg.rms_norm_eps);
                    self.gdn[i] = Some(st);
                    r?
                }
                Kind::Attn(l) => {
                    let mut kvc = self.kv[i].take().unwrap();
                    let r = Self::attn_forward(
                        l, &mut kvc, &h, pos,
                        self.cfg.rms_norm_eps, &self.device,
                    );
                    self.kv[i] = Some(kvc);
                    r?
                }
            };
            x = x.add(&r)?;
            let h2 = rms_norm(&x, &layer.post_norm, self.cfg.rms_norm_eps)?;
            let mlp = linear(
                &candle_nn::ops::silu(&linear(&h2, &layer.mlp.gate)?)?
                    .mul(&linear(&h2, &layer.mlp.up)?)?,
                &layer.mlp.down,
            )?;
            x = x.add(&mlp)?;
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
        let last = x.narrow(1, seq - 1, 1)?; // [1, 1, hidden]
        let logits = linear(&last, &self.lm_head)?.reshape((self.cfg.vocab_size,))?;
        self.kv_tokens = pos + seq;
        Ok(logits.to_dtype(DType::F32)?)
    }
}
