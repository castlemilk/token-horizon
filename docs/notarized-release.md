# Notarized Release

Token Horizon keeps its full filesystem, process, shell, and loopback telemetry capabilities in the direct-distribution build. It is not an App Sandbox target and should be distributed as a Developer ID signed and notarized app rather than through the Mac App Store.

## Prerequisites

- An Apple Developer Program membership.
- A `Developer ID Application: ...` certificate installed in the login keychain.
- An App Store Connect/API or Apple ID notarytool keychain profile.
- A final bundle identifier owned by the developer. The script defaults to `com.benebsworth.token-horizon`; override it with `BUNDLE_ID` if needed.

Check the local signing setup:

```bash
security find-identity -v -p codesigning
xcrun notarytool history --keychain-profile token-horizon-notary
```

Store a notarytool profile once, using an app-specific password rather than an account password:

```bash
xcrun notarytool store-credentials token-horizon-notary \
  --apple-id "developer@example.com" \
  --team-id "TEAMID1234" \
  --password "app-specific-password"
```

## Build

For a signed but not-yet-notarized artifact:

```bash
DEVELOPER_ID_APPLICATION="Developer ID Application: Ben Ebsworth (TEAMID1234)" \
./scripts/package-notarized.sh
```

For a signed ZIP and notarized DMG:

```bash
DEVELOPER_ID_APPLICATION="Developer ID Application: Ben Ebsworth (TEAMID1234)" \
NOTARYTOOL_PROFILE=token-horizon-notary \
MARKETING_VERSION=1.0.0 \
CURRENT_PROJECT_VERSION=3 \
./scripts/package-notarized.sh
```

Artifacts are written to `dist/`. The script uses the hardened runtime, verifies the signed app, submits the DMG, staples the ticket, and runs Gatekeeper assessment when a notary profile is provided. The ZIP contains the signed app; the stapled DMG is the notarized distribution artifact.

## Final Checks

```bash
codesign --verify --deep --strict --verbose=2 dist/TokenHorizon.app
xcrun stapler validate dist/TokenHorizon-1.0.0.dmg
hdiutil attach -nobrowse -readonly dist/TokenHorizon-1.0.0.dmg
spctl --assess --type execute "/Volumes/Token Horizon 1.0.0/TokenHorizon.app"
hdiutil detach "/Volumes/Token Horizon 1.0.0"
```

Test the stapled app on a clean macOS user account before release. Confirm that the first-run behavior, shell hook, Ollama proxy, local HTTP API, provider credential reads, and process monitoring still work after Gatekeeper launch.

## Current State

This repository currently has no installed Developer ID signing identity and no notarytool profile. The package script is therefore credential-gated and cannot complete signing or notarization until those are configured locally.
