# Token Horizon UI

Cross-platform desktop UI for Token Horizon — SvelteKit (TypeScript, SPA) in a
Tauri shell. It is a thin client of the Token Horizon loopback API
(`CoreAPIRouter`, `http://127.0.0.1:8765`): the headless daemon
(`token-horizon-headless`) or the macOS app serves it.

## Develop

```bash
# terminal 1: the API (repo root)
swift run token-horizon-headless

# terminal 2: hot-reload frontend
npm install
npm run dev

# terminal 3 (optional): native window against the hot-reload server
npm run tauri dev
```

## Build

```bash
npm run build        # static SPA bundle → build/
npm run tauri build  # native app (Linux .deb/AppImage, Windows .msi, macOS .app)
```

Linux prerequisites for the Tauri shell: `webkit2gtk-4.1` dev packages
(`sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev`).
If you can't use sudo, extract the debs locally and point `PKG_CONFIG_PATH` +
`RUSTFLAGS="-L …"` at them (see git history for commit "SvelteKit + Tauri UI").

## Configuration

The UI talks to `http://127.0.0.1:8765` by default. Point it at another daemon
(e.g. a GPU box running `token-horizon-headless`) from the browser console:

```js
localStorage.setItem('token-horizon.api', 'http://gpu-box:8765')
```

(Remote hosts need the daemon bound to a reachable interface — loopback is
the default; expose deliberately.)

## Tabs

- **OVERVIEW** — tokens/cost today + all-time, today's token breakdown, local CPU/RAM
- **PROVIDERS** — live runtimes (measured tok/s, loaded models, local cpu/mem
  when detected) + metered provider→model rollups
- **REQUESTS** — per-request table: vendor, model, product, tokens, measured
  gen tok/s, thinking level; vendor filter chips + cursor pagination
- **TRENDS** — 15-min/1h/day bucket bar charts (1D/1W/1M/3M/1Y)
- **LIMITS** — plan quota gauges per provider
