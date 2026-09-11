#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Token Horizon Full-Stack Launcher ==="

# 1. Check Native Token Horizon Core (:8765)
if curl -s http://127.0.0.1:8765/health >/dev/null 2>&1; then
    echo "[✓] Token Horizon native service is running on http://127.0.0.1:8765"
else
    echo "[!] Starting Token Horizon native app..."
    if [ -d "$DIR/TokenHorizon.app" ]; then
        "$DIR/scripts/make-app.sh"
    else
        echo "[*] Building and launching TokenHorizon.app..."
        "$DIR/scripts/make-app.sh"
    fi
fi

# 2. Check Micro Agent Workflow Engine Daemon (:8766)
if curl -s http://127.0.0.1:8766/api/health >/dev/null 2>&1; then
    echo "[✓] Workflow Engine daemon is running on http://127.0.0.1:8766"
else
    echo "[*] Starting Token Horizon Workflow Engine daemon in background..."
    mkdir -p "$HOME/Library/Logs"
    (cd "$DIR/engine" && RUN_SERVER=true nohup npm start > "$HOME/Library/Logs/token-horizon-engine.log" 2>&1 &)
    sleep 2
    if curl -s http://127.0.0.1:8766/api/health >/dev/null 2>&1; then
        echo "[✓] Workflow Engine daemon launched successfully on :8766"
    else
        echo "[!] Warning: Workflow Engine daemon starting up..."
    fi
fi

# 3. Launch Electron React UI
echo "[*] Launching Token Horizon Cross-Platform UI..."
cd "$DIR/ui"
if [ "${1:-}" = "--dev" ]; then
    npm run dev
else
    if [ ! -d "out/renderer" ]; then
        echo "[*] Building UI assets..."
        npm run vite:build:app
    fi
    npx electron .
fi
