#!/usr/bin/env python3
"""Processes the generated league badge PNGs into transparent, cropped,
resized assets for the dashboard.

Usage:
    python3 scripts/process-league-badges.py <bronze.png> <silver.png> ...

The generated art ships on a flat white background; this keys out the
background via a border flood fill (preserving interior whites/highlights),
drops stray marks (watermarks) with a row/column density crop, and writes
384x384 transparent PNGs to docs/assets/leagues/.
"""
import os
import sys
from collections import deque

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "docs", "assets", "leagues")
LEAGUES = ["bronze", "silver", "gold", "platinum", "diamond", "master", "grandmaster"]
SIZE = 384
BG_MIN = 238      # min(r,g,b) at/above this counts as background white
FEATHER_MIN = 232  # edge feathering range


def key_background(img):
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    visited = bytearray(w * h)
    q = deque()

    def is_bg(x, y):
        r, g, b, _ = px[x, y]
        return min(r, g, b) >= BG_MIN

    for x in range(w):
        for y in (0, h - 1):
            if is_bg(x, y) and not visited[y * w + x]:
                visited[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_bg(x, y) and not visited[y * w + x]:
                visited[y * w + x] = 1
                q.append((x, y))

    while q:
        x, y = q.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx] and is_bg(nx, ny):
                visited[ny * w + nx] = 1
                q.append((nx, ny))

    # Zero the flood-filled background.
    for y in range(h):
        row = y * w
        for x in range(w):
            if visited[row + x]:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)

    # Feather the boundary so anti-aliased edges don't keep a white halo.
    for y in range(h):
        for x in range(w):
            if visited[y * w + x]:
                continue
            near_bg = False
            for dy in (-2, -1, 0, 1, 2):
                for dx in (-2, -1, 0, 1, 2):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and visited[ny * w + nx]:
                        near_bg = True
                        break
                if near_bg:
                    break
            if not near_bg:
                continue
            r, g, b, a = px[x, y]
            whiteness = min(r, g, b)
            if whiteness >= FEATHER_MIN:
                alpha = max(0, min(255, int((250 - whiteness) * 255 / (250 - FEATHER_MIN))))
                px[x, y] = (r, g, b, min(a, alpha))
    return img


def density_crop(img):
    """Crop to rows/columns with meaningful coverage (drops watermarks)."""
    w, h = img.size
    px = img.load()
    min_count = max(6, w // 100)
    rows = [sum(1 for x in range(w) if px[x, y][3] > 0) for y in range(h)]
    cols = [sum(1 for y in range(h) if px[x, y][3] > 0) for x in range(w)]
    ys = [i for i, c in enumerate(rows) if c >= min_count]
    xs = [i for i, c in enumerate(cols) if c >= min_count]
    if not ys or not xs:
        return img
    pad = 6
    box = (max(0, xs[0] - pad), max(0, ys[0] - pad), min(w, xs[-1] + pad), min(h, ys[-1] + pad))
    return img.crop(box)


def main():
    paths = sys.argv[1:]
    if len(paths) != len(LEAGUES):
        print(__doc__)
        sys.exit(2)
    os.makedirs(OUT_DIR, exist_ok=True)
    for league, path in zip(LEAGUES, paths):
        img = Image.open(path)
        img = key_background(img)
        img = density_crop(img)
        # Square canvas so every badge shares the same optical size.
        side = max(img.size)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
        canvas = canvas.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
        out = os.path.join(OUT_DIR, f"{league}.png")
        canvas.save(out, "PNG", optimize=True)
        print(f"✓ {league}: {out} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
