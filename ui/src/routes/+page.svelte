<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type Stats } from '$lib/api';
	import { fmtTok, poll } from '$lib/format';

	let stats = $state<Stats | null>(null);

	onMount(() =>
		poll(async () => {
			try {
				stats = await api.stats();
			} catch {
				/* layout shows daemon-down state */
			}
		}, 2000)
	);

	const ramPct = $derived(
		stats ? (stats.system.ram_used_gb / Math.max(stats.system.ram_total_gb, 1)) * 100 : 0
	);
</script>

{#if stats}
	<div class="section-label">USAGE</div>
	<div class="grid cols-4">
		<div class="card kpi">
			<div class="value">{fmtTok(stats.usage.tokensToday)}</div>
			<div class="label">TOKENS TODAY</div>
		</div>
		<div class="card kpi">
			<div class="value">{fmtTok(stats.usage.tokensAllTime)}</div>
			<div class="label">ALL TIME</div>
		</div>
		<div class="card kpi">
			<div class="value">${stats.usage.costToday.toFixed(2)}</div>
			<div class="label">COST TODAY</div>
		</div>
		<div class="card kpi">
			<div class="value">${stats.usage.costAllTime.toFixed(2)}</div>
			<div class="label">COST ALL TIME</div>
		</div>
	</div>

	<div class="section-label">TOKEN BREAKDOWN · TODAY</div>
	<div class="card">
		<table>
			<tbody>
				<tr><td class="dim">input</td><td class="right">{fmtTok(stats.usage.breakdownToday.input)}</td></tr>
				<tr><td class="dim">output</td><td class="right">{fmtTok(stats.usage.breakdownToday.output)}</td></tr>
				<tr><td class="dim">reasoning</td><td class="right">{fmtTok(stats.usage.breakdownToday.reasoning)}</td></tr>
				<tr><td class="dim">cache read</td><td class="right">{fmtTok(stats.usage.breakdownToday.cacheRead)}</td></tr>
				<tr><td class="dim">cache write</td><td class="right">{fmtTok(stats.usage.breakdownToday.cacheWrite)}</td></tr>
			</tbody>
		</table>
	</div>

	<div class="section-label">SYSTEM · THIS MACHINE</div>
	<div class="grid cols-2">
		<div class="card">
			<div class="row" style="justify-content: space-between">
				<span class="dim mono-sm">CPU</span>
				<span class="accent mono-sm">{stats.system.cpu_percent.toFixed(0)}%</span>
			</div>
			<div class="bar-track" style="margin-top: 6px">
				<div class="bar-fill" style:width="{stats.system.cpu_percent}%"></div>
			</div>
		</div>
		<div class="card">
			<div class="row" style="justify-content: space-between">
				<span class="dim mono-sm">RAM</span>
				<span class="accent mono-sm">
					{stats.system.ram_used_gb.toFixed(1)} / {stats.system.ram_total_gb.toFixed(0)} GB
				</span>
			</div>
			<div class="bar-track" style="margin-top: 6px">
				<div class="bar-fill" style:width="{ramPct}%"></div>
			</div>
		</div>
	</div>
{:else}
	<div class="empty">waiting for daemon…</div>
{/if}
