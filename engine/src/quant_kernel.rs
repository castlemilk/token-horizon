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
pub use metal_impl::{AffineDequant, AffineQmm, AffineQmv, AffineQsg};

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
    }

    pub struct AffineDequant {
        pub inp: usize,
        pub out: usize,
        pub gs: usize,
    }

    #[repr(C)]
    struct QParams {
        in_dim: i32,
        out_dim: i32,
        ng: i32,
    }

    #[repr(C)]
    struct QmmParams {
        in_dim: i32,
        out_dim: i32,
        ng: i32,
        m: i32,
    }

    /// Packed dims for `y[M,out] = x[M,in] @ W[out,in]` with W kept in
    /// packed affine form. M ≤ 8 (spec-decode verify, short batches).
    pub struct AffineQmm {
        pub inp: usize,
        pub out: usize,
        pub gs: usize,
        pub m: usize,
    }

    // words per row = IN/8; GS % 8 == 0 so a word never spans groups.
    const QMV_SRC: &str = r#"
#include <metal_stdlib>
#include <metal_simdgroup_matrix>
using namespace metal;

struct QParams { int in_dim; int out_dim; int ng; };
struct QmmParams { int in_dim; int out_dim; int ng; int m; };
constant constexpr int GS = {GS};

// 8 output rows per threadgroup — one simdgroup (32 lanes) per row.
// Each lane reads uint4 (16B = 32 nibbles) so rows walk memory in wide
// strides; x is shared across the 8 rows via L1/L2.
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
    device const uint4* wrow =
        (device const uint4*)(wq + row * words);
    device const bfloat* srow = sb + row * 2 * p.ng;

    float acc = 0.0f;
    for (int w4 = lane; w4 < words4; w4 += 32) {
        const uint4 pack = wrow[w4];
        const int base = w4 * 32;
        // GS % 32 == 0 so a uint4 never spans a group boundary.
        const int g = base / GS;
        const float sc = float(srow[g]);
        const float bi = float(srow[p.ng + g]);
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

struct SGParams { int out_dim; int in_dim; int m; int splits; int aux; };

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
            wq + ulong(row0) * words + g * 8 + c * 2) : uint2(0);
        w[1] = live1 ? *reinterpret_cast<device const uint2 *>(
            wq + ulong(row1) * words + g * 8 + c * 2) : uint2(0);
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
            acc[0] = fma(d0, float(sb[row0 * 2 * ng + g]), acc[0]);
            acc[0] = fma(sum, float(sb[row0 * 2 * ng + ng + g]), acc[0]);
        }
        if (live1) {
            acc[1] = fma(d1, float(sb[row1 * 2 * ng + g]), acc[1]);
            acc[1] = fma(sum, float(sb[row1 * 2 * ng + ng + g]), acc[1]);
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
            wq + ulong(grow) * words + g * 8 + c * 2) : uint2(0);
        w[1] = live1 ? *reinterpret_cast<device const uint2 *>(
            wq + ulong(urow) * words + g * 8 + c * 2) : uint2(0);
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
            acc[0] = fma(d0, float(sb[grow * 2 * ng + g]), acc[0]);
            acc[0] = fma(sum, float(sb[grow * 2 * ng + ng + g]), acc[0]);
        }
        if (live1) {
            acc[1] = fma(d1, float(sb[urow * 2 * ng + g]), acc[1]);
            acc[1] = fma(sum, float(sb[urow * 2 * ng + ng + g]), acc[1]);
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
    device const uint* wrow = wq + row * words;
    device const bfloat* srow = sb + row * 2 * p.ng;

    // NB: the m-loops use constant bounds + a guard so `acc` stays in
    // registers — a runtime `p.m` bound spills it to local memory.
    // x is read as uint4 (8 bf16) once per token-row per weight word:
    // scalar loads here made the multi-row pass ~6x slower than qmv.
    float acc[8];
    for (int m = 0; m < 8; ++m) acc[m] = 0.0f;

    for (int wd = tid; wd < words; wd += 256) {
        const uint pack = wrow[wd];
        const int base = wd * 8;
        const int g = base / GS;
        const float sc = float(srow[g]);
        const float bi = float(srow[p.ng + g]);
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
        const uint pack = wrow[wd];
        const int base = wd * 8;
        const int g = base / GS;
        const float sc = float(srow[g]);
        const float bi = float(srow[p.ng + g]);
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

struct QParams { int in_dim; int out_dim; int ng; };
constant constexpr int GS = {GS};

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
    const uint pack = wq[row * (p.in_dim / 8) + col / 8];
    const float q = float((pack >> ((col % 8) * 4)) & 0xF);
    const int g = col / GS;
    y[idx] = bfloat(q * float(sb[row * 2 * p.ng + g])
                    + float(sb[row * 2 * p.ng + p.ng + g]));
}
"#;

    static QMV_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static QMV_V1_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static QMM_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static DEQ_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

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
    }

    #[repr(C)]
    struct SGParams {
        out_dim: i32,
        in_dim: i32,
        m: i32,
        splits: i32,
        aux: i32,
    }

    static SG_PREP_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static SG_DEC_PIPE: OnceLock<ComputePipeline> = OnceLock::new();
    static SG_GU_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

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
            let (cell, fname) = if self.aux > 0 {
                (&SG_GU_PIPE, "affine_q4_sg_gate_up")
            } else {
                (&SG_DEC_PIPE, "affine_q4_sg")
            };
            compile(cell, QMV_SRC, 64, fname, device)?;

            let params = SGParams {
                out_dim: self.out as i32,
                in_dim: self.inp as i32,
                m: self.m as i32,
                splits: splits as i32,
                aux: self.aux as i32,
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
                    MTLSize { width: 128, height: 1, depth: 1 },
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
