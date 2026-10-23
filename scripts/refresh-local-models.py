#!/usr/bin/env python3
"""Refresh the local-model catalogue — clients/macos/Resources/local-models.json.

The catalogue is what Token Horizon offers to RUN on this machine: the
models the bundled engines can actually serve (TH Engine serves GGUF
qwen2/qwen3/llama and safetensors qwen2/qwen3; Splash serves its own
roster), each with the size its quantisation needs on disk.

Sizes come from the Hugging Face API, so a row never claims a download
size the model does not have. The curation — which models belong in the
list, the quantisations worth offering, the RAM tiers — is hand-kept in
this file: it is a product decision, not a scrape.

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

# The curated list. `repo` is where the weights live, `file` the exact
# quantisation file (None = the repo's default GGUF), `context` the model's
# native window, `caps` what it can do, and the RAM tiers the size implies.
# `tokenizer` is the sibling repo the engine needs for a GGUF (a GGUF ships
# no tokenizer.json).
MODELS = [
    dict(id="Qwen/Qwen3-32B-GGUF", name="Qwen3 32B", engine="thengine", family="qwen3",
         paramsB=32.7, quant="Q4_K_M", file="Qwen3-32B-Q4_K_M.gguf", contextK=32768,
         caps=["tools"], minRAMGB=24, recommendedRAMGB=48, license="apache-2.0",
         tokenizer="Qwen/Qwen3-32B"),
    dict(id="Qwen/Qwen3-30B-A3B-GGUF", name="Qwen3 30B-A3B (MoE)", engine="thengine", family="qwen3",
         paramsB=30.5, quant="Q4_K_M", file="Qwen3-30B-A3B-Q4_K_M.gguf", contextK=32768,
         caps=["tools"], minRAMGB=22, recommendedRAMGB=48, license="apache-2.0",
         tokenizer="Qwen/Qwen3-30B-A3B"),
    dict(id="Qwen/Qwen3-14B-GGUF", name="Qwen3 14B", engine="thengine", family="qwen3",
         paramsB=14.8, quant="Q4_K_M", file="Qwen3-14B-Q4_K_M.gguf", contextK=32768,
         caps=["tools"], minRAMGB=12, recommendedRAMGB=24, license="apache-2.0",
         tokenizer="Qwen/Qwen3-14B"),
    dict(id="Qwen/Qwen3-8B-GGUF", name="Qwen3 8B", engine="thengine", family="qwen3",
         paramsB=8.2, quant="Q4_K_M", file="Qwen3-8B-Q4_K_M.gguf", contextK=32768,
         caps=["tools"], minRAMGB=8, recommendedRAMGB=16, license="apache-2.0",
         tokenizer="Qwen/Qwen3-8B"),
    dict(id="Qwen/Qwen3-4B-GGUF", name="Qwen3 4B", engine="thengine", family="qwen3",
         paramsB=4.0, quant="Q4_K_M", file="Qwen3-4B-Q4_K_M.gguf", contextK=32768,
         caps=["tools"], minRAMGB=6, recommendedRAMGB=12, license="apache-2.0",
         tokenizer="Qwen/Qwen3-4B"),
    dict(id="bartowski/Qwen2.5-32B-Instruct-GGUF", name="Qwen2.5 32B", engine="thengine", family="qwen2",
         paramsB=32.8, quant="Q4_K_M", file="Qwen2.5-32B-Instruct-Q4_K_M.gguf", contextK=32768,
         caps=["tools"], minRAMGB=24, recommendedRAMGB=48, license="apache-2.0",
         tokenizer="Qwen/Qwen2.5-32B-Instruct"),
    dict(id="unsloth/Llama-3.3-70B-Instruct-GGUF", name="Llama 3.3 70B", engine="thengine", family="llama",
         paramsB=70.6, quant="Q4_K_M", file="Llama-3.3-70B-Instruct-Q4_K_M.gguf", contextK=32768,
         caps=["tools"], minRAMGB=48, recommendedRAMGB=96, license="llama3.3",
         tokenizer="unsloth/Llama-3.3-70B-Instruct"),
    dict(id="incoai/Qwen3.8-27B-Splash", name="Qwen3.8 27B (Splash)", engine="splash", family="qwen3",
         paramsB=27.0, quant="Splash", file=None, contextK=32768,
         caps=["tools", "vision"], minRAMGB=24, recommendedRAMGB=48, license="apache-2.0",
         tokenizer=None),
    dict(id="incoai/Qwen3.6-35B-A3B-Splash", name="Qwen3.6 35B-A3B (Splash)", engine="splash", family="qwen3",
         paramsB=35.0, quant="Splash", file=None, contextK=32768,
         caps=["tools"], minRAMGB=28, recommendedRAMGB=48, license="apache-2.0",
         tokenizer=None),
]


def fetch(repo: str) -> dict:
    req = urllib.request.Request(HF + repo + "?blobs=true", headers={"User-Agent": "token-horizon-catalog"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except Exception as e:
        print(f"  ! {repo}: hub unreachable ({e}) — skipped")
        return {}


def size_of(repo: str, filename: str | None) -> float | None:
    """Download size of one file, in GB — the real number from the hub."""
    doc = fetch(repo)
    if not doc:
        return None
    siblings = doc.get("siblings", [])
    if filename is None:
        # The engine downloads the whole package (Splash ships its own).
        total = sum(s.get("size") or 0 for s in siblings)
        return round(total / 1e9, 1) if total else None
    for s in siblings:
        if s.get("rfilename") == filename:
            return round((s.get("size") or 0) / 1e9, 1)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    out = []
    for m in MODELS:
        size = size_of(m["id"], m["file"])
        if size is None:
            print(f"  ! {m['id']}: no size for {m['file'] or 'package'} — skipped")
            continue
        entry = dict(m)
        entry["sizeGB"] = size
        # The engine holds the weights plus the KV cache and runtime: the
        # resident footprint runs a few GB above the download.
        entry["residentGB"] = round(size + 1.2, 1)
        out.append(entry)
        print(f"  {m['name']:<30} {size:>6.1f} GB  {m['quant']:<8} {m['id']}")

    if args.check:
        return 0
    doc = {
        "_meta": ("Models the bundled engines can serve locally, with the size each "
                  "quantisation needs on disk. Sizes are fetched from the Hugging Face "
                  "API by scripts/refresh-local-models.py; the curation is hand-kept."),
        "models": out,
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print(f"\nwrote {len(out)} models -> {os.path.relpath(OUT, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
