<script lang="ts">
	import { onMount } from 'svelte';
	import type { ProviderLimit } from '$lib/api';
	import { connection } from '$lib/connection.svelte';
	import { limitsStore } from '$lib/limits.svelte';
	import { fmtReset } from '$lib/format';
	import ProviderIcon from '$lib/components/data/ProviderIcon.svelte';
	import EmptyState from '$lib/components/common/EmptyState.svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import PlugZap from '@lucide/svelte/icons/plug-zap';

	onMount(() => limitsStore.watch());

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

	/* dial geometry; rendered diameter scales with heat (64–96px) */
	const R = 34;
	const C = 2 * Math.PI * R;


</script>

<div class="lim">
<header class="phead phead-slim">
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
	<!-- skeleton: quiet dials -->
	<section class="group">
		<header class="lhead"><span class="sk sk-icon"></span><span class="sk sk-name"></span></header>
		<div class="mosaic">
			{#each [0, 1, 2] as _}
				<div class="dtile"><span class="sk sk-ddial"></span><span class="sk sk-dline"></span></div>
			{/each}
		</div>
	</section>
{:else if groups.length === 0}
	<EmptyState
		title="No quota windows"
		body={!connection.online
			? 'The listener is offline — windows appear once it reconnects.'
			: 'Windows appear after the first metered request or quota poll.'}
	/>
{:else}
	<div class="groups">
	{#each groups as g}
		<section class="group">
			<header class="lhead">
				<span class="vchip"><ProviderIcon vendor={g.vendor} size={18} /></span>
				<span class="lname">{g.vendor}</span>
				{#if g.account}<span class="acct">{g.account}</span>{/if}
				{#if limitsStore.stale}<span class="stale">stale</span>{/if}
			</header>
			<div class="mosaic">
				{#each g.rows as l}
					{@const pct = Math.min(Math.max(l.usedPercent, 0), 100)}
					<div class="dtile">
						<div class="dial">
							<svg viewBox="0 0 84 84" aria-hidden="true">
								<circle cx="42" cy="42" r={R} class="dial-track" />
								<circle
									cx="42" cy="42" r={R}
									class="dial-fill"
									style:stroke={color(pct)}
									style:--glow={color(pct)}
									stroke-dasharray="{C}"
									stroke-dashoffset={C * (1 - pct / 100)}
								/>
							</svg>
							<span class="dial-pct num" style="color: {color(pct)}">{pct.toFixed(0)}</span>
						</div>
						<div class="dtile-label">{l.label}</div>
						{#if l.detail || l.resetsAt}
							<div class="faint dtile-sub">
								{#if l.detail}{l.detail}{/if}
								{#if l.resetsAt}
									<span class="reset">{fmtReset(l.resetsAt)}</span>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/each}
	</div>
{/if}
</div>

<style>
	/* page container: dials + type scale with it, not the viewport */
	.lim {
		container-type: inline-size;
	}
	/* page frame (.phead) is shared in app.css; slim variant is just the
	   refresh action, no title block */
	.phead-slim {
		justify-content: flex-end;
		border-bottom: none;
		padding-bottom: 0;
		margin-bottom: 18px;
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
		background: color-mix(in srgb, var(--bg-raised) 62%, transparent);
		backdrop-filter: blur(22px) saturate(1.6);
		-webkit-backdrop-filter: blur(22px) saturate(1.6);
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
		background: color-mix(in srgb, var(--bg-raised) 62%, transparent);
		backdrop-filter: blur(22px) saturate(1.6);
		-webkit-backdrop-filter: blur(22px) saturate(1.6);
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
		margin-bottom: 0;
	}
	/* vendor groups: always two side by side */
	.groups {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 20px;
		align-items: start;
	}
	/* vendor group: neutral frosted tile — the rings play through */
	.group {
		background: color-mix(in srgb, var(--bg-raised) 62%, transparent);
		backdrop-filter: blur(22px) saturate(1.6);
		-webkit-backdrop-filter: blur(22px) saturate(1.6);
		border-radius: 20px;
		padding: 18px 18px 16px;
	}
	.lhead {
		display: flex;
		align-items: center;
		gap: 9px;
		margin-bottom: 8px;
	}
	.vchip {
		width: 34px;
		height: 34px;
		border-radius: 11px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--accent-soft);
		flex: none;
	}
	.lname {
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.acct {
		font-size: 11px;
		font-weight: 600;
		color: var(--text-2);
		background: var(--accent-soft);
		border-radius: 999px;
		padding: 3px 9px;
	}
	.stale {
		font-size: 10.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--warn);
	}

	/* dial mosaic: uniform rounded indicators — compact on small
	   screens, roomier on large */
	.mosaic {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 8px 12px;
		align-items: end;
	}
	.dtile {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		padding: 12px 6px 8px;
	}
	/* dials size with the page container: compact in a narrow shell,
	   roomier when the window opens up */
	.dial {
		position: relative;
		width: 60px;
		width: clamp(52px, 17cqi, 84px);
		aspect-ratio: 1;
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
		font-size: 14px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.02em;
	}
	.dtile-label {
		margin-top: 8px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.dtile-sub {
		margin-top: 4px;
		font-size: 10.5px;
		font-variant-numeric: tabular-nums;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
	}
	.reset {
		display: inline-flex;
		align-items: center;
		background: var(--accent-soft);
		border-radius: 999px;
		padding: 2px 8px;
		flex: none;
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
	.sk-ddial {
		width: 60px;
		width: clamp(52px, 17cqi, 84px);
		aspect-ratio: 1;
		border-radius: 50%;
	}
	.sk-dline {
		width: 70px;
		height: 12px;
		margin-top: 10px;
	}
	@keyframes shimmer {
		to {
			background-position: -200% 0;
		}
	}
</style>
