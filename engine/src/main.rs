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
                            "  state kept={}: rec≠ref {}/{} (±0-only {}, max|Δ| {:.3e}) conv≠ref {}/{} layers≠ {}/{} | info: rec≠step-rescan {} (max {:.3e}), rec≠continuous-fwd {} (max {:.3e}) conv≠ {} | {}",
                            r.kept, r.rec_diff_f, r.rec_elems, r.rec_zsign_f, r.rec_max_f, r.conv_diff_f,
                            r.conv_elems, r.layers_bad_f, r.layers, r.rec_diff_s,
                            r.rec_max_s, r.rec_diff_c, r.rec_max_c, r.conv_diff_c,
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
                }

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
                let snaps = (0..ns)
                    .map(|s| loaded.backend.snapshot(s))
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
