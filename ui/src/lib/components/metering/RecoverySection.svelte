<script lang="ts">
	import { BookOpen, ChevronRight } from 'lucide-svelte';
	import { apiBase, type ConsentState, type MeterInfo, type Meters, type RuntimeInfo, type ServiceStatus } from '$lib/api';
	import Modal from '$lib/components/common/Modal.svelte';
	import ProviderIcon from '$lib/components/data/ProviderIcon.svelte';
	import InstructionModal, { type InstructionStep } from './InstructionModal.svelte';
	import { TOOL_ROUTES } from '$lib/routing';

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
	/** Tool guide browser: the tool row list lives here; picking a row
	 *  swaps this modal for the detail dialog (Back returns to the list). */
	let toolBrowser = $state(false);

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
				'Nothing is being measured right now. Your coding agents still work, but their usage goes uncounted.' +
				(service && !service.supported
					? ` Auto-start is not supported here (${service.mechanism}). Run the daemon yourself.`
					: ''),
			steps: [{ body: 'The app keeps trying this address. Start the daemon and it reconnects on its own:', copy: apiBase() }],
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
					? 'Loopback meters are not allowed to listen. No traffic can be measured.'
					: 'Tool labels and file-claimed costs cannot join metered requests (pi attribution stays blank).',
			actionLabel: `Allow ${scope === 'metering' ? 'metering' : 'file reading'}`,
			onAction: closeAfter(() => onConsent(scope, true))
		};
	}

	function openUnmeteredDialog(rt: RuntimeInfo) {
		dialog = {
			vendor: rt.vendor,
			title: `${rt.display_name} is active but unmetered`,
			intro: `The runtime is running${rt.usage.tokens_all > 0 ? ' and has recorded usage' : ''}, but no meter is listening, so its traffic goes uncounted.`,
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
			intro: `Point ${tool.tool} at its meter. Traffic passes through unchanged and gets counted on the way.`,
			steps: [
				{ body: `Point ${tool.tool} here:`, copy: `http://127.0.0.1:${port}${tool.meterPath}` },
				{ body: `If the meter fails, connect ${tool.tool} back here:`, copy: tool.upstream }
			],
			brief: tool.brief(port)
		};
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
		<button class="btn btn-guide" onclick={() => (toolBrowser = true)}>
			<BookOpen size={14} strokeWidth={2} />Tool setup
		</button>
	</div>
{/if}

<Modal
	title="Tool setup guides"
	open={toolBrowser && dialog == null}
	onClose={() => (toolBrowser = false)}
>
	<div class="rlist">
		{#each TOOL_ROUTES as t (t.tool)}
			{@const live = liveMeters.get(t.vendor)}
			<button class="ritem" onclick={() => openToolGuide(t)}>
				<ProviderIcon vendor={t.vendor} size={22} />
				<span class="rtext"><span class="rtitle">{t.tool}</span><span class="rsub2">{live ? 'meter live' : 'meter off'}</span></span>
				<ChevronRight size={15} strokeWidth={2.2} />
			</button>
		{/each}
	</div>
</Modal>

<InstructionModal
	open={dialog != null}
	onClose={() => {
		dialog = null;
		toolBrowser = false;
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
	onBack={toolBrowser ? () => (dialog = null) : undefined}
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

	.ritem > :global(svg) {
		margin-left: auto;
		color: var(--text-3);
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
