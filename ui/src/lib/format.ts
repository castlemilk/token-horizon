export function fmtTok(n: number): string {
	if (n >= 1_000_000_000) return `${(n / 1e9).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1e3).toFixed(1)}K`;
	return `${n}`;
}

export function fmtBytes(n: number): string {
	if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
	if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(0)} MB`;
	return `${(n / 1024).toFixed(0)} KB`;
}

export function fmtTps(v?: number | null): string {
	return v == null ? '—' : `${v.toFixed(1)} tok/s`;
}

export function fmtTime(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toLocaleTimeString();
}

export function fmtDateTime(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toLocaleString();
}

/** Reset countdown: "in 4h 12m" soon, "Tue 14:30" this week, "Mar 12" beyond. */
export function fmtReset(epochSeconds: number): string {
	const d = new Date(epochSeconds * 1000);
	const s = Math.round(d.getTime() / 1000 - Date.now() / 1000);
	if (s <= 0) return 'soon';
	const m = Math.floor(s / 60);
	if (m < 1) return `in ${s}s`;
	if (m < 60) return `in ${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `in ${h}h ${String(m % 60).padStart(2, '0')}m`;
	const days = Math.floor(h / 24);
	if (days < 6) {
		return d.toLocaleDateString(undefined, { weekday: 'short' }) +
			' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
	}
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Total across a token breakdown. */
export function totalTok(b: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }): number {
	return b.input + b.output + b.reasoning + b.cacheRead + b.cacheWrite;
}

/**
 * Tokens that represent real model work — everything except cache READS,
 * which are near-free re-reads of already-processed context and otherwise
 * dominate headline numbers (97% of long-session traffic). Cache WRITES
 * count: they are billed, first-time work.
 */
export function billableTok(b: { input: number; output: number; reasoning: number; cacheRead?: number; cacheWrite: number }): number {
	return b.input + b.output + b.reasoning + b.cacheWrite;
}

/** Display-trim a raw model id: `/models/Qwen3.8-27B-Q8_0.gguf` → `Qwen3.8-27B-Q8_0`. */
export function fmtModel(m: string): string {
	const base = m.split('/').pop() ?? m;
	return base.replace(/\.(gguf|bin|safetensors)$/i, '');
}

/** Poll `fn` every `ms` while mounted; returns cleanup for onMount. */
export function poll(fn: () => void | Promise<void>, ms: number): () => void {
	void fn();
	const id = setInterval(() => void fn(), ms);
	return () => clearInterval(id);
}
