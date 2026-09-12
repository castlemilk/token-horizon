# Tauri release builds

One script per platform; run each on the matching OS (no cross-compilation —
use CI runners or a machine per platform). Every script stages the daemon
sidecar first (`scripts/build-sidecar.sh release`, into
`ui/src-tauri/binaries/` where `externalBin` expects it), installs UI deps if
missing, then runs `npm run tauri build`.

| Platform | Script | Output |
|---|---|---|
| Linux | `build-linux.sh` | `ui/src-tauri/target/release/bundle/` (deb, AppImage, rpm) |
| macOS | `build-macos.sh` | same path (`.app`, `.dmg`) |
| Windows | `build-windows.ps1` | same path (`.msi`, nsis `.exe`) |

Per-platform notes:

- **Linux**: needs the webkit2gtk-4.1 / libsoup-3 / javascriptcoregtk-4.1 /
  dbus dev packages, either from apt or the rootless sysroot in
  `~/toolchains` (sourced automatically when the PATH Swift toolchain is
  missing or broken — see `docs/dev-environment-linux.md`).
- **macOS**: the native app (`scripts/make-app.sh`,
  `scripts/package-notarized.sh`) is the primary product; this builds the
  cross-platform Tauri shell for parity.
- **Windows**: `token-horizon-headless` is `#if !os(Windows)`, so no sidecar
  is staged — the shell expects a reachable daemon (`TH_API=http://host:8765`,
  e.g. WSL or a LAN host).

For the dev loop (backend + hot-reload UI) use `scripts/run-dev.sh` instead.

## Customer readiness

**Daemon auto-start.** The daemon must run as the logged-in user (it reads
per-user credentials), so registration is user-scoped and lives in the daemon
itself (`Platform/DaemonAutoStart.swift`):

- Linux: `systemd --user` unit + best-effort `loginctl enable-linger`
  (boot-before-login); XDG `~/.config/autostart` fallback on non-systemd
- macOS: LaunchAgent in `~/Library/LaunchAgents` (at login, KeepAlive)
- Windows: unsupported — the headless target is `#if !os(Windows)`

Triggers, all equivalent (`GET /service` reports status):

```bash
token-horizon-headless --install-service     # or --uninstall-service / --service-status
curl -XPOST localhost:8765/service/install   # or the Settings → "Daemon starts with the machine" toggle
```

Installers cannot register it for you: Tauri's `.deb` has no maintainer
scripts, AppImage has no install hooks, and both would run as root (wrong
user context anyway). Registration is deliberately in-app / CLI.

**Signing (unsigned output is blocked/warned on customer machines):**

- macOS: set `APPLE_SIGNING_IDENTITY` (Developer ID Application) — Tauri
  signs the app and sidecar during bundling — and `NOTARYTOOL_PROFILE` to
  notarize + staple the DMG. Same conventions as `scripts/package-notarized.sh`.
- Windows: set `WINDOWS_SIGNING_THUMBPRINT` — the script post-signs every
  `.msi`/`.exe` with signtool + timestamping and verifies the signature.
- Linux: no signing requirement.
