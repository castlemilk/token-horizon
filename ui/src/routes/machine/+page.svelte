<script lang="ts">
	import { onMount } from 'svelte';
	import {
		api,
		type Stats,
		type RuntimeInfo,
		type ProcSample
	} from '$lib/api';
	import { fmtTok, fmtBytes, fmtTps, poll } from '$lib/format';
	import { providerAccent } from '$lib/colors';
	import { settings } from '$lib/settings.svelte';
	import { scope } from '$lib/scope.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';

	let stats = $state<Stats | null>(null);
	let runtimes = $state<RuntimeInfo[]>([]);
	let procs = $state<Record<string, ProcSample[]>>({});
	let histories = $state<Record<string, number[]>>({});

	onMount(() =>
		poll(async () => {
			try {
				[stats, runtimes, procs] = await Promise.all([
					api.stats(),
					api.runtimes(),
					api.processes()
				]);
				// tok/s history per running runtime (coarse 30s rollups).
				for (const rt of runtimes.filter((r) => r.running)) {
					if (histories[rt.vendor]) continue;
					api.runtimeHistory(rt.vendor, true)
						.then((h) => {
							histories = {
								...histories,
								[rt.vendor]: h.points.map((p) => p.tok_per_sec ?? 0)
							};
						})
						.catch(() => {});
				}
			} catch {
				/* daemon down */
			}
		}, 4000)
	);

	const visible = $derived(runtimes.filter((r) => settings.runtimeEnabled(r.vendor)));
	const running = $derived(visible.filter((r) => r.running));
	const ramPct = $derived(
		stats ? (stats.system.ram_used_gb / Math.max(stats.system.ram_total_gb, 1)) * 100 : 0
	);
	const topCpu = $derived((procs.byCPU ?? []).slice(0, 6));
	const topMem = $derived((procs.byMem ?? procs.byMemory ?? []).slice(0, 6));
</script>

<div class="section-label">This machine{scope.thisMachineName !== 'this machine' ? ` · ${scope.thisMachineName}` : ''}</div>
<div class="grid cols-4">
	<div class="card kpi">
		<div class="value">{stats ? stats.system.cpu_percent.toFixed(0) : '—'}<span class="unit">%</span></div>
		<div class="label">CPU</div>
		<div class="bar-track" style="margin-top: 8px">
			<div class="bar-fill" style:width="{stats?.system.cpu_percent ?? 0}%"></div>
		</div>
	</div>
	<div class="card kpi">
		<div class="value">{stats ? stats.system.ram_used_gb.toFixed(0) : '—'}<span class="unit">GB</span></div>
		<div class="label">Memory · {stats?.system.ram_total_gb.toFixed(0) ?? '—'} GB</div>
		<div class="bar-track" style="margin-top: 8px">
			<div class="bar-fill" style:width="{ramPct}%"></div>
		</div>
	</div>
	<div class="card kpi">
		<div class="value">{stats ? stats.system.load_1m.toFixed(1) : '—'}</div>
		<div class="label">Load · 1m</div>
	</div>
	<div class="card kpi">
		<div class="value">{running.length}</div>
		<div class="label">Runtimes active</div>
	</div>
</div>

<div class="section-label">Runtimes</div>
{#if running.length === 0}
	<div class="empty">
		No local runtimes detected — local endpoints are probed automatically, remote ones via POST /runtimes/endpoints
	</div>
{:else}
	<div class="stack">
		{#each running as rt}
			{@const accent = providerAccent(rt.vendor)}
			<div class="card">
				<div class="row" style="justify-content: space-between">
					<span>
						<span class="swatch" style:background={accent}></span>
						<strong>{rt.display_name}</strong>
						<span class="faint mono">{rt.vendor}</span>
					</span>
					<span class="accent num">{fmtTps(rt.tok_per_sec)}</span>
				</div>
				{#if histories[rt.vendor]?.length}
					<div style="margin-top: 8px">
						<Sparkline values={histories[rt.vendor]} />
					</div>
				{/if}
				<div class="row dim num-sm" style="margin-top: 6px; flex-wrap: wrap; gap: 14px">
					{#if rt.prompt_tok_per_sec != null}<span>prompt {rt.prompt_tok_per_sec.toFixed(1)}/s</span>{/if}
					{#if rt.generation_tokens_total != null}<span>gen {fmtTok(rt.generation_tokens_total)}</span>{/if}
					{#if rt.port}<span class="mono">:{rt.port}</span>{/if}
					{#if rt.extra?.loaded_models != null}<span>{rt.extra.loaded_models} models loaded</span>{/if}
					{#if rt.extra?.loaded_vram_bytes != null}<span>vram {fmtBytes(rt.extra.loaded_vram_bytes)}</span>{/if}
					{#if rt.extra?.proc_cpu_percent != null}<span>cpu {rt.extra.proc_cpu_percent.toFixed(0)}%</span>{/if}
					{#if rt.extra?.proc_mem_mb != null}<span>mem {fmtBytes(rt.extra.proc_mem_mb * 1048576)}</span>{/if}
					<span class="faint">tokens {fmtTok(rt.usage.tokens_all)}</span>
				</div>
			</div>
		{/each}
	</div>
{/if}

{#if topCpu.length > 0 || topMem.length > 0}
	<div class="section-label">Processes</div>
	<div class="grid cols-2">
		{#if topCpu.length > 0}
			<div class="card">
				<table>
					<thead><tr><th>Top CPU</th><th class="right">CPU</th><th class="right">Mem</th></tr></thead>
					<tbody>
						{#each topCpu as p}
							<tr>
								<td class="mono dim">{p.name}</td>
								<td class="right num">{p.cpu.toFixed(0)}%</td>
								<td class="right num">{fmtBytes(p.memMB * 1048576)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#if topMem.length > 0}
			<div class="card">
				<table>
					<thead><tr><th>Top memory</th><th class="right">Mem</th><th class="right">CPU</th></tr></thead>
					<tbody>
						{#each topMem as p}
							<tr>
								<td class="mono dim">{p.name}</td>
								<td class="right num">{fmtBytes(p.memMB * 1048576)}</td>
								<td class="right num">{p.cpu.toFixed(0)}%</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
{/if}

<style>
	.unit {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-2);
		margin-left: 2px;
	}
	.swatch {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 2.5px;
		margin-right: 7px;
	}
</style>
