<script lang="ts">
	import { scaleTime } from 'd3-scale';
	import { timeDay, timeMonth, timeYear } from 'd3-time';
	import { timeFormat } from 'd3-time-format';
	import { fmtTok } from '$lib/format';

	/** Vertical rounded bar chart on a d3 time scale — bars sit at their true
	    position in the window (empty spans are honest gaps), ticks come from
	    d3's multi-format heuristic and can never overlap.
	    Bar resolution is spec-driven: inferred window × container width tier
	      1D: 2H / 1H / 30m · 1W: 12h / 6h / 4h · 1M: 1W / 4D / 2D
	      3M: 1M / 2W / 1W · 1Y: 3M / 2M / 1M
	    (small <480px / medium <760px / large). Ticks stay width-driven and
	    are skipped when they cannot fit — bars always render. */
	let {
		points,
		from,
		to,
		height = 210
	}: {
		points: { ts: number; value: number }[];
		from: number; /* window start, epoch s */
		to: number; /* window end, epoch s */
		height?: number;
	} = $props();

	let cw = $state(0);
	/* container width in px (SSR-safe fallback); drives density, not geometry */
	const effW = $derived(cw > 0 ? cw : 900);

	/* compact height on narrow containers — container-driven so any
	   resize (window, panel, split) redraws height too, not just density */
	const H = $derived(effW < 640 ? 160 : height);

	const W = 900;
	const LABELH = 20;
	/* generous cap: sparse horizons (few bars) fill their slots instead of
	   floating as capped slivers with huge gaps */
	const MAXBW = 160;

	const merged = $derived.by(() => {
		const span = Math.max(1, to - from);
		const tier = effW < 480 ? 0 : effW < 760 ? 1 : 2;
		/* [small, medium, large] bin seconds per window */
		let bins: [number, number, number];
		if (span <= 129600) bins = [7200, 3600, 1800]; // 1D
		else if (span <= 691200) bins = [43200, 21600, 14400]; // 1W
		else if (span <= 3456000) bins = [604800, 345600, 172800]; // 1M
		else if (span <= 8640000) bins = [2592000, 1209600, 604800]; // 3M
		else bins = [7776000, 5184000, 2592000]; // 1Y
		const res = bins[tier];
		const rows: { ts: number; value: number }[] = [];
		for (const p of points) {
			const bin = from + Math.floor((p.ts - from) / res) * res;
			const last = rows[rows.length - 1];
			if (last && last.ts === bin) last.value += p.value;
			else rows.push({ ts: bin, value: p.value });
		}
		return { rows, res };
	});

	const max = $derived(Math.max(1, ...merged.rows.map((p) => p.value)));

	/* d3 time scale over the full window — time-accurate placement */
	const x = $derived(scaleTime().domain([from * 1000, to * 1000]).range([0, W]));

	const bars = $derived.by(() => {
		const { rows, res } = merged;
		if (rows.length < 1) return [];
		return rows.map((p) => {
			const step = x((p.ts + res) * 1000) - x(p.ts * 1000);
			const bw = Math.min(step, MAXBW);
			const h = (p.value / max) * (H - 6);
			/* edge bins can overhang the domain — clamp into the frame */
			const rawX = x(p.ts * 1000) + (step - bw) / 2 + bw * 0.1;
			const rawW = Math.max(bw * 0.8, 2);
			const cx = Math.max(0, rawX);
			const cw2 = Math.max(Math.min(rawX + rawW, W) - cx, 0.5);
			return {
				x: cx,
				y: H - h,
				w: cw2,
				h,
				rx: Math.min(6, bw * 0.25, cw2 / 2),
				ts: p.ts,
				value: p.value
			};
		});
	});

	/* classic d3 multi-scale tick format */
	const fTime = timeFormat('%H:%M');
	const fDay = timeFormat('%b %-d');
	const fMonth = timeFormat('%b');
	const fYear = timeFormat('%Y');
	function multiFormat(date: Date): string {
		return (
			(timeDay(date) < date ? fTime
			: timeMonth(date) < date ? fDay
			: timeYear(date) < date ? fMonth
			: fYear)(date)
		);
	}

	const ticks = $derived(
		x.ticks(Math.max(2, Math.floor(effW / 160))).map((t) => {
			const px = x(t);
			/* clamp edge ticks so they never clip out of the frame */
			const anchor = px < 34 ? 'start' : px > W - 34 ? 'end' : 'middle';
			return { t, x: anchor === 'start' ? 2 : anchor === 'end' ? W - 2 : px, anchor };
		})
	);
	const tickY = $derived(H + 14);
</script>

{#if points.length > 0}
	<div class="vwrap" bind:clientWidth={cw}>
	<svg class="vchart" viewBox="0 0 {W} {H + LABELH}" style:height="{H + LABELH}px">
		{#each bars as b}
			<rect x={b.x} y={b.y} width={b.w} height={Math.max(b.h, 0.5)} rx={b.rx} class="bar">
				<title>{multiFormat(new Date(b.ts * 1000))} — {fmtTok(b.value)} tokens</title>
			</rect>
		{/each}
		{#each ticks as tk}
			<text x={tk.x} y={tickY} class="tick" text-anchor={tk.anchor}>{multiFormat(tk.t)}</text>
		{/each}
	</svg>
	</div>
{:else}
	<div class="empty">quiet window</div>
{/if}

<style>
	.vwrap {
		width: 100%;
	}
	.vchart {
		width: 100%;
		display: block;
	}
	.bar {
		fill: var(--accent);
		opacity: 0.85;
	}
	.bar:hover {
		opacity: 1;
	}
	.tick {
		font-size: 10px;
		fill: var(--text-3);
		font-variant-numeric: tabular-nums;
	}
</style>
