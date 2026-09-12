# Building the Tauri desktop app — field notes

What it actually took to go from a half-migrated `ui/` directory to a running
Tauri + SvelteKit + Swift-sidecar stack on a **sudo-less Ubuntu 25.10** box.
Each entry: symptom → root cause → fix. The reusable artifact is
`~/toolchains/env.sh` (toolchain + sysroot + pkg-config + linker env).

---

## 1. The repo was mid-migration (Electron → SvelteKit/Tauri)

**Symptom:** `package.json` declared Electron + React + Tailwind while `src/`
was a SvelteKit app; `svelte.config.js`, `vite.config.ts`, and
`electron.vite.config.ts` all coexisted; `node_modules` had SvelteKit installed
but the manifest didn't list it.

**Fix:** deleted the template residue (`app/`, `lib/`, `conveyor/`,
`resources/`, `ui/.github/`, Electron configs, stale lockfile) and rewrote
`package.json`/`tsconfig.json` to match reality. Rule: the manifest must
describe the app that exists, not the template it was scaffolded from.

## 2. `svelte.config.js` was silently ignored

**Symptom:** `npm run build` warned "No adapter specified" and produced no
`build/` output — which is what `tauri.conf.json`'s `frontendDist` consumes.

**Root cause:** `vite.config.ts` passed `compilerOptions` to the `sveltekit()`
plugin. **Passing any options there makes SvelteKit ignore `svelte.config.js`
entirely** (it says so only in a one-line warning at `svelte-kit sync`). The
`adapter-static` config lived in `svelte.config.js`, so it never ran.

**Fix:** all options moved to `svelte.config.js`; `vite.config.ts` is now just
`plugins: [sveltekit()]`. Lesson: keep 100% of SvelteKit config in
`svelte.config.js`.

## 3. No Swift toolchain, no sudo

**Symptom:** `swift build` impossible; `sudo` needs an interactive password.

**Fix (rootless toolchain):**
- Swift 6.2.3 **Ubuntu 24.04** tarball → `~/toolchains/swift-6.2.3`
  (swift.org publishes no 25.10 build; the 24.04 build works)
- Missing sonames the 24.04 binaries expect: `libxml2.so.2`, `libicuuc.so.74`
  → downloaded the **noble** runtime `.deb`s and `dpkg-deb -x` into
  `~/toolchains/sysroot`
- Missing dev files for our `CSQLite` shim and FoundationNetworking:
  `libsqlite3-dev`, `libcurl4-openssl-dev` via `apt-get download` (no root
  needed) + extract
- Env: `CPATH` (headers), `LIBRARY_PATH` (link), `LD_LIBRARY_PATH` (runtime)

## 4. The Swift tree didn't compile once a toolchain existed

The last good build predated recent edits. Three genuine errors, all small:
`?? NSNull()` type mismatch in `CoreAPIRouter`, a non-exhaustive switch in
`VendorAuth` (`.profileFiles` added to the enum, not the switch), and an
optional `baseAddress` passed to `memcpy` in `DockerObserver`.

Lesson: without a working toolchain the tree rots invisibly. CI or a buildable
dev box is what keeps "it compiled last week" honest.

## 5. CORS had silently regressed in source

**Symptom:** the running (stale, Sep 10) binary sent
`Access-Control-Allow-Origin: *`, but no source file contained the string.

**Root cause:** the "delete the NWListener LocalServer" refactor dropped CORS
from the new POSIX transport. A fresh build would have broken every webview
client (Tauri, Vite dev) while the stale binary masked it.

**Fix:** CORS at the single transport choke point
(`LocalHTTPServing.swift`): reflect only trusted local origins
(`tauri://localhost`, `tauri.localhost`, `localhost`, `127.0.0.1`, `::1`),
`OPTIONS` preflight, `Vary: Origin`. Deliberately not `*`: a wildcard lets any
website you visit read local usage data cross-origin.

## 6. The cargo/pkg-config wall (the big one)

`cargo check` failed in layers. All fixes landed in `~/toolchains/env.sh`:

| Layer | Symptom | Fix |
|---|---|---|
| dbus | `libdbus-sys` build script panic | `libdbus-1-dev` .deb → sysroot |
| webkit chain | `webkit2gtk-4.1`, `libsoup-3.0`, `javascriptcoregtk-4.1`, `gtk+-3.0` .pc missing | resolved the **88-package dev closure** with `apt-get --download-only --print-uris -y install …` (works without root), extracted all into `~/toolchains/sysroot` |
| pkg-config | .pc files use absolute `/usr` prefixes | `PKG_CONFIG_PATH` + `PKG_CONFIG_SYSROOT_DIR=$SYSROOT` (rewrites `-I`/`-L`) |
| rust-lld | `unable to find library -lsoup-3.0` despite `LIBRARY_PATH` | **rust-lld ignores `LIBRARY_PATH`** → `RUSTFLAGS="-L $SYSROOT/usr/lib/x86_64-linux-gnu"` |
| broken symlinks | `unable to find library -latk-1.0`, `-lgtk-3`, … despite the `-L` | dev-package `.so` symlinks point at runtime `.so.0` files that apt skipped (already installed system-wide) → relinked 89 broken symlinks in the sysroot to `/lib/x86_64-linux-gnu/…` |

That last one was the sneakiest: `dpkg-deb -x` preserves relative symlinks,
so `libgtk-3.so → libgtk-3.so.0` dangled inside the sysroot. Diagnosis:
`cargo build -vv` showed the `-L` was passed correctly, so the library file
itself had to be broken — `find -xtype l` listed the dangling links.

## 7. `externalBin` must exist before cargo finishes

**Symptom:** `resource path 'binaries/token-horizon-headless-<triple>'
doesn't exist` at the `app` crate build.

**Fix:** `scripts/build-sidecar.sh [release|debug]` builds the Swift daemon
and stages it under `ui/src-tauri/binaries/` with the target-triple suffix
Tauri expects. `run-dev.sh` stages a debug sidecar automatically. Not
optional: the build fails without it (by design — the app must be able to
spawn its logging daemon).

## 8. Shell-script pitfalls in `run-dev.sh`

- **`set -e` aborts traps silently.** A `[ -n "$x" ] && echo` or `kill … && …`
  returning 1 as the last command of a function killed the shutdown sweep
  mid-run. Teardown now starts with `set +e`.
- **`pkill -f <name>` matches the invoking shell's own command line** —
  instant self-kill, zero output. Use the bracket trick: `pkill -f "[n]ame"`.
- **Backgrounded scripts can't trap SIGINT** (POSIX: signals ignored on entry
  to a non-interactive shell stay ignored). Interactive Ctrl-C is unaffected;
  for automation use SIGTERM.
- **Killing `npm run dev` doesn't kill vite** (npm → sh → node grandchildren).
  Fixed with a recursive `pgrep -P` descendant sweep before TERM/KILL.

## Remaining caveats

- **Linux tray** needs `libayatana-appindicator3` at runtime (present here via
  the dev chain; on minimal distros install it or the tray icon won't show —
  window still works).
- **Autostart during dev** registers `Exec=target/debug/app --minimized`; a
  packaged install overwrites it with the real path. Toggle lives in Settings.
- **Windows**: tray/autostart/splash all work; the sidecar is a no-op until
  TokenHorizonCore lands a Windows transport (`#if !os(Windows)` stub today).
- **Rootless sysroot is for building, not shipping**: packaged builds should
  use a normal toolchain + system packages on a real build host or CI.
