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
pub fn global_z(l: &[f32], m: f32, inv_t: f32) -> f32 {
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
    uint vlen; uint k; uint renorm; uint pad0;
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
        pad0: u32,
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
            pad0: 0,
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
            let pol = Policy { k: 20, inv_t: 1.0 / 0.6, top_p: 0.95, renorm };
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
        let pol = Policy { k: 20, inv_t: 1.0 / 0.6, top_p: 0.95, renorm: true };
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
        let (mut deep, mut emitted) = (0usize, 0usize);
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
            let pol = Policy { k, inv_t: 1.0f32 / [0.6f32, 1.0, 0.3][trial % 3], top_p: [0.95f32, 1.0, 0.8][trial % 3], renorm: trial % 2 == 1 };
            let dists: Vec<RowDist> = rows_f32.iter().map(|l| cpu_row_dist(l, &pol)).collect();
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
            let res = gpu_accept(&logits, 0, &pol, &prop, PROP, &u)?.to_vec1::<u32>()?;
            let gpu = decode_result(&res).expect("no overflow");
            let mut ui = 0;
            let cpu = accept_chain(&mut |i| dists[i].clone(), &prop, PROP, &mut || {
                ui += 1;
                u[ui - 1]
            });
            deep += (cpu.accepted == PROP) as usize;
            emitted += cpu.emitted.len();
            if gpu != cpu {
                mismatches += 1;
                eprintln!("trial {trial} k {k} renorm {}: gpu {gpu:?} cpu {cpu:?}", pol.renorm);
            }
        }
        eprintln!("gpu_accept_matches_cpu_reference: 160 trials, {mismatches} mismatches, {deep} chains accepted all {PROP}, {emitted} tokens");
        assert_eq!(mismatches, 0);
        assert!(deep > 0 && emitted > 160 * 2, "chains must run deep enough to exercise accept/residual/bonus");
        Ok(())
    }
}
