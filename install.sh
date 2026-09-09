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
#   VERSION=x.y.z  pin a release (with or without leading v)
#   TH_INSTALL_URL=url  fetch the zip from a custom URL instead of GitHub
#   INSTALL_DIR=dir     install destination (default /Applications)
#   TH_NO_LAUNCH=1      install only, don't launch
#   TH_NO_AGENT=1       skip the launch agent
#   TH_NO_SHELL=1       skip shell integration
set -euo pipefail

REPO="castlemilk/token-horizon"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
APP_NAME="TokenHorizon.app"

log() { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --- platform guard ---------------------------------------------------------
if [ "$(uname -s)" != "Darwin" ]; then
    fail "Token Horizon is macOS-only (got $(uname -s))."
fi
if [ "$(uname -m)" != "arm64" ]; then
    fail "Token Horizon needs Apple silicon (got $(uname -m))."
fi
for tool in curl unzip ditto plutil; do
    command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
done

# --- resolve version + URL --------------------------------------------------
if [ -n "${TH_INSTALL_URL:-}" ]; then
    ZIP_URL="$TH_INSTALL_URL"
    log "using override URL"
else
    if [ -n "${VERSION:-}" ]; then
        TAG="v${VERSION#v}"
    else
        log "resolving latest release…"
        TAG=$(curl -fsSL --max-time 20 "https://api.github.com/repos/${REPO}/releases/latest" \
            | python3 -c "import json,sys; print(json.load(sys.stdin).get('tag_name',''))" 2>/dev/null || true)
        [ -n "$TAG" ] || fail "could not resolve latest release (network or API limit?). Retry with VERSION=x.y.z."
    fi
    ZIP_URL="https://github.com/${REPO}/releases/download/${TAG}/TokenHorizon-${TAG#v}.zip"
fi
log "installing from $ZIP_URL"

# --- download + unpack to a staging dir -------------------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/token-horizon-install.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
curl -fSL --max-time 120 --retry 2 -o "$STAGE/app.zip" "$ZIP_URL" \
    || fail "download failed: $ZIP_URL"
unzip -q -o "$STAGE/app.zip" -d "$STAGE/unpack" \
    || fail "downloaded file is not a valid zip"
SRC="$STAGE/unpack/$APP_NAME"
[ -d "$SRC" ] || fail "zip does not contain $APP_NAME"
SRC_BIN="$SRC/Contents/MacOS/TokenHorizon"
[ -x "$SRC_BIN" ] || fail "app binary missing in archive"

# --- install ----------------------------------------------------------------
log "installing to ${INSTALL_DIR}/${APP_NAME}…"
mkdir -p "$INSTALL_DIR"
if [ -e "${INSTALL_DIR}/${APP_NAME}" ] && [ -z "${TH_INSTALL_URL:-}" ]; then
    BACKUP="${INSTALL_DIR}/${APP_NAME%.app}.backup.app"
    rm -rf "$BACKUP"
    mv "${INSTALL_DIR}/${APP_NAME}" "$BACKUP"
    log "previous install moved to $BACKUP"
fi
ditto "$SRC" "${INSTALL_DIR}/${APP_NAME}"
INSTALLED_BIN="${INSTALL_DIR}/${APP_NAME}/Contents/MacOS/TokenHorizon"
# Preview builds are ad-hoc signed: drop quarantine so first launch just works.
xattr -dr com.apple.quarantine "${INSTALL_DIR}/${APP_NAME}" 2>/dev/null || true

INSTALLED_VER=$(plutil -p "${INSTALL_DIR}/${APP_NAME}/Contents/Info.plist" 2>/dev/null \
    | grep -A1 THGitSHA | tail -1 | tr -d ' "_pkg' || true)
log "installed ${INSTALLED_BIN} ${INSTALLED_VER}"

# --- launch agent (crash auto-recovery, managed by the binary itself) -------
if [ -z "${TH_NO_AGENT:-}" ]; then
    "$INSTALLED_BIN" --install-launch-agent || log "warning: launch agent setup failed (app still installed)"
else
    log "skipping launch agent (TH_NO_AGENT=1)"
fi

# --- shell integration + MCP server (self-contained, versioned) ---------------
TH_HOME="$HOME/.config/token-horizon"
if [ -z "${TH_INSTALL_URL:-}" ]; then
    REF="${TAG:-main}"
    mkdir -p "$TH_HOME/mcp" "$TH_HOME/shell"
    log "fetching shell + MCP helpers (${REF})…"
    curl -fsSL --max-time 30 -o "$TH_HOME/shell/token-horizon.zsh" \
        "https://raw.githubusercontent.com/${REPO}/${REF}/shell/token-horizon.zsh" \
        || log "warning: could not fetch shell helpers"
    curl -fsSL --max-time 30 -o "$TH_HOME/mcp/token-horizon-mcp.mjs" \
        "https://raw.githubusercontent.com/${REPO}/${REF}/mcp/token-horizon-mcp.mjs" \
        || log "warning: could not fetch MCP server"
else
    log "skipping helper fetch for override URL (clone the repo for shell/MCP extras)"
fi

if [ -z "${TH_NO_SHELL:-}" ]; then
    ZSHRC="$HOME/.zshrc"
    MARKER="# token-horizon shell integration"
    if [ -f "$ZSHRC" ] && grep -qF "$MARKER" "$ZSHRC"; then
        log "shell integration already present in $ZSHRC"
    else
        {
            echo ""
            echo "$MARKER (th CLI + per-command token hooks)"
            echo "[ -f \"\$HOME/.config/token-horizon/shell/token-horizon.zsh\" ] && source \"\$HOME/.config/token-horizon/shell/token-horizon.zsh\""
        } >> "$ZSHRC"
        log "added shell integration to $ZSHRC (restart your shell, then try: th)"
    fi
else
    log "skipping shell integration (TH_NO_SHELL=1)"
fi

# --- launch + verify ----------------------------------------------------------
if [ -z "${TH_NO_LAUNCH:-}" ]; then
    open -a "${INSTALL_DIR}/${APP_NAME}" 2>/dev/null || "$INSTALLED_BIN" >/dev/null 2>&1 &
    log "launched; waiting for :8765…"
    for _ in $(seq 1 30); do
        if curl -s -m 2 localhost:8765/health 2>/dev/null | grep -q '"ok":true'; then
            log "Token Horizon is up: $(curl -s -m 2 localhost:8765/health | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('build',{}).get('commit','?'))" 2>/dev/null)"
            break
        fi
        sleep 1
    done
    curl -s -m 2 localhost:8765/health 2>/dev/null | grep -q '"ok":true' \
        || fail ":8765 never came up — check $HOME/Library/Logs/TokenHorizon.log"
else
    log "skipping launch (TH_NO_LAUNCH=1)"
fi

cat <<EOF

Done. Useful next steps:
  th                       shell status (after restarting your shell)
  curl -s localhost:8765/limits | python3 -m json.tool
EOF
if [ -f "$TH_HOME/mcp/token-horizon-mcp.mjs" ]; then
    if command -v node >/dev/null 2>&1; then
        printf '%s\n' "  MCP for agents — add to your MCP config:"
        printf '%s\n' '    {"token-horizon": {"command": "node", "args": ["'"$TH_HOME"'/mcp/token-horizon-mcp.mjs"]}}'
    else
        printf '%s\n' "  MCP server downloaded to $TH_HOME/mcp (install node to use it with agents)"
    fi
fi
