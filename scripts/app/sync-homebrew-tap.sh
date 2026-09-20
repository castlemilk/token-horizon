#!/usr/bin/env bash
# Publishes packaging/homebrew/token-horizon.rb into the castlemilk/homebrew-tap
# repo (tap name: castlemilk/tap). Run after bumping the cask version+sha256
# for a release; see packaging/homebrew/token-horizon.rb for the header notes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CASK="${ROOT}/packaging/homebrew/token-horizon.rb"
TAP_REPO="${TAP_REPO:-git@github.com:castlemilk/homebrew-tap.git}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --depth 1 "$TAP_REPO" "$WORK/tap"
mkdir -p "$WORK/tap/Casks"
cp "$CASK" "$WORK/tap/Casks/token-horizon.rb"

VERSION="$(awk '/^  version /{gsub(/"/,"",$2); print $2; exit}' "$CASK")"
if git -C "$WORK/tap" diff --quiet -- Casks/token-horizon.rb; then
  echo "tap already current (token-horizon ${VERSION})"
  exit 0
fi

# Reuse this repo's commit identity (falls back to the last commit's author;
# this machine has no global git identity set).
AUTHOR_NAME="$(git -C "$ROOT" config user.name || true)"
AUTHOR_EMAIL="$(git -C "$ROOT" config user.email || true)"
[[ -n "$AUTHOR_NAME" ]] || AUTHOR_NAME="$(git -C "$ROOT" log -1 --format='%an')"
[[ -n "$AUTHOR_EMAIL" ]] || AUTHOR_EMAIL="$(git -C "$ROOT" log -1 --format='%ae')"

git -C "$WORK/tap" add Casks/token-horizon.rb
git -C "$WORK/tap" -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" \
  commit -m "token-horizon ${VERSION}" >/dev/null
git -C "$WORK/tap" push -u origin HEAD
echo "published token-horizon ${VERSION} to castlemilk/homebrew-tap"
