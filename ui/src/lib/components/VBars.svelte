<script lang="ts">
	import { fmtTok } from '$lib/format';

	/** Vertical rounded bar chart. Points are pre-bucketed time series. */
	let {
		points,
		height = 140,
		labelEvery = 0
	}: {
		points: { label: string; value: number }[];
		height?: number;
		labelEvery?: number;
	} = $props();

	const W = 900;
	const max = $derived(Math.max(1, ...points.map((p) => p.value)));
	const bars = $derived(
		points.map((p, i, arr) => {
			const bw = W / Math.max(arr.length, 1);
			const h = (p.value / max) * (height - 6);
			return {
				x: i * bw,
				y: height - h,
				w: Math.max(bw * 0.72, 0.5),
				ox: bw * 0.14,
				h,
				rx: Math.min(3, bw * 0.36),
				label: p.label,
				value: p.value
			};
		})
	);
</script>

{#if points.length > 0}
	<svg class="vchart" viewBox="0 0 {W} {height}" preserveAspectRatio="none" style:height="{height}px">
		{#each bars as b}
			<rect x={b.x + b.ox} y={b.y} width={b.w} height={Math.max(b.h, 0.5)} rx={b.rx} class="bar">
				<title>{b.label} — {fmtTok(b.value)} tokens</title>
			</rect>
		{/each}
	</svg>
	{#if labelEvery > 0}
		<div class="xlabels">
			{#each points as p, i}
				<span>{i % labelEvery === 0 ? p.label : ''}</span>
			{/each}
		</div>
	{/if}
{:else}
	<div class="empty">No data in this window</div>
{/if}

<style>
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
	.xlabels {
		display: flex;
		font-size: 10px;
		color: var(--text-3);
	}
	.xlabels span {
		flex: 1;
		overflow: hidden;
		white-space: nowrap;
	}
</style>
