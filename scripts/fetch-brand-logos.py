#!/usr/bin/env python3
"""Fetches official provider logo marks for the dashboard and normalizes them
to white-on-transparent assets under docs/assets/brands/.

Sources:
  - Simple Icons (CC0) for accurate monochrome brand marks.
  - BrandBrain's fetched assets (https://api.brandbrain.dev) for brands Simple
    Icons dropped or lacks (OpenAI mark, Moonshot/Kimi raster).

Brands without a public vector mark (Zhipu/GLM) keep the hand-drawn glyph in
docs/leaderboard.html as the runtime fallback.
"""
import os
import re
import urllib.request

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "docs", "assets", "brands")

SIMPLE_ICONS = {
    "anthropic": "anthropic",
    "google": "googlegemini",
    "meta": "meta",
    "deepseek": "deepseek",
    "mistral": "mistralai",
    "xai": "x",
    "minimax": "minimax",
    "opencode": "opencode",
    "qwen": "qwen",
    "ollama": "ollama",
}
# Simple Icons dropped OpenAI; the last shipped mark still lives on the CDN.
OPENAI_URL = "https://cdn.jsdelivr.net/npm/simple-icons@12/icons/openai.svg"
MOONSHOT_URL = "https://api.brandbrain.dev/api/v1/discover/logo-assets/moonshot/primary"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "token-horizon-brand-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def white_svg(source: bytes) -> bytes:
    text = source.decode("utf-8", "ignore")
    text = re.sub(r"<title>.*?</title>", "", text, flags=re.S)
    text = re.sub(r'\s(fill|role|class)="[^"]*"', "", text)
    # Force a single white fill on the root so the mark reads on dark tiles.
    text = text.replace("<svg ", '<svg fill="#FFFFFF" ', 1)
    if "<svg fill=\"#FFFFFF\"" not in text:
        text = text.replace("<svg", '<svg fill="#FFFFFF"', 1)
    return text.encode("utf-8")


def white_png(source: bytes) -> bytes:
    """Key a raster mark: black/white art → white-on-transparent."""
    import io

    img = Image.open(io.BytesIO(source)).convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            luma = (r * 299 + g * 587 + b * 114) // 1000
            if luma > 240:
                px[x, y] = (r, g, b, 0)          # white background → transparent
            else:
                alpha = 255 - luma                # dark strokes → white, soft edges
                px[x, y] = (255, 255, 255, min(a, max(0, alpha)))
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for key, slug in SIMPLE_ICONS.items():
        svg = white_svg(fetch(f"https://cdn.simpleicons.org/{slug}"))
        path = os.path.join(OUT_DIR, f"{key}.svg")
        with open(path, "wb") as fh:
            fh.write(svg)
        print(f"✓ {key}.svg ({len(svg)} bytes)")

    svg = white_svg(fetch(OPENAI_URL))
    with open(os.path.join(OUT_DIR, "openai.svg"), "wb") as fh:
        fh.write(svg)
    print(f"✓ openai.svg ({len(svg)} bytes)")

    png = white_png(fetch(MOONSHOT_URL))
    with open(os.path.join(OUT_DIR, "kimi.png"), "wb") as fh:
        fh.write(png)
    print(f"✓ kimi.png ({len(png)} bytes)")


if __name__ == "__main__":
    main()
