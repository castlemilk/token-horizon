// Typed client for the Token Horizon loopback API (CoreAPIRouter).
// The same contract is served by the headless daemon and the macOS app.

export const DEFAULT_API_BASE = 'http://127.0.0.1:8765';

function storageGet(key: string): string | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem(key);
	} catch {
		return null; // webview with storage disabled — never brick on it
	}
}

function storageSet(key: string, value: string | null) {
	try {
		if (typeof localStorage === 'undefined') return;
		if (value) localStorage.setItem(key, value);
		else localStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

export function apiBase(): string {
	const override = storageGet('token-horizon.api');
	if (override) return override.replace(/\/$/, '');
	return DEFAULT_API_BASE;
}

export function setApiBase(url: string | null) {
	storageSet('token-horizon.api', url);
}

async function healthy(base: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const res = await fetch(`${base}/health`, { signal: timeoutSignal(timeoutMs) });
		return res.ok;
	} catch {
		return false;
	}
}

/** AbortSignal.timeout with a fallback for engines that lack it. */
export function timeoutSignal(ms: number): AbortSignal | undefined {
	try {
		if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
			return AbortSignal.timeout(ms);
		}
	} catch {
		/* fall through */
	}
	return undefined;
}

/**
 * Find the daemon: probe the loopback port range (8765-8784, the same range
 * the daemon scans and the MITM addon probes). A saved override is
 * health-checked first — a stale override (daemon moved back to :8765 after
 * a drift to :8766, or a dead sidecar port) is cleared instead of trusted,
 * otherwise one bad save bricks the connection forever with no recovery.
 */
export async function discoverApiBase(): Promise<string | null> {
	const override = storageGet('token-horizon.api');
	if (override) {
		const base = override.replace(/\/$/, '');
		if (await healthy(base)) return base;
		storageSet('token-horizon.api', null);
	}
	for (let port = 8765; port <= 8784; port++) {
		const base = `http://127.0.0.1:${port}`;
		try {
			const res = await fetch(`${base}/health`, { signal: timeoutSignal(800) });
			if (res.ok) return base;
		} catch {
			/* nothing on this port */
		}
	}
	return null;
}

async function get<T>(path: string, timeoutMs = 10000): Promise<T> {
	const res = await fetch(`${apiBase()}${path}`, { signal: timeoutSignal(timeoutMs) });
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown, timeoutMs = 15000): Promise<T> {
	const res = await fetch(`${apiBase()}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: timeoutSignal(timeoutMs)
	});
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return (await res.json()) as T;
}

// ---- Types (mirror core DTO JSON) ----

export interface Health {
	ok: boolean;
	name: string;
	platform: string;
	version: string;
	usage_store: boolean;
	machine_id?: string;
	machine_alias?: string;
}

export interface TokenBreakdown {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface UsageSnapshot {
	tokensAllTime: number;
	tokensToday: number;
	costAllTime: number;
	costToday: number;
	breakdownAll: TokenBreakdown;
	breakdownToday: TokenBreakdown;
	updatedAt: number;
}

export interface Stats {
	usage: UsageSnapshot;
	system: {
		cpu_percent: number;
		ram_used_gb: number;
		ram_total_gb: number;
		load_1m: number;
	};
}

export interface RuntimeInfo {
	vendor: string;
	display_name: string;
	running: boolean;
	pids: number[];
	port?: number;
	tok_per_sec?: number;
	prompt_tok_per_sec?: number;
	generation_tokens_total?: number;
	prompt_tokens_total?: number;
	extra?: Record<string, number>;
	sampled_at: number;
	usage: {
		tokens_all: number;
		tokens_today: number;
	};
}

export interface RuntimeHistoryPoint {
	timestamp: number;
	tok_per_sec?: number;
	prompt_tok_per_sec?: number;
	cpu_percent?: number;
	mem_mb?: number;
	loaded_models?: number;
}

export interface UsageEvent {
	id: string;
	timestamp: number;
	vendor: string;
	model: string;
	source: string;
	product?: string;
	machineID?: string;
	machineAlias?: string;
	accountID?: string;
	tokens: TokenBreakdown;
	/** Effective charge (file-reported > meter-computed); 0 for plan-free usage. */
	cost: number;
	/** USD list-price equivalent at the request's own timestamp rates; null when unpriced. */
	costEquivalent?: number | null;
	/** Raw meter-observed cost before the file-cost rank. */
	costRaw?: number;
	latencyMs?: number;
	generationTokPerSec?: number;
	promptTokPerSec?: number;
	thinkingLevel?: string;
	attestation: string;
}

export interface EventsPage {
	events: UsageEvent[];
	next_cursor: number | null;
}

export interface ModelSummary {
	model: string;
	tokens: TokenBreakdown;
	cost: number;
	/** USD list-price equivalent; null when unpriced. */
	costEquivalent?: number | null;
	requests: number;
	avgGenerationTokPerSec?: number;
	avgPromptTokPerSec?: number;
	avgContextOccupancy?: number;
	lastEvent?: number;
}

export interface ProviderSummary {
	vendor: string;
	source: string;
	tokens: TokenBreakdown;
	cost: number;
	/** USD list-price equivalent summed over priced models; null when none priced. */
	costEquivalent?: number | null;
	requests: number;
	models: ModelSummary[];
}

export interface TrendPoint {
	/** Bucket start, epoch seconds. */
	day: number;
	tokens: number;
	cost: number;
	breakdown?: TokenBreakdown;
	byTool?: Record<string, number>;
}

export interface Trends {
	window: string;
	total: number;
	points: TrendPoint[];
}

export interface ProviderLimit {
	provider: string;
	label: string;
	usedPercent: number;
	resetsAt?: number;
	detail?: string;
}

export interface BucketRow {
	/** Bucket start, epoch seconds. */
	start: number;
	vendor: string;
	tokens: TokenBreakdown;
	cost: number;
	/** USD list-price equivalent for the bucket; null when unpriced. */
	costEquivalent?: number | null;
	/** Requests in the bucket. */
	requests: number;
}

export interface ProcSample {
	pid: number;
	ppid: number;
	name: string;
	command: string;
	user: string;
	threads: number;
	cpu: number;
	memMB: number;
	diskReadMBps: number;
	diskWriteMBps: number;
	netInKBps: number;
	netOutKBps: number;
	startTime: number;
}

/** One live request meter (GET /meters): loopback listen → upstream target. */
export interface MeterInfo {
	vendor: string;
	listen_port: number;
	target: string;
	source: string;
	seen?: number;
	measured?: number;
}

/** One meterable vendor and its desired+actual state (GET /meters catalog). */
export interface MeterCatalogEntry {
	vendor: string;
	running: boolean;
	enabled: boolean;
	listen_port: number;
	target: string | null;
}

export interface Meters {
	mode: 'point' | 'mitm';
	point: MeterInfo[];
	catalog: MeterCatalogEntry[];
	mitm?: Record<string, unknown>;
}

/** OS capability probe (GET /permissions): can-we vs may-we. */
export interface CapabilityStatus {
	capability: string;
	state: 'granted' | 'denied' | 'unknown' | string;
	detail: string;
	remediation: string[];
}

/** Consent grant state (GET /consents). */
export interface ConsentState {
	scope: string;
	granted: boolean;
}

/** Cloud sync state (GET /sync/status). */
export interface SyncStatus {
	enabled: boolean;
	cursors: Record<string, string>;
	last_sync: number | null;
	last_report?: { pushed: Record<string, number>; skipped: string[]; error?: string | null };
}

/** Daemon boot/login auto-start registration (GET /service). */
export interface ServiceStatus {
	supported: boolean;
	mechanism: 'systemd-user' | 'autostart-desktop' | 'launchagent' | 'unsupported';
	installed: boolean;
	enabled: boolean;
	running: boolean;
	detail: string;
}

/** One machine's usage rollup (GET /analytics/aggregate?group=machine).
 * `key` is the machine alias when known, else the raw machine id. */
export interface MachineRow {
	key: string;
	tokens: TokenBreakdown;
	cost: number;
	requests: number;
	firstEvent?: number;
	lastEvent?: number;
}

// ---- Endpoints ----

export const api = {
	health: () => get<Health>('/health'),
	stats: () => get<Stats>('/stats'),
	runtimes: () => get<RuntimeInfo[]>('/runtimes'),
	runtimeHistory: (vendor: string, coarse = false) =>
		get<{ vendor: string; points: RuntimeHistoryPoint[] }>(
			`/runtimes/history?vendor=${encodeURIComponent(vendor)}&coarse=${coarse ? 1 : 0}`
		),
	events: (params = '', cursor?: number) =>
		get<EventsPage>(`/analytics/events${params}${cursor ? `${params ? '&' : '?'}cursor=${cursor}` : ''}`),
	summary: (metered = true, fromEpoch = 0) =>
		get<{ providers: ProviderSummary[] }>(
			`/analytics/summary?from=${Math.floor(fromEpoch)}${metered ? '&metered=1' : ''}`
		),
	trends: (window: string) => get<Trends>(`/trends?window=${window}`),
	limits: () => get<{ limits: ProviderLimit[] }>('/limits'),
	refreshLimits: () => post<{ limits: ProviderLimit[] }>('/limits/refresh', {}),
	buckets: (resolution: number, fromEpoch: number, metered = true, extra = '') =>
		get<{ resolution: number; buckets: BucketRow[] }>(
			`/analytics/buckets?resolution=${resolution}&from=${Math.floor(fromEpoch)}${metered ? '&metered=1' : ''}${extra}`
		),
	processes: () => get<Record<string, ProcSample[]>>('/processes'),
	syncStatus: () => get<SyncStatus>('/sync/status'),
	machines: () => get<{ group: string; rows: MachineRow[] }>('/analytics/aggregate?group=machine'),
	meters: () => get<Meters>('/meters'),
	toggleMeter: (vendor: string, enabled: boolean) =>
		post<{ ok: boolean; running: boolean; listen_port: number | null }>('/meters/toggle', {
			vendor,
			enabled
		}),
	setMeterPort: (vendor: string, port: number) =>
		post<{ ok: boolean; running: boolean; listen_port: number | null }>('/meters/port', {
			vendor,
			port
		}),
	consolidate: () => post<{ ok: boolean; observations: Record<string, number> }>('/consolidate', {}),
	permissions: () => get<{ permissions: CapabilityStatus[] }>('/permissions'),
	consents: () => get<{ scopes: ConsentState[] }>('/consents'),
	setConsent: (scope: string, granted: boolean) =>
		post<{ ok: boolean; scope: string; granted: boolean }>('/consents', { scope, granted }),
	serviceStatus: () => get<ServiceStatus>('/service'),
	installService: () => post<ServiceStatus>('/service/install', {}),
	uninstallService: () => post<ServiceStatus>('/service/uninstall', {})
};
