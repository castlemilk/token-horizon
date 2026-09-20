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
#   TH_BACKEND=app|daemon|go|none  backend choice (default: macOS=app,
#                         Linux=go — the Go migration target; daemon = the
#                         legacy Swift headless, kept until full route parity)
#   TH_CLOUD=auto|1|0              cloud sync server (cloud/server); auto = on
#                                  when a Go toolchain is available
#   TH_CLOUD_ADDR=:8080            cloud listen address
#   TH_CLOUD_DRIVER=duckdb         store driver (duckdb default, postgres later)
#   TH_CLOUD_DSN=…                 default ~/.config/token-horizon/cloud-dev.duckdb
#   TH_CLOUD_TOKEN=dev-token       service bearer (local dev only)
#   TH_CLOUD_WATCH=1               hot reload: rebuild+restart the cloud
#                                  server on source changes (cmd/devwatch)
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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UI_DIR="$ROOT/ui"
API="${TH_API:-http://127.0.0.1:8765}"
PLATFORM="$(uname -s)"

BACKEND="${TH_BACKEND:-auto}"
FRONTEND="${TH_FRONTEND:-auto}"
CLOUD="${TH_CLOUD:-auto}"
CLOUD_ADDR="${TH_CLOUD_ADDR:-:8080}"
CLOUD_URL="http://127.0.0.1${CLOUD_ADDR}"
CLOUD_DRIVER="${TH_CLOUD_DRIVER:-duckdb}"
CLOUD_DSN="${TH_CLOUD_DSN:-${XDG_CONFIG_HOME:-$HOME/.config}/token-horizon/cloud-dev.duckdb}"
CLOUD_TOKEN="${TH_CLOUD_TOKEN:-dev-token}"
CLOUD_WATCH="${TH_CLOUD_WATCH:-1}"

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

ensure_go() {
  # go is often installed but not on PATH (e.g. /usr/local/go).
  if ! command -v go >/dev/null 2>&1; then
    for d in /usr/local/go/bin /usr/lib/go/bin "$HOME/go/bin"; do
      [ -x "$d/go" ] && PATH="$PATH:$d"
    done
  fi
  command -v go >/dev/null 2>&1
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
    Darwin) echo app ;;   # the Go port has no macOS system-stats backend yet
    Linux)  echo go ;;    # migration target is the default; TH_BACKEND=daemon for Swift
    *)      echo none ;;
  esac
}

start_backend() {
  local mode="$1"
  [ "$mode" = none ] && return 0

  if [ "$mode" = go ]; then
    # The Go migration target. Shares usage.db, config files and the
    # loopback contract with the Swift daemon — but not yet route parity
    # (UI-called gaps: /stats, /trends, /analytics/aggregate, /consents,
    # /permissions, /meters/toggle|port, /runtimes/history|endpoints).
    ensure_go || die "no Go toolchain on PATH (install go or use TH_BACKEND=daemon)"
    local bin="${TMPDIR:-/tmp}/th-daemon-dev-$(api_port)"
    log "building token-horizon-daemon (go)…"
    (cd "$ROOT/daemons/go" && go build -o "$bin" ./cmd/token-horizon-daemon)
    log "launching go backend → $API"
    "$bin" --port "$(api_port)" &
    CHILDREN+=($!)
    wait_for_api
    log "backend healthy on $API"
    return 0
  fi

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
      # scripts/app/build-sidecar.sh.
      if ! ls "$UI_DIR"/src-tauri/binaries/token-horizon-headless-* >/dev/null 2>&1; then
        log "staging daemon sidecar for the Tauri shell…"
        (cd "$ROOT" && TH_BACKEND=none scripts/app/build-sidecar.sh debug) ||
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

# --------------------------------------------------------------------- cloud --

cloud_port() { echo "${CLOUD_ADDR#:}"; }
cloud_up() { curl -sf --max-time 2 "$CLOUD_URL/healthz" >/dev/null 2>&1; }

resolve_cloud() {
  case "$CLOUD" in
    1|0) echo "$CLOUD" ;;
    auto) ensure_go >/dev/null 2>&1 && echo 1 || echo 0 ;;
    *) die "unknown TH_CLOUD=$CLOUD" ;;
  esac
}

start_cloud() {
  [ "$1" = 1 ] || return 0
  ensure_go || die "TH_CLOUD=1 but no go toolchain found (/usr/local/go, ~/go)"
  local dir="$ROOT/cloud/server" tags=() tagstr=""
  [ -d "$dir" ] || die "cloud/server missing"
  # DuckDB registers its driver behind the duckdb build tag (~100MB static
  # link; Go's build cache makes reruns cheap after the first).
  if [ "$CLOUD_DRIVER" = duckdb ]; then tags=(-tags duckdb); tagstr=duckdb; fi

  stop_port "$(cloud_port)" || warn "could not free ${CLOUD_ADDR} — a stale cloud server may still be listening"
  mkdir -p "$(dirname "$CLOUD_DSN")"

  log "migrating cloud store ($CLOUD_DRIVER → $CLOUD_DSN)…"
  (cd "$dir" && go run ${tags[@]+"${tags[@]}"} ./cmd/migrate --driver "$CLOUD_DRIVER" --dsn "$CLOUD_DSN")

  # Build then exec the server binary directly — a `go run` wrapper can
  # orphan the compiled child when the stack tears down mid-startup.
  local bin="${TMPDIR:-/tmp}/token-horizon-cloud-dev"

  if [ "$CLOUD_WATCH" = 1 ]; then
    # Hot reload: devwatch polls the source tree, rebuilds ./cmd/server
    # and restarts it on change (build failures keep the old binary).
    local watcher="${TMPDIR:-/tmp}/token-horizon-cloud-devwatch"
    (cd "$dir" && go build -o "$watcher" ./cmd/devwatch)
    log "launching cloud sync server → $CLOUD_URL ($CLOUD_DRIVER, hot reload)"
    (cd "$dir" && \
      TH_SERVER_DRIVER="$CLOUD_DRIVER" TH_SERVER_DSN="$CLOUD_DSN" \
      TH_SERVER_ADDR="$CLOUD_ADDR" TH_SYNC_TOKEN="$CLOUD_TOKEN" \
      "$watcher" --tags "$tagstr" --bin "$bin") &
    CHILDREN+=($!)
  else
    (cd "$dir" && go build ${tags[@]+"${tags[@]}"} -o "$bin" ./cmd/server)
    log "launching cloud sync server → $CLOUD_URL ($CLOUD_DRIVER)"
    TH_SERVER_DRIVER="$CLOUD_DRIVER" TH_SERVER_DSN="$CLOUD_DSN" \
    TH_SERVER_ADDR="$CLOUD_ADDR" TH_SYNC_TOKEN="$CLOUD_TOKEN" \
      "$bin" &
    CHILDREN+=($!)
  fi
  local i
  for i in $(seq 1 60); do
    cloud_up && { log "cloud server healthy on $CLOUD_URL"; return 0; }
    sleep 1
  done
  die "cloud server never came up on $CLOUD_URL"
}

# --------------------------------------------------------------------- main --

MODE_BACKEND="$(resolve_backend)"
MODE_FRONTEND="$(resolve_frontend)"
MODE_CLOUD="$(resolve_cloud)"

log "platform=$PLATFORM backend=$MODE_BACKEND frontend=$MODE_FRONTEND cloud=$MODE_CLOUD"

# Point the daemon's cloud sync at the dev cloud server. Env must be set
# BEFORE the backend launches (the syncer reads TH_SYNC_* at boot); a
# reused/already-running daemon keeps whatever it was started with.
if [ "$MODE_CLOUD" = 1 ]; then
  export TH_SYNC_URL="$CLOUD_URL"
  export TH_SYNC_TOKEN="$CLOUD_TOKEN"
  export TH_SYNC_HANDLE="${TH_SYNC_HANDLE:-${USER:-unknown}}"
fi

if api_up; then
  if [ "$MODE_BACKEND" = none ]; then
    log "API already healthy on $API — TH_BACKEND=none, leaving it alone"
    if [ "$MODE_CLOUD" = 1 ]; then
      log "note: the running daemon keeps its own sync config — restart it with this stack for cloud sync (TH_SYNC_URL=$CLOUD_URL)"
    fi
  elif [ "${TH_REUSE:-0}" = 1 ]; then
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

start_cloud "$MODE_CLOUD"

# Point the UI at the dev cloud (Vite: process-env VITE_* beats .env files)
# so sign-in, the dock indicators and the profile pages all aim at the same
# server the daemon syncs to.
[ "$CLOUD" = 1 ] && export VITE_CLOUD_URL="${VITE_CLOUD_URL:-$CLOUD_URL}"

start_frontend "$MODE_FRONTEND"

cat <<EOF

  Token Horizon dev stack is up.
    API   : $API
    Cloud : $([ "$MODE_CLOUD" = 1 ] && echo "$CLOUD_URL ($CLOUD_DRIVER, token=$CLOUD_TOKEN)" || echo "off")
    UI    : $(case "$MODE_FRONTEND" in vite) echo "http://127.0.0.1:5173";; tauri) echo "Tauri window";; *) echo "off";; esac)

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
