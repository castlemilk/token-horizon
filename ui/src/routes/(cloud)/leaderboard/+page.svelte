<script lang="ts">
	// Leaderboard — PUBLIC rankings (no sign-in to view). Three categories
	// (the dashboard stats trio: tokens / cost / requests) across six UTC
	// windows, a rising-star chart per window (biggest gain vs the previous
	// equal window), group chips (membership is N:M), and a country flag per
	// row once the server-side IP→country mapping lands.
	import { onMount } from 'svelte';
	import { flip } from 'svelte/animate';
	import { cloud, cloudToken, type BoardEntry, type Team } from '$lib/cloud';
	import { fmtMoney, fmtTok, poll } from '$lib/format';
	import EmptyState from '$lib/components/common/EmptyState.svelte';
	import { Trophy, TrendingUp, TrendingDown, Flame, PlugZap, Rocket } from 'lucide-svelte';

	type Window = 'all' | 'today' | 'week' | 'month' | '6m' | 'year';

	const windows: { id: Window; label: string }[] = [
		{ id: 'all', label: 'All time' },
		{ id: 'today', label: 'Today' },
		{ id: 'week', label: 'This week' },
		{ id: 'month', label: 'This month' },
		{ id: '6m', label: '6 months' },
		{ id: 'year', label: 'This year' }
	];

	const reduceMotion =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	let window_ = $state<Window>('today');
	let team = $state('');
	let teams = $state<Team[]>([]);
	let entries = $state<BoardEntry[]>([]);
	let rising = $state<BoardEntry[]>([]);
	let loading = $state(true);
	let offline = $state(false);
	let signedIn = $state(false);

	// Per-horizon cache: switching back to a seen horizon renders instantly
	// (no skeleton flash) and refreshes in the background; the 30s poll
	// keeps the cached copy fresh too.
	const cache = new Map<string, { entries: BoardEntry[]; rising: BoardEntry[] }>();
	const cacheKey = () => `${window_}|${team}`;

	async function load() {
		signedIn = !!cloudToken();
		const key = cacheKey();
		const cached = cache.get(key);
		if (cached) {
			entries = cached.entries;
			rising = cached.rising;
			loading = false; // instant paint; refresh below swaps in place
		} else {
			loading = true;
		}
		try {
			const board = await cloud.board(window_, 'tokens', team);
			cache.set(key, { entries: board.entries, rising: board.rising ?? [] });
			// Apply only if the user is still looking at this horizon.
			if (cacheKey() === key) {
				entries = board.entries;
				rising = board.rising ?? [];
				offline = false;
			}
		} catch {
			offline = true;
		} finally {
			loading = false;
		}
		// Team scoping is a signed-in affordance; the board itself is public.
		if (signedIn) {
			try {
				teams = (await cloud.teams()).teams;
			} catch {
				teams = [];
			}
		}
	}

	function pickWindow(w: Window) {
		window_ = w;
		void load();
	}

	function pickTeam(slug: string) {
		team = slug;
		void load();
	}

	onMount(() => poll(load, 30000));


	/** ISO 3166 alpha-2 → flag emoji (regional indicators). */
	function flag(cc?: string): string {
		if (!cc || cc.length !== 2) return '';
		return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
	}

	const podium = $derived(entries.slice(0, 3));
	const rest = $derived(entries.slice(3));
	/** Podium display order: 2nd, 1st, 3rd. */
	const podiumOrder = $derived([podium[1], podium[0], podium[2]].filter((e) => e !== undefined));
	const risingMax = $derived(Math.max(...rising.map((e) => e.delta ?? 0), 1));

	function league(rank: number): string | null {
		if (rank === 1) return 'Champion';
		if (rank <= 3) return 'Podium';
		if (rank <= 10) return 'Top 10';
		return null;
	}

	function medal(rank: number): string {
		if (rank === 1) return 'var(--warn)';
		if (rank === 2) return 'var(--text-3)';
		return 'var(--ok)';
	}

	const initials = (e: BoardEntry) =>
		((e.display_name || e.handle || '?').trim()[0] ?? '?').toUpperCase();
</script>

<div class="controls">
	<div class="seg" role="group" aria-label="Window">
		{#each windows as w}
			<button class:active={window_ === w.id} onclick={() => pickWindow(w.id)}>{w.label}</button>
		{/each}
	</div>
	{#if signedIn && teams.length > 0}
		<select class="teamsel" aria-label="Team scope" onchange={(e) => pickTeam(e.currentTarget.value)}>
			<option value="">Everyone</option>
			{#each teams as t}
				<option value={t.slug} selected={team === t.slug}>{t.name}</option>
			{/each}
		</select>
	{/if}
</div>

{#if offline && entries.length === 0 && !loading}
	<div class="banner">
		<PlugZap size={14} strokeWidth={2} />
		<span>Cloud unreachable — retrying…</span>
		<button class="link" onclick={() => void load()}>retry now</button>
	</div>
{:else if loading}
	<section>
		<div class="podium">
			{#each [0, 1, 2] as _}
				<div class="pcol"><span class="sk sk-pav"></span><span class="sk sk-pline"></span></div>
			{/each}
		</div>
		<div class="rows">
			{#each [0, 1, 2, 3] as _}
				<div class="lrow"><span class="sk sk-rl"></span><span class="sk sk-rv"></span></div>
			{/each}
		</div>
	</section>
{:else if entries.length === 0}
	<EmptyState icon={Trophy} title="No ranked activity" />
{:else}
	<section class="podium" aria-label="Top three">
		{#each podiumOrder as e (e.handle)}
			{@const first = e.rank === 1}
			<div class="pcol" class:first animate:flip={{ duration: reduceMotion ? 0 : 320 }}>
				<span class="pring" style="--medal: {medal(e.rank)}">
					{#if e.avatar_url}
						<img src={e.avatar_url} alt="" />
					{:else}
						<span class="pinit">{initials(e)}</span>
					{/if}
					<span class="prank num">{e.rank}</span>
				</span>
				<span class="pname">{flag(e.country_code)} @{e.handle}</span>
				{#if e.groups && e.groups.length > 0}
					<span class="pchips">
						{#each e.groups.slice(0, 3) as g}
							<span class="chip">{g}</span>
						{/each}
					</span>
				{/if}
				<span class="ptoks num">{fmtTok(e.tokens)}</span>
				{#if e.delta_pct != null && window_ !== 'all'}
					{@const up = e.delta_pct >= 0}
					<span class="delta" class:up class:down={!up}>
						{#if up}<TrendingUp size={11} strokeWidth={2.4} />{:else}<TrendingDown size={11} strokeWidth={2.4} />{/if}
						{Math.abs(e.delta_pct).toFixed(0)}%
					</span>
				{/if}
				{#if first && league(e.rank)}<span class="league">{league(e.rank)}</span>{/if}
			</div>
		{/each}
	</section>

	{#if rising.length > 0}
		<section class="rising" aria-label="Rising stars">
			<div class="risehead">
				<Rocket size={13} strokeWidth={2.2} />
				<span>Rising stars — biggest gains vs the previous {windows.find((w) => w.id === window_)?.label.toLowerCase()}</span>
			</div>
			{#each rising as e (e.handle)}
				<div class="riserow">
					<span class="risehandle">{flag(e.country_code)} @{e.handle}</span>
					<span class="risebarwrap">
						<span
							class="risebar"
							style="width: {Math.max(4, ((e.delta ?? 0) / risingMax) * 100)}%"
						></span>
					</span>
					<span class="riseval num">
						+{fmtTok(e.delta ?? 0)}
						{#if e.new}<span class="newbadge">new</span>{/if}
					</span>
				</div>
			{/each}
		</section>
	{/if}

	<section>
		<div class="rows">
			{#each rest as e (e.handle)}
				{@const up = (e.delta_pct ?? 0) >= 0}
				<div class="lrow" animate:flip={{ duration: reduceMotion ? 0 : 300 }}>
					<span class="rrank num">{e.rank}</span>
					<span class="ravatar">
						{#if e.avatar_url}
							<img src={e.avatar_url} alt="" />
						{:else}
							<span>{initials(e)}</span>
						{/if}
					</span>
					<span class="rwho">
						<span class="rhandle">{flag(e.country_code)} @{e.handle}</span>
						<span class="rsub faint">
							{fmtTok(e.tokens)} tok · {fmtMoney(e.cost)} · {e.requests} req · {e.machines} machine{e.machines === 1 ? '' : 's'}
							{#if (e.streak_days ?? 0) > 0}
								<span class="streak sm"><Flame size={10} strokeWidth={2.4} />{e.streak_days}</span>
							{/if}
						</span>
						{#if e.groups && e.groups.length > 0}
							<span class="rchips">
								{#each e.groups as g}
									<span class="chip">{g}</span>
								{/each}
							</span>
						{/if}
					</span>
					<span class="rmetric num">{fmtTok(e.tokens)}</span>
					{#if e.delta_pct != null && window_ !== 'all'}
						<span class="delta" class:up class:down={!up}>
							{#if up}<TrendingUp size={11} strokeWidth={2.4} />{:else}<TrendingDown size={11} strokeWidth={2.4} />{/if}
							{Math.abs(e.delta_pct).toFixed(0)}%
						</span>
					{/if}
				</div>
			{/each}
		</div>
	</section>
{/if}

<style>
	.controls {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		margin-bottom: 26px;
		flex-wrap: wrap;
	}
	.teamsel {
		font: inherit;
		font-size: 12px;
		font-weight: 550;
		color: var(--text);
		background: var(--bg-raised);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 6px 12px;
		cursor: pointer;
	}

	/* podium: 2nd · 1st · 3rd, champion elevated */
	.podium {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
		align-items: end;
		margin-bottom: 40px;
	}
	.pcol {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 7px;
		background: var(--bg-raised);
		border-radius: 20px;
		padding: 20px 10px 16px;
	}
	.pcol.first {
		padding-top: 28px;
		padding-bottom: 22px;
		background: color-mix(in srgb, var(--warn) 8%, var(--bg-raised));
	}
	.pring {
		position: relative;
		width: 64px;
		height: 64px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--accent-soft);
		box-shadow: 0 0 0 3px var(--medal);
		font-size: 22px;
		font-weight: 700;
		overflow: visible;
	}
	.first .pring {
		width: 80px;
		height: 80px;
		font-size: 28px;
	}
	.pring img {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		object-fit: cover;
	}
	.prank {
		position: absolute;
		right: -4px;
		bottom: -4px;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--medal);
		color: light-dark(#fff, #17171b);
		font-size: 12px;
		font-weight: 800;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.pname {
		font-size: 13px;
		font-weight: 600;
		letter-spacing: -0.01em;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ptoks {
		font-size: 22px;
		font-weight: 750;
		letter-spacing: -0.03em;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.first .ptoks {
		font-size: 30px;
	}
	.league {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--warn);
	}
	.streak {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 12px;
		font-weight: 700;
		color: var(--warn);
		font-variant-numeric: tabular-nums;
	}
	.streak.sm {
		font-size: 11px;
		margin-left: 6px;
	}
	.delta {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 11.5px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.delta.up {
		color: var(--ok);
	}
	.delta.down {
		color: var(--bad);
	}

	/* membership chips (N:M — every team/group shows) */
	.pchips,
	.rchips {
		display: inline-flex;
		gap: 4px;
		flex-wrap: wrap;
		justify-content: center;
	}
	.chip {
		font-size: 9.5px;
		font-weight: 650;
		letter-spacing: 0.02em;
		padding: 2px 7px;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--text-2);
		white-space: nowrap;
	}

	/* rising star chart */
	.rising {
		background: var(--bg-raised);
		border-radius: 16px;
		padding: 14px 16px;
		margin-bottom: 32px;
	}
	.risehead {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		font-weight: 650;
		color: var(--text-2);
		margin-bottom: 10px;
	}
	.riserow {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 0;
	}
	.risehandle {
		width: 130px;
		flex: none;
		font-size: 12px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.risebarwrap {
		flex: 1;
		height: 10px;
		border-radius: 6px;
		background: var(--track);
		overflow: hidden;
	}
	.risebar {
		display: block;
		height: 100%;
		border-radius: 6px;
		background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 60%, var(--ok)));
	}
	.riseval {
		flex: none;
		font-size: 11.5px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--ok);
	}
	.newbadge {
		font-size: 9px;
		font-weight: 750;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--warn);
		margin-left: 4px;
	}

	/* rank rows */
	.rows {
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}
	.lrow {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 13px 2px;
	}
	.lrow + .lrow {
		border-top: 1px solid var(--line);
	}
	.rrank {
		width: 26px;
		font-size: 13px;
		font-weight: 700;
		color: var(--text-3);
		font-variant-numeric: tabular-nums;
		flex: none;
	}
	.ravatar {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		background: var(--accent-soft);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 13px;
		font-weight: 700;
		color: var(--text-2);
		overflow: hidden;
		flex: none;
	}
	.ravatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.rwho {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.rhandle {
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.01em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rsub {
		font-size: 11.5px;
		font-variant-numeric: tabular-nums;
	}
	.rmetric {
		font-size: 14px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		flex: none;
	}

	.banner {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		padding: 10px 14px;
		border-radius: 12px;
		background: var(--bg-raised);
		margin-bottom: 18px;
	}
	.banner .link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
		text-decoration: underline;
		margin-left: auto;
	}
	/* skeletons */
	.sk {
		display: block;
		border-radius: 8px;
		background: linear-gradient(100deg, var(--bg-raised) 40%, var(--track) 50%, var(--bg-raised) 60%);
		background-size: 200% 100%;
		animation: shimmer 1.2s ease-in-out infinite;
	}
	.sk-pav {
		width: 64px;
		height: 64px;
		border-radius: 50%;
		margin: 0 auto;
	}
	.sk-pline {
		width: 80px;
		height: 13px;
		margin: 10px auto 0;
	}
	.sk-rl {
		height: 15px;
		width: 40%;
		border-radius: 6px;
	}
	.sk-rv {
		height: 15px;
		width: 64px;
		margin-left: auto;
		border-radius: 6px;
		flex: none;
	}
	@keyframes shimmer {
		to {
			background-position: -200% 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sk {
			animation: none;
		}
	}
</style>
