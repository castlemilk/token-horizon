// TurboQuant-style KV cache compression for the full-attention layers.
//
// Port of the algorithm in https://github.com/0xsero/turboquant
// (arXiv:2504.19874): a fixed random orthogonal rotation Π spreads each
// vector's energy uniformly across coordinates, after which the rotated
// coordinates on the unit sphere follow a near-Gaussian distribution
// N(0, 1/d). Per-coordinate Lloyd-Max codebooks then quantise each
// coordinate to 2 bits. Keys additionally carry a 1-bit QJL residual
// projection ("prod" mode ≈ 3 effective bits) so attention scores get an
// unbiased correction term; values use plain 2-bit MSE codes.
//
// Because Π is orthogonal, <q,k> = <qΠ, kΠ>: the stored cache stays in
// rotated space forever — we rotate the query once per step and rotate
// the attention output back once, instead of de-rotating T cache rows.
//
// Layout per layer (d = head_dim, T = cached tokens):
//   k_codes  [h, T, d/4] u8  — 2-bit MSE codes, 4 per byte
//   k_signs  [h, T, d/8] u8  — QJL sign(S·r) bits
//   k_meta   [h, T, 2]   f32 — |k|, |r| (residual norm)
//   v_codes  [h, T, d/4] u8
//   v_norms  [h, T]      f32 — |v|
//
// ≈ 104B/token/head for K (vs 512B bf16) and ≈ 68B for V — ~6x less
// memory. Decode reconstructs attention scores via gather + matmul on
// the packed codes; this v1 is eager ops, a fused kernel can come later.

use anyhow::Result;
use candle_core::{D, DType, Device, IndexOp, Tensor};

const K_BITS_CODES_PER_BYTE: usize = 4; // 2-bit codes
const SIGN_BITS_PER_BYTE: usize = 8;

pub struct TurboQuant {
    /// Head_dim this context was built for.
    pub dim: usize,
    /// Π rotation [d,d] f32 — encode does `x @ rot`, un-rotate `x @ rot.t()`.
    rot: Tensor,
    /// QJL projection S [d,d] f32 (Gaussian).
    qjl: Tensor,
    /// 2-bit Lloyd-Max centroids for N(0, 1/d), sorted ascending.
    centroids: Vec<f32>,
    /// Decision boundaries between centroids (midpoints), len 3.
    bounds: Vec<f32>,
    dev: Device,
}

#[derive(Clone, Default)]
pub struct QuantKv {
    pub k_codes: Option<Tensor>,
    pub k_signs: Option<Tensor>,
    pub k_meta: Option<Tensor>,
    pub v_codes: Option<Tensor>,
    pub v_norms: Option<Tensor>,
}

impl QuantKv {
    pub fn len(&self) -> usize {
        self.k_codes.as_ref().map(|t| t.dims()[1]).unwrap_or(0)
    }
}

// --- CPU reference math (rotation, codebooks, packing) -----------------

/// Deterministic xorshift64* + Box-Muller Gaussian fill.
fn gaussian_vec(n: usize, seed: u64) -> Vec<f32> {
    let mut s = seed.max(1);
    let mut next_u01 = || {
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        let v = (s.wrapping_mul(0x2545F4914F6CDD1D) >> 40) as f64;
        (v / (1u64 << 24) as f64) + 1e-9
    };
    (0..n)
        .map(|i| {
            let (u1, u2) = (next_u01(), next_u01());
            let r = (-2.0 * u1.ln()).sqrt();
            if i % 2 == 0 {
                (r * (2.0 * std::f64::consts::PI * u2).cos()) as f32
            } else {
                (r * (2.0 * std::f64::consts::PI * u2).sin()) as f32
            }
        })
        .collect()
}

/// Q factor of a row-major d×d matrix via modified Gram-Schmidt —
/// deterministic random rotation, matching TurboQuant's seed design.
fn random_rotation(d: usize, seed: u64) -> Vec<f32> {
    let mut q = gaussian_vec(d * d, seed);
    for i in 0..d {
        // v_i -= sum_j<i proj_{q_j}(v_i); q_i = v_i / |v_i|
        for j in 0..i {
            let mut dot = 0.0f64;
            for c in 0..d {
                dot += q[i * d + c] as f64 * q[j * d + c] as f64;
            }
            for c in 0..d {
                q[i * d + c] -= (dot as f32) * q[j * d + c];
            }
        }
        let mut n = 0.0f64;
        for c in 0..d {
            n += (q[i * d + c] as f64).powi(2);
        }
        let inv = (1.0 / n.sqrt().max(1e-12)) as f32;
        for c in 0..d {
            q[i * d + c] *= inv;
        }
    }
    q
}

/// Lloyd-Max centroids for the rotated-coordinate distribution —
/// approximated as N(0, sigma^2) with sigma = 1/sqrt(d) (exact marginal
/// converges to this; the upstream codebook solver uses the same
/// fixed-point iteration on samples).
fn lloyd_max_2bit(sigma: f64) -> Vec<f32> {
    // symmetric 4-level: centroids ±a, ±b — iterate Lloyd's fixed point
    // on a dense grid weighted by the Gaussian pdf.
    let mut c = vec![-1.51, -0.45, 0.45, 1.51]; // Gaussian-optimal start
    let grid: Vec<f64> = (0..2000)
        .map(|i| -4.0 + 8.0 * i as f64 / 1999.0)
        .collect();
    let pdf = |x: f64| (-0.5 * x * x).exp();
    for _ in 0..200 {
        let mut next = c.clone();
        for i in 0..4 {
            let lo = if i == 0 { -4.0 } else { (c[i - 1] + c[i]) / 2.0 };
            let hi = if i == 3 { 4.0 } else { (c[i] + c[i + 1]) / 2.0 };
            let (mut num, mut den) = (0.0, 0.0);
            for &x in &grid {
                if x >= lo && x < hi {
                    let w = pdf(x);
                    num += x * w;
                    den += w;
                }
            }
            if den > 0.0 {
                next[i] = num / den;
            }
        }
        if next
            .iter()
            .zip(&c)
            .all(|(a, b)| (a - b).abs() < 1e-9)
        {
            break;
        }
        c = next;
    }
    c.iter().map(|v| (v * sigma) as f32).collect()
}

impl TurboQuant {
    pub fn new(dim: usize, dev: &Device) -> Result<Self> {
        let rot = Tensor::from_vec(
            random_rotation(dim, 0x7a6b1d3c),
            (dim, dim),
            dev,
        )?;
        let qjl =
            Tensor::from_vec(gaussian_vec(dim * dim, 0x51f2ab9e), (dim, dim), dev)?;
        let centroids = lloyd_max_2bit((dim as f64).powf(-0.5));
        let bounds = vec![
            (centroids[0] + centroids[1]) / 2.0,
            (centroids[1] + centroids[2]) / 2.0,
            (centroids[2] + centroids[3]) / 2.0,
        ];
        Ok(Self {
            dim,
            rot,
            qjl,
            centroids,
            bounds,
            dev: dev.clone(),
        })
    }

    /// Rotate q rows into cache space and compute their QJL projection.
    /// `q` [.., d] any dtype → (q̃ f32, Sq̃ f32) same leading dims.
    pub fn rotate_q(&self, q: &Tensor) -> Result<(Tensor, Tensor)> {
        let dims = q.dims().to_vec();
        let n: usize = dims[..dims.len() - 1].iter().product();
        let flat = q.to_dtype(DType::F32)?.reshape((n, self.dim))?;
        let qr = flat.matmul(&self.rot.t()?)?.reshape(dims.as_slice())?;
        let sq = qr
            .reshape((n, self.dim))?
            .matmul(&self.qjl.t()?)?
            .reshape(dims.as_slice())?;
        Ok((qr, sq))
    }

    /// Encode fresh k/v rows ([h, seq, d] bf16/f32) into quantised form.
    pub fn encode(&self, k: &Tensor, v: &Tensor) -> Result<QuantKv> {
        let (h, seq, d) = (k.dims()[0], k.dims()[1], self.dim);
        let kf = k.to_dtype(DType::F32)?.reshape((h * seq, d))?;
        let vf = v.to_dtype(DType::F32)?.reshape((h * seq, d))?;

        // keys: normalise → rotate → 2-bit codes + QJL residual signs
        let kn = kf.sqr()?.sum_keepdim(D::Minus1)?.sqrt()?; // [n,1]
        let krot = kf.broadcast_div(&kn)?.matmul(&self.rot.t()?)?;
        let k_codes = self.quantise(&krot)?; // [n, d/4] u8
        let recon = self.dequantise_codes(&k_codes, d)?; // [n, d] f32
        let res = krot.sub(&recon)?;
        let rn = res.sqr()?.sum_keepdim(D::Minus1)?.sqrt()?;
        let proj = res.matmul(&self.qjl.t()?)?; // [n, d]
        let k_signs = self.pack_signs(&proj)?; // [n, d/8] u8
        let k_meta = Tensor::cat(&[kn, rn], 1)?; // [n, 2]

        // values: normalise → rotate → 2-bit codes
        let vn = vf.sqr()?.sum_keepdim(D::Minus1)?.sqrt()?;
        let vrot = vf.broadcast_div(&vn)?.matmul(&self.rot.t()?)?;
        let v_codes = self.quantise(&vrot)?;

        Ok(QuantKv {
            k_codes: Some(k_codes.reshape((h, seq, d / 4))?),
            k_signs: Some(k_signs.reshape((h, seq, d / 8))?),
            k_meta: Some(k_meta.reshape((h, seq, 2))?),
            v_codes: Some(v_codes.reshape((h, seq, d / 4))?),
            v_norms: Some(vn.reshape((h, seq))?),
        })
    }

    /// Append an encoded delta to the cache.
    pub fn append(&self, cache: &mut QuantKv, delta: QuantKv) -> Result<()> {
        fn cat2(a: &mut Option<Tensor>, b: Option<Tensor>) -> Result<()> {
            match (a.take(), b) {
                (None, b) => *a = b,
                (Some(x), Some(y)) => *a = Some(Tensor::cat(&[&x, &y], 1)?),
                (Some(x), None) => *a = Some(x),
            }
            Ok(())
        }
        cat2(&mut cache.k_codes, delta.k_codes)?;
        cat2(&mut cache.k_signs, delta.k_signs)?;
        cat2(&mut cache.k_meta, delta.k_meta)?;
        cat2(&mut cache.v_codes, delta.v_codes)?;
        cat2(&mut cache.v_norms, delta.v_norms)
    }

    /// Attention scores in rotated space for one kv-head group.
    /// `qr`,`sq`: [seq, rep, d] f32 (per-group slices of rotate_q).
    /// Returns [seq, rep, T] f32 raw scores (pre-softmax, unscaled).
    pub fn scores(
        &self,
        qr: &Tensor,
        sq: &Tensor,
        cache: &QuantKv,
        g: usize,
    ) -> Result<Tensor> {
        let d = self.dim;
        let (seq, rep) = (qr.dims()[0], qr.dims()[1]);
        let codes = cache.k_codes.as_ref().unwrap().i(g)?; // [T, d/4]
        let meta = cache.k_meta.as_ref().unwrap().i(g)?; // [T, 2]
        let t = codes.dims()[0];

        // base term: <q̃, ĉ> where ĉ = codebook lookup of the codes.
        // matmul yields [T, seq*rep] → (T,seq,rep) → (seq,rep,T).
        let idx = self.unpack2(&codes)?; // [T, d] u8
        let chat = self
            .centroids_t()?
            .index_select(&idx.flatten_all()?.to_dtype(DType::U32)?, 0)?
            .reshape((t, d))?;
        let qm = qr.reshape((seq * rep, d))?;
        let base = chat
            .matmul(&qm.t()?)?
            .reshape((t, seq, rep))?
            .transpose(0, 1)?
            .transpose(1, 2)?; // [seq, rep, T]

        // QJL correction: <q̃,r> ≈ |r|·sqrt(pi/2)/d·<Sq̃, sign(Sr)>
        let signs =
            self.unpack_signs(&cache.k_signs.as_ref().unwrap().i(g)?)?; // [T,d]
        let sqm = sq.reshape((seq * rep, d))?;
        let corr = signs
            .matmul(&sqm.t()?)?
            .reshape((t, seq, rep))?
            .transpose(0, 1)?
            .transpose(1, 2)?; // [seq, rep, T]
        let qjl_scale = (std::f64::consts::PI / 2.0).sqrt() / d as f64;

        let kn = meta.i((.., 0))?.unsqueeze(0)?.unsqueeze(0)?; // [1,1,T]
        let rn = meta.i((.., 1))?.unsqueeze(0)?.unsqueeze(0)?;
        let score = base
            .broadcast_add(&corr.broadcast_mul(&rn)?.affine(qjl_scale, 0.0)?)?
            .broadcast_mul(&kn)?;
        Ok(score)
    }

    /// Weighted-sum of quantised values for one kv-head group.
    /// `w`: [seq, rep, T] f32 attention weights (already softmaxed).
    /// Returns [seq, rep, d] f32 in the ORIGINAL basis (rotated back).
    pub fn values(
        &self,
        w: &Tensor,
        cache: &QuantKv,
        g: usize,
    ) -> Result<Tensor> {
        let d = self.dim;
        let (seq, rep) = (w.dims()[0], w.dims()[1]);
        let codes = cache.v_codes.as_ref().unwrap().i(g)?; // [T, d/4]
        let norms = cache.v_norms.as_ref().unwrap().i(g)?; // [T]
        let t = codes.dims()[0];

        let idx = self.unpack2(&codes)?;
        let vhat = self.centroids_t()?.index_select(
            &idx.flatten_all()?.to_dtype(DType::U32)?,
            0,
        )?.reshape((t, d))?;
        // w·|v| scales each rotated unit vector
        let wv = w
            .broadcast_mul(&norms.reshape((1, 1, t))?)?
            .reshape((seq * rep, t))?;
        let out_rot = wv.matmul(&vhat)?; // [seq*rep, d]
        let out = out_rot.matmul(&self.rot)?; // Πᵀ row-form: rotate back
        out.reshape((seq, rep, d)).map_err(Into::into)
    }

    // -- internals ------------------------------------------------------

    fn centroids_t(&self) -> Result<Tensor> {
        Tensor::from_vec(self.centroids.clone(), 4, &self.dev).map_err(Into::into)
    }

    /// nearest-centroid codes for x [n, d] f32 → packed [n, d/4] u8.
    fn quantise(&self, x: &Tensor) -> Result<Tensor> {
        let (n, d) = (x.dims()[0], self.dim);
        let bounds = Tensor::from_vec(self.bounds.clone(), 3, &self.dev)?;
        // code = count of boundaries below x (centroids are sorted)
        let codes = x
            .unsqueeze(D::Minus1)?
            .broadcast_gt(&bounds.reshape((1, 1, 3))?)?
            .sum(D::Minus1)?; // [n, d] u8
        let codes = codes.reshape((n, d / 4, 4))?.to_dtype(DType::U32)?;
        let shifts =
            Tensor::from_vec(vec![1u32, 4, 16, 64], 4, &self.dev)?;
        codes
            .broadcast_mul(&shifts)?
            .sum(D::Minus1)?
            .to_dtype(DType::U8)
            .map_err(Into::into)
    }

    /// packed [.., d/4] u8 → unpacked codes [.., d] u8.
    /// c_j = floor(byte / 4^j) mod 4, computed in f32 (positive → trunc
    /// is floor).
    fn unpack2(&self, packed: &Tensor) -> Result<Tensor> {
        let dims = packed.dims().to_vec();
        let pf = packed.to_dtype(DType::F32)?;
        let mut cols = Vec::with_capacity(K_BITS_CODES_PER_BYTE);
        for j in 0..K_BITS_CODES_PER_BYTE {
            let q = pf
                .affine(1.0 / (1u64 << (2 * j)) as f64, 0.0)?
                .to_dtype(DType::U32)? // trunc = floor for non-negative
                .to_dtype(DType::F32)?;
            let q4 = q
                .affine(0.25, 0.0)?
                .to_dtype(DType::U32)?
                .to_dtype(DType::F32)?
                .affine(4.0, 0.0)?;
            cols.push(q.sub(&q4)?.to_dtype(DType::U8)?);
        }
        let mut d2 = dims.clone();
        *d2.last_mut().unwrap() *= K_BITS_CODES_PER_BYTE;
        Tensor::stack(&cols, D::Minus1)?
            .reshape(d2.as_slice())
            .map_err(Into::into)
    }

    /// packed codes [n, d/4] u8 → centroid vectors [n, d] f32.
    fn dequantise_codes(&self, packed: &Tensor, d: usize) -> Result<Tensor> {
        let idx = self.unpack2(packed)?;
        self.centroids_t()?
            .index_select(&idx.flatten_all()?.to_dtype(DType::U32)?, 0)?
            .reshape((packed.dims()[0], d))
            .map_err(Into::into)
    }

    /// sign projection [n, d] f32 → packed sign bits [n, d/8] u8.
    fn pack_signs(&self, x: &Tensor) -> Result<Tensor> {
        let (n, d) = (x.dims()[0], self.dim);
        let bits = x.ge(&x.zeros_like()?)?; // [n, d] u8 — sign >= 0 → 1
        let bits = bits.reshape((n, d / 8, 8))?.to_dtype(DType::U32)?;
        let shifts = Tensor::from_vec(
            (0..8).map(|j| 1u32 << j).collect::<Vec<_>>(),
            8,
            &self.dev,
        )?;
        bits.broadcast_mul(&shifts)?
            .sum(D::Minus1)?
            .to_dtype(DType::U8)
            .map_err(Into::into)
    }

    /// packed [.., d/8] u8 → ±1 f32 [.., d]. bit_j = floor(byte/2^j) mod 2.
    fn unpack_signs(&self, packed: &Tensor) -> Result<Tensor> {
        let dims = packed.dims().to_vec();
        let pf = packed.to_dtype(DType::F32)?;
        let mut cols = Vec::with_capacity(SIGN_BITS_PER_BYTE);
        for j in 0..SIGN_BITS_PER_BYTE {
            let q = pf
                .affine(1.0 / (1u64 << j) as f64, 0.0)?
                .to_dtype(DType::U32)?
                .to_dtype(DType::F32)?;
            let q2 = q
                .affine(0.5, 0.0)?
                .to_dtype(DType::U32)?
                .to_dtype(DType::F32)?
                .affine(2.0, 0.0)?;
            cols.push(q.sub(&q2)?.to_dtype(DType::U8)?);
        }
        let mut d2 = dims.clone();
        *d2.last_mut().unwrap() *= SIGN_BITS_PER_BYTE;
        Tensor::stack(&cols, D::Minus1)?
            .reshape(d2.as_slice())?
            .to_dtype(DType::F32)?
            .affine(2.0, -1.0)
            .map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rand_t(dims: &[usize], dev: &Device) -> Tensor {
        let n: usize = dims.iter().product();
        Tensor::from_vec(gaussian_vec(n, 42), dims.to_vec(), dev).unwrap()
    }

    #[test]
    fn rotation_is_orthogonal() {
        let d = 64;
        let r = random_rotation(d, 7);
        // rows orthonormal → R·Rᵀ = I
        let rt = Tensor::from_vec(r, (d, d), &Device::Cpu).unwrap();
        let prod = rt.matmul(&rt.t().unwrap()).unwrap();
        let v = prod.to_vec2::<f32>().unwrap();
        for i in 0..d {
            for j in 0..d {
                let want = if i == j { 1.0 } else { 0.0 };
                assert!(
                    (v[i][j] - want).abs() < 1e-4,
                    "R·Rᵀ[{i}][{j}] = {}",
                    v[i][j]
                );
            }
        }
    }

    #[test]
    fn lloyd_max_codebook_is_symmetric() {
        let c = lloyd_max_2bit(1.0);
        assert_eq!(c.len(), 4);
        assert!((c[0] + c[3]).abs() < 1e-3 && (c[1] + c[2]).abs() < 1e-3);
        assert!(c[0] < c[1] && c[1] < c[2] && c[2] < c[3]);
    }

    /// End-to-end: encode a cache, then scores/values should track the
    /// exact-attention equivalents (2-bit + QJL → loose but correlated).
    #[test]
    fn quantised_attention_tracks_exact() {
        let dev = Device::Cpu;
        let d = 64;
        let (h, t) = (2, 96);
        let tq = TurboQuant::new(d, &dev).unwrap();

        let k = rand_t(&[h, t, d], &dev);
        let v = rand_t(&[h, t, d], &dev);
        let q = rand_t(&[1, h, d], &dev); // one position, rep = h

        let mut cache = QuantKv::default();
        let delta = tq.encode(&k, &v).unwrap();
        tq.append(&mut cache, delta).unwrap();
        assert_eq!(cache.len(), t);

        let (qr, sq) = tq.rotate_q(&q).unwrap();
        let scale = (d as f64).powf(-0.5);
        for g in 0..h {
            // exact: scores = q_g · k_gᵀ · scale ; out = softmax · v_g
            let qg = q
                .i((0, g))
                .unwrap()
                .to_dtype(DType::F32)
                .unwrap()
                .unsqueeze(0)
                .unwrap(); // [1, d]
            let kg = k.i(g).unwrap().to_dtype(DType::F32).unwrap();
            let vg = v.i(g).unwrap().to_dtype(DType::F32).unwrap();
            let exact_s =
                qg.matmul(&kg.t().unwrap()).unwrap().squeeze(0).unwrap(); // [t]
            let exact_p = candle_nn::ops::softmax(
                &exact_s.affine(scale, 0.0).unwrap().unsqueeze(0).unwrap(),
                D::Minus1,
            )
            .unwrap();
            let exact_o = exact_p.matmul(&vg).unwrap(); // [1, d]

            let got_s = tq
                .scores(&qr.narrow(1, g, 1).unwrap(), &sq.narrow(1, g, 1).unwrap(), &cache, g)
                .unwrap()
                .squeeze(0)
                .unwrap()
                .squeeze(0)
                .unwrap(); // [t]
            let got_sv: Vec<f32> = got_s.to_vec1().unwrap();
            let exact_sv: Vec<f32> =
                exact_s.affine(scale, 0.0).unwrap().to_vec1().unwrap();
            // Pearson correlation of scores
            let n = t as f64;
            let mx = exact_sv.iter().map(|x| *x as f64).sum::<f64>() / n;
            let my = got_sv.iter().map(|x| *x as f64).sum::<f64>() / n;
            let (mut num, mut dx, mut dy) = (0.0, 0.0, 0.0);
            for i in 0..t {
                let a = exact_sv[i] as f64 - mx;
                let b = got_sv[i] as f64 - my;
                num += a * b;
                dx += a * a;
                dy += b * b;
            }
            let corr = num / (dx.sqrt() * dy.sqrt());
            assert!(corr > 0.9, "score corr {corr} too low for head {g}");

            let got_p = candle_nn::ops::softmax(
                &got_s.affine(scale, 0.0).unwrap().unsqueeze(0).unwrap(),
                D::Minus1,
            )
            .unwrap();
            let got_o = tq
                .values(&got_p.unsqueeze(1).unwrap(), &cache, g)
                .unwrap()
                .squeeze(0)
                .unwrap()
                .squeeze(0)
                .unwrap(); // [d]
            let eo: Vec<f32> = exact_o.to_vec2::<f32>().unwrap()[0].clone();
            let go: Vec<f32> = got_o.to_vec1().unwrap();
            let (mut n2, mut d2x, mut d2y) = (0.0, 0.0, 0.0);
            for i in 0..d {
                n2 += eo[i] as f64 * go[i] as f64;
                d2x += (eo[i] as f64).powi(2);
                d2y += (go[i] as f64).powi(2);
            }
            let cos = n2 / (d2x.sqrt() * d2y.sqrt());
            assert!(cos > 0.9, "attn out cosine {cos} too low for head {g}");
        }
    }
}
