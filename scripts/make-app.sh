#!/bin/bash
# Canonical build+install+launch for Token Horizon.
#
# There is exactly one Token Horizon: this script builds it, stamps it with
# the git commit + UTC time, installs it to /Applications (the copy users
# actually launch — a stale copy there caused real "missing data" scares),
# relaunches it, and health-gates on the SERVING build reporting our stamp.
# Never launch the app by hand or from Xcode without this script unless you
# enjoy debugging two instances with divergent data.
set -euo pipefail
cd "$(dirname "$0")/.."

MACOS=clients/macos
APP=TokenHorizon.app
INSTALLED=/Applications/TokenHorizon.app
BIN=$MACOS/.build/arm64-apple-macosx/release/TokenHorizon
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "dirty")
# Read the whole status under pipefail; an early grep exit can SIGPIPE git
# in a busy checkout and incorrectly stamp a modified build as clean.
if git status --short 2>/dev/null | grep . >/dev/null; then GIT_SHA="${GIT_SHA}-dirty"; fi
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Release pipeline overrides: version from the tag, Developer ID identity for
# hardened-runtime signing (notarization requires it). Unset = dev defaults.
VERSION="${MARKETING_VERSION:-0.4.0}"
BUILD_NUMBER="${CURRENT_PROJECT_VERSION:-8}"
SIGN_IDENTITY="${SIGN_IDENTITY:-}"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
    echo "FATAL: MARKETING_VERSION must be a canonical stable X.Y.Z version"
    exit 1
}
[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] || {
    echo "FATAL: CURRENT_PROJECT_VERSION must be a positive build number"
    exit 1
}

# Never run this script via sudo: it cannot bypass macOS App Management
# (TCC) protection on /Applications, and a root build leaves root-owned
# files in .build/ + TokenHorizon.app that break the next normal build.
if [ "$(id -u)" -eq 0 ] && [ -z "${SKIP_INSTALL:-}" ]; then
    CONSOLE_USER=$(stat -f%Su /dev/console 2>/dev/null || echo "$USER")
    echo "FATAL: do not run make-app.sh with sudo."
    echo "  sudo does not bypass TCC — grant your terminal 'App Management'"
    echo "  (System Settings → Privacy & Security → App Management) instead."
    echo "  First repair the root-owned build artifacts this run created:"
    echo "    sudo chown -R ${CONSOLE_USER}:staff clients/macos/.build TokenHorizon.app"
    echo "  Then re-run WITHOUT sudo:  ./scripts/make-app.sh"
    exit 1
fi

if [ -n "${INSTALL_RELEASE_APP:-}" ]; then
    # Install an authenticated release download without rebuilding or changing
    # its signatures. Its archive stamp remains the serving health target.
    RELEASE_STATUS="$(git status --porcelain)"
    [ -z "$RELEASE_STATUS" ] || { echo "FATAL: release installation requires a clean source checkout"; exit 1; }
    node scripts/release.mjs check "$VERSION"
    RELEASE_TAG_COMMIT="$(git rev-parse --verify "refs/tags/v$VERSION^{commit}")" || { echo "FATAL: release installation requires the exact v$VERSION tag"; exit 1; }
    [ "$RELEASE_TAG_COMMIT" = "$(git rev-parse HEAD)" ] || { echo "FATAL: release installation source must be at v$VERSION"; exit 1; }
    RELEASE_INFO="$(python3 - "$INSTALL_RELEASE_APP" "$VERSION" "$GIT_SHA" "$INSTALLED" <<'PY'
import json, os, pathlib, plistlib, re, sys

def reject(message):
    raise SystemExit('FATAL: ' + message)

requested = pathlib.Path(os.path.abspath(sys.argv[1]))
if requested.is_symlink() or not requested.is_dir():
    reject('INSTALL_RELEASE_APP must be an existing app directory, not a symlink')
source = requested.resolve(strict=True)
installed = pathlib.Path(sys.argv[4]).resolve()
if source == installed or installed in source.parents:
    reject('The release source must be outside the installed app')
if '\n' in str(source) or '\r' in str(source):
    reject('The release source path must not contain line breaks')

def inside(relative):
    path = source / relative
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(source)
    except (OSError, ValueError, RuntimeError):
        reject('Missing or external bundle component: ' + relative)
    return resolved

def plist(relative):
    try:
        with inside(relative).open('rb') as handle:
            return plistlib.load(handle)
    except (OSError, ValueError, plistlib.InvalidFileException):
        reject('Invalid bundle metadata: ' + relative)

info = plist('Contents/Info.plist')
expected = {'CFBundleIdentifier': 'local.benebsworth.token-horizon',
            'CFBundleExecutable': 'TokenHorizon', 'CFBundlePackageType': 'APPL',
            'CFBundleShortVersionString': sys.argv[2], 'THGitSHA': sys.argv[3]}
for key, value in expected.items():
    if info.get(key) != value:
        reject('Release bundle ' + key + ' differs from this source checkout')
built_at, build_number = info.get('THBuiltAt'), info.get('CFBundleVersion')
if not isinstance(built_at, str) or not built_at.strip():
    reject('Release bundle lacks its build time')
if not isinstance(build_number, str) or not re.fullmatch(r'[1-9][0-9]*', build_number):
    reject('Release bundle lacks a positive build counter')
widget = plist('Contents/PlugIns/TokenHorizonWidget.appex/Contents/Info.plist')
if widget.get('CFBundleShortVersionString') != sys.argv[2] or widget.get('CFBundleVersion') != build_number:
    reject('Release widget version or build counter differs from the app')
for executable in ['Contents/MacOS/TokenHorizon',
                   'Contents/Resources/token-horizon-gateway', 'Contents/Resources/th-engine',
                   'Contents/PlugIns/TokenHorizonWidget.appex/Contents/MacOS/TokenHorizonWidget']:
    path = inside(executable)
    if not path.is_file() or not os.access(path, os.X_OK):
        reject('Release bundle executable is missing: ' + executable)
print(json.dumps({'app': str(source), 'built_at': built_at, 'build_number': build_number}))
PY
    )"
    APP="$(printf '%s' "$RELEASE_INFO" | python3 -c 'import json,sys; print(json.load(sys.stdin)["app"])')"
    BUILT_AT="$(printf '%s' "$RELEASE_INFO" | python3 -c 'import json,sys; print(json.load(sys.stdin)["built_at"])')"
    BUILD_NUMBER="$(printf '%s' "$RELEASE_INFO" | python3 -c 'import json,sys; print(json.load(sys.stdin)["build_number"])')"
    codesign --verify --deep --strict --verbose=2 "$APP"
    spctl --assess --type execute --verbose=2 "$APP"
    xcrun stapler validate "$APP"
    echo "verified notarized release v${VERSION} build ${BUILD_NUMBER} (${GIT_SHA}, ${BUILT_AT})"
else
(cd "$MACOS" && swift build -c release)

# Gateway sidecar (portable Go binary, supervised by the app at runtime).
# The app ALWAYS ships with its proxy: a missing sidecar fails the build.
# TOKEN_HORIZON_NO_GATEWAY=1 opts out explicitly (dev machines without Go);
# releases must never set it.
if [ -z "${TOKEN_HORIZON_NO_GATEWAY:-}" ]; then
    command -v go >/dev/null 2>&1 || { echo "FATAL: go toolchain missing — the app must ship with its gateway proxy (or set TOKEN_HORIZON_NO_GATEWAY=1 to opt out explicitly)"; exit 1; }
    (cd gateway && go build -ldflags "-X main.buildCommit=${GIT_SHA} -X main.buildAt=${BUILT_AT}" -o token-horizon-gateway .)
    [ -x gateway/token-horizon-gateway ] || { echo "FATAL: gateway sidecar build produced no binary"; exit 1; }
    # macOS kills quarantined Mach-O binaries missing LC_UUID (dyld: "missing
    # LC_UUID load command" then SIGABRT) — a real release shipped a dead
    # sidecar because an old Go internal linker omits it. gate the toolchain.
    # Consume otool's entire output: grep -q exits early and can SIGPIPE
    # otool under pipefail, falsely rejecting a binary that has LC_UUID.
    if command -v otool >/dev/null 2>&1 && ! otool -l gateway/token-horizon-gateway | grep LC_UUID >/dev/null; then
        echo "FATAL: gateway sidecar lacks LC_UUID (Go toolchain too old for Mach-O LC_UUID emission; need the version pinned in gateway/go.mod)"
        exit 1
    fi
else
    echo "WARN: TOKEN_HORIZON_NO_GATEWAY=1 — building WITHOUT the gateway proxy (gateway routes will 503)"
fi

# th-engine sidecar (Rust/candle local inference, supervised on :8001).
# Optional: TOKEN_HORIZON_NO_TH_ENGINE=1 skips it (dev machines without
# Rust); when built it MUST have LC_UUID like the gateway.
if [ -z "${TOKEN_HORIZON_NO_TH_ENGINE:-}" ]; then
    CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"
    if [ -x "$CARGO" ]; then
        (cd engine && "$CARGO" build --release) || { echo "FATAL: th-engine build failed"; exit 1; }
        [ -x engine/target/release/th-engine ] || { echo "FATAL: th-engine build produced no binary"; exit 1; }
        if command -v otool >/dev/null 2>&1 && ! otool -l engine/target/release/th-engine | grep LC_UUID >/dev/null; then
            echo "FATAL: th-engine lacks LC_UUID"
            exit 1
        fi
    else
        echo "WARN: cargo not found — building WITHOUT th-engine (ENGINE tab's TH Engine backend unavailable)"
    fi
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/TokenHorizon"; cp "$MACOS/Resources/benchmarks.json" "$APP/Contents/Resources/" 2>/dev/null
cp "$MACOS/Resources/plans.json" "$APP/Contents/Resources/" 2>/dev/null
if [ -f gateway/token-horizon-gateway ]; then
    cp gateway/token-horizon-gateway "$APP/Contents/Resources/"
fi
if [ -f engine/target/release/th-engine ]; then
    cp engine/target/release/th-engine "$APP/Contents/Resources/"
fi
# Bundle verification: the sidecar must be inside unless explicitly opted out.
if [ -z "${TOKEN_HORIZON_NO_GATEWAY:-}" ]; then
    [ -x "$APP/Contents/Resources/token-horizon-gateway" ] || { echo "FATAL: gateway sidecar missing from app bundle"; exit 1; }
fi

if [ -f "$MACOS/Resources/AppIcon.icns" ]; then
    cp "$MACOS/Resources/AppIcon.icns" "$APP/Contents/Resources/"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>TokenHorizon</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleIdentifier</key><string>local.benebsworth.token-horizon</string>
    <key>CFBundleName</key><string>Token Horizon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
    <key>CFBundleURLTypes</key><array><dict>
        <key>CFBundleURLName</key><string>Token Horizon Dashboard</string>
        <key>CFBundleURLSchemes</key><array><string>tokenhorizon</string></array>
    </dict></array>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>THGitSHA</key><string>${GIT_SHA}</string>
    <key>THBuiltAt</key><string>${BUILT_AT}</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" SIGN_IDENTITY="$SIGN_IDENTITY" bash scripts/make-widget.sh "$APP"

if [ -n "$SIGN_IDENTITY" ]; then
    # Inside-out Developer ID signing: nested binaries first, then the bundle,
    # with hardened runtime + secure timestamp (required for notarization).
    if [ -f "$APP/Contents/Resources/token-horizon-gateway" ]; then
        codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP/Contents/Resources/token-horizon-gateway"
    fi
    if [ -f "$APP/Contents/Resources/th-engine" ]; then
        codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP/Contents/Resources/th-engine"
    fi
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP/Contents/MacOS/TokenHorizon"
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
    codesign --verify --deep --strict --verbose=2 "$APP"
    echo "signed with ${SIGN_IDENTITY}"
else
    codesign --force --sign - "$APP"
fi
fi

# BEGIN verified release installation (exercised by test-install-release.mjs)
install_release_app() (
    local source="$1" destination="$2" parent backup work prepared previous
    local previous_moved=0 current_moved=0 committed=0 recovery_failed=0
    parent="$(dirname "$destination")"
    backup="${destination%.app}.backup.app"
    for existing in "$destination" "$backup"; do
        if [ -L "$existing" ] || { [ -e "$existing" ] && [ ! -d "$existing" ]; }; then
            echo "FATAL: release destination and backup must be app directories, not symlinks: $existing" >&2
            return 1
        fi
    done
    work="$(mktemp -d "$parent/.TokenHorizon-install.XXXXXX")" || return 1
    prepared="$work/TokenHorizon.app"
    previous="$work/previous.app"
    # Called indirectly by the EXIT trap.
    # shellcheck disable=SC2329
    cleanup_release_install() {
        local status=$?
        trap - EXIT INT TERM
        if [ "$committed" != 1 ]; then
            if [ "$current_moved" = 1 ]; then
                if [ -e "$destination" ] || [ -L "$destination" ]; then
                    mv "$destination" "$work/failed.app" || recovery_failed=1
                fi
                if [ "$recovery_failed" = 0 ] && mv "$backup" "$destination"; then
                    current_moved=0
                else
                    recovery_failed=1
                fi
            fi
            if [ "$previous_moved" = 1 ]; then
                if [ "$current_moved" = 0 ] && mv "$previous" "$backup"; then
                    previous_moved=0
                else
                    recovery_failed=1
                fi
            fi
        fi
        if [ "$recovery_failed" = 1 ]; then
            echo "FATAL: release replacement recovery needs attention. Preserved copies: $backup and $work" >&2
            status=1
        else
            rm -rf "$work"
        fi
        exit "$status"
    }
    trap cleanup_release_install EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    # Copy into an empty directory: an overlay would retain removed resources
    # from the old app and could invalidate the notarized resource seal.
    ditto "$source" "$prepared" || return 1
    codesign --verify --deep --strict --verbose=2 "$prepared" || return 1
    spctl --assess --type execute --verbose=2 "$prepared" || return 1
    xcrun stapler validate "$prepared" || return 1
    if pgrep -x TokenHorizon >/dev/null; then
        pkill -x TokenHorizon || true
        sleep 0.5
    fi
    if [ -d "$backup" ]; then
        mv "$backup" "$previous" || return 1
        previous_moved=1
    fi
    if [ -d "$destination" ]; then
        mv "$destination" "$backup" || return 1
        current_moved=1
    fi
    mv "$prepared" "$destination" || return 1
    committed=1
    if [ "$current_moved" = 1 ]; then
        echo "previous app retained at $backup"
    elif [ "$previous_moved" = 1 ]; then
        # With no installed app, retain the existing recovery copy.
        mv "$previous" "$backup" || { recovery_failed=1; return 1; }
    fi
)
# END verified release installation

if [ -z "${INSTALL_RELEASE_APP:-}" ] && [ -z "${SKIP_INSTALL:-}" ] && pgrep -x TokenHorizon >/dev/null; then
    pkill -x TokenHorizon || true
    sleep 0.5
fi
# Single canonical install: sync the fresh build over /Applications so a
# manual launch there can never serve stale code again. SKIP_INSTALL=1
# (release packaging) builds the bundle in place without touching /Applications.
if [ -z "${SKIP_INSTALL:-}" ]; then
    if [ -n "${INSTALL_RELEASE_APP:-}" ]; then
        install_release_app "$APP" "$INSTALLED" || exit 1
    elif ! ditto "$APP" "$INSTALLED" 2>/dev/null; then
        echo "direct write to $INSTALLED blocked by macOS App Management (TCC);"
        echo "trying Finder-assisted replacement (approve the Finder prompt if shown)…"
        if [ -d "$INSTALLED" ] && osascript -e 'tell application "Finder" to delete POSIX file "'"$INSTALLED"'"' >/dev/null 2>&1; then
            if ! ditto "$APP" "$INSTALLED"; then
                echo "FATAL: ditto still failed after Finder moved the old bundle to Trash."
                echo "  The previous app is in the Trash — drag it back to /Applications to recover."
                exit 1
            fi
        else
            echo "FATAL: could not write $INSTALLED (macOS App Management / TCC)."
            echo "  sudo does NOT bypass this. Either:"
            echo "    System Settings → Privacy & Security → App Management → enable your terminal"
            echo "  or delete /Applications/TokenHorizon.app in Finder, then re-run ./scripts/make-app.sh"
            exit 1
        fi
    fi
fi
# Supervised launch via the app's own agent manager (portable — needs no repo
# scripts at runtime): ensures the LaunchAgent (crash auto-recovery + snapshotted
# env) and (re)starts the app through launchd. TOKEN_HORIZON_* and auth env
# overrides are baked into the agent plist by the installer.
# SKIP_LAUNCH=1 (CI): build + install only, no launch, no health gate.
if [ -z "${SKIP_LAUNCH:-}" ] && [ -z "${SKIP_INSTALL:-}" ]; then
"$INSTALLED/Contents/MacOS/TokenHorizon" --install-launch-agent

# Health gate: the SERVING instance must report our stamp, or fail loudly.
# A green build that isn't what's on :8765 is exactly the confusion we ended.
for _ in $(seq 1 30); do
    HEALTH=$(curl -s -m 2 localhost:8765/health 2>/dev/null || true)
    if printf '%s' "$HEALTH" | python3 -c '
import json, sys
try:
    build = json.load(sys.stdin).get("build", {})
    expected = {"commit": sys.argv[1], "built_at": sys.argv[2], "version": sys.argv[3]}
    sys.exit(0 if all(build.get(key) == value for key, value in expected.items()) else 1)
except (ValueError, AttributeError):
    sys.exit(1)
' "$GIT_SHA" "$BUILT_AT" "$VERSION"; then
        echo "verified serving build ${GIT_SHA} (${BUILT_AT})"
        if [ -n "${TOKEN_HORIZON_NO_GATEWAY:-}" ]; then
            echo "TOKEN_HORIZON_NO_GATEWAY=1: skipping gateway gate"
            exit 0
        fi
        # Gateway gate: the app must ship with its proxy available. The
        # supervisor needs a moment after launch to attach/spawn the sidecar.
        for _ in $(seq 1 20); do
            GW_PORT=$(curl -s -m 2 localhost:8765/health 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('llm_gateway_port') or '')" 2>/dev/null || true)
            if [ -n "$GW_PORT" ]; then
                echo "verified gateway sidecar on :$GW_PORT"
                exit 0
            fi
            sleep 1
        done
        echo "FATAL: serving build ${GIT_SHA} has no gateway sidecar (llm_gateway_port null after 20s). Check ~/Library/Logs/token-horizon-gateway.log"
        exit 1
    fi
    sleep 1
done
echo "FATAL: :8765 is not serving v${VERSION} build ${GIT_SHA} (${BUILT_AT}) after 30s. Health said:"
echo "$HEALTH" | head -c 600; echo
exit 1
fi
if [ -n "${SKIP_INSTALL:-}" ]; then
    if [ -n "${INSTALL_RELEASE_APP:-}" ]; then
        echo "SKIP_INSTALL=1: verified release $APP (not installed to $INSTALLED)"
    else
        echo "SKIP_INSTALL=1: built $APP in place (not installed to $INSTALLED)"
    fi
else
    echo "SKIP_LAUNCH=1: installed to $INSTALLED without launching"
fi
