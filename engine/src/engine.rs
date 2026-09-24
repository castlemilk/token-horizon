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
use anyhow::{bail, Result};
use candle_core::{DType, IndexOp, Tensor};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

pub struct Engine {
    inner: Arc<tokio::sync::Mutex<ModelInner>>,
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
        if cfg.kv_quant {
            if let model::ModelBackend::Qwen35(m) = &mut loaded.backend {
                m.enable_kv_quant()?;
            }
        }
        let model_id = model.to_string();
        let meta = loaded.meta.clone();
        let inner = ModelInner {
            backend: loaded.backend,
            tokenizer: loaded.tokenizer,
            eos_ids: loaded.eos_ids,
            chat_template: loaded.chat_template,
            device: loaded.device,
        };
        Ok(Self {
            inner: Arc::new(tokio::sync::Mutex::new(inner)),
            state: Arc::new(EngineState::new(model_id, meta, cfg)),
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
        inner.backend.clear_kv_cache();
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
    inner.backend.clear_kv_cache();
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
    let mut accept_ema = 1.5f64;
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
            let snap = inner.backend.snapshot()?;
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
                inner.backend.restore(snap);
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

    fn sample(
        &mut self,
        logits: &Tensor,
        completion: &[u32],
        prompt: &[u32],
        repeat_penalty: f32,
        repeat_last_n: usize,
    ) -> Result<u32> {
        let mut l = if logits.dtype() == DType::F32 {
            logits.to_vec1::<f32>()?
        } else {
            logits.to_dtype(DType::F32)?.to_vec1::<f32>()?
        };
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
            // argmax on CPU — we already have the vec
            return Ok(l
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|(i, _)| i as u32)
                .unwrap_or(0));
        };
        let inv_t = 1.0 / temp as f32;
        // top-k candidate set via partial select (O(n))
        let k = self.top_k.unwrap_or(n).min(n);
        let mut idx: Vec<u32> = (0..n as u32).collect();
        let cand = if k < n {
            idx.select_nth_unstable_by(k - 1, |&a, &b| {
                l[b as usize].total_cmp(&l[a as usize])
            });
            &mut idx[..k]
        } else {
            &mut idx[..]
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
        // linear-scan multinomial over candidate weights
        let sum: f64 = w.iter().map(|&v| v as f64).sum();
        if sum <= 0.0 {
            return Ok(cand[0]);
        }
        let mut r = self.next_f64() * sum;
        for (j, &wi) in w.iter().enumerate() {
            r -= wi as f64;
            if r <= 0.0 {
                return Ok(cand[j]);
            }
        }
        Ok(cand[cand.len() - 1])
    }
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
