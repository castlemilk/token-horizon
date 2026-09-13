<script lang="ts">
	// Leaderboard tab — scaffold only. The period model and row shape mirror the
	// macOS app's LeaderboardPeriod/LeaderboardEntry so the custom implementation
	// can drop in against them. Data source options: Cloudflare Worker+R2
	// (fast) or Google Sheets (legacy) — see README "Team leaderboard".
	//
	// Data scope: ranking people/machines is inherently OFF-machine data — it
	// only exists when cloud sync is configured and reachable. When it isn't,
	// say so plainly instead of rendering an empty table.
	import { scope } from '$lib/scope.svelte';

	type Period = 'today' | 'week' | 'all' | 'streak';

	const periods: { id: Period; label: string }[] = [
		{ id: 'today', label: 'Today' },
		{ id: 'week', label: '7 days' },
		{ id: 'all', label: 'All time' },
		{ id: 'streak', label: 'Streak' }
	];

	let period = $state<Period>('today');

	// TODO(custom): fetch entries for `period` from the configured backend.
	// Entry shape to render: { rank, handle, team?, tokens, delta?, league? }.
	let entries = $state<unknown[]>([]);
</script>

<header class="phead">
	<div>
		<h1>Leaderboard</h1>
		<p class="psub">
			{#if scope.cloud === 'synced'}
				Team ranking · {periods.find((p) => p.id === period)?.label}
			{:else if scope.cloud === 'degraded'}
				Cloud stale — rankings paused
			{:else}
				Off-machine rankings need cloud sync
			{/if}
		</p>
	</div>
</header>

<div class="row" style="margin-bottom: 14px">
	<div class="seg" role="group" aria-label="Period">
		{#each periods as p}
			<button class:active={period === p.id} onclick={() => (period = p.id)}>{p.label}</button>
		{/each}
	</div>
</div>

{#if scope.cloud !== 'synced'}
	<div class="card">
		<div class="empty" style="padding: 40px 0">
			<div style="font-size: 14px; font-weight: 600; color: var(--text-2); margin-bottom: 6px">
				Leaderboard needs off-machine data
			</div>
			{#if scope.cloud === 'degraded'}
				Cloud sync is unreachable right now — rankings would be stale.
				On-machine usage ({scope.thisMachineName}) is unaffected; see Tokens / Metering.
			{:else}
				Cloud sync is not configured on this daemon, so there is no off-machine
				data to rank. Your on-machine usage is fully tracked — see Tokens / Metering.
			{/if}
		</div>
	</div>
{:else if entries.length === 0}
	<div class="card">
		<div class="empty" style="padding: 40px 0">
			<div style="font-size: 14px; font-weight: 600; color: var(--text-2); margin-bottom: 6px">
				Leaderboard — {periods.find((p) => p.id === period)?.label}
			</div>
			Custom implementation goes here. Period switching is wired; entries render
			as hairline rows (rank · handle · team · tokens · delta).
		</div>
	</div>
{:else}
	<div class="card">
		<!-- TODO(custom): entry rows -->
	</div>
{/if}
