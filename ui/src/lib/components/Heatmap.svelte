<script lang="ts">
	import { fmtTok } from '$lib/format';

	/** GitHub-style daily heatmap: weeks as columns, days Mon–Sun as rows. */
	let { days, weeks = 53 }: { days: { day: string; ts: number; tokens: number }[]; weeks?: number } =
		$props();

	const CELL = 10;
	const GAP = 2;

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
		cells: ({ day: string; tokens: number; lvl: number } | null)[];
	}

	// Pad the leading week so rows align Mon–Sun, then chunk into columns.
	const columns = $derived.by(() => {
		if (days.length === 0) return [] as Week[];
		const first = new Date(days[0].ts * 1000);
		const lead = (first.getDay() + 6) % 7; // Monday-first offset
		const padded: ({ day: string; tokens: number } | null)[] = [
			...Array<null>(lead).fill(null),
			...days.map((d) => ({ day: d.day, tokens: d.tokens }))
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
					c ? { day: c.day, tokens: c.tokens, lvl: level(c.tokens, max) } : null
				)
			});
		}
		return cols.slice(-weeks);
	});

	const fmtDay = (day: string) =>
		new Date(day + 'T12:00:00').toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
</script>

<div class="heatmap" style:--cell="{CELL}px" style:--gap="{GAP}px">
	{#each columns as week}
		<div class="week">
			<span class="month">{week.month}</span>
			{#each week.cells as cell}
				{#if cell}
					<span
						class="cell lvl-{cell.lvl}"
						title="{fmtDay(cell.day)} — {cell.tokens > 0 ? fmtTok(cell.tokens) + ' tokens' : 'no activity'}"
					></span>
				{:else}
					<span class="cell pad"></span>
				{/if}
			{/each}
		</div>
	{/each}
	<div class="legend">
		<span>Less</span>
		<span class="cell lvl-0"></span><span class="cell lvl-1"></span><span class="cell lvl-2"></span><span class="cell lvl-3"></span><span class="cell lvl-4"></span>
		<span>More</span>
	</div>
</div>

<style>
	.heatmap {
		display: flex;
		gap: var(--gap);
		position: relative;
		padding-top: 14px; /* month labels */
		overflow-x: auto;
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
		border-radius: 2.5px;
		background: var(--track);
		flex: none;
	}
	.cell.pad {
		background: transparent;
	}
	.lvl-1 { background: color-mix(in srgb, var(--accent) 30%, var(--track)); }
	.lvl-2 { background: color-mix(in srgb, var(--accent) 52%, var(--track)); }
	.lvl-3 { background: color-mix(in srgb, var(--accent) 74%, var(--track)); }
	.lvl-4 { background: var(--accent); }
	.legend {
		position: absolute;
		right: 0;
		top: -2px;
		display: flex;
		align-items: center;
		gap: 3px;
		font-size: 10px;
		color: var(--text-3);
	}
	.legend .cell {
		width: 9px;
		height: 9px;
	}
</style>
