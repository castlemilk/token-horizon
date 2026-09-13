// Shared daemon connection state: every page reads the same status instead
// of failing silently on its own. Polls health, rediscovers the port when
// the daemon moves (8765-8784), and backs off while offline so a dead
// daemon doesn't spin the loop — with a manual retry() for the UI.

import { api, apiBase, setApiBase, discoverApiBase, type Health } from '$lib/api';

export type ConnStatus = 'connecting' | 'online' | 'offline';

const ONLINE_POLL_MS = 5000;
const OFFLINE_BASE_MS = 2000;
const OFFLINE_MAX_MS = 15000;

class Connection {
	status = $state<ConnStatus>('connecting');
	health = $state<Health | null>(null);
	/** Consecutive failed checks; drives backoff. */
	failures = $state(0);
	lastOk = $state(0);
	/** Last failure reason, surfaced in the footer tooltip for diagnosis. */
	lastError = $state<string | null>(null);
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;

	get online() {
		return this.status === 'online';
	}

	start() {
		if (this.running) return;
		this.running = true;
		void this.check();
	}

	stop() {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/** Manual retry from the UI: reset backoff and check now. */
	retry() {
		this.failures = 0;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		void this.check();
	}

	private schedule() {
		if (!this.running) return;
		const ms =
			this.status === 'online'
				? ONLINE_POLL_MS
				: Math.min(OFFLINE_BASE_MS * 2 ** Math.min(this.failures, 3), OFFLINE_MAX_MS);
		this.timer = setTimeout(() => void this.check(), ms);
	}

	private async check() {
		try {
			this.health = await api.health();
			this.status = 'online';
			this.failures = 0;
			this.lastError = null;
			this.lastOk = Date.now();
		} catch (e) {
			const first = e instanceof Error ? e.message : String(e);
			// Default base failed — maybe the daemon moved ports. Rediscover
			// before declaring offline (also heals stale saved overrides).
			try {
				const found = await discoverApiBase();
				if (found) {
					setApiBase(found);
					this.health = await api.health();
					this.status = 'online';
					this.failures = 0;
					this.lastError = null;
					this.lastOk = Date.now();
				} else {
					throw new Error('no daemon on 8765-8784');
				}
			} catch (e2) {
				this.failures += 1;
				this.status = 'offline';
				const second = e2 instanceof Error ? e2.message : String(e2);
				this.lastError = `${apiBase()} → ${first}; scan → ${second}`;
				try {
					console.warn('[token-horizon] daemon unreachable:', this.lastError);
				} catch {
					/* no console */
				}
			}
		}
		this.schedule();
	}
}

export const connection = new Connection();
