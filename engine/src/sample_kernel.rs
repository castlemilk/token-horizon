//! S1 — sampled DFlash acceptance on the GPU.
//!
//! A sampled verify round used to read the whole `[8, vocab]` bf16 logits
//! block back to the host (≈4 MB) and run top-k / top-p and the p/q test
//! on the CPU, one full-vocab pass per verified row. Here two small Metal
//! dispatches consume the verify logits in place, in the same command
//! buffer as the verify forward:
//!
//! * `ts_topk`   — one 1024-thread threadgroup per row: the exact top-k
//!   (k <= [`KMAX`]) by (logit desc, id asc), plus the full-vocab partition
//!   `Z` that candle's global top-p rule needs.
//! * `ts_accept` — one thread per slot: the acceptance chain (target
//!   filter, `u·q·S < w` test, residual / bonus draws) over the rows.
//!
//! The host reads back one 16-word result block ([`RES_LEN`]): emitted
//! ids, accepted count, uniforms consumed.
//!
//! **Bit-exact CPU reference.** [`cpu_row_dist`] + [`accept_chain`] are
//! the same arithmetic in Rust: [`th_expf`] is built from exact ops and
//! explicit fma (no libm), every sum is f32 in a fixed order (`Z` uses the
//! kernel's 1024-lane strided partials + fixed binary tree), there is no
//! division (the p/q test is `u·q·S < w` on unnormalised weights) and the
//! uniforms are 24-bit floats. The kernels compile with safe math and fp
//! contraction off, so the GPU and the CPU agree bit for bit:
//! `TH_SAMPLE_CPU=1` runs the reference, `TH_SAMPLE_CHECK=1` runs both and
//! reports any mismatch (engine.rs).
//!
//! **Semantics** (both paths): candidates are the top-k by (logit desc,
//! id asc); weights `w = exp((l - max) / T)`; top-p keeps a rank-order
//! prefix — `global` (candle / historical th): keep while the mass before
//! it is `< top_p · Z` over the full vocab; `renorm` (Splash / HF / vLLM):
//! keep while it is `<= top_p · Σ_topk w`. A draw walks the kept
//! candidates in rank order (`cum > u·S`). The acceptance test uses the
//! draft's recorded `q` (the distribution the proposal was drawn from), so
//! the emitted stream is distributed exactly as the target's filtered
//! distribution.
//!
//! **B1 — block verification** (`Policy::block`, [`accept_block`]): the
//! token rule above stops at the first rejected position; block
//! verification (Sun et al. 2024, "Block Verification Accelerates
//! Speculative Decoding") scores the drafted block jointly and accepts
//! the longest prefix a single joint test allows. Same output
//! distribution, never fewer accepted tokens in expectation.

/// Largest top-k the GPU path serves (Splash caps requests at 32 too).
pub const KMAX: usize = 32;
/// Uniforms staged per round: at most 7 accept draws + 1 bonus, or
/// j accept draws + 1 residual draw.
pub const NU: usize = 8;
/// Result block: [n_emitted, accepted, consumed, flags, emitted[0..8], 0..].
pub const RES_LEN: usize = 16;
/// Threads per row threadgroup = the partition's strided lanes.
pub const NT: usize = 1024;
/// Candidate pool per row (elements >= the k-th largest lane maximum).
#[cfg_attr(not(all(feature = "metal", target_os = "macos")), allow(dead_code))]
pub const POOL: usize = 1024;
/// Scratch words per row: ids[KMAX], vals[KMAX], m, Z, valid, overflow.
pub const RS: usize = 2 * KMAX + 4;
/// Verify rows per slot (anchor + 7 proposals).
pub const ROWS: usize = crate::dflash::ROWS;
const PROP: usize = crate::dflash::PROPOSALS;
const DTOPK: usize = crate::dflash::TOPK;

// f32 constants, shared bit-exactly with the MSL source below.
const LOG2E: u32 = 0x3FB8_AA3B;
const LN2_HI: u32 = 0x3F31_8000; // 0.693359375 (exact)
const LN2_LO: u32 = 0xB95E_8083; // -2.12194440e-4
const EC5: u32 = 0x3950_6967;
const EC4: u32 = 0x3AB7_43CE;
const EC3: u32 = 0x3C08_8908;
const EC2: u32 = 0x3D2A_A9C1;
const EC1: u32 = 0x3E2A_AAAA;
const EC0: u32 = 0x3F00_0000;

/// `e^x` for x <= 0 (the sampler only ever evaluates `(l - max) / T`),
/// from exact operations and explicit fma so the Metal kernel computes
/// the identical bits: Cody-Waite reduction by ln 2, a degree-7 Cephes
/// polynomial, exponent add. ~1 ulp against libm. `x <= -86` (and NaN)
/// returns 0 — e^-86 = 4e-38 is below any weight that can matter next to
/// the maximum's weight of 1.
#[inline]
pub fn th_expf(x: f32) -> f32 {
    if !(x > -86.0) {
        return 0.0;
    }
    let f = f32::from_bits;
    let n = (x * f(LOG2E)).round_ties_even();
    let r = (-n).mul_add(f(LN2_HI), x);
    let r = (-n).mul_add(f(LN2_LO), r);
    let r2 = r * r;
    let mut p = f(EC5);
    p = p.mul_add(r, f(EC4));
    p = p.mul_add(r, f(EC3));
    p = p.mul_add(r, f(EC2));
    p = p.mul_add(r, f(EC1));
    p = p.mul_add(r, f(EC0));
    let y = p.mul_add(r2, r) + 1.0;
    f32::from_bits(y.to_bits().wrapping_add(((n as i32) << 23) as u32))
}

/// Target sampling policy of one sampled slot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Policy {
    /// top-k (0 = no top-k: the whole vocabulary is the candidate set).
    pub k: usize,
    /// 1 / temperature, as the historical sampler computed it (f32).
    pub inv_t: f32,
    /// top-p; <= 0 or >= 1 disables it.
    pub top_p: f32,
    /// `true` = renorm (Splash / HF) semantics, `false` = global (candle).
    pub renorm: bool,
    /// `true` = block verification ([`accept_block`]), `false` = the
    /// token rule ([`accept_chain`]).
    pub block: bool,
}

impl Policy {
    /// The GPU path serves top-k 1..=KMAX (no top-k needs a full sort).
    pub fn gpu_ok(&self) -> bool {
        self.k >= 1 && self.k <= KMAX
    }
    fn top_p_on(&self) -> bool {
        self.top_p > 0.0 && self.top_p < 1.0
    }
}

/// One row's filtered target distribution: the kept candidates in rank
/// order with unnormalised weights `w` (the max has weight 1) and their
/// f32 sum `s`.
#[derive(Clone, Debug, PartialEq)]
pub struct RowDist {
    pub ids: Vec<u32>,
    pub w: Vec<f32>,
    pub s: f32,
}

impl RowDist {
    /// Greedy (or degenerate) row: one token, probability 1.
    pub fn single(id: u32) -> Self {
        Self { ids: vec![id], w: vec![1.0], s: 1.0 }
    }
    /// Deterministic: one kept candidate (or no weight at all).
    pub fn deterministic(&self) -> bool {
        self.ids.len() == 1 || !(self.s > 0.0)
    }
    /// `(id, prob)` in rank order (debug / stats).
    pub fn probs(&self) -> Vec<(u32, f32)> {
        if self.deterministic() {
            return vec![(self.ids[0], 1.0)];
        }
        self.ids.iter().zip(&self.w).map(|(&i, &w)| (i, w / self.s)).collect()
    }
}

/// Sort key: NaN ranks as -inf and -0.0 as +0.0, so the order is the
/// kernel's `>` / `==` order.
#[inline]
fn key(v: f32) -> f32 {
    if v.is_nan() {
        f32::NEG_INFINITY
    } else {
        v + 0.0
    }
}

/// Candle's full-vocab partition `Z = Σ_v e^((l_v - m) / T)`, summed in the
/// kernel's order: lane t accumulates v = t, t + NT, ... sequentially, then
/// a fixed binary tree (lane t += lane t + w for w = NT/2 .. 1).
///
/// The row is walked in NT-wide chunks (lane t takes element t of each
/// chunk), which adds each lane's terms in exactly the strided order —
/// the same bits — but reads the row sequentially and vectorises: 4.3x
/// faster than walking lane by lane (0.19 vs 0.79 ms per 248k row, M5 Max),
/// which had made this CPU path slower than the pre-S1 sampler.
pub fn global_z(l: &[f32], m: f32, inv_t: f32) -> f32 {
    let mut part = [0f32; NT];
    for chunk in l.chunks(NT) {
        for (p, &x) in part.iter_mut().zip(chunk) {
            *p += th_expf((key(x) - m) * inv_t);
        }
    }
    let mut w = NT / 2;
    while w > 0 {
        for t in 0..w {
            part[t] = part[t] + part[t + w];
        }
        w /= 2;
    }
    part[0]
}

/// Rank-order prefix kept by top-p (always >= 1 candidate).
fn n_keep(w: &[f32], pol: &Policy, z: impl FnOnce() -> f32) -> usize {
    if !pol.top_p_on() {
        return w.len();
    }
    let lim = if pol.renorm {
        let mut t = 0f32;
        for &x in w {
            t += x;
        }
        pol.top_p * t
    } else {
        pol.top_p * z()
    };
    let mut prefix = 0f32;
    for (j, &x) in w.iter().enumerate() {
        let cut = if pol.renorm { prefix > lim } else { prefix >= lim };
        if j > 0 && cut {
            return j;
        }
        prefix += x;
    }
    w.len()
}

/// CPU reference of `ts_topk` + the row part of `ts_accept`: the filtered
/// target distribution of one logits row (any k; the GPU serves k <= KMAX).
pub fn cpu_row_dist(l: &[f32], pol: &Policy) -> RowDist {
    let n = l.len();
    let k = if pol.k == 0 { n } else { pol.k.min(n) };
    let cmp = |a: &u32, b: &u32| key(l[*b as usize]).total_cmp(&key(l[*a as usize])).then(a.cmp(b));
    let mut idx: Vec<u32> = (0..n as u32).collect();
    if k < n {
        idx.select_nth_unstable_by(k - 1, cmp);
        idx.truncate(k);
    }
    idx.sort_unstable_by(cmp);
    let m = key(l[idx[0] as usize]);
    let w: Vec<f32> = idx.iter().map(|&i| th_expf((key(l[i as usize]) - m) * pol.inv_t)).collect();
    let keep = n_keep(&w, pol, || global_z(l, m, pol.inv_t));
    let mut s = 0f32;
    for &x in &w[..keep] {
        s += x;
    }
    idx.truncate(keep);
    let mut w = w;
    w.truncate(keep);
    RowDist { ids: idx, w, s }
}

/// One draw from a row distribution with a 24-bit uniform.
pub fn sample_dist(d: &RowDist, u: f32) -> u32 {
    if d.deterministic() {
        return d.ids[0];
    }
    let thr = u * d.s;
    let mut cum = 0f32;
    for j in 0..d.ids.len() {
        cum += d.w[j];
        if cum > thr {
            return d.ids[j];
        }
    }
    d.ids[d.ids.len() - 1]
}

/// Draft probability of `id` at proposal position `i` (0 off-table).
#[inline]
fn q_of(prop: &crate::dflash::Proposal, i: usize, id: u32) -> f32 {
    for j in 0..DTOPK {
        if prop.cand_ids[i][j] == id {
            return prop.cand_probs[i][j];
        }
    }
    0.0
}

/// Residual draw after a rejection: `max(0, w - q·S)` over the kept
/// candidates (= the normalised `max(0, p - q)` scaled by S), or the
/// target itself when the residual is empty.
pub fn residual_sample(d: &RowDist, prop: &crate::dflash::Proposal, i: usize, u: f32) -> u32 {
    let mut r = vec![0f32; d.ids.len()];
    let mut rs = 0f32;
    for j in 0..d.ids.len() {
        let t = q_of(prop, i, d.ids[j]) * d.s;
        let x = d.w[j] - t;
        r[j] = if x > 0.0 { x } else { 0.0 };
        rs += r[j];
    }
    if !(rs > 0.0) {
        return sample_dist(d, u);
    }
    let thr = u * rs;
    let mut cum = 0f32;
    let mut last = 0usize;
    for j in 0..d.ids.len() {
        if r[j] > 0.0 {
            last = j;
            cum += r[j];
            if cum > thr {
                return d.ids[j];
            }
        }
    }
    d.ids[last]
}

/// Outcome of one round's acceptance chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainOut {
    pub emitted: Vec<u32>,
    pub accepted: usize,
    /// Uniforms drawn (the host re-advances its RNG by exactly this many).
    pub consumed: usize,
}

/// The acceptance chain over `vlen` proposals (+ the bonus row when all
/// are accepted): the CPU reference of `ts_accept`.
///
/// Per position: a deterministic target (one kept candidate) emits it
/// and continues only if it is the proposal; otherwise, when both w(d)
/// and q(d) are positive, draw u and accept iff `u·q·S < w` (= u <
/// p/q); on rejection draw once more for the residual and stop.
pub fn accept_chain(
    rows: &mut dyn FnMut(usize) -> RowDist,
    prop: &crate::dflash::Proposal,
    vlen: usize,
    draw: &mut dyn FnMut() -> f32,
) -> ChainOut {
    let mut out = ChainOut { emitted: Vec::with_capacity(vlen + 1), accepted: 0, consumed: 0 };
    for i in 0..vlen {
        let d = rows(i);
        let want = prop.tokens[i];
        if d.deterministic() {
            let t = d.ids[0];
            out.emitted.push(t);
            if t == want {
                out.accepted += 1;
                continue;
            }
            return out;
        }
        let wd = d.ids.iter().position(|&x| x == want).map(|j| d.w[j]).unwrap_or(0.0);
        let qd = q_of(prop, i, want);
        if wd > 0.0 && qd > 0.0 {
            let u = draw();
            out.consumed += 1;
            if (u * qd) * d.s < wd {
                out.emitted.push(want);
                out.accepted += 1;
                continue;
            }
        }
        let u = draw();
        out.consumed += 1;
        out.emitted.push(residual_sample(&d, prop, i, u));
        return out;
    }
    let d = rows(vlen);
    let t = if d.deterministic() {
        d.ids[0]
    } else {
        let u = draw();
        out.consumed += 1;
        sample_dist(&d, u)
    };
    out.emitted.push(t);
    out
}

/// Deterministic rows as one candidate of weight 1 — the kernel's
/// `row_dist_b`; block verification uses the weights directly.
fn norm_row(d: RowDist) -> RowDist {
    if d.deterministic() {
        RowDist::single(d.ids[0])
    } else {
        d
    }
}

/// Block-verification residual weights of row `i` for the running ratio
/// c = n / d: `(c·p - q)^+` scaled by d·s, i.e. `(n·w - d·(q·s))^+` per
/// kept candidate (rank order), and their f32 sum (the kernel's order).
fn block_resid(row: &RowDist, prop: &crate::dflash::Proposal, i: usize, n: f32, d: f32) -> (Vec<f32>, f32) {
    let mut r = Vec::with_capacity(row.ids.len());
    let mut rs = 0f32;
    for j in 0..row.ids.len() {
        let a = n * row.w[j];
        let t = q_of(prop, i, row.ids[j]) * row.s;
        let b = d * t;
        let x = a - b;
        let v = if x > 0.0 { x } else { 0.0 };
        r.push(v);
        rs += v;
    }
    (r, rs)
}

/// B1 — block verification (Sun et al. 2024, "Block Verification
/// Accelerates Speculative Decoding", Alg. 2): the CPU reference of
/// `ts_accept` with `block = 1`.
///
/// With r_i = p_i(x_i) / q_i(x_i), the running ratio c_i = min(1,
/// c_{i-1}·r_i) (c_{-1} = 1), R_i = Σ_x (c_i·p_{i+1}(x) - q_{i+1}(x))^+
/// and h_i = R_i / (R_i + 1 - c_i) (h_{vlen-1} = c_{vlen-1}), it accepts
/// τ = the LAST i + 1 with η_i < h_i (0 if none) and draws the correction
/// from (c_{τ-1}·p_τ - q_τ)^+ normalised — the bonus row when τ = vlen.
/// The emitted stream is distributed as the target (as with the token
/// rule); P(τ >= i | block) = c_{i-1} >= Π_{j<i} min(1, r_j), so it never
/// accepts fewer tokens in expectation and accepts more whenever a later
/// position's surplus (r > 1) can pay for an earlier deficit.
///
/// Division-free, bit-exact with the kernel: c is carried as the pair
/// (n, d), p = w / s, so c·p - q = (n·w - d·(q·s)) / (d·s) and η < h ⟺
/// η·(R'' + (d - n)·s) < R'' with R'' = Σ (n·w - d·(q·s))^+. Consumes
/// exactly `vlen + 1` uniforms: η_0..η_{vlen-1}, then the correction draw.
pub fn accept_block(
    rows: &mut dyn FnMut(usize) -> RowDist,
    prop: &crate::dflash::Proposal,
    vlen: usize,
    draw: &mut dyn FnMut() -> f32,
) -> ChainOut {
    let mut u = [0f32; NU];
    for x in u.iter_mut().take(vlen + 1) {
        *x = draw();
    }
    let mut cache: Vec<Option<RowDist>> = (0..=vlen).map(|_| None).collect();
    let mut fetch = |i: usize, cache: &mut Vec<Option<RowDist>>| {
        if cache[i].is_none() {
            cache[i] = Some(norm_row(rows(i)));
        }
    };
    let (mut n, mut d) = (1f32, 1f32);
    // (n, d) entering position i: the residual at row i uses c_{i-1}
    let mut before = [(1f32, 1f32); ROWS];
    let mut tau = 0usize;
    fetch(0, &mut cache);
    for i in 0..vlen {
        before[i] = (n, d);
        let want = prop.tokens[i];
        let (wd, s) = {
            let cur = cache[i].as_ref().unwrap();
            (cur.ids.iter().position(|&x| x == want).map(|j| cur.w[j]).unwrap_or(0.0), cur.s)
        };
        if !(wd > 0.0) {
            // c_i = 0: neither this nor any later position can pass
            break;
        }
        let qd = q_of(prop, i, want);
        n *= wd;
        d = (d * s) * qd;
        if n >= d {
            n = 1.0;
            d = 1.0;
        }
        let pass = if i + 1 < vlen {
            fetch(i + 1, &mut cache);
            let nx = cache[i + 1].as_ref().unwrap();
            let (_, r) = block_resid(nx, prop, i + 1, n, d);
            let t2 = (d - n) * nx.s;
            u[i] * (r + t2) < r
        } else {
            u[i] * d < n
        };
        if pass {
            tau = i + 1;
        }
    }
    let mut out = ChainOut { emitted: prop.tokens[..tau].to_vec(), accepted: tau, consumed: vlen + 1 };
    let uy = u[vlen];
    fetch(tau, &mut cache);
    let row = cache[tau].as_ref().unwrap();
    let y = if tau == vlen {
        sample_dist(row, uy)
    } else {
        let (n0, d0) = before[tau];
        let (r, rs) = block_resid(row, prop, tau, n0, d0);
        if !(rs > 0.0) {
            sample_dist(row, uy)
        } else {
            let thr = uy * rs;
            let mut cum = 0f32;
            let mut last = 0usize;
            let mut pick = None;
            for j in 0..row.ids.len() {
                if r[j] > 0.0 {
                    last = j;
                    cum += r[j];
                    if cum > thr {
                        pick = Some(row.ids[j]);
                        break;
                    }
                }
            }
            pick.unwrap_or(row.ids[last])
        }
    };
    out.emitted.push(y);
    out
}

/// Analytic (f64) block-verification quantities for one drafted block:
/// `p[i]` / `q[i]` = the target / draft distribution at proposal position
/// i as `(id, prob)` lists, `x[i]` = the drafted token. Returns `(c, h)`
/// as defined at [`accept_block`] (R0b stats, exactness tests).
pub fn block_h_f64(p: &[Vec<(u32, f64)>], q: &[Vec<(u32, f64)>], x: &[u32]) -> (Vec<f64>, Vec<f64>) {
    let look = |d: &[(u32, f64)], id: u32| d.iter().find(|e| e.0 == id).map(|e| e.1).unwrap_or(0.0);
    let g = x.len();
    let (mut c, mut h) = (vec![0f64; g], vec![0f64; g]);
    let mut cp = 1.0f64;
    for i in 0..g {
        let (pi, qi) = (look(&p[i], x[i]), look(&q[i], x[i]));
        let ci = if !(cp > 0.0) || !(pi > 0.0) {
            0.0
        } else if !(qi > 0.0) {
            1.0
        } else {
            (cp * pi / qi).min(1.0)
        };
        c[i] = ci;
        h[i] = if i + 1 < g {
            let r: f64 = p[i + 1].iter().map(|&(id, pp)| (ci * pp - look(&q[i + 1], id)).max(0.0)).sum();
            let den = r + (1.0 - ci);
            if den > 0.0 {
                r / den
            } else {
                0.0
            }
        } else {
            ci
        };
        cp = ci;
    }
    (c, h)
}

/// E[τ | block] under block verification: Σ_t P(τ >= t), P(τ >= t) =
/// 1 - Π_{j >= t-1} (1 - h_j).
pub fn expected_accepted_block(h: &[f64]) -> f64 {
    let (mut tail, mut e) = (1.0f64, 0.0f64);
    for j in (0..h.len()).rev() {
        tail *= 1.0 - h[j];
        e += 1.0 - tail;
    }
    e
}

/// Decode a result block read back from `ts_accept`. `None` = a row's
/// candidate pool overflowed (pathological ties) — rerun on the CPU.
pub fn decode_result(res: &[u32]) -> Option<ChainOut> {
    if res.len() < RES_LEN || res[3] != 0 {
        return None;
    }
    let n = (res[0] as usize).min(ROWS);
    if n == 0 {
        return None;
    }
    Some(ChainOut {
        emitted: res[4..4 + n].to_vec(),
        accepted: res[1] as usize,
        consumed: res[2] as usize,
    })
}

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::gpu_accept;

/// Non-Metal builds: the engine never selects the GPU path
/// (`gpu_policy`), this only keeps the call sites compiling.
#[cfg(not(all(feature = "metal", target_os = "macos")))]
pub fn gpu_accept(
    _logits: &candle_core::Tensor,
    _row0: usize,
    _pol: &Policy,
    _prop: &crate::dflash::Proposal,
    _vlen: usize,
    _u: &[f32; NU],
) -> candle_core::Result<candle_core::Tensor> {
    candle_core::bail!("gpu_accept: Metal only")
}

#[cfg(all(feature = "metal", target_os = "macos"))]
mod metal_impl {
    use super::{Policy, DTOPK, KMAX, NT, NU, POOL, PROP, RES_LEN, ROWS, RS};
    #[allow(unused_imports)]
    use candle_core::backend::BackendStorage;
    use candle_core::{DType, Result, Storage, Tensor};
    use candle_metal_kernels::metal::ComputePipeline;
    use candle_metal_kernels::utils::EncoderProvider;
    use objc2_metal::MTLSize;
    use std::sync::OnceLock;

    const SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;
#pragma METAL fp math_mode(safe)
#pragma METAL fp contract(off)

#define KMAX 32u
#define NT 1024u
#define POOL 1024u
#define RS (2u * KMAX + 4u)
#define DTOPK 16u

// th_expf — bit-identical to sample_kernel.rs::th_expf
inline float th_expf(float x) {
    if (!(x > -86.0f)) return 0.0f;
    float n = rint(x * as_type<float>(0x3FB8AA3Bu));
    float r = fma(-n, as_type<float>(0x3F318000u), x);
    r = fma(-n, as_type<float>(0xB95E8083u), r);
    float r2 = r * r;
    float p = as_type<float>(0x39506967u);
    p = fma(p, r, as_type<float>(0x3AB743CEu));
    p = fma(p, r, as_type<float>(0x3C088908u));
    p = fma(p, r, as_type<float>(0x3D2AA9C1u));
    p = fma(p, r, as_type<float>(0x3E2AAAAAu));
    p = fma(p, r, as_type<float>(0x3F000000u));
    float y = fma(p, r2, r) + 1.0f;
    return as_type<float>(as_type<uint>(y) + (uint(int(n)) << 23));
}

struct TopkParams { uint vocab; uint row0; uint k; uint global_z; float inv_t; };

// One threadgroup per row. Pass 1: lane maxima -> row max m and the
// k-th largest lane maximum tau (every top-k element is >= tau). Pass 2:
// elements >= tau go to the pool (+ the lane's partition partial). The
// pool's top-k by (value desc, id asc) is found by rank counting.
kernel void ts_topk(device const bfloat* logits [[buffer(0)]],
                    device uint* scratch       [[buffer(1)]],
                    constant TopkParams& p     [[buffer(2)]],
                    uint row  [[threadgroup_position_in_grid]],
                    uint tid  [[thread_index_in_threadgroup]],
                    uint lane [[thread_index_in_simdgroup]],
                    uint sg   [[simdgroup_index_in_threadgroup]]) {
    threadgroup float tmax[NT];
    threadgroup float tsum[NT];
    threadgroup float pool_v[POOL];
    threadgroup uint pool_i[POOL];
    threadgroup float smin[NT / 32];
    threadgroup atomic_uint pool_n;
    device const bfloat* src = logits + ulong(p.row0 + row) * p.vocab;
    float mx = -INFINITY;
    for (uint t = tid; t < p.vocab; t += NT) {
        float v = float(src[t]);
        if (v > mx) mx = v;
    }
    tmax[tid] = mx;
    if (tid == 0) atomic_store_explicit(&pool_n, 0u, memory_order_relaxed);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    uint above = 0;
    float m = -INFINITY;
    for (uint o = 0; o < NT; ++o) {
        float v = tmax[o];
        above += (v > mx) ? 1u : 0u;
        if (v > m) m = v;
    }
    float cand = (above < p.k) ? mx : INFINITY;
    cand = simd_min(cand);
    if (lane == 0) smin[sg] = cand;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    float tau = smin[0];
    for (uint i = 1; i < NT / 32; ++i) tau = min(tau, smin[i]);
    float zs = 0.0f;
    for (uint t = tid; t < p.vocab; t += NT) {
        float v = float(src[t]);
        if (p.global_z != 0u) zs += th_expf((v - m) * p.inv_t);
        if (v >= tau) {
            uint slot = atomic_fetch_add_explicit(&pool_n, 1u, memory_order_relaxed);
            if (slot < POOL) { pool_v[slot] = v; pool_i[slot] = t; }
        }
    }
    tsum[tid] = zs;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint w = NT / 2; w > 0; w >>= 1) {
        if (tid < w) tsum[tid] = tsum[tid] + tsum[tid + w];
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }
    uint total = atomic_load_explicit(&pool_n, memory_order_relaxed);
    uint n = min(total, POOL);
    device uint* out = scratch + ulong(row) * RS;
    if (tid < n) {
        float v = pool_v[tid];
        uint id = pool_i[tid];
        uint rank = 0;
        for (uint f = 0; f < n; ++f) {
            float w2 = pool_v[f];
            uint j = pool_i[f];
            rank += (w2 > v || (w2 == v && j < id)) ? 1u : 0u;
        }
        if (rank < KMAX) { out[rank] = id; out[KMAX + rank] = as_type<uint>(v); }
    }
    if (tid >= n && tid < KMAX) { out[tid] = 0xffffffffu; out[KMAX + tid] = as_type<uint>(-INFINITY); }
    if (tid == 0) {
        out[2 * KMAX] = as_type<uint>(m);
        out[2 * KMAX + 1] = as_type<uint>(tsum[0]);
        out[2 * KMAX + 2] = min(n, KMAX);
        out[2 * KMAX + 3] = total > POOL ? 1u : 0u;
    }
}

struct AcceptParams {
    uint vlen; uint k; uint renorm; uint block;
    float inv_t; float top_p; uint pad1; uint pad2;
    uint draft[8];
    float u[8];
    uint cand_ids[7 * DTOPK];
    float cand_probs[7 * DTOPK];
};

// One row's kept candidates: ids/w in rank order; returns the kept count,
// `s` = their f32 sum. Mirrors cpu_row_dist.
inline uint row_dist(device const uint* sc, uint i, constant AcceptParams& p,
                     thread uint* ids, thread float* w, thread float& s) {
    device const uint* r = sc + i * RS;
    uint kk = min(p.k, r[2 * KMAX + 2]);
    float m = as_type<float>(r[KMAX]);
    for (uint j = 0; j < kk; ++j) {
        ids[j] = r[j];
        w[j] = th_expf((as_type<float>(r[KMAX + j]) - m) * p.inv_t);
    }
    uint keep = kk;
    if (p.top_p > 0.0f && p.top_p < 1.0f) {
        float lim;
        if (p.renorm != 0u) {
            float t = 0.0f;
            for (uint j = 0; j < kk; ++j) t += w[j];
            lim = p.top_p * t;
        } else {
            lim = p.top_p * as_type<float>(r[2 * KMAX + 1]);
        }
        float prefix = 0.0f;
        for (uint j = 0; j < kk; ++j) {
            bool cut = (p.renorm != 0u) ? (prefix > lim) : (prefix >= lim);
            if (j > 0 && cut) { keep = j; break; }
            prefix += w[j];
        }
    }
    s = 0.0f;
    for (uint j = 0; j < keep; ++j) s += w[j];
    return keep;
}

inline float q_of(constant AcceptParams& p, uint i, uint id) {
    for (uint j = 0; j < DTOPK; ++j)
        if (p.cand_ids[i * DTOPK + j] == id) return p.cand_probs[i * DTOPK + j];
    return 0.0f;
}

// B1: row_dist with deterministic rows as one candidate of weight 1
// (sample_kernel.rs::norm_row).
inline uint row_dist_b(device const uint* sc, uint i, constant AcceptParams& p,
                       thread uint* ids, thread float* w, thread float& s) {
    uint n = row_dist(sc, i, p, ids, w, s);
    if (n == 1u || !(s > 0.0f)) { n = 1u; w[0] = 1.0f; s = 1.0f; }
    return n;
}

// B1: block residual (n*w - d*(q*s))^+ of row i into r; returns the sum.
inline float block_resid(constant AcceptParams& p, uint i, thread uint* ids, thread float* w,
                         uint cnt, float s, float n, float d, thread float* r) {
    float rs = 0.0f;
    for (uint j = 0; j < cnt; ++j) {
        float a = n * w[j];
        float t = q_of(p, i, ids[j]) * s;
        float b = d * t;
        float x = a - b;
        float v = x > 0.0f ? x : 0.0f;
        r[j] = v;
        rs += v;
    }
    return rs;
}

inline uint sample_dist(thread uint* ids, thread float* w, uint n, float s, float u) {
    if (n == 1 || !(s > 0.0f)) return ids[0];
    float thr = u * s;
    float cum = 0.0f;
    for (uint j = 0; j < n; ++j) {
        cum += w[j];
        if (cum > thr) return ids[j];
    }
    return ids[n - 1];
}

kernel void ts_accept(device const uint* scratch [[buffer(0)]],
                      device uint* res          [[buffer(1)]],
                      constant AcceptParams& p  [[buffer(2)]],
                      uint tid [[thread_index_in_threadgroup]]) {
    if (tid != 0) return;
    uint emitted[8];
    uint ne = 0, accepted = 0, used = 0, flags = 0;
    uint ids[KMAX];
    float w[KMAX];
    for (uint i = 0; i <= p.vlen; ++i)
        if (scratch[i * RS + 2 * KMAX + 3] != 0u) flags = 1u;
    bool done = flags != 0u;
    if (p.block != 0u && !done) {
        // B1 block verification — mirrors sample_kernel.rs::accept_block
        float bn[8];
        float bd[8];
        uint nx_ids[KMAX];
        float nx_w[KMAX];
        float r[KMAX];
        float nn = 1.0f, dd = 1.0f;
        uint tau = 0;
        float s;
        uint cnt = row_dist_b(scratch, 0, p, ids, w, s);
        for (uint i = 0; i < p.vlen; ++i) {
            bn[i] = nn;
            bd[i] = dd;
            uint want = p.draft[i];
            float wd = 0.0f;
            for (uint j = 0; j < cnt; ++j) if (ids[j] == want) { wd = w[j]; break; }
            if (!(wd > 0.0f)) break;
            float qd = q_of(p, i, want);
            nn = nn * wd;
            dd = (dd * s) * qd;
            if (nn >= dd) { nn = 1.0f; dd = 1.0f; }
            bool pass;
            if (i + 1 < p.vlen) {
                float nxs;
                uint cn = row_dist_b(scratch, i + 1, p, nx_ids, nx_w, nxs);
                float rr = block_resid(p, i + 1, nx_ids, nx_w, cn, nxs, nn, dd, r);
                float t2 = (dd - nn) * nxs;
                pass = (p.u[i] * (rr + t2)) < rr;
                for (uint j = 0; j < cn; ++j) { ids[j] = nx_ids[j]; w[j] = nx_w[j]; }
                cnt = cn;
                s = nxs;
            } else {
                pass = (p.u[i] * dd) < nn;
            }
            if (pass) tau = i + 1;
        }
        for (uint j = 0; j < tau; ++j) emitted[ne++] = p.draft[j];
        accepted = tau;
        used = p.vlen + 1u;
        float uy = p.u[p.vlen];
        cnt = row_dist_b(scratch, tau, p, ids, w, s);
        uint pick;
        if (tau == p.vlen) {
            pick = sample_dist(ids, w, cnt, s, uy);
        } else {
            float rs = block_resid(p, tau, ids, w, cnt, s, bn[tau], bd[tau], r);
            if (!(rs > 0.0f)) {
                pick = sample_dist(ids, w, cnt, s, uy);
            } else {
                float thr = uy * rs;
                float cum = 0.0f;
                uint last = 0;
                pick = 0xffffffffu;
                for (uint j = 0; j < cnt; ++j) {
                    if (r[j] > 0.0f) {
                        last = j;
                        cum += r[j];
                        if (cum > thr) { pick = ids[j]; break; }
                    }
                }
                if (pick == 0xffffffffu) pick = ids[last];
            }
        }
        emitted[ne++] = pick;
        done = true;
    }
    for (uint i = 0; i < p.vlen && !done; ++i) {
        float s;
        uint n = row_dist(scratch, i, p, ids, w, s);
        uint want = p.draft[i];
        if (n == 1 || !(s > 0.0f)) {
            emitted[ne++] = ids[0];
            if (ids[0] == want) { accepted++; continue; }
            done = true; break;
        }
        float wd = 0.0f;
        for (uint j = 0; j < n; ++j) if (ids[j] == want) { wd = w[j]; break; }
        float qd = q_of(p, i, want);
        if (wd > 0.0f && qd > 0.0f) {
            float u = p.u[used++];
            if ((u * qd) * s < wd) { emitted[ne++] = want; accepted++; continue; }
        }
        float u = p.u[used++];
        float r[KMAX];
        float rs = 0.0f;
        for (uint j = 0; j < n; ++j) {
            float t = q_of(p, i, ids[j]) * s;
            float x = w[j] - t;
            r[j] = x > 0.0f ? x : 0.0f;
            rs += r[j];
        }
        uint pick;
        if (!(rs > 0.0f)) {
            pick = sample_dist(ids, w, n, s, u);
        } else {
            float thr = u * rs;
            float cum = 0.0f;
            uint last = 0;
            pick = 0xffffffffu;
            for (uint j = 0; j < n; ++j) {
                if (r[j] > 0.0f) {
                    last = j;
                    cum += r[j];
                    if (cum > thr) { pick = ids[j]; break; }
                }
            }
            if (pick == 0xffffffffu) pick = ids[last];
        }
        emitted[ne++] = pick;
        done = true;
    }
    if (!done) {
        float s;
        uint n = row_dist(scratch, p.vlen, p, ids, w, s);
        uint t;
        if (n == 1 || !(s > 0.0f)) t = ids[0];
        else { float u = p.u[used++]; t = sample_dist(ids, w, n, s, u); }
        emitted[ne++] = t;
    }
    res[0] = flags != 0u ? 0u : ne;
    res[1] = accepted;
    res[2] = used;
    res[3] = flags;
    for (uint j = 0; j < 8; ++j) res[4 + j] = j < ne ? emitted[j] : 0u;
    for (uint j = 12; j < 16; ++j) res[j] = 0u;
}
"#;

    #[repr(C)]
    struct TopkParams {
        vocab: u32,
        row0: u32,
        k: u32,
        global_z: u32,
        inv_t: f32,
    }

    #[repr(C)]
    struct AcceptParams {
        vlen: u32,
        k: u32,
        renorm: u32,
        block: u32,
        inv_t: f32,
        top_p: f32,
        pad1: u32,
        pad2: u32,
        draft: [u32; 8],
        u: [f32; NU],
        cand_ids: [u32; PROP * DTOPK],
        cand_probs: [f32; PROP * DTOPK],
    }

    static PIPE: OnceLock<(ComputePipeline, ComputePipeline)> = OnceLock::new();

    fn pipes(device: &candle_core::MetalDevice) -> Result<&'static (ComputePipeline, ComputePipeline)> {
        if PIPE.get().is_none() {
            let raw = device.metal_device();
            // safe math + precise functions: the CPU reference must see
            // the same bits (the source also pins fp contract off)
            let opts = objc2_metal::MTLCompileOptions::new();
            opts.setMathMode(objc2_metal::MTLMathMode::Safe);
            opts.setMathFloatingPointFunctions(objc2_metal::MTLMathFloatingPointFunctions::Precise);
            let lib = raw
                .new_library_with_source(SRC, Some(&opts))
                .map_err(candle_core::Error::wrap)?;
            let mk = |n: &str| -> Result<ComputePipeline> {
                let f = lib.get_function(n, None).map_err(candle_core::Error::wrap)?;
                raw.new_compute_pipeline_state_with_function(&f)
                    .map_err(candle_core::Error::wrap)
            };
            let _ = PIPE.set((mk("ts_topk")?, mk("ts_accept")?));
        }
        Ok(PIPE.get().unwrap())
    }

    fn metal_buf(t: &Tensor, elem: usize) -> Result<(candle_metal_kernels::metal::Buffer, usize)> {
        let (s, l) = t.storage_and_layout();
        let s = match &*s {
            Storage::Metal(m) => m.clone(),
            _ => candle_core::bail!("sample_kernel: Metal only"),
        };
        Ok((s.buffer().clone(), l.start_offset() * elem))
    }

    /// Encode the acceptance of one sampled slot whose `ROWS` verify rows
    /// start at `row0` of `logits` ([rows, vocab] bf16, contiguous).
    /// Returns the `[RES_LEN]` u32 result block — reading it back is the
    /// round's GPU sync. `u` = the uniforms the CPU path would draw next.
    pub fn gpu_accept(
        logits: &Tensor,
        row0: usize,
        pol: &Policy,
        prop: &crate::dflash::Proposal,
        vlen: usize,
        u: &[f32; NU],
    ) -> Result<Tensor> {
        let device = match logits.device() {
            candle_core::Device::Metal(d) => d.clone(),
            _ => candle_core::bail!("gpu_accept: Metal only"),
        };
        if logits.dtype() != DType::BF16 || logits.rank() != 2 || !logits.is_contiguous() {
            candle_core::bail!("gpu_accept: want contiguous [rows, vocab] bf16, got {:?} {:?}", logits.dtype(), logits.shape());
        }
        let (rows, vocab) = logits.dims2()?;
        if row0 + vlen + 1 > rows || vlen > PROP || !pol.gpu_ok() {
            candle_core::bail!("gpu_accept: row0 {row0} vlen {vlen} rows {rows} k {}", pol.k);
        }
        let (p_topk, p_acc) = pipes(&device)?;
        // ts_topk writes every scratch word it defines for rows 0..=vlen
        // (ids/vals: ranks < n, sentinels [n, KMAX); trailer by thread 0);
        // ts_accept reads only those rows' words
        let scratch = crate::outbuf::kernel_out((ROWS * RS,), DType::U32, logits.device())?;
        // ts_accept writes all RES_LEN words
        let res = crate::outbuf::kernel_out((RES_LEN,), DType::U32, logits.device())?;
        let (lb, lo) = metal_buf(logits, 2)?;
        let (sb, so) = metal_buf(&scratch, 4)?;
        let (rb, ro) = metal_buf(&res, 4)?;
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("ts_topk");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder = enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(p_topk);
        enc.set_input_buffer(0, Some(&lb), lo as _);
        enc.set_output_buffer(1, Some(&sb), so as _);
        enc.set_bytes(
            2,
            &TopkParams {
                vocab: vocab as u32,
                row0: row0 as u32,
                k: pol.k as u32,
                global_z: (!pol.renorm && pol.top_p > 0.0 && pol.top_p < 1.0) as u32,
                inv_t: pol.inv_t,
            },
        );
        enc.dispatch_thread_groups(
            MTLSize { width: vlen + 1, height: 1, depth: 1 },
            MTLSize { width: NT, height: 1, depth: 1 },
        );
        let mut ap = AcceptParams {
            vlen: vlen as u32,
            k: pol.k as u32,
            renorm: pol.renorm as u32,
            block: pol.block as u32,
            inv_t: pol.inv_t,
            top_p: pol.top_p,
            pad1: 0,
            pad2: 0,
            draft: [0; 8],
            u: *u,
            cand_ids: [0; PROP * DTOPK],
            cand_probs: [0.0; PROP * DTOPK],
        };
        for i in 0..PROP {
            ap.draft[i] = prop.tokens[i];
            for j in 0..DTOPK {
                ap.cand_ids[i * DTOPK + j] = prop.cand_ids[i][j];
                ap.cand_probs[i * DTOPK + j] = prop.cand_probs[i][j];
            }
        }
        enc.set_compute_pipeline_state(p_acc);
        enc.set_input_buffer(0, Some(&sb), so as _);
        enc.set_output_buffer(1, Some(&rb), ro as _);
        enc.set_bytes(2, &ap);
        enc.dispatch_thread_groups(
            MTLSize { width: 1, height: 1, depth: 1 },
            MTLSize { width: 32, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(res)
    }

    #[allow(dead_code)]
    const _ASSERT: () = {
        assert!(std::mem::size_of::<AcceptParams>() == 992);
        assert!(KMAX == 32 && NT == 1024 && POOL == NT && RS == 68);
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rng(seed: &mut u64) -> f64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        (*seed >> 11) as f64 / (1u64 << 53) as f64
    }

    #[test]
    fn th_expf_matches_libm() {
        let mut worst = 0f64;
        let mut x = 0f32;
        while x > -86.0 {
            let a = th_expf(x) as f64;
            let b = (x as f64).exp();
            worst = worst.max(((a - b) / b).abs());
            x -= 0.00137;
        }
        assert!(worst < 3e-7, "th_expf rel err {worst}");
        assert_eq!(th_expf(0.0), 1.0);
        assert_eq!(th_expf(-86.0), 0.0);
        assert_eq!(th_expf(f32::NAN), 0.0);
        assert_eq!(th_expf(f32::NEG_INFINITY), 0.0);
    }

    /// The chunked `global_z` adds each lane's terms in the kernel's
    /// strided order: same bits as a lane-by-lane walk, including a
    /// partial last chunk and NaN / -inf / tie-heavy rows.
    #[test]
    fn global_z_matches_strided_order() {
        let strided = |l: &[f32], m: f32, inv_t: f32| {
            let mut part = vec![0f32; NT];
            for (t, p) in part.iter_mut().enumerate() {
                let mut s = 0f32;
                let mut v = t;
                while v < l.len() {
                    s += th_expf((key(l[v]) - m) * inv_t);
                    v += NT;
                }
                *p = s;
            }
            let mut w = NT / 2;
            while w > 0 {
                for t in 0..w {
                    part[t] = part[t] + part[t + w];
                }
                w /= 2;
            }
            part[0]
        };
        let mut seed = 0x51A7_E0FFu64;
        for (trial, &n) in [248_320usize, 5000, 1024, 1000, 3 * 1024 + 1].iter().cycle().take(20).enumerate() {
            let mut l: Vec<f32> = (0..n).map(|_| (rng(&mut seed) * 16.0 - 12.0) as f32).collect();
            if trial % 3 == 0 {
                l[n / 2] = f32::NAN;
                l[n / 3] = f32::NEG_INFINITY;
            }
            if trial % 4 == 1 {
                for x in l.iter_mut().step_by(7) {
                    *x = half::bf16::from_f32(*x).to_f32();
                }
            }
            let m = l.iter().map(|&v| key(v)).fold(f32::NEG_INFINITY, f32::max);
            for inv_t in [1.0f32 / 0.6, 1.0, 1.0 / 0.3] {
                assert_eq!(global_z(&l, m, inv_t).to_bits(), strided(&l, m, inv_t).to_bits(), "trial {trial} n {n}");
            }
        }
    }

    fn fake_prop(tokens: [u32; PROP], seed: &mut u64) -> crate::dflash::Proposal {
        let mut cand_ids = [[0u32; DTOPK]; PROP];
        let mut cand_probs = [[0f32; DTOPK]; PROP];
        for i in 0..PROP {
            let mut s = 0f32;
            for j in 0..DTOPK {
                cand_ids[i][j] = if j == 0 { tokens[i] } else { (rng(seed) * 64.0) as u32 + 1000 * j as u32 };
                cand_probs[i][j] = (rng(seed) as f32).powi(3);
                s += cand_probs[i][j];
            }
            for j in 0..DTOPK {
                cand_probs[i][j] /= s;
            }
        }
        crate::dflash::Proposal { tokens, cand_ids, cand_probs }
    }

    /// Semantics of cpu_row_dist against a direct f64 formulation (up to
    /// rounding at the top-p boundary): the kept set and probabilities.
    #[test]
    fn row_dist_semantics() {
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        for trial in 0..200 {
            let n = 5000;
            let l: Vec<f32> = (0..n).map(|_| (rng(&mut seed) * 12.0 - 6.0) as f32 + if rng(&mut seed) < 0.01 { 8.0 } else { 0.0 }).collect();
            let renorm = trial % 2 == 0;
            let pol = Policy { k: 20, inv_t: 1.0 / 0.6, top_p: 0.95, renorm, block: false };
            let d = cpu_row_dist(&l, &pol);
            let mut idx: Vec<usize> = (0..n).collect();
            idx.sort_by(|&a, &b| l[b].total_cmp(&l[a]).then(a.cmp(&b)));
            let m = l[idx[0]] as f64;
            let e: Vec<f64> = idx[..20].iter().map(|&i| ((l[i] as f64 - m) / 0.6).exp()).collect();
            let denom: f64 = if renorm { e.iter().sum() } else { l.iter().map(|&v| ((v as f64 - m) / 0.6).exp()).sum() };
            let mut keep = 20;
            let mut prefix = 0f64;
            for (j, &x) in e.iter().enumerate() {
                let c = prefix / denom;
                if j > 0 && (if renorm { c > 0.95 } else { c >= 0.95 }) {
                    keep = j;
                    break;
                }
                prefix += x;
            }
            // exact ties at the boundary are measure-zero here; allow ±1 on
            // a boundary that sits within 1e-5 of top_p
            assert!((d.ids.len() as i64 - keep as i64).abs() <= 1, "trial {trial}: kept {} vs {keep}", d.ids.len());
            for (j, &id) in d.ids.iter().enumerate() {
                assert_eq!(id as usize, idx[j]);
            }
        }
    }

    /// accept_chain's emitted stream is distributed as the target: at one
    /// position with a fixed proposal table, the empirical distribution of
    /// the first emitted token matches p within sampling error.
    #[test]
    fn accept_chain_is_exact_at_one_position() {
        let mut seed = 42u64;
        let l: Vec<f32> = (0..300).map(|i| if i < 6 { 10.0 - i as f32 * 0.4 } else { -5.0 + (i % 7) as f32 * 0.1 }).collect();
        let pol = Policy { k: 20, inv_t: 1.0 / 0.6, top_p: 0.95, renorm: true, block: false };
        let d = cpu_row_dist(&l, &pol);
        let p = d.probs();
        let mut counts = std::collections::HashMap::<u32, usize>::new();
        let trials = 200_000;
        for _ in 0..trials {
            let mut prop = fake_prop([0; PROP], &mut seed);
            // draft q over ids 0..16 skewed away from p; draw d_0 ~ q
            let mut q = [0f32; DTOPK];
            let mut s = 0f32;
            for j in 0..DTOPK {
                prop.cand_ids[0][j] = j as u32;
                q[j] = 1.0 / (1.0 + j as f32 * 0.3);
                s += q[j];
            }
            let u0 = rng(&mut seed) as f32 * s;
            let mut cum = 0f32;
            let mut dtok = 15;
            for j in 0..DTOPK {
                q[j] /= 1.0;
                cum += q[j];
                if cum > u0 {
                    dtok = j;
                    break;
                }
            }
            for j in 0..DTOPK {
                prop.cand_probs[0][j] = q[j] / s;
            }
            prop.tokens[0] = dtok as u32;
            let dd = d.clone();
            let out = accept_chain(&mut |_| dd.clone(), &prop, 1, &mut || rng(&mut seed) as f32);
            *counts.entry(out.emitted[0]).or_default() += 1;
        }
        for &(id, pr) in &p {
            let f = *counts.get(&id).unwrap_or(&0) as f64 / trials as f64;
            let sd = (pr as f64 * (1.0 - pr as f64) / trials as f64).sqrt();
            assert!((f - pr as f64).abs() < 5.0 * sd + 1e-4, "id {id}: {f} vs {pr}");
        }
        let off: usize = counts.iter().filter(|(id, _)| !p.iter().any(|(x, _)| x == *id)).map(|(_, c)| c).sum();
        assert_eq!(off, 0, "emitted a token outside the target support");
    }

    /// Tiny autoregressive target / draft pair over `v` tokens, block
    /// length `g`: `p[prefix]` for |prefix| <= g, `q[prefix]` for
    /// |prefix| < g — sparse (zeros), sometimes a point mass, supports
    /// mismatched between p and q; `alpha` > 0 mixes p into q (a draft
    /// that mostly agrees, so chains run deep).
    struct Toy {
        v: usize,
        g: usize,
        p: std::collections::HashMap<Vec<u32>, Vec<f64>>,
        q: std::collections::HashMap<Vec<u32>, Vec<f64>>,
    }

    fn toy_dist(v: usize, seed: &mut u64) -> Vec<f64> {
        let mut d: Vec<f64> = (0..v).map(|_| if rng(seed) < 0.25 { 0.0 } else { rng(seed).powi(2) + 1e-3 }).collect();
        if rng(seed) < 0.15 || d.iter().all(|&x| x == 0.0) {
            d = vec![0.0; v];
            d[(rng(seed) * v as f64) as usize % v] = 1.0;
        }
        let t: f64 = d.iter().sum();
        d.iter().map(|x| x / t).collect()
    }

    fn toy(v: usize, g: usize, alpha: f64, seed: &mut u64) -> Toy {
        let (mut p, mut q) = (std::collections::HashMap::new(), std::collections::HashMap::new());
        let mut level: Vec<Vec<u32>> = vec![vec![]];
        for len in 0..=g {
            let mut next = Vec::new();
            for pre in &level {
                let pd = toy_dist(v, seed);
                if len < g {
                    let noise = toy_dist(v, seed);
                    let qd: Vec<f64> = pd.iter().zip(&noise).map(|(a, b)| alpha * a + (1.0 - alpha) * b).collect();
                    q.insert(pre.clone(), qd);
                }
                p.insert(pre.clone(), pd);
                for t in 0..v as u32 {
                    let mut z = pre.clone();
                    z.push(t);
                    next.push(z);
                }
            }
            level = next;
        }
        Toy { v, g, p, q }
    }

    fn digits(mut c: usize, v: usize, len: usize) -> Vec<u32> {
        let mut z = vec![0u32; len];
        for i in (0..len).rev() {
            z[i] = (c % v) as u32;
            c /= v;
        }
        z
    }

    fn code(z: &[u32], v: usize) -> usize {
        z.iter().fold(0, |a, &t| a * v + t as usize)
    }

    fn sparse(d: &[f64]) -> Vec<(u32, f64)> {
        d.iter().enumerate().filter(|(_, &x)| x > 0.0).map(|(i, &x)| (i as u32, x)).collect()
    }

    /// Adds `mass` for `z` completed to length g + 1 by the target.
    fn complete(t: &Toy, z: Vec<u32>, mass: f64, out: &mut [f64]) {
        if z.len() == t.g + 1 {
            out[code(&z, t.v)] += mass;
            return;
        }
        let d = &t.p[&z];
        for y in 0..t.v {
            if d[y] > 0.0 {
                let mut z2 = z.clone();
                z2.push(y as u32);
                complete(t, z2, mass * d[y], out);
            }
        }
    }

    fn target_prob(t: &Toy, z: &[u32]) -> f64 {
        (0..z.len()).map(|j| t.p[&z[..j].to_vec()][z[j] as usize]).product()
    }

    /// Exact output distribution (drafted block → accepted prefix +
    /// correction, completed by the target to g + 1 tokens) of the token
    /// rule or of block verification, by enumerating every draft block and
    /// integrating the uniforms analytically.
    fn exact_output(t: &Toy, block: bool) -> Vec<f64> {
        let (v, g) = (t.v, t.g);
        let mut out = vec![0f64; v.pow(g as u32 + 1)];
        for cx in 0..v.pow(g as u32) {
            let x = digits(cx, v, g);
            let px: f64 = (0..g).map(|i| t.q[&x[..i].to_vec()][x[i] as usize]).product();
            if px == 0.0 {
                continue;
            }
            let pl: Vec<Vec<(u32, f64)>> = (0..g).map(|i| sparse(&t.p[&x[..i].to_vec()])).collect();
            let ql: Vec<Vec<(u32, f64)>> = (0..g).map(|i| sparse(&t.q[&x[..i].to_vec()])).collect();
            let (c, h) = block_h_f64(&pl, &ql, &x);
            let mut ptau = vec![0f64; g + 1];
            for tt in 0..=g {
                ptau[tt] = if block {
                    let hit = if tt == 0 { 1.0 } else { h[tt - 1] };
                    hit * (tt..g).map(|j| 1.0 - h[j]).product::<f64>()
                } else {
                    let a = |j: usize| {
                        let (pp, qq) = (t.p[&x[..j].to_vec()][x[j] as usize], t.q[&x[..j].to_vec()][x[j] as usize]);
                        if pp > 0.0 { (pp / qq).min(1.0) } else { 0.0 }
                    };
                    (0..tt).map(a).product::<f64>() * if tt < g { 1.0 - a(tt) } else { 1.0 }
                };
            }
            for tt in 0..=g {
                if ptau[tt] <= 0.0 {
                    continue;
                }
                let pre = x[..tt].to_vec();
                let pt = &t.p[&pre];
                let yd: Vec<f64> = if tt == g {
                    pt.clone()
                } else {
                    let qt = &t.q[&pre];
                    let cp = if block && tt > 0 { c[tt - 1] } else { 1.0 };
                    let r: Vec<f64> = (0..v).map(|y| (cp * pt[y] - qt[y]).max(0.0)).collect();
                    let rs: f64 = r.iter().sum();
                    assert!(rs > 1e-15 || ptau[tt] < 1e-12, "rule block={block}: tau={tt} has mass {} but an empty residual", ptau[tt]);
                    if rs > 0.0 { r.iter().map(|x| x / rs).collect() } else { pt.clone() }
                };
                for y in 0..v {
                    if yd[y] > 0.0 {
                        let mut z = pre.clone();
                        z.push(y as u32);
                        complete(t, z, px * ptau[tt] * yd[y], &mut out);
                    }
                }
            }
        }
        out
    }

    /// B1 formula: block verification (and, as the harness control, the
    /// token rule) reproduces the target's joint distribution exactly, on
    /// random sparse / point-mass / support-mismatched toy models; block
    /// verification accepts at least as many tokens in expectation.
    #[test]
    fn block_rule_is_exact_by_enumeration() {
        let mut seed = 0x5EED_B10Cu64;
        let (mut e_tok, mut e_blk) = (0f64, 0f64);
        for trial in 0..300 {
            let (v, g) = [(3usize, 3usize), (2, 5), (4, 2), (3, 4)][trial % 4];
            let t = toy(v, g, [0.0, 0.5, 0.8][trial % 3], &mut seed);
            let target: Vec<f64> = (0..v.pow(g as u32 + 1)).map(|c| target_prob(&t, &digits(c, v, g + 1))).collect();
            for block in [false, true] {
                let out = exact_output(&t, block);
                let err = out.iter().zip(&target).map(|(a, b)| (a - b).abs()).fold(0f64, f64::max);
                assert!(err < 1e-12, "trial {trial} (v {v}, g {g}) block={block}: max |out - target| = {err:e}");
            }
            // expected accepted tokens (exact, over draft blocks)
            let mut e = [0f64; 2];
            for cx in 0..v.pow(g as u32) {
                let x = digits(cx, v, g);
                let px: f64 = (0..g).map(|i| t.q[&x[..i].to_vec()][x[i] as usize]).product();
                if px == 0.0 {
                    continue;
                }
                let pl: Vec<Vec<(u32, f64)>> = (0..g).map(|i| sparse(&t.p[&x[..i].to_vec()])).collect();
                let ql: Vec<Vec<(u32, f64)>> = (0..g).map(|i| sparse(&t.q[&x[..i].to_vec()])).collect();
                let (_, h) = block_h_f64(&pl, &ql, &x);
                e[1] += px * expected_accepted_block(&h);
                let mut pr = 1.0;
                for j in 0..g {
                    let (pp, qq) = (t.p[&x[..j].to_vec()][x[j] as usize], t.q[&x[..j].to_vec()][x[j] as usize]);
                    pr *= if pp > 0.0 { (pp / qq).min(1.0) } else { 0.0 };
                    e[0] += px * pr;
                }
            }
            assert!(e[1] >= e[0] - 1e-12, "trial {trial}: block E[tau] {} < token {}", e[1], e[0]);
            e_tok += e[0];
            e_blk += e[1];
        }
        eprintln!("block_rule_is_exact_by_enumeration: 300 toy models exact (both rules); sum E[tau] block / token = {:.4}", e_blk / e_tok);
    }

    /// Target row of a toy distribution in the engine's representation.
    fn toy_row(d: &[f64]) -> RowDist {
        let mut ids: Vec<u32> = (0..d.len() as u32).filter(|&i| d[i as usize] > 0.0).collect();
        ids.sort_by(|&a, &b| d[b as usize].total_cmp(&d[a as usize]).then(a.cmp(&b)));
        let mx = d[ids[0] as usize];
        let w: Vec<f32> = ids.iter().map(|&i| (d[i as usize] / mx) as f32).collect();
        let s = w.iter().fold(0f32, |a, &b| a + b);
        RowDist { ids, w, s }
    }

    fn toy_prop(t: &Toy, x: &[u32]) -> crate::dflash::Proposal {
        let mut tokens = [0u32; PROP];
        let mut cand_ids = [[0u32; DTOPK]; PROP];
        let mut cand_probs = [[0f32; DTOPK]; PROP];
        for i in 0..PROP {
            for j in 0..DTOPK {
                cand_ids[i][j] = if j < t.v { j as u32 } else { 1000 + j as u32 };
            }
            if i < t.g {
                tokens[i] = x[i];
                for j in 0..t.v {
                    cand_probs[i][j] = t.q[&x[..i].to_vec()][j] as f32;
                }
            }
        }
        crate::dflash::Proposal { tokens, cand_ids, cand_probs }
    }

    fn draw_f64(d: &[f64], seed: &mut u64) -> u32 {
        let u = rng(seed);
        let mut c = 0.0;
        for (i, &p) in d.iter().enumerate() {
            c += p;
            if u < c {
                return i as u32;
            }
        }
        d.iter().rposition(|&p| p > 0.0).unwrap() as u32
    }

    /// B1 implementation: the f32, division-free `accept_block` (and the
    /// token rule `accept_chain`, as control) are exact end to end — draft a
    /// block from q, accept with 24-bit uniforms, complete with the target:
    /// the empirical distribution of the g + 1 tokens matches the target
    /// joint within sampling error.
    #[test]
    fn accept_block_is_exact_monte_carlo() {
        let mut seed = 0xC0FF_EE11u64;
        for (inst, &(v, g, alpha)) in [(3usize, 3usize, 0.7f64), (2, 5, 0.8), (4, 2, 0.0), (3, 4, 0.6)].iter().enumerate() {
            let t = toy(v, g, alpha, &mut seed);
            let n_out = v.pow(g as u32 + 1);
            let target: Vec<f64> = (0..n_out).map(|c| target_prob(&t, &digits(c, v, g + 1))).collect();
            let trials = 300_000usize;
            let mut acc = [0usize; 2];
            for block in [false, true] {
                let mut counts = vec![0usize; n_out];
                for _ in 0..trials {
                    let mut x: Vec<u32> = Vec::with_capacity(g);
                    for _ in 0..g {
                        let d = &t.q[&x];
                        x.push(draw_f64(d, &mut seed));
                    }
                    let prop = toy_prop(&t, &x);
                    let mut rows = |i: usize| toy_row(&t.p[&x[..i].to_vec()]);
                    let mut draw = || ((rng(&mut seed) * 16777216.0) as u32) as f32 * (1.0 / 16777216.0);
                    let out = if block {
                        accept_block(&mut rows, &prop, g, &mut draw)
                    } else {
                        accept_chain(&mut rows, &prop, g, &mut draw)
                    };
                    acc[block as usize] += out.accepted;
                    let mut z = out.emitted.clone();
                    while z.len() < g + 1 {
                        let y = draw_f64(&t.p[&z], &mut seed);
                        z.push(y);
                    }
                    counts[code(&z, v)] += 1;
                }
                for c in 0..n_out {
                    let f = counts[c] as f64 / trials as f64;
                    let sd = (target[c] * (1.0 - target[c]) / trials as f64).sqrt();
                    assert!((f - target[c]).abs() < 5.0 * sd + 2e-5, "instance {inst} block={block} outcome {:?}: {f} vs {}", digits(c, v, g + 1), target[c]);
                }
            }
            eprintln!("accept_block_is_exact_monte_carlo: instance {inst} (v {v}, g {g}) exact; accepted/round token {:.4} block {:.4}", acc[0] as f64 / trials as f64, acc[1] as f64 / trials as f64);
        }
    }

    /// B1: on realistic rows (5000-token vocab, k 20, T 0.6, top-p 0.95,
    /// peaked, drafts mostly from the target), the f32 division-free
    /// `accept_block` makes the analytic rule's decision (τ = last i + 1
    /// with η_i < h_i) whenever no η sits within 1e-4 of its h.
    #[test]
    fn accept_block_matches_analytic_rule() {
        let mut seed = 0xAB5E_1234u64;
        let (mut checked, mut deep) = (0usize, 0usize);
        for trial in 0..2000 {
            let pol = Policy { k: 20, inv_t: 1.0 / 0.6, top_p: 0.95, renorm: trial % 2 == 0, block: true };
            let dists: Vec<RowDist> = (0..ROWS)
                .map(|_| {
                    let l: Vec<f32> = (0..5000).map(|_| (rng(&mut seed) * 8.0 - 12.0) as f32).collect();
                    let mut l = l;
                    let top = (rng(&mut seed) * 3.0) as usize + 1;
                    for tt in 0..top + 20 {
                        let v = (rng(&mut seed) * 5000.0) as usize;
                        l[v] = (14.0 - tt as f64 * (0.2 + rng(&mut seed) * 0.8) + if tt < top { 4.0 } else { 0.0 }) as f32;
                    }
                    cpu_row_dist(&l, &pol)
                })
                .collect();
            let mut tokens = [0u32; PROP];
            for i in 0..PROP {
                tokens[i] = if rng(&mut seed) < 0.85 { sample_dist(&dists[i], rng(&mut seed) as f32) } else { (rng(&mut seed) * 5000.0) as u32 };
            }
            let mut prop = fake_prop(tokens, &mut seed);
            for i in 0..PROP {
                for (j, &id) in dists[i].ids.iter().take(DTOPK).enumerate() {
                    if j > 0 && prop.cand_ids[i][j] != tokens[i] && !prop.cand_ids[i][..j].contains(&id) {
                        prop.cand_ids[i][j] = id;
                    }
                }
            }
            let eta: [f32; NU] = std::array::from_fn(|_| ((rng(&mut seed) * 16777216.0) as u32) as f32 * (1.0 / 16777216.0));
            let mut k = 0;
            let out = accept_block(&mut |i| dists[i].clone(), &prop, PROP, &mut || {
                k += 1;
                eta[k - 1]
            });
            assert_eq!(out.consumed, PROP + 1);
            let pl: Vec<Vec<(u32, f64)>> = dists[..PROP].iter().map(|d| d.probs().into_iter().map(|(i, p)| (i, p as f64)).collect()).collect();
            let ql: Vec<Vec<(u32, f64)>> = (0..PROP)
                .map(|i| {
                    let mut seen = std::collections::HashSet::new();
                    (0..DTOPK).filter(|&j| seen.insert(prop.cand_ids[i][j])).map(|j| (prop.cand_ids[i][j], prop.cand_probs[i][j] as f64)).collect()
                })
                .collect();
            let (_, h) = block_h_f64(&pl, &ql, &tokens);
            if (0..PROP).any(|j| (eta[j] as f64 - h[j]).abs() < 1e-4) {
                continue;
            }
            let tau = (0..PROP).filter(|&j| (eta[j] as f64) < h[j]).map(|j| j + 1).max().unwrap_or(0);
            assert_eq!(out.accepted, tau, "trial {trial}: h {h:?} eta {eta:?}");
            assert_eq!(&out.emitted[..tau], &tokens[..tau]);
            checked += 1;
            deep += (tau == PROP) as usize;
        }
        eprintln!("accept_block_matches_analytic_rule: {checked} blocks checked, {deep} accepted all {PROP}");
        assert!(checked > 1500 && deep > 0);
    }

    /// GPU `ts_topk` + `ts_accept` == the CPU reference, bit for bit, on
    /// random rows (both top-p semantics, several k), including the
    /// consumed-uniform count.
    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn gpu_accept_matches_cpu_reference() -> candle_core::Result<()> {
        let dev = match candle_core::Device::new_metal(0) {
            Ok(d) => d,
            Err(_) => return Ok(()),
        };
        let mut seed = 0xDEAD_BEEFu64;
        let vocab = 248_320usize;
        let mut mismatches = 0;
        let (mut deep, mut emitted) = ([0usize; 2], [0usize; 2]);
        for trial in 0..160 {
            // peaked rows (as a real LM at T=0.6) with a few near-ties
            let mut data = vec![half::bf16::ZERO; ROWS * vocab];
            for r in 0..ROWS {
                for v in 0..vocab {
                    let x = rng(&mut seed) * 8.0 - 12.0;
                    data[r * vocab + v] = half::bf16::from_f64(x);
                }
                let top = (rng(&mut seed) * 3.0) as usize + 1;
                for t in 0..top + 20 {
                    let v = (rng(&mut seed) * vocab as f64) as usize;
                    let x = 14.0 - t as f64 * (0.2 + rng(&mut seed) * 0.8) + if t < top { 4.0 } else { 0.0 };
                    data[r * vocab + v] = half::bf16::from_f64(x);
                }
            }
            let logits = candle_core::Tensor::from_vec(data.clone(), (ROWS, vocab), &dev)?;
            let rows_f32: Vec<Vec<f32>> = (0..ROWS).map(|r| data[r * vocab..(r + 1) * vocab].iter().map(|v| v.to_f32()).collect()).collect();
            let k = [20usize, 1, 32, 5][trial % 4];
            let pol0 = Policy { k, inv_t: 1.0f32 / [0.6f32, 1.0, 0.3][trial % 3], top_p: [0.95f32, 1.0, 0.8][trial % 3], renorm: trial % 2 == 1, block: false };
            let dists: Vec<RowDist> = rows_f32.iter().map(|l| cpu_row_dist(l, &pol0)).collect();
            // proposals: mostly the target's own draws so chains run deep
            let mut tokens = [0u32; PROP];
            for i in 0..PROP {
                tokens[i] = if rng(&mut seed) < 0.8 { sample_dist(&dists[i], rng(&mut seed) as f32) } else { (rng(&mut seed) * vocab as f64) as u32 };
            }
            let mut prop = fake_prop(tokens, &mut seed);
            for i in 0..PROP {
                // draft table: the target's kept ids (shuffled probs) + noise
                for (j, &id) in dists[i].ids.iter().take(DTOPK).enumerate() {
                    if j > 0 {
                        prop.cand_ids[i][j] = id;
                    }
                }
            }
            let u: [f32; NU] = std::array::from_fn(|_| ((rng(&mut seed) * 16777216.0) as u32) as f32 * (1.0 / 16777216.0));
            // both acceptance rules on the same rows / proposal / uniforms
            for block in [false, true] {
                let pol = Policy { block, ..pol0 };
                let res = gpu_accept(&logits, 0, &pol, &prop, PROP, &u)?.to_vec1::<u32>()?;
                let gpu = decode_result(&res).expect("no overflow");
                let mut ui = 0;
                let mut draw = || {
                    ui += 1;
                    u[ui - 1]
                };
                let cpu = if block {
                    accept_block(&mut |i| dists[i].clone(), &prop, PROP, &mut draw)
                } else {
                    accept_chain(&mut |i| dists[i].clone(), &prop, PROP, &mut draw)
                };
                deep[block as usize] += (cpu.accepted == PROP) as usize;
                emitted[block as usize] += cpu.emitted.len();
                if gpu != cpu {
                    mismatches += 1;
                    eprintln!("trial {trial} k {k} renorm {} block {block}: gpu {gpu:?} cpu {cpu:?}", pol.renorm);
                }
            }
        }
        eprintln!("gpu_accept_matches_cpu_reference: 160 trials x 2 rules, {mismatches} mismatches, chains accepting all {PROP}: token {} block {}, tokens: token {} block {}", deep[0], deep[1], emitted[0], emitted[1]);
        assert_eq!(mismatches, 0);
        for r in 0..2 {
            assert!(deep[r] > 0 && emitted[r] > 160 * 2, "chains must run deep enough to exercise accept/residual/bonus");
        }
        Ok(())
    }
}
