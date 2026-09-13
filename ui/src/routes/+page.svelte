<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type ProviderSummary, type UsageEvent } from '$lib/api';
	import { fmtTok, fmtModel, billableTok, poll } from '$lib/format';
	import { fetchDailyActivity, type DayActivity } from '$lib/activity';
	import { providerAccent } from '$lib/colors';
	import { settings } from '$lib/settings.svelte';
	import { scope } from '$lib/scope.svelte';
	import Heatmap from '$lib/components/Heatmap.svelte';
	import VBars from '$lib/components/VBars.svelte';
	import ProviderIcon from '$lib/components/ProviderIcon.svelte';
	import CountUp from '$lib/components/CountUp.svelte';
	import { fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import * as Accordion from '$lib/components/ui/accordion/index.js';

	const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	/** Visible-row caps: lists fade out past the cap with a "show all" toggle. */
	const MODEL_LIMIT = 5;
	const RECENT_LIMIT = 6;
	let showAllModels = $state<Record<string, boolean>>({});
	let showAllRecent = $state(false);

	let days = $state<DayActivity[]>([]);
	let summaryAll = $state<ProviderSummary[]>([]); // KPIs: window-independent
	let summary = $state<ProviderSummary[]>([]);    // ranking: windowed
	let recent = $state<UsageEvent[]>([]);
	let chartPoints = $state<{ ts: number; value: number }[]>([]);
	/** Horizon counters: merged cost / tokens / requests over the visible window. */
	let chartCost = $state(0);
	let chartRequests = $state(0);
	let chartFrom = $state(0);
	let chartTo = $state(0);
	let window_ = $state('1D');
	let booted = $state(false);
	/** Share-bar selection filters the chart. */
	let selected = $state<{ vendor: string; model?: string } | null>(null);

	const windows = ['1D', '1W', '1M', '3M', '1Y'];
	/** window → [bucket resolution seconds, span seconds] */
	const windowSpec: Record<string, [number, number]> = {
		'1D': [300, 86400],
		'1W': [900, 7 * 86400],
		'1M': [3600, 31 * 86400],
		'3M': [86400, 93 * 86400],
		'1Y': [86400, 365 * 86400]
	};


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
			// Fold per-vendor rows into one point per bucket; billable only.
			const byStart = new Map<number, number>();
			for (const b of r.buckets) {
				byStart.set(b.start, (byStart.get(b.start) ?? 0) + billableTok(b.tokens));
			}
			chartCost = r.buckets.reduce((s, b) => s + bestCost(b.cost, b.costEquivalent), 0);
			chartRequests = r.buckets.reduce((s, b) => s + (b.requests ?? 0), 0);
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
			[summaryAll, summary, recent] = await Promise.all([
				api.summary(!settings.showImports).then((r) => r.providers),
				api.summary(!settings.showImports, from).then((r) => r.providers),
				api.events(`?limit=12${settings.showImports ? '' : '&metered=1'}`).then((r) => r.events)
			]);
		} catch {
			/* layout shows daemon-down state */
		}
		void loadChart();
		fetchDailyActivity(365, !settings.showImports)
			.then((d) => (days = d))
			.catch(() => {});
	};

	onMount(() => {
		void loadAll().finally(() => (booted = true));
		const stop = poll(loadAll, 5000);
		return stop;
	});


	// ---- headline: billable work only, all time (cache reads excluded) ----
	const billableAll = $derived(summaryAll.reduce((s, p) => s + billableTok(p.tokens), 0));
	const requestsAll = $derived(summaryAll.reduce((s, p) => s + p.requests, 0));
	/** Charged + known list-price equivalents in ONE counter. */
	const costAll = $derived(summaryAll.reduce((s, p) => s + bestCost(p.cost, p.costEquivalent), 0));

	// ---- provider comparison ranking ----
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
	const visibleRecent = $derived(showAllRecent ? recent : recent.slice(0, RECENT_LIMIT));
	const recentTruncated = $derived(recent.length > RECENT_LIMIT);

	/** Newest request id — flashes once when a new request lands. */
	let freshId = $state<string | null>(null);
	$effect(() => {
		const top = recent[0]?.id;
		if (top && top !== freshId) freshId = top;
	});

	const multiMachine = $derived(scope.machines.length > 1);

	function fmtTime(ts: number): string {
		return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}
	/** One merged figure: the actual charge, else the list-price equivalent. */
	function bestCost(c: number, equiv?: number | null): number {
		return c > 0.0001 ? c : (equiv ?? 0);
	}
	function fmtCost(c: number, equiv?: number | null): string {
		const v = bestCost(c, equiv);
		return v > 0.0001 ? `$${v.toFixed(2)}` : '—';
	}
</script>

<div class="dash">
<section class="hero">
	{#if !booted}
		<div class="hero-stats">
			<div class="hero-stat"><div class="skel skel-big"></div><div class="skel skel-cap"></div></div>
			<div class="hero-stat"><div class="skel skel-big"></div><div class="skel skel-cap"></div></div>
			<div class="hero-stat"><div class="skel skel-big"></div><div class="skel skel-cap"></div></div>
		</div>
	{:else}
	<div class="hero-stats">
		<div class="hero-stat voice-tokens">
			<div class="stat-num"><CountUp value={billableAll} /></div>
			<div class="stat-cap">Tokens · all time</div>
		</div>
		<div class="hero-stat voice-requests">
			<div class="stat-num"><CountUp value={requestsAll} format={(n) => Math.round(n).toLocaleString()} /></div>
			<div class="stat-cap">Requests</div>
		</div>
		<div class="hero-stat voice-cost">
			<div class="stat-num"><CountUp value={costAll} format={(n) => `$${n.toFixed(2)}`} /></div>
			<div class="stat-cap">Cost</div>
		</div>
	</div>
	{/if}
</section>

<section class="mod chartmod">
	<div class="picker-row">
		<div class="seg" role="group" aria-label="Window">
			{#each windows as w}
				<button class:active={window_ === w} onclick={() => { window_ = w; void loadAll(); }}>{w}</button>
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
		<VBars points={chartPoints} from={chartFrom} to={chartTo} />
		<div class="chart-stats">
			<div class="chart-stat">
				<div class="chart-stat-value"><CountUp value={chartCost} format={(n) => `$${n.toFixed(2)}`} /></div>
				<div class="chart-stat-label">cost{selected ? ` · ${selected.model ?? selected.vendor}` : ''}</div>
			</div>
			<div class="chart-stat">
				<div class="chart-stat-value"><CountUp value={chartPoints.reduce((s, p) => s + p.value, 0)} /></div>
				<div class="chart-stat-label">tokens</div>
			</div>
			<div class="chart-stat">
				<div class="chart-stat-value"><CountUp value={chartRequests} format={(n) => Math.round(n).toLocaleString()} /></div>
				<div class="chart-stat-label">requests</div>
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
		<div class="empty-card">
			<div class="empty-card-title">No usage measured yet</div>
			<div class="dim empty-card-body">Point a tool at a loopback meter and its requests will land here, per provider and model.</div>
			<a class="btn" href="/machine">Set up metering</a>
		</div>
	{:else}
		<div class="sharebar" role="img" aria-label="Provider share of token usage" style="margin-top: 38px">
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
			<span></span><span>Provider</span><span class="right">Share</span>
			<span class="right">Tokens</span><span class="right m-md">Input</span><span class="right m-md">Output</span>
			<span class="right m-md">Thinking</span><span class="right m-sm">Cost</span><span class="right m-sm">Last activity</span>
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
						<span class="right num sharecell" style="justify-content: flex-end">
							<span class="sharemini"><span style="width: {r.share}%; background: {providerAccent(r.vendor)}"></span></span>
							{r.share.toFixed(1)}%
						</span>
					<span class="right num"><strong><CountUp value={r.tokens} /></strong></span>
					<span class="right num dim m-md"><CountUp value={r.input} /></span>
					<span class="right num dim m-md"><CountUp value={r.output} /></span>
						<span class="right num dim m-md">{r.thinking > 0 ? fmtTok(r.thinking) : '—'}</span>
						<span class="right num dim m-sm">{fmtCost(r.cost, r.costEquivalent)}</span>
						<span class="right dim m-sm">{fmtAgo(r.lastEvent)}</span>
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
									<span class="right num dim">{rankTotal > 0 ? ((mtoks / rankTotal) * 100).toFixed(1) : '0.0'}%</span>
								<span class="right num"><CountUp value={mtoks} /></span>
								<span class="right num dim m-md"><CountUp value={m.tokens.input} /></span>
								<span class="right num dim m-md"><CountUp value={m.tokens.output} /></span>
									<span class="right num dim m-md">{m.tokens.reasoning > 0 ? fmtTok(m.tokens.reasoning) : '—'}</span>
									<span class="right num dim m-sm">{fmtCost(m.cost, m.costEquivalent)}</span>
									<span class="right dim m-sm">{fmtAgo(m.lastEvent)}</span>
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

<section class="mod heatmod">
	<div class="faint mod-label">Activity</div>
	{#if days.length > 0}
		<Heatmap {days} />
	{:else}
		<div class="empty">…</div>
	{/if}
</section>

<section class="mod leadmod">
	<div class="faint mod-label">Leaders · {window_}</div>
	{#if !booted}
		<div class="rankskel" aria-hidden="true">
			{#each Array(4) as _}
				<div class="rankskel-row wide"><span class="skel"></span><span class="skel"></span></div>
			{/each}
		</div>
	{:else if ranked.length === 0}
		<div class="empty">…</div>
	{:else}
		<div class="leaders">
			{#each ranked.slice(0, 4) as r (r.key)}
				<button class="leader" onclick={() => select(r.vendor)} title="{r.label} — filter chart">
					<ProviderIcon vendor={r.vendor} size={22} />
					<span class="leader-name">{r.label}</span>
					<span class="leader-bar"><span style="width: {r.share}%; background: {providerAccent(r.vendor)}"></span></span>
					<span class="leader-toks num">{fmtTok(r.tokens)}</span>
				</button>
			{/each}
		</div>
	{/if}
</section>

<section class="mod recentmod">
	<div class="faint" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px">Recent</div>
	{#if !booted}
		<div class="rankskel" aria-hidden="true">
			{#each Array(4) as _}
				<div class="rankskel-row wide"><span class="skel"></span><span class="skel"></span></div>
			{/each}
		</div>
	{:else if recent.length === 0}
		<div class="empty-card">
			<div class="empty-card-title">No requests yet</div>
			<div class="dim empty-card-body">Each metered request shows up here the moment it completes.</div>
			<a class="btn" href="/machine">Set up metering</a>
		</div>
	{:else}
		<div class="recentfade" class:faded={!showAllRecent && recentTruncated}>
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
			<tbody>
				{#each visibleRecent as e (e.id)}
					<tr
						class:flash={e.id === freshId}
						in:fly={{ y: reduceMotion ? 0 : -8, duration: reduceMotion ? 0 : 280 }}
						animate:flip={{ duration: reduceMotion ? 0 : 300 }}
					>
						<td class="mono dim">{fmtTime(e.timestamp)}</td>
						<td class="dim t-md">{e.product ?? (e.vendor === 'opencode-go' ? 'opencode' : '—')}</td>
						<td>
							<span style="display: flex; align-items: center; gap: 6px">
								<ProviderIcon vendor={e.vendor} size={20} />
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
		{#if recentTruncated}
			<button class="showall" onclick={() => (showAllRecent = !showAllRecent)}>
				{showAllRecent ? 'Show fewer requests' : `Show all ${recent.length} requests`}
			</button>
		{/if}
	{/if}
</section>
</div>

<style>
	/* ---- dashboard mosaic: container-driven bento, not a viewport vstack ----
	   .dash is the container; sections are grid items that re-span and
	   re-order by available width, so the page composes itself in a narrow
	   Tauri window, a wide monitor, or anything between. Narrow-first. */
	.dash {
		container-type: inline-size;
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		column-gap: 16px;
		row-gap: 44px;
		align-items: start;
		margin-top: 28px;
	}
	.dash .hero,
	.dash .mod {
		margin: 0;
		min-width: 0;
		grid-column: 1 / -1;
	}

	.mod-label {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		margin-bottom: 12px;
	}

	/* trio: same row, same hierarchy — three type voices, one rhythm.
	   tabular sans black for tokens, light grotesk for requests,
	   italic serif for cost. Caps stay uniform so it reads as one line. */
	.hero-stats {
		display: flex;
		flex-direction: column;
		gap: 22px;
		padding-bottom: 26px;
		border-bottom: 1px solid var(--line);
	}
	.hero-stat {
		min-width: 0;
	}
	.stat-num {
		font-variant-numeric: tabular-nums;
		line-height: 1;
		white-space: nowrap;
	}
	.voice-tokens .stat-num {
		font-size: 52px;
		font-weight: 750;
		letter-spacing: -0.045em;
	}
	.voice-requests .stat-num {
		font-size: 44px;
		font-weight: 450;
		letter-spacing: -0.01em;
	}
	.voice-cost .stat-num {
		font-family: ui-serif, Georgia, 'Charter', 'Times New Roman', serif;
		font-style: italic;
		font-size: 44px;
		font-weight: 550;
		letter-spacing: -0.01em;
	}
	.stat-cap {
		margin-top: 9px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--text-3);
	}
	.skel-big {
		width: min(200px, 60%);
		height: 52px;
		border-radius: 10px;
	}
	.skel-cap {
		width: 120px;
		height: 11px;
		margin-top: 10px;
	}

	/* heatmap lives in a card so it reads as one tile next to leaders */
	.heatmod {
		background: var(--bg-raised);
		border-radius: 18px;
		padding: 18px 18px 14px;
		overflow: hidden;
	}
	/* leaders tile: glanceable top providers, taps filter the chart */
	.leadmod {
		background: var(--bg-raised);
		border-radius: 18px;
		padding: 18px 18px 10px;
		overflow: hidden;
	}
	.leaders {
		display: grid;
	}
	.leader {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr) minmax(60px, 120px) auto;
		gap: 10px;
		align-items: center;
		background: none;
		border: none;
		border-top: 1px solid var(--line);
		font: inherit;
		color: var(--text);
		padding: 11px 2px;
		cursor: pointer;
		text-align: left;
		width: 100%;
	}
	.leader:first-child {
		border-top: none;
	}
	.leader:hover {
		background: rgba(128, 128, 128, 0.06);
	}
	.leader-name {
		font-size: 13px;
		font-weight: 550;
		letter-spacing: -0.01em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.leader-bar {
		display: block;
		height: 5px;
		border-radius: 3px;
		background: var(--track);
		overflow: hidden;
	}
	.leader-bar span {
		display: block;
		height: 100%;
		border-radius: inherit;
	}
	.leader-toks {
		font-size: 13px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	/* recent table scrolls inside its tile instead of breaking the grid */
	.recentmod .recentfade {
		overflow-x: auto;
	}

	/* mid: trio falls into one row, voices scale with the container */
	@container (min-width: 560px) {
		.hero-stats {
			flex-direction: row;
			align-items: flex-end;
			gap: 28px;
			gap: clamp(28px, 6cqi, 76px);
		}
		.voice-tokens .stat-num {
			font-size: 64px;
			font-size: clamp(52px, 9cqi, 88px);
		}
		.voice-requests .stat-num,
		.voice-cost .stat-num {
			font-size: 44px;
			font-size: clamp(36px, 6cqi, 60px);
		}
	}
	/* wide: activity + leaders share the row under the full-bleed chart */
	@container (min-width: 760px) {
		.dash .heatmod { grid-column: span 5; }
		.dash .leadmod { grid-column: span 7; }
	}

	.hero {
		text-align: left;
	}
	.picker-row {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 10px;
		margin-bottom: 18px;
	}
	.chartwrap {
		position: relative;
	}

	/* Horizon stat strip, overlaid on the chart. White + difference blend =
	   color-negative: every glyph inverts against whatever bars pass under
	   it, so the counters stay legible at any overlap. */
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

	.chart-stat-value {
		font-size: 24px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
	}

	.chart-stat-label {
		margin-top: 2px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		opacity: 0.75;
	}

	.rankgrid {
		display: grid;
		grid-template-columns: 1.6rem minmax(9rem, 1.2fr) 5.5rem 5rem 5rem 5rem 5rem 4.5rem 5.5rem 1.2rem;
		/* <900px: drop input/output/thinking · <640px: also drop cost/last */
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
	/* capped recent list fades out at the bottom edge */
	.recentfade.faded {
		-webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 84px), transparent 100%);
		mask-image: linear-gradient(to bottom, #000 calc(100% - 84px), transparent 100%);
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
	/* newest request flashes once on arrival */
	@keyframes rowfresh {
		0% { background: var(--accent-soft); }
		100% { background: transparent; }
	}
	tbody tr.flash td {
		animation: rowfresh 1.8s ease-out;
	}
	section :global(button[data-slot="accordion-trigger"][data-state="open"] > svg[data-slot="accordion-trigger-icon"]) {
		transform: rotate(180deg);
	}
	.modelrow:hover { background: rgba(128, 128, 128, 0.06); }
	/* accordion triggers are <button>s inside a child component — scoped CSS
	   can't reach them, so the whole row layout lives in this global rule.
	   Padding here matches .rankgrid rows so columns line up. */
	section :global(button[data-slot="accordion-trigger"]) {
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
		grid-template-columns: 1.6rem minmax(9rem, 1.2fr) 5.5rem 5rem 5rem 5rem 5rem 4.5rem 5.5rem 1.2rem;
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
		opacity: 0.85;
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
	.sharecell { display: inline-flex; align-items: center; gap: 6px; }	.sharemini {
		display: inline-block;
		width: 42px;
		height: 4px;
		border-radius: 2px;
		background: var(--track, rgba(128, 128, 128, 0.15));
		overflow: hidden;
	}
	.sharemini span { display: block; height: 100%; }

	/* ---- loading skeletons + designed empty states ---- */
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
	@media (prefers-reduced-motion: reduce) {
		.skel { animation: none; }
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
	.rankskel-row.wide {
		grid-template-columns: 1fr 3fr;
	}
	.rankskel-row .skel {
		height: 22px;
	}
	.empty-card {
		background: color-mix(in srgb, var(--bg-raised) 72%, transparent);
		border-radius: 18px;
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.04);
		padding: 34px 24px;
		text-align: center;
		margin-top: 20px;
		display: grid;
		gap: 8px;
		justify-items: center;
	}
	.empty-card-title {
		font-size: 14px;
		font-weight: 650;
	}
	.empty-card-body {
		font-size: 12.5px;
		max-width: 380px;
	}
	.empty-card .btn {
		margin-top: 8px;
	}

	/* ---- responsive: md ≤900px, sm ≤640px ---- */
	@media (max-width: 900px) {
		.rankgrid,
		section :global(button[data-slot="accordion-trigger"]) {
			grid-template-columns: 1.6rem minmax(7rem, 1.4fr) 5rem 4.5rem 4.5rem 5.5rem 1.2rem;
		}
		.m-md { display: none; }
		.t-md { display: none; }
	}
	@media (max-width: 640px) {
		.dash { row-gap: 34px; }
		.rankgrid,
		section :global(button[data-slot="accordion-trigger"]) {
			grid-template-columns: 1.2rem minmax(6rem, 1.6fr) 4.5rem 4rem 1.2rem;
			gap: 6px;
		}
		.m-sm { display: none; }
		.t-sm { display: none; }
		.modelrow { font-size: 11.5px; }
	}
</style>
