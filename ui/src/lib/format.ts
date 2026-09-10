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

/** Total across a token breakdown. */
export function totalTok(b: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }): number {
	return b.input + b.output + b.reasoning + b.cacheRead + b.cacheWrite;
}

/** Poll `fn` every `ms` while mounted; returns cleanup for onMount. */
export function poll(fn: () => void | Promise<void>, ms: number): () => void {
	void fn();
	const id = setInterval(() => void fn(), ms);
	return () => clearInterval(id);
}
