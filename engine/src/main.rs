// th-engine — Token Horizon local inference engine.
//
// A Rust/candle sidecar: loads a GGUF or safetensors LLM and serves an
// OpenAI-compatible API plus a deeper hook surface (/engine/*) than the
// engines Token Horizon supervises externally. Token Horizon spawns and
// supervises this binary; the gateway routes /th-engine/ traffic to it.

use anyhow::Result;
use clap::{Parser, Subcommand};

mod api;
mod attn_kernel;
mod dflash;
mod draft_kernel;
mod engine;
mod gdn_kernel;
mod model;
mod quant_kernel;
mod qwen35;
mod server;
mod turboquant;
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
        /// N-gram speculative-decode draft length (0 disables).
        #[arg(long, default_value_t = 4)]
        spec_tokens: usize,
        /// TurboQuant-compressed KV cache on full-attention layers
        /// (~6x less KV memory; eager ops — mainly a long-context win).
        #[arg(long, default_value_t = false)]
        kv_quant: bool,
        /// Splash-format DFlash draft directory (layer-*.bin + model.bin)
        /// — enables neural block speculative decoding on qwen3_5.
        #[arg(long)]
        draft: Option<String>,
    },
    /// Load a model, forward the given token ids, print top-8 logits.
    /// Parity/debugging aid — not used by the app.
    Probe {
        #[arg(long)]
        model: String,
        /// Comma-separated token ids to forward.
        #[arg(long)]
        tokens: String,
        /// Dump full logits (f32, little-endian) to this path.
        #[arg(long)]
        dump: Option<String>,
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
            spec_tokens,
            kv_quant,
            draft,
        } => {
            let mut cfg = state::EngineConfig::default();
            cfg.max_tokens = max_tokens;
            cfg.prefill_step = prefill_step;
            cfg.seed = seed;
            cfg.max_context = max_context;
            cfg.spec_tokens = spec_tokens.min(7);
            cfg.kv_quant = kv_quant;
            cfg.draft_dir = draft.map(std::path::PathBuf::from);
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
        Cmd::Probe { model, tokens, dump } => {
            let ids: Vec<u32> = tokens
                .split(',')
                .map(|t| t.trim().parse())
                .collect::<Result<_, _>>()?;
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if std::env::var("TH_PF_COMPILE").is_ok() {
                // compile the prefill tile library only (no model, no GPU
                // work): source errors + cold compile time
                let dev = candle_core::Device::new_metal(0)?;
                if let candle_core::Device::Metal(d) = &dev {
                    let t = std::time::Instant::now();
                    let n = quant_kernel::pf_compile(d)?;
                    eprintln!("pf library: {n} pipelines in {:.0}ms", t.elapsed().as_secs_f64() * 1e3);
                }
                return Ok(());
            }
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if std::env::var("TH_MPP_PROBE").is_ok() {
                let dev = candle_core::Device::new_metal(0)?;
                if let candle_core::Device::Metal(d) = &dev {
                    quant_kernel::mpp_probe(d);
                }
                return Ok(());
            }
            let mut loaded =
                model::resolve_and_load(&model, None, None).await?;
            let logits = loaded.backend.forward(&ids, 0, &loaded.device)?;
            let v: Vec<f32> = logits.to_vec1()?;
            if std::env::var("TH_TEST_ROLLBACK").is_ok() {
                // rollback equivalence: continuous 4-row forward must
                // match verify-8 → rollback_verify(4) bit-for-bit.
                let pos = ids.len();
                let dev = loaded.device.clone();
                let seq8: Vec<u32> = (0..8).map(|i| 1000 + i * 37).collect();
                let probe = 555u32;

                // restore points at `pos` for the two compare paths
                let snap_a = loaded.backend.snapshot(0)?;
                let snap_c = loaded.backend.snapshot(0)?;

                // reference: continuous 4-row forward
                let _ = loaded.backend.forward_multi(&seq8[..4], pos, &dev)?;
                let l_ref = loaded.backend.forward(&[probe], pos + 4, &dev)?;
                let v_ref: Vec<f32> = l_ref.to_vec1()?;

                // verify-8 → rollback_verify(kept) at several keep counts
                let mut v_test = Vec::new();
                let mut worst = 0.0f32;
                let mut kept_max = 0usize;
                for &kept in &[1usize, 4, 7, 8] {
                    loaded.backend.restore(0, snap_a.clone())?;
                    let snap_b = loaded.backend.snapshot(0)?;
                    let _ = loaded.backend.forward_multi(&seq8, pos, &dev)?;
                    // kept=8 is a no-op rollback — compare against the
                    // verify pass's own post-state, which should be
                    // bitwise identical (same kernel, same inputs)
                    if kept == 8 {
                        let l8 =
                            loaded.backend.forward(&[probe], pos + 8, &dev)?;
                        let v_ref8: Vec<f32> = l8.to_vec1()?;
                        loaded.backend.restore(0, snap_a.clone())?;
                        let snap_b = loaded.backend.snapshot(0)?;
                        let _ =
                            loaded.backend.forward_multi(&seq8, pos, &dev)?;
                        loaded.backend.rollback_verify(0, snap_b, 8)?;
                        let l_t =
                            loaded.backend.forward(&[probe], pos + 8, &dev)?;
                        let vt: Vec<f32> = l_t.to_vec1()?;
                        let vr = &v_ref8;
                        let d = vt
                            .iter()
                            .zip(vr.iter())
                            .map(|(a, b)| (a - b).abs())
                            .fold(0.0f32, f32::max);
                        eprintln!("  kept=8 (self) max|Δ|={d:.4}");
                        if d > worst {
                            worst = d;
                            kept_max = 8;
                            v_test = vt;
                        }
                        continue;
                    }
                    loaded.backend.rollback_verify(0, snap_b, kept)?;
                    let l_t =
                        loaded.backend.forward(&[probe], pos + kept, &dev)?;
                    let vt: Vec<f32> = l_t.to_vec1()?;
                    // reference for this kept: continuous kept-row forward
                    loaded.backend.restore(0, snap_c.clone())?;
                    let _ = loaded
                        .backend
                        .forward_multi(&seq8[..kept], pos, &dev)?;
                    let l_r =
                        loaded.backend.forward(&[probe], pos + kept, &dev)?;
                    let vr: Vec<f32> = l_r.to_vec1()?;
                    let d = vt
                        .iter()
                        .zip(vr.iter())
                        .map(|(a, b)| (a - b).abs())
                        .fold(0.0f32, f32::max);
                    eprintln!("  kept={kept} max|Δ|={d:.4}");
                    if d > worst {
                        worst = d;
                        kept_max = kept;
                        v_test = vt;
                    }
                }
                // control: restore + re-forward the committed rows —
                // isolates rollback_verify's state reuse from inherent
                // batch-shape (M=8 vs M=4) kernel noise.
                loaded.backend.restore(0, snap_c)?;
                let snap_d = loaded.backend.snapshot(0)?;
                let _ = loaded.backend.forward_multi(&seq8, pos, &dev)?;
                loaded.backend.restore(0, snap_d)?;
                let _ = loaded.backend.forward_multi(&seq8[..4], pos, &dev)?;
                let l_ctl = loaded.backend.forward(&[probe], pos + 4, &dev)?;
                let v_ctl: Vec<f32> = l_ctl.to_vec1()?;

                let max_diff = |a: &[f32], b: &[f32]| {
                    a.iter()
                        .zip(b.iter())
                        .map(|(x, y)| (x - y).abs())
                        .fold(0.0f32, f32::max)
                };
                let argmax = |v: &[f32]| {
                    v.iter()
                        .enumerate()
                        .max_by(|a, b| a.1.total_cmp(b.1))
                        .map(|(i, _)| i)
                        .unwrap_or(0)
                };
                let d_ct = max_diff(&v_ref, &v_ctl);
                eprintln!(
                    "rollback test: worst rollback|Δ|={worst:.4} (kept={kept_max}) refwd|Δ|={d_ct:.4} argmax ref={} rb={} ctl={} {}",
                    argmax(&v_ref),
                    argmax(&v_test),
                    argmax(&v_ctl),
                    if argmax(&v_ref) == argmax(&v_test) && worst < 0.5 {
                        "PASS"
                    } else {
                        "FAIL"
                    }
                );
            }
            // TH_BENCH_LIN=1 → decode + prefill kernel sweeps; =dec / =pf
            // → just one of them
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if let Ok(which) = std::env::var("TH_BENCH_LIN") {
                if let model::ModelBackend::Qwen35(q) =
                    &loaded.backend
                {
                    if which != "pf" {
                        q.bench_lin(&loaded.device)?;
                    }
                    if which != "dec" {
                        q.bench_prefill(&loaded.device)?;
                    }
                }
            }
            if let Ok(m) = std::env::var("TH_BENCH_MULTI") {
                let m: usize = m.parse().unwrap_or(5);
                let dev = loaded.device.clone();
                // warm
                let mut pos = ids.len();
                for _ in 0..3 {
                    let lg = loaded.backend.forward(&[1u32], pos, &dev)?;
                    pos += 1;
                    let _ = lg.to_vec1::<f32>()?;
                }
                for _ in 0..3 {
                    let t = std::time::Instant::now();
                    let lg = loaded.backend.forward(&[1u32], pos, &dev)?;
                    let _ = lg.to_vec1::<f32>()?;
                    eprintln!("fwd1  {:.1}ms", t.elapsed().as_secs_f64() * 1e3);
                    pos += 1;
                }
                for _ in 0..3 {
                    let seq = vec![1u32; m];
                    let t = std::time::Instant::now();
                    let lg =
                        loaded.backend.forward_multi(&seq, pos, &dev)?;
                    let _ =
                        lg.flatten_all()?.to_vec1::<half::bf16>()?;
                    eprintln!(
                        "fwd{m}  {:.1}ms",
                        t.elapsed().as_secs_f64() * 1e3
                    );
                    pos += m;
                }
            }
            if let Ok(spec) = std::env::var("TH_BENCH_PREFILL") {
                // prefill forward (the TTFT path): fresh state per run,
                // last-row f32 logits read back (sync). Legacy and tile
                // routing alternate run by run in this one process (order
                // flipped each pair) so clock/thermal drift hits both
                // equally; one warm-up run each first.
                let dev = loaded.device.clone();
                let mut fwd = |seq: &[u32], legacy: bool| -> Result<f64> {
                    #[cfg(all(feature = "metal", target_os = "macos"))]
                    quant_kernel::pf_force_legacy(legacy);
                    // forward() runs decode slot 0
                    loaded.backend.clear_kv_cache(0);
                    let t = std::time::Instant::now();
                    let lg = loaded.backend.forward(seq, 0, &dev)?;
                    let _ = lg.to_vec1::<f32>()?;
                    Ok(t.elapsed().as_secs_f64() * 1e3)
                };
                let stat = |v: &mut Vec<f64>| {
                    v.sort_by(|a, b| a.total_cmp(b));
                    (v[0], v[v.len() / 2])
                };
                for m in spec.split(',').filter_map(|t| t.trim().parse::<usize>().ok()) {
                    let seq: Vec<u32> = (0..m).map(|i| ids[i % ids.len()]).collect();
                    fwd(&seq, true)?;
                    fwd(&seq, false)?;
                    let (mut leg, mut til) = (Vec::new(), Vec::new());
                    for r in 0..6 {
                        for legacy in [r % 2 == 0, r % 2 != 0] {
                            let ms = fwd(&seq, legacy)?;
                            if legacy { leg.push(ms) } else { til.push(ms) }
                        }
                    }
                    let ((lmin, lmed), (tmin, tmed)) = (stat(&mut leg), stat(&mut til));
                    eprintln!(
                        "prefill m={m:4} legacy min={lmin:.1}ms med={lmed:.1}ms | tiles min={tmin:.1}ms med={tmed:.1}ms | tiles/legacy med={:.3} ({:+.1}ms) tok/s {:.0}->{:.0}",
                        tmed / lmed,
                        tmed - lmed,
                        m as f64 / lmed * 1e3,
                        m as f64 / tmed * 1e3
                    );
                }
                #[cfg(all(feature = "metal", target_os = "macos"))]
                quant_kernel::pf_force_legacy(false);
            }
            if let Some(path) = dump {
                let bytes: Vec<u8> =
                    v.iter().flat_map(|f| f.to_le_bytes()).collect();
                std::fs::write(&path, &bytes)?;
                eprintln!("wrote {} logits to {path}", v.len());
            }
            let mut idx: Vec<usize> = (0..v.len()).collect();
            idx.sort_by(|&a, &b| {
                v[b].partial_cmp(&v[a]).unwrap_or(std::cmp::Ordering::Equal)
            });
            for &i in idx.iter().take(8) {
                println!("{i}\t{:.4}", v[i]);
            }
            Ok(())
        }
    }
}
