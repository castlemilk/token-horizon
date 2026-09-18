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
	import { api, type ProviderSummary } from '$lib/api';
	import { billableTok, fmtTok, poll } from '$lib/format';
	import { HEAT, providerAccent } from '$lib/colors';
	import { settings } from '$lib/settings.svelte';
  import { AspectRatio } from 'bits-ui'

	/** Home-screen totals widget, two sizes sharing one modal.
	 *  Tile: three counters (tokens · requests · cost). Modal: what those
	 *  numbers are made of — token composition, cost bridge (measured vs
	 *  list), and per-provider bars. Chart work comes later; bars carry it.
	 *
	 *  Content for a shared-container morph (see WidgetMorph): data +
	 *  markup + travel pairing here, choreography in the shell. Each tile
	 *  counter flies to its modal section headline via data-travel keys.
	 *
	 *  `speed` scales every duration (1 = brisk). Billable semantics
	 *  throughout (excludes cache reads), like the main tab. */
	let {
		providers = undefined,
		variant,
		speed = 1
	}: {
		providers?: ProviderSummary[];
		variant: 'small' | 'medium';
		speed?: number;
	} = $props();

	// Own data feed when the host passes none (home bento).
	let owned = $state<ProviderSummary[]>([]);
	onMount(() =>
		poll(async () => {
			try {
				owned = (await api.summary(!settings.showImports)).providers;
			} catch {
				/* daemon down — keep last paint */
			}
		}, 10000)
	);
	const feed = $derived(providers ?? owned);

	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	const totals = $derived.by(() => {
		const t = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
		let requests = 0;
		let measured = 0;
		let list = 0;
		for (const p of feed) {
			t.input += p.tokens.input;
			t.output += p.tokens.output;
			t.reasoning += p.tokens.reasoning;
			t.cacheRead += p.tokens.cacheRead;
			t.cacheWrite += p.tokens.cacheWrite;
			requests += p.requests;
			measured += p.cost;
			list += p.costEquivalent ?? 0;
		}
		return { t, requests, measured, list };
	});
	const billable = $derived(
		totals.t.input + totals.t.output + totals.t.reasoning + totals.t.cacheWrite
	);
	/** Hero semantics: actual charge where present, else list equivalent. */
	const displayCost = $derived(
		feed.reduce(
			(s, p) => s + (p.cost > 0.0001 ? p.cost : (p.costEquivalent ?? 0)),
			0
		)
	);
	const rows = $derived(
		feed
			.map((p) => ({
				vendor: p.vendor,
				tokens: billableTok(p.tokens),
				requests: p.requests,
				accent: providerAccent(p.vendor)
			}))
			.sort((a, b) => b.tokens - a.tokens)
			.map((r) => ({ ...r, share: billable > 0 ? (r.tokens / billable) * 100 : 0 }))
	);

	const fmtMoney = (v: number) => (v > 0.0001 ? `$${v.toFixed(2)}` : '—');
	const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US');

	const parts = $derived([
		{ label: 'Input', value: totals.t.input, color: '#5b9dff' },
		{ label: 'Output', value: totals.t.output, color: '#34c759' },
		{ label: 'Reasoning', value: totals.t.reasoning, color: '#b48cff' },
		{ label: 'Cache write', value: totals.t.cacheWrite, color: '#ffb340' }
	]);

	// Engine-owned, bound here so content can gate on it without reaching
	// into WidgetMorph.
	let phase = $state<Phase>('settle');
	let bodyEl = $state<HTMLElement | null>(null);

	// Live request pings: every new request fires 3 green arrows that
	// rise and fade through the tile background over 1s (tile only —
	// never the measuring ghost, never the modal).
	interface Ping {
		id: number;
		x: number;
		delay: number;
		size: number;
	}
	let pings = $state<Ping[]>([]);
	let burstSeq = $state(0);
	let lastRequests = -1;
	let pingTimer = 0;
	$effect(() => {
		const n = totals.requests;
		if (lastRequests < 0) {
			lastRequests = n; // first sighting establishes the baseline
			return;
		}
		if (n <= lastRequests || reduce) {
			lastRequests = n;
			return;
		}
		lastRequests = n;
		burstSeq++;
		const id = Date.now();
		pings = [0, 1, 2].map((k) => ({
			id: id + k,
			x: 8 + Math.random() * 80,
			delay: k * 0.2 + Math.random() * 0.15,
			size: 10 + Math.random() * 6
		}));
		window.clearTimeout(pingTimer);
		pingTimer = window.setTimeout(() => {
			pings = pings.filter((p) => p.id < id || p.id > id + 2);
		}, 1900);
	});

	// ---- morph contract (see WidgetMorph) ----
	const canFly = () => !reduce;
	const closeable = () => true;

	function marksOf(root: HTMLElement | null): TravelMark[] | null {
		if (!root) return null;
		return [...root.querySelectorAll('[data-travel]')].map((el) => ({
			key: el.getAttribute('data-travel') ?? '',
			el
		}));
	}
	const travelFrom = (_dir: 'open' | 'close', roots: TravelRoots) => marksOf(roots.box);
	const travelTo = (dir: 'open' | 'close', roots: TravelRoots) =>
		marksOf(dir === 'open' ? roots.box : roots.ghost);

	const enterOpen: EnterSpec[] = [
		// Numbers are travel targets — they arrive riding their flight
		// clones; rising .csec-h would re-animate them after landing.
		// The rise belongs to the subtitles beside them.
		{ select: '.csec-h .csub', kind: 'rise', at: (c) => c.landT + 0.1 * c.S },
		{ select: '.comp-fill', kind: 'fade', at: (c) => c.landT + 0.16 * c.S },
		{ select: '.prow', kind: 'rise', at: (c) => c.landT + 0.2 * c.S }
	];
	const exitClose: ExitSpec[] = [{ select: '.csec', at: (c) => 0.08 * c.S }];
</script>

{#snippet counters(describe: boolean)}
	<div
		class="counts"
		class:row={variant === 'medium'}
		style:--heat={HEAT}
		role="img"
		aria-label="{fmtTok(billable)} tokens, {fmtInt(totals.requests)} requests, {fmtMoney(displayCost)}"
	>
		{#if describe && pings.length > 0}
			{#key burstSeq}
				<span class="wash" aria-hidden="true"></span>
				<span class="ping-layer" aria-hidden="true">
					{#each pings as p (p.id)}
						<svg
							class="ping"
							width={p.size}
							height={p.size}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.6"
							stroke-linecap="round"
							stroke-linejoin="round"
							style:left="{p.x}%"
							style:animation-delay="{p.delay}s"
						><path d="M6 15l6-6 6 6"/></svg>
					{/each}
				</span>
			{/key}
		{/if}
		<div class="count">
			<span class="cv num v-tokens" data-travel="tokens">{fmtTok(billable)}</span>
			<span class="cl">tokens</span>
		</div>
		<div class="count">
			<span class="cv num v-requests" data-travel="requests">{fmtInt(totals.requests)}</span>
			<span class="cl">requests</span>
		</div>
		<div class="count">
			<span class="cv num v-cost" data-travel="cost">{fmtMoney(displayCost)}</span>
			<span class="cl">cost</span>
		</div>
	</div>
{/snippet}

{#snippet tileBody()}
	{@render counters(true)}
{/snippet}
{#snippet ghostSnip()}
	{@render counters(false)}
{/snippet}
{#snippet modalContent()}
	<div class="cbody" bind:this={bodyEl}>
			<section class="csec">
				<div class="csec-h" class:conceal={phase === 'fly'}>
					<span class="ctotal num v-tokens" data-travel="tokens">{fmtTok(billable)}</span>
					<span class="csub">tokens</span>
				</div>
				<div class="compbar" role="img" aria-label="Token composition">
					{#each parts as p}
						{#if p.value > 0}
							<span
								class="comp-fill"
								style:width="{billable > 0 ? (p.value / billable) * 100 : 0}%"
								style:background={p.color}
								title="{p.label} — {fmtTok(p.value)}"
							></span>
						{/if}
					{/each}
				</div>
				<div class="legend">
					{#each parts as p}
						{#if p.value >0}
							<span class="litem"><i 
							style:background={p.color}
							></i>{p.label} {fmtTok(p.value)}</span>
						{/if}
					{/each}
				</div>
			</section>
			<section class="csec">
				<div class="csec-h" class:conceal={phase === 'fly'}>
					<span class="ctotal num v-requests" data-travel="requests">{fmtInt(totals.requests)}</span>
					<span class="csub">requests</span>
				</div>
				<div class="compbar" role="img" aria-label="Requests by provider">
					{#each rows as r}
						{#if r.requests > 0}
							<span
								class="comp-fill"
								style:width="{totals.requests > 0 ? (r.requests / totals.requests) * 100 : 0}%"
								style:background={r.accent}
								title="{r.vendor} — {fmtInt(r.requests)} requests"
							></span>
						{/if}
					{/each}
				</div>
				<div class="legend center">
					{#each rows as r}
						<span class="litem"><i style:background={r.accent}></i>{r.vendor} {fmtInt(r.requests)}</span>
					{/each}
				</div>
			</section>
			<section class="csec">
				<div class="csec-h" class:conceal={phase === 'fly'}>
					<span class="ctotal num v-cost" data-travel="cost">{fmtMoney(displayCost)}</span>
					<span class="csub">total cost</span>
				</div>
			</section>
		</div>
	{/snippet}

<WidgetMorph
	size={variant === 'small' ? 'sm' : 'md'}
	{speed}
	tileLabel="Totals — tap to expand"
	title="Totals"
	bind:phase
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
/>

<style>
	.counts {
		flex: 1;
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 10px;
		margin: 0 10px;
	}
	.counts.row {
		flex-direction: row;
		align-items: center;
		gap: 30px;
	}
	.count {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 3px;
	}
	.cv {
		font-variant-numeric: tabular-nums;
		line-height: 1;
		white-space: nowrap;
		font-size: 21px;
	}
	.v-tokens {
		font-weight: 750;
		letter-spacing: -0.045em;
	}
	.v-requests {
		font-weight: 450;
		letter-spacing: -0.01em;
	}
	.v-cost {
		font-family: ui-serif, Georgia, 'Charter', 'Times New Roman', serif;
		font-style: italic;
		font-weight: 550;
		letter-spacing: -0.01em;
	}
	.cl {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-3);
	}
	/* live request pings: green wash + arrows rising through the background.
	   Both layers span the whole tile (negative inset cancels the tile
	   padding + .counts margin) and breathe in/out softly. */
	.wash {
		position: absolute;
		inset: -26px -26px;
		border-radius: 18px;
		pointer-events: none;
		z-index: 0;
		background: radial-gradient(
			ellipse 100% 80% at 50% 90%,
			color-mix(in srgb, var(--heat) 14%, transparent),
			transparent 70%
		);
		animation: washfade 2.4s ease-in-out backwards;
	}
	@keyframes washfade {
		0% { opacity: 0; }
		25% { opacity: 0.55; }
		100% { opacity: 0; }
	}
	.ping-layer {
		position: absolute;
		inset: -26px -26px;
		border-radius: 18px;
		overflow: hidden;
		pointer-events: none;
		z-index: 0;
	}
	.ping {
		position: absolute;
		bottom: 16%;
		color: var(--heat, #34c759);
		opacity: 0;
		animation: pingrise 2s ease-in-out backwards;
	}
	@keyframes pingrise {
		0% { opacity: 0; transform: translateY(10px); }
		25% { opacity: 0.7; }
		100% { opacity: 0; transform: translateY(-44px); }
	}
	/* ---- modal sections ---- */
	.cbody {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.csec {
		background: color-mix(in srgb, var(--bg-raised) 55%, transparent);
		border: 0;
		border-radius: 14px;
		padding: 16px 16px 14px;
	}
	.csec-h {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin-bottom: 2px;
	}
	.ctotal {
		font-size: 23px;
		line-height: 1.05;
		font-variant-numeric: tabular-nums;
		/* Weight/family/tracking come from the v-* voice classes — the SAME
		   voice as the tile counter with that data-travel key, so the flight
		   clone (tile-sized) scales onto this headline with zero font pop. */
	}
	.csub {
		font-size: 23px;
		color: var(--text-3);
	}
	.conceal {
		visibility: hidden;
	}
	.compbar {
		display: flex;
		height: 20px;
		border-radius: 999px;
		overflow: hidden;
		background: var(--track);
		margin-top: 10px;
	}
	.comp-fill {
		display: block;
		height: 100%;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 4px 12px;
		margin-top: 20px;
	}
	.litem {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 12px;
		color: var(--text-3);
		font-variant-numeric: tabular-nums;
	}
	.litem i {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex: none;
	}
	.cacheline {
		margin: 8px 0 0;
		font-size: 10.5px;
		color: var(--text-3);
		text-align: center;
	}
	@media (max-width: 640px) {
		.counts.row {
			gap: 16px;
		}
	}
</style>
