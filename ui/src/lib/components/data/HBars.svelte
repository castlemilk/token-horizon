<script lang="ts" module>
	/** Horizontal rounded bars with per-row accent (provider/runtime colors). */
	export interface HBarRow {
		label: string;
		value: number;
		color: string;
		/** Vendor key — renders the brand chip before the label. */
		vendor?: string;
		/** Secondary line under the label (e.g. request counts). */
		sub?: string;
		/** Indent under a parent provider row. */
		indent?: boolean;
	}
</script>

<script lang="ts">
	import { fmtTok } from '$lib/format';
	import ProviderIcon from './ProviderIcon.svelte';

	let { rows, thin = false }: { rows: HBarRow[]; thin?: boolean } = $props();

	const max = $derived(Math.max(1, ...rows.map((r) => r.value)));
</script>

<div class="hbars" class:thin>
	{#each rows as r}
		<div class="hrow" class:indent={r.indent} title="{r.label} — {fmtTok(r.value)} tokens">
			<div class="meta">
				<span class="name">
					{#if r.vendor}<ProviderIcon vendor={r.vendor} size={14} />{/if}
					{r.label}
				</span>
				{#if r.sub}<span class="hsub">{r.sub}</span>{/if}
				<span class="val">{fmtTok(r.value)}</span>
			</div>
			<div class="track">
				<div
					class="fill"
					style:width="{(r.value / max) * 100}%"
					style:background={r.color}
				></div>
			</div>
		</div>
	{/each}
</div>

<style>
	.hbars {
		display: grid;
		gap: 10px;
	}
	.hbars.thin {
		gap: 7px;
	}
	.hrow.indent {
		padding-left: 14px;
	}
	.meta {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-bottom: 3px;
	}
	.name {
		font-size: 12px;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.indent .name {
		font-weight: 400;
		color: var(--text-2);
		font-family: var(--font-mono);
		font-size: 11.5px;
	}
	.hsub {
		font-size: 11px;
		color: var(--text-3);
		font-variant-numeric: tabular-nums;
	}
	.val {
		margin-left: auto;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		color: var(--text-2);
		flex: none;
	}
	.track {
		height: 6px;
		border-radius: 3px;
		background: var(--track);
		overflow: hidden;
	}
	.thin .track {
		height: 4px;
		border-radius: 2px;
	}
	.fill {
		height: 100%;
		border-radius: inherit;
		min-width: 2px;
	}
	.indent .fill {
		opacity: 0.72;
	}
</style>
