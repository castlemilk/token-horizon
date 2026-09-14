<script lang="ts">
	import { onMount } from 'svelte';
	import { flip } from 'svelte/animate';
	import { cloud, cloudToken, type BoardEntry, type Team } from '$lib/cloud';
	import { fmtTok, poll } from '$lib/format';
	import CountUp from '$lib/components/data/CountUp.svelte';
	import EmptyState from '$lib/components/common/EmptyState.svelte';
	import { Trophy, TrendingUp, TrendingDown, Flame, PlugZap } from 'lucide-svelte';

	type Period = 'today' | 'week' | 'all' | 'streak';

	const periods: { id: Period; label: string }[] = [
		{ id: 'today', label: 'Today' },
		{ id: 'week', label: '7 days' },
		{ id: 'all', label: 'All time' },
		{ id: 'streak', label: 'Streak' }
	];

	const reduceMotion =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	let period = $state<Period>('today');
	let team = $state('');
	let teams = $state<Team[]>([]);
	let entries = $state<BoardEntry[]>([]);
	let loading = $state(true);
	let offline = $state(false);
	let signedIn = $state(false);

	async function load() {
		if (!cloudToken()) {
			signedIn = false;
			loading = false;
			return;
		}
		signedIn = true;
		try {
			const [board, mine] = await Promise.all([
				cloud.board(team, period),
				cloud.teams().catch(() => ({ teams: [] }))
			]);
			entries = board.entries;
			teams = mine.teams;
			offline = false;
		} catch {
			offline = true;
		} finally {
			loading = false;
		}
	}

	function pick(p: Period) {
		period = p;
		loading = true;
		void load();
	}

	function pickTeam(slug: string) {
		team = slug;
		loading = true;
		void load();
	}

	onMount(() => poll(load, 30000));

	/** Streak period ranks by fire, everything else by tokens. */
	const ordered = $derived(
		period === 'streak'
			? [...entries].sort((a, b) => (b.streak_days ?? 0) - (a.streak_days ?? 0))
			: entries
	);
	const podium = $derived(ordered.slice(0, 3));
	const rest = $derived(ordered.slice(3));
	/** Podium display order: 2nd, 1st, 3rd. */
	const podiumOrder = $derived(
		[podium[1], podium[0], podium[2]].filter((e) => e !== undefined)
	);

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
	<div class="seg" role="group" aria-label="Period">
		{#each periods as p}
			<button class:active={period === p.id} onclick={() => pick(p.id)}>{p.label}</button>
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

{#if !signedIn && !loading}
	<EmptyState
		icon={Trophy}
		title="Rankings live in the cloud"
		body="Sign in with Google or Microsoft in Settings, push usage with TH_SYNC_URL, and your team board appears here."
		actionLabel="Open Settings"
		actionHref="/settings"
	/>
{:else if offline && entries.length === 0 && !loading}
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
	<EmptyState
		icon={Trophy}
		title="No ranked activity"
		body="Nobody has pushed usage for this window yet — sync a daemon and check back."
	/>
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
				<span class="pname">@{e.handle}</span>
				<span class="ptoks num"><CountUp value={e.tokens} /></span>
				{#if period === 'streak' && (e.streak_days ?? 0) > 0}
					<span class="streak"><Flame size={11} strokeWidth={2.4} />{e.streak_days}</span>
				{:else if e.delta_pct != null}
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
						<span class="rhandle">@{e.handle}</span>
						<span class="rsub faint">
							{fmtTok(e.tokens)} · {e.requests} req · {e.machines} machine{e.machines === 1 ? '' : 's'}
							{#if (e.streak_days ?? 0) > 0}
								<span class="streak sm"><Flame size={10} strokeWidth={2.4} />{e.streak_days}</span>
							{/if}
						</span>
					</span>
					{#if period !== 'streak' && e.delta_pct != null}
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
