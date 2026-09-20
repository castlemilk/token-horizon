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
./scripts/app/package-notarized.sh
```

For a signed ZIP and notarized DMG:

```bash
DEVELOPER_ID_APPLICATION="Developer ID Application: Ben Ebsworth (TEAMID1234)" \
NOTARYTOOL_PROFILE=token-horizon-notary \
MARKETING_VERSION=1.0.0 \
CURRENT_PROJECT_VERSION=3 \
./scripts/app/package-notarized.sh
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

## Publish pipeline (GitHub Actions)

`.github/workflows/release.yml` runs `scripts/app/package-notarized.sh` for every
`v*` tag: it builds the app (gateway sidecar + build stamps), signs it with the
imported Developer ID certificate, notarizes + staples the app, packages the ZIP
and DMG, then notarizes + staples the DMG and runs a Gatekeeper assessment.
Without the secrets below the workflow still publishes, but warns and produces
an ad-hoc, un-notarized build.

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `APPLE_CERT_P12_BASE64` | Developer ID Application certificate + private key exported as `.p12`, base64 (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERT_PASSWORD` | Password chosen when exporting the `.p12` |
| `KEYCHAIN_PASSWORD` | Any random string; used for the temporary CI keychain |
| `APPLE_API_KEY_BASE64` | App Store Connect API key `.p8`, base64 (preferred notary auth) |
| `APPLE_API_KEY_ID` | API key ID (secret or repo variable) |
| `APPLE_API_ISSUER_ID` | API issuer UUID from App Store Connect → Users and Access → Integrations (secret or repo variable) |

Apple ID notary fallback (when no API key secret is set): `APPLE_ID`,
`APPLE_TEAM_ID` (repo variable is fine), `APPLE_APP_PASSWORD` (app-specific
password, not the account password).

Export the local certificate for the secret:

```bash
# Select only "Developer ID Application: …" in Keychain Access → My Certificates,
# File → Export Items → .p12, then:
base64 -i DeveloperID.p12 | pbcopy    # paste into APPLE_CERT_P12_BASE64
```

## Current State

The Developer ID Application identity
(`Developer ID Application: Ben Ebsworth (WFTX6CN23F)`) and the local
`token-horizon-notary` keychain profile exist, so the local commands above
produce notarized artifacts. CI notarization additionally needs the repository
secrets listed in the pipeline section.
