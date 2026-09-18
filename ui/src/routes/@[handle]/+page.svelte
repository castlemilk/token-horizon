<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { api, type ProviderSummary } from '$lib/api';
	import { cloud, type SharedProfile } from '$lib/cloud';
	import { Flame, Clock, Zap, Hash, Activity, Coins } from 'lucide-svelte';
	import { billableTok, fmtMoney, fmtTok, heroCost, poll, timeAgo } from '$lib/format';
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
	let summary = $state<ProviderSummary[]>([]);
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
				const [s, e] = await Promise.all([
					api.summary(!settings.showImports),
					api.events(metered)
				]);
				summary = s.providers;
				localEventTs = e.events[0]?.timestamp ?? null;
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
	/** All-time totals: billable tokens + requests locally, reported
	 *  figures remotely; cost is hero semantics locally, unknown remotely. */
	const totalTokens = $derived(
		isLocal
			? summary.reduce((s, p) => s + billableTok(p.tokens), 0)
			: (remote?.providers.reduce((s, p) => s + p.tokens, 0) ?? 0)
	);
	const totalRequests = $derived(
		isLocal
			? summary.reduce((s, p) => s + p.requests, 0)
			: (remote?.providers.reduce((s, p) => s + p.requests, 0) ?? 0)
	);
	const totalCostLabel = $derived(isLocal ? fmtMoney(heroCost(summary)) : '—');

	const displayName = $derived(
		isLocal ? null : (remote?.display_name || null)
	);
	const avatarURL = $derived(!isLocal ? cloud.avatarURL(remote) : null);
	const initial = $derived((handle[0] ?? '?').toUpperCase());
	const origin = $derived(isLocal ? 'this machine' : 'shared profile');
</script>

{#snippet profileHint(info: HintInfo)}
	{#if info.trailing}
		Past 12 months.
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
				<span class="mhead"><span class="mico mico-flame"><Flame size={13} strokeWidth={2.2} /></span><span class="ml">day streak</span></span>
				<span class="mv">{act.streak}</span>
			</div>
			<div class="ms">
				<span class="mhead"><span class="mico mico-clock"><Clock size={13} strokeWidth={2.2} /></span><span class="ml">last activity</span></span>
				<span class="mv">{lastActiveLabel}</span>
			</div>
			<div class="ms">
				<span class="mhead"><span class="mico mico-zap"><Zap size={13} strokeWidth={2.2} /></span><span class="ml">last 24 hours</span></span>
				<span class="mv">{last24hLabel}</span>
			</div>
			<div class="ms">
				<span class="mhead"><span class="mico mico-tokens"><Hash size={13} strokeWidth={2.2} /></span><span class="ml">total tokens</span></span>
				<span class="mv">{fmtTok(totalTokens)}</span>
			</div>
			<div class="ms">
				<span class="mhead"><span class="mico mico-req"><Activity size={13} strokeWidth={2.2} /></span><span class="ml">requests</span></span>
				<span class="mv">{totalRequests.toLocaleString('en-US')}</span>
			</div>
			<div class="ms">
				<span class="mhead"><span class="mico mico-cost"><Coins size={13} strokeWidth={2.2} /></span><span class="ml">total cost</span></span>
				<span class="mv">{totalCostLabel}</span>
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
	/* no hairline: the heatmap panel is the next visual beat.
	   Top-aligned so the avatar sits level with the username, not
	   centered against the whole stat column. */
	.profile-mast {
		align-items: flex-start;
		border-bottom: 0;
		padding-bottom: 0;
		margin-bottom: 18px;
		container-type: inline-size;
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
	/* masthead stats: 6-up grid, icon + title on one row with the value
	   below — fixed fractions, so varying value lengths ("just now" vs
	   "a minute ago") can't shift the layout. Container queries, not the
	   viewport: the side rail's gutters change the available width. */
	.mstats {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: 14px 12px;
		margin-top: 12px;
	}
	.ms {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.mhead {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.mv {
		font-size: 16px;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.2;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.mico {
		width: 24px;
		height: 24px;
		border-radius: 7px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex: none;
	}
	@container (max-width: 640px) {
		.mstats {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.mv {
			font-size: 14px;
		}
	}
	@container (max-width: 420px) {
		.mstats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.mico-flame {
		color: #ff9500;
		background: rgb(255 149 0 / 0.14);
	}
	.mico-clock {
		color: #0a84ff;
		background: rgb(10 132 255 / 0.14);
	}
	.mico-zap {
		color: #30d158;
		background: rgb(48 209 88 / 0.14);
	}
	.mico-tokens {
		color: #bf5af2;
		background: rgb(191 90 242 / 0.14);
	}
	.mico-req {
		color: #5e5ce6;
		background: rgb(94 92 230 / 0.14);
	}
	.mico-cost {
		color: var(--warn);
		background: color-mix(in srgb, var(--warn) 14%, transparent);
	}
	.ml {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pcol .psub {
		margin-top: 8px;
	}
</style>
