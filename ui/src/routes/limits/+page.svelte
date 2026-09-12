<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type ProviderLimit } from '$lib/api';
	import { poll } from '$lib/format';

	let limits = $state<ProviderLimit[]>([]);

	onMount(() =>
		poll(async () => {
			try {
				limits = (await api.limits()).limits;
			} catch {
				/* daemon down */
			}
		}, 30000)
	);

	const grouped = $derived(
		limits.reduce<Record<string, ProviderLimit[]>>((acc, l) => {
			(acc[l.provider] ??= []).push(l);
			return acc;
		}, {})
	);

	function color(pct: number): string {
		if (pct >= 90) return 'var(--bad)';
		if (pct >= 70) return 'var(--warn)';
		return 'var(--ok)';
	}
</script>

<div class="section-label">Plan limits</div>
{#if Object.keys(grouped).length === 0}
	<div class="empty">No provider limits available</div>
{/if}
{#each Object.entries(grouped) as [provider, rows]}
	<div class="section-label">{provider}</div>
	<div class="grid cols-2">
		{#each rows as l}
			<div class="card">
				<div class="row" style="justify-content: space-between">
					<span>{l.label}</span>
					<span class="num" style="color: {color(l.usedPercent)}">{l.usedPercent.toFixed(0)}%</span>
				</div>
				<div class="bar-track" style="margin-top: 8px">
					<div class="bar-fill" style:width="{l.usedPercent}%" style:background={color(l.usedPercent)}></div>
				</div>
				{#if l.detail}
					<div class="faint num-sm" style="margin-top: 6px">{l.detail}</div>
				{/if}
				{#if l.resetsAt}
					<div class="faint num-sm">Resets {new Date(l.resetsAt * 1000).toLocaleString()}</div>
				{/if}
			</div>
		{/each}
	</div>
{/each}
