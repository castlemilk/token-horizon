#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$DIR/clients/crossplatform"

echo "=== Token Horizon Cross-Platform App (dev) ==="

# Deps must exist and match package.json before vite can boot.
if [ ! -d "$APP/node_modules" ] || [ "package.json" -nt "$APP/node_modules/.package-lock.json" ]; then
    echo "[*] Installing clients/crossplatform dependencies..."
    (cd "$APP" && npm install)
fi

# Warn (don't block) when the daemon isn't up — the UI renders offline states.
if curl -s http://127.0.0.1:8765/health >/dev/null 2>&1; then
    echo "[✓] Token Horizon daemon on :8765"
else
    echo "[!] daemon not detected on :8765 — run scripts/start-all.sh for the full stack"
fi

# electron's postinstall ships the binary; npm --ignore-scripts leaves it missing.
if [ "${1:-}" = "--electron" ] && [ ! -e "$APP/node_modules/electron/dist/electron" ] && [ ! -d "$APP/node_modules/electron/dist/Electron.app" ]; then
    echo "[*] Fetching Electron binary..."
    (cd "$APP" && node node_modules/electron/install.js)
fi

cd "$APP"
if [ "${1:-}" = "--electron" ]; then
    echo "[*] Starting Electron dev (Vite + window)..."
    exec npm run dev:electron
else
    echo "[*] Starting Vite dev server (browser)..."
    exec npm run dev
fi
