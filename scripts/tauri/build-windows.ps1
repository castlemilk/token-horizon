# build-windows.ps1 — release Tauri bundle for Windows (.msi/.nsis under
# ui/src-tauri/target/release/bundle/).
#
# Sidecar caveat: token-horizon-headless does not build on Windows yet (the
# target is `#if !os(Windows)`), so there is no daemon sidecar to stage. The
# shell then expects a reachable daemon — run one on the same machine via WSL
# or on another host, and point the UI at it (TH_API=http://host:8765). If a
# sidecar built elsewhere is present under ui/src-tauri/binaries/ it is picked
# up automatically by externalBin.
#
# Prerequisites: node, cargo (rustup, MSVC toolchain), WebView2 (present on
# Windows 11 / most Windows 10), Visual Studio C++ build tools.
#
# Customer-ready output needs Authenticode signing (unsigned installers get
# SmartScreen warnings). Post-build, every .msi/.exe under bundle/ is signed
# with signtool when a certificate is available:
#   WINDOWS_SIGNING_THUMBPRINT   SHA-1 thumbprint of a cert in the user/machine
#                                store (signtool /sha1). Requires the Windows
#                                SDK (signtool.exe on PATH).
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts/tauri/build-windows.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$Sidecar = Get-ChildItem "$Root/ui/src-tauri/binaries/token-horizon-headless-*.exe" -ErrorAction SilentlyContinue
if (-not $Sidecar) {
    Write-Warning "no daemon sidecar staged (expected on Windows) — the shell will need a remote daemon (TH_API=http://host:8765)"
}

Push-Location "$Root/ui"
try {
    if (-not (Test-Path "node_modules/@sveltejs")) { npm install }
    Write-Host "[tauri:windows] building bundle"
    npm run tauri build
} finally {
    Pop-Location
}

$Thumbprint = $env:WINDOWS_SIGNING_THUMBPRINT
$Signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($Thumbprint -and $Signtool) {
    Write-Host "[tauri:windows] signing installers (thumbprint $Thumbprint)"
    Get-ChildItem "$Root/ui/src-tauri/target/release/bundle" -Recurse -Include *.msi, *.exe |
        ForEach-Object {
            & signtool.exe sign /sha1 $Thumbprint /tr http://timestamp.digicert.com /td sha256 /fd sha256 $_.FullName
            if ($LASTEXITCODE -ne 0) { throw "signtool failed on $($_.FullName)" }
            & signtool.exe verify /pa $_.FullName
            if ($LASTEXITCODE -ne 0) { throw "signtool verify failed on $($_.FullName)" }
        }
} else {
    Write-Warning "unsigned output — SmartScreen will warn customers (set WINDOWS_SIGNING_THUMBPRINT; signtool.exe must be on PATH)"
}

Write-Host "[tauri:windows] bundles are in $Root/ui/src-tauri/target/release/bundle/"
