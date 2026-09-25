// Engine — owns the model + the generation loop.
//
// Unlike a wrapped binary we control every step: per-token timestamps
// (TTFT, decode histogram), chunked prefill, cancellation, KV position
// tracking. Generation is single-slot v1 — requests serialize on the
// model mutex; the lock is acquired in async context then the blocking
// loop runs on spawn_blocking so token streaming overlaps the forward
// passes.

use crate::model::{self, ModelBackend};
use crate::state::{EngineConfig, EngineState, RequestRecord};
use crate::template::{self, ChatMessage};
use anyhow::{bail, Context, Result};
use candle_core::{DType, IndexOp, Tensor};
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
        let inner = ModelInner {
            backend: loaded.backend,
            tokenizer: loaded.tokenizer,
            eos_ids: loaded.eos_ids,
            chat_template: loaded.chat_template,
            device: loaded.device,
            live: vec![false; nslots],
        };
        let inner = Arc::new(tokio::sync::Mutex::new(inner));
        let state = Arc::new(EngineState::new(model_id, meta, cfg));
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
        let out = serde_json::json!({"cleared": cleared, "skipped_live": skipped});
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

    // --- prefill: chunked forward over the prompt, sample once at the end
    let mut last_logits: Option<Tensor> = None;
    for chunk in prompt_tokens.chunks(sp.prefill_step.max(32)) {
        let t = Instant::now();
        last_logits = Some(inner.backend.forward(chunk, pos, &device)?);
        prefill_ms_total += t.elapsed().as_secs_f64() * 1000.0;
        pos += chunk.len();
    }

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
        inner.backend.draft_prefill(0)?; // warm the ring from prefill
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
            } else {
                pos += 1;
                if first {
                    first = false;
                    ttft_ms = started.elapsed().as_secs_f64() * 1000.0;
                    if tx.send(GenEvent::FirstToken { ttft_ms }).is_err() {
                        finish = "cancelled";
                    }
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
                    let prop = inner.backend.draft_propose(
                        0,
                        anchor,
                        pos,
                        sampler.temperature,
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
                    // Also syncs the verify GPU work either way.
                    let greedy = greedy_rows(&sampler, &sp);
                    let mut rows: Vec<Vec<half::bf16>> = Vec::new();
                    let mut argmax_rows: Vec<u32> = Vec::new();
                    if greedy {
                        argmax_rows =
                            logits_m.argmax(candle_core::D::Minus1)?.to_vec1::<u32>()?;
                    } else {
                        rows = logits_m.to_vec2()?;
                    }
                    let t_verify = t0.elapsed();
                    if debug_timing() {
                        eprintln!(
                            "  [verify] enqueue={:.1}ms gpu+readback={:.1}ms",
                            t_fwd_enqueue.as_secs_f64() * 1e3,
                            (t_verify - t_fwd_enqueue).as_secs_f64() * 1e3,
                        );
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
                    } else {
                        let mut rows_it = rows.drain(..);
                        for i in 0..verify_len {
                            let row: Vec<f32> = rows_it
                                .next()
                                .unwrap()
                                .iter()
                                .map(|v| v.to_f32())
                                .collect();
                            let t = spec_accept_step(
                                &mut sampler,
                                row,
                                &prop,
                                i,
                                ec.completion,
                                &prompt_tokens,
                                sp.repeat_penalty,
                                sp.repeat_last_n,
                            )?;
                            emitted.push(t);
                            if t == prop.tokens[i] {
                                accepted += 1;
                            } else {
                                break;
                            }
                        }
                        if accepted == verify_len {
                            let row: Vec<f32> = rows_it
                                .next()
                                .unwrap()
                                .iter()
                                .map(|v| v.to_f32())
                                .collect();
                            let d = sampler.dist_vec(
                                row,
                                ec.completion,
                                &prompt_tokens,
                                sp.repeat_penalty,
                                sp.repeat_last_n,
                            );
                            emitted.push(sampler.pick(&d));
                        }
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

    let total_ms = started.elapsed().as_secs_f64() * 1000.0;
    let n_completion = completion.len();
    let decode_tps = if n_completion > 1 && decode_ms_total > 0.0 {
        (n_completion - 1) as f64 / (decode_ms_total / 1000.0)
    } else {
        0.0
    };
    let prefill_tps = if n_prompt > 0 && prefill_ms_total > 0.0 {
        n_prompt as f64 / (prefill_ms_total / 1000.0)
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
    })
}

/// Sampler that keeps the expensive parts small: one GPU→CPU logits
/// readback per token, then top-k/top-p on CPU over a bounded candidate
/// set. candle's `LogitsProcessor::sample_f` materialises + sorts the
/// full 248k vocab and builds a full-vocab `WeightedIndex` per token —
/// measured ~110ms/token, 15× the forward pass.
struct Sampler {
    temperature: Option<f64>,
    top_k: Option<usize>,
    top_p: Option<f64>,
    rng: u64,
}

impl Sampler {
    fn new(sp: &ResolvedSampling, seed: u64) -> Self {
        Self {
            temperature: sp.temperature.filter(|t| *t > 0.0),
            top_k: sp.top_k,
            top_p: sp.top_p,
            rng: seed | 1,
        }
    }

    #[inline]
    fn next_f64(&mut self) -> f64 {
        // xorshift64* — plenty for token sampling
        let mut x = self.rng;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng = x;
        (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64
            / (1u64 << 53) as f64
    }

    /// Full candidate distribution after repeat penalty, temperature,
    /// top-k and top-p — returns `(id, prob)` normalised over the kept
    /// candidates. Greedy requests (no temperature) return the argmax
    /// with prob 1.
    fn dist(
        &mut self,
        logits: &Tensor,
        completion: &[u32],
        prompt: &[u32],
        repeat_penalty: f32,
        repeat_last_n: usize,
    ) -> Result<Vec<(u32, f32)>> {
        let l = if logits.dtype() == DType::F32 {
            logits.to_vec1::<f32>()?
        } else {
            logits.to_dtype(DType::F32)?.to_vec1::<f32>()?
        };
        Ok(self.dist_vec(l, completion, prompt, repeat_penalty, repeat_last_n))
    }

    /// `dist` over an already-materialised logits vec — lets a verify
    /// pass read all rows in one GPU→CPU transfer.
    fn dist_vec(
        &mut self,
        mut l: Vec<f32>,
        completion: &[u32],
        prompt: &[u32],
        repeat_penalty: f32,
        repeat_last_n: usize,
    ) -> Vec<(u32, f32)> {
        if (repeat_penalty - 1.0).abs() > f32::EPSILON {
            for &tid in
                prompt.iter().chain(completion.iter()).rev().take(repeat_last_n)
            {
                let i = tid as usize;
                if i < l.len() {
                    l[i] = if l[i] < 0.0 {
                        l[i] * repeat_penalty
                    } else {
                        l[i] / repeat_penalty
                    };
                }
            }
        }
        let n = l.len();
        let Some(temp) = self.temperature else {
            return vec![(greedy_argmax(&l), 1.0)];
        };
        let inv_t = 1.0 / temp as f32;
        // top-k candidate set via partial select (O(n))
        let k = self.top_k.unwrap_or(n).min(n);
        let mut idx: Vec<u32> = (0..n as u32).collect();
        let cand: &[u32] = if k < n {
            idx.select_nth_unstable_by(k - 1, |&a, &b| {
                l[b as usize].total_cmp(&l[a as usize])
            });
            &idx[..k]
        } else {
            &idx[..]
        };
        // softmax weights over candidates: w = exp((l - max)/T)
        let max = cand
            .iter()
            .map(|&i| l[i as usize])
            .fold(f32::NEG_INFINITY, f32::max);
        let mut w: Vec<f32> = cand
            .iter()
            .map(|&i| ((l[i as usize] - max) * inv_t).exp())
            .collect();
        // top-p uses *global* probabilities — normalise by the full-vocab
        // partition Z, matching candle's TopKThenTopP semantics.
        if let Some(p) = self.top_p {
            if p > 0.0 && p < 1.0 {
                let z: f32 = l
                    .iter()
                    .map(|&v| ((v - max) * inv_t).exp())
                    .sum();
                let mut order: Vec<usize> = (0..cand.len()).collect();
                order.sort_by(|&a, &b| w[b].total_cmp(&w[a]));
                // candle keeps the element that crosses the threshold
                let mut cum = 0.0f64;
                for &o in &order {
                    if cum >= p {
                        w[o] = 0.0;
                    } else {
                        cum += (w[o] / z) as f64;
                    }
                }
            }
        }
        let sum: f64 = w.iter().map(|&v| v as f64).sum();
        if sum <= 0.0 {
            return vec![(cand[0], 1.0)];
        }
        cand
            .iter()
            .zip(w.drain(..))
            .filter(|(_, p)| *p > 0.0)
            .map(|(&i, p)| (i, (p as f64 / sum) as f32))
            .collect()
    }

    fn sample(
        &mut self,
        logits: &Tensor,
        completion: &[u32],
        prompt: &[u32],
        repeat_penalty: f32,
        repeat_last_n: usize,
    ) -> Result<u32> {
        let d = self.dist(logits, completion, prompt, repeat_penalty, repeat_last_n)?;
        Ok(self.pick(&d))
    }

    /// Multinomial over a `dist` result.
    fn pick(&mut self, d: &[(u32, f32)]) -> u32 {
        if d.len() == 1 {
            return d[0].0;
        }
        let mut r = self.next_f64();
        for &(id, p) in d {
            r -= p as f64;
            if r <= 0.0 {
                return id;
            }
        }
        d[d.len() - 1].0
    }
}

/// One speculative-acceptance step for draft position `i`: the emitted
/// token under the target's own distribution. Returns `Some(token)`;
/// callers compare it to `prop.tokens[i]` to decide whether the chain
/// continues. Under greedy sampling this is simply the argmax. Under
/// temperature sampling this implements the standard rejection scheme
/// (Leviathan et al. 2023, sparse variant matching Splash's kernel):
/// accept the draft token with probability `min(1, p/q)` where `p` is
/// the target's filtered distribution and `q` the draft's top-16
/// candidate distribution; on rejection emit a token sampled from the
/// residual `max(0, p - q)` (or `p` itself if the residual is empty).
fn spec_accept_step(
    sampler: &mut Sampler,
    l: Vec<f32>,
    prop: &crate::dflash::Proposal,
    i: usize,
    completion: &[u32],
    prompt: &[u32],
    repeat_penalty: f32,
    repeat_last_n: usize,
) -> Result<u32> {
    let d = sampler.dist_vec(l, completion, prompt, repeat_penalty, repeat_last_n);
    if d.len() == 1 {
        return Ok(d[0].0); // greedy argmax
    }
    let want = prop.tokens[i];
    let p_d = d
        .iter()
        .find(|(id, _)| *id == want)
        .map(|(_, p)| *p)
        .unwrap_or(0.0);
    let q_d = prop.cand_ids[i]
        .iter()
        .position(|id| *id == want)
        .map(|j| prop.cand_probs[i][j])
        .unwrap_or(0.0);
    if p_d > 0.0
        && q_d > 0.0
        && sampler.next_f64() < ((p_d / q_d).min(1.0) as f64)
    {
        return Ok(want);
    }
    // residual over the target's support (draft-only tokens have p=0)
    let mut resid: Vec<(u32, f32)> = d
        .iter()
        .map(|&(id, p)| {
            let q = prop.cand_ids[i]
                .iter()
                .position(|c| *c == id)
                .map(|j| prop.cand_probs[i][j])
                .unwrap_or(0.0);
            (id, (p - q).max(0.0))
        })
        .collect();
    let sum: f32 = resid.iter().map(|(_, r)| *r).sum();
    if sum <= 0.0 {
        resid = d; // residual empty — fall back to the target dist
    } else {
        for r in resid.iter_mut() {
            r.1 /= sum;
        }
    }
    let mut u = sampler.next_f64();
    for &(id, p) in &resid {
        u -= p as f64;
        if u <= 0.0 {
            return Ok(id);
        }
    }
    Ok(resid[resid.len() - 1].0)
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
    let device = inner.device.clone();
    let mut pos = 0usize;
    let mut last_logits: Option<Tensor> = None;
    let mut prefill_ms_total = 0.0f64;
    for chunk in prompt_tokens.chunks(sp.prefill_step.max(32)) {
        let t = Instant::now();
        last_logits = Some(inner.backend.forward_slot(slot, chunk, pos, &device)?);
        prefill_ms_total += t.elapsed().as_secs_f64() * 1000.0;
        pos += chunk.len();
    }
    inner.backend.draft_prefill(slot)?;
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
            run.pos += 1;
            run.ttft_ms = run.started.elapsed().as_secs_f64() * 1000.0;
            if run.tx.send(GenEvent::FirstToken { ttft_ms: run.ttft_ms }).is_err() {
                run.finish = Some("cancelled");
            }
        }
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
    let temps: Vec<Option<f64>> = active
        .iter()
        .map(|&b| runs[b].as_ref().unwrap().sampler.temperature)
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
    let argmax_all: Vec<u32> = if greedy.iter().any(|&g| g) {
        logits.argmax(candle_core::D::Minus1)?.to_vec1::<u32>()?
    } else {
        Vec::new()
    };
    // greedy: the argmax readback above is the first GPU sync after
    // forward_batch, so this is where the verify pass actually lands
    // (all-sampled: the per-slot to_vec2 below syncs instead)
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
            let rows: Vec<Vec<half::bf16>> = logits
                .narrow(0, off, seq_len)?
                .to_vec2()?;
            let r = runs[b].as_mut().unwrap();
            let mut rows_it = rows.into_iter();
            for k in 0..crate::dflash::PROPOSALS {
                let row: Vec<f32> = rows_it
                    .next()
                    .unwrap()
                    .iter()
                    .map(|v| v.to_f32())
                    .collect();
                let t = spec_accept_step(
                    &mut r.sampler,
                    row,
                    prop,
                    k,
                    &r.completion,
                    &r.prompt_tokens,
                    r.sp.repeat_penalty,
                    r.sp.repeat_last_n,
                )?;
                emitted.push(t);
                if t == prop.tokens[k] {
                    accepted += 1;
                } else {
                    break;
                }
            }
            if accepted == crate::dflash::PROPOSALS {
                let row: Vec<f32> = rows_it
                    .next()
                    .unwrap()
                    .iter()
                    .map(|v| v.to_f32())
                    .collect();
                let d = r.sampler.dist_vec(
                    row,
                    &r.completion,
                    &r.prompt_tokens,
                    r.sp.repeat_penalty,
                    r.sp.repeat_last_n,
                );
                emitted.push(r.sampler.pick(&d));
            }
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
    let total_ms = r.started.elapsed().as_secs_f64() * 1000.0;
    let n_completion = r.completion.len();
    let decode_tps = if n_completion > 1 && r.decode_ms_total > 0.0 {
        (n_completion - 1) as f64 / (r.decode_ms_total / 1000.0)
    } else {
        0.0
    };
    let prefill_tps = if r.n_prompt > 0 && r.prefill_ms_total > 0.0 {
        r.n_prompt as f64 / (r.prefill_ms_total / 1000.0)
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
/// batches pick through `Sampler::dist_vec` / `spec_accept_step`.
#[cfg(test)]
mod n2_tie_tests {
    use super::*;

    fn greedy_sampler() -> Sampler {
        Sampler { temperature: None, top_k: None, top_p: None, rng: 1 }
    }

    /// The anchor / non-draft / sampled-batch greedy pick.
    fn cpu_greedy(row: Vec<f32>) -> u32 {
        let d = greedy_sampler().dist_vec(row, &[], &[], 1.0, 64);
        assert_eq!(d.len(), 1);
        d[0].0
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
        assert_eq!(cpu, want, "Sampler::dist_vec greedy must pick the lowest index on ties");
        let cpu_candle: Vec<u32> =
            Tensor::from_vec(data.clone(), (3, V), &candle_core::Device::Cpu)?
                .argmax(candle_core::D::Minus1)?
                .to_vec1()?;
        assert_eq!(cpu_candle, want, "candle CPU argmax: lowest index");
        // spec_accept_step's greedy branch (sampled-batch fallback) agrees
        let prop = crate::dflash::Proposal {
            tokens: [0; crate::dflash::PROPOSALS],
            cand_ids: Default::default(),
            cand_probs: Default::default(),
        };
        for (r, &w) in want.iter().enumerate() {
            let mut s = greedy_sampler();
            let t = spec_accept_step(&mut s, rows_f32[r].clone(), &prop, 0, &[], &[], 1.0, 64)?;
            assert_eq!(t, w, "spec_accept_step greedy row {r}");
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
        let hot = Sampler { temperature: Some(0.6), top_k: Some(20), top_p: Some(0.95), rng: 1 };
        sp.repeat_penalty = 1.0;
        assert!(!greedy_rows(&hot, &sp), "sampled slots never take argmax rows");
    }
}
