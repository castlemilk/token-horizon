<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type RuntimeInfo, type ProviderSummary } from '$lib/api';
	import { fmtTok, fmtBytes, fmtTps, totalTok, poll } from '$lib/format';

	let runtimes = $state<RuntimeInfo[]>([]);
	let summary = $state<ProviderSummary[]>([]);

	onMount(() =>
		poll(async () => {
			try {
				[runtimes, summary] = await Promise.all([
					api.runtimes(),
					api.summary().then((r) => r.providers)
				]);
			} catch {
				/* daemon down */
			}
		}, 5000)
	);

	const active = $derived(runtimes.filter((r) => r.running).length);
</script>

<div class="section-label">RUNTIMES · MEASURED OVER HTTP ({active} ACTIVE)</div>
{#if runtimes.filter((r) => r.running).length === 0}
	<div class="empty">no runtimes detected — local endpoints are probed automatically, remote ones via POST /runtimes/endpoints</div>
{/if}
{#each runtimes.filter((r) => r.running) as rt}
	<div class="card" style="margin-bottom: 8px">
		<div class="row" style="justify-content: space-between">
			<span><strong>{rt.display_name}</strong> <span class="faint mono-sm">{rt.vendor}</span></span>
			<span class="accent mono-sm">{fmtTps(rt.tok_per_sec)}</span>
		</div>
		<div class="row mono-sm dim" style="margin-top: 4px; flex-wrap: wrap">
			{#if rt.prompt_tok_per_sec != null}<span>prompt {rt.prompt_tok_per_sec.toFixed(1)}/s</span>{/if}
			{#if rt.generation_tokens_total != null}<span>gen {fmtTok(rt.generation_tokens_total)}</span>{/if}
			{#if rt.port}<span>:{rt.port}</span>{/if}
			{#if rt.extra?.loaded_models != null}<span>{rt.extra.loaded_models} models loaded</span>{/if}
			{#if rt.extra?.loaded_vram_bytes != null}<span>vram {fmtBytes(rt.extra.loaded_vram_bytes)}</span>{/if}
			<!-- Local process telemetry: rendered only when the daemon detected
			     local processes for this runtime (absent for remote hosts). -->
			{#if rt.extra?.proc_cpu_percent != null}<span>cpu {rt.extra.proc_cpu_percent.toFixed(0)}%</span>{/if}
			{#if rt.extra?.proc_mem_mb != null}<span>mem {fmtBytes(rt.extra.proc_mem_mb * 1048576)}</span>{/if}
			<span class="faint">tokens {fmtTok(rt.usage.tokens_all)}</span>
		</div>
	</div>
{/each}

<div class="section-label">METERED PROVIDERS · 30D</div>
{#if summary.length === 0}
	<div class="empty">no metered traffic yet — start meters with TH_METERS or runtime endpoints</div>
{/if}
{#each summary as prov}
	<div class="card" style="margin-bottom: 8px">
		<div class="row" style="justify-content: space-between">
			<span><strong>{prov.vendor.toUpperCase()}</strong> <span class="faint mono-sm">{prov.source}</span></span>
			<span class="dim mono-sm">{fmtTok(totalTok(prov.tokens))} tok · {prov.requests} req</span>
		</div>
		{#if prov.models.length > 0}
			<table style="margin-top: 6px">
				<thead>
					<tr><th>MODEL</th><th class="right">TOKENS</th><th class="right">REQ</th><th class="right">GEN TOK/S</th></tr>
				</thead>
				<tbody>
					{#each prov.models as m}
						<tr>
							<td class="dim">{m.model}</td>
							<td class="right">{fmtTok(totalTok(m.tokens))}</td>
							<td class="right">{m.requests}</td>
							<td class="right accent">{fmtTps(m.avgGenerationTokPerSec)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
{/each}
