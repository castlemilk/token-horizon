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
	import { api, type ProviderSummary } from '$lib/api';
	import { billableTok, fmtReset, poll } from '$lib/format';
	import { settings } from '$lib/settings.svelte';
	import { limitsStore } from '$lib/limits.svelte';

	/** Single-provider widget, two sizes sharing one modal.
	 *  small: 2×2 — identity top-left, quota dials fill bottom-right,
	 *  bottom-left, then top-right. medium: 1×4 — identity left, dials
	 *  middle-left, middle-right, right. A rotation picker steps through
	 *  detected providers. Modal lists every provider as a medium-style
	 *  row. Rings match the limits page (ok/warn/bad by usedPercent).
	 *
	 *  Content for a shared-container morph (see WidgetMorph): the
	 *  identity chip travels by vendor key to its modal row. */
	let {
		variant,
		speed = 1
	}: {
		variant: 'small' | 'medium';
		speed?: number;
	} = $props();

	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	const R = 34;
	const C = 2 * Math.PI * R;

	let summary = $state<ProviderSummary[]>([]);
	let booted = $state(false);
	let idx = $state(0);

	let phase = $state<Phase>('settle');
	let landed = $state(false);
	let bodyEl = $state<HTMLElement | null>(null);

	function color(pct: number): string {
		if (pct >= 90) return 'var(--bad)';
		if (pct >= 70) return 'var(--warn)';
		// Locked dark-mode green in both themes for consistent rings.
		return '#30d158';
	}

	/** "kimi (kimi-code)" → ["kimi", "kimi-code"] for display. */
	function splitProvider(p: string): [string, string | null] {
		const m = p.match(/^(.*?)\s*\((.*)\)$/);
		return m ? [m[1], m[2]] : [p, null];
	}

	interface Win {
		label: string;
		usedPercent: number;
		detail?: string;
		resetsAt?: number;
	}

	interface Group {
		vendor: string;
		account: string | null;
		tokens: number;
		rows: Win[];
		peak: number;
	}

	// Providers with detected plans only: quota groups ordered by
	// billable usage so rotation follows real use.
	const groups = $derived.by<Group[]>(() => {
		const byProvider = limitsStore.limits.reduce<Record<string, typeof limitsStore.limits>>(
			(acc, l) => {
				(acc[l.provider] ??= []).push(l);
				return acc;
			},
			{}
		);
		const toks = new Map(summary.map((p) => [p.vendor.toLowerCase(), billableTok(p.tokens)]));
		return Object.entries(byProvider)
			.map(([provider, rows]) => {
				const [vendor, account] = splitProvider(provider);
				const sorted = [...rows].sort((a, b) => b.usedPercent - a.usedPercent);
				return {
					vendor,
					account,
					tokens: toks.get(vendor.toLowerCase()) ?? 0,
					rows: sorted,
					peak: sorted[0]?.usedPercent ?? 0
				};
			})
			.sort((a, b) => b.tokens - a.tokens);
	});

	const current = $derived(groups.length > 0 ? groups[Math.min(idx, groups.length - 1)] : null);
	const tileKey = $derived(
		current ? `${current.vendor}:${current.tokens}:${current.rows.map((r) => r.usedPercent.toFixed(0)).join(',')}` : 'empty'
	);

	function step(d: number, e?: Event) {
		e?.stopPropagation();
		if (phase !== 'settle' || groups.length === 0) return;
		idx = (idx + d + groups.length) % groups.length;
		armRotation();
	}

	// Auto-rotate through providers while the tile idles (many providers
	// get seen without touching anything). Pauses with the modal open,
	// a hidden tab, or reduced motion; manual steps restart the clock.
	let rotTimer = 0;
	function armRotation() {
		window.clearInterval(rotTimer);
		rotTimer = 0;
		if (reduce || groups.length <= 1) return;
		rotTimer = window.setInterval(() => {
			if (phase === 'settle' && !document.hidden && groups.length > 1) {
				idx = (idx + 1) % groups.length;
			}
		}, 6000);
	}
	$effect(() => {
		void groups.length;
		armRotation();
	});

	async function fetchSummary() {
		try {
			summary = (await api.summary(!settings.showImports)).providers;
		} catch {
			/* daemon down — keep last paint */
		}
	}

	onMount(() => {
		const stopWatch = limitsStore.watch();
		void fetchSummary().finally(() => (booted = true));
		const stopPoll = poll(fetchSummary, 10000);
		armRotation();
		return () => {
			stopWatch();
			stopPoll();
			window.clearInterval(rotTimer);
		};
	});

	// ---- morph contract: the identity chip travels to its modal row ----
	const canFly = () => !reduce && current != null && booted;
	const closeable = () => true;
	function mark(key: string, root: HTMLElement | null): TravelMark {
		return { key, el: root?.querySelector(`[data-travel="${key}"]`) ?? null };
	}
	const travelFrom = (_dir: 'open' | 'close', roots: TravelRoots) => {
		const key = current?.vendor.toLowerCase() ?? '';
		return key ? [mark(key, roots.box)] : null;
	};
	const travelTo = (dir: 'open' | 'close', roots: TravelRoots) => {
		const key = current?.vendor.toLowerCase() ?? '';
		if (!key) return null;
		return [mark(key, dir === 'open' ? roots.box : roots.ghost)];
	};

	const enterOpen: EnterSpec[] = [
		{ select: '.prow', kind: 'rise', y: 10, at: (c) => c.landT + 0.1 * c.S }
	];
	const exitClose: ExitSpec[] = [{ select: '.psec', at: (c) => 0.08 * c.S }];
</script>

{#snippet dial(pct: number)}
	{@const p = Math.min(Math.max(pct, 0), 100)}
	<div class="dial" role="img" aria-label="{p.toFixed(0)} percent used">
		<svg viewBox="0 0 84 84" aria-hidden="true">
			<circle cx="42" cy="42" r={R} class="dial-track" />
			<circle
				cx="42" cy="42" r={R}
				class="dial-fill"
				style:stroke={color(p)}
				style:--glow={color(p)}
				stroke-dasharray="{C}"
				stroke-dashoffset={C * (1 - p / 100)}
			/>
		</svg>
		<span class="dial-pct num" style:color={color(p)}>{p.toFixed(0)}</span>
	</div>
{/snippet}

{#snippet winCell(w: Win | null, big = false)}
	<div class="wcell">
		<div class="pviz" style:--viz="{big ? 66 : 40}px">
			{#if w}
				{@render dial(w.usedPercent)}
			{:else}
				<span class="wempty-ring" aria-hidden="true"></span>
			{/if}
		</div>
		<div class="psubz">
			{#if w}
				<span class="wlabel" title="{w.label}{w.detail ? ` — ${w.detail}` : ''}{w.resetsAt ? ` · resets ${fmtReset(w.resetsAt)}` : ''}">{w.label}{#if w.resetsAt}<em>. {fmtReset(w.resetsAt).replace(/^in /, '')}</em>{/if}</span>
			{:else}
				<span class="wlabel" aria-hidden="true">&nbsp;</span>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet identity(g: Group, logo: number)}
	<div class="ident">
		<div class="pviz" style:--viz="{logo}px">
			<span class="ilogo" data-travel={g.vendor.toLowerCase()}>
				<ProviderIcon vendor={g.vendor} fill />
			</span>
		</div>
		<div class="psubz">
			<span class="pill" title={g.account ? `${g.vendor} (${g.account})` : g.vendor}>
				{g.vendor}{#if g.account}<em> · {g.account}</em>{/if}
			</span>
		</div>
	</div>
{/snippet}

{#snippet vpicker()}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="vpick"
		role="group"
		aria-label="Provider"
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<button
			class="vbtn"
			onclick={(e) => step(-1, e)}
			disabled={groups.length <= 1 || phase !== 'settle'}
			aria-label="Previous provider"
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
		</button>
		<span class="vval num" title="Provider {idx + 1} of {groups.length}">{groups.length > 0 ? `${idx + 1}/${groups.length}` : '—'}</span>
		<button
			class="vbtn"
			onclick={(e) => step(1, e)}
			disabled={groups.length <= 1 || phase !== 'settle'}
			aria-label="Next provider"
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
		</button>
	</div>
{/snippet}

{#snippet tileBody()}
	{#key tileKey}
		<div class="tile-row" class:wide={variant === 'medium'}>
			<div class="tile-main" class:landed>
				{#if current}
					{#if variant === 'small'}
						<div class="pgrid2">
							<div class="pcell ident-cell">{@render identity(current, 40)}</div>
							<div class="pcell">{@render winCell(current.rows[2] ?? null)}</div>
							<div class="pcell">{@render winCell(current.rows[1] ?? null)}</div>
							<div class="pcell">{@render winCell(current.rows[0] ?? null)}</div>
						</div>
					{:else}
						<div class="pgrid4">
							<div class="pcell ident-cell">{@render identity(current, 66)}</div>
							<div class="pcell">{@render winCell(current.rows[0] ?? null, true)}</div>
							<div class="pcell">{@render winCell(current.rows[1] ?? null, true)}</div>
							<div class="pcell">{@render winCell(current.rows[2] ?? null, true)}</div>
						</div>
					{/if}
				{:else}
					<span class="pempty">No providers yet</span>
				{/if}
			</div>
			{@render vpicker()}
		</div>
	{/key}
{/snippet}
{#snippet ghostSnip()}
	<div class="tile-row" class:wide={variant === 'medium'}>
		<div class="tile-main">
			{#if current}
				{#if variant === 'small'}
					<div class="pgrid2">
						<div class="pcell ident-cell">{@render identity(current, 40)}</div>
						<div class="pcell">{@render winCell(current.rows[2] ?? null)}</div>
						<div class="pcell">{@render winCell(current.rows[1] ?? null)}</div>
						<div class="pcell">{@render winCell(current.rows[0] ?? null)}</div>
					</div>
				{:else}
					<div class="pgrid4">
						<div class="pcell ident-cell">{@render identity(current, 66)}</div>
						<div class="pcell">{@render winCell(current.rows[0] ?? null, true)}</div>
						<div class="pcell">{@render winCell(current.rows[1] ?? null, true)}</div>
						<div class="pcell">{@render winCell(current.rows[2] ?? null, true)}</div>
					</div>
				{/if}
			{:else}
				<span class="pempty" aria-hidden="true">No providers yet</span>
			{/if}
		</div>
		{@render vpicker()}
	</div>
{/snippet}
{#snippet modalContent()}
	<div class="pbody" bind:this={bodyEl}>
		<section class="psec">
			<div class="prefrow" class:conceal={phase === 'fly'}>
				<span class="psub">{groups.length} provider{groups.length === 1 ? '' : 's'} detected</span>
			</div>
			{#if !booted && groups.length === 0}
				<div class="pskel" aria-hidden="true">
					{#each Array(3) as _}
						<div class="pskel-row"><span class="skel"></span><span class="skel"></span></div>
					{/each}
				</div>
			{:else if groups.length === 0}
				<EmptyState
					title="No providers detected"
					body="Point a tool at a loopback meter and its provider will land here with quota status."
					actionLabel="Set up metering"
					actionHref="/metering"
				/>
			{:else}
				{#each groups as g}
					<div class="prow">
						<div class="pcell ident-cell">{@render identity(g, 66)}</div>
						<div class="pcell">{@render winCell(g.rows[0] ?? null, true)}</div>
						<div class="pcell">{@render winCell(g.rows[1] ?? null, true)}</div>
						<div class="pcell">{@render winCell(g.rows[2] ?? null, true)}</div>
					</div>
				{/each}
			{/if}
		</section>
	</div>
{/snippet}

<WidgetMorph
	size={variant === 'small' ? 'sm' : 'md'}
	{speed}
	tileLabel="Providers — tap to expand"
	title="Providers"
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
	.tile-row {
		position: relative;
		flex: 1;
		display: flex;
		flex-direction: row;
		align-items: stretch;
		min-height: 0;
		/* No picker reservation: a 20px padding-bottom pushed the grid's
		   center 10px up; the picker floats in the tile's bottom padding
		   (see .vpick) and never overlaps the grid. */
	}
	.tile-main {
		flex: 1;
		display: flex;
		min-width: 0;
	}
	/* small: 2×2 (identity TL; dials BR, BL, TR) · medium: 1×4 */
	.pgrid2 {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		grid-template-rows: repeat(2, minmax(0, 1fr));
		gap: 4px;
		min-height: 0;
	}
	.pgrid4 {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 4px;
		align-content: center;
		min-height: 0;
	}
	.pcell {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		gap: 3px;
		min-width: 0;
		min-height: 0;
		animation: cellin 0.4s cubic-bezier(0.2, 0.9, 0.3, 1.2) backwards;
	}
	.tile-main.landed .pcell {
		animation: none;
	}
	@keyframes cellin {
		from { transform: scale(0.6); opacity: 0; }
		to { transform: scale(1); opacity: 1; }
	}
	/* Every cell is three layers: the parent column, a visual zone capped
	   at --viz but free to SHRINK with the cell (fixed px overflowed the
	   small tile and crowded labels into the next row), and a fixed-height
	   one-line subtext zone that never yields. Visuals fill their zone
	   (fill-mode icon, fluid dial), so logo and ring read at the same
	   size in every grid unit and the label always sits below, on one
	   baseline. */
	.pviz {
		flex: 1 1 auto;
		height: var(--viz, 54px);
		min-height: 0;
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.psubz {
		height: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		min-width: 0;
		flex: none;
	}
	.ident {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
		height: 100%;
		text-align: center;
		gap: 4px;
		min-width: 0;
		min-height: 0;
	}
	.ilogo {
		display: flex;
		justify-content: center;
		line-height: 0;
		height: 100%;
		aspect-ratio: 1;
		max-height: var(--viz, 54px);
		flex: none;
	}
	.pill {
		max-width: 100%;
		margin: 0 auto;
		font-size: 10px;
		font-weight: 650;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		background: rgb(128 128 128 / 0.16);
		border-radius: 999px;
		padding: 3px 10px;
	}
	.pill em {
		font-style: normal;
		font-weight: 500;
		opacity: 0.7;
	}
	/* quota window cell: ring in the visual zone + single quiet status
	   line in the subtext zone, one axis */
	.wcell {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
		height: 100%;
		text-align: center;
		gap: 4px;
		min-width: 0;
		min-height: 0;
	}
	.wlabel {
		width: 100%;
		max-width: 100%;
		font-size: 9.5px;
		font-weight: 600;
		color: var(--text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}
	.wlabel em {
		font-style: normal;
		font-weight: 500;
		opacity: 0.75;
	}
	/* a quota window with no data keeps the cell's silhouette: faint ring
	   at dial size, blank subtext — neighbors don't shift */
	.wempty-ring {
		height: 86%;
		aspect-ratio: 1;
		border-radius: 50%;
		border: 2px solid var(--track);
		flex: none;
	}
	.pempty {
		align-self: center;
		font-size: 12px;
		color: var(--text-3);
	}
	/* dials: fluid square inside the visual zone, capped at --viz. The
	   pct number scales with the ring (cqmin = % of the dial's own box). */
	.dial {
		position: relative;
		height: 100%;
		aspect-ratio: 1;
		max-height: var(--viz, 54px);
		container-type: size;
		flex: none;
	}
	.dial svg {
		width: 100%;
		height: 100%;
		transform: rotate(-90deg);
	}
	.dial-track {
		fill: none;
		stroke: var(--track);
		stroke-width: 9;
	}
	.dial-fill {
		fill: none;
		stroke-width: 9;
		stroke-linecap: round;
		opacity: 0.88;
		filter: drop-shadow(0 0 5px var(--glow, transparent));
		transition: stroke-dashoffset 0.5s ease;
	}
	.dial-pct {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 18cqmin;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.02em;
		line-height: 1;
	}
	/* rotation picker floats in the tile's bottom padding (5px from the
	   visible edge) so the grid keeps the full content row and centers
	   exactly — no layout space reserved for it. */
	.vpick {
		position: absolute;
		left: 50%;
		bottom: -21px;
		transform: translateX(-50%);
		z-index: 2;
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: center;
		gap: 2px;
		background: transparent;
		color: var(--text-2);
		pointer-events: auto;
		opacity: 0.45;
		transition: opacity 0.25s ease;
	}
	.vpick:hover,
	.vpick:focus-within {
		opacity: 1;
	}
	.vval {
		font-size: 11px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		white-space: nowrap;
	}
	.vbtn {
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text);
		width: 24px;
		height: 20px;
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
		opacity: 0.55;
		cursor: default;
	}
	/* modal: medium-style rows with hairline dividers */
	.conceal {
		visibility: hidden;
	}
	.pbody {
		display: flex;
		flex-direction: column;
		padding: 10px 8px 8px;
	}
	.psec {
		display: flex;
		flex-direction: column;
		border-radius: 18px;
		padding: 12px 22px 20px;
		background: color-mix(in srgb, var(--bg-raised) 45%, transparent);
	}
	.prefrow {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 6px;
	}
	.psub {
		font-size: 12px;
		color: var(--text-3);
		font-variant-numeric: tabular-nums;
	}
	.prow {
		display: grid;
		grid-template-columns: minmax(110px, 1.1fr) repeat(3, minmax(0, 1fr));
		gap: 8px;
		align-items: start;
		padding: 14px 12px;
		border-radius: 14px;
		background: color-mix(in srgb, var(--text) 7%, transparent);
	}
	.prow .pcell {
		align-items: flex-start;
		text-align: left;
	}
	.prow .ident-cell {
		align-items: center;
		text-align: center;
	}
	.prow .wlabel {
		font-size: 12px;
	}
	.pskel {
		display: grid;
		gap: 10px;
	}
	.pskel-row {
		display: grid;
		grid-template-columns: 1fr 2fr;
		gap: 10px;
	}
	.pskel-row .skel {
		height: 22px;
		display: block;
		border-radius: 6px;
		background: var(--track);
	}
	@media (prefers-reduced-motion: reduce) {
		.pcell { animation: none; }
		.dial-fill { transition: none; }
	}
</style>
