<script lang="ts">
	import { Settings2 } from 'lucide-svelte';
	import type { RuntimeInfo } from '$lib/api';
	import ProviderIcon from '$lib/components/data/ProviderIcon.svelte';
	import CountUp from '$lib/components/data/CountUp.svelte';
	import Sparkline from '$lib/components/data/Sparkline.svelte';
	import { fmtBytes, fmtTps } from '$lib/format';

	/** Running runtime cards with stats and sparklines. Meter port and
	 *  endpoint editing lives in the settings modal (one per vendor). */
	let {
		running,
		histories,
		runningVendors,
		onSettings
	}: {
		running: RuntimeInfo[];
		histories: Record<string, number[]>;
		runningVendors: Set<string>;
		onSettings: (vendor: string, title: string) => void;
	} = $props();
</script>

<div class="section-label">Runtimes</div>
{#if running.length === 0}
	<div class="empty">
		No local runtimes detected — local endpoints are probed automatically, remote ones via POST /runtimes/endpoints
	</div>
{:else}
	<div class="stack">
		{#each running as rt}
			<div class="card">
				<div class="row" style="justify-content: space-between">
					<span style="display: flex; align-items: center; gap: 7px">
						<ProviderIcon vendor={rt.vendor} size={24} />
						<strong>{rt.display_name}</strong>
						<span class="faint mono">{rt.vendor}</span>
						{#if runningVendors.has(rt.vendor)}
							<span class="faint" title="Request meter live">· metered</span>
						{/if}
					</span>
					<span style="display: flex; align-items: center; gap: 6px">
						<span class="accent num">{fmtTps(rt.tok_per_sec)}</span>
						<button
							class="gear"
							onclick={() => onSettings(rt.vendor, rt.display_name)}
							title="Meter settings for {rt.display_name}"
							aria-label="Meter settings for {rt.display_name}"
						>
							<Settings2 size={13} strokeWidth={2} />
						</button>
					</span>
				</div>
				{#if histories[rt.vendor]?.length}
					<div style="margin-top: 8px">
						<Sparkline values={histories[rt.vendor]} />
					</div>
				{/if}
				<div class="row dim num-sm" style="margin-top: 6px; flex-wrap: wrap; gap: 14px">
					{#if rt.prompt_tok_per_sec != null}<span>prompt {rt.prompt_tok_per_sec.toFixed(1)}/s</span>{/if}
					{#if rt.generation_tokens_total != null}<span>gen <CountUp value={rt.generation_tokens_total} /></span>{/if}
					{#if rt.port}<span class="mono">:{rt.port}</span>{/if}
					{#if rt.extra?.loaded_models != null}<span>{rt.extra.loaded_models} models loaded</span>{/if}
					{#if rt.extra?.loaded_vram_bytes != null}<span>vram {fmtBytes(rt.extra.loaded_vram_bytes)}</span>{/if}
					{#if rt.extra?.proc_cpu_percent != null}<span>cpu {rt.extra.proc_cpu_percent.toFixed(0)}%</span>{/if}
					{#if rt.extra?.proc_mem_mb != null}<span>mem {fmtBytes(rt.extra.proc_mem_mb * 1048576)}</span>{/if}
					<span class="faint">tokens <CountUp value={rt.usage.tokens_all} /></span>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	.gear {
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--text-3);
		width: 24px;
		height: 24px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.gear:hover {
		background: var(--track);
		color: var(--text);
	}
</style>
