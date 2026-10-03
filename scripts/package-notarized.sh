#!/bin/bash
# Package the canonical Mac bundle without installing or launching it.
set -euo pipefail
cd "$(dirname "$0")/.."
APP_NAME=TokenHorizon
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
RELEASE_BUILD="${RELEASE_BUILD:-0}"
die() { printf 'error: %s\n' "$1" >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/token-horizon-notary.XXXXXX")"
MOUNT=""
cleanup() {
    local status=$?
    if [ -n "$MOUNT" ]; then hdiutil detach "$MOUNT" >/dev/null 2>&1 || status=1; fi
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Validate the selected credential mode before building. Partial credentials
# fail rather than quietly producing an unnotarized release.
NOTARY_ARGS=()
if [ -n "$NOTARY_PROFILE" ]; then
    NOTARY_ARGS=(--keychain-profile "$NOTARY_PROFILE")
elif [ -n "$NOTARY_KEY$NOTARY_KEY_ID$NOTARY_ISSUER" ]; then
    [ -n "$NOTARY_KEY" ] && [ -n "$NOTARY_KEY_ID" ] && [ -n "$NOTARY_ISSUER" ] || die "API notarization requires key, key ID and issuer together"
    [ -f "$NOTARY_KEY" ] && [ -s "$NOTARY_KEY" ] || die "NOTARY_KEY must be a non-empty .p8 file"
    NOTARY_ARGS=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
elif [ -n "$NOTARY_APPLE_ID$NOTARY_TEAM_ID$NOTARY_PASSWORD" ]; then
    [ -n "$NOTARY_APPLE_ID" ] && [ -n "$NOTARY_TEAM_ID" ] && [ -n "$NOTARY_PASSWORD" ] || die "Apple-ID notarization requires Apple ID, team ID and app password together"
    NOTARY_ARGS=(--apple-id "$NOTARY_APPLE_ID" --team-id "$NOTARY_TEAM_ID" --password "$NOTARY_PASSWORD")
fi
CAN_NOTARIZE=0
if [ -n "$SIGN_IDENTITY" ]; then
    case "$SIGN_IDENTITY" in 'Developer ID Application:'*) ;; *) die "Use a Developer ID Application signing identity" ;; esac
    security find-identity -v -p codesigning | grep -F "\"$SIGN_IDENTITY\"" >/dev/null || die "Developer ID identity is unavailable or invalid"
    if [ "${#NOTARY_ARGS[@]}" -gt 0 ]; then
        CAN_NOTARIZE=1
        xcrun notarytool history "${NOTARY_ARGS[@]}" --output-format json > "$WORK/notary-history.json"
    fi
elif [ "${#NOTARY_ARGS[@]}" -gt 0 ]; then
    die "Notarization credentials require DEVELOPER_ID_APPLICATION"
fi
[ "${REQUIRE_NOTARIZATION:-$RELEASE_BUILD}" != 1 ] || [ "$CAN_NOTARIZE" = 1 ] || die "This release requires signing and complete notarization credentials"
EXPECTED_COMMIT="$(git rev-parse --short HEAD)"
if [ "$RELEASE_BUILD" = 1 ]; then
    [ -n "${MARKETING_VERSION:-}" ] || die "RELEASE_BUILD requires MARKETING_VERSION"
    [ -n "${CURRENT_PROJECT_VERSION:-}" ] || die "RELEASE_BUILD requires CURRENT_PROJECT_VERSION"
    [ -z "$(git status --porcelain)" ] || die "Release packaging requires a clean checkout"
    node scripts/release.mjs check "$MARKETING_VERSION"
    [ "$(git rev-parse "refs/tags/v$MARKETING_VERSION^{commit}")" = "$(git rev-parse HEAD)" ] || die "Release packaging must build the exact version tag"
    [ -z "${TOKEN_HORIZON_NO_GATEWAY:-}${TOKEN_HORIZON_NO_TH_ENGINE:-}" ] || die "A release must include both sidecars"
    command -v go >/dev/null || die "Go is required for release packaging"
    [ -x "${CARGO:-$HOME/.cargo/bin/cargo}" ] || die "Cargo is required for the bundled TH Engine"
fi
submit() {
    local artifact="$1" result="$WORK/notary-result.json"
    printf 'Notarizing %s\n' "$(basename "$artifact")"
    xcrun notarytool submit "$artifact" "${NOTARY_ARGS[@]}" --wait --output-format json > "$result"
    python3 - "$result" <<'PY'
import json, sys
with open(sys.argv[1]) as f: result = json.load(f)
if result.get('status') != 'Accepted':
    raise SystemExit('Apple did not accept notarization: ' + str(result.get('status', 'unknown')))
print('Notarization accepted: ' + str(result.get('id', '')))
PY
}
build_env=(SKIP_INSTALL=1 SKIP_LAUNCH=1)
[ -n "$SIGN_IDENTITY" ] && build_env+=(SIGN_IDENTITY="$SIGN_IDENTITY")
[ -n "${MARKETING_VERSION:-}" ] && build_env+=(MARKETING_VERSION="$MARKETING_VERSION")
[ -n "${CURRENT_PROJECT_VERSION:-}" ] && build_env+=(CURRENT_PROJECT_VERSION="$CURRENT_PROJECT_VERSION")
env "${build_env[@]}" ./scripts/make-app.sh
[ -d "$APP" ] || die "$APP was not produced"
VERSION="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")"
node scripts/release.mjs compare "$VERSION" "$VERSION" >/dev/null
if [ "$RELEASE_BUILD" = 1 ]; then
    [ "$VERSION" = "$MARKETING_VERSION" ] || die "App version does not match the release"
    [ "$(plutil -extract CFBundleVersion raw "$APP/Contents/Info.plist")" = "$CURRENT_PROJECT_VERSION" ] || die "App build counter does not match the release"
    [ "$(plutil -extract THGitSHA raw "$APP/Contents/Info.plist")" = "$EXPECTED_COMMIT" ] || die "App commit stamp is dirty or differs from release source"
    [ -z "$(git status --porcelain)" ] || die "The build modified tracked source files"
    [ -x "$APP/Contents/Resources/token-horizon-gateway" ] || die "Gateway sidecar is missing"
    [ -x "$APP/Contents/Resources/th-engine" ] || die "TH Engine sidecar is missing"
    [ -x "$APP/Contents/PlugIns/TokenHorizonWidget.appex/Contents/MacOS/TokenHorizonWidget" ] || die "Widget extension is missing"
    WIDGET_INFO="$APP/Contents/PlugIns/TokenHorizonWidget.appex/Contents/Info.plist"
    [ "$(plutil -extract CFBundleShortVersionString raw "$WIDGET_INFO")" = "$VERSION" ] || die "Widget version does not match the release"
    [ "$(plutil -extract CFBundleVersion raw "$WIDGET_INFO")" = "$CURRENT_PROJECT_VERSION" ] || die "Widget build counter does not match the release"
fi
codesign --verify --deep --strict --verbose=2 "$APP"
if [ -n "$SIGN_IDENTITY" ]; then
    SIGNED_TEAM=""
    for target in "$APP/Contents/Resources/token-horizon-gateway" "$APP/Contents/Resources/th-engine" "$APP/Contents/PlugIns/TokenHorizonWidget.appex" "$APP/Contents/MacOS/TokenHorizon" "$APP"; do
        [ -e "$target" ] || die "Signed bundle component is missing: $target"
        codesign --verify --strict --verbose=2 "$target"
        metadata="$(codesign -dv --verbose=4 "$target" 2>&1)"
        printf '%s\n' "$metadata" | grep -F 'Authority=Developer ID Application:' >/dev/null || die "Component is not Developer ID signed: $target"
        printf '%s\n' "$metadata" | grep -F '(runtime)' >/dev/null || die "Component lacks hardened runtime: $target"
        printf '%s\n' "$metadata" | grep '^Timestamp=' >/dev/null || die "Component lacks secure timestamp: $target"
        team="$(printf '%s\n' "$metadata" | sed -n 's/^TeamIdentifier=//p')"
        [ -n "$team" ] && [ "$team" != 'not set' ] || die "Component lacks signing team: $target"
        [ -n "$SIGNED_TEAM" ] || SIGNED_TEAM="$team"
        [ "$team" = "$SIGNED_TEAM" ] || die "Nested signing team differs: $target"
    done
fi
if [ "$CAN_NOTARIZE" = 1 ]; then
    ditto -c -k --keepParent "$APP" "$WORK/${APP_NAME}.zip"
    submit "$WORK/${APP_NAME}.zip"
    xcrun stapler staple "$APP"
    xcrun stapler validate "$APP"
    spctl --assess --type execute --verbose=2 "$APP"
fi
# Never erase OUTPUT_DIR or overwrite an existing version's artifacts.
mkdir -p "$WORK/output" "$WORK/dmg" "$OUTPUT_DIR"
ZIP="${APP_NAME}-${VERSION}.zip"
DMG="${APP_NAME}-${VERSION}.dmg"
SUM="${APP_NAME}-${VERSION}.sha256"
for artifact in "$ZIP" "$DMG" "$SUM"; do
    [ ! -e "$OUTPUT_DIR/$artifact" ] || die "Output already exists: $OUTPUT_DIR/$artifact"
done
ditto -c -k --keepParent "$APP" "$WORK/output/$ZIP"
ditto "$APP" "$WORK/dmg/$APP"
ln -s /Applications "$WORK/dmg/Applications"
hdiutil create -volname "Token Horizon ${VERSION}" -srcfolder "$WORK/dmg" -format UDZO "$WORK/output/$DMG" >/dev/null
if [ "$CAN_NOTARIZE" = 1 ]; then
    submit "$WORK/output/$DMG"
    xcrun stapler staple "$WORK/output/$DMG"
    xcrun stapler validate "$WORK/output/$DMG"
fi
# Verify the final archives and both installable bundles before exposing output.
ditto -x -k "$WORK/output/$ZIP" "$WORK/unzipped"
codesign --verify --deep --strict --verbose=2 "$WORK/unzipped/$APP"
MOUNT="$WORK/mounted"
mkdir "$MOUNT"
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$WORK/output/$DMG" >/dev/null
[ -d "$MOUNT/$APP" ] || die "DMG is missing the app"
for bundle in "$WORK/unzipped/$APP" "$MOUNT/$APP"; do
    codesign --verify --deep --strict --verbose=2 "$bundle"
    [ "$(plutil -extract CFBundleShortVersionString raw "$bundle/Contents/Info.plist")" = "$VERSION" ] || die "Packaged app version differs"
    [ "$(plutil -extract CFBundleVersion raw "$bundle/Contents/Info.plist")" = "$(plutil -extract CFBundleVersion raw "$APP/Contents/Info.plist")" ] || die "Packaged app build counter differs"
    [ "$(plutil -extract THGitSHA raw "$bundle/Contents/Info.plist")" = "$(plutil -extract THGitSHA raw "$APP/Contents/Info.plist")" ] || die "Packaged source stamp differs"
    [ "$(plutil -extract THBuiltAt raw "$bundle/Contents/Info.plist")" = "$(plutil -extract THBuiltAt raw "$APP/Contents/Info.plist")" ] || die "Packaged build time differs"
    if [ "$CAN_NOTARIZE" = 1 ]; then xcrun stapler validate "$bundle"; spctl --assess --type execute --verbose=2 "$bundle"; fi
done
hdiutil detach "$MOUNT" >/dev/null
MOUNT=""
(cd "$WORK/output" && shasum -a 256 "$ZIP" "$DMG" > "$SUM" && shasum -a 256 -c "$SUM")
for artifact in "$ZIP" "$DMG" "$SUM"; do [ -s "$WORK/output/$artifact" ] || die "Missing or empty artifact: $artifact"; done
for artifact in "$ZIP" "$DMG" "$SUM"; do mv "$WORK/output/$artifact" "$OUTPUT_DIR/"; done
STATUS_LABEL='ad-hoc, not notarized'
if [ "$CAN_NOTARIZE" = 1 ]; then STATUS_LABEL='Developer ID signed, notarized and stapled';
elif [ -n "$SIGN_IDENTITY" ]; then STATUS_LABEL='Developer ID signed, not notarized'; fi
printf 'Created %s and %s (%s); verified %s\n' "$OUTPUT_DIR/$ZIP" "$OUTPUT_DIR/$DMG" "$STATUS_LABEL" "$OUTPUT_DIR/$SUM"
