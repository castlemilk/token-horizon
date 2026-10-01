# Hosted connector

Production endpoints:

- `/mcp`: Streamable HTTP with OAuth; public discovery tools plus owner-scoped account reads and report-link revocation.
- `/mcp/public`: seven public discovery tools, no credentials, no private tools even if a bearer token is supplied.
- `/connect`: setup, downloadable Codex plugin, Google/GitHub remembered sign-in and grant revocation.
- `/oauth/authorize`: browser-bound consent with a verified remembered session or consent-bound Google nonce verification, explicit read scope, optional management and offline scopes.
- `/oauth/token`, `/oauth/register`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`: official Workers OAuth provider.

`src/worker.js` wraps the existing site worker. Its OAuth and MCP dependencies are pinned; the existing REST API and dashboard catalog search remain unchanged. MCP model tools reuse the app-exported catalog and shared helpers. No provider APIs or raw provider files are parsed.

## Access boundaries

`account:read` reads profiles whose immutable provider subject matches `ownerId`; unclaimed profiles and email-only matches are excluded. Account detail includes published analytics plus private sharing and group settings. `account:manage` permits only report-link revocation, checking both profile and share ownership. Public results recursively strip identity and claim secrets. Other personal management, such as claiming profiles or changing publication preferences, remains in the existing website/app.

Google ID tokens require RS256, expected audience/issuer/expiry, verified email and a consent-specific nonce. They are used only for verification and never persisted. OAuth grant props contain only the subject and provider; KV indexes hash the full provider namespace, preserving existing Google grants. The library provides S256 PKCE, resource binding, hashed credentials, encrypted props, rotating refresh tokens and browser-bound 10-minute consent transactions. Access tokens last one hour. Offline access is optional and fixed at 30 days. The management page requires its own browser-bound transaction and either a verified remembered session or nonce-verified Google login; disconnect revokes the user's grant and tokens. No auth is delegated to the development fallbacks used by older REST tests.

The OAuth library uses Workers KV (eventual consistency). Consent is one-use under sequential requests; concurrent duplicates and revocation propagation inherit KV's consistency limits. Do not describe revocation as globally instantaneous. The production Worker requires `OAUTH_KV`, `LEADERBOARD_BUCKET`, `ASSETS`, and `GOOGLE_CLIENT_ID`. `global_fetch_strictly_public` enables SSRF-safe CIMD discovery. Google JavaScript origins must include the canonical host.

## Verification

Install with `npm ci --prefix cloudflare`, then run `node --test cloudflare/worker.test.mjs cloudflare/connector.test.mjs`. The Node adapter stubs only Workers' unused RPC base class; OAuth, crypto, consent, token exchange and MCP transport use the real libraries. Tests cover ownership, scope separation, Google nonce/audience, browser/origin binding, PKCE, code replay, refresh, public isolation and revocation. Also run Wrangler's dry build and live protocol smoke tests because Node cannot test Workers compatibility flags or actual Google login UI.

The connection screen's 30 fps ASCII/dither effect precomputes its lensed light map; it pauses when hidden, stops on page removal, and is static with reduced motion. `docs/connect.{css,js}` and `docs/black-hole.js` are dependency-free browser assets. Provider credentials remain in memory only; remembered browser sessions use opaque HttpOnly cookies. [Browser sign-in and GitHub setup](AUTH.md) describes cache and account boundaries.

Plugin source is `plugins/token-horizon`; `.agents/plugins/marketplace.json` makes it distributable from this checkout. `docs/downloads/token-horizon-plugin.zip` is the packaged download. Personal installs can be copied to `~/plugins/token-horizon` and registered through the personal marketplace helper.

## Release record — 2026-09-27

The landing, leaderboard and model explorer redesign was deployed as Worker version `4bd18322-3f9d-499c-afd2-41f0554567d8`. The connector release is `8c52a72a-0389-42e8-9114-e75296385184`. All 44 API/OAuth tests and the 19-section dashboard UI suite passed. Both plugin manifests and the companion skill validated; the personal plugin installed as `token-horizon@plugins-cli` version `1.0.0`. The repository marketplace was registered as `personal`.

Wrangler's local dev runner failed with an esbuild `EBADF` on this machine; the dry build succeeded, and deployment initialized successfully in the real Workers runtime. The rendered consent template was inspected at desktop and mobile widths before deployment; live endpoint checks confirmed pages, plugin download, OAuth metadata, a 401 challenge for anonymous private requests, seven public tools, catalog search, dynamic registration and browser-bound consent. The production consent page rendered the Google button with no browser errors. The temporary verification client was removed. Google identity verification was tested with signed fixtures; a real user's consent is completed by that user in their MCP client.
