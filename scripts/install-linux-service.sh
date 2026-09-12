#!/usr/bin/env bash
# install-linux-service.sh — install token-horizon-headless as a systemd USER
# service so usage logging starts at boot without the desktop app.
#
# For a GUI session the Tauri tray app (launch-at-login) is enough; this unit
# is for headless servers and "log even before I log in" machines. Combine
# with `loginctl enable-linger $USER` to run without any login session.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found — this installer is for systemd-based Linux" >&2
  exit 1
fi

"$ROOT/scripts/build-sidecar.sh" release

echo "[service] installing binary to ~/.local/bin"
mkdir -p "$HOME/.local/bin"
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
cp "$ROOT/ui/src-tauri/binaries/token-horizon-headless-$TRIPLE" "$HOME/.local/bin/token-horizon-headless"

echo "[service] installing systemd user unit"
mkdir -p "$HOME/.config/systemd/user"
cp "$ROOT/scripts/token-horizon-headless.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now token-horizon-headless.service

echo "[service] running: systemctl --user status token-horizon-headless"
echo "[service] tip: 'loginctl enable-linger $USER' starts it at boot before login"
