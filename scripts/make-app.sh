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

swift build -c release

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/TokenHorizon"; cp Resources/benchmarks.json "$APP/Contents/Resources/" 2>/dev/null

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
    <key>CFBundleShortVersionString</key><string>0.2.0</string>
    <key>CFBundleVersion</key><string>2</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>THGitSHA</key><string>${GIT_SHA}</string>
    <key>THBuiltAt</key><string>${BUILT_AT}</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

codesign --force --sign - "$APP"

if pgrep -x TokenHorizon >/dev/null; then
    pkill -x TokenHorizon || true
    sleep 0.5
fi
# Single canonical install: sync the fresh build over /Applications so a
# manual launch there can never serve stale code again.
ditto "$APP" "$INSTALLED"
# Supervised launch via the app's own agent manager (portable — needs no repo
# scripts at runtime): ensures the LaunchAgent (crash auto-recovery + snapshotted
# env) and (re)starts the app through launchd. TOKEN_HORIZON_* and auth env
# overrides are baked into the agent plist by the installer.
# SKIP_LAUNCH=1 (CI): build + install only, no launch, no health gate.
if [ -z "${SKIP_LAUNCH:-}" ]; then
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
echo "SKIP_LAUNCH=1: installed to $INSTALLED without launching"
