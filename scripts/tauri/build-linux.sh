#!/usr/bin/env bash
# build-linux.sh — release Tauri bundle for Linux (deb/AppImage/rpm under
# ui/src-tauri/target/release/bundle/). Stages the daemon sidecar first so the
# shell ships with an embedded backend.
#
# Prerequisites (either/or):
#   system:  sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev \
#              libjavascriptcoregtk-4.1-dev libdbus-1-dev libayatana-appindicator3-dev
#   rootless: ~/toolchains/sysroot (set up by this machine's setup; env.sh
#             points pkg-config at it — sourced automatically below)
# plus: node (nvm), cargo (rustup), swift (see note below).
#
# Swift note: a swiftly-managed toolchain can answer `swift --version` yet
# fail to run swift-build (missing libxml2.so.2 on Ubuntu 25.10). We probe
# `swift build --version` and fall back to ~/toolchains/env.sh, exactly like
# scripts/dev/run-dev.sh does. See docs/dev-environment-linux.md.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! swift build --version >/dev/null 2>&1 && [ -f "$HOME/toolchains/env.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/toolchains/env.sh"
fi

echo "[tauri:linux] staging daemon sidecar (release)"
"$ROOT/scripts/app/build-sidecar.sh" release

cd "$ROOT/ui"
[ -d node_modules/@sveltejs ] || npm install

echo "[tauri:linux] building bundle"
npm run tauri build

echo "[tauri:linux] bundles are in $ROOT/ui/src-tauri/target/release/bundle/"
