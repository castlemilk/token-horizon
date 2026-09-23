#!/bin/bash
# Semver release: bump the in-repo version pins, commit, tag vX.Y.Z, push.
# The tag push triggers .github/workflows/release.yml which builds, signs,
# notarizes, publishes the GitHub release (zip + dmg + sha256), updates the
# Homebrew cask sha256, and syncs castlemilk/homebrew-tap.
#
#   ./scripts/release.sh            # next patch (v0.3.5 -> v0.3.6)
#   ./scripts/release.sh minor      # v0.3.5 -> v0.4.0
#   ./scripts/release.sh major      # v0.3.5 -> v1.0.0
#   ./scripts/release.sh 0.4.2      # explicit version
#   ./scripts/release.sh patch --dry-run   # print the plan, change nothing
#
# Also invoked by release.yml for non-tag triggers: a push to main whose
# head commit carries a "[release]" token auto-releases (patch;
# "[release minor]"/"[release major]" upgrade it, "[release X.Y.Z]" pins
# an explicit version), and workflow_dispatch does the same with an
# optional explicit version input.
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="${1:-patch}"
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1
[ "${1:-}" = "--dry-run" ] && { DRY_RUN=1; BUMP="patch"; }

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

# --- resolve next version ----------------------------------------------------
LATEST="$(git tag --list 'v[0-9]*' --sort=-v:refname | head -1)"
LATEST="${LATEST#v}"
[ -z "$LATEST" ] && LATEST="0.0.0"
IFS='.' read -r MA MI PA <<< "$LATEST"
MA="${MA:-0}"; MI="${MI:-0}"; PA="${PA:-0}"

case "$BUMP" in
    patch) PA=$((PA + 1)) ;;
    minor) MI=$((MI + 1)); PA=0 ;;
    major) MA=$((MA + 1)); MI=0; PA=0 ;;
    ''|*[!0-9.]*) die "usage: release.sh [patch|minor|major|X.Y.Z] [--dry-run]" ;;
    *) MA="${BUMP%%.*}"; REST="${BUMP#*.}"; MI="${REST%%.*}"; PA="${REST#*.}"
       case "$REST" in
           *.*) ;;
           *) die "invalid version '$BUMP' (want X.Y.Z)" ;;
       esac
       case "$PA" in *.*) die "invalid version '$BUMP' (want X.Y.Z)" ;; esac
       for part in "$MA" "$MI" "$PA"; do
           case "$part" in ''|*[!0-9]*) die "invalid version '$BUMP' (want X.Y.Z)" ;; esac
       done ;;
esac
NEXT="${MA}.${MI}.${PA}"
TAG="v${NEXT}"

git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null && die "${TAG} already exists"
[ "$NEXT" = "$LATEST" ] && die "computed version ${NEXT} equals latest tag"

# --- show plan ----------------------------------------------------------------
printf 'latest tag : v%s\n' "$LATEST"
printf 'next       : %s\n' "$TAG"
printf 'pins       : make-app.sh VERSION, BuildInfo.swift fallback, cask version\n'
if [ "$DRY_RUN" = 1 ]; then
    printf 'dry run — would commit, tag %s, and push main + tag\n' "$TAG"
    exit 0
fi

# --- guard rails --------------------------------------------------------------
# A dirty tree is allowed (the tag points at the commit, not the worktree) but
# unpushed/uncommitted source changes can surprise — warn loudly, don't block.
if ! git diff --quiet || ! git diff --cached --quiet; then
    printf 'warning: working tree has uncommitted changes; %s will tag HEAD only\n' "$TAG" >&2
fi
git fetch --tags -q origin 2>/dev/null || true
git ls-remote --tags origin "refs/tags/${TAG}" | grep -q . && die "${TAG} already exists on origin"

# --- update the three version pins --------------------------------------------
sed -i '' -E "s/^VERSION=\"\\\$\{MARKETING_VERSION:-[0-9]+\.[0-9]+\.[0-9]+\}\"/VERSION=\"\\\${MARKETING_VERSION:-${NEXT}}\"/" scripts/make-app.sh
sed -i '' -E "s/fallback: \"[0-9]+\.[0-9]+\.[0-9]+\"/fallback: \"${NEXT}\"/" Sources/TokenHorizon/App/BuildInfo.swift
sed -i '' -E "s/^  version \"[0-9]+\.[0-9]+\.[0-9]+\"/  version \"${NEXT}\"/" packaging/homebrew/token-horizon.rb

grep -q "MARKETING_VERSION:-${NEXT}" scripts/make-app.sh || die "make-app.sh pin update failed"
grep -q "fallback: \"${NEXT}\"" Sources/TokenHorizon/App/BuildInfo.swift || die "BuildInfo.swift pin update failed"
grep -q "version \"${NEXT}\"" packaging/homebrew/token-horizon.rb || die "cask pin update failed"

# --- commit, tag, push ---------------------------------------------------------
git add scripts/make-app.sh Sources/TokenHorizon/App/BuildInfo.swift packaging/homebrew/token-horizon.rb
# No [skip ci] here — the tag points at this commit and skip tokens can
# suppress tag-push triggers too. The release workflow's job guard skips
# this push via the 'release v' prefix instead.
git commit -m "release ${TAG}" >/dev/null
git tag -a "$TAG" -m "Token Horizon ${NEXT}"
git push origin HEAD:main
git push origin "$TAG"

cat <<EOF

${TAG} pushed. The release workflow is building now:
  https://github.com/castlemilk/token-horizon/actions/workflows/release.yml
When it finishes:
  - GitHub release  -> install.sh /releases/latest picks it up
  - Homebrew cask   -> sha256 updated + tap synced (when TAP_GITHUB_TOKEN is set)
  - Settings/health -> v${NEXT} stamped via CFBundleShortVersionString
EOF
