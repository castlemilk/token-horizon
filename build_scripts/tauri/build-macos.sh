#!/usr/bin/env bash
# build-macos.sh — release Tauri bundle for macOS (.app/.dmg under
# ui/src-tauri/target/release/bundle/). Stages the daemon sidecar first so the
# shell ships with an embedded backend.
#
# NOTE: the native macOS app remains the primary macOS product —
# scripts/make-app.sh (dev/ad-hoc) and scripts/package-notarized.sh
# (Developer ID + notarization). This script builds the cross-platform Tauri
# shell instead, for parity with Linux/Windows.
#
# Prerequisites: Xcode CLT (swift), node, cargo (rustup).
#
# Customer-ready output needs signing + notarization (unsigned apps are
# Gatekeeper-quarantined on customer machines):
#   APPLE_SIGNING_IDENTITY   Developer ID Application identity (or set
#                            DEVELOPER_ID_APPLICATION — same as
#                            scripts/package-notarized.sh). Tauri signs the
#                            .app AND the embedded sidecar during bundling.
#   NOTARYTOOL_PROFILE       keychain profile for xcrun notarytool; when set,
#                            the .dmg is submitted, stapled, and validated.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-${DEVELOPER_ID_APPLICATION:-}}"
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
  security find-identity -v -p codesigning | grep -F "$APPLE_SIGNING_IDENTITY" >/dev/null ||
    { echo "[tauri:macos] ERROR: identity not in login keychain: $APPLE_SIGNING_IDENTITY" >&2; exit 1; }
  export APPLE_SIGNING_IDENTITY
  echo "[tauri:macos] signing with: $APPLE_SIGNING_IDENTITY"
else
  echo "[tauri:macos] WARNING: no APPLE_SIGNING_IDENTITY — output will be unsigned (dev-only; Gatekeeper blocks it on customer machines)" >&2
fi

echo "[tauri:macos] staging daemon sidecar (release)"
"$ROOT/scripts/build-sidecar.sh" release

cd "$ROOT/ui"
[ -d node_modules/@sveltejs ] || npm install

echo "[tauri:macos] building bundle"
npm run tauri build

if [ -n "${NOTARYTOOL_PROFILE:-}" ]; then
  for dmg in "$ROOT"/ui/src-tauri/target/release/bundle/dmg/*.dmg; do
    [ -e "$dmg" ] || continue
    echo "[tauri:macos] notarizing $(basename "$dmg")"
    xcrun notarytool submit "$dmg" --keychain-profile "$NOTARYTOOL_PROFILE" --wait
    xcrun stapler staple "$dmg"
    xcrun stapler validate "$dmg"
  done
else
  echo "[tauri:macos] notarization skipped: set NOTARYTOOL_PROFILE to submit and staple the DMG"
fi

echo "[tauri:macos] bundles are in $ROOT/ui/src-tauri/target/release/bundle/"
