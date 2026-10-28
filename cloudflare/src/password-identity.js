import { boundedText } from './request-body.js';

// Managed account credentials are checked only against this service's Firebase
// project. Provider tokens are short-lived exchange material, never sessions.
export const passwordConfigured = env => Boolean(env.OAUTH_KV && env.FIREBASE_API_KEY);
export class PasswordIdentityError extends Error {
  constructor(denied = false) { super(denied ? 'Sign-in was not accepted.' : 'Account sign-in is temporarily unavailable.'); this.denied = denied; }
}
export async function passwordIdentity(env, email, password) {
  email = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!passwordConfigured(env)) throw new PasswordIdentityError();
  if (!email || email.length > 320 || typeof password !== 'string' || !password || password.length > 1024) throw new PasswordIdentityError(true);
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8000);
  async function post(method, body) {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`, {
      method: 'POST', redirect: 'manual', signal: abort.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = JSON.parse(await boundedText(response, 65536, { timeoutMs: 8000 }));
    if (!response.ok) {
      const denied = ['INVALID_LOGIN_CREDENTIALS', 'INVALID_PASSWORD', 'EMAIL_NOT_FOUND', 'USER_DISABLED', 'INVALID_ID_TOKEN', 'TOKEN_EXPIRED'].includes(data?.error?.message);
      throw new PasswordIdentityError(denied);
    }
    return data;
  }
  try {
    const signed = await post('signInWithPassword', { email, password, returnSecureToken: true });
    // Pending MFA cannot create a session. Do not consume or expose MFA secrets.
    if (typeof signed.idToken !== 'string' || !signed.idToken || typeof signed.localId !== 'string' || !signed.localId || signed.localId.length > 128) throw new PasswordIdentityError(true);
    const lookup = await post('lookup', { idToken: signed.idToken });
    const user = Array.isArray(lookup.users) && lookup.users.length === 1 ? lookup.users[0] : null;
    if (!user || user.localId !== signed.localId || user.emailVerified !== true || user.disabled === true || typeof user.email !== 'string' || user.email.toLowerCase() !== email) throw new PasswordIdentityError(true);
    return { provider: 'firebase', sub: String(user.localId), email, name: String(user.displayName || '').slice(0, 200), picture: '' };
  } catch (error) {
    if (error instanceof PasswordIdentityError) throw error;
    throw new PasswordIdentityError();
  } finally { clearTimeout(timer); }
}
