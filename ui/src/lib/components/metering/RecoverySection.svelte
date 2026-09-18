<script lang="ts">
	import { apiBase, type ConsentState, type MeterInfo, type Meters, type RuntimeInfo, type ServiceStatus } from '$lib/api';
	import CopyField from '$lib/components/common/CopyField.svelte';
	import InstructionModal, { type InstructionStep } from './InstructionModal.svelte';
	import { TOOL_ROUTES, agentBrief } from '$lib/routing';

	/** Recovery + setup: failure-state cards stay inline; the verbose
	 *  per-tool / per-meter setup instructions live in guide modals. */
	let {
		daemonDown,
		service,
		consents,
		unmeteredActive,
		liveMeters,
		meters,
		onToggleMeter,
		onConsent,
		onInstallSvc
	}: {
		daemonDown: boolean;
		service: ServiceStatus | null;
		consents: ConsentState[];
		unmeteredActive: RuntimeInfo[];
		liveMeters: Map<string, MeterInfo>;
		meters: Meters | null;
		onToggleMeter: (vendor: string, enabled: boolean) => void;
		onConsent: (scope: string, granted: boolean) => void;
		onInstallSvc: () => void;
	} = $props();

	const consentDenied = (s: string) =>
		consents.length > 0 && !(consents.find((c) => c.scope === s)?.granted ?? false);
	const hasLiveMeters = $derived((meters?.point ?? []).length > 0);
	const open = $derived(
		daemonDown ||
			hasLiveMeters ||
			unmeteredActive.length > 0 ||
			consentDenied('metering') ||
			consentDenied('fileReading')
	);

	type Guide = { title: string; intro: string; steps: InstructionStep[]; brief: string } | null;
	let guide = $state<Guide>(null);

	function toolPort(vendor: string): number {
		const t = TOOL_ROUTES.find((x) => x.vendor === vendor);
		return (
			liveMeters.get(vendor)?.listen_port ??
			meters?.catalog.find((c) => c.vendor.toLowerCase() === vendor)?.listen_port ??
			t?.defaultPort ??
			0
		);
	}

	function openToolGuide(tool: (typeof TOOL_ROUTES)[number]) {
		const port = toolPort(tool.vendor);
		guide = {
			title: `${tool.tool} setup`,
			intro: `Point ${tool.tool} at its meter — traffic forwards byte-identical upstream and is measured in flight.`,
			steps: [
				{ body: `Use it — point ${tool.tool} here:`, copy: `http://127.0.0.1:${port}${tool.meterPath}` },
				{ body: `If the meter fails, connect ${tool.tool} back here:`, copy: tool.upstream }
			],
			brief: tool.brief(port)
		};
	}

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

	function openMeterGuide(vendor: string) {
		const live = liveMeters.get(vendor);
		const m = (meters?.point ?? []).find((x) => x.vendor.toLowerCase() === vendor);
		if (!live || !m) return;
		const hint = routeHint(m);
		guide = {
			title: hint.title,
			intro: 'Use it — point the client here (forwards byte-identical upstream):',
			steps: [
				{ body: `Meter URL:`, copy: `http://127.0.0.1:${m.listen_port}` },
				{
					body: 'If this meter fails, connect back to the original upstream so work continues unmeasured:',
					copy: m.target
				},
				{ body: hint.body, copy: hint.cmd }
			],
			brief: hint.brief
		};
	}
</script>

{#if open}
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
				<CopyField text={apiBase()} label="Copy URL" />
				{#if service?.supported}
					<div class="rrow">
						<button class="btn" onclick={() => onInstallSvc()}>
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
				<div class="rrow"><button class="btn" onclick={() => onConsent('metering', true)}>Allow metering</button></div>
			</div>
		{/if}
		{#if consentDenied('fileReading')}
			<div class="card">
				<div class="rtitle">File reading not allowed</div>
				<div class="dim rbody">Tool labels and file-claimed costs cannot join metered requests (pi attribution stays blank).</div>
				<div class="rrow"><button class="btn" onclick={() => onConsent('fileReading', true)}>Allow file reading</button></div>
			</div>
		{/if}
		{#each unmeteredActive as rt (rt.vendor)}
			<div class="card">
				<div class="rtitle">{rt.display_name} is active but unmetered</div>
				<div class="dim rbody">The runtime is running{rt.usage.tokens_all > 0 ? ' and has recorded usage' : ''}, yet no meter is listening — its traffic passes through unseen.</div>
				<div class="rrow"><button class="btn" onclick={() => onToggleMeter(rt.vendor, true)}>Start meter</button></div>
			</div>
		{/each}
		<div class="rsub">By tool — setup guides</div>
		{#each TOOL_ROUTES as t (t.tool)}
			{@const live = liveMeters.get(t.vendor)}
			<div class="card">
				<div class="rtitle">
					{t.tool}{#if live}<span class="ok"> · meter live</span>{:else}<span class="faint"> · meter off</span>{/if}
				</div>
				<div class="dim rbody">Metered URI, failback URI and the paste-ready agent brief live in the setup guide:</div>
				<div class="rrow">
					<button class="btn" onclick={() => openToolGuide(t)}>Setup guide</button>
				</div>
			</div>
		{/each}
		<div class="rsub">By meter — live connection recovery</div>
		{#each meters?.point ?? [] as m (m.vendor)}
			{@const seen = m.seen ?? 0}
			{@const measured = m.measured ?? 0}
			<div class="card">
				<div class="rtitle">
					{m.vendor}: {seen === 0
						? 'live, no arrivals yet'
						: measured === 0
							? 'traffic arriving, nothing measured'
							: `measuring · ${seen} seen · ${measured} recorded`}
				</div>
				{#if seen === 0}
					<div class="dim rbody">No arrivals yet — the point-at-me instructions live in the setup guide:</div>
					<div class="rrow">
						<button class="btn" onclick={() => openMeterGuide(m.vendor)}>Setup guide</button>
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

<InstructionModal
	open={guide != null}
	onClose={() => (guide = null)}
	title={guide?.title ?? ''}
	intro={guide?.intro ?? ''}
	steps={guide?.steps ?? []}
	brief={guide?.brief ?? ''}
/>

<style>
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
</style>
