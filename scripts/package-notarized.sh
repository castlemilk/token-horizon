#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="TokenHorizon"
APP="${APP_NAME}.app"
ARCH="${ARCH:-arm64}"
VERSION="${MARKETING_VERSION:-0.2.0}"
BUILD="${CURRENT_PROJECT_VERSION:-2}"
BUNDLE_ID="${BUNDLE_ID:-com.benebsworth.token-horizon}"
SIGNING_IDENTITY="${DEVELOPER_ID_APPLICATION:-}"
NOTARY_PROFILE="${NOTARYTOOL_PROFILE:-}"
OUTPUT_DIR="${OUTPUT_DIR:-dist}"
BIN=".build/${ARCH}-apple-macosx/release/${APP_NAME}"

die() {
    printf 'error: %s\n' "$1" >&2
    exit 1
}

[[ -n "$SIGNING_IDENTITY" ]] || die "set DEVELOPER_ID_APPLICATION to your Developer ID Application identity"
swift build -c release --arch "$ARCH"
[[ -x "$BIN" ]] || die "release executable was not produced at $BIN"

if ! security find-identity -v -p codesigning | grep -F "$SIGNING_IDENTITY" >/dev/null; then
    die "Developer ID Application identity was not found in the login keychain: $SIGNING_IDENTITY"
fi

rm -rf "$APP" "$OUTPUT_DIR"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OUTPUT_DIR"
cp "$BIN" "$APP/Contents/MacOS/$APP_NAME"
if [[ -f Resources/benchmarks.json ]]; then cp Resources/benchmarks.json "$APP/Contents/Resources/"; fi
if [[ -f Resources/AppIcon.icns ]]; then cp Resources/AppIcon.icns "$APP/Contents/Resources/"; fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key><string>en</string>
    <key>CFBundleDisplayName</key><string>Token Horizon</string>
    <key>CFBundleExecutable</key><string>${APP_NAME}</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleIconName</key><string>AppIcon</string>
    <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleName</key><string>Token Horizon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
    <key>CFBundleVersion</key><string>${BUILD}</string>
    <key>ITSAppUsesNonExemptEncryption</key><false/>
    <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Ben Ebsworth</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$APP/Contents/MacOS/$APP_NAME"
codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

ditto -c -k --keepParent "$APP" "$OUTPUT_DIR/${APP_NAME}-${VERSION}.zip"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/token-horizon-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Token Horizon ${VERSION}" -srcfolder "$STAGE" -ov -format UDZO "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg" >/dev/null

if [[ -n "$NOTARY_PROFILE" ]]; then
    xcrun notarytool submit "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg"
    xcrun stapler validate "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg"
    MOUNT="$(hdiutil attach -nobrowse -readonly "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg" | perl -ne 'if (m{(/Volumes/.*)$}) { $p=$1; $p =~ s/\s+$//; print $p; exit }')"
    [[ -n "$MOUNT" ]] || die "could not mount notarized DMG for Gatekeeper validation"
    if spctl --assess --type execute --verbose=2 "$MOUNT/$APP"; then
        :
    else
        STATUS=$?
        hdiutil detach "$MOUNT" >/dev/null || true
        exit "$STATUS"
    fi
    hdiutil detach "$MOUNT" >/dev/null
else
    printf 'notarization skipped: set NOTARYTOOL_PROFILE to submit and staple the DMG\n'
fi

cp -R ".build/${ARCH}-apple-macosx/release/${APP_NAME}.dSYM" "$OUTPUT_DIR/" 2>/dev/null || true
printf 'created %s and %s\n' "$OUTPUT_DIR/${APP_NAME}-${VERSION}.zip" "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg"
