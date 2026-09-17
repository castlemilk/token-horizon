<script lang="ts">
	import { onMount } from 'svelte';
	import WidgetMorph, {
		type Phase,
		type EnterSpec,
		type ExitSpec,
		type TravelRoots,
		type TravelMark
	} from '../generic/WidgetMorph.svelte';
	import { rectSettled } from '../generic/morph';
	import ProviderIcon from '$lib/components/data/ProviderIcon.svelte';
	import EmptyState from '$lib/components/common/EmptyState.svelte';
	import { api, type UsageEvent } from '$lib/api';
	import { billableTok, fmtTok, fmtModel, poll } from '$lib/format';
	import { settings } from '$lib/settings.svelte';
	import { scope } from '$lib/scope.svelte';
	import { flip } from 'svelte/animate';

	/** Recent requests widget, two sizes sharing one modal.
	 *  Tile: latest requests (3 small · 5 medium) as compact rows —
	 *  provider icon, model, tokens, age. Modal: the full recent table,
	 *  like-for-like with the main page (time, tool, provider, model,
	 *  tokens, tok/s, cost + show-all + arrival flash).
	 *
	 *  Content for a shared-container morph (see WidgetMorph): rows
	 *  travel by request id to their modal table rows. */
	let {
		variant,
		speed = 1
	}: {
		variant: 'small' | 'medium';
		speed?: number;
	} = $props();

	const reduceMotion =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	const reduce = reduceMotion;

	const RECENT_LIMIT = 6;
	const N = $derived(variant === 'small' ? 3 : 5);

	let recent = $state<UsageEvent[]>([]);
	let booted = $state(false);
	let showAllRecent = $state(false);

	let phase = $state<Phase>('settle');
	let landed = $state(false);
	let bodyEl = $state<HTMLElement | null>(null);

	const tileRows = $derived(recent.slice(0, N));
	const tileKey = $derived(tileRows.map((e) => e.id).join(','));
	const visibleRecent = $derived(showAllRecent ? recent : recent.slice(0, RECENT_LIMIT));
	const recentTruncated = $derived(recent.length > RECENT_LIMIT);
	const multiMachine = $derived(scope.machines.length > 1);

	let freshId = $state<string | null>(null);
	$effect(() => {
		const top = recent[0]?.id;
		if (top && top !== freshId) freshId = top;
	});

	function fmtAgo(ts?: number): string {
		if (!ts) return '—';
		const s = Math.max(0, Date.now() / 1000 - ts);
		if (s < 90) return 'just now';
		if (s < 3600) return `${Math.round(s / 60)}m ago`;
		if (s < 86400) return `${Math.round(s / 3600)}h ago`;
		if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
		return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
	}
	function fmtTime(ts: number): string {
		return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}
	function bestCost(c: number, equiv?: number | null): number {
		return c > 0.0001 ? c : (equiv ?? 0);
	}
	async function load() {
		try {
			recent = (await api.events(`?limit=12${settings.showImports ? '' : '&metered=1'}`)).events;
		} catch {
			/* daemon down — keep last paint */
		}
	}

	onMount(() => {
		void load().finally(() => (booted = true));
		return poll(load, 5000);
	});

	// ---- morph contract: icons travel by request id (no text flights —
	// the container expansion carries the morph), rows cascade in ----
	const canFly = () => !reduce && tileRows.length > 0 && booted;
	const closeable = () => true;
	function marks(keys: string[], root: HTMLElement | null): TravelMark[] | null {
		if (!root) return null;
		return keys.map((key) => ({ key, el: root.querySelector(`[data-travel="${key}"]`) }));
	}
	const keys = () => tileRows.map((e) => e.id);
	const travelFrom = (_dir: 'open' | 'close', roots: TravelRoots) => marks(keys(), roots.box);
	const travelTo = (dir: 'open' | 'close', roots: TravelRoots) =>
		marks(keys(), dir === 'open' ? roots.box : roots.ghost);

	const enterOpen: EnterSpec[] = [
		{ select: '.rtable-wrap', kind: 'fade', at: (c) => c.landT + 0.06 * c.S },
		{ select: '.rtitle', kind: 'rise', at: (c) => c.landT + 0.12 * c.S }
	];
	const exitClose: ExitSpec[] = [{ select: '.rsec', at: (c) => 0.08 * c.S }];
</script>

{#snippet rowsSnip(describe: boolean)}
	<div class="rlist" class:landed role="img" aria-label="Latest {tileRows.length} requests">
		{#each tileRows as e}
			<div class="rrow" title="{e.vendor} · {e.model} · {fmtAgo(e.timestamp)}">
				<span class="ric" data-travel={e.id}><ProviderIcon vendor={e.vendor} model={e.model} size={20} /></span>
				<span class="rmodel mono">{fmtModel(e.model)}</span>
				<span class="rtoks num">{fmtTok(billableTok(e.tokens))}</span>
				{#if describe}
					<span class="rago">{fmtAgo(e.timestamp)}</span>
				{/if}
			</div>
		{/each}
		{#if tileRows.length === 0}
			<span class="pempty">{booted ? 'No requests yet' : '…'}</span>
		{/if}
	</div>
{/snippet}

{#snippet tileBody()}
	{#key tileKey}
		<div class="tile-col">
			<div class="thead" class:conceal={phase === 'fly'}>
				<span class="ttitle">Recent</span>
				{#if recent.length > 0}<span class="tcount num">{recent.length}</span>{/if}
			</div>
			{@render rowsSnip(true)}
		</div>
	{/key}
{/snippet}
{#snippet ghostSnip()}
	<div class="tile-col" aria-hidden="true">
		<div class="thead">
			<span class="ttitle">Recent</span>
			{#if recent.length > 0}<span class="tcount num">{recent.length}</span>{/if}
		</div>
		{@render rowsSnip(false)}
	</div>
{/snippet}
{#snippet modalContent()}
	<div class="rbody" bind:this={bodyEl}>
		<section class="rsec">
			<div class="rtitle" class:conceal={phase === 'fly'}>
				<span class="faint">Latest requests</span>
				{#if recent.length > 0}<span class="tcount num">{recent.length}</span>{/if}
			</div>
			{#if !booted}
				<div class="rankskel" aria-hidden="true">
					{#each Array(4) as _, i}
						<div class="rankskel-row wide" style="animation-delay: {i * 90}ms">
							<span class="skel"></span><span class="skel"></span>
						</div>
					{/each}
				</div>
			{:else if recent.length === 0}
				<EmptyState
					title="No requests yet"
					body="Each metered request shows up here the moment it completes."
					actionLabel="Set up metering"
					actionHref="/metering"
				/>
			{:else}
				<div class="recentfade" class:faded={!showAllRecent && recentTruncated}>
				<div class="rtable-wrap">
				<table>
					<thead>
						<tr>
							<th>Time</th>
							<th class="t-md">Tool</th>
							<th>Provider</th>
							<th>Model</th>
							{#if multiMachine}<th class="t-sm">Machine</th>{/if}
							<th class="right">Tokens</th>
							<th class="right t-md">tok/s</th>
							<th class="right t-sm">Cost</th>
						</tr>
					</thead>
					<tbody class:settled={phase === 'settle'}>
						{#each visibleRecent as e, i (e.id)}
							<tr
								class:flash={e.id === freshId}
								class:no-motion={reduceMotion}
								style="animation-delay: {Math.min(i * 45, 360)}ms"
								animate:flip={{ duration: reduceMotion ? 0 : 300 }}
							>
								<td class="mono dim">{fmtTime(e.timestamp)}</td>
								<td class="dim t-md">{e.product ?? (e.vendor === 'opencode-go' ? 'opencode' : '—')}</td>
								<td>
									<span style="display: flex; align-items: center; gap: 6px">
										<span data-travel={e.id} style="display: inline-flex; line-height: 0"><ProviderIcon vendor={e.vendor} size={20} /></span>
										<span class="dim">{e.vendor}</span>
									</span>
								</td>
								<td class="mono">
									<span style="display: flex; align-items: center; gap: 6px">
										<ProviderIcon vendor={e.vendor} model={e.model} size={20} />
										{e.model}
									</span>
								</td>
								{#if multiMachine}<td class="dim t-sm">{e.machineAlias ?? '—'}</td>{/if}
								<td class="right num" style="white-space: nowrap">
									{e.tokens.input > 0 ? `${fmtTok(e.tokens.input)} in` : ''}
									{e.tokens.input > 0 && (e.tokens.output > 0 || e.tokens.reasoning > 0) ? ' · ' : ''}
									{e.tokens.output > 0 ? `${fmtTok(e.tokens.output)} out` : ''}
									{#if e.tokens.reasoning > 0}<span class="dim"> · {fmtTok(e.tokens.reasoning)} think</span>{/if}
									{#if e.tokens.cacheRead > 0}<span class="faint t-sm"> · +{fmtTok(e.tokens.cacheRead)} cached</span>{/if}
								</td>
								<td class="right num dim t-md">
									{#if e.generationTokPerSec != null}
										{e.generationTokPerSec.toFixed(0)}
									{:else if e.latencyMs != null && e.latencyMs > 0 && e.tokens.output > 0}
										<span class="faint" title="Inferred: output tokens ÷ total request duration — includes prompt processing, so it's a lower bound. Prompt-processing speed can't be inferred from duration."
											>≈{(e.tokens.output / (e.latencyMs / 1000)).toFixed(0)}</span>
									{:else}
										—
									{/if}
								</td>
								<td class="right num dim t-sm">{bestCost(e.cost, e.costEquivalent) > 0.0001 ? `$${bestCost(e.cost, e.costEquivalent).toFixed(4)}` : '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				</div>
				</div>
				{#if recentTruncated}
					<button class="showall" onclick={() => (showAllRecent = !showAllRecent)}>
						{showAllRecent ? 'Show fewer requests' : `Show all ${recent.length} requests`}
					</button>
				{/if}
			{/if}
		</section>
	</div>
{/snippet}

<WidgetMorph
	size={variant === 'small' ? 'sm' : 'md'}
	{speed}
	tileLabel="Recent requests — tap to expand"
	title="Recent requests"
	bind:phase
	bind:landed
	{canFly}
	{closeable}
	{travelFrom}
	{travelTo}
	awaitSettled={() => rectSettled(() => bodyEl)}
	staggerOpen={0.03}
	staggerClose={0.02}
	{enterOpen}
	{exitClose}
	tile={tileBody}
	modalBody={modalContent}
	ghostBody={ghostSnip}
	headerExtra={undefined}
/>

<style>
	.tile-col {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 8px;
	}
	.thead, .rtitle {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.ttitle {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-3);
	}
	.tcount {
		font-size: 11px;
		font-weight: 700;
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
	}
	.conceal {
		visibility: hidden;
	}
	/* tile rows */
	.rlist {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 9px;
		min-height: 0;
	}
	.rrow {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		animation: rowin 0.4s cubic-bezier(0.2, 0.9, 0.3, 1.2) backwards;
	}
	.ric {
		display: inline-flex;
		line-height: 0;
		flex: none;
	}
	.rlist.landed .rrow {
		animation: none;
	}
	@keyframes rowin {
		from { transform: translateY(-6px); opacity: 0; }
		to { transform: none; opacity: 1; }
	}
	.rmodel {
		flex: 1;
		font-size: 11.5px;
		color: var(--text-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.rtoks {
		font-size: 12px;
		font-weight: 700;
		letter-spacing: -0.02em;
		font-variant-numeric: tabular-nums;
		flex: none;
	}
	.rago {
		font-size: 10px;
		color: var(--text-3);
		flex: none;
		font-variant-numeric: tabular-nums;
	}
	.pempty {
		font-size: 12px;
		color: var(--text-3);
		text-align: center;
	}
	/* modal: like-for-like recent table */
	.rbody {
		display: flex;
		flex-direction: column;
		padding: 10px 8px 8px;
	}
	.rsec {
		border-radius: 18px;
		padding: 12px 22px 20px;
		background: color-mix(in srgb, var(--bg-raised) 45%, transparent);
	}
	.rtitle {
		margin-bottom: 12px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.recentfade {
		overflow-x: auto;
	}
	.recentfade.faded {
		-webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 84px), transparent 100%);
		mask-image: linear-gradient(to bottom, #000 calc(100% - 84px), transparent 100%);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12.5px;
	}
	th {
		text-align: left;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-3);
		padding: 8px 12px;
		border-bottom: 1px solid var(--line);
		white-space: nowrap;
	}
	td {
		padding: 10px 12px;
		border-bottom: 1px solid var(--line);
		vertical-align: middle;
	}
	tbody tr:last-child td {
		border-bottom: none;
	}
	.right { text-align: right; }
	.mono { font-family: var(--font-mono); }
	.dim { color: var(--text-2); }
	.faint { color: var(--text-3); }
	.num { font-variant-numeric: tabular-nums; }
	/* rows cascade only once the flight lands — during 'fly' the
	   morph owns the pixels, so starting here would play unseen */
	tbody.settled tr {
		animation: rrowin 0.45s cubic-bezier(0.2, 0.9, 0.3, 1) backwards;
	}
	tbody.settled tr.no-motion {
		animation: none;
	}
	@keyframes rrowin {
		from { opacity: 0; transform: translateY(-10px); }
		to { opacity: 1; transform: none; }
	}
	@keyframes rowfresh {
		0% { background: var(--accent-soft); }
		100% { background: transparent; }
	}
	tbody tr.flash td {
		animation: rowfresh 1.8s ease-out;
	}
	.showall {
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text-3);
		font: inherit;
		font-size: 12px;
		padding: 10px 4px 2px;
		cursor: pointer;
	}
	.showall:hover {
		color: var(--text);
	}
	@keyframes skelsweep {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}
	.skel {
		display: block;
		border-radius: 6px;
		background: linear-gradient(
			100deg,
			var(--track) 40%,
			light-dark(rgb(0 0 0 / 0.1), rgb(255 255 255 / 0.14)) 50%,
			var(--track) 60%
		);
		background-size: 200% 100%;
		animation: skelsweep 1.4s linear infinite;
	}
	.rankskel {
		display: grid;
		gap: 10px;
		margin-top: 20px;
	}
	.rankskel-row {
		animation: skelin 0.5s ease backwards;
	}
	@keyframes skelin {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: none; }
	}
	.rankskel-row {
		display: grid;
		grid-template-columns: 1fr 2fr 1fr;
		gap: 10px;
	}
	.rankskel-row.wide {
		grid-template-columns: 1fr 3fr;
	}
	.rankskel-row .skel {
		height: 22px;
	}
	@media (max-width: 900px) {
		.t-md { display: none; }
	}
	@media (max-width: 640px) {
		table { font-size: 11.5px; }
		th { font-size: 10.5px; }
		td { padding: 10px 12px; }
		.t-sm { display: none; }
	}
	@media (prefers-reduced-motion: reduce) {
		.rrow { animation: none; }
		.skel { animation: none; }
		.rankskel-row { animation: none; }
	}
</style>
