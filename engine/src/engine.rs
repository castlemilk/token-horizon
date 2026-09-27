// Engine — owns the model + the generation loop.
//
// Unlike a wrapped binary we control every step: per-token timestamps
// (TTFT, decode histogram), chunked prefill, cancellation, KV position
// tracking. Generation is single-slot v1 — requests serialize on the
// model mutex; the lock is acquired in async context then the blocking
// loop runs on spawn_blocking so token streaming overlaps the forward
// passes.

use crate::model::{self, ModelBackend};
use crate::prefix_cache::{self, PrefixCache, PrefixCacheConfig};
use crate::state::{EngineConfig, EngineState, RequestRecord};
use crate::template::{self, ChatMessage};
use anyhow::{bail, Context, Result};
use candle_core::{DType, Device, IndexOp, Tensor};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

pub struct Engine {
    inner: Arc<tokio::sync::Mutex<ModelInner>>,
    /// Batch-decode queue — set when the backend has >1 decode slots
    /// (TH_BATCH). Jobs are admitted onto free slots and stepped in
    /// lockstep: one weight sweep per verify round serves all slots.
    job_tx: Option<std::sync::mpsc::SyncSender<BatchJob>>,
    pub state: Arc<EngineState>,
}

struct ModelInner {
    backend: ModelBackend,
    tokenizer: tokenizers::Tokenizer,
    eos_ids: Vec<u32>,
    chat_template: Option<String>,
    device: candle_core::Device,
    /// Batch-mode slot occupancy (TH_BATCH > 1): `live[s]` is true while
    /// slot `s` carries a running request's GDN/KV/draft state. Written
    /// by `batch_loop` only while it holds this lock, so an admin op
    /// holding the lock sees an exact view. Always all-false on the
    /// single-slot path (the lock spans the whole generation there, so
    /// admin ops can only land between requests).
    live: Vec<bool>,
    /// T1 prefix cache — slot-state checkpoints keyed by token prefix
    /// (shared by every slot; used only under this lock).
    prefix: PrefixCache<model::BackendPrefix>,
    /// Chat-template ids for the chunk-plan policy (turn ends); None when
    /// the tokenizer lacks them (then only the end-margin checkpoint).
    msg_marks: Option<prefix_cache::ChatMarks>,
}

/// Per-request sampling overrides — any field falls back to EngineConfig.
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct RequestSampling {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<usize>,
    pub repeat_penalty: Option<f32>,
    pub max_tokens: Option<usize>,
    pub seed: Option<u64>,
    pub stop: Option<Vec<String>>,
}

/// Events flowing out of the blocking generation loop to the HTTP layer.
pub enum GenEvent {
    /// First token sampled — carries TTFT in ms.
    FirstToken { ttft_ms: f64 },
    /// A decoded text delta.
    Delta(String),
    /// Terminal state — usage + finish reason + measured rates.
    Done(Box<DoneStats>),
    /// Generation failed mid-stream.
    Error(String),
}

pub struct DoneStats {
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
    pub ttft_ms: f64,
    pub total_ms: f64,
    pub decode_tps: f64,
    pub prefill_tps: f64,
    pub finish: String,
    /// Speculative-decode verify rounds and accepted draft tokens.
    pub spec_rounds: u64,
    pub spec_accepted: u64,
    /// Prompt tokens restored from the T1 prefix cache (not prefilled).
    pub cached_tokens: usize,
}

impl Engine {
    pub async fn load(
        model: &str,
        file: Option<&str>,
        tokenizer_src: Option<&str>,
        cfg: EngineConfig,
    ) -> Result<Self> {
        let mut loaded = model::resolve_and_load(model, file, tokenizer_src).await?;
        if let Some(dir) = &cfg.draft_dir {
            loaded
                .backend
                .attach_draft(dir)
                .context("failed to load DFlash draft")?;
            tracing::info!(draft = %dir.display(), "dflash draft attached");
        }
        if cfg.kv_quant {
            if let model::ModelBackend::Qwen35(m) = &mut loaded.backend {
                m.enable_kv_quant()?;
            }
        }
        let model_id = model.to_string();
        let mut meta = loaded.meta.clone();
        let mut nslots = loaded.backend.nslots();
        if nslots > 1 && !loaded.backend.has_draft() {
            // batch_round is DFlash-only (draft_propose_batch): without a
            // draft every batched request errors after its first token.
            // Serve single-slot instead — generate_blocking (plain +
            // n-gram decode) only ever touches slot 0.
            tracing::warn!(
                requested = nslots,
                "TH_BATCH>1 requires --draft; batched decode disabled, serving single-slot"
            );
            loaded.backend.truncate_slots(1);
            nslots = 1;
        }
        if let Some(o) = meta.as_object_mut() {
            o.insert("decode_slots".into(), serde_json::json!(nslots));
        }
        // hot-path policy knobs are read here, once, never per round
        let _ = debug_timing();
        tracing::info!(qos = ?decode_qos::mode(), "decode thread QoS (TH_DECODE_QOS)");
        if loaded.backend.has_draft() {
            tracing::info!(
                verify = if verify_adaptive() { "adaptive (TH_VERIFY_ADAPTIVE)" } else { "all 7 proposals" },
                "dflash verify length"
            );
        }
        // T1 prefix cache: qwen3_5 only (the backend with slot-state
        // capture/restore); knobs read once here
        let prefix_cfg = if matches!(loaded.backend, ModelBackend::Qwen35(_)) {
            PrefixCacheConfig::from_env()
        } else {
            PrefixCacheConfig::disabled()
        };
        let msg_marks = chat_marks(&loaded.tokenizer);
        tracing::info!(
            enabled = prefix_cfg.enabled,
            plan_only = prefix_cfg.plan_only,
            grid_only = prefix_cfg.grid_only,
            max_entries = prefix_cfg.max_entries,
            max_mb = prefix_cfg.max_bytes >> 20,
            block = prefix_cfg.block,
            margin = prefix_cfg.margin,
            chat_boundaries = msg_marks.is_some(),
            "prefix cache (TH_PREFIX_CACHE*)"
        );
        let inner = ModelInner {
            backend: loaded.backend,
            tokenizer: loaded.tokenizer,
            eos_ids: loaded.eos_ids,
            chat_template: loaded.chat_template,
            device: loaded.device,
            live: vec![false; nslots],
            prefix: PrefixCache::new(prefix_cfg),
            msg_marks,
        };
        let inner = Arc::new(tokio::sync::Mutex::new(inner));
        let mut st = EngineState::new(model_id, meta, cfg);
        st.prefix_cfg = prefix_cfg;
        let state = Arc::new(st);
        let job_tx = if nslots > 1 {
            let (tx, rx) =
                std::sync::mpsc::sync_channel::<BatchJob>(nslots * 8);
            let (i2, s2) = (inner.clone(), state.clone());
            std::thread::Builder::new()
                .name("th-batch".into())
                .spawn(move || {
                    // Q1: dedicated scheduler thread — optional QoS raise
                    let _qos = decode_qos::enter();
                    batch_loop(i2, s2, rx, nslots)
                })?;
            tracing::info!(slots = nslots, "batched decode enabled");
            Some(tx)
        } else {
            None
        };
        Ok(Self {
            inner,
            job_tx,
            state,
        })
    }

    /// Run a chat completion. Streams `GenEvent`s on `tx`; the receiver
    /// dropping mid-generation cancels the request.
    ///
    /// The model mutex is held for the whole generation — that IS the
    /// admission policy for v1 (one generation at a time; queued callers
    /// see their wait reflected in TTFT).
    pub async fn generate(
        &self,
        messages: Vec<ChatMessage>,
        req: RequestSampling,
        tx: mpsc::UnboundedSender<GenEvent>,
    ) {
        let inner = self.inner.clone();
        let state = self.state.clone();
        let id = uuidish();
        state.counters.requests_total.fetch_add(1, Ordering::Relaxed);
        state.counters.requests_active.fetch_add(1, Ordering::Relaxed);
        if let Some(q) = &self.job_tx {
            let job = BatchJob {
                id: id.clone(),
                messages,
                req,
                tx: tx.clone(),
                started: Instant::now(),
            };
            match q.try_send(job) {
                Ok(()) => return,
                Err(e) => {
                    let msg = match e {
                        std::sync::mpsc::TrySendError::Full(_) => "batch queue full",
                        std::sync::mpsc::TrySendError::Disconnected(_) => {
                            tracing::error!("th-batch scheduler is gone — engine restart required");
                            "batch scheduler not running (engine restart required)"
                        }
                    };
                    let _ = tx.send(GenEvent::Error(msg.into()));
                    state.counters.requests_active.fetch_sub(1, Ordering::Relaxed);
                    return;
                }
            }
        }
        // fire-and-forget: awaiting the JoinHandle would buffer every
        // delta until generation completes and break SSE streaming
        tokio::task::spawn_blocking(move || {
            let started = Instant::now();
            // Q1: optional decode-thread QoS (TH_DECODE_QOS, default off)
            let _qos = decode_qos::enter();
            let rec = generate_blocking(&inner, &state, &id, messages, req, &tx, started);
            state
                .counters
                .requests_active
                .fetch_sub(1, Ordering::Relaxed);
            match rec {
                Ok(rec) => {
                    state.emit("request.done", serde_json::to_value(&rec).unwrap_or_default());
                    state.record(rec);
                }
                Err(e) => {
                    tracing::warn!(%id, error = %e, "generation failed");
                    let _ = tx.send(GenEvent::Error(e.to_string()));
                }
            }
        });
    }

    /// Clear the KV cache + reset tracked positions.
    ///
    /// Batch mode releases the model lock between verify rounds, so a
    /// slot can be mid-generation when this runs. Clearing it would make
    /// that request's next round verify at its old position against a
    /// zeroed KV prefix / zeroed GDN state — silent garbage. So only
    /// idle slots are cleared; live ones are reported and left intact
    /// (admission clears a slot before reuse anyway).
    pub async fn kv_clear(&self) -> serde_json::Value {
        let mut inner = self.inner.lock().await;
        let mut cleared = Vec::new();
        let mut skipped = Vec::new();
        for s in 0..inner.backend.nslots() {
            if inner.live.get(s).copied().unwrap_or(false) {
                skipped.push(s);
            } else {
                inner.backend.clear_kv_cache(s);
                cleared.push(s);
            }
        }
        if skipped.is_empty() {
            self.state.kv_tokens.store(0, Ordering::Relaxed);
        }
        // T1: checkpoints are independent of live slots (restores copy or
        // share read-only), so they always go
        let prefix_dropped = inner.prefix.clear();
        self.state.prefix_stats.entries.store(0, Ordering::Relaxed);
        self.state.prefix_stats.bytes.store(0, Ordering::Relaxed);
        let out = serde_json::json!({"cleared": cleared, "skipped_live": skipped,
                                     "prefix_cache_dropped": prefix_dropped});
        self.state.emit("kv.cleared", out.clone());
        out
    }

    pub fn config(&self) -> EngineConfig {
        self.state.config.read().unwrap().clone()
    }
}

/// `TH_DEBUG_TIMING` — per-round `[dflash]`/`[verify]`/`[batch]` timing
/// lines. Read once (the decode loop checks it every round).
fn debug_timing() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("TH_DEBUG_TIMING").is_ok())
}

/// L1 — single-slot DFlash verify length policy, read once at startup.
///
/// Default: verify all `PROPOSALS` (anchor + 7 = 8 rows) every round,
/// as Splash and the batched path do. Verify at m <= 8 is weight-
/// bandwidth bound, so rows 3..8 cost well under a millisecond, while a
/// shorter chain forfeits every accept past the cap plus the bonus row.
/// `TH_VERIFY_ADAPTIVE=1` restores the legacy rule: accept EMA + 1
/// headroom, clamped to 2..=7 (EMA of accepted proposals per round).
fn verify_adaptive() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        std::env::var("TH_VERIFY_ADAPTIVE").is_ok_and(|v| !v.is_empty() && v != "0")
    })
}

/// Q1 — decode-thread QoS (macOS).
///
/// The decode loop is host-bound between GPU syncs: every round the
/// thread encodes the draft and verify passes, blocks in
/// `waitUntilCompleted`, and must wake and encode the next pass before
/// the GPU has work again. At the default QoS the scheduler may park it
/// on a slower core or behind other runnable threads at each wake-up.
/// `TH_DECODE_QOS` (read once): `off` (default) = leave the thread's QoS
/// unchanged, `interactive` = QOS_CLASS_USER_INTERACTIVE, `initiated` =
/// QOS_CLASS_USER_INITIATED.
///
/// Default off: measured on the M5 Max (th/c-loop report) interactive
/// QoS changed ms/round by -0.3 (load 3-6) and -0.5 (18 default-QoS
/// spinners on 18 cores), both inside the arm-to-arm spread. The decode
/// thread blocks in waitUntilCompleted every round, so the timeshare
/// scheduler already treats it as interactive.
mod decode_qos {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Mode {
        Off,
        Initiated,
        Interactive,
    }

    pub fn parse(v: Option<&str>) -> Mode {
        match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            Some("interactive" | "user-interactive" | "1" | "on") => Mode::Interactive,
            Some("initiated" | "user-initiated" | "ui") => Mode::Initiated,
            _ => Mode::Off,
        }
    }

    pub fn mode() -> Mode {
        static M: std::sync::OnceLock<Mode> = std::sync::OnceLock::new();
        *M.get_or_init(|| parse(std::env::var("TH_DECODE_QOS").ok().as_deref()))
    }

    /// Restores the thread's previous QoS on drop (the single-slot loop
    /// runs on a reused tokio blocking-pool thread).
    pub struct Guard {
        #[cfg(target_os = "macos")]
        prev: Option<(libc::qos_class_t, libc::c_int)>,
    }

    #[cfg(target_os = "macos")]
    fn current() -> Option<(libc::qos_class_t, libc::c_int)> {
        let mut cls = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
        let mut rel: libc::c_int = 0;
        // SAFETY: querying the calling thread; out-params are valid
        let rc = unsafe { libc::pthread_get_qos_class_np(libc::pthread_self(), &mut cls, &mut rel) };
        (rc == 0).then_some((cls, rel))
    }

    #[cfg(target_os = "macos")]
    fn set(cls: libc::qos_class_t, rel: libc::c_int) -> bool {
        // SAFETY: plain syscall on the calling thread
        unsafe { libc::pthread_set_qos_class_self_np(cls, rel) == 0 }
    }

    /// Raise the calling thread to the configured decode QoS.
    pub fn enter() -> Guard {
        enter_with(mode())
    }

    /// `enter` for an explicit mode (tests).
    pub fn enter_with(m: Mode) -> Guard {
        #[cfg(target_os = "macos")]
        {
            let want = match m {
                Mode::Off => return Guard { prev: None },
                Mode::Initiated => libc::qos_class_t::QOS_CLASS_USER_INITIATED,
                Mode::Interactive => libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE,
            };
            let prev = current();
            if !set(want, 0) {
                return Guard { prev: None };
            }
            static ONCE: std::sync::Once = std::sync::Once::new();
            ONCE.call_once(|| {
                tracing::info!(from = ?prev.map(|p| p.0), to = ?current().map(|p| p.0), "decode thread QoS raised");
            });
            Guard { prev }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = m;
            Guard {}
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            #[cfg(target_os = "macos")]
            if let Some((cls, rel)) = self.prev.take() {
                // UNSPECIFIED can't be re-applied; DEFAULT is its effective class
                let cls = match cls {
                    libc::qos_class_t::QOS_CLASS_UNSPECIFIED => libc::qos_class_t::QOS_CLASS_DEFAULT,
                    c => c,
                };
                let _ = set(cls, rel);
            }
        }
    }
}

/// Proposals verified this round (rows = 1 + this). L1 default: all
/// `PROPOSALS`; `adaptive` = the legacy accept-EMA cap, 2..=PROPOSALS.
fn dflash_verify_len(adaptive: bool, accept_ema: f64) -> usize {
    if adaptive {
        ((accept_ema + 0.5) as usize + 1).clamp(2, crate::dflash::PROPOSALS)
    } else {
        crate::dflash::PROPOSALS
    }
}

fn uuidish() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("th-{:016x}", n)
}

// MARK: - prefill + T1 prefix cache

/// `TH_DEBUG_PREFILL` — per-phase prefill timing on stderr (`[prefill]`:
/// restore, each chunk, each capture, the draft warm-up), each phase
/// closed by a device sync. The syncs serialize host encode and GPU
/// work, so this is a diagnosis mode, not a production setting. Read once.
fn debug_prefill() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("TH_DEBUG_PREFILL").is_ok())
}

/// `TH_DEBUG_PREFILL` phase clock: syncs the device, returns the ms since
/// the previous mark and restarts. No-op (0.0) when the knob is off.
struct PhaseClock {
    on: bool,
    t: Instant,
}

impl PhaseClock {
    fn new() -> Self {
        Self { on: debug_prefill(), t: Instant::now() }
    }

    fn mark(&mut self, device: &Device) -> f64 {
        if !self.on {
            return 0.0;
        }
        let _ = device.synchronize();
        let ms = self.t.elapsed().as_secs_f64() * 1000.0;
        self.t = Instant::now();
        ms
    }
}

/// Chat-template ids (`<|im_start|>`, `<|im_end|>`, `\n`, `assistant`)
/// when the tokenizer has each as a single token.
fn chat_marks(tok: &tokenizers::Tokenizer) -> Option<prefix_cache::ChatMarks> {
    let one = |s: &str| -> Option<u32> {
        let e = tok.encode(s, false).ok()?;
        match e.get_ids() {
            [id] => Some(*id),
            _ => None,
        }
    };
    Some(prefix_cache::ChatMarks {
        im_start: tok.token_to_id("<|im_start|>")?,
        im_end: tok.token_to_id("<|im_end|>")?,
        newline: one("\n")?,
        assistant: one("assistant")?,
    })
}

/// `TH_PREFILL_HEAD=1`: every prefill chunk runs the final norm + lm_head
/// (the logits of all but the last chunk are discarded) — the A/B arm for
/// `forward_slot_nohead`. Read once.
fn prefill_head_all() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TH_PREFILL_HEAD").as_deref() == Ok("1"))
}

/// What `prefill_slot` did.
struct Prefilled {
    /// Logits of the last prompt position (None for an empty prompt).
    logits: Option<Tensor>,
    /// Prompt tokens restored from a checkpoint (not forwarded).
    cached: usize,
    /// Host time in the prefill forwards (enqueue — no sync).
    prefill_ms: f64,
}

/// Prefill `prompt` into `slot` — already cleared for this request — by
/// its chunk plan (`prefix_cache::plan`). With the cache off, or bypassed,
/// the plan is the `prefill_step` grid: exactly the old
/// `prompt.chunks(step)` loop. With the T1 prefix cache on, the plan also
/// splits at chat turn ends; the longest checkpoint computed through the
/// same boundaries is restored first (so the chunks that follow are the
/// ones the uncached prefill runs: bit-identical), and the plan's
/// checkpoint positions are captured as the prefill passes them. A
/// capture/restore failure never fails the request — it logs and falls
/// back to a full prefill.
fn prefill_slot(
    inner: &mut ModelInner,
    state: &EngineState,
    slot: usize,
    prompt: &[u32],
    sp: &ResolvedSampling,
) -> Result<Prefilled> {
    let device = inner.device.clone();
    let n = prompt.len();
    let step = sp.prefill_step.max(32);
    let ps = &state.prefix_stats;
    let mut clk = PhaseClock::new();
    let mut trace = String::new();
    let t_all = Instant::now();
    let use_cache = inner.prefix.enabled() && n > 1;
    let use_cache = use_cache && {
        let ok = !sp.kv_quant && inner.backend.prefix_capable(slot);
        if !ok {
            ps.bypassed.fetch_add(1, Ordering::Relaxed);
        }
        ok
    };
    let cfg = inner.prefix.config();
    // TH_PREFIX_CACHE=miss: the cache's plan, no restore / capture
    let restore = use_cache && !cfg.plan_only;
    let plan = if use_cache {
        let (first, turn_ends) = match &inner.msg_marks {
            Some(m) => prefix_cache::chat_boundaries(prompt, m),
            None => (None, Vec::new()),
        };
        prefix_cache::plan(n, step, Some(&cfg), first, &turn_ends)
    } else {
        prefix_cache::plan(n, step, None, None, &[])
    };
    let mut pos = 0usize;
    if use_cache {
        // the suffix must be non-empty: its forward yields the logits
        let found = if restore { inner.prefix.lookup(prompt, step, &plan, n - 1) } else { None };
        if let Some((len, entry)) = found {
            let r = if entry.pos() == len {
                inner.backend.prefix_restore(slot, entry)
            } else {
                Err(anyhow::anyhow!("checkpoint at kv {} keyed by {len} tokens", entry.pos()))
            };
            match r {
                Ok(()) => pos = len,
                Err(e) => {
                    ps.errors.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(error = %e, slot, "prefix restore failed — full prefill");
                    inner.backend.clear_kv_cache(slot);
                }
            }
        }
        if pos > 0 {
            ps.hits.fetch_add(1, Ordering::Relaxed);
            ps.reused_tokens.fetch_add(pos as u64, Ordering::Relaxed);
        } else {
            ps.misses.fetch_add(1, Ordering::Relaxed);
        }
        if clk.on {
            trace += &format!(" lookup+restore={:.1}", clk.mark(&device));
        }
    }
    let cached = pos;
    let mut logits = None;
    let mut prefill_ms = 0.0f64;
    // a restored position is one of the plan's splits
    let start = pos;
    let bounds: Vec<usize> =
        plan.splits.iter().copied().chain(std::iter::once(n)).filter(|&b| b > start).collect();
    for end in bounds {
        let t = Instant::now();
        // only the prompt's last chunk needs logits (`TH_PREFILL_HEAD=1`:
        // every chunk computes them — integration-3's forwards, A/B)
        if end < n && !prefill_head_all() {
            inner.backend.forward_slot_nohead(slot, &prompt[pos..end], pos, &device)?;
        } else {
            logits = Some(inner.backend.forward_slot(slot, &prompt[pos..end], pos, &device)?);
        }
        prefill_ms += t.elapsed().as_secs_f64() * 1000.0;
        if clk.on {
            trace += &format!(" [{pos}..{end})={:.1}", clk.mark(&device));
        }
        pos = end;
        if restore
            && plan.checkpoints.contains(&pos)
            && !inner.prefix.contains(&prompt[..pos], step, &plan.history(pos))
        {
            match inner.backend.prefix_capture(slot) {
                Ok(p) => {
                    let bytes = p.bytes();
                    let out = inner.prefix.insert(prompt[..pos].to_vec(), step, plan.history(pos), bytes, p);
                    if out.inserted {
                        ps.inserts.fetch_add(1, Ordering::Relaxed);
                    }
                    ps.evictions.fetch_add(out.evicted as u64, Ordering::Relaxed);
                    ps.entries.store(inner.prefix.len() as u64, Ordering::Relaxed);
                    ps.bytes.store(inner.prefix.bytes() as u64, Ordering::Relaxed);
                }
                Err(e) => {
                    ps.errors.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(error = %e, slot, pos, "prefix capture failed");
                }
            }
            if clk.on {
                trace += &format!(" capture@{pos}={:.1}", clk.mark(&device));
            }
        }
    }
    if clk.on {
        eprintln!(
            "  [prefill] slot={slot} n={n} cached={cached} splits={:?}{trace} total={:.1}ms",
            plan.splits,
            t_all.elapsed().as_secs_f64() * 1000.0
        );
    }
    Ok(Prefilled { logits, cached, prefill_ms })
}

// MARK: - the generation loop

struct ResolvedSampling {
    temperature: Option<f64>,
    top_p: Option<f64>,
    top_k: Option<usize>,
    repeat_penalty: f32,
    repeat_last_n: usize,
    max_tokens: usize,
    prefill_step: usize,
    spec_tokens: usize,
    kv_quant: bool,
    seed: u64,
    max_context: Option<usize>,
    stop: Vec<String>,
}

fn resolve_sampling(req: &RequestSampling, cfg: &EngineConfig) -> ResolvedSampling {
    ResolvedSampling {
        temperature: req.temperature.or(cfg.temperature),
        top_p: req.top_p.or(cfg.top_p),
        top_k: req.top_k.or(cfg.top_k),
        repeat_penalty: req.repeat_penalty.unwrap_or(cfg.repeat_penalty),
        repeat_last_n: cfg.repeat_last_n,
        max_tokens: req.max_tokens.unwrap_or(cfg.max_tokens),
        prefill_step: cfg.prefill_step,
        spec_tokens: cfg.spec_tokens,
        kv_quant: cfg.kv_quant,
        seed: req.seed.unwrap_or(cfg.seed),
        max_context: cfg.max_context,
        stop: req.stop.clone().unwrap_or_default(),
    }
}

fn generate_blocking(
    inner: &Arc<tokio::sync::Mutex<ModelInner>>,
    state: &Arc<EngineState>,
    id: &str,
    messages: Vec<ChatMessage>,
    req: RequestSampling,
    tx: &mpsc::UnboundedSender<GenEvent>,
    started: Instant,
) -> Result<RequestRecord> {
    let cfg = state.config.read().unwrap().clone();
    let sp = resolve_sampling(&req, &cfg);

    // We lock through the tokio mutex from a blocking thread — safe via
    // blocking_lock; serializes all generation.
    let mut inner = inner.blocking_lock();

    let bos = inner.tokenizer.token_to_id("<s>").map(|_| "<s>");
    let prompt = template::render(inner.chat_template.as_deref(), &messages, bos)?;
    let prompt_tokens: Vec<u32> = inner
        .tokenizer
        .encode(prompt.as_str(), false)
        .map_err(|e| anyhow::anyhow!("tokenize: {e}"))?
        .get_ids()
        .to_vec();
    let n_prompt = prompt_tokens.len();

    if let Some(max_ctx) = sp.max_context {
        if n_prompt + sp.max_tokens > max_ctx {
            bail!(
                "prompt ({} tokens) + max_tokens ({}) exceeds max_context ({})",
                n_prompt,
                sp.max_tokens,
                max_ctx
            );
        }
    }

    state.emit(
        "request.start",
        serde_json::json!({"id": id, "prompt_tokens": n_prompt}),
    );

    // kv_quant is live-tunable between requests — the clear right after
    // guarantees a toggle never mixes raw and compressed cache state.
    inner.backend.set_kv_quant(sp.kv_quant)?;
    inner.backend.clear_kv_cache(0);
    let device = inner.device.clone();
    let eos_ids = inner.eos_ids.clone();
    let tokenizer = inner.tokenizer.clone();
    let cancel = Arc::new(AtomicBool::new(false));

    let mut sampler = Sampler::new(&sp, sp.seed.max(1));

    let mut pos = 0usize;
    let mut completion: Vec<u32> = Vec::new();
    let mut text_out = TextOut::default();
    let mut ttft_ms = 0.0f64;
    let mut finish = "stop";
    let mut decode_ms_total = 0.0f64;
    let mut prefill_ms_total = 0.0f64;
    let mut spec_rounds = 0u64;
    let mut spec_accepted = 0u64;

    // --- prefill: chunked forward over the prompt (T1: from the longest
    // cached prefix), sample once at the end
    let pf = prefill_slot(&mut inner, state, 0, &prompt_tokens, &sp)?;
    let last_logits: Option<Tensor> = pf.logits;
    let cached_tokens = pf.cached;
    prefill_ms_total += pf.prefill_ms;
    pos += n_prompt;

    // --- decode loop
    //
    // Invariant: `pending` = logits predicting the token at index `pos`.
    // N-gram speculative decode: after committing a token we search the
    // prompt+completion history for the most recent occurrence of the
    // trailing n-gram and propose its continuation. The target verifies
    // all draft tokens in one batched forward (packed-weights qmm); each
    // emitted token is still sampled from the target's own distribution,
    // so output semantics are unchanged. On a mid-run mismatch we
    // restore the pre-verify snapshot and re-forward the committed run.
    let spec_k = sp.spec_tokens.min(7);
    let spec = spec_k > 0 && inner.backend.spec_capable();
    // adaptive gate: a verify round costs ~1.9x a single-token pass, so
    // it only pays when it commits >= ~2 tokens. EMA of accepted draft
    // tokens per round; drafting pauses while it sits below 1.0.
    let mut accept_ema = 4.0f64;
    let mut hist = prompt_tokens.clone();
    let mut pending: Option<Tensor> = last_logits;
    let mut first = true;
    let mut ec = EmitCtx {
        completion: &mut completion,
        hist: &mut hist,
        text_out: &mut text_out,
        tx,
        tokenizer: &tokenizer,
        eos_ids: &eos_ids,
        stops: &sp.stop,
        cancel: &cancel,
        state,
        max_tokens: sp.max_tokens,
        max_ctx: sp.max_context,
    };

    // --- DFlash block-speculative decode --------------------------------
    //
    // Anchor protocol (Splash Runtime.mm): `pos` counts COMMITTED KV
    // positions; `anchor` is the already-sampled token for position
    // `pos` that has not been forwarded yet. Each round runs the draft
    // block for [anchor, mask x7], verifies [anchor, p1..p7] in one
    // target pass, commits the retained rows' captured hidden states to
    // the draft ring, and leaves the last emitted token pending as the
    // next anchor.
    if inner.backend.has_draft() {
        if let Some(pl) = pending.take() {
            let mut anchor = sampler.sample(
                &pl,
                ec.completion,
                &prompt_tokens,
                sp.repeat_penalty,
                sp.repeat_last_n,
            )?;
            if let Emit::Done(r) = emit_token(&mut ec, anchor, pos) {
                finish = r;
                // the warm-up still runs (main ran it before every first
                // sample): the next request in this slot reads ring rows
                // this one wrote (anchor protocol), so its history must
                // not depend on how this request ended
                inner.backend.draft_prefill(0)?;
            } else {
                // `pos` stays = committed KV count: the anchor sampled for
                // position `pos` is forwarded by the first verify (it is
                // row 0 of [anchor, p1..p7]). Advancing here ran every
                // verify/draft/commit one position late — a never-written
                // KV row (and a never-committed draft ring slot) at the
                // prompt end, and RoPE +1 on every generated token.
                if first {
                    first = false;
                    ttft_ms = started.elapsed().as_secs_f64() * 1000.0;
                    if tx.send(GenEvent::FirstToken { ttft_ms }).is_err() {
                        finish = "cancelled";
                    }
                }
                // warm the ring from the prefill captures only now: the
                // first token needs just the prefill logits, the ring is
                // first read by round 1's propose (same kernels, same
                // inputs — only the host order moves). The sync keeps the
                // warm-up out of round 1's timing.
                let mut clk = PhaseClock::new();
                inner.backend.draft_prefill(0)?;
                device.synchronize()?;
                if clk.on {
                    eprintln!("  [prefill] draft_warmup={:.1}ms", clk.mark(&device));
                }
                'dflash: while finish == "stop" {
                    if cancel.load(Ordering::Relaxed) {
                        finish = "cancelled";
                        break;
                    }
                    let t0 = Instant::now();
                    // L1: verify every proposal (8 rows) — see
                    // `verify_adaptive`. The legacy rule caps the chain
                    // at the accept EMA + 1 headroom (2..=7).
                    let verify_len = dflash_verify_len(verify_adaptive(), accept_ema);
                    let dsamp = sampler.draft_sampling();
                    let prop = inner.backend.draft_propose(
                        0,
                        anchor,
                        pos,
                        dsamp,
                        || sampler.next_f64(),
                    )?;
                    let t_prop = t0.elapsed();
                    let mut seq = Vec::with_capacity(1 + verify_len);
                    seq.push(anchor);
                    seq.extend_from_slice(&prop.tokens[..verify_len]);
                    let snap = inner.backend.snapshot(0)?;
                    let logits_m =
                        inner.backend.forward_multi(&seq, pos, &device)?;
                    let t_fwd_enqueue = t0.elapsed();
                    let caps = inner.backend.take_captures(0)?;
                    // greedy needs only the argmax per row — a [n+1] u32
                    // readback instead of [n+1, vocab] bf16 (~4.5MB).
                    // S1: sampled rows are accepted on the GPU — a 16-word
                    // result block (`sample_kernel`); either readback is
                    // the round's verify sync.
                    let greedy = greedy_rows(&sampler, &sp);
                    let mut argmax_rows: Vec<u32> = Vec::new();
                    let mut chain: Option<crate::sample_kernel::ChainOut> = None;
                    if greedy {
                        argmax_rows =
                            logits_m.argmax(candle_core::D::Minus1)?.to_vec1::<u32>()?;
                    } else if let Some(pol) = gpu_policy(&sampler, &sp, &device) {
                        let (res, st0) = gpu_accept_encode(
                            &mut sampler, &logits_m, 0, &pol, &prop, verify_len,
                        )?;
                        chain = gpu_accept_finish(
                            &mut sampler,
                            &res,
                            st0,
                            &logits_m,
                            0,
                            &prop,
                            verify_len,
                            ec.completion,
                            &prompt_tokens,
                            sp.repeat_penalty,
                            sp.repeat_last_n,
                        )?;
                    }
                    // CPU reference path (TH_SAMPLE=cpu, penalty or top-k
                    // the kernel does not serve, pool overflow): read the
                    // rows back here, accept after the verify timer (in
                    // `rest`, as before S1)
                    let rows: Option<Vec<Vec<half::bf16>>> = if !greedy && chain.is_none() {
                        Some(logits_m.to_vec2()?)
                    } else {
                        None
                    };
                    let t_verify = t0.elapsed();
                    if debug_timing() {
                        eprintln!(
                            "  [verify] enqueue={:.1}ms gpu+readback={:.1}ms",
                            t_fwd_enqueue.as_secs_f64() * 1e3,
                            (t_verify - t_fwd_enqueue).as_secs_f64() * 1e3,
                        );
                    }
                    if let Some(rows) = rows.as_ref() {
                        if accept_stats() {
                            eprintln!(
                                "{}",
                                accept_stats_line(
                                    &sampler,
                                    rows,
                                    &prop,
                                    verify_len,
                                    ec.completion,
                                    &prompt_tokens,
                                    sp.repeat_penalty,
                                    sp.repeat_last_n,
                                )
                            );
                        }
                        chain = Some(cpu_accept(
                            &mut sampler,
                            rows,
                            &prop,
                            verify_len,
                            ec.completion,
                            &prompt_tokens,
                            sp.repeat_penalty,
                            sp.repeat_last_n,
                        ));
                    }
                    let mut emitted: Vec<u32> = Vec::with_capacity(8);
                    let mut accepted = 0usize;
                    if greedy {
                        for i in 0..verify_len {
                            let t = argmax_rows[i];
                            emitted.push(t);
                            if t == prop.tokens[i] {
                                accepted += 1;
                            } else {
                                break;
                            }
                        }
                        if accepted == verify_len {
                            emitted.push(argmax_rows[verify_len]);
                        }
                    } else if let Some(c) = chain {
                        emitted = c.emitted;
                        accepted = c.accepted;
                    }
                    let retained = emitted.len();
                    for (i, &t) in emitted.iter().enumerate() {
                        if let Emit::Done(r) =
                            emit_token(&mut ec, t, pos + 1 + i)
                        {
                            finish = r;
                            break 'dflash;
                        }
                    }
                    if let Some(c) = caps.as_ref() {
                        inner.backend.draft_commit(
                            0,
                            &c.narrow(0, 0, retained)?,
                            pos,
                            retained,
                        )?;
                    }
                    if retained < seq.len() {
                        // rollback the speculative tail, re-applying only
                        // the committed rows from cached scan inputs —
                        // no full model re-forward
                        inner.backend.rollback_verify(0, snap, retained)?;
                    }
                    pos += retained;
                    spec_rounds += 1;
                    spec_accepted += accepted as u64;
                    accept_ema += 0.25 * (accepted as f64 - accept_ema);
                    if accepted == verify_len {
                        // chain could have run deeper — widen next round
                        accept_ema += 0.6;
                    }
                    accept_ema = accept_ema.clamp(0.0, 7.0);
                    anchor = emitted[retained - 1];
                    let step_ms = t0.elapsed().as_secs_f64() * 1000.0;
                    decode_ms_total += step_ms;
                    state.counters.observe_decode(step_ms);
                    if debug_timing() {
                        eprintln!(
                            "[dflash] anchor={anchor} prop={:?} emitted={emitted:?} acc={accepted} step={step_ms:.1}ms propose={:.0} verify={:.0} rest={:.0} vlen={verify_len} prop_ms={:.2}",
                            prop.tokens,
                            t_prop.as_secs_f64() * 1e3,
                            (t_verify - t_prop).as_secs_f64() * 1e3,
                            (t0.elapsed() - t_verify).as_secs_f64() * 1e3,
                            t_prop.as_secs_f64() * 1e3,
                        );
                    }
                }
            }
        }
    }

    if !inner.backend.has_draft() {
    'outer: loop {
        if cancel.load(Ordering::Relaxed) {
            finish = "cancelled";
            break;
        }
        let Some(pl) = pending.take() else {
            break;
        };
        let base_pos = pos;
        let t0 = Instant::now();
        let tok = sampler.sample(
            &pl,
            ec.completion,
            &prompt_tokens,
            sp.repeat_penalty,
            sp.repeat_last_n,
        )?;
        let mut step_ms = t0.elapsed().as_secs_f64() * 1000.0;

        if let Emit::Done(r) = emit_token(&mut ec, tok, base_pos) {
            finish = r;
            break;
        }
        pos = base_pos + 1;
        if first {
            first = false;
            ttft_ms = started.elapsed().as_secs_f64() * 1000.0;
            if tx.send(GenEvent::FirstToken { ttft_ms }).is_err() {
                finish = "cancelled";
                break;
            }
        }

        let draft = if spec && accept_ema >= 1.0 {
            ngram_draft(ec.hist, spec_k)
        } else {
            Vec::new()
        };
        if !draft.is_empty() {
            let snap = inner.backend.snapshot(0)?;
            let mut seq = Vec::with_capacity(draft.len() + 1);
            seq.push(tok);
            seq.extend_from_slice(&draft);
            let t = Instant::now();
            let logits_m =
                inner.backend.forward_multi(&seq, base_pos, &device)?;
            let mut committed: Vec<u32> = vec![tok];
            let mut mismatch = false;
            for j in 1..=draft.len() {
                let cj = sampler.sample(
                    &logits_m.i(j - 1)?,
                    ec.completion,
                    &prompt_tokens,
                    sp.repeat_penalty,
                    sp.repeat_last_n,
                )?;
                let commit = if cj == draft[j - 1] {
                    spec_accepted += 1;
                    draft[j - 1]
                } else {
                    mismatch = true;
                    cj
                };
                committed.push(commit);
                if let Emit::Done(r) =
                    emit_token(&mut ec, commit, base_pos + committed.len() - 1)
                {
                    finish = r;
                    break 'outer;
                }
                if mismatch {
                    break;
                }
            }
            spec_rounds += 1;
            let accepted = (committed.len() - 1) as f64 - mismatch as u8 as f64;
            accept_ema += 0.3 * (accepted - accept_ema);
            let verify_ms = t.elapsed().as_secs_f64() * 1000.0;
            step_ms += verify_ms;
            pos = base_pos + committed.len();
            let mut refwd_ms = 0.0;
            if mismatch {
                // rollback verify-state, re-forward the committed run in
                // one batched pass — its last logits row is the pending
                let tr = Instant::now();
                inner.backend.restore(0, snap)?;
                let lg = inner
                    .backend
                    .forward_multi(&committed, base_pos, &device)?;
                refwd_ms = tr.elapsed().as_secs_f64() * 1000.0;
                step_ms += refwd_ms;
                pending = Some(lg.i(committed.len() - 1)?);
            } else {
                pending = Some(logits_m.i(committed.len() - 1)?);
            }
            decode_ms_total += step_ms;
            state.counters.observe_decode(step_ms);
            if debug_timing() {
                eprintln!(
                    "[spec] draft={} committed={} verify={:.1}ms refwd={:.1}ms",
                    draft.len(),
                    committed.len(),
                    verify_ms,
                    refwd_ms
                );
            }
            continue;
        }

        // plain single-token step; drift the gate back up so drafting
        // is retried if the text turns repetitive later
        accept_ema += 0.02 * (1.5 - accept_ema);
        let t = Instant::now();
        let logits = inner.backend.forward(&[tok], base_pos, &device)?;
        let fwd_ms = t.elapsed().as_secs_f64() * 1000.0;
        let ts = Instant::now();
        pending = Some(logits);
        step_ms += t.elapsed().as_secs_f64() * 1000.0;
        decode_ms_total += step_ms;
        state.counters.observe_decode(step_ms);
        if debug_timing() {
            eprintln!(
                "[tok] fwd={:.1}ms sample={:.1}ms",
                fwd_ms,
                step_ms - ts.elapsed().as_secs_f64() * 1000.0 - fwd_ms
            );
        }
    }
    }

    sample_check_summary();
    let total_ms = started.elapsed().as_secs_f64() * 1000.0;
    let n_completion = completion.len();
    let decode_tps = if n_completion > 1 && decode_ms_total > 0.0 {
        (n_completion - 1) as f64 / (decode_ms_total / 1000.0)
    } else {
        0.0
    };
    // T1: rate over the tokens actually forwarded (== n_prompt uncached)
    let prefilled = n_prompt - cached_tokens;
    let prefill_tps = if prefilled > 0 && prefill_ms_total > 0.0 {
        prefilled as f64 / (prefill_ms_total / 1000.0)
    } else {
        0.0
    };

    state
        .counters
        .prompt_tokens_total
        .fetch_add(n_prompt as u64, Ordering::Relaxed);
    state
        .counters
        .completion_tokens_total
        .fetch_add(n_completion as u64, Ordering::Relaxed);

    let stats = DoneStats {
        prompt_tokens: n_prompt,
        completion_tokens: n_completion,
        ttft_ms,
        total_ms,
        decode_tps,
        prefill_tps,
        finish: finish.to_string(),
        spec_rounds,
        spec_accepted,
        cached_tokens,
    };
    let _ = tx.send(GenEvent::Done(Box::new(stats)));

    Ok(RequestRecord {
        id: id.to_string(),
        started_ms: state.started.elapsed().as_millis() as u64,
        prompt_tokens: n_prompt,
        completion_tokens: n_completion,
        ttft_ms,
        total_ms,
        decode_tps,
        finish: finish.to_string(),
        cached_tokens,
    })
}

/// Per-request sampling policy + RNG. Candidate filtering, draws and the
/// DFlash acceptance chain live in `sample_kernel` (S1): one arithmetic
/// shared by the GPU kernels (`ts_topk` / `ts_accept`) and the CPU
/// reference path (`TH_SAMPLE=cpu`, repeat-penalty and top-k > 32
/// requests, the prefill anchor and the non-draft decode loop).
#[derive(Clone)]
struct Sampler {
    temperature: Option<f64>,
    top_k: Option<usize>,
    top_p: Option<f64>,
    rng: u64,
    /// The request's policy is one the GPU accept kernel serves (top-k
    /// 1..=KMAX, no repeat penalty) — decided by the request alone, not by
    /// the execution path, so `TH_SAMPLE=cpu` / `check` replay the same
    /// verification rule (B1 default, `spec_verify_rule`).
    gpu_servable: bool,
}

impl Sampler {
    fn new(sp: &ResolvedSampling, seed: u64) -> Self {
        Self {
            temperature: sp.temperature.filter(|t| *t > 0.0),
            top_k: sp.top_k,
            top_p: sp.top_p,
            rng: seed | 1,
            gpu_servable: gpu_servable_request(sp),
        }
    }

    /// Draft proposal policy for this request: `None` = greedy chaining;
    /// sampled requests chain at the request temperature and, with
    /// `draft_filter()`, draw from the draft distribution after the
    /// request's own top-k / top-p (R0b).
    fn draft_sampling(&self) -> Option<crate::dflash::DraftSampling> {
        self.temperature.map(|t| {
            let f = draft_filter();
            crate::dflash::DraftSampling {
                temp: t,
                top_k: if f { self.top_k.unwrap_or(0) } else { 0 },
                top_p: if f { self.top_p.unwrap_or(1.0) } else { 1.0 },
            }
        })
    }

    /// xorshift64* step.
    #[inline]
    fn step(&mut self) -> u64 {
        let mut x = self.rng;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// 53-bit uniform in [0, 1) — the draft walk's proposal draws.
    #[inline]
    fn next_f64(&mut self) -> f64 {
        (self.step() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// 24-bit uniform in [0, 1) — target draws and acceptance tests (the
    /// GPU kernel consumes the same values, staged by the host). One
    /// stream step per draw, like `next_f64`.
    #[inline]
    fn next_u24(&mut self) -> f32 {
        ((self.step() >> 40) as f32) * (1.0 / 16_777_216.0)
    }

    /// Advance the stream by `n` draws (the GPU consumed `n` staged uniforms).
    fn advance(&mut self, n: usize) {
        for _ in 0..n {
            self.step();
        }
    }

    /// Target policy of a sampled request (`None` = greedy).
    fn policy(&self) -> Option<crate::sample_kernel::Policy> {
        self.temperature.map(|t| crate::sample_kernel::Policy {
            k: self.top_k.unwrap_or(0),
            inv_t: 1.0 / t as f32,
            top_p: self.top_p.map(|p| p as f32).unwrap_or(1.0),
            renorm: top_p_renorm(),
            block: spec_verify_rule(spec_verify_forced(), self.gpu_servable),
        })
    }

    /// One token from a `[vocab]` logits tensor (prefill anchor, plain
    /// and n-gram decode): repeat penalty, then greedy argmax or one draw
    /// from the filtered target distribution.
    fn sample(
        &mut self,
        logits: &Tensor,
        completion: &[u32],
        prompt: &[u32],
        repeat_penalty: f32,
        repeat_last_n: usize,
    ) -> Result<u32> {
        let l = if logits.dtype() == DType::F32 {
            logits.to_vec1::<f32>()?
        } else {
            logits.to_dtype(DType::F32)?.to_vec1::<f32>()?
        };
        let d = row_dist_of(self.policy(), l, completion, prompt, repeat_penalty, repeat_last_n);
        Ok(if d.deterministic() {
            d.ids[0]
        } else {
            let u = self.next_u24();
            crate::sample_kernel::sample_dist(&d, u)
        })
    }
}

/// Repeat penalty over the last `repeat_last_n` context tokens, in place.
fn apply_repeat_penalty(
    l: &mut [f32],
    completion: &[u32],
    prompt: &[u32],
    repeat_penalty: f32,
    repeat_last_n: usize,
) {
    if (repeat_penalty - 1.0).abs() <= f32::EPSILON {
        return;
    }
    for &tid in prompt.iter().chain(completion.iter()).rev().take(repeat_last_n) {
        let i = tid as usize;
        if i < l.len() {
            l[i] = if l[i] < 0.0 { l[i] * repeat_penalty } else { l[i] / repeat_penalty };
        }
    }
}

/// One row's filtered target distribution: repeat penalty, then the greedy
/// argmax (N2 tie rule) or `sample_kernel::cpu_row_dist`.
fn row_dist_of(
    pol: Option<crate::sample_kernel::Policy>,
    mut l: Vec<f32>,
    completion: &[u32],
    prompt: &[u32],
    repeat_penalty: f32,
    repeat_last_n: usize,
) -> crate::sample_kernel::RowDist {
    apply_repeat_penalty(&mut l, completion, prompt, repeat_penalty, repeat_last_n);
    match pol {
        None => crate::sample_kernel::RowDist::single(greedy_argmax(&l)),
        Some(p) => crate::sample_kernel::cpu_row_dist(&l, &p),
    }
}

/// CPU acceptance of one round over read-back verify rows: the reference
/// of the GPU path (`TH_SAMPLE=cpu`, its overflow fallback, and requests
/// the kernel does not serve — repeat penalty, top-k 0 or > 32).
#[allow(clippy::too_many_arguments)]
fn cpu_accept(
    sampler: &mut Sampler,
    rows: &[Vec<half::bf16>],
    prop: &crate::dflash::Proposal,
    vlen: usize,
    completion: &[u32],
    prompt: &[u32],
    repeat_penalty: f32,
    repeat_last_n: usize,
) -> crate::sample_kernel::ChainOut {
    let pol = sampler.policy();
    let mut rowf = |i: usize| {
        row_dist_of(
            pol,
            rows[i].iter().map(|v| v.to_f32()).collect(),
            completion,
            prompt,
            repeat_penalty,
            repeat_last_n,
        )
    };
    let mut draw = || sampler.next_u24();
    match pol {
        Some(p) if p.block => crate::sample_kernel::accept_block(&mut rowf, prop, vlen, &mut draw),
        _ => crate::sample_kernel::accept_chain(&mut rowf, prop, vlen, &mut draw),
    }
}

/// S1 — `TH_SAMPLE` (read once): `gpu` (default) = sampled acceptance on
/// the GPU; `cpu` = the CPU reference over read-back logits (the
/// historical data flow); `check` = both each round, from the same RNG
/// state, logging any difference (`[samplecheck]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SampleMode {
    Gpu,
    Cpu,
    Check,
}

fn sample_mode() -> SampleMode {
    static V: std::sync::OnceLock<SampleMode> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        let m = match std::env::var("TH_SAMPLE").ok().as_deref().map(str::trim) {
            Some("cpu") => SampleMode::Cpu,
            Some("check") => SampleMode::Check,
            _ => SampleMode::Gpu,
        };
        tracing::info!(mode = ?m, "sampled acceptance (TH_SAMPLE)");
        m
    })
}

/// The GPU policy of a sampled slot, or `None` when the CPU path serves it
/// (greedy, repeat penalty, top-k 0 or > KMAX, TH_SAMPLE=cpu, stats, or a
/// non-Metal device).
fn gpu_policy(
    sampler: &Sampler,
    sp: &ResolvedSampling,
    dev: &candle_core::Device,
) -> Option<crate::sample_kernel::Policy> {
    if !cfg!(all(feature = "metal", target_os = "macos"))
        || !dev.is_metal()
        || sample_mode() == SampleMode::Cpu
        || accept_stats()
    {
        return None;
    }
    if (sp.repeat_penalty - 1.0).abs() > f32::EPSILON && sp.repeat_last_n > 0 {
        return None;
    }
    sampler.policy().filter(|p| p.gpu_ok())
}

/// Stage the next `NU` uniforms (without advancing the stream) and encode
/// the GPU acceptance of one slot. Returns the result tensor and the
/// stream state to resume from.
fn gpu_accept_encode(
    sampler: &mut Sampler,
    logits: &Tensor,
    row0: usize,
    pol: &crate::sample_kernel::Policy,
    prop: &crate::dflash::Proposal,
    vlen: usize,
) -> Result<(Tensor, u64)> {
    let st0 = sampler.rng;
    let us: [f32; crate::sample_kernel::NU] = std::array::from_fn(|_| sampler.next_u24());
    sampler.rng = st0;
    Ok((crate::sample_kernel::gpu_accept(logits, row0, pol, prop, vlen, &us)?, st0))
}

static CHECK_ROUNDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CHECK_MISMATCHES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Read back a GPU acceptance (the round's sync) and advance the stream by
/// the uniforms it consumed; `None` = candidate-pool overflow, run the CPU
/// path from the same state. `TH_SAMPLE=check` replays the CPU reference
/// from `st0` over read-back rows and logs any difference.
#[allow(clippy::too_many_arguments)]
fn gpu_accept_finish(
    sampler: &mut Sampler,
    res: &Tensor,
    st0: u64,
    logits: &Tensor,
    row0: usize,
    prop: &crate::dflash::Proposal,
    vlen: usize,
    completion: &[u32],
    prompt: &[u32],
    repeat_penalty: f32,
    repeat_last_n: usize,
) -> Result<Option<crate::sample_kernel::ChainOut>> {
    let v: Vec<u32> = res.to_vec1()?;
    sampler.rng = st0;
    let out = crate::sample_kernel::decode_result(&v);
    if sample_mode() == SampleMode::Check {
        let rows: Vec<Vec<half::bf16>> = logits.narrow(0, row0, vlen + 1)?.to_vec2()?;
        let mut reference = sampler.clone();
        let cpu = cpu_accept(&mut reference, &rows, prop, vlen, completion, prompt, repeat_penalty, repeat_last_n);
        let n = CHECK_ROUNDS.fetch_add(1, Ordering::Relaxed) + 1;
        if out.as_ref() != Some(&cpu) {
            let m = CHECK_MISMATCHES.fetch_add(1, Ordering::Relaxed) + 1;
            eprintln!("[samplecheck] MISMATCH round={n} gpu={out:?} cpu={cpu:?} mismatches={m}");
        }
    }
    if let Some(o) = &out {
        sampler.advance(o.consumed);
    }
    Ok(out)
}

/// `TH_SAMPLE=check` running totals (printed at request end).
fn sample_check_summary() {
    if sample_mode() == SampleMode::Check {
        eprintln!(
            "[samplecheck] rounds={} mismatches={}",
            CHECK_ROUNDS.load(Ordering::Relaxed),
            CHECK_MISMATCHES.load(Ordering::Relaxed)
        );
    }
}

/// `TH_TOP_P` (read once): `renorm` = Splash / HF / vLLM / llama.cpp
/// top-k→top-p semantics (top-p over the top-k set renormalised); unset
/// or `global` = candle's TopKThenTopP rule (cumulative mass measured
/// against the full-vocab partition, which keeps a longer tail).
fn top_p_renorm() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        let v = std::env::var("TH_TOP_P").ok();
        let on = matches!(v.as_deref().map(str::trim), Some("renorm" | "splash" | "hf"));
        tracing::info!(semantics = if on { "renorm (top-k set)" } else { "global (candle)" }, "top-p semantics (TH_TOP_P)");
        on
    })
}

/// B1 — `TH_SPEC_VERIFY` (read once): `block` / `token` force block
/// verification (`sample_kernel::accept_block`) or the token-by-token rule
/// (Splash's) for every sampled DFlash round; unset = `spec_verify_rule`'s
/// default. Both rules emit the target's distribution; block verification
/// accepts at least as many tokens in expectation. T=0 never reaches
/// either rule.
fn spec_verify_forced() -> Option<bool> {
    static V: std::sync::OnceLock<Option<bool>> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        let v = std::env::var("TH_SPEC_VERIFY").ok();
        let f = match v.as_deref().map(str::trim) {
            Some("block") => Some(true),
            Some("token") => Some(false),
            _ => None,
        };
        tracing::info!(
            rule = match f { Some(true) => "block", Some(false) => "token", None => "auto (block where the GPU kernel serves the request)" },
            "sampled DFlash verification (TH_SPEC_VERIFY)"
        );
        f
    })
}

/// The verification rule of one sampled request: the forced rule, else
/// block verification when the GPU kernel serves the request (R0b: +0.9%
/// tokens/round on the same drafted blocks, 95% CI [0.4%, 1.4%]; the
/// extra `ts_accept` work is a few µs of one thread) and the token rule
/// otherwise — on the CPU path the block rule needs all 8 row
/// distributions (~0.8 ms each) where the token rule stops at the first
/// rejection (~4.1 rows on average), which costs more than it gains.
fn spec_verify_rule(forced: Option<bool>, gpu_servable: bool) -> bool {
    forced.unwrap_or(gpu_servable)
}

/// A request whose sampled rounds the GPU accept kernel serves (see
/// `gpu_policy`: top-k 1..=KMAX and no repeat penalty in effect).
fn gpu_servable_request(sp: &ResolvedSampling) -> bool {
    let penalty = (sp.repeat_penalty - 1.0).abs() > f32::EPSILON && sp.repeat_last_n > 0;
    !penalty && sp.top_k.is_some_and(|k| k >= 1 && k <= crate::sample_kernel::KMAX)
}

/// `TH_DRAFT_FILTER` (read once): `1` = apply the request's top-k / top-p
/// to the draft's 16-candidate distribution before each proposal is
/// drawn (the acceptance ratio uses the filtered q, so the output
/// distribution is unchanged — speculative sampling is exact for any
/// proposal distribution).
fn draft_filter() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        let on = std::env::var("TH_DRAFT_FILTER").is_ok_and(|v| !v.is_empty() && v != "0");
        tracing::info!(on, "draft proposal filter (TH_DRAFT_FILTER)");
        on
    })
}

/// `TH_ACCEPT_STATS=1` (read once): per sampled DFlash round, log the
/// Rao-Blackwellised acceptance of the round's draft block under both
/// top-p semantics — R0b's paired, trajectory-free comparison. Debug
/// only: it forces the CPU path and costs 2 x 7 full-vocab
/// distributions per round.
fn accept_stats() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("TH_ACCEPT_STATS").is_ok_and(|v| !v.is_empty() && v != "0"))
}

/// R0b `[accstats]` line for one sampled round (see `accept_stats`):
/// per verified position i, a = min(1, p(d_i)/q(d_i)) for the draft's
/// actual token and alpha = sum_x min(p(x), q(x)) (the acceptance
/// probability had d_i been redrawn), under the global (g) and renorm
/// (r) top-p semantics; af = alpha had the draft drawn from its
/// target-filtered q'; e = sum_i prod_{j<=i} a_j = E[accepted | block];
/// eb = E[accepted | block] under block verification (B1), same block.
#[allow(clippy::too_many_arguments)]
fn accept_stats_line(
    sampler: &Sampler,
    rows: &[Vec<half::bf16>],
    prop: &crate::dflash::Proposal,
    vlen: usize,
    completion: &[u32],
    prompt: &[u32],
    repeat_penalty: f32,
    repeat_last_n: usize,
) -> String {
    let Some(pol) = sampler.policy() else {
        return String::new();
    };
    let pg = crate::sample_kernel::Policy { renorm: false, ..pol };
    let pr = crate::sample_kernel::Policy { renorm: true, ..pol };
    let (mut ag, mut ar, mut alg, mut alr) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut kg, mut kr) = (Vec::new(), Vec::new());
    let (mut afg, mut afr) = (Vec::new(), Vec::new());
    // B1: per-position target / draft distributions for the block rule
    let (mut plg, mut plr, mut ql) = (Vec::new(), Vec::new(), Vec::new());
    for i in 0..vlen.min(rows.len()) {
        let l: Vec<f32> = rows[i].iter().map(|v| v.to_f32()).collect();
        let dg = row_dist_of(Some(pg), l.clone(), completion, prompt, repeat_penalty, repeat_last_n).probs();
        let dr = row_dist_of(Some(pr), l, completion, prompt, repeat_penalty, repeat_last_n).probs();
        let q = |id: u32| {
            prop.cand_ids[i]
                .iter()
                .position(|c| *c == id)
                .map(|j| prop.cand_probs[i][j])
                .unwrap_or(0.0)
        };
        let p_of = |d: &[(u32, f32)], id: u32| {
            d.iter().find(|(x, _)| *x == id).map(|(_, p)| *p).unwrap_or(0.0)
        };
        let want = prop.tokens[i];
        let a = |d: &[(u32, f32)]| {
            let (p, qq) = (p_of(d, want), q(want));
            if d.len() == 1 {
                (d[0].0 == want) as u8 as f32
            } else if p > 0.0 && qq > 0.0 {
                (p / qq).min(1.0)
            } else {
                0.0
            }
        };
        let overlap = |d: &[(u32, f32)]| d.iter().map(|&(id, p)| p.min(q(id))).sum::<f32>();
        // overlap had the draft drawn from its target-filtered q'
        let mut qf = prop.cand_probs[i];
        crate::dflash::filter_q(&mut qf, sampler.top_k.unwrap_or(0), sampler.top_p.unwrap_or(1.0));
        let qfo = |id: u32| {
            prop.cand_ids[i].iter().position(|c| *c == id).map(|j| qf[j]).unwrap_or(0.0)
        };
        let overlap_f = |d: &[(u32, f32)]| d.iter().map(|&(id, p)| p.min(qfo(id))).sum::<f32>();
        afg.push(overlap_f(&dg));
        afr.push(overlap_f(&dr));
        ag.push(a(&dg));
        ar.push(a(&dr));
        alg.push(overlap(&dg));
        alr.push(overlap(&dr));
        kg.push(dg.len());
        kr.push(dr.len());
        let f64l = |d: &[(u32, f32)]| d.iter().map(|&(id, p)| (id, p as f64)).collect::<Vec<_>>();
        plg.push(f64l(&dg));
        plr.push(f64l(&dr));
        let mut seen = std::collections::HashSet::new();
        ql.push(
            (0..crate::dflash::TOPK)
                .filter(|&j| seen.insert(prop.cand_ids[i][j]))
                .map(|j| (prop.cand_ids[i][j], prop.cand_probs[i][j] as f64))
                .collect::<Vec<_>>(),
        );
    }
    let xs = &prop.tokens[..plg.len()];
    let ebg = crate::sample_kernel::expected_accepted_block(&crate::sample_kernel::block_h_f64(&plg, &ql, xs).1);
    let ebr = crate::sample_kernel::expected_accepted_block(&crate::sample_kernel::block_h_f64(&plr, &ql, xs).1);
    let e = |a: &[f32]| {
        let (mut prod, mut s) = (1.0f32, 0.0f32);
        for &x in a {
            prod *= x;
            s += prod;
        }
        s
    };
    let f = |v: &[f32]| v.iter().map(|x| format!("{x:.3}")).collect::<Vec<_>>().join(",");
    let u = |v: &[usize]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",");
    format!(
        "[accstats] eg={:.4} er={:.4} ag=[{}] ar=[{}] alg=[{}] alr=[{}] kg=[{}] kr=[{}] afg=[{}] afr=[{}] ebg={:.4} ebr={:.4}",
        e(&ag), e(&ar), f(&ag), f(&ar), f(&alg), f(&alr), u(&kg), u(&kr), f(&afg), f(&afr), ebg, ebr
    )
}

/// Greedy pick with the same tie rule as candle's Metal (and CPU)
/// arg-reduce and Splash's argmax kernel: the LOWEST index among equal
/// maxima (strict `>` scan; NaN never wins, all -inf -> 0). The DFlash
/// greedy verify reads `Tensor::argmax` rows on the GPU, while the
/// anchor, the non-draft loop, penalty requests and sampled batches come
/// through `Sampler::dist_vec` — `Iterator::max_by` returned the LAST
/// maximum there, so exact bf16 ties (ulp 0.125 in [16, 32)) picked
/// different tokens per path (N2).
fn greedy_argmax(l: &[f32]) -> u32 {
    let mut best = (0u32, f32::NEG_INFINITY);
    for (i, &v) in l.iter().enumerate() {
        if v > best.1 {
            best = (i as u32, v);
        }
    }
    best.0
}

/// A slot whose verify rows need only the per-row argmax: no temperature
/// and no repeat penalty in effect (`dist_vec` would otherwise reshape
/// the logits first).
fn greedy_rows(sampler: &Sampler, sp: &ResolvedSampling) -> bool {
    sampler.temperature.is_none()
        && ((sp.repeat_penalty - 1.0).abs() < f32::EPSILON || sp.repeat_last_n == 0)
}

/// Byte offset of the earliest stop-string match in `text` that was not
/// already checked. Bytes before `checked` were scanned on earlier
/// tokens and held no match, so a new one must end past `checked`.
fn find_stop(text: &str, checked: usize, stops: &[String]) -> Option<usize> {
    stops
        .iter()
        .filter(|s| !s.is_empty())
        .filter_map(|s| {
            let mut from = checked.saturating_sub(s.len() - 1);
            while !text.is_char_boundary(from) {
                from -= 1;
            }
            text[from..].find(s.as_str()).map(|i| from + i)
        })
        .min()
}

/// Length of the longest suffix of `text` that is a proper prefix of a
/// stop string. That tail is held back so a stop sequence split across
/// tokens never streams its first half.
fn stop_holdback(text: &str, stops: &[String]) -> usize {
    stops
        .iter()
        .filter_map(|s| {
            (1..s.len())
                .rev()
                .find(|&k| s.is_char_boundary(k) && text.ends_with(&s[..k]))
        })
        .max()
        .unwrap_or(0)
}

// MARK: - emit + n-gram draft

enum Emit {
    More,
    Done(&'static str),
}

/// Completion text plus the incremental-detokenizer cursor into
/// `EmitCtx::completion`.
///
/// A byte-level BPE token can end part-way through a UTF-8 character
/// (CJK, emoji), so decoding one token at a time streams U+FFFD halves.
/// Instead each step decodes `completion[prefix..]` and keeps only what
/// lies beyond `prefix_text` (= decode of `completion[prefix..read]`),
/// holding it back while it still ends in U+FFFD. This is the TGI /
/// `tokenizers::DecodeStream` prefix/read-offset scheme. The left
/// context also stops prefix-sensitive decoders (SentencePiece `Strip`)
/// from eating a token's leading space. Only offsets are stored, so the
/// state survives a fresh `EmitCtx` per token.
#[derive(Default)]
struct TextOut {
    /// Decoded completion text, i.e. what stop matching sees. Truncated
    /// at the stop string when one hits.
    text: String,
    /// Bytes of `text` already sent as `GenEvent::Delta`s.
    sent: usize,
    prefix: usize,
    read: usize,
    prefix_text: String,
}

impl TextOut {
    /// Fold `ids[read..]` into `text`. A window that still ends in U+FFFD
    /// (an incomplete UTF-8 sequence) waits for more ids unless `flush`
    /// (end of stream) forces it out as decoded.
    fn advance(&mut self, tok: &tokenizers::Tokenizer, ids: &[u32], flush: bool) {
        if self.read >= ids.len() {
            return;
        }
        let window = tok.decode(&ids[self.prefix..], true).unwrap_or_default();
        if !flush && (window.len() <= self.prefix_text.len() || window.ends_with('\u{FFFD}')) {
            return;
        }
        match window.strip_prefix(self.prefix_text.as_str()) {
            Some(new) => self.text.push_str(new),
            // decoder not prefix-stable here: the new ids on their own
            None => self
                .text
                .push_str(&tok.decode(&ids[self.read..], true).unwrap_or_default()),
        }
        self.prefix = self.read;
        self.read = ids.len();
        self.prefix_text = tok.decode(&ids[self.prefix..], true).unwrap_or_default();
    }
}

/// Everything `emit_token` needs — bundled so the decode loop stays
/// readable.
struct EmitCtx<'a> {
    completion: &'a mut Vec<u32>,
    hist: &'a mut Vec<u32>,
    text_out: &'a mut TextOut,
    tx: &'a mpsc::UnboundedSender<GenEvent>,
    tokenizer: &'a tokenizers::Tokenizer,
    eos_ids: &'a [u32],
    stops: &'a [String],
    cancel: &'a AtomicBool,
    state: &'a EngineState,
    max_tokens: usize,
    max_ctx: Option<usize>,
}

/// Commit one token: record it, stream whatever text it completes, and
/// apply stop rules. `pos` is the token's absolute KV index.
///
/// Deltas carry only whole characters. The final token of a stream (EOS,
/// length) flushes anything held back, so the concatenated deltas equal
/// `decode(completion)` cut at the first stop string (which is not sent).
fn emit_token(c: &mut EmitCtx, tok: u32, pos: usize) -> Emit {
    c.completion.push(tok);
    c.hist.push(tok);
    c.state.kv_tokens.store((pos + 1) as u64, Ordering::Relaxed);
    if c.cancel.load(Ordering::Relaxed) {
        return Emit::Done("cancelled");
    }
    let eos = c.eos_ids.contains(&tok);
    let mut finish = if eos {
        Some("stop")
    } else if c.completion.len() >= c.max_tokens || c.max_ctx.is_some_and(|m| pos + 1 >= m) {
        Some("length")
    } else {
        None
    };
    let t = &mut *c.text_out;
    let checked = t.text.len();
    // EOS itself is never decoded
    let n = c.completion.len() - eos as usize;
    t.advance(c.tokenizer, &c.completion[..n], finish.is_some());
    let mut end = t.text.len();
    if let Some(i) = find_stop(&t.text, checked, c.stops) {
        t.text.truncate(i);
        end = i;
        finish = Some("stop");
    } else if finish.is_none() {
        end -= stop_holdback(&t.text, c.stops);
    }
    if end > t.sent {
        let delta = t.text[t.sent..end].to_string();
        t.sent = end;
        // EOS never reported a send failure as a cancel; keep it "stop"
        if c.tx.send(GenEvent::Delta(delta)).is_err() && !eos {
            return Emit::Done("cancelled");
        }
    } else if !eos && c.tx.is_closed() {
        // nothing to send this token; still notice a dropped client
        return Emit::Done("cancelled");
    }
    finish.map_or(Emit::More, Emit::Done)
}

/// Prompt-lookup / n-gram draft: find the most recent earlier occurrence
/// of the trailing n-gram in the token history and propose its
/// continuation (up to `k` tokens). Empty when no match.
fn ngram_draft(hist: &[u32], k: usize) -> Vec<u32> {
    const N: usize = 3;
    if hist.len() < N + 1 {
        return Vec::new();
    }
    let n = N.min(hist.len() - 1);
    let pat = &hist[hist.len() - n..];
    for i in (0..hist.len() - n).rev() {
        if &hist[i..i + n] == pat {
            let start = i + n;
            return hist[start..(start + k).min(hist.len())].to_vec();
        }
    }
    Vec::new()
}


// MARK: - batched decode (TH_BATCH > 1)
//
// Jobs queue on a sync channel; the scheduler thread owns the model
// and steps all live slots in lockstep: per-slot draft propose (one
// batched forward), ONE verify forward over the concatenated row
// space (the weight sweep is shared — that's the throughput win),
// then per-slot accept / emit / commit / rollback.

struct BatchJob {
    id: String,
    messages: Vec<ChatMessage>,
    req: RequestSampling,
    tx: mpsc::UnboundedSender<GenEvent>,
    started: Instant,
}

/// Live decode state for one slot.
struct Run {
    #[allow(dead_code)]
    slot: usize,
    id: String,
    tx: mpsc::UnboundedSender<GenEvent>,
    started: Instant,
    sampler: Sampler,
    prompt_tokens: Vec<u32>,
    completion: Vec<u32>,
    hist: Vec<u32>,
    text_out: TextOut,
    pos: usize,
    anchor: u32,
    accept_ema: f64,
    spec_rounds: u64,
    spec_accepted: u64,
    ttft_ms: f64,
    decode_ms_total: f64,
    prefill_ms_total: f64,
    finish: Option<&'static str>,
    sp: ResolvedSampling,
    cancel: Arc<AtomicBool>,
    n_prompt: usize,
    /// T1: prompt tokens restored from the prefix cache.
    cached_tokens: usize,
}

fn batch_loop(
    inner: Arc<tokio::sync::Mutex<ModelInner>>,
    state: Arc<EngineState>,
    rx: std::sync::mpsc::Receiver<BatchJob>,
    nslots: usize,
) {
    let mut pending: Vec<BatchJob> = Vec::new();
    let mut runs: Vec<Option<Run>> = (0..nslots).map(|_| None).collect();
    loop {
        while let Ok(j) = rx.try_recv() {
            pending.push(j);
        }
        let idle = runs.iter().all(|r| r.is_none());
        if idle && pending.is_empty() {
            match rx.recv() {
                Ok(j) => {
                    pending.push(j);
                    continue;
                }
                Err(_) => return, // channel closed — shutdown
            }
        }
        {
            // hold the model lock only while stepping — status calls
            // and config reads land between rounds
            let mut inner = inner.blocking_lock();
            for s in 0..nslots {
                if runs[s].is_none() && !pending.is_empty() {
                    let job = pending.remove(0);
                    // admit consumes the job; keep a sender so a failed
                    // admission reaches the client (dropping it closes the
                    // stream with no Error — HTTP 200 with empty content)
                    let tx = job.tx.clone();
                    // a panic here must not unwind the scheduler thread
                    // (that drops `rx`: every later request fails while
                    // the probes stay green) — surface it as an Err; the
                    // next admit's clear_kv_cache rebuilds lost slot state
                    let res = std::panic::catch_unwind(
                        std::panic::AssertUnwindSafe(|| {
                            admit(&mut inner, &state, s, job)
                        }),
                    )
                    .unwrap_or_else(|p| {
                        Err(anyhow::anyhow!("admit panicked: {}", panic_msg(&*p)))
                    });
                    match res {
                        Ok(Some(r)) => runs[s] = Some(r),
                        Ok(None) => {
                            // rejected pre-run (admit sent the Error)
                            state.counters.requests_active.fetch_sub(1, Ordering::Relaxed);
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "batch admit failed");
                            let _ = tx.send(GenEvent::Error(e.to_string()));
                            state.counters.requests_active.fetch_sub(1, Ordering::Relaxed);
                        }
                    }
                    inner.live[s] = runs[s].is_some();
                }
            }
            let round = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                batch_round(&mut inner, &state, &mut runs)
            }))
            .unwrap_or_else(|p| {
                Err(anyhow::anyhow!("batch round panicked: {}", panic_msg(&*p)))
            });
            if let Err(e) = round {
                tracing::warn!(error = %e, "batch round failed");
                for r in runs.iter_mut().flatten() {
                    if r.finish.is_none() {
                        let _ = r.tx.send(GenEvent::Error(e.to_string()));
                        r.finish = Some("error");
                    }
                }
            }
            for s in 0..nslots {
                if matches!(&runs[s], Some(r) if r.finish.is_some()) {
                    let r = runs[s].take().unwrap();
                    inner.live[s] = false;
                    finish_run(&state, r);
                }
            }
        }
        std::thread::yield_now();
    }
}

fn panic_msg(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

/// Prefill a job onto slot `s` and emit its first token.
fn admit(
    inner: &mut ModelInner,
    state: &Arc<EngineState>,
    slot: usize,
    job: BatchJob,
) -> Result<Option<Run>> {
    let cfg = state.config.read().unwrap().clone();
    let sp = resolve_sampling(&job.req, &cfg);
    let bos = inner.tokenizer.token_to_id("<s>").map(|_| "<s>");
    let prompt = template::render(inner.chat_template.as_deref(), &job.messages, bos)?;
    let prompt_tokens: Vec<u32> = inner
        .tokenizer
        .encode(prompt.as_str(), false)
        .map_err(|e| anyhow::anyhow!("tokenize: {e}"))?
        .get_ids()
        .to_vec();
    let n_prompt = prompt_tokens.len();
    if let Some(max_ctx) = sp.max_context {
        if n_prompt + sp.max_tokens > max_ctx {
            let _ = job.tx.send(GenEvent::Error(
                format!("prompt ({n_prompt}) + max_tokens ({}) exceeds max_context", sp.max_tokens),
            ));
            return Ok(None);
        }
    }
    state.emit(
        "request.start",
        serde_json::json!({"id": job.id, "prompt_tokens": n_prompt, "slot": slot}),
    );
    inner.backend.set_kv_quant_slot(sp.kv_quant, slot)?;
    // T1: slot-local restore + canonical-chunk prefill (checkpoints are
    // shared read-only across slots — see qwen35::PrefixState)
    let pf = prefill_slot(inner, state, slot, &prompt_tokens, &sp)?;
    let pos = n_prompt;
    let last_logits = pf.logits;
    let prefill_ms_total = pf.prefill_ms;
    let cached_tokens = pf.cached;
    let mut sampler = Sampler::new(&sp, sp.seed.max(1));
    let anchor = sampler.sample(
        &last_logits.context("empty prefill")?,
        &[],
        &prompt_tokens,
        sp.repeat_penalty,
        sp.repeat_last_n,
    )?;
    let mut run = Run {
        slot,
        id: job.id,
        tx: job.tx,
        started: job.started,
        sampler,
        prompt_tokens: prompt_tokens.clone(),
        completion: Vec::new(),
        hist: prompt_tokens,
        text_out: TextOut::default(),
        pos,
        anchor,
        accept_ema: 4.0,
        spec_rounds: 0,
        spec_accepted: 0,
        ttft_ms: 0.0,
        decode_ms_total: 0.0,
        prefill_ms_total,
        finish: None,
        sp,
        cancel: Arc::new(AtomicBool::new(false)),
        n_prompt,
        cached_tokens,
    };
    let eos_ids = inner.eos_ids.clone();
    let mut ec = EmitCtx {
        completion: &mut run.completion,
        hist: &mut run.hist,
        text_out: &mut run.text_out,
        tx: &run.tx,
        tokenizer: &inner.tokenizer,
        eos_ids: &eos_ids,
        stops: &run.sp.stop,
        cancel: &run.cancel,
        state,
        max_tokens: run.sp.max_tokens,
        max_ctx: run.sp.max_context,
    };
    match emit_token(&mut ec, anchor, run.pos) {
        Emit::Done(rsn) => run.finish = Some(rsn),
        Emit::More => {
            // run.pos stays = committed KV count (anchor not forwarded
            // yet) — see the single-slot loop
            run.ttft_ms = run.started.elapsed().as_secs_f64() * 1000.0;
            if run.tx.send(GenEvent::FirstToken { ttft_ms: run.ttft_ms }).is_err() {
                run.finish = Some("cancelled");
            }
        }
    }
    // the draft ring warm-up after the first token (as the single-slot
    // loop); synced so the next lockstep round's timing excludes it. It
    // runs even when the request already ended (main ran it before every
    // first sample): the slot's next request reads ring rows written here
    let mut clk = PhaseClock::new();
    inner.backend.draft_prefill(slot)?;
    inner.device.synchronize()?;
    if clk.on {
        eprintln!("  [prefill] slot={slot} draft_warmup={:.1}ms", clk.mark(&inner.device));
    }
    Ok(Some(run))
}

/// One lockstep round over all live slots.
fn batch_round(
    inner: &mut ModelInner,
    state: &Arc<EngineState>,
    runs: &mut Vec<Option<Run>>,
) -> Result<()> {
    // active slot list (runs may be sparse mid-finish)
    let active: Vec<usize> = runs
        .iter()
        .enumerate()
        .filter(|(_, r)| matches!(r, Some(r) if r.finish.is_none()))
        .map(|(s, _)| s)
        .collect();
    if active.is_empty() {
        return Ok(());
    }
    let t0 = Instant::now();
    // cancel check
    for &b in &active {
        if let Some(r) = &mut runs[b] {
            if r.cancel.load(Ordering::Relaxed) {
                r.finish = Some("cancelled");
            }
        }
    }
    let active: Vec<usize> = active
        .into_iter()
        .filter(|&b| matches!(&runs[b], Some(r) if r.finish.is_none()))
        .collect();
    if active.is_empty() {
        return Ok(());
    }
    let anchors: Vec<u32> = active.iter().map(|&b| runs[b].as_ref().unwrap().anchor).collect();
    let poss: Vec<usize> = active.iter().map(|&b| runs[b].as_ref().unwrap().pos).collect();
    let temps: Vec<Option<crate::dflash::DraftSampling>> = active
        .iter()
        .map(|&b| runs[b].as_ref().unwrap().sampler.draft_sampling())
        .collect();
    let props = {
        // propose needs the sampler's uniform — run it per slot through
        // a small shim; draft_propose_batch takes a slot-indexed fn.
        let mut u = |b: usize| -> f64 {
            let r = runs[active[b]].as_mut().unwrap();
            r.sampler.next_f64()
        };
        inner.backend.draft_propose_batch(&active, &anchors, &poss, &temps, &mut u)?
    };
    // verify rows: anchor + all 7 proposals (rows are ~free in batch)
    let seqs: Vec<Vec<u32>> = active
        .iter()
        .zip(props.iter())
        .map(|(&b, p)| {
            let mut sq = Vec::with_capacity(8);
            sq.push(runs[b].as_ref().unwrap().anchor);
            sq.extend_from_slice(&p.tokens);
            sq
        })
        .collect();
    let snaps: Vec<model::BackendSnapshot> = active
        .iter()
        .map(|&b| inner.backend.snapshot(b))
        .collect::<Result<_>>()?;
    let seq_refs: Vec<&[u32]> = seqs.iter().map(|v| v.as_slice()).collect();
    let t_fwd = t0.elapsed();
    let logits = inner.backend.forward_batch(&active, &seq_refs, &poss)?;
    let t_verify = t0.elapsed();
    // caps per slot
    let caps: Vec<Option<Tensor>> = active
        .iter()
        .map(|&b| inner.backend.take_captures(b))
        .collect::<Result<_>>()?;
    // greedy slots read the GPU argmax rows — one [rows] u32 readback for
    // the whole batch — whatever the other slots do (N2: a sampled slot
    // used to push every slot, T=0 ones included, through the CPU
    // dist_vec path, so a T=0 stream depended on its batch mates)
    let greedy: Vec<bool> = active
        .iter()
        .map(|&b| {
            let r = runs[b].as_ref().unwrap();
            greedy_rows(&r.sampler, &r.sp)
        })
        .collect();
    // S1: encode every GPU-served sampled slot's acceptance into the same
    // command buffer before the first readback
    let mut gpu_pending: Vec<Option<(Tensor, u64)>> = (0..active.len()).map(|_| None).collect();
    for (i, &b) in active.iter().enumerate() {
        if greedy[i] {
            continue;
        }
        let r = runs[b].as_mut().unwrap();
        if let Some(pol) = gpu_policy(&r.sampler, &r.sp, &inner.device) {
            gpu_pending[i] = Some(gpu_accept_encode(
                &mut r.sampler,
                &logits,
                i * seqs[i].len(),
                &pol,
                &props[i],
                crate::dflash::PROPOSALS,
            )?);
        }
    }
    let argmax_all: Vec<u32> = if greedy.iter().any(|&g| g) {
        logits.argmax(candle_core::D::Minus1)?.to_vec1::<u32>()?
    } else {
        Vec::new()
    };
    // greedy: the argmax readback above is the first GPU sync after
    // forward_batch, so this is where the verify pass actually lands
    // (all-sampled: the first result-block / to_vec2 readback syncs)
    let t_read = t0.elapsed();
    // per-slot accept / emit / commit / rollback
    for (i, &b) in active.iter().enumerate() {
        let prop = &props[i];
        let mut emitted: Vec<u32> = Vec::with_capacity(8);
        let mut accepted = 0usize;
        let seq_len = seqs[i].len(); // = 8
        let off = i * seq_len;
        if greedy[i] {
            for k in 0..crate::dflash::PROPOSALS {
                let t = argmax_all[off + k];
                emitted.push(t);
                if t == prop.tokens[k] {
                    accepted += 1;
                } else {
                    break;
                }
            }
            if accepted == crate::dflash::PROPOSALS {
                emitted.push(argmax_all[off + crate::dflash::PROPOSALS]);
            }
        } else {
            let r = runs[b].as_mut().unwrap();
            let mut chain = None;
            if let Some((res, st0)) = gpu_pending[i].take() {
                chain = gpu_accept_finish(
                    &mut r.sampler,
                    &res,
                    st0,
                    &logits,
                    off,
                    prop,
                    crate::dflash::PROPOSALS,
                    &r.completion,
                    &r.prompt_tokens,
                    r.sp.repeat_penalty,
                    r.sp.repeat_last_n,
                )?;
            }
            let c = match chain {
                Some(c) => c,
                None => {
                    let rows: Vec<Vec<half::bf16>> = logits.narrow(0, off, seq_len)?.to_vec2()?;
                    cpu_accept(
                        &mut r.sampler,
                        &rows,
                        prop,
                        crate::dflash::PROPOSALS,
                        &r.completion,
                        &r.prompt_tokens,
                        r.sp.repeat_penalty,
                        r.sp.repeat_last_n,
                    )
                }
            };
            emitted = c.emitted;
            accepted = c.accepted;
        }
        // emit retained tokens
        let r = runs[b].as_mut().unwrap();
        let eos_ids = inner.eos_ids.clone();
        for (k, &t) in emitted.iter().enumerate() {
            let mut ec = EmitCtx {
                completion: &mut r.completion,
                hist: &mut r.hist,
                text_out: &mut r.text_out,
                tx: &r.tx,
                tokenizer: &inner.tokenizer,
                eos_ids: &eos_ids,
                stops: &r.sp.stop,
                cancel: &r.cancel,
                state,
                max_tokens: r.sp.max_tokens,
                max_ctx: r.sp.max_context,
            };
            if let Emit::Done(rsn) = emit_token(&mut ec, t, r.pos + 1 + k) {
                r.finish = Some(rsn);
                break;
            }
        }
        let retained = emitted.len();
        if let Some(c) = caps[i].as_ref() {
            inner.backend.draft_commit(
                b,
                &c.narrow(0, 0, retained)?,
                poss[i],
                retained,
            )?;
        }
        if retained < seq_len {
            inner.backend.rollback_verify(b, snaps[i].clone(), retained)?;
        }
        r.pos += retained;
        r.spec_rounds += 1;
        r.spec_accepted += accepted as u64;
        r.accept_ema += 0.25 * (accepted as f64 - r.accept_ema);
        if accepted == crate::dflash::PROPOSALS {
            r.accept_ema += 0.6;
        }
        if let Some(rl) = emitted.last() {
            r.anchor = *rl;
        }
    }
    // Full round, as the B=1 loop measures it. forward_batch only
    // ENCODES the verify pass (no sync inside), so stopping the clock
    // at its return (the old `t_verify`) dropped the GPU verify time
    // from decode_ms_total / decode_tps / the latency histogram.
    let step_ms = t0.elapsed().as_secs_f64() * 1000.0;
    if debug_timing() {
        eprintln!(
            "  [batch] nb={} propose={:.1}ms verify_enqueue={:.1}ms readback={:.1}ms accept={:.1}ms total={:.1}ms old_step={:.1}ms",
            active.len(),
            t_fwd.as_secs_f64() * 1e3,
            (t_verify - t_fwd).as_secs_f64() * 1e3,
            (t_read - t_verify).as_secs_f64() * 1e3,
            step_ms - t_read.as_secs_f64() * 1e3,
            step_ms,
            t_verify.as_secs_f64() * 1e3,
        );
    }
    for &b in &active {
        if let Some(r) = runs[b].as_mut() {
            r.decode_ms_total += step_ms;
        }
    }
    state.counters.observe_decode(step_ms);
    Ok(())
}

fn finish_run(state: &Arc<EngineState>, r: Run) {
    sample_check_summary();
    let total_ms = r.started.elapsed().as_secs_f64() * 1000.0;
    let n_completion = r.completion.len();
    let decode_tps = if n_completion > 1 && r.decode_ms_total > 0.0 {
        (n_completion - 1) as f64 / (r.decode_ms_total / 1000.0)
    } else {
        0.0
    };
    let prefilled = r.n_prompt - r.cached_tokens;
    let prefill_tps = if prefilled > 0 && r.prefill_ms_total > 0.0 {
        prefilled as f64 / (r.prefill_ms_total / 1000.0)
    } else {
        0.0
    };
    state
        .counters
        .prompt_tokens_total
        .fetch_add(r.n_prompt as u64, Ordering::Relaxed);
    state
        .counters
        .completion_tokens_total
        .fetch_add(n_completion as u64, Ordering::Relaxed);
    let finish = r.finish.unwrap_or("stop").to_string();
    let stats = DoneStats {
        prompt_tokens: r.n_prompt,
        completion_tokens: n_completion,
        ttft_ms: r.ttft_ms,
        total_ms,
        decode_tps,
        prefill_tps,
        finish: finish.clone(),
        spec_rounds: r.spec_rounds,
        spec_accepted: r.spec_accepted,
        cached_tokens: r.cached_tokens,
    };
    let _ = r.tx.send(GenEvent::Done(Box::new(stats)));
    let rec = RequestRecord {
        id: r.id,
        started_ms: state.started.elapsed().as_millis() as u64,
        prompt_tokens: r.n_prompt,
        completion_tokens: n_completion,
        ttft_ms: r.ttft_ms,
        total_ms,
        decode_tps,
        finish,
        cached_tokens: r.cached_tokens,
    };
    state.counters.requests_active.fetch_sub(1, Ordering::Relaxed);
    state.emit("request.done", serde_json::to_value(&rec).unwrap_or_default());
    state.record(rec);
}

#[cfg(test)]
mod utf8_stream {
    //! UTF-8-safe streaming through `emit_token`:
    //! `cargo test --release utf8_stream`.
    use super::*;
    use crate::state::EngineConfig;
    use std::str::FromStr;
    use tokenizers::Tokenizer;

    const EOS: u32 = 1000;
    const TEXT: &str = "你好，世界！🙂👍🏽 これは日本語です。🎉 한국어 𠮷野家 🧑‍🚀 café ✓";

    /// GPT-2 `bytes_to_unicode`: printable bytes map to themselves, the
    /// rest to U+0100.. in byte order.
    fn byte_char(b: u8) -> char {
        let printable = |x: u8| matches!(x, b'!'..=b'~' | 0xA1..=0xAC | 0xAE..=0xFF);
        if printable(b) {
            return b as char;
        }
        char::from_u32(256 + (0..b).filter(|&x| !printable(x)).count() as u32).unwrap()
    }

    /// Hermetic byte-level BPE: ids 0..=255 are single bytes, 256.. the
    /// given byte strings (free to straddle characters), EOS special.
    fn byte_tokenizer(extra: &[&[u8]]) -> Tokenizer {
        let piece = |bs: &[u8]| bs.iter().map(|&b| byte_char(b)).collect::<String>();
        let mut vocab = serde_json::Map::new();
        for b in 0..=255u8 {
            vocab.insert(piece(&[b]), (b as u32).into());
        }
        for (i, bs) in extra.iter().enumerate() {
            vocab.insert(piece(bs), (256 + i as u32).into());
        }
        let byte_level = serde_json::json!({"type": "ByteLevel",
            "add_prefix_space": false, "trim_offsets": true, "use_regex": true});
        let j = serde_json::json!({
            "version": "1.0", "truncation": null, "padding": null,
            "added_tokens": [{"id": EOS, "content": "<|eos|>", "single_word": false,
                "lstrip": false, "rstrip": false, "normalized": false, "special": true}],
            "normalizer": null, "pre_tokenizer": byte_level, "post_processor": null,
            "decoder": byte_level,
            "model": {"type": "BPE", "dropout": null, "unk_token": null,
                "continuing_subword_prefix": null, "end_of_word_suffix": null,
                "fuse_unk": false, "byte_fallback": false, "vocab": vocab, "merges": []},
        });
        Tokenizer::from_str(&j.to_string()).unwrap()
    }

    /// The real Qwen3.x tokenizer, if a snapshot is on disk
    /// (`TH_TEST_TOKENIZER=<tokenizer.json>` points elsewhere).
    fn qwen_tokenizer() -> Option<Tokenizer> {
        let path = std::env::var("TH_TEST_TOKENIZER")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| {
                let hub = std::path::PathBuf::from(std::env::var("HOME").ok()?).join(
                    ".cache/huggingface/hub/models--mlx-community--Qwen3.8-27B-4bit/snapshots",
                );
                std::fs::read_dir(hub)
                    .ok()?
                    .flatten()
                    .map(|e| e.path().join("tokenizer.json"))
                    .find(|p| p.exists())
            })?;
        Tokenizer::from_file(path).ok()
    }

    fn bytes(s: &str) -> Vec<u32> {
        s.bytes().map(u32::from).collect()
    }

    struct Out {
        deltas: Vec<String>,
        finish: &'static str,
        text: String,
    }

    /// Feed `ids` through `emit_token` as the decode loops do, with a
    /// fresh `EmitCtx` per token (as the batched path builds them).
    fn stream(tok: &Tokenizer, ids: &[u32], eos: &[u32], stops: &[&str], max_tokens: usize) -> Out {
        let state = EngineState::new(String::new(), serde_json::Value::Null, EngineConfig::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let cancel = AtomicBool::new(false);
        let stops: Vec<String> = stops.iter().map(|s| s.to_string()).collect();
        let (mut completion, mut hist, mut text_out) = (Vec::new(), Vec::new(), TextOut::default());
        let mut finish = "open";
        for (i, &t) in ids.iter().enumerate() {
            let mut ec = EmitCtx {
                completion: &mut completion,
                hist: &mut hist,
                text_out: &mut text_out,
                tx: &tx,
                tokenizer: tok,
                eos_ids: eos,
                stops: &stops,
                cancel: &cancel,
                state: &state,
                max_tokens,
                max_ctx: None,
            };
            if let Emit::Done(r) = emit_token(&mut ec, t, i) {
                finish = r;
                break;
            }
        }
        let mut deltas = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let GenEvent::Delta(d) = ev {
                deltas.push(d);
            }
        }
        Out { deltas, finish, text: text_out.text }
    }

    /// Concatenated deltas == `want`, and every delta is non-empty whole
    /// characters.
    fn assert_clean(o: &Out, want: &str) {
        assert_eq!(o.deltas.concat(), want, "deltas {:?}", o.deltas);
        for d in &o.deltas {
            assert!(!d.is_empty(), "empty delta in {:?}", o.deltas);
            assert!(!d.contains('\u{FFFD}'), "U+FFFD in delta {d:?} of {:?}", o.deltas);
        }
    }

    fn splits_a_char(tok: &Tokenizer, ids: &[u32]) -> bool {
        ids.iter().any(|&i| tok.decode(&[i], true).unwrap().contains('\u{FFFD}'))
    }

    #[test]
    fn utf8_stream_byte_tokens() {
        // every byte its own token: CJK chars span 3 ids, emoji 4
        let tok = byte_tokenizer(&[]);
        let mut ids = bytes(TEXT);
        let full = tok.decode(&ids, true).unwrap();
        assert_eq!(full, TEXT);
        assert!(splits_a_char(&tok, &ids)); // what the per-token decode streamed
        ids.push(EOS);
        let o = stream(&tok, &ids, &[EOS], &[], usize::MAX);
        assert_eq!(o.finish, "stop");
        assert_clean(&o, &full);
    }

    #[test]
    fn utf8_stream_straddling_tokens() {
        // tokens that start and end mid-character:
        // [E4 BD] [A0 E5] [A5 BD F0] [9F 99] [82 21] = "你好🙂!"
        let s = "你好🙂!";
        let b = s.as_bytes();
        let tok = byte_tokenizer(&[&b[0..2], &b[2..4], &b[4..7], &b[7..9], &b[9..11]]);
        let mut ids: Vec<u32> = (256..261).collect();
        assert_eq!(tok.decode(&ids, true).unwrap(), s);
        ids.push(EOS);
        let o = stream(&tok, &ids, &[EOS], &[], usize::MAX);
        assert_eq!(o.finish, "stop");
        assert_clean(&o, s);
    }

    #[test]
    fn utf8_stream_qwen_tokenizer() {
        let Some(tok) = qwen_tokenizer() else {
            eprintln!("utf8_stream_qwen_tokenizer: no Qwen tokenizer.json on disk, skipped");
            return;
        };
        let mut ids = tok.encode(TEXT, false).unwrap().get_ids().to_vec();
        let full = tok.decode(&ids, true).unwrap();
        assert_eq!(full, TEXT);
        assert!(splits_a_char(&tok, &ids), "sample never splits a character: {ids:?}");
        ids.push(248046); // <|im_end|>
        let o = stream(&tok, &ids, &[248046, 248044], &[], usize::MAX);
        assert_eq!(o.finish, "stop");
        assert_clean(&o, &full);
    }

    #[test]
    fn utf8_stream_cjk_stop_string() {
        let tok = byte_tokenizer(&[]);
        let o = stream(&tok, &bytes("你好，世界🙂再见"), &[EOS], &["世界"], usize::MAX);
        assert_eq!(o.finish, "stop");
        assert_clean(&o, "你好，");
        assert_eq!(o.text, "你好，");
    }

    #[test]
    fn utf8_stream_stop_prefix_held_back() {
        // the first "ab" may start "abc": held until "x" rules it out;
        // the second is the stop and never streams
        let tok = byte_tokenizer(&[]);
        let o = stream(&tok, &bytes("xxabxabcyy"), &[EOS], &["abc"], usize::MAX);
        assert_eq!(o.finish, "stop");
        assert_clean(&o, "xxabx");
    }

    #[test]
    fn utf8_stream_flush_at_end() {
        let tok = byte_tokenizer(&[]);
        // EOS right after a held-back stop prefix: flushed, not lost
        let mut ids = bytes("xa");
        ids.push(EOS);
        let o = stream(&tok, &ids, &[EOS], &["ab"], usize::MAX);
        assert_eq!(o.finish, "stop");
        assert_clean(&o, "xa");
        // max_tokens lands on a held-back stop prefix
        let o = stream(&tok, &bytes("xab"), &[EOS], &["abc"], 3);
        assert_eq!(o.finish, "length");
        assert_clean(&o, "xab");
        // max_tokens cuts a character: the tail flushes exactly as
        // decode(all_ids) renders it
        let ids = bytes("a好")[..3].to_vec();
        let o = stream(&tok, &ids, &[EOS], &[], 3);
        assert_eq!(o.finish, "length");
        assert_eq!(o.deltas.concat(), tok.decode(&ids, true).unwrap());
        assert_eq!(o.deltas.concat(), "a\u{FFFD}");
    }

    #[test]
    fn utf8_stream_cancel_while_held_back() {
        // a dropped client is noticed even when the token sends nothing
        let tok = byte_tokenizer(&[]);
        let state = EngineState::new(String::new(), serde_json::Value::Null, EngineConfig::default());
        let (tx, rx) = mpsc::unbounded_channel();
        drop(rx);
        let cancel = AtomicBool::new(false);
        let (mut completion, mut hist, mut text_out) = (Vec::new(), Vec::new(), TextOut::default());
        let mut ec = EmitCtx {
            completion: &mut completion,
            hist: &mut hist,
            text_out: &mut text_out,
            tx: &tx,
            tokenizer: &tok,
            eos_ids: &[EOS],
            stops: &[],
            cancel: &cancel,
            state: &state,
            max_tokens: usize::MAX,
            max_ctx: None,
        };
        assert!(matches!(emit_token(&mut ec, 0xE4, 0), Emit::Done("cancelled")));
    }

    /// SentencePiece-style decoder (Llama GGUF tokenizers): `Strip` drops
    /// the first token's leading space, byte-fallback pieces form a
    /// character. Per-token decode streamed "Helloworld" + 3x U+FFFD.
    #[test]
    fn utf8_stream_sentencepiece_decoder() {
        let j = serde_json::json!({
            "version": "1.0", "truncation": null, "padding": null,
            "added_tokens": [{"id": 2, "content": "</s>", "single_word": false,
                "lstrip": false, "rstrip": false, "normalized": false, "special": true}],
            "normalizer": null, "pre_tokenizer": null, "post_processor": null,
            "decoder": {"type": "Sequence", "decoders": [
                {"type": "Replace", "pattern": {"String": "\u{2581}"}, "content": " "},
                {"type": "ByteFallback"}, {"type": "Fuse"},
                {"type": "Strip", "content": " ", "start": 1, "stop": 0}]},
            "model": {"type": "BPE", "dropout": null, "unk_token": "<unk>",
                "continuing_subword_prefix": null, "end_of_word_suffix": null,
                "fuse_unk": true, "byte_fallback": true,
                "vocab": {"<unk>": 0, "<s>": 1, "</s>": 2, "\u{2581}Hello": 3, "\u{2581}world": 4,
                          "<0xE4>": 5, "<0xBD>": 6, "<0xA0>": 7, "\u{2581}": 8, "!": 9},
                "merges": []},
        });
        let tok = Tokenizer::from_str(&j.to_string()).unwrap();
        let ids = [3u32, 4, 8, 5, 6, 7, 9, 2];
        let full = tok.decode(&ids, true).unwrap();
        assert_eq!(full, "Hello world 你!");
        let o = stream(&tok, &ids, &[2], &[], usize::MAX);
        assert_eq!(o.finish, "stop");
        assert_clean(&o, &full);
    }

    /// The batched path (TH_BATCH > 1) keeps one `TextOut` per slot and
    /// builds a fresh `EmitCtx` per token, up to 8 tokens per slot per
    /// lockstep round (`admit` / `batch_round`). Interleaved that way,
    /// with rounds that end mid-character, every slot must stream exactly
    /// the deltas it streams alone.
    #[test]
    fn utf8_stream_interleaved_slots() {
        struct Slot {
            ids: Vec<u32>,
            stops: Vec<String>,
            n_prompt: usize,
            next: usize,
            completion: Vec<u32>,
            hist: Vec<u32>,
            text_out: TextOut,
            tx: mpsc::UnboundedSender<GenEvent>,
            rx: mpsc::UnboundedReceiver<GenEvent>,
            finish: &'static str,
        }
        let tok = byte_tokenizer(&[]);
        let state = EngineState::new(String::new(), serde_json::Value::Null, EngineConfig::default());
        let cancel = AtomicBool::new(false);
        let mut a = bytes(TEXT);
        a.push(EOS);
        let jobs = [(a, vec![], 21), (bytes("🍂秋风起，落叶黄。🍁"), vec!["落叶".to_string()], 9)];
        let mut slots: Vec<Slot> = jobs
            .iter()
            .map(|(ids, stops, n_prompt)| {
                let (tx, rx) = mpsc::unbounded_channel();
                Slot {
                    ids: ids.clone(),
                    stops: stops.clone(),
                    n_prompt: *n_prompt,
                    next: 0,
                    completion: Vec::new(),
                    hist: Vec::new(),
                    text_out: TextOut::default(),
                    tx,
                    rx,
                    finish: "open",
                }
            })
            .collect();
        for round in 0usize.. {
            let mut live = false;
            for (s, sl) in slots.iter_mut().enumerate() {
                if sl.finish != "open" || sl.next == sl.ids.len() {
                    continue;
                }
                live = true;
                let end = (sl.next + 1 + (round * 3 + s * 5) % 8).min(sl.ids.len());
                while sl.next < end {
                    // absolute KV index, as admit() / batch_round() pass it
                    let (t, pos) = (sl.ids[sl.next], sl.n_prompt + sl.completion.len());
                    sl.next += 1;
                    let mut ec = EmitCtx {
                        completion: &mut sl.completion,
                        hist: &mut sl.hist,
                        text_out: &mut sl.text_out,
                        tx: &sl.tx,
                        tokenizer: &tok,
                        eos_ids: &[EOS],
                        stops: &sl.stops,
                        cancel: &cancel,
                        state: &state,
                        max_tokens: usize::MAX,
                        max_ctx: None,
                    };
                    if let Emit::Done(r) = emit_token(&mut ec, t, pos) {
                        sl.finish = r;
                        break;
                    }
                }
            }
            if !live {
                break;
            }
        }
        for (sl, want) in slots.iter_mut().zip([TEXT, "🍂秋风起，"]) {
            let mut deltas = Vec::new();
            while let Ok(ev) = sl.rx.try_recv() {
                if let GenEvent::Delta(d) = ev {
                    deltas.push(d);
                }
            }
            let o = Out { deltas, finish: sl.finish, text: std::mem::take(&mut sl.text_out.text) };
            assert_eq!(o.finish, "stop");
            assert_eq!(o.text, want);
            assert_clean(&o, want);
            let stops: Vec<&str> = sl.stops.iter().map(|s| s.as_str()).collect();
            let solo = stream(&tok, &sl.ids, &[EOS], &stops, usize::MAX);
            assert_eq!(o.deltas, solo.deltas, "interleaving changed the stream");
        }
    }
}

#[cfg(test)]
mod dflash_policy {
    use super::dflash_verify_len;
    use crate::dflash::PROPOSALS;

    /// L1: the default verifies every proposal regardless of the EMA;
    /// the legacy adaptive rule is round(ema) + 1, clamped to 2..=7.
    #[test]
    fn verify_len_default_and_adaptive() {
        for ema in [0.0, 0.4, 1.0, 2.49, 3.5, 6.9, 7.0] {
            assert_eq!(dflash_verify_len(false, ema), PROPOSALS, "default @ ema={ema}");
        }
        let table = [
            (0.0, 2), (0.49, 2), (0.5, 2), (1.49, 2), (1.5, 3), (2.5, 4),
            (3.49, 4), (3.5, 5), (5.5, 7), (6.9, 7), (7.0, 7),
        ];
        for (ema, want) in table {
            assert_eq!(dflash_verify_len(true, ema), want, "adaptive @ ema={ema}");
        }
    }
}

#[cfg(test)]
mod decode_qos_tests {
    use super::decode_qos::{parse, Mode};

    #[test]
    fn parse_modes() {
        for (v, want) in [
            (None, Mode::Off),
            (Some(""), Mode::Off),
            (Some("off"), Mode::Off),
            (Some("0"), Mode::Off),
            (Some(" default "), Mode::Off),
            (Some("interactive"), Mode::Interactive),
            (Some("On"), Mode::Interactive),
            (Some("initiated"), Mode::Initiated),
            (Some("UI"), Mode::Initiated),
        ] {
            assert_eq!(parse(v), want, "TH_DECODE_QOS={v:?}");
        }
    }

    /// enter() raises the calling thread and the guard restores it.
    #[cfg(target_os = "macos")]
    #[test]
    fn enter_raises_and_restores() {
        std::thread::spawn(|| {
            let q = || {
                let mut c = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
                let mut r = 0;
                assert_eq!(unsafe { libc::pthread_get_qos_class_np(libc::pthread_self(), &mut c, &mut r) }, 0);
                c as u32
            };
            let before = q();
            {
                let _g = super::decode_qos::enter_with(Mode::Interactive);
                assert_eq!(q(), libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE as u32);
            }
            {
                // Off leaves the thread alone
                let _g = super::decode_qos::enter_with(Mode::Off);
                assert_eq!(q(), before);
            }
            let after = q();
            let norm = |c: u32| if c == 0 { libc::qos_class_t::QOS_CLASS_DEFAULT as u32 } else { c };
            assert_eq!(norm(after), norm(before), "QoS not restored");
        })
        .join()
        .unwrap();
    }
}

/// N2: every greedy pick must share the GPU argmax tie rule (lowest index
/// among equal maxima). The DFlash greedy verify reads `Tensor::argmax`
/// rows; the anchor, the non-draft loop, penalty requests and sampled
/// batches pick through `row_dist_of` / `cpu_accept` (S1).
#[cfg(test)]
mod n2_tie_tests {
    use super::*;

    fn greedy_sampler() -> Sampler {
        Sampler { temperature: None, top_k: None, top_p: None, rng: 1, gpu_servable: false }
    }

    /// The anchor / non-draft / sampled-batch greedy pick.
    fn cpu_greedy(row: Vec<f32>) -> u32 {
        let d = row_dist_of(greedy_sampler().policy(), row, &[], &[], 1.0, 64);
        assert!(d.deterministic());
        d.ids[0]
    }

    #[test]
    fn n2_greedy_tie_rule_matches_argmax() -> Result<()> {
        const V: usize = 248_320;
        let bf = half::bf16::from_f32;
        let mut data = vec![bf(-2.5); 3 * V];
        // row 0: exact duplicate max, far apart
        data[1_000] = bf(21.0);
        data[200_000] = bf(21.0);
        // row 1: two DISTINCT f32 logits that round to one bf16 (step 0.125 in [16,32))
        data[V + 5] = bf(21.03);
        data[V + 7] = bf(20.97);
        // row 2: three-way tie
        data[2 * V + 42] = bf(30.5);
        data[2 * V + 4_242] = bf(30.5);
        data[2 * V + 248_000] = bf(30.5);
        assert_eq!(data[V + 5], data[V + 7], "21.03 and 20.97 must share a bf16 value");
        let rows_f32: Vec<Vec<f32>> = (0..3)
            .map(|r| data[r * V..(r + 1) * V].iter().map(|x| x.to_f32()).collect())
            .collect();
        let want = vec![1_000u32, 5, 42];
        let cpu: Vec<u32> = rows_f32.iter().cloned().map(cpu_greedy).collect();
        assert_eq!(cpu, want, "row_dist_of greedy must pick the lowest index on ties");
        let cpu_candle: Vec<u32> =
            Tensor::from_vec(data.clone(), (3, V), &candle_core::Device::Cpu)?
                .argmax(candle_core::D::Minus1)?
                .to_vec1()?;
        assert_eq!(cpu_candle, want, "candle CPU argmax: lowest index");
        // cpu_accept's greedy rows (sampled-batch / penalty fallback) agree
        let prop = crate::dflash::Proposal {
            tokens: [0; crate::dflash::PROPOSALS],
            cand_ids: Default::default(),
            cand_probs: Default::default(),
        };
        for (r, &w) in want.iter().enumerate() {
            let mut s = greedy_sampler();
            let row: Vec<Vec<half::bf16>> = vec![data[r * V..(r + 1) * V].to_vec(); 2];
            let c = cpu_accept(&mut s, &row, &prop, 1, &[], &[], 1.0, 64);
            assert_eq!(c.emitted[0], w, "cpu_accept greedy row {r}");
            assert_eq!(c.consumed, 0, "greedy rows draw no uniforms");
        }
        assert_eq!(greedy_argmax(&[f32::NAN, 1.0, 1.0]), 1);
        assert_eq!(greedy_argmax(&[f32::NEG_INFINITY; 4]), 0);
        assert_eq!(greedy_argmax(&[]), 0);
        #[cfg(all(feature = "metal", target_os = "macos"))]
        if let Ok(metal) = candle_core::Device::new_metal(0) {
            // the ba8ee49 verify readback, verbatim (bf16 rows)
            let t = Tensor::from_vec(data.clone(), (3, V), &metal)?;
            let gpu: Vec<u32> = t.argmax(candle_core::D::Minus1)?.to_vec1::<u32>()?;
            assert_eq!(gpu, want, "metal bf16 argmax: lowest index on exact ties");
            // f32 single rows (forward() returns bf16 logits cast to f32)
            for (r, &w) in want.iter().enumerate() {
                let g = Tensor::new(rows_f32[r].as_slice(), &metal)?
                    .argmax(candle_core::D::Minus1)?
                    .to_scalar::<u32>()?;
                assert_eq!(g, w, "metal f32 argmax row {r}");
            }
        }
        Ok(())
    }

    #[test]
    fn n2_greedy_rows_routing() {
        let mut sp = resolve_sampling(&RequestSampling::default(), &EngineConfig::default());
        sp.repeat_penalty = 1.0;
        assert!(greedy_rows(&greedy_sampler(), &sp), "T=0, no penalty -> argmax rows");
        sp.repeat_penalty = 1.1;
        sp.repeat_last_n = 64;
        assert!(!greedy_rows(&greedy_sampler(), &sp), "a repeat penalty reshapes the logits");
        sp.repeat_last_n = 0;
        assert!(greedy_rows(&greedy_sampler(), &sp), "penalty window 0 = no penalty");
        let hot = Sampler { temperature: Some(0.6), top_k: Some(20), top_p: Some(0.95), rng: 1, gpu_servable: true };
        sp.repeat_penalty = 1.0;
        assert!(!greedy_rows(&hot, &sp), "sampled slots never take argmax rows");
    }
}

/// B1: the default verification rule is chosen by the request (block
/// where the GPU accept kernel serves it, token elsewhere) and
/// `TH_SPEC_VERIFY` overrides it either way.
#[cfg(test)]
mod b1_rule_tests {
    use super::*;

    #[test]
    fn b1_default_rule_by_request() {
        let mut sp = resolve_sampling(&RequestSampling::default(), &EngineConfig::default());
        sp.temperature = Some(0.6);
        sp.repeat_penalty = 1.0;
        for (k, servable) in [(Some(20), true), (Some(1), true), (Some(32), true), (Some(33), false), (Some(40), false), (Some(0), false), (None, false)] {
            sp.top_k = k;
            assert_eq!(gpu_servable_request(&sp), servable, "top_k {k:?}");
            assert_eq!(Sampler::new(&sp, 7).gpu_servable, servable, "top_k {k:?}");
        }
        sp.top_k = Some(20);
        sp.repeat_penalty = 1.1;
        sp.repeat_last_n = 64;
        assert!(!gpu_servable_request(&sp), "a repeat penalty takes the CPU path");
        sp.repeat_last_n = 0;
        assert!(gpu_servable_request(&sp), "penalty window 0 = no penalty");
        for servable in [false, true] {
            assert_eq!(spec_verify_rule(None, servable), servable, "default follows the kernel");
            assert!(spec_verify_rule(Some(true), servable), "TH_SPEC_VERIFY=block forces block");
            assert!(!spec_verify_rule(Some(false), servable), "TH_SPEC_VERIFY=token forces token");
        }
    }
}
