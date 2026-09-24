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
use candle_core::Tensor;
use candle_transformers::generation::{LogitsProcessor, Sampling};
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
}

impl Engine {
    pub async fn load(
        model: &str,
        file: Option<&str>,
        tokenizer_src: Option<&str>,
        cfg: EngineConfig,
    ) -> Result<Self> {
        let loaded = model::resolve_and_load(model, file, tokenizer_src).await?;
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
        let state2 = state.clone();
        let id2 = id.clone();
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
        })
        .await
        .ok();
        let _ = id2;
        let _ = state2;
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

    inner.backend.clear_kv_cache();
    let device = inner.device.clone();
    let eos_ids = inner.eos_ids.clone();
    let cancel = Arc::new(AtomicBool::new(false));

    let mut logits_proc = LogitsProcessor::from_sampling(
        sp.seed.max(1),
        sampling_for(&sp),
    );

    let mut pos = 0usize;
    let mut next_token: Option<u32> = None;
    let mut completion: Vec<u32> = Vec::new();
    let mut text_out = String::new();
    let mut ttft_ms = 0.0f64;
    let mut finish = "stop";
    let mut decode_ms_total = 0.0f64;
    let mut prefill_ms_total = 0.0f64;

    // --- prefill: chunked forward over the prompt, sample once at the end
    let mut last_logits: Option<Tensor> = None;
    for chunk in prompt_tokens.chunks(sp.prefill_step.max(32)) {
        let t = Instant::now();
        last_logits = Some(inner.backend.forward(chunk, pos, &device)?);
        prefill_ms_total += t.elapsed().as_secs_f64() * 1000.0;
        pos += chunk.len();
    }
    if let Some(logits) = last_logits {
        next_token = Some(sample(
            &mut logits_proc,
            &logits,
            &completion,
            &prompt_tokens,
            sp.repeat_penalty,
            sp.repeat_last_n,
        )?);
    }

    // first sampled token = TTFT boundary
    if next_token.is_some() {
        ttft_ms = started.elapsed().as_secs_f64() * 1000.0;
        if tx.send(GenEvent::FirstToken { ttft_ms }).is_err() {
            cancel.store(true, Ordering::Relaxed);
        }
    }

    // --- decode: one token per forward
    loop {
        let Some(tok) = next_token else { break };
        if cancel.load(Ordering::Relaxed) {
            finish = "cancelled";
            break;
        }
        completion.push(tok);
        state.kv_tokens.store((pos + 1) as u64, Ordering::Relaxed);

        if eos_ids.contains(&tok) {
            break;
        }
        let piece = inner
            .tokenizer
            .decode(&[tok], true)
            .unwrap_or_default();
        text_out.push_str(&piece);
        if tx.send(GenEvent::Delta(piece)).is_err() {
            finish = "cancelled";
            break;
        }
        if stop_hit(&text_out, &sp.stop) {
            truncate_at_stop(&mut text_out, &sp.stop);
            break;
        }
        if completion.len() >= sp.max_tokens {
            finish = "length";
            break;
        }
        if let Some(max_ctx) = sp.max_context {
            if pos >= max_ctx {
                finish = "length";
                break;
            }
        }

        let t = Instant::now();
        let logits = inner.backend.forward(&[tok], pos, &device)?;
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        decode_ms_total += ms;
        state.counters.observe_decode(ms);
        pos += 1;
        next_token = Some(sample(
            &mut logits_proc,
            &logits,
            &completion,
            &prompt_tokens,
            sp.repeat_penalty,
            sp.repeat_last_n,
        )?);
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

fn sampling_for(sp: &ResolvedSampling) -> Sampling {
    let t = match sp.temperature {
        Some(t) if t > 0.0 => t,
        _ => return Sampling::ArgMax,
    };
    match (sp.top_k, sp.top_p) {
        (Some(k), Some(p)) => Sampling::TopKThenTopP { k, p, temperature: t },
        (Some(k), None) => Sampling::TopK { k, temperature: t },
        (None, Some(p)) => Sampling::TopP { p, temperature: t },
        (None, None) => Sampling::All { temperature: t },
    }
}

fn sample(
    proc: &mut LogitsProcessor,
    logits: &Tensor,
    completion: &[u32],
    prompt: &[u32],
    repeat_penalty: f32,
    repeat_last_n: usize,
) -> Result<u32> {
    let logits = logits.to_dtype(candle_core::DType::F32)?;
    if (repeat_penalty - 1.0).abs() < f32::EPSILON {
        return Ok(proc.sample(&logits)?);
    }
    // penalty over the trailing window of prompt+completion
    let window: Vec<u32> = prompt
        .iter()
        .chain(completion.iter())
        .copied()
        .collect::<Vec<u32>>()
        .into_iter()
        .rev()
        .take(repeat_last_n)
        .collect();
    proc.sample_f(&logits, |l| {
        for &tid in &window {
            let tid = tid as usize;
            if tid < l.len() {
                l[tid] = if l[tid] < 0.0 {
                    l[tid] * repeat_penalty
                } else {
                    l[tid] / repeat_penalty
                };
            }
        }
    })
    .map_err(Into::into)
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
