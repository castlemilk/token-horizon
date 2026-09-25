// Model loading + forward dispatch.
//
// Two weight formats:
//   - GGUF quantized (llama.cpp ecosystem quants — Q4_K_M etc.) via
//     candle's quantized model impls. Arch from `general.architecture`.
//   - safetensors dense/bf16 via candle-transformers models, arch from
//     config.json `model_type`.
//
// Both collapse to one `forward(&tokens, pos) -> logits[vocab]` shape so
// the generation loop in engine.rs stays backend-agnostic.

use anyhow::{anyhow, bail, Context, Result};
use candle_core::quantized::gguf_file;
use candle_core::{DType, Device, IndexOp, Tensor};
use candle_transformers::models as ct;
use std::path::{Path, PathBuf};

pub enum ModelBackend {
    GgufQwen2(ct::quantized_qwen2::ModelWeights),
    GgufQwen3(ct::quantized_qwen3::ModelWeights),
    GgufLlama(ct::quantized_llama::ModelWeights),
    Qwen2(ct::qwen2::ModelForCausalLM),
    Qwen3(ct::qwen3::ModelForCausalLM),
    Qwen35(crate::qwen35::Qwen35),
}

/// Opaque per-backend state snapshot for spec-decode rollback.
/// Clone is cheap — the tensors inside are refcounted device buffers.
#[derive(Clone)]
pub enum BackendSnapshot {
    Qwen35(Box<crate::qwen35::Snapshot>),
}

impl ModelBackend {
    /// Slot-aware forward for the Qwen35 batch path.
    pub fn forward_slot(
        &mut self,
        slot: usize,
        tokens: &[u32],
        pos: usize,
        device: &Device,
    ) -> Result<Tensor> {
        if let Self::Qwen35(m) = self {
            return Ok(m.forward(slot, tokens, pos)?.to_dtype(DType::F32)?);
        }
        self.forward(tokens, pos, device)
    }

    /// Returns logits for the last input position, shape (vocab,).
    pub fn forward(&mut self, tokens: &[u32], pos: usize, device: &Device) -> Result<Tensor> {
        let input = Tensor::new(tokens, device)?.unsqueeze(0)?;
        let out = match self {
            // quantized forwards already narrow to the last position:
            // (1, vocab) → squeeze batch → (vocab,)
            Self::GgufQwen2(m) => m.forward(&input, pos)?.squeeze(0)?,
            Self::GgufQwen3(m) => m.forward(&input, pos)?.squeeze(0)?,
            Self::GgufLlama(m) => m.forward(&input, pos)?.squeeze(0)?,
            // dense forwards return (1, seq, vocab) → last position
            Self::Qwen2(m) => {
                let l = m.forward(&input, pos)?;
                l.i((0, l.dim(1)? - 1))?
            }
            Self::Qwen3(m) => {
                let l = m.forward(&input, pos)?;
                l.i((0, l.dim(1)? - 1))?
            }
            // ours: logits already (vocab,)
            Self::Qwen35(m) => m.forward(0, tokens, pos)?,
        };
        Ok(out.to_dtype(DType::F32)?)
    }

    /// Logits for every input position — `[seq, vocab]`. Speculative
    /// verify only; qwen3_5-only for now.
    pub fn forward_multi(
        &mut self,
        tokens: &[u32],
        pos: usize,
        _device: &Device,
    ) -> Result<Tensor> {
        match self {
            Self::Qwen35(m) => m.forward_multi(0, tokens, pos),
            _ => bail!("forward_multi not supported by this backend"),
        }
    }

    /// Speculative decode requires snapshot/rollback of all mutable
    /// state (KV cache, GDN recurrence, conv window).
    pub fn spec_capable(&self) -> bool {
        matches!(self, Self::Qwen35(_))
    }

    // MARK: - DFlash neural draft (qwen3_5 only)

    /// Load a Splash DFlash `draft/` directory and attach it — turns on
    /// capture-layer hidden-state collection in every forward pass.
    /// Load a Splash DFlash `draft/` directory and attach one instance
    /// per decode slot (each slot owns its own K/V ring).
    pub fn attach_draft(&mut self, draft_dir: &Path) -> Result<()> {
        match self {
            Self::Qwen35(m) => {
                let w = crate::dflash::DraftWeights::load(draft_dir, m.device())?;
                m.set_draft(w)
            }
            _ => bail!("dflash draft requires the qwen3_5 backend"),
        }
    }

    pub fn has_draft(&self) -> bool {
        matches!(self, Self::Qwen35(m) if m.has_draft())
    }

    /// Warm the draft K/V ring with the captures accumulated during
    /// prefill. Call once after the prompt forward.
    pub fn draft_prefill(&mut self, slot: usize) -> Result<()> {
        if let Self::Qwen35(m) = self {
            m.draft_prefill(slot)?;
        }
        Ok(())
    }

    /// Captures accumulated since the last drain → [rows, 25600].
    pub fn take_captures(&mut self, slot: usize) -> Result<Option<Tensor>> {
        match self {
            Self::Qwen35(m) => m.take_captures(slot),
            _ => Ok(None),
        }
    }

    /// Commit `rows` of `captured` into the draft ring at `start_pos`.
    pub fn draft_commit(&mut self, slot: usize, captured: &Tensor, start_pos: usize, rows: usize) -> Result<()> {
        if let Self::Qwen35(m) = self {
            m.draft_commit(slot, captured, start_pos, rows)?;
        }
        Ok(())
    }

    /// Batched draft proposals — one draft forward for all slots.
    pub fn draft_propose_batch(
        &mut self,
        slots: &[usize],
        anchors: &[u32],
        poss: &[usize],
        temps: &[Option<f64>],
        uniform: &mut dyn FnMut(usize) -> f64,
    ) -> Result<Vec<crate::dflash::Proposal>> {
        match self {
            Self::Qwen35(m) => {
                m.draft_propose_batch(slots, anchors, poss, temps, uniform)
            }
            _ => bail!("draft_propose_batch not supported by this backend"),
        }
    }

    /// Chain a 7-token draft proposal for `anchor` at position `pos`.
    pub fn draft_propose(
        &mut self,
        slot: usize,
        anchor: u32,
        pos: usize,
        temp: Option<f64>,
        uniform: impl FnMut() -> f64,
    ) -> Result<crate::dflash::Proposal> {
        match self {
            Self::Qwen35(m) => m.draft_propose(slot, anchor, pos, temp, uniform),
            _ => bail!("draft_propose not supported by this backend"),
        }
    }

    /// Runtime KV-quantisation toggle (qwen3_5 only; clears the cache —
    /// callers must invoke between requests).
    pub fn set_kv_quant(&mut self, on: bool) -> Result<()> {
        if let Self::Qwen35(m) = self {
            m.set_kv_quant(on)?;
        }
        Ok(())
    }

    /// Per-slot admission-time toggle — clears only `slot`.
    pub fn set_kv_quant_slot(&mut self, on: bool, slot: usize) -> Result<()> {
        if let Self::Qwen35(m) = self {
            m.set_kv_quant_slot(on, slot)?;
        }
        Ok(())
    }

    pub fn snapshot(&mut self, slot: usize) -> Result<BackendSnapshot> {
        match self {
            Self::Qwen35(m) => Ok(BackendSnapshot::Qwen35(Box::new(m.snapshot(slot)?))),
            _ => bail!("snapshot not supported by this backend"),
        }
    }

    pub fn restore(&mut self, slot: usize, snap: BackendSnapshot) -> Result<()> {
        match (self, snap) {
            (Self::Qwen35(m), BackendSnapshot::Qwen35(s)) => {
                m.restore(slot, *s)
            }
            _ => Ok(()),
        }
    }

    /// Selective rollback — keep `kept` committed rows of the verify
    /// pass rather than restoring + re-forwarding them (DFlash loop).
    pub fn rollback_verify(
        &mut self,
        slot: usize,
        snap: BackendSnapshot,
        kept: usize,
    ) -> Result<()> {
        match (self, snap) {
            (Self::Qwen35(m), BackendSnapshot::Qwen35(s)) => {
                m.rollback_verify(slot, *s, kept)
            }
            _ => bail!("rollback_verify not supported by this backend"),
        }
    }

    pub fn clear_kv_cache(&mut self, slot: usize) {
        match self {
            Self::GgufQwen2(m) => m.clear_kv_cache(),
            Self::GgufQwen3(m) => m.clear_kv_cache(),
            Self::GgufLlama(m) => m.clear_kv_cache(),
            Self::Qwen2(m) => m.clear_kv_cache(),
            Self::Qwen3(m) => m.clear_kv_cache(),
            Self::Qwen35(m) => m.clear_kv_cache(slot),
        }
    }

    /// Decode-slot count (TH_BATCH) — 1 for non-batched backends.
    pub fn nslots(&self) -> usize {
        match self {
            Self::Qwen35(m) => m.nslots(),
            _ => 1,
        }
    }

    /// Batched verify forward — `seqs`/`poss` per slot. Returns
    /// `[Σseq, vocab]`. qwen3_5 only.
    pub fn forward_batch(
        &mut self,
        slots: &[usize],
        seqs: &[&[u32]],
        poss: &[usize],
    ) -> Result<Tensor> {
        match self {
            Self::Qwen35(m) => m.forward_batch(slots, seqs, poss),
            _ => bail!("forward_batch not supported by this backend"),
        }
    }
}

pub struct LoadedModel {
    pub backend: ModelBackend,
    pub tokenizer: tokenizers::Tokenizer,
    /// EOS token ids — from config.json `eos_token_id` (int or list).
    pub eos_ids: Vec<u32>,
    /// Jinja chat template from tokenizer_config.json, if present.
    pub chat_template: Option<String>,
    /// Extra metadata for /status (arch, quant, context length).
    pub meta: serde_json::Value,
    pub device: Device,
}

// MARK: - resolution

/// A `model` arg is either a local path (dir or .gguf) or an HF repo id
/// with an optional `repo:file` split. Download via hf-hub when needed.
/// `tokenizer_src` overrides where tokenizer.json (+ config/template) come
/// from — required for GGUF repos that ship weights only.
pub async fn resolve_and_load(
    model: &str,
    file: Option<&str>,
    tokenizer_src: Option<&str>,
) -> Result<LoadedModel> {
    let aux = match tokenizer_src {
        Some(src) => Some(resolve_aux_dir(src).await?),
        None => None,
    };
    let path = PathBuf::from(model);
    if path.exists() {
        return load_local(&path, aux);
    }
    load_hf(model, file, aux).await
}

/// Resolve a tokenizer source (local dir/file or HF repo id) to a directory
/// containing tokenizer.json and whatever aux files (tokenizer_config.json,
/// config.json) the source ships.
async fn resolve_aux_dir(src: &str) -> Result<PathBuf> {
    let p = PathBuf::from(src);
    if p.is_dir() {
        return Ok(p);
    }
    if p.is_file() {
        return Ok(p.parent().unwrap_or_else(|| Path::new(".")).to_path_buf());
    }
    let api = hf_hub::api::tokio::Api::new()?;
    let repo = api.model(src.to_string());
    let tok = repo
        .get("tokenizer.json")
        .await
        .context(format!("tokenizer repo {src}: no tokenizer.json"))?;
    // Aux files are best-effort — eos ids and chat template degrade to
    // GGUF metadata / raw prompt formatting when absent.
    let _ = repo.get("tokenizer_config.json").await;
    let _ = repo.get("config.json").await;
    Ok(tok.parent().unwrap_or_else(|| Path::new(".")).to_path_buf())
}

fn load_local(path: &Path, aux: Option<PathBuf>) -> Result<LoadedModel> {
    if path.is_dir() {
        load_safetensors_dir(path)
    } else if path.extension().map(|e| e == "gguf").unwrap_or(false) {
        load_gguf(std::slice::from_ref(&path.to_path_buf()), aux)
    } else {
        bail!("unrecognized model path: {} (want a dir or .gguf)", path.display())
    }
}

async fn load_hf(repo: &str, file: Option<&str>, aux: Option<PathBuf>) -> Result<LoadedModel> {
    let (repo, inline_file) = match repo.split_once(':') {
        Some((r, f)) => (r, Some(f)),
        None => (repo, file),
    };
    let api = hf_hub::api::tokio::Api::new()?;
    let repo_api = api.model(repo.to_string());

    let file = match inline_file {
        Some(f) => f.to_string(),
        None => pick_weight_file(&repo_api, repo).await?,
    };

    if file.ends_with(".gguf") {
        let p = repo_api.get(&file).await?;
        // GGUF repos often ship tokenizer.json alongside the quants;
        // grab it + config when present.
        let _ = repo_api.get("tokenizer.json").await;
        let _ = repo_api.get("config.json").await;
        let _ = repo_api.get("tokenizer_config.json").await;
        return load_gguf(&[p], aux);
    }

    // Safetensors repo: fetch config + tokenizer + all weight shards.
    let cfg_p = repo_api.get("config.json").await?;
    let tok_p = repo_api.get("tokenizer.json").await?;
    let tok_cfg_p = repo_api.get("tokenizer_config.json").await.ok();
    let weights = fetch_safetensors(&repo_api).await?;
    load_dense(&cfg_p, &tok_p, tok_cfg_p.as_deref(), &weights)
}

/// Pick the weight entrypoint in an HF repo: a single .gguf, the named
/// quant, or safetensors.
async fn pick_weight_file(
    repo_api: &hf_hub::api::tokio::ApiRepo,
    repo: &str,
) -> Result<String> {
    let info = repo_api.info().await?;
    let ggufs: Vec<&str> = info
        .siblings
        .iter()
        .map(|s| s.rfilename.as_str())
        .filter(|f| f.ends_with(".gguf"))
        .collect();
    if ggufs.is_empty() {
        return Ok("model.safetensors".to_string()); // placeholder — real list below
    }
    // Prefer a Q4_K_M quant; else a single-file gguf; else error listing.
    if let Some(q4) = ggufs.iter().find(|f| f.contains("Q4_K_M")) {
        return Ok(q4.to_string());
    }
    if ggufs.len() == 1 {
        return Ok(ggufs[0].to_string());
    }
    bail!(
        "{repo} has {} gguf files; pass --file to pick one: {:?}",
        ggufs.len(),
        ggufs.iter().take(10).collect::<Vec<_>>()
    )
}

async fn fetch_safetensors(
    repo_api: &hf_hub::api::tokio::ApiRepo,
) -> Result<Vec<PathBuf>> {
    // Try the sharded index first; fall back to a single file.
    if let Ok(index_p) = repo_api.get("model.safetensors.index.json").await {
        let index: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&index_p)?)?;
        let mut names: Vec<String> = index["weight_map"]
            .as_object()
            .map(|m| m.values().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        names.sort();
        names.dedup();
        let mut out = Vec::with_capacity(names.len());
        for n in names {
            out.push(repo_api.get(&n).await?);
        }
        return Ok(out);
    }
    Ok(vec![repo_api.get("model.safetensors").await?])
}

// MARK: - loaders

fn load_gguf(paths: &[PathBuf], aux: Option<PathBuf>) -> Result<LoadedModel> {
    let device = Device::new_metal(0).unwrap_or(Device::Cpu);
    tracing::info!(?paths, ?device, "loading GGUF");

    let path = match paths {
        [single] => single,
        _ => bail!("multi-shard GGUF not supported yet — pass one .gguf file"),
    };
    let mut reader = std::fs::File::open(path)?;
    let content = gguf_file::Content::read(&mut reader)?;
    let arch = content
        .metadata
        .get("general.architecture")
        .and_then(|v| v.to_string().ok().map(|s| s.clone()))
        .unwrap_or_default();
    let ctx_len = content
        .metadata
        .get(&format!("{arch}.context_length"))
        .and_then(|v| v.to_u32().ok())
        .unwrap_or(0);
    let gguf_eos = content
        .metadata
        .get("tokenizer.ggml.eos_token_id")
        .and_then(|v| v.to_u32().ok());

    let backend = match arch.as_str() {
        "qwen3" => ModelBackend::GgufQwen3(ct::quantized_qwen3::ModelWeights::from_gguf(
            content, &mut reader, &device,
        )?),
        "qwen2" => ModelBackend::GgufQwen2(ct::quantized_qwen2::ModelWeights::from_gguf(
            content, &mut reader, &device,
        )?),
        "llama" => ModelBackend::GgufLlama(ct::quantized_llama::ModelWeights::from_gguf(
            content, &mut reader, &device,
        )?),
        other => bail!("unsupported gguf architecture: {other}"),
    };

    // Tokenizer/aux dir: --tokenizer wins, else the .gguf's own directory.
    let default_dir = path.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
    let dir = aux.as_deref().unwrap_or(&default_dir);
    let tokenizer = load_tokenizer(dir)
        .context("no tokenizer.json for the .gguf — pass --tokenizer <hf-repo|dir>")?;
    // EOS: aux/config.json first, else GGUF metadata, else the tokenizer's
    // declared eos token.
    let mut eos_ids = eos_from_dir(dir);
    if eos_ids.is_empty() {
        if let Some(e) = gguf_eos {
            eos_ids.push(e);
        }
    }
    if eos_ids.is_empty() {
        if let Some(id) = tokenizer.get_vocab(true).get("<|im_end|>").copied()
            .or_else(|| tokenizer.get_vocab(true).get("<|endoftext|>").copied())
        {
            eos_ids.push(id);
        }
    }
    let chat_template = template::chat_template_from(dir);

    Ok(LoadedModel {
        backend,
        tokenizer,
        eos_ids,
        chat_template,
        meta: serde_json::json!({
            "format": "gguf", "arch": arch, "context_length": ctx_len,
            "files": [path.display().to_string()],
        }),
        device,
    })
}

fn load_safetensors_dir(dir: &Path) -> Result<LoadedModel> {
    let cfg_p = dir.join("config.json");
    let tok_p = dir.join("tokenizer.json");
    let weights = {
        let index = dir.join("model.safetensors.index.json");
        if index.exists() {
            let idx: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&index)?)?;
            let mut names: Vec<String> = idx["weight_map"]
                .as_object()
                .map(|m| m.values().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            names.sort();
            names.dedup();
            names.iter().map(|n| dir.join(n)).collect()
        } else {
            vec![dir.join("model.safetensors")]
        }
    };
    load_dense(&cfg_p, &tok_p, Some(&dir.join("tokenizer_config.json")), &weights)
}

fn load_dense(
    cfg_p: &Path,
    tok_p: &Path,
    tok_cfg_p: Option<&Path>,
    weights: &[PathBuf],
) -> Result<LoadedModel> {
    let cfg_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cfg_p)?).context("config.json")?;
    let model_type = cfg_json["model_type"]
        .as_str()
        .or_else(|| {
            cfg_json["text_config"]["model_type"].as_str()
        })
        .unwrap_or("")
        .to_string();

    // qwen3_5 is our own port (hybrid GDN + full attention); it runs on
    // Metal in BF16 — MLX-quantized safetensors are dequantized at load.
    if model_type.starts_with("qwen3_5") {
        let device = Device::new_metal(0).unwrap_or(Device::Cpu);
        let cfg = crate::qwen35::Qwen35Config::from_json(&cfg_json)?;
        tracing::info!(%model_type, ?device, files = weights.len(), "loading qwen3_5");
        let backend = ModelBackend::Qwen35(crate::qwen35::Qwen35::load(weights, &cfg, &device)?);
        let tokenizer = tokenizers::Tokenizer::from_file(tok_p)
            .map_err(|e| anyhow!("tokenizer load: {e}"))?;
        let mut eos_ids = eos_ids_from_config(&cfg_json);
        if eos_ids.is_empty() {
            eos_ids = eos_ids_from_config(&cfg_json["text_config"]);
        }
        let chat_template = tok_cfg_p
            .and_then(|p| template::chat_template_file(p))
            .or_else(|| {
                tok_p.parent().and_then(|d| {
                    std::fs::read_to_string(d.join("chat_template.jinja")).ok()
                })
            });
        return Ok(LoadedModel {
            backend,
            tokenizer,
            eos_ids,
            chat_template,
            meta: serde_json::json!({
                "format": "mlx-safetensors", "model_type": model_type,
                "context_length": cfg.max_position_embeddings,
                "files": weights.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
            }),
            device,
        });
    }

    // Dense safetensors on Metal hits unimplemented ops (rms-norm) in
    // candle 0.11, and CPU lacks bf16 matmul — so dense runs F32 on CPU
    // (a correctness/dev path). GGUF quantized models use their own
    // Metal kernels and run on GPU — that's the performance path.
    let device = Device::Cpu;
    let dtype = DType::F32;
    tracing::info!(%model_type, ?device, files = weights.len(), "loading safetensors");

    let vb = unsafe {
        candle_nn::VarBuilder::from_mmaped_safetensors(weights, dtype, &device)?
    };
    let backend = match model_type.as_str() {
        "qwen2" => {
            let cfg: ct::qwen2::Config = serde_json::from_value(cfg_json.clone())?;
            ModelBackend::Qwen2(ct::qwen2::ModelForCausalLM::new(&cfg, vb)?)
        }
        "qwen3" => {
            let cfg: ct::qwen3::Config = serde_json::from_value(cfg_json.clone())?;
            ModelBackend::Qwen3(ct::qwen3::ModelForCausalLM::new(&cfg, vb)?)
        }
        other => bail!("unsupported safetensors model_type: {other} (supported: qwen2, qwen3 — or pass a .gguf)"),
    };

    let tokenizer = tokenizers::Tokenizer::from_file(tok_p)
        .map_err(|e| anyhow!("tokenizer load: {e}"))?;
    let eos_ids = eos_ids_from_config(&cfg_json);
    let chat_template = tok_cfg_p.and_then(|p| template::chat_template_file(p));

    Ok(LoadedModel {
        backend,
        tokenizer,
        eos_ids,
        chat_template,
        meta: serde_json::json!({
            "format": "safetensors", "model_type": model_type,
            "context_length": cfg_json["max_position_embeddings"].as_u64().unwrap_or(0),
            "files": weights.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        }),
        device,
    })
}

fn load_tokenizer(dir: &Path) -> Result<tokenizers::Tokenizer> {
    tokenizers::Tokenizer::from_file(dir.join("tokenizer.json"))
        .map_err(|e| anyhow!("tokenizer load: {e}"))
}

/// EOS ids from config.json `eos_token_id` (int or list) in a model dir.
fn eos_from_dir(dir: &Path) -> Vec<u32> {
    std::fs::read(dir.join("config.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .map(|c| eos_ids_from_config(&c))
        .unwrap_or_default()
}

fn eos_ids_from_config(cfg: &serde_json::Value) -> Vec<u32> {
    match &cfg["eos_token_id"] {
        serde_json::Value::Number(n) => n.as_u64().map(|v| vec![v as u32]).unwrap_or_default(),
        serde_json::Value::Array(a) => a.iter().filter_map(|v| v.as_u64().map(|x| x as u32)).collect(),
        _ => vec![],
    }
}

use crate::template;
