<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { api } from '$lib/api';
	import { cloud, type SharedProfile } from '$lib/cloud';
	import { Flame, Clock, Zap } from 'lucide-svelte';
	import { fmtTok, poll, timeAgo } from '$lib/format';
	import {
		fetchDailyActivity,
		fetchLast24hTokens,
		lastActiveDay,
		activityStats,
		type DayActivity
	} from '$lib/activity';
	import { settings } from '$lib/settings.svelte';
	import YearHeatmap, { type HintInfo } from '$lib/components/widgets/heatmap/YearHeatmap.svelte';
	import EmptyState from '$lib/components/common/EmptyState.svelte';

	// Route: /@<handle> — own handle reads the local daemon; any other
	// handle tries the cloud's shared profile and falls back to an empty
	// state (server endpoint pending — see cloud.sharedProfile).
	const handle = $derived(($page.params.handle ?? 'me').replace(/^@+/, ''));
	const localHandle = $derived((settings.handle.trim() || 'me').replace(/^@+/, ''));
	const norm = $derived(handle.toLowerCase());
	const isLocal = $derived(norm === localHandle.toLowerCase() || norm === 'me');

	let days = $state<DayActivity[]>([]);
	let last24h = $state<number | null>(null);
	let localEventTs = $state<number | null>(null);
	let remote = $state<SharedProfile | null>(null);
	let remoteMissing = $state(false);
	/** Ticks so aging "last activity" labels refresh without new data. */
	let nowTick = $state(Date.now());

	onMount(() => {
		const tick = setInterval(() => (nowTick = Date.now()), 30000);
		const done = () => clearInterval(tick);
		if (!isLocal) {
			cloud
				.sharedProfile(handle)
				.then((r) => (remote = r))
				.catch(() => (remoteMissing = true));
			return done;
		}
		const metered = `?limit=1${settings.showImports ? '' : '&metered=1'}`;
		const stop = poll(async () => {
			try {
				const r = await api.events(metered);
				localEventTs = r.events[0]?.timestamp ?? null;
			} catch {
				/* daemon down */
			}
		}, 10000);
		fetchDailyActivity(365, !settings.showImports)
			.then((d) => (days = d))
			.catch(() => {});
		fetchLast24hTokens(!settings.showImports)
			.then((v) => (last24h = v))
			.catch(() => {});
		return () => {
			stop();
			clearInterval(tick);
		};
	});

	// Billable semantics throughout (excludes cache reads) — the same
	// numbers the home widgets show. Cloud-shared days are taken as
	// reported; the local feed is billable by construction.
	const feedDays = $derived<DayActivity[]>(isLocal ? days : (remote?.days ?? []));
	const act = $derived(activityStats(feedDays));

	/** Precise last-activity timestamp: the newest metered event locally,
	 *  reported by the sharer remotely. Falls back to day granularity. */
	const lastEventTs = $derived<number | null>(
		isLocal ? localEventTs : (remote?.last_event_at ?? null)
	);
	function dayDiff(d: DayActivity): number {
		const t = new Date();
		t.setHours(0, 0, 0, 0);
		const c = new Date(d.ts * 1000);
		c.setHours(0, 0, 0, 0);
		return Math.round((t.getTime() - c.getTime()) / 86400000);
	}
	const lastActiveLabel = $derived.by(() => {
		void nowTick;
		if (lastEventTs != null) return timeAgo(lastEventTs, nowTick);
		const d = lastActiveDay(feedDays);
		if (!d) return 'No activity yet';
		const n = dayDiff(d);
		if (n <= 0) return 'Today';
		if (n === 1) return 'Yesterday';
		if (n < 7) return `${n} days ago`;
		return new Date(d.day + 'T12:00:00').toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric'
		});
	});
	/** Trailing-24h counter: measured hourly locally, reported by the
	 *  sharer remotely, last-day fallback while either is missing. */
	const last24hValue = $derived(
		isLocal ? (last24h ?? null) : (remote?.tokens_24h ?? null)
	);
	const last24hLabel = $derived(
		last24hValue != null
			? fmtTok(last24hValue)
			: feedDays.length > 0
				? fmtTok(feedDays[feedDays.length - 1]?.tokens ?? 0)
				: '…'
	);

	const displayName = $derived(
		isLocal ? null : (remote?.display_name || null)
	);
	const avatarURL = $derived(!isLocal ? cloud.avatarURL(remote) : null);
	const initial = $derived((handle[0] ?? '?').toUpperCase());
	const origin = $derived(isLocal ? 'this machine' : 'shared profile');
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
	<div class="pcol">
		<div class="handle">@{handle}</div>
		{#if displayName}
			<div class="dname">{displayName}</div>
		{/if}
		<div class="mstats">
			<div class="ms">
				<span class="mv"><Flame size={13} strokeWidth={2} />{act.streak}</span>
				<span class="ml">day streak</span>
			</div>
			<div class="ms">
				<span class="mv"><Clock size={13} strokeWidth={2} />{lastActiveLabel}</span>
				<span class="ml">last activity</span>
			</div>
			<div class="ms">
				<span class="mv"><Zap size={13} strokeWidth={2} />{last24hLabel}</span>
				<span class="ml">last 24 hours</span>
			</div>
		</div>
		<div class="psub">{origin} · {act.activeDays} active days</div>
	</div>
</div>

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
	<YearHeatmap days={feedDays} stepping={isLocal} showStats={false} hint={profileHint} />
{:else}
	<div class="card">
		<EmptyState title="Loading activity…" body="" />
	</div>
{/if}

<style>
	/* no hairline: the panel's stat cards are the next visual beat */
	.profile-mast {
		align-items: center;
		border-bottom: 0;
		padding-bottom: 0;
		margin-bottom: 18px;
	}
	.profile-mast .pcol {
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
	/* masthead stats: iOS-style value-over-label trio, hairline dividers */
	.mstats {
		display: flex;
		align-items: stretch;
		gap: 14px;
		margin-top: 10px;
		flex-wrap: wrap;
	}
	.ms {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.ms + .ms {
		border-left: 1px solid var(--line);
		padding-left: 14px;
	}
	.mv {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 18px;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.2;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		white-space: nowrap;
	}
	.mv :global(svg) {
		color: var(--text-2);
		flex: none;
	}
	.ml {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-3);
		white-space: nowrap;
	}
	.pcol .psub {
		margin-top: 8px;
	}
</style>
