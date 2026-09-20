#!/bin/bash
# Developer ID signed + Apple-notarized release packaging.
#
# Builds the app with make-app.sh (build stamps, Info.plist),
# signs it with the Developer ID identity (hardened runtime + timestamp),
# notarizes + staples it, then packages the ZIP (brew/install) and DMG and
# notarizes + staples the DMG too, finishing with a Gatekeeper assessment.
#
# Signing identity:
#   DEVELOPER_ID_APPLICATION="Developer ID Application: Name (TEAMID)"
# Notarization credentials (first match wins):
#   NOTARYTOOL_PROFILE       stored `xcrun notarytool store-credentials` profile
#   NOTARY_KEY/NOTARY_KEY_ID/NOTARY_ISSUER  App Store Connect API key (.p8)
#   NOTARY_APPLE_ID/NOTARY_TEAM_ID/NOTARY_APP_PASSWORD  Apple ID + app password
# Version (optional):
#   MARKETING_VERSION / CURRENT_PROJECT_VERSION (default: scripts/app/make-app.sh)
set -euo pipefail

cd "$(dirname "$0")/../.."

APP_NAME="TokenHorizon"
APP="${APP_NAME}.app"
OUTPUT_DIR="${OUTPUT_DIR:-dist}"
SIGN_IDENTITY="${DEVELOPER_ID_APPLICATION:-}"
NOTARY_PROFILE="${NOTARYTOOL_PROFILE:-}"
NOTARY_KEY="${NOTARY_KEY:-}"
NOTARY_KEY_ID="${NOTARY_KEY_ID:-}"
NOTARY_ISSUER="${NOTARY_ISSUER:-}"
NOTARY_APPLE_ID="${NOTARY_APPLE_ID:-}"
NOTARY_TEAM_ID="${NOTARY_TEAM_ID:-}"
NOTARY_PASSWORD="${NOTARY_APP_PASSWORD:-}"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

has_notary_creds() {
    [ -n "$NOTARY_PROFILE" ] \
        || { [ -n "$NOTARY_KEY" ] && [ -n "$NOTARY_KEY_ID" ] && [ -n "$NOTARY_ISSUER" ]; } \
        || { [ -n "$NOTARY_APPLE_ID" ] && [ -n "$NOTARY_TEAM_ID" ] && [ -n "$NOTARY_PASSWORD" ]; }
}

submit() {
    local artifact="$1"
    echo "==> notarizing $(basename "$artifact")"
    if [ -n "$NOTARY_PROFILE" ]; then
        xcrun notarytool submit "$artifact" --keychain-profile "$NOTARY_PROFILE" --wait
    elif [ -n "$NOTARY_KEY" ]; then
        xcrun notarytool submit "$artifact" --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait
    else
        xcrun notarytool submit "$artifact" --apple-id "$NOTARY_APPLE_ID" --team-id "$NOTARY_TEAM_ID" --password "$NOTARY_PASSWORD" --wait
    fi
}

# 1. Build (signed when an identity is provided; never install or relaunch).
build_env=(SKIP_INSTALL=1 SKIP_LAUNCH=1)
[ -n "$SIGN_IDENTITY" ] && build_env+=(SIGN_IDENTITY="$SIGN_IDENTITY")
[ -n "${MARKETING_VERSION:-}" ] && build_env+=(MARKETING_VERSION="$MARKETING_VERSION")
[ -n "${CURRENT_PROJECT_VERSION:-}" ] && build_env+=(CURRENT_PROJECT_VERSION="$CURRENT_PROJECT_VERSION")
env "${build_env[@]}" ./scripts/app/make-app.sh
[ -d "$APP" ] || die "$APP was not produced"

VERSION="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")"
if [ -n "$SIGN_IDENTITY" ] && ! security find-identity -v -p codesigning | grep -F "$SIGN_IDENTITY" >/dev/null; then
    die "Developer ID identity not found in the keychain: $SIGN_IDENTITY"
fi

CAN_NOTARIZE=0
if [ -n "$SIGN_IDENTITY" ] && has_notary_creds; then
    CAN_NOTARIZE=1
elif [ -n "$SIGN_IDENTITY" ]; then
    printf 'warning: signed but NOT notarized (set notary credentials)\n'
else
    printf 'warning: ad-hoc signed + NOT notarized (set DEVELOPER_ID_APPLICATION and notary credentials)\n'
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/token-horizon-notary.XXXXXX")"
STAGE=""
cleanup() {
    [ -n "$STAGE" ] && rm -rf "$STAGE"
    rm -rf "$WORK"
}
trap cleanup EXIT

# 2. Notarize the app itself (via a temp zip) and staple it, so the bundle is
#    offline-valid — brew installs the ZIP, and first launch needs no network.
if [ "$CAN_NOTARIZE" = 1 ]; then
    ditto -c -k --keepParent "$APP" "$WORK/${APP_NAME}.zip"
    submit "$WORK/${APP_NAME}.zip"
    xcrun stapler staple "$APP"
    xcrun stapler validate "$APP"
fi

# 3. Package from the (stapled) app.
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
ditto -c -k --keepParent "$APP" "$OUTPUT_DIR/${APP_NAME}-${VERSION}.zip"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/token-horizon-dmg.XXXXXX")"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Token Horizon ${VERSION}" -srcfolder "$STAGE" \
    -ov -format UDZO "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg" >/dev/null

# 4. Notarize + staple the DMG (drag-to-Applications installs validate offline).
if [ "$CAN_NOTARIZE" = 1 ]; then
    submit "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg"
    xcrun stapler staple "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg"
    xcrun stapler validate "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg"
    MOUNT="$(hdiutil attach -nobrowse -readonly "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg" | perl -ne 'if (m{(/Volumes/.*)$}) { $p=$1; $p =~ s/\s+$//; print $p; exit }')"
    [ -n "$MOUNT" ] || die "could not mount the notarized DMG for Gatekeeper validation"
    if spctl --assess --type execute --verbose=2 "$MOUNT/$APP"; then
        :
    else
        STATUS=$?
        hdiutil detach "$MOUNT" >/dev/null || true
        exit "$STATUS"
    fi
    hdiutil detach "$MOUNT" >/dev/null
fi

# 5. Checksums + debug symbols.
(cd "$OUTPUT_DIR" && shasum -a 256 "${APP_NAME}-${VERSION}.zip" "${APP_NAME}-${VERSION}.dmg" > "${APP_NAME}-${VERSION}.sha256")
for cand in .build/*/release/"${APP_NAME}".dSYM; do
    [ -d "$cand" ] && cp -R "$cand" "$OUTPUT_DIR/"
done

STATUS_LABEL="ad-hoc, not notarized"
if [ -n "$SIGN_IDENTITY" ]; then
    if [ "$CAN_NOTARIZE" = 1 ]; then STATUS_LABEL="Developer ID signed, notarized + stapled";
    else STATUS_LABEL="Developer ID signed, NOT notarized (no credentials)"; fi
fi
printf 'created %s (%s) + %s\n' "$OUTPUT_DIR/${APP_NAME}-${VERSION}.zip" \
    "$STATUS_LABEL" \
    "$OUTPUT_DIR/${APP_NAME}-${VERSION}.dmg"
