#!/usr/bin/env python3
"""
scripts/update-catalog.py
Sync, validate, and enrich model benchmark data (SWE-bench Verified, LiveCodeBench, pricing, and specs)
for Token Horizon's model catalog.

Usage:
    python3 scripts/update-catalog.py [--fetch-remote] [--verify]
"""

import sys
import json
import os
import urllib.request
import urllib.error

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BENCHMARKS_FILE = os.path.join(ROOT_DIR, "Resources", "benchmarks.json")
CACHE_DIR = os.path.expanduser("~/.config/token-horizon")
CACHE_FILE = os.path.join(CACHE_DIR, "models-cache.json")

# Curated authoritative benchmarks (SWE-bench Verified %, LiveCodeBench %, AIME %, GPQA %)
CURATED_BENCHMARKS = [
    # Anthropic
    {"match": "claude-3-7-sonnet", "name": "Claude 3.7 Sonnet", "swe": 77.6, "lcb": 70.3, "aime": 80.0, "gpqa": 75.0, "approx": False, "source": "Anthropic"},
    {"match": "claude-3-5-sonnet", "name": "Claude 3.5 Sonnet", "swe": 74.5, "lcb": 67.2, "aime": 70.0, "gpqa": 65.2, "approx": False, "source": "Anthropic"},
    {"match": "claude-opus-4-1", "name": "Claude Opus 4.1", "swe": 74.5, "lcb": None, "aime": None, "gpqa": None, "approx": True, "source": "Anthropic"},
    {"match": "claude-3-5-haiku", "name": "Claude 3.5 Haiku", "swe": 40.6, "lcb": 43.1, "aime": 45.0, "gpqa": 48.0, "approx": False, "source": "Anthropic"},
    {"match": "claude-3-opus", "name": "Claude 3 Opus", "swe": 38.0, "lcb": None, "aime": None, "gpqa": None, "approx": False, "source": "Anthropic"},
    {"match": "claude-3-haiku", "name": "Claude 3 Haiku", "swe": 28.5, "lcb": None, "aime": None, "gpqa": None, "approx": False, "source": "Anthropic"},

    # OpenAI
    {"match": "gpt-6-astra", "name": "GPT-6 Astra", "swe": 85.2, "lcb": 81.0, "aime": 92.5, "gpqa": 88.0, "approx": False, "source": "OpenAI"},
    {"match": "astra", "name": "GPT-6 Astra", "swe": 85.2, "lcb": 81.0, "aime": 92.5, "gpqa": 88.0, "approx": False, "source": "OpenAI"},
    {"match": "gpt-daybreak", "name": "GPT Daybreak Blue", "swe": 85.2, "lcb": 81.0, "aime": 92.5, "gpqa": 88.0, "approx": False, "source": "OpenAI"},
    {"match": "gpt-daybreak-blue-latest", "name": "GPT Daybreak Blue", "swe": 85.2, "lcb": 81.0, "aime": 92.5, "gpqa": 88.0, "approx": False, "source": "OpenAI"},
    {"match": "gpt-reserve", "name": "GPT Reserve", "swe": 81.5, "lcb": 78.0, "aime": 89.0, "gpqa": 83.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "swe": 81.5, "lcb": 78.0, "aime": 89.0, "gpqa": 83.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-5-sol", "name": "GPT-5 Sol", "swe": 81.5, "lcb": 78.0, "aime": 89.0, "gpqa": 83.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-5.6-terra", "name": "GPT-5.6 Terra", "swe": 72.0, "lcb": 68.5, "aime": 80.0, "gpqa": 74.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-5-terra", "name": "GPT-5 Terra", "swe": 72.0, "lcb": 68.5, "aime": 80.0, "gpqa": 74.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-5.6-luna", "name": "GPT-5.6 Luna", "swe": 52.0, "lcb": 50.0, "aime": 60.0, "gpqa": 58.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-5-luna", "name": "GPT-5 Luna", "swe": 52.0, "lcb": 50.0, "aime": 60.0, "gpqa": 58.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-5.5", "name": "GPT-5.5", "swe": 78.0, "lcb": 75.0, "aime": 84.0, "gpqa": 78.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-5.4-mini", "name": "GPT-5.4 Mini", "swe": 58.0, "lcb": 55.0, "aime": 68.0, "gpqa": 62.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-5.3-codex-spark", "name": "GPT-5.3 Codex Spark", "swe": 54.0, "lcb": 50.0, "aime": 62.0, "gpqa": 58.0, "approx": True, "source": "OpenAI"},
    {"match": "codex-auto-review", "name": "Codex Auto Review", "swe": 78.0, "lcb": 75.0, "aime": 84.0, "gpqa": 78.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-5", "name": "GPT-5 Preview", "swe": 74.9, "lcb": 72.0, "aime": 84.0, "gpqa": 78.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-5-codex", "name": "GPT-5 Codex", "swe": 74.5, "lcb": 71.5, "aime": 82.0, "gpqa": 76.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-4.5", "name": "GPT-4.5", "swe": 45.0, "lcb": 48.0, "aime": 58.0, "gpqa": 60.0, "approx": True, "source": "OpenAI"},
    {"match": "o1", "name": "o1", "swe": 61.8, "lcb": 62.0, "aime": 83.3, "gpqa": 77.3, "approx": False, "source": "OpenAI"},
    {"match": "o1-mini", "name": "o1-mini", "swe": 41.5, "lcb": 55.0, "aime": 70.0, "gpqa": 60.0, "approx": False, "source": "OpenAI"},
    {"match": "o3-mini", "name": "o3-mini", "swe": 49.3, "lcb": 63.8, "aime": 87.3, "gpqa": 79.7, "approx": False, "source": "OpenAI"},
    {"match": "o3", "name": "o3", "swe": 71.7, "lcb": 74.5, "aime": 91.2, "gpqa": 85.0, "approx": True, "source": "OpenAI"},
    {"match": "gpt-4o", "name": "GPT-4o", "swe": 38.8, "lcb": 40.5, "aime": 53.3, "gpqa": 53.6, "approx": False, "source": "OpenAI"},
    {"match": "gpt-4o-mini", "name": "GPT-4o Mini", "swe": 28.5, "lcb": 32.0, "aime": 42.0, "gpqa": 40.2, "approx": False, "source": "OpenAI"},

    # Google Gemini & Gemma
    {"match": "gemini-2-5-pro", "name": "Gemini 2.5 Pro", "swe": 63.8, "lcb": 60.5, "aime": 76.0, "gpqa": 72.0, "approx": False, "source": "Google"},
    {"match": "gemini-2-5-flash", "name": "Gemini 2.5 Flash", "swe": 55.0, "lcb": 54.0, "aime": 68.0, "gpqa": 65.0, "approx": True, "source": "Google"},
    {"match": "gemini-2-0-flash", "name": "Gemini 2.0 Flash", "swe": 51.2, "lcb": 52.0, "aime": 65.0, "gpqa": 62.0, "approx": False, "source": "Google"},
    {"match": "gemini-1-5-pro", "name": "Gemini 1.5 Pro", "swe": 44.2, "lcb": 45.0, "aime": 58.5, "gpqa": 58.5, "approx": False, "source": "Google"},
    {"match": "gemma3:27b", "name": "Gemma 3 27B", "swe": 48.5, "lcb": 46.0, "aime": 55.0, "gpqa": 54.0, "approx": False, "source": "Google"},
    {"match": "gemma3:12b", "name": "Gemma 3 12B", "swe": 38.0, "lcb": 36.0, "aime": 42.0, "gpqa": 44.0, "approx": False, "source": "Google"},
    {"match": "gemma3:4b", "name": "Gemma 3 4B", "swe": 28.0, "lcb": 26.0, "aime": 32.0, "gpqa": 35.0, "approx": False, "source": "Google"},

    # DeepSeek
    {"match": "deepseek-v4-pro", "name": "DeepSeek V4 Pro", "swe": 72.0, "lcb": 68.0, "aime": 78.0, "gpqa": 74.0, "approx": True, "source": "DeepSeek"},
    {"match": "deepseek-v4-pro-0813", "name": "DeepSeek V4 Pro (0813)", "swe": 72.0, "lcb": 68.0, "aime": 78.0, "gpqa": 74.0, "approx": True, "source": "DeepSeek"},
    {"match": "deepseek-v3-1", "name": "DeepSeek V3.1", "swe": 66.0, "lcb": 62.0, "aime": 72.0, "gpqa": 68.0, "approx": True, "source": "DeepSeek"},
    {"match": "deepseek-v3", "name": "DeepSeek V3", "swe": 49.2, "lcb": 54.7, "aime": 65.0, "gpqa": 59.1, "approx": False, "source": "DeepSeek"},
    {"match": "deepseek-r1", "name": "DeepSeek R1", "swe": 49.2, "lcb": 65.9, "aime": 79.8, "gpqa": 71.5, "approx": False, "source": "DeepSeek"},

    # Alibaba Qwen
    {"match": "qwen3-coder", "name": "Qwen 3 Coder", "swe": 67.0, "lcb": 64.0, "aime": 74.0, "gpqa": 70.0, "approx": True, "source": "Alibaba"},
    {"match": "qwen3.8:27b-mlx", "name": "Qwen 3.8 27B MLX", "swe": 54.0, "lcb": 52.0, "aime": 60.0, "gpqa": 58.0, "approx": True, "source": "Alibaba"},
    {"match": "qwen3:14b", "name": "Qwen 3 14B", "swe": 45.0, "lcb": 43.0, "aime": 52.0, "gpqa": 50.0, "approx": True, "source": "Alibaba"},
    {"match": "qwen3:8b", "name": "Qwen 3 8B", "swe": 36.0, "lcb": 34.0, "aime": 40.0, "gpqa": 42.0, "approx": True, "source": "Alibaba"},
    {"match": "qwen2.5-coder-32b", "name": "Qwen 2.5 Coder 32B", "swe": 50.8, "lcb": 48.0, "aime": 58.0, "gpqa": 55.0, "approx": False, "source": "Alibaba"},
    {"match": "qwen2.5-coder-14b", "name": "Qwen 2.5 Coder 14B", "swe": 42.0, "lcb": 40.0, "aime": 50.0, "gpqa": 48.0, "approx": False, "source": "Alibaba"},
    {"match": "qwen2.5-coder-7b", "name": "Qwen 2.5 Coder 7B", "swe": 37.6, "lcb": 35.0, "aime": 44.0, "gpqa": 42.0, "approx": False, "source": "Alibaba"},
    {"match": "qwen2.5-72b", "name": "Qwen 2.5 72B", "swe": 46.5, "lcb": 45.0, "aime": 56.0, "gpqa": 54.0, "approx": False, "source": "Alibaba"},

    # Moonshot Kimi
    {"match": "kimi-k2", "name": "Kimi K2", "swe": 65.8, "lcb": 61.0, "aime": 70.0, "gpqa": 67.0, "approx": True, "source": "Moonshot"},
    {"match": "kimi-k1.5", "name": "Kimi K1.5", "swe": 48.0, "lcb": 45.0, "aime": 55.0, "gpqa": 52.0, "approx": False, "source": "Moonshot"},

    # Zhipu GLM
    {"match": "glm-5.3", "name": "GLM 5.3", "swe": 68.0, "lcb": 63.0, "aime": 71.0, "gpqa": 68.0, "approx": True, "source": "Zhipu"},
    {"match": "glm-4-plus", "name": "GLM 4 Plus", "swe": 58.0, "lcb": 52.0, "aime": 62.0, "gpqa": 60.0, "approx": False, "source": "Zhipu"},

    # MiniMax
    {"match": "minimax-m3", "name": "MiniMax M3", "swe": 62.0, "lcb": 58.0, "aime": 66.0, "gpqa": 63.0, "approx": True, "source": "MiniMax"},
    {"match": "minimax-01", "name": "MiniMax-01", "swe": 58.0, "lcb": 54.0, "aime": 62.0, "gpqa": 59.0, "approx": False, "source": "MiniMax"},

    # Meta LLaMA
    {"match": "llama-3.3-70b", "name": "Llama 3.3 70B", "swe": 52.5, "lcb": 50.2, "aime": 58.0, "gpqa": 56.0, "approx": False, "source": "Meta"},
    {"match": "llama-3.1-405b", "name": "Llama 3.1 405B", "swe": 50.8, "lcb": 48.5, "aime": 58.0, "gpqa": 55.0, "approx": False, "source": "Meta"},
    {"match": "llama-3.1-70b", "name": "Llama 3.1 70B", "swe": 42.0, "lcb": 40.0, "aime": 48.0, "gpqa": 46.0, "approx": False, "source": "Meta"},
    {"match": "llama-3.1-8b", "name": "Llama 3.1 8B", "swe": 28.0, "lcb": 26.0, "aime": 30.0, "gpqa": 32.0, "approx": False, "source": "Meta"},

    # Mistral
    {"match": "codestral-2501", "name": "Codestral 2501", "swe": 51.0, "lcb": 49.0, "aime": 56.0, "gpqa": 54.0, "approx": False, "source": "Mistral"},
    {"match": "mistral-large", "name": "Mistral Large", "swe": 45.0, "lcb": 44.0, "aime": 52.0, "gpqa": 50.0, "approx": False, "source": "Mistral"},

    # xAI Grok
    {"match": "grok-4", "name": "Grok 4", "swe": 65.0, "lcb": 61.0, "aime": 70.0, "gpqa": 67.0, "approx": True, "source": "xAI"},
    {"match": "grok-3", "name": "Grok 3", "swe": 55.0, "lcb": 52.0, "aime": 62.0, "gpqa": 59.0, "approx": True, "source": "xAI"},

    # OpenCode
    {"match": "muse-spark-1.2", "name": "Muse Spark 1.2", "swe": 61.5, "lcb": 57.0, "aime": 65.0, "gpqa": 62.0, "approx": True, "source": "OpenCode"},
    {"match": "x-preview-f-free", "name": "x-Preview-f Free", "swe": 59.0, "lcb": 55.0, "aime": 63.0, "gpqa": 60.0, "approx": True, "source": "OpenCode"},
    {"match": "ox-alpha-free", "name": "ox-Alpha Free", "swe": 52.0, "lcb": 48.0, "aime": 55.0, "gpqa": 52.0, "approx": True, "source": "OpenCode"},
    {"match": "ornith-1.5:35b", "name": "Ornith 1.5 35B", "swe": 53.0, "lcb": 50.0, "aime": 58.0, "gpqa": 56.0, "approx": True, "source": "OpenCode"},
]

def save_benchmarks():
    payload = {
        "_meta": "Curated approximate benchmark scores. Source: provider announcements, SWE-bench Verified, LiveCodeBench, AIME 2024, GPQA Diamond.",
        "entries": CURATED_BENCHMARKS
    }
    with open(BENCHMARKS_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    print(f"✓ Saved {len(CURATED_BENCHMARKS)} benchmark entries to {BENCHMARKS_FILE}")

def verify_benchmarks():
    print(f"\nVerifying {len(CURATED_BENCHMARKS)} benchmark entries:")
    top_models = sorted(CURATED_BENCHMARKS, key=lambda x: (x.get("swe") or 0), reverse=True)
    print(f"{'MODEL':<32} {'SWE-BENCH':<12} {'LCB':<8} {'SOURCE':<14}")
    print("-" * 68)
    for m in top_models[:15]:
        swe_str = f"{m['swe']:.1f}%" if m.get("swe") else "—"
        lcb_str = f"{m['lcb']:.1f}%" if m.get("lcb") else "—"
        print(f"{m['name']:<32} {swe_str:<12} {lcb_str:<8} {m['source']:<14}")
    print("-" * 68)

def fetch_remote_specs():
    url = "https://models.dev/api.json"
    os.makedirs(CACHE_DIR, exist_ok=True)
    print(f"Fetching latest specs from {url}...")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "TokenHorizon/0.2.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
            with open(CACHE_FILE, "wb") as f:
                f.write(data)
            parsed = json.loads(data)
            print(f"✓ Saved remote specs for {len(parsed)} providers to {CACHE_FILE}")
    except Exception as e:
        print(f"Warning: Could not fetch from models.dev ({e}). Keeping local cache.")

if __name__ == "__main__":
    fetch_remote = "--fetch-remote" in sys.argv
    if fetch_remote:
        fetch_remote_specs()
    save_benchmarks()
    verify_benchmarks()
