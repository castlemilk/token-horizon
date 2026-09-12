<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type Stats, type Trends, type ProviderSummary } from '$lib/api';
	import { fmtTok, totalTok, poll } from '$lib/format';
	import { fetchDailyActivity, activityStats, type DayActivity } from '$lib/activity';
	import { providerAccent } from '$lib/colors';
	import { settings } from '$lib/settings.svelte';
	import Heatmap from '$lib/components/Heatmap.svelte';
	import VBars from '$lib/components/VBars.svelte';
	import HBars, { type HBarRow } from '$lib/components/HBars.svelte';

	let stats = $state<Stats | null>(null);
	let days = $state<DayActivity[]>([]);
	let summary = $state<ProviderSummary[]>([]);
	let trends = $state<Trends | null>(null);
	let window_ = $state('1M');

	const windows = ['1D', '1W', '1M', '3M', '1Y'];

	const loadTrends = async () => {
		try {
			trends = await api.trends(window_);
		} catch {
			/* daemon down */
		}
	};

	onMount(() => {
		const stop = poll(async () => {
			try {
				[stats, summary] = await Promise.all([
					api.stats(),
					api.summary().then((r) => r.providers)
				]);
			} catch {
				/* layout shows daemon-down state */
			}
		}, 5000);
		void loadTrends();
		fetchDailyActivity(365)
			.then((d) => (days = d))
			.catch(() => {});
		return stop;
	});

	const act = $derived(activityStats(days));

	// ---- vertical chart points, with per-window label formatting ----
	function fmtLabel(ts: number): string {
		const d = new Date(ts * 1000);
		switch (window_) {
			case '1D':
				return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
			case '1W':
				return d.toLocaleDateString(undefined, { weekday: 'short' });
			case '1M':
			case '3M':
				return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
			default:
				return d.toLocaleDateString(undefined, { month: 'short' });
		}
	}
	const points = $derived(
		(trends?.points ?? []).map((p) => ({ label: fmtLabel(p.day), value: p.tokens }))
	);
	const labelEvery = $derived(Math.max(1, Math.ceil(points.length / 8)));

	// ---- provider / model horizontal bars (settings-filtered) ----
	const provRows = $derived(
		summary
			.filter((p) => settings.providerEnabled(p.vendor))
			.sort((a, b) => totalTok(b.tokens) - totalTok(a.tokens))
			.flatMap((p) => {
				const accent = providerAccent(p.vendor);
				const rows: HBarRow[] = [
					{
						label: p.vendor,
						value: totalTok(p.tokens),
						color: accent,
						sub: `${p.requests} req`
					}
				];
				const models = [...p.models]
					.sort((a, b) => totalTok(b.tokens) - totalTok(a.tokens));
				const top = models.slice(0, 4);
				const rest = models.slice(4);
				for (const m of top) {
					rows.push({
						label: m.model,
						value: totalTok(m.tokens),
						color: accent,
						sub: `${m.requests} req`,
						indent: true
					});
				}
				if (rest.length > 0) {
					rows.push({
						label: `${rest.length} other models`,
						value: rest.reduce((s, m) => s + totalTok(m.tokens), 0),
						color: accent,
						indent: true
					});
				}
				return rows;
			})
	);
</script>

<div class="grid cols-4">
	<div class="card kpi">
		<div class="value">{fmtTok(stats?.usage.tokensToday ?? 0)}</div>
		<div class="label">Tokens today</div>
	</div>
	<div class="card kpi">
		<div class="value">{fmtTok(stats?.usage.tokensAllTime ?? 0)}</div>
		<div class="label">All time</div>
	</div>
	<div class="card kpi">
		<div class="value">{act.streak}<span class="unit">d</span></div>
		<div class="label">Current streak</div>
	</div>
	<div class="card kpi">
		<div class="value">{act.activeDays}</div>
		<div class="label">Active days · 365d</div>
	</div>
</div>

<div class="section-label">Activity · Last 12 months</div>
<div class="card">
	{#if days.length > 0}
		<Heatmap {days} />
	{:else}
		<div class="empty">Loading activity…</div>
	{/if}
</div>

<div class="section-label">Usage over time</div>
<div class="row" style="margin-bottom: 10px">
	<div class="seg" role="group" aria-label="Window">
		{#each windows as w}
			<button class:active={window_ === w} onclick={() => { window_ = w; void loadTrends(); }}>{w}</button>
		{/each}
	</div>
	<span class="dim num-sm" style="margin-left: auto">
		{#if trends}{fmtTok(trends.total)} total · {trends.points.length} buckets{/if}
	</span>
</div>
<div class="card">
	<VBars {points} {labelEvery} />
</div>

<div class="section-label">By provider and model</div>
<div class="card">
	{#if provRows.length > 0}
		<HBars rows={provRows} />
	{:else}
		<div class="empty">No metered usage yet — providers appear here as traffic is measured</div>
	{/if}
</div>

<style>
	.unit {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-2);
		margin-left: 2px;
	}
</style>
