import OAuthProvider, { insufficientScope } from '@cloudflare/workers-oauth-provider';
import { boundedText } from './request-body.js';
import site, { verifyGoogleIdToken } from './index.js';
import { handleMcp, ORIGIN, READ, MANAGE } from './connector.js';
import { connectPage, pageHeaders } from './connect-page.js';
import { browserIdentity, identityOwnerId, githubConfigured, sessionsConfigured } from './browser-auth.js';

const SCOPES = [READ, MANAGE, 'offline_access'];
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...headers } });
const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
function validOrigin(request) { return request.headers.get('Origin') === new URL(request.url).origin; }
async function readForm(request) {
  if (!validOrigin(request)) throw new Error('Reload this page to continue securely.');
  if (!(request.headers.get('content-type') || '').startsWith('application/x-www-form-urlencoded')) throw new Error('Invalid request format.');
  const body = await boundedText(request, 16384);
  return new URLSearchParams(body);
}
function resultRedirect(request, location, headers) {
  if (request.headers.get('Accept')?.includes('application/json')) { headers.set('Content-Type', 'application/json'); return new Response(JSON.stringify({ redirect: location }), { headers }); }
  headers.set('Location', location); return new Response(null, { status: 303, headers });
}
const defaultHandler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), oauth = env.OAUTH_PROVIDER;
    try {
      if (url.pathname === '/oauth/authorize') {
        if (!env.GOOGLE_CLIENT_ID && !githubConfigured(env)) return new Response(connectPage({ error: 'Account sign-in is not configured.' }), { status: 503, headers: pageHeaders() });
        if (request.method === 'GET') {
          const auth = await oauth.parseAuthRequest(request);
          if (auth.scope.some(s => !SCOPES.includes(s))) throw new Error('The application requested an unsupported permission.');
          const client = await oauth.lookupClient(auth.clientId);
          const consent = await oauth.beginConsent(auth);
          return new Response(connectPage({ mode: 'authorize', clientId: env.GOOGLE_CLIENT_ID, githubAuth: githubConfigured(env), webSessions: sessionsConfigured(env), handle: consent.handle, clientName: client?.clientName?.slice(0, 80), redirect: new URL(auth.redirectUri).host }), { headers: pageHeaders(consent.headers) });
        }
        if (request.method === 'POST') {
          const form = await readForm(request), handle = form.get('handle');
          if (!handle || handle.length > 200) throw new Error('This connection has expired. Start again from your client.');
          if (form.get('decision') === 'deny') {
            const denied = await oauth.denyConsent(request, handle);
            return resultRedirect(request, denied.headers.get('Location'), denied.headers);
          }
          if (form.get('decision') !== 'allow') throw new Error('Choose whether to connect this account.');
          // Consent still requires the browser-bound transaction and a human
          // Connect submission. A remembered login never grants access itself.
          const credential = form.get('credential');
          const identity = credential ? await verifyGoogleIdToken(credential, env, handle) : await browserIdentity(request, env);
          if (!identity) return json({ error: 'Your sign-in expired or could not be verified. Reload and sign in again.' }, 401);
          const scopes = [...new Set(form.getAll('scope'))];
          if (!scopes.includes(READ) || scopes.some(s => !SCOPES.includes(s))) throw new Error('Invalid permissions.');
          const approved = await oauth.approveConsent(request, handle, { scope: scopes });
          const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: await hash(identityOwnerId(identity)), metadata: {}, scope: scopes, props: { sub: identity.sub, provider: identity.provider || 'google' } });
          return resultRedirect(request, redirectTo, approved.headers);
        }
        return new Response(null, { status: 405, headers: { Allow: 'GET, POST', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' } });
      }
      // A metadata probe need not create a browser-bound management nonce.
      if (url.pathname === '/connect' && request.method === 'HEAD') return new Response(null, { headers: pageHeaders() });
      if (url.pathname === '/connect' && request.method === 'GET') {
        const nonce = crypto.randomUUID(), digest = await hash(nonce);
        await env.OAUTH_KV.put(`management:${digest}`, '1', { expirationTtl: 600 });
        const headers = pageHeaders();
        headers.append('Set-Cookie', `__Host-th-connect=${digest}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`);
        return new Response(connectPage({ clientId: env.GOOGLE_CLIENT_ID, githubAuth: githubConfigured(env), webSessions: sessionsConfigured(env), handle: nonce }), { headers });
      }
      if (url.pathname === '/oauth/connections' && request.method === 'POST') {
        const form = await readForm(request), nonce = form.get('handle') || '';
        const digest = await hash(nonce);
        const bound = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).includes(`__Host-th-connect=${digest}`);
        if (!bound || !await env.OAUTH_KV.get(`management:${digest}`)) return json({ error: 'Reload the page and sign in again.' }, 401);
        const credential = form.get('credential');
        const identity = credential ? await verifyGoogleIdToken(credential, env, nonce) : await browserIdentity(request, env);
        if (!identity) return json({ error: 'Sign in to manage connections.' }, 401);
        const userId = await hash(identityOwnerId(identity));
        if (form.get('action') === 'revoke') {
          const id = form.get('id') || '';
          if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('Invalid connection ID.');
          await oauth.revokeGrant(id, userId);
        } else if (form.get('action') !== 'list') throw new Error('Invalid action.');
        const grants = await oauth.listUserGrants(userId, { limit: 100, ...(form.get('cursor') ? { cursor: form.get('cursor') } : {}) });
        const items = await Promise.all(grants.items.map(async g => ({ id: g.id, name: (await oauth.lookupClient(g.clientId))?.clientName || 'Connected application', scope: g.scope, createdAt: g.createdAt, expiresAt: g.expiresAt, destination: g.redirectUri ? new URL(g.redirectUri).host : '' })));
        return json({ connections: items, cursor: grants.cursor || null, name: identity.name || identity.email });
      }
      return site.fetch(request, env, ctx);
    } catch (error) {
      // Never reflect arbitrary redirect URIs or raw token/storage errors.
      const message = error.name === 'AuthorizationError' ? 'This authorization request is invalid or expired. Start again from your client.' : 'Unable to complete this connection. Reload and try again.';
      if (request.method === 'POST') return json({ error: message }, 400);
      return new Response(connectPage({ error: message }), { status: 400, headers: pageHeaders() });
    }
  }
};
const provider = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: { fetch(request, env, ctx) {
    if (!ctx.auth?.scope?.includes(READ)) return insufficientScope(ctx.auth, [READ]);
    return handleMcp(request, env, ctx, ctx.props, ctx.auth.scope);
  } },
  defaultHandler,
  authorizeEndpoint: '/oauth/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: SCOPES, accessTokenTTL: 3600, refreshTokenTTL: 30 * 86400,
  // No refresh token is issued when the user unchecks “Stay connected”.
  tokenExchangeCallback: ({ scope }) => scope.includes('offline_access') ? undefined : { refreshTokenTTL: 0 },
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: [READ], resource_name: 'Token Horizon' }
});
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.') || url.hostname === 'tokens.benebsworth.com') return site.fetch(request, env, ctx);
    // Auth discovery always refers to the canonical audience; don't mint tokens on aliases.
    if (url.hostname !== 'token-horizon.dev' && !['localhost', '127.0.0.1'].includes(url.hostname) && (url.pathname.startsWith('/oauth/') || url.pathname === '/connect' || url.pathname.startsWith('/.well-known/'))) return Response.redirect(`${ORIGIN}${url.pathname}${url.search}`, 307);
    if (url.pathname === '/mcp/public') {
      const response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await handleMcp(request, env, ctx);
      response.headers.set('Access-Control-Allow-Origin', '*');
      response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, MCP-Protocol-Version');
      return response;
    }
    if (url.pathname === '/mcp' || url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/') || url.pathname === '/connect') return provider.fetch(request, env, ctx);
    return site.fetch(request, env, ctx);
  }
};
