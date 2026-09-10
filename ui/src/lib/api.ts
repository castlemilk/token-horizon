// Typed client for the Token Horizon loopback API (CoreAPIRouter).
// The same contract is served by the headless daemon and the macOS app.

export const DEFAULT_API_BASE = 'http://127.0.0.1:8765';

export function apiBase(): string {
	if (typeof localStorage !== 'undefined') {
		const override = localStorage.getItem('token-horizon.api');
		if (override) return override.replace(/\/$/, '');
	}
	return DEFAULT_API_BASE;
}

export function setApiBase(url: string | null) {
	if (url) localStorage.setItem('token-horizon.api', url);
	else localStorage.removeItem('token-horizon.api');
}

async function get<T>(path: string): Promise<T> {
	const res = await fetch(`${apiBase()}${path}`);
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
	tokens: TokenBreakdown;
	cost: number;
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
	requests: number;
	models: ModelSummary[];
}

export interface TrendPoint {
	day: string;
	tokens: number;
	cost: number;
	breakdown?: TokenBreakdown;
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
	summary: () => get<{ providers: ProviderSummary[] }>('/analytics/summary'),
	trends: (window: string) => get<Trends>(`/trends?window=${window}`),
	limits: () => get<{ limits: ProviderLimit[] }>('/limits')
};
