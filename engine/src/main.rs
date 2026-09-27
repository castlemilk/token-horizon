// th-engine — Token Horizon local inference engine.
//
// A Rust/candle sidecar: loads a GGUF or safetensors LLM and serves an
// OpenAI-compatible API plus a deeper hook surface (/engine/*) than the
// engines Token Horizon supervises externally. Token Horizon spawns and
// supervises this binary; the gateway routes /th-engine/ traffic to it.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

mod api;
#[cfg(all(feature = "metal", target_os = "macos"))]
mod attn_bench;
mod attn_kernel;
mod dflash;
mod draft_kernel;
mod engine;
mod gdn_kernel;
mod gpuprof;
mod model;
mod outbuf;
mod prefix_cache;
mod quant_kernel;
mod qwen35;
mod sample_kernel;
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
    // R0c: arm TH_GPU_PROF before candle creates its Metal device
    gpuprof::init();
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
            // E1 bench aid: TH_TOKENIZE=<text file> prints the comma-separated
            // ids of that text as one user message, rendered and encoded
            // exactly as the server does (chat template + generation
            // prompt) — real prompts for the TH_BENCH_* probes / --dump.
            // No model load.
            if let Ok(path) = std::env::var("TH_TOKENIZE") {
                let dir = std::path::Path::new(&model);
                let tok = tokenizers::Tokenizer::from_file(dir.join("tokenizer.json"))
                    .map_err(|e| anyhow::anyhow!("tokenizer: {e}"))?;
                let text = std::fs::read_to_string(&path)?;
                let msgs = [template::ChatMessage { role: "user".into(), content: text }];
                let bos = tok.token_to_id("<s>").map(|_| "<s>");
                let prompt = template::render(template::chat_template_from(dir).as_deref(), &msgs, bos)?;
                let ids = tok.encode(prompt.as_str(), false).map_err(|e| anyhow::anyhow!("tokenize: {e}"))?;
                let v: Vec<String> = ids.get_ids().iter().map(|i| i.to_string()).collect();
                println!("{}", v.join(","));
                return Ok(());
            }
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
            // N4: draft attention split-key vs single-pass, correctness
            // + per-call timing across ring lengths (no model load)
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if std::env::var("TH_BENCH_DRAFT_ATTN").is_ok() {
                let dev = candle_core::Device::new_metal(0)?;
                draft_kernel::bench_draft_attn(&dev)?;
                return Ok(());
            }
            // E1: fused prefill attention vs the grouped eager path and
            // candle's sdpa at prefill chunk shapes (no model load)
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if let Ok(spec) = std::env::var("TH_BENCH_PREFILL_ATTN") {
                attn_bench::bench_prefill_attn(&spec)?;
                return Ok(());
            }
            // N3: split-key vs single-pass attention across context
            // lengths (no model load). A `seq:kv,...` list selects T1b's
            // eager prefill attention bench instead (after the model load,
            // below) — both probes read TH_BENCH_ATTN.
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if std::env::var("TH_BENCH_ATTN").is_ok_and(|v| !v.contains(':')) {
                attn_bench::bench_attn()?;
                return Ok(());
            }
            // allocation cost probe (no model): fresh vs pooled buffers,
            // private (Tensor::empty) vs zero-filled (Tensor::zeros, blit)
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if let Ok(spec) = std::env::var("TH_BENCH_ALLOC") {
                let dev = candle_core::Device::new_metal(0)?;
                outbuf::bench_alloc(&dev, &spec)?;
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

                // R0a state-bitwise gate: after a round (verify seq8 →
                // rollback_verify(kept); kept = 8 is a full accept with no
                // rollback) the GDN recurrent state [layers, hv, dv, dk] f32
                // and conv windows must equal, bit for bit, a reference
                // fused scan of only the kept rows from the pre-verify
                // state. Exits nonzero on any mismatch (after the logits
                // checks below print).
                #[allow(unused_mut)]
                let mut state_fail = false;
                #[cfg(all(feature = "metal", target_os = "macos"))]
                if let model::ModelBackend::Qwen35(q) = &mut loaded.backend {
                    for kept in 1..=seq8.len() {
                        let r = q.rollback_state_check(0, pos, &seq8, kept)?;
                        eprintln!(
                            "  state kept={}: rec≠ref {}/{} (±0-only {}, max|Δ| {:.3e}) conv≠ref {}/{} layers≠ {}/{} | info: rec≠step-rescan {} (max {:.3e}), rec≠continuous-fwd {} (max {:.3e}) conv≠ {} | kernel-window≠host {} | {}",
                            r.kept, r.rec_diff_f, r.rec_elems, r.rec_zsign_f, r.rec_max_f, r.conv_diff_f,
                            r.conv_elems, r.layers_bad_f, r.layers, r.rec_diff_s,
                            r.rec_max_s, r.rec_diff_c, r.rec_max_c, r.conv_diff_c,
                            r.conv_kernel_diff,
                            if r.ok() { "ok" } else { "MISMATCH" }
                        );
                        state_fail |= !r.ok();
                    }
                    if q.nslots() >= 2 {
                        let (untouched, equal) =
                            q.slot_isolation_check(0, 1, &ids, &seq8, 3)?;
                        eprintln!(
                            "  slot isolation: slot0 untouched by a slot1 round={untouched}, same round on slot0/slot1 bitwise equal={equal}"
                        );
                        state_fail |= !(untouched && equal);
                    }
                    eprintln!(
                        "rollback state-bitwise: {}",
                        if state_fail { "FAIL" } else { "PASS" }
                    );
                    // T1 prefix cache: checkpoint two rows before the end
                    // (a >8-row prefill chunk, then a fused <=8-row suffix
                    // that must grow out of the shared exact-size K/V),
                    // restored into slot 0 and, with >= 2 slots, slot 1
                    let mut prefix_fail = false;
                    if ids.len() >= 3 {
                        let at = ids.len() - 2;
                        for into in 0..q.nslots().min(2) {
                            let r = q.prefix_restore_check(0, into, &ids, at, &seq8)?;
                            eprintln!(
                                "  prefix restore at {} slot0→slot{into}: logits≠ {} state≠ {} verify≠ {} checkpoint≠ {} | {}",
                                r.pos, r.logits_diff, r.state_diff, r.verify_diff, r.ckpt_diff,
                                if r.ok() { "ok" } else { "MISMATCH" }
                            );
                            prefix_fail |= !r.ok();
                        }
                    }
                    eprintln!(
                        "prefix restore bitwise: {}",
                        if prefix_fail { "FAIL" } else { "PASS" }
                    );
                    state_fail |= prefix_fail;
                }

                // restore points at `pos` for the two compare paths —
                // restored many times, across several forwards: deep
                let snap_a = loaded.backend.snapshot_deep(0)?;
                let snap_c = loaded.backend.snapshot_deep(0)?;

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
                if state_fail {
                    eprintln!("rollback test: exiting 1 (state-bitwise mismatch)");
                    std::process::exit(1);
                }
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
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if std::env::var("TH_BENCH_Q4").is_ok() {
                if let model::ModelBackend::Qwen35(q) = &loaded.backend {
                    qwen35::bench_q4_decode(q, &loaded.device)?;
                }
            }
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if std::env::var("TH_BENCH_DRAFT_MLP").is_ok() {
                if let model::ModelBackend::Qwen35(q) = &loaded.backend {
                    qwen35::bench_draft_mlp(q, &loaded.device)?;
                }
            }
            if let Ok(ms) = std::env::var("TH_BENCH_MULTI") {
                // one m, or a comma list (K45: "8,5,1" in one process)
                let ms: Vec<usize> = ms
                    .split(',')
                    .map(|v| v.trim().parse().unwrap_or(5))
                    .collect();
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
                let iters: usize = std::env::var("TH_BENCH_MULTI_ITERS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(3);
                for &m in &ms {
                    for _ in 0..iters {
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
            }
            if let Ok(spec) = std::env::var("TH_BENCH_PREFILL") {
                // prefill forward (the TTFT path): fresh state per run,
                // last-row f32 logits read back (sync). Legacy and tile
                // routing alternate run by run in this one process (order
                // flipped each pair) so clock/thermal drift hits both
                // equally; one warm-up run each first.
                let dev = loaded.device.clone();
                // E1: TH_BENCH_PREFILL_LARGE_ONLY=1 toggles only the m > 128
                // route (legacy AffineQmppPrefill vs the vec tile); with
                // TH_GPU_PROF=1 each run is timed by its GPU busy time
                let large_only = std::env::var("TH_BENCH_PREFILL_LARGE_ONLY").is_ok();
                let mut fwd = |seq: &[u32], legacy: bool| -> Result<f64> {
                    #[cfg(all(feature = "metal", target_os = "macos"))]
                    if large_only {
                        quant_kernel::pf_force_legacy_large(legacy);
                    } else {
                        quant_kernel::pf_force_legacy(legacy);
                    }
                    // forward() runs decode slot 0
                    loaded.backend.clear_kv_cache(0);
                    dev.synchronize()?;
                    let _ = gpuprof::drain_busy_ms();
                    let t = std::time::Instant::now();
                    let lg = loaded.backend.forward(seq, 0, &dev)?;
                    let _ = lg.to_vec1::<f32>()?;
                    let wall = t.elapsed().as_secs_f64() * 1e3;
                    Ok(if gpuprof::on() { gpuprof::drain_busy_ms() } else { wall })
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
                {
                    quant_kernel::pf_force_legacy(false);
                    quant_kernel::pf_force_legacy_large(false);
                }
            }
            if let Ok(spec) = std::env::var("TH_BENCH_STEPS") {
                // E1(d): prefill chunk size — the whole probe prompt from a
                // cleared slot 0 in `step`-row chunks (the plain grid that
                // `--prefill-step` sets), for each step in the comma list,
                // alternating run by run (TH_BENCH_STEPS_REPS, default 5);
                // GPU busy ms with TH_GPU_PROF=1, else wall ms. Prints
                // max|d| / argmax of each step's last logits vs the first.
                let dev = loaded.device.clone();
                let steps: Vec<usize> =
                    spec.split(',').filter_map(|t| t.trim().parse().ok()).filter(|&s: &usize| s >= 32).collect();
                let reps: usize = std::env::var("TH_BENCH_STEPS_REPS").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
                let n = ids.len();
                let run = |b: &mut model::ModelBackend, step: usize| -> Result<(f64, f64, Vec<f32>)> {
                    b.clear_kv_cache(0);
                    dev.synchronize()?;
                    let _ = gpuprof::drain_busy_ms();
                    let t = std::time::Instant::now();
                    let mut last = None;
                    let mut pos = 0;
                    while pos < n {
                        let e = (pos + step).min(n);
                        last = Some(b.forward(&ids[pos..e], pos, &dev)?);
                        pos = e;
                    }
                    let v = last.context("empty prompt")?.to_vec1::<f32>()?;
                    let wall = t.elapsed().as_secs_f64() * 1e3;
                    Ok((wall, gpuprof::drain_busy_ms(), v))
                };
                let mut first: Vec<Vec<f32>> = Vec::new();
                for &s in &steps {
                    first.push(run(&mut loaded.backend, s)?.2);
                }
                let mut t: Vec<Vec<(f64, f64)>> = vec![Vec::new(); steps.len()];
                for r in 0..reps {
                    for k in 0..steps.len() {
                        let i = (k + r) % steps.len();
                        let (w, g, _) = run(&mut loaded.backend, steps[i])?;
                        t[i].push((w, g));
                    }
                }
                let argmax = |v: &[f32]| v.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(i, _)| i).unwrap_or(0);
                for (i, &s) in steps.iter().enumerate() {
                    let mut w: Vec<f64> = t[i].iter().map(|x| x.0).collect();
                    let mut g: Vec<f64> = t[i].iter().map(|x| x.1).collect();
                    w.sort_by(|a, b| a.total_cmp(b));
                    g.sort_by(|a, b| a.total_cmp(b));
                    let d = first[0].iter().zip(&first[i]).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
                    eprintln!(
                        "steps n={n} step={s} chunks={} wall min={:.1} med={:.1}ms gpu min={:.1} med={:.1}ms tok/s(med wall) {:.0} | vs step {} max|d|={d:.4} argmax {} / {}",
                        n.div_ceil(s),
                        w[0],
                        w[w.len() / 2],
                        g[0],
                        g[g.len() / 2],
                        n as f64 / w[w.len() / 2] * 1e3,
                        steps[0],
                        argmax(&first[i]),
                        argmax(&first[0]),
                    );
                }
            }
            if let Ok(spec) = std::env::var("TH_BENCH_PLAN") {
                // T1 prefix cache, the GPU side of TTFT (no HTTP, template,
                // draft): for each `n:split` (prompt = the probe ids cycled
                // to n tokens; `split` = a block-aligned turn end) time,
                // alternating run by run in this process, from a cleared
                // slot 0 to the last-row logits readback (sync):
                //   base  — the plain step grid (main / TH_PREFIX_CACHE=0)
                //   cache — prefix_cache::plan with a turn end at `split`
                //           (an uncached request under the default mode),
                //           once per TH_BENCH_PLAN_MERGE value (merged-chunk
                //           row limits, default the TH_PREFIX_CACHE_MERGE
                //           default)
                //   hit   — restore the checkpoint at the split + the suffix
                //           (the first merge value's plan)
                //   ghit  — TH_PREFIX_CACHE=grid hit: restore the last grid
                //           checkpoint + main's remaining chunks
                // Checks hit == cache and ghit == base bit for bit; base vs
                // cache max|d| + argmax as info. TH_BENCH_PLAN_STEP = prefill
                // step (512), TH_BENCH_PLAN_REPS = timed runs per kind (6).
                let dev = loaded.device.clone();
                let env_num = |k: &str, d: usize| -> usize {
                    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d).max(1)
                };
                let step = env_num("TH_BENCH_PLAN_STEP", 512);
                let reps = env_num("TH_BENCH_PLAN_REPS", 6);
                let merges: Vec<usize> = std::env::var("TH_BENCH_PLAN_MERGE")
                    .ok()
                    .map(|v| v.split(',').filter_map(|x| x.trim().parse().ok()).collect())
                    .filter(|v: &Vec<usize>| !v.is_empty())
                    .unwrap_or_else(|| vec![prefix_cache::DEFAULT_MERGE]);
                let pcfg = prefix_cache::PrefixCacheConfig {
                    enabled: true,
                    plan_only: false,
                    grid_only: false,
                    max_entries: 8,
                    max_bytes: 1 << 32,
                    block: 128,
                    margin: 16,
                    merge: merges[0],
                    full: false,
                    asst: false,
                    defer: true,
                };
                let gcfg = prefix_cache::PrefixCacheConfig { grid_only: true, ..pcfg };
                let stat = |v: &mut Vec<f64>| {
                    v.sort_by(|a, b| a.total_cmp(b));
                    (v[0], v[v.len() / 2])
                };
                for pair in spec.split(',') {
                    let Some((n, split)) = pair.split_once(':').and_then(|(a, b)| {
                        Some((a.trim().parse::<usize>().ok()?, b.trim().parse::<usize>().ok()?))
                    }) else {
                        continue;
                    };
                    if split == 0 || split >= n {
                        eprintln!("plan n={n} split={split}: split must be in (0, n)");
                        continue;
                    }
                    let seq: Vec<u32> = (0..n).map(|i| ids[i % ids.len()]).collect();
                    let bounds = |p: &prefix_cache::ChunkPlan| -> Vec<usize> {
                        p.splits.iter().copied().chain(std::iter::once(n)).collect()
                    };
                    let base_p = prefix_cache::plan(n, step, None, None, &[]);
                    let cache_ps: Vec<prefix_cache::ChunkPlan> = merges
                        .iter()
                        .map(|&m| prefix_cache::plan(n, step, Some(&prefix_cache::PrefixCacheConfig { merge: m, ..pcfg }), None, &[split]))
                        .collect();
                    let grid_p = prefix_cache::plan(n, step, Some(&gcfg), None, &[split]);
                    let at = cache_ps[0].splits.iter().copied().filter(|&s| s <= split).max().unwrap_or(0);
                    let gat = grid_p.checkpoints.last().copied().unwrap_or(0);
                    let base_b = bounds(&base_p);
                    let cache_bs: Vec<Vec<usize>> = cache_ps.iter().map(|p| bounds(p)).collect();
                    // prefill from `from` through `bounds` (ends > from), last logits
                    let run = |b: &mut model::ModelBackend, from: usize, bounds: &[usize]| -> Result<Vec<f32>> {
                        let mut pos = from;
                        let mut last = None;
                        for &e in bounds.iter().filter(|&&e| e > from) {
                            last = Some(b.forward(&seq[pos..e], pos, &dev)?);
                            pos = e;
                        }
                        Ok(last.context("empty plan")?.to_vec1::<f32>()?)
                    };
                    // checkpoints: the first cache plan at `at`, main's grid at `gat`
                    let upto = |bs: &[usize], c: usize| bs.iter().copied().filter(|&e| e <= c).collect::<Vec<_>>();
                    loaded.backend.clear_kv_cache(0);
                    let _ = run(&mut loaded.backend, 0, &upto(&cache_bs[0], at))?;
                    let ck = loaded.backend.prefix_capture(0)?;
                    let gck = if gat > 0 {
                        loaded.backend.clear_kv_cache(0);
                        let _ = run(&mut loaded.backend, 0, &upto(&base_b, gat))?;
                        Some(loaded.backend.prefix_capture(0)?)
                    } else {
                        None
                    };
                    // kinds: 0 base, 1..=M cache[m], M+1 hit, M+2 ghit
                    let nm = merges.len();
                    let nk = nm + 3;
                    let timed = |kind: usize, b: &mut model::ModelBackend| -> Result<(f64, Vec<f32>)> {
                        b.clear_kv_cache(0);
                        let t = std::time::Instant::now();
                        let v = if kind == 0 {
                            run(b, 0, &base_b)?
                        } else if kind <= nm {
                            run(b, 0, &cache_bs[kind - 1])?
                        } else if kind == nm + 1 {
                            b.prefix_restore(0, &ck)?;
                            run(b, at, &cache_bs[0])?
                        } else {
                            match &gck {
                                Some(g) => {
                                    b.prefix_restore(0, g)?;
                                    run(b, gat, &base_b)?
                                }
                                None => run(b, 0, &base_b)?,
                            }
                        };
                        Ok((t.elapsed().as_secs_f64() * 1e3, v))
                    };
                    let mut first = Vec::new();
                    for k in 0..nk {
                        first.push(timed(k, &mut loaded.backend)?.1);
                    }
                    let mut t: Vec<Vec<f64>> = vec![Vec::new(); nk];
                    for r in 0..reps {
                        for k in 0..nk {
                            let kind = (k + r) % nk;
                            t[kind].push(timed(kind, &mut loaded.backend)?.0);
                        }
                    }
                    let bits_eq = |x: &[f32], y: &[f32]| x.len() == y.len() && x.iter().zip(y).all(|(a, b)| a.to_bits() == b.to_bits());
                    let argmax = |v: &[f32]| {
                        v.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(i, _)| i).unwrap_or(0)
                    };
                    let st: Vec<(f64, f64)> = t.iter_mut().map(|v| stat(v)).collect();
                    let (bmin, bmed) = st[0];
                    let mut caches = String::new();
                    for (j, m) in merges.iter().enumerate() {
                        let (cmin, cmed) = st[j + 1];
                        let dmax = first[0].iter().zip(&first[j + 1]).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
                        caches += &format!(
                            " | cache merge={m} {:?} min={cmin:.1} med={cmed:.1}ms ({:+.1}ms, {:+.1}% vs base; min {:+.1}ms) max|d|={dmax:.4} argmax {}",
                            cache_ps[j].splits,
                            cmed - bmed,
                            (cmed / bmed - 1.0) * 100.0,
                            cmin - bmin,
                            argmax(&first[j + 1]),
                        );
                    }
                    let ((hmin, hmed), (gmin, gmed)) = (st[nm + 1], st[nm + 2]);
                    eprintln!(
                        "plan n={n} split={split} step={step} | base {} chunks min={bmin:.1} med={bmed:.1}ms argmax {}{caches} | hit restore@{at}+{} rows min={hmin:.1} med={hmed:.1}ms ({:.1}x vs base) | grid-hit restore@{gat}+{} rows min={gmin:.1} med={gmed:.1}ms ({:.1}x vs base) | hit==cache {} ghit==base {}",
                        base_b.len(),
                        argmax(&first[0]),
                        n - at,
                        bmed / hmed,
                        n - gat,
                        bmed / gmed,
                        if bits_eq(&first[nm + 1], &first[1]) { "PASS" } else { "FAIL" },
                        if bits_eq(&first[nm + 2], &first[0]) { "PASS" } else { "FAIL" },
                    );
                    drop((ck, gck));
                }
            }
            if let Ok(spec) = std::env::var("TH_BENCH_TTFT") {
                bench_ttft(&mut loaded, &ids, &spec)?;
            }
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if let Ok(spec) = std::env::var("TH_BENCH_ATTN") {
                // Eager prefill attention (qwen35 `attn_eager`, the seq > 8
                // path) on random data at Qwen3.8's layout (24 q heads, 4 kv
                // heads, d 256), for each `seq:kv` (kv = pos + seq), synced,
                // median of 7, one attention layer per call (16 per forward):
                //   eager   — the broadcast form (TH_ATTN_GQA=0): K and V
                //             broadcast to all 24 heads, K^T contiguous
                //   copies  — only those three [24, kv, 256] materialisations
                //   grouped — the GQA-grouped form (T1b, default)
                // + how many output elements differ bitwise (must be 0).
                use candle_core::{DType, Tensor};
                let dev = loaded.device.clone();
                let (nh, nkv, hd) = (24usize, 4usize, 256usize);
                let rep = nh / nkv;
                for pair in spec.split(',') {
                    let Some((seq, kv)) = pair.split_once(':').and_then(|(a, b)| {
                        Some((a.trim().parse::<usize>().ok()?, b.trim().parse::<usize>().ok()?))
                    }) else {
                        continue;
                    };
                    if seq == 0 || kv < seq {
                        continue;
                    }
                    let pos = kv - seq;
                    let q = Tensor::randn(0f32, 1.0, (1, nh, seq, hd), &dev)?.to_dtype(DType::BF16)?;
                    // the model's cache layouts: K head-major contiguous, V
                    // time-major (attn_forward's cat of transposed rows)
                    let k_all = Tensor::randn(0f32, 1.0, (nkv, kv, hd), &dev)?.to_dtype(DType::BF16)?;
                    let v_all = Tensor::randn(0f32, 1.0, (kv, nkv, hd), &dev)?.to_dtype(DType::BF16)?.transpose(0, 1)?;
                    let bcast = |t: &Tensor| -> Result<Tensor> {
                        Ok(t.unsqueeze(1)?.broadcast_as((nkv, rep, kv, hd))?.reshape((nh, kv, hd))?)
                    };
                    let attn = |grouped: bool| -> Result<Tensor> {
                        qwen35::Qwen35::attn_eager(&q, &k_all, &v_all, pos, seq, nh, nkv, hd, grouped, &dev)
                    };
                    let eager = || attn(false);
                    let grouped = || attn(true);
                    let copies = || -> Result<Tensor> {
                        let kt = bcast(&k_all)?.transpose(1, 2)?.contiguous()?;
                        let v_r = bcast(&v_all)?.contiguous()?;
                        drop(v_r);
                        Ok(kt)
                    };
                    let time = |f: &dyn Fn() -> Result<Tensor>| -> Result<(f64, f64)> {
                        let _ = f()?;
                        dev.synchronize()?;
                        let mut v = Vec::new();
                        for _ in 0..7 {
                            let t = std::time::Instant::now();
                            let _o = f()?;
                            dev.synchronize()?;
                            v.push(t.elapsed().as_secs_f64() * 1e3);
                        }
                        v.sort_by(|a, b| a.total_cmp(b));
                        Ok((v[0], v[3]))
                    };
                    // sdpa — candle's fused MLX steel attention (causal with
                    // the kv - seq query offset, GQA, bf16): NOT bitwise equal
                    // (flash accumulation order), timing + max|d| only — a
                    // probe for a numerics-changing lever, not a request path
                    let sdpa = || -> Result<Tensor> {
                        let o = candle_nn::ops::sdpa(
                            &q.contiguous()?,
                            &k_all.unsqueeze(0)?.contiguous()?,
                            &v_all.unsqueeze(0)?.contiguous()?,
                            None,
                            true,
                            (hd as f32).powf(-0.5),
                            1.0,
                        )?; // [1, nh, seq, hd]
                        Ok(o.squeeze(0)?.transpose(0, 1)?.reshape((seq, nh * hd))?)
                    };
                    let ((emin, emed), (cmin, cmed), (gmin, gmed)) = (time(&eager)?, time(&copies)?, time(&grouped)?);
                    let (smin, smed) = time(&sdpa)?;
                    let (eb, gb) = (qwen35::tensor_bits(&eager()?)?, qwen35::tensor_bits(&grouped()?)?);
                    let ndiff = eb.iter().zip(&gb).filter(|(a, b)| a != b).count();
                    let sd = eager()?
                        .to_dtype(DType::F32)?
                        .sub(&sdpa()?.to_dtype(DType::F32)?)?
                        .abs()?
                        .flatten_all()?
                        .max(0)?
                        .to_scalar::<f32>()?;
                    eprintln!(
                        "attn seq={seq:4} kv={kv:5} | eager min={emin:.2} med={emed:.2}ms (x16 = {:.0} ms/forward) | copies min={cmin:.2} med={cmed:.2}ms ({:.0}% of eager) | grouped min={gmin:.2} med={gmed:.2}ms ({:.2}x faster, x16 saves {:.0} ms/forward) | bits differ {ndiff}/{} | sdpa min={smin:.2} med={smed:.2}ms ({:.2}x vs eager, {:.2}x vs grouped) max|eager-sdpa|={sd:.4}",
                        emed * 16.0,
                        cmed / emed * 100.0,
                        emed / gmed,
                        (emed - gmed) * 16.0,
                        eb.len(),
                        emed / smed,
                        gmed / smed,
                    );
                }
            }
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if let Ok(spec) = std::env::var("TH_BENCH_PREFILL_LOGITS") {
                // E1: in-model prefill A/B, eager vs fused prefill attention.
                // For each prompt length N (ids from TH_BENCH_PREFILL_IDS,
                // cycled), prefill slot 0 in the engine's 512-row grid chunks
                // (forward_slot, the prefill_slot path), synced per chunk;
                // alternate eager / fused TH_BENCH_PREFILL_REPS times (default
                // 3); report per-chunk and total ms (median), and max|d| /
                // argmax / top-10 overlap of the last-position logits.
                use candle_core::{DType, Tensor};
                let dev = loaded.device.clone();
                let path = std::env::var("TH_BENCH_PREFILL_IDS").map_err(|_| anyhow::anyhow!("TH_BENCH_PREFILL_IDS=<comma-separated ids file>"))?;
                let base: Vec<u32> = std::fs::read_to_string(&path)?
                    .split(|c: char| c == ',' || c.is_whitespace())
                    .filter_map(|t| t.trim().parse().ok())
                    .collect();
                let reps: usize = std::env::var("TH_BENCH_PREFILL_REPS").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
                let step: usize = std::env::var("TH_BENCH_PREFILL_STEP").ok().and_then(|v| v.parse().ok()).unwrap_or(512);
                for n in spec.split(',').filter_map(|t| t.trim().parse::<usize>().ok()) {
                    let ids: Vec<u32> = base.iter().copied().cycle().take(n).collect();
                    // `tail` > 0: the last `tail` rows as their own chunk (the prefix
                    // cache's default plan splits a chat prompt's tail off like this;
                    // chunks <= 128 rows take other GEMM tiles: a real numerics change)
                    let mut run = |eager: bool, tail: usize| -> Result<(Vec<f64>, Tensor)> {
                        qwen35::prefill_attn_force_eager(eager);
                        loaded.backend.clear_kv_cache(0);
                        dev.synchronize()?;
                        let mut ms = Vec::new();
                        let mut logits = None;
                        let mut pos = 0;
                        let body = n.saturating_sub(tail);
                        let mut plan: Vec<&[u32]> = ids[..body].chunks(step).collect();
                        if tail > 0 && body > 0 {
                            plan.push(&ids[body..]);
                        }
                        for chunk in plan {
                            let t = std::time::Instant::now();
                            let lg = loaded.backend.forward_slot(0, chunk, pos, &dev)?;
                            dev.synchronize()?;
                            ms.push(t.elapsed().as_secs_f64() * 1e3);
                            logits = Some(lg);
                            pos += chunk.len();
                        }
                        qwen35::prefill_attn_force_eager(false);
                        Ok((ms, logits.unwrap().to_dtype(DType::F32)?))
                    };
                    let mut e_ms: Vec<Vec<f64>> = Vec::new();
                    let mut f_ms: Vec<Vec<f64>> = Vec::new();
                    let (mut e_lg, mut f_lg) = (None, None);
                    for r in 0..reps {
                        for eager in if r % 2 == 0 { [true, false] } else { [false, true] } {
                            let (ms, lg) = run(eager, 0)?;
                            if eager { e_ms.push(ms); e_lg = Some(lg); } else { f_ms.push(ms); f_lg = Some(lg); }
                        }
                    }
                    // noise floor: the eager path with a 24-row tail chunk (the engine's
                    // own plan-dependent variation), and the same for the fused path
                    let (_, e2_lg) = run(true, 24)?;
                    let (_, f2_lg) = run(false, 24)?;
                    let med = |v: &mut Vec<f64>| { v.sort_by(|a, b| a.total_cmp(b)); v[v.len() / 2] };
                    let nch = e_ms[0].len();
                    let per = |runs: &Vec<Vec<f64>>, c: usize| { let mut v: Vec<f64> = runs.iter().map(|r| r[c]).collect(); med(&mut v) };
                    let tot = |runs: &Vec<Vec<f64>>| { let mut v: Vec<f64> = runs.iter().map(|r| r.iter().sum()).collect(); med(&mut v) };
                    let ev: Vec<f32> = e_lg.unwrap().to_vec1()?;
                    let fv: Vec<f32> = f_lg.unwrap().to_vec1()?;
                    let e2v: Vec<f32> = e2_lg.to_vec1()?;
                    let f2v: Vec<f32> = f2_lg.to_vec1()?;
                    // |d|, |d| in bf16 ulps of the reference logit, KL(p_a || p_b) in nats,
                    // max |d log p| over a's top 10, argmax, top-10 overlap
                    let cmp = |a: &[f32], b: &[f32]| -> String {
                        let (mut dmax, mut at) = (0f32, 0usize);
                        for (i, (x, y)) in a.iter().zip(b).enumerate() {
                            if (x - y).abs() > dmax { dmax = (x - y).abs(); at = i; }
                        }
                        // bf16 ulp at the larger magnitude of the pair
                        let ulp = |x: f32| { let e = x.abs().max(1e-30).log2().floor(); 2f32.powf(e - 7.0) };
                        let dulp = dmax / ulp(a[at].abs().max(b[at].abs()));
                        let big = a.iter().filter(|x| x.abs() >= 16.0).count();
                        let lse = |v: &[f32]| { let m = v.iter().cloned().fold(f32::MIN, f32::max) as f64; m + v.iter().map(|x| (*x as f64 - m).exp()).sum::<f64>().ln() };
                        let (la, lb) = (lse(a), lse(b));
                        let kl: f64 = a.iter().zip(b).map(|(x, y)| { let lpa = *x as f64 - la; let lpb = *y as f64 - lb; lpa.exp() * (lpa - lpb) }).sum();
                        let top = |v: &[f32], k: usize| { let mut i: Vec<usize> = (0..v.len()).collect(); i.sort_by(|&p, &q| v[q].total_cmp(&v[p])); i.truncate(k); i };
                        let (ta, tb) = (top(a, 10), top(b, 10));
                        let dlp = ta.iter().map(|&i| ((a[i] as f64 - la) - (b[i] as f64 - lb)).abs()).fold(0f64, f64::max);
                        let ov = ta.iter().filter(|x| tb.contains(x)).count();
                        format!("max|d| {dmax:.4} at logit {:.3}/{:.3} ({dulp:.1} bf16 ulp; {big} logits >= 16) KL {kl:.2e} top10 max|dlogp| {dlp:.4} argmax {} top10 {ov}/10", a[at], b[at],
                            if ta[0] == tb[0] { "same" } else { "DIFF" })
                    };
                    let chunks: Vec<String> = (0..nch).map(|c| format!("{:.0}/{:.0}", per(&e_ms, c), per(&f_ms, c))).collect();
                    eprintln!(
                        "prefill n={n} step={step} reps={reps} | total eager {:.1} ms fused {:.1} ms (-{:.1} ms, {:.2}x) | per chunk eager/fused [{}]",
                        tot(&e_ms), tot(&f_ms), tot(&e_ms) - tot(&f_ms), tot(&e_ms) / tot(&f_ms), chunks.join(" "),
                    );
                    eprintln!("  logits n={n} fused vs eager (step {step}): {}", cmp(&ev, &fv));
                    eprintln!("  logits n={n} NOISE FLOOR eager +24-row tail chunk vs eager grid: {}", cmp(&ev, &e2v));
                    eprintln!("  logits n={n} fused +24-row tail chunk vs fused grid: {}", cmp(&fv, &f2v));
                }
            }
            #[cfg(all(feature = "metal", target_os = "macos"))]
            if let Ok(spec) = std::env::var("TH_BENCH_BATCH") {
                // batched verify forward — the target pass of a TH_BATCH > 1
                // decode round: nb slots, each prefilled with the probe ids,
                // x 8 rows through forward_batch (rows = 8*nb > 8, so the
                // flat projections take the prefill routing). Legacy and
                // tile routing alternate run by run from restored per-slot
                // state (as TH_BENCH_PREFILL); the argmax readback is the
                // sync (batch_round's greedy path). Numerics: max|d| of the
                // bf16 logits + argmax agreement, tiles vs legacy and each
                // vs the single-slot 8-row verify on slot 0 (forward_multi,
                // decode kernels) — the batch-shape noise main already has;
                // plus slot invariance (slot b's rows vs slot 0's, same
                // input). Needs TH_BATCH >= the largest nb.
                use candle_core::{DType, Tensor, D};
                let dev = loaded.device.clone();
                let ns = loaded.backend.nslots();
                let pos = ids.len();
                let seq8: Vec<u32> = (0..8).map(|i| 1000 + i * 37).collect();
                for s in 0..ns {
                    loaded.backend.clear_kv_cache(s);
                    let _ = loaded.backend.forward_slot(s, &ids, 0, &dev)?.to_vec1::<f32>()?;
                }
                // restored before every timed run: deep snapshots
                let snaps = (0..ns)
                    .map(|s| loaded.backend.snapshot_deep(s))
                    .collect::<Result<Vec<_>>>()?;
                let maxd = |a: &Tensor, b: &Tensor| -> Result<f32> {
                    Ok(a.sub(b)?.abs()?.flatten_all()?.max(0)?.to_scalar::<f32>()?)
                };
                let argmax = |t: &Tensor| -> Result<Vec<u32>> {
                    Ok(t.argmax(D::Minus1)?.to_vec1::<u32>()?)
                };
                let reference = loaded
                    .backend
                    .forward_multi(&seq8, pos, &dev)?
                    .to_dtype(DType::F32)?;
                loaded.backend.restore(0, snaps[0].clone())?;
                let ref_am = argmax(&reference)?;
                let stat = |v: &mut Vec<f64>| {
                    v.sort_by(|a, b| a.total_cmp(b));
                    (v[0], v[v.len() / 2])
                };
                for nb in spec.split(',').filter_map(|t| t.trim().parse::<usize>().ok()) {
                    if nb < 2 || nb > ns {
                        eprintln!("batch nb={nb}: skipped (needs 2..=TH_BATCH={ns})");
                        continue;
                    }
                    let slots: Vec<usize> = (0..nb).collect();
                    let seqs: Vec<&[u32]> = vec![seq8.as_slice(); nb];
                    let poss = vec![pos; nb];
                    let mut run = |legacy: bool| -> Result<(f64, Tensor)> {
                        quant_kernel::pf_force_legacy(legacy);
                        for &s in &slots {
                            loaded.backend.restore(s, snaps[s].clone())?;
                        }
                        // restore's state copies run on the GPU: keep them
                        // out of the timed region
                        dev.synchronize()?;
                        let t = std::time::Instant::now();
                        let lg = loaded.backend.forward_batch(&slots, &seqs, &poss)?;
                        let _ = lg.argmax(D::Minus1)?.to_vec1::<u32>()?;
                        Ok((t.elapsed().as_secs_f64() * 1e3, lg))
                    };
                    let lf = run(true)?.1.to_dtype(DType::F32)?;
                    let tf = run(false)?.1.to_dtype(DType::F32)?;
                    let (mut leg, mut til) = (Vec::new(), Vec::new());
                    for r in 0..6 {
                        for legacy in [r % 2 == 0, r % 2 != 0] {
                            let (ms, _) = run(legacy)?;
                            if legacy { leg.push(ms) } else { til.push(ms) }
                        }
                    }
                    quant_kernel::pf_force_legacy(false);
                    let ((lmin, lmed), (tmin, tmed)) = (stat(&mut leg), stat(&mut til));
                    let (am_l, am_t) = (argmax(&lf)?, argmax(&tf)?);
                    let rows = 8 * nb;
                    let same_lt = (0..rows).filter(|&i| am_l[i] == am_t[i]).count();
                    let (mut dl_ref, mut dt_ref, mut inv_l, mut inv_t) = (0f32, 0f32, 0f32, 0f32);
                    let (mut ref_l, mut ref_t) = (0usize, 0usize);
                    for b in 0..nb {
                        let (lb, tb) = (lf.narrow(0, b * 8, 8)?, tf.narrow(0, b * 8, 8)?);
                        dl_ref = dl_ref.max(maxd(&lb, &reference)?);
                        dt_ref = dt_ref.max(maxd(&tb, &reference)?);
                        inv_l = inv_l.max(maxd(&lb, &lf.narrow(0, 0, 8)?)?);
                        inv_t = inv_t.max(maxd(&tb, &tf.narrow(0, 0, 8)?)?);
                        ref_l += (0..8).filter(|&i| am_l[b * 8 + i] == ref_am[i]).count();
                        ref_t += (0..8).filter(|&i| am_t[b * 8 + i] == ref_am[i]).count();
                    }
                    eprintln!(
                        "batch nb={nb} rows={rows} legacy min={lmin:.1}ms med={lmed:.1}ms | tiles min={tmin:.1}ms med={tmed:.1}ms | tiles/legacy med={:.3} ({:+.1}ms) | tiles vs legacy max|d|={:.4} argmax {same_lt}/{rows} | vs 1-slot verify: legacy max|d|={dl_ref:.4} argmax {ref_l}/{rows}, tiles max|d|={dt_ref:.4} argmax {ref_t}/{rows} | slot invariance legacy={inv_l:.4} tiles={inv_t:.4}",
                        tmed / lmed,
                        tmed - lmed,
                        maxd(&lf, &tf)?,
                    );
                }
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

/// `TH_BENCH_TTFT=n:turn_end,...` — the cold-request TTFT path in one
/// process, variants alternating run by run (order rotated per rep): from
/// the request-start slot clear to the first token's argmax readback (the
/// sync a T=0 first sample makes), prompt = the probe ids cycled to `n`
/// under the T1 chunk plan with a chat turn end at `turn_end`.
/// `TH_BENCH_DRAFT=<dir>` attaches the DFlash draft (capture rows, as the
/// server). `TH_BENCH_TTFT_KINDS` (default `miss,cap,miss-kv0,cap-kv0`):
///   miss — plan only (TH_PREFIX_CACHE=miss); cap — plus the plan's
///   checkpoint captures inline (integration-3's order) into an LRU store
///   (the server's default config); dcap — deferred captures (the
///   server's order now: holds while prefilling, one build + the prompt-end
///   checkpoint after the first token's readback; the build is timed in
///   `capture`, outside `total`);
///   suffix `-kv0` — TH_KV_CAP_PREFILL off, `-leg` — the integration-3
///   (legacy) capacity store, none — the direct store (in-process override);
///   `head` anywhere in the name — every chunk computes its logits (as
///   integration-3), else only the last (`forward_slot_nohead`).
/// `TH_BENCH_TTFT_GAP_MS` idle pause and `TH_BENCH_TTFT_THERM=1` a
/// thermal-level-0 wait before every run (both outside the timed window).
/// `TH_BENCH_TTFT_REPS` timed runs per kind (5). Prints median/min total,
/// clear, host enqueue and capture host time per kind.
fn bench_ttft(loaded: &mut model::LoadedModel, ids: &[u32], spec: &str) -> Result<()> {
    use std::time::Instant;
    let dev = loaded.device.clone();
    if let Ok(d) = std::env::var("TH_BENCH_DRAFT") {
        if !loaded.backend.has_draft() {
            loaded.backend.attach_draft(std::path::Path::new(&d))?;
        }
    }
    // TH_BENCH_TTFT_GAP_MS: idle pause before every run (thermal drift)
    let gap_ms: u64 = std::env::var("TH_BENCH_TTFT_GAP_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let therm_gate = std::env::var("TH_BENCH_TTFT_THERM").as_deref() == Ok("1");
    let mut therm_wait = 0.0f64;
    let reps: usize = std::env::var("TH_BENCH_TTFT_REPS").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
    let kinds: Vec<String> = std::env::var("TH_BENCH_TTFT_KINDS")
        .unwrap_or_else(|_| "miss,cap,miss-leg,cap-leg,miss-kv0,cap-kv0".into())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    // TH_BENCH_TTFT_IDS=<file>: comma-separated prompt ids (else --tokens)
    let file_ids: Option<Vec<u32>> = match std::env::var("TH_BENCH_TTFT_IDS") {
        Ok(f) => Some(std::fs::read_to_string(&f)?.split(',').filter_map(|t| t.trim().parse().ok()).collect()),
        Err(_) => None,
    };
    let ids: &[u32] = file_ids.as_deref().unwrap_or(ids);
    let pcfg = prefix_cache::PrefixCacheConfig::from_env();
    let pcfg = prefix_cache::PrefixCacheConfig { enabled: true, plan_only: false, grid_only: false, ..pcfg };
    let mut store: prefix_cache::PrefixCache<model::BackendPrefix> = prefix_cache::PrefixCache::new(pcfg);
    let mut nonce = 0u32;
    for pair in spec.split(',') {
        let Some((n, te)) = pair.split_once(':').and_then(|(a, b)| Some((a.trim().parse::<usize>().ok()?, b.trim().parse::<usize>().ok()?))) else {
            continue;
        };
        let plan = prefix_cache::plan(n, 512, Some(&pcfg), Some(te), &[te]);
        let bounds: Vec<usize> = plan.splits.iter().copied().chain(std::iter::once(n)).collect();
        eprintln!("ttft n={n} turn_end={te} splits={:?} checkpoints={:?} kinds={kinds:?} reps={reps}", plan.splits, plan.checkpoints);
        // (total, clear, enqueue, capture) per kind
        let mut res: Vec<Vec<(f64, f64, f64, f64)>> = vec![Vec::new(); kinds.len()];
        let mut first_tok: Vec<Option<u32>> = vec![None; kinds.len()];
        let mut ref_bits: Vec<(String, Vec<u32>)> = Vec::new();
        for r in 0..=reps {
            for k in 0..kinds.len() {
                let ki = (k + r) % kinds.len();
                let kind = kinds[ki].as_str();
                // a fresh first token per run so every run misses the store;
                // the untimed round 0 runs one fixed prompt in every kind
                // (bitwise logits identity across kinds; its checkpoints
                // are inserted once and later hit nothing)
                nonce += 1;
                let mut seq: Vec<u32> = (0..n).map(|i| ids[i % ids.len()]).collect();
                seq[0] = if r == 0 { 999 } else { 1000 + nonce % 50000 };
                if gap_ms > 0 {
                    dev.synchronize()?;
                    std::thread::sleep(std::time::Duration::from_millis(gap_ms));
                }
                // TH_BENCH_TTFT_THERM=1: wait (<= 180 s, outside the timed
                // window) for thermal pressure level 0 before every run
                if therm_gate {
                    let t = Instant::now();
                    while t.elapsed().as_secs() < 180 {
                        let lvl = std::process::Command::new("notifyutil")
                            .args(["-g", "com.apple.system.thermalpressurelevel"])
                            .output()
                            .ok()
                            .and_then(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().last().and_then(|x| x.parse::<u32>().ok()));
                        if lvl.unwrap_or(0) == 0 {
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_secs(2));
                    }
                    therm_wait += t.elapsed().as_secs_f64();
                }
                let caps = kind.starts_with("cap") || kind.starts_with("dcap");
                let deferred = kind.starts_with("dcap");
                let mut held = Vec::new();
                qwen35::set_kv_cap_override(Some(if kind.ends_with("-kv0") {
                    qwen35::KvCap::Off
                } else if kind.ends_with("-leg") {
                    qwen35::KvCap::Legacy
                } else {
                    qwen35::KvCap::Direct
                }));
                let ms = |t: Instant| t.elapsed().as_secs_f64() * 1e3;
                let t0 = Instant::now();
                loaded.backend.set_kv_quant(false)?;
                loaded.backend.clear_kv_cache(0);
                let clear = ms(t0);
                let (mut enq, mut cap) = (0.0, 0.0);
                let mut pos = 0usize;
                let mut last = None;
                for &end in &bounds {
                    let t = Instant::now();
                    if end < n && !kind.contains("head") {
                        loaded.backend.forward_slot_nohead(0, &seq[pos..end], pos, &dev)?;
                    } else {
                        last = Some(loaded.backend.forward_slot(0, &seq[pos..end], pos, &dev)?);
                    }
                    enq += ms(t);
                    pos = end;
                    if caps && pos < n && plan.checkpoints.contains(&pos) {
                        let t = Instant::now();
                        if deferred {
                            // the server's order: hold now (copy unless the
                            // tail chunk is next), build after the first token
                            let last_split = bounds.iter().position(|&b| b == pos).map_or(false, |i| i + 2 == bounds.len());
                            held.push((pos, loaded.backend.prefix_hold(0, !last_split)?, None));
                        } else {
                            let p = loaded.backend.prefix_capture(0)?;
                            let parts = vec![(store.part_id(), p.parts().iter().map(|x| x.1).sum())];
                            store.insert_shared(seq[..pos].to_vec(), 512, plan.history(pos), parts, false, p);
                        }
                        cap += ms(t);
                    }
                }
                let last = last.context("empty plan")?;
                if deferred {
                    held.push((n, loaded.backend.prefix_hold(0, false)?, Some(last.clone())));
                }
                let tok = last.argmax(0)?.to_scalar::<u32>()?;
                let total = ms(t0);
                if deferred {
                    let t = Instant::now();
                    // the server's accounting: the build's K/V and capture-row
                    // copies are shared parts
                    let (kv_id, caps_id) = (store.part_id(), store.part_id());
                    for p in loaded.backend.prefix_build(0, std::mem::take(&mut held))? {
                        let pp = p.pos();
                        let parts: Vec<(u64, usize)> = p
                            .parts()
                            .iter()
                            .map(|&(k, b)| match k {
                                qwen35::CkPart::Kv => (kv_id, b),
                                qwen35::CkPart::Caps => (caps_id, b),
                                qwen35::CkPart::Own => (store.part_id(), b),
                            })
                            .collect();
                        store.insert_shared(seq[..pp].to_vec(), 512, plan.history_at(pp, n), parts, pp == n, p);
                    }
                    cap += ms(t);
                }
                if r == 0 {
                    let bits: Vec<u32> = last.to_vec1::<f32>()?.iter().map(|v| v.to_bits()).collect();
                    ref_bits.push((kind.to_string(), bits));
                }
                // drain the draft captures like the server's warm-up would
                if loaded.backend.has_draft() {
                    loaded.backend.draft_prefill(0)?;
                    dev.synchronize()?;
                }
                if r > 0 {
                    res[ki].push((total, clear, enq, cap));
                }
                if first_tok[ki].is_none() {
                    first_tok[ki] = Some(tok);
                }
            }
        }
        qwen35::set_kv_cap_override(None);
        if let Some((k0, b0)) = ref_bits.first() {
            for (k, b) in &ref_bits[1..] {
                let diff = b.iter().zip(b0).filter(|(x, y)| x != y).count();
                eprintln!("  logits bits {k} vs {k0}: {diff} of {} differ{}", b.len(), if diff == 0 { "" } else { "  <-- NOT BITWISE" });
            }
        }
        let med = |v: &mut Vec<f64>| {
            v.sort_by(|a, b| a.total_cmp(b));
            (v[v.len() / 2], v[0])
        };
        for (ki, kind) in kinds.iter().enumerate() {
            let mut tot: Vec<f64> = res[ki].iter().map(|x| x.0).collect();
            let mut clr: Vec<f64> = res[ki].iter().map(|x| x.1).collect();
            let mut enq: Vec<f64> = res[ki].iter().map(|x| x.2).collect();
            let mut cap: Vec<f64> = res[ki].iter().map(|x| x.3).collect();
            let (tm, tmin) = med(&mut tot);
            eprintln!(
                "  {kind:10} total med {tm:7.1} min {tmin:7.1} ms | clear {:5.1} | enqueue {:6.1} | capture {:5.1} | all {:?} | tok {:?}",
                med(&mut clr).0,
                med(&mut enq).0,
                med(&mut cap).0,
                res[ki].iter().map(|x| x.0.round() as i64).collect::<Vec<_>>(),
                first_tok[ki]
            );
        }
        eprintln!("  store: entries {} bytes {:.0} MB; thermal-gate waits {:.0} s", store.len(), store.bytes() as f64 / 1e6, therm_wait);
    }
    Ok(())
}
