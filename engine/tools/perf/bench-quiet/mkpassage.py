#!/usr/bin/env python3
"""mkpassage.py OUT — fixed long-context passage: tag-stripped prose of the two
blog posts at commit cf3e5f7 (why-token-horizon + pricing-evidence), cut at a
sentence boundary near TARGET tokens (Qwen3.8 tokenizer.json via `tokenizers`)."""
import html, os, re, subprocess, sys
REPO = "/Users/benebsworth/projects/token-horizon"
TGT = os.path.expanduser("~/.cache/huggingface/hub/models--mlx-community--Qwen3.8-27B-4bit/snapshots/10c35caafbb80f7dc6a7a432cdd11af10a6d4818")
TARGET = int(os.environ.get("TARGET", "1400"))
def prose(path):
    t = subprocess.run(["git", "-C", REPO, "show", f"cf3e5f7:{path}"], capture_output=True, text=True, check=True).stdout
    t = re.sub(r"(?s)<(script|style|nav|header|footer|svg)[^>]*>.*?</\1>", " ", t)
    t = re.sub(r"(?s)<(p|h1|h2|h3|li|div|br|section|article)[^>]*>", "\n", t)
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    t = html.unescape(t)
    t = re.sub(r"[ \t\r\f\v]+", " ", t)
    t = re.sub(r" *\n[ \n]*", "\n", t).strip()
    return t
parts = [prose("docs/blog/why-token-horizon.html"), prose("docs/blog/pricing-evidence.html")]
text = "\n\n".join(parts)
from tokenizers import Tokenizer
tok = Tokenizer.from_file(os.path.join(TGT, "tokenizer.json"))
n_all = len(tok.encode(text, add_special_tokens=False).ids)
# cut at the last sentence end whose prefix is <= TARGET tokens
best = None
for m in re.finditer(r"[.!?](?=\s)", text):
    cand = text[:m.end()]
    n = len(tok.encode(cand, add_special_tokens=False).ids)
    if n <= TARGET:
        best = (cand, n)
    else:
        break
cand, n = best
open(sys.argv[1], "w").write(cand)
print(f"source tokens {n_all}, passage {len(cand)} chars, {n} tokens")
