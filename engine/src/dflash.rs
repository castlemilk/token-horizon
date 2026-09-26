// DFlash neural draft model — ported from Splash's runtime
// (docs/splash/runtime/model/DFlashDraft.cpp + ops/DraftAttention.cpp +
// metal/kernels/decode/{draft,sampling}.metal), targeting the weights
// published as `incoai/Qwen3.8-27B-DFlash2`.
//
// The draft is a 5-layer transformer over token embeddings (shared with
// the target) whose persistent context is a 2048-entry ring of K/V built
// from PROJECTED TARGET HIDDEN STATES (5 capture layers x 5120 = 25600 →
// context projection → per-layer QKV → K/V), never from draft activations.
// Each decode step runs 8 rows — [anchor, mask x7] — that attend the ring
// plus each other bidirectionally (is_causal=false); logits rows 1..7
// give unary distributions for proposal positions 1..7, and a rank-256
// selector projection + predecessor/successor codebooks score a 16x16
// edge table per position to chain a 7-token block proposal.
//
// Weight files are Splash's packed format (magic "MDFD0004"): a 16-byte
// header (magic + layer index + type) then 16 KiB-aligned sections. Q4
// projections store [tile=out/256][group=in/64][row%256] blocks of 32
// packed nibble bytes, then bf16 scales and biases in the same
// [tile][group][row] order — `w = q*scale + bias`, group 64. We repack
// into our row-major QLin layout at load (verified elementwise against
// the upstream safetensors within quantisation tolerance).

use anyhow::{bail, Context, Result};
use candle_core::{DType, Device, IndexOp, Tensor};
use half::bf16;

use crate::qwen35::{lin_apply, lin_apply_ps, rms_norm, Lin, QLin};

pub const DRAFT_LAYERS: usize = 5;
pub const HIDDEN: usize = 5120;
pub const QKV: usize = 6144; // q[4096] | k[1024] | v[1024]
pub const ATTN: usize = 4096;
pub const INTER: usize = 17408;
pub const DYN: usize = 1280; // 4 taps x 320 channel-groups
pub const HEADS: usize = 32;
pub const KV_HEADS: usize = 8;
pub const HEAD_DIM: usize = 128;
pub const ROWS: usize = 8;
pub const PROPOSALS: usize = 7;
pub const WINDOW: usize = 2048;
pub const RANK: usize = 256;
pub const TOPK: usize = 16;
/// Codebook rows (= padded vocab; the chunked top-16 covers 485 x 512).
pub const CB_ROWS: usize = 248320;
pub const TARGET_HIDDEN: usize = 25600;
pub const MASK_TOKEN: u32 = 248070;
pub const CAPTURE_LAYERS: [usize; 5] = [5, 19, 33, 47, 61];
const THETA: f64 = 10_000_000.0;
const ALIGN: usize = 16384;
const MAGIC: &[u8; 8] = b"MDFD0004";
const INV_SQRT_D: f64 = 0.08838834764831845; // 1/sqrt(128)

// MARK: - packed file parsing

fn align(x: usize) -> usize {
    (x + ALIGN - 1) & !(ALIGN - 1)
}

/// One packed weight file; `off` walks 16 KiB-aligned sections exactly
/// like Splash's `WeightFile::section`.
struct PackedFile {
    data: Vec<u8>,
    off: usize,
}

impl PackedFile {
    fn open(path: &std::path::Path, layer: u32, ty: u32) -> Result<Self> {
        let data = std::fs::read(path)
            .with_context(|| format!("read {}", path.display()))?;
        if data.len() < 16 || data.len() % ALIGN != 0 {
            bail!("{}: packed file size is not 16 KiB-aligned", path.display());
        }
        if &data[..8] != MAGIC {
            bail!("{}: bad draft magic {:?}", path.display(), &data[..8]);
        }
        let l = u32::from_le_bytes(data[8..12].try_into().unwrap());
        let t = u32::from_le_bytes(data[12..16].try_into().unwrap());
        if l != layer || t != ty {
            bail!(
                "{}: header mismatch (layer {l} type {t}, want {layer}/{ty})",
                path.display()
            );
        }
        Ok(Self { data, off: 16 })
    }

    fn section(&mut self, bytes: usize) -> Result<&[u8]> {
        let start = align(self.off);
        let end = start + bytes;
        if end > self.data.len() {
            bail!("packed file truncated at offset {start}");
        }
        self.off = end;
        Ok(&self.data[start..end])
    }

    fn finish(&self) -> Result<()> {
        if align(self.off) != self.data.len() {
            bail!("packed file has {} unconsumed bytes", self.data.len() - align(self.off));
        }
        Ok(())
    }
}

/// Repack a Splash Q4 projection into our `QLin` layout.
///
/// Splash: weights/scale/bias stored as [tile=out/256][group][row%256];
/// ours: row-major [out][group]. Nibble order is identical (LSB-first,
/// 8 per u32, verified against the upstream bf16 safetensors), so this
/// is a pure byte permutation.
fn repack_q4(sec: &[u8], out: usize, inp: usize, device: &Device) -> Result<QLin> {
    if inp % 64 != 0 || out % 256 != 0 {
        bail!("q4 dims {out}x{inp} violate group/storage constraints");
    }
    let ng = inp / 64;
    let wbytes = out * inp / 2;
    let pbytes = out * inp / 32;
    if sec.len() != wbytes + 2 * pbytes {
        bail!(
            "q4 section {} bytes, want {}",
            sec.len(),
            wbytes + 2 * pbytes
        );
    }
    let w = &sec[..wbytes];
    let s = &sec[wbytes..wbytes + pbytes];
    let b = &sec[wbytes + pbytes..];
    let mut wq = vec![0u8; wbytes];
    let mut sb = vec![0u8; 2 * pbytes];
    for r in 0..out {
        let (tile, rr) = (r / 256, r % 256);
        for g in 0..ng {
            let src = tile * ng * 256 * 32 + (g * 256 + rr) * 32;
            wq[(r * ng + g) * 32..(r * ng + g) * 32 + 32]
                .copy_from_slice(&w[src..src + 32]);
            let sp = ((tile * ng + g) * 256 + rr) * 2;
            sb[(r * 2 * ng + g) * 2..(r * 2 * ng + g) * 2 + 2]
                .copy_from_slice(&s[sp..sp + 2]);
            sb[(r * 2 * ng + ng + g) * 2..(r * 2 * ng + ng + g) * 2 + 2]
                .copy_from_slice(&b[sp..sp + 2]);
        }
    }
    let wq_u32: Vec<u32> = wq
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    let sb_bf16: Vec<bf16> = sb
        .chunks_exact(2)
        .map(|c| bf16::from_le_bytes(c.try_into().unwrap()))
        .collect();
    Ok(QLin::new(
        Tensor::from_vec(wq_u32, (out, inp / 8), device)?,
        Tensor::from_vec(sb_bf16, (out, 2 * ng), device)?,
        out,
        inp,
        64,
    ))
}

fn section_tensor(sec: &[u8], shape: (usize, usize), device: &Device) -> Result<Tensor> {
    let vals: Vec<bf16> = sec
        .chunks_exact(2)
        .map(|c| bf16::from_le_bytes(c.try_into().unwrap()))
        .collect();
    Tensor::from_vec(vals, shape, device).map_err(Into::into)
}

/// A bf16 section kept on the host (D1 codebooks).
fn section_host(sec: &[u8]) -> Vec<bf16> {
    sec.chunks_exact(2)
        .map(|c| bf16::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

fn q4(f: &mut PackedFile, out: usize, inp: usize, device: &Device) -> Result<Lin> {
    crate::qwen35::maybe_tiled(q4_rows(f, out, inp, device)?)
}

/// A Q4 section as a row-major (untiled) `Lin` — for fusing before tiling.
fn q4_rows(f: &mut PackedFile, out: usize, inp: usize, device: &Device) -> Result<Lin> {
    let bytes = out * inp / 16 * 9;
    let sec = f.section(bytes)?;
    Ok(Lin::Quant(repack_q4(sec, out, inp, device)?))
}

fn norm(f: &mut PackedFile, n: usize, device: &Device) -> Result<Tensor> {
    let sec = f.section(n * 2)?;
    let vals: Vec<bf16> = sec
        .chunks_exact(2)
        .map(|c| bf16::from_le_bytes(c.try_into().unwrap()))
        .collect();
    Tensor::from_vec(vals, n, device).map_err(Into::into)
}

// MARK: - weights

struct DraftLayer {
    input_norm: Tensor,    // [5120]
    conv_base: Tensor,     // [4, 5120] — [stage][tap][ch] flattened
    attn_dyn: Lin,         // [1280, 5120]
    qkv: Lin,              // [6144, 5120]
    q_norm: Tensor,        // [128]
    k_norm: Tensor,        // [128]
    o_proj: Lin,           // [5120, 4096]
    post_norm: Tensor,     // [5120]
    mlp_conv_base: Tensor, // [4, 5120]
    mlp_dyn: Lin,          // [1280, 5120]
    /// K45: [gate | up] fused row-wise ([2 x 17408, 5120]) so the MLP runs
    /// the target's N256 two-stream tile with the silu·mul epilogue (one
    /// dispatch instead of two projections + eager silu + mul) and hands
    /// `down` a presum block.
    gate_up: Lin,
    down: Lin,             // [5120, 17408]
}

impl DraftLayer {
    /// MLP body `down(silu(gate(x)) * up(x))` on the fused gate|up weight
    /// — shared by `propose` (8 rows) and `propose_batch` (B*8 rows).
    /// `gate_up_act_ps` picks the tile by row count: the N256 two-stream
    /// tile with the silu·mul epilogue at <= 8 rows (it also emits
    /// `down`'s presum block), the two-pass prefill tile (gate pass into
    /// scratch, then up + silu·gate) above 8 rows. When neither applies
    /// (non-Metal / untiled weights) the eager fallback narrows the fused
    /// `[.., 2 * INTER]` projection on its last dim.
    fn mlp(&self, x: &Tensor) -> Result<Tensor> {
        crate::gpuprof::region("mlp.gate_up");
        let fused = match &self.gate_up {
            Lin::Quant(q) => q.gate_up_act_ps(x, false),
            _ => None,
        };
        let (inter, inter_ps) = match fused {
            Some(r) => r?,
            None => {
                let gu = lin_apply(x, &self.gate_up)?;
                let last = gu.rank() - 1;
                let gate = gu.narrow(last, 0, INTER)?.contiguous()?;
                let up = gu.narrow(last, INTER, INTER)?.contiguous()?;
                (candle_nn::ops::silu(&gate)?.mul(&up)?, false)
            }
        };
        crate::gpuprof::region("mlp.down");
        lin_apply_ps(&inter, &self.down, inter_ps)
    }
}

/// Shared draft weights — one instance regardless of batch width.
pub struct DraftWeights {
    layers: Vec<DraftLayer>,
    fc: Lin,            // [5120, 25600] context projection
    hidden_norm: Tensor,
    final_norm: Tensor,
    selector: Lin,      // [256, 5120]
    /// D1: predecessor / successor codebooks `[CB_ROWS, 256]` bf16,
    /// row-major, HOST-resident. The walk only ever reads 97 + 112 rows
    /// per slot per round, chosen by the candidate ids the GPU just
    /// produced — gathering them on the GPU cost two extra host syncs
    /// per propose; a host gather costs ~100 KB of reads.
    pred_cb: Vec<bf16>,
    succ_cb: Vec<bf16>,
    device: Device,
}

/// Per-slot draft state — the committed-position K/V ring.
/// `ring_k[l]` = [8 heads][2048 slots][128]; slot = position % 2048.
/// GPU-resident — commits scatter in place and attention gathers via
/// index_select (no CPU round-trip).
pub struct Draft {
    pub(crate) ring_k: Vec<Tensor>,
    pub(crate) ring_v: Vec<Tensor>,
    /// Number of committed positions (0..ring_len are valid).
    pub(crate) ring_len: usize,
    #[allow(dead_code)]
    device: Device,
}

impl Draft {
    /// Fresh ring for one slot — `w` weights live in the shared
    /// `DraftWeights`.
    pub fn new(device: &Device) -> Result<Self> {
        let ring_shape = (KV_HEADS, WINDOW, HEAD_DIM);
        let ring_k = (0..DRAFT_LAYERS)
            .map(|_| Tensor::zeros(ring_shape, DType::BF16, device))
            .collect::<std::result::Result<Vec<_>, candle_core::Error>>()?;
        let ring_v = (0..DRAFT_LAYERS)
            .map(|_| Tensor::zeros(ring_shape, DType::BF16, device))
            .collect::<std::result::Result<Vec<_>, candle_core::Error>>()?;
        Ok(Self {
            ring_k,
            ring_v,
            ring_len: 0,
            device: device.clone(),
        })
    }

    pub fn clear(&mut self) {
        self.ring_len = 0;
    }
}

/// Proposals for one draft round: the chained 7-token block plus the
/// per-position candidate table the sampled acceptance rule needs.
pub struct Proposal {
    pub tokens: [u32; PROPOSALS],
    /// Top-16 candidate ids per position (rows 1..7 of the logits).
    pub cand_ids: [[u32; TOPK]; PROPOSALS],
    /// Corrected-score softmax probabilities per candidate (draft `q`).
    pub cand_probs: [[f32; TOPK]; PROPOSALS],
}

impl DraftWeights {
    /// Load a Splash `draft/` directory (layer-0..4.bin + model.bin).
    pub fn load(dir: &std::path::Path, device: &Device) -> Result<Self> {
        let mut layers = Vec::with_capacity(DRAFT_LAYERS);
        for i in 0..DRAFT_LAYERS {
            let mut f =
                PackedFile::open(&dir.join(format!("layer-{i}.bin")), i as u32, 0)?;
            layers.push(DraftLayer {
                input_norm: norm(&mut f, HIDDEN, device)?,
                conv_base: section_tensor(
                    f.section(4 * HIDDEN * 2)?,
                    (4, HIDDEN),
                    device,
                )?,
                attn_dyn: q4(&mut f, DYN, HIDDEN, device)?,
                qkv: q4(&mut f, QKV, HIDDEN, device)?,
                q_norm: norm(&mut f, HEAD_DIM, device)?,
                k_norm: norm(&mut f, HEAD_DIM, device)?,
                o_proj: q4(&mut f, HIDDEN, ATTN, device)?,
                post_norm: norm(&mut f, HIDDEN, device)?,
                mlp_conv_base: section_tensor(
                    f.section(4 * HIDDEN * 2)?,
                    (4, HIDDEN),
                    device,
                )?,
                mlp_dyn: q4(&mut f, DYN, HIDDEN, device)?,
                gate_up: {
                    // section order is gate then up; fuse before tiling
                    // (the fused tiled layout = gate tiles, then up tiles)
                    let gate = q4_rows(&mut f, INTER, HIDDEN, device)?;
                    let up = q4_rows(&mut f, INTER, HIDDEN, device)?;
                    crate::qwen35::maybe_tiled(crate::qwen35::fuse_lins(&[gate, up])?)?
                },
                down: q4(&mut f, HIDDEN, INTER, device)?,
            });
            f.finish()?;
        }
        let mut f = PackedFile::open(&dir.join("model.bin"), DRAFT_LAYERS as u32, 1)?;
        let fc = q4(&mut f, HIDDEN, TARGET_HIDDEN, device)?;
        let hidden_norm = norm(&mut f, HIDDEN, device)?;
        let final_norm = norm(&mut f, HIDDEN, device)?;
        let selector = q4(&mut f, RANK, HIDDEN, device)?;
        let cb_bytes = CB_ROWS * RANK * 2;
        let pred_cb = section_host(f.section(cb_bytes)?);
        let succ_cb = section_host(f.section(cb_bytes)?);
        f.finish()?;

        Ok(Self {
            layers,
            fc,
            hidden_norm,
            final_norm,
            selector,
            pred_cb,
            succ_cb,
            device: device.clone(),
        })
    }

    /// Commit `rows` context entries into the ring. `captured` is
    /// [rows, 25600] bf16 (5 target-layer hiddens per position, capture
    /// order 5,19,33,47,61); `start_pos` is the first row's absolute
    /// token position.
    pub fn commit(
        &self,
        ctx: &mut Draft,
        captured: &Tensor,
        start_pos: usize,
        rows: usize,
    ) -> Result<()> {
        if rows == 0 {
            return Ok(());
        }
        crate::gpuprof::region("fc");
        let proj = lin_apply(&captured.narrow(0, 0, rows)?.contiguous()?, &self.fc)?;
        crate::gpuprof::region("norm");
        // decode commits (rows <= 8): a presum block for the five qkv
        // projections (no pad copy at rows < 8, PreSums tiles)
        let (hidden, hidden_ps) = rms_norm_ps(&proj, &self.hidden_norm, 0, rows)?; // [rows, 5120]
        crate::gpuprof::region("rope_table");
        let (cos, sin) = rope_table(&self.device, start_pos, rows)?;
        for (li, l) in self.layers.iter().enumerate() {
            crate::gpuprof::region("qkv");
            let qkv = lin_apply_ps(&hidden, &l.qkv, hidden_ps)?; // [rows, 6144]
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if qkv.device().is_metal() && !draft_eager() && ring_fused() && qkv.is_contiguous() {
                // head views of the projection rows (no reshape copies —
                // draft_norm_rope and the ring write honour the row stride)
                let heads = qkv.reshape((rows, QKV / HEAD_DIM, HEAD_DIM))?;
                let k = heads.narrow(1, ATTN / HEAD_DIM, KV_HEADS)?;
                let v = heads.narrow(1, ATTN / HEAD_DIM + KV_HEADS, KV_HEADS)?;
                crate::gpuprof::region("knorm_rope");
                let k = dnorm_rope(&k, &l.k_norm, &cos, &sin)?;
                crate::gpuprof::region("ring_write");
                crate::quant_kernel::draft_ring_write(
                    &k,
                    &v,
                    &ctx.ring_k[li],
                    &ctx.ring_v[li],
                    start_pos % WINDOW,
                )?;
                continue;
            }
            let k = qkv
                .narrow(1, ATTN, KV_HEADS * HEAD_DIM)?
                .reshape((rows, KV_HEADS, HEAD_DIM))?;
            let v = qkv
                .narrow(1, ATTN + KV_HEADS * HEAD_DIM, KV_HEADS * HEAD_DIM)?
                .reshape((rows, KV_HEADS, HEAD_DIM))?;
            crate::gpuprof::region("knorm_rope");
            let k = dnorm_rope(&k, &l.k_norm, &cos, &sin)?;
            crate::gpuprof::region("ring_scatter");
            // in-place ring write: src [heads, rows, dim], indexes give
            // the slot for each row (positions are contiguous → slots
            // are contiguous mod WINDOW).
            let kp = k.permute((1, 0, 2))?.contiguous()?; // [8, rows, 128]
            let vp = v.permute((1, 0, 2))?.contiguous()?;
            let slots: Vec<u32> = (0..rows)
                .map(|r| ((start_pos + r) % WINDOW) as u32)
                .collect();
            let idx = Tensor::new(slots.as_slice(), &self.device)?
                .reshape((1, rows, 1))?
                .broadcast_as((KV_HEADS, rows, HEAD_DIM))?
                .contiguous()?;
            ctx.ring_k[li].scatter_set(&idx, &kp, 1)?;
            ctx.ring_v[li].scatter_set(&idx, &vp, 1)?;
        }
        ctx.ring_len = ctx.ring_len.max(start_pos + rows);
        Ok(())
    }


    /// Run the draft block forward for `[anchor, mask x7]` at draft
    /// positions `pos..pos+7` and chain a 7-token proposal block.
    ///
    /// `embed`/`lm_head` are the target's — the draft shares both.
    /// `temp` selects greedy (None) vs sampled chaining; `uniform` draws
    /// uniforms in (0,1).
    pub fn propose(
        &self,
        ctx: &mut Draft,
        embed: &Tensor,
        lm_head: &Lin,
        anchor: u32,
        pos: usize,
        temp: Option<f64>,
        mut uniform: impl FnMut() -> f64,
    ) -> Result<Proposal> {
        let ids: Vec<u32> = std::iter::once(anchor)
            .chain(std::iter::repeat(MASK_TOKEN).take(PROPOSALS))
            .collect();
        crate::gpuprof::region("embed");
        let mut x = embed
            .i(&Tensor::new(ids.as_slice(), &self.device)?)?
            .unsqueeze(0)?; // [1, 8, 5120]
        crate::gpuprof::region("rope_table");
        let (cos, sin) = rope_table(&self.device, pos, ROWS)?;
        for (li, l) in self.layers.iter().enumerate() {
            crate::gpuprof::region("norm.in");
            // n / conv: K45 presum blocks when `draft_ps` (plain [1,8,5120]
            // views otherwise — dconv reads the block's rows as a plain x)
            let (n, n_ps) = rms_norm_ps(&x, &l.input_norm, 0, ROWS)?; // [1,8,5120]
            crate::gpuprof::region("dyn");
            let dyn_ = lin_apply_ps(&n, &l.attn_dyn, n_ps)?; // [1,8,1280]
            crate::gpuprof::region("dconv");
            let (conv, conv_ps) = dconv_ps(&n, &dyn_, &l.conv_base, 0, None)?;
            crate::gpuprof::region("qkv");
            let qkv = lin_apply_ps(&conv, &l.qkv, conv_ps)?; // [1,8,6144]
            // q / k: head views of the projection rows (no reshape copies —
            // draft_norm_rope honours the row stride, as in the commit)
            let heads = qkv.reshape((ROWS, QKV / HEAD_DIM, HEAD_DIM))?;
            let q = heads.narrow(1, 0, HEADS)?;
            let k = heads.narrow(1, HEADS, KV_HEADS)?;
            let v = qkv
                .narrow(2, ATTN + KV_HEADS * HEAD_DIM, KV_HEADS * HEAD_DIM)?
                .reshape((ROWS, KV_HEADS, HEAD_DIM))?;
            crate::gpuprof::region("qknorm_rope");
            let q = dnorm_rope(&q, &l.q_norm, &cos, &sin)?;
            let k = dnorm_rope(&k, &l.k_norm, &cos, &sin)?;
            crate::gpuprof::region("attn");
            let attn = self.attention(ctx, li, &q, &k, &v)?;
            crate::gpuprof::region("o");
            let proj = lin_apply(&attn, &l.o_proj)?; // [1,8,5120]
            crate::gpuprof::region("dconv");
            let x2 = dconv(&proj, &dyn_, &l.conv_base, 1, Some(&x))?;
            crate::gpuprof::region("norm.post");
            let (n2, n2_ps) = rms_norm_ps(&x2, &l.post_norm, 0, ROWS)?;
            crate::gpuprof::region("dyn");
            let dyn2 = lin_apply_ps(&n2, &l.mlp_dyn, n2_ps)?;
            crate::gpuprof::region("dconv");
            let conv2 = dconv(&n2, &dyn2, &l.mlp_conv_base, 0, None)?;
            let proj2 = l.mlp(&conv2)?;
            crate::gpuprof::region("dconv");
            x = dconv(&proj2, &dyn2, &l.mlp_conv_base, 1, Some(&x2))?;
        }
        crate::gpuprof::region("norm.final");
        // only rows 1..7 feed the proposal — row 0 is the anchor and
        // its logits/selector outputs are never read: norm just those
        // (a 7-row presum block when `draft_ps`: lm_head binds it with no
        // pad copy, the selector takes the PreSums tile)
        let (fh7, fh_ps) = rms_norm_ps(&x, &self.final_norm, 1, PROPOSALS)?; // [1,7,5120]
        crate::gpuprof::region("lm_head");
        let logits = lin_apply_ps(&fh7, lm_head, fh_ps)?.squeeze(0)?; // [7, vocab]
        crate::gpuprof::region("selector");
        let sel = lin_apply_ps(&fh7, &self.selector, fh_ps)?.squeeze(0)?; // [7, 256]
        crate::gpuprof::region("select");
        self.select(&logits, &sel, anchor, temp, &mut uniform)
    }

    /// Attention for one draft layer: 8 query rows (32 heads) over the
    /// committed ring plus all 8 current rows' K/V — the current block
    /// attends bidirectionally (DFlash block decoding is not causal).
    fn attention(
        &self,
        ctx: &Draft,
        layer: usize,
        q: &Tensor, // [8, 32, 128]
        k: &Tensor, // [8, 8, 128]
        v: &Tensor, // [8, 8, 128]
    ) -> Result<Tensor> {
        let l = ctx.ring_len.min(WINDOW);
        // live window: positions len-l..len → slots mod 2048
        let start = ctx.ring_len - l;
        let dev = &self.device;
        // MEM-4: the fused kernel reads the ring in place (slots start..
        // mod 2048) — no host id list, no id upload (a fresh MTLBuffer per
        // call), no [8, l, 128] K/V gathers; those were built before this
        // early return and discarded (4 MiB each at l = 2048).
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if dev.is_metal() && !draft_eager() {
            // draft_attn returns [8, 32, 128]; o_proj needs the eager
            // path's [1, 8, 4096] — a rank-4 [1, 8, 32, 128] reads as
            // 256 rows x 128 and sends o_proj (inp 4096) down the m=256
            // prefill kernel, over-reading 2 MiB past this 64 KiB buffer.
            return Ok(crate::draft_kernel::draft_attn(
                q,
                &ctx.ring_k[layer],
                &ctx.ring_v[layer],
                k,
                v,
                l,
                start % WINDOW,
            )?
            .reshape((1, ROWS, ATTN))?);
        }
        // eager path only: gather the live window on-device
        let (kr, vr) = if l == 0 {
            (
                Tensor::zeros((KV_HEADS, 0, HEAD_DIM), DType::BF16, dev)?,
                Tensor::zeros((KV_HEADS, 0, HEAD_DIM), DType::BF16, dev)?,
            )
        } else {
            let ids: Vec<u32> =
                (start..ctx.ring_len).map(|p| (p % WINDOW) as u32).collect();
            let idx = Tensor::new(ids.as_slice(), dev)?;
            (
                ctx.ring_k[layer].index_select(&idx, 1)?,
                ctx.ring_v[layer].index_select(&idx, 1)?,
            )
        };
        let kr = gqa_expand(&kr)?;
        let vr = gqa_expand(&vr)?;
        let kc = gqa_expand(&k.permute((1, 0, 2))?)?; // [8,8,128]→[32,8,128]
        let vc = gqa_expand(&v.permute((1, 0, 2))?)?;
        let kall = Tensor::cat(&[&kr, &kc], 1)?.contiguous()?; // [32, l+8, 128]
        let vall = Tensor::cat(&[&vr, &vc], 1)?.contiguous()?;
        let qh = q.permute((1, 0, 2))?.contiguous()?; // [32, 8, 128]
        let scores = qh
            .matmul(&kall.transpose(1, 2)?.contiguous()?)?
            .affine(INV_SQRT_D, 0.0)?;
        let attn = candle_nn::ops::softmax_last_dim(&scores)?;
        let out = attn.matmul(&vall)?; // [32, 8, 128]
        out.permute((1, 0, 2))?
            .reshape((1, ROWS, ATTN))
            .map_err(Into::into)
    }

    /// Chain the 7-token proposal: top-16 unary per position from logits
    /// rows 1..7, codebook edge scores conditioned on selector hidden
    /// rows 1..7, then greedy or softmax-sampled walk.
    fn select(
        &self,
        logits: &Tensor,  // [8, vocab]
        sel: &Tensor,     // [8, 256]
        anchor: u32,
        temp: Option<f64>,
        uniform: &mut dyn FnMut() -> f64,
    ) -> Result<Proposal> {
        let (unary_all, cand_all, sel_all) =
            Self::cand_tables(logits, sel)?;
        let (pred_ids, succ_ids) = Self::codebook_ids(anchor, &cand_all);
        let pred_all = gather_cb(&self.pred_cb, &pred_ids)?;
        let succ_all = gather_cb(&self.succ_cb, &succ_ids)?;
        self.select_walk(
            &unary_all, &cand_all, &sel_all,
            &pred_all, &succ_all, temp, uniform,
        )
    }

    /// Candidate tables for `logits`/`sel` `[n, vocab]`/`[n, 256]` —
    /// the GPU sort + readback runs once over all n rows (batched
    /// propose passes all slots' rows in one call).
    /// Returns (unary[n][16], cand[n][16], sel_h[n][256]).
    fn cand_tables(
        logits: &Tensor,
        sel: &Tensor,
    ) -> Result<(Vec<Vec<f32>>, Vec<Vec<u32>>, Vec<Vec<f32>>)> {
        let n = logits.dim(0)?;
        // Top-16 per row. Metal's full-width asort is broken at
        // ncols=248320, so sort 485 chunks of 512 instead — the global
        // top-16 is always contained in the union of per-chunk top-16s
        // (any globally-top-16 element has at most 15 superiors within
        // its own chunk). Chunked sort on GPU, 7760-candidate merge on
        // CPU.
        const CHUNKS: usize = CB_ROWS / CHUNK_W;
        const CHUNK_W: usize = 512;
        // D1: ONE host sync for everything the walk needs — per-chunk
        // top-16 values, their in-chunk ids (u32 < 512, exact in f32) and
        // the selector rows, packed into one f32 buffer and read back
        // together (was three separate readbacks, each a commit + wait).
        let nk = n * CHUNKS * TOPK;
        let packed: Vec<f32> = match Self::cand_packed_fused(logits, sel, n)? {
            Some(p) => p,
            None => Self::cand_packed_sort(logits, sel, n)?,
        };
        if packed.len() != 2 * nk + n * RANK {
            bail!("cand_tables: packed readback {} != {}", packed.len(), 2 * nk + n * RANK);
        }
        let (cv, rest) = packed.split_at(nk); // [n*485*16]
        let (ci, sh) = rest.split_at(nk);
        let mut unary: Vec<Vec<f32>> = Vec::with_capacity(n);
        let mut cand: Vec<Vec<u32>> = Vec::with_capacity(n);
        for r in 0..n {
            // merge 485 chunk top-16s → global top-16 for row r
            let mut pool: Vec<(f32, u32)> = Vec::with_capacity(CHUNKS * TOPK);
            for c in 0..CHUNKS {
                let row = (r * CHUNKS + c) * TOPK;
                for k in 0..TOPK {
                    pool.push((cv[row + k], c as u32 * CHUNK_W as u32 + ci[row + k] as u32));
                }
            }
            pool.select_nth_unstable_by(TOPK - 1, |a, b| b.0.total_cmp(&a.0));
            let mut top = pool[..TOPK].to_vec();
            top.sort_by(|a, b| b.0.total_cmp(&a.0));
            unary.push(top.iter().map(|t| t.0).collect());
            cand.push(top.iter().map(|t| t.1).collect());
        }
        let sel_h: Vec<Vec<f32>> = sh.chunks_exact(RANK).map(|c| c.to_vec()).collect(); // [n, 256]
        Ok((unary, cand, sel_h))
    }

    /// The packed `[top-16 values | ids | selector]` vector via candle ops:
    /// f32 cast, per-chunk descending sort, narrows, casts, one cat.
    fn cand_packed_sort(logits: &Tensor, sel: &Tensor, n: usize) -> Result<Vec<f32>> {
        const CHUNK_W: usize = 512;
        const CHUNKS: usize = CB_ROWS / CHUNK_W;
        let cand_rows = logits.contiguous()?.to_dtype(DType::F32)?; // [n, 248320]
        let chunked = cand_rows.reshape((n, CHUNKS, CHUNK_W))?;
        let (vals, ids) = chunked.sort_last_dim(false)?; // desc per chunk
        let top_v = vals.narrow(2, 0, TOPK)?.contiguous()?.flatten_all()?;
        let top_i = ids
            .narrow(2, 0, TOPK)?
            .contiguous()?
            .flatten_all()?
            .to_dtype(DType::F32)?;
        let sel_f = sel.to_dtype(DType::F32)?.flatten_all()?;
        Ok(Tensor::cat(&[&top_v, &top_i, &sel_f], 0)?.to_vec1()?)
    }

    /// The packed `[top-16 values | ids | selector]` vector in one Metal
    /// dispatch (`quant_kernel::ChunkTop16`: candle's exact bitonic network
    /// over a threadgroup copy — bit-identical to the sort path, which R0c
    /// measured at 656 us/round). `None` off Metal, for non-bf16 inputs, or
    /// with `TH_CAND_SORT=legacy` (read once) — the caller sorts.
    fn cand_packed_fused(logits: &Tensor, sel: &Tensor, n: usize) -> Result<Option<Vec<f32>>> {
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if logits.device().is_metal()
            && logits.dtype() == DType::BF16
            && sel.dtype() == DType::BF16
            && !cand_sort_legacy()
        {
            let lg = logits.contiguous()?;
            let sl = sel.contiguous()?;
            let op = crate::quant_kernel::ChunkTop16 { n, chunks: CB_ROWS / 512, rank: RANK };
            return Ok(Some(lg.apply_op2_no_bwd(&sl, &op)?.to_vec1()?));
        }
        let _ = (logits, sel, n);
        Ok(None)
    }

    /// Codebook rows needed by the walk: pred rows for
    /// `{anchor} ∪ cand[0..6]` and succ rows for `cand[0..6]`.
    /// Batched so callers can gather across slots in one shot.
    fn codebook_ids(anchor: u32, cand: &[Vec<u32>]) -> (Vec<u32>, Vec<u32>) {
        let mut pred_ids: Vec<u32> = Vec::with_capacity(1 + 6 * TOPK);
        pred_ids.push(anchor);
        for p in 0..PROPOSALS - 1 {
            pred_ids.extend_from_slice(&cand[p]);
        }
        let mut succ_ids: Vec<u32> = Vec::with_capacity(PROPOSALS * TOPK);
        for p in 0..PROPOSALS {
            succ_ids.extend_from_slice(&cand[p]);
        }
        (pred_ids, succ_ids)
    }

    /// Per-slot walk over precomputed tables: `unary`/`cand`/`sel_h`
    /// are this slot's `n` rows (PROPOSALS each); `pred_all`/`succ_all`
    /// are this slot's codebook rows in `codebook_ids` order.
    fn select_walk(
        &self,
        unary: &[Vec<f32>],
        cand: &[Vec<u32>],
        sel_h: &[Vec<f32>],
        pred_all: &[Vec<f32>],
        succ_all: &[Vec<f32>],
        temp: Option<f64>,
        uniform: &mut dyn FnMut() -> f64,
    ) -> Result<Proposal> {
        let mut tokens = [0u32; PROPOSALS];
        let mut cand_ids = [[0u32; TOPK]; PROPOSALS];
        let mut cand_probs = [[0f32; TOPK]; PROPOSALS];
        let mut pred_idx = 0usize;
        for p in 0..PROPOSALS {
            for i in 0..TOPK {
                cand_ids[p][i] = cand[p][i];
            }
            // predecessors: anchor for p=0 else position p-1's top-16
            let npreds = if p == 0 { 1 } else { TOPK };
            let pred_rows: &[Vec<f32>] = if p == 0 {
                &pred_all[..1]
            } else {
                &pred_all[1 + (p - 1) * TOPK..1 + p * TOPK]
            };
            let succ_rows: &[Vec<f32>] =
                &succ_all[p * TOPK..(p + 1) * TOPK];
            // edge[j][i] = (pred_cb[preds[j]] ⊙ h) · succ_cb[cand_i]
            let h = &sel_h[p];
            let mut edges = vec![vec![0f32; TOPK]; npreds];
            for (j, ctx) in pred_rows.iter().enumerate() {
                for (i, succ) in succ_rows.iter().enumerate() {
                    let mut acc = 0f32;
                    for d in 0..RANK {
                        acc += ctx[d] * h[d] * succ[d];
                    }
                    edges[j][i] = acc;
                }
            }
            // corrected scores + selection
            let t = temp.unwrap_or(1.0) as f32;
            let mut best = (0usize, f32::NEG_INFINITY);
            let mut logits_p = [0f32; TOPK];
            for i in 0..TOPK {
                logits_p[i] = unary[p][i] + edges[pred_idx][i];
                if logits_p[i] > best.1 {
                    best = (i, logits_p[i]);
                }
            }
            let sel_i = match temp {
                None => best.0,
                Some(_) => {
                    let mx = logits_p.iter().fold(f32::NEG_INFINITY, |a, &b| a.max(b));
                    let mut sum = 0f32;
                    for i in 0..TOPK {
                        cand_probs[p][i] = ((logits_p[i] - mx) / t).exp();
                        sum += cand_probs[p][i];
                    }
                    let u = uniform();
                    let mut cum = 0f32;
                    let mut pick = TOPK - 1;
                    for i in 0..TOPK {
                        cand_probs[p][i] /= sum;
                        cum += cand_probs[p][i];
                        if pick == TOPK - 1 && cum > u as f32 {
                            pick = i;
                        }
                    }
                    pick
                }
            };
            tokens[p] = cand_ids[p][sel_i];
            pred_idx = sel_i;
        }
        Ok(Proposal {
            tokens,
            cand_ids,
            cand_probs,
        })
    }

    /// Batched proposal: one draft forward over every slot's
    /// `[anchor, mask×7]` block. Rows are slot-aligned blocks of 8 —
    /// `[B·8, 5120]` activations; per-slot state is confined to the
    /// attention rings and the rope tables (positions differ).
    pub fn propose_batch(
        &self,
        ctxs: &mut [&mut Draft],
        embed: &Tensor,
        lm_head: &Lin,
        anchors: &[u32],
        poss: &[usize],
        temps: &[Option<f64>],
        uniform: &mut dyn FnMut(usize) -> f64,
    ) -> Result<Vec<Proposal>> {
        let nb = ctxs.len();
        // ids: per slot — [anchor_b, mask×7]
        let ids: Vec<u32> = anchors
            .iter()
            .flat_map(|a| {
                std::iter::once(*a)
                    .chain(std::iter::repeat(MASK_TOKEN).take(PROPOSALS))
            })
            .collect();
        let mut x = embed
            .i(&Tensor::new(ids.as_slice(), &self.device)?)?
            .unsqueeze(0)?; // [1, B*8, 5120]
        // per-slot rope tables concatenated — row r uses poss[r/8] + r%8
        let mut cos_v = Vec::with_capacity(nb * ROWS * HEAD_DIM / 2);
        let mut sin_v = Vec::with_capacity(nb * ROWS * HEAD_DIM / 2);
        for b in 0..nb {
            for r in 0..ROWS {
                let p = (poss[b] + r) as f64;
                for i in 0..HEAD_DIM / 2 {
                    let f = THETA.powf(-(2.0 * i as f64) / HEAD_DIM as f64);
                    cos_v.push((p * f).cos() as f32);
                    sin_v.push((p * f).sin() as f32);
                }
            }
        }
        let cos = Tensor::from_vec(cos_v, (nb * ROWS, HEAD_DIM / 2), &self.device)?;
        let sin = Tensor::from_vec(sin_v, (nb * ROWS, HEAD_DIM / 2), &self.device)?;
        for (li, l) in self.layers.iter().enumerate() {
            let n = rms_norm(&x, &l.input_norm, 1e-6)?; // [1,B*8,5120]
            let dyn_ = lin_apply(&n, &l.attn_dyn)?; // [1,B*8,1280]
            let conv = dconv(&n, &dyn_, &l.conv_base, 0, None)?;
            let qkv = lin_apply(&conv, &l.qkv)?; // [1,B*8,6144]
            let q = qkv
                .narrow(2, 0, ATTN)?
                .reshape((nb * ROWS, HEADS, HEAD_DIM))?;
            let k = qkv
                .narrow(2, ATTN, KV_HEADS * HEAD_DIM)?
                .reshape((nb * ROWS, KV_HEADS, HEAD_DIM))?;
            let v = qkv
                .narrow(2, ATTN + KV_HEADS * HEAD_DIM, KV_HEADS * HEAD_DIM)?
                .reshape((nb * ROWS, KV_HEADS, HEAD_DIM))?;
            let q = dnorm_rope(&q, &l.q_norm, &cos, &sin)?;
            let k = dnorm_rope(&k, &l.k_norm, &cos, &sin)?;
            // per-slot attention (own ring); concat the row-blocks back
            let mut attns = Vec::with_capacity(nb);
            for (b, ctx) in ctxs.iter().enumerate() {
                let qs = q.narrow(0, b * ROWS, ROWS)?;
                let ks = k.narrow(0, b * ROWS, ROWS)?;
                let vs = v.narrow(0, b * ROWS, ROWS)?;
                attns.push(self.attention(ctx, li, &qs, &ks, &vs)?);
            }
            let attn = Tensor::cat(&attns, 1)?; // [1, B*8, 5120]
            let proj = lin_apply(&attn, &l.o_proj)?;
            let x2 = dconv(&proj, &dyn_, &l.conv_base, 1, Some(&x))?;
            let n2 = rms_norm(&x2, &l.post_norm, 1e-6)?;
            let dyn2 = lin_apply(&n2, &l.mlp_dyn)?;
            let conv2 = dconv(&n2, &dyn2, &l.mlp_conv_base, 0, None)?;
            let proj2 = l.mlp(&conv2)?; // [1,B*8,5120]
            x = dconv(&proj2, &dyn2, &l.mlp_conv_base, 1, Some(&x2))?;
        }
        let fh = rms_norm(&x, &self.final_norm, 1e-6)?; // [1,B*8,5120]
        // per-slot proposal rows: b*8+1 .. b*8+8 (anchor rows unused)
        let mut logits = Vec::with_capacity(nb);
        let mut sels = Vec::with_capacity(nb);
        for b in 0..nb {
            logits.push(fh.narrow(1, b * ROWS + 1, PROPOSALS)?);
            sels.push(fh.narrow(1, b * ROWS + 1, PROPOSALS)?);
        }
        let logits = Tensor::cat(&logits, 1)?;  // [1, B*7, 5120]
        let sels = Tensor::cat(&sels, 1)?;
        let logits = lin_apply(&logits, lm_head)?.squeeze(0)?; // [B*7, vocab]
        let sel = lin_apply(&sels, &self.selector)?.squeeze(0)?; // [B*7, 256]
        let dbg = debug_timing();
        let t_ct = std::time::Instant::now();
        // one GPU sort + readback across all slots' rows
        let (unary, cand, sel_h) = Self::cand_tables(&logits, &sel)?;
        // one codebook gather across all slots: ids are slot-major
        // (slot b's pred block = b*97 rows; succ = b*112)
        let mut pred_ids: Vec<u32> = Vec::with_capacity(nb * (1 + 6 * TOPK));
        let mut succ_ids: Vec<u32> = Vec::with_capacity(nb * PROPOSALS * TOPK);
        for b in 0..nb {
            let (pi, si) = Self::codebook_ids(
                anchors[b],
                &cand[b * PROPOSALS..(b + 1) * PROPOSALS],
            );
            pred_ids.extend_from_slice(&pi);
            succ_ids.extend_from_slice(&si);
        }
        let pred_all = gather_cb(&self.pred_cb, &pred_ids)?;
        let succ_all = gather_cb(&self.succ_cb, &succ_ids)?;
        if dbg {
            eprintln!("    [pb] cand_tables={:.1}ms", t_ct.elapsed().as_secs_f64()*1e3);
        }
        let t_w = std::time::Instant::now();
        let mut out = Vec::with_capacity(nb);
        for b in 0..nb {
            let (r0, r1) = (b * PROPOSALS, (b + 1) * PROPOSALS);
            let (p0, p1) = (b * (1 + 6 * TOPK), (b + 1) * (1 + 6 * TOPK));
            let (s0, s1) = (b * PROPOSALS * TOPK, (b + 1) * PROPOSALS * TOPK);
            let temp = temps[b];
            out.push(self.select_walk(
                &unary[r0..r1], &cand[r0..r1], &sel_h[r0..r1],
                &pred_all[p0..p1], &succ_all[s0..s1],
                temp, &mut || uniform(b),
            )?);
        }
        if dbg {
            eprintln!("    [pb] walks={:.1}ms", t_w.elapsed().as_secs_f64()*1e3);
        }
        Ok(out)
    }
}

/// D1: codebook rows for `ids` from the host-resident table, as f32.
fn gather_cb(cb: &[bf16], ids: &[u32]) -> Result<Vec<Vec<f32>>> {
    ids.iter()
        .map(|&id| {
            let o = id as usize * RANK;
            let row = cb
                .get(o..o + RANK)
                .with_context(|| format!("codebook id {id} out of range"))?;
            Ok(row.iter().map(|v| v.to_f32()).collect())
        })
        .collect()
}

// MARK: - ops

/// GQA head expansion: [kv_heads, l, d] → [heads, l, d] — query head h
/// pairs with KV head h / (HEADS/KV_HEADS).
fn gqa_expand(t: &Tensor) -> Result<Tensor> {
    const R: usize = HEADS / KV_HEADS;
    let (h, l, d) = t.dims3()?;
    t.unsqueeze(1)?
        .broadcast_as((h, R, l, d))?
        .contiguous()?
        .reshape((h * R, l, d))
        .map_err(Into::into)
}

/// Dynamic causal conv within the 8-row block: two taps (current + prev
/// row, zero-padded), base taps [stage*2+t][ch] plus per-16-channel-group
/// dynamic taps from `dyn_` [.., 1280] (stage*640 + t*320 + group).
/// `finish` adds the residual row.
fn draft_conv(
    x: &Tensor,        // [1, 8, 5120]
    dyn_: &Tensor,     // [1, 8, 1280]
    base: &Tensor,     // [4, 5120]
    stage: usize,
    residual: Option<&Tensor>,
) -> Result<Tensor> {
    const G: usize = HIDDEN / 16; // 320 groups
    let expand = |t: Tensor| -> Result<Tensor> {
        // [1, 8, 320] groups → [1, 8, 5120] channels (16 ch per group)
        t.unsqueeze(3)?
            .broadcast_as((1, ROWS, G, 16))?
            .contiguous()?
            .reshape((1, ROWS, HIDDEN))
            .map_err(Into::into)
    };
    let t0 = expand(dyn_.narrow(2, stage * 640, G)?)?
        .broadcast_add(&base.i(stage * 2)?.reshape((1, 1, HIDDEN))?)?;
    let t1 = expand(dyn_.narrow(2, stage * 640 + G, G)?)?
        .broadcast_add(&base.i(stage * 2 + 1)?.reshape((1, 1, HIDDEN))?)?;
    let zero = Tensor::zeros((1, 1, HIDDEN), DType::BF16, x.device())?;
    let prev = Tensor::cat(&[&zero, &x.narrow(1, 0, ROWS - 1)?], 1)?;
    let mut out = x.mul(&t0)?.add(&prev.mul(&t1)?)?;
    if let Some(r) = residual {
        out = out.add(r)?;
    }
    Ok(out)
}

/// Per-head RMSNorm (eps 1e-6) then NeoX-style RoPE (pairs i, i+64) on
/// [rows, heads, 128] with per-row cos/sin [rows, 64].
fn head_norm_rope(
    x: &Tensor,   // [rows, heads, 128]
    w: &Tensor,   // [128]
    cos: &Tensor, // [rows, 64] f32
    sin: &Tensor,
) -> Result<Tensor> {
    let (rows, heads) = (x.dim(0)?, x.dim(1)?);
    let n = candle_nn::ops::rms_norm(x, w, 1e-6)?; // normalises last dim
    let x1 = n.narrow(2, 0, HEAD_DIM / 2)?;
    let x2 = n.narrow(2, HEAD_DIM / 2, HEAD_DIM / 2)?;
    let c = cos.to_dtype(DType::BF16)?.reshape((rows, 1, HEAD_DIM / 2))?;
    let s = sin.to_dtype(DType::BF16)?.reshape((rows, 1, HEAD_DIM / 2))?;
    let r1 = x1.broadcast_mul(&c)?.sub(&x2.broadcast_mul(&s)?)?;
    let r2 = x1.broadcast_mul(&s)?.add(&x2.broadcast_mul(&c)?)?;
    let _ = heads;
    Tensor::cat(&[&r1, &r2], 2).map_err(Into::into)
}

/// cos/sin rows for positions `start..start+rows` — theta 1e7, 64
/// frequencies (head_dim 128, non-interleaved).
fn rope_table(
    device: &Device,
    start: usize,
    rows: usize,
) -> Result<(Tensor, Tensor)> {
    let mut cos = vec![0f32; rows * HEAD_DIM / 2];
    let mut sin = vec![0f32; rows * HEAD_DIM / 2];
    for r in 0..rows {
        let p = (start + r) as f64;
        for i in 0..HEAD_DIM / 2 {
            let f = THETA.powf(-(2.0 * i as f64) / HEAD_DIM as f64);
            cos[r * HEAD_DIM / 2 + i] = (p * f).cos() as f32;
            sin[r * HEAD_DIM / 2 + i] = (p * f).sin() as f32;
        }
    }
    Ok((
        Tensor::from_vec(cos, (rows, HEAD_DIM / 2), device)?,
        Tensor::from_vec(sin, (rows, HEAD_DIM / 2), device)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// repack_q4 must be a pure layout permutation: Splash stores
    /// [tile=out/256][group][row%256] blocks, ours is [row][group].
    /// Fill the packed section with byte-index counters and check the
    /// mapping directly against the dequantised values.
    #[test]
    fn repack_q4_is_a_pure_permutation() {
        let (out, inp) = (512usize, 128usize); // 2 tiles x 2 groups
        let wbytes = out * inp / 2;
        let pbytes = out * inp / 32;
        let mut sec = vec![0u8; wbytes + 2 * pbytes];
        for (i, b) in sec.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        let q = repack_q4(&sec, out, inp, &Device::Cpu).unwrap();
        let wq: Vec<u32> = q.wq.flatten_all().unwrap().to_vec1().unwrap();
        let sb: Vec<bf16> = q.sb.flatten_all().unwrap().to_vec1().unwrap();
        let ng = inp / 64;
        // spot-check a spread of (row, group) cells
        for &(r, g) in &[(0, 0), (0, 1), (255, 0), (256, 1), (511, 1)] {
            let (tile, rr) = (r / 256, r % 256);
            // weights: 32 packed bytes at [tile][g][rr]
            let src = tile * ng * 256 * 32 + (g * 256 + rr) * 32;
            let dst = (r * ng + g) * 8; // u32 words: 32 bytes
            let w0 = u32::from_le_bytes(
                sec[src..src + 4].try_into().unwrap(),
            );
            assert_eq!(wq[dst], w0, "weight word mismatch at r{r} g{g}");
            // scale at [tile][g][rr] in the params section
            let sp = wbytes + ((tile * ng + g) * 256 + rr) * 2;
            let sval = bf16::from_le_bytes([sec[sp], sec[sp + 1]]);
            assert_eq!(sb[r * 2 * ng + g], sval, "scale at r{r} g{g}");
            // bias
            let bp = wbytes + pbytes + ((tile * ng + g) * 256 + rr) * 2;
            let bval = bf16::from_le_bytes([sec[bp], sec[bp + 1]]);
            assert_eq!(
                sb[r * 2 * ng + ng + g],
                bval,
                "bias at r{r} g{g}"
            );
        }
    }

    /// D1: the single packed readback must reproduce the per-row global
    /// top-16 (values descending, exact ids) and the selector rows.
    #[test]
    fn cand_tables_packed_readback_is_exact() {
        let n = 3usize;
        // distinct values per row: a stride-7919 permutation of 0..CB_ROWS
        let logits: Vec<f32> = (0..n)
            .flat_map(|r| (0..CB_ROWS).map(move |j| ((j * 7919 + r * 13) % CB_ROWS) as f32 * 1e-3))
            .collect();
        let sel: Vec<f32> = (0..n * RANK).map(|i| (i as f32 * 0.37).sin()).collect();
        let lt = Tensor::from_vec(logits.clone(), (n, CB_ROWS), &Device::Cpu).unwrap();
        let st = Tensor::from_vec(sel.clone(), (n, RANK), &Device::Cpu).unwrap();
        let (unary, cand, sel_h) = DraftWeights::cand_tables(&lt, &st).unwrap();
        for r in 0..n {
            let row = &logits[r * CB_ROWS..(r + 1) * CB_ROWS];
            let mut idx: Vec<u32> = (0..CB_ROWS as u32).collect();
            idx.sort_by(|&a, &b| row[b as usize].total_cmp(&row[a as usize]));
            let want_ids: Vec<u32> = idx[..TOPK].to_vec();
            let want_v: Vec<f32> = want_ids.iter().map(|&i| row[i as usize]).collect();
            assert_eq!(cand[r], want_ids, "row {r} ids");
            assert_eq!(unary[r], want_v, "row {r} values");
            assert_eq!(sel_h[r], sel[r * RANK..(r + 1) * RANK].to_vec(), "row {r} selector");
        }
    }

    /// The fused Metal top-16 (candle's bitonic network over a threadgroup
    /// copy) reproduces the sort path's packed vector bit for bit —
    /// including the tie order: logits are drawn from 24 bf16 levels, so
    /// every 512-chunk is full of equal values.
    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn cand_packed_fused_matches_sort_bitwise() {
        let dev = Device::new_metal(0).unwrap();
        for &(n, levels) in &[(1usize, 24usize), (3, 24), (7, 3), (7, 4096)] {
            let mut seed = 0x9e3779b97f4a7c15u64 ^ (n as u64 * 131 + levels as u64);
            let mut next = || {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                (seed >> 33) as usize
            };
            let logits: Vec<f32> = (0..n * CB_ROWS)
                .map(|_| (next() % levels) as f32 * 0.125 - 1.5)
                .collect();
            let sel: Vec<f32> = (0..n * RANK).map(|i| (i as f32 * 0.37).sin()).collect();
            let lt = Tensor::from_vec(logits, (n, CB_ROWS), &dev).unwrap().to_dtype(DType::BF16).unwrap();
            let st = Tensor::from_vec(sel, (n, RANK), &dev).unwrap().to_dtype(DType::BF16).unwrap();
            let fused = DraftWeights::cand_packed_fused(&lt, &st, n).unwrap().expect("metal path");
            let sorted = DraftWeights::cand_packed_sort(&lt, &st, n).unwrap();
            assert_eq!(fused.len(), sorted.len(), "n {n} levels {levels}: length");
            let diff = fused.iter().zip(&sorted).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
            assert_eq!(diff, 0, "n {n} levels {levels}: {diff} of {} entries differ", fused.len());
        }
    }

    #[cfg(all(feature = "metal", target_os = "macos"))]
    fn host_ring(seed: &mut u64) -> Vec<f32> {
        (0..KV_HEADS * WINDOW * HEAD_DIM)
            .map(|_| {
                *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                ((*seed >> 33) as f32 / (1u64 << 31) as f32) * 4.0 - 2.0
            })
            .collect()
    }

    /// The fused commit ring write (head views + one draft_ring_write)
    /// leaves the K/V rings byte-identical to the legacy reshape + permute
    /// + index upload + scatter_set path, including a slot wrap-around.
    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn ring_write_matches_scatter_bitwise() {
        let dev = Device::new_metal(0).unwrap();
        let mut seed = 0x2545f4914f6cdd1du64;
        let mut host = |n: usize| -> Vec<f32> {
            (0..n)
                .map(|_| {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    ((seed >> 33) as f32 / (1u64 << 31) as f32) * 4.0 - 2.0
                })
                .collect()
        };
        // NB: Tensor::copy() aliases the buffer on Metal (MetalStorage::
        // try_clone clones the Arc) — every ring below is built from host
        // data so the two paths write into distinct buffers.
        let dev_t = |v: &[f32]| Tensor::from_vec(v.to_vec(), v.len(), &dev).unwrap().to_dtype(DType::BF16).unwrap();
        let mut rnd = |n: usize| -> Tensor { dev_t(&host(n)) };
        let knorm = rnd(HEAD_DIM);
        let mut ring_seed = 0x9e3779b97f4a7c15u64;
        for &(rows, start) in &[(1usize, 0usize), (4, 17), (8, 2045), (3, 2047), (8, 777)] {
            let qkv = rnd(rows * QKV).reshape((rows, QKV)).unwrap();
            let hk = host_ring(&mut ring_seed);
            let hv = host_ring(&mut ring_seed);
            let ring = |h: &[f32]| dev_t(h).reshape((KV_HEADS, WINDOW, HEAD_DIM)).unwrap();
            let init_k = ring(&hk);
            let (cos, sin) = rope_table(&dev, start, rows).unwrap();
            // legacy
            let (lk, lv) = (ring(&hk), ring(&hv));
            let k = qkv.narrow(1, ATTN, KV_HEADS * HEAD_DIM).unwrap().reshape((rows, KV_HEADS, HEAD_DIM)).unwrap();
            let v = qkv
                .narrow(1, ATTN + KV_HEADS * HEAD_DIM, KV_HEADS * HEAD_DIM)
                .unwrap()
                .reshape((rows, KV_HEADS, HEAD_DIM))
                .unwrap();
            let k = dnorm_rope(&k, &knorm, &cos, &sin).unwrap();
            let kp = k.permute((1, 0, 2)).unwrap().contiguous().unwrap();
            let vp = v.permute((1, 0, 2)).unwrap().contiguous().unwrap();
            let slots: Vec<u32> = (0..rows).map(|r| ((start + r) % WINDOW) as u32).collect();
            let idx = Tensor::new(slots.as_slice(), &dev)
                .unwrap()
                .reshape((1, rows, 1))
                .unwrap()
                .broadcast_as((KV_HEADS, rows, HEAD_DIM))
                .unwrap()
                .contiguous()
                .unwrap();
            lk.scatter_set(&idx, &kp, 1).unwrap();
            lv.scatter_set(&idx, &vp, 1).unwrap();
            // fused
            let (fk, fv) = (ring(&hk), ring(&hv));
            let heads = qkv.reshape((rows, QKV / HEAD_DIM, HEAD_DIM)).unwrap();
            let k2 = heads.narrow(1, ATTN / HEAD_DIM, KV_HEADS).unwrap();
            let v2 = heads.narrow(1, ATTN / HEAD_DIM + KV_HEADS, KV_HEADS).unwrap();
            let k2 = dnorm_rope(&k2, &knorm, &cos, &sin).unwrap();
            crate::quant_kernel::draft_ring_write(&k2, &v2, &fk, &fv, start % WINDOW).unwrap();
            let bits = |t: &Tensor| -> Vec<u16> {
                t.flatten_all().unwrap().to_vec1::<bf16>().unwrap().iter().map(|x| x.to_bits()).collect()
            };
            assert_eq!(bits(&k), bits(&k2), "rows {rows} start {start}: normed k");
            let changed = bits(&lk).iter().zip(bits(&init_k)).filter(|(a, b)| **a != *b).count();
            assert!(changed > 0, "rows {rows} start {start}: legacy path wrote nothing");
            assert_eq!(bits(&lk), bits(&fk), "rows {rows} start {start}: ring k");
            assert_eq!(bits(&lv), bits(&fv), "rows {rows} start {start}: ring v");
        }
    }

    /// K45 follow-up: the draft presum producers. (1) `draft_rmsnorm_ps`
    /// rows are bit-identical to `candle_nn::ops::rms_norm` (8-row block,
    /// the 7-row final-norm block at row offset 1, the 2-D commit shape at
    /// rows 1/3/8) with zero padding rows; `draft_conv_ps` is bit-identical
    /// to `draft_conv_fused` (stage 0 plain, stage 1 with residual). (2) The
    /// blocks' input sums are what the tiles would compute: every draft
    /// projection shape fed the block (`presum: true`, PreSums split-K
    /// tiles / bind-only paired lm_head-class tile) equals the plain-input
    /// projection AND the projection of a `Q4AttachSums` block, bit for bit.
    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn draft_presum_producers_match_plain_bitwise() {
        let dev = Device::new_metal(0).unwrap();
        if !crate::quant_kernel::presum_enabled() {
            return;
        }
        let seed = std::cell::Cell::new(0x51ed2701f3a5c4b9u64);
        let next = || {
            let s = seed.get().wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            seed.set(s);
            (s >> 33) as u32
        };
        let host = |n: usize, lo: f32, hi: f32| -> Vec<f32> {
            (0..n).map(|_| lo + (next() as f32 / (1u64 << 31) as f32) * (hi - lo)).collect()
        };
        let bf = |v: Vec<f32>, shape: &[usize]| {
            Tensor::from_vec(v, shape, &dev).unwrap().to_dtype(DType::BF16).unwrap()
        };
        let bits = |t: &Tensor| -> Vec<u16> {
            t.flatten_all().unwrap().to_vec1::<bf16>().unwrap().iter().map(|x| x.to_bits()).collect()
        };
        // random tiled Q4 weights in the draft's projection shapes
        let qlin = |out: usize, inp: usize| -> Lin {
            let ng = inp / 64;
            let words: Vec<u32> = (0..out * inp / 8).map(|_| next() ^ (next() << 16)).collect();
            let mut sbv = vec![bf16::ZERO; out * 2 * ng];
            for o in 0..out {
                for g in 0..ng {
                    sbv[o * 2 * ng + g] = bf16::from_f32(0.002 + (next() % 1000) as f32 * 2e-5);
                    sbv[o * 2 * ng + ng + g] = bf16::from_f32(((next() % 2001) as f32 - 1000.0) * 1e-4);
                }
            }
            let wq = Tensor::from_vec(words, (out, inp / 8), &dev).unwrap();
            let sb = Tensor::from_vec(sbv, (out, 2 * ng), &dev).unwrap();
            crate::qwen35::maybe_tiled(Lin::Quant(QLin::new(wq, sb, out, inp, 64))).unwrap()
        };
        let dyn_w = qlin(DYN, HIDDEN);
        let qkv_w = qlin(QKV, HIDDEN);
        let sel_w = qlin(RANK, HIDDEN);
        let wide_w = qlin(40 * 4 * 256, HIDDEN); // paired-tile class (lm_head-like)
        let check_proj = |tag: &str, block: &Tensor, plain: &Tensor, w: &Lin| {
            let rows = plain.elem_count() / HIDDEN;
            let y_plain = lin_apply(plain, w).unwrap();
            let y_ps = lin_apply_ps(block, w, true).unwrap();
            let att = plain
                .reshape((rows, HIDDEN))
                .unwrap()
                .apply_op1_no_bwd(&crate::quant_kernel::Q4AttachSums { m: rows, inp: HIDDEN })
                .unwrap()
                .narrow(0, 0, rows)
                .unwrap();
            let y_att = lin_apply_ps(&att, w, true).unwrap();
            assert_eq!(bits(&y_ps), bits(&y_plain), "{tag}: block vs plain projection");
            assert_eq!(bits(&y_ps), bits(&y_att), "{tag}: block vs attach-sums projection");
        };
        let w_norm = bf(host(HIDDEN, 0.5, 1.5), &[HIDDEN]);
        for case in 0..3 {
            let x = bf(host(ROWS * HIDDEN, -3.0, 3.0), &[1, ROWS, HIDDEN]);
            // full 8-row block
            let plain = rms_norm(&x, &w_norm, 1e-6).unwrap();
            let blk = crate::quant_kernel::draft_rmsnorm_ps(&x, &w_norm, 1e-6, 0, ROWS).unwrap().expect("producer applies");
            assert_eq!(blk.dims(), &[1, ROWS, HIDDEN]);
            assert_eq!(bits(&blk), bits(&plain), "case {case}: rms_norm block values");
            check_proj(&format!("case {case} dyn"), &blk, &plain, &dyn_w);
            // final norm: rows 1..8 as a 7-row block (row 7 of the block zero)
            let p7 = plain.narrow(1, 1, PROPOSALS).unwrap().contiguous().unwrap();
            let b7 = crate::quant_kernel::draft_rmsnorm_ps(&x, &w_norm, 1e-6, 1, PROPOSALS).unwrap().expect("producer applies");
            assert_eq!(bits(&b7), bits(&p7), "case {case}: 7-row block values");
            check_proj(&format!("case {case} selector m=7"), &b7, &p7, &sel_w);
            check_proj(&format!("case {case} wide m=7"), &b7, &p7, &wide_w);
            // dconv: stage 0 (qkv input) and stage 1 with a residual
            let dy = bf(host(ROWS * DYN, -0.5, 0.5), &[1, ROWS, DYN]);
            let base = bf(host(4 * HIDDEN, -0.5, 0.5), &[4, HIDDEN]);
            let res = bf(host(ROWS * HIDDEN, -2.0, 2.0), &[1, ROWS, HIDDEN]);
            for (stage, r) in [(0usize, None), (1, Some(&res))] {
                let cp = crate::draft_kernel::draft_conv_fused(&blk, &dy, &base, r, stage).unwrap();
                let cb = crate::quant_kernel::draft_conv_ps(&blk, &dy, &base, r, stage).unwrap();
                assert_eq!(bits(&cb), bits(&cp), "case {case} stage {stage}: dconv block values");
                check_proj(&format!("case {case} stage {stage} qkv"), &cb, &cp, &qkv_w);
            }
            // 2-D commit shapes: [rows, 5120] at rows < 8 (the pad-copy case)
            for rows in [1usize, 3, 8] {
                let pr = bf(host(rows * HIDDEN, -3.0, 3.0), &[rows, HIDDEN]);
                let pl = rms_norm(&pr, &w_norm, 1e-6).unwrap();
                let (b2, is_blk) = rms_norm_ps(&pr, &w_norm, 0, rows).unwrap();
                assert!(is_blk, "rows {rows}: producer applies");
                assert_eq!(b2.dims(), &[rows, HIDDEN]);
                assert_eq!(bits(&b2), bits(&pl), "case {case} rows {rows}: 2-D block values");
                check_proj(&format!("case {case} commit qkv rows {rows}"), &b2, &pl, &qkv_w);
            }
        }
    }

    /// D1: host codebook gather = row slices of the row-major table.
    #[test]
    fn gather_cb_host_rows() {
        let cb: Vec<bf16> = (0..4 * RANK).map(|i| bf16::from_f32(i as f32)).collect();
        let g = gather_cb(&cb, &[2, 0, 3]).unwrap();
        assert_eq!(g.len(), 3);
        for (k, &id) in [2usize, 0, 3].iter().enumerate() {
            let want: Vec<f32> = (0..RANK).map(|d| bf16::from_f32((id * RANK + d) as f32).to_f32()).collect();
            assert_eq!(g[k], want);
        }
        assert!(gather_cb(&cb, &[4]).is_err(), "out-of-range id must error");
    }

}


/// `TH_DRAFT_EAGER` — eager draft ops instead of the fused kernels.
/// Read once: propose checks it ~35 times per round.
#[cfg_attr(not(all(feature = "metal", target_os = "macos")), allow(dead_code))]
/// Draft commit writes the K/V rings through `quant_kernel::
/// draft_ring_write` (one dispatch per layer, head views instead of
/// reshape copies). `TH_DRAFT_RING=legacy` restores the permute + index
/// upload + scatter_set path (A/B; ring contents are identical). Read once.
fn ring_fused() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_DRAFT_RING").as_deref() != Ok("legacy"))
}

/// `TH_CAND_SORT=legacy`: the candle sort path in `cand_tables` (A/B arm;
/// the fused top-16 kernel is bit-identical). Read once.
fn cand_sort_legacy() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_CAND_SORT").as_deref() == Ok("legacy"))
}

fn draft_eager() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("TH_DRAFT_EAGER").is_ok())
}

fn debug_timing() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("TH_DEBUG_TIMING").is_ok())
}

/// draft_conv on the fused kernel when possible; eager chain under
/// TH_DRAFT_EAGER / non-Metal.
fn dconv(
    x: &Tensor,
    dyn_: &Tensor,
    base: &Tensor,
    stage: usize,
    residual: Option<&Tensor>,
) -> Result<Tensor> {
    #[cfg(all(feature = "metal", target_os = "macos"))]
    if x.device().is_metal()
        && dyn_.is_contiguous()
        && x.stride().last() == Some(&1)
        && !draft_eager()
    {
        return Ok(crate::draft_kernel::draft_conv_fused(x, dyn_, base, residual, stage)?);
    }
    draft_conv(x, dyn_, base, stage, residual)
}

/// K45 follow-up (draft presum producers): the single-slot propose and
/// the decode-time commit hand the draft's m <= 8 projections (attn / mlp
/// dyn, qkv, lm_head, selector, commit qkv) K45 presum blocks from their
/// producers — `quant_kernel::draft_rmsnorm_ps` (candle's own rms_norm
/// instantiation + the input-sum epilogue) and `draft_conv_ps`
/// (`draft_conv_fused`'s expression + the epilogue) — so the split-K tiles
/// take their PreSums kernels and m < 8 inputs skip the pad copy. Values
/// are bit-identical. `TH_DRAFT_PS=0` (read once) restores plain inputs;
/// off whenever K45 presum blocks are (`TH_Q4_PRESUM=0`, legacy policy).
fn draft_ps() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        std::env::var("TH_DRAFT_PS").as_deref() != Ok("0")
            && crate::quant_kernel::presum_enabled()
    })
}

/// `rms_norm` of rows `row_off..row_off + t` of `x` (last dim = channels)
/// → `([1, t, c]` (or `[t, c]` for 2-D `x`), is-a-presum-block). Falls back
/// to `rms_norm` + narrow when the producer does not apply.
fn rms_norm_ps(x: &Tensor, w: &Tensor, row_off: usize, t: usize) -> Result<(Tensor, bool)> {
    #[cfg(all(feature = "metal", target_os = "macos"))]
    if x.device().is_metal() && draft_ps() && !draft_eager() && x.is_contiguous() {
        if let Some(b) = crate::quant_kernel::draft_rmsnorm_ps(x, w, 1e-6, row_off, t)? {
            let b = if x.rank() == 2 { b.squeeze(0)? } else { b };
            return Ok((b, true));
        }
    }
    let n = rms_norm(x, w, 1e-6)?;
    let rd = x.rank().saturating_sub(2);
    let n = if row_off == 0 && t == x.dim(rd)? { n } else { n.narrow(rd, row_off, t)?.contiguous()? };
    Ok((n, false))
}

/// `dconv` emitting a presum block (one 8-row draft block) when possible.
fn dconv_ps(
    x: &Tensor,
    dyn_: &Tensor,
    base: &Tensor,
    stage: usize,
    residual: Option<&Tensor>,
) -> Result<(Tensor, bool)> {
    #[cfg(all(feature = "metal", target_os = "macos"))]
    if x.device().is_metal()
        && draft_ps()
        && !draft_eager()
        && x.is_contiguous()
        && x.elem_count() == ROWS * HIDDEN
        && dyn_.is_contiguous()
    {
        return Ok((crate::quant_kernel::draft_conv_ps(x, dyn_, base, residual, stage)?, true));
    }
    Ok((dconv(x, dyn_, base, stage, residual)?, false))
}

/// head_norm_rope on the fused kernel when possible.
fn dnorm_rope(
    x: &Tensor,
    w: &Tensor,
    cos: &Tensor,
    sin: &Tensor,
) -> Result<Tensor> {
    #[cfg(all(feature = "metal", target_os = "macos"))]
    if x.device().is_metal()
        && x.stride().last() == Some(&1)
        && !draft_eager()
    {
        return Ok(crate::draft_kernel::draft_norm_rope(x, w, cos, sin)?);
    }
    // the eager chain's candle rms_norm needs contiguous rows (callers may
    // pass strided head views of the qkv projection)
    head_norm_rope(&x.contiguous()?, w, cos, sin)
}
