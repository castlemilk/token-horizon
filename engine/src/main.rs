// th-engine — Token Horizon local inference engine.
//
// A Rust/candle sidecar: loads a GGUF or safetensors LLM and serves an
// OpenAI-compatible API plus a deeper hook surface (/engine/*) than the
// engines Token Horizon supervises externally. Token Horizon spawns and
// supervises this binary; the gateway routes /th-engine/ traffic to it.

use anyhow::Result;
use clap::{Parser, Subcommand};

mod api;
mod engine;
mod model;
mod server;
mod state;
mod template;

#[derive(Parser)]
#[command(name = "th-engine", version, about = "Token Horizon inference engine")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Load a model and serve the inference API.
    Serve {
        /// HF repo id ("Qwen/Qwen3-32B-GGUF", optional "repo:file.gguf")
        /// or a local path (dir of safetensors or a .gguf file).
        #[arg(long)]
        model: String,
        /// Specific file inside the HF repo (GGUF quant, safetensors index).
        #[arg(long)]
        file: Option<String>,
        /// Tokenizer source override — HF repo id or local dir. Needed when
        /// the weights repo doesn't ship tokenizer.json (common for GGUF).
        #[arg(long)]
        tokenizer: Option<String>,
        /// Listen port.
        #[arg(long, default_value_t = 8001)]
        port: u16,
        /// Sampling defaults applied to requests that don't override them.
        #[arg(long)]
        temperature: Option<f64>,
        #[arg(long)]
        top_p: Option<f64>,
        #[arg(long)]
        top_k: Option<usize>,
        #[arg(long)]
        repeat_penalty: Option<f32>,
        #[arg(long)]
        repeat_last_n: Option<usize>,
        /// Default completion cap when a request omits max_tokens.
        #[arg(long, default_value_t = 512)]
        max_tokens: usize,
        /// Prefill chunk size (prompt tokens per forward pass). Smaller
        /// values smooth memory pressure on long prompts.
        #[arg(long, default_value_t = 512)]
        prefill_step: usize,
        /// RNG seed for sampling (0 = nondeterministic).
        #[arg(long, default_value_t = 0)]
        seed: u64,
        /// Hard context ceiling: reject prompts whose total length
        /// (prompt + max_tokens) would exceed this many KV positions.
        #[arg(long)]
        max_context: Option<usize>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Cmd::Serve {
            model,
            file,
            tokenizer,
            port,
            temperature,
            top_p,
            top_k,
            repeat_penalty,
            repeat_last_n,
            max_tokens,
            prefill_step,
            seed,
            max_context,
        } => {
            let mut cfg = state::EngineConfig::default();
            cfg.max_tokens = max_tokens;
            cfg.prefill_step = prefill_step;
            cfg.seed = seed;
            cfg.max_context = max_context;
            if let Some(t) = temperature {
                cfg.temperature = Some(t);
            }
            if let Some(p) = top_p {
                cfg.top_p = Some(p);
            }
            if let Some(k) = top_k {
                cfg.top_k = Some(k);
            }
            if let Some(r) = repeat_penalty {
                cfg.repeat_penalty = r;
            }
            if let Some(n) = repeat_last_n {
                cfg.repeat_last_n = n;
            }

            let engine =
                engine::Engine::load(&model, file.as_deref(), tokenizer.as_deref(), cfg).await?;
            server::serve(engine, port).await
        }
    }
}
