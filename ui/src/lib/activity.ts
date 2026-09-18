// Daily activity helpers shared by the Tokens tab and the profile page.
// Source: /analytics/buckets at daily resolution (per-vendor rows), summed.

import { api } from './api';
import { billableTok } from './format';

export interface DayActivity {
	/** Local calendar day key, YYYY-MM-DD. */
	day: string;
	/** Epoch seconds at local midnight. */
	ts: number;
	tokens: number;
}

export interface ActivityStats {
	total: number;
	peak: number;
	activeDays: number;
	/** Consecutive active days ending today (or yesterday if today is empty). */
	streak: number;
}

function dayKey(ts: number): string {
	const d = new Date(ts * 1000);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Full local calendar for the last `days` days; zero-filled.
 *  Counts billable tokens (excludes cache reads) — the same semantics as
 *  the main tab headline, so tile, modal and dashboard agree. */
export async function fetchDailyActivity(days = 365, metered = true): Promise<DayActivity[]> {
	const now = Math.floor(Date.now() / 1000);
	const from = now - days * 86400;
	const res = await api.buckets(86400, from, metered);
	const byDay = new Map<string, number>();
	for (const b of res.buckets) {
		const k = dayKey(b.start);
		byDay.set(k, (byDay.get(k) ?? 0) + billableTok(b.tokens));
	}
	const out: DayActivity[] = [];
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(today.getTime() - i * 86400000);
		const ts = Math.floor(d.getTime() / 1000);
		const k = dayKey(ts);
		out.push({ day: k, ts, tokens: byDay.get(k) ?? 0 });
	}
	return out;
}

/** Full local calendar for an arbitrary [fromEpoch, toEpoch) span; zero-filled.
 *  Billable tokens, like fetchDailyActivity. */
export async function fetchDailyActivityRange(
	fromEpoch: number,
	toEpoch: number,
	metered = true
): Promise<DayActivity[]> {
	const res = await api.buckets(86400, fromEpoch, metered, '', toEpoch);
	const byDay = new Map<string, number>();
	for (const b of res.buckets) {
		const k = dayKey(b.start);
		byDay.set(k, (byDay.get(k) ?? 0) + billableTok(b.tokens));
	}
	const out: DayActivity[] = [];
	const start = new Date(fromEpoch * 1000);
	start.setHours(0, 0, 0, 0);
	const end = new Date(toEpoch * 1000);
	end.setHours(0, 0, 0, 0);
	for (let d = new Date(start); d < end; d = new Date(d.getTime() + 86400000)) {
		const ts = Math.floor(d.getTime() / 1000);
		const k = dayKey(ts);
		out.push({ day: k, ts, tokens: byDay.get(k) ?? 0 });
	}
	return out;
}

/** Local-midnight epoch bounds for a calendar year. */
export function yearBounds(year: number): [number, number] {
	const from = new Date(year, 0, 1);
	from.setHours(0, 0, 0, 0);
	const to = new Date(year + 1, 0, 1);
	to.setHours(0, 0, 0, 0);
	return [Math.floor(from.getTime() / 1000), Math.floor(to.getTime() / 1000)];
}
/** Heat band for a day's tokens relative to the visible max — the ONE
 *  banding both the heatmap cells and the widget dots use, so tile colors
 *  always match cells for the same data. */
export function heatLevel(tokens: number, maxV: number): number {
	if (tokens <= 0) return 0;
	const r = tokens / maxV;
	if (r <= 0.25) return 1;
	if (r <= 0.5) return 2;
	if (r <= 0.75) return 3;
	return 4;
}

export function activityStats(days: DayActivity[]): ActivityStats {
	const total = days.reduce((s, d) => s + d.tokens, 0);
	const peak = days.reduce((m, d) => Math.max(m, d.tokens), 0);
	const activeDays = days.filter((d) => d.tokens > 0).length;
	let streak = 0;
	// Walk backwards from today; allow today to be empty without breaking it.
	let i = days.length - 1;
	if (i >= 0 && days[i].tokens === 0) i--;
	for (; i >= 0; i--) {
		if (days[i].tokens <= 0) break;
		streak++;
	}
	return { total, peak, activeDays, streak };
}
