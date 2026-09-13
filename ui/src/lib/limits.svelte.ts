// Shared limits cache: module-level so switching in-app tabs remounts the
// page onto warm data instead of flashing empty + refetching. Polls fast
// (3s) until the first rows land — the daemon warms its cache async, so the
// first GETs after a cold start come back empty — then settles to 30s.

import { api, type ProviderLimit } from '$lib/api';
import { connection } from '$lib/connection.svelte';

const FAST_POLL_MS = 3000;
const SLOW_POLL_MS = 30000;
export const STALE_AFTER_MS = 120_000;

class LimitsStore {
	limits = $state<ProviderLimit[]>([]);
	updatedAt = $state(0);
	/** True until the first attempt resolves (skeleton, not "empty"). */
	loading = $state(true);
	refreshing = $state(false);
	private timer: ReturnType<typeof setTimeout> | null = null;
	private watchers = 0;

	get stale() {
		return this.updatedAt > 0 && Date.now() - this.updatedAt > STALE_AFTER_MS;
	}

	/** Pages call in onMount and call the returned stop in cleanup. */
	watch(): () => void {
		this.watchers += 1;
		if (this.watchers === 1) void this.fetch(true);
		return () => {
			this.watchers = Math.max(0, this.watchers - 1);
			if (this.watchers === 0 && this.timer) {
				clearTimeout(this.timer);
				this.timer = null;
			}
		};
	}

	/** Manual refresh button: force daemon re-fetch, then fast-poll in. */
	async refreshNow() {
		if (this.refreshing) return;
		this.refreshing = true;
		try {
			this.limits = (await api.refreshLimits()).limits;
			this.updatedAt = Date.now();
		} catch {
			/* offline — banner shows it; keep stale rows */
		} finally {
			this.refreshing = false;
		}
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (this.watchers > 0) this.schedule(FAST_POLL_MS);
	}

	private schedule(ms?: number) {
		if (this.watchers === 0) return;
		const delay = ms ?? (this.limits.length === 0 ? FAST_POLL_MS : SLOW_POLL_MS);
		this.timer = setTimeout(() => void this.fetch(), delay);
	}

	private async fetch(first = false) {
		if (this.watchers === 0 && !first) return;
		try {
			this.limits = (await api.limits()).limits;
			this.updatedAt = Date.now();
		} catch {
			/* connection banner owns the error state */
		} finally {
			this.loading = false;
		}
		this.schedule();
	}
}

export const limitsStore = new LimitsStore();

/** Seconds-since text for "updated Xs ago". */
export function fmtAgoShort(ms: number): string {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 5) return 'just now';
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	return `${Math.floor(m / 60)}h ago`;
}
