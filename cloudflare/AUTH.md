# Browser account sign-in

The login page, sign-in modal and connector share one remembered Token Horizon session. Google uses the existing Google Identity Services Web client. GitHub uses a server-side OAuth App authorization-code exchange with S256 PKCE. Both use immutable provider subjects (`google:<sub>` or `github:<numeric id>`); equal email addresses do not link accounts or transfer existing profile ownership.

## Public client contract

- `GET /api/config`: `googleClientId`, `googleAuth`, `githubAuth`, `webSessions`. `githubAuth` is true only when `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `OAUTH_KV` are present. `webSessions` requires KV and at least one configured provider.
- `GET /api/auth/session`: `{ok:true, authenticated, user, expiresAt}`. `user` is null or `{provider, sub, name, email, picture, login?}`; `sub` is the raw provider ID, and `login` is GitHub's display handle. `expiresAt` is an absolute Unix timestamp in **milliseconds**, or null for anonymous visitors.
- `POST /api/auth/google`: JSON `{credential:<GSI ID token>}`. The request must have a same-origin `Origin` header. The Worker verifies signature, issuer, client audience, expiry and verified email, then returns the session result and a secure cookie.
- `POST /api/auth/logout`: same-origin `Origin` required. Revokes this browser session and clears its cookie. Existing explicitly approved MCP grants are separate; disconnect them through the connection manager.
- `GET /api/auth/github?returnTo=/relative/path`: begins the browser-bound flow. `GET /api/auth/github/callback` consumes state, verifies the code with PKCE, fetches the current GitHub user and a verified email, creates a session, and redirects to the saved same-origin path with `auth=success`. Errors use safe `auth_error=expired|cancelled|provider_unavailable` values; no provider code, access token or raw provider response is returned to the frontend.

Every authentication response is `private, no-store`. `/login` is a cacheable anonymous SPA shell; it does not embed visitor identity or forward cookies to the static asset binding. Any client-side remembered avatar/name is only a presentation hint and cannot authorize account actions before server session validation.

## Session boundaries

`__Host-th-session` is random 256-bit opaque data, set with `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`. Only its SHA-256 hash indexes a KV record containing the verified identity and a fixed 30-day expiry. Sign-in rotates and revokes the previous cookie. ID tokens, GitHub access tokens and OAuth App secrets are not retained in the session, HTML, browser storage or API JSON. Logout deletes the hashed session record; revocation across Cloudflare locations inherits KV's eventual consistency.

Cookie-authenticated writes require exact same-origin `Origin`. Existing signed Google token headers used by native clients remain supported. Legacy unsigned development authentication is unchanged when no Google client is configured; it is never used to mint a remembered browser session or approve MCP consent.

GitHub transactions expire after ten minutes and require both the KV state record and the `__Host-th-github-state` HttpOnly cookie. Sequential replay consumes the transaction before provider exchange; duplicate authorization codes are also rejected by GitHub. The provider endpoints and avatar host are fixed. Requests never follow provider redirects, have eight-second deadlines, and enforce bounded response bodies. Consent retains the connector library's separate browser binding and requires an explicit Connect submit even when already signed in.

## GitHub setup

Create a dedicated [GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) with:

- Application name: Token Horizon
- Homepage URL: `https://token-horizon.dev`
- Authorization callback URL: `https://token-horizon.dev/api/auth/github/callback`

From `cloudflare/`, store the client ID and client secret using interactive Wrangler commands so they never enter source control or chat:

```sh
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
```

The callback is derived from the current origin; an optional `GITHUB_REDIRECT_URI` must exactly match that origin's `/api/auth/github/callback` and should normally remain unset. GitHub requires `read:user user:email`, with no repository or organization permissions. The code follows GitHub's [documented authorization and S256 PKCE flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

When these credentials are absent, the public configuration honestly reports `githubAuth:false`, and the start endpoint returns 503 `auth_unavailable`. A production deployment by itself does not create a GitHub OAuth App.

## Verification

Run `node --test cloudflare/browser-auth.test.mjs cloudflare/worker.test.mjs cloudflare/connector.test.mjs`. Browser-auth cases cover expiry, rotation, logout, CSRF, unverified credentials, oversized/stalled data, state/PKCE binding, open redirect rejection, cross-provider ownership separation and the account/team/profile/share APIs. Connector tests use the real OAuth library to verify explicit consent and isolated Google/GitHub grants. Actual Google and GitHub account selection should be completed by the account owner in the live browser.
