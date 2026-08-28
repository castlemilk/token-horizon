#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

APP=TokenHorizon.app
BIN=.build/arm64-apple-macosx/release/TokenHorizon

swift build -c release

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/TokenHorizon"; cp Resources/benchmarks.json "$APP/Contents/Resources/" 2>/dev/null

if [ -f Resources/AppIcon.icns ]; then
    cp Resources/AppIcon.icns "$APP/Contents/Resources/"
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
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
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

codesign --force --sign - "$APP"

if pgrep -x TokenHorizon >/dev/null; then
    pkill -x TokenHorizon || true
    sleep 0.5
fi
open "$APP"
echo "launched $APP"
