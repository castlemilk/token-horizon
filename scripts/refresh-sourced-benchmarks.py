#!/usr/bin/env python3
"""Refresh the SOURCED benchmark table — clients/macos/Resources/benchmarks-sourced.json.

The curated table (Resources/benchmarks.json) holds scores a person
transcribed, usually from the vendor's own announcement. This script adds
what the public evaluation boards publish, so a model's card can carry a
measured score instead of a blank:

  * SWE-bench Verified — the leaderboard's best run per model, from the
    leaderboard's own data file (github.com/SWE-bench/swe-bench.github.io).
  * LiveCodeBench v5 — pass@1 averaged over the questions released with the
    model, from the leaderboard site's data file.

Both are fetched once per run; nothing is scraped per model.

The curated table always wins: a vendor-reported score and an independent
harness run are different measurements, and the curated one is the number
the ecosystem quotes. This file only fills gaps, and every entry says which
board it came from.

Usage:
  scripts/refresh-sourced-benchmarks.py                 # fetch + write
  scripts/refresh-sourced-benchmarks.py --check         # report only
  scripts/refresh-sourced-benchmarks.py --catalog PATH  # catalog to map against
"""

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "clients/macos/Resources/benchmarks-sourced.json")
DEFAULT_CATALOG = os.path.join(ROOT, "docs/data/models.json")

SWE_RAW = ("https://api.github.com/repos/SWE-bench/swe-bench.github.io/contents/data/leaderboards.json")
LCB_RAW = ("https://api.github.com/repos/LiveCodeBench/LiveCodeBench.github.io/contents/build/v5.json")
GITHUB_RAW_ACCEPT = "application/vnd.github.raw"

# Leaderboard display names that no normalizer can reach. Key: the board's
# name, value: the catalog family it is.
ALIASES = {
    "Claude 3.5-Sonnet-20241022": "claude-3.5-sonnet",
    "Claude 3.7 Sonnet w/ Review Heavy": "claude-3.7-sonnet",
    "DeepSeek V3.2 Reasoner": "deepseek-v3.2",
    "Devstral Small (2512)": "devstral-small-2512",
    "Gemini 3 Pro Preview": "gemini-3-pro",
    "Llama 4 Maverick Instruct": "llama-4-maverick",
    "Llama 4 Scout Instruct": "llama-4-scout",
    "o1-preview": "o1",
    "Amazon.nova Premier v1:0": "nova-premier-v1",
    "Frogboss 32B 2510": "frogboss-32b-2510",
    "Frogmini 14B 2510": "frogmini-14b-2510",
    "Llama3-SWE-RL-70B": "llama3-swe-rl-70b",
    "SWE-agent-LM-32B": "swe-agent-lm-32b",
    "CodeAct v2.1 (claude-3-5-sonnet-20241022)": "claude-3.5-sonnet",
    "Qwen2.5 Coder 32B Instruct": "qwen2.5-coder-32b-instruct",
    "Qwen2.5-Coder 32B Instruct": "qwen2.5-coder-32b-instruct",
    "MCTS Refine 7B": "mcts-refine-7b",
    "Lingma SWE-GPT 72b (v0918)": "lingma-swe-gpt-72b",
    "Lingma SWE-GPT 72b (v0925)": "lingma-swe-gpt-72b",
    "Lingma SWE-GPT 7b (v0918)": "lingma-swe-gpt-7b",
    "Lingma SWE-GPT 7b (v0925)": "lingma-swe-gpt-7b",
    "SWE-Llama 7B": "swe-llama-7b",
    "SWE-Llama 13B": "swe-llama-13b",
    # LiveCodeBench rows: a dated snapshot or an effort level names the same
    # weights as the base model.
    "O1-2024-12-17 (High)": "o1",
    "O1-2024-12-17 (Med)": "o1",
    "O1-2024-12-17 (Low)": "o1",
    "O3-Mini-2025-01-31 (High)": "o3-mini",
    "O3-Mini-2025-01-31 (Med)": "o3-mini",
    "O3-Mini-2025-01-31 (Low)": "o3-mini",
    "O1-Mini-2024-09-12": "o1-mini",
    "O1-Preview-2024-09-12": "o1",
    "Claude-3.5-Sonnet-20241022": "claude-3.5-sonnet",
    "Claude-3.5-Sonnet-20240620": "claude-3.5-sonnet",
    "GPT-4-Turbo-2024-04-09": "gpt-4-turbo",
    "Gemini-Pro-1.5-002": "gemini-1.5-pro",
    "Gemini-Flash-1.5-002": "gemini-1.5-flash",
    "Gemini-Flash-2.0-Exp": "gemini-2.0-flash-exp",
    "DeepCoder-14B-Preview": "deepcoder-14b",
    "DeepSeek-R1-Lite-Preview": "deepseek-r1-lite",
    "Kimi-k1.6-IOI": "kimi-k1.6-ioi",
    "Kimi-k1.6-IOI-high": "kimi-k1.6-ioi-high",
    "QwQ-Max-Preview": "qwq-max",
    "Llama-3_1-Nemotron-Nano-8B-v1": "llama-3.1-nemotron-nano-8b-v1",
    "MetaStone-L1-7B": "metastone-l1-7b",
    "AzeroGPT-64b": "azero-gpt-64b",
    "GPT-4O-2024-05-13": "gpt-4o",
    "GPT-4O-2024-08-06": "gpt-4o",
    "GPT-4O-mini-2024-07-18": "gpt-4o-mini",
    # Agent configurations and unnamed rows are not models.
    "4x Scaled": None, "Co-PatcheR": None, "DeepSWE-Preview": None,
    "Multiple": None, "Undisclosed": None, "swe-search": None,
    "TTS(Bo8)": None, "TTS(Bo16)": None, "Qwen2.5 (7B + 72B)": None,
    "GPT-3.5": None, "Claude 2": None,
}

# Words a display name carries that the model id does not.
NOISE_WORDS = {"instruct", "chat", "preview", "latest", "high", "med", "medium", "low", "reasoning"}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"Accept": GITHUB_RAW_ACCEPT, "User-Agent": "token-horizon-catalog"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def norm(s: str) -> str:
    """Fold a display name onto the spelling a model id uses."""
    s = s.lower().strip()
    s = re.sub(r"\([^)]*\)", " ", s)
    s = s.replace("_", "-")
    s = re.sub(r"[^a-z0-9.\- ]", " ", s)
    s = re.sub(r"\s+", "-", s).strip("-")
    return s


def norm_tokens(s: str) -> str:
    """A looser key: brand and filler words dropped, separators gone."""
    toks = [t for t in re.split(r"[^a-z0-9]+", s.lower()) if t]
    toks = [t for t in toks if t not in NOISE_WORDS]
    return "".join(toks)


def load_catalog(path: str) -> dict:
    """family -> display name, from the app's own published catalog."""
    out = {}
    with open(path) as f:
        doc = json.load(f)
    for m in doc.get("models", []):
        family = m.get("id", "").split("/", 1)[-1]
        if family:
            out.setdefault(family, m.get("name") or family)
    return out


def build_index(families: dict) -> dict:
    index = {}
    for fam, name in families.items():
        for key in {fam.lower(), norm(fam), norm(name), norm_tokens(fam), norm_tokens(name)}:
            if key and key not in index:
                index[key] = fam
    return index


def swe_scores() -> dict:
    """model display name -> (percent, date, agent) for SWE-bench Verified."""
    doc = json.loads(fetch(SWE_RAW))
    board = next((b for b in doc.get("leaderboards", []) if b.get("name") == "Verified"), None)
    if not board:
        return {}
    best = {}
    for r in board.get("results", []):
        pct = r.get("resolved")
        name = (r.get("model_display") or "").strip()
        if pct is None or not name:
            continue
        if name not in best or pct > best[name][0]:
            best[name] = (float(pct), r.get("date"), r.get("agent") or "")
    return best


def lcb_scores() -> dict:
    """model display name -> (percent, release date) for LiveCodeBench v5."""
    doc = json.loads(fetch(LCB_RAW))
    models = {m.get("model_repr"): m for m in doc.get("models", []) if m.get("model_repr")}
    graded = {}
    for p in doc.get("performances", []):
        name = p.get("model")
        score = p.get("pass@1")
        if name is None or score is None:
            continue
        graded.setdefault(name, []).append((p.get("date") or 0, float(score)))
    out = {}
    for name, rows in graded.items():
        meta = models.get(name) or {}
        cutoff = meta.get("release_date") or 0
        # The board's headline number averages the questions released with the
        # model, so later questions (which it may have seen) do not count.
        window = [s for d, s in rows if not cutoff or d <= cutoff]
        if len(window) < 20:
            window = [s for _, s in rows]
        if len(window) < 20:
            continue
        out[name] = (round(statistics.mean(window), 1), meta.get("release_date"))
    return out


def resolve(name: str, index: dict) -> str | None:
    if name in ALIASES:
        return ALIASES[name]
    for key in (norm(name), norm_tokens(name)):
        if key in index:
            return index[key]
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report only, do not write")
    ap.add_argument("--catalog", default=DEFAULT_CATALOG)
    args = ap.parse_args()

    families = load_catalog(args.catalog)
    index = build_index(families)
    print(f"catalog families: {len(families)}")

    entries = []
    unmatched = []

    swe = swe_scores()
    print(f"SWE-bench Verified: {len(swe)} models on the board")
    for name, (pct, date, agent) in sorted(swe.items(), key=lambda x: -x[1][0]):
        fam = resolve(name, index)
        if not fam:
            unmatched.append(("swe", name))
            continue
        src = "SWE-bench Verified"
        if date:
            src += f" ({date})"
        entries.append({"match": fam, "name": families.get(fam, name), "swe": pct, "source": src, "approx": False})

    lcb = lcb_scores()
    print(f"LiveCodeBench v5: {len(lcb)} models on the board")
    lcb_by_family = {}
    for name, (pct, _date) in sorted(lcb.items(), key=lambda x: -x[1][0]):
        fam = resolve(name, index)
        if not fam:
            unmatched.append(("lcb", name))
            continue
        lcb_by_family[fam] = pct

    # Attach the LiveCodeBench number to the entry that already exists, or
    # create one — a model can have a SWE score, an LCB score, or both.
    by_match = {e["match"]: e for e in entries}
    for fam, pct in lcb_by_family.items():
        if fam in by_match:
            by_match[fam]["lcb"] = pct
        else:
            entries.append({"match": fam, "name": families.get(fam, fam), "lcb": pct,
                            "source": "LiveCodeBench v5", "approx": False})
    entries.sort(key=lambda e: e["match"])

    print(f"\nresolved {len(entries)} models")
    if unmatched:
        print(f"unmapped board rows ({len(unmatched)}) — not models, or need an alias:")
        for src, name in unmatched:
            print(f"  {src:<5} {name}")

    if args.check:
        return 0
    doc = {
        "_meta": ("Sourced benchmark scores, generated by scripts/refresh-sourced-benchmarks.py. "
                  "SWE-bench Verified (leaderboard's best run per model) and LiveCodeBench v5 "
                  "(pass@1 over the questions released with the model). The curated table "
                  "(benchmarks.json) wins where it has an entry."),
        "entries": entries,
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print(f"\nwrote {len(entries)} entries -> {os.path.relpath(OUT, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
