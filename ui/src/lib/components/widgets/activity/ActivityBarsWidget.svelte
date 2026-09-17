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
	import VBars from '$lib/components/data/VBars.svelte';
	import CountUp from '$lib/components/data/CountUp.svelte';
	import ProviderIcon from '$lib/components/data/ProviderIcon.svelte';
	import EmptyState from '$lib/components/common/EmptyState.svelte';
	import { api, type ProviderSummary, type UsageEvent } from '$lib/api';
	import { billableTok, fmtTok, poll } from '$lib/format';
	import { fmtModel } from '$lib/format';
	import { providerAccent } from '$lib/colors';
	import { settings } from '$lib/settings.svelte';
	import { fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import * as Accordion from '$lib/components/ui/accordion/index.js';

	/** Tiny activity widget: last N buckets, resolution via vertical picker.
	 *  small: 6 bars · medium: 10 bars. Rightmost bar reuses the VBars
	 *  arrival language (+{delta} green label + green column wash) when its
	 *  value grows. Modal is a like-for-like copy of the main activity +
	 *  provider charts (chartmod + rankmod). Bars poll every 5s. */
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

	const windows = ['1D', '1W', '1M', '3M', '1Y'];
	const windowSpec: Record<string, [number, number]> = {
		'1D': [300, 86400],
		'1W': [900, 7 * 86400],
		'1M': [3600, 31 * 86400],
		'3M': [86400, 93 * 86400],
		'1Y': [86400, 365 * 86400]
	};

	const N = $derived(variant === 'small' ? 6 : 10);
	const MODEL_LIMIT = 5;

	let window_ = $state('1D');
	let booted = $state(false);
	let selected = $state<{ vendor: string; model?: string } | null>(null);
	let showAllModels = $state<Record<string, boolean>>({});

	// Modal chart state — like-for-like with +page.svelte chartmod.
	let chartPoints = $state<{ ts: number; value: number }[]>([]);
	let chartCost = $state(0);
	let chartRequests = $state(0);
	let chartFrom = $state(0);
	let chartTo = $state(0);
	// Server-confirmed bucket tick (BucketResolution.snap can remap the
	// requested value) — tile slots must use THIS, not the request.
	let tileRes = $state(300);
	// Ranking state — like-for-like with +page.svelte rankmod.
	let summary = $state<ProviderSummary[]>([]);
	let recent = $state<UsageEvent[]>([]);

	let phase = $state<Phase>('settle');
	let landed = $state(false);
	let bodyEl = $state<HTMLElement | null>(null);
	// Modal width drives table density (viewport queries can't see the
	// modal): xl shows everything incl. cost → lg drops input/output/
	// thinking → compact also drops cost → minimal keeps tokens only.
	let modalW = $state(0);
	const tier = $derived(
		modalW <= 0 ? 3 : modalW < 520 ? 0 : modalW < 640 ? 1 : modalW < 800 ? 2 : 3
	);

	function bestCost(c: number, equiv?: number | null): number {
		return c > 0.0001 ? c : (equiv ?? 0);
	}
	function fmtCost(c: number, equiv?: number | null): string {
		const v = bestCost(c, equiv);
		return v > 0.0001 ? `$${v.toFixed(2)}` : '—';
	}
	function fmtAgo(ts?: number): string {
		if (!ts) return '—';
		const s = Math.max(0, Date.now() / 1000 - ts);
		if (s < 90) return 'just now';
		if (s < 3600) return `${Math.round(s / 60)}m ago`;
		if (s < 86400) return `${Math.round(s / 3600)}h ago`;
		if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
		return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
	}

	const loadChart = async () => {
		const [resolution, span] = windowSpec[window_] ?? windowSpec['1M'];
		const from = Math.floor(Date.now() / 1000) - span;
		chartFrom = from;
		chartTo = Math.floor(Date.now() / 1000);
		let extra = '';
		if (selected) {
			extra += `&vendor=${encodeURIComponent(selected.vendor)}`;
			if (selected.model) extra += `&model=${encodeURIComponent(selected.model)}`;
		}
		try {
			const r = await api.buckets(resolution, from, !settings.showImports, extra);
			const byStart = new Map<number, number>();
			for (const b of r.buckets) {
				byStart.set(b.start, (byStart.get(b.start) ?? 0) + billableTok(b.tokens));
			}
			chartCost = r.buckets.reduce((s, b) => s + bestCost(b.cost, b.costEquivalent), 0);
			chartRequests = r.buckets.reduce((s, b) => s + (b.requests ?? 0), 0);
			tileRes = r.resolution || resolution;
			chartPoints = [...byStart.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([start, value]) => ({ ts: start, value }));
		} catch {
			/* daemon down */
		}
	};

	function select(vendor: string, model?: string) {
		if (selected?.vendor === vendor && selected?.model === model) selected = null;
		else selected = { vendor, model };
		void loadChart();
	}

	const loadAll = async () => {
		const span = (windowSpec[window_] ?? windowSpec['1M'])[1];
		const from = Math.floor(Date.now() / 1000) - span;
		chartFrom = from;
		chartTo = Math.floor(Date.now() / 1000);
		try {
			[summary, recent] = await Promise.all([
				api.summary(!settings.showImports, from).then((r) => r.providers),
				api.events(`?limit=12${settings.showImports ? '' : '&metered=1'}`).then((r) => r.events)
			]);
		} catch {
			/* layout shows daemon-down state */
		}
		void loadChart();
	};

	onMount(() => {
		void loadAll().finally(() => (booted = true));
		return poll(loadAll, 5000);
	});
	$effect(() => {
		void window_;
		void loadAll();
	});

	function step(d: number, e?: Event) {
		e?.stopPropagation();
		if (phase !== 'settle') return;
		const i = windows.indexOf(window_);
		const next = Math.min(windows.length - 1, Math.max(0, i + d));
		if (windows[next] === window_) return;
		window_ = windows[next];
	}

	// ---- tile: last N buckets derived from the live chart feed ----
	// Slots use the server-confirmed tick so they line up with the
	// returned bucket starts; the last slot is the live partial bucket.
	const tilePoints = $derived.by(() => {
		const resolution = tileRes;
		const byStart = new Map(chartPoints.map((p) => [p.ts, p.value]));
		const base = Math.floor(chartTo / resolution) * resolution;
		return Array.from({ length: N }, (_, i) => {
			const ts = base - (N - 1 - i) * resolution;
			return { ts, value: byStart.get(ts) ?? 0 };
		});
	});
	const maxV = $derived(Math.max(1, ...tilePoints.map((p) => p.value)));
	// Period total (full window) — shared verbatim with the modal headline
	// so the atotal traveler never font-pops on landing.
	const tileTotal = $derived(chartPoints.reduce((s, p) => s + p.value, 0));

	/** Newest request id — flashes once when a new request lands. */
	let freshId = $state<string | null>(null);
	$effect(() => {
		const top = recent[0]?.id;
		if (top && top !== freshId) freshId = top;
	});
	const ping = $derived(
		recent[0] ? { id: recent[0].id, tokens: billableTok(recent[0].tokens) } : null
	);

	// Rightmost arrival flash — same driver as VBars: fires only when a
	// NEW request concludes (ping id change). Polls with no new requests
	// stay quiet; the state self-clears so a morph remount never replays
	// a stale flash on close.
	let flash = $state<{ delta: number; n: number } | null>(null);
	let pingSeen = $state<string | null>(null);
	let pingPrimed = $state(false);
	let flashTimer = 0;
	$effect(() => {
		if (phase !== 'settle') flash = null;
	});
	$effect(() => {
		const id = ping?.id ?? null;
		if (!pingPrimed) {
			pingPrimed = true;
			pingSeen = id;
			return;
		}
		if (!id || id === pingSeen || reduce || phase !== 'settle') return;
		pingSeen = id;
		window.clearTimeout(flashTimer);
		flash = { delta: ping?.tokens ?? 0, n: (flash?.n ?? 0) + 1 };
		flashTimer = window.setTimeout(() => (flash = null), 1600);
	});

	// ---- provider comparison ranking (like-for-like with +page) ----
	interface RankRow {
		key: string;
		vendor: string;
		model?: string;
		label: string;
		tokens: number;
		input: number;
		output: number;
		thinking: number;
		cost: number;
		costEquivalent?: number | null;
		share: number;
		lastEvent?: number;
	}
	const rankRows = $derived.by((): RankRow[] => {
		return summary.map((p) => ({
			key: p.vendor,
			vendor: p.vendor,
			label: p.vendor,
			tokens: billableTok(p.tokens),
			input: p.tokens.input,
			output: p.tokens.output,
			thinking: p.tokens.reasoning,
			cost: p.cost,
			costEquivalent: p.costEquivalent ?? null,
			share: 0,
			lastEvent: Math.max(0, ...p.models.map((m) => m.lastEvent ?? 0)) || undefined
		}));
	});
	const rankTotal = $derived(rankRows.reduce((s, r) => s + r.tokens, 0));
	const ranked = $derived(
		[...rankRows]
			.sort((a, b) => b.tokens - a.tokens)
			.map((r) => ({ ...r, share: rankTotal > 0 ? (r.tokens / rankTotal) * 100 : 0 }))
	);

	// ---- morph contract (heatmap pattern: explicit keys, both ends exist) ----
	// Single traveler: the period total. The picker does NOT travel
	// (tile arrows vs modal seg are different controls). Bars are NOT
	// travelers (modal VBars re-bins by width, so ts keys can't pair) —
	// they join the post-landing cascade via enterOpen instead.
	const canFly = () => !reduce && tilePoints.length > 0 && booted;
	const closeable = () => true;
	function pair(keys: string[], root: HTMLElement | null): TravelMark[] | null {
		if (!root) return null;
		return keys.map((key) => ({
			key,
			el: root.querySelector(`[data-travel="${key}"]`)
		}));
	}
	const KEYS = ['atotal'];
	const travelFrom = (_dir: 'open' | 'close', roots: TravelRoots) => pair(KEYS, roots.box);
	const travelTo = (dir: 'open' | 'close', roots: TravelRoots) =>
		pair(KEYS, dir === 'open' ? roots.box : roots.ghost);

	// ---- tile sky: day-cycle gradient + sun/moon orb ----
	// Derived from chartTo so it refreshes on every 5s poll without a
	// second timer. Tile-only: the modal keeps its plain background.
	const sky = $derived.by(() => {
		const d = new Date((chartTo || Date.now() / 1000) * 1000);
		const h = d.getHours() + d.getMinutes() / 60;
		const day = h >= 7 && h < 17;
		const dawn = h >= 5 && h < 7;
		const dusk = h >= 17 && h < 20;
		// Orb rides an arc across the tile while visible.
		const span = day ? { a: 7, b: 17 } : dawn ? { a: 5, b: 7 } : dusk ? { a: 17, b: 20 } : { a: 20, b: 29 };
		const t = Math.min(1, Math.max(0, (h < span.a && span.b > 24 ? h + 24 - span.a : h - span.a) / (span.b - span.a)));
		const left = `${8 + t * 84}%`;
		const top = `${68 - Math.sin(t * Math.PI) * 48}%`;
		if (day)
			return {
				name: 'day',
				bg: 'linear-gradient(180deg, light-dark(#8ec5fc, #0b2a5b) 0%, light-dark(#e0f2fe, #123a7d) 100%)',
				orb: 'sun',
				left,
				top
			};
		if (dawn)
			return {
				name: 'dawn',
				bg: 'linear-gradient(180deg, light-dark(#fda4af, #3b1d4e) 0%, light-dark(#fed7aa, #7c2d52) 100%)',
				orb: 'sun',
				left,
				top
			};
		if (dusk)
			return {
				name: 'dusk',
				bg: 'linear-gradient(180deg, light-dark(#c4b5fd, #1e1b4b) 0%, light-dark(#fdba74, #9a3412) 100%)',
				orb: 'sun',
				left,
				top
			};
		return {
			name: 'night',
			bg: 'linear-gradient(180deg, light-dark(#1e1b4b, #020617) 0%, light-dark(#312e81, #0f172a) 100%)',
			orb: 'moon',
			left,
			top
		};
	});

	const enterOpen: EnterSpec[] = [
		{ select: '.chartwrap', kind: 'fade', excludeTravel: true, at: (c) => c.landT + 0.04 * c.S },
		{ select: '.chart-stats > *', kind: 'rise', at: (c) => c.landT + 0.12 * c.S },
		{ select: '.sharebar', kind: 'fade', at: (c) => c.landT + 0.2 * c.S },
		{ select: '.ranklist > div', kind: 'rise', y: 8, at: (c) => c.landT + 0.24 * c.S }
	];
	const exitClose: ExitSpec[] = [
		{ select: '.chartwrap', dur: 0.18, at: () => 0 },
		{ select: '.rankmod, .chart-stats', at: (c) => 0.08 * c.S }
	];
</script>

{#snippet vpicker()}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="vpick"
		role="group"
		aria-label="Resolution"
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<button
			class="vbtn"
			onclick={(e) => step(-1, e)}
			disabled={windows.indexOf(window_) <= 0 || phase !== 'settle'}
			aria-label="Finer resolution"
		>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>
		</button>
		<span class="vval num" title="Resolution window">{window_}</span>
		<button
			class="vbtn"
			onclick={(e) => step(1, e)}
			disabled={windows.indexOf(window_) >= windows.length - 1 || phase !== 'settle'}
			aria-label="Coarser resolution"
		>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
		</button>
	</div>
{/snippet}

{#snippet bars(describe: boolean)}
	<div
		class="bchart"
		class:landed
		role="img"
		aria-label="Last {N} buckets · {window_} · {fmtTok(tileTotal)} tokens"
	>
		{#each tilePoints as p, i}
			{@const last = i === tilePoints.length - 1}
			{@const h = maxV > 0 ? Math.max((p.value / maxV) * 100, p.value > 0 ? 6 : 2) : 2}
			<div class="bcol" class:last title="{new Date(p.ts * 1000).toLocaleString()} — {fmtTok(p.value)}">
				{#if last && flash && describe && phase === 'settle'}
					{#key flash.n}
						<span class="bflash" aria-hidden="true"></span>
						<span class="bdelta num" aria-hidden="true">+{fmtTok(flash.delta)}</span>
					{/key}
				{/if}
				<span
					class="bar"
					class:hot={last && flash && describe && phase === 'settle'}
					style:height="{h}%"
					style={reduce ? '' : `animation-delay: ${i * 35}ms`}
				></span>
			</div>
		{/each}
	</div>
{/snippet}

{#snippet skyBg()}
	{#key sky.name}
		<div class="tile-sky" aria-hidden="true" style:background={sky.bg}>
			<span
				class="orb"
				class:sun={sky.orb === 'sun'}
				class:moon={sky.orb === 'moon'}
				style:left={sky.left}
				style:top={sky.top}
			></span>
		</div>
	{/key}
{/snippet}

{#snippet tileBody()}
	<div class="tile-row">
		{@render skyBg()}
		<div class="tile-main">
			<div class="tstat" class:conceal={phase === 'fly'}>
				<span class="btotal num" data-travel="atotal">{fmtTok(tileTotal)}</span>
				<span class="bsub">tokens</span>
			</div>
			{@render bars(true)}
		</div>
		{@render vpicker()}
	</div>
{/snippet}
{#snippet ghostSnip()}
	<div class="tile-row">
		{@render skyBg()}
		<div class="tile-main">
			<div class="tstat" aria-hidden="true">
				<span class="btotal num" data-travel="atotal">{fmtTok(tileTotal)}</span>
				<span class="bsub">tokens</span>
			</div>
			{@render bars(false)}
		</div>
		{@render vpicker()}
	</div>
{/snippet}
{#snippet modalContent()}
	<div class="cbody t{tier}" bind:this={bodyEl} bind:clientWidth={modalW}>
		<section class="mod chartmod">
			<div class="picker-row">
				<div class="seg" role="group" aria-label="Window">
					{#each windows as w}
						<button
							class:active={window_ === w}
							onclick={() => { window_ = w; void loadAll(); }}
						>{w}</button>
					{/each}
				</div>
				{#if selected}
					<button class="chip-clear" onclick={() => select(selected!.vendor, selected!.model)}
						>✕ {selected.model ?? selected.vendor}</button>
				{/if}
			</div>
			{#if !booted}
				<div class="skel skel-chart"></div>
			{:else}
			<div class="chartwrap">
				<VBars points={chartPoints} from={chartFrom} to={chartTo} {ping} />
				<div class="chart-stats">
					<div class="chart-stat">
						<span class="chart-stat-value"><CountUp value={chartCost} format={(n) => `$${n.toFixed(2)}`} /></span>
						<span class="chart-stat-label">cost{selected ? ` · ${selected.model ?? selected.vendor}` : ''}</span>
					</div>
					<div class="chart-stat" class:conceal={phase === 'fly'}>
						<span class="chart-stat-value num" data-travel="atotal"><CountUp value={tileTotal} /></span>
						<span class="chart-stat-label">tokens</span>
					</div>
					<div class="chart-stat">
						<span class="chart-stat-value"><CountUp value={chartRequests} format={(n) => Math.round(n).toLocaleString()} /></span>
						<span class="chart-stat-label">requests</span>
					</div>
				</div>
			</div>
			{/if}
		</section>

		<section class="mod rankmod">
			{#if !booted}
				<div class="rankskel" aria-hidden="true">
					{#each Array(5) as _}
						<div class="rankskel-row"><span class="skel"></span><span class="skel"></span><span class="skel"></span></div>
					{/each}
				</div>
			{:else if ranked.length === 0}
				<EmptyState
					title="No usage measured yet"
					body="Point a tool at a loopback meter and its requests will land here, per provider and model."
					actionLabel="Set up metering"
					actionHref="/metering"
				/>
			{:else}
				<div class="sharebar" role="img" aria-label="Provider share of token usage" style="margin-top: 8px">
					{#each ranked as r}
						<button
							class="seg-segment"
							class:dimmed={selected && selected.vendor !== r.vendor}
							style="width: {Math.max(r.share, 1.5)}%; background: {providerAccent(r.vendor)}"
							title="{r.label} · {r.share.toFixed(1)}% — filter chart"
							aria-label="{r.label} {r.share.toFixed(1)} percent"
							onclick={() => select(r.vendor)}
						></button>
					{/each}
				</div>

				<div class="rankgrid faint" style="margin-top: 20px; font-size: 11px">
					<span></span><span>Provider</span>
					<span class="right">Tokens</span><span class="right col-md">Input</span><span class="right col-md">Output</span>
					<span class="right col-md">Thinking</span><span class="right col-cost">Cost</span><span class="right col-sm">Last activity</span>
				</div>

				<Accordion.Root type="multiple" class="ranklist">
					{#each ranked as r, i (r.key)}
						{@const models = summary.find((p) => p.vendor === r.vendor)?.models ?? []}
						<div animate:flip={{ duration: reduceMotion ? 0 : 320 }}>
						<Accordion.Item value={r.key} class="border-b-0">
							<Accordion.Trigger class="w-full hover:no-underline" level={3}>
								<span class="faint">{i + 1}</span>
								<span style="display: flex; align-items: center; gap: 7px">
									<ProviderIcon vendor={r.vendor} size={26} />
									{r.label}
								</span>
							<span class="right num"><strong><CountUp value={r.tokens} /></strong></span>
							<span class="right num dim col-md"><CountUp value={r.input} /></span>
							<span class="right num dim col-md"><CountUp value={r.output} /></span>
								<span class="right num dim col-md">{r.thinking > 0 ? fmtTok(r.thinking) : '—'}</span>
								<span class="right num dim col-cost">{fmtCost(r.cost, r.costEquivalent)}</span>
								<span class="right dim col-sm">{fmtAgo(r.lastEvent)}</span>
							</Accordion.Trigger>
							<Accordion.Content>
								{#if models.length === 0}
									<div class="faint" style="padding: 4px 0 10px 24px; font-size: 12px">no per-model rows in this window</div>
								{:else}
									{@const sorted = [...models].sort((a, b) => billableTok(b.tokens) - billableTok(a.tokens))}
									{@const mvisible = showAllModels[r.key] ? sorted : sorted.slice(0, MODEL_LIMIT)}
									{#each mvisible as m (m.model)}
										{@const mtoks = billableTok(m.tokens)}
										<button class="rankgrid modelrow" onclick={() => select(r.vendor, m.model)}>
											<span></span>
											<span class="mono dim" style="padding-left: 22px; display: flex; align-items: center; gap: 7px" title={m.model}><ProviderIcon vendor={r.vendor} model={m.model} size={24} />{fmtModel(m.model)}</span>
										<span class="right num"><CountUp value={mtoks} /></span>
										<span class="right num dim col-md"><CountUp value={m.tokens.input} /></span>
										<span class="right num dim col-md"><CountUp value={m.tokens.output} /></span>
											<span class="right num dim col-md">{m.tokens.reasoning > 0 ? fmtTok(m.tokens.reasoning) : '—'}</span>
											<span class="right num dim col-cost">{fmtCost(m.cost, m.costEquivalent)}</span>
											<span class="right dim col-sm">{fmtAgo(m.lastEvent)}</span>
										</button>
									{/each}
									{#if sorted.length > MODEL_LIMIT}
										<button
											class="showall"
											onclick={() => (showAllModels[r.key] = !showAllModels[r.key])}
										>
											{showAllModels[r.key] ? 'Show fewer models' : `Show all ${sorted.length} models`}
										</button>
									{/if}
								{/if}
							</Accordion.Content>
						</Accordion.Item>
						</div>
					{/each}
				</Accordion.Root>
			{/if}
		</section>
	</div>
{/snippet}

<WidgetMorph
	size={variant === 'small' ? 'sm' : 'md'}
	{speed}
	tileLabel="Activity bars — {window_} · tap to expand"
	title="Activity — {window_}"
	bind:phase
	bind:landed
	{canFly}
	{closeable}
	{travelFrom}
	{travelTo}
	awaitSettled={() => rectSettled(() => bodyEl)}
	staggerOpen={variant === 'small' ? 0.035 : 0.016}
	staggerClose={variant === 'small' ? 0.022 : 0.012}
	{enterOpen}
	{exitClose}
	tile={tileBody}
	modalBody={modalContent}
	ghostBody={ghostSnip}
	headerExtra={undefined}
/>

<style>
	.tile-row {
		position: relative;
		flex: 1;
		display: flex;
		flex-direction: row;
		align-items: stretch;
		gap: 10px;
		min-height: 0;
		/* negative margins cancel the shell tile padding so the sky
		   fills the whole widget; inner padding gives the content room */
		margin: -26px -16px;
		padding: 24px 8px 22px 20px;
	}
	/* day-cycle sky: tile-only backdrop at low opacity, fading in on
	   mount/landing and cross-fading between day periods.
	   The modal keeps its plain background. */
	.tile-sky {
		position: absolute;
		inset: 0;
		border-radius: 18px;
		overflow: hidden;
		pointer-events: none;
		opacity: 0.92;
		animation: skyfade 0.9s ease backwards;
	}
	.orb {
		position: absolute;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		transform: translate(-50%, -50%);
		transition: left 6s linear, top 6s linear;
	}
	.orb.sun {
		background: radial-gradient(circle at 35% 35%, #fffbeb, #fde047 55%, #f59e0b);
		box-shadow: 0 0 18px 6px rgb(253 224 71 / 0.45);
	}
	.orb.moon {
		background: radial-gradient(circle at 35% 35%, #f8fafc, #cbd5e1 60%, #94a3b8);
		box-shadow: 0 0 14px 4px rgb(226 232 240 / 0.35);
	}
	@keyframes skyfade {
		from { opacity: 0; }
		to { opacity: 0.92; }
	}
	.tile-main {
		position: relative;
		z-index: 1;
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		min-width: 0;
	}
	/* period total, top-left over the bars — difference blend inverts
	   against whatever passes under, like the main chart-stats overlay */
	.tstat {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 1;
		display: flex;
		align-items: baseline;
		gap: 6px;
		color: #fff;
		mix-blend-mode: difference;
		pointer-events: none;
		user-select: none;
	}
	.conceal {
		visibility: hidden;
	}
	/* vertical resolution picker, right side — chromeless and small, same
	   contrast trick as the total text so it stands out over the sky */
	.vpick {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0;
		background: transparent;
		border-radius: 999px;
		padding: 0;
		align-self: center;
		flex: none;
		color: #fff;
		mix-blend-mode: difference;
		opacity: 0.78;
	}
	.vval {
		font-size: 10px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		padding: 0;
		color: inherit;
	}
	.vbtn {
		appearance: none;
		border: 0;
		background: transparent;
		color: inherit;
		width: 20px;
		height: 18px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.vbtn:hover:not(:disabled) {
		background: var(--accent-soft);
		color: var(--text);
	}
	.vbtn:disabled {
		opacity: 0.3;
		cursor: default;
	}
	/* tiny bars: narrow pills with generous rounding.
	   Definite heights throughout (chart → column → bar %) so value
	   changes transition as grow/shrink instead of snapping. */
	.bchart {
		flex: 1;
		display: flex;
		align-items: flex-end;
		gap: 5px;
		height: 128px;
		padding: 30px 6px 2px;
	}
	.bcol {
		position: relative;
		flex: 1;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		height: 100%;
	}
	.bar {
		display: block;
		width: 100%;
		max-width: 14px;
		border-radius: 999px;
		/* opaque base fading to translucent tip so opacity varies
		   bottom → top, plus a soft glow to lift off the sky */
		background: linear-gradient(
			to top,
			var(--accent),
			color-mix(in srgb, var(--accent) 40%, transparent)
		);
		box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 40%, transparent);
		opacity: 1;
		min-height: 4px;
		transition: height 0.5s cubic-bezier(0.2, 0.9, 0.25, 1);
		animation: barin 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.2) backwards;
	}
	/* post-landing: hold bars steady instead of replaying the entrance */
	.bchart.landed .bar {
		animation: none;
	}
	@keyframes barin {
		from { transform: scaleY(0.2); opacity: 0; }
		to { transform: scaleY(1); opacity: 1; }
	}
	@keyframes chromefade {
		from { opacity: 0; }
		to { opacity: 1; }
	}
	.bar.hot {
		background: linear-gradient(
			to top,
			var(--ok),
			color-mix(in srgb, var(--ok) 40%, transparent)
		);
		box-shadow: 0 0 12px color-mix(in srgb, var(--ok) 45%, transparent);
	}
	/* rightmost growth: same language as VBars — green column wash + +delta rise */
	.bflash {
		position: absolute;
		bottom: 0;
		width: 100%;
		max-width: 14px;
		height: 100%;
		border-radius: 999px;
		background: var(--ok);
		opacity: 0;
		pointer-events: none;
		animation: b-flash 1.15s ease-out forwards;
	}
	.bdelta {
		position: absolute;
		top: -16px;
		left: 50%;
		transform: translateX(-50%);
		font-size: 11px;
		font-weight: 700;
		color: var(--ok);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		pointer-events: none;
		animation: b-rise 1.4s ease-out forwards;
	}
	@keyframes b-flash {
		0% { opacity: 0.3; }
		100% { opacity: 0; }
	}
	@keyframes b-rise {
		0% { opacity: 0; transform: translate(-50%, 6px); }
		15% { opacity: 1; }
		100% { opacity: 0; transform: translate(-50%, -14px); }
	}
	.btotal {
		font-size: 15px;
		font-weight: 750;
		letter-spacing: -0.03em;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.bsub {
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		opacity: 0.75;
	}
	/* modal: like-for-like copy of +page chartmod + rankmod */
	.cbody {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 10px 8px 8px;
	}
	.cbody .mod {
		margin: 0;
		min-width: 0;
	}
	.cbody .chartmod,
	.cbody .rankmod {
		border-radius: 18px;
		padding: 22px 22px 20px;
		background: color-mix(in srgb, var(--bg-raised) 45%, transparent);
	}
	.cbody .chartmod {
		padding-top: 12px;
	}
	.picker-row {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 10px;
		margin-bottom: 20px;
	}
	.chartwrap {
		position: relative;
	}
	.chart-stats {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		display: flex;
		gap: 34px;
		padding: 12px 16px;
		color: #fff;
		mix-blend-mode: difference;
		pointer-events: none;
		user-select: none;
	}
	.chart-stat {
		display: flex;
		align-items: baseline;
		gap: 6px;
	}
	.chart-stat-value {
		font-size: 14px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
	}
	.chart-stat-label {
		font-size: 14px;
		font-weight: 500;
		opacity: 0.75;
		white-space: nowrap;
	}
	.rankgrid {
		display: grid;
		grid-template-columns: 1.6rem minmax(9rem, 1.2fr) 5rem 5rem 5rem 5rem 4.5rem 5.5rem 1.2rem;
		gap: 8px;
		align-items: center;
		width: 100%;
		text-align: left;
		padding: 0 4px;
	}
	.modelrow {
		background: none;
		border: none;
		border-top: 1px solid var(--line);
		font: inherit;
		color: var(--text);
		font-size: 12px;
		padding: 9px 4px;
		cursor: pointer;
	}
	.modelrow:first-of-type {
		border-top: none;
	}
	.modelrow:hover { background: rgba(128, 128, 128, 0.06); }
	.cbody :global(button[data-slot="accordion-trigger"]) {
		appearance: none;
		border: 0;
		background: transparent;
		width: 100%;
		color: var(--text);
		font-family: inherit;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
		display: grid;
		grid-template-columns: 1.6rem minmax(9rem, 1.2fr) 5rem 5rem 5rem 5rem 4.5rem 5.5rem 1.2rem;
		gap: 8px;
		align-items: center;
		padding: 16px 4px;
	}
	.sharebar {
		display: flex;
		height: 14px;
		border-radius: 4px;
		overflow: hidden;
		gap: 1px;
	}
	.seg-segment {
		border: none;
		padding: 0;
		cursor: pointer;
		opacity: 0.8;
		backdrop-filter: blur(6px) saturate(1.4);
		-webkit-backdrop-filter: blur(6px) saturate(1.4);
		transition: opacity 0.12s;
	}
	.seg-segment:hover { opacity: 1; }
	.seg-segment.dimmed { opacity: 0.25; }
	.chip-clear {
		border: 1px solid var(--line);
		background: transparent;
		color: var(--text-2);
		border-radius: 999px;
		font-size: 11px;
		padding: 1px 8px;
		cursor: pointer;
	}
	.seg {
		display: inline-flex;
		background: var(--track);
		border-radius: 999px;
		padding: 3px;
		gap: 2px;
	}
	.seg button {
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text-2);
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		padding: 4px 10px;
		border-radius: 999px;
		cursor: pointer;
	}
	.seg button.active {
		background: var(--bg-raised);
		color: var(--text);
		box-shadow: inset 0 0 0 1px var(--line);
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
		display: grid;
		grid-template-columns: 1fr 2fr 1fr;
		gap: 10px;
	}
	.rankskel-row .skel {
		height: 22px;
	}
	/* table density follows the modal width (t2 full / t1 compact /
	   t0 minimal) — rows always span the full graph width */
	.cbody.t2 .rankgrid,
	.cbody.t2 :global(button[data-slot="accordion-trigger"]) {
		grid-template-columns: 1.6rem minmax(8rem, 1.3fr) 5rem 4.5rem 5.5rem 1.2rem;
	}
	.cbody.t2 .col-md { display: none; }
	.cbody.t1 .rankgrid,
	.cbody.t1 :global(button[data-slot="accordion-trigger"]) {
		grid-template-columns: 1.6rem minmax(7rem, 1.4fr) 5rem 5.5rem 1.2rem;
	}
	.cbody.t1 .col-md,
	.cbody.t1 .col-cost { display: none; }
	.cbody.t0 .rankgrid,
	.cbody.t0 :global(button[data-slot="accordion-trigger"]) {
		grid-template-columns: 1.2rem minmax(6rem, 1.6fr) 4.5rem 1.2rem;
		gap: 6px;
	}
	.cbody.t0 .col-md,
	.cbody.t0 .col-cost,
	.cbody.t0 .col-sm { display: none; }
	.cbody.t0 .modelrow { font-size: 11px; }
	@media (prefers-reduced-motion: reduce) {
		.bar { transition: none; animation: none; }
		.bflash, .bdelta { animation: none; }
		.skel { animation: none; }
		.tile-sky { animation: none; }
		.orb { transition: none; }
	}
</style>
