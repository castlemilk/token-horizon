<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { api, type ProviderSummary } from '$lib/api';
	import { cloud, type SharedProfile } from '$lib/cloud';
	import { billableTok, fmtTok, poll } from '$lib/format';
	import { fetchDailyActivity, activityStats, type DayActivity } from '$lib/activity';
	import { providerAccent } from '$lib/colors';
	import { settings } from '$lib/settings.svelte';
	import YearHeatmap, { type HintInfo } from '$lib/components/widgets/heatmap/YearHeatmap.svelte';
	import HBars, { type HBarRow } from '$lib/components/data/HBars.svelte';
	import EmptyState from '$lib/components/common/EmptyState.svelte';

	// Route: /@<handle> — own handle reads the local daemon; any other
	// handle tries the cloud's shared profile and falls back to an empty
	// state (server endpoint pending — see cloud.sharedProfile).
	const handle = $derived(($page.params.handle ?? 'me').replace(/^@+/, ''));
	const localHandle = $derived((settings.handle.trim() || 'me').replace(/^@+/, ''));
	const norm = $derived(handle.toLowerCase());
	const isLocal = $derived(norm === localHandle.toLowerCase() || norm === 'me');

	let days = $state<DayActivity[]>([]);
	let summary = $state<ProviderSummary[]>([]);
	let remote = $state<SharedProfile | null>(null);
	let remoteMissing = $state(false);

	onMount(() => {
		if (!isLocal) {
			cloud
				.sharedProfile(handle)
				.then((r) => (remote = r))
				.catch(() => (remoteMissing = true));
			return;
		}
		const stop = poll(async () => {
			try {
				summary = (await api.summary(!settings.showImports)).providers;
			} catch {
				/* daemon down */
			}
		}, 10000);
		fetchDailyActivity(365, !settings.showImports)
			.then((d) => (days = d))
			.catch(() => {});
		return stop;
	});

	// Billable semantics throughout (excludes cache reads) — the same
	// numbers the home widgets show. Cloud-shared days are taken as
	// reported; the local feed is billable by construction.
	const feedDays = $derived<DayActivity[]>(isLocal ? days : (remote?.days ?? []));
	const act = $derived(activityStats(feedDays));
	const today = $derived(feedDays.length > 0 ? (feedDays[feedDays.length - 1]?.tokens ?? 0) : 0);

	const topProviders = $derived<HBarRow[]>(
		isLocal
			? summary
					.map((p) => ({ p, tokens: billableTok(p.tokens) }))
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
			: (remote?.providers ?? [])
					.map((p) => ({ ...p }))
					.sort((a, b) => b.tokens - a.tokens)
					.slice(0, 5)
					.map(
						(p): HBarRow => ({
							label: p.vendor,
							value: p.tokens,
							color: providerAccent(p.vendor),
							sub: `${p.requests} req`
						})
					)
	);

	const displayName = $derived(
		isLocal ? null : (remote?.display_name || null)
	);
	const avatarURL = $derived(!isLocal ? cloud.avatarURL(remote) : null);
	const initial = $derived((handle[0] ?? '?').toUpperCase());
	const sub = $derived(
		isLocal
			? `${act.activeDays} active days · ${act.streak} day streak · this machine`
			: remote
				? `${act.activeDays} active days · ${act.streak} day streak · shared profile`
				: 'shared profile'
	);
	const todayBit = $derived(today > 0 ? ` · ${fmtTok(today)} today` : '');
</script>

{#snippet profileHint(info: HintInfo)}
	{#if info.trailing}
		Past 12 months · billable tokens.
	{:else}
		Calendar year {info.year}.
	{/if}
{/snippet}

<div class="phead profile-mast">
	{#if avatarURL}
		<img class="avatar" src={avatarURL} alt="" />
	{:else}
		<span class="avatar">{initial}</span>
	{/if}
	<div>
		<div class="handle">@{handle}</div>
		{#if displayName}
			<div class="dname">{displayName}</div>
		{/if}
		<div class="psub">{sub}{todayBit}</div>
	</div>
</div>

<div class="section-label">Activity · Last 12 months</div>
{#if !isLocal && !remote && !remoteMissing}
	<div class="card">
		<EmptyState title="Loading shared profile…" body="" />
	</div>
{:else if !isLocal && !remote}
	<div class="card">
		<EmptyState
			title="No shared activity"
			body="@{handle} hasn't shared activity yet."
		/>
	</div>
{:else if feedDays.length > 0}
	<YearHeatmap days={feedDays} stepping={isLocal} hint={profileHint} />
{:else}
	<div class="card">
		<EmptyState title="Loading activity…" body="" />
	</div>
{/if}

<div class="section-label">Top providers</div>
<div class="card">
	{#if topProviders.length > 0}
		<HBars rows={topProviders} thin />
	{:else}
		<EmptyState title="No metered usage yet" body="" />
	{/if}
</div>

<style>
	.profile-mast {
		align-items: center;
	}
	.profile-mast > div:nth-child(2) {
		min-width: 0;
		flex: 1;
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
	img.avatar {
		object-fit: cover;
		background: var(--track);
	}
	.handle {
		font-size: 20px;
		font-weight: 680;
		letter-spacing: -0.02em;
	}
	.dname {
		font-size: 13px;
		color: var(--text-2);
	}
</style>
