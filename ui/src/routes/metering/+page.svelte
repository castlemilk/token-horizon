<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type RuntimeInfo, type Meters } from '$lib/api';
	import { connection } from '$lib/connection.svelte';
	import { fmtBytes, fmtTps, poll } from '$lib/format';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import ProviderIcon from '$lib/components/ProviderIcon.svelte';
	import CountUp from '$lib/components/CountUp.svelte';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { TOOL_ROUTES, agentBrief, copyText } from '$lib/routing';
	import { apiBase } from '$lib/api';
	import type { ConsentState, ServiceStatus } from '$lib/api';

	let runtimes = $state<RuntimeInfo[]>([]);
	let histories = $state<Record<string, number[]>>({});
	let meters = $state<Meters | null>(null);
	let consents = $state<ConsentState[]>([]);
	let service = $state<ServiceStatus | null>(null);
	/** Shared connection state — auto-reconnects with backoff, so this page
	 *  recovers on its own instead of latching a local down flag. */
	const daemonDown = $derived(connection.status === 'offline');
	let copied = $state<string | null>(null);

	function copy(text: string, key: string) {
		void copyText(text).then(() => {
			copied = key;
			setTimeout(() => (copied = null), 1500);
		});
	}

	async function setConsent(scope: string, granted: boolean) {
		try {
			await api.setConsent(scope, granted);
			consents = (await api.consents().catch(() => null))?.scopes ?? consents;
			meters = await api.meters().catch(() => meters);
		} catch {
			/* daemon down — recovery card shows it */
		}
	}

	async function installSvc() {
		try {
			service = await api.installService();
		} catch {
			/* unsupported — card shows the manual path */
		}
	}

	onMount(() =>
		poll(async () => {
			try {
				[runtimes, meters] = await Promise.all([api.runtimes(), api.meters()]);
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
				return;
			}
			try {
				consents = (await api.consents().catch(() => null))?.scopes ?? [];
			} catch {
				/* pre-consents daemon — treat as unknown, not denied */
			}
			try {
				service = await api.serviceStatus().catch(() => null);
			} catch {
				/* leave previous */
			}
		}, 4000)
	);

	async function toggleMeter(vendor: string, enabled: boolean) {
		try {
			await api.toggleMeter(vendor, enabled);
		} catch {
			/* consent missing or bind failed — the refresh below shows truth */
		}
		try {
			meters = await api.meters();
		} catch {
			/* daemon down */
		}
	}

	/* ---- Custom meter ports: numbers-only drafts per runtime vendor ---- */

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
			meters = await api.meters().catch(() => meters);
			delete portDrafts[vendor];
			portResult[vendor] = r.listen_port === port ? 'Live' : 'Saved';
		} catch (e) {
			portResult[vendor] = e instanceof Error ? e.message : 'Save failed';
		} finally {
			portSaving[vendor] = false;
		}
	}

	const running = $derived(
		runtimes.filter((r) => r.running).sort((a, b) => b.usage.tokens_all - a.usage.tokens_all)
	);
	const runningVendors = $derived(new Set((meters?.point ?? []).map((m) => m.vendor)));
	const liveMeters = $derived(new Map((meters?.point ?? []).map((m) => [m.vendor.toLowerCase(), m])));
	/** Catalog ordered by popularity: live meters first, then most-measured
	 *  traffic, alphabetical tiebreak — the vendors you actually use lead. */
	const catalog = $derived(
		[...(meters?.catalog ?? [])].sort((a, b) => {
			if (a.running !== b.running) return a.running ? -1 : 1;
			const traffic = (v: string) => {
				const m = liveMeters.get(v.toLowerCase());
				return (m?.seen ?? 0) + (m?.measured ?? 0);
			};
			return traffic(b.vendor) - traffic(a.vendor) || a.vendor.localeCompare(b.vendor);
		})
	);

	/* ---- Recovery: daemon-observable failure states + fixes ---- */
	const consentDenied = (s: string) =>
		consents.length > 0 && !(consents.find((c) => c.scope === s)?.granted ?? false);
	/** Runtime active (or has usage) but no meter listening — enable it. */
	const unmeteredActive = $derived(
		runtimes.filter((r) => {
			const k = r.vendor.toLowerCase();
			return (r.running || r.usage.tokens_all > 0) && !liveMeters.has(k);
		})
	);
	const hasLiveMeters = $derived((meters?.point ?? []).length > 0);
	const recoveryOpen = $derived(
		daemonDown ||
			hasLiveMeters ||
			unmeteredActive.length > 0 ||
			consentDenied('metering') ||
			consentDenied('fileReading')
	);

	function routeHint(m: { vendor: string; listen_port: number }): {
		title: string;
		body: string;
		cmd: string;
		brief: string;
	} {
		const v = m.vendor.toLowerCase();
		const tool = TOOL_ROUTES.find((t) => t.vendor === v);
		if (tool)
			return {
				title: `Point ${tool.tool} at this meter`,
				body: tool.fixBody,
				cmd: tool.fixCmd(m.listen_port),
				brief: tool.brief(m.listen_port)
			};
		return {
			title: `Point ${m.vendor} clients at this meter`,
			body: 'Set the vendor base URL in the client to the loopback meter — traffic forwards byte-identical upstream:',
			cmd: `http://127.0.0.1:${m.listen_port}`,
			brief: agentBrief(m.vendor, m.listen_port, '')
		};
	}
</script>

<div class="section-label">
	Request routing{meters ? ` · ${meters.mode} mode · ${meters.point.length} live` : ''}
</div>
{#if catalog.length === 0}
	<div class="empty">No meterable vendors discovered — the daemon catalog appears here</div>
{:else}
	<div class="meter-tiles">
		{#each catalog as m}
			<div class="card mtile">
				<div class="mtile-head">
					<span style="display: flex; align-items: center; gap: 7px" title={m.vendor}>
						<ProviderIcon vendor={m.vendor} size={20} />
						<strong>{m.vendor}</strong>
					</span>
					<span class="dot" class:up={m.running}></span>
				</div>
				<div class="mono mroute" class:faint={!m.running}>127.0.0.1:{m.listen_port}</div>
				<div class="mono dim mroute">→ {m.running ? (m.target ?? '—') : 'off'}</div>
				<div class="mtile-foot">
					<span class="faint">{m.running ? 'metering' : 'off'}</span>
					<Switch
						checked={m.running}
						onCheckedChange={(v) => void toggleMeter(m.vendor, v)}
						aria-label="Meter {m.vendor}"
					/>
				</div>
			</div>
		{/each}
	</div>
	<div class="hint" style="margin: 6px 0 0 2px; font-size: 11px; color: var(--text-3)">
		Point a tool at its listen URL and its traffic gets measured on the way
		through — nothing else changes. Switches stick; local runtimes pick up
		metering on their own unless you turn them off here.
	</div>
{/if}

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

{#if recoveryOpen}
	<div class="section-label">Recovery</div>
	<div class="stack">
		{#if daemonDown}
			<div class="card">
				<div class="rtitle">Daemon unreachable</div>
				<div class="dim rbody">
					Nothing is being measured right now — coding agents keep working,
					but their usage is invisible. The app keeps trying the original
					address below; start the daemon, then it reconnects on its own.
				</div>
				<div class="rrow">
					<code class="cmd">{apiBase()}</code>
					<button class="btn" onclick={() => copy(apiBase(), 'api-base')}>
						{copied === 'api-base' ? 'Copied' : 'Copy URL'}
					</button>
				</div>
				{#if service?.supported}
					<div class="rrow">
						<button class="btn" onclick={() => void installSvc()}>
							{service.installed ? 'Reinstall background service' : 'Install background service'}
						</button>
						{#if service.detail}<span class="faint rdetail">{service.detail}</span>{/if}
					</div>
				{:else if service}
					<div class="dim rbody">Auto-start is unsupported here ({service.mechanism}) — run the daemon manually.</div>
				{/if}
			</div>
		{/if}
		{#if consentDenied('metering')}
			<div class="card">
				<div class="rtitle">Metering not allowed</div>
				<div class="dim rbody">Loopback request meters cannot listen — no traffic can be measured.</div>
				<div class="rrow"><button class="btn" onclick={() => void setConsent('metering', true)}>Allow metering</button></div>
			</div>
		{/if}
		{#if consentDenied('fileReading')}
			<div class="card">
				<div class="rtitle">File reading not allowed</div>
				<div class="dim rbody">Tool labels and file-claimed costs cannot join metered requests (pi attribution stays blank).</div>
				<div class="rrow"><button class="btn" onclick={() => void setConsent('fileReading', true)}>Allow file reading</button></div>
			</div>
		{/if}
		{#each unmeteredActive as rt (rt.vendor)}
			<div class="card">
				<div class="rtitle">{rt.display_name} is active but unmetered</div>
				<div class="dim rbody">The runtime is running{rt.usage.tokens_all > 0 ? ' and has recorded usage' : ''}, yet no meter is listening — its traffic passes through unseen.</div>
				<div class="rrow"><button class="btn" onclick={() => void toggleMeter(rt.vendor, true)}>Start meter</button></div>
			</div>
		{/each}
		<div class="rsub">By tool — metered URI to use, original URI to fail back to</div>
		{#each TOOL_ROUTES as t (t.tool)}
			{@const live = liveMeters.get(t.vendor)}
			{@const port = live?.listen_port ?? meters?.catalog.find((c) => c.vendor.toLowerCase() === t.vendor)?.listen_port ?? t.defaultPort}
			{@const loopback = `http://127.0.0.1:${port}${t.meterPath}`}
			<div class="card">
				<div class="rtitle">
					{t.tool}{#if live}<span class="ok"> · meter live</span>{:else}<span class="faint"> · meter off</span>{/if}
				</div>
				<div class="dim rbody">Use it — point {t.tool} here:</div>
				<div class="rrow">
					<code class="cmd">{loopback}</code>
					<button class="btn" onclick={() => copy(loopback, `tool-use-${t.tool}`)}>
						{copied === `tool-use-${t.tool}` ? 'Copied' : 'Copy'}
					</button>
				</div>
				<div class="dim rbody" style="margin-top: 10px">If the meter fails, connect {t.tool} back here:</div>
				<div class="rrow">
					<code class="cmd">{t.upstream}</code>
					<button class="btn" onclick={() => copy(t.upstream, `tool-back-${t.tool}`)}>
						{copied === `tool-back-${t.tool}` ? 'Copied' : 'Copy'}
					</button>
					<button
						class="btn"
						title="Copy paste-ready instructions for a coding agent"
						onclick={() => copy(t.brief(port), `tool-brief-${t.tool}`)}
					>
						{copied === `tool-brief-${t.tool}` ? 'Copied' : 'Agent brief'}
					</button>
				</div>
			</div>
		{/each}
		<div class="rsub">By meter — live connection recovery</div>
		{#each meters?.point ?? [] as m (m.vendor)}			{@const hint = routeHint(m)}
			{@const seen = m.seen ?? 0}
			{@const measured = m.measured ?? 0}
			{@const loopback = `http://127.0.0.1:${m.listen_port}`}
			<div class="card">
				<div class="rtitle">
					{m.vendor}: {seen === 0
						? 'live, no arrivals yet'
						: measured === 0
							? 'traffic arriving, nothing measured'
							: `measuring · ${seen} seen · ${measured} recorded`}
				</div>
				<div class="dim rbody">Use it — point the client here (forwards byte-identical upstream):</div>
				<div class="rrow">
					<code class="cmd">{loopback}</code>
					<button class="btn" onclick={() => copy(loopback, `use-${m.vendor}`)}>
						{copied === `use-${m.vendor}` ? 'Copied' : 'Copy'}
					</button>
				</div>
				<div class="dim rbody" style="margin-top: 10px">
					If this meter fails, connect back to the original upstream so work continues unmeasured:
				</div>
				<div class="rrow">
					<code class="cmd">{m.target}</code>
					<button class="btn" onclick={() => copy(m.target, `bypass-${m.vendor}`)}>
						{copied === `bypass-${m.vendor}` ? 'Copied' : 'Copy'}
					</button>
				</div>
				{#if seen === 0}
					<div class="dim rbody" style="margin-top: 10px">{hint.body}</div>
					<div class="rrow">
						<code class="cmd">{hint.cmd}</code>
						<button class="btn" onclick={() => copy(hint.cmd, `route-${m.vendor}`)}>
							{copied === `route-${m.vendor}` ? 'Copied' : 'Copy'}
						</button>
						<button
							class="btn"
							title="Copy paste-ready instructions for a coding agent"
							onclick={() => copy(hint.brief, `brief-${m.vendor}`)}
						>
							{copied === `brief-${m.vendor}` ? 'Copied' : 'Agent brief'}
						</button>
					</div>
				{:else if measured === 0}
					<div class="dim rbody" style="margin-top: 10px">
						Requests arrive but the wire format does not parse — update the
						daemon to the latest build. If it persists, the vendor changed
						its API shape.
					</div>
				{/if}
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
	/* request routing as tiles: side by side when roomy, one long
	   column when not */
	.meter-tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
		gap: 10px;
	}
	.mtile-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 12.5px;
		margin-bottom: 6px;
	}
	.mtile {
		padding: 13px 14px;
	}
	.mroute {
		font-size: 10.5px;
		line-height: 1.5;
		overflow-x: auto;
		white-space: nowrap;
	}
	.mtile-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 8px;
		font-size: 11px;
	}
	.rtitle {
		font-size: 13px;
		font-weight: 600;
		margin-bottom: 5px;
	}
	.rsub {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-3);
		margin: 14px 0 -2px 2px;
	}
	.rbody {
		font-size: 12.5px;
	}
	.rrow {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 10px;
		flex-wrap: wrap;
	}
	.rdetail {
		font-size: 11.5px;
	}
	.cmd {
		font-family: var(--font-mono);
		font-size: 11px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 6px 9px;
		max-width: 100%;
		overflow-x: auto;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}
</style>
