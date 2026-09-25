//! Fused Metal kernels for MLX affine-quantized weights.
//!
//! The checkpoint stores projections as packed U32 nibbles + per-group
//! bf16 scales/biases (`w = q·scale + bias`, group = GS, LSB-first).
//! Dequantizing to bf16 up front makes decode bandwidth-bound — a 27B
//! model reads ~54GB of weights per token (~130ms at ~500GB/s → ~7 tok/s
//! wall regardless of dispatch count). These kernels read the packed
//! form directly (~14GB/token → ~4× headroom).
//!
//!   AffineQmv     (wq, sb, x) → y[out]      fused dequant-matvec (seq=1)
//!   AffineDequant (wq, sb)    → w[out,in]   packed→bf16 scratch for the
//!                                           prefill gemm path
//!
//! `sb` packs scales and biases as [out, 2*ng]: columns [0,ng) are
//! scales, [ng,2ng) biases.

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::{AffineDequant, AffineQmm, AffineQmpp, AffineQmppPrefill, AffineQmv, AffineQsg, mpp_probe};
#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::{pf_compile, pf_force_legacy, pf_route, pf_shapes, pf_warm, AffineQpf, PfCfg};

#[cfg(all(feature = "metal", target_os = "macos"))]
mod metal_impl {
    use candle_core::backend::BackendStorage;
    use candle_core::{
        CpuStorage, CustomOp2, CustomOp3, DType, Layout, MetalStorage,
        Result, Shape,
    };
    use candle_metal_kernels::metal::ComputePipeline;
    use candle_metal_kernels::utils::EncoderProvider;
    use objc2_metal::MTLSize;
    use std::sync::OnceLock;

    /// Packed dims for one affine-quantized `[out, in]` weight.
    /// `gs` is baked into the shader (power of two; 64 for MLX defaults).
    pub struct AffineQmv {
        pub inp: usize,
        pub out: usize,
        pub gs: usize,
        pub tiled: bool,
    }

    pub struct AffineDequant {
        pub inp: usize,
        pub out: usize,
        pub gs: usize,
        pub tiled: bool,
    }

    #[repr(C)]
    struct QParams {
        in_dim: i32,
        out_dim: i32,
        ng: i32,
        tiled: i32,
    }

    #[repr(C)]
    struct QmmParams {
        in_dim: i32,
        out_dim: i32,
        ng: i32,
        m: i32,
        tiled: i32,
    }

    /// Packed dims for `y[M,out] = x[M,in] @ W[out,in]` with W kept in
    /// packed affine form. M ≤ 8 (spec-decode verify, short batches).
    pub struct AffineQmm {
        pub inp: usize,
        pub out: usize,
        pub gs: usize,
        pub m: usize,
        pub tiled: bool,
    }

    // words per row = IN/8; GS % 8 == 0 so a word never spans groups.
    const QMV_SRC: &str = r#"
#include <metal_stdlib>
#include <metal_simdgroup_matrix>
using namespace metal;

struct QParams { int in_dim; int out_dim; int ng; int tiled; };
struct QmmParams { int in_dim; int out_dim; int ng; int m; int tiled; };
constant constexpr int GS = {GS};

// 8 output rows per threadgroup — one simdgroup (32 lanes) per row.
// Each lane reads uint4 (16B = 32 nibbles) so rows walk memory in wide
// strides; x is shared across the 8 rows via L1/L2.
// Weight word address: row-major `[row][g][i]` or Splash's tiled
// `[tile=row/256][g][col=row%256][i]` (each tile packs 256 rows' group
// chunks contiguously so a simdgroup's fragment loads are dense).
inline uint q4woff(uint row, uint g, uint i, uint words, uint ng,
                   uint tiled) {
    return tiled ? (row >> 8) * ng * 2048u + g * 2048u + (row & 255u) * 8u + i
                 : row * words + g * 8u + i;
}

// Scale/bias index — row-major sb[row][2ng] vs tiled
// [(tile*ng+g)*256 + col] with the bias plane at +tiles*ng*256.
inline ulong q4sb(uint row, uint g, uint ng, uint bias, uint out_dim,
                  uint tiled) {
    if (tiled) {
        const ulong tiles = ulong(out_dim + 255) >> 8;
        const ulong prm = (ulong(row >> 8) * ng + g) * 256 + (row & 255);
        return prm + ulong(bias) * tiles * ng * 256;
    }
    return ulong(row) * 2 * ng + ulong(bias) * ng + g;
}

kernel void affine_qmv(
    device const uint*   wq [[buffer(0)]],
    device const bfloat* sb [[buffer(1)]],
    device const bfloat* x  [[buffer(2)]],
    device bfloat*       y  [[buffer(3)]],
    constant QParams&    p  [[buffer(4)]],
    uint3 tgpos [[threadgroup_position_in_grid]],
    uint  lane  [[thread_index_in_simdgroup]],
    uint  sg    [[simdgroup_index_in_threadgroup]])
{
    const int row = tgpos.x * 8 + sg;
    if (row >= p.out_dim) return;
    const int words = p.in_dim / 8;      // u32 per row
    const int words4 = words / 4;        // uint4 per row
    const uint wbase = p.tiled
        ? (uint(row) >> 8) * p.ng * 2048u + (uint(row) & 255u) * 8u
        : uint(row) * words;

    float acc = 0.0f;
    for (int w4 = lane; w4 < words4; w4 += 32) {
        // uint4 w4 covers words w4*4..w4*4+3 = half of group w4/2
        const uint woff = p.tiled
            ? (uint(w4) >> 1) * 2048u + (uint(w4) & 1u) * 4u
            : uint(w4) * 4u;
        const uint4 pack =
            *reinterpret_cast<device const uint4*>(wq + wbase + woff);
        const int base = w4 * 32;
        // GS % 32 == 0 so a uint4 never spans a group boundary.
        const int g = base / GS;
        const float sc = float(sb[q4sb(row, g, p.ng, 0, p.out_dim, p.tiled)]);
        const float bi = float(sb[q4sb(row, g, p.ng, 1, p.out_dim, p.tiled)]);
        const uint pw[4] = {pack.x, pack.y, pack.z, pack.w};
        for (int wd = 0; wd < 4; ++wd) {
            const uint pk = pw[wd];
            const int cb = base + wd * 8;
            for (int nib = 0; nib < 8; ++nib) {
                const float w =
                    float((pk >> (nib * 4)) & 0xF) * sc + bi;
                acc += w * float(x[cb + nib]);
            }
        }
    }
    acc = simd_sum(acc);
    if (lane == 0) y[row] = bfloat(acc);
}

// ------------------------------------------------------------------
// Fragment-direct Q4 decode — ported from Splash's
// linear_q4_sgmatrix.metal (docs/splash, incoai/splash@134807b), adapted
// to our row-major packed layout.
//
// Lane->fragment mapping (from their driver probe): lane l holds
// M[fm][fn] and M[fm][fn+1] with
//   fm = (qid & 4) | ((lane >> 1) & 3),
//   fn = ((qid & 2) << 1) | ((lane & 1) << 1)
// Activations are pre-scattered by `affine_q4_prepare` into a per-group
// 512-bfloat table so each lane's B elements are one vec<bfloat,8> read,
// plus a per-group per-row sum used by the +128 offset trick:
//   (nibble | 0x4300) is bf16 (128 + q) exactly, so the MMA accumulates
//   (128+q)*x and the epilogue subtracts 128*sum(x) — scale/bias then
//   apply once per row per group, not per element.
// ------------------------------------------------------------------

constant constexpr int SG_TILE = 64;   // output rows per threadgroup

struct SGParams { int out_dim; int in_dim; int m; int splits; int aux; int tiled; };

inline uint2 sg_klogical(uint k) {
    const uint c = k >> 4, r = k & 15;
    return uint2((r >> 3) * 4 + (r & 3), 2 * c + ((r >> 2) & 1));
}

inline uint sg_xt_offset(uint j, uint kp, uint m) {
    return (((j >> 2) * 8 + kp) * 4 + (m >> 1)) * 8
         + (j & 3) * 2 + (m & 1);
}

// Scatter x[m, in] into the fragment table + compute per-group row sums.
// Grid: (in/64 * 2, 1) threadgroups of 128 — sg covers (group, row).
kernel void affine_q4_prepare(
    device const bfloat* x     [[buffer(0)]],
    device bfloat*       table [[buffer(1)]],
    device float*        sums  [[buffer(2)]],
    device atomic_uint*  ctrs  [[buffer(3)]],
    constant SGParams&   p     [[buffer(4)]],
    uint2 tg [[threadgroup_position_in_grid]],
    uint  sg [[simdgroup_index_in_threadgroup]],
    uint  lane [[thread_index_in_simdgroup]],
    uint  tid [[thread_index_in_threadgroup]])
{
    // zero the split-K arrival counters once — gate/up tiles are 32 rows
    const uint nctr =
        (p.out_dim + (p.aux ? 32 : SG_TILE) - 1) / (p.aux ? 32 : SG_TILE);
    if (p.splits > 1 && tg.x == 0) {
        for (uint i = tid; i < nctr; i += 128) {
            atomic_store_explicit(ctrs + i, 0u, memory_order_relaxed);
        }
    }
    const uint group = (tg.x * 4 + sg) / 8, row = (tg.x * 4 + sg) % 8;
    const uint ng = p.in_dim / 64;
    if (group >= ng) return;
    const uint offset = row * p.in_dim + group * 64 + 2 * lane;
    const bool live = (int)row < p.m;
    const bfloat a = live ? x[offset] : bfloat(0.0f);
    const bfloat b = live ? x[offset + 1] : bfloat(0.0f);
    const uint2 lo = sg_klogical(2 * lane);
    table[group * 512 + sg_xt_offset(lo.x, lo.y, row)] = a;
    table[group * 512 + sg_xt_offset(lo.x + 1, lo.y, row)] = b;
    const float sum = simd_sum(float(a) + float(b));
    if (lane == 0) sums[group * 8 + row] = sum;
}

// One 8x8x8 MMA on register operands; the persistent accumulator stays a
// plain float2 so the compiler never spills the fragment.
template <typename T>
__attribute__((always_inline)) inline void
sg_mma_acc(thread float2 &c, vec<T, 2> a, vec<T, 2> b) {
    simdgroup_matrix<T, 8, 8> A, B;
    simdgroup_matrix<float, 8, 8> C, D;
    reinterpret_cast<thread vec<T, 2> &>(A.thread_elements()) = a;
    reinterpret_cast<thread vec<T, 2> &>(B.thread_elements()) = b;
    reinterpret_cast<thread float2 &>(C.thread_elements()) = c;
    simdgroup_multiply_accumulate(D, A, B, C);
    c = reinterpret_cast<thread float2 &>(D.thread_elements());
}

// grid (ceil(out/64), splits, 1), 256 threads — 8 simdgroups, each owns
// 8 output rows (one fragment); more warps per tile for latency hiding.
kernel void affine_q4_sg8(
    device const uint*    wq    [[buffer(0)]],
    device const bfloat*  sb    [[buffer(1)]],
    device const bfloat*  table [[buffer(2)]],
    device const float*   sums  [[buffer(3)]],
    device bfloat*        y     [[buffer(4)]],
    device float*         part  [[buffer(5)]],
    device atomic_uint*   ctrs  [[buffer(6)]],
    constant SGParams&    p     [[buffer(7)]],
    uint3 tgpos [[threadgroup_position_in_grid]],
    uint  tid   [[thread_index_in_threadgroup]],
    uint  sg    [[simdgroup_index_in_threadgroup]],
    uint  lane  [[thread_index_in_simdgroup]],
    threadgroup uint*     arrival [[threadgroup(0)]])
{
    const uint ng = p.in_dim / 64;
    const uint words = p.in_dim / 8;
    const uint qid = lane >> 2;
    const uint fm = (qid & 4) | ((lane >> 1) & 3);
    const uint fn = ((qid & 2) << 1) | ((lane & 1) << 1);
    const uint c = fn / 2;
    const uint base = tgpos.x * SG_TILE + sg * 8;

    const uint first = tgpos.y * (ng / p.splits);
    const uint end = (tgpos.y + 1 == (uint)p.splits)
        ? ng : first + ng / p.splits;

    const uint row0 = base + fm;

    float2 acc = float2(0);
    float2 dot[2] = {float2(0), float2(0)};

    const bool live0 = row0 < (uint)p.out_dim;
    auto load = [&](uint g, thread uint2 &w)
        __attribute__((always_inline)) {
        w = live0 ? *reinterpret_cast<device const uint2 *>(
            wq + q4woff(row0, g, c * 2, words, ng, p.tiled)) : uint2(0);
    };
    uint2 wds;
    load(first, wds);
    for (uint g = first; g < end; ++g) {
        const float2 sum = float2(sums[g * 8 + fn], sums[g * 8 + fn + 1]);
        device const vec<bfloat, 8>* xt =
            reinterpret_cast<device const vec<bfloat, 8> *>(
                table + ulong(g) * 512);
        vec<bfloat, 8> bq[2];
        bq[0] = xt[fm * 4 + c];
        bq[1] = xt[(8 + fm) * 4 + c];
#pragma unroll
        for (uint j = 0; j < 8; ++j) {
            const bfloat2 b =
                reinterpret_cast<thread bfloat2 *>(&bq[j >> 2])[j & 3];
            const uint word = j < 4 ? wds.x : wds.y;
            const uint pair =
                ((word >> (4 * (j & 3))) & 0x000F000Fu) | 0x43004300u;
            if (j < 2) dot[j & 1] = float2(0);
            sg_mma_acc<bfloat>(dot[j & 1], as_type<bfloat2>(pair), b);
        }
        const float2 d0 = fma(-128.0f, sum, dot[0] + dot[1]);
        if (live0) {
            acc = fma(d0,
                float(sb[q4sb(row0, g, ng, 0, p.out_dim, p.tiled)]), acc);
            acc = fma(sum,
                float(sb[q4sb(row0, g, ng, 1, p.out_dim, p.tiled)]), acc);
        }
        if (g + 1 < end) load(g + 1, wds);
    }

    if (p.splits > 1) {
        const uint n = base + fm;
        if (n < (uint)p.out_dim) {
            device float* slot =
                part + ulong(tgpos.y) * 8 * p.out_dim + n;
            slot[fn * p.out_dim] = acc.x;
            slot[(fn + 1) * p.out_dim] = acc.y;
        }
        threadgroup_barrier(mem_flags::mem_device);
        if (tid == 0) {
            atomic_thread_fence(mem_flags::mem_device,
                                memory_order_seq_cst,
                                thread_scope::thread_scope_device);
            *arrival = atomic_fetch_add_explicit(
                ctrs + tgpos.x, 1u, memory_order_relaxed);
            atomic_thread_fence(mem_flags::mem_device,
                                memory_order_seq_cst,
                                thread_scope::thread_scope_device);
        }
        threadgroup_barrier(
            mem_flags::mem_threadgroup | mem_flags::mem_device);
        if (*arrival != (uint)p.splits - 1) return;
        float2 total = float2(0);
        for (uint s = 0; s < (uint)p.splits; ++s) {
            const uint n = base + fm;
            if (n >= (uint)p.out_dim) continue;
            device const float* slot =
                part + ulong(s) * 8 * p.out_dim + n;
            total += s == tgpos.y
                ? acc
                : float2(slot[fn * p.out_dim], slot[(fn + 1) * p.out_dim]);
        }
        acc = total;
    }
    const uint n = base + fm;
    if (n < (uint)p.out_dim) {
        if ((int)fn < p.m) y[fn * p.out_dim + n] = bfloat(acc.x);
        if ((int)fn + 1 < p.m)
            y[(fn + 1) * p.out_dim + n] = bfloat(acc.y);
    }
}

// grid (ceil(out/64), splits, 1), 128 threads — each simdgroup owns 16
// output rows (two 8-wide fragments nf=0/1).
kernel void affine_q4_sg(
    device const uint*    wq    [[buffer(0)]],   // [out][in/8] u32
    device const bfloat*  sb    [[buffer(1)]],   // [out][2*ng]
    device const bfloat*  table [[buffer(2)]],   // prepared x
    device const float*   sums  [[buffer(3)]],   // [ng][8]
    device bfloat*        y     [[buffer(4)]],   // [m][out]
    device float*         part  [[buffer(5)]],   // [splits][2][8][out]
    device atomic_uint*   ctrs  [[buffer(6)]],   // [ceil(out/64)]
    constant SGParams&    p     [[buffer(7)]],
    uint3 tgpos [[threadgroup_position_in_grid]],
    uint  tid   [[thread_index_in_threadgroup]],
    uint  sg    [[simdgroup_index_in_threadgroup]],
    uint  lane  [[thread_index_in_simdgroup]],
    threadgroup uint*     arrival [[threadgroup(0)]])
{
    const uint ng = p.in_dim / 64;
    const uint words = p.in_dim / 8;
    const uint qid = lane >> 2;
    const uint fm = (qid & 4) | ((lane >> 1) & 3);
    const uint fn = ((qid & 2) << 1) | ((lane & 1) << 1);
    const uint c = fn / 2;
    const uint base = tgpos.x * SG_TILE + sg * 16;

    const uint first = tgpos.y * (ng / p.splits);
    const uint end = (tgpos.y + 1 == (uint)p.splits)
        ? ng : first + ng / p.splits;

    const uint row0 = base + fm;
    const uint row1 = base + fm + 8;

    float2 acc[2] = {float2(0), float2(0)};
    float2 dot[2][2] = {{float2(0), float2(0)}, {float2(0), float2(0)}};

    // Row-major packed weights: row grow's group-g 32-byte chunk starts
    // at u32 word grow*words + g*8; the lane's uint2 sits at +c*2.
    const bool live0 = row0 < (uint)p.out_dim;
    const bool live1 = row1 < (uint)p.out_dim;
    auto load = [&](uint g, thread uint2 (&w)[2])
        __attribute__((always_inline)) {
        w[0] = live0 ? *reinterpret_cast<device const uint2 *>(
            wq + q4woff(row0, g, c * 2, words, ng, p.tiled)) : uint2(0);
        w[1] = live1 ? *reinterpret_cast<device const uint2 *>(
            wq + q4woff(row1, g, c * 2, words, ng, p.tiled)) : uint2(0);
    };
    uint2 wds[2];
    load(first, wds);
    for (uint g = first; g < end; ++g) {
        const float2 sum = float2(sums[g * 8 + fn], sums[g * 8 + fn + 1]);
        device const vec<bfloat, 8>* xt =
            reinterpret_cast<device const vec<bfloat, 8> *>(
                table + ulong(g) * 512);
        vec<bfloat, 8> bq[2];
        bq[0] = xt[fm * 4 + c];
        bq[1] = xt[(8 + fm) * 4 + c];
#pragma unroll
        for (uint j = 0; j < 8; ++j) {
            const bfloat2 b =
                reinterpret_cast<thread bfloat2 *>(&bq[j >> 2])[j & 3];
#pragma unroll
            for (uint nf = 0; nf < 2; ++nf) {
                const uint word = j < 4 ? wds[nf].x : wds[nf].y;
                const uint pair =
                    ((word >> (4 * (j & 3))) & 0x000F000Fu) | 0x43004300u;
                if (j < 2) dot[nf][j & 1] = float2(0);
                sg_mma_acc<bfloat>(dot[nf][j & 1], as_type<bfloat2>(pair), b);
            }
        }
        const float2 d0 =
            fma(-128.0f, sum, dot[0][0] + dot[0][1]);
        const float2 d1 =
            fma(-128.0f, sum, dot[1][0] + dot[1][1]);
        if (live0) {
            acc[0] = fma(d0,
                float(sb[q4sb(row0, g, ng, 0, p.out_dim, p.tiled)]),
                acc[0]);
            acc[0] = fma(sum,
                float(sb[q4sb(row0, g, ng, 1, p.out_dim, p.tiled)]),
                acc[0]);
        }
        if (live1) {
            acc[1] = fma(d1,
                float(sb[q4sb(row1, g, ng, 0, p.out_dim, p.tiled)]),
                acc[1]);
            acc[1] = fma(sum,
                float(sb[q4sb(row1, g, ng, 1, p.out_dim, p.tiled)]),
                acc[1]);
        }
        if (g + 1 < end) load(g + 1, wds);
    }

    if (p.splits > 1) {
        // publish this split's partials, last split reduces in order
#pragma unroll
        for (uint nf = 0; nf < 2; ++nf) {
            const uint n = base + nf * 8 + fm;
            if (n >= (uint)p.out_dim) continue;
            device float* slot =
                part + ulong(tgpos.y * 2 + nf) * 8 * p.out_dim + n;
            slot[fn * p.out_dim] = acc[nf].x;
            slot[(fn + 1) * p.out_dim] = acc[nf].y;
        }
        threadgroup_barrier(mem_flags::mem_device);
        if (tid == 0) {
            atomic_thread_fence(mem_flags::mem_device,
                                memory_order_seq_cst,
                                thread_scope::thread_scope_device);
            *arrival = atomic_fetch_add_explicit(
                ctrs + tgpos.x, 1u, memory_order_relaxed);
            atomic_thread_fence(mem_flags::mem_device,
                                memory_order_seq_cst,
                                thread_scope::thread_scope_device);
        }
        threadgroup_barrier(
            mem_flags::mem_threadgroup | mem_flags::mem_device);
        if (*arrival != (uint)p.splits - 1) return;
        float2 total[2] = {float2(0), float2(0)};
        for (uint s = 0; s < (uint)p.splits; ++s) {
#pragma unroll
            for (uint nf = 0; nf < 2; ++nf) {
                const uint n = base + nf * 8 + fm;
                if (n >= (uint)p.out_dim) continue;
                device const float* slot =
                    part + ulong(s * 2 + nf) * 8 * p.out_dim + n;
                total[nf] += s == tgpos.y
                    ? acc[nf]
                    : float2(slot[fn * p.out_dim], slot[(fn + 1) * p.out_dim]);
            }
        }
        acc[0] = total[0];
        acc[1] = total[1];
    }
#pragma unroll
    for (uint nf = 0; nf < 2; ++nf) {
        const uint n = base + nf * 8 + fm;
        const float2 value = acc[nf];
        if ((int)fn < p.m && n < (uint)p.out_dim)
            y[fn * p.out_dim + n] = bfloat(value.x);
        if ((int)fn + 1 < p.m && n < (uint)p.out_dim)
            y[(fn + 1) * p.out_dim + n] = bfloat(value.y);
    }
}

// Gate/up variant — the fused [gate | up] weight block supplies both
// streams: stream 0 = gate rows, stream 1 = up rows (at row + p.aux).
// Output = silu(gate) * up. Each simdgroup owns 8 rows, 32 rows per tg.
kernel void affine_q4_sg_gate_up(
    device const uint*    wq    [[buffer(0)]],   // [2*out][in/8] u32
    device const bfloat*  sb    [[buffer(1)]],   // [2*out][2*ng]
    device const bfloat*  table [[buffer(2)]],
    device const float*   sums  [[buffer(3)]],
    device bfloat*        y     [[buffer(4)]],   // [m][out]
    device float*         part  [[buffer(5)]],
    device atomic_uint*   ctrs  [[buffer(6)]],
    constant SGParams&    p     [[buffer(7)]],
    uint3 tgpos [[threadgroup_position_in_grid]],
    uint  tid   [[thread_index_in_threadgroup]],
    uint  sg    [[simdgroup_index_in_threadgroup]],
    uint  lane  [[thread_index_in_simdgroup]],
    threadgroup uint*     arrival [[threadgroup(0)]])
{
    const uint ng = p.in_dim / 64;
    const uint words = p.in_dim / 8;
    const uint qid = lane >> 2;
    const uint fm = (qid & 4) | ((lane >> 1) & 3);
    const uint fn = ((qid & 2) << 1) | ((lane & 1) << 1);
    const uint c = fn / 2;
    const uint base = tgpos.x * 32 + sg * 8;

    const uint first = tgpos.y * (ng / p.splits);
    const uint end = (tgpos.y + 1 == (uint)p.splits)
        ? ng : first + ng / p.splits;

    const uint grow = base + fm;          // gate row
    const uint urow = grow + p.aux;       // up row

    float2 acc[2] = {float2(0), float2(0)};
    float2 dot[2][2] = {{float2(0), float2(0)}, {float2(0), float2(0)}};

    const bool live0 = grow < (uint)p.out_dim;
    const bool live1 = urow < (uint)(p.out_dim + p.aux);
    auto load = [&](uint g, thread uint2 (&w)[2])
        __attribute__((always_inline)) {
        w[0] = live0 ? *reinterpret_cast<device const uint2 *>(
            wq + q4woff(grow, g, c * 2, words, ng, p.tiled)) : uint2(0);
        w[1] = live1 ? *reinterpret_cast<device const uint2 *>(
            wq + q4woff(urow, g, c * 2, words, ng, p.tiled)) : uint2(0);
    };
    uint2 wds[2];
    load(first, wds);
    for (uint g = first; g < end; ++g) {
        const float2 sum = float2(sums[g * 8 + fn], sums[g * 8 + fn + 1]);
        device const vec<bfloat, 8>* xt =
            reinterpret_cast<device const vec<bfloat, 8> *>(
                table + ulong(g) * 512);
        vec<bfloat, 8> bq[2];
        bq[0] = xt[fm * 4 + c];
        bq[1] = xt[(8 + fm) * 4 + c];
#pragma unroll
        for (uint j = 0; j < 8; ++j) {
            const bfloat2 b =
                reinterpret_cast<thread bfloat2 *>(&bq[j >> 2])[j & 3];
#pragma unroll
            for (uint nf = 0; nf < 2; ++nf) {
                const uint word = j < 4 ? wds[nf].x : wds[nf].y;
                const uint pair =
                    ((word >> (4 * (j & 3))) & 0x000F000Fu) | 0x43004300u;
                if (j < 2) dot[nf][j & 1] = float2(0);
                sg_mma_acc<bfloat>(dot[nf][j & 1], as_type<bfloat2>(pair), b);
            }
        }
        const float2 d0 =
            fma(-128.0f, sum, dot[0][0] + dot[0][1]);
        const float2 d1 =
            fma(-128.0f, sum, dot[1][0] + dot[1][1]);
        // the fused [gate|up] buffer's bias plane is sized by the FULL
        // row count (out_dim + aux) — both streams share it
        if (live0) {
            acc[0] = fma(d0,
                float(sb[q4sb(grow, g, ng, 0,
                             p.out_dim + p.aux, p.tiled)]),
                acc[0]);
            acc[0] = fma(sum,
                float(sb[q4sb(grow, g, ng, 1,
                             p.out_dim + p.aux, p.tiled)]),
                acc[0]);
        }
        if (live1) {
            acc[1] = fma(d1,
                float(sb[q4sb(urow, g, ng, 0,
                             p.out_dim + p.aux, p.tiled)]),
                acc[1]);
            acc[1] = fma(sum,
                float(sb[q4sb(urow, g, ng, 1,
                             p.out_dim + p.aux, p.tiled)]),
                acc[1]);
        }
        if (g + 1 < end) load(g + 1, wds);
    }

    if (p.splits > 1) {
#pragma unroll
        for (uint nf = 0; nf < 2; ++nf) {
            const uint n = base + fm;
            if (n >= (uint)p.out_dim) continue;
            device float* slot =
                part + ulong(tgpos.y * 2 + nf) * 8 * p.out_dim + n;
            slot[fn * p.out_dim] = acc[nf].x;
            slot[(fn + 1) * p.out_dim] = acc[nf].y;
        }
        threadgroup_barrier(mem_flags::mem_device);
        if (tid == 0) {
            atomic_thread_fence(mem_flags::mem_device,
                                memory_order_seq_cst,
                                thread_scope::thread_scope_device);
            *arrival = atomic_fetch_add_explicit(
                ctrs + tgpos.x, 1u, memory_order_relaxed);
            atomic_thread_fence(mem_flags::mem_device,
                                memory_order_seq_cst,
                                thread_scope::thread_scope_device);
        }
        threadgroup_barrier(
            mem_flags::mem_threadgroup | mem_flags::mem_device);
        if (*arrival != (uint)p.splits - 1) return;
        float2 total[2] = {float2(0), float2(0)};
        for (uint s = 0; s < (uint)p.splits; ++s) {
#pragma unroll
            for (uint nf = 0; nf < 2; ++nf) {
                const uint n = base + fm;
                if (n >= (uint)p.out_dim) continue;
                device const float* slot =
                    part + ulong(s * 2 + nf) * 8 * p.out_dim + n;
                total[nf] += s == tgpos.y
                    ? acc[nf]
                    : float2(slot[fn * p.out_dim], slot[(fn + 1) * p.out_dim]);
            }
        }
        acc[0] = total[0];
        acc[1] = total[1];
    }
    // out = silu(gate) * up  (Splash's exact form, exp2 fast-path)
    const uint n = base + fm;
    if (n < (uint)p.out_dim) {
        const float2 gate = acc[0], up = acc[1];
        const float2 value =
            gate / (1.0f + exp2(-1.4426f * gate)) * up;
        if ((int)fn < p.m) y[fn * p.out_dim + n] = bfloat(value.x);
        if ((int)fn + 1 < p.m)
            y[(fn + 1) * p.out_dim + n] = bfloat(value.y);
    }
}

// Batched variant for verify/short-batch forwards: one threadgroup per
// output row, M token rows per pass — the packed weight is read once no
// matter how many tokens we verify. M ≤ 8 accumulators in registers.
kernel void affine_qmm(
    device const uint*   wq [[buffer(0)]],
    device const bfloat* sb [[buffer(1)]],
    device const bfloat* x  [[buffer(2)]],   // [M, in_dim]
    device bfloat*       y  [[buffer(3)]],   // [M, out_dim]
    constant QmmParams&  p  [[buffer(4)]],
    uint3 tgpos [[threadgroup_position_in_grid]],
    uint  tid   [[thread_index_in_threadgroup]],
    uint  lane  [[thread_index_in_simdgroup]],
    uint  sg    [[simdgroup_index_in_threadgroup]])
{
    const int row = tgpos.x;
    const int words = p.in_dim / 8;

    // NB: the m-loops use constant bounds + a guard so `acc` stays in
    // registers — a runtime `p.m` bound spills it to local memory.
    // x is read as uint4 (8 bf16) once per token-row per weight word:
    // scalar loads here made the multi-row pass ~6x slower than qmv.
    float acc[8];
    for (int m = 0; m < 8; ++m) acc[m] = 0.0f;

    for (int wd = tid; wd < words; wd += 256) {
        const uint pack = wq[q4woff(row, uint(wd) >> 3, uint(wd) & 7u,
                                    words, p.ng, p.tiled)];
        const int base = wd * 8;
        const int g = base / GS;
        const float sc = float(sb[q4sb(row, g, p.ng, 0, p.out_dim, p.tiled)]);
        const float bi = float(sb[q4sb(row, g, p.ng, 1, p.out_dim, p.tiled)]);
        float ws[8];
        #pragma clang loop unroll(full)
        for (int nib = 0; nib < 8; ++nib)
            ws[nib] = float((pack >> (nib * 4)) & 0xF) * sc + bi;
        const int w4 = wd; // uint4 index into each x row
        #pragma clang loop unroll(full)
        for (int m = 0; m < 8; ++m) {
            if (m >= p.m) break;
            const uint4 xw =
                ((device const uint4*)(x + m * p.in_dim))[w4];
            const float2 x0 = float2(as_type<bfloat2>(xw.x));
            const float2 x1 = float2(as_type<bfloat2>(xw.y));
            const float2 x2 = float2(as_type<bfloat2>(xw.z));
            const float2 x3 = float2(as_type<bfloat2>(xw.w));
            acc[m] += ws[0] * x0.x + ws[1] * x0.y + ws[2] * x1.x +
                      ws[3] * x1.y + ws[4] * x2.x + ws[5] * x2.y +
                      ws[6] * x3.x + ws[7] * x3.y;
        }
    }
    threadgroup float red[64]; // [8 sg][8 m]
    #pragma clang loop unroll(full)
    for (int m = 0; m < 8; ++m) {
        acc[m] = simd_sum(acc[m]);
        if (lane == 0) red[sg * 8 + m] = acc[m];
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tid == 0) {
        for (int m = 0; m < p.m; ++m) {
            float t = 0.0f;
            for (int j = 0; j < 8; ++j) t += red[j * 8 + m];
            y[m * p.out_dim + row] = bfloat(t);
        }
    }
}

// one threadgroup (256 threads) per output row — the v1 layout.
kernel void affine_qmv_v1(
    device const uint*   wq [[buffer(0)]],
    device const bfloat* sb [[buffer(1)]],
    device const bfloat* x  [[buffer(2)]],
    device bfloat*       y  [[buffer(3)]],
    constant QParams&    p  [[buffer(4)]],
    uint3 tgpos [[threadgroup_position_in_grid]],
    uint  tid   [[thread_index_in_threadgroup]],
    uint  lane  [[thread_index_in_simdgroup]],
    uint  sg    [[simdgroup_index_in_threadgroup]])
{
    const int row = tgpos.x;
    const int words = p.in_dim / 8;
    device const uint* wrow = wq + row * words;
    device const bfloat* srow = sb + row * 2 * p.ng;

    float acc = 0.0f;
    for (int wd = tid; wd < words; wd += 256) {
        const uint pack = wq[q4woff(row, uint(wd) >> 3, uint(wd) & 7u,
                                    words, p.ng, p.tiled)];
        const int base = wd * 8;
        const int g = base / GS;
        const float sc = float(sb[q4sb(row, g, p.ng, 0, p.out_dim, p.tiled)]);
        const float bi = float(sb[q4sb(row, g, p.ng, 1, p.out_dim, p.tiled)]);
        for (int nib = 0; nib < 8; ++nib) {
            const float w =
                float((pack >> (nib * 4)) & 0xF) * sc + bi;
            acc += w * float(x[base + nib]);
        }
    }
    acc = simd_sum(acc);
    threadgroup float red[8];
    if (lane == 0) red[sg] = acc;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tid == 0) {
        float t = red[0] + red[1] + red[2] + red[3]
                + red[4] + red[5] + red[6] + red[7];
        y[row] = bfloat(t);
    }
}
"#;

    const DEQ_SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct QParams { int in_dim; int out_dim; int ng; int tiled; };
constant constexpr int GS = {GS};

inline uint q4woff_d(uint row, uint g, uint i, uint words, uint ng,
                     uint tiled) {
    return tiled ? (row >> 8) * ng * 2048u + g * 2048u + (row & 255u) * 8u + i
                 : row * words + g * 8u + i;
}
inline ulong q4sb_d(uint row, uint g, uint ng, uint bias, uint out_dim,
                    uint tiled) {
    if (tiled) {
        const ulong tiles = ulong(out_dim + 255) >> 8;
        const ulong prm = (ulong(row >> 8) * ng + g) * 256 + (row & 255);
        return prm + ulong(bias) * tiles * ng * 256;
    }
    return ulong(row) * 2 * ng + ulong(bias) * ng + g;
}

kernel void affine_dequant(
    device const uint*   wq [[buffer(0)]],
    device const bfloat* sb [[buffer(1)]],
    device bfloat*       y  [[buffer(2)]],
    constant QParams&    p  [[buffer(3)]],
    uint idx [[thread_position_in_grid]])
{
    if (idx >= (uint)(p.in_dim * p.out_dim)) return;
    const int row = idx / p.in_dim;
    const int col = idx % p.in_dim;
    const uint pack = wq[q4woff_d(row, uint(col) >> 6, (uint(col) >> 3) & 7u,
                                  p.in_dim / 8, p.ng, p.tiled)];
    const float q = float((pack >> ((col % 8) * 4)) & 0xF);
    const int g = col / GS;
    y[idx] = bfloat(q * float(sb[q4sb_d(row, g, p.ng, 0, p.out_dim, p.tiled)])
                    + float(sb[q4sb_d(row, g, p.ng, 1, p.out_dim, p.tiled)]));
}
"#;

    // ------------------------------------------------------------------
    // Cooperative-tensor decode family — ported from Splash's
    // q4_mpp_tiles.h / linear_q4.metal (incoai/splash@134807b), their
    // Apple10 path. matmul2d runs uint4b weight fragments against bf16
    // activations directly; the epilogue applies scale/bias once per
    // quant group using per-group input sums staged in threadgroup
    // memory. Requires Metal 4 (MTLLanguageVersion 4.0) and the tiled
    // [tile][group][col] weight layout (QLin::tiled).
    // ------------------------------------------------------------------
    const MPP_SRC: &str = r#"
#include <MetalPerformancePrimitives/MetalPerformancePrimitives.h>
#include <metal_stdlib>
using namespace metal;
using namespace mpp::tensor_ops;

struct MppParams {
    int out_dim;   // logical output rows
    int in_dim;
    int m;         // live token rows (<= 8)
    int groups;    // persistent threadgroups launched
    int bias_base; // bf16 index of the bias plane in sb
    int up_woff;   // byte offset of the up weight tiles (gate_up)
    int up_soff;   // bf16 offset of the up scale/bias planes
};

// -- ported helpers (verbatim semantics) ---------------------------------

enum class Q4Traversal : ushort {
  All, FourOfEight, PrefixAndFourOfEight, HalfPrefix, Guarded
};

template <class Tensor>
__attribute__((always_inline)) inline Q4Traversal
q4_traversal(const thread Tensor &values) {
  const ushort capacity = values.get_capacity();
  bool all = true;
  bool halfPrefix = capacity != 0 && (capacity % 2) == 0;
  bool striped = capacity != 0 && (capacity % 8) == 0;
  bool prefixed = capacity != 0 && (capacity % 16) == 0;
#pragma unroll
  for (ushort i = 0; i < capacity; ++i) {
    const bool valid = values.is_valid_element(i);
    all &= valid;
    halfPrefix &= valid == (i < capacity / 2);
    striped &= valid == ((i & 7) < 4);
    prefixed &= valid == (i < capacity / 2 || ((i & 7) < 4));
  }
  return all ? Q4Traversal::All : striped ? Q4Traversal::FourOfEight
       : prefixed ? Q4Traversal::PrefixAndFourOfEight
       : halfPrefix ? Q4Traversal::HalfPrefix : Q4Traversal::Guarded;
}

template <class Tensor, class Body>
__attribute__((always_inline)) inline void
q4_visit(const thread Tensor &values, Q4Traversal traversal,
         const thread Body &body) {
  if (traversal == Q4Traversal::All) {
#pragma unroll
    for (ushort i = 0; i < values.get_capacity(); ++i) body(i);
  } else if (traversal == Q4Traversal::FourOfEight) {
#pragma unroll
    for (ushort i = 0; i < values.get_capacity() / 2; ++i)
      body(ushort((i / 4) * 8 + i % 4));
  } else if (traversal == Q4Traversal::PrefixAndFourOfEight) {
#pragma unroll
    for (ushort i = 0; i < values.get_capacity() / 2; ++i) body(i);
#pragma unroll
    for (ushort i = 0; i < values.get_capacity() / 4; ++i)
      body(ushort(values.get_capacity() / 2 + (i / 4) * 8 + i % 4));
  } else if (traversal == Q4Traversal::HalfPrefix) {
#pragma unroll
    for (ushort i = 0; i < values.get_capacity() / 2; ++i) body(i);
  } else {
#pragma unroll
    for (ushort i = 0; i < values.get_capacity(); ++i)
      if (values.is_valid_element(i)) body(i);
  }
}

template <ushort Rows = 8, ushort Simdgroups = 8>
inline void q4_store_input_sums(device const bfloat *input, uint input_size,
                                uint input_origin, threadgroup float *sums,
                                uint sum_origin, uint simd_lane,
                                uint simd_group) {
  for (uint row = simd_group; row < Rows; row += Simdgroups) {
    uint origin = row * input_size + input_origin + simd_lane;
    float first = simd_sum(float(input[origin]) + float(input[origin + 32]));
    float second =
        simd_sum(float(input[origin + 64]) + float(input[origin + 96]));
    float third =
        simd_sum(float(input[origin + 128]) + float(input[origin + 160]));
    float fourth =
        simd_sum(float(input[origin + 192]) + float(input[origin + 224]));
    if (simd_lane == 0) {
      sums[sum_origin + row] = first;
      sums[sum_origin + Rows + row] = second;
      sums[sum_origin + 2 * Rows + row] = third;
      sums[sum_origin + 3 * Rows + row] = fourth;
    }
  }
}

// q4_mpp_tile<256, GateUp, Residual=false, StorageN=256, Pipelined, Sg>
// with a padded-row output guard (our out_dim need not be 256-aligned).
template <bool GateUp, ushort Simdgroups>
inline void th_mpp_tile(device bfloat *input, device uchar *weights_0,
                        device bfloat *scales_0, device bfloat *biases_0,
                        device bfloat *output_0,
                        device uchar *weights_1, device bfloat *scales_1,
                        device bfloat *biases_1,
                        uint output_size, uint input_size, uint m,
                        threadgroup float *input_sums, uint output_origin,
                        uint simd_lane, uint simd_group) {
  constexpr ushort TileN = 256, StorageN = 256;
  auto a = tensor(input, dextents<int, 2>{int(input_size), 8},
                  array<int, 2>{1, int(input_size)});
  constexpr auto descriptor =
      matmul2d_descriptor(8, TileN, 64, false, true, false);
  matmul2d<descriptor, execution_simdgroups<Simdgroups>> operation;
  auto a0 = a.slice<64, 8>(0, 0);
  uint quant_groups = input_size / 64;
  uint tile = output_origin / StorageN;
  uint tile_offset = output_origin % StorageN;
  device uchar *tile_weights_0 =
      weights_0 + ulong(tile) * quant_groups * StorageN * 64 / 2;
  device uchar *tile_weights_1 =
      weights_1 + ulong(tile) * quant_groups * StorageN * 64 / 2;
  tensor<device uint4b_format, dextents<int, 2>, tensor_inline> first_b0(
      tile_weights_0 + tile_offset * 32, dextents<int, 2>{64, TileN},
      array<int, 2>{1, 64});
  tensor<device uint4b_format, dextents<int, 2>, tensor_inline> first_b1(
      tile_weights_1 + tile_offset * 32, dextents<int, 2>{64, TileN},
      array<int, 2>{1, 64});
  auto b00 = first_b0.slice<64, TileN>(0, 0);
  auto b10 = first_b1.slice<64, TileN>(0, 0);
  auto accumulated_0 = operation.template get_destination_cooperative_tensor<
      decltype(a0), decltype(b00), float>();
  auto accumulated_1 = operation.template get_destination_cooperative_tensor<
      decltype(a0), decltype(b10), float>();
  const bool fullyOccupied =
      uint(accumulated_0.get_capacity()) * (uint(Simdgroups) * 32u) ==
      8u * TileN;
  const auto traversal = fullyOccupied ? Q4Traversal::All
                                       : q4_traversal(accumulated_0);
  q4_visit(accumulated_0, traversal, [&](ushort i) {
    accumulated_0[i] = 0.0f;
    if constexpr (GateUp)
      accumulated_1[i] = 0.0f;
  });

  q4_store_input_sums<8, Simdgroups>(input, input_size, 0, input_sums, 0,
                                     simd_lane, simd_group);
  threadgroup_barrier(mem_flags::mem_threadgroup);
  auto run_group = [&](uint quant_group,
                       thread decltype(accumulated_0) &partial_0,
                       thread decltype(accumulated_1) &partial_1) {
    uint input_origin = quant_group * 64;
    auto a_slice = a.slice<64, 8>(input_origin, 0);
    device uchar *group_weights_0 =
        tile_weights_0 + (ulong(quant_group) * StorageN + tile_offset) * 64 / 2;
    tensor<device uint4b_format, dextents<int, 2>, tensor_inline> b0(
        group_weights_0, dextents<int, 2>{64, TileN}, array<int, 2>{1, 64});
    auto b0_slice = b0.slice<64, TileN>(0, 0);
    operation.run(a_slice, b0_slice, partial_0);
    device uchar *group_weights_1 =
        tile_weights_1 + (ulong(quant_group) * StorageN + tile_offset) * 64 / 2;
    tensor<device uint4b_format, dextents<int, 2>, tensor_inline> b1(
        group_weights_1, dextents<int, 2>{64, TileN}, array<int, 2>{1, 64});
    auto b1_slice = b1.slice<64, TileN>(0, 0);
    if constexpr (GateUp)
      operation.run(a_slice, b1_slice, partial_1);
  };
  auto finish_group = [&](uint quant_group,
                          thread decltype(accumulated_0) &partial_0,
                          thread decltype(accumulated_1) &partial_1) {
    q4_visit(accumulated_0, traversal,
             [&](ushort i) __attribute__((always_inline)) {
      auto index = accumulated_0.get_multidimensional_index(i);
      uint row = index[1];
      ulong parameter = (ulong(tile) * quant_groups + quant_group) * StorageN +
                        tile_offset + index[0];
      uint sum_offset = ((quant_group >> 2) & 1) * 32 + (quant_group & 3) * 8;
      accumulated_0[i] +=
          partial_0[i] * float(scales_0[parameter]) +
          input_sums[sum_offset + row] * float(biases_0[parameter]);
      if constexpr (GateUp) {
        accumulated_1[i] +=
            partial_1[i] * float(scales_1[parameter]) +
            input_sums[sum_offset + row] * float(biases_1[parameter]);
      }
    });
    if ((quant_group & 3) == 3 && quant_group + 1 < quant_groups) {
      uint next_group = (quant_group + 1) >> 2;
      q4_store_input_sums<8, Simdgroups>(input, input_size,
                                         quant_group * 64 + 64, input_sums,
                                         (next_group & 1) * 32, simd_lane,
                                         simd_group);
      threadgroup_barrier(mem_flags::mem_threadgroup);
    }
  };
  // Pipelined: two quant groups' matmuls in flight.
  uint quant_group = 0;
  for (; quant_group + 1 < quant_groups; quant_group += 2) {
    decltype(accumulated_0) first_0, second_0;
    decltype(accumulated_1) first_1, second_1;
    run_group(quant_group, first_0, first_1);
    run_group(quant_group + 1, second_0, second_1);
    finish_group(quant_group, first_0, first_1);
    finish_group(quant_group + 1, second_0, second_1);
  }
  if (quant_group < quant_groups) {
    decltype(accumulated_0) partial_0;
    decltype(accumulated_1) partial_1;
    run_group(quant_group, partial_0, partial_1);
    finish_group(quant_group, partial_0, partial_1);
  }

  q4_visit(accumulated_0, traversal, [&](ushort i) {
    auto index = accumulated_0.get_multidimensional_index(i);
    // padded rows/columns are computed but never stored
    if (output_origin + index[0] >= output_size || index[1] >= m) return;
    uint output_index = index[1] * output_size + output_origin + index[0];
    float value;
    if constexpr (GateUp) {
      float gate = float(bfloat(accumulated_0[i]));
      float up = float(bfloat(accumulated_1[i]));
      value = gate / (1.0f + fast::exp2(-1.44269504089f * gate)) * up;
    } else {
      value = float(bfloat(accumulated_0[i]));
    }
    output_0[output_index] = bfloat(value);
  });
  threadgroup_barrier(mem_flags::mem_threadgroup);
}

// Pad x [m][in] to the [m_pad][in] activation block the tiles read.
kernel void affine_q4_mpp_pad(device const bfloat* x [[buffer(0)]],
                              device bfloat* x8      [[buffer(1)]],
                              constant int3&  dims   [[buffer(2)]],
                              uint i [[thread_position_in_grid]]) {
    const int total = dims.z * dims.y;
    if ((int)i >= total) return;
    const int row = i / dims.y;
    x8[i] = row < dims.x ? x[i] : bfloat(0);
}

// ------------------------------------------------------------------
// Prefill family — ported from prefill/linear_q4.metal: a sums pass
// computes per-(row,quant-group) input sums once per 32-row block, then
// each (row_tile, output_tile) threadgroup runs a cooperative 32 x 256
// matmul over uint4b weights with staged sums and a fused epilogue.
// ------------------------------------------------------------------

constant constexpr ushort PrefillSumBatch = 256;

kernel void affine_q4_mpp_pf_sums(device const bfloat *input [[buffer(0)]],
                                  device float *sums [[buffer(1)]],
                                  constant int& in_dim [[buffer(2)]],
                                  uint tile [[threadgroup_position_in_grid]],
                                  uint simd_lane [[thread_index_in_simdgroup]],
                                  uint simd_group
                                  [[simdgroup_index_in_threadgroup]]) {
  constexpr uint TileM = 32;
  uint quant_groups = uint(in_dim) / 64;
  input += ulong(tile) * TileM * in_dim;
  sums += ulong(tile) * TileM * quant_groups;
  for (uint quant_group = 0; quant_group < quant_groups; ++quant_group) {
    for (uint row = simd_group; row < TileM; row += 8) {
      uint origin = row * in_dim + quant_group * 64 + simd_lane;
      float sum = simd_sum(float(input[origin]) + float(input[origin + 32]));
      if (simd_lane == 0) {
        sums[quant_group * TileM + row] = sum;
      }
    }
  }
}

// q4_mpp_prefill_tile<32, 256, 8, AddResidual=false, MultiplySiluGate>
// verbatim — staged sums variant.
template <bool MultiplySiluGate>
inline void th_mpp_prefill_tile(device bfloat *input, device uchar *weights,
                                device bfloat *scales, device bfloat *biases,
                                device bfloat *output, device bfloat *auxiliary,
                                uint output_size, uint input_size,
                                device const float *precomputed_sums,
                                uint output_origin, uint simd_lane,
                                uint simd_group,
                                threadgroup float *input_sums) {
  constexpr ushort TileM = 32, TileN = 256, Simdgroups = 8;
  auto a = tensor(input, dextents<int, 2>{int(input_size), TileM},
                  array<int, 2>{1, int(input_size)});
  auto c = tensor(output, dextents<int, 2>{int(output_size), TileM},
                  array<int, 2>{1, int(output_size)});
  constexpr auto descriptor =
      matmul2d_descriptor(TileM, TileN, 64, false, true, false);
  matmul2d<descriptor, execution_simdgroups<Simdgroups>> operation;
  auto a0 = a.slice<64, TileM>(0, 0);
  uint quant_groups = input_size / 64;
  constexpr ushort WeightTileN = 256;
  uint tile = output_origin / WeightTileN;
  uint tile_column = output_origin % WeightTileN;
  device uchar *tile_weights =
      weights +
      (ulong(tile) * quant_groups * WeightTileN + tile_column) * 64 / 2;
  tensor<device uint4b_format, dextents<int, 2>, tensor_inline> first_b(
      tile_weights, dextents<int, 2>{64, TileN}, array<int, 2>{1, 64});
  auto b0 = first_b.slice<64, TileN>(0, 0);
  auto accumulated = operation.template get_destination_cooperative_tensor<
      decltype(a0), decltype(b0), float>();
#pragma unroll
  for (ushort i = 0; i < accumulated.get_capacity(); ++i) {
    accumulated[i] = 0.0f;
  }

  auto load_sums = [&](uint start) {
    uint count = min(uint(PrefillSumBatch), quant_groups - start);
    uint thread_index = simd_group * 32 + simd_lane;
    for (uint index = thread_index; index < count * TileM;
         index += Simdgroups * 32) {
      uint quant_group = start + index / TileM;
      uint row = index % TileM;
      input_sums[index] = precomputed_sums[quant_group * TileM + row];
    }
  };
  load_sums(0);
  threadgroup_barrier(mem_flags::mem_threadgroup);

  for (uint quant_group = 0; quant_group < quant_groups; ++quant_group) {
    uint input_origin = quant_group * 64;
    auto a_slice = a.slice<64, TileM>(input_origin, 0);
    device uchar *group_weights =
        tile_weights + ulong(quant_group) * WeightTileN * 64 / 2;
    tensor<device uint4b_format, dextents<int, 2>, tensor_inline> b(
        group_weights, dextents<int, 2>{64, TileN}, array<int, 2>{1, 64});
    auto b_slice = b.slice<64, TileN>(0, 0);
    auto partial = operation.template get_destination_cooperative_tensor<
        decltype(a_slice), decltype(b_slice), float>();
    operation.run(a_slice, b_slice, partial);

#pragma unroll
    for (ushort i = 0; i < accumulated.get_capacity(); ++i) {
      auto index = accumulated.get_multidimensional_index(i);
      uint row = index[1];
      ulong parameter =
          (ulong(tile) * quant_groups + quant_group) * WeightTileN +
          tile_column + index[0];
      float sum =
          input_sums[(quant_group % PrefillSumBatch) * TileM + row];
      accumulated[i] += partial[i] * float(scales[parameter]) +
                        sum * float(biases[parameter]);
    }
    if (quant_group % PrefillSumBatch == PrefillSumBatch - 1 &&
        quant_group + 1 < quant_groups) {
      threadgroup_barrier(mem_flags::mem_threadgroup);
      load_sums(quant_group + 1);
      threadgroup_barrier(mem_flags::mem_threadgroup);
    }
  }

  auto converted = operation.template get_destination_cooperative_tensor<
      decltype(a0), decltype(b0), bfloat>();
#pragma unroll
  for (ushort i = 0; i < accumulated.get_capacity(); ++i) {
    float value = float(bfloat(accumulated[i]));
    if constexpr (MultiplySiluGate) {
      auto index = accumulated.get_multidimensional_index(i);
      float gate =
          float(auxiliary[index[1] * output_size + output_origin + index[0]]);
      value = gate / (1.0f + fast::exp2(-1.44269504089f * gate)) * value;
    }
    converted[i] = bfloat(value);
  }
  converted.store(c.slice<TileN, TileM>(output_origin, 0));
}

#define TH_PREFILL_ENTRY(Name, SiluGate)                                      \
kernel void Name(                                                             \
    device const bfloat* input  [[buffer(0)]],                                \
    device const uchar*  weights [[buffer(1)]],                               \
    device const bfloat* sb      [[buffer(2)]],                               \
    device bfloat*       aux     [[buffer(3)]],                               \
    device bfloat*       output  [[buffer(4)]],                               \
    device const float*  sums    [[buffer(5)]],                               \
    constant MppParams&  p       [[buffer(6)]],                               \
    uint2 group     [[threadgroup_position_in_grid]],                         \
    uint simd_lane  [[thread_index_in_simdgroup]],                            \
    uint simd_group [[simdgroup_index_in_threadgroup]]) {                     \
  constexpr ushort TileM = 32;                                                \
  threadgroup float input_sums[TileM * PrefillSumBatch];                      \
  device const float* rs = sums +                                             \
      ulong(group.x) * TileM * (uint(p.in_dim) / 64);                         \
  device bfloat* inp = const_cast<device bfloat*>(input) +                    \
      ulong(group.x) * TileM * p.in_dim;                                      \
  device bfloat* outp = output + ulong(group.x) * TileM * p.out_dim;          \
  device uchar* w = const_cast<device uchar*>(weights) + p.up_woff;           \
  device bfloat* sc = const_cast<device bfloat*>(sb) + p.up_soff;             \
  device bfloat* bi = const_cast<device bfloat*>(sb) + p.bias_base            \
                      + p.up_soff;                                            \
  device bfloat* auxp = aux + ulong(group.x) * TileM * p.out_dim;             \
  th_mpp_prefill_tile<SiluGate>(inp, w, sc, bi, outp, auxp,                   \
      p.out_dim, p.in_dim, rs, group.y * 256, simd_lane, simd_group,          \
      input_sums);                                                          \
}

TH_PREFILL_ENTRY(affine_q4_mpp_prefill,    false)
TH_PREFILL_ENTRY(affine_q4_mpp_prefill_up, true)

// Split-K form (ported q4_mpp_tile_split): each partition of Simdgroups
// simdgroups streams an equal quant-group range of one 8 x TileN tile and
// leaves fp32 partials in threadgroup memory; the caller reduces + applies
// the epilogue. Fills the GPU on projections whose tile count is below the
// core count. Requires in % (256*SplitK) == 0.
template <ushort TileN, bool GateUp, ushort Simdgroups, ushort SplitK>
inline void th_mpp_tile_split(
    device bfloat *input, device uchar *weights_0,
    device bfloat *scales_0, device bfloat *biases_0,
    threadgroup float *partials,
    device uchar *weights_1, device bfloat *scales_1,
    device bfloat *biases_1, uint input_size,
    threadgroup float *input_sums, uint output_origin,
    uint simd_lane, uint simd_group, uint partition) {
  constexpr ushort StorageN = 256;
  auto a = tensor(input, dextents<int, 2>{int(input_size), 8},
                  array<int, 2>{1, int(input_size)});
  constexpr auto descriptor =
      matmul2d_descriptor(8, TileN, 64, false, true, false);
  matmul2d<descriptor, execution_simdgroups<Simdgroups>> operation;
  auto a0 = a.slice<64, 8>(0, 0);
  uint total_quant_groups = input_size / 64;
  uint quant_groups = total_quant_groups / SplitK;
  uint first_group = partition * quant_groups;
  uint tile = output_origin / StorageN;
  uint tile_offset = output_origin % StorageN;
  device uchar *tile_weights_0 =
      weights_0 +
      (ulong(tile) * total_quant_groups + first_group) * StorageN * 64 / 2;
  device uchar *tile_weights_1 =
      weights_1 +
      (ulong(tile) * total_quant_groups + first_group) * StorageN * 64 / 2;
  tensor<device uint4b_format, dextents<int, 2>, tensor_inline> first_b0(
      tile_weights_0 + tile_offset * 32, dextents<int, 2>{64, TileN},
      array<int, 2>{1, 64});
  tensor<device uint4b_format, dextents<int, 2>, tensor_inline> first_b1(
      tile_weights_1 + tile_offset * 32, dextents<int, 2>{64, TileN},
      array<int, 2>{1, 64});
  auto b00 = first_b0.slice<64, TileN>(0, 0);
  auto b10 = first_b1.slice<64, TileN>(0, 0);
  auto accumulated_0 = operation.template get_destination_cooperative_tensor<
      decltype(a0), decltype(b00), float>();
  auto accumulated_1 = operation.template get_destination_cooperative_tensor<
      decltype(a0), decltype(b10), float>();
  const bool fullyOccupied =
      uint(accumulated_0.get_capacity()) * (uint(Simdgroups) * 32u) ==
      8u * TileN;
  const auto traversal = fullyOccupied ? Q4Traversal::All
                                       : q4_traversal(accumulated_0);
  q4_visit(accumulated_0, traversal, [&](ushort i) {
    accumulated_0[i] = 0.0f;
    if constexpr (GateUp)
      accumulated_1[i] = 0.0f;
  });

  q4_store_input_sums<8, Simdgroups>(input, input_size, first_group * 64,
                                     input_sums, 0, simd_lane, simd_group);
  threadgroup_barrier(mem_flags::mem_threadgroup);
  auto run_group = [&](uint quant_group,
                       thread decltype(accumulated_0) &partial_0,
                       thread decltype(accumulated_1) &partial_1) {
    uint input_origin = (first_group + quant_group) * 64;
    auto a_slice = a.slice<64, 8>(input_origin, 0);
    device uchar *group_weights_0 =
        tile_weights_0 + (ulong(quant_group) * StorageN + tile_offset) * 64 / 2;
    tensor<device uint4b_format, dextents<int, 2>, tensor_inline> b0(
        group_weights_0, dextents<int, 2>{64, TileN}, array<int, 2>{1, 64});
    auto b0_slice = b0.slice<64, TileN>(0, 0);
    operation.run(a_slice, b0_slice, partial_0);
    device uchar *group_weights_1 =
        tile_weights_1 + (ulong(quant_group) * StorageN + tile_offset) * 64 / 2;
    tensor<device uint4b_format, dextents<int, 2>, tensor_inline> b1(
        group_weights_1, dextents<int, 2>{64, TileN}, array<int, 2>{1, 64});
    auto b1_slice = b1.slice<64, TileN>(0, 0);
    if constexpr (GateUp)
      operation.run(a_slice, b1_slice, partial_1);
  };
  auto finish_group = [&](uint quant_group,
                          thread decltype(accumulated_0) &partial_0,
                          thread decltype(accumulated_1) &partial_1) {
    q4_visit(accumulated_0, traversal,
             [&](ushort i) __attribute__((always_inline)) {
      auto index = accumulated_0.get_multidimensional_index(i);
      uint row = index[1];
      ulong parameter =
          (ulong(tile) * total_quant_groups + first_group + quant_group) *
              StorageN + tile_offset + index[0];
      uint sum_offset = ((quant_group >> 2) & 1) * 32 + (quant_group & 3) * 8;
      accumulated_0[i] +=
          partial_0[i] * float(scales_0[parameter]) +
          input_sums[sum_offset + row] * float(biases_0[parameter]);
      if constexpr (GateUp) {
        accumulated_1[i] +=
            partial_1[i] * float(scales_1[parameter]) +
            input_sums[sum_offset + row] * float(biases_1[parameter]);
      }
    });
    if ((quant_group & 3) == 3 && quant_group + 1 < quant_groups) {
      uint next_group = (quant_group + 1) >> 2;
      q4_store_input_sums<8, Simdgroups>(
          input, input_size, (first_group + quant_group) * 64 + 64,
          input_sums, (next_group & 1) * 32, simd_lane, simd_group);
      threadgroup_barrier(mem_flags::mem_threadgroup);
    }
  };
  uint quant_group = 0;
  for (; quant_group + 1 < quant_groups; quant_group += 2) {
    decltype(accumulated_0) first_0, second_0;
    decltype(accumulated_1) first_1, second_1;
    run_group(quant_group, first_0, first_1);
    run_group(quant_group + 1, second_0, second_1);
    finish_group(quant_group, first_0, first_1);
    finish_group(quant_group + 1, second_0, second_1);
  }
  if (quant_group < quant_groups) {
    decltype(accumulated_0) partial_0;
    decltype(accumulated_1) partial_1;
    run_group(quant_group, partial_0, partial_1);
    finish_group(quant_group, partial_0, partial_1);
  }

  q4_visit(accumulated_0, traversal, [&](ushort i) {
    auto index = accumulated_0.get_multidimensional_index(i);
    uint slot = index[1] * TileN + index[0];
    partials[partition * 8 * TileN + slot] = accumulated_0[i];
    if constexpr (GateUp)
      partials[(SplitK + partition) * 8 * TileN + slot] = accumulated_1[i];
  });
  threadgroup_barrier(mem_flags::mem_threadgroup);
}

#define TH_SPLIT_ENTRY(Name, TileN, Sgs, GateUp)                              \
kernel void Name(                                                             \
    device const bfloat* input  [[buffer(0)]],                                \
    device const uchar*  weights [[buffer(1)]],                               \
    device const bfloat* sb      [[buffer(2)]],                               \
    device bfloat*       output  [[buffer(3)]],                               \
    constant MppParams&  p       [[buffer(4)]],                               \
    uint group      [[threadgroup_position_in_grid]],                         \
    uint lane       [[thread_index_in_simdgroup]],                            \
    uint simd       [[simdgroup_index_in_threadgroup]]) {                     \
  constexpr uint Parts = 4;                                                   \
  threadgroup float sums[4 * 64],                                             \
      partials[(GateUp ? 2 : 1) * Parts * 8 * TileN];                         \
  const uint partition = simd / Sgs;                                          \
  device bfloat* inp = const_cast<device bfloat*>(input);                     \
  device const bfloat* biases = sb + p.bias_base;                             \
  device uchar* w1 = const_cast<device uchar*>(weights) + p.up_woff;          \
  device bfloat* s1 = const_cast<device bfloat*>(sb) + p.up_soff;             \
  device bfloat* b1 = const_cast<device bfloat*>(sb) + p.bias_base            \
                      + p.up_soff;                                            \
  const uint tiles = (uint(p.out_dim) + TileN - 1) / TileN;                   \
  for (uint tile = group; tile < tiles; tile += uint(p.groups)) {             \
    th_mpp_tile_split<TileN, GateUp, Sgs, Parts>(                             \
        inp, const_cast<device uchar*>(weights),                              \
        const_cast<device bfloat*>(sb),                                       \
        const_cast<device bfloat*>(biases), partials, w1, s1, b1,             \
        p.in_dim, sums + partition * 64, tile * TileN, lane,                  \
        simd % Sgs, partition);                                               \
    for (uint i = simd * 32 + lane; i < 8 * TileN;                            \
         i += Parts * Sgs * 32) {                                             \
      const uint col = tile * TileN + i % TileN;                              \
      if (col >= (uint)p.out_dim || i / TileN >= (uint)p.m) continue;         \
      float value = 0;                                                        \
      for (uint part = 0; part < Parts; ++part)                               \
        value += partials[part * 8 * TileN + i];                              \
      value = float(bfloat(value));                                           \
      if (GateUp) {                                                           \
        float up = 0;                                                         \
        for (uint part = 0; part < Parts; ++part)                             \
          up += partials[(Parts + part) * 8 * TileN + i];                     \
        value = value / (1.0f + fast::exp2(-1.44269504089f * value)) *        \
                float(bfloat(up));                                            \
      }                                                                       \
      output[(i / TileN) * p.out_dim + col] = bfloat(value);                  \
    }                                                                         \
    threadgroup_barrier(mem_flags::mem_threadgroup);                          \
  }                                                                           \
}

TH_SPLIT_ENTRY(affine_q4_mpp_n32s4, 32, 1, false)
TH_SPLIT_ENTRY(affine_q4_mpp_n64s4, 64, 2, false)
TH_SPLIT_ENTRY(affine_q4_mpp_n32s4_gate_up, 32, 1, true)

#define TH_MPP_ENTRY(Name, GateUp, Sgs)                                       \
kernel void Name(                                                             \
    device const bfloat* input  [[buffer(0)]],                                \
    device const uchar*  weights [[buffer(1)]],                               \
    device const bfloat* sb      [[buffer(2)]],                               \
    device bfloat*       output  [[buffer(3)]],                               \
    constant MppParams&  p       [[buffer(4)]],                               \
    uint group      [[threadgroup_position_in_grid]],                         \
    uint simd_lane  [[thread_index_in_simdgroup]],                            \
    uint simd_group [[simdgroup_index_in_threadgroup]]) {                     \
  threadgroup float input_sums[64];                                           \
  const uint tiles = (uint(p.out_dim) + 255u) >> 8;                           \
  device bfloat* inp = const_cast<device bfloat*>(input);                     \
  device uchar* w1 = const_cast<device uchar*>(weights) + p.up_woff;          \
  device const bfloat* biases = sb + p.bias_base;                             \
  device bfloat* s1 = const_cast<device bfloat*>(sb) + p.up_soff;             \
  device bfloat* b1 = const_cast<device bfloat*>(sb) + p.bias_base            \
                      + p.up_soff;                                            \
  for (uint tile = group; tile < tiles; tile += uint(p.groups)) {             \
    th_mpp_tile<GateUp, Sgs>(inp, const_cast<device uchar*>(weights),         \
        const_cast<device bfloat*>(sb), const_cast<device bfloat*>(biases),   \
        output, w1, s1, b1, p.out_dim, p.in_dim, p.m, input_sums,             \
        tile * 256, simd_lane, simd_group);                                   \
  }                                                                           \
}

TH_MPP_ENTRY(affine_q4_mpp,      false, 8)
TH_MPP_ENTRY(affine_q4_mpp_sg4,  false, 4)
TH_MPP_ENTRY(affine_q4_mpp_gate_up,     true, 8)
TH_MPP_ENTRY(affine_q4_mpp_gate_up_sg4, true, 4)
"#;

    static QMV_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static QMV_V1_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static QMM_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static DEQ_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    /// Compile-probe for the MPP tensor_ops headers (Metal 4) — reports
    /// whether `mpp::tensor_ops` is reachable from runtime-compiled MSL.
    pub fn mpp_probe(device: &candle_core::MetalDevice) {
        let raw = device.metal_device();
        for (lv, tag) in [
            (objc2_metal::MTLLanguageVersion::Version4_0, "4.0"),
            (objc2_metal::MTLLanguageVersion::Version3_2, "3.2"),
        ] {
            let opts = objc2_metal::MTLCompileOptions::new();
            opts.setLanguageVersion(lv);
            let src = r#"
#include <MetalPerformancePrimitives/MetalPerformancePrimitives.h>
#include <metal_stdlib>
using namespace metal;
using namespace mpp::tensor_ops;

kernel void mpp_probe(device float* y [[buffer(0)]],
                      uint tid [[thread_position_in_grid]]) {
    constexpr auto d = matmul2d_descriptor(8, 8, 8, false, true, false);
    matmul2d<d, execution_simdgroups<8>> op;
    (void)op;
    if (tid == 0) y[0] = 1.0f;
}
"#;
            match raw.new_library_with_source(src, Some(&opts)) {
                Ok(lib) => {
                    eprintln!("mpp probe: lang {tag} compiles");
                    match lib.get_function("mpp_probe", None) {
                        Ok(_) => eprintln!("mpp probe: mpp_probe fn found"),
                        Err(e) => eprintln!("mpp probe: fn err {e}"),
                    }
                    // full MPP_SRC compile timing
                    let t = std::time::Instant::now();
                    match raw.new_library_with_source(MPP_SRC, Some(&opts)) {
                        Ok(lib) => {
                            eprintln!("mpp probe: MPP_SRC compiled in {:.1?}", t.elapsed());
                            for f in ["affine_q4_mpp", "affine_q4_mpp_sg4",
                                      "affine_q4_mpp_gate_up", "affine_q4_mpp_pad"] {
                                match lib.get_function(f, None) {
                                    Ok(_) => eprintln!("  fn {f} ok"),
                                    Err(e) => eprintln!("  fn {f} ERR {e}"),
                                }
                            }
                        }
                        Err(e) => {
                            let msg = e.to_string();
                            eprintln!("mpp probe: MPP_SRC err {}", &msg[..msg.len().min(800)]);
                        }
                    }
                    return;
                }
                Err(e) => {
                    let msg = e.to_string();
                    eprintln!("mpp probe: lang {tag} -> {}", &msg[..msg.len().min(600)]);
                }
            }
        }
    }

    fn compile(
        cell: &OnceLock<ComputePipeline>,
        src_tmpl: &str,
        gs: usize,
        fname: &str,
        device: &candle_core::MetalDevice,
    ) -> Result<()> {
        if cell.get().is_some() {
            return Ok(());
        }
        let src = src_tmpl.replace("{GS}", &gs.to_string());
        let raw = device.metal_device();
        let lib = raw
            .new_library_with_source(&src, None)
            .map_err(candle_core::Error::wrap)?;
        let f = lib
            .get_function(fname, None)
            .map_err(candle_core::Error::wrap)?;
        let p = raw
            .new_compute_pipeline_state_with_function(&f)
            .map_err(candle_core::Error::wrap)?;
        let _ = cell.set(p);
        Ok(())
    }

    fn check3(
        s: &MetalStorage,
        l: &Layout,
        want: DType,
        what: &str,
    ) -> Result<()> {
        if !l.is_contiguous() {
            candle_core::bail!("affine {what} not contiguous {:?}", l.shape());
        }
        if s.dtype() != want {
            candle_core::bail!("affine {what} dtype {:?} want {want:?}", s.dtype());
        }
        Ok(())
    }

    impl CustomOp3 for AffineQmv {
        fn name(&self) -> &'static str {
            "affine-qmv"
        }
        fn cpu_fwd(
            &self,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("affine-qmv: Metal only")
        }

        fn metal_fwd(
            &self,
            s_wq: &MetalStorage,
            l_wq: &Layout,
            s_sb: &MetalStorage,
            l_sb: &Layout,
            s_x: &MetalStorage,
            l_x: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            check3(s_wq, l_wq, DType::U32, "wq")?;
            check3(s_sb, l_sb, DType::BF16, "sb")?;
            check3(s_x, l_x, DType::BF16, "x")?;

            let device = s_wq.device();
            // v1 (one row per threadgroup) measured faster than the
            // 8-rows-per-group variant on M5 Max; keep both for A/B.
            let v2 = std::env::var("TH_QMV_V2").is_ok();
            let (cell, fname, groups) = if v2 {
                (&QMV_PIPE, "affine_qmv", self.out.div_ceil(8))
            } else {
                (&QMV_V1_PIPE, "affine_qmv_v1", self.out)
            };
            compile(cell, QMV_SRC, self.gs, fname, device)?;
            let pipeline = cell.get().unwrap();

            let y_buf = device
                .new_buffer_builder()
                .with_size_for(self.out, DType::BF16)
                .with_label("qmv.y")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("affine_qmv");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipeline);
            let params = QParams {
                in_dim: self.inp as i32,
                out_dim: self.out as i32,
                ng: (self.inp / self.gs) as i32,
                tiled: self.tiled as i32,
            };
            enc.set_input_buffer(0, Some(s_wq.buffer()), l_wq.start_offset() * 4);
            enc.set_input_buffer(1, Some(s_sb.buffer()), l_sb.start_offset() * 2);
            enc.set_input_buffer(2, Some(s_x.buffer()), l_x.start_offset() * 2);
            enc.set_output_buffer(3, Some(&y_buf), 0);
            enc.set_bytes(4, &params);
            enc.dispatch_thread_groups(
                MTLSize {
                    width: groups,
                    height: 1,
                    depth: 1,
                },
                MTLSize { width: 256, height: 1, depth: 1 },
            );
            let storage = MetalStorage::new(
                y_buf,
                device.clone(),
                self.out,
                DType::BF16,
            );
            Ok((storage, Shape::from((self.out,))))
        }
    }

    /// Splash-style fragment-direct decode for M<=8 (their
    /// `decode_linear_q4_sg` + `decode_linear_q4_prepare` pair).
    /// `aux != 0` selects the gate/up variant: wq/sb hold [gate | up]
    /// row blocks and the kernel emits silu(gate)·up with `aux` = the
    /// up-half row offset.
    pub struct AffineQsg {
        pub inp: usize,
        pub out: usize,
        pub m: usize,
        pub aux: usize,
        pub tiled: bool,
    }

    #[repr(C)]
    struct SGParams {
        out_dim: i32,
        in_dim: i32,
        m: i32,
        splits: i32,
        aux: i32,
        tiled: i32,
    }

    static SG_PREP_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static SG_DEC_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static SG_GU_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static SG8_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    /// Splash's split heuristic (Linear.cpp): grow splits while the grid
    /// stays under ~16 tiles per core and each partition keeps >=12
    /// quant groups.
    fn sg_splits(out: usize, ng: usize, tile: usize) -> usize {
        let grid = out.div_ceil(tile);
        let cores: usize = std::env::var("TH_GPU_CORES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(40);
        let mut splits = 1usize;
        while splits < 8
            && grid * splits < 16 * cores
            && ng % (2 * splits) == 0
            && ng / (2 * splits) >= 12
        {
            splits *= 2;
        }
        splits
    }

    // -- cooperative-tensor (MPP) decode path -----------------------------

    /// Packed Q4 matmul through Apple's `mpp::tensor_ops` cooperative
    /// matmul — Splash's Apple10 decode family (`q4_mpp_tile`,
    /// TileN=StorageN=256, pipelined). Requires `tiled` weight layout.
    pub struct AffineQmpp {
        pub inp: usize,
        pub out: usize,    // logical output rows
        pub padded: usize, // storage rows (tiles*256)
        pub m: usize,
        /// tile index where the gate_up "up" stream starts (0 = affine)
        pub up_tile: usize,
        /// 4 or 8 simdgroups
        pub sgs: usize,
        /// tile width: 256 = persistent N256 tile, 32/64 = split4 form
        pub tile: usize,
    }

    #[repr(C)]
    struct MppParams {
        out_dim: i32,
        in_dim: i32,
        m: i32,
        groups: i32,
        bias_base: i32,
        up_woff: i32,
        up_soff: i32,
    }

    static MPP_PAD_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static MPP_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static MPP_SG4_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static MPP_GU_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static MPP_GU_SG4_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static MPP_N32S4_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static MPP_N64S4_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static MPP_N32S4_GU_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    fn compile_mpp(
        cell: &OnceLock<ComputePipeline>,
        fname: &str,
        device: &candle_core::MetalDevice,
    ) -> Result<()> {
        if cell.get().is_some() {
            return Ok(());
        }
        let raw = device.metal_device();
        let opts = objc2_metal::MTLCompileOptions::new();
        opts.setLanguageVersion(objc2_metal::MTLLanguageVersion::Version4_0);
        let lib = raw
            .new_library_with_source(MPP_SRC, Some(&opts))
            .map_err(candle_core::Error::wrap)?;
        let f = lib
            .get_function(fname, None)
            .map_err(candle_core::Error::wrap)?;
        let p = raw
            .new_compute_pipeline_state_with_function(&f)
            .map_err(candle_core::Error::wrap)?;
        let _ = cell.set(p);
        Ok(())
    }

    /// Splash's `decodeGroups` round-robin policy for the N256 family
    /// ({wave 3, full-grid 3, many-wave 8} groups per core).
    fn mpp_groups(tiles: usize, cores: usize) -> usize {
        let (wave, full, many) = (3 * cores, 3 * cores, 8 * cores);
        if tiles <= full || tiles >= many {
            return tiles;
        }
        let two_tile = tiles.div_ceil(2);
        if two_tile > wave {
            return wave;
        }
        let balanced = tiles.div_ceil(cores);
        let mut groups = two_tile.max(full * 3 / 4).min(tiles);
        while groups < tiles && max_core_tiles(tiles, groups, cores) != balanced {
            groups += 1;
        }
        groups
    }

    /// Worst-core tile count when `groups` threadgroups take tiles
    /// `g, g+groups, ...` round-robin (Splash `maxCoreTiles`).
    fn max_core_tiles(tiles: usize, groups: usize, cores: usize) -> usize {
        (0..cores)
            .map(|core| {
                let mut load = 0;
                let mut g = core;
                while g < groups && g < tiles {
                    load += (tiles - g).div_ceil(groups);
                    g += groups;
                }
                load
            })
            .max()
            .unwrap_or(0)
    }

    impl CustomOp3 for AffineQmpp {
        fn name(&self) -> &'static str {
            "affine-qmpp"
        }
        fn cpu_fwd(
            &self,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("affine-qmpp: Metal only")
        }

        fn metal_fwd(
            &self,
            s_wq: &MetalStorage,
            l_wq: &Layout,
            s_sb: &MetalStorage,
            l_sb: &Layout,
            s_x: &MetalStorage,
            l_x: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            check3(s_wq, l_wq, DType::U32, "wq")?;
            check3(s_sb, l_sb, DType::BF16, "sb")?;
            check3(s_x, l_x, DType::BF16, "x")?;
            if self.m == 0 || self.m > 8 {
                candle_core::bail!("affine-qmpp: m {} out of range 1..=8", self.m);
            }
            if self.inp % 64 != 0 {
                candle_core::bail!("affine-qmpp: in {} not %64", self.inp);
            }
            let ng = self.inp / 64;
            let gate_up = self.up_tile > 0;
            let tiles = self.padded / 256;
            let device = s_wq.device();
            compile_mpp(&MPP_PAD_PIPE, "affine_q4_mpp_pad", device)?;
            let split = self.tile == 32 || self.tile == 64;
            let (cell, fname, tgthr) = if split && gate_up {
                (&MPP_N32S4_GU_PIPE, "affine_q4_mpp_n32s4_gate_up", 128usize)
            } else if split && self.tile == 32 {
                (&MPP_N32S4_PIPE, "affine_q4_mpp_n32s4", 128)
            } else if split {
                (&MPP_N64S4_PIPE, "affine_q4_mpp_n64s4", 256)
            } else if gate_up {
                if self.sgs == 4 {
                    (&MPP_GU_SG4_PIPE, "affine_q4_mpp_gate_up_sg4", 128)
                } else {
                    (&MPP_GU_PIPE, "affine_q4_mpp_gate_up", 256)
                }
            } else if self.sgs == 4 {
                (&MPP_SG4_PIPE, "affine_q4_mpp_sg4", 128)
            } else {
                (&MPP_PIPE, "affine_q4_mpp", 256)
            };
            compile_mpp(cell, fname, device)?;

            let cores: usize = std::env::var("TH_GPU_CORES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(40);
            // split tiles fill the grid one-tile-per-tg; N256 uses the
            // round-robin persistent-group policy
            let groups = if split {
                self.out.div_ceil(self.tile)
            } else {
                mpp_groups(tiles.div_ceil(if gate_up { 2 } else { 1 }), cores)
            }
            .max(1);
            let params = MppParams {
                out_dim: self.out as i32,
                in_dim: self.inp as i32,
                m: self.m as i32,
                groups: groups as i32,
                bias_base: (self.padded * ng) as i32,
                up_woff: (self.up_tile * ng * 8192) as i32,
                up_soff: (self.up_tile * ng * 256) as i32,
            };

            let x8_buf = device
                .new_buffer_builder()
                .with_size_for(8 * self.inp, DType::BF16)
                .with_label("qmpp.x8")
                .build()
                .map_err(candle_core::Error::wrap)?;
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(8 * self.out, DType::BF16)
                .with_label("qmpp.y")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("affine_qmpp");
            let enc_ref = &encoder;
            {
                let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                    enc_ref.encoder().as_ref();
                enc.set_compute_pipeline_state(MPP_PAD_PIPE.get().unwrap());
                enc.set_input_buffer(0, Some(s_x.buffer()), l_x.start_offset() * 2);
                enc.set_output_buffer(1, Some(&x8_buf), 0);
                let dims: [i32; 3] = [self.m as i32, self.inp as i32, 8];
                enc.set_bytes(2, &dims);
                enc.dispatch_thread_groups(
                    MTLSize { width: (8 * self.inp).div_ceil(256), height: 1, depth: 1 },
                    MTLSize { width: 256, height: 1, depth: 1 },
                );
            }
            {
                let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                    enc_ref.encoder().as_ref();
                enc.set_compute_pipeline_state(cell.get().unwrap());
                enc.set_input_buffer(0, Some(&x8_buf), 0);
                enc.set_input_buffer(1, Some(s_wq.buffer()), l_wq.start_offset() * 4);
                enc.set_input_buffer(2, Some(s_sb.buffer()), l_sb.start_offset() * 2);
                enc.set_output_buffer(3, Some(&y_buf), 0);
                enc.set_bytes(4, &params);
                enc.dispatch_thread_groups(
                    MTLSize { width: groups, height: 1, depth: 1 },
                    MTLSize { width: tgthr, height: 1, depth: 1 },
                );
            }
            let out = MetalStorage::new(
                y_buf,
                device.clone(),
                8 * self.out,
                DType::BF16,
            );
            Ok((out, (8, self.out).into()))
        }
    }

    /// MPP prefill (rows > 8): pad input to 32-row blocks, one sums pass,
    /// then cooperative 32x256 tiles. `up_tile > 0` runs the fused
    /// gate/up form: gate affine pass into scratch, then up+silu·gate.
    pub struct AffineQmppPrefill {
        pub inp: usize,
        pub out: usize,    // logical output cols (per stream for gate_up)
        pub padded: usize, // weight storage rows (tiles*256)
        pub m: usize,
        pub up_tile: usize,
    }

    static MPP_PF_SUMS_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static MPP_PF_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static MPP_PF_UP_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    impl CustomOp3 for AffineQmppPrefill {
        fn name(&self) -> &'static str {
            "affine-qmpp-prefill"
        }
        fn cpu_fwd(
            &self,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("affine-qmpp-prefill: Metal only")
        }

        fn metal_fwd(
            &self,
            s_wq: &MetalStorage,
            l_wq: &Layout,
            s_sb: &MetalStorage,
            l_sb: &Layout,
            s_x: &MetalStorage,
            l_x: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            check3(s_wq, l_wq, DType::U32, "wq")?;
            check3(s_sb, l_sb, DType::BF16, "sb")?;
            check3(s_x, l_x, DType::BF16, "x")?;
            let ng = self.inp / 64;
            let gate_up = self.up_tile > 0;
            let row_tiles = self.m.div_ceil(32);
            let m_pad = row_tiles * 32;
            let out_pad = self.out.div_ceil(256) * 256;
            let out_tiles = out_pad / 256;
            let device = s_wq.device();
            compile_mpp(&MPP_PAD_PIPE, "affine_q4_mpp_pad", device)?;
            compile_mpp(&MPP_PF_SUMS_PIPE, "affine_q4_mpp_pf_sums", device)?;
            compile_mpp(&MPP_PF_PIPE, "affine_q4_mpp_prefill", device)?;
            if gate_up {
                compile_mpp(&MPP_PF_UP_PIPE, "affine_q4_mpp_prefill_up", device)?;
            }

            let params = MppParams {
                out_dim: out_pad as i32,
                in_dim: self.inp as i32,
                m: self.m as i32,
                groups: 0,
                bias_base: (self.padded * ng) as i32,
                up_woff: (self.up_tile * ng * 8192) as i32,
                up_soff: (self.up_tile * ng * 256) as i32,
            };

            let x_pad = device
                .new_buffer_builder()
                .with_size_for(m_pad * self.inp, DType::BF16)
                .with_label("qmpp_pf.x")
                .build()
                .map_err(candle_core::Error::wrap)?;
            let sums = device
                .new_buffer_builder()
                .with_size_for(row_tiles * 32 * ng, DType::F32)
                .with_label("qmpp_pf.sums")
                .build()
                .map_err(candle_core::Error::wrap)?;
            let y_pad = device
                .new_buffer_builder()
                .with_size_for(m_pad * out_pad, DType::BF16)
                .with_label("qmpp_pf.y")
                .build()
                .map_err(candle_core::Error::wrap)?;
            let gate_pad = if gate_up {
                Some(
                    device
                        .new_buffer_builder()
                        .with_size_for(m_pad * out_pad, DType::BF16)
                        .with_label("qmpp_pf.gate")
                        .build()
                        .map_err(candle_core::Error::wrap)?,
                )
            } else {
                None
            };

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("affine_qmpp_prefill");
            let enc_ref = &encoder;
            {
                let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                    enc_ref.encoder().as_ref();
                enc.set_compute_pipeline_state(MPP_PAD_PIPE.get().unwrap());
                enc.set_input_buffer(0, Some(s_x.buffer()), l_x.start_offset() * 2);
                enc.set_output_buffer(1, Some(&x_pad), 0);
                let dims: [i32; 3] =
                    [self.m as i32, self.inp as i32, m_pad as i32];
                enc.set_bytes(2, &dims);
                enc.dispatch_thread_groups(
                    MTLSize {
                        width: (m_pad * self.inp).div_ceil(256),
                        height: 1,
                        depth: 1,
                    },
                    MTLSize { width: 256, height: 1, depth: 1 },
                );
            }
            {
                let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                    enc_ref.encoder().as_ref();
                enc.set_compute_pipeline_state(MPP_PF_SUMS_PIPE.get().unwrap());
                enc.set_input_buffer(0, Some(&x_pad), 0);
                enc.set_output_buffer(1, Some(&sums), 0);
                let in_dim = self.inp as i32;
                enc.set_bytes(2, &in_dim);
                enc.dispatch_thread_groups(
                    MTLSize { width: row_tiles, height: 1, depth: 1 },
                    MTLSize { width: 256, height: 1, depth: 1 },
                );
            }
            // tile pass(es): gate_up runs gate→scratch then up+silu·gate
            let (first_w, second) = if gate_up {
                (
                    // gate stream: tiles [0, up_tile)
                    Some((0usize, 0usize)),
                    Some((self.up_tile * ng * 8192, self.up_tile * ng * 256)),
                )
            } else {
                (Some((0, 0)), None)
            };
            for (idx, offs) in [first_w, second].into_iter().enumerate() {
                let Some((w_off, s_off)) = offs else { continue };
                let silu = idx == 1;
                let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                    enc_ref.encoder().as_ref();
                enc.set_compute_pipeline_state(
                    if silu {
                        MPP_PF_UP_PIPE.get().unwrap()
                    } else {
                        MPP_PF_PIPE.get().unwrap()
                    },
                );
                enc.set_input_buffer(0, Some(&x_pad), 0);
                enc.set_input_buffer(1, Some(s_wq.buffer()), l_wq.start_offset() * 4);
                enc.set_input_buffer(2, Some(s_sb.buffer()), l_sb.start_offset() * 2);
                enc.set_input_buffer(
                    3,
                    Some(if silu {
                        gate_pad.as_ref().unwrap()
                    } else {
                        &y_pad
                    }),
                    0,
                );
                enc.set_output_buffer(
                    4,
                    Some(if silu {
                        &y_pad
                    } else if gate_up {
                        gate_pad.as_ref().unwrap()
                    } else {
                        &y_pad
                    }),
                    0,
                );
                enc.set_input_buffer(5, Some(&sums), 0);
                let p2 = MppParams { up_woff: w_off as i32, up_soff: s_off as i32, ..params };
                enc.set_bytes(6, &p2);
                enc.dispatch_thread_groups(
                    MTLSize { width: row_tiles, height: out_tiles, depth: 1 },
                    MTLSize { width: 256, height: 1, depth: 1 },
                );
            }
            let out = MetalStorage::new(
                y_pad,
                device.clone(),
                m_pad * out_pad,
                DType::BF16,
            );
            Ok((out, (m_pad, out_pad).into()))
        }
    }

    // ------------------------------------------------------------------
    // Small-M prefill tiles (T2) — self-contained source, so the decode
    // family above stays untouched:
    //   pf_prep    — one pass: pad x[m,K] into a [m_pad,K] block (zero tail
    //                rows; skipped when m fills the last row tile) and emit
    //                per-(row, quant-group) input sums, one simdgroup per
    //                (row, group). Replaces the legacy pad + one-threadgroup-
    //                per-32-rows sums pair.
    //   pf_tile    — Rows x TileN single-stream tile, a port of Splash's
    //                q4_mpp_prefill_tile (prefill/linear_q4.metal): four
    //                simdgroups read the row sums from device memory (the
    //                Apple10 prefill_linear_q4_n128_sg4 form, 0 B
    //                threadgroup memory), eight stage them in threadgroup
    //                memory; a cooperative store for interior tiles and
    //                guarded stores on the ragged edge, so no padded rows or
    //                columns reach the caller (no narrow + copy afterwards).
    //                Rows 16/24/32 are q4_mpp_tile_batched's M16/M24/M32.
    //                Epilogues: plain, up·silu(gate) with a gate operand,
    //                and fp32 split-K partials.
    //   pf_tile_gu — two-stream gate/up tile with the silu(gate)·up
    //                epilogue (one pass instead of gate→scratch + up).
    //   pf_reduce  — fixed-order split-K reduction + epilogue.
    // Per-element math and accumulation order match th_mpp_prefill_tile
    // (same sums formula, same per-group `acc += p·s + sum·b`); unsplit
    // configs differ from the legacy prefill only where the compiler
    // contracts the epilogue FMAs differently (TH_BENCH_LIN's Δlegacy).
    // ------------------------------------------------------------------
    const PF_SRC: &str = r#"
#include <MetalPerformancePrimitives/MetalPerformancePrimitives.h>
#include <metal_stdlib>
using namespace metal;
using namespace mpp::tensor_ops;

struct PfParams {
  int out_dim;      // logical output columns per stream (guard + stride)
  int in_dim;       // K
  int m;            // live rows
  int rows;         // tile rows (sum-block stride)
  int bias_base;    // bf16 index of the bias plane in sb
  int w_off;        // byte offset of stream-0 weight tiles
  int s_off;        // bf16 offset of stream-0 scale/bias planes
  int up_woff;      // byte offset of stream-1 weight tiles (gate/up)
  int up_soff;      // bf16 offset of stream-1 scale/bias planes
  int split_groups; // quant groups per K split (in_dim/64 unsplit)
  int splits;       // K splits (pf_reduce)
  int epi;          // pf_reduce epilogue: 0 plain, 1 up*silu(gate)
};

enum class Q4Traversal : ushort {
  All, FourOfEight, PrefixAndFourOfEight, HalfPrefix, Guarded
};

template <class Tensor>
__attribute__((always_inline)) inline Q4Traversal
q4_traversal(const thread Tensor &values) {
  const ushort capacity = values.get_capacity();
  bool all = true;
  bool halfPrefix = capacity != 0 && (capacity % 2) == 0;
  bool striped = capacity != 0 && (capacity % 8) == 0;
  bool prefixed = capacity != 0 && (capacity % 16) == 0;
#pragma unroll
  for (ushort i = 0; i < capacity; ++i) {
    const bool valid = values.is_valid_element(i);
    all &= valid;
    halfPrefix &= valid == (i < capacity / 2);
    striped &= valid == ((i & 7) < 4);
    prefixed &= valid == (i < capacity / 2 || ((i & 7) < 4));
  }
  return all ? Q4Traversal::All : striped ? Q4Traversal::FourOfEight
       : prefixed ? Q4Traversal::PrefixAndFourOfEight
       : halfPrefix ? Q4Traversal::HalfPrefix : Q4Traversal::Guarded;
}

template <class Tensor, class Body>
__attribute__((always_inline)) inline void
q4_visit(const thread Tensor &values, Q4Traversal traversal,
         const thread Body &body) {
  if (traversal == Q4Traversal::All) {
#pragma unroll
    for (ushort i = 0; i < values.get_capacity(); ++i) body(i);
  } else if (traversal == Q4Traversal::FourOfEight) {
#pragma unroll
    for (ushort i = 0; i < values.get_capacity() / 2; ++i)
      body(ushort((i / 4) * 8 + i % 4));
  } else if (traversal == Q4Traversal::PrefixAndFourOfEight) {
#pragma unroll
    for (ushort i = 0; i < values.get_capacity() / 2; ++i) body(i);
#pragma unroll
    for (ushort i = 0; i < values.get_capacity() / 4; ++i)
      body(ushort(values.get_capacity() / 2 + (i / 4) * 8 + i % 4));
  } else if (traversal == Q4Traversal::HalfPrefix) {
#pragma unroll
    for (ushort i = 0; i < values.get_capacity() / 2; ++i) body(i);
  } else {
#pragma unroll
    for (ushort i = 0; i < values.get_capacity(); ++i)
      if (values.is_valid_element(i)) body(i);
  }
}

// grid (ng, m_pad/8) x 256 threads: simdgroup sg of threadgroup (g, t)
// owns row t*8+sg, quant group g. d = {m, K, rows, copy}.
kernel void pf_prep(device const bfloat *x [[buffer(0)]],
                    device bfloat *xp [[buffer(1)]],
                    device float *sums [[buffer(2)]],
                    constant int4 &d [[buffer(3)]],
                    uint2 tg [[threadgroup_position_in_grid]],
                    uint lane [[thread_index_in_simdgroup]],
                    uint sg [[simdgroup_index_in_threadgroup]]) {
  const uint m = uint(d.x), K = uint(d.y), R = uint(d.z);
  const uint g = tg.x, row = tg.y * 8 + sg;
  const ulong o = ulong(row) * K + g * 64 + lane;
  const bool live = row < m;
  const bfloat v0 = live ? x[o] : bfloat(0.0f);
  const bfloat v1 = live ? x[o + 32] : bfloat(0.0f);
  if (d.w != 0) {
    xp[o] = v0;
    xp[o + 32] = v1;
  }
  const float s = simd_sum(float(v0) + float(v1));
  if (lane == 0) sums[(ulong(row / R) * (K / 64) + g) * R + row % R] = s;
}

enum : ushort { PfPlain = 0, PfUpSilu = 2, PfPartial = 3 };

inline float pf_silu_mul(float gate, float value) {
  return gate / (1.0f + fast::exp2(-1.44269504089f * gate)) * value;
}

// Single-stream Rows x TileN tile over this split's quant groups
// [first_group, first_group + n_groups). `sums` points at the row tile's
// [group][row] block; `live` rows and `out_size` columns are stored.
template <ushort Rows, ushort TileN, ushort Sgs, ushort Mode, bool Staged>
inline void pf_tile(device bfloat *input, device uchar *w0, device bfloat *s0,
                    device bfloat *b0, device const float *sums,
                    device bfloat *aux, device bfloat *out, device float *part,
                    uint out_size, uint in_size, uint live, uint first_group,
                    uint n_groups, uint output_origin, uint lane, uint sgi,
                    threadgroup float *tsums) {
  constexpr ushort StorageN = 256;
  constexpr uint Batch = 256; // staged sums per refill, as the legacy tile
  auto a = tensor(input, dextents<int, 2>{int(in_size), Rows},
                  array<int, 2>{1, int(in_size)});
  constexpr auto descriptor =
      matmul2d_descriptor(Rows, TileN, 64, false, true, false);
  matmul2d<descriptor, execution_simdgroups<Sgs>> operation;
  const uint total_groups = in_size / 64;
  const uint tile = output_origin / StorageN;
  const uint tile_offset = output_origin % StorageN;
  device uchar *tw =
      w0 + (ulong(tile) * total_groups * StorageN + tile_offset) * 32;
  tensor<device uint4b_format, dextents<int, 2>, tensor_inline> fb(
      tw, dextents<int, 2>{64, TileN}, array<int, 2>{1, 64});
  auto a0 = a.slice<64, Rows>(0, 0);
  auto b0s = fb.slice<64, TileN>(0, 0);
  auto acc = operation.template get_destination_cooperative_tensor<
      decltype(a0), decltype(b0s), float>();
  const bool full = uint(acc.get_capacity()) * (uint(Sgs) * 32u) ==
                    uint(Rows) * TileN;
  const auto trav = full ? Q4Traversal::All : q4_traversal(acc);
  q4_visit(acc, trav, [&](ushort i) { acc[i] = 0.0f; });
  device const float *gs = sums + ulong(first_group) * Rows;
  auto load = [&](uint start) {
    const uint count = min(Batch, n_groups - start);
    for (uint idx = sgi * 32 + lane; idx < count * Rows; idx += Sgs * 32)
      tsums[idx] = gs[start * Rows + idx];
  };
  if constexpr (Staged) {
    load(0);
    threadgroup_barrier(mem_flags::mem_threadgroup);
  }
  for (uint q = 0; q < n_groups; ++q) {
    const uint g = first_group + q;
    auto a_slice = a.slice<64, Rows>(g * 64, 0);
    tensor<device uint4b_format, dextents<int, 2>, tensor_inline> bq(
        tw + ulong(g) * StorageN * 32, dextents<int, 2>{64, TileN},
        array<int, 2>{1, 64});
    auto bs = bq.slice<64, TileN>(0, 0);
    auto pr = operation.template get_destination_cooperative_tensor<
        decltype(a_slice), decltype(bs), float>();
    operation.run(a_slice, bs, pr);
    q4_visit(acc, trav, [&](ushort i) __attribute__((always_inline)) {
      auto index = acc.get_multidimensional_index(i);
      const uint row = index[1];
      const ulong prm = (ulong(tile) * total_groups + g) * StorageN +
                        tile_offset + index[0];
      float sum;
      if constexpr (Staged)
        sum = tsums[(q % Batch) * Rows + row];
      else
        sum = gs[q * Rows + row];
      acc[i] += pr[i] * float(s0[prm]) + sum * float(b0[prm]);
    });
    if constexpr (Staged) {
      if (q % Batch == Batch - 1 && q + 1 < n_groups) {
        threadgroup_barrier(mem_flags::mem_threadgroup);
        load(q + 1);
        threadgroup_barrier(mem_flags::mem_threadgroup);
      }
    }
  }
  if (live == Rows && output_origin + TileN <= out_size) {
    if constexpr (Mode == PfPartial) {
      auto pc = tensor(part, dextents<int, 2>{int(out_size), Rows},
                       array<int, 2>{1, int(out_size)});
      acc.store(pc.slice<TileN, Rows>(output_origin, 0));
    } else {
      auto c = tensor(out, dextents<int, 2>{int(out_size), Rows},
                      array<int, 2>{1, int(out_size)});
      auto conv = operation.template get_destination_cooperative_tensor<
          decltype(a0), decltype(b0s), bfloat>();
      q4_visit(acc, trav, [&](ushort i) {
        float value = float(bfloat(acc[i]));
        if constexpr (Mode == PfUpSilu) {
          auto index = acc.get_multidimensional_index(i);
          value = pf_silu_mul(
              float(aux[index[1] * out_size + output_origin + index[0]]),
              value);
        }
        conv[i] = bfloat(value);
      });
      conv.store(c.slice<TileN, Rows>(output_origin, 0));
    }
    return;
  }
  q4_visit(acc, trav, [&](ushort i) {
    auto index = acc.get_multidimensional_index(i);
    const uint col = output_origin + index[0];
    const uint row = index[1];
    if (row >= live || col >= out_size) return;
    const ulong oi = ulong(row) * out_size + col;
    if constexpr (Mode == PfPartial) {
      part[oi] = acc[i];
    } else {
      float value = float(bfloat(acc[i]));
      if constexpr (Mode == PfUpSilu)
        value = pf_silu_mul(float(aux[oi]), value);
      out[oi] = bfloat(value);
    }
  });
}

// grid (m_pad/Rows, ceil(out/TileN), splits) x (32*Sgs) threads. Row
// tiles vary fastest (Splash's prefill order): the threadgroups sharing a
// weight tile dispatch together, so the weights stream from DRAM once and
// the other row tiles hit cache.
#define PF_ENTRY(Name, Rows, TileN, Sgs, Mode)                               \
kernel void Name(device const bfloat* input  [[buffer(0)]],                 \
                 device const uchar*  weights [[buffer(1)]],                \
                 device const bfloat* sb      [[buffer(2)]],                \
                 device const float*  sums    [[buffer(3)]],                \
                 device bfloat*       aux     [[buffer(4)]],                \
                 device bfloat*       out     [[buffer(5)]],                \
                 device float*        part    [[buffer(6)]],                \
                 constant PfParams&   p       [[buffer(7)]],                \
                 uint3 tg [[threadgroup_position_in_grid]],                 \
                 uint lane [[thread_index_in_simdgroup]],                   \
                 uint sgi [[simdgroup_index_in_threadgroup]]) {             \
  threadgroup float tsums[(Sgs) == 8 ? (Rows) * 256 : 1];                   \
  const uint ng = uint(p.in_dim) / 64;                                      \
  const uint row0 = tg.x * Rows;                                            \
  const uint live = min(uint(Rows), uint(p.m) - row0);                      \
  const ulong ob = ulong(row0) * uint(p.out_dim);                           \
  device uchar* wb = const_cast<device uchar*>(weights);                    \
  device bfloat* sbb = const_cast<device bfloat*>(sb);                      \
  pf_tile<Rows, TileN, Sgs, Mode, (Sgs) == 8>(                              \
      const_cast<device bfloat*>(input) + ulong(row0) * uint(p.in_dim),     \
      wb + p.w_off, sbb + p.s_off, sbb + p.bias_base + p.s_off,             \
      sums + ulong(tg.x) * ng * Rows, aux + ob, out + ob,                   \
      part + ulong(tg.z) * uint(p.m) * uint(p.out_dim) + ob,                \
      uint(p.out_dim), uint(p.in_dim), live, tg.z * uint(p.split_groups),   \
      uint(p.split_groups), tg.y * TileN, lane, sgi, tsums);                \
}

// Two-stream gate/up: stream 0 = gate, stream 1 = up (tiles from
// p.up_woff/p.up_soff), output silu(bf16 gate)·bf16 up over out_size
// columns — the same values as the gate→scratch + up·silu passes.
template <ushort Rows, ushort TileN, ushort Sgs>
inline void pf_tile_gu(device bfloat *input, device uchar *w0,
                       device bfloat *s0, device bfloat *b0, device uchar *w1,
                       device bfloat *s1, device bfloat *b1,
                       device const float *sums, device bfloat *out,
                       uint out_size, uint in_size, uint live,
                       uint output_origin) {
  constexpr ushort StorageN = 256;
  auto a = tensor(input, dextents<int, 2>{int(in_size), Rows},
                  array<int, 2>{1, int(in_size)});
  constexpr auto descriptor =
      matmul2d_descriptor(Rows, TileN, 64, false, true, false);
  matmul2d<descriptor, execution_simdgroups<Sgs>> operation;
  const uint total_groups = in_size / 64;
  const uint tile = output_origin / StorageN;
  const uint tile_offset = output_origin % StorageN;
  device uchar *tw0 =
      w0 + (ulong(tile) * total_groups * StorageN + tile_offset) * 32;
  device uchar *tw1 =
      w1 + (ulong(tile) * total_groups * StorageN + tile_offset) * 32;
  tensor<device uint4b_format, dextents<int, 2>, tensor_inline> fb0(
      tw0, dextents<int, 2>{64, TileN}, array<int, 2>{1, 64});
  auto a0 = a.slice<64, Rows>(0, 0);
  auto b00 = fb0.slice<64, TileN>(0, 0);
  auto acc0 = operation.template get_destination_cooperative_tensor<
      decltype(a0), decltype(b00), float>();
  auto acc1 = operation.template get_destination_cooperative_tensor<
      decltype(a0), decltype(b00), float>();
  const bool full = uint(acc0.get_capacity()) * (uint(Sgs) * 32u) ==
                    uint(Rows) * TileN;
  const auto trav = full ? Q4Traversal::All : q4_traversal(acc0);
  q4_visit(acc0, trav, [&](ushort i) {
    acc0[i] = 0.0f;
    acc1[i] = 0.0f;
  });
  for (uint g = 0; g < total_groups; ++g) {
    auto a_slice = a.slice<64, Rows>(g * 64, 0);
    tensor<device uint4b_format, dextents<int, 2>, tensor_inline> bq0(
        tw0 + ulong(g) * StorageN * 32, dextents<int, 2>{64, TileN},
        array<int, 2>{1, 64});
    auto b0s = bq0.slice<64, TileN>(0, 0);
    auto p0 = operation.template get_destination_cooperative_tensor<
        decltype(a_slice), decltype(b0s), float>();
    operation.run(a_slice, b0s, p0);
    tensor<device uint4b_format, dextents<int, 2>, tensor_inline> bq1(
        tw1 + ulong(g) * StorageN * 32, dextents<int, 2>{64, TileN},
        array<int, 2>{1, 64});
    auto b1s = bq1.slice<64, TileN>(0, 0);
    auto p1 = operation.template get_destination_cooperative_tensor<
        decltype(a_slice), decltype(b1s), float>();
    operation.run(a_slice, b1s, p1);
    q4_visit(acc0, trav, [&](ushort i) __attribute__((always_inline)) {
      auto index = acc0.get_multidimensional_index(i);
      const uint row = index[1];
      const ulong prm = (ulong(tile) * total_groups + g) * StorageN +
                        tile_offset + index[0];
      const float sum = sums[g * Rows + row];
      acc0[i] += p0[i] * float(s0[prm]) + sum * float(b0[prm]);
      acc1[i] += p1[i] * float(s1[prm]) + sum * float(b1[prm]);
    });
  }
  q4_visit(acc0, trav, [&](ushort i) {
    auto index = acc0.get_multidimensional_index(i);
    const uint col = output_origin + index[0];
    const uint row = index[1];
    if (row >= live || col >= out_size) return;
    out[ulong(row) * out_size + col] = bfloat(
        pf_silu_mul(float(bfloat(acc0[i])), float(bfloat(acc1[i]))));
  });
}

#define PF_GU_ENTRY(Name, Rows, TileN, Sgs)                                  \
kernel void Name(device const bfloat* input  [[buffer(0)]],                 \
                 device const uchar*  weights [[buffer(1)]],                \
                 device const bfloat* sb      [[buffer(2)]],                \
                 device const float*  sums    [[buffer(3)]],                \
                 device bfloat*       aux     [[buffer(4)]],                \
                 device bfloat*       out     [[buffer(5)]],                \
                 device float*        part    [[buffer(6)]],                \
                 constant PfParams&   p       [[buffer(7)]],                \
                 uint3 tg [[threadgroup_position_in_grid]]) {               \
  const uint ng = uint(p.in_dim) / 64;                                      \
  const uint row0 = tg.x * Rows;                                            \
  const uint live = min(uint(Rows), uint(p.m) - row0);                      \
  device uchar* wb = const_cast<device uchar*>(weights);                    \
  device bfloat* sbb = const_cast<device bfloat*>(sb);                      \
  pf_tile_gu<Rows, TileN, Sgs>(                                             \
      const_cast<device bfloat*>(input) + ulong(row0) * uint(p.in_dim),     \
      wb + p.w_off, sbb + p.s_off, sbb + p.bias_base + p.s_off,             \
      wb + p.up_woff, sbb + p.up_soff, sbb + p.bias_base + p.up_soff,       \
      sums + ulong(tg.x) * ng * Rows,                                       \
      out + ulong(row0) * uint(p.out_dim), uint(p.out_dim),                 \
      uint(p.in_dim), live, tg.y * TileN);                                  \
}

kernel void pf_reduce(device const float* part [[buffer(0)]],
                      device const bfloat* aux [[buffer(1)]],
                      device bfloat* out [[buffer(2)]],
                      constant PfParams& p [[buffer(3)]],
                      uint i [[thread_position_in_grid]]) {
  const uint total = uint(p.m) * uint(p.out_dim);
  if (i >= total) return;
  float v = 0.0f;
  for (int s = 0; s < p.splits; ++s) v += part[ulong(s) * total + i];
  v = float(bfloat(v));
  if (p.epi == 1) v = pf_silu_mul(float(aux[i]), v);
  out[i] = bfloat(v);
}
"#;

    /// Instantiated tile shapes (rows, tile_n, simdgroups); each compiles
    /// on first use into its own library with every epilogue.
    const PF_SHAPES: &[(usize, usize, usize)] = &[
        (16, 128, 4),
        (16, 256, 8),
        (16, 128, 8),
        (24, 128, 4),
        (24, 256, 8),
        (32, 128, 4),
        (32, 256, 8),
        (32, 128, 8),
    ];
    /// single-stream epilogues (`PF_ENTRY`); "gu" is `PF_GU_ENTRY`
    const PF_MODES: &[(&str, usize)] = &[("pl", 0), ("us", 2), ("pt", 3)];

    /// The instantiated (rows, tile_n, simdgroups) shapes (bench sweeps).
    pub fn pf_shapes() -> &'static [(usize, usize, usize)] {
        PF_SHAPES
    }

    fn pf_name(rows: usize, tile_n: usize, sgs: usize, mode: &str) -> String {
        format!("pf_r{rows}_n{tile_n}_s{sgs}_{mode}")
    }

    /// Prefill tile configuration (see `pf_route`).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct PfCfg {
        /// row-tile height: 16 / 24 / 32
        pub rows: usize,
        /// output columns per threadgroup: 128 / 256
        pub tile_n: usize,
        /// simdgroups per threadgroup: 4 (device sums) / 8 (staged sums)
        pub sgs: usize,
        /// K splits (1 = none); >1 adds a `pf_reduce` pass
        pub splits: usize,
        /// gate/up: one two-stream pass (else gate→scratch, up·silu)
        pub fused: bool,
    }

    impl PfCfg {
        pub const fn new(rows: usize, tile_n: usize, sgs: usize) -> Self {
            Self { rows, tile_n, sgs, splits: 1, fused: false }
        }
        pub fn exists(&self) -> bool {
            PF_SHAPES.contains(&(self.rows, self.tile_n, self.sgs))
        }
        /// "r16n128s4", "+k4" for splits, "+gu" for the fused gate/up pass
        pub fn label(&self) -> String {
            let mut s = format!("r{}n{}s{}", self.rows, self.tile_n, self.sgs);
            if self.splits > 1 {
                s += &format!("+k{}", self.splits);
            }
            if self.fused {
                s += "+gu";
            }
            s
        }
    }

    type PfLib = std::collections::HashMap<String, ComputePipeline>;

    fn pf_build(device: &candle_core::MetalDevice, src: &str, names: &[String]) -> Result<PfLib> {
        let raw = device.metal_device();
        let opts = objc2_metal::MTLCompileOptions::new();
        opts.setLanguageVersion(objc2_metal::MTLLanguageVersion::Version4_0);
        let lib = raw
            .new_library_with_source(src, Some(&opts))
            .map_err(candle_core::Error::wrap)?;
        let mut map = PfLib::new();
        for name in names {
            let f = lib
                .get_function(name, None)
                .map_err(candle_core::Error::wrap)?;
            let p = raw
                .new_compute_pipeline_state_with_function(&f)
                .map_err(candle_core::Error::wrap)?;
            map.insert(name.clone(), p);
        }
        Ok(map)
    }

    /// pf_prep + pf_reduce (shape-independent), compiled on first use.
    static PF_COMMON: OnceLock<PfLib> = OnceLock::new();
    /// One library per `PF_SHAPES` entry (all its epilogues), compiled on
    /// the first call that needs that shape: a cold process pays only for
    /// the shapes the policy routes (a whole-family compile measured
    /// 1.6-3.7s cold, ~5-12ms from the Metal shader cache).
    static PF_LIBS: [OnceLock<PfLib>; PF_SHAPES.len()] =
        [const { OnceLock::new() }; PF_SHAPES.len()];

    fn pf_common(device: &candle_core::MetalDevice) -> Result<&'static PfLib> {
        if let Some(p) = PF_COMMON.get() {
            return Ok(p);
        }
        let lib = pf_build(device, PF_SRC, &["pf_prep".to_string(), "pf_reduce".to_string()])?;
        let _ = PF_COMMON.set(lib);
        Ok(PF_COMMON.get().unwrap())
    }

    fn pf_shape_lib(device: &candle_core::MetalDevice, c: &PfCfg) -> Result<&'static PfLib> {
        let idx = PF_SHAPES
            .iter()
            .position(|&t| t == (c.rows, c.tile_n, c.sgs))
            .ok_or_else(|| candle_core::Error::Msg(format!("affine-qpf: no shape {c:?}")))?;
        if let Some(p) = PF_LIBS[idx].get() {
            return Ok(p);
        }
        let (r, n, sg) = PF_SHAPES[idx];
        let mut src = String::from(PF_SRC);
        let mut names = Vec::new();
        for &(mode, id) in PF_MODES {
            let name = pf_name(r, n, sg, mode);
            src += &format!("PF_ENTRY({name}, {r}, {n}, {sg}, {id})\n");
            names.push(name);
        }
        let name = pf_name(r, n, sg, "gu");
        src += &format!("PF_GU_ENTRY({name}, {r}, {n}, {sg})\n");
        names.push(name);
        let lib = pf_build(device, &src, &names)?;
        let _ = PF_LIBS[idx].set(lib);
        Ok(PF_LIBS[idx].get().unwrap())
    }

    /// Build every prefill tile library (probe/warm-up aid); returns the
    /// pipeline count.
    pub fn pf_compile(device: &candle_core::MetalDevice) -> Result<usize> {
        let mut n = pf_common(device)?.len();
        for &(rows, tile_n, sgs) in PF_SHAPES {
            n += pf_shape_lib(device, &PfCfg::new(rows, tile_n, sgs))?.len();
        }
        Ok(n)
    }

    /// The (rows, tile_n, simdgroups) shapes `pf_policy` can return (unit
    /// test `pf_policy_only_returns_warmed_shapes` keeps them in sync).
    const PF_POLICY_SHAPES: [(usize, usize, usize); 2] = [(16, 128, 4), (32, 256, 8)];

    /// Compile, at model load, every tile library `pf_route` can pick
    /// under the current env (the policy's shapes, or the TH_PF-forced
    /// one) plus pf_prep/pf_reduce. Lazily, the first call per shape paid
    /// the compile inside a request: the first prompt's prefill, or — once
    /// a TH_BATCH > 1 decode round routes 8*nb > 8 verify/propose rows
    /// through the tiles — a decode round mid-generation (~80 ms per
    /// pipeline on a cold Metal shader cache, a few ms warm). Returns the
    /// pipeline count; 0 when tile routing is off.
    pub fn pf_warm(device: &candle_core::MetalDevice) -> Result<usize> {
        let (off, forced, _) = pf_env();
        if off {
            return Ok(0);
        }
        let shapes: Vec<PfCfg> = match forced {
            Some(c) if c.exists() => vec![c],
            Some(_) => return Ok(0),
            None => PF_POLICY_SHAPES
                .iter()
                .map(|&(r, n, sg)| PfCfg::new(r, n, sg))
                .collect(),
        };
        let mut n = pf_common(device)?.len();
        for c in &shapes {
            n += pf_shape_lib(device, c)?.len();
        }
        Ok(n)
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct PfParams {
        out_dim: i32,
        in_dim: i32,
        m: i32,
        rows: i32,
        bias_base: i32,
        w_off: i32,
        s_off: i32,
        up_woff: i32,
        up_soff: i32,
        split_groups: i32,
        splits: i32,
        epi: i32,
    }

    /// Small-M prefill projection `y[m, out] = x[m, in] @ W^T` on tiled Q4
    /// weights (rows > 8). `up_tile > 0` selects gate/up: the up stream
    /// starts at that 256-row weight tile and the output is
    /// silu(gate)·up over `out` columns. Output is exactly `[m, out]` in a
    /// fresh buffer (never an alias of an input or scratch buffer).
    pub struct AffineQpf {
        pub inp: usize,
        /// logical output columns (per stream for gate/up)
        pub out: usize,
        /// weight storage rows of the whole matrix (tiles*256)
        pub padded: usize,
        pub m: usize,
        pub up_tile: usize,
        pub cfg: PfCfg,
    }

    impl CustomOp3 for AffineQpf {
        fn name(&self) -> &'static str {
            "affine-qpf"
        }
        fn cpu_fwd(
            &self,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("affine-qpf: Metal only")
        }

        fn metal_fwd(
            &self,
            s_wq: &MetalStorage,
            l_wq: &Layout,
            s_sb: &MetalStorage,
            l_sb: &Layout,
            s_x: &MetalStorage,
            l_x: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            check3(s_wq, l_wq, DType::U32, "wq")?;
            check3(s_sb, l_sb, DType::BF16, "sb")?;
            check3(s_x, l_x, DType::BF16, "x")?;
            let c = self.cfg;
            let gate_up = self.up_tile > 0;
            let splits = c.splits.max(1);
            let ng = self.inp / 64;
            if self.m == 0 || self.inp % 64 != 0 || !c.exists() {
                candle_core::bail!("affine-qpf: unsupported m={} in={} {:?}", self.m, self.inp, c);
            }
            if ng % splits != 0 || (gate_up && splits > 1) {
                candle_core::bail!("affine-qpf: bad split {splits} for ng={ng} gate_up={gate_up}");
            }
            if l_x.shape().elem_count() != self.m * self.inp {
                candle_core::bail!("affine-qpf: x {:?} != [{}, {}]", l_x.shape(), self.m, self.inp);
            }
            let device = s_wq.device();
            let common = pf_common(device)?;
            let shape_lib = pf_shape_lib(device, &c)?;
            let pipe = |name: &str| {
                shape_lib.get(name).or_else(|| common.get(name)).ok_or_else(|| {
                    candle_core::Error::Msg(format!("affine-qpf: no kernel {name}"))
                })
            };
            let mode = if splits > 1 {
                "pt"
            } else if gate_up && c.fused {
                "gu"
            } else {
                "pl"
            };
            let p_prep = pipe("pf_prep")?;
            let p_tile = pipe(&pf_name(c.rows, c.tile_n, c.sgs, mode))?;
            let p_up = if gate_up && !c.fused {
                Some(pipe(&pf_name(c.rows, c.tile_n, c.sgs, "us"))?)
            } else {
                None
            };
            let p_red = if splits > 1 { Some(pipe("pf_reduce")?) } else { None };

            let row_tiles = self.m.div_ceil(c.rows);
            let m_pad = row_tiles * c.rows;
            let x_off = l_x.start_offset() * 2;
            // the tiles read whole Rows-row blocks: pad unless the live
            // rows fill them (and the base is 16-byte aligned)
            let copy = m_pad != self.m || x_off % 16 != 0;
            let alloc = |n: usize, dt: DType, label: &'static str| {
                device
                    .new_buffer_builder()
                    .with_size_for(n, dt)
                    .with_label(label)
                    .build()
                    .map_err(candle_core::Error::wrap)
            };
            let x_pad = if copy { Some(alloc(m_pad * self.inp, DType::BF16, "qpf.x")?) } else { None };
            let sums = alloc(m_pad * ng, DType::F32, "qpf.sums")?;
            let y = alloc(self.m * self.out, DType::BF16, "qpf.y")?;
            let gate = if p_up.is_some() {
                Some(alloc(self.m * self.out, DType::BF16, "qpf.gate")?)
            } else {
                None
            };
            let part = if splits > 1 {
                Some(alloc(splits * self.m * self.out, DType::F32, "qpf.part")?)
            } else {
                None
            };
            let params = PfParams {
                out_dim: self.out as i32,
                in_dim: self.inp as i32,
                m: self.m as i32,
                rows: c.rows as i32,
                bias_base: (self.padded * ng) as i32,
                w_off: 0,
                s_off: 0,
                up_woff: (self.up_tile * ng * 8192) as i32,
                up_soff: (self.up_tile * ng * 256) as i32,
                split_groups: (ng / splits) as i32,
                splits: splits as i32,
                epi: 0,
            };
            let tile_grid = MTLSize {
                width: row_tiles,
                height: self.out.div_ceil(c.tile_n),
                depth: splits,
            };
            let tile_tg = MTLSize { width: 32 * c.sgs, height: 1, depth: 1 };

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            // 1. pad + sums
            enc.set_compute_pipeline_state(p_prep);
            enc.set_input_buffer(0, Some(s_x.buffer()), x_off);
            match &x_pad {
                Some(b) => enc.set_output_buffer(1, Some(b), 0),
                // unused slot (copy = 0): bound read-only, never written
                None => enc.set_input_buffer(1, Some(s_x.buffer()), x_off),
            }
            enc.set_output_buffer(2, Some(&sums), 0);
            let d: [i32; 4] =
                [self.m as i32, self.inp as i32, c.rows as i32, copy as i32];
            enc.set_bytes(3, &d);
            enc.dispatch_thread_groups(
                MTLSize { width: ng, height: m_pad / 8, depth: 1 },
                MTLSize { width: 256, height: 1, depth: 1 },
            );
            // 2. tile pass(es) — every buffer a pass reads is bound as an
            // input and every buffer it writes as an output, so candle's
            // barrier tracking orders prep → tile → (up | reduce)
            let (xb, xo) = match &x_pad {
                Some(b) => (b.as_ref(), 0usize),
                None => (s_x.buffer(), x_off),
            };
            let tile_pass = |pipe: &ComputePipeline,
                             aux: Option<&candle_metal_kernels::metal::Buffer>,
                             out: &candle_metal_kernels::metal::Buffer,
                             prm: &PfParams| {
                enc.set_compute_pipeline_state(pipe);
                enc.set_input_buffer(0, Some(xb), xo);
                enc.set_input_buffer(1, Some(s_wq.buffer()), l_wq.start_offset() * 4);
                enc.set_input_buffer(2, Some(s_sb.buffer()), l_sb.start_offset() * 2);
                enc.set_input_buffer(3, Some(&sums), 0);
                // unused aux/part slots are bound read-only to `sums`
                enc.set_input_buffer(4, Some(aux.unwrap_or(&sums)), 0);
                if splits > 1 {
                    enc.set_input_buffer(5, Some(&sums), 0);
                    enc.set_output_buffer(6, Some(out), 0);
                } else {
                    enc.set_output_buffer(5, Some(out), 0);
                    enc.set_input_buffer(6, Some(&sums), 0);
                }
                enc.set_bytes(7, prm);
                enc.dispatch_thread_groups(tile_grid, tile_tg);
            };
            match (&p_up, &gate, &part) {
                (Some(p_up), Some(g), _) => {
                    // gate stream → scratch, then up·silu(gate) → y
                    tile_pass(p_tile, None, g, &params);
                    let up = PfParams {
                        w_off: params.up_woff,
                        s_off: params.up_soff,
                        ..params
                    };
                    tile_pass(p_up, Some(g), &y, &up);
                }
                (_, _, Some(pt)) => {
                    tile_pass(p_tile, None, pt, &params);
                    let p_red = p_red.unwrap();
                    enc.set_compute_pipeline_state(p_red);
                    enc.set_input_buffer(0, Some(pt), 0);
                    enc.set_input_buffer(1, Some(&sums), 0);
                    enc.set_output_buffer(2, Some(&y), 0);
                    enc.set_bytes(3, &params);
                    enc.dispatch_thread_groups(
                        MTLSize { width: (self.m * self.out).div_ceil(256), height: 1, depth: 1 },
                        MTLSize { width: 256, height: 1, depth: 1 },
                    );
                }
                _ => tile_pass(p_tile, None, &y, &params),
            }
            let storage =
                MetalStorage::new(y, device.clone(), self.m * self.out, DType::BF16);
            Ok((storage, (self.m, self.out).into()))
        }
    }

    /// Tile policy for prefill rows (> 8) on tiled Q4 weights; `None` →
    /// legacy `AffineQmppPrefill`. Env (read once): `TH_PF=0` legacy
    /// everywhere; `TH_PF=r16n128s4[+k4][+gu]` forces one config wherever
    /// it applies (A/B); `TH_QMM_SCALAR` disables the MPP path entirely;
    /// `TH_GPU_CORES` (default 40) scales the policy's occupancy targets.
    /// Bench hook: force the legacy prefill path at runtime so
    /// TH_BENCH_PREFILL can interleave legacy and tile forwards in one
    /// process (cross-process forward timings drifted up to 30%). Off by
    /// default; a relaxed load is its only per-call cost.
    static PF_LEGACY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    pub fn pf_force_legacy(on: bool) {
        PF_LEGACY.store(on, std::sync::atomic::Ordering::Relaxed);
    }

    /// (off, forced, cores) from TH_QMM_SCALAR / TH_PF / TH_GPU_CORES,
    /// read once.
    fn pf_env() -> (bool, Option<PfCfg>, usize) {
        static ENV: OnceLock<(bool, Option<PfCfg>, usize)> = OnceLock::new();
        *ENV.get_or_init(|| {
            let scalar = std::env::var("TH_QMM_SCALAR").is_ok();
            let v = std::env::var("TH_PF").ok();
            let off = scalar || v.as_deref() == Some("0");
            let cores = std::env::var("TH_GPU_CORES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(40usize);
            (off, v.as_deref().and_then(pf_parse), cores)
        })
    }

    pub fn pf_route(m: usize, out: usize, inp: usize, gate_up: bool) -> Option<PfCfg> {
        let (off, forced, cores) = pf_env();
        if off || m <= 8 || inp % 64 != 0 || PF_LEGACY.load(std::sync::atomic::Ordering::Relaxed) {
            return None;
        }
        let ng = inp / 64;
        let valid = |c: PfCfg| c.exists() && ng % c.splits == 0 && !(gate_up && c.splits > 1);
        if let Some(c) = forced {
            let c = PfCfg { fused: c.fused && gate_up, ..c };
            return valid(c).then_some(c);
        }
        pf_policy(m, out, inp, gate_up, cores).filter(|&c| valid(c))
    }

    /// Parse "r16n128s4[+k4][+gu]".
    fn pf_parse(s: &str) -> Option<PfCfg> {
        let mut parts = s.split('+');
        let head = parts.next()?;
        let r = head.strip_prefix('r')?;
        let (rows, rest) = r.split_once('n')?;
        let (tile_n, sgs) = rest.split_once('s')?;
        let mut c = PfCfg::new(rows.parse().ok()?, tile_n.parse().ok()?, sgs.parse().ok()?);
        for p in parts {
            if let Some(k) = p.strip_prefix('k') {
                c.splits = k.parse().ok()?;
            } else if p == "gu" {
                c.fused = true;
            }
        }
        Some(c)
    }

    /// Default tile per shape, from the interleaved TH_BENCH_LIN=pf sweep
    /// (M5 Max, 40 cores; m = 16..512, every shape of the model plus the
    /// DFlash draft-commit fc/qkv):
    /// - narrow projections (<= 2 n128 column tiles per core: the N=5120
    ///   down/out/o/draft fc, 6144 draft qkv) at m <= 128 — the output
    ///   tiles alone leave most cores idle: 16-row tiles + split-K (x4
    ///   while the grid stays <= 5 tiles per core, else x2): 1.5-5.5x
    ///   over legacy;
    /// - wide single-stream (in_all 16480, in_qkv 14336) at m <= 16:
    ///   16-row tiles + split-K x2 (1.8-2.1x);
    /// - gate/up at m <= 16: fused two-stream 16-row tile (1.23x); at
    ///   17..127 legacy stays (measured 3-9% ahead of every tile);
    /// - wide single-stream at 16 < m <= 128 and gate/up at m = 128:
    ///   Splash's staged-sums 32x256 8-simdgroup tile (1.02-1.23x);
    /// - very wide (> 16 column tiles per core: lm_head, reached only by
    ///   the TH_BATCH > 1 verify/propose rows): unsplit 16-row tiles at
    ///   m <= 16, legacy above;
    /// - m > 128: legacy. Per kernel the tiles still won most shapes at
    ///   m=512, but the whole m=512 forward measured 4.3% slower with them
    ///   (in-process interleaved A/B: 931.9 -> 971.6ms), so the long-prompt
    ///   chunks stay on the legacy tile.
    fn pf_policy(m: usize, out: usize, inp: usize, gate_up: bool, cores: usize) -> Option<PfCfg> {
        if m > 128 {
            return None;
        }
        let ng = inp / 64;
        let tiles_n = out.div_ceil(128);
        if gate_up {
            return if m <= 16 {
                Some(PfCfg { fused: true, ..PfCfg::new(16, 128, 4) })
            } else if m >= 128 {
                Some(PfCfg::new(32, 256, 8))
            } else {
                None
            };
        }
        // very wide outputs (> 16 n128 column tiles per core: the 248k-
        // column lm_head, which only sees > 8 rows in a TH_BATCH > 1
        // round — verify 8*nb, draft propose 7*nb): the column tiles alone
        // fill the GPU, so split-K only adds partial-sum traffic (m=14/16:
        // 1.26x unsplit vs 1.12x +k2 over legacy), and past 16 rows no tile
        // beats legacy (r32n256s8 0.93-0.98x at m=21..128)
        if tiles_n > 16 * cores {
            return (m <= 16).then(|| PfCfg::new(16, 128, 4));
        }
        let narrow = tiles_n <= 2 * cores;
        let split = |want: usize| {
            let mut k = want;
            while k > 1 && ng % k != 0 {
                k /= 2;
            }
            PfCfg { splits: k, ..PfCfg::new(16, 128, 4) }
        };
        if narrow {
            let grid = m.div_ceil(16) * tiles_n;
            return Some(split(if grid * 4 <= 5 * cores { 4 } else { 2 }));
        }
        if m <= 16 {
            return Some(split(2));
        }
        Some(PfCfg::new(32, 256, 8))
    }

    #[cfg(test)]
    mod pf_tests {
        use super::*;

        /// `pf_route`'s validity filter (minus the env / m <= 8 gates).
        fn valid(c: PfCfg, inp: usize, gate_up: bool) -> bool {
            c.exists() && (inp / 64) % c.splits == 0 && !(gate_up && c.splits > 1)
        }

        #[test]
        fn pf_parse_round_trips_labels() {
            for s in ["r16n128s4", "r16n128s4+k4", "r32n256s8", "r16n128s4+gu", "r24n256s8+k2"] {
                assert_eq!(pf_parse(s).map(|c| c.label()).as_deref(), Some(s));
            }
            for s in ["", "0", "r16", "r16n128", "x16n128s4", "r16n128s4+kx"] {
                assert_eq!(pf_parse(s), None, "{s:?}");
            }
        }

        /// The routed config per (m, out, inp, gate_up) on 40 cores — the
        /// model's prefill shapes and the TH_BATCH > 1 decode shapes
        /// (verify rows 8*nb, draft lm_head/selector rows 7*nb).
        #[test]
        fn pf_policy_table() {
            let cases: &[(usize, usize, usize, bool, Option<&str>)] = &[
                // narrow (<= 80 n128 column tiles): down, attn o / GDN out,
                // draft fc / qkv / attn_dyn / selector
                (16, 5120, 17408, false, Some("r16n128s4+k4")),
                (24, 5120, 17408, false, Some("r16n128s4+k2")),
                (32, 5120, 17408, false, Some("r16n128s4+k2")),
                (128, 5120, 17408, false, Some("r16n128s4+k2")),
                (16, 6144, 5120, false, Some("r16n128s4+k4")),
                (32, 6144, 5120, false, Some("r16n128s4+k2")),
                (16, 5120, 25600, false, Some("r16n128s4+k4")),
                (32, 1280, 5120, false, Some("r16n128s4+k4")),
                (128, 1280, 5120, false, Some("r16n128s4+k2")),
                (14, 256, 5120, false, Some("r16n128s4+k4")),
                // wide single-stream: in_all, in_qkv, draft gate/up; very
                // wide: lm_head (unsplit at <= 16 rows, legacy above)
                (16, 16480, 5120, false, Some("r16n128s4+k2")),
                (17, 16480, 5120, false, Some("r32n256s8")),
                (58, 14336, 5120, false, Some("r32n256s8")),
                (14, 248320, 5120, false, Some("r16n128s4")),
                (16, 248320, 5120, false, Some("r16n128s4")),
                (17, 248320, 5120, false, None),
                (21, 248320, 5120, false, None),
                (32, 248320, 5120, false, None),
                (16, 17408, 5120, false, Some("r16n128s4+k2")),
                // gate/up (per-stream out): fused 16-row tile, legacy
                // 17..127, staged 32x256 at 128
                (16, 17408, 5120, true, Some("r16n128s4+gu")),
                (17, 17408, 5120, true, None),
                (32, 17408, 5120, true, None),
                (127, 17408, 5120, true, None),
                (128, 17408, 5120, true, Some("r32n256s8")),
                // m > 128: legacy
                (129, 5120, 17408, false, None),
                (512, 16480, 5120, false, None),
                (512, 17408, 5120, true, None),
            ];
            for &(m, out, inp, gu, want) in cases {
                let got = pf_policy(m, out, inp, gu, 40);
                assert_eq!(got.map(|c| c.label()).as_deref(), want, "m={m} out={out} inp={inp} gate_up={gu}");
                if let Some(c) = got {
                    assert!(valid(c, inp, gu), "invalid {c:?} for m={m} out={out} inp={inp}");
                }
            }
        }

        /// `pf_warm` compiles PF_POLICY_SHAPES only: whatever the policy
        /// picks must be one of them (and instantiated and valid), or a
        /// request would still pay a lazy compile.
        #[test]
        fn pf_policy_only_returns_warmed_shapes() {
            let outs = [256, 1280, 5120, 6144, 14336, 16480, 17408, 248320];
            let inps = [4096, 5120, 6144, 17408, 25600];
            for cores in [10, 40, 80] {
                for m in 9..=160 {
                    for &out in &outs {
                        for &inp in &inps {
                            for gu in [false, true] {
                                if let Some(c) = pf_policy(m, out, inp, gu, cores) {
                                    assert!(
                                        PF_POLICY_SHAPES.contains(&(c.rows, c.tile_n, c.sgs)),
                                        "unwarmed {c:?} (m={m} out={out} inp={inp} gu={gu} cores={cores})"
                                    );
                                    assert!(valid(c, inp, gu), "invalid {c:?}");
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    impl CustomOp3 for AffineQsg {
        fn name(&self) -> &'static str {
            "affine-qsg"
        }
        fn cpu_fwd(
            &self,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("affine-qsg: Metal only")
        }

        fn metal_fwd(
            &self,
            s_wq: &MetalStorage,
            l_wq: &Layout,
            s_sb: &MetalStorage,
            l_sb: &Layout,
            s_x: &MetalStorage,
            l_x: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            check3(s_wq, l_wq, DType::U32, "wq")?;
            check3(s_sb, l_sb, DType::BF16, "sb")?;
            check3(s_x, l_x, DType::BF16, "x")?;
            if self.m == 0 || self.m > 8 {
                candle_core::bail!("affine-qsg: m {} out of range 1..=8", self.m);
            }
            if self.inp % 64 != 0 {
                candle_core::bail!("affine-qsg: in {} not %64", self.inp);
            }
            let ng = self.inp / 64;
            let tile = if self.aux > 0 { 32 } else { 64 };
            let splits = sg_splits(self.out, ng, tile);

            let device = s_wq.device();
            compile(&SG_PREP_PIPE, QMV_SRC, 64, "affine_q4_prepare", device)?;
            let (cell, fname, tgthr) = if self.aux > 0 {
                (&SG_GU_PIPE, "affine_q4_sg_gate_up", 128usize)
            } else if std::env::var("TH_QMM_SG8").is_ok() {
                (&SG8_PIPE, "affine_q4_sg8", 256)
            } else {
                (&SG_DEC_PIPE, "affine_q4_sg", 128)
            };
            compile(cell, QMV_SRC, 64, fname, device)?;

            let params = SGParams {
                out_dim: self.out as i32,
                in_dim: self.inp as i32,
                m: self.m as i32,
                splits: splits as i32,
                aux: self.aux as i32,
                tiled: self.tiled as i32,
            };

            // scratch: activation table, group sums, split partials,
            // arrival counters
            let table_buf = device
                .new_buffer_builder()
                .with_size_for(8 * self.inp, DType::BF16)
                .with_label("qsg.table")
                .build()
                .map_err(candle_core::Error::wrap)?;
            let sums_buf = device
                .new_buffer_builder()
                .with_size_for(ng * 8, DType::F32)
                .with_label("qsg.sums")
                .build()
                .map_err(candle_core::Error::wrap)?;
            let part_buf = device
                .new_buffer_builder()
                .with_size_for(
                    if splits > 1 { splits * 16 * self.out } else { 4 },
                    DType::F32,
                )
                .with_label("qsg.part")
                .build()
                .map_err(candle_core::Error::wrap)?;
            let ctr_buf = device
                .new_buffer_builder()
                .with_size_for(self.out.div_ceil(tile).max(1), DType::U32)
                .with_label("qsg.ctrs")
                .build()
                .map_err(candle_core::Error::wrap)?;
            let elems = self.out * self.m;
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(elems, DType::BF16)
                .with_label("qsg.y")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("affine_qsg");

            let enc_ref = &encoder;
            // pass 1: scatter x into the fragment table + group sums
            {
                let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                    enc_ref.encoder().as_ref();
                enc.set_compute_pipeline_state(SG_PREP_PIPE.get().unwrap());
                enc.set_input_buffer(
                    0,
                    Some(s_x.buffer()),
                    l_x.start_offset() * 2,
                );
                enc.set_output_buffer(1, Some(&table_buf), 0);
                enc.set_output_buffer(2, Some(&sums_buf), 0);
                enc.set_output_buffer(3, Some(&ctr_buf), 0);
                enc.set_bytes(4, &params);
                enc.dispatch_thread_groups(
                    MTLSize { width: ng * 2, height: 1, depth: 1 },
                    MTLSize { width: 128, height: 1, depth: 1 },
                );
            }

            // pass 2: fragment-direct dequant + MMA + split-K reduce
            {
                let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                    enc_ref.encoder().as_ref();
                enc.set_compute_pipeline_state(cell.get().unwrap());
                enc.set_input_buffer(
                    0,
                    Some(s_wq.buffer()),
                    l_wq.start_offset() * 4,
                );
                enc.set_input_buffer(
                    1,
                    Some(s_sb.buffer()),
                    l_sb.start_offset() * 2,
                );
                enc.set_input_buffer(2, Some(&table_buf), 0);
                enc.set_input_buffer(3, Some(&sums_buf), 0);
                enc.set_output_buffer(4, Some(&y_buf), 0);
                enc.set_input_buffer(5, Some(&part_buf), 0);
                enc.set_input_buffer(6, Some(&ctr_buf), 0);
                enc.set_bytes(7, &params);
                enc.set_threadgroup_memory_length(0, 4);
                enc.dispatch_thread_groups(
                    MTLSize {
                        width: self.out.div_ceil(tile),
                        height: splits,
                        depth: 1,
                    },
                    MTLSize { width: tgthr, height: 1, depth: 1 },
                );
            }
            let storage =
                MetalStorage::new(y_buf, device.clone(), elems, DType::BF16);
            Ok((storage, Shape::from((self.m, self.out))))
        }
    }

    impl CustomOp3 for AffineQmm {
        fn name(&self) -> &'static str {
            "affine-qmm"
        }
        fn cpu_fwd(
            &self,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("affine-qmm: Metal only")
        }

        fn metal_fwd(
            &self,
            s_wq: &MetalStorage,
            l_wq: &Layout,
            s_sb: &MetalStorage,
            l_sb: &Layout,
            s_x: &MetalStorage,
            l_x: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            check3(s_wq, l_wq, DType::U32, "wq")?;
            check3(s_sb, l_sb, DType::BF16, "sb")?;
            check3(s_x, l_x, DType::BF16, "x")?;
            if self.m == 0 || self.m > 8 {
                candle_core::bail!("affine-qmm: m {} out of range 1..=8", self.m);
            }

            let device = s_wq.device();
            compile(&QMM_PIPE, QMV_SRC, self.gs, "affine_qmm", device)?;
            let pipeline = QMM_PIPE.get().unwrap();

            let elems = self.out * self.m;
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(elems, DType::BF16)
                .with_label("qmm.y")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("affine_qmm");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipeline);
            let params = QmmParams {
                in_dim: self.inp as i32,
                out_dim: self.out as i32,
                ng: (self.inp / self.gs) as i32,
                m: self.m as i32,
                tiled: self.tiled as i32,
            };
            enc.set_input_buffer(0, Some(s_wq.buffer()), l_wq.start_offset() * 4);
            enc.set_input_buffer(1, Some(s_sb.buffer()), l_sb.start_offset() * 2);
            enc.set_input_buffer(2, Some(s_x.buffer()), l_x.start_offset() * 2);
            enc.set_output_buffer(3, Some(&y_buf), 0);
            enc.set_bytes(4, &params);
            enc.dispatch_thread_groups(
                MTLSize { width: self.out, height: 1, depth: 1 },
                MTLSize { width: 256, height: 1, depth: 1 },
            );
            let storage =
                MetalStorage::new(y_buf, device.clone(), elems, DType::BF16);
            Ok((storage, Shape::from((self.m, self.out))))
        }
    }

    impl CustomOp2 for AffineDequant {
        fn name(&self) -> &'static str {
            "affine-dequant"
        }
        fn cpu_fwd(
            &self,
            _: &CpuStorage, _: &Layout, _: &CpuStorage, _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("affine-dequant: Metal only")
        }

        fn metal_fwd(
            &self,
            s_wq: &MetalStorage,
            l_wq: &Layout,
            s_sb: &MetalStorage,
            l_sb: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            check3(s_wq, l_wq, DType::U32, "wq")?;
            check3(s_sb, l_sb, DType::BF16, "sb")?;

            let device = s_wq.device();
            compile(&DEQ_PIPE, DEQ_SRC, self.gs, "affine_dequant", device)?;
            let pipeline = DEQ_PIPE.get().unwrap();

            let elems = self.out * self.inp;
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(elems, DType::BF16)
                .with_label("dequant.w")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("affine_dequant");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipeline);
            let params = QParams {
                in_dim: self.inp as i32,
                out_dim: self.out as i32,
                ng: (self.inp / self.gs) as i32,
                tiled: self.tiled as i32,
            };
            enc.set_input_buffer(0, Some(s_wq.buffer()), l_wq.start_offset() * 4);
            enc.set_input_buffer(1, Some(s_sb.buffer()), l_sb.start_offset() * 2);
            enc.set_output_buffer(2, Some(&y_buf), 0);
            enc.set_bytes(3, &params);
            let tg = 256usize;
            enc.dispatch_thread_groups(
                MTLSize {
                    width: elems.div_ceil(tg),
                    height: 1,
                    depth: 1,
                },
                MTLSize { width: tg, height: 1, depth: 1 },
            );
            let storage =
                MetalStorage::new(y_buf, device.clone(), elems, DType::BF16);
            Ok((storage, Shape::from((self.out, self.inp))))
        }
    }
}
