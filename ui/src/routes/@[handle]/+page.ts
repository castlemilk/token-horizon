import type { PageLoad } from './$types';
import { api, type ProviderSummary } from '$lib/api';
import { cloud, type SharedProfile } from '$lib/cloud';
import { fetchDailyActivity, fetchLast24hTokens, type DayActivity } from '$lib/activity';
import { settings } from '$lib/settings.svelte';

export interface ProfileData {
	handle: string;
	isLocal: boolean;
	days: DayActivity[];
	summary: ProviderSummary[];
	/** True once the summary feed resolved (even empty) — drives skeleton swaps. */
	summaryOk: boolean;
	last24h: number | null;
	lastEventTs: number | null;
	remote: SharedProfile | null;
	remoteMissing: boolean;
}

function empty(handle: string, isLocal: boolean): ProfileData {
	return {
		handle,
		isLocal,
		days: [],
		summary: [],
		summaryOk: false,
		last24h: null,
		lastEventTs: null,
		remote: null,
		remoteMissing: false
	};
}

/** Prefetch everything the profile paints so first paint has real data —
 *  skeletons only ever show when a feed is genuinely down, never as a
 *  flash before data that arrives 50ms later. SvelteKit keeps the current
 *  page visible until this resolves, so slow remotes don't blank either. */
export const load: PageLoad = async ({ params }) => {
	const handle = (params.handle ?? 'me').replace(/^@+/, '');
	const localHandle = (settings.handle.trim() || 'me').replace(/^@+/, '');
	const norm = handle.toLowerCase();
	const isLocal = norm === localHandle.toLowerCase() || norm === 'me';

	if (!isLocal) {
		try {
			const remote = await Promise.race([
				cloud.sharedProfile(handle),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000))
			]);
			return { ...empty(handle, isLocal), remote };
		} catch {
			return { ...empty(handle, isLocal), remoteMissing: true };
		}
	}

	try {
		const metered = !settings.showImports;
		const [days, s, e, h] = await Promise.all([
			fetchDailyActivity(365, metered),
			api.summary(metered),
			api.events(`?limit=1${settings.showImports ? '' : '&metered=1'}`),
			fetchLast24hTokens(metered).catch(() => null)
		]);
		return {
			handle,
			isLocal,
			days,
			summary: s.providers,
			summaryOk: true,
			last24h: h,
			lastEventTs: e.events[0]?.timestamp ?? null,
			remote: null,
			remoteMissing: false
		};
	} catch {
		// Daemon down — page renders skeletons; the refresh polls fill in.
		return empty(handle, isLocal);
	}
};
