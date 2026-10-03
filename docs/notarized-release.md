# Notarized Release

Token Horizon keeps its full filesystem, process, shell, and loopback telemetry capabilities in the direct-distribution build. It is not an App Sandbox target and should be distributed as a Developer ID signed and notarized app rather than through the Mac App Store.

## Prerequisites

- An Apple Developer Program membership.
- A `Developer ID Application: ...` certificate installed in the login keychain.
- An App Store Connect/API or Apple ID notarytool keychain profile.
- The canonical native bundle identifier is `local.benebsworth.token-horizon`; released bundle installation verifies that identifier.

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

Artifacts are written to `dist/`. The script validates credentials before building, checks signatures on the app, widget and both sidecars, notarizes and staples the app, then packages ZIP and DMG. It notarizes and staples the DMG, checks both installable bundles with Gatekeeper, and verifies the SHA-256 manifest before exposing the final files. Existing artifacts are never overwritten and the output directory is never cleared.

Production packaging additionally sets `RELEASE_BUILD=1`. It requires clean, committed source at the exact version tag with all three canonical version pins, both sidecars, a widget, and complete Developer ID/notarization credentials. The resulting app must carry the release version and the exact clean source commit; its widget must match the app version and build counter. CI uses the workflow run number as `CFBundleVersion`.

## Final Checks

```bash
codesign --verify --deep --strict --verbose=2 TokenHorizon.app
xcrun stapler validate dist/TokenHorizon-1.0.0.dmg
hdiutil attach -nobrowse -readonly dist/TokenHorizon-1.0.0.dmg
spctl --assess --type execute "/Volumes/Token Horizon 1.0.0/TokenHorizon.app"
hdiutil detach "/Volumes/Token Horizon 1.0.0"
```

Test the stapled app on a clean macOS user account before release. Confirm that the first-run behavior, shell hook, Ollama proxy, local HTTP API, provider credential reads, and process monitoring still work after Gatekeeper launch.

Install the exact published bundle through the supported launcher after
downloading its ZIP from the trusted GitHub release and verifying the archive
against that release's SHA-256 manifest. Check out its exact version tag with
clean source, extract the verified archive, then run:

```bash
MARKETING_VERSION=1.0.0 \
INSTALL_RELEASE_APP=/absolute/path/to/extracted/TokenHorizon.app \
./scripts/make-app.sh
```

This mode verifies the release's source stamp, native pins, bundle metadata,
widget version and required executables, then checks its existing signature,
Gatekeeper assessment and stapled notarization ticket. It installs and
restarts the original bundle without rebuilding or signing it again. The
serving health check uses the archive's original commit, version and build
time. A source app directory that is a symlink, or an executable link that
leaves the bundle, is rejected before installation.

## Publish pipeline (GitHub Actions)

**Push to `main` releases only when the head commit asks for it** — carry
a token in the commit message: `[release]` for a patch bump,
`[release minor]` / `[release major]` to upgrade it, or `[release X.Y.Z]`
to pin an explicit version. The workflow pins the version, tags `vX.Y.Z`,
builds, signs, notarizes, publishes the GitHub release, and syncs the
Homebrew cask. Pushes without a token (docs, WIP, ordinary fixes — and the
pipeline's own `release v…`/`release metadata…` commits) never release.
Rapid pushes serialize via the workflow's `concurrency` group — each
queued token-bearing push still gets its own release.

Caveat: the token matches anywhere in the commit message, including its
body. Only include it when that commit should ship. Failed packaging can
leave an unreleased tag; use the workflow's `release_tag` input to resume
that exact source. Existing releases, including drafts, are protected from
rebuilding or replacing assets. Inspect a failed draft before deciding how
to recover it; the workflow never silently deletes one.

Recover an unpublished tag by dispatching the corrected workflow from `main`
with `release_tag` set to that original tag. Keep the tag and native source
unchanged. Tag runs restore annotated tag metadata locally and reject a
remote tag whose commit differs from the checked-out source.

The manual path is `task release`, which delegates to the same
`scripts/release.mjs` policy used by GitHub Actions:

```bash
task release              # next patch after latest tag (v0.3.5 → v0.3.6)
task release minor        # v0.3.5 → v0.4.0
task release 1.0.0        # explicit version
task release -- --dry-run # print the plan, change nothing
```

The helper fetches current main and tag history, requires clean committed
source, computes a canonical stable version without leading zeros, and
rejects downgrades or any existing release. It updates only the three native
pins (`make-app.sh` `VERSION`, `BuildInfo.swift` fallback and the cask's
`version`), creates an annotated tag, and atomically pushes main and tag.
Dry runs perform the same checks without writing. Network or authentication
failures stop the operation rather than falling back to stale local tags.

`.github/workflows/release.yml` then runs `scripts/package-notarized.sh` for
the exact tag after validating its pins and clean source. It tests the native
app, gateway, release policy and desktop authentication contracts, provisions Rust for TH Engine, signs and notarizes the app
and DMG, then validates exactly `TokenHorizon-X.Y.Z.zip`, `.dmg` and `.sha256`.
The release remains a draft until all three uploaded assets match the local
sizes and SHA-256 digests. Only then is it published as a full release;
backfills cannot displace a newer full release as latest.

The cask checksum update starts from freshly fetched main and changes only
its checksum when that main still uses this release version. It never pushes
old version pins from the detached tag. Tap updates also reject downgrades.
Production releases fail when signing or notarization credentials are absent
or incomplete. Unsigned development packaging remains available without
`RELEASE_BUILD=1`.

Manual dispatch supports an optional `version` (blank means next patch), an
existing unreleased `release_tag` for recovery, and `desktop_installers`.
The latter defaults off: native Mac releases do not build or publish
Linux/Windows installers unless explicitly requested for that run.

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `APPLE_CERT_P12_BASE64` | Developer ID Application certificate + private key exported as `.p12`, base64 (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERT_PASSWORD` | Password chosen when exporting the `.p12` |
| `KEYCHAIN_PASSWORD` | Any random string; used for the temporary CI keychain |
| `APPLE_API_KEY_BASE64` | App Store Connect API key `.p8`, base64 (preferred notary auth) |
| `APPLE_API_KEY_ID` | API key ID (secret or repo variable) |
| `APPLE_API_ISSUER_ID` | API issuer UUID from App Store Connect → Users and Access → Integrations (secret or repo variable) |
| `TAP_GITHUB_TOKEN` | PAT with `contents: write` on `castlemilk/homebrew-tap` — enables the post-release cask sha256 bump + tap sync (absent: repo cask still updated; run `task brew-sync` manually) |

Apple ID notary fallback (when no API key secret is set): `APPLE_ID`,
`APPLE_TEAM_ID` (repo variable is fine), `APPLE_APP_PASSWORD` (app-specific
password, not the account password).

Export the local certificate for the secret:

```bash
# Select only "Developer ID Application: …" in Keychain Access → My Certificates,
# File → Export Items → .p12, then:
base64 -i DeveloperID.p12 | pbcopy    # paste into APPLE_CERT_P12_BASE64
```

Local signing identities and keychain profiles are machine-specific. Check
them with the prerequisite commands above; CI uses its imported temporary
keychain and removes the certificate, private key and keychain afterward.
