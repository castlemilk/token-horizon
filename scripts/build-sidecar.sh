#!/usr/bin/env bash
# build-sidecar.sh — build token-horizon-headless and stage it where the
# Tauri bundler expects external binaries:
#   ui/src-tauri/binaries/token-horizon-headless-<target-triple>[.exe]
#
# Usage: scripts/build-sidecar.sh [release|debug]   (default: release)
# Requires: swift toolchain (~/toolchains/env.sh is sourced as a fallback)
# and rustc (only used to resolve the host triple).

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${1:-release}"

if ! command -v swift >/dev/null 2>&1 && [ -f "$HOME/toolchains/env.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/toolchains/env.sh"
fi
command -v swift  >/dev/null 2>&1 || { echo "no swift toolchain on PATH" >&2; exit 1; }
command -v rustc  >/dev/null 2>&1 || { echo "no rustc on PATH (needed for the target triple)" >&2; exit 1; }

TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
SUFFIX=""
case "$TRIPLE" in *windows*) SUFFIX=".exe" ;; esac

echo "[sidecar] building token-horizon-headless ($CONFIG) for $TRIPLE"
cd "$ROOT"
swift build -c "$CONFIG" --product token-horizon-headless
BIN="$(swift build -c "$CONFIG" --product token-horizon-headless --show-bin-path)/token-horizon-headless"

DEST="$ROOT/ui/src-tauri/binaries"
mkdir -p "$DEST"
cp "$BIN" "$DEST/token-horizon-headless-$TRIPLE$SUFFIX"
echo "[sidecar] staged at $DEST/token-horizon-headless-$TRIPLE$SUFFIX"
