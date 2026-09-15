<script lang="ts">
	import WidgetMorph, {
		type Phase,
		type EnterSpec,
		type ExitSpec,
		type TravelRoots,
		type TravelMark
	} from './WidgetMorph.svelte';
	import Heatmap from '$lib/components/data/Heatmap.svelte';
	import {
		activityStats,
		fetchDailyActivityRange,
		yearBounds,
		type DayActivity
	} from '$lib/activity';
	import { fmtTok } from '$lib/format';

	/** Home-screen activity widget, two sizes sharing one modal.
	 *  small: 3×3 tile — last 9 days, one dot per day.
	 *  medium: 9×3 tile — last 27 days, one dot per day.
	 *  modal: the full year (trailing 365d while the year is incomplete).
	 *
	 *  Content for a shared-container morph (see WidgetMorph): this file
	 *  owns data + markup + the travel pairing, the shell owns every
	 *  pixel of choreography. Tile/ghost markup is single-sourced via
	 *  snippets so the return flight always measures what the tile shows.
	 *
	 *  `speed` scales every duration (1 = brisk default, 0.5 dreamy,
	 *  2 = instant-ish) — timing choice lives here, in the component. */
	let { days, variant, speed = 1 }: { days: DayActivity[]; variant: 'small' | 'medium'; speed?: number } =
		$props();

	const HEAT = 'light-dark(#34c759, #30d158)';
	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	function level(tokens: number, maxV: number): number {
		if (tokens <= 0) return 0;
		const r = tokens / maxV;
		if (r <= 0.25) return 1;
		if (r <= 0.5) return 2;
		if (r <= 0.75) return 3;
		return 4;
	}

	/** Same domain as the trailing-year heatmap, so tile colors match cells.
	 *  Billable tokens throughout (excludes cache reads), like the main tab. */
	const tileMax = $derived(Math.max(1, ...days.map((d) => d.tokens)));
	const TILE_N = $derived(variant === 'small' ? 9 : 27);
	const tileDays = $derived(days.slice(-TILE_N));
	const tileLvls = $derived(tileDays.map((d) => level(d.tokens, tileMax)));
	const streak = $derived(activityStats(days).streak);
	const K = $derived(tileDays.length);
	const activeK = $derived(tileDays.filter((d) => d.tokens > 0).length);
	const tileKey = $derived(tileDays.map((d) => d.tokens).join(','));

	const tip = (d: DayActivity) =>
		d.day
			? `${new Date(d.day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} — ${d.tokens > 0 ? fmtTok(d.tokens) + ' tokens' : 'no activity'}`
			: 'no data yet';

	// ---- modal: full year ----
	const currentYear = new Date().getFullYear();
	const earliestYear = $derived(
		days.length > 0 ? new Date(days[0].ts * 1000).getFullYear() : currentYear
	);
	const minYear = $derived(Math.min(earliestYear, currentYear - 1));

	let year = $state(currentYear);
	let yearCache = $state<Record<number, DayActivity[]>>({});
	let loading = $state(false);
	let loadError = $state(false);
	let heatEl = $state<HTMLElement | null>(null);

	// Engine-owned, bound here so content can gate on it (year stepping,
	// landing fades) without reaching into WidgetMorph.
	let phase = $state<Phase>('settle');
	let landed = $state(false);

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

	/** Post-mount layout keeps shifting (heatmap auto-fits week columns to
	 *  the measured container width, fonts settle). Sampling until the heat
	 *  rect holds still guarantees the measured end boxes are final. */
	function layoutStable(maxFrames = 12): Promise<void> {
		return new Promise((resolve) => {
			let last = '';
			let steady = 0;
			let n = 0;
			const sample = () => {
				n++;
				const r = heatEl?.getBoundingClientRect();
				const key = r
					? `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`
					: 'null';
				steady = key === last ? steady + 1 : 0;
				last = key;
				if (steady >= 1 || n >= maxFrames) resolve();
				else requestAnimationFrame(sample);
			};
			requestAnimationFrame(sample);
		});
	}

	async function ensureYear(y: number) {
		if (y === currentYear || yearCache[y] || loading) return;
		loading = true;
		loadError = false;
		try {
			const [from, to] = yearBounds(y);
			yearCache[y] = await fetchDailyActivityRange(from, to, true);
		} catch {
			loadError = true;
		} finally {
			loading = false;
		}
	}

	function step(d: number) {
		if (phase !== 'settle') return; // never swap content mid-flight
		const next = Math.min(currentYear, Math.max(minYear, year + d));
		if (next === year) return;
		year = next;
		if (next !== currentYear) void ensureYear(next);
	}

	$effect(() => {
		if (year !== currentYear) void ensureYear(year);
	});

	// ---- morph contract (see WidgetMorph) ----
	const canFly = () => !reduce && K > 0 && tileDays.some((d) => d.day);
	const closeable = () => trailing;

	/** Travel endpoints keyed by day ts: tile dots ↔ year cells.
	 *  Sources read pre-swap, targets post-mount on open, both live on
	 *  close. The shell matches by key, so orderings may differ. */
	function travelFrom(dir: 'open' | 'close', roots: TravelRoots): TravelMark[] | null {
		if (dir === 'open') {
			if (!roots.box) return null;
			const dots = [...roots.box.querySelectorAll('.mini .mdot')];
			return tileDays.map((d, i) => ({ key: String(d.ts), el: dots[i] ?? null }));
		}
		if (!heatEl) return null;
		return tileDays.map((d) => ({
			key: String(d.ts),
			el: heatEl!.querySelector(`[data-ts="${d.ts}"]`)
		}));
	}

	function travelTo(dir: 'open' | 'close', roots: TravelRoots): TravelMark[] | null {
		if (dir === 'open') {
			if (!heatEl) return null;
			return tileDays.map((d) => ({
				key: String(d.ts),
				el: heatEl!.querySelector(`[data-ts="${d.ts}"]`)
			}));
		}
		if (!roots.ghost) return null;
		const dots = [...roots.ghost.querySelectorAll('.mdot')];
		return tileDays.map((d, i) => ({ key: String(d.ts), el: dots[i] ?? null }));
	}

	const enterOpen: EnterSpec[] = [
		{
			select: '.heatmap .cell',
			kind: 'ripple',
			excludeTravel: true,
			at: (c) => c.landT + 0.04 * c.S
		},
		{ select: '.xstat', kind: 'rise', at: (c) => c.landT + 0.12 * c.S },
		{ select: '.xnote', kind: 'rise', y: 5, at: (c) => c.landT + 0.28 * c.S },
		{ select: '.heatmap .legend', kind: 'fade', dur: 0.4, at: (c) => c.landT + 0.4 * c.S }
	];

	const exitClose: ExitSpec[] = [
		{ select: '.xheat', dur: 0.18, at: () => 0 },
		{ select: '.xstat, .xnote', at: (c) => 0.08 * c.S }
	];
</script>

{#snippet tileBody()}
	{#key tileKey}
		{@render tileDots()}
		{@render streakFoot(true)}
	{/key}
{/snippet}
{#snippet ghostSnip()}
	{@render tileDots()}
	{@render streakFoot(false)}
{/snippet}
{#snippet modalContent()}
	{#if yearDays.length === 0}
		<div class="empty">No activity in this range yet.</div>
	{:else}
	{#key year}
			<div class="xstats" class:conceal={phase === 'fly'}>
				<div class="xstat"><span class="xv num">{fmtTok(stats.total)}</span><span class="xl">tokens · {rangeLabel}</span></div>
				<div class="xstat"><span class="xv num">🔥 {stats.streak}</span><span class="xl">day streak</span></div>
				<div class="xstat"><span class="xv num">{fmtTok(stats.peak)}</span><span class="xl"><svg class="xic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l-6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>peak day</span></div>
				<div class="xstat"><span class="xv num">{stats.activeDays}</span><span class="xl"><svg class="xic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/></svg>active days</span></div>
			</div>
			<div class="xheat" class:pre={phase === 'fly'} bind:this={heatEl}>
				<Heatmap days={yearDays} enterStagger={false} />
			</div>
			<p class="xnote" class:conceal={phase === 'fly'}>
				{#if trailing}
					Close to fly the tile days home.
				{:else}
					Calendar year {year} — closing returns without the flight, the tile days live in the current year.
				{/if}
			</p>
		{/key}
	{/if}
{/snippet}
{#snippet yearPicker()}
	<div class="ypick" role="group" aria-label="Year">
		<button class="ybtn" onclick={(e) => { e.stopPropagation(); step(-1); }} disabled={year <= minYear || phase !== 'settle'} aria-label="Previous year">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
		</button>
		<span class="yval" aria-live="polite">{yearLabel}</span>
		<button class="ybtn" onclick={(e) => { e.stopPropagation(); step(1); }} disabled={year >= currentYear || phase !== 'settle'} aria-label="Next year">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
		</button>
	</div>
{/snippet}
{#snippet tileDots()}
	<span
		class="mini"
		class:cols9={variant === 'medium'}
		class:landed
		style:--heat={HEAT}
		role="img"
		aria-label="{activeK} active days in the last {TILE_N}"
	>
		{#each tileDays as d, k}
			<span
				class="mdot lvl-{tileLvls[k]}"
				style={reduce ? '' : `animation-delay: ${k * (variant === 'small' ? 55 : 22)}ms`}
				title={tip(d)}
			></span>
		{/each}
	</span>
{/snippet}
{#snippet streakFoot(describe: boolean)}
	{#if describe}
		<span class="w-foot" class:landed-in={landed} aria-label="{streak} day streak">🔥 {streak}</span>
	{:else}
		<span class="w-foot" aria-hidden="true">🔥 {streak}</span>
	{/if}
{/snippet}

<WidgetMorph
	size={variant === 'small' ? 'sm' : 'md'}
	{speed}
	tileLabel="Activity — {variant === 'small' ? 'Last 9 days' : 'Last 27 days'} · tap to expand"
	title="Activity"
	bind:phase
	bind:landed
	{canFly}
	{closeable}
	{travelFrom}
	{travelTo}
	awaitSettled={() => layoutStable()}
	staggerOpen={variant === 'small' ? 0.035 : 0.016}
	staggerClose={variant === 'small' ? 0.022 : 0.012}
	{enterOpen}
	{exitClose}
	tile={tileBody}
	modalBody={modalContent}
	ghostBody={ghostSnip}
	headerExtra={yearPicker}
/>

<style>
	.mini {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(3, auto);
		gap: 10px;
		justify-content: center;
		align-content: center;
	}
	.mini.cols9 {
		grid-template-columns: repeat(9, auto);
		gap: 10px;
	}
	.mdot {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--track);
		transition: background 0.4s ease, transform 0.18s ease;
		animation: dotpop 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.3) backwards;
	}
	.cols9 .mdot {
		width: 16px;
		height: 16px;
	}
	.mini .mdot:hover {
		transform: scale(1.25);
	}
	.lvl-1 { background: color-mix(in srgb, var(--heat) 35%, var(--track)); }
	.lvl-2 { background: color-mix(in srgb, var(--heat) 60%, var(--track)); }
	.lvl-3 { background: color-mix(in srgb, var(--heat) 82%, var(--track)); }
	.lvl-4 { background: var(--heat); }
	@keyframes dotpop {
		from { transform: scale(0.2); opacity: 0; }
		to { transform: scale(1); opacity: 1; }
	}
	/* post-landing: hold dots steady instead of replaying their
	   staggered entrance, fade the streak label over the settled tile. */
	.mini.landed .mdot {
		animation: none;
	}
	.w-foot.landed-in {
		animation: chromefade 0.25s ease backwards;
	}
	@keyframes chromefade {
		from { opacity: 0; }
		to { opacity: 1; }
	}
	/* ---- streak label: floats over the bottom padding so the dots stay
	   centered with symmetric padding (ghost mirrors this exactly). ---- */
	.w-foot {
		position: absolute;
		left: 16px;
		right: 16px;
		bottom: 8px;
		display: flex;
		justify-content: center;
		font-size: 12.5px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}
	/* ---- modal: layout reserved while flying, zero shifts ----
	   Pre-launch conceal covers the 1–2 frames before the timeline builds;
	   GSAP inline states take over seamlessly from there. */
	.conceal {
		visibility: hidden;
	}
	/* all cells hidden until the dots land (travelers included) */
	.xheat.pre :global(.heatmap .cell) {
		visibility: hidden;
	}
	/* card chrome hidden until the shell lands — squished scaling text
	   is the overlay tell */
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
		background: color-mix(in srgb, var(--bg-raised) 55%, transparent);
		border: 0;
		border-radius: 14px;
		padding: 12px 6px 10px;
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
	.xskel {
		display: grid;
		gap: 10px;
		padding: 12px 0;
	}
	.skel-row {
		height: 92px;
		border-radius: 10px;
		background: var(--track);
	}
	.skel-row.short {
		height: 20px;
		width: 45%;
		justify-self: center;
	}
	.empty {
		padding: 18px 0;
		text-align: center;
		font-size: 12.5px;
		color: var(--text-3);
	}
	.retry {
		appearance: none;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	/* year picker */
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
	@media (max-width: 640px) {
		.mdot { width: 14px; height: 14px; }
		.cols9 .mdot { width: 14px; height: 14px; }
		.mini { gap: 8px; }
		.mini.cols9 { gap: 8px; }
		.xstats { grid-template-columns: repeat(2, 1fr); }
		.yval { min-width: 96px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.mdot { animation: none; transition: none; }
		.w-foot.landed-in { animation: none; }
	}
</style>
