# Install & distribution

Two components ship together: the **desktop app** (Tauri shell + UI) and the
**daemon** (`token-horizon-headless`, the loopback API on `:8765`).
Starting the app starts the daemon — there is nothing else to configure.

## Zero-config path (recommended)

1. Install the app bundle for your OS (below).
2. Launch it. If nothing serves `:8765`, the app spawns its embedded
   daemon sidecar automatically and hides to the tray on close (logging
   continues). Quit from the tray menu to stop everything.
3. The app enables launch-at-login on first run, so logging survives reboots.

No accounts, no ports, no config files. Overrides exist but are optional:

| Env | Meaning |
|---|---|
| `TH_MACHINE_ALIAS` | display name for this machine |
| `TH_SYNC_URL` (+`_HANDLE`, `_TEAM`) | push usage to the Go cloud server |
| `TH_CONSENT=metering\|all` | headless consent grants |
| `TH_FILE_POLL=1` / `TH_CONSOLIDATE=1` | file attribution polling / one-off backfill |

## Packages

No local builds, no app stores — every `v*` tag compiles in CI
(`release-desktop.yml`: Swift sidecar + Tauri shell per OS) and ships to
GitHub releases, then onward to package managers:

- **macOS (Apple Silicon)**: `brew install --cask castlemilk/tap/token-horizon`
  (.dmg under the hood; first launch starts the embedded daemon, quit from
  the tray to stop everything).
- **Windows**: `choco install token-horizon`, or `winget install
  castlemilk.token-horizon` (.msi under the hood).
- **Linux**: `.deb` (`sudo apt install ./token-horizon_*.deb`), `.rpm`
  (`sudo dnf install ./token-horizon-*.rpm`), or AppImage (`chmod +x`, run)
  from the same release page. Build locally only if you must:
  `./build_scripts/tauri/build-linux.sh` (needs the `libwebkit2gtk-4.1-dev`
  family or the rootless sysroot — see `docs/dev-environment-linux.md`).

macOS also keeps its native notch app (`.dmg`/`.zip` from the `release`
workflow); the Tauri shell above is the cross-platform UI. Intel Macs are
not covered by CI bundles — the runners are Apple Silicon only.

## Daemon without the app (servers)

The daemon runs standalone — same binary the app embeds:

```bash
# systemd user service (writes its own unit — the single writer;
# rerun after updating the binary):
./scripts/install-linux-service.sh
# or manually:
token-horizon-headless --install-service   # --service-status / --uninstall-service
```

macOS uses a LaunchAgent through the same `--install-service` flags
(surfaced in the UI service toggle).

## Troubleshooting

- **App shows offline**: something else holds `:8765`, or the sidecar is
  missing (dev only — run `scripts/build-sidecar.sh`). The footer tooltip
  prints the exact failure.
- **Two daemons fight over `:8765`**: the second one takes `:8766`; the UI
  follows automatically and heals stale saved ports on its own.
- **Stale daemon after rebuild**: release installs copy the binary (e.g.
  `~/.local/bin`) — rerun the installer after updating.
- **Logs**: Tauri app logs via the log plugin; headless writes to stderr
  (systemd: `journalctl --user -u token-horizon-headless`).
