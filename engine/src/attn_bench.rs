//! N3 attention probe: context-length scaling of the single-pass fused
//! `attn_decode` vs the split-key `attn_decode_split` (MPP tile), with
//! GPU timestamps and an f64 CPU reference.
//!
//! `TH_BENCH_ATTN=1 th-engine probe --model x --tokens 1` — no model
//! load. Shapes are Qwen3.8-27B's full-attention layers: 24 q heads, 4 kv
//! heads, head_dim 256, rope half-width 32. Knobs:
//!   TH_BENCH_ATTN_LENS=512,2048,...  visible keys (pos + seq)
//!   TH_BENCH_ATTN_SEQS=8,1           query rows (verify block = 8)
//!   TH_BENCH_ATTN_SPLITS=0,16,32     split counts (0 = the routing policy)
//!   TH_BENCH_ATTN_TM=1               time-major caches ([cap, nkv, d] viewed
//!                                    as [nkv, cap, d] — the layout the eager
//!                                    prefill's cat leaves in the real engine)
//!   TH_BENCH_ATTN_REF_MAX=8192       largest L checked against the f64 reference
//!   TH_BENCH_ATTN_QSCALE=1           q scale: scores have std QSCALE (1 = flat attention;
//!                                    4-8 = peaked, the regime of real long-context heads)
//!
//! GPU time = MTLCommandBuffer GPUStart/EndTime over n serial calls on a
//! private queue (a serial encoder: call i+1 starts after call i, as in
//! the real layer chain where o_proj consumes the output). "cold" rotates
//! over distinct per-layer caches (working set > SLC, like the real model
//! where ~14 GB of weights stream between two calls to the same layer).

use candle_core::{DType, Device, Result, Storage, Tensor};
use candle_metal_kernels::metal::Buffer;
use objc2_metal::{
    MTLCommandBuffer, MTLCommandEncoder, MTLCommandQueue, MTLComputeCommandEncoder, MTLSize,
};
use rayon::prelude::*;
use std::ffi::c_void;
use std::ptr::NonNull;

use crate::attn_kernel::metal_impl::{compile_split, render, DecParams, SplitParams};
use crate::attn_kernel::{split_cfg, split_for, SPLIT_MAX, SPLIT_PAGE, SPLIT_QROWS};

const NH: usize = 24;
const NKV: usize = 4;
const HD: usize = 256;
const RP: usize = 32;
const GRP: usize = NH / NKV;

fn mbuf(t: &Tensor) -> Result<(Buffer, usize)> {
    let (st, l) = t.storage_and_layout();
    match &*st {
        Storage::Metal(m) => Ok((m.buffer().clone(), l.start_offset() * t.dtype().size_in_bytes())),
        _ => candle_core::bail!("attn_bench: non-Metal tensor"),
    }
}

fn env_list(name: &str, default: &[usize]) -> Vec<usize> {
    std::env::var(name)
        .ok()
        .map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect())
        .unwrap_or_else(|| default.to_vec())
}

fn host(t: &Tensor) -> Result<Vec<f32>> {
    t.to_dtype(DType::F32)?.flatten_all()?.to_vec1()
}

fn maxdiff(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max)
}

pub fn bench_attn() -> Result<()> {
    let dev = Device::new_metal(0)?;
    let Device::Metal(md) = &dev else { candle_core::bail!("metal only") };
    let raw = md.metal_device();
    let queue = raw.new_command_queue().map_err(candle_core::Error::wrap)?;

    let lib = raw
        .new_library_with_source(&render(NH, NKV, HD, RP), None)
        .map_err(candle_core::Error::wrap)?;
    let p_dec = {
        let f = lib.get_function("attn_decode", None).map_err(candle_core::Error::wrap)?;
        raw.new_compute_pipeline_state_with_function(&f).map_err(candle_core::Error::wrap)?
    };
    let t = std::time::Instant::now();
    // TH_BENCH_ATTN_P=f32|bf16 selects the probability type (default: the
    // engine's configured one)
    let p_f32 = std::env::var("TH_BENCH_ATTN_P").map_or(split_cfg().p_f32, |v| v.trim() == "f32");
    let (p_part, p_red) = compile_split(raw, NH, NKV, HD, p_f32)?;
    eprintln!(
        "[attn-bench] split library (Metal 4 / MPP, p={}) compiled in {:.0} ms; part maxTG={} reduce maxTG={}",
        if p_f32 { "f32" } else { "bf16" },
        t.elapsed().as_secs_f64() * 1e3,
        p_part.max_total_threads_per_threadgroup(),
        p_red.max_total_threads_per_threadgroup()
    );

    let lens = env_list("TH_BENCH_ATTN_LENS", &[128, 256, 384, 512, 1024, 1450, 2048, 4096, 8192, 16384, 32768]);
    let seqs = env_list("TH_BENCH_ATTN_SEQS", &[8, 1]);
    let split_list = env_list("TH_BENCH_ATTN_SPLITS", &[0, 8, 16, 32, 64, 128]);
    let tm = std::env::var("TH_BENCH_ATTN_TM").is_ok();
    let ref_max = env_list("TH_BENCH_ATTN_REF_MAX", &[8192])[0];
    let qscale: f64 = std::env::var("TH_BENCH_ATTN_QSCALE").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(1.0);
    let cfg = split_cfg();
    let packed = NH * 2 * HD + 2 * NKV * HD;
    let m_rows = SPLIT_QROWS * GRP;

    eprintln!(
        "[attn-bench] nh={NH} nkv={NKV} hd={HD} grp={GRP} layout={} qscale={qscale} policy={cfg:?}",
        if tm { "time-major" } else { "head-major" }
    );
    eprintln!("[attn-bench] per call GPU ms, cold (rotating per-layer caches); x16 = one verify's 16 attention layers");

    for &seq in &seqs {
        for &l in &lens {
            if l < seq {
                continue;
            }
            let pos = l - seq;
            let cap = l.next_multiple_of(256);
            let kv_bytes = NKV * cap * HD * 2;
            let nl = 16usize.min(((1usize << 30) / (2 * kv_bytes)).max(2));
            let mk = || -> Result<Tensor> {
                if tm {
                    Tensor::randn(0f32, 1.0, (cap, NKV, HD), &dev)?.to_dtype(DType::BF16)?.transpose(0, 1)
                } else {
                    Tensor::randn(0f32, 1.0, (NKV, cap, HD), &dev)?.to_dtype(DType::BF16)
                }
            };
            let kcs: Vec<Tensor> = (0..nl).map(|_| mk()).collect::<Result<_>>()?;
            let vcs: Vec<Tensor> = (0..nl).map(|_| mk()).collect::<Result<_>>()?;
            let q = (Tensor::randn(0f32, 1.0, (seq, NH, HD), &dev)? * qscale)?.to_dtype(DType::BF16)?;
            // KV-head-major tile copy [NKV][QROWS][GRP][HD], padding rows zero
            let q_kv = {
                let qg = q.reshape((seq, NKV, GRP, HD))?.permute((1, 0, 2, 3))?; // [NKV, seq, GRP, HD]
                let pad = SPLIT_QROWS - seq;
                let full = if pad > 0 {
                    Tensor::cat(&[qg, Tensor::zeros((NKV, pad, GRP, HD), DType::BF16, &dev)?], 1)?
                } else {
                    qg
                };
                full.contiguous()?.reshape((NKV * m_rows, HD))?
            };
            let qkv = Tensor::randn(0f32, 1.0, (1, seq, packed), &dev)?.to_dtype(DType::BF16)?;
            let out_old = Tensor::zeros((seq, NH * HD), DType::BF16, &dev)?;
            let out_split = Tensor::zeros((seq, NH * HD), DType::BF16, &dev)?;
            let pacc = Tensor::zeros((NKV * SPLIT_MAX * m_rows * HD,), DType::F32, &dev)?;
            let pml = Tensor::zeros((NKV * SPLIT_MAX * m_rows * 2,), DType::F32, &dev)?;
            dev.synchronize()?;

            let k_st = kcs[0].stride().to_vec();
            let v_st = vcs[0].stride().to_vec();
            let qkv_stride = qkv.stride()[1];
            let dp = DecParams {
                kv_len: l as i32,
                qkv_stride: qkv_stride as i32,
                khs: k_st[0] as i32,
                kts: k_st[1] as i32,
                vhs: v_st[0] as i32,
                vts: v_st[1] as i32,
                causal_base: pos as i32,
                _pad: 0,
            };
            let (qb, qo) = mbuf(&q)?;
            let (qkb, qko) = mbuf(&q_kv)?;
            let (gb, go) = mbuf(&qkv)?;
            let (oob, ooo) = mbuf(&out_old)?;
            let (osb, oso) = mbuf(&out_split)?;
            let (pab, pao) = mbuf(&pacc)?;
            let (pmb, pmo) = mbuf(&pml)?;
            let kb: Vec<(Buffer, usize)> = kcs.iter().map(mbuf).collect::<Result<_>>()?;
            let vb: Vec<(Buffer, usize)> = vcs.iter().map(mbuf).collect::<Result<_>>()?;
            let iters = (400_000 / l).clamp(8, 200);

            let run_old = |n: usize, rot: bool| -> f64 {
                let cb = queue.commandBuffer().expect("cb");
                let enc = cb.computeCommandEncoder().expect("enc");
                for i in 0..n {
                    let li = if rot { i % nl } else { 0 };
                    enc.setComputePipelineState(p_dec.as_ref());
                    unsafe {
                        enc.setBuffer_offset_atIndex(Some(qb.as_ref()), qo, 0);
                        enc.setBuffer_offset_atIndex(Some(kb[li].0.as_ref()), kb[li].1, 1);
                        enc.setBuffer_offset_atIndex(Some(vb[li].0.as_ref()), vb[li].1, 2);
                        enc.setBuffer_offset_atIndex(Some(gb.as_ref()), go, 3);
                        enc.setBuffer_offset_atIndex(Some(oob.as_ref()), ooo, 4);
                        enc.setBytes_length_atIndex(
                            NonNull::new(&dp as *const DecParams as *mut c_void).unwrap(),
                            std::mem::size_of::<DecParams>(),
                            5,
                        );
                    }
                    enc.dispatchThreadgroups_threadsPerThreadgroup(
                        MTLSize { width: NKV, height: seq, depth: 1 },
                        MTLSize { width: 32 * GRP, height: 1, depth: 1 },
                    );
                }
                enc.endEncoding();
                cb.commit();
                cb.waitUntilCompleted();
                (cb.GPUEndTime() - cb.GPUStartTime()) * 1e3 / n as f64
            };
            let run_split = |n: usize, rot: bool, splits: usize| -> f64 {
                let sp = SplitParams {
                    visible: l as u32,
                    causal_base: pos as u32,
                    active_rows: seq as u32,
                    splits: splits as u32,
                    khs: k_st[0] as u32,
                    kts: k_st[1] as u32,
                    vhs: v_st[0] as u32,
                    vts: v_st[1] as u32,
                    qkv_stride: qkv_stride as u32,
                    _pad: [0; 3],
                };
                let cb = queue.commandBuffer().expect("cb");
                let enc = cb.computeCommandEncoder().expect("enc");
                for i in 0..n {
                    let li = if rot { i % nl } else { 0 };
                    enc.setComputePipelineState(p_part.as_ref());
                    unsafe {
                        enc.setBuffer_offset_atIndex(Some(qkb.as_ref()), qko, 0);
                        enc.setBuffer_offset_atIndex(Some(kb[li].0.as_ref()), kb[li].1, 1);
                        enc.setBuffer_offset_atIndex(Some(vb[li].0.as_ref()), vb[li].1, 2);
                        enc.setBuffer_offset_atIndex(Some(pab.as_ref()), pao, 3);
                        enc.setBuffer_offset_atIndex(Some(pmb.as_ref()), pmo, 4);
                        enc.setBytes_length_atIndex(
                            NonNull::new(&sp as *const SplitParams as *mut c_void).unwrap(),
                            std::mem::size_of::<SplitParams>(),
                            5,
                        );
                    }
                    enc.dispatchThreadgroups_threadsPerThreadgroup(
                        MTLSize { width: NKV, height: splits, depth: 1 },
                        MTLSize { width: 256, height: 1, depth: 1 },
                    );
                    enc.setComputePipelineState(p_red.as_ref());
                    unsafe {
                        enc.setBuffer_offset_atIndex(Some(pab.as_ref()), pao, 0);
                        enc.setBuffer_offset_atIndex(Some(pmb.as_ref()), pmo, 1);
                        enc.setBuffer_offset_atIndex(Some(gb.as_ref()), go, 2);
                        enc.setBuffer_offset_atIndex(Some(osb.as_ref()), oso, 3);
                        enc.setBytes_length_atIndex(
                            NonNull::new(&sp as *const SplitParams as *mut c_void).unwrap(),
                            std::mem::size_of::<SplitParams>(),
                            4,
                        );
                    }
                    enc.dispatchThreadgroups_threadsPerThreadgroup(
                        MTLSize { width: NKV, height: seq * GRP, depth: 1 },
                        MTLSize { width: HD, height: 1, depth: 1 },
                    );
                }
                enc.endEncoding();
                cb.commit();
                cb.waitUntilCompleted();
                (cb.GPUEndTime() - cb.GPUStartTime()) * 1e3 / n as f64
            };

            // ---- timing (min of 3 batches) ----
            run_old(3, true);
            let mut old_cold = f64::MAX;
            for _ in 0..3 {
                old_cold = old_cold.min(run_old(iters, true));
            }
            let pages = l.div_ceil(SPLIT_PAGE);
            let policy = split_for(&cfg, l);
            let mut res: Vec<(usize, f64)> = Vec::new();
            for &s in &split_list {
                let splits = if s == 0 {
                    crate::attn_kernel::split_count(l, cfg.base, cfg.pps, SPLIT_MAX)
                } else {
                    s.min(pages).min(SPLIT_MAX)
                };
                if res.iter().any(|&(x, _)| x == splits) {
                    continue;
                }
                run_split(3, true, splits);
                let mut best = f64::MAX;
                for _ in 0..3 {
                    best = best.min(run_split(iters, true, splits));
                }
                res.push((splits, best));
            }
            let (best_s, best_ms) = res.iter().cloned().fold((0, f64::MAX), |a, b| if b.1 < a.1 { b } else { a });
            let pol_s = crate::attn_kernel::split_count(l, cfg.base, cfg.pps, SPLIT_MAX);
            let pol_ms = res.iter().find(|r| r.0 == pol_s).map(|r| r.1).unwrap_or(f64::NAN);

            // ---- numerics on layer 0 (split at the policy's count) ----
            let _ = run_old(1, false);
            let _ = run_split(1, false, pol_s);
            let o_old = host(&out_old)?;
            let o_split = host(&out_split)?;
            let d_so = maxdiff(&o_split, &o_old);
            let (mut d_or, mut d_sr) = (f32::NAN, f32::NAN);
            if l <= ref_max {
                let qh = host(&q)?;
                let kh = host(&kcs[0].contiguous()?)?; // [NKV, cap, HD] (logical order)
                let vh = host(&vcs[0].contiguous()?)?;
                let gh = host(&qkv)?;
                let reference: Vec<Vec<f32>> = (0..seq * NH)
                    .into_par_iter()
                    .map(|rh| {
                        let (r, h) = (rh / NH, rh % NH);
                        let kvh = h / GRP;
                        let lim = pos + r + 1;
                        let qv = &qh[(r * NH + h) * HD..(r * NH + h + 1) * HD];
                        let mut s = vec![0f64; lim];
                        for (t, st) in s.iter_mut().enumerate() {
                            let kr = &kh[(kvh * cap + t) * HD..(kvh * cap + t + 1) * HD];
                            *st = qv.iter().zip(kr).map(|(a, b)| *a as f64 * *b as f64).sum::<f64>()
                                / (HD as f64).sqrt();
                        }
                        let mx = s.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                        let mut den = 0f64;
                        let mut acc = vec![0f64; HD];
                        for (t, st) in s.iter().enumerate() {
                            let w = (st - mx).exp();
                            den += w;
                            let vr = &vh[(kvh * cap + t) * HD..(kvh * cap + t + 1) * HD];
                            for (a, v) in acc.iter_mut().zip(vr) {
                                *a += w * *v as f64;
                            }
                        }
                        (0..HD)
                            .map(|c| {
                                let g = gh[r * packed + h * 2 * HD + HD + c] as f64;
                                (acc[c] / den / (1.0 + (-g).exp())) as f32
                            })
                            .collect()
                    })
                    .collect();
                let flat: Vec<f32> = reference.into_iter().flatten().collect();
                d_or = maxdiff(&o_old, &flat);
                d_sr = maxdiff(&o_split, &flat);
            }
            let sweep: Vec<String> = res.iter().map(|(s, ms)| format!("s{s}={ms:.4}")).collect();
            eprintln!(
                "[attn-bench]{} seq={seq} L={l:5} | old={old_cold:.4} | split {} | policy s{pol_s}{}={pol_ms:.4} best s{best_s}={best_ms:.4} ({:.1}x) | x16: old {:.2} policy {:.2} ms | max|Δ| split-old={d_so:.5} old-ref={d_or:.5} split-ref={d_sr:.5}",
                if tm { "[TM]" } else { "" },
                sweep.join(" "),
                if policy.is_some() { "" } else { "(routed old)" },
                old_cold / best_ms,
                old_cold * 16.0,
                if policy.is_some() { pol_ms * 16.0 } else { old_cold * 16.0 },
            );
        }
    }
    Ok(())
}
