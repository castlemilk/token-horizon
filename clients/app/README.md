# Token Horizon desktop

The Electron desktop app runs on Linux and Windows with the portable Go core bundled in the installer. It opens a desktop dashboard for AI usage, costs, provider limits, and system activity. No separate daemon installation or Go runtime is needed on the destination machine.

| Platform | Architecture | Package                        |
| -------- | ------------ | ------------------------------ |
| Linux    | x64, arm64   | AppImage and Debian `.deb`     |
| Windows  | x64          | Per-user NSIS `.exe` installer |

The `Desktop Linux and Windows` GitHub Actions workflow builds installers on native Linux x64/arm64 and Windows x64 runners. It installs the Debian package or per-user NSIS installer, then smoke-tests the installed desktop app and AppImage launcher. Review artifacts contain installers, SHA-256 checksums, and the daemon build manifest. The macOS release workflow calls this pipeline for the same version tag; after all native checks pass, it attaches the desktop installers and versioned checksums to the existing full release. Manual dispatch can backfill a mutable release with `release_tag` and `publish: true`; the default only creates review artifacts. Automatic updates are not configured. Windows installers are currently unsigned.

## Install and run

Choose your operating system and package on the [website download section](https://token-horizon.dev/#install). It links directly to the latest published installer for that target. If a target has not been published yet, use a successful review artifact for your OS and architecture from the workflow run, then extract its ZIP.

For Linux AppImage, make the file executable and launch it:

```sh
chmod +x TokenHorizon-0.3.12-linux-x86_64.AppImage
./TokenHorizon-0.3.12-linux-x86_64.AppImage
```

AppImage requires a desktop session, FUSE 2 support, and Chromium user-namespace sandbox support. On Ubuntu 24.04, install `libfuse2t64` if it is missing. On desktops that restrict user namespaces, use the `.deb` package: its installer also configures the bundled AppArmor profile and sandbox helper.

```sh
sudo apt install ./TokenHorizon-0.3.12-linux-amd64.deb
token-horizon
```

Use the `arm64` artifacts on ARM Linux machines. For Windows, run `TokenHorizon-0.3.12-windows-x64-setup.exe`, choose the install folder, then open **Token Horizon** from the Start menu or desktop shortcut. Installation is per user and does not require administrator access.

The app starts its bundled core on `127.0.0.1:8765`. If a compatible core already serves that port, it attaches to that core. Closing the app stops only the core it started; an independently running service remains available. An unrelated listener on port 8765 produces a startup error. The dashboard connection indicator and `GET /health` expose the running core version and build stamp.

The Go core keeps data in `~/.config/token-horizon/` on Linux and `%USERPROFILE%\.config\token-horizon\` on Windows. `XDG_CONFIG_HOME` changes the config parent; `TH_CONFIG_DIR` selects an explicit directory. Desktop window preferences use Electron's separate user-data directory.

## Usage capture setup

A fresh installation starts in **point** capture mode. It records requests routed through consented local meters. Until a meter is configured, the activity view can be empty. Provider file scanning requires a separate opt-in.

Quit Token Horizon before editing configuration. Use the config directory above and preserve any existing keys when updating these files. Restart the app after changes.

To capture OpenAI-compatible requests through the OpenAI meter, set these fields in `settings.json`:

```json
{
  "captureMethodology": "point",
  "meterToggles": { "openai": true }
}
```

Grant only the meter scope in `consents.json`:

```json
{
  "metering": { "granted": true, "version": 1 }
}
```

Set the client or SDK's OpenAI base URL to `http://127.0.0.1:9242/v1`. Keep its normal provider credentials in the client. Only traffic sent through that meter is counted. Other supported providers have their own deterministic meter ports; the running core exposes them at `GET /meters`.

To count supported local provider session files instead, set `captureMethodology` to `files` in `settings.json` and grant the file scope in `consents.json`:

```json
{
  "fileReading": { "granted": true, "version": 1 }
}
```

Files mode uses provider-reported usage in discovered local CLI histories and does not start request meters. Only providers installed on that machine contribute history. This portable dashboard does not include the native macOS notch or WidgetKit extension. The Workflows and Infra tabs require the optional workflow service on port 8766; its absence does not prevent usage and limits from loading.

## Develop

Install Node.js 24+, Go matching `daemons/go/go.mod`, and Git. From this directory:

```sh
npm ci
npm run dev
```

Development builds the daemon for the host OS and architecture, then starts Electron with hot reload. The generated executable lives in `resources/daemon/`; it is ignored by Git. `TOKEN_HORIZON_DAEMON_BIN` can point to a development core executable.

For browser-only UI work, `npm run dev:web` starts Vite and `npm run build:web` emits the browser bundle. Browser mode expects a separately running core on port 8765.

## Build installers

Build on the target OS. The packaging script builds the Go core with `CGO_ENABLED=0`, stamps the desktop version, Git commit, and UTC build time, then builds Electron. It validates the daemon executable architecture and SHA-256 in the actual packaged resources before generating installers.

```sh
# Linux x64 or arm64, selected explicitly
npm run build:linux -- --arch x64
npm run build:linux -- --arch arm64

# Windows x64, on Windows
npm run build:win

# Unpacked app for the native host
npm run build:unpack
```

Output is under `dist/`. The shipped core is outside ASAR at `resources/daemon/token-horizon-daemon` on Linux and `resources/daemon/token-horizon-daemon.exe` on Windows. Do not package multiple architectures concurrently in one checkout: each build replaces the generated daemon with its target binary.

`MARKETING_VERSION` overrides the package version for both installer metadata and the daemon's health stamp. Keep the package version and lockfile root version aligned with the native app version when preparing a future release. The existing macOS Swift app continues to use `scripts/make-app.sh`; `npm run build:mac` is available for Electron development packaging.

## Verify

```sh
npm run typecheck
npm run test:desktop
npm run build:unpack
npm run smoke:desktop
node scripts/checksums.mjs
```

The smoke test runs on native Linux or Windows, requires port 8765 to be free, and launches the desktop executable with temporary configuration. It defaults to the unpacked build directory; pass `-- --directory` to check an installed app instead. CI installs the `.deb` with `apt` and the NSIS installer silently for the current user, then verifies the installed core build, rendered dashboard, preload bridge, API connection, and shutdown of the owned core. On a headless Linux runner use `xvfb-run -a npm run smoke:desktop -- --directory '/opt/Token Horizon'`. Generate checksums after building installers; an unpacked-only build has no installers to hash.

Source areas: `app/` contains the React dashboard, `lib/main/` owns desktop lifecycle and daemon supervision, `conveyor/` defines typed IPC, `scripts/` handles portable packaging and smoke tests, and `../../daemons/go/` implements the cross-platform core.
