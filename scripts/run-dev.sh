#!/usr/bin/env bash
# run-dev.sh — cross-platform Token Horizon dev stack: loopback API backend
# plus the SvelteKit/Tauri UI. One command, Ctrl-C shuts down everything
# this script started.
#
# Platform behavior:
#   macOS    backend = TokenHorizon app (debug build, tracked child process)
#   Linux    backend = token-horizon-headless daemon
#   Windows  backend = none (headless target is #if !os(Windows)); UI-only,
#            point the UI at a remote daemon: TH_API=http://host:8765
#   (WSL counts as Linux and runs the daemon normally.)
#
# Overrides:
#   TH_BACKEND=app|daemon|none     backend choice (default: per platform)
#   TH_FRONTEND=tauri|vite|none    UI shell (default: tauri, falls back to
#                                  vite in the browser when cargo/webkit
#                                  deps are missing or tauri dies at boot)
#   TH_API=http://127.0.0.1:8765   API the UI talks to (localStorage override)
#
# Restart: if the API is already healthy on :8765 the existing backend is
# stopped first, then a fresh tracked backend is started; likewise any stale
# vite dev server (:5173) or Tauri shell from a previous run is killed before
# the frontend starts. Ctrl-C still only shuts down what this script
# launched. Set TH_REUSE=1 to keep a running backend instead.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_DIR="$ROOT/ui"
API="${TH_API:-http://127.0.0.1:8765}"
PLATFORM="$(uname -s)"

BACKEND="${TH_BACKEND:-auto}"
FRONTEND="${TH_FRONTEND:-auto}"

CHILDREN=()

log()  { printf '[dev] %s\n' "$*"; }
warn() { printf '[dev] WARNING: %s\n' "$*" >&2; }
die()  { printf '[dev] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- shutdown --

# All descendant PIDs below $1, deepest first (pgrep -P exists on
# Linux + macOS; absent in git-bash, where interactive Ctrl-C group
# delivery covers cleanup anyway).
descendants() {
  command -v pgrep >/dev/null 2>&1 || return 0
  local p kids
  kids=$(pgrep -P "$1" 2>/dev/null || true)
  for p in $kids; do descendants "$p" || true; done
  if [ -n "$kids" ]; then echo $kids; fi
  return 0
}

shutdown() {
  trap - INT TERM EXIT
  set +e  # teardown must never abort midway
  log "shutting down…"
  # Interactive Ctrl-C already delivers SIGINT to the whole foreground
  # process group (vite, cargo, swift all get it directly); this sweep
  # covers stragglers, non-interactive TERM delivery, and grandchildren
  # (npm → sh → vite) that don't get signalled when we TERM their parent.
  if ((${#CHILDREN[@]} > 0)); then
    local all=() pid i alive
    for pid in "${CHILDREN[@]}"; do
      # shellcheck disable=SC2207
      all+=($(descendants "$pid") "$pid")
    done
    kill -TERM "${all[@]}" 2>/dev/null || true
    for i in $(seq 1 12); do
      alive=0
      for pid in "${all[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then alive=1; fi
      done
      if ((alive == 0)); then break; fi
      sleep 0.5
    done
    kill -KILL "${all[@]}" 2>/dev/null || true
  fi
  log "done"
  exit 0
}
trap shutdown INT TERM

# ------------------------------------------------------------------ helpers --

api_up() { curl -sf --max-time 2 "$API/health" >/dev/null 2>&1; }

# Port the API listens on, derived from $API (default 8765).
api_port() { local p="${API##*:}"; echo "${p%%/*}"; }

# PIDs listening on TCP port $1 (lsof on macOS/Linux, fuser on Linux without
# lsof). Empty output when nothing listens or neither tool exists.
port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$1"/tcp 2>/dev/null | tr -s ' ' '\n' || true
  fi
}

# Stop whatever listens on TCP port $1 so we can start fresh. Returns
# non-zero when the port is still occupied afterwards.
stop_port() {
  local port="$1" pids i
  pids="$(port_pids "$port")"
  [ -n "$pids" ] || return 0
  log "stopping existing listener(s) on :$port (pid(s): $(echo $pids | tr '\n' ' '))"
  kill $pids 2>/dev/null || true
  for i in $(seq 1 10); do
    [ -z "$(port_pids "$port")" ] && return 0
    sleep 0.5
  done
  kill -9 $pids 2>/dev/null || true
  for i in $(seq 1 10); do
    [ -z "$(port_pids "$port")" ] && return 0
    sleep 0.5
  done
  return 1
}

# Stop whatever is serving the API so we can start a fresh tracked backend.
# Returns non-zero when the API is still up afterwards (nothing found, or the
# process refused to die) — the caller then reuses the running backend.
stop_api() {
  api_up || return 0
  stop_port "$(api_port)" && ! api_up
}

ensure_swift() {
  # Check `swift build`, not just `swift` — a swiftly-managed toolchain can
  # answer --version while swift-build fails to load (e.g. missing libxml2
  # on newer Ubuntu). Fall back to the rootless toolchain from setup.
  if ! swift build --version >/dev/null 2>&1 && [ -f "$HOME/toolchains/env.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/toolchains/env.sh"
  fi
  command -v swift >/dev/null 2>&1
}

# Wait for the API to come healthy; fails the script after ~90s.
wait_for_api() {
  local i
  for i in $(seq 1 90); do
    api_up && return 0
    sleep 1
  done
  die "API never came up on $API — check the backend output above"
}

open_browser() {
  local url="$1"
  case "$PLATFORM" in
    Darwin) open "$url" >/dev/null 2>&1 || true ;;
    Linux)  xdg-open "$url" >/dev/null 2>&1 || true ;;
    MINGW*|MSYS*|CYGWIN*) start "" "$url" >/dev/null 2>&1 || true ;;
  esac
}

# ------------------------------------------------------------------ backend --

resolve_backend() {
  if [ "$BACKEND" != auto ]; then echo "$BACKEND"; return; fi
  case "$PLATFORM" in
    Darwin) echo app ;;
    Linux)  echo daemon ;;
    *)      echo none ;;
  esac
}

start_backend() {
  local mode="$1"
  [ "$mode" = none ] && return 0
  ensure_swift || die "no swift toolchain on PATH (macOS: Xcode CLT; Linux: ~/toolchains/env.sh or swift.org)"

  local product bin
  case "$mode" in
    app)    product="TokenHorizon" ;;
    daemon) product="token-horizon-headless" ;;
    *)      die "unknown TH_BACKEND=$mode" ;;
  esac

  log "building $product (debug)…"
  (cd "$ROOT" && swift build --product "$product")
  bin="$(cd "$ROOT" && swift build --product "$product" --show-bin-path)/$product"
  [ -x "$bin" ] || die "built binary not found at $bin"

  log "launching $mode backend → $API"
  "$bin" &
  CHILDREN+=($!)
  wait_for_api
  log "backend healthy on $API"
}

# ----------------------------------------------------------------- frontend --

resolve_frontend() {
  if [ "$FRONTEND" != auto ]; then echo "$FRONTEND"; return; fi
  if command -v cargo >/dev/null 2>&1; then echo tauri; else echo vite; fi
}

start_frontend() {
  local mode="$1"
  [ "$mode" = none ] && return 0
  [ -d "$UI_DIR" ] || die "ui/ directory missing"

  # Kill the leftovers of previous dev runs BEFORE starting: a stale vite
  # holds :5173 (strictPort) and breaks both tauri's beforeDevCommand and the
  # vite fallback; a stale Tauri shell holds the sidecar daemon and the
  # cargo target lock.
  stop_port 5173 || warn "could not free :5173 — a stale dev server is still listening"
  pkill -f "$UI_DIR/src-tauri/target/debug/app" 2>/dev/null || true

  cd "$UI_DIR"
  if [ ! -d node_modules/@sveltejs ]; then
    log "installing UI dependencies…"
    npm install
  fi

  case "$mode" in
    tauri)
      # The shell expects the daemon sidecar staged under src-tauri/binaries
      # (externalBin). Build a debug sidecar on demand; release staging is
      # scripts/build-sidecar.sh.
      if ! ls "$UI_DIR"/src-tauri/binaries/token-horizon-headless-* >/dev/null 2>&1; then
        log "staging daemon sidecar for the Tauri shell…"
        (cd "$ROOT" && TH_BACKEND=none scripts/build-sidecar.sh debug) ||
          warn "sidecar staging failed — the app will rely on an already-running daemon"
      fi
      log "starting Tauri shell (vite dev + cargo build on first run)…"
      # Snap-packaged editors (VS Code snap) leak GTK/GDK module and schema
      # paths pointing into the snap runtime; the app then loads the snap's
      # core20 libpthread and dies with a GLIBC_PRIVATE symbol lookup error.
      # Strip them so the child links against the system GTK stack.
      unset GTK_EXE_PREFIX GTK_PATH GTK_IM_MODULE_FILE \
            GDK_PIXBUF_MODULE_FILE GDK_PIXBUF_MODULEDIR \
            GSETTINGS_SCHEMA_DIR GIO_MODULE_DIR LOCPATH 2>/dev/null || true
      npm run tauri dev &
      CHILDREN+=($!)
      # Tauri dies at boot when system webkit deps are missing (common on
      # fresh Linux). Detect an early exit and fall back to the browser.
      local pid=$! i
      sleep 8
      if ! kill -0 "$pid" 2>/dev/null; then
        if [ "$FRONTEND" = auto ]; then
          warn "tauri dev exited immediately — falling back to vite + browser"
          # Drop the dead tauri pid from CHILDREN — the watch loop below
          # tears the whole stack down for any tracked pid that exits.
          local rest=() c
          for c in "${CHILDREN[@]}"; do [ "$c" = "$pid" ] || rest+=("$c"); done
          CHILDREN=("${rest[@]}")
          start_frontend vite
          return
        fi
        die "tauri dev failed — on Linux install: libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libdbus-1-dev (or TH_FRONTEND=vite)"
      fi
      ;;
    vite)
      log "starting vite dev server on http://127.0.0.1:5173"
      npm run dev &
      CHILDREN+=($!)
      sleep 3
      open_browser "http://127.0.0.1:5173"
      ;;
    *) die "unknown TH_FRONTEND=$mode" ;;
  esac
}

# --------------------------------------------------------------------- main --

MODE_BACKEND="$(resolve_backend)"
MODE_FRONTEND="$(resolve_frontend)"

log "platform=$PLATFORM backend=$MODE_BACKEND frontend=$MODE_FRONTEND"

if api_up; then
  if [ "${TH_REUSE:-0}" = 1 ]; then
    log "API already healthy on $API — reusing (will NOT be shut down on exit)"
  elif stop_api; then
    log "existing backend stopped"
  else
    warn "could not stop the existing backend on $API — reusing it (will NOT be shut down on exit)"
  fi
fi
if ! api_up; then
  start_backend "$MODE_BACKEND"
fi

start_frontend "$MODE_FRONTEND"

cat <<EOF

  Token Horizon dev stack is up.
    API : $API
    UI  : $([ "$MODE_FRONTEND" = vite ] && echo "http://127.0.0.1:5173" || echo "Tauri window")

  Ctrl-C shuts down everything this script started.
EOF

# Wait for any tracked child to exit; if one dies, bring the stack down so
# nothing is left orphaned.
while ((${#CHILDREN[@]} > 0)); do
  for pid in "${CHILDREN[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      warn "child process $pid exited — tearing down the stack"
      shutdown
    fi
  done
  sleep 1
done
