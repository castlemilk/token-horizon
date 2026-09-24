#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../clients/macos" && pwd)"
APP="$(cd "$(dirname "${1:?Pass the containing app bundle}")" && pwd)/$(basename "$1")"
EXT="$APP/Contents/PlugIns/TokenHorizonWidget.appex"
mkdir -p "$EXT/Contents/MacOS"
SOURCES=(
    "$ROOT/Widget/TokenHorizonWidget.swift"
    "$ROOT/Sources/TokenHorizon/Widget/WidgetSnapshot.swift"
    "$ROOT/Sources/TokenHorizon/Widget/WidgetCard.swift"
    "$ROOT/Sources/TokenHorizon/UI/ProviderLogos.swift"
)
# App extensions must enter via Foundation's _NSExtensionMain (this is what
# Xcode passes for com.apple.product-type.app-extension targets). Entering at
# raw _main makes chronod's gallery probe fail — pluginkit still lists the
# extension statically, but the widget never appears in Edit Widgets.
# No App Intents are involved (widget interactions are tokenhorizon:// deep
# links), so there is no ExtractAppIntentsMetadata step.
SDK="$(xcrun --sdk macosx --show-sdk-path)"
TARGET="$(uname -m)-apple-macos14.0"
xcrun swiftc -swift-version 5 -O -parse-as-library -application-extension \
    -sdk "$SDK" -target "$TARGET" \
    -Xlinker -e -Xlinker _NSExtensionMain \
    "${SOURCES[@]}" \
    -o "$EXT/Contents/MacOS/TokenHorizonWidget"
cp "$ROOT/Widget/Info.plist" "$EXT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable TokenHorizonWidget" "$EXT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.benebsworth.token-horizon.widget" "$EXT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName TokenHorizonWidget" "$EXT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${MARKETING_VERSION:-0.3.5}" "$EXT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${CURRENT_PROJECT_VERSION:-8}" "$EXT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :LSMinimumSystemVersion 14.0" "$EXT/Contents/Info.plist"
SIGN_ARGS=(--force --sign "${SIGN_IDENTITY:--}" --entitlements "$ROOT/Widget/Widget.entitlements")
if [ -n "${SIGN_IDENTITY:-}" ]; then SIGN_ARGS+=(--options runtime --timestamp); fi
codesign "${SIGN_ARGS[@]}" "$EXT"
codesign --verify --strict "$EXT"
