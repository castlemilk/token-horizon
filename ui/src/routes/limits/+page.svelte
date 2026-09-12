<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type ProviderLimit } from '$lib/api';
	import { poll, fmtReset } from '$lib/format';
	import ProviderIcon from '$lib/components/ProviderIcon.svelte';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';

	let limits = $state<ProviderLimit[]>([]);

	onMount(() =>
		poll(async () => {
			try {
				limits = (await api.limits()).limits;
			} catch {
				/* daemon down */
			}
		}, 30000)
	);

	const grouped = $derived(
		limits.reduce<Record<string, ProviderLimit[]>>((acc, l) => {
			(acc[l.provider] ??= []).push(l);
			return acc;
		}, {})
	);

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

	/* activity-ring geometry */
	const R = 34;
	const C = 2 * Math.PI * R;
</script>

{#if Object.keys(grouped).length === 0}
	<div class="empty">no limits reported yet</div>
{/if}

{#each Object.entries(grouped) as [provider, rows]}
	{@const [vendor, account] = splitProvider(provider)}
	<section>
		<header class="lhead">
			<ProviderIcon vendor={vendor} size={17} />
			<span class="lname">{vendor}</span>
			{#if account}<span class="laccount faint">{account}</span>{/if}
		</header>
		<!-- mosaic: 3 across when roomy, 2 when not, leftover tiles land last -->
		<div class="mosaic">
			{#each rows as l}
				{@const pct = Math.min(Math.max(l.usedPercent, 0), 100)}
				<div class="tile">
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

<style>
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
</style>
