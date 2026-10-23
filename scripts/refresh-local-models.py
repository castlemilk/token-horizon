#!/usr/bin/env python3
"""Refresh the local-model catalogue — clients/macos/Resources/local-models.json.

The catalogue is what Token Horizon offers to RUN on this machine: the models
the supervised engines can actually serve, each with the size its quantisation
needs on disk.

Engines covered:

  thengine  our Rust/candle sidecar (:8001). GGUF on Metal via candle's
            quantized kernels — architectures qwen2, qwen3, llama. Also the
            qwen3_5 path: MLX 4-bit safetensors for hybrid GDN models, with
            fused packed-weight kernels, TurboQuant KV and DFlash draft.
  splash    incoai's specialised engine (:8000), its own packaged format.
  mlx       Apple's mlx-lm server (:8002), the canonical Mac engine. Any
            mlx-community checkpoint runs; the 4-bit conversions are the
            ones worth offering.

Sizes come from the Hugging Face API, so a row never claims a download size
the model does not have. The curation — which models belong in the list, the
quantisations worth offering, the RAM tiers — is hand-kept: a product
decision, not a scrape.

Only models the engine can actually load belong here. TH Engine's GGUF loader
takes a single .gguf (multi-shard repos are rejected), so shard-only quants
are excluded; the single-file Q4_K_M builds are the ones listed.

Usage:
  scripts/refresh-local-models.py            # fetch sizes + write the resource
  scripts/refresh-local-models.py --check    # report only
"""

import argparse
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "clients/macos/Resources/local-models.json")

HF = "https://huggingface.co/api/models/"

# `size` picks how the download is measured:
#   file     one pinned .gguf (the default when `file` is set)
#   package  every file in the repo (Splash ships its own layout)
#   weights  the safetensors shards plus configs (an MLX checkpoint dir)
#
# `minRAMGB` is where the model stops fighting the rest of the machine;
# `recommendedRAMGB` is where it leaves real headroom for context and apps.
MODELS = [
    # ── TH Engine · Qwen3 GGUF ──────────────────────────────────────────────
    dict(id="Qwen/Qwen3-0.6B-GGUF", name="Qwen3 0.6B", engine="thengine", family="qwen3",
         paramsB=0.6, quant="Q8_0", file="Qwen3-0.6B-Q8_0.gguf", contextK=32768,
         caps=["tools", "thinking"], minRAMGB=3, recommendedRAMGB=8, license="apache-2.0",
         tokenizer="Qwen/Qwen3-0.6B"),
    dict(id="Qwen/Qwen3-1.7B-GGUF", name="Qwen3 1.7B", engine="thengine", family="qwen3",
         paramsB=1.7, quant="Q8_0", file="Qwen3-1.7B-Q8_0.gguf", contextK=32768,
         caps=["tools", "thinking"], minRAMGB=4, recommendedRAMGB=8, license="apache-2.0",
         tokenizer="Qwen/Qwen3-1.7B"),
    dict(id="Qwen/Qwen3-4B-GGUF", name="Qwen3 4B", engine="thengine", family="qwen3",
         paramsB=4.0, quant="Q4_K_M", file="Qwen3-4B-Q4_K_M.gguf", contextK=32768,
         caps=["tools", "thinking"], minRAMGB=6, recommendedRAMGB=12, license="apache-2.0",
         tokenizer="Qwen/Qwen3-4B"),
    dict(id="Qwen/Qwen3-8B-GGUF", name="Qwen3 8B", engine="thengine", family="qwen3",
         paramsB=8.2, quant="Q4_K_M", file="Qwen3-8B-Q4_K_M.gguf", contextK=32768,
         caps=["tools", "thinking"], minRAMGB=8, recommendedRAMGB=16, license="apache-2.0",
         tokenizer="Qwen/Qwen3-8B"),
    dict(id="Qwen/Qwen3-14B-GGUF", name="Qwen3 14B", engine="thengine", family="qwen3",
         paramsB=14.8, quant="Q4_K_M", file="Qwen3-14B-Q4_K_M.gguf", contextK=32768,
         caps=["tools", "thinking"], minRAMGB=12, recommendedRAMGB=24, license="apache-2.0",
         tokenizer="Qwen/Qwen3-14B"),
    dict(id="Qwen/Qwen3-30B-A3B-GGUF", name="Qwen3 30B-A3B (MoE)", engine="thengine", family="qwen3",
         paramsB=30.5, quant="Q4_K_M", file="Qwen3-30B-A3B-Q4_K_M.gguf", contextK=32768,
         caps=["tools", "thinking", "moe"], minRAMGB=22, recommendedRAMGB=48, license="apache-2.0",
         tokenizer="Qwen/Qwen3-30B-A3B"),
    dict(id="Qwen/Qwen3-32B-GGUF", name="Qwen3 32B", engine="thengine", family="qwen3",
         paramsB=32.7, quant="Q4_K_M", file="Qwen3-32B-Q4_K_M.gguf", contextK=32768,
         caps=["tools", "thinking"], minRAMGB=24, recommendedRAMGB=48, license="apache-2.0",
         tokenizer="Qwen/Qwen3-32B"),

    # ── TH Engine · Qwen2.5 GGUF (coding) ───────────────────────────────────
    dict(id="Qwen/Qwen2.5-Coder-7B-Instruct-GGUF", name="Qwen2.5 Coder 7B", engine="thengine",
         family="qwen2", paramsB=7.6, quant="Q4_K_M",
         file="qwen2.5-coder-7b-instruct-q4_k_m.gguf", contextK=32768,
         caps=["tools", "code"], minRAMGB=8, recommendedRAMGB=16, license="apache-2.0",
         tokenizer="Qwen/Qwen2.5-Coder-7B-Instruct"),
    dict(id="Qwen/Qwen2.5-Coder-14B-Instruct-GGUF", name="Qwen2.5 Coder 14B", engine="thengine",
         family="qwen2", paramsB=14.8, quant="Q4_K_M",
         file="qwen2.5-coder-14b-instruct-q4_k_m.gguf", contextK=32768,
         caps=["tools", "code"], minRAMGB=12, recommendedRAMGB=24, license="apache-2.0",
         tokenizer="Qwen/Qwen2.5-Coder-14B-Instruct"),
    dict(id="Qwen/Qwen2.5-Coder-32B-Instruct-GGUF", name="Qwen2.5 Coder 32B", engine="thengine",
         family="qwen2", paramsB=32.8, quant="Q4_K_M",
         file="qwen2.5-coder-32b-instruct-q4_k_m.gguf", contextK=32768,
         caps=["tools", "code"], minRAMGB=24, recommendedRAMGB=48, license="apache-2.0",
         tokenizer="Qwen/Qwen2.5-Coder-32B-Instruct"),
    dict(id="bartowski/Qwen2.5-32B-Instruct-GGUF", name="Qwen2.5 32B", engine="thengine",
         family="qwen2", paramsB=32.8, quant="Q4_K_M", file="Qwen2.5-32B-Instruct-Q4_K_M.gguf",
         contextK=32768, caps=["tools"], minRAMGB=24, recommendedRAMGB=48, license="apache-2.0",
         tokenizer="Qwen/Qwen2.5-32B-Instruct"),

    # ── TH Engine · Llama GGUF ──────────────────────────────────────────────
    dict(id="unsloth/Llama-3.2-3B-Instruct-GGUF", name="Llama 3.2 3B", engine="thengine",
         family="llama", paramsB=3.2, quant="Q4_K_M", file="Llama-3.2-3B-Instruct-Q4_K_M.gguf",
         contextK=131072, caps=["tools"], minRAMGB=6, recommendedRAMGB=12, license="llama3.2",
         tokenizer="unsloth/Llama-3.2-3B-Instruct"),
    dict(id="unsloth/Llama-3.1-8B-Instruct-GGUF", name="Llama 3.1 8B", engine="thengine",
         family="llama", paramsB=8.0, quant="Q4_K_M", file="Llama-3.1-8B-Instruct-Q4_K_M.gguf",
         contextK=131072, caps=["tools"], minRAMGB=8, recommendedRAMGB=16, license="llama3.1",
         tokenizer="unsloth/Llama-3.1-8B-Instruct"),
    dict(id="unsloth/Llama-3.3-70B-Instruct-GGUF", name="Llama 3.3 70B", engine="thengine",
         family="llama", paramsB=70.6, quant="Q4_K_M", file="Llama-3.3-70B-Instruct-Q4_K_M.gguf",
         contextK=131072, caps=["tools"], minRAMGB=48, recommendedRAMGB=96, license="llama3.3",
         tokenizer="unsloth/Llama-3.3-70B-Instruct"),

    # ── TH Engine · qwen3_5 MLX 4-bit (fused kernels, TurboQuant KV, DFlash) ─
    dict(id="mlx-community/Qwen3.8-27B-4bit", name="Qwen3.8 27B · MLX 4-bit", engine="thengine",
         family="qwen3_5", paramsB=27.0, quant="MLX 4-bit", file=None, contextK=262144,
         caps=["tools", "thinking", "vision", "speculative"], minRAMGB=24, recommendedRAMGB=48,
         license="apache-2.0", tokenizer=None, size="weights"),

    # ── Splash · packaged engines ───────────────────────────────────────────
    dict(id="incoai/Qwen3.8-27B-Splash", name="Qwen3.8 27B (Splash)", engine="splash",
         family="qwen3_5", paramsB=27.0, quant="Splash", file=None, contextK=262144,
         caps=["tools", "thinking", "vision", "speculative"], minRAMGB=24, recommendedRAMGB=48,
         license="apache-2.0", tokenizer=None, size="package"),
    dict(id="incoai/Qwen3.6-35B-A3B-Splash", name="Qwen3.6 35B-A3B (Splash)", engine="splash",
         family="qwen3_5", paramsB=35.0, quant="Splash", file=None, contextK=262144,
         caps=["tools", "thinking", "moe", "speculative"], minRAMGB=28, recommendedRAMGB=48,
         license="apache-2.0", tokenizer=None, size="package"),

    # ── MLX · mlx-lm roster (any mlx-community checkpoint runs) ─────────────
    dict(id="mlx-community/Qwen3-4B-Instruct-2507-4bit", name="Qwen3 4B Instruct 2507",
         engine="mlx", family="qwen3", paramsB=4.0, quant="MLX 4-bit", file=None,
         contextK=262144, caps=["tools", "thinking"], minRAMGB=6, recommendedRAMGB=12,
         license="apache-2.0", tokenizer=None, size="weights"),
    dict(id="mlx-community/Qwen3-8B-4bit", name="Qwen3 8B", engine="mlx", family="qwen3",
         paramsB=8.2, quant="MLX 4-bit", file=None, contextK=32768,
         caps=["tools", "thinking"], minRAMGB=8, recommendedRAMGB=16, license="apache-2.0",
         tokenizer=None, size="weights"),
    dict(id="mlx-community/Qwen3-14B-4bit", name="Qwen3 14B", engine="mlx", family="qwen3",
         paramsB=14.8, quant="MLX 4-bit", file=None, contextK=32768,
         caps=["tools", "thinking"], minRAMGB=12, recommendedRAMGB=24, license="apache-2.0",
         tokenizer=None, size="weights"),
    dict(id="mlx-community/Qwen3-30B-A3B-4bit", name="Qwen3 30B-A3B (MoE)", engine="mlx",
         family="qwen3", paramsB=30.5, quant="MLX 4-bit", file=None, contextK=32768,
         caps=["tools", "thinking", "moe"], minRAMGB=22, recommendedRAMGB=48,
         license="apache-2.0", tokenizer=None, size="weights"),
    dict(id="mlx-community/Qwen3-32B-4bit", name="Qwen3 32B", engine="mlx", family="qwen3",
         paramsB=32.7, quant="MLX 4-bit", file=None, contextK=32768,
         caps=["tools", "thinking"], minRAMGB=24, recommendedRAMGB=48, license="apache-2.0",
         tokenizer=None, size="weights"),
    dict(id="mlx-community/Qwen2.5-Coder-32B-Instruct-4bit", name="Qwen2.5 Coder 32B", engine="mlx",
         family="qwen2", paramsB=32.8, quant="MLX 4-bit", file=None, contextK=32768,
         caps=["tools", "code"], minRAMGB=24, recommendedRAMGB=48, license="apache-2.0",
         tokenizer=None, size="weights"),
    dict(id="mlx-community/Llama-3.3-70B-Instruct-4bit", name="Llama 3.3 70B", engine="mlx",
         family="llama", paramsB=70.6, quant="MLX 4-bit", file=None, contextK=131072,
         caps=["tools"], minRAMGB=48, recommendedRAMGB=96, license="llama3.3",
         tokenizer=None, size="weights"),
]

# Runtime overhead above the weights, per engine: the process, the graph/arena
# and the allocator slack. KV cache is charged separately at serve time.
OVERHEAD_GB = {"thengine": 1.2, "splash": 1.2, "mlx": 1.6}


def fetch(repo: str) -> dict:
    req = urllib.request.Request(HF + repo + "?blobs=true", headers={"User-Agent": "token-horizon-catalog"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except Exception as e:
        print(f"  ! {repo}: hub unreachable ({e}) — skipped")
        return {}


def size_of(doc: dict, filename: str | None, mode: str) -> float | None:
    """Download size for one row, in GB — the real number from the hub."""
    siblings = doc.get("siblings") or []
    if mode == "file" or (filename and mode != "weights" and mode != "package"):
        for s in siblings:
            if s.get("rfilename") == filename:
                return round((s.get("size") or 0) / 1e9, 1)
        return None
    total = 0
    for s in siblings:
        name = s.get("rfilename", "")
        size = s.get("size") or 0
        if mode == "weights":
            # A checkpoint dir: the shards dominate; configs/tokenizers are noise.
            if not (name.endswith(".safetensors") or name.endswith(".json")):
                continue
            if size < 1_000_000:
                continue
        total += size
    return round(total / 1e9, 1) if total else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    cache: dict[str, dict] = {}
    out = []
    for m in MODELS:
        repo = m["id"]
        if repo not in cache:
            cache[repo] = fetch(repo)
        mode = m.get("size") or ("file" if m.get("file") else "package")
        size = size_of(cache[repo], m.get("file"), mode)
        if size is None:
            print(f"  ! {repo}: no size for {m.get('file') or mode} — skipped")
            continue
        entry = {k: v for k, v in m.items() if k != "size"}
        entry["sizeGB"] = size
        entry["residentGB"] = round(size + OVERHEAD_GB.get(m["engine"], 1.2), 1)
        entry["capabilities"] = entry.pop("caps")
        out.append(entry)
        print(f"  {entry['engine']:<8} {m['name']:<28} {size:>6.1f} GB  {m['quant']:<9} {repo}")

    if args.check:
        return 0
    doc = {
        "_meta": ("Models the supervised engines can serve locally, with the size each "
                  "quantisation needs on disk. Sizes are fetched from the Hugging Face "
                  "API by scripts/refresh-local-models.py; the curation is hand-kept."),
        "engines": {
            "thengine": "Token Horizon's Rust/candle sidecar — GGUF on Metal (qwen2/qwen3/llama), "
                        "MLX 4-bit qwen3_5 with fused kernels, TurboQuant KV and DFlash draft.",
            "splash": "incoai's specialised engine — its own packaged format.",
            "mlx": "Apple's mlx-lm server — any mlx-community checkpoint.",
        },
        "models": out,
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print(f"\nwrote {len(out)} models -> {os.path.relpath(OUT, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
