// Cloud identity client: talks to the Go server (TH_SYNC_URL target).
// Session token lives in localStorage; login is a browser dance bridged
// back with claim tickets (open provider URL → approve → app polls claim).
// All methods throw on transport/HTTP errors; callers own the UI state.

const BASE_KEY = 'token-horizon.cloud';
const TOKEN_KEY = 'token-horizon.cloud-token';

export const DEFAULT_CLOUD_BASE = 'http://127.0.0.1:8080';

export function cloudBase(): string {
	try {
		return (localStorage.getItem(BASE_KEY) || DEFAULT_CLOUD_BASE).replace(/\/$/, '');
	} catch {
		return DEFAULT_CLOUD_BASE;
	}
}

export function setCloudBase(url: string | null) {
	try {
		if (url) localStorage.setItem(BASE_KEY, url);
		else localStorage.removeItem(BASE_KEY);
	} catch {
		/* ignore */
	}
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
	tokens: number;
	cost: number;
	requests: number;
	machines: number;
	delta_pct?: number;
	streak_days?: number;
}

export interface Board {
	period: string;
	team?: string;
	entries: BoardEntry[];
}

async function req<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
	const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
	const token = cloudToken();
	if (token) headers['Authorization'] = `Bearer ${token}`;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(`${cloudBase()}${path}`, { ...init, headers, signal: ctrl.signal });
		if (res.status === 401) {
			setCloudToken(null);
			throw new Error('signed out — please sign in again');
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
	board: (team: string, period: string) =>
		req<Board>(`/v1/leaderboard?team=${encodeURIComponent(team)}&period=${period}`),
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
