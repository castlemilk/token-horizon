<script lang="ts">
	import { onMount } from 'svelte';
	import type { ProviderLimit } from '$lib/api';
	import { connection } from '$lib/connection.svelte';
	import { limitsStore, fmtAgoShort, STALE_AFTER_MS } from '$lib/limits.svelte';
	import { poll, fmtReset } from '$lib/format';
	import ProviderIcon from '$lib/components/ProviderIcon.svelte';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import PlugZap from '@lucide/svelte/icons/plug-zap';

	// Shared cache renders instantly on tab remount; this ticker just keeps
	// the "updated Xs ago" line fresh.
	let now = $state(Date.now());

	onMount(() => {
		const stopWatch = limitsStore.watch();
		const stopTick = poll(() => {
			now = Date.now();
		}, 5000);
		return () => {
			stopWatch();
			stopTick();
		};
	});

	interface Group {
		vendor: string;
		account: string | null;
		rows: ProviderLimit[];
		peak: number;
	}

	const groups = $derived.by<Group[]>(() => {
		const byProvider = limitsStore.limits.reduce<Record<string, ProviderLimit[]>>((acc, l) => {
			(acc[l.provider] ??= []).push(l);
			return acc;
		}, {});
		return Object.entries(byProvider)
			.map(([provider, rows]) => {
				const [vendor, account] = splitProvider(provider);
				const sorted = [...rows].sort((a, b) => b.usedPercent - a.usedPercent);
				return { vendor, account, rows: sorted, peak: sorted[0]?.usedPercent ?? 0 };
			})
			.sort((a, b) => b.peak - a.peak);
	});

	const totalWindows = $derived(limitsStore.limits.length);
	const hotCount = $derived(limitsStore.limits.filter((l) => l.usedPercent >= 90).length);

	function color(pct: number): string {
		if (pct >= 90) return 'var(--bad)';
		if (pct >= 70) return 'var(--warn)';
		return 'var(--ok)';
	}

	/** "kimi (kimi-code)" → ["kimi", "kimi-code"] for display. */
	function splitProvider(p: string): [string, string | null] {
		const m = p.match(/^(.*?)\s*\((.*)\)$/);
		return m ? [m[1], m[2]] : [p, null];
	}

	function updatedText(): string {
		if (!limitsStore.updatedAt) return '';
		const age = Date.now() - limitsStore.updatedAt;
		if (age > STALE_AFTER_MS) return `stale · ${fmtAgoShort(limitsStore.updatedAt)}`;
		return fmtAgoShort(limitsStore.updatedAt);
	}

	/* activity-ring geometry */
	const R = 34;
	const C = 2 * Math.PI * R;
</script>

<header class="phead">
	<div>
		<h1>Limits</h1>
		<p class="faint sub">
			{#if limitsStore.loading}
				checking quota windows…
			{:else if totalWindows > 0}
				{totalWindows} window{totalWindows === 1 ? '' : 's'}{#if hotCount > 0} · <span class="hot">{hotCount} hot</span>{/if} · updated {updatedText()}
			{:else if !connection.online}
				daemon offline — showing nothing yet
			{:else}
				no quota windows yet — they appear after the first metered request
			{/if}
		</p>
	</div>
	<button
		class="refresh"
		onclick={() => void limitsStore.refreshNow()}
		disabled={limitsStore.refreshing || !connection.online}
		title="Force quota re-check"
		aria-label="Refresh limits"
	>
		<span class="ric" class:spinning={limitsStore.refreshing}><RefreshCw size={14} strokeWidth={2.2} /></span>
		<span>{limitsStore.refreshing ? 'Checking…' : 'Refresh'}</span>
	</button>
</header>

{#if !connection.online && totalWindows === 0 && !limitsStore.loading}
	<div class="banner">
		<PlugZap size={14} strokeWidth={2} />
		<span>Listener offline — reconnecting automatically…</span>
		<button class="link" onclick={() => connection.retry()}>retry now</button>
	</div>
{/if}

{#if limitsStore.loading}
	<!-- skeleton: same tile shape so first paint doesn't jump -->
	<section>
		<header class="lhead"><span class="sk sk-icon"></span><span class="sk sk-name"></span></header>
		<div class="mosaic">
			{#each [0, 1, 2] as _}
				<div class="tile"><span class="sk sk-dial"></span><span class="sk sk-line"></span></div>
			{/each}
		</div>
	</section>
{:else}
	{#each groups as g}
		<section>
			<header class="lhead">
				<ProviderIcon vendor={g.vendor} size={17} />
				<span class="lname">{g.vendor}</span>
				{#if g.account}<span class="laccount faint">{g.account}</span>{/if}
				{#if limitsStore.stale}<span class="stale">stale</span>{/if}
			</header>
			<!-- mosaic: 3 across when roomy, 2 when not, leftover tiles land last -->
			<div class="mosaic">
				{#each g.rows as l}
					{@const pct = Math.min(Math.max(l.usedPercent, 0), 100)}
					<div class="tile" class:hot={pct >= 90}>
						<div class="dial">
							<svg viewBox="0 0 84 84" aria-hidden="true">
								<circle cx="42" cy="42" r={R} class="dial-track" />
								<circle
									cx="42" cy="42" r={R}
									class="dial-fill"
									style:stroke={color(pct)}
									stroke-dasharray="{C}"
									stroke-dashoffset={C * (1 - pct / 100)}
								/>
							</svg>
							<span class="dial-pct num" style="color: {color(pct)}">{pct.toFixed(0)}%</span>
						</div>
						<div class="tile-label">{l.label}</div>
						{#if l.detail || l.resetsAt}
							<div class="faint tile-sub">
								{#if l.detail}{l.detail}{/if}
								{#if l.resetsAt}
									<span class="reset"><RotateCcw size={10.5} strokeWidth={2.2} />{fmtReset(l.resetsAt)}</span>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/each}
{/if}

<style>
	.phead {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 22px;
	}
	.phead h1 {
		font-size: 20px;
		font-weight: 680;
		letter-spacing: -0.02em;
		margin: 0 0 4px;
	}
	.sub {
		font-size: 12px;
		margin: 0;
	}
	.hot {
		color: var(--bad);
		font-weight: 600;
	}
	.refresh {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 12.5px;
		font-weight: 550;
		padding: 8px 14px;
		border-radius: 10px;
		border: 1px solid transparent;
		background: var(--bg-raised);
		color: var(--text);
		cursor: pointer;
		flex: none;
		transition: transform 0.15s ease, opacity 0.15s ease;
	}
	.refresh:hover:not(:disabled) {
		transform: translateY(-1px);
	}
	.refresh:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.refresh .ric {
		display: inline-flex;
	}
	.refresh .ric.spinning {
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
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
		color: var(--accent, inherit);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
		text-decoration: underline;
		margin-left: auto;
	}
	section {
		margin-bottom: 44px;
	}
	.lhead {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 15px;
		font-weight: 620;
		letter-spacing: -0.01em;
		margin-bottom: 18px;
	}
	.laccount {
		font-size: 12px;
		font-weight: 400;
	}
	.stale {
		font-size: 10.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--warn);
		border: 1px solid currentColor;
		border-radius: 6px;
		padding: 2px 6px;
	}

	/* mosaic: auto-fit so 2 tiles split the row 50/50 on wide screens,
	   3 when there are enough windows, stragglers land on the last row */
	.mosaic {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
		gap: 14px;
	}

	/* Apple widget tile: soft raised fill, no hard border */
	.tile {
		background: var(--bg-raised);
		border-radius: 18px;
		overflow: hidden;
		padding: 20px 18px 16px;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		transition: transform 0.15s ease, box-shadow 0.15s ease;
	}
	.tile:hover {
		transform: translateY(-1px);
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
	}
	.tile.hot {
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bad) 45%, transparent);
	}

	.dial {
		position: relative;
		width: 84px;
		height: 84px;
	}
	.dial svg {
		width: 100%;
		height: 100%;
		transform: rotate(-90deg);
	}
	.dial-track {
		fill: none;
		stroke: var(--track);
		stroke-width: 7;
	}
	.dial-fill {
		fill: none;
		stroke-width: 7;
		stroke-linecap: round;
		transition: stroke-dashoffset 0.5s ease;
	}
	.dial-pct {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 17px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.02em;
	}

	.tile-label {
		margin-top: 12px;
		font-size: 13px;
		font-weight: 550;
	}
	.tile-sub {
		margin-top: 4px;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
	}
	.reset {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	/* skeleton shimmer */
	.sk {
		display: block;
		border-radius: 8px;
		background: linear-gradient(100deg, var(--bg-raised) 40%, var(--track) 50%, var(--bg-raised) 60%);
		background-size: 200% 100%;
		animation: shimmer 1.2s ease-in-out infinite;
	}
	.sk-icon {
		width: 17px;
		height: 17px;
		border-radius: 50%;
	}
	.sk-name {
		width: 110px;
		height: 15px;
	}
	.sk-dial {
		width: 84px;
		height: 84px;
		border-radius: 50%;
	}
	.sk-line {
		width: 70px;
		height: 12px;
		margin-top: 12px;
	}
	@keyframes shimmer {
		to {
			background-position: -200% 0;
		}
	}
</style>
