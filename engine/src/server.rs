// HTTP layer — axum. Three surfaces:
//   - Splash-compat probes: /health /ready /status /metrics /v1/models
//   - OpenAI + Anthropic inference: /v1/chat/completions, /v1/messages
//   - TH hook surface: /engine/config /engine/requests /engine/events
//     /engine/kv/clear — the control+telemetry depth TH is for.

use crate::api::*;
use crate::engine::{DoneStats, Engine, GenEvent, RequestSampling};
use crate::state::{rss_bytes, ConfigPatch, EngineState};
use crate::template::ChatMessage;
use anyhow::Result;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::{BroadcastStream, UnboundedReceiverStream};
use tokio_stream::StreamExt;

struct App {
    engine: Engine,
    started_unix: u64,
}

pub async fn serve(engine: Engine, port: u16) -> Result<()> {
    let app = Arc::new(App {
        engine,
        started_unix: unix_now(),
    });
    let router = Router::new()
        // probes
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/status", get(status))
        .route("/metrics", get(metrics))
        // OpenAI
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat_completions))
        // Anthropic
        .route("/v1/messages", post(messages))
        // TH hook surface
        .route("/engine/status", get(engine_status))
        .route("/engine/config", get(get_config).post(patch_config))
        .route("/engine/requests", get(requests))
        .route("/engine/kv/clear", post(kv_clear))
        .route("/engine/events", get(events))
        .with_state(app);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    tracing::info!(port, "th-engine serving");
    axum::serve(listener, router).await?;
    Ok(())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// MARK: - probes

async fn health() -> Json<Value> {
    Json(json!({"status": "ok"}))
}

async fn ready() -> Json<Value> {
    // Model is loaded before the listener binds, so serving == ready.
    Json(json!({"status": "ready"}))
}

/// Splash-compatible /status so the app probes both backends uniformly —
/// `instance` carries the same shape Splash emits.
async fn status(State(app): State<Arc<App>>) -> Json<Value> {
    let s = &app.engine.state;
    Json(json!({
        "instance": {
            "engine": "th-engine",
            "version": env!("CARGO_PKG_VERSION"),
            "model": s.model_id,
            "pid": std::process::id(),
            "uptime_s": s.started.elapsed().as_secs(),
        },
        "model": s.model_meta,
        "maximum_context_tokens": s.model_meta["context_length"],
        "requests": {
            "total": s.counters.requests_total.load(Ordering::Relaxed),
            "active": s.counters.requests_active.load(Ordering::Relaxed),
            "completed": s.counters.requests_completed.load(Ordering::Relaxed),
        },
        "metrics": {
            "decode_tps": f64::from_bits(s.counters.last_decode_tps_bits.load(Ordering::Relaxed)),
        },
        "kv": {"tokens": s.kv_tokens.load(Ordering::Relaxed)},
        "memory": {"rss_bytes": rss_bytes()},
        "rss_bytes": rss_bytes(),
    }))
}

/// Deeper introspection — the full tunable config + model meta + counters.
async fn engine_status(State(app): State<Arc<App>>) -> Json<Value> {
    let s = &app.engine.state;
    let cfg = s.config.read().unwrap();
    Json(json!({
        "engine": "th-engine",
        "version": env!("CARGO_PKG_VERSION"),
        "model": {"id": s.model_id, "meta": s.model_meta},
        "config": *cfg,
        "kv": {"tokens": s.kv_tokens.load(Ordering::Relaxed)},
        "memory": {"rss_bytes": rss_bytes()},
        "requests": {
            "total": s.counters.requests_total.load(Ordering::Relaxed),
            "active": s.counters.requests_active.load(Ordering::Relaxed),
            "prompt_tokens_total": s.counters.prompt_tokens_total.load(Ordering::Relaxed),
            "completion_tokens_total": s.counters.completion_tokens_total.load(Ordering::Relaxed),
        },
        "uptime_s": s.started.elapsed().as_secs(),
        "started_unix": app.started_unix,
    }))
}

async fn metrics(State(app): State<Arc<App>>) -> Response {
    let s = &app.engine.state;
    let mut out = String::new();
    let mut emit = |name: &str, help: &str, v: u64| {
        out.push_str(&format!("# HELP {name} {help}\n# TYPE {name} counter\n{name} {v}\n"));
    };
    emit("th_requests_total", "Total requests", s.counters.requests_total.load(Ordering::Relaxed));
    emit("th_prompt_tokens_total", "Prompt tokens", s.counters.prompt_tokens_total.load(Ordering::Relaxed));
    emit("th_completion_tokens_total", "Completion tokens", s.counters.completion_tokens_total.load(Ordering::Relaxed));
    let buckets = &s.counters.decode_latency_buckets;
    let bounds = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0, 256.0];
    out.push_str("# HELP th_decode_ms_bucket Per-token decode latency\n# TYPE th_decode_ms_bucket histogram\n");
    let mut cum = 0u64;
    for (i, b) in buckets.iter().enumerate() {
        cum += b.load(Ordering::Relaxed);
        if i < bounds.len() {
            out.push_str(&format!("th_decode_ms_bucket{{le=\"{}\"}} {}\n", bounds[i], cum));
        }
    }
    out.push_str(&format!("th_decode_ms_bucket{{le=\"+Inf\"}} {}\n", cum));
    out.push_str(&format!("# TYPE th_kv_tokens gauge\nth_kv_tokens {}\n", s.kv_tokens.load(Ordering::Relaxed)));
    out.push_str(&format!("# TYPE th_rss_bytes gauge\nth_rss_bytes {}\n", rss_bytes()));
    (StatusCode::OK, [("content-type", "text/plain; version=0.0.4")], out).into_response()
}

// MARK: - inference

async fn models(State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!({
        "object": "list",
        "data": [{"id": app.engine.state.model_id, "object": "model", "created": app.started_unix, "owned_by": "th-engine"}],
    }))
}

async fn chat_completions(
    State(app): State<Arc<App>>,
    Json(req): Json<ChatCompletionsRequest>,
) -> Response {
    let model_id = app.engine.state.model_id.clone();
    let messages: Vec<ChatMessage> = req
        .messages
        .iter()
        .map(|m| ChatMessage { role: m.role.clone(), content: m.text() })
        .collect();
    if messages.is_empty() {
        return err(StatusCode::BAD_REQUEST, "messages is empty");
    }
    let sampling = RequestSampling {
        temperature: req.temperature,
        top_p: req.top_p,
        top_k: req.top_k,
        repeat_penalty: req.repeat_penalty,
        max_tokens: req.max_completion_tokens.or(req.max_tokens),
        seed: req.seed,
        stop: req.stop.map(Stop::into_vec),
    };
    let id = format!("chatcmpl-{:x}", unix_now_ns());
    run_chat(app, id, model_id, messages, sampling, req.stream).await
}

fn unix_now_ns() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Shared driver: streams SSE chunks when `stream`, else collects and
/// returns one OpenAI-shaped completion.
async fn run_chat(
    app: Arc<App>,
    id: String,
    model_id: String,
    messages: Vec<ChatMessage>,
    sampling: RequestSampling,
    stream: bool,
) -> Response {
    let (tx, rx) = mpsc::unbounded_channel::<GenEvent>();
    app.engine.generate(messages, sampling, tx).await;

    if !stream {
        let mut rx = rx;
        let mut text = String::new();
        let mut done: Option<Box<DoneStats>> = None;
        while let Some(ev) = rx.recv().await {
            match ev {
                GenEvent::Delta(d) => text.push_str(&d),
                GenEvent::Done(s) => done = Some(s),
                GenEvent::Error(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e),
                GenEvent::FirstToken { .. } => {}
            }
        }
        let d = done.map(|s| *s).unwrap_or(DoneStats {
            prompt_tokens: 0, completion_tokens: 0, ttft_ms: 0.0,
            total_ms: 0.0, decode_tps: 0.0, prefill_tps: 0.0, finish: "stop".into(),
        });
        return Json(json!({
            "id": id, "object": "chat.completion", "created": unix_now(),
            "model": model_id,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                         "finish_reason": d.finish}],
            "usage": {"prompt_tokens": d.prompt_tokens,
                      "completion_tokens": d.completion_tokens,
                      "total_tokens": d.prompt_tokens + d.completion_tokens},
            "th_stats": {"ttft_ms": d.ttft_ms, "decode_tps": d.decode_tps,
                         "prefill_tps": d.prefill_tps, "total_ms": d.total_ms},
        }))
        .into_response();
    }

    // SSE stream: role chunk → delta chunks → finish chunk + usage → [DONE]
    let stream = UnboundedReceiverStream::new(rx).map(move |ev| {
        let chunk = |delta: Value, finish: Value| {
            json!({"id": id, "object": "chat.completion.chunk", "created": unix_now(),
                   "model": model_id,
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
        };
        Ok::<Event, Infallible>(match ev {
            GenEvent::FirstToken { ttft_ms } => Event::default().event("th.ttft")
                .data(json!({"ttft_ms": ttft_ms}).to_string()),
            GenEvent::Delta(d) => Event::default().data(
                chunk(json!({"content": d}), Value::Null).to_string()),
            GenEvent::Done(s) => {
                let mut o = chunk(json!({}), json!(s.finish)).as_object().cloned().unwrap_or_default();
                o.insert("usage".into(), json!({"prompt_tokens": s.prompt_tokens,
                    "completion_tokens": s.completion_tokens,
                    "total_tokens": s.prompt_tokens + s.completion_tokens}));
                o.insert("th_stats".into(), json!({"ttft_ms": s.ttft_ms,
                    "decode_tps": s.decode_tps, "prefill_tps": s.prefill_tps,
                    "total_ms": s.total_ms}));
                Event::default().data(Value::Object(o).to_string())
            }
            GenEvent::Error(e) => Event::default().event("error")
                .data(json!({"error": e}).to_string()),
        })
    });
    let stream = stream.chain(tokio_stream::once(Ok::<Event, Infallible>(Event::default().data("[DONE]"))));
    Sse::new(stream).into_response()
}

// MARK: - Anthropic Messages

async fn messages(State(app): State<Arc<App>>, Json(req): Json<MessagesRequest>) -> Response {
    let mut msgs: Vec<ChatMessage> = Vec::new();
    if let Some(sys) = &req.system {
        let t = sys.text();
        if !t.is_empty() {
            msgs.push(ChatMessage { role: "system".into(), content: t });
        }
    }
    for m in &req.messages {
        msgs.push(ChatMessage { role: m.role.clone(), content: m.text() });
    }
    let sampling = RequestSampling {
        temperature: req.temperature,
        top_p: req.top_p,
        top_k: req.top_k,
        max_tokens: req.max_tokens,
        stop: req.stop_sequences,
        ..Default::default()
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<GenEvent>();
    app.engine.generate(msgs, sampling, tx).await;

    let mut text = String::new();
    let mut done: Option<Box<DoneStats>> = None;
    while let Some(ev) = rx.recv().await {
        match ev {
            GenEvent::Delta(d) => text.push_str(&d),
            GenEvent::Done(s) => done = Some(s),
            GenEvent::Error(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e),
            _ => {}
        }
    }
    let d = done.map(|s| *s).unwrap_or(DoneStats {
        prompt_tokens: 0, completion_tokens: 0, ttft_ms: 0.0,
        total_ms: 0.0, decode_tps: 0.0, prefill_tps: 0.0, finish: "stop".into(),
    });
    Json(json!({
        "id": format!("msg_{:x}", unix_now_ns()),
        "type": "message", "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "model": app.engine.state.model_id,
        "stop_reason": if d.finish == "length" { "max_tokens" } else { "end_turn" },
        "usage": {"input_tokens": d.prompt_tokens, "output_tokens": d.completion_tokens},
    }))
    .into_response()
}

// MARK: - hooks

async fn get_config(State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!(app.engine.config()))
}

async fn patch_config(
    State(app): State<Arc<App>>,
    Json(patch): Json<ConfigPatch>,
) -> Json<Value> {
    {
        let mut cfg = app.engine.state.config.write().unwrap();
        cfg.apply_patch(patch);
    }
    app.engine
        .state
        .emit("config.updated", serde_json::json!(app.engine.config()));
    Json(json!({"ok": true, "config": app.engine.config()}))
}

async fn requests(State(app): State<Arc<App>>) -> Json<Value> {
    let ring = app.engine.state.requests.read().unwrap();
    Json(json!(ring.iter().collect::<Vec<_>>()))
}

async fn kv_clear(State(app): State<Arc<App>>) -> Json<Value> {
    app.engine.kv_clear().await;
    Json(json!({"ok": true}))
}

/// SSE broadcast of lifecycle events — request.start/done, config.updated,
/// kv.cleared. TH tails this for live engine telemetry.
async fn events(State(app): State<Arc<App>>) -> Response {
    let rx = app.engine.state.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|r| match r {
        Ok(v) => Some(Ok::<Event, Infallible>(Event::default().data(v.to_string()))),
        Err(_) => None,
    });
    Sse::new(stream).into_response()
}

fn err(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({"error": {"message": msg}}))).into_response()
}

// Silence unused-import warnings for items used in later milestones.
#[allow(unused)]
fn _unused(s: &EngineState) {}
