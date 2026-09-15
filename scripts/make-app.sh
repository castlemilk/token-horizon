#!/bin/bash
# Canonical build+install+launch for Token Horizon.
#
# There is exactly one Token Horizon: this script builds it, stamps it with
# the git commit + UTC time, installs it to /Applications (the copy users
# actually launch — a stale copy there caused real "missing data" scares),
# relaunches it, and health-gates on the SERVING build reporting our stamp.
# Never launch the app by hand or from Xcode without this script unless you
# enjoy debugging two instances with divergent data.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=TokenHorizon.app
INSTALLED=/Applications/TokenHorizon.app
BIN=.build/arm64-apple-macosx/release/TokenHorizon
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "dirty")
if git status --short 2>/dev/null | grep -q .; then GIT_SHA="${GIT_SHA}-dirty"; fi
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Release pipeline overrides: version from the tag, Developer ID identity for
# hardened-runtime signing (notarization requires it). Unset = dev defaults.
VERSION="${MARKETING_VERSION:-0.3.1}"
BUILD_NUMBER="${CURRENT_PROJECT_VERSION:-4}"
SIGN_IDENTITY="${SIGN_IDENTITY:-}"

swift build -c release

# Gateway sidecar (portable Go binary, supervised by the app at runtime).
# The app ALWAYS ships with its proxy: a missing sidecar fails the build.
# TOKEN_HORIZON_NO_GATEWAY=1 opts out explicitly (dev machines without Go);
# releases must never set it.
if [ -z "${TOKEN_HORIZON_NO_GATEWAY:-}" ]; then
    command -v go >/dev/null 2>&1 || { echo "FATAL: go toolchain missing — the app must ship with its gateway proxy (or set TOKEN_HORIZON_NO_GATEWAY=1 to opt out explicitly)"; exit 1; }
    (cd gateway && go build -ldflags "-X main.buildCommit=${GIT_SHA} -X main.buildAt=${BUILT_AT}" -o token-horizon-gateway .)
    [ -x gateway/token-horizon-gateway ] || { echo "FATAL: gateway sidecar build produced no binary"; exit 1; }
else
    echo "WARN: TOKEN_HORIZON_NO_GATEWAY=1 — building WITHOUT the gateway proxy (gateway routes will 503)"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/TokenHorizon"; cp Resources/benchmarks.json "$APP/Contents/Resources/" 2>/dev/null
if [ -f gateway/token-horizon-gateway ]; then
    cp gateway/token-horizon-gateway "$APP/Contents/Resources/"
fi
# Bundle verification: the sidecar must be inside unless explicitly opted out.
if [ -z "${TOKEN_HORIZON_NO_GATEWAY:-}" ]; then
    [ -x "$APP/Contents/Resources/token-horizon-gateway" ] || { echo "FATAL: gateway sidecar missing from app bundle"; exit 1; }
fi

if [ -f Resources/AppIcon.icns ]; then
    cp Resources/AppIcon.icns "$APP/Contents/Resources/"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>TokenHorizon</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleIdentifier</key><string>local.benebsworth.token-horizon</string>
    <key>CFBundleName</key><string>Token Horizon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>THGitSHA</key><string>${GIT_SHA}</string>
    <key>THBuiltAt</key><string>${BUILT_AT}</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

if [ -n "$SIGN_IDENTITY" ]; then
    # Inside-out Developer ID signing: nested binaries first, then the bundle,
    # with hardened runtime + secure timestamp (required for notarization).
    if [ -f "$APP/Contents/Resources/token-horizon-gateway" ]; then
        codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP/Contents/Resources/token-horizon-gateway"
    fi
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP/Contents/MacOS/TokenHorizon"
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
    codesign --verify --deep --strict --verbose=2 "$APP"
    echo "signed with ${SIGN_IDENTITY}"
else
    codesign --force --sign - "$APP"
fi

if [ -z "${SKIP_INSTALL:-}" ] && pgrep -x TokenHorizon >/dev/null; then
    pkill -x TokenHorizon || true
    sleep 0.5
fi
# Single canonical install: sync the fresh build over /Applications so a
# manual launch there can never serve stale code again. SKIP_INSTALL=1
# (release packaging) builds the bundle in place without touching /Applications.
if [ -z "${SKIP_INSTALL:-}" ]; then
    ditto "$APP" "$INSTALLED"
fi
# Supervised launch via the app's own agent manager (portable — needs no repo
# scripts at runtime): ensures the LaunchAgent (crash auto-recovery + snapshotted
# env) and (re)starts the app through launchd. TOKEN_HORIZON_* and auth env
# overrides are baked into the agent plist by the installer.
# SKIP_LAUNCH=1 (CI): build + install only, no launch, no health gate.
if [ -z "${SKIP_LAUNCH:-}" ] && [ -z "${SKIP_INSTALL:-}" ]; then
"$INSTALLED/Contents/MacOS/TokenHorizon" --install-launch-agent

# Health gate: the SERVING instance must report our stamp, or fail loudly.
# A green build that isn't what's on :8765 is exactly the confusion we ended.
for i in $(seq 1 30); do
    HEALTH=$(curl -s -m 2 localhost:8765/health 2>/dev/null || true)
    if echo "$HEALTH" | grep -q "\"commit\":\"${GIT_SHA}\""; then
        echo "verified serving build ${GIT_SHA} (${BUILT_AT})"
        if [ -n "${TOKEN_HORIZON_NO_GATEWAY:-}" ]; then
            echo "TOKEN_HORIZON_NO_GATEWAY=1: skipping gateway gate"
            exit 0
        fi
        # Gateway gate: the app must ship with its proxy available. The
        # supervisor needs a moment after launch to attach/spawn the sidecar.
        for j in $(seq 1 20); do
            GW_PORT=$(curl -s -m 2 localhost:8765/health 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('llm_gateway_port') or '')" 2>/dev/null || true)
            if [ -n "$GW_PORT" ]; then
                echo "verified gateway sidecar on :$GW_PORT"
                exit 0
            fi
            sleep 1
        done
        echo "FATAL: serving build ${GIT_SHA} has no gateway sidecar (llm_gateway_port null after 20s). Check ~/Library/Logs/token-horizon-gateway.log"
        exit 1
    fi
    sleep 1
done
echo "FATAL: :8765 is not serving build ${GIT_SHA} after 30s. Health said:"
echo "$HEALTH" | head -c 600; echo
exit 1
fi
if [ -n "${SKIP_INSTALL:-}" ]; then
    echo "SKIP_INSTALL=1: built $APP in place (not installed to $INSTALLED)"
else
    echo "SKIP_LAUNCH=1: installed to $INSTALLED without launching"
fi
