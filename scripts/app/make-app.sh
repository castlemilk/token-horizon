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
cd "$(dirname "$0")/../.."

APP=TokenHorizon.app
INSTALLED=/Applications/TokenHorizon.app
BIN=.build/arm64-apple-macosx/release/TokenHorizon
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "dirty")
if git status --short 2>/dev/null | grep -q .; then GIT_SHA="${GIT_SHA}-dirty"; fi
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Release pipeline overrides: version from the tag, Developer ID identity for
# hardened-runtime signing (notarization requires it). Unset = dev defaults.
VERSION="${MARKETING_VERSION:-0.3.5}"
BUILD_NUMBER="${CURRENT_PROJECT_VERSION:-8}"
SIGN_IDENTITY="${SIGN_IDENTITY:-}"

# Never run this script via sudo: it cannot bypass macOS App Management
# (TCC) protection on /Applications, and a root build leaves root-owned
# files in .build/ + TokenHorizon.app that break the next normal build.
if [ "$(id -u)" -eq 0 ] && [ -z "${SKIP_INSTALL:-}" ]; then
    CONSOLE_USER=$(stat -f%Su /dev/console 2>/dev/null || echo "$USER")
    echo "FATAL: do not run make-app.sh with sudo."
    echo "  sudo does not bypass TCC — grant your terminal 'App Management'"
    echo "  (System Settings → Privacy & Security → App Management) instead."
    echo "  First repair the root-owned build artifacts this run created:"
    echo "    sudo chown -R ${CONSOLE_USER}:staff .build TokenHorizon.app"
    echo "  Then re-run WITHOUT sudo:  ./scripts/app/make-app.sh"
    exit 1
fi

swift build -c release

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/TokenHorizon"; cp Resources/benchmarks.json "$APP/Contents/Resources/" 2>/dev/null
cp Resources/plans.json "$APP/Contents/Resources/" 2>/dev/null

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
    <key>CFBundleURLTypes</key><array><dict>
        <key>CFBundleURLName</key><string>Token Horizon Dashboard</string>
        <key>CFBundleURLSchemes</key><array><string>tokenhorizon</string></array>
    </dict></array>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>THGitSHA</key><string>${GIT_SHA}</string>
    <key>THBuiltAt</key><string>${BUILT_AT}</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" SIGN_IDENTITY="$SIGN_IDENTITY" bash scripts/app/make-widget.sh "$APP"

if [ -n "$SIGN_IDENTITY" ]; then
    # Inside-out Developer ID signing: nested binaries first, then the bundle,
    # with hardened runtime + secure timestamp (required for notarization).
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
    if ! ditto "$APP" "$INSTALLED" 2>/dev/null; then
        echo "direct write to $INSTALLED blocked by macOS App Management (TCC);"
        echo "trying Finder-assisted replacement (approve the Finder prompt if shown)…"
        if [ -d "$INSTALLED" ] && osascript -e 'tell application "Finder" to delete POSIX file "'"$INSTALLED"'"' >/dev/null 2>&1; then
            if ! ditto "$APP" "$INSTALLED"; then
                echo "FATAL: ditto still failed after Finder moved the old bundle to Trash."
                echo "  The previous app is in the Trash — drag it back to /Applications to recover."
                exit 1
            fi
        else
            echo "FATAL: could not write $INSTALLED (macOS App Management / TCC)."
            echo "  sudo does NOT bypass this. Either:"
            echo "    System Settings → Privacy & Security → App Management → enable your terminal"
            echo "  or delete /Applications/TokenHorizon.app in Finder, then re-run ./scripts/app/make-app.sh"
            exit 1
        fi
    fi
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
        exit 0
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
