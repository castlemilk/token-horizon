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

use crate::qwen35::{lin_apply, rms_norm, Lin, QLin};

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

fn q4(f: &mut PackedFile, out: usize, inp: usize, device: &Device) -> Result<Lin> {
    let bytes = out * inp / 16 * 9;
    let sec = f.section(bytes)?;
    crate::qwen35::maybe_tiled(Lin::Quant(repack_q4(sec, out, inp, device)?))
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
    gate: Lin,             // [17408, 5120]
    up: Lin,               // [17408, 5120]
    down: Lin,             // [5120, 17408]
}

/// Shared draft weights — one instance regardless of batch width.
pub struct DraftWeights {
    layers: Vec<DraftLayer>,
    fc: Lin,            // [5120, 25600] context projection
    hidden_norm: Tensor,
    final_norm: Tensor,
    selector: Lin,      // [256, 5120]
    pred_cb: Tensor,    // [vocab, 256]
    succ_cb: Tensor,    // [vocab, 256]
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
                gate: q4(&mut f, INTER, HIDDEN, device)?,
                up: q4(&mut f, INTER, HIDDEN, device)?,
                down: q4(&mut f, HIDDEN, INTER, device)?,
            });
            f.finish()?;
        }
        let mut f = PackedFile::open(&dir.join("model.bin"), DRAFT_LAYERS as u32, 1)?;
        let fc = q4(&mut f, HIDDEN, TARGET_HIDDEN, device)?;
        let hidden_norm = norm(&mut f, HIDDEN, device)?;
        let final_norm = norm(&mut f, HIDDEN, device)?;
        let selector = q4(&mut f, RANK, HIDDEN, device)?;
        let cb_bytes = 248320 * RANK * 2;
        let pred_cb =
            section_tensor(f.section(cb_bytes)?, (248320, RANK), device)?;
        let succ_cb =
            section_tensor(f.section(cb_bytes)?, (248320, RANK), device)?;
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
        let proj = lin_apply(&captured.narrow(0, 0, rows)?.contiguous()?, &self.fc)?;
        let hidden = rms_norm(&proj, &self.hidden_norm, 1e-6)?; // [rows, 5120]
        let (cos, sin) = rope_table(&self.device, start_pos, rows)?;
        for (li, l) in self.layers.iter().enumerate() {
            let qkv = lin_apply(&hidden, &l.qkv)?; // [rows, 6144]
            let k = qkv
                .narrow(1, ATTN, KV_HEADS * HEAD_DIM)?
                .reshape((rows, KV_HEADS, HEAD_DIM))?;
            let v = qkv
                .narrow(1, ATTN + KV_HEADS * HEAD_DIM, KV_HEADS * HEAD_DIM)?
                .reshape((rows, KV_HEADS, HEAD_DIM))?;
            let k = dnorm_rope(&k, &l.k_norm, &cos, &sin)?;
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
        let mut x = embed
            .i(&Tensor::new(ids.as_slice(), &self.device)?)?
            .unsqueeze(0)?; // [1, 8, 5120]
        let (cos, sin) = rope_table(&self.device, pos, ROWS)?;
        for (li, l) in self.layers.iter().enumerate() {
            let n = rms_norm(&x, &l.input_norm, 1e-6)?; // [1,8,5120]
            let dyn_ = lin_apply(&n, &l.attn_dyn)?; // [1,8,1280]
            let conv = dconv(&n, &dyn_, &l.conv_base, 0, None)?;
            let qkv = lin_apply(&conv, &l.qkv)?; // [1,8,6144]
            let q = qkv
                .narrow(2, 0, ATTN)?
                .reshape((ROWS, HEADS, HEAD_DIM))?;
            let k = qkv
                .narrow(2, ATTN, KV_HEADS * HEAD_DIM)?
                .reshape((ROWS, KV_HEADS, HEAD_DIM))?;
            let v = qkv
                .narrow(2, ATTN + KV_HEADS * HEAD_DIM, KV_HEADS * HEAD_DIM)?
                .reshape((ROWS, KV_HEADS, HEAD_DIM))?;
            let q = dnorm_rope(&q, &l.q_norm, &cos, &sin)?;
            let k = dnorm_rope(&k, &l.k_norm, &cos, &sin)?;
            let attn = self.attention(ctx, li, &q, &k, &v)?;
            let proj = lin_apply(&attn, &l.o_proj)?; // [1,8,5120]
            let x2 = dconv(&proj, &dyn_, &l.conv_base, 1, Some(&x))?;
            let n2 = rms_norm(&x2, &l.post_norm, 1e-6)?;
            let dyn2 = lin_apply(&n2, &l.mlp_dyn)?;
            let conv2 = dconv(&n2, &dyn2, &l.mlp_conv_base, 0, None)?;
            let inter = candle_nn::ops::silu(&lin_apply(&conv2, &l.gate)?)?
                .mul(&lin_apply(&conv2, &l.up)?)?;
            let proj2 = lin_apply(&inter, &l.down)?;
            x = dconv(&proj2, &dyn2, &l.mlp_conv_base, 1, Some(&x2))?;
        }
        let fh = rms_norm(&x, &self.final_norm, 1e-6)?; // [1,8,5120]
        // only rows 1..7 feed the proposal — row 0 is the anchor and
        // its logits/selector outputs are never read.
        let fh7 = fh.narrow(1, 1, PROPOSALS)?.contiguous()?;
        let logits = lin_apply(&fh7, lm_head)?.squeeze(0)?; // [7, vocab]
        let sel = lin_apply(&fh7, &self.selector)?.squeeze(0)?; // [7, 256]
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
        // Gather the live window on-device: positions len-l..len →
        // slots mod 2048.
        let start = ctx.ring_len - l;
        let dev = &self.device;
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
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if dev.is_metal() && std::env::var("TH_DRAFT_EAGER").is_err() {
            return Ok(crate::draft_kernel::draft_attn(
                q,
                &ctx.ring_k[layer],
                &ctx.ring_v[layer],
                k,
                v,
                l,
                start % WINDOW,
            )?
            .unsqueeze(0)?);
        }
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
        // Top-16 per row. Metal's full-width asort is broken at
        // ncols=248320, so sort 485 chunks of 512 instead — the global
        // top-16 is always contained in the union of per-chunk top-16s
        // (any globally-top-16 element has at most 15 superiors within
        // its own chunk). Chunked sort on GPU, 7760-candidate merge on
        // CPU.
        const CHUNKS: usize = 485;
        const CHUNK_W: usize = 512;
        let cand_rows = logits
            .narrow(0, 0, PROPOSALS)?
            .contiguous()?
            .to_dtype(DType::F32)?; // [7, 248320]
        let chunked = cand_rows.reshape((PROPOSALS, CHUNKS, CHUNK_W))?;
        let (vals, ids) = chunked.sort_last_dim(false)?; // desc per chunk
        let cv = vals
            .narrow(2, 0, TOPK)?
            .contiguous()?
            .reshape(((), TOPK))?
            .to_vec2::<f32>()?; // [7*485, 16]
        let ci = ids
            .narrow(2, 0, TOPK)?
            .contiguous()?
            .reshape(((), TOPK))?
            .to_vec2::<u32>()?;
        let mut unary: Vec<Vec<f32>> = Vec::with_capacity(PROPOSALS);
        let mut cand: Vec<Vec<u32>> = Vec::with_capacity(PROPOSALS);
        for r in 0..PROPOSALS {
            // merge 485 chunk top-16s → global top-16 for row r
            let mut pool: Vec<(f32, u32)> = Vec::with_capacity(CHUNKS * TOPK);
            for c in 0..CHUNKS {
                let row = r * CHUNKS + c;
                for k in 0..TOPK {
                    pool.push((cv[row][k], c as u32 * CHUNK_W as u32 + ci[row][k]));
                }
            }
            pool.select_nth_unstable_by(TOPK - 1, |a, b| b.0.total_cmp(&a.0));
            let mut top = pool[..TOPK].to_vec();
            top.sort_by(|a, b| b.0.total_cmp(&a.0));
            unary.push(top.iter().map(|t| t.0).collect());
            cand.push(top.iter().map(|t| t.1).collect());
        }
        if std::env::var("TH_DEBUG_DRAFT").is_ok() {
            eprintln!(
                "[draft] top4 {:?} ids {:?}",
                unary.iter().map(|u| &u[..4]).collect::<Vec<_>>(),
                cand.iter().map(|c| &c[..4]).collect::<Vec<_>>()
            );
        }
        let sel_h: Vec<Vec<f32>> = sel
            .narrow(0, 0, PROPOSALS)?
            .to_dtype(DType::F32)?
            .to_vec2()?; // [7, 256] — row p for position p

        let mut tokens = [0u32; PROPOSALS];
        let mut cand_ids = [[0u32; TOPK]; PROPOSALS];
        let mut cand_probs = [[0f32; TOPK]; PROPOSALS];
        let mut pred_idx = 0usize;
        // Batched codebook gathers — the walk needs pred rows for
        // {anchor} ∪ cand_ids[0..6] and succ rows for cand_ids[0..6];
        // two index_select+readback calls instead of 14 pipelined syncs.
        let mut pred_ids: Vec<u32> = Vec::with_capacity(1 + 6 * TOPK);
        pred_ids.push(anchor);
        for p in 0..PROPOSALS - 1 {
            pred_ids.extend_from_slice(&cand[p]);
        }
        let mut succ_ids: Vec<u32> = Vec::with_capacity(PROPOSALS * TOPK);
        for p in 0..PROPOSALS {
            succ_ids.extend_from_slice(&cand[p]);
        }
        let pred_all: Vec<Vec<f32>> = self
            .pred_cb
            .i(&Tensor::from_slice(&pred_ids, (pred_ids.len(),), &self.device)?)?
            .to_dtype(DType::F32)?
            .to_vec2()?;
        let succ_all: Vec<Vec<f32>> = self
            .succ_cb
            .i(&Tensor::from_slice(&succ_ids, (succ_ids.len(),), &self.device)?)?
            .to_dtype(DType::F32)?
            .to_vec2()?;
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
            let inter = candle_nn::ops::silu(&lin_apply(&conv2, &l.gate)?)?
                .mul(&lin_apply(&conv2, &l.up)?)?;
            let proj2 = lin_apply(&inter, &l.down)?;
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
        let mut out = Vec::with_capacity(nb);
        for b in 0..nb {
            let lg = logits.narrow(0, b * PROPOSALS, PROPOSALS)?;
            let se = sel.narrow(0, b * PROPOSALS, PROPOSALS)?;
            let temp = temps[b];
            out.push(self.select(&lg, &se, anchors[b], temp, &mut || uniform(b))?);
        }
        Ok(out)
    }
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
        && std::env::var("TH_DRAFT_EAGER").is_err()
    {
        return Ok(crate::draft_kernel::draft_conv_fused(x, dyn_, base, residual, stage)?);
    }
    draft_conv(x, dyn_, base, stage, residual)
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
        && std::env::var("TH_DRAFT_EAGER").is_err()
    {
        return Ok(crate::draft_kernel::draft_norm_rope(x, w, cos, sin)?);
    }
    head_norm_rope(x, w, cos, sin)
}
