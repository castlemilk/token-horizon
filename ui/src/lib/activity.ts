// Daily activity helpers shared by the Tokens tab and the profile page.
// Source: /analytics/buckets at daily resolution (per-vendor rows), summed.

import { api } from './api';
import { totalTok } from './format';

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

/** Full local calendar for the last `days` days; zero-filled. */
export async function fetchDailyActivity(days = 365, metered = true): Promise<DayActivity[]> {
	const now = Math.floor(Date.now() / 1000);
	const from = now - days * 86400;
	const res = await api.buckets(86400, from, metered);
	const byDay = new Map<string, number>();
	for (const b of res.buckets) {
		const k = dayKey(b.start);
		byDay.set(k, (byDay.get(k) ?? 0) + totalTok(b.tokens));
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
