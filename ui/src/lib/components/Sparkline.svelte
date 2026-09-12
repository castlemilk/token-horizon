<script lang="ts">
	/** Minimal line sparkline for runtime tok/s history. */
	let { values, height = 30 }: { values: (number | null | undefined)[]; height?: number } = $props();

	const W = 200;
	const pts = $derived.by(() => {
		const nums = values.map((v) => v ?? 0);
		const max = Math.max(1e-9, ...nums);
		if (nums.length < 2) return '';
		return nums
			.map((v, i) => {
				const x = (i / (nums.length - 1)) * W;
				const y = height - 3 - (v / max) * (height - 6);
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	});
</script>

{#if pts}
	<svg class="sparkline" viewBox="0 0 {W} {height}" preserveAspectRatio="none" style:height="{height}px">
		<polyline points={pts} fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
	</svg>
{/if}

<style>
	.sparkline {
		width: 100%;
		display: block;
	}
</style>
