// Data-scope store: what provenance of data can the UI show right now?
//
// Token Horizon's usage DB is on-machine; off-machine rows arrive only via
// cloud sync. The UI must render conditionally on THREE states:
//   synced   — cloud configured AND syncing: all machines' data is fresh
//   degraded — cloud configured but unreachable/stale: off-machine rows in
//              the local DB may be stale — show them, but marked
//   off      — cloud not configured: single-machine mode, no off-machine
//              data exists (and none should be promised)
// On-machine data (this machine's meters, runtimes, self-hosted LLMs) is
// ALWAYS renderable — it never depends on the cloud.

import { api, type MachineRow } from './api';
import { totalTok } from './format';

export type CloudState = 'unknown' | 'off' | 'synced' | 'degraded';

export interface MachineInfo {
	/** Display key from group=machine (alias when known, else raw id). */
	key: string;
	tokens: number;
	cost: number;
	requests: number;
	lastEvent?: number;
	isLocal: boolean;
}

/** A sync is fresh when it succeeded within this window. */
const SYNC_FRESH_MS = 15 * 60 * 1000;

/** Is the cloud server answering? A signed-out daemon never syncs, so
 *  reachability must be probed directly, not inferred from sync state. */
async function pingCloud(baseURL: string): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 2500);
		const res = await fetch(`${baseURL.replace(/\/$/, '')}/healthz`, { signal: ctrl.signal });
		clearTimeout(t);
		return res.ok;
	} catch {
		return false;
	}
}

class DataScope {
	machineID = $state('');
	machineAlias = $state('');
	machines = $state<MachineInfo[]>([]);
	cloud = $state<CloudState>('unknown');
	/** Cloud target configured (daemon has a base URL), regardless of sign-in. */
	cloudConnected = $state(false);
	/** Cloud server answers /healthz right now. Sign-in UI only shows then. */
	cloudReachable = $state(false);
	/** Signed-in identity applied on the daemon (sync is allowed to flow). */
	cloudSignedIn = $state(false);
	lastSync = $state<number | null>(null);
	syncError = $state<string | null>(null);

	/** More than one machine present in the usage DB. */
	get multiMachine(): boolean {
		return this.machines.length > 1;
	}

	/** Off-machine rows exist locally (synced in at some point). */
	get hasOffMachineData(): boolean {
		return this.machines.some((m) => !m.isLocal);
	}

	/** Off-machine data is fresh enough to trust right now. */
	get offMachineFresh(): boolean {
		return this.cloud === 'synced';
	}

	/** Short human label for the cloud/sync state. */
	get cloudLabel(): string {
		if (!this.cloudConnected) return 'no cloud configured';
		if (!this.cloudReachable) return 'cloud unreachable';
		if (!this.cloudSignedIn) return 'cloud connected — sign in to sync';
		if (this.cloud === 'synced') return 'cloud synced';
		if (this.cloud === 'degraded') return 'cloud stale — last sync a while ago';
		return '…';
	}

	/** Display name for this machine (alias preferred, id fallback). */
	get thisMachineName(): string {
		return this.machineAlias || this.machineID || 'this machine';
	}

	private async refresh() {
		let alias = this.machineAlias;
		let id = this.machineID;
		try {
			const h = await api.health();
			id = h.machine_id ?? id;
			alias = h.machine_alias ?? alias;
			this.machineID = id;
			this.machineAlias = alias;
		} catch {
			return; // daemon down — keep last known state
		}
		try {
			const s = await api.syncStatus();
			this.lastSync = s.last_sync;
			this.syncError = s.last_report?.error ?? null;
			this.cloudConnected = s.base_url != null && s.base_url !== '';
			this.cloudSignedIn = s.signed_in === true;
			this.cloudReachable = this.cloudConnected
				? await pingCloud(s.base_url as string)
				: false;
			if (!s.enabled) {
				this.cloud = 'off';
			} else {
				const fresh =
					s.last_sync != null &&
					Date.now() - s.last_sync * 1000 < SYNC_FRESH_MS &&
					!s.last_report?.error;
				this.cloud = fresh ? 'synced' : 'degraded';
			}
		} catch {
			// Endpoint missing (older core) — treat as not configured.
			this.cloud = this.cloud === 'unknown' ? 'off' : this.cloud;
		}
		try {
			const agg = await api.machines();
			this.machines = agg.rows.map((r: MachineRow) => ({
				key: r.key,
				tokens: totalTok(r.tokens),
				cost: r.cost,
				requests: r.requests,
				lastEvent: r.lastEvent,
				isLocal: r.key === alias || r.key === id
			}));
		} catch {
			/* store unavailable */
		}
	}

	/** Re-poll on demand (e.g. right after connect/disconnect). */
	async poke(): Promise<void> {
		await this.refresh();
	}

	/** Start polling (idempotent). Returns a stop function. */
	start(ms = 10000): () => void {
		void this.refresh();
		const id = setInterval(() => void this.refresh(), ms);
		return () => clearInterval(id);
	}
}

export const scope = new DataScope();
