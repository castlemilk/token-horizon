<script module lang="ts">
	/** Context handed to the hint snippet. */
	export interface HintInfo {
		trailing: boolean;
		year: number;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import Heatmap from '$lib/components/data/Heatmap.svelte';
	import {
		activityStats,
		fetchDailyActivityRange,
		yearBounds,
		type DayActivity
	} from '$lib/activity';
	import { fmtTok } from '$lib/format';

	/** Year-stepped heatmap panel with stat cards — the shared body behind
	 *  the activity widget's modal AND the profile page, so neither repeats
	 *  the year cache, the stat row, or the picker. Data + markup live here;
	 *  the widget's morph shell only borrows the rendered pixels (via the
	 *  bound heat element for dot↔cell travel pairing).
	 *
	 *  `days` is the trailing-365 feed (current-year basis); earlier years
	 *  lazy-load from /analytics/buckets. `locked` blocks year stepping
	 *  (the widget passes phase !== 'settle'); `flying` conceals chrome
	 *  mid-flight (phase === 'fly'). */
	const currentYear = new Date().getFullYear();

	let {
		days,
		metered = true,
		locked = false,
		flying = false,
		/** Year stepping needs a range-capable feed (the local daemon).
		 *  Remote/shared profiles render trailing only until the cloud
		 *  serves ranges. */
		stepping = true,
		showStats = true,
		heatEl = $bindable(null),
		year = $bindable(currentYear),
		hint
	}: {
		days: DayActivity[];
		metered?: boolean;
		locked?: boolean;
		flying?: boolean;
		stepping?: boolean;
		/** Stat cards above the grid — the widget modal keeps them, the
		 *  profile page hides them (its masthead trio is the counter). */
		showStats?: boolean;
		heatEl?: HTMLElement | null;
		year?: number;
		hint: Snippet<[HintInfo]>;
	} = $props();

	const earliestYear = $derived(
		days.length > 0 ? new Date(days[0].ts * 1000).getFullYear() : currentYear
	);
	const minYear = $derived(Math.min(earliestYear, currentYear - 1));

	let yearCache = $state<Record<number, DayActivity[]>>({});
	let loading = $state(false);
	let loadError = $state(false);

	const trailing = $derived(year === currentYear);
	const yearDays = $derived<DayActivity[]>(trailing ? days : (yearCache[year] ?? []));
	const stats = $derived(activityStats(yearDays));
	const yearLabel = $derived(trailing ? 'Past 12 months' : `${year}`);
	const rangeLabel = $derived.by(() => {
		if (yearDays.length === 0) return '';
		const f = (d: DayActivity) =>
			new Date(d.day + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		return `${f(yearDays[0])} – ${f(yearDays[yearDays.length - 1])}`;
	});

	async function ensureYear(y: number) {
		if (y === currentYear || yearCache[y] || loading) return;
		loading = true;
		loadError = false;
		try {
			const [from, to] = yearBounds(y);
			yearCache[y] = await fetchDailyActivityRange(from, to, metered);
		} catch {
			loadError = true;
		} finally {
			loading = false;
		}
	}

	function step(d: number) {
		if (locked) return; // never swap content mid-flight
		const next = Math.min(currentYear, Math.max(minYear, year + d));
		if (next === year) return;
		year = next;
		if (next !== currentYear) void ensureYear(next);
	}

	$effect(() => {
		if (year !== currentYear) void ensureYear(year);
	});
</script>

{#if stepping}
<div class="ypick-row">
	<div class="ypick" role="group" aria-label="Year">
		<button class="ybtn" onclick={(e) => { e.stopPropagation(); step(-1); }} disabled={year <= minYear || locked} aria-label="Previous year">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
		</button>
		<span class="yval" aria-live="polite">{yearLabel}</span>
		<button class="ybtn" onclick={(e) => { e.stopPropagation(); step(1); }} disabled={year >= currentYear || locked} aria-label="Next year">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
		</button>
	</div>
</div>
{/if}
{#if yearDays.length === 0}
	<div class="empty">{loading ? 'Loading…' : loadError ? 'Could not load this year.' : 'No activity in this range yet.'}</div>
{:else}
	{#key year}
		{#if showStats}
		<div class="xstats" class:conceal={flying}>
			<div class="xstat"><span class="xv num">{fmtTok(stats.total)}</span><span class="xl">tokens · {rangeLabel}</span></div>
			<div class="xstat"><span class="xv num">🔥 {stats.streak}</span><span class="xl">day streak</span></div>
			<div class="xstat"><span class="xv num">{fmtTok(stats.peak)}</span><span class="xl"><svg class="xic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l-6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>peak day</span></div>
			<div class="xstat"><span class="xv num">{stats.activeDays}</span><span class="xl"><svg class="xic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/></svg>active days</span></div>
		</div>
		{/if}
		<div class="xheat" class:pre={flying} bind:this={heatEl}>
			<Heatmap days={yearDays} />
		</div>
		<p class="xnote" class:conceal={flying}>
			{@render hint({ trailing, year })}
		</p>
	{/key}
{/if}

<style>
	/* year picker: inline at the panel top (was the modal header slot) so
	   every consumer steps years without reimplementing the control */
	.ypick-row {
		display: flex;
		justify-content: center;
		margin: 26px 0 12px;
	}
	.ypick {
		display: flex;
		align-items: center;
		gap: 4px;
		background: var(--track);
		border-radius: 999px;
		padding: 3px;
	}
	.yval {
		min-width: 118px;
		text-align: center;
		font-size: 12px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	.ybtn {
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text-2);
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.ybtn:hover:not(:disabled) {
		background: var(--accent-soft);
		color: var(--text);
	}
	.ybtn:disabled {
		opacity: 0.3;
		cursor: default;
	}
	/* modal stat cards */
	.conceal {
		visibility: hidden;
	}
	/* all cells hidden until the dots land (travelers included) */
	.xheat.pre :global(.heatmap .cell) {
		visibility: hidden;
	}
	.xstats {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 10px;
		margin: 8px 0 16px;
	}
	.xstat {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 2px;
		/* a shade deeper than the old translucent fill, still well above
		   the --track picker pill */
		background: color-mix(in srgb, var(--bg-raised) 72%, var(--track));
		border: 0;
		border-radius: 14px;
		padding: 12px 6px 10px;
		box-shadow: inset 0 0 0 0.5px var(--line);
	}
	.xv {
		font-size: 19px;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.1;
	}
	.xl {
		font-size: 10.5px;
		color: var(--text-3);
	}
	.xic {
		vertical-align: -1.5px;
		margin-right: 3px;
	}
	.xheat {
		display: flex;
		justify-content: center;
		overflow-x: auto;
		padding-bottom: 4px;
	}
	.xnote {
		margin: 12px 2px 2px;
		font-size: 11.5px;
		color: var(--text-3);
		text-align: center;
	}
	.empty {
		padding: 18px 0;
		text-align: center;
		font-size: 12.5px;
		color: var(--text-3);
	}
	@media (max-width: 640px) {
		.xstats { grid-template-columns: repeat(2, 1fr); }
		.yval { min-width: 96px; }
	}
</style>
