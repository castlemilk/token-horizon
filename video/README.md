# Token Horizon product film (Remotion)

Code-rendered 40-second product spot — no screen recordings, no stock, no
webfonts. Everything is drawn with divs + system fonts so renders are fast
and hermetic on CI.

## Scenes (40s @30fps, 1920×1080)

| Time | Scene | Beat |
|---|---|---|
| 0–4s | Hook | black-hole mark + tagline |
| 4–10s | Chaos → one view | scattered provider counters converge to 1.84M |
| 10–18s | Notch | panel expands, counter ticks, provider split bars |
| 18–26s | Plan limits | quota bars fill, Fable 90% highlighted |
| 26–33s | Local/private | 127.0.0.1 + live MLX tok/s gauge |
| 33–40s | CTA | install command types out, landing URL |

## Render

```bash
npm ci
npm run render          # 1080p mp4 → ../dist/TokenHorizon-film.mp4 (release asset)
npm run render:preview  # 960×540 fast draft for iteration
npx remotion still TokenHorizonFilm --frame=640 -o still-notch.png
```

## Optimization notes

- **Zero assets**: no images/video/fonts to fetch — CI renders offline after `npm ci`.
- **JPEG frame format** at quality 85 (`remotion.config.ts`) — flat brand colors
  compress near-losslessly and encode ~3× faster than PNG frames.
- **Module-level tables** (`CHAOS`, `SPLIT`, `LIMITS`): no per-frame allocation;
  scene components only run O(1) `interpolate` math per frame.
- **No layout thrash**: animated values drive `transform`/`opacity`/`width`
  (compositor-friendly); nothing reads layout mid-frame.
- Release CI (`release.yml`) renders the film best-effort and attaches
  `TokenHorizon-film.mp4`, which the GitHub Pages site embeds.
