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
        let meta = loaded.meta.clone();
        let nslots = loaded.backend.nslots();
        let inner = ModelInner {
            backend: loaded.backend,
            tokenizer: loaded.tokenizer,
            eos_ids: loaded.eos_ids,
            chat_template: loaded.chat_template,
            device: loaded.device,
        };
        let inner = Arc::new(tokio::sync::Mutex::new(inner));
        let state = Arc::new(EngineState::new(model_id, meta, cfg));
        let job_tx = if nslots > 1 {
            let (tx, rx) =
                std::sync::mpsc::sync_channel::<BatchJob>(nslots * 8);
            let (i2, s2) = (inner.clone(), state.clone());
            std::thread::Builder::new()
                .name("th-batch".into())
                .spawn(move || batch_loop(i2, s2, rx, nslots))?;
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
                Err(_) => {
                    let _ = tx.send(GenEvent::Error("batch queue full".into()));
                    state.counters.requests_active.fetch_sub(1, Ordering::Relaxed);
                    return;
                }
            }
        }
        // fire-and-forget: awaiting the JoinHandle would buffer every
        // delta until generation completes and break SSE streaming
        tokio::task::spawn_blocking(move || {
            let started = Instant::now();
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
    pub async fn kv_clear(&self) {
        let mut inner = self.inner.lock().await;
        inner.backend.clear_kv_cache(0);
        self.state.kv_tokens.store(0, Ordering::Relaxed);
        self.state.emit("kv.cleared", serde_json::json!({}));
    }

    pub fn config(&self) -> EngineConfig {
        self.state.config.read().unwrap().clone()
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
    let mut text_out = String::new();
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
                    // Adaptive verify length: extra rows cost ~8ms each,
                    // so cap the chain near the observed accept rate.
                    // EMA of accepted proposals/round + 1 headroom.
                    let verify_len = ((accept_ema + 0.5) as usize + 1)
                        .clamp(2, crate::dflash::PROPOSALS);
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
                    let greedy = sampler.temperature.is_none()
                        && ((sp.repeat_penalty - 1.0).abs() < f32::EPSILON
                            || sp.repeat_last_n == 0);
                    let mut rows: Vec<Vec<half::bf16>> = Vec::new();
                    let mut argmax_rows: Vec<u32> = Vec::new();
                    if greedy {
                        argmax_rows =
                            logits_m.argmax(candle_core::D::Minus1)?.to_vec1::<u32>()?;
                    } else {
                        rows = logits_m.to_vec2()?;
                    }
                    let t_verify = t0.elapsed();
                    if std::env::var("TH_DEBUG_TIMING").is_ok() {
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
                    if std::env::var("TH_DEBUG_TIMING").is_ok() {
                        eprintln!(
                            "[dflash] anchor={anchor} prop={:?} emitted={emitted:?} acc={accepted} step={step_ms:.1}ms propose={:.0} verify={:.0} rest={:.0}",
                            prop.tokens,
                            t_prop.as_secs_f64() * 1e3,
                            (t_verify - t_prop).as_secs_f64() * 1e3,
                            (t0.elapsed() - t_verify).as_secs_f64() * 1e3
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
            if std::env::var("TH_DEBUG_TIMING").is_ok() {
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
        if std::env::var("TH_DEBUG_TIMING").is_ok() {
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
            let i = l
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|(i, _)| i as u32)
                .unwrap_or(0);
            return vec![(i, 1.0)];
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

fn stop_hit(text: &str, stops: &[String]) -> bool {
    stops.iter().any(|s| !s.is_empty() && text.contains(s.as_str()))
}

fn truncate_at_stop(text: &mut String, stops: &[String]) {
    for s in stops {
        if let Some(i) = text.find(s.as_str()) {
            text.truncate(i);
        }
    }
}

// MARK: - emit + n-gram draft

enum Emit {
    More,
    Done(&'static str),
}

/// Everything `emit_token` needs — bundled so the decode loop stays
/// readable.
struct EmitCtx<'a> {
    completion: &'a mut Vec<u32>,
    hist: &'a mut Vec<u32>,
    text_out: &'a mut String,
    tx: &'a mpsc::UnboundedSender<GenEvent>,
    tokenizer: &'a tokenizers::Tokenizer,
    eos_ids: &'a [u32],
    stops: &'a [String],
    cancel: &'a AtomicBool,
    state: &'a EngineState,
    max_tokens: usize,
    max_ctx: Option<usize>,
}

/// Commit one token: record it, publish the delta, apply stop rules.
/// `pos` is the token's absolute KV index.
fn emit_token(c: &mut EmitCtx, tok: u32, pos: usize) -> Emit {
    c.completion.push(tok);
    c.hist.push(tok);
    c.state.kv_tokens.store((pos + 1) as u64, Ordering::Relaxed);
    if c.cancel.load(Ordering::Relaxed) {
        return Emit::Done("cancelled");
    }
    if c.eos_ids.contains(&tok) {
        return Emit::Done("stop");
    }
    let piece = c.tokenizer.decode(&[tok], true).unwrap_or_default();
    c.text_out.push_str(&piece);
    if c.tx.send(GenEvent::Delta(piece)).is_err() {
        return Emit::Done("cancelled");
    }
    if stop_hit(c.text_out, c.stops) {
        truncate_at_stop(c.text_out, c.stops);
        return Emit::Done("stop");
    }
    if c.completion.len() >= c.max_tokens {
        return Emit::Done("length");
    }
    if let Some(m) = c.max_ctx {
        if pos + 1 >= m {
            return Emit::Done("length");
        }
    }
    Emit::More
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
    text_out: String,
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
                    match admit(&mut inner, &state, s, job) {
                        Ok(r) => runs[s] = r,
                        Err(e) => {
                            tracing::warn!(error = %e, "batch admit failed");
                        }
                    }
                }
            }
            if let Err(e) = batch_round(&mut inner, &state, &mut runs) {
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
                    finish_run(&state, r);
                }
            }
        }
        std::thread::yield_now();
    }
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
        text_out: String::new(),
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
    // greedy-only fast path: one argmax readback for all slots
    let all_greedy = active.iter().all(|&b| {
        let r = runs[b].as_ref().unwrap();
        r.sampler.temperature.is_none()
            && ((r.sp.repeat_penalty - 1.0).abs() < f32::EPSILON
                || r.sp.repeat_last_n == 0)
    });
    let argmax_all: Vec<u32> = if all_greedy {
        logits.argmax(candle_core::D::Minus1)?.to_vec1::<u32>()?
    } else {
        Vec::new()
    };
    // per-slot accept / emit / commit / rollback
    for (i, &b) in active.iter().enumerate() {
        let prop = &props[i];
        let mut emitted: Vec<u32> = Vec::with_capacity(8);
        let mut accepted = 0usize;
        let seq_len = seqs[i].len(); // = 8
        let off = i * seq_len;
        if all_greedy {
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
    let step_ms = t_verify.as_secs_f64() * 1000.0;
    if std::env::var("TH_DEBUG_TIMING").is_ok() {
        eprintln!(
            "  [batch] nb={} propose={:.1}ms verify={:.1}ms total={:.1}ms",
            active.len(),
            t_fwd.as_secs_f64() * 1e3,
            (t_verify - t_fwd).as_secs_f64() * 1e3,
            step_ms
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
