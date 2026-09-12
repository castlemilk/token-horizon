<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { api, type Stats, type ProviderSummary } from '$lib/api';
	import { totalTok, poll } from '$lib/format';
	import { fetchDailyActivity, activityStats, type DayActivity } from '$lib/activity';
	import { providerAccent } from '$lib/colors';
	import Heatmap from '$lib/components/Heatmap.svelte';
	import HBars, { type HBarRow } from '$lib/components/HBars.svelte';
	import CountUp from '$lib/components/CountUp.svelte';

	// Route: /@<handle> — profile summarizes this machine's activity attributed
	// to the handle (the local identity configured in Settings).
	const handle = $derived(($page.params.handle ?? 'me').replace(/^@+/, ''));

	let stats = $state<Stats | null>(null);
	let days = $state<DayActivity[]>([]);
	let summary = $state<ProviderSummary[]>([]);

	onMount(() => {
		const stop = poll(async () => {
			try {
				[stats, summary] = await Promise.all([
					api.stats(),
					api.summary().then((r) => r.providers)
				]);
			} catch {
				/* daemon down */
			}
		}, 10000);
		fetchDailyActivity(365)
			.then((d) => (days = d))
			.catch(() => {});
		return stop;
	});

	const act = $derived(activityStats(days));

	const topProviders = $derived(
		summary
			.map((p) => ({ p, tokens: totalTok(p.tokens) }))
			.sort((a, b) => b.tokens - a.tokens)
			.slice(0, 5)
			.map(
				({ p, tokens }): HBarRow => ({
					label: p.vendor,
					value: tokens,
					color: providerAccent(p.vendor),
					sub: `${p.requests} req`
				})
			)
	);

	const initial = $derived((handle[0] ?? '?').toUpperCase());
</script>

<div class="card profile-head">
	<span class="avatar">{initial}</span>
	<div>
		<div class="handle">@{handle}</div>
		<div class="dim" style="font-size: 12px">
			{act.activeDays} active days · {act.streak} day streak · this machine
		</div>
	</div>
	<div class="totals">
		<div class="t">
			<div class="tv"><CountUp value={stats?.usage.tokensAllTime ?? 0} /></div>
			<div class="tl">All time</div>
		</div>
		<div class="t">
			<div class="tv"><CountUp value={stats?.usage.tokensToday ?? 0} /></div>
			<div class="tl">Today</div>
		</div>
		<div class="t">
			<div class="tv"><CountUp value={act.peak} /></div>
			<div class="tl">Peak day</div>
		</div>
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

<div class="section-label">Top providers</div>
<div class="card">
	{#if topProviders.length > 0}
		<HBars rows={topProviders} thin />
	{:else}
		<div class="empty">No metered usage yet</div>
	{/if}
</div>

<style>
	.profile-head {
		display: flex;
		align-items: center;
		gap: 14px;
	}
	.avatar {
		width: 44px;
		height: 44px;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 18px;
		font-weight: 650;
		flex: none;
	}
	.handle {
		font-size: 16px;
		font-weight: 650;
	}
	.totals {
		margin-left: auto;
		display: flex;
		gap: 26px;
	}
	.tv {
		font-size: 18px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.tl {
		font-size: 11.5px;
		color: var(--text-2);
		text-align: right;
	}
</style>
