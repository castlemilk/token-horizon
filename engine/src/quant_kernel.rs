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
pub use metal_impl::{
    AffineDequant, AffineQmm, AffineQmpp, AffineQmppPrefill, AffineQmv, AffineQmvT, AffineQsg,
    AllocBf16, ChunkTop16, Q4AttachSums, QMPP_BIND_ONLY, draft_conv_ps, draft_ring_write,
    draft_rmsnorm_ps, mpp_probe, qmvt_warm,
};

// MARK: - decode (m <= 8) tile policy

/// Which decode tile family `QLin` asks `AffineQmpp` for. Read once per
/// process (never per call): `TH_Q4_POLICY=legacy` restores the pre-WP-2
/// split-K tiles (n32s4 gate/up, n64s4 everywhere else) for A/B runs;
/// `TH_Q4_POLICY=seq` (alias `TH_Q4_SEQ=1`) runs a sequential-K tile on
/// every shape — no split-K reassociation anywhere (the Gate A arm).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Q4PolicyMode {
    /// WP-2 defaults: K1 N256 gate/up + the K2 per-shape table.
    Tuned,
    /// Pre-WP-2 tiles.
    Legacy,
    /// Sequential K everywhere (N256 sg8; Paired256 on very wide shapes).
    Seq,
}

pub fn q4_policy_mode() -> Q4PolicyMode {
    static MODE: std::sync::OnceLock<Q4PolicyMode> = std::sync::OnceLock::new();
    *MODE.get_or_init(|| {
        let mode = match std::env::var("TH_Q4_POLICY").as_deref() {
            Ok("legacy") => Q4PolicyMode::Legacy,
            Ok("seq") => Q4PolicyMode::Seq,
            _ if std::env::var("TH_Q4_SEQ").as_deref() == Ok("1") => Q4PolicyMode::Seq,
            _ => Q4PolicyMode::Tuned,
        };
        tracing::info!(?mode, "q4 decode tile policy");
        mode
    })
}

/// GPU core count, resolved once per process: the `TH_GPU_CORES`
/// override, else the IORegistry `gpu-core-count` of the IOAccelerator
/// (as Splash's MetalBackend.mm reads it), else 40 (this M5 Max — the
/// previous hardcoded default). Replaces the per-call env reads in the
/// Q4 group policies; `QLin` load warms it so the lookup never lands on
/// a request.
pub fn gpu_cores() -> usize {
    static CORES: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *CORES.get_or_init(|| {
        let env = std::env::var("TH_GPU_CORES")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|&n| n > 0);
        let (cores, source) = match env {
            Some(n) => (n, "TH_GPU_CORES"),
            None => match ioreg_gpu_cores() {
                Some(n) => (n, "ioreg gpu-core-count"),
                None => (40, "default"),
            },
        };
        tracing::info!(cores, source, "gpu cores");
        cores
    })
}

/// `gpu-core-count` from the first IOAccelerator service (Apple silicon
/// has one GPU). `None` when the property is missing.
#[cfg(target_os = "macos")]
fn ioreg_gpu_cores() -> Option<usize> {
    use std::ffi::{c_char, c_void};
    type CFTypeRef = *const c_void;
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        // consumes one reference to `matching`
        fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> u32;
        fn IORegistryEntryCreateCFProperty(
            entry: u32,
            key: CFTypeRef,
            allocator: CFTypeRef,
            options: u32,
        ) -> CFTypeRef;
        fn IOObjectRelease(object: u32) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: CFTypeRef,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFTypeRef;
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFNumberGetValue(number: CFTypeRef, the_type: isize, value: *mut c_void) -> u8;
        fn CFRelease(cf: CFTypeRef);
    }
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const CF_NUMBER_SINT64: isize = 4;
    // SAFETY: plain IOKit/CF calls; every created/copied object is
    // released on every path (the matching dictionary is consumed).
    unsafe {
        let matching = IOServiceMatching(c"IOAccelerator".as_ptr());
        if matching.is_null() {
            return None;
        }
        let entry = IOServiceGetMatchingService(0, matching); // kIOMainPortDefault
        if entry == 0 {
            return None;
        }
        let key = CFStringCreateWithCString(
            std::ptr::null(),
            c"gpu-core-count".as_ptr(),
            CF_STRING_ENCODING_UTF8,
        );
        let value = if key.is_null() {
            std::ptr::null()
        } else {
            let v = IORegistryEntryCreateCFProperty(entry, key, std::ptr::null(), 0);
            CFRelease(key);
            v
        };
        IOObjectRelease(entry);
        if value.is_null() {
            return None;
        }
        let mut n: i64 = 0;
        let ok = CFGetTypeID(value) == CFNumberGetTypeID()
            && CFNumberGetValue(value, CF_NUMBER_SINT64, &mut n as *mut i64 as *mut c_void) != 0;
        CFRelease(value);
        (ok && n > 0 && n <= 4096).then_some(n as usize)
    }
}

#[cfg(not(target_os = "macos"))]
fn ioreg_gpu_cores() -> Option<usize> {
    None
}

/// `(tile, simdgroups)` for the fused [gate | up] projection at m = 2..=8
/// (`AffineQmpp` with `up_tile > 0`).
///
/// K1: the N256 two-stream tile (`affine_q4_mpp_gate_up`, one 8 x 256
/// gate+up tile pair per persistent group — 68 groups on the 27B MLP) is
/// sequential in K and bitwise equal to Splash's `n256_gate_up`; the
/// split-K `n32s4_gate_up` it replaces measured 10-15% slower on this
/// shape (274 vs 236 us, 44.5% of all verify bytes).
pub fn gate_up_tile() -> (usize, usize) {
    match q4_policy_mode() {
        Q4PolicyMode::Legacy => (64, 2),
        Q4PolicyMode::Tuned | Q4PolicyMode::Seq => (256, 8),
    }
}

/// One decode (m <= 8) tile family for a plain projection — what
/// `plain_tile` hands `AffineQmpp` as `(tile, simdgroups)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeTile {
    /// `affine_q4_mpp_n64s4`: 4-way split-K, 64 columns per 256-thread
    /// group, one group per 64 columns (fills the 40 cores on N=5120).
    N64Split4,
    /// `affine_q4_mpp`: persistent N256 x 8 simdgroups, pipelined,
    /// sequential K, `mpp_groups` round-robin policy.
    N256Sg8,
    /// `affine_q4_mpp_paired_sg4`: Splash `n256_paired_sg4` — N256 x 4
    /// simdgroups (128 threads) at one resident wave of
    /// `PAIRED256_WAVE_GROUPS_PER_CORE` x cores persistent groups.
    Paired256,
}

impl DecodeTile {
    /// The `(tile, sgs)` pair `AffineQmpp` dispatches on.
    pub fn tile_sgs(self) -> (usize, usize) {
        match self {
            DecodeTile::N64Split4 => (64, 2),
            DecodeTile::N256Sg8 => (256, 8),
            DecodeTile::Paired256 => (256, 4),
        }
    }
}

/// Splash `kPaired256TilesPerCore`: a plain projection this wide (in
/// 256-column tiles per core) takes the paired N256 tile.
pub const PAIRED256_TILES_PER_CORE: usize = 8;
/// Splash `kPaired256WaveGroupsPerCore`: persistent groups per core for
/// the paired N256 tile (4 x 128 threads = the 512-thread knee).
pub const PAIRED256_WAVE_GROUPS_PER_CORE: usize = 4;

/// K2: measured per-shape decode tiles `(out, in) -> tile` for plain
/// projections (M5 Max 40-core, Qwen3.8-27B 4-bit, m = 8, isolated
/// kernel GPU time — q4-kernels §5, re-checked with `TH_BENCH_Q4`):
///   GDN in_all 16480x5120: N256 sg8 117.7 us vs n64s4 131.3 (65 tiles).
/// K45 autotune (`TH_BENCH_Q4_SWEEP=1`: every tile family x persistent
/// group counts {1,2,3,4,6,8} x cores + full grid, target and DFlash
/// draft shapes, interleaved passes over all layers' tensors):
///   draft gate / up 17408x5120 (unfused): N256 sg8 122.3 us vs n64s4
///   137.0 (68 tiles, -11%).
/// Every other shape keeps its rule: the listed group counts never beat
/// the full grid / one-wave policy, and the generic n64s4 rule wins or
/// ties on attn in_qkv 14336x5120 (n64s4 95.2 vs N256 101.6), the N=5120
/// out/o/down projections (n64s4 43.3/121.9 us; a sequential tile only
/// gets 20-40 groups there — 79-111 us / 218 us) and the draft dyn
/// 1280x5120, qkv 6144x5120, o 5120x4096, fc 5120x25600 and selector
/// 256x5120 shapes.
const DECODE_TILE_TABLE: &[((usize, usize), DecodeTile)] =
    &[((16480, 5120), DecodeTile::N256Sg8), ((17408, 5120), DecodeTile::N256Sg8)];

/// K2: the decode tile for a plain `[out, in]` projection at m <= 8.
/// Very wide shapes (lm_head, 970 tiles) take Splash's paired N256 tile
/// at 4 x cores groups; listed shapes their measured tile; the rest the
/// n64s4 split-K tile. Pure function of the shape and the once-read
/// policy/core count — no per-call env reads.
pub fn plain_tile(out: usize, inp: usize) -> DecodeTile {
    plain_tile_for(q4_policy_mode(), out, inp, gpu_cores())
}

/// Pure form of [`plain_tile`] (explicit policy and core count).
pub fn plain_tile_for(mode: Q4PolicyMode, out: usize, inp: usize, cores: usize) -> DecodeTile {
    let tiles = out.div_ceil(256);
    let wide = tiles >= PAIRED256_TILES_PER_CORE * cores;
    match mode {
        Q4PolicyMode::Legacy => DecodeTile::N64Split4,
        Q4PolicyMode::Seq if wide => DecodeTile::Paired256,
        Q4PolicyMode::Seq => DecodeTile::N256Sg8,
        Q4PolicyMode::Tuned if wide => DecodeTile::Paired256,
        Q4PolicyMode::Tuned => DECODE_TILE_TABLE
            .iter()
            .find(|(shape, _)| *shape == (out, inp))
            .map_or(DecodeTile::N64Split4, |&(_, tile)| tile),
    }
}

/// P0: the widest input (K) `AffineQmpp` binds directly at m = 8. The
/// direct binding measured 0.5-7% faster per call than the pad copy on
/// every K <= 6144 projection (gate_up, in_all, in_qkv, out, o, lm_head)
/// but 2.4-3.8% slower on the MLP down projection (K = 17408) —
/// `TH_BENCH_Q4` interleaved `path+pad` arm, two runs, M5 Max. Longer
/// inputs keep the copy; the output is bitwise identical either way.
pub const PAD_SKIP_MAX_IN: usize = 8192;

/// P0: whether `AffineQmpp` may bind an exact [8, in] input directly
/// instead of copying it through the pad kernel. Off under the legacy
/// policy or with `TH_Q4_PAD=1` (read once).
pub fn pad_skip_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        q4_policy_mode() != Q4PolicyMode::Legacy
            && std::env::var("TH_Q4_PAD").as_deref() != Ok("1")
    })
}

/// K45 presum block size in bytes for an `in`-wide Q4 decode operand:
/// the zero-padded [8, in] bf16 activation followed by the f32
/// per-(quant group, row) input sums `[in / 64][8]` that the MPP decode
/// tiles would otherwise recompute in every threadgroup
/// (`q4_store_input_sums`). Producers that emit it: `AddRmsNorm { sums }`,
/// the N256 gate_up tile (`AffineQmpp { emit_sums }` → the down
/// projection) and `Q4AttachSums`.
pub const fn presum_block_bytes(inp: usize) -> usize {
    8 * inp * 2 + (inp / 64) * 8 * 4
}

/// E1(c) prefill presum block for `m > 8` rows of `inp` columns: the
/// activation zero-padded to whole 32-row tiles, then the f32 per-(row,
/// quant group) input sums in the prefill tiles' layout
/// [m_pad/32][inp/64][32] (what `pf_prep` would write). In bf16 elements.
pub const fn pf_presum_elems(m: usize, inp: usize) -> usize {
    let m_pad = m.div_ceil(32) * 32;
    m_pad * inp + 2 * m_pad * (inp / 64)
}


/// K45: whether decode projections use presum blocks (producer-emitted
/// input sums, no pad copy). Read once: `TH_Q4_PRESUM=0` or the legacy
/// policy turns it off (A/B arm).
pub fn presum_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        let on = q4_policy_mode() != Q4PolicyMode::Legacy
            && std::env::var("TH_Q4_PRESUM").as_deref() != Ok("0");
        tracing::info!(on, "q4 presum blocks");
        on
    })
}

/// K45: tile families whose presum inputs also take the PreSums kernel
/// (input sums staged from the block, no in-kernel recompute). Every other
/// family binds the block directly (no pad copy) but keeps recomputing
/// the sums. Default: the split-K tiles (`split`: N=5120/in_qkv-class
/// shapes, `split_long`: K > 8192) — the in-situ forward A/B (fwd8/fwd5)
/// had the N256 (`n256`, `gu`) PreSums tiles slower than their
/// recomputing twins. `TH_Q4_PS_FAMILIES=a,b|all|none` overrides (read
/// once; families `n256,gu,split,split_long,paired`).
pub fn ps_family_on(family: &str) -> bool {
    static ON: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    ON.get_or_init(|| {
        let v = std::env::var("TH_Q4_PS_FAMILIES")
            .unwrap_or_else(|_| "split,split_long".to_string());
        let fams: Vec<String> = v.split(',').map(|s| s.trim().to_string()).collect();
        tracing::info!(?fams, "q4 presum-kernel families");
        fams
    })
    .iter()
    .any(|f| f == family || f == "all")
}

/// `TH_QMM_SCALAR` set: `QLin` skips the MPP/sg kernels for the scalar
/// qmv/qmm reference path. Read once per process — `QLin` used to look
/// the variable up on every projection call (~250 per verify round).
pub fn qmm_scalar() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_QMM_SCALAR").is_ok())
}

/// `TH_QMV_SG` set: m = 1 on row-major (untiled) weights takes the sg
/// kernel instead of qmv. Read once per process.
pub fn qmv_sg() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_QMV_SG").is_ok())
}

// MARK: - m = 1 decode (K7)

/// Which kernel family an m = 1 projection on tiled weights runs. Read
/// once per process: `TH_M1_PATH=mpp` restores the pre-K7 route (the MPP
/// decode tile over a padded 8-row block, and gate/up as that tile plus
/// eager narrow + silu·mul) for A/B runs; `plain` / `gu` enable only the
/// plain-projection / fused gate-up half.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum M1Path {
    /// `AffineQmvT`: tiled-layout matvec, fused silu·mul on gate/up.
    Qmvt,
    /// pre-K7: `AffineQmpp` at m = 1.
    Mpp,
    /// A/B arm: `AffineQmvT` on plain projections only (gate/up keeps
    /// the pre-K7 eager narrow + silu·mul over a plain matvec).
    Plain,
    /// A/B arm: the fused gate/up `AffineQmvT` only.
    GateUp,
}

impl M1Path {
    /// Whether plain (`up_row == 0`) / gate-up m = 1 calls take `AffineQmvT`.
    pub fn qmvt(self, gate_up: bool) -> bool {
        match self {
            M1Path::Qmvt => true,
            M1Path::Mpp => false,
            M1Path::Plain => !gate_up,
            M1Path::GateUp => gate_up,
        }
    }
}

pub fn m1_path() -> M1Path {
    static PATH: std::sync::OnceLock<M1Path> = std::sync::OnceLock::new();
    *PATH.get_or_init(|| {
        let path = match std::env::var("TH_M1_PATH").as_deref() {
            Ok("mpp") => M1Path::Mpp,
            Ok("plain") => M1Path::Plain,
            Ok("gu") => M1Path::GateUp,
            _ => M1Path::Qmvt,
        };
        tracing::info!(?path, "m=1 decode path");
        path
    })
}

/// One `affine_qmvt_*` instantiation: a threadgroup covers `8 * rpl`
/// consecutive rows (each lane re-uses its activations over `rpl` row
/// groups) and splits K across `sgs` simdgroups.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QmvtCfg {
    pub rpl: usize,
    pub sgs: usize,
}

impl QmvtCfg {
    pub const R1S8: QmvtCfg = QmvtCfg { rpl: 1, sgs: 8 };
    pub const R2S4: QmvtCfg = QmvtCfg { rpl: 2, sgs: 4 };
    pub const R2S8: QmvtCfg = QmvtCfg { rpl: 2, sgs: 8 };
    pub const R4S4: QmvtCfg = QmvtCfg { rpl: 4, sgs: 4 };
    pub const R4S8: QmvtCfg = QmvtCfg { rpl: 4, sgs: 8 };
    pub const R8S8: QmvtCfg = QmvtCfg { rpl: 8, sgs: 8 };

    /// `"r4s8"` → `R4S8` (the `TH_QMVT*` override syntax); `None` unless
    /// the config is instantiated (`QMVT_KERNELS`).
    pub fn parse(v: &str) -> Option<QmvtCfg> {
        let v = v.trim().strip_prefix('r')?;
        let (rpl, sgs) = v.split_once('s')?;
        let c = QmvtCfg { rpl: rpl.parse().ok()?, sgs: sgs.parse().ok()? };
        QMVT_KERNELS.contains(&c).then_some(c)
    }
}

/// The `AffineQmvT` configs compiled into `QMVT_SRC` (plain and gate/up
/// alike) — keep in sync with its `TH_QMVT_ENTRY` list.
pub const QMVT_KERNELS: [QmvtCfg; 6] = [
    QmvtCfg::R1S8,
    QmvtCfg::R2S4,
    QmvtCfg::R2S8,
    QmvtCfg::R4S4,
    QmvtCfg::R4S8,
    QmvtCfg::R8S8,
];

/// The `AffineQmvT` config for an m = 1 `[out, in]` projection (`out` =
/// rows per stream for the fused gate/up). Pure function of the shape;
/// `TH_QMVT` / `TH_QMVT_GU` (`rXsY`, read once) override every plain /
/// gate-up shape for tuning runs.
pub fn qmvt_cfg(out: usize, inp: usize, gate_up: bool) -> QmvtCfg {
    static PLAIN: std::sync::OnceLock<Option<QmvtCfg>> = std::sync::OnceLock::new();
    static GU: std::sync::OnceLock<Option<QmvtCfg>> = std::sync::OnceLock::new();
    let over = if gate_up {
        *GU.get_or_init(|| std::env::var("TH_QMVT_GU").ok().and_then(|v| QmvtCfg::parse(&v)))
    } else {
        *PLAIN.get_or_init(|| std::env::var("TH_QMVT").ok().and_then(|v| QmvtCfg::parse(&v)))
    };
    over.unwrap_or_else(|| qmvt_cfg_for(out, inp, gate_up))
}

/// Weight rows (both streams for the fused gate/up) from which an m = 1
/// projection takes the 8-row `R1S8` threadgroups instead of `R2S4`.
pub const QMVT_WIDE_ROWS: usize = 8192;

/// Pure form of [`qmvt_cfg`] (no override). Measured on the M5 Max
/// (Qwen3.8-27B 4-bit, `TH_BENCH_Q4_M=1`, 2 x 15 interleaved passes over
/// every layer's tensor, us/call):
///   gate_up 2x17408x5120  r1s8 185.8  r2s8 186.2  r4s8 194.4  (pre-K7 216.2)
///   in_all  16480x5120    r1s8  94.4  r2s8  97.6  r4s8  97.9  (106.3)
///   in_qkv  14336x5120    r1s8  89.5  r2s8  91.8  r4s8  95.5  (105.3)
///   lm_head 248320x5120   r1s8  1252  r2s8  1260  r4s8  1264  (1344)
///   down    5120x17408    r2s4  93.7  r4s8  94.7  r1s8 101.8  (113.8)
///   out     5120x6144     r2s4  39.2  r4s8  39.6  r1s8  43.0  (48.2)
///   o       5120x6144     r2s4  46.1  r4s8  47.5  r1s8  50.4  (56.2)
/// Wide shapes want the finest grid (one 8-row group per threadgroup, K
/// over 8 simdgroups); the 20-tile N = 5120 shapes want 16-row x 4-sg
/// groups (320 threadgroups of 128 threads).
pub fn qmvt_cfg_for(out: usize, _inp: usize, gate_up: bool) -> QmvtCfg {
    let rows = if gate_up { 2 * out } else { out };
    if rows >= QMVT_WIDE_ROWS {
        QmvtCfg::R1S8
    } else {
        QmvtCfg::R2S4
    }
}

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use metal_impl::{
    pf_compile, pf_force_legacy, pf_force_legacy_large, pf_presum_on, pf_route, pf_shapes,
    pf_vec_layout_ok, pf_warm, AffineQpf, PfCfg,
};

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
    use super::QmvtCfg;

    // -- DFlash draft select: exact per-chunk top-16 ----------------------

    /// The draft proposal's candidate tables in ONE dispatch: for each of
    /// `n` bf16 logits rows (`chunks` x 512 columns), the top-16 values and
    /// in-chunk ids of every 512-column chunk, plus the selector rows as
    /// f32 — the exact packed vector `dflash::cand_tables` built from
    /// `to_dtype(F32)` + `sort_last_dim` (candle's bitonic `asort_desc_f32`
    /// + a value gather) + narrows + casts + a cat. Output (f32):
    /// `[n*chunks*16 values | n*chunks*16 ids | n*rank selector]`.
    ///
    /// R0c measured the sort alone at 656 us/round: candle's argsort re-reads
    /// every compared value from device memory at each of its 45 bitonic
    /// stages. This kernel runs the IDENTICAL network (same compare/swap
    /// rule per stage, desc order, 512 = ncols_pad) over a threadgroup copy
    /// of the chunk's values: float(bf16) equals the f32-cast input, so every
    /// comparison, swap and tie order is the same and the top-16 (values and
    /// ids, in order) is bit-identical.
    pub struct ChunkTop16 {
        pub n: usize,
        pub chunks: usize,
        pub rank: usize,
    }

    const TOP16_SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;
#define SWAP(x, y) { auto tmp = (x); (x) = (y); (y) = tmp; }
struct Top16Params { uint n; uint chunks; uint row_stride; uint sel_stride; uint rank; };
// grid (n*chunks + 1) threadgroups x 512 threads; the last threadgroup
// copies the selector rows (bf16 -> f32) behind the two top-16 planes.
kernel void chunk_top16(
    device const bfloat* x        [[buffer(0)]],
    device const bfloat* sel      [[buffer(1)]],
    device float*        out      [[buffer(2)]],
    constant Top16Params& p       [[buffer(3)]],
    uint tg  [[threadgroup_position_in_grid]],
    uint col [[thread_position_in_threadgroup]])
{
    threadgroup float tv[512];
    threadgroup uint  ti[512];
    const uint nck = p.n * p.chunks;
    if (tg >= nck) {
        device float* so = out + 2 * nck * 16;
        for (uint i = col; i < p.n * p.rank; i += 512) {
            so[i] = float(sel[(i / p.rank) * p.sel_stride + i % p.rank]);
        }
        return;
    }
    const uint row = tg / p.chunks, chunk = tg % p.chunks;
    // this thread's element (value, in-chunk id) — the network's position
    // `col`. candle's argsort<SORT_DESC> (ncols == ncols_pad == 512) does,
    // per stage (k, j), for each pair (c, c ^ j) with c < c ^ j: in a
    // descending segment ((c & k) == 0) swap iff x[c] < x[c^j], else swap
    // iff x[c] > x[c^j]. Both threads of a pair evaluate that same rule on
    // the same two elements, so each can take its own result: partners
    // j < 32 sit in the same simdgroup (register shuffles, no barrier),
    // j >= 32 exchange through threadgroup memory.
    float v = float(x[row * p.row_stride + chunk * 512 + col]);
    uint i = col;
    for (uint k = 2; k <= 512; k *= 2) {
        for (uint j = k / 2; j > 0; j /= 2) {
            float pv;
            uint pi;
            if (j < 32) {
                pv = simd_shuffle_xor(v, ushort(j));
                pi = simd_shuffle_xor(i, ushort(j));
            } else {
                tv[col] = v;
                ti[col] = i;
                threadgroup_barrier(mem_flags::mem_threadgroup);
                pv = tv[col ^ j];
                pi = ti[col ^ j];
                threadgroup_barrier(mem_flags::mem_threadgroup);
            }
            const bool lower = (col & j) == 0;          // this thread is c
            const float a = lower ? v : pv;              // element at c
            const float b = lower ? pv : v;              // element at c ^ j
            const bool desc = (((lower ? col : (col ^ j)) & k) == 0);
            const bool swap = desc ? (a < b) : (a > b);
            if (swap) {
                v = pv;
                i = pi;
            }
        }
    }
    if (col < 16) {
        const uint o = tg * 16 + col;
        out[o] = v;
        out[nck * 16 + o] = float(i);
    }
}
"#;

    static TOP16_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    impl CustomOp2 for ChunkTop16 {
        fn name(&self) -> &'static str {
            "chunk-top16"
        }
        fn cpu_fwd(&self, _: &CpuStorage, _: &Layout, _: &CpuStorage, _: &Layout) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("chunk-top16: Metal only")
        }
        fn metal_fwd(
            &self,
            s_x: &MetalStorage,
            l_x: &Layout,
            s_s: &MetalStorage,
            l_s: &Layout,
        ) -> Result<(MetalStorage, Shape)> {
            if s_x.dtype() != DType::BF16 || s_s.dtype() != DType::BF16 {
                candle_core::bail!("chunk-top16: logits / selector must be bf16");
            }
            let (xd, sd) = (l_x.shape().dims(), l_s.shape().dims());
            if xd.len() != 2 || xd[0] != self.n || xd[1] != self.chunks * 512
                || sd.len() != 2 || sd[0] != self.n || sd[1] != self.rank
                || l_x.stride()[1] != 1 || l_s.stride()[1] != 1
            {
                candle_core::bail!(
                    "chunk-top16: logits {:?}/{:?} selector {:?}/{:?} vs n {} chunks {} rank {}",
                    xd, l_x.stride(), sd, l_s.stride(), self.n, self.chunks, self.rank
                );
            }
            let device = s_x.device();
            if TOP16_PIPE.get().is_none() {
                let raw = device.metal_device();
                let lib = raw
                    .new_library_with_source(TOP16_SRC, None)
                    .map_err(candle_core::Error::wrap)?;
                let f = lib.get_function("chunk_top16", None).map_err(candle_core::Error::wrap)?;
                let pipe = raw
                    .new_compute_pipeline_state_with_function(&f)
                    .map_err(candle_core::Error::wrap)?;
                let _ = TOP16_PIPE.set(pipe);
            }
            let pipe = TOP16_PIPE.get().unwrap();
            if pipe.max_total_threads_per_threadgroup() < 512 {
                candle_core::bail!("chunk-top16: pipeline allows < 512 threads");
            }
            let nck = self.n * self.chunks;
            let elems = 2 * nck * 16 + self.n * self.rank;
            let out = device
                .new_buffer_builder()
                .with_size_for(elems, DType::F32)
                .with_label("draft.top16")
                .build()
                .map_err(candle_core::Error::wrap)?;
            #[repr(C)]
            struct Top16Params {
                n: u32,
                chunks: u32,
                row_stride: u32,
                sel_stride: u32,
                rank: u32,
            }
            let params = Top16Params {
                n: self.n as u32,
                chunks: self.chunks as u32,
                row_stride: l_x.stride()[0] as u32,
                sel_stride: l_s.stride()[0] as u32,
                rank: self.rank as u32,
            };
            let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("chunk_top16");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipe);
            enc.set_input_buffer(0, Some(s_x.buffer()), l_x.start_offset() * 2);
            enc.set_input_buffer(1, Some(s_s.buffer()), l_s.start_offset() * 2);
            enc.set_output_buffer(2, Some(&out), 0);
            enc.set_bytes(3, &params);
            enc.dispatch_thread_groups(
                MTLSize { width: nck + 1, height: 1, depth: 1 },
                MTLSize { width: 512, height: 1, depth: 1 },
            );
            drop(encoder);
            Ok((MetalStorage::new(out, device.clone(), elems, DType::F32), elems.into()))
        }
    }

    // -- DFlash draft commit: ring write ----------------------------------

    const RING_SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;
struct RingParams { int rows; int start_slot; int ks; int vs; int window; int heads; };
// grid (rows, heads) threadgroups x 128 threads: ring[h][(start + r) % W][d]
// = src[r][h][d] for K and V (src rows strided by ks / vs elements).
kernel void draft_ring_write(
    device const bfloat* k   [[buffer(0)]],
    device const bfloat* v   [[buffer(1)]],
    device bfloat*       rk  [[buffer(2)]],
    device bfloat*       rv  [[buffer(3)]],
    constant RingParams& p   [[buffer(4)]],
    uint2 g [[threadgroup_position_in_grid]],
    uint  t [[thread_index_in_threadgroup]])
{
    const int r = int(g.x), h = int(g.y);
    const int slot = (p.start_slot + r) % p.window;
    const ulong dst = (ulong(h) * ulong(p.window) + ulong(slot)) * 128ul + t;
    rk[dst] = k[r * p.ks + h * 128 + int(t)];
    rv[dst] = v[r * p.vs + h * 128 + int(t)];
}
"#;

    static RING_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    /// DFlash draft commit: write `rows` K and V rows (`[rows, heads, 128]`
    /// bf16, rows strided, heads contiguous) into the per-layer rings
    /// `[heads, window, 128]` at slots `(start_slot + r) % window`, in place,
    /// in one dispatch — replaces two permute copies, a host-built index
    /// upload, a broadcast copy and two `scatter_set`s per layer. The rings
    /// are the caller's persistent state, bound as tracked outputs (later
    /// readers — the next propose's draft attention — get barriers); no
    /// storage is created around an existing buffer.
    pub fn draft_ring_write(
        k: &candle_core::Tensor,
        v: &candle_core::Tensor,
        ring_k: &candle_core::Tensor,
        ring_v: &candle_core::Tensor,
        start_slot: usize,
    ) -> Result<()> {
        use candle_core::Storage;
        let (rows, heads) = (k.dim(0)?, k.dim(1)?);
        let window = ring_k.dim(1)?;
        for (t, name) in [(k, "k"), (v, "v")] {
            let st = t.stride();
            if t.dims() != [rows, heads, 128] || st[1] != 128 || st[2] != 1 || t.dtype() != DType::BF16 {
                candle_core::bail!("draft_ring_write: {name} {:?}/{:?} needs [rows, heads, 128] bf16 with contiguous heads", t.dims(), st);
            }
        }
        for (t, name) in [(ring_k, "ring_k"), (ring_v, "ring_v")] {
            if t.dims() != [heads, window, 128] || !t.is_contiguous() || t.dtype() != DType::BF16 {
                candle_core::bail!("draft_ring_write: {name} {:?} needs contiguous [{heads}, {window}, 128] bf16", t.dims());
            }
        }
        if rows == 0 || rows > window || start_slot >= window {
            candle_core::bail!("draft_ring_write: rows {rows} start {start_slot} window {window}");
        }
        let (gk, lk) = k.storage_and_layout();
        let (gv, lv) = v.storage_and_layout();
        let (grk, lrk) = ring_k.storage_and_layout();
        let (grv, lrv) = ring_v.storage_and_layout();
        let (Storage::Metal(sk), Storage::Metal(sv), Storage::Metal(srk), Storage::Metal(srv)) =
            (&*gk, &*gv, &*grk, &*grv)
        else {
            candle_core::bail!("draft_ring_write: Metal only")
        };
        if srk.buffer() == srv.buffer() && lrk.start_offset() == lrv.start_offset() {
            candle_core::bail!("draft_ring_write: ring_k aliases ring_v");
        }
        let device = sk.device();
        if RING_PIPE.get().is_none() {
            let raw = device.metal_device();
            let lib = raw
                .new_library_with_source(RING_SRC, None)
                .map_err(candle_core::Error::wrap)?;
            let f = lib.get_function("draft_ring_write", None).map_err(candle_core::Error::wrap)?;
            let pipe = raw
                .new_compute_pipeline_state_with_function(&f)
                .map_err(candle_core::Error::wrap)?;
            let _ = RING_PIPE.set(pipe);
        }
        #[repr(C)]
        struct RingParams {
            rows: i32,
            start_slot: i32,
            ks: i32,
            vs: i32,
            window: i32,
            heads: i32,
        }
        let params = RingParams {
            rows: rows as i32,
            start_slot: start_slot as i32,
            ks: lk.stride()[0] as i32,
            vs: lv.stride()[0] as i32,
            window: window as i32,
            heads: heads as i32,
        };
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("draft_ring_write");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
            enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(RING_PIPE.get().unwrap());
        enc.set_input_buffer(0, Some(sk.buffer()), lk.start_offset() * 2);
        enc.set_input_buffer(1, Some(sv.buffer()), lv.start_offset() * 2);
        enc.set_output_buffer(2, Some(srk.buffer()), lrk.start_offset() * 2);
        enc.set_output_buffer(3, Some(srv.buffer()), lrv.start_offset() * 2);
        enc.set_bytes(4, &params);
        enc.dispatch_thread_groups(
            MTLSize { width: rows, height: heads, depth: 1 },
            MTLSize { width: 128, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(())
    }

    // -- DFlash draft presum producers (K45 follow-up) ---------------------

    /// candle's own `rms_norm<bfloat, 1024>` (reduce.metal — the exact
    /// instantiation `candle_nn::ops::rms_norm` runs for the draft's C = 5120
    /// rows: one 1024-thread threadgroup per row), compiled from candle's
    /// REDUCE source with a K45 presum epilogue appended: after the row is
    /// normed, a device barrier, then per 64-channel quant group the input
    /// sum with the decode tiles' lane pattern `simd_sum(x[64g+l] +
    /// x[64g+32+l])`. Rows >= t are the block's zero padding.
    const DRN_PS_SRC: &str = r#"
// th-engine: DFlash draft presum producer (see quant_kernel.rs)
kernel void th_draft_rmsnorm_ps(
    constant uint &src_numel    [[buffer(0)]],
    constant uint &el_per_block [[buffer(1)]],
    device const bfloat *src    [[buffer(2)]],
    device bfloat *dst          [[buffer(3)]],
    device const bfloat *alpha  [[buffer(4)]],
    constant float &eps         [[buffer(5)]],
    constant uint &t_rows       [[buffer(6)]],
    uint tid    [[ thread_index_in_threadgroup ]],
    uint dst_id [[ threadgroup_position_in_grid ]],
    uint lane   [[ thread_index_in_simdgroup ]],
    uint sg     [[ simdgroup_index_in_threadgroup ]])
{
    threadgroup RMS<float> shared[1024];
    threadgroup float total;
    const uint C = el_per_block;
    const uint ng = C / 64;
    device float *sums = (device float *)(dst + 8 * C);
    if (dst_id >= t_rows) {
        for (uint i = tid; i < C; i += 1024) dst[dst_id * C + i] = bfloat(0.0f);
        for (uint g = tid; g < ng; g += 1024) sums[g * 8 + dst_id] = 0.0f;
        return;
    }
    rms_norm<bfloat, 1024>(src_numel, el_per_block, src, dst, alpha, eps,
                           shared, total, tid, dst_id);
    threadgroup_barrier(mem_flags::mem_device);
    for (uint g = sg; g < ng; g += 32) {
        const uint o = dst_id * C + g * 64 + lane;
        const float s = simd_sum(float(dst[o]) + float(dst[o + 32]));
        if (lane == 0) sums[g * 8 + dst_id] = s;
    }
}
"#;

    /// `draft_conv_fused`'s per-element expression (draft_kernel.rs, stage
    /// 0/1 without and with residual — the same source text) regrouped so
    /// that one simdgroup owns one (row, 64-channel quant group): lane l
    /// computes channels 64g+l and 64g+32+l, writes them into the block and
    /// emits the group's presum sum with the tiles' lane pattern.
    const DCONV_PS_SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;
struct DcpParams { int stage; int has_res; int t; int _pad; };
// grid (C/64 groups, 8 rows) threadgroups x 32 threads.
kernel void th_draft_conv_ps(
    device const bfloat* x     [[buffer(0)]],
    device const bfloat* dyn   [[buffer(1)]],
    device const bfloat* base  [[buffer(2)]],
    device const bfloat* res   [[buffer(3)]],
    device bfloat*       out   [[buffer(4)]],
    constant DcpParams&  p     [[buffer(5)]],
    uint2 tg   [[threadgroup_position_in_grid]],
    uint  lane [[thread_index_in_simdgroup]])
{
    const int gq = int(tg.x), r = int(tg.y);
    device float* sums = (device float*)(out + 8 * 5120);
    if (r >= p.t) {
        out[r * 5120 + gq * 64 + int(lane)] = bfloat(0.0f);
        out[r * 5120 + gq * 64 + 32 + int(lane)] = bfloat(0.0f);
        if (lane == 0) sums[gq * 8 + r] = 0.0f;
        return;
    }
    float h[2];
    for (int k = 0; k < 2; ++k) {
        const int c = gq * 64 + k * 32 + int(lane);
        const int i = r * 5120 + c;
        const int g = c / 16;
        const int off = p.stage * 640;
        const float t0 = float(dyn[r * 1280 + off + g])
                       + float(base[p.stage * 2 * 5120 + c]);
        const float t1 = float(dyn[r * 1280 + off + 320 + g])
                       + float(base[(p.stage * 2 + 1) * 5120 + c]);
        const float prev = (r & 7) > 0 ? float(x[i - 5120]) : 0.0f;
        float v = float(x[i]) * t0 + prev * t1;
        if (p.has_res) v += float(res[i]);
        const bfloat b = bfloat(v);
        out[i] = b;
        h[k] = float(b);
    }
    const float s = simd_sum(h[0] + h[1]);
    if (lane == 0) sums[gq * 8 + r] = s;
}
"#;

    static DRN_PS_PIPE: OnceLock<Option<ComputePipeline>> = OnceLock::new();
    static DCONV_PS_PIPE: OnceLock<ComputePipeline> = OnceLock::new();

    fn metal_parts(
        t: &candle_core::Tensor,
    ) -> Result<(candle_core::MetalDevice, candle_metal_kernels::metal::Buffer, usize)> {
        let (st, l) = t.storage_and_layout();
        match &*st {
            candle_core::Storage::Metal(m) => {
                Ok((m.device().clone(), m.buffer().clone(), l.start_offset() * t.dtype().size_in_bytes()))
            }
            _ => candle_core::bail!("draft presum producer: Metal only"),
        }
    }

    /// DFlash draft RMSNorm emitting a K45 presum block. `x` holds >= `row_off
    /// + t` contiguous rows of `c` (any leading dims); rows `row_off..row_off
    /// + t` are normed into block rows `0..t` (bit-identical to
    /// `candle_nn::ops::rms_norm` on those rows), rows `t..8` are zero, then
    /// the input sums. Returns the `[1, t, c]` view of the block (the buffer
    /// holds `presum_block_bytes(c)`), or `None` when the shape does not match
    /// candle's 1024-thread instantiation (c < 2048, c % 64 != 0, t not in
    /// 1..=8) — the caller keeps `rms_norm`.
    pub fn draft_rmsnorm_ps(
        x: &candle_core::Tensor,
        w: &candle_core::Tensor,
        eps: f32,
        row_off: usize,
        t: usize,
    ) -> Result<Option<candle_core::Tensor>> {
        let c = *x.dims().last().unwrap_or(&0);
        let rows_avail = x.elem_count() / c.max(1);
        if c < 2048 || c % 64 != 0 || !(1..=8).contains(&t) || row_off + t > rows_avail
            || !x.is_contiguous() || !w.is_contiguous() || w.elem_count() != c
            || x.dtype() != DType::BF16 || w.dtype() != DType::BF16
        {
            return Ok(None);
        }
        let (device, xb, xo) = metal_parts(x)?;
        let (_, wb, wo) = metal_parts(w)?;
        let pipe = DRN_PS_PIPE.get_or_init(|| {
            let raw = device.metal_device();
            let src = format!("{}\n{}", candle_metal_kernels::source::REDUCE, DRN_PS_SRC);
            let lib = raw.new_library_with_source(&src, None).ok()?;
            let f = lib.get_function("th_draft_rmsnorm_ps", None).ok()?;
            let p = raw.new_compute_pipeline_state_with_function(&f).ok()?;
            (p.max_total_threads_per_threadgroup() >= 1024).then_some(p)
        });
        let Some(pipe) = pipe.as_ref() else {
            return Ok(None);
        };
        let block = crate::outbuf::kernel_out(
            (super::presum_block_bytes(c) / 2,),
            DType::BF16,
            x.device(),
        )?;
        let (_, bb, bo) = metal_parts(&block)?;
        let (numel, epb, trows) = ((t * c) as u32, c as u32, t as u32);
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("th_draft_rmsnorm_ps");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder = enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(pipe);
        enc.set_bytes(0, &numel);
        enc.set_bytes(1, &epb);
        enc.set_input_buffer(2, Some(&xb), xo + row_off * c * 2);
        enc.set_output_buffer(3, Some(&bb), bo);
        enc.set_input_buffer(4, Some(&wb), wo);
        enc.set_bytes(5, &eps);
        enc.set_bytes(6, &trows);
        enc.dispatch_thread_groups(
            MTLSize { width: 8, height: 1, depth: 1 },
            MTLSize { width: 1024, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(Some(block.narrow(0, 0, t * c)?.reshape((1, t, c))?))
    }

    /// `draft_conv_fused` emitting a K45 presum block: `x` / `res` are
    /// contiguous `[1, 8, 5120]` (one draft block), `dyn_` `[1, 8, 1280]`,
    /// `base` `[4, 5120]`. Values are bit-identical to `draft_conv_fused`;
    /// returns the `[1, 8, 5120]` view of the block.
    pub fn draft_conv_ps(
        x: &candle_core::Tensor,
        dyn_: &candle_core::Tensor,
        base: &candle_core::Tensor,
        res: Option<&candle_core::Tensor>,
        stage: usize,
    ) -> Result<candle_core::Tensor> {
        const C: usize = 5120;
        for (t, n, name) in [(x, 8 * C, "x"), (dyn_, 8 * 1280, "dyn"), (base, 4 * C, "base")] {
            if !t.is_contiguous() || t.elem_count() != n || t.dtype() != DType::BF16 {
                candle_core::bail!("draft_conv_ps: {name} {:?} needs {n} contiguous bf16", t.dims());
            }
        }
        if let Some(r) = res {
            if !r.is_contiguous() || r.elem_count() != 8 * C || r.dtype() != DType::BF16 {
                candle_core::bail!("draft_conv_ps: res {:?} needs [1, 8, 5120] contiguous bf16", r.dims());
            }
        }
        if stage > 1 {
            candle_core::bail!("draft_conv_ps: stage {stage}");
        }
        let (device, xb, xo) = metal_parts(x)?;
        let (_, db, dbo) = metal_parts(dyn_)?;
        let (_, bsb, bso) = metal_parts(base)?;
        let (rb, ro) = match res {
            Some(r) => {
                let (_, b, o) = metal_parts(r)?;
                (b, o)
            }
            None => (xb.clone(), xo),
        };
        if DCONV_PS_PIPE.get().is_none() {
            let raw = device.metal_device();
            let lib = raw
                .new_library_with_source(DCONV_PS_SRC, None)
                .map_err(candle_core::Error::wrap)?;
            let f = lib.get_function("th_draft_conv_ps", None).map_err(candle_core::Error::wrap)?;
            let p = raw
                .new_compute_pipeline_state_with_function(&f)
                .map_err(candle_core::Error::wrap)?;
            let _ = DCONV_PS_PIPE.set(p);
        }
        let block = crate::outbuf::kernel_out((super::presum_block_bytes(C) / 2,), DType::BF16, x.device())?;
        let (_, bb, bo) = metal_parts(&block)?;
        #[repr(C)]
        struct DcpParams {
            stage: i32,
            has_res: i32,
            t: i32,
            _pad: i32,
        }
        let params = DcpParams { stage: stage as i32, has_res: res.is_some() as i32, t: 8, _pad: 0 };
        let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
        encoder.set_label("th_draft_conv_ps");
        let enc_ref = &encoder;
        let enc: &candle_metal_kernels::metal::ComputeCommandEncoder = enc_ref.encoder().as_ref();
        enc.set_compute_pipeline_state(DCONV_PS_PIPE.get().unwrap());
        enc.set_input_buffer(0, Some(&xb), xo);
        enc.set_input_buffer(1, Some(&db), dbo);
        enc.set_input_buffer(2, Some(&bsb), bso);
        enc.set_input_buffer(3, Some(&rb), ro);
        enc.set_output_buffer(4, Some(&bb), bo);
        enc.set_bytes(5, &params);
        enc.dispatch_thread_groups(
            MTLSize { width: C / 64, height: 8, depth: 1 },
            MTLSize { width: 32, height: 1, depth: 1 },
        );
        drop(encoder);
        Ok(block.narrow(0, 0, 8 * C)?.reshape((1, 8, C))?)
    }

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
// Guarded=false is the verbatim Splash epilogue (every row of every tile
// is stored) — only valid when out_dim % 256 == 0 and the output holds 8
// rows; the per-element arithmetic is identical, so it is bit-identical.
//
// K45 presum block: PreSums=true reads the per-(quant group, row) input
// sums precomputed by the producer (f32 [qg][8], stored right after the
// zero-padded 8-row activation; the entry point stages them in
// threadgroup memory once per dispatch -> `psums[qg * 8 + row]`) instead
// of recomputing them per tile with `q4_store_input_sums` + a barrier
// every 4 groups. The producer computes them with the identical lane pattern
// (simd_sum(x[64g + l] + x[64g + 32 + l])), so results are bit-identical.
// EmitSums=true (unguarded GateUp only) stages the tile's bf16 outputs in
// threadgroup memory and writes the down projection's presum sums
// (`osums`) the same way — the output becomes a presum block itself.
template <bool GateUp, ushort Simdgroups, bool Guarded = true,
          bool PreSums = false, bool EmitSums = false>
inline void th_mpp_tile(device bfloat *input, device uchar *weights_0,
                        device bfloat *scales_0, device bfloat *biases_0,
                        device bfloat *output_0,
                        device uchar *weights_1, device bfloat *scales_1,
                        device bfloat *biases_1,
                        uint output_size, uint input_size, uint m,
                        threadgroup float *input_sums,
                        const threadgroup float *psums, device float *osums,
                        threadgroup bfloat *otile, uint output_origin,
                        uint simd_lane, uint simd_group) {
  static_assert(!EmitSums || (GateUp && !Guarded),
                "EmitSums needs the unguarded gate_up epilogue");
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

  if constexpr (!PreSums) {
    q4_store_input_sums<8, Simdgroups>(input, input_size, 0, input_sums, 0,
                                       simd_lane, simd_group);
    threadgroup_barrier(mem_flags::mem_threadgroup);
  }
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
      float sum;
      if constexpr (PreSums) {
        sum = psums[quant_group * 8 + row];
      } else {
        uint sum_offset =
            ((quant_group >> 2) & 1) * 32 + (quant_group & 3) * 8;
        sum = input_sums[sum_offset + row];
      }
      accumulated_0[i] +=
          partial_0[i] * float(scales_0[parameter]) +
          sum * float(biases_0[parameter]);
      if constexpr (GateUp) {
        accumulated_1[i] +=
            partial_1[i] * float(scales_1[parameter]) +
            sum * float(biases_1[parameter]);
      }
    });
    if constexpr (!PreSums) {
      if ((quant_group & 3) == 3 && quant_group + 1 < quant_groups) {
        uint next_group = (quant_group + 1) >> 2;
        q4_store_input_sums<8, Simdgroups>(input, input_size,
                                           quant_group * 64 + 64, input_sums,
                                           (next_group & 1) * 32, simd_lane,
                                           simd_group);
        threadgroup_barrier(mem_flags::mem_threadgroup);
      }
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
    if constexpr (Guarded) {
      if (output_origin + index[0] >= output_size || index[1] >= m) return;
    }
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
    if constexpr (EmitSums)
      otile[index[1] * 256 + index[0]] = bfloat(value);
  });
  if constexpr (EmitSums) {
    // the down projection's presum sums for this tile's 4 quant groups,
    // in q4_store_input_sums' lane pattern (bit-identical to recomputing)
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint row = simd_group; row < 8; row += Simdgroups) {
#pragma unroll
      for (uint g = 0; g < 4; ++g) {
        uint o = row * 256 + g * 64 + simd_lane;
        float s = simd_sum(float(otile[o]) + float(otile[o + 32]));
        if (simd_lane == 0)
          osums[(output_origin / 64 + g) * 8 + row] = s;
      }
    }
  }
  if constexpr (!PreSums || EmitSums)
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
template <ushort TileN, bool GateUp, ushort Simdgroups, ushort SplitK,
          bool PreSums = false>
inline void th_mpp_tile_split(
    device bfloat *input, device uchar *weights_0,
    device bfloat *scales_0, device bfloat *biases_0,
    threadgroup float *partials,
    device uchar *weights_1, device bfloat *scales_1,
    device bfloat *biases_1, uint input_size,
    threadgroup float *input_sums, const threadgroup float *psums,
    uint output_origin,
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

  if constexpr (!PreSums) {
    q4_store_input_sums<8, Simdgroups>(input, input_size, first_group * 64,
                                       input_sums, 0, simd_lane, simd_group);
    threadgroup_barrier(mem_flags::mem_threadgroup);
  }
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
      float sum;
      if constexpr (PreSums) {
        sum = psums[(first_group + quant_group) * 8 + row];
      } else {
        uint sum_offset =
            ((quant_group >> 2) & 1) * 32 + (quant_group & 3) * 8;
        sum = input_sums[sum_offset + row];
      }
      accumulated_0[i] +=
          partial_0[i] * float(scales_0[parameter]) +
          sum * float(biases_0[parameter]);
      if constexpr (GateUp) {
        accumulated_1[i] +=
            partial_1[i] * float(scales_1[parameter]) +
            sum * float(biases_1[parameter]);
      }
    });
    if constexpr (!PreSums) {
      if ((quant_group & 3) == 3 && quant_group + 1 < quant_groups) {
        uint next_group = (quant_group + 1) >> 2;
        q4_store_input_sums<8, Simdgroups>(
            input, input_size, (first_group + quant_group) * 64 + 64,
            input_sums, (next_group & 1) * 32, simd_lane, simd_group);
        threadgroup_barrier(mem_flags::mem_threadgroup);
      }
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

#define TH_SPLIT_ENTRY(Name, TileN, Sgs, GateUp, PreSums)                     \
kernel void Name(                                                             \
    device const bfloat* input  [[buffer(0)]],                                \
    device const uchar*  weights [[buffer(1)]],                               \
    device const bfloat* sb      [[buffer(2)]],                               \
    device bfloat*       output  [[buffer(3)]],                               \
    constant MppParams&  p       [[buffer(4)]],                               \
    threadgroup float* staged    [[threadgroup(0)]],                          \
    uint group      [[threadgroup_position_in_grid]],                         \
    uint lane       [[thread_index_in_simdgroup]],                            \
    uint simd       [[simdgroup_index_in_threadgroup]]) {                     \
  constexpr uint Parts = 4;                                                   \
  threadgroup float sums[PreSums ? 1 : 4 * 64],                               \
      partials[(GateUp ? 2 : 1) * Parts * 8 * TileN];                         \
  const uint partition = simd / Sgs;                                          \
  device bfloat* inp = const_cast<device bfloat*>(input);                     \
  if (PreSums) {                                                              \
    device const float* ps =                                                  \
        (device const float*)(input + 8 * uint(p.in_dim));                   \
    const uint n = 8u * (uint(p.in_dim) / 64u);                               \
    for (uint i = simd * 32 + lane; i < n; i += Parts * Sgs * 32)             \
      staged[i] = ps[i];                                                      \
    threadgroup_barrier(mem_flags::mem_threadgroup);                          \
  }                                                                           \
  device const bfloat* biases = sb + p.bias_base;                             \
  device uchar* w1 = const_cast<device uchar*>(weights) + p.up_woff;          \
  device bfloat* s1 = const_cast<device bfloat*>(sb) + p.up_soff;             \
  device bfloat* b1 = const_cast<device bfloat*>(sb) + p.bias_base            \
                      + p.up_soff;                                            \
  const uint tiles = (uint(p.out_dim) + TileN - 1) / TileN;                   \
  for (uint tile = group; tile < tiles; tile += uint(p.groups)) {             \
    th_mpp_tile_split<TileN, GateUp, Sgs, Parts, PreSums>(                    \
        inp, const_cast<device uchar*>(weights),                              \
        const_cast<device bfloat*>(sb),                                       \
        const_cast<device bfloat*>(biases), partials, w1, s1, b1,             \
        p.in_dim, PreSums ? sums : sums + partition * 64, staged,             \
        tile * TileN,                                                         \
        lane, simd % Sgs, partition);                                         \
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

TH_SPLIT_ENTRY(affine_q4_mpp_n32s4, 32, 1, false, false)
TH_SPLIT_ENTRY(affine_q4_mpp_n64s4, 64, 2, false, false)
TH_SPLIT_ENTRY(affine_q4_mpp_n32s4_gate_up, 32, 1, true, false)
TH_SPLIT_ENTRY(affine_q4_mpp_n32s4_ps, 32, 1, false, true)
TH_SPLIT_ENTRY(affine_q4_mpp_n64s4_ps, 64, 2, false, true)

// Input presum block (PreSums): psums follow the 8-row activation block;
// output presum block (EmitSums): osums follow the 8-row output block.
#define TH_MPP_ENTRY(Name, GateUp, Sgs, Guarded, PreSums, EmitSums)           \
kernel void Name(                                                             \
    device const bfloat* input  [[buffer(0)]],                                \
    device const uchar*  weights [[buffer(1)]],                               \
    device const bfloat* sb      [[buffer(2)]],                               \
    device bfloat*       output  [[buffer(3)]],                               \
    constant MppParams&  p       [[buffer(4)]],                               \
    threadgroup float* staged    [[threadgroup(0)]],                          \
    uint group      [[threadgroup_position_in_grid]],                         \
    uint simd_lane  [[thread_index_in_simdgroup]],                            \
    uint simd_group [[simdgroup_index_in_threadgroup]]) {                     \
  threadgroup float input_sums[PreSums ? 1 : 64];                             \
  threadgroup bfloat otile[EmitSums ? 8 * 256 : 1];                           \
  const uint tiles = (uint(p.out_dim) + 255u) >> 8;                           \
  device bfloat* inp = const_cast<device bfloat*>(input);                     \
  if (PreSums) {                                                              \
    device const float* ps =                                                  \
        (device const float*)(input + 8 * uint(p.in_dim));                   \
    const uint n = 8u * (uint(p.in_dim) / 64u);                               \
    for (uint i = simd_group * 32 + simd_lane; i < n; i += Sgs * 32)          \
      staged[i] = ps[i];                                                      \
    threadgroup_barrier(mem_flags::mem_threadgroup);                          \
  }                                                                           \
  device float* os = (device float*)(output + 8 * uint(p.out_dim));          \
  device uchar* w1 = const_cast<device uchar*>(weights) + p.up_woff;          \
  device const bfloat* biases = sb + p.bias_base;                             \
  device bfloat* s1 = const_cast<device bfloat*>(sb) + p.up_soff;             \
  device bfloat* b1 = const_cast<device bfloat*>(sb) + p.bias_base            \
                      + p.up_soff;                                            \
  for (uint tile = group; tile < tiles; tile += uint(p.groups)) {             \
    th_mpp_tile<GateUp, Sgs, Guarded, PreSums, EmitSums>(inp,                 \
        const_cast<device uchar*>(weights),                                   \
        const_cast<device bfloat*>(sb), const_cast<device bfloat*>(biases),   \
        output, w1, s1, b1, p.out_dim, p.in_dim, p.m, input_sums, staged, os, \
        otile, tile * 256, simd_lane, simd_group);                            \
  }                                                                           \
}

TH_MPP_ENTRY(affine_q4_mpp, false, 8, true, false, false)
TH_MPP_ENTRY(affine_q4_mpp_sg4, false, 4, true, false, false)
TH_MPP_ENTRY(affine_q4_mpp_gate_up, true, 8, true, false, false)
TH_MPP_ENTRY(affine_q4_mpp_gate_up_sg4, true, 4, true, false, false)
// K45 presum variants
TH_MPP_ENTRY(affine_q4_mpp_ps, false, 8, true, true, false)
TH_MPP_ENTRY(affine_q4_mpp_sg4_ps, false, 4, true, true, false)
TH_MPP_ENTRY(affine_q4_mpp_gate_up_ps, true, 8, true, true, false)
TH_MPP_ENTRY(affine_q4_mpp_gate_up_es, true, 8, false, false, true)
TH_MPP_ENTRY(affine_q4_mpp_gate_up_ps_es, true, 8, false, true, true)
TH_MPP_ENTRY(affine_q4_mpp_gate_up_sg4_ps, true, 4, true, true, false)
TH_MPP_ENTRY(affine_q4_mpp_gate_up_sg4_ps_es, true, 4, false, true, true)

// Splash decode_linear_q4_n256_paired_sg4 (decode/linear_q4.metal:87):
// q4_mpp_tile<256, false, false, 256, Pipelined=true, 4> with the
// unguarded epilogue, persistent groups striding 8 x 256 tiles. 128
// threads — four resident groups per core reach the occupancy knee on
// very wide one-lane projections (lm_head) with half the input re-reads
// of N128. Host side requires out_dim % 256 == 0 (see AffineQmpp).
#define TH_PAIRED_ENTRY(Name, PreSums)                                        \
kernel void Name(                                                             \
    device const bfloat* input  [[buffer(0)]],                                \
    device const uchar*  weights [[buffer(1)]],                               \
    device const bfloat* sb      [[buffer(2)]],                               \
    device bfloat*       output  [[buffer(3)]],                               \
    constant MppParams&  p       [[buffer(4)]],                               \
    threadgroup float* staged    [[threadgroup(0)]],                          \
    uint group      [[threadgroup_position_in_grid]],                         \
    uint simd_lane  [[thread_index_in_simdgroup]],                            \
    uint simd_group [[simdgroup_index_in_threadgroup]]) {                     \
  threadgroup float input_sums[PreSums ? 1 : 64];                             \
  const uint tiles = uint(p.out_dim) / 256u;                                  \
  device bfloat* inp = const_cast<device bfloat*>(input);                     \
  if (PreSums) {                                                              \
    device const float* ps =                                                  \
        (device const float*)(input + 8 * uint(p.in_dim));                   \
    const uint n = 8u * (uint(p.in_dim) / 64u);                               \
    for (uint i = simd_group * 32 + simd_lane; i < n; i += 4 * 32)            \
      staged[i] = ps[i];                                                      \
    threadgroup_barrier(mem_flags::mem_threadgroup);                          \
  }                                                                           \
  device uchar* w = const_cast<device uchar*>(weights);                       \
  device bfloat* scales = const_cast<device bfloat*>(sb);                     \
  device bfloat* biases = const_cast<device bfloat*>(sb) + p.bias_base;       \
  for (uint tile = group; tile < tiles; tile += uint(p.groups)) {             \
    th_mpp_tile<false, 4, false, PreSums, false>(inp, w, scales, biases,      \
        output, w, scales, biases, p.out_dim, p.in_dim, p.m, input_sums,      \
        staged,                                                               \
        nullptr, nullptr, tile * 256, simd_lane, simd_group);                 \
  }                                                                           \
}

TH_PAIRED_ENTRY(affine_q4_mpp_paired_sg4, false)
TH_PAIRED_ENTRY(affine_q4_mpp_paired_sg4_ps, true)

// K45: attach a presum block to an activation that did not come from a
// sums-emitting producer — x [m][in] -> [8][in] (rows >= m zero) followed
// by f32 sums[in/64][8] in q4_store_input_sums' lane pattern. Replaces the
// pad copy (same one dispatch). Threadgroup t covers quant groups
// 4t..4t+3 for all 8 rows (simdgroup r = row r).
kernel void affine_q4_attach_sums(device const bfloat* x [[buffer(0)]],
                                  device bfloat* out     [[buffer(1)]],
                                  constant int2& dims    [[buffer(2)]],
                                  uint tg   [[threadgroup_position_in_grid]],
                                  uint lane [[thread_index_in_simdgroup]],
                                  uint row  [[simdgroup_index_in_threadgroup]]) {
  const uint m = uint(dims.x), in_dim = uint(dims.y), ng = in_dim / 64;
  device bfloat* o = out + row * in_dim;
  device float* sums = (device float*)(out + 8 * in_dim);
  device const bfloat* xr = x + row * in_dim;
  for (uint g = tg * 4; g < min(ng, tg * 4 + 4); ++g) {
    const uint c = g * 64 + lane;
    const bfloat a = row < m ? xr[c] : bfloat(0.0f);
    const bfloat b = row < m ? xr[c + 32] : bfloat(0.0f);
    o[c] = a;
    o[c + 32] = b;
    const float s = simd_sum(float(a) + float(b));
    if (lane == 0) sums[g * 8 + row] = s;
  }
}
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
                            let mut names: Vec<&str> =
                                ALL_MPP_KERNELS.iter().map(|k| k.name()).collect();
                            names.extend([
                                "affine_q4_mpp_pf_sums",
                                "affine_q4_mpp_prefill",
                                "affine_q4_mpp_prefill_up",
                            ]);
                            for f in names {
                                match lib.get_function(f, None) {
                                    Ok(func) => match raw
                                        .new_compute_pipeline_state_with_function(&func)
                                    {
                                        Ok(_) => eprintln!("  fn {f} ok (pipeline)"),
                                        Err(e) => eprintln!("  fn {f} PIPELINE ERR {e}"),
                                    },
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
            static V2: OnceLock<bool> = OnceLock::new();
            let v2 = *V2.get_or_init(|| std::env::var("TH_QMV_V2").is_ok());
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

    // ------------------------------------------------------------------
    // K7: m = 1 decode matvec on the tiled `[tile][group][col][8 words]`
    // layout. The MPP tiles pad one live row to an 8-row block (a pad
    // dispatch + 8x the MMA work) and the row-streaming qmv kernels read
    // the tiled layout as 32 B chunks strided by 8 KB. Here the 32 lanes
    // of a simdgroup are 8 consecutive rows x 4 K-quarters, so every
    // weight load is one contiguous 256 B span of a (tile, group) block;
    // each lane re-uses its 16 activations over RPL row groups, and the
    // simdgroups of a threadgroup split K and reduce through threadgroup
    // memory (fixed order: bitwise deterministic).
    //
    // Nibble e of a word is kept in place (`w & 0xF << 4e` = v * 16^e,
    // exact in f32) and its activation is pre-scaled by 16^-e (exact), so
    // every product is the correctly-rounded x*v with one AND + one
    // convert + one FMA per weight — no shifts.
    //
    // GateUp: the weight holds [gate | up] row blocks (`up_row` = the up
    // stream's first row); the epilogue is the MPP gate/up form
    // (bf16-rounded gate and up, then silu(gate)*up in f32).
    // ------------------------------------------------------------------
    const QMVT_SRC: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct QmvtParams {
    uint in_dim;   // K
    uint out_dim;  // logical output rows (per stream for gate_up)
    uint ng;       // K / 64
    uint tiles;    // 256-row tiles of the whole buffer (bias plane offset)
    uint up_row;   // gate_up: first row of the up stream; 0 = plain
    uint slice;    // quant groups per simdgroup K-slice
};

template <uint RPL, uint NSG, bool GateUp>
inline __attribute__((always_inline)) void qmvt(device const uint*   wq,
                     device const bfloat* sb,
                     device const bfloat* x,
                     device bfloat*       y,
                     constant QmvtParams& p,
                     threadgroup float*   red,
                     uint tg, uint lane, uint sg)
{
    constexpr uint NS = GateUp ? 2 : 1;
    constexpr uint ROWS = 8 * RPL;
    const uint ng = p.ng;
    const uint r = lane >> 2, c = lane & 3u;
    const uint bias_plane = p.tiles * ng * 256u;
    const uint g0 = min(ng, sg * p.slice);
    const uint g1 = min(ng, g0 + p.slice);

    uint wb[RPL][NS];   // word offset of (row, group 0, this K-quarter)
    uint sbi[RPL][NS];  // scale index of (row, group 0)
    bool live[RPL];
#pragma unroll
    for (uint i = 0; i < RPL; ++i) {
        const uint row = tg * ROWS + 8u * i + r;
        live[i] = row < p.out_dim;
#pragma unroll
        for (uint s = 0; s < NS; ++s) {
            const uint rr = row + s * p.up_row;
            const uint t = rr >> 8, col = rr & 255u;
            wb[i][s] = t * ng * 2048u + col * 8u + c * 2u;
            sbi[i][s] = t * ng * 256u + col;
        }
    }
    float acc[RPL][NS];
#pragma unroll
    for (uint i = 0; i < RPL; ++i)
#pragma unroll
        for (uint s = 0; s < NS; ++s) acc[i][s] = 0.0f;

    // 16^-e for nibble e (exact powers of two)
    const float k1 = 0.0625f, k2 = 0.00390625f, k3 = 0.000244140625f,
                k4 = 0.0000152587890625f, k5 = 9.5367431640625e-7f,
                k6 = 5.9604644775390625e-8f, k7 = 3.7252902984619140625e-9f;

    for (uint g = g0; g < g1; ++g) {
        // this lane's 16 activations: x[g*64 + c*16 .. +16]
        device const uint4* xp =
            reinterpret_cast<device const uint4*>(x + g * 64u + c * 16u);
        const uint4 xa = xp[0], xb = xp[1];
        const float a0 = as_type<float>(xa.x << 16), a1 = as_type<float>(xa.x & 0xFFFF0000u);
        const float a2 = as_type<float>(xa.y << 16), a3 = as_type<float>(xa.y & 0xFFFF0000u);
        const float a4 = as_type<float>(xa.z << 16), a5 = as_type<float>(xa.z & 0xFFFF0000u);
        const float a6 = as_type<float>(xa.w << 16), a7 = as_type<float>(xa.w & 0xFFFF0000u);
        const float b0 = as_type<float>(xb.x << 16), b1 = as_type<float>(xb.x & 0xFFFF0000u);
        const float b2 = as_type<float>(xb.y << 16), b3 = as_type<float>(xb.y & 0xFFFF0000u);
        const float b4 = as_type<float>(xb.z << 16), b5 = as_type<float>(xb.z & 0xFFFF0000u);
        const float b6 = as_type<float>(xb.w << 16), b7 = as_type<float>(xb.w & 0xFFFF0000u);
        // this lane's share of the group's input sum (bias term)
        const float xs = (((a0 + a1) + (a2 + a3)) + ((a4 + a5) + (a6 + a7)))
                       + (((b0 + b1) + (b2 + b3)) + ((b4 + b5) + (b6 + b7)));
        const float p1 = a1 * k1, p2 = a2 * k2, p3 = a3 * k3, p4 = a4 * k4,
                    p5 = a5 * k5, p6 = a6 * k6, p7 = a7 * k7;
        const float q1 = b1 * k1, q2 = b2 * k2, q3 = b3 * k3, q4 = b4 * k4,
                    q5 = b5 * k5, q6 = b6 * k6, q7 = b7 * k7;
#pragma unroll
        for (uint i = 0; i < RPL; ++i) {
#pragma unroll
            for (uint s = 0; s < NS; ++s) {
                const uint2 w = live[i]
                    ? *reinterpret_cast<device const uint2*>(wq + wb[i][s] + g * 2048u)
                    : uint2(0);
                float d0 = a0 * float(w.x & 0xFu);
                float d1 = b0 * float(w.y & 0xFu);
                d0 = fma(p1, float(w.x & 0xF0u), d0);
                d1 = fma(q1, float(w.y & 0xF0u), d1);
                d0 = fma(p2, float(w.x & 0xF00u), d0);
                d1 = fma(q2, float(w.y & 0xF00u), d1);
                d0 = fma(p3, float(w.x & 0xF000u), d0);
                d1 = fma(q3, float(w.y & 0xF000u), d1);
                d0 = fma(p4, float(w.x & 0xF0000u), d0);
                d1 = fma(q4, float(w.y & 0xF0000u), d1);
                d0 = fma(p5, float(w.x & 0xF00000u), d0);
                d1 = fma(q5, float(w.y & 0xF00000u), d1);
                d0 = fma(p6, float(w.x & 0xF000000u), d0);
                d1 = fma(q6, float(w.y & 0xF000000u), d1);
                d0 = fma(p7, float(w.x & 0xF0000000u), d0);
                d1 = fma(q7, float(w.y & 0xF0000000u), d1);
                if (live[i]) {
                    const uint si = sbi[i][s] + g * 256u;
                    acc[i][s] = fma(d0 + d1, float(sb[si]), acc[i][s]);
                    acc[i][s] = fma(xs, float(sb[bias_plane + si]), acc[i][s]);
                }
            }
        }
    }
    // reduce the 4 K-quarter lanes of each row, then the NSG K-slices
#pragma unroll
    for (uint i = 0; i < RPL; ++i)
#pragma unroll
        for (uint s = 0; s < NS; ++s) {
            acc[i][s] += simd_shuffle_xor(acc[i][s], 1);
            acc[i][s] += simd_shuffle_xor(acc[i][s], 2);
        }
    if (c == 0) {
#pragma unroll
        for (uint i = 0; i < RPL; ++i)
#pragma unroll
            for (uint s = 0; s < NS; ++s)
                red[(sg * NS + s) * ROWS + 8u * i + r] = acc[i][s];
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (sg != 0) return;
    for (uint ri = lane; ri < ROWS; ri += 32u) {
        const uint row = tg * ROWS + ri;
        if (row >= p.out_dim) continue;
        float tot[NS];
#pragma unroll
        for (uint s = 0; s < NS; ++s) {
            tot[s] = 0.0f;
            for (uint k = 0; k < NSG; ++k) tot[s] += red[(k * NS + s) * ROWS + ri];
        }
        float value;
        if (GateUp) {
            const float gate = float(bfloat(tot[0]));
            const float up = float(bfloat(tot[NS - 1]));
            value = gate / (1.0f + fast::exp2(-1.44269504089f * gate)) * up;
        } else {
            value = tot[0];
        }
        y[row] = bfloat(value);
    }
}

#define TH_QMVT_ENTRY(Name, RPL, NSG, GateUp)                          \
kernel void Name(device const uint*   wq [[buffer(0)]],                \
                 device const bfloat* sb [[buffer(1)]],                \
                 device const bfloat* x  [[buffer(2)]],                \
                 device bfloat*       y  [[buffer(3)]],                \
                 constant QmvtParams& p  [[buffer(4)]],                \
                 uint tg   [[threadgroup_position_in_grid]],           \
                 uint lane [[thread_index_in_simdgroup]],              \
                 uint sg   [[simdgroup_index_in_threadgroup]]) {       \
    threadgroup float red[NSG * (GateUp ? 2 : 1) * 8 * RPL];            \
    qmvt<RPL, NSG, GateUp>(wq, sb, x, y, p, red, tg, lane, sg);        \
}

// every (rpl, sgs) in `QMVT_KERNELS`, plain and gate/up
TH_QMVT_ENTRY(affine_qmvt_r1s8,    1, 8, false)
TH_QMVT_ENTRY(affine_qmvt_r2s4,    2, 4, false)
TH_QMVT_ENTRY(affine_qmvt_r2s8,    2, 8, false)
TH_QMVT_ENTRY(affine_qmvt_r4s4,    4, 4, false)
TH_QMVT_ENTRY(affine_qmvt_r4s8,    4, 8, false)
TH_QMVT_ENTRY(affine_qmvt_r8s8,    8, 8, false)
TH_QMVT_ENTRY(affine_qmvt_gu_r1s8, 1, 8, true)
TH_QMVT_ENTRY(affine_qmvt_gu_r2s4, 2, 4, true)
TH_QMVT_ENTRY(affine_qmvt_gu_r2s8, 2, 8, true)
TH_QMVT_ENTRY(affine_qmvt_gu_r4s4, 4, 4, true)
TH_QMVT_ENTRY(affine_qmvt_gu_r4s8, 4, 8, true)
TH_QMVT_ENTRY(affine_qmvt_gu_r8s8, 8, 8, true)
"#;

    /// m = 1 matvec on tiled weights (see `QMVT_SRC`) → `y[out]` bf16.
    /// `up_row > 0` is the fused [gate | up] form: rows `[0, out)` are
    /// gate, `[up_row, up_row + out)` up, and y = silu(gate)·up.
    pub struct AffineQmvT {
        pub inp: usize,
        /// logical output rows (per stream for gate_up)
        pub out: usize,
        /// 256-row tiles of the whole weight buffer (bias plane offset)
        pub tiles: usize,
        pub up_row: usize,
        pub cfg: QmvtCfg,
    }

    #[repr(C)]
    struct QmvtParams {
        in_dim: u32,
        out_dim: u32,
        ng: u32,
        tiles: u32,
        up_row: u32,
        slice: u32,
    }

    const NQ: usize = super::QMVT_KERNELS.len();
    // [plain configs.., gate/up configs..] in `QMVT_KERNELS` order
    static QMVT_PIPES: [OnceLock<ComputePipeline>; 2 * NQ] =
        [const { OnceLock::new() }; 2 * NQ];

    fn qmvt_name(cfg: QmvtCfg, gu: bool) -> String {
        format!("affine_qmvt{}_r{}s{}", if gu { "_gu" } else { "" }, cfg.rpl, cfg.sgs)
    }

    impl AffineQmvT {
        /// `(pipeline slot, kernel name)` for this config — `None` when
        /// the combination is not instantiated in `QMVT_SRC`.
        fn kernel(&self) -> Option<(usize, String)> {
            let gu = self.up_row > 0;
            let i = super::QMVT_KERNELS.iter().position(|c| *c == self.cfg)?;
            Some((i + if gu { NQ } else { 0 }, qmvt_name(self.cfg, gu)))
        }
    }

    /// Build every `affine_qmvt*` pipeline from ONE compile of `QMVT_SRC`
    /// — at model load, instead of one full-library compile per config
    /// lazily inside the first m = 1 projections (the first plain-decode
    /// token paid three). No-op under `TH_M1_PATH=mpp`. Returns the number
    /// of pipelines built.
    pub fn qmvt_warm(device: &candle_core::MetalDevice) -> Result<usize> {
        if super::m1_path() == super::M1Path::Mpp {
            return Ok(0);
        }
        if QMVT_PIPES.iter().all(|c| c.get().is_some()) {
            return Ok(0);
        }
        let raw = device.metal_device();
        let lib = raw
            .new_library_with_source(QMVT_SRC, None)
            .map_err(candle_core::Error::wrap)?;
        let mut n = 0;
        for gu in [false, true] {
            for (i, cfg) in super::QMVT_KERNELS.iter().enumerate() {
                let cell = &QMVT_PIPES[i + if gu { NQ } else { 0 }];
                if cell.get().is_some() {
                    continue;
                }
                let f = lib
                    .get_function(&qmvt_name(*cfg, gu), None)
                    .map_err(candle_core::Error::wrap)?;
                let p = raw
                    .new_compute_pipeline_state_with_function(&f)
                    .map_err(candle_core::Error::wrap)?;
                if cell.set(p).is_ok() {
                    n += 1;
                }
            }
        }
        Ok(n)
    }

    impl CustomOp3 for AffineQmvT {
        fn name(&self) -> &'static str {
            "affine-qmvt"
        }
        fn cpu_fwd(
            &self,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
            _: &CpuStorage, _: &Layout,
        ) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("affine-qmvt: Metal only")
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
            if self.inp % 64 != 0 || l_x.shape().elem_count() != self.inp {
                candle_core::bail!(
                    "affine-qmvt: x {:?} vs in {} (want one %64 row)",
                    l_x.shape(),
                    self.inp
                );
            }
            // activations are read as uint4 (16 B) vectors
            if l_x.start_offset() % 8 != 0 {
                candle_core::bail!("affine-qmvt: x offset {} not 16B aligned", l_x.start_offset());
            }
            let rows = self.out + self.up_row;
            if rows > self.tiles * 256 || (self.up_row > 0 && self.up_row < self.out) {
                candle_core::bail!(
                    "affine-qmvt: rows {}+{} exceed {} tiles",
                    self.out,
                    self.up_row,
                    self.tiles
                );
            }
            let Some((slot, fname)) = self.kernel() else {
                candle_core::bail!("affine-qmvt: no kernel for {:?} gate_up={}", self.cfg, self.up_row > 0);
            };
            let device = s_wq.device();
            let cell = &QMVT_PIPES[slot];
            if cell.get().is_none() {
                compile(cell, QMVT_SRC, 64, &fname, device)?;
            }
            let pipeline = cell.get().unwrap();

            let ng = self.inp / 64;
            let params = QmvtParams {
                in_dim: self.inp as u32,
                out_dim: self.out as u32,
                ng: ng as u32,
                tiles: self.tiles as u32,
                up_row: self.up_row as u32,
                slice: ng.div_ceil(self.cfg.sgs) as u32,
            };
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(self.out, DType::BF16)
                .with_label("qmvt.y")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("affine_qmvt");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipeline);
            enc.set_input_buffer(0, Some(s_wq.buffer()), l_wq.start_offset() * 4);
            enc.set_input_buffer(1, Some(s_sb.buffer()), l_sb.start_offset() * 2);
            enc.set_input_buffer(2, Some(s_x.buffer()), l_x.start_offset() * 2);
            enc.set_output_buffer(3, Some(&y_buf), 0);
            enc.set_bytes(4, &params);
            enc.dispatch_thread_groups(
                MTLSize {
                    width: self.out.div_ceil(8 * self.cfg.rpl),
                    height: 1,
                    depth: 1,
                },
                MTLSize { width: 32 * self.cfg.sgs, height: 1, depth: 1 },
            );
            // fresh pooled buffer — never a clone of an input's buffer
            let storage =
                MetalStorage::new(y_buf, device.clone(), self.out, DType::BF16);
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
        let cores = super::gpu_cores();
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
        /// K45: `x` is a presum block (see [`super::presum_block_bytes`]):
        /// its buffer holds the zero-padded [8, in] activation at x's
        /// offset followed by the f32 input sums, so the op binds it
        /// directly (no pad copy at any m) and the kernel reads the sums
        /// instead of recomputing them per threadgroup.
        pub presum: bool,
        /// K45 (N256 gate_up only): write the output as a presum block —
        /// all 8 rows stored, then the down projection's input sums.
        pub emit_sums: bool,
        /// Persistent-group count override (0 = the tile policy) — used
        /// by the `TH_BENCH_Q4` autotune sweep.
        pub groups: usize,
        /// Bench variant bits (`QMPP_*`): `QMPP_BIND_ONLY` = a presum input
        /// is bound directly but the sums are recomputed in-kernel.
        pub flags: u32,
    }

    /// presum input bound directly, sums still recomputed in-kernel
    pub const QMPP_BIND_ONLY: u32 = 4;

    /// Every MPP decode entry point, indexing `MPP_PIPES` (one compiled
    /// pipeline each, built on first use from the once-compiled library).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum MppKernel {
        Pad,
        N256,
        N256Sg4,
        GateUp,
        GateUpSg4,
        N32s4,
        N64s4,
        N32s4GateUp,
        Paired256,
        N256Ps,
        N256Sg4Ps,
        GateUpPs,
        GateUpEs,
        GateUpPsEs,
        GateUpSg4Ps,
        GateUpSg4PsEs,
        N32s4Ps,
        N64s4Ps,
        Paired256Ps,
        AttachSums,
    }

    const MPP_KERNELS: usize = 20;
    const ALL_MPP_KERNELS: [MppKernel; MPP_KERNELS] = [
        MppKernel::Pad,
        MppKernel::N256,
        MppKernel::N256Sg4,
        MppKernel::GateUp,
        MppKernel::GateUpSg4,
        MppKernel::N32s4,
        MppKernel::N64s4,
        MppKernel::N32s4GateUp,
        MppKernel::Paired256,
        MppKernel::N256Ps,
        MppKernel::N256Sg4Ps,
        MppKernel::GateUpPs,
        MppKernel::GateUpEs,
        MppKernel::GateUpPsEs,
        MppKernel::GateUpSg4Ps,
        MppKernel::GateUpSg4PsEs,
        MppKernel::N32s4Ps,
        MppKernel::N64s4Ps,
        MppKernel::Paired256Ps,
        MppKernel::AttachSums,
    ];

    impl MppKernel {
        /// A PreSums entry point: stages the presum block's input sums in
        /// threadgroup memory instead of recomputing them.
        fn pre_sums(self) -> bool {
            use MppKernel as K;
            matches!(
                self,
                K::N256Ps
                    | K::N256Sg4Ps
                    | K::GateUpPs
                    | K::GateUpPsEs
                    | K::GateUpSg4Ps
                    | K::GateUpSg4PsEs
                    | K::N32s4Ps
                    | K::N64s4Ps
                    | K::Paired256Ps
            )
        }

        fn name(self) -> &'static str {
            match self {
                MppKernel::Pad => "affine_q4_mpp_pad",
                MppKernel::N256 => "affine_q4_mpp",
                MppKernel::N256Sg4 => "affine_q4_mpp_sg4",
                MppKernel::GateUp => "affine_q4_mpp_gate_up",
                MppKernel::GateUpSg4 => "affine_q4_mpp_gate_up_sg4",
                MppKernel::N32s4 => "affine_q4_mpp_n32s4",
                MppKernel::N64s4 => "affine_q4_mpp_n64s4",
                MppKernel::N32s4GateUp => "affine_q4_mpp_n32s4_gate_up",
                MppKernel::Paired256 => "affine_q4_mpp_paired_sg4",
                MppKernel::N256Ps => "affine_q4_mpp_ps",
                MppKernel::N256Sg4Ps => "affine_q4_mpp_sg4_ps",
                MppKernel::GateUpPs => "affine_q4_mpp_gate_up_ps",
                MppKernel::GateUpEs => "affine_q4_mpp_gate_up_es",
                MppKernel::GateUpPsEs => "affine_q4_mpp_gate_up_ps_es",
                MppKernel::GateUpSg4Ps => "affine_q4_mpp_gate_up_sg4_ps",
                MppKernel::GateUpSg4PsEs => "affine_q4_mpp_gate_up_sg4_ps_es",
                MppKernel::N32s4Ps => "affine_q4_mpp_n32s4_ps",
                MppKernel::N64s4Ps => "affine_q4_mpp_n64s4_ps",
                MppKernel::Paired256Ps => "affine_q4_mpp_paired_sg4_ps",
                MppKernel::AttachSums => "affine_q4_attach_sums",
            }
        }
    }

    static MPP_LIB: OnceLock<candle_metal_kernels::metal::Library> = OnceLock::new();
    static MPP_PIPES: [OnceLock<ComputePipeline>; MPP_KERNELS] =
        [const { OnceLock::new() }; MPP_KERNELS];

    /// MPP_SRC compiled once per process (Metal 4); every entry point
    /// comes out of this one library.
    fn mpp_library(
        device: &candle_core::MetalDevice,
    ) -> Result<&'static candle_metal_kernels::metal::Library> {
        if let Some(lib) = MPP_LIB.get() {
            return Ok(lib);
        }
        let opts = objc2_metal::MTLCompileOptions::new();
        opts.setLanguageVersion(objc2_metal::MTLLanguageVersion::Version4_0);
        let lib = device
            .metal_device()
            .new_library_with_source(MPP_SRC, Some(&opts))
            .map_err(candle_core::Error::wrap)?;
        let _ = MPP_LIB.set(lib);
        Ok(MPP_LIB.get().unwrap())
    }

    fn mpp_pipe(
        k: MppKernel,
        device: &candle_core::MetalDevice,
    ) -> Result<&'static ComputePipeline> {
        let cell = &MPP_PIPES[k as usize];
        if let Some(p) = cell.get() {
            return Ok(p);
        }
        let f = mpp_library(device)?
            .get_function(k.name(), None)
            .map_err(candle_core::Error::wrap)?;
        let p = device
            .metal_device()
            .new_compute_pipeline_state_with_function(&f)
            .map_err(candle_core::Error::wrap)?;
        let _ = cell.set(p);
        Ok(cell.get().unwrap())
    }

    /// K45: copy `x` [m <= 8, in] into a fresh presum block (8 zero-padded
    /// rows + input sums) — for activations whose producer does not emit
    /// one. Returns the [8, in] view of the block (narrow to m rows and
    /// pass `presum: true`). One dispatch; the sums are bit-identical to
    /// what the decode tiles would recompute.
    pub struct Q4AttachSums {
        pub m: usize,
        pub inp: usize,
    }

    impl candle_core::CustomOp1 for Q4AttachSums {
        fn name(&self) -> &'static str {
            "q4-attach-sums"
        }
        fn cpu_fwd(&self, _: &CpuStorage, _: &Layout) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("q4-attach-sums: Metal only")
        }
        fn metal_fwd(&self, s_x: &MetalStorage, l_x: &Layout) -> Result<(MetalStorage, Shape)> {
            check3(s_x, l_x, DType::BF16, "x")?;
            if self.m == 0 || self.m > 8 || self.inp % 64 != 0 {
                candle_core::bail!("q4-attach-sums: m {} in {}", self.m, self.inp);
            }
            if l_x.shape().elem_count() != self.m * self.inp {
                candle_core::bail!("q4-attach-sums: x {:?} != [{}, {}]", l_x.shape(), self.m, self.inp);
            }
            let device = s_x.device();
            let pipe = mpp_pipe(MppKernel::AttachSums, device)?;
            let elems = super::presum_block_bytes(self.inp) / 2;
            let buf = device
                .new_buffer_builder()
                .with_size_for(elems, DType::BF16)
                .with_label("q4.presum")
                .build()
                .map_err(candle_core::Error::wrap)?;
            let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("q4_attach_sums");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipe);
            enc.set_input_buffer(0, Some(s_x.buffer()), l_x.start_offset() * 2);
            enc.set_output_buffer(1, Some(&buf), 0);
            let dims: [i32; 2] = [self.m as i32, self.inp as i32];
            enc.set_bytes(2, &dims);
            enc.dispatch_thread_groups(
                MTLSize { width: (self.inp / 64).div_ceil(4), height: 1, depth: 1 },
                MTLSize { width: 256, height: 1, depth: 1 },
            );
            let out = MetalStorage::new(buf, device.clone(), 8 * self.inp, DType::BF16);
            Ok((out, (8, self.inp).into()))
        }
    }

    /// An uninitialized pooled bf16 buffer of `elems` elements viewed as
    /// [rows, cols] (rows * cols <= elems) — no dispatch, no zero-fill
    /// blit. For outputs a kernel fully overwrites (and K45 presum blocks,
    /// `elems = presum_block_bytes(cols) / 2`). The input tensor only
    /// names the device.
    pub struct AllocBf16 {
        pub elems: usize,
        pub rows: usize,
        pub cols: usize,
    }

    impl candle_core::CustomOp1 for AllocBf16 {
        fn name(&self) -> &'static str {
            "alloc-bf16"
        }
        fn cpu_fwd(&self, _: &CpuStorage, _: &Layout) -> Result<(CpuStorage, Shape)> {
            candle_core::bail!("alloc-bf16: Metal only")
        }
        fn metal_fwd(&self, s: &MetalStorage, _: &Layout) -> Result<(MetalStorage, Shape)> {
            if self.rows * self.cols > self.elems {
                candle_core::bail!("alloc-bf16: [{}, {}] > {}", self.rows, self.cols, self.elems);
            }
            let device = s.device();
            let buf = device
                .new_buffer_builder()
                .with_size_for(self.elems, DType::BF16)
                .with_label("alloc.bf16")
                .build()
                .map_err(candle_core::Error::wrap)?;
            let out = MetalStorage::new(buf, device.clone(), self.rows * self.cols, DType::BF16);
            Ok((out, (self.rows, self.cols).into()))
        }
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

    fn compile_mpp(
        cell: &OnceLock<ComputePipeline>,
        fname: &str,
        device: &candle_core::MetalDevice,
    ) -> Result<()> {
        if cell.get().is_some() {
            return Ok(());
        }
        let raw = device.metal_device();
        let f = mpp_library(device)?
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
    pub(super) fn mpp_groups(tiles: usize, cores: usize) -> usize {
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

    /// Worst-core tile count when `groups` threadgroups are placed
    /// round-robin on `cores` (group g on core g % cores) and group g
    /// streams tiles `g, g+groups, ...` (Splash `maxCoreTiles`).
    /// K2 fix: a core hosts groups `core, core+cores, ...` — the port had
    /// `g += groups`, which counted one group per core, never matched the
    /// balanced load and so sent every 3x..8x-cores grid to the full grid.
    pub(super) fn max_core_tiles(tiles: usize, groups: usize, cores: usize) -> usize {
        (0..cores)
            .map(|core| {
                let mut load = 0;
                let mut g = core;
                while g < groups && g < tiles {
                    load += (tiles - g).div_ceil(groups);
                    g += cores;
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
            let split = self.tile == 32 || self.tile == 64;
            // K45: a presum block is a valid zero-padded [8, in] operand for
            // every kernel; the families with a PreSums variant also skip
            // the in-kernel sums (split gate_up — legacy only — has none)
            // a presum input is always bound directly (no pad copy); the
            // PreSums kernel (staged sums, no in-kernel recompute) only
            // where it measured faster in situ (`super::ps_family_on`)
            let family = if split && self.inp > 8192 {
                "split_long"
            } else if split {
                "split"
            } else if gate_up {
                "gu"
            } else if self.sgs == 4 && self.out % 256 == 0 {
                "paired"
            } else {
                "n256"
            };
            let ps = self.presum
                && self.flags & QMPP_BIND_ONLY == 0
                && super::ps_family_on(family);
            use MppKernel as K;
            let (kern, tgthr) = if split && gate_up {
                (K::N32s4GateUp, 128usize)
            } else if split && self.tile == 32 {
                (if ps { K::N32s4Ps } else { K::N32s4 }, 128)
            } else if split {
                (if ps { K::N64s4Ps } else { K::N64s4 }, 256)
            } else if gate_up {
                match (self.sgs == 4, ps, self.emit_sums) {
                    (false, false, false) => (K::GateUp, 256),
                    (false, true, false) => (K::GateUpPs, 256),
                    (false, false, true) => (K::GateUpEs, 256),
                    (false, true, true) => (K::GateUpPsEs, 256),
                    (true, false, false) => (K::GateUpSg4, 128),
                    (true, true, false) => (K::GateUpSg4Ps, 128),
                    (true, true, true) => (K::GateUpSg4PsEs, 128),
                    (true, false, true) => candle_core::bail!(
                        "affine-qmpp: emit_sums on gate_up sg4 needs presum"
                    ),
                }
            } else if self.sgs == 4 && self.out % 256 == 0 {
                // K2: Splash n256_paired_sg4 verbatim (unguarded epilogue:
                // no padded columns, and the output holds all 8 rows)
                (if ps { K::Paired256Ps } else { K::Paired256 }, 128)
            } else if self.sgs == 4 {
                (if ps { K::N256Sg4Ps } else { K::N256Sg4 }, 128)
            } else {
                (if ps { K::N256Ps } else { K::N256 }, 256)
            };
            if self.emit_sums && !(gate_up && !split && self.out % 256 == 0) {
                candle_core::bail!(
                    "affine-qmpp: emit_sums needs the N256 gate_up tile (out {} % 256)",
                    self.out
                );
            }
            let uses_ps = kern.pre_sums();
            if uses_ps && 8 * ng * 4 > 24 * 1024 {
                candle_core::bail!("affine-qmpp: presum staging for in {} exceeds threadgroup memory", self.inp);
            }
            let pipe = mpp_pipe(kern, device)?;

            let cores = super::gpu_cores();
            // split tiles fill the grid one-tile-per-tg; the plain 4-sg
            // N256 tile is Splash's Paired256 (one resident wave of
            // 4 x cores persistent groups); the other N256 tiles use the
            // round-robin persistent-group policy
            let groups = if self.groups > 0 {
                self.groups
            } else if split {
                self.out.div_ceil(self.tile)
            } else if !gate_up && self.sgs == 4 {
                tiles.min(super::PAIRED256_WAVE_GROUPS_PER_CORE * cores)
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

            // P0: at m == 8 the pad is a pure copy (x8[i] = x[i]) — bind
            // x itself when it is the whole [8, in] block at a 16-byte
            // aligned offset (MPP tensor loads). Bitwise identical; saves
            // a dispatch + a pooled x8 allocation per projection. Only a
            // read binding of the caller's buffer — no new storage.
            let x_off = l_x.start_offset() * 2;
            if self.presum {
                // the block must really be there: 8 rows + sums inside the
                // buffer, MPP-aligned, and x the live [m, in] view of it
                let need = x_off + super::presum_block_bytes(self.inp);
                if x_off % 16 != 0
                    || s_x.buffer().length() < need
                    || l_x.shape().elem_count() != self.m * self.inp
                {
                    candle_core::bail!(
                        "affine-qmpp: presum block missing (x_off {x_off}, buffer {} < {need}, x {:?}, m {})",
                        s_x.buffer().length(),
                        l_x.shape(),
                        self.m
                    );
                }
            }
            let direct = self.presum
                || (self.m == 8
                    && l_x.shape().elem_count() == 8 * self.inp
                    && x_off % 16 == 0
                    && self.inp <= super::PAD_SKIP_MAX_IN
                    && super::pad_skip_enabled());
            let x8_buf = if direct {
                None
            } else {
                Some(
                    device
                        .new_buffer_builder()
                        .with_size_for(8 * self.inp, DType::BF16)
                        .with_label("qmpp.x8")
                        .build()
                        .map_err(candle_core::Error::wrap)?,
                )
            };
            // an emitted presum block: 8 output rows, then out/64 x 8 f32
            let y_elems = if self.emit_sums {
                super::presum_block_bytes(self.out) / 2
            } else {
                8 * self.out
            };
            let y_buf = device
                .new_buffer_builder()
                .with_size_for(y_elems, DType::BF16)
                .with_label("qmpp.y")
                .build()
                .map_err(candle_core::Error::wrap)?;

            let encoder =
                device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("affine_qmpp");
            let enc_ref = &encoder;
            if let Some(x8) = x8_buf.as_ref() {
                let enc: &candle_metal_kernels::metal::ComputeCommandEncoder =
                    enc_ref.encoder().as_ref();
                enc.set_compute_pipeline_state(mpp_pipe(MppKernel::Pad, device)?);
                enc.set_input_buffer(0, Some(s_x.buffer()), x_off);
                enc.set_output_buffer(1, Some(x8), 0);
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
                enc.set_compute_pipeline_state(pipe);
                match x8_buf.as_ref() {
                    Some(x8) => enc.set_input_buffer(0, Some(x8), 0),
                    None => enc.set_input_buffer(0, Some(s_x.buffer()), x_off),
                }
                enc.set_input_buffer(1, Some(s_wq.buffer()), l_wq.start_offset() * 4);
                enc.set_input_buffer(2, Some(s_sb.buffer()), l_sb.start_offset() * 2);
                enc.set_output_buffer(3, Some(&y_buf), 0);
                enc.set_bytes(4, &params);
                // K45: presum sums staged in threadgroup memory once per
                // dispatch (f32 [in/64][8]); a 16-byte stub otherwise
                let staged = if uses_ps { (8 * ng * 4).div_ceil(16) * 16 } else { 16 };
                enc.set_threadgroup_memory_length(0, staged);
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

// E1 large-M tile ("+v"): pf_tile's math with a vectorized epilogue. The
// destination cooperative tensor gives every thread its Cap elements in runs
// of 4 consecutive columns on one row (i = 4j..4j+3 -> cols c_j..c_j+3, row
// r_j; `pf_vec_layout_ok` verifies this per shape before the host routes
// here). Per quant group a run needs one 8-byte scale load, one 8-byte bias
// load and one row sum, instead of a 64-bit parameter index plus two scalar
// loads per element. The per-element arithmetic is legacy
// th_mpp_prefill_tile's source form `acc += p*s + sum*b` (same contraction),
// so plain / up·silu outputs are bitwise equal to AffineQmppPrefill on the
// same sums (pf_prep's lane pattern == the legacy sums pass). Unsplit only.
// Emit (E1(c), up·silu only): `out` is a prefill presum block with whole
// 32-row tiles — rows >= live are stored as zero — and `osums` receives the
// tile's per-(row, quant group) sums in pf_prep's lane pattern over the
// stored bf16 values (the down projection's input sums, bit-identical to a
// pf_prep pass over the same activation).
template <ushort Rows, ushort TileN, ushort Sgs, ushort Mode, bool Staged,
          bool Emit>
inline void pf_vtile(device bfloat *input, device uchar *w0, device bfloat *s0,
                     device bfloat *b0, device const float *sums,
                     device bfloat *aux, device bfloat *out, uint out_size,
                     uint in_size, uint live, uint output_origin, uint lane,
                     uint sgi, threadgroup float *tsums, device float *osums) {
  constexpr ushort StorageN = 256;
  constexpr uint Batch = 256;
  constexpr ushort Cap = ushort(uint(Rows) * TileN / (uint(Sgs) * 32u));
  constexpr ushort Runs = Cap / 4;
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
  ushort colr[Runs];
  ushort rowr[Runs];
#pragma unroll
  for (ushort j = 0; j < Runs; ++j) {
    auto idx = acc.get_multidimensional_index(j * 4);
    colr[j] = ushort(idx[0]);
    rowr[j] = ushort(idx[1]);
  }
#pragma unroll
  for (ushort i = 0; i < Cap; ++i) acc[i] = 0.0f;
  device const bfloat *sp =
      s0 + ulong(tile) * total_groups * StorageN + tile_offset;
  device const bfloat *bp =
      b0 + ulong(tile) * total_groups * StorageN + tile_offset;
  if constexpr (Staged) {
    for (uint idx = sgi * 32 + lane; idx < min(Batch, total_groups) * Rows;
         idx += Sgs * 32)
      tsums[idx] = sums[idx];
    threadgroup_barrier(mem_flags::mem_threadgroup);
  }
  for (uint g = 0; g < total_groups; ++g) {
    auto a_slice = a.slice<64, Rows>(g * 64, 0);
    tensor<device uint4b_format, dextents<int, 2>, tensor_inline> bq(
        tw + ulong(g) * StorageN * 32, dextents<int, 2>{64, TileN},
        array<int, 2>{1, 64});
    auto bs = bq.slice<64, TileN>(0, 0);
    auto pr = operation.template get_destination_cooperative_tensor<
        decltype(a_slice), decltype(bs), float>();
    operation.run(a_slice, bs, pr);
#pragma unroll
    for (ushort j = 0; j < Runs; ++j) {
      const bfloat4 s4 = *(device const bfloat4 *)(sp + colr[j]);
      const bfloat4 b4 = *(device const bfloat4 *)(bp + colr[j]);
      float sum;
      if constexpr (Staged)
        sum = tsums[(g % Batch) * Rows + rowr[j]];
      else
        sum = sums[g * Rows + rowr[j]];
#pragma unroll
      for (ushort k = 0; k < 4; ++k)
        acc[j * 4 + k] += pr[j * 4 + k] * float(s4[k]) + sum * float(b4[k]);
    }
    sp += StorageN;
    bp += StorageN;
    if constexpr (Staged) {
      if (g % Batch == Batch - 1 && g + 1 < total_groups) {
        threadgroup_barrier(mem_flags::mem_threadgroup);
        for (uint idx = sgi * 32 + lane;
             idx < min(Batch, total_groups - g - 1) * Rows; idx += Sgs * 32)
          tsums[idx] = sums[(g + 1) * Rows + idx];
        threadgroup_barrier(mem_flags::mem_threadgroup);
      }
    }
  }
  auto conv = operation.template get_destination_cooperative_tensor<
      decltype(a0), decltype(b0s), bfloat>();
#pragma unroll
  for (ushort j = 0; j < Runs; ++j) {
#pragma unroll
    for (ushort k = 0; k < 4; ++k) {
      float value = float(bfloat(acc[j * 4 + k]));
      if constexpr (Mode == PfUpSilu) {
        const uint col = output_origin + colr[j] + k;
        const uint row = rowr[j];
        const bool ok = row < live && col < out_size;
        value = pf_silu_mul(
            ok ? float(aux[ulong(row) * out_size + col]) : 0.0f, value);
      }
      if constexpr (Emit) {
        if (rowr[j] >= live) value = 0.0f;
      }
      conv[j * 4 + k] = bfloat(value);
    }
  }
  if constexpr (Emit) {
    // whole 32-row tile (the block is padded); out_size % TileN == 0
    auto c = tensor(out, dextents<int, 2>{int(out_size), Rows},
                    array<int, 2>{1, int(out_size)});
    conv.store(c.slice<TileN, Rows>(output_origin, 0));
    threadgroup_barrier(mem_flags::mem_device);
    constexpr uint G = TileN / 64;
    for (uint task = sgi; task < uint(Rows) * G; task += Sgs) {
      const uint row = task / G, lg = task % G;
      const ulong o = ulong(row) * out_size + output_origin + lg * 64 + lane;
      const float s = simd_sum(float(out[o]) + float(out[o + 32]));
      if (lane == 0) osums[(output_origin / 64 + lg) * Rows + row] = s;
    }
    return;
  }
  if (live == Rows && output_origin + TileN <= out_size) {
    auto c = tensor(out, dextents<int, 2>{int(out_size), Rows},
                    array<int, 2>{1, int(out_size)});
    conv.store(c.slice<TileN, Rows>(output_origin, 0));
    return;
  }
#pragma unroll
  for (ushort j = 0; j < Runs; ++j) {
#pragma unroll
    for (ushort k = 0; k < 4; ++k) {
      const uint col = output_origin + colr[j] + k;
      const uint row = rowr[j];
      if (row < live && col < out_size)
        out[ulong(row) * out_size + col] = conv[j * 4 + k];
    }
  }
}

// Same buffer interface as PF_ENTRY (the host's tile pass binds both alike);
// with Emit, buffer 6 (`part`) is the output block's sums plane.
#define PF_VENTRY(Name, Rows, TileN, Sgs, Mode, Emit)                        \
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
  pf_vtile<Rows, TileN, Sgs, Mode, (Sgs) == 8, Emit>(                       \
      const_cast<device bfloat*>(input) + ulong(row0) * uint(p.in_dim),     \
      wb + p.w_off, sbb + p.s_off, sbb + p.bias_base + p.s_off,             \
      sums + ulong(tg.x) * ng * Rows, aux + ob, out + ob, uint(p.out_dim),  \
      uint(p.in_dim), live, tg.y * TileN, lane, sgi, tsums,                 \
      part + ulong(tg.x) * (uint(p.out_dim) / 64) * Rows);                  \
}

// Layout probe for `pf_vec_layout_ok`: out[1 + (tid*cap + i)*3 + {0,1,2}] =
// (valid, col, row) of destination element i of thread tid; out[0] = cap.
#define PF_VPROBE(Name, Rows, TileN, Sgs)                                    \
kernel void Name(device const bfloat* x [[buffer(0)]],                      \
                 device const uchar* w [[buffer(1)]],                       \
                 device int* out [[buffer(2)]],                             \
                 uint tid [[thread_index_in_threadgroup]]) {                \
  auto a = tensor(const_cast<device bfloat*>(x), dextents<int, 2>{64, Rows}, \
                  array<int, 2>{1, 64});                                    \
  tensor<device uint4b_format, dextents<int, 2>, tensor_inline> b(          \
      const_cast<device uchar*>(w), dextents<int, 2>{64, TileN},            \
      array<int, 2>{1, 64});                                                \
  constexpr auto d = matmul2d_descriptor(Rows, TileN, 64, false, true, false); \
  matmul2d<d, execution_simdgroups<Sgs>> op;                                \
  auto a0 = a.slice<64, Rows>(0, 0);                                        \
  auto b0 = b.slice<64, TileN>(0, 0);                                       \
  auto acc = op.template get_destination_cooperative_tensor<                \
      decltype(a0), decltype(b0), float>();                                 \
  const int cap = acc.get_capacity();                                       \
  if (tid == 0) out[0] = cap;                                               \
  for (int i = 0; i < cap; ++i) {                                           \
    auto idx = acc.get_multidimensional_index(i);                           \
    out[1 + (tid * cap + i) * 3 + 0] = acc.is_valid_element(i) ? 1 : 0;     \
    out[1 + (tid * cap + i) * 3 + 1] = idx[0];                              \
    out[1 + (tid * cap + i) * 3 + 2] = idx[1];                              \
  }                                                                         \
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
    /// E1 vectorized-epilogue tiles (`PF_VENTRY`): plain, up·silu(gate),
    /// up·silu(gate) emitting the down projection's prefill presum block
    const PF_VMODES: &[(&str, usize, bool)] = &[("vpl", 0, false), ("vus", 2, false), ("vuse", 2, true)];

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
        /// E1: vectorized-epilogue tile (`pf_vtile`, "+v"; unsplit,
        /// unfused) — bitwise equal to the legacy `AffineQmppPrefill`
        pub vec: bool,
    }

    impl PfCfg {
        pub const fn new(rows: usize, tile_n: usize, sgs: usize) -> Self {
            Self { rows, tile_n, sgs, splits: 1, fused: false, vec: false }
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
            if self.vec {
                s += "+v";
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
        for &(mode, id, emit) in PF_VMODES {
            let name = pf_name(r, n, sg, mode);
            src += &format!("PF_VENTRY({name}, {r}, {n}, {sg}, {id}, {emit})\n");
            names.push(name);
        }
        let name = pf_name(r, n, sg, "vprobe");
        src += &format!("PF_VPROBE({name}, {r}, {n}, {sg})\n");
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

    /// E1: per `PF_SHAPES` entry, whether its destination cooperative
    /// tensor has the layout `pf_vtile` assumes (`pf_vec_layout_check`).
    /// MPP's layout is implementation-defined — an OS update may change
    /// it — so it is probed once per process (`pf_warm`); a shape whose
    /// probe fails, or never ran, never routes to the vec tile.
    static PF_VLAYOUT: [OnceLock<bool>; PF_SHAPES.len()] =
        [const { OnceLock::new() }; PF_SHAPES.len()];

    fn pf_shape_idx(c: &PfCfg) -> Option<usize> {
        PF_SHAPES.iter().position(|&t| t == (c.rows, c.tile_n, c.sgs))
    }

    /// The layout the vec epilogue relies on, from `PF_VPROBE`'s dump
    /// (`dump[0]` = capacity, then (valid, col, row) per thread element):
    /// capacity * threads == rows * tile_n, elements 4j..4j+3 of every
    /// thread are 4 consecutive columns (4-aligned) on one row, all valid,
    /// and every tile element is owned exactly once.
    pub(crate) fn pf_vec_layout_check(dump: &[i32], threads: usize, rows: usize, tile_n: usize) -> bool {
        let cap = dump.first().copied().unwrap_or(0).max(0) as usize;
        if cap == 0 || cap % 4 != 0 || cap * threads != rows * tile_n || dump.len() < 1 + threads * cap * 3 {
            return false;
        }
        let mut seen = vec![false; rows * tile_n];
        for t in 0..threads {
            let e = |i: usize| {
                let b = 1 + (t * cap + i) * 3;
                (dump[b], dump[b + 1], dump[b + 2])
            };
            for j in 0..cap / 4 {
                let (_, c0, r0) = e(4 * j);
                if c0 < 0 || c0 % 4 != 0 {
                    return false;
                }
                for k in 0..4 {
                    let (v, c, r) = e(4 * j + k);
                    if v != 1 || c != c0 + k as i32 || r != r0 || r < 0 {
                        return false;
                    }
                    let (c, r) = (c as usize, r as usize);
                    if c >= tile_n || r >= rows || std::mem::replace(&mut seen[r * tile_n + c], true) {
                        return false;
                    }
                }
            }
        }
        seen.iter().all(|&x| x)
    }

    /// Run `PF_VPROBE` for `c`'s shape and check its layout.
    fn pf_vec_layout_probe(device: &candle_core::MetalDevice, c: &PfCfg) -> Result<bool> {
        let lib = pf_shape_lib(device, c)?;
        let name = pf_name(c.rows, c.tile_n, c.sgs, "vprobe");
        let pipe = lib
            .get(&name)
            .ok_or_else(|| candle_core::Error::Msg(format!("affine-qpf: no kernel {name}")))?;
        let threads = 32 * c.sgs;
        let n = 1 + threads * 256 * 3;
        let alloc = |bytes: usize| {
            device.new_buffer_builder().with_size(bytes).build().map_err(candle_core::Error::wrap)
        };
        let x = alloc(64 * c.rows * 2)?;
        let w = alloc(64 * c.tile_n / 2)?;
        let out = alloc(n * 4)?;
        {
            let encoder = device.command_encoder().map_err(candle_core::Error::wrap)?;
            encoder.set_label("pf_vprobe");
            let enc_ref = &encoder;
            let enc: &candle_metal_kernels::metal::ComputeCommandEncoder = enc_ref.encoder().as_ref();
            enc.set_compute_pipeline_state(pipe);
            enc.set_input_buffer(0, Some(&x), 0);
            enc.set_input_buffer(1, Some(&w), 0);
            enc.set_output_buffer(2, Some(&out), 0);
            enc.dispatch_thread_groups(
                MTLSize { width: 1, height: 1, depth: 1 },
                MTLSize { width: threads, height: 1, depth: 1 },
            );
        }
        device.wait_until_completed().map_err(candle_core::Error::wrap)?;
        // SAFETY: shared-storage buffer of `n` i32, the dispatch completed
        let dump = unsafe { std::slice::from_raw_parts(out.contents() as *const i32, n) };
        Ok(pf_vec_layout_check(dump, threads, c.rows, c.tile_n))
    }

    /// Probe (once) and report whether `c`'s shape may take the vec tile.
    pub fn pf_vec_layout_ok(device: &candle_core::MetalDevice, c: &PfCfg) -> bool {
        let Some(idx) = pf_shape_idx(c) else { return false };
        *PF_VLAYOUT[idx].get_or_init(|| match pf_vec_layout_probe(device, c) {
            Ok(true) => true,
            Ok(false) => {
                tracing::warn!(shape = %c.label(), "prefill vec tile: unexpected cooperative-tensor layout — legacy path");
                false
            }
            Err(e) => {
                tracing::warn!(shape = %c.label(), error = %e, "prefill vec tile: layout probe failed — legacy path");
                false
            }
        })
    }

    /// The (rows, tile_n, simdgroups) shapes `pf_policy` can return (unit
    /// test `pf_policy_only_returns_warmed_shapes` keeps them in sync).
    const PF_POLICY_SHAPES: [(usize, usize, usize); 2] = [(16, 128, 4), (32, 256, 8)];
    /// E1: the shapes `pf_policy_large` can return (warmed + probed at load).
    const PF_LARGE_SHAPES: [(usize, usize, usize); 1] = [(32, 128, 4)];

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
        let mut shapes: Vec<PfCfg> = match forced {
            Some(c) if c.exists() => vec![c],
            Some(_) => return Ok(0),
            None => PF_POLICY_SHAPES
                .iter()
                .map(|&(r, n, sg)| PfCfg::new(r, n, sg))
                .collect(),
        };
        let large = pf_large_env();
        if forced.is_none() && !large.0 {
            match large.1 {
                Some(c) if c.exists() => shapes.push(c),
                _ => shapes.extend(PF_LARGE_SHAPES.iter().map(|&(r, n, sg)| PfCfg::new(r, n, sg))),
            }
        }
        let mut n = pf_common(device)?.len();
        for c in &shapes {
            n += pf_shape_lib(device, c)?.len();
        }
        // E1: probe the vec tile's layout assumption for every warmed shape
        // (a forced "+v" config included) before a request can route there
        for c in &shapes {
            let ok = pf_vec_layout_ok(device, c);
            tracing::debug!(shape = %c.label(), ok, "prefill vec tile layout");
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
        /// E1(c): `x` is a prefill presum block (`pf_presum_elems`: rows
        /// padded to 32, then the pf-layout sums) — no pf_prep pass. Only
        /// honoured by 32-row configs (the block's sums layout).
        pub presum: bool,
        /// E1(c), gate/up with the vec tile: the output is itself a
        /// prefill presum block (the down projection's input sums emitted
        /// by the up·silu pass).
        pub emit: bool,
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
            if c.vec && (splits > 1 || c.fused) {
                candle_core::bail!("affine-qpf: the vec tile is unsplit and unfused ({c:?})");
            }
            if l_x.shape().elem_count() != self.m * self.inp {
                candle_core::bail!("affine-qpf: x {:?} != [{}, {}]", l_x.shape(), self.m, self.inp);
            }
            let device = s_wq.device();
            let x_off = l_x.start_offset() * 2;
            // E1(c): a prefill presum block carries its padded rows + sums
            let presum = self.presum
                && c.rows == 32
                && x_off % 16 == 0
                && s_x.buffer().length() >= x_off + super::pf_presum_elems(self.m, self.inp) * 2;
            let emit = self.emit && gate_up && c.vec && c.rows == 32 && self.out % c.tile_n == 0;
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
            } else if c.vec {
                "vpl"
            } else {
                "pl"
            };
            let p_prep = pipe("pf_prep")?;
            let p_tile = pipe(&pf_name(c.rows, c.tile_n, c.sgs, mode))?;
            let p_up = if gate_up && !c.fused {
                let up = if emit {
                    "vuse"
                } else if c.vec {
                    "vus"
                } else {
                    "us"
                };
                Some(pipe(&pf_name(c.rows, c.tile_n, c.sgs, up))?)
            } else {
                None
            };
            let p_red = if splits > 1 { Some(pipe("pf_reduce")?) } else { None };

            let row_tiles = self.m.div_ceil(c.rows);
            let m_pad = row_tiles * c.rows;
            // the tiles read whole Rows-row blocks: pad unless the live
            // rows fill them (and the base is 16-byte aligned)
            let copy = !presum && (m_pad != self.m || x_off % 16 != 0);
            let alloc = |n: usize, dt: DType, label: &'static str| {
                device
                    .new_buffer_builder()
                    .with_size_for(n, dt)
                    .with_label(label)
                    .build()
                    .map_err(candle_core::Error::wrap)
            };
            let x_pad = if copy { Some(alloc(m_pad * self.inp, DType::BF16, "qpf.x")?) } else { None };
            // presum: the sums are the block's plane (bound from s_x below)
            let sums = alloc(if presum { 1 } else { m_pad * ng }, DType::F32, "qpf.sums")?;
            let y = alloc(
                if emit { super::pf_presum_elems(self.m, self.out) } else { self.m * self.out },
                DType::BF16,
                "qpf.y",
            )?;
            let (sb_buf, sb_off) = if presum {
                (s_x.buffer(), x_off + m_pad * self.inp * 2)
            } else {
                (sums.as_ref(), 0usize)
            };
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
            // 1. pad + sums (not for a presum block: it carries both)
            if !presum {
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
            }
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
                             prm: &PfParams,
                             osums: bool| {
                enc.set_compute_pipeline_state(pipe);
                enc.set_input_buffer(0, Some(xb), xo);
                enc.set_input_buffer(1, Some(s_wq.buffer()), l_wq.start_offset() * 4);
                enc.set_input_buffer(2, Some(s_sb.buffer()), l_sb.start_offset() * 2);
                enc.set_input_buffer(3, Some(sb_buf), sb_off);
                // unused aux/part slots are bound read-only to `sums`
                enc.set_input_buffer(4, Some(aux.unwrap_or(&sums)), 0);
                if splits > 1 {
                    enc.set_input_buffer(5, Some(&sums), 0);
                    enc.set_output_buffer(6, Some(out), 0);
                } else if osums {
                    // E1(c) emit: the block's sums plane follows its padded rows
                    enc.set_output_buffer(5, Some(out), 0);
                    enc.set_output_buffer(6, Some(out), m_pad * self.out * 2);
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
                    tile_pass(p_tile, None, g, &params, false);
                    let up = PfParams {
                        w_off: params.up_woff,
                        s_off: params.up_soff,
                        ..params
                    };
                    tile_pass(p_up, Some(g), &y, &up, emit);
                }
                (_, _, Some(pt)) => {
                    tile_pass(p_tile, None, pt, &params, false);
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
                _ => tile_pass(p_tile, None, &y, &params, false),
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
        let valid = |c: PfCfg| {
            c.exists()
                && ng % c.splits == 0
                && !(gate_up && c.splits > 1)
                && (!c.vec || (c.splits == 1 && !c.fused && pf_vec_probed_ok(&c)))
        };
        if let Some(c) = forced {
            let c = PfCfg { fused: c.fused && gate_up, ..c };
            return valid(c).then_some(c);
        }
        if m > 128 {
            // E1: long-prompt chunks — the vec tile (bitwise equal to the
            // legacy AffineQmppPrefill) unless TH_PF_LARGE=0
            let (large_off, large_forced) = pf_large_env();
            if large_off || PF_LARGE_LEGACY.load(std::sync::atomic::Ordering::Relaxed) {
                return None;
            }
            let c = large_forced.or_else(|| pf_policy_large(m, out, inp, gate_up))?;
            let c = PfCfg { fused: c.fused && gate_up, ..c };
            return valid(c).then_some(c);
        }
        pf_policy(m, out, inp, gate_up, cores).filter(|&c| valid(c))
    }

    /// E1(c): whether an m-row prefill activation should be produced as a
    /// prefill presum block (`pf_presum_elems`) — the m > 128 route is the
    /// vec tile on 32-row tiles (probed), and TH_PF_PRESUM != 0 (read
    /// once). Producers: `AddRmsNorm { pfsums }` (in_all / in_qkv / gate_up
    /// inputs) and the gate/up up·silu pass (`AffineQpf { emit }`, the down
    /// input). Consumers bind the block's sums instead of a pf_prep pass.
    pub fn pf_presum_on(m: usize) -> bool {
        static ON: OnceLock<bool> = OnceLock::new();
        let on = *ON.get_or_init(|| std::env::var("TH_PF_PRESUM").as_deref() != Ok("0"));
        if !on || m <= 128 {
            return false;
        }
        let (off, forced, _) = pf_env();
        let (large_off, large_forced) = pf_large_env();
        if off || forced.is_some() || large_off || PF_LEGACY.load(std::sync::atomic::Ordering::Relaxed)
            || PF_LARGE_LEGACY.load(std::sync::atomic::Ordering::Relaxed)
        {
            return false;
        }
        let c = large_forced.unwrap_or(PfCfg { vec: true, ..PfCfg::new(32, 128, 4) });
        c.vec && c.rows == 32 && c.splits == 1 && !c.fused && pf_vec_probed_ok(&c)
    }

    /// The layout probe ran for `c`'s shape and passed (`pf_warm`).
    fn pf_vec_probed_ok(c: &PfCfg) -> bool {
        pf_shape_idx(c).and_then(|i| PF_VLAYOUT[i].get().copied()).unwrap_or(false)
    }

    /// E1 bench hook: force the legacy tile for m > 128 at runtime so
    /// TH_BENCH_PREFILL can interleave legacy and vec forwards in one
    /// process. Off by default; a relaxed load is its only per-call cost.
    static PF_LARGE_LEGACY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    pub fn pf_force_legacy_large(on: bool) {
        PF_LARGE_LEGACY.store(on, std::sync::atomic::Ordering::Relaxed);
    }

    /// (off, forced) from TH_PF_LARGE, read once: `0` keeps m > 128 on the
    /// legacy AffineQmppPrefill (the pre-E1 path); a config label (e.g.
    /// `r32n256s8+v`) forces that tile for m > 128 (A/B).
    fn pf_large_env() -> (bool, Option<PfCfg>) {
        static ENV: OnceLock<(bool, Option<PfCfg>)> = OnceLock::new();
        *ENV.get_or_init(|| {
            let v = std::env::var("TH_PF_LARGE").ok();
            let off = v.as_deref() == Some("0");
            let forced = if off { None } else { v.as_deref().and_then(pf_parse) };
            (off, forced)
        })
    }

    /// E1 policy for m > 128 (long-prompt chunks, the draft's prompt-row
    /// fc/qkv): the 32x128 four-simdgroup vec tile — Splash's Apple10
    /// prefill shape with the vectorized epilogue. Measured (GPU
    /// timestamps, M5 Max, M = 256..4096, every model projection) ahead of
    /// the legacy op (pad + one-threadgroup-per-32-rows sums pass + 32x256
    /// tile + narrow copy) on every shape; see th-e-prefill-gemm.md.
    pub(crate) fn pf_policy_large(m: usize, _out: usize, inp: usize, _gate_up: bool) -> Option<PfCfg> {
        if m <= 128 || inp % 64 != 0 {
            return None;
        }
        Some(PfCfg { vec: true, ..PfCfg::new(32, 128, 4) })
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
            } else if p == "v" {
                c.vec = true;
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

        /// A dump in the layout the M5's MPP produces for 32x128 / 4 sg
        /// (probe: thread t, run j -> cols 4*(t%16) + 64*((j>>1)&1) .. +3,
        /// row (t/16) + 8*(j&1) + 16*(j>>2)) passes; perturbations fail.
        #[test]
        fn pf_vec_layout_check_accepts_runs_rejects_others() {
            let (rows, tile_n, threads) = (32usize, 128usize, 128usize);
            let cap = rows * tile_n / threads;
            let mut dump = vec![0i32; 1 + threads * cap * 3];
            dump[0] = cap as i32;
            for t in 0..threads {
                for j in 0..cap / 4 {
                    for k in 0..4 {
                        let b = 1 + (t * cap + 4 * j + k) * 3;
                        dump[b] = 1;
                        dump[b + 1] = (4 * (t % 16) + 64 * ((j >> 1) & 1) + k) as i32;
                        dump[b + 2] = ((t / 16) + 8 * (j & 1) + 16 * (j >> 2)) as i32;
                    }
                }
            }
            assert!(pf_vec_layout_check(&dump, threads, rows, tile_n));
            // a run whose columns are not consecutive
            let mut d = dump.clone();
            d[1 + 1 * 3 + 1] += 1;
            assert!(!pf_vec_layout_check(&d, threads, rows, tile_n));
            // an invalid element
            let mut d = dump.clone();
            d[1 + 5 * 3] = 0;
            assert!(!pf_vec_layout_check(&d, threads, rows, tile_n));
            // two threads owning the same element (row of thread 1 := thread 0's)
            let mut d = dump.clone();
            for i in 0..cap {
                d[1 + (16 * cap + i) * 3 + 2] = d[1 + i * 3 + 2];
            }
            assert!(!pf_vec_layout_check(&d, threads, rows, tile_n));
            // wrong capacity
            let mut d = dump.clone();
            d[0] = 16;
            assert!(!pf_vec_layout_check(&d, threads, rows, tile_n));
        }

        /// E1 route: m > 128 takes the vec tile (unsplit, unfused) for
        /// every model shape, plain and gate/up; <= 128 keeps `pf_policy`.
        #[test]
        fn pf_policy_large_table() {
            for &(out, inp, gu) in &[
                (17408usize, 5120usize, true),
                (5120, 17408, false),
                (16480, 5120, false),
                (14336, 5120, false),
                (5120, 6144, false),
                (5120, 25600, false),
                (6144, 5120, false),
            ] {
                for m in [129usize, 256, 512, 896, 1450, 2048, 4096, 8192] {
                    let c = pf_policy_large(m, out, inp, gu).expect("large route");
                    assert_eq!(c.label(), "r32n128s4+v", "m={m} out={out} inp={inp}");
                    assert!(valid(c, inp, gu) && c.splits == 1 && !c.fused);
                    assert!(PF_LARGE_SHAPES.contains(&(c.rows, c.tile_n, c.sgs)));
                }
                assert_eq!(pf_policy_large(128, out, inp, gu), None);
            }
        }

        fn lcg(seed: &mut u64) -> u32 {
            *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (*seed >> 32) as u32
        }

        /// The vec tile (plain and up·silu) is bitwise equal to the legacy
        /// AffineQmppPrefill — the pre-E1 path for m > 128 — on random
        /// tiled weights, including ragged rows (m % 32 != 0) and a ragged
        /// last column tile (out % 128 != 0, out % 256 != 0).
        #[test]
        fn pf_vec_matches_legacy_bitwise() {
            use candle_core::{Device, Tensor};
            let dev = Device::new_metal(0).unwrap();
            let Device::Metal(md) = &dev else { unreachable!() };
            let cfg = PfCfg { vec: true, ..PfCfg::new(32, 128, 4) };
            if !pf_vec_layout_ok(md, &cfg) {
                eprintln!("pf_vec_matches_legacy_bitwise: layout probe failed on this GPU — vec route disabled, skipped");
                return;
            }
            let mut seed = 0x5eedu64;
            // (out per stream, inp, gate_up, m)
            for &(out, inp, gu, m) in &[
                (640usize, 512usize, false, 130usize),
                (720, 256, false, 257),
                (384, 1024, false, 64),
                (1280, 512, false, 200),
                (512, 512, true, 161),
                (256, 1024, true, 96),
            ] {
                let ng = inp / 64;
                let total = if gu { 2 * out } else { out };
                let padded = total.div_ceil(256) * 256;
                let wq: Vec<u32> = (0..padded * ng * 8).map(|_| lcg(&mut seed)).collect();
                let sb: Vec<half::bf16> = (0..2 * padded * ng)
                    .map(|i| {
                        let u = (lcg(&mut seed) % 1000) as f32 / 1000.0;
                        half::bf16::from_f32(if i < padded * ng { 0.002 + 0.01 * u } else { -0.05 + 0.02 * u })
                    })
                    .collect();
                let x: Vec<half::bf16> = (0..m * inp)
                    .map(|_| half::bf16::from_f32((lcg(&mut seed) % 2000) as f32 / 500.0 - 2.0))
                    .collect();
                let wq = Tensor::from_vec(wq, (padded * ng * 8,), &dev).unwrap();
                let sb = Tensor::from_vec(sb, (2 * padded * ng,), &dev).unwrap();
                let x = Tensor::from_vec(x, (m, inp), &dev).unwrap();
                let up_tile = if gu { out / 256 } else { 0 };
                let legacy = wq
                    .apply_op3_no_bwd(&sb, &x, &AffineQmppPrefill { inp, out, padded, m, up_tile })
                    .unwrap()
                    .narrow(0, 0, m)
                    .unwrap()
                    .narrow(1, 0, out)
                    .unwrap()
                    .contiguous()
                    .unwrap();
                let vec = wq
                    .apply_op3_no_bwd(&sb, &x, &AffineQpf { inp, out, padded, m, up_tile, cfg, presum: false, emit: false })
                    .unwrap();
                let a: Vec<u16> = legacy.flatten_all().unwrap().to_dtype(candle_core::DType::F32).unwrap()
                    .to_vec1::<f32>().unwrap().iter().map(|v| half::bf16::from_f32(*v).to_bits()).collect();
                let b: Vec<u16> = vec.flatten_all().unwrap().to_dtype(candle_core::DType::F32).unwrap()
                    .to_vec1::<f32>().unwrap().iter().map(|v| half::bf16::from_f32(*v).to_bits()).collect();
                assert_eq!(a.len(), m * out);
                let diff = a.iter().zip(&b).filter(|(p, q)| p != q).count();
                assert_eq!(diff, 0, "vec vs legacy: {diff} of {} differ (out={out} inp={inp} gu={gu} m={m})", a.len());
            }
        }

        /// E1(c): the prefill presum chain is bitwise equal to the pf_prep
        /// path — AddRmsNorm { pfsums } keeps residual / normed values and
        /// its block feeds a vec projection exactly like pf_prep's sums; the
        /// gate/up up·silu pass with `emit` stores the same activation and
        /// its block feeds `down` exactly like a pf_prep pass over it.
        #[test]
        fn pf_presum_chain_matches_prep_bitwise() {
            use candle_core::{DType, Device, Tensor};
            let dev = Device::new_metal(0).unwrap();
            let Device::Metal(md) = &dev else { unreachable!() };
            let cfg = PfCfg { vec: true, ..PfCfg::new(32, 128, 4) };
            if !pf_vec_layout_ok(md, &cfg) {
                eprintln!("pf_presum_chain_matches_prep_bitwise: layout probe failed — skipped");
                return;
            }
            let bits = |t: &Tensor| -> Vec<u16> {
                t.flatten_all().unwrap().to_dtype(DType::F32).unwrap().to_vec1::<f32>().unwrap()
                    .iter().map(|v| half::bf16::from_f32(*v).to_bits()).collect()
            };
            let mut seed = 0xc0ffeeu64;
            fn rndv(seed: &mut u64, n: usize, scale: f32) -> Vec<half::bf16> {
                (0..n).map(|_| half::bf16::from_f32(((lcg(seed) % 2000) as f32 / 1000.0 - 1.0) * scale)).collect()
            }
            let qw = |seed: &mut u64, rows: usize, inp: usize| -> (Tensor, Tensor) {
                let ng = inp / 64;
                let wq: Vec<u32> = (0..rows * ng * 8).map(|_| lcg(seed)).collect();
                let sb: Vec<half::bf16> = (0..2 * rows * ng)
                    .map(|i| {
                        let u = (lcg(seed) % 1000) as f32 / 1000.0;
                        half::bf16::from_f32(if i < rows * ng { 0.002 + 0.01 * u } else { -0.05 + 0.02 * u })
                    })
                    .collect();
                (Tensor::from_vec(wq, (rows * ng * 8,), &dev).unwrap(), Tensor::from_vec(sb, (2 * rows * ng,), &dev).unwrap())
            };
            for &(t, c) in &[(161usize, 1024usize), (256, 512), (133, 1024)] {
                let x = Tensor::from_vec(rndv(&mut seed, t * c, 3.0), (1, t, c), &dev).unwrap();
                let r = Tensor::from_vec(rndv(&mut seed, t * c, 3.0), (1, t, c), &dev).unwrap();
                let w = Tensor::from_vec(rndv(&mut seed, c, 1.5), (c,), &dev).unwrap();
                let arn = |pfsums: bool| {
                    x.apply_op3_no_bwd(
                        &r,
                        &w,
                        &crate::gdn_kernel::AddRmsNorm { t, c, eps: 1e-6, sums: false, pfsums, legacy: false },
                    )
                    .unwrap()
                };
                let (y0, y1) = (arn(false), arn(true));
                for plane in 0..2 {
                    assert_eq!(
                        bits(&y0.narrow(0, plane, 1).unwrap()),
                        bits(&y1.narrow(0, plane, 1).unwrap()),
                        "add-rmsnorm plane {plane} t={t} c={c}"
                    );
                }
                let n0 = y0.narrow(0, 1, 1).unwrap().reshape((t, c)).unwrap();
                let n1 = y1.narrow(0, 1, 1).unwrap().reshape((t, c)).unwrap();
                // plain projection (ragged columns: 640 % 128 != 0 ... = 5 tiles)
                let out = 640usize;
                let (wq, sb) = qw(&mut seed, 768, c);
                let proj = |xin: &Tensor, presum: bool| {
                    wq.apply_op3_no_bwd(&sb, xin, &AffineQpf { inp: c, out, padded: 768, m: t, up_tile: 0, cfg, presum, emit: false })
                        .unwrap()
                };
                assert_eq!(bits(&proj(&n0, false)), bits(&proj(&n1, true)), "proj presum t={t} c={c}");
                // gate/up (512 per stream) with emit, then down on its block
                let half = 512usize;
                let (gwq, gsb) = qw(&mut seed, 2 * half, c);
                let gu = |xin: &Tensor, presum: bool, emit: bool| {
                    gwq.apply_op3_no_bwd(
                        &gsb,
                        xin,
                        &AffineQpf { inp: c, out: half, padded: 2 * half, m: t, up_tile: half / 256, cfg, presum, emit },
                    )
                    .unwrap()
                };
                let (a0, a1) = (gu(&n0, false, false), gu(&n1, true, true));
                assert_eq!(bits(&a0), bits(&a1), "gate/up emit t={t} c={c}");
                let (dwq, dsb) = qw(&mut seed, 256, half);
                let down = |xin: &Tensor, presum: bool| {
                    dwq.apply_op3_no_bwd(&dsb, xin, &AffineQpf { inp: half, out: 256, padded: 256, m: t, up_tile: 0, cfg, presum, emit: false })
                        .unwrap()
                };
                assert_eq!(bits(&down(&a0, false)), bits(&down(&a1, true)), "down on emitted block t={t} c={c}");
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
            } else if {
                static SG8: OnceLock<bool> = OnceLock::new();
                *SG8.get_or_init(|| std::env::var("TH_QMM_SG8").is_ok())
            } {
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

#[cfg(test)]
mod tests {
    use super::{plain_tile_for, DecodeTile, Q4PolicyMode};

    // Qwen3.8-27B decode shapes (out, in) on the 40-core M5 Max.
    const LM_HEAD: (usize, usize) = (248320, 5120);
    const IN_ALL: (usize, usize) = (16480, 5120);
    const IN_QKV: (usize, usize) = (14336, 5120);
    const OUT_O: (usize, usize) = (5120, 6144);
    const DOWN: (usize, usize) = (5120, 17408);

    #[test]
    fn plain_tile_table() {
        use DecodeTile::*;
        use Q4PolicyMode::*;
        let cases = [
            (Tuned, LM_HEAD, 40, Paired256),
            (Tuned, IN_ALL, 40, N256Sg8),
            (Tuned, IN_QKV, 40, N64Split4),
            (Tuned, OUT_O, 40, N64Split4),
            (Tuned, DOWN, 40, N64Split4),
            // K45 autotune: the DFlash draft's unfused gate / up
            (Tuned, (17408, 5120), 40, N256Sg8),
            (Tuned, (6144, 5120), 40, N64Split4),
            // 970 tiles < 8 x 128 cores: not "very wide" on a bigger GPU
            (Tuned, LM_HEAD, 128, N64Split4),
            (Legacy, LM_HEAD, 40, N64Split4),
            (Legacy, IN_ALL, 40, N64Split4),
            (Seq, LM_HEAD, 40, Paired256),
            (Seq, IN_ALL, 40, N256Sg8),
            (Seq, DOWN, 40, N256Sg8),
        ];
        for (mode, (out, inp), cores, want) in cases {
            assert_eq!(
                plain_tile_for(mode, out, inp, cores),
                want,
                "{mode:?} {out}x{inp} cores={cores}"
            );
        }
        assert_eq!(DecodeTile::N64Split4.tile_sgs(), (64, 2));
        assert_eq!(DecodeTile::N256Sg8.tile_sgs(), (256, 8));
        assert_eq!(DecodeTile::Paired256.tile_sgs(), (256, 4));
    }

    #[test]
    fn qmvt_policy_table() {
        use super::{qmvt_cfg_for, QmvtCfg, QMVT_KERNELS};
        // (out per stream, in, gate_up) -> config, Qwen3.8-27B m = 1 shapes
        let cases = [
            (17408, 5120, true, QmvtCfg::R1S8),  // gate_up (2 x 17408 rows)
            (16480, 5120, false, QmvtCfg::R1S8), // GDN in_all
            (14336, 5120, false, QmvtCfg::R1S8), // attn in_qkv
            (248320, 5120, false, QmvtCfg::R1S8), // lm_head
            (5120, 17408, false, QmvtCfg::R2S4), // down
            (5120, 6144, false, QmvtCfg::R2S4),  // GDN out / attn o
            (6144, 5120, false, QmvtCfg::R2S4),  // draft qkv
            (4096, 5120, true, QmvtCfg::R1S8),   // 8192 fused rows: wide
            (4095, 5120, true, QmvtCfg::R2S4),
        ];
        for (out, inp, gu, want) in cases {
            let got = qmvt_cfg_for(out, inp, gu);
            assert_eq!(got, want, "{out}x{inp} gate_up={gu}");
            assert!(QMVT_KERNELS.contains(&got), "{got:?} not instantiated");
        }
        assert_eq!(QmvtCfg::parse("r2s4"), Some(QmvtCfg::R2S4));
        assert_eq!(QmvtCfg::parse(" r1s8 "), Some(QmvtCfg::R1S8));
        assert_eq!(QmvtCfg::parse("r3s8"), None); // not instantiated
        assert_eq!(QmvtCfg::parse("4s8"), None);
        assert_eq!(QmvtCfg::parse("r4x8"), None);
    }

    #[cfg(all(feature = "metal", target_os = "macos"))]
    #[test]
    fn mpp_group_policy() {
        use super::metal_impl::{max_core_tiles, mpp_groups};
        // (tiles, cores, groups) — full grid up to 3 x cores and from
        // 8 x cores; in between the smallest balanced two-tile count
        // (Splash decodeGroups). 136 = the fused m=1 gate/up N256 grid.
        for (tiles, cores, want) in
            [(68, 40, 68), (65, 40, 65), (20, 40, 20), (970, 40, 970), (136, 40, 96), (300, 40, 120)]
        {
            assert_eq!(mpp_groups(tiles, cores), want, "tiles={tiles} cores={cores}");
        }
        // a core hosts groups core, core+cores, ...: 136 tiles over 96
        // groups load 4 tiles on cores 0..15 (= ceil(136/40), balanced)
        assert_eq!(max_core_tiles(136, 96, 40), 4);
        assert_eq!(max_core_tiles(136, 95, 40), 5);
        // one tile per group: the worst core hosts ceil(groups/cores)
        assert_eq!(max_core_tiles(136, 136, 40), 4);
        assert_eq!(max_core_tiles(80, 80, 40), 2);
    }
}
