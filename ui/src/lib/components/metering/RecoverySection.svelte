<script lang="ts">
	import { BookOpen, ChevronRight, Gauge } from 'lucide-svelte';
	import { apiBase, type ConsentState, type MeterInfo, type Meters, type RuntimeInfo, type ServiceStatus } from '$lib/api';
	import Modal from '$lib/components/common/Modal.svelte';
	import ProviderIcon from '$lib/components/data/ProviderIcon.svelte';
	import InstructionModal, { type InstructionStep } from './InstructionModal.svelte';
	import { TOOL_ROUTES, agentBrief } from '$lib/routing';

	/** Recovery as a compact list: every row opens its detail modal in
	 *  place (fix buttons, URLs, setup guides) — the page stays compact. */
	let {
		daemonDown,
		service,
		consents,
		unmeteredActive,
		liveMeters,
		meters,
		onToggleMeter,
		onConsent,
		onInstallSvc,
		open,
		bare = false
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
		/** External gate (the page owns it so badges match). */
		open: boolean;
		/** Bare for modal embedding (the dialog owns the title). */
		bare?: boolean;
	} = $props();

	const consentDenied = (s: string) =>
		consents.length > 0 && !(consents.find((c) => c.scope === s)?.granted ?? false);

	/** Problems vs plain setup: the section is only "recovery" when
	 *  something is actually wrong, otherwise it's just guides. */
	const hasProblems = $derived(
		daemonDown || unmeteredActive.length > 0 || consentDenied('metering') || consentDenied('fileReading')
	);

	type Dialog = {
		title: string;
		intro: string;
		steps?: InstructionStep[];
		brief?: string;
		actionLabel?: string;
		onAction?: () => void;
		vendor?: string;
		model?: string;
	} | null;
	let dialog = $state<Dialog>(null);
	/** Guide browser: the tool/meter row lists live in here; picking a row
	 *  swaps this modal for the detail dialog (Back returns to the list). */
	let browser = $state<'tool' | 'meter' | null>(null);

	const liveCount = $derived((meters?.point ?? []).length);

	function closeAfter(fn: () => void) {
		return () => {
			fn();
			dialog = null;
		};
	}

	function openDaemonDialog() {
		dialog = {
			title: 'Daemon unreachable',
			intro:
				'Nothing is being measured right now — coding agents keep working, but their usage is invisible.' +
				(service && !service.supported
					? ` Auto-start is unsupported here (${service.mechanism}) — run the daemon manually.`
					: ''),
			steps: [{ body: 'The app keeps trying this address — start the daemon, then it reconnects on its own:', copy: apiBase() }],
			...(service?.supported
				? {
						actionLabel: service.installed ? 'Reinstall background service' : 'Install background service',
						onAction: closeAfter(() => onInstallSvc())
					}
				: {})
		};
	}

	function openConsentDialog(scope: 'metering' | 'fileReading') {
		dialog = {
			title: scope === 'metering' ? 'Metering not allowed' : 'File reading not allowed',
			intro:
				scope === 'metering'
					? 'Loopback request meters cannot listen — no traffic can be measured.'
					: 'Tool labels and file-claimed costs cannot join metered requests (pi attribution stays blank).',
			actionLabel: `Allow ${scope === 'metering' ? 'metering' : 'file reading'}`,
			onAction: closeAfter(() => onConsent(scope, true))
		};
	}

	function openUnmeteredDialog(rt: RuntimeInfo) {
		dialog = {
			vendor: rt.vendor,
			title: `${rt.display_name} is active but unmetered`,
			intro: `The runtime is running${rt.usage.tokens_all > 0 ? ' and has recorded usage' : ''}, yet no meter is listening — its traffic passes through unseen.`,
			actionLabel: 'Start meter',
			onAction: closeAfter(() => onToggleMeter(rt.vendor, true))
		};
	}

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
		dialog = {
			vendor: tool.vendor,
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
		dialog = {
			vendor: m.vendor,
			title: hint.title,
			intro: 'Use it — point the client here (forwards byte-identical upstream):',
			steps: [
				{ body: 'Meter URL:', copy: `http://127.0.0.1:${m.listen_port}` },
				{
					body: 'If this meter fails, connect back to the original upstream so work continues unmeasured:',
					copy: m.target
				},
				{ body: hint.body, copy: hint.cmd }
			],
			brief: hint.brief
		};
	}

	function meterStatus(m: { seen?: number; measured?: number }): string {
		const seen = m.seen ?? 0;
		const measured = m.measured ?? 0;
		if (seen === 0) return 'live, no arrivals yet';
		if (measured === 0) return 'traffic arriving, nothing measured';
		return `measuring · ${seen} seen · ${measured} recorded`;
	}
</script>

{#if open}
	{#if !bare}
		<div class="section-label">{hasProblems ? 'Recovery' : 'Setup guides'}</div>
	{/if}
	<div class="rlist">
		{#if daemonDown}
			<button class="ritem" onclick={openDaemonDialog}>
				<span class="dot"></span>
				<span class="rtext"><span class="rtitle">Daemon unreachable</span><span class="rsub2">Nothing is being measured</span></span>
				<ChevronRight size={15} strokeWidth={2.2} />
			</button>
		{/if}
		{#if consentDenied('metering')}
			<button class="ritem" onclick={() => openConsentDialog('metering')}>
				<span class="dot"></span>
				<span class="rtext"><span class="rtitle">Metering not allowed</span><span class="rsub2">Loopback meters cannot listen</span></span>
				<ChevronRight size={15} strokeWidth={2.2} />
			</button>
		{/if}
		{#if consentDenied('fileReading')}
			<button class="ritem" onclick={() => openConsentDialog('fileReading')}>
				<span class="dot"></span>
				<span class="rtext"><span class="rtitle">File reading not allowed</span><span class="rsub2">Tool labels cannot join requests</span></span>
				<ChevronRight size={15} strokeWidth={2.2} />
			</button>
		{/if}
		{#each unmeteredActive as rt (rt.vendor)}
			<button class="ritem" onclick={() => openUnmeteredDialog(rt)}>
				<ProviderIcon vendor={rt.vendor} size={22} />
				<span class="rtext"><span class="rtitle">{rt.display_name} unmetered</span><span class="rsub2">Active but no meter listening</span></span>
				<ChevronRight size={15} strokeWidth={2.2} />
			</button>
		{/each}
	</div>
	<div class="ractions">
		<button class="btn btn-guide" onclick={() => (browser = 'tool')}>
			<BookOpen size={14} strokeWidth={2} />Tool setup
		</button>
		{#if liveCount > 0}
			<button class="btn btn-guide" onclick={() => (browser = 'meter')}>
				<Gauge size={14} strokeWidth={2} />Meter setup
			</button>
		{/if}
	</div>
{/if}

<Modal
	title={browser === 'tool' ? 'Tool setup guides' : 'Meter setup guides'}
	open={browser != null && dialog == null}
	onClose={() => (browser = null)}
>
	<div class="rlist">
		{#if browser === 'tool'}
			{#each TOOL_ROUTES as t (t.tool)}
				{@const live = liveMeters.get(t.vendor)}
				<button class="ritem" onclick={() => openToolGuide(t)}>
					<ProviderIcon vendor={t.vendor} size={22} />
					<span class="rtext"><span class="rtitle">{t.tool}</span><span class="rsub2">{live ? 'meter live' : 'meter off'}</span></span>
					<ChevronRight size={15} strokeWidth={2.2} />
				</button>
			{/each}
		{:else}
			{#each meters?.point ?? [] as m (m.vendor)}
				{@const guideable = (m.seen ?? 0) === 0}
				{#if guideable}
					<button class="ritem" onclick={() => openMeterGuide(m.vendor)}>
						<ProviderIcon vendor={m.vendor} size={22} />
						<span class="rtext"><span class="rtitle">{m.vendor}</span><span class="rsub2">{meterStatus(m)}</span></span>
						<ChevronRight size={15} strokeWidth={2.2} />
					</button>
				{:else}
					<div class="ritem static">
						<ProviderIcon vendor={m.vendor} size={22} />
						<span class="rtext"><span class="rtitle">{m.vendor}</span><span class="rsub2">{meterStatus(m)}</span></span>
						<span class="dot up trail"></span>
					</div>
				{/if}
			{/each}
		{/if}
	</div>
</Modal>

<InstructionModal
	open={dialog != null}
	onClose={() => {
		dialog = null;
		browser = null;
	}}
	title={dialog?.title ?? ''}
	intro={dialog?.intro ?? ''}
	steps={dialog?.steps ?? []}
	brief={dialog?.brief}
	actionLabel={dialog?.actionLabel}
	onAction={dialog?.onAction}
	vendor={dialog?.vendor}
	model={dialog?.model}
	backLabel="All guides"
	onBack={browser != null ? () => (dialog = null) : undefined}
/>

<style>
	.rlist {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.ritem {
		appearance: none;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 9px 10px;
		border-radius: 12px;
		cursor: pointer;
	}
	button.ritem:hover {
		background: var(--track);
	}
	.ritem.static {
		cursor: default;
	}
	.ritem > :global(svg) {
		margin-left: auto;
		color: var(--text-3);
		flex: none;
	}
	.ritem .trail {
		margin-left: auto;
		flex: none;
	}
	.rtext {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.rtitle {
		font-size: 13px;
		font-weight: 600;
	}
	.rsub2 {
		font-size: 11px;
		color: var(--text-3);
	}
	.ractions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 10px;
	}
	.btn-guide {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 10px 18px;
		font-size: 13.5px;
		border-radius: 12px;
	}
</style>
