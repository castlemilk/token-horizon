<script lang="ts">
	import { fmtTok } from '$lib/format';

	/** GitHub-style daily heatmap: weeks as columns, days Mon–Sun as rows. */
	let {
		days,
		weeks = 53,
		highlightFrom,
		enterStagger = false
	}: {
		days: { day: string; ts: number; tokens: number }[];
		weeks?: number;
		/** Epoch seconds: cells at/after this render with a ring, marking the
		 *  range the small widget aggregates (last 90 days). */
		highlightFrom?: number;
	/** Entrance cascade for the ringed cells (widget landing). Older cells
	 *  appear instantly; each newer day pops 18ms after the previous. */
		enterStagger?: boolean;
	} = $props();

	const CELL = 11;
	const GAP = 3;
	/* Apple system green (light/dark) — activity-rings accent. */
	const HEAT = 'light-dark(#34c759, #30d158)';

	/* Fit the container: show as many of the most recent weeks as the width
	   allows — no scrolling, no clipping, always the freshest data. */
	let avail = $state(0);
	const fitWeeks = $derived(
		avail > 0 ? Math.max(4, Math.min(weeks, Math.floor((avail + GAP) / (CELL + GAP)))) : weeks
	);

	const max = $derived(Math.max(1, ...days.map((d) => d.tokens)));

	function level(tokens: number, maxV: number): number {
		if (tokens <= 0) return 0;
		const r = tokens / maxV;
		if (r <= 0.25) return 1;
		if (r <= 0.5) return 2;
		if (r <= 0.75) return 3;
		return 4;
	}

	interface Week {
		month: string;
		cells: ({ day: string; ts: number; tokens: number; lvl: number } | null)[];
	}

	// Pad the leading week so rows align Mon–Sun, then chunk into columns.
	const columns = $derived.by(() => {
		if (days.length === 0) return [] as Week[];
		const first = new Date(days[0].ts * 1000);
		const lead = (first.getDay() + 6) % 7; // Monday-first offset
		const padded: ({ day: string; ts: number; tokens: number } | null)[] = [
			...Array<null>(lead).fill(null),
			...days.map((d) => ({ day: d.day, ts: d.ts, tokens: d.tokens }))
		];
		const cols: Week[] = [];
		let prevMonth = '';
		for (let i = 0; i < padded.length; i += 7) {
			const chunk = padded.slice(i, i + 7);
			while (chunk.length < 7) chunk.push(null);
			const firstReal = chunk.find((c) => c !== null);
			const month = firstReal
				? new Date(firstReal.day + 'T12:00:00').toLocaleDateString(undefined, { month: 'short' })
				: '';
			const show = month !== prevMonth ? month : '';
			if (show) prevMonth = month;
			cols.push({
				month: show,
				cells: chunk.map((c) =>
					c ? { day: c.day, ts: c.ts, tokens: c.tokens, lvl: level(c.tokens, max) } : null
				)
			});
		}
		return cols.slice(-fitWeeks);
	});

	const fmtDay = (day: string) =>
		new Date(day + 'T12:00:00').toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});

	/** Day offset inside the ringed range, for the landing stagger. */
	function dayOffset(ts: number): number {
		if (highlightFrom == null) return 0;
		return Math.max(0, Math.floor((ts - highlightFrom) / 86400));
	}
</script>

<div class="heatmap" bind:clientWidth={avail} style:--cell="{CELL}px" style:--gap="{GAP}px" style:--heat={HEAT}>
	<div class="grid-row">
		{#each columns as week}
			<div class="week">
				<span class="month">{week.month}</span>
				{#each week.cells as cell}
					{#if cell}
						{@const inRange = highlightFrom != null && cell.ts >= highlightFrom}
						<span
							class="cell lvl-{cell.lvl}"
							class:hl={inRange}
							class:enter={enterStagger}
							data-ts={cell.ts}
							style={enterStagger && inRange ? `animation-delay: ${60 + Math.min(dayOffset(cell.ts), 40) * 18}ms` : ''}
							title="{fmtDay(cell.day)} — {cell.tokens > 0 ? fmtTok(cell.tokens) + ' tokens' : 'no activity'}"
						></span>
					{:else}
						<span class="cell pad"></span>
					{/if}
				{/each}
			</div>
		{/each}
	</div>
	<div class="legend">
		<span>Less</span>
		<span class="cell lvl-0"></span><span class="cell lvl-1"></span><span class="cell lvl-2"></span><span class="cell lvl-3"></span><span class="cell lvl-4"></span>
		<span>More</span>
	</div>
</div>

<style>
	/* Apple-style: no frame — dots float on the page background, centered. */
	.heatmap {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.grid-row {
		display: flex;
		gap: var(--gap);
		position: relative;
		padding-top: 14px; /* month labels */
		max-width: 100%;
	}
	.week {
		display: flex;
		flex-direction: column;
		gap: var(--gap);
		flex: none;
	}
	.month {
		position: absolute;
		top: 0;
		font-size: 10px;
		color: var(--text-3);
		height: 12px;
		overflow: visible;
		white-space: nowrap;
	}
	.cell {
		width: var(--cell);
		height: var(--cell);
		border-radius: 50%;
		background: var(--track);
		flex: none;
	}
	.cell.pad {
		background: transparent;
	}
	/* Apple-activity green intensity ramp */
	.lvl-1 { background: color-mix(in srgb, var(--heat) 35%, var(--track)); }
	.lvl-2 { background: color-mix(in srgb, var(--heat) 60%, var(--track)); }
	.lvl-3 { background: color-mix(in srgb, var(--heat) 82%, var(--track)); }
	.lvl-4 { background: var(--heat); }
	/* ring marks the trailing range the small widget aggregates */
	.cell.hl {
		box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--heat) 70%, transparent);
	}
	/* landing cascade: cells pop as the flying tile dots arrive */
	.cell.enter {
		animation: cellin 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.25) backwards;
	}
	@keyframes cellin {
		from { transform: scale(0.2); opacity: 0; }
		to { transform: scale(1); opacity: 1; }
	}
	@media (prefers-reduced-motion: reduce) {
		.cell.enter { animation: none; }
	}
	.legend {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		font-size: 10px;
		color: var(--text-3);
		margin-top: 14px;
	}
	.legend .cell {
		width: 9px;
		height: 9px;
		border-radius: 50%;
	}
</style>
