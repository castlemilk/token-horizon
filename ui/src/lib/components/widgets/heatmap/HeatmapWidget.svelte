<script lang="ts">
	import WidgetMorph, {
		type Phase,
		type EnterSpec,
		type ExitSpec,
		type TravelRoots,
		type TravelMark
	} from '../generic/WidgetMorph.svelte';
	import YearHeatmap, { type HintInfo } from './YearHeatmap.svelte';
	import { activityStats, heatLevel, type DayActivity } from '$lib/activity';
	import { fmtTok } from '$lib/format';
	import { HEAT } from '$lib/colors';

	/** Home-screen activity widget, two sizes sharing one modal.
	 *  small: 4×4 tile — last 16 days, one dot per day.
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

	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	/** Same domain as the trailing-year heatmap, so tile colors match cells.
	 *  Billable tokens throughout (excludes cache reads), like the main tab. */
	const tileMax = $derived(Math.max(1, ...days.map((d) => d.tokens)));
	const TILE_N = $derived(variant === 'small' ? 16 : 27);
	const tileDays = $derived(days.slice(-TILE_N));
	const tileLvls = $derived(tileDays.map((d) => heatLevel(d.tokens, tileMax)));
	const streak = $derived(activityStats(days).streak);
	const K = $derived(tileDays.length);
	const activeK = $derived(tileDays.filter((d) => d.tokens > 0).length);
	const tileKey = $derived(tileDays.map((d) => d.tokens).join(','));

	const tip = (d: DayActivity) =>
		d.day
			? `${new Date(d.day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} — ${d.tokens > 0 ? fmtTok(d.tokens) + ' tokens' : 'no activity'}`
			: 'no data yet';

	// ---- modal: full year (owned by YearHeatmap; this shell only borrows
	// the heat element for travel pairing + settle measurement) ----
	const currentYear = new Date().getFullYear();
	let panelYear = $state(currentYear);
	let heatEl = $state<HTMLElement | null>(null);

	// Engine-owned, bound here so content can gate on it (year stepping,
	// landing fades) without reaching into WidgetMorph.
	let phase = $state<Phase>('settle');
	let landed = $state(false);

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

	// ---- morph contract (see WidgetMorph) ----
	const canFly = () => !reduce && K > 0 && tileDays.some((d) => d.day);
	const closeable = () => panelYear === currentYear;

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
	<YearHeatmap
		{days}
		locked={phase !== 'settle'}
		flying={phase === 'fly'}
		bind:heatEl
		bind:year={panelYear}
		hint={modalHint}
	/>
{/snippet}
{#snippet modalHint(info: HintInfo)}
	{#if info.trailing}
		Close to fly the tile days home.
	{:else}
		Calendar year {info.year} — closing returns without the flight, the tile days live in the current year.
	{/if}
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
				style={reduce ? '' : `animation-delay: ${k * (variant === 'small' ? 30 : 22)}ms`}
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
	tileLabel="Activity — {variant === 'small' ? 'Last 16 days' : 'Last 27 days'} · tap to expand"
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
/>

<style>
	.mini {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(4, auto);
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
	.retry {
		appearance: none;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	@media (max-width: 640px) {
		.mdot { width: 14px; height: 14px; }
		.cols9 .mdot { width: 14px; height: 14px; }
		.mini { gap: 8px; }
		.mini.cols9 { gap: 8px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.mdot { animation: none; transition: none; }
		.w-foot.landed-in { animation: none; }
	}
</style>
