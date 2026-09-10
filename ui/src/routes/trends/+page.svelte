<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type Trends } from '$lib/api';
	import { fmtTok, poll } from '$lib/format';

	const windows = ['1D', '1W', '1M', '3M', '1Y'];
	let window_ = $state('1D');
	let data = $state<Trends | null>(null);

	const load = async () => {
		try {
			data = await api.trends(window_);
		} catch {
			/* daemon down */
		}
	};

	onMount(() => poll(load, 10000));

	const max = $derived(Math.max(1, ...(data?.points.map((p) => p.tokens) ?? [1])));
	const W = 900;
	const H = 120;
	const bars = $derived(
		(data?.points ?? []).map((p, i, arr) => {
			const bw = W / Math.max(arr.length, 1);
			const h = (p.tokens / max) * (H - 4);
			return { x: i * bw, y: H - h, w: Math.max(bw - 1, 0.5), h };
		})
	);
</script>

<div class="section-label">TOKEN TRENDS</div>
<div class="row" style="margin-bottom: 8px">
	{#each windows as w}
		<button class="chip" class:active={window_ === w} onclick={() => { window_ = w; void load(); }}>{w}</button>
	{/each}
	<span class="dim mono-sm" style="margin-left: auto">
		{#if data}{fmtTok(data.total)} total · {data.points.length} buckets{/if}
	</span>
</div>

<div class="card">
	{#if data && data.points.length > 0}
		<svg class="spark" viewBox="0 0 {W} {H}" preserveAspectRatio="none">
			{#each bars as b}
				<rect x={b.x} y={b.y} width={b.w} height={b.h} rx="1" fill="var(--accent)" opacity="0.85" />
			{/each}
		</svg>
	{:else}
		<div class="empty">no data in this window</div>
	{/if}
</div>
