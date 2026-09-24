// Engine state: live-tunable sampling/config, request stats ring, metrics.
//
// This is the hook surface that distinguishes th-engine from a closed
// engine — every tunable is read per-request so POST /engine/config takes
// effect on the next token without a reload.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::Instant;

/// Live-tunable engine configuration. `POST /engine/config` patches any
/// subset; generation reads a snapshot per request.
#[derive(Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    /// None = greedy (argmax). Otherwise softmax temperature.
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<usize>,
    /// 1.0 = disabled. Applied over the last `repeat_last_n` tokens.
    #[serde(default = "default_repeat_penalty")]
    pub repeat_penalty: f32,
    #[serde(default = "default_repeat_last_n")]
    pub repeat_last_n: usize,
    /// Default completion cap when a request omits max_tokens.
    #[serde(default = "default_max_tokens")]
    pub max_tokens: usize,
    /// Prompt tokens per forward pass during prefill.
    #[serde(default = "default_prefill_step")]
    pub prefill_step: usize,
    /// N-gram speculative-decode draft length (0 = off, max 7).
    #[serde(default = "default_spec_tokens")]
    pub spec_tokens: usize,
    /// TurboQuant-style compressed KV cache on the full-attention
    /// layers (rotated + codebook-quantised, ~2-bit). Load-time only —
    /// changing it via /engine/config takes effect on the next load.
    #[serde(default)]
    pub kv_quant: bool,
    /// 0 = nondeterministic.
    pub seed: u64,
    /// Hard ceiling on total KV positions (prompt + completion).
    pub max_context: Option<usize>,
}

fn default_repeat_penalty() -> f32 {
    1.0
}
fn default_repeat_last_n() -> usize {
    64
}
fn default_max_tokens() -> usize {
    512
}
fn default_prefill_step() -> usize {
    512
}
fn default_spec_tokens() -> usize {
    4
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            temperature: Some(0.7),
            top_p: Some(0.8),
            top_k: Some(20),
            repeat_penalty: 1.0,
            repeat_last_n: 64,
            max_tokens: 512,
            prefill_step: 512,
            spec_tokens: 4,
            kv_quant: false,
            seed: 0,
            max_context: None,
        }
    }
}

/// Partial update for POST /engine/config — every field optional.
#[derive(Deserialize, Default)]
pub struct ConfigPatch {
    pub temperature: Option<Option<f64>>,
    pub top_p: Option<Option<f64>>,
    pub top_k: Option<Option<usize>>,
    pub repeat_penalty: Option<f32>,
    pub repeat_last_n: Option<usize>,
    pub max_tokens: Option<usize>,
    pub prefill_step: Option<usize>,
    pub spec_tokens: Option<usize>,
    pub kv_quant: Option<bool>,
    pub seed: Option<u64>,
    pub max_context: Option<Option<usize>>,
}

impl EngineConfig {
    pub fn apply_patch(&mut self, p: ConfigPatch) {
        if let Some(v) = p.temperature {
            self.temperature = v;
        }
        if let Some(v) = p.top_p {
            self.top_p = v;
        }
        if let Some(v) = p.top_k {
            self.top_k = v;
        }
        if let Some(v) = p.repeat_penalty {
            self.repeat_penalty = v;
        }
        if let Some(v) = p.repeat_last_n {
            self.repeat_last_n = v;
        }
        if let Some(v) = p.max_tokens {
            self.max_tokens = v;
        }
        if let Some(v) = p.prefill_step {
            self.prefill_step = v.max(32);
        }
        if let Some(v) = p.spec_tokens {
            self.spec_tokens = v.min(7);
        }
        if let Some(v) = p.kv_quant {
            self.kv_quant = v;
        }
        if let Some(v) = p.seed {
            self.seed = v;
        }
        if let Some(v) = p.max_context {
            self.max_context = v;
        }
    }
}

/// One completed (or aborted) generation, for the /engine/requests ring.
#[derive(Clone, Serialize)]
pub struct RequestRecord {
    pub id: String,
    pub started_ms: u64,
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
    pub ttft_ms: f64,
    pub total_ms: f64,
    /// Decode-only throughput (completion tokens minus the first).
    pub decode_tps: f64,
    pub finish: String, // "stop" | "length" | "cancelled" | "error"
}

pub struct Counters {
    pub requests_total: AtomicU64,
    pub requests_active: AtomicU64,
    pub prompt_tokens_total: AtomicU64,
    pub completion_tokens_total: AtomicU64,
    /// Per-token decode latency histogram, log2-ms buckets
    /// (<1, 1-2, 2-4, 4-8, 8-16, 16-32, 32-64, 64-128, 128-256, 256+).
    pub decode_latency_buckets: [AtomicU64; 10],
    /// Decode tok/s of the most recent completed request (f64 bits) —
    /// what /status reports as the live throughput figure.
    pub last_decode_tps_bits: AtomicU64,
    /// Requests that completed (any finish reason) — tab reads
    /// requests.completed.
    pub requests_completed: AtomicU64,
}

impl Default for Counters {
    fn default() -> Self {
        Self {
            requests_total: AtomicU64::new(0),
            requests_active: AtomicU64::new(0),
            prompt_tokens_total: AtomicU64::new(0),
            completion_tokens_total: AtomicU64::new(0),
            decode_latency_buckets: Default::default(),
            last_decode_tps_bits: AtomicU64::new(0),
            requests_completed: AtomicU64::new(0),
        }
    }
}

impl Counters {
    pub fn observe_decode(&self, ms: f64) {
        let b = if ms < 1.0 {
            0
        } else if ms >= 256.0 {
            9
        } else {
            (ms.log2().floor() as usize).min(9)
        };
        self.decode_latency_buckets[b].fetch_add(1, Ordering::Relaxed);
    }
}

/// Shared mutable state — one instance behind the HTTP layer.
pub struct EngineState {
    pub config: RwLock<EngineConfig>,
    pub requests: RwLock<VecDeque<RequestRecord>>,
    pub counters: Counters,
    pub started: Instant,
    /// Model identifier string + load-time metadata for /status.
    pub model_id: String,
    pub model_meta: serde_json::Value,
    /// KV positions currently occupied across the model's cache.
    /// The generation loop publishes after each forward; /status reports it.
    pub kv_tokens: AtomicU64,
    /// Broadcast lifecycle events (request start/finish, config change,
    /// kv clear) for the /engine/events SSE stream.
    pub events: tokio::sync::broadcast::Sender<serde_json::Value>,
}

impl EngineState {
    pub fn new(model_id: String, model_meta: serde_json::Value, config: EngineConfig) -> Self {
        let (events, _) = tokio::sync::broadcast::channel(256);
        Self {
            config: RwLock::new(config),
            requests: RwLock::new(VecDeque::with_capacity(101)),
            counters: Counters::default(),
            started: Instant::now(),
            model_id,
            model_meta,
            kv_tokens: AtomicU64::new(0),
            events,
        }
    }

    pub fn record(&self, rec: RequestRecord) {
        self.counters
            .last_decode_tps_bits
            .store(rec.decode_tps.to_bits(), Ordering::Relaxed);
        self.counters
            .requests_completed
            .fetch_add(1, Ordering::Relaxed);
        let mut ring = self.requests.write().unwrap();
        if ring.len() >= 100 {
            ring.pop_front();
        }
        ring.push_back(rec);
    }

    pub fn emit(&self, kind: &str, data: serde_json::Value) {
        let _ = self.events.send(serde_json::json!({
            "type": kind,
            "ts_ms": self.started.elapsed().as_millis() as u64,
            "data": data,
        }));
    }
}

/// Process RSS via mach task_info — no extra deps beyond libc.
pub fn rss_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    #[allow(deprecated)] // libc::mach_task_self — mach2 not worth a dep for one call
    unsafe {
        let mut info: libc::mach_task_basic_info = std::mem::zeroed();
        let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
        let kr = libc::task_info(
            libc::mach_task_self(),
            libc::MACH_TASK_BASIC_INFO,
            &mut info as *mut _ as libc::task_info_t,
            &mut count,
        );
        if kr == libc::KERN_SUCCESS as i32 {
            return info.resident_size;
        }
    }
    0
}
