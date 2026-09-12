# token-horizon-ui

Cross-platform desktop UI for Token Horizon: a SvelteKit static SPA (TypeScript,
runes mode, no Tailwind) packaged by a Tauri v2 shell. It is a thin client of the
Token Horizon loopback API (`http://127.0.0.1:8765`) served by the macOS app or
the `token-horizon-headless` daemon.

```bash
npm install          # reconcile node_modules with this manifest
npm run dev          # SvelteKit dev server on :5173
npm run tauri dev    # desktop shell (macOS / Windows / Linux)
npm run build        # static bundle in build/ (consumed by Tauri frontendDist)
npm run check        # svelte-check
```

The API base can be overridden from the browser console:
`localStorage.setItem('token-horizon.api', 'http://192.168.1.10:8765')`.

Building on a Linux box without sudo (rootless Swift toolchain, webkit dev
sysroot, rust-lld flags) is documented in
[`../docs/tauri-desktop-build.md`](../docs/tauri-desktop-build.md); the reusable
environment lives in `~/toolchains/env.sh`.

## Design language

Hairline style shared across macOS / Windows / Linux: system UI font stack,
1px `--line` borders, 6px radius, no shadows, numbers in tabular figures.
Light/dark follows the OS and can be overridden from the top bar
(`data-theme` on `<html>`, persisted in `localStorage`). The chrome accent is
deliberately neutral graphite — color comes from data (provider/runtime
accents, state dots), not the frame. All tokens live in `src/app.css`.
