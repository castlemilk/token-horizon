<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { api, type ProviderSummary } from '$lib/api';
	import { cloud, type SharedProfile } from '$lib/cloud';
	import { Flame, Clock, Zap, Hash, Activity, Coins } from 'lucide-svelte';
	import { billableTok, fmtModel, fmtMoney, fmtTok, heroCost, poll, timeAgo } from '$lib/format';
	import { providerAccent } from '$lib/colors';
	import {
		fetchDailyActivity,
		fetchLast24hTokens,
		lastActiveDay,
		activityStats,
		type DayActivity
	} from '$lib/activity';
	import { settings } from '$lib/settings.svelte';
	import YearHeatmap, { type HintInfo } from '$lib/components/widgets/heatmap/YearHeatmap.svelte';
	import ProviderIcon from '$lib/components/data/ProviderIcon.svelte';
	import AnimatedNumber from '$lib/components/data/AnimatedNumber.svelte';
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
		// Fast lane (10s): totals + newest event. Slow lane (60s): the day
		// feed and trailing-24h figure. Both fire immediately via poll().
		const fast = poll(async () => {
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
		const slow = poll(async () => {
			try {
				days = await fetchDailyActivity(365, !settings.showImports);
			} catch {
				/* daemon down */
			}
			try {
				last24h = await fetchLast24hTokens(!settings.showImports);
			} catch {
				/* daemon down */
			}
		}, 60000);
		return () => {
			fast();
			slow();
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
	 *  sharer remotely, last-day fallback while either is missing. Raw
	 *  numbers here — AnimatedNumber tweens them, formatters render. */
	const lastDayTokens = $derived(
		feedDays.length > 0 ? (feedDays[feedDays.length - 1]?.tokens ?? null) : null
	);
	const last24hNum = $derived<number | null>(
		isLocal ? (last24h ?? lastDayTokens) : (remote?.tokens_24h ?? lastDayTokens)
	);
	const totalCostNum = $derived<number | null>(isLocal ? heroCost(summary) : null);
	const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US');
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


	/** Provider split (billable locally, reported remotely) with shares. */
	const provRows = $derived(
		(isLocal
			? summary.map((p) => ({
					vendor: p.vendor,
					tokens: billableTok(p.tokens),
					cost: p.cost > 0.0001 ? p.cost : (p.costEquivalent ?? 0),
					requests: p.requests
				}))
			: (remote?.providers ?? []).map((p) => ({
					vendor: p.vendor,
					tokens: p.tokens,
					cost: 0,
					requests: p.requests
				}))
		)
			.sort((a, b) => b.tokens - a.tokens)
			.map((r) => ({ ...r, share: totalTokens > 0 ? (r.tokens / totalTokens) * 100 : 0 }))
	);
	/** Donut segments: conic-gradient stops in provider accents. */
	const donut = $derived.by(() => {
		if (totalTokens <= 0) return 'var(--track)';
		let acc = 0;
		const stops = provRows.map((r) => {
			const from = (acc / totalTokens) * 100;
			acc += r.tokens;
			const to = (acc / totalTokens) * 100;
			return `${providerAccent(r.vendor)} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
		});
		return `conic-gradient(${stops.join(', ')})`;
	});
	/** Top models across providers (local only — not shared remotely). */
	const modelRows = $derived(
		isLocal
			? summary
					.flatMap((p) =>
						p.models.map((m) => ({
							vendor: p.vendor,
							model: m.model,
							tokens: billableTok(m.tokens),
							requests: m.requests
						}))
					)
					.sort((a, b) => b.tokens - a.tokens)
					.slice(0, 8)
			: []
	);
	const modelMax = $derived(modelRows[0]?.tokens ?? 1);

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

<div class="profile-top">
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
			<div class="psub">{origin} · {act.activeDays} active days</div>
		</div>
	</div>
	<div class="mstats">
		<div class="ms">
			<span class="mhead"><span class="mico mico-flame"><Flame size={13} strokeWidth={2.2} /></span><span class="ml">day streak</span></span>
			<span class="mv"><AnimatedNumber value={act.streak} /></span>
		</div>
		<div class="ms">
			<span class="mhead"><span class="mico mico-clock"><Clock size={13} strokeWidth={2.2} /></span><span class="ml">last activity</span></span>
			<span class="mv">{lastActiveLabel}</span>
		</div>
		<div class="ms">
			<span class="mhead"><span class="mico mico-zap"><Zap size={13} strokeWidth={2.2} /></span><span class="ml">last 24 hours</span></span>
			<span class="mv"><AnimatedNumber value={last24hNum} format={fmtTok} /></span>
		</div>
		<div class="ms">
			<span class="mhead"><span class="mico mico-tokens"><Hash size={13} strokeWidth={2.2} /></span><span class="ml">total tokens</span></span>
			<span class="mv"><AnimatedNumber value={totalTokens} format={fmtTok} /></span>
		</div>
		<div class="ms">
			<span class="mhead"><span class="mico mico-req"><Activity size={13} strokeWidth={2.2} /></span><span class="ml">requests</span></span>
			<span class="mv"><AnimatedNumber value={totalRequests} format={fmtInt} /></span>
		</div>
		<div class="ms">
			<span class="mhead"><span class="mico mico-cost"><Coins size={13} strokeWidth={2.2} /></span><span class="ml">total cost</span></span>
			<span class="mv"><AnimatedNumber value={totalCostNum} format={fmtMoney} empty={isLocal ? '…' : '—'} /></span>
		</div>
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
	<YearHeatmap days={[]} stepping={false} showStats={false} skeleton hint={profileHint} />
{/if}

{#if provRows.length > 0}
	<div class="section-label">Providers</div>
	<div class="card prov">
		<div class="dwrap">
			<div class="donut" style:background={donut}></div>
			<div class="dhole">
				<span class="dnum num"><AnimatedNumber value={totalTokens} format={fmtTok} /></span>
				<span class="dlab">tokens</span>
			</div>
		</div>
		<div class="prows">
			{#each provRows as r}
				<div class="prow">
					<ProviderIcon vendor={r.vendor} size={24} />
					<span class="pname">{r.vendor}</span>
					<span class="pvals">
						<span class="pv num">{fmtTok(r.tokens)}</span>
						<span class="ptags">
							<span class="ptag">{Math.round(r.share)}%</span>
							{#if isLocal}<span class="ptag">{fmtMoney(r.cost)}</span>{/if}
							<span class="ptag">{r.requests} req</span>
						</span>
					</span>
				</div>
			{/each}
		</div>
	</div>
{/if}

{#if modelRows.length > 0}
	<div class="section-label">Top models</div>
	<div class="card models">
		{#each modelRows as m}
			<div class="mrow">
				<ProviderIcon vendor={m.vendor} model={m.model} size={24} />
				<div class="mmain">
					<div class="mline">
						<span class="mname">{fmtModel(m.model)}</span>
						<span class="mval num">{fmtTok(m.tokens)}</span>
					</div>
					<div class="msub2">{m.vendor} · {m.requests} req</div>
					<div class="mbar">
						<div class="mfill" style:width="{(m.tokens / modelMax) * 100}%" style:background={providerAccent(m.vendor)}></div>
					</div>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	/* no hairline: the heatmap panel is the next visual beat.
	   Top-aligned so the avatar sits level with the username, not
	   centered against the whole stat column. */
	/* identity row + full-width counter grid share one query container */
	.profile-top {
		container-type: inline-size;
		margin-bottom: 18px;
	}
	.profile-mast {
		align-items: flex-start;
		border-bottom: 0;
		padding-bottom: 0;
		margin-bottom: 14px;
	}
	.profile-mast .pcol {
		min-width: 0;
		flex: 1;
	}
	.avatar {
		width: 64px;
		height: 64px;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 26px;
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
	/* masthead stats: 3×2 grid, icon + title on one row with the value
	   below — fixed fractions, so varying value lengths ("just now" vs
	   "a minute ago") can't shift the layout. Container queries, not the
	   viewport: the side rail's gutters change the available width. */
	.mstats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
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
	@container (max-width: 560px) {
		.mstats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.mv {
			font-size: 14px;
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
	/* providers: conic donut with the total punched through the middle */
	.card.prov {
		display: flex;
		align-items: center;
		gap: 22px;
		flex-wrap: wrap;
	}
	.dwrap {
		position: relative;
		width: 128px;
		height: 128px;
		flex: none;
	}
	.donut {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		-webkit-mask: radial-gradient(closest-side, transparent 76%, black 77%);
		mask: radial-gradient(closest-side, transparent 76%, black 77%);
	}
	.dhole {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1px;
		pointer-events: none;
	}
	.dnum {
		font-size: 22px;
		font-weight: 800;
		letter-spacing: -0.03em;
		font-variant-numeric: tabular-nums;
	}
	.dlab {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-3);
	}
	.prows {
		flex: 1;
		min-width: 220px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.prow {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 12px;
		border-radius: 12px;
		background: color-mix(in srgb, var(--bg-raised) 72%, var(--track));
		box-shadow: inset 0 0 0 0.5px var(--line);
	}
	.pname {
		font-size: 14px;
		font-weight: 700;
		letter-spacing: -0.01em;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pvals {
		margin-left: auto;
		text-align: right;
		display: flex;
		flex-direction: column;
		flex: none;
	}
	.pv {
		font-size: 15px;
		font-weight: 750;
		letter-spacing: -0.01em;
		font-variant-numeric: tabular-nums;
	}
	.msub2 {
		font-size: 11px;
		color: var(--text-3);
		font-variant-numeric: tabular-nums;
	}
	.ptags {
		display: flex;
		align-items: baseline;
		justify-content: flex-end;
		margin-top: 3px;
	}
	.ptag {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.ptag + .ptag::before {
		content: '·';
		margin: 0 7px;
		color: var(--text-3);
	}
	.ptag:first-child {
		font-size: 12px;
		font-weight: 750;
		color: var(--text);
	}
	/* top models: Screen-Time-style bar list */
	.models .mrow {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 0;
	}
	.mmain {
		flex: 1;
		min-width: 0;
	}
	.mline {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.mname {
		font-size: 13.5px;
		font-weight: 650;
		letter-spacing: -0.005em;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mval {
		margin-left: auto;
		font-size: 14px;
		font-weight: 750;
		letter-spacing: -0.01em;
		font-variant-numeric: tabular-nums;
		flex: none;
	}
	.mbar {
		height: 10px;
		border-radius: 5px;
		background: var(--track);
		margin-top: 8px;
		overflow: hidden;
	}
	.mfill {
		height: 100%;
		border-radius: 5px;
	}
</style>
