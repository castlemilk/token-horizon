//! R0c: env-gated per-command-buffer GPU timing (`TH_GPU_PROF=1`).
//!
//! Attributes GPU execution time to engine regions and kernels without
//! touching candle: at startup (before candle creates its device) the
//! concrete Metal driver classes are swizzled —
//!   - `-[MTLCommandBuffer commit]` attaches a completion handler that
//!     records the buffer's `GPUStartTime`/`GPUEndTime`;
//!   - `computeCommandEncoderWithDispatchType:` / `blitCommandEncoder` note
//!     the command buffer candle is currently encoding into;
//!   - `setComputePipelineState:` + `dispatchThreadgroups:`/`dispatchThreads:`
//!     tag every dispatch with (phase, region, kernel function name);
//!   - `newComputePipelineStateWithFunction:error:` maps pipelines to their
//!     function names.
//! The engine marks regions with [`phase`] / [`region`] (a relaxed load
//! when disabled) and calls [`round`] once per decode round; every
//! `TH_GPU_PROF_EVERY` rounds (default 32) a table is printed:
//! `[gpuprof] row phase=.. region=.. kernel=.. n/round ms/round us/call`.
//!
//! Granularity: candle commits a command buffer every
//! `CANDLE_METAL_COMPUTE_PER_BUFFER` (default 50) encoder requests. With
//! `CANDLE_METAL_COMPUTE_PER_BUFFER=1` every dispatch gets its own command
//! buffer and the attribution is per dispatch; with the default only the
//! totals (GPU busy, idle gaps, span) are exact and a buffer's time is
//! split evenly over its dispatches. Times are *exclusive*: a buffer's
//! interval is clipped at the end of the latest earlier-committed buffer,
//! so overlapping buffers (a buffer that starts, then waits on a fence) are
//! not double counted. Per-buffer overhead is included — compare
//! against a default-granularity run for absolute totals.
//!
//! Diagnostic only: never enabled unless `TH_GPU_PROF` is set; adds no
//! work to the hot path otherwise.

#[cfg(all(feature = "metal", target_os = "macos"))]
pub use imp::*;

#[cfg(not(all(feature = "metal", target_os = "macos")))]
mod stub {
    pub fn init() {}
    #[inline]
    pub fn on() -> bool {
        false
    }
    #[inline]
    pub fn phase(_: &'static str) {}
    #[inline]
    pub fn region(_: &'static str) {}
    pub fn round() {}
}
#[cfg(not(all(feature = "metal", target_os = "macos")))]
pub use stub::*;

#[cfg(all(feature = "metal", target_os = "macos"))]
mod imp {
    use std::collections::HashMap;
    use std::ffi::{c_char, CStr};
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Mutex, OnceLock};

    use block2::RcBlock;
    use objc2::runtime::{AnyClass, AnyObject, Imp, ProtocolObject, Sel};
    use objc2::{msg_send, sel};
    use objc2_metal::{
        MTLCommandBuffer, MTLCommandEncoder, MTLCommandQueue, MTLDevice, MTLDispatchType,
        MTLSize,
    };

    static ON: AtomicBool = AtomicBool::new(false);
    static EVERY: AtomicUsize = AtomicUsize::new(32);

    /// (phase, region) of the work being encoded right now.
    static CUR: Mutex<(&'static str, &'static str)> = Mutex::new(("-", "-"));

    #[derive(Clone, Copy, PartialEq, Eq, Hash)]
    struct Key {
        phase: &'static str,
        region: &'static str,
        kernel: u32,
    }

    struct Rec {
        seq: u64,
        start: f64,
        end: f64,
        keys: Vec<Key>,
    }

    #[derive(Default)]
    struct St {
        /// the command buffer candle last opened an encoder on
        cur_cb: usize,
        /// kernel id of the pipeline last set on the current encoder
        cur_kernel: u32,
        /// per open command buffer: its dispatches' keys (until commit)
        pending: HashMap<usize, Vec<Key>>,
        /// kernel id -> function name (0 = unknown, 1 = blit)
        kernels: Vec<String>,
        /// pipeline pointer -> kernel id
        pso: HashMap<usize, u32>,
        /// completed buffers of the current window
        recs: Vec<Rec>,
        seq: u64,
        rounds: u64,
        /// latest end time over all reported buffers (clipping across
        /// window boundaries)
        last_end: f64,
    }

    fn st() -> &'static Mutex<St> {
        static S: OnceLock<Mutex<St>> = OnceLock::new();
        S.get_or_init(|| {
            Mutex::new(St {
                kernels: vec!["?".into(), "blit".into()],
                ..Default::default()
            })
        })
    }

    /// Profiling armed (read once at [`init`]).
    #[inline]
    pub fn on() -> bool {
        ON.load(Ordering::Relaxed)
    }

    /// Set the phase (verify / propose / rollback / ...) of the work
    /// encoded from here on; resets the region.
    #[inline]
    pub fn phase(p: &'static str) {
        if on() {
            *CUR.lock().unwrap() = (p, "-");
        }
    }

    /// Set the region (gdn.step / attn.o / lm_head / ...) inside the phase.
    #[inline]
    pub fn region(r: &'static str) {
        if on() {
            CUR.lock().unwrap().1 = r;
        }
    }

    // -- swizzled implementations -----------------------------------------

    static O_COMMIT: AtomicUsize = AtomicUsize::new(0);
    static O_CENC_DT: AtomicUsize = AtomicUsize::new(0);
    static O_BENC: AtomicUsize = AtomicUsize::new(0);
    static O_SETPSO: AtomicUsize = AtomicUsize::new(0);
    static O_DISP_TG: AtomicUsize = AtomicUsize::new(0);
    static O_DISP_T: AtomicUsize = AtomicUsize::new(0);
    static O_NEWPSO: AtomicUsize = AtomicUsize::new(0);

    fn push_key(s: &mut St, kernel: u32) {
        if s.cur_cb == 0 {
            return;
        }
        let (phase, region) = *CUR.lock().unwrap();
        let cb = s.cur_cb;
        s.pending.entry(cb).or_default().push(Key { phase, region, kernel });
    }

    unsafe extern "C-unwind" fn r_commit(this: *mut AnyObject, cmd: Sel) {
        let (keys, seq) = {
            let mut s = st().lock().unwrap();
            s.seq += 1;
            let keys = s.pending.remove(&(this as usize)).unwrap_or_default();
            if s.cur_cb == this as usize {
                s.cur_cb = 0;
            }
            (keys, s.seq)
        };
        let slot = Mutex::new(Some(keys));
        let block = RcBlock::new(move |cbp: NonNull<ProtocolObject<dyn MTLCommandBuffer>>| {
            // SAFETY: Metal hands the completed buffer to its handler.
            let cb = unsafe { cbp.as_ref() };
            let (start, end) = (cb.GPUStartTime(), cb.GPUEndTime());
            let keys = slot.lock().unwrap().take().unwrap_or_default();
            st().lock().unwrap().recs.push(Rec { seq, start, end, keys });
        });
        // SAFETY: `this` is the command buffer being committed; handlers
        // must be added before `commit`, which is exactly where we are.
        let cb = &*(this as *const ProtocolObject<dyn MTLCommandBuffer>);
        cb.addCompletedHandler(RcBlock::as_ptr(&block));
        let orig: unsafe extern "C-unwind" fn(*mut AnyObject, Sel) =
            std::mem::transmute(O_COMMIT.load(Ordering::Relaxed));
        orig(this, cmd);
    }

    unsafe extern "C-unwind" fn r_cenc_dt(
        this: *mut AnyObject,
        cmd: Sel,
        t: usize,
    ) -> *mut AnyObject {
        let orig: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, usize) -> *mut AnyObject =
            std::mem::transmute(O_CENC_DT.load(Ordering::Relaxed));
        let r = orig(this, cmd, t);
        st().lock().unwrap().cur_cb = this as usize;
        r
    }

    unsafe extern "C-unwind" fn r_benc(this: *mut AnyObject, cmd: Sel) -> *mut AnyObject {
        let orig: unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject =
            std::mem::transmute(O_BENC.load(Ordering::Relaxed));
        let r = orig(this, cmd);
        let mut s = st().lock().unwrap();
        s.cur_cb = this as usize;
        push_key(&mut s, 1);
        r
    }

    unsafe extern "C-unwind" fn r_setpso(this: *mut AnyObject, cmd: Sel, pso: *mut AnyObject) {
        let orig: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) =
            std::mem::transmute(O_SETPSO.load(Ordering::Relaxed));
        orig(this, cmd, pso);
        let mut s = st().lock().unwrap();
        s.cur_kernel = s.pso.get(&(pso as usize)).copied().unwrap_or(0);
    }

    unsafe extern "C-unwind" fn r_disp_tg(this: *mut AnyObject, cmd: Sel, a: MTLSize, b: MTLSize) {
        let orig: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, MTLSize, MTLSize) =
            std::mem::transmute(O_DISP_TG.load(Ordering::Relaxed));
        orig(this, cmd, a, b);
        let mut s = st().lock().unwrap();
        let k = s.cur_kernel;
        push_key(&mut s, k);
    }

    unsafe extern "C-unwind" fn r_disp_t(this: *mut AnyObject, cmd: Sel, a: MTLSize, b: MTLSize) {
        let orig: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, MTLSize, MTLSize) =
            std::mem::transmute(O_DISP_T.load(Ordering::Relaxed));
        orig(this, cmd, a, b);
        let mut s = st().lock().unwrap();
        let k = s.cur_kernel;
        push_key(&mut s, k);
    }

    unsafe extern "C-unwind" fn r_newpso(
        this: *mut AnyObject,
        cmd: Sel,
        func: *mut AnyObject,
        err: *mut *mut AnyObject,
    ) -> *mut AnyObject {
        let orig: unsafe extern "C-unwind" fn(
            *mut AnyObject,
            Sel,
            *mut AnyObject,
            *mut *mut AnyObject,
        ) -> *mut AnyObject = std::mem::transmute(O_NEWPSO.load(Ordering::Relaxed));
        let r = orig(this, cmd, func, err);
        if !r.is_null() && !func.is_null() {
            let name: *mut AnyObject = msg_send![func, name];
            let s = if name.is_null() {
                "?".to_string()
            } else {
                let c: *const c_char = msg_send![name, UTF8String];
                if c.is_null() {
                    "?".to_string()
                } else {
                    CStr::from_ptr(c).to_string_lossy().into_owned()
                }
            };
            let mut g = st().lock().unwrap();
            let id = match g.kernels.iter().position(|k| *k == s) {
                Some(i) => i as u32,
                None => {
                    g.kernels.push(s);
                    (g.kernels.len() - 1) as u32
                }
            };
            g.pso.insert(r as usize, id);
        }
        r
    }

    /// A replacement implementation as an untyped IMP.
    unsafe fn imp_of(f: *const ()) -> Imp {
        std::mem::transmute::<*const (), Imp>(f)
    }

    unsafe fn swizzle(cls: *const AnyClass, sel: Sel, imp: Imp, orig: &AtomicUsize) -> bool {
        let m = objc2::ffi::class_getInstanceMethod(cls, sel);
        if m.is_null() {
            eprintln!("[gpuprof] WARN no method {sel:?}");
            return false;
        }
        match objc2::ffi::method_setImplementation(m as *mut _, imp) {
            Some(prev) => {
                orig.store(prev as usize, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Arm the profiler when `TH_GPU_PROF` is set (non-empty, not "0").
    /// Must run before candle creates its Metal device (pipelines are
    /// named at creation). Idempotent.
    pub fn init() {
        static DONE: OnceLock<()> = OnceLock::new();
        DONE.get_or_init(|| {
            let want = std::env::var("TH_GPU_PROF").map_or(false, |v| !v.is_empty() && v != "0");
            if !want {
                return;
            }
            if let Some(n) = std::env::var("TH_GPU_PROF_EVERY")
                .ok()
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|&n| n > 0)
            {
                EVERY.store(n, Ordering::Relaxed);
            }
            let Some(dev) = objc2_metal::MTLCreateSystemDefaultDevice() else {
                eprintln!("[gpuprof] no Metal device; disabled");
                return;
            };
            let Some(q) = dev.newCommandQueue() else { return };
            let Some(cb) = q.commandBuffer() else { return };
            let Some(ce) = cb.computeCommandEncoderWithDispatchType(MTLDispatchType::Concurrent)
            else {
                return;
            };
            ce.endEncoding();
            let Some(be) = cb.blitCommandEncoder() else { return };
            be.endEncoding();
            // SAFETY: plain runtime queries on live objects; the swizzled
            // replacements forward to the original IMPs with identical
            // signatures (commit, the two encoder factories, pipeline
            // binding, both dispatch forms, pipeline creation).
            unsafe {
                let c_cb = objc2::ffi::object_getClass(
                    &*cb as *const ProtocolObject<dyn MTLCommandBuffer> as *const AnyObject,
                );
                let c_ce = objc2::ffi::object_getClass(
                    &*ce as *const ProtocolObject<dyn objc2_metal::MTLComputeCommandEncoder>
                        as *const AnyObject,
                );
                let c_dev = objc2::ffi::object_getClass(
                    &*dev as *const ProtocolObject<dyn MTLDevice> as *const AnyObject,
                );
                let ok = [
                    swizzle(c_cb, sel!(commit), imp_of(r_commit as *const ()), &O_COMMIT),
                    swizzle(
                        c_cb,
                        sel!(computeCommandEncoderWithDispatchType:),
                        imp_of(r_cenc_dt as *const ()),
                        &O_CENC_DT,
                    ),
                    swizzle(c_cb, sel!(blitCommandEncoder), imp_of(r_benc as *const ()), &O_BENC),
                    swizzle(
                        c_ce,
                        sel!(setComputePipelineState:),
                        imp_of(r_setpso as *const ()),
                        &O_SETPSO,
                    ),
                    swizzle(
                        c_ce,
                        sel!(dispatchThreadgroups:threadsPerThreadgroup:),
                        imp_of(r_disp_tg as *const ()),
                        &O_DISP_TG,
                    ),
                    swizzle(
                        c_ce,
                        sel!(dispatchThreads:threadsPerThreadgroup:),
                        imp_of(r_disp_t as *const ()),
                        &O_DISP_T,
                    ),
                    swizzle(
                        c_dev,
                        sel!(newComputePipelineStateWithFunction:error:),
                        imp_of(r_newpso as *const ()),
                        &O_NEWPSO,
                    ),
                ];
                if ok.iter().any(|&b| !b) {
                    eprintln!("[gpuprof] swizzle failed ({ok:?}); profiling off");
                    return;
                }
            }
            ON.store(true, Ordering::Relaxed);
            eprintln!(
                "[gpuprof] armed: every {} rounds, CANDLE_METAL_COMPUTE_PER_BUFFER={}",
                EVERY.load(Ordering::Relaxed),
                std::env::var("CANDLE_METAL_COMPUTE_PER_BUFFER").unwrap_or_else(|_| "50 (default)".into())
            );
            // the throwaway objects stay alive for the process (same device)
            std::mem::forget((ce, be, cb, q, dev));
        });
    }

    /// One decode round started. Every `TH_GPU_PROF_EVERY` rounds prints the
    /// window's attribution table and resets it.
    pub fn round() {
        if !on() {
            return;
        }
        let every = EVERY.load(Ordering::Relaxed) as u64;
        let (mut recs, kernels, prev_end) = {
            let mut s = st().lock().unwrap();
            s.rounds += 1;
            if s.rounds % every != 0 {
                return;
            }
            let recs = std::mem::take(&mut s.recs);
            (recs, s.kernels.clone(), s.last_end)
        };
        recs.sort_by_key(|r| r.seq);
        let n = every as f64;
        // key -> (dispatches, exclusive seconds, raw seconds)
        let mut agg: HashMap<Key, (u64, f64, f64)> = HashMap::new();
        let mut phases: HashMap<&'static str, f64> = HashMap::new();
        let (mut busy, mut raw, mut idle, mut shared) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let mut last_end = prev_end;
        let (mut first, mut last) = (f64::MAX, 0.0f64);
        let (mut ncb, mut ndisp, mut skipped) = (0u64, 0u64, 0u64);
        for r in &recs {
            if !(r.end > r.start && r.start > 0.0) {
                skipped += 1;
                continue;
            }
            ncb += 1;
            first = first.min(r.start);
            last = last.max(r.end);
            let s0 = r.start.max(last_end);
            if last_end > 0.0 && r.start > last_end {
                idle += r.start - last_end;
            }
            let excl = (r.end - s0).max(0.0);
            last_end = last_end.max(r.end);
            busy += excl;
            raw += r.end - r.start;
            let k = r.keys.len().max(1) as f64;
            if r.keys.len() > 1 {
                shared += excl;
            }
            ndisp += r.keys.len() as u64;
            if r.keys.is_empty() {
                let key = Key { phase: "-", region: "(no dispatch)", kernel: 0 };
                let e = agg.entry(key).or_default();
                e.1 += excl;
                e.2 += r.end - r.start;
                *phases.entry("-").or_default() += excl;
            }
            for key in &r.keys {
                let e = agg.entry(*key).or_default();
                e.0 += 1;
                e.1 += excl / k;
                e.2 += (r.end - r.start) / k;
                *phases.entry(key.phase).or_default() += excl / k;
            }
        }
        st().lock().unwrap().last_end = last_end;
        let ms = |s: f64| s * 1e3 / n;
        eprintln!(
            "[gpuprof] window rounds={} cbs/round={:.1} dispatches/round={:.1} busy_ms/round={:.3} raw_ms/round={:.3} idle_ms/round={:.3} span_ms/round={:.3} shared_frac={:.3} skipped={}",
            every,
            ncb as f64 / n,
            ndisp as f64 / n,
            ms(busy),
            ms(raw),
            ms(idle),
            if last > first { ms(last - first) } else { 0.0 },
            if busy > 0.0 { shared / busy } else { 0.0 },
            skipped
        );
        let mut ph: Vec<_> = phases.into_iter().collect();
        ph.sort_by(|a, b| b.1.total_cmp(&a.1));
        for (p, s) in ph {
            eprintln!("[gpuprof] phase={p} ms/round={:.3}", ms(s));
        }
        let mut rows: Vec<_> = agg.into_iter().collect();
        rows.sort_by(|a, b| b.1 .1.total_cmp(&a.1 .1));
        for (k, (cnt, excl, rawt)) in rows {
            let name = kernels.get(k.kernel as usize).map(String::as_str).unwrap_or("?");
            eprintln!(
                "[gpuprof] row phase={} region={} kernel={} n/round={:.2} ms/round={:.4} raw_ms/round={:.4} us/call={:.2}",
                k.phase,
                k.region,
                name,
                cnt as f64 / n,
                ms(excl),
                ms(rawt),
                if cnt > 0 { excl * 1e6 / cnt as f64 } else { 0.0 }
            );
        }
    }
}
