# Linux dev environment — what it takes to get the stack running

Field notes from bringing up `scripts/run-dev.sh` (daemon + Tauri UI) on this
repo's primary Linux dev box: **Ubuntu 25.10, x86_64, VS Code installed as a
snap, Swift via swiftly**. Every issue below is handled by the current
scripts; this documents *why* the handling exists so it isn't "simplified"
away later.

## Symptom-free quickstart

```bash
./scripts/run-dev.sh          # daemon on :8765 + Tauri shell (or vite fallback)
```

If that works, you don't need the rest of this page.

## 1. swiftly's Swift 6.3.3 toolchain is broken on Ubuntu 25.10

- `swift --version` works, but `swift build` dies immediately:
  `swift-build: error while loading shared libraries: libxml2.so.2: cannot
  open shared object file`.
- Ubuntu 25.10 ships `libxml2.so.16`; the swiftly toolchain was built against
  `libxml2.so.2` (Ubuntu 24.04 and earlier).
- **Fix (already on this machine):** a rootless toolchain in `~/toolchains/`:
  Swift 6.2.3 (Ubuntu 24.04 build) plus a `sysroot/` with extracted dev
  packages — `libxml2.so.2`, `libicu74`, and the sqlite3/curl dev headers and
  link symlinks the build needs without sudo. `~/toolchains/env.sh` sets
  `PATH`, `CPATH`, `LIBRARY_PATH`, `LD_LIBRARY_PATH`, `PKG_CONFIG_PATH`/
  `PKG_CONFIG_SYSROOT_DIR` (webkit2gtk etc. for the Tauri build), and
  `RUSTFLAGS` (rust-lld ignores `LIBRARY_PATH`).
- `run-dev.sh` and `build_scripts/tauri/build-linux.sh` probe `swift build
  --version` (not `command -v swift` — the binary *exists*, it just can't
  run) and source `~/toolchains/env.sh` as a fallback. Do not revert that
  check to a plain PATH lookup.

## 2. Stale `.build/` objects poison the link

After switching toolchains (6.3.3 ↔ 6.2.3), linking the daemon failed with
undefined references to `FoundationEssentials.NotificationCenter` symbols —
old object files compiled against the other toolchain's Foundation were being
reused.

**Fix:** `source ~/toolchains/env.sh && swift package clean`, then rebuild.
If you ever see `FoundationEssentials` link errors here, clean first.

## 3. Orphaned Vite dev server holds :5173

A previous session left `vite dev --port 5173 --strictPort` running (parent
shell long gone). Two failures cascaded from it:

1. Tauri's `beforeDevCommand` (`npm run dev`) failed with "Port 5173 is
   already in use", so `tauri dev` exited.
2. The script's vite fallback then hit the *same* occupied port and failed
   too.

**Fix (in `run-dev.sh`):** pre-flight cleanup kills listeners on :5173 and
stale `target/debug/app` processes before starting the frontend, and stops an
existing backend on :8765 before starting a fresh one (`TH_REUSE=1` opts back
into the old reuse behavior). Cleanup kills by port, so it only ever targets
processes squatting on ports the stack needs.

## 4. Dead-child teardown bug (script killed its own healthy stack)

When Tauri died at boot (see #5) and the script fell back to vite, the dead
Tauri PID stayed in the script's `CHILDREN` array. The watch loop — "any
tracked child exits → tear everything down" — then fired on the already-dead
PID and killed the healthy daemon and vite server seconds after they came up.

**Fix (in `run-dev.sh`):** the Tauri-early-exit fallback path now prunes the
dead PID from `CHILDREN` before starting the vite fallback.

## 5. VS Code snap leaks GTK paths; the Tauri shell loads the snap's libpthread

This shell runs inside the **VS Code snap**, whose launcher exports GTK-stack
variables pointing into the snap runtime: `GTK_EXE_PREFIX`, `GTK_PATH`,
`GDK_PIXBUF_MODULE_FILE`, `GDK_PIXBUF_MODULEDIR`, `GTK_IM_MODULE_FILE`,
`GSETTINGS_SCHEMA_DIR`, `GIO_MODULE_DIR`, `LOCPATH`.

Symptom: `target/debug/app` crashed at startup with

```
symbol lookup error: /snap/core20/current/lib/x86_64-linux-gnu/libpthread.so.0:
undefined symbol: __libc_pthread_init, version GLIBC_PRIVATE
```

Confusing because `ldd` shows **no** snap paths — the resolution only happens
at runtime through those env vars, and the snap's core20 libpthread is
incompatible with the host's newer glibc. Reproduced with `env -i` → clean
environment → no symbol error (GTK then fails only because `DISPLAY` was also
stripped, proving the env vars were the cause).

**Fix (in `run-dev.sh`):** the script unsets those eight variables before
launching `npm run tauri dev`, so the app links the system GTK stack. If you
launch the app binary manually from a snap-hosted terminal, unset them
yourself or launch from a non-snap terminal.

## 6. Never run two SwiftPM builds concurrently in this repo

Running `swift test` while `run-dev.sh` was building the daemon (both share
`.build/`) produced mixed objects and the same `FoundationEssentials`
link errors as a toolchain switch — and the dev stack then tore itself down.
SwiftPM does not reliably serialize concurrent invocations against the same
build directory.

**Rule:** one build at a time. If the link errors reappear, `swift package
clean` and rebuild, then check whether another build (dev script, IDE, CI)
was running concurrently.

## Verified end state

- `GET :8765/health` → `{"ok":true,"name":"token-horizon-headless",...}`
- Tauri shell window opens (vite dev server behind it on :5173)
- Ctrl-C on `run-dev.sh` tears down daemon + shell + vite; nothing orphaned
- Re-running `run-dev.sh` over a live stack cleanly restarts it

## Related files

- `scripts/run-dev.sh` — dev stack launcher (all fixes above live here)
- `scripts/build-sidecar.sh` — daemon sidecar staging for the Tauri bundler
- `build_scripts/tauri/` — per-platform release bundle scripts
- `docs/tauri-desktop-build.md` — Tauri build notes
- `docs/cross-platform.md` — Platform seam contract
