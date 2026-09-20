# Cross-Platform Port — Status & Architecture

Branch: `feature/cross-platform-core`

The server side of Token Horizon now lives in **`TokenHorizonCore`**, a portable
Swift module that compiles on macOS and Linux (Windows seams defined, impls TBD).
The macOS app (`TokenHorizon` target) is a UI + platform-backend shell over it.
A new **`token-horizon-headless`** daemon target serves the same loopback API
(127.0.0.1:8765+) with no UI — this is the Linux deliverable until a native UI exists.

## Verified working on Linux (Swift 6.1, Ubuntu)

```
swift build --target TokenHorizonCore          # ✅ builds
swift build --product token-horizon-headless   # ✅ builds
./.build/debug/token-horizon-headless          # ✅ serves the real API
curl localhost:8765/health                     # ✅ {"platform":"Linux",...}
curl localhost:8765/stats                      # ✅ real UsageEngine data (claude/kimi/codex/opencode)
curl localhost:8765/processes                  # ✅ /proc + ps backend
curl localhost:8765/limits                     # ✅ live provider quota fetches
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' | node clients/mcp/token-horizon-mcp.mjs  # ✅
```

Build prerequisites on Linux: Swift 6.x toolchain + sqlite3 dev files
(`apt install libsqlite3-dev`; the `CSQLite` shim maps `import CSQLite` to the
system libsqlite3). OpenTelemetry is **not** required on Linux — the core
compiles a no-op `TokenHorizonTelemetry` there.

## The Platform seam contract

OS-specific behavior goes through `Platform` (in `Platform/CredentialStore.swift`):

| Seam | Protocol | macOS impl | Linux impl | Windows impl |
|---|---|---|---|---|
| `Platform.paths` | `PlatformPathsProviding` | `~/.config/token-horizon` | `$XDG_CONFIG_HOME` | `%APPDATA%` (TBD) |
| `Platform.credentials` | `CredentialStore` | Keychain via `/usr/bin/security` | nil (libsecret TBD) | nil (wincred TBD) |
| `Platform.systemStats` | `SystemStatsProviding` | `SystemStats` (mach/vm64/iostat/ps) | `ProcFSSystemStats` (/proc + ps) | TBD (PDH/Toolhelp) |
| HTTP transport | `LocalHTTPServing` | `POSIXLoopbackHTTPServer` (BSD sockets, all platforms) | same | same |
| Runtime meter routing | `MeterRegistry.routedURL` (+ `OllamaClient.baseURLProvider` override) | auto-meters for all detected runtimes (ollama :11435, vllm :9311, sglang :9312, llamacpp :9313, mlx :9314) | same (generic, consent-gated) | — |

The app assigns backends at launch (`AppDelegate.applicationDidFinishLaunching`);
the headless daemon assigns them in `main.swift`.

## Intentionally unchanged

- All AGENTS.md invariants (hourly buckets, locking, incremental JSONL offsets,
  codex statefulness, engine-as-source-of-truth) — untouched.
- Only macOS UI (`Sources/TokenHorizon/UI/`) and lifecycle live in the app target; the server transport + router are shared core code on every platform.
- The MCP shim still only talks to the loopback API — no changes needed.

## Next steps

1. **Verify macOS app build** on a Mac: `./scripts/app/make-app.sh` (this branch
   restructured targets; access-level or import fixes may be needed).
2. Linux: libsecret `CredentialStore`, per-process disk/net rates in
   `ProcFSSystemStats`, systemd unit + packaging, validate OTel Swift on Linux
   and drop the no-op stub.
3. Windows: `PlatformPaths` is written; needs `CredentialStore` (wincred),
   `SystemStatsProviding` (PDH + Toolhelp32), and a socket impl for
   `LocalHTTPServing` (Winsock) — the POSIX server is `#if !os(Windows)`.
4. UI per platform (tray + popover) or one shared Tauri/Qt shell over :8765.
