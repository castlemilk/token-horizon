// Cloud identity client: talks to the Go server (TH_SYNC_URL target).
// Session token lives in localStorage; login is a browser dance bridged
// back with claim tickets (open provider URL → approve → app polls claim).
// All methods throw on transport/HTTP errors; callers own the UI state.

// The cloud server URL is an app-level constant — VITE_CLOUD_URL in the
// SvelteKit app's .env (see ui/.env.example) — never a per-user setting.
const TOKEN_KEY = 'token-horizon.cloud-token';

export const DEFAULT_CLOUD_BASE = 'http://127.0.0.1:8080';

export function cloudBase(): string {
	return ((import.meta.env.VITE_CLOUD_URL as string | undefined) || DEFAULT_CLOUD_BASE).replace(
		/\/$/,
		''
	);
}

export function cloudToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

export function setCloudToken(token: string | null) {
	try {
		if (token) localStorage.setItem(TOKEN_KEY, token);
		else localStorage.removeItem(TOKEN_KEY);
	} catch {
		/* ignore */
	}
}

export interface CloudUser {
	id: string;
	handle: string;
	display_name: string;
	team: string;
	email?: string;
	avatar_url?: string;
}

export interface Team {
	id: string;
	slug: string;
	name: string;
	join_code?: string;
	role?: string;
	members?: number;
	created_at: string;
}

export interface Group {
	id: string;
	team_id: string;
	slug: string;
	name: string;
	join_code?: string;
	role?: string;
	members?: number;
	created_at: string;
}

export interface BoardEntry {
	rank: number;
	handle: string;
	display_name: string;
	avatar_url: string;
	/** ISO 3166 alpha-2 — rendered as a flag emoji; empty until the
	 *  server-side IP→country mapping lands. */
	country_code?: string;
	/** Every team/group the user belongs to (membership is N:M). */
	groups?: string[];
	tokens: number;
	cost: number;
	requests: number;
	machines: number;
	/** Absolute gain on the ranked metric vs the previous equal window. */
	delta?: number;
	delta_pct?: number;
	/** First activity inside this window (no previous-window usage). */
	new?: boolean;
	streak_days?: number;
}

export interface Board {
	window: string;
	category: string;
	team?: string;
	entries: BoardEntry[];
	/** Top climbers by absolute gain vs the previous window (top 5). */
	rising?: BoardEntry[];
}

/** Another user's shared activity (for /@handle when it isn't local).
 *  SERVER PENDING: no such route exists yet — callers must treat any
 *  failure as "not shared" and fall back to the local empty state. */
export interface SharedDay {
	day: string;
	ts: number;
	tokens: number;
}

export interface SharedProvider {
	vendor: string;
	tokens: number;
	requests: number;
}

export interface SharedProfile {
	handle: string;
	display_name?: string;
	avatar_url?: string;
	days: SharedDay[];
	providers: SharedProvider[];
	/** Trailing-24h tokens as reported by the sharer (day feeds can't
	 *  answer this; falls back to the last day when absent). */
	tokens_24h?: number;
	/** Newest event timestamp (epoch seconds) — drives "last activity". */
	last_event_at?: number;
}

async function req<T>(
	path: string,
	init?: RequestInit,
	timeoutMs = 15000,
	opts?: { public?: boolean }
): Promise<T> {
	const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
	// Public routes (the rankings) never carry credentials — a stale session
	// must not fail or sign out a page that everyone can view.
	const token = opts?.public ? null : cloudToken();
	if (token) headers['Authorization'] = `Bearer ${token}`;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(`${cloudBase()}${path}`, { ...init, headers, signal: ctrl.signal });
		if (res.status === 401) {
			if (!opts?.public) {
				setCloudToken(null);
				throw new Error('signed out — please sign in again');
			}
			throw new Error('HTTP 401');
		}
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			let msg = `HTTP ${res.status}`;
			try {
				const j = JSON.parse(body) as { error?: string };
				if (j.error) msg = j.error;
			} catch {
				/* keep status */
			}
			throw new Error(msg);
		}
		return (await res.json()) as T;
	} finally {
		clearTimeout(t);
	}
}

/** Open a URL in the system browser (Tauri opener) or a popup (web). */
export async function openExternal(url: string): Promise<void> {
	try {
		const mod = await import('@tauri-apps/plugin-opener');
		await mod.openUrl(url);
		return;
	} catch {
		/* not in Tauri — popup fallback */
	}
	const popup = window.open(url, 'th-login', 'width=520,height=640,menubar=no,toolbar=no');
	if (!popup) throw new Error('popup blocked — allow popups to sign in');
}

/**
 * Sign in with a provider: fetch the login URL, open it externally, then
 * poll the claim ticket until the browser dance completes (or timeout).
 * onState lets the UI show "waiting in browser…".
 */
export async function signIn(
	provider: 'google' | 'microsoft',
	onState?: (s: 'opening' | 'waiting') => void,
	timeoutMs = 120000
): Promise<{ token: string; user: CloudUser }> {
	const login = await req<{ url: string; state: string }>(`/v1/auth/${provider}/login`);
	onState?.('opening');
	await openExternal(login.url);
	onState?.('waiting');
	const start = Date.now();
	for (;;) {
		if (Date.now() - start > timeoutMs) throw new Error('sign-in timed out — try again');
		await new Promise((r) => setTimeout(r, 2000));
		const res = await fetch(`${cloudBase()}/v1/auth/claim`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ state: login.state })
		});
		if (res.status === 202) continue; // browser dance still open
		if (res.status === 410) throw new Error('sign-in expired or already claimed — try again');
		if (!res.ok) throw new Error(`claim: HTTP ${res.status}`);
		const claimed = (await res.json()) as { token: string; user: CloudUser };
		setCloudToken(claimed.token);
		return claimed;
	}
}

export const cloud = {
	me: () => req<CloudUser>('/v1/users/me'),
	logout: () =>
		req<{ ok: boolean }>('/v1/auth/logout', { method: 'POST' }).finally(() => setCloudToken(null)),
	updateAccount: (patch: { display_name?: string; handle?: string }) =>
		req<CloudUser>('/v1/users/me', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch)
		}),
	uploadAvatar: async (blob: Blob): Promise<CloudUser> => {
		const form = new FormData();
		form.append('avatar', blob, 'avatar.webp');
		const headers: Record<string, string> = {};
		const token = cloudToken();
		if (token) headers['Authorization'] = `Bearer ${token}`;
		const res = await fetch(`${cloudBase()}/v1/users/me/avatar`, {
			method: 'POST',
			headers,
			body: form
		});
		if (res.status === 401) {
			setCloudToken(null);
			throw new Error('signed out — please sign in again');
		}
		if (!res.ok) throw new Error(`avatar upload: HTTP ${res.status}`);
		return (await res.json()) as CloudUser;
	},
	avatarURL: (u: Pick<CloudUser, 'avatar_url'> | null | undefined): string | null => {
		if (!u?.avatar_url) return null;
		if (/^https?:\/\//.test(u.avatar_url)) return u.avatar_url;
		return `${cloudBase()}${u.avatar_url}`;
	},
	teams: () => req<{ teams: Team[] }>('/v1/teams'),
	createTeam: (name: string) =>
		req<Team>('/v1/teams', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		}),
	joinTeam: (code: string) =>
		req<Team>('/v1/teams/join', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code })
		}),
	leaveTeam: (id: string) => req<{ ok: boolean }>(`/v1/teams/${id}/leave`, { method: 'POST' }),
	groups: (teamID: string) => req<{ groups: Group[] }>(`/v1/teams/${teamID}/groups`),
	board: (window: string, category: string, team: string) =>
		req<Board>(
			`/v1/leaderboard?window=${window}&category=${category}&team=${encodeURIComponent(team)}`,
			undefined,
			15000,
			{ public: true }
		),
	sharedProfile: (handle: string) =>
		req<SharedProfile>(`/v1/users/${encodeURIComponent(handle)}/activity`),
	createGroup: (teamID: string, name: string) =>
		req<Group>(`/v1/teams/${teamID}/groups`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		}),
	joinGroup: (code: string) =>
		req<Group>('/v1/groups/join', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code })
		}),
	leaveGroup: (id: string) => req<{ ok: boolean }>(`/v1/groups/${id}/leave`, { method: 'POST' })
};
