#!/bin/bash
# Token Horizon one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/castlemilk/token-horizon/main/install.sh | bash
#
# What it does (no prompts, no sudo):
#   1. Resolves the latest GitHub release (or $VERSION, e.g. v0.2.0).
#   2. Downloads TokenHorizon-<ver>.zip, installs to $INSTALL_DIR (/Applications).
#   3. Clears the quarantine flag (preview builds carry an ad-hoc signature).
#   4. Enables crash auto-recovery via the app's own launch agent.
#   5. Wires the `th` shell helper into ~/.zshrc (idempotent).
#   6. Launches the app and verifies :8765 serves the installed build.
#
# Env overrides (mostly for testing):
#   VERSION=x.y.z       pin a release (with or without leading v)
#   TH_INSTALL_URL=url  fetch the zip from a custom URL instead of GitHub
#   INSTALL_DIR=dir     install destination (default /Applications)
#   TH_NO_LAUNCH=1      install only, don't launch
#   TH_NO_AGENT=1       skip the launch agent
#   TH_NO_SHELL=1       skip shell integration
#   NO_COLOR=1          plain output (also auto-detected on non-TTY)
set -euo pipefail

# TH_DEBUG=1 → xtrace every command with an elapsed-seconds prefix.
# Used to pinpoint stalls: the last trace line before output stops is
# the culprit.
if [ -n "${TH_DEBUG:-}" ]; then
    PS4='+ ${SECONDS}s  '
    set -x
fi

REPO="castlemilk/token-horizon"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
APP_NAME="TokenHorizon.app"
T0=$SECONDS

# --- ui ----------------------------------------------------------------------
# Colors only on a real terminal that hasn't opted out.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
    YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
    BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
fi

STEP=0; STEPS=7
step() { STEP=$((STEP + 1)); printf '\n%s %s[%d/%d]%s %s\n' "🔹" "$BOLD" "$STEP" "$STEPS" "$RESET" "$*"; }
ok()   { printf '   %s✔%s %s\n' "$GREEN" "$RESET" "$*"; }
info() { printf '   %s·%s %s\n' "$DIM" "$RESET" "$*"; }
warn() { printf '   %s⚠%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '\n%s✖ %s%s\n\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# Braille spinner for waits. No-op off-TTY; always reaped by the EXIT trap.
SPIN_PID=""
spin_start() {
    [ -t 1 ] || return 0
    (
        frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
        i=0
        while :; do
            printf '\r   %s%s%s %s' "$CYAN" "${frames[$((i % 10))]}" "$RESET" "$1"
            i=$((i + 1)); sleep 0.08
        done
    ) &
    SPIN_PID=$!
}
spin_stop() {
    # Never `wait` here: a subshell stuck in sleep/write can block wait
    # indefinitely on some setups (seen in the wild — install froze at
    # `wait $SPIN_PID` after kill). TERM, brief grace, then SIGKILL —
    # all non-blocking. A stray last frame is cosmetic; a hang is not.
    if [ -n "$SPIN_PID" ]; then
        kill "$SPIN_PID" 2>/dev/null || true
        kill -0 "$SPIN_PID" 2>/dev/null && sleep 0.05
        kill -9 "$SPIN_PID" 2>/dev/null || true
        SPIN_PID=""
    fi
    [ -t 1 ] && printf '\r\033[K' || true
}

# Cleanup must exist BEFORE any spinner/fail can fire — otherwise an early
# error orphans the spinner subshell, which keeps animating forever and
# masks the real error message.
STAGE=""
cleanup() {
    spin_stop
    [ -n "$STAGE" ] && rm -rf "$STAGE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- banner -------------------------------------------------------------------
printf '%s' "$CYAN"
cat <<'BANNER'
        _        _                  _            _
       | |_ ___ | | _____ _ __     | |__   ___  _ __(_)_______  _ __
       | __/ _ \| |/ / _ \ '_ \    | '_ \ / _ \| '__| |_  / _ \| '_ \
       | || (_) |   <  __/ | | |   | | | | (_) | |  | |/ / (_) | | | |
        \__\___/|_|\_\___|_| |_|   |_| |_|\___/|_|  |_/___\___/|_| |_|
BANNER
printf '%s' "$RESET"
printf '%s   local LLM usage + observability — one command to install%s\n' "$DIM" "$RESET"

# --- 1: preflight --------------------------------------------------------------
step "Preflight"
[ "$(uname -s)" = "Darwin" ] || fail "Token Horizon is macOS-only (got $(uname -s))."
ok "macOS $(sw_vers -productVersion)"
[ "$(uname -m)" = "arm64" ] || fail "Token Horizon needs Apple silicon (got $(uname -m))."
ok "Apple silicon ($(uname -m))"
for tool in curl unzip ditto plutil; do
    command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
done
ok "tools: curl · unzip · ditto · plutil"

# --- 2: resolve release ---------------------------------------------------------
step "Resolve release"
if [ -n "${TH_INSTALL_URL:-}" ]; then
    ZIP_URL="$TH_INSTALL_URL"
    ok "override URL"
else
    if [ -n "${VERSION:-}" ]; then
        TAG="v${VERSION#v}"
        ok "pinned ${TAG}"
    else
        spin_start "contacting github…"
        # Primary: GET releases/latest, follow the 302 to /releases/tag/vX.Y.Z,
        # read url_effective. GET (not HEAD/-I) — some proxies stall HEAD.
        # No API call → no rate limit. Fallback: the API.
        # `|| true` must live INSIDE the substitution: with set -euo pipefail,
        # a failed pipeline aborts the whole script at the assignment before
        # the fallback/fail below can run.
        TAG=$(curl -fsSL --connect-timeout 10 --max-time 20 -o /dev/null \
                -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" 2>/dev/null \
              | sed -n 's|.*/tag/\(v[^/ ]*\).*|\1|p' || true)
        if [ -z "$TAG" ]; then
            # API fallback; sed not python3 (a fresh rig may lack CLT python3,
            # and the stub can stall behind a GUI install prompt).
            TAG=$(curl -fsSL --connect-timeout 10 --max-time 20 "https://api.github.com/repos/${REPO}/releases/latest" \
                | sed -n 's/.*"tag_name": *"\(v[^"]*\)".*/\1/p' | head -1 || true)
        fi
        spin_stop
        [ -n "$TAG" ] || fail "could not reach github.com — check VPN/proxy/DNS, then retry. Offline install: download the release zip on another machine, then TH_INSTALL_URL=file:///path/to/TokenHorizon-x.y.z.zip"
        ok "latest release ${BOLD}${TAG}${RESET}"
    fi
    ZIP_URL="https://github.com/${REPO}/releases/download/${TAG}/TokenHorizon-${TAG#v}.zip"
fi
info "$ZIP_URL"

# --- 3: download + unpack --------------------------------------------------------
step "Download"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/token-horizon-install.XXXXXX")"
spin_start "downloading ${TAG:-app}…"
curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 -o "$STAGE/app.zip" "$ZIP_URL" \
    || { spin_stop; fail "download failed: $ZIP_URL"; }
spin_stop
ZIP_MB=$(du -m "$STAGE/app.zip" | awk '{print $1}')
ok "downloaded ${ZIP_MB} MB"
spin_start "unpacking…"
unzip -q -o "$STAGE/app.zip" -d "$STAGE/unpack" \
    || { spin_stop; fail "downloaded file is not a valid zip"; }
spin_stop
SRC="$STAGE/unpack/$APP_NAME"
[ -d "$SRC" ] || fail "zip does not contain $APP_NAME"
SRC_BIN="$SRC/Contents/MacOS/TokenHorizon"
[ -x "$SRC_BIN" ] || fail "app binary missing in archive"
ok "verified ${APP_NAME}"

# --- 4: install -------------------------------------------------------------------
step "Install"
if [ -e "${INSTALL_DIR}/${APP_NAME}" ] && [ -z "${TH_INSTALL_URL:-}" ]; then
    BACKUP="${INSTALL_DIR}/${APP_NAME%.app}.backup.app"
    rm -rf "$BACKUP"
    mv "${INSTALL_DIR}/${APP_NAME}" "$BACKUP"
    info "previous install parked at ${BACKUP/#$HOME/~}"
fi
mkdir -p "$INSTALL_DIR"
spin_start "installing to ${INSTALL_DIR}…"
ditto "$SRC" "${INSTALL_DIR}/${APP_NAME}"
spin_stop
INSTALLED_BIN="${INSTALL_DIR}/${APP_NAME}/Contents/MacOS/TokenHorizon"
# Preview builds are ad-hoc signed: drop quarantine so first launch just works.
xattr -dr com.apple.quarantine "${INSTALL_DIR}/${APP_NAME}" 2>/dev/null || true
ok "${INSTALL_DIR/#$HOME/~}/${APP_NAME}"

INSTALLED_VER=$(plutil -extract THGitSHA raw \
    "${INSTALL_DIR}/${APP_NAME}/Contents/Info.plist" 2>/dev/null || true)
APP_VER=$(plutil -extract CFBundleShortVersionString raw \
    "${INSTALL_DIR}/${APP_NAME}/Contents/Info.plist" 2>/dev/null || true)
info "v${APP_VER:-?} · ${INSTALLED_VER:-dev}"

# --- 5: launch agent ---------------------------------------------------------------
step "Crash recovery"
if [ -z "${TH_NO_AGENT:-}" ]; then
    if "$INSTALLED_BIN" --install-launch-agent >/dev/null 2>&1; then
        ok "launch agent armed (restarts the app if it dies)"
    else
        warn "launch agent setup failed — app still installed"
    fi
else
    info "skipped (TH_NO_AGENT=1)"
fi

# --- 6: shell + MCP helpers ----------------------------------------------------------
step "Shell + agent integration"
TH_HOME="$HOME/.config/token-horizon"
if [ -z "${TH_INSTALL_URL:-}" ]; then
    REF="${TAG:-main}"
    mkdir -p "$TH_HOME/mcp" "$TH_HOME/shell"
    spin_start "fetching helpers (${REF})…"
    curl -fsSL --max-time 30 -o "$TH_HOME/shell/token-horizon.zsh" \
        "https://raw.githubusercontent.com/${REPO}/${REF}/shell/token-horizon.zsh" \
        || warn "could not fetch shell helpers"
    curl -fsSL --max-time 30 -o "$TH_HOME/mcp/token-horizon-mcp.mjs" \
        "https://raw.githubusercontent.com/${REPO}/${REF}/mcp/token-horizon-mcp.mjs" \
        || warn "could not fetch MCP server"
    spin_stop
    ok "~/.config/token-horizon/{shell,mcp}"
else
    info "skipped for override URL (clone the repo for shell/MCP extras)"
fi

if [ -z "${TH_NO_SHELL:-}" ]; then
    ZSHRC="$HOME/.zshrc"
    MARKER="# token-horizon shell integration"
    if [ -f "$ZSHRC" ] && grep -qF "$MARKER" "$ZSHRC"; then
        ok "shell hook already in ~/.zshrc"
    else
        {
            echo ""
            echo "$MARKER (th CLI + per-command token hooks)"
            echo "[ -f \"\$HOME/.config/token-horizon/shell/token-horizon.zsh\" ] && source \"\$HOME/.config/token-horizon/shell/token-horizon.zsh\""
        } >> "$ZSHRC"
        ok "shell hook added to ~/.zshrc"
    fi
else
    info "shell hook skipped (TH_NO_SHELL=1)"
fi

# --- 7: launch + verify ---------------------------------------------------------------
GW_PORT=""
HEALTH_JSON=""
if [ -z "${TH_NO_LAUNCH:-}" ]; then
    step "Launch + verify"
    # Upgrade path: the running copy still serves the OLD build — `open -a`
    # would just activate it, not launch the new bundle. Quit it first;
    # clean exit doesn't trip the KeepAlive(SuccessfulExit=false) agent,
    # so the port frees and the new build takes over.
    if pgrep -f "${APP_NAME}/Contents/MacOS/" >/dev/null 2>&1; then
        info "stopping running copy…"
        pkill -TERM -f "${APP_NAME}/Contents/MacOS/" 2>/dev/null || true
        sleep 1
    fi
    open -a "${INSTALL_DIR}/${APP_NAME}" 2>/dev/null || "$INSTALLED_BIN" >/dev/null 2>&1 &
    spin_start "waiting for :8765…"
    for _ in $(seq 1 30); do
        HEALTH_JSON=$(curl -s -m 2 localhost:8765/health 2>/dev/null || true)
        echo "$HEALTH_JSON" | grep -q '"ok":true' && break
        sleep 1
    done
    spin_stop
    echo "$HEALTH_JSON" | grep -q '"ok":true' \
        || fail ":8765 never came up — check $HOME/Library/Logs/TokenHorizon.log"
    SERVING_COMMIT=$(echo "$HEALTH_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('build',{}).get('commit','?'))" 2>/dev/null || true)
    ok "api up on :8765 (${SERVING_COMMIT:-?})"
    # Upgrade sanity: if an old instance survived, :8765 still reports the
    # previous build's stamp — flag it instead of silently "succeeding".
    if [ -n "$INSTALLED_VER" ] && [ -n "$SERVING_COMMIT" ] \
        && [ "$SERVING_COMMIT" != "$INSTALLED_VER" ]; then
        warn "still serving old build ${SERVING_COMMIT} (installed ${INSTALLED_VER}) — quit & relaunch the app"
    fi
    # The app always ships with its proxy: fail loudly if the sidecar never
    # attached (check ~/Library/Logs/token-horizon-gateway.log).
    GW_PORT=$(echo "$HEALTH_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('llm_gateway_port') or '')" 2>/dev/null || true)
    if [ -z "$GW_PORT" ]; then
        spin_start "gateway sidecar attaching…"
        sleep 10
        spin_stop
        GW_PORT=$(curl -s -m 2 localhost:8765/health 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('llm_gateway_port') or '')" 2>/dev/null || true)
    fi
    [ -n "$GW_PORT" ] && ok "gateway sidecar on :$GW_PORT" \
        || fail "gateway sidecar unavailable (llm_gateway_port null) — check $HOME/Library/Logs/token-horizon-gateway.log"
else
    info "launch skipped (TH_NO_LAUNCH=1)"
fi

# --- success menu ----------------------------------------------------------------------
ELAPSED=$((SECONDS - T0))
printf '\n%s╭──────────────────────────────────────────────────────────────────────────╮%s\n' "$DIM" "$RESET"
printf '%s│%s   %s🛰  TOKEN HORIZON v%s%s %s— installed in %ss%s\n' "$DIM" "$RESET" "$BOLD" "${APP_VER:-?}" "$RESET" "$DIM" "$ELAPSED" "$RESET"
printf '%s│%s\n' "$DIM" "$RESET"
printf '%s│%s   %s✓%s app       %s\n' "$DIM" "$RESET" "$GREEN" "$RESET" "${INSTALL_DIR/#$HOME/~}/${APP_NAME}  ·  v${APP_VER:-?}"
if [ -n "$GW_PORT" ]; then
    printf '%s│%s   %s✓%s api       %s\n' "$DIM" "$RESET" "$GREEN" "$RESET" "http://127.0.0.1:8765   ·   http://127.0.0.1:${GW_PORT} (gateway)"
else
    printf '%s│%s   %s✓%s api       %s\n' "$DIM" "$RESET" "$GREEN" "$RESET" "http://127.0.0.1:8765"
fi
printf '%s│%s   %s✓%s helpers   %s\n' "$DIM" "$RESET" "$GREEN" "$RESET" "~/.config/token-horizon (th CLI · MCP server)"
printf '%s│%s\n' "$DIM" "$RESET"
printf '%s│%s   %sTRY IT%s\n' "$DIM" "$RESET" "$BOLD" "$RESET"
printf '%s│%s     %s th stats %s         live usage + quotas %s(restart your shell)%s\n' "$DIM" "$RESET" "$CYAN" "$RESET" "$DIM" "$RESET"
printf '%s│%s     %s th limits %s        plan windows, resets\n' "$DIM" "$RESET" "$CYAN" "$RESET"
printf '%s│%s     %s th leaderboard %s   rank your grind\n' "$DIM" "$RESET" "$CYAN" "$RESET"
printf '%s│%s     %s TRACES tab %s       LLM observability — notch hover / menu bar icon\n' "$DIM" "$RESET" "$CYAN" "$RESET"
printf '%s│%s\n' "$DIM" "$RESET"
printf '%s│%s   %sPOINT AGENTS AT THE GATEWAY%s %s(captures traces)%s\n' "$DIM" "$RESET" "$BOLD" "$RESET" "$DIM" "$RESET"
printf '%s│%s     OPENAI_BASE_URL=http://127.0.0.1:%s     ANTHROPIC_BASE_URL=http://127.0.0.1:%s\n' "$DIM" "$RESET" "${GW_PORT:-11436}" "${GW_PORT:-11436}"
printf '%s│%s\n' "$DIM" "$RESET"
if [ -f "$TH_HOME/mcp/token-horizon-mcp.mjs" ]; then
    if command -v node >/dev/null 2>&1; then
        printf '%s│%s   %sMCP FOR AGENTS%s — add to your MCP config:\n' "$DIM" "$RESET" "$BOLD" "$RESET"
        printf '%s│%s     {"token-horizon":{"command":"node","args":["%s/mcp/token-horizon-mcp.mjs"]}}\n' "$DIM" "$RESET" "$TH_HOME"
    else
        printf '%s│%s   %sMCP%s server staged in %s/mcp %s(install node to use it)%s\n' "$DIM" "$RESET" "$BOLD" "$RESET" "$TH_HOME" "$DIM" "$RESET"
    fi
    printf '%s│%s\n' "$DIM" "$RESET"
fi
printf '%s╰──────────────────────────────────────────────────────────────────────────╯%s\n\n' "$DIM" "$RESET"
