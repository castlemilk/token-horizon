<script lang="ts">
	import { api, type MeterInfo, type Meters, type RuntimeInfo } from '$lib/api';
	import ProviderIcon from '$lib/components/data/ProviderIcon.svelte';
	import CountUp from '$lib/components/data/CountUp.svelte';
	import Sparkline from '$lib/components/data/Sparkline.svelte';
	import { fmtBytes, fmtTps } from '$lib/format';

	/** Running runtime cards with stats, sparklines and the custom meter
	 *  port editor (numbers-only drafts, validated 1–65535). */
	let {
		running,
		histories,
		liveMeters,
		runningVendors,
		meters,
		onMeters
	}: {
		running: RuntimeInfo[];
		histories: Record<string, number[]>;
		liveMeters: Map<string, MeterInfo>;
		runningVendors: Set<string>;
		meters: Meters | null;
		onMeters: (m: Meters | null) => void;
	} = $props();

	/** Raw draft text per vendor; absent = show the live/default port. */
	let portDrafts = $state<Record<string, string>>({});
	/** Vendors with a save in flight. */
	let portSaving = $state<Record<string, boolean>>({});
	/** Last per-vendor result: 'ok' flash or daemon error text. */
	let portResult = $state<Record<string, string>>({});

	function meterPortFor(vendor: string): number | null {
		const key = vendor.toLowerCase();
		const live = liveMeters.get(key)?.listen_port;
		if (live != null) return live;
		return meters?.catalog.find((c) => c.vendor.toLowerCase() === key)?.listen_port ?? null;
	}

	function draftFor(vendor: string): string {
		return portDrafts[vendor] ?? String(meterPortFor(vendor) ?? '');
	}

	function portError(vendor: string): string | null {
		const raw = (portDrafts[vendor] ?? '').trim();
		if (!(vendor in portDrafts)) return null; // untouched — nothing to judge
		if (!/^\d{1,5}$/.test(raw)) return 'Digits only';
		const n = Number(raw);
		if (n < 1 || n > 65535) return 'Port must be 1–65535';
		if (n === meterPortFor(vendor)) return 'Already on this port';
		return null;
	}

	function stripNonDigits(vendor: string, el: HTMLInputElement) {
		const clean = el.value.replace(/\D+/g, '').slice(0, 5);
		if (clean !== el.value) el.value = clean;
		portDrafts[vendor] = clean;
		portResult[vendor] = '';
	}

	async function applyPort(vendor: string) {
		const err = portError(vendor);
		if (err || portSaving[vendor]) return;
		const port = Number(portDrafts[vendor].trim());
		portSaving[vendor] = true;
		portResult[vendor] = '';
		try {
			const r = await api.setMeterPort(vendor, port);
			onMeters(await api.meters().catch(() => meters));
			delete portDrafts[vendor];
			portResult[vendor] = r.listen_port === port ? 'Live' : 'Saved';
		} catch (e) {
			portResult[vendor] = e instanceof Error ? e.message : 'Save failed';
		} finally {
			portSaving[vendor] = false;
		}
	}
</script>

<div class="section-label">Runtimes</div>
{#if running.length === 0}
	<div class="empty">
		No local runtimes detected — local endpoints are probed automatically, remote ones via POST /runtimes/endpoints
	</div>
{:else}
	<div class="stack">
		{#each running as rt}
			{@const perr = portError(rt.vendor)}
			{@const canSave = rt.vendor in portDrafts && !perr && !portSaving[rt.vendor]}
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
					<span class="accent num">{fmtTps(rt.tok_per_sec)}</span>
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
				<div class="portrow">
					<span class="dim">Meter port</span>
					<input
						class="pinput mono"
						class:error={!!perr}
						inputmode="numeric"
						pattern="[0-9]*"
						autocomplete="off"
						spellcheck="false"
						maxlength={5}
						placeholder={String(meterPortFor(rt.vendor) ?? '')}
						value={draftFor(rt.vendor)}
						oninput={(e) => stripNonDigits(rt.vendor, e.currentTarget)}
						onkeydown={(e) => {
							if (e.key === 'Enter') void applyPort(rt.vendor);
						}}
						aria-label="Meter port for {rt.display_name}"
					/>
					<button
						class="btn"
						disabled={!canSave}
						onclick={() => void applyPort(rt.vendor)}
					>
						{portSaving[rt.vendor] ? '…' : 'Apply'}
					</button>
					{#if perr}
						<span class="perr">{perr}</span>
					{:else if portResult[rt.vendor]}
						<span class="pok" class:bad={portResult[rt.vendor] !== 'Live' && portResult[rt.vendor] !== 'Saved'}>
							{portResult[rt.vendor]}
						</span>
					{:else}
						<span class="faint">127.0.0.1:{meterPortFor(rt.vendor) ?? '—'}</span>
					{/if}
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	/* custom meter port: numbers-only, validated 1–65535 */
	.portrow {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
		font-size: 12px;
		flex-wrap: wrap;
	}
	.pinput {
		width: 76px;
		border: 1px solid var(--line);
		background: var(--bg);
		color: var(--text);
		border-radius: 8px;
		font-size: 12px;
		padding: 5px 9px;
		font-variant-numeric: tabular-nums;
	}
	.pinput:focus {
		outline: 2px solid var(--accent);
		outline-offset: 0;
		border-color: transparent;
	}
	.pinput.error {
		border-color: var(--bad);
		background: color-mix(in srgb, var(--bad) 7%, var(--bg));
	}
	.pinput.error:focus {
		outline-color: var(--bad);
	}
	.portrow .btn:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.perr {
		color: var(--bad);
		font-size: 11.5px;
		font-weight: 600;
	}
	.pok {
		color: var(--ok);
		font-size: 11.5px;
		font-weight: 600;
	}
	.pok.bad {
		color: var(--bad);
		font-weight: 500;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
