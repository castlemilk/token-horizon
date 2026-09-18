// Input validation suite: pure, framework-free validators shared by every
// form in the app. Server contracts mirrored 1:1 —
//   usernames: NormalizeHandle + ValidateHandle (server/src/models)
//   endpoints: loopback-with-port vs proper-external split.
// Each validator returns an error string, or null when valid. Empty input
// is neutral (null) — "untouched", never an error.

/** Canonical handle form: trimmed, lowercased, leading @ stripped. */
export function normalizeHandle(raw: string): string {
	return raw.trim().toLowerCase().replace(/^@+/, '');
}

/** Account username: 2–32 chars of lowercase letters, digits, - and _. */
export function validateUsername(raw: string): string | null {
	if (!raw.trim()) return null; // untouched
	const h = normalizeHandle(raw);
	if (h.length < 2 || h.length > 32) return 'Usernames are 2–32 characters';
	if (!/^[a-z0-9_-]+$/.test(h)) return 'Lowercase letters, digits, - and _ only';
	return null;
}

/** Loopback hostnames (v4/v6/localhost). */
export function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase();
	return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);
}

/** Meter upstream endpoint: either a LOCAL address with an explicit port
 *  (http://127.0.0.1:11434) or a proper EXTERNAL URL (a full domain/IP,
 *  optionally with a port — https://api.example.com, http://ollama:11434).
 *  A bare single-label name with no port is neither. */
export function validateEndpoint(raw: string): string | null {
	const t = raw.trim();
	if (!t) return null; // untouched
	let u: URL;
	try {
		u = new URL(t);
	} catch {
		return 'Must be a full http(s) URL';
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Must be a full http(s) URL';
	const host = u.hostname.toLowerCase();
	const hasPort = u.port !== '';
	if (isLoopbackHost(host) && !hasPort)
		return 'Local endpoints need an explicit port — e.g. http://127.0.0.1:11434';
	if (!isLoopbackHost(host) && !hasPort && !host.includes('.'))
		return 'Use a full domain or IP, or add a port — e.g. https://api.example.com';
	return null;
}

/** Meter listen port: digits-only 1–65535. */
export function validatePort(raw: string): string | null {
	const t = raw.trim();
	if (!t) return null; // untouched
	if (!/^\d{1,5}$/.test(t)) return 'Digits only';
	const n = Number(t);
	if (n < 1 || n > 65535) return 'Port must be 1–65535';
	return null;
}
